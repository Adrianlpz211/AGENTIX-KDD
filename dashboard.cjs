#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execSync } = require('child_process');

const PORT = parseInt(process.env.AKDD_DASH_PORT, 10) || 3847; // override: AKDD_DASH_PORT (permite correr dos versiones lado a lado)
const projectPath = process.cwd();
const dbPath = path.join(projectPath, '.agentic', 'memoria.db');
const grafoPath = fs.existsSync(path.join(projectPath, '.agentic', 'grafo', 'grafo.cjs'))
  ? path.join(projectPath, '.agentic', 'grafo', 'grafo.cjs')
  : path.join(projectPath, '.agentic', 'grafo', 'grafo.js');
const configPath = path.join(projectPath, '.agentic', 'config.md');
const memoriaPath = path.join(projectPath, '.agentic', 'memoria');

if (!fs.existsSync(configPath)) { console.log('\n  Agentix KDD not installed.\n'); process.exit(1); }
if (fs.existsSync(grafoPath)) { try { process.stdout.write('  Syncing... '); execSync(`node "${grafoPath}" sync`, { stdio: 'pipe', cwd: projectPath }); console.log('✓'); } catch {} }

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/`/g, '&#96;')
    .replace(/\$/g, '&#36;');
}

function readConfig() {
  try {
    const c = fs.readFileSync(configPath, 'utf8');
    const lines = c.split('\n');

    const get = (key) => (c.match(new RegExp(key + ': (.+)')) || [])[1]?.trim() || '—';

    // Busca una sección que EMPIECE con el prefijo dado y recoge hasta la siguiente sección del mismo nivel
    const getBlock = (prefix, stopLevel) => {
      const startIdx = lines.findIndex(l => l.trimStart().startsWith(prefix));
      if (startIdx === -1) return '';
      const stopRe = stopLevel === '##' ? /^## / : /^### /;
      let result = [];
      for (let i = startIdx + 1; i < lines.length; i++) {
        if (lines[i].match(stopRe)) break;
        result.push(lines[i]);
      }
      return result.join('\n').trim();
    };

    // Leer stack — soporta múltiples formatos de config.md
    const getYaml = (key) => {
      // Formato 1: yaml "  key: value"
      let m = c.match(new RegExp('  ' + key + ': (.+)'));
      if (m) return m[1].trim();
      // Formato 2: markdown bold "**KEY:** value" (case insensitive)
      m = c.match(new RegExp('\\*\\*' + key + '\\*\\*:?\\s*(.+)', 'i'));
      if (m) return m[1].replace(/\*\*/g,'').trim();
      // Formato 3: uppercase "KEY: value"
      m = c.match(new RegExp('(?:^|\n)' + key.toUpperCase() + ': (.+)'));
      if (m) return m[1].trim();
      return '—';
    };

    // Extraer stack completo si existe como campo STACK
    const getStack = () => {
      const m = c.match(/(?:STACK|stack|Stack):?\s*(.+)/);
      return m ? m[1].replace(/\*\*/g,'').trim() : null;
    };
    const stackFull = getStack();

    // Para framework: intentar detectar de package.json si config.md no lo tiene
    const getPkgJson = (field) => {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(projectPath, 'package.json'), 'utf8'));
        const deps = {...(pkg.dependencies||{}), ...(pkg.devDependencies||{})};
        if (field === 'framework') {
          if (deps['next']) return 'Next.js ' + (deps['next']||'');
          if (deps['express']) return 'Express';
          if (deps['fastify']) return 'Fastify';
          if (deps['@nestjs/core']) return 'NestJS';
          if (deps['hono']) return 'Hono';
        }
        if (field === 'language') {
          if (deps['typescript'] || deps['ts-node']) return 'TypeScript';
          return 'JavaScript';
        }
        if (field === 'runtime') {
          return 'Node.js ' + (pkg.engines?.node || '18+');
        }
        if (field === 'base_datos') {
          if (deps['@prisma/client']) return 'Prisma';
          if (deps['pg'] || deps['postgres']) return 'PostgreSQL';
          if (deps['mysql2']) return 'MySQL';
          if (deps['better-sqlite3']) return 'SQLite';
        }
        if (field === 'package_manager') {
          if (fs.existsSync(path.join(projectPath, 'yarn.lock'))) return 'yarn';
          if (fs.existsSync(path.join(projectPath, 'pnpm-lock.yaml'))) return 'pnpm';
          return 'npm';
        }
      } catch {}
      return null;
    };

    const smartGet = (key) => {
      const fromYaml = getYaml(key);
      if (fromYaml && fromYaml !== '—') return fromYaml;
      const fromPkg = getPkgJson(key);
      if (fromPkg) return fromPkg;
      return stackFull || '—';
    };

    return {
      nombre: get('Nombre'),
      descripcion: (() => {
        // Descripción puede ser multilínea con | (bloque YAML)...
        const pipeMatch = c.match(/Descripción: \|\n([\s\S]*?)(?=\nTipo:|$)/);
        if (pipeMatch) return pipeMatch[1].split('\n').map(l => l.trim()).filter(Boolean).join(' ');
        // ...o texto plano que sigue sin marcador en las líneas de abajo (el
        // formato real que usa este proyecto) — antes esto se cortaba en la
        // primera línea porque get() solo captura hasta el primer salto.
        const plainMatch = c.match(/Descripción:\s*([\s\S]*?)(?=\n(?:Tipo|Nombre):|\n##|\n\s*\n)/);
        if (plainMatch) return plainMatch[1].split('\n').map(l => l.trim()).filter(Boolean).join(' ');
        return get('Descripción');
      })(),
      tipo: get('Tipo'),
      framework: smartGet('framework'),
      language: smartGet('language'),
      runtime: smartGet('runtime'),
      base_datos: smartGet('base_datos'),
      package_manager: smartGet('package_manager'),
      stack: stackFull,
      cmd_dev: getYaml('dev'),
      cmd_test: getYaml('test'),
      cmd_build: getYaml('build'),
      implementados: getBlock('### Implementados', '###'),
      pendientes: getBlock('### Pendientes', '##'),
      reglas: getBlock('### Desarrollo', '###') || getBlock('## Reglas del proyecto', '##'),
      raw: c
    };
  } catch { return {}; }
}

function readMemoria(file) { try { const p = path.join(memoriaPath, file); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; } catch { return ''; } }

function readSpecs() {
  const specsPath = path.join(projectPath, '.agentic', 'specs');
  if (!fs.existsSync(specsPath)) return [];
  try {
    return fs.readdirSync(specsPath).filter(f => f.endsWith('.md')).map(f => {
      const c = fs.readFileSync(path.join(specsPath, f), 'utf8');
      const estado = (c.match(/Estado: (.+)/) || [])[1]?.trim() || 'DESCONOCIDO';
      const fecha = (c.match(/ltima actualización: (.+)/) || [])[1]?.trim() || '—';
      // La tabla "Suite | Tests | Estado" del spec siempre tiene 1 sola fila con
      // "PASS" en la plantilla, así que contar ocurrencias de PASS siempre da 1
      // sin importar cuántos tests reales tenga el módulo. El número real está
      // en la línea "Tests: N pasando" que sí se actualiza por ciclo.
      const testsLine = c.match(/Tests:\s*(\d+)\s*pasando/);
      const tests = testsLine ? parseInt(testsLine[1], 10) : (c.match(/PASS/g) || []).length;
      return { name: f.replace('.md',''), estado, fecha, tests };
    });
  } catch { return []; }
}

function readLogs() {
  const outputPath = path.join(projectPath, '_output');
  if (!fs.existsSync(outputPath)) return [];
  const logs = [];
  try {
    fs.readdirSync(outputPath).filter(f => f.startsWith('log-') && f.endsWith('.md')).forEach(f => {
      const c = fs.readFileSync(path.join(outputPath, f), 'utf8');
      c.split(/^## /m).filter(s => s.trim() && s.includes('Resultado:')).slice(0,20).forEach(entry => {
        const lines = entry.split('\n');
        const get = (k) => { for (const l of lines) { if (l.startsWith(k+':')) return l.split(':').slice(1).join(':').trim(); } return ''; };
        logs.push({ header: lines[0].trim().slice(0,55), modulo: get('Módulo'), resultado: get('Resultado'), tests: get('Tests'), patrones: get('Patrones KDD aplicados'), errores: get('Errores evitados'), sync: get('Sync grafo') });
      });
    });
  } catch {}
  return logs.slice(0,15);
}

function calcMetrics(logs) {
  if (ciclosDB && ciclosDB.length > 0) {
    const total       = ciclosDB.length;
    const completados = ciclosDB.filter(c => c.estado === 'COMPLETADO').length;
    const stops       = ciclosDB.filter(c => c.estado === 'STOP').length;
    const goal_attainment = Math.round(completados/total*100);
    const autonomy_ratio  = Math.round((total-stops)/total*100);
    const totalFases = ciclosDB.reduce((s,c) => s+(c.fases_total||0), 0);
    const fasesOK    = ciclosDB.reduce((s,c) => s+(c.fases_completadas||0), 0);
    const handoff    = totalFases>0 ? Math.round(fasesOK/totalFases*100) : 0;
    let patronesTotal=0, erroresTotal=0;
    ciclosDB.forEach(c => {
      try { patronesTotal += JSON.parse(c.patrones_aplicados||'[]').length; } catch(e) {}
      try { erroresTotal  += JSON.parse(c.errores_evitados||'[]').length; } catch(e) {}
    });
    const testsGen  = ciclosDB.reduce((s,c) => s+(c.tests_generados||0), 0);
    const testsOK   = ciclosDB.reduce((s,c) => s+(c.tests_pasando||0), 0);
    const test_rate = testsGen>0 ? Math.round(testsOK/testsGen*100) : 0;
    const totalBlockers = ciclosDB.reduce((s,c) => s+(c.review_blockers||0), 0);
    const drift_index   = (totalBlockers/total).toFixed(1);
    const guardrails    = ciclosDB.filter(c => c.context_guard === 'STOP').length;

    // Métrica 4: Tiempo promedio por ciclo (de los que tienen duracion)
    const conDur = ciclosDB.filter(c => c.duracion_ms > 0);
    const avg_duracion_ms = conDur.length>0
      ? Math.round(conDur.reduce((s,c)=>s+c.duracion_ms,0)/conDur.length) : 0;

    // Métrica 5: Éxito por tipo de tarea
    const tipoMap = {};
    ciclosDB.forEach(c => {
      const t = c.tipo_tarea || 'feature';
      if (!tipoMap[t]) tipoMap[t] = { total:0, ok:0 };
      tipoMap[t].total++;
      if (c.estado==='COMPLETADO') tipoMap[t].ok++;
    });
    const exito_por_tipo = Object.entries(tipoMap).map(([tipo,v]) => ({
      tipo, total:v.total, ok:v.ok, rate: Math.round(v.ok/v.total*100)
    }));

    // Métrica 6: Evolución de memoria (snapshots antes/después)
    let evolucion_memoria = null;
    const conSnap = ciclosDB.filter(c => c.snapshot_fin);
    if (conSnap.length >= 2) {
      try {
        const primero = JSON.parse(conSnap[conSnap.length-1].snapshot_fin);
        const ultimo  = JSON.parse(conSnap[0].snapshot_fin);
        evolucion_memoria = {
          nodos_inicio: primero.totales?.total || 0,
          nodos_ahora:  ultimo.totales?.total  || 0,
          alta_inicio:  primero.totales?.alta  || 0,
          alta_ahora:   ultimo.totales?.alta   || 0,
          crecimiento:  (ultimo.totales?.total||0) - (primero.totales?.total||0),
        };
      } catch(e) {}
    }

    // Reintentos desde fases
    let reintento_rate = 0, avg_fase_ms = 0;
    if (fasesDB && fasesDB.length > 0) {
      const conReintentos = fasesDB.filter(f => f.intentos > 1);
      reintento_rate = Math.round(conReintentos.length/fasesDB.length*100);
      const conFaseDur = fasesDB.filter(f => f.duracion_ms > 0);
      avg_fase_ms = conFaseDur.length>0
        ? Math.round(conFaseDur.reduce((s,f)=>s+f.duracion_ms,0)/conFaseDur.length) : 0;
    }

    return {
      total, completados, stops,
      goal_attainment, autonomy_ratio,
      handoff_integrity: handoff,
      drift_index, guardrail_violations: guardrails,
      patronesTotal, erroresTotal,
      test_rate, testsGen, testsOK,
      avg_duracion_ms, avg_fase_ms,
      reintento_rate, exito_por_tipo,
      evolucion_memoria,
      source: 'sqlite'
    };
  }
  // Fallback a logs de archivos
  const completados = logs.filter(l => l.resultado&&l.resultado.includes('COMPLETADO')).length;
  const stops = logs.filter(l => l.resultado&&l.resultado.includes('STOP')).length;
  let patronesTotal=0, erroresTotal=0;
  logs.forEach(l => {
    const pm=(l.patrones||'').match(/^(\d+)/); if(pm) patronesTotal+=parseInt(pm[1]);
    const em=(l.errores||'').match(/^(\d+)/);  if(em) erroresTotal+=parseInt(em[1]);
  });
  return {
    total:logs.length, completados, stops, patronesTotal, erroresTotal,
    goal_attainment: logs.length>0?Math.round(completados/logs.length*100):0,
    autonomy_ratio:0, handoff_integrity:0, drift_index:'0',
    guardrail_violations:0, test_rate:0, testsGen:0, testsOK:0,
    avg_duracion_ms:0, avg_fase_ms:0, reintento_rate:0,
    exito_por_tipo:[], evolucion_memoria:null, source:'logs'
  };
}

function calcOnboarding(config, mImpl, dec, pat, specsArr) {
  const checks = [
    { label: 'config.md configurado', ok: config.nombre !== '—' && config.tipo !== '—' },
    { label: 'Primer sync del grafo', ok: fs.existsSync(dbPath) },
    { label: 'Módulos documentados', ok: mImpl.length > 0 },
    { label: 'Primera decisión registrada', ok: dec.length > 0 },
    { label: 'Primer patrón registrado', ok: pat.length > 0 },
    { label: 'Primer ciclo aa: completado', ok: (ciclosDB && ciclosDB.length > 0) || readMemoria('trabajo.md').includes('COMPLETADO') },
    { label: 'Specs generadas', ok: specsArr.length > 0 },
  ];
  const done = checks.filter(c => c.ok).length;
  return { checks, done, total: checks.length, pct: Math.round(done/checks.length*100) };
}

const PLACEHOLDER_TITLES = /^(Título de la decisión|Título del patrón|Nombre del patrón|Nombre del error|Nombre del error o patrón)$/i;

function parseEntries(content) {
  return content.split(/^## /m)
    // El header y las instrucciones de formato de cada .md viven dentro de un
    // comentario HTML <!-- ... -->; como el split corta por "## " sin saber de
    // comentarios, el título de archivo y el ejemplo de formato ("## [FECHA]
    // Título de la decisión") se colaban como si fueran entradas reales.
    .filter(s => s.trim() && !s.startsWith('<!--') && !s.startsWith('Cómo') && !s.startsWith('Formato') && !s.startsWith('Registro') && !s.startsWith('Patrones') && s.length > 10)
    .filter(s => !s.includes('<!--') && !s.includes('-->'))
    .map(s => {
      const lines = s.split('\n');
      const titulo = lines[0].trim().replace(/^\[.*?\]\s*/, '').trim();
      if (!titulo || titulo.length < 5 || PLACEHOLDER_TITLES.test(titulo)) return null;
      const get = (k) => { for (const l of lines) { if (l.startsWith(k + ':')) return l.split(':').slice(1).join(':').trim(); } return ''; };
      return { titulo, area: get('Área') || get('Area') || 'global', confianza: get('Confianza') || 'BAJA', aplicado: parseInt(get('Aplicado')) || 0, util: parseInt(get('Útil') || get('Util')) || 0, estado: get('Estado') || 'ACTIVO', contenido: s };
    }).filter(Boolean);
}

const config = readConfig();
const patrones = parseEntries(readMemoria('patrones.md')).filter(p => p.estado === 'ACTIVO');
const decisiones = parseEntries(readMemoria('decisiones.md'));
const errores = parseEntries(readMemoria('errores.md'));

// Adjunta a cada nodo de memoria los símbolos de código que menciona de verdad
// (Bloque B + cruce del 15/07/2026) — relaciones_semanticas usa nombres de
// entidad en texto (desde_entidad/hacia_entidad), no ids como la tabla
// `relaciones` que ya usa el resto del grafo KDD, así que se resuelve aparte.
function attachSymbolMentions(nodes, mencionesRaw) {
  const porNodo = {};
  (mencionesRaw || []).forEach(m => {
    (porNodo[m.desde_entidad] = porNodo[m.desde_entidad] || []).push({
      simbolo: m.hacia_entidad, archivo: m.descripcion,
    });
  });
  nodes.forEach(n => {
    n.simbolosMencionados = porNodo[`nodo:${n.tipo}:${n.titulo}`] || [];
  });
  return nodes;
}

function getGraphData() {
  try {
    if (!fs.existsSync(dbPath)) return { nodes: [], edges: [], ciclos: [], fases: [] };
    let db = null, usingSqlJs = false;
    // Intentar better-sqlite3 primero, fallback a sql.js
    try {
      const BS3 = require('better-sqlite3');
      // (Se eliminó un wrapper `db` muerto que abría una conexión nueva por query sin cerrarla.)
      const _db = new BS3(dbPath, { readonly: true });
      const nodes = _db.prepare('SELECT * FROM nodos ORDER BY fecha_creacion DESC').all();
      const edges = _db.prepare('SELECT * FROM relaciones').all();
      let ciclos = [], fases = [], menciones = [];
      try { ciclos = _db.prepare('SELECT * FROM ciclos ORDER BY fecha_inicio DESC LIMIT 30').all(); } catch(e) {}
      try { fases  = _db.prepare('SELECT * FROM fases ORDER BY fecha_inicio DESC LIMIT 100').all(); } catch(e) {}
      try { menciones = _db.prepare("SELECT desde_entidad, hacia_entidad, descripcion FROM relaciones_semanticas WHERE tipo='menciona_simbolo'").all(); } catch(e) {}
      _db.close();
      return { nodes: attachSymbolMentions(nodes, menciones), edges, ciclos, fases };
    } catch(e) {
      // Fallback node:sqlite (better-sqlite3 no disponible — sin compilador C++)
      try {
        const { DatabaseSync } = require('node:sqlite');
        const _db = new DatabaseSync(dbPath);
        const allSQL = (sql) => {
          try { return _db.prepare(sql).all(); } catch(e) { return []; }
        };
        const nodes  = allSQL('SELECT * FROM nodos ORDER BY fecha_creacion DESC');
        const edges  = allSQL('SELECT * FROM relaciones');
        const ciclos = allSQL('SELECT * FROM ciclos ORDER BY fecha_inicio DESC LIMIT 30');
        const fases  = allSQL('SELECT * FROM fases ORDER BY fecha_inicio DESC LIMIT 100');
        const menciones = allSQL("SELECT desde_entidad, hacia_entidad, descripcion FROM relaciones_semanticas WHERE tipo='menciona_simbolo'");
        try { _db.close(); } catch {}
        return { nodes: attachSymbolMentions(nodes, menciones), edges, ciclos, fases };
      } catch(e2) {
        return { nodes: [], edges: [], ciclos: [], fases: [] };
      }
    }
  } catch { return { nodes: [], edges: [], ciclos: [], fases: [] }; }
}

// Agrupa un archivo en un "módulo" visual a partir de su ruta — más útil que el
// lenguaje para diferenciar colores cuando el proyecto es mono-lenguaje (ej. un
// Next.js todo en TypeScript): src/app vs src/lib vs src/components vs scripts,
// etc. quedan visualmente separados aunque compartan extensión.
function deriveModulo(file) {
  const parts = String(file).split(/[\\/]/).filter(Boolean);
  parts.pop(); // quitar el nombre de archivo
  if (!parts.length) return 'raíz';
  if (parts[0] === 'src' && parts.length > 1) return 'src/' + parts[1];
  return parts[0];
}

function getCodeStructureGraph() {
  const empty = { nodes: [], edges: [] };
  if (!fs.existsSync(dbPath)) return empty;

  // Agregación a nivel de ARCHIVO (no función individual) para que el
  // grafo sea legible — cientos de archivos es manejable, miles de funciones no.
  const FILES_SQL = `
    SELECT file,
           MAX(pagerank) as pagerank,
           COUNT(*) as symbol_count,
           SUM(CASE WHEN kind='function' THEN 1 ELSE 0 END) as functions,
           SUM(CASE WHEN kind='class' THEN 1 ELSE 0 END) as classes,
           MAX(language) as language
    FROM ast_symbols
    GROUP BY file
    ORDER BY pagerank DESC
  `;
  const EDGES_SQL = `
    SELECT DISTINCT from_file, to_file, kind, COUNT(*) as weight
    FROM ast_edges
    WHERE to_file IS NOT NULL AND kind IN ('IMPORTS','CALLS','EXTENDS','USES_CLASS')
    GROUP BY from_file, to_file, kind
  `;
  // Nombres reales de lo que cada archivo define — para "¡NO ENTIENDO!": listar
  // qué funciones/clases exporta es más honesto que inventar un resumen de
  // "para qué sirve" sin leer el contenido del archivo.
  const SYMBOLS_SQL = `
    SELECT file, symbol_name, kind, exported
    FROM ast_symbols
    WHERE kind IN ('function','class')
    ORDER BY exported DESC, symbol_name ASC
  `;
  // Símbolos "nuevos" (Bloque B — comentarios/constantes/endpoints/SQL, sesión
  // del 15/07/2026): se guardan aparte de SYMBOLS_SQL en vez de mezclarlos ahí
  // porque explainCodeNode() ya humaniza function/class con lógica propia
  // (camelCase → verbo en español) que no aplica a estos — un endpoint o una
  // nota ya son texto legible, no hay nada que "traducir".
  const EXTRA_SYMBOLS_SQL = `
    SELECT file, symbol_name, kind, signature
    FROM ast_symbols
    WHERE kind IN ('endpoint','constant','enum','note','why','hack','fixme','sql_table','sql_index','form','select','field','css_class','css_id')
    ORDER BY line_start ASC
  `;

  function buildGraph(files, rawEdges, rawSymbols, rawExtra) {
    const symbolsByFile = {};
    (rawSymbols || []).forEach(s => {
      (symbolsByFile[s.file] = symbolsByFile[s.file] || []).push({ name: s.symbol_name, kind: s.kind, exported: !!s.exported });
    });
    const extraByFile = {};
    (rawExtra || []).forEach(s => {
      (extraByFile[s.file] = extraByFile[s.file] || []).push({ name: s.symbol_name, kind: s.kind, signature: s.signature });
    });
    const nodes = files.map((f, i) => ({
      id: `code-${i}`,
      file: f.file,
      titulo: f.file.split(/[\\/]/).pop(),
      tipo: f.classes > 0 ? 'clase' : 'archivo',
      language: f.language || 'other',
      modulo: deriveModulo(f.file),
      symbol_count: f.symbol_count,
      functions: f.functions,
      pagerank: f.pagerank || 0,
      symbols: symbolsByFile[f.file] || [],
      extraSymbols: extraByFile[f.file] || [],
    }));
    const fileToId = {};
    nodes.forEach(n => { fileToId[n.file] = n.id; });

    const edges = rawEdges
      .filter(e => fileToId[e.from_file] && fileToId[e.to_file] && e.from_file !== e.to_file)
      .map(e => ({ source: fileToId[e.from_file], target: fileToId[e.to_file], tipo: e.kind, weight: e.weight }));

    return { nodes, edges };
  }

  // Intentar better-sqlite3 primero, fallback a sql.js (mismo patrón que getGraphData())
  try {
    const BS3 = require('better-sqlite3');
    const _db = new BS3(dbPath, { readonly: true });
    try {
      const files = _db.prepare(FILES_SQL).all();
      const rawEdges = _db.prepare(EDGES_SQL).all();
      const rawSymbols = _db.prepare(SYMBOLS_SQL).all();
      const rawExtra = _db.prepare(EXTRA_SYMBOLS_SQL).all();
      return buildGraph(files, rawEdges, rawSymbols, rawExtra);
    } finally {
      try { _db.close(); } catch {}
    }
  } catch (e) {
    // Fallback node:sqlite (better-sqlite3 no disponible — sin compilador C++)
    try {
      const { DatabaseSync } = require('node:sqlite');
      const _db = new DatabaseSync(dbPath);
      const allSQL = (sql) => {
        try { return _db.prepare(sql).all(); } catch(e) { return []; }
      };
      const files = allSQL(FILES_SQL);
      const rawEdges = allSQL(EDGES_SQL);
      const rawSymbols = allSQL(SYMBOLS_SQL);
      const rawExtra = allSQL(EXTRA_SYMBOLS_SQL);
      try { _db.close(); } catch {}
      return buildGraph(files, rawEdges, rawSymbols, rawExtra);
    } catch(e2) {
      return empty;
    }
  }
}


// ─── Task 9: STRUCTURAL LEARNING VERIFICATION DATA ───────────────────────────
function getStructuralLearningData() {
  const empty = { patronesEstructurales: 0, ultimoIndex: null, archivosCambiados: 0, cadenasActivas: [] };
  try {
    const patronesRaw = readMemoria('patrones.md');
    const matches = [...patronesRaw.matchAll(/\[ESTRUCTURAL\] (.+)/g)];
    const cadenasActivas = matches.map(m => m[1].trim()).slice(0, 5);

    let ultimoIndex = null, archivosCambiados = 0;
    if (fs.existsSync(dbPath)) {
      const LAST_INDEX_SQL = 'SELECT ran_at, changed_files FROM ast_index_runs ORDER BY id DESC LIMIT 1';
      let last = null;
      // Intentar better-sqlite3 primero, fallback a sql.js (mismo patrón que getGraphData())
      try {
        const BS3 = require('better-sqlite3');
        const _db = new BS3(dbPath, { readonly: true });
        try {
          last = _db.prepare(LAST_INDEX_SQL).get();
        } finally {
          try { _db.close(); } catch {}
        }
      } catch (e) {
        // Fallback node:sqlite (better-sqlite3 no disponible — sin compilador C++)
        try {
          const { DatabaseSync } = require('node:sqlite');
          const _db = new DatabaseSync(dbPath);
          try { last = _db.prepare(LAST_INDEX_SQL).get(); } catch {}
          try { _db.close(); } catch {}
        } catch (e2) {}
      }
      if (last) {
        ultimoIndex = last.ran_at;
        archivosCambiados = JSON.parse(last.changed_files || '[]').length;
      }
    }

    return { patronesEstructurales: matches.length, ultimoIndex, archivosCambiados, cadenasActivas };
  } catch {
    return empty;
  }
}


// ─── v3.3: CONTRACT GUARD DATA ────────────────────────────────────────────────
function getContractData() {
  const empty = { total:0, protected:0, verified:0, candidate:0, violations:0, recent:[] };
  if (!fs.existsSync(dbPath)) return empty;
  let _db;
  try {
    const BS3 = require('better-sqlite3');
    _db = new BS3(dbPath, { readonly: true });
    const safe = (fn) => { try { return fn(); } catch { return null; } };
    return {
      total:     safe(() => _db.prepare("SELECT COUNT(*) as n FROM verified_contracts").get()?.n) || 0,
      protected: safe(() => _db.prepare("SELECT COUNT(*) as n FROM verified_contracts WHERE status='protected'").get()?.n) || 0,
      verified:  safe(() => _db.prepare("SELECT COUNT(*) as n FROM verified_contracts WHERE status='verified'").get()?.n) || 0,
      candidate: safe(() => _db.prepare("SELECT COUNT(*) as n FROM verified_contracts WHERE status='candidate'").get()?.n) || 0,
      violations:safe(() => _db.prepare("SELECT COUNT(*) as n FROM contract_violations WHERE recovered=0").get()?.n) || 0,
      recent:    safe(() => _db.prepare("SELECT id, module, name, status, verification_count, failure_count FROM verified_contracts ORDER BY updated_at DESC LIMIT 8").all()) || [],
    };
  } catch { return empty; } finally { try { _db && _db.close(); } catch {} }
}

function getCreativeData() {
  const empty = { level:1, suggestions:0, wins:0, auto_applicable:0, recent_suggestions:[], protected_for_level2:0 };
  if (!fs.existsSync(dbPath)) return empty;
  let _db;
  try {
    const BS3 = require('better-sqlite3');
    _db = new BS3(dbPath, { readonly: true });
    const safe = (fn) => { try { return fn(); } catch { return null; } };
    const protCount = safe(() => _db.prepare("SELECT COUNT(*) as n FROM verified_contracts WHERE status IN ('protected','verified')").get()?.n) || 0;
    return {
      level:              protCount >= 10 ? 2 : 1,
      protected_for_level2: protCount,
      suggestions:        safe(() => _db.prepare("SELECT COUNT(*) as n FROM creative_suggestions WHERE applied=0 AND dismissed=0").get()?.n) || 0,
      wins:               safe(() => _db.prepare("SELECT COUNT(*) as n FROM creative_wins").get()?.n) || 0,
      auto_applicable:    safe(() => _db.prepare("SELECT COUNT(*) as n FROM creative_suggestions WHERE auto_applicable=1 AND applied=0 AND dismissed=0").get()?.n) || 0,
      recent_suggestions: safe(() => _db.prepare("SELECT id, type, title, risk_level, module, auto_applicable FROM creative_suggestions WHERE applied=0 AND dismissed=0 ORDER BY created_at DESC LIMIT 5").all()) || [],
    };
  } catch { return empty; } finally { try { _db && _db.close(); } catch {} }
}

// ─── Feature 5 (14/07/2026): MEMORIA UI/FRONTEND ─────────────────────────────
// Misma memoria de siempre (patrones.md/decisiones.md/errores.md), filtrada
// por área — no es un sistema paralelo, es una vista distinta de los mismos
// datos que ya usa Contract Guard/Creative Engine, más el resultado del
// UI Native Gate (Feature 4, chequeo mecánico de confirm/alert/prompt nativos).
function getUiMemoryData() {
  const empty = { patronesAlta: 0, decisionesConArchivo: 0, erroresFrontend: 0, nativeGateViolations: 0, nativeGateSample: [], uiForms: 0, uiSelects: 0, uiFields: 0, uiCssClasses: 0, uiFlujosProtegidos: 0, browserGateConfig: false };
  if (!fs.existsSync(dbPath)) return empty;
  let _db;
  try {
    const BS3 = require('better-sqlite3');
    _db = new BS3(dbPath, { readonly: true });
    const safe = (fn) => { try { return fn(); } catch { return null; } };
    const data = {
      // area = 'frontend' exacto solo cubre lo que pasó por el detector nuevo
      // (Feature 2) — patrones.md tiene áreas escritas a mano (ej.
      // "panel/frontend") desde antes, así que hace falta LIKE, no igualdad.
      patronesAlta:         safe(() => _db.prepare("SELECT COUNT(*) as n FROM nodos WHERE tipo='patron' AND area LIKE '%frontend%' AND confianza='ALTA'").get()?.n) || 0,
      decisionesConArchivo: safe(() => _db.prepare("SELECT COUNT(*) as n FROM nodos WHERE tipo='decision' AND area LIKE '%frontend%' AND archivos_aplica != '[]'").get()?.n) || 0,
      erroresFrontend:      safe(() => _db.prepare("SELECT COUNT(*) as n FROM nodos WHERE tipo='error' AND area LIKE '%frontend%'").get()?.n) || 0,
      nativeGateViolations: 0,
      nativeGateSample:     [],
      // Plan 2 (Ojos UI, v3.13): la materia de interfaz que el indexador ya ve,
      // los flujos UI que el Regression Guard protege, y si el browser-gate
      // tiene config para verificar por comportamiento.
      uiForms:      safe(() => _db.prepare("SELECT COUNT(*) as n FROM ast_symbols WHERE kind='form'").get()?.n) || 0,
      uiSelects:    safe(() => _db.prepare("SELECT COUNT(*) as n FROM ast_symbols WHERE kind='select'").get()?.n) || 0,
      uiFields:     safe(() => _db.prepare("SELECT COUNT(*) as n FROM ast_symbols WHERE kind='field'").get()?.n) || 0,
      uiCssClasses: safe(() => _db.prepare("SELECT COUNT(*) as n FROM ast_symbols WHERE kind='css_class'").get()?.n) || 0,
      uiFlujosProtegidos: safe(() => _db.prepare(`SELECT COUNT(*) as n FROM protected_behaviors WHERE status='active' AND (critical_flows LIKE '%"FORM %' OR critical_flows LIKE '%"SELECT %' OR critical_flows LIKE '%"REQUIRED %')`).get()?.n) || 0,
      browserGateConfig: fs.existsSync(path.join(projectPath, '.agentic', 'browser-gate.json')),
    };
    try {
      const { runUiNativeGate } = require('./.agentic/grafo/ui-native-gate.cjs');
      const jsDir = path.join(projectPath, 'public', 'panel', 'js');
      const archivos = [];
      const recorrer = (dir) => {
        for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, f.name);
          if (f.isDirectory()) recorrer(full);
          else if (f.name.endsWith('.js')) archivos.push(full);
        }
      };
      if (fs.existsSync(jsDir)) recorrer(jsDir);
      const gate = runUiNativeGate(archivos, projectPath);
      data.nativeGateViolations = gate.findings ? gate.findings.length : 0;
      data.nativeGateSample = (gate.findings || []).slice(0, 3).map(f => `${path.basename(f.file)}:${f.line} — ${f.id}`);
    } catch {}
    return data;
  } catch { return empty; } finally { try { _db && _db.close(); } catch {} }
}

function getCuratorData() {
  try {
    const logPath = path.join(projectPath, '.agentic', 'curator.log');
    let lastRun = 'nunca';
    if (fs.existsSync(logPath)) {
      const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
      if (lines.length > 0) {
        const match = lines[lines.length-1].match(/\[([^\]]+)\]/);
        if (match) lastRun = match[1].split('T')[0];
      }
    }
    return { lastRun };
  } catch { return { lastRun: 'nunca' }; }
}


// ─── v3.3: EFFECTIVENESS REPORT DATA ─────────────────────────────────────────
function getEffectivenessData() {
  const empty = { total_cycles:0, metrics:{}, summary:{ improving:[], needs_work:[], stable:[] } };
  if (!fs.existsSync(dbPath)) return empty;
  try {
    const { generateReport } = require(path.join(__dirname, '.agentic/grafo/effectiveness-report.cjs'));
    const r = generateReport(__dirname);
    return r.error ? empty : r;
  } catch { return empty; }
}


// ─── Feature "endpoint≈" (14/07/2026): heurística front↔back por ruta de API ─
// El grafo solo puede ver texto estático (imports, llamadas dentro del mismo
// archivo) — nunca una petición HTTP en tiempo real. Esto NO es "arreglar" esa
// limitación (no se puede), es una heurística nueva, aditiva, igual de
// aproximada que "área≈": busca en el front cada `api('/ruta/...')` (el
// wrapper real de fetch en core.js) y en el back cada `router.METODO('/ruta')`
// montado con `app.use('/prefijo', createXRouter(...))`, y si el patrón de
// ruta calza, los conecta. Si el front arma la URL de forma dinámica sin usar
// el wrapper `api()`, o el back no sigue el patrón Express `router.METODO` +
// `app.use`, esos casos no se detectan — mismo tipo de límite que área≈, no
// es un vínculo exacto guardado en la base de datos.
// v2 (Plan 4, 15/07/2026): la lógica generalizada vive en
// .agentic/grafo/endpoint-heuristic.cjs — lee los endpoints del ÍNDICE (todos
// los frameworks del catálogo del indexador, no solo Express+TS), entiende
// montajes app.use('/p', X) con ident/require además de create*Router, y el
// front sale del perfil del proyecto (stack-profile) con fetch/axios/wrappers.
// Si ese módulo no existe (Agentix viejo) o falla → cae al legacy de abajo,
// que queda INTACTO — fail-soft: nunca peor que hoy.
function getEndpointHeuristicEdges(codeNodes, root) {
  try {
    const { computeEndpointEdges } = require(path.join(__dirname, '.agentic', 'grafo', 'endpoint-heuristic.cjs'));
    return computeEndpointEdges(codeNodes, root) || [];
  } catch {
    return getEndpointHeuristicEdgesLegacy(codeNodes, root);
  }
}

function getEndpointHeuristicEdgesLegacy(codeNodes, root) {
  const safe = (fn, fb) => { try { return fn(); } catch { return fb; } };
  const readFile = (relFile) => safe(() => fs.readFileSync(path.join(root, relFile), 'utf8'), null);

  // 1. Prefijo de montaje de cada router: app.use('/api/x', createXRouter(...))
  const mountPrefixByCreator = {};
  const serverLikeFiles = codeNodes.filter(n => /(^|[\\/])(server|app|index)\.tsx?$/i.test(n.file));
  for (const sf of serverLikeFiles) {
    const content = readFile(sf.file);
    if (!content) continue;
    const useRe = /\.use\(\s*['"`]([^'"`]+)['"`]\s*,\s*(create\w*Router)\s*\(/g;
    let m;
    while ((m = useRe.exec(content))) mountPrefixByCreator[m[2]] = m[1];
  }
  if (Object.keys(mountPrefixByCreator).length === 0) return []; // proyecto no usa este patrón — no forzar nada

  // 2. Rutas reales del back: router.METODO('/ruta', ...) + su prefijo de montaje
  const backendRoutes = [];
  const routeFiles = codeNodes.filter(n => /routes[\\/]/i.test(n.file) && /\.tsx?$/i.test(n.file));
  for (const rf of routeFiles) {
    const content = readFile(rf.file);
    if (!content) continue;
    const creatorMatch = content.match(/export\s+function\s+(create\w*Router)/);
    const prefix = creatorMatch && mountPrefixByCreator[creatorMatch[1]];
    if (!prefix) continue;
    const routeRe = /router\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]*)['"`]/g;
    let rm;
    while ((rm = routeRe.exec(content))) {
      const fullPath = (prefix + rm[2]).replace(/\/+/g, '/');
      backendRoutes.push({ file: rf.file, path: fullPath });
    }
  }
  if (backendRoutes.length === 0) return [];

  // 3. Llamadas del front: api(`/ruta/${dinamico}/mas-ruta`) — el wrapper real de core.js
  const frontFiles = codeNodes.filter(n => n.file.replace(/\\/g, '/').startsWith('public/'));
  const frontCalls = [];
  for (const ff of frontFiles) {
    const content = readFile(ff.file);
    if (!content) continue;
    const callRe = /\bapi\(\s*(`[^`]*`|'[^']*'|"[^"]*")/g;
    let cm;
    while ((cm = callRe.exec(content))) {
      const inner = cm[1].slice(1, -1).replace(/\$\{[^}]*\}/g, ' ');
      frontCalls.push({ file: ff.file, raw: inner });
    }
  }
  if (frontCalls.length === 0) return [];

  // 4. Match segmento a segmento — ':param' del back calza cualquier segmento
  // del front; ' ' (donde el front tenía un ${...} dinámico) calza
  // cualquier segmento fijo del back.
  function segMatch(frontSegs, backSegs) {
    if (frontSegs.length !== backSegs.length) return false;
    for (let i = 0; i < frontSegs.length; i++) {
      const f = frontSegs[i], b = backSegs[i];
      if (b.startsWith(':')) continue;
      if (f === ' ') continue;
      if (f !== b) return false;
    }
    return true;
  }

  const seen = new Set();
  const result = [];
  for (const fc of frontCalls) {
    const fSegs = fc.raw.split('?')[0].split('/').filter(Boolean);
    for (const br of backendRoutes) {
      const bSegs = br.path.split('/').filter(Boolean);
      if (!segMatch(fSegs, bSegs)) continue;
      const key = fc.file + '|' + br.file;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ frontFile: fc.file, backFile: br.file });
    }
  }
  return result;
}

const { nodes, edges, ciclos: ciclosDB, fases: fasesDB } = getGraphData();
const codeStructure = getCodeStructureGraph();
const endpointHeuristicEdges = getEndpointHeuristicEdges(codeStructure.nodes, projectPath);

// Mismo mapa que LANG_COLORS del cliente (script inline) — duplicado acá porque el
// legend del Code Structure se arma server-side, antes de que el <script> exista.
const LANG_COLORS_SERVER = {
  javascript:'#f7df1e', typescript:'#3178c6', python:'#4b8bbe', go:'#00add8',
  rust:'#dea584', java:'#e76f00', kotlin:'#a97bff', cpp:'#649ad2', c:'#5c9fd6',
  csharp:'#9b4f96', php:'#8993be', ruby:'#cc342d', swift:'#f05138', scala:'#dc322f',
  elixir:'#a37eba', html:'#e34c26', css:'#2979ff', other:'#00e5ff',
};
const LANG_LABELS_SERVER = {
  javascript:'JavaScript', typescript:'TypeScript', python:'Python', go:'Go',
  rust:'Rust', java:'Java', kotlin:'Kotlin', cpp:'C++', c:'C', csharp:'C#',
  php:'PHP', ruby:'Ruby', swift:'Swift', scala:'Scala', elixir:'Elixir',
  html:'HTML', css:'CSS', other:'otro',
};
const langsPresent = [...new Set(codeStructure.nodes.map(n => n.language).filter(Boolean))].sort();

// Paleta cósmica (14/07/2026) — reemplaza el arcoíris de un hue distinto por
// módulo (se sentía "carnaval", pedido explícito del dueño). Agrupa por lo
// que el cliente ve (front, azul eléctrico) vs. lo que no ve (back) — mismo
// criterio que esNodoFrontend() del lado cliente (la coraza, Feature 6), pero
// repetido acá server-side porque el legend se arma antes de que el <script>
// del cliente exista. Todos los tonos quedan brillantes a propósito (nunca
// se apagan a gris) — un intento anterior con tonos bajos hacía que algunos
// nodos casi no se notaran.
const FRONT_TONES = ['#2979ff', '#4c8dff', '#6fa6ff'];

// Paleta tetrádica por departamento (15/07/2026) — pedido explícito del dueño:
// 4 colores base (violeta/rojo/lima/cian) agrupando módulos "hermanos" (misma
// carpeta = mismo color), en vez de la familia violeta única de antes. Las
// variantes claro/oscuro NO están escritas a mano — se calculan por HSL desde
// los 4 hex originales, para que esto sirva igual en cualquier proyecto futuro
// sin inventar más hex a mano. Verificado en un mockup real contra datos de
// lumoV2 antes de aplicarlo aquí.
const BACK_HUES = ['#6d0fff', '#ff0f27', '#9fff0f', '#0fffe7'];
function hexToHslServer(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  const d = max - min;
  if (d === 0) { h = 0; s = 0; }
  else {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * (((b - r) / d) + 2);
    else h = 60 * (((r - g) / d) + 4);
    if (h < 0) h += 360;
  }
  return [h, s, l];
}
function hslToHexServer(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r, g, b;
  if (h < 60) { r = c; g = x; b = 0; } else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; } else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; } else { r = c; g = 0; b = x; }
  const toHex = v => ('0' + Math.round((v + m) * 255).toString(16)).slice(-2);
  return '#' + toHex(r) + toHex(g) + toHex(b);
}
// Cada hue base genera 3 tonos (base/claro/oscuro) — 12 en total antes de
// repetir. Orden de la lista: primero los 4 "base" (uno de cada familia),
// después los 4 "claro", después los 4 "oscuro" — así módulos vecinos
// alfabéticamente (ej. src/ai y src/api) casi nunca comparten color.
const BACK_TONES = [];
for (const tier of [0, 1, 2]) {
  for (const hex of BACK_HUES) {
    if (tier === 0) { BACK_TONES.push(hex); continue; }
    const [h, s, l] = hexToHslServer(hex);
    BACK_TONES.push(tier === 1 ? hslToHexServer(h, s, Math.min(0.92, l + 0.20)) : hslToHexServer(h, s, Math.max(0.08, l - 0.20)));
  }
}

// Perfil de convenciones (Plan 4): si el proyecto declaró sus carpetas front
// (stack-profile.cjs, key stack_profile en project_settings), la clasificación
// las usa; sin perfil → la heurística de siempre (public/). Fail-soft: si el
// módulo no existe o falla, comportamiento de hoy, sin excepción visible.
let __stackProfile = null;
try {
  __stackProfile = require(path.join(__dirname, '.agentic', 'grafo', 'stack-profile.cjs')).loadProfile(projectPath);
} catch {}

function esModuloFrontendServer(m) {
  if (__stackProfile && Array.isArray(__stackProfile.front_dirs) && __stackProfile.front_dirs.length) {
    const mn = String(m).replace(/\\/g, '/');
    return __stackProfile.front_dirs.some(d => mn === d || mn.startsWith(d + '/'));
  }
  return m === 'public' || m.startsWith('public/') || m.startsWith('public\\');
}

const modulesPresent = [...new Set(codeStructure.nodes.map(n => n.modulo).filter(Boolean))].sort();
const MOD_COLORS_SERVER = {};
{
  let frontIdx = 0, backIdx = 0;
  modulesPresent.forEach((m) => {
    if (esModuloFrontendServer(m)) {
      MOD_COLORS_SERVER[m] = FRONT_TONES[frontIdx % FRONT_TONES.length];
      frontIdx++;
    } else {
      MOD_COLORS_SERVER[m] = BACK_TONES[backIdx % BACK_TONES.length];
      backIdx++;
    }
  });
}

// Calcular grado de conexiones por nodo (como Graphify — nodos divinos)
const degreeMap = {};
nodes.forEach(n => { degreeMap[n.id] = 0; });
edges.forEach(e => { degreeMap[e.desde_id] = (degreeMap[e.desde_id] || 0) + 1; degreeMap[e.hacia_id] = (degreeMap[e.hacia_id] || 0) + 1; });
const maxDegree = Math.max(...Object.values(degreeMap), 1);

// Nodos divinos = top 20% por conexiones
const godThreshold = maxDegree * 0.6;
const godNodes = nodes.filter(n => (degreeMap[n.id] || 0) >= godThreshold && godThreshold > 0);

// Conexiones sorprendentes = edges entre nodos de diferente área
const surprisingEdges = edges.filter(e => {
  const src = nodes.find(n => n.id === e.desde_id);
  const tgt = nodes.find(n => n.id === e.hacia_id);
  return src && tgt && src.area !== tgt.area && src.area !== 'global' && tgt.area !== 'global';
});

const stats = {
  total: nodes.length, errors: nodes.filter(n => n.tipo === 'error').length,
  patterns: nodes.filter(n => n.tipo === 'patron').length, decisions: nodes.filter(n => n.tipo === 'decision').length,
  high: nodes.filter(n => n.confianza === 'ALTA').length, medium: nodes.filter(n => n.confianza === 'MEDIA').length,
  low: nodes.filter(n => n.confianza === 'BAJA').length, relations: edges.length,
  active: nodes.filter(n => n.estado === 'ACTIVO').length, obsolete: nodes.filter(n => n.estado === 'OBSOLETO').length,
  godNodes: godNodes.length, surprising: surprisingEdges.length,
};

function parseModulos(text) {
  if (!text || text === '—') return [];
  const lines = text.split('\n').map(l => l.trim()).filter(l => l);
  const results = [];
  for (const line of lines) {
    // Tabla markdown: | 1 | Auth, middleware | /login |
    if (line.startsWith('|') && !line.match(/^[|\s-]+$/) && !line.toLowerCase().includes('fase') && !line.toLowerCase().includes('módulo') && !line.toLowerCase().includes('module') && !line.toLowerCase().includes('tabla')) {
      const cols = line.split('|').map(c => c.trim()).filter(Boolean);
      if (cols.length >= 2) {
        const modName = cols[1].replace(/\*\*/g, '').replace(/✅/g, '').trim();
        if (modName && modName.length > 2) results.push(modName);
      }
    }
    // Lista simple: - módulo o [ ] módulo
    else if (line.match(/^[-*\[]/)) {
      const clean = line.replace(/^[-*]\s*/, '').replace(/^\[.\]\s*/, '').trim();
      if (clean && clean.length > 3 && !clean.startsWith('_')) results.push(clean);
    }
  }
  return results;
}

const contractData   = getContractData();
const structuralData = getStructuralLearningData();
const effectData     = getEffectivenessData();
const creativeData   = getCreativeData();
const curatorData    = getCuratorData();
const uiMemoryData   = getUiMemoryData();
const modulosImpl = parseModulos(config.implementados);
const specsData = readSpecs();
const logsData = readLogs();
const metricsData = calcMetrics(logsData);
const onboardingData = calcOnboarding(config, modulosImpl, decisiones, patrones, specsData);
const modulosPend = parseModulos(config.pendientes);
const reglas = (config.reglas || '').split('\n').map(l => l.trim()).filter(l => l && l !== '—' && l.length > 5);

// Construir módulos con relaciones para el grafo neuronal de proyecto
function buildModuleGraph() {
  const mNodes = [];
  const mEdges = [];
  const areaCount = {};

  // Contar errores y patrones por área
  nodes.forEach(n => {
    if (!areaCount[n.area]) areaCount[n.area] = { errors: 0, patterns: 0, decisions: 0, high: 0 };
    if (n.tipo === 'error') areaCount[n.area].errors++;
    if (n.tipo === 'patron') areaCount[n.area].patterns++;
    if (n.tipo === 'decision') areaCount[n.area].decisions++;
    if (n.confianza === 'ALTA') areaCount[n.area].high++;
  });

  // Crear nodos de módulos implementados
  modulosImpl.forEach((m, i) => {
    const area = m.toLowerCase().replace(/\s+/g, '-').split(/[\s\/\-]/)[0];
    const stats = areaCount[area] || { errors: 0, patterns: 0, decisions: 0, high: 0 };
    mNodes.push({ id: 'impl-' + i, label: m, tipo: 'impl', area, errors: stats.errors, patterns: stats.patterns, high: stats.high, degree: stats.errors + stats.patterns + stats.decisions });
  });

  // Crear nodos de módulos pendientes
  modulosPend.forEach((m, i) => {
    mNodes.push({ id: 'pend-' + i, label: m, tipo: 'pend', area: m.toLowerCase().split(/\s/)[0], errors: 0, patterns: 0, high: 0, degree: 0 });
  });

  // Crear edges entre módulos que comparten área en la memoria
  const implByArea = {};
  mNodes.filter(n => n.tipo === 'impl').forEach(n => {
    if (!implByArea[n.area]) implByArea[n.area] = [];
    implByArea[n.area].push(n.id);
  });

  // Conectar módulos con errores compartidos (misma área en memoria)
  const areaRelations = {};
  edges.forEach(e => {
    const src = nodes.find(n => n.id === e.desde_id);
    const tgt = nodes.find(n => n.id === e.hacia_id);
    if (src && tgt) {
      const key = [src.area, tgt.area].sort().join('::');
      areaRelations[key] = (areaRelations[key] || 0) + 1;
    }
  });

  // Conectar módulos impl con al menos 2 conexiones entre sus áreas
  mNodes.filter(n => n.tipo === 'impl').forEach((src, si) => {
    mNodes.filter((n, ti) => n.tipo === 'impl' && ti > si).forEach(tgt => {
      const key = [src.area, tgt.area].sort().join('::');
      if (areaRelations[key] >= 1) {
        mEdges.push({ source: src.id, target: tgt.id, weight: areaRelations[key], tipo: 'shared_knowledge' });
      }
    });
  });

  // Siempre conectar módulos consecutivos como relación de flujo
  mNodes.filter(n => n.tipo === 'impl').forEach((n, i, arr) => {
    if (i < arr.length - 1) {
      const exists = mEdges.find(e => (e.source === n.id && e.target === arr[i+1].id) || (e.source === arr[i+1].id && e.target === n.id));
      if (!exists) mEdges.push({ source: n.id, target: arr[i+1].id, weight: 1, tipo: 'flow' });
    }
  });

  // Conectar pendientes con el módulo impl más relacionado
  mNodes.filter(n => n.tipo === 'pend').forEach(pend => {
    if (mNodes.filter(n => n.tipo === 'impl').length > 0) {
      const target = mNodes.filter(n => n.tipo === 'impl')[0];
      mEdges.push({ source: pend.id, target: target.id, weight: 1, tipo: 'depends' });
    }
  });

  return { mNodes, mEdges };
}

const { mNodes, mEdges } = buildModuleGraph();

// Preguntas sugeridas para el nuevo integrante (como GRAPH_REPORT de Graphify)
function buildSuggestedQuestions() {
  const qs = [];
  if (godNodes.length > 0) qs.push(`What flows through ${godNodes[0].titulo.slice(0,40)}?`);
  if (surprisingEdges.length > 0) {
    const e = surprisingEdges[0];
    const src = nodes.find(n => n.id === e.desde_id);
    const tgt = nodes.find(n => n.id === e.hacia_id);
    if (src && tgt) qs.push(`How does ${src.area} connect to ${tgt.area}?`);
  }
  if (modulosImpl.length > 0) qs.push(`How do I add a feature to ${modulosImpl[0]}?`);
  if (errores.length > 0) qs.push(`What errors should I avoid in ${errores[0].area}?`);
  if (patrones.filter(p => p.confianza === 'ALTA').length > 0) qs.push(`What are the permanent rules for this project?`);
  if (decisiones.length > 0) qs.push(`Why was ${decisiones[0].titulo.slice(0,40)} decided?`);
  return qs.slice(0, 5);
}

const suggestedQuestions = buildSuggestedQuestions();

const HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Agentix KDD — ${escHtml(config.nombre)}</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.8.5/d3.min.js"></script>
<script src="https://unpkg.com/3d-force-graph@1.80.0/dist/3d-force-graph.min.js"></script>
<!-- three-spritetext necesita un THREE global — 3d-force-graph trae su PROPIA copia
     interna pero no la expone como variable global. Three.js quitó su build clásico
     (script suelto, sin módulos) a partir de r160 — 0.160.0 es la ÚLTIMA versión que
     todavía lo tiene (verificado: 0.161.0 en adelante da 404). Tira un warning de
     "deprecated" en consola, inofensivo — sigue funcionando igual, es solo el aviso. -->
<script src="https://unpkg.com/three@0.160.0/build/three.min.js"></script>
<script src="https://unpkg.com/three-spritetext@1.10.0/dist/three-spritetext.min.js"></script>
<style>
:root{--bg:#0a0d14;--bg2:#111520;--bg3:#1a1f2e;--bg4:#232840;--border:#2a3050;--text:#e2e8f0;--text2:#94a3b8;--text3:#64748b;--purple:#8b5cf6;--pl:#a78bfa;--green:#10b981;--red:#ef4444;--blue:#3b82f6;--amber:#f59e0b;--cyan:#06b6d4;--pink:#ec4899;--r:12px}
.light{--bg:#f0f4f8;--bg2:#ffffff;--bg3:#f8fafc;--bg4:#eef2f7;--border:#dde3ee;--text:#0f172a;--text2:#475569;--text3:#94a3b8}
*{box-sizing:border-box;margin:0;padding:0}
*{scrollbar-width:thin;scrollbar-color:var(--border) transparent}
*::-webkit-scrollbar{width:8px;height:8px}
*::-webkit-scrollbar-track{background:transparent}
*::-webkit-scrollbar-thumb{background:var(--border);border-radius:10px}
*::-webkit-scrollbar-thumb:hover{background:var(--pl)}
body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;height:100vh;overflow:hidden;display:flex;flex-direction:column}

/* Header */
.hdr{background:var(--bg2);border-bottom:1px solid var(--border);padding:11px 20px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;gap:12px}
.logo{font-size:15px;font-weight:700;color:var(--pl);white-space:nowrap}
.proj{font-size:12px;color:var(--text2);background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:3px 8px;margin-left:10px;white-space:nowrap}
.dot{width:7px;height:7px;border-radius:50%;background:var(--green);margin-left:8px;display:inline-block;flex-shrink:0}
.hdr-r{display:flex;align-items:center;gap:6px;flex-shrink:0}
.badge{font-size:10px;padding:3px 7px;border-radius:4px;font-weight:600;white-space:nowrap}
.b-god{background:rgba(245,158,11,.2);color:#fbbf24;border:1px solid rgba(245,158,11,.3)}
.b-sur{background:rgba(236,72,153,.15);color:#f472b6;border:1px solid rgba(236,72,153,.25)}
.b-high{background:rgba(139,92,246,.2);color:#a78bfa;border:1px solid rgba(139,92,246,.3)}
.btn{background:var(--bg3);border:1px solid var(--border);color:var(--text2);border-radius:6px;padding:5px 10px;font-size:11px;cursor:pointer;transition:all .15s;white-space:nowrap}
.btn:hover{border-color:var(--purple);color:var(--pl)}
.sel{background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:5px 8px;font-size:11px}

/* Mode tabs */
.mode-tabs{background:var(--bg2);border-bottom:1px solid var(--border);padding:0 20px;display:flex;flex-shrink:0}
.mode-tab{padding:11px 18px;font-size:13px;font-weight:500;cursor:pointer;color:var(--text3);border-bottom:2px solid transparent;transition:all .15s;display:flex;align-items:center;gap:6px;white-space:nowrap}
.mode-tab:hover{color:var(--text2)}
.mode-tab.active{color:var(--pl);border-bottom-color:var(--purple)}

.content{flex:1;overflow:hidden;display:flex}

/* ════════ KNOWLEDGE GRAPH MODE ════════ */
#mode-graph{flex:1;display:flex;flex-direction:column;overflow:hidden}
.graph-sub-tabs{display:flex;gap:2px;padding:6px 10px;background:rgba(7,9,13,.95);border-bottom:1px solid rgba(139,92,246,.2);flex-shrink:0}
.gst{font-size:11px;font-weight:600;padding:5px 14px;border-radius:6px;cursor:pointer;color:rgba(255,255,255,.45);border:1px solid transparent;transition:all .2s}
.gst:hover{color:rgba(255,255,255,.75);background:rgba(139,92,246,.08)}
.gst.active{color:#c4b5fd;background:rgba(139,92,246,.18);border-color:rgba(139,92,246,.35)}
#graph-sub-kdd{flex:1;display:flex;overflow:hidden;min-height:0}
#graph-sub-code{flex:1;display:none;overflow:hidden;position:relative;background:#07090d}
#graph-sub-combined{flex:1;display:none;overflow:hidden;position:relative;flex-direction:column;align-items:center;justify-content:center;gap:20px;background:#07090d}
.code-unavail{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:rgba(255,255,255,.35);text-align:center;gap:12px}
.code-unavail h3{color:rgba(0,229,255,.6);font-size:15px;margin:0}
.code-unavail code{font-size:11px;background:rgba(255,255,255,.06);padding:4px 10px;border-radius:5px;color:#a5b4fc}
.sidebar{width:272px;flex-shrink:0;background:var(--bg2);border-right:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden}
.sb-tabs{display:flex;border-bottom:1px solid var(--border)}
.sb-tab{flex:1;padding:9px 6px;text-align:center;font-size:11px;cursor:pointer;color:var(--text3);border-bottom:2px solid transparent;transition:all .15s}
.sb-tab.active{color:var(--pl);border-bottom-color:var(--purple)}
.sb-body{flex:1;overflow-y:auto;padding:10px}
.sb-body::-webkit-scrollbar{width:3px}
.sb-body::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}
.search-box{padding:8px 10px;border-bottom:1px solid var(--border)}
.search-input{width:100%;background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:5px 8px;font-size:11px;outline:none}
.search-input:focus{border-color:var(--purple)}
.filter-row{padding:6px 10px;border-bottom:1px solid var(--border);display:flex;gap:4px;flex-wrap:wrap}
.fpill{font-size:10px;padding:2px 7px;border-radius:10px;border:1px solid var(--border);background:var(--bg3);color:var(--text2);cursor:pointer;transition:all .15s}
.fpill.active{background:rgba(139,92,246,.15);border-color:var(--purple);color:var(--pl)}

/* God nodes section */
.god-section{padding:8px 10px;border-bottom:1px solid var(--border);background:rgba(245,158,11,.04)}
.god-title{font-size:9px;color:var(--amber);text-transform:uppercase;letter-spacing:.08em;font-weight:700;margin-bottom:5px;display:flex;align-items:center;gap:4px}
.god-item{font-size:10px;color:var(--text2);padding:3px 0;display:flex;align-items:center;gap:5px;cursor:pointer}
.god-item:hover{color:var(--amber)}
.god-ring{width:10px;height:10px;border-radius:50%;border:2px solid var(--amber);flex-shrink:0}

.nitem{padding:7px 8px;border-radius:6px;cursor:pointer;margin-bottom:3px;border:1px solid transparent;transition:all .15s}
.nitem:hover{background:var(--bg3);border-color:var(--border)}
.nitem.selected{background:rgba(139,92,246,.1);border-color:var(--purple)}
.nitem.god-node{border-left:2px solid var(--amber)}
.ntb{font-size:9px;font-weight:700;padding:2px 5px;border-radius:3px;flex-shrink:0}
.t-error{background:rgba(239,68,68,.15);color:#f87171}
.t-patron{background:rgba(16,185,129,.15);color:#34d399}
.t-decision{background:rgba(59,130,246,.15);color:#60a5fa}
/* Variantes FRONT — misma familia neón que los nodos del grafo */
.t-error.front{background:rgba(255,92,168,.18);color:#ff8fc2}
.t-patron.front{background:rgba(163,230,53,.16);color:#bef264}
.t-decision.front{background:rgba(34,211,238,.16);color:#67e8f9}
.mb{font-size:9px;padding:1px 4px;border-radius:3px;font-weight:500}
.cALTA{background:rgba(16,185,129,.2);color:#34d399}
.cMEDIA{background:rgba(245,158,11,.2);color:#fbbf24}
.cBAJA{background:rgba(100,116,139,.2);color:#94a3b8}
.ab{font-size:9px;color:var(--text3);background:var(--bg3);border-radius:3px;padding:1px 4px}
.tag-ext{font-size:9px;padding:1px 4px;border-radius:3px;background:rgba(16,185,129,.1);color:#6ee7b7;border:1px solid rgba(16,185,129,.2)}
.tag-inf{font-size:9px;padding:1px 4px;border-radius:3px;background:rgba(59,130,246,.1);color:#93c5fd;border:1px solid rgba(59,130,246,.2)}
.tag-amb{font-size:9px;padding:1px 4px;border-radius:3px;background:rgba(245,158,11,.1);color:#fcd34d;border:1px solid rgba(245,158,11,.2)}

/* Stats panel */
.mini-stats{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-bottom:10px}
.ms{background:var(--bg3);border-radius:7px;padding:8px;text-align:center}
.ms-v{font-size:22px;font-weight:700;line-height:1}
.ms-l{font-size:9px;color:var(--text3);margin-top:2px}
.conf-row{display:flex;align-items:center;gap:7px;margin-bottom:7px}
.conf-label{font-size:10px;width:56px;flex-shrink:0}
.conf-bw{flex:1;background:var(--bg3);border-radius:3px;height:4px;overflow:hidden}
.conf-bar{height:100%;border-radius:3px;transition:width .6s}
.conf-n{font-size:10px;color:var(--text3);width:16px;text-align:right}

/* Surprising connections */
.sur-section{padding:8px 10px;border-bottom:1px solid var(--border);background:rgba(236,72,153,.03)}
.sur-title{font-size:9px;color:var(--pink);text-transform:uppercase;letter-spacing:.08em;font-weight:700;margin-bottom:5px}
.sur-item{font-size:10px;color:var(--text2);padding:3px 0;cursor:pointer;display:flex;gap:4px;align-items:flex-start;line-height:1.4}
.sur-item:hover{color:var(--pink)}
.sur-dot{color:var(--pink);flex-shrink:0}

/* Graph area */
.graph-area{flex:1;position:relative;overflow:hidden;background:var(--bg)}
#gc{width:100%;height:100%}
#code-gc{width:100%;height:100%}
#combined-gc{width:100%;height:100%}
.gtt{position:absolute;background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:8px 12px;font-size:11px;pointer-events:none;opacity:0;transition:opacity .15s;z-index:15;max-width:240px;box-shadow:0 4px 20px rgba(0,0,0,.5)}
.graph-legend{position:absolute;top:10px;left:10px;background:rgba(17,21,32,.9);border:1px solid var(--border);border-radius:8px;padding:8px 12px;display:flex;gap:10px;backdrop-filter:blur(4px)}
.lg-item{display:flex;align-items:center;gap:5px;font-size:10px;color:var(--text2)}
.lg-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.graph-controls{position:absolute;bottom:12px;left:12px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;max-width:480px}
.help-fab{position:absolute;bottom:12px;right:12px;width:34px;height:34px;border-radius:50%;background:rgba(139,92,246,.18);border:1px solid rgba(139,92,246,.35);color:var(--pl);font-size:16px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;z-index:15;backdrop-filter:blur(4px)}
.help-fab:hover{background:rgba(139,92,246,.32)}
.help-fab-fixed{position:fixed}
.gc-slider-wrap{display:flex;align-items:center;gap:4px;background:rgba(17,21,32,.9);border:1px solid var(--border);border-radius:6px;padding:3px 8px}
.gc-slider-label{font-size:13px;color:var(--text2)}
.gc-slider{-webkit-appearance:none;width:80px;height:3px;border-radius:2px;background:var(--border);outline:none;cursor:pointer}
.gc-slider::-webkit-slider-thumb{-webkit-appearance:none;width:12px;height:12px;border-radius:50%;background:#8b5cf6;cursor:pointer}
.node-pinned{stroke:#ffffff !important;stroke-width:2px !important;stroke-dasharray:3,2}
.gc-btn{background:rgba(17,21,32,.9);border:1px solid var(--border);color:var(--text2);border-radius:6px;padding:5px 9px;font-size:10px;cursor:pointer;backdrop-filter:blur(4px)}
.gc-btn:hover{border-color:var(--purple);color:var(--pl)}

/* Detail panel */
.detail-panel{position:absolute;right:12px;top:12px;width:272px;background:var(--bg2);border:1px solid var(--border);border-radius:12px;box-shadow:0 8px 40px rgba(0,0,0,.6);z-index:20;display:none;max-height:calc(100% - 24px);overflow-y:auto;backdrop-filter:blur(8px)}
.detail-panel.visible{display:block}
.dp-header{padding:12px 14px;border-bottom:1px solid var(--border);display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
.dp-title{font-size:12px;font-weight:600;color:var(--text);line-height:1.4;flex:1}
.dp-close{cursor:pointer;color:var(--text3);font-size:16px;flex-shrink:0;line-height:1}
.dp-close:hover{color:var(--text)}
.dp-body{padding:12px 14px}
.dp-help-row{padding:0 14px 12px;border-bottom:1px solid var(--border)}
.dp-help-btn{background:rgba(139,92,246,.15);border:1px solid rgba(139,92,246,.3);color:var(--pl);border-radius:6px;padding:5px 10px;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;width:100%}
.dp-help-btn:hover{background:rgba(139,92,246,.28)}
.glossary-modal{display:none;position:fixed;inset:0;background:rgba(5,7,12,.75);z-index:200;align-items:center;justify-content:center;backdrop-filter:blur(3px)}
.glossary-modal.visible{display:flex}
.glossary-card{background:var(--bg2);border:1px solid var(--border);border-radius:14px;max-width:460px;width:90%;max-height:78vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.6)}
.glossary-header{padding:16px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;background:var(--bg2)}
.glossary-header-title{font-size:15px;font-weight:700;color:var(--text)}
.glossary-body{padding:6px 18px 16px}
.glossary-item{padding:11px 0;border-bottom:1px solid rgba(255,255,255,.06)}
.glossary-item:last-child{border-bottom:none}
.glossary-term{font-size:11px;font-weight:700;color:var(--pl);text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px}
.glossary-explain{font-size:13px;color:var(--text2);line-height:1.55}
.dp-section{margin-bottom:12px}
.dp-label{font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px;font-weight:600}
.dp-val{font-size:11px;color:var(--text2);line-height:1.6}
.dp-badges{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:10px}
.rel-item{display:flex;align-items:center;gap:6px;padding:5px 7px;background:var(--bg3);border-radius:5px;margin-bottom:3px;cursor:pointer;transition:all .15s}
.rel-item:hover{background:rgba(139,92,246,.1);border:1px solid rgba(139,92,246,.3)}
.rel-name{font-size:11px;color:var(--text);flex:1}
.rel-type-label{font-size:9px;color:var(--text3);background:var(--bg4);border-radius:3px;padding:1px 4px}
.conf-progress{height:3px;background:var(--bg3);border-radius:2px;overflow:hidden;margin-top:5px}
.conf-progress-fill{height:100%;border-radius:2px;transition:width .5s}

/* ════════ PROJECT DOCS MODE ════════ */
#mode-docs{flex:1;display:none;overflow:hidden}
.docs-layout{display:flex;height:100%;width:100%;overflow:hidden;flex:1;min-width:0}
.docs-nav{width:210px;flex-shrink:0;background:var(--bg2);border-right:1px solid var(--border);overflow-y:auto;padding:12px}
.docs-nav::-webkit-scrollbar{width:3px}
.docs-nav::-webkit-scrollbar-thumb{background:var(--border)}
.nav-section{margin-bottom:14px}
.nav-title{font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:.08em;font-weight:700;margin-bottom:5px;padding:0 4px}
.nav-item{font-size:12px;color:var(--text2);padding:6px 8px;border-radius:6px;cursor:pointer;margin-bottom:2px;transition:all .15s;display:flex;align-items:center;gap:6px}
.nav-item:hover{background:var(--bg3);color:var(--text)}
.nav-item.active{background:rgba(139,92,246,.12);color:var(--pl);border-left:2px solid var(--purple);padding-left:6px}
.nav-count{font-size:10px;color:var(--text3);margin-left:auto;background:var(--bg3);border-radius:10px;padding:1px 5px}
.docs-main{flex:1;min-width:0;overflow-y:auto;padding:24px 28px}
.docs-main::-webkit-scrollbar{width:4px}
.docs-main::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}
.docs-section{display:none}.docs-section.active{display:block}#doc-modules.active{display:flex}
.docs-section.active{display:block}
.docs-h1{font-size:20px;font-weight:700;color:var(--text);margin-bottom:6px}
.docs-h2{font-size:14px;font-weight:600;color:var(--text);margin:20px 0 10px;display:flex;align-items:center;gap:8px}
.docs-sub{font-size:13px;color:var(--text2);margin-bottom:20px;line-height:1.7}

/* Module graph container */
#mod-graph{width:100%;height:500px;display:block;background:var(--bg)}

/* Info cards */
.info-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:16px}
.info-card{background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:14px}
.ic-label{font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px}
.ic-val{font-size:14px;font-weight:700;color:var(--text)}
.stack-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px}
.stack-item{background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:12px}
.si-label{font-size:10px;color:var(--text3);margin-bottom:4px}
.si-val{font-size:13px;color:var(--text);font-weight:500}

/* Module cards */
.module-card{background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-bottom:6px;display:flex;align-items:center;gap:10px;transition:all .15s;cursor:default}
.module-card.impl{border-left:3px solid var(--green)}
.module-card.impl:hover{border-color:var(--green);background:rgba(16,185,129,.04)}
.module-card.pend{border-left:3px solid var(--amber);opacity:.7}
.mod-name{font-size:13px;color:var(--text);font-weight:500;flex:1}
.mod-status{font-size:10px;padding:2px 6px;border-radius:4px;font-weight:600}
.ms-impl{background:rgba(16,185,129,.15);color:#34d399}
.ms-pend{background:rgba(245,158,11,.15);color:#fbbf24}
.mod-stats{display:flex;gap:5px}
.mod-stat{font-size:10px;padding:1px 5px;border-radius:3px;background:var(--bg3);color:var(--text3)}

/* Patterns */
.pattern-card{background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:8px;transition:all .15s}
.pattern-card:hover{border-color:var(--border);}
.pattern-card.high{border-left:3px solid var(--green)}
.pc-top{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.pc-title{font-size:13px;font-weight:500;color:var(--text);flex:1}
.usage-bar{height:2px;background:var(--bg3);border-radius:1px;overflow:hidden;margin-top:6px}
.usage-fill{height:100%;border-radius:1px;background:var(--purple);transition:width .5s}

/* Decisions */
.decision-card{background:var(--bg2);border:1px solid var(--border);border-left:3px solid var(--blue);border-radius:8px;padding:12px 14px;margin-bottom:8px}
.dc-title{font-size:13px;font-weight:500;color:var(--text);margin-bottom:4px}
.dc-body{font-size:11px;color:var(--text2);line-height:1.6}

/* Rules */
.rule-item{background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:10px 14px;margin-bottom:6px;display:flex;align-items:flex-start;gap:8px;font-size:12px;color:var(--text2);line-height:1.5}
.rule-dot{width:5px;height:5px;border-radius:50%;background:var(--purple);flex-shrink:0;margin-top:5px}

/* Suggested questions */
.question-card{background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:10px 14px;margin-bottom:6px;font-size:12px;color:var(--text2);cursor:pointer;display:flex;align-items:center;gap:8px;transition:all .15s}
.question-card:hover{border-color:var(--purple);color:var(--pl);background:rgba(139,92,246,.04)}
.question-arrow{color:var(--text3);font-size:14px;margin-left:auto}

/* GRAPH REPORT section */
.report-section{background:linear-gradient(135deg,rgba(139,92,246,.08),rgba(6,182,212,.05));border:1px solid rgba(139,92,246,.2);border-radius:12px;padding:16px;margin-bottom:20px}
.report-title{font-size:12px;font-weight:700;color:var(--pl);margin-bottom:10px;display:flex;align-items:center;gap:6px}
.report-item{font-size:11px;color:var(--text2);padding:4px 0;display:flex;gap:6px;border-bottom:1px solid rgba(255,255,255,.04);line-height:1.5}
.report-item:last-child{border-bottom:none}
.report-key{color:var(--text3);flex-shrink:0;min-width:80px}

/* Commands */
.cmd-row{display:flex;align-items:center;gap:10px;padding:7px 10px;background:var(--bg3);border-radius:6px;margin-bottom:4px;font-family:monospace}
.cmd-label{font-size:10px;color:var(--text3);width:58px;flex-shrink:0}
.cmd-val{font-size:11px;color:var(--cyan)}

/* Actions */
.docs-actions{display:flex;gap:8px;margin-bottom:16px}
.action-btn{background:var(--bg2);border:1px solid var(--border);color:var(--text2);border-radius:8px;padding:8px 14px;font-size:12px;cursor:pointer;display:flex;align-items:center;gap:6px;transition:all .15s}
.action-btn:hover{border-color:var(--purple);color:var(--pl)}

.empty-state{text-align:center;padding:30px;color:var(--text3);font-size:12px}
.divider{border:none;border-top:1px solid var(--border);margin:16px 0}

@media print{.hdr,.mode-tabs,.docs-nav,.docs-actions{display:none!important}.docs-main{padding:0}}
</style>
</head>
<body id="app">

<header class="hdr">
  <div style="display:flex;align-items:center;min-width:0">
    <div class="logo">🤖 Agentix KDD</div>
    <div class="proj">${config.nombre}</div>
    <div class="dot"></div>
  </div>
  <div class="hdr-r">
    ${godNodes.length > 0 ? `<span class="badge b-god">⚡ ${stats.godNodes} divine</span>` : ''}
    ${surprisingEdges.length > 0 ? `<span class="badge b-sur">✨ ${stats.surprising} surprising</span>` : ''}
    <span class="badge b-high">★ ${stats.high} HIGH</span>
    <select class="sel" onchange="setLang(this.value)">
      <option value="en">🇺🇸 EN</option>
      <option value="es">🇪🇸 ES</option>
    </select>
  </div>
</header>

<style>
  #mode-intel { background: var(--bg); }
  .il-title { font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--text3);margin:0 0 12px }
  .il-grid { display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;margin-bottom:20px }
  .il-card { background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px 18px }
  .il-card-head { display:flex;align-items:center;gap:9px;margin-bottom:12px }
  .il-card-icon { width:28px;height:28px;border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0 }
  .icon-p { background:rgba(127,119,221,.15) }
  .icon-g { background:rgba(29,158,117,.15) }
  .icon-a { background:rgba(239,159,39,.15) }
  .il-card-name { font-size:13px;font-weight:700;color:var(--text) }
  .il-card-sub  { font-size:11px;color:var(--text3);margin-top:1px }
  .il-stat-row { display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:12px }
  .il-stat { background:rgba(255,255,255,.03);border-radius:7px;padding:9px;text-align:center }
  .il-stat-val { font-size:20px;font-weight:800;line-height:1.1 }
  .il-stat-lbl { font-size:10px;color:var(--text3);margin-top:2px }
  .vp { color:#9f99e8 } .vg { color:#34d399 } .va { color:#fbbf24 } .vr { color:#f87171 } .vx { color:var(--text2) }
  .il-list { display:flex;flex-direction:column;gap:5px }
  .il-row { display:flex;align-items:center;gap:7px;padding:6px 9px;background:rgba(255,255,255,.03);border-radius:6px;font-size:12px }
  .il-badge { font-size:9px;font-weight:700;padding:2px 6px;border-radius:9px;white-space:nowrap;flex-shrink:0 }
  .bp { background:rgba(127,119,221,.2);color:#9f99e8 }
  .bv { background:rgba(29,158,117,.2);color:#34d399 }
  .bc { background:rgba(239,159,39,.2);color:#fbbf24 }
  .bi { background:rgba(248,113,113,.2);color:#f87171 }
  .il-row-name { flex:1;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap }
  .il-row-mod  { font-size:10px;color:var(--text3) }
  .sug-row { display:flex;align-items:flex-start;gap:7px;padding:6px 9px;background:rgba(255,255,255,.03);border-radius:6px;font-size:12px;margin-bottom:4px }
  .sug-type { font-size:9px;font-weight:700;padding:2px 6px;border-radius:9px;background:rgba(239,159,39,.15);color:#fbbf24;white-space:nowrap;flex-shrink:0 }
  .sug-auto { background:rgba(29,158,117,.15);color:#34d399 }
  .sug-txt  { color:var(--text2);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap }
  .lvl-bar { display:flex;align-items:center;gap:8px;margin-bottom:10px }
  .lvl-track { height:5px;flex:1;background:rgba(255,255,255,.06);border-radius:3px;overflow:hidden }
  .lvl-fill  { height:100%;border-radius:3px }
  .cur-row { display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.05);font-size:12px }
  .cur-row:last-child { border-bottom:none }
  .cur-k { color:var(--text3) } .cur-v { color:var(--text2);font-weight:600 }
  .empty-state { font-size:12px;color:var(--text3);text-align:center;padding:12px 0 }
  .obs-panel { background:var(--surface);border:1px solid #3730a3;border-radius:12px;padding:14px 18px;margin-bottom:20px }
  .obs-head  { display:flex;align-items:center;gap:9px;margin-bottom:9px }
  .obs-badge { font-size:10px;padding:2px 7px;border-radius:9px;background:rgba(99,91,255,.15);color:#818cf8;font-weight:600 }
  .obs-txt   { font-size:13px;color:var(--text2);line-height:1.5 }
  .obs-cmd   { font-family:monospace;font-size:11px;background:rgba(255,255,255,.05);color:#a5b4fc;padding:6px 10px;border-radius:6px;margin-top:8px;display:block }
  #mode-intel { display:none;flex:1;overflow-y:auto;padding:24px;flex-direction:column;gap:0;align-items:stretch;justify-content:flex-start;box-sizing:border-box; }
</style>
<div class="mode-tabs">
  <div class="mode-tab active" onclick="setMode('graph',this)">🧠 <span data-i="tab_graph">Knowledge Graph</span></div>
  <div class="mode-tab" onclick="setMode('docs',this)">📚 <span data-i="tab_docs">Project Docs</span></div>
  <div class="mode-tab" onclick="setMode('intel',this)">🛡️ Preservation Intel</div>
</div>

<div class="content">

<!-- ════════ KNOWLEDGE GRAPH ════════ -->
<div id="mode-graph">

  <!-- Graph sub-tabs -->
  <div class="graph-sub-tabs">
    <div class="gst active" onclick="setGraphTab('kdd',this)">🧠 KDD Memory</div>
    <div class="gst" onclick="setGraphTab('code',this)">🔬 Code Structure</div>
    <div class="gst" onclick="setGraphTab('combined',this)">⚡ Combined</div>
  </div>

  <div id="graph-sub-kdd">
  <div class="sidebar">
    <div class="sb-tabs">
      <div class="sb-tab active" onclick="showSbTab('nodes',this)" data-i="sb_nodes">Nodes</div>
      <div class="sb-tab" onclick="showSbTab('report',this)" data-i="sb_report">Report</div>
      <div class="sb-tab" onclick="showSbTab('stats',this)" data-i="sb_stats">Stats</div>
    </div>

    <!-- NODES TAB -->
    <div id="sbt-nodes" style="display:flex;flex-direction:column;flex:1;overflow:hidden">
      ${godNodes.length > 0 ? `
      <div class="god-section">
        <div class="god-title">⚡ <span data-i="divine_nodes">Divine nodes</span></div>
        ${godNodes.slice(0,3).map(n => `<div class="god-item" onclick="selectNode(${n.id})"><div class="god-ring"></div><span>${escHtml(n.titulo.slice(0,36))}${n.titulo.length>36?'…':''}</span></div>`).join('')}
      </div>` : ''}
      ${surprisingEdges.length > 0 ? `
      <div class="sur-section">
        <div class="sur-title">✨ <span data-i="surprising">Surprising connections</span></div>
        ${surprisingEdges.slice(0,2).map(e => {
          const src = nodes.find(n => n.id === e.desde_id);
          const tgt = nodes.find(n => n.id === e.hacia_id);
          return src && tgt ? `<div class="sur-item" onclick="highlightEdge(${e.desde_id},${e.hacia_id})"><span class="sur-dot">⟶</span><span>${src.area} connects to ${tgt.area}</span></div>` : '';
        }).join('')}
      </div>` : ''}
      <div class="search-box"><input class="search-input" placeholder="Search nodes..." id="srch" oninput="filterSearch(this.value)"></div>
      <div class="filter-row">
        <div class="fpill active" onclick="setFilter('all',this)" data-i="f_all">All</div>
        <div class="fpill" onclick="setFilter('error',this)" data-i="f_err">Errors</div>
        <div class="fpill" onclick="setFilter('patron',this)" data-i="f_pat">Patterns</div>
        <div class="fpill" onclick="setFilter('decision',this)" data-i="f_dec">Decisions</div>
        <div class="fpill" onclick="setFilter('ALTA',this)" data-i="f_high">★ HIGH</div>
        <div class="fpill" onclick="setFilter('god',this)" data-i="f_god">⚡ Divine</div>
      </div>
      <div class="filter-row" style="margin-top:4px">
        <div class="fpill side-pill active" onclick="setSide('all',this)" data-i="f_side_all">All</div>
        <div class="fpill side-pill" onclick="setSide('front',this)" style="border-color:rgba(255,92,168,.45)">Front</div>
        <div class="fpill side-pill" onclick="setSide('back',this)" style="border-color:rgba(59,130,246,.45)">Back</div>
      </div>
      <div class="sb-body" id="nodes-list"></div>
    </div>

    <!-- REPORT TAB (like Graphify GRAPH_REPORT) -->
    <div id="sbt-report" style="display:none" class="sb-body">
      <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.08em;font-weight:700;margin-bottom:10px" data-i="graph_report">Graph Report</div>
      ${godNodes.length > 0 ? `
      <div style="margin-bottom:14px">
        <div style="font-size:10px;color:var(--amber);font-weight:600;margin-bottom:6px">⚡ Divine Nodes</div>
        <div style="font-size:11px;color:var(--text3);margin-bottom:6px;line-height:1.5">Most connected — everything flows through them</div>
        ${godNodes.map(n => `<div style="padding:5px 7px;background:rgba(245,158,11,.06);border:1px solid rgba(245,158,11,.15);border-radius:5px;margin-bottom:3px;cursor:pointer" onclick="selectNode(${n.id})"><div style="font-size:11px;color:var(--amber)">${escHtml(n.titulo.slice(0,44))}${n.titulo.length>44?'…':''}</div><div style="font-size:10px;color:var(--text3)">${degreeMap[n.id]||0} connections · ${escHtml(n.area)}</div></div>`).join('')}
      </div>` : ''}
      ${surprisingEdges.length > 0 ? `
      <div style="margin-bottom:14px">
        <div style="font-size:10px;color:var(--pink);font-weight:600;margin-bottom:6px">✨ Surprising Connections</div>
        <div style="font-size:11px;color:var(--text3);margin-bottom:6px;line-height:1.5">Links between nodes from different areas</div>
        ${surprisingEdges.slice(0,4).map(e => { const src = nodes.find(n=>n.id===e.desde_id); const tgt = nodes.find(n=>n.id===e.hacia_id); return src&&tgt?`<div style="padding:5px 7px;background:rgba(236,72,153,.05);border:1px solid rgba(236,72,153,.15);border-radius:5px;margin-bottom:3px;cursor:pointer;font-size:10px;color:var(--text2);line-height:1.5" onclick="highlightEdge(${e.desde_id},${e.hacia_id})">${src.area} <span style="color:var(--pink)">→</span> ${tgt.area}</div>`:''; }).join('')}
      </div>` : ''}
      <div>
        <div style="font-size:10px;color:var(--pl);font-weight:600;margin-bottom:6px">💡 Suggested Questions</div>
        ${suggestedQuestions.map(q => `<div style="padding:5px 7px;background:rgba(139,92,246,.06);border:1px solid rgba(139,92,246,.15);border-radius:5px;margin-bottom:3px;font-size:10px;color:var(--text2);line-height:1.4">${q}</div>`).join('')}
      </div>
    </div>

    <!-- STATS TAB -->
    <div id="sbt-stats" style="display:none" class="sb-body">
      <div class="mini-stats">
        <div class="ms"><div class="ms-v" style="color:var(--pl)">${stats.total}</div><div class="ms-l" data-i="s_total">nodes</div></div>
        <div class="ms"><div class="ms-v" style="color:var(--cyan)">${stats.relations}</div><div class="ms-l" data-i="s_rel">relations</div></div>
        <div class="ms"><div class="ms-v" style="color:var(--amber)">${stats.godNodes}</div><div class="ms-l" data-i="s_god">divine</div></div>
        <div class="ms"><div class="ms-v" style="color:var(--green)">${stats.high}</div><div class="ms-l" data-i="s_high">HIGH</div></div>
      </div>
      <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Confidence</div>
      <div class="conf-row"><div class="conf-label" style="color:#34d399">HIGH</div><div class="conf-bw"><div class="conf-bar" style="width:${stats.total?Math.round(stats.high/stats.total*100):0}%;background:#10b981"></div></div><div class="conf-n">${stats.high}</div></div>
      <div class="conf-row"><div class="conf-label" style="color:#fbbf24">MED</div><div class="conf-bw"><div class="conf-bar" style="width:${stats.total?Math.round(stats.medium/stats.total*100):0}%;background:#f59e0b"></div></div><div class="conf-n">${stats.medium}</div></div>
      <div class="conf-row"><div class="conf-label" style="color:#94a3b8">LOW</div><div class="conf-bw"><div class="conf-bar" style="width:${stats.total?Math.round(stats.low/stats.total*100):0}%;background:#475569"></div></div><div class="conf-n">${stats.low}</div></div>
      <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border);font-size:11px;color:var(--text2);line-height:2.2">
        <span style="color:#34d399">→ HIGH</span>: 7+ uses · 80%+ useful<br>
        <span style="color:#fbbf24">→ MED</span>: 3+ uses · 70%+ useful<br>
        <span style="color:var(--pink)">★ Divine</span>: ${Math.round(godThreshold)}+ connections
      </div>
      <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border)">
        <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">By type</div>
        <div style="font-size:12px;color:var(--text2);line-height:2.2">
          <span style="color:#f87171">errors:</span> ${stats.errors} &nbsp; <span style="color:#34d399">patterns:</span> ${stats.patterns} &nbsp; <span style="color:#60a5fa">decisions:</span> ${stats.decisions}
        </div>
      </div>
    </div>
  </div>

  <!-- GRAPH -->
  <div class="graph-area" id="graph-area-main">
    <button class="help-fab" onclick="showTermsGlossary('kdd')" title="¿Qué significan los términos de este grafo?">?</button>
    <div id="gc"></div>
    <div class="gtt" id="gtt"></div>
    <div class="graph-legend" style="flex-wrap:wrap;max-width:460px">
      <div class="lg-item"><div class="lg-dot" style="background:#ef4444"></div><span data-i="l_err">error</span></div>
      <div class="lg-item"><div class="lg-dot" style="background:#10b981"></div><span data-i="l_pat">pattern</span></div>
      <div class="lg-item"><div class="lg-dot" style="background:#3b82f6"></div><span data-i="l_dec">decision</span></div>
      <div class="lg-item" style="border-left:1px solid var(--border);padding-left:10px"><div class="lg-dot" style="background:#ff5ca8"></div><span data-i="l_err_f">error front</span></div>
      <div class="lg-item"><div class="lg-dot" style="background:#a3e635"></div><span data-i="l_pat_f">pattern front</span></div>
      <div class="lg-item"><div class="lg-dot" style="background:#22d3ee"></div><span data-i="l_dec_f">decision front</span></div>
      <div class="lg-item"><div class="lg-dot" style="background:transparent;border:2px solid #f59e0b;box-sizing:border-box"></div><span style="color:var(--amber)" data-i="l_divine">divine</span></div>
    </div>
    <div class="graph-controls">
      <button class="gc-btn" onclick="resetGraph()" data-i="btn_reset">⟳ Reset</button>
      <button class="gc-btn" onclick="centerGraph()" data-i="btn_center">⊙ Center</button>
      <button class="gc-btn" onclick="toggleLabels()" id="label-btn" data-i="btn_labels">Labels OFF</button>
      <button class="gc-btn" onclick="spreadGraph()" title="Spread nodes apart">⊹ Spread</button>
      <button class="gc-btn" onclick="releaseAll()" title="Release all pinned nodes">⊠ Unpin all</button>
      <div class="gc-slider-wrap" title="Node repulsion">
        <span class="gc-slider-label">⊷</span>
        <input type="range" class="gc-slider" id="repulsion-slider" min="50" max="800" value="140"
          oninput="setRepulsion(this.value)" title="Repulsion force">
      </div>
    </div>
    <div class="detail-panel" id="detail-panel">
      <div class="dp-header">
        <div class="dp-title" id="dp-title"></div>
        <div class="dp-close" onclick="closeDetail()">×</div>
      </div>
      <div class="dp-help-row"><button class="dp-help-btn" onclick="showGlossary('kdd')" title="Explicación en lenguaje simple">¡NO ENTIENDO!</button></div>
      <div class="dp-body" id="dp-body"></div>
    </div>
    ${stats.total === 0 ? '<div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center;color:var(--text3)"><div style="font-size:40px;margin-bottom:10px">🧠</div><div>No nodes yet — use aa: to start</div></div>' : ''}
  </div>
  </div><!-- /graph-sub-kdd -->

  <!-- Code Structure view — nativo, sin herramienta externa -->
  <div id="graph-sub-code" style="position:relative">
    <button class="help-fab" onclick="showTermsGlossary('code')" title="¿Qué significan los términos de este grafo?">?</button>
    <div id="code-gc"></div>
    <div class="gtt" id="code-gtt"></div>
    <div class="graph-legend" style="max-width:280px;flex-wrap:wrap;gap:5px">
      <div class="fpill active code-mod-chip-all" onclick="setCodeModulesAll()">Todos</div>
      ${modulesPresent.length ? modulesPresent.map(m => `<div class="fpill code-mod-chip" data-mod="${escHtml(m)}" onclick="toggleCodeModuleChip('${escHtml(m)}')" style="display:flex;align-items:center;gap:5px"><span style="width:7px;height:7px;border-radius:50%;background:${MOD_COLORS_SERVER[m]};display:inline-block;flex-shrink:0"></span><span>${escHtml(m)}</span></div>`).join('') : `
      <div class="lg-item"><div class="lg-dot" style="background:#00e5ff"></div><span>archivo</span></div>
      <div class="lg-item"><div class="lg-dot" style="background:#d88aff"></div><span>clase</span></div>`}
    </div>
    <div class="graph-controls">
      <button class="gc-btn" onclick="resetCodeGraph()">⟳ Reset</button>
      <button class="gc-btn" onclick="centerCodeGraph()">⊙ Center</button>
    </div>
    <div class="detail-panel" id="code-detail-panel">
      <div class="dp-header">
        <div class="dp-title" id="code-dp-title"></div>
        <div class="dp-close" onclick="closeCodeDetail()">×</div>
      </div>
      <div class="dp-help-row"><button class="dp-help-btn" onclick="showGlossary('code')" title="Explicación en lenguaje simple">¡NO ENTIENDO!</button></div>
      <div class="dp-body" id="code-dp-body"></div>
    </div>
    ${codeStructure.nodes.length === 0 ? '<div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center;color:var(--text3)"><div style="font-size:40px;margin-bottom:10px">🔬</div><div>Sin índice AST todavía — corre: node .agentic/grafo/ast-indexer.cjs index</div></div>' : ''}
  </div>

  <!-- Combined view — KDD Memory + Code Structure, unión heurística por área -->
  <div id="graph-sub-combined" style="position:relative">
    <button class="help-fab" onclick="showTermsGlossary('combined')" title="¿Qué significan los términos de este grafo?">?</button>
    <div id="combined-gc"></div>
    <div class="gtt" id="combined-gtt"></div>
    <div class="graph-legend">
      <div class="lg-item"><div class="lg-dot" style="background:#ef4444"></div><span>error/patrón/decisión (KDD)</span></div>
      <div class="lg-item"><div class="lg-dot" style="background:#00e5ff"></div><span>archivo (código)</span></div>
      <div class="lg-item"><div class="lg-dot" style="background:rgba(80,250,123,.6)"></div><span>relación por área (aproximada)</span></div>
    </div>
    <div class="graph-controls">
      <button class="gc-btn" onclick="resetCombinedGraph()">⟳ Reset</button>
      <button class="gc-btn" onclick="centerCombinedGraph()">⊙ Center</button>
    </div>
    <div class="detail-panel" id="combined-detail-panel">
      <div class="dp-header">
        <div class="dp-title" id="combined-dp-title"></div>
        <div class="dp-close" onclick="closeCombinedDetail()">×</div>
      </div>
      <div class="dp-help-row"><button class="dp-help-btn" onclick="showGlossary('combined')" title="Explicación en lenguaje simple">¡NO ENTIENDO!</button></div>
      <div class="dp-body" id="combined-dp-body"></div>
    </div>
  </div>


</div>

<!-- ════════ PROJECT DOCS ════════ -->
<div id="mode-docs">
  <div class="docs-layout">
    <nav class="docs-nav">
      <div class="nav-section">
        <div class="nav-title" data-i="nav_overview">Overview</div>
        <div class="nav-item active" onclick="showDoc('overview',this)">🏠 <span data-i="nav_project">Project</span></div>
        <div class="nav-item" onclick="showDoc('stack',this)">⚙️ <span data-i="nav_stack">Stack</span></div>
        <div class="nav-item" onclick="showDoc('commands',this)">💻 <span data-i="nav_commands">Commands</span></div>
      </div>
      <div class="nav-section">
        <div class="nav-title" data-i="nav_arch">Architecture</div>
        <div class="nav-item" onclick="showDoc('modules',this)">📦 <span data-i="nav_modules">Modules</span> <span class="nav-count">${modulosImpl.length + modulosPend.length}</span></div>
        <div class="nav-item" onclick="showDoc('rules',this)">📋 <span data-i="nav_rules">Rules</span> <span class="nav-count">${reglas.length}</span></div>
      </div>
      <div class="nav-section">
        <div class="nav-title" data-i="nav_knowledge">Knowledge</div>
        <div class="nav-item" onclick="showDoc('patterns',this)">🟢 <span data-i="nav_patterns">Patterns</span> <span class="nav-count">${patrones.length}</span></div>
        <div class="nav-item" onclick="showDoc('decisions',this)">🔵 <span data-i="nav_decisions">Decisions</span> <span class="nav-count">${decisiones.length}</span></div>
        <div class="nav-item" onclick="showDoc('errors',this)">🔴 <span data-i="nav_errors">Errors</span> <span class="nav-count">${errores.length}</span></div>
        <div class="nav-item" onclick="showDoc('questions',this)">💡 <span data-i="nav_questions">For New Devs</span></div>
        <div class="nav-item" onclick="showDoc('metrics',this)">📊 <span>Metrics</span></div>
        <div class="nav-item" onclick="showDoc('timeline',this)">🕐 <span>Timeline</span></div>
        <div class="nav-item" onclick="showDoc('onboarding',this)">🚀 <span>Onboarding</span> <span class="nav-count">${onboardingData.pct}%</span></div>
      </div>
    </nav>

    <div class="docs-main">

      <!-- OVERVIEW -->
      <div class="docs-section active" id="doc-overview">
        <div class="docs-h1">${config.nombre}</div>
        <div class="docs-sub">${config.descripcion !== '—' ? config.descripcion : 'No description yet — run aa: configurar'}</div>
        <div class="docs-actions">
          <button class="action-btn" onclick="window.print()">🖨️ <span data-i="btn_print">Print / Export PDF</span></button>
          <button class="action-btn" onclick="copyMarkdown()">📋 <span data-i="btn_copy">Copy as Markdown</span></button>
        </div>
        <div class="info-grid">
          <div class="info-card"><div class="ic-label">Type</div><div class="ic-val">${config.tipo || '—'}</div></div>
          <div class="info-card"><div class="ic-label">Modules</div><div class="ic-val">${modulosImpl.length} <span style="color:var(--text3);font-size:12px">impl</span> · ${modulosPend.length} <span style="color:var(--text3);font-size:12px">pending</span></div></div>
          <div class="info-card"><div class="ic-label">Knowledge</div><div class="ic-val">${stats.total} <span style="color:var(--text3);font-size:12px">nodes</span> · ${stats.high} <span style="color:var(--text3);font-size:12px">HIGH</span></div></div>
        </div>
        <div class="report-section">
          <div class="report-title">📊 Graph Report <span style="font-size:10px;color:var(--text3);font-weight:400">— like Graphify's GRAPH_REPORT.md</span></div>
          ${godNodes.length > 0 ? `<div class="report-item"><span class="report-key">Divine nodes</span><span>${escHtml(godNodes.map(n=>n.titulo.slice(0,30)).join(', '))}</span></div>` : ''}
          ${surprisingEdges.length > 0 ? `<div class="report-item"><span class="report-key">Surprising</span><span>${surprisingEdges.length} cross-area connections found</span></div>` : ''}
          <div class="report-item"><span class="report-key">HIGH rules</span><span>${escHtml(patrones.filter(p=>p.confianza==='ALTA').map(p=>p.titulo.slice(0,25)).join(' · ')) || 'None yet'}</span></div>
          <div class="report-item"><span class="report-key">Most errors</span><span>${errores.length > 0 ? escHtml(errores.sort((a,b)=>b.aplicado-a.aplicado)[0].titulo.slice(0,40)) : 'None yet'}</span></div>
        </div>
        <div class="docs-h2">🚀 Getting started</div>
        <div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:16px;font-size:12px;color:var(--text2);line-height:2.2">
          <strong style="color:var(--text)">1.</strong> Open in Cursor or Claude Code<br>
          <strong style="color:var(--text)">2.</strong> Type <code style="color:var(--pl);background:var(--bg3);padding:1px 6px;border-radius:3px">aa: help</code> to see all commands<br>
          <strong style="color:var(--text)">3.</strong> Type <code style="color:var(--cyan);background:var(--bg3);padding:1px 6px;border-radius:3px">aa: [your task]</code> to start developing<br>
          <strong style="color:var(--text)">4.</strong> Type <code style="color:var(--amber);background:var(--bg3);padding:1px 6px;border-radius:3px">audit: auditar</code> before going to production
        </div>
      </div>

      <!-- STACK -->
      <div class="docs-section" id="doc-stack">
        <div class="docs-h1" data-i="h_stack">Tech Stack</div>
        <div class="docs-sub" data-i="sub_stack">Technologies and frameworks used in this project.</div>
        <div class="stack-grid">
          <div class="stack-item"><div class="si-label">Framework</div><div class="si-val">${config.framework && config.framework !== '—' ? config.framework : (config.stack || '—')}</div></div>
          <div class="stack-item"><div class="si-label">Language</div><div class="si-val">${config.language && config.language !== '—' ? config.language : '—'}</div></div>
          <div class="stack-item"><div class="si-label">Runtime</div><div class="si-val">${config.runtime && config.runtime !== '—' ? config.runtime : '—'}</div></div>
          <div class="stack-item"><div class="si-label">Database</div><div class="si-val">${config.base_datos && config.base_datos !== '—' ? config.base_datos : '—'}</div></div>
          <div class="stack-item"><div class="si-label">Package Manager</div><div class="si-val">${config.package_manager && config.package_manager !== '—' ? config.package_manager : '—'}</div></div>
          ${config.stack ? '<div class="stack-item" style="grid-column:1/-1"><div class="si-label">Full Stack</div><div class="si-val">' + escHtml(config.stack) + '</div></div>' : ''}
        </div>
        <div class="docs-h2">Commands</div>
        <div class="cmd-row"><div class="cmd-label">dev</div><div class="cmd-val">${config.cmd_dev || '—'}</div></div>
        <div class="cmd-row"><div class="cmd-label">test</div><div class="cmd-val">${config.cmd_test || '—'}</div></div>
        <div class="cmd-row"><div class="cmd-label">build</div><div class="cmd-val">${config.cmd_build || '—'}</div></div>
      </div>

      <!-- COMMANDS -->
      <div class="docs-section" id="doc-commands">
        <div class="docs-h1">Commands Reference</div>
        <div class="docs-sub">All commands available in this project.</div>
        <div class="docs-h2">Development — aa:</div>
        <div class="cmd-row"><div class="cmd-label" style="color:var(--text2)">setup</div><div class="cmd-val">aa: configurar</div></div>
        <div class="cmd-row"><div class="cmd-label" style="color:var(--text2)">task</div><div class="cmd-val">aa: [your task here]</div></div>
        <div class="cmd-row"><div class="cmd-label" style="color:var(--text2)">resume</div><div class="cmd-val">aa: continúa — [answer]</div></div>
        <div class="cmd-row"><div class="cmd-label" style="color:var(--text2)">help</div><div class="cmd-val">aa: help</div></div>
        <div class="docs-h2">QA Department — audit:</div>
        <div class="cmd-row"><div class="cmd-label" style="color:var(--text2)">full</div><div class="cmd-val">audit: auditar</div></div>
        <div class="cmd-row"><div class="cmd-label" style="color:var(--text2)">security</div><div class="cmd-val">audit: seguridad</div></div>
        <div class="cmd-row"><div class="cmd-label" style="color:var(--text2)">help</div><div class="cmd-val">audit: help</div></div>
        <div class="docs-h2">Knowledge Graph</div>
        <div class="cmd-row"><div class="cmd-label" style="color:var(--text2)">sync</div><div class="cmd-val">node .agentic/grafo/grafo.js sync</div></div>
        <div class="cmd-row"><div class="cmd-label" style="color:var(--text2)">stats</div><div class="cmd-val">node .agentic/grafo/grafo.js stats</div></div>
        <div class="cmd-row"><div class="cmd-label" style="color:var(--text2)">dashboard</div><div class="cmd-val">node dashboard-v4.js</div></div>
      </div>

      <!-- MODULES -->
      <div class="docs-section" id="doc-modules" style="display:none;padding:0">
        <div style="display:flex;height:calc(100vh - 142px);overflow:hidden">
          <!-- Graph — exact same pattern as Knowledge Graph -->
          <div class="graph-area" id="mod-area" style="position:relative;flex:1;overflow:hidden;background:var(--bg)">
            <svg id="mod-svg" style="width:100%;height:100%"></svg>
            <div class="gtt" id="mod-tt"></div>
            <div style="position:absolute;top:10px;left:10px;background:rgba(17,21,32,.9);border:1px solid var(--border);border-radius:8px;padding:8px 12px;display:flex;gap:12px">
              <div style="font-size:10px;color:#34d399;display:flex;align-items:center;gap:4px"><div style="width:12px;height:12px;border-radius:3px;background:rgba(16,185,129,0.2);border:1px solid rgba(16,185,129,0.5)"></div>implemented</div>
              <div style="font-size:10px;color:#fbbf24;display:flex;align-items:center;gap:4px"><div style="width:12px;height:12px;border-radius:3px;background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.4)"></div>pending</div>
            </div>
            <div style="position:absolute;bottom:12px;left:12px;display:flex;gap:6px">
              <button onclick="resetModGraph()" style="background:rgba(17,21,32,.9);border:1px solid var(--border);color:var(--text2);border-radius:6px;padding:5px 9px;font-size:10px;cursor:pointer">⟳ Reset</button>
            </div>
            <!-- Detail panel -->
            <div id="mod-detail" style="position:absolute;right:12px;top:12px;width:240px;background:var(--bg2);border:1px solid var(--border);border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.5);display:none;padding:14px">
              <div style="display:flex;justify-content:space-between;margin-bottom:8px">
                <div style="font-size:13px;font-weight:600;color:var(--text)" id="mod-det-title"></div>
                <div onclick="document.getElementById('mod-detail').style.display='none'" style="cursor:pointer;color:var(--text3)">×</div>
              </div>
              <div id="mod-det-body"></div>
            </div>
          </div>
          <!-- List panel -->
          <div style="width:220px;flex-shrink:0;background:var(--bg2);border-left:1px solid var(--border);overflow-y:auto;padding:10px">
            <div style="font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:.08em;font-weight:700;margin-bottom:8px">✅ Implemented (${modulosImpl.length})</div>
            ${modulosImpl.length ? modulosImpl.map(m => {
              const clean = m.replace(/\\*\\*/g,'').replace(/✅/g,'').trim();
              const area = clean.toLowerCase().split(/[\\s\\-\\/]/)[0];
              const nc = nodes.filter(n => n.area === area);
              const errs = nc.filter(n => n.tipo === 'error').length;
              const pats = nc.filter(n => n.tipo === 'patron').length;
              return `<div onclick="selectModule('${clean.replace(/'/g,"\'")}','${area}',null)" style="padding:7px 10px;border-radius:6px;margin-bottom:4px;cursor:pointer;border:1px solid transparent;background:var(--bg3);transition:all .15s" onmouseover="this.style.borderColor='#10b981'" onmouseout="this.style.borderColor='transparent'"><div style="font-size:11px;font-weight:500;color:var(--text);margin-bottom:2px">${clean.length>24?clean.slice(0,24)+'…':clean}</div><div style="display:flex;gap:4px">${errs>0?`<span style="font-size:9px;color:#f87171">${errs} err</span>`:''}${pats>0?`<span style="font-size:9px;color:#34d399">${pats} pat</span>`:''}</div></div>`;
            }).join('') : '<div style="font-size:11px;color:var(--text3);padding:8px">No modules</div>'}
            <div style="font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:.08em;font-weight:700;margin:12px 0 8px">⏳ Pending (${modulosPend.length})</div>
            ${modulosPend.length ? modulosPend.map(m => {
              const clean = m.replace(/\\*\\*/g,'').replace(/\\[.\\]\\s*/g,'').trim();
              return `<div style="padding:7px 10px;border-radius:6px;margin-bottom:4px;border:1px solid rgba(245,158,11,.2);background:rgba(245,158,11,.04)"><div style="font-size:11px;color:#fbbf24">${clean.length>24?clean.slice(0,24)+'…':clean}</div></div>`;
            }).join('') : ''}
          </div>
        </div>
      </div>
      <!-- RULES -->
      <div class="docs-section" id="doc-rules">
        <div class="docs-h1">Project Rules</div>
        <div class="docs-sub">Rules that apply to all development. The system enforces these automatically.</div>
        ${reglas.length ? reglas.map(r => `<div class="rule-item"><div class="rule-dot"></div><div>${escHtml(r)}</div></div>`).join('') : '<div class="empty-state">No rules defined yet — run aa: configurar</div>'}
      </div>

      <!-- PATTERNS -->
      <div class="docs-section" id="doc-patterns">
        <div class="docs-h1">Patterns</div>
        <div class="docs-sub">Rules the system learned from this project. HIGH = permanent rule applied automatically.</div>
        ${patrones.length ? patrones.filter(p => p.titulo && p.titulo !== 'Nombre del patrón' && p.titulo.length > 5).sort((a,b) => {const w={ALTA:3,MEDIA:2,BAJA:1}; return (w[b.confianza]||0)-(w[a.confianza]||0);}).map(p => {
          const maxUse = Math.max(...patrones.map(x => x.aplicado), 1);
          return `<div class="pattern-card ${p.confianza==='ALTA'?'high':''}">
            <div class="pc-top">
              <div class="pc-title">${escHtml(p.titulo)}</div>
              <span class="mb c${p.confianza}">${escHtml(p.confianza)}</span>
              <span class="ab">${escHtml(p.area)}</span>
            </div>
            ${p.aplicado > 0 ? `<div style="font-size:10px;color:var(--text3);margin-bottom:4px">Applied ${p.aplicado} times · ${p.util} useful</div><div class="usage-bar"><div class="usage-fill" style="width:${Math.round(p.aplicado/maxUse*100)}%"></div></div>` : ''}
          </div>`;
        }).join('') : '<div class="empty-state">No patterns yet — they build up as you work</div>'}
      </div>

      <!-- DECISIONS -->
      <div class="docs-section" id="doc-decisions">
        <div class="docs-h1">Architectural Decisions</div>
        <div class="docs-sub">Why things are the way they are. The most important layer of project knowledge.</div>
        ${decisiones.length ? decisiones.map(d => `<div class="decision-card"><div class="dc-title">${escHtml(d.titulo)}</div><div class="dc-body" style="color:var(--text3);font-size:10px;margin-bottom:4px">${escHtml(d.area)} · ${d.confianza}</div></div>`).join('') : '<div class="empty-state">No decisions recorded yet</div>'}
      </div>

      <!-- ERRORS -->
      <div class="docs-section" id="doc-errors">
        <div class="docs-h1">Known Error Patterns</div>
        <div class="docs-sub">Errors the system has already learned to avoid automatically.</div>
        ${errores.length ? errores.filter(e => e.titulo && e.titulo !== 'Nombre del patrón' && e.titulo.length > 5).sort((a,b)=>b.aplicado-a.aplicado).map(e => `<div class="pattern-card" style="border-left:3px solid var(--red)">
          <div class="pc-top"><div class="pc-title">${escHtml(e.titulo)}</div><span class="mb c${e.confianza}">${e.confianza}</span><span class="ab">${escHtml(e.area)}</span></div>
          ${e.aplicado > 0 ? `<div style="font-size:10px;color:var(--text3)">Resolved ${e.aplicado} times</div>` : ''}
        </div>`).join('') : '<div class="empty-state">No errors recorded yet</div>'}
      </div>

      <!-- FOR NEW DEVS -->
      <div class="docs-section" id="doc-questions">
        <div class="docs-h1">For New Developers</div>
        <div class="docs-sub">Everything a new team member needs to get up to speed.</div>
        <div class="report-section">
          <div class="report-title">💡 Suggested Questions to explore</div>
          ${suggestedQuestions.map(q => `<div class="question-card" onclick="askQuestion(${escHtml(JSON.stringify(q))})">${escHtml(q)}<span class="question-arrow">↗</span></div>`).join('')}
        </div>
        <div class="docs-h2">🔑 Key things to know</div>
        ${patrones.filter(p=>p.confianza==='ALTA').length>0 ? `
        <div style="background:rgba(16,185,129,.05);border:1px solid rgba(16,185,129,.2);border-radius:10px;padding:14px;margin-bottom:12px">
          <div style="font-size:11px;font-weight:600;color:#34d399;margin-bottom:8px">★ Permanent rules (HIGH confidence)</div>
          ${patrones.filter(p=>p.confianza==='ALTA').map(p=>`<div style="font-size:12px;color:var(--text2);padding:4px 0;border-bottom:1px solid rgba(255,255,255,.04)">${escHtml(p.titulo)}</div>`).join('')}
        </div>` : ''}
        ${errores.length>0 ? `
        <div style="background:rgba(239,68,68,.04);border:1px solid rgba(239,68,68,.15);border-radius:10px;padding:14px;margin-bottom:12px">
          <div style="font-size:11px;font-weight:600;color:#f87171;margin-bottom:8px">⚠️ Errors to avoid</div>
          ${errores.slice(0,3).map(e=>`<div style="font-size:12px;color:var(--text2);padding:4px 0;border-bottom:1px solid rgba(255,255,255,.04)">${escHtml(e.titulo)}</div>`).join('')}
        </div>` : ''}
      </div>

      <!-- METRICS -->
      <div class="docs-section" id="doc-metrics">
        <div class="docs-h1">📊 Metrics</div>
        <div class="docs-sub">Real observability — every aa: cycle tracked. Data from SQLite, not estimates.</div>
        ${metricsData.total === 0 ? `<div class="empty-state" style="padding:48px;text-align:center">
          <div style="font-size:36px;margin-bottom:12px">📊</div>
          <div style="font-size:14px;color:var(--text2);margin-bottom:6px">No cycles recorded yet</div>
          <div style="font-size:12px;color:var(--text3)">Run <code style="background:var(--bg3);padding:2px 6px;border-radius:3px">aa: [task]</code> to start — metrics appear automatically after each cycle</div>
        </div>` : `
        <!-- Fila 1: 4 KPIs principales -->
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:12px">
          <div style="background:linear-gradient(135deg,rgba(139,92,246,.08),rgba(16,185,129,.04));border:1px solid rgba(139,92,246,.2);border-radius:10px;padding:14px;text-align:center">
            <div style="font-size:28px;font-weight:700;color:${metricsData.goal_attainment>=80?'#34d399':metricsData.goal_attainment>=60?'#fbbf24':'#f87171'}">${metricsData.goal_attainment}%</div>
            <div style="font-size:10px;font-weight:600;color:var(--text2);margin-top:3px">Goal Attainment</div>
            <div style="font-size:9px;color:${metricsData.goal_attainment>=80?'#34d399':'var(--text3)'}">target >80%</div>
          </div>
          <div style="background:rgba(6,182,212,.05);border:1px solid rgba(6,182,212,.2);border-radius:10px;padding:14px;text-align:center">
            <div style="font-size:28px;font-weight:700;color:var(--cyan)">${metricsData.autonomy_ratio||0}%</div>
            <div style="font-size:10px;font-weight:600;color:var(--text2);margin-top:3px">Autonomy Ratio</div>
            <div style="font-size:9px;color:var(--text3)">cycles without STOP</div>
          </div>
          <div style="background:rgba(16,185,129,.04);border:1px solid rgba(16,185,129,.2);border-radius:10px;padding:14px;text-align:center">
            <div style="font-size:28px;font-weight:700;color:${(metricsData.handoff_integrity||0)>=90?'#34d399':'#fbbf24'}">${metricsData.handoff_integrity||0}%</div>
            <div style="font-size:10px;font-weight:600;color:var(--text2);margin-top:3px">Handoff Integrity</div>
            <div style="font-size:9px;color:${(metricsData.handoff_integrity||0)>=90?'#34d399':'var(--text3)'}">target >90%</div>
          </div>
          <div style="background:rgba(239,68,68,.04);border:1px solid rgba(239,68,68,.15);border-radius:10px;padding:14px;text-align:center">
            <div style="font-size:28px;font-weight:700;color:${parseFloat(metricsData.drift_index||0)<=0.5?'#34d399':'#f87171'}">${metricsData.drift_index||'0'}</div>
            <div style="font-size:10px;font-weight:600;color:var(--text2);margin-top:3px">Drift Index</div>
            <div style="font-size:9px;color:${parseFloat(metricsData.drift_index||0)<=0.5?'#34d399':'var(--text3)'}">blockers/cycle (0=ideal)</div>
          </div>
        </div>

        <!-- Fila 2: 6 stats secundarios -->
        <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:8px;margin-bottom:12px">
          <div class="info-card"><div class="ic-label">Cycles</div><div class="ic-val" style="color:var(--pl)">${metricsData.total}</div></div>
          <div class="info-card"><div class="ic-label">Completed</div><div class="ic-val" style="color:var(--green)">${metricsData.completados}</div></div>
          <div class="info-card"><div class="ic-label">STOPs</div><div class="ic-val" style="color:var(--red)">${metricsData.stops}</div></div>
          <div class="info-card"><div class="ic-label">Patterns used</div><div class="ic-val" style="color:var(--amber)">${metricsData.patronesTotal}</div></div>
          <div class="info-card"><div class="ic-label">Errors avoided</div><div class="ic-val" style="color:var(--cyan)">${metricsData.erroresTotal}</div></div>
          <div class="info-card"><div class="ic-label">Test pass rate</div><div class="ic-val" style="color:var(--green)">${metricsData.test_rate||0}%</div></div>
        </div>

        <!-- Métrica extra: tiempo por ciclo y reintentos -->
        ${metricsData.avg_duracion_ms > 0 || metricsData.reintento_rate > 0 ? `
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px">
          ${metricsData.avg_duracion_ms>0?`<div class="info-card"><div class="ic-label">Avg cycle time</div><div class="ic-val" style="color:var(--text2);font-size:13px">${metricsData.avg_duracion_ms>60000?Math.round(metricsData.avg_duracion_ms/60000)+'m':metricsData.avg_duracion_ms+'ms'}</div></div>`:''}
          ${metricsData.avg_fase_ms>0?`<div class="info-card"><div class="ic-label">Avg phase time</div><div class="ic-val" style="color:var(--text2);font-size:13px">${metricsData.avg_fase_ms>60000?Math.round(metricsData.avg_fase_ms/60000)+'m':metricsData.avg_fase_ms+'ms'}</div></div>`:''}
          ${metricsData.reintento_rate>0?`<div class="info-card"><div class="ic-label">Retry rate</div><div class="ic-val" style="color:${metricsData.reintento_rate>30?'#f87171':'#fbbf24'};font-size:16px">${metricsData.reintento_rate}%</div></div>`:''}
        </div>` : ''}

        <!-- Guardrail violations -->
        ${metricsData.guardrail_violations > 0
          ? `<div style="background:rgba(239,68,68,.06);border:1px solid rgba(239,68,68,.2);border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:11px;color:#f87171">⚠️ Guardrail violations: ${metricsData.guardrail_violations} — instructions outside project scope</div>`
          : `<div style="background:rgba(16,185,129,.04);border:1px solid rgba(16,185,129,.15);border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:11px;color:#34d399">✓ Guardrail violations: 0 — all instructions within project scope</div>`}

        <!-- Éxito por tipo de tarea -->
        ${metricsData.exito_por_tipo && metricsData.exito_por_tipo.length > 1 ? `
        <div class="docs-h2">Success rate by task type</div>
        <div style="display:grid;grid-template-columns:repeat(${Math.min(metricsData.exito_por_tipo.length,4)},1fr);gap:8px;margin-bottom:16px">
          ${metricsData.exito_por_tipo.map(t => `
          <div style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:10px;text-align:center">
            <div style="font-size:18px;font-weight:700;color:${t.rate>=80?'#34d399':t.rate>=60?'#fbbf24':'#f87171'}">${t.rate}%</div>
            <div style="font-size:10px;color:var(--text2);margin-top:2px">${t.tipo}</div>
            <div style="font-size:9px;color:var(--text3)">${t.ok}/${t.total}</div>
          </div>`).join('')}
        </div>` : ''}

        <!-- Evolución de memoria -->
        ${metricsData.evolucion_memoria ? `
        <div class="docs-h2">Memory evolution</div>
        <div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:16px">
          <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;text-align:center">
            <div><div style="font-size:18px;font-weight:600;color:var(--pl)">${metricsData.evolucion_memoria.nodos_inicio}</div><div style="font-size:10px;color:var(--text3)">nodes at start</div></div>
            <div><div style="font-size:18px;font-weight:600;color:var(--pl)">${metricsData.evolucion_memoria.nodos_ahora}</div><div style="font-size:10px;color:var(--text3)">nodes now</div></div>
            <div><div style="font-size:18px;font-weight:600;color:${metricsData.evolucion_memoria.crecimiento>0?'#34d399':'#94a3b8'}">+${metricsData.evolucion_memoria.crecimiento}</div><div style="font-size:10px;color:var(--text3)">growth</div></div>
            <div><div style="font-size:18px;font-weight:600;color:var(--amber)">${metricsData.evolucion_memoria.alta_ahora}</div><div style="font-size:10px;color:var(--text3)">HIGH rules now</div></div>
          </div>
        </div>` : ''}

        <!-- Ciclos recientes -->
        <div class="docs-h2">Recent cycles</div>
        ${(ciclosDB&&ciclosDB.length>0?ciclosDB:logsData).map(l => {
          const esDB = !!l.ciclo_id;
          const tarea = (esDB ? l.tarea : l.header)||'';
          const modulo = l.modulo;
          const ok = esDB ? l.estado==='COMPLETADO' : (l.resultado&&l.resultado.includes('COMPLETADO'));
          const fases = esDB && l.fases_total>0 ? l.fases_completadas+'/'+l.fases_total+' phases' : '';
          const tests = esDB ? (l.tests_pasando||0)+'/'+(l.tests_generados||0)+' tests' : (l.tests||'');
          const tipo  = esDB && l.tipo_tarea ? l.tipo_tarea : '';
          let pats=0; if(esDB){try{pats=JSON.parse(l.patrones_aplicados||'[]').length;}catch(e){}}
          return `<div style="background:var(--bg2);border:1px solid var(--border);border-left:3px solid ${ok?'var(--green)':'var(--red)'};border-radius:8px;padding:10px 14px;margin-bottom:6px">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px">
              <div style="font-size:12px;font-weight:500;color:var(--text);flex:1;margin-right:8px">${tarea.slice(0,65)}</div>
              <div style="display:flex;gap:6px;align-items:center;flex-shrink:0">
                ${tipo?`<span style="font-size:9px;background:rgba(139,92,246,.15);color:#a78bfa;border-radius:3px;padding:1px 5px">${tipo}</span>`:''}
                <span style="font-size:10px;padding:2px 7px;border-radius:4px;background:${ok?'rgba(16,185,129,.15)':'rgba(239,68,68,.15)'};color:${ok?'#34d399':'#f87171'}">${ok?'done':'stop'}</span>
              </div>
            </div>
            <div style="display:flex;gap:10px;font-size:10px;color:var(--text3);flex-wrap:wrap">
              ${modulo&&modulo!=='global'?`<span>📦 ${modulo}</span>`:''}
              ${fases?`<span>${fases}</span>`:''}
              ${tests&&tests!=='0/0'?`<span style="color:#34d399">🧪 ${tests}</span>`:''}
              ${pats>0?`<span style="color:var(--amber)">★ ${pats} patterns</span>`:''}
              <span style="margin-left:auto">${(l.fecha_inicio||'').slice(0,16)}</span>
            </div>
          </div>`;
        }).join('')}
        `}
      </div>

      <!-- TIMELINE -->
      <div class="docs-section" id="doc-timeline">
        <div class="docs-h1">🕐 Decision Timeline</div>
        <div class="docs-sub">Every architectural decision, when it was made, why, and which modules it affects. The project's living memory.</div>
        ${decisiones.length === 0 ? '<div class="empty-state" style="padding:40px">No decisions recorded yet — the system logs them automatically as you build</div>' : `
        <div style="position:relative;padding-left:24px">
          <div style="position:absolute;left:8px;top:0;bottom:0;width:2px;background:var(--border)"></div>
          ${decisiones.map((d,i) => `<div style="position:relative;margin-bottom:16px">
            <div style="position:absolute;left:-20px;top:6px;width:10px;height:10px;border-radius:50%;background:var(--blue);border:2px solid var(--bg)"></div>
            <div style="background:var(--bg2);border:1px solid var(--border);border-left:3px solid var(--blue);border-radius:8px;padding:12px 14px">
              <div style="font-size:12px;font-weight:600;color:var(--text);margin-bottom:4px">${escHtml(d.titulo)}</div>
              <div style="display:flex;gap:8px;margin-bottom:6px">
                <span style="font-size:10px;background:rgba(59,130,246,.15);color:#60a5fa;border-radius:3px;padding:1px 6px">${escHtml(d.area)}</span>
                <span style="font-size:10px;color:var(--text3)">${d.confianza}</span>
              </div>
              ${d.contenido && d.contenido.split('\n').find(l=>l.startsWith('Razón:')) ? `<div style="font-size:11px;color:var(--text2);line-height:1.5">${escHtml(d.contenido.split('\n').find(l=>l.startsWith('Razón:')).replace('Razón:','').trim())}</div>` : ''}
            </div>
          </div>`).join('')}
        </div>`}
        ${specsData.length > 0 ? `
        <div class="docs-h2" style="margin-top:24px">📋 Module Specs</div>
        <div style="font-size:12px;color:var(--text3);margin-bottom:12px">Auto-generated specs — updated after every aa: cycle</div>
        ${specsData.map(s => `<div style="background:var(--bg2);border:1px solid var(--border);border-left:3px solid ${s.estado.includes('IMPLEMENTADO')?'var(--green)':'var(--amber)'};border-radius:8px;padding:10px 14px;margin-bottom:6px;display:flex;align-items:center;gap:10px">
          <div style="font-size:13px;font-weight:500;color:var(--text);flex:1">${s.name}</div>
          <span style="font-size:10px;background:${s.estado.includes('IMPLEMENTADO')?'rgba(16,185,129,.15)':'rgba(245,158,11,.15)'};color:${s.estado.includes('IMPLEMENTADO')?'#34d399':'#fbbf24'};border-radius:4px;padding:2px 7px">${s.estado}</span>
          ${s.tests>0?`<span style="font-size:10px;color:var(--text3)">${s.tests} tests</span>`:''}
          <span style="font-size:10px;color:var(--text3)">${s.fecha}</span>
        </div>`).join('')}` : ''}
      </div>

      <!-- ONBOARDING -->
      <div class="docs-section" id="doc-onboarding">
        <div class="docs-h1">🚀 Project Setup</div>
        <div class="docs-sub">How configured is this project with Agentix KDD. Complete all steps for the full system to work.</div>

        <!-- Progress bar -->
        <div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:20px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
            <div style="font-size:14px;font-weight:600;color:var(--text)">Setup progress</div>
            <div style="font-size:24px;font-weight:700;color:${onboardingData.pct===100?'var(--green)':onboardingData.pct>50?'var(--amber)':'var(--red)'}">${onboardingData.pct}%</div>
          </div>
          <div style="height:8px;background:var(--bg3);border-radius:4px;overflow:hidden;margin-bottom:16px">
            <div style="height:100%;width:${onboardingData.pct}%;background:${onboardingData.pct===100?'var(--green)':onboardingData.pct>50?'var(--amber)':'var(--purple)'};border-radius:4px;transition:width .5s"></div>
          </div>
          ${onboardingData.checks.map(c => `<div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.04)">
            <span style="font-size:16px">${c.ok?'✅':'⬜'}</span>
            <span style="font-size:12px;color:${c.ok?'var(--text)':'var(--text3)'}">${c.label}</span>
            ${!c.ok?'<span style="font-size:10px;color:var(--amber);margin-left:auto">pending</span>':'<span style="font-size:10px;color:var(--green);margin-left:auto">done</span>'}
          </div>`).join('')}
        </div>

        ${onboardingData.pct < 100 ? `
        <div class="docs-h2">Next steps</div>
        ${onboardingData.checks.filter(c=>!c.ok).map(c => {
          const steps = {
            'config.md configurado': 'Open in Cursor/Claude Code and run: aa: configurar',
            'Primer sync del grafo': 'Run: node .agentic/grafo/grafo.cjs sync',
            'Módulos documentados': 'Run: aa: configurar — describe your modules',
            'Primera decisión registrada': 'Run any aa: task — decisions are logged automatically',
            'Primer patrón registrado': 'Run any aa: task — patterns are detected automatically',
            'Primer ciclo aa: completado': 'Run: aa: [any task]',
            'Specs generadas': 'Complete a full module with aa: — specs auto-generate',
          };
          return `<div style="background:var(--bg2);border:1px solid rgba(245,158,11,.2);border-radius:8px;padding:12px 14px;margin-bottom:8px;display:flex;gap:10px;align-items:flex-start">
            <span style="font-size:18px;flex-shrink:0">⏳</span>
            <div>
              <div style="font-size:12px;font-weight:600;color:var(--amber);margin-bottom:4px">${c.label}</div>
              <div style="font-size:11px;color:var(--text2)">${steps[c.label]||'Follow the setup instructions'}</div>
            </div>
          </div>`;
        }).join('')}` : `
        <div style="background:rgba(16,185,129,.08);border:1px solid rgba(16,185,129,.25);border-radius:12px;padding:20px;text-align:center">
          <div style="font-size:32px;margin-bottom:8px">🎉</div>
          <div style="font-size:16px;font-weight:700;color:#34d399;margin-bottom:6px">Fully configured</div>
          <div style="font-size:12px;color:var(--text2)">This project has Agentix KDD fully set up. The system will keep improving automatically.</div>
        </div>`}
      </div>

    </div>
  </div>
