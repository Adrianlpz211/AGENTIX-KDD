'use strict';
/**
 * Salud funcional de la memoria (C03): "el proceso está vivo" NO es "la memoria funciona".
 *
 * Siete estados INDEPENDIENTES, cada uno con su fecha, su fuente, su alcance y su
 * antigüedad/expiración (nada se presenta como verificación permanente):
 *
 *   service_available      el proceso que responde (dashboard/CLI) está vivo
 *   db_readable            memoria.db se abre y se consulta en solo lectura
 *   schema_compatible      el catálogo de esquema está COMPLETO (sin migraciones pendientes)
 *   memory_search_ready    la búsqueda sobre `nodos` responde (y su índice de texto, si existe)
 *   memory_write_verified_at  última verificación de ESCRITURA (comando explícito, no al mirar)
 *   queue_healthy          la cola de procesamiento no está atascada ni tiene jobs muertos
 *   update_state           actualización en curso / última verificación de `akdd update`
 *
 * Por qué esta forma:
 *   · Readiness FALLA si falta una capacidad imprescindible (servicio, lectura,
 *     esquema, búsqueda) aunque HTTP responda 200: servicio vivo + esquema roto es
 *     NOT_READY, nunca verde.
 *   · MIRAR la salud nunca escribe. La prueba de escritura es un comando explícito
 *     (`verificarEscritura`): corre sobre una COPIA aislada (VACUUM INTO + transacción
 *     revertida, como la verificación funcional del update) y deja su resultado en
 *     `mem_health` con fecha y expiración. Una verificación vieja se muestra como
 *     STALE: no demuestra nada sobre hoy.
 *   · Una BD de solo lectura sigue buscando; la escritura muestra la limitación real
 *     (se comprueba el permiso del archivo en el momento, no solo la caché).
 *   · Si falta una tabla nueva se diagnostica y se indica `akdd update`. Leer NUNCA
 *     migra ni crea tablas.
 *
 * Estados de cada comprobación: OK · WARN · FAIL · UNKNOWN · NOT_VERIFIED · STALE.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const IMPRESCINDIBLES = Object.freeze(['service_available', 'db_readable', 'schema_compatible', 'memory_search_ready']);
const TTL_ESCRITURA_MS = 24 * 3600 * 1000;
const COLA_ATASCADA_MS = 30 * 60 * 1000;
const CHECK_ESCRITURA = 'write_verification';
const TABLAS_MEMORIA = ['mem_project', 'mem_events', 'mem_observations', 'mem_observation_events', 'mem_knowledge', 'mem_provenance', 'mem_evidence', 'mem_jobs', 'mem_job_events', 'mem_health'];

const ahoraMs = (o) => (o && o.now ? new Date(o.now).getTime() : Date.now());
const iso = (ms) => new Date(ms).toISOString();
const rutaDb = (root) => path.join(root, '.agentic', 'memoria.db');
const corto = (e) => String((e && e.message) || e || '').replace(/\s+/g, ' ').slice(0, 160);

/** Una comprobación con todo lo que hay que mostrar de ella. */
function chk(name, status, f) {
  return Object.assign({
    name, status, code: null, detail: '', action: null,
    source: null, scope: null, checked_at: null, age_ms: null, expires_at: null, expired: false, blocked_by: null,
  }, f);
}

function core() { return require('./memory-core.cjs'); }

