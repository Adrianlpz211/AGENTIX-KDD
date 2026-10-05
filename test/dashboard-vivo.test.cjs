'use strict';
/* TODO el tablero en vivo, sin matar el servidor (pedido del dueño, 05/10/2026). Hasta 3.23.6 solo las tarjetas de arriba se
   actualizaban: el grafo, la estructura de código, los tiempos y la visita se incrustaban en el HTML UNA vez, al arrancar, y por mucho
   que se recargara había que reiniciar el servidor. Ahora: (1) cada carga trae la página con los datos de AHORA; (2) un evento SSE
   «pagina» avisa de que el contenido cambió; (3) la huella cubre también los archivos que la página lee, no solo la base. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { crearFixture, arrancarDashboard, REPO } = require('./fixtures/dashboard-fixture.cjs');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-dashvivo-' + p + '-'));
const dbDe = (dir) => path.join(dir, '.agentic', 'memoria.db');
const base = (d) => d.url.replace(/\/$/, '');
const pagina = async (d) => (await fetch(base(d) + '/')).text();
const insertarNodo = (dir, titulo) => {
  const db = new DatabaseSync(dbDe(dir));
  try { db.prepare("INSERT INTO nodos (tipo, titulo, contenido, area, confianza, estado) VALUES ('patron', ?, 'cuerpo', 'pagos', 'ALTA', 'ACTIVO')").run(titulo); } finally { db.close(); }
};

/** Lee eventos SSE hasta que `listo(eventos)` o se acaba el plazo. */
async function leerSse(url, listo, ms) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  const eventos = []; let buf = '';
  try {
    const r = await fetch(url, { headers: { Accept: 'text/event-stream' }, signal: ac.signal });
    const rd = r.body.getReader(); const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await rd.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf('\n\n')) >= 0) {
        const bloque = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(bloque), da = /^data: (.+)$/m.exec(bloque);
        if (ev && da) { try { eventos.push({ tipo: ev[1], data: JSON.parse(da[1]) }); } catch { /* keepalive */ } }
      }
      if (listo(eventos)) break;
    }
  } catch { /* plazo cumplido */ } finally { clearTimeout(t); ac.abort(); }
  return eventos;
}

test('VIVO-1 — la página trae los datos de AHORA: un nodo nuevo aparece al recargar, sin reiniciar el servidor', async () => {
  const dir = tmp('nodo'); crearFixture(dir);
  const d = await arrancarDashboard(dir);
  try {
    const antes = await pagina(d);
    assert.ok(antes.includes('Doble cobro'), 'la página inicial trae los nodos del fixture');
    assert.ok(!antes.includes('Nodo nacido con el servidor corriendo'));
    insertarNodo(dir, 'Nodo nacido con el servidor corriendo');
    const despues = await pagina(d);
    assert.ok(despues.includes('Nodo nacido con el servidor corriendo'), 'antes de 3.23.6 esto exigía matar el servidor');
    assert.notEqual(/var HUELLA = ("[^"]*")/.exec(antes)[1], /var HUELLA = ("[^"]*")/.exec(despues)[1], 'la huella embebida cambia con los datos');
  } finally { d.cerrar(); }
});

test('VIVO-2 — también cuenta lo que no está en la base: editar config.md cambia la página', async () => {
  const dir = tmp('config'); crearFixture(dir);
  const d = await arrancarDashboard(dir);
  try {
    const antes = await pagina(d);
    const cfg = path.join(dir, '.agentic', 'config.md');
    fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace('Nombre: Fixture Tienda', 'Nombre: Tienda Renombrada Xyz'));
    const despues = await pagina(d);
    assert.ok(!antes.includes('Tienda Renombrada Xyz'));
    assert.ok(despues.includes('Tienda Renombrada Xyz'));
  } finally { d.cerrar(); }
});

test('VIVO-3 — el SSE avisa «pagina» con la huella al conectar y otra distinta cuando el contenido cambia', async () => {
  const dir = tmp('sse'); crearFixture(dir);
  const d = await arrancarDashboard(dir, { AKDD_DASH_POLL_MS: '300' });
  try {
    const html = await pagina(d);
    const huellaPagina = /var HUELLA = "([^"]*)"/.exec(html)[1];
    const url = base(d) + '/api/v1/events?topics=pagina';
    const lectura = leerSse(url, (ev) => ev.filter((e) => e.tipo === 'pagina').length >= 2, 12000);
    await new Promise((r) => setTimeout(r, 1200));
    insertarNodo(dir, 'Otro nodo vivo');
    const ev = (await lectura).filter((e) => e.tipo === 'pagina');
    assert.ok(ev.length >= 2, 'llegó la huella inicial y el aviso del cambio: ' + JSON.stringify(ev));
    assert.equal(ev[0].data.inicial, true);
    assert.equal(ev[0].data.huella, huellaPagina, 'al conectar, la huella del servidor coincide con la de la página recién servida');
    assert.notEqual(ev[1].data.huella, ev[0].data.huella);
  } finally { d.cerrar(); }
});

