'use strict';

/**
 * Visita guiada lista al abrir el tablero: construcción mecánica, sin LLM
 * y sin escribir memoria.db. El cache vive en .agentic/_cache.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const builder = require('./tour-builder.cjs');

const GENERATOR_VERSION = '2.1';

function hashFuente(root) {
  const h = crypto.createHash('sha256');
  h.update(GENERATOR_VERSION);
  for (const rel of ['.agentic/memoria.db', '.agentic/memoria.db-wal', '.agentic/memoria.db-shm', '.agentic/tour.json']) {
    const p = path.join(root, rel);
    try { const st = fs.statSync(p); h.update(rel + st.size + ':' + st.mtimeMs); } catch { h.update(rel + '-'); }
  }
  return h.digest('hex').slice(0, 16);
}

function claveCache(root, opts) {
  const area = String((opts && opts.area) || '').trim().toLowerCase();
  return hashFuente(root) + '-' + crypto.createHash('sha256').update(area + '|' + GENERATOR_VERSION).digest('hex').slice(0, 8);
}

function cachePath(root, clave) {
  return path.join(root, '.agentic', '_cache', 'tour-' + clave + '.json');
}

function validar(tour) {
  if (!tour || typeof tour !== 'object') return false;
  if (!Array.isArray(tour.front) || !Array.isArray(tour.back)) return false;
  return true;
}

function construir(root, { area = null, writeCache = true } = {}) {
  const r = builder.build(root, area, 40, { write: false });
  if (r.error) return { status: r.error.includes('sin índice') || r.error.includes('AST') ? 'EMPTY' : 'UNAVAILABLE', reason_code: r.error, tour: null };
  const tour = Object.assign({ schema_version: 1, generator_version: GENERATOR_VERSION, source_hash: hashFuente(root) }, r.tour, {
    coverage: {
      total: r.tour.totalModules,
      shown: (r.tour.front || []).length + (r.tour.back || []).length,
      truncated: !!(r.tour.frontTruncated || r.tour.backTruncated),
    },
  });
  if (writeCache) {
    try {
      const dir = path.join(root, '.agentic', '_cache');
      fs.mkdirSync(dir, { recursive: true });
      const clave = claveCache(root, { area });
      const tmp = cachePath(root, clave) + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(Object.assign({}, tour, { cache_area: area || null })));
      fs.renameSync(tmp, cachePath(root, clave));
    } catch { /* cache es opcional */ }
  }
  return { status: (tour.front.length || tour.back.length) ? 'OK' : 'EMPTY', tour };
}

function obtener(root, opts) {
  const area = opts && opts.area;
  const clave = claveCache(root, { area });
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath(root, clave), 'utf8'));
    if (validar(raw) && raw.source_hash === hashFuente(root) && (raw.cache_area || null) === (area || null)) {
      return { status: (raw.front.length || raw.back.length) ? 'OK' : 'EMPTY', tour: raw, cache: true };
    }
  } catch { /* cache ausente o roto: se reconstruye */ }
  return construir(root, opts);
}

module.exports = { obtener, construir, hashFuente, claveCache, validar, GENERATOR_VERSION };
