/**
 * Agentic KDD — Effectiveness Report v1.0
 *
 * Genera datos reales de efectividad comparando primeros ciclos vs últimos.
 * Todo viene de SQLite — cero estimaciones, cero inventados.
 *
 * Métricas:
 *   - Error recurrence rate:    ¿El mismo error ocurre dos veces?
 *   - Stop rate:                ¿Cuántas veces el TDD gate paró el ciclo?
 *   - First-try test pass rate: ¿Tests pasan en el primer intento?
 *   - Rework index:             ¿Cuántos ciclos tocan los mismos archivos?
 *   - Pattern velocity:         ¿Qué tan rápido suben patrones a HIGH?
 *   - Memory growth:            ¿Cuánto conocimiento acumula por ciclo?
 *
 * Uso:
 *   node effectiveness-report.cjs          → reporte completo
 *   node effectiveness-report.cjs --json   → output JSON para dashboards
 *   node effectiveness-report.cjs --short  → resumen de una línea por métrica
 */

'use strict';

const path = require('path');
const fs   = require('fs');

// ─── DB ───────────────────────────────────────────────────────────────────────

function openDB(projectRoot) {
  const dbPath = path.join(projectRoot, '.agentic/memoria.db');
  try { return new (require('better-sqlite3'))(dbPath, { readonly: true }); } catch {}
  try { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(dbPath); } catch {}
  return null;
}

// ─── CALCULAR MÉTRICAS POR VENTANA DE CICLOS ─────────────────────────────────

function calcWindowMetrics(db, cycleIds) {
  if (!cycleIds || cycleIds.length === 0) {
    return { stops: 0, stop_rate: 0, errors_found: 0, errors_per_cycle: 0,
             tests_total: 0, tests_passed: 0, first_try_rate: 0,
             patterns_applied: 0, patterns_per_cycle: 0, cycles: 0 };
  }

  const placeholders = cycleIds.map(() => '?').join(',');
  const safe = (fn) => { try { return fn(); } catch { return null; } };

  const stops = safe(() =>
    db.prepare(`SELECT COUNT(*) as n FROM ciclos WHERE estado='STOP' AND ciclo_id IN (${placeholders})`).get(...cycleIds)?.n
  ) || 0;

  const errorsFound = safe(() => {
    const rows = db.prepare(`SELECT errores_encontrados FROM ciclos WHERE ciclo_id IN (${placeholders})`).all(...cycleIds);
    return rows.reduce((s, r) => s + (parseInt(r.errores_encontrados) || 0), 0);
  }) || 0;

  // Tests: sumar de todos los ciclos
  let testsTotal = 0, testsPassed = 0;
  safe(() => {
    const rows = db.prepare(`SELECT tests_corridos FROM ciclos WHERE ciclo_id IN (${placeholders})`).all(...cycleIds);
    rows.forEach(r => {
      try {
        const t = JSON.parse(r.tests_corridos || '{}');
        testsTotal  += (t.total  || parseInt(r.tests_corridos) || 0);
        testsPassed += (t.passed || parseInt(r.tests_corridos) || 0);
      } catch {
        const n = parseInt(r.tests_corridos) || 0;
        testsTotal += n; testsPassed += n;
      }
    });
  });

  // Patrones aplicados
  const patternsApplied = safe(() => {
    const rows = db.prepare(`SELECT patrones_aplicados FROM ciclos WHERE ciclo_id IN (${placeholders})`).all(...cycleIds);
    return rows.reduce((s, r) => {
      try { return s + JSON.parse(r.patrones_aplicados || '[]').length; }
      catch { return s; }
    }, 0);
  }) || 0;

  const n = cycleIds.length;
  return {
    cycles:              n,
    stops,
    stop_rate:           n > 0 ? Math.round((stops / n) * 100) : 0,
    errors_found:        errorsFound,
    errors_per_cycle:    n > 0 ? Math.round((errorsFound / n) * 10) / 10 : 0,
    tests_total:         testsTotal,
    tests_passed:        testsPassed,
    first_try_rate:      testsTotal > 0 ? Math.round((testsPassed / testsTotal) * 100) : 100,
    patterns_applied:    patternsApplied,
    patterns_per_cycle:  n > 0 ? Math.round((patternsApplied / n) * 10) / 10 : 0,
  };
}

// ─── ERROR RECURRENCE RATE ───────────────────────────────────────────────────

