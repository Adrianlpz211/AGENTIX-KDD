/**
 * Agentic KDD — Contract Guard v1.0
 * Preservation Intelligence Layer (PIL)
 *
 * El sistema no solo recuerda errores — protege activamente lo que funciona.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PROBLEMA QUE RESUELVE:                                                 │
 * │  El agente aprende "qué no hacer" pero no mantiene una lista viva de    │
 * │  "qué debe seguir funcionando". Contract Guard cierra ese gap.          │
 * │                                                                         │
 * │  Bug A → Fix A → OK                                                     │
 * │  Bug B → Fix B → Login roto (daño colateral no detectado)               │
 * │                                                                         │
 * │  Con Contract Guard:                                                    │
 * │  Bug B → Fix B → Preservation Gate detecta AUTH-001 roto → STOP        │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * FLUJO:
 *   1. Auto-genera contratos desde tests que pasan (sin intervención del dev)
 *   2. Promueve: candidate → verified → protected (basado en evidencia)
 *   3. Antes de aceptar cambios: verifica que contratos protegidos siguen verdes
 *   4. Si algo falla: STOP con reporte exacto de qué contrato se rompió
 *   5. Registra causal edges: verifies, protects, invalidated_contract
 *
 * INTEGRACIÓN:
 *   - Se hookea en tdd-gate.cjs: después de cada run exitoso
 *   - Se hookea en harness.cjs: paso ⑤ Preservation Gate
 *   - Se hookea en impact-analyzer.cjs: blast radius pre-cambio
 *
 * Uso:
 *   node contract-guard.cjs status              — estado de contratos
 *   node contract-guard.cjs list [module]       — listar contratos
 *   node contract-guard.cjs verify [module]     — revalidar contratos
 *   node contract-guard.cjs blast <file>        — blast radius de un archivo
 *   node contract-guard.cjs promote             — promover candidatos
 *   node contract-guard.cjs snapshot            — tomar snapshot actual
 *   node contract-guard.cjs diff <ciclo_id>     — diferencia antes/después
 *   node contract-guard.cjs gate                — correr Preservation Gate
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const { execSync, spawnSync } = require('child_process');

// ─── CONSTANTES ───────────────────────────────────────────────────────────────

const PROMOTION_RULES = {
  CANDIDATE_TO_VERIFIED: { min_passes: 3, max_failure_rate: 0.05 },
  VERIFIED_TO_PROTECTED: { min_passes: 7, max_failure_rate: 0.02 },
};

const BLAST_THRESHOLDS = {
  LOW:      3,   // ≤ 3 contratos afectados → safe para creative mode
  MEDIUM:   10,  // ≤ 10 → warning
  HIGH:     20,  // ≤ 20 → require extra validation
  CRITICAL: Infinity, // > 20 → block creative, force manual review
};

const STATUS = {
  CANDIDATE:   'candidate',   // < 3 passes consecutivos
  VERIFIED:    'verified',    // ≥ 3 passes, failure_rate ≤ 5%
  PROTECTED:   'protected',   // ≥ 7 passes, failure_rate ≤ 2% — intocable
  INVALIDATED: 'invalidated', // fue roto en un ciclo reciente
  DEPRECATED:  'deprecated',  // el test que lo verificaba fue eliminado
};

// ─── DB ───────────────────────────────────────────────────────────────────────

function openDB(projectRoot) {
  const dbPath = path.join(projectRoot, '.agentic/memoria.db');
  try { return new (require('better-sqlite3'))(dbPath); } catch {}
  try { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(dbPath); } catch {}
  throw new Error('No SQLite driver disponible');
}

// ─── SCHEMA MIGRATION ────────────────────────────────────────────────────────

function migrateSchema(db) {
  // verified_contracts: contratos de comportamiento verificado
  db.exec(`
    CREATE TABLE IF NOT EXISTS verified_contracts (
      id TEXT PRIMARY KEY,
      module TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      test_file TEXT,
      test_name TEXT,
      source_files TEXT DEFAULT '[]',
      inputs_signature TEXT,
      outputs_signature TEXT,
      verification_count INTEGER DEFAULT 0,
      consecutive_passes INTEGER DEFAULT 0,
      failure_count INTEGER DEFAULT 0,
      last_verified TEXT,
      last_failed TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      status TEXT DEFAULT 'candidate',
      risk_level TEXT DEFAULT 'MEDIUM',
      auto_generated INTEGER DEFAULT 1,
      ciclo_created TEXT,
      ciclo_last_verified TEXT,
      notes TEXT
    )
  `);

  // regression_snapshots: foto de tests antes de cada ciclo
  db.exec(`
    CREATE TABLE IF NOT EXISTS regression_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ciclo_id TEXT NOT NULL,
      snapshot_type TEXT NOT NULL,  -- before | after
      passing_tests TEXT DEFAULT '[]',
      failing_tests TEXT DEFAULT '[]',
      contract_ids TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // contract_violations: historial de violaciones
  db.exec(`
    CREATE TABLE IF NOT EXISTS contract_violations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id TEXT NOT NULL,
      ciclo_id TEXT,
      violation_type TEXT NOT NULL,  -- regression | invalidation | modification
      description TEXT,
      recovered INTEGER DEFAULT 0,
      recovery_ciclo TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Índices
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_contracts_module ON verified_contracts(module)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_contracts_status ON verified_contracts(status)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_snapshots_ciclo ON regression_snapshots(ciclo_id)`);
  } catch {}
}

// ─── GENERAR ID DE CONTRATO ───────────────────────────────────────────────────

function generateContractId(module, testName) {
  const prefix = module.toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 6);
  const hash = require('crypto')
    .createHash('md5')
    .update(`${module}:${testName}`)
    .digest('hex')
    .substring(0, 4)
    .toUpperCase();
  return `${prefix}-${hash}`;
}

// ─── AUTO-GENERACIÓN DESDE TEST OUTPUT ────────────────────────────────────────

/**
 * Parsea el output de tests y extrae contratos automáticamente.
 * Soporta: Jest, Vitest, Mocha, pytest.
 * @param {string} testOutput - output crudo del test runner
 * @param {string} projectRoot
 * @returns {Array} contratos detectados
 */
