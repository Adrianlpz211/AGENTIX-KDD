'use strict';

/**
 * TEAMS v2 — avance sin esperar auditoría, correcciones prioritarias, suspensión segura, fencing y avance medido
 * (T04, T05, T10, T12, T17 y estados de flujo). Nivel A (mecanismo) salvo donde se marca B (campaña fixture con adapters simulados).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/teams-v2.cjs');
const { tm, corr, cierre, ad } = H;

const leer = (root, f) => fs.readFileSync(path.join(root, f), 'utf8');
const estadoDe = (root, id) => tm.leerTarea(root, id).state;
const flujoDe = (root, id) => tm.estado(root).tareas.find((t) => t.id === id).flujo;

/** Deja A y B entregadas (VERIFYING) y C en curso (RUNNING), todo sin un solo veredicto de revisor ni verificación del director. */
function adelantado(root) {
  H.activar(root);
  assert.equal(tm.crearPlan(root, H.planSecuencial()).status, 'PLAN_GUARDADO');
  const b = H.constructor(root);
  H.paso(root, b); // A entregada
  H.paso(root, b); // B entregada
  /* C: asignar y ack, pero el constructor "sigue trabajando" (no entrega todavía). */
  const asg = tm.asignar(root, { owner_id: 'cursor-1' });
  assert.equal(asg.status, 'ASIGNADA');
  assert.equal(asg.assignment.task.id, 'C');
  const a = tm.ack(root, { delivery_id: asg.assignment.delivery_id, owner_id: 'cursor-1', host_session_id: 'ses-1' });
  assert.equal(a.status, 'ACKED');
  return b;
}

test('[A][T04] Sprint1 F1 → F2 → Sprint2 F1: el constructor avanza sin esperar la auditoría; la verificación y los revisores van por detrás', () => {
  const root = H.proyecto();
  H.activar(root);
  tm.crearPlan(root, H.planSecuencial());
  const b = H.constructor(root);
  const l1 = H.paso(root, b);
  assert.equal(l1.find((x) => x.paso === 'resultado').status, 'VERIFICANDO');
  assert.equal(estadoDe(root, 'A'), 'VERIFYING');
  assert.equal(estadoDe(root, 'B'), 'READY', 'entregada con comprobaciones básicas habilita lo siguiente sin esperar al director');
  const l2 = H.paso(root, b);
  assert.equal(l2.find((x) => x.paso === 'asignar').task_id, 'B');
  const l3 = H.paso(root, b);
  assert.equal(l3.find((x) => x.paso === 'asignar').task_id, 'C', 'Sprint 2 Fase 1 arranca con A y B aún sin verificar ni auditar');
  assert.deepEqual(['A', 'B', 'C'].map((id) => estadoDe(root, id)), ['VERIFYING', 'VERIFYING', 'VERIFYING']);
  const e = tm.estado(root);
  assert.equal(e.campana.estado, 'EN_CURSO');
  assert.equal(e.avance.porcentaje, 0, 'nada verificado todavía: el avance medido no se infla por haber construido');
  assert.ok(e.tareas.every((t) => t.flujo === 'AUDIT_PENDING'), 'construido y en revisión son estados distintos de verificado: ' + JSON.stringify(e.tareas.map((t) => t.flujo)));
  /* Cerrarlas sí exige verificar en orden: una tarea no se cierra sobre una dependencia sin verificar. */
  const adelantada = tm.verificar(root, { task_id: 'B', event_id: 'v-b-1', gates: H.gatesPass(root, 'B') });
  assert.equal(adelantada.status, 'ESPERA_DEPENDENCIAS');
  assert.deepEqual(adelantada.faltan, ['A']);
  assert.equal(H.verificarTarea(root, 'A').status, 'DONE_VERIFIED');
  const espera = H.paso(root, b, (res) => H.gatesPass(root, res.task_id));
  const enEspera = espera.find((x) => x.paso === 'verificar-en-espera');
  assert.equal(enEspera.task_id, 'B');
  assert.equal(enEspera.status, 'DONE_VERIFIED', 'la entrega que esperaba a su dependencia se verifica sola cuando esta cierra');
});

