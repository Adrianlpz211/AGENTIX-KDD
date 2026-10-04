'use strict';
/**
 * Exclusión de escritores durante `akdd update` (3.20.1).
 *
 * Un solo archivo por proyecto: .agentic/_update/lock.json, creado con
 * apertura exclusiva ('wx'). Lo respetan:
 *   · el db-adapter: ningún escritor del motor abre memoria.db mientras haya un
 *     update vivo (assertWritable → UPDATE_IN_PROGRESS);
 *   · los servicios con conexión persistente (MCP, dashboard, TEAMS): se
 *     registran con registerWriter(), pausan y CIERRAN su conexión cuando
 *     aparece el bloqueo, y lo confirman con un ack que el actualizador espera.
 *
 * Límites honestos:
 *   · Un archivo lock NO controla a un cliente externo que no implemente este
 *     protocolo (otro programa que abra memoria.db con su propio SQLite). Para
 *     esos casos el actualizador además toma el bloqueo de escritura de SQLite
 *     (BEGIN IMMEDIATE) y se detiene antes de aplicar si no puede.
 *   · No se mata ningún proceso del usuario (Cursor, Claude, ...).
 *
 * Recuperación de un bloqueo abandonado: si el heartbeat venció (TTL) y el
 * proceso ya no existe, se aparta con un rename atómico y se reintenta. El
 * heartbeat evita confundir un proceso vivo con un PID reutilizado.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const TTL_MS = 30000;
const SALVA_MS = 4000; // un PID muerto con heartbeat reciente se espera esto antes de recuperar

const dirUpdate = (root) => path.join(root, '.agentic', '_update');
const archivoLock = (root) => path.join(dirUpdate(root), 'lock.json');
const dirWriters = (root) => path.join(dirUpdate(root), 'writers');

/** Raíz canónica: enlaces resueltos y, en Windows/macOS, mayúsculas normalizadas. */
function canonica(root) {
  let r;
  try { r = fs.realpathSync.native(root); } catch { r = path.resolve(root); }
  return process.platform === 'linux' ? r : r.toLowerCase();
}

/** De memoria.db a la raíz del proyecto; null si no es la base de un proyecto Agentix. */
function raizDeDb(dbPath) {
  const abs = path.resolve(dbPath);
  if (path.basename(abs) !== 'memoria.db') return null;
  const dir = path.dirname(abs);
  if (path.basename(dir) !== '.agentic') return null;
  return path.dirname(dir);
}

function vivo(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return !!(e && e.code === 'EPERM'); }
}

function leer(root) {
  let txt;
  try { txt = fs.readFileSync(archivoLock(root), 'utf8'); } catch { return null; }
  try {
    const d = JSON.parse(txt);
    return d && typeof d === 'object' ? d : null;
  } catch { return { _ilegible: true }; } // el dueño lo está reescribiendo: tratar como ocupado
}

/** Estado del bloqueo de un proyecto. */
function estado(root, ahora = Date.now()) {
  const d = leer(root);
  if (!d) return { held: false, stale: false, holder: null };
  if (d._ilegible) return { held: true, stale: false, holder: null, ilegible: true };
  const edad = ahora - Number(d.heartbeat_at || 0);
  const ttl = Number(d.ttl_ms || TTL_MS);
  const muerto = d.host === os.hostname() && !vivo(Number(d.pid));
  const vencido = edad > ttl;
  // Vencido por heartbeat, o dueño muerto y sin latido desde hace SALVA_MS.
  const stale = vencido || (muerto && edad > SALVA_MS);
  return { held: !stale, stale, holder: d, age_ms: edad, owner_alive: !muerto };
}

/** Los escritores del motor llaman esto antes de abrir memoria.db para escribir. */
function assertWritable(dbPath) {
  const root = raizDeDb(dbPath);
  if (!root) return;
  const e = estado(root);
  if (!e.held) return;
  if (e.holder && e.holder.token && process.env.AKDD_UPDATE_TOKEN === e.holder.token) return; // el propio actualizador
  const h = e.holder || {};
  const err = new Error(`UPDATE_IN_PROGRESS: akdd update ${h.op_id || ''} (pid ${h.pid || '?'}) tiene la exclusión de ${root}. Reintenta cuando termine.`);
  err.code = 'UPDATE_IN_PROGRESS';
  err.holder = { op_id: h.op_id, pid: h.pid, phase: h.phase, started_at: h.started_at };
  throw err;
}