function extractContractsFromTestOutput(testOutput, projectRoot, cicloId) {
  const contracts = [];

  // ── Jest / Vitest parser ──────────────────────────────────────────────────
  const jestPassing = /✓|✔|PASS|√|\s+✓\s+(.+)/g;
  const jestTest = /^\s*(?:✓|✔|√)\s+(.+?)(?:\s+\(\d+\s*m?s\))?$/gm;

  let match;
  while ((match = jestTest.exec(testOutput)) !== null) {
    const testName = match[1].trim();
    if (!testName || testName.length < 3) continue;

    // Inferir módulo desde el test name
    const module = inferModuleFromTest(testName, testOutput, projectRoot);

    contracts.push({
      module,
      name: testName,
      description: `Auto-generated from passing test: ${testName}`,
      test_name: testName,
      ciclo_created: cicloId,
      status: STATUS.CANDIDATE,
    });
  }

  // ── pytest parser ─────────────────────────────────────────────────────────
  const pytestPassing = /PASSED\s+(.+?)(?:\s+-\s+(.+?))?$/gm;
  while ((match = pytestPassing.exec(testOutput)) !== null) {
    const testFile = match[1]?.trim();
    const testName = match[2]?.trim() || testFile;
    if (!testName) continue;

    const module = inferModuleFromTest(testName, testOutput, projectRoot);
    contracts.push({
      module,
      name: testName,
      description: `Auto-generated from pytest: ${testName}`,
      test_name: testName,
      test_file: testFile,
      ciclo_created: cicloId,
      status: STATUS.CANDIDATE,
    });
  }

  // ── Test suites (Jest suite names) ───────────────────────────────────────
  const suitePassing = /PASS\s+(.+\.(?:test|spec)\.[jt]sx?)/g;
  while ((match = suitePassing.exec(testOutput)) !== null) {
    const testFile = match[1].trim();
    const module = inferModuleFromFilePath(testFile);

    contracts.push({
      module,
      name: `Suite: ${path.basename(testFile, path.extname(testFile))}`,
      description: `Auto-generated from passing suite: ${testFile}`,
      test_file: testFile,
      test_name: path.basename(testFile),
      ciclo_created: cicloId,
      status: STATUS.CANDIDATE,
    });
  }

  return contracts;
}

