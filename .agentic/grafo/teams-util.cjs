'use strict';

/**
 * Utilidades compartidas por la capa TEAMS v2 (correcciones, revisores, cierre, canal). Sin dependencia del manager,
 * para que cualquiera de esos módulos pueda importarlas sin ciclos.
 *
 *   limpiar        texto libre (de un revisor, del constructor o de una URL) → dato: sin secretos, sin forjar delimitadores
 *                  del canal, acotado. Nunca es una instrucción.
 *   hashArchivos   hash del contenido de un conjunto de archivos dentro de la raíz (el "sujeto"), estable y sin sorpresas.
 *   localizar      reubica una observación cuando las líneas se movieron: por símbolo o por contenido, no por número obsoleto.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const sha = (v) => crypto.createHash('sha256').update(typeof v === 'string' || Buffer.isBuffer(v) ? v : JSON.stringify(v)).digest('hex');
const normRel = (f) => String(f || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');

/** Ruta absoluta SOLO si cae dentro de la raíz del proyecto. Cualquier otra cosa (.., absolutas ajenas) es null. */
function dentroDeRaiz(root, rel) {
  const r = String(rel || '');
  if (!r || r.includes('\0')) return null;
  const abs = path.resolve(root, r);
  const base = path.resolve(root);
  return abs === base || abs.startsWith(base + path.sep) ? abs : null;
}

/* Caracteres de control e invisibles (incluye los de dirección de texto): se construye por códigos para que el archivo no los contenga. */
const CONTROL = new RegExp('[' + [[0, 8], [11, 12], [14, 31], [127, 127], [0x200b, 0x200f], [0x2028, 0x2029], [0x202a, 0x202e], [0x2066, 0x2069]]
  .map(([a, b]) => String.fromCharCode(a) + (a === b ? '' : '-' + String.fromCharCode(b))).join('') + ']', 'g');

/**
 * Texto libre → dato seguro. Redacta secretos y datos personales con la política de privacidad del proyecto (si la
 * redacción falla, NO se devuelve el original), neutraliza los delimitadores de los envoltorios del canal para que un
 * texto no pueda forjar un mensaje, quita caracteres de control y acota el tamaño.
 */
function limpiar(root, v, max = 600) {
  let t = String(v == null ? '' : v);
  try {
    const privacy = require('./memory-privacy.cjs');
    const r = privacy.redactar(t, privacy.cargarPolitica(root));
    t = r === privacy.FALLO ? '[REDACCION_FALLIDA]' : r;
  } catch { t = '[REDACCION_NO_DISPONIBLE]'; }
  t = t.replace(CONTROL, '')
    .replace(/<<<\s*AKDD-TEAMS/gi, '‹‹‹AKDD-TEAMS').replace(/AKDD-TEAMS\s*>>>/gi, 'AKDD-TEAMS›››')
    .replace(/<!--/g, '‹!--').replace(/-->/g, '--›');
  return t.length > max ? t.slice(0, max) + '…' : t;
}

