/**
 * Agentic KDD — VS Code Extension v0.2.0
 * Works in VS Code with Copilot, Claude Code, and any MCP-compatible agent.
 *
 * Features:
 *   - Sidebar dashboard with live memory stats from SQLite
 *   - MCP server auto-registration (Claude Code + Copilot)
 *   - 12 commands via Ctrl+Shift+P
 *   - Right-click context menu on files
 *   - File save hook for AST auto-index
 *   - Status bar indicator
 */

'use strict';

const vscode  = require('vscode');
const path    = require('path');
const fs      = require('fs');
const { execSync } = require('child_process');

// ─── ACTIVATE ────────────────────────────────────────────────────────────────

function activate(context) {
  const projectRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!projectRoot) return;

  // 1. Sidebar
  const provider = new AgenticSidebarProvider(context.extensionUri, projectRoot);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('agentickdd.dashboard', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // 2. MCP auto-registration
  const mcpPath = path.join(projectRoot, '.agentic/grafo/mcp-server.cjs');
  if (fs.existsSync(mcpPath) && vscode.lm && vscode.lm.registerMcpServerDefinitionProvider) {
    context.subscriptions.push(
      vscode.lm.registerMcpServerDefinitionProvider('agentic-kdd', {
        provideMcpServerDefinition: function() {
          return {
            label:   'Agentic KDD',
            command: 'node',
            args:    [mcpPath],
            type:    'stdio',
            env:     { PROJECT_ROOT: projectRoot },
          };
        },
      })
    );
  }

  // 3. Status bar
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  const installed = fs.existsSync(path.join(projectRoot, '.agentic/memoria.db'));
  bar.text    = installed ? '$(circuit-board) Agentic KDD' : '$(circuit-board) Agentic (akdd init)';
  bar.tooltip = 'Agentic KDD — click to open dashboard';
  bar.command = 'agentickdd.showDashboard';
  bar.show();
  context.subscriptions.push(bar);

  // 4. Commands
  function runTerm(name, cmd) {
    var t = vscode.window.createTerminal(name);
    t.show();
    t.sendText(cmd);
  }

  function reg(id, fn) {
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  }

  reg('agentickdd.showDashboard', function() {
    vscode.commands.executeCommand('agentickdd.dashboard.focus');
  });

  reg('agentickdd.indexAST', function() {
    runTerm('Agentic — AST', 'cd "' + projectRoot + '" && node .agentic/grafo/ast-indexer.cjs index');
  });

  reg('agentickdd.queryMemory', async function() {
    var q = await vscode.window.showInputBox({ prompt: 'Search KDD memory...' });
    if (!q) return;
    runTerm('Agentic — Memory', 'cd "' + projectRoot + '" && node .agentic/grafo/kdd-memory.cjs recall "' + q + '"');
  });

  reg('agentickdd.analyzeImpact', function() {
    var f = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.fsPath;
    if (!f) { vscode.window.showWarningMessage('Open a file first'); return; }
    var rel = path.relative(projectRoot, f);
    runTerm('Agentic — Impact', 'cd "' + projectRoot + '" && node .agentic/grafo/impact-analyzer.cjs analyze "' + rel + '"');
  });

  reg('agentickdd.blastRadius', function() {
    var f = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.fsPath;
    if (!f) { vscode.window.showWarningMessage('Open a file first'); return; }
    var rel = path.relative(projectRoot, f);
    runTerm('Agentic — Blast', 'cd "' + projectRoot + '" && node .agentic/grafo/contract-guard.cjs blast "' + rel + '"');
  });

  reg('agentickdd.createSpec', async function() {
    var mod = await vscode.window.showInputBox({ prompt: 'Module name...' });
    if (!mod) return;
    var tipo = await vscode.window.showQuickPick(['feature', 'bugfix'], { placeHolder: 'Spec type' });
    if (!tipo) return;
    runTerm('Agentic — Spec',
      'cd "' + projectRoot + '" && node .agentic/grafo/spec-manager.cjs create "' + mod + '"' + (tipo === 'bugfix' ? ' --bugfix' : '')
    );
  });

  reg('agentickdd.syncKnowledge', function() {
    runTerm('Agentic — Sync',
      'cd "' + projectRoot + '" && node .agentic/grafo/adr-ingestor.cjs ingest && node .agentic/grafo/knowledge-ingestor.cjs ingest'
    );
  });

  reg('agentickdd.contractsStatus', function() {
    runTerm('Agentic — Contracts', 'cd "' + projectRoot + '" && node .agentic/grafo/contract-guard.cjs status');
  });

  reg('agentickdd.historial', function() {
    runTerm('Agentic — Historial', 'cd "' + projectRoot + '" && node .agentic/grafo/session-guard.cjs historial');
  });

  reg('agentickdd.health', function() {
    runTerm('Agentic — Health', 'cd "' + projectRoot + '" && node .agentic/grafo/health-check.cjs');
  });

  reg('agentickdd.detectPatterns', function() {
    runTerm('Agentic — Patterns', 'cd "' + projectRoot + '" && node .agentic/grafo/autonomous-decision.cjs queue');
  });

  reg('agentickdd.report', function() {
    runTerm('Agentic — Report', 'cd "' + projectRoot + '" && node .agentic/grafo/effectiveness-report.cjs');
  });

  // 5. File save hook
  var cfg = vscode.workspace.getConfiguration('agentickdd');
  if (cfg.get('astEnabled')) {
    context.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument(function(doc) {
        var fp  = doc.uri.fsPath;
        var ext = path.extname(fp);
        var ok  = ['.ts','.tsx','.js','.jsx','.py','.go','.rs','.php'];
        if (ok.indexOf(ext) < 0) return;
        if (fp.indexOf('node_modules') >= 0 || fp.indexOf('.agentic') >= 0) return;
        try {
          var rel = path.relative(projectRoot, fp);
          execSync(
            'node .agentic/grafo/ast-indexer.cjs index "' + path.dirname(rel) + '"',
            { cwd: projectRoot, timeout: 10000, stdio: 'ignore' }
          );
          provider.refresh();
        } catch(e) {}
      })
    );
  }
}