test('[A][T04] una dependencia realmente sin satisfacer bloquea su rama; sin comprobaciones o con riesgo HIGH nadie avanza por entrega', () => {
  const root = H.proyecto();
  H.activar(root);
  tm.crearPlan(root, { objective: 'o', sprints: [{ tasks: [
    H.tarea('A'), H.tarea('B', { depends_on: ['A'] }),
    H.tarea('C'), H.tarea('D', { depends_on: ['C'] }),
    H.tarea('X', { risk: 'HIGH' }), H.tarea('Y', { depends_on: ['X'] }),
  ] }] });
  /* A entrega SIN comprobaciones básicas: no habilita a B y sigue ocupando al constructor (comportamiento previo). */
  const sinChecks = H.constructor(root, { comprobaciones: [] });
  H.paso(root, sinChecks);
  assert.equal(estadoDe(root, 'A'), 'VERIFYING');
  assert.equal(estadoDe(root, 'B'), 'PENDING', 'sin comprobaciones básicas la entrega no habilita nada');
  assert.equal(tm.asignar(root, { owner_id: 'cursor-1' }).status, 'OCUPADO');
  H.verificarTarea(root, 'A');
  assert.equal(estadoDe(root, 'B'), 'READY', 'verificada, sí');
  /* Con un FAIL reportado tampoco. */
  const conFallo = H.constructor(root, { owner_id: 'cursor-2', comprobaciones: ['tests=FAIL'] });
  const asg = tm.asignar(root, { owner_id: 'cursor-2' });
  assert.equal(asg.assignment.task.id, 'B', 'B es lo siguiente por orden');
  tm.ack(root, { delivery_id: asg.assignment.delivery_id, owner_id: 'cursor-2' });
  conFallo.actual = asg.assignment; conFallo.trabajar(tm.leerTarea(root, 'B').revision);
  for (const r of conFallo.readProgress()) tm.entregarResultado(root, r);
  assert.equal(estadoDe(root, 'B'), 'VERIFYING');
  /* C entrega con checks pero D se habilita; X (HIGH) conserva el cierre síncrono: Y no arranca por entrega. */
  const b = H.constructor(root, { owner_id: 'cursor-3' });
  const l = H.paso(root, b);
  assert.equal(l.find((x) => x.paso === 'asignar').task_id, 'C');
  assert.equal(estadoDe(root, 'D'), 'READY');
  const asgX = tm.asignar(root, { owner_id: 'cursor-3' });
  assert.equal(asgX.assignment.task.id, 'D', 'por orden va D antes que X');
  tm.ack(root, { delivery_id: asgX.assignment.delivery_id, owner_id: 'cursor-3' });
  const bx = H.constructor(root, { owner_id: 'cursor-4' });
  const x = tm.asignar(root, { owner_id: 'cursor-4' });
  assert.equal(x.assignment.task.id, 'X');
  tm.ack(root, { delivery_id: x.assignment.delivery_id, owner_id: 'cursor-4' });
  bx.actual = x.assignment; bx.trabajar(tm.leerTarea(root, 'X').revision);
  for (const r of bx.readProgress()) tm.entregarResultado(root, r);
  assert.equal(estadoDe(root, 'X'), 'VERIFYING');
  assert.equal(estadoDe(root, 'Y'), 'PENDING', 'una tarea HIGH (auth/migración/seguridad) no relaja su cierre por velocidad');
});

