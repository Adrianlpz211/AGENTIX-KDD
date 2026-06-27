'use strict';

const fs   = require('fs-extra');
const path = require('path');
const os   = require('os');
const { execSync } = require('child_process');
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
      try { cursorConfig = JSON.parse(fs.readFileSync(cursorMcpFile, 'utf8')); } catch {}
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
      execSync(`claude mcp add agentic-kdd -- node "${serverPath}"`, {
        stdio: 'pipe',
        cwd: projectPath,
      });
      results.claude_code = true;
      console.log(chalk.green('  ✓ Claude Code        →  registrado via "claude mcp add"'));
    } catch (e) {
      // Puede fallar si ya existe — intentar actualizar
      try {
        execSync(`claude mcp remove agentic-kdd`, { stdio: 'pipe', cwd: projectPath });
        execSync(`claude mcp add agentic-kdd -- node "${serverPath}"`, {
          stdio: 'pipe', cwd: projectPath,
        });
        results.claude_code = true;
        console.log(chalk.green('  ✓ Claude Code        →  actualizado'));
      } catch {
        console.log(chalk.gray('  ~ Claude Code        →  CLI no disponible o ya configurado'));
      }
    }
  } else {
    console.log(chalk.gray('  ~ Claude Code        →  CLI no detectado (config manual abajo)'));
  }

  // ══ PASO 3: Cursor global (opcional, solo si --global) ════════════════════
  if (opts.global) {
    const globalCursorConfig = getGlobalCursorConfigPath();
    if (globalCursorConfig) {
      try {
        fs.ensureDirSync(path.dirname(globalCursorConfig));
        let globalConfig = {};
        if (fs.existsSync(globalCursorConfig)) {
          try { globalConfig = JSON.parse(fs.readFileSync(globalCursorConfig, 'utf8')); } catch {}
        }
        if (!globalConfig.mcpServers) globalConfig.mcpServers = {};
        globalConfig.mcpServers['agentic-kdd'] = { command: 'node', args: [serverPath] };
        fs.writeFileSync(globalCursorConfig, JSON.stringify(globalConfig, null, 2));
        results.cursor_global = true;
        console.log(chalk.green(`  ✓ Cursor (global)    →  ${globalCursorConfig}`));
      } catch (e) {
        console.log(chalk.yellow(`  ⚠ Cursor (global)    →  ${e.message}`));
      }
    }
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
    execSync(`${cmd} --version`, { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch { return false; }
}

function getGlobalCursorConfigPath() {
  const platform = os.platform();
  const home     = os.homedir();

  if (platform === 'win32') {
    // Windows: %APPDATA%\Cursor\User\globalStorage\mcp.json
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'Cursor', 'User', 'globalStorage', 'mcp.json');
  }
  if (platform === 'darwin') {
    // macOS: ~/Library/Application Support/Cursor/User/globalStorage/mcp.json
    return path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'mcp.json');
  }
  // Linux: ~/.config/Cursor/User/globalStorage/mcp.json
  return path.join(home, '.config', 'Cursor', 'User', 'globalStorage', 'mcp.json');
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
    ? chalk.green('  ✓ Cursor (global)    configurado')
    : chalk.gray('  ~ Cursor (global)    No configurado — opcional: akdd mcp --global'));

  // Claude Code
  const claudeAvailable = isCLIAvailable('claude');
  if (claudeAvailable) {
    try {
      const mcpList = execSync('claude mcp list', { stdio: 'pipe' }).toString();
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

  if (hasServer && !cursorProjectOk) {
    console.log('\n' + chalk.bold('  → Ejecuta: akdd mcp\n'));
  } else if (hasServer && cursorProjectOk) {
    console.log('\n' + chalk.green('  Todo configurado. Recarga la ventana en Cursor si es necesario.\n'));
  }
}

module.exports = { mcpSetup, mcpStatus };
