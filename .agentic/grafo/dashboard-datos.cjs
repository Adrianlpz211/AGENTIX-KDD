'use strict';

/**
 * Lectura de memoria.db para el dashboard, el segundo grafo y la API.
 *
 * Abre SOLO lectura con db-adapter (better-sqlite3, node:sqlite o sql.js, el
 * que haya), nunca crea tablas ni archivos y cierra la conexión aunque una
 * consulta falle. Cada panel vuelve en un sobre:
 *
 *   { status, value, reason_code, source, updated_at }
 *
 *   OK            hay datos
 *   EMPTY         la fuente es válida y no tiene filas: aquí un 0 es verdad
 *   UNAVAILABLE   no se pudo leer (base ausente, bloqueada, corrupta, sin
 *                 driver, tabla que no existe): el valor es null, nunca 0
 *
 * Un fallo en un panel no vacía los demás.
 */

const fs = require('fs');
const path = require('path');
const adapter = require('./db-adapter.cjs');

const ahora = () => new Date().toISOString();

function sobre(status, value, reason_code, extra) {
  return Object.assign({ status, value, reason_code: reason_code || null, source: 'sqlite', updated_at: ahora() }, extra);
}

function clasificarError(err) {
  const msg = String((err && err.message) || err);
  if (err && err.code === 'NOT_INITIALIZED') return 'DB_AUSENTE';
  if (err && err.code === 'UNSUPPORTED') return 'DRIVER_AUSENTE';
  if (/locked|busy/i.test(msg)) return 'DB_BLOQUEADA';
  if (/not a database|malformed|corrupt|file is encrypted/i.test(msg)) return 'DB_CORRUPTA';
  if (/no such table/i.test(msg)) return 'TABLA_AUSENTE';
  if (/no such column/i.test(msg)) return 'ESQUEMA_DISTINTO';
  return 'CONSULTA_FALLA';
}

/**
 * Corre `fn(db)` con la base abierta en solo lectura. Devuelve lo que devuelva
 * `fn` o un sobre UNAVAILABLE con el motivo; la conexión se cierra siempre.
 */
// AKDD_DB_DRIVERS=node-sqlite,sqljs limita los drivers (pruebas y diagnóstico).
const driversEnv = () => (process.env.AKDD_DB_DRIVERS ? process.env.AKDD_DB_DRIVERS.split(',').map((s) => s.trim()).filter(Boolean) : undefined);
const abrirPorDefecto = (p) => adapter.openReadOnly(p, { drivers: driversEnv() });

function conLectura(dbPath, fn, { abrir = abrirPorDefecto } = {}) {
  if (!fs.existsSync(dbPath)) return sobre('UNAVAILABLE', null, 'DB_AUSENTE');
  let db;
  try {
    db = abrir(dbPath);
    // Abrir no lee nada: una base corrupta solo se nota en la primera consulta.
    db.get('SELECT count(*) AS n FROM sqlite_master');
  } catch (e) {
    try { db && db.close(); } catch { /* sin conexión */ }
    return sobre('UNAVAILABLE', null, clasificarError(e), { detalle: String(e.message || e).slice(0, 160) });
  }
  try {
    const r = fn(db);
    if (r && typeof r === 'object' && r.status) r.driver = db.type;
    return r;
  } catch (e) {
    return sobre('UNAVAILABLE', null, clasificarError(e), { detalle: String(e.message || e).slice(0, 160) });
  } finally {
    try { db.close(); } catch { /* ya cerrada */ }
  }
}

const tieneTabla = (db, nombre) => !!db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", nombre);
const contar = (db, sql, ...p) => Number((db.get(sql, ...p) || {}).n || 0);

/** Estados con los que se presentan los contratos; el resto queda UNVERIFIED. */
const ESTADOS_CONTRATO = ['CANDIDATE', 'VERIFIED', 'PROTECTED', 'VIOLATED', 'UNVERIFIED'];
function estadoContrato(s) {
  const v = String(s || '').toUpperCase();
  if (v === 'BROKEN' || v === 'FAILING') return 'VIOLATED';
  return ESTADOS_CONTRATO.includes(v) ? v : 'UNVERIFIED';
}

