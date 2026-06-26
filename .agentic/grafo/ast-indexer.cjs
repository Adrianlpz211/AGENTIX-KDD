/**
 * Agentic KDD — AST Indexer v1.0
 * Grafo AST con tree-sitter (offline) → SQLite
 *
 * Estrategia de dos capas:
 *   1. tree-sitter WASM (offline, determinista): cuando está disponible
 *   2. Regex fallback (siempre disponible): extrae imports/exports/funciones básicos
 *
 * Lenguajes soportados (con grammars WASM disponibles en npm):
 *   JS/TS, Python, Go, Rust, Java, C++, C, PHP, Ruby, Kotlin, Swift, C#
 *
 * Inspirado en el repo-map de Aider (tree-sitter + PageRank).
 * Paper de referencia: Codebase-Memory (arXiv 2603.27277, 2026)
 *
 * Uso CLI:
 *   node .agentic/grafo/ast-indexer.cjs index        — indexar todo el proyecto
 *   node .agentic/grafo/ast-indexer.cjs index [dir]  — indexar directorio
 *   node .agentic/grafo/ast-indexer.cjs impacto [archivo/módulo]
 *   node .agentic/grafo/ast-indexer.cjs symbols [archivo]
 *   node .agentic/grafo/ast-indexer.cjs stats
 *   node .agentic/grafo/ast-indexer.cjs clear
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── DB HELPER (compatible con mejor-sqlite3 y node:sqlite) ──────────────────

function openDB(projectRoot) {
  const dbPath = path.join(projectRoot, '.agentic/memoria.db');
  try {
    const Database = require('better-sqlite3');
    return new Database(dbPath);
  } catch {
    try {
      const { DatabaseSync } = require('node:sqlite');
      return new DatabaseSync(dbPath);
    } catch {
      throw new Error('Ningún driver SQLite disponible (better-sqlite3 o node:sqlite)');
    }
  }
}

// ─── SCHEMA PARA TABLAS AST ────────────────────────────────────────────────────

const AST_SCHEMA = `
-- ─── AST SYMBOLS ──────────────────────────────────────────────────────────────
-- Símbolos extraídos del codebase: funciones, clases, variables exportadas
CREATE TABLE IF NOT EXISTS ast_symbols (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  file         TEXT NOT NULL,          -- ruta relativa al proyecto
  language     TEXT NOT NULL,          -- js | ts | python | go | rust | java | ...
  symbol_name  TEXT NOT NULL,          -- nombre del símbolo
  kind         TEXT NOT NULL,          -- function | class | variable | interface | type | import | export
  line_start   INTEGER DEFAULT 0,
  line_end     INTEGER DEFAULT 0,
  exported     INTEGER DEFAULT 0,      -- 1 si es export
  signature    TEXT,                   -- firma completa (parámetros)
  pagerank     REAL DEFAULT 0.0,       -- score PageRank (Aider-style)
  last_indexed TEXT DEFAULT (datetime('now')),
  content_hash TEXT                    -- SHA-256 del contenido del archivo
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ast_sym_uniq ON ast_symbols(file, symbol_name, kind);
CREATE INDEX IF NOT EXISTS idx_ast_sym_file ON ast_symbols(file);
CREATE INDEX IF NOT EXISTS idx_ast_sym_kind ON ast_symbols(kind);

-- ─── AST EDGES ────────────────────────────────────────────────────────────────
-- Aristas del grafo de código: llamadas, imports, herencia
CREATE TABLE IF NOT EXISTS ast_edges (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  from_file   TEXT NOT NULL,
  to_file     TEXT,                    -- null si es externo (npm package)
  from_symbol TEXT,                    -- símbolo origen
  to_symbol   TEXT,                    -- símbolo destino
  kind        TEXT NOT NULL,           -- CALLS | IMPORTS | EXTENDS | IMPLEMENTS | DEFINES | USES
  weight      REAL DEFAULT 1.0,        -- fuerza del edge
  pagerank_src REAL DEFAULT 0.0,
  last_indexed TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ast_edge_from ON ast_edges(from_file);
CREATE INDEX IF NOT EXISTS idx_ast_edge_to ON ast_edges(to_file);
CREATE INDEX IF NOT EXISTS idx_ast_edge_kind ON ast_edges(kind);

-- ─── CAUSAL EDGES (extensión de relaciones_semanticas) ───────────────────────
-- Edges causales para autonomía: conectan causas con efectos en el historial
-- Se almacenan en relaciones_semanticas con tipos causales nuevos
-- Tipos causales: caused_failure | was_fixed_by | tested_by | regressed_by | depends_on_decision

-- ─── BI-TEMPORAL en relaciones_semanticas ─────────────────────────────────────
-- Migrations para bi-temporalidad (se ejecutan via migrateDB en grafo.cjs)
-- ALTER TABLE relaciones_semanticas ADD COLUMN valid_at TEXT DEFAULT (datetime('now'));
-- ALTER TABLE relaciones_semanticas ADD COLUMN invalid_at TEXT;   -- null = aún vigente
-- ALTER TABLE relaciones_semanticas ADD COLUMN expired_at TEXT;   -- cuándo se invalidó
-- ALTER TABLE relaciones_semanticas ADD COLUMN episode_id TEXT;   -- FK a episodios.episodio_id
-- ALTER TABLE relaciones_semanticas ADD COLUMN confidence TEXT DEFAULT 'MEDIA';
`;

function initASTSchema(db) {
  db.exec(AST_SCHEMA);
}

// ─── DETECCIÓN DE LENGUAJE ────────────────────────────────────────────────────

const LANGUAGE_MAP = {
  '.js': 'javascript', '.jsx': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript',
  '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin', '.kts': 'kotlin',
  '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp',
  '.c': 'c', '.h': 'c',
  '.cs': 'csharp',
  '.php': 'php',
  '.rb': 'ruby',
  '.swift': 'swift',
  '.scala': 'scala',
  '.ex': 'elixir', '.exs': 'elixir',
};

function detectLanguage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return LANGUAGE_MAP[ext] || null;
}

// ─── HASH HELPER ──────────────────────────────────────────────────────────────

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString(16);
}

// ─── EXTRACCIÓN REGEX (FALLBACK) ──────────────────────────────────────────────
// Funciona para todos los lenguajes sin dependencias externas.
// Menos preciso que tree-sitter pero siempre disponible.

const EXTRACTORS = {
  javascript: extractJS,
  typescript: extractJS,
  python:     extractPython,
  go:         extractGo,
  rust:       extractRust,
  java:       extractJavaKotlin,
  kotlin:     extractJavaKotlin,
  php:        extractPHP,
  ruby:       extractRuby,
};

function extractJS(content, filePath) {
  const symbols = [];
  const edges   = [];

  // Imports/requires
  const importPatterns = [
    /^import\s+(?:.*?)\s+from\s+['"]([^'"]+)['"]/gm,
    /^import\s+['"]([^'"]+)['"]/gm,
    /(?:const|let|var)\s+\{?[^}]*\}?\s*=\s*require\(['"]([^'"]+)['"]\)/gm,
    /(?:const|let|var)\s+\w+\s*=\s*require\(['"]([^'"]+)['"]\)/gm,
    /^export\s+\{.*\}\s+from\s+['"]([^'"]+)['"]/gm,
  ];

  for (const pat of importPatterns) {
    let m;
    while ((m = pat.exec(content)) !== null) {
      const src = m[1];
      edges.push({ kind: 'IMPORTS', to_symbol: src, from_symbol: null, weight: 1.0 });
    }
  }

  // Function declarations
  const fnPatterns = [
    /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/gm,
    /^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[\w]+)\s*=>/gm,
    /^(?:export\s+default\s+)?(?:async\s+)?function\s*(\w+)?\s*\(/gm,
  ];
  for (const pat of fnPatterns) {
    let m;
    while ((m = pat.exec(content)) !== null) {
      const name = m[1];
      if (!name || name.length < 1) continue;
      const line = content.substring(0, m.index).split('\n').length;
      const exported = /^export/.test(m[0]);
      symbols.push({ symbol_name: name, kind: 'function', line_start: line, exported: exported ? 1 : 0, signature: m[0].trim().substring(0, 100) });
    }
  }

  // Class declarations
  const classPattern = /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?/gm;
  let m;
  while ((m = classPattern.exec(content)) !== null) {
    const line = content.substring(0, m.index).split('\n').length;
    const exported = /^export/.test(m[0]);
    symbols.push({ symbol_name: m[1], kind: 'class', line_start: line, exported: exported ? 1 : 0 });
    if (m[2]) edges.push({ kind: 'EXTENDS', from_symbol: m[1], to_symbol: m[2], weight: 1.5 });
  }

  // Interface / type (TypeScript)
  const ifacePattern = /^(?:export\s+)?interface\s+(\w+)/gm;
  while ((m = ifacePattern.exec(content)) !== null) {
    const line = content.substring(0, m.index).split('\n').length;
    symbols.push({ symbol_name: m[1], kind: 'interface', line_start: line, exported: 1 });
  }
  const typePattern = /^(?:export\s+)?type\s+(\w+)\s*=/gm;
  while ((m = typePattern.exec(content)) !== null) {
    const line = content.substring(0, m.index).split('\n').length;
    symbols.push({ symbol_name: m[1], kind: 'type', line_start: line, exported: 1 });
  }

  return { symbols, edges };
}

function extractPython(content, _filePath) {
  const symbols = [], edges = [];
  let m;

  const importPat = /^(?:from\s+([\w.]+)\s+import|import\s+([\w., ]+))/gm;
  while ((m = importPat.exec(content)) !== null) {
    edges.push({ kind: 'IMPORTS', to_symbol: m[1] || m[2], from_symbol: null, weight: 1.0 });
  }

  const defPat = /^(class|def|async def)\s+(\w+)\s*(?:\(([^)]*)\))?:/gm;
  while ((m = defPat.exec(content)) !== null) {
    const line = content.substring(0, m.index).split('\n').length;
    symbols.push({ symbol_name: m[2], kind: m[1] === 'class' ? 'class' : 'function', line_start: line, exported: 0, signature: m[0].trim() });
  }

  return { symbols, edges };
}

function extractGo(content, _filePath) {
  const symbols = [], edges = [];
  let m;

  const importPat = /import\s*\(\s*([\s\S]*?)\s*\)/gm;
  while ((m = importPat.exec(content)) !== null) {
    const lines = m[1].split('\n').map(l => l.trim().replace(/["]/g, '').split(' ').pop()).filter(Boolean);
    lines.forEach(pkg => edges.push({ kind: 'IMPORTS', to_symbol: pkg, from_symbol: null, weight: 1.0 }));
  }

  const funcPat = /^func\s+(?:\([\w\s*]+\)\s+)?(\w+)\s*\(/gm;
  while ((m = funcPat.exec(content)) !== null) {
    const line = content.substring(0, m.index).split('\n').length;
    symbols.push({ symbol_name: m[1], kind: 'function', line_start: line, exported: /^[A-Z]/.test(m[1]) ? 1 : 0 });
  }

  const typePat = /^type\s+(\w+)\s+(struct|interface)/gm;
  while ((m = typePat.exec(content)) !== null) {
    const line = content.substring(0, m.index).split('\n').length;
    symbols.push({ symbol_name: m[1], kind: m[2], line_start: line, exported: /^[A-Z]/.test(m[1]) ? 1 : 0 });
  }

  return { symbols, edges };
}

function extractRust(content, _filePath) {
  const symbols = [], edges = [];
  let m;

  const usePat = /^use\s+([\w:]+)/gm;
  while ((m = usePat.exec(content)) !== null) {
    edges.push({ kind: 'IMPORTS', to_symbol: m[1], from_symbol: null, weight: 1.0 });
  }

  const fnPat = /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/gm;
  while ((m = fnPat.exec(content)) !== null) {
    const line = content.substring(0, m.index).split('\n').length;
    symbols.push({ symbol_name: m[1], kind: 'function', line_start: line, exported: m[0].includes('pub') ? 1 : 0 });
  }

  const structPat = /^(?:pub\s+)?struct\s+(\w+)/gm;
  while ((m = structPat.exec(content)) !== null) {
    const line = content.substring(0, m.index).split('\n').length;
    symbols.push({ symbol_name: m[1], kind: 'class', line_start: line, exported: m[0].includes('pub') ? 1 : 0 });
  }

  return { symbols, edges };
}

function extractJavaKotlin(content, filePath) {
  const symbols = [], edges = [];
  let m;
  const isKotlin = filePath.endsWith('.kt') || filePath.endsWith('.kts');

  const importPat = /^import\s+([\w.]+)/gm;
  while ((m = importPat.exec(content)) !== null) {
    edges.push({ kind: 'IMPORTS', to_symbol: m[1], from_symbol: null, weight: 1.0 });
  }

  const classPat = isKotlin
    ? /^(?:(?:open|abstract|data|sealed)\s+)?class\s+(\w+)/gm
    : /^(?:public\s+)?(?:abstract\s+)?class\s+(\w+)/gm;
  while ((m = classPat.exec(content)) !== null) {
    const line = content.substring(0, m.index).split('\n').length;
    symbols.push({ symbol_name: m[1], kind: 'class', line_start: line, exported: 1 });
  }

  const methodPat = isKotlin
    ? /^(?:(?:override|private|protected|internal|suspend)\s+)*fun\s+(\w+)/gm
    : /(?:public|private|protected)\s+(?:static\s+)?(?:\w+\s+)+(\w+)\s*\(/gm;
  while ((m = methodPat.exec(content)) !== null) {
    const line = content.substring(0, m.index).split('\n').length;
    symbols.push({ symbol_name: m[1], kind: 'function', line_start: line, exported: 0 });
  }

  return { symbols, edges };
}

function extractPHP(content, _filePath) {
  const symbols = [], edges = [];
  let m;

  const usePat = /^use\s+([\w\\]+)/gm;
  while ((m = usePat.exec(content)) !== null) {
    edges.push({ kind: 'IMPORTS', to_symbol: m[1], from_symbol: null, weight: 1.0 });
  }

  const classPat = /^(?:abstract\s+)?class\s+(\w+)/gm;
  while ((m = classPat.exec(content)) !== null) {
    const line = content.substring(0, m.index).split('\n').length;
    symbols.push({ symbol_name: m[1], kind: 'class', line_start: line, exported: 0 });
  }

  const fnPat = /^(?:public|private|protected|static|\s)+function\s+(\w+)/gm;
  while ((m = fnPat.exec(content)) !== null) {
    const line = content.substring(0, m.index).split('\n').length;
    symbols.push({ symbol_name: m[1], kind: 'function', line_start: line, exported: 0 });
  }

  return { symbols, edges };
}

function extractRuby(content, _filePath) {
  const symbols = [], edges = [];
  let m;

  const requirePat = /^require(?:_relative)?\s+['"]([^'"]+)['"]/gm;
  while ((m = requirePat.exec(content)) !== null) {
    edges.push({ kind: 'IMPORTS', to_symbol: m[1], from_symbol: null, weight: 1.0 });
  }

  const classPat = /^class\s+(\w+)(?:\s+<\s+(\w+))?/gm;
  while ((m = classPat.exec(content)) !== null) {
    const line = content.substring(0, m.index).split('\n').length;
    symbols.push({ symbol_name: m[1], kind: 'class', line_start: line, exported: 1 });
    if (m[2]) edges.push({ kind: 'EXTENDS', from_symbol: m[1], to_symbol: m[2], weight: 1.5 });
  }

  const defPat = /^(?:  )*def\s+(\w+)/gm;
  while ((m = defPat.exec(content)) !== null) {
    const line = content.substring(0, m.index).split('\n').length;
    symbols.push({ symbol_name: m[1], kind: 'function', line_start: line, exported: 0 });
  }

  return { symbols, edges };
}

// ─── TREE-SITTER WRAPPER (activación opt-in) ──────────────────────────────────

async function tryTreeSitter(content, language) {
  try {
    const Parser = require('web-tree-sitter');
    await Parser.init();
    // Los grammars se buscan en: node_modules/tree-sitter-wasms/out/[lang].wasm
    const grammarPath = require.resolve(`tree-sitter-wasms/out/tree-sitter-${language}.wasm`);
    const parser = new Parser();
    const Lang = await Parser.Language.load(grammarPath);
    parser.setLanguage(Lang);
    const tree = parser.parse(content);
    return { available: true, tree };
  } catch {
    return { available: false, tree: null };
  }
}

// ─── INDEXAR UN ARCHIVO ───────────────────────────────────────────────────────

function indexFile(db, filePath, projectRoot) {
  const relPath = path.relative(projectRoot, filePath);
  const language = detectLanguage(filePath);
  if (!language) return { skipped: true };

  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch { return { skipped: true }; }

  // Skip archivos muy grandes (> 500KB)
  if (content.length > 500000) return { skipped: true };

  const hash = simpleHash(content);

  // Verificar si ya está indexado con el mismo hash
  try {
    const existing = db.prepare('SELECT content_hash FROM ast_symbols WHERE file = ? LIMIT 1').get(relPath);
    if (existing?.content_hash === hash) return { cached: true };
  } catch {}

  // Extraer símbolos y edges
  const extractor = EXTRACTORS[language];
  if (!extractor) return { skipped: true };

  const { symbols, edges } = extractor(content, filePath);

  // Limpiar registros anteriores
  try {
    db.prepare('DELETE FROM ast_symbols WHERE file = ?').run(relPath);
    db.prepare('DELETE FROM ast_edges WHERE from_file = ?').run(relPath);
  } catch {}

  // Insertar símbolos
  const insertSym = db.prepare(`
    INSERT OR REPLACE INTO ast_symbols
      (file, language, symbol_name, kind, line_start, exported, signature, content_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const sym of symbols) {
    try {
      insertSym.run(relPath, language, sym.symbol_name, sym.kind, sym.line_start || 0, sym.exported || 0, sym.signature || null, hash);
    } catch {}
  }

  // Resolver y insertar edges
  const insertEdge = db.prepare(`
    INSERT INTO ast_edges (from_file, to_file, from_symbol, to_symbol, kind, weight)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const edge of edges) {
    let toFile = null;
    // Resolver import relativo a ruta de archivo real
    if (edge.to_symbol?.startsWith('.')) {
      const resolved = path.resolve(path.dirname(filePath), edge.to_symbol);
      const extensions = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js'];
      for (const ext of extensions) {
        if (fs.existsSync(resolved + ext)) {
          toFile = path.relative(projectRoot, resolved + ext);
          break;
        }
        if (fs.existsSync(resolved)) {
          toFile = path.relative(projectRoot, resolved);
          break;
        }
      }
    }
    try {
      insertEdge.run(relPath, toFile, edge.from_symbol || null, edge.to_symbol, edge.kind, edge.weight);
    } catch {}
  }

  return { symbols: symbols.length, edges: edges.length, language };
}

// ─── PAGERANK ─────────────────────────────────────────────────────────────────
// Algoritmo PageRank simplificado sobre el grafo de archivos.
// Aider-style: multiplica x50 si el archivo está en el chat, x10 si el símbolo fue mencionado.

function computePageRank(db, iterations = 20, dampingFactor = 0.85) {
  let files;
  try {
    files = db.prepare('SELECT DISTINCT file FROM ast_symbols').all().map(r => r.file);
  } catch { return; }

  const scores = {};
  files.forEach(f => { scores[f] = 1.0 / files.length; });

  for (let i = 0; i < iterations; i++) {
    const newScores = {};
    files.forEach(f => { newScores[f] = (1 - dampingFactor) / files.length; });

    for (const file of files) {
      let links;
      try {
        links = db.prepare('SELECT to_file, weight FROM ast_edges WHERE from_file = ? AND to_file IS NOT NULL').all(file);
      } catch { continue; }

      if (links.length === 0) continue;
      const totalWeight = links.reduce((s, l) => s + l.weight, 0);
      for (const link of links) {
        if (newScores[link.to_file] !== undefined) {
          newScores[link.to_file] += dampingFactor * (scores[file] * link.weight / totalWeight);
        }
      }
    }
    Object.assign(scores, newScores);
  }

  // Actualizar scores en DB
  const updateSym = db.prepare('UPDATE ast_symbols SET pagerank = ? WHERE file = ?');
  const updateEdge = db.prepare('UPDATE ast_edges SET pagerank_src = ? WHERE from_file = ?');
  for (const [file, score] of Object.entries(scores)) {
    try {
      updateSym.run(score, file);
      updateEdge.run(score, file);
    } catch {}
  }

  return scores;
}

// ─── ANÁLISIS DE IMPACTO ──────────────────────────────────────────────────────

/**
 * Dado un archivo o módulo, retorna qué otros archivos dependen de él
 * y cuál es la severidad estimada del impacto si se modifica.
 */
