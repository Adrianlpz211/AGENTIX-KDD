'use strict';

/* D07 + 04 — /api/v1/* de solo lectura con sobre versionado, ETag, filtros
   validados y SSE con cursor. Cambiar la base con el tablero abierto
   actualiza las tarjetas sin recargar ni mover la cámara. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { crearFixture, arrancarDashboard, REPO } = require('./fixtures/dashboard-fixture.cjs');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-api-' + p + '-'));
const dbDe = (dir) => path.join(dir, '.agentic', 'memoria.db');
const bytes = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function agregarCiclo(dir, id, estado) {
  // Con la base en uso por el tablero (que la sondea) y la suite en paralelo, sin espera la escritura recibía «database is locked» al instante.
  const db = new DatabaseSync(dbDe(dir), { timeout: 15000 });
  db.prepare("INSERT INTO ciclos (ciclo_id, tarea, modulo, estado, tests_generados, tests_pasando, stops_count, fecha_inicio, fecha_fin) VALUES (?, ?, 'pagos', ?, 4, 4, 0, '2026-09-10T09:00:00Z', '2026-09-10T10:00:00Z')").run(id, 'Tarea ' + id, estado);
  db.close();
}
async function json(url, init) { const r = await fetch(url, init); return { status: r.status, etag: r.headers.get('etag'), body: r.status === 304 ? null : await r.json() }; }

/** Abre el SSE y junta eventos { id, tipo, data }. */
function sse(url, headers) {
  const eventos = [];
  let req;
  const listo = new Promise((res, rej) => {
    req = http.get(url, { headers: Object.assign({ Accept: 'text/event-stream' }, headers) }, (r) => {
      let buf = '';
      r.setEncoding('utf8');
      r.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const bloque = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = {};
          for (const l of bloque.split('\n')) { const m = /^(id|event|data): (.*)$/.exec(l); if (m) ev[m[1]] = m[2]; }
          if (ev.event) eventos.push({ id: Number(ev.id), tipo: ev.event, data: JSON.parse(ev.data) });
        }
      });
      res(r);
    });
    req.on('error', rej);
  });
  return { eventos, listo, cerrar: () => req.destroy() };
}
async function hasta(cond, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (cond()) return true; await esperar(50); } return false; }

test('04: /api/v1/summary devuelve el sobre versionado y los mismos números que el tablero y la CLI', async () => {
  const dir = tmp('sum'); crearFixture(dir);
  const d = await arrancarDashboard(dir);
  try {
    const { status, body, etag } = await json(d.url + 'api/v1/summary');
    assert.strictEqual(status, 200);
    for (const k of ['schema_version', 'status', 'project_id', 'snapshot_revision', 'generated_at', 'source', 'window', 'coverage', 'data', 'errors']) assert.ok(k in body, 'falta ' + k);
    assert.strictEqual(body.schema_version, 1);
    assert.strictEqual(body.project_id, path.basename(dir));
    assert.ok(etag);
    const html = await (await fetch(d.url)).text();
    const goal = html.match(/data-kpi="goal"[^>]*>([^<]*)</)[1];
    assert.strictEqual(body.data.metricas.goal_attainment + '%', goal);
    const metrics = require(path.join(REPO, '.agentic', 'grafo', 'metrics.cjs'));
    const db = new DatabaseSync(dbDe(dir), { readOnly: true });
    const m = metrics.computeCycleMetrics(db); db.close();
    assert.strictEqual(m.success_rate, body.data.metricas.goal_attainment);
    assert.strictEqual(m.stops_unicos, body.data.metricas.stops);
    assert.strictEqual(m.test_pass_rate, body.data.metricas.test_rate);
    assert.deepStrictEqual(body.data.contratos, null, 'sin tabla de contratos: null, no ceros');
    assert.ok(body.errors.some((e) => e.source === 'verified_contracts'));
    assert.ok(html.includes(JSON.stringify(body.snapshot_revision)), 'la página nace con la misma revisión');
  } finally { d.cerrar(); }
});

test('04: ETag por revisión — misma revisión 304, base cambiada 200 con revisión nueva', async () => {
  const dir = tmp('etag'); crearFixture(dir);
  const d = await arrancarDashboard(dir);
  try {
    const a = await json(d.url + 'api/v1/summary');
    const b = await json(d.url + 'api/v1/summary', { headers: { 'If-None-Match': a.etag } });
    assert.strictEqual(b.status, 304);
    const f = await json(d.url + 'api/v1/tasks?limit=1');
    assert.notStrictEqual(f.etag, a.etag, 'el ETag también depende de la ruta y el filtro');
    agregarCiclo(dir, 'nuevo', 'COMPLETADO_VERIFICADO');
    const c = await json(d.url + 'api/v1/summary', { headers: { 'If-None-Match': a.etag } });
    assert.strictEqual(c.status, 200);
    assert.notStrictEqual(c.body.snapshot_revision, a.body.snapshot_revision);
    assert.strictEqual(c.body.data.metricas.total, 4);
  } finally { d.cerrar(); }
});

