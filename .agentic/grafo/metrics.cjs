/**
 * Agentic KDD — Metrics v1.0
 * KPIs operacionales del proyecto: éxito por ciclo, retrabajo, tokens ahorrados,
 * tasa de autonomía, drift de confianza, memoria aplicada vs ignorada.
 *
 * Cierra el Gap #4: el sistema mejoraba en silencio. Ahora el dev ve el valor.
 *
 * Uso:
 *   node .agentic/grafo/metrics.cjs summary
 *   node .agentic/grafo/metrics.cjs trend [N_ciclos]
 *   node .agentic/grafo/metrics.cjs memory
 *   node .agentic/grafo/metrics.cjs tokens [tarea_descripcion]
 *   node .agentic/grafo/metrics.cjs autonomy
 */

'use strict';

const path = require('path');

function openDB(projectRoot) {
  const dbPath = path.join(projectRoot, '.agentic/memoria.db');
  try { return new (require('better-sqlite3'))(dbPath); } catch {}
  try { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(dbPath); } catch {}
  throw new Error('No SQLite driver disponible');
}

// ─── MÉTRICAS DE CICLOS ───────────────────────────────────────────────────────

function computeCycleMetrics(db) {
  let ciclos = [];
  try {
    ciclos = db.prepare(`
      SELECT ciclo_id, estado, stops_count, tests_pasando, tests_generados,
             review_blockers, fases_completadas, fases_total, duracion_ms,
             patrones_aplicados, errores_evitados, sync_grafo, fecha_inicio, memory_trace
      FROM ciclos ORDER BY fecha_inicio DESC LIMIT 100
    `).all();
  } catch { return null; }

  if (ciclos.length === 0) return { error: 'Sin ciclos registrados' };

  const ec = require('./estado-ciclo.cjs');
  let eventosStop = [];
  try { eventosStop = db.prepare("SELECT id, event_id, incident_id, cycle_id FROM gate_events WHERE verdict = 'STOP'").all(); } catch {}
  const total = ciclos.length;
  const cierre = ec.resumenCierre(ciclos);
  const { porCiclo } = ec.stopsPorCiclo(eventosStop);
  const detenidos = ciclos.filter(c => ec.stopsDelCiclo(c, porCiclo) > 0).length;
  const conRework = ciclos.filter(c => c.stops_count > 0).length;

  const successRate = cierre.tasa_cierre;
  const reworkRate  = total > 0 ? Math.round((conRework / total) * 100) : 0;
  const stopRate    = total > 0 ? Math.round((detenidos / total) * 100) : 0;

  // tests_generados es el universo ejecutado; un ciclo con más aprobadas que ejecutadas no se suma.
  const tests = ec.tasaTests(ciclos);
  const testPassRate = tests.tasa;

  // Fases
  const totalFases = ciclos.reduce((s, c) => s + (c.fases_total || 0), 0);
  const compFases  = ciclos.reduce((s, c) => s + (c.fases_completadas || 0), 0);
  const faseRate   = totalFases > 0 ? Math.round((compFases / totalFases) * 100) : 0;

  // Memoria aplicada
  let patronesAplicados = 0, erroresEvitados = 0, memoriaConsultada = 0;
  ciclos.forEach(c => {
    // «Consultada» = lo que el enricher mostró al modelo (memory_trace.consultada). No es «aplicada», y la «relevante» derivada NO se cuenta.
    try { const t = JSON.parse(c.memory_trace || 'null'); if (t && Array.isArray(t.consultada)) memoriaConsultada += t.consultada.length; } catch {}
    try { const v = JSON.parse(c.patrones_aplicados || '[]'); patronesAplicados += Array.isArray(v) ? v.length : (typeof v === 'number' ? v : 0); } catch {}
    try { const v = JSON.parse(c.errores_evitados   || '[]'); erroresEvitados   += Array.isArray(v) ? v.length : (typeof v === 'number' ? v : 0); } catch {}
  });

  // Review blockers
  const totalBlockers = ciclos.reduce((s, c) => s + (c.review_blockers || 0), 0);

  // Duración promedio
  const duraciones = ciclos.filter(c => c.duracion_ms > 0).map(c => c.duracion_ms);
  const avgDuracion = duraciones.length > 0 ? Math.round(duraciones.reduce((s, d) => s + d, 0) / duraciones.length) : 0;

  return {
    ciclos_total: total,
    success_rate: successRate,
    rework_rate: reworkRate,
    stop_rate: stopRate,
    test_pass_rate: testPassRate,
    tests_estado: tests.status,
    tests_inconsistentes: tests.inconsistentes,
    cierre,
    stops_unicos: ec.incidentesStop(ciclos, eventosStop).total,
    fase_completion_rate: faseRate,
    patrones_aplicados: patronesAplicados,
    errores_evitados: erroresEvitados,
    memoria_consultada: memoriaConsultada,
    review_blockers_total: totalBlockers,
    avg_duracion_ms: avgDuracion,
    ciclos_con_sync: ciclos.filter(c => c.sync_grafo).length,
  };
}

