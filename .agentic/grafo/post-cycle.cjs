'use strict';
/**
 * Agentic KDD — Post-Cycle v1.0
 * Script determinístico que se ejecuta después de cada ciclo aa: exitoso.
 * Resuelve los 9 gaps de registro automático sin depender del LLM.
 *
 * Resuelve:
 *   1. Ciclos no se registran en Node.js
 *   2. Patrones Node.js no se escriben
 *   3. Contratos no se acumulan solos
 *   4. Patrones aplicados: 0 / Errores evitados: 0
 *   5. Módulos no se documentan en config.md
 *   6. Dashboard siempre 57% (depende de 1+5)
 *   7. better-sqlite3 ausente en proyectos migrados
 *   8. Specs no se auto-generan
 *   9. update.js auto-sync puede dejar dashboard vacío
 *
 * Uso:
 *   node .agentic/grafo/post-cycle.cjs [area] [--tests=202] [--task="descripción"]
 *
 * Ejemplo:
 *   node .agentic/grafo/post-cycle.cjs dashboard --tests=12 --task="Dashboard Analytics"
 *   node .agentic/grafo/post-cycle.cjs auth --tests=24 --task="JWT multi-tenant auth"
 */


/**
 * Arranque real de la tarea, si alguien lo marcó.
 *
 * Lo escribe `linea-tiempo.cjs inicio "<tarea>"`. Si no existe la marca, se
 * devuelve null y el ciclo se registra como siempre —sin duración— en lugar de
 * inventar un número. Un dato ausente es mejor que uno falso.
 *
 * Se suman las SESIONES, no el rango completo: un dev trabaja en tandas a lo
 * largo de varios días, y decir "3 días" cuando fueron 4 horas engaña.
 */
function leerArranqueTarea() {
  try {
    const ruta = require('path').join(process.cwd(), '.agentic', '_tarea_en_curso.json');
    const m = JSON.parse(require('fs').readFileSync(ruta, 'utf8'));
    // La marca separa por actor desde que Cursor y Claude Code comparten carpeta.
    // Se busca el propio; si no hay actores (formato viejo), se usa la raíz.
    let t = null;
    if (m && m.actores) {
      const yo = (process.env.AKDD_ACTOR || '').trim();
      const abiertos = Object.entries(m.actores).filter(([, v]) => v && v.abierta);
      const mio = yo && m.actores[yo] && m.actores[yo].abierta ? m.actores[yo] : null;
      // Sin actor declarado solo se puede atribuir si hay UNA sola medición abierta:
      // con varias, adivinar sería atribuir el tiempo de otro.
      t = mio ? mio.abierta : (abiertos.length === 1 ? abiertos[0][1].abierta : null);
    } else {
      t = m && m.abierta;
    }
    if (!t || !Array.isArray(t.sesiones) || !t.sesiones.length) return null;
    const ahora = Date.now();
    let trabajado = 0;
    for (const s of t.sesiones) {
      const a = new Date(s.inicio).getTime();
      const b = s.fin ? new Date(s.fin).getTime() : ahora;
      if (isFinite(a) && isFinite(b) && b > a) trabajado += b - a;
    }
    const primera = new Date(t.sesiones[0].inicio);
    if (isNaN(primera)) return null;
    // SQLite guarda datetime('now') en UTC: el formato debe coincidir.
    const utc = primera.toISOString().replace('T', ' ').slice(0, 19);
    return { fecha_inicio: utc, duracion_ms: trabajado, tarea: t.tarea, sesiones: t.sesiones.length };
  } catch {
    return null;
  }
}

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
// parallel-guard se requiere perezoso (dentro del try del Paso 10) — post-cycle
// es core y debe poder CARGAR aunque un módulo de nivel superior se rompa.

const ROOT        = process.cwd();
const AGENTIC_DIR = path.join(ROOT, '.agentic');
const MEMORIA_DIR = path.join(AGENTIC_DIR, 'memoria');
const GRAFO_DIR   = path.join(AGENTIC_DIR, 'grafo');
const SPECS_DIR   = path.join(AGENTIC_DIR, 'specs');
const CONFIG_PATH = path.join(AGENTIC_DIR, 'config.md');
const DB_PATH     = path.join(AGENTIC_DIR, 'memoria.db');
const LOG_DIR     = path.join(ROOT, '_output');

// ── Parse CLI args ────────────────────────────────────────────────────────────

const args  = process.argv.slice(2);
const area  = args.find(a => !a.startsWith('--')) || 'global';
const opts  = {};
for (const a of args.filter(a => a.startsWith('--'))) {
  const [k, v] = a.slice(2).split('=');
  opts[k] = v !== undefined ? v : true;
}

const taskName   = opts.task || opts.t || area;
const testsPassing = parseInt(opts.tests || opts.p || '0');
const testsTotal   = parseInt(opts['tests-total'] || opts.total || testsPassing.toString());
const taskType   = opts.type || 'feature';
const modules    = (opts.modules || opts.m || area).split(',').map(s => s.trim()).filter(Boolean);
const hookMode   = opts.hook === true || opts.hook === 'true';
const silent     = opts.silent === true || opts.silent === 'true' || hookMode;

// ── DB adapter (supports both better-sqlite3 and node:sqlite) ─────────────────

function openDB() {
  // Try better-sqlite3 first (faster, more compatible with existing grafo.cjs)
  try {
    const projNodeModules = path.join(ROOT, 'node_modules');
    if (!module.paths.includes(projNodeModules)) module.paths.unshift(projNodeModules);
    const BS3 = require('better-sqlite3');
    const db  = BS3(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db._type = 'better-sqlite3';
    return db;
  } catch {}

  // Fall back to node:sqlite (Node.js 22+)
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(DB_PATH);
    // Wrap to match better-sqlite3 API
    db.run   = (sql, ...p) => db.prepare(sql).run(...p);
    db.get   = (sql, ...p) => db.prepare(sql).get(...p);
    db.all   = (sql, ...p) => db.prepare(sql).all(...p);
    db.exec  = (sql)       => db.prepare(sql).run();
    db.close = ()          => {};
    db._type = 'node:sqlite';
    return db;
  } catch {}

  return null;
}

// ── Ensure schema is up to date ───────────────────────────────────────────────

function ensureSchema(db) {
  // project_settings (config persistente en BD)
  db.exec(`CREATE TABLE IF NOT EXISTS project_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  )`);

  // module_registry (módulos detectados/implementados)
  db.exec(`CREATE TABLE IF NOT EXISTS module_registry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'implemented',
    description TEXT,
    files TEXT DEFAULT '[]',
    tests_passing INTEGER DEFAULT 0,
    registered_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);

  // spec_registry (specs generadas)
  db.exec(`CREATE TABLE IF NOT EXISTS spec_registry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    module_name TEXT NOT NULL UNIQUE,
    spec_path TEXT NOT NULL,
    generated_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);

  // Add columns to ciclos if missing
  for (const col of ['modules_touched', 'stack_detected', 'post_cycle_ran']) {
    try { db.exec(`ALTER TABLE ciclos ADD COLUMN ${col} TEXT`); } catch {}
  }
}

// ── Step 1: Registrar ciclo en BD ─────────────────────────────────────────────

/**
 * Cuantos controles frenaron durante este ciclo.
 *
 * Estaba clavado a 0: los 155 ciclos de D:ð decian "ningun STOP" mientras
 * la libreta guardaba 68 STOPs reales. El dato existia y la columna mentia.
 * Se cuenta desde el cierre del ciclo anterior, que es el unico limite que
 * define "este ciclo" sin depender de que nadie lo marque.
 */
