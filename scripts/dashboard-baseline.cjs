#!/usr/bin/env node
'use strict';

/**
 * Referencia de diseño del dashboard (01-CONTRATO-DE-GRAFOS). El layout 3D es
 * aleatorio, así que la referencia no es un PNG del lienzo: es la firma de
 * cada control visible fuera del lienzo (posición, tamaño, color, fondo,
 * fuente, borde, radio, opacidad, capa) por vista, más una captura para mirar.
 *
 *   node scripts/dashboard-baseline.cjs capturar --motivo="..."   (solo si no hay base)
 *   node scripts/dashboard-baseline.cjs comparar
 *
 * La base no se reemplaza sola: `capturar` con base existente se niega salvo
 * `--cambio-intencional --motivo=...`, que deja la anterior en historial.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const REPO = path.join(__dirname, '..');
const BASE_DIR = path.join(REPO, 'test', 'fixtures', 'dashboard-baseline');
const VIEWPORT = { width: 1440, height: 900 };
const HORA = '2026-09-15T12:00:00.000Z';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/* Vistas que el contrato pide conservar. Cada una se alcanza con los mismos
   clics que haría la persona. */
const VISTAS = [
  { id: 'kdd', pasos: [] },
  { id: 'kdd-nodo', pasos: [{ js: 'typeof selectNode==="function" && selectNode(NODES[0].id)' }] },
  { id: 'code', pasos: [{ click: '.gst:nth-child(2)' }] },
  { id: 'combined', pasos: [{ click: '.gst:nth-child(3)' }] },
  { id: 'docs', pasos: [{ click: '.mode-tab:nth-child(2)' }] },
  { id: 'intel', pasos: [{ click: '.mode-tab:nth-child(3)' }] },
  { id: 'tiempos', pasos: [{ click: '.mode-tab:nth-child(4)' }] },
];

/* Segundo grafo (graph-server.cjs + graph-ui/index.html). */
const VISTAS_GRAPH_UI = [
  { id: 'kdd', pasos: [] },
  { id: 'kdd-nodo', pasos: [{ js: 'allData.nodes.length && showDetail(allData.nodes[0])' }] },
  { id: 'code', pasos: [{ js: 'showTab("code")' }] },
  { id: 'combined', pasos: [{ js: 'showTab("combined")' }] },
];

const SUPERFICIES = {
  dashboard: { vistas: VISTAS, archivo: 'firmas.json', asset: 'dashboard.cjs', listo: () => typeof ForceGraph3D === 'function' },
  'graph-ui': { vistas: VISTAS_GRAPH_UI, archivo: 'firmas-graph-ui.json', selector: '.tab, .leg-item, .stat, .detail-row, .detail-title, .detail-chip, .split-label, .sec-label, .sidebar, .logo, header, iframe', asset: '.agentic/grafo/graph-ui/index.html', listo: () => typeof ForceGraph === 'function' && typeof kddG !== 'undefined' && !!kddG },
};

function firmaEnPagina(extra) {
  const SEL = '[id], button, select, input, a, .mode-tab, .gst, .sb-tab, .fpill, [class*="legend"], [class*="panel"], [class*="btn"], [class*="badge"]' + (extra ? ', ' + extra : '');
  const out = [];
  const vistos = {};
  document.querySelectorAll(SEL).forEach((e) => {
    if (e.tagName === 'CANVAS' || e.closest('canvas')) return;
    const r = e.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return;
    const cs = getComputedStyle(e);
    if (cs.visibility === 'hidden' || cs.display === 'none') return;
    const base = (e.id ? '#' + e.id : '') + '|' + e.tagName.toLowerCase() + '.' + [...e.classList].sort().join('.') + '|' + (e.getAttribute('data-i') || '');
    vistos[base] = (vistos[base] || 0) + 1;
    out.push({
      k: base + '#' + vistos[base],
      x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
      color: cs.color, bg: cs.backgroundColor, font: cs.fontSize + ' ' + cs.fontWeight + ' ' + cs.fontFamily,
      borde: cs.borderTopWidth + ' ' + cs.borderTopStyle + ' ' + cs.borderTopColor, radio: cs.borderRadius,
      opacidad: cs.opacity, capa: cs.zIndex, pos: cs.position,
    });
  });
  // Estado del grafo sin depender del layout aleatorio: tamaño del lienzo,
  // cuántos nodos y enlaces pinta, y la cámara inicial (distancia al origen).
  const grafos = typeof active3DGraphs !== 'undefined' ? active3DGraphs : {};
  for (const [id, g] of Object.entries(grafos)) {
    const cont = document.getElementById(id);
    if (!g || !cont || !cont.getBoundingClientRect().width) continue;
    let datos = { nodes: [], links: [] };
    try { datos = g.graphData(); } catch { /* sin datos */ }
    const cam = g.camera ? g.camera() : null;
    out.push({ k: 'grafo#' + id, nodos: datos.nodes.length, enlaces: datos.links.length, w: Math.round(cont.getBoundingClientRect().width), h: Math.round(cont.getBoundingClientRect().height), fov: cam ? cam.fov : null, fondo: g.backgroundColor ? g.backgroundColor() : null });
  }
  // graph-ui (force-graph 2D): kddG / comboG.
  for (const [id, g] of [['kdd-mount', typeof kddG !== 'undefined' ? kddG : null], ['combined-mount', typeof comboG !== 'undefined' ? comboG : null]]) {
    const cont = document.getElementById(id);
    if (!g || !cont || !cont.getBoundingClientRect().width) continue;
    const datos = g.graphData();
    out.push({ k: 'grafo2d#' + id, nodos: datos.nodes.length, enlaces: datos.links.length, w: Math.round(cont.getBoundingClientRect().width), h: Math.round(cont.getBoundingClientRect().height), fondo: g.backgroundColor() });
  }
  return out;
}