const espera = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); // pausa sincrónica sin consumir CPU

/**
 * Toma el bloqueo del proyecto. Lanza LOCK_TIMEOUT si otro update vivo lo tiene
 * y no lo suelta dentro de timeoutMs. opts: { opId, timeoutMs, ttlMs, phase, command }
 */
function acquire(root, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 5000;
  const ttl = Number.isFinite(opts.ttlMs) ? opts.ttlMs : TTL_MS;
  const canon = canonica(root);
  const fin = Date.now() + timeoutMs;
  fs.mkdirSync(dirUpdate(root), { recursive: true });
  for (;;) {
    const token = crypto.randomBytes(16).toString('hex');
    const registro = {
      schema: 1, op_id: opts.opId || crypto.randomUUID(), token, pid: process.pid, host: os.hostname(),
      root: canon, started_at: new Date().toISOString(), heartbeat_at: Date.now(), ttl_ms: ttl,
      phase: opts.phase || 'prepare', command: opts.command || 'update',
    };
    try {
      const fd = fs.openSync(archivoLock(root), 'wx');
      try { fs.writeSync(fd, JSON.stringify(registro, null, 1)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      return { root, token, op_id: registro.op_id, file: archivoLock(root), ttl_ms: ttl, timer: null };
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
    }
    const e = estado(root);
    if (e.holder && e.holder.root && e.holder.root !== canon && !e.stale) {
      const err = new Error('LOCK_ROOT_MISMATCH: el bloqueo existente es de otra raíz canónica: ' + e.holder.root);
      err.code = 'LOCK_ROOT_MISMATCH'; throw err;
    }
    if (e.stale) {
      // Apartar el bloqueo abandonado con un rename atómico; si otro ya lo hizo, se reintenta.
      try { fs.renameSync(archivoLock(root), path.join(dirUpdate(root), `lock.abandonado.${Date.now()}.json`)); } catch { /* otro lo recuperó */ }
      continue;
    }
    if (Date.now() >= fin) {
      const err = new Error(`LOCK_TIMEOUT: otro update (${e.holder && e.holder.op_id}, pid ${e.holder && e.holder.pid}) tiene el proyecto`);
      err.code = 'LOCK_TIMEOUT'; err.holder = e.holder; throw err;
    }
    espera(150);
  }
}

function reescribir(h, cambios) {
  const d = leer(h.root);
  if (!d || d._ilegible || d.token !== h.token) return false; // ya no somos el dueño
  Object.assign(d, cambios, { heartbeat_at: Date.now() });
  try { fs.writeFileSync(h.file, JSON.stringify(d, null, 1)); return true; } catch { return false; }
}

/** Latido: mientras el dueño esté vivo el bloqueo no vence. */
function startHeartbeat(h) {
  if (h.timer) return h;
  h.timer = setInterval(() => reescribir(h, {}), Math.max(500, Math.floor(h.ttl_ms / 3)));
  if (typeof h.timer.unref === 'function') h.timer.unref();
  return h;
}

function setPhase(h, phase) { return reescribir(h, { phase }); }

/** Suelta el bloqueo solo si seguimos siendo el dueño (nunca borra el de otro). */
function release(h) {
  if (!h) return false;
  if (h.timer) { clearInterval(h.timer); h.timer = null; }
  const d = leer(h.root);
  if (!d || d.token !== h.token) return false;
  try { fs.rmSync(h.file, { force: true }); return true; } catch { return false; }
}

// ─────────────────── escritores con conexión persistente ────────────────
/**
 * Un servicio de larga vida (MCP, dashboard, TEAMS) se registra. Cuando hay un
 * update vivo ajeno: llama onPause() (debe cerrar su conexión), deja un ack con
 * el op_id y espera; cuando el bloqueo desaparece llama onResume().
 */
function registerWriter(root, nombre, { onPause, onResume, intervaloMs = 400 } = {}) {
  fs.mkdirSync(dirWriters(root), { recursive: true });
  const id = `${process.pid}-${String(nombre).replace(/[^a-z0-9_-]/gi, '_')}`;
  const f = path.join(dirWriters(root), id + '.json');
  const base = { id, name: nombre, pid: process.pid, host: os.hostname(), registered_at: new Date().toISOString() };
  let pausado = false;
  // Escritura ATÓMICA (temporal + rename): quien lee el latido nunca ve un archivo a medias.
  const escribir = (extra) => {
    const tmp = f + '.' + process.pid + '.tmp';
    try { fs.writeFileSync(tmp, JSON.stringify(Object.assign({}, base, { heartbeat_at: Date.now() }, extra || {}))); fs.renameSync(tmp, f); }
    catch { try { fs.rmSync(tmp, { force: true }); } catch { /* sin disco */ } }
  };
  escribir();
  const timer = setInterval(() => {
    const e = estado(root);
    const ajeno = e.held && e.holder && !e.ilegible && process.env.AKDD_UPDATE_TOKEN !== e.holder.token;
    if (ajeno && !pausado) {
      pausado = true;
      Promise.resolve().then(() => (onPause ? onPause(e.holder) : null)).then(() => escribir({ paused: true, ack_op_id: e.holder.op_id }), () => escribir({ paused: false, ack_error: true }));
    } else if (!ajeno && pausado) {
      pausado = false;
      Promise.resolve().then(() => (onResume ? onResume() : null)).finally(() => escribir({ paused: false }));
    } else if (!pausado) escribir();
  }, intervaloMs);
  if (typeof timer.unref === 'function') timer.unref();
  return { id, file: f, stop() { clearInterval(timer); try { fs.rmSync(f, { force: true }); } catch { /* ya no está */ } } };
}

/**
 * El actualizador espera el ack de cada escritor registrado y vivo.
 * Devuelve { ok, acked, sinAck } — sinAck bloquea el update antes de aplicar.
 */
async function waitForWriters(root, opId, timeoutMs = 6000) {
  const fin = Date.now() + timeoutMs;
  for (;;) {
    const acked = [], sinAck = [];
    let nombres = [];
    try { nombres = fs.readdirSync(dirWriters(root)).filter((n) => n.endsWith('.json')); } catch { /* sin escritores */ }
    for (const n of nombres) {
      let w = null;
      const f = path.join(dirWriters(root), n);
      try { w = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {
        // Un escritor vivo reescribe su latido cada pocos cientos de ms: una lectura a medias NO significa «no hay escritor».
        // Ilegible y reciente = desconocido, y desconocido no es ausente: cuenta como sin ack y se vuelve a leer. Ilegible y
        // viejo es basura de un proceso caído y se retira.
        let edad = null;
        try { edad = Date.now() - fs.statSync(f).mtimeMs; } catch { continue; /* ya no existe */ }
        if (edad > 10000) { try { fs.rmSync(f, { force: true }); } catch { /* otro lo limpió */ } continue; }
        sinAck.push({ id: n.slice(0, -'.json'.length), name: n, pid: null, ilegible: true });
        continue;
      }
      const muerto = w.host === os.hostname() && !vivo(Number(w.pid));
      const sinLatido = Date.now() - Number(w.heartbeat_at || 0) > 10000;
      if (muerto || sinLatido) { try { fs.rmSync(f, { force: true }); } catch { /* otro lo limpió */ } continue; }
      if (w.paused && w.ack_op_id === opId) acked.push(w.id); else sinAck.push({ id: w.id, name: w.name, pid: w.pid });
    }
    if (sinAck.length === 0) return { ok: true, acked, sinAck };
    if (Date.now() >= fin) return { ok: false, acked, sinAck };
    await new Promise((r) => setTimeout(r, 120));
  }
}

module.exports = {
  TTL_MS, canonica, raizDeDb, estado, assertWritable, acquire, startHeartbeat, setPhase, release,
  registerWriter, waitForWriters, archivoLock, dirUpdate, vivo,
};