function inferModuleFromTest(testName, fullOutput, projectRoot) {
  // Intentar inferir desde el nombre del test
  const lowerName = testName.toLowerCase();

  const modulePatterns = [
    { pattern: /auth|login|session|jwt|token|refresh/i, module: 'auth' },
    { pattern: /payment|checkout|billing|invoice|stripe/i, module: 'payments' },
    { pattern: /user|profile|account|register/i, module: 'users' },
    { pattern: /api|route|endpoint|controller/i, module: 'api' },
    { pattern: /database|db|query|migration|model/i, module: 'database' },
    { pattern: /email|notification|smtp|send/i, module: 'notifications' },
    { pattern: /file|upload|storage|image/i, module: 'storage' },
    { pattern: /dashboard|analytics|report|metric/i, module: 'analytics' },
    { pattern: /order|cart|product|inventory/i, module: 'commerce' },
  ];

  for (const { pattern, module } of modulePatterns) {
    if (pattern.test(testName)) return module;
  }

  // Extraer primera palabra como módulo
  const firstWord = testName.split(/[\s>\/\\]+/)[0].toLowerCase();
  return firstWord || 'global';
}

function inferModuleFromFilePath(filePath) {
  const parts = filePath.replace(/\\/g, '/').split('/');
  // Buscar carpeta significativa (no src, test, __tests__, spec)
  const skip = new Set(['src', 'test', 'tests', '__tests__', 'spec', 'specs', '.', '..']);
  for (const part of parts) {
    if (!skip.has(part.toLowerCase()) && !part.includes('.')) return part;
  }
  return path.basename(filePath).split('.')[0] || 'global';
}

// ─── GUARDAR / ACTUALIZAR CONTRATOS ──────────────────────────────────────────

