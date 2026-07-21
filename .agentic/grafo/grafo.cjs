#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { inferirAreaDesdeTexto } = require('./area-detector.cjs');

// ─── DB ADAPTER — better-sqlite3 nativo o sql.js puro JS ─────────────────────
// Intenta better-sqlite3 (rápido, nativo). Si falla, usa sql.js (puro JS, sin compilar).
// El usuario no hace nada — funciona en cualquier Windows/Mac/Linux automáticamente.

let dbAdapter = null; // 'better-sqlite3' | 'sqljs'

function getDB(dbPath) {
  // Intentar better-sqlite3 primero (nativo, rápido)
  if (dbAdapter !== 'node-sqlite' && dbAdapter !== 'sqljs') {
    try {
      const BS3 = require('better-sqlite3');
      const db = new BS3(dbPath);
      db.pragma('journal_mode = DELETE');
      db.pragma('synchronous = FULL');
      dbAdapter = 'better-sqlite3';
      return { db, type: 'better-sqlite3' };
    } catch(e) {}
  }

  // Fallback 1: node:sqlite — integrado en Node.js 22+
  if (dbAdapter !== 'sqljs') {
    try {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(dbPath);
      dbAdapter = 'node-sqlite';
      return { db, type: 'node-sqlite' };
    } catch(e) {}
  }

  // Fallback 2: sql.js — puro JS, cualquier Node version
  const projectRoot = path.join(__dirname, '..', '..');
  const searchPaths = [
    path.join(projectRoot, 'node_modules', 'sql.js', 'dist', 'sql-wasm.js'),
    path.join(__dirname, 'node_modules', 'sql.js', 'dist', 'sql-wasm.js'),
  ];

  for (const sqlPath of searchPaths) {
    if (fs.existsSync(sqlPath)) {
      try {
        // sql.js sync workaround usando Worker
        const SQL = require(sqlPath);
        let DbClass = null;
        if (SQL && SQL.Database) DbClass = SQL.Database;
        else if (typeof SQL === 'function') {
          // Intentar llamar sync
          let resolved = null;
          SQL({}).then(s => { resolved = s; }).catch(() => {});
          // Esperar máximo 3 segundos
          const start = Date.now();
          while (!resolved && Date.now() - start < 3000) {
            require('child_process').spawnSync('node', ['-e', ''], { timeout: 10 });
          }
          if (resolved && resolved.Database) DbClass = resolved.Database;
        }
        if (DbClass) {
          let buffer = null;
          if (fs.existsSync(dbPath)) buffer = fs.readFileSync(dbPath);
          const db = buffer ? new DbClass(buffer) : new DbClass();
          dbAdapter = 'sqljs';
          return { db, type: 'sqljs', path: dbPath };
        }
      } catch(e) {}
    }
  }

  throw new Error(
    'No se pudo inicializar el grafo SQLite.\n' +
    '  Tu versión de Node.js: ' + process.version + '\n' +
    '  Opciones:\n' +
    '  1. Usa Node.js 22+ (ya incluye SQLite integrado)\n' +
    '  2. Corre: npm install sql.js\n' +
    '  3. Instala Visual Studio Build Tools para better-sqlite3'
  );
}

// Wrapper unificado que abstrae las diferencias entre better-sqlite3 y sql.js
function createAdapter(dbPath) {
  const { db, type, path: sqlPath } = getDB(dbPath);

  if (type === 'better-sqlite3') {
    return {
      exec: (sql) => { try { db.exec(sql); } catch(e) {} },
      all:  (sql, ...params) => { try { return db.prepare(sql).all(...params.flat()); } catch(e) { return []; } },
      get:  (sql, ...params) => { try { return db.prepare(sql).get(...params.flat()); } catch(e) { return null; } },
      run:  (sql, ...params) => { try { db.prepare(sql).run(...params.flat()); } catch(e) {} },
      transaction: (fn) => db.transaction(fn),
      pragma: (p) => { try { db.pragma(p); } catch(e) {} },
      close: () => { try { db.close(); } catch(e) {} },
      prepare: (sql) => db.prepare(sql),
      type: 'better-sqlite3'
    };
  }

  if (type === 'node-sqlite') {
    // node:sqlite API — similar a better-sqlite3
    return {
      exec: (sql) => { try { db.exec(sql); } catch(e) {} },
      all:  (sql, ...params) => { try { return db.prepare(sql).all(...params.flat()); } catch(e) { return []; } },
      get:  (sql, ...params) => { try { return db.prepare(sql).get(...params.flat()); } catch(e) { return null; } },
      run:  (sql, ...params) => { try { db.prepare(sql).run(...params.flat()); } catch(e) {} },
      transaction: (fn) => (...args) => { try { fn(...args); } catch(e) {} },
      pragma: () => {},
      close: () => { try { db.close(); } catch(e) {} },
      prepare: (sql) => db.prepare(sql),
      type: 'node-sqlite'
    };
  }
    // sql.js API — puro JS, necesita guardar el archivo manualmente
    const saveDB = () => {
      try {
        const data = db.export();
        fs.writeFileSync(sqlPath, Buffer.from(data));
      } catch(e) {}
    };

    const runSQL = (sql, params) => {
      try { db.run(sql, params || []); } catch(e) {}
    };

    const execSQL = (sql) => {
      try { db.exec(sql); } catch(e) {}
    };

    const allSQL = (sql, ...params) => {
      try {
        const stmt = db.prepare(sql);
        const rows = [];
        const flatParams = params.flat();
        if (flatParams.length) stmt.bind(flatParams);
        while (stmt.step()) {
          const row = stmt.getAsObject();
          rows.push(row);
        }
        stmt.free();
        return rows;
      } catch(e) { return []; }
    };

    const getSQL = (sql, ...params) => {
      const rows = allSQL(sql, ...params);
      return rows[0] || null;
    };

    return {
      exec: execSQL,
      all: allSQL,
      get: getSQL,
      run: (sql, ...params) => { runSQL(sql, params.flat()); saveDB(); },
      transaction: (fn) => (...args) => { fn(...args); saveDB(); },
      pragma: () => {}, // no-op en sql.js
      close: () => saveDB(),
      // shim de statement para consumidores que usan db.prepare(sql).run/get/all
      prepare: (sql) => ({
        run: (...params) => { runSQL(sql, params.flat()); saveDB(); },
        get: (...params) => getSQL(sql, ...params),
        all: (...params) => allSQL(sql, ...params),
      }),
      type: 'sqljs',
      save: saveDB
    };
}

const ROOT        = path.join(__dirname, '..', '..');
// NOTA (Task 5): cuando AGENTIC_MEMORIA_PATH_OVERRIDE está seteado (sandbox de test),
// DB_PATH también debe sandboxearse. Sin esto, sincronizar() — que corre sola al
// hacer require() de este módulo vía el dispatcher CLI de abajo, sin guard de
// require.main — seguiría escribiendo nodos de prueba en la memoria.db REAL del
// proyecto aunque los .md de origen ya estén aislados. Visto en vivo: 3 nodos
// de prueba ("Fallo 1/2/3") quedaron insertados en la DB real antes de este fix.
const DB_PATH     = process.env.AGENTIC_MEMORIA_PATH_OVERRIDE
  ? path.join(process.env.AGENTIC_MEMORIA_PATH_OVERRIDE, '..', 'memoria.db')
  : path.join(ROOT, '.agentic', 'memoria.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');
const MEMORIA_PATH= process.env.AGENTIC_MEMORIA_PATH_OVERRIDE || path.join(ROOT, '.agentic', 'memoria');

// ─── INIT ──────────────────────────────────────────────────────────────────────
function initDB() {
  const adapter = createAdapter(DB_PATH);
  // Usar exec directo — más confiable que split por ;
  // porque el schema tiene comentarios -- inline dentro de CREATE TABLE
  try {
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
    adapter.exec(schema);
  } catch(e) {
    // Si falla el schema completo, intentar statement por statement
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
    // Remover comentarios inline antes de hacer split
    const clean = schema.replace(/--[^\n]*/g, '').replace(/\n\s*\n/g, '\n');
    clean.split(';').map(s => s.trim()).filter(s => s.length > 5).forEach(s => {
      try { adapter.exec(s + ';'); } catch(e) {}
    });
  }
  migrateDB(adapter);
  return adapter;
}

function migrateDB(db) {
  // v3.16.8 — arreglo de RAÍZ: en vez de que cada script mantenga su propia
  // lista dispersa de ALTER TABLE (la causa estructural del bug de
  // biocaresoft-saas), schema-columns.cjs es la fuente única de verdad de
  // TODAS las columnas conocidas del motor. Se corre PRIMERO acá porque
  // migrateDB() es el camino más transitado (cada `sync`, cada `aa:`).
  try { require('./schema-columns.cjs').ensureAllColumns(db); } catch {}

  const alteraciones = [
    "ALTER TABLE nodos ADD COLUMN ultima_validacion TEXT DEFAULT (datetime('now'))",
    // v3.16.7 — bug GLOBAL encontrado en biocaresoft-saas (2026-07-21): sincronizar()
    // INSERTA en archivos_aplica/hash_contexto, pero esas columnas SOLO las creaba
    // knowledge-validator.cjs (que corre dentro del post-cycle). En un proyecto
    // fresco donde `akdd sync` corre ANTES del primer post-cycle, el INSERT tronaba
    // "no column named archivos_aplica", el adaptador se lo tragaba, y sync reportaba
    // "N nodos nuevos" con 0 persistidos — dashboard vacío para siempre. El módulo
    // que ESCRIBE la columna debe garantizar que existe, sin depender de otro.
    "ALTER TABLE nodos ADD COLUMN archivos_aplica TEXT DEFAULT '[]'",
    "ALTER TABLE nodos ADD COLUMN hash_contexto TEXT",
    "ALTER TABLE ciclos ADD COLUMN tipo_tarea TEXT DEFAULT 'feature'",
    "ALTER TABLE ciclos ADD COLUMN memory_trace TEXT DEFAULT '[]'",
    "ALTER TABLE ciclos ADD COLUMN snapshot_inicio TEXT",
    "ALTER TABLE ciclos ADD COLUMN snapshot_fin TEXT",
    "ALTER TABLE fases ADD COLUMN duracion_ms INTEGER DEFAULT 0",
    "ALTER TABLE fases ADD COLUMN tokens_aprox INTEGER DEFAULT 0",
  ];
  alteraciones.forEach(sql => { try { db.exec(sql); } catch(e) {} });

  const indices = [
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_nodos_unique ON nodos(tipo, titulo)",
    "CREATE INDEX IF NOT EXISTS idx_nodos_area_tipo ON nodos(area, tipo)",
    "CREATE INDEX IF NOT EXISTS idx_nodos_area_confianza ON nodos(area, confianza)",
    "CREATE INDEX IF NOT EXISTS idx_nodos_tipo_confianza ON nodos(tipo, confianza)",
    "CREATE INDEX IF NOT EXISTS idx_nodos_tipo_estado ON nodos(tipo, estado)",
    "CREATE INDEX IF NOT EXISTS idx_nodos_area_tipo_estado ON nodos(area, tipo, estado)",
    "CREATE INDEX IF NOT EXISTS idx_nodos_confianza_aplicado ON nodos(confianza, aplicado)",
    "CREATE INDEX IF NOT EXISTS idx_ciclos_estado ON ciclos(estado)",
    "CREATE INDEX IF NOT EXISTS idx_ciclos_modulo ON ciclos(modulo)",
    "CREATE INDEX IF NOT EXISTS idx_ciclos_fecha ON ciclos(fecha_inicio)",
    "CREATE INDEX IF NOT EXISTS idx_fases_ciclo ON fases(ciclo_id)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_rel_unique ON relaciones(desde_id, tipo, hacia_id)",
  ];
  indices.forEach(sql => { try { db.exec(sql); } catch(e) {} });

  // v2.2 — nuevas tablas (seguro llamar múltiples veces)
  const tablasV22 = [
    `CREATE TABLE IF NOT EXISTS git_context_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sesion_id TEXT NOT NULL,
      rama TEXT, commit_hash TEXT,
      archivos_modificados TEXT DEFAULT '[]',
      riesgos_detectados TEXT DEFAULT '[]',
      predicciones TEXT DEFAULT '[]',
      tiene_riesgos_altos INTEGER DEFAULT 0,
      fecha TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS cicd_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      episodio_id TEXT, plataforma TEXT DEFAULT 'github',
      workflow TEXT, rama TEXT, commit_hash TEXT, actor TEXT, repo TEXT,
      run_id TEXT, run_url TEXT,
      tests_pasando INTEGER DEFAULT 0, tests_fallando INTEGER DEFAULT 0,
      archivos_tocados TEXT DEFAULT '[]', errores_tests TEXT DEFAULT '[]',
      es_exito INTEGER DEFAULT 0,
      fecha TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS prediction_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tarea TEXT, modulo TEXT, archivos TEXT DEFAULT '[]',
      nivel_predicho TEXT, alertas TEXT DEFAULT '[]', precondiciones TEXT DEFAULT '[]',
      fue_correcto INTEGER, ciclo_id TEXT,
      fecha TEXT DEFAULT (datetime('now'))
    )`,
  ];
  tablasV22.forEach(sql => { try { db.exec(sql); } catch(e) {} });

  // v2.2 — embedding en episodios
  const migracionesV22 = [
    "ALTER TABLE episodios ADD COLUMN embedding TEXT",
  ];
  migracionesV22.forEach(sql => { try { db.exec(sql); } catch(e) {} });

  // v2.2 — índices nuevas tablas
  const indicesV22 = [
    "CREATE INDEX IF NOT EXISTS idx_git_context_fecha ON git_context_log(fecha)",
    "CREATE INDEX IF NOT EXISTS idx_cicd_rama ON cicd_reports(rama)",
    "CREATE INDEX IF NOT EXISTS idx_prediction_fecha ON prediction_log(fecha)",
  ];
  indicesV22.forEach(sql => { try { db.exec(sql); } catch(e) {} });
}

