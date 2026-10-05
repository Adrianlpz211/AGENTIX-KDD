'use strict';
/* Contratos sin archivo de test (glowly, 05/10/2026: 0 de 140 tenían test_file ni source_files). Sin ellos el Preservation Gate no puede
   elegir qué tests correr: cada ciclo termina UNVERIFIED (NO_TEST_FILE_MAPPED) y 59 de 62 quedaron «COMPLETADO_CON_PENDIENTES».
   `backfill-test-files` los atribuye por el título literal del test, solo cuando es único, y deduce las fuentes de los imports. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { crearFixture, REPO } = require('./fixtures/dashboard-fixture.cjs');
const tm = require(path.join(REPO, '.agentic', 'grafo', 'test-file-map.cjs'));

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-cfile-' + p + '-'));

function proyecto() {
  const dir = tmp('p'); crearFixture(dir, { esquemaCompleto: true });
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true }); fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lib', 'iva.mjs'), 'export const iva = (x) => x * 0.16;\n');
  fs.writeFileSync(path.join(dir, 'tests', 'iva.test.mjs'), "import test from 'node:test';\nimport { iva } from '../lib/iva.mjs';\ntest('el IVA es el 16 por ciento', () => { iva(1); });\ntest(\"título repetido\", () => {});\n");
  fs.writeFileSync(path.join(dir, 'tests', 'otro.test.mjs'), "import test from 'node:test';\ntest('título repetido', () => {});\ntest(`con ${1 + 1} calculado`, () => {});\ntest('solo aquí', () => {});\n");
  const db = new DatabaseSync(path.join(dir, '.agentic', 'memoria.db'));
  const ins = db.prepare("INSERT INTO verified_contracts (id, module, name, test_name, status, mapping_status) VALUES (?, 'm', ?, ?, 'protected', 'RESOLVED')");
  ins.run('c1', 'iva', 'el IVA es el 16 por ciento'); ins.run('c2', 'rep', 'título repetido'); ins.run('c3', 'solo', 'solo aquí'); ins.run('c4', 'fantasma', 'este test ya no existe');
  db.close();
  return dir;
}
const cli = (dir, ...a) => spawnSync(process.execPath, [path.join(REPO, '.agentic', 'grafo', 'contract-guard.cjs'), ...a], { cwd: dir, encoding: 'utf8', windowsHide: true });
const filas = (dir) => { const d = new DatabaseSync(path.join(dir, '.agentic', 'memoria.db'), { readOnly: true }); try { return d.prepare('SELECT id, test_file, source_files FROM verified_contracts ORDER BY id').all(); } finally { d.close(); } };

test('CFILE-1 — el mapa título → archivo: solo títulos literales y únicos', () => {
  const dir = proyecto(); const m = tm.construirMapa(dir);
  assert.equal(tm.archivoDe(m, 'el IVA es el 16 por ciento'), 'tests/iva.test.mjs');
  assert.equal(tm.archivoDe(m, 'solo aquí'), 'tests/otro.test.mjs');
  assert.equal(tm.archivoDe(m, 'título repetido'), null, 'dos archivos con el mismo título: no se adivina');
  assert.equal(tm.archivoDe(m, 'este test ya no existe'), null);
  assert.equal(tm.archivoDe(m, 'con 2 calculado'), null, 'un título calculado (${}) no es literal');
  assert.deepEqual(tm.fuentesDe(dir, 'tests/iva.test.mjs'), ['lib/iva.mjs'], 'las fuentes salen de los imports del test');
});

test('CFILE-2 — backfill-test-files: dry-run cuenta y no escribe; --aplicar rellena test_file y source_files; es idempotente y no pisa', () => {
  const dir = proyecto();
  const seco = cli(dir, 'backfill-test-files');
  assert.match(seco.stdout, /Contratos: 4 · ya tenían archivo de test: 0 · atribuibles por título único: 2 · sin atribuir.*: 2/, seco.stdout + seco.stderr);
  assert.match(seco.stdout, /Dry-run: no se escribió nada/);
  assert.ok(filas(dir).every((f) => !f.test_file), 'el dry-run no escribe');
  const real = cli(dir, 'backfill-test-files', '--aplicar');
  assert.match(real.stdout, /Aplicado a 2 contrato\(s\)/, real.stdout + real.stderr);
  const f = Object.fromEntries(filas(dir).map((x) => [x.id, x]));
  assert.equal(f.c1.test_file, 'tests/iva.test.mjs'); assert.deepEqual(JSON.parse(f.c1.source_files), ['lib/iva.mjs']);
  assert.equal(f.c3.test_file, 'tests/otro.test.mjs');
  assert.ok(!f.c2.test_file && !f.c4.test_file, 'ambiguo o desaparecido: se queda sin archivo');
  const otra = cli(dir, 'backfill-test-files', '--aplicar');
  assert.match(otra.stdout, /ya tenían archivo de test: 2/, 'idempotente: lo ya puesto no se toca');
});
