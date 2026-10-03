/**
 * Agentic KDD MCP Server — v2.0
 * Expone TODOS los módulos v3 como MCP tools nativos.
 *
 * Tools nuevas en v2.0:
 *   ast_impact       — analyzeImpact(target)
 *   ast_index        — indexProject()
 *   ast_symbols      — getSymbols(file)
 *   spec_waves       — getWaves(module)
 *   spec_status      — getStatus(module)
 *   spec_create      — createSpec(module, tipo)
 *   impact_precheck  — preCheck(module)
 *   impact_diff      — analyzeDiff(files[])
 *   knowledge_query  — queryKnowledge(module)
 *   adr_ingest       — ingestADRs(dir?)
 *   causal_add       — addCausalEdge(desde, tipo, hacia, descripcion)
 *   causal_query     — queryCausalEdges(tipo?, entidad?)
 *   decision_trail   — getCicloTrail(ciclo_id)
 *   decision_why     — whyExists(target)
 *   metrics_summary  — computeMetrics()
 *   health_check     — runHealthCheck()
 *   memory_audit     — generateAuditReport()
 *   memory_forget    — forgetMemory(id, razon)
 *
 * Transporte: stdio (compatible con Cursor, Claude Code, VS Code)
 *
 * Uso:
 *   node .agentic/grafo/mcp-server.cjs
 *   (registrar como MCP server en .cursor/mcp.json o claude_desktop_config.json)
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const readline = require('readline');

const ROOT = process.env.PROJECT_ROOT || process.cwd();
process.stderr.write('[Agentic KDD MCP] Starting — ROOT: ' + ROOT + '\n');

// Add project node_modules to require path at startup
// This ensures native deps (better-sqlite3) resolve when Cursor starts the server
const projectNodeModules = path.join(ROOT, 'node_modules');
if (fs.existsSync(projectNodeModules)) {
  module.paths.unshift(projectNodeModules);
  process.stderr.write('[Agentic KDD MCP] node_modules: ' + projectNodeModules + '\n');
}

// Validate DB exists
const DB_PATH = path.join(ROOT, '.agentic/memoria.db');
if (!fs.existsSync(DB_PATH)) {
  process.stderr.write('[Agentic KDD MCP] ⚠️ DB not found at ' + DB_PATH + '\n');
  process.stderr.write('[Agentic KDD MCP] Run: akdd init\n');
}

/* La versión sale del manifiesto que viaja con el motor (generado desde el
   package.json de Agentix por scripts/sync-version.cjs). Sin manifiesto se
   anuncia 'unknown', nunca una cifra fija que se desfase. */
function versionFramework() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'framework.json'), 'utf8')).version || 'unknown'; }
  catch { return 'unknown'; }
}

// ─── LAZY LOADERS ─────────────────────────────────────────────────────────────
// Carga cada módulo bajo demanda — el MCP server arranca sin cargar todo.

function loadModule(name) {
  const p = path.join(ROOT, '.agentic/grafo', name);
  if (fs.existsSync(p)) {
    // Temporarily add project node_modules to require path so native deps resolve
    const projectNodeModules = path.join(ROOT, 'node_modules');
    if (fs.existsSync(projectNodeModules) && !module.paths.includes(projectNodeModules)) {
      module.paths.unshift(projectNodeModules);
    }
    try { return require(p); }
    catch(e) {
      process.stderr.write('[Agentic KDD MCP] ⚠️ Error loading ' + name + ': ' + e.message + '\n');
      return null;
    }
  }
  process.stderr.write('[Agentic KDD MCP] ⚠️ Module not found: ' + name + ' (ROOT=' + ROOT + ')\n');
  return null;
}

function getDB() {
  const dbPath = path.join(ROOT, '.agentic/memoria.db');

  // Try project node_modules first (works when Cursor starts server from system node)
  const localSqlite = path.join(ROOT, 'node_modules', 'better-sqlite3');
  if (fs.existsSync(localSqlite)) {
    try { return new (require(localSqlite))(dbPath); } catch(e) {
      process.stderr.write('[Agentic KDD MCP] local better-sqlite3 error: ' + e.message + '\n');
    }
  }

  // Try global require
  try { return new (require('better-sqlite3'))(dbPath); } catch {}

  // Fallback: Node.js built-in sqlite (Node 22+)
  try { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(dbPath); } catch {}

  process.stderr.write('[Agentic KDD MCP] ⚠️  No SQLite driver found. Run: npm install better-sqlite3 in project.\n');
  return null;
}

// ─── DEFINICIÓN DE TOOLS ──────────────────────────────────────────────────────

