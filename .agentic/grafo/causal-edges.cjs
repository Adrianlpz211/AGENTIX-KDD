/**
 * Agentic KDD — Causal Edges v1.0
 * Gestión de edges causales y bi-temporales en el grafo semántico.
 *
 * TIPOS DE EDGE CAUSAL:
 *   caused_failure     — "tocar A provocó que B fallara"
 *   was_fixed_by       — "el fallo en B fue resuelto haciendo X"
 *   tested_by          — "A es cubierto por el test B"
 *   regressed_by       — "el cambio C introdujo una regresión en D"
 *   depends_on_decision — "la implementación E depende de la decisión ADR-001"
 *
 * EDGES BI-TEMPORALES:
 *   Cada edge tiene valid_at / invalid_at para "olvidar inteligente sin drift"
 *   Inspirado en Zep/Graphiti (arXiv 2501.13956)
 *
 * Uso:
 *   node .agentic/grafo/causal-edges.cjs add caused_failure src/auth.ts src/session.ts
 *   node .agentic/grafo/causal-edges.cjs query caused_failure
 *   node .agentic/grafo/causal-edges.cjs invalidate <id>
 *   node .agentic/grafo/causal-edges.cjs history src/auth.ts
 */

'use strict';

const path = require('path');
const fs   = require('fs');

const CAUSAL_TYPES = new Set([
  'caused_failure',
  'was_fixed_by',
  'tested_by',
  'regressed_by',
  'depends_on_decision',
  // Tipos estructurales existentes (compatibilidad)
  'depende_de', 'importa', 'usa', 'extiende', 'llama', 'define',
]);

// ─── DB HELPER ────────────────────────────────────────────────────────────────

function openDB(projectRoot) {
  const dbPath = path.join(projectRoot, '.agentic/memoria.db');
  try { return new (require('better-sqlite3'))(dbPath); } catch {}
  try { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(dbPath); } catch {}
  throw new Error('No SQLite driver disponible');
}

// ─── MIGRACIÓN BI-TEMPORAL ────────────────────────────────────────────────────

/**
 * Agrega columnas bi-temporales a relaciones_semanticas si no existen.
 * Safe de correr múltiples veces.
 */
