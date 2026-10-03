'use strict';

/* Texto, título y color de las tarjetas de métricas. Lo usa el render del
   servidor y, inyectado, el navegador al recibir una revisión nueva: una sola
   política para los dos. Escrito con `var` y sin dependencias para poder
   inyectarse con toString(). */

function kpisVista(m) {
  var nada = { v: '—', title: 'Sin dato', color: 'var(--text3)', sinDato: true };
  if (!m) return { goal: nada, autonomy: nada, completed: nada, stops: nada, tests: nada };
  var c = m.cierre, pc = c ? c.por_clase : null;
  var g = m.goal_attainment, a = m.autonomy_ratio, t = m.test_rate;
  var inconsistente = !!(m.tests && m.tests.status === 'DATA_INCONSISTENT');
  return {
    goal: {
      v: g == null ? '—' : g + '%',
      title: c ? 'Cerrados íntegros ' + c.cerrados + ' de ' + c.total + ' (verificados ' + c.verificados + ', sin veredicto ' + pc.COMPLETADO_SIN_VEREDICTO + '). Con pendientes ' + pc.CON_PENDIENTES + ', detenidos ' + pc.DETENIDO + ', fallidos ' + pc.FALLIDO + ', cancelados ' + pc.CANCELADO + ', en curso ' + pc.EN_CURSO + ', desconocidos ' + pc.DESCONOCIDO + '. Un parcial no cuenta como cierre.' : 'Sin dato',
      color: g == null ? 'var(--text3)' : g >= 80 ? '#34d399' : g >= 60 ? '#fbbf24' : '#f87171',
      sinDato: g == null,
    },
    autonomy: {
      v: a == null ? '—' : a + '%',
      title: m.autonomia ? m.autonomia.sin_intervencion + ' de ' + m.autonomia.observadas + ': ' + m.autonomia.definicion + '. Excluidos: ' + m.autonomia.excluidas + '. Un STOP preventivo no es un defecto: es intervención.' : 'Sin dato',
      color: a == null ? 'var(--text3)' : 'var(--cyan)',
      sinDato: a == null,
    },
    completed: {
      v: String(m.completados),
      title: c ? 'Cierres íntegros. Con pendientes aparte: ' + pc.CON_PENDIENTES + (c.pendientes.length ? ' — ' + c.pendientes.map(function (p) { return p.tarea || p.ciclo_id; }).join(' · ') : '') : '',
      color: 'var(--green)',
      sinDato: false,
    },
    stops: {
      v: String(m.stops),
      title: m.incidentes ? 'Incidentes únicos: ' + m.incidentes.en_ciclos + ' en ciclos, ' + m.incidentes.sin_ciclo + ' sin ciclo enlazado' : '',
      color: 'var(--red)',
      sinDato: false,
    },
    tests: {
      v: t == null ? '—' : t + '%' + (inconsistente ? ' ⚠' : ''),
      title: m.tests ? m.tests.aprobadas + ' aprobadas de ' + m.tests.ejecutadas + ' ejecutadas · ' + m.tests.sin_ejecucion + ' ciclos sin ejecución' + (m.tests.inconsistentes.length ? ' · DATOS INCONSISTENTES en ' + m.tests.inconsistentes.length + ' ciclo(s): más aprobadas que ejecutadas, no se suman' : '') : 'Sin dato',
      color: t == null ? 'var(--text3)' : inconsistente ? 'var(--amber)' : 'var(--green)',
      sinDato: t == null,
    },
  };
}

if (typeof module !== 'undefined') module.exports = { kpisVista: kpisVista };
