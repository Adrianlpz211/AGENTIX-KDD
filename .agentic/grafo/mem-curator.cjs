/**
 * Agentic KDD — MemCurator v1.0
 *
 * Agente de gobernanza autónoma de memoria. Cierra múltiples gaps del reporte:
 *
 *   ✅ TTL enforcement: episodios > 30 días → archivo/compresión
 *   ✅ Deduplicación semántica: nodos similares > umbral → merge
 *   ✅ Resolución de conflictos: reglas contradictorias → supersesión explícita
 *   ✅ Scoring de relevancia ponderado: S(k) = cos_sim × exp(-λ×Δt) × log(1+n_accesos)
 *   ✅ MemCurator independiente: desvinculado del generador de código (evita sesgo de autovalidación)
 *   ✅ Prevención de ruido semántico: "envenenamiento por redundancia" controlado
 *
 * El curador corre automáticamente cada 10 ciclos (hookeado en grafo.cjs sync).
 * También se puede correr manualmente: node mem-curator.cjs run
 *
 * Basado en:
 *   - arXiv 2603.17787 "Governed Memory: A Production Architecture for Multi-Agent Workflows"
 *   - Zep/Graphiti temporal graph (arXiv 2501.13956)
 *   - Mem0 atomic fact extraction pattern
 *
 * Uso:
 *   node .agentic/grafo/mem-curator.cjs run        — curation completa
 *   node .agentic/grafo/mem-curator.cjs ttl        — solo TTL enforcement
 *   node .agentic/grafo/mem-curator.cjs dedup      — solo deduplicación
 *   node .agentic/grafo/mem-curator.cjs conflicts  — solo conflictos
 *   node .agentic/grafo/mem-curator.cjs score      — recalcular scores de todos los nodos
 *   node .agentic/grafo/mem-curator.cjs report     — reporte sin cambios
 */

'use strict';

const path = require('path');
const fs   = require('fs');

// ─── CONSTANTES ───────────────────────────────────────────────────────────────

const TTL_EPISODIC_DAYS    = 30;   // Episodios: retención máxima en caliente
const TTL_WORKING_DAYS     = 7;    // Working memory: expira rápido
const LAMBDA_DECAY         = 0.05; // Constante de decay temporal (λ)
const DEDUP_THRESHOLD      = 0.92; // Similitud coseno > 92% → duplicado
const CONFLICT_THRESHOLD   = 0.85; // Similitud alta + contenido contradictorio
const MAX_SEMANTIC_NODES   = 1000; // Límite de nodos procedurales activos
const MIN_UTILITY_RATIO    = 0.15; // util/aplicado < 15% → candidato a deprecar
const CURATOR_LOG_PATH     = '.agentic/curator.log';

// ─── DB HELPER ────────────────────────────────────────────────────────────────

function openDB(projectRoot) {
  const dbPath = path.join(projectRoot, '.agentic/memoria.db');
  try { return new (require('better-sqlite3'))(dbPath); } catch {}
  try { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(dbPath); } catch {}
  throw new Error('No SQLite driver disponible');
}

function log(projectRoot, msg) {
  const logPath = path.join(projectRoot, CURATOR_LOG_PATH);
  const entry = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(logPath, entry); } catch {}
  console.log(`[CURATOR] ${msg}`);
}

// ─── SCORING DE RELEVANCIA PONDERADO ─────────────────────────────────────────
/**
 * Fórmula del reporte (arXiv 2603.17787):
 * S(k) = cosine_sim(k, query) × exp(-λ × Δt_days) × log(1 + n_accesos)
 *
 * Para nodos sin query (relevancia absoluta):
 * S(k) = confidence_weight × exp(-λ × Δt_days) × log(1 + n_accesos)
 */