test('04: parámetros validados, paginación declarada y protecciones de origen', async () => {
  const dir = tmp('val'); crearFixture(dir);
  const db = new DatabaseSync(dbDe(dir));
  db.exec('DELETE FROM ciclos');
  for (let i = 0; i < 100; i++) db.prepare("INSERT INTO ciclos (ciclo_id, tarea, estado, fecha_inicio) VALUES (?, 't', 'COMPLETADO', ?)").run('k' + i, new Date(Date.UTC(2026, 6, 1) + i * 864e5).toISOString());
  db.close();
  const d = await arrancarDashboard(dir);
  try {
    const casos = [
      ['api/v1/summary?x=1', 400, 'PARAMETRO_DESCONOCIDO'], ['api/v1/tasks?limit=500', 400, 'LIMIT_INVALIDO'],
      ['api/v1/tasks?limit=0', 400, 'LIMIT_INVALIDO'], ['api/v1/tasks?cursor=-1', 400, 'CURSOR_INVALIDO'],
      ['api/v1/tasks?from=ayer', 400, 'FECHA_INVALIDA'], ['api/v1/tasks?from=2026-09-01&to=2026-08-01', 400, 'VENTANA_INVALIDA'],
      ['api/v1/tasks?project_id=otro', 404, 'PROYECTO_DESCONOCIDO'], ['api/v1/nada', 404, 'RUTA_DESCONOCIDA'],
      ['api/v1/tasks?limit=1&limit=2', 400, 'PARAMETRO_REPETIDO'],
    ];
    for (const [ruta, st, code] of casos) {
      const r = await json(d.url + ruta);
      assert.strictEqual(r.status, st, ruta);
      assert.strictEqual(r.body.errors[0].code, code, ruta);
      assert.strictEqual(r.body.data, null, ruta);
    }
    const p1 = await json(d.url + 'api/v1/tasks?limit=30');
    assert.deepStrictEqual(p1.body.coverage, { total: 100, shown: 30, truncated: true, offset: 0, next_cursor: 30 });
    assert.strictEqual(p1.body.data[0].ciclo_id, 'k99', 'más reciente primero');
    const p4 = await json(d.url + 'api/v1/tasks?limit=30&cursor=90');
    assert.deepStrictEqual(p4.body.coverage, { total: 100, shown: 10, truncated: true, offset: 90, next_cursor: null });
    const w = await json(d.url + 'api/v1/tasks?from=2026-07-01T00:00:00Z&to=2026-07-10T23:59:59Z');
    assert.strictEqual(w.body.coverage.total, 10);
    assert.deepStrictEqual(w.body.window, { from: '2026-07-01T00:00:00.000Z', to: '2026-07-10T23:59:59.000Z' });
    const plan = await json(d.url + 'api/v1/tasks?plan_id=p1');
    assert.strictEqual(plan.body.status, 'UNAVAILABLE');
    assert.strictEqual(plan.body.reason_code, 'PLAN_SIN_FUENTE');
    const origen = await json(d.url + 'api/v1/summary', { headers: { Origin: 'https://malo.example' } });
    assert.strictEqual(origen.status, 403);
    const post = await fetch(d.url + 'api/v1/summary', { method: 'POST', body: '{}' });
    assert.strictEqual(post.status, 405);
    assert.strictEqual(post.headers.get('access-control-allow-origin'), null);
  } finally { d.cerrar(); }
});