// ─── SNAPSHOT ─────────────────────────────────────────────────────────────────
function snapshotMemoria(db) {
  try {
    const snap = { fecha: new Date().toISOString(), totales: {}, por_tipo: {}, alta_rules: [] };
    snap.totales.total    = (db.get('SELECT COUNT(*) as n FROM nodos') || {}).n || 0;
    snap.totales.alta     = (db.get("SELECT COUNT(*) as n FROM nodos WHERE confianza='ALTA'") || {}).n || 0;
    snap.totales.media    = (db.get("SELECT COUNT(*) as n FROM nodos WHERE confianza='MEDIA'") || {}).n || 0;
    snap.totales.activos  = (db.get("SELECT COUNT(*) as n FROM nodos WHERE estado='ACTIVO'") || {}).n || 0;
    snap.totales.obsoletos= (db.get("SELECT COUNT(*) as n FROM nodos WHERE estado='OBSOLETO'") || {}).n || 0;
    snap.alta_rules = db.all("SELECT titulo, tipo, area FROM nodos WHERE confianza='ALTA' AND estado='ACTIVO'");
    const porTipo = db.all('SELECT tipo, COUNT(*) as n FROM nodos GROUP BY tipo');
    porTipo.forEach(r => snap.por_tipo[r.tipo] = r.n);
    return snap;
  } catch(e) { return null; }
}

// ─── EXTRAER ARCHIVOS EXPLÍCITOS DE UNA ENTRADA ──────────────────────────────
// decisiones.md/errores.md ya citan archivos reales entre backticks en sus
// campos "Impacto:"/"Contexto:"/"Evidencia:" (convención ya usada en todo el
// proyecto, ej. "Impacto: `public/panel/index.html` (fusión de...)"). Antes
// de esto, archivos_aplica en la BD se llenaba con una aproximación genérica
// (los archivos del ÚLTIMO commit, iguales para TODOS los nodos de ese sync,
// no específicos a cada decisión) — sin forma de saber qué archivo afecta
// una decisión de layout en particular. Esto extrae los archivos REALES que
// la propia entrada menciona, filtrando selectores CSS (`.dialog-form`) y
// llamadas a función (`openContactoPanel()`) que también usan backticks.
function pareceRutaDeArchivo(token) {
  if (token.includes(' ')) return false;                // snippet de código o comando, no archivo suelto
  if (token.startsWith('@')) return false;               // paquete npm con scope (@supabase/supabase-js)
  if (token.endsWith('()')) return false;                // función, no archivo
  if (/^(GET|POST|PUT|PATCH|DELETE)\s+\//i.test(token)) return false; // ruta de API, no archivo
  if (token.startsWith('.') && !/^\.\.?\//.test(token)) return false; // selector CSS (.dialog-form, .a/-b)
  if (token.includes('/')) return PREFIJOS_CARPETA.some(p => token.startsWith(p)) || EXTENSIONES.test(token);
  return EXTENSIONES.test(token);
}

// Prefijos de carpeta real conocidos en este tipo de proyecto — un token con
// "/" que NO empieza por ninguno de estos y no tiene extensión reconocible es
// casi siempre otra cosa (nombres de variable "a/b", fragmento de ruta suelto
// "/activar", paquete npm "@scope/pkg"), no un archivo real del repo.
const PREFIJOS_CARPETA = ['src/', 'public/', 'tests/', 'scripts/', 'docs/', '_output/', 'data/', 'prisma/', '.agentic/', 'node_modules/', './', '../'];
const EXTENSIONES = /\.(ts|tsx|js|jsx|md|json|css|scss|html|py|php|sql|cjs|mjs|ya?ml|prisma)$/i;

function extraerArchivosExplicitos(texto) {
  const tokens = [...texto.matchAll(/`([^`]+)`/g)].map(m => m[1].trim());
  const archivos = tokens.filter(pareceRutaDeArchivo);
  return [...new Set(archivos)];
}

// ─── CRUCE MEMORIA ↔ SÍMBOLOS DE CÓDIGO (sesión 15/07/2026) ──────────────────
// Hasta ahora una decisión/error se conectaba con código solo por coincidencia
// de RUTA de archivo (archivosExplicitos arriba, o área≈ en el dashboard) —
// nunca por lo que la propia entrada dice. Si "arreglamos el `POST /login`" y
// ast_symbols ya tiene un endpoint real con ese nombre exacto (Bloque B),
// ahora se crea un vínculo de verdad en vez de una aproximación por carpeta.
//
// Bug real encontrado probando contra decisiones.md/errores.md reales: la
// primera versión comparaba el símbolo contra TODO el texto (texto.includes),
// y eso generaba decenas de falsos positivos — constantes como NEGOCIO,
// EMBUDO, HTML, BASE también son palabras normales del español/código que
// aparecen en cualquier párrafo sin relación real con el símbolo (ej.
// "segundo NEGOCIO bajo cuenta" no está hablando de la constante NEGOCIO).
// Fix: igual que ya hace extraerArchivosExplicitos arriba, solo cuenta si el
// símbolo aparece envuelto en backticks — es la convención que el propio
// proyecto ya usa para citar código real, no prosa. Comparación EXACTA de
// token (no substring), así "GET /" tampoco matchea dentro de "GET /:id".
function extraerSimbolosMencionados(texto, simbolosDisponibles) {
  const tokens = new Set([...texto.matchAll(/`([^`]+)`/g)].map(m => m[1].trim()));
  if (!tokens.size) return [];
  return simbolosDisponibles.filter(s => tokens.has(s.symbol_name));
}

// ─── PARSEAR ENTRADAS ─────────────────────────────────────────────────────────
function parsearEntradas(contenido, tipo) {
  const entradas = [];
  // Remover bloques de comentario HTML (plantillas/ejemplos) ANTES de partir:
  // sus encabezados `## ` internos NO deben generar nodos fantasma.
  contenido = contenido.replace(/<!--[\s\S]*?-->/g, '');
  // Una entrada real SIEMPRE tiene al menos un campo estructurado. Este criterio
  // positivo descarta headers de archivo (#), secciones de scaffolding
  // (Registro / Patrones activos / Ejemplos…) y cualquier texto suelto, sin
  // depender de una lista frágil de prefijos a excluir.
  const CAMPO_RE = /^(Área|Area|Confianza|Estado|Aplicado|Útil|Util|Prioridad|Error|Síntoma|Sintoma|Causa|Solución|Solucion|Regla|Razón|Razon|Decisión|Decision|Contexto|Aplica a):/m;
  const secciones = contenido.split(/^## /m).filter(s => {
    const t = s.trim();
    if (!t || t.length < 10) return false;
    if (t.startsWith('#')) return false;   // header de archivo / preámbulo
    return CAMPO_RE.test(s);               // sólo secciones con campos reales
  });
  for (const sec of secciones) {
    const lineas = sec.split('\n');
    const titulo = lineas[0].trim().replace(/^\[.*?\]\s*/, '').trim();
    if (!titulo || titulo.length < 5) continue;
    const e = { tipo, titulo, contenido: sec, area: null, confianza: 'BAJA',
      aplicado: 0, util: 0, estado: 'ACTIVO', ultima_validacion: new Date().toISOString() };
    for (const l of lineas) {
      if (l.startsWith('Área:') || l.startsWith('Area:'))
        e.area = l.split(':')[1]?.trim() || null;
      if (l.startsWith('Confianza:'))
        e.confianza = l.split(':')[1]?.trim() || 'BAJA';
      if (l.startsWith('Aplicado:'))
        e.aplicado = parseInt(l.split(':')[1]?.trim()) || 0;
      if (l.startsWith('Útil:') || l.startsWith('Util:'))
        e.util = parseInt(l.split(':')[1]?.trim()) || 0;
      if (l.startsWith('Estado:'))
        e.estado = l.split(':')[1]?.trim().split(' ')[0] || 'ACTIVO';
      if (l.startsWith('Última validación:') || l.startsWith('Ultima validacion:'))
        e.ultima_validacion = l.split(':').slice(1).join(':').trim();
    }
    // Muchas entradas (errores.md y decisiones.md, a diferencia de patrones.md)
    // nunca tuvieron un campo "Área:" en su formato — antes de este fix caían
    // TODAS en 'global' sin importar su contenido real. Como fallback, se
    // infiere del título+contenido antes de resignarse a 'global'.
    if (!e.area) e.area = inferirAreaDesdeTexto(titulo, sec);
    e.archivosExplicitos = extraerArchivosExplicitos(sec);
    entradas.push(e);
  }
  return entradas;
}

// ─── PROMOCIÓN DE PATRONES ESTRUCTURALES ──────────────────────────────────────
// Si la misma "Cadena estructural" (ver Task 4 de watch-errors.cjs) aparece en
// 3+ entradas de errores.md, se promueve automáticamente a patrón HIGH
// confidence en patrones.md. Corre sola, dentro de sincronizar() — nada manual.
function promoverPatronesEstructurales() {
  const erroresPath = path.join(MEMORIA_PATH, 'errores.md');
  const patronesPath = path.join(MEMORIA_PATH, 'patrones.md');
  if (!fs.existsSync(erroresPath)) return { promovidos: 0 };

  const contenido = fs.readFileSync(erroresPath, 'utf8');
  const cadenaRe = /^Cadena estructural: (.+?) \(severidad: (\w+)\)/gm;
  const conteo = {};
  let m;
  while ((m = cadenaRe.exec(contenido)) !== null) {
    const cadena = m[1].trim();
    conteo[cadena] = (conteo[cadena] || 0) + 1;
  }

  const patronesExistente = fs.existsSync(patronesPath) ? fs.readFileSync(patronesPath, 'utf8') : '';
  let promovidos = 0;

  for (const [cadena, count] of Object.entries(conteo)) {
    if (count < 3) continue;
    const marcador = `[ESTRUCTURAL] ${cadena}`;
    if (patronesExistente.includes(marcador)) continue;

    const fecha = new Date().toISOString().split('T')[0];
    const entrada = `
## ${fecha} ${marcador}
Área: global
Confianza: ALTA
Aplicado: ${count}
Útil: ${count}
Estado: ACTIVO
Origen: promoción automática — cadena estructural repetida ${count} veces
Patrón: la cadena de archivos ${cadena} ha causado fallos repetidos.
Antes de tocar cualquiera de estos archivos, revisar el historial de esta cadena.
`;
    if (!fs.existsSync(patronesPath)) {
      fs.mkdirSync(path.dirname(patronesPath), { recursive: true });
      fs.writeFileSync(patronesPath, '# Patrones — Agentic KDD\n\n', 'utf8');
    }
    fs.appendFileSync(patronesPath, entrada, 'utf8');
    promovidos++;
  }

  return { promovidos };
}

