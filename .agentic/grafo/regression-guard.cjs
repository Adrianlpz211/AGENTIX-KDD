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
const esc     = require('./escenarios.cjs');

// ─── SCHEMA ───────────────────────────────────────────────────────────────────
// Solo lo llaman los que ESCRIBEN (register, deprecate, fix, proteger, renombrar).
// Leer (check, verify, status) nunca crea tablas: sin tablas, el estado es
// "no verificado", no "sano".

function tablasPresentes(db) {
  const r = safe(() => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'protected_behaviors'").get());
  return !!r;
}

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

/**
 * ¿La entrada protegida `entrada` cubre el archivo `archivo`? Por segmentos:
 * igual, o `archivo` dentro del directorio `entrada`. Una entrada vieja que es
 * solo un nombre de archivo (sin carpeta) cubre ese nombre exacto.
 * "auth" no cubre "oauth-helper.js".
 */
function cubre(entrada, archivo) {
  const e = esc.clave(entrada).replace(/\/+$/, '');
  const a = esc.clave(archivo);
  if (!e || !a) return false;
  if (a === e || a.startsWith(e + '/')) return true;
  if (!e.includes('/')) return a.split('/').pop() === e;
  return false;
}

/** Estados con los que un escenario sigue siendo aplicable al changeset. */
const ESTADOS_APLICABLES = ['active', 'candidate', 'stale'];

/**
 * Behaviors afectados: los que protegen un archivo cambiado, o un archivo que
 * depende (transitivamente) de uno cambiado según el índice AST. Si el índice
 * no está o es parcial, la selección se marca `parcial` — no se deduce "nada
 * afectado" de un índice incompleto.
 */
function seleccionarBehaviors(db, filePaths, projectRoot) {
  const behaviors = safe(() => db.prepare(
    `SELECT * FROM protected_behaviors WHERE status IN (${ESTADOS_APLICABLES.map(() => '?').join(',')})`
  ).all(...ESTADOS_APLICABLES)) || [];

  const cambiados = (filePaths || []).map(esc.norm).filter(Boolean);
  let afectados = cambiados.map((f) => ({ file: f, depth: 0, via: null }));
  let parcial = null;
  const br = safe(() => require(path.join(__dirname, 'blast-radius.cjs')));
  const grafo = br ? safe(() => br.aristas(db)) : null;
  if (!grafo) parcial = 'SIN_INDICE_AST';
  else {
    const c = br.cierre(grafo, cambiados);
    afectados = c.nodos;
    if (c.truncado) parcial = c.truncado;
    else if (cambiados.some((f) => !grafo.indexados.has(esc.clave(f)))) parcial = 'ARCHIVO_SIN_INDICE';
  }

  const relacionados = behaviors.filter((b) => {
    const entradas = [...parseJ(b.related_files, []), ...parseJ(b.test_patterns, [])];
    const hit = afectados.find((n) => entradas.some((e) => cubre(e, n.file)));
    if (hit) b._via = hit.depth > 0 ? { archivo: hit.file, depende_de: hit.via } : null;
    return !!hit;
  });
  return { behaviors: relacionados, parcial, afectados: afectados.length };
}

function findRelatedBehaviors(db, filePaths, projectRoot) {
  return seleccionarBehaviors(db, filePaths, projectRoot).behaviors;
}

/** Transición de estado auditada en la libreta (gate_events). */
function transicion(db, behaviorId, de, a, motivo, extra = {}) {
  const telemetry = safe(() => require(path.join(__dirname, 'gate-telemetry.cjs')));
  if (!telemetry) return false;
  const marca = extra.execution_id || crypto.randomUUID();
  return !!safe(() => telemetry.recordGateEvent(db, {
    gate: 'preservation-transition', verdict: String(a).toUpperCase(), behavior_id: behaviorId,
    event_id: `tr:${behaviorId}:${a}:${marca}`, source: 'mechanical',
    detalle: Object.assign({ de, a, motivo }, extra),
  }));
}

/** Evidencia del escenario `patron` dentro de una corrida (ruta exacta, o nombre único). */
function evidenciaPara(evidencia, patron, sujetoVigente) {
  if (!evidencia || !evidencia.escenarios) return null;
  const n = esc.norm(patron);
  let e = evidencia.escenarios[n];
  if (!e) {
    const porClave = Object.keys(evidencia.escenarios).filter((k) => cubre(n, k));
    e = porClave.length === 1 ? evidencia.escenarios[porClave[0]] : null;
  }
  /* Evidencia de otra versión del código no prueba la actual. */
  if (e && e.status === 'PASS' && sujetoVigente && e.subject_hash !== sujetoVigente) {
    return Object.assign({}, e, { status: 'UNVERIFIED', reason_code: 'SUJETO_DISTINTO' });
  }
  return e;
}

/** Ejecuciones verificadas distintas de un escenario: { ejecuciones, sujetos }. */
function historialVerificado(db, behaviorId) {
  const filas = safe(() => db.prepare(
    "SELECT detalle FROM gate_events WHERE gate = 'preservation' AND verdict = 'VERIFIED' AND behavior_id = ?"
  ).all(behaviorId)) || [];
  const sujetos = new Set();
  filas.forEach((f) => { const d = parseJ(f.detalle, {}); if (d.subject_hash) sujetos.add(d.subject_hash); });
  return { ejecuciones: filas.length, sujetos: sujetos.size };
}

/* PROTECTED automático: ejecuciones verificadas distintas del MISMO escenario,
   sobre al menos dos versiones distintas del código. Repetir la corrida sobre
   el mismo código no suma. */
const CRITERIO_PROTEGIDO = { ejecuciones: 5, sujetos: 2 };

/**
 * Acredita un PASS del escenario. Solo cuenta una vez por execution_id: un
 * replay de la misma corrida no sube el contador.
 */
function acreditar(db, behavior, e) {
  const telemetry = safe(() => require(path.join(__dirname, 'gate-telemetry.cjs')));
  if (!telemetry || !e || e.status !== 'PASS' || !e.execution_id || !e.subject_hash) return { acreditado: false };
  const nuevo = !!safe(() => telemetry.recordGateEvent(db, {
    gate: 'preservation', verdict: 'VERIFIED', behavior_id: behavior.id,
    event_id: `pres:${behavior.id}:${e.execution_id}`, cycle_id: null, source: 'mechanical',
    detalle: { execution_id: e.execution_id, subject_hash: e.subject_hash, evidence_id: e.evidence_id,
      policy_id: e.policy_id, descubrimiento: e.descubrimiento },
  }));
  if (!nuevo) return { acreditado: false, replay: true };
  const h = historialVerificado(db, behavior.id);
  const estadoPrevio = behavior.status;
  let confianza = behavior.confidence === 'HIGH' ? 'HIGH' : 'MEDIA';
  if (confianza !== 'HIGH' && h.ejecuciones >= CRITERIO_PROTEGIDO.ejecuciones && h.sujetos >= CRITERIO_PROTEGIDO.sujetos) {
    confianza = 'HIGH';
    transicion(db, behavior.id, 'verified', 'protected', 'estabilidad', {
      execution_id: e.execution_id, criterio: CRITERIO_PROTEGIDO, observado: h,
    });
  }
  safe(() => db.prepare(
    "UPDATE protected_behaviors SET pass_count = ?, confidence = ?, status = 'active', last_verified_at = datetime('now') WHERE id = ?"
  ).run(h.ejecuciones, confianza, behavior.id));
  if (estadoPrevio !== 'active') {
    transicion(db, behavior.id, estadoPrevio, 'verified', 'PASS del escenario', { execution_id: e.execution_id });
  }
  return { acreditado: true, pass_count: h.ejecuciones, confidence: confianza };
}

// Bug real encontrado el 18/07/2026 probando el mecanismo de RECOVERY contra
// Lumo (proyecto real de validación): esta función estaba codificada SOLO
// para Jest (`--testPathPattern`) — en cualquier proyecto vitest (como Lumo
// mismo) el comando truena con "CACError: Unknown option" sin importar si el
// test pasa o falla. jest es el único runner común cuyo filtro de archivo es
// un FLAG con nombre; vitest/mocha/node --test aceptan el patrón como
// argumento POSICIONAL tal cual — de ahí la detección.
function detectTestRunner(projectRoot) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    const script = String((pkg.scripts && pkg.scripts.test) || '');
    const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
    if (/vitest/.test(script) || deps.vitest) return 'vitest';
    if (/\bjest\b/.test(script) || deps.jest) return 'jest';
    if (/mocha/.test(script) || deps.mocha) return 'mocha';
    if (/node\s+--test|node:test/.test(script)) return 'node';
  } catch {}
  return 'unknown';
}

