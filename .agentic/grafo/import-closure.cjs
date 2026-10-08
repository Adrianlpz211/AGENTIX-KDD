'use strict';
/**
 * Cierre de imports: dado un conjunto de archivos de entrada (las pruebas y la configuración), todo lo que, por imports, pueden
 * llegar a ejecutar. Sirve para acotar la evidencia de una corrida de pruebas AL SUJETO REAL: un archivo que ninguna prueba importa
 * (una pantalla sin test que el constructor edita mientras corre la suite) no invalida lo que la suite demostró.
 *
 * Honestidad ante todo: si algún import RELATIVO o de ALIAS del proyecto no se puede resolver, o el recorrido se pasa del tope, el
 * cierre se declara INCOMPLETO y quien lo usa vuelve al comportamiento estricto (cualquier cambio invalida). Los imports de paquetes
 * (node_modules, builtins) son externos: no se rastrean. Los alias salen de tsconfig.json (`paths`/`baseUrl`) y, por defecto, de
 * `@/` y `~/` (raíz del proyecto o `src/`). Solo entiende JS/TS: un proyecto con pruebas en otro lenguaje NO es acotable.
 *
 * Límite conocido, que queda dicho: una carga dinámica con ruta calculada en tiempo de ejecución (`require(variable)`) o un archivo
 * leído por `fs` en una prueba no se ve aquí; los directorios de pruebas/fixtures completos se incluyen para cubrir lo segundo.
 */
const fs = require('fs');
const path = require('path');

