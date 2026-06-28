'use strict';
/**
 * Agentic KDD — Analyzer v1.0
 * Verificación de consistencia cross-artefacto.
 * Compara specs, código y tests para detectar inconsistencias antes de que
 * el agente las encuentre en producción.
 *
 * Uso:
 *   node .agentic/grafo/akdd-analyze.cjs run        → análisis completo
 *   node .agentic/grafo/akdd-analyze.cjs contracts  → verifica contratos vs tests
 *   node .agentic/grafo/akdd-analyze.cjs memory     → verifica memoria vs código
 *   node .agentic/grafo/akdd-analyze.cjs spec       → verifica spec vs código
 */

const fs   = require('fs');
const path = require('path');

const ROOT         = process.cwd();
const AGENTIC_DIR  = path.join(ROOT, '.agentic');
const MEMORIA_DIR  = path.join(AGENTIC_DIR, 'memoria');
const CONFIG_FILE  = path.join(AGENTIC_DIR, 'config.md');
const SPECS_DIR    = path.join(AGENTIC_DIR, 'specs');

// ── Findings ──────────────────────────────────────────────────────────────────

const findings = [];

function addFinding(severity, category, message, suggestion) {
  findings.push({ severity, category, message, suggestion });
}

// ── Check 1: Contratos vs test files ─────────────────────────────────────────

function checkContractsVsTests() {
  // Open the SQLite DB if available
  const dbPath = path.join(AGENTIC_DIR, 'memoria.db');
  if (!require('fs').existsSync(dbPath)) {
    addFinding('INFO', 'contracts', 'memoria.db no encontrada — sin contratos que verificar', 'Corre akdd init y algunos ciclos aa:');
    return;
  }

  let db;
  try {
    const projNodeModules = path.join(ROOT, 'node_modules');
    if (!module.paths.includes(projNodeModules)) module.paths.unshift(projNodeModules);
    db = new (require('better-sqlite3'))(dbPath);
  } catch(e) {
    addFinding('WARN', 'contracts', 'No se pudo abrir memoria.db: ' + e.message, 'Verifica que better-sqlite3 está instalado');
    return;
  }

  try {
    const contracts = db.prepare("SELECT * FROM verified_contracts WHERE status != 'invalidated'").all();

    if (contracts.length === 0) {
      addFinding('INFO', 'contracts', 'Sin contratos registrados aún', 'Corre ciclos aa: para acumular contratos');
      return;
    }

    // Check each contract's test file still exists
    for (const c of contracts) {
      if (c.test_file && c.test_file !== 'npm test' && c.test_file !== 'pytest') {
        const testPath = path.join(ROOT, c.test_file);
        if (!fs.existsSync(testPath)) {
          addFinding('HIGH', 'contracts',
            `Contrato [${c.id}] referencia "${c.test_file}" que ya no existe`,
            `Corre akdd contracts verify para actualizar el contrato`);
        }
      }

      // Warn on stale protected contracts
      if (c.status === 'protected' && c.last_verified) {
        const days = Math.floor((Date.now() - new Date(c.last_verified).getTime()) / 86400000);
        if (days > 30) {
          addFinding('WARN', 'contracts',
            `Contrato PROTECTED [${c.module}] no verificado en ${days} días`,
            `Corre akdd contracts gate para re-verificar`);
        }
      }
    }

    const protected_ = contracts.filter(c => c.status === 'protected').length;
    const verified   = contracts.filter(c => c.status === 'verified').length;
    addFinding('INFO', 'contracts',
      `${contracts.length} contratos: ${protected_} PROTECTED, ${verified} VERIFIED`,
      null);

  } catch(e) {
    addFinding('WARN', 'contracts', 'Error leyendo contratos: ' + e.message, null);
  } finally {
    db.close();
  }
}

// ── Check 2: Memoria vs código actual ────────────────────────────────────────

