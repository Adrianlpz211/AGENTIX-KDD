'use strict';

const path = require('path');
const fs = require('fs-extra');
const chalk = require('chalk');
const { nodo } = require('./run-safe');

async function analyze() {
  const projectPath = process.cwd();
  const grafoCjs = path.join(projectPath, '.agentic', 'grafo', 'grafo.cjs');

  if (!fs.existsSync(path.join(projectPath, '.agentic'))) {
    console.log(chalk.yellow('\n  Agentic KDD no está instalado en este proyecto.'));
    console.log(chalk.gray('  Corre akdd init para instalarlo.\n'));
    return;
  }

  if (!fs.existsSync(grafoCjs)) {
    console.log(chalk.yellow('\n  El grafo no está disponible.'));
    console.log(chalk.gray('  Actualiza con: akdd update\n'));
    return;
  }

  console.log('\n' + chalk.bold.hex('#8b5cf6')('  Agentic KDD') + chalk.gray(' — analizando proyecto...\n'));

  try {
    const output = nodo(grafoCjs, ['analizar'], { cwd: projectPath }).toString();
    console.log(output);
  } catch(e) {
    console.log(chalk.red('  Error: ' + e.message));
  }
}

module.exports = { analyze };
