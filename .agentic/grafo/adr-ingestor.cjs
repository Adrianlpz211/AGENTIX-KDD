/**
 * Agentic KDD — ADR/MADR Ingestor v1.0
 * Parsea ADRs (Architecture Decision Records) en formato MADR
 * y los convierte en edges tipados en el grafo de conocimiento.
 *
 * Por qué importa:
 *   El código explica QUÉ. Los ADRs explican POR QUÉ.
 *   Sin ADRs el agente no puede razonar sobre restricciones de diseño.
 *
 * Formato soportado: MADR (Markdown Any Decision Records)
 *   Frontmatter YAML + secciones fijas predecibles por máquina.
 *
 * Uso:
 *   node .agentic/grafo/adr-ingestor.cjs ingest [--dir docs/adr]
 *   node .agentic/grafo/adr-ingestor.cjs query [módulo]
 *   node .agentic/grafo/adr-ingestor.cjs show ADR-001
 *   node .agentic/grafo/adr-ingestor.cjs stats
 *   node .agentic/grafo/knowledge-ingestor.cjs ingest [--dir docs/gotchas]
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── DB ───────────────────────────────────────────────────────────────────────

function openDB(projectRoot) {
  const dbPath = path.join(projectRoot, '.agentic/memoria.db');
  try { return new (require('better-sqlite3'))(dbPath); } catch {}
  try { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(dbPath); } catch {}
  throw new Error('No SQLite driver disponible');
}

// ─── SCHEMA PARA KNOWLEDGE DOCS ──────────────────────────────────────────────

const KNOWLEDGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS knowledge_docs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id          TEXT NOT NULL UNIQUE,   -- ADR-001, GOTCHA-003, etc.
  tipo            TEXT NOT NULL,          -- adr | gotcha | convention | runbook
  titulo          TEXT NOT NULL,
  status          TEXT DEFAULT 'accepted', -- proposed | accepted | deprecated | superseded
  fecha           TEXT,
  decision_makers TEXT DEFAULT '[]',      -- JSON array
  afecta          TEXT DEFAULT '[]',      -- JSON array de rutas/módulos afectados
  frontmatter     TEXT DEFAULT '{}',      -- JSON completo del frontmatter
  contenido       TEXT,                   -- contenido completo del archivo
  -- Secciones MADR parseadas
  context         TEXT,                   -- Context and Problem Statement
  decision        TEXT,                   -- Decision Outcome
  consequences    TEXT,                   -- Consequences (good/bad)
  options         TEXT,                   -- Considered Options JSON
  -- Metadata
  file_path       TEXT,                   -- ruta del archivo fuente
  last_indexed    TEXT DEFAULT (datetime('now')),
  content_hash    TEXT
);
CREATE INDEX IF NOT EXISTS idx_kdocs_tipo ON knowledge_docs(tipo);
CREATE INDEX IF NOT EXISTS idx_kdocs_status ON knowledge_docs(status);
`;

function initKnowledgeSchema(db) {
  db.exec(KNOWLEDGE_SCHEMA);
}

// ─── PARSER FRONTMATTER ───────────────────────────────────────────────────────

/**
 * Parsea frontmatter YAML básico de un archivo markdown.
 * Soporta el subconjunto de YAML que usa MADR (strings, arrays, booleans).
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { frontmatter: {}, body: content };

  const raw = match[1];
  const frontmatter = {};
  const body = content.slice(match[0].length).trimStart();

  // Parsear línea por línea
  const lines = raw.split('\n');
  let currentKey = null;
  let inArray = false;

  for (const line of lines) {
    // Array item
    if (inArray && /^\s+-\s+(.+)/.test(line)) {
      const val = line.match(/^\s+-\s+(.+)/)[1].trim().replace(/^['"]|['"]$/g, '');
      if (!Array.isArray(frontmatter[currentKey])) frontmatter[currentKey] = [];
      frontmatter[currentKey].push(val);
      continue;
    }

    // Key: value
    const kvMatch = line.match(/^(\w[\w-]*)\s*:\s*(.*)/);
    if (!kvMatch) continue;

    currentKey = kvMatch[1];
    const rawVal = kvMatch[2].trim();

    if (rawVal === '' || rawVal === '[]') {
      frontmatter[currentKey] = [];
      inArray = true;
    } else if (rawVal.startsWith('[')) {
      // Inline array: [a, b, c]
      frontmatter[currentKey] = rawVal
        .replace(/[\[\]]/g, '')
        .split(',')
        .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
      inArray = false;
    } else {
      frontmatter[currentKey] = rawVal.replace(/^['"]|['"]$/g, '');
      inArray = false;
    }
  }

  return { frontmatter, body };
}

// ─── PARSER MADR ─────────────────────────────────────────────────────────────

/**
 * Parsea un archivo MADR y extrae sus secciones.
 * @param {string} content - contenido completo del archivo
 * @param {string} filePath - ruta del archivo
 * @returns {object} ADR estructurado
 */
