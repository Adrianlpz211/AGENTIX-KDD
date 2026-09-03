/**
 * El CI tiene que poder ponerse rojo por el código, y solo por el código.
 *
 * Dos formas en que este proyecto tuvo un CI que no servía, las dos reales:
 *
 *   1. `npm test` era `akdd --version` — un print de versión disfrazado de
 *      tests. El CI llevaba meses en verde sin ejecutar una sola aserción.
 *   2. Al hacerlo honesto, pasó a ser `node --test "test/*.test.cjs"`, que
 *      funciona en Node 22 y falla en Node 20: el runner de Node no expande
 *      comodines hasta la v21. Rojo en media matriz por el comodín, no por el
 *      código — y sin ninguna pista de cuál era la causa.
 *
 * Un CI verde que no corre nada y un CI rojo por el entorno son el mismo
 * problema con dos caras: en los dos casos el color deja de significar algo.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8'));

test('npm test ejecuta tests de verdad, no un print de versión', () => {
  const t = pkg.scripts.test;
  assert.ok(t, 'debe existir el script test');
  assert.ok(!/--version/.test(t),
    'un print de versión no es una suite: eso mantuvo el CI en verde sin correr nada');
  assert.match(t, /run-tests\.cjs|--test/,
    'el script debe invocar el runner de Node');
});

test('npm test no depende de que Node expanda comodines', () => {
  /* El comodín solo funciona desde Node 21. La matriz del CI incluye la 20. */
  assert.ok(!/\*/.test(pkg.scripts.test),
    'sin comodines en el script: la lista de archivos se resuelve en JS, que se ' +
    'comporta igual en todas las versiones de Node');
});

test('el corredor solo recoge los tests, no los ayudantes', () => {
  /* `test/helpers/` son utilidades compartidas. Si el corredor recorriera en
     profundidad las ejecutaría como si fueran tests. */
  const src = fs.readFileSync(path.join(RAIZ, 'scripts', 'run-tests.cjs'), 'utf8');
  assert.match(src, /readdirSync/, 'debe listar el directorio');
  assert.ok(!/recursive:\s*true/.test(src),
    'no puede recorrer en profundidad: se llevaría test/helpers por delante');
  assert.match(src, /\.test\.cjs/, 'debe filtrar por el sufijo de test');
});

test('el corredor propaga el código de salida', () => {
  /* Si devolviera 0 siempre, volveríamos al CI decorativo del principio. */
  const src = fs.readFileSync(path.join(RAIZ, 'scripts', 'run-tests.cjs'), 'utf8');
  assert.match(src, /process\.exit\(r\.status/,
    'el fallo del runner tiene que llegar a npm, o el CI vuelve a ser un adorno');
});

test('el workflow instala dependencias y corre la suite', () => {
  const ci = fs.readFileSync(path.join(RAIZ, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(ci, /npm ci|npm install/,
    'sin instalar dependencias los tests no pueden ni cargar');
  assert.match(ci, /npm test|npm run test/,
    'el workflow debe correr la suite');
});

/* ── la versión no puede vivir en dos sitios y divergir ────────────────────── */

test('package.json y config.md declaran la misma versión', () => {
  /* `config.md` decía 3.11.7 con `package.json` en 3.18.1 — siete versiones de
     diferencia. Nadie lo notó porque nada las comparaba, y el número de
     config.md es el que ve quien abre el proyecto. */
  const cfg = fs.readFileSync(path.join(RAIZ, '.agentic', 'config.md'), 'utf8');
  const m = cfg.match(/^\s*VERSION:\s*(\S+)/m);
  assert.ok(m, 'config.md debe declarar VERSION');
  assert.equal(m[1], pkg.version,
    `config.md dice ${m[1]} y package.json dice ${pkg.version} — el número que ve ` +
    'quien abre el proyecto es el de config.md, y estaba siete versiones atrás');
});

test('la versión sube antes de publicar', () => {
  /* npm rechaza publicar dos veces el mismo número, y el workflow de publish
     fallaba en silencio por eso. Este test no puede consultar npm desde el CI,
     pero sí exigir que la versión tenga forma válida y no sea la de un parche
     olvidado. */
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'versión con forma semántica');
});
