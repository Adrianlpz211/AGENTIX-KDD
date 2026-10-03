'use strict';

// H04 · H05 · H09 · H10 · H11 · H13 — el ciclo se abre, pasa por el harness,
// cuenta sus propios STOP, se cierra con lo que los gates dijeron y deja una
// traza correlacionada sin contenido sensible.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const GRAFO = path.join(__dirname, '..', '.agentic', 'grafo');
const harness = require(path.join(GRAFO, 'harness.cjs'));
const pc = require(path.join(GRAFO, 'pipeline-controller.cjs'));
const gt = require(path.join(GRAFO, 'gate-telemetry.cjs'));
const tel = require(path.join(GRAFO, 'telemetry.cjs'));
const mh = require(path.join(GRAFO, 'memory-hash.cjs'));
const kv = require(path.join(GRAFO, 'knowledge-validator.cjs'));
const { estadoFinal } = require(path.join(GRAFO, 'estado-ciclo.cjs'));
const dbAccess = require(path.join(GRAFO, 'db-adapter.cjs'));

delete process.env.NODE_TEST_CONTEXT;

function temporal() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-ciclo-'));
  fs.mkdirSync(path.join(dir, '.agentic'));
  return dir;
}

function callado(fn) {
  const log = console.log;
  console.log = () => {};
  return Promise.resolve().then(fn).finally(() => { console.log = log; });
}

// ── H05: la QA sale de la evidencia, no del veredicto del agente ────────────

const SUJETO = 'sujeto-qa';
const qaValida = () => ({
  acceptance_criteria: [{ id: 'AC1', verified: true, evidence_ref: 'tdd:1' }],
  evidence: [{ kind: 'targeted_tests', ref: 'tdd:1', subject_hash: SUJETO, status: 'PASS' }],
  regressions: [],
  qa_verdict: 'PASS',
});

test('H05: evidencia del sujeto correcto sí pasa', () => {
  assert.equal(harness.verificarQA(qaValida(), { subject_hash: SUJETO }).ok, true);
});

test('H05: PASS con regresión se rechaza aunque qa_verdict diga PASS', () => {
  const o = qaValida();
  o.regressions = ['pagos::cobro'];
  assert.equal(harness.verificarQA(o, { subject_hash: SUJETO }).ok, false);
});

