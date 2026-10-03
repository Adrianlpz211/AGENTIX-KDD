/**
 * Agentic KDD — TDD Gate v1.0
 * Loop mecánico de self-healing: ejecuta tests → evalúa → retry → abort
 *
 * Este módulo reemplaza la instrucción markdown de TDD+Self-Healing
 * con un loop determinista en código Node.js.
 *
 * Diferencia clave:
 *   ANTES: markdown dice "intenta hasta 3 veces" → el agente decide si lo sigue
 *   AHORA: código fuerza el loop, el agente no puede saltárselo
 *
 * Uso:
 *   node .agentic/grafo/tdd-gate.cjs run [area]
 *   node .agentic/grafo/tdd-gate.cjs status
 *   node .agentic/grafo/tdd-gate.cjs clear
 */

'use strict';

const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs   = require('fs');
const path = require('path');
const { createGateResult } = require('./gate-result.cjs');
const { extractTestResults } = require('./test-results.cjs');

// ─── CONSTANTES ───────────────────────────────────────────────────────────────

const MAX_HEALING_ITERATIONS   = 3;
const MAX_REGRESSION_ITERATIONS = 2;
const TDD_STATE_FILE = '.agentic/_tdd_state.json';
const TEST_COMMANDS = [
  'npm test',
  'npm run test',
  'npx jest --passWithNoTests',
  'npx vitest run',
  'npx jest',
  // Python projects
  'pytest',
  'python -m pytest',
  'python3 -m pytest',
];

// ─── DB ────────────────────────────────────────────────────────────────────────

/**
 * Abre memoria.db con 3 niveles de respaldo: better-sqlite3 del PROYECTO (vía
 * createRequire, ya que vive en el node_modules del proyecto, no de Agentix),
 * better-sqlite3 accesible directo, y node:sqlite nativo (Node 22+) como
 * último recurso — sin esto, un proyecto que solo tiene node:sqlite instalado
 * (sin better-sqlite3 en ningún lado) se queda con DB=null en silencio.
 */
function openProjectDB(dbPath, projectRoot) {
  try {
    const { createRequire } = require('module');
    const projReq = createRequire(require('path').join(projectRoot || process.cwd(), 'package.json'));
    return new (projReq('better-sqlite3'))(dbPath);
  } catch {}
  try { return new (require('better-sqlite3'))(dbPath); } catch {}
  try { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(dbPath); } catch {}
  return null;
}

// ─── TEST RUNNER ──────────────────────────────────────────────────────────────

/**
 * Detecta el comando de tests del proyecto.
 * Prueba los comandos en orden hasta encontrar uno que funcione.
 * @returns {string|null}
 */
function detectTestCommand(projectRoot) {
  // 1. Leer desde config.md si ya está guardado.
  // OJO con el regex: \s* cruza saltos de línea, así que con el formato YAML
  // en bloque (`test:` solo en su línea, `comando: npm test` debajo) el viejo
  // /^\s*test:\s*(.+)$/m capturaba la LÍNEA SIGUIENTE completa y devolvía
  // "runner: node --test" como comando literal → STOP falso en todo el
  // proyecto (bug real encontrado por el propio pipeline corriendo sobre
  // FLOTA360, 2026-07-19). [^\S\n]* = solo espacios horizontales.
  const configPath = path.join(projectRoot, '.agentic/config.md');
  if (fs.existsSync(configPath)) {
    const config = fs.readFileSync(configPath, 'utf8');
    // Forma inline: `test: npm test`
    const inline = config.match(/^[^\S\n]*test:[^\S\n]*(\S.*)$/m);
    if (inline && inline[1].trim() !== '—') {
      return inline[1].trim();
    }
    // Forma YAML en bloque: `test:` … `  comando: npm test`
    const comando = config.match(/^[^\S\n]*comando:[^\S\n]*(\S.*)$/m);
    if (comando && comando[1].trim() !== '—') {
      return comando[1].trim();
    }
  }

  // 2. Detectar por package.json
  const pkgPath = path.join(projectRoot, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
        return 'npm test';
      }
      if (pkg.scripts?.['test:run']) return 'npm run test:run';
    } catch {}
  }

  // 3. Probar comandos conocidos
  // shell:true es necesario en Windows — npm/npx son en realidad npm.cmd/npx.cmd, y sin
  // shell spawnSync falla con ENOENT (status=null) para TODOS los comandos npm/npx, cayendo
  // siempre a pytest como "detectado" incluso en proyectos Node puros sin Python.
  for (const cmd of TEST_COMMANDS) {
    try {
      const result = spawnSync(cmd.split(' ')[0], cmd.split(' ').slice(1), {
        cwd: projectRoot, timeout: 10000, stdio: 'pipe', shell: true
      });
      if (result.status !== null) return cmd;
    } catch {}
  }

  return null;
}

/**
 * v3.15.2 — Grieta R10 del Coliseo (2026-07-17): un proyecto que usa `tsx`
 * (o cualquier runner que solo TRANSPILA, no verifica tipos) puede tener
 * `npm test` en verde con errores de tipos reales sin detectar — se coló un
 * bug así hasta que se corrió `npm run typecheck` por separado, varias
 * rondas después. Si el proyecto declara un script "typecheck", correrlo es
 * parte de "los tests pasan" — no un paso opcional aparte.
 */
