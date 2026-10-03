'use strict';

/**
 * Cierre explícito, apagado y avance medido de una campaña TEAMS (spec §12 y decisión del dueño).
 *
 *   · La cola vacía NO es el fin: con el trabajo principal agotado la campaña queda en WAITING_FINAL_AUDIT hasta que los tres
 *     revisores concluyan sobre el sujeto FINAL. Solo entonces el director publica el cierre (CLOSE_REQUEST) y el constructor lo
 *     confirma con ACK (close_id + revisión) y apaga sus vigilantes. Un hallazgo que llega entre el cierre y el ACK lo REABRE.
 *   · Estado final COMPLETED o COMPLETED_WITH_PENDING, nunca mezclados; el reporte enumera lo que NO se implementó y por qué.
 *   · El avance es MEDIDO: tareas verificadas / tareas del plan, con la lista de decisiones del dueño que bloquean el resto.
 *     Nunca se inventa: sin plan no hay porcentaje (null, no 0).
 *   · Apagar vigilantes lo declara el que los apaga (STOPPED / STOP_FAILED); TEAMS no mata procesos ajenos ni verifica el sistema
 *     operativo: guarda lo declarado y el diagnóstico.
 */

const crypto = require('crypto');
const tm = require('./teams-manager.cjs');
const U = require('./teams-util.cjs');

const I = tm._i;
const FINALES_CIERRE = ['ACKED'];
const ACTIVOS = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'IMPLEMENTED_PENDING_REVIEW', 'REOPENED'];

const rev = () => require('./teams-revision.cjs');

/** ¿La sesión que llama es la del constructor conectado? (el director no actúa con ella) */
function sesionDelConstructor(root, sesion) {
  if (!sesion) return false;
  return I.lectura2(root, (db) => { const b = db && db.get('SELECT session_id FROM teams_builder WHERE id = 1'); return !!b && b.session_id === sesion; });
}

function cierreVigente(db) {
  if (!I.tieneEsquemaV2(db)) return null;
  const c = db.get('SELECT * FROM teams_closure ORDER BY requested_at DESC, rowid DESC LIMIT 1');
  return c ? { close_id: c.close_id, plan_id: c.plan_id, state: c.state, revision: c.revision, final_status: c.final_status, pending: I.pj(c.pending, []), not_done: I.pj(c.not_done, []),
    requested_at: c.requested_at, ack_at: c.ack_at, ack_session: c.ack_session, stop_report: I.pj(c.stop_report, null), reopened_reason: c.reopened_reason, confirmed_at: c.confirmed_at } : null;
}

// ─── avance medido ───────────────────────────────────────────────────────────

/**
 * Avance del plan, medido del ledger: verificadas ÷ tareas del plan (las canceladas no cuentan), y qué decisiones del dueño
 * bloquean cuántas tareas. Las tareas bloqueadas por decisión pendiente se cuentan una sola vez aunque dependan de varias.
 */
