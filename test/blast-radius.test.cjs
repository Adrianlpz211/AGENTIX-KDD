'use strict';

/** H29: radio de impacto transitivo, exacto y con cobertura declarada. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const GRAFO = path.join(__dirname, '..', '.agentic', 'grafo');
const br = require(path.join(GRAFO, 'blast-radius.cjs'));
const cg = require(path.join(GRAFO, 'contract-guard.cjs'));

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** archivos: {rel: contenido}; imports: [[desde, hacia]]; sinIndice: [rel] */
function fixture(archivos, imports, sinIndice = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-br-'));
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE ast_symbols (file TEXT, symbol_name TEXT, kind TEXT, content_hash TEXT);
           CREATE TABLE ast_edges (from_file TEXT, to_file TEXT, from_symbol TEXT, to_symbol TEXT, kind TEXT, weight REAL)`);
  for (const [rel, txt] of Object.entries(archivos)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), txt);
    if (!sinIndice.includes(rel)) db.prepare('INSERT INTO ast_symbols VALUES (?, ?, ?, ?)').run(rel.replace(/\//g, path.sep), 'x', 'function', sha(txt));
  }
  for (const [de, a] of imports) db.prepare("INSERT INTO ast_edges VALUES (?, ?, NULL, NULL, 'IMPORTS', 1)").run(de.replace(/\//g, path.sep), a.replace(/\//g, path.sep));
  return { root, db };
}

const contrato = (id, test_file, extra = {}) => Object.assign({ id, name: id, module: 'x', status: 'verified', test_file, source_files: '[]' }, extra);

test('H29: A ← B ← C incluye el contrato colgado de C', () => {
  const { root, db } = fixture({ 'src/a.js': 'a', 'src/b.js': 'b', 'test/c.test.js': 'c' }, [['src/b.js', 'src/a.js'], ['test/c.test.js', 'src/b.js']]);
  const r = br.analizar(db, root, ['src/a.js'], { contracts: [contrato('C1', 'test/c.test.js'), contrato('OTRO', 'test/z.test.js')] });
  assert.deepEqual(r.contracts.map((c) => c.id), ['C1']);
  assert.equal(r.affected.find((n) => n.file === 'test/c.test.js').depth, 2);
  assert.equal(r.complete, true);
  assert.equal(r.severity, 'LOW');
  assert.equal(r.status, 'PASS');
});

test('H29: un ciclo de imports no cuelga', () => {
  const { root, db } = fixture({ 'a.js': 'a', 'b.js': 'b' }, [['a.js', 'b.js'], ['b.js', 'a.js']]);
  const r = br.analizar(db, root, ['a.js'], { contracts: [] });
  assert.deepEqual(r.affected.map((n) => n.file).sort(), ['a.js', 'b.js']);
});

test('H29: una subcadena no inventa contrato (auth.js no es oauth-helper)', () => {
  const { root, db } = fixture({ 'src/auth.js': 'a', 'test/oauth-helper.test.js': 'o' }, []);
  const r = br.analizar(db, root, ['src/auth.js'], {
    contracts: [contrato('OAUTH', 'test/oauth-helper.test.js', { module: 'auth', source_files: JSON.stringify(['src/oauth-auth.js']) })],
  });
  assert.equal(r.contracts.length, 0);
});

test('H29: índice viejo, archivo sin índice o import dinámico = cobertura parcial, nunca LOW', () => {
  const f = fixture({ 'src/a.js': 'a', 'src/e.js': 'e', 'src/d.js': 'const m = require(nombre);' }, [['src/d.js', 'src/a.js']], ['src/e.js']);
  fs.writeFileSync(path.join(f.root, 'src', 'a.js'), 'a cambiado');
  const r = br.analizar(f.db, f.root, ['src/a.js', 'src/e.js'], { contracts: [] });
  assert.equal(r.complete, false);
  assert.equal(r.severity, 'UNKNOWN');
  assert.deepEqual(r.coverage.stale, ['src/a.js']);
  assert.ok(r.coverage.unknown.some((u) => u.file === 'src/e.js' && u.reason === 'SIN_INDICE'));
  assert.ok(r.coverage.unknown.some((u) => u.file === 'src/d.js' && u.reason === 'IMPORT_DINAMICO'));
  assert.equal(br.analizar(f.db, f.root, ['README.txt'], { contracts: [] }).coverage.unknown[0].reason, 'LENGUAJE_SIN_COBERTURA');
});

test('H29: recorrido cortado por límite queda explícito', () => {
  const { root, db } = fixture({ 'a.js': 'a', 'b.js': 'b', 'c.js': 'c' }, [['b.js', 'a.js'], ['c.js', 'b.js']]);
  const r = br.analizar(db, root, ['a.js'], { contracts: [], limites: { maxDepth: 1 } });
  assert.equal(r.coverage.truncated, 'MAX_DEPTH');
  assert.equal(r.complete, false);
});

test('H29: CRITICAL detiene; sin índice AST = ERROR, no LOW', () => {
  const { root, db } = fixture({ 'a.js': 'a' }, []);
  const muchos = Array.from({ length: 21 }, (_, i) => contrato('K' + i, 'a.js'));
  const r = br.analizar(db, root, ['a.js'], { contracts: muchos });
  assert.equal(r.severity, 'CRITICAL');
  assert.equal(r.status, 'STOP');
  const vacia = new DatabaseSync(':memory:');
  assert.equal(br.analizar(vacia, root, ['a.js'], { contracts: [] }).status, 'ERROR');
});

test('H29: preservation y el reporte usan el cierre transitivo con cobertura', () => {
  const { root, db } = fixture({ 'src/a.js': 'a', 'src/b.js': 'b', 'test/b.test.js': 't' }, [['src/b.js', 'src/a.js'], ['test/b.test.js', 'src/b.js']]);
  const enRiesgo = cg.getContractsInBlastRadius(db, ['src/a.js'], [contrato('B', 'test/b.test.js')], root);
  assert.deepEqual(enRiesgo.map((c) => c.id), ['B']);
  assert.equal(enRiesgo.analisis.complete, true);
  db.exec(`CREATE TABLE verified_contracts (id TEXT, name TEXT, module TEXT, status TEXT, test_file TEXT, source_files TEXT)`);
  db.prepare("INSERT INTO verified_contracts VALUES ('B', 'B', 'x', 'verified', 'test/b.test.js', '[]')").run();
  const rep = cg.getBlastRadiusReport(db, root, 'src/a.js');
  assert.equal(rep.contracts_at_risk, 1);
  assert.ok(rep.affected_files.includes('test/b.test.js'));
});