test('VIVO-4 — la regeneración no congela el servidor (la página se calcula en otro proceso)', async () => {
  const dir = tmp('hijo'); crearFixture(dir);
  const d = await arrancarDashboard(dir);
  try {
    const antes = await pagina(d);
    insertarNodo(dir, 'Nodo que obliga a regenerar');
    const regen = pagina(d);                                            // dispara el hijo
    const t0 = Date.now(); const r = await fetch(base(d) + '/api/v1/summary'); const ms = Date.now() - t0;
    assert.equal(r.status, 200);
    assert.ok(ms < 2000, 'mientras se regenera, el servidor sigue contestando: ' + ms + ' ms');
    assert.ok((await regen).includes('Nodo que obliga a regenerar'));
    assert.ok(antes.length > 1000);
  } finally { d.cerrar(); }
});

test('VIVO-5 — huellaPaginaDe: igual si nada cambió, distinta si cambia una tabla o un archivo que la página lee', () => {
  const dir = tmp('huella'); crearFixture(dir);
  const { huellaPaginaDe } = require(path.join(REPO, '.agentic', 'grafo', 'dashboard-api.cjs'));
  const h = () => huellaPaginaDe({ dbPath: dbDe(dir), projectPath: dir });
  const h0 = h();
  assert.equal(h(), h0, 'estable');
  insertarNodo(dir, 'cambia la tabla'); const h1 = h();
  assert.notEqual(h1, h0);
  fs.appendFileSync(path.join(dir, '.agentic', 'config.md'), '\nNota: otra línea\n');
  const t = new Date(Date.now() + 5000); fs.utimesSync(path.join(dir, '.agentic', 'config.md'), t, t);
  assert.notEqual(h(), h1, 'cambia el archivo');
});

test('VIVO-6 — el cliente trae el aviso «datos nuevos», el botón y la restauración de la vista tras recargar', async () => {
  const dir = tmp('cliente'); crearFixture(dir);
  const d = await arrancarDashboard(dir);
  try {
    const html = await pagina(d);
    for (const pieza of ['akdd-datos-nuevos', "topics=pagina", 'Actualizar ahora', 'akdd-vista', 'restaurarVista', 'IDLE_MS']) assert.ok(html.includes(pieza), 'falta en el cliente: ' + pieza);
    const sc = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    for (const s of sc) assert.doesNotThrow(() => new Function(s), 'el JS del cliente es válido');
    assert.match(html, /var IDLE_MS = 30000,/, 'por defecto se recarga sola tras 30 s sin usar el tablero');
  } finally { d.cerrar(); }
});

test('VIVO-7 — AKDD_DASH_AUTO_REFRESH_MS=0 desactiva la recarga sola (queda el aviso y el botón)', async () => {
  const dir = tmp('manual'); crearFixture(dir);
  const d = await arrancarDashboard(dir, { AKDD_DASH_AUTO_REFRESH_MS: '0' });
  try { assert.match(await pagina(d), /var IDLE_MS = 0,/); } finally { d.cerrar(); }
});

test('PUERTO-1 — cada proyecto tiene su propio puerto por defecto (estable, distinto entre proyectos) y AKDD_DASH_PORT lo manda', async () => {
  const dirA = tmp('pa'); const dirB = tmp('pb'); crearFixture(dirA); crearFixture(dirB);
  const arrancar = (dir, extra) => new Promise((resolve, reject) => {
    const env = Object.assign({}, process.env, { AKDD_DASH_NO_OPEN: '1' }, extra); delete env.AKDD_DASH_PORT; delete env.NODE_TEST_CONTEXT;
    const p = require('child_process').spawn(process.execPath, [path.join(REPO, 'dashboard.cjs')], { cwd: dir, env, windowsHide: true });
    let sal = ''; const t = setTimeout(() => { p.kill(); reject(new Error('no arrancó: ' + sal)); }, 30000);
    p.stdout.on('data', (d) => { sal += d; const m = /→ http:\/\/localhost:(\d+)/.exec(sal); if (m) { clearTimeout(t); resolve({ puerto: Number(m[1]), cerrar: () => p.kill() }); } });
    p.on('exit', () => { clearTimeout(t); });
  });
  const a = await arrancar(dirA), b = await arrancar(dirB);
  try {
    assert.ok(a.puerto >= 3847 && a.puerto < 3947 && b.puerto >= 3847 && b.puerto < 3947, 'dentro del rango propio: ' + a.puerto + ' / ' + b.puerto);
    assert.notEqual(a.puerto, b.puerto, 'dos proyectos distintos no comparten puerto');
  } finally { a.cerrar(); b.cerrar(); }
  // estable: el mismo proyecto cae en el mismo puerto la siguiente vez
  const a1 = await arrancar(dirA); const mismo = a1.puerto; a1.cerrar();
  await new Promise((r) => setTimeout(r, 600));
  const a2 = await arrancar(dirA); try { assert.equal(a2.puerto, mismo); } finally { a2.cerrar(); }
});
