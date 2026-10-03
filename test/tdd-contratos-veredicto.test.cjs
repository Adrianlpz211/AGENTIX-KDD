'use strict';

// H01 · H02 · H03 · H16 — el veredicto de los tests y los contratos sale de
// evidencia real, nunca de "el texto dice 0 fallos" ni de "no había nada".

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tdd = require('../.agentic/grafo/tdd-gate.cjs');
const cg = require('../.agentic/grafo/contract-guard.cjs');
const { extractTestResults } = require('../.agentic/grafo/test-results.cjs');
const dbAccess = require('../.agentic/grafo/db-adapter.cjs');

const SUJETO = { subject_hash: 'sujeto-1' };

// Un `node --test` lanzado desde dentro de otro hereda esta variable y le
// manda sus resultados al padre en vez de imprimirlos: el fixture no vería nada.
delete process.env.NODE_TEST_CONTEXT;

function temporal() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-tdd-'));
}

// ── H01: el proceso manda sobre el texto ────────────────────────────────────

test('H01: node --test "pass 1 / fail 0" con exit 1 no es PASS', () => {
  const r = tdd.parseTestOutput('# tests 1\n# pass 1\n# fail 0\n', 1, SUJETO);
  assert.equal(r.status, 'FAIL');
  assert.equal(r.reason_code, 'RUNNER_EXIT_NONZERO');
  assert.equal(r.allPassed, false);
});

test('H01: pytest "1 failed, 2 passed" se lee en cualquier orden', () => {
  const r = tdd.parseTestOutput('===== 1 failed, 2 passed in 0.12s =====', 1, SUJETO);
  assert.equal(r.failed, 1);
  assert.equal(r.passed, 2);
  assert.equal(r.status, 'FAIL');
});

test('H01: timeout, señal y fallo de arranque son ERROR', () => {
  assert.equal(tdd.parseTestOutput('# pass 3', 0, { ...SUJETO, timedOut: true }).reason_code, 'TIMEOUT');
  assert.equal(tdd.parseTestOutput('# pass 3', null, { ...SUJETO, signal: 'SIGKILL' }).reason_code, 'SIGNAL_SIGKILL');
  assert.equal(tdd.parseTestOutput('', null, { ...SUJETO, spawnError: 'ENOENT' }).status, 'ERROR');
});

test('H01: salida irreconocible o cero tests queda UNVERIFIED', () => {
  assert.equal(tdd.parseTestOutput('hola mundo', 0, SUJETO).reason_code, 'UNKNOWN_OUTPUT');
  assert.equal(tdd.parseTestOutput('# tests 0\n# pass 0\n# fail 0', 0, SUJETO).status, 'UNVERIFIED');
});

test('H01: un caso válido sí pasa, y sin sujeto baja a UNVERIFIED', () => {
  const ok = tdd.parseTestOutput('# tests 2\n# pass 2\n# fail 0', 0, SUJETO);
  assert.equal(ok.status, 'PASS');
  assert.equal(ok.gate.status, 'PASS');
  const sinSujeto = tdd.parseTestOutput('# tests 2\n# pass 2\n# fail 0', 0, {});
  assert.equal(sinSujeto.status, 'UNVERIFIED');
});

test('H01: argumentos de test con caracteres de shell no se ejecutan', () => {
  const r = tdd.runTests('node -e "0"', os.tmpdir(), ['a.test.js & echo pwned'], SUJETO);
  assert.equal(r.status, 'ERROR');
  assert.equal(r.reason_code, 'SPAWN_FAILED');
});

test('extractor: un resultado por test individual', () => {
  const tap = [
    'ok 1 - suma bien',
    'not ok 2 - resta mal',
    '  ---',
    "  location: 'C:\\\\p\\\\test\\\\x.test.cjs:3:1'",
    '  ...',
    'ok 3 - pendiente # SKIP',
  ].join('\n');
  const tests = extractTestResults(tap);
  assert.deepEqual(tests.map((t) => [t.test_name, t.status]), [['suma bien', 'pass'], ['resta mal', 'fail']]);
});

// ── H16: reintentar exige un cambio; el mismo fallo dos veces bloquea ───────

