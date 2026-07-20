/**
 * Agentic KDD — Code Summaries v1.0 (Pieza 3 del plan Understand-Anything)
 *
 * Descripciones en LENGUAJE NATURAL de qué hace cada archivo (y opcionalmente
 * cada pieza adentro), generadas por el agente UNA vez y persistidas — para que
 * el "¡NO ENTIENDO!" del dashboard explique de verdad en vez de adivinar por el
 * nombre. Regla dura de redacción (fijada por el owner): lo único técnico
 * permitido en un summary son los NOMBRES DE ARCHIVO — el resto debe poder
 * leerlo cualquier persona, sea dev o no. Nada de "endpoint", "parsea",
 * "instancia", "callback" — se escribe "recibe pedidos", "interpreta",
 * "crea", "cuando termina, avisa".
 *
 * Validez atada a la ESTRUCTURA (Pieza 1): un summary guarda la firma
 * estructural del archivo en ese momento. Si el archivo cambia de forma
 * cosmética (comentarios, formato) el summary SIGUE siendo válido; solo un
 * cambio estructural (funciones/imports distintos) lo marca desactualizado.
 *
 * Uso CLI (pensado para que lo llame el AGENTE, no el humano):
 *   node code-summaries.cjs write <archivo> "<texto>"   — guardar summary de archivo
 *   node code-summaries.cjs write <archivo>#<pieza> "<texto>" — summary de una pieza
 *   node code-summaries.cjs pending [área] [--limit=20] — qué archivos faltan o están viejos
 *   node code-summaries.cjs status                      — conteo general
 *   node code-summaries.cjs get <archivo>               — leer lo guardado
 */

'use strict';

const path = require('path');
const fs   = require('fs');

