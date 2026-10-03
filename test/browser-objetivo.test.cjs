'use strict';

/* H27 — el Browser Gate revisa el servidor declarado de ESTE proyecto, las
   rutas que tocó el cambio, y nunca da PASS sin identidad, sin navegador o
   con timeout. Servidores reales en puertos efímeros. */

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');

const RAIZ = path.join(__dirname, '..');
const dt = require('../.agentic/grafo/dev-target.cjs');
const bg = require('../.agentic/grafo/browser-gate.cjs');

const MARCA = 'agentix-project:clinica-h27';
const servidores = [];
function servir(handler) {
  return new Promise((res) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => { servidores.push(s); res(`http://127.0.0.1:${s.address().port}`); });
  });
}
after(() => { for (const s of servidores) s.close(); });

const html = (cuerpo, script = '') => `<!doctype html><html><head><meta name="agentix-project" content="${MARCA}"><title>x</title></head><body>${cuerpo}${script}</body></html>`;

function proyecto(cfg) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-h27-'));
  fs.mkdirSync(path.join(root, '.agentic'), { recursive: true });
  if (cfg) fs.writeFileSync(path.join(root, '.agentic', 'dev-server.json'), JSON.stringify(cfg));
  return root;
}

test('H27: una app ajena no reemplaza al proyecto declarado', async () => {
  const ajena = await servir((req, res) => res.end('<html><body>otra app</body></html>'));
  const propia = await servir((req, res) => res.end(html('compras')));
  const identidad = { tipo: 'marker', valor: MARCA };

  const bien = await dt.resolverObjetivo(proyecto({ url: propia, identidad }), ['src/pages/compras.tsx']);
  assert.strictEqual(bien.status, 'READY');
  assert.deepStrictEqual(bien.urls, [propia + '/compras']);

  const mal = await dt.resolverObjetivo(proyecto({ url: ajena, identidad }), ['src/pages/compras.tsx']);
  assert.strictEqual(mal.status, 'UNVERIFIED');
  assert.strictEqual(mal.reason_code, 'IDENTIDAD_NO_COINCIDE');

  const src = fs.readFileSync(path.join(RAIZ, '.agentic', 'grafo', 'post-cycle.cjs'), 'utf8');
  assert.doesNotMatch(src, /\[3000, 3001, 5173/, 'ya no se barren puertos habituales');
});

test('H27: sin URL, sin identidad o con timeout no hay PASS', async () => {
  const root = proyecto(null);
  const prev = process.env.AKDD_DEV_URL; delete process.env.AKDD_DEV_URL;
  try {
    assert.strictEqual((await dt.resolverObjetivo(root, ['index.html'])).reason_code, 'SIN_URL_DECLARADA');
  } finally { if (prev !== undefined) process.env.AKDD_DEV_URL = prev; }

  const propia = await servir((req, res) => res.end(html('x')));
  assert.strictEqual((await dt.resolverObjetivo(proyecto({ url: propia }), ['index.html'])).reason_code, 'SIN_IDENTIDAD');

  const colgado = await new Promise((res) => {
    const s = net.createServer(() => { /* acepta y nunca contesta */ });
    s.listen(0, '127.0.0.1', () => { servidores.push(s); res(`http://127.0.0.1:${s.address().port}`); });
  });
  const t = await dt.verificarIdentidad(colgado, { tipo: 'marker', valor: MARCA }, { timeoutMs: 300 });
  assert.strictEqual(t.ok, false);
  assert.strictEqual(t.reason_code, 'TIMEOUT');

  const cabecera = await servir((req, res) => { res.setHeader('x-agentix-project', 'clinica'); res.end('ok'); });
  assert.ok((await dt.verificarIdentidad(cabecera, { tipo: 'header', valor: 'clinica' })).ok);
  assert.strictEqual((await dt.verificarIdentidad(cabecera, { tipo: 'header', valor: 'otra' })).ok, false);
});

test('H27: rutas afectadas por convención y por mapa declarado', () => {
  assert.strictEqual(dt.rutaDe('src/pages/compras.tsx'), '/compras');
  assert.strictEqual(dt.rutaDe('pages/index.jsx'), '/');
  assert.strictEqual(dt.rutaDe('pages/_app.tsx'), null);
  assert.strictEqual(dt.rutaDe('app/(panel)/ventas/[id]/page.tsx'), '/ventas/:id');
  assert.strictEqual(dt.rutaDe('src/routes/inventario/+page.svelte'), '/inventario');
  assert.strictEqual(dt.rutaDe('src/views/compras/Lista.vue', { 'src/views/compras/': '/compras' }), '/compras');
  const r = dt.rutasAfectadas(['src/pages/a.tsx', 'src/pages/b.tsx', 'src/lib/util.ts', 'README.md'], {});
  assert.deepStrictEqual(r.rutas, ['/a', '/b']);
  assert.deepStrictEqual(r.sinRuta, ['src/lib/util.ts'], 'front sin ruta conocida queda listado');
});

test('H27: navegador real sobre la ruta afectada; error de consola = WARN, caída = UNVERIFIED', { timeout: 120000 }, async () => {
  const base = await servir((req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.url === '/compras') return res.end(html('<h1>compras</h1>'));
    if (req.url === '/favicon.ico') { res.statusCode = 204; return res.end(); }
    if (req.url === '/ventas') return res.end(html('<h1>ventas</h1>', '<script>console.error("boom ventas")</script>'));
    res.statusCode = 404; res.end('no');
  });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-h27-out-'));
  const ok = await bg.runBrowserGate(base + '/compras', { outDir: out, projectRoot: out });
  if (ok.status === 'UNVERIFIED' && ok.reason_code === 'SIN_NAVEGADOR') {
    assert.strictEqual(ok.passed, false, 'sin navegador nunca PASS');
    return;
  }
  assert.strictEqual(ok.status, 'PASS', ok.message);
  const warn = await bg.runBrowserGate(base + '/ventas', { outDir: out, projectRoot: out });
  assert.strictEqual(warn.status, 'WARN');
  assert.ok(warn.findings.some((f) => /boom ventas/.test(f.detalle)));
  const caido = await bg.runBrowserGate('http://127.0.0.1:1/', { outDir: out, projectRoot: out });
  assert.strictEqual(caido.status, 'UNVERIFIED');
  assert.strictEqual(caido.passed, false);
});
