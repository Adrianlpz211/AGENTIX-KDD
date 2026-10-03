'use strict';
/**
 * Recuperación de memoria por capas (C02): índice → detalle → cronología → evidencia.
 *
 * El agente pide primero lo BARATO (un índice compacto), elige y solo entonces paga
 * el detalle, la cronología o el original. Cada capa declara cuánto cuesta, cuánto
 * dejó fuera y por qué, y TODO se anota en el presupuesto ACUMULADO de la tarea
 * (context-usage): pedir otro recall, cambiar de rol o recuperar un detalle no lo
 * reinicia.
 *
 *   Capa 1  indice()      lista compacta: id, título, tipo, vigencia, estado de
 *                         conocimiento, resumen corto, relevancia, procedencia, coste.
 *   Capa 2  detalle()     contenido completo de IDs elegidos, en lote y limitado.
 *   Capa 3  cronologia()  actividad y observaciones alrededor de un evento o nodo,
 *                         filtrada por proyecto/tarea y paginada por cursor.
 *   Capa 4  evidencia()   original autorizado, paginado/por rango/por selector, con hash.
 *
 * Reglas que este módulo hace cumplir (todas con prueba en test/memory-layers.test.cjs):
 *   · Estados DISTINTOS: OK / NO_RESULTS / NO_DB / SCHEMA_MISSING / ERROR (y
 *     INSUFFICIENT_BUDGET / CURSOR_STALE). Jamás se devuelve [] como respuesta a todo.
 *   · La LECTURA no escribe memoria.db: no crea FTS, no migra, no abre en escritura.
 *     Sin las tablas mem_* → SCHEMA_MISSING y se manda a `akdd update`.
 *   · Búsqueda LÉXICA sobre `nodos` (sin FTS ni embeddings): funciona con embeddings
 *     apagados y con IDs INTEGER o TEXT (se compara siempre CAST(id AS TEXT)).
 *   · El conocimiento antiguo sin procedencia sale como LEGACY_UNVERIFIED_PROVENANCE:
 *     se etiqueta al LEER, no se reescribe nada.
 *   · Presupuesto en bytes (estimación tokens = bytes/4, DECLARADA). El límite sale de
 *     la decisión de esfuerzo de la tarea (effort-router) o, sin ella, de la política
 *     del tier; lo ya consumido sale de context-usage (ACUMULADO).
 *   · Se empaqueta por ENTRADAS COMPLETAS. Nunca se corta un JSON ni una instrucción
 *     por bytes: lo que no cabe se OMITE y se dice qué (id, bytes que haría falta) y por
 *     qué (`presupuesto`, `filtro`, `privacidad`, `limite_lote`). Un primer resultado
 *     grande no impide entregar los demás (primer-ajuste).
 *   · Contratos PROTEGIDOS aplicables a las rutas dadas viajan en `obligations` y se
 *     entregan ANTES que el resto: si no caben → INSUFFICIENT_BUDGET con lo que haría
 *     falta, o se amplía el presupuesto con un `expand_reason` justificado y registrado.
 *     Jamás desaparecen en silencio.
 *   · Caché: clave = proyecto + sesión + consulta normalizada + filtros + tier + versión
 *     de política + huella de la memoria + hashes de los archivos relevantes + política de
 *     privacidad. Cualquier cambio de contenido/vigencia/permisos la invalida. No se
 *     cachean fallos de BD. El empaquetado por presupuesto se rehace SIEMPRE (el
 *     acumulado cambia entre llamadas); lo cacheado es el ranking, no la entrega.
 *   · Privacidad: nada de eventos privados/suprimidos; todo texto pasa por
 *     memory-privacy (secretos fuera, fallo = marcador, nunca el original).
 *   · Todo lo recuperado es DATO NO CONFIABLE (`untrusted_content`): texto plano, nunca
 *     HTML ni instrucciones para el host. No se ejecuta ni se interpreta.
 *
 * CLI:  node memory-layers.cjs index|detail|timeline|evidence [opciones] [--root=<dir>]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const core = require('./memory-core.cjs');
const privacy = require('./memory-privacy.cjs');
const usage = require('./context-usage.cjs');
const store = require('./evidence-store.cjs');

const CONTRACT_VERSION = 'memory-layers/1';
const POLICY_VERSION = 1;
const ESTIMACION = 'bytes/4';
const TIERS = ['LOW', 'MEDIUM', 'HIGH'];

/**
 * Política por tier (versionada: forma parte de la clave de caché).
 *   LOW      índice acotado y detalles puntuales, sin vecinos.
 *   MEDIUM   suma los vecinos afectados (mismos archivos / relacionados por procedencia).
 *   HIGH     amplía según riesgo y necesidad; sigue acotado: jamás vuelca la base.
 */
const POLITICA = Object.freeze({
  LOW: Object.freeze({ index_limit: 5, max_index_limit: 10, share_index: 0.25, detail_max_ids: 3, neighbors: 0, timeline_limit: 10, max_timeline_limit: 30, share_timeline: 0.3 }),
  MEDIUM: Object.freeze({ index_limit: 10, max_index_limit: 25, share_index: 0.35, detail_max_ids: 6, neighbors: 5, timeline_limit: 25, max_timeline_limit: 60, share_timeline: 0.4 }),
  HIGH: Object.freeze({ index_limit: 20, max_index_limit: 50, share_index: 0.5, detail_max_ids: 10, neighbors: 12, timeline_limit: 50, max_timeline_limit: 100, share_timeline: 0.5 }),
});
const BUDGET_BUILTIN = Object.freeze({ LOW: 12000, MEDIUM: 40000, HIGH: 100000 });

const MAX_SCAN = 20000;            // nodos leídos por consulta; más allá se declara scan_truncated
const CONTENT_SCAN = 4000;         // caracteres de contenido que se comparan con la consulta
const RESUMEN_CHARS = 200;
const ENVELOPE_RESERVE = 900;      // bytes que se reservan para el sobre de la respuesta
const MAX_OMITTED_IDS = 10;
const MAX_QUERY_CHARS = 1000;
const MAX_PATHS = 50;
const MAX_IDS_INPUT = 200;
const MIN_EVIDENCE_PAGE = 256;
const EXPAND_MAX_FRACTION = 0.5;   // una ampliación justificada llega como mucho a +50 % del límite del tier
const HASH_FILE_MAX = 1024 * 1024;
const CACHE_MAX = 50;

const STATUS = Object.freeze(['OK', 'NO_RESULTS', 'NO_DB', 'SCHEMA_MISSING', 'ERROR', 'INSUFFICIENT_BUDGET', 'CURSOR_STALE']);

const REQ_BASE = ['nodos', 'mem_project', 'mem_knowledge', 'mem_provenance', 'mem_events', 'mem_observation_events'];
const REQ = Object.freeze({
  index: REQ_BASE,
  detail: REQ_BASE,
  timeline: ['nodos', 'mem_project', 'mem_knowledge', 'mem_provenance', 'mem_events', 'mem_observations', 'mem_observation_events'],
});
const SCHEMA_HINT = 'Ejecuta: akdd update (la lectura no migra en silencio). Mientras tanto recall sigue disponible.';

const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
const bytesDe = (v) => Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v), 'utf8');
const cerrar = (db) => { try { if (db) db.close(); } catch { /* ya cerrada */ } };
const normTxt = (s) => String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const idEsEntero = (s) => /^-?\d+$/.test(s);
const cmpId = (a, b) => (idEsEntero(a) && idEsEntero(b) ? Number(a) - Number(b) : (a < b ? -1 : a > b ? 1 : 0));
const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
const unb64 = (s) => { try { const o = JSON.parse(Buffer.from(String(s), 'base64url').toString('utf8')); return o && typeof o === 'object' ? o : null; } catch { return null; } };

function terminosDe(query) {
  // Misma tokenización que recall: una consulta se parte igual en las dos rutas.
  return require('./kdd-memory.cjs').terminos(query);
}
const effort = () => require('./effort-router.cjs');

// ───────────────────────────── sobres de respuesta ──────────────────────────
function sobre(layer, status, campos) {
  return { contract_version: CONTRACT_VERSION, layer, status, ...(campos || {}) };
}
/** Los fallos del motor SQLite son "base ilegible", no un código interno del driver. */
const codigoDe = (e) => { const c = e && e.code; return typeof c === 'string' && c.startsWith('ERR_SQLITE') ? 'DB_UNREADABLE' : (c || 'LAYER_FAILED'); };
function errorSobre(layer, e) {
  return sobre(layer, 'ERROR', { code: codigoDe(e), message: String((e && e.message) || e).slice(0, 300) });
}
function argError(layer, code, message) { return sobre(layer, 'ERROR', { code, message }); }

/** Abre en SOLO LECTURA y comprueba tablas e identidad. Nunca crea ni migra. */
function abrirLectura(root, requeridas) {
  let db;
  try { db = core.abrir(root); } catch (e) { return { fail: { status: 'ERROR', code: codigoDe(e), message: String(e && e.message).slice(0, 300) } }; }
  if (!db) return { fail: { status: 'NO_DB', code: 'NO_DB', hint: 'No hay .agentic/memoria.db en este proyecto (akdd init).' } };
  try {
    const faltan = core.tablasFaltantes(db, requeridas);
    if (faltan.length) { cerrar(db); return { fail: { status: 'SCHEMA_MISSING', code: 'SCHEMA_MISSING', missing: faltan, hint: SCHEMA_HINT } }; }
    const canon = core.canonicalRoot(root);
    const fila = db.get('SELECT project_id, canonical_root FROM mem_project WHERE singleton = 1');
    if (fila && fila.canonical_root !== canon) {
      cerrar(db);
      return { fail: { status: 'ERROR', code: 'PROJECT_ROOT_MISMATCH', message: 'Esta memoria pertenece a otra ruta (' + fila.canonical_root + '). No se mezcla por nombre de carpeta: akdd memory project adopt (renombre) o fork (copia).' } };
    }
    return { db, pid: fila ? fila.project_id : null, canon };
  } catch (e) { cerrar(db); return { fail: { status: 'ERROR', code: codigoDe(e), message: String(e && e.message).slice(0, 300) } }; }
}

