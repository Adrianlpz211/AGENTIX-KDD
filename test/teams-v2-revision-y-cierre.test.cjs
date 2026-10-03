'use strict';

/**
 * TEAMS v2 — tres revisores, cola vacía ≠ fin, cierre explícito, reapertura en carrera, reinicio y campaña fixture
 * (T06, T16 parcial, T20, T21, T22 parcial). Nivel A (mecanismo) salvo la campaña completa, marcada B (adapters y recibos SIMULADOS
 * + verificador real). El nivel C (Claude Code + Cursor + tres subagentes reales) NO se ejecuta aquí.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/teams-v2.cjs');
const { tm, corr, rev, cierre, bld } = H;
const md = require(path.join(H.G, 'teams-md-session.cjs'));
const dba = require(path.join(H.G, 'db-adapter.cjs'));
const { verificadorReal } = require(path.join(H.G, 'teams-verificador.cjs'));

const S = 'ses-cursor-aaaa';
const estadoCampana = (root) => tm.estado(root).campana.estado;
const codigos = (r) => (r.faltan || []).map((f) => f.code + (f.role ? ':' + f.role : ''));
const hashDe = (root, id) => rev.pendientes(root).pendientes.find((p) => p.task_id === id).subject_hash;
const conBuilder = (root, sesion = 'ses-cursor-aaaa') => bld.conectar(root, { session_id: sesion, proyecto: root, listo: true, loop: true, watch: true });

/** Cola de memoria 3.20.1 mínima en la base del fixture: verificado ≠ registrado, y los jobs obligatorios cuentan para el cierre. */
function conColaDeMemoria(root) {
  const w = dba.openWrite(path.join(root, '.agentic', 'memoria.db'));
  w.exec('CREATE TABLE mem_jobs (job_id TEXT PRIMARY KEY, state TEXT, attempts INTEGER DEFAULT 0, max_attempts INTEGER DEFAULT 5, required INTEGER DEFAULT 0, lease_until TEXT, error_code TEXT, manual_retries INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT, next_attempt_at TEXT)');
  w.close();
}

test('[A][T06] la cola vacía no cierra: WAITING_FINAL_AUDIT; correcciones vacías no son auditoría terminada; faltan los tres revisores sobre el sujeto final', () => {
  const root = H.proyecto();
  H.campanaVerificada(root);
  conBuilder(root);
  assert.equal(estadoCampana(root), 'WAITING_FINAL_AUDIT', 'trabajo principal agotado ≠ terminado');
  assert.equal(corr.listar(root, { activas: true }).length, 0, 'correcciones vacías');
  const sinRevisores = cierre.cerrar(root, {});
  assert.equal(sinRevisores.status, 'CIERRE_RECHAZADO');
  assert.deepEqual(codigos(sinRevisores).filter((c) => c.startsWith('REVISOR_NO_REGISTRADO')).sort(), ['REVISOR_NO_REGISTRADO:backend', 'REVISOR_NO_REGISTRADO:frontend', 'REVISOR_NO_REGISTRADO:negocio']);
  H.revisores(root);
  assert.deepEqual(codigos(cierre.cerrar(root, {})).sort(), ['REVISION_FINAL_FALTA:backend', 'REVISION_FINAL_FALTA:frontend', 'REVISION_FINAL_FALTA:negocio'], 'correcciones vacías NO significan auditoría terminada');
  const f0 = rev.sujetoFinalDe(root);
  assert.equal(rev.informar(root, { role: 'backend', scope_kind: 'FINAL', subject_hash: f0.hash, verdict: 'PASS' }).status, 'REGISTRADO');
  assert.equal(rev.informar(root, { role: 'negocio', scope_kind: 'FINAL', subject_hash: f0.hash, verdict: 'PASS' }).status, 'REGISTRADO');
  assert.deepEqual(codigos(cierre.cerrar(root, {})), ['REVISION_FINAL_FALTA:frontend'], 'con dos de tres revisores, no');
  assert.equal(md.ronda(root, { rol: 'director' }).accion, 'REVISION_FINAL_O_CIERRE');
});

