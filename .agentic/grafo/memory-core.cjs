'use strict';
/**
 * Memoria con procedencia (C01): actividad → observación → conocimiento → evidencia.
 *
 *   Actividad    evento bruto de una acción real (herramienta, fase, gate)      mem_events
 *   Observación  interpretación acotada de uno o varios eventos                 mem_observations
 *   Conocimiento entrada KDD (tabla `nodos`) con procedencia y estado           mem_knowledge + nodos
 *   Evidencia    artefacto verificable: id, hash, tamaño, alcance, fecha        mem_evidence
 *
 * Reglas que este módulo hace cumplir (no son comentarios: tienen prueba):
 *   · Una observación NUNCA valida un nodo. `validarConocimiento` exige evidencia
 *     ACTUAL (se re-verifica el hash en el momento) y un validador que no sea el modelo.
 *   · Idempotencia: clave única project_id+host+session_id+host_event_id. Reenviar
 *     el mismo evento conserva UNA actividad y UN job (cuenta los intentos). Dos
 *     ejecuciones iguales en momentos distintos traen distinto host_event_id y son
 *     dos actividades. No se deduplica por contenido.
 *   · Evento + job se insertan en UNA transacción: no hay evento sin su trabajo.
 *   · Captura NO bloquea: ante cualquier fallo devuelve { ok:false, status:'DEGRADED' }
 *     y nunca dice "capturado" si la transacción falló. Nunca lanza.
 *   · Lectura NO crea ni migra la base: sin tablas nuevas devuelve SCHEMA_MISSING y
 *     manda a `akdd update`. Las tablas entran por el actualizador seguro.
 *   · project_id es estable (UUID guardado en la propia memoria), no el nombre de la
 *     carpeta. Una copia o un renombre se detectan (ROOT_MISMATCH) y se resuelven de
 *     forma EXPLÍCITA (adoptarRaiz / bifurcarIdentidad); jamás se mezclan por nombre.
 *   · Lo antiguo sin procedencia queda LEGACY_UNVERIFIED_PROVENANCE: se calcula al
 *     leer, no se reescribe ni se rebaja en masa ni se inventan pruebas.
 *
 * El módulo abre la base con db-adapter (la capa unificada de acceso SQLite).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const privacy = require('./memory-privacy.cjs');

const EVENT_SCHEMA_VERSION = 1;
const LIMITES = Object.freeze({
  summary_chars: 600,
  max_paths: 100,
  max_payload_chars: 262144,   // por entrada/salida: más allá solo viaja el resumen
  max_pending_jobs: 10000,     // backpressure explícito
});
const ESTADOS_OBSERVACION = ['CAPTURED', 'PENDING_PROCESSING', 'PROCESSED', 'FAILED', 'SUPPRESSED'];
const ESTADOS_CONOCIMIENTO = ['PROPOSED', 'VALIDATED', 'SUSPECT', 'OBSOLETE'];
const VALIDADORES_PERMITIDOS = ['gate', 'test', 'user', 'verifier'];
const TABLAS_CAPTURA = ['mem_project', 'mem_events', 'mem_jobs', 'mem_job_events'];

const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
const iso = (opts) => new Date(opts && opts.now ? opts.now : Date.now()).toISOString();
const tiene = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);

function canonicalRoot(root) {
  let r = path.resolve(root || process.cwd());
  try { r = fs.realpathSync.native ? fs.realpathSync.native(r) : fs.realpathSync(r); } catch { /* aún no existe: se usa la ruta absoluta */ }
  r = r.split(path.sep).join('/').replace(/\/+$/, '');
  return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r;
}

const rutaDb = (root) => path.join(root, '.agentic', 'memoria.db');

/** Abre SIN crear. null si no hay base. El llamador cierra. */
function abrir(root, { write = false } = {}) {
  const p = rutaDb(root);
  if (!fs.existsSync(p)) return null;
  const dba = require('./db-adapter.cjs');
  if (!write) return dba.openReadOnly(p);
  const db = dba.openWrite(p);
  // Toda transacción de memoria lee y luego escribe: con BEGIN diferido, dos procesos concurrentes se
  // rechazan al instante (database is locked) sin esperar el busy_timeout. IMMEDIATE sí espera.
  const original = db.transaction.bind(db);
  db.transaction = (fn, opciones) => original(fn, { immediate: true, ...(opciones || {}) });
  return db;
}

