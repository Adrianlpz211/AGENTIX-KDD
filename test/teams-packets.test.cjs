'use strict';
/* H02 "Contrato TEAMS" — paquete compartido director <-> constructor.
   Cubre las pruebas 6, 7, 8, 9, 10, 11 y 12 de H02 (1-5 viven en effort-budget.test.cjs y context-reuse.test.cjs).

   QUÉ ES CADA COSA (para no confundir fixture con host real):
     · Receptor, constructor y director son SIMULADOS: funciones y procesos node que usan el mismo protocolo.
     · La base, los hashes, los originales y el ACK/lease de TEAMS son REALES.
     · Que Cursor o Claude Code lean y respondan estos paquetes dentro de su host NO se prueba aquí:
       la prueba 11b (smoke en hosts reales) queda NO_EJECUTADA salvo AKDD_HOST_SMOKE=1. */
const test = require('node:test');
const { SIN_DRIVER } = require('./helpers/db-real.cjs');
if (SIN_DRIVER) { test(require('node:path').basename(__filename) + ' (omitido: ' + SIN_DRIVER + ')', { skip: SIN_DRIVER }, () => {}); return; }
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const { proyecto, REPO } = require('./helpers/memoria-proyecto.cjs');
const G = path.join(REPO, '.agentic', 'grafo');
const tp = require(path.join(G, 'teams-packets.cjs'));
const evidence = require(path.join(G, 'evidence-store.cjs'));
const router = require(path.join(G, 'effort-router.cjs'));
const budget = require(path.join(G, 'effort-budget.cjs'));
const tm = require(path.join(G, 'teams-manager.cjs'));
const ad = require(path.join(G, 'teams-adapters.cjs'));

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const CRITERIOS = Array.from({ length: 30 }, (_, i) => `El criterio de aceptación número ${i} describe un comportamiento observable y comprobable`);

