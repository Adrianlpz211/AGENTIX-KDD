'use strict';
const { mcpSetup } = require('./mcp-setup');

const fs = require('fs-extra');
const path = require('path');
const { execSync } = require('child_process');
const chalk = require('chalk');
const ora = require('ora');
const inquirer = require('inquirer');

const GITHUB_REPO = 'Adrianlpz211/AGENTIX-KDD';
const TEMP_DIR = path.join(require('os').tmpdir(), 'agentic-kdd-download');

// ── Descargar desde GitHub ──────────────────────────────────────
async function downloadFromGitHub(spinner) {
  const tmpFile = path.join(require('os').tmpdir(), 'agentic-kdd.tar.gz');
  try {
    execSync(`curl -sL "https://github.com/${GITHUB_REPO}/archive/refs/heads/main.tar.gz" -o "${tmpFile}"`, { stdio: 'pipe' });
    fs.ensureDirSync(TEMP_DIR);
    execSync(`tar -xzf "${tmpFile}" -C "${TEMP_DIR}" --strip-components=1`, { stdio: 'pipe' });
    fs.removeSync(tmpFile);
    return TEMP_DIR;
  } catch (err) {
    throw new Error('No se pudo descargar desde GitHub. Verifica tu conexión.');
  }
}

// ── Copiar archivos al proyecto ─────────────────────────────────
function copyAgenticFiles(sourcePath, projectPath) {
  const rootFiles = ['CLAUDE.md', '_LOCKS.md', '.cursorrules', 'dashboard.cjs', 'docs', '.cursor', '.audit'];
  for (const file of rootFiles) {
    const src  = path.join(sourcePath, file);
    const dest = path.join(projectPath, file);
    if (fs.existsSync(src)) fs.copySync(src, dest, { overwrite: true });
  }

  const agSrc  = path.join(sourcePath, '.agentic');
  const agDest = path.join(projectPath, '.agentic');

  if (fs.existsSync(agSrc)) {
    fs.copySync(path.join(agSrc, 'agentes'), path.join(agDest, 'agentes'), { overwrite: true });
    fs.copySync(path.join(agSrc, 'grafo'),   path.join(agDest, 'grafo'),   { overwrite: true });

    const onlyCreate = ['memoria', 'specs', 'conocimiento'];
    for (const dir of onlyCreate) {
      const dest = path.join(agDest, dir);
      if (!fs.existsSync(dest)) {
        const src = path.join(agSrc, dir);
        if (fs.existsSync(src)) fs.copySync(src, dest);
        else fs.ensureDirSync(dest);
      }
    }

    const planDest = path.join(agDest, 'PLAN.md');
    if (!fs.existsSync(planDest)) {
      const planSrc = path.join(agSrc, 'PLAN.md');
      if (fs.existsSync(planSrc)) fs.copySync(planSrc, planDest);
    }
  }

  fs.ensureDirSync(path.join(projectPath, '_output'));
}

// ── Detectar stack ──────────────────────────────────────────────
function detectStack(projectPath) {
  const stack = { framework: '—', language: '—', packageManager: 'npm' };
  if (fs.existsSync(path.join(projectPath, 'package.json'))) {
    const pkg  = fs.readJsonSync(path.join(projectPath, 'package.json'), { throws: false }) || {};
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    stack.language = deps['typescript'] ? 'TypeScript' : 'JavaScript';
    if (fs.existsSync(path.join(projectPath, 'pnpm-lock.yaml')))      stack.packageManager = 'pnpm';
    else if (fs.existsSync(path.join(projectPath, 'yarn.lock')))       stack.packageManager = 'yarn';
    if (deps['next'])    stack.framework = `Next.js ${(deps['next']||'').replace(/[\^~]/,'')}`;
    else if (deps['react'] && !deps['next']) stack.framework = 'React';
    else if (deps['express'])  stack.framework = 'Express';
    else if (deps['fastify'])  stack.framework = 'Fastify';
    else if (deps['@nestjs/core']) stack.framework = 'NestJS';
  }
  if (fs.existsSync(path.join(projectPath, 'composer.json'))) {
    const composer = fs.readJsonSync(path.join(projectPath, 'composer.json'), { throws: false }) || {};
    stack.language = 'PHP'; stack.packageManager = 'composer';
    if ((composer.require||{})['laravel/framework']) stack.framework = 'Laravel';
    else stack.framework = 'PHP';
  }
  if (fs.existsSync(path.join(projectPath, 'pyproject.toml')) ||
      fs.existsSync(path.join(projectPath, 'requirements.txt'))) {
    stack.language = 'Python'; stack.packageManager = 'pip';
    stack.framework = 'Python';
  }
  return stack;
}