const TOOLS = [
  // ── CORE (v1, ya existían) ────────────────────────────────────────────────
  {
    name: 'grafo_buscar',
    description: 'Búsqueda híbrida en las 4 capas de memoria CoALA (procedural + episódica + semántica). Retorna los items más relevantes para la tarea actual.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Descripción de la tarea o concepto a buscar' },
        area: { type: 'string', description: 'Área o módulo del proyecto (opcional)' },
        limit: { type: 'number', description: 'Máximo de resultados (default: 10)' },
      },
      required: ['query'],
    },
    handler: async ({ query, area, limit = 10 }) => {
      const g = loadModule('grafo.cjs');
      const r = g.buscarHibrido ? g.buscarHibrido(query, area, limit) : [];
      return { resultados: r };
    },
  },
  {
    name: 'registrar_episodio',
    description: 'Registra un episodio crudo en memoria episódica. Usar al final de cada ciclo para preservar lo que ocurrió.',
    inputSchema: {
      type: 'object',
      properties: {
        episodio: { type: 'object', description: 'Objeto episodio con: tipo, descripcion, resultado, archivos_tocados, area' },
      },
      required: ['episodio'],
    },
    handler: async ({ episodio }) => {
      const g = loadModule('grafo.cjs');
      const id = g.registrarEpisodio ? g.registrarEpisodio(episodio) : null;
      return { episodio_id: id };
    },
  },
  {
    name: 'grafo_sync',
    description: 'Sincroniza la memoria markdown (.md) con el grafo SQLite. Ejecutar al final de cada ciclo.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      const g = loadModule('grafo.cjs');
      const r = g.sincronizar ? g.sincronizar() : { ok: false };
      return r;
    },
  },
  {
    name: 'grafo_coala',
    description: 'Stats completo de las 4 capas CoALA de memoria del proyecto.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      const g = loadModule('grafo.cjs');
      if (g.statsCoala) g.statsCoala();
      return { ok: true };
    },
  },

  // ── AST (v2 nuevo) ────────────────────────────────────────────────────────
  {
    name: 'ast_impact',
    description: 'Analiza el impacto de tocar un archivo o módulo. Retorna dependencias directas, indirectas, historial causal y severidad ALTO/MEDIO/BAJO.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Ruta relativa del archivo o nombre del módulo' },
      },
      required: ['target'],
    },
    handler: async ({ target }) => {
      const m = loadModule('impact-analyzer.cjs');
      const db = getDB();
      return m.analyzeImpact(db, target);
    },
  },
  {
    name: 'ast_index',
    description: 'Indexa el proyecto en el grafo AST. Extrae símbolos, imports, call graph y calcula PageRank. Ejecutar una vez por sesión o cuando cambien muchos archivos.',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Subdirectorio a indexar (opcional, default: proyecto completo)' },
      },
      required: [],
    },
    handler: async ({ dir }) => {
      const m = loadModule('ast-indexer.cjs');
      return m.indexProject(ROOT, dir);
    },
  },
  {
    name: 'ast_symbols',
    description: 'Retorna todos los símbolos (funciones, clases, exports) de un archivo específico.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Ruta relativa del archivo' },
      },
      required: ['file'],
    },
    handler: async ({ file }) => {
      const db = getDB();
      try {
        const symbols = db.prepare('SELECT symbol_name, kind, line_start, exported, pagerank FROM ast_symbols WHERE file = ? ORDER BY line_start').all(file);
        return { file, symbols };
      } catch { return { file, symbols: [], error: 'AST no indexado' }; }
    },
  },

  // ── IMPACT (v2 nuevo) ─────────────────────────────────────────────────────
  {
    name: 'impact_precheck',
    description: 'Pre-check de impacto para un módulo. Combina AST + causal + knowledge. Usar ANTES de planificar cualquier cambio.',
    inputSchema: {
      type: 'object',
      properties: {
        modulo: { type: 'string', description: 'Nombre del módulo o ruta del archivo' },
      },
      required: ['modulo'],
    },
    handler: async ({ modulo }) => {
      const m = loadModule('impact-analyzer.cjs');
      return m.preCheck(ROOT, modulo);
    },
  },
  {
    name: 'impact_diff',
    description: 'Analiza el impacto combinado de un conjunto de archivos que se van a modificar. Retorna severidad máxima y recomendaciones.',
    inputSchema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string' }, description: 'Array de rutas relativas de archivos a modificar' },
      },
      required: ['files'],
    },
    handler: async ({ files }) => {
      const m = loadModule('impact-analyzer.cjs');
      const db = getDB();
      return m.analyzeDiff(db, files);
    },
  },

  // ── SPECS (v2 nuevo) ──────────────────────────────────────────────────────
  {
    name: 'spec_waves',
    description: 'Retorna las waves de ejecución de un módulo (wave 1 = tareas sin deps, wave 2 = deps de wave 1, etc.). Usar para saber exactamente qué ejecutar ahora.',
    inputSchema: {
      type: 'object',
      properties: {
        modulo: { type: 'string', description: 'Nombre del módulo' },
      },
      required: ['modulo'],
    },
    handler: async ({ modulo }) => {
      const m = loadModule('spec-manager.cjs');
      const specDir = path.join(ROOT, '.agentic/specs', modulo);
      const tasksPath = path.join(specDir, 'tasks.md');
      if (!fs.existsSync(tasksPath)) return { error: `spec '${modulo}' no tiene tasks.md` };
      const tasks = m.parseTasks(fs.readFileSync(tasksPath, 'utf8'));
      const { waves, blocked, errors } = m.buildWaves(tasks);
      return { modulo, waves: waves.map((w, i) => ({ wave: i + 1, tasks: w })), not_runnable: blocked || [], errors: errors || [] };
    },
  },
  {
    name: 'spec_status',
    description: 'Estado actual de un spec: progreso, tareas completadas, bloqueadas, próxima wave.',
    inputSchema: {
      type: 'object',
      properties: {
        modulo: { type: 'string', description: 'Nombre del módulo' },
      },
      required: ['modulo'],
    },
    handler: async ({ modulo }) => {
      const m = loadModule('spec-manager.cjs');
      const specDir = path.join(ROOT, '.agentic/specs', modulo);
      return m.getSpecStatus(specDir) ?? { error: `spec '${modulo}' no encontrado` };
    },
  },
  {
    name: 'spec_create',
    description: 'Crea un spec nuevo para un módulo (feature o bugfix). Genera requirements.md + design.md + tasks.md con template.',
    inputSchema: {
      type: 'object',
      properties: {
        modulo: { type: 'string', description: 'Nombre del módulo' },
        tipo: { type: 'string', enum: ['feature', 'bugfix'], description: 'Tipo de spec (default: feature)' },
      },
      required: ['modulo'],
    },
    handler: async ({ modulo, tipo = 'feature' }) => {
      const m = loadModule('spec-manager.cjs');
      const dir = m.createSpecFromTemplate(ROOT, modulo, tipo);
      return { created: true, path: path.relative(ROOT, dir) };
    },
  },

  // ── KNOWLEDGE (v2 nuevo) ──────────────────────────────────────────────────
  {
    name: 'knowledge_query',
    description: 'Consulta la base de conocimiento (ADRs y gotchas) para un módulo. Retorna decisiones arquitectónicas y restricciones aplicables.',
    inputSchema: {
      type: 'object',
      properties: {
        modulo: { type: 'string', description: 'Módulo o área a consultar' },
        tipo: { type: 'string', description: 'Filtrar por tipo: adr | gotcha | convention (opcional)' },
      },
      required: [],
    },
    handler: async ({ modulo, tipo }) => {
      const m = loadModule('adr-ingestor.cjs');
      const db = getDB();
      return m.queryKnowledge(db, { modulo, tipo, status: 'accepted' });
    },
  },
  {
    name: 'adr_ingest',
    description: 'Ingesta ADRs del directorio docs/adr/ en el grafo de conocimiento.',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Directorio de ADRs (default: docs/adr)' },
      },
      required: [],
    },
    handler: async ({ dir = 'docs/adr' }) => {
      const m = loadModule('adr-ingestor.cjs');
      return m.ingestDirectory(ROOT, dir);
    },
  },

  // ── CAUSAL EDGES (v2 nuevo) ───────────────────────────────────────────────
  {
    name: 'causal_add',
    description: 'Registra un edge causal en memoria. Tipos: caused_failure, was_fixed_by, tested_by, regressed_by.',
    inputSchema: {
      type: 'object',
      properties: {
        desde: { type: 'string', description: 'Entidad origen (archivo o módulo)' },
        tipo: { type: 'string', enum: ['caused_failure','was_fixed_by','tested_by','regressed_by','depends_on_decision'] },
        hacia: { type: 'string', description: 'Entidad destino' },
        descripcion: { type: 'string', description: 'Descripción del edge' },
        confidence: { type: 'string', enum: ['BAJA','MEDIA','ALTA'], description: 'Confianza del edge' },
      },
      required: ['desde', 'tipo', 'hacia'],
    },
    handler: async ({ desde, tipo, hacia, descripcion = '', confidence = 'MEDIA' }) => {
      const m = loadModule('causal-edges.cjs');
      const db = getDB();
      return m.addCausalEdge(db, { desde_entidad: desde, tipo, hacia_entidad: hacia, descripcion, confidence });
    },
  },
  {
    name: 'causal_query',
    description: 'Consulta edges causales. Usar para entender qué causó qué en el proyecto.',
    inputSchema: {
      type: 'object',
      properties: {
        tipo: { type: 'string', description: 'Tipo de edge a filtrar (opcional)' },
        entidad: { type: 'string', description: 'Entidad a consultar (opcional)' },
        includeHistory: { type: 'boolean', description: 'Incluir edges invalidados' },
      },
      required: [],
    },
    handler: async ({ tipo, entidad, includeHistory = false }) => {
      const m = loadModule('causal-edges.cjs');
      const db = getDB();
      return m.queryCausalEdges(db, { tipo, entidad, includeHistory });
    },
  },

  // ── DECISION TRAIL (v2 nuevo) ─────────────────────────────────────────────
  {
    name: 'decision_trail',
    description: 'Trail completo de un ciclo: qué cambió, qué memoria influyó, qué quedó invalidado.',
    inputSchema: {
      type: 'object',
      properties: {
        ciclo_id: { type: 'string', description: 'ID del ciclo' },
      },
      required: ['ciclo_id'],
    },
    handler: async ({ ciclo_id }) => {
      const m = loadModule('decision-trail.cjs');
      const db = getDB();
      return m.getCicloTrail(db, ciclo_id);
    },
  },
  {
    name: 'decision_why',
    description: 'Explica por qué existe algo en el código/memoria: cadena causal + ADRs + episodios históricos.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Archivo, módulo o entidad a explicar' },
      },
      required: ['target'],
    },
    handler: async ({ target }) => {
      const m = loadModule('decision-trail.cjs');
      const db = getDB();
      return m.whyExists(db, target);
    },
  },

  // ── MÉTRICAS (v2 nuevo) ───────────────────────────────────────────────────
  {
    name: 'metrics_summary',
    description: 'Métricas operacionales del proyecto: tasa de éxito, retrabajo, calidad de memoria, autonomy score y tokens: uso real del proveedor y estimado por separado; ahorro solo si hay benchmark comparable (si no, null).',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      const m = loadModule('metrics.cjs');
      const db = getDB();
      return {
        cycles: m.computeCycleMetrics(db),
        memory: m.computeMemoryMetrics(db),
        autonomy: m.computeAutonomyScore(db),
        tokens: m.estimateTokenSavings(db, ROOT),
      };
    },
  },

  // ── HEALTH CHECK (v2 nuevo) ───────────────────────────────────────────────
  {
    name: 'health_check',
    description: 'Diagnóstico completo del sistema: qué funciona, qué falta, qué comando ejecutar para arreglarlo.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      const m = loadModule('health-check.cjs');
      return m.runHealthCheck(ROOT);
    },
  },

  // ── MEMORY AUDIT (v2 nuevo) ───────────────────────────────────────────────
  {
    name: 'memory_audit',
    description: 'Reporte de auditoría de memoria: entradas stale, contradicciones, consolidaciones propuestas.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      const m = loadModule('memory-audit.cjs');
      const db = getDB();
      m.migrateVigenciaTipo(db);
      return m.generateAuditReport(db);
    },
  },
  {
    name: 'memory_forget',
    description: 'Olvida explícitamente una entrada de memoria con evidencia. No borra — invalida con razón documentada.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'ID del nodo a olvidar' },
        razon: { type: 'string', description: 'Razón por la que se invalida (requerido para audit trail)' },
      },
      required: ['id', 'razon'],
    },
    handler: async ({ id, razon }) => {
      const m = loadModule('memory-audit.cjs');
      const db = getDB();
      return m.forgetMemory(db, id, razon, ROOT);
    },
  },
  {
    name: 'verdad_vigente',
    description: 'Retorna SOLO la memoria vigente (no histórica, no evidencia, no obsoleta). Úsalo en lugar de grafo_buscar cuando necesitas reglas que aplican HOY.',
    inputSchema: {
      type: 'object',
      properties: {
        area: { type: 'string', description: 'Área o módulo del proyecto' },
        tipo: { type: 'string', description: 'Tipo de nodo: error | patron | decision' },
        limit: { type: 'number', description: 'Máximo de resultados (default: 20)' },
      },
      required: [],
    },
    handler: async ({ area, tipo, limit = 20 }) => {
      const m = loadModule('memory-audit.cjs');
      const db = getDB();
      m.migrateVigenciaTipo(db);
      return m.verdadVigente(db, area, tipo, limit);
    },
  },
];

