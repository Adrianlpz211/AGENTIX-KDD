#!/usr/bin/env node
'use strict';
/**
 * Presupuesto de esfuerzo ACUMULADO por tarea (H02 "Presupuestos acumulados").
 *
 * El router (effort-router.cjs) ya decide el tier y sus límites; este módulo
 * pone el CONSUMO real encima, con una sola clave: el task_id.
 *
 *   · Es ACUMULADO: cambiar de rol (analyst → builder → qa) o pedir otro recall
 *     no reinicia nada. El desglose por rol existe para informar, no para medir.
 *   · Cuenta SOLO lo que Agentix controla (contexto que entrega, recuperaciones,
 *     búsquedas, lecturas y llamadas que pasan por sus herramientas). Lo que el
 *     host hace por su cuenta es "no observado": se anota como tal y NUNCA se
 *     presenta un 0 como prueba de que no se usó.
 *   · Un latido (heartbeat) no es progreso ni consumo. El progreso se demuestra
 *     con evidencia verificable; sin ella se anota un error de progreso.
 *   · Límite BLANDO → REEVALUAR, y solo una reevaluación escrita (necesidad +
 *     riesgo) abre otra ventana. Límite DURO del usuario → CHECKPOINT con
 *     pendientes; la tarea nunca se informa completada.
 *   · Ahorrar nunca elimina seguridad, archivos protegidos, scope ni leases: las
 *     guardias críticas valen igual en LOW, MEDIUM y HIGH (`guardiasCriticas`).
 *   · No promete control del razonamiento interno del host: `limitesHost` dice
 *     qué se controla y qué no.
 *
 * Persistencia: contadores y límites en `.agentic/_effort/<task>.json` (router,
 * funciona sin base de datos) + registro detallado en mem_context_usage
 * (context-usage.cjs) cuando la memoria 3.20.1 existe. Escribir en la base es
 * auxiliar: si falla, el presupuesto sigue contando y la respuesta lo declara.
 *
 * CLI:
 *   node effort-budget.cjs estado <task_id>
 *   node effort-budget.cjs registrar <task_id> <kind> [--rol=builder] [--delivered=N] [--recovered=N] [--original=N]
 *   node effort-budget.cjs host <task_id>
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const router = require('./effort-router.cjs');

/** Qué contadores mueve cada tipo de evento (los nombres son los de context-usage.KINDS). */
const EVENTOS = Object.freeze({
  // Contexto ENTREGADO por Agentix al modelo.
  context_pack: (u) => ({ context_bytes: u.delivered }),
  recall_index: (u) => ({ context_bytes: u.delivered, tool_calls: 1 }),
  timeline: (u) => ({ context_bytes: u.delivered, tool_calls: 1 }),
  compression: (u) => ({ context_bytes: u.delivered }),
  packet_sent: (u) => ({ context_bytes: u.delivered }),
  packet_delta: (u) => ({ context_bytes: u.delivered }),
  // Recuperación posterior de detalle/original: se entrega al modelo y gasta una llamada.
  recall_detail: (u) => ({ retrieved_bytes: u.recovered, retrievals: 1, tool_calls: 1 }),
  evidence_retrieval: (u) => ({ retrieved_bytes: u.recovered, retrievals: 1, tool_calls: 1 }),
  search: (u) => ({ searches: 1, tool_calls: 1, context_bytes: u.delivered }),
  file_read: (u) => ({ file_reads: 1, tool_calls: 1, context_bytes: u.delivered }),
  tool_call: (u) => ({ tool_calls: 1, context_bytes: u.delivered }),
  delegation: () => ({ delegations: 1, tool_calls: 1 }),
  repair: () => ({ repairs: 1 }),
  // Relectura de algo sin cambios que SÍ se entregó otra vez: gasto evitable, se cuenta y se avisa.
  reread_unchanged: (u) => ({ rereads_unchanged: 1, file_reads: 1, tool_calls: 1, context_bytes: u.delivered }),
  // Relectura EVITADA con una referencia: solo pesa el marcador. No gasta llamada de exploración (es el comportamiento deseado).
  cache_hit: (u) => ({ rereads_avoided: 1, context_bytes: u.delivered }),
  cache_invalidation: () => ({ cache_invalidations: 1 }),
  // Una herramienta del host que Agentix SÍ observó (captura pasiva) es una llamada más; la no observada se trata aparte.
  host_tool: (u) => ({ tool_calls: 1, context_bytes: u.delivered }),
  // El latido llega por aquí solo para ser ignorado explícitamente.
  heartbeat: () => ({}),
});
const KINDS = Object.freeze(Object.keys(EVENTOS));
const NOTA_HOST = 'Las herramientas del host fuera de Agentix no se observan: un contador en 0 no prueba que no se usaron.';
const UMBRAL_SIN_PROGRESO_MS = 15 * 60 * 1000;

