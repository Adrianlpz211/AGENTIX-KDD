/**
 * Agentic KDD — Change Classifier v1.0 (Pieza 1 del plan Understand-Anything)
 *
 * Distingue TRES niveles de cambio en un archivo, comparando contra una foto
 * (fingerprint) previa guardada en la tabla file_fingerprints:
 *
 *   NONE       → hash de contenido idéntico (no cambió ni un byte)
 *   COSMETIC   → el contenido cambió pero la ESTRUCTURA es la misma
 *                (mismas funciones/clases/imports con mismas firmas —
 *                 típicamente comentarios, formato, cuerpo interno)
 *   STRUCTURAL → cambió la firma estructural (función nueva/borrada,
 *                parámetros distintos, import agregado/quitado, etc.)
 *
 * Para qué: knowledge-validator hoy marca conocimiento como SOSPECHOSO ante
 * CUALQUIER cambio de los archivos referenciados (usa size+mtime — hasta
 * re-guardar un archivo idéntico dispara la alerta). Con esto, solo lo
 * STRUCTURAL invalida conocimiento → alertas creíbles, menos ruido.
 *
 * Conservador por diseño:
 *   - Archivo sin extractor (json, md, css...) → cualquier cambio = STRUCTURAL.
 *   - Archivo sin fingerprint previo (baseline) → UNKNOWN (tratado como
 *     STRUCTURAL por los consumidores).
 *   - Si algo falla → UNKNOWN, jamás lanza.
 *
 * La firma estructural reusa los MISMOS extractores de ast-indexer.cjs
 * (export aditivo EXTRACTORS) — una sola fuente de verdad de parsing.
 *
 * Uso CLI:
 *   node change-classifier.cjs snapshot              — foto baseline de todos los archivos indexados
 *   node change-classifier.cjs classify <archivo...> — clasificar archivo(s) contra su baseline
 *   node change-classifier.cjs status                — resumen de la tabla de fingerprints
 */

'use strict';

const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');

// ─── DB (mismo patrón de fallback que el resto del grafo) ────────────────────

function resolveDbPath(projectRoot) {
  // Generaciones distintas guardan la DB en lugares distintos — probar ambos.
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
    db.exec(`CREATE TABLE IF NOT EXISTS file_fingerprints (
      file           TEXT PRIMARY KEY,
      content_hash   TEXT NOT NULL,
      structural_sig TEXT,
      supported      INTEGER DEFAULT 0,
      updated_at     TEXT DEFAULT (datetime('now'))
    )`);
  } catch {}
  return db;
}

const safe = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };

// ─── FINGERPRINT ──────────────────────────────────────────────────────────────

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

/**
 * Firma estructural de un archivo: hash de la lista ORDENADA de
 * imports + símbolos (kind:nombre:exported:firma). Si dos versiones del
 * archivo producen la misma lista, el cambio fue solo cosmético.
 */
function structuralSignature(content, filePath) {
  let indexer;
  try { indexer = require('./ast-indexer.cjs'); } catch { return null; }
  const language = safe(() => indexer.detectLanguage(filePath));
  if (!language) return null;
  const extractor = indexer.EXTRACTORS && indexer.EXTRACTORS[language];
  if (!extractor) return null;

  const extracted = safe(() => extractor(content, filePath));
  if (!extracted) return null;

  const imports = (extracted.edges || [])
    .filter(e => e.kind === 'IMPORTS')
    .map(e => `IMPORT:${e.to_symbol}`)
    .sort();

  const symbols = (extracted.symbols || [])
    .map(s => `${s.kind}:${s.symbol_name}:${s.exported ? 1 : 0}:${(s.signature || '').replace(/\s+/g, ' ').trim()}`)
    .sort();

  return sha256([...imports, ...symbols].join('\n'));
}

/**
 * Fingerprint completo de un archivo tal como está AHORA en disco.
 * → { file, contentHash, structuralSig, supported, missing }
 */
function fingerprintFile(filePath, projectRoot) {
  projectRoot = projectRoot || process.cwd();
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
  const relPath = path.relative(projectRoot, fullPath);

  if (!fs.existsSync(fullPath)) {
    return { file: relPath, contentHash: null, structuralSig: null, supported: false, missing: true };
  }

  let content;
  try { content = fs.readFileSync(fullPath, 'utf8'); }
  catch { return { file: relPath, contentHash: null, structuralSig: null, supported: false, missing: true }; }

  const contentHash = sha256(content);
  const sig = structuralSignature(content, fullPath);

  return {
    file: relPath,
    contentHash,
    structuralSig: sig,
    supported: sig !== null,
    missing: false,
  };
}

