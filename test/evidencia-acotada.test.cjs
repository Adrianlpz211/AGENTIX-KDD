'use strict';
/* Evidencia de pruebas acotada al sujeto (caso medinet): con ~1.600 pruebas y un constructor editando sin parar, casi todas las corridas
   terminaban «UNVERIFIED (SOURCE_CHANGED_OR_INCOMPLETE)» porque CUALQUIER archivo del árbol cambiaba mientras corría la suite; solo 12
   contratos llegaron a existir y el Regression/Preservation Gate quedó inerte. Ahora:
     - lo que cambia FUERA de lo que las pruebas ejercitan (pruebas + todo lo que importan, con alias @/, + configuración) no invalida;
     - lo que cambia DENTRO sigue invalidando (la honestidad de la compuerta no se relaja);
     - si el cierre de imports no se puede resolver, o las pruebas no son JS/TS, vuelve al comportamiento estricto de siempre;
     - una huella que pierde un archivo entre listar y leer ya no se declara «incompleta». */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const G = path.join(__dirname, '..', '.agentic', 'grafo');
const { cierreDeImports } = require(path.join(G, 'import-closure.cjs'));
const se = require(path.join(G, 'source-evidence.cjs'));
const tdd = require(path.join(G, 'tdd-gate.cjs'));
const { extractTestResults } = require(path.join(G, 'test-results.cjs'));

function proyecto(archivos) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-evid-')));
  for (const [f, c] of Object.entries(archivos)) { const p = path.join(root, f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); }
  return root;
}
const BASE = {
  'package.json': JSON.stringify({ name: 'demo' }),
  'tsconfig.json': '{ /* comentario */ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./*"], }, }, }',
  'lib/a.ts': "import { b } from './b'; import { c } from '@/lib/c'; import x from 'react'; export const a = b + c;\n",
  'lib/b.ts': 'export const b = 1;\n',
  'lib/c.ts': "export * from './d.js';\n",
  'lib/d.ts': 'export const c = 2;\n',
  'lib/a.test.ts': "import { a } from './a'; import { describe } from 'vitest';\n",
  'app/page.tsx': 'export default function P() { return null; }\n',
  'docs/notas.md': '# notas\n',
};

test('cierre de imports: sigue relativos, alias @/ (tsconfig con comentarios y comas), ESM .js→.ts y deja fuera lo no importado', () => {
  const root = proyecto(BASE);
  const c = cierreDeImports(root, ['lib/a.test.ts', 'package.json']);
  assert.equal(c.completo, true, JSON.stringify(c.sinResolver));
  for (const esperado of ['lib/a.test.ts', 'lib/a.ts', 'lib/b.ts', 'lib/c.ts', 'lib/d.ts', 'package.json']) assert.ok(c.archivos.has(esperado), esperado + ' en ' + [...c.archivos]);
  assert.ok(!c.archivos.has('app/page.tsx'), 'una pantalla que ninguna prueba importa NO es sujeto');
  assert.ok(!c.archivos.has('docs/notas.md'));
});

test('cierre de imports: un import del proyecto que no se resuelve declara el cierre INCOMPLETO (no se adivina)', () => {
  const root = proyecto(Object.assign({}, BASE, { 'lib/a.test.ts': "import { a } from './a'; import { z } from './no-existe'; import y from '@/lib/tampoco';\n" }));
  const c = cierreDeImports(root, ['lib/a.test.ts']);
  assert.equal(c.completo, false);
  assert.ok(c.sinResolver.some((s) => s.includes('./no-existe')) && c.sinResolver.some((s) => s.includes('@/lib/tampoco')), JSON.stringify(c.sinResolver));
});

test('source-evidence: diff dice QUÉ cambió, y acotar deja solo el subconjunto', () => {
  const root = proyecto(BASE);
  const antes = se.capture(root);
  assert.equal(antes.complete, true);
  fs.writeFileSync(path.join(root, 'lib/b.ts'), 'export const b = 99;\n'); fs.writeFileSync(path.join(root, 'nuevo.ts'), 'x'); fs.rmSync(path.join(root, 'docs/notas.md'));
  const despues = se.capture(root);
  assert.deepEqual(se.diff(antes, despues), ['docs/notas.md', 'lib/b.ts', 'nuevo.ts']);
  const sub = se.acotar(antes, ['lib/a.ts', 'lib/b.ts', 'no-esta.ts']);
  assert.deepEqual(Object.keys(sub.files).sort(), ['lib/a.ts', 'lib/b.ts']);
  assert.equal(sub.scope, 'subject');
  assert.notEqual(sub.hash, antes.hash);
});