// ── Consolidar docs en conocimiento/ ───────────────────────────
function consolidarDocs(projectPath) {
  const conocimientoPath = path.join(projectPath, '.agentic', 'conocimiento');
  const consolidados = [];
  const ignorar = ['node_modules', '.git', '.agentic', '_output', 'dist', 'build', '.next', 'vendor'];

  // Extensiones útiles como conocimiento
  const extensionesUtiles = ['.md', '.pdf', '.txt'];
  // Nombres específicos que siempre son útiles
  const nombresUtiles = ['README', 'SPEC', 'SPECS', 'CONTEXT', 'CONTEXTO', 'REQUIREMENTS',
    'ARCHITECTURE', 'DISEÑO', 'DESIGN', 'BRIEF', 'PRD', 'CLAUDE', 'AGENTS'];

  function esArchivoUtil(nombre) {
    const upper = nombre.toUpperCase().replace(/\.[^.]+$/, '');
    const ext   = path.extname(nombre).toLowerCase();
    if (extensionesUtiles.includes(ext)) return true;
    if (nombresUtiles.some(n => upper.includes(n))) return true;
    return false;
  }

  function recorrer(dir, nivel) {
    if (nivel > 3) return; // máximo 3 niveles de profundidad
    let items;
    try { items = fs.readdirSync(dir); } catch(e) { return; }

    for (const item of items) {
      if (ignorar.includes(item) || item.startsWith('.')) continue;
      const fullPath = path.join(dir, item);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        recorrer(fullPath, nivel + 1);
      } else if (stat.isFile() && esArchivoUtil(item)) {
        // No mover repomix — solo usarlo como referencia
        if (item.includes('repomix')) {
          consolidados.push({ src: fullPath, nombre: item, tipo: 'referencia' });
          continue;
        }
        // No copiar si ya está en conocimiento/
        if (fullPath.startsWith(conocimientoPath)) continue;

        const destNombre = item;
        const destPath   = path.join(conocimientoPath, destNombre);
        // Si ya existe uno con el mismo nombre, agregar prefijo del directorio padre
        const finalDest = fs.existsSync(destPath)
          ? path.join(conocimientoPath, path.basename(dir) + '_' + destNombre)
          : destPath;

        try {
          fs.copySync(fullPath, finalDest, { overwrite: false });
          consolidados.push({ src: fullPath, nombre: destNombre, tipo: 'copiado' });
        } catch(e) {}
      }
    }
  }

  recorrer(projectPath, 0);
  return consolidados;
}

