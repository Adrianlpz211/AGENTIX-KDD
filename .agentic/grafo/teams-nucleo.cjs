'use strict';
/**
 * Puente TEAMS → núcleo Agentix (3.20.1, spec TEAMS §10 y §11).
 *
 * `aa:` y `teams:` NO son dos frameworks: lo que Cursor y Claude Code hacen en modo TEAMS se registra en el
 * MISMO núcleo (ciclos, episodios, contratos, AST, layout de UI, preservación, memoria KDD, dashboard). Este
 * módulo es la función canónica común que lo garantiza, con `origen = 'teams'`.
 *
 *   registrarCierre(root, p)        un cierre de construcción/corrección → evento + job OBLIGATORIO en una
 *                                   sola transacción (outbox) y, después, el procesador del cierre.
 *   registrarRevision(root, p)      el veredicto de un revisor, ENLAZADO al ciclo de construcción (no crea otro).
 *   procesarPendientes(root, o)     reproduce el spool local y procesa los jobs `teams_cierre` con lease,
 *                                   reintentos con backoff y dead-letter visible.
 *   estadoMemoria(root, {plan_id})  pendientes / hechos / dead-letter: lo que el cierre final y el dashboard leen.
 *   cobertura(root, {plan_id})      actividades esperadas CON registro obligatorio ÷ esperadas (ledger del plan).
 *   ciclosPorOrigen(root, {origen}) el mismo backend de ciclos, filtrado por origen (aa | teams).
 *
 * Garantías (cada una tiene prueba):
 *   · Idempotencia por identidad del evento (plan, tarea, intento, corrección, hash del sujeto): reintentar un
 *     cierre NO duplica ciclo, episodio, contrato ni nodo. El ciclo lleva un id determinista `teams_<hash>`.
 *   · Si la memoria no se puede escribir (update en curso, base ocupada, esquema ausente) el cierre se guarda en
 *     un spool local durable y el estado es MEMORY_PENDING; el trabajo independiente sigue, y el cierre final NO
 *     es completo mientras haya pendientes o dead-letter (`estadoMemoria().listo_para_cierre`).
 *   · «Sin aprendizaje nuevo» es un resultado legítimo y queda registrado como tal: nunca se fabrica un nodo
 *     vacío para aparentar cobertura.
 *   · No se repite el TDD ni la preservación cuando el cierre trae evidencia PASS verificada del sujeto
 *     (gate-result.allowsVerifiedClose); sin esa evidencia, el cierre corre el gate de verdad. Nada de PASS inventados.
 *   · Todo lo que entra a la base pasa por memory-privacy; las escrituras respetan update-guard (db-adapter).
 *   · Un heartbeat o sondeo vacío NO es un cierre: este módulo solo se invoca por cierre real.
 *   · El proceso hijo de post-cycle corre UNA vez por cierre, con el ciclo, los archivos y las omisiones declarados.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const core = require('./memory-core.cjs');
const q = require('./memory-queue.cjs');
const privacy = require('./memory-privacy.cjs');

const HOST = 'teams';
const KIND_JOB = 'teams_cierre';
const EVENTO_CIERRE = 'teams_cierre';
const EVENTO_REVISION = 'teams_revision';
const PREFIJO_CICLO = 'teams_';
const SEP = '|';
const REVISORES = ['frontend', 'backend', 'negocio'];
const VEREDICTOS = ['PASS', 'FAIL', 'FINDINGS', 'NOT_APPLICABLE'];
const CODIGOS_DEGRADADOS = new Set(['NO_DB', 'SCHEMA_MISSING', 'DB_BUSY', 'UPDATE_IN_PROGRESS', 'CAPTURE_FAILED', 'QUEUE_FULL']);
const LIMITES = Object.freeze({ files: 200, aprendizajes: 10, titulo: 200, contenido: 4000, resumen: 600, hijo_ms: 15 * 60 * 1000, lease_ms: 20 * 60 * 1000 });

const sha = (x) => crypto.createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex');
const isoAhora = (o) => new Date(o && o.now ? o.now : Date.now()).toISOString();
const ID = /^[\w.:-]{1,80}$/;
const aEnteroPositivo = (v, d) => (Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : d);

const dirNucleo = (root) => path.join(root, '.agentic', '_teams', 'nucleo');
const dirSpool = (root) => path.join(dirNucleo(root), 'outbox');

// ───────────────────────────── identidad ────────────────────────────────────

/** Id de ciclo determinista: el mismo cierre → el mismo ciclo, aunque se reintente. Prefijo = origen TEAMS. */
function idCiclo({ plan_id, task_id, attempt = 1, correction_id = '', subject_hash = '' }) {
  return PREFIJO_CICLO + sha([plan_id, task_id, attempt, correction_id || '', subject_hash || ''].join(SEP)).slice(0, 24);
}
const esCicloTeams = (cycleId) => typeof cycleId === 'string' && cycleId.startsWith(PREFIJO_CICLO);

const hash16 = (h) => String(h || '-').replace(/[^\w.:-]/g, '').slice(0, 16) || '-';

/** Clave estable del evento de cierre. El hash del sujeto separa "otro código" de "el mismo cierre reintentado". */
function claveCierre(p) {
  return [EVENTO_CIERRE, p.tipo, p.plan_id, p.task_id, p.attempt, p.correction_id || '-', hash16(p.subject_hash)].join(SEP);
}
function claveRevision(p) {
  return [EVENTO_REVISION, p.plan_id, p.task_id, p.revisor, p.auditor_id || '-', hash16(p.subject_hash), p.revision == null ? '-' : p.revision].join(SEP);
}
/** Inversa de claveCierre/claveRevision (solo lectura de lo ya persistido). */
function leerClave(host_event_id) {
  const t = String(host_event_id || '').split(SEP);
  if (t[0] === EVENTO_CIERRE) return { evento: t[0], tipo: t[1], plan_id: t[2], task_id: t[3], attempt: t[4], correction_id: t[5] === '-' ? null : t[5], hash16: t[6] };
  if (t[0] === EVENTO_REVISION) return { evento: t[0], plan_id: t[1], task_id: t[2], revisor: t[3], auditor_id: t[4] === '-' ? null : t[4], hash16: t[5], revision: t[6] === '-' ? null : t[6] };
  return null;
}

// ───────────────────────────── validación ───────────────────────────────────

function normalizarArchivos(root, files) {
  const entrada = Array.isArray(files) ? files : [];
  const limpios = []; let privados = 0; const rechazados = [];
  for (const f of entrada.slice(0, LIMITES.files)) {
    const n = privacy.normRuta(String(f || '').trim());
    if (!n || path.isAbsolute(n) || /^[a-z]:/i.test(n) || n.split('/').includes('..')) { rechazados.push(String(f).slice(0, 80)); continue; }
    // Una ruta privada (.env, claves…) NO viaja: dejaría el evento SUPPRESSED y el cierre sin procesar.
    if (privacy.rutaPrivada(root, n)) { privados++; continue; }
    if (!limpios.includes(n)) limpios.push(n);
  }
  return { files: limpios, privados_omitidos: privados, rechazados };
}

