'use strict';
/* H03 — Benchmark propio y determinista, y métricas de ahorro neto honestas. */
const test = require('node:test');
const { SIN_DRIVER } = require('./helpers/db-real.cjs');
if (SIN_DRIVER) { test(require('node:path').basename(__filename) + ' (omitido: ' + SIN_DRIVER + ')', { skip: SIN_DRIVER }, () => {}); return; }
const assert = require('node:assert/strict');
const path = require('node:path');

const { proyecto, REPO } = require('./helpers/memoria-proyecto.cjs');
const G = path.join(REPO, '.agentic', 'grafo');
const bench = require(path.join(G, 'benchmark-contexto.cjs'));
const metrics = require(path.join(G, 'context-metrics.cjs'));
const usage = require(path.join(G, 'context-usage.cjs'));

const firma = (r) => r.cases.map((c) => [c.id, c.baseline_bytes, c.optimized_bytes, c.recovered_bytes, c.criteria_met, c.criteria_total].join(':')).join('|');

test('benchmark: ocho casos A–H, ningún criterio de aceptación perdido, y se publica la distribución (incluido lo que no ahorra)', () => {
  const r = bench.ejecutar({ seed: 20261003 });
  assert.deepEqual(r.cases.map((c) => c.id), ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
  for (const c of r.cases) assert.equal(c.passed, true, c.id + ' perdió: ' + JSON.stringify((c.criteria || []).filter((x) => !x.ok)));
  assert.equal(r.acceptance.no_criterion_lost, true);
  assert.equal(r.acceptance.criteria_met, r.acceptance.criteria_total);
  assert.ok(r.distribution_net_percent && r.distribution_net_percent.n === 8);
  assert.ok(r.distribution_net_percent.min <= 0, 'la distribución incluye el caso SIN ahorro (riesgo alto), no solo los favorables');
  assert.ok(r.cases_without_saving.includes('C'), 'un cambio pequeño de riesgo alto no ahorra: se dice');
  // Honestidad del alcance.
  assert.equal(r.real_model_campaigns.status, 'NO_EJECUTADO');
  assert.equal(r.user_data, false);
  assert.match(r.scope_notice, /no es ahorro de sesión, de razonamiento ni de dinero/);
  assert.match(r.measure.tokens, /estimated_bytes4/);
  assert.equal(r.measure.money, 'no calculado');
  // Todo ahorro es NETO: incluye lo recuperado.
  for (const c of r.cases) assert.equal(c.net_bytes, c.baseline_bytes - (c.optimized_bytes + c.recovered_bytes), c.id);
});

test('benchmark: es reproducible con la misma semilla (y la semilla importa en lo generado)', () => {
  const a = bench.ejecutar({ seed: 7, only: ['B', 'E', 'H'] });
  const b = bench.ejecutar({ seed: 7, only: ['B', 'E', 'H'] });
  assert.equal(firma(a), firma(b), 'misma semilla, mismas cifras');
  const c = bench.ejecutar({ seed: 8, only: ['B', 'E', 'H'] });
  assert.notEqual(firma(a), firma(c), 'otra semilla genera otro corpus');
});

test('benchmark: CLI list/run salen bien y run devuelve 0 solo si no se perdió ningún criterio', () => {
  const { spawnSync } = require('node:child_process');
  const l = spawnSync(process.execPath, [path.join(G, 'benchmark-contexto.cjs'), 'list'], { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  assert.equal(l.status, 0);
  assert.equal(JSON.parse(l.stdout).length, 8);
  const r = spawnSync(process.execPath, [path.join(G, 'benchmark-contexto.cjs'), 'run', '--only=A,C', '--json'], { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' }, timeout: 300000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).cases.length, 2);
});

// ───────────────────────── métricas ─────────────────────────
test('métricas: el ahorro es NETO — recuperar el original resta, y si lo anula se muestra negativo', () => {
  const p = proyecto('met-neto');
  try {
    usage.registrar(p.root, { task_id: 'T1', role: 'builder', kind: 'compression', original_bytes: 100000, delivered_bytes: 5000, latency_ms: 12 });
    let m = metrics.resumen(p.root, { task_id: 'T1' });
    assert.equal(m.net.bytes, 95000);
    assert.equal(m.net.percent, 95);
    assert.equal(m.net.nullified, false);
    usage.registrar(p.root, { task_id: 'T1', role: 'builder', kind: 'evidence_retrieval', recovered_bytes: 120000 });
    m = metrics.resumen(p.root, { task_id: 'T1' });
    assert.equal(m.net.bytes, 100000 - (5000 + 120000));
    assert.equal(m.net.negative, true);
    assert.equal(m.net.nullified, true, 'si recuperar lo anula, se dice');
    assert.equal(m.calls.recoveries, 1);
    assert.match(m.scope_notice, /PAYLOAD/);
  } finally { p.limpiar(); }
});

test('métricas: bytes/4 es ESTIMACIÓN y no se mezcla con uso exacto del host ni se convierte en dinero', () => {
  const p = proyecto('met-tokens');
  try {
    usage.registrar(p.root, { task_id: 'T2', kind: 'compression', original_bytes: 4000, delivered_bytes: 400, measure: 'estimated_bytes4' });
    let m = metrics.resumen(p.root, { task_id: 'T2' });
    assert.equal(m.tokens.known, null, 'sin tokenizador ni uso del host no hay tokens "conocidos"');
    assert.equal(m.tokens.measure_types, 'estimated_bytes4');
    assert.equal(m.cost.available, false);
    usage.registrar(p.root, { task_id: 'T2', kind: 'tool_call', measure: 'host_reported', tokens_delivered: 777 });
    m = metrics.resumen(p.root, { task_id: 'T2' });
    assert.equal(m.tokens.measure_types, 'mixed');
    assert.ok(m.tokens.note && /NO se suman/.test(m.tokens.note));
    assert.equal(m.tokens.known, 777, 'solo suma lo reportado por el host');
    // Dinero: solo con precios, versión y fuente; y nunca desde bytes/4.
    assert.equal(metrics.costo({ usd_per_mtok_input: 3 }, 777).available, false);
    const c = metrics.costo({ usd_per_mtok_input: 3, version: '2026-10', source: 'tarifa del proveedor' }, 777);
    assert.equal(c.available, true);
    assert.equal(c.usd, 0.002331);
    assert.equal(metrics.costo({ usd_per_mtok_input: 3, version: 'v', source: 's' }, null).available, false);
  } finally { p.limpiar(); }
});

test('métricas: dato ausente es null / "no disponible", nunca 0; lo no observado se dice', () => {
  const p = proyecto('met-ausente');
  const q = proyecto('met-sin-tablas', { catalogo: false, nodos: 0 });
  try {
    const vacio = metrics.resumen(p.root, { task_id: 'NADA' });
    assert.equal(vacio.empty, true);
    assert.equal(vacio.net, null);
    assert.equal(vacio.tokens.known, null);
    assert.equal(metrics.resumen(q.root, {}).code, 'SCHEMA_MISSING');
    usage.registrarNoObservado(p.root, { task_id: 'T3', role: 'builder' });
    usage.registrar(p.root, { task_id: 'T3', kind: 'file_read', delivered_bytes: 100 });
    const m = metrics.resumen(p.root, { task_id: 'T3' });
    assert.ok(m.coverage.not_observed.includes('host_tool'));
    assert.match(m.coverage.note, /NO observó/);
    assert.equal(m.provider_usage.available, false);
    assert.equal(m.quality.available, false);
  } finally { p.limpiar(); q.limpiar(); }
});

test('métricas: la distribución resume sin esconder los casos malos', () => {
  const d = metrics.distribucion([99, 94, 0, -3, 41, 71]);
  assert.equal(d.n, 6);
  assert.equal(d.min, -3);
  assert.equal(d.negative_or_zero, 2);
  assert.equal(metrics.distribucion([]), null);
});
