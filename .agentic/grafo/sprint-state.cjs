'use strict';

/**
 * Sprint State — Agentic KDD v3.14 (Plan 6, C3: continuidad multi-día)
 *
 * El PLAN.md sigue siendo la verdad LEGIBLE del sprint (humanos). Este módulo
 * mantiene el espejo PARSEABLE en project_settings (key `active_sprint`) para
 * que `aa: continúa sprint` pueda reconstruir el estado exacto en un chat
 * nuevo, otro día u otra máquina — sin depender de la memoria del chatviejo.
 *
 * Regla de una sola pluma: quien avanza el sprint (el Orquestador, siguiendo
 * 09-sprint.md) actualiza AMBOS en el mismo paso — PLAN.md para humanos, esto
 * para máquinas. Si divergen, PLAN.md manda (este espejo se regenera).
 *
 * Uso CLI (lo que 09-sprint.md instruye al agente):
 *   node .agentic/grafo/sprint-state.cjs start "objetivo" "tarea 1" "tarea 2" ...
 *   node .agentic/grafo/sprint-state.cjs advance <n> <COMPLETADA|ACTIVA|SALTADA> ["nota"]
 *   node .agentic/grafo/sprint-state.cjs status
 *   node .agentic/grafo/sprint-state.cjs clear
 */

const fs = require('fs');
const path = require('path');

const safe = (fn, fb = null) => { try { return fn(); } catch { return fb; } };

function openDB(projectRoot) {
  const dbPath = path.join(projectRoot, '.agentic', 'memoria.db');
  if (!fs.existsSync(dbPath)) return null;
  try { return new (require('better-sqlite3'))(dbPath); } catch {}
  try { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(dbPath); } catch {}
  return null;
}

function ensure(db) {
  safe(() => db.exec(`CREATE TABLE IF NOT EXISTS project_settings (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now'))
  )`));
}

function getState(projectRoot) {
  const db = openDB(projectRoot || process.cwd());
  if (!db) return null;
  try {
    const row = safe(() => db.prepare(`SELECT value FROM project_settings WHERE key='active_sprint'`).get());
    return row && row.value ? safe(() => JSON.parse(row.value)) : null;
  } finally { safe(() => db.close()); }
}

function setState(projectRoot, state) {
  const db = openDB(projectRoot || process.cwd());
  if (!db) return false;
  try {
    ensure(db);
    state.actualizado = new Date().toISOString();
    safe(() => db.prepare(`INSERT OR REPLACE INTO project_settings (key, value, updated_at) VALUES ('active_sprint', ?, datetime('now'))`)
      .run(JSON.stringify(state)));
    return true;
  } finally { safe(() => db.close()); }
}

function clearState(projectRoot) {
  const db = openDB(projectRoot || process.cwd());
  if (!db) return false;
  try {
    ensure(db);
    safe(() => db.prepare(`DELETE FROM project_settings WHERE key='active_sprint'`).run());
    return true;
  } finally { safe(() => db.close()); }
}

/**
 * Una tarea puede ser un texto o `{ titulo, deps: [n...] }`. Sin `deps` se
 * asume la anterior (el sprint lineal de siempre).
 */
function startSprint(projectRoot, objetivo, tareas) {
  const lista = (tareas || []).map((t, i) => {
    const o = typeof t === 'object' && t ? t : { titulo: t };
    const deps = Array.isArray(o.deps) ? o.deps.map(Number).filter(d => d >= 1 && d !== i + 1) : (i ? [i] : []);
    const tarea = { n: i + 1, titulo: String(o.titulo || ''), deps, estado: 'PENDIENTE', nota: null };
    if (Array.isArray(o.paths)) tarea.paths = o.paths.map(String);
    return tarea;
  });
  const state = { objetivo: String(objetivo || 'sin objetivo'), iniciado: new Date().toISOString(), tareas: lista };
  activarSiguiente(state);
  asignarEsfuerzo(projectRoot, state);
  return setState(projectRoot, state) ? state : null;
}

/* Misma política que aa: y teams: el router decide al activar cada tarea. */
function asignarEsfuerzo(projectRoot, state) {
  for (const t of state.tareas) {
    if (t.estado !== 'ACTIVA' || t.effort) continue;
    try {
      const d = require('./effort-router.cjs').decidirYGuardar(projectRoot, { intent: t.titulo, paths: t.paths || [], origen: 'sprint' });
      t.effort = { task_id: d.task_id, tier: d.tier, risk: d.risk };
    } catch { /* sin router: la tarea sigue con la política por defecto */ }
  }
}

