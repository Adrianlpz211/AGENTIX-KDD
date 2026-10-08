'use strict';
/* Registro sin huecos (caso medinet, 07/10/2026). Cada prueba fija un hueco REAL medido en un proyecto con better-sqlite3 instalado:
   - module_registry / spec_registry vacíos: `db.run is not a function` dentro de catch vacíos (el handle crudo de better-sqlite3 no
     trae run/get/all) y episodios duplicados al reintentar el mismo cierre;
   - modules_touched y stack_detected siempre NULL (el INSERT de registrarCiclo no los nombraba);
   - 40 ciclos con idéntica hora de inicio y duración (se les pegaba la tarea abierta de OTRO actor);
   - specs vacíos en proyectos sin carpeta src/ (Next.js: app/, lib/, components/);
   - fallos de registro mudos.
   Se ejecuta el post-cycle REAL sobre un proyecto temporal con una memoria.db real y un better-sqlite3 FALSO que, como el de verdad,
   NO trae run/get/all en el handle. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { proyecto, REPO } = require('./helpers/memoria-proyecto.cjs');
const { abrir, disponible, motivoSinDriver } = require('./helpers/sqlite.cjs');

/** better-sqlite3 de mentira sobre node:sqlite con LA MISMA superficie que el real: prepare/exec/pragma/close, y NADA de run/get/all. */
const BS3_FALSO = `'use strict';
const { DatabaseSync } = require('node:sqlite');
module.exports = class Database {
  constructor(file) { this._db = new DatabaseSync(file, { timeout: 5000 }); this.open = true; }
  prepare(sql) { const st = this._db.prepare(sql); return { run: (...p) => st.run(...p), get: (...p) => st.get(...p), all: (...p) => st.all(...p) }; }
  exec(sql) { this._db.exec(sql); return this; }
  pragma(s, o) {
    const sentencia = /^\\s*\\w+\\s*=/.test(s) ? s : s;
    const filas = this._db.prepare('PRAGMA ' + sentencia).all();
    if (o && o.simple) { const f = filas[0]; return f ? Object.values(f)[0] : undefined; }
    return filas;
  }
  close() { this._db.close(); this.open = false; }
};
`;

function copiarGrafo(destino) {
  const origen = path.join(REPO, '.agentic', 'grafo');
  fs.cpSync(origen, destino, { recursive: true, filter: (s) => !/[\\/](vendor|node_modules)([\\/]|$)/.test(s) && !/\.log$/.test(s) });
}

function montar(t, { conBS3 = true } = {}) {
  if (!disponible()) { t.skip('HOST_REAL_NO_EJECUTADO: ' + motivoSinDriver()); return null; }
  const p = proyecto('sin-huecos');
  copiarGrafo(path.join(p.root, '.agentic', 'grafo'));
  fs.writeFileSync(path.join(p.root, '.agentic', 'config.md'), '# Config\nCONFIGURADO: SI\nVERSION: 3.24.1\n\n## Módulos\n### Implementados\n_Ninguno aún._\n\n### Pendientes\n_Ninguno aún._\n');
  // Proyecto estilo Next.js: SIN src/. El módulo «modulo-demo» vive en lib/ y app/.
  fs.mkdirSync(path.join(p.root, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(p.root, 'app', 'modulo-demo'), { recursive: true });
  fs.writeFileSync(path.join(p.root, 'lib', 'modulo-demo.ts'), 'export const modulo = 1;\n');
  fs.writeFileSync(path.join(p.root, 'app', 'modulo-demo', 'page.tsx'), 'export default function P() { return null; }\n');
  fs.writeFileSync(path.join(p.root, 'package.json'), JSON.stringify({ name: 'demo', dependencies: { next: '14.0.0', react: '18.0.0' } }));
  if (conBS3) {
    const d = path.join(p.root, 'node_modules', 'better-sqlite3');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'index.js'), BS3_FALSO);
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'better-sqlite3', version: '0.0.0-falso', main: 'index.js' }));
  }
  return p;
}

