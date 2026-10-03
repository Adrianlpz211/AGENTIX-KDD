'use strict';
/**
 * Cola durable de procesamiento de memoria (C02 "Cola" y "Qué procesar").
 *
 * Captura inserta evento + job en UNA transacción (memory-core.capturar). Este
 * módulo es el otro lado: reclama jobs con LEASE y FENCING TOKEN, procesa fuera
 * del camino de Shell/Edit, y confirma solo si sigue siendo el dueño vigente.
 *
 *   Estados: PENDING · RUNNING · DONE · RETRY · DEAD_LETTER · SUPPRESSED
 *
 *   · Claim atómico: una sola sentencia UPDATE condicionada al estado; si dos
 *     workers eligen el mismo job, solo UNO gana (el otro ve 0 filas cambiadas).
 *   · Fencing: cada claim incrementa lease_token. complete/fail exigen el token y
 *     el dueño; un worker viejo cuyo lease venció y fue reclamado recibe LEASE_LOST
 *     y su resultado se descarta.
 *   · Un lease vencido NO es permiso para duplicar efectos externos: el
 *     procesador determinista es idempotente (los ids de observación se derivan
 *     del job y de sus eventos), así que reprocesar tras una caída no duplica.
 *   · Reintentos acotados con backoff exponencial; al agotarlos → DEAD_LETTER,
 *     visible y reintentable a mano (máx. 3 veces). Sin bucles infinitos.
 *   · Sin daemon obligatorio: `drain` procesa un lote corto y termina. Puede
 *     llamarlo post-cycle, un `akdd memory drain`, o un worker opcional.
 *   · Reglas deterministas primero (pruebas fallidas, archivos tocados, decisión
 *     explícita, gate, contrato). Las lecturas repetidas se AGRUPAN en una sola
 *     observación; no se genera un aprendizaje por cada Read.
 *   · Resumen con modelo: SOLO opt-in (opts.summarizer). Sin proveedor configurado
 *     no se llama a ningún LLM. Si el resumidor falla, queda la observación
 *     determinista y el job se reintenta; nada se pierde ni bloquea la edición.
 */

const core = require('./memory-core.cjs');
const privacy = require('./memory-privacy.cjs');

const DEFAULTS = Object.freeze({ lease_ms: 60000, backoff_base_ms: 5000, backoff_max_ms: 15 * 60 * 1000, max_manual_retries: 3 });
const ESTADOS = ['PENDING', 'RUNNING', 'DONE', 'RETRY', 'DEAD_LETTER', 'SUPPRESSED'];
const iso = (ms) => new Date(ms).toISOString();
const ahoraMs = (o) => (o && o.now ? new Date(o.now).getTime() : Date.now());

function backoff(intento, o) {
  const base = (o && o.backoff_base_ms) || DEFAULTS.backoff_base_ms;
  const max = (o && o.backoff_max_ms) || DEFAULTS.backoff_max_ms;
  return Math.min(max, base * 2 ** Math.max(0, intento - 1));
}

function conBase(root, write, fn) {
  let db;
  // Abrir también puede lanzar (UPDATE_IN_PROGRESS: un update tiene la exclusión de escritores): estado explícito, no excepción.
  try { db = core.abrir(root, { write }); } catch (e) { return { ok: false, code: e.code || 'DB_OPEN_FAILED', message: e.message }; }
  if (!db) return { ok: false, code: 'NO_DB' };
  try {
    const faltan = core.tablasFaltantes(db, ['mem_jobs', 'mem_job_events', 'mem_events']);
    if (faltan.length) return { ok: false, code: 'SCHEMA_MISSING', missing: faltan, hint: 'Ejecuta: akdd update' };
    return fn(db);
  } catch (e) {
    return { ok: false, code: e.code || 'QUEUE_ERROR', message: e.message };
  } finally { try { db.close(); } catch { /* ya cerrada */ } }
}

/**
 * Jobs con procesador PROPIO (kind distinto de observe/decision). El drenaje genérico no los reclama:
 * no tiene su regla y los daría por hechos sin haber ejecutado nada. Solo se reclaman pidiéndolos en `kinds`.
 */
const DEDICADOS = Object.freeze(['teams_cierre']);

