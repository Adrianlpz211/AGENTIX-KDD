#!/usr/bin/env node
/**
 * Agentic KDD — Router de esfuerzo (02-esfuerzo-y-tokens)
 *
 * Una sola política para aa:, sprints, teams:, revisión y reparación: el tier
 * sale de la DIFICULTAD de la tarea y del RIESGO de lo que toca, el mayor de
 * los dos. Sin modos manuales lite/full/ultra.
 *
 *   · Riesgo alto obliga controles reforzados aunque el cambio sea de dos líneas.
 *   · Una spec activa o un sprint no suben el tier por sí mismos.
 *   · Índice incompleto = incertidumbre, nunca "seguro".
 *   · El modelo no puede pedirse LOW por debajo del piso de riesgo.
 *   · Límite blando = reevaluación registrada; límite duro del usuario =
 *     checkpoint y pendiente, nunca "completado".
 *
 * Los presupuestos son del contexto que aporta Agentix (bytes, llamadas). Los
 * tokens internos del host no los controla: se declara, no se finge.
 *
 * Decisión persistida en .agentic/_effort/<task_id>.json con su historial.
 *
 * CLI:
 *   node effort-router.cjs decide "<intención>" [--paths=a,b] [--type=text] [--task=T-1] [--index=COMPLETE] [--json]
 *   node effort-router.cjs reevaluar <task_id> <EVENTO> ["detalle"]
 *   node effort-router.cjs show <task_id>
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ORDEN = ['LOW', 'MEDIUM', 'HIGH'];
const rango = (t) => ORDEN.indexOf(t);
const maxTier = (...ts) => ts.reduce((a, b) => (rango(b) > rango(a) ? b : a), 'LOW');

const DEFAULT_POLICY = {
  policy_version: 1,
  tiers: {
    LOW: { context_budget_bytes: 12000, tool_calls_soft_limit: 8, max_repair_attempts: 1, recall_top_k: 3,
      required_roles: ['builder'], required_gates: ['scope', 'protected-files', 'security', 'leases', 'relevant-check'] },
    MEDIUM: { context_budget_bytes: 40000, tool_calls_soft_limit: 24, max_repair_attempts: 2, recall_top_k: 6,
      required_roles: ['analyst', 'builder', 'qa'], required_gates: ['scope', 'protected-files', 'security', 'leases', 'affected-tests', 'preservation', 'qa-directed'] },
    HIGH: { context_budget_bytes: 100000, tool_calls_soft_limit: 60, max_repair_attempts: 3, recall_top_k: 10,
      required_roles: ['analyst', 'builder', 'qa', 'reviewer'], required_gates: ['scope', 'protected-files', 'security', 'leases', 'plan', 'blast-radius', 'tdd', 'preservation', 'qa'] },
  },
  escalation_conditions: ['UNEXPECTED_DEPENDENCY', 'REPEATED_FAILURE', 'WIDER_IMPACT', 'AMBIGUOUS_CRITERIA', 'NO_PROGRESS', 'RISK_DISCOVERED'],
};
const MINIMOS = ['scope', 'protected-files', 'security', 'leases'];

// ─── POLÍTICA ────────────────────────────────────────────────────────────────

function validarPolitica(p) {
  const errores = [];
  if (!p || typeof p !== 'object') return ['la política no es un objeto'];
  if (!Number.isInteger(p.policy_version) || p.policy_version < 1) errores.push('policy_version debe ser entero >= 1');
  for (const t of ORDEN) {
    const x = p.tiers && p.tiers[t];
    if (!x) { errores.push(`falta el tier ${t}`); continue; }
    for (const k of ['context_budget_bytes', 'tool_calls_soft_limit', 'max_repair_attempts', 'recall_top_k']) {
      if (!Number.isFinite(x[k]) || x[k] < 0) errores.push(`${t}.${k} debe ser número >= 0`);
    }
    for (const k of ['required_roles', 'required_gates']) if (!Array.isArray(x[k])) errores.push(`${t}.${k} debe ser lista`);
    if (Array.isArray(x.required_gates)) for (const g of MINIMOS) if (!x.required_gates.includes(g)) errores.push(`${t} no puede quitar el gate mínimo ${g}`);
  }
  if (!errores.length && p.tiers.LOW.context_budget_bytes > p.tiers.HIGH.context_budget_bytes) errores.push('LOW no puede tener más presupuesto que HIGH');
  if (!errores.length) {
    for (const g of ['tdd', 'preservation', 'qa']) if (!p.tiers.HIGH.required_gates.includes(g)) errores.push(`HIGH no puede quitar ${g}`);
    if (!p.tiers.HIGH.required_roles.includes('reviewer')) errores.push('HIGH no puede quitar reviewer');
  }
  return errores;
}

function cargarPolitica(root) {
  const f = path.join(root || process.cwd(), '.agentic', 'effort-policy.json');
  let p;
  try { p = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return { policy: DEFAULT_POLICY, origen: 'default' };
    return { policy: DEFAULT_POLICY, origen: 'default', error: 'effort-policy.json ilegible: ' + e.message };
  }
  const errores = validarPolitica(p);
  if (errores.length) return { policy: DEFAULT_POLICY, origen: 'default', error: 'effort-policy.json inválida: ' + errores.join('; ') };
  return { policy: p, origen: f };
}

// ─── CLASIFICACIÓN ───────────────────────────────────────────────────────────

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

const RIESGO_INTENCION = [
  [/\b(auth\w*|autentic\w*|autoriz\w*|permis\w*|login|logout|password|contrasena|sesion(es)?|session|jwt|token|oauth|rbac|roles?)\b/, 'AUTH_PERMISSIONS'],
  [/\b(pago|pagos|payment|billing|factura\w*|cobro\w*|checkout|stripe|tarjeta)\b/, 'PAYMENTS'],
  [/\b(migraci\w*|migration|schema|esquema|alter table|drop|columna)\b/, 'MIGRATION'],
  [/\b(datos (personales|sensibles|de pacientes|medicos)|pii|gdpr|hipaa|secret\w*|credencial\w*|cifr\w*|encrypt\w*|tenant)\b/, 'SENSITIVE_DATA'],
  [/\b(transacci\w*|transaction|concurren\w*|race|atomic\w*)\b/, 'TRANSACTIONS'],
];
const RIESGO_RUTA = [
  [/(^|\/)(auth|middleware|permissions?|rbac|session)s?(\/|\.|$)|jwt|token|\.env|secret/, 'AUTH_PERMISSIONS'],
  [/(pay|pago|billing|stripe|checkout|factura|invoice)/, 'PAYMENTS'],
  [/(migrat|\.sql$|schema\.prisma|(^|\/)schema\.)/, 'MIGRATION'],
];
const DIFICULTAD = [
  [/\b(arquitectura|transversal|todo el (proyecto|sistema)|todos los modulos|reescrib\w*|rewrite|global)\b/, 'HIGH', 'CROSS_CUTTING'],
  [/\b(texto|typo|errata|copy|label|etiqueta|wording|traduc\w*|mensaje|titulo|placeholder|ortografia)\b/, 'LOW', 'LOCAL_TEXT_CHANGE'],
  [/\b(color|estilo|css|margen|margin|padding|fuente|font|espaciado|alineaci\w*)\b/, 'LOW', 'STYLE_CHANGE'],
  [/\b(renombr\w*|rename)\b/, 'LOW', 'SAFE_RENAME'],
  [/\b(readme|documentaci\w*|comentario\w*|docs?)\b/, 'LOW', 'DOCS_CHANGE'],
  [/\b(bug|fix|arregl\w*|corrig\w*|falla\w*|no funciona|error)\b/, 'MEDIUM', 'BOUNDED_BUG'],
  [/\b(test|prueba)s?\b/, 'LOW', 'LOCALIZED_TEST'],
];
const TIPOS = {
  text: ['LOW', 'LOCAL_TEXT_CHANGE'], style: ['LOW', 'STYLE_CHANGE'], rename: ['LOW', 'SAFE_RENAME'], docs: ['LOW', 'DOCS_CHANGE'],
  test: ['LOW', 'LOCALIZED_TEST'], obvious_bug: ['LOW', 'OBVIOUS_BUG'], bug: ['MEDIUM', 'BOUNDED_BUG'], feature: ['MEDIUM', 'FEATURE'],
  refactor: ['MEDIUM', 'REFACTOR'], cross_cutting: ['HIGH', 'CROSS_CUTTING'], migration: ['HIGH', 'MIGRATION'],
};

function riesgoDe(entrada, root) {
  const motivos = [];
  const texto = norm(entrada.intent);
  for (const [re, code] of RIESGO_INTENCION) if (re.test(texto)) motivos.push(code);
  const paths = (entrada.paths || []).map((p) => String(p).replace(/\\/g, '/').toLowerCase());
  for (const p of paths) for (const [re, code] of RIESGO_RUTA) if (re.test(p) && !motivos.includes(code)) motivos.push(code);
  try {
    const sg = require('./security-gate.cjs');
    for (const p of paths) {
      const c = sg.classifyFileRisk(p);
      if (c === 'CRITICAL' && !motivos.includes('CRITICAL_FILE')) motivos.push('CRITICAL_FILE');
      if (c === 'SENSITIVE' && !motivos.includes('SENSITIVE_FILE')) motivos.push('SENSITIVE_FILE');
    }
  } catch { /* sin clasificador: solo patrones propios */ }
  if (root && paths.length) {
    try {
      const pf = require('./protected-files.cjs').verificar(root, entrada.paths);
      if (pf.status === 'FAIL') motivos.push('PROTECTED_FILE');
      if (pf.status === 'ERROR') motivos.push('PROTECTED_MANIFEST_ERROR');
    } catch { /* manifiesto ausente = sin protegidos */ }
  }
  const c = entrada.contracts || {};
  if ((c.protected || 0) > 0) motivos.push('PROTECTED_CONTRACT');
  else if ((c.verified || 0) > 0) motivos.push('VERIFIED_CONTRACT');

  const ALTOS = new Set(['AUTH_PERMISSIONS', 'PAYMENTS', 'MIGRATION', 'SENSITIVE_DATA', 'TRANSACTIONS', 'CRITICAL_FILE', 'PROTECTED_FILE', 'PROTECTED_CONTRACT', 'PROTECTED_MANIFEST_ERROR']);
  const MEDIOS = new Set(['SENSITIVE_FILE', 'VERIFIED_CONTRACT']);
  const nivel = motivos.some((m) => ALTOS.has(m)) ? 'HIGH' : motivos.some((m) => MEDIOS.has(m)) ? 'MEDIUM' : 'LOW';
  return { nivel, motivos };
}