function avanceDe(db) {
  const plan = db ? db.get('SELECT id, objective, revision FROM teams_plans ORDER BY created_at DESC LIMIT 1') : null;
  if (!plan) return { disponible: !!db, plan: null, porcentaje: null, mensaje: 'Sin plan: no hay avance que medir.' };
  const ts = I.tareas(db, plan.id).filter((t) => t.state !== 'CANCELLED');
  const total = ts.length;
  const verificadas = ts.filter((t) => t.state === 'DONE_VERIFIED').length;
  const decisiones = db.all('SELECT * FROM teams_decisions WHERE resolved_at IS NULL AND decision_required = 1').map((d) => ({
    id: d.id, pregunta: d.question, reason_code: d.reason_code, tareas: I.pj(d.affected_tasks, []).filter((x) => ts.some((t) => t.id === x && t.state !== 'DONE_VERIFIED')),
  })).filter((d) => d.tareas.length || d.reason_code === 'CORRECCION_NEGOCIO');
  const bloqueadasSet = new Set(decisiones.flatMap((d) => d.tareas));
  const pct = total ? Math.round((verificadas / total) * 1000) / 10 : null;
  const sinDecision = total ? Math.round(((total - bloqueadasSet.size) / total) * 1000) / 10 : null;
  const enCurso = ts.filter((t) => !['DONE_VERIFIED'].includes(t.state) && !bloqueadasSet.has(t.id)).length;
  let mensaje;
  if (!total) mensaje = 'El plan no tiene tareas: no hay avance que medir.';
  else if (!decisiones.length) mensaje = `${pct} % verificado (${verificadas} de ${total} tareas); sin decisiones tuyas pendientes.`;
  else if (enCurso) mensaje = `${pct} % verificado (${verificadas} de ${total} tareas). Quedan ${bloqueadasSet.size} tareas que dependen de decisiones tuyas (${decisiones.map((d) => d.id).join(', ')}); el resto sigue avanzando: sin ellas el máximo alcanzable es ${sinDecision} %.`;
  else mensaje = `El proyecto quedó en ${pct} % (${verificadas} de ${total} tareas verificadas) por estas decisiones tuyas: ${decisiones.map((d) => `${d.id} («${U.linea('', d.pregunta || d.reason_code, 100)}»: bloquea ${d.tareas.length || 'una corrección'})`).join('; ')}.`;
  return {
    disponible: true, plan: plan.id, plan_revision: plan.revision, total, verificadas, porcentaje: pct, maximo_sin_decisiones: sinDecision,
    bloqueadas_por_decision: [...bloqueadasSet], decisiones_bloqueantes: decisiones, trabajo_independiente_pendiente: enCurso, mensaje,
  };
}

function avance(root) { return I.lectura2(root, (db) => (db ? avanceDe(db) : { disponible: false, porcentaje: null, mensaje: 'Esquema TEAMS v2 no aplicado: akdd teams init --aprobar-migracion.' })); }

// ─── capa de flujo derivada ──────────────────────────────────────────────────

/**
 * Estado de FLUJO de una tarea, derivado de hechos (no guardado, para que no diverja): construido, en revisión, con corrección,
 * verificado por el director, registro de memoria pendiente y cerrado son cosas distintas y aquí se ven por separado. `estado` es el
 * principal: una corrección abierta manda sobre todo lo demás; después, lo más avanzado alcanzado sin pendientes.
 * No cambia el significado de teams_tasks.state: es una capa encima.
 */
function flujoDeTarea(db, t) {
  const f = I.flujoDe(db, t.id);
  if (!f) return null;
  const corregir = db.get("SELECT COUNT(*) AS n FROM teams_findings WHERE task_id = ? AND actionable = 1 AND state IN ('OPEN','ASSIGNED','IN_PROGRESS','IMPLEMENTED_PENDING_REVIEW','REOPENED')", t.id).n;
  /* Asignada sin ACK (READY con dueño) NO es BUILDER_RUNNING: sin ACK no se dio por iniciada. */
  const corriendo = t.state === 'RUNNING';
  const entregada = ['VERIFYING', 'DONE_VERIFIED'].includes(t.state) && !!f.delivered_at;
  const verificada = t.state === 'DONE_VERIFIED';
  const R = rev();
  let auditoria = null;
  if (entregada) {
    const sujeto = R.sujetoDeTarea(db, t);
    const roles = {};
    for (const r of R.ROLES) {
      if (!R.aplica(r, t.allowed_files) && r !== 'negocio') { roles[r] = 'NO_APLICA'; continue; }
      const v = R.veredictoVigente(db, { role: r, scope_kind: 'TASK', task_id: t.id, subject_hash: sujeto });
      roles[r] = v.estado === 'VIGENTE' ? v.verdict : v.estado;
    }
    auditoria = { roles, pendiente: Object.values(roles).some((x) => !['PASS', 'NOT_APPLICABLE', 'NO_APLICA'].includes(x)) };
  }
  const memoriaPendiente = verificada && ['PENDING', 'FAILED', 'RETRY'].includes(f.memory_state);
  let estado = null;
  if (corriendo) estado = 'BUILDER_RUNNING';
  else if (entregada) {
    if (corregir) estado = 'CORRECTION_PENDING';
    else if (f.closed_at) estado = 'CLOSED';
    else if (verificada) estado = memoriaPendiente ? 'MEMORY_PENDING' : 'DIRECTOR_VERIFIED';
    else estado = auditoria && auditoria.pendiente ? 'AUDIT_PENDING' : 'BUILDER_DELIVERED';
  }
  return {
    estado, fase: f.phase, entregada, audit_pending: !!(auditoria && auditoria.pendiente), auditoria: auditoria && auditoria.roles, correction_pending: corregir > 0,
    director_verified: verificada, memory_state: f.memory_state, closed: !!f.closed_at, revalidar: f.revalidar, suspendida: f.suspended, sujeto_vigente: f.current_hash || t.subject_hash,
  };
}

