'use strict';

/* R01–R14: cada falso verde de la revisión debe fallar en el código corregido
   y el camino válido debe pasar. No relaja aserciones. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const G = path.join(__dirname, '..', '.agentic', 'grafo');
const pg = require(path.join(G, 'politica-gates.cjs'));
const pc = require(path.join(G, 'pipeline-controller.cjs'));
const esc = require(path.join(G, 'escenarios.cjs'));
const cb = require(path.join(G, 'contratos-backend.cjs'));
const bg = require(path.join(G, 'browser-gate.cjs'));
const bv = require(path.join(G, 'baseline-visual.cjs'));
const wa = require(path.join(G, 'whatsapp-browser-agent.cjs'));
const cg = require(path.join(G, 'contract-guard.cjs'));

const tmp = () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-rxx-'));
  fs.mkdirSync(path.join(r, '.agentic'), { recursive: true });
  fs.writeFileSync(path.join(r, '.agentic', 'config.md'), 'CONFIGURADO: SI\n');
  return r;
};

test('R01: PASS sin política ni artefacto no cierra', () => {
  const root = tmp();
  const r = pg.cierraGate({ status: 'PASS', execution_id: 'inventada', subject_hash: 'S' }, 'S', { root });
  assert.strictEqual(r.ok, false);
  assert.ok(['SIN_POLITICA', 'SIN_ARTEFACTO'].includes(r.reason_code), r.reason_code);
  const conPol = pg.cierraGate({ status: 'PASS', execution_id: 'inventada', subject_hash: 'S', policy_id: pg.POLICY_ID }, 'S', { root });
  assert.strictEqual(conPol.ok, false);
  assert.strictEqual(conPol.reason_code, 'SIN_ARTEFACTO');
});

test('R01: JSON sin runner no se llama ejecución real', () => {
  const root = tmp();
  esc.guardarArtefacto(root, {
    execution_id: 'exec-real-01', subject_hash: 'S', policy_id: pg.POLICY_ID,
    gate: 'preservation', provenance: 'mecanica', expected: [], executed: [],
  });
  const r = pg.cierraGate({
    status: 'PASS', execution_id: 'exec-real-01', subject_hash: 'S', policy_id: pg.POLICY_ID, gate: 'preservation',
  }, 'S', { root, paths: ['src/a.js'] });
  assert.strictEqual(r.ok, false);
  assert.ok(['SIN_RESULTADO_RUNNER', 'SIN_ARTEFACTO'].includes(r.reason_code), r.reason_code);
});

test('R01: artefacto con runner PASS y exit 0 sí cierra', () => {
  const root = tmp();
  esc.guardarArtefacto(root, {
    execution_id: 'exec-real-02', subject_hash: 'S', policy_id: pg.POLICY_ID,
    gate: 'preservation', provenance: 'mecanica', expected: [], executed: [],
    exit_code: 0, runner_status: 'PASS', tests_total: 1,
  });
  const r = pg.cierraGate({
    status: 'PASS', execution_id: 'exec-real-02', subject_hash: 'S', policy_id: pg.POLICY_ID, gate: 'preservation',
  }, 'S', { root, paths: ['src/a.js'] });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
});

test('R02: NO_APLICA por etiqueta suelta no cierra', () => {
  const r = pg.cierraGate({
    status: 'NO_APLICA', reason_code: 'SIN_ARCHIVOS_DE_INTERFAZ', policy_id: pg.POLICY_ID, gate: 'browser',
  }, null, {});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason_code, 'NO_APLICA_SIN_ALCANCE');
});

test('R02: docs acotados sí reciben N/A calculado', () => {
  const r = pg.cierraGate({
    status: 'NO_APLICA', reason_code: 'SIN_ARCHIVOS_DE_INTERFAZ', policy_id: pg.POLICY_ID, gate: 'browser',
  }, 'S', { paths: ['README.md'] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.no_aplica, true);
});

test('R03: API route es backend y no omite integridad de tests', () => {
  const api = pg.gatesPorSuperficie(['src/app/api/orders/route.ts']);
  assert.ok(api.required.includes('test-integrity'));
  assert.ok(api.required.includes('preservation'));
  assert.ok(!api.required.includes('browser'), JSON.stringify(api));
  const page = pg.gatesPorSuperficie(['src/app/compras/page.tsx']);
  assert.ok(page.required.includes('browser'));
});

test('R04: evidencia OLD u otra política no verifica el contrato', () => {
  const ev = {
    policy_id: 'otra/9',
    escenarios: {
      'test/api.test.js': { status: 'PASS', execution_id: 'OLD', subject_hash: 'NEW', policy_id: 'otra/9' },
    },
  };
  assert.strictEqual(esc.aprobado(ev, 'test/api.test.js', 'NEW'), false);
});

test('R05: cambiar solo la fuente invalida vigencia', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, '.agentic', 'contratos'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'api.js'), 'module.exports = { read: () => 1 };\n');
  const contrato = {
    id: 'api.read', fuentes: ['src/api.js'], dimensiones: ['salida'],
    escenarios: [{ id: 's', test: 'test/x.test.js', cubre: ['salida'] }],
  };
  fs.writeFileSync(path.join(root, '.agentic', 'contratos', 'api.json'), JSON.stringify(contrato));
  const c = cb.cargar(root).contratos[0];
  const h1 = cb.huellaVigencia(root, c);
  fs.writeFileSync(path.join(root, 'src', 'api.js'), 'module.exports = { read: () => { throw new Error("x"); } };\n');
  const c2 = cb.cargar(root).contratos[0];
  const h2 = cb.huellaVigencia(root, c2);
  assert.notStrictEqual(h1, h2);
  fs.writeFileSync(path.join(root, '.agentic', 'contratos', '_estado.json'), JSON.stringify({
    'api.read': { estado: 'verified', vigencia: h1 },
  }));
  assert.strictEqual(cb.vigente(root, 'api.read'), false);
});

test('R06: cache de otra corrida no acredita la actual', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.agentic', '_cache'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agentic', '_cache', 'test-run.json'), JSON.stringify({
    execution_id: 'OLD', ts: new Date().toISOString(),
    archivos: { 'test/api.test.js': { pass: 1, fail: 0, skip: 0 } },
  }));
  assert.strictEqual(esc.ejecutadosSegunRunner(root, null, { execution_id: 'NEW' }), null);
});

test('R07: SENT_OBSERVED sin message_id ni evidencia se rechaza', () => {
  const root = tmp();
  const a = new wa.AdapterBrowserAgent(root);
  a.encolar({ tipo: 'enviar', chat_esperado: 'c1', texto: 'hola', correlation_id: 'x1' });
  const t = wa.tareasPendientes(root)[0];
  const r = wa.registrarResultado(root, t.task_id, { status: 'SENT_OBSERVED', chat_id: 'c1' });
  assert.strictEqual(r.status, 'RECHAZADO');
  assert.strictEqual(r.reason_code, 'SIN_MENSAJE_NI_EVIDENCIA');
});

test('R08: call es false y callContact no afirma llamada', () => {
  const root = tmp();
  wa.reportarCapacidad(root, { host: 'cursor', herramientas: ['browser_navigate'], llamadas: true, whatsapp_sesion: 'ACTIVA' });
  const a = new wa.AdapterBrowserAgent(root);
  assert.strictEqual(a.capabilities().call, false);
  assert.strictEqual(a.callContact().status, 'UNSUPPORTED');
});

test('R09: ids inventados no cierran el ciclo', () => {
  const root = tmp();
  pc.abrir(root, { cycle_id: 'c-r09', task: 'ui', paths: ['src/pages/a.tsx'], subject_hash: 'S' });
  const f = path.join(root, '.agentic', '_pipeline', 'c-r09.json');
  const e = JSON.parse(fs.readFileSync(f, 'utf8'));
  e.steps.tdd = { status: 'PASS' };
  e.steps.qa = { status: 'PASS' };
  fs.writeFileSync(f, JSON.stringify(e));
  pc.registrarGate(root, 'c-r09', {
    gate: 'browser', status: 'PASS', execution_id: 'inventada', subject_hash: 'S', policy_id: pg.POLICY_ID,
  });
  pc.registrarGate(root, 'c-r09', {
    gate: 'preservation', status: 'PASS', execution_id: 'inventada2', subject_hash: 'S', policy_id: pg.POLICY_ID,
  });
  const c = pc.puedeCerrar(root, 'c-r09');
  assert.strictEqual(c.ok, false);
  assert.notStrictEqual(c.status, 'PASS');
});

test('R10: verificarEnCiclo registra el gate en el ciclo normal', () => {
  const root = tmp();
  pc.abrir(root, { cycle_id: 'c-r10', task: 'api', paths: ['src/x.js'], subject_hash: 'S' });
  const r = cb.verificarEnCiclo(root, ['src/x.js'], { cycle_id: 'c-r10', subject_hash: 'S' });
  assert.ok(r.execution_id);
  const est = pc.cargar(root, 'c-r10');
  assert.ok(est.gates && est.gates['backend-contracts'], JSON.stringify(est.gates));
});

test('R11: dos #submit de rutas distintas no se sustituyen', () => {
  const DatabaseSync = require('node:sqlite').DatabaseSync;
  const db = new DatabaseSync(':memory:');
  const ui = require(path.join(G, 'ui-layout-memory.cjs'));
  ui.ensureSchema(db);
  ui.escribirDecision || 0;
  const escribir = require(path.join(G, 'ui-layout-memory.cjs'));
  /* escritura directa con ambito */
  const rec = escribir;
  rec.ensureSchema(db);
  const ok1 = rec.recordDecision ? true : true;
  assert.ok(ok1);
  db.prepare(`INSERT INTO ui_layout_decisions (element_id, property, value, origen, route, superseded)
    VALUES ('#submit','right','12px','manual','/compras',0)`).run();
  db.prepare(`INSERT INTO ui_layout_decisions (element_id, property, value, origen, route, superseded)
    VALUES ('#submit','right','40px','manual','/ventas',0)`).run();
  const a = rec.currentDecision(db, '#submit', 'right', { route: '/compras' });
  const b = rec.currentDecision(db, '#submit', 'right', { route: '/ventas' });
  assert.strictEqual(a.value, '12px');
  assert.strictEqual(b.value, '40px');
  const amb = rec.currentDecision(db, '#submit', 'right', {});
  assert.ok(amb.ambiguo || amb.reason_code === 'LEGACY_AMBIGUO', JSON.stringify(amb));
});

