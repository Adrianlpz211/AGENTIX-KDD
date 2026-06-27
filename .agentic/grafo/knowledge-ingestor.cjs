/**
 * Agentic KDD — Knowledge Ingestor v1.0
 * Ingesta genérica de gotchas, convenciones y runbooks con frontmatter
 * estructurado → nodos en el grafo de conocimiento.
 *
 * Complementa adr-ingestor.cjs para documentación operacional.
 *
 * Uso:
 *   node .agentic/grafo/knowledge-ingestor.cjs ingest [--dir docs/gotchas]
 *   node .agentic/grafo/knowledge-ingestor.cjs query [módulo]
 *   node .agentic/grafo/knowledge-ingestor.cjs lint [--dir docs/gotchas]
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { parseFrontmatter, queryKnowledge, initKnowledgeSchema } = require('./adr-ingestor.cjs');

function openDB(projectRoot) {
  const dbPath = path.join(projectRoot, '.agentic/memoria.db');
  try { return new (require('better-sqlite3'))(dbPath); } catch {}
  try { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(dbPath); } catch {}
  throw new Error('No SQLite driver disponible');
}

// ─── REQUIRED FRONTMATTER POR TIPO ───────────────────────────────────────────

const REQUIRED_FIELDS = {
  gotcha:     ['tipo', 'regla', 'severidad'],
  convention: ['tipo', 'descripcion', 'area'],
  runbook:    ['tipo', 'titulo', 'trigger'],
  adr:        ['status'],
};

const VALID_SEVERIDADES = ['ALTO', 'MEDIO', 'BAJO'];

/**
 * Linter de frontmatter — verifica que un doc tenga los campos obligatorios.
 * @returns {{ valid: boolean, errors: string[] }}
 */
function lintDocument(filePath, content) {
  const { frontmatter } = parseFrontmatter(content);
  const tipo = frontmatter.tipo || 'gotcha';
  const required = REQUIRED_FIELDS[tipo] || REQUIRED_FIELDS.gotcha;

  const errors = [];
  for (const field of required) {
    if (!frontmatter[field]) {
      errors.push(`Falta campo obligatorio: '${field}'`);
    }
  }

  if (frontmatter.severidad && !VALID_SEVERIDADES.includes(frontmatter.severidad?.toUpperCase())) {
    errors.push(`Severidad inválida: '${frontmatter.severidad}'. Válidos: ${VALID_SEVERIDADES.join(', ')}`);
  }

  if (!frontmatter.afecta && tipo !== 'convention') {
    errors.push("Campo 'afecta' recomendado: lista de rutas/módulos afectados");
  }

  return { valid: errors.length === 0, errors, tipo, frontmatter };
}

// ─── PARSEAR DOCUMENTO DE CONOCIMIENTO ───────────────────────────────────────

