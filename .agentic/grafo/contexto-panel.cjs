'use strict';
/**
 * Datos del panel "Contexto y esfuerzo" del dashboard (H03 — Dashboard). SOLO LECTURA.
 *
 * Qué muestra, y qué NO afirma (cada punto tiene prueba):
 *   · Tier y motivo, presupuesto y consumo: salen de `.agentic/_effort/<tarea>.json` (la
 *     decisión que persiste el router de esfuerzo) y de `mem_context_usage`. Si una de las
 *     dos fuentes falta, ese dato es "no disponible", no 0.
 *   · TIPO DE MEDICIÓN en cada cifra: estimated_bytes4 (bytes ÷ 4) · tokenizer ·
 *     host_reported · not_available. Jamás se suman medidas distintas ni se llama "tokens
 *     facturados" a una estimación. Con varias medidas mezcladas: `mixed`, sin total.
 *   · Reducción NETA = original − entregado − recuperado, solo sobre las filas que tienen
 *     línea base (original_bytes > 0). Puede ser NEGATIVA (recuperar costó más de lo que
 *     se ahorró): se muestra tal cual. Sin línea base comparable: null. Es reducción de
 *     PAYLOAD de lo que Agentix entregó; no se promete ahorro de sesión, de razonamiento
 *     ni de dinero (coste: siempre "no disponible" sin precios con versión y fuente).
 *   · Cobertura del host: `observed=0` es "no observado" (Agentix no pudo ver esa
 *     herramienta), no "no se usó". Un host sin filas no prueba actividad cero.
 *   · Comparación por tarea y por rol, SIN ranking: el orden es cronológico/alfabético y
 *     se declara; nunca se ordena a una IA o rol por tokens.
 *   · Degradaciones explicadas en lenguaje simple (compresor sin actividad, evidencia
 *     caducada, referencias incompletas, herramientas no observadas, tablas ausentes).
 *   · Todo texto pasa por `seguro()` (secretos tapados, sin control, acotado) y se pagina.
 *
 * Esquema leído (lo crea `akdd update`, aquí NO se migra): mem_context_usage,
 * mem_compression_refs, mem_evidence. Los demás módulos (compresor, presupuestos) escriben
 * ahí; este panel no depende de que existan: lee las tablas y trata lo ausente como tal.
 */

const fs = require('fs');
const DONDE = (w) => (w.length ? ['WHERE', w.join(' AND ')].join(' ') : ''); // cláusula con SOLO marcadores ?: los valores viajan como parámetros
const path = require('path');
const panel = require('./memoria-panel.cjs');

const { seguro } = panel;
const LIMITE_DEF = 20;
const LIMITE_MAX = 100;
const MAX_ARCHIVOS_EFFORT = 500;
const MEDIDAS = Object.freeze({
  estimated_bytes4: 'estimación (bytes ÷ 4): no son tokens facturados',
  tokenizer: 'conteo con tokenizador conocido',
  host_reported: 'uso reportado por el host',
  not_available: 'sin medición',
});
const MOTIVOS = Object.freeze({
  AUTH_PERMISSIONS: 'toca autenticación, sesiones o permisos', PAYMENTS: 'toca pagos o facturación', MIGRATION: 'migración o cambio de esquema', SENSITIVE_DATA: 'maneja datos sensibles', TRANSACTIONS: 'transacciones o concurrencia',
  CRITICAL_FILE: 'archivo crítico', SENSITIVE_FILE: 'archivo sensible', PROTECTED_FILE: 'archivo protegido', PROTECTED_CONTRACT: 'contrato protegido', VERIFIED_CONTRACT: 'contrato verificado', PROTECTED_MANIFEST_ERROR: 'no se pudo leer la lista de archivos protegidos (se asume riesgo alto)',
  LOCAL_TEXT_CHANGE: 'cambio local de texto', STYLE_CHANGE: 'cambio de estilo', SAFE_RENAME: 'renombre seguro', DOCS_CHANGE: 'documentación', LOCALIZED_TEST: 'prueba localizada', OBVIOUS_BUG: 'error evidente', BOUNDED_BUG: 'error acotado', FEATURE: 'funcionalidad nueva', REFACTOR: 'refactor', CROSS_CUTTING: 'cambio transversal',
  UNEXPECTED_DEPENDENCY: 'apareció una dependencia inesperada', REPEATED_FAILURE: 'fallos repetidos', WIDER_IMPACT: 'el impacto resultó mayor', AMBIGUOUS_CRITERIA: 'criterios ambiguos', NO_PROGRESS: 'sin avance', RISK_DISCOVERED: 'se descubrió un riesgo', SOFT_LIMIT: 'superó el límite blando de presupuesto', SCOPE_BOUNDED: 'el alcance resultó menor',
});
const intentar = (fn, d) => { try { return fn(); } catch { return d; } };
const entero = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);
const motivoTexto = (c) => MOTIVOS[c] || seguro(c, 60);

