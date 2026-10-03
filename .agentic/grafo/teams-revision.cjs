'use strict';

/**
 * Los tres revisores del director (spec §7): frontend/UI-UX, backend y negocio (auditor general de la lógica de negocio).
 *
 *   · Un revisor es de SOLO LECTURA: informa al director. No asigna trabajo a Cursor por otro canal ni escribe el MD: sus hallazgos
 *     entran como OPEN (sin triar) y solo el director los publica, los descarta con motivo o los agrupa.
 *   · Identidad honesta: un SUBAGENTE del host tiene su propio agent_id; tres agentes con el mismo id no son tres agentes. Si el host
 *     solo permite revisar en secuencia, se declara modalidad SECUENCIAL y la cobertura (qué se mira y qué no): queda DEGRADADO,
 *     no se disfraza de equipo.
 *   · Cada veredicto (PASS / FAIL / NOT_APPLICABLE) va ligado al HASH del sujeto revisado. Un veredicto de un hash viejo no cuenta.
 *   · El cierre exige los tres roles sobre el sujeto FINAL (no un hash viejo); para una corrección pequeña basta la revisión dirigida
 *     del revisor de origen.
 *   · Negocio no decide lo ambiguo por conveniencia: lo ambiguo va como pregunta al director (bloquear), con alternativas.
 */

const tm = require('./teams-manager.cjs');
const U = require('./teams-util.cjs');
const corr = require('./teams-correcciones.cjs');

const I = tm._i;
const ROLES = ['frontend', 'backend', 'negocio'];
const MODALIDADES = ['SUBAGENTE', 'SECUENCIAL'];
const VEREDICTOS = ['PASS', 'FAIL', 'NOT_APPLICABLE'];
const ALCANCES = ['TASK', 'FINAL', 'FINDING'];

const RE_UI = /\.(html?|css|scss|sass|less|jsx|tsx|vue|svelte|astro)$|(^|\/)(components?|pages|views|layouts?|public|static|styles?|ui|frontend|client|templates?)\//i;
const RE_BACK = /\.(c?js|mjs|ts|py|go|rb|php|java|kt|cs|rs|sql|prisma|graphql)$|(^|\/)(api|routes?|server|backend|services?|db|migrations?|models?|controllers?)\//i;

/** ¿Este rol tiene algo que mirar en estos archivos? Negocio siempre aplica (criterios, orden, invariantes, coherencia front/back). */
function aplica(rol, archivos) {
  const fs = (archivos || []).map(U.normRel);
  if (rol === 'negocio') return true;
  if (rol === 'frontend') return fs.some((f) => RE_UI.test(f));
  if (rol === 'backend') return fs.some((f) => RE_BACK.test(f) && !/\.(html?|jsx|tsx|vue|svelte|css)$/i.test(f));
  return false;
}

/** ¿Esta sesión es la del constructor conectado? Un revisor o el director no actúan con ella. */
function sesionDelConstructor(root, sesion) {
  if (!sesion) return false;
  return I.lectura2(root, (db) => { const b = db && db.get('SELECT session_id FROM teams_builder WHERE id = 1'); return !!b && b.session_id === sesion; });
}

const noAutorizado = (accion, actor) => ({ status: 'NO_AUTORIZADO', accion, actor, detalle: 'solo el director registra revisores y consume sus informes; un revisor informa' });

