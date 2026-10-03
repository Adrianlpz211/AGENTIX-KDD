'use strict';

/**
 * Adapters de host para TEAMS. Contrato común:
 *   capabilities() → { host, status: AVAILABLE|AUTH_REQUIRED|UNSUPPORTED|DEGRADED, transport, version }
 *   submitTask(assignment) → { delivery_id, host_session_id, accepted, ack_at, motivo? }
 *   readProgress() → resultados [{ event_id, task_id, owner_id, fencing, expected_revision, subject_hash, files, evidence }]
 *   cancelOwnedTask(task_id) · resume() · health()
 *
 * `accepted: true` solo si el host acusó recibo. Un proceso que no arrancó,
 * o un MD escrito para que una persona lo pegue, no es una entrega aceptada.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const tm = require('./teams-manager.cjs');

const CAPACIDADES = ['AVAILABLE', 'AUTH_REQUIRED', 'UNSUPPORTED', 'DEGRADED'];

/** Detecta el host instalado sin abrir sesiones ni tocar configuración. */
function detectarHost(host) {
  const candidatos = host === 'claude-code' ? [['claude', ['--version']]]
    : host === 'cursor' ? [['cursor-agent', ['--version']], ['cursor', ['--version']]] : [];
  for (const [bin, args] of candidatos) {
    const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 5000, windowsHide: true, shell: process.platform === 'win32' });
    if (r.status === 0 && String(r.stdout || '').trim()) return { instalado: true, binario: bin, version: String(r.stdout).trim().split(/\r?\n/)[0] };
  }
  return { instalado: false, binario: null, version: null };
}

/**
 * Transporte manual: deja la asignación en `.legion/BANDEJA-<rol>.md` y la
 * respuesta vuelve por `importarRespuesta`. Es lo honesto cuando el host no
 * expone una vía programática probada: no se afirma autonomía.
 */
class AdapterManual {
  constructor(root, { rol = 'builder', owner_id, host = 'manual' } = {}) {
    Object.assign(this, { root, rol, owner_id: owner_id || rol + '-manual', host });
  }

  capabilities() { return { host: this.host, status: 'DEGRADED', transport: 'MANUAL_TRANSPORT', version: null, nota: 'una persona copia la asignación al host' }; }

  submitTask(asg) {
    const bloque = '<<<AKDD-TEAMS v1\n' + JSON.stringify({ kind: 'ASSIGNMENT', owner_id: this.owner_id, ...asg }) + '\nAKDD-TEAMS>>>';
    const f = path.join(this.root, '.legion', 'BANDEJA-' + this.rol + '.md');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, `<!-- Vista generada por akdd teams. Pega este bloque al ${this.rol}; su respuesta vuelve con akdd teams import. -->\n\n${bloque}\n`);
    fs.renameSync(tmp, f);
    return { delivery_id: asg.delivery_id, host_session_id: null, accepted: false, ack_at: null, motivo: 'MANUAL_TRANSPORT' };
  }

  readProgress() { return []; }
  cancelOwnedTask() { return { status: 'MANUAL' }; }
  resume() { return { status: 'MANUAL' }; }
  health() { return { status: 'DEGRADED', transport: 'MANUAL_TRANSPORT' }; }
}

/**
 * Host real (Claude Code / Cursor). Se detecta la instalación, pero el envío
 * programático de tareas no está implementado ni probado: delega en el
 * transporte manual y lo declara. Cuando exista una vía oficial probada por
 * versión, se implementa aquí y deja de ser DEGRADED.
 */
class AdapterHost extends AdapterManual {
  constructor(root, opciones = {}) {
    super(root, opciones);
    this.deteccion = opciones.deteccion || detectarHost(this.host);
  }

  capabilities() {
    if (!this.deteccion.instalado) return { host: this.host, status: 'UNSUPPORTED', transport: 'NINGUNO', version: null, nota: 'host no instalado o fuera del PATH' };
    return { host: this.host, status: 'DEGRADED', transport: 'MANUAL_TRANSPORT', version: this.deteccion.version, nota: 'envío programático pendiente de integración y prueba real (NO_VERIFICADO)' };
  }

  health() { return { status: this.capabilities().status, transport: this.capabilities().transport }; }
}

/**
 * Adapter determinista para pruebas: inyecta sin-ACK, resultados, archivos
 * fuera de alcance o repetición del mismo código.
 */