function validarComun(p) {
  const e = [];
  if (!p || typeof p !== 'object') return ['PARAMETROS_VACIOS'];
  if (!ID.test(String(p.plan_id || ''))) e.push('PLAN_ID_INVALIDO');
  if (!ID.test(String(p.task_id || ''))) e.push('TASK_ID_INVALIDO');
  for (const k of ['sprint_id', 'phase_id', 'correction_id', 'auditor_id']) if (p[k] != null && !ID.test(String(p[k]))) e.push(k.toUpperCase() + '_INVALIDO');
  if (p.subject_hash != null && !/^[\w.:-]{4,128}$/.test(String(p.subject_hash))) e.push('SUBJECT_HASH_INVALIDO');
  return e;
}

function areaDe(p, files) {
  const a = String(p.area || '').trim() || (files[0] ? files[0].split('/')[0] : '') || 'global';
  return a.replace(/[^\w.-]+/g, '-').slice(0, 60) || 'global';
}

/** Evidencia de gate reutilizable: SOLO si pasa allowsVerifiedClose con el sujeto exacto. */
function evidenciaReutilizable(root, p, files) {
  const reuse = {}; const motivos = {};
  const { allowsVerifiedClose } = require('./gate-result.cjs');
  for (const g of Array.isArray(p.gates) ? p.gates : []) {
    if (!g || typeof g !== 'object') continue;
    const clave = ['tdd', 'tests'].includes(g.gate) ? 'tdd' : (g.gate === 'preservation' ? 'preservacion' : null);
    if (!clave) continue;
    let ok = false;
    try { ok = g.status === 'PASS' && (!p.subject_hash || g.subject_hash === p.subject_hash) && allowsVerifiedClose(g, { root, paths: files, gate: g.gate }); } catch { ok = false; }
    if (ok) reuse[clave] = { execution_id: g.execution_id || null, status: 'PASS' };
    else motivos[clave] = 'EVIDENCIA_NO_VERIFICABLE_DEL_SUJETO';
  }
  return { reuse, motivos };
}

// ───────────────────────────── spool local (sin pérdida) ────────────────────

function escribirAtomico(f, contenido) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.' + process.pid + '.' + crypto.randomBytes(3).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, contenido);
  fs.renameSync(tmp, f);
}

function guardarSpool(root, clave, registro) {
  try { escribirAtomico(path.join(dirSpool(root), sha(clave).slice(0, 24) + '.json'), JSON.stringify(registro)); return true; } catch { return false; }
}
function listarSpool(root) {
  try { return fs.readdirSync(dirSpool(root)).filter((n) => n.endsWith('.json')).map((n) => path.join(dirSpool(root), n)); } catch { return []; }
}

// ───────────────────────────── captura (outbox) ─────────────────────────────

/** Guarda el payload completo como evidencia durable (redactada) y devuelve su id, o null si el almacén no puede. */
function guardarPayload(root, payload, scope, opts) {
  try {
    const ev = require('./evidence-store.cjs');
    const r = ev.guardar(root, { text: JSON.stringify(payload) }, { kind: 'teams_cierre', retention: 'durable_audit', scope, content_type: 'application/json', now: opts && opts.now });
    return r && r.ok ? r.evidence_id : null;
  } catch { return null; }
}

/**
 * Evento + job obligatorio (UNA transacción dentro de memory-core.capturar). Si la memoria no puede escribir,
 * el cierre queda en el spool local y se reproduce cuando vuelva: no se pierde el trabajo.
 */
function capturarOSpool(root, ev, payload, opts) {
  const cap = core.capturar(root, ev, { required: true, job_kind: KIND_JOB, now: opts && opts.now });
  if (cap.ok) return Object.assign({ spool: false }, cap);
  if (!CODIGOS_DEGRADADOS.has(cap.code) && cap.status !== 'BACKPRESSURE') return Object.assign({ spool: false }, cap); // rechazo real: no se reencola
  const guardado = guardarSpool(root, ev.host_event_id, { ev, payload, guardado_at: isoAhora(opts), motivo: cap.code });
  return { ok: false, status: 'MEMORY_PENDING', code: cap.code, message: cap.message, spool: guardado, event_key: ev.host_event_id };
}

/** Cierre canónico. Ver cabecera. `p.procesar === false` solo captura (la cola lo procesa luego). */
function registrarCierre(root, p, opts = {}) {
  const errores = validarComun(p);
  if (errores.length) return { ok: false, status: 'RECHAZADO', code: 'INVALID_CLOSE', errores };
  const { files, privados_omitidos, rechazados } = normalizarArchivos(root, p.files);
  const tipo = p.tipo === 'correccion' || p.correction_id ? 'correccion' : 'construccion';
  const attempt = aEnteroPositivo(p.attempt, 1) || 1;
  const comun = { plan_id: String(p.plan_id), task_id: String(p.task_id), attempt, correction_id: p.correction_id ? String(p.correction_id) : null, subject_hash: p.subject_hash ? String(p.subject_hash) : null, tipo };
  const cycle_id = p.cycle_id && /^teams_[a-f0-9]{8,64}$/.test(p.cycle_id) ? p.cycle_id : idCiclo(comun);
  const clave = claveCierre(comun);
  // Una corrección con cambio de código tiene ciclo PROPIO, enlazado al de la entrega/hallazgo que corrige (si se declara).
  const corrige = tipo === 'correccion' && p.corrige && typeof p.corrige === 'object' && ID.test(String(p.corrige.task_id || comun.task_id))
    ? idCiclo({ plan_id: comun.plan_id, task_id: String(p.corrige.task_id || comun.task_id), attempt: aEnteroPositivo(p.corrige.attempt, 1) || 1, correction_id: '', subject_hash: p.corrige.subject_hash ? String(p.corrige.subject_hash) : '' }) : null;
  const pol = privacy.cargarPolitica(root);
  const { reuse, motivos } = evidenciaReutilizable(root, p, files);

  const aprendizajes = (Array.isArray(p.aprendizajes) ? p.aprendizajes : []).slice(0, LIMITES.aprendizajes)
    .filter((a) => a && String(a.titulo || '').trim() && String(a.contenido || '').trim())
    .map((a) => ({
      tipo: String(a.tipo || 'patron').replace(/[^\w-]/g, '').slice(0, 30) || 'patron',
      titulo: String(a.titulo).slice(0, LIMITES.titulo), contenido: String(a.contenido).slice(0, LIMITES.contenido),
      causa: a.causa ? String(a.causa).slice(0, 600) : null, area: a.area ? String(a.area).replace(/[^\w.-]+/g, '-').slice(0, 60) : null,
      archivos: (Array.isArray(a.archivos) ? a.archivos : files).map(String).slice(0, 50),
    }));

  const payload = privacy.sanitizarValor({
    schema: 1, origen: 'teams', tipo, plan_id: comun.plan_id, sprint_id: p.sprint_id || null, phase_id: p.phase_id || null, task_id: comun.task_id,
    attempt, cycle_id, corrige_ciclo: corrige, correction_id: comun.correction_id, auditor_id: p.auditor_id || null, subject_hash: comun.subject_hash,
    area: areaDe(p, files), files, privados_omitidos, tests: aEnteroPositivo(p.tests, 0), tests_total: aEnteroPositivo(p.tests_total, aEnteroPositivo(p.tests, 0)),
    resumen: privacy.resumenSeguro(p.resumen || '', { max: LIMITES.resumen, politica: pol }), tarea: privacy.resumenSeguro(p.tarea || p.objective || comun.task_id, { max: 160, politica: pol }),
    aprendizajes, sin_aprendizaje: aprendizajes.length ? null : privacy.resumenSeguro(p.sin_aprendizaje || 'no declarado por el productor del cierre', { max: 300, politica: pol }),
    reuse, reuse_rechazado: motivos, browser: p.browser === true, modules: p.modules || null, registrado_por: p.rol === 'builder' ? 'builder' : 'director',
  }, pol);
  // sanitizarValor tapa por NOMBRE de clave y no toca números: `reuse.*.execution_id` conserva su valor.
  payload.subject_hash = comun.subject_hash; payload.cycle_id = cycle_id;

  const evidence_id = guardarPayload(root, payload, comun.task_id, opts);
  const ev = {
    host: HOST, session_id: 'plan:' + comun.plan_id, host_event_id: clave, event_type: EVENTO_CIERRE, role: payload.registrado_por,
    task_id: comun.task_id, cycle_id, paths: files, evidence_refs: evidence_id ? [evidence_id] : [],
    input: { plan: comun.plan_id, sprint: payload.sprint_id, phase: payload.phase_id, attempt, tipo, correccion: comun.correction_id, auditor: payload.auditor_id, area: payload.area },
    output: { tests: payload.tests, aprendizajes: aprendizajes.length, sujeto: hash16(comun.subject_hash) },
    occurred_at: p.occurred_at,
  };
  const cap = capturarOSpool(root, ev, payload, opts);
  const base = { event_id: cap.event_id || null, job_id: cap.job_id || null, cycle_id, event_key: clave, tipo, archivos_rechazados: rechazados.length ? rechazados : undefined, privados_omitidos: privados_omitidos || undefined };
  if (!cap.ok) {
    if (cap.status === 'MEMORY_PENDING') return Object.assign({ ok: false, memoria: 'MEMORY_PENDING', spool: cap.spool }, base, { status: 'MEMORY_PENDING', code: cap.code, message: cap.message });
    return Object.assign({ ok: false }, base, { status: cap.status || 'RECHAZADO', code: cap.code, message: cap.message });
  }
  if (opts.procesar === false || p.procesar === false) return Object.assign({ ok: true, status: 'CAPTURADO', duplicado: cap.status === 'DUPLICATE' }, base);
  const proc = procesarPendientes(root, Object.assign({}, opts, { max: opts.max || 25 }));
  const est = estadoDeEvento(root, base.event_id);
  const estado = est ? est.estado : 'MEMORY_PENDING';
  return Object.assign({ ok: estado === 'REGISTRADO', status: estado, duplicado: cap.status === 'DUPLICATE', procesamiento: { procesados: proc.procesados, registrados: proc.registrados, reintentos: proc.reintentos, dead_letter: proc.dead_letter } }, base, est && est.error_code ? { code: est.error_code } : {});
}