function tablasFaltantes(db, requeridas) {
  const hay = new Set(db.all("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name));
  return (requeridas || TABLAS_CAPTURA).filter((t) => !hay.has(t));
}

/** Estado de disponibilidad de la memoria con procedencia. No escribe. */
function disponibilidad(root) {
  let db;
  try { db = abrir(root); } catch (e) { return { state: 'DB_UNREADABLE', code: 'DB_UNREADABLE', message: e.message }; }
  if (!db) return { state: 'NO_DB', code: 'NO_DB' };
  try {
    const faltan = tablasFaltantes(db, TABLAS_CAPTURA.concat(['mem_observations', 'mem_evidence', 'mem_knowledge', 'mem_provenance']));
    return faltan.length ? { state: 'SCHEMA_MISSING', code: 'SCHEMA_MISSING', missing: faltan, hint: 'Ejecuta: akdd update' } : { state: 'READY' };
  } catch (e) { return { state: 'DB_UNREADABLE', code: 'DB_UNREADABLE', message: e.message }; }
  finally { try { db.close(); } catch { /* ya cerrada */ } }
}

// ───────────────────────────── identidad del proyecto ───────────────────────
function leerIdentidad(db, root) {
  const row = db.get('SELECT * FROM mem_project WHERE singleton = 1');
  const actual = canonicalRoot(root);
  if (!row) return { state: 'NO_IDENTITY', current_root: actual };
  if (row.canonical_root !== actual) return { state: 'ROOT_MISMATCH', project_id: row.project_id, recorded_root: row.canonical_root, current_root: actual, origin: row.origin };
  return { state: 'OK', project_id: row.project_id, canonical_root: row.canonical_root, origin: row.origin, created_at: row.created_at };
}

function asegurarIdentidad(db, root, opts) {
  const id = leerIdentidad(db, root);
  if (id.state !== 'NO_IDENTITY') return id;
  const project_id = 'prj_' + crypto.randomUUID().replace(/-/g, '');
  db.run('INSERT OR IGNORE INTO mem_project (singleton, project_id, canonical_root, created_at, origin) VALUES (1, ?, ?, ?, ?)', project_id, id.current_root, iso(opts), 'created');
  return leerIdentidad(db, root);
}

/** Identidad actual (solo lectura). */
function identidad(root) {
  const db = abrir(root);
  if (!db) return { state: 'NO_DB' };
  try {
    if (tablasFaltantes(db, ['mem_project']).length) return { state: 'SCHEMA_MISSING' };
    return leerIdentidad(db, root);
  } finally { db.close(); }
}

/** RENOMBRE/MOVIDA del mismo proyecto: se conserva el project_id y se actualiza la raíz. Explícito. */
function adoptarRaiz(root, opts) {
  const db = abrir(root, { write: true });
  if (!db) return { ok: false, code: 'NO_DB' };
  try {
    if (tablasFaltantes(db, ['mem_project']).length) return { ok: false, code: 'SCHEMA_MISSING' };
    const id = leerIdentidad(db, root);
    if (id.state !== 'ROOT_MISMATCH') return { ok: false, code: 'NADA_QUE_ADOPTAR', state: id.state };
    db.run("UPDATE mem_project SET canonical_root = ?, origin = 'adopted' WHERE singleton = 1", id.current_root);
    return { ok: true, project_id: id.project_id, from: id.recorded_root, to: id.current_root, at: iso(opts) };
  } finally { db.close(); }
}

/** COPIA del proyecto: la copia recibe un project_id NUEVO y recuerda el anterior. Explícito. */
function bifurcarIdentidad(root, opts) {
  const db = abrir(root, { write: true });
  if (!db) return { ok: false, code: 'NO_DB' };
  try {
    if (tablasFaltantes(db, ['mem_project']).length) return { ok: false, code: 'SCHEMA_MISSING' };
    const id = leerIdentidad(db, root);
    if (id.state !== 'ROOT_MISMATCH') return { ok: false, code: 'NADA_QUE_BIFURCAR', state: id.state };
    const previo = db.get('SELECT previous_ids FROM mem_project WHERE singleton = 1').previous_ids;
    const lista = previo ? JSON.parse(previo) : [];
    lista.push(id.project_id);
    const nuevo = 'prj_' + crypto.randomUUID().replace(/-/g, '');
    db.run("UPDATE mem_project SET project_id = ?, canonical_root = ?, origin = 'forked', previous_ids = ? WHERE singleton = 1", nuevo, id.current_root, JSON.stringify(lista));
    return { ok: true, project_id: nuevo, previous_project_id: id.project_id, at: iso(opts) };
  } finally { db.close(); }
}

// ───────────────────────────── captura de eventos ───────────────────────────
function validarEvento(ev) {
  const errores = [];
  if (!ev || typeof ev !== 'object') return ['evento vacío o no es un objeto'];
  for (const k of ['session_id', 'host', 'event_type']) {
    if (typeof ev[k] !== 'string' || !ev[k].trim()) errores.push(k + ' es obligatorio');
    else if (ev[k].length > 200) errores.push(k + ' excede 200 caracteres');
  }
  if (tiene(ev, 'host_event_id') && ev.host_event_id != null && (typeof ev.host_event_id !== 'string' && typeof ev.host_event_id !== 'number')) errores.push('host_event_id debe ser texto o número');
  if (tiene(ev, 'sequence') && ev.sequence != null && !Number.isInteger(ev.sequence)) errores.push('sequence debe ser un entero');
  if (tiene(ev, 'occurred_at') && ev.occurred_at != null && Number.isNaN(Date.parse(ev.occurred_at))) errores.push('occurred_at no es una fecha válida');
  return errores;
}

function tamanoValor(v) { try { return typeof v === 'string' ? v.length : JSON.stringify(v == null ? '' : v).length; } catch { return Infinity; } }

/**
 * Registra una actividad real. Nunca lanza. Devuelve:
 *   { ok:true, status:'CAPTURED'|'DUPLICATE', event_id, job_id, attempts }
 *   { ok:false, status:'REJECTED'|'DEGRADED'|'BACKPRESSURE', code, message }
 */
function capturar(root, ev, opts = {}) {
  let db = null;
  try {
    const errores = validarEvento(ev);
    if (errores.length) return { ok: false, status: 'REJECTED', code: 'INVALID_EVENT', message: errores.join('; ') };

    db = abrir(root, { write: true });
    if (!db) return { ok: false, status: 'DEGRADED', code: 'NO_DB', message: 'No hay memoria.db en este proyecto (akdd init).' };
    const faltan = tablasFaltantes(db, TABLAS_CAPTURA);
    if (faltan.length) return { ok: false, status: 'DEGRADED', code: 'SCHEMA_MISSING', missing: faltan, message: 'Faltan tablas de memoria con procedencia: ejecuta akdd update. La lectura no migra en silencio.' };

    const pol = privacy.cargarPolitica(root);
    const paths = (Array.isArray(ev.paths) ? ev.paths : []).slice(0, LIMITES.max_paths).map((p) => privacy.normRuta(p));
    const rutaDenegada = paths.some((p) => privacy.rutaPrivada(root, p));
    const grande = tamanoValor(ev.input) > LIMITES.max_payload_chars || tamanoValor(ev.output) > LIMITES.max_payload_chars;
    // Entrada/salida privadas: ni payload ni vista previa. El resto: resumen redactado, nunca el valor íntegro.
    const resIn = rutaDenegada ? null : privacy.resumenSeguro(ev.input, { max: LIMITES.summary_chars, politica: pol });
    const resOut = rutaDenegada ? null : privacy.resumenSeguro(ev.output, { max: LIMITES.summary_chars, politica: pol });
    const clase = rutaDenegada ? 'private' : (resIn === privacy.FALLO || resOut === privacy.FALLO ? 'unknown' : (grande ? 'redacted' : 'authorized'));
    const evidencias = (Array.isArray(ev.evidence_refs) ? ev.evidence_refs : []).map(String).filter((x) => /^ev_[a-f0-9]{16,64}$/.test(x)).slice(0, 50);

    const ocurrio = ev.occurred_at ? new Date(ev.occurred_at).toISOString() : iso(opts);
    const recibido = iso(opts);
    let resultado = null;

    db.transaction(() => {
      const ident = asegurarIdentidad(db, root, opts);
      if (ident.state === 'ROOT_MISMATCH') { resultado = { ok: false, status: 'REJECTED', code: 'PROJECT_ROOT_MISMATCH', message: 'La memoria pertenece a otra ruta (' + ident.recorded_root + '). Si es el mismo proyecto renombrado: akdd memory project adopt. Si es una copia: akdd memory project fork.' }; return; }
      const pid = ident.project_id;

      // Identidad durable del evento cuando el host no entrega ID: la pone el adaptador, con secuencia.
      let hostEventId = ev.host_event_id == null ? null : String(ev.host_event_id);
      let secuencia = Number.isInteger(ev.sequence) ? ev.sequence : null;
      if (hostEventId === null) {
        const max = db.get('SELECT COALESCE(MAX(sequence), 0) AS m FROM mem_events WHERE project_id = ? AND host = ? AND session_id = ?', pid, ev.host, ev.session_id).m;
        secuencia = secuencia === null ? Number(max) + 1 : secuencia;
        hostEventId = 'adapter:' + secuencia;
      }
      if (secuencia === null) secuencia = 0;

      const existente = db.get('SELECT event_id, attempts FROM mem_events WHERE project_id = ? AND host = ? AND session_id = ? AND host_event_id = ?', pid, ev.host, ev.session_id, hostEventId);
      if (existente) {
        db.run('UPDATE mem_events SET attempts = attempts + 1 WHERE event_id = ?', existente.event_id);
        const job = db.get('SELECT job_id FROM mem_job_events WHERE event_id = ?', existente.event_id);
        resultado = { ok: true, status: 'DUPLICATE', event_id: existente.event_id, job_id: job ? job.job_id : null, attempts: Number(existente.attempts) + 1 };
        return;
      }

      const pendientes = db.get("SELECT count(*) AS n FROM mem_jobs WHERE project_id = ? AND state IN ('PENDING','RETRY','RUNNING')", pid).n;
      if (Number(pendientes) >= (opts.maxPending || LIMITES.max_pending_jobs)) {
        resultado = { ok: false, status: 'BACKPRESSURE', code: 'QUEUE_FULL', message: 'La cola de procesamiento está llena (' + pendientes + '). El evento NO se registró: reintenta cuando el worker drene.', pending: Number(pendientes) };
        return;
      }

      const event_id = 'evt_' + sha([pid, ev.host, ev.session_id, hostEventId].join('|')).slice(0, 32);
      const job_id = 'job_' + sha(event_id).slice(0, 32);
      db.run(
        `INSERT INTO mem_events (event_id, schema_version, project_id, canonical_project_root, session_id, task_id, cycle_id, host, role, host_event_id, event_type, sequence, occurred_at, received_at, status, paths, input_summary, output_summary, evidence_refs, redaction_version, privacy_class, attempts)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
        event_id, EVENT_SCHEMA_VERSION, pid, ident.canonical_root, ev.session_id, ev.task_id || null, ev.cycle_id || null, ev.host, ev.role || null, hostEventId, ev.event_type, secuencia, ocurrio, recibido,
        rutaDenegada ? 'SUPPRESSED' : 'CAPTURED',
        JSON.stringify(rutaDenegada ? [] : paths), resIn, resOut, JSON.stringify(evidencias), privacy.REDACTION_VERSION, clase,
      );
      db.run(
        `INSERT INTO mem_jobs (job_id, project_id, kind, state, required, attempts, next_attempt_at, created_at, updated_at)
         VALUES (?,?,?,?,?,0,?,?,?)`,
        job_id, pid, ev.event_type === 'decision' ? 'decision' : 'observe', rutaDenegada ? 'SUPPRESSED' : 'PENDING', opts.required ? 1 : 0, recibido, recibido, recibido,
      );
      db.run('INSERT INTO mem_job_events (job_id, event_id) VALUES (?, ?)', job_id, event_id);
      resultado = { ok: true, status: 'CAPTURED', event_id, job_id, attempts: 1, sequence: secuencia, privacy_class: clase, truncated: grande || undefined };
    })();
    return resultado || { ok: false, status: 'DEGRADED', code: 'CAPTURE_FAILED', message: 'la captura no produjo resultado' };
  } catch (e) {
    // Un update en curso tiene la exclusión de escritores: la captura se degrada de forma explícita (no se pierde
    // en silencio ni bloquea al agente) y el evento puede reenviarse cuando el update termine.
    const code = e && (e.code === 'DB_BUSY' || e.code === 'UPDATE_IN_PROGRESS') ? e.code : 'CAPTURE_FAILED';
    return { ok: false, status: 'DEGRADED', code, message: e && e.message };
  } finally { try { if (db) db.close(); } catch { /* ya cerrada */ } }
}

/**
 * Adaptador de un host: fija host+sesión y deja que la identidad durable la ponga
 * la captura. Capacidades declaradas (no se promete lo que el host no entrega).
 */
function crearAdaptador(root, { host, session_id, role, task_id, cycle_id, capacidad = 'pipeline' } = {}) {
  const sesion = session_id || 'sess_' + crypto.randomUUID().slice(0, 12);
  return {
    host, session_id: sesion, capacidad,
    registrar: (ev, o) => capturar(root, { host, session_id: sesion, role, task_id, cycle_id, ...ev }, o),
  };
}

// ───────────────────────────── observaciones ────────────────────────────────
/** Crea (idempotente) una observación y la liga a sus eventos. NO toca ningún nodo. */
function observar(root, { event_ids, kind, summary, dedupe_key, status = 'PROCESSED', task_id, processor = 'deterministic' }, opts = {}) {
  const db = abrir(root, { write: true });
  if (!db) return { ok: false, code: 'NO_DB' };
  try {
    if (tablasFaltantes(db, ['mem_observations', 'mem_observation_events', 'mem_project']).length) return { ok: false, code: 'SCHEMA_MISSING' };
    if (!ESTADOS_OBSERVACION.includes(status)) return { ok: false, code: 'ESTADO_INVALIDO' };
    const pol = privacy.cargarPolitica(root);
    const ids = [...new Set((event_ids || []).map(String))].sort();
    const resumen = privacy.resumenSeguro(summary, { max: 1200, politica: pol });
    const clave = dedupe_key || sha([kind, task_id || '', ids.join(',')].join('|'));
    const observation_id = 'obs_' + sha(clave).slice(0, 24);
    const ahora = iso(opts);
    let creada = false;
    db.transaction(() => {
      const ident = leerIdentidad(db, root);
      if (ident.state === 'ROOT_MISMATCH') { const e = new Error('PROJECT_ROOT_MISMATCH'); e.code = 'PROJECT_ROOT_MISMATCH'; throw e; }
      const pid = ident.project_id || asegurarIdentidad(db, root, opts).project_id;
      const prev = db.get('SELECT observation_id FROM mem_observations WHERE observation_id = ?', observation_id);
      if (!prev) {
        db.run('INSERT INTO mem_observations (observation_id, project_id, task_id, kind, summary, status, dedupe_key, created_at, updated_at, processor) VALUES (?,?,?,?,?,?,?,?,?,?)', observation_id, pid, task_id || null, kind, resumen, status, clave, ahora, ahora, processor);
        creada = true;
      } else {
        db.run('UPDATE mem_observations SET summary = ?, status = ?, updated_at = ? WHERE observation_id = ?', resumen, status, ahora, observation_id);
      }
      for (const eid of ids) db.run('INSERT OR IGNORE INTO mem_observation_events (observation_id, event_id) VALUES (?, ?)', observation_id, eid);
    })();
    return { ok: true, observation_id, created: creada, status, events: ids.length };
  } catch (e) {
    return { ok: false, code: e.code || 'OBSERVE_FAILED', message: e.message };
  } finally { db.close(); }
}

// ───────────────────────────── conocimiento ─────────────────────────────────
const normTexto = (t) => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();
const jaccard = (a, b) => {
  const A = new Set(normTexto(a).split(/\W+/).filter(Boolean)); const B = new Set(normTexto(b).split(/\W+/).filter(Boolean));
  let i = 0; for (const x of A) if (B.has(x)) i++;
  const u = A.size + B.size - i; return u === 0 ? 0 : i / u;
};
const claveContenido = (tipo, area, scope, titulo, contenido) => sha([tipo, area, scope || '', normTexto(titulo), normTexto(contenido)].join('|'));

function estadoKddDe(estadoMem) {
  switch (estadoMem) {
    case 'VALIDATED': return { estado: 'ACTIVO', vigencia_tipo: 'VIGENTE' };
    case 'OBSOLETE': return { estado: 'OBSOLETO', vigencia_tipo: 'OBSOLETO' };
    default: return { estado: 'ACTIVO', vigencia_tipo: 'SOSPECHOSO' }; // PROPOSED / SUSPECT: se entrega "con verificación" (recall.verificar)
  }
}

function ligar(db, pid, node_id, relation, { observation_id = '', event_id = '', evidence_id = '', related_node_id = '', note = null }, ahora) {
  db.run('INSERT OR IGNORE INTO mem_provenance (project_id, node_id, relation, observation_id, event_id, evidence_id, related_node_id, note, created_at) VALUES (?,?,?,?,?,?,?,?,?)', pid, String(node_id), relation, observation_id, event_id, evidence_id, String(related_node_id), note, ahora);
}

/**
 * Propone conocimiento. Reglas de duplicado/contradicción (C01):
 *   · idéntico y mismo ámbito  → NO crea otro nodo: suma una ocurrencia con su procedencia.
 *   · parecido (Jaccard ≥ .85) → crea el nodo y deja un CANDIDATO DE REVISIÓN. Jamás fusiona.
 *   · contradice               → ver `contradice`. Las versiones/clientes distintos no se mezclan.
 * Nace PROPOSED: ni observación ni repetición lo validan.
 */
function proponerConocimiento(root, c, opts = {}) {
  const db = abrir(root, { write: true });
  if (!db) return { ok: false, code: 'NO_DB' };
  try {
    if (tablasFaltantes(db, ['mem_knowledge', 'mem_provenance', 'mem_project']).length) return { ok: false, code: 'SCHEMA_MISSING' };
    const pol = privacy.cargarPolitica(root);
    const { tipo = 'patron', area = 'global', scope = null, confianza = 'BAJA', archivos = [] } = c;
    const rt = privacy.redactarSecretos(String(c.titulo || '').slice(0, 200), pol); const rc = privacy.redactarSecretos(String(c.contenido || ''), pol);
    if (!rt.ok || !rc.ok) return { ok: false, code: 'REDACTION_FAILED' };
    const titulo = rt.text; const contenido = rc.text;
    if (!titulo.trim() || !contenido.trim()) return { ok: false, code: 'ENTRADA_VACIA' };
    const clave = claveContenido(tipo, area, scope, titulo, contenido);
    const ahora = iso(opts);
    let salida = null;
    db.transaction(() => {
      const ident = leerIdentidad(db, root);
      if (ident.state === 'ROOT_MISMATCH') { const e = new Error('PROJECT_ROOT_MISMATCH'); e.code = 'PROJECT_ROOT_MISMATCH'; throw e; }
      const pid = ident.project_id || asegurarIdentidad(db, root, opts).project_id;
      const origen = { observation_id: (c.observation_ids || [])[0] || '', event_id: (c.event_ids || [])[0] || '' };

      const igual = db.get('SELECT node_id FROM mem_knowledge WHERE project_id = ? AND content_key = ?', pid, clave);
      if (igual) {
        db.run('UPDATE mem_knowledge SET occurrences = occurrences + 1, updated_at = ? WHERE node_id = ?', ahora, igual.node_id);
        for (const o of (c.observation_ids || [])) ligar(db, pid, igual.node_id, 'occurrence', { observation_id: o }, ahora);
        for (const e of (c.event_ids || [])) ligar(db, pid, igual.node_id, 'occurrence', { event_id: e }, ahora);
        salida = { ok: true, action: 'OCCURRENCE', node_id: igual.node_id, merged: false };
        return;
      }

      const enteroId = db.all('PRAGMA table_info(nodos)').some((col) => col.name === 'id' && /INTEGER/i.test(col.type));
      const mapa = estadoKddDe('PROPOSED');
      const hashCtx = (() => { try { return require('./memory-hash.cjs').contextHash(archivos, root).hash; } catch { return null; } })();
      let node_id = enteroId ? null : `${tipo}_${clave.slice(0, 12)}`;
      // nodos tiene UNIQUE (tipo, titulo): el mismo título con otro ámbito/contenido no se fusiona ni se pierde,
      // se distingue con una marca corta derivada de su identidad de contenido.
      const choque = db.get('SELECT 1 AS x FROM nodos WHERE tipo = ? AND titulo = ?', tipo, titulo);
      const tituloFinal = choque ? titulo.slice(0, 170) + ' [' + (scope ? String(scope).slice(0, 24) + '·' : '') + clave.slice(0, 6) + ']' : titulo;
      db.run(
        `INSERT INTO nodos (id, tipo, titulo, contenido, area, confianza, estado, vigencia_tipo, hash_contexto, fecha_creacion, fecha_update, archivos_aplica)
         VALUES (?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'),?)`,
        node_id, tipo, tituloFinal, contenido, area, confianza, mapa.estado, mapa.vigencia_tipo, hashCtx, JSON.stringify(archivos),
      );
      if (enteroId) node_id = Number(db.get('SELECT last_insert_rowid() AS id').id);
      node_id = String(node_id);

      db.run('INSERT INTO mem_knowledge (node_id, project_id, state, provenance, scope, content_key, occurrences, created_at, updated_at) VALUES (?,?,?,?,?,?,1,?,?)', node_id, pid, 'PROPOSED', 'OBSERVED', scope, clave, ahora, ahora);
      ligar(db, pid, node_id, 'originated', origen, ahora);
      for (const o of (c.observation_ids || [])) ligar(db, pid, node_id, 'originated', { observation_id: o }, ahora);
      for (const e of (c.event_ids || [])) ligar(db, pid, node_id, 'originated', { event_id: e }, ahora);
      for (const ev of (c.evidence_ids || [])) ligar(db, pid, node_id, 'supports', { evidence_id: ev }, ahora);

      const parecidos = db.all("SELECT n.id, n.titulo, n.contenido FROM nodos n WHERE n.tipo = ? AND n.area = ? AND n.estado = 'ACTIVO' AND CAST(n.id AS TEXT) <> ? LIMIT 50", tipo, area, node_id)
        .filter((n) => jaccard(titulo + ' ' + contenido, (n.titulo || '') + ' ' + (n.contenido || '')) >= 0.85);
      for (const p of parecidos) ligar(db, pid, node_id, 'review_candidate', { related_node_id: p.id, note: 'parecido semántico: revisión humana, no se fusiona' }, ahora);
      try { db.run('INSERT OR REPLACE INTO nodos_fts(id, titulo, contenido, area, tipo) VALUES (?, ?, ?, ?, ?)', node_id, tituloFinal, contenido, area, tipo); } catch { /* sin FTS: la búsqueda léxica sigue funcionando */ }
      salida = { ok: true, action: 'CREATED', node_id, state: 'PROPOSED', review_candidates: parecidos.map((p) => String(p.id)), merged: false };
    })();
    return salida;
  } catch (e) {
    return { ok: false, code: e.code || 'PROPOSE_FAILED', message: e.message };
  } finally { db.close(); }
}

/** Registra que A contradice a B. Conserva ambos orígenes: NO fusiona, NO borra, NO cambia estados. */
function contradice(root, node_a, node_b, { note = null, evidence_id = '' } = {}, opts = {}) {
  const db = abrir(root, { write: true });
  if (!db) return { ok: false, code: 'NO_DB' };
  try {
    if (tablasFaltantes(db, ['mem_provenance', 'mem_project']).length) return { ok: false, code: 'SCHEMA_MISSING' };
    const pid = (leerIdentidad(db, root).project_id) || asegurarIdentidad(db, root, opts).project_id;
    const ahora = iso(opts);
    db.transaction(() => {
      ligar(db, pid, node_a, 'contradicts', { related_node_id: node_b, evidence_id, note }, ahora);
      ligar(db, pid, node_b, 'contradicts', { related_node_id: node_a, evidence_id, note }, ahora);
    })();
    return { ok: true, relation: 'contradicts', nodes: [String(node_a), String(node_b)], merged: false };
  } catch (e) { return { ok: false, code: 'CONTRADICE_FAILED', message: e.message }; } finally { db.close(); }
}

/** El conocimiento nuevo reemplaza al anterior: el anterior queda OBSOLETE (no se borra) y se enlaza. */
function reemplaza(root, nuevo, anterior, { note = null } = {}, opts = {}) {
  const db = abrir(root, { write: true });
  if (!db) return { ok: false, code: 'NO_DB' };
  try {
    if (tablasFaltantes(db, ['mem_provenance', 'mem_knowledge', 'mem_project']).length) return { ok: false, code: 'SCHEMA_MISSING' };
    const pid = (leerIdentidad(db, root).project_id) || asegurarIdentidad(db, root, opts).project_id;
    const ahora = iso(opts);
    db.transaction(() => {
      ligar(db, pid, nuevo, 'supersedes', { related_node_id: anterior, note }, ahora);
      db.run("UPDATE nodos SET estado = 'OBSOLETO', vigencia_tipo = 'SUPERSEDED', fecha_update = datetime('now') WHERE CAST(id AS TEXT) = ?", String(anterior));
      const existe = db.get('SELECT node_id FROM mem_knowledge WHERE node_id = ?', String(anterior));
      if (existe) db.run("UPDATE mem_knowledge SET state = 'OBSOLETE', updated_at = ? WHERE node_id = ?", ahora, String(anterior));
      else db.run("INSERT INTO mem_knowledge (node_id, project_id, state, provenance, created_at, updated_at) VALUES (?,?, 'OBSOLETE', 'LEGACY_UNVERIFIED_PROVENANCE', ?, ?)", String(anterior), pid, ahora, ahora);
    })();
    return { ok: true, superseded: String(anterior), by: String(nuevo) };
  } catch (e) { return { ok: false, code: 'REEMPLAZA_FAILED', message: e.message }; } finally { db.close(); }
}

/**
 * Valida conocimiento. Exige: nodo existente, validador de la lista (jamás 'model'/'summary'),
 * y al menos una evidencia que SE RE-VERIFICA AHORA (hash y tamaño actuales).
 */
function validarConocimiento(root, node_id, { evidence_ids = [], validated_by, criterio = null } = {}, opts = {}) {
  if (!VALIDADORES_PERMITIDOS.includes(validated_by)) return { ok: false, code: 'VALIDATOR_NOT_ALLOWED', allowed: VALIDADORES_PERMITIDOS };
  if (!Array.isArray(evidence_ids) || !evidence_ids.length) return { ok: false, code: 'EVIDENCE_REQUIRED' };
  const store = require('./evidence-store.cjs');
  for (const eid of evidence_ids) {
    const v = store.verificar(root, eid);
    if (v.status !== 'OK') return { ok: false, code: 'EVIDENCE_NOT_CURRENT', evidence_id: eid, evidence_status: v.status };
  }
  const db = abrir(root, { write: true });
  if (!db) return { ok: false, code: 'NO_DB' };
  try {
    if (tablasFaltantes(db, ['mem_knowledge', 'mem_provenance', 'mem_project']).length) return { ok: false, code: 'SCHEMA_MISSING' };
    const nodo = db.get('SELECT id, estado FROM nodos WHERE CAST(id AS TEXT) = ?', String(node_id));
    if (!nodo) return { ok: false, code: 'NODE_NOT_FOUND' };
    const pid = (leerIdentidad(db, root).project_id) || asegurarIdentidad(db, root, opts).project_id;
    const ahora = iso(opts);
    db.transaction(() => {
      const m = estadoKddDe('VALIDATED');
      db.run("UPDATE nodos SET estado = ?, vigencia_tipo = ?, fecha_update = datetime('now') WHERE CAST(id AS TEXT) = ?", m.estado, m.vigencia_tipo, String(node_id));
      const fila = db.get('SELECT node_id FROM mem_knowledge WHERE node_id = ?', String(node_id));
      if (fila) db.run("UPDATE mem_knowledge SET state = 'VALIDATED', provenance = 'VERIFIED', validated_at = ?, validated_by = ?, stale_since = NULL, updated_at = ? WHERE node_id = ?", ahora, validated_by, ahora, String(node_id));
      else db.run("INSERT INTO mem_knowledge (node_id, project_id, state, provenance, validated_at, validated_by, created_at, updated_at) VALUES (?,?, 'VALIDATED', 'VERIFIED', ?, ?, ?, ?)", String(node_id), pid, ahora, validated_by, ahora, ahora);
      for (const ev of evidence_ids) ligar(db, pid, node_id, 'supports', { evidence_id: ev, note: criterio ? String(criterio).slice(0, 300) : null }, ahora);
    })();
    return { ok: true, node_id: String(node_id), state: 'VALIDATED', validated_by };
  } catch (e) { return { ok: false, code: 'VALIDATE_FAILED', message: e.message }; } finally { db.close(); }
}

/** Cambió código relacionado → el conocimiento VALIDADO pasa a SUSPECT (no se borra). Solo toca lo que ya tiene procedencia nueva. */
function invalidarPorArchivos(root, archivos, opts = {}) {
  const db = abrir(root, { write: true });
  if (!db) return { ok: false, code: 'NO_DB' };
  try {
    if (tablasFaltantes(db, ['mem_knowledge']).length) return { ok: false, code: 'SCHEMA_MISSING' };
    const cambiados = new Set((archivos || []).map(privacy.normRuta));
    const ahora = iso(opts);
    const marcados = [];
    db.transaction(() => {
      const filas = db.all("SELECT k.node_id, n.archivos_aplica FROM mem_knowledge k JOIN nodos n ON CAST(n.id AS TEXT) = k.node_id WHERE k.state = 'VALIDATED'");
      for (const f of filas) {
        let lista = []; try { lista = JSON.parse(f.archivos_aplica || '[]'); } catch { lista = String(f.archivos_aplica || '').split(/[,;\n]/); }
        if (lista.map(privacy.normRuta).some((a) => cambiados.has(a))) {
          db.run("UPDATE mem_knowledge SET state = 'SUSPECT', stale_since = ?, updated_at = ? WHERE node_id = ?", ahora, ahora, f.node_id);
          db.run("UPDATE nodos SET vigencia_tipo = 'SOSPECHOSO', fecha_update = datetime('now') WHERE CAST(id AS TEXT) = ?", f.node_id);
          marcados.push(f.node_id);
        }
      }
    })();
    return { ok: true, suspect: marcados };
  } catch (e) { return { ok: false, code: 'INVALIDATE_FAILED', message: e.message }; } finally { db.close(); }
}

/** Estado de un nodo SIN escribir: lo antiguo sin procedencia se etiqueta al leer. */
function estadoDe(db, node_id) {
  const hayMem = tablasFaltantes(db, ['mem_knowledge']).length === 0;
  const k = hayMem ? db.get('SELECT * FROM mem_knowledge WHERE node_id = ?', String(node_id)) : null;
  if (k) return { state: k.state, provenance: k.provenance, occurrences: Number(k.occurrences), validated_at: k.validated_at, validated_by: k.validated_by, stale_since: k.stale_since };
  const n = db.get('SELECT estado, vigencia_tipo FROM nodos WHERE CAST(id AS TEXT) = ?', String(node_id));
  if (!n) return null;
  const obsoleto = n.estado === 'OBSOLETO' || n.vigencia_tipo === 'SUPERSEDED' || n.vigencia_tipo === 'OBSOLETO';
  return { state: obsoleto ? 'OBSOLETE' : (n.vigencia_tipo === 'SOSPECHOSO' ? 'SUSPECT' : 'VALIDATED_LEGACY'), provenance: 'LEGACY_UNVERIFIED_PROVENANCE', occurrences: null, validated_at: null, validated_by: null, stale_since: null };
}

/** Procedencia de un nodo: de qué actividades, observaciones y evidencias sale, y con qué relaciones. */
function procedencia(root, node_id) {
  const db = abrir(root);
  if (!db) return { ok: false, code: 'NO_DB' };
  try {
    if (tablasFaltantes(db, ['mem_provenance', 'mem_events']).length) return { ok: false, code: 'SCHEMA_MISSING', state: estadoDe(db, node_id) };
    const filas = db.all('SELECT relation, observation_id, event_id, evidence_id, related_node_id, note, created_at FROM mem_provenance WHERE node_id = ? ORDER BY provenance_id', String(node_id));
    const eventos = [...new Set(filas.map((f) => f.event_id).filter(Boolean))];
    const obs = [...new Set(filas.map((f) => f.observation_id).filter(Boolean))];
    for (const o of obs) for (const r of db.all('SELECT event_id FROM mem_observation_events WHERE observation_id = ?', o)) if (!eventos.includes(r.event_id)) eventos.push(r.event_id);
    return {
      ok: true, node_id: String(node_id), status: estadoDe(db, node_id),
      relations: filas,
      events: eventos.map((id) => db.get('SELECT event_id, event_type, host, role, task_id, occurred_at, status, privacy_class, paths FROM mem_events WHERE event_id = ?', id)).filter(Boolean),
      observations: obs.map((id) => db.get('SELECT observation_id, kind, summary, status, created_at FROM mem_observations WHERE observation_id = ?', id)).filter(Boolean),
      evidence: [...new Set(filas.map((f) => f.evidence_id).filter(Boolean))],
    };
  } finally { db.close(); }
}

/** Inventario para el panel Memoria: dato ausente = null (NO 0 falso). */
function inventario(root) {
  const db = abrir(root);
  if (!db) return { available: false, code: 'NO_DB' };
  try {
    const hay = new Set(db.all("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name));
    const contar = (t, where, ...p) => (hay.has(t) ? Number(db.get(['SELECT count(*) AS n FROM', t, where ? ['WHERE', where].join(' ') : ''].join(' '), ...p).n) : null);
    const out = { available: true, schema_ready: TABLAS_CAPTURA.every((t) => hay.has(t)) };
    // Una base sin catálogo aplicado no tiene vigencia_tipo: se informa tal cual, sin lanzar.
    const conVigencia = hay.has('nodos') && db.all('PRAGMA table_info(nodos)').some((c) => c.name === 'vigencia_tipo');
    out.nodes = hay.has('nodos') ? db.all("SELECT tipo, estado, " + (conVigencia ? "COALESCE(vigencia_tipo, '')" : "''") + " AS vigencia, count(*) AS n FROM nodos GROUP BY 1,2,3 ORDER BY 1,2,3") : null;
    out.nodes_total = contar('nodos');
    if (hay.has('nodos') && hay.has('mem_knowledge')) out.legacy_without_provenance = Number(db.get('SELECT count(*) AS n FROM nodos n WHERE NOT EXISTS (SELECT 1 FROM mem_knowledge k WHERE k.node_id = CAST(n.id AS TEXT))').n);
    else out.legacy_without_provenance = hay.has('nodos') ? out.nodes_total : null;
    out.events = contar('mem_events');
    out.observations = hay.has('mem_observations') ? db.all('SELECT status, count(*) AS n FROM mem_observations GROUP BY 1') : null;
    out.knowledge = hay.has('mem_knowledge') ? db.all('SELECT state, count(*) AS n FROM mem_knowledge GROUP BY 1') : null;
    out.jobs = hay.has('mem_jobs') ? db.all('SELECT state, count(*) AS n FROM mem_jobs GROUP BY 1') : null;
    out.evidence = contar('mem_evidence');
    return out;
  } finally { db.close(); }
}

module.exports = {
  EVENT_SCHEMA_VERSION, LIMITES, ESTADOS_OBSERVACION, ESTADOS_CONOCIMIENTO, VALIDADORES_PERMITIDOS, TABLAS_CAPTURA,
  canonicalRoot, abrir, tablasFaltantes, disponibilidad,
  identidad, adoptarRaiz, bifurcarIdentidad,
  validarEvento, capturar, crearAdaptador,
  observar, proponerConocimiento, contradice, reemplaza, validarConocimiento, invalidarPorArchivos, estadoDe, procedencia, inventario,
  estadoKddDe, claveContenido,
};
