'use strict';
/**
 * Registro de uso de contexto por tarea (H02 "Presupuestos acumulados", H03 "Métricas").
 *
 * Un solo sitio donde cada módulo (recuperación por capas, compresor, TEAMS,
 * lectura de archivos) anota lo que ENTREGÓ y lo que se RECUPERÓ después, por
 * task_id. El presupuesto es ACUMULADO: cambiar de rol o pedir otro recall no lo
 * reinicia, porque la clave es la tarea, no el rol ni la llamada.
 *
 * Honestidad de la medición (por qué hay campos que parecen redundantes):
 *   · `measure` dice CÓMO se midió: 'estimated_bytes4' (bytes/4, estimación),
 *     'tokenizer' (tokenizador conocido), 'host_reported' (uso reportado por el
 *     host) o 'not_available'. Nunca se suman bytes/4 con uso exacto y se llama
 *     "medición" a todo.
 *   · `observed=0` registra que Agentix NO pudo observar una herramienta del host.
 *     Un contador en 0 no demuestra que no se usó: se reporta como "no observado".
 *   · Los latidos/heartbeat NO cuentan como progreso de tarea (no se registran).
 *
 * Escribir aquí es auxiliar: si falla (sin tablas, base ocupada) devuelve
 * { ok:false } y NUNCA lanza ni bloquea a quien lo llama.
 */

const crypto = require('crypto');
const core = require('./memory-core.cjs');

const KINDS = Object.freeze([
  'recall_index', 'recall_detail', 'timeline', 'evidence_retrieval', 'compression', 'search', 'file_read',
  'tool_call', 'delegation', 'repair', 'reread_unchanged', 'cache_hit', 'cache_invalidation', 'host_tool',
  'context_pack', 'packet_sent', 'packet_delta',
]);
const MEASURES = Object.freeze(['estimated_bytes4', 'tokenizer', 'host_reported', 'not_available']);
const iso = (o) => new Date(o && o.now ? o.now : Date.now()).toISOString();
const entero = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0);

/** Estimación declarada: bytes/4. Nunca se presenta como tokens facturados. */
const estimarTokens = (bytes) => Math.ceil(entero(bytes) / 4);

function registrar(root, u, opts = {}) {
  let db = null;
  try {
    if (!u || !u.task_id) return { ok: false, code: 'TASK_ID_REQUERIDO' };
    if (!KINDS.includes(u.kind)) return { ok: false, code: 'KIND_INVALIDO', allowed: KINDS };
    const measure = u.measure || 'estimated_bytes4';
    if (!MEASURES.includes(measure)) return { ok: false, code: 'MEASURE_INVALIDO', allowed: MEASURES };
    db = core.abrir(root, { write: true });
    if (!db) return { ok: false, code: 'NO_DB' };
    if (core.tablasFaltantes(db, ['mem_context_usage', 'mem_project']).length) return { ok: false, code: 'SCHEMA_MISSING' };
    const ident = core.identidad(root);
    if (ident.state === 'ROOT_MISMATCH') return { ok: false, code: 'PROJECT_ROOT_MISMATCH' };
    let pid = ident.project_id;
    if (!pid) {
      pid = 'prj_' + crypto.randomUUID().replace(/-/g, '');
      db.run('INSERT OR IGNORE INTO mem_project (singleton, project_id, canonical_root, created_at, origin) VALUES (1, ?, ?, ?, ?)', pid, core.canonicalRoot(root), iso(opts), 'created');
      pid = db.get('SELECT project_id FROM mem_project WHERE singleton = 1').project_id;
    }
    const observed = u.observed === false ? 0 : 1;
    db.run(
      `INSERT INTO mem_context_usage (project_id, task_id, sprint_id, role, kind, original_bytes, delivered_bytes, recovered_bytes, measure, tokens_original, tokens_delivered, latency_ms, observed, detail, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      pid, String(u.task_id), u.sprint_id || null, u.role || null, u.kind, entero(u.original_bytes), entero(u.delivered_bytes), entero(u.recovered_bytes), measure,
      Number.isFinite(Number(u.tokens_original)) ? entero(u.tokens_original) : null, Number.isFinite(Number(u.tokens_delivered)) ? entero(u.tokens_delivered) : null,
      Number.isFinite(Number(u.latency_ms)) ? entero(u.latency_ms) : null, observed, u.detail ? String(u.detail).slice(0, 500) : null, iso(opts));
    return { ok: true };
  } catch (e) {
    return { ok: false, code: e && e.code === 'DB_BUSY' ? 'DB_BUSY' : 'USAGE_FAILED', message: e && e.message };
  } finally { try { if (db) db.close(); } catch { /* ya cerrada */ } }
}

/** Anota que una herramienta del host NO fue observada (no es un 0: es "no sé"). */
function registrarNoObservado(root, { task_id, role, detail }, opts) {
  return registrar(root, { task_id, role, kind: 'host_tool', observed: false, measure: 'not_available', detail: detail || 'herramienta del host no observada por Agentix' }, opts);
}

/**
 * Acumulado de una tarea (todas las llamadas, todos los roles). Dato ausente = null.
 * { delivered_bytes, recovered_bytes, original_bytes, calls, by_kind, by_role, observed, unobserved }
 */
function acumulado(root, task_id) {
  const db = core.abrir(root);
  if (!db) return { available: false, code: 'NO_DB' };
  try {
    if (core.tablasFaltantes(db, ['mem_context_usage']).length) return { available: false, code: 'SCHEMA_MISSING' };
    const filas = db.all('SELECT kind, role, observed, measure, count(*) AS n, COALESCE(SUM(original_bytes),0) AS o, COALESCE(SUM(delivered_bytes),0) AS d, COALESCE(SUM(recovered_bytes),0) AS r FROM mem_context_usage WHERE task_id = ? GROUP BY kind, role, observed, measure', String(task_id));
    const out = { available: true, task_id: String(task_id), original_bytes: 0, delivered_bytes: 0, recovered_bytes: 0, calls: 0, by_kind: {}, by_role: {}, measures: {}, unobserved: [] };
    for (const f of filas) {
      if (!Number(f.observed)) { if (!out.unobserved.includes(f.kind)) out.unobserved.push(f.kind); continue; }
      out.original_bytes += Number(f.o); out.delivered_bytes += Number(f.d); out.recovered_bytes += Number(f.r); out.calls += Number(f.n);
      const k = (out.by_kind[f.kind] = out.by_kind[f.kind] || { calls: 0, delivered_bytes: 0, recovered_bytes: 0 });
      k.calls += Number(f.n); k.delivered_bytes += Number(f.d); k.recovered_bytes += Number(f.r);
      const r = f.role || '(sin rol)';
      const x = (out.by_role[r] = out.by_role[r] || { calls: 0, delivered_bytes: 0 });
      x.calls += Number(f.n); x.delivered_bytes += Number(f.d);
      out.measures[f.measure] = (out.measures[f.measure] || 0) + Number(f.n);
    }
    // Lo recuperado después también se entregó al modelo: cuenta en el total entregado.
    out.total_delivered_bytes = out.delivered_bytes + out.recovered_bytes;
    out.estimated_tokens = estimarTokens(out.total_delivered_bytes);
    out.token_measure = Object.keys(out.measures).length === 1 ? Object.keys(out.measures)[0] : (Object.keys(out.measures).length ? 'mixed' : 'not_available');
    return out;
  } finally { db.close(); }
}

module.exports = { KINDS, MEASURES, registrar, registrarNoObservado, acumulado, estimarTokens };