const entero = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0);
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
const validaTarea = (id) => /^[\w.-]{1,80}$/.test(String(id || ''));

// ─── registro ────────────────────────────────────────────────────────────────

/**
 * Anota un evento de consumo de una tarea. NUNCA lanza.
 * ev: { kind, role?, sprint_id?, delivered_bytes?, recovered_bytes?, original_bytes?, observed?, detail?, latency_ms?, measure? }
 * Devuelve { ok, status:'OK'|'REEVALUAR'|'CHECKPOINT'|'SIN_DECISION', reason_code, uso, persistencia }.
 */
function registrar(root, task_id, ev = {}, opts = {}) {
  try {
    if (!validaTarea(task_id)) return { ok: false, status: 'ERROR', reason_code: 'TASK_ID_INVALIDO' };
    if (!KINDS.includes(ev.kind)) return { ok: false, status: 'ERROR', reason_code: 'KIND_INVALIDO', allowed: KINDS };
    const u = { delivered: entero(ev.delivered_bytes), recovered: entero(ev.recovered_bytes) };
    const noObservado = ev.observed === false;
    // Una herramienta del host que Agentix no vio no consume presupuesto: solo se registra que no se observó.
    const mov = noObservado ? { host_unobserved: 1 } : EVENTOS[ev.kind](u);
    const consumo = { ...mov, rol: ev.role || undefined, no_observado: noObservado, actividad: ev.kind !== 'heartbeat' };
    if (ev.kind === 'heartbeat') consumo.heartbeat = true;
    if (ev.duration_ms) consumo.duration_ms = entero(ev.duration_ms);
    if (ev.progreso === true) consumo.progreso = true;
    const r = router.consumir(root, task_id, consumo);
    const persistencia = { presupuesto: r.status === 'ERROR' ? r.reason_code : 'OK', detalle_en_base: 'NO_APLICA' };
    if (ev.kind !== 'heartbeat') {
      let cu = null;
      try { cu = require('./context-usage.cjs'); } catch { /* sin módulo */ }
      if (cu) {
        const x = cu.registrar(root, {
          task_id, sprint_id: ev.sprint_id, role: ev.role, kind: ev.kind === 'host_tool' ? 'host_tool' : ev.kind,
          original_bytes: ev.original_bytes, delivered_bytes: ev.delivered_bytes, recovered_bytes: ev.recovered_bytes,
          measure: ev.measure, tokens_original: ev.tokens_original, tokens_delivered: ev.tokens_delivered, latency_ms: ev.latency_ms,
          observed: noObservado ? false : undefined, detail: ev.detail,
        }, opts);
        persistencia.detalle_en_base = x.ok ? 'OK' : (x.code || 'FALLO');
      }
    }
    if (r.status === 'ERROR') return { ok: false, status: 'SIN_DECISION', reason_code: r.reason_code, persistencia };
    return { ok: true, status: r.status, reason_code: r.reason_code, uso: r.uso, estado: r.estado, completed: false, ...(r.avisos ? { avisos: r.avisos } : {}), persistencia };
  } catch (e) {
    return { ok: false, status: 'ERROR', reason_code: 'REGISTRO_FALLIDO', message: e && e.message };
  }
}