function contratos(dbPath, opts) {
  return conLectura(dbPath, (db) => {
    if (!tieneTabla(db, 'verified_contracts')) return sobre('UNAVAILABLE', null, 'TABLA_AUSENTE');
    const filas = db.all("SELECT status, COUNT(*) AS n FROM verified_contracts WHERE status IS NULL OR status != 'deprecated' GROUP BY status");
    const por_estado = Object.fromEntries(ESTADOS_CONTRATO.map((e) => [e, 0]));
    for (const f of filas) por_estado[estadoContrato(f.status)] += Number(f.n);
    const total = Object.values(por_estado).reduce((a, b) => a + b, 0);
    const violaciones = tieneTabla(db, 'contract_violations') ? contar(db, 'SELECT COUNT(*) AS n FROM contract_violations WHERE recovered = 0') : null;
    const recientes = db.all("SELECT id, module, name, status, verification_count, failure_count FROM verified_contracts WHERE status IS NULL OR status != 'deprecated' ORDER BY updated_at DESC LIMIT 8")
      .map((c) => Object.assign({}, c, { estado: estadoContrato(c.status) }));
    return sobre(total ? 'OK' : 'EMPTY', { total, por_estado, violaciones, recientes }, violaciones === null ? 'VIOLACIONES_SIN_TABLA' : null);
  }, opts);
}

/** Cuenta con COUNT(*) por clave; una tabla ausente deja esa clave en null. */
function conteos(dbPath, consultas, opts) {
  return conLectura(dbPath, (db) => {
    const value = {};
    const faltan = [];
    for (const [clave, { tabla, sql }] of Object.entries(consultas)) {
      if (!tieneTabla(db, tabla)) { value[clave] = null; faltan.push(tabla); continue; }
      try { value[clave] = contar(db, sql); } catch (e) { value[clave] = null; faltan.push(tabla + ':' + clasificarError(e)); }
    }
    const conocidos = Object.values(value).filter((v) => v !== null);
    const status = !conocidos.length ? 'UNAVAILABLE' : conocidos.every((v) => v === 0) ? 'EMPTY' : 'OK';
    return sobre(status, value, faltan.length ? 'TABLAS_AUSENTES' : null, faltan.length ? { faltan: [...new Set(faltan)] } : {});
  }, opts);
}

/** Filas de varias consultas; cada una vuelve [] si su tabla no existe y se anota.
    Con `snapshot: true` todas se leen dentro de una misma transacción de lectura. */
function filas(dbPath, consultas, opts) {
  const snapshot = !!(opts && opts.snapshot);
  return conLectura(dbPath, (db) => {
    const value = {};
    const faltan = [];
    const transaccion = snapshot && db.capabilities && db.capabilities.transactions;
    if (transaccion) db.exec('BEGIN');
    try {
      for (const [clave, { tabla, sql, params }] of Object.entries(consultas)) {
        if (tabla && !tieneTabla(db, tabla)) { value[clave] = []; faltan.push(tabla); continue; }
        try { value[clave] = db.all(sql, ...(params || [])); } catch (e) { value[clave] = []; faltan.push((tabla || clave) + ':' + clasificarError(e)); }
      }
    } finally {
      if (transaccion) { try { db.exec('COMMIT'); } catch { /* lectura: nada que confirmar */ } }
    }
    return sobre('OK', value, faltan.length ? 'TABLAS_AUSENTES' : null, faltan.length ? { faltan: [...new Set(faltan)] } : {});
  }, opts);
}

const rutaDb = (root) => path.join(root, '.agentic', 'memoria.db');

module.exports = { conLectura, contratos, conteos, filas, sobre, clasificarError, estadoContrato, ESTADOS_CONTRATO, tieneTabla, rutaDb };
