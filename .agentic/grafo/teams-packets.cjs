#!/usr/bin/env node
'use strict';
/**
 * Paquete de contexto compartido director <-> constructor (H02 "Contrato TEAMS").
 *
 * Objetivo: que el director y el constructor NO vuelvan a leer el mismo historial
 * ni el mismo código en cada vuelta. Cada rol recibe un estado compacto (snapshot)
 * y, mientras confirme lo que recibe, solo los cambios (delta).
 *
 * NO duplica el protocolo de TEAMS: el reparto, el ACK de la ENTREGA, los leases y
 * el fencing siguen siendo de teams-manager.cjs. Esto añade, encima:
 *   · un paquete versionado por (tarea, receptor) con revisión monótona;
 *   · un ACK que identifica REVISIÓN y HASH recibidos (no un "recibido" genérico);
 *   · deltas SOLO contra la revisión que el receptor confirmó (base_revision);
 *   · idempotencia de envío, de ACK y de EJECUCIÓN (el token de ejecución es el
 *     fencing de TEAMS: un zombi con fencing viejo no ejecuta ni completa);
 *   · pins de evidencia mientras la tarea/sprint/plan estén activos;
 *   · invalidación por cambio de código o de memoria;
 *   · validación de la entrega del constructor contra los ORIGINALES.
 *
 * Reglas con prueba:
 *   · Un delta con base distinta a la del receptor NO se aplica: se pide snapshot.
 *   · Un snapshot/delta con cuerpo alterado en tránsito NO se aplica.
 *   · Entrega duplicada (mismo contenido, mismo ACK, misma ejecución) no repite nada.
 *   · El director no confía en el informe del constructor: un PASS sin evidencia,
 *     con evidencia inexistente, cambiada o de otra versión se RECHAZA.
 *   · Una decisión de negocio NO bloqueante queda registrada y se continúa; una
 *     dependencia bloqueante jamás se da por resuelta por el paso del tiempo.
 *   · Tras la muerte de cualquiera de los dos roles se recupera de la base: no hay
 *     estado efímero que perder ni ejecución que repetir.
 *
 * Límite honesto: aquí se prueba el PROTOCOLO con receptores simulados. Que Cursor
 * o Claude Code lean y respondan estos mensajes dentro de su host es una prueba de
 * host real que este módulo no certifica.
 *
 * Persistencia: mem_context_packets (tabla de 3.20.1). Lectura no migra: sin la
 * tabla devuelve SCHEMA_MISSING y manda a `akdd update`.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const core = require('./memory-core.cjs');
const privacy = require('./memory-privacy.cjs');
const evidence = require('./evidence-store.cjs');

const SCHEMA_VERSION = 1;
/** Campos EXACTOS del contrato (H02). Un snapshot lleva todos y ninguno más. */
const CAMPOS_CONTRATO = Object.freeze([
  'schema_version', 'project_id', 'plan_id', 'sprint_id', 'task_id', 'sender_role', 'recipient_role', 'revision', 'base_revision', 'created_at',
  'objective', 'acceptance', 'scope', 'risk_tier', 'protected_contract_refs', 'decision_refs', 'changed_files', 'evidence_refs',
  'pending_business_decisions', 'blockers', 'next_actions', 'effort_usage',
]);
const CAMPOS_SOBRE = Object.freeze(CAMPOS_CONTRATO.slice(0, 10));
const CAMPOS_CONTENIDO = Object.freeze(CAMPOS_CONTRATO.slice(10));
const RIESGOS = ['LOW', 'MEDIUM', 'HIGH'];
const TERMINALES = new Set(['STALE', 'CLOSED']);
const LIMITES = Object.freeze({ max_paquete_bytes: 256 * 1024, delta_ratio: 0.7, max_items: 200 });

const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
const iso = (o) => new Date(o && o.now ? o.now : Date.now()).toISOString();
const falla = (code, message, extra) => ({ ok: false, status: code, code, message, ...(extra || {}) });
const normRel = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');
const RE_EV = /^ev_[a-f0-9]{16,64}$/;

/** JSON canónico (claves ordenadas): el mismo contenido da siempre el mismo hash. */
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
const pick = (o, campos) => Object.fromEntries(campos.map((c) => [c, o[c] === undefined ? null : o[c]]));
/** Hash del CONTENIDO (sin revisión ni fecha): lo que dice igual aunque se reenvíe. */
const hashContenido = (c) => sha(canon(pick(c, CAMPOS_CONTENIDO)));
/** Igual pero SIN effort_usage: el consumo cambia con cada envío y no es una razón para abrir otra revisión (duplicado = mismo estado de trabajo). */
const hashSemantico = (c) => sha(canon(pick(c, CAMPOS_CONTENIDO.filter((k) => k !== 'effort_usage'))));

// ─── acceso a la base ────────────────────────────────────────────────────────

function conBase(root, write, fn) {
  let db = null;
  try {
    db = core.abrir(root, { write });
    if (!db) return falla('NO_DB', 'No hay memoria.db en este proyecto (akdd init).');
    const faltan = core.tablasFaltantes(db, ['mem_context_packets', 'mem_project']);
    if (faltan.length) return falla('SCHEMA_MISSING', 'Faltan tablas (' + faltan.join(', ') + '): ejecuta akdd update. La lectura no migra en silencio.', { missing: faltan });
    return fn(db);
  } catch (e) {
    return falla(e && e.code === 'UPDATE_IN_PROGRESS' ? 'UPDATE_IN_PROGRESS' : ((e && e.code) || 'PACKETS_ERROR'), e && e.message);
  } finally { try { if (db) db.close(); } catch { /* ya cerrada */ } }
}

/** BEGIN IMMEDIATE: los emisores concurrentes se serializan y no chocan en la revisión. Sin transacciones reales (sql.js), mejor esfuerzo. */
function enTransaccion(db, fn) {
  if (!db.capabilities || !db.capabilities.transactions) return fn();
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch { /* el error original manda */ } throw e; }
}

function identidadProyecto(db, root, opts) {
  const fila = db.get('SELECT project_id, canonical_root FROM mem_project WHERE singleton = 1');
  const actual = core.canonicalRoot(root);
  if (!fila) {
    const pid = 'prj_' + crypto.randomUUID().replace(/-/g, '');
    db.run('INSERT OR IGNORE INTO mem_project (singleton, project_id, canonical_root, created_at, origin) VALUES (1, ?, ?, ?, ?)', pid, actual, iso(opts), 'created');
    return { project_id: db.get('SELECT project_id FROM mem_project WHERE singleton = 1').project_id };
  }
  if (fila.canonical_root !== actual) return { error: falla('PROJECT_ROOT_MISMATCH', 'La memoria pertenece a otra ruta: akdd memory project adopt|fork') };
  return { project_id: fila.project_id };
}

const packetId = (pid, task, recip, rev) => 'pk_' + sha([pid, task, recip, rev].join('|')).slice(0, 24);

// ─── contrato: validación y normalización ────────────────────────────────────

function validarContrato(p) {
  const errores = [];
  if (!p || typeof p !== 'object') return ['el paquete no es un objeto'];
  for (const c of CAMPOS_CONTRATO) if (!Object.prototype.hasOwnProperty.call(p, c)) errores.push('falta el campo ' + c);
  for (const c of Object.keys(p)) if (!CAMPOS_CONTRATO.includes(c)) errores.push('campo fuera del contrato: ' + c);
  if (p.schema_version !== SCHEMA_VERSION) errores.push('schema_version no soportada: ' + p.schema_version);
  if (!p.task_id) errores.push('task_id obligatorio');
  if (!['director', 'builder'].includes(p.sender_role) || !['director', 'builder'].includes(p.recipient_role)) errores.push('sender_role/recipient_role deben ser director|builder');
  else if (p.sender_role === p.recipient_role) errores.push('emisor y receptor no pueden ser el mismo rol');
  if (!Number.isInteger(p.revision) || p.revision < 1) errores.push('revision debe ser entero >= 1');
  if (!RIESGOS.includes(p.risk_tier)) errores.push('risk_tier debe ser LOW|MEDIUM|HIGH');
  for (const c of ['acceptance', 'protected_contract_refs', 'decision_refs', 'changed_files', 'evidence_refs', 'pending_business_decisions', 'blockers', 'next_actions']) {
    if (p[c] !== undefined && !Array.isArray(p[c])) errores.push(c + ' debe ser una lista');
  }
  return errores;
}

function texto(root, v, politica) {
  const r = privacy.redactar(String(v == null ? '' : v), politica);
  return r === privacy.FALLO ? null : r;
}