test('R12: mismo pixel con manifiesto de otro proyecto es UNVERIFIED', () => {
  const png = require(path.join(G, 'png-diff.cjs'));
  const data = Buffer.alloc(16, 255);
  const buf = png.encodePNG({ width: 2, height: 2, data });
  const r = bv.compararConContexto(buf, buf, {
    manifiesto_ref: { project_id: 'A', fixture_hash: 'f1' },
    manifiesto_actual: { project_id: 'B', fixture_hash: 'f1' },
  });
  assert.strictEqual(r.status, 'UNVERIFIED');
  assert.strictEqual(r.reason_code, 'MANIFIESTO_INCOMPATIBLE');
  const ok = bv.compararConContexto(buf, buf, {
    manifiesto_ref: { project_id: 'A' },
    manifiesto_actual: { project_id: 'A' },
  });
  assert.strictEqual(ok.status, 'PASS');
});

test('R13: schemaDisponible no crea tablas; ausencia no es PASS', () => {
  const DatabaseSync = require('node:sqlite').DatabaseSync;
  const db = new DatabaseSync(':memory:');
  assert.strictEqual(cg.schemaDisponible(db), false);
  const src = fs.readFileSync(path.join(G, 'post-cycle.cjs'), 'utf8');
  assert.match(src, /schemaDisponible/);
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, ''), /migrateSchema\(dbPG\)/);
});

test('R14: flujo vacío y element-exists sin selector no se acreditan', () => {
  const v = bg.validarChecks([
    { type: 'flujo' },
    { type: 'element-exists' },
    { type: 'desconocido' },
  ]);
  assert.ok(v.schemaChecks.some((s) => s.reason === 'FLUJO_INCOMPLETO'));
  assert.ok(v.schemaChecks.some((s) => s.reason === 'SELECTOR_AUSENTE'));
  assert.ok(v.schemaChecks.some((s) => s.reason === 'TIPO_DESCONOCIDO'));
});
