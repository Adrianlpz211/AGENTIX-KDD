'use strict';

/**
 * Estado final de un ciclo, deducido de lo que devolvieron los gates.
 * Un gate requerido que falla nunca deja "completado"; uno sin evidencia
 * deja pendientes, no éxito.
 *
 *   r.contratos     resultado del TDD gate ({ success, status })
 *   r.preservation  resultado del Preservation Gate ({ status })
 *   r.pipeline      cierre del pipeline-controller ({ status: PASS|FAIL|PENDING|UNVERIFIED })
 */
function estadoFinal(r) {
  const tdd = (r && r.contratos) || {};
  const pg = (r && r.preservation) || null;
  const harness = (r && r.pipeline) || null;
  if (tdd.status === 'BLOCKED') return 'BLOQUEADO';
  if (tdd.status === 'FAIL' || tdd.status === 'NEEDS_REPAIR' || (pg && pg.status === 'FAIL')) return 'FALLIDO';
  if (harness && harness.status === 'FAIL') return 'FALLIDO';
  if (harness && harness.status === 'ERROR') return 'FALLIDO';
  // PENDING, UNVERIFIED o cualquier otro: sin la evidencia exigida no hay "verificado".
  if (harness && harness.status !== 'PASS') return 'COMPLETADO_CON_PENDIENTES';
  if (tdd.success && tdd.status === 'PASS' && (!pg || pg.status === 'PASS' || pg.status === 'SKIP')) {
    return 'COMPLETADO_VERIFICADO';
  }
  return 'COMPLETADO_CON_PENDIENTES';
}

/* ─── Catálogo de cierre ───────────────────────────────────────────────────
   Lo usan el tablero, el CLI, las métricas y el rastro de decisiones, para que
   todos cuenten igual. "COMPLETADO" a secas es de antes de los veredictos: el
   ciclo se cerró, pero nadie dejó evidencia por sujeto, así que no es
   "verificado". Un parcial nunca es cierre íntegro. */
const CLASE_POR_ESTADO = {
  COMPLETADO_VERIFICADO: 'VERIFICADO',
  COMPLETADO: 'COMPLETADO_SIN_VEREDICTO',
  COMPLETADO_CON_PENDIENTES: 'CON_PENDIENTES',
  STOP: 'DETENIDO', BLOQUEADO: 'DETENIDO', ESPERA_HUMANA: 'DETENIDO',
  FALLIDO: 'FALLIDO', ERROR: 'FALLIDO',
  CANCELADO: 'CANCELADO', ABORTADO: 'CANCELADO',
  EN_CURSO: 'EN_CURSO', EN_PROGRESO: 'EN_CURSO', INICIADO: 'EN_CURSO',
};
const CLASES = ['VERIFICADO', 'COMPLETADO_SIN_VEREDICTO', 'CON_PENDIENTES', 'DETENIDO', 'FALLIDO', 'CANCELADO', 'EN_CURSO', 'DESCONOCIDO'];
const CIERRE_INTEGRO = new Set(['VERIFICADO', 'COMPLETADO_SIN_VEREDICTO']);
/** Ciclos con un resultado que se puede juzgar; en curso, cancelado o desconocido no. */
const CON_RESULTADO = new Set(['VERIFICADO', 'COMPLETADO_SIN_VEREDICTO', 'CON_PENDIENTES', 'DETENIDO', 'FALLIDO']);

function clasificar(estado) {
  return CLASE_POR_ESTADO[String(estado || '').trim().toUpperCase()] || 'DESCONOCIDO';
}
const esCierreIntegro = (estado) => CIERRE_INTEGRO.has(clasificar(estado));

function resumenCierre(ciclos) {
  const lista = ciclos || [];
  const por_clase = Object.fromEntries(CLASES.map((c) => [c, 0]));
  for (const c of lista) por_clase[clasificar(c.estado)]++;
  const cerrados = por_clase.VERIFICADO + por_clase.COMPLETADO_SIN_VEREDICTO;
  return {
    total: lista.length,
    por_clase,
    cerrados,
    verificados: por_clase.VERIFICADO,
    tasa_cierre: lista.length ? Math.round((cerrados * 100) / lista.length) : null,
    pendientes: lista.filter((c) => clasificar(c.estado) === 'CON_PENDIENTES').slice(0, 10).map((c) => ({ ciclo_id: c.ciclo_id || null, tarea: c.tarea || null })),
  };
}

const claveIncidente = (e) => e.incident_id || e.event_id || 'row-' + e.id;

