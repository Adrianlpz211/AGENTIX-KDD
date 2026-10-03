#!/usr/bin/env node
/**
 * Agentic KDD — Costo y uso medido (H31)
 *
 * Lo que el proveedor REPORTA y lo que alguien ESTIMA no se mezclan nunca.
 * Un dato que falta es null, no 0: un cero inventado hace que una corrida sin
 * medir parezca gratis y ensucia cualquier promedio.
 *
 * Normalización a { input, output, cache_read, cache_write } sin doble conteo:
 *   anthropic  input_tokens ya excluye la caché; cache_read_input_tokens y
 *              cache_creation_input_tokens van aparte.
 *   openai     prompt_tokens / input_tokens INCLUYEN lo cacheado
 *              (…_details.cached_tokens): se resta para que input sea solo lo
 *              no cacheado. OpenAI no reporta escritura de caché → null.
 *   gemini     promptTokenCount incluye cachedContentTokenCount: se resta.
 *              output = candidatesTokenCount + thoughtsTokenCount.
 *
 * El "ahorro" no sale de constantes: solo de comparar tareas equivalentes de la
 * misma clase (low/medium/high), con línea base, muestra mínima y calidad.
 *
 * Registro: .agentic/telemetria/uso.jsonl (solo se agrega).
 *
 * CLI:
 *   node costo-uso.cjs registrar --provider=anthropic --usage='{...}' [--model=] [--clase=medium] [--variante=kdd|baseline] [--tarea=id] [--calidad=PASS|FAIL] [--ms=] [--bytes=]
 *   node costo-uso.cjs estimar --bytes=N [--clase=] [--variante=]
 *   node costo-uso.cjs resumen
 *   node costo-uso.cjs benchmark [--min=3]
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CAMPOS = ['input', 'output', 'cache_read', 'cache_write'];
const CLASES = ['low', 'medium', 'high'];
const MIN_MUESTRA = 3;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const resta = (a, b) => (a === null ? null : b === null ? a : Math.max(0, a - b));
const suma = (...v) => (v.every((x) => x === null) ? null : v.reduce((s, x) => s + (x || 0), 0));

function vacio() { return { input: null, output: null, cache_read: null, cache_write: null }; }

/**
 * Normaliza el usage crudo de un proveedor. Sin usage → kind 'unknown' y todo null.
 */
function normalizar(provider, usage) {
  const p = String(provider || '').toLowerCase();
  if (!usage || typeof usage !== 'object') return { kind: 'unknown', provider: p || null, tokens: vacio() };

  let t = vacio();
  let nota = null;
  if (p === 'anthropic' || p === 'claude') {
    t = {
      input: num(usage.input_tokens),
      output: num(usage.output_tokens),
      cache_read: num(usage.cache_read_input_tokens),
      cache_write: num(usage.cache_creation_input_tokens),
    };
  } else if (p === 'openai') {
    const prompt = num(usage.prompt_tokens ?? usage.input_tokens);
    const det = usage.prompt_tokens_details || usage.input_tokens_details;
    const cached = det ? num(det.cached_tokens) : null;
    t = {
      input: cached === null ? prompt : resta(prompt, cached),
      output: num(usage.completion_tokens ?? usage.output_tokens),
      cache_read: cached,
      cache_write: null,
    };
    if (prompt !== null && cached === null) nota = 'input incluye caché no desglosada por el proveedor';
  } else if (p === 'gemini' || p === 'google') {
    const u = usage.usageMetadata || usage;
    const prompt = num(u.promptTokenCount);
    const cached = num(u.cachedContentTokenCount);
    const cand = num(u.candidatesTokenCount);
    const thoughts = num(u.thoughtsTokenCount);
    t = { input: resta(prompt, cached), output: suma(cand, thoughts), cache_read: cached, cache_write: null };
  } else {
    return { kind: 'unknown', provider: p || null, tokens: vacio(), nota: `proveedor sin normalizador: ${p || '(vacío)'}` };
  }

  const kind = CAMPOS.some((c) => t[c] !== null) ? 'real' : 'unknown';
  return { kind, provider: p, tokens: t, ...(nota ? { nota } : {}) };
}

/** Estimación declarada por tamaño. Nunca se suma con lo real. */
function estimar(bytes) {
  const b = num(bytes);
  return { kind: 'estimate', base: 'bytes/4', tokens: { input: b === null ? null : Math.ceil(b / 4), output: null, cache_read: null, cache_write: null } };
}

function totalTokens(tokens) { return suma(...CAMPOS.map((c) => tokens[c] ?? null)); }

/** Costo solo con precios dados por quien llama (USD por millón). Falta uno que se necesita → null. */
function costo(registro, precios) {
  if (!registro || registro.kind !== 'real' || !precios) return null;
  const tabla = precios[`${registro.provider}:${registro.model}`] || precios[registro.provider];
  if (!tabla) return null;
  let usd = 0;
  for (const c of CAMPOS) {
    const n = registro.tokens[c];
    if (n === null || n === 0) continue;
    if (typeof tabla[c] !== 'number') return null;
    usd += (n / 1e6) * tabla[c];
  }
  return Math.round(usd * 1e6) / 1e6;
}

function rutaRegistro(root) { return path.join(root, '.agentic', 'telemetria', 'uso.jsonl'); }

