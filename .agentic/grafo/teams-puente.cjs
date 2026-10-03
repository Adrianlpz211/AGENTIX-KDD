'use strict';
/**
 * Puente TEAMS → núcleo común de Agentix.
 *
 * Une dos piezas que se construyeron por separado:
 *   · el núcleo de TEAMS (teams-manager/teams-cierre): sabe CUÁNDO una tarea quedó verificada, qué revisor opinó
 *     y si la campaña puede cerrarse;
 *   · el puente a memoria (teams-nucleo): sabe REGISTRAR un cierre como ciclo/episodio/contratos/AST/layout/memoria
 *     con origen='teams', de forma idempotente y con reintento.
 *
 * Por qué existe: sin esto, `DONE_VERIFIED` cerraba la tarea en TEAMS y NADA llegaba a ciclos, memoria KDD,
 * contratos, code structure, layout, preservación ni dashboard (solo entraba lo que alguien commiteaba aparte).
 *
 *   alVerificar(root, task_id)   encola el cierre de la tarea YA verificada (outbox: no pierde el trabajo) y la deja
 *                                 en MEMORY_PENDING hasta que se registre de verdad.
 *   alRevisar(root, informe)     enlaza el veredicto de un revisor al ciclo de esa entrega (no crea otro ciclo).
 *   procesar(root, opts)         ejecuta lo pendiente (post-cycle con origen teams) y refleja el resultado en el flujo
 *                                 de TEAMS: REGISTERED / NO_LEARNING / FAILED / PENDING. Un fallo NO detiene tareas
 *                                 independientes; solo impide el cierre FINAL completo.
 *
 * Todo es fail-soft hacia TEAMS: si la memoria con procedencia no está lista (sin tablas, update en curso) se
 * degrada de forma explícita y TEAMS sigue; nunca se finge que quedó registrado.
 */

const path = require('path');

const cargar = (n) => require(path.join(__dirname, n));

function datosDeTarea(root, task_id) {
  const tm = cargar('teams-manager.cjs');
  const t = tm.leerTarea(root, task_id);
  if (!t) return null;
  const area = String((t.allowed_files && t.allowed_files[0]) || 'global').split('/').filter(Boolean)[0] || 'global';
  return {
    plan_id: t.plan_id, sprint_id: t.sprint_id || null, task_id: t.id, attempt: Math.max(1, Number(t.revision) || 1),
    subject_hash: t.subject_hash || 'sin-hash', files: t.allowed_files || [], area: area.replace(/\.[a-z0-9]+$/i, ''),
    tarea: t.objective, tier: t.effort_policy && t.effort_policy.tier,
  };
}

/** Tarea verificada → cierre pendiente de registro. Idempotente por tarea+intento+hash del sujeto. */
function alVerificar(root, task_id, extra = {}) {
  try {
    const d = datosDeTarea(root, task_id);
    if (!d) return { ok: false, status: 'TAREA_DESCONOCIDA' };
    // Sin memoria con procedencia (sin tablas / sin base) NO hay dónde registrar: no se deja la tarea esperando un registro que no
    // puede ocurrir (eso bloquearía el cierre para siempre). Queda NO_APLICA con la causa y la acción; no se finge que se registró.
    const disp = cargar('memory-core.cjs').disponibilidad(root);
    if (disp.state !== 'READY') {
      try { cargar('teams-cierre.cjs').marcarMemoria(root, { task_id, state: 'NO_APLICA', detail: 'memoria con procedencia no disponible (' + disp.state + '): ejecuta akdd update' }); } catch { /* auxiliar */ }
      return { ok: false, status: 'MEMORIA_NO_DISPONIBLE', code: disp.code || disp.state, hint: disp.hint || 'akdd update' };
    }
    const nucleo = cargar('teams-nucleo.cjs');
    const r = nucleo.registrarCierre(root, { ...d, rol: 'director', resumen: extra.resumen || ('Tarea ' + task_id + ' verificada por TEAMS'), tests: extra.tests, aprendizajes: extra.aprendizajes, sin_aprendizaje: extra.sin_aprendizaje }, { procesar: false });
    const cierre = cargar('teams-cierre.cjs');
    // Hasta que el job se ejecute, la tarea NO está registrada: MEMORY_PENDING (solo si hay memoria con procedencia; si no, no se bloquea TEAMS).
    if (r && (r.ok || r.status === 'CAPTURADO' || r.status === 'MEMORY_PENDING')) cierre.marcarMemoria(root, { task_id, state: 'PENDING', detail: 'cierre en cola' });
    return r;
  } catch (e) {
    return { ok: false, status: 'PUENTE_DEGRADADO', code: e.code || 'ERROR', message: e.message };
  }
}

/** Un informe de revisor se enlaza al ciclo de la entrega revisada. */
function alRevisar(root, informe) {
  try {
    return cargar('teams-nucleo.cjs').registrarRevision(root, informe, { procesar: false });
  } catch (e) {
    return { ok: false, status: 'PUENTE_DEGRADADO', code: e.code || 'ERROR', message: e.message };
  }
}

/** Ejecuta lo pendiente y refleja el resultado por tarea en el flujo de TEAMS. */
function procesar(root, opts = {}) {
  try {
    const nucleo = cargar('teams-nucleo.cjs');
    const cierre = cargar('teams-cierre.cjs');
    const proc = nucleo.procesarPendientes(root, opts);
    const est = nucleo.estadoMemoria(root, opts.plan_id ? { plan_id: opts.plan_id } : {});
    const reflejados = [];
    for (const e of (est.eventos || [])) {
      if (!e.task_id || e.tipo === 'revision' || e.event_type === 'teams_revision') continue;
      const state = e.estado === 'REGISTRADO' ? 'REGISTERED' : (e.estado === 'DEAD_LETTER' ? 'FAILED' : 'PENDING');
      const r = cierre.marcarMemoria(root, { task_id: e.task_id, state, detail: e.error_code || null });
      reflejados.push({ task_id: e.task_id, state, ok: r && r.status === 'OK' });
    }
    return { ok: proc.ok !== false, procesamiento: proc, reflejados, listo_para_cierre: est.listo_para_cierre };
  } catch (e) {
    return { ok: false, status: 'PUENTE_DEGRADADO', code: e.code || 'ERROR', message: e.message };
  }
}

module.exports = { alVerificar, alRevisar, procesar, datosDeTarea };

if (require.main === module) {
  const [cmd, a1] = process.argv.slice(2);
  const root = process.cwd();
  const salida = cmd === 'verificar' ? alVerificar(root, a1) : cmd === 'procesar' ? procesar(root, {}) : { ok: false, message: 'Uso: teams-puente.cjs <verificar <task_id>|procesar>' };
  console.log(JSON.stringify(salida, null, 2));
}