const CODIGO = /\.(?:[cm]?[jt]sx?)$/i;
const EXT_RESOLVER = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json'];
const MAX_ARCHIVOS = 6000;
const RE_IMPORTS = [
  /\bimport\s+(?:[^'"`;]*?\sfrom\s+)?['"]([^'"\n]+)['"]/g,
  /\bexport\s+[^'"`;]*?\sfrom\s+['"]([^'"\n]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /\b(?:vi|jest)\.(?:mock|doMock|unmock|requireActual|importActual|importMock)\s*\(\s*['"]([^'"\n]+)['"]/g,
];
const RE_RUTA_EN_CONFIG = /['"](\.{1,2}\/[^'"\n]+)['"]/g;

function quitarComentariosJson(t) {
  return String(t).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'])\/\/[^\n]*/g, '$1').replace(/,(\s*[}\]])/g, '$1');
}

function leerAlias(root) {
  const alias = []; let baseUrl = '.';
  for (const nombre of ['tsconfig.json', 'jsconfig.json']) {
    try {
      const j = JSON.parse(quitarComentariosJson(fs.readFileSync(path.join(root, nombre), 'utf8')));
      const co = (j && j.compilerOptions) || {};
      if (co.baseUrl) baseUrl = co.baseUrl;
      for (const [patron, destinos] of Object.entries(co.paths || {})) {
        if (!Array.isArray(destinos)) continue;
        alias.push({ patron, destinos: destinos.map((d) => path.resolve(root, baseUrl, String(d))) });
      }
      break;
    } catch { /* sin tsconfig legible */ }
  }
  return { alias, baseUrl };
}

function probar(base) {
  const candidatos = [base];
  for (const e of EXT_RESOLVER) candidatos.push(base + e);
  // ESM de TypeScript: `./x.js` apunta a `./x.ts`
  const m = /\.([cm]?)jsx?$/.exec(base);
  if (m) { const sin = base.slice(0, -m[0].length); candidatos.push(sin + '.' + m[1] + 'ts', sin + '.' + m[1] + 'tsx', sin + '.ts', sin + '.tsx'); }
  for (const e of EXT_RESOLVER) candidatos.push(path.join(base, 'index' + e));
  for (const c of candidatos) { try { if (fs.statSync(c).isFile()) return c; } catch { /* siguiente */ } }
  return null;
}

/** @returns {{ abs:string }|{ externo:true }|{ sinResolver:true }} */
function resolverImport(spec, desdeAbs, ctx) {
  if (spec.startsWith('.')) { const r = probar(path.resolve(path.dirname(desdeAbs), spec)); return r ? { abs: r } : { sinResolver: true }; }
  for (const a of ctx.alias) {
    const estrella = a.patron.indexOf('*');
    const prefijo = estrella < 0 ? a.patron : a.patron.slice(0, estrella);
    const sufijo = estrella < 0 ? '' : a.patron.slice(estrella + 1);
    if (estrella < 0 ? spec === a.patron : (spec.startsWith(prefijo) && spec.endsWith(sufijo) && spec.length >= prefijo.length + sufijo.length)) {
      const resto = estrella < 0 ? '' : spec.slice(prefijo.length, spec.length - sufijo.length);
      for (const d of a.destinos) { const r = probar(d.replace('*', resto)); if (r) return { abs: r }; }
      return { sinResolver: true };
    }
  }
  if (/^[@~]\//.test(spec)) {
    const resto = spec.slice(2);
    for (const d of [path.resolve(ctx.root, resto), path.resolve(ctx.root, 'src', resto)]) { const r = probar(d); if (r) return { abs: r }; }
    return { sinResolver: true };
  }
  return { externo: true };
}

/**
 * @param {string} root
 * @param {string[]} entradas  rutas relativas (con «/»)
 * @returns {{ archivos:Set<string>, completo:boolean, sinResolver:string[], truncado:boolean }}
 */
function cierreDeImports(root, entradas, { maxArchivos = MAX_ARCHIVOS } = {}) {
  const raiz = path.resolve(root);
  const ctx = Object.assign({ root: raiz }, leerAlias(raiz));
  const vistos = new Set(); const cola = []; const sinResolver = []; let truncado = false;
  const rel = (abs) => path.relative(raiz, abs).split(path.sep).join('/');
  const encolar = (abs) => {
    const r = rel(abs);
    if (r.startsWith('..') || path.isAbsolute(r) || /(^|\/)node_modules\//.test(r)) return;
    if (!vistos.has(r)) { vistos.add(r); cola.push(abs); }
  };
  for (const e of entradas) { const abs = path.resolve(raiz, e); try { if (fs.statSync(abs).isFile()) encolar(abs); } catch { /* ya no existe */ } }
  while (cola.length) {
    if (vistos.size > maxArchivos) { truncado = true; break; }
    const abs = cola.shift();
    if (!CODIGO.test(abs)) continue; // json, css, imágenes…: hojas
    let txt; try { txt = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    const esConfig = /(?:^|[\\/])(?:vitest|vite|jest|playwright|next|webpack|babel)\.config\.[cm]?[jt]s$|(?:^|[\\/])\.?babelrc/i.test(abs);
    const specs = new Set();
    for (const re of RE_IMPORTS) { re.lastIndex = 0; let m; while ((m = re.exec(txt))) specs.add(m[1]); }
    // En la configuración de pruebas, los archivos que nombra (setupFiles, alias a rutas…) también ejecutan código.
    if (esConfig) { RE_RUTA_EN_CONFIG.lastIndex = 0; let m; while ((m = RE_RUTA_EN_CONFIG.exec(txt))) specs.add(m[1]); }
    for (const spec of specs) {
      const r = resolverImport(spec, abs, ctx);
      if (r.abs) encolar(r.abs);
      // En un config, una cadena que parece ruta (un directorio, un glob) puede no ser un import: no invalida el cierre.
      else if (r.sinResolver && !esConfig) sinResolver.push(spec + '  ←  ' + rel(abs));
    }
  }
  return { archivos: vistos, completo: !truncado && sinResolver.length === 0, sinResolver: sinResolver.slice(0, 20), truncado };
}

module.exports = { cierreDeImports, resolverImport, leerAlias, CODIGO };
