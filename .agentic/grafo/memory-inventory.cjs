'use strict';
/**
 * Inventario determinista de memoria.db y de los archivos propios del proyecto.
 *
 * Por qué existe: "la base no cambió" no se puede demostrar con el hash del
 * archivo (una migración correcta lo cambia) ni con COUNT(*) (pueden desaparecer
 * registros y aparecer otros con el mismo total). Este inventario compara
 * CONTENIDO:
 *
 *   · por tabla, una huella de MULTICONJUNTO de las filas (suma módulo 2^128 de
 *     sha256 por fila): independiente del orden, sensible a duplicados, a NULL
 *     vs '' vs BLOB vs número, y a INTEGER de 64 bits (se leen como BigInt);
 *   · tras una migración ADITIVA se recalcula sobre las columnas que existían
 *     ANTES, así que una columna nueva no cuenta como cambio;
 *   · objetos propios (índices, triggers, vistas), secuencias AUTOINCREMENT y
 *     tablas del consumidor (las que Agentix no conoce) también se comparan;
 *   · todo se lee en streaming: no se carga ninguna tabla en memoria.
 *
 * Tablas DERIVADAS (se reconstruyen desde otra fuente: índice AST, FTS) se
 * identifican de forma explícita y se informan, pero no se exigen iguales.
 *
 * Si algo no se puede calcular el resultado es NO_VERIFICADO, nunca PASS.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MODULO = (1n << 128n) - 1n;
const q = (id) => '"' + String(id).replace(/"/g, '""') + '"';

// ─────────────────────── serialización determinista ────────────────────
const buf8 = new DataView(new ArrayBuffer(8));
function pieza(v) {
  if (v === null || v === undefined) return 'N';
  switch (typeof v) {
    case 'bigint': return 'I' + v.toString();
    case 'number': {
      // Con lectura BigInt los INTEGER llegan como bigint: un number es siempre REAL.
      buf8.setFloat64(0, v);
      return 'R' + buf8.getBigUint64(0).toString(16);
    }
    case 'string': return 'T' + Buffer.byteLength(v, 'utf8') + ':' + v;
    case 'boolean': return 'I' + (v ? '1' : '0');
    default:
      if (v instanceof Uint8Array) return 'B' + v.length + ':' + Buffer.from(v).toString('hex');
      return 'X' + String(v);
  }
}
function huellaFila(valores) {
  const h = crypto.createHash('sha256');
  for (const v of valores) { h.update(pieza(v)); h.update('\x1f'); }
  return BigInt('0x' + h.digest('hex').slice(0, 32));
}

// ─────────────────────────── lectura de la base ────────────────────────
function listaTablas(db) {
  return db.all("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
}
function columnas(db, tabla) {
  return db.all(`PRAGMA table_info(${q(tabla)})`);
}

/** Tablas virtuales FTS y sus tablas sombra: derivadas por construcción, no por parecido de nombre. */
function derivadasFts(tablas) {
  const out = new Set();
  for (const t of tablas) {
    if (/CREATE\s+VIRTUAL\s+TABLE/i.test(t.sql || '') && /USING\s+fts[345]/i.test(t.sql)) {
      out.add(t.name);
      for (const suf of ['_data', '_idx', '_content', '_docsize', '_config']) out.add(t.name + suf);
    }
  }
  return out;
}

/**
 * Inventario de la base. opts:
 *   derived       lista explícita de tablas derivadas (por defecto el catálogo)
 *   columnsFrom   inventario anterior: se hashean SOLO esas columnas por tabla
 *   exclude       { tabla: [columnas] } transformadas por una regla declarada
 */
