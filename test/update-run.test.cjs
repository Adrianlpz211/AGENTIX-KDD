'use strict';
/* akdd update 3.20.1: un solo comando, verificado. Consumidores REALES de 3.19.0 y 3.20.0. */
const test = require('node:test');
const { SIN_DRIVER } = require('./helpers/db-real.cjs');
if (SIN_DRIVER) { require('node:test').test(require('node:path').basename(__filename) + ' (omitido: ' + SIN_DRIVER + ')', { skip: SIN_DRIVER }, () => {}); return; }
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const legacy = require('./helpers/legacy-real.cjs');
const real = require('./helpers/db-real.cjs');
const { update, rollback } = require('../src/update.js');
const manifest = require('../src/managed-manifest.js');
const backup = require('../src/update-backup.js');
const { dba, REPO } = real;
const sc = require(path.join(REPO, '.agentic', 'grafo', 'schema-catalog.cjs'));
const guard = require(path.join(REPO, '.agentic', 'grafo', 'update-guard.cjs'));

const correr = (root, opts = {}) => update({ projectPath: root, salir: false, silent: true, __sinFuncional: true, ...opts });
/** Huella de TODO el proyecto salvo el estado propio del update (.agentic/_update). */
const huella = (root, { sinDb = false } = {}) => {
  const todo = legacy.huellaArbol(root, { sinBase: sinDb });
  for (const k of Object.keys(todo)) if (k.startsWith('.agentic/_update/')) delete todo[k];
  return todo;
};
const framework = (root) => Object.fromEntries(Object.entries(huella(root, { sinDb: true })).filter(([rel]) => manifest.esManaged(rel)));
const dbDe = (p) => path.join(p, '.agentic', 'memoria.db');

test('3.19.0 REAL → versión actual con UN comando: VERIFIED, memoria conservada por contenido, informe y respaldo', async () => {
  const p = legacy.proyectoReal('3.19.0', 'uno');
  const antes = real.inventario(p.dbPath);
  const r = await correr(p.root, { __sinFuncional: false });
  assert.equal(r.status, 'VERIFIED', JSON.stringify([r.errors, r.warnings, r.not_verified]));
  assert.equal(r.exit_code, 0);
  assert.equal(r.ok, true);
  assert.equal(r.versions.from, '3.19.0');
  assert.match(r.versions.to, /^3\.2\d\./);
  assert.equal(real.conservada(antes, p.dbPath).status, 'PASS');
  assert.equal(r.preservation.db.status, 'PASS');
  assert.equal(r.preservation.files.status, 'PASS');
  assert.equal(r.schema.after.status, 'COMPLETE');
  assert.ok(r.schema.migrations.applied.length >= 20, 'sin un segundo comando migrate');
  assert.ok(r.backup && backup.respaldoIntacto(r.backup) && r.backup.integrity === 'ok', 'respaldo VERIFICADO: abierto y con integrity_check');
  assert.deepEqual(r.functional.checks.map((c) => c.status), ['PASS', 'PASS', 'PASS', 'PASS'], JSON.stringify(r.functional.checks));
  // Informe local por operación + resumen de la última actualización.
  const ult = JSON.parse(fs.readFileSync(path.join(p.root, '.agentic', '_update', 'last-result.json'), 'utf8'));
  assert.equal(ult.status, 'VERIFIED');
  const informe = JSON.parse(fs.readFileSync(path.join(p.root, '.agentic', '_update', 'tx', r.op_id, 'verification.json'), 'utf8'));
  for (const campo of ['versions', 'source', 'schema', 'backup', 'integrity', 'preservation', 'files', 'functional', 'coverage', 'started_at', 'finished_at', 'duration_ms']) assert.ok(informe[campo] !== undefined, 'falta ' + campo);
  assert.match(informe.source.sha256, /^[0-9a-f]{64}$/);
  assert.ok(fs.existsSync(path.join(p.root, '.agentic', '_update', '.gitignore')), 'los respaldos de memoria no pueden acabar en el Git del proyecto');
  assert.ok(fs.existsSync(path.join(p.root, '.agentic', '_update', 'owned.json')));
});

