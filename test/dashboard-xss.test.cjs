'use strict';
// D25 — Ningún dato de la memoria se ejecuta ni rompe el DOM del dashboard.
// E2E en navegador real sobre un fixture con cargas en cada fuente: el efecto
// (window.__akddXss) tiene que estar ausente; probar escHtml aislado no basta.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fx = require('./fixtures/dashboard-fixture.cjs');

function hayNavegador() {
  try { require.resolve('playwright-core', { paths: [fx.REPO] }); return true; } catch { return false; }
}

async function recorrer(page) {
  return page.evaluate(async () => {
    const espera = (ms) => new Promise((r) => setTimeout(r, ms));
    const pasos = [];
    const ejecutadas = [];
    const anotar = (nombre) => { if (window.__akddXss !== undefined) { ejecutadas.push(nombre + ' → ' + window.__akddXss); delete window.__akddXss; } };
    anotar('carga inicial');
    const paso = async (nombre, fn) => { try { await fn(); pasos.push(nombre); } catch (e) { pasos.push(nombre + ' ERROR ' + e.message); } await espera(60); anotar(nombre); };
    const sonda = document.createElement('div');
    document.body.appendChild(sonda);
    // La librería del grafo pinta nodeLabel/linkLabel como HTML en su tooltip.
    const etiquetas = (g) => {
      const d = g.graphData();
      for (const [acc, lista] of [[g.nodeLabel(), d.nodes], [g.linkLabel ? g.linkLabel() : null, d.links]]) {
        if (!acc) continue;
        for (const x of lista) { const v = typeof acc === 'function' ? acc(x) : x[acc]; sonda.innerHTML = v == null ? '' : String(v); }
      }
    };
    const clicNodos = (g) => { const click = g.onNodeClick(); for (const n of g.graphData().nodes) click(n, new MouseEvent('click')); };

    await paso('lista kdd', async () => { for (const el of document.querySelectorAll('.node-item, [data-node-id]')) { el.click(); await espera(20); } });
    await paso('detalle + no entiendo kdd', async () => { for (const n of NODES) { selectNode(n.id); const b = document.querySelector('#detail-panel .dp-help-btn, .dp-help-btn'); if (b) b.click(); await espera(20); } });
    await paso('etiquetas kdd', async () => etiquetas(active3DGraphs.gc));
    await paso('busqueda', async () => { const s = document.querySelector('input[type=search], #search, input[placeholder*="earch"]'); if (s) { s.value = '<img src=x onerror="window.__akddXss=9">'; s.dispatchEvent(new Event('input', { bubbles: true })); } });
    for (const [tab, id] of [[2, 'code-gc'], [3, 'combined-gc']]) {
      await paso('modo grafo ' + id, async () => { document.querySelector('.gst:nth-child(' + tab + ')').click(); await espera(600); });
      await paso('clic nodos ' + id, async () => { if (active3DGraphs[id]) clicNodos(active3DGraphs[id]); for (const b of document.querySelectorAll('.dp-help-btn')) b.click(); });
      await paso('etiquetas ' + id, async () => { if (active3DGraphs[id]) etiquetas(active3DGraphs[id]); });
    }
    await paso('tour', async () => { const b = document.getElementById('tour-btn'); if (b) b.click(); if (typeof tourStep === 'function') for (let i = 0; i < 6; i++) tourStep(1); });
    // Chips de módulo y relaciones del detalle: handlers inline con datos.
    await paso('chips y relaciones', async () => { for (const el of document.querySelectorAll('.code-mod-chip, .rel-item')) el.click(); });
    for (const n of [2, 3, 4]) await paso('pestaña ' + n, async () => { document.querySelector('.mode-tab:nth-child(' + n + ')').click(); await espera(300); for (const b of document.querySelectorAll('.sb-tab, .fpill, .docs-nav-item, [onclick^="selectModule"]')) { if (b.offsetParent) b.click(); } });
    await paso('hover y mouseover', async () => { for (const el of document.querySelectorAll('svg g, [onmouseover], .mb, .ab')) { for (const t of ['mouseover', 'mouseenter', 'mousemove']) el.dispatchEvent(new MouseEvent(t, { bubbles: true, clientX: 5, clientY: 5 })); } });
    await paso('vuelta', async () => document.querySelector('.mode-tab:nth-child(1)').click());
    sonda.remove();
    await espera(400);
    anotar('final');
    return {
      pasos,
      ejecutadas,
      handlersInyectados: [...document.querySelectorAll('[onload],[onerror]')].map((e) => e.outerHTML.slice(0, 120)),
      javascriptUrls: [...document.querySelectorAll('[href^="javascript:" i],[src^="javascript:" i]')].length,
      pestañas: document.querySelectorAll('.mode-tab').length,
      grafos: document.querySelectorAll('.gst').length,
    };
  });
}