// ───────────────────────── decisión de esfuerzo (archivos) ──────────────────
function dirEffort(root) { return path.join(root, '.agentic', '_effort'); }

function leerEsfuerzo(root, taskId) {
  if (!/^[\w.-]{1,80}$/.test(String(taskId || ''))) return null;
  const j = intentar(() => JSON.parse(fs.readFileSync(path.join(dirEffort(root), taskId + '.json'), 'utf8')), null);
  if (!j || typeof j !== 'object' || !j.decision) return null;
  const d = j.decision; const u = j.uso || {};
  const hist = Array.isArray(j.historial) ? j.historial.slice(-6) : [];
  const budget = Number.isFinite(d.context_budget_bytes) ? d.context_budget_bytes : null;
  const llamadas = Number.isFinite(d.tool_calls_soft_limit) ? d.tool_calls_soft_limit : null;
  return {
    tier: seguro(d.tier, 12), risk: seguro(d.risk, 12), difficulty: seguro(d.difficulty, 12), state: seguro(j.estado, 20),
    reasons: (Array.isArray(d.reason_codes) ? d.reason_codes : []).slice(0, 12).map((c) => ({ code: seguro(c, 40), text: motivoTexto(c) })),
    roles: (Array.isArray(d.required_roles) ? d.required_roles : []).slice(0, 8).map((r) => seguro(r, 30)),
    budget: { context_bytes: budget, tool_calls_soft_limit: llamadas, hard_limit: d.user_hard_limit || null, source: 'decisión del router (.agentic/_effort)' },
    consumed_in_effort_file: { context_bytes: Number.isFinite(u.context_bytes) ? u.context_bytes : null, tool_calls: Number.isFinite(u.tool_calls) ? u.tool_calls : null },
    host_effort: seguro(d.host_effort, 30),
    history: hist.map((h) => ({ at: h.ts || null, event: seguro(h.evento, 40), text: motivoTexto(h.evento), tier: seguro(h.tier, 12), note: seguro(h.motivo, 160) })),
  };
}

function tareasSoloEsfuerzo(root, excluir, max) {
  const d = dirEffort(root);
  let nombres;
  try { nombres = fs.readdirSync(d).filter((n) => n.endsWith('.json')).slice(0, MAX_ARCHIVOS_EFFORT); } catch { return { items: [], note: null }; }
  const con = nombres.map((n) => ({ id: n.slice(0, -5), t: intentar(() => fs.statSync(path.join(d, n)).mtimeMs, 0) })).filter((x) => !excluir.has(x.id)).sort((a, b) => b.t - a.t).slice(0, max);
  return { items: con.map((x) => ({ task_id: seguro(x.id, 80), effort: leerEsfuerzo(root, x.id), usage: null, usage_note: 'esta tarea tiene decisión de esfuerzo pero ningún uso de contexto registrado: uso NO DISPONIBLE (no es 0)' })), note: null };
}

// ───────────────────────── uso de contexto (SQL) ────────────────────────────
const filasUso = (db, pid, taskId, role) => db.all(
  `SELECT kind, COALESCE(role, '') AS role, observed, measure, count(*) AS n,
          COALESCE(SUM(original_bytes),0) AS o, COALESCE(SUM(delivered_bytes),0) AS d, COALESCE(SUM(recovered_bytes),0) AS r,
          COALESCE(SUM(CASE WHEN original_bytes > 0 THEN original_bytes ELSE 0 END),0) AS bo,
          COALESCE(SUM(CASE WHEN original_bytes > 0 THEN delivered_bytes ELSE 0 END),0) AS bd,
          SUM(tokens_delivered) AS td, SUM(tokens_original) AS tor, count(tokens_delivered) AS ntd, AVG(latency_ms) AS lat
     FROM mem_context_usage WHERE project_id = ? AND task_id = ?${role ? ' AND role = ?' : ''} GROUP BY 1,2,3,4`,
  ...(role ? [pid, taskId, role] : [pid, taskId]));

