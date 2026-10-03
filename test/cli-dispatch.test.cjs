'use strict';

/** H34: dispatch único y argv sin shell en el CLI. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RAIZ = path.join(__dirname, '..');
const CLI = path.join(RAIZ, 'bin', 'akdd.js');

function proyecto() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-cli-'));
  const grafo = path.join(dir, '.agentic', 'grafo');
  fs.mkdirSync(grafo, { recursive: true });
  const eco = "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n";
  for (const m of ['decision-trail.cjs', 'akdd-analyze.cjs', 'autonomous-decision.cjs', 'lock-manager.cjs', 'grafo.cjs']) fs.writeFileSync(path.join(grafo, m), eco);
  return dir;
}

const akdd = (cwd, args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });

test('H34: un solo case analyze, y va al análisis cruzado con subcomando válido', () => {
  const src = fs.readFileSync(CLI, 'utf8');
  assert.equal((src.match(/case 'analyze'/g) || []).length, 1);
  const dir = proyecto();
  const r = akdd(dir, ['analyze']);
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), ['run']);
  const malo = akdd(dir, ['analyze', 'rm -rf']);
  assert.equal(malo.status, 1);
  assert.equal(malo.stdout, '');
});

test('H34: espacios, comillas, backticks y $() llegan como dato y no se ejecutan', () => {
  const dir = proyecto();
  const payload = 'a b "c" `touch PWNED1` $(touch PWNED2) ; touch PWNED3 & echo x > PWNED4 | %PATH%';
  const r = akdd(dir, ['why', payload]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), ['why', payload], 'stdout es JSON limpio con el argumento intacto');
  for (const n of ['PWNED1', 'PWNED2', 'PWNED3', 'PWNED4']) assert.equal(fs.existsSync(path.join(dir, n)), false, n);
  const d = akdd(dir, ['decide', 'src/mi archivo.js', 'o"tro.js']);
  assert.deepEqual(JSON.parse(d.stdout), ['analyze', 'src/mi archivo.js', 'o"tro.js']);
});

test('H34: locks recibe su subcomando, no el nombre del comando', () => {
  const dir = proyecto();
  assert.deepEqual(JSON.parse(akdd(dir, ['locks']).stdout), ['status']);
  assert.deepEqual(JSON.parse(akdd(dir, ['locks', 'check', '--files=a b.js']).stdout), ['check', '--files=a b.js']);
});

test('H34: comando desconocido = exit 1, stdout vacío y sin efectos', () => {
  const dir = proyecto();
  const antes = fs.readdirSync(dir).sort();
  const r = akdd(dir, ['no-existe', '$(touch X)']);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /Unknown command/);
  assert.deepEqual(fs.readdirSync(dir).sort(), antes);
  assert.equal(akdd(dir, ['--version']).stdout.trim(), require(path.join(RAIZ, 'package.json')).version);
});

test('H34: el adaptador rechaza en cmd.exe lo que cmd.exe reinterpretaría', () => {
  const rs = require(path.join(RAIZ, 'src', 'run-safe.js'));
  const eco = path.join(proyecto(), '.agentic', 'grafo', 'grafo.cjs');
  assert.deepEqual(JSON.parse(rs.nodo(eco, ['x "y" $(z)']).toString()), ['x "y" $(z)']);
  if (process.platform === 'win32') {
    assert.throws(() => rs.herramienta('npm', ['--version', '"&calc"']), (e) => e.code === 'UNSAFE_ARG');
    assert.throws(() => rs.herramienta('npm', ['%PATH%']), (e) => e.code === 'UNSAFE_ARG');
  }
});
