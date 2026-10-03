'use strict';

const fs   = require('fs-extra');
const path = require('path');
const os   = require('os');
const { herramienta } = require('./run-safe');
const chalk = require('chalk');

/**
 * akdd mcp — Configura el MCP server automáticamente.
 *
 * Hace todo lo posible sin intervención del usuario:
 *   1. Escribe .cursor/mcp.json en el proyecto (Cursor lo lee automáticamente)
 *   2. Intenta ejecutar `claude mcp add` si el CLI está disponible
 *   3. Imprime el JSON EXACTO (con ruta real del sistema, no placeholder)
 *      para los casos que requieran paso manual
 *
 * El usuario NUNCA tiene que adivinar la ruta — este comando la resuelve por él.
 */

async function mcpSetup(projectPath, opts = {}) {
  projectPath = projectPath || process.cwd();
  if (opts.global) return mcpGlobal(opts);

  // ── Verificar que Agentic está instalado ───────────────────────────────────
  const serverFile = path.join(projectPath, '.agentic', 'grafo', 'mcp-server.cjs');
  if (!fs.existsSync(serverFile)) {
    console.log(chalk.yellow('\n  mcp-server.cjs no encontrado.'));
    console.log(chalk.gray('  Ejecuta: akdd update\n'));
    return;
  }

  // ── Resolver ruta absoluta real (sin placeholders, sin adivinar) ───────────
  // path.resolve() → ruta exacta del sistema actual, con nombre de usuario correcto
  const serverPath     = path.resolve(serverFile);
  const serverPathJson = serverPath.replace(/\\/g, '\\\\'); // escaping para JSON en Windows

  console.log('\n' + chalk.bold.hex('#8b5cf6')('  Agentic KDD — MCP Setup'));
  console.log(chalk.gray(`  Ruta del servidor: ${serverPath}\n`));

  const results = {
    cursor_project: false,
    cursor_global:  false,
    claude_code:    false,
  };

  // ══ PASO 1: Cursor — proyecto (automático, siempre funciona) ═══════════════
  const cursorMcpDir  = path.join(projectPath, '.cursor');
  const cursorMcpFile = path.join(cursorMcpDir, 'mcp.json');

  try {
    fs.ensureDirSync(cursorMcpDir);

    let cursorConfig = {};
    if (fs.existsSync(cursorMcpFile)) {
      cursorConfig = JSON.parse(fs.readFileSync(cursorMcpFile, 'utf8'));
      if (!cursorConfig || typeof cursorConfig !== 'object' || Array.isArray(cursorConfig)) throw new Error('Configuración MCP inválida: se conserva sin sobrescribir');
    }
    if (!cursorConfig.mcpServers) cursorConfig.mcpServers = {};

    cursorConfig.mcpServers['agentic-kdd'] = {
      command: 'node',
      args: [serverPath],
      env: { PROJECT_ROOT: path.resolve(projectPath) },
    };

    fs.writeFileSync(cursorMcpFile, JSON.stringify(cursorConfig, null, 2));
    results.cursor_project = true;
    console.log(chalk.green('  ✓ Cursor (proyecto)  →  .cursor/mcp.json actualizado'));
    console.log(chalk.gray('    Reinicia Cursor o recarga la ventana (Ctrl+Shift+P → "Reload Window")'));
  } catch (e) {
    console.log(chalk.yellow(`  ⚠ Cursor (proyecto)  →  Error: ${e.message}`));
  }

  // ══ PASO 2: Claude Code CLI (automático si está instalado) ═════════════════
  const claudeCliAvailable = isCLIAvailable('claude');
  if (claudeCliAvailable) {
    try {
      // claude mcp add agentic-kdd -- node "/ruta/exacta/mcp-server.cjs"
      herramienta('claude', ['mcp', 'add', '--env', 'PROJECT_ROOT=' + path.resolve(projectPath), 'agentic-kdd', '--', 'node', serverPath], { cwd: projectPath });
      results.claude_code = true;
      console.log(chalk.green('  ✓ Claude Code        →  registrado via "claude mcp add"'));
    } catch (e) {
      // Puede fallar si ya existe — intentar actualizar
      try {
        herramienta('claude', ['mcp', 'remove', 'agentic-kdd'], { cwd: projectPath });
        herramienta('claude', ['mcp', 'add', '--env', 'PROJECT_ROOT=' + path.resolve(projectPath), 'agentic-kdd', '--', 'node', serverPath], { cwd: projectPath });
        results.claude_code = true;
        console.log(chalk.green('  ✓ Claude Code        →  actualizado'));
      } catch {
        console.log(chalk.gray('  ~ Claude Code        →  CLI no disponible o ya configurado'));
      }
    }
  } else {
    console.log(chalk.gray('  ~ Claude Code        →  CLI no detectado (config manual abajo)'));
  }

  // ══ PASO 4: Imprimir configs manuales con ruta EXACTA ═════════════════════
  console.log('\n' + chalk.bold('  ── Config manual (si necesitas hacerlo tú mismo) ──────────────────'));

  // Cursor manual
  const cursorJson = JSON.stringify({
    mcpServers: {
      'agentic-kdd': {
        command: 'node',
        args: [serverPath],
      }
    }
  }, null, 2);

  console.log('\n' + chalk.cyan('  Cursor → .cursor/mcp.json'));
  console.log(chalk.gray('  (Abre Cursor → Settings → MCP → Add → pega esto:)\n'));
  console.log(chalk.white(cursorJson.split('\n').map(l => '  ' + l).join('\n')));

  // Claude Code manual
  console.log('\n' + chalk.cyan('  Claude Code → terminal'));
  console.log(chalk.white(`  claude mcp add agentic-kdd -- node "${serverPath}"`));

  // VS Code manual
  console.log('\n' + chalk.cyan('  VS Code → .vscode/settings.json'));
  const vscodeJson = JSON.stringify({
    'mcp.servers': {
      'agentic-kdd': {
        command: 'node',
        args: [serverPath],
        type: 'stdio',
      }
    }
  }, null, 2);
  console.log(chalk.white(vscodeJson.split('\n').map(l => '  ' + l).join('\n')));

  // ══ RESUMEN ════════════════════════════════════════════════════════════════
  console.log('\n' + chalk.dim('  ──────────────────────────────────────────────────────'));
  const autoCount = Object.values(results).filter(Boolean).length;
  if (autoCount > 0) {
    console.log(chalk.bold.green(`  ${autoCount} configuración(es) automática(s) completada(s).`));
  }

  if (results.cursor_project) {
    console.log(chalk.green('  Cursor listo:') + chalk.gray(' Reload Window → las tools aparecen automáticamente.'));
  }
  if (results.claude_code) {
    console.log(chalk.green('  Claude Code listo:') + chalk.gray(' cierra y abre el proyecto.'));
  }

  console.log('\n' + chalk.gray('  Para configurar globalmente (todos tus proyectos):'));
  console.log(chalk.gray('  akdd mcp --global\n'));
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function isCLIAvailable(cmd) {
  try {
    herramienta(cmd, ['--version'], { timeout: 5000 });
    return true;
  } catch { return false; }
}

/**
 * Cursor lee la configuración MCP global de ~/.cursor/mcp.json en los tres
 * sistemas. Hasta 3.19 se escribía en .../Cursor/User/globalStorage/mcp.json,
 * que Cursor no lee: el modo global nunca llegó a funcionar.
 */
function getGlobalCursorConfigPath(home = os.homedir()) {
  return path.join(home, '.cursor', 'mcp.json');
}

const LAUNCHER_NAME = 'mcp-launcher.cjs';
const launcherDestino = (home = os.homedir()) => path.join(home, '.agentix', LAUNCHER_NAME);

/** Fusiona la entrada agentic-kdd en un mcp.json sin tocar lo demás; JSON inválido se conserva. */
function fusionarMcpJson(archivo, entrada) {
  let cfg = {};
  if (fs.existsSync(archivo)) {
    const txt = fs.readFileSync(archivo, 'utf8');
    if (txt.trim()) {
      try { cfg = JSON.parse(txt); } catch { return { ok: false, reason: 'INVALID_JSON' }; }
      if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { ok: false, reason: 'INVALID_JSON' };
    }
  }
  if (!cfg.mcpServers || typeof cfg.mcpServers !== 'object') cfg.mcpServers = {};
  const antes = JSON.stringify(cfg.mcpServers['agentic-kdd'] || null);
  cfg.mcpServers['agentic-kdd'] = entrada;
  if (antes === JSON.stringify(entrada)) return { ok: true, changed: false };
  fs.ensureDirSync(path.dirname(archivo));
  fs.writeFileSync(archivo, JSON.stringify(cfg, null, 2) + '\n');
  return { ok: true, changed: true };
}

/**
 * akdd mcp --global — una entrada para todos los proyectos.
 * Copia el lanzador a ~/.agentix/ y registra ESE archivo en Cursor y en Claude
 * Code (scope user). El lanzador arranca el servidor del proyecto abierto, con
 * su propio motor y su propia memoria; fuera de un proyecto Agentix no consulta
 * ninguna memoria. No escribe nada dentro del proyecto actual.
 *
 * opts.home y opts.claude existen para las pruebas (HOME aislado, sin CLI real).
 */
function mcpGlobal(opts = {}) {
  const home = opts.home || os.homedir();
  const log = opts.quiet ? () => {} : (m) => console.log(m);
  const results = { launcher: null, cursor_global: false, claude_user: false, errores: [] };

  const origen = path.join(__dirname, LAUNCHER_NAME);
  const destino = launcherDestino(home);
  fs.ensureDirSync(path.dirname(destino));
  fs.copyFileSync(origen, destino);
  results.launcher = destino;
  log('\n' + chalk.bold.hex('#8b5cf6')('  Agentic KDD — MCP global'));
  log(chalk.gray('  Lanzador: ' + destino));
  log(chalk.gray('  Detecta el proyecto abierto y arranca SU servidor con SU memoria.\n'));

  const cursorFile = getGlobalCursorConfigPath(home);
  // ${workspaceFolder} lo interpola Cursor; si no lo hiciera, el lanzador lo
  // ignora y busca el proyecto desde la carpeta de arranque.
  const r = fusionarMcpJson(cursorFile, { command: 'node', args: [destino], env: { AGENTIX_PROJECT_ROOT: '${workspaceFolder}' } });
  if (r.ok) {
    results.cursor_global = true;
    log(chalk.green('  ✓ Cursor (global)    →  ' + cursorFile + (r.changed ? '' : ' (ya estaba)')));
  } else {
    results.errores.push('cursor: ' + r.reason);
    log(chalk.yellow('  ⚠ Cursor (global)    →  ' + cursorFile + ' no es JSON válido: se conserva sin tocar. Corrígelo y repite akdd mcp --global'));
  }

  const manual = 'claude mcp add --scope user agentic-kdd -- node "' + destino + '"';
  if (opts.claude !== false && isCLIAvailable('claude')) {
    try { herramienta('claude', ['mcp', 'remove', '--scope', 'user', 'agentic-kdd'], { timeout: 20000 }); } catch { /* no existía */ }
    try {
      herramienta('claude', ['mcp', 'add', '--scope', 'user', 'agentic-kdd', '--', 'node', destino], { timeout: 20000 });
      results.claude_user = true;
      log(chalk.green('  ✓ Claude Code        →  registrado en scope user (todos los proyectos)'));
    } catch (e) {
      results.errores.push('claude: ' + e.message);
      log(chalk.yellow('  ⚠ Claude Code        →  ' + e.message));
      log(chalk.white('    Manual: ' + manual));
    }
  } else if (opts.claude !== false) {
    log(chalk.gray('  ~ Claude Code        →  CLI no detectado. Manual: ' + manual));
  }

  log(chalk.gray('\n  Recarga Cursor (Reload Window) y abre una sesión nueva de Claude Code para ver las herramientas.'));
  log(chalk.gray('  Un proyecto con configuración propia (akdd mcp) usa la suya: la del proyecto manda.\n'));
  return results;
}

/**
 * Verifica y muestra el estado actual de la config MCP.
 * akdd mcp status
 */
function mcpStatus(projectPath) {
  projectPath = projectPath || process.cwd();

  const serverFile    = path.join(projectPath, '.agentic', 'grafo', 'mcp-server.cjs');
  const cursorProject = path.join(projectPath, '.cursor', 'mcp.json');
  const globalCursor  = getGlobalCursorConfigPath();

  console.log('\n' + chalk.bold('  Agentic KDD — MCP Status\n'));

  // Server file
  const hasServer = fs.existsSync(serverFile);
  console.log(hasServer
    ? chalk.green('  ✓ mcp-server.cjs     encontrado')
    : chalk.red('  ✗ mcp-server.cjs     NO encontrado — ejecutar: akdd update'));

  // Cursor project config
  let cursorProjectOk = false;
  if (fs.existsSync(cursorProject)) {
    try {
      const config = JSON.parse(fs.readFileSync(cursorProject, 'utf8'));
      cursorProjectOk = !!(config?.mcpServers?.['agentic-kdd']);
    } catch {}
  }
  console.log(cursorProjectOk
    ? chalk.green('  ✓ Cursor (proyecto)  .cursor/mcp.json configurado')
    : chalk.yellow('  ~ Cursor (proyecto)  No configurado — ejecutar: akdd mcp'));

  // Cursor global config
  let cursorGlobalOk = false;
  if (globalCursor && fs.existsSync(globalCursor)) {
    try {
      const config = JSON.parse(fs.readFileSync(globalCursor, 'utf8'));
      cursorGlobalOk = !!(config?.mcpServers?.['agentic-kdd']);
    } catch {}
  }
  console.log(cursorGlobalOk
    ? chalk.green('  ✓ Cursor (global)    ' + globalCursor)
    : chalk.gray('  ~ Cursor (global)    No configurado — opcional: akdd mcp --global'));
  if (cursorGlobalOk) {
    const lanzador = launcherDestino();
    console.log(fs.existsSync(lanzador)
      ? chalk.green('  ✓ Lanzador global    ' + lanzador)
      : chalk.red('  ✗ Lanzador global    falta ' + lanzador + ' — ejecutar: akdd mcp --global'));
  }

  // Claude Code
  const claudeAvailable = isCLIAvailable('claude');
  if (claudeAvailable) {
    try {
      const mcpList = herramienta('claude', ['mcp', 'list']).toString();
      const hasAgentic = mcpList.includes('agentic-kdd');
      console.log(hasAgentic
        ? chalk.green('  ✓ Claude Code        registrado')
        : chalk.yellow('  ~ Claude Code        No registrado — ejecutar: akdd mcp'));
    } catch {
      console.log(chalk.gray('  ~ Claude Code        CLI disponible pero sin listar MCPs'));
    }
  } else {
    console.log(chalk.gray('  ~ Claude Code CLI    No instalado'));
  }

  if (hasServer && !cursorProjectOk && !cursorGlobalOk) {
    console.log('\n' + chalk.bold('  → Ejecuta: akdd mcp  (o akdd mcp --global para todos tus proyectos)\n'));
  } else if (hasServer) {
    console.log('\n' + chalk.green('  Todo configurado. Recarga la ventana en Cursor si es necesario.\n'));
  }
}

module.exports = { mcpSetup, mcpStatus, mcpGlobal, fusionarMcpJson, getGlobalCursorConfigPath, launcherDestino };
