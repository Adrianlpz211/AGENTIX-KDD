'use strict';

/**
 * goal-check — ¿se cumplió el objetivo de la fase? Independiente del proveedor.
 *
 *   GOAL_OK          todas las tareas requeridas verificadas (o no hay nada que hacer)
 *   SIGUE            queda trabajo ejecutable
 *   ESPERA_HUMANA    lo que queda espera a una persona (se imprime también GOAL_ESPERA)
 *   BLOQUEO_TECNICO  sin trabajo ejecutable por fallos, límites o presupuesto
 *   FALLA_GLOBAL     hay un STOP global abierto
 *
 * El progreso se mide por estados y hashes de las tareas, no por mensajes.
 * El objetivo es por fase (un sprint), nunca "todo el plan", y solo se
 * persigue en bucle si alguien lo activó con `activar`. Una pausa de la
 * persona cierra el goal: no se reintenta.
 *
 * La fuente es el sprint de `aa: sprint` (sprint-state).
 *
 * Uso:
 *   node goal-check.cjs [--sprint=S] [--json]         evalúa e imprime el código
 *   node goal-check.cjs activar --sprint=S [--turnos=N]
 *   node goal-check.cjs texto [--sprint=S] [N]        condición para /goal del host
 *   node goal-check.cjs pausa "motivo"
 *   node goal-check.cjs reporte
 *   node goal-check.cjs --hook=cursor|claude          (stdin JSON del evento stop)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CODIGOS = ['GOAL_OK', 'SIGUE', 'ESPERA_HUMANA', 'BLOQUEO_TECNICO', 'FALLA_GLOBAL'];
const TURNOS_DEFECTO = 20;
const TURNOS_MAX = 50;
const SIN_PROGRESO_MAX = 2;

const archivoGoal = (root) => path.join(root, '.agentic', '_goal', 'goal.json');
const leerGoal = (root) => { try { return JSON.parse(fs.readFileSync(archivoGoal(root), 'utf8')); } catch { return null; } };
function guardarGoal(root, g) {
  const f = archivoGoal(root);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(g, null, 2));
  fs.renameSync(tmp, f);
}
const huella = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);

// ─── fuente: sprint de aa: ──────────────────────────────────────────────────

const MAPA_SPRINT = { PENDIENTE: 'PENDING', ACTIVA: 'READY', COMPLETADA: 'DONE_VERIFIED', SALTADA: 'CANCELLED', BLOQUEADA: 'BLOCKED_HUMAN' };

function desdeSprint(root) {
  let st;
  try { st = require('./sprint-state.cjs').getState(root); } catch { return null; }
  if (!st || !Array.isArray(st.tareas)) return null;
  return {
    fuente: 'sprint', plan_id: null, sprint_id: st.objetivo, paused: false, enabled: true,
    tareas: st.tareas.map((t) => ({ id: 'T' + t.n, estado: MAPA_SPRINT[t.estado] || (/^BLOQUEADA_POR/.test(t.estado) ? 'BLOCKED_DEPENDENCY' : 'PENDING'), blocked_reason: t.nota })),
    global: false,
    humanas: st.tareas.filter((t) => t.estado === 'BLOQUEADA').map((t) => ({ id: 'T' + t.n, pregunta: t.nota, bloquea: ['T' + t.n] })),
  };
}

/** Evalúa la fase. Pura sobre el estado: no escribe nada. */
function evaluar(root, { sprint_id = null } = {}) {
  const f = desdeSprint(root);
  if (!f) return { codigo: 'GOAL_OK', motivo: 'SIN_TRABAJO', final: 'COMPLETED', nota: 'no hay plan ni sprint: nada que hacer, no se inventa trabajo', tareas: [] };
  const base = { fuente: f.fuente, plan_id: f.plan_id, sprint_id: f.sprint_id, tareas: f.tareas, humanas: f.humanas, huella: huella(f.tareas) };
  if (f.global) return Object.assign(base, { codigo: 'FALLA_GLOBAL', motivo: 'STOP_GLOBAL_ABIERTO' });
  /* REVERTED sigue abierta: volvió al punto sano, no quedó implementada. */
  const abiertas = f.tareas.filter((t) => !['DONE_VERIFIED', 'CANCELLED'].includes(t.estado));
  if (!abiertas.length) return Object.assign(base, { codigo: 'GOAL_OK', motivo: 'TODAS_VERIFICADAS', final: 'COMPLETED' });
  if (f.paused) return Object.assign(base, { codigo: 'ESPERA_HUMANA', motivo: 'PAUSA' });
  const ejecutables = abiertas.filter((t) => ['READY', 'RUNNING', 'VERIFYING'].includes(t.estado));
  if (ejecutables.length) return Object.assign(base, { codigo: 'SIGUE', motivo: 'TRABAJO_EJECUTABLE', siguiente: ejecutables[0].id });
  /* PENDING que no promueve: depende de algo bloqueado o fallido. */
  if (abiertas.some((t) => t.estado === 'BLOCKED_HUMAN') || f.humanas.length) return Object.assign(base, { codigo: 'ESPERA_HUMANA', motivo: 'DECISION_PENDIENTE' });
  return Object.assign(base, { codigo: 'BLOQUEO_TECNICO', motivo: 'SIN_TRABAJO_EJECUTABLE' });
}