test('source-evidence: no hashea carpetas generadas por herramientas y no se declara incompleto por ellas', () => {
  const root = proyecto(Object.assign({}, BASE, { 'test-results/x.json': '1', 'playwright-report/i.html': '1', 'brag-output-1/work/b.html': '1', 'tsconfig.tsbuildinfo': '1' }));
  const h = se.capture(root);
  assert.equal(h.complete, true);
  assert.ok(!Object.keys(h.files).some((f) => /test-results|playwright-report|brag-output|tsbuildinfo/.test(f)), Object.keys(h.files).join(','));
});

/** Runner falso: imprime TAP y, DURANTE la corrida, toca los archivos que le diga CAMBIA (JSON en el entorno). */
function conRunner(root, cambia) {
  fs.writeFileSync(path.join(root, 'runner.cjs'), `const fs = require('fs'); const c = JSON.parse(process.env.CAMBIA || '[]');
    for (const f of c) fs.writeFileSync(require('path').join(process.cwd(), f), '// editado durante la corrida ' + Math.random() + '\\n');
    console.log('TAP version 13\\nok 1 - suma\\n1..1\\n# tests 1\\n# pass 1\\n# fail 0');`);
  process.env.CAMBIA = JSON.stringify(cambia);
  return () => { delete process.env.CAMBIA; };
}
const correr = (root) => tdd.runTests('node runner.cjs', root, null, { execution_id: 'ex-' + Math.random().toString(36).slice(2), cycle_id: 'c1', subject_hash: 'sh' });

test('runTests: sin cambios durante la corrida → PASS con el árbol completo (como siempre)', () => {
  const root = proyecto(BASE); const limpiar = conRunner(root, []);
  try {
    const r = correr(root);
    assert.equal(r.status, 'PASS', JSON.stringify(r.source_check));
    assert.equal(r.source_check, undefined, 'sin cambios no hay nada que acotar');
    assert.equal(r.source_evidence.scope, undefined);
  } finally { limpiar(); }
});

test('runTests: un cambio AJENO a lo que las pruebas ejercitan durante la corrida NO invalida (queda anotado qué cambió fuera)', () => {
  const root = proyecto(BASE); const limpiar = conRunner(root, ['app/page.tsx', 'docs/notas.md']);
  try {
    const r = correr(root);
    assert.equal(r.status, 'PASS', JSON.stringify(r.source_check) + ' ' + r.reason_code);
    assert.equal(r.source_check.alcance, 'sujeto');
    assert.equal(r.source_check.cambios_fuera_del_sujeto, 2);
    assert.deepEqual(r.source_check.muestra.sort(), ['app/page.tsx', 'docs/notas.md']);
    assert.equal(r.source_evidence.scope, 'subject', 'la evidencia queda acotada al sujeto');
    assert.ok(!('app/page.tsx' in r.source_evidence.files) && 'lib/b.ts' in r.source_evidence.files);
  } finally { limpiar(); }
});

test('runTests: un cambio DENTRO de lo que las pruebas ejercitan sigue dando UNVERIFIED (la honestidad no se relaja)', () => {
  for (const archivo of ['lib/b.ts', 'lib/d.ts', 'lib/a.test.ts', 'package.json']) {
    const root = proyecto(BASE); const limpiar = conRunner(root, [archivo]);
    try {
      const r = correr(root);
      assert.equal(r.status, 'UNVERIFIED', archivo + ': ' + JSON.stringify(r.source_check));
      assert.equal(r.reason_code, 'SOURCE_CHANGED_OR_INCOMPLETE');
      assert.ok(r.source_check.en_el_sujeto.includes(archivo), archivo);
      assert.equal(r.allPassed, false);
    } finally { limpiar(); }
  }
});

test('runTests: una prueba NUEVA que aparece durante la corrida también invalida (pudo ejecutarse)', () => {
  const root = proyecto(BASE); const limpiar = conRunner(root, ['lib/otra.test.ts']);
  try { const r = correr(root); assert.equal(r.status, 'UNVERIFIED', JSON.stringify(r.source_check)); } finally { limpiar(); }
});

