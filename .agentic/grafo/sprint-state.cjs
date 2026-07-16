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
    ensure(db);
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

function startSprint(projectRoot, objetivo, tareas) {
  const state = {
    objetivo: String(objetivo || 'sin objetivo'),
    iniciado: new Date().toISOString(),
    tareas: (tareas || []).map((t, i) => ({ n: i + 1, titulo: String(t), estado: i === 0 ? 'ACTIVA' : 'PENDIENTE', nota: null })),
  };
  return setState(projectRoot, state) ? state : null;
}

function advance(projectRoot, n, estado, nota) {
  const state = getState(projectRoot);
  if (!state || !Array.isArray(state.tareas)) return null;
  const t = state.tareas.find(x => x.n === n);
  if (!t) return null;
  t.estado = estado;
  if (nota) t.nota = String(nota).slice(0, 200);
  // si se completó/saltó y hay una siguiente PENDIENTE, activarla
  if ((estado === 'COMPLETADA' || estado === 'SALTADA')) {
    const sig = state.tareas.find(x => x.n > n && x.estado === 'PENDIENTE');
    if (sig) sig.estado = 'ACTIVA';
  }
  return setState(projectRoot, state) ? state : null;
}

function renderStatus(state) {
  if (!state) return 'Sin sprint activo. (aa: sprint — [objetivo] para iniciar uno)';
  const done = state.tareas.filter(t => t.estado === 'COMPLETADA').length;
  const L = [];
  L.push(`🏃 Sprint activo: ${state.objetivo}`);
  L.push(`   Progreso: ${done}/${state.tareas.length} · iniciado: ${String(state.iniciado).slice(0, 10)} · actualizado: ${String(state.actualizado || '').slice(0, 16).replace('T', ' ')}`);
  state.tareas.forEach(t => {
    const icon = { COMPLETADA: '✅', ACTIVA: '▶️', PENDIENTE: '⬜', SALTADA: '⏭️' }[t.estado] || '·';
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

module.exports = { getState, setState, clearState, startSprint, advance, renderStatus };
