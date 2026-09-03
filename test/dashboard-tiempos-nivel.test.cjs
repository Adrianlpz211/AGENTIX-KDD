/**
 * «Línea de Tiempo» es una vista de primer nivel, no una entrada enterrada.
 *
 * Vivía dentro de Project Docs > Knowledge > Tiempos: tres clics y un submenú
 * para llegar a la pantalla que responde «cuánto costó esto», que es lo primero
 * que pregunta quien paga. Un dato que cuesta encontrar no se consulta, y un
 * dato que no se consulta da igual lo bien medido que esté.
 *
 * Estos tests fijan la colocación. Si un refactor la devuelve al submenú, o la
 * saca de la barra superior, el CI se pone rojo en vez de que nadie se entere
 * hasta que alguien pregunte «¿y dónde estaba eso?».
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const fuente = fs.readFileSync(path.join(__dirname, '..', 'dashboard.cjs'), 'utf8');

test('es la cuarta pestaña de la barra superior', () => {
  const tabs = [...fuente.matchAll(/class="mode-tab[^"]*"\s+onclick="setMode\('([a-z]+)'/g)]
    .map((m) => m[1]);
  assert.deepEqual(tabs, ['graph', 'docs', 'intel', 'tiempos'],
    'las pestañas de primer nivel deben ser esas cuatro, en ese orden');
});

test('se llama «Línea de Tiempo»', () => {
  const linea = fuente.split('\n').find((l) => /setMode\('tiempos'/.test(l));
  assert.match(linea, /Línea de Tiempo/,
    'el nombre lo eligió el dev: es el que busca con los ojos, no «Tiempos»');
});

test('setMode sabe mostrarla y ocultarla', () => {
  assert.match(fuente, /mode-tiempos/,
    'debe existir el contenedor #mode-tiempos');
  assert.match(fuente, /mt\.style\.display\s*=\s*mode==='tiempos'/,
    "setMode debe conmutar el modo 'tiempos' como los otros tres");
});

test('NO volvió a esconderse dentro de Project Docs', () => {
  /* Las dos formas en que podría re-enterrarse: una entrada en la barra
     lateral de docs, o el contenedor con la clase que solo vive ahí. */
  assert.ok(!/showDoc\('tiempos'/.test(fuente),
    'no puede haber una entrada showDoc(\'tiempos\') en la barra lateral de Project Docs');
  assert.ok(!/class="docs-section"\s+id="doc-tiempos"/.test(fuente),
    'no puede volver a ser una docs-section dentro de Project Docs');
});

test('el contenedor está fuera de #mode-docs, no anidado dentro', () => {
  const iDocs = fuente.indexOf('<div id="mode-docs">');
  const iIntel = fuente.indexOf('id="mode-intel"');
  const iTiempos = fuente.indexOf('<div id="mode-tiempos">');
  assert.ok(iTiempos > 0, 'debe existir el contenedor');
  assert.ok(iTiempos > iIntel && iIntel > iDocs,
    'debe ir después de Preservation Intel, que es donde el dev la pidió');
});

test('la vista se lleva su contenido, no un cascarón', () => {
  const i = fuente.indexOf('<div id="mode-tiempos">');
  const bloque = fuente.slice(i, i + 20000);
  for (const trozo of ['Tiempos y avance', 'exportarTiempos', 'tiemposDB']) {
    assert.ok(bloque.includes(trozo),
      'la vista debe contener ' + trozo + ' — si no, se movió el marco y se quedó el contenido atrás');
  }
});