test('3.20.0 REAL → versión actual: VERIFIED y la repetición es idempotente (NO_CHANGES_VERIFIED)', async () => {
  const p = legacy.proyectoReal('3.20.0', 'dos');
  const antes = real.inventario(p.dbPath);
  const r1 = await correr(p.root);
  assert.equal(r1.status, 'VERIFIED', JSON.stringify([r1.errors, r1.warnings]));
  assert.equal(real.conservada(antes, p.dbPath).status, 'PASS');
  const h1 = huella(p.root);
  const r2 = await correr(p.root);
  assert.equal(r2.status, 'NO_CHANGES_VERIFIED', JSON.stringify([r2.errors, r2.warnings]));
  assert.deepEqual(r2.escritos, [], 'segundo update idempotente');
  assert.equal(r2.schema.migrations.applied.length, 0);
  assert.deepEqual(huella(p.root), h1, 'no cambió ni un archivo (ni la base) en la repetición');
});

test('--check: inspección y plan SIN modificar el proyecto', async () => {
  const p = legacy.proyectoReal('3.19.0', 'check');
  const antes = legacy.huellaArbol(p.root);
  const r = await correr(p.root, { check: true });
  assert.equal(r.status, 'PLAN_READY');
  assert.equal(r.mode, 'check');
  assert.equal(r.exit_code, 0);
  assert.ok(r.plan.db.pending.length >= 20);
  assert.ok(r.plan.files.by_action.CREAR > 0 || r.plan.files.by_action.ESCRIBIR > 0);
  assert.deepEqual(legacy.huellaArbol(p.root), antes, 'ni un byte (ni siquiera .agentic/_update)');
  assert.ok(!fs.existsSync(path.join(p.root, '.agentic', '_update')));
  const hecho = await correr(p.root);
  assert.equal(hecho.ok, true);
  assert.equal((await correr(p.root, { check: true })).status, 'NO_CHANGES_NEEDED');
});

test('--no-migrate: advierte la incompatibilidad y NUNCA se presenta como completo', async () => {
  const p = legacy.proyectoReal('3.19.0', 'nomig');
  const antes = real.inventario(p.dbPath);
  const r = await correr(p.root, { noMigrate: true });
  assert.equal(r.status, 'UNVERIFIED');
  assert.equal(r.reason, 'SCHEMA_PENDING');
  assert.notEqual(r.exit_code, 0, 'exit 0 solo para un éxito verificable');
  assert.ok(r.not_verified.some((n) => /esquema/.test(n)));
  assert.equal(real.conservada(antes, p.dbPath).status, 'PASS');
  const db = dba.openReadOnly(p.dbPath);
  try { assert.equal(sc.inspect(db).status, 'PENDING', 'el esquema no se tocó'); } finally { db.close(); }
});

test('esquema MÁS NUEVO: BLOCKED, sin cambiar nada', async () => {
  const p = legacy.proyectoReal('3.20.0', 'nuevo');
  const w = dba.openWrite(p.dbPath, { updateOwner: true });
  try { sc.apply(w, { version: '3.20.1' }); w.run("INSERT INTO agentix_schema_migrations (id, checksum, introduced_in, level, applied_at, result) VALUES ('futuro', 'x', '9.9.9', 99, 'ya', 'APPLIED')"); } finally { w.close(); }
  const antes = huella(p.root);
  const r = await correr(p.root);
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.reason, 'NEWER_SCHEMA');
  assert.deepEqual(huella(p.root), antes);
});

test('base CORRUPTA o ilegible: BLOCKED antes de escribir nada', async () => {
  const basura = legacy.proyectoReal('3.20.0', 'basura');
  fs.writeFileSync(basura.dbPath, Buffer.from('esto no es una base SQLite '.repeat(300)));
  const a = huella(basura.root);
  const r = await correr(basura.root);
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.reason, 'DB_ILEGIBLE');
  assert.deepEqual(huella(basura.root), a);

  const cortada = legacy.proyectoReal('3.20.0', 'cortada');
  const bytes = fs.readFileSync(cortada.dbPath);
  fs.writeFileSync(cortada.dbPath, bytes.subarray(0, Math.floor(bytes.length / 2)));
  const b = huella(cortada.root);
  const r2 = await correr(cortada.root);
  assert.equal(r2.status, 'BLOCKED', JSON.stringify(r2.errors));
  assert.deepEqual(huella(cortada.root), b, 'una base truncada no se toca');
});