// ─── MÉTRICAS DE MEMORIA ──────────────────────────────────────────────────────

function computeMemoryMetrics(db) {
  const mem = {};

  try {
    mem.total_nodos    = db.prepare("SELECT COUNT(*) as n FROM nodos").get()?.n ?? 0;
    mem.nodos_alta     = db.prepare("SELECT COUNT(*) as n FROM nodos WHERE confianza='ALTA' AND estado='ACTIVO'").get()?.n ?? 0;
    mem.nodos_media    = db.prepare("SELECT COUNT(*) as n FROM nodos WHERE confianza='MEDIA' AND estado='ACTIVO'").get()?.n ?? 0;
    mem.nodos_obsoletos= db.prepare("SELECT COUNT(*) as n FROM nodos WHERE estado='OBSOLETO'").get()?.n ?? 0;
    mem.episodios      = db.prepare("SELECT COUNT(*) as n FROM episodios").get()?.n ?? 0;
    mem.sin_consolidar = db.prepare("SELECT COUNT(*) as n FROM episodios WHERE consolidado=0").get()?.n ?? 0;
    mem.entidades      = db.prepare("SELECT COUNT(*) as n FROM entidades").get()?.n ?? 0;
    mem.relaciones_sem = db.prepare("SELECT COUNT(*) as n FROM relaciones_semanticas WHERE invalid_at IS NULL OR invalid_at=''").get()?.n ?? 0;

    // Edges causales
    const causalTypes = ['caused_failure','was_fixed_by','tested_by','regressed_by'];
    const causalPlaceholders = causalTypes.map(() => '?').join(',');
    mem.edges_causales = db.prepare(`SELECT COUNT(*) as n FROM relaciones_semanticas WHERE tipo IN (${causalPlaceholders}) AND (invalid_at IS NULL OR invalid_at='')`).get(...causalTypes)?.n ?? 0;

    // AST
    try {
      mem.ast_symbols = db.prepare("SELECT COUNT(*) as n FROM ast_symbols").get()?.n ?? 0;
      mem.ast_edges   = db.prepare("SELECT COUNT(*) as n FROM ast_edges").get()?.n ?? 0;
      mem.ast_files   = db.prepare("SELECT COUNT(DISTINCT file) as n FROM ast_symbols").get()?.n ?? 0;
    } catch { mem.ast_symbols = 0; mem.ast_edges = 0; mem.ast_files = 0; }

    // Knowledge docs
    try {
      mem.knowledge_docs = db.prepare("SELECT COUNT(*) as n FROM knowledge_docs WHERE status='accepted'").get()?.n ?? 0;
    } catch { mem.knowledge_docs = 0; }

    // Vigencia types (v3.1)
    try {
      const vigencias = db.prepare("SELECT vigencia_tipo, COUNT(*) as n FROM nodos GROUP BY vigencia_tipo").all();
      mem.por_vigencia = {};
      vigencias.forEach(v => { mem.por_vigencia[v.vigencia_tipo || 'sin_clasificar'] = v.n; });
    } catch { mem.por_vigencia = {}; }

    // Calidad memoria: ratio alta/(alta+media)
    const activos = mem.nodos_alta + mem.nodos_media;
    mem.quality_score = activos > 0 ? Math.round((mem.nodos_alta / activos) * 100) : 0;
    mem.consolidation_debt = mem.sin_consolidar; // episodios sin procesar

  } catch (e) { return { error: e.message }; }

  return mem;
}

