'use strict';

// P01 · P03 · P04 · P05 · P06 · P13 — preservación por escenario con evidencia
// de un proceso real, sobre fixtures aislados (nunca la memoria del repo).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const tdd = require('../.agentic/grafo/tdd-gate.cjs');
const esc = require('../.agentic/grafo/escenarios.cjs');
const rg = require('../.agentic/grafo/regression-guard.cjs');
const dbAccess = require('../.agentic/grafo/db-adapter.cjs');

delete process.env.NODE_TEST_CONTEXT;

const SUJETO = 'sujeto-A';
const temporal = () => fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-pres-'));

function corrida(raw, exit, meta = {}) {
  return tdd.parseTestOutput(raw, exit, Object.assign({ subject_hash: SUJETO, execution_id: crypto.randomUUID() }, meta));
}

function proyecto() {
  const root = temporal();
  fs.mkdirSync(path.join(root, '.agentic'), { recursive: true });
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(root, 'test', 'a.test.cjs'), "require('../src/a.js');\n");
  fs.writeFileSync(path.join(root, 'test', 'b.test.cjs'), "require('../src/a.js');\n");
  const dbPath = path.join(root, '.agentic', 'memoria.db');
  const db = dbAccess.openWrite(dbPath);
  rg.ensureSchema(db);
  return { root, db, dbPath };
}

const fila = (db, id) => db.prepare('SELECT * FROM protected_behaviors WHERE id = ?').get(id);
const pasa = (root, archivos, sujeto = SUJETO) =>
  esc.evidenciaDeCorrida(root, corrida('# tests 3\n# pass 3\n# fail 0\n', 0, { subject_hash: sujeto }), archivos, { explicito: archivos.length === 1 });

// ── P01: ningún PASS vacío ──────────────────────────────────────────────────

test('P01: vacío, exit 1 con "10 passed", señal, timeout, sin runner y cero tests nunca son PASS', () => {
  const root = temporal();
  const casos = {
    vacio: corrida('', 0),
    exit1: corrida('10 passed in 0.3s', 1),
    senal: corrida('# pass 3', null, { signal: 'SIGKILL' }),
    timeout: corrida('# pass 3', 0, { timedOut: true }),
    sinRunner: corrida('', null, { spawnError: 'ENOENT' }),
    ceroTests: corrida('# tests 0\n# pass 0\n# fail 0\n', 0),
  };
  for (const [nombre, r] of Object.entries(casos)) {
    const ev = esc.evidenciaDeCorrida(root, r, ['test/a.test.cjs'], { explicito: true });
    const e = ev.escenarios['test/a.test.cjs'];
    assert.notEqual(e.status, 'PASS', nombre);
    assert.equal(esc.aprobado(ev, 'test/a.test.cjs', SUJETO), false, nombre);
  }
});

test('P01: si solo corrió otro test, el escenario pedido no queda aprobado', () => {
  const root = temporal();
  const r = corrida('ok 1 - test/b.test.cjs\n# tests 1\n# pass 1\n# fail 0\n', 0);
  const ev = esc.evidenciaDeCorrida(root, r, ['test/a.test.cjs', 'test/b.test.cjs']);
  assert.equal(ev.escenarios['test/a.test.cjs'].status, 'UNVERIFIED');
  assert.equal(ev.escenarios['test/a.test.cjs'].reason_code, 'EJECUCION_NO_DEMOSTRADA');
  assert.equal(ev.escenarios['test/b.test.cjs'].status, 'PASS');

  fs.mkdirSync(path.join(root, '.agentic', '_cache'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agentic', '_cache', 'test-run.json'), JSON.stringify({
    execution_id: r.gate.execution_id, subject_hash: SUJETO,
    ts: new Date(Date.now() + 1000).toISOString(), archivos: { 'test/b.test.cjs': { pass: 1, fail: 0, skip: 0 } },
  }));
  const ev2 = esc.evidenciaDeCorrida(root, r, ['test/a.test.cjs', 'test/b.test.cjs']);
  assert.equal(ev2.escenarios['test/a.test.cjs'].reason_code, 'NO_EJECUTADO');
  assert.equal(ev2.escenarios['test/b.test.cjs'].descubrimiento, 'runner');
});