test('[A][T06] auditor tardío: su hallazgo nace OPEN, el director lo publica, Cursor lo atiende primero y se cierra con la revisión dirigida (hash vigente)', () => {
  const root = H.proyecto();
  H.campanaVerificada(root);
  conBuilder(root);
  H.revisores(root);
  const hA = hashDe(root, 'A');
  const informe = rev.informar(root, {
    role: 'frontend', scope_kind: 'TASK', task_id: 'A', subject_hash: hA, verdict: 'FAIL',
    findings: [{ severity: 'HALLAZGO', location: 'src/a.js:1', criterion: 'el estado de error de a no se muestra', proposal: 'mostrar el mensaje', acceptance: 'el error aparece' }],
  });
  assert.equal(informe.status, 'REGISTRADO');
  const id = informe.hallazgos[0].id;
  assert.equal(corr.listar(root, { estado: 'OPEN' }).length, 1);
  assert.equal(md.ronda(root, { rol: 'builder' }).accion, 'ESPERAR', 'el revisor no asigna a Cursor por otro canal: nada que hacer hasta el triaje');
  assert.equal(md.ronda(root, { rol: 'director' }).accion, 'TRIAR_HALLAZGOS');
  assert.ok(codigos(cierre.cerrar(root, {})).includes('HALLAZGOS_SIN_TRIAR'));
  assert.equal(corr.tomar(root, { session_id: S, owner_id: 'cursor-1', id }).status, 'TRANSICION_INVALIDA', 'no se toma lo que el director no publicó');
  assert.equal(corr.publicarCorreccion(root, { id, actor: 'builder' }).status, 'NO_AUTORIZADO');
  assert.equal(corr.publicarCorreccion(root, { id, proposal: 'mostrar el mensaje en rojo bajo el campo' }).status, 'PUBLICADA');
  assert.equal(md.ronda(root, { rol: 'builder' }).accion, 'CORRECCION');
  assert.equal(estadoCampana(root), 'EN_CURSO', 'una corrección abierta saca a la campaña de la espera final');
  const t = corr.tomar(root, { session_id: S, owner_id: 'cursor-1', id });
  assert.equal(t.status, 'TOMADA');
  assert.equal(t.suspension, null, 'sin tarea principal en curso no hay nada que suspender');
  fs.writeFileSync(path.join(root, 'src/a.js'), 'module.exports = { v: "A", error: "visible" };\n');
  const e = corr.entregar(root, { session_id: S, id, owner_id: 'cursor-1', fencing: t.fencing, files: ['src/a.js'] });
  assert.equal(e.status, 'IMPLEMENTADA_PENDIENTE_REVIEW'.replace('REVIEW', 'REVISION'));
  assert.equal(corr.verificar(root, { id }).status, 'ESPERA_REVISION_DIRIGIDA', 'falta el veredicto del revisor de origen sobre el hash entregado');
  assert.equal(rev.informar(root, { role: 'frontend', scope_kind: 'FINDING', finding_id: id, task_id: 'A', subject_hash: hA, verdict: 'PASS' }).status, 'REGISTRADO');
  assert.equal(corr.verificar(root, { id }).status, 'ESPERA_REVISION_DIRIGIDA', 'un veredicto de un hash viejo no cuenta');
  const rechazo = rev.informar(root, { role: 'frontend', scope_kind: 'FINDING', finding_id: id, task_id: 'A', subject_hash: e.resolved_hash, verdict: 'FAIL', justification: 'el error se ve pero sin foco para teclado', evidence: 'captura 1' });
  assert.equal(rechazo.reabierta.status, 'REABIERTA');
  assert.equal(corr.siguiente(root).id, id, 'reabierta, vuelve a ser lo primero que ve el constructor');
  const t2 = corr.tomar(root, { session_id: S, owner_id: 'cursor-1', id });
  fs.writeFileSync(path.join(root, 'src/a.js'), 'module.exports = { v: "A", error: "visible", foco: true };\n');
  const e2 = corr.entregar(root, { session_id: S, id, owner_id: 'cursor-1', fencing: t2.fencing, files: ['src/a.js'] });
  assert.notEqual(e2.resolved_hash, e.resolved_hash);
  assert.equal(rev.informar(root, { role: 'frontend', scope_kind: 'FINDING', finding_id: id, task_id: 'A', subject_hash: e2.resolved_hash, verdict: 'PASS' }).status, 'REGISTRADO');
  assert.equal(corr.verificar(root, { id }).status, 'VERIFICADA');
  assert.ok(codigos(cierre.cerrar(root, {})).includes('REVALIDACION_PENDIENTE'), 'resolver una corrección invalida lo que dependía de ese código hasta revalidarlo');
  assert.deepEqual(H.revalidarTodo(root), ['B', 'C']);
  const final = corr.listar(root, { estado: 'VERIFIED_RESOLVED' })[0];
  assert.equal(final.reopen_count, 1);
  assert.ok(final.provenance.some((p) => p.reabierta), 'la reapertura conserva su procedencia');
  assert.equal(estadoCampana(root), 'WAITING_FINAL_AUDIT');
  assert.ok(codigos(cierre.cerrar(root, {})).includes('REVISION_FINAL_FALTA:frontend'), 'el código cambió: se concluye de nuevo sobre el sujeto FINAL');
  for (const r of H.revisionFinalPass(root)) assert.equal(r.status, 'REGISTRADO');
  const ok = cierre.cerrar(root, {});
  assert.equal(ok.status, 'CIERRE_SOLICITADO', JSON.stringify(ok));
  assert.equal(ok.final_status, 'COMPLETED');
});

