#!/usr/bin/env node
/**
 * Agentic KDD — Simple Gate (03-mejoras-del-zip)
 *
 * "Antes de escribir código nuevo, ¿ya existe?" — como sugerencias
 * verificables, nunca como freno:
 *   · dependencia nueva con equivalente nativo de la plataforma
 *   · función nueva cuyo nombre ya está declarado en otro archivo
 *   · bloque nuevo que ya existe idéntico en otro archivo (≥ 6 líneas)
 * y un diagnóstico de líneas netas que NO es proxy de calidad.
 *
 * La búsqueda es acotada y declara su costo y si se truncó. Con riesgo alto,
 * cada sugerencia recuerda que seguridad/contratos prevalecen aunque
 * requieran más código. No llama a ningún modelo.
 *
 * CLI: node simple-gate.cjs [archivos...] [--json]   (sin archivos: los del último commit)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const NATIVOS = {
  axios: 'fetch nativo (Node ≥ 18)', 'node-fetch': 'fetch nativo (Node ≥ 18)', 'cross-fetch': 'fetch nativo (Node ≥ 18)', request: 'fetch nativo (Node ≥ 18)',
  uuid: 'crypto.randomUUID()', 'node-uuid': 'crypto.randomUUID()',
  rimraf: 'fs.rmSync(p, { recursive: true, force: true })', mkdirp: 'fs.mkdirSync(p, { recursive: true })',
  'lodash.clonedeep': 'structuredClone()', 'clone-deep': 'structuredClone()',
  'left-pad': 'String.prototype.padStart', 'object-assign': 'Object.assign', 'array-flatten': 'Array.prototype.flat',
  'es6-promise': 'Promise nativa', 'is-number': 'Number.isFinite', dotenv: 'process.loadEnvFile() (Node ≥ 20.12)',
  'abort-controller': 'AbortController global', 'string.prototype.replaceall': 'String.prototype.replaceAll',
};
const EXT_CODIGO = /\.(c?js|mjs|jsx|tsx?|py)$/i;
/* Copias, ejemplos y tests no son código a reutilizar: solo meten ruido. */
const IGNORAR = /(^|\/)(node_modules|\.git|_output|dist|build|coverage|\.next|\.agentic\/_\w+|docs?|tests?|__tests__|spec|fixtures?|examples?|vendor|third_party|benchmarks?)(\/|$)/i;
const ES_TEST = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$/i;
const LIMITE = { archivos: 400, bytes: 4 * 1024 * 1024 };
const VENTANA = 6;
const DECL = [
  /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]{3,})\s*\(/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]{3,})\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/,
  /^\s*def\s+([A-Za-z_]\w{3,})\s*\(/,
];
const TRIVIAL = /^[\s{}()[\];,]*$|^\s*(\/\/|#|\*|\/\*)|^\s*(return|break|continue|else|try|\}\s*catch)\b[^\w]*$/;

const barra = (p) => String(p).replace(/\\/g, '/');
const norm = (l) => l.trim().replace(/\s+/g, ' ');

const GENERICOS = new Set(['main', 'init', 'run', 'start', 'setup', 'help', 'usage', 'uso', 'parse', 'load', 'save', 'open', 'close', 'leer', 'escribir', 'ruta', 'test', 'handler', 'render']);

function declaraciones(texto) {
  const out = new Set();
  for (const l of String(texto || '').split('\n')) for (const re of DECL) { const m = re.exec(l); if (m && !GENERICOS.has(m[1].toLowerCase())) out.add(m[1]); }
  return out;
}

/* Solo lo exportado se puede reutilizar desde otro archivo; un helper local con el mismo nombre no es señal. */
function exportados(texto) {
  const t = String(texto || '');
  const out = new Set();
  for (const m of t.matchAll(/^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\s*\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) out.add(m[1]);
  for (const m of t.matchAll(/\b(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/g)) out.add(m[1]);
  for (const m of t.matchAll(/module\.exports\s*=\s*\{([^}]*)\}/g)) for (const n of m[1].split(',')) { const k = n.split(':')[0].replace(/\.\.\.\w+/, '').trim(); if (/^[A-Za-z_$][\w$]*$/.test(k)) out.add(k); }
  for (const m of t.matchAll(/^def\s+([A-Za-z]\w*)\s*\(/gm)) out.add(m[1]);
  return out;
}

function lineasAgregadas(previo, nuevo) {
  const antes = new Map();
  for (const l of String(previo || '').split('\n')) antes.set(l, (antes.get(l) || 0) + 1);
  const agregadas = [];
  for (const l of String(nuevo || '').split('\n')) {
    const n = antes.get(l) || 0;
    if (n) antes.set(l, n - 1); else agregadas.push(l);
  }
  const eliminadas = [...antes.values()].reduce((a, b) => a + b, 0);
  return { agregadas, eliminadas };
}

function ventanas(lineas) {
  const utiles = lineas.map(norm).filter((l) => l.length > 3 && !TRIVIAL.test(l));
  const out = new Map();
  for (let i = 0; i + VENTANA <= utiles.length; i++) {
    const h = crypto.createHash('sha1').update(utiles.slice(i, i + VENTANA).join('\n')).digest('hex');
    if (!out.has(h)) out.set(h, utiles[i]);
  }
  return out;
}

/** Archivos del proyecto con tope de cantidad y bytes. */
function recorrer(root, excluir) {
  const out = [];
  let bytes = 0;
  let truncada = false;
  const pila = [root];
  while (pila.length && !truncada) {
    const dir = pila.pop();
    let entradas = [];
    try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entradas) {
      const abs = path.join(dir, e.name);
      const rel = barra(path.relative(root, abs));
      if (IGNORAR.test(rel + (e.isDirectory() ? '/' : ''))) continue;
      if (e.isDirectory()) { pila.push(abs); continue; }
      if (!EXT_CODIGO.test(e.name) || excluir.has(rel)) continue;
      let st; try { st = fs.statSync(abs); } catch { continue; }
      if (out.length >= LIMITE.archivos || bytes + st.size > LIMITE.bytes) { truncada = true; break; }
      bytes += st.size;
      out.push(rel);
    }
  }
  return { archivos: out, bytes, truncada };
}

function depsDe(txt) {
  try { const p = JSON.parse(txt); return new Set([...Object.keys(p.dependencies || {}), ...Object.keys(p.devDependencies || {})]); } catch { return new Set(); }
}

/**
 * cambios: [{ path, nuevo, previo }]  (contenido; previo null = archivo nuevo)
 * opciones: { decision? }  (la del effort-router, para el aviso de riesgo alto)
 */
function analizar(root, cambios, opciones = {}) {
  const t0 = Date.now();
  const sugerencias = [];
  const tocados = new Set(cambios.map((c) => barra(c.path)));
  let agregadas = 0;
  let eliminadas = 0;
  const nuevasDecl = [];
  const nuevasVentanas = new Map();

  for (const c of cambios) {
    const rel = barra(c.path);
    if (/(^|\/)package\.json$/.test(rel)) {
      const antes = depsDe(c.previo || '{}');
      for (const d of depsDe(c.nuevo || '{}')) {
        if (antes.has(d) || !NATIVOS[d]) continue;
        sugerencias.push({ tipo: 'DEPENDENCIA_EVITABLE', archivo: rel, detalle: `"${d}" tiene equivalente nativo: ${NATIVOS[d]}`, verificable: { dependencia: d, alternativa: NATIVOS[d] } });
      }
      continue;
    }
    if (!EXT_CODIGO.test(rel)) continue;
    const { agregadas: lineas, eliminadas: e } = lineasAgregadas(c.previo, c.nuevo);
    agregadas += lineas.length; eliminadas += e;
    if (ES_TEST.test(rel)) continue;
    const previas = declaraciones(c.previo);
    for (const n of declaraciones(lineas.join('\n'))) if (!previas.has(n)) nuevasDecl.push({ nombre: n, archivo: rel });
    for (const [h, primera] of ventanas(lineas)) if (!nuevasVentanas.has(h)) nuevasVentanas.set(h, { archivo: rel, primera });
  }

  let busqueda = { fuente: 'ninguna', archivos_leidos: 0, bytes_leidos: 0, truncada: false };
  if (nuevasDecl.length || nuevasVentanas.size) {
    const scan = recorrer(root, tocados);
    busqueda = { fuente: 'recorrido', archivos_leidos: scan.archivos.length, bytes_leidos: scan.bytes, truncada: scan.truncada };
    const porNombre = new Map(nuevasDecl.map((d) => [d.nombre, d]));
    const vistos = new Set();
    for (const rel of scan.archivos) {
      let txt; try { txt = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { continue; }
      const exp = exportados(txt);
      for (const n of declaraciones(txt)) {
        const d = exp.has(n) ? porNombre.get(n) : null;
        if (d && !vistos.has('D' + n)) {
          vistos.add('D' + n);
          sugerencias.push({ tipo: 'REUTILIZAR', archivo: d.archivo, detalle: `"${n}" ya existe y se exporta en ${rel}; ¿reutilizarla?`, verificable: { simbolo: n, existente: rel } });
        }
      }
      if (nuevasVentanas.size) {
        for (const [h] of ventanas(txt.split('\n'))) {
          const v = nuevasVentanas.get(h);
          if (v && !vistos.has('V' + v.archivo + rel)) {
            vistos.add('V' + v.archivo + rel);
            sugerencias.push({ tipo: 'DUPLICACION', archivo: v.archivo, detalle: `≥${VENTANA} líneas idénticas a ${rel} (empieza: "${v.primera.slice(0, 60)}")`, verificable: { existente: rel, lineas_minimas: VENTANA } });
          }
        }
      }
    }
  }

  const alto = opciones.decision && opciones.decision.risk === 'HIGH';
  if (alto) for (const s of sugerencias) s.nota = 'riesgo alto: seguridad, accesibilidad y contratos prevalecen aunque requieran más código';

  return {
    gate: 'simple',
    status: sugerencias.length ? 'WARN' : 'PASS',
    blocking: false,
    sugerencias,
    diagnostico: { lineas_agregadas: agregadas, lineas_eliminadas: eliminadas, neto: agregadas - eliminadas, nota: 'solo diagnóstico, no mide calidad' },
    busqueda,
    costo: { ms: Date.now() - t0, archivos_leidos: busqueda.archivos_leidos, bytes_leidos: busqueda.bytes_leidos },
  };
}

/** Cambios del último commit (o de los archivos dados) contra HEAD~1 / HEAD. */
function cambiosDe(root, archivos, { base = 'HEAD' } = {}) {
  const sc = require('./staged-content.cjs');
  return archivos.map((f) => {
    const rel = barra(f);
    let nuevo = null; let previo = null;
    try { nuevo = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { /* borrado */ }
    try { const r = sc.git(root, ['show', `${base}:${rel}`]); previo = r.ok ? r.stdout.toString('utf8') : null; } catch { /* sin git */ }
    return { path: rel, nuevo, previo };
  }).filter((c) => c.nuevo !== null);
}

function formatear(r) {
  if (!r.sugerencias.length) return `simple-gate: sin sugerencias (${r.costo.archivos_leidos} archivos revisados, ${r.costo.ms} ms)`;
  return [`simple-gate: ${r.sugerencias.length} sugerencia(s) — informativo, no bloquea`]
    .concat(r.sugerencias.map((s) => `  · [${s.tipo}] ${s.archivo}: ${s.detalle}`))
    .concat([`  búsqueda: ${r.busqueda.archivos_leidos} archivos${r.busqueda.truncada ? ' (truncada)' : ''}, ${r.costo.ms} ms · neto ${r.diagnostico.neto} líneas`])
    .join('\n');
}

module.exports = { analizar, cambiosDe, formatear, NATIVOS, VENTANA };

if (require.main === module) {
  const args = process.argv.slice(2);
  const root = process.cwd();
  let archivos = args.filter((a) => !a.startsWith('--'));
  let base = 'HEAD';
  if (!archivos.length) {
    try {
      const r = require('./staged-content.cjs').git(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']);
      archivos = r.ok ? r.stdout.toString('utf8').split('\n').map((s) => s.trim()).filter(Boolean) : [];
      base = 'HEAD~1';
    } catch { archivos = []; }
  }
  const r = analizar(root, cambiosDe(root, archivos, { base }));
  console.log(args.includes('--json') ? JSON.stringify(r, null, 2) : formatear(r));
}
