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
/* Un archivo más grande que esto NO se lee: su huella es tamaño + fecha de modificación, y no gasta presupuesto de bytes. Caso real (medinet, octubre 2026): un
   `repomix-output.xml` de 122 MB en la raíz superaba el tope de 100 MB y la huella salía SIEMPRE incompleta: toda verificación terminaba UNVERIFIED y no
   nació ningún contrato en 10 días (12 en total), con el motor creativo sin datos que mover. Un volcado o un binario enorme no es código que pruebas ejerciten. */
const GRANDE = 2 * 1024 * 1024;

const hashDeArchivos = (files) => crypto.createHash('sha256').update(JSON.stringify(Object.entries(files).sort((a, b) => a[0].localeCompare(b[0])))).digest('hex');

function capture(root, opts) {
  const o = opts || {}, grande = Number.isFinite(o.grande) ? o.grande : GRANDE, maxBytes = Number.isFinite(o.maxBytes) ? o.maxBytes : MAX_BYTES, maxArchivos = Number.isFinite(o.maxArchivos) ? o.maxArchivos : MAX_ARCHIVOS;
  const files = {}, base = path.resolve(root); let size = 0, complete = true, motivo = null, nArch = 0;
  // Caché de huellas por archivo (tamaño + fecha → hash): solo se vuelve a leer lo que cambió. En medinet la captura leía ~40 MB en cada una de las dos
  // capturas de cada corrida (hasta 50 s con la máquina cargada); con la caché son milisegundos. Una edición cambia la fecha: se detecta igual.
  const rutaCache = path.join(base, '.agentic', '_cache', 'huella-v1.json');
  const usarCache = o.cache !== false && fs.existsSync(path.join(base, '.agentic'));
  let viejo = {}; const nuevo = {};
  if (usarCache) { try { const j = JSON.parse(fs.readFileSync(rutaCache, 'utf8')); if (j && j.v === 1 && j.f) viejo = j.f; } catch { /* sin caché: se lee todo */ } }
  function walk(dir) {
    let entradas;
    try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { if (!e || e.code !== 'ENOENT') { complete = false; motivo = 'directorio ilegible: ' + path.relative(base, dir).split(path.sep).join('/') + ' (' + ((e && e.code) || 'error') + ')'; } return; }
    for (const e of entradas) {
      if (!complete) return;
      const abs = path.join(dir, e.name), rel = path.relative(base, abs).split(path.sep).join('/');
      if (rel.startsWith('.agentic/') && !['.agentic/grafo', '.agentic/agentes'].some((p) => rel === p || rel.startsWith(p + '/')) && !['.agentic/nucleo-reglas.md', '.agentic/config.md', '.agentic/protected_files', '.agentic/effort-policy.json'].includes(rel)) continue;
      if (e.isDirectory()) {
        if (ignored.has(e.name) || e.name.startsWith('brag-output') || (rel.startsWith('.agentic/') && (/^\.agentic\/_/.test(rel) || ['.agentic/memoria', '.agentic/telemetria'].some((p) => rel === p)))) continue;
        walk(abs);
      } else if (e.isFile() && !/^browser-gate-.*\.png$|^visual-diff-.*\.png$/.test(e.name) && !/\.(?:db|sqlite|sqlite3)(?:-wal|-shm)?$|\.bak-\d+$|\.log$|\.tsbuildinfo$/.test(e.name) && !/^\.agentic\/_(?:.*)/.test(rel)) {
        let st; try { st = fs.statSync(abs); } catch { continue; }   // desapareció entre listar y leer: lo verá `diff`
        if (st.size > grande) { files[rel] = 'grande:' + st.size + ':' + Math.floor(st.mtimeMs); nArch++; continue; }
        const previo = viejo[rel];
        if (previo && previo.s === st.size && previo.m === st.mtimeMs) { files[rel] = previo.h; nuevo[rel] = previo; nArch++; continue; }
        let b;
        try { b = fs.readFileSync(abs); } catch { continue; } // desapareció entre listar y leer: no es «incompleto», es un cambio que `diff` verá
        size += b.length;
        if (nArch >= maxArchivos || size > maxBytes) { complete = false; motivo = nArch >= maxArchivos ? 'más de ' + maxArchivos + ' archivos' : 'más de ' + Math.round(maxBytes / 1048576) + ' MB de archivos de tamaño normal'; return; }
        const h = crypto.createHash('sha256').update(b).digest('hex'); files[rel] = h; nuevo[rel] = { s: st.size, m: st.mtimeMs, h }; nArch++;
      }
    }
  }
  try { walk(base); } catch (e) { complete = false; motivo = 'error al recorrer: ' + String((e && e.message) || e).slice(0, 80); }
  if (usarCache && complete) {
    try { fs.mkdirSync(path.dirname(rutaCache), { recursive: true }); const tmp = rutaCache + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ v: 1, f: nuevo })); fs.renameSync(tmp, rutaCache); } catch { /* sin caché: la próxima captura lee todo */ }
  }
  return { files, complete, motivo, hash: hashDeArchivos(files) };
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