test('[A][T05] corrección tardía: se prioriza (BLOQUEANTE primero), suspende la tarea en curso de forma segura y la reanuda en la posición exacta', () => {
  const root = H.proyecto();
  adelantado(root);
  const f1 = corr.añadir(root, { task_id: 'A', severity: 'HALLAZGO', criterion: 'a no valida el valor', proposal: 'validar v >= 0', acceptance: 'a rechaza v < 0', location: 'src/a.js:1' });
  const f2 = corr.añadir(root, { task_id: 'B', severity: 'BLOQUEANTE', criterion: 'b expone un dato interno', proposal: 'quitar el campo', acceptance: 'b ya no lo devuelve', location: 'src/b.js:1' });
  assert.equal(f1.status, 'CREADA');
  assert.equal(f1.state, 'ASSIGNED');
  assert.equal(corr.siguiente(root).id, f2.id, 'BLOQUEANTE antes que HALLAZGO aunque llegó después');
  assert.equal(flujoDe(root, 'A'), 'CORRECTION_PENDING');
  assert.equal(tm.estado(root).tareas.find((t) => t.id === 'C').revalidar.length, 1, 'un bloqueante marca lo que ya empezó sobre esa entrega (C se apoya en B)');
  assert.equal(estadoDe(root, 'C'), 'RUNNING', 'la tarea principal sigue en curso: la corrección no la cancela');
  assert.equal(require(path.join(H.G, 'teams-md-session.cjs')).ronda(root, { rol: 'builder' }).accion, 'CORRECCION', 'en cada despertar, correcciones primero');
  /* Suspensión segura: exige decir en qué paso quedó la tarea principal. */
  const sinPaso = corr.tomar(root, { owner_id: 'cursor-1' });
  assert.equal(sinPaso.status, 'FALTA_SIGUIENTE_PASO');
  assert.equal(corr.listar(root, { estado: 'IN_PROGRESS' }).length, 0, 'sin posición guardada no se toma nada');
  const antesC = leer(root, 'src/c.js');
  const t1 = corr.tomar(root, { owner_id: 'cursor-1', siguiente_paso: 'escribir la función total() de c.js y su test' });
  assert.equal(t1.status, 'TOMADA');
  assert.equal(t1.finding.id, f2.id);
  assert.deepEqual([t1.suspension.task_id, t1.suspension.phase, t1.suspension.siguiente_paso], ['C', 'F1', 'escribir la función total() de c.js y su test']);
  assert.equal(corr.suspendidas(root).length, 1);
  assert.equal(tm.estado(root).tareas.find((x) => x.id === 'C').flujo, 'BUILDER_RUNNING');
  /* El constructor corrige b.js dentro del scope y entrega; NO puede cerrarla él mismo. */
  fs.writeFileSync(path.join(root, 'src/b.js'), 'module.exports = { v: "B", seguro: true };\n');
  const e1 = corr.entregar(root, { id: f2.id, owner_id: 'cursor-1', fencing: t1.fencing, files: ['src/b.js'] });
  assert.equal(e1.status, 'IMPLEMENTADA_PENDIENTE_REVISION');
  assert.equal(corr.verificar(root, { id: f2.id, actor: 'builder' }).status, 'NO_AUTORIZADO', 'Cursor no se autoasigna VERIFIED_RESOLVED');
  assert.equal(corr.descartar(root, { id: f1.id, razon: 'x', actor: 'builder' }).status, 'NO_AUTORIZADO');
  /* Segunda corrección seguida: reutiliza la suspensión original (no la pisa) y toca un archivo de la tarea suspendida. */
  const f3 = corr.añadir(root, { task_id: 'A', severity: 'HALLAZGO', criterion: 'c comparte un helper roto', proposal: 'arreglar el helper', acceptance: 'el helper valida', location: 'src/c.js:1', scope: ['src/c.js'] });
  const t2 = corr.tomar(root, { owner_id: 'cursor-1', id: f1.id });
  assert.equal(t2.status, 'TOMADA');
  assert.equal(t2.suspension.ya_suspendida, true);
  assert.equal(t2.suspension.siguiente_paso, 'escribir la función total() de c.js y su test', 'la posición original sobrevive a varias correcciones');
  assert.equal(corr.reanudar(root, { owner_id: 'cursor-1' }).status, 'CORRECCION_EN_CURSO', 'mientras haya una corrección en curso no se reanuda la tarea principal');
  fs.writeFileSync(path.join(root, 'src/a.js'), 'module.exports = { v: "A", valida: true };\n');
  assert.equal(corr.entregar(root, { id: f1.id, owner_id: 'cursor-1', fencing: t2.fencing, files: ['src/a.js'] }).status, 'IMPLEMENTADA_PENDIENTE_REVISION');
  const t3 = corr.tomar(root, { owner_id: 'cursor-1', id: f3.id });
  fs.writeFileSync(path.join(root, 'src/c.js'), antesC + '// helper corregido\n');
  assert.equal(corr.entregar(root, { id: f3.id, owner_id: 'cursor-1', fencing: t3.fencing, files: ['src/c.js'] }).status, 'IMPLEMENTADA_PENDIENTE_REVISION');
  const r = corr.reanudar(root, { owner_id: 'cursor-1' });
  assert.equal(r.status, 'REANUDADA');
  assert.equal(r.task_id, 'C');
  assert.equal(r.siguiente_paso, 'escribir la función total() de c.js y su test', 'retoma exactamente donde iba');
  assert.equal(r.phase, 'F1');
  assert.deepEqual(r.archivos.filter((x) => x.cambiado).map((x) => x.file), ['src/c.js'], 'recalcula el hash de sus archivos y detecta el que la corrección tocó');
  assert.deepEqual(r.pruebas_afectadas, ['relevant-check', 'affected-tests']);
  assert.ok(tm.estado(root).tareas.find((x) => x.id === 'C').revalidar.some((m) => m.startsWith('CORRECCION_TOCO_ARCHIVOS')), 'queda marcada para rehacer su verificación');
  assert.equal(corr.suspendidas(root).length, 0);
  assert.equal(require(path.join(H.G, 'teams-md-session.cjs')).ronda(root, { rol: 'builder' }).accion, 'CONTINUAR_TAREA');
  /* El director verifica: sin revisor de origen basta su verificación; el constructor ya no la vio como pendiente. */
  assert.equal(corr.verificar(root, { id: f2.id }).status, 'VERIFICADA');
  assert.equal(corr.listar(root, { activas: true }).some((f) => f.id === f2.id), false);
});

