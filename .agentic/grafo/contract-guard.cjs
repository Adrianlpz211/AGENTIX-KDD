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

function openDB(projectRoot, opciones) {
  const dbPath = path.join(projectRoot, '.agentic/memoria.db');
  const readOnly = !!(opciones && opciones.readOnly);
  return require('./db-adapter.cjs').open(dbPath, { readOnly, legacySwallow: false });
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
    // Sin ejecución identificable, repetir la misma salida no es otra pasada.
    if (!contract.execution_id) return id;
    if (esquemaPorTestListo(db)) {
      const ins = db.prepare(`INSERT OR IGNORE INTO contract_executions (contract_id, execution_id, subject_hash, status)
        VALUES (?, ?, ?, 'pass')`).run(id, contract.execution_id, contract.subject_hash || null);
      if (ins && ins.changes === 0) return id;
    }
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
  // Solo un contrato con test propio (test_id, que escribe registerPassingTests)
  // puede subir: una suite global o una línea de salida no prueban cada contrato.
  const conTestId = columnas(db, 'verified_contracts').includes('test_id');
  const contract = db.prepare(`SELECT status, name${conTestId ? ', test_id' : ''} FROM verified_contracts WHERE id = ?`).get(contractId);
  if (!contract) return;
  if (!conTestId || !contract.test_id || /^Suite: /.test(contract.name || '')) return;

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
/**
 * @param opts.sinSuiteCompleta  No caer a la suite completa si los contratos en
 *   riesgo no tienen archivo de test mapeado. Lo usa el post-cycle, que corre
 *   desde un hook de git en cada commit: en un proyecto con una suite de cinco
 *   minutos, ese respaldo la ejecutaria en cada commit y lo primero que haria
 *   cualquiera es desactivar el hook — perdiendo con el todos los demas gates.
 *   Invocado a mano (`contract-guard.cjs verify`) el respaldo si tiene sentido.
 */
function runPreservationGate(db, projectRoot, cicloId, modifiedFiles = [], opts = {}) {
  const { createGateResult } = require('./gate-result.cjs');
  const result = {
    status: 'PASS',
    reason_code: null,
    blocking: false,
    passed: false,
    violations: [],
    unverified: [],
    blast_radius: 0,
    contracts_checked: 0,
    contracts_protected: 0,
    contracts_verified: 0,
    skipped_reason: null,
    gate: null,
  };
  const terminar = (status, reason, extra) => {
    const e = extra || {};
    Object.assign(result, e);
    result.status = status;
    result.reason_code = reason;
    result.passed = status === 'PASS';
    result.blocking = typeof e.blocking === 'boolean'
      ? e.blocking
      : status === 'FAIL' || status === 'ERROR' || (status === 'UNVERIFIED' && result.contracts_protected > 0);
    return result;
  };

  let contracts = [];
  try {
    contracts = db.prepare(`
      SELECT * FROM verified_contracts
      WHERE status IN ('protected', 'verified')
      ORDER BY status DESC, verification_count DESC
    `).all();
  } catch (e) {
    return terminar('ERROR', 'CONTRACTS_QUERY_FAILED', { skipped_reason: e.message });
  }

  if (contracts.length === 0) {
    return terminar('SKIP', 'NO_CONTRACTS', { blocking: false, skipped_reason: 'Sin contratos verificados todavía' });
  }

  let contractsToCheck = contracts;
  if (modifiedFiles.length > 0) {
    contractsToCheck = getContractsInBlastRadius(db, modifiedFiles, contracts, projectRoot);
    result.blast_radius = contractsToCheck.length;
    result.blast_coverage = contractsToCheck.analisis.complete ? 'COMPLETE' : 'PARTIAL';
    if (contractsToCheck.length === 0 && !contractsToCheck.analisis.complete) {
      /* Sin cobertura completa, un radio vacío no prueba nada: se revisan todos. */
      contractsToCheck = contracts;
    } else if (contractsToCheck.length === 0) {
      return terminar('SKIP', 'NO_CONTRACTS_IN_BLAST_RADIUS', {
        blocking: false,
        skipped_reason: `Ningún contrato en el radio de ${modifiedFiles.length} archivo(s)`,
      });
    }
  }

  result.contracts_protected = contractsToCheck.filter(c => c.status === STATUS.PROTECTED).length;
  result.contracts_verified  = contractsToCheck.filter(c => c.status === STATUS.VERIFIED).length;
  result.contracts_checked = contractsToCheck.length;

  const sinMapping = contractsToCheck.filter(c => c.mapping_status === 'UNRESOLVED' || !c.test_name);
  result.unverified = sinMapping.map(c => ({ contract_id: c.id, status: c.status, reason: 'UNRESOLVED_MAPPING' }));
  const ejecutables = contractsToCheck.filter(c => !sinMapping.includes(c));

  const testFilesToRun = [...new Set(ejecutables.map(c => c.test_file).filter(Boolean))];
  if (!ejecutables.length) {
    return terminar('UNVERIFIED', 'NO_EXECUTABLE_MAPPING', {
      skipped_reason: `${contractsToCheck.length} contrato(s) en riesgo sin test individual mapeado`,
    });
  }
  if (testFilesToRun.length === 0 && opts.sinSuiteCompleta) {
    return terminar('UNVERIFIED', 'NO_TEST_FILE_MAPPED', {
      skipped_reason: 'Contratos en riesgo sin archivo de test; el post-cycle no corre la suite completa',
    });
  }

  const ejecucion = runTestsResult(projectRoot, testFilesToRun);
  if (ejecucion.status === 'ERROR' || ejecucion.status === 'UNVERIFIED') {
    return terminar(ejecucion.status, 'RUNNER_' + (ejecucion.reason_code || ejecucion.status), {
      skipped_reason: (ejecucion.failures || []).join('; ').slice(0, 300),
    });
  }

  const tests = ejecucion.tests || [];
  const estadoDe = (contract) => {
    const candidatos = tests.filter(t => t.test_name === contract.test_name
      && (!contract.test_file || !t.test_file || path.normalize(t.test_file) === path.normalize(contract.test_file)));
    if (candidatos.some(t => t.status === 'fail')) return 'fail';
    if (candidatos.some(t => t.status === 'pass')) return 'pass';
    return 'missing';
  };

  for (const contract of ejecutables) {
    const estado = estadoDe(contract);
    if (estado === 'fail') {
      result.violations.push({
        contract_id: contract.id,
        contract_name: contract.name,
        module: contract.module,
        status: contract.status,
        test: contract.test_name,
        severity: contract.status === STATUS.PROTECTED ? 'CRITICAL' : 'HIGH',
        message: `${contract.status.toUpperCase()} contract broken: ${contract.name} (${contract.module})`,
      });
      recordContractFailure(db, contract.id, cicloId, `Preservation Gate violation in cycle ${cicloId}`);
    } else if (estado === 'missing') {
      result.unverified.push({ contract_id: contract.id, status: contract.status, reason: 'TEST_NOT_IN_OUTPUT' });
    }
  }

  const subject = ejecucion.gate && ejecucion.gate.subject_hash;
  result.gate = createGateResult({
    gate: 'preservation',
    status: result.violations.length ? 'FAIL' : (result.unverified.length ? 'UNVERIFIED' : 'PASS'),
    reason_code: result.violations.length ? 'CONTRACT_BROKEN' : (result.unverified.length ? 'CONTRACT_WITHOUT_EVIDENCE' : null),
    cycle_id: cicloId,
    subject_hash: subject,
    evidence: ejecucion.gate ? ejecucion.gate.evidence : [],
  });

  if (result.violations.length) return terminar('FAIL', 'CONTRACT_BROKEN');
  if (result.unverified.length) return terminar('UNVERIFIED', 'CONTRACT_WITHOUT_EVIDENCE');
  return terminar(result.gate.status, result.gate.reason_code);
}

// ─── BLAST RADIUS ────────────────────────────────────────────────────────────

/**
 * Calcula cuántos contratos verificados están en riesgo dado un set de archivos.
 * Usa el AST graph para propagar dependencias.
 */
/* Cierre transitivo exacto (blast-radius.cjs). El arreglo devuelto lleva
   `.analisis` con la cobertura: un radio vacío con huecos no es "nada en riesgo". */
function getContractsInBlastRadius(db, modifiedFiles, allContracts, projectRoot) {
  const br = require('./blast-radius.cjs');
  const analisis = br.analizar(db, projectRoot || process.cwd(), modifiedFiles, { contracts: allContracts });
  const atRisk = analisis.contracts.slice();
  atRisk.analisis = analisis;
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
  } catch (e) { return { file: targetFile, contracts_at_risk: 0, severity: 'UNKNOWN', complete: false, reason_code: 'CONTRACTS_QUERY_FAILED', error: e.message, contracts: [] }; }

  const atRisk = getContractsInBlastRadius(db, [targetFile], contracts, projectRoot);
  const a = atRisk.analisis;

  let severity = atRisk.length <= BLAST_THRESHOLDS.LOW ? 'LOW'
    : atRisk.length <= BLAST_THRESHOLDS.MEDIUM ? 'MEDIUM'
    : atRisk.length <= BLAST_THRESHOLDS.HIGH ? 'HIGH'
    : 'CRITICAL';
  if (severity === 'LOW' && !a.complete) severity = 'UNKNOWN';

  return {
    file: targetFile,
    contracts_at_risk: atRisk.length,
    severity,
    complete: a.complete,
    coverage: a.coverage,
    affected_files: a.affected.map((n) => n.file),
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
      : severity === 'UNKNOWN'
        ? 'Partial index — low risk NOT proven; reindex (akdd ast) or run the full suite'
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

/**
 * El mismo runner del TDD gate: comando declarado del proyecto, sin Jest
 * fijo ni --passWithNoTests. Devuelve el resultado completo, no solo texto.
 */
function runTestsResult(projectRoot, testFiles) {
  const tdd = require('./tdd-gate.cjs');
  const command = tdd.detectTestCommand(projectRoot);
  if (!command) {
    return {
      status: 'UNVERIFIED', reason_code: 'NO_TEST_COMMAND', allPassed: false,
      output: '', tests: [], failures: ['sin comando de tests declarado'],
    };
  }
  return tdd.runTests(command, projectRoot, testFiles && testFiles.length ? testFiles : null);
}

function runTests(projectRoot) {
  return runTestsResult(projectRoot, null).output || '';
}

function runSpecificTests(projectRoot, testFiles) {
  return runTestsResult(projectRoot, testFiles).output || '';
}

function columnas(db, tabla) {
  try { return db.prepare(`PRAGMA table_info(${tabla})`).all().map((c) => c.name); }
  catch { return []; }
}

function esquemaPorTestListo(db) {
  const cols = columnas(db, 'verified_contracts');
  const ok = ['test_id', 'runner_id', 'runner_command', 'mapping_status', 'last_execution_id'].every((c) => cols.includes(c));
  if (!ok) return false;
  try { db.prepare('SELECT 1 FROM contract_executions LIMIT 1').all(); return true; } catch { return false; }
}

/**
 * Migración explícita v2 del Contract Guard. Solo `contract-guard.cjs migrate`
 * la corre. Los contratos viejos atados a "npm test" conservan historial y
 * nivel, y quedan UNRESOLVED hasta que un test real los respalde.
 */
function migrateSchemaV2(db) {
  migrateSchema(db);
  const cols = columnas(db, 'verified_contracts');
  const nuevas = [
    ['test_id', 'TEXT'],
    ['runner_id', 'TEXT'],
    ['runner_command', 'TEXT'],
    ['mapping_status', "TEXT DEFAULT 'RESOLVED'"],
    ['last_execution_id', 'TEXT'],
  ];
  for (const [nombre, tipo] of nuevas) {
    if (!cols.includes(nombre)) db.exec(`ALTER TABLE verified_contracts ADD COLUMN ${nombre} ${tipo}`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS contract_executions (
      contract_id  TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      subject_hash TEXT,
      status       TEXT NOT NULL,
      created_at   TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (contract_id, execution_id)
    )
  `);
  const legacy = db.prepare(`
    UPDATE verified_contracts
       SET mapping_status = 'UNRESOLVED',
           runner_command = COALESCE(runner_command, test_file),
           test_file = CASE WHEN test_file LIKE '% %' OR test_file IN ('npm test','pytest') THEN NULL ELSE test_file END
     WHERE test_id IS NULL
       AND (test_file IS NULL OR test_file LIKE 'npm %' OR test_file LIKE 'npx %' OR test_file IN ('pytest')
            OR name LIKE '% tests (%/%)')
  `).run();
  return { status: 'APPLIED', unresolved: legacy && legacy.changes != null ? legacy.changes : null };
}

function listUnresolved(db) {
  try {
    return db.prepare("SELECT id, module, name, status, runner_command FROM verified_contracts WHERE mapping_status = 'UNRESOLVED'").all();
  } catch { return []; }
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
    const dbPath = path.join(projectRoot, '.agentic/memoria.db');
    if (cmd === 'migrate') {
      const dryRun = args.includes('--dry-run');
      const res = require('./db-adapter.cjs').migrate(dbPath, {
        dryRun,
        run: (wdb) => migrateSchemaV2(wdb),
      });
      console.log(dryRun ? 'Dry-run: no se escribió nada' : `✅ Contract Guard v2 aplicado (${JSON.stringify(res)})`);
      process.exit(0);
    }
    db = openDB(projectRoot, { readOnly: ['status', 'list', 'blast', 'unresolved'].includes(cmd) });
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
      if (report.affected_files) console.log(`  Archivos alcanzados (transitivo): ${report.affected_files.length}`);
      if (report.coverage && !report.complete) {
        const u = report.coverage.unknown.map((x) => `${x.file} (${x.reason})`);
        if (u.length) console.log(`  Sin cobertura: ${u.slice(0, 10).join(', ')}${u.length > 10 ? ` … +${u.length - 10}` : ''}`);
        if (report.coverage.stale.length) console.log(`  Índice viejo: ${report.coverage.stale.slice(0, 10).join(', ')}`);
        if (report.coverage.truncated) console.log(`  Recorrido cortado: ${report.coverage.truncated}`);
      }
      console.log(`  → ${report.recommendation}\n`);
      if (report.severity === 'CRITICAL') process.exitCode = 1;
      break;
    }

    case 'gate': {
      const modifiedFiles = args;
      console.log('\n[CONTRACT] Corriendo Preservation Gate...');
      const result = runPreservationGate(db, projectRoot, `manual-${Date.now()}`, modifiedFiles);
      console.log(`\n  Preservation Gate: ${result.status}${result.reason_code ? ' (' + result.reason_code + ')' : ''}`);
      console.log(`  ${result.contracts_checked} contrato(s) revisados`);
      if (result.skipped_reason) console.log(`  (${result.skipped_reason})`);
      result.violations.forEach(v => console.log(`  [${v.severity}] ${v.contract_id}: ${v.message}`));
      result.unverified.forEach(u => console.log(`  [UNVERIFIED] ${u.contract_id}: ${u.reason}`));
      process.exit(result.blocking ? 1 : 0);
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
      console.log(`\nPreservation: ${result.status}${result.reason_code ? ' (' + result.reason_code + ')' : ''} — ${result.contracts_checked} contrato(s)`);
      result.violations.forEach(v => console.log(`  - roto: ${v.contract_name}`));
      result.unverified.forEach(u => console.log(`  - sin evidencia: ${u.contract_id} (${u.reason})`));
      break;
    }

    case 'unresolved': {
      const rows = listUnresolved(db);
      console.log(`\nContratos sin test individual mapeado (${rows.length}):`);
      rows.forEach(r => console.log(`  [${r.status}] ${r.id} ${r.module}: ${r.name}`));
      break;
    }

    default:
      console.log('Uso: node contract-guard.cjs [status | list [module] | blast <file> | gate [files...] | verify | promote | unresolved | migrate [--dry-run]]');
  }
}


// ─── REGISTER PASSING TESTS (called by TDD Gate automatically) ───────────────

/**
 * Un contrato por test individual. La misma ejecución (execution_id) no suma
 * dos veces; la promoción cuenta ejecuciones distintas válidas del mismo test.
 * Sin el esquema v2 no escribe: devuelve UPGRADE_REQUIRED.
 */
function registerPassingTests(db, params) {
  const p = params || {};
  const area = p.area || 'global';
  const tests = Array.isArray(p.tests) ? p.tests : [];
  const salida = { status: 'SKIP', reason_code: null, created: 0, updated: 0, duplicates: 0 };
  if (!db) return Object.assign(salida, { status: 'ERROR', reason_code: 'NO_DB' });
  if (!p.execution_id) return Object.assign(salida, { status: 'UNVERIFIED', reason_code: 'NO_EXECUTION_ID' });
  const pasados = tests.filter((t) => t.status === 'pass');
  if (!pasados.length) return Object.assign(salida, { reason_code: 'NO_INDIVIDUAL_TESTS' });
  if (!esquemaPorTestListo(db)) return Object.assign(salida, { status: 'UPGRADE_REQUIRED', reason_code: 'CONTRACT_SCHEMA_V2' });

  const { testId } = require('./test-results.cjs');
  const runnerId = p.runner_id || p.command || null;
  const registrar = () => {
    for (const t of pasados) {
      const tid = testId(runnerId, t);
      const id = area.toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 6) + '-T' + tid;
      const ins = db.prepare(`
        INSERT OR IGNORE INTO contract_executions (contract_id, execution_id, subject_hash, status)
        VALUES (?, ?, ?, 'pass')
      `).run(id, p.execution_id, p.subject_hash || null);
      if (ins && ins.changes === 0) { salida.duplicates++; continue; }

      const existing = db.prepare('SELECT * FROM verified_contracts WHERE id = ?').get(id);
      if (existing) {
        const total = (existing.verification_count || 0) + 1;
        const consec = (existing.consecutive_passes || 0) + 1;
        db.prepare(`
          UPDATE verified_contracts SET
            verification_count = ?, consecutive_passes = ?,
            test_id = ?, runner_id = ?, runner_command = ?, mapping_status = 'RESOLVED',
            last_execution_id = ?, last_verified = datetime('now'), updated_at = datetime('now')
          WHERE id = ?
        `).run(total, consec, tid, runnerId, p.command || null, p.execution_id, id);
        autoPromote(db, id, consec, total, existing.failure_count || 0);
        salida.updated++;
      } else {
        db.prepare(`
          INSERT INTO verified_contracts
            (id, module, name, description, test_file, test_name, test_id, runner_id, runner_command,
             mapping_status, last_execution_id, verification_count, consecutive_passes, status, last_verified)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'RESOLVED', ?, 1, 1, 'candidate', datetime('now'))
        `).run(id, area, t.test_name, 'Test individual: ' + t.test_name, t.test_file || null, t.test_name,
          tid, runnerId, p.command || null, p.execution_id);
        salida.created++;
      }
    }
  };
  if (typeof db.transaction === 'function') {
    db.transaction(registrar)();
  } else {
    db.exec('BEGIN');
    try { registrar(); db.exec('COMMIT'); }
    catch (e) { try { db.exec('ROLLBACK'); } catch { /* el error original manda */ } throw e; }
  }
  salida.status = 'PASS';
  return salida;
}

function schemaDisponible(db) {
  try {
    return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='verified_contracts'").get();
  } catch { return false; }
}

module.exports = {
  registerPassingTests,
  migrateSchema,
  migrateSchemaV2,
  schemaDisponible,
  esquemaPorTestListo,
  listUnresolved,
  runTestsResult,
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
