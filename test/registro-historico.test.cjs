'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const GRAFO = path.join(__dirname, '..', '.agentic', 'grafo');

test('reconciliar: registra el commit sin ciclo como histórico, sin duración, y es idempotente', () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-'));
  const sh = (cmd, args) => spawnSync(cmd, args, { cwd: t, encoding: 'utf8', timeout: 60000 });
  sh('git', ['init', '-q']); sh('git', ['config', 'user.email', 'a@b.c']); sh('git', ['config', 'user.name', 't']);
  fs.mkdirSync(path.join(t, 'src'), { recursive: true });
  fs.cpSync(GRAFO, path.join(t, '.agentic', 'grafo'), { recursive: true });
  fs.writeFileSync(path.join(t, 'src', 'a.js'), 'x=1\n');
  sh('git', ['add', 'src']); sh('git', ['commit', '-q', '-m', 'fix: algo']);
  sh('node', ['.agentic/grafo/grafo.cjs', 'sync']);
  const rh = '.agentic/grafo/registro-historico.cjs';
  const lista = sh('node', [rh]);
  assert.match(lista.stdout, /sin ciclo: 1/);
  const ap = sh('node', [rh, '--aplicar']);
  assert.match(ap.stdout, /Registrados: 1 · con error: 0/);
  const db = require(path.join(GRAFO, 'db-adapter.cjs')).openReadOnly(path.join(t, '.agentic', 'memoria.db'));
  try {
    const c = db.all('SELECT post_cycle_ran, fecha_inicio, fecha_fin, tipo_tarea FROM ciclos');
    assert.strictEqual(c.length, 1);
    assert.strictEqual(c[0].post_cycle_ran, 'historico');
    assert.strictEqual(c[0].fecha_inicio, c[0].fecha_fin);
    assert.strictEqual(c[0].tipo_tarea, 'fix');
  } finally { db.close(); }
  assert.match(sh('node', [rh]).stdout, /sin ciclo: 0/);
  fs.rmSync(t, { recursive: true, force: true });
});
