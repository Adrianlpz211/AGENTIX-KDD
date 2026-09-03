'use strict';

/**
 * Un solo sitio donde se decide con qué driver de SQLite corre un test.
 *
 * POR QUÉ EXISTE
 * --------------
 * El CI corre en Node 20 y 22. `node:sqlite` no existe en Node 20 y en 22 aún
 * es experimental, así que tres tests que hacían `require('node:sqlite')` a
 * pelo tumbaban la suite entera en la matriz de Node 20. No porque el código
 * estuviera mal: porque el entorno no tenía el driver.
 *
 * Eso salió a la luz al arreglar otra cosa peor: el `npm test` del proyecto era
 * `akdd --version` — un print de versión disfrazado de tests. El CI llevaba
 * meses en verde sin ejecutar una sola aserción.
 *
 * LA REGLA
 * --------
 * Un test que no puede correr por falta de driver se OMITE con su motivo a la
 * vista. No se pone rojo. Un rojo de entorno enseña a la gente a ignorar los
 * rojos, y el día que uno sea de verdad nadie lo mira.
 *
 *   const { abrir, motivoSinDriver } = require('./helpers/sqlite.cjs');
 *   test('lo que sea', (t) => {
 *     const db = abrir(archivo);
 *     if (!db) return t.skip(motivoSinDriver());
 *     ...
 *   });
 */

/** El driver disponible, en orden de preferencia. */
function driver() {
  try {
    const BS3 = require('better-sqlite3');
    return { nombre: 'better-sqlite3', abrir: (f) => new BS3(f) };
  } catch {}
  try {
    const { DatabaseSync } = require('node:sqlite');
    /* En Node 22 el módulo existe pero puede necesitar bandera: se comprueba
       abriendo de verdad, no mirando la versión. */
    return { nombre: 'node:sqlite', abrir: (f) => new DatabaseSync(f) };
  } catch {}
  return null;
}

const D = driver();

/** Abre (o crea) una base. Devuelve null si este Node no puede. */
function abrir(archivo) {
  if (!D) return null;
  try { return D.abrir(archivo); } catch { return null; }
}

const disponible = () => !!D;
const nombreDriver = () => (D ? D.nombre : null);

const motivoSinDriver = () =>
  'sin driver de SQLite en este Node (' + process.version +
  '): node:sqlite llegó en Node 22 y better-sqlite3 no está instalado. ' +
  'El test se omite a propósito — un rojo de entorno enseña a ignorar los rojos.';

module.exports = { abrir, disponible, nombreDriver, motivoSinDriver };