/** El director registra a cada revisor con su identidad real o declara que la revisión es secuencial. */
function registrar(root, { role, agent_id = null, session_id = null, modality, scope = [], coverage = null, actor = 'director', sesion_llamante = null }) {
  if (String(actor).split(':')[0] !== 'director') return noAutorizado('registrar', actor);
  if (sesionDelConstructor(root, sesion_llamante)) return noAutorizado('registrar', 'builder (sesión)');
  if (!ROLES.includes(role)) return { status: 'ROL_INVALIDO', validos: ROLES };
  if (!MODALIDADES.includes(modality)) return { status: 'MODALIDAD_INVALIDA', validas: MODALIDADES };
  const cobertura = U.limpiar(root, coverage || '', 400);
  if (modality === 'SECUENCIAL' && !cobertura) return { status: 'FALTA_COBERTURA', detalle: 'una revisión secuencial declara qué cubre y qué no (--cobertura)' };
  if (modality === 'SUBAGENTE' && !agent_id) return { status: 'FALTA_AGENT_ID', detalle: 'un subagente del host tiene su propio agent_id' };
  return I.tx2(root, (db, despertar) => {
    if (modality === 'SUBAGENTE') {
      const choque = db.get("SELECT role FROM teams_reviewers WHERE agent_id = ? AND modality = 'SUBAGENTE' AND role != ?", agent_id, role);
      if (choque) return { status: 'IDENTIDAD_COMPARTIDA', con: choque.role, detalle: 'tres funciones no son tres agentes: cada subagente necesita su propio agent_id, o declara la revisión SECUENCIAL' };
    }
    const sc = U.lista(scope).map((x) => U.limpiar(root, x, 120));
    db.run(`INSERT INTO teams_reviewers (role, agent_id, session_id, modality, scope, coverage, registered_at, updated_at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(role) DO UPDATE SET agent_id = excluded.agent_id, session_id = excluded.session_id, modality = excluded.modality,
      scope = excluded.scope, coverage = excluded.coverage, updated_at = excluded.updated_at`, role, agent_id, session_id, modality, I.js(sc), cobertura || null, I.ahoraIso(), I.ahoraIso());
    I.publicar(db, despertar, { kind: 'REVIEWER_REGISTERED', producer: 'director', target: 'director', payload: { role, modality } });
    return { status: 'REGISTRADO', role, modality, degradado: modality === 'SECUENCIAL' };
  });
}

function revisores(db) {
  const out = {};
  for (const r of ROLES) out[r] = null;
  if (!I.tieneEsquemaV2(db)) return out;
  for (const f of db.all('SELECT * FROM teams_reviewers')) {
    out[f.role] = { role: f.role, agent_id: f.agent_id, session_id: f.session_id, modality: f.modality, scope: I.pj(f.scope, []), coverage: f.coverage, degradado: f.modality === 'SECUENCIAL', registered_at: f.registered_at };
  }
  return out;
}

/** Hash que un revisor revisa de UNA tarea: lo vigente (el de la última corrección entregada) o, si no hubo, el de la entrega. */
function sujetoDeTarea(db, t) {
  const f = I.flujoDe(db, t.id);
  return (f && f.current_hash) || t.subject_hash || null;
}

/**
 * Sujeto FINAL de una campaña: los archivos de TODAS las tareas no canceladas (más los de los hallazgos aún vivos) tal como están en
 * disco ahora. Cualquier cambio de código posterior a un veredicto cambia este hash y lo vuelve obsoleto. `incompleto` si queda trabajo.
 */
function sujetoFinal(root, db, planId) {
  const ts = I.tareas(db, planId).filter((t) => t.state !== 'CANCELLED');
  const archivos = new Set(ts.flatMap((t) => t.allowed_files.map(U.normRel)));
  for (const f of db.all("SELECT scope FROM teams_findings WHERE state != 'DISMISSED_WITH_REASON'")) for (const a of I.pj(f.scope, [])) archivos.add(U.normRel(a));
  const hash = U.sha([...ts.map((t) => t.id).sort(), U.hashArchivos(root, [...archivos])].join('|'));
  return { hash, archivos: [...archivos].sort(), tareas: ts.map((t) => t.id), incompleto: ts.some((t) => t.state !== 'DONE_VERIFIED') };
}

function planActivo(db, planId) {
  return planId || (db.get("SELECT id FROM teams_plans ORDER BY created_at DESC LIMIT 1") || {}).id || null;
}

