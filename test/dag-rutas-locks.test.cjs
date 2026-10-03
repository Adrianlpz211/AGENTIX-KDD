'use strict';

// H06 · H07 · H08 — el orden de las tareas, el alcance de los archivos y quién
// tiene un lock se deciden con reglas exactas, no con coincidencias parciales.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const GRAFO = path.join(__dirname, '..', '.agentic', 'grafo');
const spec = require(path.join(GRAFO, 'spec-manager.cjs'));
const sprint = require(path.join(GRAFO, 'sprint-state.cjs'));
const harness = require(path.join(GRAFO, 'harness.cjs'));
const pn = require(path.join(GRAFO, 'path-norm.cjs'));
const pc = require(path.join(GRAFO, 'pipeline-controller.cjs'));

delete process.env.NODE_TEST_CONTEXT;

const temporal = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p || 'akdd-h-'));

// ── H06 ─────────────────────────────────────────────────────────────────────

const tareas = (bloques) => bloques.map(([n, deps, estado]) =>
  `## Tarea ${n}: paso ${n}\n- Estado: ${estado || 'PENDIENTE'}\n- Dependencias: ${deps}\n`).join('\n');

test('H06: "Tarea 2" como dependencia respeta el orden', () => {
  const t = spec.parseTasks(tareas([[1, 'Tarea 2'], [2, 'Ninguna'], [3, 'T1, #2']]));
  assert.deepEqual(t.map((x) => x.dep_ids), [[2], [], [1, 2]]);
  const { waves, errors } = spec.buildWaves(t);
  assert.deepEqual(errors, []);
  assert.deepEqual(waves.map((w) => w.map((x) => x.id)), [[2], [1], [3]]);
});

test('H06: dependencia desconocida no desaparece y su tarea no se ejecuta', () => {
  const t = spec.parseTasks(tareas([[1, 'Tarea 9'], [2, '—'], [3, 'Tarea 1']]));
  assert.deepEqual(t[0].missing_deps, ['Tarea 9']);
  const { waves, blocked, errors } = spec.buildWaves(t);
  assert.ok(errors.some((e) => e.code === 'MISSING_DEPENDENCY' && e.task === 1));
  assert.deepEqual(waves.map((w) => w.map((x) => x.id)), [[2]], 'la rama independiente avanza');
  assert.deepEqual(blocked.map((b) => [b.id, b.reason]), [[1, 'MISSING_DEPENDENCY'], [3, 'BLOCKED_BY_1']]);
});

test('H06: ciclos, autorreferencia y duplicados se rechazan sin ola de emergencia', () => {
  const ciclo = spec.buildWaves(spec.parseTasks(tareas([[1, 'Tarea 2'], [2, 'Tarea 1'], [3, '-'], [4, 'Tarea 4']])));
  assert.deepEqual(ciclo.cycles, [1, 2, 4]);
  assert.deepEqual(ciclo.waves.map((w) => w.map((x) => x.id)), [[3]]);
  assert.ok(ciclo.errors.some((e) => e.code === 'SELF_REFERENCE' && e.task === 4));
  const dup = spec.validarGrafo(spec.parseTasks(tareas([[1, '-'], [1, '-']])));
  assert.ok(dup.some((e) => e.code === 'DUPLICATE_ID'));
});

test('H06: BLOQUEADA no es ejecutable y bloquea a sus descendientes', () => {
  const t = spec.parseTasks(tareas([[1, '-', 'BLOQUEADA'], [2, 'Tarea 1'], [3, '-'], [4, 'Tarea 3']]));
  const { waves, blocked } = spec.buildWaves(t);
  assert.deepEqual(waves.map((w) => w.map((x) => x.id)), [[3], [4]]);
  assert.deepEqual(blocked.map((b) => b.id), [1, 2]);
});

test('H06: sprint con dependencias — un bloqueo frena descendientes, no lo independiente', () => {
  const s = { tareas: [
    { n: 1, titulo: 'a', deps: [], estado: 'ACTIVA' },
    { n: 2, titulo: 'b', deps: [1], estado: 'PENDIENTE' },
    { n: 3, titulo: 'c', deps: [], estado: 'PENDIENTE' },
  ] };
  s.tareas[0].estado = 'BLOQUEADA';
  sprint.activarSiguiente(s);
  assert.deepEqual(s.tareas.map((t) => t.estado), ['BLOQUEADA', 'BLOQUEADA_POR_T1', 'ACTIVA']);
});

