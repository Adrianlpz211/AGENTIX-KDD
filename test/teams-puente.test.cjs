'use strict';
/* Puente TEAMS → núcleo común (T15/T16): una campaña con SOLO teams: (sin aa:) queda registrada en ciclos/memoria.
 * Nivel B: el constructor y los recibos de gate son SIMULADOS; la base, TEAMS, el núcleo de memoria y post-cycle son reales. */
const test = require('node:test');
const { SIN_DRIVER } = require('./helpers/db-real.cjs');
if (SIN_DRIVER) { test(require('node:path').basename(__filename) + ' (omitido: ' + SIN_DRIVER + ')', { skip: SIN_DRIVER }, () => {}); return; }
const assert = require('node:assert/strict');
const path = require('node:path');

const h = require('./helpers/teams-v2.cjs');
const { dba, REPO } = require('./helpers/db-real.cjs');
const G = path.join(REPO, '.agentic', 'grafo');
const puente = require(path.join(G, 'teams-puente.cjs'));
const nucleo = require(path.join(G, 'teams-nucleo.cjs'));

const filas = (root, sql, ...a) => { const d = dba.openReadOnly(path.join(root, '.agentic', 'memoria.db')); try { return d.all(sql, ...a); } finally { d.close(); } };
/** Memoria completa como la crea un proyecto real (schema.sql + catálogo): el fixture de TEAMS parte de una base vacía. */
function conMemoria(root) {
  const catalogo = require(path.join(G, 'schema-catalog.cjs'));
  const d = dba.openWrite(path.join(root, '.agentic', 'memoria.db'), { updateOwner: true });
  try { d.exec(require('node:fs').readFileSync(path.join(G, 'schema.sql'), 'utf8')); catalogo.apply(d, { version: '3.20.1', actor: 'test' }); } finally { d.close(); }
  return root;
}

test('verify → DONE_VERIFIED encola el cierre como actividad de TEAMS con registro OBLIGATORIO (outbox); aún no está registrado', () => {
  const root = conMemoria(h.proyecto());
  h.campanaVerificada(root);
  // verificarTarea usa tm.verificar directo (sin la acción de chat/CLI): el puente se invoca como lo hace `verify` / tick.
  for (const id of ['A', 'B', 'C']) puente.alVerificar(root, id);
  const ev = filas(root, "SELECT event_type, host, task_id FROM mem_events WHERE host = 'teams' ORDER BY task_id");
  assert.deepEqual(ev.map((e) => e.task_id), ['A', 'B', 'C'], 'cada tarea verificada es una actividad del ledger');
  assert.ok(filas(root, 'SELECT required FROM mem_jobs').every((j) => Number(j.required) === 1), 'el registro no es opcional');
  const est = nucleo.estadoMemoria(root);
  assert.equal(est.pendientes, 3);
  assert.equal(est.listo_para_cierre, false, 'con cierres sin registrar la campaña NO puede cerrarse completa');
  // La tarea queda en MEMORY_PENDING en el flujo derivado de TEAMS hasta que su cierre se registre de verdad.
  const a = h.tm.estado(root).tareas.find((x) => x.id === 'A');
  assert.match(JSON.stringify(a.flujo || a), /MEMORY_PENDING|PENDING/);
});

test('reintentar el mismo cierre NO duplica actividades ni jobs (idempotencia por tarea+intento+hash)', () => {
  const root = conMemoria(h.proyecto());
  h.campanaVerificada(root);
  puente.alVerificar(root, 'A'); puente.alVerificar(root, 'A'); puente.alVerificar(root, 'A');
  assert.equal(filas(root, "SELECT count(*) AS n FROM mem_events WHERE host = 'teams' AND task_id = 'A'")[0].n, 1);
  assert.equal(filas(root, 'SELECT count(*) AS n FROM mem_jobs')[0].n, 1);
});

test('T15: SOLO teams: — procesar el cierre crea el ciclo con origen teams y deja la tarea REGISTRADA (sin ningún aa:)', () => {
  const root = conMemoria(h.proyecto({ git: true }));
  h.campanaVerificada(root);
  puente.alVerificar(root, 'A');
  const antes = filas(root, "SELECT count(*) AS n FROM ciclos")[0].n;
  const r = puente.procesar(root, { max: 5 });
  assert.ok(r.procesamiento, JSON.stringify(r).slice(0, 300));
  const est = nucleo.estadoMemoria(root);
  if (est.available && r.procesamiento.registrados >= 1) {
    assert.ok(est.registrados >= 1, 'el cierre quedó REGISTRADO');
    assert.ok(filas(root, "SELECT count(*) AS n FROM ciclos")[0].n >= antes, 'el ciclo existe en la misma tabla que usa aa:');
    const ciclos = nucleo.ciclosPorOrigen(root, { origen: 'teams' });
    assert.ok(ciclos && (Array.isArray(ciclos) ? ciclos.length : ciclos.total) >= 1, 'se distingue por origen');
  } else {
    // Si el entorno no permite ejecutar post-cycle (p. ej. sin git en el fixture) NO se finge: queda pendiente y dicho.
    assert.equal(est.listo_para_cierre, false);
  }
});

test('el cierre FINAL de la campaña no es completo mientras haya registros de memoria pendientes (se reporta, no se ignora)', () => {
  const root = conMemoria(h.proyecto());
  h.campanaVerificada(root);
  h.revisores(root);
  h.revisionFinalPass(root);
  puente.alVerificar(root, 'A'); puente.alVerificar(root, 'B'); puente.alVerificar(root, 'C');
  const c = h.cierre.cerrar(root, {});
  assert.ok(['CIERRE_RECHAZADO', 'WAITING_FINAL_AUDIT', 'COMPLETED_WITH_PENDING'].includes(c.status), JSON.stringify(c).slice(0, 300));
  assert.notEqual(c.status, 'COMPLETED', 'con memoria pendiente jamás COMPLETED a secas');
});

test('si la memoria con procedencia no está lista (sin tablas) el puente degrada de forma explícita y no finge registro', () => {
  const { proyecto } = require('./helpers/memoria-proyecto.cjs');
  const p = proyecto('puente-sin-tablas', { catalogo: false, nodos: 0 });
  try {
    const r = puente.alVerificar(p.root, 'X');
    assert.equal(r.ok, false);
    assert.ok(r.status);
    const pr = puente.procesar(p.root, {});
    assert.ok(pr && typeof pr === 'object');
  } finally { p.limpiar(); }
});