function parseMADR(content, filePath) {
  const { frontmatter, body } = parseFrontmatter(content);

  // Extraer ID del nombre de archivo (ADR-001-titulo.md → ADR-001)
  const fileName = path.basename(filePath, '.md');
  const idMatch = fileName.match(/^([A-Z]+-\d+)/i);
  const docId = idMatch ? idMatch[1].toUpperCase() : frontmatter['doc-id'] || frontmatter['id'] || fileName;

  // Extraer título del h1 si no está en frontmatter
  const titleMatch = body.match(/^#\s+(.+)$/m);
  const title = frontmatter.title || titleMatch?.[1] || fileName;

  // Extraer secciones MADR
  const sections = {};
  const sectionPattern = /^##\s+(.+)$/gm;
  let lastSection = null;
  let lastIndex = 0;
  let match;

  const allMatches = [];
  while ((match = sectionPattern.exec(body)) !== null) {
    allMatches.push({ name: match[1].trim(), index: match.index, end: match.index + match[0].length });
  }

  for (let i = 0; i < allMatches.length; i++) {
    const { name, end } = allMatches[i];
    const nextIndex = allMatches[i + 1]?.index ?? body.length;
    sections[name.toLowerCase()] = body.slice(end, nextIndex).trim();
  }

  // Normalizar nombres de secciones
  const getSection = (...keys) => {
    for (const k of keys) {
      const found = Object.entries(sections).find(([n]) => n.toLowerCase().includes(k.toLowerCase()));
      if (found) return found[1];
    }
    return null;
  };

  return {
    doc_id: docId,
    tipo: 'adr',
    titulo: title,
    status: frontmatter.status || frontmatter['decision-status'] || 'accepted',
    fecha: frontmatter.date || frontmatter.fecha || null,
    decision_makers: JSON.stringify(
      frontmatter['decision-makers'] || frontmatter['decision_makers'] ||
      frontmatter.authors || []
    ),
    afecta: JSON.stringify(
      frontmatter.afecta || frontmatter.affects || frontmatter.modules || []
    ),
    frontmatter: JSON.stringify(frontmatter),
    contenido: content,
    context: getSection('context', 'problem statement', 'contexto'),
    decision: getSection('decision outcome', 'decision', 'decisión'),
    consequences: getSection('consequences', 'consecuencias'),
    options: JSON.stringify(
      extractOptions(getSection('considered options', 'options', 'opciones'))
    ),
    file_path: filePath,
  };
}

function extractOptions(sectionText) {
  if (!sectionText) return [];
  // Extraer lista de opciones de un bloque markdown
  const options = [];
  const lines = sectionText.split('\n');
  for (const line of lines) {
    const match = line.match(/^\s*[-*]\s+(.+)/);
    if (match) options.push(match[1].trim());
  }
  return options;
}

// ─── INGESTAR UN ARCHIVO ADR ──────────────────────────────────────────────────

function ingestADR(db, filePath, projectRoot) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch { return { skipped: true }; }

  const { simpleHash } = getHashFn();
  const hash = simpleHash(content);

  // Check cache
  try {
    const existing = db.prepare('SELECT content_hash FROM knowledge_docs WHERE file_path = ?').get(filePath);
    if (existing?.content_hash === hash) return { cached: true };
  } catch {}

  const adr = parseMADR(content, filePath);
  adr.content_hash = hash;

  // Insertar o actualizar
  try {
    db.prepare(`
      INSERT OR REPLACE INTO knowledge_docs
        (doc_id, tipo, titulo, status, fecha, decision_makers, afecta,
         frontmatter, contenido, context, decision, consequences, options, file_path, content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      adr.doc_id, adr.tipo, adr.titulo, adr.status, adr.fecha,
      adr.decision_makers, adr.afecta, adr.frontmatter, adr.contenido,
      adr.context, adr.decision, adr.consequences, adr.options,
      adr.file_path, adr.content_hash
    );
  } catch {
    // Fallback sin columnas opcionales
    db.prepare(`
      INSERT OR REPLACE INTO knowledge_docs
        (doc_id, tipo, titulo, status, fecha, frontmatter, contenido, file_path, content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(adr.doc_id, adr.tipo, adr.titulo, adr.status, adr.fecha,
           adr.frontmatter, adr.contenido, adr.file_path, adr.content_hash);
  }

  // Crear edges en relaciones_semanticas para archivos afectados
  const afecta = JSON.parse(adr.afecta || '[]');
  const { addCausalEdge } = require('./causal-edges.cjs');
  for (const target of afecta) {
    try {
      addCausalEdge(db, {
        desde_entidad: adr.doc_id,
        tipo: 'depends_on_decision',
        hacia_entidad: target,
        descripcion: `ADR ${adr.doc_id}: ${adr.titulo}`,
        confidence: 'ALTA',
      });
    } catch {}
  }

  return { ingested: true, doc_id: adr.doc_id, titulo: adr.titulo, afecta };
}

// ─── INGESTAR DIRECTORIO ──────────────────────────────────────────────────────

function ingestDirectory(projectRoot, dir = 'docs/adr') {
  const db = openDB(projectRoot);
  initKnowledgeSchema(db);

  const searchDir = path.join(projectRoot, dir);
  if (!fs.existsSync(searchDir)) {
    console.log(`[ADR-INGESTOR] Directorio no encontrado: ${searchDir}`);
    console.log(`[ADR-INGESTOR] Crear ADRs en docs/adr/ con plantilla .agentic/conocimiento/templates/ADR-template.md`);
    return { ingested: 0, error: 'directory not found' };
  }

  const mdFiles = fs.readdirSync(searchDir)
    .filter(f => f.endsWith('.md'))
    .map(f => path.join(searchDir, f));

  let ingested = 0, cached = 0;
  for (const file of mdFiles) {
    const result = ingestADR(db, file, projectRoot);
    if (result.ingested) { ingested++; console.log(`  ✅ ${result.doc_id}: ${result.titulo}`); }
    else if (result.cached) cached++;
  }

  console.log(`[ADR-INGESTOR] ${ingested} ADRs ingestados, ${cached} en caché`);
  return { ingested, cached };
}

// ─── QUERY ────────────────────────────────────────────────────────────────────

function queryKnowledge(db, opts = {}) {
  const { modulo = null, tipo = null, status = 'accepted', limit = 20 } = opts;

  let query = `
    SELECT doc_id, tipo, titulo, status, decision, context, afecta, fecha
    FROM knowledge_docs WHERE 1=1
  `;
  const params = [];

  if (status) {
    query += ' AND status = ?';
    params.push(status);
  }
  if (tipo) {
    query += ' AND tipo = ?';
    params.push(tipo);
  }
  if (modulo) {
    query += ' AND (afecta LIKE ? OR titulo LIKE ? OR context LIKE ?)';
    const q = `%${modulo}%`;
    params.push(q, q, q);
  }

  query += ` ORDER BY fecha DESC LIMIT ${limit}`;

  try {
    return db.prepare(query).all(...params);
  } catch { return []; }
}

// ─── HASH FN ──────────────────────────────────────────────────────────────────

function getHashFn() {
  return {
    simpleHash: (str) => {
      let h = 0;
      for (let i = 0; i < str.length; i++) { h = ((h << 5) - h) + str.charCodeAt(i); h |= 0; }
      return h.toString(16);
    }
  };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const [,, cmd, ...args] = process.argv;
  const projectRoot = process.cwd();

  switch (cmd) {
    case 'ingest': {
      const dirArg = args.find(a => !a.startsWith('--'));
      ingestDirectory(projectRoot, dirArg || 'docs/adr');
      break;
    }
    case 'query': {
      const [modulo] = args;
      const db = openDB(projectRoot);
      initKnowledgeSchema(db);
      const results = queryKnowledge(db, { modulo });
      if (results.length === 0) {
        console.log('Sin knowledge docs. Crear ADRs en docs/adr/');
      } else {
        console.log(`\nKnowledge docs (${results.length}):\n`);
        results.forEach(r => {
          console.log(`  📄 ${r.doc_id} [${r.status}] — ${r.titulo}`);
          if (r.decision) console.log(`     Decisión: ${r.decision.substring(0, 100)}`);
        });
      }
      break;
    }
    case 'show': {
      const [docId] = args;
      if (!docId) { console.error('Uso: adr-ingestor.cjs show <doc_id>'); process.exit(1); }
      const db = openDB(projectRoot);
      initKnowledgeSchema(db);
      const doc = db.prepare('SELECT * FROM knowledge_docs WHERE doc_id = ?').get(docId);
      if (!doc) { console.log(`ADR ${docId} no encontrado`); process.exit(1); }
      console.log(`\n═══ ${doc.doc_id}: ${doc.titulo} ═══`);
      console.log(`Status: ${doc.status} | Fecha: ${doc.fecha || '-'}`);
      console.log(`\nContexto:\n${doc.context || '-'}`);
      console.log(`\nDecisión:\n${doc.decision || '-'}`);
      console.log(`\nConsecuencias:\n${doc.consequences || '-'}`);
      break;
    }
    case 'stats': {
      const db = openDB(projectRoot);
      initKnowledgeSchema(db);
      try {
        const total = db.prepare('SELECT COUNT(*) as n FROM knowledge_docs').get()?.n ?? 0;
        const byTipo = db.prepare('SELECT tipo, COUNT(*) as n FROM knowledge_docs GROUP BY tipo').all();
        console.log(`\nKnowledge Base Stats:`);
        console.log(`  Total: ${total}`);
        byTipo.forEach(r => console.log(`  ${r.tipo}: ${r.n}`));
      } catch { console.log('Sin datos'); }
      break;
    }
    default:
      console.log('Uso: node adr-ingestor.cjs [ingest [dir] | query [módulo] | show <id> | stats]');
  }
}

module.exports = {
  ingestDirectory,
  ingestADR,
  parseMADR,
  parseFrontmatter,
  queryKnowledge,
  initKnowledgeSchema,
  KNOWLEDGE_SCHEMA,
};