/** Agrega las filas de una tarea. La medición se separa por tipo; lo no observado no suma. */
function agregar(filas) {
  const u = {
    calls: 0, observed_calls: 0, unobserved_calls: 0, delivered_bytes: 0, recovered_bytes: 0, original_bytes: 0,
    baseline_original_bytes: 0, baseline_delivered_bytes: 0, retrievals: 0, by_kind: {}, by_role: {}, by_measure: {}, unobserved: [],
  };
  const lat = [];
  for (const f of filas) {
    const n = entero(f.n);
    if (!Number(f.observed)) { u.unobserved_calls += n; if (!u.unobserved.includes(f.kind)) u.unobserved.push(f.kind); continue; }
    u.calls += n; u.observed_calls += n;
    u.delivered_bytes += entero(f.d); u.recovered_bytes += entero(f.r); u.original_bytes += entero(f.o);
    u.baseline_original_bytes += entero(f.bo); u.baseline_delivered_bytes += entero(f.bd);
    if (f.kind === 'evidence_retrieval') u.retrievals += n;
    const k = (u.by_kind[f.kind] = u.by_kind[f.kind] || { calls: 0, delivered_bytes: 0, recovered_bytes: 0 });
    k.calls += n; k.delivered_bytes += entero(f.d); k.recovered_bytes += entero(f.r);
    const rol = f.role || '(sin rol)';
    const r = (u.by_role[rol] = u.by_role[rol] || { calls: 0, delivered_bytes: 0, recovered_bytes: 0 });
    r.calls += n; r.delivered_bytes += entero(f.d); r.recovered_bytes += entero(f.r);
    const m = (u.by_measure[f.measure] = u.by_measure[f.measure] || { rows: 0, delivered_bytes: 0, tokens_delivered: 0, rows_with_tokens: 0 });
    m.rows += n; m.delivered_bytes += entero(f.d) + entero(f.r);
    if (f.td !== null && f.td !== undefined) { m.tokens_delivered += entero(f.td); m.rows_with_tokens += entero(f.ntd); }
    if (f.lat !== null && f.lat !== undefined) lat.push(Number(f.lat));
  }
  u.total_delivered_bytes = u.delivered_bytes + u.recovered_bytes; // lo recuperado después también llegó al modelo
  u.avg_latency_ms = lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null;
  return u;
}

/** Cifra de tokens con su tipo: nunca se mezclan medidas. */
function tokensDe(u) {
  const tipos = Object.keys(u.by_measure);
  if (!tipos.length) return { value: null, type: 'not_available', label: MEDIDAS.not_available };
  if (tipos.length > 1) {
    const partes = {};
    for (const t of tipos) partes[t] = t === 'estimated_bytes4' ? Math.ceil(u.by_measure[t].delivered_bytes / 4) : u.by_measure[t].tokens_delivered;
    return { value: null, type: 'mixed', parts: partes, label: 'medidas distintas (' + tipos.join(' + ') + '): no se suman' };
  }
  const t = tipos[0];
  if (t === 'estimated_bytes4') return { value: Math.ceil(u.by_measure[t].delivered_bytes / 4), type: t, label: MEDIDAS[t] };
  if (t === 'not_available') return { value: null, type: t, label: MEDIDAS[t] };
  return { value: u.by_measure[t].rows_with_tokens ? u.by_measure[t].tokens_delivered : null, type: t, label: MEDIDAS[t], partial: u.by_measure[t].rows_with_tokens < u.by_measure[t].rows };
}

function reduccionNeta(u) {
  if (!(u.baseline_original_bytes > 0)) return { net_bytes: null, net_pct: null, baseline_comparable: false, note: 'sin línea base comparable: no hay filas con el tamaño original registrado. No se calcula ahorro.', scope: 'payload' };
  const net = u.baseline_original_bytes - u.baseline_delivered_bytes - u.recovered_bytes;
  return {
    net_bytes: net, net_pct: Math.round((net / u.baseline_original_bytes) * 1000) / 10, baseline_comparable: true, scope: 'payload',
    original_bytes: u.baseline_original_bytes, delivered_bytes: u.baseline_delivered_bytes, recovered_bytes: u.recovered_bytes,
    note: (net < 0 ? 'NEGATIVA: recuperar originales costó más que lo que se redujo. ' : '') + 'Es reducción de lo que Agentix entregó (payload), no ahorro de sesión, de razonamiento ni de dinero.',
  };
}

