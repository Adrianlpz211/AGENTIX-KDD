'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const gate = require('../.agentic/grafo/gate-result.cjs');
const db = require('../.agentic/grafo/db-adapter.cjs');

function temporal() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-db-'));
}

test('PASS sin evidencia del sujeto queda UNVERIFIED y no cierra', () => {
  const result = gate.createGateResult({
    gate: 'tdd',
    status: 'PASS',
    subject_hash: 'abc',
    evidence: [],
    started_at: '2026-10-02T00:00:00.000Z',
    finished_at: '2026-10-02T00:00:01.000Z',
  });
  assert.equal(result.status, 'UNVERIFIED');
  assert.equal(result.passed, false);
  assert.equal(result.reason_code, 'PASS_WITHOUT_SUBJECT_EVIDENCE');
  assert.equal(gate.allowsVerifiedClose(result), false);
});

test('DTO PASS con evidencia declarada no cierra sin artefacto', () => {
  const result = gate.createGateResult({
    gate: 'tdd',
    status: 'PASS',
    subject_hash: 'abc',
    evidence: [{ kind: 'runner', subject_hash: 'abc', exit_code: 0 }],
  });
  assert.equal(result.status, 'PASS');
  assert.equal(result.passed, true);
  assert.equal(gate.allowsVerifiedClose(result), false);
});

test('SKIP y ERROR no cierran aunque blocking sea false', () => {
  for (const status of ['SKIP', 'ERROR', 'FAIL', 'UNVERIFIED']) {
    const result = gate.createGateResult({
      gate: 'tdd',
      status,
      blocking: false,
      reason_code: 'MOTIVO',
      subject_hash: 'abc',
      evidence: [{ kind: 'runner', subject_hash: 'abc' }],
    });
    assert.equal(result.status, status);
    assert.equal(gate.allowsVerifiedClose(result), false);
  }
});

test('lectura de un archivo ausente no lo crea', () => {
  const dir = temporal();
  const archivo = path.join(dir, 'memoria.db');
  assert.throws(() => db.openReadOnly(archivo), (err) => err.code === 'NOT_INITIALIZED');
  assert.equal(fs.existsSync(archivo), false);
});

test('lectura no cambia user_version ni el esquema', () => {
  const dir = temporal();
  const archivo = path.join(dir, 'memoria.db');
  const escritura = db.openWrite(archivo);
  escritura.exec('CREATE TABLE nodos (id INTEGER PRIMARY KEY, titulo TEXT)');
  escritura.exec('PRAGMA user_version = 7');
  escritura.run('INSERT INTO nodos (titulo) VALUES (?)', 'alpha');
  escritura.close();

  const antes = db.openReadOnly(archivo);
  const versionAntes = db.userVersion(antes);
  const tablasAntes = antes.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map((r) => r.name);
  antes.close();

  const lectura = db.openReadOnly(archivo);
  assert.throws(() => lectura.exec('CREATE TABLE intrusa (id INTEGER)'), (err) => err.code === 'READ_ONLY');
  assert.throws(() => lectura.pragma('user_version = 1'), (err) => err.code === 'READ_ONLY');
  lectura.close();

  const despues = db.openReadOnly(archivo);
  assert.equal(db.userVersion(despues), versionAntes);
  assert.equal(db.userVersion(despues), 7);
  assert.deepEqual(
    despues.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map((r) => r.name),
    tablasAntes
  );
  assert.equal(despues.get('SELECT COUNT(*) AS n FROM nodos').n, 1);
  despues.close();
});

test('un fallo a mitad de la transacción revierte todo', () => {
  const dir = temporal();
  const archivo = path.join(dir, 'memoria.db');
  const conexion = db.openWrite(archivo);
  conexion.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)');
  assert.throws(() => {
    conexion.transaction(() => {
      conexion.run("INSERT INTO t (v) VALUES ('ok')");
      conexion.run('INSERT INTO t (v) VALUES (NULL)');
    })();
  });
  assert.equal(conexion.get('SELECT COUNT(*) AS n FROM t').n, 0);
  conexion.close();
});

