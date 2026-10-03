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

const fs = require('fs');
const path = require('path');

/** Windows y macOS comparan sin mayúsculas; Linux no. */
const FS_INSENSIBLE = process.platform === 'win32' || process.platform === 'darwin';
const clave = (p) => (FS_INSENSIBLE ? norm(p).toLowerCase() : norm(p));

function realpath(p) {
  try { return fs.realpathSync.native(p); } catch { return null; }
}

/**
 * Ruta real de `p`, aunque todavía no exista: se resuelve el ancestro más
 * cercano que sí existe (con enlaces y junctions) y se le pega el resto.
 */
function rutaReal(abs) {
  let actual = abs;
  const resto = [];
  for (;;) {
    const r = realpath(actual);
    if (r) return resto.length ? path.join(r, ...resto.reverse()) : r;
    const padre = path.dirname(actual);
    if (padre === actual) return null;
    resto.push(path.basename(actual));
    actual = padre;
  }
}

/** `hijo` está dentro de `padre` (o es él), comparando por segmentos. */
function dentroDe(hijo, padre) {
  const rel = path.relative(padre, hijo);
  if (rel === '') return true;
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Resuelve `p` contra la raíz del proyecto.
 *   { ok:true, abs, rel }  dentro del proyecto (rel con /)
 *   { ok:false, reason }   ESCAPE (sale de la raíz, por .., absoluta o enlace),
 *                          INVALID (vacía o con byte nulo), NO_ROOT
 */
function resolverEnRaiz(raiz, p) {
  const s = String(p == null ? '' : p);
  if (!s.trim() || s.includes('\0')) return { ok: false, reason: 'INVALID', input: s };
  const raizReal = realpath(raiz);
  if (!raizReal) return { ok: false, reason: 'NO_ROOT', input: s };
  const abs = path.resolve(raizReal, s);
  if (!dentroDe(abs, raizReal)) return { ok: false, reason: 'ESCAPE', input: s };
  const real = rutaReal(abs);
  if (!real || !dentroDe(real, raizReal)) return { ok: false, reason: 'ESCAPE', input: s, via: 'link' };
  return { ok: true, abs: real, rel: norm(path.relative(raizReal, real)), input: s };
}

/**
 * ¿`rel` está permitido por la lista? Una entrada que termina en `/` o que es
 * un directorio existente cubre su contenido por segmentos; si no, es un
 * archivo exacto (`auth.ts` no cubre `auth.ts.bak`).
 */
function permitido(raiz, rel, lista) {
  const k = clave(rel);
  for (const entrada of lista || []) {
    const r = resolverEnRaiz(raiz, entrada);
    if (!r.ok) continue;
    const ke = clave(r.rel);
    let esDir = /[\\/]$/.test(String(entrada));
    if (!esDir) { try { esDir = fs.statSync(r.abs).isDirectory(); } catch { esDir = false; } }
    if (k === ke) return true;
    if (esDir && (ke === '' || k.startsWith(ke + '/'))) return true;
  }
  return false;
}

module.exports = { norm, dualKeys, eolOf, samePath, resolverEnRaiz, permitido, dentroDe, rutaReal, clave, FS_INSENSIBLE };
