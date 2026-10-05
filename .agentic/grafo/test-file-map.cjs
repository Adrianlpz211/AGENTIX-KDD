'use strict';

/**
 * test-file-map — a qué ARCHIVO pertenece cada test, por el título literal.
 *
 * Caso real (glowly, 05/10/2026): los 140 contratos nacieron sin `test_file` (y sin `source_files`), porque el corredor (`node --test` sobre
 * un glob) imprime los títulos sin decir de qué archivo vienen y `tdd-gate` solo atribuye archivo cuando corre UN archivo. Consecuencia:
 * el Preservation Gate no puede elegir qué tests correr y termina cada ciclo en UNVERIFIED (NO_TEST_FILE_MAPPED) → 59 de 62 ciclos
 * «COMPLETADO_CON_PENDIENTES» y la protección contra regresiones, en la práctica, sin ejecutarse.
 *
 * Aquí se lee el código de los tests (sin ejecutar nada) y se saca el mapa título → archivo. Solo se atribuye cuando el título es ÚNICO
 * en el proyecto: si dos archivos tienen un test con el mismo título no se adivina. Los imports del archivo de test dan sus fuentes.
 * Solo lectura; no toca la base (eso lo decide quien lo llama).
 */

const fs = require('fs');
const path = require('path');

const RE_TEST = /\.(test|spec)\.(mjs|cjs|js|jsx|ts|tsx|mts|cts)$/;
const SALTAR = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage', '.agentic', '.turbo', 'out', '.cache']);
const RE_TITULO = /\b(?:test|it|describe)(?:\.(?:only|skip|todo|concurrent))?\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\\n])*?)\1/g;
const MAX_ARCHIVOS = 5000;

const norm = (p) => String(p).split('\\').join('/');
const normTitulo = (t) => String(t).replace(/\s+/g, ' ').trim();

function listarTests(root) {
  const out = [];
  const visitar = (dir, prof) => {
    if (prof > 12 || out.length >= MAX_ARCHIVOS) return;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (SALTAR.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) visitar(full, prof + 1);
      else if (RE_TEST.test(e.name)) out.push(norm(path.relative(root, full)));
    }
  };
  visitar(root, 0);
  return out;
}

function titulosDe(src) {
  const out = [];
  let m;
  RE_TITULO.lastIndex = 0;
  while ((m = RE_TITULO.exec(src)) !== null) {
    const t = m[2];
    if (m[1] === '`' && t.includes('${')) continue;                  // título calculado: no es literal
    out.push(normTitulo(t.replace(/\\(['"`\\])/g, '$1')));
  }
  return out;
}

/** Mapa título → Set(archivos) de todo el proyecto. */
function construirMapa(root) {
  const mapa = new Map();
  const archivos = listarTests(root);
  for (const f of archivos) {
    let src; try { src = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
    for (const t of titulosDe(src)) {
      if (!t) continue;
      if (!mapa.has(t)) mapa.set(t, new Set());
      mapa.get(t).add(f);
    }
  }
  return { mapa, archivos };
}

/** Archivo del test, solo si el título es único en el proyecto; null si no está o es ambiguo. */
function archivoDe(m, testName) {
  const s = m.mapa.get(normTitulo(testName));
  return s && s.size === 1 ? [...s][0] : null;
}

/** Fuentes que importa un archivo de test (rutas relativas resueltas contra el proyecto; sin node_modules ni paquetes). */
function fuentesDe(root, archivoTest) {
  let src; try { src = fs.readFileSync(path.join(root, archivoTest), 'utf8'); } catch { return []; }
  const rutas = new Set();
  const re = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)(['"])(\.{1,2}\/[^'"]+|@\/[^'"]+)\1/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    let spec = m[2];
    let base;
    if (spec.startsWith('@/')) base = path.join(root, spec.slice(2));
    else base = path.resolve(path.dirname(path.join(root, archivoTest)), spec);
    const candidatos = [base, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts'].map((e) => base + e), ...['index.ts', 'index.tsx', 'index.js'].map((i) => path.join(base, i))];
    const hallado = candidatos.find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } });
    if (hallado) { const rel = norm(path.relative(root, hallado)); if (!rel.startsWith('..') && !RE_TEST.test(rel) && !rel.includes('node_modules/')) rutas.add(rel); }
  }
  return [...rutas];
}

module.exports = { listarTests, construirMapa, archivoDe, fuentesDe, titulosDe };