// ─── estado de la campaña ────────────────────────────────────────────────────

/** Estado derivado de los hechos (no guardado, para que no pueda divergir): nunca dice FINISHED solo porque la cola esté vacía. */
function campanaDe(db, root = null) {
  const s = I.sesion(db);
  if (!s || !s.enabled) return { estado: 'DESACTIVADA' };
  if (s.paused) return { estado: 'PAUSADA' };
  const c = cierreVigente(db);
  if (c && c.state === 'ACKED') return { estado: c.final_status, close_id: c.close_id };
  if (c && c.state === 'REQUESTED') return { estado: 'CIERRE_SOLICITADO', close_id: c.close_id };
  const plan = rev().planActivo(db);
  if (!plan) return { estado: 'SIN_PLAN' };
  const ts = I.tareas(db, plan).filter((t) => t.state !== 'CANCELLED');
  const trabajo = ts.filter((t) => ['PENDING', 'READY', 'RUNNING', 'VERIFYING'].includes(t.state));
  const correcciones = db.get("SELECT COUNT(*) AS n FROM teams_findings WHERE actionable = 1 AND state IN ('ASSIGNED','IN_PROGRESS','REOPENED','IMPLEMENTED_PENDING_REVIEW')").n;
  if (trabajo.length || correcciones) return { estado: 'EN_CURSO', tareas_en_curso: trabajo.length, correcciones_abiertas: correcciones };
  const bloqueadas = ts.filter((t) => t.state !== 'DONE_VERIFIED');
  const base = bloqueadas.length ? { bloqueadas: bloqueadas.map((t) => t.id) } : {};
  if (c && c.state === 'REOPENED') return Object.assign({ estado: 'WAITING_FINAL_AUDIT', reabierto: c.reopened_reason }, base);
  return Object.assign({ estado: 'WAITING_FINAL_AUDIT', nota: 'cola vacía: espera a los tres revisores sobre el sujeto final; la vigilancia sigue' }, base);
}

// ─── condiciones de cierre ───────────────────────────────────────────────────