function takeInventory(db, opts = {}) {
  if (!db.capabilities || !db.capabilities.iterate || !db.capabilities.bigints) {
    return { ok: false, status: 'NO_VERIFICADO', reason: 'el driver no ofrece lectura en streaming con INTEGER de 64 bits' };
  }
  let derived = opts.derived;
  if (!derived) { try { derived = require('./schema-catalog.cjs').derived_tables; } catch { derived = []; } }
  // Columnas que una regla DECLARADA transforma: se excluyen del hash en ambos lados y se verifican aparte.
  let exclude = opts.exclude;
  if (!exclude) { try { exclude = require('./schema-catalog.cjs').DATA_V2.modifica; } catch { exclude = {}; } }
  const tablas = listaTablas(db);
  const fts = derivadasFts(tablas);
  let catalogo = {};
  try { catalogo = require('./schema-catalog.cjs').catalog.tables; } catch { /* sin catálogo */ }
  const out = { schema: 1, taken_at: new Date().toISOString(), tables: {}, objects: {}, sequences: {}, integrity: null, foreign_keys: null, driver: db.type };

  for (const t of tablas) {
    const cols = columnas(db, t.name);
    const nombres = cols.map((c) => c.name);
    let clase = 'user';
    if (t.name.startsWith('agentix_schema_')) clase = 'registry';
    else if (derived.includes(t.name) || fts.has(t.name)) clase = 'derived';
    else if (catalogo[t.name]) clase = 'engine';
    const previo = opts.columnsFrom && opts.columnsFrom.tables[t.name];
    const excluidas = new Set((exclude && exclude[t.name]) || []);
    let aHashear = nombres;
    if (previo) aHashear = previo.hashed_columns.filter((c) => !excluidas.has(c));
    else aHashear = nombres.filter((c) => !excluidas.has(c));
    const info = {
      class: clase, columns: nombres, pk: cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name),
      hashed_columns: aHashear, excluded_columns: [...excluidas], rows: 0, digest: null, virtual: /CREATE\s+VIRTUAL/i.test(t.sql || ''),
      sql: t.sql || null,
    };
    try {
      info.rows = Number(db.get(`SELECT count(*) AS n FROM ${q(t.name)}`).n);
    } catch (e) { info.error = 'COUNT: ' + e.message; }
    const faltan = aHashear.filter((c) => !nombres.includes(c));
    if (faltan.length) info.missing_columns = faltan;
    else if (!info.virtual && clase !== 'derived' && !info.error) {
      try {
        let suma = 0n, xor = 0n, n = 0;
        const sel = aHashear.length ? aHashear.map(q).join(', ') : '1';
        for (const fila of db.iterate(`SELECT ${sel} FROM ${q(t.name)}`, undefined, { bigints: true })) {
          const h = huellaFila(aHashear.length ? aHashear.map((c) => fila[c]) : [1]);
          suma = (suma + h) & MODULO; xor ^= h; n++;
        }
        info.digest = { sum: suma.toString(16), xor: xor.toString(16), count: n };
      } catch (e) { info.error = 'DIGEST: ' + e.message; }
    }
    out.tables[t.name] = info;
  }

  for (const o of db.all("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('index','trigger','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name")) {
    out.objects[o.name] = { type: o.type, table: o.tbl_name, sql: (o.sql || '').replace(/\s+/g, ' ').trim() };
  }
  if (tablas.length && db.get("SELECT 1 AS x FROM sqlite_master WHERE name='sqlite_sequence'")) {
    for (const s of db.all('SELECT name, seq FROM sqlite_sequence ORDER BY name')) out.sequences[s.name] = String(s.seq);
  }
  try { out.integrity = db.get('PRAGMA integrity_check').integrity_check; } catch (e) { out.integrity = 'ERROR: ' + e.message; }
  try {
    const fk = db.all('PRAGMA foreign_key_check');
    out.foreign_keys = { count: fk.length, signature: crypto.createHash('sha256').update(JSON.stringify(fk.map((r) => [r.table, r.rowid, r.parent, r.fkid]).sort())).digest('hex').slice(0, 16) };
  } catch (e) { out.foreign_keys = { count: null, error: e.message }; }
  return out;
}

/**
 * Antes de una regla declarada que transforma registros, guarda lo mínimo para
 * poder VERIFICARLA después (solo las filas afectadas, no la tabla).
 */
function snapshotDeclarado(db) {
  const out = {};
  try {
    const { DATA_V2 } = require('./schema-catalog.cjs');
    const cols = new Set(columnas(db, DATA_V2.tabla).map((c) => c.name));
    if (cols.has('test_file') && cols.has('test_id')) {
      const filas = db.all(`SELECT id, test_file FROM ${q(DATA_V2.tabla)} WHERE ${DATA_V2.where}`);
      out[DATA_V2.id] = { table: DATA_V2.tabla, regla: DATA_V2.regla, filas: filas.map((r) => [String(r.id), r.test_file === undefined ? null : r.test_file]) };
    }
  } catch { /* sin tabla de contratos: no hay regla que verificar */ }
  return out;
}