function checkMemoryVsCode() {
  const erroresFile = path.join(MEMORIA_DIR, 'errores.md');
  const patronesFile= path.join(MEMORIA_DIR, 'patrones.md');

  if (!fs.existsSync(erroresFile) && !fs.existsSync(patronesFile)) {
    addFinding('INFO', 'memory', 'Archivos de memoria no encontrados', 'Corre akdd init');
    return;
  }

  // Check patrones.md for HIGH-confidence rules and verify they're not violated in code
  if (fs.existsSync(patronesFile)) {
    const patrones = fs.readFileSync(patronesFile, 'utf8');
    const highPatterns = patrones.match(/###[^\n]+\n[\s\S]*?\*\*confianza\*\*:\s*ALTA[\s\S]*?(?=###|$)/gi) || [];

    // Basic structural checks on source files
    const srcFiles = findSourceFiles(ROOT);

    for (const pattern of highPatterns) {
      const titleMatch = pattern.match(/###\s+(.+)/);
      const ruleMatch  = pattern.match(/\*\*regla\*\*:\s*(.+)/i);
      if (!titleMatch || !ruleMatch) continue;

      const rule = ruleMatch[1].toLowerCase();

      // Check: if rule mentions "tenant" or "agency_id", verify files filter by it
      if ((rule.includes('tenant') || rule.includes('agency_id')) && srcFiles.length > 0) {
        const routeFiles = srcFiles.filter(f => f.includes('route') || f.includes('router') || f.includes('api'));
        const violations = routeFiles.filter(f => {
          const content = safeRead(f);
          return content && content.includes('findMany') && !content.includes('agency_id') &&
                 !content.includes('tenant') && !content.includes('TESTING');
        });
        if (violations.length > 0) {
          addFinding('HIGH', 'memory',
            `Patrón HIGH "${titleMatch[1]}" puede estar violado en: ${violations.slice(0,3).map(f => path.relative(ROOT,f)).join(', ')}`,
            `Revisar manualmente — patrón: ${rule}`);
        }
      }
    }

    addFinding('INFO', 'memory', `${highPatterns.length} patrones HIGH verificados contra código`, null);
  }

  // Check errores.md size
  if (fs.existsSync(erroresFile)) {
    const errLines = fs.readFileSync(erroresFile, 'utf8').split('\n').filter(l => l.startsWith('### ')).length;
    if (errLines > 50) {
      addFinding('WARN', 'memory',
        `errores.md tiene ${errLines} entradas — puede degradar el contexto del agente`,
        `Corre: node .agentic/grafo/mem-curator.cjs run`);
    }
  }
}

// ── Check 3: Config vs stack real ────────────────────────────────────────────

function checkConfigVsStack() {
  if (!fs.existsSync(CONFIG_FILE)) {
    addFinding('HIGH', 'config', 'config.md no encontrado', 'Corre akdd init');
    return;
  }

  const config = fs.readFileSync(CONFIG_FILE, 'utf8');

  // Check test command is configured
  const testMatch = config.match(/^\s*test:\s*(.+)$/m);
  if (!testMatch || testMatch[1].trim() === '—' || testMatch[1].trim() === '') {
    addFinding('HIGH', 'config',
      'Comando de tests no configurado en config.md',
      'Agrega: test: npm test  (o el comando de tu stack)');
  } else {
    addFinding('INFO', 'config', `Comando de tests: ${testMatch[1].trim()}`, null);
  }

  // Check Python project has test command pointing to pytest
  const hasPython = fs.existsSync(path.join(ROOT, 'backend', 'requirements.txt')) ||
                    fs.existsSync(path.join(ROOT, 'requirements.txt'));
  if (hasPython && testMatch && !testMatch[1].includes('pytest')) {
    addFinding('WARN', 'config',
      'Proyecto Python detectado pero test: no usa pytest',
      `Cambia a: test: cd backend && py -3.13 -m pytest -x -v`);
  }

  // Check DESIGN_SYSTEM
  const hasDesignSystem = fs.existsSync(path.join(ROOT, 'DESIGN_SYSTEM.md')) ||
                          fs.existsSync(path.join(ROOT, '.agentic', 'DESIGN_SYSTEM.md'));
  if (!hasDesignSystem) {
    addFinding('INFO', 'config', 'DESIGN_SYSTEM.md no encontrado',
      'Opcional: crea DESIGN_SYSTEM.md para que el agente Front tenga referencia de tokens');
  }
}

// ── Check 4: Specs vs código ──────────────────────────────────────────────────

function checkSpecsVsCode() {
  if (!fs.existsSync(SPECS_DIR)) {
    addFinding('INFO', 'specs', 'No hay specs registradas aún', 'Se crean automáticamente durante ciclos aa:');
    return;
  }

  const specFiles = fs.readdirSync(SPECS_DIR).filter(f => f.endsWith('.md'));
  if (specFiles.length === 0) {
    addFinding('INFO', 'specs', 'Directorio specs vacío', null);
    return;
  }

  addFinding('INFO', 'specs', `${specFiles.length} specs encontradas`, null);

  // Check specs for unresolved TODOs
  for (const specFile of specFiles) {
    const content = safeRead(path.join(SPECS_DIR, specFile)) || '';
    const todos   = (content.match(/\bTODO\b|\bPENDING\b|\bFIXME\b/gi) || []).length;
    if (todos > 0) {
      addFinding('WARN', 'specs',
        `${specFile} tiene ${todos} TODOs/PENDINGs sin resolver`,
        `Revisar y actualizar o eliminar entradas obsoletas`);
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function findSourceFiles(root, extensions = ['.ts', '.tsx', '.js', '.py']) {
  const results = [];
  const skip = new Set(['node_modules', '.agentic', '.git', '__pycache__', '.next', 'dist', 'build']);

  function walk(dir) {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (skip.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (extensions.some(e => entry.name.endsWith(e))) results.push(full);
      }
    } catch {}
  }

  walk(root);
  return results;
}

function safeRead(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return null; }
}

// ── Report printer ────────────────────────────────────────────────────────────

function printReport() {
  console.log('\n══════════════════════════════════════════════════');
  console.log('  🔍 Agentic KDD — Analyzer');
  console.log('══════════════════════════════════════════════════');

  const bySeverity = { HIGH: [], WARN: [], INFO: [] };
  for (const f of findings) {
    (bySeverity[f.severity] || bySeverity.INFO).push(f);
  }

  if (bySeverity.HIGH.length > 0) {
    console.log('\n  🔴 HIGH — requieren atención:');
    for (const f of bySeverity.HIGH) {
      console.log(`\n  [${f.category.toUpperCase()}] ${f.message}`);
      if (f.suggestion) console.log(`  → ${f.suggestion}`);
    }
  }

  if (bySeverity.WARN.length > 0) {
    console.log('\n  🟠 WARN — revisar:');
    for (const f of bySeverity.WARN) {
      console.log(`\n  [${f.category.toUpperCase()}] ${f.message}`);
      if (f.suggestion) console.log(`  → ${f.suggestion}`);
    }
  }

  if (bySeverity.INFO.length > 0) {
    console.log('\n  ✅ INFO:');
    for (const f of bySeverity.INFO) {
      console.log(`  [${f.category.toUpperCase()}] ${f.message}`);
    }
  }

  const total = findings.length;
  const issues = bySeverity.HIGH.length + bySeverity.WARN.length;
  console.log(`\n  Total: ${total} checks | Problemas: ${issues}`);

  if (issues === 0) {
    console.log('  ✅ Todo consistente — el proyecto está en buen estado.');
  } else if (bySeverity.HIGH.length > 0) {
    console.log('  ⛔ Hay inconsistencias críticas — resolver antes del próximo ciclo aa:');
    process.exit(1);
  } else {
    console.log('  ⚠️  Hay advertencias — revisar cuando sea posible.');
  }

  console.log('══════════════════════════════════════════════════\n');
}

// ── CLI ───────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const cmd = process.argv[2] || 'run';

  if (cmd === 'run') {
    checkContractsVsTests();
    checkMemoryVsCode();
    checkConfigVsStack();
    checkSpecsVsCode();
  } else if (cmd === 'contracts') {
    checkContractsVsTests();
  } else if (cmd === 'memory') {
    checkMemoryVsCode();
  } else if (cmd === 'spec') {
    checkSpecsVsCode();
  } else if (cmd === 'config') {
    checkConfigVsStack();
  } else {
    console.log('Uso: node akdd-analyze.cjs [run|contracts|memory|spec|config]');
    process.exit(0);
  }

  printReport();
}

module.exports = { checkContractsVsTests, checkMemoryVsCode, checkConfigVsStack, checkSpecsVsCode };