function usoPublico(u) {
  return {
    calls: u.calls, observed_calls: u.observed_calls, unobserved_calls: u.unobserved_calls, unobserved_kinds: u.unobserved,
    delivered_bytes: u.delivered_bytes, recovered_bytes: u.recovered_bytes, total_delivered_bytes: u.total_delivered_bytes,
    retrievals: u.retrievals, tokens: tokensDe(u), net_reduction: reduccionNeta(u),
    by_kind: u.by_kind, by_role: u.by_role, by_measure: u.by_measure, avg_latency_ms: u.avg_latency_ms,
    cost: { available: false, note: 'coste en dinero: no disponible (sin precios con versión y fuente conocidas)' },
  };
}

// ───────────────────────── cobertura, compresión, degradaciones ─────────────
function cobertura(db, pid) {
  const tot = db.all('SELECT observed, count(*) AS n FROM mem_context_usage WHERE project_id = ? GROUP BY observed', pid);
  const obs = entero((tot.find((r) => Number(r.observed) === 1) || {}).n);
  const no = entero((tot.find((r) => Number(r.observed) === 0) || {}).n);
  const kinds = db.all('SELECT kind, observed, count(*) AS n FROM mem_context_usage WHERE project_id = ? GROUP BY 1,2 ORDER BY 1', pid);
  const detalles = db.all("SELECT detail, count(*) AS n FROM mem_context_usage WHERE project_id = ? AND observed = 0 GROUP BY detail ORDER BY count(*) DESC LIMIT 10", pid);
  const total = obs + no;
  return {
    observed_rows: obs, unobserved_rows: no,
    quality: total === 0 ? 'sin_datos' : (no === 0 ? 'completa' : 'parcial'),
    observed_pct: total ? Math.round((obs / total) * 1000) / 10 : null,
    kinds_observed: kinds.filter((k) => Number(k.observed) === 1).map((k) => ({ kind: seguro(k.kind, 40), rows: entero(k.n) })),
    not_observed: detalles.map((d) => ({ what: seguro(d.detail || 'herramienta del host', 160), rows: entero(d.n) })),
    note: 'Solo cuenta lo que Agentix pudo observar. "No observado" no significa "no se usó"; un host sin filas no prueba actividad cero.',
  };
}

function compresion(db, hay, pid) {
  if (!hay.has('mem_compression_refs')) return { available: false, reason: 'SCHEMA_MISSING', note: 'falta la tabla mem_compression_refs: akdd update' };
  const r = db.get('SELECT count(*) AS n, COALESCE(SUM(original_bytes),0) AS o, COALESCE(SUM(delivered_bytes),0) AS d, COALESCE(SUM(recovered_bytes),0) AS rec, COALESCE(SUM(retrieval_count),0) AS rc, COALESCE(SUM(CASE WHEN complete = 0 THEN 1 ELSE 0 END),0) AS inc FROM mem_compression_refs WHERE project_id = ?', pid);
  const metodos = db.all('SELECT compression_method AS m, count(*) AS n FROM mem_compression_refs WHERE project_id = ? GROUP BY 1 ORDER BY count(*) DESC LIMIT 10', pid);
  return {
    available: true, references: entero(r.n), original_bytes: entero(r.o), delivered_bytes: entero(r.d), recovered_bytes: entero(r.rec), retrievals: entero(r.rc), incomplete_references: entero(r.inc),
    methods: metodos.map((x) => ({ method: seguro(x.m, 40), references: entero(x.n) })),
    measure: 'estimated_bytes4', note: 'tamaños en bytes de lo que Agentix entregó; no son tokens ni coste',
  };
}

