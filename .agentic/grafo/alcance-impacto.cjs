'use strict';

/**
 * Alcance de verificación por impacto (P15). Proporcional, sin huecos:
 *
 *   · texto local en una vista → solo esa ruta; no se abre auditoría global
 *   · token global (variable CSS en :root) → las vistas que lo consumen
 *   · archivo compartido sin ruta conocida → suite completa (índice inseguro),
 *     no por hábito sino porque no se sabe a quién afecta
 *   · el navegador recorre las rutas afectadas + smoke crítico, nunca todo
 *
 * Solo mira el front; el backend se selecciona por AST y contratos
 * (contratos-backend). No decide el riesgo: eso es de effort-router. Un cambio de una línea en
 * auth sigue con sus contratos protegidos aunque el alcance sea local.
 */

const fs = require('fs');
const path = require('path');

const FRONT = /\.(html?|jsx?|tsx?|vue|svelte|css|scss|sass|less|mdx)$/i;
const ESTILO = /\.(css|scss|sass|less)$/i;
const NO_CODIGO = /(^|\/)(test|tests|__tests__|docs?)\/|\.(md|txt)$|\.test\.|\.spec\./i;
const EXCLUIR_DIR = new Set(['node_modules', '.git', '.agentic', '_output', 'dist', 'build', '.next', 'coverage', '.legion']);
const MAX_ARCHIVOS = 5000;

const rel = (root, f) => path.relative(root, path.resolve(root, f)).replace(/\\/g, '/');
const leer = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

/** `--x: valor` declarados en bloques :root/html. */
function tokensDefinidos(css) {
  const out = new Map();
  const bloques = String(css || '').match(/(?::root|html)\s*\{[^}]*\}/g) || [];
  for (const b of bloques) for (const m of b.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)) out.set(m[1], m[2].trim());
  return out;
}

/** Tokens cuyo valor cambió (o, sin versión anterior, todos los del archivo). */
function tokensCambiados(despues, antes) {
  const d = tokensDefinidos(despues);
  if (antes == null) return [...d.keys()];
  const a = tokensDefinidos(antes);
  const cambios = [];
  for (const [k, v] of d) if (a.get(k) !== v) cambios.push(k);
  for (const k of a.keys()) if (!d.has(k)) cambios.push(k);
  return cambios;
}

function archivosFront(root) {
  const out = [];
  const pila = [root];
  while (pila.length && out.length < MAX_ARCHIVOS) {
    const d = pila.pop();
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.isDirectory()) { if (!EXCLUIR_DIR.has(e.name)) pila.push(path.join(d, e.name)); }
      else if (FRONT.test(e.name)) out.push(path.join(d, e.name));
    }
  }
  return { archivos: out, incompleto: pila.length > 0 };
}

/** Rutas de las vistas que consumen esos tokens, directo o importando la hoja que los usa. */
function vistasConsumidoras(root, tokens, { mapa } = {}) {
  const { rutaDe } = require('./dev-target.cjs');
  const { archivos, incompleto } = archivosFront(root);
  const usa = (txt) => tokens.some((t) => txt.includes(`var(${t}`));
  const hojas = [];
  const rutas = new Set();
  const textos = new Map(archivos.map((f) => [f, leer(f) || '']));
  for (const [f, txt] of textos) {
    if (!usa(txt)) continue;
    const ruta = rutaDe(rel(root, f), mapa);
    if (ruta) rutas.add(ruta);
    else if (ESTILO.test(f)) hojas.push(path.basename(f));
  }
  if (hojas.length) {
    for (const [f, txt] of textos) {
      if (ESTILO.test(f) || !hojas.some((h) => txt.includes(h))) continue;
      const ruta = rutaDe(rel(root, f), mapa);
      if (ruta) rutas.add(ruta);
    }
  }
  return { rutas: [...rutas].sort(), incompleto };
}

/**
 * @param files   archivos del changeset
 * @param opts    { mapa, antes: { [archivo]: contenido anterior } }
 * @returns { nivel: LOCAL|AMPLIADO|COMPLETO, rutas, sinRuta, tokens, suite, browser, auditoria_global, motivos }
 */
function alcance(root, files, { mapa, antes = {} } = {}) {
  const { rutaDe } = require('./dev-target.cjs');
  const rutas = new Set();
  const sinRuta = [];
  const motivos = [];
  const tokens = [];
  let incompleto = false;
  for (const f0 of files || []) {
    const f = rel(root, f0);
    if (NO_CODIGO.test(f) || !FRONT.test(f)) continue;
    const ruta = rutaDe(f, mapa);
    if (ruta) { rutas.add(ruta); continue; }
    if (ESTILO.test(f)) {
      const txt = leer(path.join(root, f));
      const cambiados = tokensCambiados(txt, antes[f] != null ? antes[f] : antes[f0]);
      if (cambiados.length) {
        const v = vistasConsumidoras(root, cambiados, { mapa });
        for (const r of v.rutas) rutas.add(r);
        tokens.push(...cambiados);
        if (!motivos.includes('TOKEN_GLOBAL')) motivos.push('TOKEN_GLOBAL');
        if (v.incompleto) incompleto = true;
        continue;
      }
    }
    sinRuta.push(f);
  }
  if (sinRuta.length && !motivos.includes('INDICE_INSEGURO')) motivos.push('INDICE_INSEGURO');
  if (incompleto) motivos.push('PROYECTO_DEMASIADO_GRANDE');
  const nivel = sinRuta.length || incompleto ? 'COMPLETO' : (tokens.length ? 'AMPLIADO' : 'LOCAL');
  return {
    nivel, rutas: [...rutas].sort(), sinRuta, tokens: [...new Set(tokens)],
    suite: nivel === 'COMPLETO' ? 'COMPLETA' : 'DIRIGIDA',
    browser: { rutas: [...rutas].sort(), smoke_critico: true },
    auditoria_global: false,
    motivos: motivos.length ? motivos : ['CAMBIO_LOCAL'],
  };
}

module.exports = { alcance, tokensDefinidos, tokensCambiados, vistasConsumidoras };