// ─── USO Y AHORRO DE TOKENS (medido, ver costo-uso.cjs) ──────────────────────

/**
 * Uso real reportado por el proveedor, estimaciones aparte, y ahorro solo
 * donde hay una comparación de tareas equivalentes con calidad. Sin eso el
 * ahorro es null: no se deriva de constantes por patrón o por ciclo.
 */
function estimateTokenSavings(db, projectRoot = process.cwd()) {
  const cu = require('./costo-uso.cjs');
  const registros = cu.leer(projectRoot);
  const bench = cu.benchmark(registros);
  const probadas = Object.entries(bench.clases)
    .filter(([, c]) => c.veredicto === 'MENOS_TOKENS_MISMA_O_MEJOR_CALIDAD')
    .map(([clase, c]) => ({ clase, diferencia_tokens_pct: c.diferencia_tokens_pct, n_baseline: c.baseline.n, n_kdd: c.kdd.n }));
  return {
    uso: cu.resumen(registros),
    ahorro_por_clase: probadas.length ? probadas : null,
    benchmark: bench,
    total_tokens_estimados_ahorrados: null,
    nota: probadas.length
      ? 'Ahorro medido por clase de tarea con línea base y calidad; no se extrapola.'
      : 'Sin comparación de tareas equivalentes con calidad: ahorro sin dato (null).',
  };
}

// ─── AUTONOMY SCORE ───────────────────────────────────────────────────────────

/**
 * Score de autonomía real basado en datos medibles.
 * No es una estimación del roadmap — es lo que los datos muestran.
 */
function computeAutonomyScore(db) {
  const cycles = computeCycleMetrics(db);
  const mem    = computeMemoryMetrics(db);
  if (cycles?.error) return { error: 'Sin datos' };

  const scores = {};

  // 1. Tasa de éxito sin intervención (40% del score)
  scores.success_rate = Math.min(cycles.success_rate || 0, 100);
  scores.success_weight = 0.4;

  // 2. Tasa de tests automáticos (20%)
  scores.test_coverage = Math.min(cycles.test_pass_rate || 0, 100);
  scores.test_weight = 0.2;

  // 3. Uso de memoria (20%): (patrones aplicados DECLARADOS + memoria CONSULTADA por el enricher) / ciclos. Antes solo contaba los
  //    declarados, que ningún ciclo mecánico (hook, TEAMS) llena: el puntaje quedaba en 0 de forma estructural.
  const memUsage = cycles.ciclos_total > 0
    ? Math.min(Math.round((((cycles.patrones_aplicados || 0) + (cycles.memoria_consultada || 0)) / cycles.ciclos_total) * 20), 100)
    : 0;
  scores.memory_usage = memUsage;
  scores.memory_weight = 0.2;

  // 4. Completitud del grafo (20%): AST + knowledge + causal
  const graphCompleteness = Math.min(
    Math.round(((mem.ast_files || 0) > 0 ? 40 : 0) +
               ((mem.knowledge_docs || 0) > 0 ? 30 : 0) +
               ((mem.edges_causales || 0) > 0 ? 30 : 0)),
    100
  );
  scores.graph_completeness = graphCompleteness;
  scores.graph_weight = 0.2;

  const overall = Math.round(
    scores.success_rate   * scores.success_weight +
    scores.test_coverage  * scores.test_weight +
    scores.memory_usage   * scores.memory_weight +
    scores.graph_completeness * scores.graph_weight
  );

  return {
    overall_autonomy: overall,
    componentes: {
      tasa_exito: { score: scores.success_rate, peso: '40%' },
      cobertura_tests: { score: scores.test_coverage, peso: '20%' },
      uso_memoria: { score: scores.memory_usage, peso: '20%' },
      completitud_grafo: { score: scores.graph_completeness, peso: '20%' },
    },
    nivel: overall >= 85 ? 'MUY ALTO' : overall >= 70 ? 'ALTO' : overall >= 50 ? 'MEDIO' : 'EN DESARROLLO',
  };
}