test('runTests: cierre de imports incompleto o pruebas que no son JS/TS → comportamiento ESTRICTO (cualquier cambio invalida)', () => {
  const sinResolver = proyecto(Object.assign({}, BASE, { 'lib/a.test.ts': "import './fantasma';\n" })); let limpiar = conRunner(sinResolver, ['app/page.tsx']);
  try { const r = correr(sinResolver); assert.equal(r.status, 'UNVERIFIED'); assert.match(r.source_check.motivo, /cierre de imports incompleto/); assert.ok(r.source_check.sin_resolver.some((s) => s.includes('./fantasma'))); } finally { limpiar(); }
  const py = proyecto({ 'package.json': '{}', 'tests/test_x.py': 'def test_x(): pass\n', 'app/main.py': 'x = 1\n' }); limpiar = conRunner(py, ['app/main.py']);
  try { const r = correr(py); assert.equal(r.status, 'UNVERIFIED'); assert.match(r.source_check.motivo, /no son JS\/TS|no se encontraron/); } finally { limpiar(); }
});

test('parser: vitest/jest sin TTY → el contrato conoce su archivo y su nombre no lleva «(N tests)» ni la duración', () => {
  const salida = [' ✓ lib/a.test.ts (12 tests) 34ms', ' ✓ app/x.spec.tsx (3 tests | 1 skipped) 8ms', ' ✓ lib/b.test.ts (1 test)', ' ✗ lib/rota.test.ts (2 tests | 1 failed) 20ms', ' ✓ suma básica 3ms'].join('\n');
  const r = extractTestResults(salida);
  const por = Object.fromEntries(r.map((x) => [x.test_name, x]));
  assert.deepEqual(r.slice(0, 4).map((x) => [x.test_file, x.test_name, x.status]), [
    ['lib/a.test.ts', 'lib/a.test.ts', 'pass'], ['app/x.spec.tsx', 'app/x.spec.tsx', 'pass'], ['lib/b.test.ts', 'lib/b.test.ts', 'pass'], ['lib/rota.test.ts', 'lib/rota.test.ts', 'fail']]);
  assert.equal(por['suma básica'].status, 'pass', 'un título suelto con duración sin paréntesis también se limpia');
  assert.equal(por['suma básica'].test_file, null);
});

test('contratos: nacen con su archivo de prueba y con el código que esa prueba ejercita (source_files) → el radio de impacto los relaciona', (t) => {
  const { disponible, motivoSinDriver } = require('./helpers/sqlite.cjs');
  if (!disponible()) return t.skip('HOST_REAL_NO_EJECUTADO: ' + motivoSinDriver());
  const { proyecto: pm } = require('./helpers/memoria-proyecto.cjs');
  const cg = require(path.join(G, 'contract-guard.cjs'));
  const p = pm('contratos-src'); const root = p.root;
  for (const [f, c] of Object.entries(BASE)) { const a = path.join(root, f); fs.mkdirSync(path.dirname(a), { recursive: true }); fs.writeFileSync(a, c); }
  const db = p.abrirW();
  try {
    const tests = extractTestResults(' ✓ lib/a.test.ts (3 tests) 5ms');
    const r = cg.registerPassingTests(db, { area: 'lib', command: 'npm test', execution_id: 'ex-1', subject_hash: 'sh', tests, root });
    assert.equal(r.status, 'PASS', JSON.stringify(r)); assert.equal(r.created, 1);
    const fila = db.get('SELECT test_file, test_name, source_files, mapping_status FROM verified_contracts');
    assert.equal(fila.test_file, 'lib/a.test.ts'); assert.equal(fila.test_name, 'lib/a.test.ts'); assert.equal(fila.mapping_status, 'RESOLVED');
    const fuentes = JSON.parse(fila.source_files);
    for (const f of ['lib/a.ts', 'lib/b.ts', 'lib/c.ts', 'lib/d.ts']) assert.ok(fuentes.includes(f), f + ' en ' + fuentes);
    assert.ok(!fuentes.includes('lib/a.test.ts') && !fuentes.includes('app/page.tsx'), 'ni la propia prueba ni lo que no importa');
    // La misma prueba en otra corrida (otro execution_id) suma al MISMO contrato: el nombre ya no cambia con la duración.
    const r2 = cg.registerPassingTests(db, { area: 'lib', command: 'npm test', execution_id: 'ex-2', subject_hash: 'sh2', tests: extractTestResults(' ✓ lib/a.test.ts (3 tests) 9ms'), root });
    assert.equal(r2.updated, 1); assert.equal(r2.created, 0);
    assert.equal(db.get('SELECT count(*) n FROM verified_contracts').n, 1);
  } finally { db.close(); }
});