function detectTypecheckCommand(projectRoot) {
  const pkgPath = path.join(projectRoot, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.scripts && pkg.scripts.typecheck) return 'npm run typecheck';
    } catch {}
  }
  return null;
}

function runTypecheck(command, projectRoot) {
  try {
    const isWin = process.platform === 'win32';
    const shell = isWin ? 'cmd.exe' : 'sh';
    const shellFlag = isWin ? '/c' : '-c';
    const result = spawnSync(shell, [shellFlag, command], {
      cwd: projectRoot, timeout: parseInt(process.env.AKDD_TEST_TIMEOUT_MS, 10) || 120000,
      stdio: 'pipe', encoding: 'utf8',
    });
    const output = (result.stdout || '') + (result.stderr || '');
    return { passed: (result.status ?? 1) === 0, output };
  } catch (err) {
    return { passed: false, output: err.message };
  }
}

/**
 * Ejecuta la suite de tests y retorna el resultado estructurado.
 * @param {string} command
 * @param {string} projectRoot
 * @param {string} [testFile] - archivo específico o null para suite completa
 * @returns {{ allPassed: boolean, total: number, passed: number, failed: number,
 *             failures: string[], output: string, error: string|null }}
 */
/* Letras y dígitos de cualquier idioma, espacios y separadores de ruta. Nada
   que el shell interprete; un argumento que empiece por "-" sería una opción. */
const ARG_SEGURO = /^[\p{L}\p{N}_./\\:@+][\p{L}\p{N}_ ./\\:@+-]*$/u;

function subjectHash(projectRoot) {
  const h = crypto.createHash('sha256');
  const git = (args) => {
    const r = spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8', shell: false, timeout: 10000 });
    return r.status === 0 ? r.stdout : '';
  };
  const usable = spawnSync('git', ['rev-parse', '--git-dir'], { cwd: projectRoot, encoding: 'utf8', shell: false, timeout: 10000 }).status === 0;
  /* Sin Git utilizable (no hay repo, o Git lo rechaza) la huella sale del contenido:
     una constante dejaría el gate trabado y haría pasar evidencia vieja por nueva. */
  if (!usable) return huellaContenido(projectRoot);
  const head = git(['rev-parse', 'HEAD']);
  h.update(head || 'sin-commits:' + path.resolve(projectRoot));
  h.update(git(['diff', 'HEAD', '--binary']));
  const others = git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  for (const f of others) {
    h.update(f + '\0');
    try { h.update(fs.readFileSync(path.join(projectRoot, f))); } catch { h.update('ILEGIBLE:' + f); }
    h.update('\0');
  }
  return h.digest('hex');
}

const FUERA_DE_HUELLA = /^(\.git|node_modules|_output|dist|build|coverage)$|^\.agentic[\\/](_|memoria|telemetria|snapshots|_cache|_executions|_pipeline|_effort)/;
const ES_SUJETO = /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|py|rb|go|java|kt|php|cs|rs|sql|json|lock|html?|css|scss|sass|less|svg)$/i;

function huellaContenido(projectRoot) {
  const h = crypto.createHash('sha256');
  h.update('contenido:');
  const recorrer = (dir) => {
    let entradas = [];
    try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entradas.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entradas) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(projectRoot, abs);
      if (FUERA_DE_HUELLA.test(rel)) continue;
      if (e.isDirectory()) recorrer(abs);
      else if (e.isFile() && ES_SUJETO.test(e.name)) {
        try { h.update(rel.split(path.sep).join('/') + '\0'); h.update(fs.readFileSync(abs)); h.update('\0'); }
        catch { h.update('ILEGIBLE:' + rel.split(path.sep).join('/') + '\0'); }
      }
    }
  };
  recorrer(projectRoot);
  return h.digest('hex');
}

/**
 * El comando de tests viene de config.md o package.json y se corre con el
 * shell del sistema: es el adaptador de runner. Un archivo de test no se
 * interpola en esa línea si trae caracteres de shell.
 */
