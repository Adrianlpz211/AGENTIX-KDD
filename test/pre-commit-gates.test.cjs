/**
 * El pre-commit bloquea lo CRÍTICO y no estorba con lo demás.
 *
 * Hasta v3.18 el hook llamaba a security-gate con `2>/dev/null` y luego hacía
 * `exit 0` incondicional. El gate encontraba una llave privada, salía con
 * código 1 — y el hook se lo tragaba. Gritaba y nadie lo escuchaba.
 *
 * La v1 decía «la escalada a bloqueo se gana con datos». El dato es que
 * `passed:false` en security-gate.cjs ocurre EXACTAMENTE y SOLO cuando hay
 * hallazgos CRITICAL: secretos filtrados, fugas cross-tenant y bypass de JWT.
 * No hay caso legítimo para commitear ninguno de los tres.
 *
 * Estos tests vigilan las cuatro propiedades que hacen que el hook sea útil y
 * no un estorbo. Si se pierde una, el hook deja de servir:
 *   1. lo limpio pasa            (si no, se desactiva en un día)
 *   2. lo CRÍTICO bloquea        (si no, es decorativo)
 *   3. los avisos NO bloquean    (si no, se desactiva en una semana)
 *   4. hay escotilla documentada (si no, alguien borra el hook entero)
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const HOOK = path.join(__dirname, '..', '.agentic', 'grafo', 'git-hooks', 'pre-commit');
const hook = fs.readFileSync(HOOK, 'utf8');

test('el hook NO se traga el código de salida del security-gate', () => {
  /* El bug original: `node security-gate.cjs $STAGED 2>/dev/null` seguido de
     `exit 0`. El redirect a /dev/null en la línea del security-gate es la
     firma de que su veredicto se está descartando. */
  const lineaGate = hook.split('\n').find((l) => /security-gate\.cjs/.test(l) && !/^\s*#/.test(l));
  assert.ok(lineaGate, 'el hook debe invocar security-gate.cjs');
  assert.ok(!/2>\/dev\/null/.test(lineaGate),
    'security-gate no puede invocarse con 2>/dev/null: se descartaría su veredicto');
});

test('el hook comprueba el código de salida y puede bloquear', () => {
  assert.match(hook, /if \[ \$\? -ne 0 \]/,
    'debe comprobar el código de salida del security-gate');
  assert.match(hook, /exit 1/,
    'debe existir una salida con código 1 — sin eso no bloquea nada');
});

test('solo bloquea por el security-gate, no por los avisos', () => {
  /* spec-value-scan, test-integrity-gate y ui-native-gate son WARN: informan y
     siguen. Un hook que grita por todo se desactiva, y al desactivarlo se
     pierde también el bloqueo que sí importa. */
  for (const aviso of ['spec-value-scan', 'test-integrity-gate', 'ui-native-gate']) {
    const linea = hook.split('\n').find((l) => l.includes(aviso + '.cjs') && !/^\s*#/.test(l));
    assert.ok(linea, 'el hook debe invocar ' + aviso);
    assert.ok(!/BLOQUEO=1/.test(linea),
      aviso + ' es un aviso: no puede marcar bloqueo');
  }
});

test('ui-native-gate corre en el hook, no solo en la prosa de CLAUDE.md', () => {
  /* La regla «nunca diálogos nativos del navegador» vivía solo como texto en
     CLAUDE.md: dependía de que el modelo la leyera. Con Cursor en un modelo de
     reserva, eso es una lotería. Ahora corre siempre. */
  assert.match(hook, /ui-native-gate\.cjs/,
    'ui-native-gate debe invocarse desde el pre-commit');
});

test('hay una escotilla documentada para saltar los gates', () => {
  assert.match(hook, /AKDD_SKIP_GATES/,
    'debe existir una variable de escape explícita');
  assert.match(hook, /AKDD_SKIP_GATES.*=.*"1"|AKDD_SKIP_GATES.*=.*1/,
    'la escotilla debe comprobarse de verdad, no solo mencionarse');
});

test('el mensaje de bloqueo dice qué pasó y qué hacer', () => {
  /* Un error que no explica cómo salir del paso hace que la gente borre el
     hook en vez de arreglar el problema. */
  assert.match(hook, /BLOQUEADO/, 'el mensaje debe decir que el commit se bloqueó');
  assert.match(hook, /AKDD_SKIP_GATES=1 git commit/,
    'el mensaje debe incluir el comando exacto de la escotilla');
});