test('P01: un archivo con solo tests omitidos no aprueba', () => {
  const root = temporal();
  fs.mkdirSync(path.join(root, '.agentic', '_cache'), { recursive: true });
  const rSkip = corrida('# tests 3\n# pass 1\n# skipped 2\n', 0);
  fs.writeFileSync(path.join(root, '.agentic', '_cache', 'test-run.json'), JSON.stringify({
    execution_id: rSkip.gate.execution_id, subject_hash: SUJETO,
    ts: new Date(Date.now() + 1000).toISOString(), archivos: { 'test/a.test.cjs': { pass: 0, fail: 0, skip: 2 }, 'test/b.test.cjs': { pass: 1, fail: 0, skip: 0 } },
  }));
  const ev = esc.evidenciaDeCorrida(root, rSkip, ['test/a.test.cjs']);
  assert.equal(ev.escenarios['test/a.test.cjs'].status, 'SKIP');
});

test('P01: verifyAfterTDD sin evidencia estructurada, o de otro sujeto, no toca last_verified_at', () => {
  const { root, db } = proyecto();
  const reg = rg.registerBehavior(db, { module: 'm', files: ['src/a.js'], testFiles: ['test/a.test.cjs'], projectRoot: root });
  assert.equal(reg.status, 'candidate');
  db.prepare("UPDATE protected_behaviors SET status = 'active', last_verified_at = '2000-01-01 00:00:00' WHERE id = ?").run(reg.id);

  const texto = rg.verifyAfterTDD(db, '10 passed', ['src/a.js'], root);
  assert.equal(texto.status, 'UNVERIFIED');
  assert.equal(texto.passed, false);

  const otro = rg.verifyAfterTDD(db, pasa(root, ['test/a.test.cjs'], 'sujeto-viejo'), ['src/a.js'], root, { subject_hash: SUJETO });
  assert.equal(otro.status, 'UNVERIFIED');
  assert.equal(fila(db, reg.id).last_verified_at, '2000-01-01 00:00:00');

  const vacia = rg.verifyAfterTDD(db, esc.evidenciaDeCorrida(root, corrida('', 0), ['test/a.test.cjs'], { explicito: true }), ['src/a.js'], root);
  assert.equal(vacia.status, 'UNVERIFIED');
  assert.equal(fila(db, reg.id).last_verified_at, '2000-01-01 00:00:00');
  assert.equal(fila(db, reg.id).pass_count, 0);

  const ok = rg.verifyAfterTDD(db, pasa(root, ['test/a.test.cjs']), ['src/a.js'], root, { subject_hash: SUJETO });
  assert.equal(ok.status, 'PASS');
  assert.notEqual(fila(db, reg.id).last_verified_at, '2000-01-01 00:00:00');
  assert.equal(fila(db, reg.id).pass_count, 1);
  db.close();
});

test('P01: un FAIL atribuible marca el escenario violado con su ejecución', () => {
  const { root, db } = proyecto();
  const ev = pasa(root, ['test/a.test.cjs']);
  const reg = rg.registerBehavior(db, { module: 'm', files: ['src/a.js'], testFiles: ['test/a.test.cjs'], evidencia: ev, projectRoot: root });
  assert.equal(reg.status, 'active');
  const falla = esc.evidenciaDeCorrida(root, corrida('# tests 1\n# pass 0\n# fail 1\n', 1), ['test/a.test.cjs'], { explicito: true });
  const v = rg.verifyAfterTDD(db, falla, ['src/a.js'], root);
  assert.equal(v.status, 'FAIL');
  assert.equal(fila(db, reg.id).status, 'violated');
  db.close();
});

