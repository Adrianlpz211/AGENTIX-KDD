'use strict';
/* TEAMS que no se duerme y no pierde lo escrito (medinet, 08/10/2026):
   · una tarea quedó en el estado pero no en el archivo del canal (otro editor la pisó)
   · la barra de avance en 4 tramos (verde / azul / naranja / rojo), igual en TEAMS y en individual
   · el fin se declara solo tras RECORRER todo: un bloqueo del dueño no detiene el recorrido
   · el gancho de parada del host pide seguir si queda trabajo o el vigilante murió, con freno anti-bucle */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const G = path.join(__dirname, '..', '.agentic', 'grafo');
const T = require(path.join(G, 'teams.cjs'));
const canal = require(path.join(G, 'teams-canal.cjs'));
const C = require(path.join(G, 'teams-continuidad.cjs'));

function proyecto() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-vida-'));
  fs.mkdirSync(path.join(root, '.agentic'), { recursive: true });
  return root;
}
const run = (root, ...args) => T.ejecutar(args, root);
const salida = (root, ...args) => run(root, ...args).out;
function arrancado(root) { run(root, 'activar'); run(root, 'modo', 'completo'); run(root, 'iniciar'); }
const tarea = (root, t) => salida(root, 'tarea', t, '--criterio=hecho', '--sin-contexto');
const canalTxt = (root) => fs.readFileSync(canal.rutaCanal(root), 'utf8');

test('VIDA-1 canal pisado: si un editor guarda una copia vieja y falta una tarea, Agentix la repone en el siguiente cálculo', () => {
  const root = proyecto(); arrancado(root);
  tarea(root, 'Primera'); tarea(root, 'Segunda');
  const antes = canalTxt(root);
  assert.match(antes, /\[T-002\] Segunda/);
  // el editor del constructor guarda encima una copia que no tiene T-002
  const sin = antes.split('\n'); const i = sin.findIndex((l) => /\[T-002\]/.test(l));
  fs.writeFileSync(canal.rutaCanal(root), sin.slice(0, i).join('\n') + '\n');
  assert.doesNotMatch(canalTxt(root), /\[T-002\]/);
  const e = T.calcular(root);
  assert.deepEqual(e.recuperados, ['T-002']);
  assert.match(canalTxt(root), /\[T-002\] Segunda/, 'repuesta en el archivo');
  assert.ok(e.tareas.some((t) => t.id === 'T-002'), 'y el cálculo ya la ve');
  assert.deepEqual(T.calcular(root).recuperados, [], 'idempotente: no repone dos veces');
  const a = T.accionable(T.calcular(root, { sinRecuperar: true }), 'director');
  assert.ok(Array.isArray(a.razones));
});

test('VIDA-2 un canal nuevo no hereda tareas de la instantánea del anterior', () => {
  const root = proyecto(); arrancado(root); tarea(root, 'Vieja');
  assert.ok(fs.existsSync(path.join(canal.dirEstado(root), 'canal-ultimo.md')));
  fs.rmSync(canal.rutaCanal(root));
  run(root, 'activar');
  assert.doesNotMatch(canalTxt(root), /Vieja/, 'activar olvida la instantánea');
  assert.deepEqual(T.calcular(root).recuperados, []);
});

test('VIDA-3 la barra de 4 tramos y el estado de fin: se recorre TODO antes de parar', () => {
  const root = proyecto(); arrancado(root);
  for (const n of ['A', 'B', 'C', 'D']) tarea(root, n);
  let e = T.calcular(root);
  assert.equal(e.segmentos.rojo, 4); assert.equal(e.segmentos.verde, 0); assert.equal(e.fin, null);
  // A aceptada, B entregada sin aceptar, C y D sin empezar
  salida(root, 'reportar', 'T-001', '--estado=HECHO', '--detalle=listo'); salida(root, 'aceptar', 'T-001');
  salida(root, 'reportar', 'T-002', '--estado=HECHO', '--detalle=listo');
  e = T.calcular(root);
  assert.equal(e.segmentos.verde, 1); assert.equal(e.segmentos.azul, 1); assert.equal(e.segmentos.rojo, 2);
  assert.equal(e.segmentos.pct.verde, 25);
  assert.equal(e.fin, null, 'quedan tareas sin hacer: no hay fin');
  // una decisión del dueño abierta NO detiene el recorrido: mientras quede trabajo accionable no hay fin
  salida(root, 'decision', '¿Usamos A o B?', '--tipo=dueno', '--opciones=A|B', '--recomendacion=A', '--impacto=x', '--porque=y');
  assert.equal(T.calcular(root).fin, null);
  // se hace todo lo demás
  salida(root, 'aceptar', 'T-002');
  for (const id of ['T-003', 'T-004']) { salida(root, 'reportar', id, '--estado=HECHO', '--detalle=listo'); salida(root, 'aceptar', id); }
  e = T.calcular(root);
  assert.equal(e.segmentos.verde, 4);
  assert.equal(e.fin, 'ESPERA_DUENO', 'recorrido completo: solo falta la decisión del dueño');
  const a = T.accionable(e, 'director');
  assert.ok(a.razones.some((r) => /RECORRIDO COMPLETO/.test(r)), 'el Director se entera una vez y no inventa trabajo');
  // el dueño responde → todo verde
  const id = /D-\d+/.exec(canalTxt(root))[0];
  salida(root, 'decidir', id, 'A');
  e = T.calcular(root);
  assert.equal(e.fin, 'TERMINADO');
  assert.ok(T.accionable(e, 'director').razones.some((r) => /TODO VERDE/.test(r)));
});

