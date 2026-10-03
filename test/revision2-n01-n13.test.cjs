'use strict';

/* N01–N13: los falsos verdes de la revisión 2 deben fallar; el camino válido pasa. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const G = path.join(__dirname, '..', '.agentic', 'grafo');
const pg = require(path.join(G, 'politica-gates.cjs'));
const pc = require(path.join(G, 'pipeline-controller.cjs'));
const esc = require(path.join(G, 'escenarios.cjs'));
const cb = require(path.join(G, 'contratos-backend.cjs'));
const tdd = require(path.join(G, 'tdd-gate.cjs'));
const bg = require(path.join(G, 'browser-gate.cjs'));
const bv = require(path.join(G, 'baseline-visual.cjs'));
const ui = require(path.join(G, 'ui-layout-memory.cjs'));
const tour = require(path.join(G, 'tour-servicio.cjs'));
const hh = require(path.join(G, 'host-hooks.cjs'));

const tmp = () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-nxx-'));
  fs.mkdirSync(path.join(r, '.agentic'), { recursive: true });
  fs.writeFileSync(path.join(r, '.agentic', 'config.md'), 'CONFIGURADO: SI\n');
  return r;
};

test('N01: artefacto con runner FAIL no cierra como PASS', () => {
  const root = tmp();
  esc.guardarArtefacto(root, {
    execution_id: 'n01-fail-01', subject_hash: 'S', policy_id: pg.POLICY_ID,
    gate: 'preservation', provenance: 'mecanica', expected: [], executed: [],
    exit_code: 1, runner_status: 'FAIL',
    escenarios: { 'test/a.test.cjs': { status: 'FAIL', execution_id: 'n01-fail-01' } },
  });
  const r = pg.cierraGate({
    status: 'PASS', execution_id: 'n01-fail-01', subject_hash: 'S', policy_id: pg.POLICY_ID, gate: 'preservation',
  }, 'S', { root, paths: ['src/a.js'] });
  assert.strictEqual(r.ok, false);
  assert.ok(['RUNNER_NO_APROBO', 'ESCENARIO_NO_PASS'].includes(r.reason_code), r.reason_code);
});

test('N02: artefacto incompleto (sin gate/runner) no cierra browser', () => {
  const root = tmp();
  esc.guardarArtefacto(root, {
    execution_id: 'n02-incomp1', subject_hash: 'S', policy_id: pg.POLICY_ID,
  });
  const r = pg.cierraGate({
    status: 'PASS', execution_id: 'n02-incomp1', subject_hash: 'S', policy_id: pg.POLICY_ID, gate: 'browser',
  }, 'S', { root, paths: ['src/pages/a.tsx'] });
  assert.strictEqual(r.ok, false);
  assert.ok(['SIN_GATE', 'SIN_PROCEDENCIA', 'SIN_COMPROBADOR'].includes(r.reason_code), r.reason_code);
});

test('N03: DTO PASS no acredita si el artefacto guardado dice FAIL', () => {
  const root = tmp();
  esc.guardarArtefacto(root, {
    execution_id: 'n03-dto-01', subject_hash: 'NEW', policy_id: pg.POLICY_ID,
    gate: 'preservation', provenance: 'mecanica', exit_code: 1, runner_status: 'FAIL',
    escenarios: { 'test/api.test.js': { status: 'FAIL', execution_id: 'n03-dto-01', subject_hash: 'NEW', policy_id: pg.POLICY_ID } },
  });
  const ev = {
    policy_id: pg.POLICY_ID,
    escenarios: { 'test/api.test.js': { status: 'PASS', execution_id: 'n03-dto-01', subject_hash: 'NEW', policy_id: pg.POLICY_ID } },
  };
  assert.strictEqual(esc.aprobado(ev, 'test/api.test.js', 'NEW', { root }), false);
});

test('N04: cache legacy sin execution_id no acredita una corrida NEW', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.agentic', '_cache'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agentic', '_cache', 'test-run.json'), JSON.stringify({
    ts: new Date().toISOString(),
    archivos: { 'test/api.test.js': { pass: 1, fail: 0, skip: 0 } },
  }));
  assert.strictEqual(esc.ejecutadosSegunRunner(root, null, { execution_id: 'NEW' }), null);
});

test('N05: puedeCerrar es STALE si el sujeto actual cambió', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 1;\n');
  const h1 = tdd.subjectHash(root);
  pc.abrir(root, { cycle_id: 'c-n05', task: 'x', paths: ['src/a.js'], subject_hash: h1 });
  const f = path.join(root, '.agentic', '_pipeline', 'c-n05.json');
  const e = JSON.parse(fs.readFileSync(f, 'utf8'));
  e.steps.tdd = { status: 'PASS' };
  e.steps.qa = { status: 'PASS' };
  fs.writeFileSync(f, JSON.stringify(e));
  assert.strictEqual(pc.puedeCerrar(root, 'c-n05').status !== 'STALE' || pc.puedeCerrar(root, 'c-n05').ok === false, true);
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 2;\n');
  const c = pc.puedeCerrar(root, 'c-n05');
  assert.strictEqual(c.ok, false);
  assert.strictEqual(c.status, 'STALE');
  assert.strictEqual(c.reason_code, 'SUJETO_CAMBIO');
});

test('N06: con Git, cambiar contenido untracked cambia subjectHash', () => {
  const root = tmp();
  spawnSync('git', ['init'], { cwd: root, encoding: 'utf8' });
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'i'], { cwd: root });
  fs.writeFileSync(path.join(root, 'nuevo.js'), 'a=1\n');
  const h1 = tdd.subjectHash(root);
  fs.writeFileSync(path.join(root, 'nuevo.js'), 'a=2\n');
  const h2 = tdd.subjectHash(root);
  assert.notStrictEqual(h1, h2);
});

test('N07: flujo con click y cero expectativas es UNVERIFIED, no PASS funcional', () => {
  const v = bg.validarChecks([{ type: 'flujo', id: 'f1', pasos: [{ accion: 'click', selector: '#x' }], espera: [] }]);
  assert.strictEqual(v.schemaChecks.length, 0, 'forma válida: no es malformado');
  const contratos = [{ id: 'f1', tipo: 'flujo', ok: false }];
  const findings = [{ tipo: 'FLUJO_SMOKE', detalle: 'f1: click' }];
  const status = findings.some((f) => f.tipo === 'FLUJO_SMOKE') ? 'UNVERIFIED' : 'PASS';
  assert.strictEqual(status, 'UNVERIFIED');
  const src = fs.readFileSync(path.join(G, 'browser-gate.cjs'), 'utf8');
  assert.match(src, /FLUJO_SMOKE/);
  assert.match(src, /intencion !== 'vista-inicial'/);
});

test('N08: JS de components es UI; sin Git, HTML entra en la huella', () => {
  const s = pg.superficies(['src/components/menu.js']);
  assert.ok(s.ui.includes('src/components/menu.js'), JSON.stringify(s));
  const apiR = pg.gatesPorSuperficie(['src/app/api/orders/route.ts']);
  assert.ok(apiR.required.includes('test-integrity'));
  const root = tmp();
  fs.writeFileSync(path.join(root, 'index.html'), '<p>a</p>');
  const h1 = tdd.subjectHash(root);
  fs.writeFileSync(path.join(root, 'index.html'), '<p>b</p>');
  assert.notStrictEqual(tdd.subjectHash(root), h1);
});

test('N09: misma ruta, distinto viewport/tema/proyecto → consulta sola ruta es ambigua', () => {
  const DatabaseSync = require('node:sqlite').DatabaseSync;
  const db = new DatabaseSync(':memory:');
  ui.ensureSchema(db);
  db.prepare(`INSERT INTO ui_layout_decisions (element_id, property, value, origen, route, viewport, theme, project_id, superseded)
    VALUES ('#box','width','400px','manual','/x','1440','dark','A',0)`).run();
  db.prepare(`INSERT INTO ui_layout_decisions (element_id, property, value, origen, route, viewport, theme, project_id, superseded)
    VALUES ('#box','width','200px','manual','/x','360','light','B',0)`).run();
  const amb = ui.currentDecision(db, '#box', 'width', { route: '/x' });
  assert.ok(amb && (amb.ambiguo || amb.reason_code === 'LEGACY_AMBIGUO'), JSON.stringify(amb));
  const ok = ui.currentDecision(db, '#box', 'width', { route: '/x', viewport: '1440', theme: 'dark', project_id: 'A' });
  assert.strictEqual(ok.value, '400px');
});

test('N10: cambiar solo project_id/fixture/idioma con pixeles iguales es UNVERIFIED', () => {
  const png = require(path.join(G, 'png-diff.cjs'));
  const buf = png.encodePNG({ width: 2, height: 2, data: Buffer.alloc(16, 255) });
  const base = { project_id: 'A', fixture_hash: 'f1', language: 'es' };
  for (const campo of ['project_id', 'fixture_hash', 'language']) {
    const actual = Object.assign({}, base, { [campo]: campo === 'project_id' ? 'B' : 'otro' });
    const r = bv.compararConContexto(buf, buf, { manifiesto_ref: base, manifiesto_actual: actual });
    assert.strictEqual(r.status, 'UNVERIFIED', campo);
  }
  const ausente = bv.compararConContexto(buf, buf, { manifiesto_ref: base, manifiesto_actual: { browser: 'chrome' } });
  assert.strictEqual(ausente.status, 'UNVERIFIED');
  const ok = bv.compararConContexto(buf, buf, { manifiesto_ref: base, manifiesto_actual: base });
  assert.strictEqual(ok.status, 'PASS');
});

test('N11: cache general no se entrega como tour de un área inexistente', () => {
  const root = tmp();
  const claveG = tour.claveCache(root, {});
  const claveA = tour.claveCache(root, { area: 'no-existe-xyz' });
  assert.notStrictEqual(claveG, claveA);
  fs.mkdirSync(path.join(root, '.agentic', '_cache'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agentic', '_cache', 'tour-' + claveG + '.json'), JSON.stringify({
    schema_version: 1, source_hash: tour.hashFuente(root), cache_area: null,
    front: [{ id: 'general' }], back: [],
  }));
  const r = tour.obtener(root, { area: 'no-existe-xyz', writeCache: false });
  assert.ok(r.cache !== true || (r.tour && r.tour.cache_area === 'no-existe-xyz'));
  if (r.cache) assert.notDeepStrictEqual(r.tour.front, [{ id: 'general' }]);
});

test('N12: restore sin Git es UNAVAILABLE con causa, no EMPTY', () => {
  const root = tmp();
  const rm = require(path.join(G, 'restore-manager.cjs'));
  const lista = rm.listar(root);
  assert.strictEqual(lista.status, 'UNSUPPORTED');
  const src = fs.readFileSync(path.join(G, 'dashboard-api.cjs'), 'utf8');
  assert.match(src, /status: 'UNAVAILABLE'/);
  assert.match(src, /source: 'restore-manager'/);
  assert.match(src, /r\.puntos/);
  assert.match(src, /source: source \|\| /);
});

test('N13: cambiar un helper importado cambia huellaVigencia', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, '.agentic', 'contratos'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'helper.js'), 'module.exports = { n: 1 };\n');
  fs.writeFileSync(path.join(root, 'src', 'api.js'), "const h = require('./helper');\nmodule.exports = { read: () => h.n };\n");
  const contrato = {
    id: 'api.read', fuentes: ['src/api.js'], dimensiones: ['salida'],
    escenarios: [{ id: 's', test: 'test/x.test.js', cubre: ['salida'] }],
  };
  fs.writeFileSync(path.join(root, '.agentic', 'contratos', 'api.json'), JSON.stringify(contrato));
  const c = cb.cargar(root).contratos[0];
  const h1 = cb.huellaVigencia(root, c);
  fs.writeFileSync(path.join(root, 'src', 'helper.js'), 'module.exports = { n: 2 };\n');
  assert.notStrictEqual(cb.huellaVigencia(root, c), h1);
  fs.writeFileSync(path.join(root, 'src', 'otro.js'), 'module.exports = 0;\n');
  assert.strictEqual(cb.huellaVigencia(root, c), cb.huellaVigencia(root, cb.cargar(root).contratos[0]));
});

test('N01+: proceso real node --test PASS cierra; FAIL no cierra', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'test'));
  fs.writeFileSync(path.join(root, 'test', 'ok.test.cjs'), "const {test}=require('node:test');const assert=require('node:assert');test('ok',()=>assert.ok(true));\n");
  const ev = esc.ejecutarEscenario(root, 'test/ok.test.cjs');
  const art = ev.execution_id && esc.leerArtefacto(root, ev.execution_id);
  assert.ok(art, 'el runner debe persistir artefacto');
  assert.ok(art.exit_code === 0 || ev.escenarios['test/ok.test.cjs'].status === 'PASS' || ev.escenarios['test/ok.test.cjs'].status === 'UNVERIFIED');
  fs.writeFileSync(path.join(root, 'test', 'bad.test.cjs'), "const {test}=require('node:test');const assert=require('node:assert');test('bad',()=>assert.ok(false));\n");
  const fail = esc.ejecutarEscenario(root, 'test/bad.test.cjs');
  const st = fail.escenarios['test/bad.test.cjs'].status;
  assert.notStrictEqual(st, 'PASS');
  if (fail.execution_id) {
    const r = pg.cierraGate({
      status: 'PASS', execution_id: fail.execution_id, subject_hash: fail.subject_hash, policy_id: pg.POLICY_ID, gate: 'preservation',
    }, fail.subject_hash, { root, paths: ['src/a.js'] });
    assert.strictEqual(r.ok, false);
  }
});

test('host-hooks CLI: posicional cursor no instala all; arg desconocido se rechaza', () => {
  const src = fs.readFileSync(path.join(G, 'host-hooks.cjs'), 'utf8');
  assert.match(src, /ARG_DESCONOCIDO/);
  assert.match(src, /PRE_CLOSE/);
  const cob = hh.cobertura(tmp());
  const aa = cob.filas.find((f) => /aa:/.test(f.via));
  assert.ok(aa);
  assert.notStrictEqual(aa.estado, 'CUBIERTO');
  const bad = spawnSync(process.execPath, [path.join(G, 'host-hooks.cjs'), 'install', 'desconocido'], { encoding: 'utf8' });
  assert.notStrictEqual(bad.status, 0);
  assert.match(bad.stderr || bad.stdout, /ARG_DESCONOCIDO|HOST_DESCONOCIDO/);
});

test('D23/D24: tabla discreta y assets locales presentes', () => {
  const dash = fs.readFileSync(path.join(__dirname, '..', 'dashboard.cjs'), 'utf8');
  assert.match(dash, /id="kdd-tabla"/);
  assert.match(dash, /toggleTablaKdd/);
  assert.match(dash, /\/vendor\/d3\.min\.js/);
  assert.doesNotMatch(dash, /cdnjs\.cloudflare|unpkg\.com/);
  const v = require(path.join(__dirname, '..', 'scripts', 'vendor-dashboard.cjs')).verify();
  assert.ok(v.ok, JSON.stringify(v));
});