/** Hash de un archivo del proyecto (ruta resuelta y acotada). Privado/ausente: null con su motivo. */
function hashArchivo(root, rel) {
  try {
    const r = require('./context-reuse.cjs').resolverArchivo(root, rel);
    if (!r.ok) return { sha256: null, motivo: r.code === 'PRIVATE_NOT_DELIVERED' ? 'PRIVATE' : (r.code === 'NOT_FOUND' ? 'DELETED' : r.code) };
    return { sha256: sha(fs.readFileSync(r.real)), motivo: null };
  } catch { return { sha256: null, motivo: 'UNREADABLE' }; }
}

/** Hash del sujeto = lo que existe en disco ahora para esos archivos. Lo calcula el director; no se confía en el del constructor. */
function subjectHash(root, paths) {
  const lineas = [...new Set((paths || []).map(normRel))].sort().map((p) => p + ':' + (hashArchivo(root, p).sha256 || 'ausente'));
  return sha(lineas.join('\n'));
}
const evidenciaScope = (task_id, subject) => task_id + '@' + subject;

/** Hash del contenido de un nodo de memoria (para detectar que cambió una decisión citada). null si no se puede leer. */
function hashDecision(root, id) {
  try {
    const db = core.abrir(root);
    if (!db) return null;
    try {
      if (core.tablasFaltantes(db, ['nodos']).length) return null;
      const f = db.get('SELECT titulo, contenido, estado, confianza FROM nodos WHERE id = ?', id);
      return f ? sha([f.titulo, f.contenido, f.estado, f.confianza].join('\u0001')) : 'AUSENTE';
    } finally { db.close(); }
  } catch { return null; }
}

/**
 * Normaliza lo que el llamador aporta al CONTENIDO del paquete: redacta secretos, calcula hashes de archivos
 * y de decisiones, y exige que cada evidencia citada exista y sea verificable. Devuelve { ok, contenido }.
 */
function armar(root, e = {}) {
  const pol = privacy.cargarPolitica(root);
  const rojo = (v) => texto(root, v, pol);
  const items = (a) => (Array.isArray(a) ? a : []).slice(0, LIMITES.max_items);
  if (!RIESGOS.includes(e.risk_tier)) return falla('RIESGO_INVALIDO', 'risk_tier debe ser LOW|MEDIUM|HIGH');
  const objective = rojo(e.objective);
  if (objective === null) return falla('REDACCION_FALLIDA', 'no se pudo redactar el objetivo');
  const acceptance = items(e.acceptance).map(rojo);
  if (acceptance.includes(null)) return falla('REDACCION_FALLIDA', 'no se pudo redactar un criterio de aceptación');

  const scopeIn = Array.isArray(e.scope) ? { allowed_files: e.scope } : (e.scope || {});
  const scope = { ...scopeIn, allowed_files: [...new Set(items(scopeIn.allowed_files).map(normRel))].sort() };

  const changed_files = items(e.changed_files).map((f) => {
    const rel = normRel(typeof f === 'string' ? f : f && f.path);
    if (typeof f === 'object' && f && Object.prototype.hasOwnProperty.call(f, 'sha256')) return { path: rel, sha256: f.sha256 };
    const h = hashArchivo(root, rel);
    return h.sha256 ? { path: rel, sha256: h.sha256 } : { path: rel, sha256: null, motivo: h.motivo };
  }).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const decision_refs = items(e.decision_refs).map((d) => {
    const id = typeof d === 'object' && d ? d.id : d;
    const ch = typeof d === 'object' && d && Object.prototype.hasOwnProperty.call(d, 'content_hash') ? d.content_hash : hashDecision(root, id);
    return { id: String(id), content_hash: ch };
  }).sort((a, b) => (a.id < b.id ? -1 : 1));

  const evidence_refs = [];
  for (const r of items(e.evidence_refs)) {
    const id = typeof r === 'string' ? r : r && r.evidence_id;
    if (!RE_EV.test(String(id || ''))) return falla('EVIDENCE_REF_INVALIDA', 'referencia de evidencia mal formada: ' + String(id).slice(0, 60));
    // Los refs que vienen de nuestro propio estado previo (decisiones, resoluciones) no se re-verifican: la vigencia se juzga aparte (validarVigencia).
    const previa = e.sin_reverificar_evidencia && typeof r === 'object' && r && r.sha256 ? { ok: true, sha256: r.sha256 } : null;
    const v = previa || evidence.verificar(root, id);
    if (!v.ok) return falla('EVIDENCE_NO_VERIFICABLE', 'la evidencia ' + id + ' no se puede verificar (' + v.code + '): un paquete no cita lo que no existe', { evidence_id: id, evidence_code: v.code });
    const extra = typeof r === 'object' && r ? { ...(r.criterio ? { criterio: String(r.criterio).slice(0, 200) } : {}), ...(r.gate ? { gate: String(r.gate).slice(0, 60) } : {}) } : {};
    evidence_refs.push({ evidence_id: id, sha256: v.sha256, ...extra });
  }
  evidence_refs.sort((a, b) => (a.evidence_id < b.evidence_id ? -1 : 1));

  const pending = items(e.pending_business_decisions).map((d) => {
    const q = rojo(typeof d === 'string' ? d : d.question);
    const id = (d && d.id) || 'D-' + sha(String(q)).slice(0, 8);
    return { id: String(id), question: q, blocking: !!(d && d.blocking), ...(d && d.assumed ? { assumed: rojo(d.assumed) } : {}), ...(d && d.since ? { since: d.since } : {}) };
  }).sort((a, b) => (a.id < b.id ? -1 : 1));
  const blockers = items(e.blockers).map((b) => ({ id: String(b.id || 'B-' + sha(canon(b)).slice(0, 8)), tipo: b.tipo || 'TECNICO', ref: b.ref != null ? String(b.ref) : null, blocking: b.blocking !== false, ...(b.since ? { since: b.since } : {}), ...(b.detalle ? { detalle: rojo(b.detalle) } : {}) })).sort((a, b) => (a.id < b.id ? -1 : 1));
  const next_actions = items(e.next_actions).map((a) => (typeof a === 'string' ? rojo(a) : { ...a, ...(a.action ? { action: rojo(a.action) } : {}) }));

  let effort_usage = e.effort_usage;
  if (effort_usage === undefined) {
    try { effort_usage = require('./effort-budget.cjs').resumenParaPaquete(root, e.effort_task_id || e.task_id); } catch { effort_usage = { disponible: false, code: 'SIN_PRESUPUESTO' }; }
  }
  return {
    ok: true,
    contenido: {
      objective, acceptance, scope, risk_tier: e.risk_tier,
      protected_contract_refs: [...new Set(items(e.protected_contract_refs).map(String))].sort(),
      decision_refs, changed_files, evidence_refs, pending_business_decisions: pending, blockers, next_actions,
      effort_usage: effort_usage || { disponible: false },
    },
  };
}

// ─── reconstrucción de estados ───────────────────────────────────────────────

/** Contrato completo (snapshot) de una fila: orden de campos fijo para que su hash sea determinista. */
function contratoDe(row, contenido) {
  const sobre = { schema_version: SCHEMA_VERSION, project_id: row.project_id, plan_id: row.plan_id || null, sprint_id: row.sprint_id || null, task_id: row.task_id, sender_role: row.sender_role, recipient_role: row.recipient_role, revision: Number(row.revision), base_revision: null, created_at: row.created_at };
  const out = {};
  for (const c of CAMPOS_CONTRATO) out[c] = c in sobre ? sobre[c] : (contenido[c] === undefined ? null : contenido[c]);
  return out;
}

/** Estado (contenido) de la revisión R reconstruido: snapshot directo, o delta aplicado sobre su base. */
function estadoEn(filas, rev, memo = new Map(), pila = new Set()) {
  if (memo.has(rev)) return memo.get(rev);
  const fila = filas.get(rev);
  if (!fila || pila.has(rev)) return null;
  pila.add(rev);
  let res = null;
  let cuerpo = null;
  try { cuerpo = JSON.parse(fila.body); } catch { cuerpo = null; }
  if (cuerpo) {
    if (fila.kind === 'snapshot') res = pick(cuerpo, CAMPOS_CONTENIDO);
    else if (fila.kind === 'delta') {
      const base = estadoEn(filas, Number(fila.base_revision), memo, pila);
      if (base) {
        res = { ...base };
        const set = (cuerpo.delta && cuerpo.delta.set) || {};
        for (const k of Object.keys(set)) if (CAMPOS_CONTENIDO.includes(k)) res[k] = set[k];
      }
    }
  }
  pila.delete(rev);
  memo.set(rev, res);
  return res;
}

