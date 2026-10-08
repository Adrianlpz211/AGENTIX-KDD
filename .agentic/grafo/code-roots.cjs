'use strict';
/**
 * Raíces de código de un proyecto: dónde está de verdad su fuente.
 *
 * Antes había DOS criterios distintos y los dos fijos: `generarSpec` solo miraba `src/` y `detectarYEscribirPatrones`
 * `src, app, lib, backend/app, backend/src`. Un proyecto Next.js (medinet: app/, lib/, components/, sin src/) se quedaba con
 * 0 specs y 0 fuentes por módulo en TODOS sus ciclos. Esta función es la única fuente de verdad para ambos.
 *
 * Solo devuelve carpetas que EXISTEN. Si ninguna candidata existe, devuelve [] (el llamador decide el respaldo).
 */
const fs = require('fs');
const path = require('path');

const CANDIDATAS = ['src', 'app', 'lib', 'components', 'pages', 'server', 'backend', 'api', 'hooks', 'utils', 'services', 'worker'];
const SUBCARPETAS_MONOREPO = ['src', 'app', 'lib'];

function esDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function subdirs(p) { try { return fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules').map((e) => e.name); } catch { return []; } }

/** @returns {string[]} rutas relativas al proyecto, con «/», sin solaparse (si «backend» está, «backend/app» sobra). */
function raicesDeCodigo(root) {
  const base = root || process.cwd();
  const out = [];
  for (const c of CANDIDATAS) if (esDir(path.join(base, c))) out.push(c);
  // Monorepos: packages/*/src, apps/*/{src,app,lib}
  for (const grupo of ['packages', 'apps']) {
    if (!esDir(path.join(base, grupo))) continue;
    for (const pkg of subdirs(path.join(base, grupo))) {
      for (const sub of SUBCARPETAS_MONOREPO) {
        const rel = grupo + '/' + pkg + '/' + sub;
        if (esDir(path.join(base, rel))) out.push(rel);
      }
    }
  }
  const unicas = [...new Set(out)];
  return unicas.filter((r) => !unicas.some((o) => o !== r && r.startsWith(o + '/')));
}

module.exports = { raicesDeCodigo, CANDIDATAS };