// ─── SINCRONIZAR ──────────────────────────────────────────────────────────────
function sincronizar() {
  const db = initDB();
  const archivos = [
    { file: 'errores.md', tipo: 'error' },
    { file: 'patrones.md', tipo: 'patron' },
    { file: 'decisiones.md', tipo: 'decision' }
  ];
  let total = 0, nuevos = 0, actualizados = 0;

  // archivos_aplica/hash_contexto: sin esto, todo nodo quedaba con '[]'/null para
  // siempre y knowledge-validator.cjs nunca tenía con qué detectar obsolescencia.
  // Aproximación razonable (no exacta por nodo): los archivos del último commit,
  // vía el mismo git diff-tree que ya usa post-cycle.cjs para episodios.
  let archivosRecientes = [];
  try {
    const { execSync } = require('child_process');
    const diff = execSync('git diff-tree --no-commit-id --name-only -r HEAD', { cwd: process.cwd(), stdio: 'pipe', timeout: 5000 }).toString();
    archivosRecientes = diff.split('\n').map(f => f.trim()).filter(Boolean);
  } catch { /* sin git o sin commits — queda vacío, no rompe nada */ }
  let hashContexto = null;
  if (archivosRecientes.length) {
    try {
      const kv = require('./knowledge-validator.cjs');
      hashContexto = kv.computeContextHash(archivosRecientes, process.cwd());
    } catch {}
  }
  const archivosJSON = JSON.stringify(archivosRecientes);

  // Símbolos indexados una sola vez (no por-entrada) — evita cientos de
  // queries repetidas cuando hay muchas entradas en decisiones/errores/patrones.
  let simbolosIndexados = [];
  try {
    simbolosIndexados = db.all(
      "SELECT file, kind, symbol_name FROM ast_symbols WHERE kind IN ('endpoint','constant','sql_table','sql_index')"
    );
  } catch { /* ast_symbols puede no existir si nunca se corrió ast-indexer.cjs */ }

  for (const { file, tipo } of archivos) {
    const fp = path.join(MEMORIA_PATH, file);
    if (!fs.existsSync(fp)) continue;
    const entradas = parsearEntradas(fs.readFileSync(fp, 'utf8'), tipo);
    for (const e of entradas) {
      // Si la propia entrada cita archivos reales (Impacto:/Contexto:/Evidencia:
      // entre backticks), eso es MÁS preciso que "los archivos del último commit"
      // — permite que 02-analista.md relacione una decisión de layout con el
      // archivo exacto que toca, no solo con lo que cambió en el commit más
      // reciente (que puede no tener nada que ver con esta entrada en particular).
      const archivosNodo = e.archivosExplicitos && e.archivosExplicitos.length
        ? JSON.stringify(e.archivosExplicitos)
        : archivosJSON;
      const hashNodo = e.archivosExplicitos && e.archivosExplicitos.length
        ? (() => { try { return require('./knowledge-validator.cjs').computeContextHash(e.archivosExplicitos, process.cwd()); } catch { return hashContexto; } })()
        : hashContexto;

      const ex = db.get('SELECT id FROM nodos WHERE tipo=? AND titulo=?', e.tipo, e.titulo);
      if (ex) {
        db.run(`UPDATE nodos SET contenido=?,area=?,confianza=?,aplicado=?,util=?,estado=?,ultima_validacion=?,
                fecha_update=datetime('now'),archivos_aplica=?,hash_contexto=? WHERE tipo=? AND titulo=?`,
          e.contenido, e.area, e.confianza, e.aplicado, e.util, e.estado, e.ultima_validacion, archivosNodo, hashNodo, e.tipo, e.titulo);
        actualizados++;
      } else {
        db.run(`INSERT INTO nodos (tipo,titulo,contenido,area,confianza,aplicado,util,estado,ultima_validacion,fecha_update,archivos_aplica,hash_contexto)
                VALUES (?,?,?,?,?,?,?,?,?,datetime('now'),?,?)`,
          e.tipo, e.titulo, e.contenido, e.area, e.confianza, e.aplicado, e.util, e.estado, e.ultima_validacion, archivosNodo, hashNodo);
        nuevos++;
      }
      total++;

      if (simbolosIndexados.length) {
        const mencionados = extraerSimbolosMencionados(e.contenido, simbolosIndexados);
        for (const s of mencionados) {
          try {
            db.run(`INSERT OR IGNORE INTO relaciones_semanticas
                    (desde_entidad, tipo, hacia_entidad, peso, descripcion) VALUES (?,?,?,?,?)`,
              `nodo:${e.tipo}:${e.titulo}`, 'menciona_simbolo', `${s.kind}:${s.symbol_name}`, 1.0, s.file);
          } catch {}
        }
      }
    }
  }
  if (db.type === 'sqljs' && db.save) db.save();
  detectarRelaciones(db);
  // Gap CoALA: consolidación episódica automática
  // Episodios "resuelto" sin consolidar → extraer como patrones/errores
  try {
    const episodiosPendientes = db.all(
      `SELECT * FROM episodios WHERE consolidado=0 AND resultado='resuelto' 
       AND tipo IN ('fix','error') ORDER BY fecha DESC LIMIT 20`
    );
    episodiosPendientes.forEach(ep => {
      try {
        // Solo consolidar si tiene suficiente info
        if (!ep.descripcion || !ep.accion_tomada) return;
        const titulo = `[EP] ${ep.descripcion.slice(0, 80)}`;
        const ex = db.get('SELECT id FROM nodos WHERE titulo=?', titulo);
        if (!ex) {
          const contenido = `## ${ep.fecha.split('T')[0]} [EP] ${ep.descripcion}
Área: ${ep.area || 'global'}
Confianza: BAJA
Estado: ACTIVO
Origen: consolidado de episodio
Fix aplicado: ${ep.accion_tomada}
Razón: ${ep.razon_resultado || 'ver episodio original'}`;
          db.run(`INSERT INTO nodos (tipo,titulo,contenido,area,confianza,aplicado,util,estado,ultima_validacion,fecha_update) 
                  VALUES (?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
            'error', titulo, contenido, ep.area || 'global', 'BAJA', 1, 1, 'ACTIVO');
          const nodoId = (db.get('SELECT id FROM nodos WHERE titulo=?', titulo) || {}).id;
          if (nodoId) {
            db.run('UPDATE episodios SET consolidado=1, nodo_generado_id=? WHERE id=?', nodoId, ep.id);
          }
        }
      } catch(e) {}
    });
  } catch(e) {}
  // Gap CoALA: decay automático — patrones sin uso pierden relevancia
  try {
    const ahora = Date.now();
    const nodos = db.all("SELECT id, ultimo_acceso, fecha_creacion, aplicado, confianza FROM nodos WHERE estado='ACTIVO'");
    nodos.forEach(n => {
      const base = n.ultimo_acceso || n.fecha_creacion;
      const dias = base ? (ahora - new Date(base).getTime()) / (1000*60*60*24) : 0;
      const tasa = { 'ALTA': 0.003, 'MEDIA': 0.008, 'BAJA': 0.015 }[n.confianza] || 0.01;
      const decay = Math.max(0.1, 1.0 - (dias * tasa));
      let estado = 'ACTIVO';
      if (decay < 0.3 && n.confianza === 'BAJA' && (n.aplicado || 0) === 0) estado = 'OBSOLETO';
      try { db.run('UPDATE nodos SET decay_score=?, estado=? WHERE id=?', decay, estado, n.id); } catch(e) {}
    });
  } catch(e) {}
  // Forzar checkpoint WAL para que los datos queden en la DB principal
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch(e) {}

  // v3.16.7 — anti-éxito-falso: el adaptador traga errores de INSERT en
  // try/catch, así que `total`/`nuevos` cuentan intentos, no filas reales.
  // Si contamos 6 "nuevos" pero la tabla tiene 0, algo se tragó los writes
  // (schema desalineado) — hay que GRITARLO, no reportar verde falso (el bug
  // exacto de biocaresoft-saas: sync decía "6 nuevos" con 0 persistidos).
  let realCount = null;
  try { realCount = (db.get('SELECT COUNT(*) n FROM nodos') || {}).n; } catch {}
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch(e) {}
  db.close();

  if (total > 0 && realCount != null && realCount === 0) {
    console.log(`\n  ⚠️  ALERTA: sync intentó escribir ${total} nodo(s) pero la tabla nodos quedó en 0.`);
    console.log(`  Los INSERT se están tragando en silencio — casi seguro un schema desalineado.`);
    console.log(`  Corre:  node .agentic/grafo/grafo.cjs sync   (ya migra las columnas) o  akdd health --fix\n`);
  } else {
    console.log(`\n  Grafo sincronizado — ${realCount != null ? realCount : total} nodos (${nuevos} nuevos, ${actualizados} actualizados)`);
  }
  console.log(`  Motor: ${dbAdapter === 'better-sqlite3' ? 'nativo (<5ms)' : dbAdapter === 'node-sqlite' ? 'node:sqlite (Node.js 22+)' : 'sql.js (<20ms)'}\n`);

  // Promoción automática de patrones estructurales (Task 5) — corre siempre,
  // sin comando manual, como parte del sync normal del grafo.
  try {
    const promo = promoverPatronesEstructurales();
    if (promo.promovidos > 0) {
      console.log(`[GRAFO] ${promo.promovidos} patrón(es) estructural(es) promovido(s) a ALTA confianza`);
    }
  } catch (e) {
    console.error('[GRAFO] Error en promoción estructural (no bloqueante):', e.message);
  }
}

// ─── RELACIONES ────────────────────────────────────────────────────────────────
function detectarRelaciones(db) {
  const nodos = db.all('SELECT * FROM nodos');
  for (const n of nodos) for (const o of nodos) {
    if (n.id === o.id) continue;
    if (n.tipo==='error'  && o.tipo==='patron'   && (n.area===o.area||o.area==='global'))
      try { db.run('INSERT OR IGNORE INTO relaciones (desde_id,tipo,hacia_id,peso) VALUES (?,?,?,?)', n.id,'resuelto_por',o.id,1.0); } catch(e) {}
    if (n.tipo==='patron' && o.tipo==='decision' && (n.area===o.area||o.area==='global'))
      try { db.run('INSERT OR IGNORE INTO relaciones (desde_id,tipo,hacia_id,peso) VALUES (?,?,?,?)', n.id,'origino',o.id,0.8); } catch(e) {}
    if (n.area===o.area && n.area!=='global' && n.id<o.id)
      try { db.run('INSERT OR IGNORE INTO relaciones (desde_id,tipo,hacia_id,peso) VALUES (?,?,?,?)', n.id,'relacionado_con',o.id,0.5); } catch(e) {}
    if (n.confianza==='ALTA' && o.confianza==='ALTA' && n.area===o.area && n.id<o.id)
      try { db.run('INSERT OR IGNORE INTO relaciones (desde_id,tipo,hacia_id,peso) VALUES (?,?,?,?)', n.id,'aplica_a',o.id,1.5); } catch(e) {}
  }
  if (db.type === 'sqljs' && db.save) db.save();
}

// ─── CONSULTAR ────────────────────────────────────────────────────────────────
function consultar(area, tipo) {
  const db = initDB();
  const trace = { area, tipo, timestamp: new Date().toISOString(), nodos_retornados: 0, titulos: [] };
  let sql = "SELECT * FROM nodos WHERE estado='ACTIVO'";
  const params = [];
  if (area && area !== 'global') { sql += " AND (area=? OR area='global')"; params.push(area); }
  if (tipo) { sql += " AND tipo=?"; params.push(tipo); }
  sql += " ORDER BY CASE confianza WHEN 'ALTA' THEN 0 WHEN 'MEDIA' THEN 1 ELSE 2 END, util DESC, aplicado DESC";
  const resultados = db.all(sql, ...params);
  trace.nodos_retornados = resultados.length;
  trace.titulos = resultados.slice(0,5).map(r => r.titulo);
  db.close();
  return { resultados, trace };
}

// ─── STATS ────────────────────────────────────────────────────────────────────
function stats() {
  const db = initDB();
  const totalNodos = (db.get('SELECT COUNT(*) as n FROM nodos') || {}).n || 0;
  const totalRels  = (db.get('SELECT COUNT(*) as n FROM relaciones') || {}).n || 0;
  const porTipo    = db.all('SELECT tipo, COUNT(*) as n FROM nodos GROUP BY tipo');
  const porConf    = db.all('SELECT confianza, COUNT(*) as n FROM nodos GROUP BY confianza');
  const altas      = db.all("SELECT titulo,tipo,area FROM nodos WHERE confianza='ALTA' AND estado='ACTIVO'");
  let cicloStats   = null;
  try {
    const total = (db.get('SELECT COUNT(*) as n FROM ciclos') || {}).n || 0;
    if (total > 0) {
      const comp  = (db.get("SELECT COUNT(*) as n FROM ciclos WHERE estado='COMPLETADO'") || {}).n || 0;
      const stops = (db.get("SELECT COUNT(*) as n FROM ciclos WHERE estado='STOP'") || {}).n || 0;
      cicloStats = { total, comp, stops, goal: Math.round(comp/total*100) };
    }
  } catch(e) {}
  db.close();

  console.log('\n  GRAFO DE CONOCIMIENTO — Agentic KDD\n');
  console.log(`  Motor: ${dbAdapter === 'better-sqlite3' ? 'better-sqlite3 nativo' : dbAdapter === 'node-sqlite' ? 'node:sqlite (Node.js 22+)' : 'sql.js (compatible Windows)'}`);
  console.log(`  Total nodos: ${totalNodos} | Relaciones: ${totalRels}`);
  if (porTipo.length)  { console.log('\n  Por tipo:');      porTipo.forEach(r => console.log(`    ${r.tipo}: ${r.n}`)); }
  if (porConf.length)  { console.log('\n  Por confianza:'); porConf.forEach(r => console.log(`    ${r.confianza}: ${r.n}`)); }
  if (altas.length)    { console.log('\n  Reglas ALTA (permanentes):'); altas.forEach(r => console.log(`    [${r.tipo}] ${r.titulo} (${r.area})`)); }
  if (cicloStats)      { console.log(`\n  Ciclos: ${cicloStats.total} | Completados: ${cicloStats.comp} | STOPs: ${cicloStats.stops} | Goal Attainment: ${cicloStats.goal}%`); }
  if (totalNodos === 0) console.log('\n  Sin datos — usa aa: para empezar.');
  console.log('');
}

// ─── MÉTRICAS ─────────────────────────────────────────────────────────────────
function metricas() {
  try {
    const db = initDB();
    const ciclos = db.all('SELECT * FROM ciclos ORDER BY fecha_inicio DESC');
    if (!ciclos.length) { db.close(); return { total: 0, mensaje: 'Sin ciclos aun' }; }
    const total       = ciclos.length;
    const completados = ciclos.filter(c => c.estado==='COMPLETADO').length;
    const stops       = ciclos.filter(c => c.estado==='STOP').length;
    const goal        = Math.round(completados/total*100);
    const autonomy    = Math.round((total-stops)/total*100);
    const totalFases  = ciclos.reduce((s,c)=>s+(c.fases_total||0),0);
    const fasesOK     = ciclos.reduce((s,c)=>s+(c.fases_completadas||0),0);
    const handoff     = totalFases>0?Math.round(fasesOK/totalFases*100):0;
    const blockers    = ciclos.reduce((s,c)=>s+(c.review_blockers||0),0);
    const drift       = (blockers/total).toFixed(2);
    const guardrails  = ciclos.filter(c=>c.context_guard==='STOP').length;
    let pats=0, errs=0;
    ciclos.forEach(c=>{
      try{pats+=JSON.parse(c.patrones_aplicados||'[]').length;}catch(e){}
      try{errs+=JSON.parse(c.errores_evitados||'[]').length;}catch(e){}
    });
    const tGen = ciclos.reduce((s,c)=>s+(c.tests_generados||0),0);
    const tOK  = ciclos.reduce((s,c)=>s+(c.tests_pasando||0),0);
    // Éxito por tipo de tarea
    const tipoMap = {};
    ciclos.forEach(c=>{
      const t = c.tipo_tarea||'feature';
      if(!tipoMap[t]) tipoMap[t]={total:0,ok:0};
      tipoMap[t].total++;
      if(c.estado==='COMPLETADO') tipoMap[t].ok++;
    });
    const exito_por_tipo = Object.entries(tipoMap).map(([tipo,v])=>({
      tipo, total:v.total, ok:v.ok, rate:Math.round(v.ok/v.total*100)
    }));
    // Evolución de memoria
    let evolucion = null;
    const conSnap = ciclos.filter(c=>c.snapshot_fin);
    if (conSnap.length>=2) {
      try {
        const p = JSON.parse(conSnap[conSnap.length-1].snapshot_fin);
        const u = JSON.parse(conSnap[0].snapshot_fin);
        evolucion = {
          nodos_inicio: p.totales?.total||0, nodos_ahora: u.totales?.total||0,
          alta_inicio: p.totales?.alta||0,   alta_ahora:  u.totales?.alta||0,
          crecimiento: (u.totales?.total||0)-(p.totales?.total||0)
        };
      } catch(e) {}
    }
    db.close();
    return {
      total, completados, stops,
      goal_attainment: goal, autonomy_ratio: autonomy,
      handoff_integrity: handoff, drift_index: drift,
      guardrail_violations: guardrails,
      patrones_aplicados: pats, errores_evitados: errs,
      test_rate: tGen>0?Math.round(tOK/tGen*100):0,
      tests_generados: tGen, tests_pasando: tOK,
      exito_por_tipo, evolucion_memoria: evolucion,
      ciclos_recientes: ciclos.slice(0,15),
      motor: dbAdapter
    };
  } catch(e) { return { total:0, error: e.message }; }
}

// ─── REGISTRAR CICLO ──────────────────────────────────────────────────────────
function registrarCiclo(datos) {
  try {
    const db = initDB();
    const ciclo_id = crypto.randomUUID
      ? crypto.randomUUID()
      : Date.now().toString(36)+Math.random().toString(36).slice(2);
    const snap = snapshotMemoria(db);
    db.run(`INSERT INTO ciclos (ciclo_id,tarea,tipo_tarea,modulo,area,estado,context_guard,
      fases_total,fases_completadas,patrones_aplicados,errores_evitados,decisiones_usadas,
      memory_trace,tests_generados,tests_pasando,review_blockers,review_required,stops_count,
      sync_grafo,duracion_ms,snapshot_inicio,snapshot_fin,fecha_fin)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`,
      ciclo_id,
      datos.tarea||'',
      datos.tipo_tarea||'feature',
      datos.modulo||'global',
      datos.area||'global',
      datos.estado||'COMPLETADO',
      datos.context_guard||'OK',
      datos.fases_total||0,
      datos.fases_completadas||0,
      JSON.stringify(datos.patrones_aplicados||[]),
      JSON.stringify(datos.errores_evitados||[]),
      JSON.stringify(datos.decisiones_usadas||[]),
      JSON.stringify(datos.memory_trace||[]),
      datos.tests_generados||0,
      datos.tests_pasando||0,
      datos.review_blockers||0,
      datos.review_required||0,
      datos.stops_count||0,
      datos.sync_grafo?1:0,
      datos.duracion_ms||0,
      snap?JSON.stringify(snap):null,
      snap?JSON.stringify(snap):null
    );
    if (datos.fases && Array.isArray(datos.fases)) {
      datos.fases.forEach(f => {
        try {
          db.run(`INSERT OR IGNORE INTO fases (ciclo_id,fase_num,fase_nombre,agente,estado,
            memoria_leida,decision_tomada,resultado,intentos,duracion_ms,fecha_fin)
            VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'))`,
            ciclo_id,f.num||0,f.nombre||'',f.agente||'',f.estado||'COMPLETADO',
            JSON.stringify(f.memoria_leida||[]),f.decision||'',f.resultado||'',
            f.intentos||1,f.duracion_ms||0);
        } catch(e) {}
      });
    }
    if (db.type==='sqljs' && db.save) db.save();
    db.close();
    return ciclo_id;
  } catch(e) { return null; }
}

