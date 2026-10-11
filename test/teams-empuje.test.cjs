'use strict';
/* Cursor se paraba y había que pasarle varios mensajes para que retomara (medinet, protocolo_reserva, 10-11/10/2026). Causas en nuestro código:
   · el gancho de parada solo armaba al rol si hacía una ronda en las últimas 6 h: tras días de pausa, `continuar` no lo armaba;
   · cortábamos el encadenado tras 2 seguimientos y Cursor limita a 5 por defecto (loop_limit);
   · el seguimiento era un «lee las reglas y corre la ronda»: modelo de jalar, no de empujar.
   Ahora el gancho le ENTREGA a Cursor el siguiente ítem completo, con `aa:`, y mantiene armado a su rol. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const G = path.join(__dirname, '..', '.agentic', 'grafo');
const T = require(path.join(G, 'teams.cjs'));
const canal = require(path.join(G, 'teams-canal.cjs'));
const C = require(path.join(G, 'teams-continuidad.cjs'));
const HH = require(path.join(G, 'host-hooks.cjs'));

process.env.AKDD_TEAMS_NO_AVISO = '1';

function proyecto() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-empuje-'));
  fs.mkdirSync(path.join(root, '.agentic'), { recursive: true });
  return root;
}
const run = (root, ...a) => T.ejecutar(a, root);
const salida = (root, ...a) => run(root, ...a).out;
function arrancado(root) { run(root, 'activar'); run(root, 'modo', 'completo'); run(root, 'iniciar'); }
const tarea = (root, t, ...extra) => salida(root, 'tarea', t, '--criterio=muestra el error y no pierde datos', '--sin-contexto', ...extra);
function vigilanteVivo(root) { // un vigilante «vivo» para no mezclar el aviso de vigilante con lo que se prueba
  const f = path.join(canal.dirEstado(root), 'vigilantes'); fs.mkdirSync(f, { recursive: true });
  for (const rol of ['director', 'builder']) fs.writeFileSync(path.join(f, rol + '.json'), JSON.stringify({ pid: process.pid, latido: new Date().toISOString(), sondeo_s: 10, desde: new Date().toISOString() }));
}
function estado(root, fn) { const est = T.leerEstado(root); fn(est); T.guardarEstado(root, est); }
const armar = (root) => estado(root, (est) => { est.armado = Object.assign({}, est.armado, { builder: Date.now() }); });   // lo que hace `continuar --rol=builder`

test('EM-1 el gancho de Cursor ENTREGA la tarea completa, con aa:, y dice cómo reportarla y cuántas quedan', () => {
  const root = proyecto(); arrancado(root); vigilanteVivo(root);
  tarea(root, 'Pantalla de pagos'); tarea(root, 'Pantalla de citas'); armar(root);
  const r = C.decidir(root, 'cursor', { loop_count: 0 });
  assert.equal(r.continuar, true, JSON.stringify(r));
  assert.match(r.mensaje, /^aa: \[TEAMS\] Trabaja T-001 — Pantalla de pagos/);
  assert.match(r.mensaje, /muestra el error y no pierde datos/, 'trae los criterios de la tarea');
  assert.match(r.mensaje, /reportar T-001 --estado=HECHO/);
  assert.match(r.mensaje, /quedan 1 más en la cola/);
  assert.doesNotMatch(r.mensaje, /lee las reglas/i);
  assert.deepEqual(Object.keys(C.salidaParaHost('cursor', r)), ['followup_message']);
});

test('EM-2 orden del siguiente ítem: lo PARCIAL, luego las correcciones, luego la cola', () => {
  const root = proyecto(); arrancado(root); vigilanteVivo(root);
  tarea(root, 'Primera'); tarea(root, 'Segunda'); armar(root);
  salida(root, 'corregir', 'escapar el HTML del buscador', '--sev=HALLAZGO', '--archivo=src/b.js:3');
  let r = C.decidir(root, 'cursor', { loop_count: 0 });
  assert.match(r.mensaje, /^aa: \[TEAMS\] Resuelve la corrección C-001/, 'la corrección va antes que la cola');
  assert.match(r.mensaje, /resolver C-001 "qué hiciste"/);
  salida(root, 'reportar', 'T-002', '--estado=PARCIAL', '--detalle=falta el estado de error');
  estado(root, (est) => { est.seen = {}; });
  r = C.decidir(root, 'cursor', { loop_count: 0 });
  assert.match(r.mensaje, /^aa: \[TEAMS\] Trabaja T-002/, 'lo parcial va primero');
  assert.match(r.mensaje, /Iba PARCIAL: "falta el estado de error\.?"/);
});

test('EM-3 tras días de pausa, continuar ARMA al rol: antes el gancho no actuaba hasta que corriera una ronda', () => {
  const root = proyecto(); arrancado(root); vigilanteVivo(root);
  tarea(root, 'Una tarea');
  run(root, 'pausa');
  const dia = 24 * 3600 * 1000;
  estado(root, (est) => { est.rondas = { builder: Date.now() - 3 * dia, director: Date.now() - 3 * dia }; est.armado = {}; });
  run(root, 'continuar', '--rol=builder');   // reactiva el canal y arma
  estado(root, (est) => { est.rondas = { builder: Date.now() - 3 * dia }; });   // ni una ronda hecha todavía
  const r = C.decidir(root, 'cursor', { loop_count: 0 });
  assert.equal(r.continuar, true, 'armado por continuar: ' + JSON.stringify(r));
  // y sin armar (estado viejo) el gancho no obliga a una conversación cualquiera
  estado(root, (est) => { est.armado = {}; });
  assert.equal(C.decidir(root, 'cursor', { loop_count: 0 }).motivo, 'NO_ES_ESTE_ROL');
});

test('EM-4 el gancho que empuja mantiene armado a su rol (sin rondas manuales no hay otra marca de vida)', () => {
  const root = proyecto(); arrancado(root); vigilanteVivo(root);
  tarea(root, 'Una tarea');
  estado(root, (est) => { est.armado = {}; est.rondas = { builder: Date.now() - 60000 }; });
  const antes = Date.now();
  assert.equal(C.decidir(root, 'cursor', { loop_count: 0 }).continuar, true);
  assert.ok(T.leerEstado(root).armado.builder >= antes, 'quedó armado');
  const s = T.salud(root);
  assert.equal(s.roles.builder.loop, 'ACTIVO', 'el semáforo ve el empuje como loop activo');
});

test('EM-5 ya no cortamos a los 2 seguimientos: Cursor encadena hasta el tope de seguridad', () => {
  const root = proyecto(); arrancado(root); vigilanteVivo(root);
  tarea(root, 'Una tarea larga'); armar(root);
  assert.equal(C.decidir(root, 'cursor', { loop_count: 2 }).continuar, true);
  assert.equal(C.decidir(root, 'cursor', { loop_count: 4 }).continuar, true);
  const tope = C.decidir(root, 'cursor', { loop_count: C.LOOP_MAX });
  assert.equal(tope.continuar, false);
  assert.equal(tope.motivo, 'TOPE_DE_SEGUIMIENTOS');
});

test('EM-6 una tarea larga con el mismo pendiente NO se marca dormida mientras sigue tocando código; sin avance, sí', () => {
  const root = proyecto(); arrancado(root); vigilanteVivo(root);
  tarea(root, 'Tarea larga'); armar(root);
  tarea(root, 'Tarea larga');
  process.env.AKDD_TEAMS_ULTIMO_CAMBIO = String(Date.now() - 30000);   // tocó código hace 30 s
  try {
    for (let i = 0; i < C.MAX_SEGUIDAS + 3; i++) assert.equal(C.decidir(root, 'cursor', { loop_count: i }).continuar, true, 'turno ' + i);
  } finally { delete process.env.AKDD_TEAMS_ULTIMO_CAMBIO; }
  const root2 = proyecto(); arrancado(root2); vigilanteVivo(root2);
  tarea(root2, 'Tarea larga'); armar(root2);
  process.env.AKDD_TEAMS_ULTIMO_CAMBIO = String(Date.now() - 5 * 3600 * 1000);   // nada desde hace horas
  try {
    const motivos = []; for (let i = 0; i < C.MAX_SEGUIDAS + 2; i++) motivos.push(C.decidir(root2, 'cursor', { loop_count: i }).motivo);
    assert.ok(motivos.includes('FRENO_ANTIBUCLE'), motivos.join(','));
  } finally { delete process.env.AKDD_TEAMS_ULTIMO_CAMBIO; }
});

test('EM-7 el hooks.json de Cursor sale con loop_limit: null en el stop de TEAMS (sin el tope de 5 por defecto)', () => {
  const root = proyecto();
  const r = HH.instalar(root, 'cursor');
  assert.equal(r.ok, true);
  const cfg = JSON.parse(fs.readFileSync(path.join(root, '.cursor', 'hooks.json'), 'utf8'));
  const stop = cfg.hooks.stop.find((x) => /host-guard\.cjs.*--event=stop/.test(x.command));
  assert.ok(stop, 'hay un stop de host-guard');
  assert.ok('loop_limit' in stop && stop.loop_limit === null, JSON.stringify(stop));
});