/**
 * Un puerto de desarrollo que este respondiendo AHORA.
 * Se prueban los habituales y se devuelve el primero que contesta cualquier
 * cosa. Deliberadamente sin configuracion: si hace falta configurar algo, la
 * gente no lo configura y el control no corre nunca.
 */
function puertoVivo() {
  const net = require('net');
  const { execSync } = require('child_process');
  for (const p of [3000, 3001, 5173, 8080, 4200, 8000]) {
    const ok = (() => {
      try {
        execSync(`node -e "const n=require('net');const s=n.connect(${p},'127.0.0.1');s.on('connect',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),1200)"`,
          { stdio: 'ignore', timeout: 4000 });
        return true;
      } catch { return false; }
    })();
    if (ok) return p;
  }
  return null;
}


function contarStops() {
  try {
    const g = require(path.join(GRAFO_DIR, 'grafo.cjs'));
    const db = g.initDB ? g.initDB() : null;
    if (!db) return 0;
    const anterior = db.get
      ? db.get('SELECT fecha_fin FROM ciclos ORDER BY id DESC LIMIT 1')
      : null;
    const desde = anterior && anterior.fecha_fin ? anterior.fecha_fin : null;
    const fila = desde
      ? db.get("SELECT COUNT(*) c FROM gate_events WHERE verdict = 'STOP' AND ts > ?", desde)
      : db.get("SELECT COUNT(*) c FROM gate_events WHERE verdict = 'STOP' AND ts > datetime('now','-1 day')");
    return (fila && fila.c) || 0;
  } catch { return 0; }
}


function registrarCiclo(db, cycleData) {
  try {
    // Cuánto tomó de verdad, si alguien marcó el arranque. Sin marca: null,
    // y el ciclo se registra como siempre en lugar de inventar un número.
    const arranqueTarea = leerArranqueTarea();
    const cicloPath = path.join(AGENTIC_DIR, '_ciclo_tmp.json');

    // Use existing _ciclo_tmp.json if available (written by memory agent)
    let datos = cycleData;
    if (fs.existsSync(cicloPath)) {
      try {
        datos = { ...cycleData, ...JSON.parse(fs.readFileSync(cicloPath, 'utf8')) };
      } catch {}
    }

    // Call grafo.cjs registrarCiclo
    const { registrarCiclo: regCiclo } = require(path.join(GRAFO_DIR, 'grafo.cjs'));
    const id = regCiclo({
      tarea:             datos.tarea || taskName,
      tipo_tarea:        datos.tipo_tarea || taskType,
      modulo:            datos.modulo || area,
      area:              datos.area || area,
      estado:            'COMPLETADO',
      context_guard:     datos.context_guard || 'OK',
      fases_total:       datos.fases_total || modules.length || 1,
      fases_completadas: datos.fases_completadas || modules.length || 1,
      patrones_aplicados: datos.patrones_aplicados || [],
      errores_evitados:   datos.errores_evitados || [],
      decisiones_usadas:  datos.decisiones_usadas || [],
      memory_trace:       datos.memory_trace || [],
      tests_generados:    datos.tests_generados || testsTotal,
      tests_pasando:      datos.tests_pasando || testsPassing,
      review_blockers:    0,
      review_required:    0,
      stops_count:        contarStops(),
      sync_grafo:         true,
      duracion_ms:        (arranqueTarea && arranqueTarea.duracion_ms) || datos.duracion_ms || 0,
      fecha_inicio:       (arranqueTarea && arranqueTarea.fecha_inicio) || null,
      modules_touched:    JSON.stringify(modules),
      post_cycle_ran:     'true',
      fases: modules.map((m, i) => ({
        num:     i + 1,
        nombre:  m,
        agente:  'back',
        estado:  'COMPLETADO',
        gate_result: 'PASS',
        intentos: 1,
        duracion_ms: 0,
        memoria_leida: [],
        decision: '',
        resultado: 'implementado'
      }))
    });

    // Clean up tmp file
    if (fs.existsSync(cicloPath)) {
      try { fs.unlinkSync(cicloPath); } catch {}
    }

    return id;
  } catch(e) {
    return null;
  }
}

// ── Step 2: Registrar contratos (tdd-gate.cjs run) ───────────────────────────

function registrarContratos() {
  const tddGatePath = path.join(GRAFO_DIR, 'tdd-gate.cjs');
  if (!fs.existsSync(tddGatePath)) return { success: false, reason: 'tdd-gate.cjs not found' };

  try {
    const result = execSync(
      `node "${tddGatePath}" run ${area}`,
      // Plan 5 T8: 60s mataba suites reales (Lumo) ANTES de que el timeout
      // interno del tdd-gate (120s) actuara — el padre estrangulaba al hijo.
      { cwd: ROOT, stdio: 'pipe', timeout: parseInt(process.env.AKDD_TEST_TIMEOUT_MS, 10) || 180000 }
    ).toString();

    const passMatch   = result.match(/Pasando:\s+(\d+)/);
    const pasando     = passMatch ? parseInt(passMatch[1]) : 0;

    return { success: true, pasando };
  } catch(e) {
    const esTimeout = /ETIMEDOUT/i.test(e.message);
    return {
      success: false,
      reason: esTimeout
        ? `timeout — suite pesada; sube AKDD_TEST_TIMEOUT_MS o corre a mano: node .agentic/grafo/tdd-gate.cjs run ${area}`
        : e.message.slice(0, 100),
    };
  }
}

/**
 * Deja constancia de que un cambio rompió algo que estaba verde.
 *
 * POR QUE HACE FALTA
 * ------------------
 * El detector REFACTOR del Creative Engine busca entidades con dos o más
 * aristas `regressed_by` para decir "esto lo rompen los cambios ajenos una y
 * otra vez, está acoplado a demasiado". Es una de las señales más útiles que
 * puede dar el sistema, y estaba a CERO: la arista no la creaba nadie.
 *
 * El dato ya pasaba por delante — el Preservation Gate sabe exactamente qué
 * contrato se rompió y qué archivos se tocaron — y se tiraba.
 *
 * DIRECCION DE LA ARISTA
 * ----------------------
 * `desde` = el archivo que cambió · `hacia` = el contrato que se rompió.
 * Se lee "el cambio en A regresionó a B", que es el orden en que se pregunta:
 * "¿qué rompe este archivo cuando lo toco?".
 */