function dificultadDe(entrada) {
  const motivos = [];
  let nivel = 'LOW';
  const tipo = entrada.change_type && (TIPOS[String(entrada.change_type).toLowerCase()]
    || Object.values(TIPOS).find(([, code]) => code === String(entrada.change_type).toUpperCase()));
  if (tipo) {
    const [n, code] = tipo;
    nivel = n; motivos.push(code);
  } else {
    const texto = norm(entrada.intent);
    const hit = DIFICULTAD.find(([re]) => re.test(texto));
    if (hit) { nivel = hit[1]; motivos.push(hit[2]); } else { nivel = 'MEDIUM'; motivos.push('UNCLASSIFIED_INTENT'); }
  }
  const paths = entrada.paths || [];
  const raices = new Set(paths.map((p) => String(p).replace(/\\/g, '/').split('/')[0]));
  if (paths.length > 12 || raices.size > 4) { nivel = maxTier(nivel, 'HIGH'); motivos.push('UNCONTROLLED_SCOPE'); }
  else if (paths.length > 4) { nivel = maxTier(nivel, 'MEDIUM'); motivos.push('SEVERAL_RELATED_POINTS'); }
  if (!paths.length && nivel === 'LOW' && !['LOCAL_TEXT_CHANGE', 'STYLE_CHANGE', 'DOCS_CHANGE'].includes(motivos[0])) {
    nivel = 'MEDIUM'; motivos.push('UNKNOWN_SCOPE');
  }
  const cobertura = entrada.index_coverage || 'UNKNOWN';
  if (cobertura !== 'COMPLETE' && (!paths.length || nivel !== 'LOW')) {
    nivel = maxTier(nivel, 'MEDIUM'); motivos.push(cobertura === 'UNKNOWN' ? 'INDEX_UNKNOWN' : 'INDEX_INCOMPLETE');
  }
  return { nivel, motivos };
}

