/**
 * Agentic KDD — Autonomous Decision Engine v1.0
 *
 * Motor de decisión autónoma L4.
 *
 * Lo que resuelve:
 *   - El agente detecta situaciones que afectan lo que se está trabajando
 *     y decide autónomamente si implementar, advertir, o diferir
 *   - Prerequisite chain: detecta si algo que hay que tocar tiene un
 *     prerequisito roto y lo resuelve primero
 *   - Cross-module pattern: si el mismo error ya ocurrió en otro módulo
 *     y fue resuelto allá, aplica la misma solución aquí
 *   - Full spectrum: no solo mira errores — también protege lo que funciona
 *
 * Decisiones posibles:
 *   STOP              → blast CRITICAL o PROTECTED contract roto
 *                        No implementar. Reportar exactamente qué rompería.
 *   WARN              → blast HIGH o VERIFIED contract en riesgo
 *                        Implementar pero avisar. El dev decide si continuar.
 *   IMPLEMENT         → blast MEDIUM/LOW + sin rotura de contratos
 *                        Implementar ahora dentro del ciclo.
 *   IMPLEMENT_CAUTIOUS→ prerequisito resuelto primero, luego la tarea
 *                        Implementar en orden: prerequisito → tarea original
 *   DEFER             → blast LOW + sin historial + sin contratos en riesgo
 *                        No tocar ahora. Agregar a cola de sugerencias al final.
 *
 * Uso desde el pipeline (harness.cjs lo llama automáticamente):
 *   const { analyze } = require('./autonomous-decision.cjs');
 *   const decision = await analyze({ files: ['src/auth.ts'], task: 'fix session' });
 *
 * Uso manual:
 *   node autonomous-decision.cjs analyze src/auth.ts
 *   node autonomous-decision.cjs queue           — ver cola diferida
 *   node autonomous-decision.cjs flush           — mostrar cola y limpiarla
 */

'use strict';

const path = require('path');
const fs   = require('fs');

// ─── CONSTANTES ───────────────────────────────────────────────────────────────

const DECISIONS = {
  STOP:               'STOP',
  WARN:               'WARN',
  IMPLEMENT:          'IMPLEMENT',
  IMPLEMENT_CAUTIOUS: 'IMPLEMENT_CAUTIOUS',
  DEFER:              'DEFER',
};

const BLAST_LEVELS = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

const DEFERRED_QUEUE_PATH = '.agentic/deferred_queue.json';

// ─── FILE RISK TABLE ──────────────────────────────────────────────────────────

const DEFAULT_RISK_TABLE = {
  CRITICAL:  ['auth.ts', 'middleware/', '.env', 'prisma/schema', 'secrets'],
  SENSITIVE: ['routes/auth', 'lib/prisma', 'collab-manager', 'harness'],
  NORMAL:    ['routes/', 'lib/', 'services/', 'controllers/'],
  FREE:      ['tests/', '__tests__/', 'utils/', 'validators', 'constants'],
};