const CERRADA = new Set(['COMPLETADA', 'SALTADA']);

/**
 * Un bloqueo frena a sus descendientes y deja seguir a lo independiente.
 * Activa la primera PENDIENTE cuyas dependencias están todas cerradas.
 */
function activarSiguiente(state) {
  const porN = new Map(state.tareas.map(t => [t.n, t]));
  let cambio = true;
  while (cambio) {
    cambio = false;
    for (const t of state.tareas) {
      if (t.estado !== 'PENDIENTE') continue;
      const dep = (t.deps || []).find(d => {
        const e = porN.get(d) ? porN.get(d).estado : 'DESCONOCIDA';
        return e === 'BLOQUEADA' || e === 'DESCONOCIDA' || /^BLOQUEADA_POR/.test(e);
      });
      if (dep !== undefined) { t.estado = 'BLOQUEADA_POR_T' + dep; cambio = true; }
    }
  }
  if (state.tareas.some(t => t.estado === 'ACTIVA')) return;
  const sig = state.tareas.find(t => t.estado === 'PENDIENTE'
    && (t.deps || []).every(d => porN.get(d) && CERRADA.has(porN.get(d).estado)));
  if (sig) sig.estado = 'ACTIVA';
}

function advance(projectRoot, n, estado, nota) {
  const state = getState(projectRoot);
  if (!state || !Array.isArray(state.tareas)) return null;
  const t = state.tareas.find(x => x.n === n);
  if (!t) return null;
  t.estado = estado;
  if (nota) t.nota = String(nota).slice(0, 200);
  if (CERRADA.has(estado) || estado === 'BLOQUEADA') activarSiguiente(state);
  asignarEsfuerzo(projectRoot, state);
  return setState(projectRoot, state) ? state : null;
}

function renderStatus(state) {
  if (!state) return 'Sin sprint activo. (aa: sprint — [objetivo] para iniciar uno)';
  const done = state.tareas.filter(t => t.estado === 'COMPLETADA').length;
  const L = [];
  L.push(`🏃 Sprint activo: ${state.objetivo}`);
  L.push(`   Progreso: ${done}/${state.tareas.length} · iniciado: ${String(state.iniciado).slice(0, 10)} · actualizado: ${String(state.actualizado || '').slice(0, 16).replace('T', ' ')}`);
  state.tareas.forEach(t => {
    const icon = { COMPLETADA: '✅', ACTIVA: '▶️', PENDIENTE: '⬜', SALTADA: '⏭️', BLOQUEADA: '⛔' }[t.estado]
      || (/^BLOQUEADA_POR/.test(t.estado) ? '⛔' : '·');
    L.push(`   ${icon} T${t.n}: ${t.titulo}${t.nota ? ` — ${t.nota}` : ''}`);
  });
  const activa = state.tareas.find(t => t.estado === 'ACTIVA');
  L.push(activa ? `   → Para retomar: continuar con T${activa.n} (${activa.titulo})` : '   → Todas las tareas cerradas: correr el cierre del sprint y clear.');
  return L.join('\n');
}

if (require.main === module) {
  const [, , cmd, ...args] = process.argv;
  const root = process.cwd();
  if (cmd === 'start') {
    const [objetivo, ...tareas] = args;
    const s = startSprint(root, objetivo, tareas);
    console.log(s ? renderStatus(s) : '⚠️ No se pudo iniciar (¿memoria.db existe?)');
  } else if (cmd === 'advance') {
    const s = advance(root, parseInt(args[0], 10), args[1] || 'COMPLETADA', args[2]);
    console.log(s ? renderStatus(s) : '⚠️ No se pudo avanzar (¿sprint activo? ¿n válido?)');
  } else if (cmd === 'clear') {
    console.log(clearState(root) ? '✅ Sprint activo limpiado.' : '⚠️ Nada que limpiar.');
  } else {
    console.log(renderStatus(getState(root)));
  }
}

module.exports = { getState, setState, clearState, startSprint, advance, renderStatus, activarSiguiente };
