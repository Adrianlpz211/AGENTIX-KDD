'use strict';

/* P02 — una sola política de preservación por superficie, la misma para
   aa:, TEAMS, CLI y MCP. Un cambio de interfaz con TDD verde pero sin
   navegador no cierra verificado; NO_APLICA exige razón comprobable. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const G = path.join(__dirname, '..', '.agentic', 'grafo');
const pg = require(path.join(G, 'politica-gates.cjs'));
const router = require(path.join(G, 'effort-router.cjs'));
const pc = require(path.join(G, 'pipeline-controller.cjs'));
const { estadoFinal } = require(path.join(G, 'estado-ciclo.cjs'));
const tig = require(path.join(G, 'test-integrity-gate.cjs'));

const raiz = () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-p02-'));
  fs.mkdirSync(path.join(r, '.agentic'), { recursive: true });
  fs.writeFileSync(path.join(r, '.agentic', 'config.md'), 'CONFIGURADO: SI\n');
  return r;
};

test('P02: superficie decide los gates; sin rutas no se supone N/A', () => {
  const ui = pg.gatesPorSuperficie(['src/pages/compras.tsx', 'src/styles/app.css']);
  assert.deepStrictEqual(ui.required.sort(), ['browser', 'preservation']);
  assert.ok(ui.no_aplica.some((n) => n.gate === 'visual' && n.razon === 'SIN_REFERENCIA_APROBADA'));

  const back = pg.gatesPorSuperficie(['src/services/precio.js']);
  assert.deepStrictEqual(back.required.sort(), ['preservation', 'test-integrity']);
  assert.ok(back.no_aplica.some((n) => n.gate === 'browser' && n.razon === 'SIN_ARCHIVOS_DE_INTERFAZ'));

  const docs = pg.gatesPorSuperficie(['README.md']);
  assert.deepStrictEqual(docs.required, []);
  assert.ok(docs.no_aplica.some((n) => n.gate === 'preservation' && n.razon === 'SOLO_DOCUMENTACION'));

  const nada = pg.gatesPorSuperficie([]);
  assert.deepStrictEqual(nada.required, ['preservation'], 'alcance desconocido exige preservación');
  assert.strictEqual(nada.policy_id, 'preservacion/1');
});

test('P02: con referencia visual aprobada, la UI exige también visual', () => {
  const root = raiz();
  const d = path.join(root, '.agentic', 'snapshots', 'compras', '1280x800@1-light-default');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'aprobado.png'), 'x');
  assert.ok(pg.gatesPorSuperficie(['src/pages/compras.tsx'], { root }).required.includes('visual'));
});

test('P02: el tier LOW no quita los gates de superficie y aa:/TEAMS deciden igual', () => {
  const entrada = { task_id: 'T1', intent: 'cambiar color del botón', paths: ['src/components/Boton.css'], change_type: 'style' };
  const aa = router.decidir({ ...entrada, origen: 'aa' });
  const teams = router.decidir({ ...entrada, origen: 'teams' });
  assert.strictEqual(aa.tier, 'LOW');
  assert.ok(aa.required_gates.includes('browser') && aa.required_gates.includes('preservation'), aa.required_gates.join(','));
  assert.deepStrictEqual(aa.required_gates, teams.required_gates);
  assert.strictEqual(aa.policy_id, teams.policy_id);
  assert.strictEqual(aa.policy_id, 'preservacion/1');
});

function cicloConTddVerde(root, id, paths) {
  pc.abrir(root, { cycle_id: id, task: 'arreglar botón guardar', paths, subject_hash: 'S1' });
  const f = path.join(root, '.agentic', '_pipeline', id + '.json');
  const e = JSON.parse(fs.readFileSync(f, 'utf8'));
  e.steps.tdd = { status: 'PASS' };
  e.steps.qa = { status: 'PASS' };
  fs.writeFileSync(f, JSON.stringify(e));
}

test('P02: TDD verde con botón roto o sin navegador no cierra; solo PASS del mismo sujeto', () => {
  const root = raiz();
  cicloConTddVerde(root, 'c-ui', ['src/pages/compras.tsx']);
  let c = pc.puedeCerrar(root, 'c-ui');
  assert.strictEqual(c.ok, false);
  assert.deepStrictEqual(c.pendientes.sort(), ['gate:browser', 'gate:preservation']);
  assert.strictEqual(c.status, 'PENDING');

  pc.registrarGate(root, 'c-ui', { gate: 'browser', status: 'FAIL', reason_code: 'CONTRATO_UI_ROTO', execution_id: 'b1', subject_hash: 'S1', policy_id: pg.POLICY_ID });
  c = pc.puedeCerrar(root, 'c-ui');
  assert.strictEqual(c.status, 'FAIL', 'botón roto con TDD verde');
  assert.strictEqual(estadoFinal({ contratos: { success: true, status: 'PASS' }, pipeline: c }), 'FALLIDO');

  pc.registrarGate(root, 'c-ui', { gate: 'browser', status: 'UNVERIFIED', reason_code: 'SIN_NAVEGADOR', execution_id: 'b2', subject_hash: 'S1', policy_id: pg.POLICY_ID });
  c = pc.puedeCerrar(root, 'c-ui');
  assert.strictEqual(c.ok, false, 'sin navegador nunca verde');
  assert.notStrictEqual(estadoFinal({ contratos: { success: true, status: 'PASS' }, pipeline: c }), 'COMPLETADO_VERIFICADO');

  pc.registrarGate(root, 'c-ui', { gate: 'browser', status: 'PASS', execution_id: 'b3', subject_hash: 'OTRO', policy_id: pg.POLICY_ID });
  assert.strictEqual(pc.puedeCerrar(root, 'c-ui').gates.browser.reason_code, 'SUJETO_DISTINTO');
  pc.registrarGate(root, 'c-ui', { gate: 'browser', status: 'PASS', execution_id: 'b4', subject_hash: 'S1', policy_id: 'otra/9' });
  assert.strictEqual(pc.puedeCerrar(root, 'c-ui').gates.browser.reason_code, 'POLITICA_DISTINTA');
  pc.registrarGate(root, 'c-ui', { gate: 'browser', status: 'PASS', subject_hash: 'S1', policy_id: pg.POLICY_ID });
  assert.strictEqual(pc.puedeCerrar(root, 'c-ui').gates.browser.reason_code, 'SIN_EJECUCION');

  const esc = require(path.join(G, 'escenarios.cjs'));
  esc.guardarArtefacto(root, {
    execution_id: 'b5-pass-ok', subject_hash: 'S1', policy_id: pg.POLICY_ID, gate: 'browser',
    cycle_id: 'c-ui', provenance: 'browser', expected: [], executed: [], status: 'PASS',
    comprobador: 'browser-gate', contratos: [{ id: 'vista', status: 'PASS' }],
  });
  pc.registrarGate(root, 'c-ui', { gate: 'browser', status: 'PASS', execution_id: 'b5-pass-ok', subject_hash: 'S1', policy_id: pg.POLICY_ID });
  pc.registrarGate(root, 'c-ui', { gate: 'preservation', status: 'NO_APLICA', execution_id: 'p1', subject_hash: 'S1', policy_id: pg.POLICY_ID });
  assert.ok(['NO_APLICA_SIN_RAZON', 'NO_APLICA_SIN_ALCANCE', 'NO_APLICA_SIN_ARTEFACTO', 'SIN_ARTEFACTO', 'NO_PASS:UNVERIFIED'].includes(pc.puedeCerrar(root, 'c-ui').gates.preservation.reason_code), JSON.stringify(pc.puedeCerrar(root, 'c-ui').gates.preservation));
  esc.guardarArtefacto(root, {
    execution_id: 'p2-na-ok', subject_hash: 'S1', policy_id: pg.POLICY_ID, gate: 'preservation',
    cycle_id: 'c-ui', provenance: 'mecanica', expected: [], executed: [], status: 'NO_APLICA',
  });
  pc.registrarGate(root, 'c-ui', { gate: 'preservation', status: 'NO_APLICA', reason_code: 'SIN_ESCENARIOS_PROTEGIDOS', execution_id: 'p2-na-ok', subject_hash: 'S1', policy_id: pg.POLICY_ID });
  c = pc.puedeCerrar(root, 'c-ui');
  assert.strictEqual(c.ok, true, JSON.stringify(c));
  assert.strictEqual(estadoFinal({ contratos: { success: true, status: 'PASS' }, pipeline: c }), 'COMPLETADO_VERIFICADO');
});

test('P02: CLI y MCP entran por la misma puerta y dan el mismo cierre', () => {
  const root = raiz();
  cicloConTddVerde(root, 'c-cli', ['src/pages/compras.tsx']);
  const res = path.join(root, 'r.json');
  fs.writeFileSync(res, JSON.stringify({ gate: 'browser', status: 'UNVERIFIED', reason_code: 'SIN_NAVEGADOR', execution_id: 'b', subject_hash: 'S1', policy_id: pg.POLICY_ID }));
  const cli = spawnSync(process.execPath, [path.join(G, 'pipeline-controller.cjs'), 'gate', '--input=' + res, '--cycle=c-cli'], { cwd: root, encoding: 'utf8' });
  assert.strictEqual(cli.status, 1, cli.stdout + cli.stderr);
  const viaCli = pc.puedeCerrar(root, 'c-cli');

  cicloConTddVerde(root, 'c-mcp', ['src/pages/compras.tsx']);
  pc.registrarGate(root, 'c-mcp', { gate: 'browser', status: 'UNVERIFIED', reason_code: 'SIN_NAVEGADOR', execution_id: 'b', subject_hash: 'S1', policy_id: pg.POLICY_ID, source: 'mcp' });
  const viaMcp = pc.puedeCerrar(root, 'c-mcp');
  assert.deepStrictEqual(viaCli.pendientes, viaMcp.pendientes);
  assert.strictEqual(viaCli.status, viaMcp.status);
  const mcp = fs.readFileSync(path.join(G, 'mcp-server.cjs'), 'utf8');
  assert.match(mcp, /name === 'pipeline_gate'\) return pc\.registrarGate/);
  assert.strictEqual(pc.registrarGate(root, 'c-mcp', { gate: 'inventado', status: 'PASS' }).reason_code, 'GATE_DESCONOCIDO');
});

test('P02: test-integrity sin versión anterior no da PASS; título desaparecido es FAIL', () => {
  const root = raiz();
  fs.mkdirSync(path.join(root, 'test'));
  fs.writeFileSync(path.join(root, 'test', 'a.test.js'), "test('suma', () => {}); test('nuevo', () => {});");
  const sinBase = tig.evaluar(root, { files: ['test/a.test.js'], subject_hash: 'S1' });
  assert.strictEqual(sinBase.status, 'UNVERIFIED', 'sin git no se distingue archivo nuevo de base ilegible');
  assert.strictEqual(sinBase.reason_code, 'SIN_VERSION_ANTERIOR');

  const conBase = tig.evaluar(root, { files: ['test/a.test.js'], readBase: () => "test('suma', () => {}); test('resta', () => {});" });
  assert.strictEqual(conBase.status, 'FAIL');
  assert.strictEqual(conBase.findings[0].tituloDesaparecido, 'resta');

  const igual = tig.evaluar(root, { files: ['test/a.test.js'], readBase: () => "test('suma', () => {});" });
  assert.strictEqual(igual.status, 'PASS');
  assert.ok(igual.execution_id && igual.policy_id === pg.POLICY_ID);
  assert.strictEqual(tig.evaluar(root, { files: ['src/x.js'] }).reason_code, 'SIN_TESTS_TOCADOS');
});
