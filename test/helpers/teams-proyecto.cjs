'use strict';
/**
 * Proyecto temporal con memoria.db REAL de 3.20.1 + tablas TEAMS, para las pruebas del puente al núcleo,
 * la vigilancia y el dashboard de TEAMS.
 *
 *   const { proyectoTeams } = require('./helpers/teams-proyecto.cjs');
 *   const p = proyectoTeams('cierre');                       // TEAMS activo + plan de 2 tareas
 *   const q = proyectoTeams('hijo', { conGrafo: true });     // además copia .agentic/grafo: permite correr post-cycle como hijo
 *
 * El motor de un proyecto vive en SU `.agentic/grafo` (grafo.cjs resuelve la raíz desde __dirname), así que el
 * proceso hijo de post-cycle solo puede probarse contra una copia del motor dentro del proyecto temporal.
 */
const fs = require('fs');
const path = require('path');
const { proyecto, REPO } = require('./memoria-proyecto.cjs');

const GRAFO = path.join(REPO, '.agentic', 'grafo');
const tm = require(path.join(GRAFO, 'teams-manager.cjs'));

function copiarMotor(root) {
  const destino = path.join(root, '.agentic', 'grafo');
  fs.cpSync(GRAFO, destino, {
    recursive: true,
    // Lo que no es motor: dependencias vendorizadas del dashboard, UI de grafos y artefactos de ejecución.
    filter: (src) => !/[\\/](vendor|graph-ui)([\\/]|$)/.test(src) && !/post-cycle\.log$/.test(src),
  });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'proyecto-prueba', version: '0.0.0', private: true, scripts: {} }, null, 2));
}

function tareaBase(id, files, extra) {
  return Object.assign({ id, objective: 'tarea ' + id, acceptance: ['criterio ' + id], allowed_files: files || ['src/' + id + '.js'] }, extra || {});
}

/** @returns {{root, dbPath, abrirW, abrirR, limpiar, tm, plan_id, tareas}} */
function proyectoTeams(nombre, { conGrafo = false, plan = true, tareas } = {}) {
  const p = proyecto('teams-' + nombre, { nodos: 2 });
  fs.writeFileSync(path.join(p.root, '.agentic', 'config.md'), 'CONFIGURADO: SI\nNombre: prueba\n');
  const r = tm.init(p.root, { aprobarMigracion: true });
  if (r.status !== 'ACTIVO') throw new Error('TEAMS no se activó en el proyecto de prueba: ' + JSON.stringify(r));
  let plan_id = null;
  const ts = tareas || [tareaBase('A'), tareaBase('B')];
  if (plan) {
    const c = tm.crearPlan(p.root, { objective: 'plan de prueba', sprints: [{ tasks: ts }] });
    plan_id = c.plan_id || c.id || (c.plan && c.plan.id) || null;
    if (!plan_id) {
      const db = p.abrirR(); try { plan_id = db.get('SELECT id FROM teams_plans ORDER BY created_at DESC LIMIT 1').id; } finally { db.close(); }
    }
  }
  if (conGrafo) copiarMotor(p.root);
  return Object.assign(p, { tm, plan_id, tareas: ts });
}

module.exports = { proyectoTeams, copiarMotor, tareaBase, GRAFO, REPO };