// ───────────────────────────── argumentos ───────────────────────────────────
function normalizarComunes(o, layer) {
  if (o == null || typeof o !== 'object' || Array.isArray(o)) return { error: argError(layer, 'INVALID_ARGS', 'los argumentos deben ser un objeto') };
  const a = {};
  if (o.tier != null && o.tier !== '') {
    const t = String(o.tier).toUpperCase();
    if (!TIERS.includes(t)) return { error: argError(layer, 'INVALID_TIER', 'tier debe ser LOW|MEDIUM|HIGH') };
    a.tier = t;
  }
  if (o.task_id != null && o.task_id !== '') {
    if (!/^[\w.-]{1,80}$/.test(String(o.task_id))) return { error: argError(layer, 'INVALID_TASK_ID', 'task_id inválido (letras, números, punto, guion, hasta 80)') };
    a.task_id = String(o.task_id);
  }
  for (const k of ['role', 'session_id']) {
    if (o[k] != null && o[k] !== '') {
      if (typeof o[k] !== 'string' || o[k].length > 200) return { error: argError(layer, 'INVALID_ARGS', k + ' debe ser texto de hasta 200 caracteres') };
      a[k] = o[k];
    }
  }
  if (o.budget_bytes != null) {
    const n = Number(o.budget_bytes);
    if (!Number.isFinite(n) || n < 0) return { error: argError(layer, 'INVALID_ARGS', 'budget_bytes debe ser un número >= 0') };
    a.budget_bytes = Math.floor(n);
  }
  if (o.expand_reason != null) {
    if (typeof o.expand_reason !== 'string') return { error: argError(layer, 'INVALID_ARGS', 'expand_reason debe ser texto') };
    a.expand_reason = o.expand_reason.trim().slice(0, 300);
  }
  a.expand = !!a.expand_reason && a.expand_reason.length >= 8;
  if (o.cursor != null && o.cursor !== '') {
    if (typeof o.cursor !== 'string' || o.cursor.length > 2000) return { error: argError(layer, 'INVALID_CURSOR', 'cursor inválido') };
    a.cursor = o.cursor;
  }
  return { a };
}

/** Ruta relativa a la raíz y sin escapes. null si no es utilizable. */
function relDeRaiz(root, p) {
  if (typeof p !== 'string' || !p || p.length > 500 || p.includes('\0')) return null;
  let n = privacy.normRuta(p);
  if (path.isAbsolute(p)) n = path.relative(root, p).split(path.sep).join('/');
  n = n.replace(/\/+$/, '');
  if (!n || n === '..' || n.startsWith('../') || n.startsWith('/') || /^[A-Za-z]:/.test(n) || n.split('/').includes('..')) return null;
  return n;
}

function normalizarRutas(root, v) {
  if (v == null) return { paths: [], rejected: 0 };
  if (!Array.isArray(v)) return { error: true };
  const out = []; let rechazadas = 0;
  for (const p of v.slice(0, MAX_PATHS)) {
    const r = relDeRaiz(root, p);
    if (r === null) { rechazadas++; continue; }
    if (!out.includes(r)) out.push(r);
  }
  return { paths: out.sort(), rejected: rechazadas + Math.max(0, v.length - MAX_PATHS) };
}

// ───────────────────────────── presupuesto ──────────────────────────────────
/**
 * Límite y consumo de la tarea. La decisión de esfuerzo manda sobre el `tier` pedido:
 * quien llama no puede bajarse el tier para esquivar el piso de riesgo.
 */
function presupuestoDe(root, a) {
  let decision = null;
  let tier = a.tier || 'MEDIUM';
  let tierSource = a.tier ? 'param' : 'default';
  let limite = null;
  let limitSource = null;
  if (a.task_id) {
    try { const e = effort().leer(root, a.task_id); if (e && e.decision) decision = e.decision; } catch { /* sin decisión legible */ }
  }
  if (decision && TIERS.includes(decision.tier) && Number.isFinite(Number(decision.context_budget_bytes))) {
    tier = decision.tier; tierSource = 'effort_decision'; limite = Number(decision.context_budget_bytes); limitSource = 'effort_decision';
  }
  if (!Number.isFinite(limite)) {
    try {
      const { policy } = effort().cargarPolitica(root);
      const v = policy && policy.tiers && policy.tiers[tier] && Number(policy.tiers[tier].context_budget_bytes);
      if (Number.isFinite(v)) { limite = v; limitSource = 'effort_policy'; }
    } catch { /* política ilegible */ }
  }
  if (!Number.isFinite(limite)) { limite = BUDGET_BUILTIN[tier]; limitSource = 'builtin_default'; }
  let usado = 0;
  let accounting = 'no_task';
  if (a.task_id) {
    const ac = usage.acumulado(root, a.task_id);
    if (ac && ac.available) { usado = Number(ac.total_delivered_bytes) || 0; accounting = 'recorded'; } else accounting = 'unavailable:' + ((ac && ac.code) || 'UNKNOWN');
  }
  return {
    tier, tierSource, limite, limitSource, usado, accounting, restante: Math.max(0, limite - usado),
    decision: !!decision, tierIgnorado: decision && a.tier && a.tier !== decision.tier ? a.tier : null,
    pol: POLITICA[tier],
  };
}

function bloquePresupuesto(p, a, capLlamada) {
  const b = {
    unit: 'bytes', estimacion: ESTIMACION, tier: p.tier, tier_source: p.tierSource, limite: p.limite, limit_source: p.limitSource,
    usado_acumulado: p.usado, este_llamado: 0, restante: p.restante, limite_llamada: Number.isFinite(capLlamada) ? capLlamada : p.restante,
    estimated_tokens_call: 0, accumulated: !!a.task_id, accounting: p.accounting,
  };
  if (p.tierIgnorado) b.requested_tier_ignored = p.tierIgnorado;
  if (!a.task_id) b.note = 'sin task_id el presupuesto no se acumula entre llamadas';
  return b;
}

/** Fija este_llamado = bytes reales de la respuesta (con el propio bloque dentro). */
function sellar(res, p) {
  const b = res.budget;
  for (let i = 0; i < 5; i++) {
    const n = bytesDe(res);
    if (b.este_llamado === n) break;
    b.este_llamado = n; b.estimated_tokens_call = Math.ceil(n / 4); b.restante = Math.max(0, p.limite - p.usado - n);
  }
  return b.este_llamado;
}

function registrarUso(root, a, kind, res, extra = {}) {
  if (!a.task_id) return;
  const esEv = kind === 'evidence_retrieval';
  const r = usage.registrar(root, {
    task_id: a.task_id, role: a.role, kind, original_bytes: extra.original_bytes || 0,
    delivered_bytes: esEv ? 0 : res.budget.este_llamado, recovered_bytes: esEv ? res.budget.este_llamado : 0,
    detail: [extra.detail, res.status].filter(Boolean).join(' | ').slice(0, 200),
  });
  if (!r.ok) res.budget.accounting = 'failed:' + r.code;
}

/** Tope de la llamada: lo que el tier deja, lo que queda y lo que el llamador acote. */
function topeLlamada(p, a, capCapa) {
  let c = Math.min(p.restante, Number.isFinite(capCapa) ? capCapa : Infinity);
  if (Number.isFinite(a.budget_bytes)) c = Math.min(c, a.budget_bytes);
  return Math.max(0, Math.floor(c));
}

/** Ampliación justificada: como mucho +50 % del límite del tier por encima de lo que queda. */
function ampliacionMax(p) { return Math.floor(p.limite * EXPAND_MAX_FRACTION); }

/**
 * Bytes EXTRA que se conceden a una llamada con `expand_reason` válido para que quepa
 * `necesario` (sobre el tope `cap` que ya tenía). El tope duro que el llamador puso con
 * `budget_bytes` jamás se amplía; el del tier sí, hasta +50 % (o sin techo para lo
 * obligatorio: un contrato protegido no se pierde por falta de presupuesto).
 */
function ampliar(p, a, cap, necesario, { sinTecho = false } = {}) {
  if (!a.expand || necesario <= cap) return 0;
  let techo = sinTecho ? Infinity : p.limite + ampliacionMax(p) - p.usado;
  if (Number.isFinite(a.budget_bytes)) techo = Math.min(techo, a.budget_bytes);
  return Math.max(0, Math.min(necesario, techo) - cap);
}

// ───────────────────────────── conocimiento y procedencia ───────────────────
function columnasDe(db, tabla) {
  try { return new Set(db.all('PRAGMA table_info(' + tabla + ')').map((c) => c.name)); } catch { return new Set(); }
}

function enLotes(lista, tam, fn) {
  for (let i = 0; i < lista.length; i += tam) fn(lista.slice(i, i + tam));
}
const MARCAS = (n) => new Array(n).fill('?').join(',');

/**
 * Estado de conocimiento sin escribir. Reproduce memory-core.estadoDe en lote (una
 * consulta, no tres por nodo); una prueba comprueba que ambas dan lo mismo.
 */
function estadoConocimiento(k, n) {
  if (k) return { state: k.state, provenance: k.provenance, occurrences: Number(k.occurrences), validated_at: k.validated_at || null, validated_by: k.validated_by || null, stale_since: k.stale_since || null };
  const vig = n.vigencia_tipo;
  const obsoleto = n.estado === 'OBSOLETO' || vig === 'SUPERSEDED' || vig === 'OBSOLETO';
  return { state: obsoleto ? 'OBSOLETE' : (vig === 'SOSPECHOSO' ? 'SUSPECT' : 'VALIDATED_LEGACY'), provenance: 'LEGACY_UNVERIFIED_PROVENANCE', occurrences: null, validated_at: null, validated_by: null, stale_since: null };
}

function cargarConocimiento(db, pid) {
  const mapa = new Map();
  if (!pid) return mapa;
  for (const k of db.all('SELECT node_id, state, provenance, occurrences, validated_at, validated_by, stale_since FROM mem_knowledge WHERE project_id = ?', pid)) mapa.set(String(k.node_id), k);
  return mapa;
}

/** Archivos a los que aplica un nodo (JSON o lista separada por comas), normalizados. */
function archivosDeNodo(valor) {
  if (!valor) return [];
  let lista = [];
  try { const j = JSON.parse(valor); lista = Array.isArray(j) ? j.map(String) : []; } catch { lista = String(valor).split(/[,;\n]/); }
  return lista.map((s) => privacy.normRuta(s.trim()).replace(/\/+$/, '')).filter(Boolean);
}
const mismoArchivo = (a, b) => a === b || a.endsWith('/' + b) || b.endsWith('/' + a);
const tocaRutas = (archivos, rutas) => archivos.some((f) => rutas.some((r) => mismoArchivo(f, r)));

/**
 * Procedencia en lote de unos nodos: eventos, observaciones y evidencias que los
 * originan, y relaciones con otros nodos. Los eventos privados/suprimidos no se
 * cuentan ni se nombran (que existan tampoco se filtra).
 */