function condiciones(db, root, { memoria = null, pendientes_explicitos = [] } = {}) {
  const faltan = [];
  const pendientes = [];
  const noHecho = [];
  const plan = rev().planActivo(db);
  if (!plan) return { faltan: [{ code: 'SIN_PLAN' }], pendientes, no_hecho: noHecho, plan: null };
  const ts = I.tareas(db, plan).filter((t) => t.state !== 'CANCELLED');
  const explicitos = new Map((pendientes_explicitos || []).map((x) => (typeof x === 'string' ? [x, 'pendiente declarado por el director'] : [x.id, x.motivo || 'pendiente declarado por el director'])));
  const abiertas = new Map(db.all('SELECT * FROM teams_decisions WHERE resolved_at IS NULL').map((d) => [d.id, d]));
  const sinCerrar = [];
  for (const t of ts) {
    if (t.state === 'DONE_VERIFIED') continue;
    const decision = t.stop && (t.stop.ids || []).map((id) => abiertas.get(id)).find((d) => d && d.decision_required);
    if (['BLOCKED_HUMAN', 'BLOCKED_DEPENDENCY'].includes(t.state) && decision) {
      pendientes.push({ tipo: 'DECISION_HUMANA', task_id: t.id, decision_id: decision.id, pregunta: U.linea('', decision.question || decision.reason_code, 200) });
      noHecho.push({ task_id: t.id, estado: t.state, motivo: 'espera la decisión ' + decision.id });
    } else if (explicitos.has(t.id)) {
      pendientes.push({ tipo: 'DECLARADO', task_id: t.id, motivo: U.linea('', explicitos.get(t.id), 200) });
      noHecho.push({ task_id: t.id, estado: t.state, motivo: U.linea('', explicitos.get(t.id), 200) });
    } else sinCerrar.push(t.id + '(' + t.state + ')');
  }
  if (sinCerrar.length) faltan.push({ code: 'TAREAS_SIN_CERRAR', tareas: sinCerrar });
  const fs = db.all('SELECT * FROM teams_findings').map(require('./teams-correcciones.cjs').fila);
  const abiertasF = fs.filter((f) => f.actionable && ACTIVOS.includes(f.state));
  if (abiertasF.length) faltan.push({ code: 'CORRECCIONES_ABIERTAS', ids: abiertasF.map((f) => f.id + '(' + f.state + ')') });
  const sinTriar = fs.filter((f) => f.actionable && f.state === 'OPEN');
  if (sinTriar.length) faltan.push({ code: 'HALLAZGOS_SIN_TRIAR', ids: sinTriar.map((f) => f.id) });
  for (const f of fs.filter((x) => x.state === 'BLOCKED_HUMAN')) {
    pendientes.push({ tipo: 'CORRECCION_BLOQUEADA', id: f.id, decision_id: f.decision_id, criterio: U.linea('', f.criterion, 200) });
    noHecho.push({ task_id: f.task_id, correccion: f.id, motivo: 'corrección en espera de decisión ' + f.decision_id });
  }
  /* Los tres revisores sobre el sujeto FINAL: sin resultado viejo ni ausente. */
  const R = rev();
  const regs = R.revisores(db);
  const fin = R.sujetoFinal(root, db, plan);
  for (const r of R.ROLES) {
    if (!regs[r]) { faltan.push({ code: 'REVISOR_NO_REGISTRADO', role: r }); continue; }
    const v = R.veredictoVigente(db, { role: r, scope_kind: 'FINAL', subject_hash: fin.hash });
    if (v.estado === 'SIN_VEREDICTO') faltan.push({ code: 'REVISION_FINAL_FALTA', role: r });
    else if (v.estado === 'OBSOLETO') faltan.push({ code: 'REVISION_FINAL_OBSOLETA', role: r, detalle: 'el código cambió después de su veredicto' });
    else if (v.verdict === 'FAIL') faltan.push({ code: 'REVISION_FINAL_FAIL', role: r });
  }
  const sinConsumir = R.sinConsumir(db);
  if (sinConsumir.length) faltan.push({ code: 'RESULTADOS_SIN_CONSUMIR', reviews: sinConsumir.map((r) => r.id) });
  /* Registro de memoria y revalidaciones. */
  const flujos = ts.map((t) => ({ t, f: I.flujoDe(db, t.id) })).filter((x) => x.f);
  const memPend = flujos.filter((x) => ['PENDING', 'FAILED', 'RETRY'].includes(x.f.memory_state));
  if (memPend.length) faltan.push({ code: 'MEMORIA_PENDIENTE', tareas: memPend.map((x) => x.t.id + '(' + x.f.memory_state + ')') });
  if (memoria && memoria.available && memoria.required_pending > 0) faltan.push({ code: 'JOBS_OBLIGATORIOS_ABIERTOS', n: memoria.required_pending });
  const reval = flujos.filter((x) => x.f.revalidar.length);
  if (reval.length) faltan.push({ code: 'REVALIDACION_PENDIENTE', tareas: reval.map((x) => x.t.id) });
  const susp = flujos.filter((x) => x.f.suspended);
  if (susp.length) faltan.push({ code: 'TAREA_SUSPENDIDA', tareas: susp.map((x) => x.t.id) });
  return {
    faltan, pendientes, no_hecho: noHecho, plan, sujeto_final: fin.hash, degradados: R.ROLES.filter((r) => regs[r] && regs[r].degradado),
    memoria: memoria && !memoria.available ? { estado: 'NO_DISPONIBLE', codigo: memoria.code } : { estado: 'COMPROBADA' },
  };
}

