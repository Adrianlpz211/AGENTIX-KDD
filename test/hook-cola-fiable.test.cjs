'use strict';
/* La cola de commits del hook ya no da por «hecho» lo que no se registró (caso medinet: de 4 commits, uno con «PASS» y otro con
   «ERROR» quedaron archivados en done/ sin ciclo en la base, y nunca se reintentaron).
   - un fallo / update en curso / timeout NO se archiva: vuelve a la cola con su contador y su espera, y al agotarse queda
     ABANDONADA con el motivo (visible en `hook-runner.cjs estado`);
   - un «éxito» se COMPRUEBA en la base: salir con 0 sin dejar el ciclo es CICLO_NO_REGISTRADO y se reintenta;
   - la tarea del ciclo es el asunto del commit, no «auto post-commit abc1234»;
   - el área se deduce de la raíz de código real (Next.js: app/, lib/…), y un merge se compara con su primer padre;
   - un --amend con el mismo árbol no vuelve a correr post-cycle. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { proyecto, REPO } = require('./helpers/memoria-proyecto.cjs');
const { disponible, motivoSinDriver, abrir } = require('./helpers/sqlite.cjs');
const runner = require('../.agentic/grafo/hook-runner.cjs');

const git = (cwd, ...a) => { const r = spawnSync('git', ['-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...a], { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error('git ' + a.join(' ') + ': ' + r.stderr); return r.stdout.trim(); };
function repo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-cola-')));
  git(root, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(root, '.agentic'), { recursive: true });
  fs.writeFileSync(path.join(root, '.gitignore'), '.agentic/\n');
  return root;
}
const commit = (root, archivos, msg) => { for (const [f, c] of Object.entries(archivos)) { const p = path.join(root, f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); } git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', msg); return git(root, 'rev-parse', 'HEAD'); };
const leerHecho = (root, sha) => JSON.parse(fs.readFileSync(path.join(root, '.agentic', '_hooks', 'done', sha + '.json'), 'utf8'));
const enCola = (root, sha) => fs.existsSync(path.join(root, '.agentic', '_hooks', 'queue', sha + '.json'));

test('un fallo NO se archiva: vuelve a la cola con intentos y espera; al agotarse queda ABANDONADA con su motivo', () => {
  const root = repo(); const sha = commit(root, { 'src/a/x.ts': 'a' }, 'feat: a');
  runner.encolar(root, sha);
  const opts = { ejecutar: () => ({ status: 'ERROR', exit: 1 }), noEsperar: true, unaPasada: true, backoffMs: 0, maxIntentos: 3 };
  let r = runner.drenar(root, opts);
  assert.ok(enCola(root, sha), 'tras el 1.er fallo sigue en la cola');
  assert.ok(!fs.existsSync(path.join(root, '.agentic', '_hooks', 'done', sha + '.json')), 'y NO está archivada como hecha');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.agentic', '_hooks', 'queue', sha + '.json'), 'utf8')).intentos, 1);
  assert.equal(r.processed[0].result.reintento, 1);
  runner.drenar(root, opts);
  r = runner.drenar(root, opts); // 3.er intento = el máximo
  assert.ok(!enCola(root, sha), 'agotados los intentos sale de la cola');
  const h = leerHecho(root, sha);
  assert.equal(h.result.status, 'ABANDONADA', 'archivada como ABANDONADA, no como PASS');
  assert.equal(h.intentos, 3);
  assert.ok(h.result.ultimo_motivo, 'con el motivo');
  assert.equal(runner.estadoCola(root).abandonados.length, 1, 'el diagnóstico la muestra');
});

test('con espera pendiente el worker no gira en vacío ni la archiva: un reintento futuro se respeta', () => {
  const root = repo(); const sha = commit(root, { 'src/a/x.ts': 'a' }, 'feat: a');
  runner.encolar(root, sha);
  let llamadas = 0;
  runner.drenar(root, { ejecutar: () => { llamadas++; return { status: 'RETRY', reason_code: 'UPDATE_EN_CURSO' }; }, noEsperar: true, unaPasada: true, backoffMs: 600000 });
  assert.equal(llamadas, 1);
  const r2 = runner.drenar(root, { ejecutar: () => { llamadas++; return { status: 'PASS' }; }, noEsperar: true, unaPasada: true });
  assert.equal(llamadas, 1, 'aún no toca: no se vuelve a ejecutar antes de su hora');
  assert.equal(r2.processed.length, 0);
  assert.ok(enCola(root, sha));
});

test('un reintento que sale bien se archiva como hecho (PASS)', () => {
  const root = repo(); const sha = commit(root, { 'src/a/x.ts': 'a' }, 'feat: a');
  runner.encolar(root, sha);
  runner.drenar(root, { ejecutar: () => ({ status: 'ERROR' }), noEsperar: true, unaPasada: true, backoffMs: 0 });
  runner.drenar(root, { ejecutar: () => ({ status: 'PASS', verificado: true }), noEsperar: true });
  assert.ok(!enCola(root, sha));
  assert.equal(leerHecho(root, sha).result.status, 'PASS');
});

test('el éxito se COMPRUEBA en la base: post-cycle que sale con 0 sin dejar el ciclo es CICLO_NO_REGISTRADO y se reintenta', (t) => {
  if (!disponible()) return t.skip('HOST_REAL_NO_EJECUTADO: ' + motivoSinDriver());
  const p = proyecto('cola-verifica'); const root = p.root;
  git(root, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(root, '.gitignore'), '.agentic/\n');
  const sha = commit(root, { 'src/a/x.ts': 'a' }, 'feat: algo de verdad');
  fs.mkdirSync(path.join(root, '.agentic', 'grafo'), { recursive: true });
  const script = path.join(root, '.agentic', 'grafo', 'post-cycle.cjs');
  runner.encolar(root, sha);

  fs.writeFileSync(script, 'process.exit(0);\n'); // sale «bien» sin escribir nada (omitido)
  let r = runner.drenar(root, { noEsperar: true, unaPasada: true, backoffMs: 0 });
  assert.equal(r.processed[0].result.status, 'RETRY');
  assert.equal(r.processed[0].result.reason_code, 'CICLO_NO_REGISTRADO');
  assert.ok(enCola(root, sha), 'sigue en la cola');

  fs.writeFileSync(script, 'process.exit(75);\n'); // update en curso
  r = runner.drenar(root, { noEsperar: true, unaPasada: true, backoffMs: 0 });
  assert.equal(r.processed[0].result.reason_code, 'UPDATE_EN_CURSO');

  // Ahora sí deja el ciclo, cerrado, y la tarea es el ASUNTO del commit.
  fs.writeFileSync(script, `const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(${JSON.stringify(p.dbPath)}, { timeout: 5000 });
    d.prepare("INSERT INTO ciclos (ciclo_id, tarea, estado, fecha_inicio) VALUES (?, ?, 'COMPLETADO', datetime('now'))").run(process.env.AKDD_CYCLE_ID, process.argv.find((a) => a.startsWith('--task=')).slice(7)); d.close();`);
  r = runner.drenar(root, { noEsperar: true, unaPasada: true });
  assert.equal(r.processed[0].result.status, 'PASS');
  assert.equal(r.processed[0].result.verificado, true, 'comprobado en la base, no solo «salió con 0»');
  const db = abrir(p.dbPath); const f = db.prepare('SELECT tarea FROM ciclos WHERE ciclo_id = ?').get('commit-' + sha); try { db.close(); } catch { /* */ }
  assert.match(f.tarea, /^auto post-commit [0-9a-f]{7} — feat: algo de verdad$/, 'la tarea lleva el asunto del commit: ' + f.tarea);
});

