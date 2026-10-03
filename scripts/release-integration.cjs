'use strict';
/**
 * Piloto de release (3.20.1): el artefacto que se va a publicar actualiza
 * consumidores REALES de versiones publicadas, de punta a punta.
 *
 * Qué ejercita (y por qué es el artefacto de verdad, no el repo):
 *   1. Instala el TARBALL en un directorio limpio (solo dependencias de producción,
 *      sin opcionales) y usa ESA CLI instalada: la misma que recibiría un usuario.
 *   2. Para cada versión base publicada (3.19.0 y 3.20.0) arma un consumidor ejecutando
 *      el motor PUBLICADO (no un esquema escrito a mano), le añade datos propios
 *      (tablas del consumidor, BLOB, INTEGER de 64 bits, WAL, vistas, índices) y:
 *        · akdd update --check   → plan, sin tocar nada
 *        · akdd update           → VERIFIED, memoria conservada por CONTENIDO
 *        · akdd update (otra vez)→ NO_CHANGES_VERIFIED, idempotente
 *        · MCP por stdio sobre el proyecto actualizado (initialize, remember, recall)
 *        · akdd update --rollback → archivos atrás, memoria intacta, motor anterior la lee
 *   3. Las sondas adversariales (sandbox/) contra el paquete.
 *
 * No certifica una sesión real de Cursor/Claude ni consumidores que no sean estos.
 */
const TARGET = require('../package.json').version;
const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const { spawn, spawnSync } = require('child_process'), readline = require('readline');
const { herramienta, nodo } = require('../src/run-safe');
const { extractTarGz } = require('../src/tar-extract');
const ROOT = path.resolve(__dirname, '..');

async function rpc(root) {
  const p = spawn(process.execPath, [path.join(root, '.agentic/grafo/mcp-server.cjs')], { cwd: root, env: { ...process.env, PROJECT_ROOT: root, NODE_PATH: path.join(ROOT, 'node_modules'), NODE_NO_WARNINGS: '1' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let id = 0, err = '';
  p.stderr.on('data', (b) => { err = (err + b).slice(-6000); });
  const pending = new Map();
  readline.createInterface({ input: p.stdout }).on('line', (line) => {
    try { const r = JSON.parse(line), a = pending.get(r.id); if (a) { pending.delete(r.id); clearTimeout(a.timer); r.error ? a.reject(Error(JSON.stringify(r.error))) : a.resolve(r.result); } } catch { /* línea de log */ }
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const n = ++id;
    const timer = setTimeout(() => { pending.delete(n); reject(Error('MCP_TIMEOUT ' + method + ' ' + err)); }, 30000);
    pending.set(n, { resolve, reject, timer });
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
  });
  const tool = async (name, args) => {
    const r = await call('tools/call', { name, arguments: args });
    assert.notEqual(r.isError, true, JSON.stringify(r));
    const c = r.content && r.content.find((x) => x.type === 'text');
    return c ? JSON.parse(c.text) : r;
  };
  try {
    const initialized = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'agentix-release-check', version: '1' } });
    assert.equal(initialized.serverInfo.version, TARGET);
    const tools = await call('tools/list', {});
    for (const n of ['recall', 'remember', 'effort_decide', 'teams', 'restore']) assert.ok(tools.tools.some((t) => t.name === n), 'MCP tool ' + n);
    const saved = await tool('remember', { entry: 'Release sentinel: conservar memoria y verificar el paquete publicado', tipo: 'patron', area: 'release', confianza: 'ALTA' });
    assert.ok(saved.ok, JSON.stringify(saved));
    const recalled = await tool('recall', { query: 'Release sentinel', top_k: 5, budget_tokens: 1000 });
    assert.ok(JSON.stringify(recalled).includes('sentinel'), JSON.stringify(recalled));
    return { tools: tools.tools.length, initialize: true, remember: true, recall: true };
  } finally { p.stdin.end(); p.kill(); for (const a of pending.values()) clearTimeout(a.timer); }
}

