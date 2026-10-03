'use strict';

const path = require('path');
const fs = require('fs-extra');
const chalk = require('chalk');
const { nodo } = require('./run-safe');

async function graph() {
  const projectPath = process.cwd();
  const grafoPath = path.join(projectPath, '.agentic', 'grafo', 'grafo.cjs');
  const grafoOld  = path.join(projectPath, '.agentic', 'grafo', 'grafo.js');
  const dbPath    = path.join(projectPath, '.agentic', 'memoria.db');

  if (!fs.existsSync(path.join(projectPath, '.agentic', 'config.md'))) {
    console.log(chalk.yellow('\n  Agentic KDD no está instalado en este proyecto.'));
    console.log(chalk.gray('  Corre akdd init para instalarlo.\n'));
    return;
  }

  const grafo = fs.existsSync(grafoPath) ? grafoPath : fs.existsSync(grafoOld) ? grafoOld : null;
  if (!grafo) {
    console.log(chalk.yellow('\n  El grafo no está disponible.'));
    console.log(chalk.gray('  Actualiza con: akdd update\n'));
    return;
  }

  console.log('\n' + chalk.bold.hex('#8b5cf6')('  Agentic KDD') + chalk.gray(' — grafo de conocimiento\n'));

  // Sincronizar primero
  try {
    process.stdout.write(chalk.gray('  Sincronizando memoria... '));
    nodo(grafo, ['sync'], { cwd: projectPath });
    console.log(chalk.green('✓'));
  } catch (e) {
    console.log(chalk.yellow('⚠ ' + e.message.slice(0, 100)));
  }

  // Stats
  if (fs.existsSync(dbPath)) {
    try {
      const output = nodo(grafo, ['stats'], { cwd: projectPath }).toString();
      console.log(output);
    } catch (e) {
      console.log(chalk.red('  Error stats: ' + e.stderr?.toString().slice(0, 200)));
    }
  } else {
    console.log(chalk.yellow(`  DB no encontrada en: ${dbPath}\n`));
  }

  // Métricas si hay ciclos
  try {
    const m = JSON.parse(nodo(grafo, ['metricas'], { cwd: projectPath }).toString());
    if (m.total > 0) {
      console.log(chalk.bold('  Métricas del agente:'));
      const pct = (v) => (v == null ? '—' : v + '%');
      console.log(`  Goal Attainment: ${chalk.green(pct(m.goal_attainment))} | Autonomy: ${chalk.cyan(pct(m.autonomy_ratio))} | Handoff: ${chalk.green(pct(m.handoff_integrity))}`);
      console.log(`  Patrones aplicados: ${m.patrones_aplicados} | Errores evitados: ${m.errores_evitados}\n`);
    }
  } catch(e) {}
}

module.exports = { graph };