test('[A] revisores: identidad honesta, modalidad declarada, NOT_APPLICABLE justificado, informes coherentes y hash vigente', () => {
  const root = H.proyecto();
  H.campanaVerificada(root);
  assert.equal(rev.registrar(root, { role: 'ux', agent_id: 'a', modality: 'SUBAGENTE' }).status, 'ROL_INVALIDO');
  assert.equal(rev.registrar(root, { role: 'frontend', modality: 'SUBAGENTE' }).status, 'FALTA_AGENT_ID');
  assert.equal(rev.registrar(root, { role: 'frontend', modality: 'SECUENCIAL' }).status, 'FALTA_COBERTURA', 'secuencial declara qué cubre y qué no');
  assert.equal(rev.registrar(root, { role: 'frontend', agent_id: 'ag-1', modality: 'SUBAGENTE' }).status, 'REGISTRADO');
  assert.equal(rev.registrar(root, { role: 'backend', agent_id: 'ag-1', modality: 'SUBAGENTE' }).status, 'IDENTIDAD_COMPARTIDA', 'tres funciones no son tres agentes');
  const sec = rev.registrar(root, { role: 'backend', agent_id: 'director', modality: 'SECUENCIAL', coverage: 'solo API y datos, sin pruebas de carga' });
  assert.equal(sec.degradado, true, 'secuencial queda DEGRADADO, no disfrazado de equipo');
  assert.equal(rev.registrar(root, { role: 'negocio', agent_id: 'ag-3', modality: 'SUBAGENTE', actor: 'revisor:negocio' }).status, 'NO_AUTORIZADO', 'un revisor no se registra a sí mismo');
  assert.equal(rev.registrar(root, { role: 'negocio', agent_id: 'ag-3', modality: 'SUBAGENTE' }).status, 'REGISTRADO');
  const h = hashDe(root, 'A');
  assert.equal(rev.informar(root, { role: 'backend', scope_kind: 'TASK', task_id: 'A', subject_hash: h, verdict: 'NOT_APPLICABLE' }).status, 'NOT_APPLICABLE_SIN_JUSTIFICAR');
  assert.equal(rev.informar(root, { role: 'backend', scope_kind: 'TASK', task_id: 'A', verdict: 'PASS' }).status, 'SIN_HASH');
  assert.equal(rev.informar(root, { role: 'backend', scope_kind: 'TASK', task_id: 'A', subject_hash: h, verdict: 'FAIL' }).status, 'FAIL_SIN_HALLAZGOS', 'un FAIL sin hallazgo accionable es incoherente');
  assert.equal(rev.informar(root, { role: 'backend', scope_kind: 'TASK', task_id: 'A', subject_hash: h, verdict: 'PASS', findings: ['HALLAZGO|src/a.js:1|algo|arreglar|ok'] }).status, 'PASS_CON_HALLAZGOS');
  assert.equal(rev.informar(root, { role: 'backend', scope_kind: 'TASK', task_id: 'A', subject_hash: h, verdict: 'NOT_APPLICABLE', justification: 'la tarea A no toca endpoints ni datos' }).status, 'REGISTRADO');
  assert.equal(corr.listar(root).length, 0, 'ningún informe incoherente dejó hallazgos a medias');
  const e = rev.estadoRevision(root);
  assert.equal(e.por_tarea.find((t) => t.task_id === 'A').roles.backend.verdict, 'NOT_APPLICABLE');
  assert.deepEqual(e.sin_registrar, []);
  assert.deepEqual(e.degradados, ['backend']);
  assert.equal(rev.informar(root, { role: 'frontend', scope_kind: 'TASK', task_id: 'ZZ', subject_hash: h, verdict: 'PASS' }).status, 'TAREA_DESCONOCIDA');
  /* Sin registrar no se acepta el informe (no se inventa identidad). */
  const otro = H.proyecto();
  H.campanaVerificada(otro);
  assert.equal(rev.informar(otro, { role: 'frontend', scope_kind: 'TASK', task_id: 'A', subject_hash: hashDe(otro, 'A'), verdict: 'PASS' }).status, 'REVISOR_NO_REGISTRADO');
  /* Un veredicto emitido sobre un hash que dejó de ser vigente figura como OBSOLETO. */
  fs.writeFileSync(path.join(root, 'src/a.js'), 'module.exports = { cambio: 1 };\n');
  const g = corr.añadir(root, { task_id: 'A', severity: 'HALLAZGO', criterion: 'x', proposal: 'y', acceptance: 'z', location: 'src/a.js:1' });
  const t = corr.tomar(root, { session_id: S, owner_id: 'cursor-1', id: g.id });
  fs.writeFileSync(path.join(root, 'src/a.js'), 'module.exports = { cambio: 2 };\n');
  corr.entregar(root, { session_id: S, id: g.id, owner_id: 'cursor-1', fencing: t.fencing, files: ['src/a.js'] });
  assert.equal(rev.estadoRevision(root).por_tarea.find((x) => x.task_id === 'A').roles.backend.estado, 'OBSOLETO', 'el sujeto cambió: el veredicto sobre el hash anterior ya no es el vigente');
});