test('un commit con el MISMO árbol (--amend sin cambios) no vuelve a correr post-cycle', () => {
  const root = repo(); const sha = commit(root, { 'src/a/x.ts': 'a' }, 'feat: a');
  runner.encolar(root, sha);
  runner.drenar(root, { ejecutar: () => ({ status: 'PASS', verificado: true }), noEsperar: true });
  git(root, 'commit', '-q', '--amend', '--allow-empty', '-m', 'feat: a (reescrito)');
  const nuevo = git(root, 'rev-parse', 'HEAD');
  assert.notEqual(nuevo, sha);
  const r = runner.encolar(root, nuevo);
  assert.equal(r.dup_tree, true, 'se reconoce el árbol ya registrado');
  assert.equal(leerHecho(root, nuevo).result.status, 'DUP_TREE');
  assert.ok(!enCola(root, nuevo), 'no entra a la cola');
  // pero un PASS NO comprobado no cuenta como registrado
  const b = commit(root, { 'src/b/y.ts': 'b' }, 'feat: b'); runner.encolar(root, b);
  runner.drenar(root, { ejecutar: () => ({ status: 'PASS', verificado: false }), noEsperar: true });
  git(root, 'commit', '-q', '--amend', '--allow-empty', '-m', 'feat: b2');
  assert.ok(!runner.encolar(root, git(root, 'rev-parse', 'HEAD')).dup_tree, 'un PASS sin comprobar no sirve de excusa para saltarse el registro');
});

