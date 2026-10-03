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

/* v2 (3.20.1): capa de flujo, correcciones, revisores, cierre y plan con referencias. Todo ADITIVO: tablas nuevas, ningún ALTER
   sobre las de v1, de modo que un proyecto v1 migra con `init --aprobar-migracion` (con respaldo) y nada se reescribe al leer. */
const SCHEMA_VERSION = 2;
const ESTADOS = ['PENDING', 'READY', 'RUNNING', 'VERIFYING', 'DONE_VERIFIED', 'BLOCKED_HUMAN',
  'BLOCKED_DEPENDENCY', 'BLOCKED_TECHNICAL', 'FAILED', 'REVERTED', 'CANCELLED'];
/* REVERTED no es final: la tarea no quedó implementada y puede reintentarse desde el punto sano. */
const FINALES = new Set(['DONE_VERIFIED', 'CANCELLED']);
const ALCANCES = ['TASK', 'DEPENDENCY_CHAIN', 'GLOBAL', 'CHANNEL'];
const RIESGOS = ['LOW', 'MEDIUM', 'HIGH'];
/** Gates que TEAMS impone por sí mismo (alcance, leases, plan); el resto llega del controlador. */
const GATES_PROPIOS = new Set(['scope', 'leases', 'plan']);
/* advance_on_delivery: una entrega con comprobaciones básicas habilita la tarea siguiente sin esperar al cierre del director
   (la auditoría corre por detrás, nunca gatea el avance ordinario). memory_closure_required: el cierre exige el registro de memoria. */
const LIMITES_DEFECTO = { reparaciones: 3, replanificaciones: 2, max_intentos_plan: 60, max_minutos_plan: null, lease_ms: 10 * 60 * 1000, ack_ms: 2 * 60 * 1000, advance_on_delivery: true, memory_closure_required: true };
/** Gates cuyo fallo frena la cadena (nunca se relajan por avanzar rápido). */
const GATES_CRITICOS = new Set(['security', 'preservation', 'protected-files', 'blast-radius']);
const ESTADOS_FLUJO = ['BUILDER_RUNNING', 'BUILDER_DELIVERED', 'AUDIT_PENDING', 'CORRECTION_PENDING', 'DIRECTOR_VERIFIED', 'MEMORY_PENDING', 'CLOSED'];
const ROLES_DEFECTO = { director: { host: 'claude-code' }, builder: { host: 'cursor' } };
/** Orígenes que prueban que la decisión la tomó una persona. */
const ORIGEN_HOOK_TTL_MS = 30 * 60 * 1000;

