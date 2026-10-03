'use strict';

/**
 * Radio de impacto transitivo sobre el índice AST.
 *
 * Quién depende (directa o indirectamente) de los archivos cambiados, qué
 * contratos cuelgan de ellos, y qué parte de la respuesta NO está cubierta.
 * Compara rutas exactas (normalizadas), nunca subcadenas: "auth" no es
 * "oauth-helper".
 *
 * Cobertura: un archivo sin índice, con índice viejo (hash distinto), en un
 * lenguaje sin extractor o con imports dinámicos queda UNKNOWN. Un índice
 * parcial no demuestra bajo riesgo: si hay huecos, la severidad no puede ser
 * LOW, queda UNKNOWN.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pn = require('./path-norm.cjs');

const KINDS = ['IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'USES', 'USES_CLASS', 'CALLS'];
const LIMITES = { maxDepth: 8, maxNodes: 2000 };
const UMBRALES = { LOW: 3, MEDIUM: 10, HIGH: 20 };
const CON_EXTRACTOR = /\.(js|jsx|ts|tsx|mjs|cjs|py|go|rs|java|kts?|php|rb|sql|html?|css)$/i;
const DINAMICO = /\brequire\s*\(\s*(?!['"`])[^)\s]|\bimport\s*\(\s*(?!['"`])[^)\s]/;

const k = (f) => pn.clave(pn.norm(String(f || '')).replace(/^\.\//, ''));

function aristas(db) {
  const inversas = new Map();
  const indexados = new Map();
  try {
    const marcas = KINDS.map(() => '?').join(',');
    for (const e of db.prepare(`SELECT from_file, to_file FROM ast_edges WHERE to_file IS NOT NULL AND kind IN (${marcas})`).all(...KINDS)) {
      const a = k(e.to_file); const de = pn.norm(e.from_file);
      if (a === k(de)) continue;
      if (!inversas.has(a)) inversas.set(a, new Set());
      inversas.get(a).add(de);
      if (!indexados.has(k(de))) indexados.set(k(de), null);
    }
  } catch { return null; }
  try {
    for (const r of db.prepare('SELECT file, MAX(content_hash) AS h FROM ast_symbols GROUP BY file').all()) indexados.set(k(r.file), r.h || null);
  } catch { /* sin tabla de símbolos: todo queda sin índice */ }
  return { inversas, indexados };
}

/** BFS hacia atrás (quién me usa) con visitados y límites. */
function cierre(grafo, archivos, limites) {
  const lim = Object.assign({}, LIMITES, limites);
  const visto = new Map();
  let cola = [];
  for (const f of archivos) { const n = pn.norm(f); if (!visto.has(k(n))) { visto.set(k(n), { file: n, depth: 0, via: null }); cola.push(n); } }
  let truncado = null;
  for (let d = 0; cola.length; d++) {
    const siguiente = [];
    for (const f of cola) {
      const deps = grafo.inversas.get(k(f));
      if (!deps) continue;
      if (d >= lim.maxDepth) { truncado = truncado || 'MAX_DEPTH'; continue; }
      for (const dep of deps) {
        if (visto.has(k(dep))) continue;
        if (visto.size >= lim.maxNodes) { truncado = 'MAX_NODES'; break; }
        visto.set(k(dep), { file: dep, depth: d + 1, via: f });
        siguiente.push(dep);
      }
    }
    cola = siguiente;
  }
  return { nodos: [...visto.values()], truncado };
}

function cobertura(root, grafo, nodos) {
  const unknown = [];
  const stale = [];
  for (const n of nodos) {
    const abs = path.join(root, n.file);
    let contenido = null;
    try { contenido = fs.readFileSync(abs, 'utf8'); } catch { /* borrado o ilegible */ }
    if (!CON_EXTRACTOR.test(n.file)) { unknown.push({ file: n.file, reason: 'LENGUAJE_SIN_COBERTURA' }); continue; }
    if (!grafo.indexados.has(k(n.file))) { unknown.push({ file: n.file, reason: contenido == null ? 'NO_EXISTE' : 'SIN_INDICE' }); continue; }
    const h = grafo.indexados.get(k(n.file));
    if (contenido != null && h && crypto.createHash('sha256').update(contenido).digest('hex') !== h) stale.push(n.file);
    if (contenido != null && DINAMICO.test(contenido)) unknown.push({ file: n.file, reason: 'IMPORT_DINAMICO' });
  }
  return { unknown, stale };
}

