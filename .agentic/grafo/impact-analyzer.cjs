/**
 * Agentic KDD — Impact Analyzer v1.0
 * Análisis de impacto pre-cambio: qué puede romperse antes de tocar algo.
 *
 * Fuentes de análisis:
 *   1. Grafo AST (ast-indexer.cjs) — dependencias estructurales del código
 *   2. Edges causales (causal-edges.cjs) — historial de qué causó fallos
 *   3. Memoria semántica (grafo.cjs) — mapa de entidades del proyecto
 *   4. Predictor (prediccion.cjs) — predicciones basadas en historial
 *
 * Uso:
 *   node .agentic/grafo/impact-analyzer.cjs analyze src/auth/login.ts
 *   node .agentic/grafo/impact-analyzer.cjs diff [archivos...]
 *   node .agentic/grafo/impact-analyzer.cjs precheck [módulo]
 */

'use strict';

const fs   = require('fs');
const path = require('path');

function openDB(projectRoot) {
  const dbPath = path.join(projectRoot, '.agentic/memoria.db');
  try { return new (require('better-sqlite3'))(dbPath); } catch {}
  try { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(dbPath); } catch {}
  throw new Error('No SQLite driver disponible');
}

// ─── ANÁLISIS DE IMPACTO COMPLETO ─────────────────────────────────────────────

/**
 * Analiza el impacto de tocar un archivo/módulo.
 * Combina AST (estructural) + causal (histórico) + semántico.
 *
 * @param {object} db
 * @param {string} target - ruta relativa o nombre del módulo
 * @returns {ImpactReport}
 */
function analyzeImpact(db, target) {
  const report = {
    target,
    timestamp: new Date().toISOString(),
    severity: 'BAJO',
    severity_score: 0,
    structural: { direct: [], indirect: [], count: 0 },
    causal: { failures: [], fixes: [], count: 0 },
    semantic: { dependents: [], count: 0 },
    knowledge: { adrs: [], gotchas: [], count: 0 },
    warnings: [],
    recommendations: [],
  };

  // ── 1. Análisis estructural (AST edges) ──────────────────────────────────
  try {
    report.structural.direct = db.prepare(`
      SELECT DISTINCT from_file as file, kind, weight
      FROM ast_edges
      WHERE to_file LIKE ? OR to_symbol LIKE ?
      ORDER BY weight DESC LIMIT 30
    `).all(`%${target}%`, `%${target}%`);

    report.structural.indirect = db.prepare(`
      SELECT DISTINCT ae2.from_file as file
      FROM ast_edges ae1
      JOIN ast_edges ae2 ON ae1.from_file = ae2.to_file
      WHERE ae1.to_file LIKE ? AND ae2.from_file NOT LIKE ?
      LIMIT 30
    `).all(`%${target}%`, `%${target}%`);

    report.structural.count = report.structural.direct.length + report.structural.indirect.length;
  } catch {}

  // ── 2. Análisis causal (historial de fallos) ──────────────────────────────
  try {
    // ¿Este archivo ha causado fallos antes?
    report.causal.failures = db.prepare(`
      SELECT desde_entidad, tipo, hacia_entidad, descripcion, valid_at
      FROM relaciones_semanticas
      WHERE tipo = 'caused_failure'
        AND (desde_entidad LIKE ? OR hacia_entidad LIKE ?)
        AND (invalid_at IS NULL OR invalid_at = '')
      ORDER BY valid_at DESC LIMIT 10
    `).all(`%${target}%`, `%${target}%`);

    // ¿Hay fixes conocidos para problemas en este área?
    report.causal.fixes = db.prepare(`
      SELECT desde_entidad, tipo, hacia_entidad, descripcion
      FROM relaciones_semanticas
      WHERE tipo = 'was_fixed_by'
        AND desde_entidad LIKE ?
      LIMIT 5
    `).all(`%${target}%`);

    report.causal.count = report.causal.failures.length;
  } catch {}

  // ── 3. Análisis semántico (entidades que dependen de este módulo) ─────────
  try {
    report.semantic.dependents = db.prepare(`
      SELECT desde_entidad, tipo, descripcion
      FROM relaciones_semanticas
      WHERE hacia_entidad LIKE ?
        AND tipo IN ('depende_de', 'importa', 'usa', 'llama')
        AND (invalid_at IS NULL OR invalid_at = '')
      ORDER BY peso DESC LIMIT 20
    `).all(`%${target}%`);

    report.semantic.count = report.semantic.dependents.length;
  } catch {}

  // ── 4. Knowledge base (ADRs y gotchas relacionados) ───────────────────────
  try {
    const knowledgeDocs = db.prepare(`
      SELECT doc_id, tipo, titulo, decision, status
      FROM knowledge_docs
      WHERE afecta LIKE ? OR context LIKE ? OR titulo LIKE ?
      ORDER BY tipo, status
      LIMIT 10
    `).all(`%${target}%`, `%${target}%`, `%${target}%`);

    report.knowledge.adrs = knowledgeDocs.filter(d => d.tipo === 'adr');
    report.knowledge.gotchas = knowledgeDocs.filter(d => d.tipo === 'gotcha');
    report.knowledge.count = knowledgeDocs.length;
  } catch {}

  // ── 5. Calcular severidad ─────────────────────────────────────────────────
  let score = 0;
  score += report.structural.direct.length * 2;
  score += report.structural.indirect.length * 1;
  score += report.causal.failures.length * 5;  // penalizar historial de fallos
  score += report.semantic.count * 1.5;
  score += report.knowledge.gotchas.length * 3;

  report.severity_score = Math.round(score);

  if (score >= 20) report.severity = 'ALTO';
  else if (score >= 8) report.severity = 'MEDIO';
  else report.severity = 'BAJO';

  // ── 6. Generar warnings y recomendaciones ────────────────────────────────
  if (report.causal.failures.length > 0) {
    report.warnings.push(`⚠️ Este módulo ha causado ${report.causal.failures.length} fallo(s) histórico(s)`);
    report.recommendations.push('Revisar los episodios de fallos antes de modificar');
  }

  if (report.knowledge.gotchas.length > 0) {
    report.warnings.push(`⚠️ Hay ${report.knowledge.gotchas.length} gotcha(s) documentado(s) para este módulo`);
    report.recommendations.push(`Leer gotchas: ${report.knowledge.gotchas.map(g => g.doc_id).join(', ')}`);
  }

  if (report.structural.direct.length >= 5) {
    report.warnings.push(`⚠️ ${report.structural.direct.length} archivos dependen directamente de este módulo`);
    report.recommendations.push('Ejecutar suite completa de tests después de los cambios');
  }

  if (report.severity === 'ALTO') {
    report.recommendations.push('Considerar un Bugfix Spec antes de proceder');
    report.recommendations.push('Hacer backup/branch antes de modificar');
  }

  if (report.causal.fixes.length > 0) {
    report.recommendations.push(`Fix pattern conocido: ${report.causal.fixes[0].hacia_entidad}`);
  }

  return report;
}

