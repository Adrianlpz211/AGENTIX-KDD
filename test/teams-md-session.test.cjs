'use strict';

/* C01 — TEAMS por el canal MD entre sesiones abiertas. El director publica
   en el canal; la sesión del constructor lee sin pegado, acepta, implementa
   y entrega por su cola; el director verifica. AVAILABLE solo tras ese ida y
   vuelta. Repetir la cola no duplica; compactar no reejecuta. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const G = path.join(__dirname, '..', '.agentic', 'grafo');
const tm = require(path.join(G, 'teams-manager.cjs'));
const ad = require(path.join(G, 'teams-adapters.cjs'));
const md = require(path.join(G, 'teams-md-session.cjs'));
const { createGateResult } = require(path.join(G, 'gate-result.cjs'));

function proyecto({ plan = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-c01-'));
  fs.mkdirSync(path.join(root, '.agentic'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'saludo.js'), "module.exports = 'Hola';\n");
  fs.writeFileSync(path.join(root, '.agentic', 'config.md'), 'CONFIGURADO: SI\n');
  require(path.join(G, 'db-adapter.cjs')).openWrite(path.join(root, '.agentic', 'memoria.db')).close();
  if (!plan) return root;
  assert.strictEqual(tm.init(root, { aprobarMigracion: true }).status, 'ACTIVO');
  tm.crearPlan(root, { id: 'P', objective: 'md', sprints: [{ id: 'S1', tasks: [{ id: 'A', objective: 'cambiar saludo', acceptance: ['dice Buenas'], allowed_files: ['src/saludo.js'], risk: 'LOW', change_type: 'text' }] }] });
  return root;
}

const verificador = (root) => (res) => {
  const t = tm.leerTarea(root, res.task_id);
  const ok = fs.readFileSync(path.join(root, 'src', 'saludo.js'), 'utf8').includes('Buenas');
  return tm.gatesRequeridos(t).map((gate) => require('./helpers/gates.cjs').fixtureGate(root, { gate, status: ok ? 'PASS' : 'FAIL', subject_hash: t.subject_hash, execution_id: 'v-' + gate, evidence: [{ kind: 'fixture', subject_hash: t.subject_hash }] }));
};

/** Un pase de la sesión del constructor: lee el canal, acepta, implementa, entrega. */
function paseConstructor(root, session_id) {
  const { eventos } = md.leerCanal(root, { rol: 'builder' });
  const asig = eventos.find((e) => e.event_kind === 'TASK_ASSIGNED');
  if (!asig) return null;
  const p = asig.payload;
  md.ackear(root, { session_id, delivery_id: p.delivery_id });
  fs.writeFileSync(path.join(root, 'src', 'saludo.js'), "module.exports = 'Buenas';\n");
  md.entregar(root, { resultado: { task_id: p.task.id, delivery_id: p.delivery_id, fencing: p.fencing, subject_hash: 'h-' + Date.now(), files: p.task.allowed_files } });
  md.visto(root, { rol: 'builder', hasta_seq: asig.seq });
  return asig;
}

test('C01: sin las dos sesiones vivas es DEGRADED con la acción exacta; registradas sin ida y vuelta, también', () => {
  const root = proyecto();
  const a = new md.AdapterMdSesion(root);
  const c0 = a.capabilities();
  assert.strictEqual(c0.status, 'DEGRADED');
  assert.strictEqual(c0.motivo, 'SESION_AUSENTE');
  assert.ok(c0.accion.some((x) => /registrar --rol=builder/.test(x)));
  assert.match(c0.latencia, /siguiente pase/);
  md.registrar(root, { rol: 'director', host: 'claude-code' });
  md.registrar(root, { rol: 'builder', host: 'cursor' });
  assert.strictEqual(a.capabilities().motivo, 'HANDSHAKE_SIN_IDA_Y_VUELTA', 'registrarse no es ACK');
});