test('H06: updateTaskStatus no toca la tarea siguiente si la suya no tiene estado', () => {
  const root = temporal();
  const dir = path.join(root, '.agentic', 'specs', 'm');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'tasks.md');
  fs.writeFileSync(f, '## Tarea 1: sin estado\n- Dependencias: -\n\n## Tarea 2: otra\n- Estado: PENDIENTE\n');
  assert.equal(spec.updateTaskStatus(root, 'm', 1, 'COMPLETADA'), false);
  assert.match(fs.readFileSync(f, 'utf8'), /Tarea 2: otra\n- Estado: PENDIENTE/);
});

// ── H07 ─────────────────────────────────────────────────────────────────────

function proyecto() {
  const root = temporal('akdd-scope-');
  fs.mkdirSync(path.join(root, 'src', 'carpeta con espacios'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'auth.ts'), 'x');
  fs.writeFileSync(path.join(root, 'src', 'auth.ts.bak'), 'x');
  fs.writeFileSync(path.join(root, 'secrets.env'), 'x');
  return root;
}

test('H07: archivo exacto no es prefijo; .. que sale del plan se rechaza', () => {
  const root = proyecto();
  const allow = ['src/auth.ts'];
  assert.equal(harness.checkScopeDeviation(['src/auth.ts'], allow, [], root).ok, true);
  assert.equal(harness.checkScopeDeviation(['src/auth.ts.bak'], allow, [], root).ok, false);
  assert.equal(harness.checkScopeDeviation(['src/../secrets.env'], ['src/'], [], root).ok, false);
  assert.equal(harness.checkScopeDeviation(['../fuera.txt'], [], [], root).ok, false, 'sin allowlist, salir de la raíz sigue prohibido');
  const abs = path.join(os.tmpdir(), 'otro.txt');
  assert.match(harness.checkScopeDeviation([abs], [], [], root).reason, /ESCAPE/);
});

test('H07: espacios, Unicode y mayúsculas válidas funcionan', () => {
  const root = proyecto();
  assert.equal(harness.checkScopeDeviation(['src/carpeta con espacios/ñandú.ts'], ['src/carpeta con espacios/'], [], root).ok, true);
  assert.equal(harness.checkScopeDeviation(['src\\auth.ts'], ['src/auth.ts'], [], root).ok, true);
  if (pn.FS_INSENSIBLE) {
    assert.equal(harness.checkScopeDeviation(['SRC/Auth.ts'], ['src/auth.ts'], [], root).ok, true);
  }
});