// ── P03: registro acumulativo por escenario ─────────────────────────────────

test('P03: dos ciclos del mismo módulo conservan dos escenarios y todos sus archivos', () => {
  const { root, db } = proyecto();
  const quince = Array.from({ length: 15 }, (_, i) => `src/f${i}.js`);
  const r1 = rg.registerBehavior(db, { module: 'm', files: quince, testFiles: ['test/a.test.cjs'], projectRoot: root });
  const r2 = rg.registerBehavior(db, { module: 'm', files: ['src/otro.js'], testFiles: ['test/b.test.cjs'], projectRoot: root });
  assert.notEqual(r1.id, r2.id);
  const a = JSON.parse(fila(db, r1.id).related_files);
  assert.equal(quince.every((f) => a.includes(f)), true, 'los 15 archivos siguen');
  rg.registerBehavior(db, { module: 'm', files: ['src/nuevo.js'], testFiles: ['test/a.test.cjs'], projectRoot: root });
  const a2 = JSON.parse(fila(db, r1.id).related_files);
  assert.equal(a2.length, 17, 'se une, no se sustituye: 15 + a.js inferido + nuevo.js');
  db.close();
});

test('P03: 80 anclas previas no se recortan al volver a registrar', () => {
  const { root, db } = proyecto();
  const r = rg.registerBehavior(db, { module: 'm', files: ['src/a.js'], testFiles: ['test/a.test.cjs'], projectRoot: root });
  const anclas = Array.from({ length: 80 }, (_, i) => ({ file: 'src/a.js', symbol_name: 's' + i, kind: 'function' }));
  db.prepare('UPDATE protected_behaviors SET protected_symbols = ? WHERE id = ?').run(JSON.stringify(anclas), r.id);
  rg.registerBehavior(db, { module: 'm', files: ['src/a.js'], testFiles: ['test/a.test.cjs'], projectRoot: root });
  assert.equal(JSON.parse(fila(db, r.id).protected_symbols).length, 80);
  db.close();
});

test('P03: renombrar no pierde la protección; retirar sin decisión se rechaza', () => {
  const { root, db } = proyecto();
  const r = rg.registerBehavior(db, { module: 'm', files: ['src/a.js'], testFiles: ['test/a.test.cjs'], projectRoot: root });
  db.prepare("UPDATE protected_behaviors SET status = 'active' WHERE id = ?").run(r.id);
  assert.equal(rg.renombrar(db, 'src/a.js', 'src/alfa.js', { motivo: 'renombre' }).movidos, 1);
  assert.equal(rg.seleccionarBehaviors(db, ['src/alfa.js'], root).behaviors.some((b) => b.id === r.id), true);

  assert.equal(rg.deprecateBehavior(db, r.id).reason_code, 'SIN_DECISION');
  assert.equal(rg.deprecateBehavior(db, r.id, { motivo: 'flujo eliminado' }).reason_code, 'SIN_DECISION');
  assert.equal(fila(db, r.id).status, 'active');
  assert.equal(rg.deprecateBehavior(db, r.id, { motivo: 'flujo eliminado', aprobador: 'dev' }).ok, true);
  assert.equal(fila(db, r.id).status, 'retired');
  const t = db.prepare("SELECT detalle FROM gate_events WHERE gate = 'preservation-transition' AND behavior_id = ? AND verdict = 'RETIRED'").get(r.id);
  assert.equal(JSON.parse(t.detalle).aprobador, 'dev');
  db.close();
});

// ── P04: selección por segmentos, extensiones y dependencias ────────────────

test('P04: segmentos, no subcadenas', () => {
  assert.equal(rg.cubre('src/auth.js', 'src/oauth-helper.js'), false);
  assert.equal(rg.cubre('auth', 'src/oauth-helper.js'), false);
  assert.equal(rg.cubre('src/ui/', 'src/ui/estilos.css'), true);
  assert.equal(rg.cubre('src/ui', 'src/uix/a.css'), false);
  assert.equal(rg.cubre('billing.test.js', 'test/billing.test.js'), true);
  if (process.platform === 'win32') assert.equal(rg.cubre('src/Auth.ts', 'SRC\\auth.ts'), true);
});

