'use strict';

/* P09-P12 — la referencia visual no se pisa sola, la aprobación exige
   decisión, una referencia alterada o una máscara abusiva no dan PASS, una
   región protegida tiene su propio umbral, y los contratos de flujo y
   accesibilidad corren en un navegador real (FAIL si se rompen). */

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const bv = require('../.agentic/grafo/baseline-visual.cjs');
const png = require('../.agentic/grafo/png-diff.cjs');
const bg = require('../.agentic/grafo/browser-gate.cjs');
const BG_CLI = path.join(__dirname, '..', '.agentic', 'grafo', 'browser-gate.cjs');

function imagen(w, h, pintar) {
  const data = Buffer.alloc(w * h * 4, 255);
  if (pintar) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = pintar(x, y);
    if (c) { const i = (y * w + x) * 4; data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; }
  }
  return png.encodePNG({ width: w, height: h, data });
}
const raiz = () => fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-bv-'));
const VARI = bv.variante({});

test('P10: capturar deja candidato y la referencia aprobada no cambia', () => {
  const root = raiz();
  const a = imagen(20, 20);
  const c1 = bv.guardarCandidato(root, 'compras', VARI, a, {});
  assert.strictEqual(bv.referencia(root, 'compras', VARI).reason_code, 'SIN_REFERENCIA');
  assert.ok(bv.aprobar(root, 'compras', VARI, c1.id, { aprobador: 'ana', motivo: 'base', origen: 'baseline_inicial' }).ok);
  const sha1 = bv.referencia(root, 'compras', VARI).manifest.sha256;

  const b = imagen(20, 20, (x) => (x < 10 ? [0, 0, 0] : null));
  bv.guardarCandidato(root, 'compras', VARI, b, {});
  assert.strictEqual(bv.referencia(root, 'compras', VARI).manifest.sha256, sha1, 'otra captura no pisa la aprobada');
  assert.strictEqual(bv.listar(root, 'compras')[0].candidatos.length, 2);
});

test('P10: aprobar exige aprobador y motivo; base inicial no reemplaza una base', () => {
  const root = raiz();
  const c = bv.guardarCandidato(root, 'v', VARI, imagen(4, 4), {});
  assert.strictEqual(bv.aprobar(root, 'v', VARI, c.id, {}).reason_code, 'SIN_DECISION');
  assert.strictEqual(bv.aprobar(root, 'v', VARI, c.id, { aprobador: 'ana' }).reason_code, 'SIN_DECISION');
  assert.strictEqual(bv.aprobar(root, 'v', VARI, '../x', { aprobador: 'a', motivo: 'm' }).reason_code, 'CANDIDATO_NO_EXISTE');
  assert.strictEqual(bv.aprobar(root, 'v', VARI, c.id, { aprobador: 'a', motivo: 'm', origen: 'yo' }).reason_code, 'ORIGEN_INVALIDO');
  assert.ok(bv.aprobar(root, 'v', VARI, c.id, { aprobador: 'a', motivo: 'm', origen: 'baseline_inicial' }).ok);
  const c2 = bv.guardarCandidato(root, 'v', VARI, imagen(4, 4, () => [1, 2, 3]), {});
  assert.strictEqual(bv.aprobar(root, 'v', VARI, c2.id, { aprobador: 'a', motivo: 'm', origen: 'baseline_inicial' }).reason_code, 'YA_HAY_BASE');
  const ok = bv.aprobar(root, 'v', VARI, c2.id, { aprobador: 'a', motivo: 'rediseño pedido', origen: 'cambio_intencional' });
  assert.ok(ok.ok);
  assert.ok(ok.manifest.reemplaza, 'deja rastro de la base anterior');
  assert.strictEqual(fs.readdirSync(path.join(root, '.agentic', 'snapshots', 'v', VARI, 'historial')).filter((f) => f.endsWith('.png')).length, 1);
});

test('P10: referencia alterada o sin manifiesto no se usa', () => {
  const root = raiz();
  const c = bv.guardarCandidato(root, 'v', VARI, imagen(4, 4), {});
  bv.aprobar(root, 'v', VARI, c.id, { aprobador: 'a', motivo: 'm' });
  const dir = path.join(root, '.agentic', 'snapshots', 'v', VARI);
  fs.writeFileSync(path.join(dir, 'aprobado.png'), imagen(4, 4, () => [9, 9, 9]));
  assert.strictEqual(bv.referencia(root, 'v', VARI).reason_code, 'REFERENCIA_ALTERADA');
  fs.unlinkSync(path.join(dir, 'aprobado.json'));
  assert.strictEqual(bv.referencia(root, 'v', VARI).reason_code, 'REFERENCIA_SIN_MANIFIESTO');
});