function procedenciaDe(db, pid, nids, { completa = false } = {}) {
  const por = new Map(nids.map((n) => [n, { events: new Set(), observations: new Set(), evidence: new Set(), contradicts: [], superseded_by: [], supersedes: [], review_candidates: [], relation_counts: {}, notes: [], withheld: 0 }]));
  if (!pid || !nids.length) return por;
  const filas = [];
  enLotes(nids, 400, (lote) => {
    for (const f of db.all('SELECT provenance_id, node_id, relation, observation_id, event_id, evidence_id, related_node_id, note, created_at FROM mem_provenance WHERE project_id = ? AND node_id IN (' + MARCAS(lote.length) + ') ORDER BY provenance_id', pid, ...lote)) filas.push(f);
  });
  const reversas = [];
  enLotes(nids, 400, (lote) => {
    for (const f of db.all("SELECT node_id, related_node_id FROM mem_provenance WHERE project_id = ? AND relation = 'supersedes' AND related_node_id IN (" + MARCAS(lote.length) + ')', pid, ...lote)) reversas.push(f);
  });
  const obsIds = [...new Set(filas.map((f) => f.observation_id).filter(Boolean))];
  const eventosDeObs = new Map();
  enLotes(obsIds, 400, (lote) => {
    for (const r of db.all('SELECT observation_id, event_id FROM mem_observation_events WHERE observation_id IN (' + MARCAS(lote.length) + ')', ...lote)) {
      if (!eventosDeObs.has(r.observation_id)) eventosDeObs.set(r.observation_id, []);
      eventosDeObs.get(r.observation_id).push(r.event_id);
    }
  });
  const todosEv = [...new Set(filas.map((f) => f.event_id).filter(Boolean).concat([...eventosDeObs.values()].flat()))];
  const validos = new Set();
  enLotes(todosEv, 400, (lote) => {
    for (const r of db.all("SELECT event_id FROM mem_events WHERE project_id = ? AND privacy_class <> 'private' AND status <> 'SUPPRESSED' AND event_id IN (" + MARCAS(lote.length) + ')', pid, ...lote)) validos.add(r.event_id);
  });
  const existentes = new Set();
  enLotes(todosEv, 400, (lote) => { for (const r of db.all('SELECT event_id FROM mem_events WHERE event_id IN (' + MARCAS(lote.length) + ')', ...lote)) existentes.add(r.event_id); });
  const obsOk = new Set();
  enLotes(obsIds, 400, (lote) => {
    for (const r of db.all("SELECT observation_id FROM mem_observations WHERE status <> 'SUPPRESSED' AND observation_id IN (" + MARCAS(lote.length) + ')', ...lote)) obsOk.add(r.observation_id);
  });
  for (const f of filas) {
    const p = por.get(String(f.node_id));
    if (!p) continue;
    // una fila que apunta a un evento privado/suprimido no se nombra ni se cuenta
    if (f.event_id && existentes.has(f.event_id) && !validos.has(f.event_id)) { p.withheld++; continue; }
    if (f.event_id && validos.has(f.event_id)) p.events.add(f.event_id);
    if (f.observation_id && obsOk.has(f.observation_id)) {
      p.observations.add(f.observation_id);
      for (const e of eventosDeObs.get(f.observation_id) || []) if (validos.has(e)) p.events.add(e);
    }
    if (f.evidence_id) p.evidence.add(f.evidence_id);
    if (f.related_node_id) {
      if (f.relation === 'contradicts') p.contradicts.push(f.related_node_id);
      else if (f.relation === 'supersedes') p.supersedes.push(f.related_node_id);
      else if (f.relation === 'review_candidate') p.review_candidates.push(f.related_node_id);
    }
    if (completa) {
      // Resumen, no filas: los ids ya viajan en events/observations/evidence_ids; aquí solo cuántas relaciones de cada tipo y las notas.
      p.relation_counts[f.relation] = (p.relation_counts[f.relation] || 0) + 1;
      if (f.note && p.notes.length < 10) p.notes.push({ relation: f.relation, related_node_id: f.related_node_id || null, note: privacy.resumenSeguro(f.note, { max: 200 }) });
    }
  }
  for (const r of reversas) { const p = por.get(String(r.related_node_id)); if (p) p.superseded_by.push(String(r.node_id)); }
  return por;
}

// ───────────────────────────── huella y caché ───────────────────────────────
/**
 * Huella de la memoria que ENTREGAMOS: nodos (vigencia/contenido), conocimiento,
 * procedencia, eventos, observaciones, evidencias y contratos. Excluye el registro de
 * uso: anotar el consumo de una llamada no puede invalidar la caché de la siguiente.
 */
function huellaMemoria(db) {
  const h = crypto.createHash('sha256');
  const hay = new Set(db.all("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name));
  const g = (sql) => { try { return db.get(sql); } catch (e) { return { err: String(e && e.message) }; } };
  const cols = columnasDe(db, 'nodos');
  const c = (n, expr) => (cols.has(n) ? "COALESCE(" + expr + ",'')" : "''");
  const nodos = g("SELECT count(*) AS n, group_concat(x, char(10)) AS g FROM (SELECT CAST(id AS TEXT)||'|'||" + c('estado', 'estado') + "||'|'||" + c('vigencia_tipo', 'vigencia_tipo') + "||'|'||" + c('fecha_update', 'fecha_update') + "||'|'||" + c('confianza', 'confianza') + "||'|'||length(COALESCE(contenido,''))||'|'||length(COALESCE(titulo,''))||'|'||substr(COALESCE(contenido,''),1,40)||substr(COALESCE(contenido,''),-40) AS x FROM nodos ORDER BY rowid)");
  h.update('nodos:' + nodos.n + ':' + sha(String(nodos.g || '')) + '\n');
  const k = g("SELECT count(*) AS n, group_concat(x, char(10)) AS g FROM (SELECT node_id||'|'||state||'|'||provenance||'|'||occurrences||'|'||COALESCE(updated_at,'')||'|'||COALESCE(stale_since,'') AS x FROM mem_knowledge ORDER BY node_id)");
  h.update('knowledge:' + k.n + ':' + sha(String(k.g || '')) + '\n');
  const simple = [['mem_provenance', 'count(*) AS n, COALESCE(max(provenance_id),0) AS m'], ['mem_events', "count(*) AS n, COALESCE(max(received_at),'') AS m, COALESCE(sum(CASE WHEN privacy_class='private' OR status='SUPPRESSED' THEN 1 ELSE 0 END),0) AS p"], ['mem_observations', "count(*) AS n, COALESCE(max(updated_at),'') AS m, group_concat(DISTINCT status) AS s"], ['mem_evidence', "count(*) AS n, COALESCE(max(created_at),'') AS m, COALESCE(max(last_verified_at),'') AS v"]];
  for (const [t, expr] of simple) if (hay.has(t)) h.update(t + ':' + JSON.stringify(g(['SELECT', expr, 'FROM', t].join(' '))) + '\n');
  if (hay.has('verified_contracts')) {
    const vc = g("SELECT count(*) AS n, group_concat(x, char(10)) AS g FROM (SELECT id||'|'||COALESCE(status,'')||'|'||COALESCE(updated_at,'')||'|'||COALESCE(source_files,'') AS x FROM verified_contracts WHERE status IN ('protected','verified') ORDER BY id)");
    h.update('contracts:' + vc.n + ':' + sha(String(vc.g || '')) + '\n');
  }
  return h.digest('hex');
}

function dentroDe(padre, hijo) { const rel = path.relative(padre, hijo); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); }
function realSeguro(p) { try { return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p); } catch { return null; } }

/** Hash de cada archivo relevante: si cambia el código, la caché del ranking deja de valer. */
function hashesArchivos(root, rutas) {
  const raizReal = realSeguro(root);
  const out = {};
  for (const r of rutas) {
    try {
      if (privacy.rutaPrivada(root, r)) { out[r] = 'private'; continue; }
      const real = realSeguro(path.join(root, r));
      if (!real) { out[r] = 'missing'; continue; }
      if (!raizReal || !dentroDe(raizReal, real)) { out[r] = 'outside'; continue; }
      const st = fs.statSync(real);
      if (!st.isFile()) { out[r] = 'not_file'; continue; }
      out[r] = st.size <= HASH_FILE_MAX ? sha(fs.readFileSync(real)).slice(0, 24) : 'big:' + st.size + ':' + Math.floor(st.mtimeMs);
    } catch { out[r] = 'unreadable'; }
  }
  return out;
}

const cache = new Map();
function cacheGet(clave) {
  const v = cache.get(clave);
  if (v) { cache.delete(clave); cache.set(clave, v); }
  return v || null;
}
function cacheSet(clave, valor) {
  cache.set(clave, valor);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}
function limpiarCache() { cache.clear(); }

// ───────────────────────────── contratos protegidos (obligaciones) ──────────
function obligacionesPara(db, rutas) {
  if (!rutas.length) return { evaluated: false, reason: 'sin paths: no se puede saber qué contratos aplican', items: [], verified_applicable: 0 };
  const hay = db.get("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='verified_contracts'");
  if (!hay) return { evaluated: false, reason: 'este proyecto no tiene la tabla verified_contracts', items: [], verified_applicable: 0 };
  const filas = db.all("SELECT * FROM verified_contracts WHERE status IN ('protected','verified') ORDER BY id");
  const items = []; let verificados = 0;
  for (const f of filas) {
    let fuentes = [];
    try { const j = JSON.parse(f.source_files || '[]'); fuentes = Array.isArray(j) ? j.map((x) => privacy.normRuta(String(x)).replace(/\/+$/, '')) : []; } catch { fuentes = String(f.source_files || '').split(/[,;\n]/).map((x) => privacy.normRuta(x.trim())).filter(Boolean); }
    const tf = f.test_file ? [privacy.normRuta(String(f.test_file))] : [];
    const aplica = fuentes.filter((s) => rutas.some((r) => mismoArchivo(s, r)));
    const aplicaTest = tf.filter((s) => rutas.some((r) => mismoArchivo(s, r)));
    if (!aplica.length && !aplicaTest.length) continue;
    if (f.status !== 'protected') { verificados++; continue; }
    const desc = privacy.resumenSeguro(f.description || '', { max: 240 });
    items.push(conCoste({
      kind: 'protected_contract', contract_id: f.id, module: f.module, name: privacy.resumenSeguro(f.name || '', { max: 160 }), status: f.status,
      source_files: aplica.length ? aplica : aplicaTest, test_file: f.test_file || null, test_name: f.test_name || null,
      description: desc, description_truncated: String(f.description || '').replace(/\s+/g, ' ').trim().length > 240 || undefined,
    }));
  }
  return { evaluated: true, items, verified_applicable: verificados };
}

/** Fija el coste (bytes/4 declarado) de una entrada contando el propio campo `cost`. */
function conCoste(e) {
  e.cost = { bytes: 0, tokens_est: 0, estimacion: ESTIMACION };
  for (let i = 0; i < 3; i++) {
    const n = bytesDe(e);
    if (e.cost.bytes === n) break;
    e.cost.bytes = n; e.cost.tokens_est = Math.ceil(n / 4);
  }
  return e;
}

function empaquetar(entradas, cap) {
  const entregadas = []; const omitidas = []; let usados = 0;
  for (const e of entradas) {
    const c = e.cost.bytes;
    if (usados + c <= cap) { entregadas.push(e); usados += c; } else omitidas.push({ id: e.id !== undefined ? e.id : e.contract_id, needed_bytes: c });
  }
  return { entregadas, omitidas, usados };
}

function bloqueOmitidos(porRazon, ids) {
  const total = Object.values(porRazon).reduce((s, n) => s + n, 0);
  const por = Object.fromEntries(Object.entries(porRazon).filter(([, n]) => n > 0));
  return { count: total, by_reason: por, ids: ids.slice(0, MAX_OMITTED_IDS), ids_truncated: ids.length > MAX_OMITTED_IDS || undefined };
}