// ─── MCP PROTOCOL (JSON-RPC 2.0 over stdio) ───────────────────────────────────

// 3.20.1 — durante `akdd update` este servidor PAUSA (deja de atender herramientas), lo
// CONFIRMA con un ack y se reanuda solo al terminar. Solo en un proyecto Agentix de verdad:
// registrarse crearía carpetas en cualquier otro directorio.
let _pausadoPorUpdate = false;
try {
  if (fs.existsSync(path.join(ROOT, '.agentic', 'grafo'))) {
    const _escritor = require('./update-guard.cjs').registerWriter(ROOT, 'mcp', {
      onPause: () => { _pausadoPorUpdate = true; },
      onResume: () => { _pausadoPorUpdate = false; },
    });
    process.on('exit', () => { try { _escritor.stop(); } catch { /* ya cerrado */ } });
  }
} catch { /* motor sin update-guard: no hay exclusión que respetar */ }

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }

  const { id, method, params } = request;
  // JSON-RPC: una notificación (sin id, p. ej. notifications/initialized) no
  // lleva respuesta. Antes se contestaba con un error sin id, que algunos
  // clientes registran como fallo del servidor.
  if (id === undefined || id === null) return;
  if (_pausadoPorUpdate && method === 'tools/call') {
    sendError(id, -32000, 'UPDATE_IN_PROGRESS: akdd update está actualizando este proyecto; reintenta en unos segundos.');
    return;
  }

  try {
    if (method === 'ping') {
      sendResponse(id, {});
    } else if (method === 'initialize') {
      sendResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'agentic-kdd', version: versionFramework() },
      });
    } else if (method === 'tools/list') {
      sendResponse(id, {
        tools: TOOLS.map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    } else if (method === 'tools/call') {
      const { name, arguments: args = {} } = params;
      const tool = TOOLS.find(t => t.name === name);
      if (!tool) {
        sendError(id, -32601, `Tool '${name}' no encontrada`);
        return;
      }
      // Las tools dinámicas (v3.2+/CLI/v3.3+/autonomous/v3.4+/v3.5) se pushean a TOOLS
      // sin handler; sus handlers viven en TOOL_MAP. Resolver desde ambos.
      const handler = tool.handler || (TOOL_MAP[name] && TOOL_MAP[name].handler);
      if (!handler) {
        sendError(id, -32603, `Tool '${name}' sin handler`);
        return;
      }
      const inicio = Date.now();
      try {
        const result = await handler(args);
        // Actividad real de una herramienta de Agentix: se anota en la memoria con procedencia (silencioso, no bloquea).
        try { require(path.join(ROOT, '.agentic/grafo/mcp-contexto-tools.cjs')).registrarLlamada(ROOT, name, args, true, Date.now() - inicio); } catch { /* módulo ausente */ }
        sendResponse(id, {
          content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
        });
      } catch (e) {
        sendError(id, -32603, `Error ejecutando ${name}: ${e.message}`);
      }
    } else {
      sendError(id, -32601, `Método '${method}' no soportado`);
    }
  } catch (e) {
    sendError(id, -32603, e.message);
  }
});

