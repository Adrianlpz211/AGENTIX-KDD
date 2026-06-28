'use strict';
/**
 * Agentic KDD — Memory Curator v2.0
 * Curación automática real: deduplicación, scoring por relevancia, expiración.
 * 
 * Principio: 30 entradas precisas > 300 entradas ruidosas.
 * 
 * Uso:
 *   node .agentic/grafo/mem-curator.cjs run        → cura completa
 *   node .agentic/grafo/mem-curator.cjs report     → solo reporte, no modifica
 *   node .agentic/grafo/mem-curator.cjs dedup      → solo deduplicar
 *   node .agentic/grafo/mem-curator.cjs score      → solo recalcular scores
 *   node .agentic/grafo/mem-curator.cjs expire     → solo expirar entradas viejas
 */

const fs   = require('fs');
const path = require('path');

const ROOT         = process.cwd();
const MEMORIA_DIR  = path.join(ROOT, '.agentic', 'memoria');
const ERRORES_FILE = path.join(MEMORIA_DIR, 'errores.md');
const PATRONES_FILE= path.join(MEMORIA_DIR, 'patrones.md');
const DECISIONES_FILE = path.join(MEMORIA_DIR, 'decisiones.md');

// ── Configuración de curación ───────────────────────────────────────────────

const CONFIG = {
  // Días sin referencias antes de marcar como candidato a expiración
  EXPIRY_DAYS_LOW_SCORE:  90,
  EXPIRY_DAYS_HIGH_SCORE: 365,
  // Número máximo de entradas por archivo antes de forzar curación
  MAX_ENTRIES_ERRORS:   50,
  MAX_ENTRIES_PATTERNS: 40,
  MAX_ENTRIES_DECISIONS:30,
  // Umbral de similitud para considerar duplicado (0-1)
  SIMILARITY_THRESHOLD: 0.75,
};

// ── Parser de archivos de memoria ───────────────────────────────────────────

