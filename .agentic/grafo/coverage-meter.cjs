'use strict';

/**
 * Coverage Meter — Agentic KDD v3.14 (Plan 6, C1: cobertura declarada)
 *
 * Responde la pregunta que el sistema callaba (debilidad D2 / hueco L5-2):
 * "¿cuánto de este proyecto VE Agentix, y dónde están sus puntos ciegos?"
 *
 * Dos modos, fail-soft:
 *   HEURÍSTICO (siempre): por archivo indexado, % de líneas cubiertas por los
 *     rangos de símbolos (line_start..line_end del Plan 1) + archivos CIEGOS
 *     (indexables, con contenido real, cero símbolos) + causa probable.
 *   EXACTO (si web-tree-sitter está instalado): reusa ts-enricher.compare y
 *     reporta el % de emparejamiento real contra un parser de verdad.
 *
 * Lo invisible NO desprotege: ancla ausente = DOUBT = portón cerrado. Este
 * medidor existe para DECLARARLO, no para arreglarlo.
 *
 * Uso CLI:
 *   node .agentic/grafo/coverage-meter.cjs [--target=DIR] [--out=_output]
 */

const fs = require('fs');
const path = require('path');

const safe = (fn, fb = null) => { try { return fn(); } catch { return fb; } };

const CODE_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.kt', '.php', '.rb', '.html', '.htm', '.css', '.sql']);
const IGNORE_DIRS = new Set(['node_modules', '.git', '.agentic', 'dist', 'build', '.next', 'coverage', '__pycache__', '.pytest_cache', 'vendor', 'target']);

function openDB(dbPath) {
  try { return new (require('better-sqlite3'))(dbPath, { readonly: true }); } catch {}
  try { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(dbPath, { readOnly: true }); } catch {}
  return null;
}

function walkCodeFiles(dir, root, out = []) {
  const entries = safe(() => fs.readdirSync(dir, { withFileTypes: true }), []);
  for (const e of entries) {
    if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkCodeFiles(full, root, out);
    else if (CODE_EXTS.has(path.extname(e.name).toLowerCase())) out.push(path.relative(root, full));
  }
  return out;
}

