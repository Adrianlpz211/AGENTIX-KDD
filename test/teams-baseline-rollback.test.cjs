'use strict';

/* P18 / C04 — el punto sano se toma antes de entregar y el rollback está
   conectado al scheduler. Repositorio Git de prueba; se comparan bytes. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const G = path.join(__dirname, '..', '.agentic', 'grafo');
const ad = require(path.join(G, 'teams-adapters.cjs'));
const tm = require(path.join(G, 'teams-manager.cjs'));
const rm = require(path.join(G, 'restore-manager.cjs'));
const ef = require(path.join(G, 'efectos.cjs'));

const ORIGINAL = 'module.exports = 1;\n';

function fixture({ rollback = true, politica = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-p18-'));
  const g = (...a) => {
    const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: root, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(a.join(' ') + ': ' + r.stderr);
  };
  g('init', '-q');
  fs.mkdirSync(path.join(root, '.agentic'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'a.js'), ORIGINAL);
  fs.writeFileSync(path.join(root, 'src', 'b.js'), 'module.exports = 2;\n');
  fs.writeFileSync(path.join(root, 'src', 'grande.js'), '// ' + 'x'.repeat(400) + '\n');
  fs.writeFileSync(path.join(root, '.gitignore'), '.agentic/_restore/\n.agentic/_teams/\n.agentic/memoria.db*\n.legion/\n.agentic/efectos.jsonl*\n');
  fs.writeFileSync(path.join(root, '.agentic', 'config.md'), 'CONFIGURADO: SI\n');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fx-p18"}');
  require(path.join(G, 'db-adapter.cjs')).openWrite(path.join(root, '.agentic', 'memoria.db')).close();
  g('add', '-A');
  g('commit', '-q', '-m', 'base');
  fs.writeFileSync(path.join(root, '.agentic', 'restore-policy.json'), JSON.stringify(Object.assign({ rollback_automatico: rollback }, politica)));
  assert.strictEqual(tm.init(root, { aprobarMigracion: true, mismoHost: true }).status, 'ACTIVO');
  return root;
}

const tarea = (id, archivo, extra) => Object.assign({ id, objective: 'tarea ' + id, acceptance: ['criterio ' + id], allowed_files: [archivo], risk: 'LOW', change_type: 'text' }, extra);
function plan(root, tareas) {
  const p = tm.crearPlan(root, { id: 'P1', objective: 'p18', sprints: [{ id: 'S1', tasks: tareas }] });
  assert.ok(!p.status || !/INVALIDO|DESACTIVADO/.test(p.status), JSON.stringify(p));
}
const leer = (root, f) => fs.readFileSync(path.join(root, f), 'utf8');
const escribir = (root, f, c) => fs.writeFileSync(path.join(root, f), c);

/** El host escribe en cuanto recibe la tarea, antes de acusar recibo. */
const builderQueEscribe = (root, contenido = 'module.exports = "escrito al recibir";\n') => new ad.AdapterPrueba({
  alEnviar: (asg) => { for (const f of asg.task.allowed_files) escribir(root, f, contenido); },
  producir: (a) => ({ files: a.task.allowed_files, subject_hash: 'h-' + a.task.id + '-' + Date.now() }),
});
const gates = (root, status) => (res) => [{ gate: 'tests', status, subject_hash: tm.leerTarea(root, res.task_id).subject_hash, execution_id: 'x' }];

function verificadorQueFalla(root, { antesDeResponder } = {}) {
  let llamadas = 0;
  return (res) => {
    llamadas++;
    if (antesDeResponder && llamadas === 1) antesDeResponder();
    return [{ gate: 'tests', status: 'FAIL', subject_hash: tm.leerTarea(root, res.task_id).subject_hash, execution_id: 'x' + llamadas, reason_code: 'ASSERT' }];
  };
}

test('P18: el host escribe al recibir; el BASELINE conserva lo de antes y el fallo reproducible revierte solo', () => {
  const root = fixture();
  plan(root, [tarea('A', 'src/a.js')]);
  const log = ad.tick(root, { builder: builderQueEscribe(root), verificador: verificadorQueFalla(root) });
  const pasos = log.map((p) => p.paso + (p.tipo ? ':' + p.tipo : ''));
  assert.ok(pasos.indexOf('punto:BASELINE') < pasos.indexOf('submit'), 'el punto sano va antes de entregar: ' + pasos);
  const base = log.find((p) => p.tipo === 'BASELINE');
  assert.strictEqual(base.state, 'VERIFIED');
  const rb = log.find((p) => p.paso === 'rollback');
  assert.ok(rb, JSON.stringify(log));
  assert.strictEqual(rb.status, 'REVERTIDA', JSON.stringify(rb));
  assert.strictEqual(rb.point_id, base.id);
  assert.strictEqual(leer(root, 'src/a.js').replace(/\r/g, ''), ORIGINAL, 'volvió exactamente a lo de antes de la entrega');
  assert.strictEqual(tm.leerTarea(root, 'A').state, 'REVERTED', 'revertida no es terminada');
});

