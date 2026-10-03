'use strict';
/**
 * Datos del panel "Memoria" del dashboard (C03). SOLO LECTURA, salvo `reintentar`.
 *
 * Responde, sin que nadie abra SQLite: ¿qué está guardado? ¿qué falta procesar? ¿qué
 * evidencia respalda este conocimiento? ¿dónde hay huecos de captura?
 *
 * Reglas (cada una tiene prueba en test/memoria-dashboard.test.cjs):
 *   · Dato ausente = null / { available:false, reason } — jamás un 0 que parezca verdad.
 *   · Tres grados de certeza distintos, nunca mezclados:
 *       asserted  "el agente lo afirmó"      (registro antiguo o sin respaldo)
 *       observed  "observado"                (nace de actividad registrada; aún sin validar)
 *       verified  "verificado"               (VALIDATED con evidencia vigente y validador permitido)
 *   · Nada de lo que se entrega es HTML: todo texto pasa por `seguro()` (sin caracteres
 *     de control, secretos tapados con falla-cerrado, longitud acotada) y la página lo
 *     pinta con textContent. Un `<script>` en un título es TEXTO.
 *   · Lo privado/redactado no se revela: un evento de ruta denegada o clase private/unknown
 *     solo expone metadatos. El original NUNCA está en la base (se guarda ya redactado), y
 *     aquí además se vuelve a redactar al mostrar (defensa en profundidad).
 *   · Aislamiento: todo se filtra por el project_id de ESTA memoria. Si la memoria pertenece
 *     a otra ruta (ROOT_MISMATCH: copia de otro proyecto) no se listan sus filas mem_*.
 *   · Paginación por cursor (rowid, keyset): memoria acotada con una base enorme. Sin SQL
 *     arbitrario: todo valor del navegador es un parámetro enlazado o una lista cerrada.
 *   · Acción única permitida: reintentar un job muerto (validado, con límite y registro).
 *     Jamás se borra memoria para vaciar la cola ni se pasa nada de observado a validado.
 */

const fs = require('fs');
const DONDE = (w) => (w.length ? ['WHERE', w.join(' AND ')].join(' ') : ''); // cláusula con SOLO marcadores ?: los valores viajan como parámetros
const path = require('path');
const crypto = require('crypto');
const core = require('./memory-core.cjs');
const privacy = require('./memory-privacy.cjs');

const LIMITE_DEF = 25;
const LIMITE_MAX = 200;
const EXPORT_MAX = 1000;
const RETRY_VENTANA_MS = 60000;
const RETRY_MAX_POR_VENTANA = 10;
const KINDS = Object.freeze(['events', 'observations', 'knowledge']);
const EPISTEMICOS = Object.freeze({
  asserted: 'El agente lo afirmó (sin actividad ni evidencia que lo respalde)',
  observed: 'Observado: nace de actividad registrada, aún sin validar',
  verified: 'Verificado: validado con evidencia vigente',
});

const iso = (o) => new Date(o && o.now ? o.now : Date.now()).toISOString();
const parseJSON = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const intentar = (fn, d) => { try { return fn(); } catch { return d; } };

/** Texto seguro para entregar: sin control, secretos tapados (falla cerrado) y acotado. */
function seguro(valor, max = 300) {
  if (valor == null) return null;
  const r = privacy.redactarSecretos(String(valor), null);
  if (!r.ok) return privacy.FALLO;
  // eslint-disable-next-line no-control-regex
  const t = r.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/g, ' ');
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function limiteDe(n, def = LIMITE_DEF, max = LIMITE_MAX) {
  const x = Number(n);
  return Number.isInteger(x) && x > 0 ? Math.min(x, max) : def;
}