function archivosDeContrato(c) {
  let fuentes = [];
  try { fuentes = JSON.parse(c.source_files || '[]'); } catch { /* columna vacía o vieja */ }
  return [c.test_file, ...fuentes].filter(Boolean);
}

/**
 * Vecinos directos de cada archivo: quién lo usa (callers) y qué usa
 * (callees), con tope. Es lo que el paquete de contexto entrega, en vez del
 * cierre transitivo entero. Sin índice → fuente 'sin_indice', listas vacías.
 */
function vecinos(db, archivos, { max = 8 } = {}) {
  const out = {};
  let ok = true;
  for (const f of archivos || []) {
    const n = pn.norm(String(f)).replace(/^\.\//, '');
    try {
      const marcas = KINDS.map(() => '?').join(',');
      const callers = db.prepare(`SELECT DISTINCT from_file AS f FROM ast_edges WHERE to_file = ? AND kind IN (${marcas}) LIMIT ?`).all(n, ...KINDS, max + 1).map((r) => pn.norm(r.f)).filter((x) => k(x) !== k(n));
      const callees = db.prepare(`SELECT DISTINCT to_file AS f FROM ast_edges WHERE from_file = ? AND to_file IS NOT NULL AND kind IN (${marcas}) LIMIT ?`).all(n, ...KINDS, max + 1).map((r) => pn.norm(r.f)).filter((x) => k(x) !== k(n));
      out[n] = { callers: callers.slice(0, max), callees: callees.slice(0, max), truncado: callers.length > max || callees.length > max };
    } catch { ok = false; out[n] = { callers: [], callees: [], truncado: false }; }
  }
  return { fuente: ok ? 'ast' : 'sin_indice', archivos: out };
}

/**
 * → { status: PASS|WARN|STOP|ERROR, severity: LOW|MEDIUM|HIGH|CRITICAL|UNKNOWN,
 *     affected, contracts, coverage: { unknown, stale, truncated }, complete }
 */
function analizar(db, root, archivos, opciones) {
  const o = opciones || {};
  const grafo = db ? aristas(db) : null;
  if (!grafo) return { status: 'ERROR', reason_code: 'AST_INDEX_UNAVAILABLE', severity: 'UNKNOWN', affected: [], contracts: [], complete: false,
    coverage: { unknown: archivos.map((f) => ({ file: f, reason: 'SIN_INDICE' })), stale: [], truncated: null } };
  const { nodos, truncado } = cierre(grafo, archivos, o.limites);
  const cov = cobertura(root, grafo, nodos);
  const claves = new Set(nodos.map((n) => k(n.file)));
  const contracts = (o.contracts || []).filter((c) => archivosDeContrato(c).some((f) => claves.has(k(f))));
  const completo = !truncado && !cov.unknown.length && !cov.stale.length;
  const n = contracts.length;
  let severity = n <= UMBRALES.LOW ? 'LOW' : n <= UMBRALES.MEDIUM ? 'MEDIUM' : n <= UMBRALES.HIGH ? 'HIGH' : 'CRITICAL';
  if (severity === 'LOW' && !completo) severity = 'UNKNOWN';
  return {
    status: severity === 'CRITICAL' ? 'STOP' : (completo && severity === 'LOW' ? 'PASS' : 'WARN'),
    reason_code: severity === 'CRITICAL' ? 'BLAST_CRITICAL' : (!completo ? 'PARTIAL_COVERAGE' : null),
    severity, affected: nodos, contracts, complete: completo,
    coverage: { unknown: cov.unknown, stale: cov.stale, truncated: truncado },
  };
}

module.exports = { analizar, cierre, aristas, vecinos, LIMITES, UMBRALES };
