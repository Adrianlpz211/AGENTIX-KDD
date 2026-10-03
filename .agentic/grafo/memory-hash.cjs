'use strict';

/**
 * Hashes de la memoria KDD — una sola definición para quien escribe y quien
 * valida.
 *
 *   dedupHash    identidad de una entrada (texto normalizado + tipo + área).
 *                Sirve para no guardar dos veces lo mismo.
 *   contextHash  huella de los archivos a los que la entrada aplica: ruta +
 *                contenido normalizado. Tamaño y fecha no cuentan: un archivo
 *                re-guardado igual no cambia, uno editado con el mismo tamaño sí.
 *
 * Los hashes llevan prefijo de versión (`v2:`). Uno sin prefijo es de antes:
 * no se sabe qué midió, así que el contexto queda UNKNOWN hasta revalidar — no
 * se da por bueno ni se invalida en bloque por el formato.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HASH_VERSION = 2;
const PREFIJO = 'v' + HASH_VERSION + ':';

function sha(texto) {
  return crypto.createHash('sha256').update(texto).digest('hex');
}

function normalizar(texto) {
  return String(texto == null ? '' : texto)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n')
    .trim();
}

function rutaRelativa(archivo, root) {
  const abs = path.isAbsolute(archivo) ? archivo : path.join(root, archivo);
  return path.relative(root, abs).split(path.sep).join('/');
}

function dedupHash(entry, tipo, area) {
  return PREFIJO + sha([normalizar(entry).toLowerCase(), tipo || '', area || ''].join('\u0000')).slice(0, 16);
}

/**
 * @returns {{ hash: string|null, estado: 'OK'|'PARTIAL'|'DELETED'|'EMPTY', faltantes: string[] }}
 */
function contextHash(archivos, projectRoot) {
  const root = projectRoot || process.cwd();
  const lista = [...new Set((archivos || []).filter(Boolean).map((a) => rutaRelativa(String(a), root)))].sort();
  if (!lista.length) return { hash: null, estado: 'EMPTY', faltantes: [] };
  const h = crypto.createHash('sha256');
  const faltantes = [];
  for (const rel of lista) {
    const abs = path.join(root, rel);
    let contenido = null;
    try { contenido = fs.readFileSync(abs, 'utf8'); } catch { /* borrado o ilegible */ }
    if (contenido === null) {
      faltantes.push(rel);
      h.update(rel + '\u0000DELETED\u0000');
    } else {
      h.update(rel + '\u0000' + sha(normalizar(contenido)) + '\u0000');
    }
  }
  const estado = faltantes.length === lista.length ? 'DELETED' : (faltantes.length ? 'PARTIAL' : 'OK');
  return { hash: PREFIJO + h.digest('hex').slice(0, 16), estado, faltantes };
}

/**
 * Compara el hash guardado con el actual.
 * @returns {'VIGENTE'|'CAMBIADO'|'DELETED'|'UNKNOWN'|'SIN_ARCHIVOS'}
 */
function compararContexto(guardado, archivos, projectRoot) {
  const actual = contextHash(archivos, projectRoot);
  if (actual.estado === 'EMPTY') return { estado: 'SIN_ARCHIVOS', actual };
  if (actual.faltantes.length) return { estado: 'DELETED', actual };
  if (!guardado || !String(guardado).startsWith(PREFIJO)) return { estado: 'UNKNOWN', actual };
  return { estado: guardado === actual.hash ? 'VIGENTE' : 'CAMBIADO', actual };
}

module.exports = { HASH_VERSION, normalizar, dedupHash, contextHash, compararContexto };
