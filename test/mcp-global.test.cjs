'use strict';
/* MCP global (3.20). Una sola entrada global para todos los proyectos, sin
 * mezclar memorias: el lanzador arranca el servidor DEL PROYECTO abierto.
 * Hasta 3.19 `akdd mcp --global` escribía en una ruta que Cursor no lee y
 * apuntaba al motor de un proyecto concreto. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const LAUNCHER = path.join(REPO, 'src', 'mcp-launcher.cjs');
const { resolverProyecto } = require(LAUNCHER);
const { mcpGlobal, mcpSetup, fusionarMcpJson } = require(path.join(REPO, 'src', 'mcp-setup.js'));

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const escribir = (raiz, rel, txt) => { const f = path.join(raiz, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, txt); return f; };
const SIN_PROYECTO = { AGENTIX_PROJECT_ROOT: '', PROJECT_ROOT: '', CLAUDE_PROJECT_DIR: '' };

/* Servidor falso: responde initialize diciendo con qué PROJECT_ROOT y cwd arrancó. */
const FAKE_SERVER = `const rl=require('readline').createInterface({input:process.stdin});
rl.on('line',l=>{const m=JSON.parse(l);if(m.id==null)return;process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{root:process.env.PROJECT_ROOT,cwd:process.cwd()}})+'\\n');});`;

function proyectoFalso() {
  const raiz = tmp('akdd-mcpproj-');
  escribir(raiz, '.agentic/grafo/mcp-server.cjs', FAKE_SERVER);
  fs.mkdirSync(path.join(raiz, 'src', 'modulo'), { recursive: true });
  return fs.realpathSync(raiz);
}

/** Habla JSON-RPC por stdio y devuelve las respuestas recibidas antes de cerrar. */
function conversar(script, { cwd, env, mensajes, esperar }) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [script], { cwd, env: Object.assign({}, process.env, env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const respuestas = []; let buf = '';
    const t = setTimeout(() => { p.kill(); reject(Error('timeout: ' + JSON.stringify(respuestas))); }, 30000);
    p.stdout.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (l) respuestas.push(JSON.parse(l));
        if (respuestas.length >= esperar) { clearTimeout(t); p.stdin.end(); p.kill(); resolve(respuestas); }
      }
    });
    p.on('error', reject);
    for (const m of mensajes) p.stdin.write(JSON.stringify(Object.assign({ jsonrpc: '2.0' }, m)) + '\n');
  });
}

test('MCP global: el lanzador encuentra el proyecto subiendo desde una subcarpeta', () => {
  const raiz = proyectoFalso();
  assert.equal(resolverProyecto(SIN_PROYECTO, path.join(raiz, 'src', 'modulo')), raiz);
});

test('MCP global: ${workspaceFolder} sin interpolar se ignora y manda la carpeta real', () => {
  const raiz = proyectoFalso();
  assert.equal(resolverProyecto({ AGENTIX_PROJECT_ROOT: '${workspaceFolder}' }, raiz), raiz);
});

test('MCP global: la variable explícita gana a la carpeta de arranque', () => {
  const a = proyectoFalso(), b = proyectoFalso();
  assert.equal(resolverProyecto({ AGENTIX_PROJECT_ROOT: b }, a), b);
});

test('MCP global: fuera de un proyecto Agentix no resuelve ninguno', () => {
  const fuera = tmp('akdd-sinproy-');
  assert.equal(resolverProyecto(SIN_PROYECTO, fuera), null);
});

test('MCP global: arranca el servidor DEL proyecto con su PROJECT_ROOT y su carpeta', async () => {
  const raiz = proyectoFalso();
  const [r] = await conversar(LAUNCHER, { cwd: path.join(raiz, 'src', 'modulo'), env: SIN_PROYECTO, mensajes: [{ id: 1, method: 'initialize', params: {} }], esperar: 1 });
  assert.equal(fs.realpathSync(r.result.root), raiz);
  assert.equal(fs.realpathSync(r.result.cwd), raiz);
});