/** Verifica la regla declarada contra lo que quedó. Devuelve problemas ([] = cumple). */
function verificarDeclarado(db, declarado) {
  const problemas = [];
  for (const [id, d] of Object.entries(declarado || {})) {
    for (const [pk, original] of d.filas) {
      const r = db.get(`SELECT test_file, runner_command, mapping_status FROM ${q(d.table)} WHERE id = ?`, [pk]);
      if (!r) { problemas.push(`${id}: la fila ${pk} desapareció`); continue; }
      if (r.mapping_status !== 'UNRESOLVED') problemas.push(`${id}: la fila ${pk} no quedó UNRESOLVED`);
      const cambio = (r.test_file === null ? null : r.test_file) !== original;
      if (cambio && (r.test_file !== null || r.runner_command !== original)) {
        problemas.push(`${id}: la fila ${pk} cambió fuera de la regla (test_file=${r.test_file}, runner_command=${r.runner_command})`);
      }
    }
  }
  return problemas;
}

/**
 * Compara dos inventarios. `despues` debe haberse tomado con
 * { columnsFrom: antes, exclude } para comparar solo lo que existía.
 */
function compare(antes, despues, opts = {}) {
  if (!antes || antes.ok === false) return { ok: false, status: 'NO_VERIFICADO', reason: (antes && antes.reason) || 'sin inventario previo', problems: [] };
  if (!despues || despues.ok === false) return { ok: false, status: 'NO_VERIFICADO', reason: (despues && despues.reason) || 'sin inventario posterior', problems: [] };
  const problemas = [], noVerificado = [], info = { derived: {}, added_tables: [], objects_added: [] };
  const resumen = { compared: 0, user_tables: [], engine_tables: 0, rows_compared: 0 };

  for (const [nombre, a] of Object.entries(antes.tables)) {
    if (a.class === 'registry') continue;
    const d = despues.tables[nombre];
    if (!d) { problemas.push(`la tabla ${nombre} (${a.class}) ya no existe`); continue; }
    if (a.class === 'derived') { info.derived[nombre] = { before: a.rows, after: d.rows }; continue; }
    if (d.missing_columns) { problemas.push(`${nombre}: desaparecieron columnas ${d.missing_columns.join(', ')}`); continue; }
    if (a.error || d.error || !a.digest || !d.digest) { noVerificado.push(`${nombre}: ${a.error || d.error || 'sin huella'}`); continue; }
    resumen.compared++; resumen.rows_compared += a.rows;
    if (a.class === 'user') resumen.user_tables.push(nombre); else resumen.engine_tables++;
    if (a.rows !== d.rows) problemas.push(`${nombre}: ${a.rows} filas antes, ${d.rows} después`);
    if (a.digest.sum !== d.digest.sum || a.digest.xor !== d.digest.xor) problemas.push(`${nombre}: el contenido de las filas originales cambió (huella distinta con las mismas ${a.digest.count} filas)`);
  }
  for (const nombre of Object.keys(despues.tables)) if (!antes.tables[nombre] && !nombre.startsWith('agentix_schema_')) info.added_tables.push(nombre);

  for (const [nombre, o] of Object.entries(antes.objects)) {
    if (nombre.startsWith('agentix_dd_')) continue;
    const d = despues.objects[nombre];
    if (!d) problemas.push(`el ${o.type} ${nombre} ya no existe`);
    else if (d.sql !== o.sql) problemas.push(`el ${o.type} ${nombre} cambió de definición`);
  }
  for (const nombre of Object.keys(despues.objects)) if (!antes.objects[nombre]) info.objects_added.push(nombre);

  for (const [t, seq] of Object.entries(antes.sequences)) {
    const s = despues.sequences[t];
    if (s === undefined) problemas.push(`la secuencia AUTOINCREMENT de ${t} desapareció`);
    else if (BigInt(s) < BigInt(seq)) problemas.push(`la secuencia de ${t} retrocedió (${seq} → ${s})`);
  }
  if (despues.integrity !== 'ok') problemas.push('integrity_check: ' + despues.integrity);
  if (antes.foreign_keys && despues.foreign_keys && antes.foreign_keys.count !== null) {
    if (despues.foreign_keys.count === null) noVerificado.push('foreign_key_check no se pudo ejecutar después');
    else if (despues.foreign_keys.count > antes.foreign_keys.count) problemas.push(`foreign_key_check: ${despues.foreign_keys.count} incidencia(s) frente a ${antes.foreign_keys.count} previas`);
  }
  const status = problemas.length ? 'FAIL' : (noVerificado.length ? 'NO_VERIFICADO' : 'PASS');
  return { ok: status === 'PASS', status, problems: problemas, unverified: noVerificado, summary: resumen, info };
}

