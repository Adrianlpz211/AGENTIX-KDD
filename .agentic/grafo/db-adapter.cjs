'use strict';

/**
 * Un solo adaptador de SQLite para lecturas, escrituras y migraciones.
 *
 * Abrir para leer no crea el archivo, no cambia journal_mode ni user_version
 * y no aplica schema. La migración es una función aparte, con copia previa.
 * sql.js asíncrono no se finge con una espera ocupada: queda unsupported.
 */

const fs = require('fs');
const path = require('path');

function errorCodigo(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function moduloAusente(err) {
  if (!err) return false;
  if (err.code === 'MODULE_NOT_FOUND' || err.code === 'ERR_UNKNOWN_BUILTIN_MODULE') return true;
  return /Cannot find module|node:sqlite/.test(String(err.message));
}

function aplanar(params) {
  return params.flat();
}

function abrirNativo(dbPath, readOnly, busyTimeout, permitidos) {
  const intentos = [];
  const usar = (nombre) => !permitidos || permitidos.includes(nombre);

  if (usar('better-sqlite3')) try {
    const BS3 = require('better-sqlite3');
    const db = new BS3(dbPath, { readonly: readOnly, fileMustExist: readOnly });
    if (!readOnly) {
      db.pragma('busy_timeout = ' + busyTimeout);
      db.pragma('journal_mode = DELETE');
      db.pragma('synchronous = FULL');
    }
    return { db, type: 'better-sqlite3', save: null };
  } catch (err) {
    if (!moduloAusente(err)) throw err;
    intentos.push('better-sqlite3');
  }

  if (usar('node-sqlite')) try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly, timeout: busyTimeout });
    return { db, type: 'node-sqlite', save: null };
  } catch (err) {
    if (!moduloAusente(err)) throw err;
    intentos.push('node:sqlite');
  }

  const sql = usar('sqljs') ? cargarSqlJsSincrono() : null;
  if (sql) {
    if (!fs.existsSync(dbPath)) {
      if (readOnly) throw errorCodigo('NOT_INITIALIZED', 'NOT_INITIALIZED: ' + dbPath);
    }
    const buffer = fs.existsSync(dbPath) ? fs.readFileSync(dbPath) : null;
    const db = buffer ? new sql.Database(buffer) : new sql.Database();
    const destino = dbPath;
    const save = () => {
      const data = db.export();
      fs.writeFileSync(destino, Buffer.from(data));
    };
    return { db, type: 'sqljs', save, sqlJs: true };
  }

  throw errorCodigo(
    'UNSUPPORTED',
    'Sin driver SQLite usable (' + intentos.join(', ') + '). sql.js asíncrono no se resuelve esperando.'
  );
}

function cargarSqlJsSincrono() {
  let exported;
  try {
    exported = require('sql.js');
  } catch (err) {
    if (moduloAusente(err)) return null;
    throw err;
  }
  if (exported && exported.Database) return exported;
  const dist = path.join(path.dirname(require.resolve('sql.js')), 'dist', 'sql-wasm.js');
  if (fs.existsSync(dist)) {
    const wasm = require(dist);
    if (wasm && wasm.Database) return wasm;
  }
  return null;
}

