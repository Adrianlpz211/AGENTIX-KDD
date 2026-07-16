'use strict';
/**
 * Agentic KDD — Lock Manager v2.0
 * Lock real para desarrollo multi-instancia en el mismo proyecto.
 *
 * v2.0 fixes:
 * - WAL mode en SQLite para escrituras concurrentes reales
 * - Acquire atómico con transacción (elimina TOCTOU race condition)
 * - Paths normalizados a relativos lowercase para evitar false misses
 * - INSTANCE_ID persistido en disco (.agentic/_instance_id) — sobrevive restarts
 * - Deadlock detection antes de cada acquire
 * - Cleanup automático de locks huérfanos al iniciar
 *
 * Uso:
 *   node .agentic/grafo/lock-manager.cjs acquire --module=auth --files=src/auth.ts
 *   node .agentic/grafo/lock-manager.cjs release --module=auth
 *   node .agentic/grafo/lock-manager.cjs status
 *   node .agentic/grafo/lock-manager.cjs check --files=src/auth.ts,src/middleware.ts
 *   node .agentic/grafo/lock-manager.cjs acquire-schema
 *   node .agentic/grafo/lock-manager.cjs release-schema
 *   node .agentic/grafo/lock-manager.cjs release-all
 *   node .agentic/grafo/lock-manager.cjs wait --module=auth [--timeout=300]
 */

const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const crypto = require('crypto');

const ROOT      = process.cwd();
const DB_PATH   = path.join(ROOT, '.agentic', 'memoria.db');
const INST_FILE = path.join(ROOT, '.agentic', '_instance_id');

const LOCK_TTL_MINUTES   = 30;
const SCHEMA_TTL_MINUTES = 10;
const WAIT_POLL_MS       = 2000;

// ── INSTANCE_ID persistido ────────────────────────────────────────────────────
// Sobrevive reinicios de Cursor — permite liberar locks de sesiones anteriores

function getOrCreateInstanceId() {
  try {
    if (fs.existsSync(INST_FILE)) {
      const id = fs.readFileSync(INST_FILE, 'utf8').trim();
      if (id && id.startsWith('inst_')) return id;
    }
  } catch {}
  const id = `inst_${os.hostname().replace(/[^a-zA-Z0-9]/g,'')}_${crypto.randomBytes(6).toString('hex')}`;
  try { fs.writeFileSync(INST_FILE, id, 'utf8'); } catch {}
  return id;
}

const INSTANCE_ID = process.env.AGENTIC_INSTANCE_ID || getOrCreateInstanceId();

// ── DB setup ─────────────────────────────────────────────────────────────────

