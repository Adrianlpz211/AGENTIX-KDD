/**
 * Regression Guard — Agentic KDD v3.6
 *
 * Resuelve: "arreglé una cosa y rompí otra que ya funcionaba"
 *
 * Dos momentos de acción:
 *   ANTES del build: checkBeforeBuild() — ¿este cambio rompería algo sano?
 *   DESPUÉS del ciclo: registerBehavior() — guardar snapshot de lo que quedó bien
 *
 * Auto-registration: no requiere intervención del dev.
 * El sistema infiere módulo, archivos y tests del ciclo exitoso.
 */

'use strict';

const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const { execSync } = require('child_process');

// ─── SCHEMA ───────────────────────────────────────────────────────────────────

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS protected_behaviors (
      id                TEXT PRIMARY KEY,
      module            TEXT NOT NULL,
      description       TEXT NOT NULL,
      critical_flows    TEXT DEFAULT '[]',
      test_patterns     TEXT DEFAULT '[]',
      related_files     TEXT DEFAULT '[]',
      pass_count        INTEGER DEFAULT 1,
      confidence        TEXT DEFAULT 'MEDIA',
      status            TEXT DEFAULT 'active',
      last_verified_at  TEXT DEFAULT (datetime('now')),
      created_at        TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS invariant_violations (
      id            TEXT PRIMARY KEY,
      behavior_id   TEXT NOT NULL,
      cycle         INTEGER DEFAULT 0,
      changed_files TEXT DEFAULT '[]',
      failed_tests  TEXT DEFAULT '[]',
      description   TEXT,
      fixed_at      TEXT,
      created_at    TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (behavior_id) REFERENCES protected_behaviors(id)
    );

    CREATE INDEX IF NOT EXISTS idx_pb_module ON protected_behaviors(module);
    CREATE INDEX IF NOT EXISTS idx_pb_status ON protected_behaviors(status);
    CREATE INDEX IF NOT EXISTS idx_iv_behavior ON invariant_violations(behavior_id);
  `);
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

const safe = (fn, fb = null) => { try { return fn(); } catch { return fb; } };
const parseJ = (s, fb = []) => { try { return JSON.parse(s); } catch { return fb; } };

function inferModule(filePaths) {
  const segments = filePaths
    .map(f => f.replace(/\\/g, '/'))
    .flatMap(f => f.split('/'))
    .map(s => s.replace(/\.(ts|js|cjs|mjs)$/, ''))
    .filter(s => s && !['src','routes','lib','middleware','tests','unit','integration','index'].includes(s));
  
  const counts = {};
  segments.forEach(s => { counts[s] = (counts[s] || 0) + 1; });
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0] || 'global';
}

function extractFlows(filePaths, projectRoot) {
  const flows = [];
  const methods = ['get', 'post', 'put', 'patch', 'delete'];
  
  filePaths.forEach(fp => {
    const full = path.isAbsolute(fp) ? fp : path.join(projectRoot, fp);
    if (!fs.existsSync(full)) return;
    const content = safe(() => fs.readFileSync(full, 'utf8'), '');
    
    methods.forEach(method => {
      const regex = new RegExp(`app\\.${method}\\(['"\`]([^'"\`]+)`, 'gi');
      const matches = content.matchAll(regex);
      for (const m of matches) {
        flows.push(`${method.toUpperCase()} ${m[1]}`);
      }
    });
  });
  
  return [...new Set(flows)].slice(0, 20);
}

function inferTestPatterns(filePaths) {
  return filePaths
    .map(f => path.basename(f.replace(/\\/g, '/')))
    .filter(f => f.includes('.test.') || f.includes('.spec.'))
    .filter((v, i, a) => a.indexOf(v) === i);
}

function findRelatedBehaviors(db, filePaths) {
  const behaviors = safe(() =>
    db.prepare(`
      SELECT * FROM protected_behaviors
      WHERE status = 'active'
        AND confidence IN ('HIGH', 'MEDIA')
    `).all()
  ) || [];

  const fpNorm = filePaths.map(f => f.replace(/\\/g, '/').toLowerCase());

  return behaviors.filter(b => {
    const bFiles = parseJ(b.related_files, []).map(f => f.replace(/\\/g, '/').toLowerCase());
    return bFiles.some(bf => fpNorm.some(fp => fp.includes(bf) || bf.includes(fp)));
  });
}

