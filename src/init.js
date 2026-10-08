'use strict';
const { mcpSetup } = require('./mcp-setup');
const { nodo, herramienta } = require('./run-safe');
const txm = require('./update-tx');
const manifest = require('./managed-manifest');

const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const chalk = require('chalk');
const ora = require('ora');
const inquirer = require('inquirer');

const GITHUB_REPO = 'Adrianlpz211/AGENTIX-KDD';
const REPO_URL = `https://github.com/${GITHUB_REPO}`;

// ── Descargar: la misma ruta fijada y validada que update ───────
function descargarFramework({ ref, archivo } = {}) {
  if (!ref && !archivo) return { ...txm.prepararBundle(path.join(__dirname, '..')), commit: null };
  ref = ref || 'main';
  let descarga = null;
  let commit = null;
  try {
    if (!archivo) {
      commit = txm.resolverRef(REPO_URL, ref);
      descarga = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-download-'));
      archivo = path.join(descarga, `${commit}.tar.gz`);
      herramienta('curl', ['-sfL', `${REPO_URL}/archive/${commit}.tar.gz`, '-o', archivo]);
    }
    const sha256 = txm.hashArchivo(archivo);
    const staging = txm.prepararStaging(archivo);
    const valido = txm.validarStaging(staging);
    if (!valido.ok) {
      fs.removeSync(staging);
      throw new Error('La versión descargada no es válida:\n    ' + valido.problemas.slice(0, 10).join('\n    '));
    }
    return { staging, commit, sha256, version: valido.version };
  } catch (err) {
    if (err.code === 'ARCHIVO_HOSTIL' || /no es válida/.test(err.message)) throw err;
    throw new Error('No se pudo descargar desde GitHub (' + err.message + '). Verifica tu conexión.');
  } finally {
    if (descarga) fs.removeSync(descarga);
  }
}

// ── Copiar archivos al proyecto ─────────────────────────────────
// Solo lo que está en src/managed-manifest.js — la misma lista que mantiene
// update. La memoria, specs, conocimiento, PLAN.md y docs/ del repo de Agentix
// NO viajan: son del repo de Agentix. El proyecto recibe semillas genéricas
// (templates/seed) y solo si no tiene ya las suyas.
//
// Si el proyecto ya tenía un archivo con el mismo nombre (su propio CLAUDE.md,
// sus .cursorrules) se respalda como <archivo>.agentix-backup antes de
// escribir, y el texto de su CLAUDE.md pasa a .agentic/INSTRUCCIONES-PROYECTO.md
// para que se vuelva a pegar debajo del marcador.
function copyAgenticFiles(sourcePath, projectPath) {
  const respaldados = [];
  const hashes = {};
  const instrucciones = path.join(projectPath, '.agentic', 'INSTRUCCIONES-PROYECTO.md');
  for (const rel of manifest.archivos(sourcePath)) {
    const src = path.join(sourcePath, rel);
    const dest = path.join(projectPath, rel);
    if (fs.existsSync(dest)) {
      if (txm.hashArchivo(dest) === txm.hashArchivo(src)) { hashes[rel] = txm.hashArchivo(dest); continue; }
      fs.copySync(dest, dest + '.agentix-backup', { overwrite: false, errorOnExist: false });
      respaldados.push(rel);
      if (rel === 'CLAUDE.md' && !fs.existsSync(instrucciones)) {
        const propio = fs.readFileSync(dest, 'utf8').trim();
        if (propio) {
          fs.ensureDirSync(path.dirname(instrucciones));
          fs.writeFileSync(instrucciones, '# Instrucciones del proyecto\n#\n# Este archivo es tuyo. Agentix NO lo escribe nunca.\n'
            + '# `akdd update` lo lee y lo pega al final de CLAUDE.md en cada actualización.\n\n' + propio + '\n');
        }
      }
    }
    fs.ensureDirSync(path.dirname(dest));
    fs.copyFileSync(src, dest);
    hashes[rel] = txm.hashArchivo(dest);
  }

  if (fs.existsSync(instrucciones) && hashes['CLAUDE.md']) {
    const propio = fs.readFileSync(instrucciones, 'utf8').trim();
    if (propio) fs.appendFileSync(path.join(projectPath, 'CLAUDE.md'), '\n' + propio + '\n');
  }

  sembrar(sourcePath, projectPath);
  fs.ensureDirSync(path.join(projectPath, '_output'));
  return { hashes, respaldados };
}

