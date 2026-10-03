'use strict';

/**
 * Datos del panel TEAMS del dashboard (3.20.1, spec §11). Solo LECTURA y ADITIVO: no toca los grafos KDD /
 * combinado / code structure ni su diseño, y usa el mismo backend de ciclos, memoria y contratos que `aa:`.
 *
 *   resumen(root, filtros)      sesión, plan, las cuatro etapas por separado (construidas · auditadas · verificadas ·
 *                               REGISTRADAS), tareas, ciclos por origen, correcciones, cobertura de registro y memoria
 *   vigilancia(root, {role})    por rol: instalada, viva, detecta, el host acepta, último progreso, loop y watch
 *   auditoria(root, filtros)    por revisor: alcance, hash, pendientes y hallazgos
 *
 * Filtros: origen (aa | teams | todos), plan, sprint, phase, role (frontend | backend | negocio | builder | director),
 * correction (id de hallazgo).
 *
 * Regla de datos: lo que no se puede leer es `null` / `desconocido`, NUNCA 0. Construido, auditado, verificado y
 * registrado se cuentan aparte: una entrega no es un cierre, ni un cierre es un registro en la memoria.
 */

const fs = require('fs');
const path = require('path');
const datos = require('./dashboard-datos.cjs');

/* El plan pedido, o el último. Texto FIJO: el único dato (el id del plan) viaja siempre como parámetro. */
const SUB = 'COALESCE(?, (SELECT id FROM teams_plans ORDER BY created_at DESC, id DESC LIMIT 1))';

const ETAPAS = ['construidas', 'auditadas', 'verificadas', 'registradas'];
const ESTADOS_HALLAZGO = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'IMPLEMENTED_PENDING_REVIEW', 'VERIFIED_RESOLVED', 'REOPENED', 'BLOCKED_HUMAN', 'DISMISSED_WITH_REASON'];
const ROLES_REVISOR = ['frontend', 'backend', 'negocio'];
const pj = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
const nv = (v) => (v === undefined ? null : v);

const hay = (r, tabla) => !((r.faltan || []).some((f) => f === tabla || String(f).startsWith(tabla + ':')));

function normalizarFiltros(f) {
  const x = f || {};
  const origen = ['aa', 'teams'].includes(x.origen) ? x.origen : 'todos';
  const rol = x.role ? String(x.role).toLowerCase() : null;
  const alias = { front: 'frontend', back: 'backend', business: 'negocio' };
  return { origen, plan: x.plan || null, sprint: x.sprint || null, phase: x.phase || null, role: rol ? (alias[rol] || rol) : null, correction: x.correction || null };
}

/** Misma lectura (una transacción) para todo lo que cualquier bloque necesita. */
function leerBase(dbPath, filtros, opts) {
  const plan = filtros.plan;
  const consultas = {
    sesion: { tabla: 'teams_sessions', sql: 'SELECT enabled, paused, session_generation, roles FROM teams_sessions WHERE id = 1' },
    plan: { tabla: 'teams_plans', sql: `SELECT id, objective, state, revision FROM teams_plans WHERE id = ${SUB}`, params: [plan] },
    tareas: { tabla: 'teams_tasks', sql: `SELECT id, sprint_id, state, subject_hash, owner_id, blocked_reason, risk, orden FROM teams_tasks WHERE plan_id = ${SUB} ORDER BY orden`, params: [plan] },
    intentos: { tabla: 'teams_attempts', sql: `SELECT a.task_id, a.state, a.subject_hash FROM teams_attempts a JOIN teams_tasks t ON t.id = a.task_id WHERE t.plan_id = ${SUB}`, params: [plan] },
    flujo: { tabla: 'teams_flow', sql: `SELECT f.task_id, f.phase, f.memory_state, f.closed_at, f.verified_at FROM teams_flow f JOIN teams_tasks t ON t.id = f.task_id WHERE t.plan_id = ${SUB}`, params: [plan] },
    revisiones: { tabla: 'teams_reviews', sql: `SELECT r.id, r.role, r.scope_kind, r.task_id, r.finding_id, r.subject_hash, r.verdict, r.agent_id, r.created_at FROM teams_reviews r LEFT JOIN teams_tasks t ON t.id = r.task_id WHERE r.task_id IS NULL OR t.plan_id = ${SUB} ORDER BY r.id`, params: [plan] },
    hallazgos: { tabla: 'teams_findings', sql: `SELECT id, task_id, severity, state, origin, actionable, reviewed_hash, resolved_hash, reopen_count, recurrence, location, criterion, created_at, updated_at FROM teams_findings WHERE plan_id IS NULL OR plan_id = ${SUB}`, params: [plan] },
    revisores: { tabla: 'teams_reviewers', sql: 'SELECT role, agent_id, session_id, modality, scope, coverage, registered_at, updated_at FROM teams_reviewers' },
    builder: { tabla: 'teams_builder', sql: 'SELECT session_id, host, model, state, watchers, project, connected_at, ready_at, updated_at FROM teams_builder WHERE id = 1' },
    ciclos: { tabla: 'ciclos', sql: "SELECT estado, CASE WHEN ciclo_id LIKE 'teams\\_%' ESCAPE '\\' THEN 'teams' ELSE 'aa' END AS origen, count(*) AS n FROM ciclos GROUP BY 1, 2" },
  };
  return datos.filas(dbPath, consultas, Object.assign({ snapshot: true }, opts || {}));
}