function postCycle(p, { cicloId, actor, origen = 'teams', extra = [], env = {} } = {}) {
  const args = ['.agentic/grafo/post-cycle.cjs', 'lib', '--tests=3', '--tests-total=3', '--task=Tarea de prueba del registro', '--type=feature', '--modules=modulo-demo', '--skip=deps,browser', '--silent', ...(origen === 'teams' ? ['--origen=teams'] : []), ...extra];
  const e = Object.assign({}, process.env, { NODE_NO_WARNINGS: '1', AKDD_TEAMS_REUSE: JSON.stringify({ tdd: { execution_id: 'reutilizada-por-la-prueba' } }) }, env);
  if (cicloId) e.AKDD_CYCLE_ID = cicloId; else delete e.AKDD_CYCLE_ID;
  if (actor) e.AKDD_ACTOR = actor; else delete e.AKDD_ACTOR;
  return spawnSync(process.execPath, args, { cwd: p.root, env: e, encoding: 'utf8', timeout: 240000, windowsHide: true });
}

const leer = (p, sql, ...params) => { const db = abrir(p.dbPath); try { return db.prepare(sql).all(...params); } finally { try { db.close(); } catch { /* ya cerrada */ } } };

test('registro con better-sqlite3: módulos, specs, columnas del ciclo y episodio único (el caso medinet)', { timeout: 600000 }, (t) => {
  const p = montar(t); if (!p) return;
  const r1 = postCycle(p, { cicloId: 'teams_prueba_0001', actor: 'teams-v4' });
  assert.equal(r1.status, 0, r1.stderr);
  assert.ok(!/db\.run is not a function/.test(r1.stderr), 'ya no se oculta un «db.run is not a function»: ' + r1.stderr.slice(0, 300));

  assert.deepEqual(leer(p, 'SELECT name, status FROM module_registry').map((x) => x.name), ['modulo-demo'], 'module_registry se llena aunque el handle sea el crudo de better-sqlite3');
  assert.deepEqual(leer(p, 'SELECT module_name FROM spec_registry').map((x) => x.module_name), ['modulo-demo'], 'spec_registry se llena');
  const spec = fs.readFileSync(path.join(p.root, '.agentic', 'specs', 'modulo-demo.md'), 'utf8');
  assert.match(spec, /lib[\\/]modulo-demo\.ts/, 'el spec encuentra el código de un proyecto SIN src/ (lib/ y app/)');

  const [c] = leer(p, "SELECT modules_touched, stack_detected, post_cycle_ran FROM ciclos WHERE ciclo_id = 'teams_prueba_0001'");
  assert.ok(c, 'el ciclo existe');
  assert.equal(c.modules_touched, '["modulo-demo"]', 'modules_touched ya no queda en NULL');
  assert.ok(c.stack_detected && JSON.parse(c.stack_detected).front, 'stack_detected ya no queda en NULL: ' + c.stack_detected);

  // Reintentar el MISMO cierre (TEAMS lo hace): no duplica el episodio.
  const r2 = postCycle(p, { cicloId: 'teams_prueba_0001', actor: 'teams-v4' });
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(leer(p, "SELECT count(*) n FROM episodios WHERE tipo = 'ciclo_teams' AND ciclo_id = 'teams_prueba_0001'")[0].n, 1, 'un solo episodio por ciclo, también con better-sqlite3');
});

test('un paso de registro que falla se VE (stderr y post-cycle.log), no termina «bien» en silencio', { timeout: 600000 }, (t) => {
  const p = montar(t); if (!p) return;
  // Se sabotea module_registry: una VISTA con ese nombre rechaza el INSERT.
  const db = abrir(p.dbPath); db.exec('DROP TABLE IF EXISTS module_registry'); db.exec('CREATE VIEW module_registry AS SELECT 1 AS id, 1 AS name'); try { db.close(); } catch { /* ya cerrada */ }
  const r = postCycle(p, { cicloId: 'teams_prueba_0002', actor: 'teams-v4' });
  assert.match(r.stderr, /\[post-cycle\] FALLO en module_registry\(modulo-demo\)/, 'el fallo sale por stderr: ' + r.stderr.slice(0, 400));
  assert.match(r.stderr, /paso\(s\) de registro con error/);
});