test('[A][T05] línea movida: la corrección se reubica por símbolo o contenido; si no aparece no se parchea sobre una línea obsoleta', () => {
  const root = H.proyecto();
  H.activar(root);
  tm.crearPlan(root, { objective: 'o', sprints: [{ tasks: [H.tarea('A')] }] });
  fs.writeFileSync(path.join(root, 'src/a.js'), 'const x = 1;\nfunction calcular(v) {\n  return v + 1;\n}\nmodule.exports = { calcular };\n');
  const f = corr.añadir(root, { task_id: 'A', severity: 'HALLAZGO', criterion: 'calcular no valida', proposal: 'validar v', acceptance: 'calcular(-1) lanza', location: { file: 'src/a.js', line: 2, symbol: 'calcular' } });
  assert.equal(f.status, 'CREADA');
  fs.writeFileSync(path.join(root, 'src/a.js'), '// cabecera\n// otra\n// y otra\nconst x = 1;\nfunction calcular(v) {\n  return v + 1;\n}\nmodule.exports = { calcular };\n');
  const rb = corr.reubicar(root, { id: f.id });
  assert.equal(rb.status, 'REUBICADO');
  assert.equal(rb.line, 5);
  assert.equal(rb.desplazamiento, 3);
  const t = corr.tomar(root, { owner_id: 'cursor-1', id: f.id });
  assert.equal(t.status, 'TOMADA');
  assert.equal(t.reubicacion.status, 'REUBICADO');
  assert.equal(t.finding.location.line, 5, 'la ubicación guardada se actualiza con la nueva posición');
  assert.equal(t.finding.location.relocated_from, 2);
  /* Observación sin símbolo y con contenido desaparecido: no hay dónde parchear. */
  const g = corr.añadir(root, { task_id: 'A', severity: 'HALLAZGO', criterion: 'línea rara', proposal: 'cambiarla', acceptance: 'ya no existe', location: { file: 'src/a.js', line: 4 } });
  fs.writeFileSync(path.join(root, 'src/a.js'), 'module.exports = {};\n');
  const rg = corr.tomar(root, { owner_id: 'cursor-1', id: g.id });
  assert.equal(rg.status, 'HASH_OBSOLETO_SIN_REUBICAR');
  assert.equal(corr.listar(root, { estado: 'ASSIGNED' }).some((x) => x.id === g.id), true, 'sigue en la cola, esperando que el director la vuelva a revisar');
});