function runTestFile(testPattern, projectRoot) {
  try {
    const isWin = process.platform === 'win32';
    const shell = isWin ? 'cmd.exe' : 'sh';
    const flag  = isWin ? '/c' : '-c';
    const cmd   = `npm test -- --testPathPattern="${testPattern}" 2>&1`;
    
    const result = require('child_process').spawnSync(
      shell, [flag, cmd],
      { cwd: projectRoot, timeout: 60000, encoding: 'utf8', stdio: 'pipe' }
    );
    
    const output = (result.stdout || '') + (result.stderr || '');
    const clean  = output.replace(/\x1b\[[0-9;]*[mGKHF]/g, '');
    
    const passed = clean.match(/(\d+)\s+passed/i)?.[1];
    const failed = clean.match(/(\d+)\s+failed/i)?.[1];
    
    return {
      passed:     parseInt(passed || '0'),
      failed:     parseInt(failed || '0'),
      allPassed:  result.status === 0 || (!failed && !!passed),
      output:     clean.slice(-500),
    };
  } catch(e) {
    return { passed: 0, failed: 1, allPassed: false, output: e.message };
  }
}

// ─── CORE FUNCTIONS ───────────────────────────────────────────────────────────

/**
 * STEP 4 — llamar ANTES del build.
 * Si encuentra behaviors HIGH relacionados con los archivos → corre sus tests.
 * Si alguno falla → STOP.
 */
function checkBeforeBuild(db, filesToChange, projectRoot) {
  ensureSchema(db);
  projectRoot = projectRoot || process.cwd();

  const related = findRelatedBehaviors(db, filesToChange);
  if (related.length === 0) {
    return { passed: true, reason: 'No protected behaviors related to this changeset' };
  }

  const highConfidence = related.filter(b => b.confidence === 'HIGH');
  const mediaConfidence = related.filter(b => b.confidence === 'MEDIA');
  const violations = [];
  const warnings   = [];

  // HIGH confidence → run tests, block if any fail
  highConfidence.forEach(behavior => {
    const patterns = parseJ(behavior.test_patterns, []);
    patterns.forEach(pattern => {
      const result = runTestFile(pattern, projectRoot);
      if (!result.allPassed) {
        violations.push({
          behavior_id:  behavior.id,
          behavior:     behavior.description,
          module:       behavior.module,
          test_pattern: pattern,
          failed:       result.failed,
          confidence:   'HIGH',
        });
      }
    });
  });

  // MEDIA confidence → warn but don't block
  mediaConfidence.forEach(behavior => {
    warnings.push({
      behavior:   behavior.description,
      module:     behavior.module,
      confidence: 'MEDIA',
    });
  });

  if (violations.length > 0) {
    return {
      passed:     false,
      violations,
      warnings,
      message:    [
        `🛑 REGRESSION GUARD STOP: ${violations.length} protected behavior(s) at risk:`,
        ...violations.map(v =>
          `  [HIGH] "${v.behavior}" (${v.module}) — test "${v.test_pattern}" currently failing`
        ),
        '',
        'Fix the failing tests before modifying these files.',
        'To override: add --override-regression to your aa: command.',
      ].join('\n'),
    };
  }

  const result = { passed: true };
  if (warnings.length > 0) {
    result.warnings = warnings;
    result.message = `⚠️  REGRESSION GUARD WARN: ${warnings.length} MEDIA behavior(s) in changeset path — proceed carefully.`;
  }
  return result;
}

/**
 * STEP 9 — llamar DESPUÉS de TDD Gate PASS + QA PASS.
 * Auto-registra snapshot de comportamientos sanos.
 * No requiere intervención del dev.
 */
function registerBehavior(db, params) {
  ensureSchema(db);

  const {
    module:       moduleName,
    files:        changedFiles = [],
    testFiles:    testPassed   = [],
    testOutput,
    projectRoot,
  } = params;

  const root    = projectRoot || process.cwd();
  const module_ = moduleName || inferModule(changedFiles);
  const flows   = extractFlows(changedFiles, root);
  const tests   = testPassed.length > 0 ? testPassed : inferTestPatterns(changedFiles);

  if (module_ === 'global' && changedFiles.length === 0) return null;

  const description = `${module_} module — ${flows.length > 0
    ? flows.slice(0, 3).join(', ')
    : `${changedFiles.length} files`} functioning correctly`;

  // Check if behavior for this module already exists
  const existing = safe(() =>
    db.prepare(`
      SELECT id, pass_count, confidence FROM protected_behaviors
      WHERE module = ? AND status = 'active'
      LIMIT 1
    `).get(module_)
  );

  if (existing) {
    const newCount     = existing.pass_count + 1;
    const newConfidence = newCount >= 5 ? 'HIGH' : 'MEDIA';

    safe(() =>
      db.prepare(`
        UPDATE protected_behaviors SET
          pass_count       = ?,
          confidence       = ?,
          description      = ?,
          critical_flows   = ?,
          test_patterns    = ?,
          related_files    = ?,
          last_verified_at = datetime('now')
        WHERE id = ?
      `).run(
        newCount,
        newConfidence,
        description,
        JSON.stringify(flows),
        JSON.stringify(tests),
        JSON.stringify(changedFiles.slice(0, 10)),
        existing.id
      )
    );

    return { id: existing.id, module: module_, pass_count: newCount, confidence: newConfidence, updated: true };
  }

  // Create new behavior
  const id = `pb_${module_}_${Date.now()}`;
  safe(() =>
    db.prepare(`
      INSERT OR IGNORE INTO protected_behaviors
        (id, module, description, critical_flows, test_patterns, related_files, pass_count, confidence)
      VALUES (?, ?, ?, ?, ?, ?, 1, 'MEDIA')
    `).run(
      id, module_, description,
      JSON.stringify(flows),
      JSON.stringify(tests),
      JSON.stringify(changedFiles.slice(0, 10))
    )
  );

  return { id, module: module_, pass_count: 1, confidence: 'MEDIA', created: true };
}

/**
 * STEP after TDD Gate — verify protected behaviors weren't silently broken.
 * Compares current test output against registered behaviors.
 */
function verifyAfterTDD(db, testOutput, changedFiles, projectRoot) {
  ensureSchema(db);
  projectRoot = projectRoot || process.cwd();

  const related = findRelatedBehaviors(db, changedFiles);
  if (related.length === 0) return { passed: true };

  const clean = (testOutput || '').replace(/\x1b\[[0-9;]*[mGKHF]/g, '');
  const violations = [];

  related.forEach(behavior => {
    const patterns = parseJ(behavior.test_patterns, []);
    patterns.forEach(pattern => {
      // Check if this test file appears in the output as failed
      const failPattern = new RegExp(`FAIL.*${pattern.replace('.', '\\.')}`, 'i');
      if (failPattern.test(clean)) {
        violations.push({
          behavior_id:  behavior.id,
          behavior:     behavior.description,
          module:       behavior.module,
          test_pattern: pattern,
        });

        // Record violation
        const vid = `iv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        safe(() =>
          db.prepare(`
            INSERT OR IGNORE INTO invariant_violations
              (id, behavior_id, changed_files, failed_tests, description)
            VALUES (?, ?, ?, ?, ?)
          `).run(
            vid,
            behavior.id,
            JSON.stringify(changedFiles),
            JSON.stringify([pattern]),
            `${pattern} failed after changes to ${changedFiles.join(', ')}`
          )
        );

        // Mark behavior as violated
        safe(() =>
          db.prepare(`UPDATE protected_behaviors SET status = 'violated' WHERE id = ?`)
            .run(behavior.id)
        );
      } else {
        // Test still passing — update verified timestamp
        safe(() =>
          db.prepare(`UPDATE protected_behaviors SET last_verified_at = datetime('now') WHERE id = ?`)
            .run(behavior.id)
        );
      }
    });
  });

  if (violations.length > 0) {
    return {
      passed:     false,
      violations,
      message: `⚠️  REGRESSION DETECTED: ${violations.length} previously-healthy behavior(s) broken:\n` +
        violations.map(v => `  [${v.module}] "${v.behavior}" — ${v.test_pattern} now failing`).join('\n'),
    };
  }

  return { passed: true, verified: related.length };
}

/**
 * Status report — akdd regression status
 */
function regressionStatus(db) {
  ensureSchema(db);

  const behaviors   = safe(() => db.prepare(`SELECT * FROM protected_behaviors ORDER BY confidence DESC, pass_count DESC`).all()) || [];
  const violations  = safe(() => db.prepare(`SELECT * FROM invariant_violations WHERE fixed_at IS NULL ORDER BY created_at DESC`).all()) || [];

  const high    = behaviors.filter(b => b.confidence === 'HIGH'   && b.status === 'active');
  const media   = behaviors.filter(b => b.confidence === 'MEDIA'  && b.status === 'active');
  const violated= behaviors.filter(b => b.status === 'violated');

  const lines = [
    '',
    '═══════════════════════════════════════════════════',
    '  Regression Guard — Protected Behaviors',
    '═══════════════════════════════════════════════════',
    `  HIGH (${high.length}):      fully protected behaviors`,
    `  MEDIA (${media.length}):    emerging behaviors (< 5 cycles)`,
    `  VIOLATED (${violated.length}): currently broken`,
    `  Open violations: ${violations.length}`,
    '',
  ];

  if (high.length > 0) {
    lines.push('  ── HIGH confidence ────────────────────────────');
    high.forEach(b => lines.push(`  ✅ [${b.module}] ${b.description.substring(0, 60)} (${b.pass_count} cycles)`));
  }

  if (violated.length > 0) {
    lines.push('\n  ── VIOLATED ────────────────────────────────────');
    violated.forEach(b => lines.push(`  ❌ [${b.module}] ${b.description.substring(0, 60)}`));
  }

  if (media.length > 0) {
    lines.push('\n  ── MEDIA confidence ────────────────────────────');
    media.forEach(b => lines.push(`  🔶 [${b.module}] ${b.description.substring(0, 60)} (${b.pass_count} cycles)`));
  }

  lines.push('═══════════════════════════════════════════════════\n');
  return lines.join('\n');
}

/**
 * Deprecate a behavior manually — akdd behaviors deprecate <id>
 */
function deprecateBehavior(db, id) {
  ensureSchema(db);
  const result = safe(() =>
    db.prepare(`UPDATE protected_behaviors SET status = 'deprecated' WHERE id = ?`).run(id)
  );
  return result?.changes > 0;
}

/**
 * Fix a violation — called after the dev confirms the regression was intentional
 */
function fixViolation(db, behaviorId) {
  ensureSchema(db);
  safe(() => {
    db.prepare(`UPDATE invariant_violations SET fixed_at = datetime('now') WHERE behavior_id = ? AND fixed_at IS NULL`).run(behaviorId);
    db.prepare(`UPDATE protected_behaviors SET status = 'active', pass_count = 1, confidence = 'MEDIA' WHERE id = ?`).run(behaviorId);
  });
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const cmd  = process.argv[2] || 'status';
  const args = process.argv.slice(3);

  const dbPath = path.join(process.cwd(), '.agentic/memoria.db');
  if (!require('fs').existsSync(dbPath)) {
    console.log('No .agentic/memoria.db found. Run: akdd init');
    process.exit(0);
  }

  const DB = new (require('better-sqlite3'))(dbPath);
  ensureSchema(DB);

  switch(cmd) {
    case 'status':
      console.log(regressionStatus(DB));
      break;

    case 'check': {
      const files = args;
      if (!files.length) { console.log('Usage: regression-guard.cjs check <file1> <file2>...'); break; }
      const result = checkBeforeBuild(DB, files, process.cwd());
      if (!result.passed) {
        console.log(result.message);
        process.exit(1);
      }
      console.log(result.message || '✅ REGRESSION GUARD PASS');
      break;
    }

    case 'register': {
      const module = args[0] || 'global';
      const files  = args.slice(1);
      const result = registerBehavior(DB, { module, files, projectRoot: process.cwd() });
      if (result) {
        console.log(`✅ Behavior ${result.created ? 'created' : 'updated'}: [${result.module}] ${result.confidence} (${result.pass_count} cycles)`);
      }
      break;
    }

    case 'deprecate': {
      const id = args[0];
      if (!id) { console.log('Usage: regression-guard.cjs deprecate <behavior-id>'); break; }
      deprecateBehavior(DB, id);
      console.log(`✅ Behavior ${id} deprecated`);
      break;
    }

    case 'fix': {
      const id = args[0];
      if (!id) { console.log('Usage: regression-guard.cjs fix <behavior-id>'); break; }
      fixViolation(DB, id);
      console.log(`✅ Violation fixed, behavior reset to MEDIA`);
      break;
    }

    default:
      console.log('Commands: status | check <files> | register <module> <files> | deprecate <id> | fix <id>');
  }

  DB.close();
}

module.exports = {
  ensureSchema,
  checkBeforeBuild,
  registerBehavior,
  verifyAfterTDD,
  regressionStatus,
  deprecateBehavior,
  fixViolation,
};
