'use strict';
/* Retomar tras una pausa (medinet / protocolo_reserva, 10/10/2026): al continuar, el constructor recibía solo «corre ronda». Ahora `pausa` guarda DÓNDE
   quedó cada rol y `continuar` imprime el bloque RETOMA (dónde quedaste, qué cambió, primera acción) y, desde el Director, el mensaje listo para pegar
   en Cursor (también tras `reabrir`). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const G = path.join(__dirname, '..', '.agentic', 'grafo');
const T = require(path.join(G, 'teams.cjs'));
const R = require(path.join(G, 'teams-retoma.cjs'));

process.env.AKDD_TEAMS_NO_AVISO = '1';   // las pruebas nunca mandan nada al teléfono

function proyecto() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-retoma-'));
  fs.mkdirSync(path.join(root, '.agentic'), { recursive: true });
  return root;
}
const run = (root, ...a) => T.ejecutar(a, root);
const salida = (root, ...a) => run(root, ...a).out;
const tarea = (root, t) => salida(root, 'tarea', t, '--criterio=hecho', '--sin-contexto');
function arrancado(root) { run(root, 'activar'); run(root, 'modo', 'completo'); run(root, 'iniciar'); }

test('RT-1 pausa guarda el punto de retoma: lo que iba PARCIAL, la cola y el último reporte', () => {
  const root = proyecto(); arrancado(root);
  tarea(root, 'Pantalla de pagos'); tarea(root, 'Pantalla de citas');
  salida(root, 'reportar', 'T-001', '--estado=PARCIAL', '--detalle=falta el estado de error y el test');
  run(root, 'pausa');
  const snap = T.leerEstado(root).retoma;
  assert.ok(snap && snap.at, 'hay instantánea');
  assert.equal(snap.parciales.length, 1);
  assert.equal(snap.parciales[0].id, 'T-001');
  assert.match(snap.parciales[0].detalle, /falta el estado de error/);
  assert.equal(snap.ultimo_reporte.id, 'T-001');
  assert.deepEqual(snap.cola.map((t) => t.id), ['T-001', 'T-002'], 'lo PARCIAL sigue pendiente, por eso también está en la cola');
});

test('RT-2 continuar (constructor): dónde quedó + qué cambió durante la pausa + primera acción', () => {
  const root = proyecto(); arrancado(root);
  tarea(root, 'Pantalla de pagos'); tarea(root, 'Pantalla de citas');
  salida(root, 'reportar', 'T-001', '--estado=PARCIAL', '--detalle=falta el estado de error y el test');
  run(root, 'pausa');
  // mientras el constructor no estaba, el Director encola y corrige
  tarea(root, 'Tarea nueva del Director');
  salida(root, 'corregir', 'escapar el HTML del buscador', '--sev=HALLAZGO', '--archivo=src/b.js:3');
  const out = salida(root, 'continuar', '--rol=builder');
  assert.match(out, /RETOMA — CONSTRUCTOR/);
  assert.match(out, /Iba en curso \(PARCIAL\)/);
  assert.match(out, /T-001 — Pantalla de pagos/);
  assert.match(out, /falta el estado de error y el test/);
  assert.match(out, /Qué cambió mientras estuvo pausado/);
  assert.match(out, /NUEVA tarea T-003 — Tarea nueva del Director/);
  assert.match(out, /NUEVA corrección C-001/);
  assert.match(out, /PRIMERA ACCIÓN: Retoma T-001/, 'lo parcial va primero');
});

test('RT-3 sin nada parcial: las correcciones van antes que la cola; sin cola, avisa que quedó libre', () => {
  const root = proyecto(); arrancado(root);
  tarea(root, 'Una tarea');
  run(root, 'pausa');
  salida(root, 'corregir', 'validar el tenant', '--sev=BLOQUEANTE', '--archivo=src/q.js:4');
  let out = salida(root, 'continuar', '--rol=builder');
  assert.match(out, /PRIMERA ACCIÓN: Resuelve primero C-001/);
  const root2 = proyecto(); arrancado(root2);
  run(root2, 'pausa');
  out = salida(root2, 'continuar', '--rol=builder');
  assert.match(out, /Mientras estuvo pausado no cambió nada/);
  assert.match(out, /nada en cola/i);
});

test('RT-4 continuar (Director): trae el mensaje listo para pegar en Cursor', () => {
  const root = proyecto(); arrancado(root);
  tarea(root, 'Una tarea');
  run(root, 'pausa');
  const out = salida(root, 'continuar', '--rol=director');
  assert.match(out, /RETOMA — DIRECTOR/);
  assert.match(out, /PEGA ESTO en el chat de Cursor/);
  assert.match(out, /teams: continuar — retoma donde quedaste/);
  assert.match(out, /continuar --rol=builder/);
});

test('RT-5 reabrir también imprime el mensaje para Cursor (las tareas nuevas no lo despiertan solas)', () => {
  const root = proyecto(); arrancado(root);
  run(root, 'cerrar');
  const out = salida(root, 'reabrir');
  assert.match(out, /Canal ACTIVO otra vez/);
  assert.match(out, /PEGA ESTO en el chat de Cursor/);
  assert.match(out, /teams: continuar — retoma donde quedaste/);
});

test('RT-6 una pausa anterior a esta versión (sin instantánea) no rompe: solo dice dónde está', () => {
  const root = proyecto(); arrancado(root);
  tarea(root, 'Una tarea');
  run(root, 'pausa');
  const est = T.leerEstado(root); delete est.retoma;
  const canal = require(path.join(G, 'teams-canal.cjs'));
  fs.writeFileSync(path.join(canal.dirEstado(root), 'estado.json'), JSON.stringify(est));
  const out = salida(root, 'continuar', '--rol=builder');
  assert.match(out, /RETOMA — CONSTRUCTOR/);
  assert.doesNotMatch(out, /Qué cambió mientras estuvo pausado/, 'sin instantánea no se inventa un antes/después');
  assert.match(out, /PRIMERA ACCIÓN: Toma T-001/);
});

test('RT-7 el módulo es puro y tolera entradas vacías', () => {
  const e = { tareas: [], correcciones: [], tareasPend: [], corrPend: [], hechasSinAceptar: [], devueltas: [], decididasDueno: [], rondas: {} };
  const snap = R.instantanea(e);
  assert.deepEqual(R.cambios(e, snap), { tareasNuevas: [], correccionesNuevas: [], correccionesResueltas: [], estados: [], decisiones: [] });
  assert.ok(R.bloque(e, 'builder', snap).length >= 3);
  assert.ok(R.bloque(e, 'director', null).length >= 3);
  assert.equal(R.hace(5 * 60000), '5 min');
  assert.match(R.hace(125 * 60000), /2 h 05 min/);
});
