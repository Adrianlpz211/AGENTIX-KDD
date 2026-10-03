'use strict';

/**
 * TEAMS nativo — un único backend para chat (`teams:`), CLI (`akdd teams`) y MCP.
 *
 * La fuente de verdad es la base transaccional (memoria.db, tablas teams_*).
 * Los MD de `.legion/` son vistas regeneradas por un solo escritor: leerlos
 * nunca activa, desactiva ni crea trabajo.
 *
 * Estados de tarea:
 *   PENDING → READY → RUNNING → VERIFYING → DONE_VERIFIED
 *   BLOCKED_HUMAN · BLOCKED_DEPENDENCY · BLOCKED_TECHNICAL · FAILED · REVERTED · CANCELLED
 * El constructor nunca declara DONE: entrega un resultado y el controlador
 * verifica con gates del sujeto exacto.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dba = require('./db-adapter.cjs');
const { allowsVerifiedClose } = require('./gate-result.cjs');

const SCHEMA_VERSION = 1;
const ESTADOS = ['PENDING', 'READY', 'RUNNING', 'VERIFYING', 'DONE_VERIFIED', 'BLOCKED_HUMAN',
  'BLOCKED_DEPENDENCY', 'BLOCKED_TECHNICAL', 'FAILED', 'REVERTED', 'CANCELLED'];
/* REVERTED no es final: la tarea no quedó implementada y puede reintentarse desde el punto sano. */
const FINALES = new Set(['DONE_VERIFIED', 'CANCELLED']);
const ALCANCES = ['TASK', 'DEPENDENCY_CHAIN', 'GLOBAL', 'CHANNEL'];
const RIESGOS = ['LOW', 'MEDIUM', 'HIGH'];
/** Gates que TEAMS impone por sí mismo (alcance, leases, plan); el resto llega del controlador. */
const GATES_PROPIOS = new Set(['scope', 'leases', 'plan']);
const LIMITES_DEFECTO = { reparaciones: 3, replanificaciones: 2, max_intentos_plan: 60, max_minutos_plan: null, lease_ms: 10 * 60 * 1000, ack_ms: 2 * 60 * 1000 };
const ROLES_DEFECTO = { director: { host: 'claude-code' }, builder: { host: 'cursor' } };
/** Orígenes que prueban que la decisión la tomó una persona. */
const ORIGEN_HOOK_TTL_MS = 30 * 60 * 1000;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS teams_meta (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS teams_sessions (id INTEGER PRIMARY KEY CHECK (id = 1), enabled INTEGER NOT NULL DEFAULT 0,
    paused INTEGER NOT NULL DEFAULT 0, session_generation INTEGER NOT NULL DEFAULT 0, project_id TEXT, roles TEXT, updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS teams_plans (id TEXT PRIMARY KEY, objective TEXT NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
    limits TEXT, replans INTEGER NOT NULL DEFAULT 0, final_report TEXT, created_at TEXT, updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS teams_sprints (id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, n INTEGER NOT NULL, objective TEXT, state TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS teams_tasks (id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, sprint_id TEXT, objective TEXT NOT NULL,
    acceptance TEXT NOT NULL, depends_on TEXT NOT NULL, allowed_files TEXT NOT NULL, risk TEXT NOT NULL, effort_policy TEXT,
    state TEXT NOT NULL, owner_id TEXT, revision INTEGER NOT NULL DEFAULT 1, subject_hash TEXT, evidence TEXT, stop TEXT,
    restore_point_id TEXT, priority INTEGER NOT NULL DEFAULT 0, orden INTEGER NOT NULL DEFAULT 0, repairs INTEGER NOT NULL DEFAULT 0,
    failed_hashes TEXT, blocked_reason TEXT, created_at TEXT, updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS teams_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, owner_id TEXT, fencing INTEGER,
    delivery_id TEXT, state TEXT NOT NULL, subject_hash TEXT, result TEXT, started_at TEXT, finished_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS teams_decisions (id TEXT PRIMARY KEY, reason_code TEXT NOT NULL, scope TEXT NOT NULL, affected_tasks TEXT,
    affected_resources TEXT, evidence TEXT, decision_required INTEGER NOT NULL DEFAULT 0, question TEXT, safe_independent_tasks TEXT,
    decision TEXT, decided_by TEXT, origin TEXT, created_at TEXT, resolved_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS teams_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, project_id TEXT,
    session_generation INTEGER, producer_role TEXT, target_role TEXT, task_id TEXT, revision INTEGER, kind TEXT NOT NULL,
    payload_hash TEXT, payload TEXT, created_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS teams_delivery (delivery_id TEXT PRIMARY KEY, event_seq INTEGER, task_id TEXT, target_role TEXT,
    owner_id TEXT, host_session_id TEXT, state TEXT NOT NULL, retry_count INTEGER NOT NULL DEFAULT 0, next_retry_at INTEGER,
    ack_at TEXT, created_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS teams_leases (resource TEXT PRIMARY KEY, owner_id TEXT NOT NULL, task_id TEXT, fencing INTEGER NOT NULL,
    expires_ms INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS teams_acks (role TEXT PRIMARY KEY, last_ack_seq INTEGER NOT NULL DEFAULT 0)`,
];

// ─── utilidades ──────────────────────────────────────────────────────────────

const ahoraIso = () => new Date().toISOString();
const sha = (v) => crypto.createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
const js = (v) => JSON.stringify(v === undefined ? null : v);
const pj = (v, d) => { try { return v == null ? d : JSON.parse(v); } catch { return d; } };
const dbPath = (root) => path.join(root, '.agentic', 'memoria.db');
const dirTeams = (root) => path.join(root, '.agentic', '_teams');

function errorTeams(code, mensaje, extra) {
  const e = new Error(code + ': ' + mensaje);
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

function normalizarRecurso(f) {
  return String(f || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').toLowerCase();
}

function escribirAtomico(f, contenido) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, contenido);
  fs.renameSync(tmp, f);
}

function conDB(root, fn) {
  if (!fs.existsSync(dbPath(root))) throw errorTeams('NOT_INITIALIZED', 'no hay memoria.db en ' + root + ' (akdd init primero)');
  const db = dba.openWrite(dbPath(root));
  try { return fn(db); } finally { db.close(); }
}

function tieneEsquema(db) {
  return !!db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='teams_meta'");
}

/** Abre, exige esquema y corre `fn` en una transacción. Los avisos de despertar salen después del COMMIT. */
function tx(root, fn) {
  const despertar = [];
  const r = conDB(root, (db) => {
    if (!tieneEsquema(db)) throw errorTeams('MIGRACION_PENDIENTE', 'TEAMS no está inicializado: akdd teams init --aprobar-migracion');
    return db.transaction(() => fn(db, despertar))();
  });
  for (const d of despertar) avisar(root, d.target, d.seq);
  return r;
}

function lectura(root, fn) {
  if (!fs.existsSync(dbPath(root))) return fn(null);
  const db = dba.openReadOnly(dbPath(root));
  try { return fn(tieneEsquema(db) ? db : null); } finally { db.close(); }
}

/** Indicador de revisión para los vigilantes: la señal, nunca la fuente de verdad. */
function avisar(root, target, seq) {
  try { escribirAtomico(path.join(dirTeams(root), 'rev-' + target + '.json'), JSON.stringify({ seq, at: ahoraIso() })); } catch { /* el respaldo por timer lo cubre */ }
}

function sesion(db) {
  const s = db.get('SELECT * FROM teams_sessions WHERE id = 1');
  return s ? { enabled: !!s.enabled, paused: !!s.paused, session_generation: s.session_generation, project_id: s.project_id, roles: pj(s.roles, {}), updated_at: s.updated_at } : null;
}

function fila(t) {
  if (!t) return null;
  return {
    id: t.id, plan_id: t.plan_id, sprint_id: t.sprint_id, objective: t.objective,
    acceptance: pj(t.acceptance, []), depends_on: pj(t.depends_on, []), allowed_files: pj(t.allowed_files, []),
    risk: t.risk, effort_policy: pj(t.effort_policy, {}), state: t.state, owner_id: t.owner_id, revision: t.revision,
    subject_hash: t.subject_hash, evidence: pj(t.evidence, []), stop: pj(t.stop, null), restore_point_id: t.restore_point_id,
    priority: t.priority, repairs: t.repairs, failed_hashes: pj(t.failed_hashes, []), blocked_reason: t.blocked_reason,
  };
}

const tarea = (db, id) => fila(db.get('SELECT * FROM teams_tasks WHERE id = ?', id));
const tareas = (db, planId) => (planId
  ? db.all('SELECT * FROM teams_tasks WHERE plan_id = ? ORDER BY orden', planId)
  : db.all('SELECT * FROM teams_tasks ORDER BY plan_id, orden')).map(fila);

function publicar(db, despertar, ev) {
  const s = sesion(db) || {};
  const payload = ev.payload || {};
  const eventId = ev.event_id || ('ev-' + crypto.randomUUID());
  const previo = db.get('SELECT seq FROM teams_events WHERE event_id = ?', eventId);
  if (previo) return { seq: previo.seq, event_id: eventId, duplicado: true };
  db.run(`INSERT INTO teams_events (event_id, project_id, session_generation, producer_role, target_role, task_id, revision, kind, payload_hash, payload, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, eventId, s.project_id || null, s.session_generation || 0, ev.producer || 'teams',
  ev.target || 'director', ev.task_id || null, ev.revision || null, ev.kind, sha(payload), js(payload), ahoraIso());
  const seq = db.get('SELECT seq FROM teams_events WHERE event_id = ?', eventId).seq;
  despertar.push({ target: ev.target || 'director', seq });
  return { seq, event_id: eventId, duplicado: false };
}

/** Transición validada: estado de origen permitido + revisión esperada. */
function transicionar(db, id, { de, a, revision, cambios = {} }) {
  const t = tarea(db, id);
  if (!t) throw errorTeams('TAREA_DESCONOCIDA', id);
  if (de && !de.includes(t.state)) throw errorTeams('TRANSICION_INVALIDA', `${id}: ${t.state} → ${a}`, { estado: t.state });
  if (revision != null && revision !== t.revision) throw errorTeams('REVISION_OBSOLETA', `${id}: esperaba ${revision}, actual ${t.revision}`, { actual: t.revision });
  const sets = ['state = ?', 'revision = revision + 1', 'updated_at = ?'];
  const vals = [a, ahoraIso()];
  for (const [k, v] of Object.entries(cambios)) {
    sets.push(k + ' = ?');
    vals.push(v !== null && typeof v === 'object' ? js(v) : v);
  }
  db.run(`UPDATE teams_tasks SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);
  return tarea(db, id);
}

// ─── validación de plan (una sola, la usan todos los roles) ──────────────────

/**
 * Valida la forma de una tarea. Director (al planificar), constructor (al
 * recibir una asignación) e importación de respuestas externas usan esta misma
 * función: no hay un schema por rol.
 */
function validarTarea(t) {
  const errores = [];
  if (!t || typeof t !== 'object') return ['TAREA_NO_OBJETO'];
  if (!/^[\w.-]{1,40}$/.test(String(t.id || ''))) errores.push('ID_INVALIDO');
  if (!String(t.objective || '').trim()) errores.push('SIN_OBJETIVO');
  if (!Array.isArray(t.acceptance) || !t.acceptance.some((a) => String(a).trim())) errores.push('SIN_ACEPTACION');
  if (!Array.isArray(t.allowed_files) || !t.allowed_files.length) errores.push('SIN_ALCANCE');
  else if (t.allowed_files.some((f) => /(^|[\\/])\.\.([\\/]|$)/.test(String(f)) || path.isAbsolute(String(f)))) errores.push('ALCANCE_FUERA_DEL_PROYECTO');
  if (t.depends_on != null && !Array.isArray(t.depends_on)) errores.push('DEPENDENCIAS_NO_LISTA');
  if (t.risk != null && !RIESGOS.includes(t.risk)) errores.push('RIESGO_DESCONOCIDO');
  return errores;
}

function validarPlan(plan) {
  const errores = [];
  if (!plan || !String(plan.objective || '').trim()) errores.push({ code: 'SIN_OBJETIVO' });
  const sprints = Array.isArray(plan && plan.sprints) ? plan.sprints : [];
  if (!sprints.length) errores.push({ code: 'SIN_SPRINTS' });
  const todas = [];
  sprints.forEach((s, i) => {
    if (!Array.isArray(s.tasks) || !s.tasks.length) errores.push({ code: 'SPRINT_VACIO', sprint: i + 1 });
    for (const t of s.tasks || []) {
      todas.push(t);
      for (const code of validarTarea(t)) errores.push({ code, task: t && t.id });
    }
  });
  const ids = new Set(todas.map((t) => t.id));
  const { validarGrafo } = require('./spec-manager.cjs');
  const grafo = validarGrafo(todas.map((t) => ({
    id: t.id,
    dep_ids: (t.depends_on || []).filter((d) => ids.has(d)),
    missing_deps: (t.depends_on || []).filter((d) => !ids.has(d)),
  })));
  return { ok: errores.length === 0, errores, grafo, tareas: todas };
}

// ─── sesión: activar / pausar / desactivar ───────────────────────────────────

function identificarProyecto(root) {
  for (const f of ['.agentic/config.md', 'package.json']) {
    const p = path.join(root, f);
    if (fs.existsSync(p)) return sha(path.resolve(root).toLowerCase()).slice(0, 16);
  }
  return null;
}

/**
 * `teams: activar` / `akdd teams init`. El esquema nuevo solo se aplica con
 * aprobación explícita, con respaldo y en una transacción. Activar no ejecuta
 * nada: no arranca una cola vacía.
 */
function init(root, opciones = {}) {
  const proyecto = identificarProyecto(root);
  if (!proyecto) return { status: 'PROYECTO_NO_IDENTIFICADO', detalle: 'falta .agentic/config.md o package.json' };
  if (!fs.existsSync(dbPath(root))) return { status: 'NOT_INITIALIZED', detalle: 'no hay memoria.db (akdd init primero)' };
  const existe = lectura(root, (db) => !!db);
  let migracion = null;
  if (!existe) {
    if (!opciones.aprobarMigracion) {
      return { status: 'MIGRACION_PENDIENTE', tablas: SCHEMA.length, comando: 'akdd teams init --aprobar-migracion', detalle: 'TEAMS añade tablas teams_* a memoria.db; se aplica con respaldo y solo si lo apruebas' };
    }
    const r = dba.migrate(dbPath(root), {
      statements: SCHEMA,
      run: (db) => db.run("INSERT OR REPLACE INTO teams_meta (key, value) VALUES ('schema_version', ?)", String(SCHEMA_VERSION)),
    });
    migracion = { status: r.status, respaldo: r.backupPath };
  }
  const roles = Object.assign({}, ROLES_DEFECTO, opciones.roles || {});
  for (const [rol, def] of Object.entries(roles)) {
    if (!def || !def.host) return { status: 'ROL_INVALIDO', rol };
  }
  if (roles.director.host === roles.builder.host && !opciones.mismoHost) {
    return { status: 'ROL_INVALIDO', detalle: 'director y constructor en el mismo host requiere --mismo-host' };
  }
  return tx(root, (db, despertar) => {
    const previa = sesion(db);
    const gen = (previa ? previa.session_generation : 0) + 1;
    /* El modelo exacto lo informa cada adapter al conectarse; aquí no se inventa. */
    const guardados = Object.fromEntries(Object.entries(roles).map(([r, d]) => [r, { host: d.host, model: d.model || null }]));
    db.run(`INSERT INTO teams_sessions (id, enabled, paused, session_generation, project_id, roles, updated_at) VALUES (1, 1, 0, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET enabled = 1, paused = 0, session_generation = excluded.session_generation,
      project_id = excluded.project_id, roles = excluded.roles, updated_at = excluded.updated_at`, gen, proyecto, js(guardados), ahoraIso());
    publicar(db, despertar, { kind: 'SESSION_ENABLED', producer: 'humano', target: 'director', payload: { gen, roles: guardados } });
    return { status: 'ACTIVO', session_generation: gen, roles: guardados, migracion, ejecutando: false };
  });
}

function pausar(root) {
  return tx(root, (db, despertar) => {
    db.run('UPDATE teams_sessions SET paused = 1, updated_at = ? WHERE id = 1', ahoraIso());
    publicar(db, despertar, { kind: 'PAUSED', producer: 'humano', target: 'builder' });
    const enCurso = db.all("SELECT id FROM teams_tasks WHERE state IN ('RUNNING','VERIFYING')").map((r) => r.id);
    return { status: 'PAUSADO', en_curso: enCurso, nota: 'no se asignan tareas nuevas; las en curso terminan o se aseguran' };
  });
}

/** `teams: continuar`: libera leases vencidos y devuelve a READY lo que quedó sin dueño válido. */
function continuar(root, { ahora = Date.now() } = {}) {
  return tx(root, (db, despertar) => {
    const s = sesion(db);
    if (!s || !s.enabled) return { status: 'DESACTIVADO' };
    db.run('UPDATE teams_sessions SET paused = 0, updated_at = ? WHERE id = 1', ahoraIso());
    const recuperadas = reclamarVencidos(db, ahora);
    recalcular(db);
    publicar(db, despertar, { kind: 'RESUMED', producer: 'humano', target: 'builder', payload: { recuperadas } });
    return { status: 'ACTIVO', recuperadas };
  });
}

/** `teams: desactivar`: detiene lo propio, conserva historial; persiste tras reinicio. */
function desactivar(root) {
  return tx(root, (db, despertar) => {
    db.run('UPDATE teams_sessions SET enabled = 0, paused = 0, updated_at = ? WHERE id = 1', ahoraIso());
    const liberados = db.all('SELECT resource FROM teams_leases').length;
    db.run('DELETE FROM teams_leases');
    db.run("UPDATE teams_delivery SET state = 'CANCELLED' WHERE state IN ('PENDING','SENT')");
    for (const t of db.all("SELECT id FROM teams_tasks WHERE state = 'RUNNING' OR (state = 'READY' AND owner_id IS NOT NULL)")) {
      transicionar(db, t.id, { a: 'READY', cambios: { owner_id: null } });
    }
    db.run("UPDATE teams_attempts SET state = 'CANCELLED', finished_at = ? WHERE state IN ('ASSIGNED','RUNNING')", ahoraIso());
    publicar(db, despertar, { kind: 'SESSION_DISABLED', producer: 'humano', target: 'builder' });
    return { status: 'DESACTIVADO', leases_liberados: liberados, historial: 'conservado' };
  });
}

/** Solo la base decide si TEAMS está activo; un MD en `.legion/` no cuenta. */
function activo(root) {
  return lectura(root, (db) => {
    const s = db && sesion(db);
    return !!(s && s.enabled);
  });
}

// ─── plan ────────────────────────────────────────────────────────────────────

function decidirEsfuerzo(root, t) {
  try {
    const router = require('./effort-router.cjs');
    return router.decidir({
      task_id: 'teams-' + t.id, intent: t.objective, paths: t.allowed_files, change_type: t.change_type,
      requested_tier: t.risk, contracts: t.contracts, origen: 'teams',
    }, { root });
  } catch (e) {
    return { tier: 'HIGH', risk: t.risk || 'HIGH', required_gates: ['scope', 'protected-files', 'security', 'leases', 'tdd', 'preservation', 'qa'], error: e.message };
  }
}

/** `teams: plan`. Un plan inválido no se guarda; dependencias rotas bloquean solo su rama. */
function crearPlan(root, plan) {
  const v = validarPlan(plan);
  if (v.errores.length) return { status: 'PLAN_INVALIDO', errores: v.errores };
  return tx(root, (db, despertar) => {
    const s = sesion(db);
    if (!s || !s.enabled) return { status: 'DESACTIVADO' };
    const planId = plan.id || ('P-' + Date.now().toString(36));
    if (db.get('SELECT id FROM teams_plans WHERE id = ?', planId)) return { status: 'PLAN_EXISTE', plan_id: planId };
    for (const t of v.tareas) {
      if (db.get('SELECT id FROM teams_tasks WHERE id = ?', t.id)) return { status: 'PLAN_INVALIDO', errores: [{ code: 'ID_DUPLICADO_EN_BASE', task: t.id }] };
    }
    const limites = Object.assign({}, LIMITES_DEFECTO, plan.limits || {});
    db.run('INSERT INTO teams_plans (id, objective, state, limits, created_at, updated_at) VALUES (?,?,?,?,?,?)',
      planId, plan.objective, 'ACTIVE', js(limites), ahoraIso(), ahoraIso());
    const malGrafo = new Map();
    for (const e of v.grafo) if (!malGrafo.has(e.task)) malGrafo.set(e.task, e.code);
    let orden = 0;
    plan.sprints.forEach((sp, i) => {
      const sprintId = sp.id || `${planId}-S${i + 1}`;
      db.run('INSERT INTO teams_sprints (id, plan_id, n, objective, state) VALUES (?,?,?,?,?)', sprintId, planId, i + 1, sp.objective || null, 'ACTIVE');
      for (const t of sp.tasks) {
        const decision = decidirEsfuerzo(root, t);
        const estado = malGrafo.has(t.id) ? 'BLOCKED_DEPENDENCY' : 'PENDING';
        db.run(`INSERT INTO teams_tasks (id, plan_id, sprint_id, objective, acceptance, depends_on, allowed_files, risk, effort_policy,
          state, priority, orden, blocked_reason, failed_hashes, evidence, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        t.id, planId, sprintId, t.objective, js(t.acceptance), js(t.depends_on || []), js(t.allowed_files), decision.risk || t.risk || 'MEDIUM',
        js({ tier: decision.tier, required_gates: decision.required_gates, required_roles: decision.required_roles, policy_version: decision.policy_version, policy_id: decision.policy_id || null, no_aplica: decision.no_aplica || [], origen: 'teams' }),
        estado, Number(t.priority) || 0, orden++, malGrafo.get(t.id) || null, '[]', '[]', ahoraIso(), ahoraIso());
      }
    });
    /* Lo que depende de un nodo roto tampoco arranca. */
    propagarBloqueoGrafo(db, planId);
    recalcular(db);
    publicar(db, despertar, { kind: 'PLAN_CREATED', producer: 'director', target: 'builder', payload: { plan_id: planId } });
    return { status: 'PLAN_GUARDADO', plan_id: planId, tareas: tareas(db, planId).map((t) => ({ id: t.id, state: t.state, tier: t.effort_policy.tier, blocked_reason: t.blocked_reason })) };
  });
}

function descendientes(db, ids) {
  const todas = tareas(db);
  const fuera = new Set(ids);
  let cambio = true;
  while (cambio) {
    cambio = false;
    for (const t of todas) {
      if (!fuera.has(t.id) && t.depends_on.some((d) => fuera.has(d))) { fuera.add(t.id); cambio = true; }
    }
  }
  return [...fuera];
}

function propagarBloqueoGrafo(db, planId) {
  const rotas = tareas(db, planId).filter((t) => t.state === 'BLOCKED_DEPENDENCY').map((t) => t.id);
  for (const id of descendientes(db, rotas)) {
    const t = tarea(db, id);
    if (t.state === 'PENDING') transicionar(db, id, { de: ['PENDING'], a: 'BLOCKED_DEPENDENCY', cambios: { blocked_reason: 'DEPENDE_DE_NODO_INVALIDO' } });
  }
}

/** PENDING con todas sus dependencias DONE_VERIFIED pasa a READY. Nada más promueve. */
function recalcular(db) {
  const todas = tareas(db);
  const porId = new Map(todas.map((t) => [t.id, t]));
  const promovidas = [];
  for (const t of todas) {
    if (t.state !== 'PENDING') continue;
    if (t.depends_on.every((d) => porId.get(d) && porId.get(d).state === 'DONE_VERIFIED')) {
      transicionar(db, t.id, { de: ['PENDING'], a: 'READY' });
      promovidas.push(t.id);
    }
  }
  return promovidas;
}

// ─── leases con fencing ──────────────────────────────────────────────────────

function siguienteFencing(db) {
  const r = db.get("SELECT value FROM teams_meta WHERE key = 'fencing'");
  const n = (r ? Number(r.value) : 0) + 1;
  db.run("INSERT OR REPLACE INTO teams_meta (key, value) VALUES ('fencing', ?)", String(n));
  return n;
}

function reclamarVencidos(db, ahora) {
  const vencidos = db.all('SELECT * FROM teams_leases WHERE expires_ms <= ?', ahora);
  const tareasAfectadas = [...new Set(vencidos.map((l) => l.task_id).filter(Boolean))];
  db.run('DELETE FROM teams_leases WHERE expires_ms <= ?', ahora);
  const recuperadas = [];
  for (const id of tareasAfectadas) {
    if (db.get('SELECT 1 FROM teams_leases WHERE task_id = ?', id)) continue;
    const t = tarea(db, id);
    /* Sin ACK o sin heartbeat: no se dio por iniciada; vuelve a la cola. VERIFYING no se toca. */
    if (t && (t.state === 'RUNNING' || (t.state === 'READY' && t.owner_id))) {
      transicionar(db, id, { a: 'READY', cambios: { owner_id: null } });
      db.run("UPDATE teams_attempts SET state = 'ABANDONED', finished_at = ? WHERE task_id = ? AND state IN ('ASSIGNED','RUNNING')", ahoraIso(), id);
      db.run("UPDATE teams_delivery SET state = 'EXPIRED' WHERE task_id = ? AND state IN ('PENDING','SENT')", id);
      recuperadas.push(id);
    }
  }
  return recuperadas;
}

function leaseValido(db, t, ownerId, fencing, ahora) {
  const ls = db.all('SELECT * FROM teams_leases WHERE task_id = ?', t.id);
  if (!ls.length) return 'SIN_LEASE';
  if (ls.some((l) => l.owner_id !== ownerId)) return 'LEASE_DE_OTRO';
  if (ls.some((l) => Number(l.fencing) !== Number(fencing))) return 'FENCING_OBSOLETO';
  if (ls.some((l) => l.expires_ms <= ahora)) return 'LEASE_VENCIDO';
  return null;
}

// ─── scheduler ───────────────────────────────────────────────────────────────

function stopGlobalAbierto(db) {
  return db.get("SELECT id FROM teams_decisions WHERE scope = 'GLOBAL' AND resolved_at IS NULL");
}

function recursosEnCuarentena(db) {
  return new Set(db.all("SELECT affected_resources FROM teams_decisions WHERE resolved_at IS NULL AND reason_code = 'RESTORE_FAILED'")
    .flatMap((r) => pj(r.affected_resources, [])).map(normalizarRecurso));
}

/**
 * Asigna la siguiente tarea READY al constructor `owner_id`: orden estable
 * (prioridad, luego orden del plan), salta lo que choca con leases ajenos y
 * nunca reintenta en bucle una misma tarea fallida.
 */
function asignar(root, { owner_id, rol = 'builder', ahora = Date.now() } = {}) {
  if (!owner_id) throw errorTeams('SIN_OWNER', 'asignar requiere owner_id');
  return tx(root, (db, despertar) => {
    const s = sesion(db);
    if (!s || !s.enabled) return { status: 'DESACTIVADO' };
    if (s.paused) return { status: 'PAUSADO' };
    if (stopGlobalAbierto(db)) return { status: 'STOP_GLOBAL' };
    reclamarVencidos(db, ahora);
    recalcular(db);
    const propia = db.get("SELECT id FROM teams_tasks WHERE owner_id = ? AND state IN ('READY','RUNNING','VERIFYING')", owner_id);
    if (propia) return { status: 'OCUPADO', task_id: propia.id };
    const cuarentena = recursosEnCuarentena(db);
    const candidatas = db.all("SELECT * FROM teams_tasks WHERE state = 'READY' AND owner_id IS NULL ORDER BY priority DESC, orden ASC").map(fila);
    for (const t of candidatas) {
      const recursos = t.allowed_files.map(normalizarRecurso);
      if (recursos.some((r) => cuarentena.has(r))) continue;
      const ocupados = recursos.filter((r) => db.get('SELECT 1 FROM teams_leases WHERE resource = ? AND owner_id != ?', r, owner_id));
      if (ocupados.length) continue;
      const planRow = db.get('SELECT limits FROM teams_plans WHERE id = ?', t.plan_id);
      const limites = Object.assign({}, LIMITES_DEFECTO, pj(planRow && planRow.limits, {}));
      const fencing = siguienteFencing(db);
      const vence = ahora + limites.ack_ms;
      for (const r of recursos) {
        db.run('INSERT OR REPLACE INTO teams_leases (resource, owner_id, task_id, fencing, expires_ms) VALUES (?,?,?,?,?)', r, owner_id, t.id, fencing, vence);
      }
      const asignada = transicionar(db, t.id, { de: ['READY'], a: 'READY', cambios: { owner_id } });
      const deliveryId = 'dl-' + crypto.randomUUID();
      const payload = {
        task: { id: t.id, objective: t.objective, acceptance: t.acceptance, allowed_files: t.allowed_files, depends_on: t.depends_on, risk: t.risk },
        effort_policy: t.effort_policy, revision: asignada.revision, fencing, delivery_id: deliveryId,
      };
      const ev = publicar(db, despertar, { kind: 'TASK_ASSIGNED', producer: 'director', target: rol, task_id: t.id, revision: asignada.revision, payload });
      db.run(`INSERT INTO teams_delivery (delivery_id, event_seq, task_id, target_role, owner_id, state, created_at) VALUES (?,?,?,?,?,?,?)`,
        deliveryId, ev.seq, t.id, rol, owner_id, 'PENDING', ahoraIso());
      db.run(`INSERT INTO teams_attempts (task_id, owner_id, fencing, delivery_id, state, started_at) VALUES (?,?,?,?,?,?)`,
        t.id, owner_id, fencing, deliveryId, 'ASSIGNED', ahoraIso());
      return { status: 'ASIGNADA', assignment: payload, event_seq: ev.seq };
    }
    return { status: 'SIN_TRABAJO' };
  });
}

/** ACK del constructor. Solo con ACK la tarea pasa a RUNNING y el lease toma su duración real. */
function ack(root, { delivery_id, owner_id, host_session_id = null, ahora = Date.now() }) {
  return tx(root, (db, despertar) => {
    const d = db.get('SELECT * FROM teams_delivery WHERE delivery_id = ?', delivery_id);
    if (!d) return { status: 'ENTREGA_DESCONOCIDA' };
    if (d.owner_id !== owner_id) return { status: 'ENTREGA_DE_OTRO' };
    if (d.state === 'ACKED') return { status: 'ACKED', duplicado: true };
    if (d.state !== 'PENDING' && d.state !== 'SENT') return { status: 'ENTREGA_' + d.state };
    const t = tarea(db, d.task_id);
    const planRow = db.get('SELECT limits FROM teams_plans WHERE id = ?', t.plan_id);
    const limites = Object.assign({}, LIMITES_DEFECTO, pj(planRow && planRow.limits, {}));
    db.run("UPDATE teams_delivery SET state = 'ACKED', ack_at = ?, host_session_id = ? WHERE delivery_id = ?", ahoraIso(), host_session_id, delivery_id);
    db.run('UPDATE teams_leases SET expires_ms = ? WHERE task_id = ? AND owner_id = ?', ahora + limites.lease_ms, d.task_id, owner_id);
    db.run("UPDATE teams_attempts SET state = 'RUNNING' WHERE delivery_id = ?", delivery_id);
    const r = transicionar(db, d.task_id, { de: ['READY'], a: 'RUNNING' });
    publicar(db, despertar, { kind: 'TASK_ACKED', producer: 'builder', target: 'director', task_id: d.task_id, revision: r.revision, payload: { delivery_id, host_session_id } });
    return { status: 'ACKED', task_id: d.task_id, revision: r.revision };
  });
}

function heartbeat(root, { task_id, owner_id, fencing, ahora = Date.now() }) {
  return tx(root, (db) => {
    const t = tarea(db, task_id);
    const err = t && leaseValido(db, t, owner_id, fencing, ahora);
    if (!t || err) return { status: err || 'TAREA_DESCONOCIDA' };
    const planRow = db.get('SELECT limits FROM teams_plans WHERE id = ?', t.plan_id);
    const limites = Object.assign({}, LIMITES_DEFECTO, pj(planRow && planRow.limits, {}));
    db.run('UPDATE teams_leases SET expires_ms = ? WHERE task_id = ?', ahora + limites.lease_ms, task_id);
    return { status: 'OK' };
  });
}

/**
 * El constructor entrega resultado (hash del sujeto + archivos tocados). No
 * puede declarar DONE: la tarea pasa a VERIFYING. Un event_id repetido
 * devuelve el mismo desenlace sin otra transición.
 */
function entregarResultado(root, r, { ahora = Date.now() } = {}) {
  return tx(root, (db, despertar) => {
    if (!r || !r.event_id) return { status: 'SIN_EVENT_ID' };
    const previo = db.get('SELECT payload FROM teams_events WHERE event_id = ?', r.event_id);
    if (previo) return Object.assign({ duplicado: true }, pj(previo.payload, {}).desenlace || { status: 'DUPLICADO' });
    const t = tarea(db, r.task_id);
    if (!t) return { status: 'TAREA_DESCONOCIDA' };
    if (t.state !== 'RUNNING') return registrarDesenlace(db, despertar, r, t, { status: 'TRANSICION_INVALIDA', estado: t.state });
    if (r.expected_revision != null && r.expected_revision !== t.revision) {
      return registrarDesenlace(db, despertar, r, t, { status: 'REVISION_OBSOLETA', actual: t.revision });
    }
    const lease = leaseValido(db, t, r.owner_id, r.fencing, ahora);
    if (lease) return registrarDesenlace(db, despertar, r, t, { status: 'RECHAZADO_' + lease });
    if (!r.subject_hash) return registrarDesenlace(db, despertar, r, t, { status: 'SIN_SUJETO' });
    const permitidos = new Set(t.allowed_files.map(normalizarRecurso));
    const fuera = (r.files || []).map(normalizarRecurso).filter((f) => !permitidos.has(f));
    if (fuera.length) {
      const stop = abrirStop(db, despertar, {
        reason_code: 'ESCRITURA_FUERA_DE_ALCANCE', scope: 'GLOBAL', task_id: t.id, resources: fuera,
        evidence: [{ kind: 'diff', files: fuera, subject_hash: r.subject_hash }], decision_required: true,
        question: `La tarea ${t.id} escribió fuera de su alcance (${fuera.join(', ')}). ¿Revertir o ampliar alcance?`,
      });
      return registrarDesenlace(db, despertar, r, t, { status: 'STOP_GLOBAL', stop_id: stop.id, fuera });
    }
    if (t.failed_hashes.includes(r.subject_hash)) {
      return registrarDesenlace(db, despertar, r, t, fallo(db, despertar, t, 'MISMO_CODIGO_REINTENTADO', r.subject_hash));
    }
    db.run("UPDATE teams_attempts SET state = 'DELIVERED', subject_hash = ?, result = ? WHERE task_id = ? AND fencing = ? AND state = 'RUNNING'",
      r.subject_hash, js({ files: r.files || [], evidence: r.evidence || [] }), t.id, r.fencing);
    const v = transicionar(db, t.id, { de: ['RUNNING'], a: 'VERIFYING', cambios: { subject_hash: r.subject_hash } });
    return registrarDesenlace(db, despertar, r, v, { status: 'VERIFICANDO', revision: v.revision });
  });
}

function registrarDesenlace(db, despertar, r, t, desenlace) {
  publicar(db, despertar, {
    event_id: r.event_id, kind: 'TASK_RESULT', producer: 'builder', target: 'director', task_id: t.id, revision: t.revision,
    payload: { subject_hash: r.subject_hash || null, files: r.files || [], desenlace },
  });
  return desenlace;
}

/** Gates que la tarea necesita para cerrar (según el router), quitando los que TEAMS impone solo. */
function gatesRequeridos(t) {
  return (t.effort_policy.required_gates || []).filter((g) => !GATES_PROPIOS.has(g));
}

/**
 * Cierre por el controlador. DONE_VERIFIED exige un gate-result PASS con
 * evidencia del sujeto exacto para cada gate requerido. Un FAIL cuenta como
 * reparación; agotar el límite bloquea esa tarea, no el plan.
 */
function verificar(root, { task_id, expected_revision, event_id, gates = [] }) {
  return tx(root, (db, despertar) => {
    if (event_id) {
      const previo = db.get('SELECT payload FROM teams_events WHERE event_id = ?', event_id);
      if (previo) return Object.assign({ duplicado: true }, pj(previo.payload, {}).desenlace || {});
    }
    const t = tarea(db, task_id);
    if (!t) return { status: 'TAREA_DESCONOCIDA' };
    const cerrar = (desenlace) => {
      publicar(db, despertar, { event_id, kind: 'TASK_VERIFIED_RESULT', producer: 'director', target: 'builder', task_id, revision: t.revision, payload: { desenlace } });
      return desenlace;
    };
    if (t.state !== 'VERIFYING') return cerrar({ status: 'TRANSICION_INVALIDA', estado: t.state });
    if (expected_revision != null && expected_revision !== t.revision) return cerrar({ status: 'REVISION_OBSOLETA', actual: t.revision });
    const porGate = new Map(gates.map((g) => [g.gate, g]));
    const testGate = gates.find(g => ['tdd','tests'].includes(g.gate));
    if (testGate) for (const name of ['relevant-check','affected-tests','full-suite','tests']) if (!porGate.has(name)) porGate.set(name,testGate);
    const fallidos = gates.filter((g) => g.status === 'FAIL' && (!g.subject_hash || g.subject_hash === t.subject_hash));
    const protegido = fallidos.find((g) => ['preservation', 'blast-radius', 'protected-files'].includes(g.gate)
      && /PROTECTED|CRITICAL/i.test(String(g.reason_code || '')));
    if (protegido) {
      db.run('DELETE FROM teams_leases WHERE task_id = ?', task_id);
      transicionar(db, task_id, { de: ['VERIFYING'], a: 'BLOCKED_TECHNICAL', cambios: { owner_id: null, blocked_reason: 'PROTECTED_ROTO' } });
      const s = abrirStop(db, despertar, {
        reason_code: 'PROTECTED_ROTO', scope: protegido.scope === 'GLOBAL' ? 'GLOBAL' : 'DEPENDENCY_CHAIN', task_id, resources: t.allowed_files,
        decision_required: true, evidence: [{ kind: 'gate', gate: protegido.gate, reason_code: protegido.reason_code, subject_hash: t.subject_hash }],
        question: `${task_id} rompe un contrato protegido (${protegido.reason_code}). ¿Revertir al punto de restauración o rehacer el alcance?`,
      });
      return cerrar({ status: 'STOP', motivo: 'PROTECTED_ROTO', stop_id: s.id, afectadas: s.afectadas });
    }
    if (fallidos.length) {
      return cerrar(fallo(db, despertar, t, 'GATE_FAIL:' + fallidos.map((g) => g.gate).join(','), t.subject_hash));
    }
    const faltan = gatesRequeridos(t).filter((g) => {
      const r = porGate.get(g);
      const politicaDistinta = r && r.policy_id && t.effort_policy.policy_id && r.policy_id !== t.effort_policy.policy_id;
      return !r || r.subject_hash !== t.subject_hash || politicaDistinta || !allowsVerifiedClose(r, { root, paths: t.allowed_files, gate: g });
    });
    if (faltan.length) return cerrar({ status: 'SIN_EVIDENCIA_SUFICIENTE', faltan, estado: 'VERIFYING' });
    const evidencia = gatesRequeridos(t).map((g) => ({ gate: g, subject_hash: t.subject_hash, execution_id: porGate.get(g).execution_id || null }));
    const v = transicionar(db, task_id, { de: ['VERIFYING'], a: 'DONE_VERIFIED', cambios: { evidence: evidencia } });
    db.run('DELETE FROM teams_leases WHERE task_id = ?', task_id);
    db.run("UPDATE teams_attempts SET state = 'VERIFIED', finished_at = ? WHERE task_id = ? AND state = 'DELIVERED'", ahoraIso(), task_id);
    const liberadas = recalcular(db);
    return cerrar({ status: 'DONE_VERIFIED', revision: v.revision, liberadas });
  });
}

function fallo(db, despertar, t, motivo, subjectHash) {
  const planRow = db.get('SELECT limits FROM teams_plans WHERE id = ?', t.plan_id);
  const limites = Object.assign({}, LIMITES_DEFECTO, pj(planRow && planRow.limits, {}));
  const hashes = [...new Set([...t.failed_hashes, subjectHash].filter(Boolean))];
  const reparaciones = t.repairs + 1;
  db.run('DELETE FROM teams_leases WHERE task_id = ?', t.id);
  db.run("UPDATE teams_attempts SET state = 'FAILED', finished_at = ? WHERE task_id = ? AND state IN ('RUNNING','DELIVERED')", ahoraIso(), t.id);
  if (reparaciones >= limites.reparaciones) {
    transicionar(db, t.id, { a: 'BLOCKED_TECHNICAL', cambios: { owner_id: null, repairs: reparaciones, failed_hashes: hashes, blocked_reason: 'LIMITE_REPARACIONES:' + motivo } });
    const stop = abrirStop(db, despertar, {
      reason_code: 'LIMITE_REPARACIONES', scope: 'DEPENDENCY_CHAIN', task_id: t.id, decision_required: false,
      evidence: [{ kind: 'fallos', motivo, reparaciones, subject_hash: subjectHash }],
      question: `${t.id} agotó ${reparaciones} reparaciones (${motivo}). Necesita replanificar o revisión.`,
    });
    return { status: 'BLOCKED_TECHNICAL', motivo, reparaciones, stop_id: stop.id };
  }
  transicionar(db, t.id, { a: 'READY', cambios: { owner_id: null, repairs: reparaciones, failed_hashes: hashes } });
  return { status: 'REPARAR', motivo, reparaciones, quedan: limites.reparaciones - reparaciones };
}

// ─── STOP por alcance y decisiones humanas ───────────────────────────────────

function abrirStop(db, despertar, o) {
  if (!ALCANCES.includes(o.scope)) throw errorTeams('ALCANCE_DESCONOCIDO', String(o.scope));
  const id = o.id || ('Q-' + crypto.randomUUID().slice(0, 8));
  let afectadas = [];
  if (o.scope === 'GLOBAL') afectadas = tareas(db).filter((t) => !FINALES.has(t.state)).map((t) => t.id);
  else if (o.scope === 'TASK' || o.scope === 'DEPENDENCY_CHAIN') afectadas = o.task_id ? descendientes(db, [o.task_id]) : [];
  afectadas = afectadas.filter((x) => !FINALES.has(tarea(db, x).state));
  const estadoBloqueo = o.decision_required ? 'BLOCKED_HUMAN' : 'BLOCKED_TECHNICAL';
  for (const x of afectadas) {
    const t = tarea(db, x);
    const stops = (t.stop && t.stop.ids) || [];
    const previo = (t.stop && t.stop.previo) || t.state;
    db.run('DELETE FROM teams_leases WHERE task_id = ?', x);
    db.run("UPDATE teams_attempts SET state = 'CANCELLED', finished_at = ? WHERE task_id = ? AND state IN ('ASSIGNED','RUNNING')", ahoraIso(), x);
    if (t.state === 'BLOCKED_TECHNICAL' && x === o.task_id && !o.decision_required) {
      db.run('UPDATE teams_tasks SET stop = ? WHERE id = ?', js({ ids: [...stops, id], previo: 'PENDING' }), x);
      continue;
    }
    transicionar(db, x, { a: x === o.task_id || o.scope === 'GLOBAL' ? estadoBloqueo : 'BLOCKED_DEPENDENCY',
      cambios: { owner_id: null, stop: { ids: [...stops, id], previo: previo === 'VERIFYING' ? 'VERIFYING' : 'PENDING' }, blocked_reason: o.reason_code } });
  }
  const seguras = tareas(db).filter((t) => t.state === 'READY' && !afectadas.includes(t.id)).map((t) => t.id);
  db.run(`INSERT INTO teams_decisions (id, reason_code, scope, affected_tasks, affected_resources, evidence, decision_required, question,
    safe_independent_tasks, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`, id, o.reason_code, o.scope, js(afectadas), js(o.resources || []),
  js(o.evidence || []), o.decision_required ? 1 : 0, o.question || null, js(seguras), ahoraIso());
  publicar(db, despertar, { kind: o.scope === 'GLOBAL' ? 'INCIDENT' : 'STOP', producer: 'teams', target: 'director', task_id: o.task_id || null,
    payload: { id, reason_code: o.reason_code, scope: o.scope, afectadas } });
  return { id, afectadas, seguras };
}

function stop(root, o) {
  return tx(root, (db, despertar) => {
    if (o.task_id && !tarea(db, o.task_id)) return { status: 'TAREA_DESCONOCIDA' };
    return Object.assign({ status: 'STOP' }, abrirStop(db, despertar, o));
  });
}

function pendientes(root) {
  return lectura(root, (db) => {
    if (!db) return [];
    return db.all('SELECT * FROM teams_decisions WHERE resolved_at IS NULL ORDER BY created_at').map((d) => ({
      id: d.id, reason_code: d.reason_code, scope: d.scope, question: d.question, decision_required: !!d.decision_required,
      affected_tasks: pj(d.affected_tasks, []), affected_resources: pj(d.affected_resources, []),
      safe_independent_tasks: pj(d.safe_independent_tasks, []), created_at: d.created_at,
    }));
  });
}

const archivoOrigen = (root) => path.join(dirTeams(root), 'origen-humano.jsonl');
const hashDecision = (pendingId, decision) => sha(String(pendingId) + '\n' + String(decision).trim().toLowerCase());

/**
 * Lo llama el hook de prompt del host con el texto que escribió la persona:
 * es la prueba de origen humano de `teams: resolver`. El modelo no pasa por aquí.
 */
function registrarOrigenHumano(root, { pending_id, decision, host }) {
  fs.mkdirSync(dirTeams(root), { recursive: true });
  fs.appendFileSync(archivoOrigen(root), JSON.stringify({ pending_id, hash: hashDecision(pending_id, decision), host, at: Date.now() }) + '\n');
}

function consumirOrigenHumano(root, pendingId, decision, ahora) {
  const f = archivoOrigen(root);
  let lineas = [];
  try { lineas = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch { return null; }
  const h = hashDecision(pendingId, decision);
  const entradas = lineas.map((l) => pj(l, null)).filter(Boolean);
  const idx = entradas.findIndex((e) => e.pending_id === pendingId && e.hash === h && ahora - e.at <= ORIGEN_HOOK_TTL_MS);
  if (idx < 0) return null;
  const encontrada = entradas[idx];
  const restantes = entradas.filter((e, i) => i !== idx && ahora - e.at <= ORIGEN_HOOK_TTL_MS);
  escribirAtomico(f, restantes.map((e) => JSON.stringify(e)).join('\n') + (restantes.length ? '\n' : ''));
  return encontrada;
}

/**
 * `teams: resolver <id> <decisión>`. Solo con origen humano probado: una
 * terminal interactiva o el hook de prompt del host que vio el mensaje de la
 * persona. Documentos, memoria, mensajes externos o el paso del tiempo no
 * aprueban nada.
 */
function resolver(root, { pending_id, decision, decided_by = 'humano', origen, ahora = Date.now() }) {
  if (!String(decision || '').trim()) return { status: 'SIN_DECISION' };
  let prueba = null;
  if (origen === 'cli-tty') prueba = { tipo: 'cli-tty' };
  else if (origen === 'hook-prompt') {
    const e = consumirOrigenHumano(root, pending_id, decision, ahora);
    if (e) prueba = { tipo: 'hook-prompt', host: e.host };
  }
  if (!prueba) return { status: 'ORIGEN_NO_VERIFICADO', detalle: 'la decisión debe venir de la persona: escríbela en el chat como "teams: resolver <id> <decisión>" con los hooks del host instalados, o corre akdd teams resolve en una terminal' };
  return tx(root, (db, despertar) => {
    const d = db.get('SELECT * FROM teams_decisions WHERE id = ?', pending_id);
    if (!d) return { status: 'PENDIENTE_DESCONOCIDO' };
    if (d.resolved_at) return { status: 'YA_RESUELTO', decision: d.decision };
    db.run('UPDATE teams_decisions SET decision = ?, decided_by = ?, origin = ?, resolved_at = ? WHERE id = ?',
      String(decision).trim(), decided_by, prueba.tipo + (prueba.host ? ':' + prueba.host : ''), ahoraIso(), pending_id);
    const liberadas = [];
    for (const x of pj(d.affected_tasks, [])) {
      const t = tarea(db, x);
      if (!t || !t.stop) continue;
      const quedan = (t.stop.ids || []).filter((s) => s !== pending_id);
      if (quedan.length) { db.run('UPDATE teams_tasks SET stop = ? WHERE id = ?', js({ ids: quedan, previo: t.stop.previo }), x); continue; }
      /* Revalidar: vuelve a PENDING y solo pasa a READY si sus dependencias están verificadas. */
      transicionar(db, x, { a: t.stop.previo === 'VERIFYING' ? 'VERIFYING' : 'PENDING', cambios: { stop: null, blocked_reason: null } });
      liberadas.push(x);
    }
    const listas = recalcular(db);
    publicar(db, despertar, { kind: 'DECISION_RESOLVED', producer: 'humano', target: 'director', payload: { pending_id, decision: String(decision).trim(), liberadas } });
    return { status: 'RESUELTO', liberadas, listas };
  });
}

/** Restauración fallida (carpeta 05): la tarea queda bloqueada y sus archivos en cuarentena. */
function restauracionFallida(root, { task_id, files = [], detalle }) {
  return stop(root, {
    reason_code: 'RESTORE_FAILED', scope: 'TASK', task_id, resources: files, decision_required: true,
    evidence: [{ kind: 'restore', detalle: detalle || null }],
    question: `La restauración de ${task_id} falló; el estado de ${files.join(', ') || 'sus archivos'} es desconocido. ¿Cómo seguir?`,
  });
}

function enlazarPunto(root, { task_id, point_id }) {
  return tx(root, (db) => {
    if (!tarea(db, task_id)) return { status: 'TAREA_DESCONOCIDA' };
    db.run('UPDATE teams_tasks SET restore_point_id = ? WHERE id = ?', point_id, task_id);
    return { status: 'OK' };
  });
}

/** Rollback de la tarea: queda REVERTED (no implementada) y su rama no avanza. */
function marcarRevertida(root, { task_id, point_id, motivo }) {
  return tx(root, (db, despertar) => {
    const t = tarea(db, task_id);
    if (!t) return { status: 'TAREA_DESCONOCIDA' };
    db.run('DELETE FROM teams_leases WHERE task_id = ?', task_id);
    db.run("UPDATE teams_attempts SET state = 'REVERTED', finished_at = ? WHERE task_id = ? AND state IN ('ASSIGNED','RUNNING','DELIVERED','FAILED')", ahoraIso(), task_id);
    const r = transicionar(db, task_id, { a: 'REVERTED', cambios: { owner_id: null, restore_point_id: point_id || t.restore_point_id, blocked_reason: motivo || 'REVERTIDA' } });
    publicar(db, despertar, { kind: 'INCIDENT', producer: 'teams', target: 'director', task_id, revision: r.revision, payload: { tipo: 'TASK_REVERTED', point_id, motivo } });
    return { status: 'REVERTED', revision: r.revision };
  });
}

/** Otro intento desde el punto sano, dentro del presupuesto de reparaciones. */
function reintentar(root, { task_id }) {
  return tx(root, (db, despertar) => {
    const t = tarea(db, task_id);
    if (!t) return { status: 'TAREA_DESCONOCIDA' };
    if (t.state !== 'REVERTED') return { status: 'TRANSICION_INVALIDA', estado: t.state };
    const planRow = db.get('SELECT limits FROM teams_plans WHERE id = ?', t.plan_id);
    const limites = Object.assign({}, LIMITES_DEFECTO, pj(planRow && planRow.limits, {}));
    if (t.repairs >= limites.reparaciones) return { status: 'SIN_PRESUPUESTO', reparaciones: t.repairs };
    transicionar(db, task_id, { de: ['REVERTED'], a: 'PENDING', cambios: { blocked_reason: null } });
    const listas = recalcular(db);
    publicar(db, despertar, { kind: 'TASK_RETRY', producer: 'director', target: 'builder', task_id });
    return { status: 'OK', listas };
  });
}

/**
 * Una restauración devolvió estos archivos a un estado anterior: lo verificado
 * que dependía de ellos ya no está en disco y deja de contar como DONE.
 */
function invalidarPorRestore(root, { files, point_id }) {
  const tocados = new Set((files || []).map(normalizarRecurso));
  return tx(root, (db, despertar) => {
    const afectadas = tareas(db).filter((t) => t.state === 'DONE_VERIFIED' && t.allowed_files.some((f) => tocados.has(normalizarRecurso(f))));
    for (const t of afectadas) {
      transicionar(db, t.id, { de: ['DONE_VERIFIED'], a: 'REVERTED', cambios: { blocked_reason: 'CODIGO_RESTAURADO:' + point_id } });
      publicar(db, despertar, { kind: 'INCIDENT', producer: 'teams', target: 'director', task_id: t.id, payload: { tipo: 'TASK_STALE_BY_RESTORE', point_id } });
    }
    return afectadas.map((t) => t.id);
  });
}

// ─── estado, delta y vistas ──────────────────────────────────────────────────

function estado(root) {
  return lectura(root, (db) => {
    if (!db) return { inicializado: false, enabled: false };
    const s = sesion(db) || { enabled: false };
    const ts = tareas(db);
    const conteo = Object.fromEntries(ESTADOS.map((e) => [e, 0]));
    for (const t of ts) conteo[t.state] = (conteo[t.state] || 0) + 1;
    const plan = db.get("SELECT id, objective, state FROM teams_plans ORDER BY created_at DESC LIMIT 1");
    const ultimo = db.get('SELECT MAX(seq) AS seq FROM teams_events');
    return {
      inicializado: true, enabled: s.enabled, paused: !!s.paused, session_generation: s.session_generation || 0, roles: s.roles || {},
      plan: plan || null, conteo,
      tareas: ts.map((t) => ({ id: t.id, sprint_id: t.sprint_id, state: t.state, owner_id: t.owner_id, tier: t.effort_policy.tier, risk: t.risk, depends_on: t.depends_on, blocked_reason: t.blocked_reason })),
      leases: db.all('SELECT resource, owner_id, task_id, fencing, expires_ms FROM teams_leases'),
      pendientes: db.all('SELECT id, scope, reason_code FROM teams_decisions WHERE resolved_at IS NULL'),
      ultimo_seq: (ultimo && ultimo.seq) || 0,
    };
  });
}

/**
 * Tareas RUNNING con su último latido real. El latido sale del lease: ack y
 * heartbeat lo renuevan a ahora + lease_ms. Nada de mtime de archivos.
 */
function actividadConstructor(root) {
  return lectura(root, (db) => {
    if (!db) return [];
    return tareas(db).filter((t) => t.state === 'RUNNING').map((t) => {
      const planRow = db.get('SELECT limits FROM teams_plans WHERE id = ?', t.plan_id);
      const leaseMs = Object.assign({}, LIMITES_DEFECTO, pj(planRow && planRow.limits, {})).lease_ms;
      const l = db.get('SELECT MAX(expires_ms) AS e, MAX(fencing) AS f FROM teams_leases WHERE task_id = ?', t.id);
      return { task_id: t.id, owner_id: t.owner_id, tier: t.effort_policy.tier || 'MEDIUM', fencing: l && l.f, lease_ms: leaseMs, ultimo_latido_ms: l && l.e ? l.e - leaseMs : null };
    });
  });
}

function leerTarea(root, id) {
  return lectura(root, (db) => (db ? tarea(db, id) : null));
}

/** Lo que un rol necesita para retomar: eventos dirigidos a él desde su último ACK, sin los propios. */
function delta(root, { rol, desde = null, limite = 200 }) {
  return lectura(root, (db) => {
    if (!db) return { eventos: [], last_ack_seq: 0 };
    const ack = db.get('SELECT last_ack_seq FROM teams_acks WHERE role = ?', rol);
    const base = desde != null ? desde : (ack ? ack.last_ack_seq : 0);
    const eventos = db.all('SELECT * FROM teams_events WHERE seq > ? AND target_role = ? AND producer_role != ? ORDER BY seq LIMIT ?', base, rol, rol, limite)
      .map((e) => ({ seq: e.seq, event_id: e.event_id, kind: e.kind, task_id: e.task_id, revision: e.revision, payload: pj(e.payload, {}) }));
    return { eventos, last_ack_seq: base };
  });
}

function ackSeq(root, { rol, seq }) {
  return tx(root, (db) => {
    const r = db.get('SELECT last_ack_seq FROM teams_acks WHERE role = ?', rol);
    const nuevo = Math.max(r ? r.last_ack_seq : 0, Number(seq) || 0);
    db.run('INSERT INTO teams_acks (role, last_ack_seq) VALUES (?, ?) ON CONFLICT(role) DO UPDATE SET last_ack_seq = excluded.last_ack_seq', rol, nuevo);
    return { rol, last_ack_seq: nuevo };
  });
}

const MARCA_HUMANA_INICIO = '<!-- akdd:humano:inicio — lo que escribas aquí se conserva al regenerar -->';
const MARCA_HUMANA_FIN = '<!-- akdd:humano:fin -->';

/** Lo que la persona escribió entre las marcas: se conserva tal cual al regenerar. */
function seccionHumana(archivo) {
  let txt = '';
  try { txt = fs.readFileSync(archivo, 'utf8'); } catch { return ''; }
  const i = txt.indexOf(MARCA_HUMANA_INICIO);
  const j = txt.indexOf(MARCA_HUMANA_FIN);
  if (i < 0 || j < i) return '';
  return txt.slice(i + MARCA_HUMANA_INICIO.length, j).replace(/^\r?\n/, '').replace(/\r?\n$/, '');
}

/** Regenera `.legion/CONTINUIDAD.md` y `.legion/AUDITORIA-CURSOR.md`: un solo escritor, escritura atómica. */
function regenerarVistas(root) {
  const e = estado(root);
  if (!e.inicializado) return { status: 'SIN_TEAMS' };
  const ps = pendientes(root);
  const aviso = '<!-- Vista generada por akdd teams. No editar: se reescribe. Las órdenes van por `teams:` o `akdd teams`. -->\n';
  const lista = (arr) => (arr.length ? arr.map((x) => '- ' + x).join('\n') : '- (ninguna)');
  const por = (st) => e.tareas.filter((t) => st.includes(t.state));
  const continuidad = aviso + `# Continuidad — foto del momento\n\n**TEAMS:** ${e.enabled ? (e.paused ? 'activo, en pausa' : 'activo') : 'desactivado'} · sesión ${e.session_generation}\n`
    + `**Roles:** ${Object.entries(e.roles).map(([r, d]) => `${r} = ${d.host}${d.model ? ' (' + d.model + ')' : ''}`).join(' · ') || '(sin roles)'}\n`
    + `**Plan:** ${e.plan ? e.plan.id + ' — ' + e.plan.objective : '(sin plan)'}\n\n`
    + `## Cerrado y verificado\n${lista(por(['DONE_VERIFIED']).map((t) => t.id))}\n\n`
    + `## Corriendo ahora\n${lista(por(['RUNNING', 'VERIFYING']).map((t) => `${t.id} (${t.state}, ${t.owner_id || 'sin dueño'})`))}\n\n`
    + `## Preguntas sin responder\n${lista(ps.map((p) => `${p.id} [${p.scope}] ${p.question || p.reason_code} → bloquea ${p.affected_tasks.join(', ') || 'nada'}`))}\n\n`
    + `## Pendiente, sin arrancar\n${lista(por(['PENDING', 'READY']).map((t) => t.id))}\n\n`
    + `## Bloqueado o revertido\n${lista(por(['BLOCKED_HUMAN', 'BLOCKED_DEPENDENCY', 'BLOCKED_TECHNICAL', 'REVERTED']).map((t) => `${t.id} (${t.state}: ${t.blocked_reason || ''})`))}\n\n`
    + `## Última actualización\n${ahoraIso()} (reloj del sistema, evento ${e.ultimo_seq})\n`;
  const fCanal = path.join(root, '.legion', 'AUDITORIA-CURSOR.md');
  const humano = seccionHumana(fCanal);
  /* Envoltorios por rol: cada sesión lee los suyos desde el canal sin que nadie se los pegue. */
  const envoltorios = (rol) => {
    const evs = delta(root, { rol, limite: 50 }).eventos;
    if (!evs.length) return '- (nada nuevo)\n';
    return evs.map((ev) => '```\n<<<AKDD-TEAMS v1\n' + JSON.stringify({ kind: 'EVENT', rol, seq: ev.seq, event_kind: ev.kind, task_id: ev.task_id, revision: ev.revision, payload: ev.payload })
      + '\nAKDD-TEAMS>>>\n```').join('\n') + '\n';
  };
  const auditoria = aviso + `# Canal TEAMS — vista\n\nLa cola real vive en la base. Para responder desde fuera, pega un bloque:\n\n`
    + '```\n<<<AKDD-TEAMS v1\n{"kind":"RESULT","task_id":"...","event_id":"...","owner_id":"...","fencing":0,"subject_hash":"...","files":[]}\nAKDD-TEAMS>>>\n```\n\n'
    + `## Tareas para el constructor\n${lista(por(['READY']).map((t) => `${t.id} [${t.tier}]`))}\n\n`
    + `## En verificación del director\n${lista(por(['VERIFYING']).map((t) => t.id))}\n\n`
    + `## Entregas para el constructor (envoltorio)\n${envoltorios('builder')}\n`
    + `## Entregas para el director (envoltorio)\n${envoltorios('director')}\n`
    + `## Notas de la persona\n${MARCA_HUMANA_INICIO}\n${humano}\n${MARCA_HUMANA_FIN}\n`;
  escribirAtomico(path.join(root, '.legion', 'CONTINUIDAD.md'), continuidad);
  escribirAtomico(fCanal, auditoria);
  return { status: 'OK', archivos: ['.legion/CONTINUIDAD.md', '.legion/AUDITORIA-CURSOR.md'] };
}

const BLOQUE = /<<<AKDD-TEAMS v1\r?\n([\s\S]*?)\r?\nAKDD-TEAMS>>>/g;

/**
 * Importa respuestas de un adapter sin transporte directo. Solo cuenta lo que
 * va dentro de bloques delimitados y valida contra schema; el texto de
 * alrededor nunca se interpreta como orden.
 */
function importarRespuesta(root, texto) {
  const resultados = [];
  for (const m of String(texto || '').matchAll(BLOQUE)) {
    const msg = pj(m[1], null);
    if (!msg || typeof msg !== 'object') { resultados.push({ status: 'BLOQUE_ILEGIBLE' }); continue; }
    if (msg.kind === 'ACK') resultados.push(ack(root, msg));
    else if (msg.kind === 'RESULT') resultados.push(entregarResultado(root, msg));
    else resultados.push({ status: 'TIPO_NO_PERMITIDO', kind: msg.kind });
  }
  return resultados;
}

// ─── intención del chat ──────────────────────────────────────────────────────

const ACCIONES = {
  activar: 'init', plan: 'plan', ejecutar: 'run', estado: 'status', pausa: 'pause', pausar: 'pause',
  continuar: 'resume', desactivar: 'disable', pendientes: 'pending', resolver: 'resolve',
};

/** `teams: <acción> [args]` escrito por la persona. Fuera del inicio del mensaje no es una orden. */
function parsearIntencion(texto) {
  const m = /^\s*teams:\s*([a-záéíóú]+)\b\s*([\s\S]*)$/i.exec(String(texto || ''));
  if (!m) return null;
  const accion = ACCIONES[m[1].toLowerCase()];
  if (!accion) return { accion: null, desconocida: m[1] };
  const resto = m[2].trim();
  if (accion === 'resolve') {
    const r = /^(\S+)\s+([\s\S]+)$/.exec(resto);
    return r ? { accion, pending_id: r[1], decision: r[2].trim() } : { accion, error: 'uso: teams: resolver <id> <decisión>' };
  }
  return { accion, argumento: resto || null };
}

/**
 * Entrada única para chat, CLI y MCP: misma acción → misma función → mismo estado.
 * `origen` de resolve lo fija quien llama (terminal interactiva o rastro del hook).
 */
function ejecutarAccion(root, accion, a = {}) {
  switch (accion) {
    case 'init': return init(root, { aprobarMigracion: !!a.aprobar_migracion, roles: a.roles, mismoHost: !!a.mismo_host });
    case 'plan': {
      const plan = a.plan || (a.archivo ? JSON.parse(fs.readFileSync(path.resolve(root, a.archivo), 'utf8')) : { objective: a.objetivo, sprints: [] });
      return crearPlan(root, plan);
    }
    case 'run': {
      const adapters = require('./teams-adapters.cjs');
      const builder = adapters.adaptersDe(root).builder;
      return { capabilities: builder.capabilities(), pasos: adapters.tick(root, { builder }) };
    }
    case 'status': return Object.assign(estado(root), { goal: require('./goal-check.cjs').evaluar(root, { sprint_id: a.sprint || null }) });
    case 'pause': return pausar(root);
    case 'resume': return continuar(root);
    case 'disable': return desactivar(root);
    case 'pending': return pendientes(root);
    case 'resolve': return resolver(root, { pending_id: a.pending_id, decision: a.decision, decided_by: a.decided_by || 'humano', origen: a.origen });
    case 'import': return importarRespuesta(root, a.texto != null ? a.texto : fs.readFileSync(path.resolve(root, a.archivo), 'utf8'));
    case 'verify': return verificar(root, { task_id: a.task_id, expected_revision: a.expected_revision, event_id: a.event_id, gates: a.gates || [] });
    case 'stop': return stop(root, a);
    case 'views': return regenerarVistas(root);
    default: return { status: 'ACCION_DESCONOCIDA', accion };
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = Object.fromEntries(args.filter((x) => x.startsWith('--')).map((x) => { const [k, ...v] = x.slice(2).split('='); return [k.replace(/-/g, '_'), v.length ? v.join('=') : true]; }));
  const pos = args.filter((x) => !x.startsWith('--'));
  const accion = pos[0] || 'status';
  const root = process.cwd();
  const a = Object.assign({}, opt);
  if (accion === 'plan' && pos[1]) { if (/\.json$/i.test(pos[1])) a.archivo = pos[1]; else a.objetivo = pos.slice(1).join(' '); }
  if (accion === 'resolve') Object.assign(a, { pending_id: pos[1], decision: pos.slice(2).join(' '), origen: process.stdin.isTTY ? 'cli-tty' : 'hook-prompt' });
  if (accion === 'import') a.archivo = pos[1];
  if (accion === 'verify') { a.task_id = pos[1]; if (opt.gates) a.gates = JSON.parse(fs.readFileSync(path.resolve(root, opt.gates), 'utf8')); }
  let r;
  try { r = ejecutarAccion(root, accion, a); } catch (e) { r = { status: e.code || 'ERROR', detalle: e.message }; }
  console.log(JSON.stringify(r, null, 2));
  if (r && /INVALIDO|DESCONOCID|ERROR|NO_VERIFICADO/.test(String(r.status || ''))) process.exitCode = 1;
}

module.exports = {
  ejecutarAccion,
  SCHEMA, SCHEMA_VERSION, ESTADOS, ALCANCES, LIMITES_DEFECTO, ROLES_DEFECTO,
  init, pausar, continuar, desactivar, activo,
  validarTarea, validarPlan, crearPlan,
  asignar, ack, heartbeat, entregarResultado, verificar, gatesRequeridos,
  stop, pendientes, resolver, registrarOrigenHumano, restauracionFallida,
  enlazarPunto, marcarRevertida, reintentar, invalidarPorRestore, actividadConstructor,
  estado, leerTarea, delta, ackSeq, regenerarVistas, importarRespuesta, parsearIntencion,
  normalizarRecurso,
};
