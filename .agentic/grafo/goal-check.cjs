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

const archivoGoal = (root) => path.join(root, '.agentic', '_teams', 'goal.json');
const leerGoal = (root) => { try { return JSON.parse(fs.readFileSync(archivoGoal(root), 'utf8')); } catch { return null; } };
function guardarGoal(root, g) {
  const f = archivoGoal(root);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(g, null, 2));
  fs.renameSync(tmp, f);
}
const huella = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);

// ─── fuentes: TEAMS o sprint de aa: ──────────────────────────────────────────

function desdeTeams(root, sprintId) {
  let tm;
  try { tm = require('./teams-manager.cjs'); } catch { return null; }
  const e = tm.estado(root);
  if (!e.inicializado || !e.plan) return null;
  const pendientes = tm.pendientes(root);
  const ts = sprintId ? e.tareas.filter((t) => t.sprint_id === sprintId) : e.tareas;
  return {
    fuente: 'teams', plan_id: e.plan.id, sprint_id: sprintId || null, paused: e.paused, enabled: e.enabled,
    tareas: ts.map((t) => ({ id: t.id, estado: t.state, blocked_reason: t.blocked_reason })),
    global: pendientes.some((p) => p.scope === 'GLOBAL'),
    humanas: pendientes.filter((p) => p.decision_required).map((p) => ({ id: p.id, pregunta: p.question, bloquea: p.affected_tasks })),
  };
}

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

function presupuesto(root, f) {
  if (f.fuente !== 'teams') return null;
  try {
    const db = require('./db-adapter.cjs').openReadOnly(path.join(root, '.agentic', 'memoria.db'));
    try {
      const plan = db.get('SELECT limits, created_at FROM teams_plans WHERE id = ?', f.plan_id);
      const lim = Object.assign({}, require('./teams-manager.cjs').LIMITES_DEFECTO, JSON.parse((plan && plan.limits) || '{}'));
      const intentos = db.get('SELECT COUNT(*) AS n FROM teams_attempts a JOIN teams_tasks t ON t.id = a.task_id WHERE t.plan_id = ?', f.plan_id).n;
      const minutos = plan && plan.created_at ? (Date.now() - Date.parse(plan.created_at)) / 60000 : 0;
      if (lim.max_intentos_plan && intentos >= lim.max_intentos_plan) return { motivo: 'PRESUPUESTO_INTENTOS', intentos, limite: lim.max_intentos_plan };
      if (lim.max_minutos_plan && minutos >= lim.max_minutos_plan) return { motivo: 'PRESUPUESTO_TIEMPO', minutos: Math.round(minutos), limite: lim.max_minutos_plan };
      return null;
    } finally { db.close(); }
  } catch { return null; }
}

/** Evalúa la fase. Pura sobre el estado: no escribe nada. */
function evaluar(root, { sprint_id = null } = {}) {
  const f = desdeTeams(root, sprint_id) || desdeSprint(root);
  if (!f) return { codigo: 'GOAL_OK', motivo: 'SIN_TRABAJO', final: 'COMPLETED', nota: 'no hay plan ni sprint: nada que hacer, no se inventa trabajo', tareas: [] };
  const base = { fuente: f.fuente, plan_id: f.plan_id, sprint_id: f.sprint_id, tareas: f.tareas, humanas: f.humanas, huella: huella(f.tareas) };
  if (f.global) return Object.assign(base, { codigo: 'FALLA_GLOBAL', motivo: 'STOP_GLOBAL_ABIERTO' });
  /* REVERTED sigue abierta: volvió al punto sano, no quedó implementada. */
  const abiertas = f.tareas.filter((t) => !['DONE_VERIFIED', 'CANCELLED'].includes(t.estado));
  if (!abiertas.length) return Object.assign(base, { codigo: 'GOAL_OK', motivo: 'TODAS_VERIFICADAS', final: 'COMPLETED' });
  if (f.fuente === 'teams' && !f.enabled) return Object.assign(base, { codigo: 'ESPERA_HUMANA', motivo: 'TEAMS_DESACTIVADO' });
  if (f.paused) return Object.assign(base, { codigo: 'ESPERA_HUMANA', motivo: 'PAUSA' });
  const sinPresupuesto = presupuesto(root, f);
  if (sinPresupuesto) return Object.assign(base, { codigo: 'BLOQUEO_TECNICO', motivo: sinPresupuesto.motivo, presupuesto: sinPresupuesto });
  const ejecutables = abiertas.filter((t) => ['READY', 'RUNNING', 'VERIFYING'].includes(t.estado));
  if (ejecutables.length) return Object.assign(base, { codigo: 'SIGUE', motivo: 'TRABAJO_EJECUTABLE', siguiente: ejecutables[0].id });
  /* PENDING que no promueve: depende de algo bloqueado o fallido. */
  if (abiertas.some((t) => t.estado === 'BLOCKED_HUMAN') || f.humanas.length) return Object.assign(base, { codigo: 'ESPERA_HUMANA', motivo: 'DECISION_PENDIENTE' });
  return Object.assign(base, { codigo: 'BLOQUEO_TECNICO', motivo: 'SIN_TRABAJO_EJECUTABLE' });
}