/**
 * Veredicto de un revisor (frontend/backend/negocio), ENLAZADO al ciclo de construcción de esa entrega: no crea
 * otro ciclo. NOT_APPLICABLE exige motivo. Un veredicto que el revisor no emitió no se inventa: sin `veredicto`
 * el registro queda SIN_VEREDICTO y no cuenta como PASS.
 */
function registrarRevision(root, p, opts = {}) {
  const errores = validarComun(p);
  if (p && p.revisor) p = Object.assign({}, p, { revisor: normalizarRevisor(p.revisor) });
  if (!REVISORES.includes(p && p.revisor)) errores.push('REVISOR_INVALIDO');
  if (p && p.veredicto != null && !VEREDICTOS.includes(p.veredicto)) errores.push('VEREDICTO_INVALIDO');
  if (p && p.veredicto === 'NOT_APPLICABLE' && !String(p.motivo || '').trim()) errores.push('NOT_APPLICABLE_SIN_MOTIVO');
  if (errores.length) return { ok: false, status: 'RECHAZADO', code: 'INVALID_REVIEW', errores };
  const attempt = aEnteroPositivo(p.attempt, 1) || 1;
  const construccion = { plan_id: String(p.plan_id), task_id: String(p.task_id), attempt, correction_id: null, subject_hash: p.subject_hash ? String(p.subject_hash) : null, tipo: 'construccion' };
  const cycle_id = p.cycle_id && /^teams_[a-f0-9]{8,64}$/.test(p.cycle_id) ? p.cycle_id : idCiclo(construccion);
  const { files } = normalizarArchivos(root, p.files);
  const pol = privacy.cargarPolitica(root);
  const clave = claveRevision({ plan_id: construccion.plan_id, task_id: construccion.task_id, revisor: p.revisor, auditor_id: p.auditor_id, subject_hash: construccion.subject_hash, revision: p.revision });
  const payload = privacy.sanitizarValor({
    schema: 1, origen: 'teams', plan_id: construccion.plan_id, task_id: construccion.task_id, cycle_id, revisor: p.revisor, auditor_id: p.auditor_id || null,
    scope: p.scope ? String(p.scope).slice(0, 120) : null, subject_hash: construccion.subject_hash, revision: p.revision == null ? null : Number(p.revision),
    veredicto: p.veredicto || 'SIN_VEREDICTO', hallazgos: (Array.isArray(p.hallazgos) ? p.hallazgos : []).map(String).filter((x) => ID.test(x)).slice(0, 50),
    motivo: p.motivo ? privacy.resumenSeguro(p.motivo, { max: 300, politica: pol }) : null, evidencia: (Array.isArray(p.evidencia) ? p.evidencia : []).map(String).filter((x) => /^ev_[a-f0-9]{16,64}$/.test(x)).slice(0, 20),
    resumen: privacy.resumenSeguro(p.resumen || '', { max: LIMITES.resumen, politica: pol }), files,
  }, pol);
  payload.subject_hash = construccion.subject_hash; payload.cycle_id = cycle_id;
  const evidence_id = guardarPayload(root, payload, construccion.task_id, opts);
  const ev = {
    host: HOST, session_id: 'plan:' + construccion.plan_id, host_event_id: clave, event_type: EVENTO_REVISION, role: 'director',
    task_id: construccion.task_id, cycle_id, paths: files, evidence_refs: [...(evidence_id ? [evidence_id] : []), ...payload.evidencia],
    input: { plan: construccion.plan_id, revisor: p.revisor, auditor: payload.auditor_id, scope: payload.scope }, output: { veredicto: payload.veredicto, hallazgos: payload.hallazgos.length },
  };
  const cap = capturarOSpool(root, ev, payload, opts);
  const base = { event_id: cap.event_id || null, job_id: cap.job_id || null, cycle_id, event_key: clave, revisor: p.revisor, veredicto: payload.veredicto };
  if (!cap.ok) return Object.assign({ ok: false }, base, { status: cap.status || 'RECHAZADO', code: cap.code, message: cap.message, spool: cap.spool });
  if (opts.procesar === false || p.procesar === false) return Object.assign({ ok: true, status: 'CAPTURADO', duplicado: cap.status === 'DUPLICATE' }, base);
  procesarPendientes(root, Object.assign({}, opts, { max: opts.max || 25 }));
  const est = estadoDeEvento(root, base.event_id);
  return Object.assign({ ok: !!est && est.estado === 'REGISTRADO', status: est ? est.estado : 'MEMORY_PENDING', duplicado: cap.status === 'DUPLICATE' }, base);
}