// ───────────────────────────── capa 1: índice ───────────────────────────────
function normalizarIndice(root, o) {
  const c = normalizarComunes(o, 'index');
  if (c.error) return c;
  const a = c.a;
  if (o.query != null) {
    if (typeof o.query !== 'string') return { error: argError('index', 'INVALID_ARGS', 'query debe ser texto') };
    if (o.query.length > MAX_QUERY_CHARS) return { error: argError('index', 'INVALID_ARGS', 'query excede ' + MAX_QUERY_CHARS + ' caracteres') };
    a.query = o.query.trim();
  }
  const rutas = normalizarRutas(root, o.paths);
  if (rutas.error) return { error: argError('index', 'INVALID_ARGS', 'paths debe ser una lista de rutas') };
  a.paths = rutas.paths; a.paths_rejected = rutas.rejected;
  const t = o.type != null ? o.type : o.tipo;
  if (t != null && t !== '') { if (typeof t !== 'string' || t.length > 80) return { error: argError('index', 'INVALID_ARGS', 'type inválido') }; a.type = t; }
  if (o.area != null && o.area !== '') { if (typeof o.area !== 'string' || o.area.length > 120) return { error: argError('index', 'INVALID_ARGS', 'area inválida') }; a.area = o.area; }
  if (o.state != null && o.state !== '') {
    const lista = (Array.isArray(o.state) ? o.state : [o.state]).map((s) => String(s).toUpperCase());
    if (lista.length > 10 || lista.some((s) => !/^[A-Z_]{3,40}$/.test(s))) return { error: argError('index', 'INVALID_ARGS', 'state inválido') };
    a.state = lista.sort();
  }
  a.include_obsolete = o.include_obsolete === true;
  if (o.limit != null) { const n = Number(o.limit); if (!Number.isFinite(n) || n < 1) return { error: argError('index', 'INVALID_ARGS', 'limit debe ser >= 1') }; a.limit = Math.floor(n); }
  return { a };
}

const RANGO_CONF = { ALTA: 0.9, MEDIA: 0.6, BAJA: 0.3 };

/** Ranking léxico (sin FTS ni embeddings) + filtros + vecinos. Es lo que se cachea. */
function calcularBase(db, pid, a, terms, rutas, pol) {
  const cols = columnasDe(db, 'nodos');
  const sel = ['id', 'tipo', 'titulo', 'area', 'confianza', 'estado', 'fecha_update', 'vigencia_tipo', 'archivos_aplica'].filter((c) => cols.has(c));
  const filas = db.all('SELECT CAST(id AS TEXT) AS nid, ' + sel.filter((c) => c !== 'id').join(', ') + ", substr(COALESCE(contenido,''), 1, " + CONTENT_SCAN + ") AS c, length(COALESCE(contenido,'')) AS clen FROM nodos ORDER BY rowid LIMIT " + (MAX_SCAN + 1));
  const truncado = filas.length > MAX_SCAN;
  if (truncado) filas.length = MAX_SCAN;
  const conocimiento = cargarConocimiento(db, pid);
  const hayQuery = terms.length > 0;
  // Una consulta escrita pero sin términos útiles NO es "sin consulta": no devuelve el catálogo entero.
  const consultaInutil = !!a.query && !hayQuery && rutas.length === 0;
  const filtroTipo = a.type ? a.type.toLowerCase() : null;
  const filtroArea = a.area ? a.area.toLowerCase() : null;
  const filtroEstado = a.state ? new Set(a.state) : null;
  const porRazon = { obsoleto: 0, filtro: 0 };
  const idsFiltrados = [];
  const prim = []; const porId = new Map();
  let original = 0;
  const max = terms.length * 4;
  for (const n of filas) {
    const archivos = archivosDeNodo(n.archivos_aplica);
    const rutaMatch = rutas.length > 0 && tocaRutas(archivos, rutas);
    let rel = 0;
    if (consultaInutil) continue;
    if (hayQuery) {
      const t = normTxt(n.titulo); const c = normTxt(n.c);
      let raw = 0;
      for (const w of terms) { if (t.includes(w)) raw += 3; if (c.includes(w)) raw += 1; }
      if (raw <= 0) continue;
      rel = raw / max;
      if (rutaMatch) rel = Math.min(1, rel + 0.25);
    } else if (rutas.length) {
      if (!rutaMatch) continue;
      rel = 0.8 + 0.1 * (RANGO_CONF[n.confianza] || 0.3);
    } else {
      rel = RANGO_CONF[n.confianza] || 0.3;
    }
    const st = estadoConocimiento(conocimiento.get(n.nid), { estado: n.estado, vigencia_tipo: n.vigencia_tipo });
    const motivoFuera = (() => {
      if (!a.include_obsolete && st.state === 'OBSOLETE') return 'obsoleto';
      if (filtroTipo && String(n.tipo || '').toLowerCase() !== filtroTipo) return 'filtro';
      if (filtroArea && !String(n.area || '').toLowerCase().includes(filtroArea)) return 'filtro';
      if (filtroEstado && !filtroEstado.has(st.state)) return 'filtro';
      return null;
    })();
    if (motivoFuera) { porRazon[motivoFuera]++; if (idsFiltrados.length < MAX_OMITTED_IDS) idsFiltrados.push(n.nid); continue; }
    original += Number(n.clen) || 0;
    const cand = { nid: n.nid, rel, conf: RANGO_CONF[n.confianza] || 0.3, fecha: String(n.fecha_update || ''), via: null };
    prim.push(cand); porId.set(n.nid, cand);
  }
  // Orden DETERMINISTA: relevancia, confianza, más reciente, id.
  const ordenar = (x, y) => (y.rel - x.rel) || (y.conf - x.conf) || (x.fecha < y.fecha ? 1 : x.fecha > y.fecha ? -1 : 0) || cmpId(x.nid, y.nid);
  prim.sort(ordenar);

  // Vecinos afectados (MEDIUM/HIGH): mismos archivos o relacionados por procedencia.
  const vecinos = [];
  if (pol.neighbors > 0 && (rutas.length || prim.length)) {
    const nuevos = new Map();
    const filaPorId = new Map(filas.map((n) => [n.nid, n]));
    if (rutas.length) {
      for (const n of filas) {
        if (porId.has(n.nid)) continue;
        if (tocaRutas(archivosDeNodo(n.archivos_aplica), rutas)) nuevos.set(n.nid, { nid: n.nid, rel: 0.4, via: 'affected_path', fecha: String(n.fecha_update || ''), conf: RANGO_CONF[n.confianza] || 0.3 });
      }
    }
    const top = prim.slice(0, 10).map((c) => c.nid);
    if (pid && top.length) {
      const rel = db.all("SELECT node_id, related_node_id, relation FROM mem_provenance WHERE project_id = ? AND related_node_id <> '' AND (node_id IN (" + MARCAS(top.length) + ') OR related_node_id IN (' + MARCAS(top.length) + '))', pid, ...top, ...top);
      for (const r of rel) {
        const otro = top.includes(String(r.node_id)) ? String(r.related_node_id) : String(r.node_id);
        if (porId.has(otro) || nuevos.has(otro) || !filaPorId.has(otro)) continue;
        const n = filaPorId.get(otro);
        nuevos.set(otro, { nid: otro, rel: 0.35, via: 'related:' + r.relation, fecha: String(n.fecha_update || ''), conf: RANGO_CONF[n.confianza] || 0.3 });
      }
    }
    for (const v of [...nuevos.values()].sort(ordenar)) {
      const n = filaPorId.get(v.nid);
      const st = estadoConocimiento(conocimiento.get(v.nid), { estado: n.estado, vigencia_tipo: n.vigencia_tipo });
      if (!a.include_obsolete && st.state === 'OBSOLETE') { porRazon.obsoleto++; continue; }
      if (vecinos.length < pol.neighbors) vecinos.push(v);
    }
  }
  return {
    cands: prim.concat(vecinos).map((c) => ({ nid: c.nid, rel: c.rel, via: c.via })),
    primarios: prim.length, vecinos: vecinos.length,
    omitidos_filtro: porRazon, ids_filtrados: idsFiltrados, escaneados: filas.length, scan_truncated: truncado, original_bytes: original,
  };
}

/** Entradas compactas del índice para las filas de una página. */
function entradasIndice(db, pid, pagina, root) {
  if (!pagina.length) return [];
  const nids = pagina.map((c) => c.nid);
  const cols = columnasDe(db, 'nodos');
  const sel = ['tipo', 'titulo', 'area', 'confianza', 'estado', 'vigencia_tipo', 'archivos_aplica'].filter((c) => cols.has(c));
  const filas = new Map();
  enLotes(nids, 400, (lote) => {
    for (const f of db.all('SELECT CAST(id AS TEXT) AS nid, id AS rid, ' + sel.join(', ') + ", substr(COALESCE(contenido,''), 1, 600) AS c FROM nodos WHERE CAST(id AS TEXT) IN (" + MARCAS(lote.length) + ')', ...lote)) filas.set(f.nid, f);
  });
  const conocimiento = cargarConocimiento(db, pid);
  const prov = procedenciaDe(db, pid, nids);
  const pol = privacy.cargarPolitica(root);
  const out = [];
  for (const c of pagina) {
    const n = filas.get(c.nid);
    if (!n) continue;
    const st = estadoConocimiento(conocimiento.get(c.nid), { estado: n.estado, vigencia_tipo: n.vigencia_tipo });
    const p = prov.get(c.nid);
    const limpio = String(n.c || '').replace(/\s+/g, ' ').trim();
    const e = {
      id: n.rid, title: privacy.resumenSeguro(n.titulo || '', { max: 200, politica: pol }), type: n.tipo || null, area: n.area || null, confidence: n.confianza || null,
      vigencia: n.vigencia_tipo || null, knowledge_state: st.state, provenance_kind: st.provenance,
      summary: privacy.resumenSeguro(n.c || '', { max: RESUMEN_CHARS, politica: pol }), summary_truncated: limpio.length > RESUMEN_CHARS || undefined,
      relevance: Math.round(c.rel * 100) / 100,
      provenance: { events: p.events.size, observations: p.observations.size, evidence: p.evidence.size, contradicts: p.contradicts.length ? p.contradicts.slice(0, 5) : undefined, superseded_by: p.superseded_by.length ? p.superseded_by.slice(0, 5) : undefined },
    };
    if (st.provenance === 'LEGACY_UNVERIFIED_PROVENANCE') e.legacy = true;
    const archivos = archivosDeNodo(n.archivos_aplica);
    if (archivos.length) e.files = archivos.slice(0, 5);
    if (st.state === 'PROPOSED' || st.state === 'SUSPECT' || n.vigencia_tipo === 'SOSPECHOSO') e.needs_verification = true;
    if (c.via) e.neighbor = { via: c.via };
    out.push(conCoste(e));
  }
  return out;
}

function claveIndice(root, canon, pid, a, terms, rutas, tier, privKey) {
  const kq = sha(JSON.stringify([CONTRACT_VERSION, POLICY_VERSION, canon, pid, a.session_id || null, terms, a.query ? 1 : 0, { t: a.type || null, a: a.area || null, s: a.state || null, o: !!a.include_obsolete }, tier, rutas, privKey]));
  return kq;
}