/** Herramienta del host que Agentix NO pudo observar: se anota como "no observada", jamás como 0. */
function registrarNoObservado(root, task_id, { role, detail } = {}, opts) {
  return registrar(root, task_id, { kind: 'host_tool', role, observed: false, detail: detail || 'herramienta del host no observada por Agentix', measure: 'not_available' }, opts);
}

// ─── lectura del estado ──────────────────────────────────────────────────────

/** Estado compacto del presupuesto. Dato ausente = no disponible (nunca 0 inventado). */
function estado(root, task_id, { ahora } = {}) {
  if (!validaTarea(task_id)) return { disponible: false, code: 'TASK_ID_INVALIDO' };
  const e = router.leer(root, task_id);
  if (!e) return { disponible: false, code: 'SIN_DECISION', nota: 'la tarea no tiene decisión de esfuerzo: no hay presupuesto que medir' };
  const d = e.decision;
  const uso = router.usoCompleto(e.uso);
  const base = e.soft_baseline || { context_bytes: 0, tool_calls: 0, repairs: 0 };
  const inicio = Date.parse((e.historial[0] && e.historial[0].ts) || '') || null;
  const ahoraMs = ahora || Date.now();
  let medicion = { available: false, code: 'SIN_MEMORIA_3_20_1' };
  try { medicion = require('./context-usage.cjs').acumulado(root, task_id); } catch { /* sin módulo */ }
  const h = d.user_hard_limit;
  return {
    disponible: true, task_id, tier: d.tier, risk: d.risk, estado: e.estado, reason_codes: d.reason_codes,
    limites: {
      context_budget_bytes: d.context_budget_bytes, tool_calls_soft_limit: d.tool_calls_soft_limit, max_repair_attempts: d.max_repair_attempts,
      user_hard_limit: h || null,
    },
    uso,
    restante_blando: {
      context_bytes: Math.max(0, d.context_budget_bytes - (uso.context_bytes - base.context_bytes)),
      tool_calls: Math.max(0, d.tool_calls_soft_limit - (uso.tool_calls - base.tool_calls)),
      repairs: Math.max(0, d.max_repair_attempts - (uso.repairs - base.repairs)),
    },
    por_rol: e.por_rol || {},
    // Un contador de herramientas del host en 0 NO prueba que no se usaron: se declara cobertura, no ausencia.
    cobertura: {
      alcance: 'SOLO_LO_QUE_PASA_POR_AGENTIX',
      herramientas_host_no_observadas: uso.host_unobserved,
      nota: NOTA_HOST,
    },
    ultimo_actividad_at: e.ultimo_actividad_at || null,
    ultimo_progreso_at: e.ultimo_progreso_at || null,
    heartbeats_ignorados: uso.heartbeats_ignored,
    errores_progreso: e.historial.filter((x) => x.evento === 'ERROR_PROGRESO').length,
    transcurrido_ms: inicio ? Math.max(0, ahoraMs - inicio) : null,
    reevaluaciones: (e.reevaluaciones || []).length,
    reevaluacion_pendiente: e.historial.some((x) => (x.evento === 'SOFT_LIMIT' || x.evento === 'REPAIR_LIMIT') && x.ventana === (e.reevaluaciones || []).length),
    provider_capability: d.provider_capability || 'HOST_NATIVE_UNCONTROLLED',
    host_effort: d.host_effort,
    medicion,
  };
}

/** Resumen mínimo para el paquete TEAMS (`effort_usage`). Sin decisión: no disponible, no ceros. */
function resumenParaPaquete(root, task_id) {
  const s = estado(root, task_id);
  if (!s.disponible) return { disponible: false, code: s.code };
  return {
    disponible: true, tier: s.tier, risk: s.risk, estado: s.estado,
    context_bytes: s.uso.context_bytes, tool_calls: s.uso.tool_calls, retrieved_bytes: s.uso.retrieved_bytes, retrievals: s.uso.retrievals,
    repairs: s.uso.repairs, delegations: s.uso.delegations, rereads_avoided: s.uso.rereads_avoided, rereads_unchanged: s.uso.rereads_unchanged,
    herramientas_host_no_observadas: s.uso.host_unobserved, reevaluaciones: s.reevaluaciones,
  };
}

