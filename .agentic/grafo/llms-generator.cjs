/**
 * Agentic KDD — llms.txt Generator v1.0
 *
 * Genera automáticamente:
 *   .agentic/llms.txt       — mapa estructural mínimo para agentes externos
 *   .agentic/llms-full.txt  — versión expandida con todas las reglas vigentes
 *   .agentic/knowledge-graph.json — grafo causal serializado para Git versioning
 *
 * ¿Qué resuelve?
 *   Gap: "Discoverability" — agentes externos no saben qué hay en Agentic KDD sin indexar todo
 *   Solución: llms.txt es el estándar emergente (equiv a robots.txt pero para LLMs)
 *
 *   Gap: "Grafo descentralizado" — el reporte pide que el grafo viaje en el repo vía Git
 *   Solución: knowledge-graph.json en .agentic/ → versión del grafo junto al código
 *
 *   Gap: "Progressive disclosure" — developer nuevo no sabe por dónde empezar
 *   Solución: llms.txt actúa como mapa de onboarding estructurado
 *
 * Se ejecuta automáticamente en: akdd sync, akdd update
 * También se puede correr manualmente: node llms-generator.cjs
 *
 * Uso:
 *   node .agentic/grafo/llms-generator.cjs generate
 *   node .agentic/grafo/llms-generator.cjs graph
 *   node .agentic/grafo/llms-generator.cjs all
 */

'use strict';

const path = require('path');
const fs   = require('fs');

// ─── DB HELPER ────────────────────────────────────────────────────────────────

function openDB(projectRoot) {
  const dbPath = path.join(projectRoot, '.agentic/memoria.db');
  try { return new (require('better-sqlite3'))(dbPath); } catch {}
  try { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(dbPath); } catch {}
  return null; // Si no hay DB, generar desde config.md
}

// ─── LEER CONFIG DEL PROYECTO ────────────────────────────────────────────────