function sendResponse(id, result) {
  const response = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(response + '\n');
}

function sendError(id, code, message) {
  const response = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  process.stdout.write(response + '\n');
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

console.error(`[Agentic KDD MCP v2.0] ${TOOLS.length} tools disponibles. ROOT: ${ROOT}`);

// ─── v3.2: TOOLS ADICIONALES ──────────────────────────────────────────────────
// mem_curate, generate_llms_txt, report_benchmarks, causal_prune

// Lookup map para tools registradas dinámicamente (v3.2+)
const TOOL_MAP = {};

// Añadir al TOOL_MAP y TOOLS en runtime
const TOOLS_V32 = [
  {
    name: 'mem_curate',
    description: 'Curation autónoma de memoria: TTL, deduplicación semántica, resolución de conflictos, scores.',
    inputSchema: { type:'object', properties:{ mode:{type:'string',enum:['run','ttl','dedup','conflicts','score','report']} }, required:[] },
  },
  {
    name: 'generate_llms_txt',
    description: 'Genera .agentic/llms.txt, llms-full.txt y knowledge-graph.json para Git versioning.',
    inputSchema: { type:'object', properties:{}, required:[] },
  },
  {
    name: 'report_benchmarks',
    description: 'LongMemEval + Token Reduction Index + Memory Quality Score. Evidencia pública de valor.',
    inputSchema: { type:'object', properties:{}, required:[] },
  },
  {
    name: 'causal_prune',
    description: 'Prune semántico del grafo causal. Previene colapso de contexto por exceso de edges.',
    inputSchema: { type:'object', properties:{ maxPerEntity:{type:'number'}, ageDays:{type:'number'} }, required:[] },
  },
];

// Handler dinámico para tools v3.2
async function handleV32Tool(name, args={}) {
  switch(name) {
    case 'mem_curate': {
      const m = require(path.join(ROOT, '.agentic/grafo/mem-curator.cjs'));
      const db = getDB();
      const mode = args.mode || 'run';
      return mode==='ttl' ? m.enforceEpisodicTTL(db,ROOT)
        : mode==='dedup' ? m.deduplicateNodes(db,ROOT)
        : mode==='conflicts' ? m.resolveConflicts(db,ROOT)
        : mode==='score' ? m.recalculateScores(db,ROOT)
        : mode==='report' ? m.generateReport(ROOT)
        : m.runCuration(ROOT);
    }
    case 'generate_llms_txt': {
      const m = require(path.join(ROOT, '.agentic/grafo/llms-generator.cjs'));
      return m.generateAll(ROOT);
    }
    case 'report_benchmarks': {
      const m = require(path.join(ROOT, '.agentic/grafo/metrics.cjs'));
      const db = getDB();
      return m.computeReportBenchmarks(db, ROOT);
    }
    case 'causal_prune': {
      const m = require(path.join(ROOT, '.agentic/grafo/causal-edges.cjs'));
      const db = getDB();
      return m.pruneEdges ? m.pruneEdges(db, args) : { error: 'pruneEdges no disponible' };
    }
    default: return { error: `Tool v3.2 '${name}' no encontrada` };
  }
}

// Registrar en el servidor existente
TOOLS.push(...TOOLS_V32);
TOOLS_V32.forEach(t => { TOOL_MAP[t.name] = { ...t, handler: (args) => handleV32Tool(t.name, args) }; });

process.stderr.write('[Agentic KDD MCP v3.2] +4 tools v3.2 registradas (mem_curate, generate_llms_txt, report_benchmarks, causal_prune)\n');

// ─── v3.2: CLI UNIFICATION — Tools que hoy solo existen en terminal ───────────
// El dev nunca sale del chat del IDE para hacer init, update, collab.

const TOOLS_CLI = [
  {
    name: 'init_project',
    description: 'Instala Agentic KDD en el proyecto actual. Equivale a correr "akdd init" en terminal. Configura MCP automáticamente.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'update_project',
    description: 'Actualiza el motor del proyecto con el que trae el paquete agentic-kdd instalado (GitHub solo con --ref). Equivale a "akdd update". memoria.db, los Markdown de memoria y la config no se tocan; el esquema solo migra con --migrate.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'collab_init',
    description: 'Activa el modo colaborativo. Crea la base de datos compartida automáticamente en Turso. Equivale a "akdd collab init".',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'collab_invite',
    description: 'Genera un código de invitación temporal (24h, un solo uso) para que un miembro del equipo se una. Equivale a "akdd collab invite".',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'collab_status',
    description: 'Muestra el estado del modo colaborativo: DB activa, último sync, conexión.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'system_health',
    description: 'Diagnóstico completo del sistema Agentic KDD. Equivale a "akdd health". Retorna qué está configurado y qué falta.',
    inputSchema: {
      type: 'object',
      properties: {
        fix: { type: 'boolean', description: 'Intentar arreglar automáticamente los problemas detectados' },
      },
      required: [],
    },
  },
];

async function handleCLITool(name, args={}) {
  const { execSync } = require('child_process');
  const run = (cmd) => {
    try {
      const out = execSync(cmd, { cwd: ROOT, stdio: 'pipe', timeout: 60000 }).toString();
      return { ok: true, output: out };
    } catch (e) {
      return { ok: false, output: e.stdout?.toString() || e.message };
    }
  };

  switch(name) {
    case 'init_project':
      return run('akdd init --non-interactive');

    case 'update_project':
      return run('akdd update');

    case 'collab_init': {
      const m = require(path.join(ROOT, '.agentic/grafo/collab-manager.cjs'));
      return m.collabInit(ROOT);
    }

    case 'collab_invite': {
      // Leer config del proyecto
      const fs = require('fs');
      const configPath = path.join(ROOT, '.agentic/collab.json');
      if (!fs.existsSync(configPath)) {
        return { ok: false, error: 'Modo colaborativo no activado. Usar collab_init primero.' };
      }
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const projectId = config.project_id;

      // Llamar al Worker
      const PROVISIONER_URL = 'https://agentic-collab.adrianlpz-game.workers.dev';
      try {
        const response = await fetch(`${PROVISIONER_URL}/invite`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId }),
        });
        const result = await response.json();
        return result;
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }

    case 'collab_status': {
      const m = require(path.join(ROOT, '.agentic/grafo/collab-manager.cjs'));
      // status() usa console.log, capturamos
      const config = m.loadConfig(ROOT);
      if (!config?.enabled) return { enabled: false, message: 'Collab no activado. Usar collab_init.' };
      return {
        enabled: true,
        db: config.db || config.url,
        member_id: config.member_id,
        last_sync: config.last_sync,
        sync_on_cycle_end: config.sync_on_cycle_end,
      };
    }

    case 'system_health': {
      const m = require(path.join(ROOT, '.agentic/grafo/health-check.cjs'));
      return m.runHealthCheck(ROOT);
    }

    default:
      return { error: `CLI tool '${name}' no encontrada` };
  }
}