test('[A] correcciones: la nota no es tarea, el descarte exige motivo y conserva procedencia, y la prioridad no deja morir lo viejo', () => {
  const root = H.proyecto();
  H.activar(root);
  tm.crearPlan(root, { objective: 'o', sprints: [{ tasks: [H.tarea('A'), H.tarea('B', { risk: 'HIGH' })] }] });
  const nota = corr.añadir(root, { task_id: 'A', severity: 'NOTA', impact: 'el nombre de la variable es confuso', location: 'src/a.js:1', actor: 'revisor:backend', origin: 'revisor:backend' });
  assert.equal(nota.status, 'CREADA');
  assert.equal(nota.finding.actionable, false);
  assert.equal(corr.listar(root, { activas: true }).length, 0, 'una nota no entra en la cola de correcciones');
  assert.equal(corr.publicarCorreccion(root, { id: nota.id }).status, 'NOTA_NO_ACCIONABLE');
  assert.equal(corr.promover(root, { id: nota.id }).status, 'FALTAN_CAMPOS');
  assert.equal(corr.promover(root, { id: nota.id, proposal: 'renombrarla', acceptance: 'el nombre dice qué es' }).status, 'PROMOVIDA');
  assert.equal(corr.publicarCorreccion(root, { id: nota.id }).status, 'PUBLICADA');
  /* Descartar: motivo obligatorio; el duplicado deja su procedencia en el original. */
  const a = corr.añadir(root, { task_id: 'A', severity: 'HALLAZGO', criterion: 'a no valida', proposal: 'validar', acceptance: 'rechaza', location: 'src/a.js:1' });
  const b = corr.añadir(root, { task_id: 'A', severity: 'HALLAZGO', criterion: 'a no valida la entrada nunca', proposal: 'validar', acceptance: 'rechaza', location: 'src/a.js:1', origin: 'revisor:negocio', actor: 'revisor:negocio' });
  assert.equal(b.status, 'CREADA', 'redacción distinta = otra clave: llega como hallazgo propio, OPEN');
  assert.equal(corr.descartar(root, { id: b.id }).status, 'SIN_MOTIVO');
  assert.equal(corr.descartar(root, { id: b.id, razon: 'duplicado de ' + a.id, duplicate_of: a.id }).status, 'DESCARTADA');
  const orig = corr.listar(root).find((x) => x.id === a.id);
  assert.equal(orig.recurrence, 2);
  assert.ok(orig.provenance.some((p) => p.via === b.id), 'la procedencia del descartado vive en el original');
  assert.equal(corr.añadir(root, { task_id: 'A', severity: 'HALLAZGO', criterion: 'a no valida la entrada nunca', proposal: 'validar', acceptance: 'x', location: 'src/a.js:1' }).status, 'YA_DESCARTADO', 'un falso positivo no vuelve a entrar sin forzarlo');
  /* Orden: BLOQUEANTE nunca lo supera lo viejo; entre el resto, la antigüedad evita la inanición. */
  const ahora = Date.now();
  const mk = (o) => Object.assign({ severity: 'HALLAZGO', reopen_count: 0, recurrence: 1, escalated: false, created_at: new Date(ahora).toISOString() }, o);
  const p = (f, riesgo) => corr.prioridad(f, { ahora, riesgo });
  const viejo = mk({ created_at: new Date(ahora - 400 * 3600000).toISOString() });
  assert.ok(p(mk({ severity: 'BLOQUEANTE' }), 'LOW') > p(viejo, 'HIGH'), 'ni 400 horas de antigüedad pasan a un BLOQUEANTE');
  assert.ok(p(viejo, 'LOW') > p(mk({}), 'HIGH'), 'un hallazgo viejo termina pasando a uno nuevo de mayor riesgo: sin inanición');
  assert.ok(p(mk({ reopen_count: 2 }), 'LOW') > p(mk({}), 'LOW'), 'lo reabierto sube');
  assert.ok(p(mk({ recurrence: 4, escalated: true }), 'LOW') > p(mk({}), 'LOW'), 'el origen recurrente escala');
  assert.ok(p(mk({}), 'HIGH') > p(mk({}), 'LOW'), 'a igual antigüedad pesa el riesgo');
  /* Bloqueo por negocio: queda pregunta y alternativas; el constructor no la ve hasta la decisión. */
  const c = corr.añadir(root, { task_id: 'B', severity: 'BLOQUEANTE', criterion: 'el redondeo del total no está definido', proposal: 'redondear', acceptance: 'total con 2 decimales', location: 'src/b.js:1' });
  const bl = corr.bloquear(root, { id: c.id, pregunta: '¿Redondeo hacia arriba o al más cercano?', alternativas: ['arriba', 'más cercano'] });
  assert.equal(bl.status, 'BLOQUEADA_POR_DECISION');
  assert.equal(corr.listar(root, { estado: 'BLOCKED_HUMAN' }).length, 1);
  assert.equal(corr.tomar(root, { session_id: S, owner_id: 'cursor-1', id: c.id }).status, 'TRANSICION_INVALIDA');
  assert.equal(corr.desbloquear(root, { id: c.id }).status, 'DECISION_PENDIENTE');
  assert.match(tm.estado(root).pendientes_dueno.map((x) => x.pregunta).join(' '), /Redondeo hacia arriba/);
});

