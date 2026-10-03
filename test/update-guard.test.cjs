'use strict';
/* Exclusión de escritores y capacidades reales del adaptador (3.20.1). */
const test = require('node:test');
const { SIN_DRIVER } = require('./helpers/db-real.cjs');
if (SIN_DRIVER) { require('node:test').test(require('node:path').basename(__filename) + ' (omitido: ' + SIN_DRIVER + ')', { skip: SIN_DRIVER }, () => {}); return; }
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');

const real = require('./helpers/db-real.cjs');
const { dba, REPO } = real;
const guard = require(path.join(REPO, '.agentic', 'grafo', 'update-guard.cjs'));

const proyecto = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-guard-'));
  real.crearBase(path.join(root, '.agentic', 'memoria.db'), { propias: false });
  return fs.realpathSync(root);
};
const hijo = (codigo, env, cwd) => spawnSync(process.execPath, ['-e', codigo], { cwd: cwd || REPO, env: { ...process.env, NODE_NO_WARNINGS: '1', ...env }, encoding: 'utf8', timeout: 30000 });
const pidMuerto = () => { const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }); return Number(r.stdout); };

test('bloqueo: se toma con apertura exclusiva y un segundo update espera y falla con LOCK_TIMEOUT', () => {
  const root = proyecto();
  const a = guard.acquire(root, { opId: 'uno', timeoutMs: 200 });
  try {
    assert.ok(fs.existsSync(guard.archivoLock(root)));
    const lock = JSON.parse(fs.readFileSync(guard.archivoLock(root), 'utf8'));
    assert.equal(lock.op_id, 'uno');
    assert.equal(lock.pid, process.pid);
    assert.equal(lock.root, guard.canonica(root), 'se guarda la raíz CANÓNICA del proyecto');
    assert.ok(lock.token && lock.heartbeat_at && lock.started_at);
    assert.throws(() => guard.acquire(root, { opId: 'dos', timeoutMs: 300 }), (e) => e.code === 'LOCK_TIMEOUT' && e.holder.op_id === 'uno');
  } finally { guard.release(a); }
  assert.ok(!fs.existsSync(guard.archivoLock(root)), 'al soltarlo desaparece');
  const b = guard.acquire(root, { opId: 'tres', timeoutMs: 200 });
  guard.release(b);
});

test('bloqueo: dos PROCESOS a la vez — solo uno lo toma', async () => {
  const root = proyecto();
  const script = `const g=require(${JSON.stringify(path.join(REPO, '.agentic/grafo/update-guard.cjs'))});
    try{const h=g.acquire(${JSON.stringify(root)},{opId:process.argv[1],timeoutMs:100});console.log('TOMADO');setTimeout(()=>{g.release(h);process.exit(0)},1500)}
    catch(e){console.log(e.code);process.exit(0)}`;
  const lanzar = (id) => new Promise((resolve) => {
    const p = spawn(process.execPath, ['-e', script, id], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, NODE_NO_WARNINGS: '1' } });
    let out = ''; p.stdout.on('data', (d) => { out += d; }); p.on('exit', () => resolve(out.trim()));
  });
  const r = await Promise.all([lanzar('a'), lanzar('b')]);
  assert.deepEqual(r.slice().sort(), ['LOCK_TIMEOUT', 'TOMADO']);
});

test('bloqueo: uno ABANDONADO (dueño muerto, sin latido) se recupera; uno vivo no', () => {
  const root = proyecto();
  fs.mkdirSync(guard.dirUpdate(root), { recursive: true });
  const escribir = (extra) => fs.writeFileSync(guard.archivoLock(root), JSON.stringify({ schema: 1, op_id: 'zombi', token: 't', pid: pidMuerto(), host: os.hostname(), root: guard.canonica(root), started_at: 'x', heartbeat_at: Date.now() - 60000, ttl_ms: 30000, phase: 'apply', ...extra }));
  escribir({});
  assert.equal(guard.estado(root).stale, true);
  const h = guard.acquire(root, { opId: 'nuevo', timeoutMs: 500 });
  guard.release(h);
  assert.ok(fs.readdirSync(guard.dirUpdate(root)).some((n) => n.startsWith('lock.abandonado.')), 'el bloqueo viejo se aparta (no se borra), queda como evidencia');

  // PID reutilizado: el proceso EXISTE (somos nosotros) pero el latido venció → no es el dueño real.
  escribir({ pid: process.pid, heartbeat_at: Date.now() - 120000 });
  assert.equal(guard.estado(root).stale, true, 'un PID vivo con el latido vencido se recupera: el latido manda, no el PID');
  fs.rmSync(guard.archivoLock(root));

  // Vivo y con latido reciente: no se toca.
  escribir({ pid: process.pid, heartbeat_at: Date.now() });
  assert.equal(guard.estado(root).held, true);
  assert.throws(() => guard.acquire(root, { opId: 'otro', timeoutMs: 200 }), (e) => e.code === 'LOCK_TIMEOUT');
});