// ─── goal opt-in por fase ────────────────────────────────────────────────────

/** Activa el objetivo de UN sprint (nunca «todo el plan»), con tope de turnos. */
function activar(root, { sprint_id, turnos = TURNOS_DEFECTO } = {}) {
  if (!sprint_id) return { status: 'RECHAZADO', motivo: 'GOAL_POR_FASE', detalle: 'el objetivo es un sprint concreto, nunca "todo el plan": --sprint=<id>' };
  const n = Math.min(Math.max(1, Number(turnos) || TURNOS_DEFECTO), TURNOS_MAX);
  const e = evaluar(root, { sprint_id });
  if (e.motivo === 'SIN_TRABAJO') return { status: 'RECHAZADO', motivo: 'SIN_TRABAJO' };
  const g = {
    activo: true, sprint_id, turnos_max: n, turnos: 0, sin_progreso: 0, huella: e.huella, reintento_error: 0, activado_at: new Date().toISOString(),
    fases: [],
  };
  guardarGoal(root, g);
  return { status: 'ACTIVO', goal: g, condicion: texto(root, { sprint_id, turnos: n }), mecanismo: MECANISMO };
}

const MECANISMO = 'hook-local: la continuación la decide goal-check en el evento stop del host; no se invoca /goal del host';

function cerrarGoal(root, motivo, extra = {}) {
  const g = leerGoal(root);
  if (!g) return null;
  Object.assign(g, { activo: false, cerrado_por: motivo, cerrado_at: new Date().toISOString() }, extra);
  guardarGoal(root, g);
  return g;
}

/** Condición en texto plano para el /goal del host: sin marcadores que el modelo tenga que rellenar. */
function texto(root, { sprint_id, turnos = TURNOS_DEFECTO } = {}) {
  const fase = sprint_id ? `el sprint ${sprint_id}` : 'la fase actual';
  return `Trabaja solo en ${fase}. Después de cada tarea corre node .agentic/grafo/goal-check.cjs${sprint_id ? ' --sprint=' + sprint_id : ''}. `
    + `Termina cuando imprima GOAL_OK o GOAL_ESPERA, o después de ${turnos} turnos. `
    + 'Si imprime BLOQUEO_TECNICO o FALLA_GLOBAL, para y reporta. No decidas lo que espera a la persona.';
}

/** La pausa de la persona cierra el goal en vez de contarse como incumplimiento. */
function pausa(root, motivo) {
  const g = cerrarGoal(root, 'PAUSA_HUMANA', { motivo_pausa: String(motivo || '').slice(0, 300) });
  return { codigo: 'ESPERA_HUMANA', motivo: 'PAUSA', goal: g };
}

// ─── reporte final: una sola conclusión ──────────────────────────────────────

function reporte(root, { sprint_id = null } = {}) {
  const e = evaluar(root, { sprint_id });
  const r = {
    codigo: e.codigo, motivo: e.motivo, fuente: e.fuente || null, plan_id: e.plan_id || null, sprint_id: e.sprint_id || null,
    completadas: e.tareas.filter((t) => t.estado === 'DONE_VERIFIED').map((t) => t.id),
    revertidas: e.tareas.filter((t) => t.estado === 'REVERTED').map((t) => t.id),
    pendientes_humanas: e.humanas || [],
    bloqueadas: e.tareas.filter((t) => /^BLOCKED_/.test(t.estado)).map((t) => ({ id: t.id, estado: t.estado, motivo: t.blocked_reason })),
    sin_verificar: e.tareas.filter((t) => !['DONE_VERIFIED', 'CANCELLED'].includes(t.estado)).map((t) => t.id),
    siguiente_accion: siguienteAccion(e),
  };
  r.huella = huella([r.codigo, e.tareas]);
  const g = leerGoal(root) || {};
  r.ya_reportado = g.ultimo_reporte === r.huella;
  if (!r.ya_reportado && e.codigo !== 'SIGUE' && fs.existsSync(path.join(root, '.agentic'))) {
    guardarGoal(root, Object.assign(g, { ultimo_reporte: r.huella }));
  }
  return r;
}

function siguienteAccion(e) {
  switch (e.codigo) {
    case 'GOAL_OK': return 'Nada pendiente en esta fase.';
    case 'SIGUE': return `Continuar con ${e.siguiente}.`;
    case 'ESPERA_HUMANA': return e.motivo === 'PAUSA' ? 'Reanudar el sprint con aa: continúa sprint.'
      : `Resolver ${(e.humanas || []).map((h) => h.id).join(', ') || 'la decisión pendiente'} y continuar con aa: continúa sprint.`;
    case 'FALLA_GLOBAL': return 'Revisar el incidente global antes de tocar nada.';
    default: return 'Revisar las tareas bloqueadas y replanificar o resolver la causa técnica.';
  }
}