function deactivate() {}

// ─── SIDEBAR PROVIDER ─────────────────────────────────────────────────────────

function AgenticSidebarProvider(extensionUri, projectRoot) {
  this.extensionUri = extensionUri;
  this.projectRoot  = projectRoot;
  this._view        = null;
  this._timer       = null;
}

AgenticSidebarProvider.prototype.resolveWebviewView = function(webviewView) {
  var self = this;
  this._view = webviewView;

  webviewView.webview.options = {
    enableScripts: true,
    localResourceRoots: [this.extensionUri],
  };

  webviewView.webview.html = this._buildHtml();

  webviewView.webview.onDidReceiveMessage(function(msg) {
    var root = self.projectRoot;
    function runTerm(name, cmd) {
      var t = vscode.window.createTerminal(name);
      t.show();
      t.sendText(cmd);
    }
    switch (msg.cmd) {
      case 'health':     vscode.commands.executeCommand('agentickdd.health'); break;
      case 'contracts':  vscode.commands.executeCommand('agentickdd.contractsStatus'); break;
      case 'historial':  vscode.commands.executeCommand('agentickdd.historial'); break;
      case 'report':     vscode.commands.executeCommand('agentickdd.report'); break;
      case 'dashboard':  runTerm('Agentic', 'cd "' + root + '" && node dashboard.cjs'); break;
      case 'search':
        vscode.window.showInputBox({ prompt: 'Search KDD memory...' }).then(function(q) {
          if (q) runTerm('Memory', 'cd "' + root + '" && node .agentic/grafo/kdd-memory.cjs recall "' + q + '"');
        });
        break;
    }
  });

  this._timer = setInterval(function() {
    if (webviewView.visible) self.refresh();
  }, 60000);

  webviewView.onDidDispose(function() {
    clearInterval(self._timer);
  });
};

AgenticSidebarProvider.prototype.refresh = function() {
  if (this._view) this._view.webview.html = this._buildHtml();
};

AgenticSidebarProvider.prototype._getStats = function() {
  var root = this.projectRoot;
  var db   = path.join(root, '.agentic/memoria.db');
  var s    = { installed: false, nodes: 0, high: 0, cycles: 0, protected: 0, violations: 0 };

  if (!fs.existsSync(db)) return s;
  s.installed = true;

  try {
    var res = execSync(
      'node -e "try{' +
      'var D=require(\'better-sqlite3\');' +
      'var db=new D(\'' + db.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + '\',{readonly:true});' +
      'var r={' +
        'n:db.prepare(\'SELECT COUNT(*) as n FROM nodos WHERE estado=\\\'ACTIVO\\\'\').get().n,' +
        'h:db.prepare(\'SELECT COUNT(*) as n FROM nodos WHERE confianza=\\\'ALTA\\\' AND estado=\\\'ACTIVO\\\'\').get().n,' +
        'c:0,p:0,v:0' +
      '};' +
      'try{r.c=db.prepare(\'SELECT COUNT(*) as n FROM ciclos\').get().n}catch(e){}' +
      'try{r.p=db.prepare(\'SELECT COUNT(*) as n FROM verified_contracts WHERE status=\\\'protected\\\'\').get().n}catch(e){}' +
      'try{r.v=db.prepare(\'SELECT COUNT(*) as n FROM contract_violations WHERE recovered=0\').get().n}catch(e){}' +
      'process.stdout.write(JSON.stringify(r));db.close()' +
      '}catch(e){process.stdout.write(JSON.stringify({n:0,h:0,c:0,p:0,v:0}))}"',
      { cwd: root, timeout: 5000, stdio: 'pipe' }
    ).toString().trim();

    var parsed = JSON.parse(res);
    s.nodes      = parsed.n || 0;
    s.high       = parsed.h || 0;
    s.cycles     = parsed.c || 0;
    s.protected  = parsed.p || 0;
    s.violations = parsed.v || 0;
  } catch(e) {}

  return s;
};