test('[A][T10] duplicado, coalescing y desorden: no se pierde una corrección ni se repite una ejecución', () => {
  const root = H.proyecto();
  adelantado(root);
  const base = { task_id: 'A', severity: 'HALLAZGO', criterion: 'a no valida el valor', proposal: 'validar', acceptance: 'rechaza negativos', location: 'src/a.js:1' };
  const uno = corr.añadir(root, Object.assign({ event_id: 'ev-fn-1' }, base));
  const mismoEvento = corr.añadir(root, Object.assign({ event_id: 'ev-fn-1' }, base));
  assert.equal(mismoEvento.status, 'DUPLICADO');
  assert.equal(mismoEvento.id, uno.id, 'el mismo evento no crea otra corrección');
  const otraVoz = corr.añadir(root, Object.assign({}, base, { origin: 'revisor:backend', actor: 'revisor:backend' }));
  assert.equal(otraVoz.status, 'DUPLICADO_AGRUPADO');
  assert.equal(otraVoz.id, uno.id, 'el mismo problema visto por otro revisor se agrupa');
  assert.equal(otraVoz.recurrence, 2);
  const tercera = corr.añadir(root, Object.assign({}, base, { severity: 'BLOQUEANTE', origin: 'revisor:negocio', actor: 'revisor:negocio' }));
  assert.equal(tercera.recurrence, 3);
  assert.equal(tercera.escalated, true, 'el origen recurrente escala');
  const unica = corr.listar(root, { task_id: 'A' });
  assert.equal(unica.length, 1);
  assert.equal(unica[0].severity, 'BLOQUEANTE', 'agrupar sube a la severidad más alta');
  assert.deepEqual(unica[0].provenance.map((p) => p.origen), ['director', 'revisor:backend', 'revisor:negocio'], 'se conserva quién lo vio');
  /* Fuera de orden: verificar o entregar antes de tomar no avanza nada y no pierde la corrección. */
  assert.equal(corr.verificar(root, { id: uno.id }).status, 'TRANSICION_INVALIDA');
  assert.equal(corr.entregar(root, { id: uno.id, owner_id: 'cursor-1', fencing: 1 }).status, 'TRANSICION_INVALIDA');
  assert.equal(corr.listar(root, { estado: 'ASSIGNED' }).length, 1);
  const t = corr.tomar(root, { owner_id: 'cursor-1', siguiente_paso: 'seguir con c.js' });
  assert.equal(corr.tomar(root, { owner_id: 'cursor-1', id: uno.id }).duplicado, true, 'tomar dos veces es idempotente');
  fs.writeFileSync(path.join(root, 'src/a.js'), 'module.exports = { v: "A", ok: 1 };\n');
  const e1 = corr.entregar(root, { id: uno.id, owner_id: 'cursor-1', fencing: t.fencing, files: ['src/a.js'], event_id: 'ev-ent-1' });
  const e2 = corr.entregar(root, { id: uno.id, owner_id: 'cursor-1', fencing: t.fencing, files: ['src/a.js'], event_id: 'ev-ent-1' });
  assert.equal(e1.status, 'IMPLEMENTADA_PENDIENTE_REVISION');
  assert.equal(e2.duplicado, true, 'el mismo mensaje repetido no repite la transición');
  assert.equal(corr.listar(root, { estado: 'IMPLEMENTED_PENDING_REVIEW' }).length, 1);
  assert.equal(corr.verificar(root, { id: uno.id, expected_revision: 1 }).status, 'REVISION_OBSOLETA', 'un mensaje con revisión vieja se rechaza');
  /* Reaparece sobre la versión ya entregada: se reabre (no se pierde) y sube prioridad. */
  const hashViejo = corr.listar(root, { task_id: 'A' })[0].reviewed_hash;
  const re = corr.reabrir(root, { id: uno.id, razon: 'el negativo -1 aún pasa', evidencia: 'caso -1' });
  assert.equal(re.status, 'REABIERTA');
  assert.equal(re.reopen_count, 1);
  assert.notEqual(hashViejo, null);
  assert.equal(corr.siguiente(root).id, uno.id);
});