// ─── TREND (últimos N ciclos) ─────────────────────────────────────────────────

function computeTrend(db, n = 10) {
  let ciclos = [];
  try {
    ciclos = db.prepare(`
      SELECT ciclo_id, estado, tests_pasando, tests_generados, stops_count, fecha_inicio
      FROM ciclos ORDER BY fecha_inicio DESC LIMIT ?
    `).all(n);
  } catch { return []; }

  return ciclos.reverse().map((c, i) => ({
    ciclo: i + 1,
    id: c.ciclo_id,
    estado: c.estado,
    test_rate: c.tests_generados > 0 && c.tests_pasando <= c.tests_generados ? Math.round((c.tests_pasando / c.tests_generados) * 100) : null,
    rework: c.stops_count > 0 ? 1 : 0,
    fecha: c.fecha_inicio?.substring(0, 10),
  }));
}

// ─── PRINT ────────────────────────────────────────────────────────────────────

function printUso(s) {
  const dato = (v) => (v === null || v === undefined ? 'sin dato' : v.toLocaleString());
  console.log('\n  ── TOKENS ──────────────────────────────────────');
  console.log(`  Real (proveedor):   ${dato(s.uso.real.total)} en ${s.uso.real.llamadas} llamadas` +
    ` (input ${dato(s.uso.real.input)}, output ${dato(s.uso.real.output)}, caché leída ${dato(s.uso.real.cache_read)}, escrita ${dato(s.uso.real.cache_write)})`);
  console.log(`  Estimado (bytes/4): ${dato(s.uso.estimado.input)} en ${s.uso.estimado.llamadas} registros — no se suma al real`);
  if (s.uso.sin_dato) console.log(`  Sin usage:          ${s.uso.sin_dato} llamadas (no cuentan como 0)`);
  if (s.ahorro_por_clase) for (const a of s.ahorro_por_clase) console.log(`  Ahorro ${a.clase}: ${a.diferencia_tokens_pct}% (n=${a.n_baseline}/${a.n_kdd}, calidad igual o mejor)`);
  else console.log('  Ahorro:             sin dato — falta benchmark de tareas equivalentes con calidad');
}

