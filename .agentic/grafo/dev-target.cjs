#!/usr/bin/env node
'use strict';

/**
 * dev-target — a qué servidor y a qué rutas apunta el Browser Gate.
 *
 * Antes post-cycle probaba 3000, 3001, 5173… y usaba el primero que
 * contestara: otra app abierta en 3000 se revisaba en lugar del proyecto y el
 * gate decía PASS sobre la app equivocada. Ahora:
 *
 *   URL declarada   AKDD_DEV_URL o .agentic/dev-server.json { "url": ... }.
 *                   Sin declaración no se adivina: UNVERIFIED.
 *   Identidad       la respuesta tiene que probar que es ESTE proyecto:
 *                   { "identidad": { "tipo": "marker", "valor": "..." } } busca
 *                   el texto en el HTML (p. ej. <meta name="agentix-project"
 *                   content="...">); { "tipo": "header", "nombre": ..., "valor": ... }
 *                   mira una cabecera. Sin identidad declarada o sin
 *                   coincidencia: UNVERIFIED, nunca PASS.
 *   Rutas           las que tocó el cambio (convenciones Next pages/app,
 *                   SvelteKit, Nuxt; o el mapa "rutas" del archivo), no solo /.
 *                   Un archivo de front sin ruta conocida queda listado.
 *   Externo         el servidor es del dev: aquí no se arranca ni se apaga.
 *
 *   .agentic/dev-server.json
 *   { "url": "http://127.0.0.1:5173",
 *     "identidad": { "tipo": "marker", "valor": "agentix-project:clinica" },
 *     "rutas": { "src/views/compras/": "/compras" } }
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const TIMEOUT_MS = 5000;

function leerConfig(root) {
  let cfg = {};
  const f = path.join(root, '.agentic', 'dev-server.json');
  if (fs.existsSync(f)) {
    try { cfg = JSON.parse(fs.readFileSync(f, 'utf8')); }
    catch (e) { return { ok: false, reason_code: 'CONFIG_INVALIDA', message: `.agentic/dev-server.json ilegible: ${e.message}` }; }
  }
  if (process.env.AKDD_DEV_URL) cfg.url = process.env.AKDD_DEV_URL;
  if (!cfg.url) return { ok: false, reason_code: 'SIN_URL_DECLARADA', message: 'sin URL declarada (AKDD_DEV_URL o .agentic/dev-server.json) — no se adivina el puerto' };
  try { new URL(cfg.url); } catch { return { ok: false, reason_code: 'CONFIG_INVALIDA', message: `url inválida: ${cfg.url}` }; }
  return { ok: true, cfg };
}

function pedir(url, timeoutMs) {
  return new Promise((resolve) => {
    let fin = false;
    const terminar = (r) => { if (!fin) { fin = true; resolve(r); } };
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { timeout: timeoutMs }, (res) => {
      let cuerpo = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (cuerpo.length < 2 * 1024 * 1024) cuerpo += d; });
      res.on('end', () => terminar({ ok: true, status: res.statusCode, headers: res.headers, cuerpo }));
    });
    req.on('timeout', () => { req.destroy(); terminar({ ok: false, reason_code: 'TIMEOUT' }); });
    req.on('error', (e) => terminar({ ok: false, reason_code: e.code === 'ECONNREFUSED' ? 'SIN_SERVIDOR' : 'ERROR_RED', message: e.message }));
    setTimeout(() => { req.destroy(); terminar({ ok: false, reason_code: 'TIMEOUT' }); }, timeoutMs + 500).unref();
  });
}

/** ¿El servidor en `url` es este proyecto? */
async function verificarIdentidad(url, identidad, { timeoutMs = TIMEOUT_MS } = {}) {
  if (!identidad || !identidad.tipo || !identidad.valor) {
    return { ok: false, reason_code: 'SIN_IDENTIDAD', message: 'sin identidad declarada: no hay forma de saber si el servidor es este proyecto' };
  }
  const r = await pedir(url, timeoutMs);
  if (!r.ok) return { ok: false, reason_code: r.reason_code, message: r.message || r.reason_code };
  if (identidad.tipo === 'marker') {
    return r.cuerpo.includes(identidad.valor)
      ? { ok: true, status: r.status }
      : { ok: false, reason_code: 'IDENTIDAD_NO_COINCIDE', message: `la respuesta de ${url} no contiene la marca del proyecto` };
  }
  if (identidad.tipo === 'header') {
    const h = r.headers[String(identidad.nombre || 'x-agentix-project').toLowerCase()];
    return h === identidad.valor
      ? { ok: true, status: r.status }
      : { ok: false, reason_code: 'IDENTIDAD_NO_COINCIDE', message: `cabecera ${identidad.nombre || 'x-agentix-project'} = ${h || '(ausente)'}` };
  }
  return { ok: false, reason_code: 'IDENTIDAD_INVALIDA', message: `tipo de identidad desconocido: ${identidad.tipo}` };
}