test('base TOMADA por un proceso externo que no respeta el protocolo: BLOCKED (DB_OCUPADA) sin aplicar nada', async () => {
  const p = legacy.proyectoReal('3.20.0', 'ocupada');
  const externo = spawn(process.execPath, ['-e', `const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(${JSON.stringify(p.dbPath)});d.exec('BEGIN IMMEDIATE');console.log('TOMADA');setTimeout(()=>{d.exec('ROLLBACK');process.exit(0)},15000)`], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  let s = ''; externo.stdout.on('data', (d) => { s += d; });
  try {
    for (let i = 0; i < 80 && !s.includes('TOMADA'); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(s.includes('TOMADA'));
    const antes = framework(p.root);
    const r = await correr(p.root, { busyMs: 300 });
    assert.equal(r.status, 'BLOCKED');
    assert.equal(r.reason, 'DB_OCUPADA');
    assert.deepEqual(framework(p.root), antes, 'ningún archivo del framework cambió');
  } finally { externo.kill(); }
});

test('dos updates SIMULTÁNEOS: uno aplica, el otro se bloquea; la base queda íntegra', async () => {
  const p = legacy.proyectoReal('3.19.0', 'dos-a-la-vez');
  const antes = real.inventario(p.dbPath);
  const script = `require(${JSON.stringify(path.join(REPO, 'src/update.js'))}).update({projectPath:${JSON.stringify(p.root)},salir:false,silent:true,__sinFuncional:true,lockTimeoutMs:150}).then(r=>{console.log('@@'+JSON.stringify({s:r.status,reason:r.reason}));process.exit(0)})`;
  const lanzar = () => new Promise((resolve) => {
    const c = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, NODE_NO_WARNINGS: '1' } });
    let o = ''; c.stdout.on('data', (d) => { o += d; }); c.on('exit', () => resolve(JSON.parse(o.split('@@').pop())));
  });
  const [a, b] = await Promise.all([lanzar(), lanzar()]);
  const estados = [a.s, b.s].sort();
  assert.ok(estados.includes('VERIFIED') || estados.includes('VERIFIED_WITH_WARNINGS'), 'uno aplicó: ' + JSON.stringify([a, b]));
  assert.ok([a, b].some((x) => x.s === 'BLOCKED' && /LOCK_TIMEOUT|RECUPERACION/.test(x.reason || '')) || estados.includes('NO_CHANGES_VERIFIED'), 'el otro se bloqueó o llegó después y no tenía nada que hacer: ' + JSON.stringify([a, b]));
  assert.equal(real.conservada(antes, p.dbPath).status, 'PASS');
  const db = dba.openReadOnly(p.dbPath);
  try { assert.equal(sc.inspect(db).status, 'COMPLETE'); assert.equal(db.get('PRAGMA integrity_check').integrity_check, 'ok'); } finally { db.close(); }
});