// ─── DB (mismo patrón que las otras piezas) ──────────────────────────────────

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
  let db;
  try { db = new (require('better-sqlite3'))(dbPath); }
  catch { try { const { DatabaseSync } = require('node:sqlite'); db = new DatabaseSync(dbPath); } catch { return null; } }
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS code_summaries (
      file           TEXT NOT NULL,
      symbol         TEXT NOT NULL DEFAULT '',
      summary        TEXT NOT NULL,
      lang           TEXT DEFAULT 'es',
      structural_sig TEXT,
      content_hash   TEXT,
      generated_at   TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (file, symbol)
    )`);
  } catch {}
  return db;
}

const safe = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };

// Normaliza separadores: el índice AST guarda "src\ai\factory.ts" en Windows,
// pero el agente puede escribir "src/ai/factory.ts" — misma clave siempre.
function normFile(f) { return String(f || '').replace(/\//g, '\\').trim(); }

// ─── FINGERPRINT ACTUAL (vía Pieza 1) ────────────────────────────────────────

function currentFingerprint(file, projectRoot) {
  try {
    const cc = require('./change-classifier.cjs');
    const fp = cc.fingerprintFile(file.replace(/\\/g, '/'), projectRoot);
    return fp && !fp.missing ? fp : null;
  } catch { return null; }
}

// ─── WRITE ────────────────────────────────────────────────────────────────────

function writeSummary(fileAndSymbol, summary, projectRoot) {
  projectRoot = projectRoot || process.cwd();
  if (!summary || !String(summary).trim()) return { ok: false, reason: 'summary vacío' };

  const [rawFile, symbol = ''] = String(fileAndSymbol).split('#');
  const file = normFile(rawFile);

  const fp = currentFingerprint(file, projectRoot);
  if (!fp) return { ok: false, reason: `archivo no encontrado: ${file}` };

  const db = openDB(projectRoot);
  if (!db) return { ok: false, reason: 'DB unavailable' };

  const ok = safe(() => {
    db.prepare(`
      INSERT INTO code_summaries (file, symbol, summary, structural_sig, content_hash, generated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(file, symbol) DO UPDATE SET
        summary = excluded.summary,
        structural_sig = excluded.structural_sig,
        content_hash = excluded.content_hash,
        generated_at = excluded.generated_at
    `).run(file, symbol, String(summary).trim(), fp.structuralSig, fp.contentHash);
    return true;
  }, false);

  safe(() => db.close());
  return ok ? { ok: true, file, symbol: symbol || null } : { ok: false, reason: 'write failed' };
}

// ─── VALIDEZ ──────────────────────────────────────────────────────────────────
// fresh    → estructura idéntica a cuando se escribió (cosmético no invalida)
// stale    → la estructura del archivo cambió desde el summary
// missing  → sin summary

function summaryState(row, projectRoot) {
  const fp = currentFingerprint(row.file, projectRoot);
  if (!fp) return 'stale';                          // archivo borrado/ilegible
  if (row.structural_sig && fp.structuralSig) {
    return row.structural_sig === fp.structuralSig ? 'fresh' : 'stale';
  }
  // Sin firma estructural (archivo sin extractor): validez por contenido exacto
  return row.content_hash === fp.contentHash ? 'fresh' : 'stale';
}

/** Devuelve el summary de archivo si sigue vigente; null si no hay o está viejo. */
function getFresh(file, projectRoot) {
  projectRoot = projectRoot || process.cwd();
  const db = openDB(projectRoot);
  if (!db) return null;
  const row = safe(() => db.prepare(
    `SELECT * FROM code_summaries WHERE file = ? AND symbol = ''`
  ).get(normFile(file)));
  safe(() => db.close());
  if (!row) return null;
  return summaryState(row, projectRoot) === 'fresh' ? row.summary : null;
}

// ─── PENDING (qué describir) ──────────────────────────────────────────────────

function pending(projectRoot, area = null, limit = 20) {
  projectRoot = projectRoot || process.cwd();
  const db = openDB(projectRoot);
  if (!db) return { error: 'DB unavailable' };

  let files = (safe(() => db.prepare(`SELECT DISTINCT file FROM ast_symbols ORDER BY file`).all()) || [])
    .map(r => r.file);
  if (area) files = files.filter(f => f.toLowerCase().includes(String(area).toLowerCase()));

  const rows = safe(() => db.prepare(`SELECT * FROM code_summaries WHERE symbol = ''`).all()) || [];
  const byFile = new Map(rows.map(r => [r.file, r]));

  const result = { missing: [], stale: [], fresh: 0 };
  for (const f of files) {
    const row = byFile.get(f);
    if (!row) { result.missing.push(f); continue; }
    if (summaryState(row, projectRoot) === 'fresh') result.fresh++;
    else result.stale.push(f);
  }
  safe(() => db.close());
  result.toDescribe = [...result.missing, ...result.stale].slice(0, limit);
  return result;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const [,, cmd, ...args] = process.argv;
  const projectRoot = process.cwd();

  switch (cmd) {
    case 'write': {
      const [target, ...rest] = args;
      const text = rest.join(' ');
      const r = writeSummary(target, text, projectRoot);
      console.log(r.ok ? `✅ ${r.file}${r.symbol ? '#' + r.symbol : ''}` : `❌ ${r.reason}`);
      break;
    }
    case 'pending': {
      const area = args.find(a => !a.startsWith('--')) || null;
      const limit = parseInt((args.find(a => a.startsWith('--limit=')) || '').split('=')[1] || '20', 10);
      const r = pending(projectRoot, area, limit);
      if (r.error) { console.log(`❌ ${r.error}`); break; }
      console.log(`\n  Con descripción vigente: ${r.fresh}`);
      console.log(`  Sin descripción:         ${r.missing.length}`);
      console.log(`  Desactualizados:         ${r.stale.length}`);
      if (r.toDescribe.length) {
        console.log(`\n  Próximos ${r.toDescribe.length} a describir (lote máx ${limit}):`);
        r.toDescribe.forEach(f => console.log(`   - ${f}`));
      }
      console.log('');
      break;
    }
    case 'get': {
      const db = openDB(projectRoot);
      const rows = safe(() => db.prepare(`SELECT * FROM code_summaries WHERE file = ?`).all(normFile(args[0]))) || [];
      safe(() => db.close());
      if (!rows.length) { console.log('(sin descripciones para ese archivo)'); break; }
      rows.forEach(r => {
        const state = summaryState(r, projectRoot);
        console.log(`\n  [${state === 'fresh' ? '✅ vigente' : '⚠️ desactualizado'}] ${r.file}${r.symbol ? '#' + r.symbol : ''}`);
        console.log(`  ${r.summary}`);
      });
      console.log('');
      break;
    }
    case 'status': {
      const db = openDB(projectRoot);
      const total = safe(() => db.prepare(`SELECT COUNT(*) n FROM code_summaries`).get().n, 0);
      const files = safe(() => db.prepare(`SELECT COUNT(DISTINCT file) n FROM code_summaries`).get().n, 0);
      safe(() => db.close());
      console.log(`\n  code_summaries: ${total} descripciones sobre ${files} archivo(s)\n`);
      break;
    }
    default:
      console.log('Uso: node code-summaries.cjs [write <archivo>[#pieza] "<texto>" | pending [área] [--limit=N] | get <archivo> | status]');
  }
}

module.exports = { writeSummary, getFresh, pending };
