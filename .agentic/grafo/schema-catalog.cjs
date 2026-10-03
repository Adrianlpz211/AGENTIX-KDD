'use strict';
/**
 * Catálogo autoritativo del esquema de memoria.db (3.20.1).
 *
 * Qué resuelve:
 *   · La versión del esquema deja de deducirse de config.md o de la versión npm:
 *     se INSPECCIONA la base (tablas, columnas, índices) y se anota cada
 *     migración en `agentix_schema_migrations` con id estable, checksum,
 *     versión que la introdujo, fecha y resultado.
 *   · Ninguna migración se prueba con "ALTER y callar el error". Se mira si la
 *     estructura existe; si existe se comprueba que es compatible; si falta se
 *     aplica; si falla se aborta; y se verifican las postcondiciones.
 *   · Todo se aplica en UNA transacción: o queda completo o no cambia nada.
 *   · Solo migraciones compatibles y ADITIVAS (tablas, columnas, índices,
 *     triggers de default). Nada destructivo, ninguna tabla desconocida del
 *     proyecto se toca, ningún downgrade.
 *
 * El catálogo (schema-catalog.data.json) se genera de bases REALES de los
 * motores publicados: scripts/gen-schema-catalog.cjs.
 *
 * Este módulo NO abre ni crea bases: recibe una conexión del db-adapter.
 * Leer (inspect/verify) no escribe nada.
 */

const crypto = require('crypto');
const DATA = require('./schema-catalog.data.json');

const BASELINE = '3.19.0';
const SUPPORTED_LEVEL = 3;           // 1 = línea base 3.19.0, 2 = adiciones de 3.20.0, 3 = memoria con evidencia de 3.20.1
const LEVEL_DE = (since) => (since === BASELINE ? 1 : since === '3.20.0' ? 2 : 3);
const RELLENO_BASE = ['fecha_update', 'fecha_creacion', 'created_at', 'fecha'];

