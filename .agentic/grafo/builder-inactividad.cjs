'use strict';

/**
 * ¿El constructor se detuvo de verdad? Se decide con señales del propio
 * protocolo, nunca con la fecha de modificación de archivos:
 *
 *   - tarea RUNNING con ACK (un constructor que espera al director no está atascado)
 *   - último latido real (ack/heartbeat renuevan el lease)
 *   - gracia por tier: una tarea HIGH puede pensar más sin escribir
 *   - confirmación con dos sondeos independientes, ambos "no vive"
 *
 * Sin latido real solo hay una sospecha DEGRADED, nunca una emergencia.
 * Es aritmética: el temporizador no necesita consultar a una IA por tick.
 */

const tm = require('./teams-manager.cjs');

const LATIDO_MS = 30 * 1000;
const LATIDOS_AUSENTES = 3;
const GRACIA_MS = { LOW: 60 * 1000, MEDIUM: 2 * 60 * 1000, HIGH: 5 * 60 * 1000 };

function evaluar(root, { ahora = Date.now(), heartbeat_soportado = false, sondear = null, latido_ms = LATIDO_MS } = {}) {
  const est = tm.estado(root);
  if (!est.inicializado || !est.enabled) return { status: 'SIN_TEAMS', tareas: [] };
  const corriendo = tm.actividadConstructor(root);
  if (!corriendo.length) {
    const esperando = est.tareas.some((t) => ['VERIFYING', 'BLOCKED_HUMAN', 'BLOCKED_DEPENDENCY'].includes(t.state));
    return { status: 'NO_ATASCADO', motivo: esperando ? 'ESPERANDO_DIRECTOR_O_PERSONA' : 'SIN_TRABAJO_EN_CURSO', tareas: [] };
  }
  const tareas = corriendo.map((t) => {
    if (!heartbeat_soportado) {
      return { ...t, status: 'DEGRADED_HEURISTICO', detalle: 'el transporte no da latidos reales: no se puede afirmar que el constructor se detuvo' };
    }
    const ausente = t.ultimo_latido_ms == null ? Infinity : ahora - t.ultimo_latido_ms;
    const umbral = LATIDOS_AUSENTES * latido_ms + (GRACIA_MS[t.tier] || GRACIA_MS.MEDIUM);
    if (ausente < umbral) return { ...t, status: 'ACTIVO', ausente_ms: ausente, umbral_ms: umbral };
    const sondeos = typeof sondear === 'function' ? (sondear(t) || []) : [];
    const fuentes = new Set(sondeos.map((s) => s.fuente));
    if (sondeos.some((s) => s.vivo === true)) return { ...t, status: 'ACTIVO', ausente_ms: ausente, umbral_ms: umbral, detalle: 'un sondeo lo ve vivo: trabaja sin latir' };
    if (fuentes.size >= 2 && sondeos.every((s) => s.vivo === false)) return { ...t, status: 'CONFIRMADO', ausente_ms: ausente, umbral_ms: umbral, sondeos };
    return { ...t, status: 'SOSPECHA', ausente_ms: ausente, umbral_ms: umbral, detalle: 'faltan dos sondeos independientes que lo confirmen' };
  });
  const peor = ['CONFIRMADO', 'SOSPECHA', 'DEGRADED_HEURISTICO', 'ACTIVO'].find((s) => tareas.some((t) => t.status === s));
  return { status: peor, tareas };
}

/**
 * Solo para lo CONFIRMADO: un intento de recuperación del adapter; si no
 * vuelve, STOP de esa tarea (lo independiente sigue) y un aviso único.
 */
function actuar(root, resultado, { recuperar = null, ahora = Date.now() } = {}) {
  const acciones = [];
  for (const t of resultado.tareas.filter((x) => x.status === 'CONFIRMADO')) {
    let recuperado = false;
    if (typeof recuperar === 'function') { try { recuperado = recuperar(t) === true; } catch { recuperado = false; } }
    if (recuperado) { acciones.push({ task_id: t.task_id, accion: 'RECUPERADO' }); continue; }
    const incidente = `${t.task_id}#${t.fencing || 0}`;
    const s = tm.stop(root, {
      reason_code: 'CONSTRUCTOR_INTERRUMPIDO', scope: 'TASK', task_id: t.task_id, decision_required: false,
      evidence: [{ kind: 'inactividad', ausente_ms: t.ausente_ms, umbral_ms: t.umbral_ms, sondeos: t.sondeos }],
    });
    let aviso = { status: 'SIN_WHATSAPP' };
    try {
      aviso = require('./whatsapp-manager.cjs').notificar(root, {
        evento: 'CONSTRUCTOR_INTERRUMPIDO', incident_id: incidente, tarea: t.task_id,
        que: `sin latido hace ${Math.round(t.ausente_ms / 60000)} min y dos sondeos no lo ven vivo`, sigue: 'las tareas independientes', accion: 'revisar la sesión del constructor',
      }, { ahora });
    } catch { /* WhatsApp es opcional */ }
    acciones.push({ task_id: t.task_id, accion: 'STOP', stop: s.id || s.status, aviso: aviso.status });
  }
  return acciones;
}

module.exports = { evaluar, actuar, LATIDO_MS, LATIDOS_AUSENTES, GRACIA_MS };

/* El latido lo declara el adapter del constructor; los de host de hoy no lo dan. */
if (require.main === module) {
  const root = process.cwd();
  let latido = false;
  try {
    const { builder } = require('./teams-adapters.cjs').adaptersDe(root);
    latido = !!(builder && builder.capabilities().heartbeat === true);
  } catch { /* sin adapters: sin latido */ }
  const r = evaluar(root, { heartbeat_soportado: latido });
  const acciones = r.status === 'CONFIRMADO' ? actuar(root, r) : [];
  console.log(JSON.stringify(Object.assign({ heartbeat_soportado: latido }, r, { acciones }), null, 2));
}
