'use strict';
/**
 * Métricas de contexto y esfuerzo (H03): qué se midió, CÓMO se midió y qué NO se puede afirmar.
 *
 * Principios (cada uno tiene prueba en test/context-metrics.test.cjs):
 *   · Ahorro NETO en bytes = lo que se habría entregado sin optimizar − (lo entregado optimizado
 *     + los marcadores + todo lo recuperado después). Recuperar el original resta ahorro; si lo
 *     anula, el neto es 0 o NEGATIVO y se muestra tal cual.
 *   · Se reporta el TIPO de medición. bytes/4 es una ESTIMACIÓN; no se suma con uso reportado
 *     por el host ni con un tokenizador exacto y se llama "medición" a todo. Los tokens "conocidos"
 *     solo salen de filas con measure = tokenizer | host_reported.
 *   · Sin un baseline de ejecución equivalente se habla de REDUCCIÓN DE PAYLOAD, nunca de ahorro de
 *     sesión, de razonamiento ni de dinero. El dinero solo con precios, versión y fuente conocidos.
 *   · Dato ausente = null / "no disponible", jamás 0. Lo que el host hace fuera de Agentix es
 *     "no observado".
 *   · Todo texto de salida pasa por la redacción de secretos; nada de esto es un ranking de IA
 *     por tokens.
 */

const core = require('./memory-core.cjs');

const AVISO_ALCANCE = 'Es una reducción de PAYLOAD comparable de lo que Agentix controló; no es ahorro de sesión, de razonamiento ni de dinero.';
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

/**
 * Resumen de uso para un proyecto, tarea, rol o sprint.
 * filtros: { task_id, role, sprint_id }
 */