class AdapterPrueba {
  constructor({ owner_id = 'builder-prueba', sinAck = false, producir, alEnviar } = {}) {
    Object.assign(this, { owner_id, sinAck, alEnviar, producir: producir || ((a) => ({ files: a.task.allowed_files, subject_hash: 'h-' + a.task.id })) });
    this.cola = [];
    this.sesion = 'ses-' + crypto.randomUUID().slice(0, 8);
  }

  capabilities() { return { host: 'prueba', status: 'AVAILABLE', transport: 'IN_PROCESS', version: '1' }; }

  submitTask(asg) {
    /* Un host real puede empezar a escribir en cuanto recibe la tarea, antes de acusar recibo. */
    if (typeof this.alEnviar === 'function') this.alEnviar(asg);
    if (this.sinAck) return { delivery_id: asg.delivery_id, host_session_id: null, accepted: false, ack_at: null, motivo: 'SIN_ACK' };
    this.actual = asg;
    return { delivery_id: asg.delivery_id, host_session_id: this.sesion, accepted: true, ack_at: new Date().toISOString() };
  }

  /**
   * Receptor en proceso del paquete de contexto (H02). Es SIMULADO: aplica la lógica pura de teams-packets.recibir;
   * un host real tiene que implementar lo mismo dentro de su sesión y eso no se prueba aquí.
   */
  confirmarPaquete(pk) {
    const tp = require('./teams-packets.cjs');
    const r = tp.recibir(this.estadoPaquete || null, pk);
    if (r.status === 'APLICADO') this.estadoPaquete = r.estado;
    return r;
  }

  /** Se llama después del ACK, cuando la tarea ya está RUNNING. */
  trabajar(revision) {
    const a = this.actual;
    if (!a) return;
    const p = this.producir(a);
    this.cola.push({
      event_id: 'res-' + a.delivery_id, task_id: a.task.id, owner_id: this.owner_id, fencing: a.fencing,
      expected_revision: revision, subject_hash: p.subject_hash, files: p.files, evidence: p.evidence || [],
      ...(p.entrega ? { entrega: p.entrega } : {}),
    });
    this.actual = null;
  }

  readProgress() { const c = this.cola; this.cola = []; return c; }
  cancelOwnedTask() { this.actual = null; return { status: 'CANCELLED' }; }
  resume() { return { status: 'OK' }; }
  health() { return { status: 'AVAILABLE' }; }
}

const FALLO_VERIFICACION = new Set(['REPARAR', 'BLOCKED_TECHNICAL', 'STOP']);

/** Gates que fallaron en las dos corridas: solo eso cuenta como fallo reproducible. */
function falloReproducible(primera, segunda) {
  const fallan = (gs) => new Set((gs || []).filter((g) => g.status === 'FAIL').map((g) => g.gate));
  const a = fallan(primera);
  const b = fallan(segunda);
  return a.size > 0 && [...a].some((g) => b.has(g));
}

/** Efectos externos de la tarea aún sin compensar: impiden revertir solo. */
function efectosDeTarea(root, res) {
  let propios = [];
  try { propios = require('./efectos.cjs').listar(root, { pendientes: true }).filter((e) => e.task_id === res.task_id); } catch { /* sin diario */ }
  return propios.concat(res.side_effects || []);
}

/**
 * Un paso del scheduler: asigna, captura el punto sano, entrega, recoge
 * resultados y verifica con el controlador. `verificador(resultado)` devuelve
 * gate-results del sujeto; el director añade su verificación aquí, no el
 * constructor.
 *
 * El BASELINE se toma ANTES de entregar: un host puede escribir en cuanto
 * recibe la tarea, y un ACK no da un punto sano retroactivo.
 */