/**
 * El director solicita el cierre. Rechazado (con la lista exacta de lo que falta) salvo que TODAS las condiciones se cumplan. Si se
 * cumplen: publica CLOSE_REQUEST con close_id y revisión, y el constructor deja de tomar trabajo nuevo hasta su ACK.
 */
function cerrar(root, { pendientes_explicitos = [], actor = 'director', sesion_llamante = null } = {}) {
  if (String(actor).split(':')[0] !== 'director') return { status: 'NO_AUTORIZADO', detalle: 'solo el director solicita el cierre' };
  if (sesionDelConstructor(root, sesion_llamante)) return { status: 'NO_AUTORIZADO', detalle: 'la sesión del constructor no solicita el cierre: solo lo confirma con su ACK' };
  /* La cola de memoria se consulta fuera de la transacción de TEAMS (otra conexión, solo lectura). */
  let memoria = null;
  try { memoria = require('./memory-queue.cjs').estadisticas(root); } catch { memoria = { available: false, code: 'NO_DISPONIBLE' }; }
  return I.tx2(root, (db, despertar) => {
    const s = I.sesion(db);
    if (!s || !s.enabled) return { status: 'DESACTIVADO' };
    const previo = cierreVigente(db);
    if (previo && previo.state === 'ACKED') return { status: 'CAMPANA_CERRADA', close_id: previo.close_id, final_status: previo.final_status, detalle: 'una reapertura necesita nueva sesión: akdd teams reabrir' };
    if (previo && previo.state === 'REQUESTED') return { status: 'CIERRE_YA_SOLICITADO', close_id: previo.close_id, revision: previo.revision, final_status: previo.final_status };
    const c = condiciones(db, root, { memoria, pendientes_explicitos });
    if (c.faltan.length) return { status: 'CIERRE_RECHAZADO', faltan: c.faltan, pendientes: c.pendientes, detalle: 'la cola vacía no es el fin: faltan condiciones del cierre' };
    const closeId = 'C-' + crypto.randomUUID().slice(0, 8);
    const finalStatus = c.pendientes.length ? 'COMPLETED_WITH_PENDING' : 'COMPLETED';
    db.run('INSERT INTO teams_closure (close_id, plan_id, state, final_status, pending, not_done, requested_at) VALUES (?,?,?,?,?,?,?)', closeId, c.plan, 'REQUESTED', finalStatus, I.js(c.pendientes), I.js(c.no_hecho), I.ahoraIso());
    const ev = I.publicar(db, despertar, { kind: 'CLOSE_REQUEST', producer: 'director', target: 'builder', payload: { close_id: closeId, final_status: finalStatus, pendientes: c.pendientes.length, no_hecho: c.no_hecho.length } });
    db.run('UPDATE teams_closure SET revision = ? WHERE close_id = ?', ev.seq, closeId);
    return {
      status: 'CIERRE_SOLICITADO', close_id: closeId, revision: ev.seq, final_status: finalStatus, pendientes: c.pendientes, no_hecho: c.no_hecho,
      degradaciones: c.degradados.map((r) => 'revisor ' + r + ' en modalidad SECUENCIAL'), memoria: c.memoria,
      siguiente: 'el constructor confirma con: akdd teams cerrar-ack --close=' + closeId + ' --revision=' + ev.seq + ' --vigilantes=apagados|stop-failed',
    };
  });
}