/** Una línea, para tablas y listas del canal: sin saltos, sin barras que rompan la tabla, sin encabezados forjados. */
function linea(root, v, max = 160) {
  return limpiar(root, v, max).replace(/\s+/g, ' ').replace(/\|/g, '¦').replace(/^[#>*\-+\s]+/, '').trim();
}

/** Hash del sujeto: contenido de los archivos pedidos (ordenados, sin duplicados). Un archivo ausente cuenta como 'ausente'. */
function hashArchivos(root, files) {
  const unicos = [...new Set((files || []).map(normRel).filter(Boolean))].sort();
  const lineas = unicos.map((f) => {
    const abs = dentroDeRaiz(root, f);
    let h = 'ausente';
    if (abs) { try { h = sha(fs.readFileSync(abs)); } catch { h = 'ausente'; } }
    return f + ':' + h;
  });
  return sha(lineas.join('\n'));
}

/** Hash por archivo (para guardar posición exacta al suspender una tarea). */
function hashesPorArchivo(root, files) {
  return [...new Set((files || []).map(normRel).filter(Boolean))].sort().map((f) => {
    const abs = dentroDeRaiz(root, f);
    let h = null;
    if (abs) { try { h = sha(fs.readFileSync(abs)); } catch { h = null; } }
    return { file: f, hash: h };
  });
}

const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Reubica una observación `{ file, line, symbol, snippet, snippet_hash, file_hash }` en el archivo ACTUAL.
 *  · mismo hash de archivo → la línea sigue valiendo;
 *  · cambió → se busca por símbolo (declaración) y, si no, por el contenido de la línea observada;
 *  · no aparece → NO_ENCONTRADO: no se parchea a ciegas sobre una línea obsoleta.
 */
function localizar(root, loc) {
  const l = loc || {};
  const abs = dentroDeRaiz(root, l.file);
  if (!abs) return { status: 'FUERA_DE_RAIZ' };
  let txt;
  try { txt = fs.readFileSync(abs, 'utf8'); } catch { return { status: 'ARCHIVO_AUSENTE' }; }
  if (l.file_hash && sha(txt) === l.file_hash) return { status: 'SIN_CAMBIOS', line: l.line || null };
  const lineas = txt.split(/\r?\n/);
  if (l.symbol && /^[\w$.]{1,80}$/.test(String(l.symbol))) {
    const s = escRe(l.symbol);
    const decl = new RegExp(`(^|[\\s;(,{])(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function\\*?|class|const|let|var|def|fn|func)\\s+${s}\\b|^\\s*(?:async\\s+)?${s}\\s*(?:\\(|[:=])`);
    let i = lineas.findIndex((x) => decl.test(x));
    let por = 'simbolo';
    if (i < 0) { i = lineas.findIndex((x) => new RegExp(`\\b${s}\\b`).test(x)); por = 'simbolo-uso'; }
    if (i >= 0) return { status: 'REUBICADO', line: i + 1, por, desplazamiento: l.line ? i + 1 - Number(l.line) : null };
  }
  const objetivo = l.snippet ? String(l.snippet).split(/\r?\n/).map((x) => x.trim()).find(Boolean) : null;
  if (objetivo) {
    const i = lineas.findIndex((x) => x.trim() === objetivo);
    if (i >= 0) return { status: 'REUBICADO', line: i + 1, por: 'contenido', desplazamiento: l.line ? i + 1 - Number(l.line) : null };
  }
  if (l.snippet_hash) {
    const i = lineas.findIndex((x) => x.trim() && sha(x.trim()) === l.snippet_hash);
    if (i >= 0) return { status: 'REUBICADO', line: i + 1, por: 'hash', desplazamiento: l.line ? i + 1 - Number(l.line) : null };
  }
  return { status: 'NO_ENCONTRADO' };
}

/** Argumentos de CLI: `--k=v` y `--flag`; el resto, posicionales. Las claves con guion pasan a guion bajo. */
function parseArgs(argv) {
  const opt = {};
  const pos = [];
  for (const a of argv) {
    const m = /^--([^=]+)(?:=([\s\S]*))?$/.exec(a);
    if (m) {
      const k = m[1].replace(/-/g, '_');
      const v = m[2] === undefined ? true : m[2];
      /* Una opción repetida (--hallazgo=... --hallazgo=...) se acumula en lista. */
      opt[k] = k in opt ? [].concat(opt[k], v) : v;
    }
    else pos.push(a);
  }
  return { opt, pos };
}

/** Lista desde "a,b,c" (CLI) o arreglo (API). */
const lista = (v) => (Array.isArray(v) ? v.map(String) : (v == null || v === true || v === '' ? [] : String(v).split(',').map((x) => x.trim()).filter(Boolean)));

module.exports = { sha, normRel, dentroDeRaiz, limpiar, linea, hashArchivos, hashesPorArchivo, localizar, parseArgs, lista };