function medirCobertura(targetDir) {
  const dbPath = path.join(targetDir, '.agentic', 'memoria.db');
  const res = {
    ok: false, archivosDisco: 0, archivosIndexados: 0, ciegos: [],
    coberturaLineas: null, exacto: null, notas: [],
  };
  const db = openDB(dbPath);
  if (!db) { res.notas.push('sin memoria.db — corre akdd init/sync'); return res; }

  try {
    const enDisco = walkCodeFiles(targetDir, targetDir);
    res.archivosDisco = enDisco.length;

    const filasIdx = safe(() => db.prepare(
      `SELECT file, MIN(line_start) mn, MAX(line_end) mx, COUNT(*) n FROM ast_symbols GROUP BY file`
    ).all()) || [];
    const idxSet = new Set(filasIdx.map(r => String(r.file).replace(/\\/g, '/').toLowerCase()));
    res.archivosIndexados = filasIdx.length;

    // Archivos CIEGOS: en disco, indexables, con contenido real, SIN una sola fila
    for (const rel of enDisco) {
      const key = rel.replace(/\\/g, '/').toLowerCase();
      if (idxSet.has(key)) continue;
      const contenido = safe(() => fs.readFileSync(path.join(targetDir, rel), 'utf8'), '');
      if (!contenido || contenido.length > 500000) continue; // los >500KB los salta también el indexador (documentado)
      const lineasReales = contenido.split('\n').filter(l => l.trim()).length;
      if (lineasReales <= 30) continue; // archivo chico sin símbolos = normal, no ciego
      const backticks = (contenido.match(/`/g) || []).length;
      res.ciegos.push({
        file: rel.replace(/\\/g, '/'), lineas: lineasReales,
        causaProbable: backticks > 20 ? 'template-pesado' : 'sin patrones reconocibles',
      });
    }

    // % de líneas cubiertas por rangos de símbolos (muestra: archivos indexados JS/TS)
    let cubiertas = 0, totales = 0, muestreados = 0;
    const rangosPorFile = safe(() => db.prepare(
      `SELECT file, line_start, line_end FROM ast_symbols WHERE line_end > 0 AND language IN ('javascript','typescript')`
    ).all()) || [];
    const porFile = {};
    rangosPorFile.forEach(r => { (porFile[r.file] = porFile[r.file] || []).push(r); });
    for (const [file, rangos] of Object.entries(porFile)) {
      if (muestreados >= 200) break; // muestra acotada — es un medidor, no un censo
      const abs = path.join(targetDir, file);
      const contenido = safe(() => fs.readFileSync(abs, 'utf8'));
      if (!contenido) continue;
      const total = contenido.split('\n').length;
      const marca = new Array(total + 1).fill(false);
      rangos.forEach(r => { for (let i = Math.max(1, r.line_start); i <= Math.min(total, r.line_end); i++) marca[i] = true; });
      cubiertas += marca.filter(Boolean).length;
      totales += total;
      muestreados++;
    }
    if (totales) res.coberturaLineas = { pct: Math.round((cubiertas / totales) * 100), archivosMuestreados: muestreados };

    res.ok = true;
  } finally { safe(() => db.close()); }
  return res;
}

async function medirExacto(targetDir) {
  // Modo exacto: SOLO si el topógrafo está instalado (feature-detect, jamás descarga)
  try {
    require.resolve('web-tree-sitter');
    require.resolve('tree-sitter-wasms/out/tree-sitter-javascript.wasm');
  } catch { return null; }
  return safe(async () => {
    const ts = require(path.join(__dirname, 'ts-enricher.cjs'));
    const r = await ts.compare(targetDir, path.join(targetDir, '.agentic', 'memoria.db'), require('os').tmpdir());
    return r && r.ok ? { pctMatch: Math.round(r.pctMatch * 100), pctPreciso: Math.round(r.pctPrecisoNoUltimo * 100) } : null;
  });
}

function renderReporte(targetDir, res, exacto) {
  const pctVisto = res.archivosDisco ? Math.round((res.archivosIndexados / res.archivosDisco) * 100) : 0;
  const L = [];
  L.push(`# 📊 Cobertura del índice — ${path.basename(targetDir)} (${new Date().toISOString().slice(0, 10)})`);
  L.push('');
  L.push(`- Archivos de código en disco: **${res.archivosDisco}** · indexados: **${res.archivosIndexados}** (${pctVisto}%)`);
  if (res.coberturaLineas) L.push(`- Líneas cubiertas por rangos de símbolos (muestra JS/TS, ${res.coberturaLineas.archivosMuestreados} archivos): **${res.coberturaLineas.pct}%**`);
  if (exacto) L.push(`- **Modo exacto** (vs parser real): emparejamiento **${exacto.pctMatch}%** · precisión ≤2 líneas **${exacto.pctPreciso}%**`);
  else L.push(`- Modo exacto: no disponible (instala el topógrafo: \`npm install --no-save web-tree-sitter tree-sitter-wasms\`)`);
  L.push('');
  if (res.ciegos.length) {
    L.push(`## Puntos ciegos (${res.ciegos.length} archivo(s) con contenido real y cero símbolos)`);
    res.ciegos.slice(0, 15).forEach(c => L.push(`- ${c.file} (${c.lineas} líneas — ${c.causaProbable})`));
    if (res.ciegos.length > 15) L.push(`- …y ${res.ciegos.length - 15} más`);
  } else {
    L.push('## Puntos ciegos: ninguno detectado ✓');
  }
  L.push('');
  L.push('> Lo invisible NO desprotege: un símbolo que el índice no ve produce DUDA en el guardia — y la DUDA cierra el portón (comportamiento de siempre). Este medidor DECLARA los límites; no los disimula.');
  return L.join('\n');
}

if (require.main === module) {
  const opt = (name, def) => {
    const a = process.argv.find(x => x.startsWith(`--${name}=`));
    return a ? a.split('=').slice(1).join('=') : def;
  };
  const target = path.resolve(opt('target', process.cwd()));
  const outDir = path.resolve(opt('out', path.join(process.cwd(), '_output')));
  (async () => {
    const res = medirCobertura(target);
    if (!res.ok) { console.log('⚠️ ', res.notas.join(' | ')); process.exit(0); }
    const exacto = await medirExacto(target);
    const reporte = renderReporte(target, res, exacto);
    console.log(reporte);
    safe(() => { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, `cobertura-${new Date().toISOString().slice(0, 10)}.md`), reporte); });
    console.log(`\n📄 Reporte: ${path.join(outDir, `cobertura-${new Date().toISOString().slice(0, 10)}.md`)}`);
  })().catch(e => { console.log('⚠️  coverage-meter (no bloquea nada):', e.message); process.exit(0); });
}

module.exports = { medirCobertura, medirExacto, renderReporte };