test('[A][T21] cierre: la cola vacía no basta; un hallazgo en carrera lo reabre; ACK con close_id y revisión; después, sin trabajo nuevo', () => {
  const root = H.proyecto();
  H.campanaVerificada(root);
  conBuilder(root);
  H.revisores(root);
  H.revisionFinalPass(root);
  const c1 = cierre.cerrar(root, {});
  assert.equal(c1.status, 'CIERRE_SOLICITADO');
  assert.equal(cierre.cerrar(root, {}).status, 'CIERRE_YA_SOLICITADO', 'reintentar el cierre no crea otro ni duplica nada');
  assert.equal(tm.asignar(root, { owner_id: 'cursor-1' }).status, 'CIERRE_SOLICITADO', 'Cursor no toma trabajo nuevo con el cierre solicitado');
  assert.equal(md.ronda(root, { rol: 'builder' }).accion, 'CIERRE_ACK');
  assert.equal(cierre.ack(root, { close_id: c1.close_id, revision: c1.revision, session_id: 'ses-otra-sesion', vigilantes: 'apagados' }).status, 'SESION_NO_REGISTRADA');
  assert.equal(cierre.ack(root, { close_id: c1.close_id, revision: c1.revision + 5, session_id: 'ses-cursor-aaaa', vigilantes: 'apagados' }).status, 'REVISION_OBSOLETA');
  assert.equal(cierre.ack(root, { close_id: 'C-nada', revision: 1, session_id: 'ses-cursor-aaaa' }).status, 'CIERRE_DESCONOCIDO');
  assert.equal(cierre.ack(root, { close_id: c1.close_id, revision: c1.revision, session_id: 'ses-cursor-aaaa', actor: 'director' }).status, 'NO_AUTORIZADO');
  /* Hallazgo ENTRE el cierre y el ACK: se reabre, no se descarta. */
  const hallazgo = corr.añadir(root, { task_id: 'B', severity: 'HALLAZGO', criterion: 'b no valida su entrada', proposal: 'validar', acceptance: 'rechaza basura', location: 'src/b.js:1' });
  assert.equal(hallazgo.status, 'CREADA');
  assert.equal(tm.estado(root).cierre.state, 'REOPENED');
  assert.match(tm.estado(root).cierre.reopened_reason, /HALLAZGO_EN_CARRERA/);
  const tarde = cierre.ack(root, { close_id: c1.close_id, revision: c1.revision, session_id: 'ses-cursor-aaaa', vigilantes: 'apagados' });
  assert.equal(tarde.status, 'CIERRE_REABIERTO', 'el ACK de un cierre reabierto se rechaza: el constructor vuelve al trabajo');
  assert.equal(estadoCampana(root), 'EN_CURSO');
  assert.equal(md.ronda(root, { rol: 'builder' }).accion, 'CORRECCION');
  /* Se atiende, se vuelve a concluir sobre el sujeto nuevo y se pide otro cierre. */
  const t = corr.tomar(root, { session_id: S, owner_id: 'cursor-1', id: hallazgo.id });
  fs.writeFileSync(path.join(root, 'src/b.js'), 'module.exports = { v: "B", valida: true };\n');
  assert.equal(corr.entregar(root, { session_id: S, id: hallazgo.id, owner_id: 'cursor-1', fencing: t.fencing, files: ['src/b.js'] }).status, 'IMPLEMENTADA_PENDIENTE_REVISION');
  assert.equal(corr.verificar(root, { id: hallazgo.id }).status, 'VERIFICADA');
  assert.deepEqual(H.revalidarTodo(root), ['C']);
  const rechazado = cierre.cerrar(root, {});
  assert.deepEqual(codigos(rechazado).sort(), ['REVISION_FINAL_OBSOLETA:backend', 'REVISION_FINAL_OBSOLETA:frontend', 'REVISION_FINAL_OBSOLETA:negocio'], 'un resultado viejo no cierra');
  H.revisionFinalPass(root);
  const c2 = cierre.cerrar(root, {});
  assert.equal(c2.status, 'CIERRE_SOLICITADO');
  assert.notEqual(c2.close_id, c1.close_id);
  assert.equal(cierre.ack(root, { close_id: c1.close_id, revision: c1.revision, session_id: 'ses-cursor-aaaa' }).status, 'CIERRE_REABIERTO', 'el cierre viejo sigue muerto');
  const ack = cierre.ack(root, { close_id: c2.close_id, revision: c2.revision, session_id: 'ses-cursor-aaaa', vigilantes: 'apagados', detalle: 'loop cancelado y watch detenido' });
  assert.equal(ack.status, 'CIERRE_ACEPTADO');
  assert.equal(ack.final_status, 'COMPLETED');
  assert.equal(cierre.ack(root, { close_id: c2.close_id, revision: c2.revision, session_id: 'ses-cursor-aaaa' }).duplicado, true);
  assert.equal(estadoCampana(root), 'COMPLETED');
  assert.equal(tm.asignar(root, { owner_id: 'cursor-1' }).status, 'CERRADO');
  assert.equal(cierre.cerrar(root, {}).status, 'CAMPANA_CERRADA');
  const conf = cierre.confirmar(root, { vigilantes: 'apagados' });
  assert.equal(conf.status, 'CIERRE_CONFIRMADO');
  assert.equal(conf.tareas_cerradas, 3);
  assert.deepEqual(tm.estado(root).tareas.map((x) => x.flujo), ['CLOSED', 'CLOSED', 'CLOSED']);
  const sr = tm.estado(root).cierre.stop_report;
  assert.equal(sr.estado, 'STOPPED');
  assert.equal(sr.verificado_por_teams, false, 'TEAMS guarda lo que el constructor DECLARA: no verifica procesos del sistema');
  assert.equal(sr.director.estado, 'STOPPED');
  /* Reapertura posterior = nueva sesión explícita. */
  const re = cierre.reabrirCampana(root, { motivo: 'el dueño pide otra iteración' });
  assert.equal(re.status, 'CAMPANA_REABIERTA');
  assert.equal(re.session_generation, 2);
  assert.equal(tm.estado(root).builder.state, 'CONECTADO', 'el constructor debe reconectar y confirmar READY de nuevo');
});

