/**
 * Agentic KDD — Graph Reviewer v1.0 (Pieza 6 del plan Understand-Anything)
 *
 * Chequeo DETERMINISTA de integridad de memoria.db — sin IA, puro código.
 * La memoria se degrada en silencio con cada refactor: relaciones que apuntan
 * a nodos borrados, decisiones ligadas a archivos que ya no existen, aristas
 * AST de archivos renombrados, locks huérfanos de instancias que crashearon.
 * Nadie lo nota hasta que el contexto que el agente recibe está podrido.
 *
 * Checks (todos read-only por defecto):
 *   1. relaciones colgantes         — desde_id/hacia_id sin nodo en `nodos`
 *   2. relaciones_semanticas huérf. — entidades "nodo:tipo:titulo" cuyo título ya no existe
 *   3. archivos fantasma            — nodos cuyo archivos_aplica referencia archivos borrados
 *   4. aristas AST fantasma         — ast_edges con from/to_file fuera de ast_symbols
 *   4b. símbolos AST fantasma       — ast_symbols de archivos que ya no existen en disco
 *   5. contratos/behaviors rotos    — test_file / test_patterns apuntando a tests borrados
 *   6. locks vencidos               — module_locks/file_locks expirados hace > 7 días
 *
 * --fix limpia SOLO las categorías seguras (1, 2, 4, 4b, 6): datos derivados o
 * basura, reconstruibles. Los checks 3 y 5 son CONOCIMIENTO y contratos — solo
 * se reportan; la decisión de reasignar/archivar es del dev, nunca automática.
 *
 * Uso:
 *   node graph-reviewer.cjs           — reporte (no toca nada)
 *   node graph-reviewer.cjs --fix     — limpia las categorías seguras
 *   node graph-reviewer.cjs --json    — salida JSON (para health-check)
 */

'use strict';

const path = require('path');
const fs   = require('fs');

const STALE_LOCK_DAYS = 7;

// ─── DB (mismo patrón que change-classifier / graph-freshness) ───────────────

function resolveDbPath(projectRoot) {
  const candidates = [
    path.join(projectRoot, '.agentic', 'memoria.db'),
    path.join(projectRoot, '.agentic', 'grafo', 'memoria.db'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return candidates[0];
}

function openDB(projectRoot, readonly) {
  const dbPath = resolveDbPath(projectRoot);
  if (!fs.existsSync(dbPath)) return null;
  try { return new (require('better-sqlite3'))(dbPath, readonly ? { readonly: true } : {}); }
  catch { try { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(dbPath); } catch { return null; } }
}

const safe = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };

function tableExists(db, name) {
  return !!safe(() => db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name));
}

function fileExists(projectRoot, p) {
  if (!p) return false;
  const full = path.isAbsolute(p) ? p : path.join(projectRoot, p);
  return fs.existsSync(full);
}

// ─── CHECKS ───────────────────────────────────────────────────────────────────

/** 1. relaciones cuyo desde_id/hacia_id no existe en nodos */
function checkDanglingRelations(db) {
  if (!tableExists(db, 'relaciones') || !tableExists(db, 'nodos')) return { skipped: true, items: [] };
  const rows = safe(() => db.prepare(`
    SELECT r.id, r.desde_id, r.hacia_id, r.tipo FROM relaciones r
    WHERE r.desde_id NOT IN (SELECT id FROM nodos)
       OR r.hacia_id NOT IN (SELECT id FROM nodos)
  `).all()) || [];
  return { items: rows.map(r => ({ id: r.id, detail: `relación #${r.id} (${r.tipo}) → nodo ${r.desde_id}→${r.hacia_id} inexistente` })) };
}

