/**
 * Agentic KDD — Diff Overlay v1.0 (Pieza 4 del plan Understand-Anything)
 *
 * La armadura YA calcula qué se afecta con un cambio (ast-impact, contratos en
 * riesgo) — pero solo en texto. Esta pieza lo hace VISIBLE: genera un JSON con
 * los archivos cambiados ahora mismo (git) + los que pueden verse afectados
 * (1 salto por las aristas del grafo de código) + cuáles de esos tienen
 * contratos/behaviors protegiéndolos. El dashboard lo pinta encima del grafo
 * Code Structure: rojo = cambió, naranja = puede verse afectado (con anillo si
 * hay contrato encima), el resto atenuado.
 *
 * Uso:
 *   node diff-overlay.cjs                 — diff actual (working tree + staged + untracked)
 *   node diff-overlay.cjs <commit-base>   — diff contra un commit/rama base
 *   → escribe .agentic/diff-overlay.json y muestra resumen
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const { execSync } = require('child_process');

const GIT_TIMEOUT = 8000;

function resolveDbPath(projectRoot) {
  const candidates = [
    path.join(projectRoot, '.agentic', 'memoria.db'),
    path.join(projectRoot, '.agentic', 'grafo', 'memoria.db'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return candidates[0];
}

function openDB(projectRoot) {
  const dbPath = resolveDbPath(projectRoot);
  if (!fs.existsSync(dbPath)) return null;
  try { return new (require('better-sqlite3'))(dbPath, { readonly: true }); }
  catch { try { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(dbPath); } catch { return null; } }
}

const safe = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };

function git(cmd, projectRoot) {
  try {
    return execSync(`git ${cmd}`, { cwd: projectRoot, stdio: 'pipe', timeout: GIT_TIMEOUT }).toString();
  } catch { return null; }
}

// Rutas del diff → mismo formato que usa el índice AST (backslash en Windows)
function normToIndex(p) { return String(p || '').trim().replace(/\//g, '\\'); }

/** Archivos cambiados AHORA: working tree + staged + untracked (+ vs base). */
function collectChangedFiles(projectRoot, base) {
  const out = new Set();
  const add = (raw) => (raw || '').split('\n').map(l => l.trim()).filter(Boolean).forEach(f => out.add(normToIndex(f)));
  if (base) add(git(`diff --name-only "${base}" -- .`, projectRoot));
  add(git('diff --name-only -- .', projectRoot));
  add(git('diff --cached --name-only -- .', projectRoot));
  add(git('ls-files --others --exclude-standard -- .', projectRoot));
  // Los artefactos generados no son "cambios del proyecto"
  return [...out].filter(f => !f.startsWith('.agentic\\') && !f.startsWith('_output\\'));
}

function generate(projectRoot, base = null) {
  projectRoot = projectRoot || process.cwd();
  const changed = collectChangedFiles(projectRoot, base);

  const db = openDB(projectRoot);
  if (!db) return { error: 'DB unavailable' };

  // Solo interesan los cambiados que el grafo CONOCE (están indexados)
  const indexed = new Set((safe(() => db.prepare('SELECT DISTINCT file FROM ast_symbols').all()) || []).map(r => r.file));
  const changedIndexed = changed.filter(f => indexed.has(f));

  // 1 salto por las aristas: quién depende de lo cambiado (upstream) y qué usa
  // lo cambiado (downstream) — ambos son "puede verse afectado".
  const affected = new Map();  // file → {via:Set}
  if (changedIndexed.length) {
    const ph = changedIndexed.map(() => '?').join(',');
    const up = safe(() => db.prepare(
      `SELECT DISTINCT from_file AS f, to_file AS c FROM ast_edges WHERE to_file IN (${ph}) AND from_file NOT IN (${ph})`
    ).all(...changedIndexed, ...changedIndexed)) || [];
    const down = safe(() => db.prepare(
      `SELECT DISTINCT to_file AS f, from_file AS c FROM ast_edges WHERE from_file IN (${ph}) AND to_file IS NOT NULL AND to_file NOT IN (${ph})`
    ).all(...changedIndexed, ...changedIndexed)) || [];
    for (const r of [...up, ...down]) {
      if (!r.f || changedIndexed.includes(r.f)) continue;
      if (!affected.has(r.f)) affected.set(r.f, new Set());
      affected.get(r.f).add(r.c);
    }
  }

  // ¿Cuáles de los tocados/afectados tienen contratos o behaviors encima?
  const contractFiles = new Set();
  const addContractFiles = (rows, field) => (rows || []).forEach(r => {
    let arr = [];
    try { arr = JSON.parse(r[field] || '[]'); } catch {}
    arr.forEach(f => contractFiles.add(normToIndex(f)));
  });
  addContractFiles(safe(() => db.prepare(`SELECT source_files FROM verified_contracts WHERE status IN ('verified','protected')`).all()), 'source_files');
  addContractFiles(safe(() => db.prepare(`SELECT related_files FROM protected_behaviors WHERE status != 'deprecated'`).all()), 'related_files');
  safe(() => db.close());

  const overlay = {
    version: '1.0',
    generatedAt: new Date().toISOString(),
    base: base || 'working-tree',
    changed: changedIndexed.map(f => ({ file: f, hasContracts: contractFiles.has(f) })),
    changedUnindexed: changed.filter(f => !indexed.has(f)).length,
    affected: [...affected.entries()].map(([f, via]) => ({
      file: f,
      via: [...via].slice(0, 5),
      hasContracts: contractFiles.has(f),
    })),
  };

  const outPath = path.join(projectRoot, '.agentic', 'diff-overlay.json');
  try { fs.writeFileSync(outPath, JSON.stringify(overlay, null, 2), 'utf8'); }
  catch (e) { return { error: `no se pudo escribir ${outPath}: ${e.message}` }; }

  return { ok: true, outPath, changed: overlay.changed.length, affected: overlay.affected.length, unindexed: overlay.changedUnindexed };
}

if (require.main === module) {
  const base = process.argv[2] || null;
  const r = generate(process.cwd(), base);
  if (r.error) { console.log(`❌ ${r.error}`); process.exit(1); }
  console.log(`\n  🔥 Diff Overlay generado → ${path.relative(process.cwd(), r.outPath)}`);
  console.log(`  Archivos cambiados (en el grafo): ${r.changed}`);
  console.log(`  Posiblemente afectados (1 salto): ${r.affected}`);
  if (r.unindexed) console.log(`  Cambiados pero fuera del grafo:   ${r.unindexed} (no indexados — no se pintan)`);
  console.log(`  Míralo en el dashboard: Code Structure → botón "🔥 Cambios"\n`);
}

module.exports = { generate };
