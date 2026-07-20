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
  // Migración tolerante (v3.15): CREATE IF NOT EXISTS no agrega columnas a una
  // tabla vieja ya existente. line_end viene en el schema desde v1, pero si un
  // cliente antiquísimo la tuviera sin esa columna, el INSERT nuevo reventaría.
  // Un ALTER de un centavo lo blinda — mismo patrón del resto del motor.
  try { db.exec('ALTER TABLE ast_symbols ADD COLUMN line_end INTEGER DEFAULT 0'); } catch {}
  try { db.exec('ALTER TABLE ast_symbols ADD COLUMN content_hash TEXT'); } catch {}
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
  '.sql': 'sql',
  '.html': 'html', '.htm': 'html',
  '.css': 'css',
};

function detectLanguage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return LANGUAGE_MAP[ext] || null;
}

// ─── HASH HELPER ──────────────────────────────────────────────────────────────

function simpleHash(str) {
  // SHA-256 real (antes era un hash polinómico de 32 bits con riesgo de colisión,
  // lo que podía saltar el reindexado de un archivo modificado en el cache check)
  return require('crypto').createHash('sha256').update(String(str)).digest('hex');
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
  sql:        extractSQL,
  html:       extractHTML,
  css:        extractCSS,
};

// ─── MINERÍA DE COMENTARIOS SEMÁNTICOS (inspirado en Graphify) ────────────────
// // NOTE: / WHY: / HACK: / FIXME: (o su equivalente con #) ya son la forma en
// que un dev deja el "por qué" de una decisión mientras codea. Hoy esa
// intención se pierde si nadie la copia a mano a decisiones.md — esto la
// convierte en nodo del grafo automáticamente, sin depender del LLM.
// Genérico por diseño: aplica igual a cualquier lenguaje ya soportado arriba,
// no requiere un extractor propio por lenguaje (// y # cubren JS/TS/Go/Rust/
// Java/Kotlin/PHP/Ruby y Python/Ruby respectivamente).
const COMMENT_MARKER_PATTERN = /(?:\/\/|#)\s*(NOTE|WHY|HACK|FIXME)\s*:\s*(.+)/i;

function extractCommentMarkers(content) {
  const symbols = [];
  const lineas = content.split('\n');
  lineas.forEach((linea, i) => {
    const m = COMMENT_MARKER_PATTERN.exec(linea);
    if (!m) return;
    const marker = m[1].toLowerCase();
    const texto = m[2].trim().slice(0, 200);
    // symbol_name lleva la línea para no colisionar con otro marcador del
    // mismo tipo en el mismo archivo (la unique index es file+symbol_name+kind)
    const slug = texto.slice(0, 40).replace(/\s+/g, ' ');
    symbols.push({
      symbol_name: `L${i + 1}: ${slug}`,
      kind: marker, // note | why | hack | fixme
      line_start: i + 1,
      exported: 0,
      signature: texto,
    });
  });
  return symbols;
}

// ─── HTML — la materia del UI como nodos reales (Plan 2, Fase A: Ojos) ────────
// Los dos bugs de Salud360 (combobox que rompió selects existentes; CSS que
// rompió validaciones required) se colaron porque forms/selects/required eran
// INVISIBLES para el grafo. Estos extractores les dan existencia como símbolos:
//   form   → kind 'form'   (line_end = primer </form> posterior — válido SOLO
//            para form porque HTML prohíbe forms anidados; NO generalizar)
//   select → kind 'select' (kind propio: es exactamente el caso del bug #1)
//   input/textarea → kind 'field'
// required se detecta EXACTO (/\srequired(?=[\s=>/])/i — un class="required"
// NO es un campo required) y viaja como marcador [required] en el signature.
function extractHTML(content, _filePath) {
  const symbols = [], edges = [];
  let m;

  const formPat = /<form\b[^>]*>/gi;
  while ((m = formPat.exec(content)) !== null) {
    const line = content.substring(0, m.index).split('\n').length;
    const tag = m[0];
    const id = tag.match(/\bid\s*=\s*["']([^"']+)["']/i);
    const name = tag.match(/\bname\s*=\s*["']([^"']+)["']/i);
    const symbol_name = id ? `form#${id[1]}` : (name ? `form[name=${name[1]}]` : `form@L${line}`);
    const closeIdx = content.indexOf('</form>', m.index);
    const line_end = closeIdx >= 0 ? content.substring(0, closeIdx).split('\n').length : line;
    symbols.push({ symbol_name, kind: 'form', line_start: line, line_end, exported: 1, signature: tag.slice(0, 150) });
  }

  const fieldPat = /<(input|select|textarea)\b[^>]*>/gi;
  while ((m = fieldPat.exec(content)) !== null) {
    const line = content.substring(0, m.index).split('\n').length;
    const tag = m[0];
    const base = m[1].toLowerCase();
    const kind = base === 'select' ? 'select' : 'field';
    const name = tag.match(/\bname\s*=\s*["']([^"']+)["']/i);
    const id = tag.match(/\bid\s*=\s*["']([^"']+)["']/i);
    const symbol_name = name ? `${base}[name=${name[1]}]` : (id ? `${base}#${id[1]}` : `${base}@L${line}`);
    const line_end = content.substring(0, m.index + tag.length).split('\n').length;
    const esRequired = /\srequired(?=[\s=>/])/i.test(tag);
    symbols.push({
      symbol_name, kind, line_start: line, line_end, exported: 0,
      signature: (esRequired ? '[required] ' : '') + tag.slice(0, 140),
    });
  }

  extractUsesClass(content, edges);
  return { symbols, edges };
}

// ─── CSS — clases e ids definidos como nodos (Plan 2, Fase A) ─────────────────
// Solo CABEZAS de selector (lo que precede a '{') — jamás propiedades: indexar
// color/margin/etc. es ruido puro que infla la tabla sin anclar nada.
function extractCSS(content, _filePath) {
  const symbols = [], edges = [];
  const selPat = /(^|\})([^{}]+)\{/g;
  const seen = new Set();
  let m;
  while ((m = selPat.exec(content)) !== null) {
    const head = m[2];
    const headOffset = m.index + m[1].length;
    let cm;
    const clsPat = /\.(-?[A-Za-z_][\w-]*)/g;
    while ((cm = clsPat.exec(head)) !== null) {
      if (seen.has('c|' + cm[1])) continue;
      seen.add('c|' + cm[1]);
      const line = content.substring(0, headOffset + cm.index).split('\n').length;
      symbols.push({ symbol_name: cm[1], kind: 'css_class', line_start: line, exported: 1 });
    }
    const idPat = /#(-?[A-Za-z_][\w-]*)/g;
    while ((cm = idPat.exec(head)) !== null) {
      if (seen.has('i|' + cm[1])) continue;
      seen.add('i|' + cm[1]);
      const line = content.substring(0, headOffset + cm.index).split('\n').length;
      symbols.push({ symbol_name: cm[1], kind: 'css_id', line_start: line, exported: 1 });
    }
  }
  return { symbols, edges };
}

// Clases CSS usadas por un archivo (class="..." / className="...") → edges
// USES_CLASS con to_file NULL; la pasada de enlace post-index (linkCssEdges)
// resuelve a qué archivo CSS apunta cada una. Esto es el blast radius del CSS:
// "este .css lo usan estas vistas" — el bug #2 de Salud360 era invisible sin esto.
function extractUsesClass(content, edges) {
  const classAttrPat = /\bclass(?:Name)?\s*=\s*["'`]([^"'`]+)["'`]/gi;
  const vistos = new Set();
  let m;
  while ((m = classAttrPat.exec(content)) !== null) {
    m[1].split(/\s+/).filter(Boolean).slice(0, 50).forEach(cls => {
      if (!/^-?[A-Za-z_][\w-]*$/.test(cls) || vistos.has(cls)) return;
      vistos.add(cls);
      edges.push({ kind: 'USES_CLASS', to_symbol: cls, from_symbol: null, weight: 0.5 });
    });
  }
}

// ─── SQL — esquemas como nodos reales (antes solo vivían como texto plano) ────
function extractSQL(content, _filePath) {
  const symbols = [], edges = [];
  let m;

  const tablePat = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"[]?\w+[`"\]]?)/gi;
  while ((m = tablePat.exec(content)) !== null) {
    const line = content.substring(0, m.index).split('\n').length;
    const nombre = m[1].replace(/[`"[\]]/g, '');
    symbols.push({ symbol_name: nombre, kind: 'sql_table', line_start: line, exported: 1 });
  }

  // Bug real encontrado el 15/07/2026 probando contra SQL real de Lumo: los
  // nombres suelen venir entre comillas ("NegocioLinea_negocioId_idx") y a
  // veces con CONCURRENTLY entre INDEX e IF NOT EXISTS (Postgres). \w+ no
  // puede empezar en una comilla, así que el regex retrocedía y capturaba
  // "IF" o "CONCURRENTLY" como si fueran el nombre del índice.
  const indexPat = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?(\w+)[`"\]]?/gi;
  while ((m = indexPat.exec(content)) !== null) {
    const line = content.substring(0, m.index).split('\n').length;
    symbols.push({ symbol_name: m[1], kind: 'sql_index', line_start: line, exported: 0 });
  }

  return { symbols, edges };
}

// ─── EDGES CALLS (función-a-función, DENTRO del mismo archivo) ────────────────
// Heurística por regex + ventana de líneas — NO es un parser real. Solo
// detecta llamadas a símbolos ya conocidos de este mismo archivo (funciones/
// clases extraídas arriba). Llamadas cruzadas entre archivos siguen
// representándose únicamente a nivel de archivo vía edges IMPORTS.
const JS_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof',
  'instanceof', 'new', 'delete', 'void', 'in', 'of', 'do', 'else', 'try',
  'finally', 'throw', 'yield', 'await', 'async', 'class', 'extends', 'super',
  'this', 'import', 'export', 'from', 'const', 'let', 'var', 'with',
]);

function extractCallsWithinFile(content, knownSymbols) {
  const edges = [];
  if (!knownSymbols || knownSymbols.length === 0) return edges;

  const symbolNames = new Set(knownSymbols.map(s => s.symbol_name));
  const sorted = [...knownSymbols].sort((a, b) => a.line_start - b.line_start);

  // A qué símbolo "pertenece" una línea: el último símbolo cuyo line_start
  // sea <= esa línea. Es una ventana, no un parseo real de llaves — suficiente
  // para atribuir la llamada al bloque más probable sin la fragilidad de
  // hacer brace-matching sobre JS/TS con template literals y regex literales.
  function ownerAt(line) {
    let owner = null;
    for (const s of sorted) {
      if (s.line_start <= line) owner = s;
      else break;
    }
    return owner;
  }

  const callPattern = /\b([a-zA-Z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = callPattern.exec(content)) !== null) {
    const name = m[1];
    if (JS_KEYWORDS.has(name)) continue;
    if (!symbolNames.has(name)) continue;

    const line = content.substring(0, m.index).split('\n').length;
    const owner = ownerAt(line);
    if (!owner) continue;
    if (owner.symbol_name === name) continue; // no contar la propia declaración

    edges.push({ kind: 'CALLS', from_symbol: owner.symbol_name, to_symbol: name, weight: 1.0 });
  }
  return edges;
}

// ─── BLANQUEO DE TEMPLATE LITERALS (Plan 3 — hallazgo de la medición) ─────────
// La comparación contra tree-sitter (2026-07-15, 2181 símbolos de lumoV2)
// encontró que los ÚNICOS 4 casos donde el rango regex se queda CORTO
// (dirección peligrosa) eran template literals gigantes con código incrustado
// (const HTML = `...<script>function x(){}...`): las líneas del código
// embebido matcheaban los patrones ^-anclados y creaban símbolos FANTASMA que
// recortaban el rango del símbolo real. Solución en la capa regex — sin
// tree-sitter: reemplazar el interior de los template literals por espacios
// ANTES de extraer símbolos, preservando saltos de línea (los números de
// línea no se mueven: misma longitud, mismos \n).
// Nota honesta: un backtick suelto dentro de un string normal o comentario
// puede abrir el estado hasta el próximo backtick — el peor caso es perder un
// símbolo del índice (igual que si el regex no lo viera hoy) y el guardia
// cierra el portón por DOUBT. Nunca peor que hoy.
function blankTemplateLiterals(content) {
  const out = Array.from(content);
  const stack = []; // -1 = cuerpo de template; n>=1 = profundidad de llaves dentro de ${ }
  // Fuera de los templates hay un lexer-lite: strings ('/") y comentarios
  // (// y /* */) se RECORREN sin blanquear pero sus backticks NO abren
  // template — la primera versión de esta función no los entendía y un
  // backtick suelto en un comentario invertía la fase: se tragó 292 símbolos
  // reales de lumoV2 (medido contra tree-sitter el 2026-07-15). La ambigüedad
  // restante (backtick dentro de un regex literal) es rarísima y su peor caso
  // es perder un símbolo del índice — el guardia cierra por DOUBT, nunca peor
  // que hoy.
  let mode = 'code'; // code | sq | dq | line | block — solo aplica FUERA de templates
  let prev = '';     // último char significativo en modo code (para regex vs división)
  let i = 0;
  const n = content.length;
  while (i < n) {
    const c = content[i];
    const d = i + 1 < n ? content[i + 1] : '';
    const top = stack.length ? stack[stack.length - 1] : null;

    if (top === null) {                 // fuera de template: lexer-lite
      if (mode === 'code') {
        if (c === '`') { stack.push(-1); i++; continue; }
        if (c === "'") { mode = 'sq'; i++; continue; }
        if (c === '"') { mode = 'dq'; i++; continue; }
        if (c === '/' && d === '/') { mode = 'line'; i += 2; continue; }
        if (c === '/' && d === '*') { mode = 'block'; i += 2; continue; }
        if (c === '/' && d !== ' ' && d !== '=' && /[(,=:[!&|?{;+\-*%<>~^]/.test(prev || '(')) {
          // d !== ' ': una división formateada (`= ancho / 2`) tiene espacio
          // tras el slash y NO es regex — sin esta regla, cada división tras
          // `=` desincronizaba el lexer (medido: flow-builder.js perdía 149
          // símbolos por sus cálculos de UI). Nadie escribe regexes /  .../
          // con espacio inicial; d !== '=' descarta el operador /=.
          // LITERAL DE REGEX (el / está en posición de operando). Cazado en
          // vivo: `.replace(/\`/g, '&#96;')` de escHtml — el backtick dentro
          // del regex abría un template fantasma y se tragaba el resto del
          // archivo (readConfig y 291 símbolos más, medido contra
          // tree-sitter). Consumir hasta el / de cierre respetando escapes y
          // clases de caracteres; \n = rescate (regex roto, seguir normal).
          i++;
          let inClass = false;
          while (i < n) {
            const rc = content[i];
            if (rc === '\\') { i += 2; continue; }
            if (rc === '\n') break;
            if (rc === '[') inClass = true;
            else if (rc === ']') inClass = false;
            else if (rc === '/' && !inClass) { i++; break; }
            i++;
          }
          prev = '/';
          continue;
        }
        if (!/\s/.test(c)) prev = c;
        i++; continue;
      }
      if (mode === 'sq') {
        if (c === '\\') { i += 2; continue; }
        if (c === "'" || c === '\n') mode = 'code';
        i++; continue;
      }
      if (mode === 'dq') {
        if (c === '\\') { i += 2; continue; }
        if (c === '"' || c === '\n') mode = 'code';
        i++; continue;
      }
      if (mode === 'line') {
        if (c === '\n') mode = 'code';
        i++; continue;
      }
      // block comment
      if (c === '*' && d === '/') { mode = 'code'; i += 2; continue; }
      i++; continue;
    }

    if (top === -1) {                   // cuerpo del template
      if (c === '\\') {
        out[i] = ' ';
        if (i + 1 < n && content[i + 1] !== '\n') out[i + 1] = ' ';
        i += 2;
        continue;
      }
      if (c === '`') {
        stack.pop();
        if (stack.length) out[i] = ' '; // backtick de template ANIDADO: también se blanquea
        i++;
        continue;
      }
      if (c === '$' && content[i + 1] === '{') {
        out[i] = ' '; out[i + 1] = ' ';
        stack.push(1);
        i += 2;
        continue;
      }
      if (c !== '\n') out[i] = ' ';
      i++;
      continue;
    }
    // top >= 1 → dentro de ${ ... } (también es código embebido, se blanquea)
    if (c === '`') { stack.push(-1); out[i] = ' '; i++; continue; }
    if (c === '{') stack[stack.length - 1]++;
    else if (c === '}') {
      stack[stack.length - 1]--;
      if (stack[stack.length - 1] === 0) { stack.pop(); out[i] = ' '; i++; continue; }
    }
    if (c !== '\n') out[i] = ' ';
    i++;
  }
  return out.join('');
}

function extractJS(content, filePath) {
  const symbols = [];
  const edges   = [];

  // Vista "solo código" para los patrones de símbolos/endpoints/calls — el
  // contenido de los template literals queda en blanco (mismas líneas, sin
  // texto). extractUsesClass usa el contenido CRUDO más abajo: las clases CSS
  // de las vistas viven justamente DENTRO de esos templates.
  const rawContent = content;
  content = blankTemplateLiterals(content);

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

  // Enum (TypeScript) — símbolo granular que antes no se distinguía de 'class'
  const enumPattern = /^(?:export\s+)?(?:const\s+)?enum\s+(\w+)/gm;
  while ((m = enumPattern.exec(content)) !== null) {
    const line = content.substring(0, m.index).split('\n').length;
    symbols.push({ symbol_name: m[1], kind: 'enum', line_start: line, exported: /^export/.test(m[0]) ? 1 : 0 });
  }

  // Constantes reales (convención SCREAMING_SNAKE_CASE) — deliberadamente NO
  // se intenta capturar toda declaración `const`, porque ya colisionaría con
  // los arrow functions que fnPatterns extrae como 'function'. Este patrón
  // solo dispara con nombres en mayúsculas, que por convención nunca son
  // funciones — cero riesgo de duplicar el mismo símbolo con dos 'kind'.
  // (?:\s*:[^=\n]*)? — anotación de tipo TS opcional (Plan 3, hallazgo de la
  // medición): `export const PLAN_LIMITS: Record<...> =` no matcheaba porque
  // el patrón exigía el `=` inmediatamente después del nombre.
  const constPattern = /^(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)(?:\s*:[^=\n]*)?\s*=/gm;
  while ((m = constPattern.exec(content)) !== null) {
    const line = content.substring(0, m.index).split('\n').length;
    symbols.push({ symbol_name: m[1], kind: 'constant', line_start: line, exported: /^export/.test(m[0]) ? 1 : 0 });
  }

  // Endpoints de API (Express-style) como nodos reales del grafo — antes solo
  // vivían como heurística recalculada en vivo por el dashboard (endpoint≈),
  // nunca como símbolo persistido. Mismo patrón que ya usa dashboard.cjs.
  // v3.13 (Plan 4): + fastify (mismo estilo de registro que router/app).
  const endpointPattern = /\b(?:router|app|fastify)\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  while ((m = endpointPattern.exec(content)) !== null) {
    const line = content.substring(0, m.index).split('\n').length;
    symbols.push({ symbol_name: `${m[1].toUpperCase()} ${m[2]}`, kind: 'endpoint', line_start: line, exported: 1 });
  }

  // NestJS (Plan 4): @Controller('prefix') + @Get('sub') → 'GET /prefix/sub'.
  // Gate: solo si el archivo tiene @Controller — un @Get suelto sin controller
  // puede ser otro decorador y produciría endpoints fantasma.
  const ctrlMatch = content.match(/@Controller\s*\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/);
  if (ctrlMatch) {
    const ctrlPrefix = ('/' + (ctrlMatch[1] || '')).replace(/\/+/g, '/');
    const nestPattern = /@(Get|Post|Put|Delete|Patch)\s*\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/g;
    while ((m = nestPattern.exec(content)) !== null) {
      const line = content.substring(0, m.index).split('\n').length;
      const ruta = ((ctrlPrefix + (m[2] ? '/' + m[2] : '')) || '/').replace(/\/+/g, '/');
      symbols.push({ symbol_name: `${m[1].toUpperCase()} ${ruta}`, kind: 'endpoint', line_start: line, exported: 1 });
    }
  }

  const callableSymbols = symbols.filter(s => s.kind === 'function' || s.kind === 'class');
  const callEdges = extractCallsWithinFile(content, callableSymbols);
  edges.push(...callEdges);

  // Plan 2 (Fase A): clases CSS usadas en JSX/templates de este archivo JS —
  // sobre el contenido CRUDO (las class= de los templates son justo lo que buscamos)
  extractUsesClass(rawContent, edges);

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

  // Endpoints Python (Plan 4) — mismo símbolo normalizado 'METHOD /ruta':
  // Flask: @app.route('/x', methods=['GET','POST']) → un endpoint por método (ANY sin methods)
  const flaskPat = /@\w+\.route\s*\(\s*['"]([^'"]+)['"]\s*(?:,[^)]*methods\s*=\s*\[([^\]]*)\])?/g;
  while ((m = flaskPat.exec(content)) !== null) {
    const line = content.substring(0, m.index).split('\n').length;
    const methods = m[2]
      ? m[2].split(',').map(s => s.replace(/['"\s]/g, '').toUpperCase()).filter(Boolean)
      : ['ANY'];
    methods.forEach(met => symbols.push({ symbol_name: `${met} ${m[1]}`, kind: 'endpoint', line_start: line, exported: 1 }));
  }
  // FastAPI: @app.get('/x') / @router.post('/x')
  const fastapiPat = /@\w+\.(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/g;
  while ((m = fastapiPat.exec(content)) !== null) {
    const line = content.substring(0, m.index).split('\n').length;
    symbols.push({ symbol_name: `${m[1].toUpperCase()} ${m[2]}`, kind: 'endpoint', line_start: line, exported: 1 });
  }
  // Django: path('x/', view) — solo en urls.py (path() es nombre común; fuera
  // de urls.py produciría endpoints fantasma)
  if (/urls\.py$/i.test(String(_filePath || ''))) {
    const djangoPat = /\bpath\s*\(\s*['"]([^'"]+)['"]/g;
    while ((m = djangoPat.exec(content)) !== null) {
      const line = content.substring(0, m.index).split('\n').length;
      symbols.push({ symbol_name: ('ANY /' + m[1]).replace(/\/+/g, '/'), kind: 'endpoint', line_start: line, exported: 1 });
    }
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

  // Endpoints Go (Plan 4): gin/echo r.GET("/x", ...) + net/http HandleFunc("/x", ...)
  const ginPat = /\.\s*(GET|POST|PUT|DELETE|PATCH)\s*\(\s*"([^"]+)"/g;
  while ((m = ginPat.exec(content)) !== null) {
    const line = content.substring(0, m.index).split('\n').length;
    symbols.push({ symbol_name: `${m[1]} ${m[2]}`, kind: 'endpoint', line_start: line, exported: 1 });
  }
  const handleFuncPat = /\bHandleFunc\s*\(\s*"([^"]+)"/g;
  while ((m = handleFuncPat.exec(content)) !== null) {
    const line = content.substring(0, m.index).split('\n').length;
    symbols.push({ symbol_name: `ANY ${m[1]}`, kind: 'endpoint', line_start: line, exported: 1 });
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

  // Endpoints Spring (Plan 4): @GetMapping("/x") / @PostMapping(value = "/x")
  const springPat = /@(Get|Post|Put|Delete|Patch)Mapping\s*\(\s*(?:value\s*=\s*)?['"]([^'"]+)['"]/g;
  while ((m = springPat.exec(content)) !== null) {
    const line = content.substring(0, m.index).split('\n').length;
    symbols.push({ symbol_name: `${m[1].toUpperCase()} ${m[2]}`, kind: 'endpoint', line_start: line, exported: 1 });
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

  // Endpoints Laravel (Plan 4): Route::get('/x', ...)
  const laravelPat = /Route::(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/g;
  while ((m = laravelPat.exec(content)) !== null) {
    const line = content.substring(0, m.index).split('\n').length;
    symbols.push({ symbol_name: `${m[1].toUpperCase()} ${m[2]}`, kind: 'endpoint', line_start: line, exported: 1 });
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

  // Endpoints Rails (Plan 4): get '/x' — solo en routes.rb (fuera del DSL de
  // rutas, un "get 'x'" suelto sería otra cosa)
  if (/routes\.rb$/i.test(String(_filePath || ''))) {
    const railsPat = /^[ \t]*(get|post|put|patch|delete)\s+['"]([^'"]+)['"]/gm;
    while ((m = railsPat.exec(content)) !== null) {
      const line = content.substring(0, m.index).split('\n').length;
      symbols.push({ symbol_name: `${m[1].toUpperCase()} ${m[2]}`, kind: 'endpoint', line_start: line, exported: 1 });
    }
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

// ─── LINE_END: FRONTERA POR SIGUIENTE SÍMBOLO (v3.13 — Plan 1) ────────────────
// Un símbolo "termina" donde empieza el siguiente símbolo de frontera — el
// mismo criterio ownerAt de extractCallsWithinFile, ahora persistido en la BD.
// NUNCA se cuentan llaves: strings/comentarios/template literals hacen frágil
// el brace-matching; comparar números de línea no se confunde con texto.
//
// Solo son FRONTERA los kinds cuyo regex está anclado a inicio de línea (^…gm):
// los demás (endpoint, markers note/why/hack/fixme) pueden vivir DENTRO de un
// cuerpo — usarlos como frontera recortaría rangos en la dirección PELIGROSA
// (faltaría rango en vez de sobrar). La imprecisión resultante (líneas en
// blanco entre símbolos quedan dentro del rango) cae hacia el lado seguro:
// un guardia que revisa de más, nunca de menos.
const BOUNDARY_KINDS = new Set(['function', 'class', 'interface', 'type', 'enum', 'constant', 'struct']);

function computeLineEnds(symbols, content) {
  const totalLineas = content.split('\n').length;

  const fronteras = symbols
    .filter(s => BOUNDARY_KINDS.has(s.kind) && s.line_start > 0)
    .sort((a, b) => a.line_start - b.line_start);
  for (let i = 0; i < fronteras.length; i++) {
    fronteras[i].line_end = i + 1 < fronteras.length
      ? Math.max(fronteras[i + 1].line_start - 1, fronteras[i].line_start)
      : totalLineas;
  }

  // Endpoints: hasta el próximo endpoint o la próxima frontera, lo que llegue
  // antes — cubre el handler inline de router.get('/x', async (req,res)=>{…}).
  const endpoints = symbols
    .filter(s => s.kind === 'endpoint' && s.line_start > 0)
    .sort((a, b) => a.line_start - b.line_start);
  const cortes = [...endpoints, ...fronteras].map(s => s.line_start).sort((a, b) => a - b);
  for (const ep of endpoints) {
    const siguiente = cortes.find(l => l > ep.line_start);
    ep.line_end = siguiente ? Math.max(siguiente - 1, ep.line_start) : totalLineas;
  }

  // SQL: cada tabla/índice termina donde empieza el siguiente símbolo SQL.
  const sqlSyms = symbols
    .filter(s => (s.kind === 'sql_table' || s.kind === 'sql_index') && s.line_start > 0)
    .sort((a, b) => a.line_start - b.line_start);
  for (let i = 0; i < sqlSyms.length; i++) {
    sqlSyms[i].line_end = i + 1 < sqlSyms.length
      ? Math.max(sqlSyms[i + 1].line_start - 1, sqlSyms[i].line_start)
      : totalLineas;
  }

  // Todo lo demás (markers, etc.): línea única.
  symbols.forEach(s => { if (!s.line_end) s.line_end = s.line_start || 0; });
}

// ─── INDEXAR UN ARCHIVO ───────────────────────────────────────────────────────

// ─── PIEZA 7: RESOLVER DE IMPORTS COMPARTIDO (importMap determinista) ─────────
// Antes, CADA edge IMPORTS re-resolvía su specifier con hasta 8 fs.existsSync,
// repitiendo el trabajo para specifiers idénticos desde la misma carpeta, y sin
// soporte de alias (@/, ~/). Este resolver se crea UNA vez por corrida de
// indexado y memoiza cada (carpeta, specifier) → misma resolución para todos,
// bit-idéntica entre corridas, más rápida, y con alias del tsconfig/jsconfig.
// ADITIVO: indexFile lo recibe como parámetro OPCIONAL — cualquier caller viejo
// que no lo pase obtiene el comportamiento inline original, intacto.
// Quita comentarios // y /* */ de un JSONC SIN romper strings — un regex simple
// aquí es una trampa: los tsconfig reales tienen globs como "@/*" y "**/*.mts"
// dentro de strings, y un /\/\*...\*\//g se come desde el /* de "@/*" hasta el
// */ de "**/*.mts", destruyendo justo la sección paths (bug real encontrado
// probando contra el tsconfig de un proyecto Next.js).
function stripJsonComments(raw) {
  let out = '', inStr = false, i = 0;
  while (i < raw.length) {
    const c = raw[i], n = raw[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') { out += n || ''; i += 2; continue; }
      if (c === '"') inStr = false;
      i++; continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < raw.length && raw[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i++; i += 2; continue; }
    out += c; i++;
  }
  return out;
}

function loadAliasTable(projectRoot) {
  // tsconfig.json / jsconfig.json → compilerOptions.paths + baseUrl.
  // Parse tolerante (los tsconfig reales traen comentarios): si no parsea,
  // simplemente no hay alias — nunca rompe el indexado.
  for (const cfgName of ['tsconfig.json', 'jsconfig.json']) {
    try {
      const raw = stripJsonComments(fs.readFileSync(path.join(projectRoot, cfgName), 'utf8'))
        .replace(/,\s*([}\]])/g, '$1');        // comas colgantes
      const cfg = JSON.parse(raw);
      const paths = cfg?.compilerOptions?.paths;
      if (!paths) continue;
      const baseUrl = cfg?.compilerOptions?.baseUrl || '.';
      const table = [];
      for (const [pattern, targets] of Object.entries(paths)) {
        if (!Array.isArray(targets) || !targets.length) continue;
        // "@/*": ["./src/*"] → prefijo "@/" apunta a "<base>/src/"
        table.push({
          prefix: pattern.replace(/\*$/, ''),
          target: path.resolve(projectRoot, baseUrl, String(targets[0]).replace(/\*$/, '')),
        });
      }
      if (table.length) return table;
    } catch { /* siguiente candidato */ }
  }
  return [];
}

function createImportResolver(projectRoot) {
  const aliasTable = loadAliasTable(projectRoot);
  const cache = new Map();
  const stats = { resolved: 0, unresolved: 0, cacheHits: 0, aliasResolved: 0 };

  // Mismos candidatos que la resolución inline original (incluye el fix
  // TS+ESM de reemplazo de extensión del 14/07) — una sola fuente de verdad.
  function probeCandidates(resolvedBase) {
    const candidates = [resolvedBase];
    const extMatch = resolvedBase.match(/\.(js|jsx|mjs|cjs)$/i);
    if (extMatch) {
      const base = resolvedBase.slice(0, -extMatch[0].length);
      candidates.push(base + '.ts', base + '.tsx');
    }
    const extensions = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js'];
    for (const ext of extensions) candidates.push(resolvedBase + ext);
    for (const c of candidates) {
      if (fs.existsSync(c)) return path.relative(projectRoot, c);
    }
    return null;
  }

  function resolve(fromFileAbs, specifier) {
    if (!specifier) return null;
    let key, resolvedBase = null;

    if (specifier.startsWith('.')) {
      const dir = path.dirname(fromFileAbs);
      key = dir + '|' + specifier;
      if (cache.has(key)) { stats.cacheHits++; return cache.get(key); }
      resolvedBase = path.resolve(dir, specifier);
    } else {
      const alias = aliasTable.find(a => specifier.startsWith(a.prefix));
      if (!alias) return null;  // bare import (npm) — igual que siempre: null
      key = 'alias|' + specifier;
      if (cache.has(key)) { stats.cacheHits++; return cache.get(key); }
      resolvedBase = path.join(alias.target, specifier.slice(alias.prefix.length));
    }

    const result = probeCandidates(resolvedBase);
    cache.set(key, result);
    if (result) { stats.resolved++; if (key.startsWith('alias|')) stats.aliasResolved++; }
    else stats.unresolved++;
    return result;
  }

  return { resolve, stats };
}

function indexFile(db, filePath, projectRoot, importResolver = null) {
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
  symbols.push(...extractCommentMarkers(content));
  computeLineEnds(symbols, content);

  // Limpiar registros anteriores
  try {
    db.prepare('DELETE FROM ast_symbols WHERE file = ?').run(relPath);
    db.prepare('DELETE FROM ast_edges WHERE from_file = ?').run(relPath);
  } catch {}

  // Insertar símbolos
  // line_end incluido (v3.13): la columna existía en el schema desde v1 pero el
  // INSERT la omitía — aunque alguien la calculara, jamás se escribía.
  const insertSym = db.prepare(`
    INSERT OR REPLACE INTO ast_symbols
      (file, language, symbol_name, kind, line_start, line_end, exported, signature, content_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const sym of symbols) {
    try {
      insertSym.run(relPath, language, sym.symbol_name, sym.kind, sym.line_start || 0, sym.line_end || 0, sym.exported || 0, sym.signature || null, hash);
    } catch {}
  }

  // Resolver y insertar edges
  const insertEdge = db.prepare(`
    INSERT INTO ast_edges (from_file, to_file, from_symbol, to_symbol, kind, weight)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const edge of edges) {
    let toFile = null;
    if (edge.kind === 'CALLS') {
      toFile = relPath; // llamada local — mismo archivo, por construcción
    } else if (importResolver && edge.to_symbol && edge.kind === 'IMPORTS') {
      // PIEZA 7: resolver compartido/memoizado (cubre relativos Y alias @/).
      // Mismos candidatos que el inline de abajo — misma respuesta, menos I/O.
      toFile = importResolver.resolve(filePath, edge.to_symbol);
    } else if (edge.to_symbol?.startsWith('.')) {
      const resolved = path.resolve(path.dirname(filePath), edge.to_symbol);

      // Bug real encontrado el 14/07/2026 mirando por qué el back (TypeScript
      // + ESM) no mostraba NINGUNA conexión interna en el grafo, mientras el
      // front (JS plano) sí: en TS+ESM el código fuente escribe
      // "./archetypes.js" aunque el archivo real en disco es "archetypes.ts"
      // (convención real de TypeScript moderno con módulos ESM). El código
      // viejo solo probaba AGREGAR una extensión al final (dejando
      // "archetypes.js.ts", que nunca existe) — nunca intentaba REEMPLAZAR
      // el .js/.jsx del propio specifier por .ts/.tsx. Resultado real medido:
      // 1334 de 1389 imports del proyecto (96%, casi todo el back) quedaban
      // sin resolver. candidates prueba primero la ruta tal cual (cubre el
      // caso del front, que sí es .js -> .js real, sin desajuste), después
      // el reemplazo de extensión (cubre el caso TS+ESM), y por último el
      // agregado de extensión de siempre (cubre imports sin extensión, ej.
      // "./utils").
      const candidates = [resolved];
      const extMatch = resolved.match(/\.(js|jsx|mjs|cjs)$/i);
      if (extMatch) {
        const base = resolved.slice(0, -extMatch[0].length);
        candidates.push(base + '.ts', base + '.tsx');
      }
      const extensions = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js'];
      for (const ext of extensions) candidates.push(resolved + ext);

      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          toFile = path.relative(projectRoot, candidate);
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

// ─── ENLACE CSS→VISTA (Plan 2, Fase A) ────────────────────────────────────────
// Resuelve to_file de los edges USES_CLASS pendientes buscando qué archivo(s)
// CSS definen cada clase (igualdad EXACTA de symbol_name — nada de LIKE).
// Clase definida en 2+ archivos CSS → un edge por cada definición.
function linkCssEdges(db) {
  let pend;
  try {
    pend = db.prepare("SELECT id, from_file, from_symbol, to_symbol, weight FROM ast_edges WHERE kind = 'USES_CLASS' AND to_file IS NULL").all();
  } catch { return { linked: 0 }; }
  if (!pend || !pend.length) return { linked: 0 };

  let linked = 0;
  for (const e of pend) {
    let defs;
    try {
      defs = db.prepare("SELECT DISTINCT file FROM ast_symbols WHERE kind = 'css_class' AND symbol_name = ?").all(e.to_symbol);
    } catch { continue; }
    if (!defs || !defs.length) continue;
    try {
      db.prepare('UPDATE ast_edges SET to_file = ? WHERE id = ?').run(defs[0].file, e.id);
      linked++;
      for (let i = 1; i < defs.length; i++) {
        db.prepare('INSERT INTO ast_edges (from_file, to_file, from_symbol, to_symbol, kind, weight) VALUES (?, ?, ?, ?, ?, ?)')
          .run(e.from_file, defs[i].file, e.from_symbol, e.to_symbol, 'USES_CLASS', e.weight);
      }
    } catch {}
  }
  return { linked };
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
        links = db.prepare("SELECT to_file, weight FROM ast_edges WHERE from_file = ? AND to_file IS NOT NULL AND kind != 'CALLS'").all(file);
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
      WHERE (to_file LIKE ? OR to_symbol LIKE ?) AND kind != 'CALLS' AND (to_file IS NULL OR to_file != from_file)
      ORDER BY weight DESC
    `).all(`%${target}%`, `%${target}%`);

    indirectFiles = db.prepare(`
      SELECT DISTINCT ae2.from_file
      FROM ast_edges ae1
      JOIN ast_edges ae2 ON ae1.from_file = ae2.to_file
      WHERE ae1.to_file LIKE ? AND ae1.kind != 'CALLS' AND ae2.kind != 'CALLS'
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

// Plan 7 (T6): sello de versión del índice — SUBIR este número cada vez que
// cambien extractores/kinds/line_end. Un cliente viejo que corre `akdd update`
// trae el motor nuevo pero su índice cacheado (por hash de contenido) JAMÁS se
// recalcularía solo: line_end quedaría en 0 y los kinds nuevos no existirían
// (la "trampa del caché", medida en v3.13). El sello fuerza UNA reconstrucción
// completa y automática la primera vez que el motor nuevo indexa.
const INDEX_VERSION = 4;

function indexProject(projectRoot, targetDir = null) {
  const db = openDB(projectRoot);
  initASTSchema(db);

  try {
    db.exec(`CREATE TABLE IF NOT EXISTS project_settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now'))
    )`);
    const v = db.prepare(`SELECT value FROM project_settings WHERE key='index_version'`).get();
    if (!v || parseInt(v.value, 10) !== INDEX_VERSION) {
      console.log(`[AST-INDEXER] Versión de índice ${v ? v.value : '(ninguna)'} → ${INDEX_VERSION}: reconstrucción completa automática (una sola vez)`);
      db.exec('DELETE FROM ast_symbols; DELETE FROM ast_edges;');
      db.prepare(`INSERT OR REPLACE INTO project_settings (key, value, updated_at) VALUES ('index_version', ?, datetime('now'))`)
        .run(String(INDEX_VERSION));
    }
  } catch { /* el sello es un plus — sin project_settings el index corre igual */ }
  db.exec(`
    CREATE TABLE IF NOT EXISTS ast_index_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ran_at TEXT DEFAULT (datetime('now')),
      changed_files TEXT
    );
  `);

  const searchDir = targetDir ? path.join(projectRoot, targetDir) : projectRoot;
  const files = getAllSourceFiles(searchDir, projectRoot);

  console.log(`[AST-INDEXER] Indexando ${files.length} archivos en ${path.relative(process.cwd(), searchDir) || '.'}`);

  // PIEZA 7: un solo resolver de imports para toda la corrida — memoizado,
  // determinista y con alias. Best-effort: si su creación falla, se indexa
  // exactamente igual que siempre (indexFile cae al inline original).
  let importResolver = null;
  try { importResolver = createImportResolver(projectRoot); } catch {}

  let indexed = 0, skipped = 0, cached = 0, errors = 0;
  const changedFiles = [];

  for (const file of files) {
    const result = indexFile(db, file, projectRoot, importResolver);
    if (result.cached) cached++;
    else if (result.skipped) skipped++;
    else if (result.error) errors++;
    else {
      indexed++;
      changedFiles.push(path.relative(projectRoot, file));
      if (indexed % 50 === 0) process.stdout.write(`\r[AST-INDEXER] ${indexed}/${files.length}...`);
    }
  }

  process.stdout.write('\n');
  // Pasada de enlace CSS→vista (Plan 2, Fase A): los edges USES_CLASS nacen con
  // to_file NULL (al extraer una vista no se sabe qué CSS define la clase) —
  // aquí, con TODO indexado, se resuelven por igualdad exacta de symbol_name.
  try {
    const cssLink = linkCssEdges(db);
    if (cssLink.linked) console.log(`[AST-INDEXER] ${cssLink.linked} edges CSS→vista enlazados`);
  } catch {}
  // PIEZA 7: métrica del resolver — visible para poder comparar corridas.
  if (importResolver && (importResolver.stats.resolved || importResolver.stats.unresolved)) {
    const s = importResolver.stats;
    console.log(`[AST-INDEXER] importMap: ${s.resolved} resueltos (${s.aliasResolved} por alias) · ${s.unresolved} sin resolver · ${s.cacheHits} cache hits`);
  }
  console.log('[AST-INDEXER] Calculando PageRank...');
  computePageRank(db);

  try {
    db.prepare('INSERT INTO ast_index_runs (changed_files) VALUES (?)').run(JSON.stringify(changedFiles));
  } catch {}

  console.log(`[AST-INDEXER] ✅ Completado: ${indexed} indexados, ${cached} en caché, ${skipped} omitidos`);
  try { db.close(); } catch {}
  return { indexed, cached, skipped, errors, changedFiles };
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
  extractCallsWithinFile,
  // Export aditivo (Pieza 1): change-classifier.cjs reusa los mismos extractores
  // para calcular firmas estructurales — una sola fuente de verdad de parsing.
  EXTRACTORS,
  // Export aditivo (Pieza 7): resolver compartido de imports, memoizado y con
  // alias — indexProject lo crea una vez por corrida; expuesto para tests.
  createImportResolver,
};
