/**
 * Agentic KDD — Health Check v1.0
 * Diagnóstico completo del estado del sistema: qué funciona, qué falta, qué hacer.
 *
 * Cierra el Gap #3: un dev que llega al proyecto (o retoma después de tiempo)
 * no sabe si el AST está indexado, si las migraciones corrieron, si hay ADRs.
 * Este módulo elimina esa fricción con un reporte de estado en <2 segundos.
 *
 * Uso:
 *   node .agentic/grafo/health-check.cjs
 *   node .agentic/grafo/health-check.cjs --fix     (intenta arreglar lo que puede)
 *   node .agentic/grafo/health-check.cjs --json    (output JSON para scripts)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const CHECKS = [
  // ── Core ──────────────────────────────────────────────────────────────────
  {
    id: 'config',
    nombre: 'config.md configurado',
    categoria: 'core',
    check: (root) => {
      const p = path.join(root, '.agentic/config.md');
      if (!fs.existsSync(p)) return { ok: false, msg: 'config.md no existe' };
      const c = fs.readFileSync(p, 'utf8');
      if (c.includes('CONFIGURADO: NO')) return { ok: false, msg: 'CONFIGURADO: NO — ejecutar aa: setup' };
      return { ok: true, msg: 'configurado' };
    },
    fix: null,
  },
  {
    id: 'db',
    nombre: 'Base de datos SQLite',
    categoria: 'core',
    check: (root) => {
      const p = path.join(root, '.agentic/memoria.db');
      if (!fs.existsSync(p)) return { ok: false, msg: 'memoria.db no existe — ejecutar: node .agentic/grafo/grafo.cjs sync' };
      const stat = fs.statSync(p);
      return { ok: true, msg: `${Math.round(stat.size / 1024)}KB` };
    },
    fix: 'node .agentic/grafo/grafo.cjs sync',
  },
  {
    id: 'driver',
    nombre: 'Driver SQLite disponible',
    categoria: 'core',
    check: (_root) => {
      try { require('better-sqlite3'); return { ok: true, msg: 'better-sqlite3' }; } catch {}
      try { require('node:sqlite'); return { ok: true, msg: 'node:sqlite (Node 22+)' }; } catch {}
      return { ok: false, msg: 'Ningún driver. Ejecutar: npm install better-sqlite3 (o usar Node 22+)' };
    },
    fix: 'npm install better-sqlite3',
  },
  // ── Schema ────────────────────────────────────────────────────────────────
  {
    id: 'schema_v3',
    nombre: 'Schema v3.1 migrado',
    categoria: 'schema',
    check: (root) => {
      const dbPath = path.join(root, '.agentic/memoria.db');
      if (!fs.existsSync(dbPath)) return { ok: false, msg: 'DB no existe' };
      try {
        let db;
        try { db = new (require('better-sqlite3'))(dbPath); } catch { const { DatabaseSync } = require('node:sqlite'); db = new DatabaseSync(dbPath); }
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
        const missing = ['ast_symbols','ast_edges','knowledge_docs'].filter(t => !tables.includes(t));
        if (missing.length > 0) return { ok: false, msg: `Tablas faltantes: ${missing.join(', ')} — ejecutar: node .agentic/grafo/grafo.cjs sync` };
        return { ok: true, msg: 'ast_symbols ✓ ast_edges ✓ knowledge_docs ✓' };
      } catch (e) { return { ok: false, msg: e.message }; }
    },
    fix: 'node .agentic/grafo/grafo.cjs sync',
  },
  {
    id: 'vigencia_tipo',
    nombre: 'Campo vigencia_tipo en nodos',
    categoria: 'schema',
    check: (root) => {
      const dbPath = path.join(root, '.agentic/memoria.db');
      if (!fs.existsSync(dbPath)) return { ok: false, msg: 'DB no existe' };
      try {
        let db;
        try { db = new (require('better-sqlite3'))(dbPath); } catch { const { DatabaseSync } = require('node:sqlite'); db = new DatabaseSync(dbPath); }
        const cols = db.prepare("PRAGMA table_info(nodos)").all().map(c => c.name);
        if (!cols.includes('vigencia_tipo')) return { ok: false, msg: 'Falta vigencia_tipo — ejecutar: node .agentic/grafo/memory-audit.cjs migrate' };
        return { ok: true, msg: 'vigencia_tipo presente' };
      } catch (e) { return { ok: false, msg: e.message }; }
    },
    fix: 'node .agentic/grafo/memory-audit.cjs migrate',
  },
  // ── AST ───────────────────────────────────────────────────────────────────
  {
    id: 'ast_index',
    nombre: 'Índice AST del proyecto',
    categoria: 'discernimiento',
    check: (root) => {
      const dbPath = path.join(root, '.agentic/memoria.db');
      if (!fs.existsSync(dbPath)) return { ok: false, msg: 'DB no existe' };
      try {
        let db;
        try { db = new (require('better-sqlite3'))(dbPath); } catch { const { DatabaseSync } = require('node:sqlite'); db = new DatabaseSync(dbPath); }
        const count = db.prepare("SELECT COUNT(*) as n FROM ast_symbols").get()?.n ?? 0;
        if (count === 0) return { ok: false, msg: 'AST no indexado — ejecutar: node .agentic/grafo/ast-indexer.cjs index' };
        const files = db.prepare("SELECT COUNT(DISTINCT file) as n FROM ast_symbols").get()?.n ?? 0;
        return { ok: true, msg: `${count} símbolos en ${files} archivos` };
      } catch { return { ok: false, msg: 'Tabla ast_symbols no existe — ejecutar: node .agentic/grafo/grafo.cjs sync && node .agentic/grafo/ast-indexer.cjs index' }; }
    },
    fix: 'node .agentic/grafo/ast-indexer.cjs index',
  },
  // ── Knowledge ─────────────────────────────────────────────────────────────
  {
    id: 'knowledge_docs',
    nombre: 'Base de conocimiento (ADRs/gotchas)',
    categoria: 'conocimiento',
    check: (root) => {
      const dbPath = path.join(root, '.agentic/memoria.db');
      if (!fs.existsSync(dbPath)) return { ok: false, msg: 'DB no existe' };
      try {
        let db;
        try { db = new (require('better-sqlite3'))(dbPath); } catch { const { DatabaseSync } = require('node:sqlite'); db = new DatabaseSync(dbPath); }
        const count = db.prepare("SELECT COUNT(*) as n FROM knowledge_docs").get()?.n ?? 0;
        if (count === 0) {
          const hasADRDir = fs.existsSync(path.join(root, 'docs/adr'));
          if (!hasADRDir) return { ok: false, msg: 'Sin ADRs. Crear docs/adr/ y ejecutar: node .agentic/grafo/adr-ingestor.cjs ingest' };
          return { ok: false, msg: 'docs/adr/ existe pero no ingestado — ejecutar: node .agentic/grafo/adr-ingestor.cjs ingest' };
        }
        return { ok: true, msg: `${count} docs ingestados` };
      } catch { return { ok: false, msg: 'Tabla knowledge_docs no disponible' }; }
    },
    fix: 'node .agentic/grafo/adr-ingestor.cjs ingest && node .agentic/grafo/knowledge-ingestor.cjs ingest',
  },
  // ── Memoria ───────────────────────────────────────────────────────────────
  {
    id: 'memory_quality',
    nombre: 'Calidad de memoria procedural',
    categoria: 'memoria',
    check: (root) => {
      const dbPath = path.join(root, '.agentic/memoria.db');
      if (!fs.existsSync(dbPath)) return { ok: false, msg: 'DB no existe' };
      try {
        let db;
        try { db = new (require('better-sqlite3'))(dbPath); } catch { const { DatabaseSync } = require('node:sqlite'); db = new DatabaseSync(dbPath); }
        const total = db.prepare("SELECT COUNT(*) as n FROM nodos WHERE estado='ACTIVO'").get()?.n ?? 0;
        const alta  = db.prepare("SELECT COUNT(*) as n FROM nodos WHERE confianza='ALTA' AND estado='ACTIVO'").get()?.n ?? 0;
        if (total === 0) return { ok: false, msg: 'Sin memoria — ejecutar al menos un ciclo aa:' };
        const ratio = Math.round((alta / total) * 100);
        return { ok: ratio >= 10, msg: `${total} nodos activos, ${alta} ALTA (${ratio}%)` };
      } catch { return { ok: false, msg: 'Error leyendo nodos' }; }
    },
    fix: null,
  },
  {
    id: 'memory_debt',
    nombre: 'Deuda de consolidación',
    categoria: 'memoria',
    check: (root) => {
      const dbPath = path.join(root, '.agentic/memoria.db');
      if (!fs.existsSync(dbPath)) return { ok: true, msg: 'N/A' };
      try {
        let db;
        try { db = new (require('better-sqlite3'))(dbPath); } catch { const { DatabaseSync } = require('node:sqlite'); db = new DatabaseSync(dbPath); }
        const sin_consolidar = db.prepare("SELECT COUNT(*) as n FROM episodios WHERE consolidado=0").get()?.n ?? 0;
        if (sin_consolidar > 50) return { ok: false, msg: `${sin_consolidar} episodios sin consolidar — ejecutar: node .agentic/grafo/grafo.cjs consolidar` };
        return { ok: true, msg: `${sin_consolidar} episodios sin consolidar` };
      } catch { return { ok: true, msg: 'N/A' }; }
    },
    fix: 'node .agentic/grafo/grafo.cjs consolidar',
  },
  // ── Harness ───────────────────────────────────────────────────────────────
  {
    id: 'harness',
    nombre: 'Harness v3 disponible',
    categoria: 'harness',
    check: (root) => {
      const p = path.join(root, '.agentic/grafo/harness.cjs');
      if (!fs.existsSync(p)) return { ok: false, msg: 'harness.cjs no encontrado — copiar desde el ZIP v3' };
      try { require(p); return { ok: true, msg: 'harness.cjs cargado correctamente' }; }
      catch (e) { return { ok: false, msg: `Error en harness.cjs: ${e.message}` }; }
    },
    fix: null,
  },
  {
    id: 'tdd_gate',
    nombre: 'TDD gate mecánico',
    categoria: 'harness',
    check: (root) => {
      const p = path.join(root, '.agentic/grafo/tdd-gate.cjs');
      if (!fs.existsSync(p)) return { ok: false, msg: 'tdd-gate.cjs no encontrado' };
      return { ok: true, msg: 'presente' };
    },
    fix: null,
  },
  // ── Specs ─────────────────────────────────────────────────────────────────
  {
    id: 'specs',
    nombre: 'Specs del proyecto',
    categoria: 'autonomia',
    check: (root) => {
      const p = path.join(root, '.agentic/specs');
      if (!fs.existsSync(p)) return { ok: false, msg: 'Directorio .agentic/specs/ no existe' };
      const mods = fs.readdirSync(p, { withFileTypes: true }).filter(e => e.isDirectory() && e.name !== 'templates');
      if (mods.length === 0) return { ok: false, msg: 'Sin specs de módulos — crear con: node .agentic/grafo/spec-manager.cjs create <módulo>' };
      return { ok: true, msg: `${mods.length} specs de módulos` };
    },
    fix: null,
  },

  // ── v3.2: Embeddings bimodales ─────────────────────────────────────────────
  {
    id: 'embeddings_model',
    nombre: 'Modelo de embeddings bimodal NL-PL',
    categoria: 'embeddings',
    check: (root) => {
      const localCache = path.join(root, '.agentic', '.model_cache');
      const jinaDir = path.join(localCache, 'models--jinaai--jina-embeddings-v2-base-code');
      const hfCache = path.join(require('os').homedir(), '.cache', 'huggingface', 'hub', 'models--jinaai--jina-embeddings-v2-base-code');
      if (fs.existsSync(jinaDir) || fs.existsSync(hfCache)) {
        return { ok: true, msg: 'jina-embeddings-v2-base-code activo (bimodal NL-PL)' };
      }
      // Verificar si al menos tiene mini
      const miniDir = path.join(localCache, 'models--Xenova--all-MiniLM-L6-v2');
      if (fs.existsSync(miniDir)) {
        return { ok: false, msg: 'Solo all-MiniLM-L6-v2 (NL, no código). Ejecutar: akdd jina-install para modelo bimodal' };
      }
      return { ok: false, msg: 'Sin modelo de embeddings. Ejecutar: akdd jina-install (bimodal) o akdd embed-install (básico)' };
    },
    fix: 'akdd jina-install',
  },
  // ── v3.2: MemCurator ────────────────────────────────────────────────────────
  {
    id: 'mem_curator',
    nombre: 'MemCurator disponible',
    categoria: 'memoria',
    check: (root) => {
      const p = path.join(root, '.agentic', 'grafo', 'mem-curator.cjs');
      if (!fs.existsSync(p)) return { ok: false, msg: 'mem-curator.cjs no encontrado — ejecutar: akdd update' };
      return { ok: true, msg: 'MemCurator disponible' };
    },
    fix: 'akdd update',
  },
  // ── v3.2: llms.txt ─────────────────────────────────────────────────────────
  {
    id: 'llms_txt',
    nombre: 'llms.txt generado',
    categoria: 'discoverability',
    check: (root) => {
      const p = path.join(root, '.agentic', 'llms.txt');
      if (!fs.existsSync(p)) return { ok: false, msg: 'llms.txt no generado — ejecutar: akdd llms' };
      return { ok: true, msg: 'llms.txt presente' };
    },
    fix: 'akdd llms',
  },
  // ── v3.2: knowledge-graph.json ─────────────────────────────────────────────
  {
    id: 'knowledge_graph_json',
    nombre: 'knowledge-graph.json para Git',
    categoria: 'discoverability',
    check: (root) => {
      const p = path.join(root, '.agentic', 'knowledge-graph.json');
      if (!fs.existsSync(p)) return { ok: false, msg: 'knowledge-graph.json no existe — ejecutar: akdd llms' };
      try {
        const g = JSON.parse(fs.readFileSync(p, 'utf8'));
        return { ok: true, msg: `${g.stats?.total_nodes || 0} nodos, ${g.stats?.total_edges || 0} edges` };
      } catch { return { ok: false, msg: 'knowledge-graph.json inválido — ejecutar: akdd llms' }; }
    },
    fix: 'akdd llms',
  },
  // ── PIEZA 6 (aditivo): integridad del grafo — Graph Reviewer ────────────────
  {
    id: 'graph_integrity',
    nombre: 'Integridad del grafo (reviewer)',
    categoria: 'memoria',
    check: (root) => {
      try {
        const s = require(path.join(root, '.agentic', 'grafo', 'graph-reviewer.cjs')).healthSummary(root);
        if (!s) return { ok: true, msg: 'reviewer no disponible — omitido' };
        if (s.total === 0) return { ok: true, msg: 'memoria íntegra — 0 referencias rotas' };
        const parts = [];
        if (s.fixable) parts.push(`${s.fixable} limpiable(s) con --fix del reviewer`);
        if (s.reportOnly) parts.push(`${s.reportOnly} requieren decisión humana`);
        return { ok: false, msg: `${s.total} referencia(s) rota(s): ${parts.join(' + ')}` };
      } catch { return { ok: true, msg: 'reviewer no disponible — omitido' }; }
    },
    fix: 'node .agentic/grafo/graph-reviewer.cjs --fix',
  },
];

// ─── RUNNER ───────────────────────────────────────────────────────────────────

function runHealthCheck(projectRoot, opts = {}) {
  const results = CHECKS.map(check => {
    let result;
    try { result = check.check(projectRoot); }
    catch (e) { result = { ok: false, msg: `Error: ${e.message}` }; }
    return { id: check.id, nombre: check.nombre, categoria: check.categoria, ...result, fix: check.fix };
  });

  const ok    = results.filter(r => r.ok).length;
  const fail  = results.filter(r => !r.ok).length;
  const score = Math.round((ok / results.length) * 100);

  return { results, ok, fail, total: results.length, score, projectRoot };
}

// ─── AUTO-FIX ─────────────────────────────────────────────────────────────────

function autoFix(projectRoot) {
  const { results } = runHealthCheck(projectRoot);
  const failed = results.filter(r => !r.ok && r.fix);

  if (failed.length === 0) {
    console.log('\n✅ Sin fixes automáticos necesarios.');
    return;
  }

  console.log(`\n[HEALTH-CHECK] Ejecutando ${failed.length} fixes automáticos...\n`);
  const { execSync } = require('child_process');

  failed.forEach(r => {
    console.log(`  Fixing: ${r.nombre}`);
    console.log(`  Cmd:    ${r.fix}`);
    try {
      execSync(r.fix, { cwd: projectRoot, stdio: 'pipe', timeout: 60000 });
      console.log(`  ✅ OK\n`);
    } catch (e) {
      console.log(`  ⚠️  Parcial: ${e.message.substring(0, 80)}\n`);
    }
  });
}

// ─── PRINT ────────────────────────────────────────────────────────────────────

function printHealthCheck(report) {
  const { results, ok, fail, score } = report;
  const categories = [...new Set(results.map(r => r.categoria))];

  console.log('\n═══════════════════════════════════════════════════');
  console.log(`  Agentic KDD — Health Check`);
  console.log(`  Score: ${score}%  (${ok}/${results.length} OK)`);
  console.log('═══════════════════════════════════════════════════');

  categories.forEach(cat => {
    const catResults = results.filter(r => r.categoria === cat);
    console.log(`\n  ── ${cat.toUpperCase()} `);
    catResults.forEach(r => {
      const icon = r.ok ? '✅' : '❌';
      console.log(`  ${icon} ${r.nombre.padEnd(35)} ${r.msg}`);
      if (!r.ok && r.fix) console.log(`     Fix: ${r.fix}`);
    });
  });

  if (fail > 0) {
    console.log(`\n  Para arreglar todo: node .agentic/grafo/health-check.cjs --fix`);
  }
  console.log('═══════════════════════════════════════════════════\n');
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const projectRoot = process.cwd();

  if (args.includes('--json')) {
    const report = runHealthCheck(projectRoot);
    console.log(JSON.stringify(report, null, 2));
  } else if (args.includes('--fix')) {
    const report = runHealthCheck(projectRoot);
    printHealthCheck(report);
    autoFix(projectRoot);
    // Re-run después de fixes
    const reportAfter = runHealthCheck(projectRoot);
    console.log(`\nDespués de fixes: ${reportAfter.score}% (${reportAfter.ok}/${reportAfter.total} OK)`);
  } else {
    const report = runHealthCheck(projectRoot);
    printHealthCheck(report);
  }
}

module.exports = { runHealthCheck, printHealthCheck, autoFix, CHECKS };