/** Un hallazgo accionable que llega con el cierre solicitado (aún sin ACK) lo reabre: no se descarta ni espera. */
function reabrirPorHallazgo(db, despertar, f) {
  if (!I.tieneEsquemaV2(db) || !f || f.actionable === false) return null;
  const c = cierreVigente(db);
  if (!c || c.state !== 'REQUESTED') return null;
  const razon = 'HALLAZGO_EN_CARRERA:' + f.id;
  db.run("UPDATE teams_closure SET state = 'REOPENED', reopened_reason = ? WHERE close_id = ?", razon, c.close_id);
  I.publicar(db, despertar, { kind: 'CLOSE_REOPENED', producer: 'teams', target: 'builder', payload: { close_id: c.close_id, razon } });
  I.publicar(db, despertar, { kind: 'CLOSE_REOPENED', producer: 'teams', target: 'director', payload: { close_id: c.close_id, razon } });
  return { close_id: c.close_id, razon };
}

/**
 * ACK del constructor: confirma close_id y revisión exactos, y declara el apagado de SUS vigilantes. Si el cierre se reabrió por un
 * hallazgo en carrera, el ACK se rechaza y el constructor vuelve al trabajo. STOP_FAILED se conserva con su diagnóstico.
 */
function ack(root, { close_id, revision, session_id = null, vigilantes = 'NO_REPORTADO', detalle = null, actor = 'builder' }) {
  if (String(actor).split(':')[0] !== 'builder') return { status: 'NO_AUTORIZADO', detalle: 'el ACK de cierre es del constructor' };
  const vig = String(vigilantes).toLowerCase();
  const estadoVig = /^(apagados|stopped|ok)$/.test(vig) ? 'STOPPED' : (/^(stop-?failed|fallo|error)$/.test(vig) ? 'STOP_FAILED' : 'NO_REPORTADO');
  return I.tx2(root, (db, despertar) => {
    const c = db.get('SELECT * FROM teams_closure WHERE close_id = ?', close_id);
    if (!c) return { status: 'CIERRE_DESCONOCIDO' };
    const b = db.get('SELECT session_id FROM teams_builder WHERE id = 1');
    if (b && b.session_id && session_id !== b.session_id) return { status: 'SESION_NO_REGISTRADA', detalle: 'el ACK debe venir de la sesión del constructor conectado' };
    if (c.state === 'ACKED') return { status: 'ACK_DUPLICADO', close_id, final_status: c.final_status, duplicado: true };
    if (c.state === 'REOPENED') return { status: 'CIERRE_REABIERTO', razon: c.reopened_reason, detalle: 'llegó un hallazgo entre el cierre y tu ACK: atiéndelo (akdd teams ronda) y espera el nuevo cierre' };
    if (c.state !== 'REQUESTED') return { status: 'CIERRE_' + c.state };
    if (Number(revision) !== Number(c.revision)) return { status: 'REVISION_OBSOLETA', esperada: c.revision, recibida: revision == null ? null : Number(revision) };
    const reporte = { estado: estadoVig, detalle: detalle ? U.limpiar(root, detalle, 400) : null, declarado_por: 'builder', verificado_por_teams: false, at: I.ahoraIso() };
    db.run("UPDATE teams_closure SET state = 'ACKED', ack_at = ?, ack_session = ?, ack_revision = ?, stop_report = ? WHERE close_id = ?", I.ahoraIso(), session_id, Number(revision), I.js(reporte), close_id);
    I.publicar(db, despertar, { kind: 'CLOSE_ACKED', producer: 'builder', target: 'director', payload: { close_id, revision: Number(revision), vigilantes: estadoVig } });
    return { status: 'CIERRE_ACEPTADO', close_id, final_status: c.final_status, vigilantes: estadoVig, nota: estadoVig === 'STOP_FAILED' ? 'STOP_FAILED conservado con su diagnóstico: apaga a mano lo propio, sin matar procesos ajenos' : null };
  });
}