/** Abre solo lectura y devuelve { db, hay, ident, pid, cerrar } o { error }. */
function abrirPanel(root) {
  let db;
  try { db = core.abrir(root); } catch (e) { return { error: { available: false, code: 'DB_UNREADABLE', message: String(e.message || e).slice(0, 160) } }; }
  if (!db) return { error: { available: false, code: 'NO_DB', hint: 'el proyecto aún no tiene memoria.db' } };
  const cerrar = () => { try { db.close(); } catch { /* ya cerrada */ } };
  try {
    db.get('SELECT count(*) AS n FROM sqlite_master');
    const hay = new Set(db.all("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name));
    let ident = { state: 'NO_IDENTITY' };
    if (hay.has('mem_project')) {
      const row = db.get('SELECT * FROM mem_project WHERE singleton = 1');
      const actual = core.canonicalRoot(root);
      if (row) ident = row.canonical_root !== actual ? { state: 'ROOT_MISMATCH', origin: row.origin } : { state: 'OK', project_id: row.project_id, origin: row.origin };
    }
    return { db, hay, ident, pid: ident.state === 'OK' ? ident.project_id : null, cerrar };
  } catch (e) {
    cerrar();
    return { error: { available: false, code: 'DB_UNREADABLE', message: String(e.message || e).slice(0, 160) } };
  }
}

/** Identidad para mostrar: el project_id interno NO sale (otro proyecto no debe poder pedirlo). */
const identidadPublica = (id) => ({ state: id.state, origin: id.origin || null, hint: id.state === 'ROOT_MISMATCH' ? 'esta memoria pertenece a otra ruta (copia o renombre): no se listan sus actividades. Renombre del mismo proyecto: akdd memory project adopt · copia: akdd memory project fork' : (id.state === 'NO_IDENTITY' ? 'aún no se ha capturado ninguna actividad en este proyecto' : null) });

// ───────────────────────── sello de cambios (para SSE) ──────────────────────
/**
 * Huella barata de "algo cambió" para el canal SSE existente. Solo contadores y marcas
 * de tiempo: NO viaja contenido. Dato ausente = 'na' (no se confunde con 0).
 */
function marca(root) {
  const h = (x) => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 12);
  const mtime = (f) => intentar(() => String(fs.statSync(f).mtimeMs), 'na');
  const ctx = { effort: mtime(path.join(root, '.agentic', '_effort')) };
  const mem = { update: mtime(path.join(root, '.agentic', '_update', 'last-result.json')) };
  const p = abrirPanel(root);
  if (p.error) return { memory: h({ mem, db: p.error.code }), context: h({ ctx, db: p.error.code }) };
  try {
    const q = (t, sql) => (p.hay.has(t) ? intentar(() => p.db.all(sql), 'na') : 'na');
    mem.events = q('mem_events', 'SELECT MAX(rowid) AS m FROM mem_events');
    mem.obs = q('mem_observations', 'SELECT status, count(*) AS n FROM mem_observations GROUP BY status');
    mem.jobs = q('mem_jobs', 'SELECT state, count(*) AS n, MAX(updated_at) AS u FROM mem_jobs GROUP BY state');
    mem.know = q('mem_knowledge', 'SELECT state, count(*) AS n, MAX(updated_at) AS u FROM mem_knowledge GROUP BY state');
    mem.health = q('mem_health', 'SELECT MAX(checked_at) AS m FROM mem_health');
    mem.ident = p.ident.state;
    ctx.usage = q('mem_context_usage', 'SELECT MAX(usage_id) AS m FROM mem_context_usage');
    ctx.refs = q('mem_compression_refs', 'SELECT count(*) AS n, COALESCE(SUM(retrieval_count),0) AS r FROM mem_compression_refs');
    return { memory: h(mem), context: h(ctx) };
  } finally { p.cerrar(); }
}

// ───────────────────────── inventario y huecos ──────────────────────────────
const VIGENTE_NO = new Set(['OBSOLETO', 'SUPERSEDED', 'HISTORICO']);

function inventario(p) {
  const { db, hay, pid } = p;
  const out = { nodes_total: null, by_type: null, legacy_without_provenance: null, knowledge_by_state: null, observations_by_status: null, events_total: null, evidence_total: null, evidence_by_status: null };
  if (hay.has('nodos')) {
    const filas = intentar(() => db.all("SELECT tipo, estado, COALESCE(vigencia_tipo, '') AS v, count(*) AS n FROM nodos GROUP BY 1,2,3"), null);
    if (filas) {
      const por = {};
      let total = 0;
      for (const f of filas) {
        const t = (por[f.tipo] = por[f.tipo] || { tipo: seguro(f.tipo, 40), count: 0, current: 0, suspect: 0, obsolete: 0 });
        const n = Number(f.n); t.count += n; total += n;
        if (f.estado === 'OBSOLETO' || VIGENTE_NO.has(f.v)) t.obsolete += n;
        else if (f.v === 'SOSPECHOSO') t.suspect += n;
        else t.current += n;
      }
      out.by_type = Object.values(por).sort((a, b) => b.count - a.count);
      out.nodes_total = total;
      out.legacy_without_provenance = hay.has('mem_knowledge') && pid
        ? Number(db.get('SELECT count(*) AS n FROM nodos n WHERE NOT EXISTS (SELECT 1 FROM mem_knowledge k WHERE k.node_id = CAST(n.id AS TEXT) AND k.project_id = ?)', pid).n)
        : (!hay.has('mem_knowledge') || p.ident.state === 'NO_IDENTITY' ? total : null); // sin tabla o sin identidad aún: no hay procedencia nueva posible. ROOT_MISMATCH: no disponible
    }
  }
  if (pid) {
    if (hay.has('mem_knowledge')) out.knowledge_by_state = db.all('SELECT state, provenance, count(*) AS n FROM mem_knowledge WHERE project_id = ? GROUP BY 1,2 ORDER BY 1,2', pid).map((r) => ({ state: r.state, provenance: r.provenance, count: Number(r.n) }));
    if (hay.has('mem_observations')) out.observations_by_status = db.all('SELECT status, count(*) AS n FROM mem_observations WHERE project_id = ? GROUP BY 1 ORDER BY 1', pid).map((r) => ({ status: r.status, count: Number(r.n) }));
    if (hay.has('mem_events')) out.events_total = Number(db.get('SELECT count(*) AS n FROM mem_events WHERE project_id = ?', pid).n);
    if (hay.has('mem_evidence')) {
      out.evidence_by_status = db.all('SELECT status, count(*) AS n FROM mem_evidence WHERE project_id = ? GROUP BY 1 ORDER BY 1', pid).map((r) => ({ status: r.status, count: Number(r.n) }));
      out.evidence_total = out.evidence_by_status.reduce((a, r) => a + r.count, 0);
    }
  }
  return out;
}

/** Huecos de captura: lo que NO se capturó se muestra explícitamente, no se omite. */
function huecos(p, inv) {
  const { db, hay, pid } = p;
  const g = [];
  if (!hay.has('mem_events')) { g.push({ code: 'SIN_TABLAS_DE_CAPTURA', message: 'faltan las tablas de captura: la memoria con procedencia no está instalada en esta base', action: 'akdd update' }); return g; }
  if (!pid) { g.push({ code: p.ident.state === 'ROOT_MISMATCH' ? 'IDENTIDAD_OTRA_RUTA' : 'SIN_CAPTURA', message: p.ident.state === 'ROOT_MISMATCH' ? 'la memoria pertenece a otra ruta: no se muestran sus actividades' : 'todavía no hay ninguna actividad capturada en este proyecto' }); return g; }
  if (inv.events_total === 0 && inv.nodes_total > 0) g.push({ code: 'SIN_CAPTURA', message: 'hay ' + inv.nodes_total + ' conocimientos pero ninguna actividad capturada: ese conocimiento no tiene actividad de origen (es anterior a la captura o el host no entrega eventos)' });
  const ses = db.all('SELECT host, session_id, count(*) AS n, MIN(sequence) AS mn, MAX(sequence) AS mx FROM mem_events WHERE project_id = ? AND sequence > 0 GROUP BY host, session_id ORDER BY MAX(occurred_at) DESC LIMIT 100', pid);
  for (const s of ses) {
    const faltan = Number(s.mx) - Number(s.mn) + 1 - Number(s.n);
    if (faltan > 0) g.push({ code: 'SECUENCIA_CON_SALTOS', host: seguro(s.host, 60), session: seguro(s.session_id, 60), missing: faltan, message: 'faltan ' + faltan + ' evento(s) entre la secuencia ' + s.mn + ' y ' + s.mx + ': el host no los entregó o se perdieron' });
  }
  const sup = Number(db.get("SELECT count(*) AS n FROM mem_events WHERE project_id = ? AND privacy_class IN ('private','unknown')", pid).n);
  if (sup > 0) g.push({ code: 'EVENTOS_PRIVADOS', count: sup, message: sup + ' actividad(es) se guardaron solo como metadatos (ruta o contenido privado): no hay su contenido a propósito' });
  if (hay.has('mem_observations')) {
    const f = Number(db.get("SELECT count(*) AS n FROM mem_observations WHERE project_id = ? AND status = 'FAILED'", pid).n);
    if (f > 0) g.push({ code: 'OBSERVACIONES_FALLIDAS', count: f, message: f + ' observación(es) no se pudieron procesar' });
  }
  if (hay.has('mem_context_usage')) {
    const no = db.all("SELECT detail, count(*) AS n FROM mem_context_usage WHERE project_id = ? AND observed = 0 GROUP BY detail ORDER BY count(*) DESC LIMIT 10", pid);
    for (const r of no) g.push({ code: 'HERRAMIENTA_NO_OBSERVADA', count: Number(r.n), message: 'Agentix no pudo observar: ' + seguro(r.detail || 'una herramienta del host', 160) + ' (no observado no significa que no se usó)' });
  }
  const hosts = db.all('SELECT host, count(*) AS n FROM mem_events WHERE project_id = ? GROUP BY host ORDER BY count(*) DESC LIMIT 20', pid);
  g.push({ code: 'CAPTURA_POR_HOST', info: true, hosts: hosts.map((h) => ({ host: seguro(h.host, 60), events: Number(h.n) })), message: 'solo hay actividad de los hosts que entregaron eventos; un host sin eventos aquí no prueba que no hubo actividad' });
  return g;
}

// ───────────────────────── cola ─────────────────────────────────────────────
function cola(root) {
  const q = require('./memory-queue.cjs');
  const s = q.estadisticas(root);
  if (!s.available) return { available: false, code: s.code, hint: s.code === 'SCHEMA_MISSING' ? 'faltan las tablas de la cola: akdd update' : null };
  const por = s.by_state;
  const muertos = (s.dead_letter || []).map((d) => ({
    job_id: d.job_id, error_code: seguro(d.error_code, 80), attempts: Number(d.attempts), manual_retries: Number(d.manual_retries), updated_at: d.updated_at,
    retries_left: Math.max(0, q.DEFAULTS.max_manual_retries - Number(d.manual_retries)), can_retry: Number(d.manual_retries) < q.DEFAULTS.max_manual_retries,
  }));
  return {
    available: true,
    pending: por.PENDING, active: por.RUNNING, retry: por.RETRY, failed: por.DEAD_LETTER, done: por.DONE, suppressed: por.SUPPRESSED,
    expired_leases: s.expired_leases, required_pending: s.required_pending, oldest_pending_age_ms: s.oldest_pending_age_ms,
    healthy: s.healthy, dead_letter: muertos, max_manual_retries: q.DEFAULTS.max_manual_retries,
  };
}

/** Reintento de un job muerto: validado, con límite por job (cola) y por minuto (aquí), y con registro. */
const intentosRecientes = [];
function reintentar(root, job_id, opts = {}) {
  if (!/^job_[a-f0-9]{8,64}$/.test(String(job_id || ''))) return { ok: false, code: 'JOB_ID_INVALIDO' };
  const t = opts.now ? new Date(opts.now).getTime() : Date.now();
  while (intentosRecientes.length && t - intentosRecientes[0] > RETRY_VENTANA_MS) intentosRecientes.shift();
  if (intentosRecientes.length >= RETRY_MAX_POR_VENTANA) return { ok: false, code: 'DEMASIADOS_REINTENTOS', message: 'espera un minuto antes de reintentar más jobs' };
  intentosRecientes.push(t);
  const r = require('./memory-queue.cjs').reintentar(root, job_id, opts);
  // Registro: queda quién/cuándo/qué pasó. Es auxiliar: si falla, el resultado del reintento no cambia.
  intentar(() => {
    const db = core.abrir(root, { write: true });
    if (!db) return;
    try {
      if (core.tablasFaltantes(db, ['mem_health']).length) return;
      db.run('INSERT OR REPLACE INTO mem_health (check_name, scope, status, detail, source, checked_at, expires_at) VALUES (?,?,?,?,?,?,NULL)', 'manual_retry', job_id, r.ok ? 'OK' : 'REJECTED', JSON.stringify({ code: r.code || null, manual_retries: r.manual_retries == null ? null : r.manual_retries }), opts.source || 'dashboard', iso(opts));
    } finally { db.close(); }
  }, null);
  return r;
}

// ───────────────────────── actualización ────────────────────────────────────
function actualizacion(root) {
  try {
    const r = require('./update-estado.cjs').leer(root, { limit: 1 }).data;
    return {
      available: true, installed_version: r.installed_version,
      last_verification: r.last_verification ? { status: r.last_verification.status, ok: r.last_verification.ok, finished_at: r.last_verification.finished_at, versions: r.last_verification.versions, warnings: r.last_verification.warnings, not_verified: r.last_verification.not_verified } : null,
      memory_preserved: r.memory_preserved ? { database: r.memory_preserved.database, own_files: r.memory_preserved.own_files } : null,
      schema: { status: r.schema.status, pending: r.schema.pending === undefined ? null : r.schema.pending },
      in_progress: r.memory.update.in_progress, backup_available: r.backup.available,
    };
  } catch (e) { return { available: false, code: 'UPDATE_NO_DISPONIBLE', message: String(e.message || e).slice(0, 120) }; }
}

// ───────────────────────── resumen del panel ────────────────────────────────
function resumen(root, opts = {}) {
  const stamp = marca(root); // antes de leer: si cambia mientras tanto, el cliente solo refresca de más
  const p = abrirPanel(root);
  if (p.error) return { status: 'UNAVAILABLE', reason_code: p.error.code, data: { available: false, ...p.error, stamp, update: actualizacion(root) } };
  let inv; let gaps;
  try {
    inv = inventario(p);
    gaps = huecos(p, inv);
  } finally { p.cerrar(); }
  const faltan = intentar(() => { const d = core.disponibilidad(root); return d.state === 'SCHEMA_MISSING' ? d.missing : []; }, null);
  return {
    status: 'OK',
    data: {
      available: true, identity: identidadPublica(p.ident), schema_ready: faltan !== null && faltan.length === 0, missing_tables: faltan,
      inventory: inv, queue: cola(root), capture_gaps: gaps, update: actualizacion(root), epistemic_labels: EPISTEMICOS, stamp,
    },
  };
}

// ───────────────────────── listados con cursor ──────────────────────────────
const escLike = (s) => '%' + String(s).replace(/[\\%_]/g, '\\$&') + '%';
// OJO: status SUPPRESSED también lo pone la cola cuando un evento no tiene regla de procesamiento; lo PRIVADO lo dice la clase.
const privado = (e) => e.privacy_class === 'private' || e.privacy_class === 'unknown';

function epistemico(provenance, state) {
  if (provenance === 'VERIFIED' && state === 'VALIDATED') return 'verified';
  if (provenance === 'OBSERVED') return 'observed';
  return 'asserted';
}

function eventoPublico(e, detalle) {
  const oculto = privado(e);
  const rutas = oculto ? [] : parseJSON(e.paths, []).slice(0, detalle ? 50 : 5).map((x) => seguro(x, 200));
  const o = {
    event_id: e.event_id, event_type: seguro(e.event_type, 60), host: seguro(e.host, 60), role: seguro(e.role, 40), task_id: seguro(e.task_id, 80), session_id: seguro(e.session_id, 80),
    occurred_at: e.occurred_at, status: e.status, privacy_class: e.privacy_class, attempts: Number(e.attempts), sequence: Number(e.sequence),
    paths: rutas, summary_hidden: oculto, epistemic: 'observed',
    summary: oculto ? null : seguro(e.output_summary || e.input_summary, detalle ? 600 : 200),
  };
  if (detalle) { o.input_summary = oculto ? null : seguro(e.input_summary, 600); o.output_summary = oculto ? null : seguro(e.output_summary, 600); o.received_at = e.received_at; o.cycle_id = seguro(e.cycle_id, 80); o.redaction_version = e.redaction_version; }
  return o;
}

function paginaDe(filas, limit, cursorDe) {
  const hayMas = filas.length > limit;
  const pagina = hayMas ? filas.slice(0, limit) : filas;
  return { pagina, coverage: { shown: pagina.length, truncated: hayMas, next_cursor: hayMas ? cursorDe(pagina[pagina.length - 1]) : null, total: null, cursor_kind: 'rowid' } };
}

/**
 * Lista paginada. kind: events | observations | knowledge.
 * filtros (todos opcionales, valores enlazados): type, host, status, state, provenance, task, q.
 */
function listar(root, { kind, cursor, limit, type, host, status, state, provenance, task, q } = {}) {
  if (!KINDS.includes(kind)) return { status: 'UNAVAILABLE', reason_code: 'KIND_INVALIDO', data: null, allowed: KINDS };
  const lim = limiteDe(limit);
  const p = abrirPanel(root);
  if (p.error) return { status: 'UNAVAILABLE', reason_code: p.error.code, data: null };
  try {
    const { db, hay, pid } = p;
    const tabla = kind === 'events' ? 'mem_events' : (kind === 'observations' ? 'mem_observations' : 'nodos');
    if (!hay.has(tabla)) return { status: 'UNAVAILABLE', reason_code: 'SCHEMA_MISSING', data: null, hint: 'falta la tabla ' + tabla + ': ejecuta akdd update (leer no migra)' };
    const vacio = { status: 'EMPTY', data: [], coverage: { shown: 0, truncated: false, next_cursor: null, total: null, cursor_kind: 'rowid' }, identity: identidadPublica(p.ident) };
    const w = []; const a = [];
    const cur = Number.isInteger(Number(cursor)) && Number(cursor) > 0 ? Number(cursor) : null;

    if (kind === 'events') {
      if (!pid) return vacio;
      w.push('project_id = ?'); a.push(pid);
      if (cur) { w.push('rowid < ?'); a.push(cur); }
      if (type) { w.push('event_type = ?'); a.push(type); }
      if (host) { w.push('host = ?'); a.push(host); }
      if (status) { w.push('status = ?'); a.push(status); }
      if (task) { w.push('task_id = ?'); a.push(task); }
      if (q) { w.push("privacy_class IN ('authorized','redacted') AND (input_summary LIKE ? ESCAPE '\\' OR output_summary LIKE ? ESCAPE '\\' OR event_type LIKE ? ESCAPE '\\')"); a.push(escLike(q), escLike(q), escLike(q)); }
      const filas = db.all('SELECT rowid AS rid, event_id, event_type, host, role, task_id, session_id, occurred_at, received_at, status, privacy_class, paths, input_summary, output_summary, attempts, sequence, cycle_id, redaction_version FROM mem_events ' + DONDE(w) + ' ORDER BY rowid DESC LIMIT ?', ...a, lim + 1);
      const { pagina, coverage } = paginaDe(filas, lim, (f) => f.rid);
      return { status: pagina.length ? 'OK' : 'EMPTY', data: pagina.map((f) => eventoPublico(f, false)), coverage, identity: identidadPublica(p.ident) };
    }

    if (kind === 'observations') {
      if (!pid) return vacio;
      w.push('o.project_id = ?'); a.push(pid);
      if (cur) { w.push('o.rowid < ?'); a.push(cur); }
      if (type) { w.push('o.kind = ?'); a.push(type); }
      if (status) { w.push('o.status = ?'); a.push(status); }
      if (task) { w.push('o.task_id = ?'); a.push(task); }
      if (q) { w.push("o.summary LIKE ? ESCAPE '\\'"); a.push(escLike(q)); }
      const cuenta = hay.has('mem_observation_events') ? '(SELECT count(*) FROM mem_observation_events x WHERE x.observation_id = o.observation_id)' : 'NULL';
      const filas = db.all('SELECT o.rowid AS rid, o.observation_id, o.kind, o.summary, o.status, o.task_id, o.created_at, o.updated_at, o.processor, o.error_code, ' + cuenta + ' AS events FROM mem_observations o ' + DONDE(w) + ' ORDER BY o.rowid DESC LIMIT ?', ...a, lim + 1);
      const { pagina, coverage } = paginaDe(filas, lim, (f) => f.rid);
      return {
        status: pagina.length ? 'OK' : 'EMPTY', coverage, identity: identidadPublica(p.ident),
        data: pagina.map((f) => ({
          observation_id: f.observation_id, kind: seguro(f.kind, 60), summary: seguro(f.summary, 240), status: f.status, task_id: seguro(f.task_id, 80), created_at: f.created_at, updated_at: f.updated_at,
          processor: seguro(f.processor, 40), error_code: seguro(f.error_code, 80), events: f.events === null ? null : Number(f.events),
          epistemic: f.processor === 'summarizer' ? 'asserted' : 'observed',
        })),
      };
    }

    // knowledge: nodos + su procedencia (si la tiene). Lo antiguo sin fila de procedencia sale como LEGACY, calculado al leer.
    const conK = hay.has('mem_knowledge') && !!pid;
    const estadoSql = "COALESCE(k.state, CASE WHEN n.estado = 'OBSOLETO' OR n.vigencia_tipo IN ('SUPERSEDED','OBSOLETO') THEN 'OBSOLETE' WHEN n.vigencia_tipo = 'SOSPECHOSO' THEN 'SUSPECT' ELSE 'VALIDATED_LEGACY' END)";
    const provSql = "COALESCE(k.provenance, 'LEGACY_UNVERIFIED_PROVENANCE')";
    const JOIN_K = conK ? 'LEFT JOIN mem_knowledge k ON k.node_id = CAST(n.id AS TEXT) AND k.project_id = ?' : '';
    const sel = conK ? { st: estadoSql, pr: provSql, k: 'k.occurrences, k.validated_at, k.validated_by, k.stale_since' }
      : { st: "CASE WHEN n.estado = 'OBSOLETO' OR n.vigencia_tipo IN ('SUPERSEDED','OBSOLETO') THEN 'OBSOLETE' WHEN n.vigencia_tipo = 'SOSPECHOSO' THEN 'SUSPECT' ELSE 'VALIDATED_LEGACY' END", pr: "'LEGACY_UNVERIFIED_PROVENANCE'", k: 'NULL AS occurrences, NULL AS validated_at, NULL AS validated_by, NULL AS stale_since' };
    const params = conK ? [pid] : [];
    if (cur) { w.push('n.rowid < ?'); a.push(cur); }
    if (type) { w.push('n.tipo = ?'); a.push(type); }
    if (state) { w.push(sel.st + ' = ?'); a.push(state); }
    if (provenance) { w.push(sel.pr + ' = ?'); a.push(provenance); }
    if (q) { w.push("(n.titulo LIKE ? ESCAPE '\\' OR n.contenido LIKE ? ESCAPE '\\')"); a.push(escLike(q), escLike(q)); }
    const filas = db.all('SELECT n.rowid AS rid, n.id AS node_id, n.tipo, n.titulo, n.area, n.confianza, n.estado, n.vigencia_tipo, ' + sel.st + ' AS state, ' + sel.pr + ' AS provenance, ' + sel.k + ' FROM nodos n ' + JOIN_K + ' ' + DONDE(w) + ' ORDER BY n.rowid DESC LIMIT ?', ...params, ...a, lim + 1);
    const { pagina, coverage } = paginaDe(filas, lim, (f) => f.rid);
    return {
      status: pagina.length ? 'OK' : 'EMPTY', coverage, identity: identidadPublica(p.ident),
      data: pagina.map((f) => ({
        node_id: String(f.node_id), tipo: seguro(f.tipo, 40), titulo: seguro(f.titulo, 160), area: seguro(f.area, 60), confianza: seguro(f.confianza, 20), state: f.state, provenance: f.provenance,
        occurrences: f.occurrences === null || f.occurrences === undefined ? null : Number(f.occurrences), validated_at: f.validated_at || null, validated_by: seguro(f.validated_by, 40), stale_since: f.stale_since || null,
        epistemic: epistemico(f.provenance, f.state),
      })),
    };
  } finally { p.cerrar(); }
}

// ───────────────────────── detalle ──────────────────────────────────────────
function evidenciaPublica(db, hay, pid, ids) {
  if (!hay.has('mem_evidence')) return ids.map((id) => ({ evidence_id: id, status: null, note: 'tabla de evidencias no disponible' }));
  return ids.slice(0, 50).map((id) => {
    const r = pid ? db.get('SELECT evidence_id, kind, store, sha256, bytes, status, retention, privacy_class, created_at, last_verified_at, expires_at FROM mem_evidence WHERE evidence_id = ? AND project_id = ?', id, pid) : null;
    return r ? { evidence_id: r.evidence_id, kind: seguro(r.kind, 40), store: seguro(r.store, 40), sha256: String(r.sha256).slice(0, 16), bytes: Number(r.bytes), status: r.status, retention: r.retention, privacy_class: r.privacy_class, created_at: r.created_at, last_verified_at: r.last_verified_at, expires_at: r.expires_at }
      : { evidence_id: seguro(id, 80), status: 'NO_ENCONTRADA', note: 'la evidencia no existe en este proyecto' };
  });
}

function detalle(root, { kind, id } = {}) {
  if (!KINDS.includes(kind)) return { status: 'UNAVAILABLE', reason_code: 'KIND_INVALIDO', data: null, allowed: KINDS };
  if (!id) return { status: 'UNAVAILABLE', reason_code: 'ID_REQUERIDO', data: null };
  const p = abrirPanel(root);
  if (p.error) return { status: 'UNAVAILABLE', reason_code: p.error.code, data: null };
  try {
    const { db, hay, pid } = p;
    const falta = (t) => !hay.has(t);
    if (kind === 'events') {
      if (falta('mem_events')) return { status: 'UNAVAILABLE', reason_code: 'SCHEMA_MISSING', data: null };
      const e = pid ? db.get('SELECT * FROM mem_events WHERE event_id = ? AND project_id = ?', String(id), pid) : null;
      if (!e) return { status: 'EMPTY', reason_code: 'NO_ENCONTRADO', data: null };
      const obs = hay.has('mem_observation_events') && hay.has('mem_observations') ? db.all('SELECT o.observation_id, o.kind, o.status, o.summary FROM mem_observation_events x JOIN mem_observations o ON o.observation_id = x.observation_id WHERE x.event_id = ? AND o.project_id = ? LIMIT 50', e.event_id, pid) : null;
      const kn = hay.has('mem_provenance') ? db.all("SELECT DISTINCT node_id, relation FROM mem_provenance WHERE event_id = ? AND project_id = ? LIMIT 50", e.event_id, pid) : null;
      const job = hay.has('mem_job_events') && hay.has('mem_jobs') ? db.get('SELECT j.job_id, j.state, j.attempts, j.error_code FROM mem_job_events je JOIN mem_jobs j ON j.job_id = je.job_id WHERE je.event_id = ? LIMIT 1', e.event_id) : null;
      const refs = parseJSON(e.evidence_refs, []).filter((x) => /^ev_[a-f0-9]{16,64}$/.test(String(x)));
      const oculto = privado(e);
      return {
        status: 'OK',
        data: {
          kind, item: eventoPublico(e, true),
          explanation: oculto
            ? 'Esta actividad se guardó solo como metadatos porque su ruta o su contenido son privados. No hay contenido que mostrar, a propósito.'
            : 'Actividad registrada por el host "' + seguro(e.host, 60) + '" (' + seguro(e.event_type, 60) + ') el ' + e.occurred_at + '. Es lo que el host reportó: no está validado.',
          origin: { host: seguro(e.host, 60), session_id: seguro(e.session_id, 80), task_id: seguro(e.task_id, 80), cycle_id: seguro(e.cycle_id, 80) },
          files: oculto ? [] : parseJSON(e.paths, []).slice(0, 50).map((x) => seguro(x, 200)),
          evidence: evidenciaPublica(db, hay, pid, refs),
          processing: job ? { job_id: job.job_id, state: job.state, attempts: Number(job.attempts), error_code: seguro(job.error_code, 80) } : null,
          observations: obs ? obs.map((o) => ({ observation_id: o.observation_id, kind: seguro(o.kind, 60), status: o.status, summary: seguro(o.summary, 200) })) : null,
          knowledge: kn ? kn.map((k) => ({ node_id: String(k.node_id), relation: k.relation })) : null,
          validation: { epistemic: 'observed', label: EPISTEMICOS.observed },
        },
      };
    }
    if (kind === 'observations') {
      if (falta('mem_observations')) return { status: 'UNAVAILABLE', reason_code: 'SCHEMA_MISSING', data: null };
      const o = pid ? db.get('SELECT * FROM mem_observations WHERE observation_id = ? AND project_id = ?', String(id), pid) : null;
      if (!o) return { status: 'EMPTY', reason_code: 'NO_ENCONTRADO', data: null };
      const evs = hay.has('mem_observation_events') && hay.has('mem_events') ? db.all('SELECT e.event_id, e.event_type, e.host, e.occurred_at, e.status, e.privacy_class FROM mem_observation_events x JOIN mem_events e ON e.event_id = x.event_id WHERE x.observation_id = ? AND e.project_id = ? ORDER BY e.occurred_at LIMIT 100', o.observation_id, pid) : null;
      const kn = hay.has('mem_provenance') ? db.all('SELECT DISTINCT node_id, relation FROM mem_provenance WHERE observation_id = ? AND project_id = ? LIMIT 50', o.observation_id, pid) : null;
      const ep = o.processor === 'summarizer' ? 'asserted' : 'observed';
      return {
        status: 'OK',
        data: {
          kind,
          item: { observation_id: o.observation_id, kind: seguro(o.kind, 60), summary: seguro(o.summary, 1200), status: o.status, task_id: seguro(o.task_id, 80), created_at: o.created_at, updated_at: o.updated_at, processor: seguro(o.processor, 40), error_code: seguro(o.error_code, 80), epistemic: ep },
          explanation: ep === 'asserted' ? 'Resumen escrito por un modelo a partir de las actividades de abajo. No está verificado: es lo que el modelo dedujo.' : 'Interpretación determinista (reglas, sin modelo) de las actividades de abajo. Es lo observado, no está validado.',
          origin: { events: evs ? evs.length : null },
          events: evs ? evs.map((e) => ({ event_id: e.event_id, event_type: seguro(e.event_type, 60), host: seguro(e.host, 60), occurred_at: e.occurred_at, status: e.status, privacy_class: e.privacy_class })) : null,
          knowledge: kn ? kn.map((k) => ({ node_id: String(k.node_id), relation: k.relation })) : null,
          validation: { epistemic: ep, label: EPISTEMICOS[ep] },
        },
      };
    }
    // knowledge
    const n = db.get('SELECT id, tipo, titulo, contenido, area, confianza, estado, vigencia_tipo, archivos_aplica FROM nodos WHERE CAST(id AS TEXT) = ?', String(id));
    if (!n) return { status: 'EMPTY', reason_code: 'NO_ENCONTRADO', data: null };
    const k = hay.has('mem_knowledge') && pid ? db.get('SELECT * FROM mem_knowledge WHERE node_id = ? AND project_id = ?', String(id), pid) : null;
    const rel = hay.has('mem_provenance') && pid ? db.all('SELECT relation, observation_id, event_id, evidence_id, related_node_id, note, created_at FROM mem_provenance WHERE node_id = ? AND project_id = ? ORDER BY provenance_id LIMIT 200', String(id), pid) : [];
    const evIds = [...new Set(rel.map((r) => r.evidence_id).filter(Boolean))];
    const obsIds = [...new Set(rel.map((r) => r.observation_id).filter(Boolean))];
    const evtIds = [...new Set(rel.map((r) => r.event_id).filter(Boolean))];
    for (const o of obsIds.slice(0, 50)) if (hay.has('mem_observation_events')) for (const r of db.all('SELECT event_id FROM mem_observation_events WHERE observation_id = ? LIMIT 100', o)) if (!evtIds.includes(r.event_id)) evtIds.push(r.event_id);
    const state = k ? k.state : (n.estado === 'OBSOLETO' || n.vigencia_tipo === 'SUPERSEDED' || n.vigencia_tipo === 'OBSOLETO' ? 'OBSOLETE' : (n.vigencia_tipo === 'SOSPECHOSO' ? 'SUSPECT' : 'VALIDATED_LEGACY'));
    const provenance = k ? k.provenance : 'LEGACY_UNVERIFIED_PROVENANCE';
    const ep = epistemico(provenance, state);
    const evid = evidenciaPublica(db, hay, pid, evIds);
    let explicacion;
    if (!k) explicacion = 'Registro anterior a la memoria con procedencia: no se sabe de qué actividad salió ni qué lo respalda. Se muestra tal cual estaba; no se reescribió ni se rebajó.';
    else if (ep === 'verified') explicacion = 'Validado el ' + k.validated_at + ' por "' + seguro(k.validated_by, 40) + '" con ' + evid.length + ' evidencia(s) vigente(s).';
    else if (state === 'SUSPECT') explicacion = 'Estaba validado, pero cambió código relacionado desde el ' + k.stale_since + ': hay que volver a verificarlo.';
    else if (state === 'OBSOLETE') explicacion = 'Reemplazado o retirado: se conserva como historia, no se usa como verdad vigente.';
    else explicacion = 'Propuesto a partir de ' + (obsIds.length + evtIds.length) + ' actividad(es)/observación(es) y visto ' + (k.occurrences || 1) + ' vez/veces. Una observación o una repetición NO lo validan: falta evidencia actual.';
    return {
      status: 'OK',
      data: {
        kind,
        item: { node_id: String(n.id), tipo: seguro(n.tipo, 40), titulo: seguro(n.titulo, 200), contenido: seguro(n.contenido, 1500), area: seguro(n.area, 60), confianza: seguro(n.confianza, 20), state, provenance, vigencia: seguro(n.vigencia_tipo, 30), epistemic: ep },
        explanation: explicacion,
        origin: { events: evtIds.length, observations: obsIds.length, legacy: !k },
        files: parseJSON(n.archivos_aplica, []).slice(0, 50).map((x) => seguro(x, 200)),
        relations: rel.slice(0, 100).map((r) => ({ relation: r.relation, observation_id: r.observation_id || null, event_id: r.event_id || null, evidence_id: r.evidence_id || null, related_node_id: r.related_node_id || null, note: seguro(r.note, 200), created_at: r.created_at })),
        events: evtIds.slice(0, 50), observations: obsIds.slice(0, 50),
        evidence: evid,
        validation: { epistemic: ep, label: EPISTEMICOS[ep], state, validated_at: k ? k.validated_at : null, validated_by: k ? seguro(k.validated_by, 40) : null, occurrences: k ? Number(k.occurrences) : null, evidence_current: evid.length ? evid.every((e) => e.status === 'AVAILABLE') : null },
      },
    };
  } finally { p.cerrar(); }
}

/** Exportación: la MISMA ruta que el listado (mismo saneado), en lotes; nunca el contenido original. */
function exportar(root, { kind, max = EXPORT_MAX, ...filtros } = {}) {
  const tope = Math.min(Number(max) || EXPORT_MAX, EXPORT_MAX);
  const items = []; let cursor;
  for (;;) {
    const r = listar(root, { kind, cursor, limit: Math.min(LIMITE_MAX, tope - items.length), ...filtros });
    if (!r.data || !r.data.length) return { status: r.status, reason_code: r.reason_code || null, items };
    items.push(...r.data);
    if (items.length >= tope || !r.coverage || r.coverage.next_cursor === null) return { status: 'OK', items, truncated: r.coverage ? r.coverage.next_cursor !== null : false };
    cursor = r.coverage.next_cursor;
  }
}

module.exports = { KINDS, EPISTEMICOS, LIMITE_MAX, EXPORT_MAX, seguro, marca, resumen, listar, detalle, cola, reintentar, exportar, huecos, inventario, abrirPanel };