test('[A][T12] lease y fencing viejos: un constructor reemplazado no escribe sin revalidar; el token nuevo manda', () => {
  const root = H.proyecto();
  H.activar(root);
  tm.crearPlan(root, { objective: 'o', sprints: [{ tasks: [H.tarea('A')] }] });
  const f = corr.añadir(root, { task_id: 'A', severity: 'HALLAZGO', criterion: 'a no valida', proposal: 'validar', acceptance: 'rechaza', location: 'src/a.js:1' });
  const t0 = 1_000_000;
  const viejo = corr.tomar(root, { owner_id: 'cursor-viejo', id: f.id, ahora: t0 });
  assert.equal(viejo.status, 'TOMADA');
  const lim = tm.LIMITES_DEFECTO.lease_ms;
  /* El constructor viejo murió: su lease vence y la corrección vuelve a la cola para otra sesión, con otro fencing. */
  const nuevo = corr.tomar(root, { owner_id: 'cursor-nuevo', id: f.id, ahora: t0 + lim + 1000 });
  assert.equal(nuevo.status, 'TOMADA');
  assert.ok(nuevo.fencing > viejo.fencing, 'cada toma trae un token de fencing mayor');
  fs.writeFileSync(path.join(root, 'src/a.js'), 'module.exports = { escrito_por: "viejo" };\n');
  const rechazo = corr.entregar(root, { id: f.id, owner_id: 'cursor-viejo', fencing: viejo.fencing, files: ['src/a.js'], ahora: t0 + lim + 2000 });
  assert.equal(rechazo.status, 'RECHAZADO_LEASE_DE_OTRO', 'el dueño viejo no entrega');
  const mismoDueñoViejoToken = corr.entregar(root, { id: f.id, owner_id: 'cursor-nuevo', fencing: viejo.fencing, files: ['src/a.js'], ahora: t0 + lim + 2000 });
  assert.equal(mismoDueñoViejoToken.status, 'RECHAZADO_FENCING_OBSOLETO', 'ni con otro dueño y el token anterior');
  assert.equal(corr.listar(root, { estado: 'IN_PROGRESS' })[0].owner_id, 'cursor-nuevo');
  /* Lease vencido sin relevo: tampoco entrega a ciegas. */
  const vencido = corr.entregar(root, { id: f.id, owner_id: 'cursor-nuevo', fencing: nuevo.fencing, files: ['src/a.js'], ahora: t0 + 3 * lim });
  assert.equal(vencido.status, 'RECHAZADO_LEASE_VENCIDO');
  assert.equal(corr.latido(root, { id: f.id, owner_id: 'cursor-viejo', fencing: viejo.fencing }).status, 'FENCING_OBSOLETO', 'el latido de un token viejo no renueva nada');
  /* Hash viejo: el sujeto cambió desde la revisión y la observación no se encuentra → revalidar, no escribir. */
  const g = corr.añadir(root, { task_id: 'A', severity: 'HALLAZGO', criterion: 'línea inexistente', proposal: 'cambiar', acceptance: 'ok', location: { file: 'src/a.js', line: 9, snippet: 'esta línea ya no existe' } });
  fs.writeFileSync(path.join(root, 'src/a.js'), 'module.exports = { otra: "cosa" };\n');
  assert.equal(corr.tomar(root, { owner_id: 'cursor-nuevo', id: g.id }).status, 'HASH_OBSOLETO_SIN_REUBICAR');
});

test('[A] estados de flujo separados: construido, en revisión, con corrección, verificado, registro de memoria pendiente y cerrado', () => {
  const root = H.proyecto();
  H.activar(root);
  /* Una base con cola de memoria 3.20.1 (mínima) hace que verificado ≠ registrado. */
  const w = require(path.join(H.G, 'db-adapter.cjs')).openWrite(path.join(root, '.agentic', 'memoria.db'));
  w.exec("CREATE TABLE mem_jobs (job_id TEXT PRIMARY KEY, state TEXT, attempts INTEGER DEFAULT 0, max_attempts INTEGER DEFAULT 5, required INTEGER DEFAULT 0, lease_until TEXT, error_code TEXT, manual_retries INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT, next_attempt_at TEXT)");
  w.close();
  tm.crearPlan(root, { objective: 'o', sprints: [{ tasks: [H.tarea('A')] }] });
  const asg = tm.asignar(root, { owner_id: 'cursor-1' });
  assert.equal(tm.estado(root).tareas[0].flujo, null, 'asignada y sin ACK no es BUILDER_RUNNING todavía');
  tm.ack(root, { delivery_id: asg.assignment.delivery_id, owner_id: 'cursor-1' });
  assert.equal(flujoDe(root, 'A'), 'BUILDER_RUNNING');
  const b = H.constructor(root);
  b.actual = asg.assignment; b.trabajar(tm.leerTarea(root, 'A').revision);
  for (const r of b.readProgress()) tm.entregarResultado(root, r);
  assert.equal(flujoDe(root, 'A'), 'AUDIT_PENDING', 'entregada y sin veredictos de revisores');
  const s = corr.añadir(root, { task_id: 'A', severity: 'HALLAZGO', criterion: 'falla algo', proposal: 'arreglarlo', acceptance: 'ya no falla', location: 'src/a.js:1' });
  assert.equal(flujoDe(root, 'A'), 'CORRECTION_PENDING', 'una corrección abierta manda sobre lo demás');
  corr.descartar(root, { id: s.id, razon: 'falso positivo de prueba' });
  assert.equal(H.verificarTarea(root, 'A').status, 'DONE_VERIFIED');
  assert.equal(flujoDe(root, 'A'), 'MEMORY_PENDING', 'verificado por el director pero sin registro de memoria: otro estado');
  assert.equal(tm.estado(root).tareas[0].memory_state, 'PENDING');
  assert.equal(cierre.marcarMemoria(root, { task_id: 'A', state: 'REGISTERED' }).status, 'OK');
  assert.equal(flujoDe(root, 'A'), 'DIRECTOR_VERIFIED');
  assert.equal(cierre.marcarMemoria(root, { task_id: 'A', state: 'NO_LEARNING', detail: 'cambio mecánico sin aprendizaje' }).status, 'OK', 'sin aprendizaje nuevo es un resultado legítimo');
  assert.equal(cierre.marcarMemoria(root, { task_id: 'ZZ', state: 'REGISTERED' }).status, 'TAREA_DESCONOCIDA');
  assert.equal(cierre.marcarMemoria(root, { task_id: 'A', state: 'INVENTADO' }).status, 'ESTADO_INVALIDO');
});

