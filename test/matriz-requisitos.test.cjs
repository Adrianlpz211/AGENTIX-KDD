'use strict';
/* La matriz requisito → prueba no se pudre: cada prueba citada existe y cada documento de la especificación tiene requisitos. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const m = require(path.join(__dirname, '..', 'scripts', 'gen-matriz-requisitos.cjs'));

test('matriz: toda prueba citada por un requisito existe (no se puede citar una prueba inventada)', () => {
  assert.deepEqual(m.comprobar(), []);
});

test('matriz: los seis documentos tienen requisitos y todos declaran su alcance (real / fixture / simulado / NO_EJECUTADO)', () => {
  const docs = new Set(m.datos.requisitos.map((r) => r.doc));
  for (const d of ['C01', 'C02', 'C03', 'H01', 'H02', 'H03']) assert.ok(docs.has(d), d);
  for (const r of m.datos.requisitos) assert.ok(r.alcance && r.alcance.length > 4, r.id + ' sin alcance');
  const ids = m.datos.requisitos.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'ids únicos');
});

test('matriz: lo que no se probó en un host real se declara NO_EJECUTADO y el documento no afirma publicación', () => {
  const md = m.markdown();
  assert.match(md, /H02-11b/);
  assert.match(md, /NO_EJECUTADO/);
  assert.match(md, /no afirma que 3\.20\.1 esté publicada/);
  assert.match(md, /Implementado no es verificado/i);
});