test('P04: CSS, HTML, SQL y config entran como archivos protegidos', () => {
  const { root, db } = proyecto();
  const r = rg.registerBehavior(db, { module: 'ui', files: ['src/estilos.css', 'src/vista.html', 'db/schema.sql', 'vite.config.ts', 'src/App.vue'], testFiles: ['test/a.test.cjs'], projectRoot: root });
  const rel = JSON.parse(fila(db, r.id).related_files);
  for (const f of ['src/estilos.css', 'src/vista.html', 'db/schema.sql', 'vite.config.ts', 'src/App.vue']) assert.ok(rel.includes(f), f);
  db.close();
});

test('P04: cambiar un archivo importado alcanza al escenario que protege a quien lo importa', () => {
  const { root, db } = proyecto();
  db.exec('CREATE TABLE ast_edges (from_file TEXT, to_file TEXT, kind TEXT)');
  db.exec('CREATE TABLE ast_symbols (file TEXT, symbol_name TEXT, kind TEXT, line_start INTEGER, line_end INTEGER, content_hash TEXT, signature TEXT)');
  db.prepare("INSERT INTO ast_edges VALUES ('src/page.js', 'src/util.js', 'IMPORTS')").run();
  db.prepare("INSERT INTO ast_symbols (file, symbol_name, kind, content_hash) VALUES ('src/util.js', 'u', 'function', 'h'), ('src/page.js', 'p', 'function', 'h')").run();
  const r = rg.registerBehavior(db, { module: 'p', files: ['src/page.js'], testFiles: ['test/b.test.cjs'], projectRoot: root });
  const sel = rg.seleccionarBehaviors(db, ['src/util.js'], root);
  const hit = sel.behaviors.find((b) => b.id === r.id);
  assert.ok(hit, 'el escenario de page.js queda seleccionado');
  assert.equal(hit._via.archivo, 'src/page.js');
  assert.equal(sel.parcial, null);
  db.close();
});

test('P04: sin índice AST la selección se declara parcial, no "nada afectado"', () => {
  const { root, db } = proyecto();
  const c = rg.checkBeforeBuild(db, ['src/zeta.js'], root);
  assert.equal(c.status, 'UNVERIFIED');
  assert.equal(c.reason_code, 'SIN_INDICE_AST');
  db.close();
});

// ── P05: promoción por ejecuciones distintas, recuperación con prueba ───────

test('P05: un replay de la misma ejecución no promueve; HIGH exige 5 ejecuciones en 2 sujetos', () => {
  const { root, db } = proyecto();
  const ev = pasa(root, ['test/a.test.cjs']);
  const r = rg.registerBehavior(db, { module: 'm', files: ['src/a.js'], testFiles: ['test/a.test.cjs'], evidencia: ev, projectRoot: root });
  for (let i = 0; i < 6; i++) rg.registerBehavior(db, { module: 'm', files: ['src/a.js'], testFiles: ['test/a.test.cjs'], evidencia: ev, projectRoot: root });
  assert.equal(fila(db, r.id).pass_count, 1, 'misma execution_id cuenta una vez');

  for (let i = 0; i < 5; i++) rg.registerBehavior(db, { module: 'm', files: ['src/a.js'], testFiles: ['test/a.test.cjs'], evidencia: pasa(root, ['test/a.test.cjs']), projectRoot: root });
  assert.equal(fila(db, r.id).pass_count, 6);
  assert.equal(fila(db, r.id).confidence, 'MEDIA', 'seis corridas sobre el mismo código no son estabilidad');

  rg.registerBehavior(db, { module: 'm', files: ['src/a.js'], testFiles: ['test/a.test.cjs'], evidencia: pasa(root, ['test/a.test.cjs'], 'sujeto-B'), projectRoot: root });
  assert.equal(fila(db, r.id).confidence, 'HIGH');
  const t = db.prepare("SELECT detalle FROM gate_events WHERE gate = 'preservation-transition' AND verdict = 'PROTECTED' AND behavior_id = ?").get(r.id);
  assert.deepEqual(JSON.parse(t.detalle).criterio, rg.CRITERIO_PROTEGIDO);
  db.close();
});