test('H05: full_suite_passed sin evidencia no basta cuando la política la exige', () => {
  const o = Object.assign(qaValida(), { full_suite_passed: true });
  const r = harness.verificarQA(o, { subject_hash: SUJETO, qa_policy: { requires_full_suite: true } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /full_suite/);
});

test('H05: evidencia de otro sujeto o criterio sin referencia no cuenta', () => {
  const ajena = qaValida();
  ajena.evidence[0].subject_hash = 'otro';
  assert.equal(harness.verificarQA(ajena, { subject_hash: SUJETO }).ok, false);
  const sinRef = qaValida();
  sinRef.acceptance_criteria[0].evidence_ref = 'no-existe';
  assert.equal(harness.verificarQA(sinRef, { subject_hash: SUJETO }).ok, false);
  const legacy = { acceptance_criteria_checked: true, full_suite_passed: true, regressions: [], qa_verdict: 'PASS' };
  assert.equal(harness.verificarQA(legacy, { subject_hash: SUJETO }).ok, false, 'booleans sin referencias no son prueba');
});

// ── H04: el controlador pasa los pasos por PRE/EXEC/POST ────────────────────

test('H04: el paso registra PRE/EXEC/POST y un gate requerido fallido impide cerrar', async () => {
  const root = temporal();
  pc.abrir(root, { cycle_id: 'ciclo-h04', task: 'tarea de prueba', subject_hash: SUJETO });
  const sinSalida = await callado(() => pc.paso(root, { cycle_id: 'ciclo-h04', step: 'qa', quiet: true }));
  assert.equal(sinSalida.status, 'NEEDS_AGENT_ACTION', 'no se simula al agente');

  const malo = Object.assign(qaValida(), { regressions: ['x'] });
  const r = await callado(() => pc.paso(root, { cycle_id: 'ciclo-h04', step: 'qa', output: malo, quiet: true, ctx: { tdd_passed: true } }));
  assert.equal(r.status, 'FAIL');
  assert.deepEqual(r.phases, ['PRE', 'POST']);
  const cierre = pc.puedeCerrar(root, 'ciclo-h04');
  assert.equal(cierre.ok, false);
  assert.ok(cierre.pendientes.includes('qa'));
});

test('H04: el mismo evento por dos entradas se ejecuta una vez', async () => {
  const root = temporal();
  pc.abrir(root, { cycle_id: 'ciclo-dup', task: 'tarea de prueba', subject_hash: SUJETO });
  const entrada = { cycle_id: 'ciclo-dup', step: 'qa', output: qaValida(), event_id: 'ev-1', quiet: true, ctx: { tdd_passed: true } };
  const a = await callado(() => pc.paso(root, Object.assign({}, entrada, { source: 'hook' })));
  const b = await callado(() => pc.paso(root, Object.assign({}, entrada, { source: 'mcp' })));
  assert.equal(a.status, 'PASS');
  assert.equal(b.duplicate, true);
  assert.equal(pc.cargar(root, 'ciclo-dup').events.length, 1);
});

// ── H09: STOP por ciclo ─────────────────────────────────────────────────────

function libreta() {
  const dir = temporal();
  const db = dbAccess.openWrite(path.join(dir, '.agentic', 'memoria.db'));
  gt.ensureTelemetrySchema(db);
  return { dir, db };
}

test('H09: dos incidentes cuentan dos; reenvío no duplica; otro ciclo no hereda', () => {
  const { db } = libreta();
  gt.recordGateEvent(db, { gate: 'tdd', verdict: 'STOP', cycle_id: 'c1', event_id: 'e1' });
  gt.recordGateEvent(db, { gate: 'tdd', verdict: 'STOP', cycle_id: 'c1', event_id: 'e1' });
  gt.recordGateEvent(db, { gate: 'spec', verdict: 'STOP', cycle_id: 'c1', event_id: 'e2' });
  gt.recordGateEvent(db, { gate: 'spec', verdict: 'STOP', cycle_id: 'c1', event_id: 'e3', incident_id: 'i-e2' });
  const c1 = gt.contarStopsDelCiclo(db, 'c1');
  assert.equal(c1.status, 'OK');
  assert.equal(c1.eventos, 3, 'el reenvío de e1 no se anotó');
  assert.equal(gt.contarStopsDelCiclo(db, 'c2').incidentes, 0);
  db.close();
});

test('H09: sin ciclo o con la consulta caída no hay cero', () => {
  const { db } = libreta();
  assert.equal(gt.contarStopsDelCiclo(db, null).incidentes, null);
  db.close();
  assert.equal(gt.contarStopsDelCiclo(db, 'c1').status, 'ERROR');
});

// ── H10: cierre fiel ────────────────────────────────────────────────────────

test('H10: un gate posterior fallido no deja éxito; sin evidencia quedan pendientes', () => {
  const ok = { contratos: { success: true, status: 'PASS' } };
  assert.equal(estadoFinal(ok), 'COMPLETADO_VERIFICADO');
  assert.equal(estadoFinal({ ...ok, preservation: { status: 'FAIL' } }), 'FALLIDO');
  assert.equal(estadoFinal({ ...ok, pipeline: { status: 'FAIL' } }), 'FALLIDO');
  assert.equal(estadoFinal({ ...ok, preservation: { status: 'UNVERIFIED' } }), 'COMPLETADO_CON_PENDIENTES');
  assert.equal(estadoFinal({ contratos: { status: 'BLOCKED' } }), 'BLOQUEADO');
  assert.equal(estadoFinal({ contratos: { success: false, status: 'ERROR' } }), 'COMPLETADO_CON_PENDIENTES');
});

test('H10: el ciclo se abre EN_CURSO, se cierra una vez y no se reabre', () => {
  const dir = temporal();
  const memoria = path.join(dir, '.agentic', 'memoria');
  fs.mkdirSync(memoria);
  const script = `
    process.env.AGENTIC_MEMORIA_PATH_OVERRIDE = ${JSON.stringify(memoria)};
    const g = require(${JSON.stringify(path.join(GRAFO, 'grafo.cjs'))});
    const id = g.registrarCiclo({ ciclo_id: 'ciclo-h10', tarea: 't', estado: 'EN_CURSO', stops_count: null });
    const abierto = require(${JSON.stringify(path.join(GRAFO, 'db-adapter.cjs'))})
      .openReadOnly(${JSON.stringify(path.join(dir, '.agentic', 'memoria.db'))});
    const fila = abierto.get("SELECT estado, fecha_fin, stops_count FROM ciclos WHERE ciclo_id = 'ciclo-h10'");
    abierto.close();
    const reintento = g.registrarCiclo({ ciclo_id: 'ciclo-h10', tarea: 't', estado: 'EN_CURSO' });
    const c1 = g.cerrarCiclo(id, { estado: 'FALLIDO', stops_count: 2 });
    const c2 = g.cerrarCiclo(id, { estado: 'COMPLETADO_VERIFICADO' });
    const tarde = g.registrarCiclo({ ciclo_id: 'ciclo-h10', tarea: 't', estado: 'EN_CURSO' });
    process.stdout.write('@@' + JSON.stringify({ id, fila, reintento, c1, c2, tarde }));
  `;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', cwd: dir });
  const out = JSON.parse(r.stdout.split('@@').pop());
  assert.equal(out.id, 'ciclo-h10');
  assert.equal(out.fila.estado, 'EN_CURSO');
  assert.equal(out.fila.fecha_fin, null, 'un ciclo abierto no tiene cierre');
  assert.equal(out.fila.stops_count, null, 'sin conteo todavía no es cero');
  assert.equal(out.reintento, 'ciclo-h10', 'tras un crash el ciclo abierto se retoma');
  assert.equal(out.c1.status, 'PASS');
  assert.equal(out.c2.reason_code, 'NO_ABIERTO', 'no se recertifica un ciclo ya cerrado');
  assert.equal(out.tarde, null);
});

// ── H11: traza correlacionada y redactada ──────────────────────────────────

test('H11: recall/remember/STOP quedan en la traza del ciclo sin contenido sensible', () => {
  const root = temporal();
  tel.recordMemoryRead('clave sk-abcdefghijklmnopqrstu de juan@ejemplo.com', [{ id: 7 }], { cycle_id: 'c-h11', via: 'mcp' }, root);
  tel.recordMemoryWrite('el password: hunter2 del +52 55 1234 5678', { ok: true, id: 'p1' }, { cycle_id: 'c-h11' }, root);
  tel.recordStop('token=abc123456789 filtrado', { cycle_id: 'c-h11', gate: 'spec' }, root);
  const archivo = path.join(root, '.agentic', 'telemetria', 'trace_c-h11.jsonl');
  const crudo = fs.readFileSync(archivo, 'utf8');
  for (const prohibido of ['sk-abcdefghijklmnopqrstu', 'juan@ejemplo.com', 'hunter2', '1234 5678', 'abc123456789']) {
    assert.equal(crudo.includes(prohibido), false, 'se coló: ' + prohibido);
  }
  const eventos = crudo.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(eventos.map((e) => e.action), ['recall', 'remember', 'stop']);
  assert.ok(eventos.every((e) => e.schema_version === tel.SCHEMA_VERSION && e.trace_id === 'c-h11' && e.event_id));
});

test('H11: escrituras concurrentes dejan un JSONL válido', () => {
  const root = temporal();
  const script = (n) => `
    const t = require(${JSON.stringify(path.join(GRAFO, 'telemetry.cjs'))});
    for (let i = 0; i < 200; i++) t.recordStep('qa', { status: 'PASS', reason: 'x'.repeat(300) }, { cycle_id: 'c-conc' }, ${JSON.stringify(root)});
  `;
  const { spawn } = require('child_process');
  return Promise.all([1, 2, 3].map((n) => new Promise((res) => spawn(process.execPath, ['-e', script(n)]).on('exit', res))))
    .then(() => {
      const lineas = fs.readFileSync(path.join(root, '.agentic', 'telemetria', 'trace_c-conc.jsonl'), 'utf8').trim().split('\n');
      assert.equal(lineas.length, 600);
      lineas.forEach((l) => JSON.parse(l));
    });
});

test('H11: fallo de escritura con auditoría requerida es visible y sin secretos', () => {
  const root = temporal();
  fs.writeFileSync(path.join(root, '.agentic', 'telemetria'), 'no soy un directorio');
  process.env.AKDD_AUDIT_REQUIRED = '1';
  try {
    assert.throws(() => tel.recordStop('secreto sk-abcdefghijklmnopqrstu', { cycle_id: 'c' }, root), (e) => {
      assert.ok(['TELEMETRY_WRITE_FAILED', 'EEXIST', 'ENOTDIR'].includes(e.code), e.code);
      assert.equal(String(e.message).includes('sk-abcdefghijklmnopqrstu'), false);
      return true;
    });
  } finally {
    delete process.env.AKDD_AUDIT_REQUIRED;
  }
  assert.doesNotThrow(() => tel.recordStop('x', { cycle_id: 'c' }, root), 'sin auditoría requerida no tumba al que llama');
});

// ── H13: hashes de memoria ──────────────────────────────────────────────────

test('H13: quien escribe y quien valida calculan el mismo hash', () => {
  const root = temporal();
  fs.writeFileSync(path.join(root, 'a.js'), 'const a = 1;\n');
  assert.equal(kv.computeContextHash(['a.js'], root), mh.contextHash(['a.js'], root).hash);
  assert.notEqual(mh.dedupHash('texto', 'patron', 'x'), mh.contextHash(['a.js'], root).hash);
});

test('H13: un cambio con el mismo tamaño y fecha se detecta', () => {
  const root = temporal();
  const f = path.join(root, 'a.js');
  fs.writeFileSync(f, 'const a = 1;\n');
  const antes = mh.contextHash(['a.js'], root).hash;
  const { mtime } = fs.statSync(f);
  fs.writeFileSync(f, 'const a = 2;\n');
  fs.utimesSync(f, mtime, mtime);
  assert.equal(mh.compararContexto(antes, ['a.js'], root).estado, 'CAMBIADO');
  fs.writeFileSync(f, 'const a = 2;\r\n');
  assert.equal(mh.compararContexto(mh.contextHash(['a.js'], root).hash, ['a.js'], root).estado, 'VIGENTE');
});

test('H13: borrado y hash legacy son explícitos', () => {
  const root = temporal();
  fs.writeFileSync(path.join(root, 'a.js'), 'x');
  assert.equal(mh.compararContexto('abcdef0123456789', ['a.js'], root).estado, 'UNKNOWN');
  fs.unlinkSync(path.join(root, 'a.js'));
  const r = mh.compararContexto('v2:abcdef0123456789', ['a.js'], root);
  assert.equal(r.estado, 'DELETED');
  assert.deepEqual(r.actual.faltantes, ['a.js']);
});