// Registrar tools CLI en el servidor
TOOLS.push(...TOOLS_CLI);
TOOLS_CLI.forEach(t => {
  TOOL_MAP[t.name] = { ...t, handler: (args) => handleCLITool(t.name, args) };
});

process.stderr.write('[Agentic KDD MCP] +6 CLI tools registradas — init_project, update_project, collab_init, collab_invite, collab_status, system_health\n');

// ─── v3.3: CONTRACT GUARD + CREATIVE ENGINE MCP TOOLS ────────────────────────

const TOOLS_V33 = [
  { name: 'contracts_status',  description: 'Contract Guard status — protected, verified, candidate, violations.', inputSchema: {type:'object',properties:{},required:[]} },
  { name: 'contracts_list',    description: 'List verified contracts. Filter by module.', inputSchema: {type:'object',properties:{module:{type:'string'}},required:[]} },
  { name: 'contracts_blast',   description: 'Blast radius for a file — how many contracts at risk if this file changes.', inputSchema: {type:'object',properties:{file:{type:'string'}},required:['file']} },
  { name: 'contracts_gate',    description: 'Run Preservation Gate — checks all verified contracts still pass. Call before accepting changes.', inputSchema: {type:'object',properties:{modified_files:{type:'array',items:{type:'string'}}},required:[]} },
  { name: 'creative_level',    description: 'Current Creative Engine level (0=strict, 1=assisted, 2=creative_controlled). Shows how many contracts needed for level 2.', inputSchema: {type:'object',properties:{},required:[]} },
  { name: 'creative_suggest',  description: 'List pending creative suggestions — simplifications, refactors, missing tests, fragility warnings.', inputSchema: {type:'object',properties:{module:{type:'string'}},required:[]} },
  { name: 'creative_apply',    description: 'Apply a creative suggestion (only if auto_applicable=true and blast_radius≤3).', inputSchema: {type:'object',properties:{id:{type:'string'}},required:['id']} },
  { name: 'creative_wins',     description: 'Show applied creative improvements and their impact.', inputSchema: {type:'object',properties:{},required:[]} },
  { name: 'pipeline_step',     description: 'Register one aa: pipeline step through the harness (PRE/EXEC/POST). Reasoning steps need the agent output; tdd runs the gate. Same event_id twice runs once.', inputSchema: {type:'object',properties:{step:{type:'string',enum:['context_guard','analyst','implementation','tdd','qa','review','memory']},cycle_id:{type:'string'},output:{type:'object'},event_id:{type:'string'},area:{type:'string'}},required:['step']} },
  { name: 'pipeline_gate',     description: 'Register a structured surface gate result (preservation, test-integrity, browser, visual) for the current aa: cycle. Only PASS of the same subject and policy closes it.', inputSchema: {type:'object',properties:{cycle_id:{type:'string'},result:{type:'object'}},required:['result']} },
  { name: 'pipeline_status',   description: 'State of the current aa: cycle in the pipeline controller and whether it can close.', inputSchema: {type:'object',properties:{cycle_id:{type:'string'}},required:[]} },
];

async function handleV33Tool(name, args={}) {
  switch(name) {
    case 'contracts_status': {
      const m = require(path.join(ROOT, '.agentic/grafo/contract-guard.cjs'));
      const db = getDB(); m.migrateSchema(db); return m.getStatus(db);
    }
    case 'contracts_list': {
      const m = require(path.join(ROOT, '.agentic/grafo/contract-guard.cjs'));
      const db = getDB(); return m.listContracts(db, args.module);
    }
    case 'contracts_blast': {
      const m = require(path.join(ROOT, '.agentic/grafo/contract-guard.cjs'));
      const db = getDB(); return m.getBlastRadiusReport(db, ROOT, args.file);
    }
    case 'contracts_gate': {
      const m = require(path.join(ROOT, '.agentic/grafo/contract-guard.cjs'));
      const db = getDB(); m.migrateSchema(db);
      return m.runPreservationGate(db, ROOT, `mcp-${Date.now()}`, args.modified_files || []);
    }
    case 'pipeline_step':
    case 'pipeline_gate':
    case 'pipeline_status': {
      const pc = require(path.join(ROOT, '.agentic/grafo/pipeline-controller.cjs'));
      let cycleId = args.cycle_id;
      if (!cycleId) {
        const c = require(path.join(ROOT, '.agentic/grafo/ciclo-actual.cjs')).actual(ROOT);
        cycleId = c && c.cycle_id;
      }
      if (!cycleId) return { status: 'ERROR', reason: 'sin ciclo en curso: pasa cycle_id o corre el context-enricher' };
      if (name === 'pipeline_status') return { estado: pc.cargar(ROOT, cycleId), cierre: pc.puedeCerrar(ROOT, cycleId) };
      if (name === 'pipeline_gate') return pc.registrarGate(ROOT, cycleId, Object.assign({}, args.result, { source: 'mcp' }));
      return await pc.paso(ROOT, { cycle_id: cycleId, step: args.step, output: args.output, event_id: args.event_id, area: args.area, source: 'mcp', quiet: true });
    }
    case 'creative_level': {
      const m = require(path.join(ROOT, '.agentic/grafo/creative-engine.cjs'));
      const db = getDB(); m.migrateSchema(db); return m.getCurrentLevel(db, ROOT);
    }
    case 'creative_suggest': {
      const m = require(path.join(ROOT, '.agentic/grafo/creative-engine.cjs'));
      const db = getDB(); m.migrateSchema(db); return m.getSuggestions(db, args.module);
    }
    case 'creative_apply': {
      const m = require(path.join(ROOT, '.agentic/grafo/creative-engine.cjs'));
      const db = getDB(); m.migrateSchema(db);
      return m.applySuggestion(db, args.id, ROOT, `mcp-${Date.now()}`);
    }
    case 'creative_wins': {
      const m = require(path.join(ROOT, '.agentic/grafo/creative-engine.cjs'));
      const db = getDB(); m.migrateSchema(db); return m.getCreativeWins(db);
    }
    default: return { error: `V33 tool '${name}' not found` };
  }
}

