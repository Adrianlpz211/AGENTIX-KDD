'use strict';

/**
 * Path Norm — Agentic KDD v3.14 (Plan 6, C2: higiene Windows)
 *
 * El helper CANÓNICO para las tres trampas de Windows que este proyecto ya
 * pisó en vivo (2026-07-15):
 *   1. La BD guarda file-keys con \ (path.relative en Windows) pero el código
 *      compara con / — dualKeys() da ambas formas para lookups.
 *   2. Comparar rutas sin normalizar separador — norm() a / siempre.
 *   3. Reescribir archivos reconstruyendo con '\n' sobre contenido CRLF —
 *      con autocrlf=true git declara el archivo ENTERO cambiado (medido:
 *      la contención veía todo como HIT). eolOf() da el EOL a preservar.
 *
 * Auditoría del 2026-07-16: el motor actual NO tiene ofensores vivos (la
 * disciplina de los Planes 1-5 ya normalizaba en cada sitio). Este módulo
 * existe para que el código FUTURO tenga un solo lugar correcto al cual
 * llamar en vez de reinventar el patrón inline.
 */

/** Ruta con separador / — para comparar, SIEMPRE. */
function norm(p) {
  return String(p == null ? '' : p).replace(/\\/g, '/');
}

/** Ambas formas de una ruta relativa — para lookups contra la BD
 *  (ast_symbols.file se guarda con el separador del SO). */
function dualKeys(p) {
  const s = String(p == null ? '' : p);
  return [...new Set([s, s.replace(/\\/g, '/'), s.replace(/\//g, '\\')])];
}

/** EOL dominante de un contenido — para reescrituras que lo preservan. */
function eolOf(content) {
  return String(content == null ? '' : content).includes('\r\n') ? '\r\n' : '\n';
}

/** Igualdad de rutas ignorando separador y mayúsculas (Windows-insensible). */
function samePath(a, b) {
  return norm(a).toLowerCase() === norm(b).toLowerCase();
}

module.exports = { norm, dualKeys, eolOf, samePath };
