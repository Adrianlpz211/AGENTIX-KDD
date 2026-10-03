'use strict';
/* Inventario de memoria (3.20.1): "no cambió nada" se demuestra por CONTENIDO. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const real = require('./helpers/db-real.cjs');
const { dba, inv } = real;

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** Una base con todos los tipos de dato difíciles. */
function baseExotica() {
  const f = path.join(tmp('akdd-inv-'), 'memoria.db');
  real.crearBase(f, { nodos: 4, propias: false });
  const db = dba.openWrite(f, { updateOwner: true });
  try {
    db.exec('CREATE TABLE exotica (a INTEGER, b TEXT, c BLOB, d, e REAL, PRIMARY KEY (a, b)) WITHOUT ROWID');
    db.run('INSERT INTO exotica VALUES (?,?,?,?,?)', [9223372036854775807n, 'ñandú 🦆', Buffer.from([0, 255, 1, 0]), 1.0, 0.1]);
    db.run('INSERT INTO exotica VALUES (?,?,?,?,?)', [-9223372036854775808n, '', null, null, -0.0]);
    db.run('INSERT INTO exotica VALUES (?,?,?,?,?)', [1n, 'a', Buffer.alloc(0), 'texto', 1e300]);
    db.exec('CREATE TABLE dups (x TEXT, y INTEGER)');
    for (let i = 0; i < 3; i++) db.run("INSERT INTO dups VALUES ('igual', 1)");
    db.exec('CREATE INDEX idx_dups ON dups(x)');
    db.exec('CREATE VIEW v_dups AS SELECT x FROM dups');
    db.exec('CREATE TRIGGER tr_dups AFTER INSERT ON dups BEGIN SELECT 1; END');
  } finally { db.close(); }
  return f;
}

const siempreFalla = (nombre, dbPath, mutar) => {
  const antes = real.inventario(dbPath);
  const db = dba.openWrite(dbPath, { updateOwner: true });
  try { mutar(db); } finally { db.close(); }
  const r = real.conservada(antes, dbPath);
  assert.equal(r.status, 'FAIL', `"${nombre}" debía detectarse`);
  return r;
};

test('inventario: dos lecturas de la misma base dan el mismo resultado, y es independiente del orden', () => {
  const f = baseExotica();
  const a = real.inventario(f), b = real.inventario(f);
  assert.equal(real.inv.compare(a, b).status, 'PASS');
  assert.deepEqual(a.tables.exotica.digest, b.tables.exotica.digest);
  assert.equal(a.tables.exotica.rows, 3);
  assert.deepEqual(a.tables.exotica.pk, ['a', 'b'], 'clave compuesta y WITHOUT ROWID');
  assert.equal(a.tables.dups.rows, 3, 'filas duplicadas cuentan');
  assert.equal(a.tables.nodos.class, 'engine');
  assert.equal(a.tables.exotica.class, 'user', 'tabla del consumidor');
});

test('inventario: detecta cambios que ni COUNT(*) ni el hash del archivo verían', () => {
  const f = baseExotica();
  siempreFalla('cambiar un valor de 64 bits por otro cercano', f, (d) => d.run('UPDATE exotica SET a = 9223372036854775806 WHERE a = 9223372036854775807'));
  const g = baseExotica();
  siempreFalla('quitar una fila y añadir otra (mismo total)', g, (d) => { d.run("DELETE FROM exotica WHERE a = 1"); d.run("INSERT INTO exotica VALUES (2, 'a', x'', 'texto', 1e300)"); });
  const h = baseExotica();
  siempreFalla('NULL por cadena vacía', h, (d) => d.run("UPDATE exotica SET d = '' WHERE d IS NULL"));
  const i = baseExotica();
  siempreFalla('BLOB vacío por NULL', i, (d) => d.run('UPDATE exotica SET c = NULL WHERE length(c) = 0'));
  const j = baseExotica();
  siempreFalla('REAL 1.0 por INTEGER 1 en una columna sin afinidad', j, (d) => d.run('UPDATE exotica SET d = 1 WHERE d = 1.0'));
  const k = baseExotica();
  siempreFalla('borrar una de tres filas idénticas', k, (d) => d.run('DELETE FROM dups WHERE rowid = (SELECT min(rowid) FROM dups)'));
  const l = baseExotica();
  siempreFalla('texto con la misma longitud pero otro contenido', l, (d) => d.run("UPDATE exotica SET b = 'ñandú 🦅' WHERE a = 9223372036854775807"));
});

test('inventario: objetos propios (índices, triggers, vistas) y secuencias se vigilan', () => {
  const f = baseExotica();
  siempreFalla('borrar un índice propio', f, (d) => d.exec('DROP INDEX idx_dups'));
  const g = baseExotica();
  siempreFalla('borrar una vista propia', g, (d) => d.exec('DROP VIEW v_dups'));
  const h = baseExotica();
  siempreFalla('cambiar un trigger propio', h, (d) => { d.exec('DROP TRIGGER tr_dups'); d.exec('CREATE TRIGGER tr_dups AFTER INSERT ON dups BEGIN SELECT 2; END'); });
  const i = baseExotica();
  siempreFalla('retroceder una secuencia AUTOINCREMENT', i, (d) => { d.exec('DELETE FROM nodos'); d.exec("UPDATE sqlite_sequence SET seq = 1 WHERE name = 'nodos'"); });
});