// ───────────────────────── lectura (sin escribir) ───────────────────────────
/** db_readable + schema_compatible + memory_search_ready sobre UNA conexión de solo lectura. */
function comprobarLectura(root, t) {
  const p = rutaDb(root);
  const ahora = iso(t);
  const base = { checked_at: ahora, age_ms: 0, expires_at: null };
  const bloqueado = (por) => ({ status: 'FAIL', code: 'BLOQUEADO', detail: 'depende de ' + por, blocked_by: por, source: 'derivado', scope: 'proyecto', ...base });
  if (!fs.existsSync(p)) {
    return {
      db_readable: chk('db_readable', 'FAIL', { code: 'NO_DB', detail: 'el proyecto no tiene .agentic/memoria.db', action: 'akdd init', source: 'sistema de archivos', scope: 'proyecto', ...base }),
      schema_compatible: chk('schema_compatible', 'FAIL', bloqueado('db_readable')),
      memory_search_ready: chk('memory_search_ready', 'FAIL', bloqueado('db_readable')),
      writable_now: null, hasMem: null,
    };
  }
  let db;
  try {
    db = require('./db-adapter.cjs').openReadOnly(p);
    db.get('SELECT count(*) AS n FROM sqlite_master'); // abrir no lee: una BD corrupta solo se nota aquí
  } catch (e) {
    try { db && db.close(); } catch { /* sin conexión */ }
    return {
      db_readable: chk('db_readable', 'FAIL', { code: 'DB_UNREADABLE', detail: 'no se pudo abrir en solo lectura: ' + corto(e), action: 'revisa el respaldo en .agentic/_update/backups (no ejecutes update sobre una base ilegible)', source: 'consulta de solo lectura', scope: 'memoria.db', ...base }),
      schema_compatible: chk('schema_compatible', 'FAIL', bloqueado('db_readable')),
      memory_search_ready: chk('memory_search_ready', 'FAIL', bloqueado('db_readable')),
      writable_now: null, hasMem: null,
    };
  }
  try {
    let writable = true;
    try { fs.accessSync(p, fs.constants.W_OK); } catch { writable = false; }
    const hay = new Set(db.all("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name));
    const out = {
      db_readable: chk('db_readable', 'OK', { detail: 'se abre y se consulta en solo lectura' + (writable ? '' : ' · el archivo es de SOLO LECTURA para este usuario'), source: 'consulta de solo lectura', scope: 'memoria.db', ...base }),
      writable_now: writable, hasMem: hay.has('mem_health'),
      tablas_memoria_faltan: TABLAS_MEMORIA.filter((x) => !hay.has(x)),
    };

    // ── esquema ────────────────────────────────────────────────────────
    let insp = null;
    try { insp = require('./schema-catalog.cjs').inspect(db); } catch (e) { insp = { error: corto(e) }; }
    if (!insp || insp.error) {
      out.schema_compatible = chk('schema_compatible', 'UNKNOWN', { code: 'ESQUEMA_NO_INSPECCIONABLE', detail: insp ? insp.error : 'sin inspección', source: 'schema-catalog', scope: 'memoria.db', ...base });
    } else if (insp.status === 'COMPLETE') {
      out.schema_compatible = chk('schema_compatible', 'OK', { detail: 'catálogo completo (nivel ' + insp.detected_level + ' de ' + insp.supported_level + ')', source: 'schema-catalog.inspect', scope: 'memoria.db', ...base });
    } else {
      const tablasNuevas = [];
      for (const u of insp.pending || []) for (const o of u.ops || []) if (o.op === 'create_table' && !tablasNuevas.includes(o.table)) tablasNuevas.push(o.table);
      const acciones = { PENDING: 'akdd update', BLOCKED: 'akdd update --check (hay conflictos de esquema que requieren revisión humana)', NEWER_SCHEMA: 'actualiza la CLI: npm install -g agentic-kdd' };
      out.schema_compatible = chk('schema_compatible', 'FAIL', {
        code: insp.status === 'PENDING' ? 'ESQUEMA_PENDIENTE' : insp.status,
        detail: insp.status === 'PENDING'
          ? (insp.pending.length + ' migración(es) pendiente(s)' + (tablasNuevas.length ? '; faltan las tablas: ' + tablasNuevas.slice(0, 8).join(', ') + (tablasNuevas.length > 8 ? '…' : '') : ''))
          : 'estado del esquema: ' + insp.status,
        action: acciones[insp.status] || 'akdd update', source: 'schema-catalog.inspect', scope: 'memoria.db', ...base,
      });
      out.esquema_pendiente = insp.pending.length;
      out.tablas_nuevas_faltan = tablasNuevas;
    }

    // ── búsqueda ───────────────────────────────────────────────────────
    if (out.schema_compatible.status !== 'OK') {
      out.memory_search_ready = chk('memory_search_ready', 'FAIL', { code: 'ESQUEMA_NO_COMPATIBLE', detail: 'el motor no abre una memoria con el esquema incompleto: la búsqueda no está lista', blocked_by: 'schema_compatible', action: out.schema_compatible.action, source: 'derivado', scope: 'proyecto', ...base });
    } else if (!hay.has('nodos')) {
      out.memory_search_ready = chk('memory_search_ready', 'FAIL', { code: 'SIN_TABLA_NODOS', detail: 'no existe la tabla nodos', action: 'akdd update', source: 'consulta de solo lectura', scope: 'memoria.db', ...base });
    } else {
      try {
        const n = Number(db.get('SELECT count(*) AS n FROM nodos').n);
        let fts = null;
        if (hay.has('nodos_fts')) {
          try { db.get("SELECT count(*) AS n FROM nodos_fts WHERE nodos_fts MATCH 'agentix'"); fts = 'ok'; } catch (e) { fts = corto(e); }
        }
        if (fts && fts !== 'ok') out.memory_search_ready = chk('memory_search_ready', 'WARN', { code: 'INDICE_TEXTO_DEGRADADO', detail: 'la tabla nodos responde (' + n + ' nodos) pero el índice de texto falla: ' + fts, action: 'node .agentic/grafo/grafo.cjs sync', source: 'consulta de solo lectura', scope: 'nodos + nodos_fts', ...base });
        else out.memory_search_ready = chk('memory_search_ready', 'OK', { detail: n === 0 ? 'la búsqueda responde; la memoria aún no tiene nodos' : 'la búsqueda responde sobre ' + n + ' nodo(s)', source: 'consulta de solo lectura', scope: 'nodos' + (hay.has('nodos_fts') ? ' + nodos_fts' : ''), ...base });
      } catch (e) {
        out.memory_search_ready = chk('memory_search_ready', 'FAIL', { code: 'BUSQUEDA_FALLA', detail: corto(e), source: 'consulta de solo lectura', scope: 'nodos', ...base });
      }
    }

    // ── última verificación de escritura (caché con fecha, no permanente) ─
    out.escritura = leerEscrituraCacheada(db, hay, t, writable);
    return out;
  } finally { try { db.close(); } catch { /* ya cerrada */ } }
}

/** memory_write_verified_at: lo guardado por el comando explícito + el permiso real HOY. */
function leerEscrituraCacheada(db, hay, t, writable) {
  const origen = { source: 'mem_health (comando verificar-escritura)', scope: 'copia aislada + prueba en la base real' };
  const cmd = 'node .agentic/grafo/memoria-salud.cjs verificar-escritura';
  if (!hay.has('mem_health')) return chk('memory_write_verified_at', 'NOT_VERIFIED', { code: 'SIN_TABLA_MEM_HEALTH', detail: 'falta la tabla mem_health: la verificación de escritura se guarda ahí', action: 'akdd update', ...origen });
  let fila = null;
  try { fila = db.get('SELECT status, detail, source, checked_at, expires_at FROM mem_health WHERE check_name = ? AND scope = ?', CHECK_ESCRITURA, 'project'); } catch { fila = null; }
  if (!writable) {
    return chk('memory_write_verified_at', 'FAIL', {
      code: 'BD_SOLO_LECTURA', detail: 'memoria.db es de solo lectura para este usuario: la búsqueda funciona, escribir NO' + (fila ? ' (la última verificación fue ' + String(fila.status) + ' el ' + fila.checked_at + ', pero hoy el permiso cambió)' : ''),
      action: 'revisa los permisos de .agentic/memoria.db', ...origen, source: 'permiso del archivo (ahora)' + (fila ? ' + mem_health' : ''), checked_at: iso(t), age_ms: 0,
    });
  }
  if (!fila) return chk('memory_write_verified_at', 'NOT_VERIFIED', { code: 'NUNCA_VERIFICADA', detail: 'la escritura aún no se verificó. Mirar la salud no escribe; la prueba es un comando explícito.', action: cmd, ...origen });
  const edad = Math.max(0, t - Date.parse(fila.checked_at));
  const expirada = fila.expires_at ? Date.parse(fila.expires_at) <= t : false;
  const base = { ...origen, checked_at: fila.checked_at, age_ms: edad, expires_at: fila.expires_at || null, expired: expirada };
  if (String(fila.status) === 'FAIL') return chk('memory_write_verified_at', 'FAIL', { code: 'ESCRITURA_FALLO', detail: 'la última verificación falló: ' + String(fila.detail || '').slice(0, 160), action: cmd, ...base });
  if (expirada) return chk('memory_write_verified_at', 'STALE', { code: 'VERIFICACION_EXPIRADA', detail: 'la última verificación (' + fila.status + ') es antigua y ya no demuestra nada sobre hoy', action: cmd, ...base });
  return chk('memory_write_verified_at', String(fila.status) === 'PASS' ? 'OK' : 'WARN', { code: String(fila.status) === 'PASS' ? null : 'VERIFICACION_PARCIAL', detail: String(fila.status) === 'PASS' ? 'escritura verificada en una copia aislada y en la base real' : 'verificación parcial: ' + String(fila.detail || '').slice(0, 160), action: String(fila.status) === 'PASS' ? null : cmd, ...base });
}

// ───────────────────────── cola y actualización ─────────────────────────────
function comprobarCola(root, t, bloqueo) {
  const base = { source: 'mem_jobs', scope: 'cola de procesamiento del proyecto', checked_at: iso(t), age_ms: 0, expires_at: null };
  if (bloqueo) return chk('queue_healthy', 'UNKNOWN', { code: 'ESQUEMA_NO_COMPATIBLE', detail: 'no se puede leer la cola: ' + bloqueo, blocked_by: 'schema_compatible', action: 'akdd update', ...base });
  let s;
  try { s = require('./memory-queue.cjs').estadisticas(root, { now: iso(t) }); } catch (e) { return chk('queue_healthy', 'UNKNOWN', { code: 'COLA_ILEGIBLE', detail: corto(e), ...base }); }
  if (!s.available) return chk('queue_healthy', 'UNKNOWN', { code: s.code, detail: s.code === 'SCHEMA_MISSING' ? 'faltan las tablas de la cola' : 'cola no disponible', action: s.code === 'SCHEMA_MISSING' ? 'akdd update' : null, ...base });
  const pendientes = (s.by_state.PENDING || 0) + (s.by_state.RETRY || 0) + (s.by_state.RUNNING || 0);
  const problemas = [];
  if (s.by_state.DEAD_LETTER) problemas.push(s.by_state.DEAD_LETTER + ' job(s) fallido(s) definitivamente');
  if (s.expired_leases) problemas.push(s.expired_leases + ' job(s) con lease vencido (el worker se cayó)');
  const atascada = pendientes > 0 && s.oldest_pending_age_ms > COLA_ATASCADA_MS;
  if (atascada) problemas.push('el trabajo pendiente más antiguo lleva ' + Math.round(s.oldest_pending_age_ms / 60000) + ' min sin procesarse');
  const resumen = { pending: pendientes, dead_letter: s.by_state.DEAD_LETTER || 0, expired_leases: s.expired_leases, oldest_pending_age_ms: s.oldest_pending_age_ms };
  if (!problemas.length) return chk('queue_healthy', 'OK', { detail: pendientes ? pendientes + ' pendiente(s), avanzando' : 'cola vacía', metrics: resumen, ...base });
  return chk('queue_healthy', s.by_state.DEAD_LETTER || atascada ? 'FAIL' : 'WARN', {
    code: atascada ? 'COLA_ATASCADA' : (s.by_state.DEAD_LETTER ? 'JOBS_MUERTOS' : 'LEASES_VENCIDOS'), detail: problemas.join('; '), metrics: resumen,
    action: 'reintenta los jobs fallidos desde el panel Memoria (límite 3 por job) o corre: node .agentic/grafo/memory-queue.cjs drain', ...base,
  });
}

function comprobarUpdate(root, t) {
  const base = { source: 'update-guard + .agentic/_update/last-result.json', scope: 'actualización del proyecto', checked_at: iso(t), age_ms: 0, expires_at: null };
  let ue;
  try { ue = require('./update-estado.cjs'); } catch { return chk('update_state', 'UNKNOWN', { code: 'MODULO_AUSENTE', detail: 'update-estado.cjs no está instalado', ...base }); }
  let enCurso = { in_progress: false };
  try { enCurso = ue.updateEnCurso(root); } catch { /* sin guard */ }
  let ultimo = null;
  try { ultimo = JSON.parse(fs.readFileSync(path.join(root, '.agentic', '_update', 'last-result.json'), 'utf8')); } catch { ultimo = null; }
  const ult = ultimo ? { status: ultimo.status, finished_at: ultimo.finished_at || null, op_id: ultimo.op_id || null } : null;
  if (enCurso.in_progress) return chk('update_state', 'WARN', { code: 'UPDATE_EN_CURSO', detail: 'hay un akdd update en marcha (fase ' + (enCurso.phase || '?') + '): los escritores están pausados', last: ult, ...base });
  if (!ultimo) return chk('update_state', 'NOT_VERIFIED', { code: 'SIN_VERIFICACION', detail: 'no hay una verificación de actualización registrada', action: 'akdd update', ...base });
  const b = { ...base, checked_at: ultimo.finished_at || null, age_ms: ultimo.finished_at ? Math.max(0, t - Date.parse(ultimo.finished_at)) : null, last: ult };
  if (/^(VERIFIED|NO_CHANGES_VERIFIED)$/.test(String(ultimo.status))) return chk('update_state', 'OK', { detail: 'la última actualización terminó ' + ultimo.status, ...b });
  if (ultimo.status === 'VERIFIED_WITH_WARNINGS') return chk('update_state', 'WARN', { code: ultimo.status, detail: 'la última actualización terminó con avisos: revisa su informe', ...b });
  if (ultimo.status === 'UNVERIFIED') return chk('update_state', 'WARN', { code: ultimo.status, detail: 'la última actualización no se pudo verificar por completo', action: 'akdd update', ...b });
  return chk('update_state', 'FAIL', { code: String(ultimo.status || 'DESCONOCIDO'), detail: 'la última actualización no terminó bien (' + ultimo.status + ')', action: 'revisa .agentic/_update/tx/' + (ultimo.op_id || '') + '/', ...b });
}

// ───────────────────────── entrada principal ────────────────────────────────
/**
 * Estado de salud completo. SOLO LECTURA.
 * opts: { now, source }  — `source` nombra quién responde (por defecto el proceso actual).
 */
function leer(root, opts = {}) {
  const t = ahoraMs(opts);
  const servicio = chk('service_available', 'OK', { detail: 'el proceso que responde está vivo (esto NO dice nada de la memoria)', source: opts.source || 'proceso actual', scope: 'proceso', checked_at: iso(t), age_ms: 0 });
  let l;
  try { l = comprobarLectura(root, t); } catch (e) {
    l = {
      db_readable: chk('db_readable', 'FAIL', { code: 'ERROR_INESPERADO', detail: corto(e), source: 'consulta de solo lectura', scope: 'memoria.db', checked_at: iso(t), age_ms: 0 }),
      schema_compatible: chk('schema_compatible', 'UNKNOWN', { blocked_by: 'db_readable', checked_at: iso(t), age_ms: 0 }),
      memory_search_ready: chk('memory_search_ready', 'UNKNOWN', { blocked_by: 'db_readable', checked_at: iso(t), age_ms: 0 }),
      escritura: chk('memory_write_verified_at', 'UNKNOWN', { checked_at: iso(t), age_ms: 0 }), writable_now: null,
    };
  }
  const cola = comprobarCola(root, t, l.schema_compatible.status !== 'OK' ? (l.schema_compatible.detail || l.schema_compatible.code) : null);
  const upd = comprobarUpdate(root, t);
  const escritura = l.escritura || chk('memory_write_verified_at', 'UNKNOWN', { code: 'NO_COMPROBABLE', detail: 'sin base legible no hay nada que verificar', blocked_by: 'db_readable', checked_at: iso(t), age_ms: 0 });
  const checks = { service_available: servicio, db_readable: l.db_readable, schema_compatible: l.schema_compatible, memory_search_ready: l.memory_search_ready, memory_write_verified_at: escritura, queue_healthy: cola, update_state: upd };

  const fallan = IMPRESCINDIBLES.filter((k) => checks[k].status === 'FAIL');
  const noReady = fallan.length > 0;
  const degradan = Object.entries(checks).filter(([k, c]) => !IMPRESCINDIBLES.includes(k) ? (c.status === 'FAIL' || c.status === 'WARN') : c.status === 'WARN').map(([k]) => k);
  const atencion = Object.entries(checks).filter(([, c]) => c.status === 'NOT_VERIFIED' || c.status === 'STALE' || c.status === 'UNKNOWN').map(([k]) => k);
  const status = noReady ? 'NOT_READY' : (degradan.length ? 'DEGRADED' : 'READY');
  const acciones = [];
  for (const [k, c] of Object.entries(checks)) if (c.action && c.status !== 'OK' && !acciones.some((a) => a.action === c.action)) acciones.push({ check: k, status: c.status, action: c.action });
  return {
    status, ready: !noReady, verified_complete: Object.values(checks).every((c) => c.status === 'OK'),
    failing: fallan, degraded_by: degradan, needs_attention: atencion,
    checks, actions: acciones,
    explanation: noReady
      ? 'La memoria NO está lista: ' + fallan.map((k) => k + ' (' + (checks[k].code || checks[k].status) + ')').join(', ') + '. El servicio responde, pero eso no basta.'
      : (degradan.length ? 'La memoria puede buscar, pero hay limitaciones: ' + degradan.join(', ') + '.' : 'La memoria puede buscar y no hay fallos conocidos. Los estados NOT_VERIFIED/STALE indican lo que aún no se ha probado.'),
    generated_at: iso(t),
  };
}

// ───────────────────────── verificación de escritura (explícita) ────────────
/**
 * Prueba de ESCRITURA. Se invoca a propósito (CLI o acción explícita), nunca al abrir el panel.
 *   1. Copia coherente de la base (VACUUM INTO) en un directorio temporal.
 *   2. En la copia: INSERT + lectura dentro de una transacción que se revierte, y la
 *      misma comprobación sobre mem_health. Cubre triggers, índices y esquema.
 *   3. En la base REAL: se guarda el resultado en mem_health (una escritura legítima y
 *      mínima). Si la base es de solo lectura, o hay un update en curso, eso falla y
 *      el resultado lo dice: la copia pasando NO demuestra que la real escriba.
 * Nunca deja filas de prueba en la memoria de nadie.
 */
function verificarEscritura(root, opts = {}) {
  const t = ahoraMs(opts);
  const ttl = Number(opts.ttlMs) > 0 ? Number(opts.ttlMs) : TTL_ESCRITURA_MS;
  const p = rutaDb(root);
  const res = { status: 'FAIL', code: null, copy: null, real: null, persisted: false, checked_at: iso(t), expires_at: iso(t + ttl), source: 'memoria-salud:verificar-escritura' };
  if (!fs.existsSync(p)) { res.code = 'NO_DB'; res.copy = 'NO_PROBADA'; res.real = 'NO_PROBADA'; return res; }
  const dba = require('./db-adapter.cjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-escritura-'));
  try {
    // ── 1-2. copia aislada ──────────────────────────────────────────────
    try {
      const origen = dba.openReadOnly(p);
      try { origen.backupTo(path.join(tmp, 'memoria.db')); } finally { origen.close(); }
      const w = dba.openWrite(path.join(tmp, 'memoria.db'), { updateOwner: true });
      try {
        const hay = new Set(w.all("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name));
        if (!hay.has('nodos')) throw Object.assign(new Error('la copia no tiene la tabla nodos'), { code: 'SIN_TABLA_NODOS' });
        const antes = Number(w.get('SELECT count(*) AS n FROM nodos').n);
        let leido = null; let leidoHealth = null;
        try {
          w.transaction(() => {
            w.run('INSERT INTO nodos (tipo, titulo, contenido, area, confianza) VALUES (?,?,?,?,?)', ['patron', '__verificacion_escritura__', 'prueba transaccional', 'salud', 'BAJA']);
            leido = w.get("SELECT titulo FROM nodos WHERE titulo = '__verificacion_escritura__'");
            if (hay.has('mem_health')) {
              w.run('INSERT OR REPLACE INTO mem_health (check_name, scope, status, detail, source, checked_at) VALUES (?,?,?,?,?,?)', '__prueba__', 'copia', 'PASS', 'prueba', 'copia', iso(t));
              leidoHealth = w.get("SELECT check_name FROM mem_health WHERE check_name = '__prueba__'");
            }
            throw Object.assign(new Error('revertir'), { code: 'REVERTIR_PRUEBA' });
          })();
        } catch (e) { if (!e || e.code !== 'REVERTIR_PRUEBA') throw e; }
        const despues = Number(w.get('SELECT count(*) AS n FROM nodos').n);
        if (!leido) throw Object.assign(new Error('lo insertado no se pudo leer dentro de la transacción'), { code: 'LECTURA_FALLA' });
        if (hay.has('mem_health') && !leidoHealth) throw Object.assign(new Error('mem_health no respondió dentro de la transacción'), { code: 'MEM_HEALTH_FALLA' });
        if (antes !== despues) throw Object.assign(new Error('la transacción de prueba dejó filas'), { code: 'FILAS_RESIDUALES' });
        res.copy = 'PASS';
      } finally { w.close(); }
    } catch (e) { res.copy = 'FAIL'; res.code = e.code || 'COPIA_FALLA'; res.copy_detail = corto(e); }

    // ── 3. base real: el resultado se guarda en mem_health ─────────────
    let real = null;
    let tieneHealth = false;
    try {
      const r = dba.openReadOnly(p);
      try { tieneHealth = r.all("SELECT name FROM sqlite_master WHERE type='table' AND name='mem_health'").length > 0; } finally { r.close(); }
    } catch (e) { res.real = 'FAIL'; res.code = res.code || 'DB_UNREADABLE'; res.real_detail = corto(e); }
    if (res.real === null) {
      if (!tieneHealth) { res.real = 'NO_PROBADA'; res.real_detail = 'falta la tabla mem_health: ejecuta akdd update. La copia sí se probó.'; }
      else {
        const estado = res.copy === 'PASS' ? 'PASS' : 'FAIL';
        const detalle = JSON.stringify({ copy: res.copy, copy_detail: res.copy_detail || null }).slice(0, 300);
        try {
          real = dba.openWrite(p);
          real.run('INSERT OR REPLACE INTO mem_health (check_name, scope, status, detail, source, checked_at, expires_at) VALUES (?,?,?,?,?,?,?)', CHECK_ESCRITURA, 'project', estado, detalle, res.source, res.checked_at, res.expires_at);
          res.real = 'PASS'; res.persisted = true;
        } catch (e) {
          res.real = 'FAIL';
          res.code = e && e.code === 'UPDATE_IN_PROGRESS' ? 'UPDATE_EN_CURSO' : (/readonly|read-only|READ_ONLY/i.test(String(e && (e.message || e.code))) ? 'BD_SOLO_LECTURA' : (res.code || 'ESCRITURA_REAL_FALLA'));
          res.real_detail = corto(e);
        } finally { try { real && real.close(); } catch { /* ya cerrada */ } }
      }
    }
    res.status = res.copy === 'PASS' && res.real === 'PASS' ? 'PASS' : (res.copy === 'PASS' && res.real === 'NO_PROBADA' ? 'PARTIAL' : 'FAIL');
    if (res.status === 'PASS') res.code = null;
    return res;
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temporal */ } }
}

// ───────────────────────── CLI ──────────────────────────────────────────────
function cli(argv) {
  const [cmd, ...resto] = argv;
  const json = resto.includes('--json');
  const root = process.cwd();
  if (cmd === 'verificar-escritura') {
    const r = verificarEscritura(root);
    console.log(json ? JSON.stringify(r, null, 2) : 'Verificación de escritura: ' + r.status + ' (copia ' + r.copy + ' · base real ' + r.real + (r.persisted ? ' · guardada hasta ' + r.expires_at : ' · NO guardada') + ')' + (r.code ? '\n  causa: ' + r.code : ''));
    return r.status === 'FAIL' ? 1 : 0;
  }
  if (!cmd || cmd === 'salud' || cmd === 'estado') {
    const r = leer(root, { source: 'CLI' });
    if (json) console.log(JSON.stringify(r, null, 2));
    else {
      console.log('Memoria: ' + r.status + (r.ready ? '' : '  (NO lista)') + '\n  ' + r.explanation);
      for (const [k, c] of Object.entries(r.checks)) console.log('  ' + k.padEnd(26) + c.status.padEnd(13) + (c.detail || ''));
      for (const a of r.actions) console.log('  → ' + a.action);
    }
    return r.ready ? 0 : 1;
  }
  console.error('uso: memoria-salud.cjs [salud|verificar-escritura] [--json]');
  return 2;
}

if (require.main === module) process.exit(cli(process.argv.slice(2)));

module.exports = { leer, verificarEscritura, IMPRESCINDIBLES, TTL_ESCRITURA_MS, COLA_ATASCADA_MS, CHECK_ESCRITURA, TABLAS_MEMORIA };