function parseMemoryFile(filePath) {
  if (!fs.existsSync(filePath)) return [];

  const content = fs.readFileSync(filePath, 'utf8');
  const entries = [];

  // Detectar entradas por bloques --- o por encabezados ###
  const blocks = content.split(/\n(?=###\s|---\s*\n###)/);

  for (const block of blocks) {
    const titleMatch = block.match(/###\s+(.+)/);
    if (!titleMatch) continue;

    const entry = {
      title:      titleMatch[1].trim(),
      raw:        block,
      confidence: extractField(block, 'confianza') || extractField(block, 'confidence') || 'MEDIA',
      date:       extractField(block, 'fecha') || extractField(block, 'date') || null,
      references: parseInt(extractField(block, 'referencias') || '0'),
      module:     extractField(block, 'módulo') || extractField(block, 'module') || 'global',
      score:      0,
    };

    entry.score = computeScore(entry);
    entries.push(entry);
  }

  return entries;
}

function extractField(text, field) {
  const regex = new RegExp(`\\*\\*${field}\\*\\*:\\s*(.+)`, 'i');
  const match = text.match(regex);
  return match ? match[1].trim() : null;
}

// ── Scoring ──────────────────────────────────────────────────────────────────

function computeScore(entry) {
  let score = 0;

  // Confianza base
  if (entry.confidence === 'ALTA')  score += 40;
  if (entry.confidence === 'MEDIA') score += 20;
  if (entry.confidence === 'BAJA')  score += 5;

  // Referencias acumuladas
  score += Math.min(entry.references * 5, 30);

  // Penalización por antigüedad
  if (entry.date) {
    const daysSince = daysSinceDate(entry.date);
    if (daysSince > 180) score -= 10;
    if (daysSince > 365) score -= 20;
  }

  // Bonus por módulo global
  if (entry.module === 'global') score += 5;

  return Math.max(0, score);
}

function daysSinceDate(dateStr) {
  try {
    const d = new Date(dateStr);
    return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
  } catch { return 0; }
}

// ── Deduplicación ────────────────────────────────────────────────────────────

function cosineSimilarity(a, b) {
  const wordsA = tokenize(a);
  const wordsB = tokenize(b);
  const vocab  = [...new Set([...wordsA, ...wordsB])];

  const vecA = vocab.map(w => wordsA.filter(x => x === w).length);
  const vecB = vocab.map(w => wordsB.filter(x => x === w).length);

  const dot    = vecA.reduce((s, v, i) => s + v * vecB[i], 0);
  const magA   = Math.sqrt(vecA.reduce((s, v) => s + v * v, 0));
  const magB   = Math.sqrt(vecB.reduce((s, v) => s + v * v, 0));

  return (magA && magB) ? dot / (magA * magB) : 0;
}

function tokenize(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9áéíóúñü\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3);
}

function deduplicateEntries(entries) {
  const kept    = [];
  const removed = [];

  for (let i = 0; i < entries.length; i++) {
    let isDuplicate = false;

    for (let j = 0; j < kept.length; j++) {
      const sim = cosineSimilarity(entries[i].title + ' ' + entries[i].raw,
                                   kept[j].title   + ' ' + kept[j].raw);
      if (sim >= CONFIG.SIMILARITY_THRESHOLD) {
        // Keep the one with higher score
        if (entries[i].score > kept[j].score) {
          removed.push(kept[j]);
          kept[j] = entries[i];
        } else {
          removed.push(entries[i]);
        }
        isDuplicate = true;
        break;
      }
    }

    if (!isDuplicate) kept.push(entries[i]);
  }

  return { kept, removed };
}

// ── Expiración ───────────────────────────────────────────────────────────────

function expireEntries(entries) {
  const now     = Date.now();
  const kept    = [];
  const expired = [];

  for (const entry of entries) {
    const maxDays = entry.score >= 40
      ? CONFIG.EXPIRY_DAYS_HIGH_SCORE
      : CONFIG.EXPIRY_DAYS_LOW_SCORE;

    if (entry.date) {
      const days = daysSinceDate(entry.date);
      if (days > maxDays && entry.confidence === 'BAJA') {
        expired.push(entry);
        continue;
      }
    }

    kept.push(entry);
  }

  return { kept, expired };
}

// ── Reconstruir archivo ──────────────────────────────────────────────────────

function rebuildFile(filePath, entries, headerLines) {
  // Sort by score descending
  const sorted = [...entries].sort((a, b) => b.score - a.score);

  const lines = [];
  if (headerLines) lines.push(...headerLines, '');

  for (const entry of sorted) {
    lines.push(entry.raw.trim());
    lines.push('');
  }

  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
}

function extractHeader(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const headerLines = [];
  for (const line of lines) {
    if (line.startsWith('### ')) break;
    headerLines.push(line);
  }
  return headerLines;
}

// ── Curación principal ───────────────────────────────────────────────────────

function curateFile(filePath, maxEntries, label) {
  const result = {
    file: label,
    before: 0, after: 0,
    deduped: 0, expired: 0, sorted: true,
    changes: [],
  };

  if (!fs.existsSync(filePath)) {
    result.changes.push('archivo no encontrado — sin cambios');
    return result;
  }

  const header  = extractHeader(filePath);
  const entries = parseMemoryFile(filePath);
  result.before = entries.length;

  // 1. Recalcular scores
  entries.forEach(e => { e.score = computeScore(e); });

  // 2. Deduplicar
  const { kept: afterDedup, removed } = deduplicateEntries(entries);
  result.deduped = removed.length;
  if (removed.length > 0) {
    result.changes.push(`${removed.length} duplicados eliminados`);
  }

  // 3. Expirar
  const { kept: afterExpire, expired } = expireEntries(afterDedup);
  result.expired = expired.length;
  if (expired.length > 0) {
    result.changes.push(`${expired.length} entradas expiradas (BAJA confianza, sin uso)`);
  }

  // 4. Si supera máximo, descartar las de menor score
  let finalEntries = afterExpire;
  if (finalEntries.length > maxEntries) {
    const cutoff = finalEntries.length - maxEntries;
    result.changes.push(`${cutoff} entradas de bajo score descartadas (límite: ${maxEntries})`);
    finalEntries = finalEntries.sort((a, b) => b.score - a.score).slice(0, maxEntries);
  }

  result.after = finalEntries.length;

  // 5. Reescribir ordenado por score
  rebuildFile(filePath, finalEntries, header);

  if (result.changes.length === 0) {
    result.changes.push('sin cambios necesarios');
  }

  return result;
}

// ── Report ───────────────────────────────────────────────────────────────────

function report() {
  console.log('\n══════════════════════════════════════════════════');
  console.log('  🧠 Memory Curator — Análisis');
  console.log('══════════════════════════════════════════════════');

  const files = [
    { path: ERRORES_FILE,    label: 'errores.md',    max: CONFIG.MAX_ENTRIES_ERRORS    },
    { path: PATRONES_FILE,   label: 'patrones.md',   max: CONFIG.MAX_ENTRIES_PATTERNS  },
    { path: DECISIONES_FILE, label: 'decisiones.md', max: CONFIG.MAX_ENTRIES_DECISIONS },
  ];

  for (const f of files) {
    const entries = parseMemoryFile(f.path);
    console.log(`\n  📄 ${f.label}: ${entries.length} entradas`);

    if (entries.length === 0) {
      console.log('     (vacío)');
      continue;
    }

    const sorted = [...entries].sort((a, b) => b.score - a.score);
    const high   = sorted.filter(e => e.score >= 40).length;
    const med    = sorted.filter(e => e.score >= 20 && e.score < 40).length;
    const low    = sorted.filter(e => e.score < 20).length;

    console.log(`     Score ALTO (≥40): ${high} | MEDIO (20-39): ${med} | BAJO (<20): ${low}`);
    if (entries.length > f.max) {
      console.log(`     ⚠️  Supera límite (${f.max}) — curación recomendada`);
    }

    // Show duplicates preview
    const { removed } = deduplicateEntries(entries);
    if (removed.length > 0) {
      console.log(`     🔁 Posibles duplicados: ${removed.length}`);
    }
  }

  console.log('\n══════════════════════════════════════════════════\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const cmd = process.argv[2] || 'run';

  if (cmd === 'report') {
    report();
    process.exit(0);
  }

  if (cmd === 'run' || cmd === 'dedup' || cmd === 'score' || cmd === 'expire') {
    console.log('\n══════════════════════════════════════════════════');
    console.log('  🧠 Memory Curator — Curación');
    console.log('══════════════════════════════════════════════════\n');

    const files = [
      { path: ERRORES_FILE,    max: CONFIG.MAX_ENTRIES_ERRORS,    label: 'errores.md'    },
      { path: PATRONES_FILE,   max: CONFIG.MAX_ENTRIES_PATTERNS,  label: 'patrones.md'   },
      { path: DECISIONES_FILE, max: CONFIG.MAX_ENTRIES_DECISIONS, label: 'decisiones.md' },
    ];

    let totalRemoved = 0;

    for (const f of files) {
      const result = curateFile(f.path, f.max, f.label);
      totalRemoved += result.deduped + result.expired;

      const delta = result.before - result.after;
      console.log(`  ${f.label}:`);
      console.log(`    Antes: ${result.before} → Después: ${result.after} (${delta > 0 ? '-' + delta : 'sin cambio'})`);
      for (const c of result.changes) {
        console.log(`    ✓ ${c}`);
      }
      console.log('');
    }

    console.log(`  Total eliminadas: ${totalRemoved}`);
    console.log('══════════════════════════════════════════════════\n');

    process.exit(0);
  }

  console.log('Uso: node mem-curator.cjs [run|report|dedup|score|expire]');
}

module.exports = { curateFile, parseMemoryFile, computeScore, deduplicateEntries, expireEntries };
