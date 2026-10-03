'use strict';

/**
 * metricas-servicio — métricas de ciclos sobre el historial completo, con el
 * catálogo de estado-ciclo. Lo usan el render del tablero y la API /api/v1,
 * para que la misma revisión dé los mismos números en todos los canales.
 */

const ec = require('./estado-ciclo.cjs');

/** Consultas de solo lectura que necesita metricasDeCiclos. Tabla ausente = sin dato. */
const CONSULTAS = {
  ciclosTodos: { tabla: 'ciclos', sql: 'SELECT id, ciclo_id, tarea, tipo_tarea, estado, stops_count, tests_generados, tests_pasando, fases_total, fases_completadas, review_blockers, context_guard, duracion_ms, patrones_aplicados, errores_evitados, fecha_inicio, fecha_fin FROM ciclos' },
  stopsEventos: { tabla: 'gate_events', sql: "SELECT id, event_id, incident_id, cycle_id FROM gate_events WHERE verdict = 'STOP'" },
  fasesAgg: { tabla: 'fases', sql: 'SELECT COUNT(*) n, SUM(CASE WHEN intentos > 1 THEN 1 ELSE 0 END) reintentos, SUM(CASE WHEN duracion_ms > 0 THEN 1 ELSE 0 END) con_dur, SUM(CASE WHEN duracion_ms > 0 THEN duracion_ms ELSE 0 END) ms FROM fases' },
  snapshots: { tabla: 'ciclos', sql: "SELECT snapshot_fin FROM ciclos WHERE snapshot_fin IS NOT NULL AND snapshot_fin != '' ORDER BY fecha_inicio ASC, id ASC" },
};

const largo = (json) => { try { const v = JSON.parse(json || '[]'); return Array.isArray(v) ? v.length : 0; } catch { return 0; } };

function metricasDeCiclos({ ciclos, eventosStop, fasesAgg, snapshots }) {
  const todos = ciclos || [];
  if (!todos.length) return null;
  const total = todos.length;
  const cierre = ec.resumenCierre(todos);
  const incidentes = ec.incidentesStop(todos, eventosStop);
  const autonomia = ec.autonomia(todos, eventosStop);
  const tests = ec.tasaTests(todos);
  const totalFases = todos.reduce((s, c) => s + (c.fases_total || 0), 0);
  const fasesOK = todos.reduce((s, c) => s + (c.fases_completadas || 0), 0);
  let patronesTotal = 0, erroresTotal = 0;
  for (const c of todos) { patronesTotal += largo(c.patrones_aplicados); erroresTotal += largo(c.errores_evitados); }
  const totalBlockers = todos.reduce((s, c) => s + (c.review_blockers || 0), 0);
  const conDur = todos.filter((c) => c.duracion_ms > 0);

  const tipoMap = {};
  for (const c of todos) {
    const t = c.tipo_tarea || 'feature';
    if (!tipoMap[t]) tipoMap[t] = { total: 0, ok: 0 };
    tipoMap[t].total++;
    if (ec.esCierreIntegro(c.estado)) tipoMap[t].ok++;
  }

  let evolucion_memoria = null;
  const conSnap = snapshots || [];
  if (conSnap.length >= 2) {
    try {
      const primero = JSON.parse(conSnap[0].snapshot_fin);
      const ultimo = JSON.parse(conSnap[conSnap.length - 1].snapshot_fin);
      const t = (s, k) => (s.totales && s.totales[k]) || 0;
      evolucion_memoria = { nodos_inicio: t(primero, 'total'), nodos_ahora: t(ultimo, 'total'), alta_inicio: t(primero, 'alta'), alta_ahora: t(ultimo, 'alta'), crecimiento: t(ultimo, 'total') - t(primero, 'total') };
    } catch { /* snapshot ilegible: sin evolución */ }
  }

  let reintento_rate = 0, avg_fase_ms = 0;
  if (fasesAgg && Number(fasesAgg.n) > 0) {
    reintento_rate = Math.round((Number(fasesAgg.reintentos || 0) / Number(fasesAgg.n)) * 100);
    avg_fase_ms = Number(fasesAgg.con_dur) > 0 ? Math.round(Number(fasesAgg.ms) / Number(fasesAgg.con_dur)) : 0;
  }

  return {
    total, completados: cierre.cerrados, stops: incidentes.total,
    goal_attainment: cierre.tasa_cierre, autonomy_ratio: autonomia.ratio,
    handoff_integrity: totalFases > 0 ? Math.round((fasesOK / totalFases) * 100) : null,
    drift_index: (totalBlockers / total).toFixed(1),
    guardrail_violations: todos.filter((c) => c.context_guard === 'STOP').length,
    patronesTotal, erroresTotal,
    test_rate: tests.tasa, testsGen: tests.ejecutadas, testsOK: tests.aprobadas,
    avg_duracion_ms: conDur.length ? Math.round(conDur.reduce((s, c) => s + c.duracion_ms, 0) / conDur.length) : 0,
    avg_fase_ms, reintento_rate,
    exito_por_tipo: Object.entries(tipoMap).map(([tipo, v]) => ({ tipo, total: v.total, ok: v.ok, rate: Math.round((v.ok / v.total) * 100) })),
    evolucion_memoria,
    cierre, incidentes, autonomia, tests,
    source: 'sqlite',
  };
}

module.exports = { CONSULTAS, metricasDeCiclos };