function envolver(nativo, opciones) {
  const state = {
    depth: 0,
    readOnly: !!opciones.readOnly,
    legacySwallow: !!opciones.legacySwallow && !opciones.readOnly,
    type: nativo.type,
  };

  function proteger(fn, vacio) {
    return (...args) => {
      try {
        return fn(...args);
      } catch (err) {
        if (state.depth > 0 || !state.legacySwallow) throw err;
        return vacio;
      }
    };
  }

  function sentencia(sql) {
    if (nativo.sqlJs) return null;
    return nativo.db.prepare(sql);
  }

  const execNativo = (sql) => {
    if (state.readOnly && /^\s*(create|alter|drop|insert|update|delete|replace|pragma\s+\w+\s*=)/i.test(sql)) {
      throw errorCodigo('READ_ONLY', 'READ_ONLY');
    }
    nativo.db.exec(sql);
  };

  const api = {
    type: nativo.type,
    readOnly: state.readOnly,
    capabilities: {
      driver: nativo.type,
      transactions: nativo.type !== 'sqljs',
      nestedSavepoints: nativo.type !== 'sqljs',
      readOnly: state.readOnly,
      multiProcess: nativo.type !== 'sqljs',
      asyncBusyWait: false,
    },
    exec: proteger(execNativo, undefined),
    run: proteger((sql, ...params) => {
      const valores = aplanar(params);
      if (nativo.sqlJs) {
        nativo.db.run(sql, valores);
        return { changes: nativo.db.getRowsModified() };
      }
      const stmt = sentencia(sql);
      const r = valores.length ? stmt.run(...valores) : stmt.run();
      return { changes: r && typeof r.changes !== 'undefined' ? Number(r.changes) : null };
    }, undefined),
    get: proteger((sql, ...params) => {
      const valores = aplanar(params);
      if (nativo.sqlJs) {
        const stmt = nativo.db.prepare(sql);
        if (valores.length) stmt.bind(valores);
        const row = stmt.step() ? stmt.getAsObject() : null;
        stmt.free();
        return row;
      }
      const stmt = sentencia(sql);
      return valores.length ? stmt.get(...valores) : stmt.get();
    }, null),
    all: proteger((sql, ...params) => {
      const valores = aplanar(params);
      if (nativo.sqlJs) {
        const stmt = nativo.db.prepare(sql);
        if (valores.length) stmt.bind(valores);
        const rows = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        stmt.free();
        return rows;
      }
      const stmt = sentencia(sql);
      return valores.length ? stmt.all(...valores) : stmt.all();
    }, []),
    prepare(sql) {
      if (nativo.sqlJs) {
        return {
          run: (...params) => api.run(sql, ...params),
          get: (...params) => api.get(sql, ...params),
          all: (...params) => api.all(sql, ...params),
        };
      }
      const stmt = sentencia(sql);
      return {
        run: (...params) => {
          try {
            const valores = aplanar(params);
            return valores.length ? stmt.run(...valores) : stmt.run();
          } catch (err) {
            if (state.depth > 0 || !state.legacySwallow) throw err;
          }
        },
        get: (...params) => {
          try {
            const valores = aplanar(params);
            return valores.length ? stmt.get(...valores) : stmt.get();
          } catch (err) {
            if (state.depth > 0 || !state.legacySwallow) throw err;
            return null;
          }
        },
        all: (...params) => {
          try {
            const valores = aplanar(params);
            return valores.length ? stmt.all(...valores) : stmt.all();
          } catch (err) {
            if (state.depth > 0 || !state.legacySwallow) throw err;
            return [];
          }
        },
      };
    },
    pragma(statement) {
      if (state.readOnly && /=/.test(String(statement))) {
        throw errorCodigo('READ_ONLY', 'READ_ONLY');
      }
      const sql = /^\s*pragma\b/i.test(statement) ? statement : 'PRAGMA ' + statement;
      return api.exec(sql);
    },
    transaction(fn) {
      if (state.readOnly) throw errorCodigo('READ_ONLY', 'READ_ONLY');
      if (!api.capabilities.transactions) {
        throw errorCodigo('UNSUPPORTED', 'Este driver no ofrece transacciones reales');
      }
      return (...args) => {
        const anidada = state.depth > 0;
        const sp = 'akdd_sp_' + state.depth;
        if (anidada) nativo.db.exec('SAVEPOINT ' + sp);
        else nativo.db.exec('BEGIN');
        state.depth += 1;
        try {
          const result = fn(...args);
          state.depth -= 1;
          if (anidada) nativo.db.exec('RELEASE ' + sp);
          else nativo.db.exec('COMMIT');
          return result;
        } catch (err) {
          state.depth -= 1;
          try {
            if (anidada) {
              nativo.db.exec('ROLLBACK TO ' + sp);
              nativo.db.exec('RELEASE ' + sp);
            } else {
              nativo.db.exec('ROLLBACK');
            }
          } catch { /* el error original manda */ }
          throw err;
        }
      };
    },
    close() {
      if (nativo.save && !state.readOnly) nativo.save();
      if (typeof nativo.db.close === 'function') nativo.db.close();
    },
    save: nativo.save && !state.readOnly ? nativo.save : null,
  };

  return api;
}