AgenticSidebarProvider.prototype._buildHtml = function() {
  var s   = this._getStats();
  var dot = s.violations > 0 ? '#f87171' : s.protected > 0 ? '#34d399' : '#fbbf24';
  var lbl = s.violations > 0 ? 'Violations detected' : s.protected > 0 ? 'Contracts active' : 'No contracts yet';

  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>' +
    '*{box-sizing:border-box;margin:0;padding:0}' +
    'body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);font-size:12px;padding:10px;background:var(--vscode-sideBar-background)}' +
    '.hdr{display:flex;align-items:center;gap:6px;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid var(--vscode-sideBarSectionHeader-border,#333)}' +
    '.ttl{font-size:13px;font-weight:600}' +
    '.bdg{font-size:10px;padding:1px 6px;border-radius:10px;background:#7F77DD22;color:#9f99e8}' +
    '.warn{padding:10px;background:#3d2f0030;border:1px solid #fbbf24;border-radius:4px;margin-bottom:10px;font-size:11px}' +
    '.grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px}' +
    '.card{background:var(--vscode-input-background);border-radius:4px;padding:8px;text-align:center;border:1px solid var(--vscode-input-border,#333)}' +
    '.val{font-size:18px;font-weight:700;line-height:1.2}' +
    '.lbl{font-size:10px;color:var(--vscode-descriptionForeground);margin-top:2px}' +
    '.pur{color:#9f99e8}.grn{color:#34d399}.amb{color:#fbbf24}.red{color:#f87171}' +
    '.sbar{display:flex;align-items:center;gap:6px;padding:6px 8px;background:var(--vscode-input-background);border-radius:4px;margin-bottom:10px;font-size:11px}' +
    '.dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}' +
    '.btns{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-bottom:8px}' +
    '.btn{background:var(--vscode-button-secondaryBackground,#2d2d2d);color:var(--vscode-button-secondaryForeground,#ccc);border:1px solid var(--vscode-button-border,#444);padding:5px 8px;cursor:pointer;border-radius:3px;font-size:11px;text-align:center}' +
    '.btn:hover{background:var(--vscode-button-secondaryHoverBackground,#3d3d3d)}' +
    '.pri{background:#7F77DD;color:#fff;border-color:#7F77DD;grid-column:1/-1}' +
    '.pri:hover{background:#9f99e8}' +
    '.ft{font-size:10px;color:var(--vscode-descriptionForeground);text-align:center;margin-top:8px}' +
    '</style></head><body>' +
    '<div class="hdr"><span>⚡</span><span class="ttl">Agentic KDD</span><span class="bdg">v0.2.0</span></div>' +
    (!s.installed ? '<div class="warn">⚠️ Not initialized.<br>Run: <strong>akdd init</strong></div>' : '') +
    '<div class="grid">' +
      '<div class="card"><div class="val pur">' + s.nodes + '</div><div class="lbl">Memory nodes</div></div>' +
      '<div class="card"><div class="val grn">' + s.high + '</div><div class="lbl">HIGH rules</div></div>' +
      '<div class="card"><div class="val amb">' + s.cycles + '</div><div class="lbl">Cycles run</div></div>' +
      '<div class="card"><div class="val ' + (s.violations > 0 ? 'red' : 'grn') + '">' + s.protected + '</div><div class="lbl">Protected contracts</div></div>' +
    '</div>' +
    '<div class="sbar"><div class="dot" style="background:' + dot + '"></div><span>' + lbl + '</span></div>' +
    '<div class="btns">' +
      '<button class="btn pri" onclick="s(\'dashboard\')">📊 Open Full Dashboard</button>' +
      '<button class="btn" onclick="s(\'contracts\')">🛡️ Contracts</button>' +
      '<button class="btn" onclick="s(\'historial\')">📋 Historial</button>' +
      '<button class="btn" onclick="s(\'search\')">🔍 Search Memory</button>' +
      '<button class="btn" onclick="s(\'report\')">📈 Report</button>' +
      '<button class="btn" onclick="s(\'health\')">🩺 Health</button>' +
    '</div>' +
    '<div class="ft">' + (s.installed ? s.nodes + ' nodes · ' + s.cycles + ' cycles' : 'Run akdd init to start') + '</div>' +
    '<script>const vscode=acquireVsCodeApi();function s(c){vscode.postMessage({cmd:c})}</script>' +
    '</body></html>';
};

module.exports = { activate, deactivate };