const SCHEMA_V1 = [
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

const SCHEMA_V2 = [
  /* Capa de flujo por tarea: no cambia el significado de teams_tasks.state; añade lo que ese estado no distingue. */
  `CREATE TABLE IF NOT EXISTS teams_flow (task_id TEXT PRIMARY KEY, phase TEXT, review_criteria TEXT, risks TEXT, pending_decisions TEXT,
    delivered_at TEXT, delivery_checks TEXT, current_hash TEXT, verified_at TEXT, memory_state TEXT NOT NULL DEFAULT 'NONE', memory_detail TEXT,
    closed_at TEXT, revalidar TEXT, suspended INTEGER NOT NULL DEFAULT 0, espera_deps INTEGER NOT NULL DEFAULT 0, updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS teams_findings (id TEXT PRIMARY KEY, seq INTEGER, plan_id TEXT, task_id TEXT, severity TEXT NOT NULL,
    actionable INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, origin TEXT NOT NULL, reviewed_hash TEXT,
    reviewed_revision INTEGER, location TEXT, impact TEXT, criterion TEXT, proposal TEXT, acceptance TEXT, depends_on TEXT, scope TEXT,
    dedupe_key TEXT, recurrence INTEGER NOT NULL DEFAULT 1, provenance TEXT, assigned_to TEXT, owner_id TEXT, fencing INTEGER, base_hash TEXT,
    resolved_hash TEXT, lease_until INTEGER, reopen_count INTEGER NOT NULL DEFAULT 0, reason TEXT, duplicate_of TEXT, decision_id TEXT, escalated INTEGER NOT NULL DEFAULT 0,
    event_id TEXT UNIQUE, created_at TEXT, updated_at TEXT, published_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_teams_findings_state ON teams_findings(state)`,
  `CREATE INDEX IF NOT EXISTS idx_teams_findings_task ON teams_findings(task_id)`,
  `CREATE INDEX IF NOT EXISTS idx_teams_findings_dedupe ON teams_findings(dedupe_key)`,
  `CREATE TABLE IF NOT EXISTS teams_finding_log (n INTEGER PRIMARY KEY AUTOINCREMENT, finding_id TEXT NOT NULL, revision INTEGER, from_state TEXT,
    to_state TEXT, actor TEXT, note TEXT, at TEXT)`,
  `CREATE TABLE IF NOT EXISTS teams_suspended (id INTEGER PRIMARY KEY AUTOINCREMENT, finding_id TEXT NOT NULL, task_id TEXT, sprint_id TEXT, phase TEXT,
    next_step TEXT, files TEXT, leases TEXT, state TEXT NOT NULL, created_at TEXT, resumed_at TEXT, resume_report TEXT)`,
  `CREATE TABLE IF NOT EXISTS teams_reviewers (role TEXT PRIMARY KEY, agent_id TEXT, session_id TEXT, modality TEXT NOT NULL, scope TEXT, coverage TEXT,
    registered_at TEXT, updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS teams_reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, scope_kind TEXT NOT NULL, task_id TEXT, finding_id TEXT,
    subject_hash TEXT, revision INTEGER, verdict TEXT NOT NULL, justification TEXT, evidence TEXT, agent_id TEXT, tipo TEXT, consumed INTEGER NOT NULL DEFAULT 0,
    findings TEXT, event_id TEXT UNIQUE, created_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_teams_reviews_role ON teams_reviews(role, scope_kind, task_id)`,
  `CREATE TABLE IF NOT EXISTS teams_builder (id INTEGER PRIMARY KEY CHECK (id = 1), session_id TEXT, host TEXT, model TEXT, state TEXT NOT NULL, capabilities TEXT,
    watchers TEXT, project TEXT, protocol TEXT, connected_at TEXT, ready_at TEXT, updated_at TEXT, prev_session_id TEXT)`,
  `CREATE TABLE IF NOT EXISTS teams_plan_refs (plan_id TEXT NOT NULL, url TEXT NOT NULL, nota TEXT, added_revision INTEGER, downloaded INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (plan_id, url))`,
  `CREATE TABLE IF NOT EXISTS teams_plan_deltas (id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id TEXT NOT NULL, revision INTEGER NOT NULL, kind TEXT, payload TEXT, created_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS teams_closure (close_id TEXT PRIMARY KEY, plan_id TEXT, state TEXT NOT NULL, revision INTEGER, final_status TEXT, pending TEXT, not_done TEXT,
    requested_at TEXT, ack_at TEXT, ack_session TEXT, ack_revision INTEGER, stop_report TEXT, reopened_reason TEXT, confirmed_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS teams_campaign (id INTEGER PRIMARY KEY CHECK (id = 1), run_id TEXT, started_at TEXT, ticks INTEGER NOT NULL DEFAULT 0, last_tick_at TEXT, mode TEXT)`,
];

const SCHEMA = SCHEMA_V1.concat(SCHEMA_V2);

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

/** v2 = capa de flujo/correcciones/revisores/cierre. Una base v1 sigue funcionando; lo nuevo pide la migración aprobada. */
function tieneEsquemaV2(db) {
  return !!db && !!db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='teams_flow'");
}

/** 'NINGUNO' (sin tablas TEAMS) | 'V1' | 'V2'. Solo lee: nunca migra. */
function versionEsquema(root) {
  if (!fs.existsSync(dbPath(root))) return 'SIN_BASE';
  const db = dba.openReadOnly(dbPath(root));
  try { return !tieneEsquema(db) ? 'NINGUNO' : (tieneEsquemaV2(db) ? 'V2' : 'V1'); } finally { db.close(); }
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

/** Como `tx`, pero para operaciones de la capa v2: sin las tablas nuevas devuelve MIGRACION_PENDIENTE, jamás migra a escondidas. */
function tx2(root, fn) {
  const despertar = [];
  const r = conDB(root, (db) => {
    if (!tieneEsquemaV2(db)) throw errorTeams('MIGRACION_PENDIENTE', 'el esquema TEAMS v2 no está aplicado: akdd teams init --aprobar-migracion (con respaldo)', { desde: tieneEsquema(db) ? 'V1' : 'NINGUNO' });
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

/** Lectura de la capa v2: `fn(db)` solo si existen sus tablas; si no, `fn(null)` (se muestra como "sin datos", nunca como 0). */
function lectura2(root, fn) {
  return lectura(root, (db) => fn(tieneEsquemaV2(db) ? db : null));
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

// ─── capa de flujo (v2) ──────────────────────────────────────────────────────

const limitesDe = (db, planId) => {
  const r = db.get('SELECT limits FROM teams_plans WHERE id = ?', planId);
  return Object.assign({}, LIMITES_DEFECTO, pj(r && r.limits, {}));
};

function flujoFila(f) {
  if (!f) return null;
  return {
    task_id: f.task_id, phase: f.phase, review_criteria: pj(f.review_criteria, []), risks: pj(f.risks, []), pending_decisions: pj(f.pending_decisions, []),
    delivered_at: f.delivered_at, delivery_checks: pj(f.delivery_checks, []), current_hash: f.current_hash, verified_at: f.verified_at,
    memory_state: f.memory_state, memory_detail: f.memory_detail, closed_at: f.closed_at, revalidar: pj(f.revalidar, []),
    suspended: !!f.suspended, espera_deps: !!f.espera_deps,
  };
}

/** Fila de flujo de una tarea; null si la base es v1 o la tarea no la tiene (planes anteriores a v2). */
function flujoDe(db, taskId) {
  if (!tieneEsquemaV2(db)) return null;
  return flujoFila(db.get('SELECT * FROM teams_flow WHERE task_id = ?', taskId));
}

/** Escribe solo los campos pasados (los objetos se guardan como JSON). Crea la fila si falta. No hace nada en una base v1. */
function upsertFlujo(db, taskId, patch) {
  if (!tieneEsquemaV2(db)) return;
  if (!db.get('SELECT 1 FROM teams_flow WHERE task_id = ?', taskId)) db.run('INSERT INTO teams_flow (task_id, updated_at) VALUES (?, ?)', taskId, ahoraIso());
  const sets = ['updated_at = ?'];
  const vals = [ahoraIso()];
  for (const [k, v] of Object.entries(patch)) {
    sets.push(k + ' = ?');
    vals.push(v !== null && typeof v === 'object' ? js(v) : (typeof v === 'boolean' ? (v ? 1 : 0) : v));
  }
  db.run(`UPDATE teams_flow SET ${sets.join(', ')} WHERE task_id = ?`, ...vals, taskId);
}

/**
 * Comprobaciones básicas que el constructor reporta al entregar. Acepta objetos {name,status} o strings "nombre=PASS".
 * Lo que no se puede interpretar se descarta: una comprobación ilegible no habilita nada.
 */
function normalizarChecks(evidence) {
  const out = [];
  for (const e of Array.isArray(evidence) ? evidence : []) {
    if (typeof e === 'string') {
      const m = /^\s*([\w.:-]{1,60})\s*[=:]\s*(PASS|FAIL|ERROR|SKIP)\s*$/i.exec(e);
      if (m) out.push({ name: m[1], status: m[2].toUpperCase() });
    } else if (e && typeof e === 'object' && (e.status || e.result)) {
      out.push({ name: String(e.name || e.kind || e.gate || 'check').slice(0, 60), status: String(e.status || e.result).toUpperCase().slice(0, 12) });
    }
  }
  return out;
}

const hayBloqueantesAbiertos = (db, taskId) => tieneEsquemaV2(db) && !!db.get(
  "SELECT 1 FROM teams_findings WHERE task_id = ? AND severity = 'BLOQUEANTE' AND actionable = 1 AND state NOT IN ('VERIFIED_RESOLVED','DISMISSED_WITH_REASON')", taskId);

/**
 * ¿Esta entrega (aún VERIFYING) habilita a sus dependientes? Solo con comprobaciones básicas reportadas y sin fallo,
 * tarea no HIGH (auth/migración/seguridad conservan el cierre síncrono), sin hallazgo bloqueante abierto ni revalidación
 * pendiente. NO la declara verificada: DONE_VERIFIED sigue exigiendo los gates del sujeto exacto, y un gate crítico que
 * falle después abre el STOP de su cadena como siempre.
 */
function entregaHabilita(db, dep) {
  if (!dep || dep.state !== 'VERIFYING' || !tieneEsquemaV2(db)) return false;
  if (!limitesDe(db, dep.plan_id).advance_on_delivery) return false;
  if ((dep.effort_policy.tier || 'MEDIUM') === 'HIGH' || dep.risk === 'HIGH') return false;
  const f = flujoDe(db, dep.id);
  if (!f || !f.delivered_at) return false;
  const checks = f.delivery_checks;
  if (!checks.some((c) => c.status === 'PASS') || checks.some((c) => c.status === 'FAIL' || c.status === 'ERROR')) return false;
  if (f.revalidar.length || hayBloqueantesAbiertos(db, dep.id)) return false;
  return true;
}

/** Una dependencia cuenta como satisfecha si está verificada, o entregada y habilitante (política advance_on_delivery). */
const dependenciaSatisfecha = (db, dep) => !!dep && (dep.state === 'DONE_VERIFIED' || entregaHabilita(db, dep));

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
  for (const campo of ['criterios_de_revision', 'riesgos', 'decisiones_pendientes']) {
    if (t[campo] != null && (!Array.isArray(t[campo]) || t[campo].some((x) => typeof x !== 'string' && (!x || typeof x !== 'object')))) errores.push(campo.toUpperCase() + '_NO_LISTA');
  }
  if (t.phase != null && !/^[\w .:-]{1,60}$/.test(String(t.phase))) errores.push('FASE_INVALIDA');
  return errores;
}

/**
 * Referencias del dueño (URLs que el plan puede consultar). Solo http/https bien formadas: un file:, javascript: o cadena
 * suelta no es una referencia. Aquí SOLO se guardan; descargarlas es trabajo de la investigación web, no del plan.
 */
function normalizarReferencias(refs) {
  const ok = [];
  const errores = [];
  for (const r of Array.isArray(refs) ? refs : []) {
    const url = typeof r === 'string' ? r : r && r.url;
    const nota = typeof r === 'object' && r ? String(r.nota || '').slice(0, 300) : '';
    let u = null;
    try { u = new URL(String(url)); } catch { /* inválida */ }
    if (!u || !/^https?:$/.test(u.protocol) || u.username || u.password) { errores.push({ code: 'REFERENCIA_INVALIDA', url: String(url).slice(0, 120) }); continue; }
    if (!ok.some((x) => x.url === u.href)) ok.push({ url: u.href, nota });
  }
  return { ok, errores };
}

/**
 * Un sprint puede traer `tasks` planas o `phases: [{ id, objective, tasks }]` (sprints → fases → tareas). Se aplana a tareas con
 * `phase`, que es lo que el scheduler consume; la forma plana de v1 pasa intacta.
 */
function normalizarSprints(plan) {
  const sprints = Array.isArray(plan && plan.sprints) ? plan.sprints : [];
  return sprints.map((s) => {
    if (!s || !Array.isArray(s.phases)) return s;
    const tasks = [...(Array.isArray(s.tasks) ? s.tasks : [])];
    for (const f of s.phases) for (const t of (f && Array.isArray(f.tasks) ? f.tasks : [])) tasks.push(Object.assign({}, t, { phase: t.phase || (f.id || f.objective || null) }));
    return Object.assign({}, s, { tasks });
  });
}

function validarPlan(plan) {
  const errores = [];
  if (!plan || !String(plan.objective || '').trim()) errores.push({ code: 'SIN_OBJETIVO' });
  const sprints = normalizarSprints(plan);
  if (!sprints.length) errores.push({ code: 'SIN_SPRINTS' });
  const todas = [];
  sprints.forEach((s, i) => {
    if (!Array.isArray(s.tasks) || !s.tasks.length) errores.push({ code: 'SPRINT_VACIO', sprint: i + 1 });
    for (const t of s.tasks || []) {
      todas.push(t);
      for (const code of validarTarea(t)) errores.push({ code, task: t && t.id });
    }
  });
  if (plan && plan.referencias != null) {
    if (!Array.isArray(plan.referencias)) errores.push({ code: 'REFERENCIAS_NO_LISTA' });
    else errores.push(...normalizarReferencias(plan.referencias).errores);
  }
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
  const r = initNucleo(root, opciones);
  /* Activar prepara el canal y la continuidad (vista derivada de la base). Si ya existía un canal manual, se copia antes de reemplazarlo. */
  if (r && r.status === 'ACTIVO') {
    try { const c = require('./teams-canal.cjs').regenerar(root); r.canal = { status: c.status, importado: c.importado || null }; } catch (e) { r.canal = { status: 'ERROR', detalle: String(e.message).slice(0, 120) }; }
  }
  return r;
}

function initNucleo(root, opciones = {}) {
  const proyecto = identificarProyecto(root);
  if (!proyecto) return { status: 'PROYECTO_NO_IDENTIFICADO', detalle: 'falta .agentic/config.md o package.json' };
  if (!fs.existsSync(dbPath(root))) return { status: 'NOT_INITIALIZED', detalle: 'no hay memoria.db (akdd init primero)' };
  const desde = versionEsquema(root);
  let migracion = null;
  if (desde !== 'V2') {
    /* El esquema nuevo SOLO entra por aquí, con aprobación y respaldo: nunca al leer ni a escondidas. Una base v1 recibe únicamente las tablas v2. */
    if (!opciones.aprobarMigracion) {
      return { status: 'MIGRACION_PENDIENTE', desde, tablas: desde === 'V1' ? SCHEMA_V2.length : SCHEMA.length, comando: 'akdd teams init --aprobar-migracion', detalle: 'TEAMS añade tablas teams_* a memoria.db; se aplica con respaldo y solo si lo apruebas' };
    }
    const r = dba.migrate(dbPath(root), {
      statements: desde === 'V1' ? SCHEMA_V2 : SCHEMA,
      run: (db) => db.run("INSERT OR REPLACE INTO teams_meta (key, value) VALUES ('schema_version', ?)", String(SCHEMA_VERSION)),
    });
    migracion = { status: r.status, respaldo: r.backupPath, desde };
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
    /* El modelo exacto lo informa cada adapter al conectarse; aquí no se inventa. */
    const guardados = Object.fromEntries(Object.entries(roles).map(([r, d]) => [r, { host: d.host, model: d.model || null }]));
    if (previa && previa.enabled) {
      /* Activar de nuevo con la misma configuración es idempotente: no sube la generación ni invalida la sesión del constructor. */
      const mismos = Object.keys(guardados).every((r) => previa.roles[r] && previa.roles[r].host === guardados[r].host) && Object.keys(previa.roles).length === Object.keys(guardados).length;
      if (mismos) return { status: 'ACTIVO', session_generation: previa.session_generation, roles: previa.roles, migracion, ejecutando: false, idempotente: true, paused: previa.paused };
      /* Reconfigurar roles de verdad es otra cosa: transición explícita y sin tareas en vuelo. */
      if (!opciones.reconfigurar) return { status: 'RECONFIGURACION_REQUIERE_TRANSICION', roles_actuales: previa.roles, roles_pedidos: guardados, comando: 'akdd teams init --reconfigurar' };
      const vivas = db.all("SELECT id FROM teams_tasks WHERE state IN ('RUNNING','VERIFYING')").map((r) => r.id);
      if (vivas.length) return { status: 'TAREAS_ACTIVAS', tareas: vivas, detalle: 'cierra o pausa las tareas en curso antes de reconfigurar los roles' };
    }
    const gen = (previa ? previa.session_generation : 0) + 1;
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
    /* Correcciones IN_PROGRESS cuyo constructor dejó de latir vuelven a la cola para que otra sesión las tome con otro fencing. */
    if (tieneEsquemaV2(db)) require('./teams-correcciones.cjs').reclamarVencidasEn(db, ahora);
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
    /* Desactivar conserva la historia: las correcciones en curso vuelven a ASSIGNED sin dueño (su registro de cambios queda). */
    if (tieneEsquemaV2(db)) {
      for (const f of db.all("SELECT id, revision, state FROM teams_findings WHERE state = 'IN_PROGRESS'")) {
        db.run("UPDATE teams_findings SET state = 'ASSIGNED', owner_id = NULL, lease_until = NULL, revision = revision + 1, updated_at = ? WHERE id = ?", ahoraIso(), f.id);
        db.run('INSERT INTO teams_finding_log (finding_id, revision, from_state, to_state, actor, note, at) VALUES (?,?,?,?,?,?,?)', f.id, f.revision + 1, f.state, 'ASSIGNED', 'sistema', 'TEAMS desactivado', ahoraIso());
      }
    }
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
    const v2 = tieneEsquemaV2(db);
    normalizarSprints(plan).forEach((sp, i) => {
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
        if (v2) {
          upsertFlujo(db, t.id, {
            phase: t.phase || null, review_criteria: t.criterios_de_revision || [], risks: t.riesgos || [], pending_decisions: t.decisiones_pendientes || [],
          });
        }
      }
    });
    if (v2) {
      /* Referencias del dueño: se guardan (no se descargan aquí). El plan nace en revisión 1. */
      for (const r of normalizarReferencias(plan.referencias).ok) {
        db.run('INSERT OR IGNORE INTO teams_plan_refs (plan_id, url, nota, added_revision) VALUES (?,?,?,1)', planId, r.url, r.nota);
      }
      db.run('INSERT INTO teams_plan_deltas (plan_id, revision, kind, payload, created_at) VALUES (?,?,?,?,?)', planId, 1, 'CREATED', js({ tareas: v.tareas.map((t) => t.id) }), ahoraIso());
    }
    /* Lo que depende de un nodo roto tampoco arranca. */
    propagarBloqueoGrafo(db, planId);
    recalcular(db);
    publicar(db, despertar, { kind: 'PLAN_CREATED', producer: 'director', target: 'builder', payload: { plan_id: planId } });
    const lista = tareas(db, planId);
    /* El primer lote existe ANTES de arrancar al constructor: es lo que ya está READY al guardar el plan. */
    return {
      status: 'PLAN_GUARDADO', plan_id: planId, revision: 1,
      primer_lote: lista.filter((t) => t.state === 'READY').map((t) => t.id),
      referencias: v2 ? normalizarReferencias(plan.referencias).ok.length : 0,
      tareas: lista.map((t) => ({ id: t.id, state: t.state, tier: t.effort_policy.tier, blocked_reason: t.blocked_reason })),
    };
  });
}

/**
 * Cambio de plan = nueva revisión con delta, NUNCA un reemplazo silencioso: las tareas ya aceptadas (cualquier estado distinto de
 * PENDING/READY sin dueño) no se tocan. Admite añadir tareas y referencias; cancelar una tarea aún sin empezar. Pide la capa v2.
 */
function revisarPlan(root, { plan_id, agregar = [], cancelar = [], referencias = [], motivo = null }) {
  const errores = [];
  for (const t of agregar) for (const code of validarTarea(t)) errores.push({ code, task: t && t.id });
  const refs = normalizarReferencias(referencias);
  errores.push(...refs.errores);
  if (errores.length) return { status: 'PLAN_INVALIDO', errores };
  return tx2(root, (db, despertar) => {
    const s = sesion(db);
    if (!s || !s.enabled) return { status: 'DESACTIVADO' };
    const plan = db.get(plan_id ? 'SELECT * FROM teams_plans WHERE id = ?' : 'SELECT * FROM teams_plans ORDER BY created_at DESC LIMIT 1', ...(plan_id ? [plan_id] : []));
    if (!plan) return { status: 'PLAN_DESCONOCIDO' };
    const existentes = new Set(tareas(db).map((t) => t.id));
    for (const t of agregar) if (existentes.has(t.id)) return { status: 'PLAN_INVALIDO', errores: [{ code: 'ID_DUPLICADO_EN_BASE', task: t.id }] };
    const todas = tareas(db, plan.id).concat(agregar.map((t) => ({ id: t.id, depends_on: t.depends_on || [] })));
    const ids = new Set(todas.map((t) => t.id));
    const { validarGrafo } = require('./spec-manager.cjs');
    const grafo = validarGrafo(todas.map((t) => ({ id: t.id, dep_ids: (t.depends_on || []).filter((d) => ids.has(d)), missing_deps: (t.depends_on || []).filter((d) => !ids.has(d)) })));
    if (grafo.length) return { status: 'PLAN_INVALIDO', errores: grafo.map((e) => ({ code: e.code, task: e.task })) };
    for (const id of cancelar) {
      const t = tarea(db, id);
      if (!t || t.plan_id !== plan.id) return { status: 'TAREA_DESCONOCIDA', task: id };
      if (!['PENDING', 'READY'].includes(t.state) || t.owner_id) return { status: 'TAREA_YA_ACEPTADA', task: id, estado: t.state, detalle: 'una tarea en curso o cerrada no se reemplaza en silencio' };
    }
    const rev = plan.revision + 1;
    const sprintId = (db.get('SELECT id FROM teams_sprints WHERE plan_id = ? ORDER BY n DESC LIMIT 1', plan.id) || {}).id || null;
    let orden = (db.get('SELECT MAX(orden) AS o FROM teams_tasks WHERE plan_id = ?', plan.id).o || 0) + 1;
    for (const t of agregar) {
      const decision = decidirEsfuerzo(root, t);
      db.run(`INSERT INTO teams_tasks (id, plan_id, sprint_id, objective, acceptance, depends_on, allowed_files, risk, effort_policy,
        state, priority, orden, failed_hashes, evidence, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      t.id, plan.id, t.sprint_id || sprintId, t.objective, js(t.acceptance), js(t.depends_on || []), js(t.allowed_files), decision.risk || t.risk || 'MEDIUM',
      js({ tier: decision.tier, required_gates: decision.required_gates, required_roles: decision.required_roles, policy_version: decision.policy_version, policy_id: decision.policy_id || null, no_aplica: decision.no_aplica || [], origen: 'teams' }),
      'PENDING', Number(t.priority) || 0, orden++, '[]', '[]', ahoraIso(), ahoraIso());
      upsertFlujo(db, t.id, { phase: t.phase || null, review_criteria: t.criterios_de_revision || [], risks: t.riesgos || [], pending_decisions: t.decisiones_pendientes || [] });
    }
    for (const id of cancelar) transicionar(db, id, { a: 'CANCELLED', cambios: { blocked_reason: 'CANCELADA_POR_REVISION_DE_PLAN:' + rev } });
    for (const r of refs.ok) db.run('INSERT OR IGNORE INTO teams_plan_refs (plan_id, url, nota, added_revision) VALUES (?,?,?,?)', plan.id, r.url, r.nota, rev);
    db.run('UPDATE teams_plans SET revision = ?, updated_at = ? WHERE id = ?', rev, ahoraIso(), plan.id);
    db.run('INSERT INTO teams_plan_deltas (plan_id, revision, kind, payload, created_at) VALUES (?,?,?,?,?)', plan.id, rev, 'REVISED',
      js({ agregadas: agregar.map((t) => t.id), canceladas: cancelar, referencias: refs.ok.map((r) => r.url), motivo }), ahoraIso());
    recalcular(db);
    publicar(db, despertar, { kind: 'PLAN_REVISED', producer: 'director', target: 'builder', payload: { plan_id: plan.id, revision: rev, agregadas: agregar.map((t) => t.id), canceladas: cancelar } });
    return { status: 'PLAN_REVISADO', plan_id: plan.id, revision: rev, agregadas: agregar.map((t) => t.id), canceladas: cancelar };
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

/**
 * Una dependencia dejó de estar entregada-y-sana (falló su verificación o recibió un hallazgo): lo que ya EMPEZÓ sobre ella queda
 * marcado para revalidar. No se cancela ni se revierte nada: el trabajo continúa, pero no puede cerrarse sin rehacer su verificación.
 */
function marcarDependientesRevalidar(db, despertar, taskId, motivo) {
  if (!tieneEsquemaV2(db)) return [];
  const marcadas = [];
  for (const id of descendientes(db, [taskId]).filter((x) => x !== taskId)) {
    const t = tarea(db, id);
    if (!t || !['RUNNING', 'VERIFYING'].includes(t.state)) continue; /* lo aún no empezado se construirá sobre el código ya corregido */
    const f = flujoDe(db, id);
    const prev = f ? f.revalidar : [];
    if (prev.includes(motivo)) continue;
    upsertFlujo(db, id, { revalidar: prev.concat(motivo) });
    marcadas.push(id);
  }
  if (marcadas.length) publicar(db, despertar, { kind: 'REVALIDATE', producer: 'teams', target: 'director', task_id: taskId, payload: { motivo, tareas: marcadas } });
  return marcadas;
}

function propagarBloqueoGrafo(db, planId) {
  const rotas = tareas(db, planId).filter((t) => t.state === 'BLOCKED_DEPENDENCY').map((t) => t.id);
  for (const id of descendientes(db, rotas)) {
    const t = tarea(db, id);
    if (t.state === 'PENDING') transicionar(db, id, { de: ['PENDING'], a: 'BLOCKED_DEPENDENCY', cambios: { blocked_reason: 'DEPENDE_DE_NODO_INVALIDO' } });
  }
}

/**
 * PENDING con todas sus dependencias satisfechas pasa a READY. Satisfecha = DONE_VERIFIED, o entregada con comprobaciones
 * básicas bajo la política advance_on_delivery (la auditoría corre por detrás). Una dependencia realmente sin satisfacer
 * (sin entregar, fallida, bloqueada) sigue bloqueando su rama. Nada más promueve.
 */
function recalcular(db) {
  const todas = tareas(db);
  const porId = new Map(todas.map((t) => [t.id, t]));
  const promovidas = [];
  for (const t of todas) {
    if (t.state !== 'PENDING') continue;
    if (t.depends_on.every((d) => dependenciaSatisfecha(db, porId.get(d)))) {
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
    /* Cierre solicitado o aceptado: el constructor no toma trabajo nuevo (un hallazgo en carrera reabre el cierre y lo libera). */
    const cierre = tieneEsquemaV2(db) && db.get("SELECT close_id, state FROM teams_closure WHERE state IN ('REQUESTED','ACKED') ORDER BY requested_at DESC LIMIT 1");
    if (cierre) return { status: cierre.state === 'ACKED' ? 'CERRADO' : 'CIERRE_SOLICITADO', close_id: cierre.close_id };
    reclamarVencidos(db, ahora);
    recalcular(db);
    /* Una entrega habilitante (VERIFYING con comprobaciones) NO ocupa al constructor: puede seguir con lo siguiente mientras el director
       verifica y los revisores auditan. Sin esas comprobaciones, o en tareas HIGH, sigue ocupándolo como siempre. */
    const propia = db.all("SELECT * FROM teams_tasks WHERE owner_id = ? AND state IN ('READY','RUNNING','VERIFYING')", owner_id).map(fila)
      .find((t) => t.state !== 'VERIFYING' || !entregaHabilita(db, t));
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
    /* Estado de flujo: BUILDER_DELIVERED. Las comprobaciones básicas que trae la entrega pueden habilitar lo siguiente (advance_on_delivery). */
    const flujoPrevio = flujoDe(db, t.id);
    upsertFlujo(db, t.id, { delivered_at: ahoraIso(), delivery_checks: normalizarChecks(r.evidence), current_hash: r.subject_hash, espera_deps: false, revalidar: flujoPrevio && flujoPrevio.revalidar.length ? flujoPrevio.revalidar : [] });
    recalcular(db);
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
    /* Una tarea puede EMPEZAR sobre una entrega aún sin verificar (advance_on_delivery), pero no cerrarse sobre ella: DONE_VERIFIED exige
       las dependencias verificadas. No se publica evento con event_id: el reintento posterior, ya con las dependencias cerradas, debe poder correr. */
    const sinVerificar = t.depends_on.filter((d) => { const x = tarea(db, d); return !x || x.state !== 'DONE_VERIFIED'; });
    if (sinVerificar.length) {
      upsertFlujo(db, task_id, { espera_deps: true });
      return { status: 'ESPERA_DEPENDENCIAS', faltan: sinVerificar, estado: 'VERIFYING' };
    }
    upsertFlujo(db, task_id, { espera_deps: false });
    if (hayBloqueantesAbiertos(db, task_id)) return { status: 'BLOQUEADO_POR_CORRECCION', estado: 'VERIFYING', detalle: 'hay una corrección BLOQUEANTE de esta tarea sin verificar' };
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
      const r = cerrar(fallo(db, despertar, t, 'GATE_FAIL:' + fallidos.map((g) => g.gate).join(','), t.subject_hash));
      /* Lo que ya empezó sobre esta entrega queda marcado: su verificación tendrá que rehacerse contra lo que salga de la reparación. */
      marcarDependientesRevalidar(db, despertar, t.id, 'DEP_FALLO_VERIFICACION:' + t.id);
      return r;
    }
    const faltan = gatesRequeridos(t).filter((g) => {
      const r = porGate.get(g);
      const politicaDistinta = r && r.policy_id && t.effort_policy.policy_id && r.policy_id !== t.effort_policy.policy_id;
      return !r || r.subject_hash !== t.subject_hash || politicaDistinta || !allowsVerifiedClose(r, { root, paths: t.allowed_files, gate: g });
    });
    if (faltan.length) return cerrar({ status: 'SIN_EVIDENCIA_SUFICIENTE', faltan, estado: 'VERIFYING' });
    const evidencia = gatesRequeridos(t).map((g) => ({ gate: g, subject_hash: t.subject_hash, execution_id: porGate.get(g).execution_id || null }));
    const v = transicionar(db, task_id, { de: ['VERIFYING'], a: 'DONE_VERIFIED', cambios: { evidence: evidencia } });
    /* DIRECTOR_VERIFIED. El registro de memoria queda PENDIENTE hasta que el puente de cierre lo marque (REGISTERED / NO_LEARNING):
       verificado y registrado son estados distintos, y el cierre final exige los dos. Sin la cola de memoria de 3.20.1 no hay nada que registrar. */
    const conMemoria = tieneEsquemaV2(db) && limitesDe(db, t.plan_id).memory_closure_required
      && !!db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mem_jobs'");
    upsertFlujo(db, task_id, { verified_at: ahoraIso(), revalidar: [], espera_deps: false, memory_state: conMemoria ? 'PENDING' : 'NO_APLICA' });
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
    const plan = db.get("SELECT id, objective, state, revision FROM teams_plans ORDER BY created_at DESC LIMIT 1");
    const ultimo = db.get('SELECT MAX(seq) AS seq FROM teams_events');
    const v2 = tieneEsquemaV2(db);
    const cierre = v2 ? require('./teams-cierre.cjs') : null;
    const base = {
      inicializado: true, enabled: s.enabled, paused: !!s.paused, session_generation: s.session_generation || 0, roles: s.roles || {},
      plan: plan || null, conteo,
      tareas: ts.map((t) => {
        const o = { id: t.id, sprint_id: t.sprint_id, state: t.state, owner_id: t.owner_id, tier: t.effort_policy.tier, risk: t.risk, depends_on: t.depends_on, blocked_reason: t.blocked_reason };
        if (v2) { const fl = cierre.flujoDeTarea(db, t); if (fl) { o.flujo = fl.estado; o.fase = fl.fase; o.audit_pending = fl.audit_pending; o.correction_pending = fl.correction_pending; o.memory_state = fl.memory_state; o.sujeto_vigente = fl.sujeto_vigente; if (fl.revalidar.length) o.revalidar = fl.revalidar; } }
        return o;
      }),
      leases: db.all('SELECT resource, owner_id, task_id, fencing, expires_ms FROM teams_leases'),
      pendientes: db.all('SELECT id, scope, reason_code FROM teams_decisions WHERE resolved_at IS NULL'),
      ultimo_seq: (ultimo && ultimo.seq) || 0,
      esquema: v2 ? 'V2' : 'V1',
    };
    if (!v2) return Object.assign(base, { v2: false, nota: 'esquema TEAMS v2 sin aplicar: correcciones, revisores, cierre y avance medido requieren akdd teams init --aprobar-migracion' });
    const corr = require('./teams-correcciones.cjs').resumen(db);
    const bld = require('./teams-builder.cjs').estadoBuilder(db);
    const R = require('./teams-revision.cjs');
    const regs = R.revisores(db);
    const refs = db.all('SELECT url, nota, added_revision, downloaded FROM teams_plan_refs ORDER BY added_revision').map((r) => ({ url: r.url, nota: r.nota, revision: r.added_revision, descargada: !!r.downloaded }));
    const camp = db.get('SELECT run_id, started_at, ticks, last_tick_at, mode FROM teams_campaign WHERE id = 1');
    const pendientesDueno = db.all('SELECT id, reason_code, question, affected_tasks FROM teams_decisions WHERE resolved_at IS NULL AND decision_required = 1')
      .map((d) => ({ id: d.id, pregunta: d.question, reason_code: d.reason_code, bloquea: pj(d.affected_tasks, []) }));
    return Object.assign(base, {
      v2: true, campana: cierre.campanaDe(db), avance: cierre.avanceDe(db), ejecucion: camp || null, builder: bld,
      revisores: regs, revisiones_sin_consumir: R.sinConsumir(db).length,
      correcciones: { por_estado: corr.por_estado, por_triar: corr.por_triar, abiertas_accionables: corr.abiertas_accionables, bloqueadas_humano: corr.bloqueadas_humano,
        activas: corr.activas.slice(0, 20).map((f) => ({ id: f.id, severity: f.severity, state: f.state, task_id: f.task_id, criterio: f.criterion, prioridad: f.prioridad })) },
      cierre: cierre.cierreVigente(db), referencias: refs, pendientes_dueno: pendientesDueno,
      auditoria: {
        sin_registrar: R.ROLES.filter((r) => !regs[r]), degradados: R.ROLES.filter((r) => regs[r] && regs[r].degradado),
        tareas_con_auditoria_pendiente: base.tareas.filter((t) => t.audit_pending).map((t) => t.id), informes_sin_consumir: R.sinConsumir(db).length,
      },
    });
  });
}

/**
 * Revalida una tarea ya DONE_VERIFIED cuyo código o cuyas dependencias cambiaron (corrección entregada, dependencia reparada).
 * Exige los gates de la tarea con PASS y evidencia sobre el sujeto VIGENTE (el hash tras la corrección), o una declaración
 * explícita de "sin efecto" con su razón. Un FAIL no limpia nada: la tarea sigue marcada y el director decide.
 */
function revalidar(root, { task_id, gates = [], sin_efecto = null, event_id = null }) {
  return tx2(root, (db, despertar) => {
    const t = tarea(db, task_id);
    if (!t) return { status: 'TAREA_DESCONOCIDA' };
    const f = flujoDe(db, task_id);
    if (!f || !f.revalidar.length) return { status: 'NADA_QUE_REVALIDAR' };
    if (t.state !== 'DONE_VERIFIED') return { status: 'TRANSICION_INVALIDA', estado: t.state, detalle: 'una tarea en curso o en verificación se revalida con su verificación normal' };
    const sujeto = f.current_hash || t.subject_hash;
    if (sin_efecto) {
      const razon = String(sin_efecto).trim().slice(0, 300);
      if (!razon) return { status: 'SIN_RAZON' };
      upsertFlujo(db, task_id, { revalidar: [] });
      publicar(db, despertar, { event_id, kind: 'REVALIDATED', producer: 'director', target: 'builder', task_id, payload: { sin_efecto: razon, motivos: f.revalidar } });
      return { status: 'REVALIDADA', sin_efecto: razon };
    }
    const fallidos = gates.filter((g) => g.status === 'FAIL' && (!g.subject_hash || g.subject_hash === sujeto));
    if (fallidos.length) {
      publicar(db, despertar, { kind: 'REVALIDATION_FAILED', producer: 'director', target: 'director', task_id, payload: { gates: fallidos.map((g) => g.gate) } });
      return { status: 'REVALIDACION_FALLIDA', gates: fallidos.map((g) => g.gate), detalle: 'la tarea sigue marcada: el director abre una corrección sobre ella' };
    }
    const porGate = new Map(gates.map((g) => [g.gate, g]));
    const faltan = gatesRequeridos(t).filter((g) => { const r = porGate.get(g); return !r || r.subject_hash !== sujeto || !allowsVerifiedClose(r, { root, paths: t.allowed_files, gate: g }); });
    if (faltan.length) return { status: 'SIN_EVIDENCIA_SUFICIENTE', faltan, sujeto };
    db.run('UPDATE teams_tasks SET subject_hash = ?, evidence = ?, updated_at = ? WHERE id = ?', sujeto, js(gatesRequeridos(t).map((g) => ({ gate: g, subject_hash: sujeto, execution_id: porGate.get(g).execution_id || null, revalidada: true }))), ahoraIso(), task_id);
    upsertFlujo(db, task_id, { revalidar: [] });
    publicar(db, despertar, { event_id, kind: 'REVALIDATED', producer: 'director', target: 'builder', task_id, payload: { sujeto, motivos: f.revalidar } });
    return { status: 'REVALIDADA', sujeto };
  });
}

/** Tareas VERIFYING cuya verificación esperaba a sus dependencias y que ya pueden verificarse (las dependencias cerraron). */
function verificacionesEnEspera(root) {
  return lectura2(root, (db) => {
    if (!db) return [];
    return db.all('SELECT task_id FROM teams_flow WHERE espera_deps = 1').map((r) => tarea(db, r.task_id))
      .filter((t) => t && t.state === 'VERIFYING' && t.depends_on.every((d) => { const x = tarea(db, d); return x && x.state === 'DONE_VERIFIED'; }))
      .map((t) => ({ task_id: t.id, subject_hash: t.subject_hash, revision: t.revision, owner_id: t.owner_id, files: t.allowed_files }));
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

/**
 * Regenera `.legion/CONTINUIDAD.md` y `.legion/AUDITORIA-CURSOR.md`. El render determinista vive en teams-canal.cjs (secciones del
 * canal, un solo escritor, publicaciones serializadas con bloqueo y escritura atómica con revisión).
 */
function regenerarVistas(root) {
  return require('./teams-canal.cjs').regenerar(root);
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
  avance: 'progress', cerrar: 'close',
};

/** Nombres en español (CLI y chat) a accion canonica. Una sola tabla: CLI, MCP y chat comparten el mismo backend. */
const ALIAS = {
  'conectar-builder': 'connect-builder', 'builder-listo': 'builder-ready', correcciones: 'findings', revision: 'review',
  cerrar: 'close', 'cerrar-ack': 'close-ack', 'confirmar-cierre': 'close-confirm', 'reabrir-campana': 'reopen-campaign', avance: 'progress',
  ronda: 'round', reportar: 'report', revalidar: 'revalidate', 'revisar-plan': 'revise-plan', 'importar-canal': 'import-channel', memoria: 'memory-mark',
};

/** Sub-acciones de `findings` y `review` (espanol o ingles) a funcion del modulo. */
const SUB_CORRECCIONES = {
  'añadir': 'añadir', anadir: 'añadir', add: 'añadir', publicar: 'publicarCorreccion', promover: 'promover', descartar: 'descartar', tomar: 'tomar', entregar: 'entregar',
  reanudar: 'reanudar', latido: 'latido', soltar: 'soltar', verificar: 'verificar', reabrir: 'reabrir', bloquear: 'bloquear', desbloquear: 'desbloquear',
  reubicar: 'reubicar', siguiente: 'siguiente', listar: 'listar',
};
const SUB_REVISION = { registrar: 'registrar', informar: 'informar', consumir: 'consumir', estado: 'estadoRevision', pendientes: 'pendientes', 'sujeto-final': 'sujetoFinalDe' };

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
/** Acciones que cambian estado: tras ellas el canal MD se refresca (vista derivada, un solo escritor). */
const ESCRIBEN = new Set(['plan', 'revise-plan', 'run', 'connect-builder', 'builder-ready', 'pause', 'resume', 'disable', 'resolve', 'import', 'verify', 'revalidate', 'stop',
  'close', 'close-ack', 'close-confirm', 'reopen-campaign', 'memory-mark', 'report', 'import-channel']);
const SUB_LECTURA = new Set(['listar', 'siguiente', 'reubicar', 'estado', 'pendientes', 'sujeto-final', 'suspendidas']);

function ejecutarAccion(root, accionPedida, a = {}) {
  const accion = ALIAS[accionPedida] || accionPedida;
  const r = ejecutarSinRefrescar(root, accionPedida, a);
  const escribe = ESCRIBEN.has(accion) || ((accion === 'findings' || accion === 'review') && !SUB_LECTURA.has(String(a.sub || (a.params && a.params.sub) || (accion === 'findings' ? 'listar' : 'estado'))));
  if (escribe && r && typeof r === 'object' && !Array.isArray(r) && !/DESCONOCID|MIGRACION_PENDIENTE|NO_AUTORIZADO|INVALID/.test(String(r.status || ''))) {
    try { require('./teams-canal.cjs').refrescar(root); } catch { /* el canal es derivado */ }
  }
  return r;
}

function ejecutarSinRefrescar(root, accionPedida, a = {}) {
  const accion = ALIAS[accionPedida] || accionPedida;
  const P = a.params || {};
  switch (accion) {
    case 'init': return init(root, { aprobarMigracion: !!a.aprobar_migracion, roles: a.roles, mismoHost: !!a.mismo_host, reconfigurar: !!a.reconfigurar });
    case 'plan': {
      const plan = a.plan || (a.archivo ? JSON.parse(fs.readFileSync(path.resolve(root, a.archivo), 'utf8')) : { objective: a.objetivo, sprints: [] });
      return crearPlan(root, plan);
    }
    case 'revise-plan': return revisarPlan(root, Object.assign({}, P, a.plan_id ? { plan_id: a.plan_id } : {}));
    /* run = validar (primer lote + builder READY + vigilancia + verificador) y correr un pase con el verificador REAL, no una pasada vacia. */
    case 'run': return require('./teams-builder.cjs').ejecutar(root, {});
    case 'connect-builder': return require('./teams-builder.cjs').conectar(root, { session_id: a.sesion || a.session_id || P.session_id, host: a.host || P.host, model: a.modelo || a.model || P.model, proyecto: a.proyecto || P.proyecto, protocolo: a.protocolo || P.protocolo || 'v2', loop: a.loop != null ? a.loop : P.loop, watch: a.watch != null ? a.watch : P.watch, capacidades: P.capacidades, listo: !!(a.listo || P.listo) });
    case 'builder-ready': return require('./teams-builder.cjs').listo(root, { session_id: a.sesion || a.session_id || P.session_id, loop: a.loop != null ? a.loop : P.loop, watch: a.watch != null ? a.watch : P.watch });
    case 'status': return Object.assign(estado(root), { goal: require('./goal-check.cjs').evaluar(root, { sprint_id: a.sprint || null }) });
    case 'progress': return require('./teams-cierre.cjs').avance(root);
    case 'pause': return pausar(root);
    case 'resume': return continuar(root);
    case 'disable': return desactivar(root);
    case 'pending': return pendientes(root);
    case 'resolve': return resolver(root, { pending_id: a.pending_id, decision: a.decision, decided_by: a.decided_by || 'humano', origen: a.origen });
    case 'import': return importarRespuesta(root, a.texto != null ? a.texto : fs.readFileSync(path.resolve(root, a.archivo), 'utf8'));
    case 'revalidate': return revalidar(root, { task_id: a.task_id || P.task_id, gates: a.gates || P.gates || [], sin_efecto: a.sin_efecto || P.sin_efecto || null, event_id: a.event_id || P.event_id || null });
    case 'verify': {
      const r = verificar(root, { task_id: a.task_id, expected_revision: a.expected_revision, event_id: a.event_id, gates: a.gates || [] });
      // Verificada → su cierre entra al núcleo común de Agentix (outbox, idempotente). Un fallo del puente no cambia el veredicto.
      if (r && r.status === 'DONE_VERIFIED') { try { r.memoria = require('./teams-puente.cjs').alVerificar(root, a.task_id).status || 'EN_COLA'; } catch { r.memoria = 'PUENTE_NO_DISPONIBLE'; } }
      return r;
    }
    case 'stop': return stop(root, a);
    case 'views': return regenerarVistas(root);
    case 'findings': {
      const fn = SUB_CORRECCIONES[String(a.sub || P.sub || 'listar')];
      const m = require('./teams-correcciones.cjs');
      return fn ? m[fn](root, P) : { status: 'SUBACCION_DESCONOCIDA', validas: Object.keys(SUB_CORRECCIONES) };
    }
    case 'review': {
      const fn = SUB_REVISION[String(a.sub || P.sub || 'estado')];
      const m = require('./teams-revision.cjs');
      const r = fn ? m[fn](root, P) : { status: 'SUBACCION_DESCONOCIDA', validas: Object.keys(SUB_REVISION) };
      // Un informe de revisor se enlaza al ciclo de la entrega revisada (no crea otro ciclo).
      if (r && r.review_id && !r.duplicado && P.verdict && P.task_id) {
        try { const t = leerTarea(root, P.task_id); if (t) require('./teams-puente.cjs').alRevisar(root, { plan_id: t.plan_id, task_id: P.task_id, revisor: P.role, subject_hash: P.subject_hash, veredicto: P.verdict, scope: P.scope_kind || 'TASK', motivo: P.justification || undefined }); } catch { /* auxiliar */ }
      }
      return r;
    }
    case 'close': return require('./teams-cierre.cjs').cerrar(root, P);
    case 'close-ack': return require('./teams-cierre.cjs').ack(root, P);
    case 'close-confirm': return require('./teams-cierre.cjs').confirmar(root, P);
    case 'reopen-campaign': return require('./teams-cierre.cjs').reabrirCampana(root, P);
    case 'memory-mark': return require('./teams-cierre.cjs').marcarMemoria(root, P);
    case 'round': return require('./teams-md-session.cjs').ronda(root, P);
    case 'report': return require('./teams-md-session.cjs').reportar(root, P);
    case 'import-channel': return require('./teams-canal.cjs').importarManual(root, P);
    default: return { status: 'ACCION_DESCONOCIDA', accion: accionPedida };
  }
}

module.exports = {
  ejecutarAccion,
  SCHEMA, SCHEMA_V1, SCHEMA_V2, SCHEMA_VERSION, ESTADOS, ESTADOS_FLUJO, ALCANCES, LIMITES_DEFECTO, ROLES_DEFECTO, GATES_CRITICOS,
  init, pausar, continuar, desactivar, activo, versionEsquema,
  validarTarea, validarPlan, crearPlan, revisarPlan, normalizarReferencias,
  asignar, ack, heartbeat, entregarResultado, verificar, revalidar, gatesRequeridos, verificacionesEnEspera,
  stop, pendientes, resolver, registrarOrigenHumano, restauracionFallida,
  enlazarPunto, marcarRevertida, reintentar, invalidarPorRestore, actividadConstructor,
  estado, leerTarea, delta, ackSeq, regenerarVistas, importarRespuesta, parsearIntencion,
  normalizarRecurso,
  /* Interno de la capa v2 (correcciones, revisores, cierre, canal): mismas primitivas transaccionales, una sola fuente de verdad. */
  _i: {
    tx, tx2, lectura, lectura2, sesion, publicar, tarea, tareas, fila, transicionar, siguienteFencing, normalizarRecurso, js, pj, sha, ahoraIso, errorTeams,
    tieneEsquemaV2, flujoDe, upsertFlujo, limitesDe, entregaHabilita, hayBloqueantesAbiertos, marcarDependientesRevalidar, recalcular, descendientes, abrirStop,
    dbPath, dirTeams, escribirAtomico, seccionHumana, MARCA_HUMANA_INICIO, MARCA_HUMANA_FIN, normalizarChecks,
  },
};

// El CLI va DESPUÉS de module.exports: los módulos v2 (builder, cierre, correcciones...) leen `tm._i` al cargarse y,
// ejecutado como script, el bloque anterior los cargaba con las exportaciones aún vacías (connect-builder fallaba).
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
  if (accion === 'revise-plan' || accion === 'revisar-plan') a.params = JSON.parse(fs.readFileSync(path.resolve(root, opt.archivo), 'utf8'));
  if (accion === 'revalidate' || accion === 'revalidar') { a.task_id = pos[1]; if (opt.gates) a.gates = JSON.parse(fs.readFileSync(path.resolve(root, opt.gates), 'utf8')); }
  if (accion === 'verify') { a.task_id = pos[1]; if (opt.gates) a.gates = JSON.parse(fs.readFileSync(path.resolve(root, opt.gates), 'utf8')); }
  let r;
  try { r = ejecutarAccion(root, accion, a); } catch (e) { r = { status: e.code || 'ERROR', detalle: e.message }; }
  console.log(JSON.stringify(r, null, 2));
  if (r && /INVALIDO|DESCONOCID|ERROR|NO_VERIFICADO/.test(String(r.status || ''))) process.exitCode = 1;
}