const filasDe = (db, pid, task, recip) => new Map(db.all('SELECT * FROM mem_context_packets WHERE project_id = ? AND task_id = ? AND recipient_role = ? ORDER BY revision', pid, task, recip).map((f) => [Number(f.revision), f]));

function envolver(row, { snapshot = false, contenido } = {}) {
  if (!snapshot || row.kind === 'snapshot') return { packet_id: row.packet_id, kind: row.kind, revision: Number(row.revision), base_revision: row.base_revision == null ? null : Number(row.base_revision), body_hash: row.body_hash, body: row.body, status: row.status };
  // Un delta pedido en forma de snapshot (receptor sin base): mismo estado, cuerpo completo y determinista.
  const cuerpo = JSON.stringify(contratoDe(row, contenido));
  return { packet_id: row.packet_id, kind: 'snapshot', revision: Number(row.revision), base_revision: null, body_hash: sha(cuerpo), body: cuerpo, status: row.status, desde_delta: true };
}

// ─── enviar ──────────────────────────────────────────────────────────────────

/**
 * Entrega de estado a un receptor. Idempotente: el mismo contenido que la última revisión vigente
 * devuelve ESA revisión (DUPLICADO) y no abre otra. Snapshot si el receptor no confirmó nada
 * (o se reinició, o se invalidó); delta solo contra la última revisión que SÍ confirmó.
 *
 * e: task_id, plan_id, sprint_id, sender_role, recipient_role + los campos de contenido (ver armar).
 *    forzar_snapshot, pin_scope ('task'|'sprint'|'plan', por defecto task), effort_task_id, now.
 */
