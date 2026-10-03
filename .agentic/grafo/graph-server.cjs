'use strict';
const http = require('http');
const path = require('path');
const fs   = require('fs');
const { exec } = require('child_process');
const { exportGraph } = require('./graph-export.cjs');

const PUERTO_BASE = 9750;
const INTENTOS_PUERTO = 10;
const UI_DIR = path.join(__dirname, 'graph-ui');
// Code Structure lo sirve codebase-memory-mcp en otro proceso; su URL sale de
// la instancia real (variable o sondeo), no de un puerto escrito en el HTML.
const CODE_URL_DEFECTO = 'http://localhost:9749';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};
const HOSTS_LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

function esLoopbackHttp(u) {
  try { const x = new URL(u); return x.protocol === 'http:' && HOSTS_LOOPBACK.has(x.hostname === '::1' ? '[::1]' : x.hostname); } catch { return false; }
}

function hostPermitido(h, port) {
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(String(h || '').toLowerCase());
  return !!m && HOSTS_LOOPBACK.has(m[1]) && (!m[2] || Number(m[2]) === Number(port));
}

function origenPermitido(origin, port) {
  if (!origin) return true;
  try { const o = new URL(origin); return o.protocol === 'http:' && hostPermitido(o.host, port); } catch { return false; }
}

/**
 * Resuelve la ruta pedida a un archivo de `uiDir` o devuelve el código HTTP del
 * rechazo. Se decodifica UNA vez; lo que siga codificado, rutas absolutas,
 * segmentos `..`, barras invertidas y enlaces que salen de la carpeta se niegan
 * antes de leer nada.
 */
function resolverRuta(rawUrl, uiDir) {
  const crudo = String(rawUrl || '/').split('?')[0].split('#')[0];
  let ruta;
  try { ruta = decodeURIComponent(crudo); } catch { return { status: 400, reason_code: 'CODIFICACION_INVALIDA' }; }
  if (/%[0-9a-f]{2}/i.test(ruta)) return { status: 400, reason_code: 'DOBLE_CODIFICACION' };
  if (ruta.includes('\0') || ruta.includes('\\')) return { status: 400, reason_code: 'CARACTER_PROHIBIDO' };
  if (!ruta.startsWith('/') || ruta.startsWith('//') || /^\/[a-z]:/i.test(ruta)) return { status: 400, reason_code: 'RUTA_ABSOLUTA' };
  if (ruta.split('/').some((s) => s === '..' || s === '.')) return { status: 403, reason_code: 'SALE_DE_LA_CARPETA' };
  if (ruta === '/') ruta = '/index.html';

  const base = path.resolve(uiDir);
  const full = path.resolve(base, '.' + ruta);
  if (full !== base && !full.startsWith(base + path.sep)) return { status: 403, reason_code: 'SALE_DE_LA_CARPETA' };
  let real;
  try { real = fs.realpathSync(full); } catch { return { status: 404, reason_code: 'NO_EXISTE' }; }
  const baseReal = fs.realpathSync(base);
  if (real !== baseReal && !real.startsWith(baseReal + path.sep)) return { status: 403, reason_code: 'ENLACE_FUERA' };
  let st;
  try { st = fs.statSync(real); } catch { return { status: 404, reason_code: 'NO_EXISTE' }; }
  if (!st.isFile()) return { status: 404, reason_code: 'NO_ES_ARCHIVO' };
  return { status: 200, archivo: real };
}

/** ¿Responde algo en esa URL? (sondeo corto, sin seguir redirecciones). */
function sondear(url, ms = 600) {
  return new Promise((res) => {
    const r = http.request(url, { method: 'HEAD', timeout: ms }, (x) => { x.resume(); res(true); });
    r.on('timeout', () => { r.destroy(); res(false); });
    r.on('error', () => res(false));
    r.end();
  });
}

async function instanciaCode(env) {
  const pedida = env.AKDD_CODE_GRAPH_URL;
  if (pedida && !esLoopbackHttp(pedida)) return { url: null, estado: 'URL_NO_PERMITIDA' };
  const url = pedida || CODE_URL_DEFECTO;
  return (await sondear(url)) ? { url, estado: 'CONECTADO' } : { url: null, estado: 'SIN_CONEXION', intentada: url };
}