test('el rollback de una conexión no borra lo que otra ya confirmó', () => {
  const dir = temporal();
  const archivo = path.join(dir, 'memoria.db');
  const a = db.openWrite(archivo, { busyTimeout: 300 });
  const b = db.openWrite(archivo, { busyTimeout: 300 });
  a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)');
  a.transaction(() => { a.run("INSERT INTO t (v) VALUES ('a')"); })();
  b.transaction(() => { b.run("INSERT INTO t (v) VALUES ('b')"); })();
  assert.throws(() => {
    a.transaction(() => {
      a.run("INSERT INTO t (v) VALUES ('c')");
      throw new Error('medio');
    })();
  }, /medio/);
  const valores = a.all('SELECT v FROM t ORDER BY id').map((r) => r.v);
  assert.deepEqual(valores, ['a', 'b']);
  a.close();
  b.close();
});

test('la migración en seco no toca la base y un fallo restaura la copia', () => {
  const dir = temporal();
  const archivo = path.join(dir, 'memoria.db');
  const conexion = db.openWrite(archivo);
  conexion.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
  conexion.exec('PRAGMA user_version = 2');
  conexion.close();

  const seco = db.migrate(archivo, {
    dryRun: true,
    version: 3,
    statements: ['ALTER TABLE t ADD COLUMN extra TEXT'],
  });
  assert.equal(seco.applied, false);
  const lectura = db.openReadOnly(archivo);
  assert.equal(db.userVersion(lectura), 2);
  lectura.close();

  assert.throws(() => db.migrate(archivo, {
    version: 4,
    statements: ['ESTO NO ES SQL'],
  }));
  const restaurada = db.openReadOnly(archivo);
  assert.equal(db.userVersion(restaurada), 2);
  restaurada.close();
});

test('importar el grafo no crea ni migra una base', () => {
  const dir = temporal();
  const memoria = path.join(dir, 'memoria');
  fs.mkdirSync(memoria);
  const dbPath = path.join(dir, 'memoria.db');
  const grafo = path.join(__dirname, '..', '.agentic', 'grafo', 'grafo.cjs');
  const script = `
    process.env.AGENTIC_MEMORIA_PATH_OVERRIDE = ${JSON.stringify(memoria)};
    require(${JSON.stringify(grafo)});
  `;
  const corrida = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(corrida.status, 0, corrida.stderr);
  assert.equal(fs.existsSync(dbPath), false);
});

test('recall no crea tablas ni cambia user_version', async () => {
  const dir = temporal();
  const root = dir;
  fs.mkdirSync(path.join(root, '.agentic'));
  const archivo = path.join(root, '.agentic', 'memoria.db');
  const conexion = db.openWrite(archivo);
  conexion.exec(`CREATE TABLE nodos (
    id INTEGER PRIMARY KEY,
    titulo TEXT, contenido TEXT, area TEXT, tipo TEXT,
    confianza TEXT, aplicado INTEGER, estado TEXT,
    embedding TEXT, fecha_update TEXT
  )`);
  conexion.exec('PRAGMA user_version = 7');
  conexion.run(
    "INSERT INTO nodos (titulo, contenido, area, tipo, confianza, aplicado, estado) VALUES (?,?,?,?,?,?,?)",
    ['alpha', 'beta', 'auth', 'error', 'ALTA', 1, 'ACTIVO']
  );
  conexion.close();

  const { recall } = require('../.agentic/grafo/kdd-memory.cjs');
  const salida = await recall('alpha', { topK: 5 }, root);
  assert.ok(salida);

  const lectura = db.openReadOnly(archivo);
  assert.equal(db.userVersion(lectura), 7);
  const tablas = lectura.all("SELECT name FROM sqlite_master").map((r) => r.name);
  assert.equal(tablas.includes('nodos_fts'), false);
  assert.equal(lectura.get('SELECT COUNT(*) AS n FROM nodos').n, 1);
  lectura.close();
});