function indice(root, o = {}) {
  try {
    root = root || process.cwd();
    const n = normalizarIndice(root, o);
    if (n.error) return n.error;
    const a = n.a;
    const p = presupuestoDe(root, a);
    const ab = abrirLectura(root, REQ.index.concat(a.task_id ? ['mem_context_usage'] : []));
    if (ab.fail) return sobre('index', ab.fail.status, { ...ab.fail, query: a.query || null, budget: bloquePresupuesto(p, a) });
    const { db, pid, canon } = ab;
    let r;
    try { r = construirIndice(root, db, pid, canon, a, p); } finally { cerrar(db); }
    if (r.registrar) registrarUso(root, a, 'recall_index', r.res, { original_bytes: r.original_bytes, detail: 'cache:' + r.res.cache });
    return r.res;
  } catch (e) { return errorSobre('index', e); }
}

function construirIndice(root, db, pid, canon, a, p) {
  const pol = p.pol;
  const terms = a.query ? terminosDe(a.query) : [];
  const politicaPriv = privacy.cargarPolitica(root);
  const privKey = sha(JSON.stringify([politicaPriv.policy_id, politicaPriv.deny_paths, politicaPriv.deny_fields, politicaPriv.exclude, privacy.REDACTION_VERSION])).slice(0, 16);
  const kq = claveIndice(root, canon, pid, a, terms, a.paths, p.tier, privKey);
  const hf = huellaMemoria(db);
  const hashes = hashesArchivos(root, a.paths);
  const clave = sha(kq + '|' + hf + '|' + JSON.stringify(hashes));
  const fp = sha(hf + JSON.stringify(hashes)).slice(0, 16);

  let offset = 0;
  if (a.cursor) {
    const c = unb64(a.cursor);
    if (!c || c.v !== 1 || !Number.isInteger(c.o) || c.o < 0 || c.kq !== kq.slice(0, 16)) return { res: argError('index', 'INVALID_CURSOR', 'el cursor no corresponde a esta consulta'), registrar: false };
    if (c.f !== fp) return { res: sobre('index', 'CURSOR_STALE', { code: 'CURSOR_STALE', message: 'La memoria o los archivos cambiaron desde que se pidió esa página: repite la consulta sin cursor.' }), registrar: false };
    offset = c.o;
  }

  let base = cacheGet(clave);
  const hit = !!base;
  if (!base) {
    const ranking = calcularBase(db, pid, a, terms, a.paths, pol);
    const obligaciones = obligacionesPara(db, a.paths);
    base = { ranking, obligaciones };
    cacheSet(clave, base);
  }
  const { ranking, obligaciones } = base;
  const total = ranking.cands.length;
  if (offset > total || (offset === total && total > 0)) return { res: argError('index', 'INVALID_CURSOR', 'el cursor queda fuera del resultado'), registrar: false };

  const limite = Math.min(a.limit || pol.index_limit, pol.max_index_limit);
  const pagina = ranking.cands.slice(offset, offset + limite);
  const hayMas = offset + limite < total;
  const entradas = entradasIndice(db, pid, pagina, root);

  // Presupuesto: obligaciones primero (no se pueden perder), después el índice.
  const capObl = topeLlamada(p, a, Infinity);
  const capIdxCapa = Math.floor(p.limite * pol.share_index);
  const obl = offset === 0 ? obligaciones.items : [];
  const oblBytes = obl.reduce((s, e) => s + e.cost.bytes, 0);
  const costes = entradas.reduce((s, e) => s + e.cost.bytes, 0);
  let extra = 0;
  let repartoRelajado = false;
  const necesarioObl = obl.length ? oblBytes + ENVELOPE_RESERVE : 0;
  let insuficienteObl = false;
  if (necesarioObl > capObl) {
    extra = ampliar(p, a, capObl, necesarioObl, { sinTecho: true });
    if (capObl + extra < necesarioObl) insuficienteObl = true;
  }
  let idxCap = Math.max(0, Math.min(capIdxCapa, capObl + extra - oblBytes - ENVELOPE_RESERVE));
  if (!insuficienteObl && a.expand && costes > idxCap) {
    // Justificación válida: el reparto por capa se relaja y, si hace falta, se amplía el tier (+50 % máx.).
    extra += ampliar(p, a, capObl + extra, oblBytes + costes + ENVELOPE_RESERVE);
    idxCap = Math.max(0, capObl + extra - oblBytes - ENVELOPE_RESERVE);
    repartoRelajado = true;
  }
  const bloque = bloquePresupuesto(p, a, capObl + extra);
  bloque.cache_hit = hit || undefined;
  bloque.layer_cap_index = idxCap;
  const base0 = {
    query: a.query || null, query_terms: terms, tier: p.tier,
    filters: { type: a.type || null, area: a.area || null, state: a.state || null, include_obsolete: a.include_obsolete },
    paths: a.paths, paths_rejected: a.paths_rejected || undefined,
    search: { mode: 'lexical', fts: 'not_used', semantic: false, scanned: ranking.escaneados, scan_truncated: ranking.scan_truncated || undefined },
    cache: hit ? 'hit' : 'miss', untrusted_content: true, content_format: 'plain_text',
  };

  if (insuficienteObl) {
    const res = sobre('index', 'INSUFFICIENT_BUDGET', {
      ...base0, code: 'OBLIGATIONS_DO_NOT_FIT',
      message: 'Hay contratos protegidos aplicables y no caben en el presupuesto: no se omiten. Amplía con expand_reason (justificado) o sube el tier.',
      needed_bytes: necesarioObl, available_bytes: capObl,
      obligations: { evaluated: true, count: obl.length, items: obl.map((e) => ({ contract_id: e.contract_id, module: e.module, name: e.name, status: e.status, source_files: e.source_files, cost: e.cost })), delivered: 'ids_only' },
      total, budget: bloque,
    });
    sellar(res, p);
    return { res, registrar: true, original_bytes: 0 };
  }

  const emp = empaquetar(entradas, idxCap);
  const fuera = entradas.length - emp.entregadas.length;
  const porRazon = { presupuesto: fuera, filtro: ranking.omitidos_filtro.filtro, obsoleto: ranking.omitidos_filtro.obsoleto };
  const idsOm = emp.omitidas.map((x) => ({ id: x.id, reason: 'presupuesto', needed_bytes: x.needed_bytes })).concat(ranking.ids_filtrados.map((id) => ({ id, reason: 'filtro_u_obsoleto' })));
  const omitted = bloqueOmitidos(porRazon, idsOm);
  omitted.items = omitted.ids; delete omitted.ids;
  const nextCursor = hayMas ? b64({ v: 1, o: offset + limite, kq: kq.slice(0, 16), f: fp }) : null;

  let status = 'OK';
  const sinNada = !emp.entregadas.length && !obl.length;
  if (total === 0 && !obl.length) status = 'NO_RESULTS';
  else if (sinNada && entradas.length > 0) status = 'INSUFFICIENT_BUDGET';

  const res = sobre('index', status, {
    ...base0,
    results: emp.entregadas,
    obligations: offset === 0
      ? { evaluated: obligaciones.evaluated, reason: obligaciones.reason, count: obl.length, items: obl, verified_applicable: obligaciones.verified_applicable }
      : { evaluated: obligaciones.evaluated, delivered_on_first_page: true, count: obligaciones.items.length },
    total, total_primary: ranking.primarios, neighbors: ranking.vecinos, returned: emp.entregadas.length, offset, limit: limite,
    has_more: hayMas, next_cursor: nextCursor, omitted, budget: bloque,
  });
  if (status === 'INSUFFICIENT_BUDGET') { res.code = 'INDEX_DOES_NOT_FIT'; res.needed_bytes = Math.min(...emp.omitidas.map((x) => x.needed_bytes)) + ENVELOPE_RESERVE; res.message = 'Ni la entrada más pequeña cabe en el presupuesto del índice: amplía con expand_reason o sube el tier.'; }
  if (status === 'NO_RESULTS') res.note = terms.length === 0 && a.query ? 'la consulta no tiene términos útiles (palabras de 3+ letras)' : 'sin coincidencias en una memoria que se leyó correctamente';
  if (extra > 0 || repartoRelajado) { res.budget.expanded = { reason: privacy.resumenSeguro(a.expand_reason, { max: 120 }), extra_bytes: extra, share_relaxed: repartoRelajado || undefined }; }
  if (!res.obligations.reason) delete res.obligations.reason;
  sellar(res, p);
  return { res, registrar: true, original_bytes: ranking.original_bytes };
}

// ───────────────────────────── capa 2: detalle ──────────────────────────────
function detalle(root, ids, o = {}) {
  try {
    root = root || process.cwd();
    const c = normalizarComunes(o, 'detail');
    if (c.error) return c.error;
    const a = c.a;
    let lista = ids;
    if (lista == null) lista = o.ids;
    if (typeof lista === 'string' || typeof lista === 'number') lista = [lista];
    if (!Array.isArray(lista) || !lista.length) return argError('detail', 'INVALID_ARGS', 'ids debe ser una lista no vacía de ids de nodo');
    if (lista.length > MAX_IDS_INPUT) return argError('detail', 'INVALID_ARGS', 'demasiados ids en la petición (máx. ' + MAX_IDS_INPUT + ')');
    const invalidos = []; const limpios = [];
    for (const x of lista) {
      const s = typeof x === 'number' ? String(x) : x;
      if (typeof s !== 'string' || !s.length || s.length > 120 || s.includes('\0')) { invalidos.push(String(x).slice(0, 40)); continue; }
      if (!limpios.includes(s)) limpios.push(s);
    }
    if (!limpios.length) return sobre('detail', 'ERROR', { code: 'INVALID_ARGS', message: 'ninguno de los ids es válido', invalid_ids: invalidos.slice(0, 5) });
    a.content_offset = Number.isFinite(Number(o.content_offset)) && Number(o.content_offset) > 0 ? Math.floor(Number(o.content_offset)) : 0;
    a.content_limit = Number.isFinite(Number(o.content_limit)) && Number(o.content_limit) > 0 ? Math.floor(Number(o.content_limit)) : null;
    a.include_obsolete = o.include_obsolete === true;
    const p = presupuestoDe(root, a);
    const ab = abrirLectura(root, REQ.detail.concat(a.task_id ? ['mem_context_usage'] : []));
    if (ab.fail) return sobre('detail', ab.fail.status, { ...ab.fail, budget: bloquePresupuesto(p, a) });
    const { db, pid } = ab;
    let r;
    try { r = construirDetalle(root, db, pid, a, p, limpios, invalidos); } finally { cerrar(db); }
    if (r.registrar) registrarUso(root, a, 'recall_detail', r.res, { original_bytes: r.original_bytes, detail: 'ids:' + limpios.length });
    return r.res;
  } catch (e) { return errorSobre('detail', e); }
}