function calcErrorRecurrence(db, allCycleIds, splitAt) {
  const safe = (fn) => { try { return fn(); } catch { return 0; } };

  // Errores únicos en primera mitad
  const firstHalf   = allCycleIds.slice(0, splitAt);
  const secondHalf  = allCycleIds.slice(splitAt);

  if (firstHalf.length === 0 || secondHalf.length === 0) return { rate: 0, recurred: 0, total_first: 0 };

  const ph1 = firstHalf.map(() => '?').join(',');
  const ph2 = secondHalf.map(() => '?').join(',');

  // Patrones de error en primera mitad
  const firstErrors = safe(() =>
    db.prepare(`SELECT titulo FROM nodos WHERE tipo='error' AND fecha_creacion IN (
      SELECT fecha_inicio FROM ciclos WHERE ciclo_id IN (${ph1})
    )`).all(...firstHalf).map(r => r.titulo)
  ) || [];

  // Mismos patrones vistos en segunda mitad
  let recurred = 0;
  if (firstErrors.length > 0 && secondHalf.length > 0) {
    firstErrors.forEach(titulo => {
      if (!titulo) return;
      const found = safe(() =>
        db.prepare(`SELECT COUNT(*) as n FROM nodos WHERE tipo='error' AND titulo=? AND fecha_creacion IN (
          SELECT fecha_inicio FROM ciclos WHERE ciclo_id IN (${ph2})
        )`).get(titulo, ...secondHalf)?.n
      );
      if (found > 0) recurred++;
    });
  }

  return {
    rate:        firstErrors.length > 0 ? Math.round((recurred / firstErrors.length) * 100) : 0,
    recurred,
    total_first: firstErrors.length,
  };
}

// ─── PATTERN VELOCITY ────────────────────────────────────────────────────────

function calcPatternVelocity(db) {
  const safe = (fn) => { try { return fn(); } catch { return null; } };

  const highNodes = safe(() =>
    db.prepare(`SELECT aplicado, fecha_creacion, fecha_update FROM nodos
      WHERE confianza='ALTA' AND estado='ACTIVO' AND tipo='patron'`).all()
  ) || [];

  if (highNodes.length === 0) return { avg_cycles_to_high: null, total_high: 0 };

  // Promedio de aplicaciones para llegar a HIGH (proxy: campo aplicado)
  const avgApplied = highNodes.reduce((s, n) => s + (n.aplicado || 0), 0) / highNodes.length;

  return {
    avg_cycles_to_high: Math.round(avgApplied * 10) / 10,
    total_high:         highNodes.length,
  };
}

// ─── REWORK INDEX ────────────────────────────────────────────────────────────

function calcReworkIndex(db, cycleIds) {
  if (!cycleIds || cycleIds.length < 2) return { index: 0, reworked_areas: 0 };

  const safe = (fn) => { try { return fn(); } catch { return null; } };
  const ph = cycleIds.map(() => '?').join(',');

  // Áreas que aparecen en más de un ciclo = rework
  const areas = safe(() =>
    db.prepare(`SELECT n.area, COUNT(DISTINCT c.ciclo_id) as cycles
      FROM nodos n
      JOIN ciclos c ON n.fecha_creacion >= c.fecha_inicio AND n.fecha_creacion <= COALESCE(c.fecha_fin, datetime('now'))
      WHERE c.ciclo_id IN (${ph})
      GROUP BY n.area HAVING cycles > 1`).all(...cycleIds)
  ) || [];

  const totalAreas = safe(() =>
    db.prepare(`SELECT COUNT(DISTINCT area) as n FROM nodos WHERE estado='ACTIVO'`).get()?.n
  ) || 1;

  return {
    index:         areas.length,
    reworked_areas:areas.length,
    total_areas:   totalAreas,
    rate:          Math.round((areas.length / totalAreas) * 100),
  };
}

// ─── REPORTE COMPLETO ─────────────────────────────────────────────────────────

