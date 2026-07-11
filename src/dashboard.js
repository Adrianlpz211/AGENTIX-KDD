'use strict';

const path = require('path');
const fs = require('fs-extra');
const chalk = require('chalk');
const { execSync } = require('child_process');

async function dashboard() {
  const projectPath = process.cwd();
  const configPath = path.join(projectPath, '.agentic', 'config.md');
  const grafoCjs = path.join(projectPath, '.agentic', 'grafo', 'grafo.cjs');
  const grafoJs  = path.join(projectPath, '.agentic', 'grafo', 'grafo.js');

  if (!fs.existsSync(configPath)) {
    console.log(chalk.yellow('\n  Agentic KDD not installed in this project.'));
    console.log(chalk.gray('  Run: akdd init\n'));
    return;
  }

  // Sync graph
  const grafoPath = fs.existsSync(grafoCjs) ? grafoCjs : grafoJs;
  if (fs.existsSync(grafoPath)) {
    try {
      process.stdout.write(chalk.gray('  Syncing knowledge graph... '));
      execSync(`node "${grafoPath}" sync`, { stdio: 'pipe', cwd: projectPath });
      console.log(chalk.green('✓'));
    } catch (e) {}
  }

  // Check for local dashboard first
  const localCjs = path.join(projectPath, 'dashboard.cjs');
  const localJs  = path.join(projectPath, 'dashboard.js');
  const template = path.join(__dirname, '..', 'dashboard.cjs');

  const dashPath = fs.existsSync(localCjs) ? localCjs
                 : fs.existsSync(localJs)  ? localJs
                 : fs.existsSync(template) ? template
                 : null;

  if (!dashPath) {
    console.log(chalk.yellow('\n  Dashboard not found.'));
    console.log(chalk.gray('  Copy dashboard.cjs to your project root.\n'));
    return;
  }

  console.log(chalk.blue('\n  Agentic KDD Dashboard v4'));
  const origCwd = process.cwd();
  process.chdir(projectPath);
  try {
    require(dashPath);
  } catch (e) {
    console.log(chalk.red('  Error: ' + e.message));
    process.chdir(origCwd);
  }
}

module.exports = { dashboard };