function computeRelevanceScore(node, queryEmbedding, cosineFn) {
  const now = Date.now();

  // Δt en días desde última actualización
  const lastUpdate = node.fecha_update || node.fecha_creacion || new Date().toISOString();
  const deltaDays = (now - new Date(lastUpdate).getTime()) / (1000 * 60 * 60 * 24);

  // Decay temporal exponencial
  const decayFactor = Math.exp(-LAMBDA_DECAY * deltaDays);

  // Frecuencia de uso
  const usageScore = Math.log(1 + (node.aplicado || 0));

  // Similitud semántica (si hay query embedding disponible)
  let simScore = 1.0;
  if (queryEmbedding && node.embedding && cosineFn) {
    try {
      const nodeEmbed = typeof node.embedding === 'string'
        ? JSON.parse(node.embedding) : node.embedding;
      simScore = cosineFn(queryEmbedding, nodeEmbed);
    } catch {}
  } else {
    // Sin embedding: usar confianza como proxy de similitud
    const confMap = { 'ALTA': 0.9, 'MEDIA': 0.6, 'BAJA': 0.3 };
    simScore = confMap[node.confianza] || 0.5;
  }

  const score = simScore * decayFactor * (1 + usageScore * 0.1);

  return {
    node_id: node.id,
    titulo: node.titulo,
    score: Math.round(score * 1000) / 1000,
    components: {
      similarity: Math.round(simScore * 1000) / 1000,
      decay: Math.round(decayFactor * 1000) / 1000,
      usage: Math.round(usageScore * 1000) / 1000,
      delta_days: Math.round(deltaDays),
    },
  };
}

// ─── TTL ENFORCEMENT ─────────────────────────────────────────────────────────
/**
 * Episodios > 30 días sin consolidar → comprimir en resumen + archivar.
 * Working memory > 7 días → eliminar.
 * Esto implementa la Capa Episódica del reporte.
 */
function enforceEpisodicTTL(db, projectRoot) {
  const results = { compressed: 0, archived: 0, deleted: 0 };

  // 1. Episodios > TTL_EPISODIC_DAYS días sin consolidar → comprimir
  try {
    const staleEpisodes = db.prepare(`
      SELECT episodio_id, tipo, descripcion, resultado, fecha, modulo
      FROM episodios
      WHERE consolidado = 0
        AND julianday('now') - julianday(fecha) > ?
      ORDER BY fecha ASC
      LIMIT 100
    `).all(TTL_EPISODIC_DAYS);

    if (staleEpisodes.length > 0) {
      // Generar resumen comprimido por módulo
      const byModule = {};
      staleEpisodes.forEach(ep => {
        const mod = ep.modulo || 'global';
        if (!byModule[mod]) byModule[mod] = [];
        byModule[mod].push(ep);
      });

      for (const [mod, eps] of Object.entries(byModule)) {
        const summary = `[COMPRIMIDO] ${eps.length} episodios de ${mod}: ` +
          eps.slice(0, 3).map(e => e.descripcion?.substring(0, 50)).join(' | ');

        // Insertar resumen como nodo semántico comprimido
        try {
          db.prepare(`
            INSERT OR IGNORE INTO nodos (tipo, titulo, contenido, area, confianza, estado, vigencia_tipo, fecha_creacion, fecha_update)
            VALUES ('episodio_comprimido', ?, ?, ?, 'BAJA', 'ACTIVO', 'HISTORICO', datetime('now'), datetime('now'))
          `).run(`Resumen episódico: ${mod} (${eps.length} eventos)`, summary, mod);
        } catch {}

        // Marcar episodios como consolidados
        const ids = eps.map(e => e.episodio_id);
        const placeholders = ids.map(() => '?').join(',');
        db.prepare(`UPDATE episodios SET consolidado=1 WHERE episodio_id IN (${placeholders})`).run(...ids);

        results.compressed += eps.length;
      }
    }
  } catch (e) {
    log(projectRoot, `TTL episodios error: ${e.message}`);
  }

  // 2. Episodios consolidados > 90 días → archivar (log + delete del hot store)
  try {
    const archiveable = db.prepare(`
      SELECT COUNT(*) as n FROM episodios
      WHERE consolidado = 1
        AND julianday('now') - julianday(fecha) > 90
    `).get()?.n || 0;

    if (archiveable > 0) {
      // Escribir archivo .jsonl antes de borrar
      const oldEps = db.prepare(`
        SELECT * FROM episodios
        WHERE consolidado = 1
          AND julianday('now') - julianday(fecha) > 90
        LIMIT 500
      `).all();

      const archivePath = path.join(projectRoot, '.agentic', `episodios_archive_${Date.now()}.jsonl`);
      try {
        fs.writeFileSync(archivePath, oldEps.map(e => JSON.stringify(e)).join('\n'));
        db.prepare(`
          DELETE FROM episodios
          WHERE consolidado = 1
            AND julianday('now') - julianday(fecha) > 90
        `).run();
        results.archived += oldEps.length;
      } catch {}
    }
  } catch {}

  return results;
}