const sinTeams = (r) => !hay(r, 'teams_tasks') || !hay(r, 'teams_plans');

/** Tareas del plan con las etapas de cada una. Un dato que no existe es null, no false. */
function tareasConEtapas(r, filtros, registradas) {
  const v = r.value;
  const flujo = new Map(v.flujo.map((f) => [f.task_id, f]));
  const entregadas = new Set(v.intentos.filter((a) => a.subject_hash && ['DELIVERED', 'VERIFIED'].includes(a.state)).map((a) => a.task_id));
  const conRevision = new Map();
  for (const x of v.revisiones) if (x.task_id) { if (!conRevision.has(x.task_id)) conRevision.set(x.task_id, []); conRevision.get(x.task_id).push(x); }
  const reviewsOk = hay(r, 'teams_reviews');
  const flujoOk = hay(r, 'teams_flow');
  let lista = v.tareas.map((t) => {
    const f = flujo.get(t.id) || null;
    const rev = conRevision.get(t.id) || [];
    return {
      id: t.id, sprint_id: t.sprint_id || null, phase: f ? f.phase : null, state: t.state, owner_id: t.owner_id || null, risk: t.risk || null, blocked_reason: t.blocked_reason || null,
      construida: entregadas.has(t.id) || ['VERIFYING', 'DONE_VERIFIED'].includes(t.state),
      auditada: reviewsOk ? rev.length > 0 : null,
      verificada: t.state === 'DONE_VERIFIED',
      registrada: registradas ? (registradas.get(t.id) || 'NO_ENCOLADA') : 'DESCONOCIDO',
      memoria: flujoOk && f ? f.memory_state : null,
    };
  });
  if (filtros.sprint) lista = lista.filter((t) => t.sprint_id === filtros.sprint);
  if (filtros.phase) lista = lista.filter((t) => t.phase === filtros.phase);
  return lista;
}

function contar(lista, campo, esperado) {
  if (lista.some((t) => t[campo] === null)) return { n: null, de: lista.length, desconocido: true };
  return { n: lista.filter((t) => (esperado === undefined ? t[campo] === true : t[campo] === esperado)).length, de: lista.length, desconocido: false };
}

function bloqueCorrecciones(r, filtros) {
  if (!hay(r, 'teams_findings')) return { disponible: false, motivo: 'TABLA_AUSENTE' };
  let l = r.value.hallazgos;
  if (filtros.role) l = l.filter((h) => String(h.origin).toLowerCase() === filtros.role);
  if (filtros.correction) l = l.filter((h) => h.id === filtros.correction);
  const por_estado = Object.fromEntries(ESTADOS_HALLAZGO.map((e) => [e, l.filter((h) => h.state === e).length]));
  const por_severidad = {};
  for (const h of l) por_severidad[h.severity] = (por_severidad[h.severity] || 0) + 1;
  return {
    disponible: true, total: l.length, por_estado, por_severidad,
    abiertas: l.filter((h) => !['VERIFIED_RESOLVED', 'DISMISSED_WITH_REASON'].includes(h.state)).length,
    reabiertas: l.filter((h) => h.state === 'REOPENED' || Number(h.reopen_count) > 0).length,
    items: l.slice(0, filtros.correction ? 5 : 20).map((h) => ({ id: h.id, task_id: h.task_id || null, severity: h.severity, state: h.state, origin: h.origin, actionable: !!h.actionable, location: h.location || null, criterion: h.criterion || null, reopen_count: Number(h.reopen_count) || 0, updated_at: h.updated_at || null })),
  };
}