// ── Comando principal: akdd init ────────────────────────────────
async function init() {
  const projectPath = process.cwd();

  console.log('\n' + chalk.bold.hex('#8b5cf6')('  🤖 Agentic KDD') + chalk.gray(' — autonomous development pipeline'));
  console.log(chalk.gray('  github.com/Adrianlpz211/Agentic-KDD\n'));

  // Verificar si ya está instalado
  if (fs.existsSync(path.join(projectPath, '.agentic', 'agentes'))) {
    console.log(chalk.yellow('  Agentic KDD ya está instalado en este proyecto.'));
    console.log(chalk.gray('  Para actualizar los agentes sin perder tu memoria: akdd update\n'));
    return;
  }

  // Detectar stack
  const stack = detectStack(projectPath);
  const hasCode = fs.existsSync(path.join(projectPath, 'src')) ||
                  fs.existsSync(path.join(projectPath, 'app')) ||
                  fs.existsSync(path.join(projectPath, 'pages'));

  if (stack.framework !== '—')
    console.log(chalk.green(`  ✓ Stack detectado: ${stack.framework} · ${stack.language} · ${stack.packageManager}`));
  if (hasCode)
    console.log(chalk.green('  ✓ Código existente detectado'));
  console.log('');

  // ── PREGUNTA 1: Nombre ──────────────────────────────────────
  const { name } = await inquirer.prompt([{
    type: 'input', name: 'name',
    message: 'Nombre del proyecto:',
    default: path.basename(projectPath)
  }]);

  // ── PREGUNTA 2: Nuevo o existente ──────────────────────────
  const { isNew } = await inquirer.prompt([{
    type: 'list', name: 'isNew',
    message: '¿El proyecto es nuevo o ya tiene código?',
    choices: [
      { name: 'Nuevo — empezando desde cero', value: true },
      { name: 'Existente — ya tiene código o avance', value: false }
    ],
    default: !hasCode
  }]);

  // ── INSTALAR — crear carpetas PRIMERO antes de preguntar docs ──
  const spinner = ora({ text: 'Descargando Agentic KDD...', color: 'magenta' }).start();
  let sourcePath;
  try {
    sourcePath = await downloadFromGitHub(spinner);
    spinner.text = 'Instalando archivos...';
    copyAgenticFiles(sourcePath, projectPath);
    fs.removeSync(TEMP_DIR);

    // Instalar git hooks (registro automático de contratos) — best-effort, no aborta init
    try {
      require('child_process').execSync(
        `node "${path.join(projectPath, '.agentic', 'grafo', 'install-hooks.cjs')}" --quiet`,
        { stdio: 'pipe', cwd: projectPath }
      );
    } catch (e) { /* hook best-effort */ }

    // Instalar better-sqlite3 para el grafo SQLite
    spinner.text = 'Instalando dependencias del grafo...';
    try {
      require('child_process').execSync('npm install better-sqlite3 --save', {
        stdio: 'pipe', cwd: projectPath
      });
      spinner.succeed(chalk.green('Archivos instalados + better-sqlite3'));
    } catch(e) {
      spinner.warn(chalk.yellow('Archivos instalados (sin better-sqlite3)'));
      console.log(chalk.gray('\n  El grafo usará node:sqlite integrado en Node.js 22+'));
      console.log(chalk.gray('  Para máximo rendimiento instala las build tools:'));
      console.log(chalk.gray('  https://visualstudio.microsoft.com/visual-cpp-build-tools/\n'));
    }
  } catch (err) {
    spinner.fail(chalk.red('Error en la instalación'));
    console.error(chalk.red('\n  ' + err.message + '\n'));
    process.exit(1);
  }

  // ── Agregar dev:kdd al package.json si es proyecto Node ────
  const pkgPath = path.join(projectPath, 'package.json');
  if (fs.existsSync(pkgPath) && stack.language !== 'Python') {
    try {
      const pkg = fs.readJsonSync(pkgPath, { throws: false }) || {};
      if (!pkg.scripts) pkg.scripts = {};
      if (!pkg.scripts['dev:kdd']) {
        pkg.scripts['dev:kdd'] = 'npm run dev 2>&1 | node .agentic/grafo/watch-errors.cjs';
        fs.writeJsonSync(pkgPath, pkg, { spaces: 2 });
        console.log(chalk.green('  ✓ Script dev:kdd agregado al package.json'));
      }
    } catch(e) {
      console.log(chalk.yellow('  ⚠ No se pudo agregar dev:kdd al package.json — agrégalo manualmente'));
    }
  }

  // ── PREGUNTA 3: Docs (DESPUÉS de crear carpetas) ───────────
  const { hasDocs } = await inquirer.prompt([{
    type: 'confirm', name: 'hasDocs',
    message: '¿Tienes specs, wireframes o documentación del proyecto?',
    default: false
  }]);

  if (hasDocs) {
    // Recorrer el proyecto y consolidar docs automáticamente
    console.log('');
    const docsSpinner = ora({ text: 'Buscando archivos de conocimiento...', color: 'cyan' }).start();
    const consolidados = consolidarDocs(projectPath);
    const copiados    = consolidados.filter(d => d.tipo === 'copiado');
    const referencias = consolidados.filter(d => d.tipo === 'referencia');

    if (copiados.length > 0) {
      docsSpinner.succeed(chalk.green(`Archivos de conocimiento centralizados en .agentic/conocimiento/`));
      copiados.forEach(d => console.log(chalk.gray(`    ✓ ${d.nombre}`)));
      if (referencias.length > 0) {
        console.log(chalk.gray(`\n  Como referencia (no movido):`));
        referencias.forEach(d => console.log(chalk.gray(`    ~ ${d.nombre}`)));
      }
    } else {
      docsSpinner.warn(chalk.yellow('No se encontraron archivos de conocimiento en el proyecto.'));
      console.log(chalk.gray('  Puedes agregarlos manualmente en .agentic/conocimiento/'));
    }
  } else {
    console.log('');
    console.log(chalk.gray('  Tip: puedes agregar specs, docs o wireframes en'));
    console.log(chalk.gray('  .agentic/conocimiento/ en cualquier momento.'));
    console.log(chalk.gray('  Agentic los usará automáticamente en el siguiente aa:'));
  }

  // ── CREAR config.md BASE ────────────────────────────────────
  // Necesario para que akdd graph funcione antes de aa: configurar
  const configPath = path.join(projectPath, '.agentic', 'config.md');
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, `# Configuración del proyecto
CONFIGURADO: SI
Nombre: ${name}
Stack: ${stack.framework} · ${stack.language} · ${stack.packageManager}
Estado: Pendiente aa: configurar
`);
  }

  // ── PROYECTO EXISTENTE: onboard + ast + sync automáticos (una sola vez) ─────
  // Si el dev marcó "ya tiene código", poblamos el dashboard con lo que se puede
  // deducir del proyecto: patrones (onboard), nodos del código (ast) y grafo (sync).
  // Todo best-effort: si algo falla, init NO se rompe.
  if (!isNew) {
    const grafoDir = path.join(projectPath, '.agentic', 'grafo');
    const brownSpinner = ora({ text: 'Proyecto existente — analizando y poblando memoria...', color: 'cyan' }).start();
    try {
      brownSpinner.stop();
      const { onboard } = require('./onboard');
      await onboard();                       // detecta stack/módulos/patrones → patrones.md
    } catch (e) {
      console.log(chalk.gray('  (puedes correrlo luego con: akdd onboard)'));
    }
    try {
      execSync(`node "${path.join(grafoDir, 'ast-indexer.cjs')}" index`, { stdio: 'pipe', cwd: projectPath, timeout: 120000 });
      console.log(chalk.green('  ✓ Mapa de código indexado (akdd ast)'));
    } catch (e) {
      console.log(chalk.gray('  (puedes generar el mapa de código luego con: akdd ast)'));
    }
    try {
      execSync(`node "${path.join(grafoDir, 'grafo.cjs')}" sync`, { stdio: 'pipe', cwd: projectPath, timeout: 30000 });
      console.log(chalk.green('  ✓ Grafo de conocimiento sincronizado (akdd sync)'));
    } catch (e) {
      console.log(chalk.gray('  (puedes sincronizar el grafo luego con: akdd sync)'));
    }
  }

  // ── RESUMEN FINAL ───────────────────────────────────────────
  console.log('\n' + chalk.bold('  Instalado:'));
  console.log(chalk.gray('  .agentic/agentes/      — pipeline de 9 agentes'));
  console.log(chalk.gray('  .agentic/grafo/        — motor SQLite de conocimiento'));
  console.log(chalk.gray('  .agentic/memoria/      — errores, patrones, decisiones'));
  console.log(chalk.gray('  .agentic/conocimiento/ — documentación del proyecto'));
  console.log(chalk.gray('  .agentic/specs/        — specs auto-generadas'));
  console.log(chalk.gray('  .audit/                — departamento QA (7 subagentes)'));
  console.log(chalk.gray('  dashboard.cjs          — dashboard visual'));
  console.log(chalk.gray('  CLAUDE.md              — activa aa: / ag: / audit:'));
  console.log(chalk.gray('  .cursorrules           — reglas para Cursor'));

  // ── CONFIGURAR MCP AUTOMÁTICAMENTE ─────────────────────────────────────────
  console.log(chalk.bold("  Configurando MCP server..."));
  try {
    await mcpSetup(projectPath, { silent: false });
  } catch(e) {
    console.log(chalk.gray("  (MCP: ejecuta akdd mcp para configurarlo manualmente)"));
  }

  // Instrucción final
  console.log('\n' + chalk.dim('  ─────────────────────────────────────────────'));
  console.log(chalk.bold('  Último paso — abre este proyecto en'));
  console.log(chalk.bold('  Cursor o Claude Code y ejecuta:'));
  console.log('');
  console.log('  ' + chalk.bold.hex('#a78bfa')('aa: configurar'));
  console.log('');
  console.log(chalk.gray('  Esto completa la configuración leyendo tu'));
  console.log(chalk.gray('  código real. Solo se hace una vez.'));
  console.log(chalk.dim('  ─────────────────────────────────────────────\n'));
}

module.exports = { init };