// ─── DECISIÓN ────────────────────────────────────────────────────────────────

function idTarea(entrada) {
  if (entrada.task_id && /^[\w.-]{1,80}$/.test(entrada.task_id)) return entrada.task_id;
  return 'T-' + crypto.createHash('sha256').update(JSON.stringify([entrada.intent, entrada.paths || []])).digest('hex').slice(0, 12);
}

/** Gates de preservación por superficie: el tier no los quita (P02). */
function superficie(entrada, root) {
  try { return require('./politica-gates.cjs').gatesPorSuperficie(entrada.paths || [], { root }); }
  catch (e) { return { policy_id: null, required: ['preservation'], no_aplica: [], error: e.message }; }
}

function construir(entrada, tier, riesgo, dificultad, policy, extra) {
  const t = policy.tiers[tier];
  const u = entrada.user_limits || {};
  const ctx = Number.isFinite(u.max_context_bytes) ? Math.min(t.context_budget_bytes, u.max_context_bytes) : t.context_budget_bytes;
  const calls = Number.isFinite(u.max_tool_calls) ? Math.min(t.tool_calls_soft_limit, u.max_tool_calls) : t.tool_calls_soft_limit;
  const roles = [...t.required_roles];
  if (riesgo.nivel === 'HIGH' && !roles.includes('reviewer')) roles.push('reviewer');
  const sup = superficie(entrada, extra && extra._root);
  let alcance = null;
  if (extra && extra._root && (entrada.paths || []).length) {
    try {
      const a = require('./alcance-impacto.cjs').alcance(extra._root, entrada.paths);
      alcance = { nivel: a.nivel, rutas: a.rutas, motivos: a.motivos, suite_front: a.suite };
    } catch { /* sin análisis: el tier decide */ }
  }
  delete extra._root;
  return {
    policy_version: policy.policy_version,
    policy_id: sup.policy_id,
    task_id: idTarea(entrada),
    difficulty: dificultad.nivel,
    risk: riesgo.nivel,
    tier,
    reason_codes: [...dificultad.motivos, ...riesgo.motivos],
    required_gates: [...new Set([...MINIMOS, ...t.required_gates, ...sup.required])],
    paths: (entrada.paths || []).slice(),
    preservation_gates: sup.required,
    no_aplica: sup.no_aplica,
    verification_scope: alcance,
    required_roles: roles,
    context_budget_bytes: ctx,
    tool_calls_soft_limit: calls,
    max_repair_attempts: t.max_repair_attempts,
    recall_top_k: t.recall_top_k,
    escalation_conditions: policy.escalation_conditions,
    user_hard_limit: Number.isFinite(u.max_context_bytes) || Number.isFinite(u.max_tool_calls) ? { max_context_bytes: u.max_context_bytes ?? null, max_tool_calls: u.max_tool_calls ?? null } : null,
    host_effort: 'no_controlable',
    subject_hash: entrada.subject_hash || null,
    ...extra,
  };
}

