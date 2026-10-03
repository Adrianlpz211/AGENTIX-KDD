'use strict';
/* El guardia de hooks del IDE tomaba como raíz el cwd de la terminal. Con la
 * sesión parada en src/, creó src/.agentic/_hooks-eventos.jsonl y el release
 * check lo atrapó dentro del paquete npm (03/10/2026). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const hg = require('../.agentic/grafo/host-guard.cjs');

function proyecto() {
  const r = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-hg-')));
  fs.mkdirSync(path.join(r, '.agentic', 'grafo'), { recursive: true });
  fs.mkdirSync(path.join(r, 'src', 'deep'), { recursive: true });
  return r;
}

test('host-guard: desde una subcarpeta la raíz es la del proyecto, no el cwd', () => {
  const r = proyecto();
  assert.equal(hg.raizProyecto([null, undefined, path.join(r, 'src', 'deep')]), r);
});

test('host-guard: ${workspaceFolder} sin interpolar se ignora', () => {
  const r = proyecto();
  assert.equal(hg.raizProyecto(['${workspaceFolder}', path.join(r, 'src')]), r);
});

test('host-guard: el evento se anota en la raíz y nunca siembra .agentic en una subcarpeta', () => {
  const r = proyecto();
  hg.anotarEvento(hg.raizProyecto([path.join(r, 'src')]), 'claude', 'shell', { tool_use_id: 't1' }, { decision: 'allow' });
  assert.ok(fs.existsSync(path.join(r, '.agentic', '_hooks-eventos.jsonl')));
  assert.ok(!fs.existsSync(path.join(r, 'src', '.agentic')));
});

test('host-guard: fuera de un proyecto Agentix no escribe nada', () => {
  const fuera = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-hgx-'));
  hg.anotarEvento(hg.raizProyecto([fuera]), 'cursor', 'shell', {}, { decision: 'allow' });
  assert.ok(!fs.existsSync(path.join(fuera, '.agentic')));
});