test('H07: junction/enlace hacia fuera del proyecto se rechaza', (t) => {
  const root = proyecto();
  const fuera = temporal('akdd-fuera-');
  fs.writeFileSync(path.join(fuera, 'x.txt'), 'x');
  try {
    fs.symlinkSync(fuera, path.join(root, 'src', 'enlace'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (e) {
    t.skip('no se pudo crear el enlace: ' + e.code);
    return;
  }
  const r = harness.checkScopeDeviation(['src/enlace/x.txt'], ['src/'], [], root);
  assert.equal(r.ok, false);
  assert.match(r.reason, /ESCAPE/);
  assert.equal(pn.resolverEnRaiz(root, 'src/enlace/nuevo.txt').ok, false, 'archivo nuevo bajo el enlace también');
});

test('H07: el POST de implementación calcula el alcance en vez de creer al agente', () => {
  const root = proyecto();
  const post = harness.GATE_DEFINITIONS.implementation.post;
  const salida = { files_touched: ['src/auth.ts.bak'], diff_summary: 'x', within_scope: true };
  assert.equal(post(salida, { allowed_files: ['src/auth.ts'], project_root: root }).ok, false);
  assert.equal(post(Object.assign({}, salida, { files_touched: ['src/auth.ts'] }), { allowed_files: ['src/auth.ts'], project_root: root }).ok, true);
});

test('H07: ampliar el alcance queda registrado y no admite escapes', () => {
  const root = proyecto();
  pc.abrir(root, { cycle_id: 'c-scope', task: 't' });
  assert.equal(pc.verificarAntesDeEscribir(root, 'c-scope', '../fuera.txt').ok, false, 'sin plan, salir de la raíz sigue prohibido');
  assert.equal(pc.ampliarAlcance(root, 'c-scope', ['src/auth.ts'], '').reason_code, 'MOTIVO_REQUERIDO');
  assert.equal(pc.ampliarAlcance(root, 'c-scope', ['../x'], 'porque sí').reason_code, 'ESCAPE');
  assert.equal(pc.ampliarAlcance(root, 'c-scope', ['src/auth.ts'], 'pedido del dev').ok, true);
  assert.equal(pc.cargar(root, 'c-scope').scope_extensions[0].motivo, 'pedido del dev');
  assert.equal(pc.verificarAntesDeEscribir(root, 'c-scope', 'src/auth.ts').ok, true);
  assert.equal(pc.verificarAntesDeEscribir(root, 'c-scope', 'src/auth.ts.bak').ok, false);
});

// ── H08 ─────────────────────────────────────────────────────────────────────

const LM = path.join(GRAFO, 'lock-manager.cjs');

function proyectoConBase() {
  const root = temporal('akdd-locks-');
  fs.mkdirSync(path.join(root, '.agentic'));
  const { DatabaseSync } = require('node:sqlite');
  new DatabaseSync(path.join(root, '.agentic', 'memoria.db')).close();
  return root;
}

function lm(root, owner, args, env) {
  return spawnSync(process.execPath, [LM, ...args], {
    cwd: root, encoding: 'utf8',
    env: Object.assign({}, process.env, { AKDD_OWNER_ID: owner }, env || {}),
  });
}

const fencingDe = (r) => Number((r.stdout.match(/fencing: (\d+)/) || [])[1]);

test('H08: dos procesos a la vez — un solo lease', async () => {
  const root = proyectoConBase();
  lm(root, 'setup', ['status']);
  const correr = (owner) => new Promise((res) => {
    const p = spawn(process.execPath, [LM, 'acquire', '--module=auth'], {
      cwd: root, env: Object.assign({}, process.env, { AKDD_OWNER_ID: owner }),
    });
    p.on('exit', (code) => res(code));
  });
  const codigos = await Promise.all(['a', 'b', 'c'].map(correr));
  assert.equal(codigos.filter((c) => c === 0).length, 1, 'exactamente uno obtiene el lock: ' + codigos);
});

test('H08: vence el mismo día; renew/release ajeno falla; fencing viejo no confirma', () => {
  const root = proyectoConBase();
  const t0 = Date.parse('2026-10-02T10:00:00Z');
  const a = lm(root, 'sesion-a', ['acquire', '--module=pagos'], { AKDD_LOCK_NOW_MS: String(t0) });
  assert.equal(a.status, 0, a.stderr);
  const fa = fencingDe(a);

  assert.notEqual(lm(root, 'sesion-b', ['release', '--module=pagos']).status, 0, 'release ajeno');
  assert.notEqual(lm(root, 'sesion-b', ['renew', '--module=pagos'], { AKDD_LOCK_NOW_MS: String(t0) }).status, 0, 'renew ajeno');
  assert.notEqual(lm(root, 'sesion-b', ['acquire', '--module=pagos'], { AKDD_LOCK_NOW_MS: String(t0 + 60e3) }).status, 0, 'vigente: otro no entra');

  const tarde = String(t0 + 31 * 60e3);   // mismo día, 31 min después
  assert.notEqual(lm(root, 'sesion-a', ['renew', '--module=pagos'], { AKDD_LOCK_NOW_MS: tarde }).status, 0, 'vencido no se resucita');
  const b = lm(root, 'sesion-b', ['acquire', '--module=pagos'], { AKDD_LOCK_NOW_MS: tarde });
  assert.equal(b.status, 0, 'el vencido se libera el mismo día: ' + b.stderr);
  assert.ok(fencingDe(b) > fa, 'el takeover recibe un fencing mayor');

  const conf = lm(root, 'sesion-a', ['confirm', '--module=pagos', '--fencing=' + fa], { AKDD_LOCK_NOW_MS: tarde });
  assert.notEqual(conf.status, 0);
  assert.match(conf.stderr, /NOT_OWNER|STALE_FENCING/);
  assert.equal(lm(root, 'sesion-b', ['confirm', '--module=pagos', '--fencing=' + fencingDe(b)], { AKDD_LOCK_NOW_MS: tarde }).status, 0);
});

test('H08: el hijo que hereda el dueño es el mismo dueño; otra sesión no', () => {
  const root = proyectoConBase();
  assert.equal(lm(root, 'sesion-padre', ['acquire', '--module=ui']).status, 0);
  assert.equal(lm(root, 'sesion-padre', ['renew', '--module=ui']).status, 0, 'hijo con AKDD_OWNER_ID heredado');
  const otra = spawnSync(process.execPath, [LM, 'release', '--module=ui'], {
    cwd: root, encoding: 'utf8',
    env: Object.assign({}, process.env, { AKDD_OWNER_ID: '', AKDD_ACTOR: 'otro-agente' }),
  });
  assert.notEqual(otra.status, 0, 'mismo proyecto, otra sesión');
});