// ─── EMBEDDINGS SEMÁNTICOS (opcional) ─────────────────────────────────────────
async function buscarSemantico(query, topK) {
  topK = topK||5;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const {resultados} = consultar(query, null);
    return resultados.slice(0,topK);
  }
  try {
    const queryEmb = await getEmbedding(query, apiKey);
    if (!queryEmb) { const {resultados}=consultar(query,null); return resultados.slice(0,topK); }
    const db = initDB();
    const nodos = db.all("SELECT * FROM nodos WHERE estado='ACTIVO'");
    db.close();
    const scored = [];
    for (const n of nodos) {
      const txt = `${n.titulo} ${n.area} ${(n.contenido||'').slice(0,400)}`;
      const emb  = await getEmbedding(txt, apiKey);
      if (emb) scored.push({...n, _score: cosineSim(queryEmb,emb)});
    }
    return scored.sort((a,b)=>b._score-a._score).slice(0,topK);
  } catch(e) {
    const {resultados} = consultar(query,null);
    return resultados.slice(0,topK);
  }
}

async function getEmbedding(text, apiKey) {
  return new Promise(resolve => {
    try {
      const https = require('https');
      const body = JSON.stringify({model:'voyage-3',input:[text],input_type:'document'});
      const req = https.request({
        hostname:'api.voyageai.com',path:'/v1/embeddings',method:'POST',
        headers:{'Authorization':`Bearer ${apiKey}`,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}
      }, res => {
        let d=''; res.on('data',c=>d+=c);
        res.on('end',()=>{ try{resolve(JSON.parse(d).data?.[0]?.embedding||null);}catch(e){resolve(null);} });
      });
      req.on('error',()=>resolve(null));
      req.setTimeout(5000,()=>{req.destroy();resolve(null);});
      req.write(body); req.end();
    } catch(e) { resolve(null); }
  });
}

function cosineSim(a,b) {
  if (!a||!b||a.length!==b.length) return 0;
  let dot=0,na=0,nb=0;
  for(let i=0;i<a.length;i++){dot+=a[i]*b[i];na+=a[i]*a[i];nb+=b[i]*b[i];}
  return dot/(Math.sqrt(na)*Math.sqrt(nb)||1);
}

// ─── Indexado automático de embeddings (búsqueda vectorial real) ──────────────
// Corre en cada `akdd sync`. Incremental: tras el primer run solo embebe nodos
// nuevos/cambiados. La promesa sin await mantiene vivo el event loop (inferencia
// async) hasta terminar, así el proceso no sale antes de persistir.
async function _autoIndexEmbeddings() {
  try {
    const embMod = getEmbeddingsModuleGrafo();
    if (!embMod || typeof embMod.isAvailable !== 'function' || !embMod.isAvailable()) return;
    const db = initDB();
    const r = await embMod.indexarPendientes(db, 30);
    if (r && r.indexados > 0) console.error(`[EMBEDDINGS] ${r.indexados} nodo(s) indexado(s) para búsqueda vectorial`);
    if (db.save) db.save();
    db.close();
  } catch {}
}

// ─── CLI ──────────────────────────────────────────────────────────────────────
// Guard (Task 5, fix de causa raíz): sin `require.main === module`, hacer
// require() de este archivo desde CUALQUIER script disparaba este dispatcher
// igual — process.argv[2] es el argv del script que hace el require, no de este
// archivo, así que caía casi siempre en el default 'sync' y corría sincronizar()
// de verdad contra la DB real, sin que nadie lo pidiera. Esto mordió a la Tarea 5
// (test que hacía require() insertó nodos de prueba en memoria.db real). Con este
// guard, el bloque solo corre cuando grafo.cjs se ejecuta directamente como CLI
// (`node grafo.cjs ...`), igual que antes; un require() normal ya no dispara nada.
if (require.main === module) {
  const cmd  = process.argv[2]||'sync';
  const arg1 = process.argv[3];
  const arg2 = process.argv[4];

  switch(cmd) {
    case 'sync':     sincronizar(); _autoIndexEmbeddings();
                     // sincronizar() es la referencia local sin envolver — los hooks de
                     // abajo ("Hook into existing exports") solo parchan
                     // module.exports.sincronizar, que este switch nunca llama. Sin esta
                     // llamada directa, Creative Engine nunca corre en un sync real
                     // (confirmado: la tabla creative_suggestions nunca se crea).
                     try { _autoRunCreativeEngine(`sync-${Date.now()}`); } catch {}
                     try { require('./install-hooks.cjs').installHooks({ quiet: true }); } catch {}
                     break;
    case 'sync-stats':
      sincronizar();
      stats();
      break;
    case 'query':
      const {resultados,trace} = consultar(arg1,arg2);
      console.log(JSON.stringify({resultados,trace},null,2)); break;
    case 'stats':    stats(); break;
    case 'metricas': console.log(JSON.stringify(metricas(),null,2)); break;
    case 'ciclo':
      try {
        const d = JSON.parse(arg1||'{}');
        const id = registrarCiclo(d);
        console.log(id?`Ciclo registrado: ${id}`:'Error al registrar');
      } catch(e) { console.log('JSON invalido'); } break;
    case 'semantico':
      if (!arg1) { console.log('Uso: node grafo.cjs semantico "query" [topK]'); break; }
      buscarSemantico(arg1,parseInt(arg2)||5).then(r=>console.log(JSON.stringify(r,null,2)));
      break;
    case 'snapshot':
      const db2=initDB(); console.log(JSON.stringify(snapshotMemoria(db2),null,2)); db2.close(); break;
    case 'analizar':
      analizarProyecto(); break;
    default:
      console.log('Uso: node grafo.cjs [sync|query|stats|metricas|ciclo|semantico|snapshot|analizar]');
  }
}


// ─── ANÁLISIS AUTOMÁTICO DEL PROYECTO ────────────────────────────────────────
// Recorre el código real y construye el grafo sin esperar ciclos aa:
// Similar al GRAPH_REPORT.md de Graphify