test('escritores con conexión persistente: el que confirma la pausa deja pasar; el que no, BLOQUEA antes de aplicar', async () => {
  // a) sin confirmación
  const p = legacy.proyectoReal('3.20.0', 'mudo');
  const mudo = spawn(process.execPath, ['-e', `const fs=require('fs'),path=require('path');const dir=${JSON.stringify(path.join(p.root, '.agentic', '_update', 'writers'))};fs.mkdirSync(dir,{recursive:true});
    const f=path.join(dir,process.pid+'-mudo.json');setInterval(()=>fs.writeFileSync(f,JSON.stringify({id:process.pid+'-mudo',name:'mcp-falso',pid:process.pid,host:require('os').hostname(),heartbeat_at:Date.now()})),100);console.log('LISTO')`], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  let s = ''; mudo.stdout.on('data', (d) => { s += d; });
  try {
    for (let i = 0; i < 60 && !s.includes('LISTO'); i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 500)); // deja que escriba su primer latido
    const antes = framework(p.root);
    const r = await correr(p.root, { writerAckMs: 700 });
    assert.equal(r.status, 'BLOCKED');
    assert.equal(r.reason, 'NO_PAUSE_ACK');
    assert.match(r.errors[0].message, /mcp-falso/);
    assert.deepEqual(framework(p.root), antes);
    assert.ok(!fs.existsSync(guard.archivoLock(p.root)), 'el bloqueo se liberó');
  } finally { mudo.kill(); }
  // b) con confirmación: un servicio real cierra su conexión y el update procede
  const q = legacy.proyectoReal('3.20.0', 'servicio');
  const servicio = spawn(process.execPath, ['-e', `const g=require(${JSON.stringify(path.join(REPO, '.agentic/grafo/update-guard.cjs'))});const a=require(${JSON.stringify(path.join(REPO, '.agentic/grafo/db-adapter.cjs'))});
    let db=a.openWrite(${JSON.stringify(q.dbPath)});g.registerWriter(${JSON.stringify(q.root)},'servicio',{intervaloMs:100,onPause:()=>{db.close();db=null;console.log('PAUSADO')}});console.log('LISTO');setTimeout(()=>process.exit(0),60000)`], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  let s2 = ''; servicio.stdout.on('data', (d) => { s2 += d; });
  try {
    for (let i = 0; i < 60 && !s2.includes('LISTO'); i++) await new Promise((r) => setTimeout(r, 100));
    const r = await correr(q.root, { writerAckMs: 5000 });
    assert.ok(r.ok, JSON.stringify([r.status, r.errors]));
    // La salida del hijo llega por una tubería asíncrona: puede tardar unos ms más que el propio update en verse.
    for (let i = 0; i < 30 && !s2.includes('PAUSADO'); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(s2.includes('PAUSADO'));
    assert.ok(r.coverage.verified.some((c) => /1 servicio\(s\) confirmaron la pausa/.test(c)));
  } finally { servicio.kill(); }
});

test('un escritor del motor que intenta abrir la base DURANTE la migración recibe UPDATE_IN_PROGRESS', async () => {
  const p = legacy.proyectoReal('3.20.0', 'durante');
  let resultadoHijo = null;
  const r = await correr(p.root, {
    __hooks: {
      antes_migracion: () => {
        const c = spawnSync(process.execPath, ['-e', `try{require(${JSON.stringify(path.join(REPO, '.agentic/grafo/db-adapter.cjs'))}).openWrite(${JSON.stringify(p.dbPath)}).close();console.log('ABIERTA')}catch(e){console.log(e.code)}`], { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1', AKDD_UPDATE_TOKEN: '' } });
        resultadoHijo = c.stdout.trim();
      },
    },
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(resultadoHijo, 'UPDATE_IN_PROGRESS');
});

test('migración que FALLA: ROLLED_BACK verificado — archivos y datos recuperados', async () => {
  const p = legacy.proyectoReal('3.19.0', 'falla');
  const w = dba.openWrite(p.dbPath, { updateOwner: true });
  try {
    // event_id ya existe y está duplicado: el índice único de 3.20 no puede crearse (decisión humana, no del update).
    w.exec('ALTER TABLE gate_events ADD COLUMN event_id TEXT');
    w.run("INSERT INTO gate_events (gate, verdict, event_id) VALUES ('g', 'PASS', 'dup')");
    w.run("INSERT INTO gate_events (gate, verdict, event_id) VALUES ('g', 'PASS', 'dup')");
  } finally { w.close(); }
  const antesArch = framework(p.root);
  const antesDb = real.inventario(p.dbPath);
  const r = await correr(p.root);
  assert.equal(r.status, 'ROLLED_BACK', JSON.stringify([r.errors, r.recovery]));
  assert.equal(r.exit_code, 3);
  assert.equal(r.reason, 'DATOS_DUPLICADOS');
  assert.equal(r.recovery.verified, true);
  assert.ok(r.recovery.files.reverted > 0);
  assert.equal(r.recovery.db.state, 'UNCHANGED', 'la transacción de BD revirtió sola');
  assert.deepEqual(framework(p.root), antesArch, 'el framework volvió EXACTAMENTE a lo anterior');
  assert.equal(real.conservada(antesDb, p.dbPath).status, 'PASS');
  assert.ok(backup.respaldoIntacto(r.recovery.backup ? { path: r.recovery.backup, sha256: r.backup.sha256 } : r.backup), 'el respaldo sigue ahí');
  const j = JSON.parse(fs.readFileSync(path.join(p.root, '.agentic', '_update', 'tx', r.op_id, 'journal.json'), 'utf8'));
  assert.equal(j.fase, 'REVERTIDO');
  assert.ok(j.historial.some((h) => h.fase === 'RESPALDO_VERIFICADO'), 'el journal registró las fases');
});

for (const punto of ['tras_respaldo', 'tras_archivos', 'antes_migracion', 'tras_migracion', 'tras_validacion']) {
  test(`interrupción en "${punto}": se recupera de forma determinista y verificada`, async () => {
    const p = legacy.proyectoReal('3.19.0', 'int-' + punto);
    const antesArch = framework(p.root);
    const antesDb = real.inventario(p.dbPath);
    const r = await correr(p.root, { __fallar: punto });
    assert.equal(r.status, 'ROLLED_BACK', JSON.stringify([r.errors, r.recovery]));
    assert.equal(r.reason, 'FALLO_INYECTADO');
    assert.deepEqual(framework(p.root), antesArch, 'archivos de vuelta');
    assert.equal(real.conservada(antesDb, p.dbPath).status, 'PASS', 'datos intactos');
    const migrada = ['tras_migracion', 'tras_validacion'].includes(punto);
    assert.equal(r.recovery.db.state, migrada ? 'MIGRATED_KEPT_COMPATIBLE' : 'UNCHANGED');
    // y se puede volver a actualizar sin quedar a medias
    const otra = await correr(p.root);
    assert.ok(otra.ok, JSON.stringify([otra.status, otra.errors]));
    assert.equal(real.conservada(antesDb, p.dbPath).status, 'PASS');
  });
}

test('el proceso MUERE a mitad (process.exit): la siguiente corrida recupera antes de seguir', async () => {
  const p = legacy.proyectoReal('3.19.0', 'muerte');
  const antesArch = framework(p.root);
  const antesDb = real.inventario(p.dbPath);
  const c = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(REPO, 'src/update.js'))}).update({projectPath:${JSON.stringify(p.root)},salir:false,silent:true,__sinFuncional:true,__hooks:{tras_archivos:()=>process.exit(9)}})`], { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  assert.equal(c.status, 9, 'el proceso murió en mitad de la aplicación');
  assert.notDeepEqual(framework(p.root), antesArch, 'quedó a medias de verdad');
  assert.ok(fs.existsSync(guard.archivoLock(p.root)), 'dejó su bloqueo');
  // El bloqueo de un proceso muerto se recupera por latido vencido; aquí se acelera.
  const lock = JSON.parse(fs.readFileSync(guard.archivoLock(p.root), 'utf8'));
  lock.heartbeat_at = Date.now() - 600000;
  fs.writeFileSync(guard.archivoLock(p.root), JSON.stringify(lock));
  const r = await correr(p.root);
  assert.ok(r.ok, JSON.stringify([r.status, r.errors, r.warnings]));
  assert.equal(r.recovered_previous.length, 1);
  assert.equal(r.recovered_previous[0].fase_al_morir, 'APLICANDO');
  assert.equal(real.conservada(antesDb, p.dbPath).status, 'PASS');
});

test('edición EXTERNA durante la aplicación: la recuperación NO la sobrescribe a ciegas', async () => {
  const p = legacy.proyectoReal('3.19.0', 'externa');
  const editado = path.join(p.root, '.agentic', 'grafo', 'post-cycle.cjs'); // un archivo (no esencial) que el update SÍ reescribe de 3.19 a la actual
  let textoEditado = null;
  const r = await correr(p.root, {
    __hooks: { tras_archivos: () => { fs.appendFileSync(editado, '\n<!-- nota de una persona mientras corría el update -->\n'); textoEditado = fs.readFileSync(editado, 'utf8'); } },
    __fallar: 'tras_migracion',
  });
  assert.equal(r.status, 'RECOVERY_REQUIRED', JSON.stringify([r.errors, r.recovery]));
  assert.equal(r.exit_code, 4);
  assert.equal(r.recovery.files.conflicts.length >= 1, true);
  assert.equal(fs.readFileSync(editado, 'utf8'), textoEditado, 'lo que escribió la persona sigue ahí');
  // Mientras haya una recuperación pendiente, un nuevo update se detiene.
  const siguiente = await correr(p.root);
  assert.equal(siguiente.status, 'BLOCKED');
  assert.equal(siguiente.reason, 'RECUPERACION_PENDIENTE');
  assert.equal(r.recovery.journal && fs.existsSync(r.recovery.journal), true);
});

test('espacio insuficiente y carpeta no escribible: se detiene ANTES de empezar', async () => {
  const p = legacy.proyectoReal('3.20.0', 'entorno');
  const original = fs.statfsSync;
  fs.statfsSync = () => ({ bavail: 1, bsize: 4096 });
  try {
    const r = backup.comprobarEntorno({ projectPath: p.root, dbPath: p.dbPath });
    assert.equal(r.ok, false);
    assert.equal(r.problemas[0].code, 'DISCO_INSUFICIENTE');
    const a = await correr(p.root);
    assert.equal(a.status, 'BLOCKED');
    assert.equal(a.reason, 'DISCO_INSUFICIENTE');
  } finally { fs.statfsSync = original; }
  const q = legacy.proyectoReal('3.20.0', 'noescribible');
  fs.writeFileSync(path.join(q.root, '.agentic', '_update'), 'esto es un archivo, no una carpeta');
  const antes = framework(q.root);
  const b = await correr(q.root);
  assert.equal(b.status, 'BLOCKED');
  assert.deepEqual(framework(q.root), antes);
});

test('conectores nativos: sin ninguno apto el update se detiene y explica cómo resolverlo', async () => {
  const p = legacy.proyectoReal('3.20.0', 'driver');
  const antes = huella(p.root);
  const r = await correr(p.root, { __driverCandidates: ['better-sqlite3', 'sqljs'] });
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.reason, 'DRIVER_NO_APTO');
  assert.match(r.errors[0].message, /node:sqlite|better-sqlite3/);
  assert.deepEqual(huella(p.root), antes);
});

test('personalizaciones: un archivo del framework con cambios propios se CONSERVA y la versión nueva queda aparte', async () => {
  const p = legacy.proyectoReal('3.19.0', 'personal');
  const propio = path.join(p.root, '.agentic', 'agentes', '01-orquestador.md');
  fs.appendFileSync(propio, '\n## Regla de mi equipo\nNo desplegar los viernes.\n');
  const contenidoPropio = fs.readFileSync(propio, 'utf8');
  fs.mkdirSync(path.join(p.root, '.cursor', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(p.root, '.cursor', 'rules', 'mia.mdc'), 'regla adicional del usuario');
  fs.mkdirSync(path.join(p.root, '.audit'), { recursive: true });
  fs.writeFileSync(path.join(p.root, '.audit', 'extra.md'), 'auditoría propia');
  fs.writeFileSync(path.join(p.root, '.agentic', 'protected_files'), '.agentic/agentes/05-qa.md\n');
  const qa = fs.readFileSync(path.join(p.root, '.agentic', 'agentes', '05-qa.md'), 'utf8');
  const r = await correr(p.root);
  assert.equal(r.status, 'VERIFIED_WITH_WARNINGS', JSON.stringify([r.errors, r.warnings]));
  assert.equal(fs.readFileSync(propio, 'utf8'), contenidoPropio, 'el archivo personalizado queda como estaba');
  const aparte = r.files.preserved.find((x) => x.file === '.agentic/agentes/01-orquestador.md');
  assert.ok(aparte, 'se informa el conflicto');
  assert.ok(fs.existsSync(path.join(p.root, aparte.new_version)), 'y la versión nueva se guarda aparte');
  assert.equal(fs.readFileSync(path.join(p.root, '.cursor', 'rules', 'mia.mdc'), 'utf8'), 'regla adicional del usuario');
  assert.equal(fs.readFileSync(path.join(p.root, '.audit', 'extra.md'), 'utf8'), 'auditoría propia');
  assert.equal(fs.readFileSync(path.join(p.root, '.agentic', 'agentes', '05-qa.md'), 'utf8'), qa, 'lo protegido no se toca');
  assert.ok(r.files.protected.includes('.agentic/agentes/05-qa.md'));
});

test('un archivo INDISPENSABLE del motor personalizado: BLOCKED antes de aplicar (nada de motor a medias)', async () => {
  const p = legacy.proyectoReal('3.19.0', 'esencial');
  fs.appendFileSync(path.join(p.root, '.agentic', 'grafo', 'grafo.cjs'), '\n// parche local de mi equipo\n');
  const antes = huella(p.root);
  const r = await correr(p.root);
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.reason, 'ESENCIAL_CONSERVADO');
  assert.match(r.errors[0].message, /indispensable/);
  assert.deepEqual(huella(p.root), antes, 'no se aplicó NADA');
});

test('paquete incompleto: BLOCKED y sin tocar el proyecto', async () => {
  const p = legacy.proyectoReal('3.20.0', 'incompleto');
  const bundle = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-bundle-roto-'));
  fs.cpSync(path.join(REPO, '.agentic'), path.join(bundle, '.agentic'), { recursive: true, filter: (s) => !/[\\/](vendor|graph-ui)([\\/]|$)/.test(s) });
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(bundle, 'package.json'));
  fs.rmSync(path.join(bundle, '.agentic', 'grafo', 'grafo.cjs'));
  const antes = huella(p.root);
  const r = await correr(p.root, { bundleRoot: bundle });
  assert.equal(r.status, 'BLOCKED');
  assert.match(r.reason, /BUNDLE_INVALIDO|STAGING_INVALIDO/);
  assert.deepEqual(huella(p.root), antes);
});

test('rutas con espacios, acentos y eñes', async () => {
  const p = legacy.proyectoReal('3.20.0', 'ruta');
  const destino = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-')), 'Mi Proyecto ñandú — prueba');
  fs.cpSync(p.root, destino, { recursive: true });
  const antes = real.inventario(dbDe(destino));
  const r = await correr(destino);
  assert.equal(r.status, 'VERIFIED', JSON.stringify(r.errors));
  assert.equal(real.conservada(antes, dbDe(destino)).status, 'PASS');
});

test('rollback POSTERIOR con aprendizajes nuevos: revierte archivos, conserva la memoria y el motor anterior la lee', async () => {
  const p = legacy.proyectoReal('3.19.0', 'rollback');
  const frameworkAntes = framework(p.root);
  const r = await correr(p.root);
  assert.ok(r.ok);
  // Días después: el motor nuevo aprendió cosas.
  const w = dba.openWrite(p.dbPath, { updateOwner: true });
  try { for (let i = 0; i < 5; i++) w.run("INSERT INTO nodos (tipo, titulo, contenido, area, confianza) VALUES ('patron', ?, 'aprendido después', 'auth', 'MEDIA')", ['APRENDIDO_' + i]); } finally { w.close(); }
  const antesRows = (() => { const d = dba.openReadOnly(p.dbPath); try { return d.get('SELECT count(*) AS n FROM nodos').n; } finally { d.close(); } })();
  const rb = rollback({ projectPath: p.root, silent: true });
  assert.equal(rb.status, 'ROLLED_BACK', JSON.stringify(rb.errors));
  assert.equal(rb.ok, true);
  assert.equal(rb.recovery.db.state, 'UNTOUCHED');
  assert.deepEqual(framework(p.root), frameworkAntes, 'los archivos volvieron EXACTAMENTE a los de 3.19.0 (incluso se retiró el framework.json que 3.19.0 no traía)');
  const d = dba.openReadOnly(p.dbPath);
  try { assert.equal(d.get('SELECT count(*) AS n FROM nodos').n, antesRows, 'los aprendizajes nuevos siguen ahí (no se restauró una base vieja)'); } finally { d.close(); }
  // El motor 3.19.0 de vuelta SÍ puede leer la base migrada (cambios aditivos).
  const motorViejo = spawnSync(process.execPath, [path.join(p.root, '.agentic', 'grafo', 'grafo.cjs'), 'stats'], { cwd: p.root, encoding: 'utf8', timeout: 60000, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  assert.equal(motorViejo.status, 0, motorViejo.stderr);
});

test('rollback BLOQUEADO si el esquema cambió después de esa actualización', async () => {
  const p = legacy.proyectoReal('3.20.0', 'rollback-bloq');
  assert.ok((await correr(p.root)).ok);
  const w = dba.openWrite(p.dbPath, { updateOwner: true });
  try { w.run("INSERT INTO agentix_schema_migrations (id, checksum, introduced_in, level, applied_at, result) VALUES ('posterior', 'x', '3.99.0', 7, 'ya', 'APPLIED')"); w.run("INSERT OR REPLACE INTO agentix_schema_meta (key, value) VALUES ('level', '7')"); } finally { w.close(); }
  const antes = huella(p.root);
  const rb = rollback({ projectPath: p.root, silent: true });
  assert.equal(rb.status, 'BLOCKED');
  assert.equal(rb.reason, 'ESQUEMA_POSTERIOR');
  assert.deepEqual(huella(p.root), antes, 'ni un archivo ni la memoria cambiaron');
});

test('el paquete npm no lleva memoria, respaldos ni evidencia privada', () => {
  const out = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], { cwd: REPO, encoding: 'utf8', shell: process.platform === 'win32' });
  const lista = JSON.parse(out.stdout)[0].files.map((f) => f.path);
  assert.deepEqual(lista.filter((f) => /memoria\.db|\.bak|_update|backups\/|verification\.json|last-result/.test(f)), []);
  assert.ok(lista.includes('.agentic/grafo/schema-catalog.cjs') && lista.includes('src/update-run.js') && lista.includes('src/release-manifests.json'));
});