test('MCP global: sin proyecto responde MCP válido, no consulta memoria y calla las notificaciones', async () => {
  const fuera = tmp('akdd-sinproy-');
  const r = await conversar(LAUNCHER, {
    cwd: fuera, env: SIN_PROYECTO, esperar: 4,
    mensajes: [
      { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { method: 'notifications/initialized' },
      { id: 2, method: 'tools/list' },
      { id: 3, method: 'tools/call', params: { name: 'agentix_status', arguments: {} } },
      { id: 4, method: 'ping' },
    ],
  });
  assert.deepEqual(r.map((x) => x.id), [1, 2, 3, 4], 'la notificación no lleva respuesta');
  assert.equal(r[0].result.serverInfo.name, 'agentic-kdd');
  assert.deepEqual(r[1].result.tools.map((t) => t.name), ['agentix_status']);
  assert.match(r[2].result.content[0].text, /akdd init/);
  assert.deepEqual(r[3].result, {});
});

test('MCP servidor real: una notificación no recibe respuesta y ping contesta', { timeout: 120000 }, async () => {
  const raiz = tmp('akdd-mcpreal-');
  fs.cpSync(path.join(REPO, '.agentic', 'grafo'), path.join(raiz, '.agentic', 'grafo'), { recursive: true, filter: (s) => !/[\\/]vendor([\\/]|$)/.test(s) });
  const r = await conversar(path.join(raiz, '.agentic', 'grafo', 'mcp-server.cjs'), {
    cwd: raiz, env: { PROJECT_ROOT: raiz, NODE_PATH: path.join(REPO, 'node_modules') }, esperar: 2,
    mensajes: [{ method: 'notifications/initialized' }, { id: 7, method: 'ping' }, { id: 8, method: 'initialize', params: {} }],
  });
  assert.deepEqual(r.map((x) => x.id), [7, 8]);
  assert.deepEqual(r[0].result, {});
  assert.equal(r[1].result.serverInfo.name, 'agentic-kdd');
});

test('akdd mcp --global: escribe ~/.cursor/mcp.json conservando los otros MCP, copia el lanzador y no toca el proyecto', async () => {
  const home = tmp('akdd-home-');
  const otros = { mcpServers: { 'supabase komerza': { url: 'https://example.invalid/mcp', headers: {} } } };
  escribir(home, '.cursor/mcp.json', JSON.stringify(otros, null, 2));
  const proyecto = proyectoFalso();

  const r = await mcpSetup(proyecto, { global: true, home, claude: false, quiet: true });
  assert.equal(r.cursor_global, true);
  const cfg = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8'));
  assert.deepEqual(cfg.mcpServers['supabase komerza'], otros.mcpServers['supabase komerza'], 'el MCP ajeno queda igual');
  const destino = path.join(home, '.agentix', 'mcp-launcher.cjs');
  assert.deepEqual(cfg.mcpServers['agentic-kdd'], { command: 'node', args: [destino], env: { AGENTIX_PROJECT_ROOT: '${workspaceFolder}' } });
  assert.equal(fs.readFileSync(destino, 'utf8'), fs.readFileSync(LAUNCHER, 'utf8'));
  assert.ok(!fs.existsSync(path.join(proyecto, '.cursor')), 'global no escribe dentro del proyecto');

  const antes = fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8');
  mcpGlobal({ home, claude: false, quiet: true });
  assert.equal(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8'), antes, 'idempotente');
});

test('akdd mcp --global: un mcp.json inválido se conserva byte a byte', () => {
  const home = tmp('akdd-home-');
  const roto = '{ "mcpServers": { "x": ';
  escribir(home, '.cursor/mcp.json', roto);
  const r = mcpGlobal({ home, claude: false, quiet: true });
  assert.equal(r.cursor_global, false);
  assert.equal(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8'), roto);
  assert.equal(fusionarMcpJson(path.join(home, '.cursor', 'mcp.json'), {}).reason, 'INVALID_JSON');
});