/** Último veredicto del rol sobre ese alcance Y ese hash. Si hay un veredicto del rol con otro hash, devuelve `obsoleto`, no el veredicto. */
function veredictoVigente(db, { role, scope_kind, task_id = null, finding_id = null, subject_hash }) {
  const filas = db.all('SELECT * FROM teams_reviews WHERE role = ? AND scope_kind = ? AND COALESCE(task_id,\'\') = ? AND COALESCE(finding_id,\'\') = ? ORDER BY id DESC', role, scope_kind, task_id || '', finding_id || '');
  if (!filas.length) return { estado: 'SIN_VEREDICTO' };
  const vigente = filas.find((r) => r.subject_hash === subject_hash);
  if (vigente) return { estado: 'VIGENTE', verdict: vigente.verdict, justification: vigente.justification, review_id: vigente.id, at: vigente.created_at };
  return { estado: 'OBSOLETO', ultimo_hash: filas[0].subject_hash, verdict: filas[0].verdict };
}

/** Un hallazgo corto desde la línea de comandos: "SEV|archivo:linea|criterio|solución|aceptación[|impacto]". */
function parseHallazgoCorto(txt) {
  const [sev, ubic, criterio, solucion, aceptacion, impacto] = String(txt).split('|').map((x) => x.trim());
  return { severity: sev, location: ubic, criterion: criterio, proposal: solucion, acceptance: aceptacion, impact: impacto };
}

/**
 * El revisor entrega su informe: veredicto sobre un hash + (si encontró algo) sus hallazgos. Todo en UNA transacción: o quedan el
 * veredicto y los hallazgos, o ninguno. Los hallazgos nacen OPEN y el director decide qué hacer con ellos; el cierre no se
 * adelanta: un FAIL sin hallazgos o un PASS con hallazgos accionables son informes incoherentes y se rechazan.
 */