// ─── reevaluación y escalado ─────────────────────────────────────────────────

/** Cierra un REEVALUAR con una decisión escrita (necesidad + riesgo). Ver router.documentarReevaluacion. */
function reevaluarDocumentado(root, task_id, datos) { return router.documentarReevaluacion(root, task_id, datos); }

/**
 * Señales que obligan a subir de tier. Cada una sube UN escalón (tope HIGH). Además, si las rutas o la
 * intención nuevas tocan riesgo alto (auth/pagos/migración/datos sensibles/archivos protegidos), el riesgo
 * se descubre y el tier pasa a HIGH: un título de "cambio pequeño" no baja el riesgo.
 */
function evaluarSenales(root, task_id, s = {}) {
  const e = router.leer(root, task_id);
  if (!e) return { ok: false, reason_code: 'SIN_DECISION' };
  const cambios = [];
  const aplica = (evento, detalle) => { const r = router.reevaluar(root, task_id, evento, detalle); cambios.push({ evento, cambio: !!r.cambio, tier: r.decision && r.decision.tier }); };
  if (s.repeated_failure) aplica('REPEATED_FAILURE', s.repeated_failure === true ? 'fallo repetido' : String(s.repeated_failure));
  if (s.unexpected_dependency) aplica('UNEXPECTED_DEPENDENCY', s.unexpected_dependency === true ? 'dependencia inesperada' : String(s.unexpected_dependency));
  if (s.wider_impact) aplica('WIDER_IMPACT', s.wider_impact === true ? 'impacto mayor' : String(s.wider_impact));
  if (s.ambiguous_criteria) aplica('AMBIGUOUS_CRITERIA', s.ambiguous_criteria === true ? 'criterio ambiguo' : String(s.ambiguous_criteria));
  if (s.paths || s.intent) {
    const r = router.riesgoDe({ intent: s.intent || '', paths: s.paths || [] }, root);
    const actual = router.leer(root, task_id).decision;
    if (r.nivel === 'HIGH' && actual.risk !== 'HIGH') aplica('RISK_DISCOVERED', 'riesgo alto descubierto: ' + r.motivos.join(','));
  }
  return { ok: true, cambios, tier: router.leer(root, task_id).decision.tier };
}

/** Desescala solo con alcance acotado probado; nunca por debajo del piso de riesgo. */
function acotarAlcance(root, task_id, detalle) { return router.reevaluar(root, task_id, 'SCOPE_BOUNDED', detalle); }

// ─── acciones permitidas por tier ────────────────────────────────────────────

/**
 * ¿Esta acción cabe en el tier? Reduce exploración innecesaria SIN recortar lo necesario:
 *   · LOW no investiga globalmente ni delega a roles que su política no pide.
 *   · Leer un archivo que hace falta (en alcance, o para reparar un bug) NUNCA se niega.
 *   · Tras un CHECKPOINT por límite duro del usuario no se sigue gastando.
 */