async function capturarVistas(url, { outDir, superficie = 'dashboard' } = {}) {
  const sup = SUPERFICIES[superficie];
  const bg = require(path.join(REPO, '.agentic', 'grafo', 'browser-gate.cjs'));
  const browser = await bg.launchBrowser('system');
  const errores = [];
  const vistas = {};
  try {
    for (const v of sup.vistas) {
      const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, locale: 'es-ES', timezoneId: 'UTC', colorScheme: 'dark' });
      const page = await ctx.newPage();
      if (page.clock && page.clock.setFixedTime) await page.clock.setFixedTime(new Date(HORA));
      page.on('pageerror', (e) => errores.push({ vista: v.id, error: String(e.message || e).slice(0, 200) }));
      await page.goto(url, { waitUntil: 'load', timeout: 60000 });
      await page.waitForFunction(sup.listo, null, { timeout: 30000 }).catch(() => errores.push({ vista: v.id, error: 'librería del grafo no cargó' }));
      await page.waitForTimeout(1200);
      for (const p of v.pasos) {
        if (p.click) await page.click(p.click);
        if (p.js) await page.evaluate(p.js);
        await page.waitForTimeout(900);
      }
      vistas[v.id] = await page.evaluate(firmaEnPagina, sup.selector || '');
      if (outDir) { fs.mkdirSync(outDir, { recursive: true }); await page.screenshot({ path: path.join(outDir, v.id + '.png') }); }
      await ctx.close();
    }
    return { vistas, errores, browser_version: browser.version() };
  } finally { await browser.close(); }
}

/** Compara firmas: cambiado o desaparecido = diferencia no autorizada; agregado se lista aparte. */
function comparar(base, actual) {
  const out = {};
  for (const [vista, filas] of Object.entries(base)) {
    const ahora = new Map((actual[vista] || []).map((f) => [f.k, f]));
    const cambios = [];
    const desaparecidos = [];
    for (const f of filas) {
      const g = ahora.get(f.k);
      if (!g) { desaparecidos.push(f.k); continue; }
      const dif = Object.keys(f).filter((c) => c !== 'k' && (['x', 'y', 'w', 'h'].includes(c) ? Math.abs(f[c] - g[c]) > 1 : f[c] !== g[c]));
      if (dif.length) cambios.push({ k: f.k, campos: Object.fromEntries(dif.map((c) => [c, [f[c], g[c]]])) });
      ahora.delete(f.k);
    }
    out[vista] = { cambios, desaparecidos, agregados: [...ahora.keys()] };
  }
  return out;
}

const archivoBase = (superficie = 'dashboard') => path.join(BASE_DIR, SUPERFICIES[superficie].archivo);
function leerBase(superficie = 'dashboard') { try { return JSON.parse(fs.readFileSync(archivoBase(superficie), 'utf8')); } catch { return null; } }