function crearServidor({ root = process.cwd(), uiDir = UI_DIR, env = process.env } = {}) {
  let puertoActual = null;
  const base = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };
  const server = http.createServer(async (req, res) => {
    const enviar = (status, tipo, cuerpo, extra) => {
      res.writeHead(status, Object.assign({ 'Content-Type': tipo }, base, extra));
      res.end(req.method === 'HEAD' ? undefined : cuerpo);
    };
    const json = (status, obj) => enviar(status, MIME['.json'], JSON.stringify(obj));
    if (!hostPermitido(req.headers.host, puertoActual)) return json(403, { status: 'ERROR', reason_code: 'HOST_NO_PERMITIDO' });
    if (!origenPermitido(req.headers.origin, puertoActual)) return json(403, { status: 'ERROR', reason_code: 'ORIGEN_NO_PERMITIDO' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return enviar(405, 'text/plain; charset=utf-8', 'Método no permitido', { Allow: 'GET, HEAD' });

    const ruta = String(req.url || '/').split('?')[0];
    if (ruta.startsWith('/vendor/')) {
      const permitidos = new Set(['d3.min.js', '3d-force-graph.min.js', 'three.min.js', 'three-spritetext.min.js', 'force-graph.min.js']);
      const nombre = path.basename(ruta);
      if (!permitidos.has(nombre) || ruta.split('/').some((s) => s === '..' || s === '.')) return enviar(404, 'text/plain; charset=utf-8', 'NO_EXISTE');
      const vendorDir = path.resolve(__dirname, 'vendor');
      const full = path.resolve(vendorDir, nombre);
      if (!full.startsWith(vendorDir + path.sep)) return enviar(403, 'text/plain; charset=utf-8', 'SALE_DE_LA_CARPETA');
      if (!fs.existsSync(full)) return enviar(404, 'text/plain; charset=utf-8', 'NO_EXISTE');
      return enviar(200, MIME['.js'], fs.readFileSync(full));
    }
    if (ruta === '/api/graph.json') {
      try { return json(200, exportGraph(root)); } catch (e) { return json(500, { status: 'ERROR', reason_code: 'EXPORT_FALLA', detalle: String(e.message).slice(0, 160) }); }
    }
    if (ruta === '/api/instance.json') {
      return json(200, { schema_version: 1, status: 'OK', graph_url: `http://localhost:${puertoActual}`, code: await instanciaCode(env), generated_at: new Date().toISOString() });
    }
    const r = resolverRuta(req.url, uiDir);
    if (r.status !== 200) return enviar(r.status, 'text/plain; charset=utf-8', r.reason_code);
    const ext = path.extname(r.archivo).toLowerCase();
    const extra = ext === '.html' ? { 'Content-Security-Policy': "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src http://localhost:* http://127.0.0.1:*; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" } : {};
    enviar(200, MIME[ext] || 'application/octet-stream', fs.readFileSync(r.archivo), extra);
  });

  /** Escucha en el primer puerto libre desde `desde` (0 = el que dé el sistema). */
  server.escuchar = (desde = PUERTO_BASE, intentos = INTENTOS_PUERTO) => new Promise((resolve, reject) => {
    let p = Number(desde);
    const probar = () => {
      const alFallar = (e) => {
        server.removeListener('listening', alEscuchar);
        if (e.code === 'EADDRINUSE' && p !== 0 && --intentos > 0) { p += 1; return probar(); }
        reject(e);
      };
      const alEscuchar = () => { server.removeListener('error', alFallar); puertoActual = server.address().port; resolve(puertoActual); };
      server.once('error', alFallar);
      server.once('listening', alEscuchar);
      server.listen(p, '127.0.0.1');
    };
    probar();
  });
  return server;
}

module.exports = { crearServidor, resolverRuta, hostPermitido, origenPermitido, instanciaCode, UI_DIR };

if (require.main === module) {
  const root = process.argv[2] || process.env.AGENTIX_ROOT || process.cwd();
  const server = crearServidor({ root });
  server.escuchar(Number(process.env.AKDD_GRAPH_PORT) || PUERTO_BASE).then((port) => {
    const url = `http://localhost:${port}`;
    console.log(`\n  Agentix Graph UI → ${url}\n`);
    if (process.env.AKDD_DASH_NO_OPEN === '1') return;
    const open = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    exec(open, () => {});
  }).catch((e) => { console.error('  No se pudo abrir el servidor del grafo: ' + e.message); process.exitCode = 1; });
}