test('bloqueo: otra raíz canónica no se pisa; solo el dueño lo suelta', () => {
  const root = proyecto();
  fs.mkdirSync(guard.dirUpdate(root), { recursive: true });
  fs.writeFileSync(guard.archivoLock(root), JSON.stringify({ schema: 1, op_id: 'ajeno', token: 'x', pid: process.pid, host: os.hostname(), root: 'c:\\otro\\proyecto', heartbeat_at: Date.now(), ttl_ms: 30000, phase: 'apply' }));
  assert.throws(() => guard.acquire(root, { timeoutMs: 100 }), (e) => e.code === 'LOCK_ROOT_MISMATCH');
  fs.rmSync(guard.archivoLock(root));
  const mio = guard.acquire(root, { opId: 'mio', timeoutMs: 100 });
  assert.equal(guard.release({ ...mio, token: 'robado' }), false, 'otro token no puede liberar');
  assert.ok(fs.existsSync(guard.archivoLock(root)));
  assert.equal(guard.release(mio), true);
});

test('escritores: con un update vivo, openWrite de OTRO proceso falla con UPDATE_IN_PROGRESS; con el token pasa; leer siempre se puede', () => {
  const root = proyecto();
  const db = path.join(root, '.agentic', 'memoria.db');
  const h = guard.acquire(root, { opId: 'activo', timeoutMs: 100 });
  try {
    const adaptador = JSON.stringify(path.join(REPO, '.agentic/grafo/db-adapter.cjs'));
    const abrir = `const a=require(${adaptador});try{a.openWrite(${JSON.stringify(db)}).close();console.log('ABIERTA')}catch(e){console.log(e.code)}`;
    assert.equal(hijo(abrir, {}).stdout.trim(), 'UPDATE_IN_PROGRESS');
    assert.equal(hijo(abrir, { AKDD_UPDATE_TOKEN: h.token }).stdout.trim(), 'ABIERTA', 'el propio actualizador sí');
    assert.equal(hijo(`const a=require(${adaptador});a.openReadOnly(${JSON.stringify(db)}).close();console.log('LEIDA')`, {}).stdout.trim(), 'LEIDA');
  } finally { guard.release(h); }
  assert.equal(hijo(`const a=require(${JSON.stringify(path.join(REPO, '.agentic/grafo/db-adapter.cjs'))});a.openWrite(${JSON.stringify(db)}).close();console.log('ABIERTA')`, {}).stdout.trim(), 'ABIERTA', 'sin update, normal');
});