/** Reclama el siguiente job disponible. Devuelve { ok:true, job } | { ok:true, job:null } | { ok:false }. */
function reclamar(root, { owner, lease_ms = DEFAULTS.lease_ms, now, kinds } = {}) {
  if (!owner) return { ok: false, code: 'OWNER_REQUERIDO' };
  return conBase(root, true, (db) => {
    const t = ahoraMs({ now }); const ahora = iso(t); const hasta = iso(t + lease_ms);
    const pedidos = Array.isArray(kinds) && kinds.length ? kinds.filter((k) => /^[a-z_]{1,40}$/.test(String(k))) : null;
    const filtroKind = pedidos ? 'kind IN (' + pedidos.map((k) => "'" + k + "'").join(',') + ')' : 'kind NOT IN (' + DEDICADOS.map((k) => "'" + k + "'").join(',') + ')';
    for (let intento = 0; intento < 8; intento++) {
      const cand = db.get(
        `SELECT job_id, state, attempts, max_attempts FROM mem_jobs
         WHERE ((state IN ('PENDING','RETRY') AND next_attempt_at <= ?) OR (state = 'RUNNING' AND lease_until < ?)) AND ${filtroKind}
         ORDER BY required DESC, next_attempt_at ASC, job_id ASC LIMIT 1`, ahora, ahora);
      if (!cand) return { ok: true, job: null };
      // Un lease vencido cuenta como intento: si ya agotó los suyos, va a dead-letter, no vuelve a correr.
      if (cand.state === 'RUNNING' && Number(cand.attempts) >= Number(cand.max_attempts)) {
        db.run("UPDATE mem_jobs SET state = 'DEAD_LETTER', error_code = 'LEASE_EXPIRED_MAX_ATTEMPTS', updated_at = ? WHERE job_id = ? AND state = 'RUNNING' AND lease_until < ?", ahora, cand.job_id, ahora);
        continue;
      }
      const r = db.run(
        `UPDATE mem_jobs SET state = 'RUNNING', lease_owner = ?, lease_token = lease_token + 1, lease_until = ?, attempts = attempts + 1, updated_at = ?
         WHERE job_id = ? AND ((state IN ('PENDING','RETRY') AND next_attempt_at <= ?) OR (state = 'RUNNING' AND lease_until < ?))`,
        owner, hasta, ahora, cand.job_id, ahora, ahora);
      if (r.changes === 1) {
        const job = db.get('SELECT * FROM mem_jobs WHERE job_id = ?', cand.job_id);
        const eventos = db.all('SELECT e.* FROM mem_job_events je JOIN mem_events e ON e.event_id = je.event_id WHERE je.job_id = ? ORDER BY e.occurred_at, e.sequence', cand.job_id);
        return { ok: true, job: { ...job, lease_token: Number(job.lease_token) }, events: eventos };
      }
      // Otro worker ganó este job: se prueba con el siguiente.
    }
    return { ok: true, job: null, contended: true };
  });
}

const dueñoVigente = "job_id = ? AND lease_token = ? AND lease_owner = ? AND state = 'RUNNING'";

/** Confirma. Solo el dueño vigente (token + owner) con el lease sin vencer. */
function completar(root, job_id, lease_token, owner, { result_ref = null, now } = {}) {
  return conBase(root, true, (db) => {
    const t = iso(ahoraMs({ now }));
    const r = db.run(`UPDATE mem_jobs SET state = 'DONE', result_ref = ?, error_code = NULL, updated_at = ? WHERE ${dueñoVigente} AND lease_until >= ?`, result_ref, t, job_id, lease_token, owner, t);
    return r.changes === 1 ? { ok: true, status: 'DONE', job_id } : { ok: false, code: 'LEASE_LOST', message: 'El lease venció o lo tiene otro worker: este resultado se descarta.' };
  });
}

