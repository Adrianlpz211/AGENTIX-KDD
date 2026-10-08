'use strict';
/**
 * Huella del árbol de código: sha256 de cada archivo + un hash global. Es la base de «¿cambió algo mientras corrían las pruebas?».
 *
 * Cambios respecto a la versión anterior (caso medinet: ~1.600 pruebas y un constructor editando sin parar, casi todos los ciclos
 * terminaban «UNVERIFIED (SOURCE_CHANGED_OR_INCOMPLETE)» y solo 12 contratos llegaron a existir):
 *   · un archivo que desaparece entre listar y leer (el swap/tmp de un editor o de un agente) YA NO aborta todo el recorrido
 *     con complete=false: se omite, y la diferencia entre dos huellas lo cuenta como lo que es (añadido o borrado);
 *   · no se hashean carpetas generadas por herramientas (test-results, playwright-report, .turbo, out, storybook-static,
 *     brag-output*) ni *.tsbuildinfo: el propio runner las reescribe y daban «cambios» falsos;
 *   · `diff(antes, despues)` devuelve QUÉ archivos cambiaron, no solo «hash distinto».
 */
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const ignored = new Set(['node_modules', '.git', '.next', '.nuxt', '.venv', 'venv', 'dist', 'build', 'coverage', '_output', '.model_cache', '__pycache__', '_hooks', '_cache',
  'test-results', 'playwright-report', '.turbo', 'out', 'storybook-static']);
const MAX_ARCHIVOS = 20000, MAX_BYTES = 100 * 1024 * 1024;

const hashDeArchivos = (files) => crypto.createHash('sha256').update(JSON.stringify(Object.entries(files).sort((a, b) => a[0].localeCompare(b[0])))).digest('hex');

function capture(root) {
  const files = {}, base = path.resolve(root); let size = 0, complete = true;
  function walk(dir) {
    let entradas;
    try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { if (!e || e.code !== 'ENOENT') complete = false; return; }
    for (const e of entradas) {
      if (!complete) return;
      const abs = path.join(dir, e.name), rel = path.relative(base, abs).split(path.sep).join('/');
      if (rel.startsWith('.agentic/') && !['.agentic/grafo', '.agentic/agentes'].some((p) => rel === p || rel.startsWith(p + '/')) && !['.agentic/nucleo-reglas.md', '.agentic/config.md', '.agentic/protected_files', '.agentic/effort-policy.json'].includes(rel)) continue;
      if (e.isDirectory()) {
        if (ignored.has(e.name) || e.name.startsWith('brag-output') || (rel.startsWith('.agentic/') && (/^\.agentic\/_/.test(rel) || ['.agentic/memoria', '.agentic/telemetria'].some((p) => rel === p)))) continue;
        walk(abs);
      } else if (e.isFile() && !/^browser-gate-.*\.png$|^visual-diff-.*\.png$/.test(e.name) && !/\.(?:db|sqlite|sqlite3)(?:-wal|-shm)?$|\.bak-\d+$|\.log$|\.tsbuildinfo$/.test(e.name) && !/^\.agentic\/_(?:.*)/.test(rel)) {
        let b;
        try { b = fs.readFileSync(abs); } catch { continue; } // desapareció entre listar y leer: no es «incompleto», es un cambio que `diff` verá
        size += b.length;
        if (Object.keys(files).length >= MAX_ARCHIVOS || size > MAX_BYTES) { complete = false; return; }
        files[rel] = crypto.createHash('sha256').update(b).digest('hex');
      }
    }
  }
  try { walk(base); } catch { complete = false; }
  return { files, complete, hash: hashDeArchivos(files) };
}

/** Archivos que difieren entre dos huellas (modificados, añadidos o borrados), ordenados. */
function diff(antes, despues) {
  const a = (antes && antes.files) || {}, b = (despues && despues.files) || {};
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort();
}

/** Huella restringida a un subconjunto de archivos (mismo formato que capture). */
function acotar(huella, rels) {
  const files = {};
  for (const r of rels) if (huella.files[r] !== undefined) files[r] = huella.files[r];
  return { files, complete: huella.complete, hash: hashDeArchivos(files), scope: 'subject' };
}

module.exports = { capture, diff, acotar, hashDeArchivos };
