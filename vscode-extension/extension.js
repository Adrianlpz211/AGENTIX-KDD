/**
 * Agentic KDD — VS Code Extension v0.1.0
 *
 * Integra el framework Agentic KDD directamente en VS Code:
 *   - Dashboard sidebar (webview reutilizando dashboard.cjs)
 *   - Comandos de contexto (AST index, impact analysis, spec creation)
 *   - MCP server registration via registerMcpServerDefinitionProvider
 *   - File save hooks para indexación automática
 *
 * Referencia: cómo lo hace Cline/Roo Code (webview + MCP local)
 */

'use strict';

const vscode = require('vscode');
const path   = require('path');
const { execSync, spawn } = require('child_process');

// ─── ACTIVACIÓN ───────────────────────────────────────────────────────────────

function activate(context) {
  console.log('Agentic KDD extension activated');

  const projectRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!projectRoot) return;

  // ── 1. Dashboard Sidebar ────────────────────────────────────────────────
  const dashboardProvider = new AgenticDashboardProvider(context.extensionUri, projectRoot);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('agentickdd.dashboard', dashboardProvider)
  );

  // ── 2. MCP Server Registration ─────────────────────────────────────────
  // Registra el MCP server local para que Claude Code lo descubra automáticamente
  if (vscode.lm?.registerMcpServerDefinitionProvider) {
    context.subscriptions.push(
      vscode.lm.registerMcpServerDefinitionProvider('agentic-kdd', {
        provideMcpServerDefinition: () => ({
          label: 'Agentic KDD',
          command: 'node',
          args: [path.join(projectRoot, '.agentic/grafo/mcp-server.cjs')],
          type: 'stdio',
          env: { PROJECT_ROOT: projectRoot },
        })
      })
    );
  }

  // ── 3. Comandos ─────────────────────────────────────────────────────────

  // Mostrar dashboard
  context.subscriptions.push(
    vscode.commands.registerCommand('agentickdd.showDashboard', () => {
      dashboardProvider.show();
    })
  );

  // Indexar AST
  context.subscriptions.push(
    vscode.commands.registerCommand('agentickdd.indexAST', async () => {
      const terminal = vscode.window.createTerminal('Agentic KDD — AST Index');
      terminal.show();
      terminal.sendText(`cd "${projectRoot}" && node .agentic/grafo/ast-indexer.cjs index`);
    })
  );

  // Query memoria
  context.subscriptions.push(
    vscode.commands.registerCommand('agentickdd.queryMemory', async () => {
      const query = await vscode.window.showInputBox({ prompt: 'Buscar en memoria KDD...' });
      if (!query) return;
      const terminal = vscode.window.createTerminal('Agentic KDD — Memory Query');
      terminal.show();
      terminal.sendText(`cd "${projectRoot}" && node .agentic/grafo/grafo.cjs buscar "${query}"`);
    })
  );

  // Analizar impacto del archivo actual
  context.subscriptions.push(
    vscode.commands.registerCommand('agentickdd.analyzeImpact', async () => {
      const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
      if (!activeFile) {
        vscode.window.showWarningMessage('Abrir un archivo primero');
        return;
      }
      const relPath = path.relative(projectRoot, activeFile);
      const terminal = vscode.window.createTerminal('Agentic KDD — Impact');
      terminal.show();
      terminal.sendText(`cd "${projectRoot}" && node .agentic/grafo/impact-analyzer.cjs analyze "${relPath}"`);
    })
  );

  // Crear spec
  context.subscriptions.push(
    vscode.commands.registerCommand('agentickdd.createSpec', async () => {
      const moduleName = await vscode.window.showInputBox({ prompt: 'Nombre del módulo para el spec...' });
      if (!moduleName) return;
      const tipo = await vscode.window.showQuickPick(['feature', 'bugfix'], { placeHolder: 'Tipo de spec' });
      if (!tipo) return;
      const terminal = vscode.window.createTerminal('Agentic KDD — Spec');
      terminal.show();
      terminal.sendText(`cd "${projectRoot}" && node .agentic/grafo/spec-manager.cjs create "${moduleName}" ${tipo === 'bugfix' ? '--bugfix' : ''}`);
    })
  );

  // Sincronizar ADRs y gotchas
  context.subscriptions.push(
    vscode.commands.registerCommand('agentickdd.syncKnowledge', async () => {
      const terminal = vscode.window.createTerminal('Agentic KDD — Knowledge Sync');
      terminal.show();
      terminal.sendText(`cd "${projectRoot}" && node .agentic/grafo/adr-ingestor.cjs ingest && node .agentic/grafo/knowledge-ingestor.cjs ingest`);
    })
  );

  // ── 4. File Save Hook (AST auto-index) ─────────────────────────────────
  const config = vscode.workspace.getConfiguration('agentickdd');
  if (config.get('astEnabled')) {
    context.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument((document) => {
        const filePath = document.uri.fsPath;
        const ext = path.extname(filePath);
        const indexableExts = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs'];
        if (!indexableExts.includes(ext)) return;
        if (filePath.includes('node_modules') || filePath.includes('.agentic')) return;

        // Indexar el archivo guardado (silencioso, en background)
        try {
          const relPath = path.relative(projectRoot, filePath);
          execSync(
            `node .agentic/grafo/ast-indexer.cjs index "${path.dirname(relPath)}"`,
            { cwd: projectRoot, timeout: 10000, stdio: 'ignore' }
          );
        } catch {}
      })
    );
  }

  vscode.window.setStatusBarMessage('$(brain) Agentic KDD activo', 3000);
}

