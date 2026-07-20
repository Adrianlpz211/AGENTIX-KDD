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

const { execSync, spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

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
function runTests(command, projectRoot, testFile = null) {
  const fullCmd = testFile ? `${command} -- ${testFile}` : command;

  let output = '';
  let errorOutput = '';
  let exitCode = 0;

  try {
    // Windows: use cmd.exe, Unix: use sh
    const isWin = process.platform === 'win32';
    const shell = isWin ? 'cmd.exe' : 'sh';
    const shellFlag = isWin ? '/c' : '-c';
    const shellCmd = isWin ? fullCmd : fullCmd + ' 2>&1';

    const result = spawnSync(
      shell, [shellFlag, shellCmd],
      // Plan 5 T8: configurable — suites reales pesadas superan los 120s
      { cwd: projectRoot, timeout: parseInt(process.env.AKDD_TEST_TIMEOUT_MS, 10) || 120000, stdio: 'pipe', encoding: 'utf8' }
    );
    output = (result.stdout || '') + (isWin ? (result.stderr || '') : '');
    errorOutput = result.stderr || '';
    exitCode = result.status ?? 1;
  } catch (err) {
    return {
      allPassed: false, total: 0, passed: 0, failed: 1,
      failures: [`ERROR ejecutando tests: ${err.message}`],
      output: '', error: err.message
    };
  }

  return parseTestOutput(output + errorOutput, exitCode);
}

/**
 * Parsea el output de múltiples frameworks de testing.
 * Soporta: jest, vitest, mocha, jasmine, tap, pytest (output básico).
 */
function parseTestOutput(raw, exitCode) {
  // Strip ANSI color codes — Vitest adds them and break regex matching
  raw = (raw || '').replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

  const result = {
    allPassed: exitCode === 0,
    total: 0, passed: 0, failed: 0,
    failures: [], output: raw, error: null
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
  const nodeTestTotal = raw.match(/^[ℹi#]\s*tests\s+(\d+)/im);
  const nodeTestPass  = raw.match(/^[ℹi#]\s*pass\s+(\d+)/im);
  const nodeTestFail  = raw.match(/^[ℹi#]\s*fail\s+(\d+)/im);
  if (nodeTestTotal && result.total === 0) {
    result.total  = parseInt(nodeTestTotal[1] || '0');
    result.passed = parseInt(nodeTestPass?.[1] || '0');
    result.failed = parseInt(nodeTestFail?.[1] || '0');
  }

  // ── pytest (básico) ──────────────────────────────────────────────────────
  // "5 passed, 2 failed in 1.23s"
  const pytestSummary = raw.match(/(\d+)\s+passed(?:,\s*(\d+)\s+failed)?/i);
  if (pytestSummary && result.total === 0) {
    result.passed = parseInt(pytestSummary[1] || '0');
    result.failed = parseInt(pytestSummary[2] || '0');
    result.total  = result.passed + result.failed;
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

  // ── Fallback: si exitCode !== 0 y no parseamos nada ─────────────────────
  if (exitCode !== 0 && result.total === 0) {
    result.allPassed = false;
    result.failed = 1;
    if (result.failures.length === 0) {
      // Extraer la primera línea de error
      const errorLine = raw.split('\n').find(l => /error|fail|cannot|unexpected/i.test(l));
      if (errorLine) result.failures.push(errorLine.trim().substring(0, 120));
      else result.failures.push('Error desconocido — revisar output completo');
    }
  }

  // Si no se reconoció NINGÚN resultado de test, NO asumir PASS (gate de calidad):
  // un exitCode 0 espurio (común con `cmd /c` en Windows) no debe dar verde con tests rotos.
  if (result.passed === 0 && result.failed === 0 && result.total === 0) {
    result.allPassed = false;
  } else {
    // En Windows, "cd backend && pytest" puede retornar exitCode != 0 aunque los tests pasen.
    // Si passed > 0 y failed === 0, es PASS.
    result.allPassed = result.failed === 0 && (exitCode === 0 || result.passed > 0);
  }
  return result;
}

/**
 * Encuentra archivos de test en el scope del plan.
 * @param {string} projectRoot
 * @param {string[]} [scope] - archivos/directorios a buscar
 * @returns {string[]}
 */
function findTestFiles(projectRoot, scope = []) {
  const testPatterns = [
    /\.(test|spec)\.(ts|tsx|js|jsx)$/,
    /__(tests?)__\//,
    /test\/.*\.(ts|js)$/,
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

  console.log(`\n[TDD-GATE] Comando: ${command}`);
  console.log(`[TDD-GATE] Tests encontrados: ${testFiles.length}`);
  console.log(`[TDD-GATE] Área: ${area}`);
  console.log(`[TDD-GATE] Max iteraciones: ${MAX_HEALING_ITERATIONS}\n`);

  let iteration = 0;
  let lastResult = null;
  const history = [];

  // ── LOOP ──────────────────────────────────────────────────────────────────
  while (iteration < MAX_HEALING_ITERATIONS) {
    iteration++;
    console.log(`[TDD-GATE] ── Iteración ${iteration}/${MAX_HEALING_ITERATIONS} ──`);

    const result = runTests(command, projectRoot);
    lastResult = result;
    history.push({ iteration, ...result });

    console.log(`[TDD-GATE] Resultado: ${result.allPassed ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`[TDD-GATE] Total: ${result.total} | Pasando: ${result.passed} | Fallando: ${result.failed}`);

    // v3.15.2 (Grieta R10): "los tests pasan" no es lo mismo que "el proyecto
    // compila" cuando el runner (tsx/esbuild) no verifica tipos. Si hay un
    // script typecheck, correrlo aquí — antes de declarar PASS y registrar
    // contratos — cierra ese hueco sin inventar un gate nuevo que el agente
    // pueda olvidar correr aparte.
    if (result.allPassed) {
      const tcCmd = detectTypecheckCommand(projectRoot);
      if (tcCmd) {
        const tc = runTypecheck(tcCmd, projectRoot);
        console.log(`[TDD-GATE] Typecheck (${tcCmd}): ${tc.passed ? '✅ PASS' : '❌ FAIL'}`);
        if (!tc.passed) {
          result.allPassed = false;
          result.failed = (result.failed || 0) + 1;
          result.failures = [...(result.failures || []), `TYPECHECK: ${tc.output.slice(0, 500)}`];
          history[history.length - 1] = { iteration, ...result };
        }
      }
    }

    if (result.allPassed) {
      console.log(`\n[TDD-GATE] ✅ PASS en iteración ${iteration}`);

      // Auto-register passing tests as contract candidates
      try {
        const contractGuardPath = require('path').join(__dirname, 'contract-guard.cjs');
        const cg = require(contractGuardPath);
        const dbPath = require('path').join(projectRoot || process.cwd(), '.agentic/memoria.db');
        const DB = openProjectDB(dbPath, projectRoot);
        if (DB && cg && typeof cg.registerPassingTests === 'function') {
          cg.registerPassingTests(DB, { passed: result.passed, total: result.total, area: area || 'global', command });
          console.log(`[TDD-GATE] 📋 Contracts: ${result.passed} tests → candidates`);
        }

        // Auto-register protected behavior snapshot
        try {
          const rgPath = require('path').join(__dirname, 'regression-guard.cjs');
          if (require('fs').existsSync(rgPath)) {
            const rg = require(rgPath);
            const DB2 = openProjectDB(dbPath, projectRoot);
            if (DB2) {
              const behavior = rg.registerBehavior(DB2, {
                module:      area || 'global',
                files:       scope,
                testFiles:   testFiles,
                projectRoot: projectRoot || process.cwd(),
              });
              if (behavior) {
                console.log(`[TDD-GATE] 🛡️  Behavior: [${behavior.module}] ${behavior.confidence} (cycle ${behavior.pass_count})`);
              }
              DB2.close();
            }
          }
        } catch(e) { /* regression guard optional */ }

        if (DB) DB.close();
      } catch(e) { /* contract guard optional */ }

      break;
    }

    if (iteration < MAX_HEALING_ITERATIONS) {
      console.log(`[TDD-GATE] Fallando tests: ${result.failures.slice(0, 5).join(', ')}`);
      console.log(`[TDD-GATE] 🔄 Señal de healing enviada al agente para iteración ${iteration + 1}`);
      console.log(`[TDD-GATE] Diagnóstico necesario: revisar error → aplicar fix → re-ejecutar\n`);

      // Guardar estado para que el agente sepa en qué iteración está
      saveState(projectRoot, {
        iteration,
        lastResult: result,
        area,
        command,
        testFiles,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // ── SUITE COMPLETA (verificar regresiones) ────────────────────────────────
  let regressions = [];
  if (lastResult?.allPassed) {
    console.log('\n[TDD-GATE] Verificando suite completa para detectar regresiones...');
    const suiteResult = runTests(command, projectRoot);
    if (!suiteResult.allPassed) {
      regressions = suiteResult.failures;
      console.log(`[TDD-GATE] ⚠️ Regresiones detectadas: ${regressions.join(', ')}`);
    } else {
      console.log('[TDD-GATE] ✅ Suite completa: sin regresiones');
    }
  }

  const finalResult = {
    success: lastResult?.allPassed && regressions.length === 0,
    allPassed: lastResult?.allPassed ?? false,
    iterations: iteration,
    tests_found: testFiles,
    tests_passing: lastResult?.passed ?? 0,
    tests_failing: lastResult?.failed ?? 0,
    failing_tests: lastResult?.failures ?? [],
    regressions,
    command,
    area,
    history,
  };

  if (!finalResult.success) {
    finalResult.stop_reason = lastResult?.allPassed
      ? `Regresiones introducidas: ${regressions.join(', ')}`
      : `Tests fallando después de ${iteration} iteraciones. Requiere intervención humana.`;
  }

  // Limpiar estado si terminamos
  clearState(projectRoot);

  // Imprimir reporte
  _printTDDReport(finalResult);

  return finalResult;
}

function _printTDDReport(r) {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  🧪 TDD-GATE REPORTE FINAL');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Resultado:         ${r.success ? '✅ PASS' : '🛑 STOP'}`);
  console.log(`  Tests encontrados: ${r.tests_found.length}`);
  console.log(`  Pasando:           ${r.tests_passing}`);
  console.log(`  Fallando:          ${r.tests_failing}`);
  console.log(`  Iteraciones:       ${r.iterations} (max ${MAX_HEALING_ITERATIONS})`);
  console.log(`  Regresiones:       ${r.regressions.length === 0 ? '0 ✓' : r.regressions.join(', ')}`);
  if (!r.success && r.stop_reason) {
    console.log(`\n  ⛔ STOP: ${r.stop_reason}`);
    console.log('  Acción requerida: diagnóstico e intervención humana.');
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
      scope = scope.filter(f => !/^\.agentic[\\\/]/.test(f));
      const result = runSelfHealingLoop({ projectRoot, area, scope });
      // El fallo era invisible: run devolvía reason sin imprimirla y el exit 1
      // parecía un crash mudo. Ahora la razón siempre se ve.
      if (!result.success && result.reason) console.log(`[TDD-GATE] ❌ ${result.reason}`);
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
  detectTestCommand,
};