test('inventario: una columna AÑADIDA no es un cambio; una columna QUITADA sí', () => {
  const f = baseExotica();
  const antes = real.inventario(f);
  const db = dba.openWrite(f, { updateOwner: true });
  try { db.exec('ALTER TABLE dups ADD COLUMN extra TEXT'); } finally { db.close(); }
  assert.equal(real.conservada(antes, f).status, 'PASS', 'migración aditiva: se compara lo que existía');
  const db2 = dba.openWrite(f, { updateOwner: true });
  try { db2.exec('ALTER TABLE dups DROP COLUMN y'); } finally { db2.close(); }
  assert.equal(real.conservada(antes, f).status, 'FAIL');
});

test('inventario: las tablas derivadas se identifican explícitamente y no se confunden con conocimiento', () => {
  const f = baseExotica();
  const db = dba.openWrite(f, { updateOwner: true });
  try {
    require(path.join(real.REPO, '.agentic', 'grafo', 'schema-catalog.cjs')).apply(db, { version: 'prueba' }); // crea ast_symbols como lo haría el motor
    db.run("INSERT INTO ast_symbols (file, language, symbol_name, kind, line_start) VALUES ('a.js', 'javascript', 'f', 'function', 1)");
    // Una tabla del consumidor con nombre PARECIDO a una derivada no es derivada.
    db.exec('CREATE TABLE ast_symbols_mios (x TEXT)');
    db.run("INSERT INTO ast_symbols_mios VALUES ('mio')");
  } finally { db.close(); }
  const antes = real.inventario(f);
  assert.equal(antes.tables.ast_symbols.class, 'derived');
  assert.equal(antes.tables.ast_symbols_mios.class, 'user', 'no se excluye por nombre aproximado');
  const w = dba.openWrite(f, { updateOwner: true });
  try { w.exec('DELETE FROM ast_symbols'); w.run("UPDATE ast_symbols_mios SET x = 'otro'"); } finally { w.close(); }
  const r = real.conservada(antes, f);
  assert.equal(r.status, 'FAIL');
  assert.ok(r.problems.some((p) => /ast_symbols_mios/.test(p)), 'lo del consumidor sí se exige');
  assert.ok(!r.problems.some((p) => /^ast_symbols:/.test(p)), 'lo derivado solo se informa');
  assert.deepEqual(r.info.derived.ast_symbols, { before: 1, after: 0 });
});

test('inventario: se lee en streaming (50.000 filas) sin cargar la tabla', () => {
  const f = path.join(tmp('akdd-inv-grande-'), 'memoria.db');
  real.crearBase(f, { nodos: 1, propias: false });
  const db = dba.openWrite(f, { updateOwner: true });
  try {
    db.exec('CREATE TABLE grande (id INTEGER PRIMARY KEY, t TEXT)');
    db.transaction(() => { for (let i = 0; i < 50000; i++) db.run('INSERT INTO grande VALUES (?, ?)', [i, 'fila ' + i]); })();
  } finally { db.close(); }
  const antesMem = process.memoryUsage().heapUsed;
  const a = real.inventario(f);
  const despuesMem = process.memoryUsage().heapUsed;
  assert.equal(a.tables.grande.rows, 50000);
  assert.ok(despuesMem - antesMem < 40 * 1024 * 1024, 'sin crecer en memoria con la tabla: +' + Math.round((despuesMem - antesMem) / 1048576) + ' MB');
});

test('inventario: sin streaming con INTEGER de 64 bits es NO_VERIFICADO, nunca PASS', () => {
  const falso = { capabilities: { iterate: false, bigints: false }, type: 'falso' };
  const r = inv.takeInventory(falso);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'NO_VERIFICADO');
  assert.equal(inv.compare(r, r).status, 'NO_VERIFICADO');
});

test('inventario de archivos: ninguno propio cambia, falta ninguno; los cambios esperados se declaran', () => {
  const root = tmp('akdd-inv-arch-');
  const w = (rel, t) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
  w('.agentic/memoria/patrones.md', 'a'); w('.agentic/config.md', 'b'); w('.cursor/rules/mia.mdc', 'regla propia'); w('CLAUDE.md', 'framework');
  const noFramework = (rel) => rel !== 'CLAUDE.md';
  const antes = inv.inventoryFiles(root, { incluir: noFramework });
  assert.ok(antes['.cursor/rules/mia.mdc'] && !antes['CLAUDE.md']);
  w('.cursor/rules/mia.mdc', 'regla propia editada');
  const mal = inv.compareFiles(antes, inv.inventoryFiles(root, { incluir: noFramework }), {});
  assert.equal(mal.ok, false);
  assert.match(mal.problems[0], /mia\.mdc/);
  const bien = inv.compareFiles(antes, inv.inventoryFiles(root, { incluir: noFramework }), { '.cursor/rules/mia.mdc': 'cambio declarado' });
  assert.equal(bien.ok, true);
  fs.rmSync(path.join(root, '.agentic/config.md'));
  assert.match(inv.compareFiles(antes, inv.inventoryFiles(root, { incluir: noFramework }), { '.cursor/rules/mia.mdc': 'x' }).problems.join(), /config\.md.*desapareció/);
});