/**
 * Pura: misma entrada → misma decisión, venga de aa:, de un sprint o de teams:
 * (`origen` se registra pero no cambia nada).
 */
function decidir(entrada, opciones = {}) {
  const root = opciones.root || null;
  const { policy, error } = opciones.policy ? { policy: opciones.policy } : cargarPolitica(root);
  const riesgo = riesgoDe(entrada, root);
  const dificultad = dificultadDe(entrada);
  let tier = maxTier(dificultad.nivel, riesgo.nivel);
  const extra = { _root: root };
  if (error) extra.policy_error = error;
  if (entrada.requested_tier && ORDEN.includes(entrada.requested_tier)) {
    if (rango(entrada.requested_tier) < rango(riesgo.nivel)) extra.requested_tier_rejected = 'MIN_SEGURIDAD';
    else tier = maxTier(entrada.requested_tier, riesgo.nivel);
  }
  if (entrada.deep_analysis) tier = 'HIGH';
  return construir(entrada, tier, riesgo, dificultad, policy, extra);
}

// ─── PERSISTENCIA, ESCALADO Y LÍMITES ────────────────────────────────────────

const rutaTarea = (root, id) => {
  if (!/^[\w.-]{1,80}$/.test(String(id || ''))) { const e = new Error('task_id inválido'); e.code = 'INVALID_TASK_ID'; throw e; }
  return path.join(root, '.agentic', '_effort', id + '.json');
};

