'use strict';

/** H23: .agentic/protected_files se cumple en plan/escritura/update, sin atajos. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const GRAFO = path.join(__dirname, '..', '.agentic', 'grafo');
const pf = require(path.join(GRAFO, 'protected-files.cjs'));
const harness = require(path.join(GRAFO, 'harness.cjs'));
const { guardiaProtegidos } = require(path.join(__dirname, '..', 'src', 'update.js'));

function proyecto(manifiesto) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-prot-')));
  fs.mkdirSync(path.join(dir, '.agentic'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src', 'pagos'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'pagos', 'cobro.js'), '1');
  fs.writeFileSync(path.join(dir, 'src', 'libre.js'), '1');
  if (manifiesto != null) fs.writeFileSync(path.join(dir, '.agentic', 'protected_files'), manifiesto);
  return dir;
}

test('H23: sin manifiesto = vacío explícito; el manifiesto mismo sigue protegido', () => {
  const dir = proyecto(null);
  const m = pf.cargar(dir);
  assert.equal(m.ok, true);
  assert.equal(m.explicitEmpty, true);
  assert.equal(pf.verificar(dir, ['src/libre.js']).status, 'PASS');
  assert.equal(pf.verificar(dir, ['.agentic/protected_files']).status, 'FAIL', 'no se autoedita para eludirse');
  assert.equal(pf.verificar(dir, ['.agentic/protected_unlocks.json']).status, 'FAIL');
});

test('H23: manifiesto inválido = ERROR y el plan no escribe nada', () => {
  const dir = proyecto('src/*.js\n');
  const m = pf.cargar(dir);
  assert.equal(m.status, 'ERROR');
  assert.equal(m.line, 1);
  const r = harness.checkScopeDeviation(['src/libre.js'], [], [], dir);
  assert.equal(r.ok, false);
  assert.equal(r.reason_code, 'MANIFEST_INVALID');
  assert.equal(pf.cargar(proyecto('../fuera\n')).status, 'ERROR', 'una entrada que escapa de la raíz es inválida');
});

test('H23: lo protegido manda sobre el plan, con alias y mayúsculas', () => {
  const dir = proyecto('# pagos\nsrc/pagos/\n');
  const r = harness.checkScopeDeviation(['src/pagos/cobro.js'], ['src/'], [], dir);
  assert.equal(r.ok, false);
  assert.deepEqual(r.protected, ['src/pagos/cobro.js']);
  assert.equal(pf.verificar(dir, ['./src/../src/pagos/cobro.js']).status, 'FAIL');
  if (process.platform === 'win32') assert.equal(pf.verificar(dir, ['SRC/Pagos/COBRO.js']).status, 'FAIL');
  assert.equal(harness.checkScopeDeviation(['src/libre.js'], ['src/'], [], dir).ok, true);
});

test('H23: un junction/enlace hacia lo protegido no lo elude', () => {
  const dir = proyecto('src/pagos/\n');
  const enlace = path.join(dir, 'atajo');
  fs.symlinkSync(path.join(dir, 'src', 'pagos'), enlace, process.platform === 'win32' ? 'junction' : 'dir');
  const r = pf.verificar(dir, ['atajo/cobro.js']);
  assert.equal(r.status, 'FAIL');
  assert.equal(r.blocked[0].file, 'src/pagos/cobro.js');
});

test('H23: update no pisa lo protegido y se detiene ante manifiesto inválido', () => {
  const dir = proyecto('CLAUDE.md\n.agentic/grafo/mio.cjs\n');
  const fuente = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-src-'));
  fs.mkdirSync(path.join(fuente, 'grafo'), { recursive: true });
  fs.writeFileSync(path.join(fuente, 'grafo', 'mio.cjs'), 'NUEVO');
  fs.writeFileSync(path.join(fuente, 'grafo', 'otro.cjs'), 'NUEVO');
  fs.mkdirSync(path.join(dir, '.agentic', 'grafo'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.agentic', 'grafo', 'mio.cjs'), 'MIO');

  const g = guardiaProtegidos(dir, null);
  assert.equal(g.ok, true);
  require('fs-extra').copySync(path.join(fuente, 'grafo'), path.join(dir, '.agentic', 'grafo'), { overwrite: true, filter: g.filtro });
  assert.equal(fs.readFileSync(path.join(dir, '.agentic', 'grafo', 'mio.cjs'), 'utf8'), 'MIO');
  assert.equal(fs.readFileSync(path.join(dir, '.agentic', 'grafo', 'otro.cjs'), 'utf8'), 'NUEVO');
  assert.deepEqual(g.omitidos, ['.agentic/grafo/mio.cjs']);

  fs.writeFileSync(path.join(dir, '.agentic', 'protected_files'), 'C:\\absoluto\n');
  assert.equal(guardiaProtegidos(dir, null).ok, false);
});

test('H23: desbloqueo humano, por archivo, por acción y con vencimiento', () => {
  const dir = proyecto('src/pagos/cobro.js\n');
  assert.equal(pf.desbloquear(dir, { file: 'src/pagos/cobro.js', accion: 'write', minutos: 10 }, {}).reason_code, 'HUMAN_REQUIRED');
  assert.equal(pf.desbloquear(dir, { file: '.agentic/protected_files', accion: 'write', minutos: 10 }, { interactivo: true }).reason_code, 'NOT_UNLOCKABLE');
  const t0 = Date.parse('2026-10-02T10:00:00Z');
  assert.equal(pf.desbloquear(dir, { file: 'src/pagos/cobro.js', accion: 'write', minutos: 10 }, { interactivo: true, ahora: t0 }).ok, true);
  assert.equal(pf.verificar(dir, ['src/pagos/cobro.js'], { accion: 'write', ahora: t0 + 60000 }).status, 'PASS');
  assert.equal(pf.verificar(dir, ['src/pagos/cobro.js'], { accion: 'update', ahora: t0 + 60000 }).status, 'FAIL', 'otra acción sigue bloqueada');
  assert.equal(pf.verificar(dir, ['src/pagos/cobro.js'], { accion: 'write', ahora: t0 + 11 * 60000 }).status, 'FAIL', 'vencido');
});

test('H23: el CLI no desbloquea sin terminal y check sale con 1', () => {
  const dir = proyecto('src/pagos/\n');
  const cli = path.join(GRAFO, 'protected-files.cjs');
  const u = spawnSync(process.execPath, [cli, 'unlock', '--file=src/pagos/cobro.js', '--accion=write', '--minutos=5'], { cwd: dir, encoding: 'utf8' });
  assert.equal(u.status, 1);
  assert.match(u.stdout, /HUMAN_REQUIRED/);
  const c = spawnSync(process.execPath, [cli, 'check', 'src/pagos/cobro.js'], { cwd: dir, encoding: 'utf8' });
  assert.equal(c.status, 1);
});