/** El director confirma la recepción del ACK y cierra el flujo de las tareas verificadas (CLOSED). Declara el apagado de los suyos. */
function confirmar(root, { close_id = null, vigilantes = 'NO_REPORTADO', detalle = null, actor = 'director', sesion_llamante = null } = {}) {
  if (String(actor).split(':')[0] !== 'director') return { status: 'NO_AUTORIZADO' };
  if (sesionDelConstructor(root, sesion_llamante)) return { status: 'NO_AUTORIZADO', detalle: 'la confirmación de recepción es del director' };
  const vig = String(vigilantes).toLowerCase();
  const estadoVig = /^(apagados|stopped|ok)$/.test(vig) ? 'STOPPED' : (/^(stop-?failed|fallo|error)$/.test(vig) ? 'STOP_FAILED' : 'NO_REPORTADO');
  return I.tx2(root, (db) => {
    const c = close_id ? db.get('SELECT * FROM teams_closure WHERE close_id = ?', close_id) : db.get('SELECT * FROM teams_closure ORDER BY requested_at DESC, rowid DESC LIMIT 1');
    if (!c) return { status: 'CIERRE_DESCONOCIDO' };
    if (c.state !== 'ACKED') return { status: 'SIN_ACK', estado: c.state };
    if (c.confirmed_at) return { status: 'YA_CONFIRMADO', final_status: c.final_status };
    const sr = I.pj(c.stop_report, {}) || {};
    sr.director = { estado: estadoVig, detalle: detalle ? U.limpiar(root, detalle, 400) : null, declarado_por: 'director', verificado_por_teams: false, at: I.ahoraIso() };
    db.run('UPDATE teams_closure SET confirmed_at = ?, stop_report = ? WHERE close_id = ?', I.ahoraIso(), I.js(sr), c.close_id);
    const cerradas = I.tareas(db, c.plan_id).filter((t) => t.state === 'DONE_VERIFIED');
    for (const t of cerradas) I.upsertFlujo(db, t.id, { closed_at: I.ahoraIso() });
    return { status: 'CIERRE_CONFIRMADO', final_status: c.final_status, tareas_cerradas: cerradas.length, vigilantes_director: estadoVig, vigilantes_builder: (sr.estado || 'NO_REPORTADO') };
  });
}

/** Reapertura explícita DESPUÉS del cierre: nueva sesión (generación +1) y nueva revisión; los recursos se reinician a propósito. */
function reabrirCampana(root, { motivo, actor = 'director', sesion_llamante = null } = {}) {
  if (String(actor).split(':')[0] !== 'director') return { status: 'NO_AUTORIZADO' };
  if (sesionDelConstructor(root, sesion_llamante)) return { status: 'NO_AUTORIZADO', detalle: 'reabrir la campaña es del director' };
  const m = U.limpiar(root, motivo || '', 300);
  if (!m) return { status: 'SIN_MOTIVO' };
  return I.tx2(root, (db, despertar) => {
    const s = I.sesion(db);
    if (!s || !s.enabled) return { status: 'DESACTIVADO' };
    const c = cierreVigente(db);
    if (!c || !['ACKED', 'REQUESTED', 'REOPENED'].includes(c.state)) return { status: 'NO_HAY_CIERRE', detalle: 'no hay un cierre que reabrir' };
    db.run("UPDATE teams_closure SET state = 'SUPERSEDED', reopened_reason = ? WHERE close_id = ?", m, c.close_id);
    const gen = s.session_generation + 1;
    db.run('UPDATE teams_sessions SET session_generation = ?, updated_at = ? WHERE id = 1', gen, I.ahoraIso());
    /* El constructor tiene que volver a conectarse y confirmar READY en la nueva generación. */
    if (db.get('SELECT 1 FROM teams_builder WHERE id = 1')) db.run("UPDATE teams_builder SET state = 'CONECTADO', ready_at = NULL, updated_at = ? WHERE id = 1", I.ahoraIso());
    db.run('DELETE FROM teams_campaign');
    I.publicar(db, despertar, { kind: 'CAMPAIGN_REOPENED', producer: 'director', target: 'builder', payload: { close_id: c.close_id, session_generation: gen, motivo: m } });
    return { status: 'CAMPANA_REABIERTA', session_generation: gen, cierre_anterior: c.close_id, siguiente: 'reconectar al constructor (akdd teams conectar-builder) y volver a ejecutar' };
  });
}