TOOLS.push(...TOOLS_V33);
TOOLS_V33.forEach(t => { TOOL_MAP[t.name] = { ...t, handler: (args) => handleV33Tool(t.name, args) }; });
process.stderr.write('[Agentic KDD MCP] +8 v3.3 tools (contracts_status, contracts_blast, contracts_gate, creative_level, creative_suggest, creative_apply, creative_wins)\n');

// ─── v3.3: SESSION GUARD MCP TOOL ────────────────────────────────────────────
TOOLS.push({
  name: 'session_historial',
  description: 'Recupera el checkpoint de la última sesión. Úsalo al inicio de un chat nuevo para retomar el contexto exacto de donde quedaste.',
  inputSchema: { type: 'object', properties: {}, required: [] },
});
TOOL_MAP['session_historial'] = {
  name: 'session_historial',
  description: 'Recupera el último checkpoint de sesión.',
  inputSchema: { type: 'object', properties: {}, required: [] },
  handler: async () => {
    try {
      const m = require(path.join(ROOT, '.agentic/grafo/session-guard.cjs'));
      return m.generateCheckpoint(ROOT) || { message: 'Sin ciclos todavía — corre aa: primero' };
    } catch (e) { return { error: e.message }; }
  }
};
process.stderr.write('[Agentic KDD MCP] +1 session_historial tool\n');

// ─── v3.3: AUTONOMOUS DECISION ENGINE MCP TOOLS ──────────────────────────────
const TOOLS_AUTONOMOUS = [
  {
    name: 'autonomous_decide',
    description: 'Analyzes a proposed change and returns: STOP/WARN/IMPLEMENT/IMPLEMENT_CAUTIOUS/DEFER. Checks blast radius, prerequisite chain, cross-module patterns, and contract status. Use before any significant change.',
    inputSchema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string' }, description: 'Files to be modified' },
        task:  { type: 'string', description: 'Task description' },
        error_signatures: { type: 'array', items: { type: 'string' }, description: 'Error signatures detected' },
      },
      required: ['files'],
    },
  },
  {
    name: 'autonomous_sprint',
    description: 'Generates a sprint plan combining business objective with technical findings. Pass objective, priorities and constraints — Agentic produces an executable priority-ordered plan.',
    inputSchema: {
      type: 'object',
      properties: {
        objective:   { type: 'string', description: 'Sprint objective' },
        priorities:  { type: 'array', items: { type: 'string' }, description: 'Business priorities' },
        constraints: { type: 'array', items: { type: 'string' }, description: 'Things not to touch' },
      },
      required: ['objective'],
    },
  },
  {
    name: 'deferred_queue',
    description: 'Shows the deferred action queue — things detected but not implemented in current cycle. Auto-populated by the decision engine.',
    inputSchema: { type: 'object', properties: { flush: { type: 'boolean' } }, required: [] },
  },
];

async function handleAutonomousTool(name, args={}) {
  const m = require(path.join(ROOT, '.agentic/grafo/autonomous-decision.cjs'));
  switch(name) {
    case 'autonomous_decide':
      return m.analyze({
        files:           args.files || [],
        task:            args.task || '',
        errorSignatures: args.error_signatures || [],
        projectRoot:     ROOT,
      });
    case 'autonomous_sprint':
      return m.planSprint({
        objective:   args.objective || '',
        priorities:  args.priorities || [],
        constraints: args.constraints || [],
      }, ROOT);
    case 'deferred_queue':
      return args.flush ? m.flushDeferredQueue(ROOT) : m.loadDeferredQueue(ROOT);
    default: return { error: 'Unknown autonomous tool' };
  }
}

TOOLS.push(...TOOLS_AUTONOMOUS);
TOOLS_AUTONOMOUS.forEach(t => { TOOL_MAP[t.name] = { ...t, handler: (args) => handleAutonomousTool(t.name, args) }; });
process.stderr.write('[Agentic KDD MCP] +3 autonomous tools (autonomous_decide, autonomous_sprint, deferred_queue)\n');