function analizarProyecto() {
  console.log('\n  Analizando proyecto...\n');

  const db = initDB();
  const ignorar = new Set(['node_modules','.git','.next','dist','build','vendor',
    'coverage','.cache','tmp','temp','.turbo','out','.output','public','static',
    '__pycache__','.pytest_cache','.mypy_cache']);
  const extsCodigo = new Set(['.ts','.tsx','.js','.jsx','.php','.py','.vue','.svelte','.rb','.go','.java']);
  const extsDocs   = new Set(['.md','.txt','.pdf']);

  let archivosAnalizados = 0, nodosPrevios = 0, nodosCreados = 0;

  // Contar nodos previos
  try { nodosPrevios = (db.get('SELECT COUNT(*) as n FROM nodos') || {}).n || 0; } catch(e) {}

  // ── 1. DETECTAR MÓDULOS desde estructura de carpetas ───────────────────────
  function detectarModulos(dir, nivel) {
    if (nivel > 4) return [];
    let items; try { items = fs.readdirSync(dir); } catch(e) { return []; }
    const modulos = [];

    for (const item of items) {
      if (ignorar.has(item) || item.startsWith('.') || item.startsWith('_')) continue;
      const full = path.join(dir, item);
      let stat; try { stat = fs.statSync(full); } catch(e) { continue; }

      if (stat.isDirectory()) {
        // Es módulo si tiene archivos de código dentro
        let tieneCode = false;
        try {
          const sub = fs.readdirSync(full);
          tieneCode = sub.some(f => extsCodigo.has(path.extname(f).toLowerCase()));
        } catch(e) {}

        if (tieneCode) {
          modulos.push({ nombre: item, ruta: full, nivel });
        }
        modulos.push(...detectarModulos(full, nivel + 1));
      }
    }
    return modulos;
  }

  // ── 2. ANALIZAR ARCHIVOS de código ─────────────────────────────────────────
  function analizarArchivo(filePath) {
    let content; try { content = fs.readFileSync(filePath, 'utf8'); } catch(e) { return null; }
    const ext  = path.extname(filePath).toLowerCase();
    const nombre = path.basename(filePath);
    const info = { imports: [], exports: [], patrones: [], decisiones: [] };

    // Detectar imports/dependencias
    const importRegexes = [
      /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g,  // ES6 import
      /require\(['"]([^'"]+)['"]\)/g,               // CommonJS require
      /use\s+([A-Z][a-zA-Z]+)/g,                    // PHP use
      /import\s+([a-zA-Z.]+)/g,                     // Python import
    ];
    importRegexes.forEach(rx => {
      let m; while ((m = rx.exec(content)) !== null) {
        if (!m[1].startsWith('.') && !m[1].startsWith('@')) info.imports.push(m[1]);
      }
    });

    // Detectar patrones de naming
    if (/export\s+default\s+function\s+([A-Z][a-zA-Z]+)/.test(content)) info.patrones.push('componente React');
    if (/\bconst\s+\w+\s*=\s*async\s*\(/.test(content)) info.patrones.push('funciones async/await');
    if (/\.env\b/.test(content) || /process\.env/.test(content)) info.patrones.push('variables de entorno');
    if (/createClient|supabase/.test(content)) info.patrones.push('Supabase client');
    if (/prisma\.|PrismaClient/.test(content)) info.patrones.push('Prisma ORM');
    if (/SELECT|INSERT|UPDATE|DELETE/i.test(content)) info.patrones.push('queries SQL directas');
    if (/middleware/.test(nombre.toLowerCase())) info.patrones.push('middleware pattern');
    if (/\.test\.|\.spec\./.test(nombre)) info.patrones.push('archivo de test');
    if (/interface\s+[A-Z]|type\s+[A-Z]/.test(content)) info.patrones.push('TypeScript types/interfaces');
    if (/zod\.|yup\.|joi\./.test(content)) info.patrones.push('validación de schemas');
    if (/useQuery|useMutation|useEffect/.test(content)) info.patrones.push('React hooks');
    if (/@Injectable|@Controller|@Module/.test(content)) info.patrones.push('NestJS decorators');
    if (/artisan|Eloquent|->where/.test(content)) info.patrones.push('Laravel Eloquent');

    // Detectar decisiones arquitectónicas implícitas
    if (/lib\/|utils\/|helpers\//.test(content)) info.decisiones.push('utilidades centralizadas');
    if (/only.*server|server.*only/i.test(content) || /use server/.test(content)) info.decisiones.push('Server Components (Next.js)');
    if (/use client/.test(content)) info.decisiones.push('Client Components (Next.js)');

    archivosAnalizados++;
    return info;
  }

  // ── 3. INFERIR ÁREA desde la ruta del archivo ──────────────────────────────
  function inferirArea(ruta) {
    const parts = ruta.toLowerCase().split(path.sep);
    const areaMap = {
      'auth': 'auth', 'authentication': 'auth', 'login': 'auth',
      'api': 'api', 'routes': 'api', 'endpoints': 'api', 'controllers': 'api',
      'components': 'frontend', 'ui': 'frontend', 'pages': 'frontend', 'views': 'frontend',
      'lib': 'core', 'utils': 'core', 'helpers': 'core', 'shared': 'core',
      'database': 'database', 'db': 'database', 'models': 'database', 'migrations': 'database',
      'middleware': 'middleware', 'hooks': 'frontend', 'services': 'services',
      'payment': 'payments', 'stripe': 'payments', 'billing': 'payments',
      'email': 'notifications', 'notifications': 'notifications', 'mailer': 'notifications',
      'tests': 'testing', 'test': 'testing', 'spec': 'testing',
    };
    for (const part of parts) {
      if (areaMap[part]) return areaMap[part];
    }
    return 'global';
  }

  // ── 4. RECORRER EL PROYECTO ────────────────────────────────────────────────
  const patronesEncontrados = {};  // patrón → { count, areas }
  const decisionesEncontradas = {};
  const areasConCodigo = new Set();

  function recorrer(dir, nivel) {
    if (nivel > 5) return;
    let items; try { items = fs.readdirSync(dir); } catch(e) { return; }

    for (const item of items) {
      if (ignorar.has(item) || item.startsWith('.')) continue;
      const full = path.join(dir, item);
      let stat; try { stat = fs.statSync(full); } catch(e) { continue; }

      if (stat.isDirectory()) {
        recorrer(full, nivel + 1);
      } else if (stat.isFile()) {
        const ext = path.extname(item).toLowerCase();
        if (!extsCodigo.has(ext)) continue;

        const info = analizarArchivo(full);
        if (!info) continue;

        const area = inferirArea(full);
        areasConCodigo.add(area);

        info.patrones.forEach(p => {
          if (!patronesEncontrados[p]) patronesEncontrados[p] = { count: 0, areas: new Set() };
          patronesEncontrados[p].count++;
          patronesEncontrados[p].areas.add(area);
        });

        info.decisiones.forEach(d => {
          if (!decisionesEncontradas[d]) decisionesEncontradas[d] = { count: 0, areas: new Set() };
          decisionesEncontradas[d].count++;
          decisionesEncontradas[d].areas.add(area);
        });
      }
    }
  }

  recorrer(ROOT, 0);

  // ── 5. DETECTAR STACK desde package.json / composer.json ──────────────────
  const stackInfo = {};
  const pkgPath = path.join(ROOT, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps['next'])           { stackInfo['Next.js'] = Object.keys(deps['next']||{}).length > 0; }
      if (deps['react'])          stackInfo['React'] = true;
      if (deps['@supabase/supabase-js']) stackInfo['Supabase'] = true;
      if (deps['prisma'] || deps['@prisma/client']) stackInfo['Prisma'] = true;
      if (deps['express'])        stackInfo['Express'] = true;
      if (deps['typescript'])     stackInfo['TypeScript'] = true;
      if (deps['tailwindcss'])    stackInfo['Tailwind CSS'] = true;
      if (deps['zustand'])        stackInfo['Zustand'] = true;
      if (deps['zod'])            stackInfo['Zod'] = true;
      if (deps['stripe'])         stackInfo['Stripe'] = true;
      if (deps['resend'] || deps['nodemailer']) stackInfo['Email service'] = true;
    } catch(e) {}
  }

  // ── 6. GUARDAR EN MEMORIA ──────────────────────────────────────────────────
  const fecha = new Date().toISOString().split('T')[0];

  // Guardar patrones detectados (solo los que aparecen 2+ veces)
  Object.entries(patronesEncontrados).forEach(([patron, data]) => {
    if (data.count < 1) return;
    const area = data.areas.size === 1 ? [...data.areas][0] : 'global';
    const confianza = data.count >= 5 ? 'MEDIA' : 'BAJA';
    const titulo = `[AUTO] ${patron}`;
    const contenido = `## ${fecha} [AUTO] ${patron}
Área: ${area}
Confianza: ${confianza}
Aplicado: ${data.count}
Útil: 0
Estado: ACTIVO
Última validación: ${fecha}
Creado: ${fecha}
Origen: akdd analyze — detectado en ${data.count} archivos
Regla: Patrón usado consistentemente en el proyecto
Áreas: ${[...data.areas].join(', ')}`;

    try {
      const ex = db.get('SELECT id FROM nodos WHERE tipo=? AND titulo=?', 'patron', titulo);
      if (!ex) {
        db.run("INSERT INTO nodos (tipo,titulo,contenido,area,confianza,aplicado,util,estado,ultima_validacion,fecha_update) VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))",
          'patron', titulo, contenido, area, confianza, data.count, 0, 'ACTIVO', fecha);
        nodosCreados++;
      }
    } catch(e) {}
  });

  // Guardar decisiones detectadas
  Object.entries(decisionesEncontradas).forEach(([decision, data]) => {
    if (data.count < 1) return;
    const area = data.areas.size === 1 ? [...data.areas][0] : 'global';
    const titulo = `[AUTO] ${decision}`;
    const contenido = `## ${fecha} [AUTO] ${decision}
Área: ${area}
Confianza: BAJA
Estado: ACTIVO
Última validación: ${fecha}
Creado: ${fecha}
Origen: akdd analyze — inferido del código (${data.count} referencias)
Decisión: ${decision}
Razón: Detectado automáticamente — verificar con el equipo
Áreas: ${[...data.areas].join(', ')}`;

    try {
      const ex = db.get('SELECT id FROM nodos WHERE tipo=? AND titulo=?', 'decision', titulo);
      if (!ex) {
        db.run("INSERT INTO nodos (tipo,titulo,contenido,area,confianza,aplicado,util,estado,ultima_validacion,fecha_update) VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))",
          'decision', titulo, contenido, area, 'BAJA', 0, 0, 'ACTIVO', fecha);
        nodosCreados++;
      }
    } catch(e) {}
  });

  // Guardar stack como decisiones
  Object.keys(stackInfo).forEach(tech => {
    const titulo = `[AUTO] Stack: ${tech}`;
    const contenido = `## ${fecha} [AUTO] Stack: ${tech}
Área: global
Confianza: MEDIA
Estado: ACTIVO
Última validación: ${fecha}
Creado: ${fecha}
Origen: akdd analyze — detectado en package.json
Decisión: El proyecto usa ${tech}
Razón: Dependencia confirmada en package.json`;

    try {
      const ex = db.get('SELECT id FROM nodos WHERE tipo=? AND titulo=?', 'decision', titulo);
      if (!ex) {
        db.run("INSERT INTO nodos (tipo,titulo,contenido,area,confianza,aplicado,util,estado,ultima_validacion,fecha_update) VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))",
          'decision', titulo, contenido, 'global', 'MEDIA', 0, 0, 'ACTIVO', fecha);
        nodosCreados++;
      }
    } catch(e) {}
  });

  // Detectar relaciones entre nodos nuevos
  detectarRelaciones(db);

  // ── 7. MEMORIA SEMÁNTICA — entidades y relaciones del proyecto ────────────
  // Gap CoALA: analizarProyecto ahora llena entidades y relaciones_semanticas
  const archivosConImports = {};
  function recorrerParaEntidades(dir, nivel) {
    if (nivel > 5) return;
    let items; try { items = fs.readdirSync(dir); } catch(e) { return; }
    for (const item of items) {
      if (ignorar.has(item) || item.startsWith('.')) continue;
      const full = path.join(dir, item);
      let stat; try { stat = fs.statSync(full); } catch(e) { continue; }
      if (stat.isDirectory()) {
        recorrerParaEntidades(full, nivel + 1);
      } else if (stat.isFile() && extsCodigo.has(path.extname(item).toLowerCase())) {
        let content; try { content = fs.readFileSync(full, 'utf8'); } catch(e) { continue; }
        const relPath = path.relative(ROOT, full).replace(/\\/g, '/');
        const nombre = path.basename(item, path.extname(item));
        const area = inferirArea(full);
        // Registrar entidad
        const esTest = /\.test\.|\.spec\./.test(item);
        const esCritico = ['middleware','auth','session','database','config','index','app','main','server'].some(k => nombre.toLowerCase().includes(k));
        try {
          const ex = db.get('SELECT id FROM entidades WHERE nombre=?', nombre);
          if (!ex) {
            db.run(`INSERT INTO entidades (nombre, tipo, descripcion, area, propiedades, critica, fecha_creacion, fecha_update) VALUES (?,?,?,?,?,?,datetime('now'),datetime('now'))`,
              nombre,
              esTest ? 'test' : 'archivo',
              `Archivo: ${relPath}`,
              area,
              JSON.stringify({ ruta: relPath, extension: path.extname(item) }),
              esCritico ? 1 : 0
            );
            nodosCreados++;
          }
        } catch(e) {}
        // Detectar imports locales para relaciones semánticas
        const importLocales = [];
        const rxLocal = /(?:import|require)\s*(?:.*?\s+from\s+)?['"](\.[^'"]+)['"]/g;
        let m; while ((m = rxLocal.exec(content)) !== null) {
          const importado = path.basename(m[1]).replace(/\.[^.]+$/, '') || path.basename(m[1]);
          if (importado && importado !== nombre) importLocales.push(importado);
        }
        archivosConImports[nombre] = importLocales;
      }
    }
  }
  recorrerParaEntidades(ROOT, 0);

  // Registrar relaciones semánticas basadas en imports
  Object.entries(archivosConImports).forEach(([desde, imports]) => {
    imports.forEach(hacia => {
      try {
        db.run(`INSERT OR IGNORE INTO relaciones_semanticas (desde_entidad, tipo, hacia_entidad, peso) VALUES (?,?,?,?)`,
          desde, 'importa', hacia, 1.0);
      } catch(e) {}
    });
  });

  if (db.type === 'sqljs' && db.save) db.save();

  // Actualizar archivos .md de memoria con lo detectado
  actualizarMemoriaMd(patronesEncontrados, decisionesEncontradas, stackInfo, fecha);

  const totalNodos = (db.get('SELECT COUNT(*) as n FROM nodos') || {}).n || 0;
  const totalEntidades = (() => { try { return (db.get('SELECT COUNT(*) as n FROM entidades') || {}).n || 0; } catch(e) { return 0; } })();
  const totalRelSem = (() => { try { return (db.get('SELECT COUNT(*) as n FROM relaciones_semanticas') || {}).n || 0; } catch(e) { return 0; } })();
  db.close();

  // ── OUTPUT ─────────────────────────────────────────────────────────────────
  console.log(`  Archivos analizados: ${archivosAnalizados}`);
  console.log(`  Areas detectadas:    ${[...areasConCodigo].join(', ') || 'ninguna'}`);
  console.log(`\n  Stack detectado:`);
  Object.keys(stackInfo).forEach(t => console.log(`    ✓ ${t}`));
  console.log(`\n  Patrones encontrados: ${Object.keys(patronesEncontrados).length}`);
  Object.entries(patronesEncontrados)
    .sort((a,b) => b[1].count - a[1].count)
    .slice(0,8)
    .forEach(([p,d]) => console.log(`    [${d.count}x] ${p}`));
  console.log(`\n  Decisiones inferidas: ${Object.keys(decisionesEncontradas).length}`);
  Object.keys(decisionesEncontradas).forEach(d => console.log(`    ~ ${d}`));
  console.log(`\n  Memoria semántica:`);
  console.log(`    Entidades: ${totalEntidades} archivos/módulos mapeados`);
  console.log(`    Relaciones: ${totalRelSem} dependencias entre archivos`);
  console.log(`\n  Nodos nuevos en grafo: ${nodosCreados} (total: ${totalNodos})`);
  console.log(`\n  Dashboard actualizado — corre: node dashboard.cjs\n`);
}

// ── Actualizar archivos .md de memoria con lo detectado ────────────────────
function actualizarMemoriaMd(patrones, decisiones, stack, fecha) {
  try {
    // Actualizar patrones.md
    const patronesPath = path.join(MEMORIA_PATH, 'patrones.md');
    let patronesContent = fs.existsSync(patronesPath) ? fs.readFileSync(patronesPath, 'utf8') : '# Patrones — Agentic KDD\n\n';

    Object.entries(patrones)
      .filter(([p]) => !patronesContent.includes(`[AUTO] ${p}`))
      .sort((a,b) => b[1].count - a[1].count)
      .slice(0, 10)
      .forEach(([patron, data]) => {
        const area = data.areas.size === 1 ? [...data.areas][0] : 'global';
        patronesContent += `\n## ${fecha} [AUTO] ${patron}
Área: ${area}
Confianza: ${data.count >= 5 ? 'MEDIA' : 'BAJA'}
Aplicado: ${data.count}
Útil: 0
Estado: ACTIVO
Última validación: ${fecha}
Creado: ${fecha}
Origen: akdd analyze
Regla: Patrón detectado automáticamente en ${data.count} archivos\n`;
      });
    fs.writeFileSync(patronesPath, patronesContent);

    // Actualizar decisiones.md
    const decisionesPath = path.join(MEMORIA_PATH, 'decisiones.md');
    let decisionesContent = fs.existsSync(decisionesPath) ? fs.readFileSync(decisionesPath, 'utf8') : '# Decisiones — Agentic KDD\n\n';

    // Stack como decisiones
    Object.keys(stack)
      .filter(t => !decisionesContent.includes(`Stack: ${t}`))
      .forEach(tech => {
        decisionesContent += `\n## ${fecha} [AUTO] Stack: ${tech}
Área: global
Confianza: MEDIA
Estado: ACTIVO
Última validación: ${fecha}
Creado: ${fecha}
Origen: akdd analyze
Decisión: El proyecto usa ${tech}
Razón: Dependencia confirmada en package.json\n`;
      });

    Object.entries(decisiones)
      .filter(([d]) => !decisionesContent.includes(`[AUTO] ${d}`))
      .forEach(([decision, data]) => {
        const area = data.areas.size === 1 ? [...data.areas][0] : 'global';
        decisionesContent += `\n## ${fecha} [AUTO] ${decision}
Área: ${area}
Confianza: BAJA
Estado: ACTIVO
Última validación: ${fecha}
Creado: ${fecha}
Origen: akdd analyze
Decisión: ${decision}
Razón: Inferido del código — verificar con el equipo\n`;
      });
    fs.writeFileSync(decisionesPath, decisionesContent);
  } catch(e) {}
}

