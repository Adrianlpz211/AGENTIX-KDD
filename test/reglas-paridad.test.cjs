/**
 * Hueco A — CLAUDE.md y .cursorrules no pueden divergir en silencio.
 *
 * Estaban en 966 líneas contra 169. A Cursor no le llegaban MODO LEGIÓN,
 * Regression Guard, Security Gate, Spec Gate, RECOVERY, POST-CYCLE ni el Lock
 * Manager. El README prometía paridad y no existía.
 *
 * El parche habría sido actualizar .cursorrules a mano — que es exactamente lo
 * que produjo el problema: dos ficheros mantenidos a mano divergen siempre.
 *
 * El cierre es este test. La fuente es CLAUDE.md, el generador es
 * scripts/sync-rules.cjs, y aquí se regenera y se compara. Si alguien cambia
 * una regla y no ejecuta el sync, el CI se pone ROJO. No avisa: falla.
 * Un aviso se ignora; un rojo, no.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { generarCursorrules, RAIZ } = require('../scripts/sync-rules.cjs');

test('.cursorrules está al día con CLAUDE.md', () => {
  const ruta = path.join(RAIZ, '.cursorrules');
  assert.ok(fs.existsSync(ruta), '.cursorrules debe existir');

  const enDisco = fs.readFileSync(ruta, 'utf8').replace(/\r\n/g, '\n');
  const esperado = generarCursorrules();

  if (enDisco !== esperado) {
    /* Mensaje que dice qué hacer, no solo que algo falla. */
    const a = enDisco.split('\n').length;
    const e = esperado.split('\n').length;
    assert.fail(
      '.cursorrules diverge de CLAUDE.md (' + a + ' líneas en disco, ' + e + ' esperadas).\n' +
      '      Alguien cambió las reglas y no regeneró. Ejecuta:\n' +
      '        node scripts/sync-rules.cjs'
    );
  }
});

test('a Cursor le llegan las reglas operativas, no solo las de activación', () => {
  const reglas = fs.readFileSync(path.join(RAIZ, '.cursorrules'), 'utf8');

  /* Las siete que faltaban cuando se detectó el hueco. Si alguna vuelve a
     desaparecer, es que el generador dejó de propagarla. */
  const obligatorias = [
    'MODO LEGIÓN',
    'REGRESSION GUARD',
    'SECURITY GATE',
    'SPEC GATE',
    'RECOVERY',
    'POST-CYCLE',
    'LOCK MANAGER'
  ];

  const faltan = obligatorias.filter((r) => !reglas.includes(r));
  assert.deepEqual(faltan, [],
    'a Cursor no le llegan estas reglas: ' + faltan.join(', '));
});

test('el territorio del usuario NO se propaga a .cursorrules', () => {
  /* Lo que el usuario escribe es de su proyecto, no de Agentix. Si se colara
     aquí, cada `akdd update` lo repartiría a todos los destinos. */
  const reglas = fs.readFileSync(path.join(RAIZ, '.cursorrules'), 'utf8');
  assert.ok(!/^#\s*INSTRUCCIONES DEL PROYECTO/m.test(reglas),
    '.cursorrules no puede contener el bloque de instrucciones del usuario');
});

test('el generador es idempotente', () => {
  /* Dos pasadas seguidas deben dar exactamente lo mismo. Si no, el generador
     tiene estado y la comparación del primer test sería inestable. */
  assert.equal(generarCursorrules(), generarCursorrules(),
    'generar dos veces debe producir el mismo texto');
});
