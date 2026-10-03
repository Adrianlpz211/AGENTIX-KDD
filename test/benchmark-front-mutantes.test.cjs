'use strict';

/* P19 — mutantes de frontend sembrados en páginas de fixture y detectados en
   un navegador real por el browser-gate, cada uno con su control sano.
   Sin navegador los casos quedan SKIP (nunca PASS): el benchmark los cuenta
   como no ejecutados. */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const bg = require('../.agentic/grafo/browser-gate.cjs');

const PAGINAS = {
  '/handler-sano': '<button data-testid="b" onclick="document.getElementById(\'ok\').hidden=false">Enviar</button><p id="ok" data-testid="ok" hidden>Enviado</p>',
  '/handler-roto': '<button data-testid="b">Enviar</button><p id="ok" data-testid="ok" hidden>Enviado</p>',
  '/carga-sana': '<button data-testid="b" onclick="this.textContent=\'Cargando\';setTimeout(()=>{document.getElementById(\'r\').textContent=\'Listo\'},150)">Cargar</button><p id="r"></p>',
  '/carga-infinita': '<button data-testid="b" onclick="this.textContent=\'Cargando\'">Cargar</button><p id="r"></p>',
  '/overlay': '<button data-testid="b" onclick="document.getElementById(\'ok\').hidden=false">Enviar</button><p id="ok" data-testid="ok" hidden>Enviado</p><div style="position:fixed;inset:0;background:rgba(0,0,0,.01)"></div>',
  '/select-sano': '<label for="s">Talla</label><select id="s"><option>M</option></select>',
  '/select-roto': '<label for="s">Talla</label><select id="s" disabled><option>M</option></select>',
  '/modal-sano': '<div id="m" data-testid="modal">Hola <button data-testid="cerrar" onclick="document.getElementById(\'m\').hidden=true">Cerrar</button></div>',
  '/modal-roto': '<div id="m" data-testid="modal">Hola <button data-testid="cerrar">Cerrar</button></div>',
  '/required-sano': '<label for="e">Correo</label><input id="e" required>',
  '/required-roto': '<label for="e">Correo</label><input id="e">',
  '/teclado-sano': '<button>Uno</button><button>Dos</button><button>Tres</button>',
  '/teclado-roto': '<button>Uno</button><button style="width:0;height:0;padding:0;border:0;overflow:hidden">Oculto</button><button>Tres</button>',
  '/rechazo': '<p>Hola</p><script>Promise.reject(new Error("rechazo sin manejar"))</script>',
  '/texto-local': '<p>Bienvenida actualizada</p>',
  '/error-sano': '<button data-testid="b" onclick="fetch(\'/api/guardar\',{method:\'POST\'}).then(r=>{document.getElementById(\'m\').textContent=r.ok?\'Guardado\':\'No se pudo guardar\'})">Guardar</button><p id="m"></p>',
  '/error-roto': '<button data-testid="b" onclick="fetch(\'/api/guardar\',{method:\'POST\'}).then(()=>{document.getElementById(\'m\').textContent=\'Guardado\'})">Guardar</button><p id="m"></p>',
  '/foco-sano': '<button data-testid="abrir" onclick="m.hidden=false;c.focus()">Abrir</button><div id="m" hidden><button id="c" data-testid="cerrar" onclick="m.hidden=true;document.querySelector(\'[data-testid=abrir]\').focus()">Cerrar</button></div>',
  '/foco-roto': '<button data-testid="abrir" onclick="m.hidden=false;c.focus()">Abrir</button><div id="m" hidden><button id="c" data-testid="cerrar" onclick="m.hidden=true">Cerrar</button></div>',
  '/trampa': '<button id="a">Uno</button><button>Dos</button><button>Tres</button><script>document.addEventListener(\'keydown\',e=>{if(e.key===\'Tab\'){e.preventDefault();document.getElementById(\'a\').focus()}})</script>',
  '/rol-sano': '<button data-testid="borrar" id="x">Borrar todo</button><script>if(new URLSearchParams(location.search).get(\'rol\')!==\'admin\')document.getElementById(\'x\').remove()</script>',
  '/rol-roto': '<button data-testid="borrar" id="x">Borrar todo</button>',
  '/movil-sano': '<button data-testid="b" style="max-width:100%">Pagar</button>',
  '/movil-roto': '<button data-testid="b" style="margin-left:420px">Pagar</button>',
  '/vacio-sano': '<ul id="l"></ul><p id="e"></p><script>const d=[];if(!d.length)document.getElementById(\'e\').textContent=\'Sin pedidos todavía\'</script>',
  '/vacio-roto': '<ul id="l"></ul><p id="e"></p>',
  '/movimiento-sano': '<style>@media (prefers-reduced-motion: no-preference){.s{animation:g 1s linear infinite}}@keyframes g{to{transform:rotate(360deg)}}</style><div class="s">*</div>',
  '/movimiento-roto': '<style>.s{animation:g 1s linear infinite}@keyframes g{to{transform:rotate(360deg)}}</style><div class="s">*</div>',
  '/xss-sano': '<p id="n"></p><script>fetch(\'/api/dato\').then(r=>r.json()).then(d=>{document.getElementById(\'n\').textContent=d.nombre})</script>',
  '/xss-roto': '<p id="n"></p><script>fetch(\'/api/dato\').then(r=>r.json()).then(d=>{document.getElementById(\'n\').innerHTML=d.nombre})</script>',
};
const SPA = '<button data-testid="b" onclick="history.pushState({},\'\',location.pathname.replace(/\\/detalle$/,\'\')+\'/detalle\');pinta()">Ver</button><p id="v"></p><script>function pinta(){document.getElementById(\'v\').textContent=location.pathname.endsWith(\'/detalle\')?\'Detalle del pedido\':\'Lista\'}pinta()</script>';
PAGINAS['/spa-sana'] = SPA;
PAGINAS['/spa-sana/detalle'] = SPA;
PAGINAS['/spa-rota'] = SPA;