test('D07: SSE avisa el cambio con id, Last-Event-ID repone lo perdido y un cursor viejo pide snapshot', async () => {
  const dir = tmp('sse'); crearFixture(dir);
  const d = await arrancarDashboard(dir, { AKDD_DASH_POLL_MS: '100' });
  const u = d.url + 'api/v1/events';
  try {
    const a = sse(u); await a.listo;
    assert.ok(await hasta(() => a.eventos.length >= 1), 'no llegó la revisión inicial');
    const inicial = a.eventos[0];
    assert.strictEqual(inicial.tipo, 'revision');
    const t0 = Date.now();
    agregarCiclo(dir, 'sse1', 'COMPLETADO');
    assert.ok(await hasta(() => a.eventos.length >= 2), 'el cambio no llegó por SSE');
    const latencia = Date.now() - t0;
    const cambio = a.eventos[1];
    assert.strictEqual(cambio.id, inicial.id + 1);
    assert.notStrictEqual(cambio.data.snapshot_revision, inicial.data.snapshot_revision);
    const sum = await json(d.url + 'api/v1/summary');
    assert.strictEqual(sum.body.snapshot_revision, cambio.data.snapshot_revision, 'SSE y summary hablan de la misma revisión');
    await esperar(600);
    assert.strictEqual(a.eventos.length, 2, 'sin cambios no hay eventos nuevos (señales coalescidas)');
    a.cerrar();

    const b = sse(u, { 'Last-Event-ID': String(inicial.id) }); await b.listo;
    assert.ok(await hasta(() => b.eventos.length >= 1));
    await esperar(300);
    assert.deepStrictEqual(b.eventos.map((e) => e.id), [cambio.id], 'repone solo lo posterior al cursor, sin duplicar');
    b.cerrar();

    const c = sse(u, { 'Last-Event-ID': '999' }); await c.listo;
    assert.ok(await hasta(() => c.eventos.length >= 1));
    assert.strictEqual(c.eventos[0].tipo, 'snapshot');
    assert.strictEqual(c.eventos[0].data.motivo, 'CURSOR_EXPIRADO');
    c.cerrar();
    assert.ok(latencia < 3000, 'latencia ' + latencia + ' ms');
  } finally { d.cerrar(); }
});

test('04: el SSE tiene tope de clientes', async () => {
  const dir = tmp('tope'); crearFixture(dir);
  const d = await arrancarDashboard(dir, { AKDD_DASH_MAX_SSE: '2' });
  const abiertos = [];
  try {
    for (let i = 0; i < 2; i++) { const s = sse(d.url + 'api/v1/events'); abiertos.push(s); await s.listo; }
    const r = await fetch(d.url + 'api/v1/events', { headers: { Accept: 'text/event-stream' } });
    assert.strictEqual(r.status, 503);
    assert.strictEqual((await r.json()).reason_code, 'DEMASIADOS_CLIENTES');
  } finally { abiertos.forEach((s) => s.cerrar()); d.cerrar(); }
});

test('04/D07: observar y sondear sin cambios no escribe la base ni emite eventos', async () => {
  const dir = tmp('quieto'); crearFixture(dir);
  const antes = bytes(dbDe(dir));
  const d = await arrancarDashboard(dir, { AKDD_DASH_POLL_MS: '50' });
  try {
    const s = sse(d.url + 'api/v1/events'); await s.listo;
    let etag = null;
    for (let i = 0; i < 40; i++) { const r = await json(d.url + 'api/v1/summary', { headers: etag ? { 'If-None-Match': etag } : {} }); etag = r.etag || etag; await esperar(50); }
    assert.strictEqual(s.eventos.length, 1, 'solo la revisión inicial');
    s.cerrar();
    assert.strictEqual(bytes(dbDe(dir)), antes, 'la base cambió');
    assert.ok(!fs.existsSync(dbDe(dir) + '-wal') && !fs.existsSync(dbDe(dir) + '-journal'));
  } finally { d.cerrar(); }
});