function analyzeImpact(db, target) {
  // Buscar edges que apunten al target
  let directDeps, indirectFiles;
  try {
    directDeps = db.prepare(`
      SELECT DISTINCT from_file, kind, weight
      FROM ast_edges
      WHERE to_file LIKE ? OR to_symbol LIKE ?
      ORDER BY weight DESC
    `).all(`%${target}%`, `%${target}%`);

    indirectFiles = db.prepare(`
      SELECT DISTINCT ae2.from_file
      FROM ast_edges ae1
      JOIN ast_edges ae2 ON ae1.from_file = ae2.to_file
      WHERE ae1.to_file LIKE ?
      LIMIT 50
    `).all(`%${target}%`);
  } catch {
    return { target, direct: [], indirect: [], severity: 'DESCONOCIDO', error: 'Sin datos AST' };
  }

  // Determinar severidad
  let severity = 'BAJO';
  if (directDeps.length >= 5 || indirectFiles.length >= 10) severity = 'ALTO';
  else if (directDeps.length >= 2 || indirectFiles.length >= 3) severity = 'MEDIO';

  // Buscar también en relaciones_semanticas (memoria semántica existente)
  let semanticRelations = [];
  try {
    semanticRelations = db.prepare(`
      SELECT desde_entidad, tipo, peso
      FROM relaciones_semanticas
      WHERE hacia_entidad LIKE ? AND (invalid_at IS NULL OR invalid_at = '')
      ORDER BY peso DESC LIMIT 20
    `).all(`%${target}%`);
    if (semanticRelations.length >= 3) severity = severity === 'BAJO' ? 'MEDIO' : severity;
  } catch {}

  return {
    target,
    direct: directDeps.slice(0, 20),
    indirect: indirectFiles.slice(0, 20),
    semantic: semanticRelations,
    severity,
    summary: `${directDeps.length} deps directas, ${indirectFiles.length} indirectas → Severidad: ${severity}`,
  };
}

