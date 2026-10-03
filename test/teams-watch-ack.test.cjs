'use strict';

/* C02 — la vigilancia entrega, no solo imprime. Detectado, entregado y
   aceptado son distintos; el ACK del rol solo avanza con aceptación
   explícita (también tras una Promise); el diagnóstico tiene cursor propio. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const G = path.join(__dirname, '..', '.agentic', 'grafo');
const tm = require(path.join(G, 'teams-manager.cjs'));
const ad = require(path.join(G, 'teams-adapters.cjs'));
const tw = require(path.join(G, 'teams-watch.cjs'));

function proyecto() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-c02-'));
  fs.mkdirSync(path.join(root, '.agentic'));
  fs.writeFileSync(path.join(root, '.agentic', 'config.md'), 'CONFIGURADO: SI\n');
  require(path.join(G, 'db-adapter.cjs')).openWrite(path.join(root, '.agentic', 'memoria.db')).close();
  assert.strictEqual(tm.init(root, { aprobarMigracion: true }).status, 'ACTIVO');
  const tareas = ['A', 'B', 'C'].map((id) => ({ id, objective: 't ' + id, acceptance: ['c ' + id], allowed_files: ['src/' + id + '.js'] }));
  tm.crearPlan(root, { objective: 'o', sprints: [{ tasks: tareas }] });
  return root;
}
const asignar = (root, n = 1) => { for (let i = 0; i < n; i++) tm.asignar(root, { owner_id: 'b' + Math.random() }); };
const pendientes = (root) => tm.delta(root, { rol: 'builder' }).eventos.length;
const vigilar = (root, onTrabajo, extra) => new tw.Vigilancia(root, Object.assign({ rol: 'builder', sinLimites: true, watcher: false, timer: false, onTrabajo }, extra));

test('C02: imprimir o no responder no es aceptar; solo true o {aceptado} mueve el ACK', () => {
  const root = proyecto();
  asignar(root);
  const v = vigilar(root, () => undefined);
  v.revisar('prueba');
  assert.ok(pendientes(root) > 0, 'sin aceptación explícita no hay ACK');
  assert.ok(v.stats.detectados > 0 && v.stats.entregados > 0);
  assert.strictEqual(v.stats.aceptados, 0);
  const ok = vigilar(root, () => ({ aceptado: true }));
  ok.revisar('prueba');
  assert.strictEqual(pendientes(root), 0);
  assert.ok(ok.stats.aceptados > 0);
});

test('C02: con Promise el ACK espera al resultado; rechazo no hace ACK y el siguiente pase reintenta', async () => {
  const root = proyecto();
  asignar(root);
  let soltar;
  const v = vigilar(root, () => new Promise((r) => { soltar = r; }));
  const espera = v.revisar('prueba');
  assert.ok(espera && typeof espera.then === 'function');
  assert.ok(pendientes(root) > 0, 'Promise pendiente: todavía no hay ACK');
  soltar(true);
  await espera;
  assert.strictEqual(pendientes(root), 0);

  asignar(root);
  const vistos = [];
  let falla = true;
  const r = vigilar(root, async (evs) => { vistos.push(...evs.map((e) => e.event_id)); if (falla) throw new Error('sesión ocupada'); return true; });
  await r.revisar('prueba');
  assert.strictEqual(r.stats.rechazos, 1);
  assert.ok(pendientes(root) > 0, 'rechazo: sin ACK');
  falla = false;
  await r.revisar('reintento');
  assert.strictEqual(pendientes(root), 0);
  assert.strictEqual(new Set(vistos).size, vistos.length / 2, 'el reintento entrega los mismos eventos, no otros');
});

test('C02: aceptación parcial confirma solo hasta lo aceptado', () => {
  const root = proyecto();
  asignar(root, 2);
  const evs = tm.delta(root, { rol: 'builder' }).eventos;
  assert.ok(evs.length >= 2);
  vigilar(root, () => ({ aceptado: true, hasta_seq: evs[0].seq })).revisar('prueba');
  assert.deepStrictEqual(tm.delta(root, { rol: 'builder' }).eventos.map((e) => e.seq), evs.slice(1).map((e) => e.seq));
});

test('C02: el diagnóstico usa cursor propio y no consume el ACK del rol', () => {
  const root = proyecto();
  asignar(root);
  const antes = pendientes(root);
  const impresos = [];
  const diag = vigilar(root, (evs) => { impresos.push(...evs.map((e) => e.seq)); return true; }, { cursor: 'propio' });
  diag.revisar('a');
  diag.revisar('b');
  assert.strictEqual(pendientes(root), antes, 'el rol operativo sigue con su trabajo pendiente');
  assert.strictEqual(new Set(impresos).size, impresos.length, 'el diagnóstico no reimprime');
  assert.ok(impresos.length > 0);
});

test('C02: ACK perdido no duplica la ejecución; sin novedades no se llama al manejador', () => {
  const root = proyecto();
  asignar(root);
  const ejecutados = new Set();
  let ejecuciones = 0;
  const consumidor = (evs) => { for (const e of evs) if (!ejecutados.has(e.event_id)) { ejecutados.add(e.event_id); ejecuciones++; } };
  const caida = vigilar(root, (evs) => { consumidor(evs); throw new Error('proceso muerto antes del ACK'); });
  caida.revisar('a');
  const tras = ejecuciones;
  const sana = vigilar(root, (evs) => { consumidor(evs); return true; });
  sana.revisar('reinicio');
  assert.strictEqual(ejecuciones, tras, 'reentrega idempotente por event_id');
  let llamadas = 0;
  const quieta = vigilar(root, () => { llamadas++; return true; });
  quieta.revisar('x'); quieta.revisar('y');
  assert.strictEqual(llamadas, 0, 'sin trabajo: cero turnos de modelo');
});

test('C02: el adapter manual o sin vía de entrega nunca acepta', async () => {
  const root = proyecto();
  asignar(root);
  const manual = tw.entregarConAdapter(new ad.AdapterManual(root));
  const v = vigilar(root, manual);
  await v.revisar('prueba');
  assert.ok(pendientes(root) > 0);
  assert.strictEqual(v.stats.aceptados, 0);
  const acepta = tw.entregarConAdapter({ entregarEventos: async (evs) => ({ aceptado: true, hasta_seq: evs[evs.length - 1].seq }) });
  await vigilar(root, acepta).revisar('prueba');
  assert.strictEqual(pendientes(root), 0);
});

test('C02: script de Windows propio, sin ventana ni credenciales, con logs rotados', () => {
  const root = proyecto();
  const s = tw.scriptTareaWindows(root, 'builder');
  assert.match(s.nombre, /^AgentixTeams-[0-9a-f]{8}-builder$/);
  assert.match(s.instalar, /--headless/);
  assert.match(s.instalar, /--entregar/);
  assert.match(s.instalar, /RestartCount/);
  assert.doesNotMatch(s.instalar, /-Password|-User /);
  assert.ok(s.limites.some((l) => /no despierta al modelo/.test(l)));
  const f = path.join(root, '.agentic', '_teams', 'w.log');
  const log = tw.logRotado(f, { maxBytes: 50, copias: 2 });
  for (let i = 0; i < 10; i++) log('linea ' + i + ' ' + 'x'.repeat(20));
  assert.ok(fs.existsSync(f + '.1'));
  assert.ok(!fs.existsSync(f + '.3'));
});