function readProjectConfig(projectRoot) {
  const configPath = path.join(projectRoot, '.agentic', 'config.md');
  if (!fs.existsSync(configPath)) return {};

  const content = fs.readFileSync(configPath, 'utf8');
  const config  = {};

  // Extraer campos clave del config.md
  const extractField = (key) => {
    const match = content.match(new RegExp(`${key}:\\s*(.+)`));
    return match ? match[1].trim() : null;
  };

  config.proyecto   = extractField('PROYECTO');
  config.stack      = extractField('STACK');
  config.descripcion= extractField('DESCRIPCIÓN') || extractField('DESCRIPCION');
  config.modulos    = [];

  // Extraer módulos listados
  const modulosMatch = content.match(/MÓDULOS[^\n]*\n([\s\S]*?)(?=\n##|\n\*\*|$)/i);
  if (modulosMatch) {
    config.modulos = modulosMatch[1]
      .split('\n')
      .map(l => l.replace(/^[-*\s]+/, '').trim())
      .filter(Boolean)
      .slice(0, 20);
  }

  return config;
}

// ─── GENERAR llms.txt ─────────────────────────────────────────────────────────
/**
 * llms.txt: formato estándar emergente para que LLMs se orienten en un proyecto.
 * Minimalista. Agentes externos lo leen antes de explorar el codebase.
 */
function generateLlmsTxt(projectRoot, db) {
  const config = readProjectConfig(projectRoot);

  const lines = [];
  const now = new Date().toISOString().split('T')[0];

  lines.push(`# ${config.proyecto || path.basename(projectRoot)}`);
  lines.push('');
  if (config.descripcion) {
    lines.push(`> ${config.descripcion}`);
    lines.push('');
  }
  lines.push(`> Agentic KDD v3.2 — Knowledge-Driven Development`);
  lines.push(`> Generated: ${now}`);
  lines.push('');

  // Stack
  if (config.stack) {
    lines.push('## Stack');
    lines.push('');
    config.stack.split(/[,/]/).map(s => s.trim()).filter(Boolean).forEach(s => {
      lines.push(`- ${s}`);
    });
    lines.push('');
  }

  // Módulos del proyecto
  if (db) {
    try {
      const entities = db.prepare(`
        SELECT nombre, tipo, descripcion, area
        FROM entidades WHERE tipo IN ('modulo','archivo','api','tabla')
        ORDER BY tipo, nombre LIMIT 30
      `).all();

      if (entities.length > 0) {
        lines.push('## Architecture');
        lines.push('');
        const byType = {};
        entities.forEach(e => {
          if (!byType[e.tipo]) byType[e.tipo] = [];
          byType[e.tipo].push(e);
        });
        Object.entries(byType).forEach(([tipo, ents]) => {
          lines.push(`### ${tipo.charAt(0).toUpperCase() + tipo.slice(1)}s`);
          ents.slice(0, 10).forEach(e => {
            lines.push(`- **${e.nombre}**: ${e.descripcion || e.area || tipo}`);
          });
          lines.push('');
        });
      }
    } catch {}
  } else if (config.modulos?.length > 0) {
    lines.push('## Modules');
    lines.push('');
    config.modulos.forEach(m => lines.push(`- ${m}`));
    lines.push('');
  }

  // Reglas vigentes HIGH
  if (db) {
    try {
      const rules = db.prepare(`
        SELECT titulo, area, tipo
        FROM nodos
        WHERE confianza = 'ALTA'
          AND estado = 'ACTIVO'
          AND (vigencia_tipo = 'VIGENTE' OR vigencia_tipo IS NULL)
        ORDER BY aplicado DESC LIMIT 15
      `).all();

      if (rules.length > 0) {
        lines.push('## Key Rules (HIGH confidence)');
        lines.push('');
        rules.forEach(r => {
          lines.push(`- [${r.tipo}] ${r.titulo} (${r.area || 'global'})`);
        });
        lines.push('');
      }
    } catch {}
  }

  // ADRs activos
  if (db) {
    try {
      const adrs = db.prepare(`
        SELECT titulo, decision, status FROM knowledge_docs
        WHERE status = 'accepted' LIMIT 10
      `).all();

      if (adrs.length > 0) {
        lines.push('## Architecture Decisions');
        lines.push('');
        adrs.forEach(a => {
          lines.push(`- **${a.titulo}**: ${a.decision?.substring(0, 80) || ''}`);
        });
        lines.push('');
      }
    } catch {}
  }

  // Errores frecuentes (memoria causal)
  if (db) {
    try {
      const errors = db.prepare(`
        SELECT titulo FROM nodos
        WHERE tipo = 'error'
          AND confianza IN ('ALTA','MEDIA')
          AND estado = 'ACTIVO'
        ORDER BY aplicado DESC LIMIT 10
      `).all();

      if (errors.length > 0) {
        lines.push('## Known Pitfalls');
        lines.push('');
        errors.forEach(e => lines.push(`- ${e.titulo}`));
        lines.push('');
      }
    } catch {}
  }

  // Footer
  lines.push('## Agentic KDD Tools');
  lines.push('');
  lines.push('This project uses Agentic KDD for persistent AI memory. Available MCP tools:');
  lines.push('- `grafo_buscar` — hybrid search across 4 CoALA memory layers');
  lines.push('- `ast_impact` — pre-change impact analysis');
  lines.push('- `knowledge_query` — query ADRs and gotchas');
  lines.push('- `verdad_vigente` — currently valid rules only');
  lines.push('- `decision_trail` — decision observability');
  lines.push('- `health_check` — full system diagnostic');
  lines.push('');
  lines.push('Run `akdd health` to verify system state before working.');
  lines.push('');

  return lines.join('\n');
}

// ─── GENERAR llms-full.txt ────────────────────────────────────────────────────
/**
 * Versión expandida con TODO el conocimiento vigente del proyecto.
 * Para agentes que necesitan contexto completo antes de empezar.
 */
function generateLlmsFullTxt(projectRoot, db) {
  if (!db) return null;

  const lines = [];
  const minimal = generateLlmsTxt(projectRoot, db);
  lines.push(minimal);

  lines.push('---');
  lines.push('## Full Knowledge Base');
  lines.push('');

  // Todos los patrones ALTA y MEDIA vigentes
  try {
    const patterns = db.prepare(`
      SELECT titulo, contenido, tipo, area, aplicado, util
      FROM nodos
      WHERE estado = 'ACTIVO'
        AND confianza IN ('ALTA', 'MEDIA')
        AND (vigencia_tipo = 'VIGENTE' OR vigencia_tipo IS NULL)
      ORDER BY confianza DESC, aplicado DESC
      LIMIT 50
    `).all();

    if (patterns.length > 0) {
      lines.push('### All Active Patterns');
      lines.push('');
      patterns.forEach(p => {
        lines.push(`#### [${p.tipo}] ${p.titulo} (${p.area || 'global'})`);
        if (p.contenido) lines.push(p.contenido.substring(0, 300));
        lines.push(`*Applied: ${p.aplicado || 0}× | Useful: ${p.util || 0}×*`);
        lines.push('');
      });
    }
  } catch {}

  // Causal edges activos
  try {
    const edges = db.prepare(`
      SELECT desde_entidad, tipo, hacia_entidad, descripcion
      FROM relaciones_semanticas
      WHERE tipo IN ('caused_failure','was_fixed_by','tested_by','regressed_by')
        AND (invalid_at IS NULL OR invalid_at = '')
      ORDER BY valid_at DESC LIMIT 30
    `).all();

    if (edges.length > 0) {
      lines.push('### Causal Memory');
      lines.push('');
      edges.forEach(e => {
        lines.push(`- ${e.desde_entidad} --${e.tipo}--> ${e.hacia_entidad}`);
        if (e.descripcion) lines.push(`  *${e.descripcion.substring(0, 100)}*`);
      });
      lines.push('');
    }
  } catch {}

  return lines.join('\n');
}

// ─── GENERAR knowledge-graph.json ────────────────────────────────────────────
/**
 * Grafo causal serializado para Git versioning.
 * Viaja con el repo → el equipo comparte el grafo sin infraestructura externa.
 * Inspirado en Graphify y Understand Anything.
 */
function generateKnowledgeGraph(projectRoot, db) {
  if (!db) return null;

  const graph = {
    version: '3.2',
    generated: new Date().toISOString(),
    project: path.basename(projectRoot),
    nodes: [],
    edges: [],
    decisions: [],
    stats: {},
  };

  // Nodos procedurales vigentes
  try {
    graph.nodes = db.prepare(`
      SELECT id, tipo, titulo, area, confianza, aplicado, util,
             decay_score, vigencia_tipo, fecha_creacion
      FROM nodos
      WHERE estado = 'ACTIVO'
        AND (vigencia_tipo = 'VIGENTE' OR vigencia_tipo IS NULL)
        AND confianza IN ('ALTA', 'MEDIA')
      ORDER BY confianza DESC, aplicado DESC
      LIMIT 200
    `).all();
  } catch {}

  // Edges causales activos
  try {
    graph.edges = db.prepare(`
      SELECT desde_entidad, tipo, hacia_entidad, descripcion, confidence, valid_at
      FROM relaciones_semanticas
      WHERE tipo IN ('caused_failure','was_fixed_by','tested_by','regressed_by','depends_on_decision')
        AND (invalid_at IS NULL OR invalid_at = '')
      ORDER BY valid_at DESC LIMIT 300
    `).all();
  } catch {}

  // ADRs
  try {
    graph.decisions = db.prepare(`
      SELECT doc_id, titulo, decision, status, afecta, fecha_indexado
      FROM knowledge_docs
      WHERE status = 'accepted'
      LIMIT 50
    `).all();
  } catch {}

  // Stats
  graph.stats = {
    total_nodes: graph.nodes.length,
    total_edges: graph.edges.length,
    total_decisions: graph.decisions.length,
    high_confidence: graph.nodes.filter(n => n.confianza === 'ALTA').length,
  };

  return graph;
}

// ─── GENERAR TODO ─────────────────────────────────────────────────────────────

function generateAll(projectRoot) {
  projectRoot = projectRoot || process.cwd();
  const db = openDB(projectRoot);

  const results = { llms_txt: false, llms_full: false, knowledge_graph: false };

  // 1. llms.txt
  try {
    const content = generateLlmsTxt(projectRoot, db);
    fs.writeFileSync(path.join(projectRoot, '.agentic', 'llms.txt'), content);
    results.llms_txt = true;
    console.log('[LLMS] ✅ .agentic/llms.txt generado');
  } catch (e) {
    console.error('[LLMS] Error llms.txt:', e.message);
  }

  // 2. llms-full.txt
  if (db) {
    try {
      const content = generateLlmsFullTxt(projectRoot, db);
      if (content) {
        fs.writeFileSync(path.join(projectRoot, '.agentic', 'llms-full.txt'), content);
        results.llms_full = true;
        console.log('[LLMS] ✅ .agentic/llms-full.txt generado');
      }
    } catch (e) {
      console.error('[LLMS] Error llms-full.txt:', e.message);
    }
  }

  // 3. knowledge-graph.json
  if (db) {
    try {
      const graph = generateKnowledgeGraph(projectRoot, db);
      if (graph) {
        fs.writeFileSync(
          path.join(projectRoot, '.agentic', 'knowledge-graph.json'),
          JSON.stringify(graph, null, 2)
        );
        results.knowledge_graph = true;
        console.log(`[LLMS] ✅ .agentic/knowledge-graph.json generado (${graph.stats.total_nodes} nodos, ${graph.stats.total_edges} edges)`);
      }
    } catch (e) {
      console.error('[LLMS] Error knowledge-graph.json:', e.message);
    }
  }

  return results;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const [,, cmd] = process.argv;
  const projectRoot = process.cwd();

  switch (cmd) {
    case 'generate':
      const db = openDB(projectRoot);
      const content = generateLlmsTxt(projectRoot, db);
      fs.writeFileSync(path.join(projectRoot, '.agentic', 'llms.txt'), content);
      console.log('✅ .agentic/llms.txt generado');
      break;
    case 'graph':
      const db2 = openDB(projectRoot);
      if (!db2) { console.error('DB no disponible'); break; }
      const graph = generateKnowledgeGraph(projectRoot, db2);
      fs.writeFileSync(path.join(projectRoot, '.agentic', 'knowledge-graph.json'), JSON.stringify(graph, null, 2));
      console.log(`✅ knowledge-graph.json: ${graph.stats.total_nodes} nodos, ${graph.stats.total_edges} edges`);
      break;
    case 'all':
    default:
      generateAll(projectRoot);
  }
}

module.exports = { generateLlmsTxt, generateLlmsFullTxt, generateKnowledgeGraph, generateAll };
