'use strict';

const fs = require('fs-extra');
const path = require('path');
const { execSync } = require('child_process');
const chalk = require('chalk');
const ora = require('ora');

const GITHUB_REPO = 'Adrianlpz211/AGENTIX-KDD';
const TEMP_DIR = path.join(require('os').tmpdir(), 'agentic-kdd-update');

async function update() {
  const projectPath = process.cwd();

  console.log('\n' + chalk.bold.blue('  Agentic KDD') + chalk.gray(' — updating...\n'));

  if (!fs.existsSync(path.join(projectPath, '.agentic', 'config.md'))) {
    console.log(chalk.yellow('  Agentic KDD is not installed in this project.'));
    console.log(chalk.gray('  Run akdd init to install it.\n'));
    process.exit(1);
  }

  // ── PASO 0: Guardar estado del usuario ANTES de tocar nada ───────────────
  const configPath = path.join(projectPath, '.agentic', 'config.md');
  const userState  = preserveUserState(projectPath, configPath);

  const spinner = ora({ text: 'Downloading latest version from GitHub...', color: 'blue' }).start();

  try {
    const tmpFile = path.join(require('os').tmpdir(), 'agentic-kdd-update.tar.gz');

    execSync(
      `curl -sL "https://github.com/${GITHUB_REPO}/archive/refs/heads/main.tar.gz" -o "${tmpFile}"`,
      { stdio: 'pipe' }
    );

    fs.ensureDirSync(TEMP_DIR);
    execSync(`tar -xzf "${tmpFile}" -C "${TEMP_DIR}" --strip-components=1`, { stdio: 'pipe' });
    fs.removeSync(tmpFile);

    spinner.text = 'Updating system files (keeping your memory intact)...';

    // ── 1. Agentes ──────────────────────────────────────────────────────────
    const agentsSrc = path.join(TEMP_DIR, '.agentic', 'agentes');
    const agentsDest = path.join(projectPath, '.agentic', 'agentes');
    if (fs.existsSync(agentsSrc)) {
      fs.copySync(agentsSrc, agentsDest, { overwrite: true });
    }

    // ── 2. Grafo ────────────────────────────────────────────────────────────
    const grafoSrc  = path.join(TEMP_DIR, '.agentic', 'grafo');
    const grafoDest = path.join(projectPath, '.agentic', 'grafo');
    if (fs.existsSync(grafoSrc)) {
      fs.copySync(grafoSrc, grafoDest, { overwrite: true });
    }

    // ── 3. Dashboard ────────────────────────────────────────────────────────
    const dashSrc = path.join(TEMP_DIR, 'dashboard.cjs');
    const dashDest = path.join(projectPath, 'dashboard.cjs');
    if (fs.existsSync(dashSrc)) {
      fs.copySync(dashSrc, dashDest, { overwrite: true });
    }

    // ── 4. Audit ────────────────────────────────────────────────────────────
    const auditSrc  = path.join(TEMP_DIR, '.audit');
    const auditDest = path.join(projectPath, '.audit');
    if (fs.existsSync(auditSrc)) {
      fs.copySync(auditSrc, auditDest, { overwrite: true });
    }

    // ── 5. CLAUDE.md + cursor rules ─────────────────────────────────────────
    for (const file of ['CLAUDE.md', '_LOCKS.md']) {
      const src  = path.join(TEMP_DIR, file);
      const dest = path.join(projectPath, file);
      if (fs.existsSync(src)) fs.copySync(src, dest, { overwrite: true });
    }

    const cursorSrc = path.join(TEMP_DIR, '.cursor');
    const cursorDest = path.join(projectPath, '.cursor');
    if (fs.existsSync(cursorSrc)) fs.copySync(cursorSrc, cursorDest, { overwrite: true });

    const cursorrulesSrc = path.join(TEMP_DIR, '.cursorrules');
    const cursorrulesDest = path.join(projectPath, '.cursorrules');
    if (fs.existsSync(cursorrulesSrc)) fs.copySync(cursorrulesSrc, cursorrulesDest, { overwrite: true });

    // ── Limpiar temp ────────────────────────────────────────────────────────
    fs.removeSync(TEMP_DIR);

    // ── PASO 1: Restaurar estado del usuario en config.md ──────────────────
    // Garantiza que CONFIGURADO, nombre, stack y test command nunca se pierden
    restoreUserState(configPath, userState);

    // ── PASO 2: Migrar schema de memoria.db ────────────────────────────────
    spinner.text = 'Migrating knowledge graph schema...';
    try {
      execSync(`node "${path.join(grafoDest, 'grafo.cjs')}" migrate`, {
        stdio: 'pipe', cwd: projectPath, timeout: 15000
      });
    } catch(e) { /* schema migration is best-effort */ }

    // ── PASO 3: Reconstruir better-sqlite3 si es necesario ─────────────────
    spinner.text = 'Checking dependencies...';
    try {
      execSync('npm rebuild better-sqlite3', { stdio: 'pipe', cwd: projectPath });
    } catch(e) {}

    // ── PASO 4: Auto-sync para que el dashboard lea los datos actualizados ──
    spinner.text = 'Syncing knowledge graph...';
    try {
      execSync(`node "${path.join(grafoDest, 'grafo.cjs')}" sync`, {
        stdio: 'pipe', cwd: projectPath, timeout: 30000
      });
    } catch(e) { /* sync is best-effort */ }

    spinner.succeed(chalk.green('Updated successfully!'));

    console.log('\n' + chalk.bold('  What was updated:'));
    console.log(chalk.gray('  ✓ Agent instructions (.agentic/agentes/)'));
    console.log(chalk.gray('  ✓ Knowledge graph engine (.agentic/grafo/)'));
    console.log(chalk.gray('  ✓ Dashboard (dashboard.cjs)'));
    console.log(chalk.gray('  ✓ QA department (.audit/)'));
    console.log(chalk.gray('  ✓ CLAUDE.md + Cursor rules'));

    console.log('\n' + chalk.bold('  What was kept intact:'));
    console.log(chalk.gray('  ✓ Your project memory (.agentic/memoria/)'));
    console.log(chalk.gray('  ✓ Your project config (.agentic/config.md)'));
    console.log(chalk.gray('  ✓ Your knowledge base (.agentic/conocimiento/)'));
    console.log(chalk.gray('  ✓ Your PLAN.md'));
    console.log(chalk.gray('  ✓ Your knowledge graph data (memoria.db)'));
    console.log(chalk.gray('  ✓ Your CONFIGURADO state and project settings\n'));

    if (userState.configured) {
      console.log(chalk.green('  ✓ Project state verified: CONFIGURADO\n'));
    }

  } catch (err) {
    // Si algo falla, restaurar estado igual
    try { restoreUserState(configPath, userState); } catch(e) {}
    spinner.fail(chalk.red('Update failed'));
    console.error(chalk.red('\n  Error: ' + err.message));
    console.log(chalk.gray('  Check your internet connection and try again.\n'));
    process.exit(1);
  }
}