test('[A] revalidar: una corrección invalida lo que dependía de ese código; solo se limpia con gates PASS sobre el sujeto vigente o con "sin efecto" razonado', () => {
  const root = H.proyecto();
  H.campanaVerificada(root);
  const f = corr.añadir(root, { task_id: 'A', severity: 'HALLAZGO', criterion: 'a no valida', proposal: 'validar', acceptance: 'rechaza', location: 'src/a.js:1' });
  const t = corr.tomar(root, { owner_id: 'cursor-1', id: f.id });
  fs.writeFileSync(path.join(root, 'src/a.js'), 'module.exports = { v: "A", valida: true };\n');
  corr.entregar(root, { id: f.id, owner_id: 'cursor-1', fencing: t.fencing, files: ['src/a.js'] });
  assert.deepEqual(tm.estado(root).tareas.filter((x) => x.revalidar).map((x) => x.id), ['B', 'C'], 'B depende de A y C de B: las dos quedan marcadas');
  assert.equal(tm.revalidar(root, { task_id: 'A' }).status, 'NADA_QUE_REVALIDAR');
  assert.equal(tm.revalidar(root, { task_id: 'B', sin_efecto: '  ' }).status, 'SIN_RAZON', 'sin razón no es "sin efecto"');
  assert.equal(tm.revalidar(root, { task_id: 'B' }).status, 'SIN_EVIDENCIA_SUFICIENTE', 'y sin gates tampoco se limpia');
  const viejo = tm.leerTarea(root, 'B');
  const sujetoVigente = tm.estado(root).tareas.find((x) => x.id === 'B').sujeto_vigente;
  const mk = (sujeto, falla) => tm.gatesRequeridos(viejo).map((gate) => H.fixtureGate(root, {
    gate, status: gate === falla ? 'FAIL' : 'PASS', subject_hash: sujeto, execution_id: 'x-' + gate, evidence: [{ kind: 'fixture', subject_hash: sujeto }],
  }, viejo.allowed_files));
  /* Gates de otro sujeto no sirven; un FAIL no limpia nada; los PASS del sujeto vigente sí. */
  assert.equal(tm.revalidar(root, { task_id: 'B', gates: mk('otro-sujeto') }).status, 'SIN_EVIDENCIA_SUFICIENTE');
  assert.equal(tm.revalidar(root, { task_id: 'B', gates: mk(sujetoVigente, 'relevant-check') }).status, 'REVALIDACION_FALLIDA');
  assert.ok(tm.estado(root).tareas.find((x) => x.id === 'B').revalidar, 'un FAIL no limpia nada');
  assert.equal(tm.revalidar(root, { task_id: 'B', gates: mk(sujetoVigente) }).status, 'REVALIDADA');
  assert.equal(tm.estado(root).tareas.find((x) => x.id === 'B').revalidar, undefined);
  assert.equal(tm.revalidar(root, { task_id: 'C', sin_efecto: 'C solo lee el valor de B, que no cambió' }).status, 'REVALIDADA');
});

test('[A][T21] STOP_FAILED se conserva con su diagnóstico y no se confunde con un apagado correcto', () => {
  const root = H.proyecto();
  H.campanaVerificada(root);
  conBuilder(root);
  H.revisores(root);
  H.revisionFinalPass(root);
  const c = cierre.cerrar(root, {});
  const ack = cierre.ack(root, { close_id: c.close_id, revision: c.revision, session_id: 'ses-cursor-aaaa', vigilantes: 'stop-failed', detalle: 'el watch no respondió al detenerlo; el supervisor sigue vivo' });
  assert.equal(ack.status, 'CIERRE_ACEPTADO');
  assert.equal(ack.vigilantes, 'STOP_FAILED');
  assert.match(ack.nota, /STOP_FAILED conservado/);
  const sr = tm.estado(root).cierre.stop_report;
  assert.equal(sr.estado, 'STOP_FAILED');
  assert.match(sr.detalle, /supervisor sigue vivo/);
  const sinReporte = H.proyecto();
  H.campanaVerificada(sinReporte);
  conBuilder(sinReporte);
  H.revisores(sinReporte);
  H.revisionFinalPass(sinReporte);
  const c2 = cierre.cerrar(sinReporte, {});
  assert.equal(cierre.ack(sinReporte, { close_id: c2.close_id, revision: c2.revision, session_id: 'ses-cursor-aaaa' }).vigilantes, 'NO_REPORTADO', 'sin declaración no se supone apagado');
});

test('[A][T21] COMPLETED_WITH_PENDING: lo bloqueado por el dueño queda pendiente explícito y el reporte dice qué NO se implementó y por qué', () => {
  const root = H.proyecto();
  H.activar(root);
  tm.crearPlan(root, { objective: 'o', sprints: [{ tasks: [H.tarea('A'), H.tarea('B'), H.tarea('C', { depends_on: ['B'] })] }] });
  conBuilder(root);
  H.revisores(root);
  const s = tm.stop(root, { reason_code: 'NEGOCIO_AMBIGUO', scope: 'DEPENDENCY_CHAIN', task_id: 'B', decision_required: true, question: '¿Qué regla de descuento aplica?' });
  const b = H.constructor(root);
  H.paso(root, b);
  H.verificarTarea(root, 'A');
  assert.equal(estadoCampana(root), 'WAITING_FINAL_AUDIT');
  H.revisionFinalPass(root);
  const c = cierre.cerrar(root, {});
  assert.equal(c.status, 'CIERRE_SOLICITADO', JSON.stringify(c));
  assert.equal(c.final_status, 'COMPLETED_WITH_PENDING', 'nunca se mezcla con COMPLETED');
  assert.deepEqual(c.pendientes.map((p) => p.task_id).sort(), ['B', 'C']);
  assert.deepEqual(c.no_hecho.map((p) => p.task_id).sort(), ['B', 'C']);
  assert.match(c.no_hecho[0].motivo, new RegExp(s.id));
  assert.equal(cierre.ack(root, { close_id: c.close_id, revision: c.revision, session_id: 'ses-cursor-aaaa', vigilantes: 'apagados' }).final_status, 'COMPLETED_WITH_PENDING');
  assert.equal(estadoCampana(root), 'COMPLETED_WITH_PENDING');
  assert.equal(cierre.avance(root).porcentaje, 33.3, 'el avance sigue siendo lo medido: 1 de 3');
});