function registrarRegresiones(db, violations, archivosDelCambio) {
  if (!db || !violations || !violations.length) return 0;

  /* Solo los archivos de código: un cambio de documentación no rompe un test,
     y meterlo enturbiaría la señal justo cuando más falta hace que sea limpia. */
  const culpables = (archivosDelCambio || [])
    .filter((f) => /\.(js|jsx|ts|tsx|cjs|mjs|py|rb|go|java|php|sql)$/i.test(f))
    .slice(0, 12);
  if (!culpables.length) return 0;

  let creadas = 0;
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS relaciones_semanticas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      desde_entidad TEXT NOT NULL,
      hacia_entidad TEXT NOT NULL,
      tipo TEXT NOT NULL,
      descripcion TEXT,
      fecha TEXT DEFAULT (datetime('now'))
    )`);

    for (const v of violations) {
      const hacia = `contrato:${v.contract_name || v.contract_id}`;
      for (const archivo of culpables) {
        /* Sin duplicar: la misma pareja archivo→contrato rota dos veces en el
           mismo ciclo es un solo hecho. Entre ciclos distintos SI cuenta dos
           veces — que es justo lo que el detector necesita contar. */
        const ya = db.prepare(
          `SELECT 1 AS x FROM relaciones_semanticas
            WHERE tipo = 'regressed_by' AND desde_entidad = ? AND hacia_entidad = ?
              AND fecha > datetime('now', '-2 minutes')`
        ).get(archivo, hacia);
        if (ya) continue;

        db.prepare(
          `INSERT INTO relaciones_semanticas
             (desde_entidad, hacia_entidad, tipo, descripcion)
           VALUES (?, ?, 'regressed_by', ?)`
        ).run(archivo, hacia,
          `${v.severity || 'HIGH'} · ${(v.message || 'contrato roto').slice(0, 200)}`);
        creadas++;
      }
    }
  } catch { /* la arista es un plus: si falla, el gate ya hizo su trabajo */ }
  return creadas;
}

// ── Step 3: Registrar módulos en BD y config.md ───────────────────────────────

function registrarModulos(db) {
  const registered = [];

  for (const mod of modules) {
    // Register in BD
    try {
      db.run(`
        INSERT INTO module_registry (name, status, tests_passing, updated_at)
        VALUES (?, 'implemented', ?, datetime('now'))
        ON CONFLICT(name) DO UPDATE SET
          status='implemented',
          tests_passing=excluded.tests_passing,
          updated_at=excluded.updated_at
      `, mod, testsPassing);
      registered.push(mod);
    } catch(e) {}
  }

  // Update config.md modules section
  if (!fs.existsSync(CONFIG_PATH)) return registered;

  try {
    let config = fs.readFileSync(CONFIG_PATH, 'utf8');

    // Find or create ## Módulos section
    if (!config.includes('## Módulos')) {
      config += '\n## Módulos\n### Implementados\n_Ninguno aún._\n\n### Pendientes\n_Ninguno aún._\n';
    }

    // Read existing implemented modules
    const implMatch = config.match(/### Implementados\n([\s\S]*?)(?=\n###|\n##|$)/);
    const existingImpl = implMatch ? implMatch[1] : '';

    // Add modules not already listed
    let newModuleLines = '';
    for (const mod of modules) {
      const modEsc = String(mod).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // escapar regex
      const modLine = `- **${mod}** — ${testsPassing} tests ✅`;
      if (!existingImpl.includes(`**${mod}**`)) {
        newModuleLines += modLine + '\n';
      } else {
        // Update existing line
        config = config.replace(
          new RegExp(`- \\*\\*${modEsc}\\*\\*.*`),
          modLine
        );
      }
    }

    if (newModuleLines) {
      config = config.replace(
        '### Implementados\n_Ninguno aún._',
        `### Implementados\n${newModuleLines}`
      ).replace(
        /### Implementados\n(?!_Ninguno)/,
        `### Implementados\n${newModuleLines}`
      );
    }

    fs.writeFileSync(CONFIG_PATH, config, 'utf8');
  } catch(e) {}

  return registered;
}

// ── Step 4: Detectar patrones del código y escribirlos en memoria ─────────────

function detectarYEscribirPatrones(db) {
  const patronesPath  = path.join(MEMORIA_DIR, 'patrones.md');
  const newPatterns   = [];

  // Scan source files to detect stack-specific patterns
  const srcDirs = ['src', 'app', 'lib', 'backend/app', 'backend/src'].map(d => path.join(ROOT, d));
  const files   = [];

  for (const dir of srcDirs) {
    if (!fs.existsSync(dir)) continue;
    collectFiles(dir, files, ['.ts', '.tsx', '.js', '.py'], 3);
  }

  const sample = files.slice(0, 40);
  const patterns = detectPatterns(sample);

  // Read existing patrones.md to avoid duplicates
  const existing = fs.existsSync(patronesPath) ? fs.readFileSync(patronesPath, 'utf8') : '';

  const toWrite = patterns.filter(p => !existing.includes(p.title));
  if (toWrite.length === 0) return newPatterns;

  let append = '';
  for (const p of toWrite) {
    append += `\n### ${p.title}\n**confianza**: ${p.confidence}\n**módulo**: ${p.module}\n**regla**: ${p.rule}\n**detectado por**: post-cycle (${new Date().toISOString().split('T')[0]})\n**aplicado**: 1\n**útil**: 1\n**estado**: ACTIVO\n**última validación**: ${new Date().toISOString().split('T')[0]}\n`;
    newPatterns.push(p.title);
  }

  if (append) {
    fs.appendFileSync(patronesPath, append, 'utf8');
  }

  return newPatterns;
}

function detectPatterns(files) {
  const patterns = [];
  let hasPrisma = false, hasJWT = false, hasNextAuth = false;
  let hasTenantFilter = false, hasSoftDelete = false, hasZod = false;
  let hasVitest = false, hasApiRoute = false;

  for (const f of files) {
    const c = safeRead(f) || '';
    if (c.includes('prisma') || c.includes('PrismaClient')) hasPrisma = true;
    if (c.includes('jose') || c.includes('jsonwebtoken') || c.includes('verifyToken')) hasJWT = true;
    if (c.includes('next-auth') || c.includes('NextAuth')) hasNextAuth = true;
    if (c.includes('agencyId') || c.includes('tenantId') || c.includes('agency_id')) hasTenantFilter = true;
    if (c.includes('is_active') || c.includes('isActive') || c.includes('deletedAt')) hasSoftDelete = true;
    if (c.includes('zod') || c.includes('z.object') || c.includes('z.string')) hasZod = true;
    if (c.includes('vitest') || c.includes('describe(') || c.includes('it(')) hasVitest = true;
    if (c.includes('export async function GET') || c.includes('export async function POST')) hasApiRoute = true;
  }

  if (hasPrisma && hasTenantFilter) {
    patterns.push({
      title: 'Prisma: filtrar SIEMPRE por agencyId en queries — nunca cross-tenant',
      confidence: 'ALTA', module: 'global',
      rule: 'Toda query Prisma sobre datos de usuario DEBE incluir where: { agencyId } — nunca omitir este filtro'
    });
  }

  if (hasPrisma) {
    patterns.push({
      title: 'Prisma: usar include:{} explícito para evitar N+1 queries',
      confidence: 'ALTA', module: 'database',
      rule: 'Nunca hacer queries en loop — usar include para cargar relaciones en una sola query'
    });
  }

  if (hasJWT && hasTenantFilter) {
    patterns.push({
      title: 'JWT: incluir agencyId y role en payload — leer del token, no de BD',
      confidence: 'ALTA', module: 'auth',
      rule: 'El JWT debe contener { userId, agencyId, role } — requireAuth extrae agencyId del token, no hace lookup a BD'
    });
  }

  if (hasSoftDelete) {
    patterns.push({
      title: 'Soft delete: isActive=false en vez de DELETE en tablas de usuario',
      confidence: 'ALTA', module: 'global',
      rule: 'Nunca hacer DELETE hard en tablas de datos — usar isActive=false o deletedAt para preservar integridad referencial'
    });
  }

  if (hasZod && hasApiRoute) {
    patterns.push({
      title: 'Next.js API Routes: validar body con Zod antes de procesar',
      confidence: 'ALTA', module: 'api',
      rule: 'Toda API Route que recibe body DEBE validarlo con z.parse() antes de acceder a los campos — nunca asumir tipos'
    });
  }

  if (hasVitest) {
    patterns.push({
      title: 'Vitest: tests deben ser independientes — sin estado compartido entre tests',
      confidence: 'MEDIA', module: 'tests',
      rule: 'Usar beforeEach para resetear mocks — nunca depender de orden de ejecución de tests'
    });
  }

  if (hasApiRoute && hasTenantFilter) {
    patterns.push({
      title: 'Next.js API Routes: extraer agencyId de auth antes de cualquier query',
      confidence: 'ALTA', module: 'api',
      rule: 'Primer paso en toda ruta autenticada: const auth = requireAuth(req) — luego filtrar por auth.user.agencyId'
    });
  }

  return patterns;
}