/**
 * Lo llama el puente de cierre al registrar (o fallar al registrar) la memoria de una tarea verificada. REGISTERED / NO_LEARNING
 * (aprendizaje legítimamente vacío, no un nodo falso) resuelven el pendiente; PENDING / FAILED lo mantienen y bloquean el cierre.
 */
function marcarMemoria(root, { task_id, state, detail = null }) {
  const validos = ['PENDING', 'REGISTERED', 'NO_LEARNING', 'FAILED', 'RETRY', 'NO_APLICA'];
  if (!validos.includes(state)) return { status: 'ESTADO_INVALIDO', validos };
  return I.tx2(root, (db) => {
    const t = I.tarea(db, task_id);
    if (!t) return { status: 'TAREA_DESCONOCIDA' };
    if (t.state !== 'DONE_VERIFIED') return { status: 'TAREA_NO_VERIFICADA', estado: t.state, detalle: 'solo lo verificado se registra en memoria' };
    I.upsertFlujo(db, task_id, { memory_state: state, memory_detail: detail ? U.limpiar(root, detail, 300) : null });
    return { status: 'OK', task_id, memory_state: state };
  });
}

function resumen(db) {
  if (!db) return { disponible: false };
  const c = cierreVigente(db);
  return { disponible: true, campana: campanaDe(db), cierre: c, avance: avanceDe(db) };
}

module.exports = { flujoDeTarea, cierreVigente, avanceDe, avance, campanaDe, condiciones, cerrar, reabrirPorHallazgo, ack, confirmar, reabrirCampana, marcarMemoria, resumen };

// ─── CLI: akdd teams cerrar | cerrar-ack | cierre-confirmar | reabrir | avance ───
if (require.main === module) {
  const { opt, pos } = U.parseArgs(process.argv.slice(2));
  const [sub] = pos;
  const root = process.cwd();
  let r;
  try {
    switch (sub) {
      case 'cerrar': r = cerrar(root, { pendientes_explicitos: U.lista(opt.pendientes).map((id) => ({ id, motivo: opt.motivo || 'pendiente declarado' })), sesion_llamante: opt.sesion || null }); break;
      case 'ack': r = ack(root, { close_id: opt.close, revision: opt.revision, session_id: opt.sesion || null, vigilantes: opt.vigilantes || 'NO_REPORTADO', detalle: opt.detalle || null }); break;
      case 'confirmar': r = confirmar(root, { close_id: opt.close || null, vigilantes: opt.vigilantes || 'NO_REPORTADO', detalle: opt.detalle || null, sesion_llamante: opt.sesion || null }); break;
      case 'reabrir': r = reabrirCampana(root, { motivo: opt.motivo, sesion_llamante: opt.sesion || null }); break;
      case 'memoria': r = marcarMemoria(root, { task_id: opt.tarea, state: opt.estado, detail: opt.detalle || null }); break;
      case 'avance': default: r = avance(root); break;
    }
  } catch (e) { r = { status: e.code || 'ERROR', detalle: e.message }; }
  if (['cerrar', 'ack', 'confirmar', 'reabrir', 'memoria'].includes(sub)) require('./teams-canal.cjs').refrescar(root);
  console.log(JSON.stringify(r, null, 2));
  if (r && /INVALIDO|DESCONOCID|ERROR|NO_AUTORIZADO|MIGRACION_PENDIENTE|RECHAZADO|REABIERTO|OBSOLETA|SIN_/.test(String(r.status || ''))) process.exitCode = 1;
}