module.exports = { sincronizar, consultar, stats, metricas, registrarCiclo, buscarSemantico, snapshotMemoria, analizarProyecto, promoverPatronesEstructurales };

// ─── CoALA v3: MEMORIA EPISÓDICA ──────────────────────────────────────────
function registrarEpisodio(datos) {
  try {
    const db = initDB();
    const episodio_id = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
    db.run(`INSERT INTO episodios 
      (episodio_id, ciclo_id, sesion_id, tipo, descripcion, intento_num, 
       contexto_antes, accion_tomada, resultado, razon_resultado, 
       archivos_tocados, area, modulo, relevancia)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      episodio_id,
      datos.ciclo_id || null,
      datos.sesion_id || null,
      datos.tipo || 'accion',
      datos.descripcion || '',
      datos.intento_num || 1,
      datos.contexto_antes || null,
      datos.accion_tomada || null,
      datos.resultado || null,
      datos.razon_resultado || null,
      JSON.stringify(datos.archivos_tocados || []),
      datos.area || 'global',
      datos.modulo || 'global',
      datos.relevancia || 1.0
    );
    if (db.type === 'sqljs' && db.save) db.save();
    db.close();
    return episodio_id;
  } catch(e) { console.error('Error registrarEpisodio:', e.message); return null; }
}

// Consolidar episodios → patrones/decisiones (episódica → procedural)
// Agentmemory lo hace con barridos horarios; aquí lo hacemos por demanda
function consolidarEpisodios(area) {
  try {
    const db = initDB();
    const filtro = area && area !== 'global' ? `AND area='${area}'` : '';
    const episodios = db.all(
      `SELECT * FROM episodios WHERE consolidado=0 ${filtro} ORDER BY fecha DESC LIMIT 50`
    );
    if (!episodios.length) { db.close(); return { consolidados: 0, episodios: [] }; }
    // Devolver los episodios sin consolidar para que el agente Memoria los procese
    // El agente decide cuáles merecen convertirse en patrones/decisiones
    db.close();
    return { consolidados: episodios.length, episodios };
  } catch(e) { return { consolidados: 0, episodios: [] }; }
}

// Marcar episodio como consolidado (después de que el agente lo procesó)
function marcarEpisodioConsolidado(episodio_id, nodo_id) {
  try {
    const db = initDB();
    db.run('UPDATE episodios SET consolidado=1, nodo_generado_id=? WHERE episodio_id=?', 
      nodo_id || null, episodio_id);
    if (db.type === 'sqljs' && db.save) db.save();
    db.close();
    return true;
  } catch(e) { return false; }
}

// ─── CoALA v3: MEMORIA SEMÁNTICA (grafo de entidades) ────────────────────
function registrarEntidad(datos) {
  try {
    const db = initDB();
    const ex = db.get('SELECT id FROM entidades WHERE nombre=?', datos.nombre);
    if (ex) {
      db.run(`UPDATE entidades SET tipo=?, descripcion=?, area=?, propiedades=?, 
              modificaciones=modificaciones+1, fecha_update=datetime('now') WHERE nombre=?`,
        datos.tipo || 'modulo',
        datos.descripcion || null,
        datos.area || 'global',
        JSON.stringify(datos.propiedades || {}),
        datos.nombre
      );
    } else {
      db.run(`INSERT INTO entidades (nombre, tipo, descripcion, area, propiedades, critica)
              VALUES (?,?,?,?,?,?)`,
        datos.nombre,
        datos.tipo || 'modulo',
        datos.descripcion || null,
        datos.area || 'global',
        JSON.stringify(datos.propiedades || {}),
        datos.critica ? 1 : 0
      );
    }
    if (db.type === 'sqljs' && db.save) db.save();
    db.close();
    return true;
  } catch(e) { return false; }
}

function registrarRelacionSemantica(desde, tipo, hacia, descripcion, peso) {
  try {
    const db = initDB();
    db.run(`INSERT OR REPLACE INTO relaciones_semanticas 
            (desde_entidad, tipo, hacia_entidad, peso, descripcion)
            VALUES (?,?,?,?,?)`,
      desde, tipo, hacia, peso || 1.0, descripcion || null
    );
    if (db.type === 'sqljs' && db.save) db.save();
    db.close();
    return true;
  } catch(e) { return false; }
}

// Consultar impacto de tocar una entidad (qué más puede romperse)
function impactoEntidad(nombre) {
  try {
    const db = initDB();
    const entidad = db.get('SELECT * FROM entidades WHERE nombre=?', nombre);
    if (!entidad) { db.close(); return null; }
    // Qué depende de esta entidad
    const dependientes = db.all(
      `SELECT desde_entidad, tipo, descripcion FROM relaciones_semanticas 
       WHERE hacia_entidad=? ORDER BY tipo`,
      nombre
    );
    // Qué depende esta entidad  
    const dependencias = db.all(
      `SELECT hacia_entidad, tipo, descripcion FROM relaciones_semanticas 
       WHERE desde_entidad=? ORDER BY tipo`,
      nombre
    );
    // Errores asociados a esta entidad
    const errores = db.all(
      `SELECT titulo, confianza FROM nodos 
       WHERE tipo='error' AND (area=? OR contenido LIKE ?) AND estado='ACTIVO' LIMIT 5`,
      entidad.area, `%${nombre}%`
    );
    db.close();
    return { entidad, dependientes, dependencias, errores };
  } catch(e) { return null; }
}

// ─── CoALA v3: DECAY TEMPORAL ─────────────────────────────────────────────
// Los patrones que no se usan pierden relevancia gradualmente
// Inspirado en ACT-R activation decay: A(t) = ln(Σ t_i^-d) 
function aplicarDecay() {
  try {
    const db = initDB();
    const ahora = Date.now();
    const nodos = db.all("SELECT id, ultimo_acceso, aplicado, confianza FROM nodos WHERE estado='ACTIVO'");
    
    nodos.forEach(n => {
      const diasSinUso = (ahora - new Date(n.ultimo_acceso || n.fecha_creacion || ahora).getTime()) / (1000 * 60 * 60 * 24);
      const baseDecay = { 'ALTA': 0.005, 'MEDIA': 0.01, 'BAJA': 0.02 }[n.confianza] || 0.01;
      const nuevoDecay = Math.max(0.1, 1.0 - (diasSinUso * baseDecay));
      
      // Si decay < 0.3 y confianza BAJA → marcar como OBSOLETO
      let nuevoEstado = 'ACTIVO';
      if (nuevoDecay < 0.3 && n.confianza === 'BAJA' && n.aplicado === 0) nuevoEstado = 'OBSOLETO';
      
      try {
        db.run('UPDATE nodos SET decay_score=?, estado=? WHERE id=?', nuevoDecay, nuevoEstado, n.id);
      } catch(e) {}
    });
    
    if (db.type === 'sqljs' && db.save) db.save();
    const obsoletos = nodos.filter(n => n.confianza === 'BAJA').length;
    db.close();
    return { procesados: nodos.length, obsoletos_potenciales: obsoletos };
  } catch(e) { return { procesados: 0, error: e.message }; }
}

// ─── CoALA v3: RECUPERACIÓN HÍBRIDA ──────────────────────────────────────
// Combina: búsqueda por keyword (BM25-like) + filtro por área + ranking por decay
// Para búsqueda vectorial real se necesitan embeddings (Voyage AI / local)
// Sin embeddings usa keyword scoring (ya mejor que solo SQL)
function buscarHibrido(query, area, topK) {
  topK = topK || 10;
  try {
    const db = initDB();
    const terms = (query || '').toLowerCase().split(/\s+/).filter(t => t.length > 2);
    
    // Búsqueda en nodos procedurales
    let sqlNodos = `SELECT *, 'procedural' as memoria_tipo FROM nodos WHERE estado='ACTIVO'`;
    if (area && area !== 'global') sqlNodos += ` AND (area=? OR area='global')`;
    const nodosAll = area && area !== 'global' 
      ? db.all(sqlNodos, area) 
      : db.all(sqlNodos);
    
    // Búsqueda en episodios
    let sqlEpisodios = `SELECT *, 'episodica' as memoria_tipo FROM episodios WHERE relevancia > 0.3`;
    if (area && area !== 'global') sqlEpisodios += ` AND (area=? OR area='global')`;
    sqlEpisodios += ' ORDER BY fecha DESC LIMIT 50';
    const episodiosAll = area && area !== 'global' 
      ? db.all(sqlEpisodios, area) 
      : db.all(sqlEpisodios);
    
    // Búsqueda en entidades semánticas
    const entidadesAll = db.all('SELECT *, \'semantica\' as memoria_tipo FROM entidades LIMIT 100');
    
    db.close();
    
    // Scoring BM25-like por keyword
    const scoreItem = (item) => {
      const text = ([item.titulo, item.descripcion, item.contenido, item.accion_tomada, item.razon_resultado, item.nombre]
        .filter(Boolean).join(' ')).toLowerCase();
      let score = 0;
      terms.forEach(term => {
        const count = (text.match(new RegExp(term, 'g')) || []).length;
        if (count > 0) score += 1 + Math.log(count); // TF component
      });
      // Boost por confianza/relevancia
      if (item.confianza === 'ALTA') score *= 2.0;
      else if (item.confianza === 'MEDIA') score *= 1.5;
      // Boost por decay
      score *= (item.decay_score || 1.0);
      // Boost por accesos recientes
      score += Math.log(1 + (item.accesos_total || item.aplicado || 0)) * 0.3;
      return score;
    };
    
    // Combinar todos los resultados y rankear
    const todos = [...nodosAll, ...episodiosAll, ...entidadesAll];
    const scored = todos
      .map(item => ({ ...item, _score: scoreItem(item) }))
      .filter(item => item._score > 0)
      .sort((a, b) => b._score - a._score)
      .slice(0, topK);
    
    return {
      resultados: scored,
      trace: {
        query, area, topK,
        nodos_candidatos: nodosAll.length,
        episodios_candidatos: episodiosAll.length,
        entidades_candidatas: entidadesAll.length,
        resultados_finales: scored.length,
        metodo: 'keyword_hybrid_rrf'
      }
    };
  } catch(e) { return { resultados: [], trace: { error: e.message } }; }
}

// ─── CoALA v3: STATS EXTENDIDO ────────────────────────────────────────────
function statsCoala() {
  const db = initDB();
  const proc = (db.get('SELECT COUNT(*) as n FROM nodos WHERE estado=\'ACTIVO\'') || {}).n || 0;
  const episod = (db.get('SELECT COUNT(*) as n FROM episodios') || {}).n || 0;
  const sinConsolidar = (db.get('SELECT COUNT(*) as n FROM episodios WHERE consolidado=0') || {}).n || 0;
  const entidades = (db.get('SELECT COUNT(*) as n FROM entidades') || {}).n || 0;
  const relSem = (db.get('SELECT COUNT(*) as n FROM relaciones_semanticas') || {}).n || 0;
  const obsoletos = (db.get('SELECT COUNT(*) as n FROM nodos WHERE estado=\'OBSOLETO\'') || {}).n || 0;
  db.close();
  
  console.log('\n  MEMORIA CoALA v3 — Agentic KDD\n');
  console.log(`  🔧 Procedural (patrones/errores/decisiones): ${proc} activos, ${obsoletos} obsoletos`);
  console.log(`  📖 Episódica (trayectorias):                 ${episod} total, ${sinConsolidar} sin consolidar`);
  console.log(`  🧠 Semántica (grafo de entidades):           ${entidades} entidades, ${relSem} relaciones`);
  console.log('');
}

// Exportar funciones CoALA nuevas
const _originalExports = module.exports || {};
module.exports = {
  ..._originalExports,
  registrarEpisodio,
  consolidarEpisodios,
  marcarEpisodioConsolidado,
  registrarEntidad,
  registrarRelacionSemantica,
  impactoEntidad,
  aplicarDecay,
  buscarHibrido,
  statsCoala
};

// Agregar casos al switch CLI
const _args = process.argv.slice(2);
if (_args[0] === 'episodio') {
  try { 
    const d = JSON.parse(_args[1] || '{}');
    const id = registrarEpisodio(d);
    console.log(id ? `Episodio registrado: ${id}` : 'Error');
  } catch(e) { console.log('JSON inválido'); }
}
if (_args[0] === 'consolidar') {
  const r = consolidarEpisodios(_args[1]);
  console.log(JSON.stringify(r, null, 2));
}
if (_args[0] === 'entidad') {
  try {
    const d = JSON.parse(_args[1] || '{}');
    registrarEntidad(d);
    console.log('Entidad registrada:', d.nombre);
  } catch(e) { console.log('JSON inválido'); }
}
if (_args[0] === 'impacto') {
  const r = impactoEntidad(_args[1]);
  console.log(JSON.stringify(r, null, 2));
}
if (_args[0] === 'decay') {
  const r = aplicarDecay();
  console.log(`Decay aplicado: ${r.procesados} nodos procesados`);
}
if (_args[0] === 'buscar') {
  // v2.2: búsqueda híbrida con embeddings si disponibles
  const embMod = getEmbeddingsModuleGrafo();
  if (embMod && embMod.isAvailable()) {
    buscarHibridoConEmbeddings(_args[1], _args[2], parseInt(_args[3]) || 10)
      .then(r => console.log(JSON.stringify({ resultados: r, trace: { metodo: 'vector_hybrid_rrf' } }, null, 2)));
  } else {
    const r = buscarHibrido(_args[1], _args[2], parseInt(_args[3]) || 10);
    console.log(JSON.stringify(r, null, 2));
  }
}
if (_args[0] === 'coala') {
  statsCoala();
}

// ─── v2.2: Nuevos comandos CLI ────────────────────────────────────────────────

if (_args[0] === 'git-context') {
  const gitMod = getGitContextModuleGrafo();
  if (!gitMod) { console.log('  git-context module not available (akdd update)'); process.exit(0); }
  const db = initDB();
  const resultado = gitMod.analizarGitContext(ROOT, db);
  if (resultado.disponible) {
    const { contexto } = resultado;
    // Guardar en working_memory
    const sesionId = `git-${Date.now()}`;
    try {
      db.run('UPDATE working_memory SET expirado=1 WHERE expirado=0');
      db.run(
        `INSERT INTO working_memory (sesion_id, tipo, contenido, relevancia) VALUES (?,?,?,?)`,
        sesionId, 'observacion', JSON.stringify(contexto), 1.0
      );
      // Log en git_context_log si la tabla existe
      try {
        db.run(
          `INSERT INTO git_context_log (sesion_id, rama, commit_hash, archivos_modificados, riesgos_detectados, predicciones, tiene_riesgos_altos)
           VALUES (?,?,?,?,?,?,?)`,
          sesionId,
          contexto.rama || '',
          (contexto.commits_recientes?.[0]?.hash || ''),
          JSON.stringify(contexto.archivos_modificados || []),
          JSON.stringify(contexto.riesgos || []),
          JSON.stringify(contexto.predicciones || []),
          contexto.tiene_riesgos_altos ? 1 : 0
        );
      } catch(e) {}
    } catch(e) {}
    if (db.type === 'sqljs' && db.save) db.save();
    db.close();
    console.log(gitMod.formatearReporte(resultado));
  } else {
    db.close();
    console.log(`  ${resultado.mensaje}`);
  }
}

if (_args[0] === 'predict') {
  const predMod = getPrediccionModuleGrafo();
  if (!predMod) { console.log('  prediccion module not available (akdd update)'); process.exit(0); }
  const db = initDB();
  predMod.mostrarEstadisticasPrediccion(db);
  db.close();
}

if (_args[0] === 'ci-install') {
  const ciMod = getCICDModuleGrafo();
  if (!ciMod) { console.log('  cicd module not available (akdd update)'); process.exit(0); }
  ciMod.instalarWorkflow(ROOT);
}

if (_args[0] === 'ci-status') {
  const ciMod = getCICDModuleGrafo();
  if (!ciMod) { console.log('  cicd module not available (akdd update)'); process.exit(0); }
  const db = initDB();
  ciMod.mostrarEstadoCI(db);
  db.close();
}

if (_args[0] === 'ci-report') {
  const ciMod = getCICDModuleGrafo();
  if (!ciMod) { process.exit(0); } // No fallar CI
  const db = initDB();
  const esExito = _args.includes('--success');
  const outputIdx = _args.indexOf('--output');
  const outputFile = outputIdx >= 0 ? _args[outputIdx + 1] : null;
  ciMod.reportarCI(ROOT, db, { esExito, outputFile });
  if (db.type === 'sqljs' && db.save) db.save();
  db.close();
}

if (_args[0] === 'embed-status') {
  const embMod = getEmbeddingsModuleGrafo();
  console.log('\n  Embeddings locales — Agentic KDD v2.2\n');
  if (!embMod) {
    console.log('  Estado: módulo embeddings.cjs no encontrado');
    console.log('  Solución: akdd update\n');
  } else {
    embMod.getStatus(ROOT).then((s) => {
      const ok = s.active_model && s.active_model !== 'none';
      console.log(`  Estado: ${ok ? '✓ disponible' : 'sin modelo'}`);
      console.log(`  Modelo: ${s.active_model}`);
      console.log(`  Tipo:   ${s.model_type}`);
      console.log(`  Dimensiones: ${s.dims}`);
      console.log(`  Instalar: ${s.install_command}\n`);
    }).catch((e) => console.error('  Error:', e.message));
  }
}

if (_args[0] === 'embed-install') {
  const embMod = getEmbeddingsModuleGrafo();
  if (!embMod) { console.log('\n  akdd update primero\n'); process.exit(1); }
  embMod.installMini(ROOT).catch((e) => { console.error(e.message); process.exitCode = 1; });
}

// ─── v2.2: Lazy loaders de módulos (sin romper arranque si no existen) ────────
function getEmbeddingsModuleGrafo() {
  try {
    const p = path.join(__dirname, 'embeddings.cjs');
    return fs.existsSync(p) ? require(p) : null;
  } catch(e) { return null; }
}
function getGitContextModuleGrafo() {
  try {
    const p = path.join(__dirname, 'git-context.cjs');
    return fs.existsSync(p) ? require(p) : null;
  } catch(e) { return null; }
}
function getPrediccionModuleGrafo() {
  try {
    const p = path.join(__dirname, 'prediccion.cjs');
    return fs.existsSync(p) ? require(p) : null;
  } catch(e) { return null; }
}
function getCICDModuleGrafo() {
  try {
    const p = path.join(__dirname, 'cicd.cjs');
    return fs.existsSync(p) ? require(p) : null;
  } catch(e) { return null; }
}

// ─── v2.2: buscar con embeddings (async) ────────────────────────────────────
async function buscarHibridoConEmbeddings(query, area, topK) {
  const embMod = getEmbeddingsModuleGrafo();
  const db = initDB();
  
  let sqlNodos = `SELECT *, 'procedural' as memoria_tipo FROM nodos WHERE estado='ACTIVO'`;
  if (area && area !== 'global') sqlNodos += ` AND (area=? OR area='global')`;
  const nodosAll = area ? db.all(sqlNodos, area) : db.all(sqlNodos);
  
  let sqlEp = `SELECT *, 'episodica' as memoria_tipo FROM episodios WHERE relevancia > 0.3`;
  if (area && area !== 'global') sqlEp += ` AND (area=? OR area='global')`;
  sqlEp += ' ORDER BY fecha DESC LIMIT 50';
  const episodiosAll = area ? db.all(sqlEp, area) : db.all(sqlEp);
  
  const entidadesAll = db.all("SELECT *, 'semantica' as memoria_tipo FROM entidades LIMIT 100");
  db.close();
  
  const todos = [...nodosAll, ...episodiosAll, ...entidadesAll];
  if (embMod && embMod.isAvailable()) {
    return await embMod.buscarHibridoVectorial(todos, query, topK || 10);
  }
  return buscarHibrido(query, area, topK).resultados;
}

// ─── v2.2: sync extendido (git-context + embeddings) ─────────────────────────
// Se activa con: node grafo.cjs sync-v2
if (_args[0] === 'sync-v2') {
  (async () => {
    // 1. Sync normal
    sincronizar();
    
    const db = initDB();
    
    // 2. Git context
    const gitMod = getGitContextModuleGrafo();
    if (gitMod && gitMod.gitDisponible(ROOT)) {
      const resultado = gitMod.analizarGitContext(ROOT, db);
      if (resultado.disponible && resultado.contexto) {
        const { riesgos, predicciones } = resultado.contexto;
        if (riesgos?.some(r => r.nivel === 'ALTO')) {
          console.log('\n  ⚠️  ALERTAS:');
          riesgos.filter(r => r.nivel === 'ALTO').slice(0, 3).forEach(r => 
            console.log(`  🔴 [ALTO] ${r.archivo}: ${r.advertencia || ''}`));
        }
        if (predicciones?.length > 0) {
          console.log('  ⚡ Predicciones:');
          predicciones.slice(0, 3).forEach(p => console.log(`  · ${p.mensaje}`));
        }
        // Guardar en working_memory
        const sesionId = `sync-v2-${Date.now()}`;
        try {
          db.run('UPDATE working_memory SET expirado=1 WHERE expirado=0');
          db.run(
            `INSERT INTO working_memory (sesion_id, tipo, contenido, relevancia) VALUES (?,?,?,?)`,
            sesionId, 'observacion', JSON.stringify(resultado.contexto), 1.0
          );
        } catch(e) {}
      }
    }
    
    // 3. Embeddings — indexar pendientes
    const embMod = getEmbeddingsModuleGrafo();
    if (embMod && embMod.isAvailable()) {
      process.stdout.write('  Embeddings: indexando... ');
      try {
        const r = await embMod.indexarPendientes(db, 30);
        console.log(r.indexados > 0 ? `✓ (${r.indexados} nuevos)` : '✓ (al día)');
      } catch(e) { console.log(''); }
    }
    
    if (db.type === 'sqljs' && db.save) db.save();
    db.close();
  })();
}

// ─── v2.2: predicción para Context Guard ─────────────────────────────────────
if (_args[0] === 'predecir') {
  const predMod = getPrediccionModuleGrafo();
  if (!predMod) { console.log(JSON.stringify({ nivel_riesgo: 'BAJO', alertas: [] })); process.exit(0); }
  try {
    const tarea   = _args[1] || '';
    const archivos = _args[2] ? JSON.parse(_args[2]) : [];
    const modulo  = _args[3] || 'global';
    const db = initDB();
    const resultado = predMod.evaluarRiesgoTarea(tarea, archivos, modulo, db);
    db.close();
    console.log(JSON.stringify(resultado, null, 2));
  } catch(e) { console.log(JSON.stringify({ nivel_riesgo: 'BAJO', alertas: [], error: e.message })); }
}

// ─── v2.2: schema migration ───────────────────────────────────────────────────
// Las nuevas tablas se crean automáticamente en el próximo initDB()
// grafo.cjs ya llama migrateDB() que tiene las ALTER TABLE
// Solo hay que asegurar que las nuevas tablas de git_context_log, etc. se crean

// ─── v3.1: Migración para AST, Knowledge Base y Bi-temporal ─────────────────
// Agentic KDD v3.1 — Nuevas tablas y columnas para Fases 1-3
// Esta función se llama automáticamente en la siguiente ejecución.

function migrateV3_1(db) {
  // Columnas bi-temporales en relaciones_semanticas
  const biTemporalMigrations = [
    "ALTER TABLE relaciones_semanticas ADD COLUMN valid_at TEXT DEFAULT (datetime('now'))",
    "ALTER TABLE relaciones_semanticas ADD COLUMN invalid_at TEXT",
    "ALTER TABLE relaciones_semanticas ADD COLUMN expired_at TEXT",
    "ALTER TABLE relaciones_semanticas ADD COLUMN episode_id TEXT",
    "ALTER TABLE relaciones_semanticas ADD COLUMN confidence TEXT DEFAULT 'MEDIA'",
    "ALTER TABLE relaciones_semanticas ADD COLUMN context TEXT",
    "ALTER TABLE relaciones_semanticas ADD COLUMN source TEXT DEFAULT 'agent'",
  ];
  biTemporalMigrations.forEach(sql => { try { db.exec(sql); } catch(e) {} });

  // Índices bi-temporales
  const biTemporalIndices = [
    "CREATE INDEX IF NOT EXISTS idx_rel_sem_valid ON relaciones_semanticas(valid_at)",
    "CREATE INDEX IF NOT EXISTS idx_rel_sem_invalid ON relaciones_semanticas(invalid_at)",
    "CREATE INDEX IF NOT EXISTS idx_rel_sem_type ON relaciones_semanticas(tipo)",
  ];
  biTemporalIndices.forEach(sql => { try { db.exec(sql); } catch(e) {} });

  // Tabla AST Symbols
  const astSymbolsSQL = `
    CREATE TABLE IF NOT EXISTS ast_symbols (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      file         TEXT NOT NULL,
      language     TEXT NOT NULL,
      symbol_name  TEXT NOT NULL,
      kind         TEXT NOT NULL,
      line_start   INTEGER DEFAULT 0,
      line_end     INTEGER DEFAULT 0,
      exported     INTEGER DEFAULT 0,
      signature    TEXT,
      pagerank     REAL DEFAULT 0.0,
      last_indexed TEXT DEFAULT (datetime('now')),
      content_hash TEXT
    )`;
  try { db.exec(astSymbolsSQL); } catch(e) {}
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_ast_sym_uniq ON ast_symbols(file, symbol_name, kind)"); } catch(e) {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_ast_sym_file ON ast_symbols(file)"); } catch(e) {}

  // Tabla AST Edges
  const astEdgesSQL = `
    CREATE TABLE IF NOT EXISTS ast_edges (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      from_file    TEXT NOT NULL,
      to_file      TEXT,
      from_symbol  TEXT,
      to_symbol    TEXT,
      kind         TEXT NOT NULL,
      weight       REAL DEFAULT 1.0,
      pagerank_src REAL DEFAULT 0.0,
      last_indexed TEXT DEFAULT (datetime('now'))
    )`;
  try { db.exec(astEdgesSQL); } catch(e) {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_ast_edge_from ON ast_edges(from_file)"); } catch(e) {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_ast_edge_to ON ast_edges(to_file)"); } catch(e) {}

  // Tabla Knowledge Docs (ADRs, gotchas, convenciones)
  const knowledgeDocsSQL = `
    CREATE TABLE IF NOT EXISTS knowledge_docs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id          TEXT NOT NULL UNIQUE,
      tipo            TEXT NOT NULL,
      titulo          TEXT NOT NULL,
      status          TEXT DEFAULT 'accepted',
      fecha           TEXT,
      decision_makers TEXT DEFAULT '[]',
      afecta          TEXT DEFAULT '[]',
      frontmatter     TEXT DEFAULT '{}',
      contenido       TEXT,
      context         TEXT,
      decision        TEXT,
      consequences    TEXT,
      options         TEXT DEFAULT '[]',
      file_path       TEXT,
      last_indexed    TEXT DEFAULT (datetime('now')),
      content_hash    TEXT
    )`;
  try { db.exec(knowledgeDocsSQL); } catch(e) {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_kdocs_tipo ON knowledge_docs(tipo)"); } catch(e) {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_kdocs_status ON knowledge_docs(status)"); } catch(e) {}

  // campo gate_result en fases (para harness tracking)
  try { db.exec("ALTER TABLE fases ADD COLUMN gate_result TEXT"); } catch(e) {}
  try { db.exec("ALTER TABLE fases ADD COLUMN harness_passed INTEGER DEFAULT 0"); } catch(e) {}

  // campo ast_indexed en ciclos
  try { db.exec("ALTER TABLE ciclos ADD COLUMN ast_indexed INTEGER DEFAULT 0"); } catch(e) {}
  try { db.exec("ALTER TABLE ciclos ADD COLUMN knowledge_loaded INTEGER DEFAULT 0"); } catch(e) {}
}

// Auto-run migrateV3_1 when grafo.cjs is first loaded
(function autoMigrateV3_1() {
  try {
    const _dbForMigration = initDB();
    migrateV3_1(_dbForMigration);
    if (_dbForMigration.save) _dbForMigration.save();
    _dbForMigration.close();
  } catch(e) {
    // Silent — migration runs opportunistically
  }
})();

// Export migrateV3_1
const _exportsV31 = module.exports || {};
module.exports = { ..._exportsV31, migrateV3_1 };


// ─── v3.2: Vigencia de Memoria + Verdad Vigente ────────────────────────────
// Cierra el Gap #1: límite claro entre memoria vigente, histórica y evidencia

function migrateV3_2(db) {
  // Columna vigencia_tipo en nodos
  try { db.exec("ALTER TABLE nodos ADD COLUMN vigencia_tipo TEXT DEFAULT 'VIGENTE'"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_nodos_vigencia ON nodos(vigencia_tipo)"); } catch {}
  // Inferir vigencia_tipo para registros existentes
  try {
    db.exec("UPDATE nodos SET vigencia_tipo='OBSOLETO' WHERE estado='OBSOLETO' AND vigencia_tipo='VIGENTE'");
    db.exec("UPDATE nodos SET vigencia_tipo='HISTORICO' WHERE estado='CONSOLIDADO' AND vigencia_tipo='VIGENTE'");
  } catch {}
}

// Auto-run
(function autoMigrateV3_2() {
  try {
    const _db = initDB();
    migrateV3_2(_db);
    if (_db.save) _db.save();
    _db.close();
  } catch {}
})();

const _exportsV32 = module.exports || {};
module.exports = { ..._exportsV32, migrateV3_2 };


// ─── v3.2: AUTO-INTEGRATION — MemCurator + llms-generator ─────────────────────
// Se hookan automáticamente en el flujo de sync existente.

const _grafoPath = __dirname;

function _autoRunCurator() {
  try {
    const db = initDB();
    // Contar ciclos desde última curation
    let lastCuration = 0;
    try {
      const meta = db.get("SELECT valor FROM metadata WHERE clave='last_curator_cycle'");
      lastCuration = parseInt(meta?.valor || '0');
    } catch {}
    const totalCycles = db.get("SELECT COUNT(*) as n FROM ciclos")?.n || 0;
    if (totalCycles - lastCuration >= 10) {
      const { runCuration } = require(require('path').join(_grafoPath, 'mem-curator.cjs'));
      runCuration(process.cwd());
      try {
        db.run("INSERT OR REPLACE INTO metadata (clave, valor) VALUES ('last_curator_cycle', ?)", String(totalCycles));
      } catch {
        try { db.run("CREATE TABLE IF NOT EXISTS metadata (clave TEXT PRIMARY KEY, valor TEXT)"); } catch {}
        try { db.run("INSERT OR REPLACE INTO metadata (clave, valor) VALUES ('last_curator_cycle', ?)", String(totalCycles)); } catch {}
      }
    }
    if (db.save) db.save(); db.close();
  } catch {}
}

function _autoGenerateLlms() {
  try {
    const { generateAll } = require(require('path').join(_grafoPath, 'llms-generator.cjs'));
    generateAll(process.cwd());
  } catch {}
}

// Hookar en la función sincronizar existente
const _origExports = module.exports || {};
const _origSync = _origExports.sincronizar;
if (_origSync && typeof _origSync === 'function') {
  _origExports.sincronizar = function(...args) {
    const result = _origSync.apply(this, args);
    try { _autoRunCurator(); } catch {}
    try { _autoGenerateLlms(); } catch {}
    return result;
  };
}

module.exports = { ..._origExports };

// ─── v3.3: CONTRACT GUARD + CREATIVE ENGINE AUTO-INTEGRATION ─────────────────

function _autoRunContractGuard(cicloId, testOutput) {
  try {
    const db = initDB();
    const cg = require(require('path').join(__dirname, 'contract-guard.cjs'));
    cg.migrateSchema(db);
    if (testOutput) {
      cg.ingestFromCycle(db, process.cwd(), cicloId, testOutput);
    }
    if (db.save) db.save(); db.close();
  } catch {}
}

function _autoRunCreativeEngine(cicloId) {
  try {
    const db = initDB();
    const ce = require(require('path').join(__dirname, 'creative-engine.cjs'));
    ce.migrateSchema(db);
    const result = ce.runCreativePass(db, process.cwd(), cicloId);
    if (result.new_suggestions > 0 || result.auto_applied > 0) {
      console.error(`[CREATIVE] Level ${result.level}: ${result.new_suggestions} suggestions, ${result.auto_applied} auto-applied`);
    }
    if (db.save) db.save(); db.close();
  } catch {}
}

// Hook into existing exports
const _contractCreativeExports = module.exports || {};
const _origSyncCC = _contractCreativeExports.sincronizar;
if (_origSyncCC && typeof _origSyncCC === 'function') {
  _contractCreativeExports.sincronizar = function(...args) {
    const result = _origSyncCC.apply(this, args);
    const cicloId = `sync-${Date.now()}`;
    try { _autoRunContractGuard(cicloId, null); } catch {}
    try { _autoRunCreativeEngine(cicloId); } catch {}
    return result;
  };
}

module.exports = { ..._contractCreativeExports };

// ─── v3.3: SESSION GUARD AUTO-CHECKPOINT ──────────────────────────────────────
function _autoSessionGuard() {
  try {
    const db = initDB();
    const cycles = db.get("SELECT COUNT(*) as n FROM ciclos")?.n || 0;
    if (cycles > 0 && cycles % 5 === 0) {
      const { generateCheckpoint } = require(require('path').join(__dirname, 'session-guard.cjs'));
      generateCheckpoint(process.cwd());
      console.error('[SESSION] Checkpoint guardado (.agentic/checkpoint.md)');
    }
    if (db.save) db.save(); db.close();
  } catch {}
}

const _sgExports = module.exports || {};
const _origSyncSG = _sgExports.sincronizar;
if (_origSyncSG && typeof _origSyncSG === 'function') {
  _sgExports.sincronizar = function(...args) {
    const result = _origSyncSG.apply(this, args);
    try { _autoSessionGuard(); } catch {}
    return result;
  };
}
module.exports = { ..._sgExports };

// ─── v3.3: AUTONOMOUS DECISION ENGINE AUTO-INTEGRATION ────────────────────────
// Se hookea en el sync para correr la cola diferida al final de cada ciclo

function _autoFlushDeferred() {
  try {
    const { flushDeferredQueue } = require(require('path').join(__dirname, 'autonomous-decision.cjs'));
    const flushed = flushDeferredQueue(process.cwd());
    if (flushed.length > 0) {
      console.error(`[AUTONOMOUS] ${flushed.length} deferred item(s) from queue — review as suggestions`);
      // Add to creative engine suggestions
      try {
        const { addSuggestion } = require(require('path').join(__dirname, 'creative-engine.cjs'));
        const db = initDB();
        flushed.forEach(item => {
          addSuggestion(db, {
            type: 'OPPORTUNITY',
            title: item.task || 'Deferred task',
            description: item.reason || 'Deferred by Autonomous Decision Engine',
            module: (item.files || [])[0] || 'global',
          }, `deferred-${Date.now()}`);
        });
        if (db.save) db.save(); db.close();
      } catch {}
    }
  } catch {}
}

const _adExports = module.exports || {};
const _origSyncAD = _adExports.sincronizar;
if (_origSyncAD && typeof _origSyncAD === 'function') {
  _adExports.sincronizar = function(...args) {
    const result = _origSyncAD.apply(this, args);
    try { _autoFlushDeferred(); } catch {}
    return result;
  };
}
module.exports = { ..._adExports };

// ─── v3.4: kdd-memory + knowledge-validator + telemetry INTEGRATION ─────────

function _autoKDDMemorySync() {
  try {
    const { syncFTS } = require(require('path').join(__dirname, 'kdd-memory.cjs'));
    const db = initDB();
    const nodeCount = db.get("SELECT COUNT(*) as n FROM nodos WHERE estado='ACTIVO'")?.n || 0;
    let ftsCount = 0;
    try { ftsCount = db.get("SELECT COUNT(*) as n FROM nodos_fts")?.n || 0; } catch {}
    if (ftsCount < nodeCount * 0.9) {
      syncFTS(db);
      console.error('[KDD-MEMORY] FTS index synced');
    }
    if (db.save) db.save(); db.close();
  } catch {}
}

function _autoKnowledgeValidation() {
  try {
    const { scanAll } = require(require('path').join(__dirname, 'knowledge-validator.cjs'));
    const result = scanAll(process.cwd());
    if (result.sospechoso > 0 || result.poison_candidates > 0) {
      console.error(`[VALIDATOR] ${result.sospechoso} suspicious + ${result.poison_candidates} poison candidates`);
    }
  } catch {}
}

const _kdmExports = module.exports || {};
const _origSyncKDM = _kdmExports.sincronizar;
if (_origSyncKDM && typeof _origSyncKDM === 'function') {
  _kdmExports.sincronizar = function(...args) {
    const result = _origSyncKDM.apply(this, args);
    try { _autoKDDMemorySync(); } catch {}
    return result;
  };
}
module.exports = { ..._kdmExports };

// ─── v3.6: project_settings — config persistente en BD ──────────────────────
// Guarda CONFIGURADO, nombre, stack y test command en memoria.db
// Fuente de verdad secundaria cuando config.md falla o se pisa durante update

(function migrateProjectSettings() {
  try {
    const _db = initDB();

    // Crear tabla project_settings si no existe
    _db.exec(`
      CREATE TABLE IF NOT EXISTS project_settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    // Leer config.md y sincronizar a BD si CONFIGURADO: SI
    const fs   = require('fs');
    const path = require('path');
    const configPath = path.join(process.cwd(), '.agentic', 'config.md');

    if (fs.existsSync(configPath)) {
      const config = fs.readFileSync(configPath, 'utf8');
      const configured = /^CONFIGURADO:\s*SI/m.test(config);

      if (configured) {
        // Guardar estado en BD
        const _UPSERT_PS = `
          INSERT INTO project_settings (key, value, updated_at)
          VALUES (?, ?, datetime('now'))
          ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
        `;

        _db.run(_UPSERT_PS, 'configured', 'true');

        const nameMatch = config.match(/^Nombre:\s*(.+)$/m);
        if (nameMatch) _db.run(_UPSERT_PS, 'project_name', nameMatch[1].trim());

        // [^\S\n]* y no \s*: \s* cruzaba el salto de línea y con config.md en
        // formato YAML de bloque capturaba la línea siguiente (bug 2026-07-19).
        const testMatch = config.match(/^[^\S\n]*test:[^\S\n]*(\S.*)$/m) || config.match(/^[^\S\n]*comando:[^\S\n]*(\S.*)$/m);
        if (testMatch && testMatch[1].trim() !== '—') {
          _db.run(_UPSERT_PS, 'test_command', testMatch[1].trim());
        }

        const stackBlock = config.match(/^## Stack\n([\s\S]+?)(?=\n##|$)/m);
        if (stackBlock) _db.run(_UPSERT_PS, 'stack', stackBlock[1].trim());
      }
    } else {
      // config.md no existe — intentar restaurar desde BD
      const settings = {};
      try {
        const rows = _db.all('SELECT key, value FROM project_settings');
        for (const row of rows) settings[row.key] = row.value;
      } catch {}

      if (settings.configured === 'true' && fs.existsSync(path.join(process.cwd(), '.agentic'))) {
        // Reconstruir config.md mínimo desde BD
        const lines = [
          '# Agentic KDD — Configuración del proyecto',
          'CONFIGURADO: SI',
          'VERSION: 2.0',
          '',
          '## Proyecto',
          `Nombre: ${settings.project_name || '(restaurado desde BD)'}`,
          'Descripción: —',
          'Tipo: EXISTENTE',
          '',
          settings.stack ? `## Stack\n${settings.stack}` : '## Stack\n—',
          '',
          '## Comando de tests',
          settings.test_command ? `test: ${settings.test_command}` : 'test: —',
        ];
        fs.writeFileSync(configPath, lines.join('\n'), 'utf8');
        console.error('[AGENTIC] config.md restaurado desde memoria.db');
      }
    }

    if (_db.save) _db.save();
    _db.close();
  } catch(e) {
    // Silent — best effort
  }
})();

const _ps36Exports = module.exports || {};
module.exports = { ..._ps36Exports };
