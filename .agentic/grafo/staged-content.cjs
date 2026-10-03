'use strict';

/**
 * Lo que de verdad se va a commitear: el ÍNDICE, no el worktree.
 *
 * Todas las llamadas a git van por argv y con -z (separador NUL): un archivo
 * con espacios, comillas, `$()` o Unicode es un dato, nunca un comando. Ningún
 * contenido staged se ejecuta; solo se lee como texto.
 */

const { spawnSync } = require('child_process');

const MAX_BUF = 256 * 1024 * 1024;

function git(root, args, binario) {
  const r = spawnSync('git', args, { cwd: root, maxBuffer: MAX_BUF, windowsHide: true });
  if (r.error) return { ok: false, error: r.error.message, stdout: Buffer.alloc(0) };
  return { ok: r.status === 0, status: r.status, stdout: r.stdout, stderr: r.stderr ? r.stderr.toString('utf8') : '' };
}

/**
 * Entradas staged: [{ status, path, from? }]
 *   status A|M|D|R|C|T (T = cambio de tipo/modo). Rename/copy traen `from`.
 */
function entradas(root) {
  const r = git(root, ['diff', '--cached', '--name-status', '-z', '-M', '--no-color']);
  if (!r.ok) return { ok: false, error: r.stderr || r.error, items: [] };
  const partes = r.stdout.toString('utf8').split('\0');
  const items = [];
  for (let i = 0; i < partes.length;) {
    const st = partes[i++];
    if (!st) continue;
    const letra = st[0];
    if (letra === 'R' || letra === 'C') {
      items.push({ status: letra, from: partes[i++], path: partes[i++], score: st.slice(1) });
    } else {
      items.push({ status: letra, path: partes[i++] });
    }
  }
  return { ok: true, items };
}

/** Rutas con conflicto de merge sin resolver (etapas 1-3 en el índice). */
function conflictos(root) {
  const r = git(root, ['ls-files', '-u', '-z']);
  if (!r.ok) return [];
  const rutas = new Set();
  for (const linea of r.stdout.toString('utf8').split('\0')) {
    const tab = linea.indexOf('\t');
    if (tab !== -1) rutas.add(linea.slice(tab + 1));
  }
  return [...rutas];
}

/** Contenido del blob en el índice. → { ok, buffer, binary, size } */
function leer(root, ruta) {
  const r = git(root, ['cat-file', 'blob', ':' + ruta]);
  if (!r.ok) return { ok: false, error: r.stderr || r.error };
  const buf = r.stdout;
  const muestra = buf.subarray(0, 8000);
  return { ok: true, buffer: buf, size: buf.length, binary: muestra.includes(0) };
}

/** Hash del árbol que tendría el commit: la evidencia de "sobre qué se revisó". */
function treeDelIndice(root) {
  const r = git(root, ['write-tree']);
  return r.ok ? r.stdout.toString('utf8').trim() : null;
}

module.exports = { entradas, conflictos, leer, treeDelIndice, git };