// ───────────────────────────── procesamiento ────────────────────────────────

function abrirLectura(root) {
  try { return core.abrir(root); } catch { return null; }
}

function leerCiclo(root, cycle_id) {
  const db = abrirLectura(root);
  if (!db) return null;
  try { return db.get('SELECT ciclo_id, estado, tests_pasando, tests_generados, fecha_inicio, fecha_fin FROM ciclos WHERE ciclo_id = ?', cycle_id) || null; }
  catch { return null; } finally { try { db.close(); } catch { /* ya cerrada */ } }
}

function cargarPayload(root, ev) {
  const refs = (() => { try { return JSON.parse(ev.evidence_refs || '[]'); } catch { return []; } })();
  const store = (() => { try { return require('./evidence-store.cjs'); } catch { return null; } })();
  for (const id of refs) {
    if (!store) break;
    try {
      const v = store.verificar(root, id);
      if (v.status !== 'OK') continue;
      const o = store.obtener(root, id, { length: 1024 * 1024 }, { touch: false });
      // Solo cuenta el original COMPLETO y verificado por hash: una página parcial no es el payload del cierre.
      if (o && o.ok && o.complete && typeof o.content === 'string') { const j = JSON.parse(o.content); if (j && j.schema === 1) return { payload: j, degradado: false }; }
    } catch { /* otra referencia o respaldo */ }
  }
  // Respaldo: lo que el propio evento conserva. Se marca degradado, nunca se presenta como el payload completo.
  const k = leerClave(ev.host_event_id);
  if (!k) return null;
  let paths = []; try { paths = JSON.parse(ev.paths || '[]'); } catch { /* sin rutas */ }
  return { degradado: true, payload: {
    schema: 1, origen: 'teams', tipo: k.tipo || 'construccion', plan_id: k.plan_id, task_id: k.task_id, attempt: Number(k.attempt) || 1, cycle_id: ev.cycle_id, correction_id: k.correction_id,
    area: paths[0] ? String(paths[0]).split('/')[0] : 'global', files: paths, tests: 0, tests_total: 0, tarea: k.task_id, aprendizajes: [], sin_aprendizaje: 'payload completo no disponible: cierre reconstruido del evento', reuse: {}, reuse_rechazado: {}, browser: false,
    revisor: k.revisor, auditor_id: k.auditor_id, veredicto: 'SIN_VEREDICTO', hallazgos: [], evidencia: [],
  } };
}

function resolverPostCycle(root, opts) {
  if (opts && opts.postCycle) return opts.postCycle;
  const local = path.join(root, '.agentic', 'grafo', 'post-cycle.cjs');
  return fs.existsSync(local) ? local : null;
}