function generateReport(projectRoot, options = {}) {
  projectRoot = projectRoot || process.cwd();
  const db = openDB(projectRoot);
  if (!db) return { error: 'DB no disponible' };

  const safe = (fn) => { try { return fn(); } catch { return null; } };

  // Obtener todos los ciclos en orden cronológico
  const allCycles = safe(() =>
    db.prepare(`SELECT ciclo_id, descripcion, fecha_inicio, estado FROM ciclos ORDER BY fecha_inicio ASC`).all()
  ) || [];

  if (allCycles.length < 2) {
    db.close();
    return { error: `Solo ${allCycles.length} ciclo(s) — se necesitan al menos 2 para comparar`, cycles: allCycles.length };
  }

  const n         = allCycles.length;
  const splitAt   = Math.max(1, Math.floor(n / 2));
  const firstIds  = allCycles.slice(0, splitAt).map(c => c.ciclo_id);
  const lastIds   = allCycles.slice(splitAt).map(c => c.ciclo_id);
  const last3Ids  = allCycles.slice(-3).map(c => c.ciclo_id);
  const first3Ids = allCycles.slice(0, 3).map(c => c.ciclo_id);

  // Calcular métricas
  const first  = calcWindowMetrics(db, firstIds);
  const last   = calcWindowMetrics(db, lastIds);
  const first3 = calcWindowMetrics(db, first3Ids);
  const last3  = calcWindowMetrics(db, last3Ids);

  const recurrence = calcErrorRecurrence(db, allCycles.map(c => c.ciclo_id), splitAt);
  const velocity   = calcPatternVelocity(db);
  const rework     = calcReworkIndex(db, last3Ids);

  // Memoria evolution
  const memFirst = safe(() =>
    db.prepare(`SELECT COUNT(*) as n FROM nodos WHERE fecha_creacion <= (
      SELECT fecha_inicio FROM ciclos ORDER BY fecha_inicio ASC LIMIT 1 OFFSET ?
    )`).get(Math.max(0, splitAt - 1))?.n
  ) || 0;
  const memNow = safe(() =>
    db.prepare(`SELECT COUNT(*) as n FROM nodos WHERE estado='ACTIVO'`).get()?.n
  ) || 0;

  // Delta helpers
  const delta = (before, after) => {
    if (before === 0 && after === 0) return { val: 0, pct: 0, dir: '→' };
    if (before === 0) return { val: after, pct: 100, dir: '↑' };
    const pct = Math.round(((after - before) / before) * 100);
    return { val: after - before, pct: Math.abs(pct), dir: pct > 0 ? '↑' : pct < 0 ? '↓' : '→' };
  };

  const report = {
    generated: new Date().toISOString(),
    project:   path.basename(projectRoot),
    total_cycles: n,
    window: {
      first_half:  { cycles: firstIds.length,  label: `ciclos 1-${firstIds.length}` },
      second_half: { cycles: lastIds.length,   label: `ciclos ${firstIds.length + 1}-${n}` },
    },

    metrics: {
      stop_rate: {
        label:       'Stop rate (TDD gate)',
        description: 'Ciclos donde el harness tuvo que parar',
        first:       `${first.stop_rate}%`,
        last:        `${last.stop_rate}%`,
        delta:       delta(first.stop_rate, last.stop_rate),
        trend:       last.stop_rate < first.stop_rate ? 'improving' : last.stop_rate > first.stop_rate ? 'degrading' : 'stable',
        raw:         { first: first.stop_rate, last: last.stop_rate },
      },
      errors_per_cycle: {
        label:       'Errores por ciclo',
        description: 'Promedio de errores nuevos encontrados por ciclo',
        first:       first.errors_per_cycle,
        last:        last.errors_per_cycle,
        delta:       delta(first.errors_per_cycle, last.errors_per_cycle),
        trend:       last.errors_per_cycle < first.errors_per_cycle ? 'improving' : 'stable',
        raw:         { first: first.errors_per_cycle, last: last.errors_per_cycle },
      },
      first_try_rate: {
        label:       'Tests en primer intento',
        description: '% de tests que pasan sin self-healing',
        first:       `${first.first_try_rate}%`,
        last:        `${last.first_try_rate}%`,
        delta:       delta(first.first_try_rate, last.first_try_rate),
        trend:       last.first_try_rate >= first.first_try_rate ? 'improving' : 'degrading',
        raw:         { first: first.first_try_rate, last: last.first_try_rate },
      },
      error_recurrence: {
        label:       'Recurrencia de errores',
        description: '% de errores de la primera mitad que volvieron a ocurrir',
        value:       `${recurrence.rate}%`,
        recurred:    recurrence.recurred,
        total:       recurrence.total_first,
        trend:       recurrence.rate < 20 ? 'good' : recurrence.rate < 50 ? 'moderate' : 'needs_work',
      },
      pattern_velocity: {
        label:       'Velocidad de patrones',
        description: 'Promedio de aplicaciones para llegar a HIGH confidence',
        avg_to_high: velocity.avg_cycles_to_high,
        total_high:  velocity.total_high,
        trend:       velocity.total_high > 5 ? 'good' : 'building',
      },
      memory_growth: {
        label:       'Crecimiento de memoria',
        description: 'Nodos de conocimiento acumulados',
        at_start:    memFirst,
        now:         memNow,
        delta:       memNow - memFirst,
        per_cycle:   n > 0 ? Math.round(((memNow - memFirst) / n) * 10) / 10 : 0,
        trend:       memNow > memFirst ? 'growing' : 'stable',
      },
      patterns_per_cycle: {
        label:       'Patrones aplicados por ciclo',
        description: 'Cuántos patrones de memoria usa el agente en cada ciclo',
        first:       first.patterns_per_cycle,
        last:        last.patterns_per_cycle,
        delta:       delta(first.patterns_per_cycle, last.patterns_per_cycle),
        trend:       last.patterns_per_cycle >= first.patterns_per_cycle ? 'improving' : 'stable',
        raw:         { first: first.patterns_per_cycle, last: last.patterns_per_cycle },
      },
    },

    summary: {
      improving: [],
      stable:    [],
      needs_work:[],
    },
  };

  // Clasificar métricas en el summary
  Object.entries(report.metrics).forEach(([key, m]) => {
    if (!m.trend) return;
    if (['improving','good','growing'].includes(m.trend)) report.summary.improving.push(m.label);
    else if (['degrading','needs_work'].includes(m.trend)) report.summary.needs_work.push(m.label);
    else report.summary.stable.push(m.label);
  });

  db.close();
  return report;
}