function upsertContract(db, contract, cicloId) {
  const id = contract.id || generateContractId(contract.module, contract.name);

  const existing = db.prepare('SELECT * FROM verified_contracts WHERE id = ?').get(id);

  if (existing) {
    // Actualizar contrato existente
    const newPasses = (existing.consecutive_passes || 0) + 1;
    const newTotal  = (existing.verification_count || 0) + 1;

    db.prepare(`
      UPDATE verified_contracts SET
        verification_count = ?,
        consecutive_passes = ?,
        last_verified = datetime('now'),
        ciclo_last_verified = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(newTotal, newPasses, cicloId, id);

    // Auto-promover si cumple criterios
    autoPromote(db, id, newPasses, newTotal, existing.failure_count || 0);
  } else {
    // Crear nuevo contrato
    db.prepare(`
      INSERT OR IGNORE INTO verified_contracts
        (id, module, name, description, test_file, test_name, verification_count,
         consecutive_passes, status, ciclo_created, ciclo_last_verified, auto_generated)
      VALUES (?, ?, ?, ?, ?, ?, 1, 1, 'candidate', ?, ?, 1)
    `).run(
      id, contract.module, contract.name,
      contract.description || contract.name,
      contract.test_file || null,
      contract.test_name || contract.name,
      cicloId, cicloId
    );
  }

  return id;
}

// ─── AUTO-PROMOCIÓN ───────────────────────────────────────────────────────────

function autoPromote(db, contractId, consecutivePasses, totalPasses, failureCount) {
  const failureRate = totalPasses > 0 ? failureCount / totalPasses : 0;
  const contract = db.prepare('SELECT status FROM verified_contracts WHERE id = ?').get(contractId);
  if (!contract) return;

  let newStatus = contract.status;

  if (contract.status === STATUS.CANDIDATE) {
    const rule = PROMOTION_RULES.CANDIDATE_TO_VERIFIED;
    if (consecutivePasses >= rule.min_passes && failureRate <= rule.max_failure_rate) {
      newStatus = STATUS.VERIFIED;
    }
  }

  if (contract.status === STATUS.VERIFIED || newStatus === STATUS.VERIFIED) {
    const rule = PROMOTION_RULES.VERIFIED_TO_PROTECTED;
    if (consecutivePasses >= rule.min_passes && failureRate <= rule.max_failure_rate) {
      newStatus = STATUS.PROTECTED;
    }
  }

  if (newStatus !== contract.status) {
    db.prepare(`
      UPDATE verified_contracts SET status = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(newStatus, contractId);
    console.log(`[CONTRACT] Promoted ${contractId}: ${contract.status} → ${newStatus}`);
  }
}

// ─── REGISTRAR FALLO DE CONTRATO ─────────────────────────────────────────────

function recordContractFailure(db, contractId, cicloId, description) {
  // Actualizar contrato
  db.prepare(`
    UPDATE verified_contracts SET
      failure_count = failure_count + 1,
      consecutive_passes = 0,
      last_failed = datetime('now'),
      status = CASE WHEN status = 'protected' THEN 'invalidated' ELSE status END,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(contractId);

  // Registrar violación
  db.prepare(`
    INSERT INTO contract_violations (contract_id, ciclo_id, violation_type, description)
    VALUES (?, ?, 'regression', ?)
  `).run(contractId, cicloId, description || 'Contract failed during cycle');

  // Registrar causal edge
  try {
    db.prepare(`
      INSERT OR IGNORE INTO relaciones_semanticas
        (desde_entidad, tipo, hacia_entidad, descripcion, confidence, valid_at)
      VALUES (?, 'invalidated_contract', ?, ?, 'HIGH', datetime('now'))
    `).run(cicloId || 'unknown_cycle', contractId, description || 'regression detected');
  } catch {}
}

// ─── SNAPSHOT ANTES/DESPUÉS ───────────────────────────────────────────────────

/**
 * Toma un snapshot del estado de tests antes de ejecutar un ciclo.
 * Se llama desde el harness antes de la fase de build.
 */
function takeSnapshot(db, projectRoot, cicloId, snapshotType) {
  const testOutput = runTests(projectRoot);
  const passing = extractPassingTests(testOutput);
  const failing  = extractFailingTests(testOutput);

  // Mapear tests a contratos
  const contractIds = [];
  passing.forEach(test => {
    const module = inferModuleFromTest(test, testOutput, projectRoot);
    const id = generateContractId(module, test);
    contractIds.push(id);
  });

  db.prepare(`
    INSERT INTO regression_snapshots
      (ciclo_id, snapshot_type, passing_tests, failing_tests, contract_ids)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    cicloId, snapshotType,
    JSON.stringify(passing),
    JSON.stringify(failing),
    JSON.stringify(contractIds)
  );

  return { passing, failing, contractIds, total: passing.length + failing.length };
}

// ─── PRESERVATION GATE ───────────────────────────────────────────────────────

/**
 * El paso ⑤ del pipeline. Verifica que los contratos PROTECTED y VERIFIED
 * sigan pasando después de un ciclo.
 *
 * Solo corre los tests relacionados con archivos modificados (no todos).
 * Usa el AST graph para identificar qué contratos están en riesgo.
 *
 * @returns { passed: bool, violations: [], blast_radius: int }
 */
function runPreservationGate(db, projectRoot, cicloId, modifiedFiles = []) {
  const result = {
    passed: true,
    violations: [],
    blast_radius: 0,
    contracts_checked: 0,
    contracts_protected: 0,
    contracts_verified: 0,
    skipped_reason: null,
  };

  // Obtener contratos protegidos y verificados
  let contracts = [];
  try {
    contracts = db.prepare(`
      SELECT * FROM verified_contracts
      WHERE status IN ('protected', 'verified')
      ORDER BY status DESC, verification_count DESC
    `).all();
  } catch { return result; }

  if (contracts.length === 0) {
    result.skipped_reason = 'No verified contracts yet — run more cycles to build contract base';
    return result;
  }

  result.contracts_protected = contracts.filter(c => c.status === STATUS.PROTECTED).length;
  result.contracts_verified  = contracts.filter(c => c.status === STATUS.VERIFIED).length;

  // Si hay archivos modificados, filtrar contratos relacionados
  let contractsToCheck = contracts;
  if (modifiedFiles.length > 0) {
    // Calcular blast radius
    const blastContracts = getContractsInBlastRadius(db, modifiedFiles, contracts);
    result.blast_radius = blastContracts.length;

    // Solo verificar contratos en el blast radius
    if (blastContracts.length > 0) {
      contractsToCheck = blastContracts;
    } else {
      // No hay contratos en riesgo → gate pasa automáticamente
      result.passed = true;
      result.skipped_reason = `No contracts in blast radius of modified files (${modifiedFiles.length} files)`;
      return result;
    }
  }

  result.contracts_checked = contractsToCheck.length;

  // Correr solo los test files relacionados
  const testFilesToRun = [...new Set(
    contractsToCheck
      .map(c => c.test_file)
      .filter(Boolean)
  )];

  let testOutput = '';
  if (testFilesToRun.length > 0) {
    testOutput = runSpecificTests(projectRoot, testFilesToRun);
  } else {
    // Sin test files mapeados → correr suite completa
    testOutput = runTests(projectRoot);
  }

  const passingTests = new Set(extractPassingTests(testOutput));
  const failingTests = new Set(extractFailingTests(testOutput));

  // Verificar cada contrato
  for (const contract of contractsToCheck) {
    const testName = contract.test_name || contract.name;
    const isFailing = failingTests.has(testName) ||
                      [...failingTests].some(t => t.includes(testName) || testName.includes(t));

    if (isFailing) {
      result.passed = false;
      result.violations.push({
        contract_id: contract.id,
        contract_name: contract.name,
        module: contract.module,
        status: contract.status,
        test: testName,
        severity: contract.status === STATUS.PROTECTED ? 'CRITICAL' : 'HIGH',
        message: `${contract.status.toUpperCase()} contract broken: ${contract.name} (${contract.module})`,
      });

      // Registrar la violación en DB
      recordContractFailure(db, contract.id, cicloId,
        `Preservation Gate violation in cycle ${cicloId}`);
    } else if (passingTests.has(testName) ||
               [...passingTests].some(t => t.includes(testName))) {
      // Contrato pasó → actualizar
      upsertContract(db, { id: contract.id, module: contract.module, name: contract.name }, cicloId);
    }
  }

  return result;
}

// ─── BLAST RADIUS ────────────────────────────────────────────────────────────

/**
 * Calcula cuántos contratos verificados están en riesgo dado un set de archivos.
 * Usa el AST graph para propagar dependencias.
 */
function getContractsInBlastRadius(db, modifiedFiles, allContracts) {
  const atRisk = [];

  // Obtener todos los archivos que dependen de los modificados (via AST)
  const affectedFiles = new Set(modifiedFiles);
  try {
    for (const file of modifiedFiles) {
      const dependents = db.prepare(`
        SELECT DISTINCT desde_entidad FROM relaciones_semanticas
        WHERE (hacia_entidad LIKE ? OR hacia_entidad = ?)
          AND tipo IN ('depende_de', 'importa', 'usa', 'llama')
          AND (invalid_at IS NULL OR invalid_at = '')
      `).all(`%${path.basename(file)}%`, file);

      dependents.forEach(d => affectedFiles.add(d.desde_entidad));
    }
  } catch {}

  // Mapear a contratos
  for (const contract of allContracts) {
    const sourceFiles = (() => {
      try { return JSON.parse(contract.source_files || '[]'); } catch { return []; }
    })();

    const testFile = contract.test_file || '';

    // Contrato está en riesgo si:
    // 1. Su test file fue modificado
    // 2. Alguno de sus source files fue modificado
    // 3. Algún archivo del blast radius toca su módulo
    const isAtRisk =
      modifiedFiles.some(f => testFile.includes(path.basename(f)) || f.includes(testFile)) ||
      sourceFiles.some(sf => affectedFiles.has(sf) || modifiedFiles.some(m => sf.includes(path.basename(m)))) ||
      [...affectedFiles].some(af => af.toLowerCase().includes(contract.module.toLowerCase()));

    if (isAtRisk) atRisk.push(contract);
  }

  return atRisk;
}

/**
 * Reporte de blast radius para un archivo.
 */
function getBlastRadiusReport(db, projectRoot, targetFile) {
  let contracts = [];
  try {
    contracts = db.prepare(`
      SELECT * FROM verified_contracts WHERE status IN ('protected', 'verified')
    `).all();
  } catch { return { file: targetFile, contracts_at_risk: 0, severity: 'LOW', contracts: [] }; }

  const atRisk = getContractsInBlastRadius(db, [targetFile], contracts);

  const severity = atRisk.length <= BLAST_THRESHOLDS.LOW ? 'LOW'
    : atRisk.length <= BLAST_THRESHOLDS.MEDIUM ? 'MEDIUM'
    : atRisk.length <= BLAST_THRESHOLDS.HIGH ? 'HIGH'
    : 'CRITICAL';

  return {
    file: targetFile,
    contracts_at_risk: atRisk.length,
    severity,
    protected_contracts: atRisk.filter(c => c.status === STATUS.PROTECTED).length,
    verified_contracts: atRisk.filter(c => c.status === STATUS.VERIFIED).length,
    contracts: atRisk.map(c => ({
      id: c.id,
      name: c.name,
      module: c.module,
      status: c.status,
    })),
    recommendation: severity === 'LOW'
      ? 'Safe to modify — minimal contract risk'
      : severity === 'MEDIUM'
        ? 'Proceed with caution — run preservation gate after changes'
        : severity === 'HIGH'
          ? 'High risk — verify all contracts before accepting changes'
          : 'CRITICAL — multiple protected contracts at risk — manual review required',
  };
}

// ─── INGERIR DESDE CICLO COMPLETADO ──────────────────────────────────────────

/**
 * Punto de entrada principal. Llamar después de cada ciclo exitoso.
 * Extrae contratos del output de tests y los almacena/actualiza.
 */
function ingestFromCycle(db, projectRoot, cicloId, testOutput) {
  if (!testOutput) return { contracts_created: 0, contracts_updated: 0 };

  const contracts = extractContractsFromTestOutput(testOutput, projectRoot, cicloId);
  let created = 0, updated = 0;

  for (const contract of contracts) {
    const id = generateContractId(contract.module, contract.name);
    const existing = db.prepare('SELECT id FROM verified_contracts WHERE id = ?').get(id);

    upsertContract(db, contract, cicloId);
    if (existing) updated++; else created++;
  }

  // Agregar causal edge del ciclo a los contratos
  try {
    const contractIds = contracts
      .map(c => generateContractId(c.module, c.name))
      .slice(0, 10); // Máx 10 edges por ciclo

    contractIds.forEach(cid => {
      try {
        db.prepare(`
          INSERT OR IGNORE INTO relaciones_semanticas
            (desde_entidad, tipo, hacia_entidad, descripcion, valid_at)
          VALUES (?, 'verifies', ?, 'cycle verified this contract', datetime('now'))
        `).run(cicloId, cid);
      } catch {}
    });
  } catch {}

  return { contracts_created: created, contracts_updated: updated };
}

// ─── TEST RUNNERS ─────────────────────────────────────────────────────────────

function runTests(projectRoot) {
  const commands = ['npm test -- --passWithNoTests', 'npx jest --passWithNoTests', 'npx vitest run', 'npm run test'];
  for (const cmd of commands) {
    try {
      const out = execSync(cmd, {
        cwd: projectRoot, stdio: 'pipe', timeout: 120000
      }).toString();
      return out;
    } catch (e) {
      const out = (e.stdout?.toString() || '') + (e.stderr?.toString() || '');
      if (out.length > 100) return out; // test output even if exit code != 0
    }
  }
  return '';
}

function runSpecificTests(projectRoot, testFiles) {
  if (!testFiles || testFiles.length === 0) return runTests(projectRoot);

  const fileList = testFiles.map(f => `"${f}"`).join(' ');
  try {
    const out = execSync(`npx jest ${fileList} --passWithNoTests`, {
      cwd: projectRoot, stdio: 'pipe', timeout: 120000
    }).toString();
    return out;
  } catch (e) {
    return (e.stdout?.toString() || '') + (e.stderr?.toString() || '');
  }
}

function extractPassingTests(output) {
  const passing = [];
  const patterns = [
    /^\s*(?:✓|✔|√|PASS)\s+(.+?)(?:\s+\d+\s*m?s)?$/gm,
    /PASSED\s+(.+?)(?:\s+\[)/gm,
  ];
  patterns.forEach(pattern => {
    let m;
    while ((m = pattern.exec(output)) !== null) {
      const name = m[1]?.trim();
      if (name && name.length > 2) passing.push(name);
    }
  });
  return [...new Set(passing)];
}

function extractFailingTests(output) {
  const failing = [];
  const patterns = [
    /^\s*(?:✕|✗|×|FAIL|●)\s+(.+?)(?:\s+\d+\s*m?s)?$/gm,
    /FAILED\s+(.+?)(?:\s+\[)/gm,
  ];
  patterns.forEach(pattern => {
    let m;
    while ((m = pattern.exec(output)) !== null) {
      const name = m[1]?.trim();
      if (name && name.length > 2) failing.push(name);
    }
  });
  return [...new Set(failing)];
}

// ─── STATUS Y REPORTES ───────────────────────────────────────────────────────

function getStatus(db) {
  try {
    const total     = db.prepare("SELECT COUNT(*) as n FROM verified_contracts").get()?.n || 0;
    const protected_= db.prepare("SELECT COUNT(*) as n FROM verified_contracts WHERE status='protected'").get()?.n || 0;
    const verified  = db.prepare("SELECT COUNT(*) as n FROM verified_contracts WHERE status='verified'").get()?.n || 0;
    const candidate = db.prepare("SELECT COUNT(*) as n FROM verified_contracts WHERE status='candidate'").get()?.n || 0;
    const invalidated=db.prepare("SELECT COUNT(*) as n FROM verified_contracts WHERE status='invalidated'").get()?.n || 0;
    const violations= db.prepare("SELECT COUNT(*) as n FROM contract_violations WHERE recovered=0").get()?.n || 0;

    return { total, protected: protected_, verified, candidate, invalidated, open_violations: violations,
      coverage_level: total === 0 ? 'NONE' : protected_ >= 5 ? 'STRONG' : protected_ >= 2 ? 'MODERATE' : 'WEAK' };
  } catch { return { total: 0, error: 'Schema not migrated — run: akdd update' }; }
}

function listContracts(db, module) {
  try {
    const query = module
      ? `SELECT * FROM verified_contracts WHERE module = ? ORDER BY status DESC, verification_count DESC`
      : `SELECT * FROM verified_contracts ORDER BY status DESC, verification_count DESC LIMIT 50`;
    return module ? db.prepare(query).all(module) : db.prepare(query).all();
  } catch { return []; }
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const [,, cmd, ...args] = process.argv;
  const projectRoot = process.cwd();

  let db;
  try {
    db = openDB(projectRoot);
    migrateSchema(db);
  } catch (e) {
    console.error('[CONTRACT] DB error:', e.message);
    process.exit(1);
  }

  switch (cmd) {
    case 'status': {
      const s = getStatus(db);
      console.log('\n══════════════════════════════════════════════');
      console.log('  Contract Guard — Status');
      console.log('══════════════════════════════════════════════');
      console.log(`  PROTECTED:   ${s.protected}   (intocables — ${PROMOTION_RULES.VERIFIED_TO_PROTECTED.min_passes}+ passes)`);
      console.log(`  VERIFIED:    ${s.verified}   (verificados — ${PROMOTION_RULES.CANDIDATE_TO_VERIFIED.min_passes}+ passes)`);
      console.log(`  CANDIDATE:   ${s.candidate}   (< ${PROMOTION_RULES.CANDIDATE_TO_VERIFIED.min_passes} passes)`);
      console.log(`  INVALIDATED: ${s.invalidated}   (rotos en ciclo reciente)`);
      console.log(`  Violations:  ${s.open_violations} abiertas`);
      console.log(`  Coverage:    ${s.coverage_level}`);
      console.log(`  Total:       ${s.total}`);
      console.log('══════════════════════════════════════════════\n');
      break;
    }

    case 'list': {
      const contracts = listContracts(db, args[0]);
      const statusIcon = { protected: '🛡️', verified: '✅', candidate: '🔄', invalidated: '❌' };
      console.log(`\nContracts${args[0] ? ` [${args[0]}]` : ''} (${contracts.length}):\n`);
      contracts.forEach(c => {
        const icon = statusIcon[c.status] || '?';
        console.log(`  ${icon} [${c.id}] ${c.name}`);
        console.log(`     Module: ${c.module} | Passes: ${c.verification_count} | Fails: ${c.failure_count}`);
      });
      break;
    }

    case 'blast': {
      const file = args[0];
      if (!file) { console.error('Uso: contract-guard.cjs blast <archivo>'); break; }
      const report = getBlastRadiusReport(db, projectRoot, file);
      console.log(`\nBlast Radius: ${file}`);
      console.log(`  Contratos en riesgo: ${report.contracts_at_risk}`);
      console.log(`  Severidad: ${report.severity}`);
      console.log(`  Protected: ${report.protected_contracts} | Verified: ${report.verified_contracts}`);
      console.log(`  → ${report.recommendation}\n`);
      break;
    }

    case 'gate': {
      const modifiedFiles = args;
      console.log('\n[CONTRACT] Corriendo Preservation Gate...');
      const result = runPreservationGate(db, projectRoot, `manual-${Date.now()}`, modifiedFiles);
      if (result.passed) {
        console.log(`\n  ✅ Preservation Gate PASSED`);
        console.log(`  ${result.contracts_checked} contratos verificados`);
        if (result.skipped_reason) console.log(`  (${result.skipped_reason})`);
      } else {
        console.log(`\n  ❌ Preservation Gate FAILED — ${result.violations.length} violation(s)\n`);
        result.violations.forEach(v => {
          console.log(`  [${v.severity}] ${v.contract_id}: ${v.message}`);
        });
      }
      process.exit(result.passed ? 0 : 1);
    }

    case 'promote': {
      const candidates = db.prepare(`
        SELECT * FROM verified_contracts WHERE status IN ('candidate','verified')
      `).all();
      let promoted = 0;
      candidates.forEach(c => {
        autoPromote(db, c.id, c.consecutive_passes, c.verification_count, c.failure_count);
        promoted++;
      });
      console.log(`Reviewed ${promoted} contracts for promotion.`);
      break;
    }

    case 'verify': {
      const module = args[0];
      console.log(`\n[CONTRACT] Running preservation gate${module ? ` for ${module}` : ''}...`);
      const result = runPreservationGate(db, projectRoot, `verify-${Date.now()}`, []);
      console.log(result.passed
        ? `\n✅ All ${result.contracts_checked} contracts passing\n`
        : `\n❌ ${result.violations.length} contracts broken:\n${result.violations.map(v => `  - ${v.contract_name}`).join('\n')}\n`
      );
      break;
    }

    case 'migrate': {
      migrateSchema(db);
      console.log('✅ Schema migrated');
      break;
    }

    default:
      console.log('Uso: node contract-guard.cjs [status | list [module] | blast <file> | gate [files...] | verify | promote | migrate]');
  }
}

module.exports = {
  migrateSchema,
  ingestFromCycle,
  runPreservationGate,
  getBlastRadiusReport,
  getContractsInBlastRadius,
  getStatus,
  listContracts,
  takeSnapshot,
  upsertContract,
  recordContractFailure,
  extractContractsFromTestOutput,
  generateContractId,
  STATUS,
};