test('área: raíz de código real (Next.js) y asunto del commit; un merge se compara con su primer padre', () => {
  const root = repo();
  const c1 = commit(root, { 'app/citas/page.tsx': '1', 'app/citas/form.tsx': '2', 'lib/util.ts': '3' }, 'feat(citas): pantalla');
  assert.equal(runner.areaDe(root, c1).area, 'citas', 'la carpeta más tocada bajo app/');
  assert.equal(runner.asuntoDe(root, c1), 'feat(citas): pantalla');
  const c2 = commit(root, { 'lib/solo.ts': 'x' }, 'chore: lib');
  assert.equal(runner.areaDe(root, c2).area, 'lib', 'un archivo suelto en la raíz toma el nombre de la raíz');
  const c3 = commit(root, { 'README.md': 'x' }, 'docs');
  assert.equal(runner.areaDe(root, c3).area, 'general', 'sin código: general');

  git(root, 'checkout', '-q', '-b', 'rama'); const cr = commit(root, { 'app/pagos/a.tsx': 'p' }, 'feat: pagos');
  git(root, 'checkout', '-q', 'main'); commit(root, { 'app/otro/b.tsx': 'o' }, 'feat: otro');
  git(root, 'merge', '-q', '--no-ff', 'rama', '-m', 'merge rama');
  const m = runner.areaDe(root, git(root, 'rev-parse', 'HEAD'));
  assert.equal(m.esMerge, true);
  assert.ok(m.files.some((f) => f.includes('pagos')), 'un merge ya no sale con 0 archivos: ' + JSON.stringify(m.files));
  void cr;
});

test('hook-runner estado: informa lo pendiente, lo abandonado y lo no comprobado', () => {
  const root = repo(); const a = commit(root, { 'src/a/x.ts': 'a' }, 'a'); const b = commit(root, { 'src/b/y.ts': 'b' }, 'b');
  runner.encolar(root, a); runner.encolar(root, b);
  runner.drenar(root, { ejecutar: (_r, it) => (it.sha === a ? { status: 'PASS', verificado: false } : { status: 'RETRY', reason_code: 'POST_CYCLE_TIMEOUT' }), noEsperar: true, unaPasada: true, backoffMs: 60000 });
  const e = runner.estadoCola(root);
  assert.equal(e.pendientes, 1); assert.equal(e.hechos, 1); assert.equal(e.sinComprobar, 1);
  assert.equal(e.enEspera[0].motivo, 'POST_CYCLE_TIMEOUT');
  void REPO;
});