function parseKnowledgeDoc(content, filePath) {
  const { frontmatter, body } = parseFrontmatter(content);

  const fileName = path.basename(filePath, '.md');
  const tipo = frontmatter.tipo || 'gotcha';

  // Generar doc_id automático
  const prefix = tipo.toUpperCase().substring(0, 3);
  const docId = frontmatter['doc-id'] || frontmatter.id || `${prefix}-${fileName.replace(/[^a-z0-9-]/gi, '-').substring(0, 30)}`;

  // Extraer secciones del body
  const reglaMatch = body.match(/^##\s+(?:Regla|Rule|Descripción)\s*\n([\s\S]*?)(?=\n##|\s*$)/im);
  const ejemploMatch = body.match(/^##\s+(?:Ejemplo|Example|Bad|❌)\s*\n([\s\S]*?)(?=\n##|\s*$)/im);

  return {
    doc_id: docId,
    tipo,
    titulo: frontmatter.titulo || frontmatter.title || frontmatter.regla || fileName,
    status: frontmatter.status || 'accepted',
    fecha: frontmatter.date || frontmatter.fecha || null,
    decision_makers: JSON.stringify(frontmatter.authors || frontmatter['decision-makers'] || []),
    afecta: JSON.stringify(frontmatter.afecta || frontmatter.affects || []),
    frontmatter: JSON.stringify(frontmatter),
    contenido: content,
    context: frontmatter.contexto || frontmatter.context || null,
    decision: frontmatter.regla || frontmatter.descripcion || reglaMatch?.[1]?.trim() || null,
    consequences: ejemploMatch?.[1]?.trim() || null,
    options: '[]',
    file_path: filePath,
  };
}

// ─── INGESTAR UN DOC ─────────────────────────────────────────────────────────

function ingestDoc(db, filePath, projectRoot) {
  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); } catch { return { skipped: true }; }

  // Lint antes de ingestar
  const lint = lintDocument(filePath, content);
  if (!lint.valid) {
    console.warn(`  ⚠️  ${path.basename(filePath)}: ${lint.errors.join(' | ')}`);
    // No bloquear — ingestar igual pero marcar
  }

  let h = 0;
  for (let i = 0; i < content.length; i++) { h = ((h << 5) - h) + content.charCodeAt(i); h |= 0; }
  const hash = h.toString(16);

  try {
    const existing = db.prepare('SELECT content_hash FROM knowledge_docs WHERE file_path = ?').get(filePath);
    if (existing?.content_hash === hash) return { cached: true };
  } catch {}

  const doc = parseKnowledgeDoc(content, filePath);
  doc.content_hash = hash;

  try {
    db.prepare(`
      INSERT OR REPLACE INTO knowledge_docs
        (doc_id, tipo, titulo, status, fecha, decision_makers, afecta,
         frontmatter, contenido, context, decision, consequences, options, file_path, content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      doc.doc_id, doc.tipo, doc.titulo, doc.status, doc.fecha,
      doc.decision_makers, doc.afecta, doc.frontmatter, doc.contenido,
      doc.context, doc.decision, doc.consequences, doc.options,
      doc.file_path, doc.content_hash
    );
  } catch (e) {
    db.prepare(`
      INSERT OR REPLACE INTO knowledge_docs
        (doc_id, tipo, titulo, status, frontmatter, contenido, file_path, content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(doc.doc_id, doc.tipo, doc.titulo, doc.status,
           doc.frontmatter, doc.contenido, doc.file_path, doc.content_hash);
  }

  // Insertar como nodo en memoria procedural también (para búsqueda en grafo.cjs)
  try {
    const fm = JSON.parse(doc.frontmatter || '{}');
    db.prepare(`
      INSERT OR IGNORE INTO nodos
        (tipo, titulo, contenido, area, confianza, estado)
      VALUES (?, ?, ?, ?, ?, 'ACTIVO')
    `).run(
      `conocimiento_${doc.tipo}`,
      doc.titulo,
      doc.decision || doc.contenido?.substring(0, 500) || '',
      fm.area || fm.afecta?.[0] || 'global',
      fm.severidad === 'ALTO' ? 'ALTA' : fm.severidad === 'MEDIO' ? 'MEDIA' : 'BAJA'
    );
  } catch {}

  return { ingested: true, doc_id: doc.doc_id, titulo: doc.titulo };
}

// ─── INGESTAR DIRECTORIO ──────────────────────────────────────────────────────

const DEFAULT_DIRS = ['docs/gotchas', 'docs/conventions', 'docs/runbooks', '.agentic/conocimiento'];

function ingestKnowledgeDirectory(projectRoot, dir = null) {
  const db = openDB(projectRoot);
  initKnowledgeSchema(db);

  const dirs = dir ? [dir] : DEFAULT_DIRS;
  let totalIngested = 0, totalCached = 0;

  for (const d of dirs) {
    const searchDir = path.join(projectRoot, d);
    if (!fs.existsSync(searchDir)) continue;

    console.log(`[KNOWLEDGE] Ingesting ${d}...`);
    const mdFiles = fs.readdirSync(searchDir)
      .filter(f => f.endsWith('.md') && !f.startsWith('README') && !f.startsWith('_'))
      .map(f => path.join(searchDir, f));

    for (const file of mdFiles) {
      const result = ingestDoc(db, file, projectRoot);
      if (result.ingested) { totalIngested++; console.log(`  ✅ ${result.doc_id}: ${result.titulo}`); }
      else if (result.cached) totalCached++;
      else if (result.skipped) console.log(`  ⏭️  Omitido: ${path.basename(file)}`);
    }
  }

  console.log(`[KNOWLEDGE] ${totalIngested} docs ingestados, ${totalCached} en caché`);
  return { ingested: totalIngested, cached: totalCached };
}

// ─── LINT DE DIRECTORIO ──────────────────────────────────────────────────────

function lintDirectory(projectRoot, dir = 'docs/gotchas') {
  const searchDir = path.join(projectRoot, dir);
  if (!fs.existsSync(searchDir)) {
    console.log(`Directorio no encontrado: ${searchDir}`);
    return;
  }

  const files = fs.readdirSync(searchDir).filter(f => f.endsWith('.md')).map(f => path.join(searchDir, f));
  let valid = 0, invalid = 0;

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const result = lintDocument(file, content);
    if (result.valid) {
      valid++;
      console.log(`  ✅ ${path.basename(file)}`);
    } else {
      invalid++;
      console.log(`  ❌ ${path.basename(file)}: ${result.errors.join('; ')}`);
    }
  }

  console.log(`\nLint: ${valid} válidos, ${invalid} con errores`);
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const [,, cmd, ...args] = process.argv;
  const projectRoot = process.cwd();

  switch (cmd) {
    case 'ingest': {
      const dirArg = args.find(a => !a.startsWith('--'));
      ingestKnowledgeDirectory(projectRoot, dirArg);
      break;
    }
    case 'query': {
      const [modulo] = args;
      const db = openDB(projectRoot);
      initKnowledgeSchema(db);
      const results = queryKnowledge(db, { modulo, status: null });
      if (results.length === 0) { console.log('Sin knowledge docs.'); break; }
      console.log(`\nKnowledge (${results.length}):`);
      results.forEach(r => {
        console.log(`  [${r.tipo}] ${r.doc_id} — ${r.titulo}`);
        if (r.decision) console.log(`    → ${r.decision.substring(0, 120)}`);
      });
      break;
    }
    case 'lint': {
      const dirArg = args.find(a => !a.startsWith('--'));
      lintDirectory(projectRoot, dirArg || 'docs/gotchas');
      break;
    }
    default:
      console.log('Uso: node knowledge-ingestor.cjs [ingest [dir] | query [módulo] | lint [dir]]');
  }
}

module.exports = {
  ingestKnowledgeDirectory,
  ingestDoc,
  lintDocument,
  parseKnowledgeDoc,
};