function runTests(command, projectRoot, testFile = null, meta = {}) {
  const archivos = testFile == null ? [] : (Array.isArray(testFile) ? testFile : [testFile]);
  if (archivos.some((f) => !ARG_SEGURO.test(String(f)))) {
    return parseTestOutput('', null, {
      spawnError: 'UNSAFE_TEST_ARG', command, projectRoot, subject_hash: meta.subject_hash,
    });
  }
  const separador = /^(npm|pnpm|yarn)(\.cmd)?\s/.test(command.trim()) ? ' --' : '';
  const fullCmd = archivos.length
    ? `${command}${separador} ${archivos.map((f) => '"' + f + '"').join(' ')}`
    : command;
  const sourceBefore = require('./source-evidence.cjs').capture(projectRoot);
  const startedAt = new Date().toISOString();
  const timeout = parseInt(process.env.AKDD_TEST_TIMEOUT_MS, 10) || 120000;

  const isWin = process.platform === 'win32';
  // Heredado de un `node --test` padre, el runner del proyecto le reporta al
  // padre por un canal propio y no imprime su resumen: no habría qué medir.
  const env = Object.assign({}, process.env);
  delete env.NODE_TEST_CONTEXT;
  let result;
  try {
    // En Windows la línea va tal cual a cmd.exe: sin verbatim, Node escapa las
    // comillas internas y el runner recibe `"archivo"` con las comillas puestas.
    result = isWin
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', `"${fullCmd}"`], {
        cwd: projectRoot, timeout, stdio: 'pipe', encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, env,
      })
      : spawnSync('sh', ['-c', fullCmd], {
        cwd: projectRoot, timeout, stdio: 'pipe', encoding: 'utf8', env,
      });
  } catch (err) {
    result = { error: err, status: null, signal: null, stdout: '', stderr: '' };
  }

  const timedOut = !!(result.error && result.error.code === 'ETIMEDOUT');
  const parsed = parseTestOutput((result.stdout || '') + (result.stderr || ''), result.status, {
    command,
    projectRoot,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    timedOut,
    signal: timedOut ? null : result.signal,
    spawnError: !timedOut && result.error ? (result.error.code || result.error.message) : null,
    subject_hash: meta.subject_hash || subjectHash(projectRoot),
    cycle_id: meta.cycle_id,
    execution_id: meta.execution_id,
    testFile: archivos.length === 1 ? archivos[0] : null,
  });
  const sourceAfter = require('./source-evidence.cjs').capture(projectRoot);
  if (!sourceBefore.complete || sourceBefore.hash !== sourceAfter.hash) {
    parsed.status='UNVERIFIED'; parsed.allPassed=false; parsed.reason_code='SOURCE_CHANGED_OR_INCOMPLETE';
    parsed.gate.status='UNVERIFIED'; parsed.gate.reason_code=parsed.reason_code;
  }
  parsed.run_scope = archivos.length ? 'targeted' : 'suite';
  Object.defineProperty(parsed,'source_evidence',{value:sourceBefore});
  require('./escenarios.cjs').evidenciaDeCorrida(projectRoot,parsed,archivos.length?archivos:findTestFiles(projectRoot),{gate:parsed.gate.gate,cycle_id:meta.cycle_id,explicito:archivos.length>0});
  return parsed;
}

function contarPytest(raw) {
  const lineas = raw.split('\n').filter((l) => /\b\d+\s+(passed|failed|errors?)\b/.test(l) && /\bin\s+[\d.]+\s*s\b/.test(l));
  if (!lineas.length) return null;
  const linea = lineas[lineas.length - 1];
  const n = (re) => { const m = linea.match(re); return m ? parseInt(m[1], 10) : 0; };
  const passed = n(/(\d+)\s+passed/);
  const failed = n(/(\d+)\s+failed/) + n(/(\d+)\s+errors?\b/);
  return { passed, failed, total: passed + failed };
}

/**
 * Parsea el output de múltiples frameworks de testing.
 * Soporta: jest, vitest, mocha, jasmine, tap, pytest (output básico).
 */