function leer(root, id) { try { return JSON.parse(fs.readFileSync(rutaTarea(root, id), 'utf8')); } catch (e) { if (e.code === 'INVALID_TASK_ID') throw e; return null; } }

function escribir(root, estado) {
  const f = rutaTarea(root, estado.decision.task_id);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(estado, null, 2));
  fs.renameSync(tmp, f);
}

/** Decide y persiste; si la tarea ya tiene decisión, la devuelve (una vez por tarea). */
function decidirYGuardar(root, entrada, opciones = {}) {
  const id = idTarea(entrada);
  const previo = leer(root, id);
  if (previo && !opciones.forzar) return previo.decision;
  const decision = decidir({ ...entrada, task_id: id }, { ...opciones, root });
  escribir(root, {
    decision, entrada: { intent: entrada.intent, paths: entrada.paths || [], origen: entrada.origen || 'aa' },
    uso: { context_bytes: 0, tool_calls: 0 }, estado: 'EN_CURSO',
    historial: [{ ts: new Date().toISOString(), evento: 'DECIDIDO', tier: decision.tier, motivo: decision.reason_codes.join(',') }],
  });
  return decision;
}

const SUBE = new Set(['UNEXPECTED_DEPENDENCY', 'REPEATED_FAILURE', 'WIDER_IMPACT', 'AMBIGUOUS_CRITERIA', 'NO_PROGRESS', 'RISK_DISCOVERED']);

/** Escala o desescala con evidencia. Nunca por debajo del piso de riesgo. */
function reevaluar(root, id, evento, detalle) {
  const e = leer(root, id);
  if (!e) return { ok: false, reason_code: 'SIN_DECISION' };
  const d = e.decision;
  const { policy } = cargarPolitica(root);
  let nuevo = d.tier;
  if (SUBE.has(evento)) nuevo = ORDEN[Math.min(rango(d.tier) + 1, 2)];
  else if (evento === 'SCOPE_BOUNDED') nuevo = maxTier(ORDEN[Math.max(rango(d.tier) - 1, 0)], d.risk);
  else return { ok: false, reason_code: 'EVENTO_DESCONOCIDO' };
  let risk = d.risk;
  if (evento === 'RISK_DISCOVERED') { risk = 'HIGH'; nuevo = 'HIGH'; }
  const t = policy.tiers[nuevo];
  const roles = [...t.required_roles];
  if (risk === 'HIGH' && !roles.includes('reviewer')) roles.push('reviewer');
  e.decision = {
    ...d, tier: nuevo, risk,
    required_gates: [...new Set([...MINIMOS, ...t.required_gates, ...(d.preservation_gates || [])])], required_roles: roles,
    context_budget_bytes: d.user_hard_limit && Number.isFinite(d.user_hard_limit.max_context_bytes) ? Math.min(t.context_budget_bytes, d.user_hard_limit.max_context_bytes) : t.context_budget_bytes,
    tool_calls_soft_limit: d.user_hard_limit && Number.isFinite(d.user_hard_limit.max_tool_calls) ? Math.min(t.tool_calls_soft_limit, d.user_hard_limit.max_tool_calls) : t.tool_calls_soft_limit,
    max_repair_attempts: t.max_repair_attempts, recall_top_k: t.recall_top_k,
    reason_codes: [...new Set([...d.reason_codes, evento])],
  };
  e.historial.push({ ts: new Date().toISOString(), evento, desde: d.tier, tier: nuevo, motivo: detalle ? String(detalle).slice(0, 300) : null });
  escribir(root, e);
  return { ok: true, decision: e.decision, cambio: d.tier !== nuevo };
}

/**
 * Suma uso. Límite blando superado → REEVALUAR (registrado, no corta una
 * comprobación necesaria). Límite duro del usuario → CHECKPOINT: la tarea
 * queda PENDIENTE con su evidencia; no se informa completada.
 */