function nuevo(nombre) {
  const p = proyecto(nombre);
  fs.writeFileSync(path.join(p.root, 'package.json'), JSON.stringify({ name: 'fx', version: '1.0.0' }));
  fs.mkdirSync(path.join(p.root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(p.root, 'src', 'a.js'), 'module.exports = () => 1;\n');
  fs.writeFileSync(path.join(p.root, 'src', 'b.js'), 'module.exports = () => 2;\n');
  return p;
}
const base = (o = {}) => ({
  task_id: 'T-1', plan_id: 'P-1', sprint_id: 'S-1', sender_role: 'director', recipient_role: 'builder',
  objective: 'Que el total del carrito sume el descuento', acceptance: CRITERIOS, scope: ['src/a.js'], risk_tier: 'MEDIUM',
  protected_contract_refs: ['C-PRECIO-1'], next_actions: ['implementar'], ...o,
});
/** Receptor simulado: lo que haría la sesión que recibe, con la lógica pura del módulo. */
function receptor() {
  const r = { estado: null, recibir(pk) { const x = tp.recibir(this.estado, pk); if (x.status === 'APLICADO') this.estado = x.estado; return x; } };
  return r;
}
const filasPaquetes = (p) => { const d = p.abrirR(); try { return d.all('SELECT revision, kind, status, base_revision, acked_revision FROM mem_context_packets ORDER BY revision'); } finally { d.close(); } };

test('contrato: un snapshot lleva EXACTAMENTE los campos del contrato, redacta secretos y rechaza lo que no se puede sostener', () => {
  const p = nuevo('contrato');
  try {
    const r = tp.enviar(p.root, base({ objective: 'usa la clave sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd para el cliente' }));
    assert.equal(r.ok, true);
    assert.equal(r.kind, 'snapshot');
    assert.equal(r.revision, 1);
    const cuerpo = JSON.parse(r.packet.body);
    assert.deepEqual(Object.keys(cuerpo), [...tp.CAMPOS_CONTRATO], 'ni un campo más ni uno menos, en el orden del contrato');
    assert.equal(tp.CAMPOS_CONTRATO.length, 22);
    assert.deepEqual(tp.validarContrato(cuerpo), []);
    assert.equal(cuerpo.base_revision, null);
    assert.equal(cuerpo.risk_tier, 'MEDIUM');
    assert.ok(!r.packet.body.includes('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd'), 'el secreto no viaja en el paquete');
    assert.ok(cuerpo.effort_usage && cuerpo.effort_usage.disponible === false, 'sin presupuesto de la tarea: "no disponible", no ceros');
    assert.equal(filasPaquetes(p).length, 1, 'persistido en mem_context_packets');

    // Validación del contrato.
    const sinCampo = { ...cuerpo }; delete sinCampo.blockers;
    assert.match(tp.validarContrato(sinCampo).join(';'), /falta el campo blockers/);
    assert.match(tp.validarContrato({ ...cuerpo, extra: 1 }).join(';'), /fuera del contrato: extra/);
    assert.match(tp.validarContrato({ ...cuerpo, risk_tier: 'ENORME' }).join(';'), /risk_tier/);
    assert.match(tp.validarContrato({ ...cuerpo, sender_role: 'builder', recipient_role: 'builder' }).join(';'), /no pueden ser el mismo rol/);

    // Rechazos del emisor.
    assert.equal(tp.enviar(p.root, base({ sender_role: 'builder', recipient_role: 'builder' })).code, 'ROLES_INVALIDOS');
    assert.equal(tp.enviar(p.root, base({ risk_tier: 'GIGANTE' })).code, 'RIESGO_INVALIDO');
    assert.equal(tp.enviar(p.root, base({ evidence_refs: ['no-es-una-ref'] })).code, 'EVIDENCE_REF_INVALIDA');
    const inexistente = tp.enviar(p.root, base({ evidence_refs: ['ev_' + 'a'.repeat(40)] }));
    assert.equal(inexistente.code, 'EVIDENCE_NO_VERIFICABLE', 'un paquete no cita lo que no existe');
    assert.equal(inexistente.evidence_code, 'UNKNOWN_REFERENCE');
    const enorme = tp.enviar(p.root, base({ task_id: 'T-GRANDE', acceptance: Array.from({ length: 200 }, (_, i) => ('criterio largo ' + i + ' ').repeat(160)) }));
    assert.equal(enorme.code, 'PAQUETE_DEMASIADO_GRANDE', 'no se trunca en silencio');
    assert.equal(filasPaquetes(p).length, 1, 'ningún rechazo dejó filas');
  } finally { p.limpiar(); }
});

test('sin las tablas de 3.20.1 no se migra en silencio: SCHEMA_MISSING y TEAMS sigue igual', () => {
  const p = proyecto('sinschema', { catalogo: false, nodos: 0 });
  try {
    fs.writeFileSync(path.join(p.root, 'package.json'), '{"name":"x"}');
    const r = tp.enviar(p.root, base());
    assert.equal(r.code, 'SCHEMA_MISSING');
    assert.match(r.message, /akdd update/);
    assert.equal(tp.estadoCorriente(p.root, { task_id: 'T-1', recipient_role: 'builder' }).code, 'SCHEMA_MISSING');
    assert.equal(tp.paqueteDeAsignacion(p.root, { task: { id: 'T-1' } }), null, 'la integración con TEAMS es fail-soft');
  } finally { p.limpiar(); }
});

test('[prueba 7] delta SOLO contra la revisión que el receptor confirmó; si la base no coincide o el receptor reinició → snapshot, nunca estado corrupto', () => {
  const p = nuevo('delta');
  try {
    const rx = receptor();
    const e1 = tp.enviar(p.root, base());
    assert.equal(e1.kind, 'snapshot');
    assert.equal(rx.recibir(e1.packet).status, 'APLICADO');
    // Sin ACK todavía, el emisor NO sabe que el receptor tiene la base: otro snapshot.
    const e2 = tp.enviar(p.root, base({ next_actions: ['implementar', 'probar'] }));
    assert.equal(e2.kind, 'snapshot', 'sin confirmación no hay delta');
    assert.equal(rx.recibir(e2.packet).status, 'APLICADO');
    const a2 = tp.ack(p.root, { task_id: 'T-1', recipient_role: 'builder', revision: 2, hash: rx.recibir(e2.packet).ack.hash });
    assert.equal(a2.ok, true);
    // Confirmada la revisión 2: el siguiente cambio pequeño viaja como DELTA con base 2.
    const e3 = tp.enviar(p.root, base({ next_actions: ['implementar', 'probar', 'documentar'] }));
    assert.equal(e3.kind, 'delta');
    const c3 = JSON.parse(e3.packet.body);
    assert.equal(c3.base_revision, 2);
    assert.deepEqual(Object.keys(c3.delta.set), ['next_actions'], 'solo lo que cambió');
    assert.ok(e3.delivered_bytes < e3.snapshot_bytes * 0.7, 'el delta pesa bastante menos que el snapshot');
    const ap3 = rx.recibir(e3.packet);
    assert.equal(ap3.status, 'APLICADO');
    assert.equal(rx.estado.revision, 3);
    // El estado reconstruido por el receptor es EXACTAMENTE el que el emisor tiene.
    const snap = tp.snapshotActual(p.root, { task_id: 'T-1', recipient_role: 'builder' });
    assert.equal(tp.hashContenido(rx.estado.contenido), tp.hashContenido(JSON.parse(snap.packet.body)));
    // La base de un delta es la última CONFIRMADA, no la última enviada.
    const e4 = tp.enviar(p.root, base({ next_actions: ['implementar', 'probar', 'documentar', 'publicar'] }));
    assert.equal(JSON.parse(e4.packet.body).base_revision, 2, 'la 3 no está confirmada: sigue valiendo la 2');

    // (a) Base que no coincide: el receptor está en la 1, el delta pide la 2.
    const viejo = receptor();
    viejo.recibir(e1.packet);
    const antes = JSON.stringify(viejo.estado);
    const r1 = viejo.recibir(e3.packet);
    assert.equal(r1.status, 'PIDE_SNAPSHOT');
    assert.equal(r1.motivo, 'BASE_NO_COINCIDE');
    assert.deepEqual([r1.tiene, r1.base_pedida], [1, 2]);
    assert.equal(JSON.stringify(viejo.estado), antes, 'NO se aplicó nada: el estado quedó intacto');
    // (b) Receptor reiniciado (sin estado): tampoco aplica el delta.
    const nuevoRx = receptor();
    assert.equal(nuevoRx.recibir(e3.packet).motivo, 'SIN_ESTADO_BASE');
    assert.equal(nuevoRx.estado, null);
    // (c) Cuerpo alterado en tránsito.
    const roto = { ...e3.packet, body: e3.packet.body.replace('documentar', 'DOCUMENTAR') };
    assert.equal(rx.recibir({ ...roto, revision: 99 }).motivo, 'CUERPO_ALTERADO');
    // (d) Delta cuyo resultado no coincide con su hash (emisor y receptor divergieron).
    const adulterado = JSON.parse(e3.packet.body); adulterado.delta.set.next_actions = ['otra cosa'];
    const cuerpoAdulterado = JSON.stringify(adulterado);
    const rx2 = receptor(); rx2.estado = { ...JSON.parse(JSON.stringify(rx.estado)), revision: 2 };
    rx2.estado.contenido.next_actions = ['implementar', 'probar'];
    assert.equal(rx2.recibir({ ...e3.packet, body: cuerpoAdulterado, body_hash: sha(cuerpoAdulterado) }).motivo, 'RESULTADO_NO_COINCIDE');
    // Y el receptor que pidió snapshot lo recibe completo y queda al día.
    const s = tp.snapshotActual(p.root, { task_id: 'T-1', recipient_role: 'builder' });
    assert.equal(s.packet.kind, 'snapshot');
    assert.equal(viejo.recibir(s.packet).status, 'APLICADO');
    assert.equal(viejo.estado.revision, 4);
  } finally { p.limpiar(); }
});

test('orden y ACK fuera de orden: una revisión vieja no retrocede el estado; el ACK de la 3 puede llegar antes que el de la 2', () => {
  const p = nuevo('orden');
  try {
    const rx = receptor();
    const e1 = tp.enviar(p.root, base());
    rx.recibir(e1.packet);
    tp.ack(p.root, { task_id: 'T-1', recipient_role: 'builder', revision: 1, hash: e1.packet.body_hash });
    const e2 = tp.enviar(p.root, base({ next_actions: ['x'] }));
    const e3 = tp.enviar(p.root, base({ next_actions: ['x', 'y'] }));
    assert.deepEqual([e2.kind, e3.kind, JSON.parse(e2.packet.body).base_revision, JSON.parse(e3.packet.body).base_revision], ['delta', 'delta', 1, 1]);
    // El mensaje 3 llega antes que el 2 (misma base: se aplica directo); el 2 llega tarde y se ignora.
    assert.equal(rx.recibir(e3.packet).status, 'APLICADO');
    assert.equal(rx.estado.revision, 3);
    assert.equal(rx.recibir(e2.packet).status, 'OBSOLETO');
    assert.equal(rx.estado.revision, 3, 'no retrocede');
    // Y el ACK de la 3 llega antes que el de la 2: los dos valen, en cualquier orden.
    assert.equal(tp.ack(p.root, { task_id: 'T-1', recipient_role: 'builder', revision: 3, hash: e3.packet.body_hash }).ok, true);
    assert.equal(tp.ack(p.root, { task_id: 'T-1', recipient_role: 'builder', revision: 2, hash: e2.packet.body_hash }).ok, true);
    const cur = tp.estadoCorriente(p.root, { task_id: 'T-1', recipient_role: 'builder' });
    assert.equal(cur.revision, 3);
    assert.equal(cur.ultima_confirmada, 3);
    // El siguiente delta ya parte de la 3.
    const e4 = tp.enviar(p.root, base({ next_actions: ['x', 'y', 'z'] }));
    assert.equal(JSON.parse(e4.packet.body).base_revision, 3);
  } finally { p.limpiar(); }
});

test('ACK identifica REVISIÓN y HASH recibidos: un hash distinto no se acepta e invalida la base; ACK repetido es idempotente', () => {
  const p = nuevo('ack');
  try {
    const e1 = tp.enviar(p.root, base());
    assert.equal(tp.ack(p.root, { task_id: 'T-1', recipient_role: 'builder', revision: 7, hash: 'x' }).code, 'ACK_DESCONOCIDO');
    const mal = tp.ack(p.root, { task_id: 'T-1', recipient_role: 'builder', revision: 1, hash: 'f'.repeat(64) });
    assert.equal(mal.code, 'ACK_HASH_DISTINTO');
    assert.equal(mal.necesita_snapshot, true);
    const ok = tp.ack(p.root, { task_id: 'T-1', recipient_role: 'builder', revision: 1, hash: e1.packet.body_hash });
    assert.deepEqual([ok.ok, ok.primer_ack, ok.duplicado], [true, true, false]);
    const dup = tp.ack(p.root, { task_id: 'T-1', recipient_role: 'builder', revision: 1, hash: e1.packet.body_hash });
    assert.deepEqual([dup.ok, dup.primer_ack, dup.duplicado], [true, false, true]);
    // El receptor dice haber aplicado un estado distinto al enviado: se invalida su base.
    const e2 = tp.enviar(p.root, base({ next_actions: ['a'] }));
    assert.equal(e2.kind, 'delta');
    const divergido = tp.ack(p.root, { task_id: 'T-1', recipient_role: 'builder', revision: 2, hash: e2.packet.body_hash, state_hash: 'e'.repeat(64) });
    assert.equal(divergido.code, 'ACK_HASH_DISTINTO');
    const e3 = tp.enviar(p.root, base({ next_actions: ['a', 'b'] }));
    assert.equal(e3.kind, 'snapshot', 'sin base confirmada vuelve el snapshot completo');
    // Un receptor que se reinicia pierde sus confirmaciones.
    assert.equal(tp.ack(p.root, { task_id: 'T-1', recipient_role: 'builder', revision: 3, hash: e3.packet.body_hash }).ok, true);
    assert.equal(tp.enviar(p.root, base({ next_actions: ['a', 'b', 'c'] })).kind, 'delta');
    tp.reiniciarReceptor(p.root, { task_id: 'T-1', recipient_role: 'builder' });
    assert.equal(tp.enviar(p.root, base({ next_actions: ['a', 'b', 'c', 'd'] })).kind, 'snapshot');
    // El ACK pendiente se ve para reintentar.
    assert.ok(tp.pendientesDeAck(p.root, { recipient_role: 'builder' }).pendientes.length >= 1);
    assert.ok(tp.paquetesPendientes(p.root, { recipient_role: 'builder' }).paquetes.every((x) => x.kind === 'snapshot'), 'sin base confirmada los pendientes van como snapshot');
  } finally { p.limpiar(); }
});

test('[prueba 6] entrega duplicada no duplica ejecución: ni revisión, ni aplicación, ni ejecución de negocio', () => {
  const p = nuevo('dup');
  try {
    const e1 = tp.enviar(p.root, base());
    const e1b = tp.enviar(p.root, base());
    assert.equal(e1b.status, 'DUPLICADO');
    assert.equal(e1b.revision, 1, 'el mismo estado no abre otra revisión');
    assert.equal(e1b.packet.body_hash, e1.packet.body_hash);
    assert.equal(filasPaquetes(p).length, 1);
    // El consumo cambia en cada envío; eso por sí solo NO es un estado nuevo.
    router.decidirYGuardar(p.root, { task_id: 'T-1', intent: 'cambia el texto del título', paths: ['src/a.js'], index_coverage: 'COMPLETE' });
    assert.equal(tp.enviar(p.root, base()).status, 'DUPLICADO');
    // El receptor que recibe dos veces lo mismo no lo vuelve a aplicar.
    const rx = receptor();
    assert.equal(rx.recibir(e1.packet).status, 'APLICADO');
    const otra = rx.recibir(e1.packet);
    assert.equal(otra.status, 'DUPLICADO');
    assert.equal(otra.ack.revision, 1, 're-acusa sin repetir nada');

    // EJECUCIÓN: un solo reclamo gana. El token es el fencing de TEAMS.
    const ref = { task_id: 'T-1', recipient_role: 'builder', revision: 1 };
    const c1 = tp.reclamarEjecucion(p.root, { ...ref, token: 1 });
    assert.deepEqual([c1.ok, c1.status], [true, 'RECLAMADA']);
    const c2 = tp.reclamarEjecucion(p.root, { ...ref, token: 1 });
    assert.deepEqual([c2.ok, c2.code, c2.duplicado], [false, 'YA_EN_EJECUCION', true], 'la entrega duplicada no ejecuta otra vez');
    const zombi = tp.reclamarEjecucion(p.root, { ...ref, token: 0 });
    assert.equal(zombi.zombi, true, 'un fencing menor es un zombi');
    assert.equal(tp.completarEjecucion(p.root, { ...ref, token: 1 }).status, 'EJECUTADA');
    const c3 = tp.reclamarEjecucion(p.root, { ...ref, token: 1 });
    assert.deepEqual([c3.code, c3.duplicado], ['YA_EJECUTADO', true]);
    assert.equal(tp.reclamarEjecucion(p.root, { ...ref, token: 2 }).code, 'YA_EJECUTADO', 'ni siquiera un fencing mayor repite lo ya ejecutado');
    // Un ACK posterior no borra el estado de ejecución.
    tp.ack(p.root, { ...ref, hash: e1.packet.body_hash });
    assert.equal(tp.estadoCorriente(p.root, { task_id: 'T-1', recipient_role: 'builder' }).ejecucion.estado, 'EXECUTED');
    assert.equal(tp.reclamarEjecucion(p.root, { ...ref, token: -1 }).code, 'TOKEN_INVALIDO');
    assert.equal(tp.reclamarEjecucion(p.root, { ...ref, revision: 9, token: 1 }).code, 'PAQUETE_DESCONOCIDO');
  } finally { p.limpiar(); }
});

test('[prueba 8] el director rechaza un PASS inventado y evidencia de una versión anterior; solo acepta lo que verifica contra los originales', () => {
  const p = nuevo('director');
  try {
    const arch = (rel) => ({ path: rel, sha256: sha(fs.readFileSync(path.join(p.root, rel))) });
    // v1 del código y su evidencia (salida de tests atada al sujeto exacto).
    const sujeto1 = tp.subjectHash(p.root, ['src/a.js']);
    const ev1 = tp.guardarEvidenciaDeGate(p.root, { task_id: 'T-1', subject_hash: sujeto1, gate: 'relevant-check', texto: 'node --test: 12 pass, 0 fail' });
    assert.equal(ev1.ok, true);
    const entrega = (o = {}) => ({ task_id: 'T-1', subject_hash: tp.subjectHash(p.root, ['src/a.js']), scope: ['src/a.js'], changed_files: [arch('src/a.js')], criteria: [{ criterio: 'suma el descuento', resultado: 'PASS', evidence_ref: ev1.evidence_id }], ...o });

    const buena = tp.validarEntrega(p.root, entrega());
    assert.equal(buena.ok, true, JSON.stringify(buena.rechazos));
    assert.equal(buena.status, 'EVIDENCIA_VERIFICADA');
    assert.match(buena.nota, /no marca DONE/, 'aprobar evidencia no cierra la tarea');
    assert.equal(buena.detalle_requerido.requerido, false, 'MEDIUM sin contradicción: basta con el hash');

    // PASS inventado: sin evidencia, con una referencia que no existe, o mal formada.
    const sinEv = tp.validarEntrega(p.root, entrega({ criteria: [{ criterio: 'x', resultado: 'PASS' }] }));
    assert.deepEqual(sinEv.rechazos.map((r) => r.code), ['PASS_SIN_EVIDENCIA']);
    const falsa = tp.validarEntrega(p.root, entrega({ criteria: [{ criterio: 'x', resultado: 'PASS', evidence_ref: 'ev_' + 'b'.repeat(40) }] }));
    assert.deepEqual(falsa.rechazos.map((r) => r.code), ['UNKNOWN_REFERENCE']);
    assert.deepEqual(tp.validarEntrega(p.root, entrega({ criteria: [{ criterio: 'x', resultado: 'PASS', evidence_ref: 'inventado' }] })).rechazos.map((r) => r.code), ['EVIDENCE_REF_INVALIDA']);
    assert.deepEqual(tp.validarEntrega(p.root, entrega({ criteria: [] })).rechazos.map((r) => r.code), ['SIN_CRITERIOS']);
    assert.equal(tp.validarEntrega(p.root, entrega({ criteria: [{ criterio: 'x', resultado: 'FAIL', evidence_ref: ev1.evidence_id }] })).rechazos[0].code, 'CRITERIO_NO_PASS');
    // Evidencia real pero SIN vínculo a ningún sujeto (la guardó alguien sin atarla a la versión).
    const suelta = evidence.guardar(p.root, { text: 'salida suelta' }, { kind: 'tool_output', task_id: 'T-1' });
    assert.equal(tp.validarEntrega(p.root, entrega({ criteria: [{ criterio: 'x', resultado: 'PASS', evidence_ref: suelta.evidence_id }] })).rechazos[0].code, 'EVIDENCIA_SIN_VINCULO_A_SUJETO');

    // El código CAMBIA (v2): la evidencia de la v1 ya no sirve, aunque exista y su hash esté intacto.
    fs.writeFileSync(path.join(p.root, 'src', 'a.js'), 'module.exports = () => 2; // v2\n');
    const vieja = tp.validarEntrega(p.root, entrega());
    assert.equal(vieja.ok, false);
    assert.deepEqual(vieja.rechazos.map((r) => r.code), ['EVIDENCIA_DE_OTRA_VERSION']);
    assert.match(vieja.rechazos[0].detalle, /versión anterior/);
    // El constructor miente sobre el contenido: declara el hash viejo con el código nuevo en disco.
    const miente = tp.validarEntrega(p.root, { ...entrega(), subject_hash: sujeto1, changed_files: [{ path: 'src/a.js', sha256: sha('module.exports = () => 1;\n') }] });
    const codigos = miente.rechazos.map((r) => r.code);
    assert.ok(codigos.includes('SUJETO_NO_COINCIDE') && codigos.includes('ARCHIVO_CAMBIO_DESPUES'), codigos.join(','));
    // Evidencia de la v2 correcta → vuelve a valer.
    const sujeto2 = tp.subjectHash(p.root, ['src/a.js']);
    assert.notEqual(sujeto1, sujeto2);
    const ev2 = tp.guardarEvidenciaDeGate(p.root, { task_id: 'T-1', subject_hash: sujeto2, gate: 'relevant-check', texto: 'node --test: 12 pass (v2)' });
    assert.equal(tp.validarEntrega(p.root, entrega({ criteria: [{ criterio: 'suma', resultado: 'PASS', evidence_ref: ev2.evidence_id }] })).ok, true);
    // Alcance: un archivo fuera de lo permitido se rechaza aunque la evidencia sea buena.
    fs.writeFileSync(path.join(p.root, 'src', 'c.js'), 'x\n');
    const fuera = tp.validarEntrega(p.root, entrega({ changed_files: [arch('src/a.js'), arch('src/c.js')], subject_hash: undefined, criteria: [{ criterio: 'x', resultado: 'PASS', evidence_ref: ev2.evidence_id }] }));
    assert.ok(fuera.rechazos.some((r) => r.code === 'FUERA_DE_ALCANCE' && r.path === 'src/c.js'));

    // El ORIGINAL de la evidencia se altera en disco: ya no verifica.
    const objeto = evidence.rutaObjeto(p.root, ev2.sha256);
    fs.chmodSync(objeto, 0o666);
    fs.appendFileSync(objeto, ' manipulado');
    const alterada = tp.validarEntrega(p.root, entrega({ criteria: [{ criterio: 'suma', resultado: 'PASS', evidence_ref: ev2.evidence_id }] }));
    assert.deepEqual(alterada.rechazos.map((r) => r.code), ['EVIDENCE_CHANGED']);
  } finally { p.limpiar(); }
});

test('riesgo, contradicción, fallo o cierre con prueba obligan a mirar el DETALLE (y cuesta presupuesto); lo demás, no', () => {
  const p = nuevo('detalle');
  try {
    assert.deepEqual(tp.detalleRequerido({ risk_tier: 'HIGH' }), { requerido: true, motivos: ['RIESGO'] });
    assert.deepEqual(tp.detalleRequerido({ contradiccion: true, fallo: true, cierre_exige_prueba: true }).motivos, ['CONTRADICCION', 'FALLO', 'CIERRE_EXIGE_PRUEBA']);
    assert.equal(tp.detalleRequerido({ risk_tier: 'LOW' }).requerido, false);
    router.decidirYGuardar(p.root, { task_id: 'T-1', intent: 'ajusta la verificación de permisos', paths: ['src/a.js'] });
    const sujeto = tp.subjectHash(p.root, ['src/a.js']);
    const ev = tp.guardarEvidenciaDeGate(p.root, { task_id: 'T-1', subject_hash: sujeto, gate: 'tdd', texto: 'x'.repeat(3000) });
    const entrega = { task_id: 'T-1', subject_hash: sujeto, changed_files: ['src/a.js'], risk_tier: 'HIGH', criteria: [{ criterio: 'ok', resultado: 'PASS', evidence_ref: ev.evidence_id }] };
    const r = tp.validarEntrega(p.root, entrega);
    assert.equal(r.ok, true);
    assert.equal(r.detalle_requerido.requerido, true);
    assert.equal(r.detalle_leido.length, 1);
    assert.equal(r.detalle_leido[0].bytes, 3000, 'se leyó el original, no solo su hash');
    const e = budget.estado(p.root, 'T-1');
    assert.equal(e.uso.retrievals, 1, 'recuperar el detalle gastó presupuesto de la tarea');
    assert.equal(e.uso.retrieved_bytes, 3000);
    // En LOW sin contradicción no se lee el original.
    const r2 = tp.validarEntrega(p.root, { ...entrega, risk_tier: 'LOW' });
    assert.equal(r2.detalle_leido.length, 0);
  } finally { p.limpiar(); }
});

test('[prueba 9] el reinicio conserva pins, revisiones y pendientes humanos (también en un proceso nuevo); cerrar libera los pins', () => {
  const p = nuevo('restart');
  try {
    const sujeto = tp.subjectHash(p.root, ['src/a.js']);
    const ev = tp.guardarEvidenciaDeGate(p.root, { task_id: 'T-1', subject_hash: sujeto, gate: 'tdd', texto: 'salida de tests' }, { retention: 'cache', ttl_ms: 1000 });
    const e1 = tp.enviar(p.root, base({ evidence_refs: [ev.evidence_id] }));
    assert.equal(e1.ok, true);
    assert.deepEqual(e1.pins, [{ evidence_id: ev.evidence_id, pinned: true }]);
    tp.ack(p.root, { task_id: 'T-1', recipient_role: 'builder', revision: 1, hash: e1.packet.body_hash });
    const d = tp.registrarDecisionPendiente(p.root, { task_id: 'T-1', pregunta: '¿El descuento aplica al envío?', bloqueante: false, supuesto: 'no aplica al envío' });
    assert.equal(d.ok, true);
    assert.equal(d.continuar, true);
    assert.equal(d.revision, 2);
    const antes = tp.estadoCorriente(p.root, { task_id: 'T-1', recipient_role: 'builder' });
    assert.equal(antes.revision, 2);

    // "Reinicio" 1: el módulo se vuelve a cargar desde cero (sin nada en memoria).
    for (const k of Object.keys(require.cache)) if (k.startsWith(G)) delete require.cache[k];
    const tp2 = require(path.join(G, 'teams-packets.cjs'));
    const ev2 = require(path.join(G, 'evidence-store.cjs'));
    const despues = tp2.estadoCorriente(p.root, { task_id: 'T-1', recipient_role: 'builder' });
    assert.equal(despues.revision, 2, 'la revisión sobrevive');
    assert.deepEqual(despues.pendientes_humanos.map((x) => x.question), ['¿El descuento aplica al envío?'], 'el pendiente humano sobrevive');
    assert.equal(despues.pendientes_humanos[0].blocking, false);
    assert.deepEqual(despues.pins, [ev.evidence_id], 'el pin sobrevive');
    assert.equal(despues.ultima_confirmada, 1);
    // La evidencia fijada no se purga aunque la caché haya caducado; la que no tiene pin, sí.
    const suelta = ev2.guardar(p.root, { text: 'sin pin' }, { kind: 'tool_output', retention: 'cache', ttl_ms: 1000 });
    const limpieza = ev2.limpiar(p.root, { now: Date.now() + 3600 * 1000 });
    assert.ok(limpieza.expired.includes(suelta.evidence_id));
    assert.ok(!limpieza.expired.includes(ev.evidence_id), 'lo fijado por una tarea activa no se purga');
    assert.equal(ev2.verificar(p.root, ev.evidence_id).ok, true);

    // "Reinicio" 2: un PROCESO nuevo lee el mismo estado de la base.
    const hijo = spawnSync(process.execPath, [path.join(G, 'teams-packets.cjs'), 'estado', '--task=T-1', '--rol=builder'], { cwd: p.root, encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
    assert.equal(hijo.status, 0, hijo.stderr);
    const dh = JSON.parse(hijo.stdout);
    assert.equal(dh.revision, 2);
    assert.deepEqual(dh.pins, [ev.evidence_id]);
    assert.equal(dh.pendientes_humanos.length, 1);

    // Resolver el pendiente: solo por una persona o una verificación.
    assert.equal(tp2.resolverPendiente(p.root, { task_id: 'T-1', id: d.decision_id, origen: 'timeout' }).code, 'TIMEOUT_NO_RESUELVE');
    assert.equal(tp2.estadoCorriente(p.root, { task_id: 'T-1', recipient_role: 'builder' }).pendientes_humanos.length, 1, 'el tiempo no lo resolvió');
    assert.equal(tp2.resolverPendiente(p.root, { task_id: 'T-1', id: d.decision_id, origen: 'humano' }).status, 'RESUELTO');
    assert.equal(tp2.estadoCorriente(p.root, { task_id: 'T-1', recipient_role: 'builder' }).pendientes_humanos.length, 0);

    // Pins por alcance: un pin de sprint sobrevive al cierre de la tarea; los de tarea se liberan.
    const ev3 = tp2.guardarEvidenciaDeGate(p.root, { task_id: 'T-1', subject_hash: sujeto, gate: 'qa', texto: 'revisión de sprint' });
    const e3 = tp2.enviar(p.root, base({ evidence_refs: [ev.evidence_id, ev3.evidence_id], pin_scope: 'sprint', next_actions: ['x'] }));
    assert.equal(e3.ok, true);
    assert.deepEqual(tp2.pinsActivos(p.root, 'sprint', 'S-1').sort(), [ev.evidence_id, ev3.evidence_id].sort());
    const c = tp2.cerrar(p.root, { task_id: 'T-1', sprint_id: 'S-1' });
    assert.equal(c.status, 'CERRADA');
    assert.deepEqual(tp2.pinsActivos(p.root, 'task', 'T-1'), [], 'los pins de la tarea se liberaron');
    assert.equal(tp2.pinsActivos(p.root, 'sprint', 'S-1').length, 2, 'el sprint sigue activo: sus pins siguen');
    assert.equal(tp2.cerrar(p.root, { task_id: 'T-1', sprint_id: 'S-1', cerrar_sprint: true }).pins_liberados.sprint, 2);
    assert.equal(tp2.enviar(p.root, base({ next_actions: ['y'] })).code, 'TAREA_CERRADA');
    assert.ok(filasPaquetes(p).every((f) => f.status === 'CLOSED'));
    // Abandonar también libera.
    const ev4 = tp2.guardarEvidenciaDeGate(p.root, { task_id: 'T-2', subject_hash: sujeto, gate: 'x', texto: 'otra' });
    tp2.enviar(p.root, base({ task_id: 'T-2', evidence_refs: [ev4.evidence_id] }));
    assert.equal(tp2.pinsActivos(p.root, 'task', 'T-2').length, 1);
    assert.equal(tp2.cerrar(p.root, { task_id: 'T-2', motivo: 'ABANDONED' }).status, 'ABANDONADA');
    assert.equal(tp2.pinsActivos(p.root, 'task', 'T-2').length, 0);
  } finally { p.limpiar(); }
});

test('cambio de código, de memoria o de evidencia INVALIDA los paquetes: no se ejecutan ni sirven de base de delta', () => {
  const p = nuevo('invalida');
  try {
    // Una decisión de memoria citada.
    const w = p.abrirW();
    let nodoId;
    try { w.run('INSERT INTO nodos (tipo, titulo, contenido, area, confianza, estado, vigencia_tipo) VALUES (?,?,?,?,?,?,?)', ['decision', 'DESC', 'el descuento es 10 %', 'precio', 'ALTA', 'ACTIVO', 'VIGENTE']); nodoId = w.get('SELECT max(id) AS id FROM nodos').id; } finally { w.close(); }
    const sujeto = tp.subjectHash(p.root, ['src/a.js']);
    const ev = tp.guardarEvidenciaDeGate(p.root, { task_id: 'T-1', subject_hash: sujeto, gate: 'tdd', texto: 'ok' });
    const contenido = { changed_files: ['src/a.js'], decision_refs: [nodoId], evidence_refs: [ev.evidence_id] };
    const e1 = tp.enviar(p.root, base(contenido));
    assert.equal(JSON.parse(e1.packet.body).decision_refs[0].content_hash.length, 64);
    tp.ack(p.root, { task_id: 'T-1', recipient_role: 'builder', revision: 1, hash: e1.packet.body_hash });
    assert.equal(tp.invalidar(p.root, {}).invalidados.length, 0, 'nada cambió: nada se invalida');
    assert.equal(tp.validarVigencia(p.root, tp.estadoCorriente(p.root, { task_id: 'T-1', recipient_role: 'builder' }).contenido).vigente, true);

    // (1) Cambió la MEMORIA citada.
    const w2 = p.abrirW();
    try { w2.run("UPDATE nodos SET contenido = 'el descuento es 15 %' WHERE id = ?", nodoId); } finally { w2.close(); }
    const r1 = tp.invalidar(p.root, {});
    assert.deepEqual(r1.invalidados.map((i) => i.motivos[0].tipo), ['MEMORIA']);
    assert.deepEqual(r1.evidencias_afectadas, [ev.evidence_id], 'las evidencias de ese paquete quedan señaladas como afectadas');
    assert.equal(tp.reclamarEjecucion(p.root, { task_id: 'T-1', recipient_role: 'builder', revision: 1, token: 1 }).code, 'PAQUETE_INVALIDADO');
    assert.equal(tp.ack(p.root, { task_id: 'T-1', recipient_role: 'builder', revision: 1, hash: e1.packet.body_hash }).code, 'ACK_DE_PAQUETE_STALE');
    // El siguiente envío es snapshot nuevo (no hay base vigente).
    const e2 = tp.enviar(p.root, base({ ...contenido, decision_refs: [nodoId] }));
    assert.equal(e2.kind, 'snapshot');
    assert.equal(e2.revision, 2);
    tp.ack(p.root, { task_id: 'T-1', recipient_role: 'builder', revision: 2, hash: e2.packet.body_hash });
    // (2) Cambió el CÓDIGO citado.
    fs.writeFileSync(path.join(p.root, 'src', 'a.js'), 'module.exports = () => 99;\n');
    const r2 = tp.invalidar(p.root, {});
    assert.ok(r2.invalidados[0].motivos.some((m) => m.tipo === 'CODIGO' && m.ref === 'src/a.js'));
    // (3) Invalidación por evento externo declarado (restauración): fuerza por rutas aunque el hash coincidiera.
    const e3 = tp.enviar(p.root, base({ changed_files: ['src/a.js'] }));
    const r3 = tp.invalidar(p.root, { paths: ['src/a.js'], reason: 'RESTORE' });
    assert.equal(r3.invalidados.length, 1);
    assert.equal(e3.ok, true);
    // (4) Una evidencia que ya no verifica también invalida.
    const sujeto2 = tp.subjectHash(p.root, ['src/b.js']);
    const evB = tp.guardarEvidenciaDeGate(p.root, { task_id: 'T-5', subject_hash: sujeto2, gate: 'x', texto: 'ok' });
    tp.enviar(p.root, base({ task_id: 'T-5', evidence_refs: [evB.evidence_id] }));
    fs.appendFileSync(evidence.rutaObjeto(p.root, evB.sha256), ' alterado');
    const r4 = tp.invalidar(p.root, { task_id: 'T-5' });
    assert.equal(r4.invalidados[0].motivos[0].tipo, 'EVIDENCIA');
  } finally { p.limpiar(); }
});

test('recuperación tras la muerte del constructor o del director: se reconstruye de la base y no se repite la ejecución de negocio', () => {
  const p = nuevo('muerte');
  try {
    router.decidirYGuardar(p.root, { task_id: 'T-1', intent: 'cambia el texto del título', paths: ['src/a.js'], index_coverage: 'COMPLETE' });
    const e1 = tp.enviar(p.root, base());
    const rx = receptor();
    rx.recibir(e1.packet);
    tp.ack(p.root, { task_id: 'T-1', recipient_role: 'builder', revision: 1, hash: e1.packet.body_hash });
    const ref = { task_id: 'T-1', recipient_role: 'builder', revision: 1 };
    // El constructor (fencing 1) empieza a ejecutar... y muere sin completar.
    assert.equal(tp.reclamarEjecucion(p.root, { ...ref, token: 1 }).status, 'RECLAMADA');
    // TEAMS vence su lease y reasigna con fencing 2. El constructor nuevo recupera TODO desde la base.
    const rec = tp.recuperar(p.root, { task_id: 'T-1', recipient_role: 'builder' });
    assert.equal(rec.status, 'RECUPERADO');
    assert.deepEqual(rec.ejecucion, { estado: 'EXECUTING', token: 1 });
    assert.equal(rec.snapshot.kind, 'snapshot', 'el receptor nuevo no tiene base: snapshot completo');
    const rx2 = receptor();
    assert.equal(rx2.recibir(rec.snapshot).status, 'APLICADO');
    assert.equal(tp.reclamarEjecucion(p.root, { ...ref, token: 1 }).code, 'YA_EN_EJECUCION', 'el mismo fencing no se repite');
    const relevo = tp.reclamarEjecucion(p.root, { ...ref, token: 2 });
    assert.deepEqual([relevo.ok, relevo.status, relevo.anterior], [true, 'RELEVADA', 1]);
    // El zombi (fencing 1) despierta e intenta completar: no es el dueño.
    assert.equal(tp.completarEjecucion(p.root, { ...ref, token: 1 }).code, 'TOKEN_NO_VIGENTE');
    assert.equal(tp.completarEjecucion(p.root, { ...ref, token: 2 }).status, 'EJECUTADA');
    assert.equal(tp.reclamarEjecucion(p.root, { ...ref, token: 3 }).code, 'YA_EJECUTADO');

    // Muere el DIRECTOR: otro director arranca con módulos vacíos y lo único que tiene es la base.
    for (const k of Object.keys(require.cache)) if (k.startsWith(G)) delete require.cache[k];
    const tpNuevo = require(path.join(G, 'teams-packets.cjs'));
    const cur = tpNuevo.estadoCorriente(p.root, { task_id: 'T-1', recipient_role: 'builder' });
    assert.equal(cur.revision, 1);
    assert.deepEqual(cur.ejecucion, { estado: 'EXECUTED', token: 2 });
    // Reenvía el mismo estado (no sabe si el anterior llegó): no abre otra revisión ni repite nada.
    const reenvio = tpNuevo.enviar(p.root, base());
    assert.equal(reenvio.status, 'DUPLICADO');
    assert.equal(reenvio.revision, 1);
    assert.equal(filasPaquetes(p).length, 1);

    // Dependencia bloqueante: el tiempo NO la resuelve; solo se dispara una revisión de estado.
    const b = tpNuevo.enviar(p.root, base({ blockers: [{ id: 'B-DEP', tipo: 'DEPENDENCIA', ref: 'T-0', blocking: true }], next_actions: ['esperar T-0'] }));
    assert.equal(b.ok, true);
    const rev = tpNuevo.revisionPorTiempo(p.root, { task_id: 'T-1', ahora: Date.now() + 3 * 3600 * 1000 });
    assert.equal(rev.sin_progreso, true);
    assert.equal(rev.accion, 'REVISAR_ESTADO');
    assert.deepEqual(rev.bloqueos_vigentes.map((x) => x.id), ['B-DEP'], 'el bloqueo sigue vigente');
    assert.match(rev.nota, /el tiempo no los resuelve/);
    assert.equal(tpNuevo.resolverPendiente(p.root, { task_id: 'T-1', id: 'B-DEP', origen: 'timeout' }).code, 'TIMEOUT_NO_RESUELVE');
    assert.equal(tpNuevo.resolverPendiente(p.root, { task_id: 'T-1', id: 'B-DEP', origen: 'verificacion' }).status, 'RESUELTO');
    assert.equal(tpNuevo.resolverPendiente(p.root, { task_id: 'T-1', id: 'no-existe', origen: 'humano' }).code, 'PENDIENTE_DESCONOCIDO');
    assert.equal(router.leer(p.root, 'T-1').decision.tier, 'LOW', 'el paso del tiempo no escaló ni inventó trabajo');
  } finally { p.limpiar(); }
});

test('[prueba 10] un bloqueo no crítico no detiene las tareas independientes; uno bloqueante frena solo su cadena y el tiempo no lo resuelve', () => {
  const p = nuevo('bloqueo');
  try {
    fs.mkdirSync(path.join(p.root, '.agentic'), { recursive: true });
    fs.writeFileSync(path.join(p.root, '.agentic', 'config.md'), 'CONFIGURADO: SI\n');
    assert.equal(tm.init(p.root, { aprobarMigracion: true }).status, 'ACTIVO');
    const plan = tm.crearPlan(p.root, {
      id: 'P-1', objective: 'descuentos', sprints: [{ id: 'S-1', tasks: [
        { id: 'A', objective: 'aplicar el descuento al total', acceptance: ['total con descuento'], allowed_files: ['src/a.js'] },
        { id: 'B', objective: 'mostrar el descuento en el resumen', acceptance: ['resumen con descuento'], allowed_files: ['src/b.js'], depends_on: ['A'] },
        { id: 'C', objective: 'texto del pie de página', acceptance: ['pie actualizado'], allowed_files: ['src/c.js'] },
      ] }],
    });
    assert.equal(plan.status, 'PLAN_GUARDADO', JSON.stringify(plan));
    const a = tm.asignar(p.root, { owner_id: 'builder-1' });
    assert.equal(a.status, 'ASIGNADA');
    assert.equal(a.assignment.task.id, 'A');
    const pk = tp.paqueteDeAsignacion(p.root, a.assignment);
    assert.ok(pk && pk.kind === 'snapshot' && pk.revision === 1, 'la asignación arma su paquete');
    assert.equal(JSON.parse(pk.body).task_id, 'A');

    // Decisión de negocio NO bloqueante: queda registrada y NO abre ningún STOP ni frena nada.
    const nb = tp.registrarDecisionPendiente(p.root, { task_id: 'A', pregunta: '¿El descuento se redondea hacia arriba?', bloqueante: false, supuesto: 'redondeo normal' });
    assert.deepEqual([nb.ok, nb.continuar, nb.status], [true, true, 'REGISTRADA_CONTINUA']);
    assert.equal(tm.pendientes(p.root).length, 0, 'ningún STOP: se continúa');
    assert.equal(tm.estado(p.root).conteo.BLOCKED_HUMAN, 0);
    assert.equal(tp.estadoCorriente(p.root, { task_id: 'A', recipient_role: 'builder' }).pendientes_humanos.length, 1);

    // Decisión BLOQUEANTE: frena la cadena A → B, pero C (independiente) sigue.
    const bl = tp.registrarDecisionPendiente(p.root, { task_id: 'A', pregunta: '¿El descuento aplica a clientes corporativos?', bloqueante: true });
    assert.deepEqual([bl.ok, bl.continuar, bl.status], [true, false, 'REGISTRADA_BLOQUEANTE']);
    assert.ok(bl.stop.id);
    const est = tm.estado(p.root);
    const por = Object.fromEntries(est.tareas.map((t) => [t.id, t.state]));
    assert.equal(por.A, 'BLOCKED_HUMAN');
    assert.equal(por.B, 'BLOCKED_DEPENDENCY');
    assert.equal(por.C, 'READY', 'la tarea independiente no se detuvo');
    const c = tm.asignar(p.root, { owner_id: 'builder-2' });
    assert.equal(c.status, 'ASIGNADA');
    assert.equal(c.assignment.task.id, 'C', 'y se asigna mientras la decisión espera a la persona');
    // Resolver el pendiente en el paquete NO abre la cadena: eso lo decide la persona en TEAMS (origen humano probado).
    assert.equal(tp.resolverPendiente(p.root, { task_id: 'A', id: bl.decision_id, origen: 'timeout' }).code, 'TIMEOUT_NO_RESUELVE');
    assert.equal(tm.pendientes(p.root).length, 1);
    assert.equal(tm.estado(p.root).tareas.find((t) => t.id === 'A').state, 'BLOCKED_HUMAN', 'el tiempo no liberó nada');
    assert.equal(tm.resolver(p.root, { pending_id: bl.stop.id, decision: 'sí', origen: 'bot' }).status, 'ORIGEN_NO_VERIFICADO');
  } finally { p.limpiar(); }
});

test('integración con tick: asignación con paquete, ACK del paquete por el receptor, y entrega con PASS inventado → reparación, no DONE', () => {
  const p = nuevo('tick');
  try {
    fs.writeFileSync(path.join(p.root, '.agentic', 'config.md'), 'CONFIGURADO: SI\n');
    assert.equal(tm.init(p.root, { aprobarMigracion: true }).status, 'ACTIVO');
    tm.crearPlan(p.root, { id: 'P-1', objective: 'o', sprints: [{ id: 'S-1', tasks: [
      { id: 'A', objective: 'cambiar el texto del título', acceptance: ['título cambiado'], allowed_files: ['src/a.js'] },
    ] }] });
    const invento = { task_id: 'A', criteria: [{ criterio: 'título cambiado', resultado: 'PASS', evidence_ref: 'ev_' + 'c'.repeat(40) }], changed_files: [{ path: 'src/a.js', sha256: sha(fs.readFileSync(path.join(p.root, 'src', 'a.js'))) }], scope: ['src/a.js'] };
    const builder = new ad.AdapterPrueba({ owner_id: 'builder-1', producir: (a) => ({ files: a.task.allowed_files, subject_hash: 'h-A', entrega: invento }) });
    const log = ad.tick(p.root, { builder, puntos: false, verificador: () => [] });
    const pasos = log.map((x) => x.paso);
    assert.ok(pasos.includes('paquete'), 'la asignación armó su paquete');
    const ackp = log.find((x) => x.paso === 'ack-paquete');
    assert.deepEqual([ackp.recibido, ackp.status], ['APLICADO', 'ACKED'], 'el receptor (simulado) aplicó y acusó revisión + hash');
    assert.equal(builder.estadoPaquete.revision, 1);
    assert.equal(tp.estadoCorriente(p.root, { task_id: 'A', recipient_role: 'builder' }).ultima_confirmada, 1);
    const val = log.find((x) => x.paso === 'validar-entrega');
    assert.deepEqual(val.rechazos, ['UNKNOWN_REFERENCE'], 'el director comprobó el original y no existe');
    const ver = log.find((x) => x.paso === 'verificar');
    assert.equal(ver.status, 'REPARAR', 'un PASS inventado cuenta como fallo, nunca como DONE');
    assert.equal(tm.leerTarea(p.root, 'A').state, 'READY');
    assert.equal(tm.leerTarea(p.root, 'A').repairs, 1);
    // El canal MD muestra el paquete pendiente de ACK (para sesiones sin otra vía).
    tm.regenerarVistas(p.root);
    const vista = fs.readFileSync(path.join(p.root, '.legion', 'AUDITORIA-CURSOR.md'), 'utf8');
    assert.match(vista, /Paquetes de contexto pendientes de ACK/);
    // Con otra entrega, la nueva asignación vuelve a empezar con SNAPSHOT (otro intento = posible sesión nueva).
    const log2 = ad.tick(p.root, { builder: new ad.AdapterPrueba({ owner_id: 'builder-1' }), puntos: false, verificador: () => [] });
    assert.equal(log2.find((x) => x.paso === 'paquete').kind, 'snapshot');
  } finally { p.limpiar(); }
});

test('integración con tick: una entrega verificada cierra sus paquetes y libera sus pins', () => {
  const p = nuevo('tickok');
  try {
    fs.writeFileSync(path.join(p.root, '.agentic', 'config.md'), 'CONFIGURADO: SI\n');
    tm.init(p.root, { aprobarMigracion: true });
    tm.crearPlan(p.root, { id: 'P-1', objective: 'o', sprints: [{ id: 'S-1', tasks: [{ id: 'A', objective: 'cambiar el texto del título', acceptance: ['ok'], allowed_files: ['src/a.js'], risk: 'LOW' }] }] });
    const t = tm.leerTarea(p.root, 'A');
    const sujetoDisco = tp.subjectHash(p.root, ['src/a.js']);
    const ev = tp.guardarEvidenciaDeGate(p.root, { task_id: 'A', subject_hash: sujetoDisco, gate: 'relevant-check', texto: 'pass' });
    const entrega = { task_id: 'A', subject_hash: sujetoDisco, changed_files: [{ path: 'src/a.js', sha256: sha(fs.readFileSync(path.join(p.root, 'src', 'a.js'))) }], scope: ['src/a.js'], criteria: [{ criterio: 'ok', resultado: 'PASS', evidence_ref: ev.evidence_id }] };
    // La evidencia citada se fija como pin mientras la tarea esté activa.
    tp.enviar(p.root, { ...base({ task_id: 'A', scope: ['src/a.js'], risk_tier: t.effort_policy.tier || 'LOW', evidence_refs: [ev.evidence_id], sender_role: 'builder', recipient_role: 'director' }) });
    assert.deepEqual(tp.pinsActivos(p.root, 'task', 'A'), [ev.evidence_id]);
    const builder = new ad.AdapterPrueba({ owner_id: 'builder-1', producir: (a) => ({ files: a.task.allowed_files, subject_hash: 'h-A', entrega }) });
    // Gates del director sobre el sujeto EXACTO (mismo helper que la matriz de teams.test.cjs).
    const verificador = (res) => {
      const tarea = tm.leerTarea(p.root, res.task_id);
      return tm.gatesRequeridos(tarea).map((g) => require('./helpers/gates.cjs').fixtureGate(p.root, { gate: g, status: 'PASS', subject_hash: tarea.subject_hash, execution_id: 'x-' + g, evidence: [{ kind: 'fixture', subject_hash: tarea.subject_hash }] }));
    };
    const log = ad.tick(p.root, { builder, puntos: false, verificador });
    const val = log.find((x) => x.paso === 'validar-entrega');
    assert.equal(val.status, 'EVIDENCIA_VERIFICADA', 'la evidencia verificada habilita al director a correr sus gates');
    assert.deepEqual(val.rechazos, []);
    const ver = log.find((x) => x.paso === 'verificar');
    assert.equal(ver.status, 'DONE_VERIFIED', JSON.stringify(ver));
    assert.ok(log.some((x) => x.paso === 'cerrar-paquetes'));
    assert.deepEqual(tp.pinsActivos(p.root, 'task', 'A'), [], 'cerrada y verificada: los pins de la tarea se liberan');
    assert.ok(filasPaquetes(p).every((f) => f.status === 'CLOSED'));
  } finally { p.limpiar(); }
});

const SCRIPT_EMISOR = `
const [root, i, G] = process.argv.slice(1);
const tp = require(G + '/teams-packets.cjs');
const r = tp.enviar(root, { task_id: 'T-C', plan_id: 'P', sprint_id: 'S', sender_role: 'director', recipient_role: 'builder', objective: 'obj', acceptance: ['a'], scope: ['src/a.js'], risk_tier: 'LOW', next_actions: ['accion ' + i] });
console.log(JSON.stringify({ ok: r.ok, revision: r.revision, status: r.status, code: r.code }));
`;
const SCRIPT_RECLAMO = `
const [root, i, G] = process.argv.slice(1);
const tp = require(G + '/teams-packets.cjs');
const r = tp.reclamarEjecucion(root, { task_id: 'T-C', recipient_role: 'builder', revision: 1, token: 1 });
console.log(JSON.stringify({ ok: r.ok, status: r.status, code: r.code }));
`;
const correr = (script, args) => new Promise((resolve) => {
  const h = spawn(process.execPath, ['-e', script, ...args], { env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  let out = ''; let err = '';
  h.stdout.on('data', (d) => { out += d; }); h.stderr.on('data', (d) => { err += d; });
  h.on('close', (code) => resolve({ code, out: out.trim(), err }));
});

test('[prueba 11a] SIMULADO — procesos node concurrentes contra la misma base: revisiones únicas y un solo ganador de ejecución (NO son hosts reales)', async () => {
  const p = nuevo('concurrente');
  try {
    const N = 8;
    const res = await Promise.all(Array.from({ length: N }, (_, i) => correr(SCRIPT_EMISOR, [p.root, String(i), G])));
    for (const r of res) assert.equal(r.code, 0, r.err);
    const filas = res.map((r) => JSON.parse(r.out));
    assert.ok(filas.every((f) => f.ok), JSON.stringify(filas));
    const revs = filas.map((f) => f.revision).sort((a, b) => a - b);
    assert.deepEqual(revs, Array.from({ length: N }, (_, i) => i + 1), 'revisiones 1..N sin huecos ni repetidas: los emisores se serializan');
    assert.equal(filasPaquetes(p).length, N);
    // Todas las revisiones se reconstruyen (ninguna quedó a medias).
    for (let r = 1; r <= N; r++) assert.equal(tp.snapshotActual(p.root, { task_id: 'T-C', recipient_role: 'builder', revision: r }).ok, true);
    // Carrera por la EJECUCIÓN de un mismo paquete con el mismo fencing: gana exactamente uno.
    const carrera = await Promise.all(Array.from({ length: 6 }, (_, i) => correr(SCRIPT_RECLAMO, [p.root, String(i), G])));
    const rs = carrera.map((r) => JSON.parse(r.out));
    assert.equal(rs.filter((x) => x.ok).length, 1, JSON.stringify(rs));
    assert.ok(rs.filter((x) => !x.ok).every((x) => x.code === 'YA_EN_EJECUCION'));
  } finally { p.limpiar(); }
});

test('[prueba 11b] smoke dentro de HOSTS REALES (Cursor y Claude Code abiertos sobre el proyecto)', {
  skip: process.env.AKDD_HOST_SMOKE === '1' ? false : 'HOST_REAL_NO_EJECUTADO: requiere Cursor y Claude Code abiertos sobre un proyecto real (AKDD_HOST_SMOKE=1); no se sustituye por la simulación 11a',
}, () => {
  // Con hosts reales solo se comprueba lo observable sin afirmar autonomía: detección y capacidad DECLARADA.
  for (const host of ['claude-code', 'cursor']) {
    const det = ad.detectarHost(host);
    const cap = new ad.AdapterHost(process.cwd(), { host, deteccion: det }).capabilities();
    assert.notEqual(cap.status, 'AVAILABLE', host + ': el envío programático no está verificado; no se declara autónomo');
  }
});

test('[prueba 12] los adapters no certifican autonomía de host con un estado: DEGRADED/UNSUPPORTED y NO_VERIFICADO, y los límites quedan registrados', () => {
  const p = nuevo('hostlim');
  try {
    const cursor = new ad.AdapterHost(p.root, { host: 'cursor', deteccion: { instalado: true, binario: 'cursor', version: '9.9' } }).capabilities();
    assert.equal(cursor.status, 'DEGRADED');
    assert.match(cursor.nota, /NO_VERIFICADO/);
    const ausente = new ad.AdapterHost(p.root, { host: 'cursor', deteccion: { instalado: false } }).capabilities();
    assert.equal(ausente.status, 'UNSUPPORTED');
    // Con las dos sesiones MD "registradas" pero sin un ida y vuelta real verificado, tampoco es AVAILABLE.
    const md = require(path.join(G, 'teams-md-session.cjs'));
    md.registrar(p.root, { rol: 'director', host: 'claude-code' });
    md.registrar(p.root, { rol: 'builder', host: 'cursor' });
    const cap = new md.AdapterMdSesion(p.root, { rol: 'builder' }).capabilities();
    assert.equal(cap.status, 'DEGRADED');
    assert.equal(cap.motivo, 'HANDSHAKE_SIN_IDA_Y_VUELTA', 'estar registradas no prueba que respondan');
    // Los límites del host quedan dichos, junto al presupuesto de la tarea.
    router.decidirYGuardar(p.root, { task_id: 'T-9', intent: 'cambia el texto del título', paths: ['src/a.js'], index_coverage: 'COMPLETE' });
    budget.registrarNoObservado(p.root, 'T-9', { role: 'builder' });
    budget.declararProgreso(p.root, 'T-9', { afirmacion: 'ya casi' });
    const l = budget.limitesHost(p.root, 'T-9');
    assert.deepEqual([l.autonomia_host, l.herramientas_host_no_observadas, l.errores_progreso], ['NO_VERIFICADA', 1, 1]);
  } finally { p.limpiar(); }
});

test('métricas de paquetes: tipo, estado y reducción de PAYLOAD (no ahorro de sesión); sin la tabla, no disponible', () => {
  const p = nuevo('stats');
  try {
    assert.equal(tp.estadisticas(p.root).packets, 0);
    const e1 = tp.enviar(p.root, base());
    tp.ack(p.root, { task_id: 'T-1', recipient_role: 'builder', revision: 1, hash: e1.packet.body_hash });
    tp.enviar(p.root, base({ next_actions: ['a'] }));
    tp.enviar(p.root, base({ next_actions: ['a', 'b'] }));
    const s = tp.estadisticas(p.root);
    assert.equal(s.measure, 'payload_bytes');
    assert.equal(s.packets, 3);
    assert.equal(s.by_kind.snapshot.n, 1);
    assert.equal(s.by_kind.delta.n, 2);
    assert.ok(s.by_kind.delta.payload_reduction_bytes > 0);
    assert.ok(s.by_kind.delta.snapshot_equivalent_bytes > s.by_kind.delta.bytes);
    assert.equal(s.pending_ack, 2);
    assert.equal(s.by_status.ACKED, 1);
  } finally { p.limpiar(); }
  const q = proyecto('stats-sin', { catalogo: false, nodos: 0 });
  try { assert.equal(tp.estadisticas(q.root).code, 'SCHEMA_MISSING'); } finally { q.limpiar(); }
});