// ─── goal opt-in por fase ────────────────────────────────────────────────────

/**
 * `continuar: true` activa el supervisor de plan: el goal sigue siendo de un
 * sprint, pero al cerrarse esa fase pasa solo al siguiente sprint con trabajo
 * ejecutable (dentro de `lookahead` sprints desde el primero abierto), con
 * los mismos turnos y el mismo control de progreso para todo el recorrido.
 */
function activar(root, { sprint_id, turnos = TURNOS_DEFECTO, continuar = false, lookahead = 1 } = {}) {
  if (!sprint_id) return { status: 'RECHAZADO', motivo: 'GOAL_POR_FASE', detalle: 'el objetivo es un sprint concreto, nunca "todo el plan": --sprint=<id>' };
  const n = Math.min(Math.max(1, Number(turnos) || TURNOS_DEFECTO), TURNOS_MAX);
  const e = evaluar(root, { sprint_id });
  if (e.motivo === 'SIN_TRABAJO') return { status: 'RECHAZADO', motivo: 'SIN_TRABAJO' };
  const g = {
    activo: true, sprint_id, turnos_max: n, turnos: 0, sin_progreso: 0, huella: e.huella, reintento_error: 0, activado_at: new Date().toISOString(),
    continuar_plan: !!continuar && e.fuente === 'teams', lookahead: Math.min(Math.max(1, Number(lookahead) || 1), LOOKAHEAD_MAX), fases: [],
  };
  guardarGoal(root, g);
  return { status: 'ACTIVO', goal: g, condicion: texto(root, { sprint_id, turnos: n }), mecanismo: MECANISMO };
}

const LOOKAHEAD_MAX = 2;
const MECANISMO = 'hook-local: la continuación la decide goal-check en el evento stop del host; no se invoca /goal del host';
const EJECUTABLE = new Set(['READY', 'RUNNING', 'VERIFYING']);
const CERRADA = new Set(['DONE_VERIFIED', 'CANCELLED']);

/** Sprints del plan en su orden, con sus tareas. */
function sprintsDelPlan(root) {
  try {
    const e = require('./teams-manager.cjs').estado(root);
    if (!e.inicializado || !e.plan) return [];
    const orden = [];
    const por = new Map();
    for (const t of e.tareas) {
      if (!por.has(t.sprint_id)) { por.set(t.sprint_id, []); orden.push(t.sprint_id); }
      por.get(t.sprint_id).push(t);
    }
    return orden.map((id) => ({ id, tareas: por.get(id) }));
  } catch { return []; }
}

/** Siguiente sprint con trabajo ejecutable dentro de la ventana; nunca inventa trabajo. */
function siguienteSprint(root, actual, lookahead) {
  const sprints = sprintsDelPlan(root);
  const primeroAbierto = sprints.findIndex((s) => s.tareas.some((t) => !CERRADA.has(t.state)));
  if (primeroAbierto < 0) return null;
  const ventana = sprints.slice(primeroAbierto, primeroAbierto + 1 + lookahead);
  return ventana.find((s) => s.id !== actual && s.tareas.some((t) => EJECUTABLE.has(t.state))) || null;
}

