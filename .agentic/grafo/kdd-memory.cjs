/**
 * Agentic KDD — KDD Memory Server v1.0
 * BM25 + vector hybrid ranked retrieval over .agentic/memoria/*.md + SQLite
 *
 * LA MAYOR PALANCA hacia L4.
 *
 * El problema actual: los agentes leen errores.md, patrones.md, decisiones.md
 * COMPLETOS en cada ciclo. Con proyectos de 6+ meses eso son miles de tokens
 * de contexto sin ranking. El agente no sabe qué es más relevante.
 *
 * La solución: recall(query, top_k) devuelve los K fragmentos más relevantes
 * rankeados por BM25 (léxico) + vector similarity (semántico) con RRF fusion.
 * El agente consume 50-200 tokens en vez de 5.000-20.000.
 *
 * Implementa:
 *   - BM25 via SQLite FTS5 (léxico — ideal para nombres de funciones, errores exactos)
 *   - Vector similarity via embeddings existentes de Agentic KDD (semántico)
 *   - Reciprocal Rank Fusion (RRF) para combinar ambos rankings
 *   - Temporal decay: entradas más recientes tienen mayor peso
 *   - Trust scoring: nodos HIGH > MEDIUM > LOW confidence
 *   - remember(entry) con validación antes de escribir
 *
 * Referencias:
 *   - Basic Memory (~3.3k ★): markdown-native BM25+vector hybrid
 *   - memweave: FTS5 + sqlite-vec, 0.7×vector + 0.3×BM25, temporal decay
 *   - context-mode: BM25-only, headings 5× weight
 *   - QMD (Tobi Lütke): BM25 + vector + reranking RRF
 *
 * Uso:
 *   node kdd-memory.cjs recall "error de autenticación JWT" --top 10
 *   node kdd-memory.cjs remember "pattern: usar siempre bcrypt para passwords" --area auth
 *   node kdd-memory.cjs stats
 *   node kdd-memory.cjs index    — re-indexar todos los archivos markdown
 */

'use strict';

const path  = require('path');
const fs    = require('fs');
const crypto= require('crypto');

const VECTOR_WEIGHT = 0.65;  // peso del retrieval semántico
const BM25_WEIGHT   = 0.35;  // peso del retrieval léxico
const K_RRF         = 60;    // constante RRF estándar
const DECAY_LAMBDA  = 0.05;  // decay temporal (misma que MemCurator)
const HIGH_BOOST    = 1.5;   // multiplicador para nodos HIGH confidence
const HEADING_BOOST = 3.0;   // multiplicador para matches en títulos/headings

// ─── DB ───────────────────────────────────────────────────────────────────────

function openDB(projectRoot, opciones) {
  const dbPath = path.join(projectRoot, '.agentic/memoria.db');
  if (!fs.existsSync(dbPath)) return null;
  try {
    const dba = require('./db-adapter.cjs');
    return opciones && opciones.write ? dba.openWrite(dbPath) : dba.openReadOnly(dbPath);
  } catch {
    return null;
  }
}

function traza() {
  try { return require('./telemetry.cjs'); } catch { return null; }
}

function syncFTS(db) {
  try {
    db.exec("DELETE FROM nodos_fts");
    const nodes = db.prepare(
      "SELECT id, titulo, contenido, area, tipo FROM nodos WHERE estado='ACTIVO' LIMIT 5000"
    ).all();
    const insert = db.prepare("INSERT INTO nodos_fts(id, titulo, contenido, area, tipo) VALUES (?, ?, ?, ?, ?)");
    nodes.forEach(n => {
      try { insert.run(n.id, n.titulo || '', n.contenido || '', n.area || '', n.tipo || ''); } catch {}
    });
    return nodes.length;
  } catch { return 0; }
}

// ─── TÉRMINOS ────────────────────────────────────────────────────────────────