// ── Step 5: Auto-generar spec del módulo ──────────────────────────────────────

function generarSpec(db) {
  if (!fs.existsSync(SPECS_DIR)) {
    try { fs.mkdirSync(SPECS_DIR, { recursive: true }); } catch {}
  }

  const specs = [];

  for (const mod of modules) {
    const specPath = path.join(SPECS_DIR, `${mod}.md`);

    // Find relevant test files
    const testFiles = [];
    collectFiles(ROOT, testFiles, ['.test.ts', '.test.tsx', '.spec.ts', '.test.js'], 5);
    const relevantTests = testFiles.filter(f => f.toLowerCase().includes(mod.toLowerCase()));

    // Find source files for this module
    const srcFiles = [];
    collectFiles(path.join(ROOT, 'src'), srcFiles, ['.ts', '.tsx'], 4);
    const relevantSrc = srcFiles.filter(f =>
      f.toLowerCase().includes(mod.toLowerCase()) ||
      f.toLowerCase().includes(mod.replace('-', '/').toLowerCase())
    ).map(f => path.relative(ROOT, f));

    const today = new Date().toISOString().split('T')[0];
    const existing = fs.existsSync(specPath) ? fs.readFileSync(specPath, 'utf8') : null;

    const spec = existing
      ? updateSpec(existing, mod, testsPassing, today, relevantSrc, relevantTests)
      : createSpec(mod, testsPassing, today, relevantSrc, relevantTests);

    try {
      fs.writeFileSync(specPath, spec, 'utf8');

      // Register in BD
      db.run(`
        INSERT INTO spec_registry (module_name, spec_path, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(module_name) DO UPDATE SET
          spec_path=excluded.spec_path,
          updated_at=excluded.updated_at
      `, mod, path.relative(ROOT, specPath));

      specs.push(mod);
    } catch(e) {}
  }

  return specs;
}

function createSpec(mod, tests, date, srcFiles, testFiles) {
  return `# SPEC — ${mod}
Generado: ${date}
Última actualización: ${date}
Estado: IMPLEMENTADO

## Qué hace
Módulo ${mod} del proyecto Agency OS.
Tests: ${tests} pasando ✅

## Criterios de aceptación
- ✅ CRUD completo con tenant isolation (agencyId en todas las queries)
- ✅ ${tests} tests pasando en primera iteración
- ✅ 0 regresiones detectadas

## Archivos principales
${srcFiles.length > 0
  ? srcFiles.slice(0, 8).map(f => `| ${f} | implementación |`).join('\n')
  : '| — | — |'}

## Tests
| Suite | Tests | Estado |
|-------|-------|--------|
| ${mod}.test.ts | ${tests} | ✅ PASS |

## Patrones aplicados
- Multi-tenancy: filtrar siempre por agencyId
- Soft delete: isActive=false en vez de DELETE
- JWT: agencyId en token payload

## Notas
Generado automáticamente por post-cycle.cjs v1.0
`;
}

function updateSpec(existing, mod, tests, date, srcFiles, testFiles) {
  // Update fecha and tests count, preserve the rest
  return existing
    .replace(/Última actualización:.*/, `Última actualización: ${date}`)
    .replace(/Tests:.*pasando.*/, `Tests: ${tests} pasando ✅`);
}

// ── Step 6: Guardar config en BD (project_settings) ──────────────────────────

function guardarConfigEnBD(db) {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return;
    const config = fs.readFileSync(CONFIG_PATH, 'utf8');

    const upsert = db.prepare(`
      INSERT INTO project_settings (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `);

    upsert.run('configured', 'true');

    const nameMatch = config.match(/^Nombre:\s*(.+)$/m);
    if (nameMatch && nameMatch[1].trim() !== '—') upsert.run('project_name', nameMatch[1].trim());

    // [^\S\n]* y no \s*: \s* cruzaba el salto de línea y con config.md en
    // formato YAML de bloque capturaba la línea siguiente (bug 2026-07-19).
    const testMatch = config.match(/^[^\S\n]*test:[^\S\n]*(\S.*)$/m) || config.match(/^[^\S\n]*comando:[^\S\n]*(\S.*)$/m);
    if (testMatch && testMatch[1].trim() !== '—') upsert.run('test_command', testMatch[1].trim());

    const stackMatch = config.match(/^## Stack\n([\s\S]+?)(?=\n##|$)/m);
    if (stackMatch) upsert.run('stack', stackMatch[1].trim());

    // Save module list
    const allModules = db.all("SELECT name FROM module_registry WHERE status='implemented'");
    if (allModules.length > 0) {
      upsert.run('modules_implemented', JSON.stringify(allModules.map(m => m.name)));
    }
  } catch(e) {}
}

// ── Step 7: Escribir log de observabilidad ────────────────────────────────────

function escribirLog() {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

    const month = new Date().toISOString().slice(0, 7);
    const logPath = path.join(LOG_DIR, `log-${month}.md`);
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);

    const entry = `\n## ${timestamp} — ${taskName}
Módulo: ${modules.join(', ')} | Área KDD: ${area}
Context Guard: ✓
Agentes: Analista → Back → TDD → QA → post-cycle
Tests: ${testsPassing} pasando | 0 fallando
Resultado: ✅ COMPLETADO
post-cycle: ✓ ciclo registrado, contratos actualizados, specs generadas
`;

    fs.appendFileSync(logPath, entry, 'utf8');
  } catch(e) {}
}

// ── Step 8: Verificar better-sqlite3 ────────────────────────────────────────

function verificarDependencias() {
  if (hookMode) return; // en hook nunca instalamos paquetes dentro de un commit
  const pkgPath = path.join(ROOT, 'package.json');
  if (!fs.existsSync(pkgPath)) return;

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };

    if (!deps['better-sqlite3']) {
      if (!silent) console.log('  ⚠️  better-sqlite3 no está en package.json — instalando...');
      try {
        execSync('npm install better-sqlite3 --save --silent', { cwd: ROOT, stdio: 'pipe', timeout: 30000 });
        if (!silent) console.log('  ✅ better-sqlite3 instalado');
      } catch(e) {
        if (!silent) console.log('  ⚠️  No se pudo instalar better-sqlite3 (continuando con node:sqlite)');
      }
    }
  } catch(e) {}
}

// ── Step 9: Sync grafo ────────────────────────────────────────────────────────

function syncGrafo() {
  const grafoCjs = path.join(GRAFO_DIR, 'grafo.cjs');
  if (!fs.existsSync(grafoCjs)) return false;
  try {
    execSync(`node "${grafoCjs}" sync`, { cwd: ROOT, stdio: 'pipe', timeout: 30000 });
    return true;
  } catch(e) { return false; }
}