const FRONT = /\.(html?|css|scss|less|js|jsx|ts|tsx|vue|svelte|astro)$/i;

/** Ruta de la app que corresponde a un archivo, o null si no se sabe. */
function rutaDe(rel, mapa) {
  const r = rel.replace(/\\/g, '/');
  for (const [prefijo, ruta] of Object.entries(mapa || {})) {
    if (r === prefijo || r.startsWith(prefijo.endsWith('/') ? prefijo : prefijo + '/')) return ruta;
  }
  const limpiar = (s) => {
    const segs = s.split('/').filter((x) => x && !/^\(.*\)$/.test(x));
    const out = segs.map((x) => x.replace(/^\[\.\.\.(.+)\]$/, ':$1').replace(/^\[(.+)\]$/, ':$1'));
    return '/' + out.join('/');
  };
  let m;
  if ((m = r.match(/(?:^|\/)app\/(.*?)\/?page\.(?:jsx?|tsx?|mdx)$/))) return limpiar(m[1]);
  if ((m = r.match(/(?:^|\/)pages\/(.+)\.(?:jsx?|tsx?|vue)$/)) && !/(^|\/)(_app|_document|api\/)/.test(m[1])) return limpiar(m[1].replace(/(^|\/)index$/, ''));
  if ((m = r.match(/(?:^|\/)src\/routes\/(.*?)\/?\+page\.svelte$/))) return limpiar(m[1]);
  if (/(^|\/)(index\.html?|src\/(main|App)\.(jsx?|tsx?|vue))$/.test(r)) return '/';
  return null;
}

function rutasAfectadas(files, mapa) {
  const rutas = new Set();
  const sinRuta = [];
  for (const f of files || []) {
    if (!FRONT.test(f)) continue;
    const ruta = rutaDe(f, mapa);
    if (ruta) rutas.add(ruta); else sinRuta.push(f);
  }
  return { rutas: [...rutas].sort(), sinRuta };
}

/** Todo lo que el gate necesita saber antes de abrir un navegador. */
async function resolverObjetivo(root, files, opts = {}) {
  const c = leerConfig(root);
  if (!c.ok) return { status: 'UNVERIFIED', ...c };
  const ident = await verificarIdentidad(c.cfg.url, c.cfg.identidad, opts);
  if (!ident.ok) return { status: 'UNVERIFIED', url: c.cfg.url, reason_code: ident.reason_code, message: ident.message };
  let { rutas, sinRuta } = rutasAfectadas(files, c.cfg.rutas);
  let impacto = null;
  try {
    impacto = require('./alcance-impacto.cjs').alcance(root, files, { mapa: c.cfg.rutas, antes: opts.antes });
    rutas = [...new Set([...rutas, ...impacto.rutas])].sort();
    sinRuta = sinRuta.filter((f) => impacto.sinRuta.includes(f.replace(/\\/g, '/')));
  } catch { /* sin análisis de impacto: rutas directas */ }
  const base = c.cfg.url.replace(/\/+$/, '');
  return {
    status: 'READY',
    url: c.cfg.url,
    externo: true,
    rutas,
    urls: rutas.map((r) => base + r),
    sinRuta,
    impacto: impacto ? { nivel: impacto.nivel, tokens: impacto.tokens, motivos: impacto.motivos, suite: impacto.suite } : null,
    identidad: c.cfg.identidad.tipo,
  };
}

if (require.main === module) {
  resolverObjetivo(process.cwd(), process.argv.slice(2)).then((r) => {
    console.log(JSON.stringify(r, null, 2));
    if (r.status !== 'READY') process.exitCode = 1;
  });
}

module.exports = { leerConfig, verificarIdentidad, rutaDe, rutasAfectadas, resolverObjetivo, TIMEOUT_MS };
