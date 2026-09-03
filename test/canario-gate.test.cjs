/**
 * Un arreglo no se cierra sin un test que lo detecte.
 *
 * "Que los errores no se repitan" no lo da la memoria ni la buena intención:
 * lo da un test que se pone rojo cuando el error vuelve. Eso ya estaba escrito
 * como disciplina en el protocolo, y la disciplina que depende de que alguien
 * se acuerde no ocurre — en la memoria de D:\360 había 29 errores registrados
 * y 3 comportamientos protegidos. Veintinueve arreglos, tres canarios.
 *
 * Estos tests fijan las tres propiedades que hacen útil el control, y muy en
 * particular la tercera, que es la que decide si sobrevive instalado:
 *   1. un ARREGLO sin test frena
 *   2. un arreglo CON test pasa
 *   3. una FUNCIONALIDAD nueva sin test solo avisa
 *
 * La 3 nació de un fallo real durante la implementación: el gate mezclaba el
 * tipo declarado con el mensaje del último commit, así que en un repo cuyo
 * commit anterior decía "fix" TODA funcionalidad nueva frenaba. Un freno falso
 * es exactamente lo que lleva a desactivar un control — y al desactivarlo se
 * pierde también el freno que sí importaba.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const cg = require('../.agentic/grafo/canario-gate.cjs');
const RAIZ = path.join(__dirname, '..');

/* Archivos que existen en el repo, para no depender de git ni del disco. */
const PROD = 'src/update.js';
const TEST = 'test/error-cure.test.cjs';

test('un ARREGLO sin ningún test frena', () => {
  const r = cg.revisar(RAIZ, { files: [PROD], tipo: 'fix' });
  assert.equal(r.veredicto, 'STOP');
  assert.equal(r.esArreglo, true);
  assert.match(cg.formatear(r), /regresión de mañana/);
});

test('un arreglo que trae su test pasa', () => {
  const r = cg.revisar(RAIZ, { files: [PROD, TEST], tipo: 'fix' });
  assert.equal(r.veredicto, 'PASS');
});

test('una FUNCIONALIDAD nueva sin test solo avisa, no frena', () => {
  /* El fallo real: se consultaba el mensaje del último commit ADEMÁS del tipo
     declarado. En un repo cuyo commit anterior decía "fix", esto daba STOP. */
  const r = cg.revisar(RAIZ, { files: [PROD], tipo: 'feature' });
  assert.equal(r.veredicto, 'WARN',
    'escribir deuda de test en una funcionalidad nueva es normal; frenarlo haría que se desactive el gate');
  assert.equal(r.esArreglo, false);
});

test('el tipo declarado manda sobre el mensaje del commit', () => {
  /* Canario del canario: si alguien vuelve a concatenar las dos señales, el
     test de arriba se vuelve inestable según cuál fuera el último commit del
     repo. Aquí se comprueba en el fuente, que no depende del historial. */
  const src = fs.readFileSync(
    path.join(RAIZ, '.agentic', 'grafo', 'canario-gate.cjs'), 'utf8');
  assert.ok(!/String\(tipo \|\| ''\) \+ ' ' \+ mensajeDelCambio/.test(src),
    'no se puede volver a mezclar el tipo declarado con el mensaje del commit');
  assert.match(src, /tipo\s*\n?\s*\?\s*PISTAS_ARREGLO\.test\(String\(tipo\)\)/,
    'con tipo declarado, solo el tipo decide si es un arreglo');
});

test('un cambio que no toca producción no molesta', () => {
  const r = cg.revisar(RAIZ, { files: ['README.md'], tipo: 'fix' });
  assert.equal(r.veredicto, 'PASS');
});

test('reconoce las formas habituales de nombrar un test', () => {
  for (const f of ['test/x.test.cjs', 'src/__tests__/y.js', 'spec/z_spec.rb',
                   'app/foo.spec.ts', 'tests/e2e/login.js', 'test_algo.py']) {
    assert.ok(cg.ES_TEST.test(f), `debería reconocer ${f} como test`);
  }
  for (const f of ['src/index.ts', 'lib/testing-utils.ts']) {
    assert.ok(!cg.ES_TEST.test(f), `${f} no es un archivo de test`);
  }
});

test('post-cycle lo invoca de verdad', () => {
  /* El pecado que este sprint persigue: un control construido que nadie llama.
     El canario-gate existió un rato exactamente así. */
  const pc = fs.readFileSync(
    path.join(RAIZ, '.agentic', 'grafo', 'post-cycle.cjs'), 'utf8');
  assert.match(pc, /canario-gate\.cjs/,
    'post-cycle debe invocar el canario: construido y no llamado protege cero');
  assert.match(pc, /cgRes\.veredicto === 'STOP'/,
    'debe leer el veredicto que el gate realmente devuelve, no uno inventado');
});

test('el pre-commit también lo corre', () => {
  const hook = fs.readFileSync(
    path.join(RAIZ, '.agentic', 'grafo', 'git-hooks', 'pre-commit'), 'utf8');
  assert.match(hook, /canario-gate\.cjs/,
    'el commit es el momento en que el arreglo entra al repo: ahí tiene que mirar');
});