function resumen(root, filtros = {}, opts = {}) {
  const db = core.abrir(root);
  if (!db) return { available: false, code: 'NO_DB' };
  try {
    if (core.tablasFaltantes(db, ['mem_context_usage']).length) return { available: false, code: 'SCHEMA_MISSING', hint: 'Ejecuta: akdd update' };
    const w = ['1 = 1']; const a = [];
    for (const [col, v] of [['task_id', filtros.task_id], ['role', filtros.role], ['sprint_id', filtros.sprint_id]]) if (v) { w.push(col + ' = ?'); a.push(String(v)); }
    const DONDE = ['WHERE', w.join(' AND ')].join(' ');
    const filas = db.all(['SELECT kind, observed, measure, count(*) AS n, COALESCE(SUM(original_bytes),0) AS o, COALESCE(SUM(delivered_bytes),0) AS d, COALESCE(SUM(recovered_bytes),0) AS r,',
      'COALESCE(SUM(tokens_original),0) AS to_, COALESCE(SUM(tokens_delivered),0) AS td, SUM(CASE WHEN tokens_delivered IS NOT NULL THEN 1 ELSE 0 END) AS conocidos,',
      'COALESCE(SUM(latency_ms),0) AS lat FROM mem_context_usage', DONDE, 'GROUP BY kind, observed, measure'].join(' '), ...a);
    if (!filas.length) return { available: true, empty: true, filters: filtros, scope_notice: AVISO_ALCANCE, net: null, tokens: { estimated: null, known: null }, coverage: { observed_kinds: [], not_observed: [] } };

    const por = {}; const medidas = {}; const noObservado = []; let lat = 0; let tokensConocidos = 0; let hayConocidos = false;
    let compOrig = 0; let compEnt = 0; let compRec = 0; let totalEntregado = 0; let totalRecuperado = 0;
    for (const f of filas) {
      if (!Number(f.observed)) { if (!noObservado.includes(f.kind)) noObservado.push(f.kind); continue; }
      const k = (por[f.kind] = por[f.kind] || { calls: 0, original_bytes: 0, delivered_bytes: 0, recovered_bytes: 0 });
      k.calls += Number(f.n); k.original_bytes += Number(f.o); k.delivered_bytes += Number(f.d); k.recovered_bytes += Number(f.r);
      medidas[f.measure] = (medidas[f.measure] || 0) + Number(f.n);
      lat += Number(f.lat);
      totalEntregado += Number(f.d); totalRecuperado += Number(f.r);
      if (f.kind === 'compression') { compOrig += Number(f.o); compEnt += Number(f.d); compRec += Number(f.r); }
      if ((f.measure === 'tokenizer' || f.measure === 'host_reported') && Number(f.conocidos) > 0) { hayConocidos = true; tokensConocidos += Number(f.td); }
    }
    // Lo recuperado por otras vías (evidencia, detalle) también se entregó al modelo: pesa contra el ahorro de compactar.
    const recuperadoTotal = totalRecuperado;
    const neto = compOrig - (compEnt + recuperadoTotal);
    const tipos = Object.keys(medidas);
    const kindCalls = (k) => (por[k] ? por[k].calls : 0);
    const out = {
      available: true, empty: false, filters: filtros, scope_notice: AVISO_ALCANCE,
      bytes: { original_compactable: compOrig, delivered_compacted: compEnt, delivered_total: totalEntregado, recovered_after: recuperadoTotal },
      net: { bytes: neto, percent: pct(neto, compOrig), baseline: 'payload comparable (original_bytes de lo compactado)', negative: neto < 0, nullified: compOrig > 0 && neto <= 0 },
      tokens: {
        estimated: Math.ceil((totalEntregado + recuperadoTotal) / 4), estimated_measure: 'estimated_bytes4',
        known: hayConocidos ? tokensConocidos : null,
        measure_types: tipos.length ? (tipos.length === 1 ? tipos[0] : 'mixed') : 'not_available',
        note: tipos.length > 1 ? 'Hay mediciones de distinto tipo: NO se suman en un solo número.' : null,
      },
      by_kind: por,
      calls: { recoveries: kindCalls('evidence_retrieval') + kindCalls('recall_detail'), compressions: kindCalls('compression'), reads: kindCalls('file_read'), searches: kindCalls('search'), delegations: kindCalls('delegation'), repairs: kindCalls('repair'), tool_calls: kindCalls('tool_call') },
      reuse: { rereads_avoided: kindCalls('reread_unchanged'), cache_hits: kindCalls('cache_hit'), cache_invalidations: kindCalls('cache_invalidation') },
      latency_ms: { compression_and_other: lat },
      coverage: { observed_kinds: Object.keys(por), not_observed: noObservado, note: noObservado.length ? 'Agentix NO observó estas herramientas del host: su ausencia en las cifras no prueba que no se usaran.' : null },
      provider_usage: { available: false, reason: 'Solo se muestra uso de proveedor/caché cuando el host lo reporta; no se deduce por igualdad local de cadenas.' },
      cost: costo(opts.precios, hayConocidos ? tokensConocidos : null),
      quality: { available: false, reason: 'La calidad (criterios cumplidos, regresiones, gates) no sale del uso de contexto: ver el benchmark y el resultado de los gates.' },
    };
    return out;
  } finally { db.close(); }
}

/** Dinero SOLO con precios, versión y fuente conocidos. Si no: no disponible (no 0). */
function costo(precios, tokens) {
  if (!precios || !precios.source || !precios.version || !Number.isFinite(Number(precios.usd_per_mtok_input))) return { available: false, reason: 'Sin precios con versión y fuente conocidas: no se calcula dinero.' };
  if (tokens == null) return { available: false, reason: 'No hay tokens medidos (tokenizador o uso del host): bytes/4 es una estimación y no se convierte en dinero.' };
  return { available: true, usd: Math.round((tokens / 1e6) * Number(precios.usd_per_mtok_input) * 1e6) / 1e6, source: precios.source, version: precios.version, note: 'Solo tokens de entrada medidos; no incluye salida ni razonamiento.' };
}

/** Distribución de resultados de una lista de casos: se publica la distribución, no un ejemplo favorable. */
function distribucion(netosPct) {
  const v = netosPct.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const q = (p) => v[Math.min(v.length - 1, Math.floor(p * (v.length - 1)))];
  return { n: v.length, min: v[0], p25: q(0.25), median: q(0.5), p75: q(0.75), max: v[v.length - 1], negative_or_zero: v.filter((x) => x <= 0).length };
}

module.exports = { AVISO_ALCANCE, resumen, costo, distribucion, pct };