function informar(root, { role, scope_kind = 'TASK', task_id = null, finding_id = null, subject_hash, revision = null, verdict, justification = null, evidence = null, findings = [], agent_id = null, tipo = null, event_id = null, actor = null, sesion_llamante = null }) {
  if (sesionDelConstructor(root, sesion_llamante)) return noAutorizado('informar', 'builder (sesión)');
  if (!ROLES.includes(role)) return { status: 'ROL_INVALIDO', validos: ROLES };
  if (!ALCANCES.includes(scope_kind)) return { status: 'ALCANCE_INVALIDO', validos: ALCANCES };
  const quien = actor || 'revisor:' + role;
  if (quien !== 'revisor:' + role && String(quien).split(':')[0] !== 'director') return noAutorizado('informar', quien);
  const v = String(verdict || '').toUpperCase();
  if (!VEREDICTOS.includes(v)) return { status: 'VEREDICTO_INVALIDO', validos: VEREDICTOS };
  if (!subject_hash) return { status: 'SIN_HASH', detalle: 'un veredicto va ligado al hash del sujeto que se revisó' };
  const just = U.limpiar(root, justification || '', 500);
  if (v === 'NOT_APPLICABLE' && !just) return { status: 'NOT_APPLICABLE_SIN_JUSTIFICAR', detalle: 'NOT_APPLICABLE exige justificar por qué no hay nada que revisar en este rol' };
  if (scope_kind === 'TASK' && !task_id) return { status: 'FALTA_TAREA' };
  if (scope_kind === 'FINDING' && !finding_id) return { status: 'FALTA_CORRECCION' };
  const prep = [];
  for (const h of Array.isArray(findings) ? findings : []) {
    const base = typeof h === 'string' ? parseHallazgoCorto(h) : h;
    const p = corr.preparar(root, Object.assign({}, base, { task_id: base.task_id || task_id || null, actor: 'revisor:' + role, origin: 'revisor:' + role, reviewed_hash: subject_hash, publicar: false }));
    if (p.status) return Object.assign({ en: 'hallazgo ' + (prep.length + 1) }, p);
    prep.push(p);
  }
  const accionables = prep.filter((p) => p.accionable);
  if (v === 'PASS' && accionables.length) return { status: 'PASS_CON_HALLAZGOS', detalle: 'un PASS no lleva hallazgos accionables: informa FAIL o baja la severidad a NOTA' };
  if (v === 'FAIL' && !accionables.length && scope_kind !== 'FINDING') return { status: 'FAIL_SIN_HALLAZGOS', detalle: 'un FAIL se justifica con al menos un hallazgo accionable' };
  if (v === 'FAIL' && scope_kind === 'FINDING' && !accionables.length && !just) return { status: 'FAIL_SIN_RAZON', detalle: 'rechazar una corrección exige la razón (--justificacion) o un hallazgo nuevo' };
  return I.tx2(root, (db, despertar) => {
    if (event_id) {
      const previo = db.get('SELECT id FROM teams_reviews WHERE event_id = ?', event_id);
      if (previo) return { status: 'DUPLICADO', review_id: previo.id, duplicado: true };
    }
    const reg = db.get('SELECT * FROM teams_reviewers WHERE role = ?', role);
    if (!reg) return { status: 'REVISOR_NO_REGISTRADO', role, detalle: 'el director registra a cada revisor (modalidad e identidad) antes de aceptar su informe' };
    if (agent_id && reg.modality === 'SUBAGENTE' && reg.agent_id !== agent_id) return { status: 'AGENTE_NO_COINCIDE', esperado: reg.agent_id };
    if (task_id && !I.tarea(db, task_id)) return { status: 'TAREA_DESCONOCIDA', task_id };
    let fnd = null;
    if (scope_kind === 'FINDING') {
      fnd = corr.leer(db, finding_id);
      if (!fnd) return { status: 'CORRECCION_DESCONOCIDA' };
    }
    /* PASS y NOT_APPLICABLE no necesitan triaje: nacen consumidos. Un FAIL espera a que el director publique o descarte sus hallazgos. */
    const consumido = v === 'FAIL' ? 0 : 1;
    db.run(`INSERT INTO teams_reviews (role, scope_kind, task_id, finding_id, subject_hash, revision, verdict, justification, evidence, agent_id, tipo, consumed, event_id, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, role, scope_kind, scope_kind === 'FINAL' ? null : (task_id || (fnd && fnd.task_id) || null), finding_id || null, subject_hash,
    revision, v, just || null, I.js(evidence == null ? null : U.limpiar(root, typeof evidence === 'string' ? evidence : JSON.stringify(evidence), 800)), reg.agent_id || agent_id, tipo || (scope_kind === 'FINDING' ? 'DIRIGIDA' : scope_kind), consumido, event_id, I.ahoraIso());
    const reviewId = db.get('SELECT MAX(id) AS id FROM teams_reviews').id;
    const creados = [];
    for (const p of prep) {
      const r = corr.añadirEn(db, despertar, root, p);
      creados.push({ status: r.status, id: r.id });
    }
    db.run('UPDATE teams_reviews SET findings = ? WHERE id = ?', I.js(creados.map((c) => c.id).filter(Boolean)), reviewId);
    let reabierta = null;
    if (scope_kind === 'FINDING' && v === 'FAIL') {
      /* El revisor de una corrección la rechaza con evidencia nueva: se reabre y vuelve primero a la cola del constructor. */
      reabierta = corr.reabrirEn(db, despertar, root, { id: finding_id, razon: just || 'la corrección no cumple la aceptación', evidencia: evidence ? JSON.stringify(evidence) : null, reviewed_hash: subject_hash, actor: 'revisor:' + role });
      if (reabierta.status === 'REABIERTA') db.run('UPDATE teams_reviews SET consumed = 1 WHERE id = ?', reviewId);
    }
    I.publicar(db, despertar, { kind: 'REVIEW_REPORTED', producer: 'revisor', target: 'director', task_id: task_id || null, payload: { role, scope_kind, verdict: v, review_id: reviewId, hallazgos: creados.map((c) => c.id) } });
    return { status: 'REGISTRADO', review_id: reviewId, verdict: v, modalidad: reg.modality, hallazgos: creados, reabierta };
  });
}

/**
 * Informes de revisores cuyo resultado el director aún no consumió: un FAIL cuyos hallazgos siguen OPEN (sin publicar ni descartar).
 * PASS y NOT_APPLICABLE no necesitan triaje, y un FAIL de corrección ya se reabrió. Es derivado, no una marca a mano.
 */
function sinConsumir(db) {
  if (!I.tieneEsquemaV2(db)) return [];
  return db.all('SELECT id, role, scope_kind, task_id, verdict, findings FROM teams_reviews WHERE consumed = 0')
    .filter((r) => I.pj(r.findings, []).some((id) => { const f = db.get('SELECT state FROM teams_findings WHERE id = ?', id); return f && f.state === 'OPEN'; }))
    .map((r) => ({ id: r.id, role: r.role, scope_kind: r.scope_kind, task_id: r.task_id, verdict: r.verdict }));
}

/** El director declara consumido el resultado de un revisor (ya publicó o descartó sus hallazgos). */
function consumir(root, { ids = null, role = null, actor = 'director', sesion_llamante = null } = {}) {
  if (String(actor).split(':')[0] !== 'director') return noAutorizado('consumir', actor);
  if (sesionDelConstructor(root, sesion_llamante)) return noAutorizado('consumir', 'builder (sesión)');
  return I.tx2(root, (db) => {
    const filas = db.all('SELECT id FROM teams_reviews WHERE consumed = 0' + (role ? ' AND role = ?' : ''), ...(role ? [role] : []))
      .filter((r) => !ids || U.lista(ids).map(Number).includes(r.id));
    /* No se consume un informe cuyos hallazgos siguen sin triar: eso dejaría una corrección fuera de la cola sin que nadie la haya mirado. */
    const sinTriar = db.all("SELECT id FROM teams_findings WHERE state = 'OPEN' AND actionable = 1").map((r) => r.id);
    if (sinTriar.length && filas.length) return { status: 'HALLAZGOS_SIN_TRIAR', ids: sinTriar, detalle: 'publica o descarta esos hallazgos antes de consumir el informe' };
    for (const r of filas) db.run('UPDATE teams_reviews SET consumed = 1 WHERE id = ?', r.id);
    return { status: 'CONSUMIDOS', n: filas.length };
  });
}

/**
 * Cobertura de revisión por rol sobre lo entregado: por tarea (veredicto vigente / obsoleto / falta) y sobre el sujeto FINAL.
 * No toca nada; es lo que el director lee para saber a quién esperar.
 */
function estadoRevision(root, { ahora = Date.now() } = {}) {
  return I.lectura2(root, (db) => {
    if (!db) return { disponible: false, motivo: 'MIGRACION_PENDIENTE' };
    const regs = revisores(db);
    const plan = planActivo(db);
    const entregadas = plan ? I.tareas(db, plan).filter((t) => ['VERIFYING', 'DONE_VERIFIED'].includes(t.state)) : [];
    const porTarea = entregadas.map((t) => {
      const sujeto = sujetoDeTarea(db, t);
      const fila = { task_id: t.id, subject_hash: sujeto, roles: {} };
      for (const r of ROLES) {
        const v = veredictoVigente(db, { role: r, scope_kind: 'TASK', task_id: t.id, subject_hash: sujeto });
        fila.roles[r] = Object.assign({ aplica: aplica(r, t.allowed_files) }, v);
      }
      return fila;
    });
    const fin = plan ? sujetoFinal(root, db, plan) : null;
    const final = {};
    for (const r of ROLES) final[r] = fin ? veredictoVigente(db, { role: r, scope_kind: 'FINAL', subject_hash: fin.hash }) : { estado: 'SIN_PLAN' };
    const sinConsumirRows = sinConsumir(db);
    return {
      disponible: true, revisores: regs, por_tarea: porTarea, sujeto_final: fin ? { hash: fin.hash, incompleto: fin.incompleto, tareas: fin.tareas } : null, final,
      sin_registrar: ROLES.filter((r) => !regs[r]), degradados: ROLES.filter((r) => regs[r] && regs[r].degradado), sin_consumir: sinConsumirRows,
    };
  });
}

/** Lo que cada rol aún debe revisar de lo ya entregado (para el director y para el loop de cada revisor). */
function pendientes(root) {
  const e = estadoRevision(root);
  if (!e.disponible) return e;
  const out = [];
  for (const t of e.por_tarea) {
    for (const r of ROLES) {
      const v = t.roles[r];
      if (v.estado !== 'VIGENTE') out.push({ role: r, task_id: t.task_id, subject_hash: t.subject_hash, motivo: v.estado, aplica: v.aplica });
    }
  }
  return { disponible: true, pendientes: out, final: e.final, sujeto_final: e.sujeto_final };
}

function sujetoFinalDe(root) {
  return I.lectura2(root, (db) => {
    if (!db) return { status: 'MIGRACION_PENDIENTE' };
    const plan = planActivo(db);
    if (!plan) return { status: 'SIN_PLAN' };
    const f = sujetoFinal(root, db, plan);
    return { status: 'OK', plan_id: plan, hash: f.hash, incompleto: f.incompleto, tareas: f.tareas };
  });
}

module.exports = { ROLES, MODALIDADES, VEREDICTOS, aplica, registrar, revisores, informar, consumir, sinConsumir, estadoRevision, pendientes, sujetoFinal, sujetoFinalDe, sujetoDeTarea, veredictoVigente, planActivo };

// ─── CLI: akdd teams revision <sub> ──────────────────────────────────────────
if (require.main === module) {
  const { opt, pos } = U.parseArgs(process.argv.slice(2));
  const [sub] = pos;
  const root = process.cwd();
  let r;
  try {
    switch (sub) {
      case 'registrar': r = registrar(root, { role: opt.rol, agent_id: opt.agente || null, session_id: opt.sesion || null, modality: opt.modalidad, scope: opt.alcance, coverage: opt.cobertura, actor: opt.como || 'director', sesion_llamante: opt.sesion || null }); break;
      case 'informar': {
        const hs = [].concat(opt.hallazgo || []);
        r = informar(root, {
          role: opt.rol, scope_kind: (opt.alcance ? String(opt.alcance).toUpperCase() : (opt.correccion ? 'FINDING' : 'TASK')), task_id: opt.tarea || null, finding_id: opt.correccion || null,
          subject_hash: opt.hash === 'actual' ? undefined : opt.hash, verdict: opt.veredicto, justification: opt.justificacion || null, evidence: opt.evidencia || null,
          findings: hs, agent_id: opt.agente || null, event_id: opt.evento || null, actor: opt.como || null, sesion_llamante: opt.sesion || null,
        });
        break;
      }
      case 'consumir': r = consumir(root, { ids: opt.ids || null, role: opt.rol || null, actor: opt.como || 'director', sesion_llamante: opt.sesion || null }); break;
      case 'sujeto-final': r = sujetoFinalDe(root); break;
      case 'pendientes': r = pendientes(root); break;
      case 'estado': default: r = estadoRevision(root); break;
    }
  } catch (e) { r = { status: e.code || 'ERROR', detalle: e.message }; }
  if (['registrar', 'informar', 'consumir'].includes(sub)) require('./teams-canal.cjs').refrescar(root);
  console.log(JSON.stringify(r, null, 2));
  if (r && /INVALIDO|DESCONOCID|ERROR|NO_AUTORIZADO|MIGRACION_PENDIENTE|FALTA|SIN_|NO_REGISTRADO|INCOHERENTE|COMPARTIDA|PASS_CON|FAIL_SIN|NOT_APPLICABLE_SIN/.test(String(r.status || ''))) process.exitCode = 1;
}