</div>

<!-- ════════ PRESERVATION INTEL ════════ -->
<div id="mode-intel" style="display:none">
  <button class="help-fab help-fab-fixed" onclick="showTermsGlossary('intel')" title="¿Qué significa cada tarjeta?">?</button>



  <p class="il-title">Contract Guard</p>
  <div class="il-grid">
    <div class="il-card">
      <div class="il-card-head">
        <div class="il-card-icon icon-p">🛡️</div>
        <div><div class="il-card-name">Contratos verificados</div><div class="il-card-sub">Lo que no se puede romper</div></div>
      </div>
      <div class="il-stat-row">
        <div class="il-stat"><div class="il-stat-val vp">${contractData.protected}</div><div class="il-stat-lbl">Protected</div></div>
        <div class="il-stat"><div class="il-stat-val vg">${contractData.verified}</div><div class="il-stat-lbl">Verified</div></div>
        <div class="il-stat"><div class="il-stat-val va">${contractData.candidate}</div><div class="il-stat-lbl">Candidate</div></div>
        <div class="il-stat"><div class="il-stat-val ${contractData.violations > 0 ? 'vr' : 'vx'}">${contractData.violations}</div><div class="il-stat-lbl">Violations</div></div>
      </div>
      ${contractData.recent && contractData.recent.length > 0 ? `
      <div class="il-list">
        ${contractData.recent.map(c => `
          <div class="il-row">
            <span class="il-badge b${c.status[0]}">${c.status.toUpperCase()}</span>
            <span class="il-row-name" title="${escHtml(c.name)}">${escHtml(c.name.substring(0,38))}</span>
            <span class="il-row-mod">${escHtml(c.module)}</span>
          </div>`).join('')}
      </div>` : `<div class="empty-state">Sin contratos — corre ciclos aa: para generarlos</div>`}
    </div>

    <div class="il-card">
      <div class="il-card-head">
        <div class="il-card-icon icon-a">✨</div>
        <div><div class="il-card-name">Creative Engine</div><div class="il-card-sub">Autonomía creativa dirigida</div></div>
      </div>
      <div class="lvl-bar">
        <span style="font-size:11px;color:var(--text3);white-space:nowrap">Nivel ${creativeData.level}</span>
        <div class="lvl-track"><div class="lvl-fill" style="width:${Math.round(creativeData.level / 3 * 100)}%;background:${creativeData.level >= 2 ? '#34d399' : '#fbbf24'}"></div></div>
        <span style="font-size:11px;color:${creativeData.level >= 2 ? '#34d399' : '#fbbf24'};white-space:nowrap">${creativeData.level >= 2 ? 'CREATIVO' : 'ASISTIDO'}</span>
      </div>
      ${creativeData.level < 2 ? `<div style="font-size:11px;color:var(--text3);margin-bottom:10px">Faltan ${10 - (creativeData.protected_for_level2 || 0)} contratos para Nivel 2</div>` : ''}
      <div class="il-stat-row">
        <div class="il-stat"><div class="il-stat-val va">${creativeData.suggestions}</div><div class="il-stat-lbl">Pendientes</div></div>
        <div class="il-stat"><div class="il-stat-val vg">${creativeData.wins}</div><div class="il-stat-lbl">Aplicadas</div></div>
      </div>
      ${creativeData.recent_suggestions && creativeData.recent_suggestions.length > 0 ? `
        ${creativeData.recent_suggestions.map(s => `
          <div class="sug-row">
            <span class="sug-type ${s.auto_applicable ? 'sug-auto' : ''}">${s.type}</span>
            <span class="sug-txt" title="${escHtml(s.title)}">${escHtml(s.title.substring(0,50))}</span>
          </div>`).join('')}` : `<div class="empty-state">Sin sugerencias todavía</div>`}
    </div>

    <div class="il-card">
      <div class="il-card-head">
        <div class="il-card-icon icon-g">🔬</div>
        <div><div class="il-card-name">MemCurator</div><div class="il-card-sub">Gobernanza autónoma</div></div>
      </div>
      <div class="cur-row"><span class="cur-k">Última curation</span><span class="cur-v">${curatorData.lastRun}</span></div>
      <div class="cur-row"><span class="cur-k">Auto-run</span><span class="cur-v">cada 10 ciclos</span></div>
      <div class="cur-row"><span class="cur-k">TTL episódico</span><span class="cur-v">30 días</span></div>
      <div class="cur-row"><span class="cur-k">Límite nodos</span><span class="cur-v">1,000</span></div>
      <div class="cur-row"><span class="cur-k">Dedup threshold</span><span class="cur-v">92% Jaccard</span></div>
      <div style="margin-top:10px;font-size:11px;color:var(--text3)">
        <code style="color:#a5b4fc">akdd cure</code> — manual &nbsp;·&nbsp; <code style="color:#a5b4fc">akdd cure report</code> — preview
      </div>
    </div>

    <div class="il-card">
      <div class="il-card-head">
        <div class="il-card-icon icon-p">🧬</div>
        <div><div class="il-card-name">Aprendizaje Estructural</div><div class="il-card-sub">Nativo — ast_symbols/ast_edges, sin herramienta externa</div></div>
      </div>
      <div class="il-stat-row">
        <div class="il-stat"><div class="il-stat-val ${structuralData.patronesEstructurales > 0 ? 'vg' : 'vx'}">${structuralData.patronesEstructurales}</div><div class="il-stat-lbl">Patrones aprendidos</div></div>
        <div class="il-stat"><div class="il-stat-val vp">${structuralData.archivosCambiados}</div><div class="il-stat-lbl">Archivos en último index</div></div>
      </div>
      ${structuralData.ultimoIndex ? `<div style="font-size:11px;color:var(--text3);margin-bottom:8px">Último index AST: ${escHtml(structuralData.ultimoIndex)}</div>` : `<div class="empty-state">Sin índice AST todavía — corre: node .agentic/grafo/ast-indexer.cjs index</div>`}
      ${structuralData.cadenasActivas.length > 0 ? `
      <div class="il-list">
        ${structuralData.cadenasActivas.map(c => `<div class="il-row"><span class="il-badge bp">CADENA</span><span class="il-row-name" title="${escHtml(c)}">${escHtml(c.substring(0, 45))}</span></div>`).join('')}
      </div>` : `<div class="empty-state">Sin cadenas estructurales promovidas todavía — se necesitan 3 fallos con la misma causa</div>`}
      <div style="margin-top:10px;font-size:11px;color:var(--text3)">
        Verificar tú mismo: <code style="color:#a5b4fc">node .agentic/grafo/causal-edges.cjs detect-changes</code>
      </div>
    </div>
  </div>

  <p class="il-title" style="margin-top:24px">🎨 Memoria UI/Frontend</p>
  <div class="il-grid">
    <div class="il-card">
      <div class="il-card-head">
        <div class="il-card-icon icon-a">🎨</div>
        <div><div class="il-card-name">Memoria de diseño</div><div class="il-card-sub">Misma memoria de siempre, filtrada por área frontend</div></div>
      </div>
      <div class="il-stat-row">
        <div class="il-stat"><div class="il-stat-val ${uiMemoryData.patronesAlta > 0 ? 'vg' : 'vx'}">${uiMemoryData.patronesAlta}</div><div class="il-stat-lbl">Patrones ALTA</div></div>
        <div class="il-stat"><div class="il-stat-val vp">${uiMemoryData.decisionesConArchivo}</div><div class="il-stat-lbl">Decisiones c/archivo</div></div>
        <div class="il-stat"><div class="il-stat-val va">${uiMemoryData.erroresFrontend}</div><div class="il-stat-lbl">Errores UI</div></div>
      </div>
      <div style="margin-top:6px;font-size:11px;color:var(--text3)">
        Ver reglas: pestaña <b>KDD Memory</b>, buscar por área "frontend"
      </div>
    </div>

    <div class="il-card">
      <div class="il-card-head">
        <div class="il-card-icon ${uiMemoryData.nativeGateViolations > 0 ? 'icon-a' : 'icon-g'}">${uiMemoryData.nativeGateViolations > 0 ? '⚠️' : '✅'}</div>
        <div><div class="il-card-name">UI Native Gate</div><div class="il-card-sub">confirm/alert/prompt nativos — chequeo mecánico</div></div>
      </div>
      <div class="il-stat-row">
        <div class="il-stat"><div class="il-stat-val ${uiMemoryData.nativeGateViolations > 0 ? 'vr' : 'vg'}">${uiMemoryData.nativeGateViolations}</div><div class="il-stat-lbl">Violaciones activas</div></div>
      </div>
      ${uiMemoryData.nativeGateSample.length > 0 ? `
      <div class="il-list">
        ${uiMemoryData.nativeGateSample.map(s => `<div class="il-row"><span class="il-badge bi">NATIVO</span><span class="il-row-name" title="${escHtml(s)}">${escHtml(s)}</span></div>`).join('')}
      </div>` : `<div class="empty-state">Sin elementos nativos sin estilizar en public/panel/js</div>`}
      <div style="margin-top:10px;font-size:11px;color:var(--text3)">
        Verificar tú mismo: <code style="color:#a5b4fc">node .agentic/grafo/ui-native-gate.cjs &lt;archivos&gt;</code>
      </div>
    </div>

    <div class="il-card">
      <div class="il-card-head">
        <div class="il-card-icon icon-g">👁</div>
        <div><div class="il-card-name">Ojos UI</div><div class="il-card-sub">v3.13 — forms/selects/required y CSS como nodos del grafo</div></div>
      </div>
      <div class="il-stat-row">
        <div class="il-stat"><div class="il-stat-val vg">${uiMemoryData.uiForms}</div><div class="il-stat-lbl">Forms</div></div>
        <div class="il-stat"><div class="il-stat-val vg">${uiMemoryData.uiSelects}</div><div class="il-stat-lbl">Selects</div></div>
        <div class="il-stat"><div class="il-stat-val vp">${uiMemoryData.uiFields}</div><div class="il-stat-lbl">Campos</div></div>
        <div class="il-stat"><div class="il-stat-val va">${uiMemoryData.uiCssClasses}</div><div class="il-stat-lbl">Clases CSS</div></div>
      </div>
      <div style="margin-top:8px;font-size:11px;color:var(--text3)">
        Flujos UI protegidos por el Regression Guard: <b style="color:${uiMemoryData.uiFlujosProtegidos > 0 ? '#4ade80' : 'var(--text3)'}">${uiMemoryData.uiFlujosProtegidos}</b>
        &nbsp;·&nbsp; Browser Gate por vista: ${uiMemoryData.browserGateConfig
          ? '<b style="color:#4ade80">config lista ✓</b>'
          : '<span title="Crear .agentic/browser-gate.json con {port, routes} para activar los checks por comportamiento">config faltante — <code style="color:#a5b4fc">.agentic/browser-gate.json</code></span>'}
      </div>
    </div>
  </div>