function openDB() {
  const projNodeModules = path.join(ROOT, 'node_modules');
  if (!module.paths.includes(projNodeModules)) module.paths.unshift(projNodeModules);
  let db;
  try { db = new (require('better-sqlite3'))(DB_PATH); }
  catch {
    // Fallback node:sqlite (Node 22+) — better-sqlite3 es optionalDependency y
    // su build nativo puede faltar (sin toolchain). Polyfills mínimos para la
    // superficie que usa este módulo: pragma() y transaction().
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(DB_PATH);
    db.pragma = (s) => { try { db.exec('PRAGMA ' + s); } catch {} };
    db.transaction = (fn) => (...args) => {
      db.exec('BEGIN IMMEDIATE');
      try { const r = fn(...args); db.exec('COMMIT'); return r; }
      catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
    };
  }
  // WAL mode: permite lecturas concurrentes mientras se escribe
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000'); // esperar hasta 5s si la BD está ocupada
  return db;
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS module_locks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      module_name  TEXT NOT NULL UNIQUE,
      instance_id  TEXT NOT NULL,
      files        TEXT NOT NULL DEFAULT '[]',
      acquired_at  TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at   TEXT NOT NULL,
      purpose      TEXT,
      pid          INTEGER
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS file_locks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path    TEXT NOT NULL UNIQUE,
      module_name  TEXT NOT NULL,
      instance_id  TEXT NOT NULL,
      acquired_at  TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at   TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_lock (
      id           INTEGER PRIMARY KEY CHECK (id = 1),
      instance_id  TEXT NOT NULL,
      acquired_at  TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at   TEXT NOT NULL,
      purpose      TEXT,
      pid          INTEGER
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS lock_waiters (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      module_name  TEXT NOT NULL,
      instance_id  TEXT NOT NULL,
      waiting_since TEXT NOT NULL DEFAULT (datetime('now')),
      timeout_at   TEXT NOT NULL
    )
  `);
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_ml_inst ON module_locks(instance_id)"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_fl_path ON file_locks(file_path)"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_fl_module ON file_locks(module_name)"); } catch {}
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function expiresAt(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

function waitTimeoutAt(seconds) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

// Normaliza paths: absoluto → relativo, backslashes → forward, lowercase en Windows
function normalizePath(filePath) {
  let p = filePath;
  // Convertir absoluto a relativo si está bajo ROOT
  if (path.isAbsolute(p)) {
    const rel = path.relative(ROOT, p);
    if (!rel.startsWith('..')) p = rel;
  }
  // Forward slashes siempre
  p = p.replace(/\\/g, '/');
  // Quitar ./ inicial
  if (p.startsWith('./')) p = p.slice(2);
  return p;
}

function normalizePaths(files) {
  return [...new Set(files.map(normalizePath))];
}

function purgeExpired(db) {
  db.prepare("DELETE FROM module_locks WHERE expires_at < datetime('now')").run();
  db.prepare("DELETE FROM file_locks WHERE expires_at < datetime('now')").run();
  db.prepare("DELETE FROM schema_lock WHERE expires_at < datetime('now')").run();
  db.prepare("DELETE FROM lock_waiters WHERE timeout_at < datetime('now')").run();
}

// ── Deadlock detection ────────────────────────────────────────────────────────
// Detecta ciclos: A espera B, B espera A → deadlock

function detectDeadlock(db, requestingInstance, targetModule) {
  // ¿Quién tiene targetModule?
  const holder = db.prepare(
    "SELECT instance_id FROM module_locks WHERE module_name = ?"
  ).get(targetModule);
  if (!holder) return { deadlock: false };

  const holderInstance = holder.instance_id;
  if (holderInstance === requestingInstance) return { deadlock: false };

  // ¿El holder está esperando algún módulo que tenga requestingInstance?
  const holderWaiting = db.prepare(
    "SELECT module_name FROM lock_waiters WHERE instance_id = ?"
  ).all(holderInstance);

  for (const w of holderWaiting) {
    const wastedModuleHolder = db.prepare(
      "SELECT instance_id FROM module_locks WHERE module_name = ?"
    ).get(w.module_name);
    if (wastedModuleHolder && wastedModuleHolder.instance_id === requestingInstance) {
      return {
        deadlock: true,
        cycle: `${requestingInstance} → [${targetModule}] → ${holderInstance} → [${w.module_name}] → ${requestingInstance}`,
      };
    }
  }

  return { deadlock: false };
}

// ── Acquire module lock (atómico) ─────────────────────────────────────────────

function acquireModuleLock(db, moduleName, files = [], purpose = '') {
  const normalFiles = normalizePaths(files);

  // Transacción atómica — elimina TOCTOU
  const acquire = db.transaction(() => {
    purgeExpired(db);

    // 1. Verificar si el módulo está bloqueado por otra instancia
    const existingModule = db.prepare(
      "SELECT * FROM module_locks WHERE module_name = ?"
    ).get(moduleName);

    if (existingModule && existingModule.instance_id !== INSTANCE_ID) {
      // Detectar deadlock antes de reportar bloqueo
      const dl = detectDeadlock(db, INSTANCE_ID, moduleName);
      return {
        success: false,
        reason: `Module "${moduleName}" locked by ${existingModule.instance_id}`,
        locked_by: existingModule.instance_id,
        expires_at: existingModule.expires_at,
        deadlock: dl.deadlock,
        deadlock_cycle: dl.cycle,
      };
    }

    // 2. Verificar conflictos de archivos con otras instancias
    const fileConflicts = [];
    for (const file of normalFiles) {
      const fileLock = db.prepare(
        "SELECT * FROM file_locks WHERE file_path = ? AND instance_id != ?"
      ).get(file, INSTANCE_ID);
      if (fileLock) {
        fileConflicts.push({ file, locked_by_module: fileLock.module_name, locked_by_instance: fileLock.instance_id });
      }
    }

    if (fileConflicts.length > 0) {
      return { success: false, reason: 'File conflicts', conflicts: fileConflicts };
    }

    // 3. Adquirir lock de módulo
    const exp = expiresAt(LOCK_TTL_MINUTES);
    db.prepare(`
      INSERT INTO module_locks (module_name, instance_id, files, acquired_at, expires_at, purpose, pid)
      VALUES (?, ?, ?, datetime('now'), ?, ?, ?)
      ON CONFLICT(module_name) DO UPDATE SET
        instance_id=excluded.instance_id, files=excluded.files,
        acquired_at=excluded.acquired_at, expires_at=excluded.expires_at,
        purpose=excluded.purpose, pid=excluded.pid
    `).run(moduleName, INSTANCE_ID, JSON.stringify(normalFiles), exp, purpose, process.pid);

    // 4. Adquirir locks de archivos
    for (const file of normalFiles) {
      db.prepare(`
        INSERT INTO file_locks (file_path, module_name, instance_id, acquired_at, expires_at)
        VALUES (?, ?, ?, datetime('now'), ?)
        ON CONFLICT(file_path) DO UPDATE SET
          module_name=excluded.module_name, instance_id=excluded.instance_id,
          acquired_at=excluded.acquired_at, expires_at=excluded.expires_at
      `).run(file, moduleName, INSTANCE_ID, exp);
    }

    // 5. Remover de waiters si estaba esperando
    db.prepare("DELETE FROM lock_waiters WHERE module_name = ? AND instance_id = ?")
      .run(moduleName, INSTANCE_ID);

    return { success: true, instance_id: INSTANCE_ID, module: moduleName, files: normalFiles, expires_at: exp };
  });

  return acquire();
}

// ── Release module lock ───────────────────────────────────────────────────────

function releaseModuleLock(db, moduleName) {
  let lockSnapshot = null;
  const release = db.transaction(() => {
    const lock = db.prepare(
      "SELECT * FROM module_locks WHERE module_name = ? AND instance_id = ?"
    ).get(moduleName, INSTANCE_ID);
    if (!lock) return { success: false, reason: `No lock owned by this instance for [${moduleName}]` };
    lockSnapshot = lock;

    db.prepare("DELETE FROM module_locks WHERE module_name = ? AND instance_id = ?")
      .run(moduleName, INSTANCE_ID);
    db.prepare("DELETE FROM file_locks WHERE module_name = ? AND instance_id = ?")
      .run(moduleName, INSTANCE_ID);

    return { success: true, module: moduleName };
  });
  const res = release();

  // Plan 7 (T3): los locks se BORRAN al liberarse — sin historial, el Parallel
  // Guard no puede reconstruir ventanas. Esta migaja mecánica persiste la
  // ventana [acquired_at → ahora] en la libreta (gate_events): dos ventanas
  // SOLAPADAS de instancias DISTINTAS = paralelismo probado por hierro,
  // independiente de transcripts, cwd u obediencia del modelo. Fail-soft.
  if (res.success && lockSnapshot) {
    try {
      // acquired_at viene de SQLite datetime('now') = UTC "YYYY-MM-DD HH:MM:SS"
      // sin zona — Date.parse lo leería como hora LOCAL. Normalizar a ISO UTC
      // para que el solape se compare en el mismo reloj que released_at.
      const acqRaw = String(lockSnapshot.acquired_at || '');
      const acqIso = acqRaw.includes('T') ? acqRaw : new Date(acqRaw.replace(' ', 'T') + 'Z').toISOString();
      require(require('path').join(__dirname, 'gate-telemetry.cjs')).recordGateEvent(db, {
        gate: 'legion', verdict: 'LOCK_WINDOW', source: 'mechanical',
        detalle: {
          module: moduleName, instance: INSTANCE_ID,
          acquired_at: acqIso, released_at: new Date().toISOString(),
        },
      });
    } catch { /* nunca bloquea el release */ }
  }
  return res;
}

// ── Release all locks for this instance ──────────────────────────────────────

function releaseAll(db) {
  const rel = db.transaction(() => {
    const modules = db.prepare("SELECT module_name FROM module_locks WHERE instance_id = ?")
      .all(INSTANCE_ID).map(r => r.module_name);
    db.prepare("DELETE FROM module_locks WHERE instance_id = ?").run(INSTANCE_ID);
    db.prepare("DELETE FROM file_locks WHERE instance_id = ?").run(INSTANCE_ID);
    db.prepare("DELETE FROM schema_lock WHERE instance_id = ?").run(INSTANCE_ID);
    db.prepare("DELETE FROM lock_waiters WHERE instance_id = ?").run(INSTANCE_ID);
    return { success: true, released_modules: modules };
  });
  return rel();
}

// ── Check files ───────────────────────────────────────────────────────────────

function checkFiles(db, files) {
  purgeExpired(db);
  const normalFiles = normalizePaths(files);
  const conflicts = [];
  for (const file of normalFiles) {
    const lock = db.prepare(
      "SELECT * FROM file_locks WHERE file_path = ? AND instance_id != ?"
    ).get(file, INSTANCE_ID);
    if (lock) conflicts.push({ file, locked_by_module: lock.module_name, locked_by_instance: lock.instance_id, expires_at: lock.expires_at });
  }
  return { safe: conflicts.length === 0, conflicts };
}

// ── Schema lock ───────────────────────────────────────────────────────────────

function acquireSchemaLock(db, purpose = 'migration') {
  const acquire = db.transaction(() => {
    purgeExpired(db);
    const existing = db.prepare("SELECT * FROM schema_lock WHERE id = 1").get();
    if (existing && existing.instance_id !== INSTANCE_ID) {
      return { success: false, reason: `Schema locked by ${existing.instance_id} for ${existing.purpose}`, expires_at: existing.expires_at };
    }
    const exp = expiresAt(SCHEMA_TTL_MINUTES);
    db.prepare(`
      INSERT INTO schema_lock (id, instance_id, acquired_at, expires_at, purpose, pid)
      VALUES (1, ?, datetime('now'), ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET instance_id=excluded.instance_id,
        acquired_at=excluded.acquired_at, expires_at=excluded.expires_at,
        purpose=excluded.purpose, pid=excluded.pid
    `).run(INSTANCE_ID, exp, purpose, process.pid);
    return { success: true, instance_id: INSTANCE_ID, purpose, expires_at: exp };
  });
  return acquire();
}

function releaseSchemaLock(db) {
  const result = db.prepare("DELETE FROM schema_lock WHERE id = 1 AND instance_id = ?").run(INSTANCE_ID);
  return { success: result.changes > 0 };
}

// ── Wait for lock ─────────────────────────────────────────────────────────────

function waitForLock(db, moduleName, timeoutSeconds = 300) {
  const deadline = Date.now() + timeoutSeconds * 1000;

  // Register as waiter
  db.prepare(`
    INSERT OR REPLACE INTO lock_waiters (module_name, instance_id, waiting_since, timeout_at)
    VALUES (?, ?, datetime('now'), ?)
  `).run(moduleName, INSTANCE_ID, waitTimeoutAt(timeoutSeconds));

  console.log(`⏳ Waiting for [${moduleName}] to be released (timeout: ${timeoutSeconds}s)...`);

  while (Date.now() < deadline) {
    const existing = db.prepare(
      "SELECT * FROM module_locks WHERE module_name = ? AND instance_id != ?"
    ).get(moduleName, INSTANCE_ID);

    if (!existing || new Date(existing.expires_at) < new Date()) {
      // Lock is free — try to acquire
      const result = acquireModuleLock(db, moduleName, [], 'waited');
      if (result.success) {
        console.log(`✅ Lock acquired after waiting: [${moduleName}]`);
        return result;
      }
    }

    // Check for deadlock while waiting
    const dl = detectDeadlock(db, INSTANCE_ID, moduleName);
    if (dl.deadlock) {
      db.prepare("DELETE FROM lock_waiters WHERE module_name = ? AND instance_id = ?").run(moduleName, INSTANCE_ID);
      return { success: false, reason: 'Deadlock detected', deadlock: true, cycle: dl.cycle };
    }

    // Sleep poll — bloqueo real sin quemar CPU (antes era un busy-wait al 100%)
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, WAIT_POLL_MS);
    } catch {
      const start = Date.now();
      while (Date.now() - start < WAIT_POLL_MS) { /* fallback spin */ }
    }
  }

  db.prepare("DELETE FROM lock_waiters WHERE module_name = ? AND instance_id = ?").run(moduleName, INSTANCE_ID);
  return { success: false, reason: `Timeout after ${timeoutSeconds}s waiting for [${moduleName}]` };
}

// ── Renew lock ────────────────────────────────────────────────────────────────

function renewLock(db, moduleName) {
  const exp = expiresAt(LOCK_TTL_MINUTES);
  const r1 = db.prepare("UPDATE module_locks SET expires_at=? WHERE module_name=? AND instance_id=?")
    .run(exp, moduleName, INSTANCE_ID);
  db.prepare("UPDATE file_locks SET expires_at=? WHERE module_name=? AND instance_id=?")
    .run(exp, moduleName, INSTANCE_ID);
  return { success: r1.changes > 0, renewed_until: exp };
}

// ── Status ────────────────────────────────────────────────────────────────────

function getStatus(db) {
  purgeExpired(db);
  return {
    instance_id:  INSTANCE_ID,
    module_locks: db.prepare("SELECT * FROM module_locks ORDER BY acquired_at DESC").all(),
    schema_lock:  db.prepare("SELECT * FROM schema_lock WHERE id=1").get() || null,
    waiters:      db.prepare("SELECT * FROM lock_waiters").all(),
  };
}

function printStatus(s) {
  console.log('\n══════════════════════════════════════════════════');
  console.log('  🔒 Lock Manager v2.0 — Status');
  console.log(`  This instance: ${s.instance_id}`);
  console.log('══════════════════════════════════════════════════');

  if (s.schema_lock) {
    const mine = s.schema_lock.instance_id === s.instance_id;
    console.log(`\n  📐 Schema: ${mine ? '✅ YOURS' : '🔴 BLOCKED by ' + s.schema_lock.instance_id}`);
    console.log(`     Purpose: ${s.schema_lock.purpose} | Expires: ${s.schema_lock.expires_at}`);
  } else {
    console.log('\n  📐 Schema: ✅ free');
  }

  if (s.module_locks.length === 0) {
    console.log('\n  📦 No active module locks\n');
  } else {
    console.log(`\n  📦 Module locks (${s.module_locks.length}):`);
    for (const lock of s.module_locks) {
      const mine  = lock.instance_id === s.instance_id;
      const files = JSON.parse(lock.files || '[]');
      console.log(`\n  ${mine ? '✅' : '🔴'} [${lock.module_name}] — ${mine ? 'YOURS' : 'BLOCKED'}`);
      console.log(`     Instance: ${lock.instance_id}`);
      if (files.length) console.log(`     Files: ${files.join(', ')}`);
      if (lock.purpose) console.log(`     Purpose: ${lock.purpose}`);
      console.log(`     Expires: ${lock.expires_at}`);
    }
  }

  if (s.waiters.length > 0) {
    console.log(`\n  ⏳ Waiting (${s.waiters.length}):`);
    for (const w of s.waiters) {
      console.log(`     [${w.module_name}] ← ${w.instance_id} (since ${w.waiting_since})`);
    }
  }

  console.log('\n══════════════════════════════════════════════════\n');
}

// ── CLI ───────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd  = args[0];
  const opts = {};
  for (const arg of args.slice(1)) {
    const m = arg.match(/^--?([\w-]+)(?:=(.+))?$/);
    if (m) opts[m[1]] = m[2] !== undefined ? m[2] : true;
  }

  if (!fs.existsSync(DB_PATH)) {
    console.error('Lock Manager: memoria.db not found. Run akdd init first.');
    process.exit(1);
  }

  let db;
  try { db = openDB(); ensureSchema(db); }
  catch(e) { console.error('Lock Manager DB error:', e.message); process.exit(1); }

  switch(cmd) {
    case 'acquire': {
      const mod = opts.module || opts.m;
      if (!mod) { console.error('--module required'); process.exit(1); }
      const files   = opts.files ? opts.files.split(',').map(f=>f.trim()) : [];
      const purpose = opts.purpose || opts.p || '';
      const result  = acquireModuleLock(db, mod, files, purpose);
      if (result.success) {
        console.log(`✅ Lock acquired: [${mod}]`);
        if (files.length) console.log(`   Files: ${result.files.join(', ')}`);
        console.log(`   Expires: ${result.expires_at}`);
      } else {
        console.error(`🔴 DENIED: ${result.reason}`);
        if (result.deadlock) console.error(`   💀 DEADLOCK: ${result.deadlock_cycle}`);
        if (result.conflicts) result.conflicts.forEach(c => console.error(`   Conflict: ${c.file} → [${c.locked_by_module}]`));
        process.exit(1);
      }
      break;
    }
    case 'release': {
      const mod = opts.module || opts.m;
      if (!mod) { console.error('--module required'); process.exit(1); }
      const r = releaseModuleLock(db, mod);
      if (r.success) console.log(`✅ Released: [${mod}]`);
      else { console.error(`🔴 ${r.reason}`); process.exit(1); }
      break;
    }
    case 'release-all': {
      const r = releaseAll(db);
      console.log(`✅ Released ${r.released_modules.length} locks: ${r.released_modules.join(', ') || '(none)'}`);
      break;
    }
    case 'check': {
      const files = opts.files ? opts.files.split(',').map(f=>f.trim()) : [];
      if (!files.length) { console.error('--files required'); process.exit(1); }
      const r = checkFiles(db, files);
      if (r.safe) { console.log('✅ Files free — safe to proceed'); }
      else {
        console.error('🔴 Conflicts:');
        r.conflicts.forEach(c => console.error(`   ${c.file} → [${c.locked_by_module}]`));
        process.exit(1);
      }
      break;
    }
    case 'acquire-schema': {
      const r = acquireSchemaLock(db, opts.purpose || opts.p || 'migration');
      if (r.success) console.log(`✅ Schema lock acquired — ${r.purpose} | Expires: ${r.expires_at}`);
      else { console.error(`🔴 Schema locked: ${r.reason}`); process.exit(1); }
      break;
    }
    case 'release-schema': {
      const r = releaseSchemaLock(db);
      if (r.success) console.log('✅ Schema lock released');
      else console.error('⚠️  No schema lock owned by this instance');
      break;
    }
    case 'renew': {
      const mod = opts.module || opts.m;
      if (!mod) { console.error('--module required'); process.exit(1); }
      const r = renewLock(db, mod);
      if (r.success) console.log(`✅ Renewed [${mod}] until ${r.renewed_until}`);
      else { console.error('🔴 No lock to renew'); process.exit(1); }
      break;
    }
    case 'wait': {
      const mod = opts.module || opts.m;
      if (!mod) { console.error('--module required'); process.exit(1); }
      const timeout = parseInt(opts.timeout || '300');
      const r = waitForLock(db, mod, timeout);
      if (!r.success) { console.error(`🔴 ${r.reason}`); process.exit(1); }
      break;
    }
    case 'status':
    default: {
      printStatus(getStatus(db));
      break;
    }
  }
  db.close();
}

module.exports = {
  acquireModuleLock, releaseModuleLock, releaseAll,
  acquireSchemaLock, releaseSchemaLock,
  checkFiles, renewLock, waitForLock,
  getStatus, detectDeadlock, normalizePath,
  INSTANCE_ID,
};
