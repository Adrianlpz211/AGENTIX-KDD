'use strict';
// El diseño de todos los grafos del dashboard no cambia: cada vista se compara
// contra la referencia capturada ANTES de tocar el render (test/fixtures/dashboard-baseline).

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const REPO = path.join(__dirname, '..');
const baseline = require(path.join(REPO, 'scripts', 'dashboard-baseline.cjs'));

function hayNavegador() {
  try { require.resolve('playwright-core', { paths: [REPO] }); return true; } catch { return false; }
}

test('DASH-BASE: existe la referencia aprobada con su procedencia', () => {
  const b = baseline.leerBase();
  assert.ok(b, 'falta test/fixtures/dashboard-baseline/firmas.json');
  for (const c of ['baseline_id', 'viewport', 'browser_version', 'asset_hash', 'fixture_hash', 'aprobacion']) assert.ok(b[c], 'falta ' + c);
  for (const v of baseline.VISTAS.map((x) => x.id)) assert.ok(Array.isArray(b.vistas[v]) && b.vistas[v].length, 'vista sin firma: ' + v);
});

test('DASH-BASE: comparar detecta un control movido, restilado o desaparecido', () => {
  const base = { v: [{ k: 'a', x: 10, y: 10, w: 50, h: 20, color: 'red' }, { k: 'b', x: 0, y: 0, w: 1, h: 1 }] };
  assert.deepStrictEqual(baseline.comparar(base, { v: [{ k: 'a', x: 11, y: 10, w: 50, h: 20, color: 'red' }, { k: 'b', x: 0, y: 0, w: 1, h: 1 }] }).v.cambios, []);
  const d = baseline.comparar(base, { v: [{ k: 'a', x: 30, y: 10, w: 50, h: 20, color: 'blue' }, { k: 'c', x: 0, y: 0, w: 1, h: 1 }] }).v;
  assert.deepStrictEqual(Object.keys(d.cambios[0].campos).sort(), ['color', 'x']);
  assert.deepStrictEqual(d.desaparecidos, ['b']);
  assert.deepStrictEqual(d.agregados, ['c']);
});

test('DASH-BASE: las 7 vistas siguen idénticas a la referencia', { timeout: 240000, skip: hayNavegador() ? false : 'sin playwright-core' }, async () => {
  const r = await baseline.compararActual();
  assert.notStrictEqual(r.status, 'UNVERIFIED', r.reason_code);
  assert.strictEqual(r.status, 'PASS', JSON.stringify({ rotas: r.rotas, errores: r.errores, dif: r.diferencias }, null, 1).slice(0, 3000));
});

test('DASH-BASE: las 4 vistas del segundo grafo (graph-ui) siguen idénticas a la referencia', { timeout: 180000, skip: hayNavegador() ? false : 'sin playwright-core' }, async () => {
  const b = baseline.leerBase('graph-ui');
  assert.ok(b && b.aprobacion && b.aprobacion.origen, 'falta la referencia aprobada de graph-ui');
  const r = await baseline.compararActual({ superficie: 'graph-ui' });
  assert.notStrictEqual(r.status, 'UNVERIFIED', r.reason_code);
  assert.strictEqual(r.status, 'PASS', JSON.stringify({ rotas: r.rotas, errores: r.errores, dif: r.diferencias }, null, 1).slice(0, 3000));
});