test('C01: ida y vuelta real por el canal, sin pegar nada; luego AVAILABLE', () => {
  const root = proyecto();
  md.registrar(root, { rol: 'director', host: 'claude-code' });
  const { session_id } = md.registrar(root, { rol: 'builder', host: 'cursor' });
  const director = new md.AdapterMdSesion(root);
  const l1 = ad.tick(root, { builder: director, verificador: verificador(root), puntos: false });
  assert.strictEqual(l1.find((p) => p.paso === 'submit').accepted, false, 'publicar en el canal no es aceptación');
  assert.strictEqual(tm.leerTarea(root, 'A').state, 'READY');

  const asig = paseConstructor(root, session_id);
  assert.ok(asig, 'la sesión leyó la tarea del canal');
  const l2 = ad.tick(root, { builder: director, verificador: verificador(root), puntos: false });
  assert.strictEqual(l2.find((p) => p.paso === 'verificar').status, 'DONE_VERIFIED', JSON.stringify(l2));
  const c = director.capabilities();
  assert.strictEqual(c.status, 'AVAILABLE');
  assert.strictEqual(c.verificado.task_id, 'A');
  assert.strictEqual(c.verificado.session_id, session_id);
  assert.ok(md.leerCanal(root, { rol: 'builder' }).eventos.every((e) => e.event_kind !== 'TASK_ASSIGNED'), 'la tarea aceptada no se vuelve a ofrecer');
});

test('C01: repetir la cola entera no duplica transiciones', () => {
  const root = proyecto();
  md.registrar(root, { rol: 'director' });
  const { session_id } = md.registrar(root, { rol: 'builder' });
  const director = new md.AdapterMdSesion(root);
  ad.tick(root, { builder: director, verificador: verificador(root), puntos: false });
  paseConstructor(root, session_id);
  ad.tick(root, { builder: director, verificador: verificador(root), puntos: false });
  const antes = tm.leerTarea(root, 'A');
  fs.rmSync(path.join(root, '.legion', '_md-session', 'estado.json'));
  ad.tick(root, { builder: director, verificador: verificador(root), puntos: false });
  const despues = tm.leerTarea(root, 'A');
  assert.strictEqual(despues.state, 'DONE_VERIFIED');
  assert.strictEqual(despues.revision, antes.revision, 'sin transiciones nuevas');
});

test('C01: tras compactar, la sesión retoma lo que tenía en curso y no lo reejecuta', () => {
  const root = proyecto();
  md.registrar(root, { rol: 'director' });
  const { session_id } = md.registrar(root, { rol: 'builder' });
  ad.tick(root, { builder: new md.AdapterMdSesion(root), verificador: verificador(root), puntos: false });
  const asig = md.leerCanal(root, { rol: 'builder' }).eventos.find((e) => e.event_kind === 'TASK_ASSIGNED');
  md.ackear(root, { session_id, delivery_id: asig.payload.delivery_id });
  const r = md.retomar(root, { rol: 'builder', session_id });
  assert.match(r.continuidad, /Continuidad/);
  assert.deepStrictEqual(r.en_curso, [asig.payload.delivery_id]);
  assert.ok(!r.nuevos.some((e) => e.event_kind === 'TASK_ASSIGNED'), 'no se ofrece de nuevo como tarea nueva');
});

test('C01: las notas de la persona sobreviven a la regeneración del canal', () => {
  const root = proyecto();
  tm.regenerarVistas(root);
  const f = path.join(root, '.legion', 'AUDITORIA-CURSOR.md');
  const txt = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, txt.replace('<!-- akdd:humano:fin -->', 'Ojo: el saludo va sin signo.\n<!-- akdd:humano:fin -->'));
  tm.regenerarVistas(root);
  tm.regenerarVistas(root);
  const final = fs.readFileSync(f, 'utf8');
  assert.strictEqual(final.split('Ojo: el saludo va sin signo.').length, 2, 'una sola copia, sin perderla ni duplicarla');
});

test('C01: la vigilancia solo acepta lo que la sesión confirmó haber leído', () => {
  const root = proyecto();
  tm.asignar(root, { owner_id: 'builder-md-session' });
  const evs = tm.delta(root, { rol: 'builder' }).eventos;
  const a = new md.AdapterMdSesion(root);
  assert.strictEqual(a.entregarEventos(evs).aceptado, false);
  md.visto(root, { rol: 'builder', hasta_seq: evs[0].seq });
  assert.deepStrictEqual(a.entregarEventos(evs), { aceptado: true, hasta_seq: evs[0].seq });
});

test('C01: preparar no migra la base y dice qué hace falta', () => {
  const root = proyecto({ plan: false });
  const p = md.preparar(root, {});
  assert.strictEqual(p.status, 'PREPARADO');
  assert.deepStrictEqual(p.roles, { director: 'claude-code', builder: 'cursor' });
  assert.strictEqual(p.migracion.requerida, true);
  assert.ok(p.aviso);
  assert.strictEqual(tm.estado(root).inicializado, false, 'preparar archivos no es activar TEAMS');
});