/** Falla un intento: RETRY con backoff, o DEAD_LETTER si ya no quedan intentos. */
function fallar(root, job_id, lease_token, owner, { error_code = 'PROCESS_FAILED', now, backoff_opts } = {}) {
  return conBase(root, true, (db) => {
    const t = ahoraMs({ now });
    const j = db.get('SELECT attempts, max_attempts FROM mem_jobs WHERE job_id = ?', job_id);
    if (!j) return { ok: false, code: 'JOB_NO_EXISTE' };
    const agotado = Number(j.attempts) >= Number(j.max_attempts);
    const sig = iso(t + backoff(Number(j.attempts), backoff_opts));
    const r = db.run(`UPDATE mem_jobs SET state = ?, error_code = ?, next_attempt_at = ?, updated_at = ? WHERE ${dueñoVigente}`,
      agotado ? 'DEAD_LETTER' : 'RETRY', String(error_code).slice(0, 80), sig, iso(t), job_id, lease_token, owner);
    return r.changes === 1 ? { ok: true, status: agotado ? 'DEAD_LETTER' : 'RETRY', job_id, next_attempt_at: agotado ? null : sig } : { ok: false, code: 'LEASE_LOST' };
  });
}

function renovar(root, job_id, lease_token, owner, { lease_ms = DEFAULTS.lease_ms, now } = {}) {
  return conBase(root, true, (db) => {
    const t = ahoraMs({ now });
    const r = db.run(`UPDATE mem_jobs SET lease_until = ?, updated_at = ? WHERE ${dueñoVigente} AND lease_until >= ?`, iso(t + lease_ms), iso(t), job_id, lease_token, owner, iso(t));
    return r.changes === 1 ? { ok: true } : { ok: false, code: 'LEASE_LOST' };
  });
}

/** Reintento manual y acotado de un job muerto. Nunca borra memoria para vaciar la cola. */
function reintentar(root, job_id, opts = {}) {
  return conBase(root, true, (db) => {
    const j = db.get('SELECT state, manual_retries FROM mem_jobs WHERE job_id = ?', job_id);
    if (!j) return { ok: false, code: 'JOB_NO_EXISTE' };
    if (j.state !== 'DEAD_LETTER') return { ok: false, code: 'NO_ES_DEAD_LETTER', state: j.state };
    if (Number(j.manual_retries) >= DEFAULTS.max_manual_retries) return { ok: false, code: 'REINTENTOS_AGOTADOS', message: 'Ya se reintentó a mano ' + j.manual_retries + ' veces: revisa la causa (error_code) en lugar de repetir.' };
    const t = iso(ahoraMs(opts));
    db.run("UPDATE mem_jobs SET state = 'PENDING', attempts = 0, manual_retries = manual_retries + 1, next_attempt_at = ?, updated_at = ?, error_code = NULL WHERE job_id = ? AND state = 'DEAD_LETTER'", t, t, job_id);
    return { ok: true, status: 'PENDING', job_id, manual_retries: Number(j.manual_retries) + 1 };
  });
}

function estadisticas(root, opts = {}) {
  const db = core.abrir(root);
  if (!db) return { available: false, code: 'NO_DB' };
  try {
    if (core.tablasFaltantes(db, ['mem_jobs']).length) return { available: false, code: 'SCHEMA_MISSING' };
    const por = Object.fromEntries(ESTADOS.map((e) => [e, 0]));
    for (const r of db.all('SELECT state, count(*) AS n FROM mem_jobs GROUP BY 1')) por[r.state] = Number(r.n);
    const t = ahoraMs(opts);
    const viejo = db.get("SELECT MIN(created_at) AS c FROM mem_jobs WHERE state IN ('PENDING','RETRY','RUNNING')").c;
    const vencidos = Number(db.get("SELECT count(*) AS n FROM mem_jobs WHERE state = 'RUNNING' AND lease_until < ?", iso(t)).n);
    const obligatorios = Number(db.get("SELECT count(*) AS n FROM mem_jobs WHERE required = 1 AND state NOT IN ('DONE','SUPPRESSED')").n);
    const dead = db.all("SELECT job_id, error_code, attempts, manual_retries, updated_at FROM mem_jobs WHERE state = 'DEAD_LETTER' ORDER BY updated_at DESC LIMIT 20");
    return {
      available: true, by_state: por, expired_leases: vencidos, required_pending: obligatorios,
      oldest_pending_age_ms: viejo ? Math.max(0, t - Date.parse(viejo)) : 0, dead_letter: dead,
      healthy: por.DEAD_LETTER === 0 && vencidos === 0,
    };
  } finally { db.close(); }
}