</div>
</div>

<div class="glossary-modal" id="glossary-modal" onclick="if(event.target===this)closeGlossary()">
  <div class="glossary-card">
    <div class="glossary-header">
      <div class="glossary-header-title" id="glossary-title"></div>
      <div class="dp-close" onclick="closeGlossary()">×</div>
    </div>
    <div class="glossary-body" id="glossary-body"></div>
  </div>
</div>

<script>
function escHtml(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

// ─── "¡NO ENTIENDO!" — explicación de ESE nodo específico, no un glosario ───
// Reorganiza los datos reales que YA existen para ese nodo puntual (su propio
// contenido/conexiones/números) con etiquetas simples — no inventa nada nuevo,
// no llama ninguna IA, es la misma info de siempre presentada distinto.

const FIELD_LABELS={
  contexto:'📍 Dónde pasó / contexto', 'síntoma':'😵 Lo que se notó', sintoma:'😵 Lo que se notó',
  causa:'🔍 Por qué pasó', 'solución':'✅ Cómo se resolvió (o falta resolver)', solucion:'✅ Cómo se resolvió (o falta resolver)',
  evitar:'🚫 Qué no volver a hacer', 'aplicar cuando':'📌 Cuándo aplica esto', regla:'📏 La regla que quedó',
  error:'💥 El error tal cual salió', origen:'🔎 Cómo se detectó', 'ubicación':'📂 Dónde está en el código',
  ubicacion:'📂 Dónde está en el código', 'razón':'💡 La razón', razon:'💡 La razón',
};
const SKIP_FIELD_LABELS=new Set(['área','area','confianza','aplicado','útil','util','estado','última validación','ultima validacion','creado','tipo','raw']);

// ─── Glosario general de términos — ícono flotante "?", uno por grafo ───────
// Distinto del botón "¡NO ENTIENDO!": esto NO depende de qué nodo esté
// seleccionado, es la misma explicación de conceptos generales siempre.
const TERMS_GLOSSARY={
  kdd:{title:'❓ KDD Memory — términos generales',items:[
    {term:'error',explain:'Un problema real que pasó en el proyecto y quedó anotado en la memoria para no repetirlo.'},
    {term:'pattern (patrón)',explain:'Una forma de resolver algo que ya se probó y funcionó bien — se guarda para reusarla la próxima vez en vez de reinventar la rueda.'},
    {term:'decision',explain:'Una decisión importante que se tomó sobre cómo construir algo, con la razón por la que se eligió así.'},
    {term:'BAJA / MEDIA / ALTA',explain:'Qué tanta confianza hay en que esto sea correcto. Empieza en BAJA y sube solo, entre más veces se use y funcione bien.'},
    {term:'AMBIGUOUS / INFERRED / EXTRACTED',explain:'Qué tan seguro está el sistema de esta información. EXTRACTED = se sacó directo de algo confirmado. INFERRED = se dedujo por contexto. AMBIGUOUS = todavía no está del todo claro.'},
    {term:'Applied / Useful (aplicado/útil)',explain:'Cuántas veces se usó esto, y de esas veces, cuántas de verdad ayudaron.'},
    {term:'Connections (conexiones)',explain:'Con cuántas otras cosas de la memoria del proyecto está relacionado esto — mientras más conexiones, más "central" es.'},
    {term:'⚡ Divine (nodo divino)',explain:'Un apodo cariñoso para los nodos con MUCHAS conexiones — son los que más importan en el mapa.'},
  ]},
  code:{title:'❓ Code Structure — términos generales',items:[
    {term:'archivo / nodo',explain:'Cada punto del grafo es un archivo real de tu código — como una hoja de un cuaderno donde está escrita una parte del programa. No se muestra función por función (serían miles), se agrupa a nivel de archivo para que el grafo sea legible.'},
    {term:'Color del nodo',explain:'El color indica el módulo/carpeta del archivo (ej. src/app, src/lib, scripts, supabase) — así diferencias de un vistazo qué partes del proyecto son frontend, backend, utilidades, etc., incluso si todo está en el mismo lenguaje.'},
    {term:'Tamaño del nodo',explain:'Los archivos que definen al menos una "clase" (una plantilla de código reutilizable) se ven un poco más grandes que los que solo tienen funciones sueltas.'},
    {term:'Funciones / Símbolos',explain:'Cuántas "acciones" (funciones) y piezas de código distintas hay guardadas adentro de este archivo.'},
    {term:'PageRank',explain:'Un número que dice qué tan "importante" es este archivo dentro del proyecto — mientras más alto, más cosas dependen de él. Es el mismo tipo de cálculo que usa Google para ordenar páginas web, aplicado a tu código.'},
    {term:'Importa / llama a',explain:'Los archivos que ESTE necesita para funcionar — como los ingredientes que usa en su receta.'},
    {term:'Usado por',explain:'Los archivos que dependen de este — si algo se rompe aquí, estos otros se ven afectados también.'},
    {term:'IMPORTS',explain:'Una etiqueta que dice: "este archivo trae/usa código de aquel otro".'},
    {term:'Chips de módulo (filtro)',explain:'Cada chip es una carpeta/módulo del proyecto — hacé clic para prenderlo o apagarlo. A diferencia de los filtros de KDD Memory, acá podés apagar VARIOS a la vez (no es uno solo excluyente). "Todos"/"Ninguno" prenden o apagan todos de un golpe.'},
    {term:'Coraza (posición del nodo)',explain:'Los archivos de frontend (todo lo que el usuario final ve, ej. carpeta public/) se acomodan en un anillo exterior; el código de atrás (backend, lógica de negocio) se acomoda hacia el centro. Es una forma de ver de un vistazo qué tan "cerca de la superficie" está cada archivo.'},
    {term:'endpoint≈ (línea cian)',explain:'Une un archivo de frontend con un archivo de backend cuando el primero llama a una ruta de API (ej. /api/embudo/...) que el segundo registra. Es una coincidencia de texto de ruta, no un vínculo exacto guardado en la base de datos — si el front arma la URL de forma dinámica sin el wrapper de siempre, esa conexión no se detecta.'},
  ]},
  combined:{title:'❓ Combined — términos generales',items:[
    {term:'¿Qué es esta pestaña?',explain:'Une los dos mundos: lo que aprendiste del proyecto (errores, patrones, decisiones) y tu código real, para ver si se relacionan.'},
    {term:'área≈ (relación por área)',explain:'Una corazonada, no una certeza: si un error/patrón/decisión dice que pasó en el área "auth", y hay archivos cuya ruta también dice "auth", los conectamos con una línea verde como sugerencia — no es un vínculo 100% exacto guardado en la base de datos.'},
    {term:'nodo rojo/verde/azul (KDD)',explain:'Son los mismos error/patrón/decisión de la pestaña KDD Memory.'},
    {term:'nodo celeste (código)',explain:'Es un archivo real de tu código, igual que en Code Structure.'},
    {term:'Coraza (posición del nodo)',explain:'Igual que en Code Structure: lo de frontend se acomoda hacia afuera, lo de backend hacia el centro — acá se ve mezclado con los nodos de memoria (errores/patrones/decisiones) también clasificados por área.'},
    {term:'endpoint≈ (línea ámbar)',explain:'Une un archivo de frontend con un archivo de backend cuando el primero llama a una ruta de API (ej. /api/embudo/...) que el segundo registra. Es una coincidencia de texto de ruta, igual de aproximada que área≈ — si el front arma la URL de forma dinámica sin el wrapper de siempre, esa conexión no se detecta.'},
  ]},
  intel:{title:'❓ Preservation Intel — términos generales',items:[
    {term:'🛡️ Contract Guard',explain:'Vigila que el código que ya funciona no se rompa por accidente. Cada prueba que pasa varias veces seguidas se vuelve un "contrato" — mientras más veces pasa, más protegido queda.'},
    {term:'Protected / Verified / Candidate',explain:'Los 3 niveles de confianza de un contrato. Candidate = recién detectado, pocas pruebas todavía. Verified = ya pasó varias veces. Protected = pasó tantas veces que quedó blindado — si un cambio nuevo lo rompe, el sistema avisa antes de dejarte continuar.'},
    {term:'Violations (violaciones)',explain:'Cuántas veces un cambio intentó romper algo que ya estaba protegido, y el sistema lo detuvo a tiempo.'},
    {term:'✨ Creative Engine',explain:'Un motor que, además de hacer lo que le pides, se fija en oportunidades de mejora y te las sugiere — nunca cambia nada por su cuenta, siempre pide tu confirmación primero.'},
    {term:'Nivel (de autonomía)',explain:'Qué tanta confianza tiene el sistema para actuar solo. Empieza en Nivel 1 (solo sugiere, nunca aplica nada) y solo puede subir con el tiempo, entre más contratos protegidos acumule el proyecto.'},
    {term:'Pendientes / Aplicadas',explain:'Cuántas sugerencias del Creative Engine están esperando tu confirmación, y cuántas ya confirmaste.'},
    {term:'🔬 MemCurator',explain:'El "bibliotecario" de la memoria del proyecto — su trabajo sería limpiar recuerdos viejos o duplicados para que la memoria no se llene de basura. Hoy todavía no se ha usado nunca en este proyecto.'},
    {term:'🧬 Aprendizaje Estructural',explain:'Analiza cómo se conecta tu código de verdad (qué archivo llama a cuál) para detectar cuando el MISMO tipo de fallo se repite varias veces por la misma cadena de archivos — si pasa 3 veces o más, lo sube automáticamente a "patrón confirmado" sin que nadie tenga que hacerlo a mano.'},
    {term:'🎨 Memoria de diseño',explain:'Lo mismo que Contract Guard/Creative Engine pero mirando solo la parte de UI/diseño: cuántas reglas de estilo de alta confianza hay, cuántas decisiones de layout ya quedaron ligadas a un archivo concreto, y cuántos errores conocidos son de interfaz (responsive, PWA, etc.).'},
    {term:'UI Native Gate',explain:'Un chequeo automático que busca confirm()/alert()/prompt() nativos del navegador en tu código — cosas que ya decidiste reemplazar por tu propio diseño una vez, pero que se pueden colar de nuevo la próxima vez que alguien construye algo parecido sin acordarse de la regla. No bloquea nada, solo avisa.'},
    {term:'🔀 Parallel Guard ("romper el silencio")',explain:'Cuando una tarea se supone que se hace con 2 partes en paralelo (front y back a la vez), este chequeo revisa la conversación real y confirma si de verdad pasó en paralelo o si terminó haciéndose una cosa después de la otra sin que nadie se diera cuenta. Se ve en un reporte aparte (_output/parallel-guard-*.md), no tiene tarjeta propia todavía.'},
  ]},
};

function showTermsGlossary(kind){
  const g=TERMS_GLOSSARY[kind];
  if(!g)return;
  document.getElementById('glossary-title').textContent=g.title;
  document.getElementById('glossary-body').innerHTML=glossaryItemsHTML(g.items.map(it=>({label:it.term,text:it.explain})));
  document.getElementById('glossary-modal').classList.add('visible');
}

function parseContenido(contenido){
  if(!contenido)return[];
  const lines=String(contenido).split('\\n');
  const out=[];
  let currentLabel=null, buffer=[];
  const flush=()=>{ if(currentLabel && buffer.join(' ').trim())out.push({label:currentLabel, text:buffer.join(' ').trim()}); buffer=[]; };
  for(const raw of lines){
    const line=raw.trim();
    if(!line||line.startsWith('##'))continue;
    const m=line.match(/^([A-ZÁÉÍÓÚÑ][a-záéíóúñ ]{2,25}):\\s*(.*)$/);
    if(m){
      const key=m[1].toLowerCase().trim();
      if(SKIP_FIELD_LABELS.has(key)){currentLabel=null;continue;}
      flush();
      currentLabel=FIELD_LABELS[key]||('📋 '+m[1]);
      buffer=m[2]?[m[2]]:[];
    } else if(currentLabel){
      buffer.push(line);
    }
  }
  flush();
  return out;
}

function glossaryItemsHTML(items){
  return items.map(it=>\`
    <div class="glossary-item">
      <div class="glossary-term">\${escHtml(it.label)}</div>
      <div class="glossary-explain">\${escHtml(it.text)}</div>
    </div>
  \`).join('');
}

function explainKddNode(node){
  const fields=parseContenido(node.contenido);
  const deg=DEGREE_MAP[node.id]||0;
  const tipoLabel={error:'un error',patron:'un patrón (algo que se probó y funcionó, para reusarlo)',decision:'una decisión de diseño'}[node.tipo]||node.tipo;
  let summary=\`Esto es \${tipoLabel}, del área "\${node.area||'global'}". \`;
  if(node.aplicado>0)summary+=\`Se ha usado \${node.aplicado}×, de las cuales \${node.util}× resultó útil. \`;
  summary+=\`Está conectado con \${deg} otra(s) cosa(s) de la memoria del proyecto.\`;
  const items=[{label:'📝 En resumen',text:summary},...fields];
  if(!fields.length)items.push({label:'ℹ️ Nota',text:'Este nodo todavía no tiene más detalle guardado aparte del título — probablemente se detectó automáticamente y nadie lo ha revisado a mano todavía (con "aa: aprende").'});
  const menciones=node.simbolosMencionados||[];
  if(menciones.length){
    items.push({label:'🔗 Menciona en código (vínculo real, no aproximado)',
      text:menciones.map(m=>"'"+m.simbolo+"' en "+m.archivo).join(' — ')});
  }
  return {title:'¡NO ENTIENDO! — '+String(node.titulo||'').slice(0,60), bodyHTML:glossaryItemsHTML(items)};
}

// ─── Traductor de nombres técnicos a lenguaje simple ──────────────────────────
// No lee el CUERPO del código (no hay forma de "entender" qué hace sin eso) —
// traduce el NOMBRE de la función/clase usando patrones comunes de convención
// de nombres (camelCase + verbos típicos en inglés). Es una inferencia honesta,
// no una lectura real del código: si el nombre no sigue un patrón reconocido,
// se avisa explícitamente en vez de inventar una explicación.
const HUMANIZE_VERBS={
  get:'obtiene',fetch:'trae',set:'asigna',create:'crea',update:'actualiza',delete:'elimina',
  remove:'elimina',save:'guarda',load:'carga',parse:'interpreta',validate:'valida',
  handle:'maneja / responde a',render:'muestra en pantalla',ensure:'se asegura de que exista',
  read:'lee',write:'escribe',build:'arma',init:'inicializa',initialize:'inicializa',
  check:'verifica',is:'verifica si',has:'verifica si tiene',format:'da formato a',
  generate:'genera',send:'envía',find:'busca',list:'lista',toggle:'activa o desactiva',
  open:'abre',close:'cierra',login:'inicia sesión de',logout:'cierra sesión de',
  normalize:'normaliza',sync:'sincroniza',merge:'combina',filter:'filtra',sort:'ordena',
  calculate:'calcula',compute:'calcula',register:'registra',upsert:'guarda o actualiza',
  add:'agrega',clear:'limpia',reset:'reinicia',refresh:'refresca',apply:'aplica',
};
const HUMANIZE_NOUNS={
  row:'una fila de datos',rows:'filas de datos',object:'un objeto',obj:'un objeto',
  json:'datos JSON',val:'un valor',value:'un valor',user:'el usuario',users:'los usuarios',
  product:'el producto',products:'los productos',form:'el formulario',session:'la sesión',
  config:'la configuración',file:'el archivo',dir:'la carpeta',path:'la ruta',
  data:'los datos',id:'el identificador',name:'el nombre',date:'la fecha',
  order:'el pedido',orders:'los pedidos',cart:'el carrito',auth:'la autenticación',
  token:'el token',key:'la llave',db:'la base de datos',query:'la consulta',
  request:'la solicitud',response:'la respuesta',error:'el error',status:'el estado',
};
function splitWords(s){
  return String(s).replace(/([a-z0-9])([A-Z])/g,'$1 $2').replace(/[_\\-]+/g,' ').toLowerCase().trim();
}
function humanizeWordList(str){
  return str.split(' ').filter(Boolean).map(w=>HUMANIZE_NOUNS[w]||w).join(' ');
}
function humanizeSymbolName(name){
  const toMatch=name.match(/^([a-zA-Z0-9]+)To([A-Z][a-zA-Z0-9]*)$/);
  if(toMatch){
    return {ok:true,text:'convierte '+humanizeWordList(splitWords(toMatch[1]))+' en '+humanizeWordList(splitWords(toMatch[2]))};
  }
  const words=splitWords(name).split(' ').filter(Boolean);
  if(!words.length)return {ok:false,text:name};
  const verb=HUMANIZE_VERBS[words[0]];
  if(!verb)return {ok:false,text:name};
  const rest=humanizeWordList(words.slice(1).join(' '));
  return {ok:true,text:verb+(rest?' '+rest:'')};
}

function explainCodeNode(node){
  const outEdges=CODE_EDGES.filter(e=>edgeEndId(e.source)===node.id);
  const inEdges=CODE_EDGES.filter(e=>edgeEndId(e.target)===node.id);
  const rankNote=node.pagerank>0.01?'uno de los archivos más importantes/centrales del proyecto':node.pagerank>0.002?'un archivo con conectividad media':'un archivo bastante periférico — pocas cosas dependen de él';
  const usedByNames=inEdges.map(e=>{const o=codeNodeMap[edgeEndId(e.source)===node.id?edgeEndId(e.target):edgeEndId(e.source)];return o?o.file.split(/[\\/]/).pop():'';}).filter(Boolean);
  const needsNames=outEdges.map(e=>{const o=codeNodeMap[edgeEndId(e.source)===node.id?edgeEndId(e.target):edgeEndId(e.source)];return o?o.file.split(/[\\/]/).pop():'';}).filter(Boolean);
  let summary=\`Módulo: \${node.modulo||'—'} · Lenguaje: \${node.language||'—'}. Este archivo tiene \${node.functions} función(es) adentro. Es \${rankNote}. \`;
  summary+=usedByNames.length?\`\${usedByNames.length} otro(s) archivo(s) DEPENDEN de este, así que si lo cambias hay que revisar: \${usedByNames.slice(0,6).join(', ')}\${usedByNames.length>6?'…':''}. \`:'Ningún otro archivo indexado depende de este todavía. ';
  summary+=needsNames.length?\`A su vez, este archivo necesita: \${needsNames.slice(0,6).join(', ')}\${needsNames.length>6?'…':''}.\`:'No depende de ningún otro archivo indexado.';
  const items=[{label:'📝 En resumen',text:summary}];
  const syms=node.symbols||[];
  if(syms.length){
    const exported=syms.filter(s=>s.exported);
    const list=(exported.length?exported:syms).slice(0,10);
    const scope=s=>s.exported?'se usa en otras partes del sistema':'solo se usa dentro de este mismo archivo';
    const lines=list.map(s=>{
      const h=humanizeSymbolName(s.name);
      if(h.ok){
        const capitalized=h.text.charAt(0).toUpperCase()+h.text.slice(1);
        return \`\${capitalized} (\${scope(s)}).\`;
      }
      return \`Hace algo relacionado con "\${splitWords(s.name)}" — el nombre no sigue un patrón reconocible para traducirlo automáticamente (\${scope(s)}).\`;
    });
    items.push({label:'🧩 Qué hace este archivo, en palabras simples',
      text:lines.join(' ') + (syms.length>list.length?\` …y \${syms.length-list.length} cosa(s) más.\`:'')
        + ' (Nota: esto se infiere del nombre de cada función, no de leer el código real — puede no ser 100% exacto si el nombre no describe bien lo que hace.)'});
  } else {
    items.push({label:'ℹ️ Nota',text:'No se detectaron funciones ni clases nombradas en este archivo (puede ser solo configuración, tipos, o código sin símbolos exportados reconocidos por el indexador).'});
  }
  const extra=node.extraSymbols||[];
  const endpoints=extra.filter(s=>s.kind==='endpoint');
  if(endpoints.length){
    items.push({label:'🛣️ Rutas de API que expone',
      text:endpoints.map(s=>s.name).join(' · ')});
  }
  const constants=extra.filter(s=>s.kind==='constant'||s.kind==='enum');
  if(constants.length){
    items.push({label:'🏷️ Constantes/enums definidos',
      text:constants.map(s=>s.name).join(', ')});
  }
  const sqlDefs=extra.filter(s=>s.kind==='sql_table'||s.kind==='sql_index');
  if(sqlDefs.length){
    items.push({label:'🗄️ Esquema SQL definido aquí',
      text:sqlDefs.map(s=>(s.kind==='sql_table'?'tabla ':'índice ')+s.name).join(', ')});
  }
  const notes=extra.filter(s=>['note','why','hack','fixme'].includes(s.kind));
  if(notes.length){
    const etiqueta={note:'Nota',why:'Por qué',hack:'Parche temporal',fixme:'Pendiente de arreglar'};
    items.push({label:'🗒️ Lo que el propio código dice de sí mismo',
      text:notes.map(s=>'['+(etiqueta[s.kind]||s.kind)+'] '+s.signature).join(' — ')});
  }
  // Plan 2 (Ojos UI): la materia de interfaz que este archivo define
  const uiMatter=extra.filter(s=>['form','select','field'].includes(s.kind));
  if(uiMatter.length){
    const conReq=s=>(String(s.signature||'').startsWith('[required]')?' (required)':'');
    items.push({label:'🖼️ Materia de UI (forms/selects/campos)',
      text:uiMatter.map(s=>s.name+conReq(s)).join(' · ')});
  }
  const cssDefs=extra.filter(s=>s.kind==='css_class'||s.kind==='css_id');
  if(cssDefs.length){
    const lista=cssDefs.slice(0,25).map(s=>(s.kind==='css_id'?'#':'.')+s.name).join(', ');
    items.push({label:'🎨 Clases/ids CSS definidos aquí',
      text:lista+(cssDefs.length>25?\` …y \${cssDefs.length-25} más.\`:'')});
  }
  return {title:'¡NO ENTIENDO! — '+node.file.split(/[\\/]/).pop(), bodyHTML:glossaryItemsHTML(items)};
}

function explainCombinedNode(node){
  const links=combinedLinksArr.filter(e=>mergedEdgeEndId(e.source)===node.mergedId||mergedEdgeEndId(e.target)===node.mergedId);
  const areaLinks=links.filter(l=>l.tipo==='area_match');
  let summary;
  if(node.group==='kdd'){
    summary=areaLinks.length
      ?\`Este \${node.tipo} ocurrió en el área "\${node.area}". Encontramos \${areaLinks.length} archivo(s) de código cuya ruta también menciona "\${node.area}" — puede que ahí se haya originado, aunque esto es una coincidencia de nombre de carpeta, no un vínculo 100% confirmado en la base de datos.\`
      :\`Este \${node.tipo} es del área "\${node.area||'global'}" y no encontramos ningún archivo de código cuya ruta coincida con esa área todavía.\`;
  } else {
    summary=areaLinks.length
      ?\`Este archivo coincide por nombre de carpeta con \${areaLinks.length} error(es)/patrón(es)/decisión(es) guardados en la memoria — puede que sea donde ocurrieron, aunque es una aproximación, no un vínculo exacto.\`
      :'No encontramos ningún error/patrón/decisión de la memoria cuya área coincida con la ruta de este archivo.';
  }
  return {title:'¡NO ENTIENDO! — '+(node.group==='kdd'?String(node.titulo||'').slice(0,50):node.file.split(/[\\/]/).pop()), bodyHTML:glossaryItemsHTML([{label:'📝 En resumen',text:summary}])};
}

let lastKddNode=null, lastCodeNode=null, lastCombinedNode=null;

function showGlossary(kind){
  let data=null;
  if(kind==='kdd'&&lastKddNode)data=explainKddNode(lastKddNode);
  else if(kind==='code'&&lastCodeNode)data=explainCodeNode(lastCodeNode);
  else if(kind==='combined'&&lastCombinedNode)data=explainCombinedNode(lastCombinedNode);
  if(!data)return;
  document.getElementById('glossary-title').textContent=data.title;
  document.getElementById('glossary-body').innerHTML=data.bodyHTML;
  document.getElementById('glossary-modal').classList.add('visible');
}
function closeGlossary(){
  document.getElementById('glossary-modal').classList.remove('visible');
}

const NODES = ${JSON.stringify(nodes)};
const CODE_NODES = ${JSON.stringify(codeStructure.nodes)};
const CODE_EDGES = ${JSON.stringify(codeStructure.edges)};
const ENDPOINT_HEURISTIC_EDGES = ${JSON.stringify(endpointHeuristicEdges)};
const CODE_COLORS = { archivo: '#00e5ff', clase: '#d88aff' };
// Color por tipo de archivo (lenguaje detectado por el AST indexer) — antes todos los
// archivos se veían del mismo color salvo que tuvieran una clase adentro; ahora cada
// lenguaje tiene su propio color, igual que Code Structure lo pide.
const LANG_COLORS = {
  javascript:'#f7df1e', typescript:'#3178c6', python:'#4b8bbe', go:'#00add8',
  rust:'#dea584', java:'#e76f00', kotlin:'#a97bff', cpp:'#649ad2', c:'#5c9fd6',
  csharp:'#9b4f96', php:'#8993be', ruby:'#cc342d', swift:'#f05138', scala:'#dc322f',
  elixir:'#a37eba', html:'#e34c26', css:'#2979ff', other:'#00e5ff',
};
const MOD_COLORS = ${JSON.stringify(MOD_COLORS_SERVER)};
function codeNodeColor(d){ return MOD_COLORS[d.modulo] || LANG_COLORS[d.language] || CODE_COLORS[d.tipo] || '#00e5ff'; }
const LANGS_PRESENT = [...new Set(CODE_NODES.map(n=>n.language).filter(Boolean))].sort();
const codeNodeMap={};
CODE_NODES.forEach(n=>codeNodeMap[n.id]=n);
const EDGES = ${JSON.stringify(edges)};
const M_NODES = ${JSON.stringify(mNodes)};
const M_EDGES = ${JSON.stringify(mEdges)};
const DEGREE_MAP = ${JSON.stringify(degreeMap)};
const MAX_DEGREE = ${maxDegree};
const GOD_THRESHOLD = ${godThreshold};
const COLORS = {error:'#ef4444',patron:'#10b981',decision:'#3b82f6'};
// Variantes FRONT (16/07/2026, pedido del dueño): el conocimiento que nace del
// frontend se distingue de un vistazo sin leer el área. Mismo temperamento
// semántico (error cálido, patrón verdoso, decisión azulado) pero familia
// neón inconfundible — coherente con la convención "front = eléctrico" del
// Combined. Rosa (no naranja) para el error: el naranja chocaba con el ámbar
// de los nodos divinos.
const COLORS_FRONT = {error:'#ff5ca8',patron:'#a3e635',decision:'#22d3ee'};
function kddNodeColor(d){ return (esNodoFrontend(d)?COLORS_FRONT:COLORS)[d.tipo]||'#8b5cf6'; }
let lang='en', isDark=true, currentFilter='all', currentSide='all', searchVal='', selectedNodeId=null;
let labelsVisible=false;
let modGraphRendered=false;
const nodeMap={};
NODES.forEach(n=>nodeMap[n.id]=n);
const relMap={};
EDGES.forEach(e=>{
  if(!relMap[e.desde_id])relMap[e.desde_id]=[];
  if(!relMap[e.hacia_id])relMap[e.hacia_id]=[];
  relMap[e.desde_id].push({...e,dir:'out'});
  relMap[e.hacia_id].push({...e,dir:'in'});
});

const T={
  en:{tab_graph:'Knowledge Graph',tab_docs:'Project Docs',sb_nodes:'Nodes',sb_report:'Report',sb_stats:'Stats',f_all:'All',f_err:'Errors',f_pat:'Patterns',f_dec:'Decisions',f_high:'★ HIGH',f_god:'⚡ Divine',f_side_all:'All',s_total:'nodes',s_rel:'relations',s_god:'divine',s_high:'HIGH',l_err:'error',l_pat:'pattern',l_dec:'decision',l_err_f:'error front',l_pat_f:'pattern front',l_dec_f:'decision front',l_divine:'divine',btn_reset:'⟳ Reset',btn_center:'⊙ Center',btn_labels:'Labels',nav_overview:'Overview',nav_project:'Project',nav_stack:'Stack',nav_commands:'Commands',nav_arch:'Architecture',nav_modules:'Modules',nav_rules:'Rules',nav_knowledge:'Knowledge',nav_patterns:'Patterns',nav_decisions:'Decisions',nav_errors:'Errors',nav_questions:'For New Devs',h_stack:'Tech Stack',sub_stack:'Technologies used.',graph_report:'Graph Report',divine_nodes:'Divine nodes',surprising:'Surprising connections',btn_print:'Print / Export PDF',btn_copy:'Copy as Markdown',dark:'Dark',light:'Light'},
  es:{tab_graph:'Grafo de conocimiento',tab_docs:'Docs del proyecto',sb_nodes:'Nodos',sb_report:'Reporte',sb_stats:'Stats',f_all:'Todos',f_err:'Errores',f_pat:'Patrones',f_dec:'Decisiones',f_high:'★ ALTA',f_god:'⚡ Divinos',f_side_all:'Todos',s_total:'nodos',s_rel:'relaciones',s_god:'divinos',s_high:'ALTA',l_err:'error',l_pat:'patrón',l_dec:'decisión',l_err_f:'error front',l_pat_f:'patrón front',l_dec_f:'decisión front',l_divine:'divino',btn_reset:'⟳ Resetear',btn_center:'⊙ Centrar',btn_labels:'Labels',nav_overview:'Vista general',nav_project:'Proyecto',nav_stack:'Stack',nav_commands:'Comandos',nav_arch:'Arquitectura',nav_modules:'Módulos',nav_rules:'Reglas',nav_knowledge:'Conocimiento',nav_patterns:'Patrones',nav_decisions:'Decisiones',nav_errors:'Errores',nav_questions:'Para nuevos devs',h_stack:'Stack Tecnológico',sub_stack:'Tecnologías del proyecto.',graph_report:'Reporte del grafo',divine_nodes:'Nodos divinos',surprising:'Conexiones sorprendentes',btn_print:'Imprimir / Exportar PDF',btn_copy:'Copiar como Markdown',dark:'Oscuro',light:'Claro'}
};

function setMode(mode,el){
  document.querySelectorAll('.mode-tab').forEach(t=>t.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('mode-graph').style.display=mode==='graph'?'flex':'none';
  document.getElementById('mode-intel').style.display=mode==='intel'?'flex':'none';
  document.getElementById('mode-docs').style.display=mode==='docs'?'flex':'none';
  if(mode==='docs')setTimeout(renderModuleGraph,100);
}

function setGraphTab(tab,el){
  document.querySelectorAll('.gst').forEach(t=>t.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('graph-sub-kdd').style.display=tab==='kdd'?'flex':'none';
  document.getElementById('graph-sub-code').style.display=tab==='code'?'flex':'none';
  document.getElementById('graph-sub-combined').style.display=tab==='combined'?'flex':'none';
  if(tab==='code'&&!active3DGraphs['code-gc'])renderCodeGraph();
  if(tab==='combined'&&!active3DGraphs['combined-gc'])renderCombinedGraph();
  // A diferencia de D3 (que anima 1-2s y se queda quieto), la librería 3D corre
  // un ciclo de render continuo para que orbitar responda fluido — incluyendo
  // pestañas ya visitadas pero ocultas. Sin esto, con las 3 pestañas visitadas
  // en una sesión larga quedan 3 ciclos de render de GPU corriendo a la vez
  // sin necesidad. Se pausa el que se oculta, se reanuda el que se muestra.
  const activeGraphId=tab==='kdd'?'gc':tab==='code'?'code-gc':'combined-gc';
  ['gc','code-gc','combined-gc'].forEach(id=>{
    if(id===activeGraphId)resume3DGraph(id); else pause3DGraph(id);
  });
}

function showDoc(section,el){
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  el.classList.add('active');
  // Hide all sections
  document.querySelectorAll('.docs-section').forEach(function(s){
    s.style.display='none';
    s.classList.remove('active');
  });
  const sec=document.getElementById('doc-'+section);
  sec.style.display='block';
  sec.classList.add('active');
  const main=document.querySelector('.docs-main');
  if(section==='modules'){
    main.style.padding='0';
    main.style.overflow='hidden';
    sec.style.display='block';
    renderModuleGraph();
  } else {
    main.style.padding='24px 28px';
    main.style.overflow='auto';
  }
}

function showSbTab(tab,el){
  document.querySelectorAll('.sb-tab').forEach(t=>t.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('sbt-nodes').style.display=tab==='nodes'?'flex':'none';
  document.getElementById('sbt-report').style.display=tab==='report'?'block':'none';
  document.getElementById('sbt-stats').style.display=tab==='stats'?'block':'none';
}

function setLang(l){
  lang=l;
  document.querySelectorAll('[data-i]').forEach(el=>{const k=el.getAttribute('data-i');if(T[l][k])el.textContent=T[l][k];});
  renderNodeList();
}

function toggleLabels(){
  labelsVisible=!labelsVisible;
  document.getElementById('label-btn').textContent='Labels '+(labelsVisible?'ON':'OFF');
  // Igual que refreshKddColors(): reasignar el mismo accessor fuerza a la
  // librería a recalcular nodeThreeObject para cada nodo (crea/quita los
  // sprites de texto según labelsVisible, ver renderGraph()).
  const g=active3DGraphs['gc'];
  if(g)g.nodeThreeObject(g.nodeThreeObject());
}

function setFilter(f,el){
  currentFilter=f;
  document.querySelectorAll('.fpill:not(.side-pill)').forEach(p=>p.classList.remove('active'));
  el.classList.add('active');
  renderNodeList();
  highlightByFilter();
}

// Segunda dimensión del filtro (front/back) — combinable con el filtro de tipo:
// "Errors" + "Front" = solo los errores nacidos del frontend.
function setSide(s,el){
  currentSide=s;
  document.querySelectorAll('.side-pill').forEach(p=>p.classList.remove('active'));
  el.classList.add('active');
  renderNodeList();
  highlightByFilter();
}

function filterSearch(val){searchVal=val.toLowerCase();renderNodeList();}

// Las "Suggested Questions" no se responden con texto — se responden mostrando
// los nodos reales detrás de la pregunta: saltan al grafo, abren la lista de
// nodos y la filtran por las palabras clave de la pregunta.
function askQuestion(q){
  const gTab=document.querySelector('.mode-tab[onclick*="graph"]');
  if(gTab) setMode('graph',gTab);
  const nTab=document.querySelector('.sb-tab[onclick*="nodes"]');
  if(nTab) showSbTab('nodes',nTab);
  const STOP=new Set(['what','how','why','does','do','is','are','the','a','an','to','for','in','of','on','i','should','this','was','were','decided','permanent','rules','add','feature']);
  const term=q.toLowerCase().replace(/[?¿]/g,'').split(/\\s+/).filter(w=>w.length>2&&!STOP.has(w)).slice(0,4).join(' ');
  const box=document.getElementById('srch');
  if(box){ box.value=term; filterSearch(term); box.focus(); }
}

function getFiltered(){
  let r=NODES;
  if(currentSide==='front')r=r.filter(n=>esNodoFrontend(n));
  else if(currentSide==='back')r=r.filter(n=>!esNodoFrontend(n));
  if(currentFilter==='ALTA')r=r.filter(n=>n.confianza==='ALTA');
  else if(currentFilter==='god')r=r.filter(n=>(DEGREE_MAP[n.id]||0)>=GOD_THRESHOLD&&GOD_THRESHOLD>0);
  else if(currentFilter!=='all')r=r.filter(n=>n.tipo===currentFilter);
  if(searchVal){
    const terms=searchVal.split(/\\s+/).filter(Boolean);
    r=r.filter(n=>{
      const hay=(n.titulo+' '+n.area).toLowerCase();
      return terms.some(t=>hay.includes(t));
    });
  }
  return r;
}

function getConfTag(n){
  const deg=DEGREE_MAP[n.id]||0;
  if(deg>=GOD_THRESHOLD&&GOD_THRESHOLD>0)return '<span class="tag-ext">EXTRACTED</span>';
  if(n.confianza==='ALTA')return '<span class="tag-inf">INFERRED</span>';
  return '<span class="tag-amb">AMBIGUOUS</span>';
}

function renderNodeList(){
  const list=document.getElementById('nodes-list');
  const filtered=getFiltered();
  const tl={error:T[lang].l_err,patron:T[lang].l_pat,decision:T[lang].l_dec};
  if(!filtered.length){list.innerHTML='<div class="empty-state">📭 No nodes found</div>';return;}
  list.innerHTML=filtered.map(n=>{
    const title=escHtml(n.titulo.length>48?n.titulo.slice(0,48)+'…':n.titulo);
    const isGod=(DEGREE_MAP[n.id]||0)>=GOD_THRESHOLD&&GOD_THRESHOLD>0;
    const deg=DEGREE_MAP[n.id]||0;
    return \`<div class="nitem\${n.id===selectedNodeId?' selected':''}\${isGod?' god-node':''}" onclick="selectNode(\${n.id})" id="nitem-\${n.id}">
      <div style="display:flex;align-items:center;gap:5px;margin-bottom:4px">
        \${isGod?'<span style="color:var(--amber);font-size:10px">⚡</span>':''}
        <span class="ntb t-\${n.tipo}\${esNodoFrontend(n)?' front':''}">\${tl[n.tipo]||n.tipo}\${esNodoFrontend(n)?' · front':''}</span>
        <span style="font-size:11px;color:var(--text);flex:1;line-height:1.3">\${title}</span>
      </div>
      <div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center">
        <span class="mb c\${n.confianza}">\${n.confianza}</span>
        <span class="ab">\${n.area}</span>
        \${deg>0?'<span class="ab">'+deg+' conn</span>':''}
        \${n.aplicado>0?'<span class="ab">✓ '+n.aplicado+'x</span>':''}
        \${getConfTag(n)}
      </div>
    </div>\`;
  }).join('');
}

function selectNode(id){
  selectedNodeId=id;
  renderNodeList();
  showDetail(nodeMap[id]);
  focusNode(id);
  const el=document.getElementById('nitem-'+id);
  if(el)el.scrollIntoView({block:'nearest'});
}

function showDetail(node){
  if(!node)return;
  lastKddNode=node;
  document.getElementById('dp-title').textContent=node.titulo;
  const deg=DEGREE_MAP[node.id]||0;
  const isGod=deg>=GOD_THRESHOLD&&GOD_THRESHOLD>0;
  const rels=relMap[node.id]||[];
  const relHTML=rels.map(r=>{
    const other=r.dir==='out'?nodeMap[r.hacia_id]:nodeMap[r.desde_id];
    if(!other)return'';
    const t=escHtml(other.titulo.length>30?other.titulo.slice(0,30)+'…':other.titulo);
    const relLabel=r.dir==='out'?r.tipo:'← '+r.tipo;
    return \`<div class="rel-item" onclick="selectNode(\${other.id})"><div style="width:7px;height:7px;border-radius:50%;background:\${kddNodeColor(other)};flex-shrink:0"></div><div class="rel-name">\${t}</div><span class="rel-type-label">\${relLabel}</span></div>\`;
  }).filter(Boolean).join('');
  const cl=node.contenido?node.contenido.split('\\n').filter(l=>l.trim()&&!l.startsWith('##')&&!l.startsWith('Área')&&!l.startsWith('Confianza')&&!l.startsWith('Aplicado')&&!l.startsWith('Útil')&&!l.startsWith('Estado')).slice(0,5).join('\\n'):'';
  const confPct=node.aplicado>0?Math.min(Math.round(node.util/node.aplicado*100),100):0;
  document.getElementById('dp-body').innerHTML=\`
    <div class="dp-badges">
      \${isGod?'<span class="mb" style="background:rgba(245,158,11,.2);color:#fbbf24;border:1px solid rgba(245,158,11,.3)">⚡ divine</span>':''}
      <span class="mb t-\${node.tipo}" style="font-size:11px;padding:3px 8px">\${node.tipo}</span>
      <span class="mb c\${node.confianza}" style="font-size:11px;padding:3px 8px">\${node.confianza}</span>
      <span class="ab" style="font-size:11px;padding:3px 8px">\${escHtml(node.area)}</span>
    </div>
    <div class="dp-section">
      <div class="dp-label">Connections · Confidence tag</div>
      <div class="dp-val">\${deg} connections · \${getConfTag(node)}</div>
    </div>
    <div class="dp-section">
      <div class="dp-label">Applied / Useful</div>
      <div class="dp-val">\${node.aplicado}x applied · \${node.util}x useful</div>
      \${node.aplicado>0?'<div class="conf-progress"><div class="conf-progress-fill" style="width:'+confPct+'%;background:'+( confPct>=80?'#10b981':confPct>=50?'#f59e0b':'#ef4444')+'"></div></div>':''}
    </div>
    \${cl?'<div class="dp-section"><div class="dp-label">Details</div><div class="dp-val" style="font-size:10px;background:var(--bg3);border-radius:6px;padding:8px;white-space:pre-wrap;max-height:120px;overflow-y:auto">'+escHtml(cl)+'</div></div>':''}
    \${rels.length>0?'<div class="dp-section"><div class="dp-label">Connected nodes ('+rels.length+')</div>'+relHTML+'</div>':''}
  \`;
  document.getElementById('detail-panel').classList.add('visible');
}

function closeDetail(){
  document.getElementById('detail-panel').classList.remove('visible');
  selectedNodeId=null;
  renderNodeList();
  refreshKddColors();
  const g=active3DGraphs['gc'];
  if(g)g.controls().target.set(0,0,0); // vuelve a orbitar el grafo completo, no un nodo puntual
}

// Reasigna los mismos accessors de color (misma función, mismo objeto) —
// eso es lo que 3d-force-graph usa como disparador para recalcular colores/
// grosores de todos los nodos y links ya dibujados, sin reconstruir el grafo.
function refreshKddColors(){
  const g=active3DGraphs['gc'];
  if(!g)return;
  g.nodeColor(g.nodeColor());
  g.linkColor(g.linkColor());
  g.linkWidth(g.linkWidth());
  forceRefreshLinkMaterials(g);
}

function focusNode(id){
  refreshKddColors();
}

function highlightEdge(srcId,tgtId){
  const g=active3DGraphs['gc'];
  if(!g)return;
  const isPair=e=>{const s=edgeEndId(e.source),t=edgeEndId(e.target);return (s===srcId&&t===tgtId)||(s===tgtId&&t===srcId);};
  g.linkColor(e=>isPair(e)?'#ec4899':'#2a3050');
  g.linkWidth(e=>isPair(e)?3:1);
  g.nodeColor(d=>d.id===srcId||d.id===tgtId?'#ffffff':kddNodeColor(d));
}

function highlightByFilter(){
  const g=active3DGraphs['gc'];
  if(!g)return;
  const ids=getFiltered().map(n=>n.id);
  g.nodeColor(d=>ids.includes(d.id)?kddNodeColor(d):'rgba(100,100,110,0.15)');
  g.linkColor(e=>{
    const s=edgeEndId(e.source), t=edgeEndId(e.target);
    return ids.includes(s)&&ids.includes(t)?'#3a4060':'rgba(58,64,96,0.05)';
  });
}

function getNodeRadius(d){
  const deg=DEGREE_MAP[d.id]||0;
  const base=d.confianza==='ALTA'?13:d.confianza==='MEDIA'?10:7;
  const bonus=MAX_DEGREE>0?Math.round((deg/MAX_DEGREE)*8):0;
  return base+bonus;
}

function resetGraph(){
  closeDetail();
  currentFilter='all';
  currentSide='all';
  searchVal='';
  document.getElementById('srch').value='';
  document.querySelectorAll('.fpill:not(.side-pill)').forEach((p,i)=>p.classList.toggle('active',i===0));
  document.querySelectorAll('.side-pill').forEach((p,i)=>p.classList.toggle('active',i===0));
  renderNodeList();
  refreshKddColors();
  // En el 2D original esto ya era todo lo que hacía "Reset" (solo filtros/búsqueda)
  // — pero ahí los nodos fijados/la cámara no tenían adónde "irse", así que no se
  // notaba. En 3D si arrastraste/fijaste un nodo o moviste la cámara, "Reset" se
  // sentía roto (no pasaba nada visible). Ahora también libera nodos fijados y
  // recentra la cámara — la intención real de un botón "Reset".
  NODES.forEach(n=>{n.fx=null;n.fy=null;n.fz=null;});
  pinnedNodeIds.clear();
  const g=active3DGraphs['gc'];
  if(g){ g.d3ReheatSimulation(); robustAutoFit(g, NODES, 5); }
}

function centerGraph(){
  const g=active3DGraphs['gc'];
  if(!g)return;
  robustAutoFit(g, NODES, 5);
}

// ─── Graph interaction helpers (3D) ───────────────────────────
// El indicador visual de "nodo fijado" antes era una clase CSS sobre un
// <circle> SVG — en 3D no hay un elemento DOM por nodo (son mallas Three.js
// dentro de un <canvas>), así que se resuelve con color: un nodo fijado se
// dibuja con un tono más claro/blanqueado del mismo color.
const pinnedNodeIds=new Set();

function blendWhite(hex, amt){ return blendTowards(hex,'#ffffff',amt); }

// Mezcla un color hacia otro (ej. hacia el fondo oscuro, para "atenuar" un
// nodo que no es vecino del seleccionado — no hay opacidad por-canal en los
// materiales de esferas, así que atenuar = acercar el color al del fondo).
function blendTowards(hex, targetHex, amt){
  const c=String(hex).replace('#','');
  const t=String(targetHex).replace('#','');
  if(c.length!==6||t.length!==6)return hex;
  const mix=(a,b)=>Math.round(a+(b-a)*amt);
  const r=mix(parseInt(c.substr(0,2),16), parseInt(t.substr(0,2),16));
  const gg=mix(parseInt(c.substr(2,2),16), parseInt(t.substr(2,2),16));
  const b=mix(parseInt(c.substr(4,2),16), parseInt(t.substr(4,2),16));
  return 'rgb('+r+','+gg+','+b+')';
}

function unpinNode(id){
  const node=nodeMap[id];
  if(!node)return;
  node.fx=null; node.fy=null; node.fz=null;
  pinnedNodeIds.delete(id);
  refreshKddColors();
  const g=active3DGraphs['gc'];
  if(g)g.d3ReheatSimulation();
}

function releaseAll(){
  NODES.forEach(n=>{n.fx=null;n.fy=null;n.fz=null;});
  pinnedNodeIds.clear();
  refreshKddColors();
  const g=active3DGraphs['gc'];
  if(g)g.d3ReheatSimulation();
}

function spreadGraph(){
  const g=active3DGraphs['gc'];
  if(!g)return;
  g.d3Force('charge').strength(d=>(DEGREE_MAP[d.id]||0)>=GOD_THRESHOLD?-1200:-700);
  g.d3ReheatSimulation();
  setTimeout(()=>{
    const repVal=parseInt(document.getElementById('repulsion-slider')?.value||140);
    g.d3Force('charge').strength(d=>(DEGREE_MAP[d.id]||0)>=GOD_THRESHOLD?-(repVal*2):-(repVal));
    g.d3ReheatSimulation();
  }, 1800);
}

function setRepulsion(val){
  val=parseInt(val);
  const g=active3DGraphs['gc'];
  if(!g)return;
  g.d3Force('charge').strength(d=>(DEGREE_MAP[d.id]||0)>=GOD_THRESHOLD?-(val*2):-(val));
  g.d3ReheatSimulation();
}

// ─── Motor 3D compartido (esferas reales + orbitar) ──────────────────────────
// Reemplaza la simulación D3/SVG plana de los 3 grafos. Una sola función que
// envuelve ForceGraph3D() en vez de que cada grafo monte su propia simulación
// desde cero — cada render*() de abajo arma sus propios nodos/links (igual
// que antes) y le pasa sus propios colores/callbacks a ESTA función.
// NOTA: el 4to grafo del proyecto (Module Neural Graph, en Project Docs) NO
// pasa por aquí — sigue siendo D3/SVG puro, a propósito, no se toca.
const active3DGraphs={};
// Color único para TODAS las líneas de conexión "en reposo" (sin seleccionar
// nada) en los 3 grafos — mismo estilo en todos lados, en vez de que cada uno
// tuviera su propio color (KDD usaba un azul-gris oscuro, Combined mezclaba
// morado y verde según el tipo de relación).
const LINK_BASE_COLOR='#8b5cf6';
const LINK_BASE_RGBA='rgba(139,92,246,0.35)';
const LINK_DIMMED_RGBA='rgba(139,92,246,0.08)';

// Paleta cósmica (14/07/2026) — SOLO para Code Structure, pedido explícito:
// "implementale eso al code estructure solo a ese". KDD Memory y las líneas
// de Combined NO se tocan — siguen con LINK_BASE_RGBA de arriba. Combined sí
// hereda los colores de NODO nuevos (ver MOD_COLORS_SERVER) porque reusa
// codeNodeColor() para sus nodos de código — eso es "aplicarle los colores
// de cada grafo", no un esquema aparte.
// Punto de memoria (14/07/2026) — valores "v3" aprobados antes de subir la
// intensidad, por si el dueño no le gusta esta v4 "incandescente" y hay que
// volver: CODE_LINK_BASE_RGBA='rgba(255,255,255,0.14)',
// CODE_LINK_DIMMED_RGBA='rgba(255,255,255,0.04)', CODE_PARTICLE_COLOR='#ffe066'.
// v4→v5: 0.28 seguía leyéndose gris contra el fondo negro — una línea de 1px
// semitransparente casi nunca se ve "blanco brillante" salvo que la opacidad
// sea bastante más alta (es cómo funciona la mezcla de color, no un bug).
// Subido a 0.5 + un poco más de grosor (ver getCodeLinkWidth) para que de
// verdad se perciba incandescente, no solo gris claro.
const CODE_LINK_BASE_RGBA='rgba(255,255,255,0.5)';
const CODE_LINK_DIMMED_RGBA='rgba(255,255,255,0.18)';
const CODE_PARTICLE_COLOR='#fff200';

// Velocidad de partícula "escalonada" — pedido del dueño: con la misma
// velocidad fija para todos los links, todas las partículas salían y
// llegaban sincronizadas (se veía como si todo el grafo se moviera de golpe,
// sin pausas reales entre una y otra). Cada link recibe una velocidad
// distinta pero ESTABLE (calculada una sola vez y guardada en el propio
// objeto del link) — así se van desincronizando naturalmente con el tiempo
// en vez de recalcularse al azar en cada frame (eso sí se vería tembloroso).
function getStaggeredParticleSpeed(link){
  if(link.__particleSpeed==null) link.__particleSpeed=0.003+Math.random()*0.007;
  return link.__particleSpeed;
}

// NOTA sobre los 3 intentos de "resplandor" en partículas (descartado por
// decisión del dueño, no por falla técnica): los primeros 2 (Sprite+
// CanvasTexture, y Group con 2 Mesh) sí rompían el render de verdad —
// Group no tiene '.geometry' (el frustum culling truena leyendo
// boundingSphere de undefined) y Sprite usa una ruta de render aparte
// (WebGLSprites) que no se lleva bien con el pipeline normal de Mesh de
// esta librería. El 3er intento (un solo Mesh normal con su propia
// PlaneGeometry + textura de canvas con gradiente radial blanco, en vez de
// Group/Sprite) SÍ funcionaba sin romper nada — probado y confirmado. Se
// descartó de todos modos porque, en un grafo con cientos de líneas
// superpuestas, un halo sutil (unos pocos px) queda casi invisible contra
// el fondo denso — no era un problema técnico, era que no se justificaba
// el esfuerzo visual. Si se retoma más adelante: usar linkDirectional-
// ParticleThreeObject devolviendo un Mesh (nunca Group/Sprite),
// frustumCulled=false + depthTest=false, y para que reaccione a
// selección hay que leer el link real desde mesh.parent.__data (la
// librería clona el objeto de la fábrica por cada partícula y clone() no
// conserva propiedades personalizadas puestas directo en el mesh).
// Fuerza mínima compatible con d3-force: reemplaza el forceX/forceY(strength 0.3)
// que sí tenía el 2D original (ver renderGraph_OLD_D3_UNUSED más abajo) — sin esto,
// un nodo sin conexiones no tiene NADA que lo jale de vuelta al centro, y la
// repulsión sola lo empuja cada vez más lejos con cada tick (por eso se veían
// nodos sueltos perdidos en la nada: no era que la repulsión sobrara, era que
// faltaba por completo la fuerza que la contrarresta).
function forceRecenter(strength){
  let nodes;
  function force(alpha){
    for(const n of nodes){
      n.vx=(n.vx||0)-(n.x||0)*strength*alpha;
      n.vy=(n.vy||0)-(n.y||0)*strength*alpha;
      n.vz=(n.vz||0)-(n.z||0)*strength*alpha;
    }
  }
  force.initialize=ns=>{nodes=ns;};
  return force;
}

// ─── Feature 6 (14/07/2026): "coraza" — UI por fuera, código de atrás adentro ─
// Pedido tal cual lo describió el dueño: front es lo que ve el usuario final
// (la parte de "encima"), back es el código detrás (lo de "adentro") — un
// nodo de UI/frontend se empuja hacia un radio grande (cáscara exterior), el
// resto se empuja hacia un radio chico (núcleo). No reemplaza forceRecenter
// (que sigue atrayendo todo hacia el origen) — se suma como una fuerza extra
// que además separa por capas según a qué radio target quiere llegar cada nodo.
function forceRadialShell(strength,getTargetRadius){
  let nodes;
  function force(alpha){
    for(const n of nodes){
      const x=n.x||0,y=n.y||0,z=n.z||0;
      const r=Math.sqrt(x*x+y*y+z*z)||0.0001;
      const targetR=getTargetRadius(n);
      const factor=(targetR-r)/r*strength*alpha;
      n.vx=(n.vx||0)+x*factor;
      n.vy=(n.vy||0)+y*factor;
      n.vz=(n.vz||0)+z*factor;
    }
  }
  force.initialize=ns=>{nodes=ns;};
  return force;
}

// Clasifica un nodo (KDD o de código) como "frontend" para la coraza — misma
// idea que area-detector.cjs pero aplicada a nodos ya cargados en el navegador,
// no a texto de memoria. Nodo KDD: usa el área ya calculada (Feature 2, área
// exacta 'frontend' o compuesta como 'panel/frontend'). Nodo de código: usa
// la ruta del archivo — con perfil del proyecto (Plan 4: FRONT_DIRS inyectado
// server-side desde stack-profile) o, sin perfil, la heurística de siempre:
// public/ (la carpeta real del panel de este proyecto) o .jsx/.tsx.
const FRONT_DIRS=${JSON.stringify((__stackProfile && Array.isArray(__stackProfile.front_dirs)) ? __stackProfile.front_dirs : [])};
function esNodoFrontend(d){
  // Nodo de código: siempre tiene .file (KDD nunca lo tiene) — se clasifica
  // por ruta. Nodo KDD: se clasifica por el área ya calculada (Feature 2).
  if(d.file!==undefined){
    const f=d.file.replace(/\\\\/g,'/');
    if(FRONT_DIRS.length)return FRONT_DIRS.some(dir=>f===dir||f.startsWith(dir+'/'));
    return f.startsWith('public/')||/\\.(jsx|tsx)$/i.test(f);
  }
  return !!(d.area&&/frontend/i.test(d.area));
}

// Halo de luz alrededor de cada nodo de código (pedido explícito, paleta
// tetrádica del 15/07/2026) — sprite aditivo con gradiente radial, cacheado
// por color: con cientos de nodos pero solo ~15 colores posibles, se genera
// la textura una vez por color y se reusa, no una por nodo.
const glowTextureCache={};
function getGlowTexture(color){
  if(glowTextureCache[color])return glowTextureCache[color];
  const size=128;
  const canvas=document.createElement('canvas');
  canvas.width=canvas.height=size;
  const ctx=canvas.getContext('2d');
  const grad=ctx.createRadialGradient(size/2,size/2,0,size/2,size/2,size/2);
  grad.addColorStop(0,'rgba(255,255,255,0.85)');
  grad.addColorStop(0.35,color);
  grad.addColorStop(1,'rgba(0,0,0,0)');
  ctx.fillStyle=grad;
  ctx.fillRect(0,0,size,size);
  const tex=new THREE.CanvasTexture(canvas);
  glowTextureCache[color]=tex;
  return tex;
}
function createGlowSprite(color,nodeRadius){
  const mat=new THREE.SpriteMaterial({map:getGlowTexture(color),transparent:true,blending:THREE.AdditiveBlending,depthWrite:false});
  const sprite=new THREE.Sprite(mat);
  const s=nodeRadius*3.4;
  sprite.scale.set(s,s,1);
  return sprite;
}

function create3DGraph(containerId, opts){
  const container=document.getElementById(containerId);
  const graph=ForceGraph3D()(container)
    .backgroundColor('rgba(0,0,0,0)')
    // Bug real (el de "Combined solo muestra un nodo", la causa de fondo real
    // detrás de todo lo que se probó antes con cámara/near-far): la librería
    // usa por defecto el campo "id" de cada nodo para su propio seguimiento
    // interno (juntar cada malla 3D con su nodo de datos, resolver a qué nodo
    // apunta cada link). Combined usa "mergedId" (no "id") para evitar que
    // choquen los ids de KDD y de código — pero nunca se le avisó a la
    // librería de ese cambio, así que seguía buscando por "id" mientras TODO
    // el resto de mi código (links, clics, vecinos) usaba "mergedId". Sin
    // esa correspondencia, la librería no lograba ubicar los nodos de verdad
    // — las 379 esferas quedaban todas superpuestas en el origen (0,0,0),
    // pareciendo un solo punto. Confirmado con datos reales: getWorldPosition()
    // de cada esfera daba (0,0,0) para todas, sin excepción.
    .nodeId(opts.nodeId||'id')
    .graphData({nodes:opts.nodes, links:opts.links})
    .nodeColor(opts.nodeColor)
    .nodeVal(opts.nodeVal||(()=>4))
    .nodeLabel(opts.nodeLabel||(()=>''))
    .nodeOpacity(0.92)
    .nodeThreeObjectExtend(true) // el objeto de nodeThreeObject se AGREGA a la esfera normal, no la reemplaza
    .nodeThreeObject(opts.nodeThreeObject||(()=>null))
    .linkColor(opts.linkColor)
    .linkWidth(opts.linkWidth||(()=>1))
    .linkOpacity(0.45)
    // Animación de "impulsos neuronales" — partículas que viajan por cada
    // conexión, como el pedido del dueño. Función nativa de la librería
    // (linkDirectionalParticles), no hay que construirla desde cero. Todo
    // esto es opt-in vía opts — si un futuro caller no pasa estas opciones,
    // el comportamiento queda EXACTAMENTE igual que antes (0 partículas por
    // defecto en la librería), así que no debería romper nada existente.
    .linkDirectionalParticles(opts.linkDirectionalParticles||0)
    .linkDirectionalParticleSpeed(opts.linkDirectionalParticleSpeed||0.006)
    .linkDirectionalParticleWidth(opts.linkDirectionalParticleWidth||2)
    // Si se pasa linkDirectionalParticleThreeObject (sprite con resplandor,
    // ver makeGlowParticleObject) se usa ESE en vez del color plano — la
    // librería no tiene un modo "extend" para partículas (confirmado
    // reflexionando sobre el objeto: linkDirectionalParticleThreeObjectExtend
    // no existe en esta versión), así que pasar un objeto personalizado
    // reemplaza por completo la esferita de color por defecto.
    .linkDirectionalParticleColor(opts.linkDirectionalParticleColor||opts.linkColor)
    .onNodeClick((node,ev)=>{ if(graph.__idleState)graph.__idleState.last=performance.now(); if(opts.onNodeClick) opts.onNodeClick(node,ev); })
    .onBackgroundClick(()=>{ if(graph.__idleState)graph.__idleState.last=performance.now(); if(opts.onBackgroundClick) opts.onBackgroundClick(); })
    .enableNodeDrag(true)
    .width(container.clientWidth||800)
    .height(container.clientHeight||600);
  // Nota: v1.80.0 no tiene un método .controlType() — el control de cámara
  // por defecto de esta librería YA es "orbitar con clic-arrastre" (se
  // verifica más abajo con datos reales, no se asume).
  if(opts.onNodeDragEnd) graph.onNodeDragEnd(opts.onNodeDragEnd);
  if(opts.linkDirectionalParticleThreeObject) graph.linkDirectionalParticleThreeObject(opts.linkDirectionalParticleThreeObject);
  if(opts.chargeStrength) graph.d3Force('charge').strength(opts.chargeStrength);
  if(opts.linkDistance) graph.d3Force('link').distance(opts.linkDistance);
  if(opts.centerStrength) graph.d3Force('recenter', forceRecenter(opts.centerStrength));
  if(opts.radialShellGetRadius) graph.d3Force('radialShell', forceRadialShell(opts.radialShellStrength||0.12, opts.radialShellGetRadius));
  // Bug real encontrado probando: los controles de cámara (TrackballControls)
  // cachean el tamaño de pantalla en el momento en que se crean — si en ese
  // instante el <canvas> todavía tenía su tamaño por defecto (300x150), orbitar
  // queda con las coordenadas de arrastre completamente desalineadas. Forzar
  // el recálculo después de fijar el tamaño real del contenedor lo corrige.
  if(graph.controls&&graph.controls().handleResize)graph.controls().handleResize();
  // La cámara arranca a una distancia FIJA por defecto (~767) sin importar el
  // tamaño real del grafo — si el grafo es compacto (pocos nodos, poca
  // repulsión) la cámara queda absurdamente lejos y todo se ve como puntitos
  // perdidos en un lienzo vacío (no es que los nodos estén dispersos de
  // verdad: es que la cámara nunca se acercó a donde están). Se encuadra
  // automáticamente, apenas la simulación asienta por primera vez.
  // Bug real encontrado probando con Combined (379 nodos): con UNA sola pasada
  // a los 1200ms, un grafo grande todavía no terminó de asentar — algún nodo
  // suelto puede estar temporalmente muy lejos (la fuerza de recentrado aún no
  // lo alcanzó), y como fitCameraToNodes usa el nodo MÁS lejano para calcular
  // el radio, ese único nodo transitorio dispara una distancia de cámara
  // gigante — resultado: solo se ve un puntito en medio de la nada. La misma
  // cámara "demasiado cerca al inicio" pasaba en grafos chicos (KDD/Code):
  // se hacía el encuadre antes de que los nodos terminaran de repelerse y
  // separarse del todo, así que después seguían creciendo y la cámara quedaba
  // corta (nodos gigantes/superpuestos). Ahora se reencuadra cada 1s (hasta 8
  // intentos = 8s) y se PARA solo cuando dos pasadas seguidas dan casi la
  // misma distancia (< 3% de diferencia) — eso SÍ prueba que ya asentó.
  //
  // SEGUNDO bug real, más grave, encontrado después: el auto-encuadre y el
  // auto-orbitar (más abajo) SE PISABAN entre sí. El auto-encuadre detectaba
  // "¿el usuario ya tocó la cámara?" comparando si camera.position cambió
  // desde su última pasada — pero el auto-orbitar TAMBIÉN mueve
  // camera.position (a propósito, para girar solo) sin que el usuario haga
  // nada. Resultado: si el auto-orbitar arrancaba (5s de "inactividad", que
  // en realidad solo significa "nadie tocó nada", no que el encuadre ya
  // terminó) ANTES de que el auto-encuadre completara sus 8 intentos, el
  // encuadre creía "ah, el usuario ya la movió, no le piso el gesto" y se
  // rendía a mitad de camino — dejando la cámara en una posición sin asentar
  // de verdad (el bug real de "Combined solo muestra un nodo"). Ahora los dos
  // sistemas comparten UNA sola señal real de "el usuario tocó la cámara"
  // (el evento 'start' de TrackballControls, que solo se dispara con
  // interacción real de mouse/touch) en vez de comparar posiciones — el
  // auto-orbitar mover la cámara ya NO se confunde con un gesto del usuario.
  const ctrl=graph.controls();
  graph.__userTouchedCamera=false;
  if(ctrl&&ctrl.addEventListener)ctrl.addEventListener('start',()=>{ graph.__userTouchedCamera=true; });
  // Bug real reportado por el dueño: al hacer zoom a mano (scroll) en KDD
  // Memory y Combined, los nodos aparecían/desaparecían según se acercara o
  // alejara — verificado con datos reales: near/far se calculaba UNA sola
  // vez al encuadrar (una ventana fija alrededor de esa distancia exacta),
  // pero el zoom del usuario mueve la cámara LEJOS de esa ventana sin volver
  // a calcularla — zoom out saca a TODOS los nodos más allá del far plane
  // (invisibles), zoom in los mete todos más cerca que el near plane (también
  // invisibles). El arreglo: recalcular near/far en cada evento 'change' de
  // los controles (se dispara con cualquier zoom/rotar/pan real), usando la
  // distancia ACTUAL de la cámara — así la ventana de profundidad sigue al
  // zoom en vez de quedarse fija en el valor del último encuadre.
  if(ctrl&&ctrl.addEventListener)ctrl.addEventListener('change',()=>{
    if(graph.__nodeSpreadRadius==null)return;
    const cam=graph.camera();
    const dist=cam.position.distanceTo(ctrl.target);
    const spread=graph.__nodeSpreadRadius;
    // mismo mínimo proporcional que en fitCameraToNodes — cubre nodos sueltos
    // que se hayan alejado más de lo que medía el spread cacheado
    cam.near=Math.max(Math.min(dist-spread, dist*0.1), 0.5);
    cam.far=Math.max(dist+spread, dist*3);
    cam.updateProjectionMatrix();
  });
  if(opts.autoFit!==false)robustAutoFit(graph, opts.nodes, 5);
  // Auto-orbitar tras inactividad: si nadie toca el grafo por 5s, la cámara
  // empieza a girar sola despacio alrededor del centro — se detiene apenas
  // el usuario interactúa de nuevo (clic/arrastre/scroll real, vía el mismo
  // evento 'start' de arriba) o al pausar la pestaña.
  // Verificado con datos reales: mover camera.position a mano y llamar
  // controls().update() NO lo revierte (TrackballControls no pisa la
  // posición manual en su próximo update — solo la usa para pan/zoom/rotar
  // cuando el usuario mueve el mouse), así que es seguro rotar así.
  const idle={last:performance.now(), rafId:null, active:true};
  if(ctrl&&ctrl.addEventListener)ctrl.addEventListener('start',()=>{idle.last=performance.now();});
  graph.__idleState=idle;
  startIdleOrbit(graph);
  active3DGraphs[containerId]=graph;
  return graph;
}
// Un solo tick de rotación, reusado tanto al crear el grafo como al
// reanudarlo desde pausa — evita mantener la misma lógica en dos lugares.
function startIdleOrbit(graph){
  const idle=graph.__idleState;
  function tick(){
    idle.rafId=requestAnimationFrame(tick);
    if(!idle.active)return;
    if(performance.now()-idle.last<5000)return;
    const cam=graph.camera();
    const target=graph.controls().target;
    const a=0.0015; // radianes por frame — giro lento y discreto
    const dx=cam.position.x-target.x, dz=cam.position.z-target.z;
    const cosA=Math.cos(a), sinA=Math.sin(a);
    cam.position.x=target.x+dx*cosA-dz*sinA;
    cam.position.z=target.z+dx*sinA+dz*cosA;
    cam.lookAt(target);
  }
  tick();
}

// Bug real encontrado probando el resaltado amarillo en KDD Memory: reasignar
// el mismo accessor (el patrón g.linkColor(g.linkColor()) que SÍ funciona
// para nodeColor) NO actualiza el color de los links — se verificó con datos
// reales que el material seguía en el color de siempre (#2a3050) aunque el
// accessor devolviera correctamente "#facc15" al llamarlo a mano. La causa:
// nuestros links siempre usan linkWidth (para poder engrosar el
// seleccionado), así que la librería los dibuja como mallas 3D
// (CylinderGeometry) en vez de líneas simples — y ese modo de render no
// reacciona a reasignar el accessor, solo lo usa una vez al crear la malla.
// Cada malla de link SÍ guarda una referencia a su dato real en
// __data/__graphObjType (confirmado explorando el objeto en el
// navegador) — así que se actualiza el material A MANO, recorriendo la
// escena directamente, en vez de confiar en la reactividad rota.
function forceRefreshLinkMaterials(graph){
  if(!graph)return;
  const colorFn=graph.linkColor();
  graph.scene().traverse(obj=>{
    if(obj.__graphObjType==='link' && obj.__data && obj.material && obj.material.color){
      const c=colorFn(obj.__data);
      if(typeof c!=='string')return;
      obj.material.color.set(c); // THREE ya parsea bien hex y rgba() — se comprobó con datos reales
      const alphaMatch=c.match(/rgba\\([\\d.]+,\\s*[\\d.]+,\\s*[\\d.]+,\\s*([\\d.]+)\\)/i);
      obj.material.opacity=alphaMatch?parseFloat(alphaMatch[1]):1;
      obj.material.transparent=true;
      obj.material.needsUpdate=true;
    }
  });
  // Bug real encontrado probando Combined (1028 links, muchos más que los 520
  // de KDD): la PRIMERA llamada justo después de seleccionar un nodo no
  // alcanzaba a actualizar todos los materiales — probablemente la librería
  // todavía está terminando de crear/instanciar las mallas de los links en
  // un grafo tan grande. Una segunda pasada 80ms después sí los agarraba
  // todos. Se repite acá adentro para que TODOS los llamadores (focusNode,
  // focusCodeNode, focusCombinedNode) queden cubiertos sin tener que
  // acordarse de hacerlo en cada uno.
  setTimeout(()=>{
    graph.scene().traverse(obj=>{
      if(obj.__graphObjType==='link' && obj.__data && obj.material && obj.material.color){
        const c=colorFn(obj.__data);
        if(typeof c!=='string')return;
        obj.material.color.set(c);
        const alphaMatch=c.match(/rgba\\([\\d.]+,\\s*[\\d.]+,\\s*[\\d.]+,\\s*([\\d.]+)\\)/i);
        obj.material.opacity=alphaMatch?parseFloat(alphaMatch[1]):1;
        obj.material.transparent=true;
        obj.material.needsUpdate=true;
      }
    });
  }, 80);
}
function pause3DGraph(containerId){
  const g=active3DGraphs[containerId];
  if(!g)return;
  if(g.pauseAnimation)g.pauseAnimation();
  if(g.__idleState){ g.__idleState.active=false; if(g.__idleState.rafId)cancelAnimationFrame(g.__idleState.rafId); }
}
function resume3DGraph(containerId){
  const g=active3DGraphs[containerId];
  if(!g)return;
  if(g.resumeAnimation)g.resumeAnimation();
  if(g.__idleState&&!g.__idleState.active){
    g.__idleState.active=true;
    g.__idleState.last=performance.now(); // no orbitar de inmediato al volver a la pestaña
    startIdleOrbit(g);
  }
}

// Bug real encontrado probando Code Structure (287 nodos, solo 46 links —
// muy disperso, casi todos los nodos terminan a distancia parecida del
// centro, como una "cáscara esférica" en vez de un cluster denso): en ese
// caso zoomToFit() calculaba una distancia de cámara mucho más CHICA que el
// radio real (dio 22.7 con nodos a ~65 de distancia) — se probó de nuevo con
// la simulación ya asentada y dio el mismo número mal, así que no era un
// tema de timing. Se calibró primero contra el valor de KDD Memory que se
// veía bien (37.2, confirmado por el dueño): radio máximo/tan(fov) daba 37.7,
// muy cercano — pero esa calibración resultó ser engañosa. Al medir de
// verdad cuántos nodos de Combined (379, más disperso) caían DENTRO del
// cuadro de la cámara con esa fórmula (proyectando cada nodo con
// camera.project() y contando cuántos caen en el rango visible), solo el 38%
// entraba — la fórmula "se veía bien" en KDD solo porque es denso (la
// mayoría cerca del centro, los pocos sueltos afuera no se notaban), no
// porque encuadrara todo de verdad. Ahora se calcula por eje (X e Y por
// separado, cada uno con su propio FOV — vertical para Y, derivado del
// aspect para X) usando un percentil (no el máximo ni una constante mágica)
// y se toma la distancia más exigente de los dos ejes — esto sí se verificó
// que mete la gran mayoría de los nodos reales dentro de cuadro, en los 3
// grafos, no solo en el que se usó para calibrar.
function fitCameraToNodes(graph, nodes, padding, percentile){
  if(!nodes||!nodes.length)return;
  const p=percentile||0.92;
  const cx=nodes.reduce((s,n)=>s+(n.x||0),0)/nodes.length;
  const cy=nodes.reduce((s,n)=>s+(n.y||0),0)/nodes.length;
  const cz=nodes.reduce((s,n)=>s+(n.z||0),0)/nodes.length;
  const cam=graph.camera();
  const vFovRad=(cam.fov||50)*Math.PI/180;
  const aspect=cam.aspect||1;
  const hFovRad=2*Math.atan(Math.tan(vFovRad/2)*aspect);
  const pctVal=(arr)=>{ const s=arr.slice().sort((a,b)=>a-b); return Math.max(s[Math.floor(s.length*p)]||0, 5); };
  const targetY=pctVal(nodes.map(n=>Math.abs((n.y||0)-cy)));
  const targetX=pctVal(nodes.map(n=>Math.abs((n.x||0)-cx)));
  const distForY=targetY/Math.tan(vFovRad/2);
  const distForX=targetX/Math.tan(hFovRad/2);
  const dist=Math.max(distForY,distForX)+(padding||0);
  cam.position.set(cx,cy,cz+dist);
  cam.lookAt(cx,cy,cz);
  graph.controls().target.set(cx,cy,cz);
  // El bug REAL de "Combined solo muestra un nodo" (el que de verdad importaba
  // — todo lo anterior en esta función solo mueve la cámara, esto es lo que
  // arregla lo que se ve): la librería deja el far plane por defecto en
  // 125000 con near en 0.1 — una proporción de 1.25 MILLONES a 1. Verificado
  // con datos reales: a la distancia de cámara real (~156 en Combined), TODOS
  // los nodos proyectaban a z≈0.999 en el buffer de profundidad (comprobado
  // con matrixWorldInverse, no con .project() que puede engañar) — el GPU ya
  // no tiene precisión para distinguir cuál esfera está más cerca en cada
  // píxel, así que el z-test se vuelve casi aleatorio y solo UNA esfera "gana"
  // en casi toda la pantalla. Esto explica por qué mis chequeos de posición/
  // proyección (NDC x,y) siempre daban bien (~90%) pero el render real
  // mostraba un solo punto: esos chequeos nunca miraban la precisión real del
  // depth buffer. El arreglo: acotar near/far al rango real de profundidad de
  // ESTE grafo específico cada vez que se encuadra, en vez de dejar el default
  // gigante de la librería.
  const maxDist3D=Math.max(...nodes.map(n=>Math.sqrt((n.x-cx)**2+(n.y-cy)**2+(n.z-cz)**2)), 5);
  // Segundo bug real, encontrado DESPUÉS de este primero: nodos sueltos
  // pueden seguir alejándose con el tiempo (la fuerza de recentrado no es
  // perfecta para todos) — verificado con datos reales: minutos después de
  // este cálculo, algunos nodos ya estaban a 140-159 unidades del centro
  // aunque maxDist3D solo había medido 59.9 en ESE momento. Un near/far
  // calculado una sola vez y nunca vuelto a ajustar (salvo por zoom, ver el
  // listener 'change') se quedaba corto para esos casos — resultado: esos
  // nodos sueltos aparecían y desaparecían según el zoom. Por eso ahora,
  // ADEMÁS de acotar al spread real medido, se exige un mínimo proporcional
  // a la distancia actual de cámara (far ≥ 3× la distancia) — así siempre
  // hay margen de sobra sin importar cuánto se haya movido algún nodo suelto
  // desde el último encuadre, y la proporción far/near se mantiene chica
  // (≤30:1) para no repetir el problema original de precisión del buffer.
  cam.near=Math.max(Math.min(dist-maxDist3D-(padding||0)-10, dist*0.1), 0.5);
  cam.far=Math.max(dist+maxDist3D+(padding||0)+10, dist*3);
  cam.updateProjectionMatrix();
  // Se guarda para que el listener de 'change' en create3DGraph pueda seguir
  // ajustando near/far en vivo mientras el usuario hace zoom a mano (ver bug
  // real más abajo, en create3DGraph) sin tener que recalcular el radio del
  // grafo en cada evento — solo la distancia actual de la cámara cambia.
  graph.__nodeSpreadRadius=maxDist3D+(padding||0)+10;
}

// Reencuadra en repetición (cada 1s, hasta 8 intentos) en vez de una sola vez
// a un tiempo fijo — bug real: con un solo intento a los 1200ms, un grafo
// grande (Combined, 379 nodos) todavía no había terminado de asentar, y un
// nodo suelto transitorio (la fuerza de recentrado aún no lo alcanzaba)
// disparaba una distancia de cámara gigante — resultado: se veía un solo
// puntito en la nada. Se para de reencuadrar solo cuando dos pasadas seguidas
// dan casi la misma distancia (< 3% de diferencia, prueba real de que ya
// asentó) o si el usuario YA TOCÓ la cámara con el mouse de verdad
// (graph.__userTouchedCamera, marcado por el evento 'start' de
// TrackballControls en create3DGraph — NO por comparar si camera.position
// cambió, que es como se hacía antes y causaba el bug real de "Combined solo
// muestra un nodo": el auto-orbitar (abajo) TAMBIÉN mueve camera.position sin
// que el usuario haga nada, y esa versión anterior confundía ese movimiento
// automático con un gesto real, rindiéndose a mitad de camino).
function robustAutoFit(graph, nodes, padding){
  // Se reinicia acá, no solo en create3DGraph: si el usuario ya arrastró la
  // cámara antes pero ahora hace clic en "Reset"/"Center" a propósito, ESE
  // clic debe forzar el reencuadre completo de nuevo — si no, la marca vieja
  // de "el usuario ya la tocó" dejaría el botón sin efecto para siempre.
  graph.__userTouchedCamera=false;
  let lastDist=null, attempts=0;
  const maxAttempts=8;
  const tryFit=()=>{
    attempts++;
    if(graph.__userTouchedCamera)return; // el usuario ya agarró la cámara de verdad — no se le pisa el gesto
    fitCameraToNodes(graph, nodes, padding);
    const cam=graph.camera();
    const newDist=Math.sqrt(cam.position.x**2+cam.position.y**2+cam.position.z**2);
    const stable=lastDist!==null && Math.abs(newDist-lastDist)/Math.max(newDist,1)<0.03;
    lastDist=newDist;
    if(!stable && attempts<maxAttempts) setTimeout(tryFit, 1000);
  };
  setTimeout(tryFit, 1000);
}

// ─── Knowledge Graph — 3D real (esferas + orbitar) ───────────────────────────
// Vecinos directos de un nodo (para el resaltado amarillo + atenuar el resto)
function kddNeighborIds(id){
  const rels=relMap[id]||[];
  const s=new Set();
  rels.forEach(r=>s.add(r.dir==='out'?r.hacia_id:r.desde_id));
  return s;
}

function renderGraph(){
  if(!NODES.length)return;
  const links=EDGES.map(e=>({...e,source:e.desde_id,target:e.hacia_id})).filter(e=>nodeMap[e.source]&&nodeMap[e.target]);
  // Definidas aparte (no solo dentro de linkColor/linkWidth) para que la
  // partícula de cada conexión pueda usar EXACTAMENTE el mismo color/ancho
  // que su línea, sin duplicar la lógica — pedido del dueño.
  const getKddLinkColor=e=>{
    const s=edgeEndId(e.source), t=edgeEndId(e.target);
    if(selectedNodeId&&(s===selectedNodeId||t===selectedNodeId))return '#facc15';
    return selectedNodeId ? LINK_DIMMED_RGBA : LINK_BASE_RGBA;
  };
  const getKddLinkWidth=e=>{
    const s=edgeEndId(e.source), t=edgeEndId(e.target);
    return selectedNodeId&&(s===selectedNodeId||t===selectedNodeId)?1.2:0.4;
  };

  const graph=create3DGraph('gc',{
    nodes:NODES,
    links,
    nodeColor:d=>{
      const base=kddNodeColor(d);
      if(d.id===selectedNodeId)return '#ffffff';
      if(selectedNodeId){
        // hay un nodo seleccionado: solo sus vecinos directos quedan a color
        // completo, el resto se atenúa de verdad (mezclado hacia el fondo)
        return kddNeighborIds(selectedNodeId).has(d.id) ? base : blendTowards(base,'#0a0d14',0.75);
      }
      if(pinnedNodeIds.has(d.id))return blendWhite(base,0.4);
      return base;
    },
    nodeVal:d=>Math.pow(getNodeRadius(d)/6,3),
    nodeLabel:d=>{
      const deg=DEGREE_MAP[d.id]||0;
      const isGod=deg>=GOD_THRESHOLD&&GOD_THRESHOLD>0;
      return '<div style="background:rgba(17,21,32,.95);border:1px solid #2a3050;border-radius:6px;padding:6px 9px;font-family:sans-serif;max-width:220px">'
        +'<strong style="color:#e2e8f0">'+(isGod?'⚡ ':'')+escHtml(d.titulo.slice(0,50))+(d.titulo.length>50?'…':'')+'</strong><br>'
        +'<span style="color:#64748b;font-size:10px">'+d.tipo+' · '+escHtml(d.area)+' · '+d.confianza+' · '+deg+' connections</span></div>';
    },
    // Etiqueta 3D real (sprite de texto, siempre mirando a cámara) — solo para
    // ALTA confianza / divinos, igual que el 2D original. Solo si labelsVisible
    // está prendido (botón "Labels"); si no, no se crea ningún objeto extra.
    nodeThreeObject:d=>{
      if(!labelsVisible)return null;
      const deg=DEGREE_MAP[d.id]||0;
      const isGod=deg>=GOD_THRESHOLD&&GOD_THRESHOLD>0;
      if(!(d.confianza==='ALTA'||isGod))return null;
      const txt=(isGod?'⚡ ':'')+d.titulo.slice(0,34)+(d.titulo.length>34?'…':'');
      const sprite=new SpriteText(txt);
      sprite.color=isGod?'#f59e0b':'#e2e8f0';
      sprite.backgroundColor=false; // sin caja de fondo — solo el texto flotando
      sprite.padding=1;
      // Bug real encontrado probando: sprite.textHeight NO produce el tamaño real
      // en mundo que promete — salía ~6 unidades (una caja de ~39 de ancho, más
      // grande que 3 nodos juntos) en vez de las 2 configuradas. En vez de confiar
      // en ese cálculo interno, se fuerza el tamaño real después de crear el
      // sprite, usando solo su relación de aspecto (ancho/alto, que sí es
      // confiable) para no depender de esa cuenta rota.
      const desiredH=isGod?1.6:1.2;
      const aspect=(sprite.scale.y>0?sprite.scale.x/sprite.scale.y:6);
      sprite.scale.set(desiredH*aspect, desiredH, 1);
      sprite.position.y=getNodeRadius(d)*0.7+desiredH+1.5; // flota arriba de la esfera, no encima
      // Segundo bug real: aunque backgroundColor=false y el material queda
      // transparent=true, la textura seguía viéndose como un rectángulo negro
      // sólido — la combinación transparent+depthWrite (true por defecto en
      // Three.js) hace que las zonas "transparentes" de la textura terminen
      // pintando su color de relleno (negro) en vez de dejar ver lo que hay
      // detrás. depthWrite=false es el arreglo estándar para texturas
      // transparentes en sprites.
      sprite.material.depthWrite=false;
      return sprite;
    },
    linkColor:getKddLinkColor,
    linkWidth:getKddLinkWidth,
    // Impulsos que viajan por cada conexión — mismo color que su línea,
    // apenas un poco más gruesos, y velocidad escalonada para que no
    // salgan todas sincronizadas.
    linkDirectionalParticles:1,
    linkDirectionalParticleSpeed:getStaggeredParticleSpeed,
    linkDirectionalParticleWidth:e=>getKddLinkWidth(e)+0.1,
    linkDirectionalParticleColor:getKddLinkColor,
    // Menos repulsión y links más cortos que el primer intento — el mismo
    // grafo en 3D tiene un eje extra (Z) para dispersarse, así que con la
    // misma fuerza que en 2D queda mucho más disperso de lo que se veía antes.
    chargeStrength:d=>(DEGREE_MAP[d.id]||0)>=GOD_THRESHOLD?-260:-140,
    linkDistance:d=>{
      const sd=DEGREE_MAP[edgeEndId(d.source)]||0, td=DEGREE_MAP[edgeEndId(d.target)]||0;
      return sd>=GOD_THRESHOLD||td>=GOD_THRESHOLD?55:38;
    },
    // Mismo valor (0.3) que usaba el 2D original en forceX/forceY — jala a TODO
    // nodo de vuelta al centro sin importar si tiene conexiones o no.
    centerStrength:0.3,
    onNodeClick:(node)=>{
      selectNode(node.id);
      const g=active3DGraphs['gc'];
      if(g)g.controls().target.set(node.x,node.y,node.z);
    },
    onBackgroundClick:()=>{
      closeDetail();
      const g=active3DGraphs['gc'];
      if(g)g.controls().target.set(0,0,0);
    },
    onNodeDragEnd:(node)=>{
      node.fx=node.x; node.fy=node.y; node.fz=node.z;
      pinnedNodeIds.add(node.id);
      refreshKddColors();
    },
  });
  graph.d3Force('center', null); // se reemplaza por 'recenter' (arriba) que sí actúa continuamente por eje
}

// ─── D3 Code Structure Graph (nativo) ─────────────────────────────────────────
let codeSelectedId=null;
// Filtro de módulos por chips — mismo comportamiento que los chips de KDD
// Memory (empieza en "Todos", tocar un módulo deja SOLO ese activo) con una
// variante pedida explícitamente: una vez que tocaste un módulo específico,
// podés sumar otros sin apagar los ya activos (en KDD, tocar otro chip
// apaga el anterior — acá no). null = modo "Todos" (se ve todo); un Set =
// modo específico (solo se ven los módulos del set).
let codeActiveModules=null;

function codeModuleVisible(mod){
  return codeActiveModules===null || codeActiveModules.has(mod);
}
function renderCodeModuleChips(){
  const allChip=document.querySelector('.code-mod-chip-all');
  if(allChip) allChip.classList.toggle('active',codeActiveModules===null);
  document.querySelectorAll('.code-mod-chip').forEach(chip=>{
    chip.classList.toggle('active',codeActiveModules!==null && codeActiveModules.has(chip.dataset.mod));
  });
}
function toggleCodeModuleChip(mod){
  if(codeActiveModules===null){
    // Primer clic en un módulo específico rompe "Todos" — igual que KDD,
    // deja SOLO ese módulo activo.
    codeActiveModules=new Set([mod]);
  } else if(codeActiveModules.has(mod)){
    codeActiveModules.delete(mod);
    if(codeActiveModules.size===0) codeActiveModules=null; // sin nada activo → vuelve a "Todos"
  } else {
    // La variante sobre KDD: sumar otro módulo sin apagar el que ya estaba activo.
    codeActiveModules.add(mod);
  }
  renderCodeModuleChips();
  refreshCodeColors();
}
function setCodeModulesAll(){
  codeActiveModules=null;
  renderCodeModuleChips();
  refreshCodeColors();
}

function getCodeNodeRadius(d){
  const base=d.tipo==='clase'?11:7;
  const bonus=Math.round((d.pagerank||0)*400);
  return Math.min(base+bonus,22);
}

// Vecinos directos de un archivo/clase (para el mismo resaltado amarillo +
// atenuado que ya se probó en KDD Memory — mismo patrón, mismo helper genérico
// edgeEndId ya definido más abajo en el archivo).
function codeNeighborIds(id){
  const s=new Set();
  CODE_EDGES.forEach(e=>{
    const src=edgeEndId(e.source), tgt=edgeEndId(e.target);
    if(src===id)s.add(tgt);
    if(tgt===id)s.add(src);
  });
  return s;
}

function refreshCodeColors(){
  const g=active3DGraphs['code-gc'];
  if(!g)return;
  g.nodeColor(g.nodeColor());
  g.linkColor(g.linkColor());
  g.linkWidth(g.linkWidth());
  forceRefreshLinkMaterials(g);
}

function renderCodeGraph(){
  if(!CODE_NODES.length)return;
  // endpoint≈ (front llama a una ruta que el back registra) también aplica
  // acá — no hace falta ningún nodo KDD, front y back son los dos "código".
  // buildEndpointHeuristicLinks() ya devuelve {source,target} como ids
  // crudos de CODE_NODES, iguales a los de CODE_EDGES — se puede mezclar
  // directo, sin remapear nada.
  const links=[...CODE_EDGES,...buildEndpointHeuristicLinks()].filter(e=>codeNodeMap[e.source]&&codeNodeMap[e.target]);
  const codeLinkHiddenByFilter=e=>{
    const s=edgeEndId(e.source), t=edgeEndId(e.target);
    const sn=codeNodeMap[s], tn=codeNodeMap[t];
    return (sn&&!codeModuleVisible(sn.modulo)) || (tn&&!codeModuleVisible(tn.modulo));
  };
  const CODE_ENDPOINT_MATCH_COLOR='#22d3ee';
  // USES_CLASS (Plan 2): vista→CSS por clase usada — rosa, para distinguir la
  // capa de estilos de los imports/calls (blanco) y del endpoint≈ (cyan).
  const CODE_USES_CLASS_COLOR='rgba(236,72,153,0.55)';
  const getCodeLinkColor=e=>{
    if(codeLinkHiddenByFilter(e))return 'rgba(60,60,70,0.02)';
    const s=edgeEndId(e.source), t=edgeEndId(e.target);
    if(codeSelectedId&&(s===codeSelectedId||t===codeSelectedId))return '#facc15';
    if(e.tipo==='endpoint_match')return CODE_ENDPOINT_MATCH_COLOR;
    if(e.tipo==='USES_CLASS')return codeSelectedId ? 'rgba(236,72,153,0.08)' : CODE_USES_CLASS_COLOR;
    return codeSelectedId ? CODE_LINK_DIMMED_RGBA : CODE_LINK_BASE_RGBA;
  };
  const getCodeLinkWidth=e=>{
    if(codeLinkHiddenByFilter(e))return 0;
    const s=edgeEndId(e.source), t=edgeEndId(e.target);
    if(codeSelectedId&&(s===codeSelectedId||t===codeSelectedId))return 1.2;
    if(e.tipo==='endpoint_match')return 0.9;
    if(e.tipo==='USES_CLASS')return 0.4;
    return 0.6;
  };

  const graph=create3DGraph('code-gc',{
    nodes:CODE_NODES,
    links,
    nodeColor:d=>{
      if(!codeModuleVisible(d.modulo))return 'rgba(60,60,70,0.05)';
      const base=codeNodeColor(d);
      if(d.id===codeSelectedId)return '#ffffff';
      if(codeSelectedId){
        return codeNeighborIds(codeSelectedId).has(d.id) ? base : blendTowards(base,'#0a0d14',0.75);
      }
      return base;
    },
    nodeVal:d=>Math.pow(getCodeNodeRadius(d)/6,3),
    nodeThreeObject:d=>{
      if(!codeModuleVisible(d.modulo))return null;
      return createGlowSprite(codeNodeColor(d),getCodeNodeRadius(d));
    },
    nodeLabel:d=>{
      return '<div style="background:rgba(17,21,32,.95);border:1px solid #2a3050;border-radius:6px;padding:6px 9px;font-family:sans-serif;max-width:220px">'
        +'<strong style="color:#e2e8f0">'+escHtml(d.titulo||d.file||'')+'</strong><br>'
        +'<span style="color:#64748b;font-size:10px">'+d.functions+' funciones · '+d.symbol_count+' símbolos</span></div>';
    },
    linkColor:getCodeLinkColor,
    linkWidth:getCodeLinkWidth,
    // Impulsos que viajan por cada conexión — mismo efecto que en KDD Memory.
    linkDirectionalParticles:1,
    linkDirectionalParticleSpeed:getStaggeredParticleSpeed,
    linkDirectionalParticleWidth:e=>getCodeLinkWidth(e)+0.1,
    linkDirectionalParticleColor:e=>codeLinkHiddenByFilter(e)?'rgba(60,60,70,0.02)':(e.tipo==='endpoint_match'?CODE_ENDPOINT_MATCH_COLOR:CODE_PARTICLE_COLOR),
    // Mismos valores ya probados en KDD Memory (charge/distance/centro) —
    // 287 nodos, densidad similar, arranca del mismo punto ya calibrado.
    chargeStrength:()=>-140,
    linkDistance:()=>45,
    // Ver nota igual en renderCombinedGraph: 0.3 ahogaba la fuerza de coraza.
    centerStrength:0.08,
    radialShellGetRadius:d=>esNodoFrontend(d)?220:60,
    onNodeClick:(node)=>{
      showCodeDetail(node);
      const g=active3DGraphs['code-gc'];
      if(g)g.controls().target.set(node.x,node.y,node.z);
    },
    onBackgroundClick:()=>{
      closeCodeDetail();
      const g=active3DGraphs['code-gc'];
      if(g)g.controls().target.set(0,0,0);
    },
    onNodeDragEnd:(node)=>{
      node.fx=node.x; node.fy=node.y; node.fz=node.z;
    },
  });
}

function edgeEndId(v){return (v&&typeof v==='object')?v.id:v;}
// Variante para Combined: sus links usan mergedId (namespaced kdd-N/code-N)
// como identidad real, no el "id" crudo — ver el nodeId('mergedId') que se
// le pasa a create3DGraph en renderCombinedGraph.
function mergedEdgeEndId(v){return (v&&typeof v==='object')?v.mergedId:v;}
function showCodeDetail(node){
  lastCodeNode=node;
  document.getElementById('code-dp-title').textContent=node.file;
  const outEdges=CODE_EDGES.filter(e=>edgeEndId(e.source)===node.id);
  const inEdges=CODE_EDGES.filter(e=>edgeEndId(e.target)===node.id);
  const relList=(edges,dir)=>edges.slice(0,10).map(e=>{
    const otherId=dir==='out'?edgeEndId(e.target):edgeEndId(e.source);
    const other=codeNodeMap[otherId];
    if(!other)return'';
    const name=other.file.split(/[\\/]/).pop();
    return \`<div class="rel-item" onclick="focusCodeNode('\${otherId}')"><div style="width:7px;height:7px;border-radius:50%;background:\${codeNodeColor(other)};flex-shrink:0"></div><div class="rel-name">\${escHtml(name)}</div><span class="rel-type-label">\${e.tipo}</span></div>\`;
  }).filter(Boolean).join('');
  const rankNote=node.pagerank>0.01?'archivo central — muchas cosas dependen de él':node.pagerank>0.002?'conectividad media':'archivo periférico';
  document.getElementById('code-dp-body').innerHTML=\`
    <div class="dp-badges">
      <span class="mb" style="font-size:11px;padding:3px 8px;background:rgba(0,229,255,.15);color:#00e5ff;border:1px solid rgba(0,229,255,.3)">\${escHtml(node.tipo)}</span>
    </div>
    <div class="dp-section">
      <div class="dp-label">Funciones / Símbolos</div>
      <div class="dp-val">\${node.functions} funciones · \${node.symbol_count} símbolos totales</div>
    </div>
    <div class="dp-section">
      <div class="dp-label">PageRank</div>
      <div class="dp-val">\${(node.pagerank||0).toFixed(4)} — \${rankNote}</div>
    </div>
    \${outEdges.length?'<div class="dp-section"><div class="dp-label">Importa / llama a ('+outEdges.length+')</div>'+relList(outEdges,'out')+'</div>':''}
    \${inEdges.length?'<div class="dp-section"><div class="dp-label">Usado por ('+inEdges.length+')</div>'+relList(inEdges,'in')+'</div>':''}
    \${(!outEdges.length&&!inEdges.length)?'<div class="dp-section"><div class="dp-val" style="opacity:.5">Sin conexiones detectadas con otros archivos</div></div>':''}
  \`;
  document.getElementById('code-detail-panel').classList.add('visible');
  focusCodeNode(node.id);
}
function closeCodeDetail(){
  document.getElementById('code-detail-panel').classList.remove('visible');
  codeSelectedId=null;
  refreshCodeColors();
}
function focusCodeNode(id){
  codeSelectedId=id;
  refreshCodeColors();
}
function resetCodeGraph(){
  const g=active3DGraphs['code-gc'];
  if(!g)return;
  CODE_NODES.forEach(n=>{n.fx=null;n.fy=null;n.fz=null;});
  g.d3ReheatSimulation();
  robustAutoFit(g, CODE_NODES, 5);
}
function centerCodeGraph(){
  const g=active3DGraphs['code-gc'];
  if(!g)return;
  robustAutoFit(g, CODE_NODES, 5);
}

// ─── Combined — merge heurístico por área (KDD Memory + Code Structure) ──────
let combinedNodeMap={};
let combinedLinksArr=[];
let combinedSelectedId=null;

function combinedNeighborIds(mergedId){
  const s=new Set();
  combinedLinksArr.forEach(e=>{
    const src=mergedEdgeEndId(e.source), tgt=mergedEdgeEndId(e.target);
    if(src===mergedId)s.add(tgt);
    if(tgt===mergedId)s.add(src);
  });
  return s;
}

function refreshCombinedColors(){
  const g=active3DGraphs['combined-gc'];
  if(!g)return;
  g.nodeColor(g.nodeColor());
  g.linkColor(g.linkColor());
  g.linkWidth(g.linkWidth());
  forceRefreshLinkMaterials(g);
}

function buildHeuristicLinks(){
  // Heurística: un nodo KDD con area="X" se conecta a archivos de código
  // cuya ruta contenga "X". Aproximación deliberada — no hay vínculo exacto
  // guardado en la base de datos entre un patrón/error y el archivo que lo
  // originó, así que esto es lo mejor que se puede inferir sin esa data.
  const links=[];
  NODES.forEach(kddNode=>{
    if(!kddNode.area||kddNode.area==='global')return;
    const areaLower=kddNode.area.toLowerCase();
    CODE_NODES.forEach(codeNode=>{
      if(codeNode.file.toLowerCase().includes(areaLower)){
        links.push({source:'kdd-'+kddNode.id,target:codeNode.id,tipo:'area_match',weight:0.5});
      }
    });
  });
  return links;
}

// "endpoint≈" — front llama api('/ruta') que calza con una router.METODO('/ruta')
// del back (ver getEndpointHeuristicEdges en el servidor, dashboard.cjs). Igual
// de heurística que área≈: no es un vínculo exacto guardado en la base de datos,
// es una coincidencia de texto de ruta.
function buildEndpointHeuristicLinks(){
  const links=[];
  const codeNodeByFile={};
  CODE_NODES.forEach(n=>{codeNodeByFile[n.file]=n;});
  ENDPOINT_HEURISTIC_EDGES.forEach(e=>{
    const front=codeNodeByFile[e.frontFile], back=codeNodeByFile[e.backFile];
    if(front&&back) links.push({source:front.id,target:back.id,tipo:'endpoint_match',weight:0.6});
  });
  return links;
}

let combinedMergedNodesArr=[];

function renderCombinedGraph(){
  if(!NODES.length&&!CODE_NODES.length)return;

  // Namespacing de IDs para evitar colisión entre los dos sets de nodos
  const mergedNodes=[
    ...NODES.map(n=>({...n,mergedId:'kdd-'+n.id,group:'kdd'})),
    ...CODE_NODES.map(n=>({...n,mergedId:n.id,group:'code'})),
  ];
  combinedMergedNodesArr=mergedNodes;
  combinedNodeMap={};
  mergedNodes.forEach(n=>combinedNodeMap[n.mergedId]=n);

  const kddEdges=EDGES
    .filter(e=>combinedNodeMap['kdd-'+e.desde_id]&&combinedNodeMap['kdd-'+e.hacia_id])
    .map(e=>({source:'kdd-'+e.desde_id,target:'kdd-'+e.hacia_id}));
  const codeEdges=CODE_EDGES
    .filter(e=>combinedNodeMap[e.source]&&combinedNodeMap[e.target])
    .map(e=>({source:e.source,target:e.target,tipo:e.tipo}));
  const heuristicEdges=buildHeuristicLinks().filter(e=>combinedNodeMap[e.source]&&combinedNodeMap[e.target]);

  const endpointEdges=buildEndpointHeuristicLinks().filter(e=>combinedNodeMap[e.source]&&combinedNodeMap[e.target]);
  combinedLinksArr=[...kddEdges,...codeEdges,...heuristicEdges,...endpointEdges];
  // "El combined es solo aplicarle los colores de cada grafo" (pedido explícito)
  // — esto valía para nodos (ya lo hacía, ver nodeColor abajo) pero no para
  // LÍNEAS: antes TODAS las líneas de Combined (kdd-kdd, code-code, heurística)
  // pintaban del mismo púrpura genérico, así que las 848 conexiones reales de
  // código (recién arregladas en ast-indexer.cjs) quedaban invisibles, perdidas
  // en la maraña — existían en los datos, pero no se distinguían a simple vista.
  // Code-code ahora usa el blanco de Code Structure. endpoint≈ (front↔back por
  // ruta de API) usa ámbar, para distinguirse de área≈ (que se queda púrpura,
  // igual que kdd-kdd).
  const ENDPOINT_MATCH_COLOR='#22d3ee';
  const USES_CLASS_COLOR='rgba(236,72,153,0.55)'; // Plan 2: capa CSS→vista en rosa
  const isCombinedCodeCodeEdge=(s,t)=>{
    const sn=combinedNodeMap[s], tn=combinedNodeMap[t];
    return !!(sn&&tn&&sn.group==='code'&&tn.group==='code');
  };
  const getCombinedLinkColor=e=>{
    const s=mergedEdgeEndId(e.source), t=mergedEdgeEndId(e.target);
    if(combinedSelectedId&&(s===combinedSelectedId||t===combinedSelectedId))return '#facc15';
    if(e.tipo==='endpoint_match') return ENDPOINT_MATCH_COLOR;
    if(e.tipo==='USES_CLASS') return combinedSelectedId ? 'rgba(236,72,153,0.08)' : USES_CLASS_COLOR;
    if(isCombinedCodeCodeEdge(s,t)) return combinedSelectedId ? CODE_LINK_DIMMED_RGBA : CODE_LINK_BASE_RGBA;
    return combinedSelectedId ? LINK_DIMMED_RGBA : LINK_BASE_RGBA;
  };
  const getCombinedParticleColor=e=>{
    const s=mergedEdgeEndId(e.source), t=mergedEdgeEndId(e.target);
    if(combinedSelectedId&&(s===combinedSelectedId||t===combinedSelectedId))return '#facc15';
    if(e.tipo==='endpoint_match') return ENDPOINT_MATCH_COLOR;
    return isCombinedCodeCodeEdge(s,t) ? CODE_PARTICLE_COLOR : getCombinedLinkColor(e);
  };
  const getCombinedLinkWidth=e=>{
    const s=mergedEdgeEndId(e.source), t=mergedEdgeEndId(e.target);
    if(combinedSelectedId&&(s===combinedSelectedId||t===combinedSelectedId))return 1.2;
    if(e.tipo==='endpoint_match')return 0.9; // solo 50 en Lumo — más grueso para que se note
    return 0.4;
  };

  create3DGraph('combined-gc',{
    nodes:mergedNodes,
    links:combinedLinksArr,
    nodeId:'mergedId', // los links usan mergedId (namespaced kdd-N / code-N), no el id crudo
    nodeColor:d=>{
      const base=d.group==='kdd'?kddNodeColor(d):codeNodeColor(d);
      if(d.mergedId===combinedSelectedId)return '#ffffff';
      if(combinedSelectedId){
        return combinedNeighborIds(combinedSelectedId).has(d.mergedId) ? base : blendTowards(base,'#0a0d14',0.75);
      }
      return base;
    },
    nodeVal:d=>Math.pow((d.group==='kdd'?8:6)/6,3),
    nodeThreeObject:d=>{
      if(d.group!=='code')return null; // el glow tetrádico es solo para nodos de código
      return createGlowSprite(codeNodeColor(d),6);
    },
    nodeLabel:d=>{
      const label=d.group==='kdd'?d.titulo:d.file;
      return '<div style="background:rgba(17,21,32,.95);border:1px solid #2a3050;border-radius:6px;padding:6px 9px;font-family:sans-serif;max-width:220px">'
        +'<strong style="color:#e2e8f0">'+escHtml(String(label).slice(0,60))+'</strong><br>'
        +'<span style="color:#64748b;font-size:10px">'+(d.group==='kdd'?'KDD · '+escHtml(d.area||''):'código')+'</span></div>';
    },
    linkColor:getCombinedLinkColor,
    linkWidth:getCombinedLinkWidth,
    // Impulsos que viajan por cada conexión — mismo efecto que en los otros 2.
    linkDirectionalParticles:1,
    linkDirectionalParticleSpeed:getStaggeredParticleSpeed,
    linkDirectionalParticleWidth:e=>getCombinedLinkWidth(e)+0.1,
    linkDirectionalParticleColor:getCombinedParticleColor,
    chargeStrength:()=>-140,
    linkDistance:()=>45,
    // centerStrength bajó de 0.3 a 0.08: con 0.3, forceRecenter jala TODO
    // hacia el origen (r=0) con la misma fuerza que la coraza empuja hacia
    // afuera — las dos fuerzas se anulaban y no había separación visible.
    // 0.08 alcanza para que nada se vaya a la deriva lateral, sin ahogar la
    // fuerza radial que sí separa UI (afuera) de código de atrás (adentro).
    centerStrength:0.08,
    radialShellGetRadius:d=>esNodoFrontend(d)?220:60,
    onNodeClick:(node)=>{
      showCombinedDetail(node);
      const g=active3DGraphs['combined-gc'];
      if(g)g.controls().target.set(node.x,node.y,node.z);
    },
    onBackgroundClick:()=>{
      closeCombinedDetail();
      const g=active3DGraphs['combined-gc'];
      if(g)g.controls().target.set(0,0,0);
    },
    onNodeDragEnd:(node)=>{
      node.fx=node.x; node.fy=node.y; node.fz=node.z;
    },
  });
}

function showCombinedDetail(node){
  lastCombinedNode=node;
  const isKdd=node.group==='kdd';
  document.getElementById('combined-dp-title').textContent=isKdd?node.titulo:node.file;
  const links=combinedLinksArr.filter(e=>mergedEdgeEndId(e.source)===node.mergedId||mergedEdgeEndId(e.target)===node.mergedId);
  const areaLinks=links.filter(l=>l.tipo==='area_match');
  const relHTML=areaLinks.slice(0,12).map(e=>{
    const otherId=mergedEdgeEndId(e.source)===node.mergedId?mergedEdgeEndId(e.target):mergedEdgeEndId(e.source);
    const other=combinedNodeMap[otherId];
    if(!other)return'';
    const label=other.group==='kdd'?other.titulo:other.file.split(/[\\/]/).pop();
    const dotColor=other.group==='kdd'?kddNodeColor(other):'#00e5ff';
    return \`<div class="rel-item" onclick="focusCombinedNode('\${otherId}')"><div style="width:7px;height:7px;border-radius:50%;background:\${dotColor};flex-shrink:0"></div><div class="rel-name">\${escHtml(String(label).slice(0,36))}</div><span class="rel-type-label">área≈</span></div>\`;
  }).filter(Boolean).join('');

  const bodyHTML=isKdd?\`
    <div class="dp-badges">
      <span class="mb t-\${node.tipo}" style="font-size:11px;padding:3px 8px">\${node.tipo}</span>
      <span class="mb c\${node.confianza}" style="font-size:11px;padding:3px 8px">\${node.confianza}</span>
      <span class="ab" style="font-size:11px;padding:3px 8px">\${escHtml(node.area||'global')}</span>
    </div>
    <div class="dp-section">
      <div class="dp-label">Archivos de código relacionados por área (\${areaLinks.length})</div>
      \${areaLinks.length?relHTML:'<div class="dp-val" style="opacity:.5">Sin coincidencia de área con ningún archivo indexado</div>'}
    </div>
  \`:\`
    <div class="dp-badges">
      <span class="mb" style="font-size:11px;padding:3px 8px;background:rgba(0,229,255,.15);color:#00e5ff">\${escHtml(node.tipo)}</span>
    </div>
    <div class="dp-section">
      <div class="dp-label">Funciones / Símbolos</div>
      <div class="dp-val">\${node.functions} funciones · \${node.symbol_count} símbolos</div>
    </div>
    <div class="dp-section">
      <div class="dp-label">Nodos KDD relacionados por área (\${areaLinks.length})</div>
      \${areaLinks.length?relHTML:'<div class="dp-val" style="opacity:.5">Ningún error/patrón/decisión coincide con la ruta de este archivo</div>'}
    </div>
  \`;
  document.getElementById('combined-dp-body').innerHTML=bodyHTML;
  document.getElementById('combined-detail-panel').classList.add('visible');
  focusCombinedNode(node.mergedId);
}

function closeCombinedDetail(){
  document.getElementById('combined-detail-panel').classList.remove('visible');
  combinedSelectedId=null;
  refreshCombinedColors();
}

function focusCombinedNode(mergedId){
  combinedSelectedId=mergedId;
  refreshCombinedColors();
}

function resetCombinedGraph(){
  const g=active3DGraphs['combined-gc'];
  if(!g)return;
  combinedMergedNodesArr.forEach(n=>{n.fx=null;n.fy=null;n.fz=null;});
  g.d3ReheatSimulation();
  robustAutoFit(g, combinedMergedNodesArr, 5);
}
function centerCombinedGraph(){
  const g=active3DGraphs['combined-gc'];
  if(!g)return;
  robustAutoFit(g, combinedMergedNodesArr, 5);
}

// ─── D3 Module Neural Graph (fullscreen) ─────────────────────
let modSim, modNodeG, modLink2;

function renderModuleGraph(){
  if(modGraphRendered||(!M_NODES.length))return;
  modGraphRendered=true;

  const container=document.getElementById('mod-area');
  if(!container)return;
  // Use docs-main width minus the list panel (220px)
  const docsMain=document.querySelector('.docs-main');
  const W=Math.max((docsMain?docsMain.clientWidth:0)-220, 400);
  const H=Math.max(window.innerHeight-160, 500);
  container.style.width=W+'px';
  container.style.height=H+'px';

  const svg=d3.select('#mod-svg')
    .attr('width',W).attr('height',H)
    .call(d3.zoom().scaleExtent([0.2,4]).on('zoom',function(ev){g2.attr('transform',ev.transform);}));

  const g2=svg.append('g');
  const defs2=svg.append('defs');
  defs2.append('marker').attr('id','arr2').attr('viewBox','0 -4 8 8').attr('refX',20).attr('refY',0)
    .attr('markerWidth',5).attr('markerHeight',5).attr('orient','auto')
    .append('path').attr('d','M0,-4L8,0L0,4').attr('fill','#4b5570');

  const cleanLabel=function(s){var r=s;while(r.indexOf('**')>=0)r=r.split('**').join('');while(r.indexOf('*')>=0)r=r.split('*').join('');r=r.replace(/^\\[.\\]\\s*/,'');return r.trim();};
  const implNodes=M_NODES.filter(function(n){return n.tipo==='impl';}).map(function(n){return Object.assign({},n,{label:cleanLabel(n.label)});});
  const pendNodes=M_NODES.filter(function(n){return n.tipo==='pend';}).map(function(n){return Object.assign({},n,{label:cleanLabel(n.label)});});

  // Grid positions — impl top, pending bottom
  var NW=160,NH=52,HGAP=24,VGAP=32;
  var cols=Math.min(3,implNodes.length);
  if(cols===0)cols=1;
  var rows=Math.ceil(implNodes.length/cols);
  var gridW=cols*(NW+HGAP)-HGAP;
  var sx=(W-gridW)/2;
  var sy=50;
  implNodes.forEach(function(n,i){
    n.x=sx+(i%cols)*(NW+HGAP)+NW/2;
    n.y=sy+Math.floor(i/cols)*(NH+VGAP)+NH/2;
  });
  var implBottom=sy+rows*(NH+VGAP)+16;
  var PW=130,PH=40,PGAP=16;
  var pendTW=pendNodes.length*(PW+PGAP)-PGAP;
  var px=(W-pendTW)/2;
  var py=Math.max(implBottom+50, H-PH-30);
  pendNodes.forEach(function(n,i){
    n.x=px+i*(PW+PGAP)+PW/2;
    n.y=py;
  });

  // Links: impl sequential flow
  var links=[];
  for(var i=0;i<implNodes.length-1;i++) links.push({s:implNodes[i],t:implNodes[i+1]});

  g2.append('g').selectAll('line').data(links).enter().append('line')
    .attr('x1',function(d){return d.s.x;}).attr('y1',function(d){return d.s.y;})
    .attr('x2',function(d){return d.t.x;}).attr('y2',function(d){return d.t.y;})
    .attr('stroke','#2a3050').attr('stroke-width',1.5).attr('stroke-opacity',0.4)
    .attr('marker-end','url(#arr2)');

  // Section labels
  g2.append('text').text('✅ Implemented').attr('x',W/2).attr('y',sy-16)
    .attr('text-anchor','middle').attr('font-size',11).attr('fill','rgba(16,185,129,0.6)');
  if(pendNodes.length>0){
    g2.append('line').attr('x1',40).attr('y1',implBottom+20).attr('x2',W-40).attr('y2',implBottom+20)
      .attr('stroke','rgba(245,158,11,0.2)').attr('stroke-width',1).attr('stroke-dasharray','4,4');
    g2.append('text').text('⏳ Pending').attr('x',W/2).attr('y',implBottom+36)
      .attr('text-anchor','middle').attr('font-size',11).attr('fill','rgba(245,158,11,0.6)');
  }

  // Impl node groups
  var iG=g2.append('g').selectAll('g').data(implNodes).enter().append('g')
    .attr('transform',function(d){return 'translate('+d.x+','+d.y+')';})
    .style('cursor','pointer')
    .on('click',function(ev,d){ev.stopPropagation();selectModule(d.label,d.area,d);})
    .on('mouseover',function(ev,d){
      var tt=document.getElementById('mod-tt');
      tt.innerHTML='<strong style="color:var(--text)">'+d.label+'</strong><br><span style="color:var(--text3);font-size:10px">'+d.errors+' errors · '+d.patterns+' patterns</span>';
      tt.style.opacity=1;
      var r=container.getBoundingClientRect();
      tt.style.left=(ev.clientX-r.left+12)+'px';tt.style.top=(ev.clientY-r.top-8)+'px';
    }).on('mouseout',function(){document.getElementById('mod-tt').style.opacity=0;});

  iG.append('rect').attr('width',NW).attr('height',NH).attr('x',-NW/2).attr('y',-NH/2).attr('rx',10)
    .attr('fill','rgba(16,185,129,0.1)')
    .attr('stroke',function(d){return d.degree>2?'rgba(139,92,246,0.7)':'rgba(16,185,129,0.45)';})
    .attr('stroke-width',function(d){return d.degree>2?2:1.5;});

  iG.append('text').text(function(d){return d.label.length>17?d.label.slice(0,17)+'…':d.label;})
    .attr('text-anchor','middle').attr('dy',-4)
    .attr('font-size',12).attr('font-weight','600')
    .attr('fill',function(d){return d.degree>2?'#a78bfa':'#34d399';});

  iG.append('text').text(function(d){
    var p=[];if(d.errors>0)p.push(d.errors+' err');if(d.patterns>0)p.push(d.patterns+' pat');return p.join(' · ')||'✓';
  }).attr('text-anchor','middle').attr('dy',14).attr('font-size',9)
    .attr('fill',function(d){return d.errors>0?'#f87171':'#6ee7b7';});

  // Pending node groups
  if(pendNodes.length>0){
    var pG=g2.append('g').selectAll('g').data(pendNodes).enter().append('g')
      .attr('transform',function(d){return 'translate('+d.x+','+d.y+')';})
      .style('cursor','pointer')
      .on('click',function(ev,d){ev.stopPropagation();selectModule(d.label,d.area,d);})
      .on('mouseover',function(ev,d){
        var tt=document.getElementById('mod-tt');
        tt.innerHTML='<strong style="color:var(--text)">⏳ '+d.label+'</strong>';
        tt.style.opacity=1;
        var r=container.getBoundingClientRect();
        tt.style.left=(ev.clientX-r.left+12)+'px';tt.style.top=(ev.clientY-r.top-8)+'px';
      }).on('mouseout',function(){document.getElementById('mod-tt').style.opacity=0;});

    pG.append('rect').attr('width',PW).attr('height',PH).attr('x',-PW/2).attr('y',-PH/2).attr('rx',8)
      .attr('fill','rgba(245,158,11,0.07)').attr('stroke','rgba(245,158,11,0.4)').attr('stroke-width',1.5);

    pG.append('text').text(function(d){return d.label.length>15?d.label.slice(0,15)+'…':d.label;})
      .attr('text-anchor','middle').attr('dy',4)
      .attr('font-size',11).attr('font-weight','500').attr('fill','#fbbf24');
  }

  svg.on('click',function(){document.getElementById('mod-detail').style.display='none';});
}


function showModTT(ev,d,container){
  var tt=document.getElementById('gtt');
  var icon=d.tipo==='impl'?'✅':'⏳';
  tt.innerHTML='<strong style="color:var(--text)">'+icon+' '+d.label+'</strong><br><span style="color:var(--text3);font-size:10px">'+d.errors+' errors · '+d.patterns+' patterns</span>';
  tt.style.opacity=1;
  var r=container.getBoundingClientRect();
  tt.style.left=(ev.clientX-r.left+14)+'px';
  tt.style.top=(ev.clientY-r.top-10)+'px';
}

function getModW(d){ return Math.max(100,Math.min(d.label.length,18)*8+24); }

function selectModule(label,area,d){
  var panel=document.getElementById('mod-detail');
  document.getElementById('mod-det-title').textContent=label;
  var knNodes=NODES.filter(function(n){return n.area===area||n.area==='global';});
  var errs=knNodes.filter(function(n){return n.tipo==='error';});
  var pats=knNodes.filter(function(n){return n.tipo==='patron'&&n.confianza==='ALTA';});
  var decs=knNodes.filter(function(n){return n.tipo==='decision';});
  var html='';
  html+='<div style="font-size:10px;color:var(--text3);margin-bottom:8px">'+(d?d.tipo==='impl'?'Done':'Pending':'')+'</div>';
  if(errs.length>0){
    html+='<div style="margin-bottom:8px"><div style="font-size:10px;color:#f87171;font-weight:600;margin-bottom:4px">Errors ('+errs.length+')</div>';
    errs.slice(0,3).forEach(function(e){html+='<div style="font-size:11px;color:#94a3b8;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.05)">'+escHtml(e.titulo.slice(0,42))+'</div>';});
    html+='</div>';
  }
  if(pats.length>0){
    html+='<div style="margin-bottom:8px"><div style="font-size:10px;color:#34d399;font-weight:600;margin-bottom:4px">HIGH patterns ('+pats.length+')</div>';
    pats.slice(0,3).forEach(function(p){html+='<div style="font-size:11px;color:#94a3b8;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.05)">'+escHtml(p.titulo.slice(0,42))+'</div>';});
    html+='</div>';
  }
  if(decs.length>0){
    html+='<div><div style="font-size:10px;color:#60a5fa;font-weight:600;margin-bottom:4px">Decisions ('+decs.length+')</div>';
    decs.slice(0,2).forEach(function(dec){html+='<div style="font-size:11px;color:#94a3b8;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.05)">'+escHtml(dec.titulo.slice(0,42))+'</div>';});
    html+='</div>';
  }
  if(!errs.length&&!pats.length&&!decs.length) html+='<div style="font-size:11px;color:#64748b">No knowledge recorded yet.</div>';
  document.getElementById('mod-det-body').innerHTML=html;
  panel.style.display='block';
}

function resetModGraph(){
  document.getElementById('mod-detail').style.display='none';
}

function centerModGraph(){
  // noop — static graph
}

function copyMarkdown(){
  const t='# '+('${config.nombre}')+'\\n\\nGenerated by Agentix KDD Dashboard\\n';
  navigator.clipboard?.writeText(t).then(()=>alert('Copied!')).catch(()=>alert('Copy manually'));
}

// Init
renderNodeList();
renderGraph();
</script>

  </body>
</html>`;

const server = require('http').createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(HTML);
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  Agentix KDD Dashboard v4`);
  console.log(`  → ${url}\n`);
  // Open browser
  const { exec } = require('child_process');
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
            : process.platform === 'darwin' ? `open "${url}"`
            : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) console.log(`  Open manually: ${url}`);
  });
  console.log('  Press Ctrl+C to stop\n');
});