/** Semillas genéricas: solo se crean, nunca sustituyen lo que el proyecto ya tiene. */
function sembrar(sourcePath, projectPath) {
  const seed = [path.join(sourcePath, 'templates', 'seed'), path.join(__dirname, '..', 'templates', 'seed')]
    .find((p) => fs.existsSync(p));
  const agDest = path.join(projectPath, '.agentic');
  for (const dir of ['memoria', 'specs', 'conocimiento']) fs.ensureDirSync(path.join(agDest, dir));
  if (!seed) return;
  const pila = [seed];
  while (pila.length) {
    const d = pila.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { pila.push(p); continue; }
      const dest = path.join(projectPath, path.relative(seed, p));
      if (!fs.existsSync(dest)) { fs.ensureDirSync(path.dirname(dest)); fs.copyFileSync(p, dest); }
    }
  }
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
/**
 * Banderas para uso desatendido. `akdd init` era 100% interactivo: tres
 * prompts, uno de ellos una lista que se navega con flechas. Un agente (o un
 * script de CI, o un contenedor) no puede contestarlos — con una tuberia
 * revienta con ERR_USE_AFTER_CLOSE y deja el proyecto a medio crear.
 *
 * Un framework cuyo propio instalador no se puede automatizar obliga a que
 * haya siempre una persona teclando, que es justo lo que viene a evitar.
 *
 *   akdd init --yes                      todo por defecto, sin preguntar
 *   akdd init --name=clinia --nuevo      nombre y tipo explicitos
 *   akdd init --yes --existente          proyecto que ya tiene codigo
 *   akdd init --yes --con-docs           ademas consolida la documentacion
 */
function leerBanderas(argv) {
  const f = { desatendido: false, nombre: null, nuevo: null, docs: null, ref: undefined, archivo: undefined, deps: false, browser: false };
  for (const a of argv) {
    if (a === '--yes' || a === '-y' || a === '--si') f.desatendido = true;
    else if (a.startsWith('--ref=')) f.ref = a.slice(6);
    else if (a.startsWith('--from=')) f.archivo = path.resolve(a.slice(7));
    else if (a === '--deps') f.deps = true;
    else if (a === '--browser') f.browser = true;
    else if (a.startsWith('--name=') || a.startsWith('--nombre=')) f.nombre = a.split('=').slice(1).join('=');
    else if (a === '--nuevo' || a === '--new') { f.nuevo = true; f.desatendido = true; }
    else if (a === '--existente' || a === '--existing') { f.nuevo = false; f.desatendido = true; }
    else if (a === '--con-docs' || a === '--with-docs') { f.docs = true; f.desatendido = true; }
    else if (a === '--sin-docs' || a === '--no-docs') { f.docs = false; f.desatendido = true; }
  }
  if (f.nombre) f.desatendido = true;
  return f;
}