// ───────────────────────────── procesador determinista ──────────────────────
const TIPOS_EDICION = new Set(['file_edit', 'file_write', 'edit', 'write']);
const TIPOS_LECTURA = new Set(['file_read', 'read', 'search', 'grep']);
const parseJSON = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

/**
 * Todos los eventos del MISMO grupo (tarea, o sesión si no hay tarea) de ciertos tipos. Agrupar es leer el
 * grupo entero: cada job procesa un evento, pero la observación agrupada se recalcula con todos y se
 * actualiza en su sitio (misma clave), en lugar de crear una observación por cada Read o Edit.
 */
function eventosDelGrupo(root, ev, tipos) {
  const db = core.abrir(root);
  if (!db) return [ev];
  try {
    const FILTRO = ev.task_id ? 'task_id = ?' : 'task_id IS NULL AND session_id = ?';
    const consulta = ['SELECT * FROM mem_events WHERE project_id = ? AND', FILTRO, 'AND event_type IN (' + tipos.map(() => '?').join(',') + ') ORDER BY occurred_at, sequence LIMIT 5000'].join(' ');
    const rows = db.all(consulta, ev.project_id, ev.task_id || ev.session_id, ...tipos);
    return rows.length ? rows : [ev];
  } finally { db.close(); }
}
const claveGrupo = (ev) => (ev.task_id ? 'task:' + ev.task_id : 'sess:' + ev.session_id);

/** Reglas deterministas. Devuelve { observations:[ids], knowledge:[ids], handled:n } y escribe de forma idempotente. */
function procesarDeterminista(root, eventos, opts = {}) {
  const obs = []; const knowledge = []; let marcados = 0;
  const por = {};
  for (const ev of eventos) (por[ev.event_type] = por[ev.event_type] || []).push(ev);
  const ids = (l) => l.map((e) => e.event_id);
  const registrar = (kind, evs, summary, extra = {}) => {
    const r = core.observar(root, { event_ids: ids(evs), kind, summary, task_id: evs[0].task_id || null, ...extra }, opts);
    if (!r.ok) { const e = new Error(r.code || 'OBSERVE_FAILED'); e.code = r.code; throw e; }
    obs.push(r.observation_id); return r;
  };

  for (const [tipo, evs] of Object.entries(por)) {
    if (tipo === 'test_run' || tipo === 'test_result') {
      const falla = evs.filter((e) => /fail|error|✖|rojo/i.test((e.status || '') + ' ' + (e.output_summary || '')));
      if (falla.length) registrar('test_failure', falla, falla.length + ' ejecución(es) de pruebas con fallos. ' + (falla[0].output_summary || ''));
      const ok = evs.filter((e) => !falla.includes(e));
      if (ok.length) registrar('test_pass', ok, ok.length + ' ejecución(es) de pruebas sin fallos. ' + (ok[0].output_summary || ''));
    } else if (tipo === 'gate_result') {
      registrar('gate_result', evs, 'Resultado de gate: ' + (evs[0].output_summary || evs[0].input_summary || '(sin resumen)'));
    } else if (tipo === 'contract_change') {
      registrar('contract_change', evs, 'Cambio de contrato: ' + (evs[0].output_summary || evs[0].input_summary || ''));
    } else if (tipo === 'tool_error' || tipo === 'error') {
      registrar('tool_error', evs, 'Error de herramienta: ' + (evs[0].output_summary || ''));
    } else if (tipo === 'decision') {
      const r = registrar('decision_explicit', evs, 'Decisión explícita: ' + (evs[0].input_summary || evs[0].output_summary || ''));
      const texto = (evs[0].input_summary || evs[0].output_summary || '').trim();
      if (texto && texto !== privacy.FALLO && evs[0].privacy_class !== 'private') {
        const area = (parseJSON(evs[0].paths, [])[0] || 'global').split('/')[0] || 'global';
        const k = core.proponerConocimiento(root, { tipo: 'decision', area, titulo: texto.slice(0, 100), contenido: texto, archivos: parseJSON(evs[0].paths, []), observation_ids: [r.observation_id], event_ids: ids(evs) }, opts);
        if (k.ok) knowledge.push(k.node_id);
      }
    } else if (TIPOS_EDICION.has(tipo)) {
      const grupo = eventosDelGrupo(root, evs[0], [...TIPOS_EDICION]);
      const tarea = evs[0].task_id || '(sin tarea)';
      const archivos = [...new Set(grupo.flatMap((e) => parseJSON(e.paths, [])))];
      registrar('files_touched', grupo, archivos.length + ' archivo(s) tocado(s) en ' + tarea + ': ' + archivos.slice(0, 12).join(', ') + (archivos.length > 12 ? ' …' : ''), { dedupe_key: 'files_touched|' + claveGrupo(evs[0]) });
    } else if (TIPOS_LECTURA.has(tipo)) {
      // Lecturas repetidas: UNA observación agrupada por tarea. No es un aprendizaje por cada Read.
      const grupo = eventosDelGrupo(root, evs[0], [...TIPOS_LECTURA]);
      const cuenta = {};
      for (const e of grupo) for (const p of parseJSON(e.paths, [])) cuenta[p] = (cuenta[p] || 0) + 1;
      const top = Object.entries(cuenta).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([p, n]) => p + '×' + n);
      registrar('reads_grouped', grupo, grupo.length + ' lectura(s) de ' + Object.keys(cuenta).length + ' archivo(s). Más repetidos: ' + (top.join(', ') || '—'), { dedupe_key: 'reads|' + claveGrupo(evs[0]) });
    } else {
      continue; // sin regla: la actividad queda registrada y se marca SUPPRESSED (abajo)
    }
    marcados += evs.length;
  }
  return { observations: [...new Set(obs)], knowledge, handled: marcados, unhandled: eventos.length - marcados };
}