test('P18: otro agente edita después de la entrega; el rollback se rechaza sin perder su trabajo', () => {
  const root = fixture();
  plan(root, [tarea('A', 'src/a.js')]);
  const ajeno = 'module.exports = "escrito al recibir";\n// arreglo manual de otra persona\n';
  const log = ad.tick(root, { builder: builderQueEscribe(root), verificador: verificadorQueFalla(root, { antesDeResponder: () => escribir(root, 'src/a.js', ajeno) }) });
  const rb = log.find((p) => p.paso === 'rollback');
  assert.strictEqual(rb.status, 'NO_ELEGIBLE');
  assert.ok(rb.motivos.some((m) => m.startsWith('TRABAJO_AJENO_EN_ALCANCE')), rb.motivos.join());
  assert.strictEqual(leer(root, 'src/a.js'), ajeno);
  assert.ok(tm.pendientes(root).some((s) => s.reason_code === 'ROLLBACK_NO_ELEGIBLE'), 'STOP local con motivos');
});

test('P18: fallo que no se repite no revierte; un efecto externo pendiente tampoco', () => {
  const root = fixture();
  plan(root, [tarea('A', 'src/a.js'), tarea('B', 'src/b.js')]);
  let n = 0;
  const unaVez = (res) => [{ gate: 'tests', status: ++n === 1 ? 'FAIL' : 'PASS', subject_hash: tm.leerTarea(root, res.task_id).subject_hash, execution_id: 'x' + n }];
  const l1 = ad.tick(root, { builder: builderQueEscribe(root), verificador: unaVez });
  assert.deepStrictEqual(l1.find((p) => p.paso === 'rollback').motivos, ['FALLO_NO_REPRODUCIBLE']);

  const root2 = fixture();
  plan(root2, [tarea('A', 'src/a.js')]);
  const b = builderQueEscribe(root2);
  const original = b.submitTask.bind(b);
  b.submitTask = (asg) => {
    ef.registrar(root2, { tipo: 'db', recurso_id: 'pedidos/1', idempotency_key: 'k1', reversible: true, tenant: 'A' }, { task_id: asg.task.id });
    return original(asg);
  };
  const l2 = ad.tick(root2, { builder: b, verificador: verificadorQueFalla(root2) });
  const rb = l2.find((p) => p.paso === 'rollback');
  assert.ok(rb.motivos.includes('EFECTOS_EXTERNOS'), rb.motivos.join());
  assert.notStrictEqual(leer(root2, 'src/a.js'), ORIGINAL, 'no revierte código dejando la base de datos en otro estado');
});

test('P18: sin punto sano íntegro la tarea no se entrega y el scheduler sigue con la independiente', () => {
  const root = fixture({ politica: { max_archivo_bytes: 100 } });
  plan(root, [tarea('A', 'src/grande.js', { priority: 10 }), tarea('B', 'src/b.js')]);
  const enviados = [];
  const builder = new ad.AdapterPrueba({ alEnviar: (asg) => enviados.push(asg.task.id) });
  const l1 = ad.tick(root, { builder, verificador: gates(root, 'PASS') });
  const b1 = l1.find((p) => p.paso === 'baseline');
  assert.ok(b1, JSON.stringify(l1));
  assert.strictEqual(b1.status, 'NO_ENTREGADA');
  assert.strictEqual(enviados.length, 0, 'no se autorizó escribir');
  assert.ok(/BLOCKED/.test(tm.leerTarea(root, b1.task_id).state));
  const l2 = ad.tick(root, { builder, verificador: gates(root, 'PASS') });
  const asignada = l2.find((p) => p.paso === 'asignar');
  assert.strictEqual(asignada.status, 'ASIGNADA', JSON.stringify(l2));
  assert.notStrictEqual(asignada.task_id, b1.task_id, 'la independiente sigue');
  assert.deepStrictEqual(enviados, [asignada.task_id]);
});

test('P18: sin política de rollback el fallo sigue el ciclo de reparación normal', () => {
  const root = fixture({ rollback: false });
  plan(root, [tarea('A', 'src/a.js')]);
  const log = ad.tick(root, { builder: builderQueEscribe(root), verificador: verificadorQueFalla(root) });
  assert.ok(!log.some((p) => p.paso === 'rollback'));
  assert.strictEqual(log.find((p) => p.paso === 'verificar').status, 'REPARAR');
  assert.notStrictEqual(leer(root, 'src/a.js'), ORIGINAL);
});
