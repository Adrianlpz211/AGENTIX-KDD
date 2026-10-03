'use strict';
/* El piloto de release tenía '3.20.0' escrito 4 veces: al subir a 3.20.1 la
 * barrera falló en el paso 3 (03/10/2026). El objetivo sale de package.json;
 * solo la base publicada (3.19.0) puede ser un literal. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'release-integration.cjs'), 'utf8');

// Bases ya publicadas contra las que se prueba la actualización (nunca la versión objetivo).
const BASES_PUBLICADAS = ['3.19.0', '3.20.0'];

test('release: el piloto no fija la versión objetivo', () => {
  assert.match(src, /const TARGET\s*=\s*require\('\.\.\/package\.json'\)\.version/);
  const pkgVersion = require('../package.json').version;
  const literales = [...src.matchAll(/'(\d+\.\d+\.\d+)'/g)].map((m) => m[1]).filter((v) => !BASES_PUBLICADAS.includes(v) || v === pkgVersion);
  assert.deepEqual(literales, [], 'versión escrita a mano que no es una base publicada (' + pkgVersion + ' debe salir de package.json)');
});

test('release: la base del piloto sigue siendo la 3.19.0 publicada', () => {
  assert.match(src, /'3\.19\.0'/);
});