// ─── SNAPSHOT (guardar baseline) ──────────────────────────────────────────────

function snapshotFiles(files, projectRoot, db) {
  projectRoot = projectRoot || process.cwd();
  const ownDb = !db;
  if (ownDb) db = openDB(projectRoot);
  if (!db) return { ok: false, reason: 'DB unavailable' };

  let saved = 0, skipped = 0;
  const upsert = safe(() => db.prepare(`
    INSERT INTO file_fingerprints (file, content_hash, structural_sig, supported, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(file) DO UPDATE SET
      content_hash = excluded.content_hash,
      structural_sig = excluded.structural_sig,
      supported = excluded.supported,
      updated_at = excluded.updated_at
  `));
  if (!upsert) { if (ownDb) safe(() => db.close()); return { ok: false, reason: 'prepare failed' }; }

  for (const f of files) {
    const fp = fingerprintFile(f, projectRoot);
    if (fp.missing) { skipped++; continue; }
    const ok = safe(() => { upsert.run(fp.file, fp.contentHash, fp.structuralSig, fp.supported ? 1 : 0); return true; });
    if (ok) saved++; else skipped++;
  }

  if (ownDb) safe(() => db.close());
  return { ok: true, saved, skipped };
}

/** Snapshot de todos los archivos que el AST indexer conoce. */
function snapshotAll(projectRoot) {
  projectRoot = projectRoot || process.cwd();
  const db = openDB(projectRoot);
  if (!db) return { ok: false, reason: 'DB unavailable' };
  const files = (safe(() => db.prepare('SELECT DISTINCT file FROM ast_symbols').all()) || []).map(r => r.file);
  const result = snapshotFiles(files, projectRoot, db);
  safe(() => db.close());
  return { ...result, total: files.length };
}

// ─── CLASSIFY ─────────────────────────────────────────────────────────────────

/**
 * Clasifica el estado ACTUAL de un archivo contra su baseline guardado.
 * → { file, level: 'NONE'|'COSMETIC'|'STRUCTURAL'|'UNKNOWN', reason }
 */
function classifyFile(filePath, projectRoot, db) {
  projectRoot = projectRoot || process.cwd();
  const ownDb = !db;
  if (ownDb) db = openDB(projectRoot);
  if (!db) return { file: filePath, level: 'UNKNOWN', reason: 'DB unavailable' };

  const current = fingerprintFile(filePath, projectRoot);
  const stored = safe(() => db.prepare('SELECT * FROM file_fingerprints WHERE file = ?').get(current.file));
  if (ownDb) safe(() => db.close());

  if (current.missing) {
    // Archivo borrado: si había baseline, eso ES un cambio estructural.
    return stored
      ? { file: current.file, level: 'STRUCTURAL', reason: 'file deleted since baseline' }
      : { file: current.file, level: 'UNKNOWN', reason: 'file missing and no baseline' };
  }

  if (!stored) return { file: current.file, level: 'UNKNOWN', reason: 'no baseline snapshot yet' };

  if (current.contentHash === stored.content_hash) {
    return { file: current.file, level: 'NONE', reason: 'content identical' };
  }

  // Contenido cambió — ¿la estructura también?
  if (current.supported && stored.supported && stored.structural_sig) {
    if (current.structuralSig === stored.structural_sig) {
      return { file: current.file, level: 'COSMETIC', reason: 'content changed but structure (symbols/imports/signatures) identical' };
    }
    return { file: current.file, level: 'STRUCTURAL', reason: 'structural signature changed' };
  }

  // Sin soporte de extractor → conservador
  return { file: current.file, level: 'STRUCTURAL', reason: 'no extractor support — any change treated as structural (conservative)' };
}

/**
 * ¿TODOS estos archivos cambiaron solo cosméticamente (o nada)?
 * Cualquier STRUCTURAL o UNKNOWN → false. Es el helper que consume
 * knowledge-validator: solo suprime la alerta cuando hay CERTEZA de que
 * ningún cambio fue estructural.
 */
function allCosmetic(files, projectRoot) {
  if (!files || !files.length) return false;
  projectRoot = projectRoot || process.cwd();
  const db = openDB(projectRoot);
  if (!db) return false;
  let result = true;
  const details = [];
  for (const f of files) {
    const c = classifyFile(f, projectRoot, db);
    details.push(c);
    if (c.level !== 'NONE' && c.level !== 'COSMETIC') { result = false; break; }
  }
  safe(() => db.close());
  return result;
}