function tick(root, { builder, verificador, puntos }) {
  const log = [];
  const rm = require('./restore-manager.cjs');
  const conPuntos = puntos === undefined ? rm.disponible(root) : !!puntos;
  /* Un punto por actividad de escritura, no por cada lectura. Sin Git no hay puntos. */
  const punto = (tipo, taskId, extra) => {
    if (!conPuntos) return null;
    const t = tm.leerTarea(root, taskId);
    const r = rm.crear(root, { tipo, task_id: taskId, sprint_id: t.sprint_id, archivos: t.allowed_files, label: `${tipo} ${taskId}`, ...extra });
    if (r.status === 'OK' && tipo === 'BASELINE') tm.enlazarPunto(root, { task_id: taskId, point_id: r.punto.id });
    log.push({ paso: 'punto', tipo, task_id: taskId, status: r.status, id: r.punto && r.punto.id, state: r.punto && r.punto.state });
    return r;
  };
  const asg = tm.asignar(root, { owner_id: builder.owner_id });
  log.push({ paso: 'asignar', status: asg.status, task_id: asg.assignment && asg.assignment.task.id });
  if (asg.status === 'ASIGNADA') {
    const taskId = asg.assignment.task.id;
    const base = punto('BASELINE', taskId, { attempt: asg.assignment.fencing });
    if (base && (base.status !== 'OK' || base.punto.state !== 'VERIFIED')) {
      /* Sin punto sano íntegro no se autoriza escribir. STOP de esta tarea; las independientes siguen. */
      const motivo = base.status !== 'OK' ? base.status : 'BASELINE_' + base.punto.state;
      const s = tm.stop(root, {
        reason_code: 'BASELINE_NO_OBTENIDO', scope: 'TASK', task_id: taskId, decision_required: false,
        resources: asg.assignment.task.allowed_files, evidence: [{ kind: 'restore', motivo, detalle: base.detalle || base.punto && base.punto.motivo_estado || null }],
        question: `No se pudo capturar un punto sano de ${taskId} (${motivo}); no se entregó para no escribir sin red.`,
      });
      log.push({ paso: 'baseline', task_id: taskId, status: 'NO_ENTREGADA', motivo, stop_id: s.id });
      return log;
    }
    /* H02: el estado de la tarea viaja como paquete (snapshot, o delta si el receptor ya confirmó una base). Sin la tabla de
       3.20.1 devuelve null y la entrega sigue exactamente como antes. Cada asignación (fencing nuevo) arranca con snapshot. */
    const tp = require('./teams-packets.cjs');
    const pk = tp.paqueteDeAsignacion(root, asg.assignment);
    if (pk) { asg.assignment.context_packet = pk; log.push({ paso: 'paquete', task_id: taskId, kind: pk.kind, revision: pk.revision }); }
    const sub = builder.submitTask(asg.assignment);
    log.push({ paso: 'submit', accepted: sub.accepted, motivo: sub.motivo || null });
    if (sub.accepted && sub.ack_at) {
      const a = tm.ack(root, { delivery_id: sub.delivery_id, owner_id: builder.owner_id, host_session_id: sub.host_session_id });
      log.push({ paso: 'ack', status: a.status });
      /* El ACK del PAQUETE identifica revisión y hash recibidos; lo da el receptor, no se presume por el ACK de la entrega. */
      if (pk && a.status === 'ACKED' && typeof builder.confirmarPaquete === 'function') {
        const c = builder.confirmarPaquete(pk);
        const k = c && c.ack ? tp.ack(root, { task_id: taskId, recipient_role: 'builder', revision: c.ack.revision, hash: c.ack.hash, state_hash: c.ack.state_hash }) : null;
        log.push({ paso: 'ack-paquete', task_id: taskId, recibido: c && c.status, status: k ? (k.status) : 'SIN_ACK' });
      }
      if (a.status === 'ACKED' && typeof builder.trabajar === 'function') builder.trabajar(a.revision);
    }
  }
  for (const res of builder.readProgress()) {
    const e = tm.entregarResultado(root, res);
    log.push({ paso: 'resultado', task_id: res.task_id, status: e.status });
    if (e.status === 'VERIFICANDO') punto('AFTER_UNVERIFIED', res.task_id, { attempt: res.fencing });
    if (e.status === 'VERIFICANDO' && typeof verificador === 'function') {
      /* H02: el director NO confía en el informe del constructor. Si trae criterios con evidencia, se comprueban contra los
         originales; un PASS inventado, cambiado o de otra versión cuenta como gate fallido (una reparación), nunca como DONE. */
      const extras = [];
      if (res.entrega) {
        const vp = require('./teams-packets.cjs').validarEntrega(root, { ...res.entrega, task_id: res.task_id });
        log.push({ paso: 'validar-entrega', task_id: res.task_id, status: vp.status || vp.code, rechazos: (vp.rechazos || []).map((r) => r.code) });
        if (!vp.ok) extras.push({ gate: 'evidence-originals', status: 'FAIL', subject_hash: res.subject_hash, reason_code: 'ENTREGA_RECHAZADA:' + (vp.rechazos || []).map((r) => r.code).join(',') });
      }
      const gates = (verificador(res) || []).concat(extras);
      const v = tm.verificar(root, { task_id: res.task_id, expected_revision: e.revision, event_id: 'ver-' + res.event_id, gates });
      log.push({ paso: 'verificar', task_id: res.task_id, status: v.status, faltan: v.faltan || null });
      if (typeof builder.alVerificar === 'function') builder.alVerificar(res, v);
      if (v.status === 'DONE_VERIFIED') {
        punto('AFTER_VERIFIED', res.task_id, { attempt: res.fencing, evidence: gates.map((g) => ({ gate: g.gate, status: g.status })) });
        /* Puente al núcleo común: la tarea verificada se REGISTRA (ciclo, memoria, contratos, AST, layout) con origen teams. Outbox: no se pierde. */
        try { const pu = require('./teams-puente.cjs').alVerificar(root, res.task_id); log.push({ paso: 'cierre-memoria', task_id: res.task_id, status: pu && (pu.status || (pu.ok ? 'OK' : 'DEGRADADO')) }); } catch { /* TEAMS sigue; el cierre final lo reportará pendiente */ }
        /* Cerrada y verificada: sus pins de evidencia se liberan (los de sprint/plan, solo al cerrar ese nivel). */
        try { const c = require('./teams-packets.cjs').cerrar(root, { task_id: res.task_id }); log.push({ paso: 'cerrar-paquetes', task_id: res.task_id, status: c.status || c.code }); } catch { /* auxiliar */ }
      }
      else if (FALLO_VERIFICACION.has(v.status) && conPuntos && rm.politica(root).rollback_automatico) {
        const reproducible = falloReproducible(gates, (verificador(res) || []).concat(extras));
        const rb = rm.rollbackAutomatico(root, { task_id: res.task_id, attempt: res.fencing, fallo_reproducible: reproducible, side_effects: efectosDeTarea(root, res) });
        log.push({ paso: 'rollback', task_id: res.task_id, status: rb.status, motivos: rb.motivos || null, point_id: rb.point_id || null });
      }
    }
  }
  /* Entregas que esperaban a sus dependencias (se habilitaron por entrega, no por verificación): ahora que ya cerraron, se verifican.
     Sin esto una tarea que empezó sobre una entrega aún sin verificar quedaría VERIFYING para siempre. */
  if (typeof verificador === 'function') {
    for (const w of tm.verificacionesEnEspera(root)) {
      const res = { task_id: w.task_id, subject_hash: w.subject_hash, files: w.files, owner_id: w.owner_id, fencing: null, event_id: 'esp-' + w.task_id + '-r' + w.revision };
      const gates = verificador(res) || [];
      const v = tm.verificar(root, { task_id: w.task_id, expected_revision: w.revision, event_id: 'ver-' + res.event_id, gates });
      log.push({ paso: 'verificar-en-espera', task_id: w.task_id, status: v.status, faltan: v.faltan || null });
      if (v.status === 'DONE_VERIFIED') {
        try { require('./teams-packets.cjs').cerrar(root, { task_id: w.task_id }); } catch { /* auxiliar */ }
      }
    }
  }
  return log;
}

/**
 * Adapters configurados para un proyecto real: nunca el de prueba. Si la
 * sesión del rol se registró en el canal MD, se usa ese canal; si no, el host
 * con transporte manual declarado.
 */
function adaptersDe(root) {
  const e = tm.estado(root);
  const roles = e.roles || tm.ROLES_DEFECTO;
  const md = require('./teams-md-session.cjs');
  const registradas = md.sesiones(root);
  return Object.fromEntries(Object.entries(roles).map(([rol, d]) => [rol,
    d.transport === 'md-session' || registradas[rol]
      ? new md.AdapterMdSesion(root, { rol, owner_id: rol + '-md-session' })
      : new AdapterHost(root, { rol, host: d.host, owner_id: rol + '-' + d.host })]));
}

module.exports = { CAPACIDADES, detectarHost, AdapterManual, AdapterHost, AdapterPrueba, tick, adaptersDe };