/** Ejecuta post-cycle como PROCESO HIJO, una vez por cierre, con el ciclo/archivos/omisiones del cierre. */
function correrPostCycle(root, ev, payload, opts) {
  const script = resolverPostCycle(root, opts);
  if (!script) return { ok: false, code: 'POST_CYCLE_AUSENTE', message: 'no hay .agentic/grafo/post-cycle.cjs en el proyecto' };
  const skip = ['deps'];
  if (!payload.browser) skip.push('browser');
  if (payload.reuse && payload.reuse.tdd) skip.push('contratos');
  if (payload.reuse && payload.reuse.preservacion) skip.push('preservacion');
  const area = payload.area || 'global';
  const args = [script, area, '--silent', '--origen=teams', '--tests=' + (payload.tests || 0), '--tests-total=' + (payload.tests_total || payload.tests || 0),
    '--task=' + String(payload.tarea || payload.task_id).replace(/[\r\n"]/g, ' ').slice(0, 160), '--type=' + (payload.tipo === 'correccion' ? 'fix' : 'feature'), '--modules=' + area, '--skip=' + skip.join(',')];
  const r = spawnSync(process.execPath, args, {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: (opts && opts.hijo_ms) || LIMITES.hijo_ms,
    env: Object.assign({}, process.env, {
      AKDD_CYCLE_ID: ev.cycle_id, AKDD_ACTOR: 'teams-nucleo', AKDD_TEAMS_FILES: JSON.stringify(payload.files || []),
      AKDD_TEAMS_REUSE: JSON.stringify(payload.reuse || {}), AKDD_TEAMS_CIERRE: ev.event_id,
    }),
  });
  if (r.error && r.error.code === 'ETIMEDOUT') return { ok: false, code: 'POST_CYCLE_TIMEOUT', message: 'post-cycle excedió el tiempo' };
  if (r.status === 75) return { ok: false, code: 'UPDATE_IN_PROGRESS', message: 'un akdd update tiene la exclusión de escritura' };
  if (r.status !== 0) return { ok: false, code: 'POST_CYCLE_EXIT_' + r.status, message: String(r.stderr || r.stdout || '').trim().split(/\r?\n/).pop().slice(0, 200) };
  return { ok: true, skip };
}

function marcarEvento(root, event_id, estado) {
  let db = null;
  try {
    db = core.abrir(root, { write: true });
    if (db) db.run("UPDATE mem_events SET status = ? WHERE event_id = ? AND status NOT IN ('SUPPRESSED')", estado, event_id);
  } catch { /* la marca es informativa: el estado real lo dan la observación y el job */ } finally { try { if (db) db.close(); } catch { /* ya cerrada */ } }
}

/** Observación de cierre: es el ÚLTIMO paso y la marca de «registrado» (idempotente por event_id). */
function observarCierre(root, ev, resumen, kind, opts) {
  return core.observar(root, { event_ids: [ev.event_id], kind, summary: resumen, task_id: ev.task_id, dedupe_key: kind + SEP + ev.event_id, processor: 'teams-nucleo' }, opts);
}

/** Arista «el ciclo de la corrección corrige el ciclo de la entrega»: idempotente, y solo si ambos ciclos existen. */
function enlazarCorreccion(root, desde, hacia, correction_id) {
  let db = null;
  try {
    if (!leerCiclo(root, hacia)) return { ok: true, enlazado: false }; // el ciclo corregido aún no está registrado: no se inventa el enlace
    db = core.abrir(root, { write: true });
    if (!db) return { ok: false, code: 'NO_DB' };
    if (core.tablasFaltantes(db, ['relaciones_semanticas']).length) return { ok: true, enlazado: false };
    const ya = db.get("SELECT 1 AS x FROM relaciones_semanticas WHERE tipo = 'corrige' AND desde_entidad = ? AND hacia_entidad = ?", 'ciclo:' + desde, 'ciclo:' + hacia);
    if (!ya) db.run("INSERT INTO relaciones_semanticas (desde_entidad, hacia_entidad, tipo, descripcion) VALUES (?, ?, 'corrige', ?)", 'ciclo:' + desde, 'ciclo:' + hacia, 'hallazgo ' + String(correction_id || '?').slice(0, 80));
    return { ok: true, enlazado: true };
  } catch (e) { return { ok: false, code: e.code || 'ENLACE_NO_REGISTRADO', message: e.message }; } finally { try { if (db) db.close(); } catch { /* ya cerrada */ } }
}

function ejecutarCierre(root, ev, opts) {
  const c = cargarPayload(root, ev);
  if (!c) return { ok: false, code: 'PAYLOAD_NO_DISPONIBLE' };
  const payload = c.payload;
  const ref = { cycle_id: ev.cycle_id, tipo: payload.tipo, degradado: c.degradado || undefined, reutiliza: Object.keys(payload.reuse || {}) };

  // 1. Ciclo + episodio + contratos + AST + layout + preservación + memoria: post-cycle, UNA vez por cierre.
  const existente = leerCiclo(root, ev.cycle_id);
  if (existente && existente.estado !== 'EN_CURSO') ref.ciclo = 'YA_REGISTRADO';
  else {
    const exec = typeof opts.ejecutor === 'function' ? opts.ejecutor(root, ev, payload) : correrPostCycle(root, ev, payload, opts);
    if (!exec.ok) return exec;
    ref.ciclo = 'REGISTRADO';
  }
  const ciclo = leerCiclo(root, ev.cycle_id);
  if (!ciclo) return { ok: false, code: 'CICLO_NO_REGISTRADO', message: 'post-cycle terminó pero el ciclo ' + ev.cycle_id + ' no está en la base' };
  if (ciclo.estado === 'EN_CURSO') return { ok: false, code: 'CICLO_NO_CERRADO', message: 'el ciclo quedó EN_CURSO: se reintenta' };
  ref.estado_ciclo = ciclo.estado;
  if (payload.corrige_ciclo) { const enl = enlazarCorreccion(root, ev.cycle_id, payload.corrige_ciclo, payload.correction_id); if (!enl.ok) return enl; ref.corrige = payload.corrige_ciclo; }

  // 2. Conocimiento: lo declarado, con su causa y procedencia; o «sin aprendizaje nuevo» (resultado legítimo).
  const nodos = [];
  for (const a of payload.aprendizajes || []) {
    const contenido = a.causa ? a.contenido + '\n\nCausa: ' + a.causa : a.contenido;
    const k = core.proponerConocimiento(root, { tipo: a.tipo || 'patron', area: a.area || payload.area || 'global', scope: 'teams:' + payload.plan_id, titulo: a.titulo, contenido, archivos: a.archivos || payload.files, event_ids: [ev.event_id], confianza: 'BAJA' }, opts);
    if (!k.ok) return { ok: false, code: k.code || 'CONOCIMIENTO_NO_REGISTRADO', message: k.message };
    nodos.push(k.node_id);
  }
  ref.aprendizaje = nodos.length ? { nodos: nodos.length } : { ninguno: true, motivo: String(payload.sin_aprendizaje || 'no declarado').slice(0, 120) };
  if ((payload.files || []).length) core.invalidarPorArchivos(root, payload.files, opts);

  // 3. La marca de «registrado»: solo existe si los pasos anteriores terminaron.
  const o = observarCierre(root, ev, 'Cierre TEAMS ' + payload.tipo + ' de ' + payload.task_id + ' (intento ' + payload.attempt + '): ciclo ' + ev.cycle_id + ' ' + ciclo.estado + '; ' + (nodos.length ? nodos.length + ' conocimiento(s)' : 'sin aprendizaje nuevo'), 'teams_cierre', opts);
  if (!o.ok) return { ok: false, code: o.code || 'OBSERVACION_NO_REGISTRADA', message: o.message };
  return { ok: true, ref };
}

function ejecutarRevision(root, ev, opts) {
  const c = cargarPayload(root, ev);
  if (!c) return { ok: false, code: 'PAYLOAD_NO_DISPONIBLE' };
  const p = c.payload;
  const ciclo = leerCiclo(root, ev.cycle_id);
  const ref = { cycle_id: ev.cycle_id, revisor: p.revisor, veredicto: p.veredicto, ciclo_enlazado: !!ciclo };
  // El veredicto viaja a la libreta de gates SIN inventar PASS: solo PASS/FAIL/FINDINGS emitidos por el revisor.
  if (['PASS', 'FAIL', 'FINDINGS'].includes(p.veredicto)) {
    let db = null;
    try {
      db = core.abrir(root, { write: true });
      require('./gate-telemetry.cjs').recordGateEvent(db, {
        gate: 'teams-review-' + p.revisor, verdict: p.veredicto === 'PASS' ? 'PASS' : 'FAIL', file: (p.files || [])[0] || null, cycle_id: ev.cycle_id, event_id: 'teams-review:' + ev.event_id,
        detalle: { revisor: p.revisor, auditor_id: p.auditor_id, scope: p.scope, subject_hash: p.subject_hash, revision: p.revision, hallazgos: p.hallazgos, evidencia: p.evidencia, origen: 'teams' }, source: 'mechanical',
      });
    } catch (e) { return { ok: false, code: e.code || 'GATE_EVENT_NO_REGISTRADO', message: e.message }; } finally { try { if (db) db.close(); } catch { /* ya cerrada */ } }
  }
  const o = observarCierre(root, ev, 'Revisión ' + p.revisor + ' de ' + p.task_id + ': ' + p.veredicto + (p.motivo ? ' (' + p.motivo + ')' : '') + (p.hallazgos && p.hallazgos.length ? ' · ' + p.hallazgos.length + ' hallazgo(s)' : '') + (ciclo ? ' · ciclo ' + ev.cycle_id : ' · ciclo de construcción aún no registrado'), 'teams_revision', opts);
  if (!o.ok) return { ok: false, code: o.code || 'OBSERVACION_NO_REGISTRADA', message: o.message };
  return { ok: true, ref };
}

/** Reproduce el spool local (cierres que no pudieron entrar a la base) y procesa los jobs de cierre pendientes. */
function procesarPendientes(root, opts = {}) {
  const salida = { ok: true, reproducidos: 0, procesados: 0, registrados: 0, reintentos: 0, dead_letter: 0, lease_lost: 0, errores: [] };
  for (const f of listarSpool(root)) {
    let reg = null; try { reg = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    if (!reg || !reg.ev) { try { fs.unlinkSync(f); } catch { /* ilegible */ } continue; }
    const evidence_id = guardarPayload(root, reg.payload, reg.ev.task_id, opts);
    if (evidence_id && !(reg.ev.evidence_refs || []).includes(evidence_id)) reg.ev.evidence_refs = [evidence_id, ...(reg.ev.evidence_refs || [])];
    const cap = core.capturar(root, reg.ev, { required: true, job_kind: KIND_JOB, now: opts.now });
    if (cap.ok) { salida.reproducidos++; try { fs.unlinkSync(f); } catch { /* ya no está */ } }
    else if (!CODIGOS_DEGRADADOS.has(cap.code) && cap.status !== 'BACKPRESSURE') { salida.errores.push({ spool: path.basename(f), code: cap.code }); } // rechazo real: queda visible, no se pierde
  }
  const owner = opts.owner || 'teams-nucleo:' + process.pid;
  const max = Math.min(Number(opts.max) || 25, 200);
  for (let i = 0; i < max; i++) {
    const c = q.reclamar(root, { owner, lease_ms: opts.lease_ms || LIMITES.lease_ms, now: opts.now, kinds: [KIND_JOB] });
    if (!c.ok) { salida.ok = false; salida.code = c.code; salida.hint = c.hint; break; }
    if (!c.job) break;
    const ev = (c.events || []).find((e) => e.host === HOST);
    salida.procesados++;
    let r;
    try {
      if (!ev) r = { ok: false, code: 'EVENTO_NO_TEAMS' };
      else if (ev.event_type === EVENTO_REVISION) r = ejecutarRevision(root, ev, opts);
      else if (ev.event_type === EVENTO_CIERRE) r = ejecutarCierre(root, ev, opts);
      else r = { ok: false, code: 'TIPO_NO_SOPORTADO' };
    } catch (e) { r = { ok: false, code: e.code || 'PROCESS_FAILED', message: e.message }; }
    if (r.ok) {
      const done = q.completar(root, c.job.job_id, c.job.lease_token, owner, { result_ref: JSON.stringify(r.ref).slice(0, 480), now: opts.now });
      if (done.ok) { salida.registrados++; marcarEvento(root, ev.event_id, 'PROCESSED'); } else salida.lease_lost++;
    } else {
      const f = q.fallar(root, c.job.job_id, c.job.lease_token, owner, { error_code: r.code || 'PROCESS_FAILED', now: opts.now, backoff_opts: opts.backoff });
      if (f.ok && f.status === 'DEAD_LETTER') salida.dead_letter++; else if (f.ok) salida.reintentos++; else salida.lease_lost++;
      salida.errores.push({ job_id: c.job.job_id, code: r.code, message: r.message });
    }
  }
  return salida;
}

// ───────────────────────────── estado y cobertura ───────────────────────────

/** Estado de UN evento: REGISTRADO (hay observación de cierre) | MEMORY_PENDING | DEAD_LETTER | EN_SPOOL. */
function estadoDeEvento(root, event_id) {
  const db = abrirLectura(root);
  if (!db || !event_id) return null;
  try {
    const e = db.get('SELECT event_id, event_type, host_event_id FROM mem_events WHERE event_id = ?', event_id);
    if (!e) return null;
    const kind = e.event_type === EVENTO_REVISION ? 'teams_revision' : 'teams_cierre';
    const obs = db.get("SELECT 1 AS x FROM mem_observations WHERE dedupe_key = ? AND status = 'PROCESSED'", kind + SEP + event_id);
    const job = db.get('SELECT j.state, j.error_code, j.attempts, j.max_attempts, j.next_attempt_at FROM mem_job_events je JOIN mem_jobs j ON j.job_id = je.job_id WHERE je.event_id = ?', event_id);
    if (obs) return { estado: 'REGISTRADO', event_id };
    if (job && job.state === 'DEAD_LETTER') return { estado: 'DEAD_LETTER', event_id, error_code: job.error_code, attempts: Number(job.attempts) };
    return { estado: 'MEMORY_PENDING', event_id, job_state: job ? job.state : null, error_code: job ? job.error_code : null, attempts: job ? Number(job.attempts) : 0, next_attempt_at: job ? job.next_attempt_at : null };
  } finally { try { db.close(); } catch { /* ya cerrada */ } }
}

const SQL_EVENTOS_COLUMNAS = 'e.event_id, e.event_type, e.host_event_id, e.task_id, e.cycle_id, e.occurred_at, j.job_id, j.state AS job_state, j.attempts, j.max_attempts, j.error_code, j.next_attempt_at, j.manual_retries';
const SQL_EVENTOS_UNION = 'FROM mem_events e LEFT JOIN mem_job_events je ON je.event_id = e.event_id LEFT JOIN mem_jobs j ON j.job_id = je.job_id';
const SQL_EVENTOS = 'SELECT ' + SQL_EVENTOS_COLUMNAS + ' ' + SQL_EVENTOS_UNION + ' WHERE e.host = ? AND e.event_type IN (?, ?) ORDER BY e.occurred_at, e.event_id';
const SQL_EVENTOS_PLAN = 'SELECT ' + SQL_EVENTOS_COLUMNAS + ' ' + SQL_EVENTOS_UNION + ' WHERE e.host = ? AND e.event_type IN (?, ?) AND e.session_id = ? ORDER BY e.occurred_at, e.event_id';

/** Pendientes, hechos y dead-letter de los cierres TEAMS (opcionalmente de un plan). Sin datos: available:false, nunca 0. */
function estadoMemoria(root, { plan_id } = {}) {
  const db = abrirLectura(root);
  const spool = listarSpool(root).length;
  if (!db) return { available: false, code: 'NO_DB', en_spool: spool || null };
  try {
    const faltan = core.tablasFaltantes(db, ['mem_events', 'mem_jobs', 'mem_job_events', 'mem_observations']);
    if (faltan.length) return { available: false, code: 'SCHEMA_MISSING', missing: faltan, hint: 'Ejecuta: akdd update', en_spool: spool || null };
    const filas = plan_id ? db.all(SQL_EVENTOS_PLAN, HOST, EVENTO_CIERRE, EVENTO_REVISION, 'plan:' + plan_id) : db.all(SQL_EVENTOS, HOST, EVENTO_CIERRE, EVENTO_REVISION);
    const hechas = new Set(db.all("SELECT dedupe_key FROM mem_observations WHERE kind IN ('teams_cierre','teams_revision') AND status = 'PROCESSED'").map((r) => r.dedupe_key));
    const items = filas.map((f) => {
      const kind = f.event_type === EVENTO_REVISION ? 'teams_revision' : 'teams_cierre';
      const registrado = hechas.has(kind + SEP + f.event_id);
      const estado = registrado ? 'REGISTRADO' : (f.job_state === 'DEAD_LETTER' ? 'DEAD_LETTER' : 'MEMORY_PENDING');
      const k = leerClave(f.host_event_id) || {};
      return { event_id: f.event_id, job_id: f.job_id, tipo: f.event_type === EVENTO_REVISION ? 'revision' : (k.tipo || 'construccion'), plan_id: k.plan_id || null, task_id: f.task_id, cycle_id: f.cycle_id, estado, job_state: f.job_state || null, error_code: registrado ? null : f.error_code, attempts: f.attempts == null ? null : Number(f.attempts), max_attempts: f.max_attempts == null ? null : Number(f.max_attempts), next_attempt_at: registrado ? null : f.next_attempt_at, manual_retries: f.manual_retries == null ? null : Number(f.manual_retries), occurred_at: f.occurred_at };
    });
    const cuenta = (e) => items.filter((i) => i.estado === e).length;
    const out = {
      available: true, plan_id: plan_id || null, total: items.length, registrados: cuenta('REGISTRADO'), pendientes: cuenta('MEMORY_PENDING'), dead_letter: cuenta('DEAD_LETTER'),
      en_spool: spool, required_pending: items.filter((i) => i.estado !== 'REGISTRADO').length + spool, items,
    };
    out.listo_para_cierre = out.pendientes === 0 && out.dead_letter === 0 && spool === 0;
    out.motivos_bloqueo = [].concat(out.pendientes ? ['MEMORY_PENDING:' + out.pendientes] : [], out.dead_letter ? ['DEAD_LETTER:' + out.dead_letter] : [], spool ? ['EN_SPOOL:' + spool] : []);
    return out;
  } finally { try { db.close(); } catch { /* ya cerrada */ } }
}

const pj = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };

/** Rol de revisor en el vocabulario de este módulo (los demás módulos de TEAMS usan alias). */
function normalizarRevisor(r) {
  const x = String(r || '').toLowerCase();
  if (/^(front|frontend|ui|ux|frontend-ui-ux)$/.test(x)) return 'frontend';
  if (/^(back|backend|api)$/.test(x)) return 'backend';
  if (/^(negocio|business|general|auditor|negocio-auditor)$/.test(x)) return 'negocio';
  return x;
}

/* Consultas FIJAS: los nombres de tabla y de columna no se componen con datos. */
const SQL_HALLAZGOS_PLAN = 'SELECT id, task_id, state FROM teams_findings WHERE plan_id = ?';
const SQL_REVISIONES_PLAN = 'SELECT role, task_id, subject_hash, verdict FROM teams_reviews WHERE task_id IN (SELECT id FROM teams_tasks WHERE plan_id = ?)';

/**
 * Fuentes de actividades esperadas que NO son de este módulo: las correcciones (teams_findings) y las revisiones
 * (teams_reviews) del núcleo TEAMS. Se leen de forma tolerante: si la tabla no existe o no se puede leer, esa
 * categoría es DESCONOCIDA (no cero).
 */
function leerFuentesExtra(db, planId) {
  const out = { correccion: { desconocido: true, esperadas: [] }, revision: { desconocido: true, esperadas: [] } };
  try {
    if (!core.tablasFaltantes(db, ['teams_findings']).length) {
      // Una corrección que cambió código (IMPLEMENTED_PENDING_REVIEW / VERIFIED_RESOLVED) debe tener su ciclo propio.
      const filas = db.all(SQL_HALLAZGOS_PLAN, planId).filter((f) => ['IMPLEMENTED_PENDING_REVIEW', 'VERIFIED_RESOLVED'].includes(String(f.state).toUpperCase()));
      out.correccion = { desconocido: false, fuente: 'teams_findings', esperadas: filas.map((f) => ({ correction_id: String(f.id), task_id: f.task_id || null })) };
    }
  } catch { /* sin lectura: queda DESCONOCIDA */ }
  try {
    if (!core.tablasFaltantes(db, ['teams_reviews']).length) {
      const vistos = new Set(); const esperadas = [];
      for (const f of db.all(SQL_REVISIONES_PLAN, planId)) {
        if (!f.verdict || !f.task_id) continue;
        const e = { task_id: f.task_id, revisor: normalizarRevisor(f.role), hash16: hash16(f.subject_hash) };
        const k = [e.task_id, e.revisor, e.hash16].join(SEP);
        if (!vistos.has(k)) { vistos.add(k); esperadas.push(e); }
      }
      out.revision = { desconocido: false, fuente: 'teams_reviews', esperadas };
    }
  } catch { /* sin lectura: queda DESCONOCIDA */ }
  return out;
}

/**
 * Cobertura de registro = actividades esperadas CON registro obligatorio hechas ÷ esperadas, derivada del plan y
 * su ledger (tareas × intentos entregados, correcciones, revisiones), NO de la cantidad de nodos. Un dato que no
 * se puede leer es «desconocido/degradado», jamás 0.
 */
function cobertura(root, { plan_id, esperadas_extra } = {}) {
  const db = abrirLectura(root);
  if (!db) return { available: false, estado: 'DESCONOCIDO', code: 'NO_DB' };
  try {
    const faltan = core.tablasFaltantes(db, ['teams_plans', 'teams_tasks', 'teams_attempts']);
    if (faltan.length) return { available: false, estado: 'DESCONOCIDO', code: 'SIN_TEAMS', missing: faltan };
    const plan = plan_id ? db.get('SELECT id FROM teams_plans WHERE id = ?', plan_id) : db.get('SELECT id FROM teams_plans ORDER BY created_at DESC, id DESC LIMIT 1');
    if (!plan) return { available: false, estado: 'DESCONOCIDO', code: 'PLAN_DESCONOCIDO' };
    const pid = plan.id;
    const mem = core.tablasFaltantes(db, ['mem_events', 'mem_jobs', 'mem_job_events', 'mem_observations']);
    const registro = mem.length ? null : estadoMemoria(root, { plan_id: pid });
    const porEvento = new Map(); // task|hash16 → estado (construcción)
    const porCorreccion = new Map(); const porRevision = new Map();
    if (registro && registro.available) {
      for (const it of registro.items) {
        const k = db.get('SELECT host_event_id FROM mem_events WHERE event_id = ?', it.event_id);
        const c = leerClave(k && k.host_event_id); if (!c) continue;
        if (c.evento === EVENTO_CIERRE && c.tipo === 'construccion') porEvento.set(c.task_id + SEP + c.hash16, it.estado);
        else if (c.evento === EVENTO_CIERRE) porCorreccion.set(String(c.correction_id), it.estado);
        else porRevision.set([c.task_id, c.revisor, c.hash16].join(SEP), it.estado);
      }
    }
    const detalle = [];
    const marcar = (categoria, esperada, estado, extra) => detalle.push(Object.assign({ categoria, estado: estado || (registro && registro.available ? 'NO_ENCOLADA' : 'DESCONOCIDO') }, esperada, extra || {}));
    // Construcción: cada intento ENTREGADO (con sujeto) del plan es una actividad con registro obligatorio.
    const intentos = db.all("SELECT a.task_id, a.subject_hash, a.state, a.fencing FROM teams_attempts a JOIN teams_tasks t ON t.id = a.task_id WHERE t.plan_id = ? AND a.subject_hash IS NOT NULL AND a.state IN ('DELIVERED','VERIFIED') ORDER BY a.id", pid);
    const vistos = new Set();
    for (const a of intentos) {
      const k = a.task_id + SEP + hash16(a.subject_hash);
      if (vistos.has(k)) continue; vistos.add(k);
      marcar('construccion', { task_id: a.task_id, subject_hash: hash16(a.subject_hash) }, porEvento.get(k));
    }
    const extra = leerFuentesExtra(db, pid);
    const extras = esperadas_extra || {};
    for (const e of (extras.correccion || (extra.correccion.desconocido ? [] : extra.correccion.esperadas))) marcar('correccion', { correction_id: e.correction_id, task_id: e.task_id || null }, porCorreccion.get(String(e.correction_id)));
    for (const e of (extras.revision || (extra.revision.desconocido ? [] : extra.revision.esperadas))) marcar('revision', { task_id: e.task_id, revisor: e.revisor }, porRevision.get([e.task_id, e.revisor, e.hash16 || '-'].join(SEP)));
    const cat = (n) => {
      const d = detalle.filter((x) => x.categoria === n);
      const desconocido = (n === 'construccion' ? !(registro && registro.available) : (extra[n].desconocido && !extras[n]));
      return { esperadas: desconocido ? null : d.length, registradas: desconocido ? null : d.filter((x) => x.estado === 'REGISTRADO').length, pendientes: desconocido ? null : d.filter((x) => ['MEMORY_PENDING', 'NO_ENCOLADA', 'DEAD_LETTER'].includes(x.estado)).length, dead_letter: desconocido ? null : d.filter((x) => x.estado === 'DEAD_LETTER').length, desconocido, fuente: n === 'construccion' ? 'teams_attempts' : (extras[n] ? 'parametro' : extra[n].fuente || null) };
    };
    const por_categoria = { construccion: cat('construccion'), correccion: cat('correccion'), revision: cat('revision') };
    const conocidas = Object.values(por_categoria).filter((c) => !c.desconocido);
    const esperadas = conocidas.reduce((a, c) => a + c.esperadas, 0);
    const registradas = conocidas.reduce((a, c) => a + c.registradas, 0);
    const degradado = Object.values(por_categoria).some((c) => c.desconocido);
    let estado;
    if (!conocidas.length) estado = 'DESCONOCIDO';
    else if (!esperadas) estado = degradado ? 'DEGRADADO' : 'SIN_ACTIVIDAD_ESPERADA';
    else estado = registradas === esperadas ? (degradado ? 'COMPLETA_PARCIAL_DEGRADADA' : 'COMPLETA') : (degradado ? 'PARCIAL_DEGRADADA' : 'PARCIAL');
    return {
      available: true, plan_id: pid, origen: 'teams', formula: 'registradas / esperadas con registro obligatorio (ledger del plan, no cantidad de nodos)',
      esperadas: conocidas.length ? esperadas : null, registradas: conocidas.length ? registradas : null,
      cobertura_pct: esperadas ? Math.round((registradas * 1000) / esperadas) / 10 : null, estado, degradado, por_categoria,
      memoria: registro && registro.available ? { pendientes: registro.pendientes, dead_letter: registro.dead_letter, en_spool: registro.en_spool, listo_para_cierre: registro.listo_para_cierre } : null,
      detalle: detalle.slice(0, 200),
      aviso: degradado ? 'categorías sin fuente legible quedan DESCONOCIDAS y fuera del denominador: no se cuentan como 0 ni como completas' : null,
    };
  } finally { try { db.close(); } catch { /* ya cerrada */ } }
}

/** Mismo backend de ciclos para `aa` y `teams`: el origen se distingue por el prefijo determinista del id. */
function ciclosPorOrigen(root, { origen = 'teams', limite = 100 } = {}) {
  const db = abrirLectura(root);
  if (!db) return { available: false, code: 'NO_DB' };
  try {
    if (core.tablasFaltantes(db, ['ciclos']).length) return { available: false, code: 'SIN_TABLA_CICLOS' };
    const v = origen === 'teams' ? 'teams' : (origen === 'aa' ? 'aa' : 'todos');
    const COLS = 'ciclo_id, tarea, tipo_tarea, modulo, area, estado, tests_generados, tests_pasando, stops_count, fecha_inicio, fecha_fin';
    const SQL = {
      teams: { filas: 'SELECT ' + COLS + " FROM ciclos WHERE ciclo_id LIKE 'teams\\_%' ESCAPE '\\' ORDER BY id DESC LIMIT ?", total: "SELECT count(*) AS n FROM ciclos WHERE ciclo_id LIKE 'teams\\_%' ESCAPE '\\'", estados: "SELECT estado, count(*) AS n FROM ciclos WHERE ciclo_id LIKE 'teams\\_%' ESCAPE '\\' GROUP BY estado" },
      aa: { filas: 'SELECT ' + COLS + " FROM ciclos WHERE ciclo_id NOT LIKE 'teams\\_%' ESCAPE '\\' ORDER BY id DESC LIMIT ?", total: "SELECT count(*) AS n FROM ciclos WHERE ciclo_id NOT LIKE 'teams\\_%' ESCAPE '\\'", estados: "SELECT estado, count(*) AS n FROM ciclos WHERE ciclo_id NOT LIKE 'teams\\_%' ESCAPE '\\' GROUP BY estado" },
      todos: { filas: 'SELECT ' + COLS + ' FROM ciclos ORDER BY id DESC LIMIT ?', total: 'SELECT count(*) AS n FROM ciclos', estados: 'SELECT estado, count(*) AS n FROM ciclos GROUP BY estado' },
    }[v];
    const filas = db.all(SQL.filas, Math.min(Number(limite) || 100, 500));
    const total = Number(db.get(SQL.total).n);
    const por_estado = {};
    for (const r of db.all(SQL.estados)) por_estado[r.estado] = Number(r.n);
    return { available: true, origen, total, por_estado, ciclos: filas.map((c) => Object.assign({ origen: esCicloTeams(c.ciclo_id) ? 'teams' : 'aa' }, c)) };
  } finally { try { db.close(); } catch { /* ya cerrada */ } }
}

// ───────────────────────────── CLI ──────────────────────────────────────────

function cli(argv) {
  const opt = Object.fromEntries(argv.filter((a) => a.startsWith('--')).map((a) => { const [k, ...v] = a.slice(2).split('='); return [k.replace(/-/g, '_'), v.length ? v.join('=') : true]; }));
  const cmd = argv.find((a) => !a.startsWith('--')) || 'estado';
  const root = process.cwd();
  const leerArchivo = () => JSON.parse(fs.readFileSync(path.resolve(root, String(opt.archivo)), 'utf8'));
  let r;
  try {
    if (cmd === 'cierre') r = registrarCierre(root, leerArchivo(), { procesar: !opt.diferido });
    else if (cmd === 'revision') r = registrarRevision(root, leerArchivo(), { procesar: !opt.diferido });
    else if (cmd === 'procesar') r = procesarPendientes(root, { max: opt.max ? Number(opt.max) : undefined });
    else if (cmd === 'estado') r = estadoMemoria(root, { plan_id: opt.plan || undefined });
    else if (cmd === 'cobertura') r = cobertura(root, { plan_id: opt.plan || undefined });
    else if (cmd === 'ciclos') r = ciclosPorOrigen(root, { origen: opt.origen || 'teams', limite: opt.limite });
    else if (cmd === 'pasos') r = require('./post-cycle.cjs').PASOS;
    else r = { status: 'COMANDO_DESCONOCIDO', uso: 'node teams-nucleo.cjs <cierre --archivo=f.json [--diferido] | revision --archivo=f.json | procesar [--max=N] | estado [--plan=ID] | cobertura [--plan=ID] | ciclos [--origen=teams|aa] | pasos>' };
  } catch (e) { r = { status: 'ERROR', code: e.code || null, detalle: e.message }; }
  console.log(JSON.stringify(r, null, 2));
  if (r && (r.status === 'ERROR' || r.status === 'RECHAZADO' || r.status === 'DEAD_LETTER' || r.ok === false)) process.exitCode = 1;
}

if (require.main === module) cli(process.argv.slice(2));

module.exports = {
  HOST, KIND_JOB, EVENTO_CIERRE, EVENTO_REVISION, PREFIJO_CICLO, REVISORES, VEREDICTOS, LIMITES,
  idCiclo, esCicloTeams, claveCierre, claveRevision, leerClave,
  registrarCierre, registrarRevision, procesarPendientes, estadoDeEvento, estadoMemoria, cobertura, ciclosPorOrigen,
};