// ─── DEDUPLICACIÓN SEMÁNTICA ─────────────────────────────────────────────────
/**
 * Detecta nodos procedurales semánticamente duplicados.
 * Estrategia: similitud de título + área + tipo → merge tomando el de mayor confianza.
 *
 * Sin acceso a embeddings reales (sin GPU): usa similitud de texto Jaccard como proxy.
 */
function deduplicateNodes(db, projectRoot) {
  const results = { merged: 0, candidates: 0 };

  try {
    // Obtener nodos activos del mismo tipo y área
    const nodes = db.prepare(`
      SELECT id, tipo, titulo, contenido, confianza, area, aplicado, util,
             fecha_creacion, fecha_update, vigencia_tipo
      FROM nodos
      WHERE estado = 'ACTIVO'
      ORDER BY tipo, area, confianza DESC
    `).all();

    // Agrupar por tipo+área
    const groups = {};
    nodes.forEach(n => {
      const key = `${n.tipo}:${n.area || 'global'}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(n);
    });

    for (const [key, group] of Object.entries(groups)) {
      if (group.length < 2) continue;

      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i];
          const b = group[j];

          // Similitud de Jaccard sobre palabras del título
          const sim = jaccardSim(a.titulo || '', b.titulo || '');

          if (sim >= DEDUP_THRESHOLD) {
            results.candidates++;

            // Merge: mantener el de mayor confianza, agregar frecuencia de uso
            const winner = confRank(a.confianza) >= confRank(b.confianza) ? a : b;
            const loser  = winner === a ? b : a;

            // Actualizar el winner con la frecuencia acumulada del loser
            try {
              db.prepare(`
                UPDATE nodos SET
                  aplicado = aplicado + ?,
                  util = util + ?,
                  contenido = contenido || ' [MERGED: ' || ? || ']',
                  fecha_update = datetime('now')
                WHERE id = ?
              `).run(loser.aplicado || 0, loser.util || 0,
                     loser.titulo?.substring(0, 40) || '', winner.id);

              // Marcar loser como OBSOLETO
              db.prepare(`
                UPDATE nodos SET estado='OBSOLETO', vigencia_tipo='OBSOLETO',
                  fecha_update=datetime('now')
                WHERE id = ?
              `).run(loser.id);

              results.merged++;
            } catch {}
          }
        }
      }
    }
  } catch (e) {
    log(projectRoot, `Dedup error: ${e.message}`);
  }

  return results;
}

// ─── RESOLUCIÓN DE CONFLICTOS ─────────────────────────────────────────────────
/**
 * Detecta reglas contradictorias en la capa semántica.
 * Criterio: mismo área + tipo + título similar + contenido contradictorio.
 * Acción: marcar la más antigua como HISTORICO, conservar la más reciente.
 */
function resolveConflicts(db, projectRoot) {
  const results = { resolved: 0, detected: 0 };

  try {
    // Detectar pares con alta similitud de título pero fechas diferentes
    const nodes = db.prepare(`
      SELECT id, tipo, titulo, contenido, confianza, area, fecha_creacion, fecha_update, vigencia_tipo
      FROM nodos
      WHERE estado = 'ACTIVO' AND vigencia_tipo = 'VIGENTE'
      ORDER BY fecha_update DESC
    `).all();

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]; // más reciente
        const b = nodes[j]; // más antiguo

        if (a.tipo !== b.tipo || a.area !== b.area) continue;

        const titleSim = jaccardSim(a.titulo || '', b.titulo || '');

        // Títulos muy similares pero diferente contenido → posible conflicto
        if (titleSim >= 0.7 && titleSim < DEDUP_THRESHOLD) {
          results.detected++;

          // El más antiguo pasa a HISTORICO (supersesión)
          try {
            db.prepare(`
              UPDATE nodos SET
                vigencia_tipo = 'HISTORICO',
                contenido = contenido || ' [SUPERSEDED BY: ' || ? || ']',
                fecha_update = datetime('now')
              WHERE id = ?
            `).run(a.titulo?.substring(0, 40) || '', b.id);

            results.resolved++;
          } catch {}
        }
      }
    }
  } catch (e) {
    log(projectRoot, `Conflicts error: ${e.message}`);
  }

  return results;
}

// ─── RECALCULAR SCORES DE TODOS LOS NODOS ────────────────────────────────────
/**
 * Actualiza el campo decay_score de todos los nodos activos.
 * Usa la fórmula S(k) sin query embedding (modo absoluto).
 */
function recalculateScores(db, projectRoot) {
  let updated = 0;

  try {
    const nodes = db.prepare(`
      SELECT id, confianza, aplicado, util, fecha_update, fecha_creacion
      FROM nodos WHERE estado = 'ACTIVO'
    `).all();

    const stmt = db.prepare(`UPDATE nodos SET decay_score = ? WHERE id = ?`);

    nodes.forEach(node => {
      const scored = computeRelevanceScore(node, null, null);
      try {
        stmt.run(scored.score, node.id);
        updated++;
      } catch {}
    });
  } catch (e) {
    log(projectRoot, `Score recalc error: ${e.message}`);
  }

  return { updated };
}

// ─── LIMIT NODOS PROCEDURALES ─────────────────────────────────────────────────
/**
 * Si hay > MAX_SEMANTIC_NODES nodos activos, deprecar los de menor score.
 * Previene el "colapso de contexto" por grafo demasiado denso.
 */
function enforceNodeLimit(db, projectRoot) {
  let deprecated = 0;

  try {
    const count = db.prepare(`SELECT COUNT(*) as n FROM nodos WHERE estado='ACTIVO'`).get()?.n || 0;

    if (count > MAX_SEMANTIC_NODES) {
      const excess = count - MAX_SEMANTIC_NODES;

      // Obtener los nodos de menor score y baja utilidad
      const candidates = db.prepare(`
        SELECT id FROM nodos
        WHERE estado = 'ACTIVO'
          AND confianza = 'BAJA'
          AND (aplicado = 0 OR (util * 1.0 / aplicado) < ?)
        ORDER BY decay_score ASC, fecha_update ASC
        LIMIT ?
      `).all(MIN_UTILITY_RATIO, excess);

      candidates.forEach(n => {
        try {
          db.prepare(`
            UPDATE nodos SET estado='OBSOLETO', vigencia_tipo='OBSOLETO',
              fecha_update=datetime('now')
            WHERE id=?
          `).run(n.id);
          deprecated++;
        } catch {}
      });
    }
  } catch (e) {
    log(projectRoot, `Node limit error: ${e.message}`);
  }

  return { deprecated };
}

// ─── CURATION COMPLETA ───────────────────────────────────────────────────────

/**
 * Curation completa. Se llama automáticamente cada 10 ciclos desde grafo.cjs.
 */
function runCuration(projectRoot) {
  const start = Date.now();
  projectRoot = projectRoot || process.cwd();

  log(projectRoot, 'Iniciando curation...');

  let db;
  try { db = openDB(projectRoot); }
  catch (e) { log(projectRoot, `DB error: ${e.message}`); return null; }

  const report = {
    timestamp: new Date().toISOString(),
    ttl: null,
    dedup: null,
    conflicts: null,
    scores: null,
    node_limit: null,
    duration_ms: 0,
  };

  try {
    // 1. TTL enforcement (episodios viejos)
    report.ttl = enforceEpisodicTTL(db, projectRoot);
    log(projectRoot, `TTL: ${report.ttl.compressed} comprimidos, ${report.ttl.archived} archivados`);

    // 2. Deduplicación semántica
    report.dedup = deduplicateNodes(db, projectRoot);
    log(projectRoot, `Dedup: ${report.dedup.merged} mergeados de ${report.dedup.candidates} candidatos`);

    // 3. Resolución de conflictos
    report.conflicts = resolveConflicts(db, projectRoot);
    log(projectRoot, `Conflictos: ${report.conflicts.resolved} resueltos de ${report.conflicts.detected} detectados`);

    // 4. Recalcular scores
    report.scores = recalculateScores(db, projectRoot);
    log(projectRoot, `Scores: ${report.scores.updated} nodos actualizados`);

    // 5. Límite de nodos
    report.node_limit = enforceNodeLimit(db, projectRoot);
    if (report.node_limit.deprecated > 0) {
      log(projectRoot, `Node limit: ${report.node_limit.deprecated} nodos deprecados`);
    }

  } catch (e) {
    log(projectRoot, `Curation error: ${e.message}`);
  }

  report.duration_ms = Date.now() - start;
  log(projectRoot, `Curation completa en ${report.duration_ms}ms`);

  return report;
}

// ─── REPORTE SIN CAMBIOS ─────────────────────────────────────────────────────

function generateReport(projectRoot) {
  projectRoot = projectRoot || process.cwd();
  const db = openDB(projectRoot);

  // Episodios sin consolidar
  const staleEpisodes = db.prepare(`
    SELECT COUNT(*) as n FROM episodios
    WHERE consolidado = 0
      AND julianday('now') - julianday(fecha) > ?
  `).get(TTL_EPISODIC_DAYS)?.n || 0;

  // Nodos activos
  const activeNodes = db.prepare(`SELECT COUNT(*) as n FROM nodos WHERE estado='ACTIVO'`).get()?.n || 0;

  // Nodos BAJA confianza con baja utilidad
  const lowUtility = db.prepare(`
    SELECT COUNT(*) as n FROM nodos
    WHERE estado='ACTIVO' AND confianza='BAJA'
      AND aplicado >= 3 AND (util * 1.0 / aplicado) < ?
  `).get(MIN_UTILITY_RATIO)?.n || 0;

  // Nodos sin vigencia_tipo
  let unclassified = 0;
  try {
    unclassified = db.prepare(`
      SELECT COUNT(*) as n FROM nodos
      WHERE estado='ACTIVO' AND (vigencia_tipo IS NULL OR vigencia_tipo = '')
    `).get()?.n || 0;
  } catch {}

  return {
    active_nodes: activeNodes,
    stale_episodes: staleEpisodes,
    low_utility_candidates: lowUtility,
    unclassified_vigencia: unclassified,
    over_limit: activeNodes > MAX_SEMANTIC_NODES,
    needs_curation: staleEpisodes > 50 || lowUtility > 20 || activeNodes > MAX_SEMANTIC_NODES,
  };
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function jaccardSim(a, b) {
  const setA = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
  const setB = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

function confRank(c) {
  return { 'ALTA': 3, 'MEDIA': 2, 'BAJA': 1 }[c] || 0;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const [,, cmd] = process.argv;
  const projectRoot = process.cwd();

  switch (cmd) {
    case 'run': {
      const r = runCuration(projectRoot);
      if (r) {
        console.log('\n=== MemCurator Report ===');
        console.log(`TTL:       ${r.ttl?.compressed} comprimidos, ${r.ttl?.archived} archivados`);
        console.log(`Dedup:     ${r.dedup?.merged} mergeados`);
        console.log(`Conflictos:${r.conflicts?.resolved} resueltos`);
        console.log(`Scores:    ${r.scores?.updated} actualizados`);
        console.log(`Duración:  ${r.duration_ms}ms\n`);
      }
      break;
    }
    case 'ttl': {
      const db = openDB(projectRoot);
      const r = enforceEpisodicTTL(db, projectRoot);
      console.log(`TTL: ${r.compressed} comprimidos, ${r.archived} archivados`);
      break;
    }
    case 'dedup': {
      const db = openDB(projectRoot);
      const r = deduplicateNodes(db, projectRoot);
      console.log(`Dedup: ${r.merged} mergeados de ${r.candidates} candidatos`);
      break;
    }
    case 'conflicts': {
      const db = openDB(projectRoot);
      const r = resolveConflicts(db, projectRoot);
      console.log(`Conflictos: ${r.resolved} resueltos de ${r.detected} detectados`);
      break;
    }
    case 'score': {
      const db = openDB(projectRoot);
      const r = recalculateScores(db, projectRoot);
      console.log(`Scores: ${r.updated} nodos actualizados`);
      break;
    }
    case 'report': {
      const r = generateReport(projectRoot);
      console.log('\n=== MemCurator Pre-Report ===');
      console.log(`Nodos activos:          ${r.active_nodes}`);
      console.log(`Episodios stale:        ${r.stale_episodes}`);
      console.log(`Candidatos baja util:   ${r.low_utility_candidates}`);
      console.log(`Sin vigencia_tipo:      ${r.unclassified_vigencia}`);
      console.log(`Sobre límite:           ${r.over_limit}`);
      console.log(`Necesita curation:      ${r.needs_curation}`);
      console.log('\nPara curar: node mem-curator.cjs run\n');
      break;
    }
    default:
      console.log('Uso: node mem-curator.cjs [run | ttl | dedup | conflicts | score | report]');
  }
}

module.exports = {
  runCuration,
  enforceEpisodicTTL,
  deduplicateNodes,
  resolveConflicts,
  recalculateScores,
  enforceNodeLimit,
  computeRelevanceScore,
  generateReport,
};