test('[A][T17] la negocio pendiente bloquea solo su rama: el trabajo independiente sigue y el avance se mide del plan, no se inventa', () => {
  const root = H.proyecto();
  H.activar(root);
  tm.crearPlan(root, { objective: 'o', sprints: [{ tasks: [H.tarea('A'), H.tarea('B', { depends_on: ['A'] }), H.tarea('C'), H.tarea('D', { depends_on: ['C'] })] }] });
  assert.equal(cierre.avance(root).porcentaje, 0);
  assert.equal(tm.estado(root).avance.total, 4);
  /* La decisión de negocio sobre C es del dueño: queda la pregunta y las alternativas. */
  const s = tm.stop(root, { reason_code: 'NEGOCIO_AMBIGUO', scope: 'DEPENDENCY_CHAIN', task_id: 'C', decision_required: true, question: '¿El descuento aplica antes o después del impuesto? Alternativas: antes | después' });
  assert.deepEqual(s.afectadas.sort(), ['C', 'D']);
  const b = H.constructor(root);
  const l = H.paso(root, b);
  assert.equal(l.find((x) => x.paso === 'asignar').task_id, 'A', 'lo independiente sigue');
  H.verificarTarea(root, 'A');
  const l2 = H.paso(root, b);
  assert.equal(l2.find((x) => x.paso === 'asignar').task_id, 'B');
  H.verificarTarea(root, 'B');
  const av = cierre.avance(root);
  assert.equal(av.verificadas, 2);
  assert.equal(av.total, 4);
  assert.equal(av.porcentaje, 50, 'verificadas ÷ tareas del plan: 2 de 4');
  assert.equal(av.maximo_sin_decisiones, 50);
  assert.deepEqual(av.bloqueadas_por_decision.sort(), ['C', 'D']);
  assert.equal(av.decisiones_bloqueantes[0].id, s.id);
  assert.match(av.mensaje, /quedó en 50 %/);
  assert.match(av.mensaje, new RegExp(s.id), 'dice cuáles son las decisiones que bloquean');
  assert.equal(tm.estado(root).campana.estado, 'WAITING_FINAL_AUDIT', 'con lo independiente agotado espera la auditoría final; no es FINISHED');
  assert.deepEqual(tm.estado(root).pendientes_dueno.map((p) => p.id), [s.id]);
  assert.equal(tm.asignar(root, { owner_id: 'cursor-1' }).status, 'SIN_TRABAJO', 'no se inventa trabajo para mantener a Cursor ocupado');
  /* Sin plan no hay porcentaje (null, no 0). */
  const vacio = H.proyecto();
  H.activar(vacio);
  assert.equal(cierre.avance(vacio).porcentaje, null);
});