test('D25: las cargas de la memoria no se ejecutan ni rompen el DOM en ninguna vista', { timeout: 180000, skip: hayNavegador() ? false : 'sin playwright-core' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-xss-'));
  fx.crearFixture(dir, { payload: true });
  const srv = await fx.arrancarDashboard(dir);
  const bg = require(path.join(fx.REPO, '.agentic', 'grafo', 'browser-gate.cjs'));
  const browser = await bg.launchBrowser('system');
  const errores = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', (e) => errores.push(String(e.message || e).slice(0, 200)));
    page.on('dialog', (d) => { errores.push('dialogo: ' + d.message()); d.dismiss().catch(() => {}); });
    page.on('console', (m) => { if (/Content Security Policy|Refused to (load|execute|apply|connect)/i.test(m.text())) errores.push('CSP: ' + m.text().slice(0, 200)); });
    await page.goto(srv.url, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => typeof ForceGraph3D === 'function' && typeof active3DGraphs !== 'undefined' && active3DGraphs.gc, null, { timeout: 30000 });
    const r = await recorrer(page);
    const fallidos = r.pasos.filter((p) => / ERROR /.test(p));
    assert.deepStrictEqual(fallidos, [], 'pasos del recorrido que fallaron');
    assert.deepStrictEqual(r.ejecutadas, [], 'cargas ejecutadas (paso → payload)');
    assert.deepStrictEqual(r.handlersInyectados, []);
    assert.strictEqual(r.javascriptUrls, 0);
    assert.strictEqual(r.pestañas, 7, '4 pestañas de grafos y documentación + Memoria, Contexto y Actualización');
    assert.strictEqual(r.grafos, 3);
    assert.deepStrictEqual(errores, [], 'errores de página');
  } finally {
    await browser.close().catch(() => {});
    srv.cerrar();
  }
});

test('D25/D26: el segundo grafo (graph-ui) tampoco ejecuta cargas de la memoria', { timeout: 120000, skip: hayNavegador() ? false : 'sin playwright-core' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-xss2-'));
  fx.crearFixture(dir, { payload: true });
  const { crearServidor } = require(path.join(fx.REPO, '.agentic', 'grafo', 'graph-server.cjs'));
  const server = crearServidor({ root: dir, env: { AKDD_CODE_GRAPH_URL: 'http://127.0.0.1:' + await fx.puertoLibre() } });
  const port = await server.escuchar(0);
  const bg = require(path.join(fx.REPO, '.agentic', 'grafo', 'browser-gate.cjs'));
  const browser = await bg.launchBrowser('system');
  const errores = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => errores.push(String(e.message || e).slice(0, 200)));
    page.on('console', (m) => { if (/Content Security Policy|Refused to (load|execute|apply|connect)/i.test(m.text())) errores.push('CSP: ' + m.text().slice(0, 200)); });
    await page.goto(`http://localhost:${port}/`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => typeof kddG !== 'undefined' && kddG, null, { timeout: 30000 });
    const r = await page.evaluate(async () => {
      const espera = (ms) => new Promise((x) => setTimeout(x, ms));
      const ejecutadas = [];
      const anotar = (n) => { if (window.__akddXss !== undefined) { ejecutadas.push(n + ' → ' + window.__akddXss); delete window.__akddXss; } };
      anotar('carga inicial');
      const hover = kddG.onNodeHover();
      for (const n of allData.nodes) { showDetail(n); hover(n); await espera(10); }
      anotar('detalle y tooltip');
      showTab('combined'); await espera(300); showTab('code'); await espera(300);
      anotar('pestañas');
      const frame = document.querySelector('#tab-code iframe');
      return { ejecutadas, iframeSrc: frame.getAttribute('src'), iframeTexto: frame.srcdoc };
    });
    assert.deepStrictEqual(r.ejecutadas, []);
    assert.strictEqual(r.iframeSrc, null, 'sin instancia de Code Structure no se apunta a un puerto inventado');
    assert.match(r.iframeTexto, /sin conexión/);
    assert.deepStrictEqual(errores, []);
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }
});

test('D25: el servidor solo entrega la página a loopback, por GET/HEAD y con CSP', { timeout: 60000 }, async () => {
  const http = require('http');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-hdr-'));
  fx.crearFixture(dir);
  const srv = await fx.arrancarDashboard(dir);
  const { port } = new URL(srv.url);
  const pedir = (opts) => new Promise((res, rej) => {
    const r = http.request(Object.assign({ host: '127.0.0.1', port, path: '/', method: 'GET' }, opts), (x) => { let b = ''; x.on('data', (d) => { b += d; }); x.on('end', () => res({ status: x.statusCode, h: x.headers, b })); });
    r.on('error', rej); r.end();
  });
  try {
    const ok = await pedir({});
    assert.strictEqual(ok.status, 200);
    assert.match(ok.h['content-security-policy'], /object-src 'none'/);
    assert.match(ok.h['content-security-policy'], /frame-ancestors 'none'/);
    assert.match(ok.h['content-security-policy'], /connect-src 'self'/);
    assert.strictEqual(ok.h['x-content-type-options'], 'nosniff');
    assert.strictEqual((await pedir({ headers: { Host: 'localhost:' + port } })).status, 200);
    assert.strictEqual((await pedir({ headers: { Host: 'atacante.example:' + port } })).status, 403);
    assert.strictEqual((await pedir({ headers: { Host: '127.0.0.1:1' } })).status, 403);
    assert.strictEqual((await pedir({ method: 'POST' })).status, 405);
    assert.strictEqual((await pedir({ method: 'DELETE' })).status, 405);
    const head = await pedir({ method: 'HEAD' });
    assert.strictEqual(head.status, 200);
    assert.strictEqual(head.b, '');
    assert.strictEqual((await pedir({ path: '/../../etc/passwd' })).status, 404);
    assert.strictEqual((await pedir({ path: '/?x=1' })).status, 200);
  } finally {
    srv.cerrar();
  }
});