const REGISTRY_DDL = [
  `CREATE TABLE IF NOT EXISTS agentix_schema_migrations (
    id TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    introduced_in TEXT NOT NULL,
    level INTEGER NOT NULL,
    applied_at TEXT NOT NULL,
    applied_by TEXT,
    result TEXT NOT NULL,
    details TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS agentix_schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
];
const TABLAS_DEL_REGISTRO = ['agentix_schema_migrations', 'agentix_schema_meta'];

/* Tipos que el propio código declaró de dos maneras a lo largo de la historia
   (según qué script creó primero la columna). No son una deriva del usuario. */
const TIPOS_ALTERNATIVOS = {
  'relaciones_semanticas.confidence': ['REAL', 'TEXT'],
  'ciclos.knowledge_loaded': ['TEXT', 'INTEGER'],
  'ciclos.memory_trace': ['TEXT'],
};

/* Regla declarada de la única transformación de registros anteriores. */
const DATA_V2 = {
  id: 'data:verified_contracts-v2-unresolved',
  since: '3.20.0',
  tabla: 'verified_contracts',
  requiere: ['test_id', 'runner_command', 'mapping_status'],
  regla: "Contratos atados a un comando genérico (npm test, pytest, 'tests (n/m)') quedan mapping_status='UNRESOLVED', su comando pasa a runner_command y test_file se vacía si no es un archivo real. Nivel, historial y demás campos no cambian.",
  modifica: { verified_contracts: ['test_file'] },
  where: `test_id IS NULL AND (test_file IS NULL OR test_file LIKE 'npm %' OR test_file LIKE 'npx %' OR test_file IN ('pytest') OR name LIKE '% tests (%/%)')`,
};

// ───────────────────────────── utilidades ──────────────────────────────
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const q = (id) => '"' + String(id).replace(/"/g, '""') + '"';
function err(code, message, extra) {
  const e = new Error(message); e.code = code; if (extra) Object.assign(e, extra); return e;
}

function afinidad(tipo) {
  const t = String(tipo || '').toUpperCase();
  if (t.includes('INT')) return 'INTEGER';
  if (/CHAR|CLOB|TEXT/.test(t)) return 'TEXT';
  if (t === '' || t.includes('BLOB')) return 'BLOB';
  if (/REAL|FLOA|DOUB/.test(t)) return 'REAL';
  return 'NUMERIC';
}

function tablasExistentes(db) {
  return db.all("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
}
function columnasDe(db, tabla) {
  return db.all(`PRAGMA table_info(${q(tabla)})`);
}
function indicesDe(db, tabla) {
  return db.all(`PRAGMA index_list(${q(tabla)})`);
}
function columnasIndice(db, nombre) {
  return db.all(`PRAGMA index_info(${q(nombre)})`).map((r) => r.name);
}
const colsDelDdl = (ddl) => {
  const m = /\(([^)]*)\)\s*(?:WHERE.*)?$/is.exec(ddl);
  return m ? m[1].split(',').map((s) => s.trim().replace(/^"|"$/g, '').split(/\s+/)[0]) : [];
};

// ───────────────────────────── unidades ────────────────────────────────
/** Unidades de migración, derivadas del catálogo. Estables y ordenadas. */
function unidades() {
  const out = [];
  const nombres = Object.keys(DATA.tables).sort();
  for (const t of nombres) {
    const def = DATA.tables[t];
    if (def.since === BASELINE) {
      const cols = def.columns.filter((c) => c.since === BASELINE);
      const idx = def.indexes.filter((i) => i.since === BASELINE);
      out.push({
        id: `baseline:${t}`, kind: 'baseline', table: t, since: BASELINE, level: 1,
        checksum: sha(JSON.stringify({ cols: cols.map((c) => [c.name, afinidad(c.type)]), idx: idx.map((i) => i.ddl) })),
        columnas: cols.map((c) => c.name), indices: idx.map((i) => i.name),
      });
      for (const c of def.columns.filter((x) => x.since !== BASELINE)) {
        out.push({ id: `add-column:${t}.${c.name}`, kind: 'add-column', table: t, column: c.name, since: c.since, level: LEVEL_DE(c.since),
          checksum: sha(JSON.stringify([t, c.name, afinidad(c.type), c.dflt || null])), columnas: [c.name], indices: [] });
      }
      for (const i of def.indexes.filter((x) => x.since !== BASELINE)) {
        out.push({ id: `create-index:${i.name}`, kind: 'create-index', table: t, index: i.name, since: i.since, level: LEVEL_DE(i.since),
          checksum: sha(i.ddl), columnas: [], indices: [i.name] });
      }
    } else {
      out.push({
        id: `create-table:${t}`, kind: 'create-table', table: t, since: def.since, level: LEVEL_DE(def.since),
        checksum: sha(JSON.stringify({ c: def.columns.map((c) => [c.name, afinidad(c.type)]), i: def.indexes.map((i) => i.ddl) })),
        columnas: def.columns.map((c) => c.name), indices: def.indexes.map((i) => i.name),
      });
    }
  }
  out.push({ id: DATA_V2.id, kind: 'data', table: DATA_V2.tabla, since: DATA_V2.since, level: LEVEL_DE(DATA_V2.since),
    checksum: sha(JSON.stringify([DATA_V2.id, DATA_V2.where])), columnas: DATA_V2.requiere, indices: [], regla: DATA_V2.regla });
  return out;
}
const UNIDADES = unidades();
const CATALOG_CHECKSUM = sha(UNIDADES.map((u) => u.id + ':' + u.checksum).join('|'));

// ─────────────────────────── evaluación (solo lectura) ─────────────────
function leerRegistro(db, existentes) {
  if (!existentes.has('agentix_schema_migrations')) return { presente: false, filas: new Map(), nivel: null };
  const filas = new Map(db.all('SELECT id, checksum, introduced_in, level, applied_at, applied_by, result FROM agentix_schema_migrations').map((r) => [r.id, r]));
  let nivel = null;
  if (existentes.has('agentix_schema_meta')) {
    const m = db.get("SELECT value FROM agentix_schema_meta WHERE key='level'");
    if (m && Number.isFinite(Number(m.value))) nivel = Number(m.value);
  }
  return { presente: true, filas, nivel };
}

/**
 * Evalúa UNA unidad contra el estado vivo de la base. Devuelve las operaciones
 * necesarias (ops), los bloqueos (conflicts) y avisos (warnings). No escribe.
 */
function evaluar(db, unidad, existentes) {
  const ops = [], conflicts = [], warnings = [];
  const def = DATA.tables[unidad.table];

  if (unidad.kind === 'data') {
    if (!existentes.has(unidad.table)) return { ops: [{ op: 'data', unidad: unidad.id }], conflicts, warnings, satisfecha: false };
    const cols = new Set(columnasDe(db, unidad.table).map((c) => c.name));
    if (DATA_V2.requiere.some((c) => !cols.has(c))) return { ops: [{ op: 'data', unidad: unidad.id }], conflicts, warnings, satisfecha: false };
    const n = db.get(`SELECT count(*) AS n FROM ${q(unidad.table)} WHERE (${DATA_V2.where}) AND COALESCE(mapping_status,'') <> 'UNRESOLVED'`).n;
    return { ops: n > 0 ? [{ op: 'data', unidad: unidad.id, filas: Number(n) }] : [], conflicts, warnings, satisfecha: n === 0 };
  }

  if (!existentes.has(unidad.table)) {
    // Añadir columna o índice a una tabla que aún no existe: la crea su unidad de tabla.
    if (unidad.kind === 'baseline' || unidad.kind === 'create-table') ops.push({ op: 'create_table', table: unidad.table });
    else ops.push({ op: 'pendiente_de_tabla', table: unidad.table });
    return { ops, conflicts, warnings, satisfecha: false };
  }

  const reales = new Map(columnasDe(db, unidad.table).map((c) => [c.name, c]));
  for (const nombre of unidad.columnas) {
    const cat = def.columns.find((c) => c.name === nombre);
    const real = reales.get(nombre);
    if (!real) {
      if (cat.pk) { conflicts.push({ code: 'PK_FALTANTE', table: unidad.table, column: nombre, message: `la tabla ${unidad.table} existe sin su clave ${nombre}: no se puede añadir con ALTER` }); continue; }
      ops.push({ op: cat.dynamicDefault ? 'add_column_dynamic' : 'add_column', table: unidad.table, column: nombre });
    } else {
      const clave = `${unidad.table}.${nombre}`;
      const aceptados = (TIPOS_ALTERNATIVOS[clave] || []).concat(afinidad(cat.type));
      if (!aceptados.includes(afinidad(real.type))) {
        warnings.push({ code: 'TIPO_DISTINTO', table: unidad.table, column: nombre, esperado: cat.type, real: real.type, message: `${clave} está declarada ${real.type || '(sin tipo)'} y el catálogo espera ${cat.type}; SQLite es de tipado flexible, no bloquea` });
      }
    }
  }
  for (const nombre of unidad.indices) {
    const idef = def.indexes.find((i) => i.name === nombre);
    const reales_i = indicesDe(db, unidad.table);
    const real = reales_i.find((i) => i.name === nombre);
    if (!real) {
      ops.push({ op: 'create_index', table: unidad.table, index: nombre, unique: idef.unique });
    } else {
      const cols = columnasIndice(db, nombre).join(',');
      const esp = colsDelDdl(idef.ddl).join(',');
      if (cols !== esp || !!real.unique !== !!idef.unique) {
        warnings.push({ code: 'INDICE_DISTINTO', table: unidad.table, index: nombre, message: `el índice ${nombre} existe con otra definición (${real.unique ? 'UNIQUE ' : ''}${cols}); no se reemplaza` });
      }
    }
  }
  return { ops, conflicts, warnings, satisfecha: ops.length === 0 && conflicts.length === 0 };
}

/**
 * Inspección completa y SIN escribir.
 * status: COMPLETE | PENDING | BLOCKED | NEWER_SCHEMA
 */
function inspect(db, opts = {}) {
  const tablas = tablasExistentes(db);
  const existentes = new Set(tablas.map((t) => t.name));
  const reg = leerRegistro(db, existentes);
  const pendientes = [], satisfechas = [], conflicts = [], warnings = [];

  for (const u of UNIDADES) {
    const ev = evaluar(db, u, existentes);
    conflicts.push(...ev.conflicts.map((c) => ({ unidad: u.id, ...c })));
    warnings.push(...ev.warnings.map((w) => ({ unidad: u.id, ...w })));
    const fila = reg.filas.get(u.id);
    if (fila && fila.checksum !== u.checksum) {
      warnings.push({ unidad: u.id, code: 'CHECKSUM_DISTINTO', message: `${u.id}: la definición cambió desde que se registró (${fila.checksum.slice(0, 8)} → ${u.checksum.slice(0, 8)})` });
    }
    if (ev.satisfecha) satisfechas.push({ id: u.id, registrada: !!fila });
    else pendientes.push({ id: u.id, kind: u.kind, since: u.since, level: u.level, table: u.table, ops: ev.ops });
  }

  // ¿Esquema más nuevo que este motor?
  const nuevas = [];
  for (const [id, fila] of reg.filas) {
    if (!UNIDADES.some((u) => u.id === id)) {
      if (Number(fila.level) > SUPPORTED_LEVEL) nuevas.push({ id, level: Number(fila.level), introduced_in: fila.introduced_in });
      else warnings.push({ unidad: id, code: 'MIGRACION_DESCONOCIDA', message: `el registro tiene ${id}, que este motor no conoce` });
    }
  }
  const newer = nuevas.length > 0 || (reg.nivel !== null && reg.nivel > SUPPORTED_LEVEL);

  const propias = tablas.map((t) => t.name).filter((n) => !DATA.tables[n] && !TABLAS_DEL_REGISTRO.includes(n));
  let status = 'COMPLETE';
  if (newer) status = 'NEWER_SCHEMA';
  else if (conflicts.length) status = 'BLOCKED';
  else if (pendientes.length) status = 'PENDING';

  return {
    status,
    supported_level: SUPPORTED_LEVEL,
    detected_level: reg.nivel,
    catalog_checksum: CATALOG_CHECKSUM,
    registry_present: reg.presente,
    registry_entries: reg.filas.size,
    user_version: Number((db.get('PRAGMA user_version') || {}).user_version || 0),
    pending: pendientes,
    satisfied: satisfechas.length,
    conflicts, warnings,
    newer_than_supported: nuevas,
    foreign_tables: propias,
  };
}

// ───────────────────────────── aplicación ──────────────────────────────
function ejecutarOp(db, op, ctx) {
  const def = DATA.tables[op.table];
  switch (op.op) {
    case 'create_table': {
      db.exec(def.create);
      for (const i of def.indexes) db.exec(i.ddl);
      return;
    }
    case 'add_column': {
      const c = def.columns.find((x) => x.name === op.column);
      const dflt = c.dflt !== null && c.dflt !== undefined && c.dflt !== '' ? ` DEFAULT ${c.dflt}` : '';
      db.exec(`ALTER TABLE ${q(op.table)} ADD COLUMN ${q(op.column)} ${c.type || ''}${dflt}`.trim());
      return;
    }
    case 'add_column_dynamic': {
      // SQLite no admite un DEFAULT no constante en ALTER ... ADD COLUMN.
      const c = def.columns.find((x) => x.name === op.column);
      const expr = c.dynamicDefault.expr;
      const presentes = new Set(columnasDe(db, op.table).map((x) => x.name));
      const origen = (c.dynamicDefault.relleno || RELLENO_BASE).filter((x) => presentes.has(x) && x !== op.column);
      const sin = db.get("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name = ? AND sql LIKE '%WITHOUT ROWID%'", [op.table]);
      if (sin) throw err('SIN_ROWID', `${op.table} es WITHOUT ROWID: el default dinámico de ${op.column} no se puede reproducir con un trigger`);
      db.exec(`ALTER TABLE ${q(op.table)} ADD COLUMN ${q(op.column)} ${c.type || ''}`.trim());
      const candidatos = origen.map((x) => `NULLIF(${q(x)}, '')`).concat([expr]);
      db.exec(`UPDATE ${q(op.table)} SET ${q(op.column)} = COALESCE(${candidatos.join(', ')}) WHERE ${q(op.column)} IS NULL`);
      db.exec(`CREATE TRIGGER IF NOT EXISTS ${q('agentix_dd_' + op.table + '_' + op.column)} AFTER INSERT ON ${q(op.table)} WHEN NEW.${q(op.column)} IS NULL BEGIN UPDATE ${q(op.table)} SET ${q(op.column)} = ${expr} WHERE rowid = NEW.rowid; END`);
      ctx.dinamicas.push({ table: op.table, column: op.column, relleno: origen, expr });
      return;
    }
    case 'create_index': {
      const idef = def.indexes.find((i) => i.name === op.index);
      if (idef.unique) {
        const cols = colsDelDdl(idef.ddl);
        const d = db.get(`SELECT count(*) AS n FROM (SELECT 1 FROM ${q(op.table)} GROUP BY ${cols.map(q).join(', ')} HAVING count(*) > 1)`);
        if (Number(d.n) > 0) {
          throw err('DATOS_DUPLICADOS', 'no se puede crear el índice único ' + op.index + ': ' + d.n + ' grupo(s) de ' + op.table + '(' + cols.join(', ') + ') están duplicados. Deduplicar es una decisión humana; la actualización no borra registros.', { index: op.index, grupos: Number(d.n) });
        }
      }
      db.exec(idef.ddl);
      return;
    }
    case 'data': {
      const r = db.run(`UPDATE verified_contracts SET mapping_status = 'UNRESOLVED', runner_command = COALESCE(runner_command, test_file), test_file = CASE WHEN test_file LIKE '% %' OR test_file IN ('npm test','pytest') THEN NULL ELSE test_file END WHERE ${DATA_V2.where}`);
      ctx.cambios.push({ unidad: op.unidad, filas: r && r.changes != null ? Number(r.changes) : null });
      return;
    }
    case 'pendiente_de_tabla':
      return; // la crea su unidad baseline/create-table, que va antes
    default:
      throw err('OP_DESCONOCIDA', 'operación de migración desconocida: ' + op.op);
  }
}

function registrar(db, u, resultado, actor, version, detalles) {
  db.run(
    `INSERT OR REPLACE INTO agentix_schema_migrations (id, checksum, introduced_in, level, applied_at, applied_by, result, details) VALUES (?,?,?,?,?,?,?,?)`,
    [u.id, u.checksum, u.since, u.level, new Date().toISOString(), actor || null, resultado, JSON.stringify({ engine: version || null, ...(detalles || {}) })]
  );
}

/**
 * Aplica todo lo pendiente en UNA transacción. Estricto: nada se silencia.
 * Aborta (y la transacción revierte) ante cualquier conflicto, fallo o
 * postcondición incumplida. Si el esquema es más nuevo, no toca nada.
 *
 * opts: { version, actor, dryRun }
 */
function apply(db, opts = {}) {
  if (!db.capabilities || !db.capabilities.transactions) throw err('UNSUPPORTED', 'este driver no ofrece transacciones reales: no se migra');
  const antes = inspect(db);
  if (antes.status === 'NEWER_SCHEMA') throw err('NEWER_SCHEMA', 'la base tiene un esquema más nuevo que este motor: no se modifica nada', { inspeccion: antes });
  if (antes.status === 'BLOCKED') throw err('SCHEMA_CONFLICT', 'conflictos de esquema que requieren revisión: ' + antes.conflicts.map((c) => c.message).join('; '), { inspeccion: antes });
  if (opts.dryRun) return { status: 'DRY_RUN', applied: [], adopted: [], plan: antes.pending, inspeccion: antes };

  const ctx = { dinamicas: [], cambios: [] };
  const aplicadas = [], adoptadas = [];
  db.transaction(() => {
    for (const sql of REGISTRY_DDL) db.exec(sql);
    for (const u of UNIDADES) {
      const existentes = new Set(tablasExistentes(db).map((t) => t.name));
      const ev = evaluar(db, u, existentes);
      if (ev.conflicts.length) throw err('SCHEMA_CONFLICT', ev.conflicts.map((c) => c.message).join('; '));
      const habia = db.get('SELECT result FROM agentix_schema_migrations WHERE id = ?', [u.id]);
      let hizo = false;
      for (const op of ev.ops) { ejecutarOp(db, op, ctx); hizo = true; }
      // Postcondición de la unidad: estructura completa tras aplicar.
      const despues = evaluar(db, u, new Set(tablasExistentes(db).map((t) => t.name)));
      if (!despues.satisfecha) throw err('POSTCONDICION', `la migración ${u.id} no dejó la estructura esperada: ${JSON.stringify(despues.ops)}`);
      if (hizo) { aplicadas.push(u.id); registrar(db, u, 'APPLIED', opts.actor, opts.version, { ops: ev.ops.map((o) => o.op), cambios: ctx.cambios.filter((c) => c.unidad === u.id), dinamicas: ctx.dinamicas.filter((d) => ev.ops.some((o) => o.op === 'add_column_dynamic' && o.table === d.table && o.column === d.column)) }); }
      else if (!habia) { adoptadas.push(u.id); registrar(db, u, 'ADOPTED', opts.actor, opts.version, { nota: 'la estructura ya existía; inspeccionada, no modificada' }); }
    }
    db.run("INSERT OR REPLACE INTO agentix_schema_meta (key, value) VALUES ('level', ?)", [String(SUPPORTED_LEVEL)]);
    db.run("INSERT OR REPLACE INTO agentix_schema_meta (key, value) VALUES ('catalog_checksum', ?)", [CATALOG_CHECKSUM]);
    db.run("INSERT OR REPLACE INTO agentix_schema_meta (key, value) VALUES ('engine_version', ?)", [String(opts.version || '')]);
    db.run("INSERT OR REPLACE INTO agentix_schema_meta (key, value) VALUES ('last_applied_at', ?)", [new Date().toISOString()]);
    // Verificación final dentro de la transacción: si falla, revierte todo.
    const v = verify(db);
    if (!v.ok) throw err('VERIFICACION', 'verificación del esquema falló: ' + v.problemas.join('; '), { problemas: v.problemas });
  })();
  return { status: aplicadas.length ? 'APPLIED' : (adoptadas.length ? 'ADOPTED' : 'NO_CHANGES'), applied: aplicadas, adopted: adoptadas, dynamic_defaults: ctx.dinamicas, data_changes: ctx.cambios, warnings: inspect(db).warnings };
}

/** Postcondiciones: toda la estructura requerida existe y no hay pendientes. */
function verify(db) {
  const r = inspect(db);
  const problemas = [];
  if (r.status === 'NEWER_SCHEMA') problemas.push('esquema más nuevo que el soportado');
  for (const c of r.conflicts) problemas.push(c.message);
  for (const p of r.pending) problemas.push('pendiente: ' + p.id);
  // Columnas añadidas con default dinámico: con su trigger y sin NULL (el relleno declarado).
  const triggers = new Set(db.all("SELECT name FROM sqlite_master WHERE type='trigger'").map((t) => t.name));
  const existentes = new Set(tablasExistentes(db).map((t) => t.name));
  if (existentes.has('agentix_schema_migrations')) {
    for (const fila of db.all("SELECT id, details FROM agentix_schema_migrations WHERE result='APPLIED'")) {
      let d = null; try { d = JSON.parse(fila.details); } catch { d = null; }
      for (const x of (d && d.dinamicas) || []) {
        if (!triggers.has('agentix_dd_' + x.table + '_' + x.column)) problemas.push(`falta el trigger de default de ${x.table}.${x.column}`);
        const n = db.get(`SELECT count(*) AS n FROM ${q(x.table)} WHERE ${q(x.column)} IS NULL`);
        if (Number(n.n) > 0) problemas.push(`${x.table}.${x.column} tiene ${n.n} fila(s) sin valor tras el relleno`);
      }
    }
  }
  return { ok: problemas.length === 0, problemas, status: r.status };
}

/** Resumen corto para health / dashboard. */
function status(db) {
  const r = inspect(db);
  return {
    status: r.status, supported_level: r.supported_level, detected_level: r.detected_level,
    pending: r.pending.map((p) => p.id), conflicts: r.conflicts.map((c) => c.message),
    warnings: r.warnings.length, registry_entries: r.registry_entries, foreign_tables: r.foreign_tables.length,
  };
}

/** Compatibilidad con schema-columns.cjs: columnas del catálogo que faltan. */
function faltantes(db) {
  const r = inspect(db);
  const out = [];
  for (const p of r.pending) for (const o of p.ops) if (o.op === 'add_column' || o.op === 'add_column_dynamic') out.push(`${o.table}.${o.column}`);
  for (const p of r.pending) for (const o of p.ops) if (o.op === 'create_table') out.push(`tabla ${o.table}`);
  return out;
}

module.exports = {
  BASELINE, SUPPORTED_LEVEL, CATALOG_CHECKSUM, DATA_V2,
  derived_tables: DATA.derived_tables,
  catalog: DATA, unidades: () => UNIDADES.slice(),
  inspect, apply, verify, status, faltantes, afinidad,
};