// ─── ANÁLISIS DE DIFF (múltiples archivos) ────────────────────────────────────

/**
 * Analiza el impacto de un conjunto de archivos que se van a modificar.
 * Similar al /understand-diff de Understand-Anything.
 */
function analyzeDiff(db, files) {
  const results = files.map(f => analyzeImpact(db, f));

  // Severidad máxima del conjunto
  const maxSeverity = results.reduce((max, r) => {
    const order = { 'BAJO': 0, 'MEDIO': 1, 'ALTO': 2 };
    return order[r.severity] > order[max] ? r.severity : max;
  }, 'BAJO');

  const totalScore = results.reduce((sum, r) => sum + r.severity_score, 0);
  const allWarnings = [...new Set(results.flatMap(r => r.warnings))];
  const allRecs = [...new Set(results.flatMap(r => r.recommendations))];

  return {
    files_analyzed: files,
    max_severity: maxSeverity,
    total_score: totalScore,
    per_file: results,
    warnings: allWarnings,
    recommendations: allRecs,
    safe_to_proceed: maxSeverity !== 'ALTO' && allWarnings.length === 0,
  };
}

// ─── PRE-CHECK (antes de ejecutar un plan) ────────────────────────────────────

/**
 * Verifica si es seguro ejecutar un plan sobre un módulo.
 * Combina impact analysis con validation del spec.
 */