function construirDetalle(root, db, pid, a, p, limpios, invalidos) {
  const pol = p.pol;
  const maxIds = pol.detail_max_ids;
  const pedidos = limpios.slice(0, maxIds);
  const fueraLote = limpios.slice(maxIds);
  const polPriv = privacy.cargarPolitica(root);
  const cols = columnasDe(db, 'nodos');
  const sel = ['tipo', 'titulo', 'area', 'confianza', 'estado', 'vigencia_tipo', 'archivos_aplica', 'fecha_update'].filter((c) => cols.has(c));
  const filas = new Map();
  enLotes(pedidos, 400, (lote) => {
    for (const f of db.all('SELECT CAST(id AS TEXT) AS nid, id AS rid, ' + sel.join(', ') + ', COALESCE(contenido,\'\') AS c FROM nodos WHERE CAST(id AS TEXT) IN (' + MARCAS(lote.length) + ')', ...lote)) filas.set(f.nid, f);
  });
  const conocimiento = cargarConocimiento(db, pid);
  const existentes = pedidos.filter((i) => filas.has(i));
  const prov = procedenciaDe(db, pid, existentes, { completa: true });
  const entradas = []; const noEncontrados = []; let original = 0;
  for (const nid of pedidos) {
    const n = filas.get(nid);
    if (!n) { noEncontrados.push(conCoste({ id: nid, status: 'NOT_FOUND' })); continue; }
    const st = estadoConocimiento(conocimiento.get(nid), { estado: n.estado, vigencia_tipo: n.vigencia_tipo });
    const pv = prov.get(nid);
    const base = {
      id: n.rid, status: 'OK', title: privacy.resumenSeguro(n.titulo || '', { max: 200, politica: polPriv }), type: n.tipo || null, area: n.area || null, confidence: n.confianza || null,
      vigencia: n.vigencia_tipo || null, knowledge_state: st.state, provenance_kind: st.provenance, occurrences: st.occurrences, validated_at: st.validated_at, validated_by: st.validated_by, stale_since: st.stale_since,
      files: archivosDeNodo(n.archivos_aplica).slice(0, 20),
      provenance: {
        events: [...pv.events].slice(0, 20), observations: [...pv.observations].slice(0, 20), evidence_ids: [...pv.evidence].slice(0, 20),
        contradicts: pv.contradicts, supersedes: pv.supersedes, superseded_by: pv.superseded_by, review_candidates: pv.review_candidates,
        relation_counts: pv.relation_counts, notes: pv.notes.length ? pv.notes : undefined, withheld_private: pv.withheld || undefined,
      },
      timeline_hint: { around: { node_id: String(n.rid) } },
    };
    if (st.provenance === 'LEGACY_UNVERIFIED_PROVENANCE') base.legacy = true;
    if (st.state === 'PROPOSED' || st.state === 'SUSPECT' || n.vigencia_tipo === 'SOSPECHOSO') base.needs_verification = true;
    if (st.state === 'OBSOLETE' && !a.include_obsolete) {
      base.status = 'OBSOLETE'; base.applicable = false; base.note = 'Conocimiento obsoleto/sustituido: no se entrega su contenido salvo include_obsolete.';
      entradas.push(conCoste(base)); continue;
    }
    const red = privacy.redactarSecretos(n.c, polPriv);
    const completo = red.ok ? red.text : privacy.FALLO;
    original += Buffer.byteLength(String(n.c || ''));
    let contenido = completo;
    if (a.content_offset || a.content_limit) {
      const fin = a.content_limit ? a.content_offset + a.content_limit : undefined;
      contenido = completo.slice(a.content_offset, fin);
      base.content_range = { offset: a.content_offset, length: contenido.length, total_chars: completo.length };
      base.has_more_content = (fin !== undefined ? fin : completo.length) < completo.length || undefined;
    }
    base.content = contenido;
    base.content_bytes = Buffer.byteLength(contenido);
    base.content_redactions = red.ok ? red.redactions || undefined : undefined;
    entradas.push(conCoste(base));
  }

  const capLlamada = topeLlamada(p, a, Infinity);
  let extra = 0;
  const reserva = ENVELOPE_RESERVE;
  const aEntregar = entradas.filter((e) => e.status !== 'NOT_FOUND').concat(noEncontrados);
  let cap = Math.max(0, capLlamada - reserva);
  let emp = empaquetar(aEntregar, cap);
  if (emp.omitidas.length && a.expand) {
    extra = ampliar(p, a, capLlamada, aEntregar.reduce((s, e) => s + e.cost.bytes, 0) + reserva);
    if (extra > 0) { cap += extra; emp = empaquetar(aEntregar, cap); }
  }
  const bloque = bloquePresupuesto(p, a, capLlamada + extra);
  const porRazon = { presupuesto: emp.omitidas.length, limite_lote: fueraLote.length, ids_invalidos: invalidos.length };
  const idsOm = emp.omitidas.map((x) => ({ id: x.id, reason: 'presupuesto', needed_bytes: x.needed_bytes })).concat(fueraLote.map((id) => ({ id, reason: 'limite_lote' })));
  const omitted = bloqueOmitidos(porRazon, []);
  omitted.items = idsOm.slice(0, MAX_OMITTED_IDS); delete omitted.ids;
  if (idsOm.length > MAX_OMITTED_IDS) omitted.items_truncated = true;
  if (invalidos.length) omitted.invalid_ids = invalidos.slice(0, 5);
  const entregadas = emp.entregadas;
  const algunoOk = entregadas.some((e) => e.status === 'OK' || e.status === 'OBSOLETE');
  let status = 'OK';
  const todosNoEncontrados = pedidos.length > 0 && pedidos.every((i) => !filas.has(i));
  if (todosNoEncontrados) status = 'NO_RESULTS';
  else if (!algunoOk && emp.omitidas.length) status = 'INSUFFICIENT_BUDGET';
  const res = sobre('detail', status, {
    tier: p.tier, requested: limpios.length, returned: entregadas.filter((e) => e.status === 'OK' || e.status === 'OBSOLETE').length, results: entregadas,
    total: limpios.length, has_more: fueraLote.length > 0, next_ids: fueraLote.length ? fueraLote.slice(0, MAX_OMITTED_IDS) : undefined,
    batch_limit: maxIds, omitted, budget: bloque, untrusted_content: true, content_format: 'plain_text',
  });
  if (status === 'INSUFFICIENT_BUDGET') {
    res.code = 'DETAIL_DOES_NOT_FIT'; res.needed_bytes = Math.min(...emp.omitidas.map((x) => x.needed_bytes)) + reserva;
    res.message = 'El contenido pedido no cabe en el presupuesto: amplía con expand_reason, sube el tier o pagina el contenido con content_offset/content_limit.';
  }
  if (extra > 0) res.budget.expanded = { reason: privacy.resumenSeguro(a.expand_reason, { max: 120 }), extra_bytes: extra };
  sellar(res, p);
  return { res, registrar: true, original_bytes: original };
}

// ───────────────────────────── capa 3: cronología ───────────────────────────
const COLS_EVENTO = 'event_id, event_type, host, role, task_id, cycle_id, session_id, occurred_at, sequence, status, paths, input_summary, output_summary, evidence_refs';
const FILTRO_PUBLICO = "privacy_class <> 'private' AND status <> 'SUPPRESSED'";
const claveEvento = (e) => [e.occurred_at, Number(e.sequence), e.event_id];

function cronologia(root, o = {}) {
  try {
    root = root || process.cwd();
    const c = normalizarComunes(o, 'timeline');
    if (c.error) return c.error;
    const a = c.a;
    const around = o.around && typeof o.around === 'object' && !Array.isArray(o.around) ? o.around : {};
    const eventId = around.event_id != null ? String(around.event_id) : (o.event_id != null ? String(o.event_id) : null);
    const nodeId = around.node_id != null ? String(around.node_id) : (o.node_id != null ? String(o.node_id) : null);
    if (eventId && nodeId) return argError('timeline', 'INVALID_ARGS', 'indica solo uno: around.event_id o around.node_id');
    for (const x of [eventId, nodeId]) if (x != null && (x.length > 120 || x.includes('\0'))) return argError('timeline', 'INVALID_ARGS', 'identificador demasiado largo');
    if (!eventId && !nodeId && !a.task_id) return argError('timeline', 'ANCHOR_REQUIRED', 'indica around.event_id, around.node_id o task_id');
    if (o.limit != null) { const n = Number(o.limit); if (!Number.isFinite(n) || n < 1) return argError('timeline', 'INVALID_ARGS', 'limit debe ser >= 1'); a.limit = Math.floor(n); }
    a.event_id = eventId; a.node_id = nodeId;
    const p = presupuestoDe(root, a);
    const ab = abrirLectura(root, REQ.timeline.concat(a.task_id ? ['mem_context_usage'] : []));
    if (ab.fail) return sobre('timeline', ab.fail.status, { ...ab.fail, budget: bloquePresupuesto(p, a) });
    const { db, pid } = ab;
    let r;
    try { r = construirCronologia(root, db, pid, a, p); } finally { cerrar(db); }
    if (r.registrar) registrarUso(root, a, 'timeline', r.res, { detail: r.detail });
    return r.res;
  } catch (e) { return errorSobre('timeline', e); }
}

function entradaEvento(e, obs, polPriv, root, esAncla) {
  let paths = [];
  try { const j = JSON.parse(e.paths || '[]'); paths = Array.isArray(j) ? j.map(String) : []; } catch { /* sin rutas legibles */ }
  paths = paths.filter((x) => !privacy.rutaPrivada(root, x)).slice(0, 10);
  let evs = [];
  try { const j = JSON.parse(e.evidence_refs || '[]'); evs = Array.isArray(j) ? j.map(String).filter((x) => /^ev_[a-f0-9]{16,64}$/.test(x)).slice(0, 10) : []; } catch { /* sin evidencias */ }
  const out = {
    kind: 'event', event_id: e.event_id, event_type: e.event_type, host: e.host, role: e.role || null, task_id: e.task_id || null, session_id: e.session_id,
    occurred_at: e.occurred_at, sequence: Number(e.sequence), status: e.status,
    paths, input_summary: e.input_summary ? privacy.resumenSeguro(e.input_summary, { max: 300, politica: polPriv }) : null,
    output_summary: e.output_summary ? privacy.resumenSeguro(e.output_summary, { max: 300, politica: polPriv }) : null,
    evidence_refs: evs,
    observations: obs.slice(0, 3).map((x) => ({ observation_id: x.observation_id, kind: x.kind, status: x.status, summary: privacy.resumenSeguro(x.summary || '', { max: 300, politica: polPriv }) })),
  };
  if (obs.length > 3) out.observations_truncated = obs.length - 3;
  if (esAncla) out.is_anchor = true;
  return conCoste(out);
}

