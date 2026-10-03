'use strict';
// D26 — Segundo grafo (graph-server.cjs + graph-export.cjs + graph-ui):
// rutas confinadas a graph-ui, solo loopback, sin CORS abierto, puerto e
// iframe de la instancia real, base leída sin escribir y recortes declarados.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const REPO = path.join(__dirname, '..');
const gs = require(path.join(REPO, '.agentic', 'grafo', 'graph-server.cjs'));
const { exportGraph, LIMITES } = require(path.join(REPO, '.agentic', 'grafo', 'graph-export.cjs'));
const fx = require('./fixtures/dashboard-fixture.cjs');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function pedir(port, opts = {}) {
  return new Promise((res, rej) => {
    const r = http.request(Object.assign({ host: '127.0.0.1', port, path: '/', method: 'GET' }, opts), (x) => {
      let b = ''; x.on('data', (d) => { b += d; }); x.on('end', () => res({ status: x.statusCode, h: x.headers, b }));
    });
    r.on('error', rej); r.end();
  });
}

function uiConSecreto() {
  const raiz = tmp('akdd-gui-');
  const ui = path.join(raiz, 'graph-ui');
  fs.mkdirSync(ui);
  fs.writeFileSync(path.join(ui, 'index.html'), '<html>ok</html>');
  fs.mkdirSync(path.join(raiz, 'fuera'));
  fs.writeFileSync(path.join(raiz, 'fuera', 'secreto.txt'), 'SECRETO-NO-DEBE-SALIR');
  fs.writeFileSync(path.join(raiz, 'secreto.txt'), 'SECRETO-NO-DEBE-SALIR');
  return { raiz, ui };
}

test('D26: resolverRuta niega traversal POSIX, Windows, codificado, absoluto y NUL', () => {
  const { ui } = uiConSecreto();
  const casos = [
    ['/../secreto.txt', 403], ['/a/../../secreto.txt', 403], ['/%2e%2e/secreto.txt', 403], ['/%2E%2E%2Fsecreto.txt', 403],
    ['/%252e%252e/secreto.txt', 400], ['/..%5csecreto.txt', 400], ['/..\\secreto.txt', 400], ['//etc/passwd', 400],
    ['/C:/Windows/win.ini', 400], ['/c:%5cWindows%5cwin.ini', 400], ['/index.html%00.txt', 400], ['/%E0%A4%A', 400],
    ['/./index.html', 403], ['/no-existe.html', 404],
  ];
  for (const [url, esperado] of casos) assert.strictEqual(gs.resolverRuta(url, ui).status, esperado, url);
  const ok = gs.resolverRuta('/', ui);
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(path.basename(ok.archivo), 'index.html');
});

test('D26: un enlace dentro de graph-ui que apunta afuera se niega', (t) => {
  const { raiz, ui } = uiConSecreto();
  try { fs.symlinkSync(path.join(raiz, 'fuera'), path.join(ui, 'enlace'), 'junction'); } catch (e) { return t.skip('el sistema no permite crear el enlace: ' + e.code); }
  const r = gs.resolverRuta('/enlace/secreto.txt', ui);
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.reason_code, 'ENLACE_FUERA');
});

test('D26: el servidor solo responde a loopback, GET/HEAD, sin CORS abierto y nunca entrega contenido externo', async () => {
  const { ui } = uiConSecreto();
  const dir = tmp('akdd-gsrv-');
  fx.crearFixture(dir);
  const server = gs.crearServidor({ root: dir, uiDir: ui, env: {} });
  const port = await server.escuchar(0);
  try {
    const ok = await pedir(port);
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.h['access-control-allow-origin'], undefined);
    assert.strictEqual(ok.h['x-content-type-options'], 'nosniff');
    assert.match(ok.h['content-security-policy'], /frame-ancestors 'none'/);
    for (const p of ['/../secreto.txt', '/%2e%2e/secreto.txt', '/%2e%2e%2ffuera%2fsecreto.txt', '/..%5csecreto.txt', '/%252e%252e/secreto.txt']) {
      const r = await pedir(port, { path: p });
      assert.ok(r.status === 400 || r.status === 403, p + ' → ' + r.status);
      assert.ok(!r.b.includes('SECRETO'), p + ' filtró contenido externo');
    }
    assert.strictEqual((await pedir(port, { headers: { Host: 'atacante.example:' + port } })).status, 403);
    assert.strictEqual((await pedir(port, { headers: { Origin: 'http://atacante.example' } })).status, 403);
    assert.strictEqual((await pedir(port, { headers: { Origin: 'http://localhost:' + port } })).status, 200);
    assert.strictEqual((await pedir(port, { method: 'POST', path: '/api/graph.json' })).status, 405);
    const head = await pedir(port, { method: 'HEAD' });
    assert.strictEqual(head.status, 200);
    assert.strictEqual(head.b, '');
  } finally { server.close(); }
});