test('P10: la foto plana de la v3.17 se compara pero no aprueba', () => {
  const root = raiz();
  fs.mkdirSync(path.join(root, '.agentic', 'snapshots'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agentic', 'snapshots', 'vieja.png'), imagen(4, 4));
  const r = bv.referencia(root, 'vieja', VARI);
  assert.ok(r.ok && r.legacy);
  assert.strictEqual(bv.referencia(root, 'vieja', bv.variante({ width: 390, height: 844 })).reason_code, 'SIN_REFERENCIA', 'escritorio no prueba móvil');
  const c = bv.guardarCandidato(root, 'vieja', VARI, imagen(4, 4), {});
  assert.ok(bv.aprobar(root, 'vieja', VARI, c.id, { aprobador: 'a', motivo: 'adoptar', origen: 'baseline_inicial' }).ok, 'la legada no bloquea la base inicial');
});

test('P10: máscaras con motivo, acotadas y fuera de zonas protegidas; regiones con su umbral', () => {
  const ref = imagen(100, 100);
  const reloj = imagen(100, 100, (x, y) => (x < 10 && y < 10 ? [0, 0, 0] : null));
  assert.strictEqual(bv.comparar(ref, reloj, { threshold: 0.5 }).status, 'FAIL', '1% distinto sobre umbral 0.5');
  assert.strictEqual(bv.comparar(ref, reloj, { mascaras: [{ x: 0, y: 0, w: 10, h: 10 }] }).reason_code, 'MASCARA_SIN_MOTIVO');
  assert.strictEqual(bv.comparar(ref, reloj, { mascaras: [{ x: 0, y: 0, w: 10, h: 10, motivo: 'reloj' }] }).status, 'PASS');
  assert.strictEqual(bv.comparar(ref, reloj, { mascaras: [{ x: 0, y: 0, w: 50, h: 50, motivo: 'todo' }] }).reason_code, 'MASCARA_EXCESIVA');
  assert.strictEqual(bv.comparar(ref, reloj, {
    mascaras: [{ x: 0, y: 0, w: 10, h: 10, motivo: 'reloj' }], regiones: [{ nombre: 'boton', x: 5, y: 5, w: 10, h: 10 }],
  }).reason_code, 'MASCARA_SOBRE_REGION_PROTEGIDA');

  const boton = imagen(100, 100, (x, y) => (x >= 80 && x < 82 && y >= 80 && y < 82 ? [0, 0, 0] : null));
  assert.strictEqual(bv.comparar(ref, boton, { threshold: 0.5 }).status, 'PASS', '0.04% global pasa');
  const r = bv.comparar(ref, boton, { threshold: 0.5, regiones: [{ nombre: 'guardar', x: 75, y: 75, w: 10, h: 10 }] });
  assert.strictEqual(r.status, 'FAIL');
  assert.strictEqual(r.reason_code, 'REGION_PROTEGIDA_CAMBIO');
  assert.strictEqual(r.regiones[0].nombre, 'guardar');
  assert.strictEqual(bv.comparar(ref, imagen(100, 90)).reason_code, 'DIMENSIONES');
  assert.strictEqual(bv.comparar(Buffer.from('no png'), ref).status, 'UNVERIFIED');
});

const servidores = [];
after(() => { for (const s of servidores) s.close(); });
function servir(handler) {
  return new Promise((res) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => { servidores.push(s); res(`http://127.0.0.1:${s.address().port}`); });
  });
}