function preCheck(projectRoot, moduleName) {
  const db = openDB(projectRoot);

  // Obtener archivos del spec si existe
  const specDir = path.join(projectRoot, '.agentic/specs', moduleName);
  const tasksPath = path.join(specDir, 'tasks.md');

  let files = [moduleName];
  if (fs.existsSync(tasksPath)) {
    try {
      const { parseTasks } = require('./spec-manager.cjs');
      const tasks = parseTasks(fs.readFileSync(tasksPath, 'utf8'));
      const specFiles = tasks.flatMap(t => t.files).filter(Boolean);
      if (specFiles.length > 0) files = specFiles;
    } catch {}
  }

  const diffResult = analyzeDiff(db, files);

  console.log(`\n🔍 Pre-check para: ${moduleName}`);
  console.log(`   Archivos analizados: ${files.length}`);
  console.log(`   Severidad máxima: ${diffResult.max_severity}`);
  console.log(`   Score total: ${diffResult.total_score}`);

  if (diffResult.warnings.length > 0) {
    console.log('\n⚠️  Warnings:');
    diffResult.warnings.forEach(w => console.log(`   ${w}`));
  }

  if (diffResult.recommendations.length > 0) {
    console.log('\n💡 Recomendaciones:');
    diffResult.recommendations.forEach(r => console.log(`   → ${r}`));
  }

  console.log(`\n${diffResult.safe_to_proceed ? '✅ SEGURO PROCEDER' : '⚠️  REVISAR ANTES DE PROCEDER'}`);

  return diffResult;
}

// ─── FORMATO DE REPORTE ───────────────────────────────────────────────────────

function formatReport(report) {
  const lines = [
    `\n📊 Análisis de Impacto: ${report.target}`,
    `${'═'.repeat(50)}`,
    `Severidad: ${report.severity} (score: ${report.severity_score})`,
    '',
  ];

  if (report.structural.direct.length > 0) {
    lines.push(`Deps estructurales directas (${report.structural.direct.length}):`);
    report.structural.direct.slice(0, 5).forEach(d =>
      lines.push(`  ${d.kind} ← ${d.file}`)
    );
  }

  if (report.causal.failures.length > 0) {
    lines.push(`\nHistorial de fallos causados (${report.causal.failures.length}):`);
    report.causal.failures.slice(0, 3).forEach(f =>
      lines.push(`  ⚠️ ${f.descripcion?.substring(0, 80) || f.hacia_entidad}`)
    );
  }

  if (report.knowledge.adrs.length > 0) {
    lines.push(`\nADRs relacionados: ${report.knowledge.adrs.map(a => a.doc_id).join(', ')}`);
  }

  if (report.warnings.length > 0) {
    lines.push('\nWarnings:');
    report.warnings.forEach(w => lines.push(`  ${w}`));
  }

  if (report.recommendations.length > 0) {
    lines.push('\nRecomendaciones:');
    report.recommendations.forEach(r => lines.push(`  → ${r}`));
  }

  return lines.join('\n');
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const [,, cmd, ...args] = process.argv;
  const projectRoot = process.cwd();

  switch (cmd) {
    case 'analyze': {
      const [target] = args;
      if (!target) { console.error('Uso: impact-analyzer.cjs analyze <target>'); process.exit(1); }
      try {
        const db = openDB(projectRoot);
        const report = analyzeImpact(db, target);
        console.log(formatReport(report));
      } catch (e) { console.error(e.message); }
      break;
    }
    case 'diff': {
      if (args.length === 0) { console.error('Uso: impact-analyzer.cjs diff <file1> [file2...]'); process.exit(1); }
      try {
        const db = openDB(projectRoot);
        const result = analyzeDiff(db, args);
        console.log(`\nImpacto del diff (${args.length} archivos):`);
        console.log(`Severidad máxima: ${result.max_severity}`);
        result.per_file.forEach(r =>
          console.log(`  ${r.severity.padEnd(6)} ${r.target}`)
        );
        if (result.warnings.length > 0) {
          console.log('\nWarnings:');
          result.warnings.forEach(w => console.log(`  ${w}`));
        }
        console.log(`\n${result.safe_to_proceed ? '✅ OK proceder' : '⚠️  Revisar primero'}`);
      } catch (e) { console.error(e.message); }
      break;
    }
    case 'precheck': {
      const [mod] = args;
      if (!mod) { console.error('Uso: impact-analyzer.cjs precheck <módulo>'); process.exit(1); }
      preCheck(projectRoot, mod);
      break;
    }
    default:
      console.log('Uso: node impact-analyzer.cjs [analyze <target> | diff <files...> | precheck <módulo>]');
  }
}

module.exports = {
  analyzeImpact,
  analyzeDiff,
  preCheck,
  formatReport,
};
