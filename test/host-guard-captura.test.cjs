'use strict';
// Canarios: valores FALSOS con formato de secreto, codificados para que el escáner de secretos del repo no los confunda con una filtración real.
const dec = (b) => Buffer.from(b, 'base64').toString('utf8');
/* C01/C02: captura PASIVA de lo que el host entrega por sus hooks. Nunca cambia la decisión de la guardia. */
const test = require('node:test');
const { SIN_DRIVER } = require('./helpers/db-real.cjs');
if (SIN_DRIVER) { test(require('node:path').basename(__filename) + ' (omitido: ' + SIN_DRIVER + ')', { skip: SIN_DRIVER }, () => {}); return; }
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { proyecto, REPO } = require('./helpers/memoria-proyecto.cjs');

function conMotor(nombre, opts) {
  const p = proyecto(nombre, opts);
  fs.cpSync(path.join(REPO, '.agentic', 'grafo'), path.join(p.root, '.agentic', 'grafo'), { recursive: true });
  return p;
}
const guardia = (p, host, evento, entrada, env = {}) => spawnSync(process.execPath, [path.join(p.root, '.agentic', 'grafo', 'host-guard.cjs'), '--host=' + host, '--event=' + evento], {
  cwd: p.root, input: JSON.stringify(entrada), encoding: 'utf8', timeout: 60000,
  env: { ...process.env, AKDD_NO_MEMORY_CAPTURE: '0', NODE_NO_WARNINGS: '1', ...env },
});
const eventos = (p) => { const d = p.abrirR(); try { return d.all('SELECT host, event_type, paths, input_summary, output_summary, host_event_id FROM mem_events ORDER BY rowid'); } finally { d.close(); } };

test('la guardia del host registra shell, edición y MCP que RECIBE, con su decisión; los secretos salen tapados', () => {
  const p = conMotor('hg-captura');
  try {
    const a = guardia(p, 'claude', 'shell', { tool_name: 'Bash', tool_use_id: 'tu-1', session_id: 'sess-9', tool_input: { command: dec('Y3VybCAtSCAiQXV0aG9yaXphdGlvbjogQmVhcmVyIEFCQ0RFRkdISUpLTE1OT1AxMjM0NSIgaHR0cHM6Ly94') }, cwd: p.root });
    assert.equal(a.status, 0, a.stderr);
    guardia(p, 'cursor', 'edit', { tool_name: 'Write', tool_use_id: 'tu-2', conversation_id: 'conv-1', tool_input: { path: 'src/a.js' }, workspace_roots: [p.root] });
    const e = eventos(p);
    assert.deepEqual(e.map((x) => x.event_type), ['shell_command', 'file_edit']);
    assert.equal(e[0].host, 'claude');
    assert.equal(e[0].host_event_id, 'tu-1', 'usa el id del host: reenviar el mismo hook no duplica');
    assert.ok(!/ABCDEFGHIJKLMNOP12345/.test(JSON.stringify(e)), 'el secreto del comando no se guardó');
    assert.ok(/allow|deny/.test(e[0].output_summary), 'queda la decisión de la guardia, no la salida de la herramienta');
    assert.deepEqual(JSON.parse(e[1].paths), ['src/a.js']);
    // El mismo hook reenviado es una sola actividad.
    guardia(p, 'claude', 'shell', { tool_name: 'Bash', tool_use_id: 'tu-1', session_id: 'sess-9', tool_input: { command: 'curl https://x' }, cwd: p.root });
    assert.equal(eventos(p).length, 2);
  } finally { p.limpiar(); }
});

test('una simulación se etiqueta -smoke; con el aislamiento de pruebas activo no se escribe nada', () => {
  const p = conMotor('hg-smoke');
  try {
    guardia(p, 'cursor', 'shell', { command: 'echo hola', hook_event_name: 'beforeShellExecution', workspace_roots: [p.root] }, { AKDD_HOOK_SMOKE: '1' });
    assert.equal(eventos(p)[0].host, 'cursor-smoke', 'jamás se cuenta como verificación dentro de Cursor');
    const n = eventos(p).length;
    guardia(p, 'cursor', 'shell', { command: 'echo otro', workspace_roots: [p.root] }, { AKDD_NO_MEMORY_CAPTURE: '1' });
    assert.equal(eventos(p).length, n, 'AKDD_NO_MEMORY_CAPTURE=1: las pruebas no ensucian la memoria real');
  } finally { p.limpiar(); }
});

test('si la memoria no está lista (sin tablas) la guardia sigue decidiendo igual: la captura jamás bloquea ni cambia un deny', () => {
  const p = conMotor('hg-sin-tablas', { catalogo: false, nodos: 0 });
  try {
    const peligroso = guardia(p, 'claude', 'shell', { tool_name: 'Bash', tool_input: { command: 'rm -rf /' }, cwd: p.root });
    const inocuo = guardia(p, 'claude', 'shell', { tool_name: 'Bash', tool_input: { command: 'echo hola' }, cwd: p.root });
    assert.equal(peligroso.status, 0);
    assert.match(peligroso.stdout, /deny|ask/, 'la decisión de seguridad no depende de la captura');
    assert.ok(!/deny/.test(inocuo.stdout || ''), 'y un comando inocuo no se niega por no poder registrar');
    const d = p.abrirR();
    try { assert.equal(d.all("SELECT name FROM sqlite_master WHERE name = 'mem_events'").length, 0, 'tampoco creó las tablas: no migra'); } finally { d.close(); }
  } finally { p.limpiar(); }
});