function migrateRelacionesBiTemporal(db) {
  const cols = db.prepare("PRAGMA table_info(relaciones_semanticas)").all().map(c => c.name);

  const migrations = [
    { col: 'valid_at',    sql: "ALTER TABLE relaciones_semanticas ADD COLUMN valid_at TEXT DEFAULT (datetime('now'))" },
    { col: 'invalid_at',  sql: "ALTER TABLE relaciones_semanticas ADD COLUMN invalid_at TEXT" },
    { col: 'expired_at',  sql: "ALTER TABLE relaciones_semanticas ADD COLUMN expired_at TEXT" },
    { col: 'episode_id',  sql: "ALTER TABLE relaciones_semanticas ADD COLUMN episode_id TEXT" },
    { col: 'confidence',  sql: "ALTER TABLE relaciones_semanticas ADD COLUMN confidence TEXT DEFAULT 'MEDIA'" },
    { col: 'context',     sql: "ALTER TABLE relaciones_semanticas ADD COLUMN context TEXT" },
    { col: 'source',      sql: "ALTER TABLE relaciones_semanticas ADD COLUMN source TEXT DEFAULT 'agent'" },
  ];

  let migrated = 0;
  for (const m of migrations) {
    if (!cols.includes(m.col)) {
      try { db.exec(m.sql); migrated++; } catch (e) {
        if (!e.message.includes('duplicate column')) throw e;
      }
    }
  }

  // Crear índices para bi-temporalidad
  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_rel_sem_valid ON relaciones_semanticas(valid_at);
      CREATE INDEX IF NOT EXISTS idx_rel_sem_invalid ON relaciones_semanticas(invalid_at);
      CREATE INDEX IF NOT EXISTS idx_rel_sem_type ON relaciones_semanticas(tipo);
    `);
  } catch {}

  return migrated;
}

// ─── CREAR EDGE CAUSAL ────────────────────────────────────────────────────────

/**
 * Registra un edge causal en el grafo semántico.
 *
 * @param {object} db
 * @param {object} opts
 *   desde_entidad: string — entidad origen (archivo, módulo, símbolo)
 *   tipo: string — uno de CAUSAL_TYPES
 *   hacia_entidad: string — entidad destino
 *   peso: number (default 1.0)
 *   descripcion: string — por qué existe este edge
 *   episode_id: string — FK al episodio origen
 *   confidence: string — BAJA | MEDIA | ALTA
 *   context: string — contexto adicional
 * @returns {object} el edge creado
 */
function addCausalEdge(db, opts) {
  const {
    desde_entidad,
    tipo,
    hacia_entidad,
    peso = 1.0,
    descripcion = '',
    episode_id = null,
    confidence = 'MEDIA',
    context = null,
  } = opts;

  if (!CAUSAL_TYPES.has(tipo)) {
    throw new Error(`Tipo de edge no válido: '${tipo}'. Válidos: ${[...CAUSAL_TYPES].join(', ')}`);
  }

  // Si ya existe un edge activo del mismo tipo, invalidar el anterior (bi-temporalidad)
  try {
    const existing = db.prepare(`
      SELECT id FROM relaciones_semanticas
      WHERE desde_entidad = ? AND tipo = ? AND hacia_entidad = ?
        AND (invalid_at IS NULL OR invalid_at = '')
    `).get(desde_entidad, tipo, hacia_entidad);

    if (existing) {
      db.prepare(`
        UPDATE relaciones_semanticas
        SET invalid_at = datetime('now'), expired_at = datetime('now')
        WHERE id = ?
      `).run(existing.id);
    }
  } catch {}

  // Insertar nuevo edge
  let result;
  try {
    result = db.prepare(`
      INSERT INTO relaciones_semanticas
        (desde_entidad, tipo, hacia_entidad, peso, descripcion,
         valid_at, episode_id, confidence, context, source)
      VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, 'agent')
    `).run(desde_entidad, tipo, hacia_entidad, peso, descripcion, episode_id, confidence, context);
  } catch (e) {
    // Si no existen columnas bi-temporales, insertar sin ellas
    result = db.prepare(`
      INSERT OR REPLACE INTO relaciones_semanticas
        (desde_entidad, tipo, hacia_entidad, peso, descripcion)
      VALUES (?, ?, ?, ?, ?)
    `).run(desde_entidad, tipo, hacia_entidad, peso, descripcion);
  }

  return {
    id: result.lastInsertRowid,
    desde_entidad, tipo, hacia_entidad, peso, descripcion, confidence,
  };
}

// ─── INVALIDAR EDGE (olvidar inteligente) ────────────────────────────────────

/**
 * Invalida un edge sin borrarlo — preserva el historial (modelo Graphiti).
 * El edge invalidado ya no aparece en queries sin --history.
 */
function invalidateEdge(db, edgeId, reason = '') {
  try {
    db.prepare(`
      UPDATE relaciones_semanticas
      SET invalid_at = datetime('now'),
          expired_at = datetime('now'),
          context = COALESCE(context, '') || ' | Invalidado: ' || ?
      WHERE id = ?
    `).run(reason, edgeId);
    return true;
  } catch {
    return false;
  }
}

// ─── QUERY EDGES CAUSALES ────────────────────────────────────────────────────

/**
 * Obtiene edges causales activos (sin invalid_at) de una entidad.
 */
function queryCausalEdges(db, opts = {}) {
  const { tipo = null, entidad = null, includeHistory = false, limit = 50 } = opts;

  let query = `
    SELECT id, desde_entidad, tipo, hacia_entidad, peso, descripcion,
           valid_at, invalid_at, confidence, context, episode_id
    FROM relaciones_semanticas
    WHERE 1=1
  `;
  const params = [];

  if (!includeHistory) {
    query += " AND (invalid_at IS NULL OR invalid_at = '')";
  }

  if (tipo) {
    query += ' AND tipo = ?';
    params.push(tipo);
  }

  if (entidad) {
    query += ' AND (desde_entidad LIKE ? OR hacia_entidad LIKE ?)';
    params.push(`%${entidad}%`, `%${entidad}%`);
  }

  // Solo tipos causales si no se especifica tipo
  if (!tipo) {
    const causalList = ['caused_failure', 'was_fixed_by', 'tested_by', 'regressed_by', 'depends_on_decision'];
    query += ` AND tipo IN (${causalList.map(() => '?').join(',')})`;
    params.push(...causalList);
  }

  query += ` ORDER BY valid_at DESC LIMIT ${limit}`;

  try {
    return db.prepare(query).all(...params);
  } catch {
    return [];
  }
}

// ─── HISTORIAL DE UNA ENTIDAD ────────────────────────────────────────────────

/**
 * Retorna el historial bi-temporal completo de una entidad.
 * Incluye todos los edges pasados y presentes, con timestamps.
 */
function getEntityHistory(db, entidad) {
  try {
    return db.prepare(`
      SELECT id, desde_entidad, tipo, hacia_entidad, peso, descripcion,
             valid_at, invalid_at, expired_at, confidence, context, episode_id
      FROM relaciones_semanticas
      WHERE desde_entidad LIKE ? OR hacia_entidad LIKE ?
      ORDER BY valid_at DESC
    `).all(`%${entidad}%`, `%${entidad}%`);
  } catch { return []; }
}

// ─── POINT-IN-TIME QUERY ─────────────────────────────────────────────────────

/**
 * "¿Qué sabíamos sobre X en la fecha Y?"
 * Retorna edges que eran vigentes en ese momento.
 */
function getEdgesAtTime(db, entidad, timestamp) {
  try {
    return db.prepare(`
      SELECT id, desde_entidad, tipo, hacia_entidad, descripcion, confidence
      FROM relaciones_semanticas
      WHERE (desde_entidad LIKE ? OR hacia_entidad LIKE ?)
        AND valid_at <= ?
        AND (invalid_at IS NULL OR invalid_at > ?)
      ORDER BY valid_at DESC
    `).all(`%${entidad}%`, `%${entidad}%`, timestamp, timestamp);
  } catch { return []; }
}

// ─── EXTRAER CAUSALES DE EPISODIO ─────────────────────────────────────────────

/**
 * Dada la info de un episodio de error + fix, extrae automáticamente
 * los edges causales implícitos.
 *
 * @param {object} episodio
 *   tipo: 'error' | 'fix'
 *   descripcion: string
 *   archivos_tocados: string[] (JSON)
 *   resultado: 'resuelto' | 'fallo' | ...
 *   accion_tomada: string
 * @returns {Array<object>} edges causales sugeridos
 */
function extractCausalsFromEpisode(episodio) {
  const suggested = [];
  const archivos = JSON.parse(episodio.archivos_tocados || '[]');

  if (episodio.tipo === 'error' && episodio.resultado === 'resuelto') {
    // El episodio documenta un error que se resolvió
    // Inferir: el archivo tocado "caused_failure" en el módulo afectado
    for (const file of archivos) {
      if (episodio.descripcion) {
        suggested.push({
          desde_entidad: file,
          tipo: 'caused_failure',
          hacia_entidad: episodio.modulo || episodio.area || 'unknown',
          descripcion: episodio.descripcion.substring(0, 200),
          episode_id: episodio.episodio_id,
          confidence: 'MEDIA',
        });
      }
      if (episodio.accion_tomada) {
        suggested.push({
          desde_entidad: file,
          tipo: 'was_fixed_by',
          hacia_entidad: episodio.accion_tomada.substring(0, 100),
          descripcion: episodio.razon_resultado || '',
          episode_id: episodio.episodio_id,
          confidence: 'MEDIA',
        });
      }
    }
  }

  if (episodio.tipo === 'fix') {
    for (const file of archivos) {
      suggested.push({
        desde_entidad: file,
        tipo: 'was_fixed_by',
        hacia_entidad: episodio.accion_tomada?.substring(0, 100) || 'fix-applied',
        descripcion: episodio.descripcion?.substring(0, 200) || '',
        episode_id: episodio.episodio_id,
        confidence: 'ALTA',
      });
    }
  }

  return suggested;
}

// ─── ENRIQUECIMIENTO CON CODEBASE-MEMORY-MCP ─────────────────────────────────

/**
 * Llama a codebase-memory-mcp (puerto 9749) para enriquecer los edges causales
 * con datos reales del call-chain estructural del código.
 *
 * Retorna { added, skipped } si port 9749 está activo, o null si no está disponible.
 */
async function enrichWithCodeStructure(db, projectRoot, opts = {}) {
  const { port = 9749, module: moduleName, dryRun = false } = opts;
  const http = require('http');

  function fetchJSON(path) {
    return new Promise((resolve, reject) => {
      const req = http.get({ host: 'localhost', port, path, timeout: 3000 }, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
  }

  let graphData;
  try {
    graphData = await fetchJSON('/api/graph');
  } catch {
    return null; // codebase-memory-mcp no disponible — skip silencioso
  }

  if (!graphData || !graphData.edges) return null;

  const { edges: structEdges = [] } = graphData;
  let added = 0, skipped = 0;

  migrateRelacionesBiTemporal(db);

  for (const e of structEdges) {
    const { source, target, type = 'calls' } = e;
    if (!source || !target) continue;
    if (moduleName && !source.includes(moduleName) && !target.includes(moduleName)) {
      skipped++; continue;
    }

    // Mapear tipos estructurales de codebase-memory-mcp a CAUSAL_TYPES
    const tipoMapped = {
      'calls': 'llama',
      'imports': 'importa',
      'extends': 'extiende',
      'uses': 'usa',
      'defines': 'define',
    }[type] || 'usa';

    try {
      if (!dryRun) {
        addCausalEdge(db, {
          desde_entidad: source,
          tipo: tipoMapped,
          hacia_entidad: target,
          descripcion: `[codebase-memory] ${type} — structural call chain`,
          confidence: 'ALTA',
          context: 'codebase-memory-mcp',
          source: 'code-structure',
        });
      }
      added++;
    } catch { skipped++; }
  }

  return { added, skipped };
}

/**
 * Detecta cambios estructurales recientes consultando codebase-memory-mcp.
 * Retorna lista de archivos con su impacto downstream.
 */
async function detectStructuralChanges(port = 9749) {
  const http = require('http');
  return new Promise((resolve) => {
    const req = http.get({ host: 'localhost', port, path: '/api/changes', timeout: 3000 }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/**
 * Traza la ruta de llamadas entre dos entidades de código.
 * Retorna el path como array, o null si no disponible.
 */
async function traceCodePath(from, to, port = 9749) {
  const http = require('http');
  const encodedFrom = encodeURIComponent(from);
  const encodedTo = encodeURIComponent(to);
  return new Promise((resolve) => {
    const req = http.get(
      { host: 'localhost', port, path: `/api/trace?from=${encodedFrom}&to=${encodedTo}`, timeout: 4000 },
      res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const [,, cmd, ...args] = process.argv;
  const projectRoot = process.cwd();
  const db = openDB(projectRoot);

  // Migrar a bi-temporal si necesario
  const migrated = migrateRelacionesBiTemporal(db);
  if (migrated > 0) console.log(`[CAUSAL] Migradas ${migrated} columnas bi-temporales`);

  switch (cmd) {
    case 'add': {
      // add <tipo> <desde> <hacia> [descripcion]
      const [tipo, desde, hacia, ...descParts] = args;
      if (!tipo || !desde || !hacia) {
        console.error('Uso: causal-edges.cjs add <tipo> <desde> <hacia> [descripción]');
        process.exit(1);
      }
      try {
        const edge = addCausalEdge(db, { desde_entidad: desde, tipo, hacia_entidad: hacia, descripcion: descParts.join(' ') });
        console.log(`✅ Edge causal creado: [${edge.id}] ${desde} --${tipo}--> ${hacia}`);
      } catch (e) {
        console.error(`Error: ${e.message}`);
        process.exit(1);
      }
      break;
    }
    case 'query': {
      const [tipo, entidad] = args;
      const edges = queryCausalEdges(db, { tipo, entidad });
      console.log(`\nEdges causales (${edges.length}):\n`);
      edges.forEach(e => {
        const status = e.invalid_at ? '❌' : '✅';
        console.log(`  ${status} [${e.id}] ${e.desde_entidad} --${e.tipo}--> ${e.hacia_entidad}`);
        if (e.descripcion) console.log(`       ${e.descripcion}`);
      });
      break;
    }
    case 'history': {
      const [entidad] = args;
      if (!entidad) { console.error('Uso: causal-edges.cjs history <entidad>'); process.exit(1); }
      const history = getEntityHistory(db, entidad);
      console.log(`\nHistorial bi-temporal de '${entidad}' (${history.length} edges):\n`);
      history.forEach(e => {
        const status = e.invalid_at ? `[EXPIRADO ${e.invalid_at}]` : '[VIGENTE]';
        console.log(`  ${status} ${e.desde_entidad} --${e.tipo}--> ${e.hacia_entidad}`);
        console.log(`    valid_at: ${e.valid_at} | confidence: ${e.confidence || '-'}`);
      });
      break;
    }
    case 'invalidate': {
      const [id, ...reasonParts] = args;
      if (!id) { console.error('Uso: causal-edges.cjs invalidate <id> [razón]'); process.exit(1); }
      const ok = invalidateEdge(db, parseInt(id), reasonParts.join(' '));
      console.log(ok ? `✅ Edge ${id} invalidado (historial preservado)` : `Error invalidando edge ${id}`);
      break;
    }
    case 'migrate': {
      console.log(`Migración bi-temporal: ${migrated} columnas agregadas`);
      break;
    }
    case 'enrich': {
      // Enriquecer edges con datos de codebase-memory-mcp (puerto 9749)
      const module = args[0] || null;
      const dryRun = args.includes('--dry');
      console.log(`\n[CAUSAL] Enriqueciendo con codebase-memory-mcp${module ? ` (módulo: ${module})` : ''}${dryRun ? ' — dry-run' : ''}...`);
      enrichWithCodeStructure(db, projectRoot, { module, dryRun }).then(result => {
        if (!result) {
          console.log('  ⚠️  codebase-memory-mcp no disponible (puerto 9749). Skipping.');
          console.log('  → Abre codebase-memory-mcp-ui.exe para activar el análisis estructural.');
        } else {
          console.log(`  ✅ Edges estructurales: ${result.added} agregados, ${result.skipped} saltados`);
          if (dryRun) console.log('  (dry-run — no se escribió nada)');
        }
      });
      break;
    }
    case 'detect-changes': {
      console.log('\n[CAUSAL] Detectando cambios estructurales recientes...');
      detectStructuralChanges().then(changes => {
        if (!changes) {
          console.log('  ⚠️  codebase-memory-mcp no disponible (puerto 9749).');
        } else {
          console.log(`  Cambios detectados: ${JSON.stringify(changes, null, 2)}`);
        }
      });
      break;
    }
    case 'trace': {
      const [from, to] = args;
      if (!from || !to) { console.error('Uso: causal-edges.cjs trace <desde> <hasta>'); process.exit(1); }
      console.log(`\n[CAUSAL] Trazando ruta: ${from} → ${to}...`);
      traceCodePath(from, to).then(path => {
        if (!path) {
          console.log('  ⚠️  No disponible o sin ruta encontrada.');
        } else {
          console.log(`  Ruta: ${JSON.stringify(path, null, 2)}`);
        }
      });
      break;
    }
    default:
      console.log('Uso: node causal-edges.cjs [add | query | history | invalidate | migrate | enrich | detect-changes | trace]');
  }
}

module.exports = {
  addCausalEdge,
  invalidateEdge,
  queryCausalEdges,
  getEntityHistory,
  getEdgesAtTime,
  extractCausalsFromEpisode,
  enrichWithCodeStructure,
  detectStructuralChanges,
  traceCodePath,
  migrateRelacionesBiTemporal,
  CAUSAL_TYPES,
};

// ─── v1.1: CAUSAL EDGE PRUNING ────────────────────────────────────────────────
// Cierra el gap de "escalado exponencial" del grafo causal.
// Sin pruning, las queries fuerzan al agente a cargar cadenas completas de
// dependencias → colapso de contexto (arXiv 2603.17787).

const MAX_EDGES_PER_ENTITY    = 50;  // máx edges por entidad
const MIN_CONFIDENCE_TO_KEEP  = 0.3; // confidence < 0.3 → candidato a prune
const PRUNE_AGE_DAYS          = 180; // edges > 180 días sin acceso → archivar

/**
 * Prune semántico de edges causales.
 * Mantiene: edges recientes + alta confianza + tipos críticos.
 * Archiva: edges viejos de baja confianza.
 */
function pruneEdges(db, options = {}) {
  const maxPerEntity = options.maxPerEntity || MAX_EDGES_PER_ENTITY;
  const minConf      = options.minConfidence || MIN_CONFIDENCE_TO_KEEP;
  const ageDays      = options.ageDays || PRUNE_AGE_DAYS;
  const results      = { archived: 0, pruned: 0 };

  try {
    // 1. Invalidar edges de baja confianza muy viejos
    const old = db.prepare(`
      SELECT id FROM relaciones_semanticas
      WHERE tipo IN ('caused_failure','was_fixed_by','tested_by','regressed_by')
        AND (invalid_at IS NULL OR invalid_at = '')
        AND (confidence IS NULL OR (CASE confidence
              WHEN 'ALTA' THEN 1.0 WHEN 'MEDIA' THEN 0.5 WHEN 'BAJA' THEN 0.2
              ELSE COALESCE(CAST(confidence AS REAL), 0) END) < ?)
        AND julianday('now') - julianday(COALESCE(valid_at, datetime('now'))) > ?
    `).all(minConf, ageDays);

    old.forEach(r => {
      try {
        db.prepare(`
          UPDATE relaciones_semanticas
          SET invalid_at = datetime('now'),
              expired_at = datetime('now')
          WHERE id = ?
        `).run(r.id);
        results.archived++;
      } catch {}
    });

    // 2. Por entidad: si tiene > maxPerEntity edges activos, eliminar los más viejos de menor confianza
    const entities = db.prepare(`
      SELECT DISTINCT desde_entidad FROM relaciones_semanticas
      WHERE tipo IN ('caused_failure','was_fixed_by','tested_by','regressed_by')
        AND (invalid_at IS NULL OR invalid_at = '')
    `).all();

    for (const { desde_entidad } of entities) {
      const edgeCount = db.prepare(`
        SELECT COUNT(*) as n FROM relaciones_semanticas
        WHERE desde_entidad = ?
          AND tipo IN ('caused_failure','was_fixed_by','tested_by','regressed_by')
          AND (invalid_at IS NULL OR invalid_at = '')
      `).get(desde_entidad)?.n || 0;

      if (edgeCount > maxPerEntity) {
        const excess = edgeCount - maxPerEntity;
        const toRemove = db.prepare(`
          SELECT id FROM relaciones_semanticas
          WHERE desde_entidad = ?
            AND tipo IN ('caused_failure','was_fixed_by','tested_by','regressed_by')
            AND (invalid_at IS NULL OR invalid_at = '')
          ORDER BY (CASE confidence
              WHEN 'ALTA' THEN 1.0 WHEN 'MEDIA' THEN 0.5 WHEN 'BAJA' THEN 0.2
              ELSE COALESCE(CAST(confidence AS REAL), 0) END) ASC, valid_at ASC
          LIMIT ?
        `).all(desde_entidad, excess);

        toRemove.forEach(r => {
          try {
            db.prepare(`
              UPDATE relaciones_semanticas
              SET invalid_at = datetime('now')
              WHERE id = ?
            `).run(r.id);
            results.pruned++;
          } catch {}
        });
      }
    }

  } catch (e) {
    console.error('[CAUSAL] Prune error:', e.message);
  }

  return results;
}

/**
 * Encapsular edges relacionados en un edge resumen.
 * Reduce la densidad del grafo agrupando múltiples edges del mismo par.
 */
function encapsulateEdges(db, fromEntity, toEntity) {
  try {
    const edges = db.prepare(`
      SELECT id, tipo, descripcion, confidence
      FROM relaciones_semanticas
      WHERE desde_entidad = ? AND hacia_entidad = ?
        AND (invalid_at IS NULL OR invalid_at = '')
      ORDER BY valid_at DESC
    `).all(fromEntity, toEntity);

    if (edges.length <= 3) return { encapsulated: false };

    const summary = `[ENCAPSULADO: ${edges.length} edges] ` +
      edges.slice(0, 3).map(e => `${e.tipo}: ${e.descripcion?.substring(0, 30)}`).join(' | ');

    // Invalidar todos los edges individuales
    edges.forEach(e => {
      try {
        db.prepare(`UPDATE relaciones_semanticas SET invalid_at=datetime('now') WHERE id=?`).run(e.id);
      } catch {}
    });

    // Crear edge resumen
    try {
      db.prepare(`
        INSERT INTO relaciones_semanticas
          (desde_entidad, tipo, hacia_entidad, descripcion, confidence, valid_at)
        VALUES (?, 'encapsulated_history', ?, ?, 'ALTA', datetime('now'))
      `).run(fromEntity, toEntity, summary);
    } catch {}

    return { encapsulated: true, count: edges.length };
  } catch (e) {
    return { encapsulated: false, error: e.message };
  }
}

/**
 * Stats del grafo causal.
 */
function getCausalStats(db) {
  try {
    const active   = db.prepare(`SELECT COUNT(*) as n FROM relaciones_semanticas WHERE tipo IN ('caused_failure','was_fixed_by','tested_by','regressed_by') AND (invalid_at IS NULL OR invalid_at='')`).get()?.n || 0;
    const inactive = db.prepare(`SELECT COUNT(*) as n FROM relaciones_semanticas WHERE invalid_at IS NOT NULL AND invalid_at != ''`).get()?.n || 0;
    const entities = db.prepare(`SELECT COUNT(DISTINCT desde_entidad) as n FROM relaciones_semanticas WHERE (invalid_at IS NULL OR invalid_at='')`).get()?.n || 0;

    return { active_edges: active, archived_edges: inactive, entities, needs_prune: active > (entities * MAX_EDGES_PER_ENTITY * 0.8) };
  } catch { return { active_edges: 0, archived_edges: 0, entities: 0, needs_prune: false }; }
}

// Exportar nuevas funciones
const _prevExports = module.exports || {};
module.exports = {
  ..._prevExports,
  pruneEdges,
  encapsulateEdges,
  getCausalStats,
  MAX_EDGES_PER_ENTITY,
};
