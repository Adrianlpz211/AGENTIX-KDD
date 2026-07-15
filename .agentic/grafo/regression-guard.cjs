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

  // v3.13 — anclas de símbolos por behavior (contención por líneas, fase 2 semilla).
  // ALTER falla si la columna ya existe — silenciado a propósito (patrón del proyecto).
  try { db.exec(`ALTER TABLE protected_behaviors ADD COLUMN protected_symbols TEXT DEFAULT '[]'`); } catch {}
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

function extractFlows(filePaths, projectRoot, db) {
  const flows = [];
  // v3.13 — MISMO patrón que el endpointPattern de ast-indexer.cjs, carácter a
  // carácter: el veredicto de contención busca estos flows como symbol_name por
  // IGUALDAD EXACTA — si el formato difiere en un espacio, nunca se encuentran.
  // Además arregla un bug real: el patrón viejo solo veía `app.get(...)` — se
  // perdían TODOS los endpoints declarados con `router.get(...)` (Router()).
  const endpointRe = /\b(?:router|app)\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/g;

  filePaths.forEach(fp => {
    const full = path.isAbsolute(fp) ? fp : path.join(projectRoot, fp);
    if (!fs.existsSync(full)) return;
    const content = safe(() => fs.readFileSync(full, 'utf8'), '');
    endpointRe.lastIndex = 0;
    let m;
    while ((m = endpointRe.exec(content)) !== null) {
      flows.push(`${m[1].toUpperCase()} ${m[2]}`);
    }
  });

  // Flujos UI (Plan 2, Fase B) — DESDE EL ÍNDICE, jamás con regex propio: una
  // sola fuente de verdad de nombres (si extractFlows generara los nombres con
  // su propio regex, cualquier divergencia de un carácter contra el indexador
  // rompería el JOIN por igualdad — la lección del Plan 1). Formatos estables:
  //   FORM form#login · SELECT select[name=linea] · REQUIRED input[name=email]
  if (db) {
    filePaths.forEach(fp => {
      const relNorm = String(fp).replace(/\\/g, '/');
      if (!/\.(html|htm|js|jsx|ts|tsx|vue|svelte)$/i.test(relNorm)) return;
      for (const k of [relNorm, relNorm.replace(/\//g, '\\')]) {
        const rows = safe(() => db.prepare(
          "SELECT symbol_name, kind, signature FROM ast_symbols WHERE file = ? AND kind IN ('form','select','field')"
        ).all(k)) || [];
        if (!rows.length) continue;
        rows.forEach(r => {
          if (r.kind === 'form') flows.push(`FORM ${r.symbol_name}`);
          else if (r.kind === 'select') flows.push(`SELECT ${r.symbol_name}`);
          if ((r.kind === 'field' || r.kind === 'select') && String(r.signature || '').startsWith('[required]')) {
            flows.push(`REQUIRED ${r.symbol_name}`);
          }
        });
        break;
      }
    });
  }

  return [...new Set(flows)].slice(0, 30);
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

    // Detect Python project
    const isPython =
      fs.existsSync(path.join(projectRoot, 'requirements.txt')) ||
      fs.existsSync(path.join(projectRoot, 'backend', 'requirements.txt'));

    // Sanitizar testPattern: solo caracteres válidos de ruta/patrón de test.
    // Elimina metacaracteres de shell ("`$;&|()<>) para evitar inyección de comandos,
    // ya que testPattern proviene de la DB (nombres de archivo) e se interpola en el shell.
    const safePattern = String(testPattern || '').replace(/[^A-Za-z0-9._/\\*\- ]/g, '');

    let cmd;
    if (isPython) {
      // testPattern for pytest = test file or -k expression
      const backendDir = fs.existsSync(path.join(projectRoot, 'backend', 'requirements.txt'))
        ? 'backend' : '.';
      cmd = `cd ${backendDir} && pytest -x -v 2>&1`;
    } else {
      cmd = `npm test -- --testPathPattern="${safePattern}" 2>&1`;
    }

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

// ─── CONTENCIÓN POR LÍNEAS (v3.13 — números, no palabras) ─────────────────────
// Responde: "¿las líneas que cambiaste caen DENTRO del rango de algún flow o
// ancla protegida de este behavior?" — comparación de enteros contra el índice
// AST, con frescura verificada por hash SHA-256 del contenido en disco.
//
// Regla de oro (fail-closed): ante CUALQUIER duda devuelve DOUBT y el caller se
// comporta EXACTAMENTE como siempre (nivel archivo). Ninguna falla de esta
// maquinaria puede dejar pasar lo que hoy se detecta — un fallo solo cuesta que
// la alarma suene como sonaba antes. La degradación (MISS) exige evidencia
// positiva COMPLETA: hash fresco + todos los anclajes localizados con line_end
// calculado + diff real presente en TODOS los archivos relacionados tocados
// (diff vacío = el cambio aún no está aplicado, ej. Step 4 pre-build → DOUBT).
function lineContainmentVerdict(db, behavior, filesToChange, projectRoot) {
  const DOUBT = (why) => ({ mode: 'DOUBT', why });
  try {
    const norm = f => String(f).replace(/\\/g, '/');
    const flows   = parseJ(behavior.critical_flows, []);
    const anchors = parseJ(behavior.protected_symbols, []);
    if (!flows.length && !anchors.length) return DOUBT('behavior sin flows ni anclas');

    let gitCtx, indexer;
    try {
      gitCtx  = require(path.join(__dirname, 'git-context.cjs'));
      indexer = require(path.join(__dirname, 'ast-indexer.cjs'));
    } catch { return DOUBT('módulos de soporte no disponibles'); }
    if (typeof gitCtx.getChangedLines !== 'function') return DOUBT('getChangedLines no disponible');

    const bFiles = parseJ(behavior.related_files, []).map(f => norm(f).toLowerCase());
    const changedRelated = (filesToChange || [])
      .map(norm)
      .filter(fp => bFiles.some(bf => fp.toLowerCase().includes(bf) || bf.includes(fp.toLowerCase())));
    if (!changedRelated.length) return DOUBT('sin archivos del behavior en el changeset');

    // 1. FRESCURA — el índice debe describir EXACTAMENTE el contenido en disco
    //    (hash igual). Si difiere, re-indexar (barato, idempotente); si aún
    //    difiere → DOUBT. La BD puede guardar la ruta con / o \ — probar ambas.
    for (const rel of changedRelated) {
      const full = path.isAbsolute(rel) ? rel : path.join(projectRoot, rel);
      if (!fs.existsSync(full)) return DOUBT(`archivo no existe en disco: ${rel}`);
      const hashDisco = crypto.createHash('sha256').update(fs.readFileSync(full, 'utf8')).digest('hex');
      const candidates = [rel, rel.replace(/\//g, '\\')];
      const lookup = () => {
        for (const k of candidates) {
          const r = safe(() => db.prepare('SELECT content_hash FROM ast_symbols WHERE file = ? LIMIT 1').get(k));
          if (r) return r.content_hash;
        }
        return null;
      };
      let indexado = lookup();
      if (indexado !== hashDisco) {
        safe(() => indexer.indexFile(db, full, projectRoot));
        indexado = lookup();
        if (indexado !== hashDisco) return DOUBT(`índice desactualizado para ${rel}`);
      }
    }

    // 2. LOCALIZAR cada flow y cada ancla en el índice — igualdad EXACTA de
    //    symbol_name (nada de LIKE/substring: esa clase de matching de texto ya
    //    produjo 3 bugs reales el 2026-07-15). Anclaje no localizable → DOUBT.
    const ubicaciones = [];
    const dentroDelBehavior = (file) => {
      const rf = norm(file).toLowerCase();
      return bFiles.some(bf => rf.includes(bf) || bf.includes(rf));
    };
    // Mapeo prefijo→kind (Plan 2, Fase B): los flujos de endpoint usan el flow
    // COMPLETO como symbol_name ('GET /x'); los flujos UI usan el nombre SIN el
    // prefijo ('FORM form#login' → símbolo 'form#login' de kind 'form').
    const FLOW_KINDS = {
      GET: ['endpoint'], POST: ['endpoint'], PUT: ['endpoint'], DELETE: ['endpoint'],
      PATCH: ['endpoint'], ANY: ['endpoint'],
      FORM: ['form'], SELECT: ['select'], REQUIRED: ['field', 'select'],
    };
    for (const flow of flows) {
      const espacio = String(flow).indexOf(' ');
      const prefijo = espacio > 0 ? String(flow).slice(0, espacio) : '';
      const kinds = FLOW_KINDS[prefijo];
      if (!kinds) return DOUBT(`flow con prefijo desconocido: "${flow}"`);
      const nombre = kinds[0] === 'endpoint' ? String(flow) : String(flow).slice(espacio + 1);
      const filas = safe(() => db.prepare(
        `SELECT file, line_start, line_end FROM ast_symbols WHERE kind IN (${kinds.map(() => '?').join(',')}) AND symbol_name = ?`
      ).all(...kinds, nombre)) || [];
      const propias = filas.filter(r => dentroDelBehavior(r.file));
      if (!propias.length) return DOUBT(`flow "${flow}" no localizado en el índice`);
      for (const r of propias) {
        if (!r.line_end || r.line_end <= 0) return DOUBT(`line_end sin calcular para "${flow}"`);
        ubicaciones.push({ etiqueta: flow, fileNorm: norm(r.file).toLowerCase(), start: r.line_start, end: r.line_end });
      }
    }
    for (const a of anchors) {
      if (!a || !a.symbol_name || !a.kind) continue;
      const filas = safe(() => db.prepare(
        'SELECT file, line_start, line_end FROM ast_symbols WHERE kind = ? AND symbol_name = ?'
      ).all(a.kind, a.symbol_name)) || [];
      const propias = filas.filter(r =>
        norm(r.file).toLowerCase() === norm(a.file || '').toLowerCase() || dentroDelBehavior(r.file));
      if (!propias.length) return DOUBT(`ancla "${a.symbol_name}" no localizada`);
      for (const r of propias) {
        if (!r.line_end || r.line_end <= 0) return DOUBT(`line_end sin calcular para ancla "${a.symbol_name}"`);
        ubicaciones.push({ etiqueta: `${a.kind} ${a.symbol_name}`, fileNorm: norm(r.file).toLowerCase(), start: r.line_start, end: r.line_end });
      }
    }

    // 3. LÍNEAS CAMBIADAS (lado NUEVO del diff — la misma "foto" del archivo
    //    que el índice recién verificado por hash).
    const hits = [];
    for (const rel of changedRelated) {
      const changed = gitCtx.getChangedLines(projectRoot, rel);
      if (changed === null) return DOUBT(`diff no disponible para ${rel}`);
      if (!changed.length) return DOUBT(`sin diff en ${rel} — cambio aún no aplicado`);
      for (const u of ubicaciones) {
        if (u.fileNorm !== rel.toLowerCase()) continue;
        const tocadas = changed.filter(l => l >= u.start && l <= u.end);
        if (tocadas.length) {
          hits.push({ etiqueta: u.etiqueta, file: rel, start: u.start, end: u.end, lineas: tocadas.slice(0, 10) });
        }
      }
    }

    if (hits.length) return { mode: 'HIT', hits };
    return { mode: 'MISS', zonas: [...new Set(ubicaciones.map(u => u.etiqueta))].slice(0, 8) };
  } catch (e) {
    return { mode: 'DOUBT', why: 'error inesperado: ' + (e && e.message ? e.message : String(e)) };
  }
}

// Anclas de símbolos tocados por un ciclo (v3.13 — fase 2 semilla). Guarda
// NOMBRES estables (file + symbol_name + kind), NUNCA números de línea: las
// líneas se pudren con cada edición del archivo; se resuelven frescas contra
// el índice en el momento del check (lineContainmentVerdict).
function computeTouchedSymbols(db, changedFiles, projectRoot) {
  const out = [];
  let gitCtx, indexer;
  try {
    gitCtx  = require(path.join(__dirname, 'git-context.cjs'));
    indexer = require(path.join(__dirname, 'ast-indexer.cjs'));
  } catch { return out; }
  if (typeof gitCtx.getChangedLines !== 'function') return out;

  for (const rel of (changedFiles || []).slice(0, 10)) {
    try {
      const relNorm = String(rel).replace(/\\/g, '/');
      const full = path.isAbsolute(rel) ? rel : path.join(projectRoot, rel);
      if (!fs.existsSync(full)) continue;
      safe(() => indexer.indexFile(db, full, projectRoot)); // refresca solo si el hash cambió
      let rows = [];
      for (const k of [relNorm, relNorm.replace(/\//g, '\\')]) {
        rows = safe(() => db.prepare(
          "SELECT file, symbol_name, kind, line_start, line_end FROM ast_symbols WHERE file = ? AND line_end > 0 AND kind IN ('function','class','endpoint','form','select','field')"
        ).all(k)) || [];
        if (rows.length) break;
      }
      if (!rows.length) continue;
      const changed = gitCtx.getChangedLines(projectRoot, relNorm);
      if (!changed || !changed.length) continue;
      rows.forEach(r => {
        if (changed.some(l => l >= r.line_start && l <= r.line_end)) {
          out.push({ file: r.file, symbol_name: r.symbol_name, kind: r.kind });
        }
      });
    } catch {}
  }
  return out.slice(0, 30);
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
  const notices    = []; // v3.13 — behaviors compartidos cuyas zonas protegidas NO se tocan

  // HIGH confidence → contención por líneas primero (v3.13):
  //   MISS (evidencia completa: líneas cambiadas fuera de toda zona protegida)
  //     → no correr tests aquí; NOTICE informativo. verifyAfterTDD (Step 9)
  //       sigue verificando TODO después del cambio — esto solo degrada el
  //       pre-check de "terreno verde", que era la fuente de falsas alarmas.
  //   HIT o DOUBT → exactamente el comportamiento de siempre (correr tests,
  //       STOP si fallan), con la zona exacta en el mensaje cuando es HIT.
  highConfidence.forEach(behavior => {
    const verdict = lineContainmentVerdict(db, behavior, filesToChange, projectRoot);
    if (verdict.mode === 'MISS') {
      notices.push({
        behavior: behavior.description, module: behavior.module, confidence: 'HIGH',
        detalle: `líneas cambiadas fuera de las zonas protegidas [${(verdict.zonas || []).join(', ')}]`,
      });
      return;
    }
    const zona = verdict.mode === 'HIT'
      ? verdict.hits.map(h => `${h.etiqueta} (líneas ${h.start}-${h.end})`).join(', ')
      : null;
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
          zona,
        });
      }
    });
  });

  // MEDIA confidence → warn but don't block (misma contención por líneas)
  mediaConfidence.forEach(behavior => {
    const verdict = lineContainmentVerdict(db, behavior, filesToChange, projectRoot);
    if (verdict.mode === 'MISS') {
      notices.push({
        behavior: behavior.description, module: behavior.module, confidence: 'MEDIA',
        detalle: `líneas cambiadas fuera de las zonas protegidas [${(verdict.zonas || []).join(', ')}]`,
      });
      return;
    }
    warnings.push({
      behavior:   behavior.description,
      module:     behavior.module,
      confidence: 'MEDIA',
      ...(verdict.mode === 'HIT'
        ? { zona: verdict.hits.map(h => `${h.etiqueta} (líneas ${h.start}-${h.end})`).join(', ') }
        : {}),
    });
  });

  if (violations.length > 0) {
    return {
      passed:     false,
      violations,
      warnings,
      notices,
      message:    [
        `🛑 REGRESSION GUARD STOP: ${violations.length} protected behavior(s) at risk:`,
        ...violations.map(v =>
          `  [HIGH] "${v.behavior}" (${v.module}) — test "${v.test_pattern}" currently failing${v.zona ? ` — tocas ${v.zona}` : ''}`
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
    result.message = `⚠️  REGRESSION GUARD WARN: ${warnings.length} MEDIA behavior(s) in changeset path — proceed carefully.` +
      warnings.filter(w => w.zona).map(w => `\n  ⚠️  [${w.module}] tocas ${w.zona}`).join('');
  }
  if (notices.length > 0) {
    result.notices = notices;
    const nl = notices.map(n => `  ℹ️  [${n.confidence}] "${n.behavior}" — ${n.detalle}`).join('\n');
    result.message = (result.message ? result.message + '\n' : '') +
      `ℹ️  CONTENCIÓN POR LÍNEAS: ${notices.length} behavior(s) compartido(s) sin tocar sus zonas protegidas:\n${nl}`;
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
  // Plan 2: anchors PRIMERO — computeTouchedSymbols re-indexa los archivos
  // cambiados (hash-gated), y extractFlows lee los flujos UI de ese índice fresco.
  const anchors = computeTouchedSymbols(db, changedFiles, root); // v3.13 — nombres estables, nunca líneas
  const flows   = extractFlows(changedFiles, root, db);
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

    // v3.13 — unir anclas nuevas con las previas (sin duplicar): las
    // protecciones se acumulan ciclo a ciclo, no se reemplazan.
    const prev = safe(() => db.prepare('SELECT protected_symbols FROM protected_behaviors WHERE id = ?').get(existing.id));
    const seenAnchor = new Set();
    const mergedAnchors = [];
    [...parseJ(prev && prev.protected_symbols, []), ...anchors].forEach(a => {
      if (!a || !a.symbol_name) return;
      const k = `${a.file}|${a.symbol_name}|${a.kind}`.toLowerCase();
      if (!seenAnchor.has(k)) { seenAnchor.add(k); mergedAnchors.push(a); }
    });

    safe(() =>
      db.prepare(`
        UPDATE protected_behaviors SET
          pass_count       = ?,
          confidence       = ?,
          description      = ?,
          critical_flows   = ?,
          test_patterns    = ?,
          related_files    = ?,
          protected_symbols = ?,
          last_verified_at = datetime('now')
        WHERE id = ?
      `).run(
        newCount,
        newConfidence,
        description,
        JSON.stringify(flows),
        JSON.stringify(tests),
        JSON.stringify(changedFiles.slice(0, 10)),
        JSON.stringify(mergedAnchors.slice(0, 50)),
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
        (id, module, description, critical_flows, test_patterns, related_files, protected_symbols, pass_count, confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'MEDIA')
    `).run(
      id, module_, description,
      JSON.stringify(flows),
      JSON.stringify(tests),
      JSON.stringify(changedFiles.slice(0, 10)),
      JSON.stringify(anchors.slice(0, 50))
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
  lineContainmentVerdict,
  computeTouchedSymbols,
};