let base = null;
let server = null;
let disponible = null;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-bench-front-'));

before(async () => {
  server = http.createServer((req, res) => {
    const ruta = req.url.split('?')[0];
    if (ruta === '/favicon.ico') { res.statusCode = 204; return res.end(); }
    if (ruta === '/api/guardar') { res.statusCode = 500; return res.end('{"error":"FALLO"}'); }
    if (ruta === '/api/dato') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ nombre: '<img src=x onerror="window.__akddXss=1">' })); }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (!PAGINAS[ruta]) res.statusCode = 404;
    res.end(`<!doctype html><html lang="es"><head><title>f</title></head><body>${PAGINAS[ruta] || '<p>404</p>'}</body></html>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const probe = await bg.runBrowserGate(base + '/texto-local', { projectRoot: root, outDir: root });
  disponible = probe.reason_code !== 'SIN_NAVEGADOR';
});
after(() => { if (server) server.close(); });

async function gate(t, ruta, checks, extra) {
  if (!disponible) { t.skip('sin navegador'); return null; }
  return bg.runBrowserGate(base + ruta, Object.assign({ projectRoot: root, outDir: root, checks }, extra));
}
async function sanoYRoto(t, sanoRuta, rotoRuta, checks, extra) {
  const sano = await gate(t, sanoRuta, checks, extra);
  if (!sano) return null;
  assert.strictEqual(sano.status, 'PASS', sano.message);
  const roto = await gate(t, rotoRuta, checks, extra);
  assert.strictEqual(roto.status, 'FAIL', roto.message);
  return roto;
}
const flujo = (pasos, espera, timeoutMs = 1500) => ({ type: 'flujo', id: 'f', pasos, espera, timeoutMs });
const clickB = [{ accion: 'click', testid: 'b' }];

test('BENCH-F01: handler de botón ausente', { timeout: 60000 }, async (t) => {
  const sano = await gate(t, '/handler-sano', [flujo(clickB, [{ visible: { testid: 'ok' } }])]);
  if (!sano) return;
  assert.strictEqual(sano.status, 'PASS', sano.message);
  const roto = await gate(t, '/handler-roto', [flujo(clickB, [{ visible: { testid: 'ok' } }])]);
  assert.strictEqual(roto.status, 'FAIL');
});

test('BENCH-F05: loading infinito', { timeout: 60000 }, async (t) => {
  const sano = await gate(t, '/carga-sana', [flujo(clickB, [{ texto: 'Listo' }])]);
  if (!sano) return;
  assert.strictEqual(sano.status, 'PASS', sano.message);
  assert.strictEqual((await gate(t, '/carga-infinita', [flujo(clickB, [{ texto: 'Listo' }])])).status, 'FAIL');
});

test('BENCH-F06: botón cubierto por un overlay', { timeout: 60000 }, async (t) => {
  const r = await gate(t, '/overlay', [flujo(clickB, [{ visible: { testid: 'ok' } }])]);
  if (!r) return;
  assert.strictEqual(r.status, 'FAIL');
  assert.ok(r.findings.some((f) => f.tipo === 'FLUJO_ROTO'));
});

test('BENCH-F07: select inutilizable', { timeout: 60000 }, async (t) => {
  const c = [{ type: 'select-usable', selector: '#s' }];
  const sano = await gate(t, '/select-sano', c);
  if (!sano) return;
  assert.strictEqual(sano.status, 'PASS', sano.message);
  assert.strictEqual((await gate(t, '/select-roto', c)).status, 'FAIL');
});

test('BENCH-F08: modal que no cierra', { timeout: 60000 }, async (t) => {
  const c = [flujo([{ accion: 'click', testid: 'cerrar' }], [{ oculto: { testid: 'modal' } }])];
  const sano = await gate(t, '/modal-sano', c);
  if (!sano) return;
  assert.strictEqual(sano.status, 'PASS', sano.message);
  assert.strictEqual((await gate(t, '/modal-roto', c)).status, 'FAIL');
});

test('BENCH-F03: validación perdida (required)', { timeout: 60000 }, async (t) => {
  const c = [{ type: 'required-attr', selector: '#e' }];
  const sano = await gate(t, '/required-sano', c);
  if (!sano) return;
  assert.strictEqual(sano.status, 'PASS', sano.message);
  assert.strictEqual((await gate(t, '/required-roto', c)).status, 'FAIL');
});

test('BENCH-F10a: foco en un control invisible', { timeout: 60000 }, async (t) => {
  const c = [{ type: 'teclado', tabs: 3 }];
  const sano = await gate(t, '/teclado-sano', c);
  if (!sano) return;
  assert.strictEqual(sano.status, 'PASS', sano.message);
  const roto = await gate(t, '/teclado-roto', c);
  assert.strictEqual(roto.status, 'FAIL');
  assert.ok(roto.findings.some((f) => f.tipo === 'TECLADO_ROTO'));
});

test('BENCH-F19: promesa rechazada sin manejar no da PASS', { timeout: 60000 }, async (t) => {
  const r = await gate(t, '/rechazo', []);
  if (!r) return;
  assert.notStrictEqual(r.status, 'PASS');
  assert.ok(r.findings.some((f) => f.tipo === 'PAGE_ERROR' || f.tipo === 'CONSOLE_ERROR'), JSON.stringify(r.findings));
});

test('BENCH-F04: un error del servidor mostrado como éxito', { timeout: 60000 }, async (t) => {
  const c = [flujo(clickB, [{ peticion: { metodo: 'POST', ruta: '/api/guardar', status: 500 } }, { texto: 'No se pudo guardar' }])];
  const sano = await gate(t, '/error-sano', c);
  if (!sano) return;
  // El 500 sembrado deja su línea en consola: WARN es correcto, FAIL no.
  assert.notStrictEqual(sano.status, 'FAIL', sano.message);
  assert.ok(sano.contratos.every((x) => x.status === 'PASS'));
  assert.strictEqual((await gate(t, '/error-roto', c)).status, 'FAIL');
});

test('BENCH-F09: el foco no vuelve al cerrar el diálogo', { timeout: 60000 }, async (t) => {
  const c = [flujo([{ accion: 'click', testid: 'abrir' }, { accion: 'click', testid: 'cerrar' }], [{ foco: { testid: 'abrir' } }])];
  await sanoYRoto(t, '/foco-sano', '/foco-roto', c);
});

test('BENCH-F10b: trampa de teclado', { timeout: 60000 }, async (t) => {
  const roto = await sanoYRoto(t, '/teclado-sano', '/trampa', [{ type: 'teclado', tabs: 3 }]);
  if (roto) assert.ok(roto.findings.some((f) => /trampa/.test(f.detalle)), JSON.stringify(roto.findings));
});

test('BENCH-F11: la ruta no sobrevive a recargar', { timeout: 60000 }, async (t) => {
  const c = [flujo([...clickB, { accion: 'reload' }], [{ texto: 'Detalle del pedido' }])];
  await sanoYRoto(t, '/spa-sana', '/spa-rota', c);
});

test('BENCH-F12: un rol sin permiso ve la acción de administrador', { timeout: 60000 }, async (t) => {
  const admin = await gate(t, '/rol-sano?rol=admin', [flujo([], [{ visible: { testid: 'borrar' } }], 800)]);
  if (!admin) return;
  assert.strictEqual(admin.status, 'PASS', 'el admin sí la ve: ' + admin.message);
  await sanoYRoto(t, '/rol-sano?rol=ventas', '/rol-roto?rol=ventas', [flujo([], [{ oculto: { testid: 'borrar' } }], 800)]);
});

test('BENCH-F13: el botón queda fuera de la pantalla en móvil', { timeout: 60000 }, async (t) => {
  await sanoYRoto(t, '/movil-sano', '/movil-roto', [{ type: 'en-pantalla', selector: '[data-testid="b"]' }], { viewport: { width: 375, height: 700 } });
});

test('BENCH-F20: falta el texto del estado vacío', { timeout: 60000 }, async (t) => {
  await sanoYRoto(t, '/vacio-sano', '/vacio-roto', [flujo([], [{ texto: 'Sin pedidos todavía' }], 800)]);
});

test('BENCH-F21: una animación sin fin ignora reduced-motion', { timeout: 60000 }, async (t) => {
  await sanoYRoto(t, '/movimiento-sano', '/movimiento-roto', [{ type: 'movimiento-reducido' }]);
});

test('BENCH-F24: un dato con HTML se ejecuta (XSS)', { timeout: 60000 }, async (t) => {
  const roto = await sanoYRoto(t, '/xss-sano', '/xss-roto', [{ type: 'xss-sentinela', esperaMs: 600 }]);
  if (roto) assert.ok(roto.findings.some((f) => f.tipo === 'XSS_EJECUTADO'));
});

test('BENCH-F22: otro viewport o tema no se compara contra la referencia de la base', async () => {
  const bv = require('../.agentic/grafo/baseline-visual.cjs');
  const png = require('../.agentic/grafo/png-diff.cjs');
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-bench-var-'));
  const buf = png.encodePNG({ width: 4, height: 4, data: Buffer.alloc(64, 255) });
  const c = bv.guardarCandidato(r, 'pedidos', bv.variante({}), buf, { url: 'http://127.0.0.1:1/pedidos' });
  assert.ok(bv.aprobar(r, 'pedidos', bv.variante({}), c.id, { aprobador: 'ana', motivo: 'base', origen: 'baseline_inicial' }).ok);
  for (const v of [{ width: 375, height: 700 }, { theme: 'dark' }]) {
    const res = await bg.runCompare('http://127.0.0.1:1/pedidos', 'pedidos', { projectRoot: r, viewports: [v] });
    assert.strictEqual(res.status, 'UNVERIFIED', JSON.stringify(v));
    assert.strictEqual(res.reason_code, 'SIN_REFERENCIA', 'la variante base no sirve de referencia para ' + JSON.stringify(v));
  }
});

test('BENCH-SANO: texto local cambiado pasa sin bloqueo', { timeout: 60000 }, async (t) => {
  const r = await gate(t, '/texto-local', [{ type: 'a11y' }]);
  if (!r) return;
  assert.strictEqual(r.status, 'PASS', r.message);
});