function marcarEventos(root, eventos, estado) {
  if (!eventos.length) return;
  const db = core.abrir(root, { write: true });
  if (!db) return;
  try {
    db.transaction(() => { for (const e of eventos) db.run("UPDATE mem_events SET status = ? WHERE event_id = ? AND status NOT IN ('SUPPRESSED')", estado, e.event_id); })();
  } finally { db.close(); }
}

/**
 * Procesa un lote. Nunca bloquea herramientas del host: un fallo es del job, no del agente.
 * opts: { owner, max, lease_ms, now, summarizer(eventos) → string | null }
 */
async function drenar(root, opts = {}) {
  const owner = opts.owner || 'drain:' + process.pid;
  const max = Math.min(Number(opts.max) || 25, 500);
  const salida = { ok: true, processed: 0, done: 0, retried: 0, dead_letter: 0, lease_lost: 0, observations: 0, knowledge: 0, errors: [] };
  for (let i = 0; i < max; i++) {
    const c = reclamar(root, { owner, lease_ms: opts.lease_ms, now: opts.now });
    if (!c.ok) { salida.ok = false; salida.code = c.code; salida.missing = c.missing; salida.hint = c.hint; break; }
    if (!c.job) break;
    const { job, events } = c;
    salida.processed++;
    try {
      const r = procesarDeterminista(root, events, opts);
      if (typeof opts.summarizer === 'function') {
        const s = await opts.summarizer(events);
        if (s) core.observar(root, { event_ids: events.map((e) => e.event_id), kind: 'summary_model', summary: s, processor: 'summarizer', task_id: events[0] && events[0].task_id }, opts);
      }
      const done = completar(root, job.job_id, job.lease_token, owner, { result_ref: r.observations.join(',').slice(0, 500) || null, now: opts.now });
      if (done.ok) {
        salida.done++; salida.observations += r.observations.length; salida.knowledge += r.knowledge.length;
        marcarEventos(root, events, r.unhandled === events.length ? 'SUPPRESSED' : 'PROCESSED');
      } else { salida.lease_lost++; }
    } catch (e) {
      const f = fallar(root, job.job_id, job.lease_token, owner, { error_code: e.code || 'PROCESS_FAILED', now: opts.now });
      if (f.ok && f.status === 'DEAD_LETTER') salida.dead_letter++; else if (f.ok) salida.retried++; else salida.lease_lost++;
      salida.errors.push({ job_id: job.job_id, code: e.code || 'PROCESS_FAILED', message: e.message });
    }
  }
  return salida;
}

module.exports = { DEFAULTS, ESTADOS, DEDICADOS, reclamar, completar, fallar, renovar, reintentar, estadisticas, procesarDeterminista, drenar, backoff };
