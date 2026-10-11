'use strict';
/* Falso positivo medido en medinet (11/10/2026): el cierre del ciclo corre MINUTOS después del commit y el constructor sigue editando. El control comparaba la copia
   de trabajo (a medio reescribir) contra HEAD y daba 62 «títulos desaparecidos» críticos en un archivo que tenía 44 pruebas. Ahora compara el commit contra su padre,
   los dos desde los objetos de git. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const TIG = require(path.join(__dirname, '..', '.agentic', 'grafo', 'test-integrity-gate.cjs'));

const git = (root, ...a) => cp.spawnSync('git', a, { cwd: root, encoding: 'utf8', windowsHide: true });
const prueba = (titulos) => titulos.map((t) => `it('${t}', () => { expect(1).toBe(1); });`).join('\n') + '\n';
function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-tig-'));
  git(root, 'init', '-q'); git(root, 'config', 'user.email', 'a@b.c'); git(root, 'config', 'user.name', 'x'); git(root, 'config', 'commit.gpgsign', 'false');
  return root;
}
const commit = (root, msg) => { git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', msg, '--no-verify'); return git(root, 'rev-parse', 'HEAD').stdout.trim(); };

test('TIC-1 el commit se compara contra su padre: un título que SÍ desapareció en ese commit se ve', () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'a.test.ts'), prueba(['suma dos', 'resta dos', 'multiplica']));
  commit(root, 'base');
  fs.writeFileSync(path.join(root, 'a.test.ts'), prueba(['suma dos', 'multiplica']));   // se quitó «resta dos»
  const sha = commit(root, 'quita una prueba');
  const r = TIG.scanCommit(root, sha, ['a.test.ts']);
  assert.equal(r.scanned, true);
  assert.deepEqual(r.findings.map((f) => f.tituloDesaparecido), ['resta dos']);
});

test('TIC-2 el caso real: el constructor sigue editando DESPUÉS del commit y eso ya no cuenta como pruebas borradas', () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'b.test.ts'), prueba(['uno', 'dos', 'tres', 'cuatro']));
  commit(root, 'base');
  fs.writeFileSync(path.join(root, 'b.test.ts'), prueba(['uno', 'dos', 'tres', 'cuatro', 'cinco']));   // el commit solo AÑADE
  const sha = commit(root, 'añade una prueba');
  // el constructor sigue reescribiendo el archivo mientras corre el cierre: borra y renombra a media edición
  fs.writeFileSync(path.join(root, 'b.test.ts'), prueba(['otro nombre']));
  const viejo = TIG.scan(root, { staged: false, files: ['b.test.ts'] });   // lo que hacía el cierre antes: copia de trabajo vs HEAD
  assert.ok(viejo.findings.length >= 4, 'el método anterior daba alarmas falsas: ' + viejo.findings.length);
  const nuevo = TIG.scanCommit(root, sha, ['b.test.ts']);
  assert.deepEqual(nuevo.findings, [], 'comparando commit contra padre no hay nada que avisar');
});

test('TIC-3 archivo nuevo, borrado, commit raíz y archivos que el commit no tocó', () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'c.test.ts'), prueba(['x']));
  const raiz = commit(root, 'raíz');
  assert.deepEqual(TIG.scanCommit(root, raiz, ['c.test.ts']), { findings: [], scanned: false }, 'commit raíz: sin padre');
  fs.writeFileSync(path.join(root, 'd.test.ts'), prueba(['nuevo1', 'nuevo2']));
  const sha2 = commit(root, 'archivo nuevo');
  assert.deepEqual(TIG.scanCommit(root, sha2, ['d.test.ts']).findings, [], 'un archivo nuevo no tiene versión anterior');
  assert.deepEqual(TIG.scanCommit(root, sha2, ['c.test.ts']), { findings: [], scanned: false }, 'c.test.ts no estaba en ese commit');
  fs.rmSync(path.join(root, 'c.test.ts'));
  const sha3 = commit(root, 'borra c');
  const r = TIG.scanCommit(root, sha3, ['c.test.ts']);
  assert.deepEqual(r.findings.map((f) => f.tituloDesaparecido), ['x'], 'borrar la prueba entera sí es un título desaparecido');
});

test('TIC-4 una referencia rara no se interpreta: cae a HEAD', () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'e.test.ts'), prueba(['a'])); commit(root, 'base');
  fs.writeFileSync(path.join(root, 'e.test.ts'), prueba(['b'])); commit(root, 'cambia');
  const r = TIG.scanCommit(root, '; rm -rf /', ['e.test.ts']);
  assert.deepEqual(r.findings.map((f) => f.tituloDesaparecido), ['a']);
});
