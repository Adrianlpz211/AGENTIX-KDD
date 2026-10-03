'use strict';

/**
 * H17–H22: hooks de git sobre repos reales en carpetas temporales.
 * El contenido revisado es el del ÍNDICE; los nombres raros son datos; los
 * bloqueos llegan al exit code; el canario usa el mensaje de ESTE commit; el
 * post-commit encola por SHA; el instalador respeta hooksPath y hooks ajenos.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const GRAFO = path.join(__dirname, '..', '.agentic', 'grafo');
const RUNNER = path.join(GRAFO, 'hook-runner.cjs');
const runner = require(RUNNER);
const { installHooks, statusHooks } = require(path.join(GRAFO, 'install-hooks.cjs'));

const SECRETO = 'const k = "' + 'AKIA' + 'Z7Q2M4N8P1R5T3W6' + '";\n';

function env() {
  const e = Object.assign({}, process.env, {
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.invalid',
    AKDD_HOOK_NO_WORKER: '1',
  });
  delete e.AKDD_SKIP_GATES;
  delete e.NODE_TEST_CONTEXT;
  return e;
}

function git(cwd, args) {
  return spawnSync('git', args, { cwd, env: env(), encoding: 'utf8' });
}

function repo({ hooks = true } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-hooks-')));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  fs.mkdirSync(path.join(dir, '.agentic', 'grafo'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.agentic', 'grafo', 'hook-runner.cjs'),
    `const r = require(${JSON.stringify(RUNNER)});\nif (require.main === module) process.exit(r.main(process.argv.slice(2)));\n`);
  fs.writeFileSync(path.join(dir, '.gitignore'), '.agentic/\n');
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'init']);
  if (hooks) installHooks({ root: dir, quiet: true });
  return dir;
}

const escribir = (dir, rel, txt) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), txt); };
const commit = (dir, msg) => git(dir, ['commit', '-q', '-m', msg]);

test('H17: el gate revisa el ÍNDICE — secreto staged con worktree limpio bloquea', () => {
  const dir = repo();
  escribir(dir, 'src/a.js', SECRETO);
  git(dir, ['add', 'src/a.js']);
  escribir(dir, 'src/a.js', 'const k = 1;\n');
  const r = commit(dir, 'feat: a');
  assert.notEqual(r.status, 0, 'el commit debía bloquearse');
  assert.match(r.stdout + r.stderr, /BLOQUEADO/);
});

test('H17: secreto solo en el worktree (índice limpio) no bloquea', () => {
  const dir = repo();
  escribir(dir, 'src/a.js', 'const k = 1;\n');
  escribir(dir, 'test/a.test.js', "test('a', () => {});\n");
  git(dir, ['add', '-A']);
  escribir(dir, 'src/a.js', SECRETO);
  const r = commit(dir, 'feat: a');
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('H18: archivo 25 con espacios, Unicode y $() — se revisa y su nombre no se ejecuta', () => {
  const dir = repo();
  for (let i = 0; i < 24; i++) escribir(dir, `src/f${i}.js`, `module.exports = ${i};\n`);
  const raro = 'src/ñandú $(touch PWNED) & x.js';
  escribir(dir, raro, SECRETO);
  git(dir, ['add', '-A']);
  const r = commit(dir, 'feat: muchos');
  assert.notEqual(r.status, 0);
  assert.equal(fs.existsSync(path.join(dir, 'PWNED')), false);
  assert.equal(fs.existsSync(path.join(dir, 'src', 'PWNED')), false);
  const ev = JSON.parse(fs.readFileSync(path.join(dir, '.agentic', '_hooks', 'pre-commit.json'), 'utf8'));
  assert.ok(ev.files.some((f) => f.path === raro), 'el nombre se preserva como dato');
  assert.match(ev.tree, /^[0-9a-f]{40}$/);
});

test('H18: presupuesto agotado sobre código = INCOMPLETE y bloquea', () => {
  const dir = repo({ hooks: false });
  escribir(dir, 'src/grande.js', 'x'.repeat(2048));
  git(dir, ['add', '-A']);
  const antes = runner.POLITICA.max_bytes_archivo;
  runner.POLITICA.max_bytes_archivo = 1024;
  try {
    const r = runner.preCommit(dir, { sinAvisos: true });
    assert.equal(r.gates.security.status, 'INCOMPLETE');
    assert.equal(r.bloquea, true);
  } finally { runner.POLITICA.max_bytes_archivo = antes; }
});

test('H17: merge sin resolver = MERGE_CONFLICT visible', () => {
  const dir = repo({ hooks: false });
  escribir(dir, 'a.txt', 'base\n'); git(dir, ['add', '-A']); commit(dir, 'base');
  git(dir, ['checkout', '-q', '-b', 'otra']);
  escribir(dir, 'a.txt', 'otra\n'); git(dir, ['commit', '-qam', 'otra']);
  git(dir, ['checkout', '-q', 'main']);
  escribir(dir, 'a.txt', 'main\n'); git(dir, ['commit', '-qam', 'main']);
  git(dir, ['merge', 'otra']);
  const r = runner.preCommit(dir, { sinAvisos: true });
  assert.equal(r.gates.merge.reason_code, 'MERGE_CONFLICT');
  assert.equal(r.bloquea, true);
});

function protegerTest(dir, rel) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(dir, '.agentic', 'memoria.db'));
  db.exec(`CREATE TABLE nodos (titulo TEXT, tipo TEXT, area TEXT, archivos_aplica TEXT, confianza TEXT, estado TEXT)`);
  db.prepare(`INSERT INTO nodos VALUES ('regla', 'patron', 'x', ?, 'ALTA', 'ACTIVO')`).run(JSON.stringify([rel]));
  db.close();
}

test('H19: quitar un caso de un test protegido bloquea el commit', () => {
  const dir = repo();
  escribir(dir, 'test/p.test.js', "test('uno', () => {});\ntest('dos', () => {});\n");
  git(dir, ['add', '-A']); assert.equal(commit(dir, 'test: p').status, 0);
  protegerTest(dir, 'test/p.test.js');
  escribir(dir, 'test/p.test.js', "test('uno', () => {});\n");
  git(dir, ['add', '-A']);
  const r = commit(dir, 'test: quita dos');
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stdout + r.stderr, /test_integrity/);
});

test('H19: borrar entero un test protegido también bloquea; uno sin proteger solo avisa', () => {
  const dir = repo();
  escribir(dir, 'test/p.test.js', "test('uno', () => {});\n");
  escribir(dir, 'test/libre.test.js', "test('a', () => {});\ntest('b', () => {});\n");
  git(dir, ['add', '-A']); assert.equal(commit(dir, 'test: base').status, 0);
  protegerTest(dir, 'test/p.test.js');
  escribir(dir, 'test/libre.test.js', "test('a', () => {});\n");
  git(dir, ['add', '-A']);
  assert.equal(commit(dir, 'test: libre').status, 0, 'sin protección es WARN');
  git(dir, ['rm', '-q', 'test/p.test.js']);
  assert.notEqual(commit(dir, 'chore: borra').status, 0);
});

test('H20: el canario usa el mensaje de ESTE commit, no el COMMIT_EDITMSG viejo', () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, '.git', 'COMMIT_EDITMSG'), 'fix: el commit anterior\n');
  escribir(dir, 'src/b.js', 'module.exports = 2;\n');
  git(dir, ['add', '-A']);
  assert.equal(commit(dir, 'feat: nuevo').status, 0, 'feat sin test es WARN');
  escribir(dir, 'src/c.js', 'module.exports = 3;\n');
  git(dir, ['add', '-A']);
  const r = commit(dir, 'fix: arregla c');
  assert.notEqual(r.status, 0, 'un arreglo sin test se frena');
  assert.match(r.stdout + r.stderr, /canario/);
});

test('H21: tres commits seguidos quedan encolados por SHA y se procesan una vez cada uno', () => {
  const dir = repo();
  const shas = [];
  for (let i = 0; i < 3; i++) {
    escribir(dir, `docs/n${i}.md`, `${i}\n`);
    git(dir, ['add', '-A']);
    assert.equal(commit(dir, `docs: ${i}`).status, 0);
    shas.push(git(dir, ['rev-parse', 'HEAD']).stdout.trim());
  }
  const cola = fs.readdirSync(path.join(dir, '.agentic', '_hooks', 'queue'));
  assert.equal(cola.length, 3);
  const item = JSON.parse(fs.readFileSync(path.join(dir, '.agentic', '_hooks', 'queue', shas[2] + '.json'), 'utf8'));
  assert.equal(item.parent, shas[1]);
  assert.match(item.tree, /^[0-9a-f]{40}$/);

  const vistos = [];
  const r = runner.drenar(dir, { ejecutar: (_root, it) => { vistos.push(it.sha); return { status: 'PASS' }; } });
  assert.deepEqual(vistos, shas, 'cada commit, en orden, sobre su propio SHA');
  assert.equal(r.processed.length, 3);
  assert.equal(runner.encolar(dir, shas[0]).duplicate, true, 'dedup por SHA ya hecho');
  assert.equal(runner.drenar(dir, { ejecutar: () => { throw new Error('no debía correr'); } }).processed.length, 0);
});

test('H21: un crash antes del ACK deja el commit en la cola y se recupera', () => {
  const dir = repo();
  escribir(dir, 'docs/x.md', 'x\n'); git(dir, ['add', '-A']); commit(dir, 'docs: x');
  const sha = git(dir, ['rev-parse', 'HEAD']).stdout.trim();
  assert.throws(() => runner.drenar(dir, { ejecutar: () => ({ status: 'PASS' }), crashAntesDeAck: true }));
  assert.ok(fs.existsSync(path.join(dir, '.agentic', '_hooks', 'queue', sha + '.json')));
  assert.equal(fs.existsSync(path.join(dir, '.agentic', '_hooks', 'drain.lock')), false, 'el lock se libera aunque falle');
  const r = runner.drenar(dir, { ejecutar: () => ({ status: 'PASS' }) });
  assert.equal(r.processed.length, 1);
  assert.ok(fs.existsSync(path.join(dir, '.agentic', '_hooks', 'done', sha + '.json')));
});

test('H22: respeta core.hooksPath, no pisa hooks ajenos y compone solo si se pide', () => {
  const dir = repo({ hooks: false });
  git(dir, ['config', 'core.hooksPath', 'mis-hooks']);
  const ajeno = '#!/bin/sh\necho ajeno\n';
  escribir(dir, 'mis-hooks/pre-commit', ajeno);

  const r1 = installHooks({ root: dir, quiet: true });
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, 'conflict');
  assert.equal(path.resolve(r1.hooksDir), path.join(dir, 'mis-hooks'));
  assert.equal(fs.readFileSync(path.join(dir, 'mis-hooks', 'pre-commit'), 'utf8'), ajeno, 'el ajeno sigue intacto');
  assert.equal(statusHooks({ root: dir }).status, 'conflict');

  const r2 = installHooks({ root: dir, quiet: true, compose: true });
  assert.equal(r2.ok, true);
  assert.equal(fs.readFileSync(path.join(dir, 'mis-hooks', 'pre-commit.agentix-backup'), 'utf8'), ajeno);
  assert.equal(statusHooks({ root: dir }).status, 'enabled');
  assert.ok(installHooks({ root: dir, quiet: true }).results.every((x) => x.action === 'unchanged'), 'idempotente');

  installHooks({ root: dir, quiet: true, uninstall: true });
  assert.equal(fs.readFileSync(path.join(dir, 'mis-hooks', 'pre-commit'), 'utf8'), ajeno, 'desinstalar devuelve el ajeno');
  assert.equal(fs.existsSync(path.join(dir, 'mis-hooks', 'post-commit')), false);
});

test('H22: en un worktree se instala donde git ejecuta los hooks', () => {
  const dir = repo({ hooks: false });
  const wt = path.join(path.dirname(dir), path.basename(dir) + '-wt');
  assert.equal(git(dir, ['worktree', 'add', '-q', wt, '-b', 'wt']).status, 0);
  const r = installHooks({ root: wt, quiet: true });
  assert.equal(r.ok, true);
  const esperado = path.resolve(wt, git(wt, ['rev-parse', '--git-path', 'hooks']).stdout.trim());
  assert.equal(path.resolve(r.hooksDir), esperado);
  assert.ok(fs.existsSync(path.join(esperado, 'pre-commit')));
  assert.equal(statusHooks({ root: dir }).status, 'enabled', 'el repo principal comparte los hooks');
});
