'use strict';
/* Los escritores del motor respetan la exclusión de `akdd update` (3.20.1). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const real = require('./helpers/db-real.cjs');
const { REPO, dba } = real;
const GRAFO = path.join(REPO, '.agentic', 'grafo');
const guard = require(path.join(GRAFO, 'update-guard.cjs'));
const sc = require(path.join(GRAFO, 'schema-catalog.cjs'));
const { rpcMcp } = require('../src/update-verify.js');

/** Un proyecto con el motor actual y una base completa. */
function proyecto() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-escr-')));
  fs.mkdirSync(path.join(root, '.agentic', 'memoria'), { recursive: true });
  fs.cpSync(GRAFO, path.join(root, '.agentic', 'grafo'), { recursive: true, filter: (s) => !/[\\/](vendor|graph-ui)([\\/]|$)/.test(s) });
  const f = path.join(root, '.agentic', 'memoria.db');
  real.crearBase(f, { propias: false });
  const w = dba.openWrite(f, { updateOwner: true });
  try { sc.apply(w, { version: 'prueba' }); } finally { w.close(); }
  fs.writeFileSync(path.join(root, '.agentic', 'config.md'), 'CONFIGURADO: SI\n');
  return root;
}
const motor = (root, script, args = []) => spawnSync(process.execPath, [path.join(root, '.agentic', 'grafo', script), ...args], { cwd: root, encoding: 'utf8', timeout: 60000, env: { ...process.env, PROJECT_ROOT: root, NODE_NO_WARNINGS: '1', AKDD_UPDATE_TOKEN: '' } });

test('MCP: el servidor REAL pausa, deja el ack que el actualizador espera, rechaza herramientas y se reanuda solo', async () => {
  const root = proyecto();
  const server = path.join(root, '.agentic', 'grafo', 'mcp-server.cjs');
  const { spawn } = require('node:child_process');
  const p = spawn(process.execPath, [server], { cwd: root, env: { ...process.env, PROJECT_ROOT: root, NODE_NO_WARNINGS: '1', AKDD_UPDATE_TOKEN: '' }, stdio: ['pipe', 'pipe', 'ignore'] });
  const pend = new Map(); let buf = '';
  p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!l) continue; try { const m = JSON.parse(l); const r = pend.get(m.id); if (r) { pend.delete(m.id); r(m); } } catch { /* log */ } } });
  let n = 0;
  const llamar = (method, params) => new Promise((res, rej) => { const id = ++n; pend.set(id, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); setTimeout(() => rej(new Error('sin respuesta a ' + method)), 20000); });
  try {
    const init = await llamar('initialize', {});
    assert.equal(init.result.serverInfo.name, 'agentic-kdd');
    assert.equal((await llamar('ping')).result !== undefined, true, 'ping responde');
    const normal = await llamar('tools/call', { name: 'recall', arguments: { query: 'regla' } });
    assert.ok(normal.result, 'antes del update atiende');

    const h = guard.acquire(root, { opId: 'op-mcp', timeoutMs: 100 });
    try {
      const w = await guard.waitForWriters(root, 'op-mcp', 6000);
      assert.equal(w.ok, true, JSON.stringify(w));
      assert.equal(w.acked.length, 1, 'el MCP confirmó la pausa');
      const pausado = await llamar('tools/call', { name: 'recall', arguments: { query: 'regla' } });
      assert.equal(pausado.error.code, -32000);
      assert.match(pausado.error.message, /UPDATE_IN_PROGRESS/);
    } finally { guard.release(h); }
    let ok = false;
    for (let i = 0; i < 40 && !ok; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const r = await llamar('tools/call', { name: 'recall', arguments: { query: 'regla' } });
      ok = !!r.result;
    }
    assert.ok(ok, 'al terminar el update el MCP vuelve a atender solo');
  } finally { p.kill(); }
});

test('MCP: en una carpeta SIN Agentix no se registra ni crea nada', () => {
  const vacia = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-vacia-'));
  const p = spawnSync(process.execPath, [path.join(GRAFO, 'mcp-server.cjs')], { cwd: vacia, input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n', encoding: 'utf8', timeout: 20000, env: { ...process.env, PROJECT_ROOT: vacia, NODE_NO_WARNINGS: '1' } });
  assert.ok(p.stdout.includes('"id":1'));
  assert.ok(!fs.existsSync(path.join(vacia, '.agentic')), 'no se sembró .agentic');
});

test('cola de commits: con un update vivo no se procesa (queda intacta); sin update se procesa', () => {
  const root = proyecto();
  const runner = require(path.join(root, '.agentic', 'grafo', 'hook-runner.cjs'));
  const h = guard.acquire(root, { opId: 'op-cola', timeoutMs: 100 });
  try {
    const r = runner.drenar(root, { ejecutar: () => { throw new Error('no debía ejecutarse durante el update'); } });
    assert.equal(r.update_in_progress, true);
    assert.deepEqual(r.processed, []);
  } finally { guard.release(h); }
  const despues = runner.drenar(root, { ejecutar: () => ({ status: 'PASS' }) });
  assert.ok(!despues.update_in_progress);
});

test('post-cycle y telemetría en segundo plano se POSPONEN (código 75) mientras dura el update', () => {
  const root = proyecto();
  const h = guard.acquire(root, { opId: 'op-pc', timeoutMs: 100 });
  try {
    const a = motor(root, 'post-cycle.cjs', ['general', '--tests=1', '--task=prueba']);
    assert.equal(a.status, 75, a.stdout + a.stderr);
    assert.match(a.stderr, /UPDATE_IN_PROGRESS/);
    const b = motor(root, 'gate-telemetry.cjs', ['stats']);
    assert.equal(b.status, 75, b.stdout + b.stderr);
  } finally { guard.release(h); }
  const c = motor(root, 'gate-telemetry.cjs', ['stats']);
  assert.notEqual(c.status, 75, 'sin update, funciona');
});

test('lock-manager: abrir su base durante un update falla con UPDATE_IN_PROGRESS', () => {
  const root = proyecto();
  const h = guard.acquire(root, { opId: 'op-lm', timeoutMs: 100 });
  try {
    const r = motor(root, 'lock-manager.cjs', ['acquire', '--module=prueba', '--files=a.js', '--purpose=x']);
    assert.match(r.stdout + r.stderr, /UPDATE_IN_PROGRESS/);
  } finally { guard.release(h); }
});
