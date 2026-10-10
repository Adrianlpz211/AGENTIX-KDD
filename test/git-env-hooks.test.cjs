'use strict';
/* Regresión 10/10/2026: la suite corrió dentro de un hook de commit, heredó GIT_DIR/GIT_INDEX_FILE del repo REAL y sus `git init`
   + `git config user.name prueba` + `git commit` terminaron escribiendo ahí (core.bare=true, identidad «prueba», ramas y commits
   de prueba en main, índice destrozado). Aquí se comprueba que ningún proceso de pruebas que lance Agentix hereda esas variables. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const REPO = path.resolve(__dirname, '..');
const { entornoSinGit, VARIABLES_DE_GIT } = require(path.join(REPO, '.agentic', 'grafo', 'git-env.cjs'));
const tdd = require(path.join(REPO, '.agentic', 'grafo', 'tdd-gate.cjs'));

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), n + '-'));
// Un git que NO hereda nada del proceso que corre esta prueba (por si ella misma corre dentro de un hook).
const gitLimpio = (cwd, ...a) => cp.execFileSync('git', a, { cwd, encoding: 'utf8', env: entornoSinGit(process.env), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

test('GE-1 entornoSinGit quita todas las variables que apuntan a un repo y respeta el resto', () => {
  const sucio = { PATH: '/bin', HOME: '/h', GIT_TERMINAL_PROMPT: '0' };
  for (const k of VARIABLES_DE_GIT) sucio[k] = '/repo/real';
  const limpio = entornoSinGit(sucio);
  for (const k of VARIABLES_DE_GIT) assert.ok(!(k in limpio), k + ' debe salir');
  assert.equal(limpio.PATH, '/bin');
  assert.equal(limpio.GIT_TERMINAL_PROMPT, '0', 'las que no apuntan a un repo se conservan');
  assert.ok('GIT_DIR' in sucio, 'no muta el original');
});

test('GE-2 tdd-gate.runTests no le pasa GIT_DIR al comando de pruebas aunque el proceso lo tenga', () => {
  const victima = tmp('ge-victima');
  gitLimpio(victima, 'init', '-q');
  const proyecto = tmp('ge-proyecto');
  fs.writeFileSync(path.join(proyecto, 'sonda.cjs'),
    "require('fs').writeFileSync('salida.txt', ['GIT_DIR=' + (process.env.GIT_DIR || 'ausente'), 'GIT_INDEX_FILE=' + (process.env.GIT_INDEX_FILE || 'ausente'), 'GIT_WORK_TREE=' + (process.env.GIT_WORK_TREE || 'ausente')].join('\\n'));\n");
  const antes = { d: process.env.GIT_DIR, i: process.env.GIT_INDEX_FILE, w: process.env.GIT_WORK_TREE };
  process.env.GIT_DIR = path.join(victima, '.git');
  process.env.GIT_INDEX_FILE = path.join(victima, '.git', 'index');
  process.env.GIT_WORK_TREE = victima;
  try {
    tdd.runTests('node sonda.cjs', proyecto);
  } finally {
    for (const [k, v] of [['GIT_DIR', antes.d], ['GIT_INDEX_FILE', antes.i], ['GIT_WORK_TREE', antes.w]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  const salida = fs.readFileSync(path.join(proyecto, 'salida.txt'), 'utf8');
  assert.match(salida, /GIT_DIR=ausente/);
  assert.match(salida, /GIT_INDEX_FILE=ausente/);
  assert.match(salida, /GIT_WORK_TREE=ausente/);
});

test('GE-3 un `git init` + `git config` hecho por las pruebas NO toca el repo de afuera aunque el proceso tenga GIT_DIR', () => {
  const victima = tmp('ge-victima2');
  gitLimpio(victima, 'init', '-q');
  gitLimpio(victima, 'config', 'user.name', 'dueño-real');
  const proyecto = tmp('ge-proyecto2');
  fs.writeFileSync(path.join(proyecto, 'ensucia.cjs'), [
    "const cp = require('child_process'); const fs = require('fs'); const os = require('os'); const path = require('path');",
    "const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ge-fixture-'));",
    "const g = (...a) => cp.execFileSync('git', a, { cwd: d, encoding: 'utf8', env: process.env });",
    "g('init', '-q'); g('config', 'user.name', 'prueba'); g('config', 'user.email', 'prueba@local');",
    "fs.writeFileSync(path.join(d, 'a.txt'), 'x'); g('add', '-A'); g('commit', '-q', '-m', 'fixture');",
  ].join('\n') + '\n');
  const antes = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(victima, '.git');
  try {
    tdd.runTests('node ensucia.cjs', proyecto);
  } finally {
    if (antes === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = antes;
  }
  assert.equal(gitLimpio(victima, 'config', 'user.name').trim(), 'dueño-real', 'la identidad del repo de afuera sigue intacta');
  const cfg = fs.readFileSync(path.join(victima, '.git', 'config'), 'utf8');
  assert.ok(!/prueba/.test(cfg), 'ninguna escritura de la fixture llegó al repo de afuera');
  assert.ok(!/bare\s*=\s*true/.test(cfg), 'el repo de afuera no quedó bare');
  assert.throws(() => gitLimpio(victima, 'rev-parse', '--verify', 'HEAD'), 'el repo de afuera no recibió el commit de la fixture');
});

test('GE-4 el ejecutor de la suite (scripts/run-tests.cjs) limpia el entorno antes de lanzar las pruebas', () => {
  const src = fs.readFileSync(path.join(REPO, 'scripts', 'run-tests.cjs'), 'utf8');
  assert.match(src, /require\('\.\.\/\.agentic\/grafo\/git-env\.cjs'\)/);
  assert.match(src, /\.\.\.entornoSinGit\(process\.env\)/, 'el env del hijo sale de entornoSinGit');
});