function enviar(root, e = {}) {
  if (!e.task_id || !/^[\w.-]{1,80}$/.test(String(e.task_id))) return falla('TASK_ID_INVALIDO', 'task_id obligatorio');
  if (!['director', 'builder'].includes(e.sender_role) || !['director', 'builder'].includes(e.recipient_role) || e.sender_role === e.recipient_role) return falla('ROLES_INVALIDOS', 'sender_role y recipient_role deben ser director|builder y distintos');
  const arm = armar(root, e);
  if (!arm.ok) return arm;
  const contenido = arm.contenido;
  const hashC = hashContenido(contenido);

  const r = conBase(root, true, (db) => enTransaccion(db, () => {
    const id = identidadProyecto(db, root, e);
    if (id.error) return id.error;
    const pid = id.project_id;
    const filas = filasDe(db, pid, e.task_id, e.recipient_role);
    const ultima = filas.size ? filas.get(Math.max(...filas.keys())) : null;
    if (ultima && ultima.status === 'CLOSED' && !e.reabrir) return falla('TAREA_CERRADA', 'el flujo de esta tarea ya se cerró; no se envían más paquetes', { revision: Number(ultima.revision) });
    const memo = new Map();
    if (ultima && !TERMINALES.has(ultima.status)) {
      const est = estadoEn(filas, Number(ultima.revision), memo);
      if (est && hashSemantico(est) === hashSemantico(contenido)) {
        // Mismo estado ya enviado: no hay revisión nueva. El receptor sin base recibe la forma snapshot.
        const base = [...filas.values()].filter((f) => f.acked_revision != null && !TERMINALES.has(f.status));
        return { ok: true, status: 'DUPLICADO', duplicado: true, ...resumenFila(ultima), packet: envolver(ultima, { snapshot: !base.length, contenido: est }) };
      }
    }
    const revision = (ultima ? Number(ultima.revision) : 0) + 1;
    const createdAt = iso(e);
    const sobre = { schema_version: SCHEMA_VERSION, project_id: pid, plan_id: e.plan_id || null, sprint_id: e.sprint_id || null, task_id: e.task_id, sender_role: e.sender_role, recipient_role: e.recipient_role, revision, created_at: createdAt };
    const filaTmp = { ...sobre, revision };
    const snapshotCuerpo = JSON.stringify(contratoDe(filaTmp, contenido));
    if (Buffer.byteLength(snapshotCuerpo) > LIMITES.max_paquete_bytes) return falla('PAQUETE_DEMASIADO_GRANDE', 'el estado excede el límite de un paquete; reduce lo que cita (no se trunca en silencio)', { bytes: Buffer.byteLength(snapshotCuerpo) });
    // Base del delta: la última revisión CONFIRMADA por el receptor y todavía vigente.
    const confirmadas = [...filas.values()].filter((f) => f.acked_revision != null && !TERMINALES.has(f.status)).sort((a, b) => Number(b.acked_revision) - Number(a.acked_revision));
    let kind = 'snapshot'; let cuerpo = snapshotCuerpo; let baseRev = null;
    if (!e.forzar_snapshot && confirmadas.length) {
      const base = confirmadas[0];
      const estBase = estadoEn(filas, Number(base.revision), memo);
      if (estBase) {
        const set = {};
        for (const c of CAMPOS_CONTENIDO) if (canon(estBase[c]) !== canon(contenido[c])) set[c] = contenido[c];
        const candidato = JSON.stringify({ ...sobre, base_revision: Number(base.revision), delta: { set }, result_hash: hashC, snapshot_bytes: Buffer.byteLength(snapshotCuerpo) });
        if (Buffer.byteLength(candidato) < Buffer.byteLength(snapshotCuerpo) * LIMITES.delta_ratio) { kind = 'delta'; cuerpo = candidato; baseRev = Number(base.revision); }
      }
    }
    const row = { packet_id: packetId(pid, e.task_id, e.recipient_role, revision), schema_version: SCHEMA_VERSION, project_id: pid, plan_id: e.plan_id || null, sprint_id: e.sprint_id || null, task_id: e.task_id, sender_role: e.sender_role, recipient_role: e.recipient_role, revision, base_revision: baseRev, kind, body: cuerpo, body_hash: sha(cuerpo), status: 'SENT', created_at: createdAt };
    db.run(`INSERT INTO mem_context_packets (packet_id, schema_version, project_id, plan_id, sprint_id, task_id, sender_role, recipient_role, revision, base_revision, kind, body, body_hash, status, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, row.packet_id, row.schema_version, row.project_id, row.plan_id, row.sprint_id, row.task_id, row.sender_role, row.recipient_role, row.revision, row.base_revision, row.kind, row.body, row.body_hash, row.status, row.created_at);
    return { ok: true, status: 'ENVIADO', duplicado: false, ...resumenFila(row), snapshot_bytes: Buffer.byteLength(snapshotCuerpo), delivered_bytes: Buffer.byteLength(cuerpo), packet: envolver(row), _evidencias: contenido.evidence_refs.map((x) => x.evidence_id) };
  }));
  if (!r.ok) return r;
  // Efectos laterales FUERA de la transacción (cada módulo abre su propia conexión): pins y presupuesto.
  const evs = r._evidencias || [];
  delete r._evidencias;
  if (!r.duplicado) {
    const owner = e.pin_scope === 'sprint' && e.sprint_id ? ['sprint', e.sprint_id] : e.pin_scope === 'plan' && e.plan_id ? ['plan', e.plan_id] : ['task', e.task_id];
    r.pins = evs.map((id) => { const p = evidence.fijar(root, id, owner[0], owner[1], e); return { evidence_id: id, pinned: !!p.ok, ...(p.ok ? {} : { code: p.code }) }; });
    try {
      require('./effort-budget.cjs').registrar(root, e.effort_task_id || e.task_id, { kind: r.kind === 'delta' ? 'packet_delta' : 'packet_sent', role: e.sender_role, original_bytes: r.snapshot_bytes, delivered_bytes: r.delivered_bytes, detail: `paquete r${r.revision} ${r.kind}` }, e);
    } catch { /* el presupuesto es auxiliar */ }
  }
  return r;
}

const resumenFila = (row) => ({ packet_id: row.packet_id, revision: Number(row.revision), base_revision: row.base_revision == null ? null : Number(row.base_revision), kind: row.kind, body_hash: row.body_hash, bytes: Buffer.byteLength(row.body) });

// ─── receptor (lado puro: lo ejecuta quien recibe) ───────────────────────────

/**
 * Lógica del RECEPTOR, sin base de datos. `estado` es lo que el receptor ya tiene ({revision, contenido, task_id, ...})
 * o null tras un reinicio. Devuelve { status, estado, ack } y NUNCA un estado a medias:
 *   APLICADO      estado nuevo; `ack` identifica revisión y hash recibidos.
 *   DUPLICADO     misma revisión: no se vuelve a aplicar (ni a ejecutar); se re-acusa.
 *   OBSOLETO      llegó una revisión anterior (orden): se ignora.
 *   PIDE_SNAPSHOT delta con base que no coincide, cuerpo alterado, resultado distinto o receptor sin estado.
 */
function recibir(estado, paquete) {
  if (!paquete || typeof paquete.body !== 'string') return { status: 'PIDE_SNAPSHOT', motivo: 'PAQUETE_ILEGIBLE', estado };
  if (sha(paquete.body) !== paquete.body_hash) return { status: 'PIDE_SNAPSHOT', motivo: 'CUERPO_ALTERADO', estado };
  let obj;
  try { obj = JSON.parse(paquete.body); } catch { return { status: 'PIDE_SNAPSHOT', motivo: 'CUERPO_ILEGIBLE', estado }; }
  const ack = { revision: Number(paquete.revision), hash: paquete.body_hash };
  if (estado && (estado.task_id !== obj.task_id || (estado.recipient_role && estado.recipient_role !== obj.recipient_role))) return { status: 'PIDE_SNAPSHOT', motivo: 'PAQUETE_DE_OTRO_FLUJO', estado };
  if (estado && Number(paquete.revision) < estado.revision) return { status: 'OBSOLETO', estado, ack };
  if (estado && Number(paquete.revision) === estado.revision) {
    // Un snapshot es AUTORIDAD: si su contenido difiere del que el receptor cree tener, lo reemplaza (estado divergido).
    if (paquete.kind === 'snapshot' && !validarContrato(obj).length && hashContenido(pick(obj, CAMPOS_CONTENIDO)) !== hashContenido(estado.contenido)) {
      const nuevo = { revision: obj.revision, task_id: obj.task_id, recipient_role: obj.recipient_role, project_id: obj.project_id, contenido: pick(obj, CAMPOS_CONTENIDO) };
      return { status: 'APLICADO', estado: nuevo, ack: { ...ack, state_hash: hashContenido(nuevo.contenido) }, reemplazo: true };
    }
    return { status: 'DUPLICADO', estado, ack: { ...ack, state_hash: hashContenido(estado.contenido) } };
  }
  if (paquete.kind === 'snapshot') {
    const errs = validarContrato(obj);
    if (errs.length) return { status: 'PIDE_SNAPSHOT', motivo: 'SNAPSHOT_FUERA_DE_CONTRATO', errores: errs, estado };
    const nuevo = { revision: obj.revision, task_id: obj.task_id, recipient_role: obj.recipient_role, project_id: obj.project_id, contenido: pick(obj, CAMPOS_CONTENIDO) };
    return { status: 'APLICADO', estado: nuevo, ack: { ...ack, state_hash: hashContenido(nuevo.contenido) } };
  }
  if (paquete.kind === 'delta') {
    if (!estado) return { status: 'PIDE_SNAPSHOT', motivo: 'SIN_ESTADO_BASE', estado };
    if (estado.revision !== obj.base_revision) return { status: 'PIDE_SNAPSHOT', motivo: 'BASE_NO_COINCIDE', tiene: estado.revision, base_pedida: obj.base_revision, estado };
    const contenido = { ...estado.contenido };
    for (const [k, v] of Object.entries((obj.delta && obj.delta.set) || {})) { if (!CAMPOS_CONTENIDO.includes(k)) return { status: 'PIDE_SNAPSHOT', motivo: 'DELTA_FUERA_DE_CONTRATO', campo: k, estado }; contenido[k] = v; }
    if (hashContenido(contenido) !== obj.result_hash) return { status: 'PIDE_SNAPSHOT', motivo: 'RESULTADO_NO_COINCIDE', estado };
    return { status: 'APLICADO', estado: { ...estado, revision: obj.revision, contenido }, ack: { ...ack, state_hash: obj.result_hash } };
  }
  return { status: 'PIDE_SNAPSHOT', motivo: 'KIND_DESCONOCIDO', estado };
}

// ─── ACK, reinicio y recuperación (lado del director) ────────────────────────

function limpiarAcks(db, pid, task, recip) {
  return db.run("UPDATE mem_context_packets SET acked_revision = NULL, acked_hash = NULL, acked_at = NULL, status = CASE WHEN status = 'ACKED' THEN 'SENT' ELSE status END WHERE project_id = ? AND task_id = ? AND recipient_role = ? AND status NOT IN ('STALE','CLOSED')", pid, task, recip).changes;
}

/**
 * ACK de un paquete: identifica REVISIÓN y HASH recibidos. Idempotente y tolerante al orden
 * (un ACK de la revisión 3 puede llegar antes que el de la 2). Un hash distinto no se acepta
 * y obliga a snapshot: el receptor tiene algo que no es lo que se envió.
 */
function ack(root, a = {}) {
  return conBase(root, true, (db) => enTransaccion(db, () => {
    const id = identidadProyecto(db, root, a);
    if (id.error) return id.error;
    const filas = filasDe(db, id.project_id, a.task_id, a.recipient_role);
    const f = filas.get(Number(a.revision));
    if (!f) return { ok: false, status: 'ACK_DESCONOCIDO', code: 'ACK_DESCONOCIDO', message: 'no existe esa revisión para ese receptor' };
    if (TERMINALES.has(f.status)) return { ok: false, status: 'ACK_DE_PAQUETE_' + f.status, code: 'ACK_DE_PAQUETE_' + f.status, necesita_snapshot: true };
    const memo = new Map();
    const est = estadoEn(filas, Number(f.revision), memo);
    const hashSnapshot = est ? sha(JSON.stringify(contratoDe(f, est))) : null;
    const hashOk = a.hash === f.body_hash || (hashSnapshot && a.hash === hashSnapshot);
    const estadoOk = a.state_hash == null || (est && a.state_hash === hashContenido(est));
    if (!hashOk || !estadoOk) {
      limpiarAcks(db, id.project_id, a.task_id, a.recipient_role);
      return { ok: false, status: 'ACK_HASH_DISTINTO', code: 'ACK_HASH_DISTINTO', necesita_snapshot: true, message: 'el receptor confirma un hash o un estado distintos al enviado: se invalida su base y recibirá un snapshot' };
    }
    if (f.acked_revision != null && f.acked_hash === a.hash) return { ok: true, status: 'ACKED', duplicado: true, primer_ack: false, revision: Number(f.revision) };
    db.run("UPDATE mem_context_packets SET acked_revision = ?, acked_hash = ?, acked_at = ?, status = CASE WHEN status = 'SENT' THEN 'ACKED' ELSE status END WHERE packet_id = ?", Number(f.revision), a.hash, iso(a), f.packet_id);
    return { ok: true, status: 'ACKED', duplicado: false, primer_ack: true, revision: Number(f.revision) };
  }));
}

/** El receptor se reinició o perdió su contexto: sus confirmaciones ya no valen y el siguiente envío será snapshot. */
function reiniciarReceptor(root, { task_id, recipient_role } = {}) {
  const r = conBase(root, true, (db) => enTransaccion(db, () => {
    const id = identidadProyecto(db, root, {});
    if (id.error) return id.error;
    return { ok: true, status: 'RECEPTOR_REINICIADO', acks_invalidados: limpiarAcks(db, id.project_id, task_id, recipient_role) };
  }));
  try { require('./context-reuse.cjs').olvidarReceptor(root, task_id + ':' + recipient_role, { prefijo: true }); } catch { /* caché auxiliar */ }
  return r;
}

/** Estado completo ACTUAL (o de una revisión) como snapshot: lo que pide un receptor con PIDE_SNAPSHOT. No abre revisión nueva. */
function snapshotActual(root, { task_id, recipient_role, revision } = {}) {
  return conBase(root, false, (db) => {
    const id = db.get('SELECT project_id FROM mem_project WHERE singleton = 1');
    if (!id) return falla('SIN_PROYECTO', 'la memoria no tiene identidad de proyecto');
    const filas = filasDe(db, id.project_id, task_id, recipient_role);
    if (!filas.size) return falla('SIN_PAQUETES', 'no hay paquetes para esa tarea y receptor');
    const rev = revision != null ? Number(revision) : Math.max(...filas.keys());
    const f = filas.get(rev);
    if (!f) return falla('REVISION_DESCONOCIDA', 'no existe esa revisión');
    const est = estadoEn(filas, rev);
    if (!est) return falla('ESTADO_IRRECONSTRUIBLE', 'no se pudo reconstruir el estado de esa revisión');
    return { ok: true, status: 'SNAPSHOT', packet: envolver(f, { snapshot: true, contenido: est }), revision: rev, estado_pkt: f.status };
  });
}

/** Qué paquetes siguen sin ACK para un receptor (para reintentos y para vigilar un ACK que no llega). */
function pendientesDeAck(root, { recipient_role, task_id } = {}) {
  return conBase(root, false, (db) => {
    const id = db.get('SELECT project_id FROM mem_project WHERE singleton = 1');
    if (!id) return { ok: true, pendientes: [] };
    const filas = db.all("SELECT * FROM mem_context_packets WHERE project_id = ? AND recipient_role = ? AND acked_revision IS NULL AND status IN ('SENT') " + (task_id ? 'AND task_id = ? ' : '') + 'ORDER BY created_at, revision', ...[id.project_id, recipient_role].concat(task_id ? [task_id] : []));
    return { ok: true, pendientes: filas.map((f) => ({ task_id: f.task_id, ...resumenFila(f), created_at: f.created_at })) };
  });
}

/**
 * Los paquetes pendientes de ACK con su cuerpo (para publicarlos en el canal MD o reintentar la entrega). Un receptor sin
 * base confirmada los recibe en forma SNAPSHOT: un delta no se le puede aplicar.
 */
function paquetesPendientes(root, { recipient_role, task_id } = {}) {
  return conBase(root, false, (db) => {
    const id = db.get('SELECT project_id FROM mem_project WHERE singleton = 1');
    if (!id) return { ok: true, paquetes: [] };
    const filas = db.all("SELECT * FROM mem_context_packets WHERE project_id = ? AND recipient_role = ? AND acked_revision IS NULL AND status = 'SENT' " + (task_id ? 'AND task_id = ? ' : '') + 'ORDER BY created_at, revision', ...[id.project_id, recipient_role].concat(task_id ? [task_id] : []));
    const out = [];
    for (const f of filas) {
      const todas = filasDe(db, id.project_id, f.task_id, f.recipient_role);
      const hayBase = [...todas.values()].some((x) => x.acked_revision != null && !TERMINALES.has(x.status));
      out.push({ task_id: f.task_id, ...envolver(f, { snapshot: !hayBase, contenido: estadoEn(todas, Number(f.revision)) }) });
    }
    return { ok: true, paquetes: out };
  });
}

/**
 * Estado vigente de un flujo, reconstruido DESDE LA BASE (no hay estado efímero): lo que consulta el director
 * o el constructor tras reiniciar. Incluye pendientes humanos, bloqueos, estado de ejecución y pins activos.
 */
function estadoCorriente(root, { task_id, recipient_role } = {}) {
  const r = conBase(root, false, (db) => {
    const id = db.get('SELECT project_id FROM mem_project WHERE singleton = 1');
    if (!id) return falla('SIN_PROYECTO', 'sin paquetes todavía');
    const filas = filasDe(db, id.project_id, task_id, recipient_role);
    if (!filas.size) return falla('SIN_PAQUETES', 'no hay paquetes para esa tarea y receptor');
    const rev = Math.max(...filas.keys());
    const f = filas.get(rev);
    const est = estadoEn(filas, rev);
    const confirmadas = [...filas.values()].filter((x) => x.acked_revision != null && !TERMINALES.has(x.status)).map((x) => Number(x.acked_revision));
    return {
      ok: true, task_id, recipient_role, revision: rev, estado_paquete: f.status, kind: f.kind, contenido: est,
      ultima_confirmada: confirmadas.length ? Math.max(...confirmadas) : null,
      pendientes_humanos: est ? est.pending_business_decisions : [], bloqueos: est ? est.blockers : [],
      ejecucion: ejecucionDe(f.status), project_id: id.project_id,
    };
  });
  if (r.ok) r.pins = pinsActivos(root, 'task', task_id);
  return r;
}

function pinsActivos(root, owner_kind, owner_id) {
  const db = core.abrir(root);
  if (!db) return [];
  try {
    if (core.tablasFaltantes(db, ['mem_evidence_pins']).length) return [];
    return db.all('SELECT evidence_id FROM mem_evidence_pins WHERE owner_kind = ? AND owner_id = ? ORDER BY evidence_id', owner_kind, String(owner_id)).map((x) => x.evidence_id);
  } finally { db.close(); }
}

function ejecucionDe(status) {
  const m = /^(EXECUTING|EXECUTED):(\d+)$/.exec(String(status));
  return m ? { estado: m[1], token: Number(m[2]) } : null;
}

// ─── ejecución idempotente (el token es el fencing de TEAMS) ─────────────────

/**
 * Reclama la EJECUCIÓN de un paquete. Solo un reclamo gana por (paquete, token):
 *   · primera vez            → { ok:true } y queda EXECUTING:<token>
 *   · mismo paquete otra vez → YA_EN_EJECUCION / YA_EJECUTADO (entrega duplicada no repite)
 *   · token MAYOR que el del reclamo en curso → relevo (el anterior murió: su lease venció y TEAMS dio otro fencing)
 *   · token menor o igual → zombi: rechazado
 * No reinventa los leases: el token ES el fencing que ya entrega teams-manager.asignar.
 */
function reclamarEjecucion(root, { task_id, recipient_role, revision, token } = {}) {
  const tok = Number(token);
  if (!Number.isInteger(tok) || tok < 0) return falla('TOKEN_INVALIDO', 'token (fencing) entero >= 0 obligatorio');
  return conBase(root, true, (db) => enTransaccion(db, () => {
    const id = db.get('SELECT project_id FROM mem_project WHERE singleton = 1');
    if (!id) return falla('SIN_PROYECTO', 'sin paquetes todavía');
    const f = db.get('SELECT packet_id, status FROM mem_context_packets WHERE project_id = ? AND task_id = ? AND recipient_role = ? AND revision = ?', id.project_id, task_id, recipient_role, Number(revision));
    if (!f) return falla('PAQUETE_DESCONOCIDO', 'no existe esa revisión');
    if (TERMINALES.has(f.status)) return falla('PAQUETE_INVALIDADO', 'el paquete está ' + f.status + ': no se ejecuta');
    const ej = ejecucionDe(f.status);
    if (!ej) {
      const c = db.run("UPDATE mem_context_packets SET status = ? WHERE packet_id = ? AND status IN ('SENT','ACKED')", 'EXECUTING:' + tok, f.packet_id).changes;
      return c === 1 ? { ok: true, status: 'RECLAMADA', token: tok } : falla('CARRERA_PERDIDA', 'otro reclamo se adelantó');
    }
    if (ej.estado === 'EXECUTED') return { ok: false, status: 'YA_EJECUTADO', code: 'YA_EJECUTADO', token: ej.token, duplicado: true };
    if (tok > ej.token) {
      const c = db.run("UPDATE mem_context_packets SET status = ? WHERE packet_id = ? AND status = ?", 'EXECUTING:' + tok, f.packet_id, 'EXECUTING:' + ej.token).changes;
      return c === 1 ? { ok: true, status: 'RELEVADA', token: tok, anterior: ej.token } : falla('CARRERA_PERDIDA', 'otro reclamo se adelantó');
    }
    return { ok: false, status: 'YA_EN_EJECUCION', code: 'YA_EN_EJECUCION', token: ej.token, duplicado: tok === ej.token, zombi: tok < ej.token };
  }));
}

/** Cierra la ejecución SOLO si el token sigue siendo el vigente (un zombi relevado no puede completar). */
function completarEjecucion(root, { task_id, recipient_role, revision, token } = {}) {
  return conBase(root, true, (db) => enTransaccion(db, () => {
    const id = db.get('SELECT project_id FROM mem_project WHERE singleton = 1');
    if (!id) return falla('SIN_PROYECTO', 'sin paquetes todavía');
    const c = db.run("UPDATE mem_context_packets SET status = ? WHERE project_id = ? AND task_id = ? AND recipient_role = ? AND revision = ? AND status = ?", 'EXECUTED:' + Number(token), id.project_id, task_id, recipient_role, Number(revision), 'EXECUTING:' + Number(token)).changes;
    return c === 1 ? { ok: true, status: 'EJECUTADA', token: Number(token) } : falla('TOKEN_NO_VIGENTE', 'ese token ya no es el dueño de la ejecución (relevado o ya cerrado)');
  }));
}

// ─── vigencia e invalidación ─────────────────────────────────────────────────

/** ¿Lo que cita un contenido sigue siendo cierto? Código por hash, decisiones por hash de nodo, evidencias por su verificación. */
function validarVigencia(root, contenido) {
  const motivos = [];
  const noVerificable = [];
  for (const f of contenido.changed_files || []) {
    if (!f.sha256) continue;
    const h = hashArchivo(root, f.path);
    if (h.sha256 !== f.sha256) motivos.push({ tipo: 'CODIGO', ref: f.path, detalle: h.sha256 ? 'el contenido cambió' : (h.motivo || 'ausente') });
  }
  for (const d of contenido.decision_refs || []) {
    if (!d.content_hash) { noVerificable.push({ tipo: 'MEMORIA', ref: d.id }); continue; }
    const h = hashDecision(root, d.id);
    if (h === null) noVerificable.push({ tipo: 'MEMORIA', ref: d.id });
    else if (h !== d.content_hash) motivos.push({ tipo: 'MEMORIA', ref: d.id, detalle: h === 'AUSENTE' ? 'el nodo ya no existe' : 'el nodo cambió' });
  }
  for (const ev of contenido.evidence_refs || []) {
    const v = evidence.verificar(root, ev.evidence_id);
    if (!v.ok) motivos.push({ tipo: 'EVIDENCIA', ref: ev.evidence_id, detalle: v.code });
    else if (v.sha256 !== ev.sha256) motivos.push({ tipo: 'EVIDENCIA', ref: ev.evidence_id, detalle: 'EVIDENCE_CHANGED' });
  }
  return { vigente: !motivos.length, motivos, no_verificable: noVerificable };
}

/**
 * Cambió código o memoria: los paquetes afectados pasan a STALE (no se ejecutan, no sirven de base de delta)
 * y la siguiente entrega será un snapshot nuevo. `paths` fuerza la invalidación de los flujos que citan
 * esos archivos; sin `paths`, se revalida cada flujo por hash y solo caen los que de verdad cambiaron.
 */
function invalidar(root, o = {}) {
  const lista = conBase(root, false, (db) => {
    const id = db.get('SELECT project_id FROM mem_project WHERE singleton = 1');
    if (!id) return { ok: true, flujos: [], project_id: null };
    const flujos = db.all("SELECT DISTINCT task_id, recipient_role FROM mem_context_packets WHERE project_id = ? AND status NOT IN ('STALE','CLOSED')" + (o.task_id ? ' AND task_id = ?' : ''), ...[id.project_id].concat(o.task_id ? [o.task_id] : []));
    return { ok: true, flujos, project_id: id.project_id };
  });
  if (!lista.ok) return lista;
  const forzar = new Set((o.paths || []).map(normRel));
  const invalidados = [];
  const evidenciasAfectadas = new Set();
  for (const fl of lista.flujos) {
    const cur = estadoCorriente(root, { task_id: fl.task_id, recipient_role: fl.recipient_role });
    if (!cur.ok || !cur.contenido) continue;
    let motivos = [];
    const toca = [...(cur.contenido.changed_files || []).map((f) => f.path), ...((cur.contenido.scope && cur.contenido.scope.allowed_files) || [])].some((p) => forzar.has(p));
    if (toca) motivos.push({ tipo: 'CODIGO', detalle: 'cambio externo declarado: ' + (o.reason || 'CODE_CHANGED') });
    if (o.forzar) motivos.push({ tipo: 'FORZADA', detalle: o.reason || 'invalidación explícita' });
    if (!motivos.length) motivos = validarVigencia(root, cur.contenido).motivos;
    if (!motivos.length) continue;
    conBase(root, true, (db) => enTransaccion(db, () => db.run("UPDATE mem_context_packets SET status = 'STALE', acked_revision = NULL, acked_hash = NULL, acked_at = NULL WHERE project_id = ? AND task_id = ? AND recipient_role = ? AND status NOT IN ('STALE','CLOSED')", lista.project_id, fl.task_id, fl.recipient_role)));
    invalidados.push({ task_id: fl.task_id, recipient_role: fl.recipient_role, motivos });
    for (const ev of cur.contenido.evidence_refs || []) evidenciasAfectadas.add(ev.evidence_id);
  }
  try { require('./context-reuse.cjs').invalidarPorCambio(root, { paths: o.paths || [], reason: o.reason || 'CODE_CHANGED', task_id: o.task_id }); } catch { /* caché auxiliar */ }
  return { ok: true, status: 'INVALIDADO', invalidados, evidencias_afectadas: [...evidenciasAfectadas] };
}

/**
 * La tarea se cerró o se abandonó: los paquetes quedan CLOSED y los pins de la tarea se liberan.
 * Los pins de sprint/plan solo se liberan si se cierra ese nivel (cerrar_sprint / cerrar_plan).
 */
function cerrar(root, { task_id, plan_id, sprint_id, cerrar_sprint, cerrar_plan, motivo = 'CLOSED' } = {}) {
  const r = conBase(root, true, (db) => enTransaccion(db, () => {
    const id = db.get('SELECT project_id FROM mem_project WHERE singleton = 1');
    if (!id) return { ok: true, cerrados: 0 };
    return { ok: true, cerrados: db.run("UPDATE mem_context_packets SET status = 'CLOSED' WHERE project_id = ? AND task_id = ? AND status != 'CLOSED'", id.project_id, task_id).changes };
  }));
  if (!r.ok) return r;
  const liberados = { task: 0, sprint: 0, plan: 0 };
  const a = evidence.soltar(root, 'task', task_id); if (a.ok) liberados.task = a.released;
  if (cerrar_sprint && sprint_id) { const b = evidence.soltar(root, 'sprint', sprint_id); if (b.ok) liberados.sprint = b.released; }
  if (cerrar_plan && plan_id) { const c = evidence.soltar(root, 'plan', plan_id); if (c.ok) liberados.plan = c.released; }
  return { ok: true, status: motivo === 'ABANDONED' ? 'ABANDONADA' : 'CERRADA', paquetes_cerrados: r.cerrados, pins_liberados: liberados };
}

// ─── el director no confía en el informe del constructor ─────────────────────

/** ¿Hay que mirar el DETALLE (originales) y no solo el resumen? Riesgo, contradicción, fallo o cierre que exige prueba. */
function detalleRequerido(ctx = {}) {
  const motivos = [];
  if (ctx.risk_tier === 'HIGH') motivos.push('RIESGO');
  if (ctx.contradiccion) motivos.push('CONTRADICCION');
  if (ctx.fallo) motivos.push('FALLO');
  if (ctx.cierre_exige_prueba) motivos.push('CIERRE_EXIGE_PRUEBA');
  return { requerido: motivos.length > 0, motivos };
}

/** Guarda la salida de un gate como evidencia ATADA a la versión exacta del sujeto (tarea@hash). */
function guardarEvidenciaDeGate(root, { task_id, subject_hash, texto: t, bytes, gate, retention = 'durable_audit' } = {}, opts = {}) {
  if (!task_id || !subject_hash) return falla('SUJETO_REQUERIDO', 'task_id y subject_hash son obligatorios');
  return evidence.guardar(root, bytes ? { bytes } : { text: String(t == null ? '' : t) }, { ...opts, kind: gate ? 'gate:' + gate : 'gate', task_id, scope: evidenciaScope(task_id, subject_hash), retention });
}

function scopeDeEvidencia(root, evidence_id) {
  const db = core.abrir(root);
  if (!db) return null;
  try {
    if (core.tablasFaltantes(db, ['mem_evidence']).length) return null;
    const f = db.get('SELECT scope FROM mem_evidence WHERE evidence_id = ?', evidence_id);
    return f ? f.scope : null;
  } finally { db.close(); }
}

/**
 * Valida lo que el constructor DICE contra lo que EXISTE. entrega:
 *   { task_id, subject_hash?, changed_files:[{path,sha256}], scope?:[rutas permitidas],
 *     criteria:[{ criterio, resultado:'PASS'|..., evidence_ref }], risk_tier?, contradiccion?, fallo?, cierre_exige_prueba?, effort_task_id? }
 * Un PASS exige evidencia que (1) exista, (2) conserve su hash, (3) esté atada al sujeto ACTUAL.
 * Nunca marca DONE: aprobar la evidencia solo HABILITA al director a correr sus gates sobre el sujeto exacto.
 */
function validarEntrega(root, entrega = {}, opts = {}) {
  const rechazos = [];
  const verificados = [];
  const task_id = entrega.task_id;
  if (!task_id) return falla('TASK_ID_INVALIDO', 'task_id obligatorio');
  const archivos = Array.isArray(entrega.changed_files) ? entrega.changed_files : [];
  // El sujeto lo calcula el director desde el disco; el hash declarado por el constructor solo se COMPARA.
  const actual = subjectHash(root, archivos.map((f) => (typeof f === 'string' ? f : f.path)));
  if (entrega.subject_hash && entrega.subject_hash !== actual) rechazos.push({ code: 'SUJETO_NO_COINCIDE', detalle: 'el hash del sujeto declarado no es el de los archivos que existen ahora' });
  for (const f of archivos) {
    if (typeof f === 'string' || !f.sha256) continue;
    const h = hashArchivo(root, f.path);
    if (h.sha256 !== f.sha256) rechazos.push({ code: 'ARCHIVO_CAMBIO_DESPUES', path: normRel(f.path), detalle: 'el archivo ya no tiene el contenido que el constructor declaró' });
  }
  if (Array.isArray(entrega.scope)) {
    const permitidos = new Set(entrega.scope.map(normRel));
    for (const f of archivos) { const p = normRel(typeof f === 'string' ? f : f.path); if (!permitidos.has(p)) rechazos.push({ code: 'FUERA_DE_ALCANCE', path: p }); }
  }
  const criterios = Array.isArray(entrega.criteria) ? entrega.criteria : [];
  if (!criterios.length) rechazos.push({ code: 'SIN_CRITERIOS', detalle: 'una entrega sin criterios verificados no sostiene ningún PASS' });
  const vinculo = evidenciaScope(task_id, actual);
  for (const c of criterios) {
    const nombre = c && c.criterio;
    if (!c || String(c.resultado).toUpperCase() !== 'PASS') { rechazos.push({ criterio: nombre, code: 'CRITERIO_NO_PASS', detalle: String(c && c.resultado) }); continue; }
    if (!c.evidence_ref) { rechazos.push({ criterio: nombre, code: 'PASS_SIN_EVIDENCIA', detalle: 'un PASS sin evidencia no se acepta' }); continue; }
    if (!RE_EV.test(String(c.evidence_ref))) { rechazos.push({ criterio: nombre, code: 'EVIDENCE_REF_INVALIDA' }); continue; }
    const v = evidence.verificar(root, c.evidence_ref);
    if (!v.ok) { rechazos.push({ criterio: nombre, code: v.code, evidence_id: c.evidence_ref, detalle: 'la evidencia no se pudo verificar contra el original' }); continue; }
    const scope = scopeDeEvidencia(root, c.evidence_ref);
    if (scope !== vinculo) {
      const deOtraVersion = typeof scope === 'string' && scope.startsWith(task_id + '@');
      rechazos.push({ criterio: nombre, code: deOtraVersion ? 'EVIDENCIA_DE_OTRA_VERSION' : 'EVIDENCIA_SIN_VINCULO_A_SUJETO', evidence_id: c.evidence_ref, detalle: deOtraVersion ? 'la evidencia se obtuvo sobre una versión anterior del código' : 'la evidencia no está atada al sujeto actual de esta tarea' });
      continue;
    }
    verificados.push({ criterio: nombre, evidence_id: c.evidence_ref, sha256: v.sha256 });
  }
  const detalle = detalleRequerido({ risk_tier: entrega.risk_tier, contradiccion: entrega.contradiccion, fallo: entrega.fallo, cierre_exige_prueba: entrega.cierre_exige_prueba });
  const leidos = [];
  if (detalle.requerido && !rechazos.length) {
    // Riesgo/contradicción/fallo/cierre con prueba: no basta el hash, se lee el original (y cuesta presupuesto).
    for (const v of verificados) {
      const o = evidence.obtener(root, v.evidence_id, { length: opts.detalle_bytes || 4096 });
      if (!o.ok) { rechazos.push({ criterio: v.criterio, code: o.code, evidence_id: v.evidence_id, detalle: 'el original no se pudo recuperar' }); continue; }
      leidos.push({ evidence_id: v.evidence_id, bytes: o.delivered_bytes, complete: !!o.complete });
      try { require('./effort-budget.cjs').registrar(root, entrega.effort_task_id || task_id, { kind: 'evidence_retrieval', role: 'director', recovered_bytes: o.delivered_bytes, detail: 'detalle de ' + v.evidence_id }); } catch { /* auxiliar */ }
    }
  }
  const ok = rechazos.length === 0;
  return {
    ok, status: ok ? 'EVIDENCIA_VERIFICADA' : 'RECHAZADA', pass_permitido: ok, rechazos, verificados, subject_hash: actual,
    detalle_requerido: detalle, detalle_leido: leidos,
    nota: 'Aprobar la evidencia no marca DONE: el director corre sus gates sobre este sujeto exacto.',
  };
}

// ─── decisiones de negocio y bloqueos ────────────────────────────────────────

/**
 * Una decisión de negocio pendiente. NO bloqueante: queda registrada en el estado (sobrevive al reinicio)
 * y el trabajo continúa. Bloqueante: además abre un STOP de TEAMS por cadena de dependencia (nunca global)
 * y las tareas independientes siguen. Solo una persona o una verificación la resuelven: el tiempo, no.
 */
function registrarDecisionPendiente(root, d = {}) {
  const recip = d.recipient_role || 'builder';
  const sender = d.sender_role || 'director';
  const cur = estadoCorriente(root, { task_id: d.task_id, recipient_role: recip });
  let base = cur.ok ? cur.contenido : d.estado_base;
  if (!base) return falla('SIN_PAQUETE_BASE', 'no hay paquete previo ni estado_base para registrar la decisión');
  if (!String(d.pregunta || '').trim()) return falla('PREGUNTA_REQUERIDA', 'la decisión pendiente necesita su pregunta');
  const id = d.id || 'D-' + sha(d.task_id + '|' + d.pregunta).slice(0, 8);
  const lista = (base.pending_business_decisions || []).filter((x) => x.id !== id).concat([{ id, question: String(d.pregunta), blocking: !!d.bloqueante, ...(d.supuesto ? { assumed: String(d.supuesto) } : {}), since: iso(d) }]);
  const blockers = (base.blockers || []).filter((x) => x.id !== 'B-' + id).concat(d.bloqueante ? [{ id: 'B-' + id, tipo: 'DECISION', ref: id, blocking: true, since: iso(d) }] : []);
  const r = enviar(root, { ...base, task_id: d.task_id, plan_id: d.plan_id, sprint_id: d.sprint_id, sender_role: sender, recipient_role: recip, pending_business_decisions: lista, blockers, effort_usage: undefined, sin_reverificar_evidencia: true, now: d.now, effort_task_id: d.effort_task_id });
  if (!r.ok) return r;
  const out = { ok: true, decision_id: id, bloqueante: !!d.bloqueante, continuar: !d.bloqueante, revision: r.revision, status: d.bloqueante ? 'REGISTRADA_BLOQUEANTE' : 'REGISTRADA_CONTINUA' };
  if (d.bloqueante) {
    try {
      const tm = require('./teams-manager.cjs');
      if (tm.activo(root)) {
        const t = tm.leerTarea(root, d.task_id);
        const s = tm.stop(root, { reason_code: 'DECISION_DE_NEGOCIO', scope: 'DEPENDENCY_CHAIN', task_id: d.task_id, decision_required: true, resources: t ? t.allowed_files : [], question: String(d.pregunta), evidence: [{ kind: 'paquete', decision_id: id, revision: r.revision }] });
        out.stop = { id: s.id, afectadas: s.afectadas, seguras: s.seguras };
      } else out.stop = { status: 'TEAMS_NO_ACTIVO' };
    } catch (e) { out.stop = { status: 'STOP_NO_ABIERTO', detalle: e.code || e.message }; }
  }
  return out;
}

/**
 * Resolver una decisión o un bloqueo. SOLO con origen 'humano' o 'verificacion'. Un timeout, el reloj
 * o "ya pasó mucho rato" no resuelven nada: la dependencia bloqueante sigue bloqueada.
 */
function resolverPendiente(root, d = {}) {
  if (!['humano', 'verificacion'].includes(d.origen)) return falla('TIMEOUT_NO_RESUELVE', 'solo una persona o una verificación resuelven un pendiente; el paso del tiempo no', { origen: d.origen || null });
  const recip = d.recipient_role || 'builder';
  const cur = estadoCorriente(root, { task_id: d.task_id, recipient_role: recip });
  if (!cur.ok) return cur;
  const b = cur.contenido;
  const pend = (b.pending_business_decisions || []).filter((x) => x.id !== d.id);
  const bloq = (b.blockers || []).filter((x) => x.id !== d.id && x.id !== 'B-' + d.id && x.ref !== d.id);
  if (pend.length === (b.pending_business_decisions || []).length && bloq.length === (b.blockers || []).length) return falla('PENDIENTE_DESCONOCIDO', 'no hay un pendiente o bloqueo con ese id');
  const r = enviar(root, { ...b, task_id: d.task_id, plan_id: d.plan_id, sprint_id: d.sprint_id, sender_role: d.sender_role || 'director', recipient_role: recip, pending_business_decisions: pend, blockers: bloq, effort_usage: undefined, sin_reverificar_evidencia: true, now: d.now });
  return r.ok ? { ok: true, status: 'RESUELTO', revision: r.revision, origen: d.origen } : r;
}

/** Tiempo sin progreso: dispara REVISIÓN de estado. No crea trabajo ni libera bloqueos. */
function revisionPorTiempo(root, { task_id, recipient_role = 'builder', effort_task_id, ahora, umbral_ms } = {}) {
  let sp = { ok: false, code: 'SIN_PRESUPUESTO' };
  try { sp = require('./effort-budget.cjs').sinProgreso(root, effort_task_id || task_id, { ahora, umbral_ms }); } catch { /* auxiliar */ }
  const cur = estadoCorriente(root, { task_id, recipient_role });
  const bloqueos = cur.ok ? (cur.bloqueos || []).filter((b) => b.blocking) : [];
  return { ok: true, sin_progreso: !!sp.sin_progreso, accion: sp.sin_progreso ? 'REVISAR_ESTADO' : 'NINGUNA', bloqueos_vigentes: bloqueos, nota: bloqueos.length ? 'los bloqueos siguen vigentes: el tiempo no los resuelve' : null };
}

/**
 * Tras la muerte del director o del constructor: el nuevo proceso reconstruye TODO desde la base.
 * `receptor_nuevo` invalida las confirmaciones del receptor muerto (el siguiente envío será snapshot).
 * No repite ejecución: el estado de ejecución del paquete viaja con la respuesta.
 */
function recuperar(root, { task_id, recipient_role, receptor_nuevo = true } = {}) {
  if (receptor_nuevo) reiniciarReceptor(root, { task_id, recipient_role });
  const cur = estadoCorriente(root, { task_id, recipient_role });
  if (!cur.ok) return cur;
  const snap = snapshotActual(root, { task_id, recipient_role });
  return { ok: true, status: 'RECUPERADO', revision: cur.revision, ejecucion: cur.ejecucion, pendientes_humanos: cur.pendientes_humanos, bloqueos: cur.bloqueos, pins: cur.pins, snapshot: snap.ok ? snap.packet : null, estado_paquete: cur.estado_paquete };
}

// ─── métricas ────────────────────────────────────────────────────────────────

/**
 * Observabilidad de los paquetes (H03): cuántos, de qué tipo y cuánto pesó cada forma. La "reducción" es de PAYLOAD
 * (delta frente al snapshot equivalente), no ahorro de sesión, de razonamiento ni de dinero. Sin la tabla: no disponible.
 */
function estadisticas(root) {
  return conBase(root, false, (db) => {
    const id = db.get('SELECT project_id FROM mem_project WHERE singleton = 1');
    if (!id) return { ok: true, available: true, packets: 0, by_kind: {}, by_status: {}, pending_ack: 0 };
    const por = db.all('SELECT kind, status, count(*) AS n, COALESCE(SUM(length(body)),0) AS bytes FROM mem_context_packets WHERE project_id = ? GROUP BY kind, status', id.project_id);
    const out = { ok: true, available: true, measure: 'payload_bytes', packets: 0, by_kind: {}, by_status: {}, pending_ack: 0 };
    for (const f of por) {
      out.packets += Number(f.n);
      const k = (out.by_kind[f.kind] = out.by_kind[f.kind] || { n: 0, bytes: 0 });
      k.n += Number(f.n); k.bytes += Number(f.bytes);
      const st = /^(EXECUTING|EXECUTED):/.test(f.status) ? f.status.split(':')[0] : f.status;
      out.by_status[st] = (out.by_status[st] || 0) + Number(f.n);
    }
    out.pending_ack = Number(db.get("SELECT count(*) AS n FROM mem_context_packets WHERE project_id = ? AND status = 'SENT' AND acked_revision IS NULL", id.project_id).n);
    if (out.by_kind.delta) {
      let equivalente = 0;
      for (const f of db.all("SELECT body FROM mem_context_packets WHERE project_id = ? AND kind = 'delta' LIMIT 5000", id.project_id)) { try { equivalente += Number(JSON.parse(f.body).snapshot_bytes) || 0; } catch { /* cuerpo ilegible: no suma */ } }
      out.by_kind.delta.snapshot_equivalent_bytes = equivalente;
      out.by_kind.delta.payload_reduction_bytes = Math.max(0, equivalente - out.by_kind.delta.bytes);
    }
    return out;
  });
}

// ─── integración con teams-adapters.tick (todo fail-soft) ────────────────────

/**
 * Arma y entrega el paquete director→constructor de una asignación recién hecha. Sin la tabla de 3.20.1
 * (o sin tarea) devuelve null y TEAMS sigue exactamente como antes.
 */
function paqueteDeAsignacion(root, asg) {
  try {
    const tm = require('./teams-manager.cjs');
    const t = tm.leerTarea(root, asg.task.id);
    if (!t) return null;
    const effId = 'teams-' + t.id;
    let tier = (t.effort_policy && t.effort_policy.tier) || t.risk || 'MEDIUM';
    try {
      const router = require('./effort-router.cjs');
      const dec = router.decidirYGuardar(root, { task_id: effId, intent: t.objective, paths: t.allowed_files, requested_tier: t.risk, origen: 'teams' });
      tier = dec.tier;
    } catch { /* sin router: se usa el tier del plan */ }
    // Cada asignación es un intento nuevo (fencing nuevo): puede atenderlo otra sesión sin base. Si ya hubo paquetes de esta tarea,
    // las confirmaciones previas no cuentan y el envío es SNAPSHOT. Los deltas son para cambios dentro de una misma asignación.
    if (estadoCorriente(root, { task_id: t.id, recipient_role: 'builder' }).ok) reiniciarReceptor(root, { task_id: t.id, recipient_role: 'builder' });
    const r = enviar(root, {
      task_id: t.id, plan_id: t.plan_id, sprint_id: t.sprint_id, sender_role: 'director', recipient_role: 'builder',
      objective: t.objective, acceptance: t.acceptance, scope: t.allowed_files, risk_tier: tier,
      next_actions: ['implementar dentro del alcance', 'entregar resultado con evidencia; el director verifica, no se declara DONE'],
      effort_task_id: effId,
    });
    return r.ok ? r.packet : null;
  } catch { return null; }
}

module.exports = {
  SCHEMA_VERSION, CAMPOS_CONTRATO, CAMPOS_SOBRE, CAMPOS_CONTENIDO, LIMITES,
  validarContrato, armar, enviar, recibir, ack, reiniciarReceptor, snapshotActual, pendientesDeAck, paquetesPendientes, estadoCorriente, pinsActivos,
  reclamarEjecucion, completarEjecucion, validarVigencia, invalidar, cerrar,
  estadisticas, detalleRequerido, guardarEvidenciaDeGate, validarEntrega, subjectHash, evidenciaScope, hashContenido,
  registrarDecisionPendiente, resolverPendiente, revisionPorTiempo, recuperar, paqueteDeAsignacion,
};

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  const opt = {}; const libres = [];
  for (const a of rest) { const m = /^--([^=]+)(?:=(.*))?$/s.exec(a); if (m) opt[m[1]] = m[2] === undefined ? true : m[2]; else libres.push(a); }
  const root = process.cwd();
  const out = (x) => console.log(JSON.stringify(x, null, 2));
  if (cmd === 'estado') out(estadoCorriente(root, { task_id: opt.task, recipient_role: opt.rol || 'builder' }));
  else if (cmd === 'pendientes-ack') out(pendientesDeAck(root, { recipient_role: opt.rol || 'builder', task_id: opt.task }));
  else if (cmd === 'stats') out(estadisticas(root));
  else if (cmd === 'snapshot') out(snapshotActual(root, { task_id: opt.task, recipient_role: opt.rol || 'builder', revision: opt.revision }));
  else if (cmd === 'ack') out(ack(root, { task_id: opt.task, recipient_role: opt.rol || 'builder', revision: Number(opt.revision), hash: opt.hash, state_hash: opt['state-hash'] }));
  else if (cmd === 'invalidar') out(invalidar(root, { task_id: opt.task, paths: opt.paths ? String(opt.paths).split(',') : [], reason: opt.motivo }));
  else if (cmd === 'cerrar') out(cerrar(root, { task_id: opt.task, plan_id: opt.plan, sprint_id: opt.sprint, motivo: opt.abandonada ? 'ABANDONED' : 'CLOSED' }));
  else console.log('Uso: node teams-packets.cjs estado --task=T-1 [--rol=builder] | stats | snapshot --task=T-1 [--rol= --revision=] | ack --task=T-1 --revision=N --hash=H [--state-hash=H] | pendientes-ack [--rol=] | invalidar [--task= --paths=a,b] | cerrar --task=T-1');
}