/** Ejecuta la CLI INSTALADA desde el tarball. Devuelve el JSON de la operación. */
function akdd(bin, project, args) {
  const r = spawnSync(process.execPath, [bin, ...args], { cwd: project, encoding: 'utf8', timeout: 600000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* sin JSON */ }
  return { exit: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

/** Añade al consumidor datos que un usuario real sí podría perder. */
function datosPropios(project, dba) {
  const db = dba.openWrite(path.join(project, '.agentic', 'memoria.db'), { updateOwner: true });
  try {
    for (let i = 0; i < 50; i++) db.run('INSERT INTO nodos (tipo, titulo, contenido, area, confianza) VALUES (?,?,?,?,?)', ['patron', 'PRIVATE_' + i, 'Memoria original ' + i + ' ñandú', 'release', 'ALTA']);
    db.exec('CREATE TABLE release_private (id INTEGER, k TEXT, b BLOB, big, PRIMARY KEY (id, k)) WITHOUT ROWID');
    db.transaction(() => { for (let i = 0; i < 500; i++) db.run('INSERT INTO release_private VALUES (?,?,?,?)', [i, 'PRESERVE_' + i, Buffer.from([i % 256, 255, 0]), i === 0 ? 9223372036854775807n : i]); })();
    db.exec('CREATE VIEW v_release AS SELECT k FROM release_private');
    db.exec('CREATE INDEX idx_release_k ON release_private(k)');
  } finally { db.close(); }
  fs.writeFileSync(path.join(project, 'src', 'business.cjs'), 'USER_PRIVATE_BUSINESS\n');
}

async function consumidor(version, bin, bundle, dba, inv) {
  const legacy = require('../test/helpers/legacy-real.cjs');
  const p = legacy.proyectoReal(version, 'release');
  datosPropios(p.root, dba);
  const dbPath = p.dbPath;
  const tomar = (opts) => { const d = dba.openReadOnly(dbPath); try { return inv.takeInventory(d, opts); } finally { d.close(); } };
  const antes = tomar();
  const propios = inv.inventoryFiles(p.root, { incluir: (rel) => !require('../src/managed-manifest').esManaged(rel) });
  const arbolAntes = legacy.huellaArbol(p.root);

  // 1. --check: plan, sin tocar nada
  const check = akdd(bin, p.root, ['update', '--check', '--json']);
  assert.equal(check.exit, 0, version + ' --check: ' + check.stderr);
  assert.equal(check.json.status, 'PLAN_READY', version + ' --check');
  assert.deepEqual(legacy.huellaArbol(p.root), arbolAntes, version + ': --check no puede modificar nada');

  // 2. update real, con la CLI instalada desde el tarball
  const r1 = akdd(bin, p.root, ['update', '--json']);
  assert.equal(r1.exit, 0, version + ' update: ' + (r1.stderr || r1.stdout).slice(0, 800));
  assert.equal(r1.json.status, 'VERIFIED', version + ': ' + JSON.stringify([r1.json.errors, r1.json.warnings, r1.json.not_verified]));
  assert.equal(r1.json.versions.from, version);
  assert.equal(r1.json.versions.to, TARGET);
  assert.equal(r1.json.preservation.db.status, 'PASS');
  assert.equal(r1.json.preservation.files.status, 'PASS');
  assert.equal(r1.json.schema.after.status, 'COMPLETE');
  assert.ok(r1.json.functional.checks.every((c) => c.status === 'PASS'), version + ' funcional: ' + JSON.stringify(r1.json.functional.checks));
  const cmp = inv.compare(antes, tomar({ columnsFrom: antes }));
  assert.equal(cmp.status, 'PASS', version + ': ' + JSON.stringify(cmp.problems));
  const despuesPropios = inv.inventoryFiles(p.root, { incluir: (rel) => !require('../src/managed-manifest').esManaged(rel) });
  assert.equal(inv.compareFiles(propios, despuesPropios, {}).ok, true, version + ': archivos propios intactos');

  // 3. idempotente
  const r2 = akdd(bin, p.root, ['update', '--json']);
  assert.equal(r2.exit, 0);
  assert.equal(r2.json.status, 'NO_CHANGES_VERIFIED', version + ' repetición: ' + JSON.stringify(r2.json.errors));
  const tras2 = legacy.huellaArbol(p.root);

  // 4. MCP del proyecto actualizado
  const mcp = await rpc(p.root);

  // 5. rollback: archivos atrás, memoria intacta, el motor anterior la lee
  // El MCP (remember/recall) escribió memoria NUEVA después del update: el rollback no debe tocarla.
  const antesDelRollback = tomar({ columnsFrom: antes });
  const rb = akdd(bin, p.root, ['update', '--rollback', '--json']);
  assert.equal(rb.exit, 0, version + ' rollback: ' + (rb.stderr || rb.stdout).slice(0, 400));
  assert.equal(rb.json.status, 'ROLLED_BACK');
  assert.equal(rb.json.recovery.db.state, 'UNTOUCHED');
  const cmpRb = inv.compare(antesDelRollback, tomar({ columnsFrom: antes }));
  assert.equal(cmpRb.status, 'PASS', version + ' rollback: la memoria no se toca: ' + JSON.stringify(cmpRb.problems).slice(0, 600));
  const viejo = spawnSync(process.execPath, [path.join(p.root, '.agentic', 'grafo', 'grafo.cjs'), 'stats'], { cwd: p.root, encoding: 'utf8', timeout: 120000, env: { ...process.env, NODE_NO_WARNINGS: '1', NODE_PATH: path.join(ROOT, 'node_modules') } });
  assert.equal(viejo.status, 0, version + ': el motor anterior no pudo leer la base migrada: ' + viejo.stderr.slice(0, 300));

  // El motor anterior, al leer, reescribe marcas de tiempo propias (project_settings.updated_at): la línea base va DESPUÉS.
  const trasMotorViejo = tomar({ columnsFrom: antes });

  // 6. y se puede volver a actualizar después del rollback
  const r3 = akdd(bin, p.root, ['update', '--json']);
  assert.equal(r3.exit, 0, version + ' re-update: ' + (r3.stderr || r3.stdout).slice(0, 400));
  assert.ok(['VERIFIED', 'VERIFIED_WITH_WARNINGS'].includes(r3.json.status), version + ' re-update: ' + r3.json.status);
  const final = tomar({ columnsFrom: antes });
  { const c = inv.compare(trasMotorViejo, final); assert.equal(c.status, 'PASS', version + ' tras el re-update: ' + JSON.stringify(c.problems).slice(0, 600)); }
  assert.equal(final.integrity, 'ok');
  void tras2;
  return {
    from: version, to: TARGET, status: r1.json.status, migrations_applied: r1.json.schema.migrations.applied.length, migrations_adopted: r1.json.schema.migrations.adopted.length,
    tables_compared: cmp.summary.compared, rows_compared: cmp.summary.rows_compared, user_tables: cmp.summary.user_tables, backup_verified: r1.json.backup.integrity === 'ok',
    idempotent: true, rollback: true, old_engine_reads_migrated_db: true, mcp, duration_ms: r1.json.duration_ms,
  };
}

async function check(tgz, lab, baselines) {
  const bundle = path.join(lab, 'package'); fs.mkdirSync(bundle, { recursive: true }); extractTarGz(tgz, bundle);
  assert.equal(require(path.join(bundle, 'package.json')).version, TARGET);
  for (const f of ['.agentic/grafo/schema-catalog.cjs', '.agentic/grafo/memory-inventory.cjs', '.agentic/grafo/update-guard.cjs', 'src/update-run.js', 'src/release-manifests.json']) assert.ok(fs.existsSync(path.join(bundle, f)), 'el paquete no trae ' + f);

  // Instalación limpia del TARBALL: lo que recibiría un usuario (sin opcionales).
  const installRoot = path.join(lab, 'clean-install');
  herramienta('npm', ['install', '--prefix', installRoot, tgz, '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'], { encoding: 'utf8', timeout: 240000 });
  const bin = path.join(installRoot, 'node_modules', 'agentic-kdd', 'bin', 'akdd.js');
  assert.equal(nodo(bin, ['--version'], { encoding: 'utf8' }).trim(), TARGET);

  const dba = require(path.join(bundle, '.agentic/grafo/db-adapter.cjs'));
  const inv = require(path.join(bundle, '.agentic/grafo/memory-inventory.cjs'));
  const versiones = (Array.isArray(baselines) ? baselines : [baselines]).filter(Boolean);
  const consumidores = [];
  for (const v of ['3.19.0', '3.20.0']) consumidores.push(await consumidor(v, bin, bundle, dba, inv));

  const attacks = require('../sandbox/probes.cjs').run(bundle, 512, 211), native = require('../sandbox/native-probes.cjs').run(bundle);
  assert.equal(attacks.failures.length, 0, JSON.stringify(attacks.failures));
  assert.equal(native.failures.length, 0, JSON.stringify(native.failures));
  fs.writeFileSync(path.join(lab, 'adversarial-results.json'), JSON.stringify({ attacks, native }, null, 2));
  void versiones;
  return {
    adversarial: { cases: attacks.results.length + native.results.length, failures: 0, seed: 211 },
    clean_npm_install_core: true, published_baseline: consumidores.map((c) => c.from), target: TARGET, sqlite_integrity: 'ok',
    consumers: consumidores,
    original_nodes_preserved: true, private_rows_preserved: 500, content_preserved_by_inventory: true,
    idempotent: true, rollback: true, migration_preserves_rows: true,
    mcp: consumidores[0].mcp,
  };
}
module.exports = { check, rpc };
