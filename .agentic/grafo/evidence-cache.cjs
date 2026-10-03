#!/usr/bin/env node
/**
 * Agentic KDD — Caché de evidencia (02-esfuerzo-y-tokens)
 *
 * Reutilizar una comprobación solo cuando lo probado es idéntico de verdad:
 *   llave = sujeto (contenido de los archivos del alcance + sus imports locales
 *           transitivos) + runner (config de tests, scripts, lock) + entorno
 *           (node, plataforma, capacidades) + versión de política + comando + tipo.
 *
 * "El archivo no cambió" no basta: un import, la config o una dependencia
 * también cambian el resultado. Un test dirigido no certifica la suite (el
 * tipo forma parte de la llave). Las comprobaciones externas vencen.
 * Se guarda referencia y resumen, nunca salidas enteras.
 *
 * Cuando no hay acierto, `motivo` dice qué cambió (sujeto, runner, entorno,
 * política, vencida): es lo que el log usa para explicar por qué se amplió.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join('.agentic', '_cache', 'evidence');
const RUNNER_FILES = [
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
  'jest.config.js', 'jest.config.cjs', 'jest.config.ts', 'vitest.config.ts', 'vitest.config.js', 'vitest.config.mjs',
  '.mocharc.json', '.mocharc.js', '.mocharc.yml', 'playwright.config.ts', 'playwright.config.js',
  'tsconfig.json', 'babel.config.js', '.babelrc', 'pytest.ini', 'pyproject.toml', 'setup.cfg',
];
const EXT = ['', '.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '/index.js', '/index.ts', '/index.cjs'];
const IMPORT_RE = /(?:require\s*\(\s*|import\s*(?:[^'"]*?from\s*)?|import\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
const MAX_ARCHIVOS = 400;

const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');

function resolver(desde, spec) {
  const base = path.resolve(path.dirname(desde), spec);
  for (const e of EXT) {
    const f = base + e;
    try { if (fs.statSync(f).isFile()) return f; } catch { /* siguiente */ }
  }
  return null;
}

/** Archivos del alcance + imports locales transitivos, con su hash de contenido. */
function cierre(root, alcance) {
  const vistos = new Map();
  const pila = (alcance || []).map((f) => path.resolve(root, f));
  let incompleto = false;
  while (pila.length) {
    const f = pila.pop();
    if (vistos.has(f)) continue;
    if (vistos.size >= MAX_ARCHIVOS) { incompleto = true; break; }
    let txt;
    try { txt = fs.readFileSync(f); } catch { vistos.set(f, 'AUSENTE'); continue; }
    vistos.set(f, sha(txt));
    const s = txt.toString('utf8');
    let m;
    IMPORT_RE.lastIndex = 0;
    while ((m = IMPORT_RE.exec(s))) {
      const r = resolver(f, m[1]);
      if (r && !vistos.has(r)) pila.push(r);
    }
  }
  const rel = [...vistos.entries()].map(([f, h]) => [path.relative(root, f).replace(/\\/g, '/'), h]).sort();
  return { archivos: rel, hash: sha(JSON.stringify(rel)), incompleto };
}

function huellaRunner(root) {
  const partes = [];
  for (const f of RUNNER_FILES) {
    try { partes.push([f, sha(fs.readFileSync(path.join(root, f)))]); } catch { /* no existe */ }
  }
  return sha(JSON.stringify(partes));
}

function huellaEntorno(capacidades = []) {
  return sha(JSON.stringify([process.version, process.platform, process.arch, [...capacidades].sort()]));
}

function politica(root) {
  try { return require('./effort-router.cjs').cargarPolitica(root).policy.policy_version; } catch { return 0; }
}

function componentes(root, q) {
  const c = cierre(root, q.alcance);
  return {
    comando: String(q.comando || ''), tipo: q.tipo === 'suite' ? 'suite' : 'dirigido',
    sujeto: c.hash, runner: huellaRunner(root), entorno: huellaEntorno(q.capacidades), politica: politica(root),
    _cierre: c,
  };
}

const llaveAlcance = (q) => sha(JSON.stringify([String(q.comando || ''), q.tipo === 'suite' ? 'suite' : 'dirigido', [...(q.alcance || [])].map(String).sort()]));
const llave = (c) => sha(JSON.stringify([c.comando, c.tipo, c.sujeto, c.runner, c.entorno, c.politica]));
const dir = (root) => path.join(root, DIR);

function guardar(root, q, resultado) {
  const c = componentes(root, q);
  if (c._cierre.incompleto) return { ok: false, reason_code: 'ALCANCE_DEMASIADO_GRANDE' };
  const k = llave(c);
  const entrada = {
    key: k, ts: new Date().toISOString(), comando: c.comando, tipo: c.tipo, alcance: q.alcance || [],
    archivos_probados: c._cierre.archivos.length,
    componentes: { sujeto: c.sujeto, runner: c.runner, entorno: c.entorno, politica: c.politica },
    ttl_ms: Number.isFinite(q.ttlMs) ? q.ttlMs : null,
    resultado: {
      status: resultado.status, pass: resultado.pass ?? null, fail: resultado.fail ?? null,
      ref: resultado.ref || null, resumen: resultado.resumen ? String(resultado.resumen).slice(0, 500) : null,
    },
  };
  fs.mkdirSync(dir(root), { recursive: true });
  fs.writeFileSync(path.join(dir(root), k + '.json'), JSON.stringify(entrada, null, 2));
  const idx = path.join(dir(root), 'index.json');
  let index = {};
  try { index = JSON.parse(fs.readFileSync(idx, 'utf8')); } catch { /* nuevo */ }
  index[llaveAlcance(q)] = { key: k, componentes: entrada.componentes };
  fs.writeFileSync(idx, JSON.stringify(index, null, 2));
  return { ok: true, key: k, entrada };
}

/** ¿Se puede reutilizar? → { hit, entrada?, motivo } */
function buscar(root, q, { ahora = Date.now() } = {}) {
  const c = componentes(root, q);
  if (c._cierre.incompleto) return { hit: false, motivo: 'ALCANCE_DEMASIADO_GRANDE' };
  const k = llave(c);
  let e = null;
  try { e = JSON.parse(fs.readFileSync(path.join(dir(root), k + '.json'), 'utf8')); } catch { /* no hay */ }
  if (e) {
    if (e.ttl_ms !== null && ahora - Date.parse(e.ts) > e.ttl_ms) return { hit: false, motivo: 'VENCIDA' };
    return { hit: true, entrada: e, motivo: 'IDENTICO' };
  }
  let previo = null;
  try { previo = JSON.parse(fs.readFileSync(path.join(dir(root), 'index.json'), 'utf8'))[llaveAlcance(q)]; } catch { /* sin índice */ }
  if (!previo) return { hit: false, motivo: q.tipo === 'suite' ? 'SIN_SUITE_PREVIA' : 'SIN_EVIDENCIA' };
  const p = previo.componentes;
  const cambios = [];
  if (p.sujeto !== c.sujeto) cambios.push('SUJETO_CAMBIO');
  if (p.runner !== c.runner) cambios.push('RUNNER_O_DEPENDENCIAS_CAMBIO');
  if (p.entorno !== c.entorno) cambios.push('ENTORNO_CAMBIO');
  if (p.politica !== c.politica) cambios.push('POLITICA_CAMBIO');
  return { hit: false, motivo: cambios.join('+') || 'SIN_EVIDENCIA' };
}

module.exports = { guardar, buscar, cierre, huellaRunner, huellaEntorno, RUNNER_FILES };