function proyectoQueFalla() {
  const dir = temporal();
  fs.mkdirSync(path.join(dir, '.agentic'));
  fs.mkdirSync(path.join(dir, 'test'));
  fs.writeFileSync(path.join(dir, '.agentic', 'config.md'), 'test: node --test\n');
  fs.writeFileSync(path.join(dir, 'test', 'a.test.cjs'),
    "require('node:test')('siempre falla', () => { throw new Error('roto'); });\n");
  return dir;
}

test('H16: sin cambio de código no hay reintento; mismo fallo tras reparar bloquea', () => {
  const dir = proyectoQueFalla();
  const silencio = console.log;
  console.log = () => {};
  try {
    const r1 = tdd.runSelfHealingLoop({ projectRoot: dir, subjectHash: 'v1' });
    assert.equal(r1.status, 'NEEDS_REPAIR');
    assert.equal(r1.iterations, 1);

    const r2 = tdd.runSelfHealingLoop({ projectRoot: dir, subjectHash: 'v1' });
    assert.equal(r2.reason_code, 'NO_REPAIR_SINCE_LAST_FAIL');
    assert.equal(r2.iterations, 1, 'no consume un intento sin cambio');

    const r3 = tdd.runSelfHealingLoop({ projectRoot: dir, subjectHash: 'v2' });
    assert.equal(r3.status, 'BLOCKED');
    assert.equal(r3.reason_code, 'SAME_FAILURE_AFTER_REPAIR');

    const r4 = tdd.runSelfHealingLoop({ projectRoot: dir, subjectHash: 'v3' });
    assert.equal(r4.status, 'BLOCKED', 'bloqueado hasta revisión humana');
    tdd.clearState(dir);
    assert.equal(tdd.loadState(dir), null);
  } finally {
    console.log = silencio;
  }
});

// ── H02 / H03: contratos por test individual, preservation honesto ──────────

function baseContratos(conV2) {
  const dir = temporal();
  fs.mkdirSync(path.join(dir, '.agentic'));
  const dbPath = path.join(dir, '.agentic', 'memoria.db');
  const db = dbAccess.openWrite(dbPath);
  cg.migrateSchema(db);
  if (conV2) cg.migrateSchemaV2(db);
  return { dir, dbPath, db };
}

const TESTS = [
  { test_file: 'test/a.test.cjs', test_name: 'uno', status: 'pass' },
  { test_file: 'test/a.test.cjs', test_name: 'dos', status: 'pass' },
  { test_file: 'test/a.test.cjs', test_name: 'tres', status: 'fail' },
];

test('H03: un contrato por test que pasó, nunca uno por área', () => {
  const { db } = baseContratos(true);
  const r = cg.registerPassingTests(db, { area: 'pagos', command: 'npm test', execution_id: 'e1', subject_hash: 's1', tests: TESTS });
  assert.equal(r.status, 'PASS');
  assert.equal(r.created, 2);
  const filas = db.prepare('SELECT test_name, verification_count FROM verified_contracts ORDER BY test_name').all();
  assert.deepEqual(filas.map((f) => f.test_name), ['dos', 'uno']);
  db.close();
});

test('H03: la misma ejecución no suma dos veces; otra ejecución sí', () => {
  const { db } = baseContratos(true);
  const p = { area: 'pagos', command: 'npm test', subject_hash: 's1', tests: TESTS };
  cg.registerPassingTests(db, { ...p, execution_id: 'e1' });
  const rep = cg.registerPassingTests(db, { ...p, execution_id: 'e1' });
  assert.equal(rep.duplicates, 2);
  assert.equal(rep.updated, 0);
  cg.registerPassingTests(db, { ...p, execution_id: 'e2' });
  const uno = db.prepare("SELECT verification_count FROM verified_contracts WHERE test_name = 'uno'").get();
  assert.equal(uno.verification_count, 2);
  db.close();
});

test('H03: sin esquema v2 no escribe y pide migrar', () => {
  const { db } = baseContratos(false);
  const r = cg.registerPassingTests(db, { area: 'x', command: 'npm test', execution_id: 'e1', tests: TESTS });
  assert.equal(r.status, 'UPGRADE_REQUIRED');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM verified_contracts').get().n, 0);
  db.close();
});