// ───────────────────────────── archivos del proyecto ───────────────────
const OMITIR_DIR = new Set(['node_modules', '.git', '_update', '_cache', '.model_cache', '_pipeline', '_executions', '_teams', '_restore', '_whatsapp', '_effort', '_context', '_hooks', 'telemetria', 'worktrees']);
// Los acompañantes TRANSITORIOS de SQLite (-journal en modo clásico, -wal/-shm en WAL) los crea y los borra SQLite solo, en cualquier
// momento: no son archivos del proyecto y su aparición o desaparición no es una pérdida. Antes solo se omitían los de memoria.db y
// faltaba -journal: una base antigua con una escritura en curso al inventariar (caso real: komerza) hacía fallar la verificación
// posterior con «el archivo propio .agentic/memoria.db-journal desapareció». También los temporales de editores (.tmp, .swp, ~).
const OMITIR_ARCHIVO = /^(memoria\.db(-wal|-shm|-journal)?|memoria\.db\.bak-.*|_.*\.json|_.*\.jsonl|.*\.(db|sqlite|sqlite3)-(journal|wal|shm)|.*\.(tmp|swp)|.*~)$/;

function hashArchivo(f) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(f, 'r');
  try {
    const b = Buffer.allocUnsafe(1 << 16);
    for (;;) { const n = fs.readSync(fd, b, 0, b.length, null); if (!n) break; h.update(b.subarray(0, n)); }
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

/**
 * Archivos del proyecto que el update NO debe tocar. `incluir(rel)` decide cuáles
 * entran (el actualizador pasa "no es del framework"). Streaming por archivo.
 */
function inventoryFiles(root, opts = {}) {
  const incluir = opts.incluir || (() => true);
  const raices = opts.dirs || ['.agentic', '.cursor', '.audit', '.claude'];
  const out = {};
  const caminar = (rel) => {
    let entradas;
    try { entradas = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entradas) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (!OMITIR_DIR.has(e.name)) caminar(r); continue; }
      if (!e.isFile() || OMITIR_ARCHIVO.test(e.name)) continue;
      if (!incluir(r)) continue;
      const f = path.join(root, r);
      try { out[r] = { size: fs.statSync(f).size, sha256: hashArchivo(f) }; } catch { out[r] = { error: 'ilegible' }; }
    }
  };
  for (const d of raices) caminar(d);
  // Archivos sueltos en la raíz (CLAUDE.md propio, .cursorrules, README, etc.): solo los no administrados.
  let sueltos = [];
  try { sueltos = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isFile()); } catch { /* raíz ilegible */ }
  for (const e of sueltos) {
    if (!incluir(e.name)) continue;
    try { out[e.name] = { size: fs.statSync(path.join(root, e.name)).size, sha256: hashArchivo(path.join(root, e.name)) }; } catch { out[e.name] = { error: 'ilegible' }; }
  }
  return out;
}

/** Cada archivo propio de antes debe seguir idéntico, salvo los cambios esperados y declarados. */
function compareFiles(antes, despues, esperados = {}) {
  const problemas = [], cambiosEsperados = [], detalle = [];
  for (const [rel, a] of Object.entries(antes)) {
    const d = despues[rel];
    if (!d) { problemas.push(`el archivo propio ${rel} desapareció`); detalle.push({ rel, tipo: 'desapareció' }); continue; }
    if (a.sha256 !== d.sha256) {
      if (esperados[rel]) cambiosEsperados.push({ file: rel, reason: esperados[rel] });
      else { problemas.push(`el archivo propio ${rel} cambió`); detalle.push({ rel, tipo: 'cambió' }); }
    }
  }
  // `detail` dice QUÉ archivo y qué le pasó: quien llama decide si fue el update (fallo) u otro programa (aviso).
  return { ok: problemas.length === 0, problems: problemas, detail: detalle, expected_changes: cambiosEsperados, compared: Object.keys(antes).length };
}

module.exports = {
  takeInventory, compare, snapshotDeclarado, verificarDeclarado,
  inventoryFiles, compareFiles, hashArchivo, huellaFila, pieza,
};