function open(dbPath, opciones) {
  const opts = opciones || {};
  const readOnly = !!opts.readOnly;
  if (readOnly && !fs.existsSync(dbPath)) {
    throw errorCodigo('NOT_INITIALIZED', 'NOT_INITIALIZED: ' + dbPath);
  }
  const padre = path.dirname(dbPath);
  if (!readOnly && !fs.existsSync(padre)) fs.mkdirSync(padre, { recursive: true });
  const busyTimeout = Number.isFinite(opts.busyTimeout) ? opts.busyTimeout : 5000;
  let nativo;
  try {
    nativo = abrirNativo(dbPath, readOnly, busyTimeout, Array.isArray(opts.drivers) ? opts.drivers : null);
  } catch (err) {
    if (readOnly && /unable to open|SQLITE_CANTOPEN|no such file/i.test(String(err && err.message))) {
      throw errorCodigo('NOT_INITIALIZED', 'NOT_INITIALIZED: ' + dbPath);
    }
    throw err;
  }
  return envolver(nativo, {
    readOnly,
    legacySwallow: !!opts.legacySwallow && !readOnly,
  });
}

function openReadOnly(dbPath, opciones) {
  return open(dbPath, Object.assign({}, opciones, { readOnly: true, legacySwallow: false }));
}

function openWrite(dbPath, opciones) {
  return open(dbPath, Object.assign({}, opciones, { readOnly: false, legacySwallow: false }));
}

function userVersion(db) {
  const row = db.get('PRAGMA user_version');
  if (!row) return 0;
  const valor = row.user_version;
  return Number.isFinite(valor) ? valor : 0;
}

function initialize(dbPath, schemaSql) {
  const db = openWrite(dbPath);
  try {
    if (schemaSql) db.exec(schemaSql);
  } finally {
    db.close();
  }
  return { status: 'INITIALIZED', path: dbPath };
}

function migrate(dbPath, opciones) {
  const opts = opciones || {};
  if (!fs.existsSync(dbPath)) {
    throw errorCodigo('NOT_INITIALIZED', 'NOT_INITIALIZED: ' + dbPath);
  }
  const conVersion = opts.version !== undefined;
  const version = conVersion ? Number(opts.version) : null;
  if (conVersion && (!Number.isInteger(version) || version < 0)) {
    throw errorCodigo('INVALID_VERSION', 'version de migración inválida');
  }
  if (!conVersion && typeof opts.run !== 'function') {
    throw errorCodigo('INVALID_VERSION', 'version de migración inválida');
  }
  const statements = Array.isArray(opts.statements) ? opts.statements : [];
  if (opts.dryRun) {
    return { status: 'DRY_RUN', version, statements, applied: false };
  }
  const backupPath = dbPath + '.bak-' + Date.now();
  const db = openWrite(dbPath);
  // Copiar sólo memoria.db pierde commits que aún viven en -wal.
  // VACUUM INTO genera un respaldo SQLite coherente, incluidos esos commits.
  try { db.exec("VACUUM INTO '" + backupPath.replace(/'/g, "''") + "'"); }
  catch (err) { db.close(); err.backupPath = backupPath; throw err; }
  let detalle;
  try {
    db.transaction(() => {
      statements.forEach((sql) => db.exec(sql));
      if (typeof opts.run === 'function') detalle = opts.run(db);
      if (conVersion) db.exec('PRAGMA user_version = ' + version);
    })();
  } catch (err) {
    try { db.close(); } catch { /* se restaura el archivo */ }
    // La transacción ya hizo ROLLBACK. No sobrescribir una DB abierta por otro proceso.
    err.backupPath = backupPath;
    throw err;
  }
  db.close();
  return { status: 'APPLIED', version, backupPath, applied: true, detalle };
}

module.exports = {
  open,
  openReadOnly,
  openWrite,
  initialize,
  migrate,
  userVersion,
};