function stopsPorCiclo(eventosStop) {
  const vistos = new Map();
  for (const e of eventosStop || []) { const k = claveIncidente(e); if (!vistos.has(k)) vistos.set(k, e.cycle_id || null); }
  const porCiclo = new Map();
  let sinCiclo = 0;
  for (const cid of vistos.values()) {
    if (cid) porCiclo.set(cid, (porCiclo.get(cid) || 0) + 1); else sinCiclo++;
  }
  return { porCiclo, sinCiclo };
}

/* stops_count del ciclo y los eventos STOP enlazados a él describen el mismo
   incidente: se toma el mayor, no la suma. Un STOP de un ciclo viejo sin
   contador ni eventos cuenta como uno. */
function stopsDelCiclo(c, porCiclo) {
  const ev = (porCiclo && porCiclo.get(c.ciclo_id)) || 0;
  const n = Math.max(Number(c.stops_count) || 0, ev);
  return n === 0 && String(c.estado || '').toUpperCase() === 'STOP' ? 1 : n;
}

function incidentesStop(ciclos, eventosStop) {
  const { porCiclo, sinCiclo } = stopsPorCiclo(eventosStop);
  const ids = new Set((ciclos || []).map((c) => c.ciclo_id));
  let enCiclos = 0;
  for (const c of ciclos || []) enCiclos += stopsDelCiclo(c, porCiclo);
  let otros = 0;
  for (const [cid, n] of porCiclo) if (!ids.has(cid)) otros += n;
  return { total: enCiclos + sinCiclo + otros, en_ciclos: enCiclos, sin_ciclo: sinCiclo + otros };
}

/** Autonomía = ciclos cerrados íntegros sin STOP / ciclos con resultado. */
function autonomia(ciclos, eventosStop) {
  const { porCiclo } = stopsPorCiclo(eventosStop);
  const lista = ciclos || [];
  const elegibles = lista.filter((c) => CON_RESULTADO.has(clasificar(c.estado)));
  const sinIntervencion = elegibles.filter((c) => esCierreIntegro(c.estado) && stopsDelCiclo(c, porCiclo) === 0).length;
  return {
    ratio: elegibles.length ? Math.round((sinIntervencion * 100) / elegibles.length) : null,
    observadas: elegibles.length,
    sin_intervencion: sinIntervencion,
    excluidas: lista.length - elegibles.length,
    definicion: 'ciclos cerrados sin STOP / ciclos con resultado (en curso, cancelados y desconocidos no cuentan)',
  };
}

/* tests_generados lo escribe el cierre como aprobadas + fallidas: es el universo
   ejecutado. Un ciclo con más aprobadas que ejecutadas no se suma: se declara. */
function tasaTests(ciclos) {
  let aprobadas = 0, ejecutadas = 0, sinEjecucion = 0;
  const inconsistentes = [];
  for (const c of ciclos || []) {
    const g = Number(c.tests_generados) || 0, p = Number(c.tests_pasando) || 0;
    if (g === 0 && p === 0) { sinEjecucion++; continue; }
    if (p > g) { inconsistentes.push(c.ciclo_id || null); continue; }
    aprobadas += p; ejecutadas += g;
  }
  return {
    status: inconsistentes.length ? 'DATA_INCONSISTENT' : ejecutadas ? 'OK' : 'UNAVAILABLE',
    aprobadas, ejecutadas,
    tasa: ejecutadas ? Math.round((aprobadas * 100) / ejecutadas) : null,
    sin_ejecucion: sinEjecucion,
    inconsistentes,
  };
}

const ICONO = { VERIFICADO: '✅', COMPLETADO_SIN_VEREDICTO: '✅', CON_PENDIENTES: '🟡', DETENIDO: '🛑', FALLIDO: '❌', CANCELADO: '⏹', EN_CURSO: '⏳', DESCONOCIDO: '❔' };
const icono = (estado) => ICONO[clasificar(estado)];

/**
 * Los STOP que el cierre del ciclo DEBE dejar en la libreta aunque la compuerta no los haya escrito sola. Caso medinet: ciclos en estado
 * BLOQUEADO (TDD en BLOCKED) con `stops_count` 0 porque el TDD gate frenaba sin dejar el evento con el id del ciclo. Un ciclo bloqueado
 * por una compuerta ES un STOP: si no queda contado, el 0 de stops_count miente.
 */
function stopsDeCierre(r) {
  const tdd = (r && r.contratos) || {};
  const out = [];
  if (tdd.status === 'BLOCKED') out.push({ gate: 'tdd', motivo: String(tdd.reason_code || tdd.reason || 'BLOCKED').slice(0, 120) });
  return out;
}

module.exports = {
  stopsDeCierre,
  estadoFinal, clasificar, esCierreIntegro, resumenCierre, incidentesStop, autonomia, tasaTests, stopsDelCiclo, stopsPorCiclo, icono,
  CLASES, CLASE_POR_ESTADO,
};