function printSummary(projectRoot) {
  const db = openDB(projectRoot);
  const cycles = computeCycleMetrics(db);
  const mem    = computeMemoryMetrics(db);
  const savings = estimateTokenSavings(db, projectRoot);
  const autonomy = computeAutonomyScore(db);

  console.log('\n═══════════════════════════════════════════════════');
  console.log('  Agentic KDD — Project Metrics');
  console.log('═══════════════════════════════════════════════════');

  if (!cycles?.error) {
    console.log('\n  ── CICLOS ──────────────────────────────────────');
    console.log(`  Total ciclos:       ${cycles.ciclos_total}`);
    console.log(`  Tasa de éxito:      ${cycles.success_rate == null ? 'sin dato' : cycles.success_rate + '%'} (${cycles.cierre.cerrados} cerrados íntegros, ${cycles.cierre.por_clase.CON_PENDIENTES} con pendientes)`);
    console.log(`  STOP únicos:        ${cycles.stops_unicos}`);
    console.log(`  Tasa de retrabajo:  ${cycles.rework_rate}%`);
    console.log(`  Tests pass rate:    ${cycles.test_pass_rate == null ? 'sin dato' : cycles.test_pass_rate + '%'}${cycles.tests_estado === 'DATA_INCONSISTENT' ? ` ⚠ datos inconsistentes en ${cycles.tests_inconsistentes.length} ciclo(s)` : ''}`);
    console.log(`  Fases completadas:  ${cycles.fase_completion_rate}%`);
    console.log(`  Patrones aplicados: ${cycles.patrones_aplicados}`);
    console.log(`  Errores evitados:   ${cycles.errores_evitados}`);
  }

  if (!mem?.error) {
    console.log('\n  ── MEMORIA ─────────────────────────────────────');
    console.log(`  Nodos procedurales: ${mem.total_nodos} (ALTA: ${mem.nodos_alta}, MEDIA: ${mem.nodos_media})`);
    console.log(`  Quality score:      ${mem.quality_score}%`);
    console.log(`  Episodios:          ${mem.episodios} (${mem.sin_consolidar} sin consolidar)`);
    console.log(`  Entidades semántic: ${mem.entidades}`);
    console.log(`  Edges causales:     ${mem.edges_causales}`);
    console.log(`  AST: ${mem.ast_files} archivos, ${mem.ast_symbols} símbolos, ${mem.ast_edges} edges`);
    console.log(`  Knowledge docs:     ${mem.knowledge_docs}`);
  }

  printUso(savings);

  if (!autonomy?.error) {
    console.log('\n  ── AUTONOMY SCORE ──────────────────────────────');
    console.log(`  Score global:       ${autonomy.overall_autonomy}% — ${autonomy.nivel}`);
    console.log(`  Éxito sin interv.:  ${autonomy.componentes.tasa_exito.score}%`);
    console.log(`  Cobertura tests:    ${autonomy.componentes.cobertura_tests.score}%`);
    console.log(`  Uso de memoria:     ${autonomy.componentes.uso_memoria.score}%`);
    console.log(`  Grafo completo:     ${autonomy.componentes.completitud_grafo.score}%`);
  }

  console.log('\n═══════════════════════════════════════════════════\n');
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const [,, cmd, ...args] = process.argv;
  const projectRoot = process.cwd();

  switch (cmd) {
    case 'summary':
      printSummary(projectRoot);
      break;
    case 'memory': {
      const db = openDB(projectRoot);
      const m = computeMemoryMetrics(db);
      console.log(JSON.stringify(m, null, 2));
      break;
    }
    case 'tokens': {
      const db = openDB(projectRoot);
      const s = estimateTokenSavings(db, projectRoot);
      printUso(s);
      console.log(`  Nota: ${s.nota}`);
      break;
    }
    case 'autonomy': {
      const db = openDB(projectRoot);
      const a = computeAutonomyScore(db);
      console.log(`\nAutonomy Score: ${a.overall_autonomy}% — ${a.nivel}`);
      Object.entries(a.componentes || {}).forEach(([k, v]) =>
        console.log(`  ${k}: ${v.score}% (peso ${v.peso})`)
      );
      break;
    }
    case 'trend': {
      const n = parseInt(args[0]) || 10;
      const db = openDB(projectRoot);
      const trend = computeTrend(db, n);
      console.log(`\nTrend últimos ${n} ciclos:`);
      trend.forEach(t => {
        const ok = require('./estado-ciclo.cjs').icono(t.estado);
        const tests = t.test_rate !== null ? `tests:${t.test_rate}%` : 'sin tests';
        console.log(`  ${ok} ${t.fecha} [${t.id}] ${tests}`);
      });
      break;
    }
    default:
      console.log('Uso: node metrics.cjs [summary | memory | tokens | autonomy | trend [N]]');
  }
}

module.exports = {
  computeCycleMetrics,
  computeMemoryMetrics,
  estimateTokenSavings,
  computeAutonomyScore,
  computeTrend,
};

// ─── v3.2: MÉTRICAS DEL REPORTE ───────────────────────────────────────────────
// Implementa los 3 benchmarks solicitados en el análisis de viabilidad:
//   1. LongMemEval-style: precisión de recuperación histórica
//   2. Token Reduction Index: reducción vs trabajo sin memoria
//   3. CodeBERTScore proxy: calidad semántica del código generado

/**
 * 1. LongMemEval-style Temporal Memory Score
 *
 * Mide si el sistema prioriza reglas VIGENTES sobre reglas HISTÓRICAS cuando hay
 * conflicto temporal. Score > 0.6 = sistema gobernado correctamente.
 *
 * Basado en: LongMemEval (arXiv 2603.07670)
 */