// ─── v3.4: kdd-memory + knowledge-validator + telemetry MCP TOOLS ────────────
const TOOLS_V34 = [
  { name: 'recall', description: 'Ranked memory retrieval (BM25+vector). Use instead of reading errores.md/patrones.md. Returns id, title, confidence, files and a short summary within a token budget (estimate bytes/4, truncation reported). No match = empty. Obsolete entries are never returned. Pass id to get one entry in full; exclude_ids to skip what another role already got.', inputSchema: { type:'object', properties: { query:{type:'string'}, id:{type:['string','number']}, top_k:{type:'number'}, tipo:{type:'string'}, area:{type:'string'}, budget_tokens:{type:'number'}, exclude_ids:{type:'array', items:{type:['string','number']}} }, required:[] } },
  { name: 'remember', description: 'Write to memory with validation. Checks for duplicates, computes hash_contexto, adds frontmatter. Use at end of every cycle.', inputSchema: { type:'object', properties: { entry:{type:'string'}, tipo:{type:'string'}, area:{type:'string'}, confianza:{type:'string'}, archivos:{type:'array',items:{type:'string'}} }, required:['entry'] } },
  { name: 'validate_knowledge', description: 'Check if a memory entry is still valid before applying it. Returns: trusted, status (ACTIVO/SOSPECHOSO/OBSOLETO), recommendation.', inputSchema: { type:'object', properties: { node_id:{type:'string'} }, required:['node_id'] } },
  { name: 'memory_scan', description: 'Scan all memory for stale/obsolete/poisoned entries. Run periodically or before a major feature.', inputSchema: { type:'object', properties:{}, required:[] } },
  { name: 'telemetry_view', description: 'View execution trace for a cycle. Essential for L4 auditing.', inputSchema: { type:'object', properties:{ trace_id:{type:'string'} }, required:[] } },
  { name: 'telemetry_summary', description: 'Summary of all telemetry: total spans, STOPs, recalls, remembers.', inputSchema: { type:'object', properties:{}, required:[] } },
  { name: 'effort_decide', description: 'Universal effort router: tier = max(difficulty, risk), LOW/MEDIUM/HIGH with gates, roles, context budget and repair attempts. Same decision for aa:, sprint and teams. A requested tier below the risk floor is rejected (MIN_SEGURIDAD). Pass event to re-evaluate an existing task.', inputSchema: { type:'object', properties:{ intent:{type:'string'}, paths:{type:'array', items:{type:'string'}}, change_type:{type:'string'}, task_id:{type:'string'}, requested_tier:{type:'string'}, index_coverage:{type:'string'}, max_context_bytes:{type:'number'}, max_tool_calls:{type:'number'}, event:{type:'string'}, detail:{type:'string'} }, required:[] } },
  { name: 'context_pack', description: 'One context package per task (objective, acceptance, authorized paths, recall summaries, risks, file hashes, evidence). Reused when task and context are unchanged. Pass role to get only that role\'s part.', inputSchema: { type:'object', properties:{ task_id:{type:'string'}, objective:{type:'string'}, acceptance:{type:'array', items:{type:'string'}}, paths:{type:'array', items:{type:'string'}}, role:{type:'string'} }, required:['objective'] } },
  { name: 'teams', description: 'TEAMS native backend (same as `akdd teams` and `teams:` in chat). action: init|plan|run|status|pause|resume|disable|pending|resolve|import|verify|views. init needs approve_migration=true to add teams_* tables (with backup). resolve only succeeds if the host prompt hook recorded the person writing "teams: resolver <id> <decision>".', inputSchema: { type:'object', properties:{ action:{type:'string'}, approve_migration:{type:'boolean'}, plan:{type:'object'}, pending_id:{type:'string'}, decision:{type:'string'}, text:{type:'string'}, task_id:{type:'string'}, gates:{type:'array', items:{type:'object'}}, sprint:{type:'string'} }, required:['action'] } },
  { name: 'whatsapp', description: 'Optional WhatsApp notices (same backend as `akdd ws` and `ws:` in chat). action: estado|desactivar|reintentar|procesar|teams|activar|contacto|elegir. activar/contacto/elegir only succeed if the host prompt hook recorded the person typing them; this tool cannot activate on its own. Without a real tested transport the activation ends UNSUPPORTED and nothing is sent.', inputSchema: { type:'object', properties:{ action:{type:'string'}, activation_id:{type:'string'}, text:{type:'string'}, choice:{type:'string'} }, required:['action'] } },
  { name: 'restore', description: 'Real code restore points (Git objects in private refs/agentix/restore/*, never HEAD/branch/index). action: list|create|show|preview|apply|resume. apply needs expected_current_hash from a fresh preview; a preview that asks for a decision cannot be confirmed from here (only an interactive terminal). Restores code only: databases, migrations, deploys and messages are listed as not reverted.', inputSchema: { type:'object', properties:{ action:{type:'string'}, id:{type:'string'}, label:{type:'string'}, files:{type:'array', items:{type:'string'}}, expected_current_hash:{type:'string'} }, required:['action'] } },
];