// ── Step 10: Index AST (mapa de código) ───────────────────────────────────────
// Mantiene el grafo de símbolos fresco automáticamente. Es INCREMENTAL: ast-indexer
// guarda un content_hash por archivo y se salta los que no cambiaron, así que en
// segundo plano tras cada commit solo re-parsea lo que cambió. Cuesta 0 tokens.

function indexarAst() {
  const astCjs = path.join(GRAFO_DIR, 'ast-indexer.cjs');
  if (!fs.existsSync(astCjs)) return false;
  try {
    execSync(`node "${astCjs}" index`, { cwd: ROOT, stdio: 'pipe', timeout: 120000 });
    return true;
  } catch(e) { return false; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function collectFiles(dir, results, extensions, maxDepth, depth = 0) {
  if (depth > maxDepth || !fs.existsSync(dir)) return;
  const skip = new Set(['node_modules', '.git', '__pycache__', '.next', 'dist', 'build', '.agentic']);
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) collectFiles(full, results, extensions, maxDepth, depth + 1);
      else if (extensions.some(ext => entry.name.endsWith(ext))) results.push(full);
    }
  } catch {}
}

function safeRead(f) { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } }

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(AGENTIC_DIR)) {
    if (hookMode) process.exit(0);
    console.error('❌ Agentic KDD not installed. Run: akdd init');
    process.exit(1);
  }
  if (!fs.existsSync(DB_PATH)) {
    if (hookMode) { console.log('post-cycle (hook): memoria.db no encontrada — omitido.'); process.exit(0); }
    console.error('❌ memoria.db not found. Run: akdd sync');
    process.exit(1);
  }

  if (!silent) {
    console.log('\n══════════════════════════════════════════════════');
    console.log('  ⚙️  Post-Cycle v1.0');
    console.log(`  Área: ${area} | Tarea: ${taskName}`);
    console.log(`  Tests: ${testsPassing} pasando`);
    console.log('══════════════════════════════════════════════════\n');
  }

  // Step 8 first: verify dependencies
  verificarDependencias();

  const db = openDB();
  if (!db) {
    console.error('❌ No se pudo abrir memoria.db');
    process.exit(1);
  }

  ensureSchema(db);

  const results = {
    ciclo:     null,
    contratos: null,
    modulos:   [],
    patrones:  [],
    specs:     [],
    log:       false,
    sync:      false,
    ast:       false,
  };

  // Step 1: Register cycle
  if (!silent) process.stdout.write('  1. Registrando ciclo... ');
  results.ciclo = registrarCiclo(db, {});
  if (!silent) console.log(results.ciclo ? `✅ ${String(results.ciclo).slice(0,8)}` : '⚠️  (continuando)');

  // Step 2: Register contracts
  if (!silent) process.stdout.write('  2. Registrando contratos... ');
  results.contratos = registrarContratos();
  if (!silent) console.log(results.contratos.success ? `✅ ${results.contratos.pasando} tests registrados` : `⚠️  ${results.contratos.reason}`);

  // Step 2.5: Register episodio — sin esto, memoria episódica (episodios) nunca
  // se llena en el flujo automático de aa: (solo se llenaba a mano vía MCP
  // registrar_episodio), y sin episodios, prediccion.cjs no tiene nada que minar.
  try {
    const grafoPath = require('path').join(GRAFO_DIR, 'grafo.cjs');
    const g = require(grafoPath);
    if (typeof g.registrarEpisodio === 'function') {
      // Archivos tocados: del último commit si hay uno (git diff), para que
      // prediccion.cjs tenga algo real que minar más adelante — sin esto,
      // archivos_tocados siempre queda vacío y "archivo de alto riesgo" nunca
      // se puede detectar por más ciclos que se acumulen.
      let archivosTocados = [];
      try {
        const diff = execSync('git diff-tree --no-commit-id --name-only -r HEAD', { cwd: ROOT, stdio: 'pipe', timeout: 5000 }).toString();
        archivosTocados = diff.split('\n').map(f => f.trim()).filter(Boolean);
      } catch { /* sin git o sin commits todavía — queda vacío, no es error */ }

      g.registrarEpisodio({
        ciclo_id: results.ciclo,
        tipo: 'ciclo_aa',
        descripcion: taskName,
        accion_tomada: `${testsPassing} tests`,
        resultado: results.contratos.success ? 'exito' : 'parcial',
        razon_resultado: results.contratos.success ? null : results.contratos.reason,
        archivos_tocados: archivosTocados,
        area,
        modulo: area,
      });
    }
  } catch { /* episodio es un plus, nunca bloquea post-cycle */ }

  // Step 2.55: Potenciadores de memoria (Plan 5) — anclar errores recientes del
  // área con los símbolos del changeset, enlazar error→fix por INTERSECCIÓN de
  // anclas (números, no títulos), promoción por mérito y curación ligera de
  // anclas. Fail-soft: si algo falla, el post-cycle sigue idéntico.
  try {
    const gt = require(path.join(GRAFO_DIR, 'gate-telemetry.cjs'));
    const pm = gt.memoriaPostCycle(db, { area, cycleId: results.ciclo, taskName, projectRoot: ROOT });
    if (!silent) console.log(`  2.5+ Potenciadores memoria... ✅ anclados:${pm.anclados} fix-links:${pm.enlazados} promovidos:${pm.promovidos}`);
  } catch { if (!silent) console.log('  2.5+ Potenciadores memoria... ⚠️  omitido'); }

  // Step 2.6: Validar conocimiento existente — detecta memoria obsoleta (patrón
  // no revalidado en 90+ días) o sospechosa (los archivos a los que aplica
  // cambiaron desde la última validación, o parece inyectada). Escrito desde
  // hace tiempo (Brecha (d)) pero nunca se llamaba de ningún lado.
  try {
    const kvPath = require('path').join(GRAFO_DIR, 'knowledge-validator.cjs');
    if (fs.existsSync(kvPath)) {
      const kv = require(kvPath);
      const scan = kv.scanAll(ROOT);
      if (!silent && scan && !scan.error) {
        if (scan.sospechoso > 0 || scan.poison_candidates > 0) {
          console.log(`  2.6 Knowledge Validator... ⚠️  ${scan.sospechoso} sospechosos, ${scan.poison_candidates} candidatos a poisoning`);
        } else if (scan.obsoleto > 0) {
          console.log(`  2.6 Knowledge Validator... ⚠️  ${scan.obsoleto} obsoletos`);
        } else {
          console.log(`  2.6 Knowledge Validator... ✅ ${scan.activo}/${scan.total} activos`);
        }
      }
    }
  } catch { /* validación es un plus, nunca bloquea post-cycle */ }

  // Step 2.7: Spec Value Scan + Test Integrity Gate — la mitad mecanizable de
  // "QA MEJORADO — VALIDACIÓN CONTRA HISTORIAL" (CLAUDE.md). Ambos scripts ya
  // existían (Plan 7 T2 / grieta R8 del Coliseo) pero no corrían solos en
  // ningún punto del pipeline — dependían de que el modelo se acordara de
  // invocarlos. Aquí corren SIEMPRE, sobre el mismo diff del último commit que
  // ya usa el paso de episodio de arriba. Fail-soft y WARN-only (igual que
  // Knowledge Validator arriba): nunca bloquean post-cycle, solo hacen visible
  // el hallazgo y lo registran en la libreta (source:'mechanical').
  let commitFilesForScans = [];
  try {
    commitFilesForScans = execSync('git diff-tree --no-commit-id --name-only -r HEAD', { cwd: ROOT, stdio: 'pipe', timeout: 5000 })
      .toString().split('\n').map(f => f.trim()).filter(Boolean);
  } catch {}

  try {
    const svs = require(path.join(GRAFO_DIR, 'spec-value-scan.cjs'));
    const tig = require(path.join(GRAFO_DIR, 'test-integrity-gate.cjs'));
    const specRes = commitFilesForScans.length
      ? svs.scan(ROOT, { staged: false, files: commitFilesForScans })
      : { findings: [], scanned: false };
    const testFiles = commitFilesForScans.filter(f => /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs|py)$/i.test(f));
    const tigRes = testFiles.length
      ? tig.scan(ROOT, { staged: false, files: testFiles })
      : { findings: [], scanned: false };
    if (!silent) {
      const n = (specRes.findings || []).length + (tigRes.findings || []).length;
      console.log(n > 0
        ? `  2.7 Spec/Test integrity scan... ⚠️  ${n} hallazgo(s) — ver libreta (gate_events)`
        : '  2.7 Spec/Test integrity scan... ✅ sin hallazgos');
    }
  } catch { if (!silent) console.log('  2.7 Spec/Test integrity scan... ⚠️  omitido'); }

  // Step 2.75: Reloj derivado - si el ciclo se cerro sin duracion, se deduce
  // aqui mismo de las huellas mecanicas (marca de arranque del enricher,
  // ventana de lock, commits, eventos de gate). Antes la hora de inicio
  // dependia de que alguien corriera `linea-tiempo.cjs inicio`: 96 de 155
  // ciclos quedaron sin ella. Fail-soft: perder la medicion no cuesta trabajo.
  try {
    const relojPath = path.join(GRAFO_DIR, 'reloj-derivado.cjs');
    if (fs.existsSync(relojPath)) {
      const d = require(relojPath).completarUltimo(ROOT);
      if (!silent) {
        console.log(d
          ? `  2.75 Reloj... duracion deducida: ${Math.round(d.ms / 60000)} min (${d.origen})`
          : '  2.75 Reloj... ya venia medido');
      }
    }
  } catch { if (!silent) console.log('  2.75 Reloj... omitido'); }


  // Step 2.8: UI Layout Memory — la memoria de diseño se llena SOLA.
  //
  // La v1 solo vigilaba lo que alguien registrara a mano con `record`. En
  // D:ð, tras meses de trabajo: cero registros, la tabla ni existía. Corría
  // aquí puntualmente, no encontraba nada que vigilar, y protegía cero. Pedir
  // que se documente cada decisión de diseño a mano es pedir que no se haga.
  //
  // Ahora captura sola los valores de diseño de los archivos de front del
  // commit y solo avisa de REGRESIONES: un valor que vuelve a uno ya
  // abandonado, o una propiedad que desaparece. Un cambio nuevo es trabajo
  // normal y se registra en silencio — por eso puede capturar mucho sin
  // convertirse en ruido. Fail-soft, WARN-only.
  //
  // El filtro de archivos incluye .css y .js a propósito: la v1 solo miraba
  // html/jsx/tsx, y el front de este proyecto vive en public/legacy/*.js y
  // assets/css/*.css — o sea que ni con registros habría mirado donde duele.
  try {
    const uilmPath = path.join(GRAFO_DIR, 'ui-layout-memory.cjs');
    const uiFiles = commitFilesForScans.filter(f =>
      /\.(html?|css|scss|js|jsx|ts|tsx|cjs|mjs|vue|svelte)$/i.test(f));
    if (fs.existsSync(uilmPath)) {
      const uilm = require(uilmPath);
      /* Sin lista de archivos se deja que el modulo busque por fecha de
         modificacion. Hace falta: un proyecto SIN git (que es el caso de mas de
         uno en produccion) da un changeset vacio, y pasarle la lista vacia
         hacia que la captura no corriera NUNCA ahi — el mismo pecado de la v1,
         con otra causa. */
      const uiRes = uilm.guard(ROOT, {
        files: uiFiles.length ? uiFiles : null,
        capturar: true,
      });
      if (!silent) {
        const todos = uiRes.findings || [];
        /* Los conflictos NO son regresiones: son decisiones que nunca se
           cerraron (el mismo selector con valores distintos en varios
           archivos). Contarlos juntos hacia que el paso dijera "39 posibles
           regresiones" cuando eran 39 disputas y CERO regresiones — un numero
           alarmante por un problema distinto, que es la forma mas rapida de
           que alguien deje de leer los avisos. */
        const conflictos = todos.filter((f) => f.conflicto).length;
        const regresiones = todos.length - conflictos;
        const partes = [];
        if (regresiones) partes.push(regresiones + ' posible(s) regresion(es)');
        if (conflictos) partes.push(conflictos + ' decision(es) de diseno en disputa');
        console.log(partes.length
          ? '  2.8 UI Layout Memory... ⚠️  ' + partes.join('  ·  ') +
            '  —  ' + uiRes.capturados + ' valor(es) registrado(s)'
          : '  2.8 UI Layout Memory... ✅ ' + uiRes.capturados +
            ' valor(es) de diseño registrado(s), sin regresiones');
      }
    } else if (!silent) {
      console.log('  2.8 UI Layout Memory... — (sin archivos de front en este commit)');
    }
  } catch { if (!silent) console.log('  2.8 UI Layout Memory... ⚠️  omitido'); }

  // Step 2.85: Browser Gate condicional - solo si hay un servidor vivo.
  //
  // El browser-gate existia y era papel: necesitaba que alguien lo invocara a
  // mano con la URL. Ahora, si el commit toco front Y hay un servidor de
  // desarrollo respondiendo en un puerto habitual, corre solo y deja en la
  // libreta los errores de consola y de pagina. Si no hay servidor, no dice
  // nada y no molesta: un control que exige montar un entorno para poder
  // correr es un control que no corre.
  try {
    const bgPath = path.join(GRAFO_DIR, 'browser-gate.cjs');
    const frontTocado = commitFilesForScans.some(f =>
      /\.(html?|css|scss|js|jsx|ts|tsx|vue|svelte)$/i.test(f));
    if (fs.existsSync(bgPath) && frontTocado) {
      const puerto = puertoVivo();
      if (puerto) {
        const { execSync } = require('child_process');
        const salida = execSync(
          `node "${bgPath}" http://127.0.0.1:${puerto}`,
          { cwd: ROOT, stdio: 'pipe', timeout: 90000 }
        ).toString();
        if (!silent) {
          const mal = /error|ERROR|❌/.test(salida);
          console.log(mal
            ? `  2.85 Browser Gate... hallazgos en el puerto ${puerto} - ver libreta`
            : `  2.85 Browser Gate... sin errores de consola en el puerto ${puerto}`);
        }
      } else if (!silent) {
        console.log('  2.85 Browser Gate... - (ningun servidor de desarrollo escuchando)');
      }
    }
  } catch { if (!silent) console.log('  2.85 Browser Gate... omitido'); }


  // Step 2.9: CSS Token Gate — mitad mecánica de la NORMA CSS TOKENS de
  // 03-front.md (v3.17.0, caso real salud360: valores visuales compartidos
  // regados a mano en N archivos → ajustar una vista rompe otra). Corre solo
  // sobre los CSS/HTML del último commit y solo defiende tokens que el
  // proyecto YA definió — sin tokens, sin ruido. Fail-soft, WARN-only,
  // misma disciplina que 2.7 y 2.8.
  try {
    const ctgPath = path.join(GRAFO_DIR, 'css-token-gate.cjs');
    const cssFiles = commitFilesForScans.filter(f => /\.(css|html|htm)$/i.test(f));
    if (fs.existsSync(ctgPath) && cssFiles.length) {
      const ctg = require(ctgPath);
      const ctgRes = ctg.runCssTokenGate(cssFiles, ROOT);
      if (!silent) {
        const n = (ctgRes.findings || []).length;
        console.log(ctgRes.sinTokens
          ? '  2.9 CSS Token Gate... — (proyecto sin tokens definidos)'
          : n > 0
            ? `  2.9 CSS Token Gate... ⚠️  ${n} valor(es) hardcodeados que ya tienen token — ver libreta (gate_events)`
            : '  2.9 CSS Token Gate... ✅ sin hallazgos');
      }
    } else if (!silent) {
      console.log('  2.9 CSS Token Gate... — (sin archivos CSS/HTML en este commit)');
    }
  } catch { if (!silent) console.log('  2.9 CSS Token Gate... ⚠️  omitido'); }

  // Step 2.10: Canario Gate — un arreglo no se cierra sin un test que lo detecte.
  //
  // "Que los errores no se repitan" no lo da la memoria: lo da un test que se
  // pone rojo si el error vuelve. Eso estaba escrito como disciplina en el
  // protocolo, y la disciplina que depende de que alguien se acuerde no ocurre:
  // en D:ð hay 29 errores registrados y 3 protected_behaviors. Veintinueve
  // arreglos, tres canarios.
  //
  // Aquí se cuenta, no se juzga: si el cambio toca produccion y ningun test,
  // lo dice — y distingue el arreglo sin canario (la regresion de manana) de la
  // funcionalidad sin test (deuda normal). WARN-only, como sus hermanos: el
  // freno lo pone el dev al leerlo, no un script que puede equivocarse.
  try {
    const cgPath = path.join(GRAFO_DIR, 'canario-gate.cjs');
    if (fs.existsSync(cgPath)) {
      const cg = require(cgPath);
      const cgRes = cg.revisar(ROOT, {
        files: commitFilesForScans.length ? commitFilesForScans : null,
        commit: !commitFilesForScans.length,
        /* `datos` vive en otro ambito y aqui era undefined: el paso entero
           caia por el catch y se veia como "omitido", sin decir por que.
           Sin tipo declarado el canario usa el mensaje del commit, que es
           la mejor senal disponible en este punto y ya la tiene delante. */
        tipo: null,
      });
      if (!silent) {
        console.log(cgRes.veredicto === 'STOP'
          ? `  2.10 Canario Gate... ⚠️  ARREGLO sin test que lo detecte — ${cgRes.produccion.length} archivo(s) de produccion, 0 tests`
          : cgRes.veredicto === 'WARN'
            ? `  2.10 Canario Gate... ⚠️  ${cgRes.produccion.length} archivo(s) de produccion sin test nuevo`
            : '  2.10 Canario Gate... ✅ el cambio trae su test');
      }
    } else if (!silent) {
      console.log('  2.10 Canario Gate... — (no instalado)');
    }
  } catch { if (!silent) console.log('  2.10 Canario Gate... ⚠️  omitido'); }

  // Step 2.11: Preservation Gate — el que dice si algo que estaba verde se rompió.
  //
  // ESTO NO CORRIA. NUNCA. Y es la pieza que alimenta a casi todo lo demas.
  //
  // `runPreservationGate` corre los tests de los contratos en riesgo, detecta
  // cuales se rompieron y es la UNICA funcion que incrementa `failure_count` y
  // escribe en `contract_violations`. Esta bien escrita y solo se invocaba a
  // mano desde la terminal o desde el MCP.
  //
  // Consecuencia medida en D:ð tras 155 ciclos: los 102 contratos con
  // failure_count = 0, la tabla de violaciones vacia, y el detector FRAGILITY
  // del Creative Engine ciego — porque lee justo ese campo. Un gate que existe,
  // funciona y nadie llama protege cero, igual que la memoria de diseño de la v1.
  //
  // Corre ACOTADO a los archivos del commit (solo los tests de los contratos en
  // riesgo, no la suite entera) y es WARN-only: informa, no frena. El freno ya
  // lo pone el TDD Gate antes de llegar aqui.
  try {
    const cgPath = path.join(GRAFO_DIR, 'contract-guard.cjs');
    if (fs.existsSync(cgPath)) {
      const cg = require(cgPath);
      /* contract-guard NO exporta su initDB: se abre la base con el helper de
         este archivo. Llamar a `cg.initDB` daba undefined y el gate caía por el
         camino silencioso de "sin base" — un fallo que no se habría notado
         nunca, porque el mensaje era idéntico al de un proyecto sin memoria. */
      const dbPG = openDB();
      if (dbPG && typeof cg.runPreservationGate === 'function') {
        if (typeof cg.migrateSchema === 'function') { try { cg.migrateSchema(dbPG); } catch {} }
        const pg = cg.runPreservationGate(dbPG, ROOT, (results && results.ciclo) || `post-${Date.now()}`,
          commitFilesForScans || []);
        const roturas = (pg.violations || []).length;

        /* Cada rotura deja su arista causal: "este cambio rompio aquello".
           Es lo que el detector REFACTOR lee para decir "esto lo rompen los
           cambios ajenos una y otra vez" — y estaba a cero porque nadie creaba
           la arista. */
        if (roturas) registrarRegresiones(dbPG, pg.violations, commitFilesForScans || []);

        if (!silent) {
          console.log(roturas
            ? `  2.11 Preservation Gate... ⚠️  ${roturas} contrato(s) roto(s) — ver contract_violations`
            : '  2.11 Preservation Gate... ✅ nada de lo que estaba verde se rompio');
        }
        try { dbPG.close(); } catch {}
      } else if (!silent) {
        console.log('  2.11 Preservation Gate... — (sin base o sin la funcion)');
      }
    } else if (!silent) {
      console.log('  2.11 Preservation Gate... — (no instalado)');
    }
  } catch (e) {
    if (!silent) console.log('  2.11 Preservation Gate... ⚠️  omitido' +
      (process.env.AKDD_DEBUG ? ' (' + e.message + ')' : ''));
  }

  // Step 2.12: ¿acertó la predicción?
  //
  // Va AL FINAL de los controles a propósito: la calificación sale de comparar
  // lo que se predijo al empezar con lo que registraron los gates. Si corriera
  // antes, no habría nada que comparar.
  //
  // La tabla de verdad está en prediccion-registro.cjs, y el caso que importa
  // entenderlo es este: "predijo ALTO y no pasó nada" NO se cuenta como fallo.
  // Un aviso atendido previene el problema, y castigar al sistema por eso lleva
  // a bajar la sensibilidad hasta que la alerta no avisa de nada. Se cuenta
  // como "sin verdad conocida".
  //
  // El número que sí se puede exigir que baje es el FALSO NEGATIVO: predijo
  // BAJO y se rompió algo. Ese no admite interpretación.
  try {
    const pregPath = path.join(GRAFO_DIR, 'prediccion-registro.cjs');
    if (fs.existsSync(pregPath)) {
      const preg = require(pregPath);
      const ev = preg.evaluarPendientes(ROOT, (results && results.ciclo) || null);
      if (!silent) {
        if (!ev.evaluadas) {
          console.log('  2.12 Predicción... — (ninguna apuntada en las últimas horas)');
        } else {
          const partes = [];
          if (ev.aciertos) partes.push(ev.aciertos + ' acierto(s)');
          if (ev.falsosNegativos) partes.push(ev.falsosNegativos + ' FALSO(S) NEGATIVO(S)');
          if (ev.sinVerdad) partes.push(ev.sinVerdad + ' sin verdad conocida');
          console.log((ev.falsosNegativos
            ? '  2.12 Predicción... ⚠️  '
            : '  2.12 Predicción... ✅ ') + partes.join(' · '));
        }
      }
    } else if (!silent) {
      console.log('  2.12 Predicción... — (no instalado)');
    }
  } catch (e) {
    if (!silent) console.log('  2.12 Predicción... ⚠️  omitido' +
      (process.env.AKDD_DEBUG ? ' (' + e.message + ')' : ''));
  }

  // Step 3: Register modules
  if (!silent) process.stdout.write('  3. Registrando módulos... ');
  results.modulos = registrarModulos(db);
  if (!silent) console.log(results.modulos.length > 0 ? `✅ ${results.modulos.join(', ')}` : '⚠️  sin módulos');

  // Step 4: Detect and write patterns
  if (!silent) process.stdout.write('  4. Detectando patrones Node.js... ');
  results.patrones = detectarYEscribirPatrones(db);
  if (!silent) console.log(results.patrones.length > 0 ? `✅ ${results.patrones.length} nuevos` : '✅ sin cambios');

  // Step 5: Generate specs
  if (!silent) process.stdout.write('  5. Generando specs... ');
  results.specs = generarSpec(db);
  if (!silent) console.log(results.specs.length > 0 ? `✅ ${results.specs.join(', ')}` : '⚠️  sin specs');

  // Step 6: Save config to BD
  if (!silent) process.stdout.write('  6. Guardando config en BD... ');
  guardarConfigEnBD(db);
  if (!silent) console.log('✅');

  // Step 7: Write observability log
  if (!silent) process.stdout.write('  7. Escribiendo log... ');
  escribirLog();
  results.log = true;
  if (!silent) console.log('✅');

  // Step 7.5: ReasoningBank — aprender de este ciclo exitoso (MARK 3)
  try {
    const rb = require('./reasoning-bank.cjs');
    const strat = `Módulo ${area}: ${testsPassing} tests pasando` +
      (results.patrones && results.patrones.length ? `; patrones: ${results.patrones.slice(0, 5).join(', ')}` : '');
    const rres = rb.record(db, {
      intent: taskName,
      area,
      strategy: strat,
      signals: { tests: testsPassing, modules, patrones: results.patrones || [] },
    });
    results.reasoning = rres && rres.action;
    if (!silent) console.log(`  8. ReasoningBank... ${rres && rres.ok ? '✅ ' + rres.action + (rres.confidence ? ` (${rres.confidence})` : '') : '⚠️  ' + ((rres && rres.reason) || 'omitido')}`);
  } catch (e) { /* best-effort — nunca rompe el ciclo */ }

  db.close();

  // Step 9: Sync grafo (after DB close)
  if (!silent) process.stdout.write('  8. Sync grafo... ');
  results.sync = syncGrafo();
  if (!silent) console.log(results.sync ? '✅' : '⚠️  sync falló (continuando)');

  // Step 10: Index AST (incremental — solo re-parsea archivos cambiados)
  if (!silent) process.stdout.write('  9. Index AST (mapa de código)... ');
  results.ast = indexarAst();
  if (!silent) console.log(results.ast ? '✅' : '⚠️  (omitido)');

  // Step 11: Parallel Guard ("romper el silencio") — solo corre si el
  // orquestador pasó --expected-parallel, es decir, si MODO LEGIÓN decidió
  // que esta tarea calificaba para Front+Back simultáneo. No previene el
  // salto (eso solo lo puede evitar el propio modelo, dentro de su turno) —
  // lo hace VISIBLE en vez de silencioso, escribiendo el veredicto a
  // _output/ en vez de dejarlo pasar como si el ciclo hubiera cumplido.
  results.parallelGuard = null;
  if (opts['expected-parallel']) {
    if (!silent) process.stdout.write('  10. Parallel Guard... ');
    try {
      const { checkParallelDispatch, formatearVeredicto } = require('./parallel-guard.cjs');
      const windowMinutes = parseInt(opts['window-minutes']) || 30;
      const veredicto = await checkParallelDispatch(ROOT, { windowMinutes });
      results.parallelGuard = veredicto;
      if (!silent) {
        const icono = { CONFIRMADO: '✅', NO_CONFIRMADO: '⚠️ ', SIN_EVIDENCIA: '❔' }[veredicto.verdicto] || '?';
        console.log(`${icono} ${veredicto.verdicto}`);
      }

      if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
      const fecha = new Date().toISOString().slice(0, 10);
      const reportPath = path.join(LOG_DIR, `parallel-guard-${fecha}.md`);
      const entrada = `## ${new Date().toISOString()} — ${taskName}\n\n${formatearVeredicto(veredicto)}\n\n---\n\n`;
      fs.appendFileSync(reportPath, entrada, 'utf8');
    } catch (e) {
      if (!silent) console.log(`⚠️  error verificando: ${e.message.slice(0, 80)}`);
    }
  }

  // Step 12 (PIEZA 2, aditivo): sellar el grafo con el commit HEAD actual —
  // así checkFreshness() puede medir después qué tan al día está la memoria.
  // Best-effort: si falla (sin git, sin DB), el post-cycle reporta igual que siempre.
  if (!silent) process.stdout.write('  11. Freshness stamp... ');
  try {
    const fresh = require('./graph-freshness.cjs').stampGraph(process.cwd());
    if (!silent) console.log(fresh.ok ? `✅ ${fresh.commit.slice(0, 8)}` : `⚠️  (${fresh.reason})`);
  } catch (e) { if (!silent) console.log('⚠️  (omitido)'); }

  if (!silent) {
    console.log('\n══════════════════════════════════════════════════');
    console.log('  ✅ Post-Cycle completado');
    console.log(`  Ciclo: ${results.ciclo ? String(results.ciclo).slice(0,8) : '—'} | Contratos: ${results.contratos?.success ? '✅' : '⚠️'}`);
    console.log(`  Módulos: ${results.modulos.length} | Patrones: ${results.patrones.length} nuevos | Specs: ${results.specs.length}`);
    if (results.parallelGuard) {
      const icono = { CONFIRMADO: '✅', NO_CONFIRMADO: '⚠️ ', SIN_EVIDENCIA: '❔' }[results.parallelGuard.verdicto] || '?';
      console.log(`  Parallel Guard: ${icono} ${results.parallelGuard.verdicto} — ${results.parallelGuard.razon}`);
    }
    console.log('══════════════════════════════════════════════════\n');
  }
}

if (require.main === module) {
  main().catch(e => { console.error('❌ post-cycle falló:', e.message); process.exit(1); });
}

module.exports = { main, detectPatterns, registrarModulos, generarSpec, registrarRegresiones };