/** 2. relaciones_semanticas cuyas entidades "nodo:tipo:titulo" ya no existen */
function checkDanglingSemantic(db) {
  if (!tableExists(db, 'relaciones_semanticas') || !tableExists(db, 'nodos')) return { skipped: true, items: [] };
  // Solo entidades con el prefijo nodo: son verificables contra `nodos` — el
  // resto (endpoint:, archivo:, entidades libres) tienen otras fuentes de verdad
  // y NO se marcan (conservador: mejor un falso negativo que borrar algo vivo).
  const rows = safe(() => db.prepare(`
    SELECT id, desde_entidad, hacia_entidad, tipo FROM relaciones_semanticas
    WHERE invalid_at IS NULL
  `).all()) || [];
  const titulos = new Set((safe(() => db.prepare(`SELECT titulo FROM nodos`).all()) || []).map(n => String(n.titulo)));
  const isDeadNodeRef = (ent) => {
    const m = String(ent || '').match(/^nodo:(?:error|decision|patron|regla):(.+)$/);
    if (!m) return false;
    return !titulos.has(m[1]);
  };
  const items = rows
    .filter(r => isDeadNodeRef(r.desde_entidad) || isDeadNodeRef(r.hacia_entidad))
    .map(r => ({ id: r.id, detail: `rel.semántica #${r.id} (${r.tipo}) → referencia a nodo borrado: ${[r.desde_entidad, r.hacia_entidad].filter(isDeadNodeRef).join(', ').slice(0, 90)}` }));
  return { items };
}

/** 3. nodos con archivos_aplica apuntando a archivos que ya no existen (SOLO REPORTE) */
function checkGhostFiles(db, projectRoot) {
  if (!tableExists(db, 'nodos')) return { skipped: true, items: [] };
  const hasCol = safe(() => db.prepare(`SELECT archivos_aplica FROM nodos LIMIT 1`).get(), undefined);
  if (hasCol === undefined) return { skipped: true, items: [] };  // columna no existe en este schema
  const rows = safe(() => db.prepare(`
    SELECT id, tipo, titulo, archivos_aplica FROM nodos
    WHERE archivos_aplica IS NOT NULL AND archivos_aplica != '[]' AND archivos_aplica != ''
      AND estado = 'ACTIVO'
  `).all()) || [];

  // Muchas entradas viejas guardan solo el NOMBRE del archivo ("factory.ts") sin
  // su carpeta — eso NO es un archivo fantasma si existe uno con ese nombre en
  // cualquier parte del índice AST. Solo se marca fantasma lo que no aparece ni
  // por ruta exacta ni por basename (conservador: cero falsos positivos reales,
  // confirmado en la primera pasada sobre Lumo donde 27 nodos salían mal marcados).
  const indexedBasenames = new Set(
    (safe(() => db.prepare(`SELECT DISTINCT file FROM ast_symbols`).all()) || [])
      .map(r => String(r.file).split(/[\\/]/).pop())
  );
  const isMissing = (a) => {
    if (fileExists(projectRoot, a)) return false;
    const hasSep = /[\\/]/.test(a);
    if (!hasSep && indexedBasenames.has(String(a).trim())) return false;  // nombre pelado que sí existe

    // Patrón glob ("public/panel/js/**", "src/*.ts") — nunca existe como ruta
    // literal, así que fs.existsSync siempre da falso aunque la carpeta esté
    // ahí (encontrado batalleando graph-reviewer contra Lumo real: 27 nodos
    // marcados fantasma solo por tener un glob en archivos_aplica). Conservador:
    // si la carpeta ANTES del primer carácter de glob existe en disco, se
    // asume vivo — resolver el glob completo no vale la pena para esta señal
    // barata; lo que importa es no gritar fantasma sobre algo que sigue ahí.
    if (/[*?[\]{}]/.test(a)) {
      const idx = a.search(/[*?[\]{}]/);
      const prefix = a.slice(0, idx).replace(/[\\/]+$/, '');
      if (!prefix || fileExists(projectRoot, prefix)) return false;
    }
    return true;
  };

  const items = [];
  for (const n of rows) {
    let archivos = [];
    try { archivos = JSON.parse(n.archivos_aplica); } catch { continue; }
    const missing = archivos.filter(isMissing);
    if (missing.length) {
      items.push({ id: n.id, detail: `${n.tipo} #${n.id} "${String(n.titulo).slice(0, 50)}" → archivo(s) inexistente(s): ${missing.join(', ').slice(0, 100)}`, missing });
    }
  }
  return { items };
}

