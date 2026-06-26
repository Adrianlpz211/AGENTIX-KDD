/**
 * Agentic KDD — Collab Manager v2.0
 * Modo colaborativo automático via Turso + Cloudflare Worker.
 *
 * El usuario solo corre: akdd collab init
 * El sistema crea la DB en Turso automáticamente.
 * El usuario nunca sabe que Turso existe.
 *
 * Uso:
 *   node .agentic/grafo/collab-manager.cjs init
 *   node .agentic/grafo/collab-manager.cjs push
 *   node .agentic/grafo/collab-manager.cjs pull
 *   node .agentic/grafo/collab-manager.cjs status
 *   node .agentic/grafo/collab-manager.cjs join <url> <token>
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execSync } = require('child_process');

// URL de tu Cloudflare Worker — actualizar después de deploy
const PROVISIONER_URL = 'https://agentic-collab.adrianlpz-game.workers.dev';

const COLLAB_CONFIG_PATH = '.agentic/collab.json';

// ─── SYNC TABLES — TODO lo que hace a Agentic L4 ──────────────────────────────
// Regla: si está aquí, cualquier miembro del equipo que haga collab pull
// recibe el cerebro completo del proyecto — no solo fragmentos.
//
// NO sincronizar:
//   regression_snapshots  → snapshots de sesión individual, no conocimiento del equipo
//   working_memory        → buffer de sesión activa, se resetea por diseño
//   creative_suggestions  → sugerencias personales del dev, no del equipo
//   git_context_log       → log local de diffs, cada dev tiene su propio git
//   deferred_queue        → archivo JSON por dev, no tabla compartida
//
const SYNC_TABLES = [

  // ── CORE MEMORY (CoALA 4 layers) ───────────────────────────────────────────
  'nodos',              // Patrones, errores, decisiones con confianza — EL núcleo
  'episodios',          // Historia cruda de cada ciclo
  'entidades',          // Módulos, archivos, APIs detectados en el proyecto
  'relaciones_semanticas', // Causal edges: caused_failure, was_fixed_by, verifies, protects

  // ── CICLOS Y TRAZABILIDAD ──────────────────────────────────────────────────
  'ciclos',             // Qué se hizo, cuándo, con qué resultado — historial ejecutivo
  'fases',              // Fases dentro de cada ciclo — granularidad total
  'knowledge_docs',     // ADRs, gotchas, convenciones — por qué las cosas son como son

  // ── AST GRAPH ─────────────────────────────────────────────────────────────
  'ast_symbols',        // Símbolos del codebase — estructura completa
  'ast_edges',          // Relaciones AST — dependencias, imports, call graph

  // ── PRESERVATION INTELLIGENCE ─────────────────────────────────────────────
  'verified_contracts', // Contratos protegidos — lo que no se puede romper
  'creative_wins',      // Mejoras aplicadas — el equipo aprende de lo que funcionó
  'contract_violations',// Violaciones pasadas — el equipo sabe qué rompió qué

  // ── PREDICCIÓN Y CI/CD ────────────────────────────────────────────────────
  'prediction_log',     // Patrones de riesgo predictivo detectados
  'cicd_reports',       // Reportes de CI/CD — qué falló en producción
];

// ─── DB LOCAL ──────────────────────────────────────────────────────────────────

function openLocalDB(projectRoot) {
  const dbPath = path.join(projectRoot, '.agentic/memoria.db');
  try { return new (require('better-sqlite3'))(dbPath); } catch {}
  try { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(dbPath); } catch {}
  throw new Error('No SQLite driver disponible');
}

// ─── CONFIG ───────────────────────────────────────────────────────────────────

function loadConfig(projectRoot) {
  const configPath = path.join(projectRoot, COLLAB_CONFIG_PATH);
  if (!fs.existsSync(configPath)) return null;
  try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { return null; }
}

function saveConfig(projectRoot, config) {
  const configPath = path.join(projectRoot, COLLAB_CONFIG_PATH);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  // Asegurar que collab.json está en .gitignore
  const gitignorePath = path.join(projectRoot, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const gi = fs.readFileSync(gitignorePath, 'utf8');
    if (!gi.includes('collab.json')) {
      fs.appendFileSync(gitignorePath, '\n# Agentic KDD collab credentials\n.agentic/collab.json\n');
    }
  }
}

// ─── GENERAR PROJECT ID ───────────────────────────────────────────────────────

function getProjectId(projectRoot) {
  // Usar el nombre del directorio + un hash corto para que sea único y legible
  const dirName = path.basename(projectRoot).toLowerCase().replace(/[^a-z0-9]/g, '-');
  const hash = require('crypto')
    .createHash('md5')
    .update(projectRoot)
    .digest('hex')
    .substring(0, 6);
  return `${dirName}-${hash}`;
}

// ─── INIT — PROVISIONAR DB AUTOMÁTICAMENTE ───────────────────────────────────

async function collabInit(projectRoot) {
  console.log('\n[COLLAB] Activando modo colaborativo...\n');

  // Verificar si ya está configurado
  const existing = loadConfig(projectRoot);
  if (existing?.enabled && existing?.url) {
    console.log('[COLLAB] Ya configurado. URL:', existing.url);
    console.log('[COLLAB] Para re-configurar: borrar .agentic/collab.json y correr de nuevo.');
    return existing;
  }

  const projectId = getProjectId(projectRoot);
  console.log(`[COLLAB] Project ID: ${projectId}`);
  console.log('[COLLAB] Creando base de datos compartida...');

  // Llamar al Cloudflare Worker para provisionar la DB
  let provisionResult;
  try {
    const response = await fetch(PROVISIONER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Provisioner error: ${err}`);
    }

    provisionResult = await response.json();
  } catch (e) {
    console.error('[COLLAB] Error conectando con el servidor de provisión:', e.message);
    console.error('[COLLAB] Verificar que el Cloudflare Worker está activo.');
    process.exit(1);
  }

  if (!provisionResult.ok) {
    console.error('[COLLAB] Error creando DB:', provisionResult.error);
    process.exit(1);
  }

  // Guardar credenciales localmente
  const config = {
    enabled: true,
    url: provisionResult.url,
    token: provisionResult.token,
    db: provisionResult.db,
    project_id: projectId,
    member_id: os.userInfo().username,
    sync_on_cycle_end: true,
    last_sync: null,
    created_at: new Date().toISOString(),
  };

  saveConfig(projectRoot, config);

  console.log('\n[COLLAB] ✅ Modo colaborativo activado.');
  console.log(`[COLLAB] DB: ${provisionResult.db}`);
  console.log('[COLLAB] Credenciales guardadas en .agentic/collab.json (gitignored)');
  console.log('\n[COLLAB] Para que otros miembros del equipo se unan:');
  console.log(`  Compárteles: URL y token de .agentic/collab.json`);
  console.log(`  Ellos corren: akdd collab join <url> <token>\n`);

  // Primer push
  console.log('[COLLAB] Sincronizando memoria local → compartida...');
  await syncUp(projectRoot);

  return config;
}

// ─── JOIN — PARA EL DEV QUE SE UNE AL EQUIPO ─────────────────────────────────

async function collabJoin(projectRoot, urlOrCode, token) {
  console.log('\n[COLLAB] Uniéndose al equipo...\n');

  let finalUrl = urlOrCode;
  let finalToken = token;

  // Detectar si es un código de invitación (formato: PREFIX-XXXXXX)
  const isInviteCode = !urlOrCode?.startsWith('libsql://') && !urlOrCode?.startsWith('http');

  if (isInviteCode) {
    console.log(`[COLLAB] Resolviendo código: ${urlOrCode}`);
    try {
      const response = await fetch(`${PROVISIONER_URL}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: urlOrCode }),
      });
      const result = await response.json();

      if (!result.ok) {
        console.error(`[COLLAB] ❌ ${result.error}`);
        process.exit(1);
      }

      finalUrl   = result.url;
      finalToken = result.token;
      console.log(`[COLLAB] ✅ Código válido. Conectando a: ${result.db}`);
    } catch (e) {
      console.error('[COLLAB] Error resolviendo código:', e.message);
      process.exit(1);
    }
  }

  const config = {
    enabled: true,
    url: finalUrl,
    token: finalToken,
    member_id: os.userInfo().username,
    sync_on_cycle_end: true,
    last_sync: null,
    joined_at: new Date().toISOString(),
  };

  saveConfig(projectRoot, config);

  console.log('[COLLAB] ✅ Conectado al equipo.');
  console.log('[COLLAB] Descargando memoria del equipo...');

  await syncDown(projectRoot);

  console.log('[COLLAB] ✅ Listo. Ya tienes toda la memoria del equipo.\n');
}

// ─── INVITE ───────────────────────────────────────────────────────────────────

async function collabInvite(projectRoot) {
  const config = loadConfig(projectRoot);
  if (!config?.enabled) {
    console.log('\n[COLLAB] Modo colaborativo no activado. Correr: akdd collab init\n');
    return;
  }

  const projectId = config.project_id || getProjectId(projectRoot);
  console.log('\n[COLLAB] Generando código de invitación...');

  let result;
  try {
    const response = await fetch(`${PROVISIONER_URL}/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId }),
    });
    result = await response.json();
  } catch (e) {
    console.error('[COLLAB] Error:', e.message);
    return;
  }

  if (!result.ok) {
    console.error('[COLLAB] Error generando código:', result.error);
    return;
  }

  console.log('\n' + '═'.repeat(50));
  console.log('  🔑 Código de invitación Agentic KDD');
  console.log('═'.repeat(50));
  console.log(`\n  Código:   ${result.code}`);
  console.log(`  Expira:   ${result.expires_in}`);
  console.log(`  Un solo uso — expira al usarse o en 24h`);
  console.log('\n  Comparte este código por Slack/WhatsApp.');
  console.log('  El miembro del equipo corre:');
  console.log(`\n  akdd collab join ${result.code}\n`);
  console.log('═'.repeat(50) + '\n');
}

// ─── SYNC UP (local → Turso) ──────────────────────────────────────────────────

async function syncUp(projectRoot) {
  const config = loadConfig(projectRoot);
  if (!config?.enabled) {
    console.log('[COLLAB] Modo colaborativo no activado. Correr: akdd collab init');
    return { synced: false };
  }

  let client;
  try {
    const { createClient } = require('@libsql/client');
    client = createClient({ url: config.url, authToken: config.token });
  } catch {
    console.log('[COLLAB] @libsql/client no instalado. Correr: npm install @libsql/client');
    return { synced: false };
  }

  const localDB = openLocalDB(projectRoot);
  const lastSync = config.last_sync || '1970-01-01T00:00:00.000Z';
  let totalRows = 0;

  // Schema push — crear tablas en remoto si no existen
  await pushSchema(client, localDB);

  for (const table of SYNC_TABLES) {
    try {
      // Solo filas nuevas/modificadas desde el último sync
      const dateField = getDateField(table);
      const rows = localDB.prepare(
        `SELECT * FROM ${table} WHERE ${dateField} > ? LIMIT 500`
      ).all(lastSync);

      if (rows.length === 0) continue;

      console.log(`[COLLAB] ${table}: ${rows.length} filas a sincronizar`);

      for (const row of rows) {
        const keys = Object.keys(row);
        const vals = Object.values(row);
        const placeholders = keys.map(() => '?').join(', ');
        try {
          await client.execute({
            sql: `INSERT OR REPLACE INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`,
            args: vals,
          });
          totalRows++;
        } catch {}
      }
    } catch {}
  }

  // Actualizar last_sync
  config.last_sync = new Date().toISOString();
  saveConfig(projectRoot, config);

  console.log(`[COLLAB] ✅ Sync up: ${totalRows} filas enviadas.`);
  return { synced: true, rows: totalRows };
}

// ─── SYNC DOWN (Turso → local) ────────────────────────────────────────────────

async function syncDown(projectRoot) {
  const config = loadConfig(projectRoot);
  if (!config?.enabled) return { synced: false };

  let client;
  try {
    const { createClient } = require('@libsql/client');
    client = createClient({ url: config.url, authToken: config.token });
  } catch {
    console.log('[COLLAB] @libsql/client no instalado. Correr: npm install @libsql/client');
    return { synced: false };
  }

  const localDB = openLocalDB(projectRoot);
  let totalRows = 0;

  for (const table of SYNC_TABLES) {
    try {
      const dateField = getDateField(table);
      const lastSync = config.last_sync || '1970-01-01T00:00:00.000Z';

      const rs = await client.execute(
        `SELECT * FROM ${table} WHERE ${dateField} > ? LIMIT 1000`,
        [lastSync]
      );

      if (!rs.rows?.length) continue;

      console.log(`[COLLAB] ${table}: recibiendo ${rs.rows.length} filas`);

      for (const row of rs.rows) {
        const keys = Object.keys(row);
        const vals = keys.map(k => row[k]);
        const placeholders = keys.map(() => '?').join(', ');

        // Estrategia por tabla:
        // OR IGNORE: tablas aditivas — no sobrescribir versión local
        //   episodios, ciclos, fases, prediction_log, cicd_reports
        //   (cada dev tiene su propia historia de ejecución)
        // OR REPLACE: tablas de conocimiento compartido — toma la más reciente
        //   nodos, entidades, relaciones_semanticas, knowledge_docs,
        //   ast_symbols, ast_edges, verified_contracts, creative_wins, contract_violations
        const ADDITIVE_TABLES = new Set(['episodios','ciclos','fases','prediction_log','cicd_reports']);
        const strategy = ADDITIVE_TABLES.has(table) ? 'OR IGNORE' : 'OR REPLACE';

        try {
          localDB.prepare(
            `INSERT ${strategy} INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`
          ).run(vals);
          totalRows++;
        } catch {}
      }
    } catch {}
  }

  // Actualizar last_sync
  config.last_sync = new Date().toISOString();
  saveConfig(projectRoot, config);

  console.log(`[COLLAB] ✅ Sync down: ${totalRows} filas recibidas.`);
  return { synced: true, rows: totalRows };
}

// ─── SCHEMA PUSH ──────────────────────────────────────────────────────────────
// Crea las tablas en la DB remota si no existen (primera vez)

async function pushSchema(client, localDB) {
  const tables = localDB.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL"
  ).all();

  for (const table of tables) {
    if (!SYNC_TABLES.includes(table.name)) continue;
    try {
      await client.execute(
        table.sql.replace('CREATE TABLE', 'CREATE TABLE IF NOT EXISTS')
      );
    } catch {}
  }
}

// ─── STATUS ───────────────────────────────────────────────────────────────────

async function status(projectRoot) {
  const config = loadConfig(projectRoot);

  console.log('\n[COLLAB] Estado del modo colaborativo:\n');

  if (!config?.enabled) {
    console.log('  ❌ No activado.');
    console.log('  Correr: akdd collab init\n');
    return;
  }

  console.log(`  ✅ Activado`);
  console.log(`  DB:          ${config.db || config.url}`);
  console.log(`  Miembro:     ${config.member_id}`);
  console.log(`  Último sync: ${config.last_sync || 'nunca'}`);
  console.log(`  Auto-sync:   ${config.sync_on_cycle_end ? 'sí (al final de cada aa:)' : 'no'}`);

  // Test de conexión
  try {
    const { createClient } = require('@libsql/client');
    const client = createClient({ url: config.url, authToken: config.token });
    await client.execute('SELECT 1');
    console.log('  Conexión:    ✅ OK\n');
  } catch {
    console.log('  Conexión:    ❌ Error — verificar credenciales\n');
  }
}

// ─── HELPER ───────────────────────────────────────────────────────────────────

function getDateField(table) {
  const fields = {
    // Core memory
    nodos:                  'fecha_update',
    episodios:              'fecha',
    entidades:              'fecha_update',
    relaciones_semanticas:  'valid_at',
    // Ciclos y trazabilidad
    ciclos:                 'fecha_inicio',
    fases:                  'fecha',
    knowledge_docs:         'last_indexed',
    // AST
    ast_symbols:            'last_indexed',
    ast_edges:              'last_indexed',
    // Preservation Intelligence
    verified_contracts:     'updated_at',
    creative_wins:          'created_at',
    contract_violations:    'created_at',
    // Predicción y CI/CD
    prediction_log:         'fecha',
    cicd_reports:           'fecha',
  };
  return fields[table] || 'rowid';
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const [,, cmd, arg1, arg2] = process.argv;
  const projectRoot = process.cwd();

  switch (cmd) {
    case 'init':
      collabInit(projectRoot).catch(console.error);
      break;
    case 'invite':
      collabInvite(projectRoot).catch(console.error);
      break;
    case 'join':
      if (!arg1) {
        console.error('Uso: collab-manager.cjs join <código>');
        console.error('  o: collab-manager.cjs join <url> <token>');
        process.exit(1);
      }
      collabJoin(projectRoot, arg1, arg2).catch(console.error);
      break;
    case 'push':
      syncUp(projectRoot).then(r => {
        process.exit(r.synced ? 0 : 1);
      }).catch(console.error);
      break;
    case 'pull':
      syncDown(projectRoot).then(r => {
        process.exit(r.synced ? 0 : 1);
      }).catch(console.error);
      break;
    case 'status':
      status(projectRoot).catch(console.error);
      break;
    default:
      console.log('Uso: node collab-manager.cjs [init | join <url> <token> | push | pull | status]');
  }
}

module.exports = {
  collabInit,
  collabJoin,
  collabInvite,
  syncUp,
  syncDown,
  status,
  loadConfig,
};