test('[A][T16] verificado ≠ registrado: un registro de memoria pendiente o un job obligatorio abierto impiden el cierre; reintentar no duplica', () => {
  const root = H.proyecto();
  H.activar(root);
  conColaDeMemoria(root);
  tm.crearPlan(root, { objective: 'o', sprints: [{ tasks: [H.tarea('A')] }] });
  conBuilder(root);
  H.revisores(root);
  H.paso(root, H.constructor(root));
  H.verificarTarea(root, 'A');
  H.revisionFinalPass(root);
  assert.deepEqual(codigos(cierre.cerrar(root, {})), ['MEMORIA_PENDIENTE']);
  assert.equal(cierre.marcarMemoria(root, { task_id: 'A', state: 'FAILED', detail: 'el worker de memoria falló' }).status, 'OK');
  assert.deepEqual(codigos(cierre.cerrar(root, {})), ['MEMORIA_PENDIENTE'], 'un fallo del registro obligatorio deja MEMORY_PENDING, no se oculta');
  cierre.marcarMemoria(root, { task_id: 'A', state: 'REGISTERED' });
  const w = dba.openWrite(path.join(root, '.agentic', 'memoria.db'));
  w.run("INSERT INTO mem_jobs (job_id, state, required, created_at, updated_at, next_attempt_at) VALUES ('j1', 'PENDING', 1, ?, ?, ?)", new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
  w.close();
  assert.deepEqual(codigos(cierre.cerrar(root, {})), ['JOBS_OBLIGATORIOS_ABIERTOS']);
  const w2 = dba.openWrite(path.join(root, '.agentic', 'memoria.db'));
  w2.run("UPDATE mem_jobs SET state = 'DONE' WHERE job_id = 'j1'");
  w2.close();
  const c = cierre.cerrar(root, {});
  assert.equal(c.status, 'CIERRE_SOLICITADO');
  assert.equal(cierre.cerrar(root, {}).close_id, c.close_id, 'reintentar no crea otro cierre');
  assert.equal(tm.estado(root).cierre.close_id, c.close_id);
});

test('[A][T20] reinicio de director o constructor: plan, correcciones, revisores, posición suspendida y cierre se reconstruyen de la base en un proceso nuevo', () => {
  const root = H.proyecto();
  H.activar(root);
  tm.crearPlan(root, H.planSecuencial());
  conBuilder(root);
  H.revisores(root);
  const b = H.constructor(root);
  H.paso(root, b);
  const asg = tm.asignar(root, { owner_id: 'cursor-1' });
  tm.ack(root, { delivery_id: asg.assignment.delivery_id, owner_id: 'cursor-1', host_session_id: 'ses-cursor-aaaa' });
  const f = corr.añadir(root, { task_id: 'A', severity: 'BLOQUEANTE', criterion: 'a rompe', proposal: 'arreglar', acceptance: 'no rompe', location: 'src/a.js:1' });
  const t = corr.tomar(root, { session_id: S, owner_id: 'cursor-1', id: f.id, siguiente_paso: 'terminar b.js paso 3' });
  assert.equal(t.status, 'TOMADA');
  rev.informar(root, { role: 'negocio', scope_kind: 'TASK', task_id: 'A', subject_hash: hashDe(root, 'A'), verdict: 'PASS' });
  const aqui = {
    tareas: tm.estado(root).tareas.map((x) => [x.id, x.state, x.flujo]),
    correcciones: corr.listar(root, { activas: true }).map((x) => [x.id, x.state, x.owner_id, x.fencing]),
    suspendidas: corr.suspendidas(root),
    revisores: Object.keys(rev.estadoRevision(root).revisores).map((r) => rev.estadoRevision(root).revisores[r].modality),
    ronda: md.ronda(root, { rol: 'builder' }).accion,
    revision: rev.estadoRevision(root).por_tarea.map((x) => [x.task_id, x.roles.negocio.verdict || x.roles.negocio.estado]),
  };
  const G = JSON.stringify(H.G);
  const nuevo = H.enProcesoNuevo(root, `
    const tm = require(${G} + '/teams-manager.cjs'), corr = require(${G} + '/teams-correcciones.cjs'), rev = require(${G} + '/teams-revision.cjs'), md = require(${G} + '/teams-md-session.cjs');
    const r = rev.estadoRevision(process.cwd());
    console.log(JSON.stringify({
      tareas: tm.estado(process.cwd()).tareas.map((x) => [x.id, x.state, x.flujo]),
      correcciones: corr.listar(process.cwd(), { activas: true }).map((x) => [x.id, x.state, x.owner_id, x.fencing]),
      suspendidas: corr.suspendidas(process.cwd()),
      revisores: Object.keys(r.revisores).map((k) => r.revisores[k].modality),
      ronda: md.ronda(process.cwd(), { rol: 'builder' }).accion,
      revision: r.por_tarea.map((x) => [x.task_id, x.roles.negocio.verdict || x.roles.negocio.estado]),
    }));`);
  assert.deepEqual(nuevo, aqui, 'un proceso nuevo ve exactamente lo mismo');
  assert.equal(nuevo.suspendidas[0].siguiente_paso, 'terminar b.js paso 3', 'la posición de la tarea suspendida sobrevive al reinicio');
  assert.equal(nuevo.correcciones[0][3], t.fencing, 'y el fencing de la corrección en curso');
});

test('[B] campaña fixture completa: ejecutar con verificador real, constructor simulado, hallazgo tardío, cierre, ACK y confirmación', () => {
  const root = H.proyecto();
  H.activar(root);
  assert.equal(tm.crearPlan(root, H.planSecuencial()).status, 'PLAN_GUARDADO');
  assert.equal(conBuilder(root).status, 'BUILDER_READY');
  H.revisores(root);
  /* Comprobadores de laboratorio para lo que TEAMS no puede comprobar solo (preservation, test-integrity); el resto es real. */
  const ver = verificadorReal(root, { extra: { preservation: () => ({ status: 'PASS', assertions: 1 }), 'test-integrity': () => ({ status: 'PASS', assertions: 1 }) } });
  const b = H.constructor(root);
  const corridas = [];
  for (let i = 0; i < 3; i++) corridas.push(bld.ejecutar(root, { adapters: b, verificador: ver }));
  assert.ok(corridas.every((r) => r.status === 'EJECUTANDO' && r.run_id === corridas[0].run_id));
  assert.deepEqual(['A', 'B', 'C'].map((id) => tm.leerTarea(root, id).state), ['DONE_VERIFIED', 'DONE_VERIFIED', 'DONE_VERIFIED'], 'verificadas por gates reales con su recibo de ejecución');
  assert.equal(estadoCampana(root), 'WAITING_FINAL_AUDIT');
  assert.equal(cierre.cerrar(root, {}).status, 'CIERRE_RECHAZADO');
  /* El backend revisa y encuentra algo tarde. */
  const hB = hashDe(root, 'B');
  const inf = rev.informar(root, { role: 'backend', scope_kind: 'TASK', task_id: 'B', subject_hash: hB, verdict: 'FAIL', findings: ['BLOQUEANTE|src/b.js:1|b devuelve un dato interno|quitar el campo|b ya no lo devuelve'] });
  assert.equal(inf.status, 'REGISTRADO');
  assert.equal(corr.publicarCorreccion(root, { id: inf.hallazgos[0].id, proposal: 'quitar el campo interno del resultado' }).status, 'PUBLICADA');
  assert.equal(md.ronda(root, { rol: 'builder' }).accion, 'CORRECCION');
  const t = corr.tomar(root, { session_id: S, owner_id: 'cursor-1', id: inf.hallazgos[0].id });
  fs.writeFileSync(path.join(root, 'src/b.js'), 'module.exports = { v: "B", publico: true };\n');
  const e = corr.entregar(root, { session_id: S, id: inf.hallazgos[0].id, owner_id: 'cursor-1', fencing: t.fencing, files: ['src/b.js'] });
  assert.equal(e.status, 'IMPLEMENTADA_PENDIENTE_REVISION');
  assert.equal(rev.informar(root, { role: 'backend', scope_kind: 'FINDING', finding_id: inf.hallazgos[0].id, task_id: 'B', subject_hash: e.resolved_hash, verdict: 'PASS' }).status, 'REGISTRADO');
  assert.equal(corr.verificar(root, { id: inf.hallazgos[0].id }).status, 'VERIFICADA');
  assert.deepEqual(H.revalidarTodo(root), ['C']);
  const rc = bld.ejecutar(root, { adapters: b, verificador: ver });
  assert.equal(rc.pasos[0].status, 'SIN_TRABAJO', 'sin tareas nuevas: el pase no inventa trabajo');
  for (const r of H.revisionFinalPass(root)) assert.equal(r.status, 'REGISTRADO');
  const c = cierre.cerrar(root, {});
  assert.equal(c.status, 'CIERRE_SOLICITADO', JSON.stringify(c));
  const ack = cierre.ack(root, { close_id: c.close_id, revision: c.revision, session_id: 'ses-cursor-aaaa', vigilantes: 'apagados' });
  assert.equal(ack.status, 'CIERRE_ACEPTADO');
  assert.equal(cierre.confirmar(root, { vigilantes: 'apagados' }).status, 'CIERRE_CONFIRMADO');
  assert.equal(estadoCampana(root), 'COMPLETED');
  assert.equal(cierre.avance(root).porcentaje, 100);
});

test('[A] la sesión del constructor no ejerce operaciones del director aunque diga serlo: candado de sesión sobre verificar, descartar, publicar, cerrar y revisión', () => {
  const root = H.proyecto();
  H.campanaVerificada(root);
  conBuilder(root);
  H.revisores(root);
  const f = corr.añadir(root, { task_id: 'A', severity: 'HALLAZGO', criterion: 'a no valida', proposal: 'validar', acceptance: 'rechaza', location: 'src/a.js:1' });
  const t = corr.tomar(root, { session_id: S, id: f.id });
  fs.writeFileSync(path.join(root, 'src/a.js'), 'module.exports = { v: "A", valida: true };\n');
  corr.entregar(root, { session_id: S, id: f.id, files: ['src/a.js'] });
  const rechazos = [
    corr.verificar(root, { id: f.id, session_id: S }),
    corr.descartar(root, { id: f.id, razon: 'x', session_id: S }),
    corr.reabrir(root, { id: f.id, razon: 'x', session_id: S }),
    corr.publicarCorreccion(root, { id: f.id, session_id: S }),
    rev.registrar(root, { role: 'frontend', agent_id: 'ag-x', modality: 'SUBAGENTE', sesion_llamante: S }),
    rev.informar(root, { role: 'frontend', scope_kind: 'FINAL', subject_hash: 'h', verdict: 'PASS', sesion_llamante: S }),
    rev.consumir(root, { sesion_llamante: S }),
    cierre.cerrar(root, { sesion_llamante: S }),
    cierre.confirmar(root, { sesion_llamante: S }),
    cierre.reabrirCampana(root, { motivo: 'x', sesion_llamante: S }),
  ];
  assert.ok(rechazos.every((r) => r.status === 'NO_AUTORIZADO'), JSON.stringify(rechazos.map((r) => r.status)));
  assert.equal(corr.listar(root, { estado: 'IMPLEMENTED_PENDING_REVIEW' }).length, 1, 'nada cambió');
  assert.equal(corr.verificar(root, { id: f.id, session_id: 'ses-del-director' }).status, 'VERIFICADA', 'otra sesión (la del director) sí puede');
  assert.equal(t.status, 'TOMADA');
});
