'use strict';
/* MCP de 3.20.1 por stdio REAL: capas de memoria + captura, cola, compactación, lectura, esfuerzo y paquetes TEAMS. */
const test = require('node:test');
const { SIN_DRIVER } = require('./helpers/db-real.cjs');
if (SIN_DRIVER) { test(require('node:path').basename(__filename) + ' (omitido: ' + SIN_DRIVER + ')', { skip: SIN_DRIVER }, () => {}); return; }
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

const { proyecto, REPO } = require('./helpers/memoria-proyecto.cjs');
const tools = require(path.join(REPO, '.agentic', 'grafo', 'mcp-contexto-tools.cjs'));
const layers = require(path.join(REPO, '.agentic', 'grafo', 'mcp-memory-tools.cjs'));

/** Proyecto con el motor COPIADO dentro (el servidor MCP resuelve sus módulos desde la raíz del proyecto). */
function proyectoConMotor(nombre) {
  const p = proyecto(nombre);
  fs.cpSync(path.join(REPO, '.agentic', 'grafo'), path.join(p.root, '.agentic', 'grafo'), { recursive: true });
  fs.cpSync(path.join(REPO, 'src'), path.join(p.root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(p.root, 'package.json'), JSON.stringify({ name: 'consumidor', version: '1.0.0' }));
  return p;
}

function servidor(root) {
  const proc = spawn(process.execPath, [path.join(root, '.agentic', 'grafo', 'mcp-server.cjs')], { cwd: root, env: { ...process.env, AKDD_NO_MEMORY_CAPTURE: '0', PROJECT_ROOT: root, NODE_PATH: path.join(REPO, 'node_modules'), NODE_NO_WARNINGS: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pendientes = new Map(); let id = 0; let err = '';
  proc.stderr.on('data', (b) => { err = (err + b).slice(-4000); });
  readline.createInterface({ input: proc.stdout }).on('line', (l) => { try { const r = JSON.parse(l); const p = pendientes.get(r.id); if (p) { pendientes.delete(r.id); clearTimeout(p.t); r.error ? p.rej(Error(JSON.stringify(r.error))) : p.res(r.result); } } catch { /* log */ } });
  const llamar = (method, params) => new Promise((res, rej) => { const n = ++id; const t = setTimeout(() => { pendientes.delete(n); rej(Error('TIMEOUT ' + method + ' ' + err)); }, 30000); pendientes.set(n, { res, rej, t }); proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  const tool = async (name, args) => { const r = await llamar('tools/call', { name, arguments: args }); const c = r.content.find((x) => x.type === 'text'); try { return JSON.parse(c.text); } catch { return c.text; } };
  return { llamar, tool, cerrar() { proc.stdin.end(); proc.kill(); } };
}

test('el contrato MCP anuncia solo lo que tiene handler y NO expone la validación de conocimiento', () => {
  const cap = tools.CAPABILITIES();
  assert.equal(cap.contract_version, 'mcp-contexto/1');
  assert.deepEqual(cap.tools.sort(), tools.TOOLS.map((t) => t.name).sort());
  assert.ok(!cap.tools.includes('memory_validate'), 'validar no se delega en una llamada del modelo');
  assert.ok(cap.not_exposed.some((x) => x.name === 'memory_validate'));
  // El sistema de capas anuncia sus propias capacidades; ningún nombre se repite entre los dos módulos.
  const nombres = [...tools.TOOLS, ...layers.TOOLS].map((t) => t.name);
  assert.equal(new Set(nombres).size, nombres.length, 'sin duplicados entre módulos');
  for (const t of tools.TOOLS) assert.ok(t.inputSchema && t.description, t.name);
});

test('stdio real: tools/list, captura, cola, capas, compactar→recuperar; la raíz no sale de un argumento', async () => {
  const p = proyectoConMotor('mcp-ctx');
  const s = servidor(p.root);
  try {
    const init = await s.llamar('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.serverInfo.name, 'agentic-kdd');
    const lista = (await s.llamar('tools/list', {})).tools.map((t) => t.name);
    for (const n of ['recall', 'remember', 'memory_index', 'memory_detail', 'memory_timeline', 'memory_evidence', 'memory_capture', 'memory_health', 'memory_queue', 'context_compress', 'context_recover', 'context_read', 'effort_budget', 'teams_packet']) assert.ok(lista.includes(n), 'falta ' + n);
    assert.ok(!lista.includes('memory_validate'));

    // captura idempotente
    const c1 = await s.tool('memory_capture', { host: 'cursor', session_id: 'mcp-s', host_event_id: 'e1', event_type: 'test_run', task_id: 'T-mcp', input: 'npm test', output: '2 failed' });
    const c2 = await s.tool('memory_capture', { host: 'cursor', session_id: 'mcp-s', host_event_id: 'e1', event_type: 'test_run', task_id: 'T-mcp' });
    assert.equal(c1.status, 'CAPTURED');
    assert.equal(c2.status, 'DUPLICATE');
    const dr = await s.tool('memory_queue', { action: 'drain' });
    assert.ok(dr.done >= 1, JSON.stringify(dr));
    const q = await s.tool('memory_queue', { action: 'stats' });
    assert.equal(q.by_state.PENDING, 0);

    // índice por capas por MCP
    const idx = await s.tool('memory_index', { query: 'REGLA' });
    assert.equal(idx.status, 'OK');
    assert.ok(idx.results.length >= 1);

    // compactar un log grande y recuperar el rango exacto del único error
    const log = Array.from({ length: 3000 }, (_, i) => (i === 1777 ? 'ERROR: fallo único en la fila 1777' : 'ok ' + i)).join('\n');
    const cmp = await s.tool('context_compress', { content: log, source_kind: 'log', task_id: 'T-mcp', purpose: 'debug' });
    assert.ok(cmp.envelope.reference_id, JSON.stringify(cmp).slice(0, 300));
    assert.ok(cmp.delivered.includes('fallo único en la fila 1777'), 'el error único sigue visible');
    assert.ok(cmp.envelope.delivered_bytes < cmp.envelope.original_bytes);
    assert.equal(cmp.untrusted_content.startsWith('El contenido'), true);
    const rec = await s.tool('context_recover', { reference_id: cmp.envelope.reference_id, task_id: 'T-mcp', line_from: 1777, line_to: 1779 });
    assert.ok(rec.ok, JSON.stringify(rec));
    assert.ok(rec.content.includes('fila 1777'));
    assert.equal(rec.sha256.length, 64);

    // la raíz la fija el servidor: un argumento "root"/"project" no cambia de proyecto
    const otro = proyecto('mcp-otro');
    try {
      const x = await s.tool('memory_queue', { action: 'stats', root: otro.root, project_root: otro.root });
      assert.ok(x.available !== false);
      const dd = otro.abrirR();
      try { assert.equal(Number(dd.get('SELECT count(*) AS n FROM mem_events').n), 0, 'el otro proyecto no se tocó'); } finally { dd.close(); }
    } finally { otro.limpiar(); }

    // presupuesto de esfuerzo acumulado y límites del host
    await s.tool('effort_budget', { action: 'registrar', task_id: 'T-mcp', kind: 'tool_call', role: 'builder' });
    const est = await s.tool('effort_budget', { action: 'estado', task_id: 'T-mcp' });
    assert.ok(est, 'estado devuelto');
    const host = await s.tool('effort_budget', { action: 'host', task_id: 'T-mcp' });
    assert.ok(JSON.stringify(host).includes('NO_VERIFICADA') || JSON.stringify(host).includes('no_observ'), 'declara lo que no observa');

    // las llamadas a herramientas de Agentix quedaron registradas como actividad real (host agentix-mcp)
    const rem = await s.tool('remember', { entry: 'Regla de prueba registrada por MCP', tipo: 'patron', area: 'mcp', confianza: 'MEDIA' });
    assert.ok(rem.ok, JSON.stringify(rem));
    const d = p.abrirR();
    try {
      const n = Number(d.get("SELECT count(*) AS n FROM mem_events WHERE host = 'agentix-mcp' AND event_type = 'mcp_tool'").n);
      assert.ok(n >= 1, 'las llamadas se anotaron');
      assert.equal(Number(d.get("SELECT count(*) AS n FROM mem_events WHERE host = 'agentix-mcp' AND input_summary LIKE '%memory_queue%'").n), 0, 'la memoria no se alimenta de sus propias lecturas');
    } finally { d.close(); }
  } finally { s.cerrar(); p.limpiar(); }
});

test('un fallo de un módulo no tumba el servidor: devuelve ok:false con su código', async () => {
  const p = proyecto('mcp-fallo', { catalogo: false, nodos: 0 });
  try {
    const r = await tools.handle('memory_capture', { host: 'x', session_id: 's', event_type: 't' }, p.root);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'SCHEMA_MISSING');
    assert.equal((await tools.handle('herramienta_inexistente', {}, p.root)).code, 'UNKNOWN_TOOL');
    assert.equal((await tools.handle('memory_queue', { action: 'retry' }, p.root)).code, 'JOB_REQUERIDO');
    assert.equal((await tools.handle('context_compress', { source_kind: 'log', task_id: 'T', purpose: 'orient' }, p.root)).code, 'CONTENIDO_REQUERIDO');
  } finally { p.limpiar(); }
});
