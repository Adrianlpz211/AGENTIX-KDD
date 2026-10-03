'use strict';
/* Catálogo de esquema (3.20.1): inspección, migración estricta, registro. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const real = require('./helpers/db-real.cjs');
const legacy = require('./helpers/legacy-real.cjs');
const { dba, inv } = real;
const sc = require(path.join(real.REPO, '.agentic', 'grafo', 'schema-catalog.cjs'));

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const abrir = (f) => dba.openWrite(f, { updateOwner: true });

test('catálogo: una base REAL 3.19.0 muestra exactamente lo que añadió la 3.20 y las funciones perezosas', () => {
  const { dbPath } = legacy.proyectoReal('3.19.0', 'cat');
  const db = dba.openReadOnly(dbPath);
  try {
    const r = sc.inspect(db);
    assert.equal(r.status, 'PENDING');
    assert.equal(r.registry_present, false, 'una instalación antigua no tiene registro: se inspecciona la estructura');
    assert.equal(r.user_version, 0, 'user_version=0 no significa base vacía');
    assert.ok(r.satisfied > 25, 'las tablas de la línea base ya cumplen');
    const ids = r.pending.map((p) => p.id);
    for (const esperado of ['create-table:lock_fencing', 'add-column:gate_events.cycle_id', 'add-column:module_locks.fencing', 'create-index:idx_ge_event', 'add-column:ui_layout_decisions.project_id']) {
      assert.ok(ids.includes(esperado), 'falta detectar ' + esperado);
    }
    assert.deepEqual(r.foreign_tables, [], 'el motor 3.19 no deja tablas que el catálogo desconozca');
  } finally { db.close(); }
});

test('catálogo: una base REAL 3.20.0 solo tiene pendientes las funciones que el motor crea al usarlas', () => {
  const { dbPath } = legacy.proyectoReal('3.20.0', 'cat');
  const db = dba.openReadOnly(dbPath);
  try {
    const r = sc.inspect(db);
    assert.ok(!r.pending.some((p) => p.id === 'create-table:lock_fencing'), 'lo de 3.20 ya está');
    assert.ok(r.pending.every((p) => /contract|file_fingerprints|code_summaries|metadata|verified_contracts/.test(p.id)), 'solo funciones perezosas: ' + r.pending.map((p) => p.id));
  } finally { db.close(); }
});

test('catálogo: aplicar es una transacción, deja el registro y es idempotente', () => {
  const { dbPath } = legacy.proyectoReal('3.19.0', 'apply');
  const antes = real.inventario(dbPath);
  const db = abrir(dbPath);
  try {
    const a = sc.apply(db, { version: '3.20.1', actor: 'prueba' });
    assert.equal(a.status, 'APPLIED');
    assert.ok(a.applied.length >= 20);
    assert.ok(a.adopted.length >= 30, 'lo que ya existía se adopta (se inspecciona, no se modifica)');
    const r = sc.inspect(db);
    assert.equal(r.status, 'COMPLETE');
    assert.equal(r.detected_level, sc.SUPPORTED_LEVEL);
    const fila = db.get("SELECT * FROM agentix_schema_migrations WHERE id = 'create-table:lock_fencing'");
    assert.equal(fila.result, 'APPLIED');
    assert.equal(fila.introduced_in, '3.20.0');
    assert.match(fila.checksum, /^[0-9a-f]{64}$/);
    assert.ok(fila.applied_at && fila.applied_by === 'prueba');
    const b = sc.apply(db, { version: '3.20.1' });
    assert.equal(b.status, 'NO_CHANGES', 'esquema completo: ninguna migración innecesaria');
    assert.deepEqual(b.applied, []);
  } finally { db.close(); }
  assert.equal(real.conservada(antes, dbPath).status, 'PASS', 'la memoria original se conserva por contenido');
});

test('catálogo: esquema PARCIAL (faltan tablas y columnas) se completa sin tocar lo que hay', () => {
  const dbPath = path.join(tmp('akdd-parcial-'), 'memoria.db');
  real.crearBase(dbPath, { nodos: 7 });
  const db = abrir(dbPath);
  try {
    db.exec('DROP TABLE IF EXISTS working_memory; DROP TABLE IF EXISTS prediction_log; DROP INDEX IF EXISTS idx_nodos_area_tipo;');
  } finally { db.close(); }
  const antes = real.inventario(dbPath);
  const w = abrir(dbPath);
  try {
    assert.equal(sc.inspect(w).status, 'PENDING');
    sc.apply(w, { version: '3.20.1' });
    assert.equal(sc.inspect(w).status, 'COMPLETE');
    assert.ok(w.get("SELECT 1 AS x FROM sqlite_master WHERE name = 'working_memory'"), 'la tabla perdida se recreó');
    assert.equal(w.get('SELECT count(*) AS n FROM nodos').n, 7);
  } finally { w.close(); }
  assert.equal(real.conservada(antes, dbPath).status, 'PASS');
});

test('catálogo: un esquema MÁS NUEVO se rechaza sin modificar nada', () => {
  const dbPath = path.join(tmp('akdd-nuevo-'), 'memoria.db');
  real.crearBase(dbPath);
  let w = abrir(dbPath);
  try {
    sc.apply(w, { version: '3.20.1' });
    w.run("INSERT INTO agentix_schema_migrations (id, checksum, introduced_in, level, applied_at, result) VALUES ('create-table:futuro', 'x', '9.9.9', 99, 'ahora', 'APPLIED')");
    w.run("INSERT OR REPLACE INTO agentix_schema_meta (key, value) VALUES ('level', '99')");
  } finally { w.close(); }
  const antes = real.inventario(dbPath);
  w = abrir(dbPath);
  try {
    assert.equal(sc.inspect(w).status, 'NEWER_SCHEMA');
    assert.throws(() => sc.apply(w, { version: '3.20.1' }), (e) => e.code === 'NEWER_SCHEMA');
  } finally { w.close(); }
  assert.equal(real.conservada(antes, dbPath).status, 'PASS', 'rechazar no cambia ni una fila');
});

test('catálogo: un fallo A MITAD revierte TODO (UNA transacción) y no deja registro', () => {
  const dbPath = path.join(tmp('akdd-fallo-'), 'memoria.db');
  real.crearBase(dbPath);
  let w = abrir(dbPath);
  try {
    // Base "de 3.19" con una columna event_id ya usada y DUPLICADA: el índice único de 3.20 no puede crearse.
    w.exec('DROP TABLE IF EXISTS gate_events');
    w.exec('CREATE TABLE gate_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, gate TEXT NOT NULL, verdict TEXT NOT NULL, behavior_id TEXT, file TEXT, detalle TEXT, cycle_hint TEXT, source TEXT, event_id TEXT)');
    w.run("INSERT INTO gate_events (gate, verdict, event_id) VALUES ('g', 'PASS', 'dup')");
    w.run("INSERT INTO gate_events (gate, verdict, event_id) VALUES ('g', 'PASS', 'dup')");
  } finally { w.close(); }
  const antes = real.inventario(dbPath);
  w = abrir(dbPath);
  let error = null;
  try { sc.apply(w, { version: '3.20.1' }); } catch (e) { error = e; }
  try {
    assert.ok(error, 'la migración debía abortar');
    assert.equal(error.code, 'DATOS_DUPLICADOS', 'deduplicar es una decisión humana: el update no borra registros');
    assert.ok(!w.get("SELECT 1 AS x FROM sqlite_master WHERE name = 'lock_fencing'"), 'lo demás se revirtió: ninguna tabla nueva quedó a medias');
    assert.ok(!w.get("SELECT 1 AS x FROM sqlite_master WHERE name = 'agentix_schema_migrations'"), 'ni el registro');
  } finally { w.close(); }
  assert.equal(real.conservada(antes, dbPath).status, 'PASS');
});

test('catálogo: una columna con DEFAULT dinámico se migra explícitamente (relleno declarado + trigger)', () => {
  const dbPath = path.join(tmp('akdd-dd-'), 'memoria.db');
  real.crearBase(dbPath, { nodos: 3 });
  let w = abrir(dbPath);
  try {
    // Una base antigua sin ultima_validacion: SQLite NO permite ALTER ... ADD COLUMN con DEFAULT (datetime('now')).
    w.exec('ALTER TABLE nodos RENAME TO nodos_old');
    w.exec(`CREATE TABLE nodos (id INTEGER PRIMARY KEY AUTOINCREMENT, tipo TEXT NOT NULL, titulo TEXT NOT NULL, contenido TEXT, area TEXT DEFAULT 'global', confianza TEXT DEFAULT 'BAJA',
      aplicado INTEGER DEFAULT 0, util INTEGER DEFAULT 0, estado TEXT DEFAULT 'ACTIVO', ultimo_acceso TEXT DEFAULT (datetime('now')), accesos_total INTEGER DEFAULT 0, decay_score REAL DEFAULT 1.0,
      embedding TEXT, embedding_modelo TEXT, fecha_creacion TEXT DEFAULT (datetime('now')), fecha_update TEXT DEFAULT (datetime('now')),
      archivos_aplica TEXT DEFAULT '[]', hash_contexto TEXT, validation_score REAL DEFAULT 1.0, vigencia_tipo TEXT DEFAULT 'VIGENTE', anclas TEXT DEFAULT '[]')`);
    w.exec('INSERT INTO nodos (id, tipo, titulo, contenido, area, confianza, fecha_creacion) SELECT id, tipo, titulo, contenido, area, confianza, \'2020-01-02 03:04:05\' FROM nodos_old');
    w.exec('DROP TABLE nodos_old');
  } finally { w.close(); }
  w = abrir(dbPath);
  try {
    assert.throws(() => w.exec("ALTER TABLE nodos ADD COLUMN ultima_validacion TEXT DEFAULT (datetime('now'))"), /non-constant|constant/i, 'es la limitación real de SQLite que antes se silenciaba');
    const a = sc.apply(w, { version: '3.20.1' });
    assert.ok(a.dynamic_defaults.some((d) => d.table === 'nodos' && d.column === 'ultima_validacion'));
    const filas = w.all('SELECT ultima_validacion, fecha_update FROM nodos');
    assert.ok(filas.length === 3 && filas.every((f) => f.ultima_validacion === f.fecha_update), 'relleno declarado: toma fecha_update (la primera fecha propia de la fila) en vez de inventar otra');
    w.run("INSERT INTO nodos (tipo, titulo) VALUES ('patron', 'nuevo')");
    assert.match(w.get("SELECT ultima_validacion AS v FROM nodos WHERE titulo = 'nuevo'").v, /^\d{4}-\d\d-\d\d /, 'el trigger reproduce el default en las inserciones nuevas');
    assert.equal(sc.verify(w).ok, true);
  } finally { w.close(); }
});

test('catálogo: un checksum distinto en el registro se avisa; una migración desconocida no bloquea', () => {
  const dbPath = path.join(tmp('akdd-chk-'), 'memoria.db');
  real.crearBase(dbPath);
  const w = abrir(dbPath);
  try {
    sc.apply(w, { version: '3.20.1' });
    w.run("UPDATE agentix_schema_migrations SET checksum = 'otro' WHERE id = 'baseline:nodos'");
    w.run("INSERT INTO agentix_schema_migrations (id, checksum, introduced_in, level, applied_at, result) VALUES ('rama-ajena', 'x', '3.20.9', 2, 'ahora', 'APPLIED')");
    const r = sc.inspect(w);
    assert.equal(r.status, 'COMPLETE');
    assert.ok(r.warnings.some((x) => x.code === 'CHECKSUM_DISTINTO'));
    assert.ok(r.warnings.some((x) => x.code === 'MIGRACION_DESCONOCIDA'));
  } finally { w.close(); }
});

test('catálogo: la regla declarada sobre contratos antiguos deja nivel e historial y es verificable', () => {
  const { dbPath } = legacy.proyectoReal('3.20.0', 'reg');
  const w = abrir(dbPath);
  let declarado;
  try {
    // Un contrato "viejo" atado a un comando genérico (como los que dejó la 3.19).
    w.run("INSERT INTO verified_contracts (module, name, test_file, status, verification_count, consecutive_passes) VALUES ('auth', 'suite completa', 'npm test', 'VERIFIED', 7, 7)");
    w.run("INSERT INTO verified_contracts (module, name, test_file, status, verification_count, consecutive_passes) VALUES ('auth', 'login', 'src/auth.test.js', 'VERIFIED', 5, 5)");
    declarado = inv.snapshotDeclarado(w);
    assert.equal(declarado[sc.DATA_V2.id], undefined, 'sin las columnas v2 todavía no hay regla que verificar');
  } finally { w.close(); }
  const w2 = abrir(dbPath);
  try {
    const antes = inv.takeInventory(w2);
    const snap = inv.snapshotDeclarado(w2);
    sc.apply(w2, { version: '3.20.1' });
    const filas = w2.all('SELECT name, test_file, runner_command, mapping_status, verification_count FROM verified_contracts ORDER BY id');
    const generico = filas.find((f) => f.name === 'suite completa');
    assert.equal(generico.mapping_status, 'UNRESOLVED');
    assert.equal(generico.runner_command, 'npm test', 'el comando original se conserva en runner_command');
    assert.equal(generico.verification_count, 7, 'nivel e historial no cambian');
    assert.equal(filas.find((f) => f.name === 'login').mapping_status, 'RESOLVED', 'un test real no se toca');
    assert.deepEqual(inv.verificarDeclarado(w2, snap), []);
    const despues = inv.takeInventory(w2, { columnsFrom: antes });
    assert.equal(inv.compare(antes, despues).status, 'PASS');
  } finally { w2.close(); }
});

test('catálogo: un motor recién arrancado en un proyecto NUEVO no crea nada que el catálogo desconozca', () => {
  const root = tmp('akdd-nuevo-motor-');
  fs.mkdirSync(path.join(root, '.agentic', 'memoria'), { recursive: true });
  fs.cpSync(path.join(real.REPO, '.agentic', 'grafo'), path.join(root, '.agentic', 'grafo'), { recursive: true, filter: (s) => !/[\\/](vendor|graph-ui)([\\/]|$)/.test(s) });
  fs.writeFileSync(path.join(root, '.agentic', 'memoria', 'patrones.md'), '# Patrones\n');
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env, PROJECT_ROOT: root, NODE_NO_WARNINGS: '1' };
  for (const [s, a] of [['grafo.cjs', ['sync']], ['gate-telemetry.cjs', ['stats']], ['regression-guard.cjs', ['status']], ['contract-guard.cjs', ['status']], ['lock-manager.cjs', ['status']], ['ui-layout-memory.cjs', ['list']], ['prediccion-registro.cjs', ['precision']]]) {
    spawnSync(process.execPath, [path.join(root, '.agentic', 'grafo', s), ...a], { cwd: root, env, encoding: 'utf8', timeout: 60000 });
  }
  const db = dba.openReadOnly(path.join(root, '.agentic', 'memoria.db'));
  try {
    const r = sc.inspect(db);
    assert.equal(r.status, 'COMPLETE', 'una base creada por el motor actual está completa: ' + JSON.stringify(r.pending.map((p) => p.id)));
    assert.deepEqual(r.foreign_tables, [], 'ninguna tabla fuera del catálogo');
    assert.ok(r.registry_present && r.registry_entries >= 50, 'la base nueva ya lleva su registro de migraciones');
  } finally { db.close(); }
});

test('catálogo: abrir o importar para LEER no crea ni migra la base', () => {
  const dbPath = path.join(tmp('akdd-leer-'), 'memoria.db');
  real.crearBase(dbPath);
  const antesBytes = fs.readFileSync(dbPath);
  const db = dba.openReadOnly(dbPath);
  try { sc.inspect(db); sc.verify(db); sc.status(db); } finally { db.close(); }
  assert.ok(antesBytes.equals(fs.readFileSync(dbPath)), 'inspect/verify/status no escriben ni un byte');
  assert.throws(() => dba.openReadOnly(path.join(tmp('akdd-nada-'), 'no-existe.db')), (e) => e.code === 'NOT_INITIALIZED');
});