function construirCronologia(root, db, pid, a, p) {
  const pol = p.pol;
  const polPriv = privacy.cargarPolitica(root);
  const limite = Math.min(a.limit || pol.timeline_limit, pol.max_timeline_limit);
  const alcance = { task_id: a.task_id || null, session_id: a.session_id || null };
  const kScope = sha(JSON.stringify([CONTRACT_VERSION, pid, alcance, a.event_id || null, a.node_id || null])).slice(0, 16);
  const vacio = (campos) => ({ res: sobre('timeline', 'NO_RESULTS', { scope: alcance, events: [], total: 0, returned: 0, has_more: false, budget: bloquePresupuesto(p, a), ...campos }), registrar: false });
  if (!pid && !a.node_id) return vacio({ code: 'NO_ACTIVITY', note: 'este proyecto aún no tiene actividad registrada' });

  const donde = ['project_id = ?', FILTRO_PUBLICO]; const params = [pid];
  if (a.task_id) { donde.push('task_id = ?'); params.push(a.task_id); }
  if (a.session_id) { donde.push('session_id = ?'); params.push(a.session_id); }
  const CLAUSULA_EV = donde.join(' AND ');
  const total = Number(db.get('SELECT count(*) AS n FROM mem_events WHERE ' + CLAUSULA_EV, ...params).n);
  const privados = Number(db.get("SELECT count(*) AS n FROM mem_events WHERE project_id = ? AND (privacy_class = 'private' OR status = 'SUPPRESSED')" + (a.task_id ? ' AND task_id = ?' : '') + (a.session_id ? ' AND session_id = ?' : ''), ...[pid].concat(a.task_id ? [a.task_id] : [], a.session_id ? [a.session_id] : [])).n);

  // ancla
  let ancla = null; let anclaEvento = null;
  if (a.event_id) {
    const e = db.get('SELECT ' + COLS_EVENTO + ' FROM mem_events WHERE project_id = ? AND ' + FILTRO_PUBLICO + ' AND event_id = ?', pid, a.event_id);
    if (!e) return vacio({ code: 'ANCHOR_NOT_AVAILABLE', anchor: { type: 'event' }, note: 'el evento no existe o no está disponible en este proyecto' });
    anclaEvento = e; ancla = { type: 'event', id: e.event_id };
  } else if (a.node_id) {
    const n = db.get('SELECT CAST(id AS TEXT) AS nid, titulo FROM nodos WHERE CAST(id AS TEXT) = ?', a.node_id);
    if (!n) return vacio({ code: 'ANCHOR_NOT_FOUND', anchor: { type: 'node', id: a.node_id } });
    const pv = procedenciaDe(db, pid, [n.nid]).get(n.nid);
    const idsEv = [...pv.events];
    ancla = { type: 'node', id: n.nid, title: privacy.resumenSeguro(n.titulo || '', { max: 120, politica: polPriv }), linked_events: idsEv.length, linked_observations: pv.observations.size };
    if (!idsEv.length) {
      const k = db.get('SELECT provenance FROM mem_knowledge WHERE node_id = ?', n.nid);
      return vacio({ code: 'NODE_WITHOUT_EVENTS', anchor: ancla, note: k ? 'el nodo no tiene actividad registrada' : 'conocimiento anterior a la procedencia (LEGACY_UNVERIFIED_PROVENANCE): no hay actividad que mostrar', legacy: !k || undefined });
    }
    const filas = [];
    enLotes(idsEv, 400, (lote) => { for (const e of db.all('SELECT ' + COLS_EVENTO + ' FROM mem_events WHERE project_id = ? AND ' + FILTRO_PUBLICO + ' AND event_id IN (' + MARCAS(lote.length) + ')', pid, ...lote)) filas.push(e); });
    filas.sort((x, y) => (x.occurred_at < y.occurred_at ? -1 : x.occurred_at > y.occurred_at ? 1 : (Number(x.sequence) - Number(y.sequence)) || (x.event_id < y.event_id ? -1 : 1)));
    anclaEvento = filas[0] || null;
    if (!anclaEvento) return vacio({ code: 'ANCHOR_NOT_AVAILABLE', anchor: ancla });
  } else ancla = { type: 'task', id: a.task_id };

  const sqlAntes = (k) => 'SELECT ' + COLS_EVENTO + ' FROM mem_events WHERE ' + CLAUSULA_EV + ' AND (occurred_at < ? OR (occurred_at = ? AND (sequence < ? OR (sequence = ? AND event_id < ?)))) ORDER BY occurred_at DESC, sequence DESC, event_id DESC LIMIT ?';
  const sqlDespues = () => 'SELECT ' + COLS_EVENTO + ' FROM mem_events WHERE ' + CLAUSULA_EV + ' AND (occurred_at > ? OR (occurred_at = ? AND (sequence > ? OR (sequence = ? AND event_id > ?)))) ORDER BY occurred_at ASC, sequence ASC, event_id ASC LIMIT ?';
  const kp = (k) => [k[0], k[0], k[1], k[1], k[2]];
  const existeAntes = (k) => !!db.get('SELECT 1 AS x FROM mem_events WHERE ' + CLAUSULA_EV + ' AND (occurred_at < ? OR (occurred_at = ? AND (sequence < ? OR (sequence = ? AND event_id < ?)))) LIMIT 1', ...params, ...kp(k));
  const existeDespues = (k) => !!db.get('SELECT 1 AS x FROM mem_events WHERE ' + CLAUSULA_EV + ' AND (occurred_at > ? OR (occurred_at = ? AND (sequence > ? OR (sequence = ? AND event_id > ?)))) LIMIT 1', ...params, ...kp(k));

  // ventana
  let modo; let items;
  if (a.cursor) {
    const c = unb64(a.cursor);
    if (!c || c.v !== 1 || !['f', 'b'].includes(c.d) || !Array.isArray(c.k) || c.k.length !== 3 || c.s !== kScope) return { res: argError('timeline', 'INVALID_CURSOR', 'el cursor no corresponde a esta consulta'), registrar: false };
    modo = c.d === 'f' ? 'forward' : 'backward';
    items = modo === 'forward' ? db.all(sqlDespues(), ...params, ...kp(c.k), limite) : db.all(sqlAntes(), ...params, ...kp(c.k), limite).reverse();
  } else if (anclaEvento) {
    const k = claveEvento(anclaEvento);
    const nb = Math.floor((limite - 1) / 2);
    const antes = nb > 0 ? db.all(sqlAntes(), ...params, ...kp(k), nb).reverse() : [];
    const despues = db.all(sqlDespues(), ...params, ...kp(k), Math.max(0, limite - 1 - antes.length));
    modo = 'window'; items = antes.concat([anclaEvento], despues);
  } else {
    modo = 'forward'; items = db.all('SELECT ' + COLS_EVENTO + ' FROM mem_events WHERE ' + CLAUSULA_EV + ' ORDER BY occurred_at ASC, sequence ASC, event_id ASC LIMIT ?', ...params, limite);
  }
  if (!items.length) return vacio({ code: 'NO_EVENTS_IN_RANGE', anchor: ancla, total, omitted: bloqueOmitidos({ privacidad: privados }, []), note: 'no hay más actividad en esa dirección' });

  // observaciones de la ventana
  const obsPor = new Map();
  enLotes(items.map((e) => e.event_id), 400, (lote) => {
    for (const r of db.all("SELECT oe.event_id AS eid, o.observation_id, o.kind, o.summary, o.status, o.created_at FROM mem_observation_events oe JOIN mem_observations o ON o.observation_id = oe.observation_id WHERE o.project_id = ? AND o.status <> 'SUPPRESSED' AND oe.event_id IN (" + MARCAS(lote.length) + ') ORDER BY o.created_at, o.observation_id', pid, ...lote)) {
      if (!obsPor.has(r.eid)) obsPor.set(r.eid, []);
      obsPor.get(r.eid).push(r);
    }
  });
  const anclaId = anclaEvento ? anclaEvento.event_id : null;
  const entradas = items.map((e) => entradaEvento(e, obsPor.get(e.event_id) || [], polPriv, root, e.event_id === anclaId && modo === 'window'));

  // presupuesto: contigüidad cronológica → se entrega por cercanía al punto de partida y se corta en el primer hueco
  const capCapa = Math.floor(p.limite * pol.share_timeline);
  const capLlamada = topeLlamada(p, a, capCapa);
  let extra = 0;
  const reserva = ENVELOPE_RESERVE;
  const ordenProximidad = (() => {
    if (modo === 'window') {
      const ia = items.findIndex((e) => e.event_id === anclaId);
      const orden = [ia];
      for (let d = 1; d < items.length; d++) { if (ia + d < items.length) orden.push(ia + d); if (ia - d >= 0) orden.push(ia - d); }
      return orden;
    }
    return modo === 'forward' ? items.map((_, i) => i) : items.map((_, i) => items.length - 1 - i);
  })();
  const elegir = (cap) => {
    const sel = new Set(); let usados = 0;
    for (const i of ordenProximidad) { const c = entradas[i].cost.bytes; if (usados + c > cap) break; sel.add(i); usados += c; }
    return sel;
  };
  let sel = elegir(Math.max(0, capLlamada - reserva));
  if (sel.size < entradas.length && a.expand) {
    extra = ampliar(p, a, capLlamada, entradas.reduce((s, e) => s + e.cost.bytes, 0) + reserva);
    if (extra > 0) sel = elegir(Math.max(0, capLlamada + extra - reserva));
  }
  const bloque = bloquePresupuesto(p, a, capLlamada + extra);
  const entreg = [...sel].sort((x, y) => x - y).map((i) => ({ i, e: entradas[i], ev: items[i] }));
  const omitidosPres = entradas.length - entreg.length;
  if (!entreg.length) {
    const res = sobre('timeline', 'INSUFFICIENT_BUDGET', {
      code: 'TIMELINE_DOES_NOT_FIT', needed_bytes: Math.min(...entradas.map((e) => e.cost.bytes)) + reserva, anchor: ancla, scope: alcance, total, budget: bloque,
      message: 'Ni el primer evento cabe en el presupuesto: amplía con expand_reason, sube el tier o reduce limit.',
    });
    sellar(res, p);
    return { res, registrar: true, detail: 'insufficient' };
  }
  const primero = entreg[0].ev; const ultimo = entreg[entreg.length - 1].ev;
  const hayDespues = existeDespues(claveEvento(ultimo));
  const hayAntes = existeAntes(claveEvento(primero));
  const res = sobre('timeline', 'OK', {
    anchor: ancla, scope: alcance, mode: modo, events: entreg.map((x) => x.e), total, returned: entreg.length, limit: limite,
    has_more: hayDespues || hayAntes, has_more_next: hayDespues, has_more_prev: hayAntes,
    next_cursor: hayDespues ? b64({ v: 1, d: 'f', k: claveEvento(ultimo), s: kScope }) : null,
    prev_cursor: hayAntes ? b64({ v: 1, d: 'b', k: claveEvento(primero), s: kScope }) : null,
    omitted: bloqueOmitidos({ presupuesto: omitidosPres, privacidad: privados }, []),
    budget: bloque, untrusted_content: true, content_format: 'plain_text',
  });
  delete res.omitted.ids;
  if (modo === 'window' && !res.events.some((e) => e.is_anchor)) res.anchor_delivered = false;
  if (extra > 0) res.budget.expanded = { reason: privacy.resumenSeguro(a.expand_reason, { max: 120 }), extra_bytes: extra };
  sellar(res, p);
  return { res, registrar: true, detail: modo };
}