function deactivate() {}

// ─── DASHBOARD WEBVIEW PROVIDER ───────────────────────────────────────────────

class AgenticDashboardProvider {
  constructor(extensionUri, projectRoot) {
    this.extensionUri = extensionUri;
    this.projectRoot  = projectRoot;
    this._view = null;
  }

  resolveWebviewView(webviewView) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    webviewView.webview.html = this._getHtmlContent();

    // Actualizar cada 30 segundos
    const interval = setInterval(() => {
      if (webviewView.visible) {
        webviewView.webview.postMessage({ type: 'refresh' });
      }
    }, 30000);
    webviewView.onDidDispose(() => clearInterval(interval));
  }

  show() {
    vscode.commands.executeCommand('agentickdd.dashboard.focus');
  }

  _getHtmlContent() {
    // Reutiliza el HTML del dashboard existente (.agentic/dashboard.cjs)
    // En producción, genera el HTML via dashboard.cjs y lo inyecta aquí
    const dashPath = path.join(this.projectRoot, 'dashboard.cjs');
    const hasDashboard = require('fs').existsSync(dashPath);

    return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agentic KDD</title>
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px; }
    h3 { color: var(--vscode-textLink-foreground); margin-bottom: 8px; }
    .btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
           border: none; padding: 6px 12px; cursor: pointer; border-radius: 3px; margin: 4px; }
    .btn:hover { background: var(--vscode-button-hoverBackground); }
    .status { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 8px; }
  </style>
</head>
<body>
  <h3>⚡ Agentic KDD</h3>
  <div>
    <button class="btn" onclick="vscode.postMessage({cmd:'index'})">🗺️ Index AST</button>
    <button class="btn" onclick="vscode.postMessage({cmd:'impact'})">🔍 Impact</button>
    <button class="btn" onclick="vscode.postMessage({cmd:'sync'})">📄 Sync Knowledge</button>
    <button class="btn" onclick="vscode.postMessage({cmd:'dashboard'})">📊 Dashboard</button>
  </div>
  <p class="status">${hasDashboard ? '✅ Framework instalado' : '⚠️ Ejecutar akdd init en el proyecto'}</p>
  <script>
    const vscode = acquireVsCodeApi();
    window.addEventListener('message', e => {
      if (e.data.type === 'refresh') { /* actualizar stats */ }
    });
  </script>
</body>
</html>`;
  }
}

module.exports = { activate, deactivate };