test('P09/P10/P11/P12: navegador real — candidato, aprobación, FAIL visual, flujo y accesibilidad', { timeout: 180000 }, async (t) => {
  let color = '#2a6';
  let guardado = false;
  const base = await servir((req, res) => {
    if (req.url === '/favicon.ico') { res.statusCode = 204; return res.end(); }
    if (req.url === '/api/guardar' && req.method === 'POST') { guardado = true; res.setHeader('content-type', 'application/json'); return res.end('{"ok":true}'); }
    if (req.url === '/falta.png') { res.statusCode = 404; return res.end(); }
    res.setHeader('content-type', 'text/html');
    if (req.url === '/form') {
      return res.end(`<!doctype html><html><body>
        <label for="n">Nombre</label><input id="n" data-testid="nombre">
        <button data-testid="guardar" onclick="fetch('/api/guardar',{method:'POST'}).then(()=>{document.getElementById('ok').hidden=false})">Guardar</button>
        <p id="ok" data-testid="aviso" hidden>Guardado</p></body></html>`);
    }
    if (req.url === '/roto') return res.end('<!doctype html><html><body><button></button><input id="x"><img src="/falta.png"></body></html>');
    return res.end(`<!doctype html><html><body style="margin:0"><div style="width:300px;height:120px;background:${color}"></div><p>hora: <span id="h"></span></p><script>document.getElementById('h').textContent=new Date().toISOString()</script></body></html>`);
  });
  const root = raiz();
  const vp = [{ width: 640, height: 400 }];

  const s1 = await bg.runSnapshot(base + '/panel', 'panel', { projectRoot: root, viewports: vp });
  if (s1.status === 'UNVERIFIED' && /navegador|browser|chrome|executable/i.test(s1.message)) {
    assert.strictEqual(s1.passed, false, 'sin navegador nunca PASS');
    t.skip('sin navegador: lo visual no se comprobó');
    return;
  }
  assert.strictEqual(s1.status, 'CANDIDATO', s1.message);
  const vari = s1.candidatos[0].variante;
  assert.strictEqual(vari, '640x400@1-light-default');
  assert.strictEqual(bv.referencia(root, 'panel', vari).reason_code, 'SIN_REFERENCIA', 'capturar no aprueba');

  const sinRef = await bg.runCompare(base + '/panel', 'panel', { projectRoot: root, viewports: vp });
  assert.strictEqual(sinRef.status, 'UNVERIFIED');

  assert.ok(bv.aprobar(root, 'panel', vari, s1.candidatos[0].candidato, { aprobador: 'qa', motivo: 'base', origen: 'baseline_inicial' }).ok);
  const igual = await bg.runCompare(base + '/panel', 'panel', { projectRoot: root, viewports: vp });
  assert.strictEqual(igual.status, 'PASS', 'hora congelada y animaciones apagadas: misma foto. ' + igual.message);

  const otraRuta = await bg.runCompare(base + '/otra', 'panel', { projectRoot: root, viewports: vp });
  assert.strictEqual(otraRuta.resultados[0].reason_code, 'RUTA_DISTINTA');

  color = '#c33';
  const roto = await bg.runCompare(base + '/panel', 'panel', { projectRoot: root, viewports: vp });
  assert.strictEqual(roto.status, 'FAIL', roto.message);
  assert.ok(roto.resultados[0].candidato, 'el cambio queda como candidato, no se acepta solo');
  assert.strictEqual(bv.referencia(root, 'panel', vari).manifest.origen, 'baseline_inicial');

  // asíncrono: el servidor de la página vive en este mismo proceso
  const cli = await new Promise((res) => {
    const p = spawn(process.execPath, [BG_CLI, base + '/panel', '--compare=panel', '--viewports=640x400', '--json'], { cwd: root });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (status) => res({ status, out }));
  });
  assert.strictEqual(cli.status, 1, 'compare FAIL sale con 1: ' + cli.out);

  const flujo = { type: 'flujo', id: 'guardar-nombre', pasos: [
    { accion: 'fill', testid: 'nombre', valor: 'Ana' }, { accion: 'click', rol: 'button', nombre: 'Guardar' },
  ], espera: [{ visible: { testid: 'aviso' } }, { texto: 'Guardado' }, { peticion: { metodo: 'POST', ruta: '/api/guardar', status: 200 } }] };
  const ok = await bg.runBrowserGate(base + '/form', { projectRoot: root, outDir: root, checks: [flujo, { type: 'a11y' }, { type: 'teclado', tabs: 2 }] });
  assert.strictEqual(ok.status, 'PASS', ok.message);
  assert.ok(guardado, 'el efecto de red ocurrió de verdad');
  assert.ok(ok.limites && ok.limites.includes('contraste calculado'), 'declara lo que la revisión no prueba');

  const malFlujo = Object.assign({}, flujo, { espera: [{ peticion: { metodo: 'POST', ruta: '/api/borrar' } }] });
  const mal = await bg.runBrowserGate(base + '/form', { projectRoot: root, outDir: root, checks: [malFlujo] });
  assert.strictEqual(mal.status, 'FAIL');
  assert.ok(mal.findings.some((f) => f.tipo === 'FLUJO_ROTO' && /api\/borrar/.test(f.detalle)));

  const a11y = await bg.runBrowserGate(base + '/roto', { projectRoot: root, outDir: root, checks: [{ type: 'a11y' }] });
  assert.strictEqual(a11y.status, 'FAIL');
  const tipos = new Set(a11y.findings.map((f) => f.tipo));
  for (const t of ['A11Y_SIN_NOMBRE', 'A11Y_SIN_ETIQUETA', 'A11Y_IMG_SIN_ALT', 'ASSET_ROTO']) assert.ok(tipos.has(t), `falta ${t}: ${[...tipos]}`);
});