test('P05: el PASS de un módulo no certifica otro escenario', () => {
  const { root, db } = proyecto();
  const evA = pasa(root, ['test/a.test.cjs']);
  rg.registerBehavior(db, { module: 'm', files: ['src/a.js'], testFiles: ['test/a.test.cjs'], evidencia: evA, projectRoot: root });
  const rb = rg.registerBehavior(db, { module: 'm', files: ['src/a.js'], testFiles: ['test/b.test.cjs'], evidencia: evA, projectRoot: root });
  assert.equal(rb.status, 'candidate');
  assert.equal(rb.pass_count, 0);
  db.close();
});

test('P05: fixViolation no reactiva sin volver a correr el escenario en PASS', () => {
  const { root, db } = proyecto();
  const r = rg.registerBehavior(db, { module: 'm', files: ['src/a.js'], testFiles: ['test/a.test.cjs'], evidencia: pasa(root, ['test/a.test.cjs']), projectRoot: root });
  db.prepare("UPDATE protected_behaviors SET status = 'violated' WHERE id = ?").run(r.id);
  const no = rg.fixViolation(db, r.id, { ejecutar: () => ({ status: 'UNVERIFIED', reason_code: 'ZERO_TESTS' }) });
  assert.equal(no.ok, false);
  assert.equal(fila(db, r.id).status, 'violated');
  const ev = pasa(root, ['test/a.test.cjs']);
  const si = rg.fixViolation(db, r.id, { ejecutar: () => ({ status: 'PASS', archivo: 'test/a.test.cjs', evidencia: ev }) });
  assert.equal(si.ok, true);
  assert.equal(fila(db, r.id).status, 'active');
  db.close();
});

test('P05: un cambio intencional exige delta, alcance, aprobador y pruebas preservadas', () => {
  const { root, db } = proyecto();
  const r = rg.registerBehavior(db, { module: 'm', files: ['src/a.js'], testFiles: ['test/a.test.cjs'], evidencia: pasa(root, ['test/a.test.cjs']), projectRoot: root });
  assert.equal(rg.cambioIntencional(db, r.id, { delta: 'nuevo campo' }).reason_code, 'CAMBIO_INCOMPLETO');
  assert.equal(rg.cambioIntencional(db, r.id, { delta: 'nuevo campo', alcance: 'src/a.js', aprobador: 'dev', preservadas: ['test/a.test.cjs'] }).ok, true);
  assert.equal(fila(db, r.id).status, 'stale');
  rg.registerBehavior(db, { module: 'm', files: ['src/a.js'], testFiles: ['test/a.test.cjs'], evidencia: pasa(root, ['test/a.test.cjs']), projectRoot: root });
  assert.equal(fila(db, r.id).status, 'active', 'vuelve a verificado solo con un PASS nuevo');
  db.close();
});

test('P05: un escenario HIGH sin poder ejecutarse frena el build (fail-closed)', () => {
  const { root, db } = proyecto();
  const r = rg.registerBehavior(db, { module: 'm', files: ['src/a.js'], testFiles: ['test/no-existe.test.cjs'], projectRoot: root });
  db.prepare("UPDATE protected_behaviors SET status = 'active', confidence = 'HIGH' WHERE id = ?").run(r.id);
  const c = rg.checkBeforeBuild(db, ['src/a.js'], root);
  assert.equal(c.passed, false);
  assert.equal(c.status, 'UNVERIFIED');
  assert.equal(c.violations[0].reason_code, 'ESCENARIO_NO_EXISTE');
  db.close();
});