function classifyFileRisk(filePath, projectRoot) {
  let riskTable = DEFAULT_RISK_TABLE;
  try {
    const configPath = path.join(projectRoot || process.cwd(), '.agentic/config.md');
    const config = fs.readFileSync(configPath, 'utf8');
    const tableMatch = config.match(/\[file_risk_table\]([\s\S]*?)(?=\[|$)/);
    if (tableMatch) {
      const lines = tableMatch[1].trim().split(/\r?\n/).filter(Boolean);
      const custom = { CRITICAL: [], SENSITIVE: [], NORMAL: [], FREE: [] };
      lines.forEach(function(line) {
        const colonIdx = line.indexOf(':');
        if (colonIdx < 0) return;
        const lvl = line.substring(0, colonIdx).trim().toUpperCase();
        const vals = line.substring(colonIdx + 1).split(',').map(function(p) { return p.trim(); }).filter(Boolean);
        if (custom[lvl]) custom[lvl].push.apply(custom[lvl], vals);
      });
      riskTable = {
        CRITICAL:  DEFAULT_RISK_TABLE.CRITICAL.concat(custom.CRITICAL),
        SENSITIVE: DEFAULT_RISK_TABLE.SENSITIVE.concat(custom.SENSITIVE),
        NORMAL:    DEFAULT_RISK_TABLE.NORMAL.concat(custom.NORMAL),
        FREE:      DEFAULT_RISK_TABLE.FREE.concat(custom.FREE),
      };
    }
  } catch(e) {}

  const fp = (filePath || '').replace(/\\/g, '/').toLowerCase();
  for (var i = 0; i < riskTable.CRITICAL.length;  i++) if (fp.includes(riskTable.CRITICAL[i].toLowerCase()))  return 'CRITICAL';
  for (var i = 0; i < riskTable.SENSITIVE.length; i++) if (fp.includes(riskTable.SENSITIVE[i].toLowerCase())) return 'SENSITIVE';
  for (var i = 0; i < riskTable.FREE.length;      i++) if (fp.includes(riskTable.FREE[i].toLowerCase()))      return 'FREE';
  for (var i = 0; i < riskTable.NORMAL.length;    i++) if (fp.includes(riskTable.NORMAL[i].toLowerCase()))    return 'NORMAL';
  return 'NORMAL';
}

// ─── PATTERN DETECTION ACROSS MODULES ────────────────────────────────────────

function detectPatternAcrossModules(db, errorSignatures, currentFiles, projectRoot) {
  if (!db || !errorSignatures || errorSignatures.length === 0) return [];

  const findings = [];
  const currentAreas = (currentFiles || []).map(function(f) {
    return path.basename(f, path.extname(f)).toLowerCase();
  });

  const sfn = function(fn) { try { return fn(); } catch(e) { return []; } };

  errorSignatures.forEach(function(sig) {
    if (!sig || sig.length < 3) return;

    const likeQuery = '%' + sig + '%';
    const placeholders = currentAreas.length > 0
      ? 'AND area NOT IN (' + currentAreas.map(function() { return '?'; }).join(',') + ')'
      : '';

    let otherModules = [];
    try {
      otherModules = db.prepare(
        'SELECT DISTINCT area, id, titulo, confianza, aplicado FROM nodos ' +
        'WHERE tipo IN (\'error\', \'patron\') ' +
        'AND (titulo LIKE ? OR contenido LIKE ?) ' +
        'AND estado = \'ACTIVO\' ' +
        placeholders + ' ORDER BY aplicado DESC LIMIT 8'
      ).all.apply(null, [likeQuery, likeQuery].concat(currentAreas));
    } catch(e) {}

    otherModules.forEach(function(mod) {
      const hasHistory = (mod.aplicado || 0) > 0;
      const riskLevel  = classifyFileRisk(mod.area, projectRoot);

      let knownFix = null;
      try {
        const fixRow = db.prepare(
          'SELECT descripcion FROM relaciones_semanticas ' +
          'WHERE desde_entidad LIKE ? AND tipo = \'was_fixed_by\' ' +
          'AND (invalid_at IS NULL OR invalid_at = \'\') LIMIT 1'
        ).get('%' + mod.area + '%');
        if (fixRow) knownFix = fixRow.descripcion;
      } catch(e) {}

      let action;
      if (riskLevel === 'CRITICAL') {
        action = 'WARN';
      } else if (riskLevel === 'SENSITIVE' && !knownFix) {
        action = 'WARN';
      } else if (hasHistory || knownFix) {
        action = 'AUTO_FIX';
      } else {
        action = riskLevel === 'FREE' ? 'AUTO_FIX' : 'WARN';
      }

      findings.push({
        module:      mod.area,
        signature:   sig,
        titulo:      mod.titulo,
        risk_level:  riskLevel,
        has_history: hasHistory,
        known_fix:   knownFix,
        action:      action,
        reason: action === 'AUTO_FIX'
          ? 'Pattern in ' + mod.area + ' (' + (mod.aplicado || 0) + 'x) — auto-fixing'
          : riskLevel + ' file — requires confirmation before touching ' + mod.area,
      });
    });
  });

  const seen = {};
  return findings.filter(function(f) {
    const key = f.module + ':' + f.signature;
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

// ─── PREREQUISITE CHECK FOR FINDINGS ─────────────────────────────────────────

function prerequisiteCheckFindings(db, findings, currentFiles) {
  if (!db || !findings || !findings.length) {
    return { prerequisites: [], non_blockers: findings || [], can_proceed: true, fix_order: [{ step: 'MAIN_TASK' }] };
  }

  const prerequisites = [];
  const nonBlockers   = [];

  findings.forEach(function(finding) {
    var isPrerequisite = false;

    try {
      (currentFiles || []).forEach(function(file) {
        const bn   = path.basename(file);
        const deps = db.prepare(
          'SELECT hacia_entidad FROM relaciones_semanticas ' +
          'WHERE desde_entidad LIKE ? ' +
          'AND tipo IN (\'depende_de\', \'importa\', \'usa\', \'llama\') ' +
          'AND (invalid_at IS NULL OR invalid_at = \'\') LIMIT 10'
        ).all('%' + bn + '%').map(function(r) { return r.hacia_entidad; });

        if (deps.some(function(d) {
          return d && d.toLowerCase().includes(finding.module.toLowerCase());
        })) {
          isPrerequisite = true;
        }
      });
    } catch(e) {}

    if (isPrerequisite) {
      prerequisites.push(Object.assign({}, finding, {
        prerequisite_reason: finding.module + ' is upstream of current task — fix first',
      }));
    } else {
      nonBlockers.push(finding);
    }
  });

  const autoFixable = nonBlockers.filter(function(f) { return f.action === 'AUTO_FIX'; });
  const warnOnly    = prerequisites.concat(nonBlockers.filter(function(f) { return f.action === 'WARN'; }));

  const fixOrder = prerequisites.map(function(p) { return Object.assign({}, p, { when: 'BEFORE_MAIN_TASK' }); });
  fixOrder.push({ step: 'MAIN_TASK' });
  autoFixable.forEach(function(n) { fixOrder.push(Object.assign({}, n, { when: 'AFTER_MAIN_TASK' })); });

  return {
    prerequisites: prerequisites,
    non_blockers:  nonBlockers,
    can_proceed:   prerequisites.length === 0,
    auto_fixable:  autoFixable,
    warn_only:     warnOnly,
    fix_order:     fixOrder,
  };
}


// ─── DB ───────────────────────────────────────────────────────────────────────

function openDB(projectRoot) {
  const dbPath = path.join(projectRoot, '.agentic/memoria.db');
  try { return new (require('better-sqlite3'))(dbPath); } catch {}
  try { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(dbPath); } catch {}
  return null;
}

function safe(fn, fallback = null) {
  try { return fn(); } catch { return fallback; }
}

// ─── PREREQUISITE CHAIN DETECTION ────────────────────────────────────────────
/**
 * Dado un set de archivos a modificar, detecta si algún prerequisito
 * en la cadena de dependencias tiene contratos rotos.
 *
 * Ejemplo:
 *   Quieres tocar dashboard.ts
 *   dashboard.ts importa authMiddleware.ts
 *   authMiddleware.ts tiene contrato INVALIDATED
 *   → authMiddleware.ts es prerequisito roto
 */
function detectPrerequisiteChain(db, targetFiles, projectRoot) {
  const broken = [];

  if (!db) return broken;

  targetFiles.forEach(file => {
    const basename = path.basename(file);

    // Obtener dependencias via AST edges
    const deps = safe(() =>
      db.prepare(`
        SELECT DISTINCT hacia_entidad as dep
        FROM relaciones_semanticas
        WHERE (desde_entidad LIKE ? OR desde_entidad = ?)
          AND tipo IN ('depende_de', 'importa', 'usa', 'llama')
          AND (invalid_at IS NULL OR invalid_at = '')
        LIMIT 20
      `).all(`%${basename}%`, file)
    ) || [];

    deps.forEach(({ dep }) => {
      if (!dep) return;

      // Verificar si esa dependencia tiene contratos fallidos o invalidados
      const brokenContracts = safe(() =>
        db.prepare(`
          SELECT id, name, status, module
          FROM verified_contracts
          WHERE (test_file LIKE ? OR name LIKE ? OR module LIKE ?)
            AND status IN ('invalidated')
          LIMIT 5
        `).all(`%${dep}%`, `%${dep}%`, `%${path.basename(dep, path.extname(dep))}%`)
      ) || [];

      if (brokenContracts.length > 0) {
        broken.push({
          prerequisite: dep,
          broken_contracts: brokenContracts,
          affects: file,
          reason: `${dep} has ${brokenContracts.length} broken contract(s) — must be fixed before ${basename}`,
        });
      }

      // También verificar errores HIGH confidence no resueltos en la dependencia
      const depArea = path.basename(dep, path.extname(dep)).toLowerCase();
      const unresolvedErrors = safe(() =>
        db.prepare(`
          SELECT titulo, confianza FROM nodos
          WHERE tipo = 'error'
            AND confianza IN ('ALTA', 'MEDIA')
            AND estado = 'ACTIVO'
            AND area LIKE ?
            AND (vigencia_tipo = 'VIGENTE' OR vigencia_tipo IS NULL)
          LIMIT 3
        `).all(`%${depArea}%`)
      ) || [];

      if (unresolvedErrors.length > 0 && brokenContracts.length === 0) {
        broken.push({
          prerequisite: dep,
          broken_contracts: [],
          unresolved_errors: unresolvedErrors,
          affects: file,
          reason: `${dep} has ${unresolvedErrors.length} HIGH/MEDIUM unresolved error(s)`,
          severity: 'soft', // no es STOP, es WARN
        });
      }
    });
  });

  return broken;
}

// ─── CROSS-MODULE ERROR CHECK ─────────────────────────────────────────────────
/**
 * ¿Este error ya ocurrió en otro módulo?
 * Si sí y fue resuelto → propone misma solución
 * Si sí y no fue resuelto → es sistémico, escalar
 */
function crossModuleCheck(db, errorSignatures, currentFiles) {
  if (!db || !errorSignatures || errorSignatures.length === 0) return [];

  const findings = [];
  const currentAreas = currentFiles.map(f => path.basename(f, path.extname(f)).toLowerCase());

  errorSignatures.forEach(sig => {
    if (!sig) return;

    // Buscar el mismo error en otras áreas
    const otherInstances = safe(() =>
      db.prepare(`
        SELECT id, titulo, area, contenido, aplicado
        FROM nodos
        WHERE tipo = 'error'
          AND (titulo LIKE ? OR contenido LIKE ?)
          AND estado = 'ACTIVO'
          AND area NOT IN (${currentAreas.map(() => '?').join(',')})
        ORDER BY aplicado DESC
        LIMIT 5
      `).all(`%${sig}%`, `%${sig}%`, ...currentAreas)
    ) || [];

    otherInstances.forEach(inst => {
      // ¿Fue resuelto allá?
      const fixEdge = safe(() =>
        db.prepare(`
          SELECT descripcion, hacia_entidad
          FROM relaciones_semanticas
          WHERE desde_entidad LIKE ?
            AND tipo = 'was_fixed_by'
            AND (invalid_at IS NULL OR invalid_at = '')
          LIMIT 1
        `).get(`%${inst.area}%`)
      );

      findings.push({
        signature:   sig,
        found_in:    inst.area,
        titulo:      inst.titulo,
        was_fixed:   !!fixEdge,
        fix_applied: fixEdge?.descripcion || null,
        fix_target:  fixEdge?.hacia_entidad || null,
        is_systemic: !fixEdge,
        recommendation: fixEdge
          ? `Apply same fix as in ${inst.area}: ${fixEdge.descripcion?.substring(0, 80)}`
          : `Systemic error — also present in ${inst.area} without resolution. Escalate priority.`,
      });
    });
  });

  return findings;
}

// ─── BLAST RADIUS CHECK ───────────────────────────────────────────────────────

function getBlastLevel(db, targetFiles) {
  if (!db) return { level: 'LOW', level_int: 0, contracts_at_risk: 0, protected: 0 };

  let contractsAtRisk = 0;
  let protectedAtRisk = 0;

  try {
    const allContracts = db.prepare(
      "SELECT * FROM verified_contracts WHERE status IN ('protected','verified')"
    ).all();

    targetFiles.forEach(file => {
      const basename = path.basename(file);
      allContracts.forEach(c => {
        const testFile = c.test_file || '';
        const isAtRisk = testFile.includes(basename) ||
          (c.module && file.toLowerCase().includes(c.module.toLowerCase()));
        if (isAtRisk) {
          contractsAtRisk++;
          if (c.status === 'protected') protectedAtRisk++;
        }
      });
    });
  } catch {}

  const level = contractsAtRisk === 0   ? 'LOW'
    : contractsAtRisk <= 3              ? 'LOW'
    : contractsAtRisk <= 10             ? 'MEDIUM'
    : contractsAtRisk <= 20             ? 'HIGH'
    : 'CRITICAL';

  return {
    level,
    level_int: BLAST_LEVELS[level],
    contracts_at_risk: contractsAtRisk,
    protected: protectedAtRisk,
  };
}

// ─── DEFERRED QUEUE ───────────────────────────────────────────────────────────

function loadDeferredQueue(projectRoot) {
  const qPath = path.join(projectRoot, DEFERRED_QUEUE_PATH);
  if (!fs.existsSync(qPath)) return [];
  try { return JSON.parse(fs.readFileSync(qPath, 'utf8')); } catch { return []; }
}

function saveDeferredQueue(projectRoot, queue) {
  const qPath = path.join(projectRoot, DEFERRED_QUEUE_PATH);
  try { fs.writeFileSync(qPath, JSON.stringify(queue, null, 2)); } catch {}
}

function addToDeferred(projectRoot, item) {
  const queue = loadDeferredQueue(projectRoot);
  queue.push({ ...item, deferred_at: new Date().toISOString() });
  // Máx 50 items en cola
  if (queue.length > 50) queue.splice(0, queue.length - 50);
  saveDeferredQueue(projectRoot, queue);
}

function flushDeferredQueue(projectRoot) {
  const queue = loadDeferredQueue(projectRoot);
  if (queue.length === 0) return [];
  saveDeferredQueue(projectRoot, []);
  return queue;
}

// ─── MOTOR DE DECISIÓN PRINCIPAL ─────────────────────────────────────────────
/**
 * Analiza un cambio propuesto y decide qué hacer.
 *
 * @param {Object} params
 * @param {string[]} params.files          Archivos a modificar
 * @param {string}   params.task           Descripción de la tarea
 * @param {string[]} params.errorSignatures Firmas de errores detectados (opcional)
 * @param {string}   params.projectRoot
 */
function analyze(params = {}) {
  const {
    files          = [],
    task           = '',
    errorSignatures= [],
    projectRoot    = process.cwd(),
  } = params;

  const db = openDB(projectRoot);
  const result = {
    decision:     DECISIONS.IMPLEMENT,
    files,
    task,
    blast:        null,
    prerequisites: [],
    cross_module:  [],
    reasons:       [],
    deferred:      [],
    action_plan:   [],
    summary:       '',
  };

  // ── 1. BLAST RADIUS ────────────────────────────────────────────────────────
  if (files.length > 0) {
    result.blast = getBlastLevel(db, files);

    if (result.blast.protected > 0) {
      // Hay contratos PROTECTED en riesgo → STOP
      result.decision = DECISIONS.STOP;
      result.reasons.push(
        `PROTECTED contracts at risk: ${result.blast.protected}. ` +
        `These represent verified behavior that must not break.`
      );
    } else if (result.blast.level === 'CRITICAL') {
      result.decision = DECISIONS.STOP;
      result.reasons.push(
        `Blast radius CRITICAL: ${result.blast.contracts_at_risk} contracts at risk. ` +
        `Too many verified behaviors could break.`
      );
    } else if (result.blast.level === 'HIGH') {
      result.decision = DECISIONS.WARN;
      result.reasons.push(
        `Blast radius HIGH: ${result.blast.contracts_at_risk} contracts at risk. ` +
        `Proceed with caution. Run akdd contracts gate after changes.`
      );
    }
  }

  // ── 2. PREREQUISITE CHAIN ──────────────────────────────────────────────────
  if (files.length > 0 && result.decision !== DECISIONS.STOP) {
    const prereqs = detectPrerequisiteChain(db, files, projectRoot);
    const hardPrereqs = prereqs.filter(p => !p.severity || p.severity === 'hard');
    const softPrereqs = prereqs.filter(p => p.severity === 'soft');

    if (hardPrereqs.length > 0) {
      result.prerequisites = hardPrereqs;
      result.decision = DECISIONS.IMPLEMENT_CAUTIOUS;
      result.reasons.push(
        `Prerequisite chain broken: ${hardPrereqs.length} dependency(ies) have broken contracts. ` +
        `Must fix prerequisites first.`
      );
      result.action_plan = [
        ...hardPrereqs.map(p => ({
          step: 'FIX_PREREQUISITE',
          target: p.prerequisite,
          reason: p.reason,
          before_main_task: true,
        })),
        { step: 'EXECUTE_ORIGINAL_TASK', target: files, task },
      ];
    } else if (softPrereqs.length > 0) {
      result.prerequisites = softPrereqs;
      if (result.decision === DECISIONS.IMPLEMENT) {
        result.decision = DECISIONS.WARN;
      }
      result.reasons.push(
        `Soft prerequisite warning: ${softPrereqs.length} dependency(ies) have unresolved HIGH errors.`
      );
    }
  }

  // ── 3. CROSS-MODULE CHECK ──────────────────────────────────────────────────
  if (errorSignatures.length > 0) {
    const crossModuleFindings = crossModuleCheck(db, errorSignatures, files);
    result.cross_module = crossModuleFindings;

    const systemicErrors = crossModuleFindings.filter(f => f.is_systemic);
    const fixableErrors  = crossModuleFindings.filter(f => f.was_fixed);

    if (systemicErrors.length > 0 && result.decision === DECISIONS.IMPLEMENT) {
      result.decision = DECISIONS.WARN;
      result.reasons.push(
        `Systemic error detected: ${systemicErrors.length} error(s) also present in other modules ` +
        `without resolution. Consider addressing root cause.`
      );
    }

    if (fixableErrors.length > 0) {
      result.reasons.push(
        `Cross-module pattern found: ${fixableErrors.length} error(s) were already ` +
        `resolved in other modules. Applying same fix pattern.`
      );
      result.action_plan.push(
        ...fixableErrors.map(f => ({
          step: 'APPLY_KNOWN_FIX',
          signature: f.signature,
          from_module: f.found_in,
          fix: f.fix_applied,
        }))
      );
    }
  }

  // ── 4. LOW BLAST + SIN HISTORIAL → DEFER ──────────────────────────────────
  if (result.decision === DECISIONS.IMPLEMENT &&
      result.blast?.level === 'LOW' &&
      result.cross_module.length === 0 &&
      result.prerequisites.length === 0 &&
      files.length > 0) {

    // ¿Hay historial causal para estos archivos?
    let hasHistory = false;
    if (db) {
      files.forEach(f => {
        const basename = path.basename(f);
        const history = safe(() =>
          db.prepare(`
            SELECT COUNT(*) as n FROM relaciones_semanticas
            WHERE (desde_entidad LIKE ? OR hacia_entidad LIKE ?)
              AND tipo IN ('caused_failure', 'was_fixed_by', 'regressed_by')
              AND (invalid_at IS NULL OR invalid_at = '')
          `).get(`%${basename}%`, `%${basename}%`)?.n
        ) || 0;
        if (history > 0) hasHistory = true;
      });
    }

    if (!hasHistory && task && task.toLowerCase().includes('minor')) {
      // Solo diferir si explícitamente se indica que es menor
      result.decision = DECISIONS.DEFER;
      result.deferred = files;
      addToDeferred(projectRoot, { files, task, reason: 'Low blast, no history, minor scope' });
      result.reasons.push('Low blast radius, no causal history, minor scope — deferred to end-of-cycle suggestions.');
    }
  }

  // ── 5. RESUMEN EJECUTIVO ───────────────────────────────────────────────────
  result.summary = buildSummary(result);

  if (db) { try { db.close(); } catch {} }
  return result;
}

// ─── RESUMEN EJECUTIVO ────────────────────────────────────────────────────────

function buildSummary(result) {
  const icons = {
    STOP:               '🛑',
    WARN:               '⚠️',
    IMPLEMENT:          '✅',
    IMPLEMENT_CAUTIOUS: '🔄',
    DEFER:              '📋',
  };

  const icon = icons[result.decision] || '?';
  let summary = `${icon} Decision: ${result.decision}`;

  if (result.blast) {
    summary += ` | Blast: ${result.blast.level} (${result.blast.contracts_at_risk} contracts)`;
  }

  if (result.prerequisites.length > 0) {
    summary += ` | Prerequisites: ${result.prerequisites.length} broken`;
  }

  if (result.cross_module.length > 0) {
    const fixed = result.cross_module.filter(f => f.was_fixed).length;
    const systemic = result.cross_module.filter(f => f.is_systemic).length;
    if (fixed > 0) summary += ` | ${fixed} known fix(es) available`;
    if (systemic > 0) summary += ` | ${systemic} systemic error(s)`;
  }

  return summary;
}

// ─── PRINT RESULT ─────────────────────────────────────────────────────────────

function printAnalysis(result) {
  console.log('\n' + '═'.repeat(60));
  console.log('  Autonomous Decision Engine');
  console.log('═'.repeat(60));
  console.log(`\n  ${result.summary}\n`);

  if (result.reasons.length > 0) {
    console.log('  Reasons:');
    result.reasons.forEach(r => console.log(`    • ${r}`));
    console.log('');
  }

  if (result.prerequisites.length > 0) {
    console.log('  Prerequisite chain:');
    result.prerequisites.forEach(p => {
      console.log(`    ⚡ ${p.prerequisite}`);
      console.log(`       ${p.reason}`);
    });
    console.log('');
  }

  if (result.cross_module.length > 0) {
    console.log('  Cross-module findings:');
    result.cross_module.forEach(f => {
      const icon = f.was_fixed ? '✅' : '⚠️';
      console.log(`    ${icon} "${f.signature}" also in ${f.found_in}`);
      console.log(`       ${f.recommendation}`);
    });
    console.log('');
  }

  if (result.action_plan.length > 0) {
    console.log('  Action plan:');
    result.action_plan.forEach((step, i) => {
      console.log(`    ${i + 1}. [${step.step}] ${step.target || step.signature || ''}`);
      if (step.reason) console.log(`       Reason: ${step.reason}`);
      if (step.fix) console.log(`       Apply: ${step.fix}`);
    });
    console.log('');
  }

  console.log('═'.repeat(60) + '\n');
}

// ─── SPRINT PLANNER ───────────────────────────────────────────────────────────
/**
 * Punto 3: Sprint planning con contexto explícito del dev.
 *
 * El dev pasa el contexto una vez. Agentic cruza contra datos técnicos.
 * Produce un plan ejecutable por prioridad real (negocio + técnica).
 *
 * @param {Object} context
 * @param {string} context.objective      "Terminar el módulo de pagos antes del viernes"
 * @param {string[]} context.constraints  ["no tocar auth.ts esta semana"]
 * @param {string[]} context.priorities   ["pagos bloquea al cliente X"]
 * @param {string} projectRoot
 */
function planSprint(context = {}, projectRoot) {
  projectRoot = projectRoot || process.cwd();
  const db = openDB(projectRoot);
  if (!db) return { error: 'DB no disponible' };

  const { objective = '', constraints = [], priorities = [] } = context;

  const plan = {
    objective,
    constraints,
    business_priorities: priorities,
    technical_findings:  [],
    combined_priority:   [],
    sprint_blocks:       [],
  };

  // Detectar deuda técnica por blast radius
  try {
    const highRisk = db.prepare(`
      SELECT DISTINCT module, COUNT(*) as contract_count
      FROM verified_contracts
      WHERE status IN ('invalidated', 'verified')
        AND failure_count > 0
      GROUP BY module
      ORDER BY failure_count DESC, contract_count DESC
      LIMIT 10
    `).all();

    plan.technical_findings = highRisk.map(r => ({
      module:    r.module,
      contracts: r.contract_count,
      priority:  r.contract_count > 5 ? 'HIGH' : r.contract_count > 2 ? 'MEDIUM' : 'LOW',
    }));
  } catch {}

  // Errores sin resolver de alta confianza
  try {
    const unresolvedErrors = db.prepare(`
      SELECT area, COUNT(*) as n, MAX(confianza) as max_conf
      FROM nodos
      WHERE tipo = 'error'
        AND estado = 'ACTIVO'
        AND confianza IN ('ALTA', 'MEDIA')
      GROUP BY area
      ORDER BY n DESC
      LIMIT 8
    `).all();

    unresolvedErrors.forEach(e => {
      plan.technical_findings.push({
        module:   e.area,
        errors:   e.n,
        priority: e.max_conf === 'ALTA' ? 'HIGH' : 'MEDIUM',
        type:     'unresolved_errors',
      });
    });
  } catch {}

  // Combinar prioridad de negocio con prioridad técnica
  const businessKeywords = [...priorities, objective].join(' ').toLowerCase();

  plan.technical_findings.forEach(f => {
    const moduleStr = (f.module || '').toLowerCase();
    const businessMatch = businessKeywords.includes(moduleStr) ||
      priorities.some(p => p.toLowerCase().includes(moduleStr));

    const isConstrained = constraints.some(c =>
      c.toLowerCase().includes(moduleStr)
    );

    plan.combined_priority.push({
      module:           f.module,
      technical_priority: f.priority,
      business_match:   businessMatch,
      constrained:      isConstrained,
      final_priority:   isConstrained ? 'BLOCKED'
        : businessMatch && f.priority === 'HIGH' ? 'P1_CRITICAL'
        : businessMatch ? 'P2_HIGH'
        : f.priority === 'HIGH' ? 'P3_MEDIUM'
        : 'P4_LOW',
    });
  });

  // Ordenar plan
  const order = { P1_CRITICAL:0, P2_HIGH:1, P3_MEDIUM:2, P4_LOW:3, BLOCKED:4 };
  plan.combined_priority.sort((a, b) =>
    (order[a.final_priority] || 3) - (order[b.final_priority] || 3)
  );

  // Bloques del sprint
  plan.sprint_blocks = [
    {
      block: 'Immediate — P1/P2',
      items: plan.combined_priority.filter(p => ['P1_CRITICAL','P2_HIGH'].includes(p.final_priority)),
    },
    {
      block: 'This cycle — P3',
      items: plan.combined_priority.filter(p => p.final_priority === 'P3_MEDIUM'),
    },
    {
      block: 'Next cycle — P4',
      items: plan.combined_priority.filter(p => p.final_priority === 'P4_LOW'),
    },
    {
      block: 'BLOCKED — do not touch',
      items: plan.combined_priority.filter(p => p.final_priority === 'BLOCKED'),
    },
  ].filter(b => b.items.length > 0);

  if (db) { try { db.close(); } catch {} }
  return plan;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const [,, cmd, ...args] = process.argv;
  const projectRoot = process.cwd();

  switch (cmd) {
    case 'analyze': {
      const files = args.filter(a => !a.startsWith('--'));
      const result = analyze({ files, task: args.join(' '), projectRoot });
      printAnalysis(result);
      process.exit(result.decision === DECISIONS.STOP ? 1 : 0);
    }

    case 'queue': {
      const queue = loadDeferredQueue(projectRoot);
      if (queue.length === 0) {
        console.log('\n  Cola diferida vacía.\n');
      } else {
        console.log(`\n  Cola diferida (${queue.length} items):\n`);
        queue.forEach((item, i) => {
          console.log(`  ${i+1}. [${item.deferred_at?.split('T')[0]}] ${item.task}`);
          console.log(`     Files: ${(item.files || []).join(', ')}`);
        });
        console.log('');
      }
      break;
    }

    case 'flush': {
      const flushed = flushDeferredQueue(projectRoot);
      if (flushed.length === 0) {
        console.log('\n  Sin items diferidos.\n');
      } else {
        console.log(`\n  ${flushed.length} items de la cola para revisar:\n`);
        flushed.forEach((item, i) => {
          console.log(`  ${i+1}. ${item.task}`);
          if (item.reason) console.log(`     ${item.reason}`);
        });
        console.log('');
      }
      break;
    }

    case 'sprint': {
      // Uso: node autonomous-decision.cjs sprint --objective "..." --priority "..." --constraint "..."
      const getArg = (flag) => {
        const idx = process.argv.indexOf(flag);
        return idx >= 0 ? process.argv[idx + 1] : null;
      };
      const objective   = getArg('--objective') || 'Complete current sprint tasks';
      const priorities  = process.argv.filter((_, i) => process.argv[i-1] === '--priority');
      const constraints = process.argv.filter((_, i) => process.argv[i-1] === '--constraint');

      const plan = planSprint({ objective, priorities, constraints }, projectRoot);

      if (plan.error) { console.log(`\n  Error: ${plan.error}\n`); break; }

      console.log('\n  Sprint Plan\n  ' + '─'.repeat(40));
      console.log(`  Objective: ${plan.objective}\n`);

      plan.sprint_blocks.forEach(block => {
        console.log(`  ${block.block}:`);
        block.items.forEach(item => {
          const marker = item.business_match ? '★' : '○';
          console.log(`    ${marker} ${item.module} [${item.final_priority}]`);
        });
        console.log('');
      });
      break;
    }

    default:
      console.log('Uso: node autonomous-decision.cjs [analyze <files> | queue | flush | sprint --objective "..."]');
  }
}

module.exports = {
  analyze,
  planSprint,
  detectPrerequisiteChain,
  crossModuleCheck,
  getBlastLevel,
  loadDeferredQueue,
  flushDeferredQueue,
  DECISIONS,
};