function permitirAccion(root, task_id, accion, ctx = {}) {
  const e = router.leer(root, task_id);
  if (!e) return { ok: false, code: 'SIN_DECISION' };
  const d = e.decision;
  if (e.estado === 'PENDIENTE') return { ok: false, code: 'CHECKPOINT_LIMITE_DURO', motivo: 'la tarea quedó pendiente por un límite del usuario; no se sigue gastando' };
  if (accion === 'lectura') {
    const rel = String(ctx.path || '').replace(/\\/g, '/');
    const enAlcance = !rel || (d.paths || []).some((p) => rel === p || rel.startsWith(String(p).replace(/\/$/, '') + '/'));
    return { ok: true, ...(enAlcance || ctx.reparacion ? {} : { aviso: 'FUERA_DEL_ALCANCE_DECLARADO', nota: 'se permite; si hace falta de verdad, reevalúa con WIDER_IMPACT' }) };
  }
  if (accion === 'busqueda_global') {
    if (d.tier === 'LOW' && !ctx.reparacion) return { ok: false, code: 'TIER_LOW_SIN_INVESTIGACION_GLOBAL', motivo: 'un cambio LOW trabaja con el contexto mínimo aplicable', siguiente: 'si el cambio resulta más grande, reevaluar con WIDER_IMPACT o RISK_DISCOVERED' };
    return { ok: true, alcance: d.tier === 'MEDIUM' ? 'acotado' : 'completo' };
  }
  if (accion === 'delegacion') {
    const rol = ctx.rol;
    if (!rol) return { ok: false, code: 'ROL_REQUERIDO' };
    if (!(d.required_roles || []).includes(rol)) return { ok: false, code: 'DELEGACION_INNECESARIA', motivo: `la política ${d.tier} no pide el rol ${rol}`, roles: d.required_roles };
    return { ok: true };
  }
  if (accion === 'recuperar_original') return { ok: true, nota: 'cuenta en el presupuesto acumulado' };
  return { ok: false, code: 'ACCION_DESCONOCIDA', accion };
}

/** Las guardias críticas valen en TODOS los tiers: se verifica que la decisión no las perdió por ahorrar. */
function guardiasCriticas(decision) {
  const faltan = router.MINIMOS.filter((g) => !(decision.required_gates || []).includes(g));
  const extra = [];
  if (decision.tier === 'HIGH') {
    for (const g of ['tdd', 'preservation', 'qa']) if (!(decision.required_gates || []).includes(g)) extra.push(g);
    if (!(decision.required_roles || []).includes('reviewer')) extra.push('reviewer');
  }
  return { ok: !faltan.length && !extra.length, faltan: faltan.concat(extra) };
}

// ─── progreso ────────────────────────────────────────────────────────────────

/**
 * El progreso se DEMUESTRA. evidencia: [{ tipo:'evidence_ref', id } | { tipo:'file_hash', path, sha256 }].
 * Sin evidencia verificable (o solo latidos) no hay progreso: se anota un error de progreso.
 */
function declararProgreso(root, task_id, { afirmacion, evidencia = [], role } = {}) {
  const e = router.leer(root, task_id);
  if (!e) return { ok: false, code: 'SIN_DECISION' };
  const verificada = [];
  for (const ev of evidencia) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.tipo === 'evidence_ref') {
      try { const v = require('./evidence-store.cjs').verificar(root, ev.id); if (v.ok) verificada.push({ tipo: ev.tipo, id: ev.id }); } catch { /* sin almacén */ }
    } else if (ev.tipo === 'file_hash' && ev.path && ev.sha256) {
      try {
        const rel = String(ev.path).replace(/\\/g, '/');
        if (rel.split('/').includes('..') || path.isAbsolute(rel)) continue;
        const h = sha(fs.readFileSync(path.join(root, rel)));
        if (h === ev.sha256) verificada.push({ tipo: ev.tipo, path: rel });
      } catch { /* archivo ausente: no verifica */ }
    }
  }
  if (!verificada.length) {
    router.anotar(root, task_id, 'ERROR_PROGRESO', 'PROGRESO_NO_DEMOSTRADO: ' + String(afirmacion || '(sin afirmación)').slice(0, 160));
    return { ok: false, code: 'PROGRESO_NO_DEMOSTRADO', motivo: 'sin evidencia verificable no hay progreso (un latido no cuenta)' };
  }
  router.consumir(root, task_id, { rol: role, progreso: true, actividad: true });
  return { ok: true, verificada };
}

/**
 * ¿Lleva demasiado sin progreso real? Dispara una REVISIÓN de estado (queda anotada una vez por ventana),
 * no inventa trabajo ni escala sola: la decisión de subir de tier es explícita (evaluarSenales).
 */