function degradaciones(db, hay, pid, usoTotal, comp, cob, efectoSinTier, compresionesEnUso) {
  const d = [];
  if (!hay.has('mem_context_usage')) d.push({ code: 'SIN_TABLAS', level: 'warn', message: 'Todavía no está instalada la tabla de uso de contexto: no hay datos que mostrar. Ejecuta akdd update.' });
  else if (usoTotal === 0) d.push({ code: 'SIN_USO_REGISTRADO', level: 'info', message: 'Aún no se registró ningún uso de contexto. Eso no significa que el consumo fue cero: significa que no hay medición.' });
  if (comp && comp.available && comp.references === 0 && !compresionesEnUso) d.push({ code: 'COMPRESOR_SIN_ACTIVIDAD', level: 'info', message: 'No hay compresiones registradas: el compresor puede estar desactivado o no haberse usado todavía. Mientras tanto Agentix entrega el contenido original completo (sin reducción).' });
  if (comp && comp.available && comp.incomplete_references > 0) d.push({ code: 'REFERENCIAS_INCOMPLETAS', level: 'warn', message: comp.incomplete_references + ' resultado(s) se entregaron resumidos y no se pueden recuperar completos: el modelo vio una parte.' });
  if (hay.has('mem_evidence')) {
    const e = db.all("SELECT status, count(*) AS n FROM mem_evidence WHERE project_id = ? AND status IN ('EXPIRED','UNAVAILABLE','CHANGED') GROUP BY 1", pid);
    const mapa = { EXPIRED: 'la caché de originales caducó', UNAVAILABLE: 'el original ya no está en disco', CHANGED: 'el original cambió desde que se guardó' };
    for (const x of e) d.push({ code: 'EVIDENCIA_' + x.status, level: 'warn', message: entero(x.n) + ' referencia(s): ' + mapa[x.status] + '. Esas referencias no se pueden recuperar; se entrega el contenido original o se avisa.' });
  }
  if (cob && cob.quality === 'parcial') d.push({ code: 'HERRAMIENTAS_NO_OBSERVADAS', level: 'warn', message: 'Agentix no pudo observar algunas herramientas del host: las cifras son un mínimo, no el total.' });
  if (efectoSinTier) d.push({ code: 'SIN_DECISION_DE_ESFUERZO', level: 'info', message: 'No hay decisiones de esfuerzo guardadas (.agentic/_effort): no se puede mostrar el nivel ni el presupuesto de ninguna tarea.' });
  return d;
}

function proveedor(root) {
  const er = intentar(() => require('./effort-router.cjs'), null);
  const c = er && typeof er.capacidadProveedor === 'function' ? intentar(() => er.capacidadProveedor(root), null) : null;
  return c ? { capability: seguro(c.capability, 40), can_set_reasoning: !!c.can_set_reasoning, note: c.can_set_reasoning ? null : 'Agentix controla el contexto que entrega; el razonamiento interno del host no es controlable.' }
    : { capability: 'no_disponible', can_set_reasoning: false, note: 'el razonamiento interno del host no es controlable por Agentix' };
}

// ───────────────────────── entrada principal ────────────────────────────────
/**
 * opts: { cursor, limit, task, role }
 * cursor = último usage_id visto (keyset descendente por tarea más reciente).
 */
