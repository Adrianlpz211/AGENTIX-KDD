#!/usr/bin/env node
'use strict';

/**
 * Corredor de tests portable entre versiones de Node.
 *
 * POR QUÉ EXISTE
 * --------------
 * `npm test` era `node --test "test/*.test.cjs"`. Eso funciona en Node 22 y
 * falla en Node 20 — el runner de Node no expande comodines hasta la v21, así
 * que en la v20 la cadena se toma como una ruta literal que no existe y el
 * paso muere sin ejecutar una sola aserción.
 *
 * Y el CI corre las dos versiones. Resultado: Node 20 en rojo, Node 22
 * cancelado en cascada, y ninguna pista de que la causa era el comodín y no el
 * código.
 *
 * Aquí la lista de archivos se resuelve en JavaScript, que se comporta igual en
 * todas las versiones, y se le pasa explícita al runner.
 *
 * Solo se recogen los `*.test.cjs` del directorio `test/`: NO se recorre en
 * profundidad, para que `test/helpers/` (ayudantes, no tests) no acabe
 * ejecutándose como si lo fuera.
 *
 *   npm test                    todos
 *   npm test -- error-cure      solo los que contengan ese texto
 *   npm test -- test/x.test.cjs ese archivo (así llama el TDD gate)
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const DIR = path.join(RAIZ, 'test');

const filtro = process.argv.slice(2).filter((a) => !a.startsWith('-'));

const suite = fs.readdirSync(DIR).filter((f) => f.endsWith('.test.cjs')).sort();

/* Una ruta elige ese archivo exacto; un texto suelto, los que lo contengan.
   Una ruta fuera de esta suite no la puede correr este runner: se dice, no se
   da por pasada. */
const elegidos = new Set();
const fueraDeSuite = [];
for (const q of filtro) {
  if (/[\\/]/.test(q)) {
    const rel = path.relative(RAIZ, path.resolve(RAIZ, q));
    if (path.dirname(rel) === 'test' && suite.includes(path.basename(rel))) elegidos.add(path.basename(rel));
    else fueraDeSuite.push(q);
  } else {
    for (const f of suite) if (f.includes(q)) elegidos.add(f);
  }
}

const archivos = suite
  .filter((f) => !filtro.length || elegidos.has(f))
  .map((f) => path.join('test', f));

const avisarFuera = () => {
  if (!fueraDeSuite.length) return;
  console.log(`\n  No ejecutados (${fueraDeSuite.length}): no son de la suite test/*.test.cjs de este repo`);
  for (const f of fueraDeSuite) console.log('   · ' + f);
};

if (!archivos.length) {
  console.error('  Sin tests que correr' + (filtro.length ? ` para: ${filtro.join(', ')}` : '') + '.');
  avisarFuera();
  process.exit(1);
}

console.log(`  ${archivos.length} archivo(s) de test · Node ${process.version}\n`);

/* Un segundo reportero (junit) deja el resultado POR ARCHIVO: es la evidencia
   de "verificado" que lee capabilities.cjs. La salida en pantalla no cambia. */
const CACHE = path.join(RAIZ, '.agentic', '_cache');
/* Fuera del repo: mientras corre la suite está abierto, y hay tests que
   empaquetan el repo entero. */
const JUNIT = path.join(require('os').tmpdir(), `akdd-test-run-${process.pid}.junit.xml`);
const r = spawnSync(process.execPath, ['--test',
  '--test-reporter=spec', '--test-reporter-destination=stdout',
  '--test-reporter=junit', '--test-reporter-destination=' + JUNIT,
  ...archivos], {
  cwd: RAIZ,
  // Las pruebas ejercitan la guardia del host y el MCP CONTRA ESTE REPO: sin este aislamiento anotarían sus eventos
  // en la memoria real del proyecto. Los tests de captura lo activan explícitamente en SU proceso.
  env: { ...process.env, AKDD_NO_MEMORY_CAPTURE: process.env.AKDD_NO_MEMORY_CAPTURE || '1' },
  stdio: ['inherit', 'pipe', 'pipe'],
  encoding: 'utf8',
  maxBuffer: 256 * 1024 * 1024,
});
process.stdout.write(r.stdout || '');
process.stderr.write(r.stderr || '');
registrarCorrida();

function registrarCorrida() {
  try {
    const xml = fs.readFileSync(JUNIT, 'utf8');
    const porArchivo = {};
    for (const m of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
      const f = (m[1].match(/\bfile="([^"]+)"/) || [])[1];
      if (!f) continue;
      const rel = path.relative(RAIZ, f).split(path.sep).join('/');
      const e = porArchivo[rel] || (porArchivo[rel] = { pass: 0, fail: 0, skip: 0 });
      const cuerpo = m[3] || '';
      if (/<failure\b/.test(cuerpo)) e.fail++;
      else if (/<skipped\b/.test(cuerpo)) e.skip++;
      else e.pass++;
    }
    if (!fs.existsSync(CACHE)) fs.mkdirSync(CACHE);
    fs.writeFileSync(path.join(CACHE, 'test-run.json'), JSON.stringify({
      ts: new Date().toISOString(),
      node: process.version,
      status: r.status,
      filtro,
      archivos: porArchivo,
    }, null, 2));
  } catch { /* sin evidencia por archivo: capabilities lo mostrará como no verificado */ }
  try { fs.rmSync(JUNIT, { force: true }); } catch { /* temporal */ }
}

/* Lo que se omitió, con su motivo, al final y a la vista: un skip silencioso
   se lee como un verde. */
const omitidos = [...new Set(String(r.stdout || '').split(/\r?\n/)
  .map((l) => l.trim().match(/^#\s*SKIP\b.*$|^﹟?\s*\S*\s*.*\s#\s*SKIP\b.*$/))
  .filter(Boolean).map((m) => m[0]))];
if (omitidos.length) {
  console.log(`\n  Omitidos (${omitidos.length}), con su motivo:`);
  for (const o of omitidos) console.log('   · ' + o);
}
avisarFuera();

process.exit(r.status === null ? 1 : r.status);
