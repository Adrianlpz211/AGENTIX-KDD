'use strict';

/* H31 — uso real y estimado separados, sin dato = null, dos proveedores
   normalizados sin doble conteo, benchmark por clase con calidad. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cu = require('../.agentic/grafo/costo-uso.cjs');
const metrics = require('../.agentic/grafo/metrics.cjs');

function proyecto() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-h31-'));
  fs.mkdirSync(path.join(root, '.agentic'), { recursive: true });
  return root;
}

test('H31: usage ausente es null, no cero', () => {
  const n = cu.normalizar('anthropic', undefined);
  assert.strictEqual(n.kind, 'unknown');
  assert.deepStrictEqual(n.tokens, { input: null, output: null, cache_read: null, cache_write: null });
  assert.strictEqual(cu.totalTokens(n.tokens), null);
  const r = cu.resumen([{ kind: 'unknown', tokens: n.tokens }]);
  assert.strictEqual(r.real.total, null);
  assert.strictEqual(r.real.input, null);
  assert.strictEqual(r.sin_dato, 1);
  assert.strictEqual(cu.normalizar('desconocido', { input_tokens: 5 }).kind, 'unknown');
});

test('H31: anthropic y openai normalizados sin doble conteo de caché', () => {
  const a = cu.normalizar('anthropic', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 900, cache_creation_input_tokens: 200 });
  assert.deepStrictEqual(a.tokens, { input: 100, output: 50, cache_read: 900, cache_write: 200 });
  assert.strictEqual(cu.totalTokens(a.tokens), 1250);

  const o = cu.normalizar('openai', { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 900 } });
  assert.deepStrictEqual(o.tokens, { input: 100, output: 50, cache_read: 900, cache_write: null });
  assert.strictEqual(cu.totalTokens(o.tokens), 1050, 'lo cacheado no se cuenta dos veces');

  const r = cu.normalizar('openai', { input_tokens: 300, output_tokens: 20, input_tokens_details: { cached_tokens: 100 } });
  assert.deepStrictEqual(r.tokens, { input: 200, output: 20, cache_read: 100, cache_write: null });

  const g = cu.normalizar('gemini', { usageMetadata: { promptTokenCount: 500, cachedContentTokenCount: 400, candidatesTokenCount: 30, thoughtsTokenCount: 10 } });
  assert.deepStrictEqual(g.tokens, { input: 100, output: 40, cache_read: 400, cache_write: null });

  const sinDetalle = cu.normalizar('openai', { prompt_tokens: 10, completion_tokens: 2 });
  assert.strictEqual(sinDetalle.tokens.cache_read, null);
  assert.ok(sinDetalle.nota);
});

test('H31: estimado no se suma con real; costo solo con precios dados', () => {
  const root = proyecto();
  cu.registrar(root, { provider: 'anthropic', model: 'm', usage: { input_tokens: 10, output_tokens: 5 } });
  cu.registrar(root, { estimado: true, bytes: 4000 });
  cu.registrar(root, { provider: 'openai', usage: null });
  const s = cu.resumen(cu.leer(root));
  assert.strictEqual(s.real.total, 15);
  assert.strictEqual(s.estimado.input, 1000);
  assert.strictEqual(s.sin_dato, 1);

  const reg = cu.leer(root)[0];
  assert.strictEqual(cu.costo(reg, null), null);
  assert.strictEqual(cu.costo(reg, { anthropic: { input: 3 } }), null, 'falta precio de output → null');
  assert.strictEqual(cu.costo(reg, { anthropic: { input: 3, output: 15 } }), 0.000105);

  const traza = fs.readdirSync(path.join(root, '.agentic', 'telemetria')).filter((f) => f.startsWith('trace_'));
  assert.ok(traza.length, 'el uso también queda en la traza');
});

test('H31: benchmark low/medium/high con calidad; sin datos no hay ahorro', () => {
  const root = proyecto();
  const vacio = metrics.estimateTokenSavings(null, root);
  assert.strictEqual(vacio.total_tokens_estimados_ahorrados, null);
  assert.strictEqual(vacio.ahorro_por_clase, null);
  assert.strictEqual(metrics.computeTokenReductionIndex(null, root).passes, null);

  const corrida = (clase, variante, input, calidad) => cu.registrar(root, {
    provider: 'anthropic', usage: { input_tokens: input, output_tokens: 100 }, clase, variante, calidad, ms: 1000,
  });
  for (const t of [1000, 1100, 900]) corrida('low', 'baseline', t, 'PASS');
  for (const t of [500, 600, 400]) corrida('low', 'kdd', t, 'PASS');
  for (const t of [2000, 2000, 2000]) corrida('medium', 'baseline', t, 'PASS');
  for (const t of [800, 800]) corrida('medium', 'kdd', t, 'FAIL');
  corrida('medium', 'kdd', 800, 'PASS');
  for (const t of [5000, 5000]) corrida('high', 'baseline', t, 'PASS');
  corrida('high', 'kdd', 1000, 'PASS');

  const b = cu.benchmark(cu.leer(root));
  assert.strictEqual(b.clases.low.veredicto, 'MENOS_TOKENS_MISMA_O_MEJOR_CALIDAD');
  assert.strictEqual(b.clases.low.diferencia_tokens_pct, -45.5);
  assert.strictEqual(b.clases.low.kdd.calidad_pass, 1);
  assert.strictEqual(b.clases.medium.veredicto, 'CALIDAD_PEOR', 'menos tokens con peor calidad no es ahorro');
  assert.strictEqual(b.clases.high.veredicto, 'MUESTRA_INSUFICIENTE');

  const s = metrics.estimateTokenSavings(null, root);
  assert.deepStrictEqual(s.ahorro_por_clase.map((a) => a.clase), ['low']);

  const src = fs.readFileSync(path.join(__dirname, '..', '.agentic', 'grafo', 'metrics.cjs'), 'utf8');
  assert.doesNotMatch(src, /tokensWithoutKDD\s*=\s*8000|\*\s*800;/, 'sin constantes de ahorro');
});