/** 4. ast_edges cuyos archivos ya NO EXISTEN EN DISCO (borrados/renombrados) */
function checkGhostAstEdges(db, projectRoot) {
  if (!tableExists(db, 'ast_edges') || !tableExists(db, 'ast_symbols')) return { skipped: true, items: [] };
  // Fantasma = fuera del índice Y ADEMÁS inexistente en disco. Un archivo que
  // existe pero no está indexado (gap del indexer, archivo >500KB, extensión
  // nueva) NO es podredumbre — su arista sigue siendo información real de
  // dependencia y borrarla perdería datos (detectado en la primera pasada sobre
  // Lumo: 180 aristas a archivos vivos como brand.js iban a borrarse mal).
  const rows = safe(() => db.prepare(`
    SELECT e.id, e.from_file, e.to_file, e.kind FROM ast_edges e
    WHERE e.from_file NOT IN (SELECT DISTINCT file FROM ast_symbols)
       OR (e.to_file IS NOT NULL AND e.to_file NOT IN (SELECT DISTINCT file FROM ast_symbols))
  `).all()) || [];
  const existsCache = new Map();
  const gone = (f) => {
    if (!f) return false;
    if (!existsCache.has(f)) existsCache.set(f, !fileExists(projectRoot, f));
    return existsCache.get(f);
  };
  const items = rows
    .filter(r => gone(r.from_file) || gone(r.to_file))
    .map(r => ({ id: r.id, detail: `arista AST #${r.id} (${r.kind}) ${r.from_file} → ${r.to_file || '?'}` }));
  return { items };
}

/** 4b. ast_symbols de archivos que ya no existen en disco */
function checkGhostAstSymbols(db, projectRoot) {
  if (!tableExists(db, 'ast_symbols')) return { skipped: true, items: [] };
  const files = (safe(() => db.prepare(`SELECT DISTINCT file FROM ast_symbols`).all()) || []).map(r => r.file);
  const missing = files.filter(f => !fileExists(projectRoot, f));
  return { items: missing.map(f => ({ id: f, detail: `símbolos indexados de archivo borrado: ${f}` })), files: missing };
}

/** 5. contratos/behaviors cuyos tests ya no existen (SOLO REPORTE) */
function checkBrokenContracts(db, projectRoot) {
  const items = [];
  if (tableExists(db, 'verified_contracts')) {
    const rows = safe(() => db.prepare(`
      SELECT id, module, name, test_file FROM verified_contracts
      WHERE status IN ('verified','protected') AND test_file IS NOT NULL AND test_file != ''
    `).all()) || [];
    rows.forEach(r => {
      // Solo verificar test_file que sea una RUTA real ("test/auth.test.js") —
      // muchos contratos guardan el COMANDO ("npm test") ahí, y un comando no es
      // un archivo borrable (falso positivo confirmado en la primera pasada:
      // 16 contratos de Lumo salían como "test borrado: npm test").
      const looksLikePath = /[\\/]/.test(r.test_file) || /\.(test|spec)\.[a-z]+$/i.test(r.test_file);
      if (looksLikePath && !fileExists(projectRoot, r.test_file)) {
        items.push({ id: `contract-${r.id}`, detail: `contrato [${r.module}] "${String(r.name).slice(0, 40)}" → test borrado: ${r.test_file}` });
      }
    });
  }
  if (tableExists(db, 'protected_behaviors')) {
    const rows = safe(() => db.prepare(`
      SELECT id, module, test_patterns FROM protected_behaviors WHERE status != 'deprecated'
    `).all()) || [];
    rows.forEach(r => {
      let patterns = [];
      try { patterns = JSON.parse(r.test_patterns || '[]'); } catch {}
      // Solo patterns que parezcan rutas de archivo concretas (no globs ni nombres de test)
      const filePatterns = patterns.filter(p => typeof p === 'string' && /[\\/]/.test(p) && !p.includes('*'));
      const missing = filePatterns.filter(p => !fileExists(projectRoot, p));
      if (missing.length) {
        items.push({ id: `behavior-${r.id}`, detail: `behavior [${r.module}] #${r.id} → test(s) borrado(s): ${missing.join(', ').slice(0, 90)}` });
      }
    });
  }
  return { items };
}