test('[A] la CLI no conoce el dueño interno del adapter: sin --dueno se toma el único dueño con tareas asignadas, y la suspensión encuentra la tarea principal', () => {
  const root = H.proyecto();
  H.activar(root);
  tm.crearPlan(root, { objective: 'o', sprints: [{ tasks: [H.tarea('A'), H.tarea('B')] }] });
  const asg = tm.asignar(root, { owner_id: 'builder-md-session' });
  tm.ack(root, { delivery_id: asg.assignment.delivery_id, owner_id: 'builder-md-session', host_session_id: 'ses-x' });
  const f = corr.añadir(root, { task_id: 'B', severity: 'HALLAZGO', criterion: 'b no valida', proposal: 'validar', acceptance: 'rechaza', location: 'src/b.js:1' });
  const t = corr.tomar(root, { id: f.id, siguiente_paso: 'seguir con a.js' });
  assert.equal(t.status, 'TOMADA');
  assert.equal(t.finding.owner_id, 'builder-md-session');
  assert.equal(t.suspension.task_id, 'A', 'la tarea principal del constructor real se suspende aunque la CLI no sepa su nombre interno');
  fs.writeFileSync(path.join(root, 'src/b.js'), 'module.exports = { valida: true };\n');
  assert.equal(corr.entregar(root, { id: f.id, files: ['src/b.js'] }).status, 'IMPLEMENTADA_PENDIENTE_REVISION', 'entregar sin dueño explícito usa el de la corrección');
  assert.equal(corr.reanudar(root, {}).status, 'REANUDADA');
});

test('[A] desactivar y continuar con correcciones en curso: conservan la historia, sueltan lo propio y recuperan lo que perdió su lease', () => {
  const root = H.proyecto();
  H.activar(root);
  tm.crearPlan(root, { objective: 'o', sprints: [{ tasks: [H.tarea('A')] }] });
  const f = corr.añadir(root, { task_id: 'A', severity: 'HALLAZGO', criterion: 'a no valida', proposal: 'validar', acceptance: 'rechaza', location: 'src/a.js:1' });
  const t0 = 5_000_000;
  const t = corr.tomar(root, { owner_id: 'cursor-1', id: f.id, ahora: t0 });
  assert.equal(t.status, 'TOMADA');
  /* continuar con el lease aún vigente no toca nada; con el lease vencido la devuelve a la cola. */
  tm.continuar(root, { ahora: t0 + 1000 });
  assert.equal(corr.listar(root, { estado: 'IN_PROGRESS' }).length, 1);
  tm.continuar(root, { ahora: t0 + tm.LIMITES_DEFECTO.lease_ms + 1000 });
  assert.equal(corr.listar(root, { estado: 'ASSIGNED' }).length, 1, 'el constructor dejó de latir: otra sesión puede tomarla');
  const t2 = corr.tomar(root, { owner_id: 'cursor-2', id: f.id });
  assert.ok(t2.fencing > t.fencing);
  const d = tm.desactivar(root);
  assert.equal(d.status, 'DESACTIVADO');
  const tras = corr.listar(root)[0];
  assert.equal(tras.state, 'ASSIGNED', 'desactivar suelta la corrección en curso');
  assert.equal(tras.owner_id, null);
  assert.equal(tm.estado(root).leases.length, 0, 'sin leases propios colgados');
  assert.ok(tras.revision >= 4, 'y la historia (revisiones) se conserva');
  assert.equal(corr.listar(root).length, 1, 'ninguna corrección se pierde');
});

test('[A][T04] advance_on_delivery es una política del plan: activa por defecto y se puede apagar (entonces solo habilita lo verificado)', () => {
  assert.equal(tm.LIMITES_DEFECTO.advance_on_delivery, true, 'activa por defecto para trabajo ordinario');
  const root = H.proyecto();
  H.activar(root);
  tm.crearPlan(root, { objective: 'o', limits: { advance_on_delivery: false }, sprints: [{ tasks: [H.tarea('A'), H.tarea('B', { depends_on: ['A'] })] }] });
  H.paso(root, H.constructor(root));
  assert.equal(estadoDe(root, 'A'), 'VERIFYING');
  assert.equal(estadoDe(root, 'B'), 'PENDING', 'con la política apagada, entregar no habilita: solo la verificación');
  assert.equal(tm.asignar(root, { owner_id: 'cursor-1' }).status, 'OCUPADO');
  H.verificarTarea(root, 'A');
  assert.equal(estadoDe(root, 'B'), 'READY');
});
