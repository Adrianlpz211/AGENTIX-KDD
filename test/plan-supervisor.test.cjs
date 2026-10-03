'use strict';

/* P17 / C05 — supervisor de plan entre sprints. Una pregunta en S1 no frena
   lo independiente de S2/S3; un STOP global sí frena; sin progreso se agota
   el presupuesto y siempre sale el reporte del plan con lo hecho y lo que falta. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const G = path.join(__dirname, '..', '.agentic', 'grafo');
const tm = require(path.join(G, 'teams-manager.cjs'));
const ad = require(path.join(G, 'teams-adapters.cjs'));
const gc = require(path.join(G, 'goal-check.cjs'));
const { createGateResult } = require(path.join(G, 'gate-result.cjs'));

const t = (id, extra) => Object.assign({ id, objective: 't ' + id, acceptance: ['c ' + id], allowed_files: ['src/' + id + '.js'], risk: 'LOW', change_type: 'text' }, extra);

function proyecto(sprints) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-p17-'));
  fs.mkdirSync(path.join(root, '.agentic'));
  fs.writeFileSync(path.join(root, '.agentic', 'config.md'), 'CONFIGURADO: SI\n');
  require(path.join(G, 'db-adapter.cjs')).openWrite(path.join(root, '.agentic', 'memoria.db')).close();
  assert.strictEqual(tm.init(root, { aprobarMigracion: true }).status, 'ACTIVO');
  const p = tm.crearPlan(root, { id: 'P', objective: 'tres sprints', sprints });
  assert.strictEqual(p.status, 'PLAN_GUARDADO', JSON.stringify(p));
  return root;
}

const TRES = [
  { id: 'S1', tasks: [t('A'), t('B', { depends_on: ['A'] })] },
  { id: 'S2', tasks: [t('C')] },
  { id: 'S3', tasks: [t('D')] },
];

const verificador = (root) => (res) => {
  const tarea = tm.leerTarea(root, res.task_id);
  return tm.gatesRequeridos(tarea).map((gate) => require('./helpers/gates.cjs').fixtureGate(root, {
    gate, status: 'PASS', subject_hash: tarea.subject_hash, execution_id: 'x-' + gate,
    evidence: [{ kind: 'fixture', subject_hash: tarea.subject_hash, exit: 0 }],
  }));
};
const trabajar = (root) => ad.tick(root, { builder: new ad.AdapterPrueba({}), verificador: verificador(root), puntos: false });
const estado = (root, id) => tm.leerTarea(root, id).state;

test('P17: pregunta humana en S1; S2 y S3 independientes se completan y el reporte lista lo pendiente', () => {
  const root = proyecto(TRES);
  assert.strictEqual(gc.activar(root, { sprint_id: 'S1', continuar: true, lookahead: 2 }).status, 'ACTIVO');
  tm.stop(root, { reason_code: 'DECISION_DE_NEGOCIO', scope: 'TASK', task_id: 'A', decision_required: true, question: '¿Qué tarifa aplica?' });

  const d1 = gc.decidirStop(root, {});
  assert.strictEqual(d1.seguir, true, JSON.stringify(d1));
  assert.deepStrictEqual(d1.cambio_de_sprint, { de: 'S1', a: 'S2', motivo: 'ESPERA_HUMANA' });
  assert.match(d1.mecanismo, /hook-local/);
  trabajar(root);
  assert.strictEqual(estado(root, 'C'), 'DONE_VERIFIED');

  const d2 = gc.decidirStop(root, {});
  assert.strictEqual(d2.seguir, true, JSON.stringify(d2));
  assert.strictEqual(d2.cambio_de_sprint.a, 'S3');
  trabajar(root);
  assert.strictEqual(estado(root, 'D'), 'DONE_VERIFIED');

  const fin = gc.decidirStop(root, {});
  assert.strictEqual(fin.seguir, false);
  assert.strictEqual(fin.motivo, 'ESPERA_HUMANA', 'S3 terminó, el plan no');
  assert.strictEqual(fin.plan.completo, false);
  const s1 = fin.plan.sprints.find((s) => s.sprint_id === 'S1');
  assert.deepStrictEqual(s1.pendientes.sort(), ['A', 'B']);
  assert.deepStrictEqual(fin.plan.sprints.find((s) => s.sprint_id === 'S2').completadas, ['C']);
  assert.ok(fin.plan.pendientes_humanas.some((h) => /tarifa/.test(h.pregunta)));
  assert.deepStrictEqual(fin.plan.fases.map((f) => f.sprint_id), ['S1', 'S2']);
  assert.strictEqual(gc.leerGoal(root).activo, false);
});

test('P17: un STOP global real sí frena aunque haya trabajo en otros sprints', () => {
  const root = proyecto(TRES);
  gc.activar(root, { sprint_id: 'S1', continuar: true, lookahead: 2 });
  tm.stop(root, { reason_code: 'INCIDENTE', scope: 'GLOBAL', decision_required: true, question: 'incidente en producción' });
  const d = gc.decidirStop(root, {});
  assert.strictEqual(d.seguir, false);
  assert.strictEqual(d.motivo, 'FALLA_GLOBAL');
  assert.ok(d.plan && d.plan.pendientes_humanas.length, 'el reporte sale igual');
});

test('P17: sin progreso agota el presupuesto y reporta lo que falta', () => {
  const root = proyecto(TRES);
  gc.activar(root, { sprint_id: 'S2', continuar: true });
  let d;
  for (let i = 0; i < 10; i++) { d = gc.decidirStop(root, {}); if (!d.seguir) break; }
  assert.strictEqual(d.seguir, false);
  assert.strictEqual(d.motivo, 'SIN_PROGRESO');
  assert.ok(d.plan.sprints.every((s) => Array.isArray(s.pendientes)));
  assert.match(d.plan.resumen, /quedan 4 tarea/);
});

test('P17: la ventana de lookahead se respeta y sin supervisor el goal sigue siendo por fase', () => {
  const root = proyecto([
    { id: 'S1', tasks: [t('A')] },
    { id: 'S2', tasks: [t('C', { depends_on: ['A'] })] },
    { id: 'S3', tasks: [t('D')] },
  ]);
  gc.activar(root, { sprint_id: 'S1', continuar: true, lookahead: 1 });
  tm.stop(root, { reason_code: 'DECISION', scope: 'TASK', task_id: 'A', decision_required: true, question: '¿?' });
  const d = gc.decidirStop(root, {});
  assert.strictEqual(d.seguir, false, 'S3 queda fuera de la ventana de un sprint');
  assert.strictEqual(d.motivo, 'ESPERA_HUMANA');

  const root2 = proyecto(TRES);
  gc.activar(root2, { sprint_id: 'S1' });
  tm.stop(root2, { reason_code: 'DECISION', scope: 'TASK', task_id: 'A', decision_required: true, question: '¿?' });
  const d2 = gc.decidirStop(root2, {});
  assert.strictEqual(d2.seguir, false);
  assert.strictEqual(d2.plan, null, 'sin supervisor no hay continuación entre sprints');
  assert.strictEqual(gc.activar(root2, { continuar: true }).motivo, 'GOAL_POR_FASE', 'nunca "todo el plan" como un solo goal');
});

test('P17: REVERTED sigue abierta y la pausa de la persona no se salta', () => {
  const root = proyecto(TRES);
  gc.activar(root, { sprint_id: 'S2', continuar: true, lookahead: 2 });
  tm.marcarRevertida(root, { task_id: 'C', point_id: null, motivo: 'ROLLBACK' });
  assert.notStrictEqual(gc.evaluar(root, { sprint_id: 'S2' }).codigo, 'GOAL_OK', 'revertida no es terminada');
  tm.pausar(root);
  const d = gc.decidirStop(root, {});
  assert.strictEqual(d.seguir, false);
  assert.strictEqual(d.motivo, 'ESPERA_HUMANA');
  assert.ok(d.plan.sprints.find((s) => s.sprint_id === 'S2').revertidas.includes('C'));
});