test('servicios con conexión persistente: pausan, cierran y CONFIRMAN; el que no confirma bloquea', async () => {
  const root = proyecto();
  // Un servicio de verdad en otro proceso: al ver el bloqueo cierra su conexión y deja el ack.
  const servicio = spawn(process.execPath, ['-e', `
    const g=require(${JSON.stringify(path.join(REPO, '.agentic/grafo/update-guard.cjs'))});
    const a=require(${JSON.stringify(path.join(REPO, '.agentic/grafo/db-adapter.cjs'))});
    let db=a.openWrite(${JSON.stringify(path.join(root, '.agentic', 'memoria.db'))});
    g.registerWriter(${JSON.stringify(root)},'servicio-prueba',{intervaloMs:100,onPause:()=>{db.close();db=null;console.log('PAUSADO')},onResume:()=>console.log('REANUDADO')});
    console.log('LISTO');setTimeout(()=>process.exit(0),20000);`], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  let salida = ''; servicio.stdout.on('data', (d) => { salida += d; });
  try {
    for (let i = 0; i < 60 && !salida.includes('LISTO'); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(salida.includes('LISTO'));
    const h = guard.acquire(root, { opId: 'op1', timeoutMs: 100 });
    try {
      const w = await guard.waitForWriters(root, 'op1', 5000);
      assert.equal(w.ok, true, JSON.stringify(w));
      assert.equal(w.acked.length, 1);
      // El ack se escribe antes de que el «PAUSADO» del servicio llegue por la tubería: se espera a que llegue, no se lee al instante.
      for (let i = 0; i < 60 && !salida.includes('PAUSADO'); i++) await new Promise((r) => setTimeout(r, 100));
      assert.ok(salida.includes('PAUSADO'), 'el servicio cerró su conexión');
    } finally { guard.release(h); }
    for (let i = 0; i < 60 && !salida.includes('REANUDADO'); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(salida.includes('REANUDADO'), 'al terminar el update el servicio se reanuda solo');
  } finally { servicio.kill(); }

  // Un escritor vivo que NO confirma la pausa: el actualizador debe detenerse.
  const mudo = spawn(process.execPath, ['-e', `
    const fs=require('fs'),path=require('path');
    const dir=${JSON.stringify(path.join(root, '.agentic', '_update', 'writers'))};fs.mkdirSync(dir,{recursive:true});
    const f=path.join(dir,process.pid+'-mudo.json');
    setInterval(()=>fs.writeFileSync(f,JSON.stringify({id:process.pid+'-mudo',name:'mudo',pid:process.pid,host:require('os').hostname(),heartbeat_at:Date.now()})),100);
    console.log('LISTO');`], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  let s2 = ''; mudo.stdout.on('data', (d) => { s2 += d; });
  try {
    for (let i = 0; i < 60 && !s2.includes('LISTO'); i++) await new Promise((r) => setTimeout(r, 100));
    // Con la máquina cargada (la suite corre en paralelo) el primer latido puede tardar: se espera a que EXISTA, no un tiempo fijo.
    const dirEscritores = path.join(root, '.agentic', '_update', 'writers');
    for (let i = 0; i < 100 && !(fs.existsSync(dirEscritores) && fs.readdirSync(dirEscritores).some((n) => n.endsWith('-mudo.json'))); i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 300));
    const w = await guard.waitForWriters(root, 'op2', 700);
    assert.equal(w.ok, false);
    assert.equal(w.sinAck[0].name, 'mudo');
  } finally { mudo.kill(); }
});

test('adaptador: node:sqlite supera TODAS las pruebas reales; un conector ausente o sql.js no sirven para actualizar', () => {
  const ok = dba.probeCapabilities('node:sqlite');
  assert.equal(ok.ok, true, JSON.stringify(ok.failed));
  for (const c of ['driver', 'bigint', 'blob', 'transacciones', 'backup_con_wal', 'readonly', 'bloqueo', 'multiproceso', 'cierre']) assert.equal(ok.checks[c], true, c);
  const ausente = dba.probeCapabilities('better-sqlite3');
  if (!ausente.ok) assert.match(ausente.failed.join(' '), /disponible|better-sqlite3/, 'si no está instalado, se dice por qué');
  const sqljs = dba.probeCapabilities('sqljs');
  assert.equal(sqljs.ok, false, 'sql.js reexporta el archivo completo desde memoria: no protege una actualización concurrente');
  assert.equal(dba.selectDriverForUpdate(['sqljs']).driver, null);
  assert.equal(dba.selectDriverForUpdate(['better-sqlite3', 'node:sqlite']).driver !== null, true);
});

test('adaptador: INTEGER de 64 bits, BLOB y respaldo con commits en WAL', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-ad-')), 'x.db');
  const w = dba.open(f, { updateOwner: true });
  try {
    w.exec('PRAGMA journal_mode = WAL');
    w.exec('CREATE TABLE t (n INTEGER, b BLOB)');
    w.run('INSERT INTO t VALUES (?, ?)', [9223372036854775807n, Buffer.from([255, 0, 7])]);
    const fila = [...w.iterate('SELECT n FROM t', undefined, { bigints: true })][0];
    assert.equal(fila.n, 9223372036854775807n);
    const copia = f + '.copia';
    w.backupTo(copia);
    const r = dba.openReadOnly(copia);
    try { assert.equal(r.get('SELECT count(*) AS n FROM t').n, 1, 'el respaldo incluye lo que aún estaba en el -wal'); } finally { r.close(); }
    assert.throws(() => w.backupTo(copia), (e) => e.code === 'BACKUP_EXISTE', 'nunca pisa un respaldo');
  } finally { w.close(); }
});