test('VIDA-4 gancho de parada: pide seguir si hay trabajo o el vigilante murió; nunca en pausa; con freno anti-bucle', () => {
  const root = proyecto(); arrancado(root);
  tarea(root, 'Trabajo');
  const est = T.leerEstado(root); est.rondas = { builder: Date.now() - 60000, director: Date.now() - 60000 };
  fs.writeFileSync(path.join(canal.dirEstado(root), 'estado.json'), JSON.stringify(est));
  let r = C.decidir(root, 'cursor', {});
  assert.equal(r.continuar, true); assert.equal(r.motivo, 'TRABAJO_PENDIENTE');
  assert.match(r.mensaje, /ronda --rol=builder/); assert.match(r.mensaje, /vigilante/i);
  assert.deepEqual(Object.keys(C.salidaParaHost('cursor', r)), ['followup_message']);
  assert.deepEqual(Object.keys(C.salidaParaHost('claude', r)), ['decision', 'reason']);
  // Claude ya continuando por el gancho → no se encadena otra vuelta
  assert.equal(C.decidir(root, 'claude', { stop_hook_active: true }).motivo, 'YA_CONTINUANDO');
  // otra conversación cualquiera (el rol no hizo ronda hace horas) no se obliga
  const viejo = T.leerEstado(root); viejo.rondas = { builder: Date.now() - 12 * 3600 * 1000 };
  fs.writeFileSync(path.join(canal.dirEstado(root), 'estado.json'), JSON.stringify(viejo));
  assert.equal(C.decidir(root, 'cursor', {}).motivo, 'NO_ES_ESTE_ROL');
  fs.writeFileSync(path.join(canal.dirEstado(root), 'estado.json'), JSON.stringify(est));
  // freno: tras MAX_SEGUIDAS intentos sin cambio deja de insistir
  fs.rmSync(path.join(canal.dirEstado(root), 'continuidad.json'), { force: true });
  const motivos = []; for (let i = 0; i < C.MAX_SEGUIDAS + 2; i++) motivos.push(C.decidir(root, 'cursor', {}).motivo);
  assert.equal(motivos.filter((m) => m === 'TRABAJO_PENDIENTE').length, C.MAX_SEGUIDAS);
  assert.equal(motivos[motivos.length - 1], 'FRENO_ANTIBUCLE');
  // pausa: el protocolo mandó parar
  run(root, 'pausa');
  assert.equal(C.decidir(root, 'cursor', {}).motivo, 'CANAL_PAUSADO');
  assert.equal(C.decidir(root, 'claude', {}).continuar, false);
});

test('VIDA-5 sin trabajo y con vigilante vivo se puede parar (solo faltan decisiones del dueño)', () => {
  const root = proyecto(); arrancado(root);
  const est = T.leerEstado(root); est.rondas = { builder: Date.now() - 1000, director: Date.now() - 1000 };
  fs.writeFileSync(path.join(canal.dirEstado(root), 'estado.json'), JSON.stringify(est));
  // vigilante «vivo»: este mismo proceso con latido reciente
  const dir = path.join(canal.dirEstado(root), 'vigilantes'); fs.mkdirSync(dir, { recursive: true });
  for (const rol of ['director', 'builder']) fs.writeFileSync(path.join(dir, rol + '.json'), JSON.stringify({ rol, pid: process.pid, desde: new Date().toISOString(), latido: new Date().toISOString(), sondeo_s: 10 }));
  assert.equal(C.decidir(root, 'claude', {}).motivo, 'NADA_QUE_HACER');
  // el vigilante muere → se le pide relanzarlo aunque no haya trabajo
  fs.rmSync(path.join(dir, 'director.json'));
  const r = C.decidir(root, 'claude', {});
  assert.equal(r.continuar, true); assert.equal(r.motivo, 'SIN_VIGILANTE');
  assert.match(r.mensaje, /esperar --rol=director/);
});
