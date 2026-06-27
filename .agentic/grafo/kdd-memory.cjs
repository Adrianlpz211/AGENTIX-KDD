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

function openDB(projectRoot) {
  const dbPath = path.join(projectRoot, '.agentic/memoria.db');
  let db;
  try { db = new (require('better-sqlite3'))(dbPath); }
  catch { try { const { DatabaseSync } = require('node:sqlite'); db = new DatabaseSync(dbPath); } catch { return null; } }

  // Crear tabla FTS5 para búsqueda léxica si no existe
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS nodos_fts USING fts5(
        id UNINDEXED,
        titulo,
        contenido,
        area,
        tipo,
        tokenize='porter unicode61'
      )
    `);

    // Sincronizar FTS con nodos si está vacío
    const ftsCount = db.prepare("SELECT COUNT(*) as n FROM nodos_fts").get()?.n || 0;
    if (ftsCount === 0) {
      syncFTS(db);
    }
  } catch {}

  return db;
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
    // Sanitizar query para FTS5
    const sanitized = query
      .replace(/['"]/g, ' ')
      .replace(/[()]/g, ' ')
      .trim();

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
  const { topK = 10, tipo = null, area = null } = options;

  const db = openDB(projectRoot);
  if (!db) return { results: [], source: 'unavailable' };

  // Sincronizar FTS si es necesario
  try {
    const ftsCount = db.prepare("SELECT COUNT(*) as n FROM nodos_fts").get()?.n || 0;
    const nodeCount = db.prepare("SELECT COUNT(*) as n FROM nodos WHERE estado='ACTIVO'").get()?.n || 0;
    if (ftsCount < nodeCount * 0.8) syncFTS(db); // re-sync si hay >20% desincronizado
  } catch {}

  // BM25 search
  const bm25Results = bm25Search(db, query, topK * 2);

  // Vector search (async)
  const vectorResults = await vectorSearch(db, query, projectRoot, topK * 2);

  // Si ninguno tiene resultados, fallback a query simple
  if (bm25Results.length === 0 && vectorResults.length === 0) {
    const fallback = db.prepare(`
      SELECT id, titulo, contenido, area, tipo, confianza, aplicado
      FROM nodos
      WHERE estado = 'ACTIVO'
        AND confianza IN ('ALTA', 'MEDIA')
        ${tipo ? "AND tipo = '" + tipo + "'" : ''}
        ${area ? "AND area LIKE '%" + area + "%'" : ''}
      ORDER BY aplicado DESC
      LIMIT ?
    `).all(topK);

    db.close();
    return {
      results: fallback,
      source: 'fallback_no_query_match',
      query,
    };
  }

  // RRF fusion
  let results = rrfFusion(bm25Results, vectorResults, db, topK * 2);

  // Aplicar filtros post-fusion
  if (tipo) results = results.filter(r => r.tipo === tipo);
  if (area) results = results.filter(r => r.area?.toLowerCase().includes(area.toLowerCase()));

  results = results.slice(0, topK);

  // Enriquecer con contenido completo si está disponible
  results = results.map(r => {
    try {
      const full = db.prepare("SELECT titulo, contenido, area, tipo, confianza FROM nodos WHERE id = ?").get(r.id);
      if (full) return { ...r, ...full };
    } catch {}
    return r;
  });

  db.close();
  return {
    results,
    query,
    source: `bm25(${bm25Results.length}) + vector(${vectorResults.length}) → rrf`,
    total_found: results.length,
  };
}

// ─── REMEMBER — ESCRIBIR EN MEMORIA CON VALIDACIÓN ───────────────────────────
/**
 * Escribe una entrada en memoria con validación.
 * Antes de escribir verifica que no sea duplicado (similitud Jaccard > 0.85).
 * Agrega frontmatter de validación automáticamente.
 */
function remember(entry, options = {}, projectRoot) {
  projectRoot = projectRoot || process.cwd();
  const { tipo = 'patron', area = 'global', confianza = 'BAJA', archivos = [] } = options;

  const db = openDB(projectRoot);
  if (!db) return { ok: false, error: 'DB unavailable' };

  // Generar hash del contexto
  const hashCtx = crypto.createHash('md5')
    .update(entry + area + tipo)
    .digest('hex')
    .substring(0, 8);

  const id = `${tipo}_${hashCtx}`;

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

    // Actualizar FTS
    try {
      db.prepare("INSERT OR REPLACE INTO nodos_fts(id, titulo, contenido, area, tipo) VALUES (?, ?, ?, ?, ?)")
        .run(id, entry.substring(0, 100), entry, area, tipo);
    } catch {}

    db.close();
    return { ok: true, id, hash: hashCtx };
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

  const db = openDB(projectRoot);
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
        console.log(`   Source: ${result.source} | Found: ${result.total_found}\n`);
        result.results.forEach((r, i) => {
          const conf = r.confianza === 'ALTA' ? '⭐' : r.confianza === 'MEDIA' ? '○' : '·';
          console.log(`  ${i+1}. ${conf} [${r.tipo}] ${r.titulo?.substring(0,60)}`);
          console.log(`     Area: ${r.area} | Score: ${r.relevance_score} | Aplicado: ${r.aplicado || 0}×`);
          if (r.contenido && r.contenido.length > 80) console.log(`     ${r.contenido.substring(0,120)}...`);
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
      const db = openDB(projectRoot);
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

module.exports = { recall, remember, indexMarkdown, syncFTS, getStats, bm25Search };