// ── P06: leer no migra ──────────────────────────────────────────────────────

test('P06: leer una base sin tablas no crea nada y no se reporta como sana', () => {
  const root = temporal();
  fs.mkdirSync(path.join(root, '.agentic'));
  const dbPath = path.join(root, '.agentic', 'memoria.db');
  const w = dbAccess.openWrite(dbPath); w.exec('CREATE TABLE otra (x INTEGER)'); w.close();
  const antes = fs.readFileSync(dbPath);
  const db = dbAccess.openReadOnly(dbPath);
  try {
    assert.equal(rg.checkBeforeBuild(db, ['src/a.js'], root).reason_code, 'SIN_TABLAS');
    assert.equal(rg.verifyAfterTDD(db, pasa(root, ['test/a.test.cjs']), ['src/a.js'], root).status, 'UNVERIFIED');
    assert.match(rg.regressionStatus(db), /NO VERIFICADO/);
    const tablas = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
    assert.deepEqual(tablas, ['otra']);
  } finally { db.close(); }
  assert.equal(Buffer.compare(antes, fs.readFileSync(dbPath)), 0, 'archivo intacto');
});

test('P06: la CLI de estado abre en solo lectura y no crea tablas', () => {
  const root = temporal();
  fs.mkdirSync(path.join(root, '.agentic'));
  const dbPath = path.join(root, '.agentic', 'memoria.db');
  const w = dbAccess.openWrite(dbPath); w.exec('CREATE TABLE otra (x INTEGER)'); w.close();
  const cli = path.join(__dirname, '..', '.agentic', 'grafo', 'regression-guard.cjs');
  const r = require('child_process').spawnSync(process.execPath, [cli, 'status'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /NO VERIFICADO/);
  const db = dbAccess.openReadOnly(dbPath);
  try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'protected_behaviors'").get().n, 0); }
  finally { db.close(); }
});

// ── P13: argv preservado, rechazo en vez de "limpieza" ──────────────────────

test('P13: un argumento con caracteres de shell o que empieza por "-" se rechaza, no se limpia', () => {
  const root = temporal();
  for (const malo of ['a.test.js & echo pwned', '--watch', 'x|y.test.js', 'a$(b).test.js']) {
    const r = tdd.runTests('node --test', root, [malo], { subject_hash: SUJETO });
    assert.equal(r.status, 'ERROR', malo);
    assert.equal(r.reason_code, 'SPAWN_FAILED', malo);
  }
});

test('P13: pytest recibe el archivo pedido y corre desde backend/ cuando corresponde', () => {
  const root = temporal();
  fs.mkdirSync(path.join(root, 'backend'));
  fs.writeFileSync(path.join(root, 'backend', 'requirements.txt'), 'pytest\n');
  const d = rg.descriptorRunner(root);
  assert.equal(d.runner, 'pytest');
  assert.equal(d.cwd, path.join(root, 'backend'));
});

test('P13: un escenario con acentos y espacios corre con su ruta intacta y aprueba con evidencia', () => {
  const root = temporal();
  fs.mkdirSync(path.join(root, 'pruebas'));
  const archivo = 'pruebas/ñandú prueba.test.cjs';
  fs.writeFileSync(path.join(root, archivo), "require('node:test')('ok', () => {});\n");
  const ev = esc.ejecutarEscenario(root, archivo, { comando: 'node --test', subject_hash: SUJETO });
  const e = ev.escenarios[archivo];
  assert.equal(e.status, 'PASS', JSON.stringify(e));
  assert.equal(e.subject_hash, SUJETO);
  assert.ok(e.execution_id);

  fs.writeFileSync(path.join(root, archivo), "require('node:test')('mal', () => { throw new Error('x'); });\n");
  const ev2 = esc.ejecutarEscenario(root, archivo, { comando: 'node --test', subject_hash: SUJETO });
  assert.equal(ev2.escenarios[archivo].status, 'FAIL');
});