function bloqueCiclos(r, filtros) {
  if (!hay(r, 'ciclos')) return { disponible: false, motivo: 'TABLA_AUSENTE' };
  const por_origen = { aa: 0, teams: 0 };
  const por_estado = {};
  for (const c of r.value.ciclos) {
    por_origen[c.origen] += Number(c.n);
    if (filtros.origen === 'todos' || filtros.origen === c.origen) por_estado[c.estado] = (por_estado[c.estado] || 0) + Number(c.n);
  }
  const total = filtros.origen === 'todos' ? por_origen.aa + por_origen.teams : por_origen[filtros.origen];
  return { disponible: true, filtro_origen: filtros.origen, total, por_origen, por_estado };
}

function bloqueAuditoria(r, filtros) {
  const v = r.value;
  const reviewsOk = hay(r, 'teams_reviews');
  const revisoresOk = hay(r, 'teams_reviewers');
  const roles = filtros.role && ROLES_REVISOR.includes(filtros.role) ? [filtros.role] : ROLES_REVISOR;
  const registrados = new Map(v.revisores.map((x) => [String(x.role).toLowerCase(), x]));
  const tareas = v.tareas.filter((t) => t.subject_hash && ['VERIFYING', 'DONE_VERIFIED'].includes(t.state));
  const out = roles.map((rol) => {
    const reg = registrados.get(rol) || null;
    const rs = reviewsOk ? v.revisiones.filter((x) => String(x.role).toLowerCase() === rol) : null;
    const ultima = rs && rs.length ? rs[rs.length - 1] : null;
    // Pendiente: entrega con sujeto SIN informe de este revisor para ese hash exacto (un hash viejo no cuenta).
    const pendientes = rs ? tareas.filter((t) => !rs.some((x) => x.task_id === t.id && x.subject_hash === t.subject_hash)).map((t) => t.id) : null;
    return {
      role: rol, registrado: revisoresOk ? !!reg : null, modality: reg ? reg.modality : null, agent_id: reg ? reg.agent_id : null, scope: reg ? reg.scope : null, coverage: reg ? reg.coverage : null,
      informes: rs ? rs.length : null,
      ultimo: ultima ? { task_id: ultima.task_id || null, finding_id: ultima.finding_id || null, verdict: ultima.verdict, subject_hash: ultima.subject_hash ? String(ultima.subject_hash).slice(0, 16) : null, at: ultima.created_at } : null,
      pendientes: pendientes ? pendientes.length : null, tareas_pendientes: pendientes ? pendientes.slice(0, 10) : null,
    };
  });
  const hall = bloqueCorrecciones(r, filtros);
  return { disponible: reviewsOk || revisoresOk, revisores: out, hallazgos: hall.disponible ? { total: hall.total, abiertas: hall.abiertas, por_estado: hall.por_estado } : null, motivo: reviewsOk || revisoresOk ? null : 'TABLAS_AUSENTES' };
}