function resumen(root, opts = {}) {
  const lim = Number.isInteger(Number(opts.limit)) && Number(opts.limit) > 0 ? Math.min(Number(opts.limit), LIMITE_MAX) : LIMITE_DEF;
  const stamp = panel.marca(root).context;
  const p = panel.abrirPanel(root);
  if (p.error) return { status: 'UNAVAILABLE', reason_code: p.error.code, data: { available: false, ...p.error, stamp } };
  try {
    const { db, hay, pid, ident } = p;
    const conUso = hay.has('mem_context_usage') && !!pid;
    const cur = Number.isInteger(Number(opts.cursor)) && Number(opts.cursor) > 0 ? Number(opts.cursor) : null;
    let tareas = []; let coverage = { shown: 0, truncated: false, next_cursor: null, total: null, cursor_kind: 'usage_id' };
    let totales = null; let cob = null; let porRol = null;
    if (conUso) {
      const w = ['project_id = ?']; const a = [pid];
      if (opts.task) { w.push('task_id = ?'); a.push(opts.task); }
      if (opts.role) { w.push('role = ?'); a.push(opts.role); }
      const filas = db.all('SELECT task_id, MAX(usage_id) AS last_id, MIN(created_at) AS first_at, MAX(created_at) AS last_at FROM mem_context_usage ' + DONDE(w) + ' GROUP BY task_id' + (cur ? ' HAVING MAX(usage_id) < ?' : '') + ' ORDER BY last_id DESC LIMIT ?', ...a, ...(cur ? [cur] : []), lim + 1);
      const hayMas = filas.length > lim;
      const pagina = hayMas ? filas.slice(0, lim) : filas;
      coverage = { shown: pagina.length, truncated: hayMas, next_cursor: hayMas ? Number(pagina[pagina.length - 1].last_id) : null, total: null, cursor_kind: 'usage_id' };
      tareas = pagina.map((f) => {
        const u = agregar(filasUso(db, pid, f.task_id, opts.role));
        const ef = leerEsfuerzo(root, f.task_id);
        const presupuesto = ef && ef.budget.context_bytes;
        const consumido = u.total_delivered_bytes;
        return {
          task_id: seguro(f.task_id, 80), first_at: f.first_at, last_at: f.last_at, effort: ef, usage: usoPublico(u),
          budget_use: presupuesto ? { budget_bytes: presupuesto, consumed_bytes: consumido, consumed_pct: Math.round((consumido / presupuesto) * 1000) / 10, over_budget: consumido > presupuesto, source: 'entregado + recuperado, de mem_context_usage' } : null,
        };
      });
      // Totales del proyecto (no de la página): una sola agregación por tipo.
      const todas = db.all(
        `SELECT kind, COALESCE(role, '') AS role, observed, measure, count(*) AS n,
                COALESCE(SUM(original_bytes),0) AS o, COALESCE(SUM(delivered_bytes),0) AS d, COALESCE(SUM(recovered_bytes),0) AS r,
                COALESCE(SUM(CASE WHEN original_bytes > 0 THEN original_bytes ELSE 0 END),0) AS bo,
                COALESCE(SUM(CASE WHEN original_bytes > 0 THEN delivered_bytes ELSE 0 END),0) AS bd,
                SUM(tokens_delivered) AS td, SUM(tokens_original) AS tor, count(tokens_delivered) AS ntd, AVG(latency_ms) AS lat
           FROM mem_context_usage WHERE project_id = ?${opts.role ? ' AND role = ?' : ''} GROUP BY 1,2,3,4`, ...(opts.role ? [pid, opts.role] : [pid]));
      const ut = agregar(todas);
      totales = usoPublico(ut);
      // Comparación por rol: orden ALFABÉTICO declarado; nunca por tokens.
      porRol = Object.keys(ut.by_role).sort().map((r) => ({ role: seguro(r, 40), ...ut.by_role[r] }));
      cob = cobertura(db, pid);
    }
    const comp = hay.has('mem_context_usage') || hay.has('mem_compression_refs') ? (pid ? compresion(db, hay, pid) : { available: false, reason: 'SIN_IDENTIDAD' }) : { available: false, reason: 'SCHEMA_MISSING' };
    // Tareas con decisión de esfuerzo pero sin uso: solo en la primera página y sin filtros.
    let sinUso = [];
    if (!cur && !opts.task && !opts.role) sinUso = tareasSoloEsfuerzo(root, new Set(tareas.map((t) => t.task_id)), 20).items;
    const sinTier = !intentar(() => fs.readdirSync(dirEffort(root)).some((n) => n.endsWith('.json')), false);
    const usoTotal = totales ? totales.calls + totales.unobserved_calls : 0;
    return {
      status: tareas.length || sinUso.length || totales ? 'OK' : 'EMPTY',
      coverage,
      data: {
        available: true, identity: { state: ident.state },
        measurement: { types: MEDIDAS, note: 'Cada cifra lleva su tipo de medición. bytes ÷ 4 es una estimación; nunca se suma con tokens exactos ni se llama "tokens facturados".' },
        provider: proveedor(root),
        totals: totales, by_role: porRol, by_role_note: 'ordenado alfabéticamente: esto compara, no clasifica. No hay ranking de IA o rol por tokens.',
        host_coverage: cob, compression: comp,
        degradations: degradaciones(db, hay, pid, usoTotal, comp, cob, sinTier, totales && totales.by_kind.compression ? totales.by_kind.compression.calls : 0),
        tasks: tareas, tasks_without_usage: sinUso,
        tasks_order: 'más reciente primero (no por consumo)',
        stamp,
      },
    };
  } finally { p.cerrar(); }
}

module.exports = { MEDIDAS, MOTIVOS, resumen, agregar, tokensDe, reduccionNeta, leerEsfuerzo, LIMITE_MAX };