// ─── INDEXAR PROYECTO COMPLETO ────────────────────────────────────────────────

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.agentic', 'dist', 'build', '.next',
  'coverage', '__pycache__', '.pytest_cache', 'vendor', 'target',
]);

function getAllSourceFiles(dir, projectRoot, results = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return results; }

  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.agentic') continue;
    if (IGNORE_DIRS.has(e.name)) continue;

    const fullPath = path.join(dir, e.name);
    if (e.isDirectory()) {
      getAllSourceFiles(fullPath, projectRoot, results);
    } else if (detectLanguage(fullPath)) {
      results.push(fullPath);
    }
  }
  return results;
}

function indexProject(projectRoot, targetDir = null) {
  const db = openDB(projectRoot);
  initASTSchema(db);

  const searchDir = targetDir ? path.join(projectRoot, targetDir) : projectRoot;
  const files = getAllSourceFiles(searchDir, projectRoot);

  console.log(`[AST-INDEXER] Indexando ${files.length} archivos en ${path.relative(process.cwd(), searchDir) || '.'}`);

  let indexed = 0, skipped = 0, cached = 0, errors = 0;

  for (const file of files) {
    const result = indexFile(db, file, projectRoot);
    if (result.cached) cached++;
    else if (result.skipped) skipped++;
    else if (result.error) errors++;
    else {
      indexed++;
      if (indexed % 50 === 0) process.stdout.write(`\r[AST-INDEXER] ${indexed}/${files.length}...`);
    }
  }

  process.stdout.write('\n');
  console.log('[AST-INDEXER] Calculando PageRank...');
  computePageRank(db);

  console.log(`[AST-INDEXER] ✅ Completado: ${indexed} indexados, ${cached} en caché, ${skipped} omitidos`);
  return { indexed, cached, skipped, errors };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const [,, cmd, arg] = process.argv;
  const projectRoot = process.cwd();

  switch (cmd) {
    case 'index': {
      const result = indexProject(projectRoot, arg);
      process.exit(0);
      break;
    }
    case 'impacto': {
      if (!arg) { console.error('Uso: ast-indexer.cjs impacto [archivo/módulo]'); process.exit(1); }
      try {
        const db = openDB(projectRoot);
        const impact = analyzeImpact(db, arg);
        console.log(`\n📊 Análisis de Impacto: ${impact.target}`);
        console.log(`Severidad: ${impact.severity}`);
        console.log(`Dependencias directas (${impact.direct.length}):`);
        impact.direct.slice(0, 10).forEach(d => console.log(`  ${d.kind} ← ${d.from_file}`));
        if (impact.indirect.length > 0) {
          console.log(`Dependencias indirectas (${impact.indirect.length}):`);
          impact.indirect.slice(0, 5).forEach(d => console.log(`  ← ${d.from_file}`));
        }
      } catch (e) { console.error('Error:', e.message); }
      break;
    }
    case 'symbols': {
      if (!arg) { console.error('Uso: ast-indexer.cjs symbols [archivo]'); process.exit(1); }
      try {
        const db = openDB(projectRoot);
        const syms = db.prepare('SELECT symbol_name, kind, line_start, exported FROM ast_symbols WHERE file = ? ORDER BY line_start').all(arg);
        console.log(`\nSímbolos en ${arg} (${syms.length}):`);
        syms.forEach(s => console.log(`  ${s.exported ? '📤' : '  '} ${s.kind.padEnd(12)} ${s.symbol_name} (línea ${s.line_start})`));
      } catch (e) { console.error('Error:', e.message); }
      break;
    }
    case 'stats': {
      try {
        const db = openDB(projectRoot);
        const symCount = db.prepare('SELECT COUNT(*) as n FROM ast_symbols').get()?.n ?? 0;
        const edgeCount = db.prepare('SELECT COUNT(*) as n FROM ast_edges').get()?.n ?? 0;
        const fileCount = db.prepare('SELECT COUNT(DISTINCT file) as n FROM ast_symbols').get()?.n ?? 0;
        const langs = db.prepare('SELECT language, COUNT(*) as n FROM ast_symbols GROUP BY language ORDER BY n DESC').all();
        console.log(`\n📊 AST Index Stats`);
        console.log(`  Archivos indexados: ${fileCount}`);
        console.log(`  Símbolos:           ${symCount}`);
        console.log(`  Edges:              ${edgeCount}`);
        console.log(`  Lenguajes: ${langs.map(l => `${l.language}(${l.n})`).join(', ')}`);
      } catch (e) { console.error('Error:', e.message); }
      break;
    }
    case 'clear': {
      try {
        const db = openDB(projectRoot);
        db.exec('DELETE FROM ast_symbols; DELETE FROM ast_edges;');
        console.log('AST index limpiado');
      } catch (e) { console.error('Error:', e.message); }
      break;
    }
    default:
      console.log('Uso: node ast-indexer.cjs [index [dir] | impacto <target> | symbols <file> | stats | clear]');
  }
}

module.exports = {
  indexProject,
  indexFile,
  analyzeImpact,
  computePageRank,
  detectLanguage,
  initASTSchema,
  AST_SCHEMA,
  LANGUAGE_MAP,
};