/** Resumen del panel. `registradas` se toma de la cobertura del núcleo (ledger del plan × cierres registrados). */
function resumen(root, filtrosEntrada, opts = {}) {
  const filtros = normalizarFiltros(filtrosEntrada);
  const dbPath = datos.rutaDb(root);
  const r = leerBase(dbPath, filtros, opts);
  if (r.status !== 'OK') return { status: 'UNAVAILABLE', reason_code: r.reason_code || 'SIN_BASE', data: null };
  if (sinTeams(r)) {
    return { status: 'OK', reason_code: 'SIN_TEAMS', data: { filtros, inicializado: false, sesion: null, plan: null, etapas: Object.fromEntries(ETAPAS.map((e) => [e, { n: null, de: null, desconocido: true }])), tareas: [], ciclos: bloqueCiclos(r, filtros), correcciones: { disponible: false, motivo: 'SIN_TEAMS' }, auditoria: { disponible: false, motivo: 'SIN_TEAMS' }, cobertura: null, memoria: null } };
  }
  const v = r.value;
  const plan = v.plan[0] || null;
  const s = v.sesion[0] || null;
  let cobertura = null; let memoria = null; let registradas = null;
  try {
    const nucleo = require('./teams-nucleo.cjs');
    cobertura = plan ? nucleo.cobertura(root, { plan_id: plan.id }) : null;
    memoria = plan ? nucleo.estadoMemoria(root, { plan_id: plan.id }) : null;
    if (cobertura && cobertura.available) {
      registradas = new Map();
      for (const d of cobertura.detalle) if (d.categoria === 'construccion') { if (!registradas.has(d.task_id) || d.estado === 'REGISTRADO') registradas.set(d.task_id, d.estado); }
    }
  } catch { /* sin núcleo: «registradas» queda desconocido */ }
  const lista = tareasConEtapas(r, filtros, registradas);
  const etapas = {
    construidas: contar(lista, 'construida'), auditadas: contar(lista, 'auditada'), verificadas: contar(lista, 'verificada'),
    registradas: registradas ? { n: lista.filter((t) => t.registrada === 'REGISTRADO').length, de: lista.length, desconocido: false } : { n: null, de: lista.length, desconocido: true },
  };
  const b = v.builder[0] || null;
  return {
    status: 'OK', reason_code: null,
    data: {
      filtros, inicializado: true,
      sesion: s ? { enabled: !!s.enabled, paused: !!s.paused, generation: s.session_generation, roles: pj(s.roles, {}) } : null,
      builder: hay(r, 'teams_builder') ? (b ? { session_id: b.session_id, host: b.host, model: b.model, state: b.state, declarado: pj(b.watchers, null), project: b.project, ready_at: b.ready_at } : null) : { disponible: false },
      plan: plan ? { id: plan.id, objective: plan.objective, state: plan.state, revision: nv(plan.revision) } : null,
      etapas, tareas: lista,
      ciclos: bloqueCiclos(r, filtros), correcciones: bloqueCorrecciones(r, filtros), auditoria: bloqueAuditoria(r, filtros),
      cobertura: cobertura && cobertura.available ? { cobertura_pct: cobertura.cobertura_pct, estado: cobertura.estado, esperadas: cobertura.esperadas, registradas: cobertura.registradas, por_categoria: cobertura.por_categoria, degradado: cobertura.degradado, aviso: cobertura.aviso, formula: cobertura.formula } : { disponible: false, motivo: cobertura ? cobertura.code : 'SIN_PLAN' },
      memoria: memoria && memoria.available ? { total: memoria.total, registrados: memoria.registrados, pendientes: memoria.pendientes, dead_letter: memoria.dead_letter, en_spool: memoria.en_spool, listo_para_cierre: memoria.listo_para_cierre, motivos_bloqueo: memoria.motivos_bloqueo, items: memoria.items.filter((i) => i.estado !== 'REGISTRADO').slice(0, 20) } : { disponible: false, motivo: memoria ? memoria.code : 'SIN_PLAN' },
    },
    faltan: r.faltan || [],
  };
}

/**
 * Vigilancia por rol, SOLO lectura de archivos (sin consultar el sistema ni leer líneas de comandos). Lo declarado
 * por la sesión y lo observado se muestran por separado: «vivo» y «detecta» salen del latido del proceso; «el host
 * acepta» sale de las lecturas confirmadas (métricas del watch y VISTO), no de lo que la sesión diga de sí misma.
 */