/**
 * Descriptor del runner para correr UN archivo: comando base y directorio.
 * El archivo nunca se interpola a mano: lo agrega tdd-gate.runTests, que lo
 * valida y rechaza si trae caracteres de shell (no lo "limpia").
 */
function descriptorRunner(projectRoot) {
  const backend = path.join(projectRoot, 'backend');
  if (fs.existsSync(path.join(backend, 'requirements.txt'))) return { runner: 'pytest', comando: 'pytest -x -v', cwd: backend };
  if (fs.existsSync(path.join(projectRoot, 'requirements.txt')) || fs.existsSync(path.join(projectRoot, 'pyproject.toml'))) {
    return { runner: 'pytest', comando: 'pytest -x -v', cwd: projectRoot };
  }
  const runner = detectTestRunner(projectRoot);
  // jest toma el posicional como regex; --runTestsByPath lo toma como ruta exacta.
  if (runner === 'jest') return { runner, comando: 'npm test -- --runTestsByPath', cwd: projectRoot };
  return { runner, comando: null, cwd: projectRoot };
}

/** Ruta real del escenario: tal cual si existe; si es solo un nombre, debe ser único. */
function localizarEscenario(patron, projectRoot) {
  const n = esc.norm(patron);
  if (fs.existsSync(path.join(projectRoot, n))) return { ok: true, archivo: n };
  if (n.includes('/')) return { ok: false, reason_code: 'ESCENARIO_NO_EXISTE' };
  const tdd = safe(() => require(path.join(__dirname, 'tdd-gate.cjs')));
  const todos = tdd ? (safe(() => tdd.findTestFiles(projectRoot)) || []) : [];
  const iguales = todos.map(esc.norm).filter((f) => cubre(n, f));
  if (iguales.length === 1) return { ok: true, archivo: iguales[0] };
  return { ok: false, reason_code: iguales.length ? 'ESCENARIO_AMBIGUO' : 'ESCENARIO_NO_EXISTE', candidatos: iguales };
}