function sinProgreso(root, task_id, { ahora, umbral_ms = UMBRAL_SIN_PROGRESO_MS } = {}) {
  const e = router.leer(root, task_id);
  if (!e) return { ok: false, code: 'SIN_DECISION' };
  if (e.estado !== 'EN_CURSO') return { ok: true, sin_progreso: false, estado: e.estado };
  const ahoraMs = ahora || Date.now();
  const desde = Date.parse(e.ultimo_progreso_at || (e.historial[0] && e.historial[0].ts) || '');
  if (!Number.isFinite(desde)) return { ok: true, sin_progreso: false, motivo: 'sin referencia de tiempo' };
  const ms = ahoraMs - desde;
  if (ms < umbral_ms) return { ok: true, sin_progreso: false, ms_sin_progreso: ms };
  const ya = e.historial.some((x) => x.evento === 'REVISION_SIN_PROGRESO' && Date.parse(x.ts) >= desde);
  if (!ya) router.anotar(root, task_id, 'REVISION_SIN_PROGRESO', `${Math.round(ms / 60000)} min sin progreso demostrado`);
  return { ok: true, sin_progreso: true, ms_sin_progreso: ms, accion: 'REVISAR_ESTADO', nota: 'revisar el estado y los bloqueos reales; no se crean tareas nuevas por el paso del tiempo', ya_anotada: ya };
}

// ─── límites del host ────────────────────────────────────────────────────────

/**
 * Qué controla Agentix y qué no. NUNCA certifica la autonomía de un host con un dato de estado:
 * eso exige un ida y vuelta real dentro del host (smoke), que este módulo no puede probar.
 */
function limitesHost(root, task_id) {
  const prov = router.capacidadProveedor(root);
  const s = task_id ? estado(root, task_id) : null;
  return {
    provider_capability: prov.capability,
    can_set_reasoning: prov.can_set_reasoning,
    ...(prov.error ? { provider_aviso: prov.error } : {}),
    host_effort: prov.can_set_reasoning ? 'controlado_por_proveedor' : 'no_controlable',
    controla: ['contexto que entrega Agentix', 'cuántas recuperaciones/lecturas/llamadas pasan por sus herramientas', 'gates y alcance al cerrar'],
    no_controla: ['razonamiento interno del host (thinking)', 'herramientas que el host usa sin pasar por Agentix', 'modelo, endpoint y ajustes del IDE'],
    autonomia_host: 'NO_VERIFICADA',
    nota: 'La autonomía completa de un host solo se afirma con una prueba real dentro de ese host; un test de estado no la certifica.',
    ...(s && s.disponible ? { herramientas_host_no_observadas: s.uso.host_unobserved, heartbeats_ignorados: s.heartbeats_ignorados, errores_progreso: s.errores_progreso } : {}),
  };
}

module.exports = {
  KINDS, UMBRAL_SIN_PROGRESO_MS,
  registrar, registrarNoObservado, estado, resumenParaPaquete,
  reevaluarDocumentado, evaluarSenales, acotarAlcance,
  permitirAccion, guardiasCriticas,
  declararProgreso, sinProgreso, limitesHost,
};

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  const opt = {}; const libres = [];
  for (const a of rest) { const m = /^--([^=]+)(?:=(.*))?$/s.exec(a); if (m) opt[m[1]] = m[2] === undefined ? true : m[2]; else libres.push(a); }
  const root = process.cwd();
  const out = (x) => console.log(JSON.stringify(x, null, 2));
  if (cmd === 'estado') out(estado(root, libres[0]));
  else if (cmd === 'registrar') out(registrar(root, libres[0], { kind: libres[1], role: opt.rol, delivered_bytes: opt.delivered, recovered_bytes: opt.recovered, original_bytes: opt.original }));
  else if (cmd === 'host') out(limitesHost(root, libres[0]));
  else console.log('Uso: node effort-budget.cjs estado <task_id> | registrar <task_id> <kind> [--rol= --delivered= --recovered= --original=] | host [task_id]');
}