function vigilancia(root, { role } = {}) {
  let vig; let watch;
  try { vig = require('./teams-vigilancia.cjs'); watch = require('./teams-watch.cjs'); } catch { return { status: 'UNAVAILABLE', reason_code: 'MODULO_AUSENTE', data: null }; }
  const roles = role && vig.ROLES.includes(role) ? [role] : vig.ROLES;
  const base = datos.filas(datos.rutaDb(root), { builder: { tabla: 'teams_builder', sql: 'SELECT session_id, state, watchers, ready_at FROM teams_builder WHERE id = 1' } }, { snapshot: true });
  const declarado = base.status === 'OK' && hay(base, 'teams_builder') && base.value.builder[0] ? pj(base.value.builder[0].watchers, null) : null;
  const porRol = roles.map((rol) => {
    const e = vig.estado(root, rol, { consultarSistema: false, lectorCmdline: () => null });
    const cap = vig.capacidades(root, rol, { lectorCmdline: () => null });
    const m = watch.resumenMetricas(root, rol, { conProgreso: true });
    const reg = vig.leerRegistro(root);
    const nombre = vig.nombreTarea(root, rol);
    const p = e.proceso;
    return {
      rol,
      instalada: reg.tareas && reg.tareas[nombre] ? { registrada: true, lanzador: reg.tareas[nombre].lanzador || null, desde: reg.tareas[nombre].instalada_at || null, nota: 'registrada por Agentix; su estado en el Programador de tareas no se consulta desde el panel' } : { registrada: false },
      vivo: p.hay_latido ? { pid: p.pid, proceso_existe: !!p.vivo, latido_vigente: !!p.vigente, latido_at: p.latido_at, edad_ms: p.edad_ms } : { pid: null, proceso_existe: false, latido_vigente: false },
      detecta: p.hay_latido && p.vigilancia ? { watcher: p.vigilancia.watcher ? 'VIVO' : 'MUERTO', respaldo: p.vigilancia.timer ? 'VIVO' : 'MUERTO', canal: p.vigilancia.canal ? 'VIVO' : 'NO_DISPONIBLE', intervalo_ms: p.intervalo_ms } : { watcher: 'DESCONOCIDO', respaldo: 'DESCONOCIDO', canal: 'DESCONOCIDO' },
      host_acepta: m.disponible ? { atenciones: m.n, aceptadas: m.aceptadas, sin_aceptacion: m.sin_aceptacion, atencion_lenta: m.atencion_lenta, lat_atencion_ms: m.lat_atencion_ms, lat_deteccion_ms: m.lat_deteccion_ms } : { atenciones: null, aceptadas: null, motivo: 'SIN_METRICAS' },
      ultimo_progreso: m.disponible && m.progreso ? { con_progreso: m.progreso.con_progreso, sin_progreso: m.progreso.sin_progreso, no_medibles: m.progreso.no_medibles } : { con_progreso: null, motivo: 'SIN_METRICAS' },
      loop_host: cap.loop_host, watch: cap.deteccion, despertar_modelo: cap.despertar_modelo, autonomia: cap.autonomia,
      declarado_por_la_sesion: rol === 'builder' ? declarado : null,
      veredicto: e.veredicto,
    };
  });
  return { status: 'OK', reason_code: null, data: { roles: porRol, nota: 'el proceso de vigilancia detecta; el despertar del modelo por evento no está soportado por ningún host verificado' } };
}

/** Detalle de auditoría paginado (informes de los revisores) con filtros de rol y corrección. */
function auditoria(root, filtrosEntrada, { cursor = 0, limit = 50 } = {}) {
  const filtros = normalizarFiltros(filtrosEntrada);
  const r = leerBase(datos.rutaDb(root), filtros, {});
  if (r.status !== 'OK') return { status: 'UNAVAILABLE', reason_code: r.reason_code || 'SIN_BASE', data: null };
  if (sinTeams(r)) return { status: 'OK', reason_code: 'SIN_TEAMS', data: { disponible: false, informes: [] }, coverage: { total: 0, shown: 0, truncated: false, offset: 0, next_cursor: null } };
  let informes = hay(r, 'teams_reviews') ? r.value.revisiones.slice().reverse() : null;
  if (informes) {
    if (filtros.role) informes = informes.filter((x) => String(x.role).toLowerCase() === filtros.role);
    if (filtros.correction) informes = informes.filter((x) => x.finding_id === filtros.correction);
  }
  const base = bloqueAuditoria(r, filtros);
  if (!informes) return { status: 'OK', reason_code: 'TABLA_AUSENTE', data: Object.assign({}, base, { informes: null }), coverage: null };
  const desde = Math.max(0, Number(cursor) || 0);
  const pagina = informes.slice(desde, desde + limit);
  const siguiente = desde + pagina.length < informes.length ? desde + pagina.length : null;
  return {
    status: informes.length ? 'OK' : 'EMPTY', reason_code: null,
    data: Object.assign({}, base, { informes: pagina.map((x) => ({ id: x.id, role: x.role, scope_kind: x.scope_kind, task_id: x.task_id || null, finding_id: x.finding_id || null, verdict: x.verdict, subject_hash: x.subject_hash ? String(x.subject_hash).slice(0, 16) : null, agent_id: x.agent_id || null, at: x.created_at })) }),
    coverage: { total: informes.length, shown: pagina.length, truncated: informes.length > pagina.length, offset: desde, next_cursor: siguiente },
  };
}

/** Pagina las tareas del resumen (el sobre de la API lo pide). */
function paginarTareas(data, { cursor = 0, limit = 50 } = {}) {
  const lista = data.tareas || [];
  const desde = Math.max(0, Number(cursor) || 0);
  const pagina = lista.slice(desde, desde + limit);
  const siguiente = desde + pagina.length < lista.length ? desde + pagina.length : null;
  return { tareas: pagina, coverage: { total: lista.length, shown: pagina.length, truncated: lista.length > pagina.length, offset: desde, next_cursor: siguiente } };
}

module.exports = { ETAPAS, ESTADOS_HALLAZGO, ROLES_REVISOR, normalizarFiltros, resumen, vigilancia, auditoria, paginarTareas };