function registrar(root, entrada) {
  const reg = {
    ts: new Date().toISOString(),
    cycle_id: entrada.cycle_id || process.env.AKDD_CYCLE_ID || null,
    model: entrada.model || null,
    calls: num(entrada.calls) ?? 1,
    bytes: num(entrada.bytes),
    ms: num(entrada.ms),
    tarea: {
      id: entrada.tarea || null,
      clase: CLASES.includes(entrada.clase) ? entrada.clase : null,
      variante: entrada.variante === 'baseline' || entrada.variante === 'kdd' ? entrada.variante : null,
    },
    calidad: { status: entrada.calidad === 'PASS' || entrada.calidad === 'FAIL' ? entrada.calidad : null },
    ...(entrada.estimado ? estimar(entrada.bytes) : normalizar(entrada.provider, entrada.usage)),
  };
  const f = rutaRegistro(root);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, JSON.stringify(reg) + '\n');
  try { require('./telemetry.cjs').recordUsage(reg, { cycle_id: reg.cycle_id }, root); } catch { /* la traza es un extra */ }
  return reg;
}

function leer(root) {
  const f = rutaRegistro(root);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function resumen(registros) {
  const real = registros.filter((r) => r.kind === 'real');
  const est = registros.filter((r) => r.kind === 'estimate');
  const r = { llamadas: real.reduce((s, x) => s + (x.calls || 1), 0) };
  for (const c of CAMPOS) r[c] = suma(...real.map((x) => x.tokens[c] ?? null));
  r.total = real.length ? suma(...CAMPOS.map((c) => r[c])) : null;
  if (!real.length) for (const c of CAMPOS) r[c] = null;
  return {
    real: r,
    estimado: { llamadas: est.length, input: est.length ? suma(...est.map((x) => x.tokens.input)) : null, base: 'bytes/4' },
    sin_dato: registros.filter((x) => x.kind === 'unknown').length,
  };
}

function mediana(v) {
  const s = v.filter((x) => x !== null).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function grupo(rs) {
  const conCalidad = rs.filter((r) => r.calidad && r.calidad.status);
  return {
    n: rs.length,
    mediana_tokens: mediana(rs.map((r) => totalTokens(r.tokens))),
    mediana_ms: mediana(rs.map((r) => r.ms ?? null)),
    mediana_llamadas: mediana(rs.map((r) => r.calls ?? null)),
    calidad_pass: conCalidad.length ? conCalidad.filter((r) => r.calidad.status === 'PASS').length / conCalidad.length : null,
    sin_calidad: rs.length - conCalidad.length,
  };
}

/**
 * Comparación por clase de tarea, solo con uso REAL. Sin línea base, sin
 * muestra mínima o sin calidad medida en todas las corridas: no hay veredicto.
 */
function benchmark(registros, { minMuestra = MIN_MUESTRA } = {}) {
  const real = registros.filter((r) => r.kind === 'real' && r.tarea && r.tarea.clase);
  const clases = {};
  for (const clase of CLASES) {
    const base = grupo(real.filter((r) => r.tarea.clase === clase && r.tarea.variante === 'baseline'));
    const kdd = grupo(real.filter((r) => r.tarea.clase === clase && r.tarea.variante === 'kdd'));
    let veredicto;
    let diferencia_tokens = null;
    if (base.n < minMuestra || kdd.n < minMuestra) veredicto = 'MUESTRA_INSUFICIENTE';
    else if (base.sin_calidad || kdd.sin_calidad) veredicto = 'SIN_CALIDAD';
    else if (base.mediana_tokens === null || kdd.mediana_tokens === null || base.mediana_tokens === 0) veredicto = 'SIN_DATO';
    else {
      diferencia_tokens = Math.round(((kdd.mediana_tokens - base.mediana_tokens) / base.mediana_tokens) * 1000) / 10;
      if (kdd.calidad_pass < base.calidad_pass) veredicto = 'CALIDAD_PEOR';
      else veredicto = diferencia_tokens < 0 ? 'MENOS_TOKENS_MISMA_O_MEJOR_CALIDAD' : 'SIN_AHORRO';
    }
    clases[clase] = { baseline: base, kdd, diferencia_tokens_pct: diferencia_tokens, veredicto };
  }
  return { min_muestra: minMuestra, clases, nota: 'Por clase de tarea; no hay porcentaje universal.' };
}

module.exports = { normalizar, estimar, totalTokens, costo, registrar, leer, resumen, benchmark, rutaRegistro, CLASES, MIN_MUESTRA };

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  const opt = {};
  for (const a of rest) { const m = /^--([^=]+)=(.*)$/s.exec(a); if (m) opt[m[1]] = m[2]; }
  const root = process.cwd();
  if (cmd === 'registrar') {
    let usage = null;
    try { usage = opt.usage ? JSON.parse(opt.usage) : null; } catch { console.error('usage no es JSON'); process.exit(1); }
    console.log(JSON.stringify(registrar(root, { ...opt, usage, ms: opt.ms ? Number(opt.ms) : undefined, bytes: opt.bytes ? Number(opt.bytes) : undefined })));
  } else if (cmd === 'estimar') {
    console.log(JSON.stringify(registrar(root, { ...opt, estimado: true, bytes: Number(opt.bytes) })));
  } else if (cmd === 'resumen') {
    console.log(JSON.stringify(resumen(leer(root)), null, 2));
  } else if (cmd === 'benchmark') {
    console.log(JSON.stringify(benchmark(leer(root), { minMuestra: opt.min ? Number(opt.min) : MIN_MUESTRA }), null, 2));
  } else {
    console.log('Uso: node costo-uso.cjs registrar|estimar|resumen|benchmark');
  }
}