// ─── MATRIZ DE DECISIÓN (estilo Understand-Anything) ─────────────────────────

/**
 * Dado un lote de clasificaciones, decide el nivel de actualización necesario.
 * → { action: 'SKIP'|'PARTIAL_UPDATE'|'ARCHITECTURE_UPDATE'|'FULL_UPDATE',
 *     filesToReanalyze, reason }
 */
function classifyUpdate(classifications, totalFilesInGraph, newDirs = 0) {
  const structural = classifications.filter(c => c.level === 'STRUCTURAL' || c.level === 'UNKNOWN');
  const cosmetic = classifications.filter(c => c.level === 'COSMETIC');

  if (structural.length === 0) {
    return {
      action: 'SKIP',
      filesToReanalyze: [],
      reason: cosmetic.length > 0
        ? `${cosmetic.length} archivo(s) con cambios solo cosméticos — nada estructural que reanalizar`
        : 'Sin cambios detectados',
    };
  }

  const files = structural.map(c => c.file);
  const pct = totalFilesInGraph > 0 ? structural.length / totalFilesInGraph : 0;

  if (structural.length > 30 || pct > 0.5) {
    return {
      action: 'FULL_UPDATE',
      filesToReanalyze: files,
      reason: `${structural.length} archivos con cambios estructurales (${structural.length > 30 ? '>30 archivos' : '>50% del proyecto'}) — reanálisis completo recomendado`,
    };
  }

  if (newDirs > 0 || structural.length > 10) {
    return {
      action: 'ARCHITECTURE_UPDATE',
      filesToReanalyze: files,
      reason: newDirs > 0
        ? `${newDirs} carpeta(s) nueva(s)/borrada(s) — revisar arquitectura`
        : `${structural.length} archivos estructurales (>10) — revisar arquitectura`,
    };
  }

  return {
    action: 'PARTIAL_UPDATE',
    filesToReanalyze: files,
    reason: `${structural.length} archivo(s) con cambios estructurales — reanálisis parcial`,
  };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const [,, cmd, ...args] = process.argv;
  const projectRoot = process.cwd();

  switch (cmd) {
    case 'snapshot': {
      console.log('\n[CLASSIFIER] Snapshot baseline de archivos indexados...');
      const r = snapshotAll(projectRoot);
      if (!r.ok) { console.log(`❌ ${r.reason}`); break; }
      console.log(`✅ ${r.saved}/${r.total} fingerprints guardados (${r.skipped} omitidos)\n`);
      break;
    }

    case 'classify': {
      if (!args.length) { console.log('Uso: change-classifier.cjs classify <archivo...>'); break; }
      const results = args.map(f => classifyFile(f, projectRoot));
      const icon = { NONE: '⚪', COSMETIC: '🟡', STRUCTURAL: '🔴', UNKNOWN: '❓' };
      console.log('');
      results.forEach(r => console.log(`  ${icon[r.level] || '?'} ${r.level.padEnd(10)} ${r.file}  — ${r.reason}`));
      const decision = classifyUpdate(results, safe(() => {
        const db = openDB(projectRoot);
        const n = db.prepare('SELECT COUNT(DISTINCT file) n FROM ast_symbols').get().n;
        db.close(); return n;
      }, 0) || 0);
      console.log(`\n  Decisión: ${decision.action} — ${decision.reason}\n`);
      break;
    }

    case 'status': {
      const db = openDB(projectRoot);
      if (!db) { console.log('❌ DB unavailable'); break; }
      const total = safe(() => db.prepare('SELECT COUNT(*) n FROM file_fingerprints').get().n, 0);
      const supported = safe(() => db.prepare('SELECT COUNT(*) n FROM file_fingerprints WHERE supported = 1').get().n, 0);
      const last = safe(() => db.prepare('SELECT MAX(updated_at) t FROM file_fingerprints').get().t);
      safe(() => db.close());
      console.log(`\n  file_fingerprints: ${total} archivos (${supported} con firma estructural)`);
      console.log(`  Último snapshot: ${last || 'nunca'}\n`);
      break;
    }

    default:
      console.log('Uso: node change-classifier.cjs [snapshot | classify <archivo...> | status]');
  }
}

module.exports = { fingerprintFile, classifyFile, allCosmetic, classifyUpdate, snapshotFiles, snapshotAll, structuralSignature };