// ───────────────────────────── capa 4: evidencia ────────────────────────────
function evidencia(root, evidence_id, selector = {}, o = {}) {
  try {
    root = root || process.cwd();
    const c = normalizarComunes(o, 'evidence');
    if (c.error) return c.error;
    const a = c.a;
    if (typeof evidence_id !== 'string' || !evidence_id || evidence_id.length > 120) return argError('evidence', 'INVALID_ARGS', 'evidence_id debe ser el identificador ev_… de una evidencia');
    if (selector == null || typeof selector !== 'object' || Array.isArray(selector)) return argError('evidence', 'INVALID_ARGS', 'selector debe ser un objeto');
    const sel = {};
    for (const k of ['offset', 'length', 'line_from', 'line_to']) if (selector[k] != null) { const n = Number(selector[k]); if (!Number.isFinite(n) || n < 0) return argError('evidence', 'INVALID_ARGS', k + ' debe ser un número >= 0'); sel[k] = Math.floor(n); }
    if (selector.cursor != null) {
      const cu = selector.cursor;
      if (typeof cu !== 'object' || Array.isArray(cu)) return argError('evidence', 'INVALID_CURSOR', 'cursor de evidencia inválido');
      if (Number.isFinite(Number(cu.line_from))) { if (sel.line_from == null) sel.line_from = Math.floor(Number(cu.line_from)); } else if (Number.isFinite(Number(cu.offset))) sel.offset = sel.offset != null ? sel.offset : Math.floor(Number(cu.offset));
    }
    if (selector.json != null) {
      if (typeof selector.json !== 'object' || Array.isArray(selector.json)) return argError('evidence', 'INVALID_ARGS', 'json debe ser un objeto {path, fields, offset, limit}');
      sel.json = {};
      if (selector.json.path != null) sel.json.path = String(selector.json.path).slice(0, 200);
      if (selector.json.fields != null) { if (!Array.isArray(selector.json.fields)) return argError('evidence', 'INVALID_ARGS', 'json.fields debe ser una lista'); sel.json.fields = selector.json.fields.slice(0, 50).map(String); }
      for (const k of ['offset', 'limit']) if (selector.json[k] != null) sel.json[k] = Number(selector.json[k]);
    }
    const p = presupuestoDe(root, a);
    // Sin tablas o sin base, el propio almacén lo dice con su estado explícito.
    const capLlamada = topeLlamada(p, a, Infinity);
    let extra = 0;
    const reserva = 900;
    let contenidoCap = capLlamada - reserva;
    if (contenidoCap < MIN_EVIDENCE_PAGE) {
      extra = ampliar(p, a, capLlamada, MIN_EVIDENCE_PAGE + reserva);
      contenidoCap = capLlamada + extra - reserva;
    }
    const bloque = bloquePresupuesto(p, a, capLlamada + extra);
    const envolver = (r) => {
      const { ok, ...resto } = r;
      return sobre('evidence', r.status || (ok ? 'OK' : 'ERROR'), resto);
    };
    if (contenidoCap < MIN_EVIDENCE_PAGE) {
      // ¿Existe siquiera? Si no, el estado correcto no es "presupuesto".
      const v = store.verificar(root, evidence_id);
      if (!v.ok) { const res = envolver(v); res.budget = bloque; return res; }
      const res = sobre('evidence', 'INSUFFICIENT_BUDGET', { evidence_id, code: 'EVIDENCE_PAGE_DOES_NOT_FIT', needed_bytes: MIN_EVIDENCE_PAGE + reserva, available_bytes: capLlamada, total_bytes: v.bytes, sha256: v.sha256, message: 'No cabe ni una página mínima: amplía con expand_reason o sube el tier.', budget: bloque });
      sellar(res, p);
      if (a.task_id) registrarUso(root, a, 'evidence_retrieval', res, { detail: 'insufficient' });
      return res;
    }
    let tope = Math.min(contenidoCap, store.LIMITES.max_page_bytes);
    let r = null; let res = null;
    for (let intento = 0; intento < 4; intento++) {
      const s2 = { ...sel };
      if (!s2.json && s2.line_from == null && s2.line_to == null) s2.length = Math.min(sel.length != null ? sel.length : store.LIMITES.page_bytes, tope);
      r = store.obtener(root, evidence_id, s2, { max_page_bytes: tope, touch: intento === 0 });
      if (!r.ok) break;
      res = envolver(r);
      const redc = privacy.redactarSecretos(res.content, privacy.cargarPolitica(root));
      if (!redc.ok) { res.content = privacy.FALLO; res.content_withheld = 'REDACCION_FALLIDA'; } else if (redc.redactions > 0 && redc.text !== res.content) { res.content = redc.text; res.redactions = redc.redactions; res.note_redaction = 'el original almacenado es íntegro; lo entregado tapa secretos (el hash es el del original)'; }
      res.budget = bloque; res.untrusted_content = true; res.content_format = 'plain_text';
      if (res.has_more && res.range && res.range.offset !== undefined) {
        // Qué queda fuera y por qué: la página se acortó por el presupuesto o simplemente es el tamaño de página.
        const pedida = Math.min(sel.length != null ? sel.length : store.LIMITES.page_bytes, store.LIMITES.max_page_bytes);
        res.omitted = { remaining_bytes: Number(res.total_bytes) - (res.range.offset + res.range.length), reason: tope < pedida ? 'presupuesto' : 'pagina' };
      }
      sellar(res, p);
      if (res.budget.este_llamado <= capLlamada + extra || sel.json) break;
      tope = Math.floor(tope * 0.7);
      if (tope < MIN_EVIDENCE_PAGE) break;
    }
    if (!r.ok) { const e = envolver(r); e.budget = bloque; sellar(e, p); return e; }
    if (res.budget.este_llamado > capLlamada + extra) {
      // La página no cupo ni reduciéndola (el JSON escapa saltos y comillas): solo una ampliación justificada la deja pasar.
      const e2 = ampliar(p, a, capLlamada + extra, res.budget.este_llamado);
      if (capLlamada + extra + e2 >= res.budget.este_llamado) extra += e2;
      else {
        const e = sobre('evidence', 'INSUFFICIENT_BUDGET', { evidence_id, code: 'EVIDENCE_PAGE_DOES_NOT_FIT', needed_bytes: res.budget.este_llamado, available_bytes: capLlamada, message: 'La página mínima no cabe en el presupuesto: amplía con expand_reason o sube el tier.', budget: bloque });
        sellar(e, p);
        return e;
      }
    }
    if (extra > 0) res.budget.expanded = { reason: privacy.resumenSeguro(a.expand_reason, { max: 120 }), extra_bytes: extra };
    registrarUso(root, a, 'evidence_retrieval', res, { original_bytes: Number(res.total_bytes) || 0, detail: evidence_id.slice(0, 20) });
    return res;
  } catch (e) { return errorSobre('evidence', e); }
}

// ───────────────────────────── CLI ──────────────────────────────────────────
function parsearArgs(argv) {
  const opt = {}; const libres = [];
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([^=]+)(?:=([\s\S]*))?$/.exec(argv[i]);
    if (m) opt[m[1]] = m[2] === undefined ? true : m[2]; else libres.push(argv[i]);
  }
  return { opt, libres };
}
const lista = (v) => (v === undefined || v === true ? undefined : String(v).split(',').map((s) => s.trim()).filter(Boolean));
const numero = (v) => (v === undefined || v === true ? undefined : Number(v));

function comunesCli(opt) {
  return { tier: opt.tier, task_id: opt.task, role: opt.role, session_id: opt.session, budget_bytes: numero(opt.budget), expand_reason: typeof opt['expand-reason'] === 'string' ? opt['expand-reason'] : undefined, cursor: typeof opt.cursor === 'string' ? opt.cursor : undefined };
}

function ejecutarCli(argv, salida) {
  const cmd = argv[0];
  const { opt, libres } = parsearArgs(argv.slice(1));
  const root = typeof opt.root === 'string' ? path.resolve(opt.root) : process.cwd();
  const out = salida || ((x) => console.log(JSON.stringify(x, null, 2)));
  let res;
  if (cmd === 'index') {
    res = indice(root, { ...comunesCli(opt), query: typeof opt.query === 'string' ? opt.query : libres.join(' ') || undefined, paths: lista(opt.paths), type: opt.type, area: opt.area, state: lista(opt.state), include_obsolete: !!opt['include-obsolete'], limit: numero(opt.limit) });
  } else if (cmd === 'detail') {
    const ids = lista(opt.ids) || libres;
    res = detalle(root, ids, { ...comunesCli(opt), include_obsolete: !!opt['include-obsolete'], content_offset: numero(opt['content-offset']), content_limit: numero(opt['content-limit']) });
  } else if (cmd === 'timeline') {
    res = cronologia(root, { ...comunesCli(opt), around: { event_id: typeof opt.event === 'string' ? opt.event : undefined, node_id: typeof opt.node === 'string' ? opt.node : undefined }, limit: numero(opt.limit) });
  } else if (cmd === 'evidence') {
    const id = libres[0] || (typeof opt.id === 'string' ? opt.id : undefined);
    const sel = {};
    if (opt.offset !== undefined) sel.offset = numero(opt.offset);
    if (opt.length !== undefined) sel.length = numero(opt.length);
    if (opt['line-from'] !== undefined) sel.line_from = numero(opt['line-from']);
    if (opt['line-to'] !== undefined) sel.line_to = numero(opt['line-to']);
    if (opt['json-path'] !== undefined || opt.fields !== undefined) sel.json = { path: typeof opt['json-path'] === 'string' ? opt['json-path'] : undefined, fields: lista(opt.fields), offset: numero(opt['json-offset']), limit: numero(opt['json-limit']) };
    res = evidencia(root, id, sel, comunesCli(opt));
  } else {
    out({ contract_version: CONTRACT_VERSION, status: 'ERROR', code: 'USAGE', message: 'Uso: node memory-layers.cjs index|detail|timeline|evidence [--root=dir] [--task=T-1] [--tier=LOW|MEDIUM|HIGH] [--budget=bytes] [--expand-reason="…"] — index: --query --paths=a,b --type --area --state=A,B --limit --cursor | detail: <id…> | --ids=1,2 | timeline: --event=<id>|--node=<id> | evidence: <ev_id> [--offset --length --line-from --line-to --json-path --fields]' });
    return 2;
  }
  out(res);
  return res.status === 'OK' || res.status === 'NO_RESULTS' ? 0 : 1;
}

module.exports = {
  CONTRACT_VERSION, POLICY_VERSION, POLITICA, ESTIMACION, STATUS, ENVELOPE_RESERVE,
  indice, detalle, cronologia, evidencia, presupuestoDe, limpiarCache, ejecutarCli,
};

if (require.main === module) process.exitCode = ejecutarCli(process.argv.slice(2));