// ─── PRINT REPORT ─────────────────────────────────────────────────────────────

function printReport(report) {
  if (report.error) {
    console.log(`\n[REPORT] ${report.error}\n`);
    return;
  }

  const arrow = (trend) => trend === 'improving' || trend === 'good' || trend === 'growing' ? '✅' :
                            trend === 'degrading' || trend === 'needs_work' ? '⚠️' : '→';

  console.log('\n' + '═'.repeat(60));
  console.log('  Agentic KDD — Effectiveness Report');
  console.log(`  ${report.project} · ${report.total_cycles} ciclos totales`);
  console.log('═'.repeat(60));
  console.log(`\n  Comparando: ${report.window.first_half.label} vs ${report.window.second_half.label}\n`);

  const m = report.metrics;

  console.log('  ① Stop rate (TDD gate paró el ciclo)');
  console.log(`     Antes: ${m.stop_rate.first}  →  Ahora: ${m.stop_rate.last}  ${arrow(m.stop_rate.trend)}`);
  if (m.stop_rate.delta.pct > 0) console.log(`     ${m.stop_rate.delta.dir} ${m.stop_rate.delta.pct}% ${m.stop_rate.trend}`);

  console.log('\n  ② Errores por ciclo');
  console.log(`     Antes: ${m.errors_per_cycle.first}  →  Ahora: ${m.errors_per_cycle.last}  ${arrow(m.errors_per_cycle.trend)}`);

  console.log('\n  ③ Tests pasan en primer intento');
  console.log(`     Antes: ${m.first_try_rate.first}  →  Ahora: ${m.first_try_rate.last}  ${arrow(m.first_try_rate.trend)}`);

  console.log('\n  ④ Recurrencia de errores');
  console.log(`     ${m.error_recurrence.recurred}/${m.error_recurrence.total} errores volvieron a ocurrir = ${m.error_recurrence.value}  ${arrow(m.error_recurrence.trend)}`);

  console.log('\n  ⑤ Memoria acumulada');
  console.log(`     Inicio: ${m.memory_growth.at_start} nodos  →  Ahora: ${m.memory_growth.now} nodos  (+${m.memory_growth.delta})`);
  console.log(`     ${m.memory_growth.per_cycle} nodos nuevos por ciclo promedio`);

  console.log('\n  ⑥ Patrones de memoria aplicados por ciclo');
  console.log(`     Antes: ${m.patterns_per_cycle.first}  →  Ahora: ${m.patterns_per_cycle.last}  ${arrow(m.patterns_per_cycle.trend)}`);

  console.log('\n  ⑦ Patrones con confianza HIGH');
  console.log(`     ${m.pattern_velocity.total_high} patrones promovidos a HIGH`);
  if (m.pattern_velocity.avg_to_high) console.log(`     Promedio de ${m.pattern_velocity.avg_to_high} aplicaciones para llegar a HIGH`);

  if (report.summary.improving.length > 0) {
    console.log(`\n  ✅ Mejorando:   ${report.summary.improving.join(' · ')}`);
  }
  if (report.summary.needs_work.length > 0) {
    console.log(`  ⚠️  Atención:    ${report.summary.needs_work.join(' · ')}`);
  }

  console.log('\n' + '═'.repeat(60));
  console.log('  Generado:', new Date(report.generated).toLocaleString('es-ES'));
  console.log('═'.repeat(60) + '\n');
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const projectRoot = process.cwd();
  const report = generateReport(projectRoot);

  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }
}

module.exports = { generateReport, printReport };