const VACIAS = new Set(('the and for with from that this into los las del por para con una uno unos unas que como sus este esta ' +
  'estos estas pero sin sobre entre cuando donde todo toda todos todas hay ser son fue han hace hacer el la de en un y o a al se lo le').split(' '));

function terminos(query) {
  const out = [];
  for (const w of String(query || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9_]+/)) {
    if (w.length >= 3 && !VACIAS.has(w) && !out.includes(w)) out.push(w);
    if (out.length >= 16) break;
  }
  return out;
}

/** Sin índice FTS: coincidencia de términos sobre los nodos activos, en lectura. */
function lexicoSinFts(db, query, topK) {
  const ts = terminos(query);
  if (!ts.length) return [];
  let filas = [];
  try { filas = db.prepare("SELECT id, titulo, contenido, area, tipo FROM nodos WHERE estado = 'ACTIVO' LIMIT 5000").all(); } catch { return []; }
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return filas
    .map((r) => {
      const t = norm(r.titulo); const c = norm(r.contenido);
      const score = ts.reduce((s, w) => s + (t.includes(w) ? HEADING_BOOST : 0) + (c.includes(w) ? 1 : 0), 0);
      return { ...r, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((r, idx) => ({ id: r.id, titulo: r.titulo, area: r.area, tipo: r.tipo, bm25_rank: idx + 1 }));
}

// ─── BM25 SEARCH ─────────────────────────────────────────────────────────────
/**
 * BM25 via SQLite FTS5. Ideal para:
 *   - Nombres exactos de funciones/archivos
 *   - Mensajes de error específicos
 *   - Identificadores de código
 */
function bm25Search(db, query, topK = 20) {
  if (!query || !db) return [];

  try {
    // Términos sueltos con OR: una tarea larga no tiene que aparecer entera.
    const sanitized = terminos(query).map((t) => `"${t}"`).join(' OR ');

    if (!sanitized) return [];

    const results = db.prepare(`
      SELECT
        id,
        titulo,
        contenido,
        area,
        tipo,
        bm25(nodos_fts) as bm25_score
      FROM nodos_fts
      WHERE nodos_fts MATCH ?
      ORDER BY bm25_score
      LIMIT ?
    `).all(sanitized, topK * 2);

    // BM25 en SQLite: scores más negativos = más relevantes (invertir)
    const maxScore = results.length > 0 ? Math.abs(Math.min(...results.map(r => r.bm25_score))) : 1;

    return results.map((r, idx) => ({
      id:        r.id,
      titulo:    r.titulo,
      contenido: r.contenido?.substring(0, 200),
      area:      r.area,
      tipo:      r.tipo,
      bm25_rank: idx + 1,
      bm25_score: Math.abs(r.bm25_score) / (maxScore || 1),
    }));
  } catch { return []; }
}

// ─── VECTOR SEARCH ───────────────────────────────────────────────────────────
/**
 * Búsqueda semántica via embeddings existentes.
 * Usa el módulo embeddings.cjs de Agentic KDD.
 */
async function vectorSearch(db, query, projectRoot, topK = 20) {
  if (!db || !query) return [];

  try {
    const embeddingsModule = require(path.join(projectRoot, '.agentic/grafo/embeddings.cjs'));
    const queryEmbedding = await embeddingsModule.embed(query, projectRoot);

    if (!queryEmbedding) return []; // embeddings no disponibles, fallback a BM25

    // Obtener nodos con embeddings almacenados
    const nodes = db.prepare(`
      SELECT id, titulo, contenido, area, tipo, confianza, embedding, aplicado, fecha_update
      FROM nodos
      WHERE estado = 'ACTIVO' AND embedding IS NOT NULL
      LIMIT 2000
    `).all();

    const scored = [];
    for (const node of nodes) {
      try {
        const nodeEmbed = typeof node.embedding === 'string'
          ? JSON.parse(node.embedding) : node.embedding;
        if (!nodeEmbed || !Array.isArray(nodeEmbed)) continue;

        const score = embeddingsModule.cosineSim(queryEmbedding, nodeEmbed);
        if (score > 0.2) { // threshold mínimo
          scored.push({ ...node, vector_score: score });
        }
      } catch {}
    }

    scored.sort((a, b) => b.vector_score - a.vector_score);
    return scored.slice(0, topK).map((n, idx) => ({
      id:           n.id,
      titulo:       n.titulo,
      contenido:    n.contenido?.substring(0, 200),
      area:         n.area,
      tipo:         n.tipo,
      confianza:    n.confianza,
      aplicado:     n.aplicado,
      fecha_update: n.fecha_update,
      vector_rank:  idx + 1,
      vector_score: n.vector_score,
    }));
  } catch { return []; }
}

// ─── TEMPORAL DECAY ──────────────────────────────────────────────────────────

function computeDecay(fechaUpdate) {
  if (!fechaUpdate) return 0.5;
  const deltaDays = (Date.now() - new Date(fechaUpdate).getTime()) / (1000 * 60 * 60 * 24);
  return Math.exp(-DECAY_LAMBDA * deltaDays);
}

// ─── RRF FUSION ──────────────────────────────────────────────────────────────
/**
 * Reciprocal Rank Fusion — combina BM25 y vector rankings.
 * RRF(d) = Σ 1/(k + rank_i(d))
 * Aplicamos pesos: BM25_WEIGHT y VECTOR_WEIGHT
 * Plus: boost por confianza HIGH, decay temporal
 */
function rrfFusion(bm25Results, vectorResults, db, topK = 10) {
  const scores = {};
  const nodeData = {};

  // Procesar BM25 results
  bm25Results.forEach((r, idx) => {
    const rank = idx + 1;
    const rrf  = BM25_WEIGHT / (K_RRF + rank);
    scores[r.id] = (scores[r.id] || 0) + rrf;
    nodeData[r.id] = { ...nodeData[r.id], ...r };
  });

  // Procesar vector results
  vectorResults.forEach((r, idx) => {
    const rank = idx + 1;
    const rrf  = VECTOR_WEIGHT / (K_RRF + rank);
    scores[r.id] = (scores[r.id] || 0) + rrf;
    nodeData[r.id] = { ...nodeData[r.id], ...r };
  });

  // Enriquecer con datos completos de DB y aplicar boosts
  if (db) {
    Object.keys(scores).forEach(id => {
      try {
        const node = db.prepare(
          "SELECT confianza, aplicado, util, fecha_update, vigencia_tipo FROM nodos WHERE id = ?"
        ).get(id);

        if (node) {
          nodeData[id] = { ...nodeData[id], ...node };

          // Boost por confianza
          const confBoost = node.confianza === 'ALTA' ? HIGH_BOOST
                          : node.confianza === 'MEDIA' ? 1.2 : 1.0;

          // Decay temporal
          const decay = computeDecay(node.fecha_update);

          // Boost por frecuencia de uso
          const usageBoost = 1 + Math.log(1 + (node.aplicado || 0)) * 0.1;

          // Penalizar HISTORICO/OBSOLETO
          const vigenciaPenalty = (node.vigencia_tipo === 'HISTORICO' || node.vigencia_tipo === 'OBSOLETO') ? 0.3 : 1.0;

          scores[id] *= confBoost * decay * usageBoost * vigenciaPenalty;
        }
      } catch {}
    });
  }

  // Ordenar por score final y retornar top K
  return Object.entries(scores)
    .sort(([, a], [, b]) => b - a)
    .slice(0, topK)
    .map(([id, score]) => ({
      ...nodeData[id],
      id,
      relevance_score: Math.round(score * 1000) / 1000,
      _debug: {
        bm25_rank: nodeData[id]?.bm25_rank,
        vector_rank: nodeData[id]?.vector_rank,
      },
    }));
}

// ─── RECALL — PUNTO DE ENTRADA PRINCIPAL ─────────────────────────────────────
/**
 * Recuperación ponderada. Reemplaza la lectura de archivos completos.
 * El agente llama recall() en vez de leer errores.md, patrones.md, etc.
 *
 * @param {string} query   Descripción de la tarea o error
 * @param {number} topK    Número de resultados (default 10)
 * @param {string} tipo    Filtrar por tipo (patron, error, decision, etc.)
 * @param {string} area    Filtrar por área
 */
async function recall(query, options = {}, projectRoot) {
  projectRoot = projectRoot || process.cwd();
  let salida;
  try {
    salida = await recallInterno(query, options, projectRoot);
  } catch (e) {
    const t = traza();
    if (t) t.recordMemoryRead(query, [], { error: e.message, via: options.via }, projectRoot);
    throw e;
  }
  const t = traza();
  if (t) t.recordMemoryRead(query, salida.results || [], { via: options.via, error: salida.source === 'unavailable' ? 'DB unavailable' : null }, projectRoot);
  return salida;
}

// ─── PRESUPUESTO, VIGENCIA Y CACHÉ (H32) ─────────────────────────────────────

const PRESUPUESTO_TOKENS = 1500;          // por llamada, salvo que se pida otro
const ESTIMACION = 'bytes/4';             // declarada: no es el tokenizador real
const RESUMEN_CHARS = 200;
const MIN_VECTOR_SOLO = 0.35;             // sin coincidencia léxica hace falta más similitud
const NO_APLICAR = new Set(['OBSOLETO', 'HISTORICO', 'SUPERSEDED']);
const cache = new Map();
const CACHE_MAX = 50;

const vigente = () => require('./memoria-vigente.cjs');
const costoTokens = (obj) => Math.ceil(Buffer.byteLength(JSON.stringify(obj), 'utf8') / 4);

/** Cambia con cualquier escritura en la base (archivo principal o WAL). */
function huellaGrafo(projectRoot) {
  const base = path.join(projectRoot, '.agentic', 'memoria.db');
  return ['', '-wal'].map((s) => { try { const st = fs.statSync(base + s); return `${st.mtimeMs}:${st.size}`; } catch { return '-'; } }).join('|');
}

function archivosDe(fila) {
  const v = fila.archivos_aplica;
  if (!v) return [];
  try { const a = JSON.parse(v); if (Array.isArray(a)) return a.map(String); } catch { /* lista separada por comas */ }
  return String(v).split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
}

function resumir(texto) {
  const t = String(texto || '').replace(/\s+/g, ' ').trim();
  return t.length > RESUMEN_CHARS ? t.slice(0, RESUMEN_CHARS - 1) + '…' : t;
}

async function recallInterno(query, options, projectRoot) {
  const { topK = 10, tipo = null, area = null, detalle = false } = options;
  const presupuesto = Number.isFinite(options.presupuestoTokens) ? options.presupuestoTokens : PRESUPUESTO_TOKENS;
  const excluir = new Set((options.excluir || []).map(String));

  const contexto = options.contexto || null;
  const huella = huellaGrafo(projectRoot);
  const clave = JSON.stringify([path.resolve(projectRoot), options.tenant || null, query, topK, tipo, area, detalle, presupuesto, [...excluir].sort(), contexto]);
  const enCache = cache.get(clave);
  if (enCache && enCache.huella === huella && !options.sinCache) {
    return { ...JSON.parse(enCache.salida), cache: 'hit' };
  }

  const db = openDB(projectRoot);
  if (!db) return { results: [], source: 'unavailable' };

  let salida;
  try {
    // Recall no crea el índice FTS (eso es el comando index). Sin él, la
    // búsqueda léxica se hace sobre los nodos en lectura.
    let hayFts = false;
    try { hayFts = !!db.prepare("SELECT 1 AS x FROM sqlite_master WHERE name = 'nodos_fts'").get(); } catch {}
    const bm25Results = hayFts ? bm25Search(db, query, topK * 2) : lexicoSinFts(db, query, topK * 2);
    const vectorResults = await vectorSearch(db, query, projectRoot, topK * 2);

    const lexicos = new Set(bm25Results.map((r) => String(r.id)));
    let candidatos = rrfFusion(bm25Results, vectorResults, db, topK * 3)
      .filter((r) => lexicos.has(String(r.id)) || (r.vector_score || 0) >= MIN_VECTOR_SOLO);

    let obsoletos = 0;
    let yaEntregados = 0;
    const filas = [];
    for (const r of candidatos) {
      let f = null;
      try { f = db.prepare('SELECT * FROM nodos WHERE id = ?').get(r.id); } catch {}
      if (!f) continue;
      const inactivo = f.estado !== 'ACTIVO' || NO_APLICAR.has(f.vigencia_tipo);
      const protegidoViejo = inactivo && f.estado !== 'ELIMINADO' && f.vigencia_tipo !== 'SUPERSEDED' && vigente().esProtegido(f);
      if (inactivo && !protegidoViejo) { obsoletos++; continue; }
      if (tipo && f.tipo !== tipo) continue;
      if (area && !String(f.area || '').toLowerCase().includes(String(area).toLowerCase())) continue;
      if (excluir.has(String(f.id))) { yaEntregados++; continue; }
      const item = {
        id: f.id,
        titulo: f.titulo,
        tipo: f.tipo,
        area: f.area,
        confianza: f.confianza || null,
        vigencia: f.vigencia_tipo || null,
        archivos: archivosDe(f),
        resumen: resumir(f.contenido),
        relevance_score: r.relevance_score,
      };
      if (f.vigencia_tipo === 'SOSPECHOSO' || protegidoViejo) item.verificar = true;
      if (contexto || protegidoViejo) {
        const v = vigente().evaluar(f, contexto || {});
        if (v.aplicable === 'NO') continue;
        item.aplicabilidad = v;
      }
      if (detalle) item.contenido = f.contenido;
      filas.push(item);
      if (filas.length >= topK) break;
    }

    const results = [];
    let usados = 0;
    for (const item of filas) {
      const c = costoTokens(item);
      if (usados + c > presupuesto) break;
      results.push(item);
      usados += c;
    }
    const omitidos = filas.length - results.length;

    salida = {
      results,
      query,
      source: results.length
        ? `${hayFts ? 'bm25' : 'lexico'}(${bm25Results.length}) + vector(${vectorResults.length}) → rrf`
        : 'sin_coincidencia',
      total_found: results.length,
      presupuesto: { tokens: presupuesto, usados, estimacion: ESTIMACION, truncado: omitidos > 0, omitidos },
      excluidos: { obsoletos, ya_entregados: yaEntregados },
      detalle: detalle ? 'incluido' : 'bajo demanda: detalle(id)',
    };
  } finally {
    try { db.close(); } catch {}
  }

  cache.set(clave, { huella, salida: JSON.stringify(salida) });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return { ...salida, cache: 'miss' };
}

/**
 * Detalle bajo demanda de un nodo: contenido completo y, si sus archivos tienen
 * descripción vigente en code-summaries, esa descripción. Lo obsoleto no se da.
 */
function detalle(id, projectRoot) {
  projectRoot = projectRoot || process.cwd();
  const db = openDB(projectRoot);
  if (!db) return { ok: false, reason: 'unavailable' };
  try {
    const f = db.prepare('SELECT * FROM nodos WHERE id = ?').get(id);
    if (!f) return { ok: false, reason: 'NO_EXISTE' };
    if (f.estado !== 'ACTIVO' || NO_APLICAR.has(f.vigencia_tipo)) return { ok: false, reason: 'NO_VIGENTE', vigencia: f.vigencia_tipo || f.estado };
    const archivos = archivosDe(f);
    const descripciones = {};
    try {
      const cs = require('./code-summaries.cjs');
      for (const a of archivos) { const d = cs.getFresh(a, projectRoot); if (d) descripciones[a] = d; }
    } catch { /* sin descripciones */ }
    return {
      ok: true, id: f.id, titulo: f.titulo, tipo: f.tipo, area: f.area, confianza: f.confianza,
      vigencia: f.vigencia_tipo || null, verificar: f.vigencia_tipo === 'SOSPECHOSO', archivos, contenido: f.contenido, descripciones,
    };
  } finally { try { db.close(); } catch {} }
}

// ─── REMEMBER — ESCRIBIR EN MEMORIA CON VALIDACIÓN ───────────────────────────
/**
 * Escribe una entrada en memoria con validación.
 * Antes de escribir verifica que no sea duplicado (similitud Jaccard > 0.85).
 * Agrega frontmatter de validación automáticamente.
 */
function remember(entry, options = {}, projectRoot) {
  projectRoot = projectRoot || process.cwd();
  const r = rememberInterno(entry, options, projectRoot);
  const t = traza();
  if (t) t.recordMemoryWrite(entry, r, { tipo: options.tipo, area: options.area, via: options.via }, projectRoot);
  return r;
}

function rememberInterno(entry, options, projectRoot) {
  const { tipo = 'patron', area = 'global', confianza = 'BAJA', archivos = [] } = options;

  const db = openDB(projectRoot, { write: true });
  if (!db) return { ok: false, error: 'DB unavailable' };

  // Identidad de la entrada y huella de los archivos a los que aplica son dos
  // cosas distintas: la primera evita duplicados, la segunda detecta contexto
  // cambiado. Las dos salen de memory-hash.cjs, el mismo que usa el validador.
  const mh = require('./memory-hash.cjs');
  const dedup = mh.dedupHash(entry, tipo, area);
  const hashCtx = mh.contextHash(archivos, projectRoot).hash;

  const integerId = db.all('PRAGMA table_info(nodos)').some(c => c.name === 'id' && /INTEGER/i.test(c.type));
  let id = integerId ? null : `${tipo}_${dedup.slice(3, 15)}`;

  // Verificar duplicado por similitud de texto
  const jaccardSim = (a, b) => {
    const sA = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
    const sB = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
    const inter = new Set([...sA].filter(x => sB.has(x)));
    const union = new Set([...sA, ...sB]);
    return union.size === 0 ? 0 : inter.size / union.size;
  };

  let isDuplicate = false;
  try {
    const existing = db.prepare(
      "SELECT titulo, contenido FROM nodos WHERE tipo = ? AND area = ? AND estado = 'ACTIVO' LIMIT 20"
    ).all(tipo, area);

    isDuplicate = existing.some(n =>
      jaccardSim(entry, (n.titulo || '') + ' ' + (n.contenido || '')) > 0.85
    );
  } catch {}

  if (isDuplicate) {
    db.close();
    return { ok: false, reason: 'duplicate', message: 'Entry too similar to existing knowledge — skipped' };
  }

  // Escribir en DB
  try {
    db.prepare(`
      INSERT OR REPLACE INTO nodos
        (id, tipo, titulo, contenido, area, confianza, estado, vigencia_tipo,
         hash_contexto, fecha_creacion, fecha_update, archivos_aplica)
      VALUES (?, ?, ?, ?, ?, ?, 'ACTIVO', 'VIGENTE', ?, datetime('now'), datetime('now'), ?)
    `).run(
      id, tipo,
      entry.substring(0, 100),  // titulo
      entry,                     // contenido completo
      area, confianza, hashCtx,
      JSON.stringify(archivos)
    );

    if (integerId) id = Number(db.get('SELECT last_insert_rowid() AS id').id);
    // Actualizar FTS
    try {
      db.prepare("INSERT OR REPLACE INTO nodos_fts(id, titulo, contenido, area, tipo) VALUES (?, ?, ?, ?, ?)")
        .run(id, entry.substring(0, 100), entry, area, tipo);
    } catch {}

    db.close();
    return { ok: true, id, hash: dedup, context_hash: hashCtx };
  } catch (e) {
    db.close();
    return { ok: false, error: e.message };
  }
}

// ─── INDEX — REINDEXAR ARCHIVOS MARKDOWN ─────────────────────────────────────
/**
 * Indexa (o re-indexa) todos los archivos .md de .agentic/memoria/
 * Útil al inicializar o cuando se editan archivos manualmente.
 */
function indexMarkdown(projectRoot) {
  projectRoot = projectRoot || process.cwd();
  const memoriaPath = path.join(projectRoot, '.agentic/memoria');

  if (!fs.existsSync(memoriaPath)) return { indexed: 0 };

  const db = openDB(projectRoot, { write: true });
  if (!db) return { indexed: 0 };

  let indexed = 0;
  const files = fs.readdirSync(memoriaPath).filter(f => f.endsWith('.md'));

  files.forEach(file => {
    try {
      const content = fs.readFileSync(path.join(memoriaPath, file), 'utf8');
      const area = path.basename(file, '.md');

      // Extraer entradas (bloques separados por ## o ***)
      const entries = content
        .split(/\n(?=##|\*{3}|\-{3})/)
        .map(block => block.trim())
        .filter(block => block.length > 20 && !block.startsWith('#!'));

      entries.forEach(entry => {
        const tipo = file.includes('error') ? 'error'
          : file.includes('patron') ? 'patron'
          : file.includes('decision') ? 'decision'
          : 'patron';

        // Detectar confianza por marcadores en el texto
        const confianza = /HIGH|ALTA|⭐⭐⭐/.test(entry) ? 'ALTA'
          : /MEDIA|MEDIUM|⭐⭐/.test(entry) ? 'MEDIA'
          : 'BAJA';

        const result = remember(entry, { tipo, area, confianza }, projectRoot);
        if (result.ok) indexed++;
      });
    } catch {}
  });

  // Re-sync FTS completo
  syncFTS(db);
  db.close();

  return { indexed, files: files.length };
}

// ─── STATS ────────────────────────────────────────────────────────────────────

function getStats(projectRoot) {
  const db = openDB(projectRoot || process.cwd());
  if (!db) return { error: 'DB unavailable' };

  const safe = (fn) => { try { return fn(); } catch { return null; } };

  const stats = {
    total_nodes:      safe(() => db.prepare("SELECT COUNT(*) as n FROM nodos WHERE estado='ACTIVO'").get()?.n) || 0,
    fts_indexed:      safe(() => db.prepare("SELECT COUNT(*) as n FROM nodos_fts").get()?.n) || 0,
    with_embeddings:  safe(() => db.prepare("SELECT COUNT(*) as n FROM nodos WHERE estado='ACTIVO' AND embedding IS NOT NULL").get()?.n) || 0,
    high_confidence:  safe(() => db.prepare("SELECT COUNT(*) as n FROM nodos WHERE estado='ACTIVO' AND confianza='ALTA'").get()?.n) || 0,
    retrieval_mode:   null,
  };

  // Determinar modo de retrieval disponible
  try {
    require(path.join(projectRoot || process.cwd(), '.agentic/grafo/embeddings.cjs'));
    stats.retrieval_mode = stats.with_embeddings > 0 ? 'hybrid_bm25_vector' : 'bm25_only';
  } catch {
    stats.retrieval_mode = 'bm25_only';
  }

  stats.sync_status = stats.fts_indexed >= stats.total_nodes * 0.9 ? 'synced' : 'needs_sync';
  stats.coverage_pct = stats.total_nodes > 0
    ? Math.round((stats.with_embeddings / stats.total_nodes) * 100) : 0;

  db.close();
  return stats;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const [,, cmd, ...args] = process.argv;
  const projectRoot = process.cwd();

  switch (cmd) {
    case 'recall': {
      const query = args.filter(a => !a.startsWith('--')).join(' ');
      const topK  = parseInt(args.find(a => a.startsWith('--top'))?.split('=')[1] || '10');
      const tipo  = args.find(a => a.startsWith('--tipo='))?.split('=')[1];

      if (!query) { console.log('Uso: kdd-memory.cjs recall "query" [--top=10] [--tipo=error|patron]'); break; }

      recall(query, { topK, tipo }, projectRoot).then(result => {
        console.log(`\n📚 KDD Memory Recall — "${query}"`);
        console.log(`   Source: ${result.source} | Found: ${result.total_found}`);
        if (result.presupuesto) {
          const p = result.presupuesto;
          console.log(`   Presupuesto: ${p.usados}/${p.tokens} tokens (${p.estimacion})${p.truncado ? ` — TRUNCADO, ${p.omitidos} omitidos` : ''}\n`);
        }
        if (!result.results.length) console.log('   Sin coincidencias: no se rellena con otras entradas.\n');
        result.results.forEach((r, i) => {
          const conf = r.confianza === 'ALTA' ? '⭐' : r.confianza === 'MEDIA' ? '○' : '·';
          console.log(`  ${i+1}. ${conf} [${r.tipo}] #${r.id} ${r.titulo?.substring(0,60)}${r.verificar ? '  (SOSPECHOSO: verificar)' : ''}`);
          console.log(`     Area: ${r.area} | Score: ${r.relevance_score}${r.archivos?.length ? ' | ' + r.archivos.join(', ') : ''}`);
          if (r.resumen) console.log(`     ${r.resumen}`);
          console.log('');
        });
      });
      break;
    }

    case 'remember': {
      const entry  = args.filter(a => !a.startsWith('--')).join(' ');
      const area   = args.find(a => a.startsWith('--area='))?.split('=')[1] || 'global';
      const tipo   = args.find(a => a.startsWith('--tipo='))?.split('=')[1] || 'patron';
      if (!entry) { console.log('Uso: kdd-memory.cjs remember "entry" [--area=global] [--tipo=patron]'); break; }
      const result = remember(entry, { tipo, area }, projectRoot);
      console.log(result.ok ? `✅ Stored: ${result.id}` : `❌ ${result.reason || result.error}`);
      break;
    }

    case 'index':
      const r = indexMarkdown(projectRoot);
      console.log(`✅ Indexed ${r.indexed} entries from ${r.files} markdown files`);
      break;

    case 'sync': {
      const db = openDB(projectRoot, { write: true });
      if (!db) { console.log('❌ DB unavailable'); break; }
      const n = syncFTS(db);
      db.close();
      console.log(`✅ FTS synced: ${n} nodes`);
      break;
    }

    case 'stats': {
      const s = getStats(projectRoot);
      console.log('\n📊 KDD Memory Stats');
      console.log(`   Total nodes:     ${s.total_nodes}`);
      console.log(`   FTS indexed:     ${s.fts_indexed} (${s.sync_status})`);
      console.log(`   With embeddings: ${s.with_embeddings} (${s.coverage_pct}% coverage)`);
      console.log(`   HIGH confidence: ${s.high_confidence}`);
      console.log(`   Retrieval mode:  ${s.retrieval_mode}\n`);
      break;
    }

    default:
      console.log('Uso: node kdd-memory.cjs [recall "query" | remember "entry" | index | sync | stats]');
  }
}

module.exports = { recall, detalle, remember, indexMarkdown, syncFTS, getStats, bm25Search, terminos, huellaGrafo, PRESUPUESTO_TOKENS };