test('reloj: el cierre de TEAMS no hereda la tarea abierta de otro actor; el pipeline aa: sí usa la suya', { timeout: 600000 }, (t) => {
  const p = montar(t); if (!p) return;
  const inicio = '2026-10-01T10:00:00.000Z';
  fs.writeFileSync(path.join(p.root, '.agentic', '_tarea_en_curso.json'), JSON.stringify({ actores: { cursor: { abierta: { tarea: 'tarea ajena', sesiones: [{ inicio, fin: '2026-10-01T10:01:38.000Z' }] } } } }));

  postCycle(p, { cicloId: 'teams_prueba_0003', actor: 'teams-v4' });
  const [teams] = leer(p, "SELECT fecha_inicio, duracion_ms FROM ciclos WHERE ciclo_id = 'teams_prueba_0003'");
  assert.ok(teams, 'ciclo de TEAMS registrado');
  assert.notEqual(String(teams.fecha_inicio).slice(0, 10), '2026-10-01', 'no hereda el inicio de la tarea de «cursor»');
  assert.ok(!teams.duracion_ms, 'sin medición propia no hay duración (no se inventa ni se copia la de otro): ' + teams.duracion_ms);

  // Sin actor declarado (como el hook de commit) y con UNA sola tarea abierta en la carpeta: antes se la pegaba a cada ciclo.
  postCycle(p, { cicloId: 'teams_prueba_0005' });
  const [sinActor] = leer(p, "SELECT fecha_inicio, duracion_ms FROM ciclos WHERE ciclo_id = 'teams_prueba_0005'");
  assert.ok(sinActor, 'ciclo de TEAMS sin actor registrado');
  assert.notEqual(String(sinActor.fecha_inicio).slice(0, 10), '2026-10-01', 'un cierre de TEAMS/commit no hereda la tarea abierta de nadie, ni sin actor');
  assert.ok(!sinActor.duracion_ms, 'y sin duración copiada: ' + sinActor.duracion_ms);

  postCycle(p, { cicloId: 'aa_prueba_0004', origen: 'aa', actor: 'cursor', extra: ['--origen=aa'] });
  const [aa] = leer(p, "SELECT fecha_inicio, duracion_ms FROM ciclos WHERE ciclo_id = 'aa_prueba_0004'");
  assert.ok(aa, 'ciclo aa: registrado');
  assert.equal(String(aa.fecha_inicio).slice(0, 10), '2026-10-01', 'el pipeline aa: sí usa la marca de SU actor');
  assert.equal(aa.duracion_ms, 98000, 'y su duración medida');
});

test('raíces de código: Next.js (app/, lib/, components/) y monorepos; solo carpetas que existen, sin solaparse', () => {
  const { raicesDeCodigo } = require(path.join(REPO, '.agentic', 'grafo', 'code-roots.cjs'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-raices-'));
  for (const d of ['app', 'lib', 'components', 'backend/app', 'packages/ui/src', 'apps/web/app', 'node_modules/x']) fs.mkdirSync(path.join(root, d), { recursive: true });
  const r = raicesDeCodigo(root);
  for (const esperado of ['app', 'lib', 'components', 'backend', 'packages/ui/src', 'apps/web/app']) assert.ok(r.includes(esperado), esperado + ' en ' + JSON.stringify(r));
  assert.ok(!r.includes('backend/app'), 'backend/app sobra: ya está «backend»');
  assert.ok(!r.some((x) => x.includes('node_modules')));
  assert.ok(!r.includes('src'), 'no inventa carpetas que no existen');
  assert.deepEqual(raicesDeCodigo(fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-raices-vacio-'))), []);
});

test('AST: no indexa carpetas generadas (brag-output*, out, tmp…) ni las que el .gitignore declara', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-astig-'));
  const w = (rel, txt = 'export const x = 1;\n') => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, txt); };
  w('src/real.ts'); w('brag-output-2026/work/brag.html', '<html></html>'); w('out/bundle.js'); w('tmp/x.ts'); w('descargas/y.ts'); w('src/lib.min.js');
  fs.writeFileSync(path.join(root, '.gitignore'), 'descargas/\n# comentario\n*.log\n');
  const ast = require(path.join(REPO, '.agentic', 'grafo', 'ast-indexer.cjs'));
  const rel = ast.getAllSourceFiles(root, root).map((f) => path.relative(root, f).replace(/\\/g, '/')).sort();
  assert.deepEqual(rel, ['src/real.ts']);
});