/** 6. locks expirados hace > STALE_LOCK_DAYS días (basura de crashes) */
function checkStaleLocks(db) {
  const cutoff = new Date(Date.now() - STALE_LOCK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const items = [];
  for (const t of ['module_locks', 'file_locks']) {
    if (!tableExists(db, t)) continue;
    const rows = safe(() => db.prepare(`
      SELECT id, expires_at FROM ${t} WHERE expires_at IS NOT NULL AND expires_at < ?
    `).all(cutoff)) || [];
    rows.forEach(r => items.push({ id: r.id, table: t, detail: `${t} #${r.id} expirado desde ${r.expires_at}` }));
  }
  return { items };
}

// ─── REVIEW COMPLETO ──────────────────────────────────────────────────────────

function review(projectRoot) {
  projectRoot = projectRoot || process.cwd();
  const db = openDB(projectRoot, true);
  if (!db) return { error: 'DB unavailable' };

  const result = {
    danglingRelations: checkDanglingRelations(db),
    danglingSemantic:  checkDanglingSemantic(db),
    ghostFiles:        checkGhostFiles(db, projectRoot),
    ghostAstEdges:     checkGhostAstEdges(db, projectRoot),
    ghostAstSymbols:   checkGhostAstSymbols(db, projectRoot),
    brokenContracts:   checkBrokenContracts(db, projectRoot),
    staleLocks:        checkStaleLocks(db),
  };
  safe(() => db.close());

  result.totalIssues = Object.values(result)
    .filter(v => v && Array.isArray(v.items))
    .reduce((s, v) => s + v.items.length, 0);
  return result;
}

// ─── FIX (solo categorías seguras: 1, 2, 4, 4b, 6) ───────────────────────────

function fix(projectRoot) {
  projectRoot = projectRoot || process.cwd();
  const before = review(projectRoot);
  if (before.error) return before;

  const db = openDB(projectRoot, false);
  if (!db) return { error: 'DB unavailable (write)' };

  const cleaned = { relaciones: 0, semanticas: 0, astEdges: 0, astSymbols: 0, locks: 0 };

  // 1. relaciones colgantes
  before.danglingRelations.items.forEach(i => {
    if (safe(() => { db.prepare(`DELETE FROM relaciones WHERE id = ?`).run(i.id); return true; })) cleaned.relaciones++;
  });
  // 2. semánticas huérfanas — se INVALIDAN (bi-temporal), no se borran: preserva auditoría
  before.danglingSemantic.items.forEach(i => {
    if (safe(() => { db.prepare(`UPDATE relaciones_semanticas SET invalid_at = datetime('now') WHERE id = ?`).run(i.id); return true; })) cleaned.semanticas++;
  });
  // 4. aristas AST fantasma
  before.ghostAstEdges.items.forEach(i => {
    if (safe(() => { db.prepare(`DELETE FROM ast_edges WHERE id = ?`).run(i.id); return true; })) cleaned.astEdges++;
  });
  // 4b. símbolos AST de archivos borrados (+ sus aristas y fingerprints)
  (before.ghostAstSymbols.files || []).forEach(f => {
    if (safe(() => {
      db.prepare(`DELETE FROM ast_symbols WHERE file = ?`).run(f);
      db.prepare(`DELETE FROM ast_edges WHERE from_file = ? OR to_file = ?`).run(f, f);
      safe(() => db.prepare(`DELETE FROM file_fingerprints WHERE file = ?`).run(f));
      return true;
    })) cleaned.astSymbols++;
  });
  // 6. locks vencidos
  before.staleLocks.items.forEach(i => {
    if (safe(() => { db.prepare(`DELETE FROM ${i.table} WHERE id = ?`).run(i.id); return true; })) cleaned.locks++;
  });

  safe(() => db.close());
  return { cleaned, reported: { ghostFiles: before.ghostFiles.items.length, brokenContracts: before.brokenContracts.items.length } };
}

// ─── RESUMEN PARA HEALTH-CHECK ────────────────────────────────────────────────

function healthSummary(projectRoot) {
  const r = safe(() => review(projectRoot));
  if (!r || r.error) return null;
  return {
    total: r.totalIssues,
    fixable: r.danglingRelations.items.length + r.danglingSemantic.items.length
           + r.ghostAstEdges.items.length + r.ghostAstSymbols.items.length + r.staleLocks.items.length,
    reportOnly: r.ghostFiles.items.length + r.brokenContracts.items.length,
  };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const projectRoot = process.cwd();
  const asJson = args.includes('--json');
  const doFix = args.includes('--fix');

  if (doFix) {
    const r = fix(projectRoot);
    if (r.error) { console.log(`❌ ${r.error}`); process.exit(1); }
    if (asJson) { console.log(JSON.stringify(r, null, 2)); }
    else {
      console.log('\n  🧹 Graph Reviewer — limpieza de categorías seguras');
      console.log(`  Relaciones colgantes eliminadas:     ${r.cleaned.relaciones}`);
      console.log(`  Rel. semánticas invalidadas:         ${r.cleaned.semanticas}`);
      console.log(`  Aristas AST fantasma eliminadas:     ${r.cleaned.astEdges}`);
      console.log(`  Archivos AST fantasma des-indexados: ${r.cleaned.astSymbols}`);
      console.log(`  Locks vencidos eliminados:           ${r.cleaned.locks}`);
      if (r.reported.ghostFiles || r.reported.brokenContracts) {
        console.log(`\n  ⚠️  Pendientes de decisión humana (NO se tocan automáticamente):`);
        if (r.reported.ghostFiles) console.log(`     - ${r.reported.ghostFiles} nodo(s) de conocimiento con archivos fantasma (revisar/reasignar)`);
        if (r.reported.brokenContracts) console.log(`     - ${r.reported.brokenContracts} contrato(s)/behavior(s) con tests borrados (deprecar o re-apuntar)`);
      }
      console.log('');
    }
    process.exit(0);
  }

  const r = review(projectRoot);
  if (r.error) { console.log(`❌ ${r.error}`); process.exit(1); }
  if (asJson) { console.log(JSON.stringify(r, null, 2)); process.exit(0); }

  console.log('\n  🔎 Graph Reviewer — integridad de memoria.db\n');
  const section = (label, res, fixable) => {
    const n = res.skipped ? 'n/a' : res.items.length;
    const icon = res.skipped ? '➖' : res.items.length === 0 ? '✅' : fixable ? '🧹' : '⚠️ ';
    console.log(`  ${icon} ${label}: ${n}${!res.skipped && res.items.length ? (fixable ? ' (limpiable con --fix)' : ' (requiere decisión humana)') : ''}`);
    (res.items || []).slice(0, 5).forEach(i => console.log(`       - ${i.detail}`));
    if ((res.items || []).length > 5) console.log(`       … y ${res.items.length - 5} más`);
  };
  section('Relaciones colgantes', r.danglingRelations, true);
  section('Rel. semánticas huérfanas', r.danglingSemantic, true);
  section('Nodos con archivos fantasma', r.ghostFiles, false);
  section('Aristas AST fantasma', r.ghostAstEdges, true);
  section('Archivos AST borrados aún indexados', r.ghostAstSymbols, true);
  section('Contratos/behaviors con tests borrados', r.brokenContracts, false);
  section('Locks vencidos (>7 días)', r.staleLocks, true);
  console.log(`\n  Total: ${r.totalIssues} problema(s)${r.totalIssues ? ' — corre con --fix para limpiar lo seguro' : ' — memoria íntegra'}\n`);
}

module.exports = { review, fix, healthSummary };