async function handleV34Tool(name, args={}) {
  const ROOT2 = ROOT || process.cwd();
  switch(name) {
    case 'recall': {
      const m = require(path.join(ROOT2, '.agentic/grafo/kdd-memory.cjs'));
      if (args.id !== undefined && args.id !== null && args.id !== '') return m.detalle(args.id, ROOT2);
      return m.recall(args.query, {
        topK: args.top_k||10, tipo:args.tipo, area:args.area, via:'mcp',
        presupuestoTokens: Number.isFinite(args.budget_tokens) ? args.budget_tokens : undefined,
        excluir: Array.isArray(args.exclude_ids) ? args.exclude_ids : [],
      }, ROOT2);
    }
    case 'remember': {
      const m = require(path.join(ROOT2, '.agentic/grafo/kdd-memory.cjs'));
      return m.remember(args.entry, { tipo:args.tipo||'patron', area:args.area||'global', confianza:args.confianza||'BAJA', archivos:args.archivos||[], via:'mcp' }, ROOT2);
    }
    case 'validate_knowledge': {
      const m = require(path.join(ROOT2, '.agentic/grafo/knowledge-validator.cjs'));
      return m.validateKnowledge(args.node_id, ROOT2);
    }
    case 'memory_scan': {
      const m = require(path.join(ROOT2, '.agentic/grafo/knowledge-validator.cjs'));
      return m.scanAll(ROOT2);
    }
    case 'effort_decide': {
      const r = require(path.join(ROOT2, '.agentic/grafo/effort-router.cjs'));
      if (args.event) return r.reevaluar(ROOT2, args.task_id, args.event, args.detail);
      const limites = {};
      if (Number.isFinite(args.max_context_bytes)) limites.max_context_bytes = args.max_context_bytes;
      if (Number.isFinite(args.max_tool_calls)) limites.max_tool_calls = args.max_tool_calls;
      return r.decidirYGuardar(ROOT2, {
        intent: args.intent || '', paths: args.paths || [], change_type: args.change_type, task_id: args.task_id,
        requested_tier: args.requested_tier, index_coverage: args.index_coverage, origen: 'mcp',
        user_limits: Object.keys(limites).length ? limites : undefined,
      });
    }
    case 'context_pack': {
      const c = require(path.join(ROOT2, '.agentic/grafo/context-pack.cjs'));
      const p = await c.armar(ROOT2, { task_id: args.task_id, objetivo: args.objective, aceptacion: args.acceptance || [], paths: args.paths || [], origen: 'mcp' });
      return args.role ? c.paraRol(ROOT2, p, args.role) : p;
    }
    case 'teams': {
      const t = require(path.join(ROOT2, '.agentic/grafo/teams-manager.cjs'));
      return t.ejecutarAccion(ROOT2, args.action, {
        aprobar_migracion: args.approve_migration === true, plan: args.plan, pending_id: args.pending_id, decision: args.decision,
        texto: args.text, task_id: args.task_id, gates: args.gates, sprint: args.sprint, origen: 'hook-prompt',
      });
    }
    case 'whatsapp': {
      const w = require(path.join(ROOT2, '.agentic/grafo/whatsapp-manager.cjs'));
      const ad = w.adapterActual(ROOT2);
      switch (args.action) {
        case 'estado': return w.estado(ROOT2);
        case 'desactivar': return w.desactivar(ROOT2, { adapter: ad });
        case 'reintentar': return w.reintentar(ROOT2, { activation_id: args.activation_id, adapter: ad });
        case 'procesar': return w.procesarCola(ROOT2, { adapter: ad });
        case 'teams': return w.desdeTeams(ROOT2);
        case 'activar': return w.activar(ROOT2, { origen: 'hook-prompt', texto: args.text || 'ws: activar' });
        case 'contacto': return w.contacto(ROOT2, { activation_id: args.activation_id, texto: args.text, origen: 'hook-prompt', adapter: ad });
        case 'elegir': return w.elegir(ROOT2, { activation_id: args.activation_id, eleccion: args.choice, origen: 'hook-prompt', adapter: ad });
        default: return { status: 'USO', detalle: 'action: estado|desactivar|reintentar|procesar|teams|activar|contacto|elegir' };
      }
    }
    case 'restore': {
      const r = require(path.join(ROOT2, '.agentic/grafo/restore-manager.cjs'));
      switch (args.action) {
        case 'list': return r.listar(ROOT2);
        case 'create': return r.crear(ROOT2, { label: args.label, archivos: args.files });
        case 'show': return r.mostrar(ROOT2, args.id);
        case 'preview': return r.preview(ROOT2, args.id);
        case 'apply': return r.aplicar(ROOT2, args.id, { expected_current_hash: args.expected_current_hash, origen: 'mcp' });
        case 'resume': return r.reanudar(ROOT2);
        default: return { status: 'USO', detalle: 'action: list|create|show|preview|apply|resume' };
      }
    }
    case 'telemetry_view': {
      const m = require(path.join(ROOT2, '.agentic/grafo/telemetry.cjs'));
      return m.viewTrace(args.trace_id, ROOT2);
    }
    case 'telemetry_summary': {
      const m = require(path.join(ROOT2, '.agentic/grafo/telemetry.cjs'));
      return m.getSummary(ROOT2);
    }
    default: return { error: 'Unknown v34 tool' };
  }
}

TOOLS.push(...TOOLS_V34);
TOOLS_V34.forEach(t => { TOOL_MAP[t.name] = { ...t, handler: (args) => handleV34Tool(t.name, args) }; });
process.stderr.write('[Agentic KDD MCP] +6 v3.4 tools (recall, remember, validate_knowledge, memory_scan, telemetry_view, telemetry_summary)\n');

// ─── 3.20.1: memoria con evidencia, recuperación por capas, contexto compacto, esfuerzo y TEAMS ───
// Dos módulos con contrato versionado. Se registran SOLO si sus archivos existen (un proyecto a medio
// actualizar no rompe el servidor) y la raíz del proyecto la fija ESTE servidor, nunca el llamador.
for (const [archivo, nombre] of [['mcp-memory-tools.cjs', 'memory layers'], ['mcp-contexto-tools.cjs', 'context tools']]) {
  try {
    const p = path.join(ROOT, '.agentic/grafo', archivo);
    if (!fs.existsSync(p)) continue;
    const modulo = require(p);
    TOOLS.push(...modulo.TOOLS);
    modulo.TOOLS.forEach((t) => { TOOL_MAP[t.name] = { ...t, handler: (args) => modulo.handle(t.name, args, ROOT) }; });
    process.stderr.write('[Agentic KDD MCP] +' + modulo.TOOLS.length + ' 3.20.1 tools (' + nombre + ')\n');
  } catch (e) {
    process.stderr.write('[Agentic KDD MCP] 3.20.1 ' + nombre + ' no disponible: ' + e.message + '\n');
  }
}

// ─── v3.5: PATTERN DETECTION + FILE RISK MCP TOOLS ──────────────────────────
const TOOLS_V35 = [
  {
    name: 'detect_patterns',
    description: 'Detects if the same error/bug pattern exists in other modules. Returns list of findings with AUTO_FIX or WARN action per module based on file risk level and memory history.',
    inputSchema: {
      type: 'object',
      properties: {
        error_signatures: { type: 'array', items: { type: 'string' }, description: 'Error signatures to look for across modules' },
        current_files:    { type: 'array', items: { type: 'string' }, description: 'Files currently being modified' },
      },
      required: ['error_signatures'],
    },
  },
  {
    name: 'prerequisite_check',
    description: 'Given pattern findings, determines which must be fixed BEFORE the current task and which can wait until after.',
    inputSchema: {
      type: 'object',
      properties: {
        findings:      { type: 'array', description: 'Output from detect_patterns' },
        current_files: { type: 'array', items: { type: 'string' } },
      },
      required: ['findings', 'current_files'],
    },
  },
  {
    name: 'classify_file_risk',
    description: 'Returns CRITICAL/SENSITIVE/NORMAL/FREE risk level for a file. Determines if agent can act autonomously or must warn first.',
    inputSchema: {
      type: 'object',
      properties: { file: { type: 'string' } },
      required: ['file'],
    },
  },
];

async function handleV35Tool(name, args={}) {
  const m = require(path.join(ROOT, '.agentic/grafo/autonomous-decision.cjs'));
  switch(name) {
    case 'detect_patterns': {
      const db = getDB();
      return m.detectPatternAcrossModules(db, args.error_signatures || [], args.current_files || [], ROOT);
    }
    case 'prerequisite_check': {
      const db = getDB();
      return m.prerequisiteCheckFindings(db, args.findings || [], args.current_files || []);
    }
    case 'classify_file_risk':
      return { file: args.file, risk_level: m.classifyFileRisk(args.file, ROOT) };
    default: return { error: 'Unknown v35 tool' };
  }
}

TOOLS.push(...TOOLS_V35);
TOOLS_V35.forEach(t => { TOOL_MAP[t.name] = { ...t, handler: (args) => handleV35Tool(t.name, args) }; });
process.stderr.write('[Agentic KDD MCP] +3 v3.5 tools (detect_patterns, prerequisite_check, classify_file_risk)\n');