async function conFixture(fn, superficie = 'dashboard') {
  const fx = require(path.join(REPO, 'test', 'fixtures', 'dashboard-fixture.cjs'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-dash-'));
  const fixture_hash = fx.crearFixture(dir);
  if (superficie === 'graph-ui') {
    const { crearServidor } = require(path.join(REPO, '.agentic', 'grafo', 'graph-server.cjs'));
    const server = crearServidor({ root: dir });
    const port = await server.escuchar(0);
    try { return await fn(`http://localhost:${port}/`, fixture_hash); } finally { server.close(); }
  }
  const srv = await fx.arrancarDashboard(dir);
  try { return await fn(srv.url, fixture_hash); } finally { srv.cerrar(); }
}

async function capturar({ motivo, cambioIntencional, superficie = 'dashboard' } = {}) {
  const previa = leerBase(superficie);
  if (previa && !cambioIntencional) return { ok: false, reason_code: 'YA_HAY_BASE', nota: 'una base nueva necesita --cambio-intencional y motivo' };
  if (!motivo) return { ok: false, reason_code: 'SIN_MOTIVO' };
  const sup = SUPERFICIES[superficie];
  return conFixture(async (url, fixture_hash) => {
    const r = await capturarVistas(url, { superficie, outDir: path.join(REPO, '_output', superficie + '-baseline') });
    if (r.errores.length) return { ok: false, reason_code: 'ERRORES_EN_PAGINA', errores: r.errores };
    fs.mkdirSync(BASE_DIR, { recursive: true });
    if (previa) {
      const hist = path.join(BASE_DIR, 'historial');
      fs.mkdirSync(hist, { recursive: true });
      fs.writeFileSync(path.join(hist, previa.baseline_id + '.json'), JSON.stringify(previa, null, 2));
    }
    const datos = {
      baseline_id: (superficie === 'dashboard' ? 'dash-' : 'gui-') + new Date().toISOString().replace(/[:.]/g, '-'),
      project_id: 'fixture-dashboard', superficie, viewport: VIEWPORT, dpr: 1, locale: 'es-ES', timezone: 'UTC', hora: HORA,
      browser_version: r.browser_version, asset_hash: sha(fs.readFileSync(path.join(REPO, sup.asset))).slice(0, 16),
      fixture_hash, state: sup.vistas.map((v) => v.id), owner: 'persona', aprobacion: { origen: previa ? 'cambio_intencional' : 'baseline_inicial', motivo, reemplaza: previa ? previa.baseline_id : null },
      vistas: r.vistas,
    };
    fs.writeFileSync(archivoBase(superficie), JSON.stringify(datos, null, 1));
    return { ok: true, baseline_id: datos.baseline_id, vistas: Object.fromEntries(Object.entries(r.vistas).map(([k, v]) => [k, v.length])) };
  }, superficie);
}

async function compararActual({ superficie = 'dashboard' } = {}) {
  const base = leerBase(superficie);
  if (!base) return { status: 'UNVERIFIED', reason_code: 'SIN_REFERENCIA' };
  return conFixture(async (url, fixture_hash) => {
    if (fixture_hash !== base.fixture_hash) return { status: 'UNVERIFIED', reason_code: 'FIXTURE_DISTINTO' };
    const r = await capturarVistas(url, { superficie, outDir: path.join(REPO, '_output', superficie + '-actual') });
    const d = comparar(base.vistas, r.vistas);
    const rotas = Object.entries(d).filter(([, x]) => x.cambios.length || x.desaparecidos.length).map(([k]) => k);
    return { status: r.errores.length || rotas.length ? 'FAIL' : 'PASS', superficie, baseline_id: base.baseline_id, rotas, diferencias: d, errores: r.errores, browser_version: r.browser_version };
  }, superficie);
}

module.exports = { capturarVistas, comparar, capturar, compararActual, leerBase, VISTAS, VISTAS_GRAPH_UI, SUPERFICIES, BASE_DIR };

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  const opt = Object.fromEntries(rest.map((a) => /^--([^=]+)(?:=(.*))?$/.exec(a)).filter(Boolean).map((m) => [m[1], m[2] ?? true]));
  const superficie = opt.superficie || 'dashboard';
  if (!SUPERFICIES[superficie]) { console.error('superficie desconocida: ' + superficie); process.exit(2); }
  const run = cmd === 'capturar' ? capturar({ motivo: opt.motivo, cambioIntencional: !!opt['cambio-intencional'], superficie }) : compararActual({ superficie });
  run.then((r) => { console.log(JSON.stringify(r, null, 2)); if (r.ok === false || r.status === 'FAIL') process.exitCode = 1; })
    .catch((e) => { console.error(e.stack || e); process.exitCode = 2; });
}