test('D26: graph.json declara cobertura, límites y secciones sin dato, y no escribe la base', async () => {
  const dir = tmp('akdd-gexp-');
  fx.crearFixture(dir);
  const db = path.join(dir, '.agentic', 'memoria.db');
  const antes = hash(db);
  const server = gs.crearServidor({ root: dir, env: {} });
  const port = await server.escuchar(0);
  try {
    const r = JSON.parse((await pedir(port, { path: '/api/graph.json' })).b);
    assert.strictEqual(r.schema_version, 1);
    assert.strictEqual(r.status, 'PARCIAL');
    assert.deepStrictEqual(r.limits, LIMITES);
    assert.deepStrictEqual(r.coverage.nodos, { total: 6, shown: 6, excluded: { obsoletos: 0 }, truncated: false, limit: 600 });
    assert.strictEqual(r.coverage.ciclos.total, 2);
    assert.ok(r.errors.some((e) => e.seccion === 'contratos' && e.reason_code === 'TABLA_AUSENTE'), 'una tabla ausente queda como sin dato, no como cero');
    assert.strictEqual(r.coverage.contratos, undefined);
  } finally { server.close(); }
  assert.strictEqual(hash(db), antes, 'la exportación escribió memoria.db');
  assert.ok(!fs.existsSync(db + '-wal') && !fs.existsSync(db + '-journal'), 'quedó un archivo de escritura junto a la base');
});

test('D26: el recorte a 600 nodos se declara (total, mostrados, truncated)', () => {
  const dir = tmp('akdd-gcut-');
  fs.mkdirSync(path.join(dir, '.agentic'));
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(path.join(dir, '.agentic', 'memoria.db'));
  d.exec("CREATE TABLE nodos (id INTEGER PRIMARY KEY, titulo TEXT, tipo TEXT, area TEXT, confianza TEXT, estado TEXT, aplicado INTEGER, util INTEGER, accesos_total INTEGER, decay_score REAL)");
  const ins = d.prepare("INSERT INTO nodos (titulo, tipo, estado, accesos_total) VALUES (?, 'patron', ?, ?)");
  for (let i = 0; i < 612; i++) ins.run('n' + i, i < 5 ? 'OBSOLETO' : 'ACTIVO', i);
  d.close();
  const r = exportGraph(dir);
  assert.deepStrictEqual(r.coverage.nodos, { total: 612, shown: 600, excluded: { obsoletos: 5 }, truncated: true, limit: 600 });
  assert.strictEqual(r.nodes.length, 600);
});

test('D26: puerto ocupado → siguiente libre, y la instancia informa su URL real', async () => {
  const ocupa = http.createServer();
  await new Promise((r) => ocupa.listen(0, '127.0.0.1', r));
  const ocupado = ocupa.address().port;
  const dir = tmp('akdd-gport-');
  fx.crearFixture(dir);
  const server = gs.crearServidor({ root: dir, env: {} });
  try {
    const port = await server.escuchar(ocupado, 5);
    assert.notStrictEqual(port, ocupado);
    assert.ok(port > ocupado && port <= ocupado + 4, 'eligió ' + port);
    const i = JSON.parse((await pedir(port, { path: '/api/instance.json' })).b);
    assert.strictEqual(i.graph_url, 'http://localhost:' + port);
  } finally { server.close(); ocupa.close(); }
});

test('D26: la URL de Code Structure sale de la instancia real; sin respuesta queda sin conexión', async () => {
  const code = http.createServer((q, s) => s.end('code'));
  await new Promise((r) => code.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + code.address().port;
  try {
    assert.deepStrictEqual(await gs.instanciaCode({ AKDD_CODE_GRAPH_URL: url }), { url, estado: 'CONECTADO' });
    assert.deepStrictEqual(await gs.instanciaCode({ AKDD_CODE_GRAPH_URL: 'http://atacante.example:9749' }), { url: null, estado: 'URL_NO_PERMITIDA' });
  } finally { code.close(); }
  const libre = await fx.puertoLibre();
  const sin = await gs.instanciaCode({ AKDD_CODE_GRAPH_URL: 'http://127.0.0.1:' + libre });
  assert.strictEqual(sin.url, null);
  assert.strictEqual(sin.estado, 'SIN_CONEXION');
  const html = fs.readFileSync(path.join(gs.UI_DIR, 'index.html'), 'utf8');
  assert.ok(!/src="http:\/\/localhost:9749"/.test(html), 'el iframe sigue con el puerto fijo');
});

test('D26: los dos grafos muestran el mismo total de nodos de memoria', async () => {
  const dir = tmp('akdd-gtot-');
  fx.crearFixture(dir);
  const srv = await fx.arrancarDashboard(dir);
  try {
    const html = await (await fetch(srv.url)).text();
    const m = /const NODES = (\[[\s\S]*?\]);\n/.exec(html);
    assert.ok(m, 'no se encontró NODES en el dashboard');
    const nodosDashboard = JSON.parse(m[1]);
    const r = exportGraph(dir);
    assert.strictEqual(r.coverage.nodos.total, nodosDashboard.length);
    const estados = (xs) => xs.reduce((a, n) => { a[n.estado || ''] = (a[n.estado || ''] || 0) + 1; return a; }, {});
    assert.deepStrictEqual(estados(r.nodes.filter((n) => n.id.startsWith('n_'))), estados(nodosDashboard));
  } finally { srv.cerrar(); }
});