test('D07: en el navegador la tarjeta cambia sin recargar ni mover la cámara; sin SSE el sondeo responde y al volver no duplica', { timeout: 120000 }, async (t) => {
  const bg = require(path.join(REPO, '.agentic', 'grafo', 'browser-gate.cjs'));
  let browser;
  try { browser = await bg.launchBrowser('system'); } catch (e) { t.skip('sin navegador: ' + e.message); return; }
  const dir = tmp('nav'); crearFixture(dir);
  const d = await arrancarDashboard(dir, { AKDD_DASH_POLL_MS: '100', AKDD_DASH_CLIENT_POLL_MS: '400' });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    const errores = []; page.on('pageerror', (e) => errores.push(String(e.message || e)));
    const ajenas = []; page.on('request', (r) => { const u = new URL(r.url()); if (!/^(127\.0\.0\.1|localhost)$/.test(u.hostname)) ajenas.push(r.url()); });
    await page.goto(d.url, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof ForceGraph3D === 'function' && document.querySelector('.dot').getAttribute('data-conexion') === 'vivo', null, { timeout: 30000 });
    await page.waitForTimeout(1500);
    // El giro automático por inactividad es del diseño y no depende del
    // refresco: se congela para que lo único que pueda mover la cámara sea
    // la actualización. Se guarda el objeto del grafo para ver que no se recrea.
    await page.evaluate(() => { const g = Object.values(active3DGraphs || {})[0]; g.__idleState.active = false; window.__g0 = g; });
    const camara = () => page.evaluate(() => { const g = Object.values(active3DGraphs || {})[0]; if (!g || g !== window.__g0) return 'grafo recreado'; const p = g.camera().position; return [p.x, p.y, p.z].map((v) => Math.round(v * 1000) / 1000); });
    // El auto-encuadre ajusta la cámara mientras el layout se asienta: medir desde que está quieta.
    let cam0 = await camara();
    for (let i = 0, quietas = 0; i < 60 && quietas < 3; i++) {
      await page.waitForTimeout(500);
      const c = await camara();
      quietas = JSON.stringify(c) === JSON.stringify(cam0) ? quietas + 1 : 0;
      cam0 = c;
    }
    const goal0 = await page.textContent('[data-kpi="goal"]');
    const navs = await page.evaluate(() => performance.getEntriesByType('navigation').length);

    const t0 = Date.now();
    agregarCiclo(dir, 'vivo1', 'COMPLETADO_VERIFICADO');
    await page.waitForFunction((g) => document.querySelector('[data-kpi="goal"]').textContent !== g, goal0, { timeout: 10000 });
    const latencia = Date.now() - t0;
    assert.strictEqual(await page.textContent('[data-kpi="goal"]'), '50%', '2 cerrados de 4');
    assert.match(await page.getAttribute('[data-kpi="goal"]', 'title'), /Cerrados íntegros 2 de 4 \(verificados 1/);
    assert.deepStrictEqual(await camara(), cam0, 'la cámara se movió');
    assert.strictEqual(await page.evaluate(() => performance.getEntriesByType('navigation').length), navs, 'la página se recargó');
    assert.match(await page.getAttribute('.dot', 'title'), /Actualizado .* · en vivo/);
    const refrescos1 = await page.evaluate(() => window.__akddRefrescos);
    assert.strictEqual(refrescos1, 1);

    // Sin SSE: el sondeo con ETag toma el relevo.
    assert.deepStrictEqual(errores, []);

    // Sin SSE desde el principio: el sondeo con ETag toma el relevo.
    const p2 = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    p2.on('pageerror', (e) => errores.push(String(e.message || e)));
    await p2.route('**/api/v1/events', (r) => r.abort());
    await p2.goto(d.url, { waitUntil: 'load' });
    await p2.waitForFunction(() => document.querySelector('.dot').getAttribute('data-conexion') === 'sondeo', null, { timeout: 30000 });
    await p2.waitForFunction(() => document.querySelector('[data-kpi="goal"]').textContent === '50%', null, { timeout: 5000 })
      .catch(() => assert.fail('la página nueva no trajo lo último: el HTML es del arranque'));
    const r0 = await p2.evaluate(() => window.__akddRefrescos || 0);
    agregarCiclo(dir, 'vivo2', 'COMPLETADO_VERIFICADO');
    await p2.waitForFunction(() => document.querySelector('[data-kpi="goal"]').textContent === '60%', null, { timeout: 10000 });
    // Al menos UN refresco por el sondeo (el 60% ya lo prueba). No se exige un número exacto: con la máquina cargada un sondeo
    // extra legítimo suma otro, y lo que importa es que el sondeo tome el relevo, no cuántas veces llegó a preguntar.
    assert.ok((await p2.evaluate(() => window.__akddRefrescos)) >= r0 + 1, 'el sondeo refrescó la tarjeta');
    assert.match(await p2.getAttribute('.dot', 'title'), /sondeo periódico/);

    // Vuelve el SSE: no se repite el refresco ya aplicado.
    const rSondeo = await p2.evaluate(() => window.__akddRefrescos); // refrescos aplicados por el sondeo hasta aquí
    await p2.unroute('**/api/v1/events');
    await p2.waitForFunction(() => document.querySelector('.dot').getAttribute('data-conexion') === 'vivo', null, { timeout: 30000 });
    await p2.waitForTimeout(1500);
    assert.strictEqual(await p2.evaluate(() => window.__akddRefrescos), rSondeo, 'al volver el SSE se repitió un refresco ya aplicado');
    // La primera página, con SSE, también recibió el segundo cambio una sola vez.
    await page.waitForFunction(() => document.querySelector('[data-kpi="goal"]').textContent === '60%', null, { timeout: 10000 });
    assert.strictEqual(await page.evaluate(() => window.__akddRefrescos), 2);
    assert.deepStrictEqual(await camara(), cam0);
    assert.deepStrictEqual(errores, []);
    assert.deepStrictEqual(ajenas, [], 'pidió algo fuera del tablero');
    t.diagnostic('latencia navegador ' + latencia + ' ms');
  } finally { d.cerrar(); await browser.close(); }
});
