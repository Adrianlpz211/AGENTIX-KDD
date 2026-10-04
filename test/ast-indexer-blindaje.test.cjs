'use strict';
/* El indexador AST ya no puede dejar sin servicio a la base: caso real medido en glowly (un indexado de ~10 min
   retuvo memoria.db; el tablero devolvía DB_BLOQUEADA y los cierres de TEAMS fallaban). Aquí se prueba que:
   · espera por los bloqueos de otros escritores en vez de fallar al instante,
   · solo hay UN indexado a la vez por proyecto (los demás se saltan),
   · escribe por lotes cortos y respeta un presupuesto de tiempo (la próxima corrida sigue donde quedó),
   · sin cambios en el código no reescribe nada (PageRank incluido). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const INDEXER = path.join(__dirname, '..', '.agentic', 'grafo', 'ast-indexer.cjs');
const ast = require(INDEXER);

function proyecto(n = 30) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-ast-'));
  fs.mkdirSync(path.join(root, '.agentic'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  for (let i = 0; i < n; i++) {
    const prev = i ? "const p = require('./m" + (i - 1) + "');\n" : '';
    fs.writeFileSync(path.join(root, 'src', 'm' + i + '.js'), prev + 'function f' + i + '(a) { return a + ' + i + '; }\nfunction g' + i + '() { return f' + i + '(1); }\nmodule.exports = { f' + i + ', g' + i + ' };\n');
  }
  return root;
}
function contar(root, tabla) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(root, '.agentic', 'memoria.db'), { readOnly: true });
  try { return db.prepare('SELECT count(*) AS n FROM ' + tabla).get().n; } finally { db.close(); }
}
function cli(root, env) {
  return spawnSync(process.execPath, [INDEXER, 'index'], { cwd: root, encoding: 'utf8', timeout: 120000, env: Object.assign({}, process.env, env || {}) });
}
const silencio = (fn) => { const o = console.log; const w = process.stdout.write; console.log = () => {}; process.stdout.write = () => true; try { return fn(); } finally { console.log = o; process.stdout.write = w; } };

test('indexa por lotes y el resultado es idéntico al de siempre; sin cambios no reescribe nada', () => {
  const root = proyecto(30);
  const r1 = silencio(() => ast.indexProject(root));
  assert.equal(r1.indexed, 30);
  const simbolos = contar(root, 'ast_symbols');
  assert.ok(simbolos >= 60, 'dos funciones por archivo como mínimo: ' + simbolos);
  assert.ok(contar(root, 'ast_edges') > 0);
  const r2 = cli(root);
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /Sin cambios en el código: PageRank vigente/);
  assert.equal(contar(root, 'ast_symbols'), simbolos, 'repetir no duplica');
});

test('un solo indexado por proyecto: con otro vivo se salta; un lock viejo o de un proceso muerto no estorba', () => {
  const root = proyecto(5);
  const lock = path.join(root, '.agentic', '_ast-indexing.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
  const r = silencio(() => ast.indexProject(root));
  assert.equal(r.enCurso, true, 'con otro indexado vivo se omite');
  assert.equal(fs.existsSync(path.join(root, '.agentic', 'memoria.db')), false, 'ni siquiera toca la base');
  fs.writeFileSync(lock, JSON.stringify({ pid: 2147483000, at: Date.now() }));
  const r2 = silencio(() => ast.indexProject(root));
  assert.equal(r2.indexed, 5, 'el lock de un proceso muerto se retira solo');
  assert.equal(fs.existsSync(lock), false, 'y el lock se libera al terminar');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() - 30 * 60000 }));
  assert.equal(silencio(() => ast.indexProject(root)).enCurso, undefined, 'un lock de más de 20 min se considera abandonado');
});

test('presupuesto de tiempo: se detiene ordenadamente y la siguiente corrida termina lo que faltó, sin duplicar', () => {
  const rootRef = proyecto(40);
  silencio(() => ast.indexProject(rootRef));
  const esperado = contar(rootRef, 'ast_symbols');
  const root = proyecto(40);
  process.env.AKDD_AST_MAX_MS = '1';
  let parcial;
  try { parcial = silencio(() => ast.indexProject(root)); } finally { delete process.env.AKDD_AST_MAX_MS; }
  assert.equal(parcial.parcial, true);
  assert.ok(parcial.pendientes > 0 && parcial.indexed < 40, 'quedó trabajo pendiente: ' + JSON.stringify(parcial));
  const fin = silencio(() => ast.indexProject(root));
  assert.equal(fin.parcial, false);
  assert.equal(contar(root, 'ast_symbols'), esperado, 'la suma de las dos corridas = una corrida completa');
});

test('espera el bloqueo de otro escritor en vez de fallar: un escritor que retiene la base 2 s no hace perder archivos', async () => {
  const root = proyecto(12);
  silencio(() => ast.indexProject(root)); // crea la base y el esquema
  fs.writeFileSync(path.join(root, 'src', 'm3.js'), 'function nueva() { return 1; }\nmodule.exports = { nueva };\n');
  const retiene = "const { DatabaseSync } = require('node:sqlite');const d = new DatabaseSync(process.argv[1]);d.exec('BEGIN IMMEDIATE');console.log('LISTO');setTimeout(() => { d.exec('COMMIT'); d.close(); }, 2000);";
  const hijo = spawn(process.execPath, ['-e', retiene, path.join(root, '.agentic', 'memoria.db')], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res) => hijo.stdout.on('data', (d) => { if (String(d).includes('LISTO')) res(); }));
  const t0 = Date.now();
  const r = cli(root, { AKDD_AST_BUSY_MS: '15000' });
  const ms = Date.now() - t0;
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /crash inesperado|database is locked/);
  assert.match(r.stdout, /1 indexados/);
  assert.ok(ms >= 1500, 'esperó al otro escritor (' + ms + ' ms)');
  await new Promise((res) => hijo.on('exit', res));
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(root, '.agentic', 'memoria.db'), { readOnly: true });
  try { assert.ok(db.prepare("SELECT count(*) AS n FROM ast_symbols WHERE symbol_name = 'nueva'").get().n >= 1, 'el archivo cambiado quedó indexado'); } finally { db.close(); }
});

test('tres indexados lanzados a la vez no se pelean: el resultado es el mismo que uno solo y nadie falla', async () => {
  const rootRef = proyecto(25);
  silencio(() => ast.indexProject(rootRef));
  const esperado = contar(rootRef, 'ast_symbols');
  const root = proyecto(25);
  const lanzar = () => new Promise((res) => { const p = spawn(process.execPath, [INDEXER, 'index'], { cwd: root }); let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; }); p.on('exit', (c) => res({ c, out })); });
  const rs = await Promise.all([lanzar(), lanzar(), lanzar()]);
  for (const r of rs) { assert.equal(r.c, 0); assert.doesNotMatch(r.out, /crash inesperado|database is locked/); }
  assert.ok(rs.some((r) => /ya hay un indexado en curso|Completado/.test(r.out)));
  assert.equal(contar(root, 'ast_symbols'), esperado);
});
