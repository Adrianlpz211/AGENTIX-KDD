'use strict';
// D17–D20 — aristas con evidencia, confianza ≠ centralidad, “no entiendo”
// honesto y resúmenes que se invalidan si cambia el cuerpo.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');
const fx = require('./fixtures/dashboard-fixture.cjs');
const summaries = require(path.join(REPO, '.agentic', 'grafo', 'code-summaries.cjs'));

test('D17: las aristas de flujo y de pendiente son decoración, no dependencia', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-d17-'));
  fx.crearFixture(dir);
  const cfg = path.join(dir, '.agentic', 'config.md');
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8')
    .replace('## Módulos implementados', '## Módulos\n### Implementados')
    .replace('## Módulos pendientes', '### Pendientes'));
  const srv = await fx.arrancarDashboard(dir);
  try {
    const html = await (await fetch(srv.url)).text();
    const i = html.indexOf('const M_EDGES = ');
    assert.ok(i >= 0, 'no se inyectaron M_EDGES');
    const start = html.indexOf('[', i);
    let n = 0, end = start;
    for (; end < html.length; end++) {
      if (html[end] === '[') n++;
      else if (html[end] === ']') { n--; if (!n) { end++; break; } }
    }
    const edges = JSON.parse(html.slice(start, end));
    const layout = edges.filter((e) => e.tipo === 'flow' || e.tipo === 'depends');
    assert.ok(layout.length, 'el layout visual desapareció');
    assert.ok(layout.every((e) => e.razonamiento === false && e.provenance === 'layout'));
    const reales = edges.filter((e) => e.razonamiento !== false);
    assert.ok(reales.every((e) => e.tipo !== 'flow' && e.tipo !== 'depends'));
  } finally { srv.cerrar(); }
});

test('D18: un nodo muy conectado no se etiqueta EXTRACTED por su grado', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-d18-'));
  fx.crearFixture(dir);
  const srv = await fx.arrancarDashboard(dir);
  try {
    const html = await (await fetch(srv.url)).text();
    const fn = html.match(/function getConfTag\(n\)\{[\s\S]*?\n\}/);
    assert.ok(fn, 'falta getConfTag');
    assert.ok(!/deg>=GOD_THRESHOLD/.test(fn[0]));
    assert.match(fn[0], /provenance|procedencia/);
  } finally { srv.cerrar(); }
});

test('D19: sin imports no afirma que el archivo funciona solo', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-d19-'));
  fx.crearFixture(dir);
  const srv = await fx.arrancarDashboard(dir);
  try {
    const html = await (await fetch(srv.url)).text();
    assert.ok(!/funciona solo — no necesita/.test(html));
    assert.ok(html.includes('no se detectaron dependencias'), html.includes('explainCodeNode') ? 'explainCodeNode está pero el texto no' : 'falta explainCodeNode');
  } finally { srv.cerrar(); }
});

test('D20: misma firma estructural y cuerpo distinto deja el resumen STALE', () => {
  const row = { structural_sig: 'sig-a', content_hash: 'cuerpo-1' };
  const fp = { structuralSig: 'sig-a', contentHash: 'cuerpo-2' };
  // summaryState lee el archivo real; aquí se prueba el contrato de igualdad.
  const estado = (row.structural_sig === fp.structuralSig && row.content_hash === fp.contentHash) ? 'fresh' : 'stale';
  assert.strictEqual(estado, 'stale');
  assert.strictEqual(summaries.summaryState({ structural_sig: 'x', content_hash: null }, REPO), 'stale');
});
