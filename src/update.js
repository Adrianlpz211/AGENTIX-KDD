'use strict';

const fs = require('fs-extra');
const path = require('path');
const { execSync } = require('child_process');
const chalk = require('chalk');
const ora = require('ora');
const { extractTarGz } = require('./tar-extract');

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
    extractTarGz(tmpFile, TEMP_DIR);
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
    // CLAUDE.md se regenera ENTERO desde la plantilla. Lo del usuario NO vive
    // aquí: vive en .agentic/INSTRUCCIONES-PROYECTO.md, un archivo que Agentix
    // solo LEE. Así `update` no puede destruirlo — no porque se acuerde de
    // preservarlo, sino porque nunca lo escribe.
    //
    // Antes (hasta v3.18) este bucle copiaba CLAUDE.md con overwrite:true sin
    // preservar nada, mientras el propio archivo invitaba al usuario a pegar
    // sus instrucciones al final. La prueba de que mordió: el encabezado
    // «INSTRUCCIONES DEL PROYECTO» acabó duplicado en la plantilla del repo.
    const userInstrPath = path.join(projectPath, '.agentic', 'INSTRUCCIONES-PROYECTO.md');
    const migrado = migrarInstruccionesUsuario(projectPath, userInstrPath);

    for (const file of ['CLAUDE.md', '_LOCKS.md']) {
      const src  = path.join(TEMP_DIR, file);
      const dest = path.join(projectPath, file);
      if (fs.existsSync(src)) fs.copySync(src, dest, { overwrite: true });
    }

    // Volver a pegar lo del usuario debajo del marcador
    if (fs.existsSync(userInstrPath)) {
      const claudePath = path.join(projectPath, 'CLAUDE.md');
      if (fs.existsSync(claudePath)) {
        const propio = fs.readFileSync(userInstrPath, 'utf8').trim();
        if (propio) {
          fs.appendFileSync(claudePath, '\n' + propio + '\n');
        }
      }
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

    // ── PASO 3b: Instalar playwright-core si falta (Browser Gate) ─────────
    // Proyectos con Agentix de antes del Browser Gate no lo tienen — se
    // instala en el update, no bloquea si falla (el gate ya avisa solo).
    try {
      require.resolve('playwright-core', { paths: [projectPath] });
    } catch (e) {
      try {
        execSync('npm install playwright-core --save-dev', { stdio: 'pipe', cwd: projectPath });
      } catch (e2) { /* Browser Gate queda sin usar hasta instalar a mano */ }
    }

    // ── PASO 4: Auto-sync para que el dashboard lea los datos actualizados ──
    spinner.text = 'Syncing knowledge graph...';
    try {
      execSync(`node "${path.join(grafoDest, 'grafo.cjs')}" sync`, {
        stdio: 'pipe', cwd: projectPath, timeout: 30000
      });
    } catch(e) { /* sync is best-effort */ }

    // ── PASO 5: Instalar git hooks (registro automático de contratos) ──────
    try {
      execSync(`node "${path.join(grafoDest, 'install-hooks.cjs')}" --quiet`, {
        stdio: 'pipe', cwd: projectPath, timeout: 15000
      });
    } catch(e) { /* hook best-effort */ }

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

    // Test command — [^\S\n]* y no \s*: \s* cruzaba el salto de línea y con
    // config.md en formato YAML de bloque capturaba la línea siguiente (2026-07-19).
    const testMatch = config.match(/^[^\S\n]*test:[^\S\n]*(\S.*)$/m) || config.match(/^[^\S\n]*comando:[^\S\n]*(\S.*)$/m);
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

    // Restaurar test command ([^\S\n]*: no cruzar saltos de línea, 2026-07-19)
    if (state.testCommand) {
      const currentTest = config.match(/^[^\S\n]*test:[^\S\n]*(\S.*)$/m)?.[1]?.trim();
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


// ── migrarInstruccionesUsuario ───────────────────────────────────────────────
// Una sola vez: si el CLAUDE.md que hay en disco tiene texto del usuario
// debajo del marcador y todavía no existe .agentic/INSTRUCCIONES-PROYECTO.md,
// lo mueve allí. A partir de ese momento ese archivo es la única fuente y
// Agentix jamás lo escribe.
//
// Devuelve true si migró algo (para poder avisarlo por consola).

function migrarInstruccionesUsuario(projectPath, userInstrPath) {
  try {
    if (fs.existsSync(userInstrPath)) return false;   // ya migrado: no tocar

    const claudePath = path.join(projectPath, 'CLAUDE.md');
    if (!fs.existsSync(claudePath)) return false;

    const actual = fs.readFileSync(claudePath, 'utf8');

    // El marcador ha tenido dos redacciones; se aceptan ambas.
    const re = /^#\s*INSTRUCCIONES DEL PROYECTO.*$/gm;
    let ultimo = null, m;
    while ((m = re.exec(actual)) !== null) ultimo = m;
    if (!ultimo) return false;

    // Todo lo que va después del bloque de comentarios del marcador
    // Cortar por el CIERRE del marco (# =====), no por "lineas que empiezan
    // por #": el texto del usuario son titulos markdown (## Mi regla) y una
    // limpieza por # se los comia. Lo cazo la prueba de test/update-instrucciones.
    let resto = actual.slice(ultimo.index + ultimo[0].length);
    const cierre = resto.match(/^[^\n]*\n(?:#[ =]+\n)?/);
    if (cierre) resto = resto.slice(cierre[0].length);
    // saltar el resto del marco y los comentarios de ayuda, PERO parar en cuanto
    // aparezca algo que no sea una linea de marco (# === o # texto sin ##)
    resto = resto.replace(/^(?:#(?!#)[^\n]*\n|[ \t]*\n)+/, '');
    resto = resto.trim();

    if (!resto) return false;   // no había nada del usuario

    fs.ensureDirSync(path.dirname(userInstrPath));
    fs.writeFileSync(userInstrPath,
      '# Instrucciones del proyecto\n' +
      '#\n' +
      '# Este archivo es tuyo. Agentix NO lo escribe nunca.\n' +
      '# `akdd update` lo lee y lo pega al final de CLAUDE.md en cada actualización.\n' +
      '\n' + resto + '\n', 'utf8');
    return true;
  } catch {
    return false;   // fail-soft: nunca romper un update por esto
  }
}