function runTestFile(testPattern, projectRoot) {
  const loc = localizarEscenario(testPattern, projectRoot);
  if (!loc.ok) {
    return { status: 'UNVERIFIED', reason_code: loc.reason_code, allPassed: false, passed: 0, failed: 0, evidencia: null };
  }
  const d = descriptorRunner(projectRoot);
  const ev = esc.ejecutarEscenario(projectRoot, loc.archivo, { comando: d.comando || undefined, cwd: d.cwd });
  const e = ev.escenarios[loc.archivo];
  return {
    status: e.status, reason_code: e.reason_code, allPassed: e.status === 'PASS',
    passed: e.status === 'PASS' ? 1 : 0, failed: e.status === 'FAIL' ? 1 : 0,
    archivo: loc.archivo, runner: d.runner, evidencia: ev,
  };
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

    const bFiles = parseJ(behavior.related_files, []);
    const changedRelated = (filesToChange || [])
      .map(norm)
      .filter(fp => bFiles.some(bf => cubre(bf, fp)));
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
    const dentroDelBehavior = (file) => bFiles.some(bf => cubre(bf, file));
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
  projectRoot = projectRoot || process.cwd();

  // Telemetría (Plan 5, T1): la libreta donde por fin quedan los veredictos.
  // Fail-soft total — si el módulo no está o falla, el gate sigue idéntico.
  const telemetry = safe(() => require(path.join(__dirname, 'gate-telemetry.cjs')));
  const record = (ev) => { if (telemetry) safe(() => telemetry.recordGateEvent(db, ev)); };

  // v3.15.2 (Grieta R8 del Coliseo): antes de mirar behaviors por línea,
  // ¿el changeset toca un test que verifica un patrón ALTA y le desapareció
  // el título/aserción? Esto es independiente de protected_behaviors (que
  // vienen de ciclos TDD) — se ancla a la memoria KDD (nodos.archivos_aplica).
  // Fail-soft: si el módulo no está o falla, el resto del gate sigue igual.
  const testIntegrity = safe(() => require(path.join(__dirname, 'test-integrity-gate.cjs')));
  if (testIntegrity) {
    const tiRes = safe(() => testIntegrity.scan(projectRoot, { staged: false, files: filesToChange }));
    const criticas = tiRes && tiRes.findings ? tiRes.findings.filter(f => f.nivel === 'CRITICAL') : [];
    if (criticas.length > 0) {
      return {
        passed: false,
        violations: criticas.map(c => ({
          behavior_id: null, behavior: `Test protegido modificado: "${c.tituloDesaparecido}" (protege "${c.patronOrigen}")`,
          module: c.area, test_pattern: c.file, failed: [c.tituloDesaparecido], confidence: 'ALTA',
        })),
        warnings: [], notices: [],
        message: `STOP: test protegido debilitado en el changeset:\n` +
          criticas.map(c => `  🔴 ${c.file}: desapareció "${c.tituloDesaparecido}" — protege el patrón ALTA "${c.patronOrigen}" (${c.area})`).join('\n'),
      };
    }
  }

  if (!tablasPresentes(db)) {
    return { passed: true, status: 'UNVERIFIED', reason_code: 'SIN_TABLAS',
      reason: 'Sin registro de comportamientos protegidos: preservación no verificada (no es lo mismo que sana).' };
  }

  const sel = seleccionarBehaviors(db, filesToChange, projectRoot);
  const related = sel.behaviors;
  if (related.length === 0) {
    return { passed: true, status: sel.parcial ? 'UNVERIFIED' : 'NO_APLICA', reason_code: sel.parcial || 'SIN_ESCENARIOS_RELACIONADOS',
      reason: 'No protected behaviors related to this changeset' + (sel.parcial ? ` (selección parcial: ${sel.parcial})` : '') };
  }

  const highConfidence = related.filter(b => b.status === 'active' && b.confidence === 'HIGH');
  const mediaConfidence = related.filter(b => !(b.status === 'active' && b.confidence === 'HIGH'));
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
    record({ gate: 'regression', verdict: verdict.mode, behavior_id: behavior.id,
      file: (filesToChange && filesToChange[0]) || null,
      detalle: verdict.mode === 'HIT' ? { hits: (verdict.hits || []).slice(0, 3) } : { why: verdict.why || null, confidence: 'HIGH' } });
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
    if (!patterns.length) {
      violations.push({ behavior_id: behavior.id, behavior: behavior.description, module: behavior.module,
        test_pattern: null, status: 'UNVERIFIED', reason_code: 'SIN_ESCENARIO_EJECUTABLE', confidence: 'HIGH', zona });
    }
    patterns.forEach(pattern => {
      const result = runTestFile(pattern, projectRoot);
      if (!result.allPassed) {
        violations.push({
          behavior_id:  behavior.id,
          behavior:     behavior.description,
          module:       behavior.module,
          test_pattern: pattern,
          failed:       result.failed,
          status:       result.status,
          reason_code:  result.reason_code,
          confidence:   'HIGH',
          zona,
        });
      }
    });
  });

  // RECOVERY mecánico (18/07/2026): un behavior HIGH que antes tenía un
  // STOP/FAIL registrado y ahora vuelve a pasar limpio se marca RECOVERED
  // solo — ya no depende de que el modelo corra el `node -e` a mano que
  // documentaba CLAUDE.md (eso quedaba honestamente marcado `source:'protocol'`,
  // y en la práctica se olvidaba seguido). Corre ANTES de decidir el
  // passed/failed final: un behavior puede recuperarse aunque OTRO siga roto.
  if (telemetry) {
    const violatingIds = new Set(violations.map(v => v.behavior_id));
    const resolvedIds = highConfidence.filter(b => !violatingIds.has(b.id)).map(b => b.id);
    safe(() => telemetry.detectAndRecordRecoveries(db, resolvedIds, { gateOrigen: 'regression' }));
  }

  // MEDIA confidence → warn but don't block (misma contención por líneas)
  mediaConfidence.forEach(behavior => {
    const verdict = lineContainmentVerdict(db, behavior, filesToChange, projectRoot);
    record({ gate: 'regression', verdict: verdict.mode, behavior_id: behavior.id,
      file: (filesToChange && filesToChange[0]) || null,
      detalle: verdict.mode === 'HIT' ? { hits: (verdict.hits || []).slice(0, 3) } : { why: verdict.why || null, confidence: 'MEDIA' } });
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
      confidence: behavior.status === 'candidate' ? 'CANDIDATE' : (behavior.confidence || 'MEDIA'),
      estado:     behavior.status,
      ...(verdict.mode === 'HIT'
        ? { zona: verdict.hits.map(h => `${h.etiqueta} (líneas ${h.start}-${h.end})`).join(', ') }
        : {}),
    });
  });

  if (violations.length > 0) {
    violations.forEach(v => record({ gate: 'regression', verdict: 'STOP', behavior_id: v.behavior_id,
      file: (filesToChange && filesToChange[0]) || null, detalle: { test: v.test_pattern, zona: v.zona || null } }));
    return {
      passed:     false,
      status:     violations.some(v => v.status === 'FAIL' || v.status === 'ERROR') ? 'FAIL' : 'UNVERIFIED',
      violations,
      warnings,
      notices,
      message:    [
        `🛑 REGRESSION GUARD STOP: ${violations.length} protected behavior(s) at risk:`,
        ...violations.map(v =>
          `  [HIGH] "${v.behavior}" (${v.module}) — test "${v.test_pattern}" ${v.status === 'FAIL' ? 'currently failing' : `sin verificar (${v.status}${v.reason_code ? ': ' + v.reason_code : ''})`}${v.zona ? ` — tocas ${v.zona}` : ''}`
        ),
        '',
        'Fix the failing tests before modifying these files.',
        'To override: add --override-regression to your aa: command.',
      ].join('\n'),
    };
  }

  /* Sin violaciones HIGH el build puede seguir, pero solo es PASS si no quedó
     nada aplicable sin verificar: MEDIA y candidatos no se corrieron aquí. */
  const result = { passed: true, status: warnings.length || sel.parcial ? 'UNVERIFIED' : 'PASS' };
  if (sel.parcial) result.parcial = sel.parcial;
  if (warnings.length > 0) {
    result.warnings = warnings;
    result.message = `⚠️  REGRESSION GUARD WARN: ${warnings.length} MEDIA/candidate behavior(s) in changeset path — proceed carefully.` +
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
/**
 * Deriva los archivos FUENTE que un test ejercita, leyendo sus imports/requires
 * relativos. Respaldo para cuando el behavior se registra con changeset vacío
 * (árbol limpio, o el scope filtró .agentic/) — sin esto related_files quedaba
 * [] y regression-guard `check <archivo>` nunca podía asociar fuente↔behavior
 * (hueco #2 del Coliseo, 2026-07-20). Un test casi siempre importa lo que prueba.
 */
function inferSourceFromTests(testFiles, root) {
  const fuentes = new Set();
  for (const t of testFiles || []) {
    const abs = path.isAbsolute(t) ? t : path.join(root, t);
    let c; try { c = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    const imports = c.match(/(?:from\s+|require\(\s*)['"](\.[^'"]+)['"]/g) || [];
    for (const imp of imports) {
      const m = imp.match(/['"](\.[^'"]+)['"]/);
      if (!m) continue;
      let rel = m[1].replace(/\.(js|ts|jsx|tsx|mjs|cjs)$/, '');
      const baseDir = path.dirname(abs);
      // Probar extensiones reales sobre el import resuelto.
      for (const ext of ['.ts', '.js', '.tsx', '.jsx', '.mjs', '.cjs']) {
        const cand = path.resolve(baseDir, rel + ext);
        if (fs.existsSync(cand)) { fuentes.add(path.relative(root, cand).replace(/\\/g, '/')); break; }
      }
    }
  }
  return [...fuentes];
}

/* Archivos que un escenario protege: fuente de UI, estilos, plantillas, SQL y
   configuración cuentan igual que el código. */
const ES_FUENTE = /\.(js|ts|jsx|tsx|mjs|cjs|py|css|scss|sass|less|html?|vue|svelte|astro|hbs|ejs|njk|sql|prisma|graphql|gql)$/i;
const ES_CONFIG = /(^|\/)(package\.json|tsconfig[^/]*\.json|[^/]*\.config\.(js|cjs|mjs|ts)|vite\.config\.[a-z]+|requirements\.txt|pyproject\.toml)$/i;
const esFuente = (f) => {
  const n = esc.norm(f);
  return (ES_FUENTE.test(n) || ES_CONFIG.test(n)) &&
    !/\.(test|spec)\./.test(n) &&
    !/^\.(claude|agentic|git)\//.test(n) && !/node_modules\//.test(n);
};

const unir = (a, b, k = esc.clave) => {
  const vistos = new Set();
  const out = [];
  [...(a || []), ...(b || [])].forEach((x) => {
    if (x == null || x === '') return;
    const c = k(x);
    if (!vistos.has(c)) { vistos.add(c); out.push(x); }
  });
  return out;
};
const claveAncla = (a) => `${esc.clave(a.file)}|${a.symbol_name}|${a.kind}`;

/** Escenario vigente que corre exactamente este test (no las filas viejas por módulo). */
function filaDeEscenario(db, test) {
  const filas = safe(() => db.prepare(
    "SELECT * FROM protected_behaviors WHERE status NOT IN ('retired', 'deprecated')"
  ).all()) || [];
  return filas.find((f) => {
    const tp = parseJ(f.test_patterns, []);
    return tp.length === 1 && esc.clave(tp[0]) === esc.clave(test);
  }) || null;
}

/**
 * Registra lo que quedó sano: UN escenario por archivo de test. Une lo nuevo
 * con lo que ya protegía (archivos, flujos, anclas) — nunca lo sustituye ni lo
 * recorta. Un escenario nuevo nace `candidate`; solo pasa a verificado con
 * evidencia PASS de ese escenario sobre el sujeto (params.evidencia).
 */
function registerBehavior(db, params) {
  ensureSchema(db);

  const {
    module:       moduleName,
    files:        changedFiles = [],
    testFiles:    testPassed   = [],
    evidencia     = null,
    subject_hash  = null,
    projectRoot,
  } = params;

  const root    = projectRoot || process.cwd();
  const module_ = moduleName || inferModule(changedFiles);
  // Plan 2: anchors PRIMERO — computeTouchedSymbols re-indexa los archivos
  // cambiados (hash-gated), y extractFlows lee los flujos UI de ese índice fresco.
  const anchors = computeTouchedSymbols(db, changedFiles, root); // v3.13 — nombres estables, nunca líneas
  const flows   = extractFlows(changedFiles, root, db);
  const tests   = (testPassed.length > 0 ? testPassed : inferTestPatterns(changedFiles)).map(esc.norm);

  if (changedFiles.length === 0 && tests.length === 0) return null;

  const cambiosFuente = changedFiles.map(esc.norm).filter(esFuente);
  const flowsUseful = flows.filter((f) => !/^(FORM form#|REQUIRED (input|select)|SELECT select\[)/i.test(f));

  const resultados = [];
  const objetivos = tests.length ? tests : [null];
  for (const test of objetivos) {
    const inferidos = test ? inferSourceFromTests([test], root) : [];
    const relacionados = unir(cambiosFuente, inferidos);
    const flowsEsc = flowsUseful.length ? flowsUseful : (test ? [`TEST ${path.posix.basename(test)}`] : flows);
    const previo = test ? filaDeEscenario(db, test) : safe(() => db.prepare(
      "SELECT * FROM protected_behaviors WHERE module = ? AND test_patterns = '[]' AND status NOT IN ('retired', 'deprecated') LIMIT 1"
    ).get(module_));

    let fila;
    if (previo) {
      const mergedFiles   = unir(parseJ(previo.related_files, []), relacionados);
      const mergedFlows   = unir(parseJ(previo.critical_flows, []), flowsEsc, (x) => String(x));
      const mergedAnchors = unir(parseJ(previo.protected_symbols, []), anchors.filter((a) => a && a.symbol_name), claveAncla);
      safe(() => db.prepare(
        'UPDATE protected_behaviors SET critical_flows = ?, related_files = ?, protected_symbols = ? WHERE id = ?'
      ).run(JSON.stringify(mergedFlows), JSON.stringify(mergedFiles), JSON.stringify(mergedAnchors), previo.id));
      fila = Object.assign({}, previo);
    } else {
      const id = test
        ? `pb_${module_}_${esc.idEscenario(test).slice(4)}`
        : `pb_${module_}_sin_test`;
      const description = `${module_} — ${test ? path.posix.basename(test) : 'sin escenario ejecutable'}` +
        (flowsEsc.length ? ` (${flowsEsc.slice(0, 3).join(', ')})` : '');
      safe(() => db.prepare(`
        INSERT OR IGNORE INTO protected_behaviors
          (id, module, description, critical_flows, test_patterns, related_files, protected_symbols, pass_count, confidence, status, last_verified_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'MEDIA', 'candidate', NULL)
      `).run(id, module_, description, JSON.stringify(flowsEsc), JSON.stringify(test ? [test] : []),
        JSON.stringify(relacionados), JSON.stringify(anchors.filter((a) => a && a.symbol_name))));
      transicion(db, id, null, 'candidate', 'registro', { test });
      fila = { id, module: module_, status: 'candidate', confidence: 'MEDIA', pass_count: 0 };
    }

    const e = test ? evidenciaPara(evidencia, test, subject_hash) : null;
    const cred = e ? acreditar(db, fila, e) : { acreditado: false };
    const actual = safe(() => db.prepare('SELECT status, confidence, pass_count FROM protected_behaviors WHERE id = ?').get(fila.id)) || fila;
    resultados.push({
      id: fila.id, test, status: actual.status, confidence: actual.confidence, pass_count: actual.pass_count,
      evidencia: e ? e.status : 'SIN_EVIDENCIA', acreditado: cred.acreditado, replay: !!cred.replay,
      created: !previo, updated: !!previo,
    });
  }

  const principal = resultados[0];
  return Object.assign({ module: module_, escenarios: resultados }, principal);
}

/**
 * Después de los tests: ¿siguen sanos los escenarios protegidos que este
 * cambio alcanza? Consume la evidencia estructurada de la corrida (no texto).
 * Solo un PASS del escenario sobre el sujeto actualiza last_verified_at.
 */
function verifyAfterTDD(db, evidencia, changedFiles, projectRoot, opts = {}) {
  projectRoot = projectRoot || process.cwd();
  const sujeto = opts.subject_hash || null;
  if (!tablasPresentes(db)) return { passed: false, status: 'UNVERIFIED', reason_code: 'SIN_TABLAS', verified: 0 };
  if (!evidencia || typeof evidencia !== 'object' || !evidencia.escenarios) {
    return { passed: false, status: 'UNVERIFIED', reason_code: 'SIN_EVIDENCIA_ESTRUCTURADA', verified: 0 };
  }

  const sel = seleccionarBehaviors(db, changedFiles, projectRoot);
  /* Con el índice incompleto no se puede saber a quién alcanza el cambio:
     se exige evidencia de TODOS los escenarios aplicables. */
  const alcance = sel.parcial ? 'todos' : 'afectados';
  if (sel.parcial) {
    sel.behaviors = safe(() => db.prepare(
      `SELECT * FROM protected_behaviors WHERE status IN (${ESTADOS_APLICABLES.map(() => '?').join(',')})`
    ).all(...ESTADOS_APLICABLES)) || [];
  }
  if (sel.behaviors.length === 0) {
    return { passed: true, status: 'NO_APLICA', reason_code: 'SIN_ESCENARIOS_RELACIONADOS', alcance, verified: 0 };
  }

  const violations = [];
  const sinVerificar = [];
  let verified = 0;
  const files = (changedFiles || []).map(esc.norm);

  for (const behavior of sel.behaviors) {
    const patterns = parseJ(behavior.test_patterns, []);
    if (!patterns.length) { sinVerificar.push({ behavior_id: behavior.id, reason_code: 'SIN_ESCENARIO_EJECUTABLE' }); continue; }
    for (const pattern of patterns) {
      const e = evidenciaPara(evidencia, pattern, sujeto);
      if (e && (e.status === 'FAIL' || e.status === 'ERROR')) {
        violations.push({ behavior_id: behavior.id, behavior: behavior.description, module: behavior.module,
          test_pattern: pattern, status: e.status, reason_code: e.reason_code, execution_id: e.execution_id });
        safe(() => require(path.join(__dirname, 'gate-telemetry.cjs')).recordGateEvent(db, {
          gate: 'preservation', verdict: 'FAIL', behavior_id: behavior.id,
          event_id: `pres-fail:${behavior.id}:${e.execution_id || crypto.randomUUID()}`,
          detalle: { test: pattern, execution_id: e.execution_id, subject_hash: e.subject_hash, reason_code: e.reason_code },
        }));
        const vid = `iv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        safe(() => db.prepare(`
          INSERT OR IGNORE INTO invariant_violations (id, behavior_id, changed_files, failed_tests, description)
          VALUES (?, ?, ?, ?, ?)
        `).run(vid, behavior.id, JSON.stringify(files), JSON.stringify([pattern]),
          `${pattern} ${e.status} (${e.reason_code || 'sin código'}) tras cambiar ${files.join(', ')}`));
        if (behavior.status !== 'violated') {
          safe(() => db.prepare("UPDATE protected_behaviors SET status = 'violated' WHERE id = ?").run(behavior.id));
          transicion(db, behavior.id, behavior.status, 'violated', 'escenario falló', { execution_id: e.execution_id });
          behavior.status = 'violated';
        }
      } else if (e && e.status === 'PASS') {
        acreditar(db, behavior, e);
        verified++;
      } else {
        sinVerificar.push({ behavior_id: behavior.id, test_pattern: pattern,
          status: e ? e.status : 'UNVERIFIED', reason_code: e ? e.reason_code : 'ESCENARIO_SIN_EVIDENCIA' });
      }
    }
  }

  if (violations.length > 0) {
    return {
      passed: false, status: 'FAIL', violations, sin_verificar: sinVerificar, verified,
      message: `⚠️  REGRESSION DETECTED: ${violations.length} previously-healthy behavior(s) broken:\n` +
        violations.map(v => `  [${v.module}] "${v.behavior}" — ${v.test_pattern} ${v.status}`).join('\n'),
    };
  }
  if (sinVerificar.length > 0) {
    return { passed: false, status: 'UNVERIFIED', reason_code: 'ESCENARIOS_SIN_EVIDENCIA',
      sin_verificar: sinVerificar, verified, alcance, parcial: sel.parcial };
  }
  return { passed: true, status: 'PASS', verified, alcance, parcial: sel.parcial };
}

/**
 * Status report — akdd regression status
 */
function regressionStatus(db) {
  if (!tablasPresentes(db)) {
    return '\n  Regression Guard — sin registro de comportamientos protegidos: estado NO VERIFICADO.\n';
  }

  const behaviors   = safe(() => db.prepare(`SELECT * FROM protected_behaviors ORDER BY confidence DESC, pass_count DESC`).all()) || [];
  const violations  = safe(() => db.prepare(`SELECT * FROM invariant_violations WHERE fixed_at IS NULL ORDER BY created_at DESC`).all()) || [];

  const high    = behaviors.filter(b => b.confidence === 'HIGH'   && b.status === 'active');
  const media   = behaviors.filter(b => b.confidence === 'MEDIA'  && b.status === 'active');
  const candidatos = behaviors.filter(b => b.status === 'candidate' || b.status === 'stale');
  const violated= behaviors.filter(b => b.status === 'violated');

  const lines = [
    '',
    '═══════════════════════════════════════════════════',
    '  Regression Guard — Protected Behaviors',
    '═══════════════════════════════════════════════════',
    `  HIGH (${high.length}):      fully protected behaviors`,
    `  MEDIA (${media.length}):    emerging behaviors (< 5 cycles)`,
    `  CANDIDATE (${candidatos.length}): registrados, sin ejecución verificada`,
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

  if (candidatos.length > 0) {
    lines.push('\n  ── CANDIDATE ───────────────────────────────────');
    candidatos.forEach(b => lines.push(`  ◻️  [${b.module}] ${b.description.substring(0, 60)} (${b.status})`));
  }

  lines.push('═══════════════════════════════════════════════════\n');
  return lines.join('\n');
}

/**
 * Retirar un escenario exige una decisión: motivo y quién la tomó.
 */
function deprecateBehavior(db, id, decision = {}) {
  const motivo = String(decision.motivo || '').trim();
  const aprobador = String(decision.aprobador || '').trim();
  if (!motivo || !aprobador) return { ok: false, reason_code: 'SIN_DECISION' };
  if (!tablasPresentes(db)) return { ok: false, reason_code: 'SIN_TABLAS' };
  const previo = safe(() => db.prepare('SELECT status FROM protected_behaviors WHERE id = ?').get(id));
  if (!previo) return { ok: false, reason_code: 'NO_EXISTE' };
  safe(() => db.prepare(`UPDATE protected_behaviors SET status = 'retired' WHERE id = ?`).run(id));
  transicion(db, id, previo.status, 'retired', motivo, { aprobador });
  return { ok: true, status: 'retired' };
}

/**
 * Cerrar una violación exige volver a correr el escenario sobre el código
 * recuperado. Sin PASS, la violación sigue abierta.
 */
function fixViolation(db, behaviorId, opts = {}) {
  if (!tablasPresentes(db)) return { ok: false, reason_code: 'SIN_TABLAS' };
  const b = safe(() => db.prepare('SELECT * FROM protected_behaviors WHERE id = ?').get(behaviorId));
  if (!b) return { ok: false, reason_code: 'NO_EXISTE' };
  const patterns = parseJ(b.test_patterns, []);
  if (!patterns.length) return { ok: false, reason_code: 'SIN_ESCENARIO_EJECUTABLE' };
  const ejecutar = opts.ejecutar || ((p) => runTestFile(p, opts.projectRoot || process.cwd()));
  const corridas = patterns.map((p) => ({ p, r: ejecutar(p) }));
  const fallida = corridas.find((c) => !c.r || c.r.status !== 'PASS');
  if (fallida) {
    return { ok: false, reason_code: 'ESCENARIO_NO_RECUPERADO', test: fallida.p,
      status: fallida.r ? fallida.r.status : 'UNVERIFIED' };
  }
  safe(() => db.prepare(`UPDATE invariant_violations SET fixed_at = datetime('now') WHERE behavior_id = ? AND fixed_at IS NULL`).run(behaviorId));
  safe(() => db.prepare(`UPDATE protected_behaviors SET status = 'active' WHERE id = ?`).run(behaviorId));
  const exec = corridas[0].r.evidencia && corridas[0].r.evidencia.execution_id;
  transicion(db, behaviorId, b.status, 'recovered', 'escenario re-ejecutado en PASS', { execution_id: exec });
  for (const c of corridas) {
    const e = c.r.evidencia ? evidenciaPara(c.r.evidencia, c.r.archivo || c.p) : null;
    if (e) acreditar(db, Object.assign({}, b, { status: 'active' }), e);
  }
  return { ok: true, status: 'active' };
}

/** PROTECTED por decisión explícita (criticidad), con motivo y aprobador trazables. */
function proteger(db, id, decision = {}) {
  const motivo = String(decision.motivo || '').trim();
  const aprobador = String(decision.aprobador || '').trim();
  if (!motivo || !aprobador) return { ok: false, reason_code: 'SIN_DECISION' };
  const b = safe(() => db.prepare('SELECT status, confidence FROM protected_behaviors WHERE id = ?').get(id));
  if (!b) return { ok: false, reason_code: 'NO_EXISTE' };
  if (b.status !== 'active') return { ok: false, reason_code: 'NO_VERIFICADO' };
  safe(() => db.prepare("UPDATE protected_behaviors SET confidence = 'HIGH' WHERE id = ?").run(id));
  transicion(db, id, 'verified', 'protected', motivo, { aprobador, criterio: 'decision' });
  return { ok: true, confidence: 'HIGH' };
}

/** Un archivo cambió de ruta: la protección lo sigue, no se pierde. */
function renombrar(db, desde, hacia, decision = {}) {
  if (!tablasPresentes(db)) return { ok: false, reason_code: 'SIN_TABLAS' };
  const de = esc.norm(desde);
  const a = esc.norm(hacia);
  if (!de || !a) return { ok: false, reason_code: 'RUTA_INVALIDA' };
  const mover = (lista) => lista.map((x) => {
    const k = esc.clave(x);
    if (k === esc.clave(de)) return a;
    if (k.startsWith(esc.clave(de) + '/')) return a + esc.norm(x).slice(de.length);
    return x;
  });
  const filas = safe(() => db.prepare("SELECT * FROM protected_behaviors WHERE status NOT IN ('retired', 'deprecated')").all()) || [];
  let movidos = 0;
  for (const f of filas) {
    const rf = parseJ(f.related_files, []); const tp = parseJ(f.test_patterns, []);
    const nrf = mover(rf); const ntp = mover(tp);
    if (JSON.stringify(nrf) === JSON.stringify(rf) && JSON.stringify(ntp) === JSON.stringify(tp)) continue;
    safe(() => db.prepare('UPDATE protected_behaviors SET related_files = ?, test_patterns = ? WHERE id = ?')
      .run(JSON.stringify(nrf), JSON.stringify(ntp), f.id));
    transicion(db, f.id, f.status, f.status, decision.motivo || 'renombre', { desde: de, hacia: a });
    movidos++;
  }
  return { ok: true, movidos };
}

/**
 * Cambio intencional sobre un escenario: delta esperado, alcance, aprobador y
 * qué pruebas se preservan. Deja el escenario `stale` hasta que vuelva a pasar:
 * no es una autorización abierta.
 */
function cambioIntencional(db, id, cambio = {}) {
  const faltan = ['delta', 'alcance', 'aprobador'].filter((k) => !String(cambio[k] || '').trim());
  if (!Array.isArray(cambio.preservadas)) faltan.push('preservadas');
  if (faltan.length) return { ok: false, reason_code: 'CAMBIO_INCOMPLETO', faltan };
  const b = safe(() => db.prepare('SELECT status FROM protected_behaviors WHERE id = ?').get(id));
  if (!b) return { ok: false, reason_code: 'NO_EXISTE' };
  safe(() => db.prepare("UPDATE protected_behaviors SET status = 'stale' WHERE id = ?").run(id));
  transicion(db, id, b.status, 'stale', 'cambio intencional', {
    delta: cambio.delta, alcance: cambio.alcance, aprobador: cambio.aprobador, preservadas: cambio.preservadas,
  });
  return { ok: true, status: 'stale' };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const cmd  = process.argv[2] || 'status';
  const args = process.argv.slice(3);
  const opcion = (n) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : ''; };
  const posicionales = args.filter((a) => !a.startsWith('--'));

  const dbPath = path.join(process.cwd(), '.agentic/memoria.db');
  if (!require('fs').existsSync(dbPath)) {
    console.log('No .agentic/memoria.db found. Run: akdd init');
    process.exit(0);
  }

  const adapter = require(path.join(__dirname, 'db-adapter.cjs'));
  const ESCRIBEN = ['check', 'register', 'deprecate', 'fix', 'protect', 'rename'];
  const escribe = ESCRIBEN.includes(cmd);
  const DB = escribe ? adapter.openWrite(dbPath) : adapter.openReadOnly(dbPath);
  let salida = 0;
  try {
    if (escribe && cmd !== 'check') ensureSchema(DB);
    switch (cmd) {
      case 'status':
        console.log(regressionStatus(DB));
        break;

      case 'check': {
        if (!posicionales.length) { console.log('Usage: regression-guard.cjs check <file1> <file2>...'); break; }
        const result = checkBeforeBuild(DB, posicionales, process.cwd());
        if (!result.passed) { console.log(result.message); salida = 1; break; }
        console.log(result.message || (result.status === 'PASS' ? '✅ REGRESSION GUARD PASS'
          : `ℹ️  REGRESSION GUARD ${result.status}${result.reason_code ? ' (' + result.reason_code + ')' : ''}`));
        break;
      }

      case 'register': {
        const module = posicionales[0] || 'global';
        const result = registerBehavior(DB, { module, files: posicionales.slice(1), projectRoot: process.cwd() });
        if (result) {
          console.log(`✅ Behavior ${result.created ? 'created' : 'updated'}: [${result.module}] ${result.status} ${result.confidence} (${result.pass_count} verificaciones)`);
        }
        break;
      }

      case 'deprecate': {
        const id = posicionales[0];
        if (!id) { console.log('Usage: regression-guard.cjs deprecate <behavior-id> --motivo="..." --aprobador="..."'); break; }
        const r = deprecateBehavior(DB, id, { motivo: opcion('motivo'), aprobador: opcion('aprobador') });
        console.log(r.ok ? `✅ Behavior ${id} retirado` : `🛑 No se retiró ${id}: ${r.reason_code}`);
        if (!r.ok) salida = 1;
        break;
      }

      case 'fix': {
        const id = posicionales[0];
        if (!id) { console.log('Usage: regression-guard.cjs fix <behavior-id>'); break; }
        const r = fixViolation(DB, id, { projectRoot: process.cwd() });
        console.log(r.ok ? '✅ Escenario re-ejecutado en PASS: violación cerrada'
          : `🛑 Violación sigue abierta: ${r.reason_code}${r.test ? ` (${r.test}: ${r.status})` : ''}`);
        if (!r.ok) salida = 1;
        break;
      }

      case 'protect': {
        const id = posicionales[0];
        const r = proteger(DB, id, { motivo: opcion('motivo'), aprobador: opcion('aprobador') });
        console.log(r.ok ? `✅ ${id} PROTECTED` : `🛑 No se protegió ${id}: ${r.reason_code}`);
        if (!r.ok) salida = 1;
        break;
      }

      case 'rename': {
        const r = renombrar(DB, posicionales[0], posicionales[1], { motivo: opcion('motivo') });
        console.log(r.ok ? `✅ ${r.movidos} escenario(s) siguen a ${posicionales[1]}` : `🛑 ${r.reason_code}`);
        if (!r.ok) salida = 1;
        break;
      }

      default:
        console.log('Commands: status | check <files> | register <module> <files> | deprecate <id> --motivo= --aprobador= | fix <id> | protect <id> --motivo= --aprobador= | rename <desde> <hacia>');
    }
  } finally {
    DB.close();
  }
  process.exitCode = salida;
}

module.exports = {
  ensureSchema,
  tablasPresentes,
  checkBeforeBuild,
  registerBehavior,
  verifyAfterTDD,
  regressionStatus,
  deprecateBehavior,
  fixViolation,
  proteger,
  renombrar,
  cambioIntencional,
  runTestFile,
  descriptorRunner,
  seleccionarBehaviors,
  cubre,
  lineContainmentVerdict,
  computeTouchedSymbols,
  CRITERIO_PROTEGIDO,
};