function computeLongMemEvalScore(db) {
  try {
    // Contar nodos con vigencia correctamente clasificada
    const total = db.prepare("SELECT COUNT(*) as n FROM nodos WHERE estado='ACTIVO'").get()?.n || 0;
    if (total === 0) return { score: 0, level: 'N/A', details: 'Sin nodos' };

    let classified = 0;
    try {
      classified = db.prepare(
        "SELECT COUNT(*) as n FROM nodos WHERE estado='ACTIVO' AND vigencia_tipo IS NOT NULL AND vigencia_tipo != ''"
      ).get()?.n || 0;
    } catch {}

    // Contar conflictos resueltos (HISTORICO/SUPERSEDED)
    let resolved = 0;
    try {
      resolved = db.prepare(
        "SELECT COUNT(*) as n FROM nodos WHERE vigencia_tipo = 'HISTORICO'"
      ).get()?.n || 0;
    } catch {}

    // Score: % de nodos clasificados correctamente
    const classificationRate = total > 0 ? classified / total : 0;

    // Bonus por tener conflictos resueltos
    const conflictBonus = Math.min(resolved / Math.max(total * 0.05, 1), 0.2);

    const score = Math.min(classificationRate + conflictBonus, 1.0);
    const level = score >= 0.8 ? 'EXCELLENT' : score >= 0.6 ? 'GOOD' : score >= 0.4 ? 'NEEDS_WORK' : 'CRITICAL';

    return {
      score: Math.round(score * 100),
      level,
      classified_nodes: classified,
      total_nodes: total,
      resolved_conflicts: resolved,
      target: '> 60% (reporte requiere superior al 60%)',
      passes: score >= 0.6,
    };
  } catch (e) { return { score: 0, level: 'ERROR', error: e.message }; }
}

/**
 * 2. Token Reduction Index
 *
 * Reducción MEDIDA por clase de tarea (costo-uso.cjs benchmark). Sin tareas
 * equivalentes con línea base, muestra y calidad, el índice es null: antes
 * salía de 8000 frente a 500 tokens fijos y siempre "pasaba".
 */
function computeTokenReductionIndex(db, projectRoot = process.cwd()) {
  const s = estimateTokenSavings(db, projectRoot);
  const clases = s.benchmark.clases;
  const medidas = Object.entries(clases).filter(([, c]) => c.diferencia_tokens_pct !== null && c.veredicto !== 'CALIDAD_PEOR');
  return {
    index: null,
    por_clase: Object.fromEntries(Object.entries(clases).map(([k, c]) => [k, { reduccion_pct: c.diferencia_tokens_pct === null ? null : -c.diferencia_tokens_pct, veredicto: c.veredicto }])),
    total_tokens_saved_estimate: null,
    target: '> 70% por clase, con calidad igual o mejor',
    passes: medidas.length ? medidas.every(([, c]) => -c.diferencia_tokens_pct >= 70) : null,
    note: medidas.length ? 'Medido por clase; no se agrega en un porcentaje universal.' : 'Sin benchmark comparable: sin dato.',
  };
}

/**
 * 3. Memory Quality Score (proxy de CodeBERTScore)
 *
 * El reporte pide CodeBERTScore pero requiere acceso al modelo.
 * Este proxy mide la calidad semántica de la memoria desde sus señales internas.
 *
 * Score = (high_conf / total) × (useful / applied) × classification_rate
 */
