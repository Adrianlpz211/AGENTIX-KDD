/**
 * Una sola definición de escHtml, y ningún carácter que rompa el <script>.
 *
 * dashboard.cjs tenía DOS escHtml: la del servidor (línea 21) escapaba
 * & < > " ` $ — la del cliente (línea 2367) solo & < >. La copia débil es la
 * que corría en el navegador. Dos copias de una función de escape es el
 * terreno donde aparecen los agujeros: la débil se olvida de un carácter y
 * nadie lo nota porque «ya está escapado».
 *
 * Ahora el cliente recibe la del servidor inyectada con ${escHtml.toString()}.
 * Estos tests vigilan que siga habiendo una sola y que sea la completa.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const DASH = path.join(__dirname, '..', 'dashboard.cjs');
const fuente = fs.readFileSync(DASH, 'utf8');

test('escHtml está definida una sola vez', () => {
  const defs = fuente.match(/function\s+escHtml\s*\(/g) || [];
  assert.equal(defs.length, 1,
    'hay ' + defs.length + ' definiciones de escHtml — debe haber exactamente una');
});

test('el cliente recibe la escHtml del servidor, no una copia propia', () => {
  assert.match(fuente, /\$\{escHtml\.toString\(\)\}/,
    'el <script> del cliente debe inyectar la función del servidor');
});

test('escHtml escapa los seis caracteres, no solo tres', () => {
  /* Se ejecuta la función real extraída del fuente. */
  const i = fuente.indexOf('function escHtml');
  const cuerpo = fuente.slice(i);
  const fin = cuerpo.indexOf('\n}\n');
  const escHtml = new Function('return ' + cuerpo.slice(0, fin + 2))();

  const casos = [
    ['&', '&amp;',  'ampersand'],
    ['<', '&lt;',   'menor que'],
    ['>', '&gt;',   'mayor que'],
    ['"', '&quot;', 'comilla doble — sin esto, inyección en atributos HTML'],
    ['`', '&#96;',  'backtick — sin esto, se escapa de un template literal'],
    ['$', '&#36;',  'dólar — sin esto, ${...} se interpola en el cliente']
  ];
  for (const [entrada, esperado, porque] of casos) {
    assert.equal(escHtml(entrada), esperado,
      'escHtml debe escapar ' + porque);
  }
});

test('el fuente no lleva separadores de línea unicode', () => {
  /* U+2028 y U+2029 son saltos de línea válidos en JavaScript pero no en JSON:
     uno literal dentro de un <script> parte el archivo por la mitad y el
     navegador ve un error de sintaxis que no se ve leyendo el código. */
  const ficheros = [DASH, path.join(__dirname, '..', 'src', 'update.js')];
  for (const f of ficheros) {
    const t = fs.readFileSync(f, 'utf8');
    const linea = t.split(/\r?\n/).findIndex((l) => /[\u2028\u2029]/.test(l));
    assert.equal(linea, -1,
      path.basename(f) + ' tiene U+2028/U+2029 literal en la línea ' + (linea + 1));
  }
});