// ─── hook de stop del host ───────────────────────────────────────────────────

/**
 * Decide si el host sigue otro turno. Solo con un goal activo; respeta el
 * corte de la persona (aborted), la pausa y un solo reintento ante error.
 * El tope real son los turnos propios + loop_limit del host.
 */
function decidirStop(root, entrada = {}) {
  const g = leerGoal(root);
  if (!g || !g.activo) return { seguir: false, motivo: 'SIN_GOAL' };
  const estadoHost = entrada.status || null;
  if (estadoHost === 'aborted') { cerrarGoal(root, 'CORTE_DE_LA_PERSONA'); return { seguir: false, motivo: 'CORTE_DE_LA_PERSONA' }; }
  let e = evaluar(root, { sprint_id: g.sprint_id });
  const terminar = (motivo) => {
    cerrarGoal(root, motivo, { fases: g.fases || [], turnos: g.turnos });
    return { seguir: false, motivo, reporte: reporte(root, { sprint_id: g.sprint_id }) };
  };
  const cambio = null;
  if (e.codigo !== 'SIGUE') return terminar(e.codigo);
  if (estadoHost === 'error') {
    if (g.reintento_error >= 1) return terminar('ERROR_REPETIDO');
    g.reintento_error += 1;
  }
  g.turnos += 1;
  if (e.huella === g.huella && !cambio) g.sin_progreso += 1; else { g.sin_progreso = 0; g.huella = e.huella; }
  if (g.turnos >= g.turnos_max) return terminar('TOPE_DE_TURNOS');
  if (g.sin_progreso > SIN_PROGRESO_MAX) return terminar('SIN_PROGRESO');
  guardarGoal(root, g);
  const previo = cambio ? `El sprint ${cambio.de} quedó en ${cambio.motivo}; lo independiente sigue. ` : '';
  return {
    seguir: true, motivo: 'SIGUE', turno: g.turnos, cambio_de_sprint: cambio, 
    mensaje: `${previo}Sigue con el sprint ${g.sprint_id}: próxima tarea ${e.siguiente}. Al cerrarla corre node .agentic/grafo/goal-check.cjs --sprint=${g.sprint_id}.`,
  };
}

function salidaHook(host, d) {
  if (host === 'claude') return d.seguir ? { decision: 'block', reason: d.mensaje } : {};
  return d.seguir ? { followup_message: d.mensaje } : {};
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function rootDe(entrada) {
  const r = (entrada && Array.isArray(entrada.workspace_roots) && entrada.workspace_roots[0]) || (entrada && entrada.cwd) || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return path.resolve(String(r).replace(/^\/([a-z]):\//i, '$1:/'));
}

function imprimir(e, json) {
  if (json) { console.log(JSON.stringify(e, null, 2)); return; }
  console.log(e.codigo === 'ESPERA_HUMANA' ? 'GOAL_ESPERA (ESPERA_HUMANA)' : e.codigo);
  console.log('  motivo: ' + e.motivo + (e.siguiente ? ' · siguiente: ' + e.siguiente : ''));
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; }));
  const pos = args.filter((a) => !a.startsWith('--'));
  if (opt.hook) {
    let buf = '';
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => {
      let entrada = {};
      try { entrada = JSON.parse(buf || '{}'); } catch { /* sin entrada: sin goal que seguir */ }
      let d = { seguir: false };
      try { d = decidirStop(rootDe(entrada), entrada); } catch { /* ante error, dejar parar */ }
      process.stdout.write(JSON.stringify(salidaHook(opt.hook, d)));
      process.exit(0);
    });
  } else {
    const root = process.cwd();
    const cmd = pos[0];
    if (cmd === 'activar') console.log(JSON.stringify(activar(root, { sprint_id: opt.sprint, turnos: opt.turnos }), null, 2));
    else if (cmd === 'texto') console.log(texto(root, { sprint_id: opt.sprint || null, turnos: Number(pos[1]) || TURNOS_DEFECTO }));
    else if (cmd === 'pausa') imprimir(pausa(root, pos.slice(1).join(' ')), opt.json);
    else if (cmd === 'reporte') console.log(JSON.stringify(reporte(root, { sprint_id: opt.sprint || null }), null, 2));
    else {
      const e = evaluar(root, { sprint_id: opt.sprint || null });
      imprimir(e, opt.json);
      process.exit(e.codigo === 'GOAL_OK' || e.codigo === 'ESPERA_HUMANA' || e.codigo === 'SIGUE' ? 0 : 2);
    }
  }
}

module.exports = {
  CODIGOS, evaluar, activar, texto, pausa, reporte, decidirStop, salidaHook, cerrarGoal, leerGoal,
  TURNOS_MAX, SIN_PROGRESO_MAX, MECANISMO,
};