function consumir(root, id, uso = {}) {
  const e = leer(root, id);
  if (!e) return { status: 'ERROR', reason_code: 'SIN_DECISION' };
  e.uso.context_bytes += Number(uso.context_bytes) || 0;
  e.uso.tool_calls += Number(uso.tool_calls) || 0;
  const d = e.decision;
  const h = d.user_hard_limit;
  let status = 'OK';
  let reason_code = null;
  if (h && ((Number.isFinite(h.max_context_bytes) && e.uso.context_bytes > h.max_context_bytes) || (Number.isFinite(h.max_tool_calls) && e.uso.tool_calls > h.max_tool_calls))) {
    status = 'CHECKPOINT'; reason_code = 'USER_HARD_LIMIT';
    e.estado = 'PENDIENTE';
    e.checkpoint = { ts: new Date().toISOString(), uso: { ...e.uso }, evidencia: uso.evidencia || e.checkpoint?.evidencia || [], pendientes: uso.pendientes || [] };
  } else if (e.uso.context_bytes > d.context_budget_bytes || e.uso.tool_calls > d.tool_calls_soft_limit) {
    status = 'REEVALUAR'; reason_code = 'SOFT_LIMIT';
    if (!e.historial.some((x) => x.evento === 'SOFT_LIMIT' && x.tier === d.tier)) {
      e.historial.push({ ts: new Date().toISOString(), evento: 'SOFT_LIMIT', tier: d.tier, motivo: `uso ${e.uso.context_bytes} B / ${e.uso.tool_calls} llamadas` });
    }
  }
  escribir(root, e);
  return { status, reason_code, uso: e.uso, estado: e.estado, completed: false };
}

/** Cierre: con un checkpoint por límite duro, nunca se marca completada. */
function cerrar(root, id, { ok }) {
  const e = leer(root, id);
  if (!e) return { ok: false, reason_code: 'SIN_DECISION' };
  if (e.estado === 'PENDIENTE') return { ok: false, estado: 'PENDIENTE', reason_code: 'USER_HARD_LIMIT', checkpoint: e.checkpoint };
  e.estado = ok ? 'COMPLETADA' : 'FALLIDA';
  e.historial.push({ ts: new Date().toISOString(), evento: 'CERRADO', tier: e.decision.tier, motivo: e.estado });
  escribir(root, e);
  return { ok: !!ok, estado: e.estado };
}

module.exports = { decidir, decidirYGuardar, reevaluar, consumir, cerrar, leer, cargarPolitica, validarPolitica, DEFAULT_POLICY, ORDEN, MINIMOS };

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  const opt = {};
  const libres = [];
  for (const a of rest) { const m = /^--([^=]+)(?:=(.*))?$/s.exec(a); if (m) opt[m[1]] = m[2] === undefined ? true : m[2]; else libres.push(a); }
  const root = process.cwd();
  const json = (x) => console.log(JSON.stringify(x, null, 2));
  if (cmd === 'decide') {
    const entrada = {
      intent: libres.join(' '), task_id: opt.task, change_type: opt.type,
      paths: opt.paths ? String(opt.paths).split(',').filter(Boolean) : [],
      index_coverage: opt.index || undefined, origen: opt.origen || 'cli',
      requested_tier: opt.tier, deep_analysis: !!opt.deep,
    };
    const d = opt['dry-run'] ? decidir(entrada, { root }) : decidirYGuardar(root, entrada);
    if (opt.json) json(d);
    else console.log(`${d.task_id}: ${d.tier} (dificultad ${d.difficulty}, riesgo ${d.risk}) — ${d.reason_codes.join(', ')}\n  gates: ${d.required_gates.join(', ')}\n  roles: ${d.required_roles.join(', ')}\n  contexto ${d.context_budget_bytes} B, ${d.tool_calls_soft_limit} llamadas (blando), reparaciones ${d.max_repair_attempts}`);
  } else if (cmd === 'reevaluar') {
    json(reevaluar(root, libres[0], libres[1], libres.slice(2).join(' ')));
  } else if (cmd === 'show') {
    json(leer(root, libres[0]));
  } else {
    console.log('Uso: node effort-router.cjs decide "<intención>" [--paths=a,b] [--type=] [--task=] [--index=] [--json] | reevaluar <task_id> <EVENTO> | show <task_id>');
  }
}