test('H03: la migración deja los contratos viejos de "npm test" como UNRESOLVED', () => {
  const { db } = baseContratos(false);
  db.prepare(`INSERT INTO verified_contracts (id, module, name, test_file, status, verification_count, consecutive_passes)
              VALUES ('X-1', 'pagos', 'pagos tests (5/5)', 'npm test', 'protected', 9, 9)`).run();
  cg.migrateSchemaV2(db);
  const fila = db.prepare("SELECT status, mapping_status, verification_count FROM verified_contracts WHERE id = 'X-1'").get();
  assert.equal(fila.mapping_status, 'UNRESOLVED');
  assert.equal(fila.status, 'protected', 'conserva su nivel');
  assert.equal(fila.verification_count, 9, 'conserva su historial');
  db.close();
});

test('H02: sin contratos es SKIP explícito, no PASS', () => {
  const { dir, db } = baseContratos(true);
  const r = cg.runPreservationGate(db, dir, 'c1', []);
  assert.equal(r.status, 'SKIP');
  assert.equal(r.reason_code, 'NO_CONTRACTS');
  assert.equal(r.passed, false);
  db.close();
});

test('H02: error de consulta es ERROR bloqueante', () => {
  const dir = temporal();
  const db = dbAccess.openWrite(path.join(dir, 'vacia.db'));
  const r = cg.runPreservationGate(db, dir, 'c1', []);
  assert.equal(r.status, 'ERROR');
  assert.equal(r.blocking, true);
  db.close();
});

test('H02: contrato protegido sin test mapeado es UNVERIFIED y bloquea', () => {
  const { dir, db } = baseContratos(false);
  db.prepare(`INSERT INTO verified_contracts (id, module, name, test_file, status)
              VALUES ('X-1', 'pagos', 'pagos tests (5/5)', 'npm test', 'protected')`).run();
  cg.migrateSchemaV2(db);
  const r = cg.runPreservationGate(db, dir, 'c1', []);
  assert.equal(r.status, 'UNVERIFIED');
  assert.equal(r.blocking, true);
  db.close();
});

test('H02: preservation corre el runner del proyecto y detecta el test roto', () => {
  const { dir, db } = baseContratos(true);
  fs.mkdirSync(path.join(dir, 'test'));
  fs.writeFileSync(path.join(dir, '.agentic', 'config.md'), 'test: node --test\n');
  fs.writeFileSync(path.join(dir, 'test', 'a.test.cjs'), [
    "const t = require('node:test');",
    "t('uno', () => {});",
    "t('dos', () => { throw new Error('se rompió'); });",
  ].join('\n'));
  for (const nombre of ['uno', 'dos']) {
    db.prepare(`INSERT INTO verified_contracts (id, module, name, test_file, test_name, status, mapping_status)
                VALUES (?, 'pagos', ?, 'test/a.test.cjs', ?, 'verified', 'RESOLVED')`).run('P-' + nombre, nombre, nombre);
  }
  const r = cg.runPreservationGate(db, dir, 'c1', []);
  assert.equal(r.status, 'FAIL', JSON.stringify({ reason: r.reason_code, skipped: r.skipped_reason, unverified: r.unverified }));
  assert.deepEqual(r.violations.map((v) => v.test), ['dos']);
  db.close();
});

test('sin Git utilizable la huella del sujeto sale del contenido: cambia con el código, no con el estado del motor', () => {
  const dir = temporal();
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'module.exports = 1;\n');
  const h1 = tdd.subjectHash(dir);
  assert.strictEqual(tdd.subjectHash(dir), h1, 'estable sin cambios');
  fs.mkdirSync(path.join(dir, '_output'));
  fs.writeFileSync(path.join(dir, '_output', 'log.js'), 'x');
  fs.mkdirSync(path.join(dir, '.agentic', '_cache'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.agentic', '_tdd_state.json'), '{}');
  assert.strictEqual(tdd.subjectHash(dir), h1, 'logs y estado del motor no son el sujeto');
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'module.exports = 2;\n');
  assert.notStrictEqual(tdd.subjectHash(dir), h1, 'cambiar el código cambia el sujeto');
});
test('node --test: cuenta el resumen final, no el parcial que imprime un archivo con runner propio', () => {
  const salida = '✔ a (1ms)\nℹ tests 16\nℹ pass 16\nℹ fail 0\n✔ b (1ms)\nℹ tests 304\nℹ pass 302\nℹ fail 2\n';
  const r = tdd.parseTestOutput(salida, 1, SUJETO);
  assert.strictEqual(r.total, 304);
  assert.strictEqual(r.failed, 2);
  assert.notStrictEqual(r.status, 'PASS');
});