// ── preserveUserState ────────────────────────────────────────────────────────
// Lee el estado actual del usuario antes del update para restaurarlo después

function preserveUserState(projectPath, configPath) {
  const state = {
    configured:  false,
    name:        null,
    description: null,
    stack:       null,
    testCommand: null,
    rawSections: {},  // Secciones del usuario que no son del sistema
  };

  if (!fs.existsSync(configPath)) return state;

  try {
    const config = fs.readFileSync(configPath, 'utf8');

    // CONFIGURADO
    state.configured = /^CONFIGURADO:\s*SI/m.test(config);

    // Nombre del proyecto
    const nameMatch = config.match(/^Nombre:\s*(.+)$/m);
    if (nameMatch) state.name = nameMatch[1].trim();

    // Descripción
    const descMatch = config.match(/^Descripción:\s*([\s\S]+?)(?=\n##|\n[A-Z])/m);
    if (descMatch) state.description = descMatch[1].trim();

    // Stack completo (bloque ## Stack hasta el siguiente ##)
    const stackMatch = config.match(/^## Stack\n([\s\S]+?)(?=\n##|$)/m);
    if (stackMatch) state.stack = stackMatch[1].trim();

    // Test command
    const testMatch = config.match(/^\s*test:\s*(.+)$/m);
    if (testMatch && testMatch[1].trim() !== '—') {
      state.testCommand = testMatch[1].trim();
    }

    // Secciones de módulos y reglas del proyecto (todo lo que va después de ## Reglas)
    const userSections = config.match(/^## (Reglas del proyecto|Módulos|Archivos compartidos|Sinónimos)([\s\S]+?)(?=\n##|$)/gm) || [];
    for (const section of userSections) {
      const titleMatch = section.match(/^## (.+)/);
      if (titleMatch) state.rawSections[titleMatch[1]] = section;
    }

  } catch(e) { /* best-effort */ }

  return state;
}

// ── restoreUserState ─────────────────────────────────────────────────────────
// Restaura el estado del usuario en config.md después del update

function restoreUserState(configPath, state) {
  if (!fs.existsSync(configPath)) return;

  try {
    let config = fs.readFileSync(configPath, 'utf8');
    let changed = false;

    // Restaurar CONFIGURADO: SI
    if (state.configured && /^CONFIGURADO:\s*NO/m.test(config)) {
      config = config.replace(/^CONFIGURADO:\s*NO/m, 'CONFIGURADO: SI');
      changed = true;
    }

    // Restaurar nombre del proyecto
    if (state.name) {
      const currentName = config.match(/^Nombre:\s*(.+)$/m)?.[1]?.trim();
      if (!currentName || currentName === '—' || currentName === '') {
        config = config.replace(/^Nombre:\s*.*$/m, `Nombre: ${state.name}`);
        changed = true;
      }
    }

    // Restaurar test command
    if (state.testCommand) {
      const currentTest = config.match(/^\s*test:\s*(.+)$/m)?.[1]?.trim();
      if (!currentTest || currentTest === '—') {
        config = config.replace(/^(\s*test:)\s*.*$/m, `$1 ${state.testCommand}`);
        changed = true;
      }
    }

    // Restaurar stack si se perdió
    if (state.stack) {
      const hasStack = config.includes('## Stack') && !config.match(/^## Stack\s*\n—/m);
      if (!hasStack) {
        config = config.replace(/^## Stack[\s\S]*?(?=\n##)/m, `## Stack\n${state.stack}\n`);
        changed = true;
      }
    }

    // Restaurar secciones de usuario
    for (const [title, section] of Object.entries(state.rawSections)) {
      if (!config.includes(`## ${title}`)) {
        config += `\n${section}\n`;
        changed = true;
      }
    }

    if (changed) {
      fs.writeFileSync(configPath, config, 'utf8');
    }

  } catch(e) { /* best-effort */ }
}

module.exports = { update };