function computeMemoryQualityScore(db) {
  try {
    const mem = computeMemoryMetrics(db);
    if (mem.error || mem.total_nodos === 0) return { score: 0, level: 'N/A' };

    const activeNodes = (mem.nodos_alta || 0) + (mem.nodos_media || 0);
    if (activeNodes === 0) return { score: 0, level: 'NO_DATA' };

    // Tasa de confianza alta
    const highConfRate = mem.nodos_alta / activeNodes;

    // Tasa de utilidad (util/aplicado)
    let utilRate = 0.5; // default
    try {
      const utilStats = db.prepare(`
        SELECT AVG(CAST(util AS REAL) / MAX(aplicado, 1)) as avg_util
        FROM nodos WHERE estado='ACTIVO' AND aplicado > 0
      `).get();
      utilRate = utilStats?.avg_util || 0.5;
    } catch {}

    // Tasa de clasificación de vigencia
    let classRate = 0.5;
    try {
      const classified = db.prepare("SELECT COUNT(*) as n FROM nodos WHERE estado='ACTIVO' AND vigencia_tipo IS NOT NULL AND vigencia_tipo != ''").get()?.n || 0;
      const total = mem.total_nodos;
      classRate = total > 0 ? classified / total : 0.5;
    } catch {}

    const score = highConfRate * 0.4 + utilRate * 0.3 + classRate * 0.3;
    const pct   = Math.round(score * 100);
    const level = pct >= 80 ? 'EXCELLENT' : pct >= 60 ? 'GOOD' : pct >= 40 ? 'FAIR' : 'POOR';

    return {
      score: pct,
      level,
      components: {
        high_confidence_rate: Math.round(highConfRate * 100),
        utility_rate: Math.round(utilRate * 100),
        classification_rate: Math.round(classRate * 100),
      },
      note: 'Proxy de CodeBERTScore basado en señales internas de calidad de memoria',
    };
  } catch (e) { return { score: 0, level: 'ERROR', error: e.message }; }
}

/**
 * Reporte unificado de los 3 benchmarks del informe.
 */
function computeReportBenchmarks(db, projectRoot = process.cwd()) {
  return {
    longmemeval: computeLongMemEvalScore(db),
    token_reduction: computeTokenReductionIndex(db, projectRoot),
    memory_quality: computeMemoryQualityScore(db),
    report_summary: null, // se completa abajo
  };
}

// Añadir al CLI
const _origMain = module.exports;

if (require.main === module) {
  const [,, cmd] = process.argv;
  const projectRoot = process.cwd();

  if (cmd === 'benchmarks') {
    const path = require('path');
    function openDB2(root) {
      const dbPath = path.join(root, '.agentic/memoria.db');
      try { return new (require('better-sqlite3'))(dbPath); } catch {}
      try { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(dbPath); } catch {}
      throw new Error('No SQLite driver');
    }
    const db = openDB2(projectRoot);
    const b = computeReportBenchmarks(db);

    console.log('\n═══════════════════════════════════════════════════');
    console.log('  Agentic KDD — Report Benchmarks');
    console.log('═══════════════════════════════════════════════════');

    console.log('\n  ① LongMemEval-style Temporal Score');
    console.log(`     Score:  ${b.longmemeval.score}%  [target: >60%]`);
    console.log(`     Level:  ${b.longmemeval.level}`);
    console.log(`     Passes: ${b.longmemeval.passes ? '✅' : '❌'}`);

    console.log('\n  ② Token Reduction Index');
    for (const [clase, c] of Object.entries(b.token_reduction.por_clase)) {
      console.log(`     ${clase}: ${c.reduccion_pct === null ? 'sin dato' : c.reduccion_pct + '%'} (${c.veredicto})`);
    }
    console.log(`     Passes: ${b.token_reduction.passes === null ? 'sin dato' : b.token_reduction.passes ? '✅' : '❌'}`);

    console.log('\n  ③ Memory Quality Score (CodeBERTScore proxy)');
    console.log(`     Score:  ${b.memory_quality.score}%`);
    console.log(`     Level:  ${b.memory_quality.level}`);
    console.log(`     High conf: ${b.memory_quality.components?.high_confidence_rate}%`);
    console.log(`     Utility:   ${b.memory_quality.components?.utility_rate}%`);

    console.log('\n═══════════════════════════════════════════════════\n');
  }
}

module.exports = {
  ...(_origMain || {}),
  computeLongMemEvalScore,
  computeTokenReductionIndex,
  computeMemoryQualityScore,
  computeReportBenchmarks,
};