/** Reporte de todo el plan, sprint por sprint: lo hecho y lo que queda, con motivo. */
function reportePlan(root, motivo, g = leerGoal(root) || {}) {
  const sprints = sprintsDelPlan(root).map((s) => ({
    sprint_id: s.id,
    completadas: s.tareas.filter((t) => t.state === 'DONE_VERIFIED').map((t) => t.id),
    revertidas: s.tareas.filter((t) => t.state === 'REVERTED').map((t) => t.id),
    bloqueadas: s.tareas.filter((t) => /^BLOCKED_/.test(t.state)).map((t) => ({ id: t.id, estado: t.state, motivo: t.blocked_reason })),
    pendientes: s.tareas.filter((t) => !CERRADA.has(t.state)).map((t) => t.id),
  }));
  let humanas = [];
  try { humanas = require('./teams-manager.cjs').pendientes(root).filter((p) => p.decision_required).map((p) => ({ id: p.id, pregunta: p.question, bloquea: p.affected_tasks })); } catch { /* sin TEAMS */ }
  const pendientes = sprints.flatMap((s) => s.pendientes);
  return {
    motivo, mecanismo: MECANISMO, fases: g.fases || [], turnos: g.turnos || 0, sprints, pendientes_humanas: humanas,
    completo: pendientes.length === 0,
    resumen: pendientes.length ? `quedan ${pendientes.length} tarea(s) sin verificar: ${pendientes.join(', ')}` : 'todas las tareas del plan verificadas',
  };
}

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
  let teams = null;
  try {
    const tm = require('./teams-manager.cjs');
    if (tm.activo(root)) teams = tm.pausar(root);
  } catch { /* sin TEAMS: solo se cierra el goal */ }
  const g = cerrarGoal(root, 'PAUSA_HUMANA', { motivo_pausa: String(motivo || '').slice(0, 300) });
  return { codigo: 'ESPERA_HUMANA', motivo: 'PAUSA', goal: g, teams };
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
  if (e.fuente === 'teams') {
    try {
      const db = require('./db-adapter.cjs').openReadOnly(path.join(root, '.agentic', 'memoria.db'));
      try {
        r.evidencias = db.all("SELECT id, evidence FROM teams_tasks WHERE plan_id = ? AND state = 'DONE_VERIFIED'", e.plan_id)
          .map((x) => ({ id: x.id, evidence: JSON.parse(x.evidence || '[]') }));
        r.intentos = db.get('SELECT COUNT(*) AS n FROM teams_attempts a JOIN teams_tasks t ON t.id = a.task_id WHERE t.plan_id = ?', e.plan_id).n;
      } finally { db.close(); }
    } catch { /* el reporte sale igual sin el detalle */ }
  }
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
    case 'ESPERA_HUMANA': return e.motivo === 'PAUSA' ? 'Reanudar con teams: continuar.'
      : `Responder ${(e.humanas || []).map((h) => h.id).join(', ') || 'la decisión pendiente'} con teams: resolver <id> <decisión>.`;
    case 'FALLA_GLOBAL': return 'Revisar el incidente global en teams: pendientes antes de tocar nada.';
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
  const terminar = (motivoFase) => {
    let motivo = motivoFase;
    let plan = null;
    if (g.continuar_plan) {
      plan = reportePlan(root, motivoFase, g);
      /* El sprint actual terminó, pero el plan no: la conclusión es la del plan. */
      if (motivoFase === 'GOAL_OK' && !plan.completo) motivo = plan.pendientes_humanas.length ? 'ESPERA_HUMANA' : 'BLOQUEO_TECNICO';
      plan.motivo = motivo;
    }
    cerrarGoal(root, motivo, { fases: g.fases || [], turnos: g.turnos });
    return { seguir: false, motivo, reporte: reporte(root, { sprint_id: g.sprint_id }), plan };
  };
  let cambio = null;
  /* Supervisor de plan: la fase cerró pero otro sprint de la ventana tiene trabajo ejecutable. */
  if (e.codigo !== 'SIGUE' && g.continuar_plan && ['GOAL_OK', 'ESPERA_HUMANA', 'BLOQUEO_TECNICO'].includes(e.codigo)
    && !['PAUSA', 'TEAMS_DESACTIVADO'].includes(e.motivo) && !e.presupuesto) {
    const sig = siguienteSprint(root, g.sprint_id, g.lookahead || 1);
    if (sig) {
      g.fases = (g.fases || []).concat({ sprint_id: g.sprint_id, codigo: e.codigo, motivo: e.motivo, at: new Date().toISOString() });
      cambio = { de: g.sprint_id, a: sig.id, motivo: e.codigo };
      g.sprint_id = sig.id;
      e = evaluar(root, { sprint_id: sig.id });
    }
  }
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
    seguir: true, motivo: 'SIGUE', turno: g.turnos, cambio_de_sprint: cambio, mecanismo: g.continuar_plan ? MECANISMO : undefined,
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
    if (cmd === 'activar') console.log(JSON.stringify(activar(root, { sprint_id: opt.sprint, turnos: opt.turnos, continuar: !!opt.continuar, lookahead: opt.lookahead }), null, 2));
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
  CODIGOS, evaluar, activar, texto, pausa, reporte, reportePlan, siguienteSprint, decidirStop, salidaHook, cerrarGoal, leerGoal,
  TURNOS_MAX, SIN_PROGRESO_MAX, LOOKAHEAD_MAX, MECANISMO,
};