async function init() {
  const projectPath = process.cwd();
  const banderas = leerBanderas(process.argv.slice(2));

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
  const nombrePorDefecto = banderas.nombre || path.basename(projectPath);
  const { name } = banderas.desatendido
    ? { name: nombrePorDefecto }
    : await inquirer.prompt([{
        type: 'input', name: 'name',
        message: 'Nombre del proyecto:',
        default: nombrePorDefecto
      }]);
  if (banderas.desatendido) console.log(chalk.gray(`  · nombre: ${name}`));

  // ── PREGUNTA 2: Nuevo o existente ──────────────────────────
  const { isNew } = banderas.desatendido
    ? { isNew: banderas.nuevo !== null ? banderas.nuevo : !hasCode }
    : await inquirer.prompt([{
        type: 'list', name: 'isNew',
        message: '¿El proyecto es nuevo o ya tiene código?',
        choices: [
          { name: 'Nuevo — empezando desde cero', value: true },
          { name: 'Existente — ya tiene código o avance', value: false }
        ],
        default: !hasCode
      }]);
  if (banderas.desatendido) console.log(chalk.gray(`  · tipo: ${isNew ? 'nuevo' : 'existente'}`));

  // ── INSTALAR — crear carpetas PRIMERO antes de preguntar docs ──
  const spinner = ora({ text: 'Descargando Agentic KDD...', color: 'magenta' }).start();
  let fuente = null;
  try {
    fuente = descargarFramework({ ref: banderas.ref, archivo: banderas.archivo });
    spinner.text = 'Instalando archivos...';
    const copia = copyAgenticFiles(fuente.staging, projectPath);
    txm.registrarOwned(projectPath, copia.hashes, { version: fuente.version, commit: fuente.commit, sha256: fuente.sha256 });
    spinner.succeed(chalk.green(`Archivos instalados — ${fuente.version || 'unknown'}${fuente.commit ? ' @ ' + fuente.commit.slice(0, 12) : ''}`));
    if (copia.respaldados.length) {
      console.log(chalk.yellow(`  ✋ Ya existían y se respaldaron como <archivo>.agentix-backup: ${copia.respaldados.join(', ')}`));
    }

    // Hooks: no pisa hooks ajenos (los reporta como conflicto)
    try {
      nodo(path.join(projectPath, '.agentic', 'grafo', 'install-hooks.cjs'), ['--quiet'], { cwd: projectPath });
    } catch (e) { /* el estado de los hooks se ve con akdd health */ }

    // Hooks del HOST (Claude Code / Cursor): enriquecimiento sin aa:, guardia de la DENY LIST y avisos. Solo los que el proyecto usa.
    try {
      nodo(path.join(projectPath, '.agentic', 'grafo', 'host-hooks.cjs'), ['auto'], { cwd: projectPath });
    } catch (e) { /* se ve con akdd host-hooks status */ }

    // Dependencias: nunca sin pedirlas. Sin better-sqlite3 el motor usa node:sqlite.
    if (banderas.deps) {
      try { herramienta('npm', ['install', 'better-sqlite3', '--save'], { cwd: projectPath }); console.log(chalk.green('  ✓ better-sqlite3')); }
      catch (e) { console.log(chalk.yellow('  ⚠ better-sqlite3 no se pudo instalar — se usa node:sqlite')); }
    }
    if (banderas.browser) {
      try { herramienta('npm', ['install', 'playwright-core', '--save-dev'], { cwd: projectPath }); console.log(chalk.green('  ✓ playwright-core (Browser Gate con tu Chrome/Edge)')); }
      catch (e) { console.log(chalk.yellow('  ⚠ playwright-core no se pudo instalar')); }
    }
    if (!banderas.deps || !banderas.browser) {
      console.log(chalk.gray('  · Opcionales sin instalar: ' + [!banderas.deps && 'better-sqlite3 (--deps)', !banderas.browser && 'playwright-core (--browser)'].filter(Boolean).join(', ')));
    }
  } catch (err) {
    spinner.fail(chalk.red('Error en la instalación'));
    console.error(chalk.red('\n  ' + err.message + '\n'));
    if (fuente) fs.removeSync(fuente.staging);
    process.exit(1);
  }
  fs.removeSync(fuente.staging);

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
  const { hasDocs } = banderas.desatendido
    ? { hasDocs: banderas.docs === true }
    : await inquirer.prompt([{
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
      nodo(path.join(grafoDir, 'ast-indexer.cjs'), ['index'], { cwd: projectPath, timeout: 120000 });
      console.log(chalk.green('  ✓ Mapa de código indexado (akdd ast)'));
    } catch (e) {
      console.log(chalk.gray('  (puedes generar el mapa de código luego con: akdd ast)'));
    }
    try {
      nodo(path.join(grafoDir, 'grafo.cjs'), ['sync'], { cwd: projectPath, timeout: 30000 });
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

module.exports = { init, leerBanderas, copyAgenticFiles, sembrar, descargarFramework };