function parseTestOutput(raw, exitCode, meta = {}) {
  // Strip ANSI color codes — Vitest adds them and break regex matching
  raw = (raw || '').replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

  const result = {
    allPassed: false,
    total: 0, passed: 0, failed: 0,
    failures: [], output: raw, error: null,
    exitCode: exitCode === undefined ? null : exitCode,
    runner: null,
  };

  // ── Jest / Vitest ────────────────────────────────────────────────────────
  // "Tests: 5 passed, 2 failed, 7 total"
  // Jest format: "Tests: 177 passed, 2 failed, 192 total"
  const jestSummary = raw.match(/Tests:\s*(?:(\d+)\s+passed,?\s*)?(?:(\d+)\s+failed,?\s*)?(\d+)\s+total/i);
  if (jestSummary) {
    result.passed = parseInt(jestSummary[1] || '0');
    result.failed = parseInt(jestSummary[2] || '0');
    result.total  = parseInt(jestSummary[3] || '0');
  }

  // Vitest format: "Tests  177 passed | 15 skipped (192)"
  const vitestSummary = raw.match(/Tests\s+(\d+)\s+passed(?:\s*\|\s*(\d+)\s+failed)?(?:\s*\|[^(]*)?\s*\((\d+)\)/i);
  if (vitestSummary && result.total === 0) {
    result.passed = parseInt(vitestSummary[1] || '0');
    result.failed = parseInt(vitestSummary[2] || '0');
    result.total  = parseInt(vitestSummary[3] || '0');
  }

  // Vitest format: "Test Files  38 passed | 2 skipped (40)"
  const vitestFiles = raw.match(/Test Files\s+(\d+)\s+passed(?:\s*\|\s*(\d+)\s+failed)?(?:\s*\|[^(]*)?\s*\((\d+)\)/i);
  if (vitestFiles && result.total === 0) {
    result.passed = parseInt(vitestFiles[1] || '0');
    result.failed = parseInt(vitestFiles[2] || '0');
    result.total  = parseInt(vitestFiles[3] || '0');
  }

  // "Test Suites: 1 failed, 2 passed, 3 total"
  const suiteSummary = raw.match(/Test Suites:\s*(?:(\d+)\s+failed,?\s*)?(?:(\d+)\s+passed,?\s*)?(\d+)\s+total/i);
  if (suiteSummary && result.total === 0) {
    result.failed = parseInt(suiteSummary[1] || '0');
    result.passed = parseInt(suiteSummary[2] || '0');
    result.total  = parseInt(suiteSummary[3] || '0');
  }

  // ── Mocha ────────────────────────────────────────────────────────────────
  // "  5 passing" / "  2 failing"
  const mochaPassing = raw.match(/(\d+)\s+passing/i);
  const mochaFailing = raw.match(/(\d+)\s+failing/i);
  if (mochaPassing || mochaFailing) {
    result.passed = parseInt(mochaPassing?.[1] || '0');
    result.failed = parseInt(mochaFailing?.[1] || '0');
    result.total  = result.passed + result.failed;
  }

  // ── Node.js test runner nativo (node --test) ──────────────────────────────
  // "ℹ tests 5" / "ℹ pass 5" / "ℹ fail 0" en modo TTY (spec reporter), o
  // "# tests 5" / "# pass 5" / "# fail 0" en modo NO-TTY (reporter TAP —
  // el que usa spawnSync SIEMPRE, porque no hay terminal real). v3.15.2:
  // el prefijo '#' faltaba — cualquier ejecución programática (exactamente
  // como corre este propio gate) del test runner nativo de Node, o de tsx
  // --test (mismo runtime), reportaba 0/0/0 aunque los tests pasaran de
  // verdad. Se descubrió corrido contra el propio Coliseo (MediCore usa
  // `tsx --test`).
  // El resumen que vale es el último: un archivo que corre su propio runner
  // (sin NODE_TEST_CONTEXT) imprime un resumen parcial antes que el final.
  const ultimo = (re) => { const ms = [...raw.matchAll(re)]; return ms.length ? ms[ms.length - 1] : null; };
  const nodeTestTotal = ultimo(/^[ℹi#]\s*tests\s+(\d+)/gim);
  const nodeTestPass  = ultimo(/^[ℹi#]\s*pass\s+(\d+)/gim);
  const nodeTestFail  = ultimo(/^[ℹi#]\s*fail\s+(\d+)/gim);
  if (nodeTestTotal && result.total === 0) {
    result.total  = parseInt(nodeTestTotal[1] || '0');
    result.passed = parseInt(nodeTestPass?.[1] || '0');
    result.failed = parseInt(nodeTestFail?.[1] || '0');
  }

  if (result.total > 0) result.runner = 'reconocido';

  // ── pytest ───────────────────────────────────────────────────────────────
  // "5 passed, 2 failed in 1.23s" y "1 failed, 2 passed in 0.1s": el orden no
  // es fijo, cada contador se lee por separado en la línea de resumen.
  const py = contarPytest(raw);
  if (py) {
    // pytest manda sobre los contadores genéricos que se cruzan con su texto
    result.passed = py.passed;
    result.failed = py.failed;
    result.total = py.total;
    result.runner = 'pytest';
  }

  // ── Extraer nombres de tests fallidos ────────────────────────────────────
  const failurePatterns = [
    /●\s+(.+)$/gm,                          // jest bullets
    /FAIL\s+.+\n.*›\s+(.+)/gm,              // jest FAIL
    /\d+\)\s+(.+)\n.*Error:/gm,             // mocha
    /FAILED\s+(test_.+)/gm,                 // pytest
    /AssertionError.*at\s+(.+):\d+/gm,      // generic
  ];

  for (const pattern of failurePatterns) {
    let match;
    while ((match = pattern.exec(raw)) !== null) {
      const failure = match[1].trim();
      if (failure && !result.failures.includes(failure) && result.failures.length < 20) {
        result.failures.push(failure);
      }
    }
  }

  const reconocido = result.total > 0 || result.passed > 0 || result.failed > 0;

  // Veredicto. El texto nunca convierte en PASS un proceso que salió mal.
  let status;
  let reason;
  if (meta.spawnError) { status = 'ERROR'; reason = 'SPAWN_FAILED'; }
  else if (meta.timedOut) { status = 'ERROR'; reason = 'TIMEOUT'; }
  else if (meta.signal) { status = 'ERROR'; reason = 'SIGNAL_' + meta.signal; }
  else if (exitCode === null || exitCode === undefined) { status = 'ERROR'; reason = 'NO_EXIT_CODE'; }
  else if (result.failed > 0) { status = 'FAIL'; reason = 'TESTS_FAILED'; }
  else if (exitCode !== 0) { status = 'FAIL'; reason = 'RUNNER_EXIT_NONZERO'; }
  else if (!reconocido) { status = 'UNVERIFIED'; reason = 'UNKNOWN_OUTPUT'; }
  else if (result.total === 0 || result.passed === 0) { status = 'UNVERIFIED'; reason = 'ZERO_TESTS'; }
  else { status = 'PASS'; reason = null; }

  if (status !== 'PASS' && result.failures.length === 0) {
    const errorLine = raw.split('\n').find(l => /error|fail|cannot|unexpected/i.test(l));
    result.failures.push(errorLine ? errorLine.trim().substring(0, 120) : reason);
  }
  if (status === 'FAIL' && result.failed === 0) result.failed = 1;
  if (status === 'ERROR') result.error = reason;

  result.status = status;
  result.reason_code = reason;
  result.allPassed = status === 'PASS';
  result.tests = extractTestResults(raw, { testFile: meta.testFile || null });

  const subject = meta.subject_hash || null;
  result.gate = createGateResult({
    gate: 'tdd',
    status,
    reason_code: reason,
    scope: 'TASK',
    cycle_id: meta.cycle_id,
    execution_id: meta.execution_id || crypto.randomUUID(),
    subject_hash: subject,
    evidence: subject ? [{
      kind: 'runner',
      subject_hash: subject,
      command: meta.command || null,
      exit_code: result.exitCode,
      total: result.total,
      passed: result.passed,
      failed: result.failed,
      output_sha256: crypto.createHash('sha256').update(raw).digest('hex'),
    }] : [],
    started_at: meta.started_at,
    finished_at: meta.finished_at,
  });
  if (status === 'PASS' && result.gate.status !== 'PASS') {
    result.status = result.gate.status;
    result.reason_code = result.gate.reason_code;
    result.allPassed = false;
  }
  return result;
}

/**
 * Encuentra archivos de test en el scope del plan.
 * @param {string} projectRoot
 * @param {string[]} [scope] - archivos/directorios a buscar
 * @returns {string[]}
 */
/* Extensiones que SI pueden tener tests relacionados. Ver el filtro del scope
   en el comando `run` para el motivo de que sea lista blanca y no negra. */
/**
 * Deja en el scope solo lo que puede tener tests relacionados.
 *
 * DOS FILTROS Y DOS HISTORIAS
 * ---------------------------
 * 1 · Estado del motor. El gate ensucia memoria.db al correr, y en proyectos
 *     que la versionan el scope quedaba como [.agentic/...] → 0 tests →
 *     fallo mudo en cada post-cycle (FLOTA360, 2026-07-19).
 *
 * 2 · Todo lo que no es codigo. Un .md no tiene tests relacionados: dejarlo
 *     manda al buscador a rastrear su carpeta, no encontrar nada, y abortar
 *     con "No se encontraron archivos de test" — en un repo con 17 archivos
 *     de test y 99 verdes.
 *
 *     Caso real (03/09/2026, este mismo repo): el unico archivo modificado era
 *     `_output/log-2026-09.md`, el registro que EL PROPIO post-cycle escribe al
 *     terminar. 61 ciclos seguidos con 0 contratos, y un Preservation Gate que
 *     no protegia nada.
 *
 * El segundo filtro es lista BLANCA a proposito. La lista negra por carpeta ya
 * fallo dos veces, y por el mismo motivo las dos: siempre aparece una carpeta
 * que nadie penso. Lo que no es codigo no entra, se llame como se llame.
 *
 * Si tras filtrar no queda nada, scope vacio = escaneo completo del proyecto,
 * que es lo correcto para un arbol limpio.
 */
function filtrarScope(scope) {
  return (scope || [])
    .filter(f => !/^(\.agentic|\.claude|\.git|node_modules|dist|build|coverage)[\/]/.test(f))
    .filter(f => ES_CODIGO_FUENTE.test(f));
}

const ES_CODIGO_FUENTE = /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|py|rb|go|java|kt|php|cs|rs|sql)$/i;

function findTestFiles(projectRoot, scope = []) {
  const testPatterns = [
    /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/,
    /__(tests?)__\//,
    /test\/.*\.(ts|js)$/,
    // Prefijo test-* / spec-* (convención común que el motor ignoraba — hueco
    // #4 del Coliseo, 2026-07-20: un cliente con `test-catalogos.js` en
    // `web/scripts/` nunca registraba contratos porque ningún patrón matcheaba).
    // Se ancla al nombre base para no confundir un dir `test-fixtures/`.
    /(^|[\\/])(test|spec)-[^\\/]+\.(ts|tsx|js|jsx|mjs|cjs)$/i,
    // Python
    /test_.*\.py$/,
    /.*_test\.py$/,
    /tests\/.*\.py$/,
  ];

  const results = [];

  const searchDir = (dir, maxDepth = 5, depth = 0) => {
    if (depth > maxDepth) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const fullPath = path.join(dir, e.name);
        if (e.isDirectory()) {
          searchDir(fullPath, maxDepth, depth + 1);
        } else if (testPatterns.some(p => p.test(fullPath))) {
          results.push(path.relative(projectRoot, fullPath));
        }
      }
    } catch {}
  };

  if (scope.length > 0) {
    // Buscar tests relacionados con los archivos del scope
    for (const f of scope) {
      const base = path.basename(f, path.extname(f));
      const dir = path.dirname(path.join(projectRoot, f));
      searchDir(dir);
      // También buscar en __tests__ relativo
      const testDir = path.join(path.dirname(path.join(projectRoot, f)), '__tests__');
      if (fs.existsSync(testDir)) searchDir(testDir);
    }
  } else {
    searchDir(projectRoot);
  }

  return [...new Set(results)];
}

// ─── SELF-HEALING LOOP ────────────────────────────────────────────────────────

/**
 * Carga el estado del TDD gate desde el archivo de estado.
 */
function loadState(projectRoot) {
  const statePath = path.join(projectRoot, TDD_STATE_FILE);
  if (fs.existsSync(statePath)) {
    try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}
  }
  return null;
}

function saveState(projectRoot, state) {
  const statePath = path.join(projectRoot, TDD_STATE_FILE);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function clearState(projectRoot) {
  const statePath = path.join(projectRoot, TDD_STATE_FILE);
  if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
}

/**
 * LOOP PRINCIPAL DE SELF-HEALING
 *
 * @param {object} opts
 *   projectRoot: string
 *   area: string (área del módulo)
 *   scope: string[] (archivos tocados en la fase actual)
 *   testCommand: string|null (null = autodetectar)
 * @returns {object} resultado con allPassed, iterations, etc.
 */
function runSelfHealingLoop(opts) {
  const { projectRoot = process.cwd(), area = 'global', scope = [], testCommand = null } = opts;

  const command = testCommand || detectTestCommand(projectRoot);
  if (!command) {
    return {
      success: false,
      allPassed: false,
      reason: 'No se detectó comando de tests. Configurar test: en config.md.',
      tests_found: [],
      iterations: 0,
    };
  }

  const testFiles = findTestFiles(projectRoot, scope);

  if (testFiles.length === 0) {
    return {
      success: false,
      allPassed: false,
      reason: 'No se encontraron archivos de test. TDD es OBLIGATORIO — crear tests antes de avanzar.',
      tests_found: [],
      iterations: 0,
      command,
    };
  }

  const maxIter = opts.maxIterations || MAX_HEALING_ITERATIONS;
  const subject = opts.subjectHash || subjectHash(projectRoot);
  const previo = loadState(projectRoot);
  const mismoSujetoDeTrabajo = previo && previo.command === command && previo.area === area;
  const history = mismoSujetoDeTrabajo && Array.isArray(previo.history) ? previo.history.slice() : [];
  let iteration = 1;

  const cerrar = (extra) => {
    const r = Object.assign({
      success: false, allPassed: false,
      iterations: iteration, tests_found: testFiles,
      tests_passing: 0, tests_failing: 0, failing_tests: [], regressions: [],
      command, area, history, subject_hash: subject,
    }, extra);
    _printTDDReport(r);
    return r;
  };

  if (mismoSujetoDeTrabajo) {
    if (previo.blocked) {
      return cerrar({
        status: 'BLOCKED', reason_code: previo.reason_code, iterations: previo.iteration,
        failing_tests: previo.failures || [],
        stop_reason: 'Bloqueado tras ' + previo.iteration + ' intentos. Revisión humana y `tdd-gate.cjs clear`.',
      });
    }
    if (previo.subject_hash === subject) {
      return cerrar({
        status: 'NEEDS_REPAIR', reason_code: 'NO_REPAIR_SINCE_LAST_FAIL', iterations: previo.iteration,
        failing_tests: previo.failures || [],
        stop_reason: 'El código no cambió desde el último fallo: reparar antes de reintentar.',
      });
    }
    iteration = previo.iteration + 1;
  }

  console.log(`\n[TDD-GATE] Comando: ${command}`);
  console.log(`[TDD-GATE] Tests encontrados: ${testFiles.length}`);
  console.log(`[TDD-GATE] Área: ${area}`);
  console.log(`[TDD-GATE] Intento ${iteration}/${maxIter}\n`);

  const result = runTests(command, projectRoot, null, { subject_hash: subject, cycle_id: opts.cycleId });

  // v3.15.2 (Grieta R10): "los tests pasan" no es lo mismo que "el proyecto
  // compila" cuando el runner (tsx/esbuild) no verifica tipos.
  if (result.allPassed) {
    const tcCmd = detectTypecheckCommand(projectRoot);
    if (tcCmd) {
      const tc = runTypecheck(tcCmd, projectRoot);
      console.log(`[TDD-GATE] Typecheck (${tcCmd}): ${tc.passed ? '✅ PASS' : '❌ FAIL'}`);
      if (!tc.passed) {
        result.allPassed = false;
        result.status = 'FAIL';
        result.reason_code = 'TYPECHECK_FAILED';
        result.failed = (result.failed || 0) + 1;
        result.failures = [...(result.failures || []), `TYPECHECK: ${tc.output.slice(0, 500)}`];
        result.gate = createGateResult(Object.assign({}, result.gate, { status: 'FAIL', reason_code: 'TYPECHECK_FAILED' }));
      }
    }
  }

  const firma = crypto.createHash('sha256').update([...(result.failures || [])].sort().join('\n')).digest('hex');
  history.push({ iteration, status: result.status, reason_code: result.reason_code, subject_hash: subject, failure_signature: firma });

  console.log(`[TDD-GATE] Resultado: ${result.status}${result.reason_code ? ' (' + result.reason_code + ')' : ''}`);
  console.log(`[TDD-GATE] Total: ${result.total} | Pasando: ${result.passed} | Fallando: ${result.failed}`);

  const base = {
    iterations: iteration,
    tests_passing: result.passed,
    tests_failing: result.failed,
    failing_tests: result.failures,
    gate: result.gate,
  };

  if (result.allPassed) {
    const registro = registrarContratosDelResultado(projectRoot, area, command, scope, testFiles, result);
    clearState(projectRoot);
    return cerrar(Object.assign(base, {
      success: true, allPassed: true, status: 'PASS', contracts: registro,
      preservation: registro.preservacion || null,
    }));
  }

  base.preservation = verificarPreservacion(projectRoot, scope, testFiles, result);

  const mismoFallo = mismoSujetoDeTrabajo && previo.failure_signature === firma;
  const repetidos = mismoFallo ? (previo.same_failure_count || 1) + 1 : 1;
  let status = 'NEEDS_REPAIR';
  let reason = result.reason_code;
  let blocked = false;
  if (result.status === 'ERROR' || result.status === 'UNVERIFIED') {
    status = result.status;
  }
  if (repetidos >= 2 && iteration > 1) { status = 'BLOCKED'; reason = 'SAME_FAILURE_AFTER_REPAIR'; blocked = true; }
  else if (iteration >= maxIter) { status = 'BLOCKED'; reason = 'MAX_ITERATIONS'; blocked = true; }

  saveState(projectRoot, {
    iteration, area, command, testFiles,
    subject_hash: subject,
    failure_signature: firma,
    same_failure_count: repetidos,
    failures: result.failures,
    failed: result.failed,
    status, reason_code: reason, blocked,
    history,
    timestamp: new Date().toISOString(),
  });

  return cerrar(Object.assign(base, {
    status, reason_code: reason,
    stop_reason: blocked
      ? `Bloqueado (${reason}) en el intento ${iteration}. Requiere intervención humana.`
      : `${result.status} (${result.reason_code}). Reparar el código y volver a correr: el reintento exige un cambio.`,
  }));
}

/** Corrida fallida: los escenarios protegidos que fallaron quedan violados. */
function verificarPreservacion(projectRoot, scope, testFiles, result) {
  const root = projectRoot || process.cwd();
  const dbPath = path.join(root, '.agentic/memoria.db');
  if (!fs.existsSync(dbPath)) return { status: 'UNVERIFIED', reason_code: 'SIN_MEMORIA' };
  let DB = null;
  try {
    const rg = require(path.join(__dirname, 'regression-guard.cjs'));
    const esc = require(path.join(__dirname, 'escenarios.cjs'));
    DB = openProjectDB(dbPath, projectRoot);
    if (!DB) return { status: 'UNVERIFIED', reason_code: 'DB_NO_DISPONIBLE' };
    const tested = esc.evidenciaDeCorrida(root, result, testFiles);
    const verdict = rg.verifyAfterTDD(DB, tested, scope, root);
    const id = crypto.randomUUID(), source = result.source_evidence || require('./source-evidence.cjs').capture(root);
    const status = verdict.status === 'NO_APLICA' ? 'NO_APLICA' : verdict.status;
    esc.guardarArtefacto(root, { execution_id: id, gate: 'preservation', subject_hash: tested.subject_hash,
      cycle_id: tested.cycle_id, provenance: 'gate-check', comprobador: 'regression-guard:selection-and-verify',
      status, runner_status: status, assertions: status === 'NO_APLICA' ? 1 : verdict.verified || 0,
      runner_hash: require('./evidence-cache.cjs').huellaRunner(root), source_files: source.files, source_manifest_hash: source.hash,
      expected: [], executed: [], escenarios: {}, runner_execution_id: tested.execution_id });
    return { ...verdict, execution_id: id, subject_hash: tested.subject_hash, policy_id: esc.POLICY_ID };
  } catch (e) {
    return { status: 'ERROR', reason_code: e.message };
  } finally {
    if (DB) try { DB.close(); } catch { /* ya cerrada */ }
  }
}

function registrarContratosDelResultado(projectRoot, area, command, scope, testFiles, result) {
  const salida = { contracts: null, behavior: null };
  const dbPath = path.join(projectRoot || process.cwd(), '.agentic/memoria.db');
  if (!fs.existsSync(dbPath)) return salida;
  try {
    const cg = require(path.join(__dirname, 'contract-guard.cjs'));
    const DB = openProjectDB(dbPath, projectRoot);
    if (DB && typeof cg.registerPassingTests === 'function') {
      salida.contracts = cg.registerPassingTests(DB, {
        area: area || 'global',
        command,
        runner_id: command,
        execution_id: result.gate && result.gate.execution_id,
        subject_hash: result.gate && result.gate.subject_hash,
        tests: result.tests || [],
        passed: result.passed,
        total: result.total,
      });
      const c = salida.contracts || {};
      console.log(`[TDD-GATE] 📋 Contracts: ${c.status || '—'} · ${c.updated || 0} actualizados · ${c.created || 0} nuevos`);
    }
    if (DB) DB.close();
  } catch (e) { salida.contracts = { status: 'ERROR', reason_code: e.message }; }

  try {
    const rgPath = path.join(__dirname, 'regression-guard.cjs');
    if (fs.existsSync(rgPath)) {
      const rg = require(rgPath);
      const esc = require(path.join(__dirname, 'escenarios.cjs'));
      const root = projectRoot || process.cwd();
      const DB2 = openProjectDB(dbPath, projectRoot);
      if (DB2) {
        const evidencia = esc.evidenciaDeCorrida(root, result, testFiles);
        salida.evidencia = evidencia;
        salida.preservacion = rg.verifyAfterTDD(DB2, evidencia, scope, root);
        salida.behavior = rg.registerBehavior(DB2, {
          module: area || 'global', files: scope, testFiles, evidencia, projectRoot: root,
        });
        if (salida.behavior) {
          const n = (salida.behavior.escenarios || []).length;
          const ok = (salida.behavior.escenarios || []).filter((e) => e.acreditado).length;
          console.log(`[TDD-GATE] 🛡️  Escenarios [${salida.behavior.module}]: ${n} registrados · ${ok} verificados en esta corrida`);
        }
        console.log(`[TDD-GATE] 🛡️  Preservación: ${salida.preservacion.status}${salida.preservacion.reason_code ? ' (' + salida.preservacion.reason_code + ')' : ''}`);
        DB2.close();
      }
    }
  } catch (e) { /* regression guard opcional */ }
  return salida;
}

function _printTDDReport(r) {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  🧪 TDD-GATE REPORTE FINAL');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Resultado:         ${r.success ? '✅ PASS' : '🛑 ' + (r.status || 'STOP')}${r.reason_code ? ' (' + r.reason_code + ')' : ''}`);
  console.log(`  Tests encontrados: ${r.tests_found.length}`);
  console.log(`  Pasando:           ${r.tests_passing}`);
  console.log(`  Fallando:          ${r.tests_failing}`);
  console.log(`  Intento:           ${r.iterations} (max ${MAX_HEALING_ITERATIONS})`);
  if (!r.success && r.stop_reason) {
    console.log(`\n  ⛔ ${r.stop_reason}`);
  }
  console.log('═══════════════════════════════════════════════════\n');
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const [,, command, ...args] = process.argv;
  const projectRoot = process.cwd();

  switch (command) {
    case 'run': {
      const area = args[0] || 'global';
      // Changeset real (staged+unstaged+untracked) para que Regression Guard
      // pueda asociar el behavior a archivos concretos — sin esto related_files
      // queda vacío y checkBeforeBuild() nunca puede matchear nada.
      let scope = [];
      try {
        const gitContext = require('./git-context.cjs');
        if (gitContext.gitDisponible(projectRoot)) {
          const diff = gitContext.getDiff(projectRoot);
          scope = [...diff.archivos_modificados, ...diff.archivos_nuevos];
        }
      } catch (e) { /* sin git — scope vacío, igual que antes */ }
      // Estado interno del motor fuera del scope: el gate MISMO ensucia
      // memoria.db al correr, y en proyectos que la versionan eso hacía que
      // el scope fuera solo [.agentic/...] → 0 tests relacionados → fallo
      // mudo en cada post-cycle (encontrado corriendo sobre FLOTA360,
      // 2026-07-19). Si tras filtrar no queda nada, scope vacío = escaneo
      // completo del proyecto, que es lo correcto para un árbol limpio.
      // Excluir estado del motor y config del entorno (no son código fuente
      // del proyecto): .agentic/, .claude/, .git/, node_modules/, dist/build.
      scope = filtrarScope(scope);
      const result = runSelfHealingLoop({ projectRoot, area, scope });
      try {
        fs.writeFileSync(path.join(projectRoot, '.agentic', '_tdd_ultimo.json'), JSON.stringify({
          area, success: !!result.success, status: result.status || null, reason_code: result.reason_code || null,
          passed: result.tests_passing || 0, failed: result.tests_failing || 0,
          subject_hash: result.subject_hash || null,
          execution_id: result.gate ? result.gate.execution_id : null,
          contracts: result.contracts && result.contracts.contracts ? result.contracts.contracts : null,
          finished_at: new Date().toISOString(),
        }, null, 2));
      } catch { /* el veredicto ya salió por el código de salida */ }
      // El fallo era invisible: run devolvía reason sin imprimirla y el exit 1
      // parecía un crash mudo. Ahora la razón siempre se ve.
      if (!result.success && (result.reason || result.stop_reason)) {
        console.log(`[TDD-GATE] ❌ ${result.reason || result.stop_reason}`);
      }
      process.exit(result.success ? 0 : 1);
      break;
    }
    case 'detect': {
      const cmd = detectTestCommand(projectRoot);
      console.log(cmd ? `Comando detectado: ${cmd}` : 'No se detectó comando de tests');
      break;
    }
    case 'status': {
      const state = loadState(projectRoot);
      if (state) {
        console.log('Estado TDD actual:', JSON.stringify(state, null, 2));
      } else {
        console.log('Sin estado TDD activo');
      }
      break;
    }
    case 'clear': {
      clearState(projectRoot);
      console.log('Estado TDD limpiado');
      break;
    }
    case 'find': {
      const files = findTestFiles(projectRoot);
      console.log(`Tests encontrados (${files.length}):\n${files.join('\n')}`);
      break;
    }
    default:
      console.log('Uso: node tdd-gate.cjs [run [area] | detect | status | clear | find]');
  }
}

module.exports = {
  runSelfHealingLoop,
  runTests,
  parseTestOutput,
  findTestFiles,
  subjectHash,
  loadState,
  clearState,
  detectTestCommand, filtrarScope, ES_CODIGO_FUENTE};
