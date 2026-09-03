/**
 * El registro de contratos no puede abortar porque el sistema se ensucia solo.
 *
 * EL CASO REAL (03/09/2026, este mismo repo)
 * ------------------------------------------
 * `akdd health` decía «61 ciclos y 0 contratos». Había 99 tests verdes y el
 * Preservation Gate no protegía nada. Dos causas encadenadas, las dos de la
 * misma familia: **el sistema se saboteaba con sus propios residuos.**
 *
 * 1 · El scope venía de git y el único archivo modificado era
 *     `_output/log-2026-09.md` — el registro que EL PROPIO post-cycle escribe
 *     al terminar. Con el scope no vacío, el buscador rastreaba `_output/`,
 *     no encontraba tests, y abortaba con «No se encontraron archivos de
 *     test» en un repo con 17 archivos de test.
 *
 *     Ya había pasado antes con `.agentic/` (FLOTA360, 2026-07-19) y se
 *     parcheó con una lista negra de carpetas. Volvió a pasar porque
 *     `_output/` no estaba en ella. Por eso ahora es lista BLANCA: siempre
 *     aparece una carpeta que nadie pensó, pero lo que no es código nunca
 *     tiene tests relacionados.
 *
 * 2 · Y aunque el scope se arreglara, el comando de test declarado en
 *     `.agentic/config.md` seguía siendo `node bin/akdd.js --version` — el
 *     print de versión disfrazado de suite. El gate lee config.md ANTES que
 *     package.json, así que arreglar el package.json no le llegaba.
 *
 * Con las dos cerradas: 0 contratos → 99 tests registrados.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const gate = require('../.agentic/grafo/tdd-gate.cjs');
const RAIZ = path.join(__dirname, '..');

/* ── 1 · el scope ──────────────────────────────────────────────────────────── */

test('un scope de solo documentación queda vacío, no roto', () => {
  /* Vacío significa "escanea el proyecto entero", que es lo correcto para un
     árbol limpio. Dejar el .md dentro es lo que abortaba el gate. */
  assert.deepEqual(gate.filtrarScope(['_output/log-2026-09.md']), []);
  assert.deepEqual(gate.filtrarScope(['README.md', 'docs/guia.md', 'CHANGELOG.md']), []);
});

test('el residuo que el propio sistema escribe no cuenta como cambio', () => {
  /* `_output/` lo escribe el post-cycle; `.agentic/memoria.db` lo escribe el
     gate al correr. Que el sistema se sabotee con su propia basura es el fallo
     que se repitió dos veces. */
  const r = gate.filtrarScope([
    '_output/log-2026-09.md',
    '.agentic/memoria.db',
    '.claude/settings.json',
    'src/de-verdad.ts',
  ]);
  assert.deepEqual(r, ['src/de-verdad.ts']);
});

test('el código sí pasa, en los lenguajes que el motor soporta', () => {
  const entrada = ['a.ts', 'b.tsx', 'c.js', 'd.cjs', 'e.py', 'f.go', 'g.sql', 'h.vue'];
  assert.deepEqual(gate.filtrarScope(entrada), entrada);
});

test('el filtro es lista BLANCA, no negra', () => {
  /* La lista negra por carpeta falló dos veces y por el mismo motivo las dos:
     siempre aparece una carpeta que nadie pensó. Una extensión desconocida no
     puede colarse. */
  assert.deepEqual(gate.filtrarScope(['carpeta-que-nadie-penso/cosa.log']), []);
  assert.deepEqual(gate.filtrarScope(['salida/reporte.html']), [],
    'un .html no tiene tests relacionados');
});

test('sin scope no revienta', () => {
  assert.deepEqual(gate.filtrarScope([]), []);
  assert.deepEqual(gate.filtrarScope(null), []);
  assert.deepEqual(gate.filtrarScope(undefined), []);
});

/* ── 2 · el comando de test declarado ──────────────────────────────────────── */

test('config.md no declara un print de versión como suite', () => {
  /* El gate lee config.md ANTES que package.json. Arreglar el package.json no
     le llega: hay que arreglar los dos, y este test vigila el que se olvida. */
  const cfg = fs.readFileSync(path.join(RAIZ, '.agentic', 'config.md'), 'utf8');
  const m = cfg.match(/^[^\S\n]*test:[^\S\n]*(\S.*)$/m);
  assert.ok(m, 'config.md debe declarar un comando de test');

  const cmd = m[1].trim();
  assert.ok(!/--version/.test(cmd),
    `config.md declara "${cmd}" — un print de versión no ejecuta ninguna aserción, ` +
    'y el gate lo daría por bueno con 0 tests, dejando 0 contratos registrados');
});

test('el comando declarado y el de package.json no se contradicen', () => {
  const cfg = fs.readFileSync(path.join(RAIZ, '.agentic', 'config.md'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8'));
  const declarado = (cfg.match(/^[^\S\n]*test:[^\S\n]*(\S.*)$/m) || [])[1];
  assert.ok(declarado, 'config.md debe declarar el comando');

  /* Si config.md dice `npm test`, el que manda es el script de package.json y
     los dos apuntan al mismo sitio. Cualquier otra cosa tiene que ser un
     corredor de verdad, no un eco. */
  const esDelegacion = /^npm (run )?test$/.test(declarado.trim());
  assert.ok(esDelegacion || /--test|run-tests|jest|vitest|pytest|mocha/.test(declarado),
    `"${declarado}" no parece un corredor de tests`);
  assert.ok(!/--version/.test(pkg.scripts.test || ''),
    'package.json tampoco puede declarar un print de versión');
});

/* ── 3 · canario del efecto ────────────────────────────────────────────────── */

test('el CLI usa el filtro, no una copia suya', () => {
  /* Si alguien vuelve a escribir el filtro a mano en el bloque del CLI, este
     test no lo detectaría por sí solo — pero sí detecta que se dejó de usar la
     función, que es como se pierde la corrección. */
  const src = fs.readFileSync(path.join(RAIZ, '.agentic', 'grafo', 'tdd-gate.cjs'), 'utf8');
  const codigo = src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  assert.match(codigo, /scope\s*=\s*filtrarScope\(scope\)/,
    'el comando `run` debe filtrar el scope antes de buscar tests');
});
