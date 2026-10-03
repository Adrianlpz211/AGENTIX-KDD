'use strict';
/* Casos restantes de la lista de 3.20.1: WAL, retención, respaldo alterado, enlaces fuera del proyecto. */
const test = require('node:test');
const { SIN_DRIVER } = require('./helpers/db-real.cjs');
if (SIN_DRIVER) { test(require('node:path').basename(__filename) + ' (omitido: ' + SIN_DRIVER + ')', { skip: SIN_DRIVER }, () => {}); return; }
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const legacy = require('./helpers/legacy-real.cjs');
const real = require('./helpers/db-real.cjs');
const { update } = require('../src/update.js');
const backup = require('../src/update-backup.js');
const manifest = require('../src/managed-manifest.js');
const { dba, REPO } = real;

const correr = (root, opts = {}) => update({ projectPath: root, salir: false, silent: true, __sinFuncional: true, ...opts });
const nodos = (dbPath) => { const d = dba.openReadOnly(dbPath); try { return d.get('SELECT count(*) AS n FROM nodos').n; } finally { d.close(); } };

test('commits que SOLO viven en el -wal: el respaldo los incluye y el update los conserva', async () => {
  const p = legacy.proyectoReal('3.20.0', 'wal');
  const antes = nodos(p.dbPath);
  // Un proceso escribe en modo WAL y MUERE sin cerrar ni hacer checkpoint: los commits quedan solo en el -wal.
  const c = spawnSync(process.execPath, ['-e', `const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(${JSON.stringify(p.dbPath)});d.exec('PRAGMA journal_mode=WAL');d.exec('PRAGMA wal_autocheckpoint=0');
    for(let i=0;i<6;i++)d.prepare("INSERT INTO nodos (tipo,titulo,contenido,area,confianza) VALUES ('patron',?,'solo en el wal','wal','MEDIA')").run('WAL_'+i);process.exit(0)`], { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  assert.equal(c.status, 0, c.stderr);
  assert.ok(fs.existsSync(p.dbPath + '-wal') && fs.statSync(p.dbPath + '-wal').size > 0, 'hay commits en el -wal');
  assert.equal(nodos(p.dbPath), antes + 6, 'una lectura normal ya los ve');
  const inventario = real.inventario(p.dbPath);
  const r = await correr(p.root);
  assert.equal(r.status, 'VERIFIED', JSON.stringify([r.errors, r.warnings]));
  const verificado = dba.openReadOnly(r.backup.path);
  try { assert.equal(verificado.get('SELECT count(*) AS n FROM nodos').n, antes + 6, 'el respaldo (VACUUM INTO) incluye lo que solo estaba en el -wal'); } finally { verificado.close(); }
  assert.equal(nodos(p.dbPath), antes + 6, 'y el update no perdió ninguno');
  assert.equal(real.conservada(inventario, p.dbPath).status, 'PASS');
});

test('retención: jamás borra el respaldo en curso, el último verificado, uno en investigación ni el de una transacción abierta', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-ret-'));
  const base = backup.dirBackups(root);
  const ids = ['2026-01-a', '2026-02-b', '2026-03-c', '2026-04-d', '2026-05-e', '2026-06-f'];
  for (const id of ids) { fs.mkdirSync(path.join(base, id), { recursive: true }); fs.writeFileSync(path.join(base, id, 'memoria.db'), id); fs.writeFileSync(path.join(base, id, 'meta.json'), JSON.stringify({ op_id: id })); }
  fs.writeFileSync(path.join(base, '2026-02-b', '.keep'), 'investigar');
  fs.mkdirSync(path.join(root, '.agentic', '_update', 'tx', '2026-03-c'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agentic', '_update', 'tx', '2026-03-c', 'journal.json'), JSON.stringify({ estado: 'aplicando', op_id: '2026-03-c' }));
  const borrados = backup.podarRespaldos(root, { conservar: 1, activos: ['2026-05-e'] });
  const quedan = fs.readdirSync(base).sort();
  for (const protegido of ['2026-02-b', '2026-03-c', '2026-05-e', '2026-06-f']) assert.ok(quedan.includes(protegido), protegido + ' debía conservarse');
  assert.deepEqual(borrados.sort(), ['2026-01-a', '2026-04-d']);
});

test('respaldo alterado o no verificable: no se restaura ni se da por bueno', () => {
  const p = legacy.proyectoReal('3.20.0', 'resp');
  const sc = require(path.join(REPO, '.agentic', 'grafo', 'schema-catalog.cjs'));
  const meta = backup.crearRespaldoDb({ adapter: dba, catalog: sc, driver: 'node-sqlite', dbPath: p.dbPath, projectPath: p.root, opId: 'op-resp' });
  assert.equal(backup.respaldoIntacto(meta), true);
  assert.equal(meta.integrity, 'ok');
  const bytes = fs.readFileSync(meta.path);
  fs.writeFileSync(meta.path, Buffer.concat([bytes.subarray(0, bytes.length - 8), Buffer.from('ALTERADO')]));
  assert.equal(backup.respaldoIntacto(meta), false, 'el hash ya no coincide');
  assert.throws(() => backup.restaurarDesdeRespaldo({ projectPath: p.root, dbPath: p.dbPath, meta, opId: 'op-resp' }), (e) => e.code === 'RESPALDO_ALTERADO');
  assert.ok(fs.existsSync(p.dbPath), 'la base original sigue donde estaba');
  // Un adaptador cuyo respaldo sale ilegible: NO se continúa.
  const adaptadorRoto = Object.assign({}, dba, { openReadOnly: (f, o) => { const d = dba.openReadOnly(f, o); if (!/op-roto/.test(f)) return d; return d; } });
  const roto = Object.assign({}, adaptadorRoto, { openReadOnly: (f, o) => { const d = dba.openReadOnly(f, o); return Object.assign(Object.create(d), { backupTo: (dest) => { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, Buffer.from('basura '.repeat(500))); return dest; }, close: () => d.close() }); } });
  assert.throws(() => backup.crearRespaldoDb({ adapter: roto, catalog: sc, driver: 'node-sqlite', dbPath: p.dbPath, projectPath: p.root, opId: 'op-roto' }));
  assert.ok(nodos(p.dbPath) > 0, 'la base real no se tocó');
});

test('un enlace/junction del proyecto que apunta FUERA: BLOCKED, y no se escribe fuera del proyecto', async () => {
  const p = legacy.proyectoReal('3.19.0', 'enlace');
  const fuera = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-fuera-'));
  const agentes = path.join(p.root, '.agentic', 'agentes');
  fs.cpSync(agentes, fuera, { recursive: true });
  fs.rmSync(agentes, { recursive: true, force: true });
  fs.symlinkSync(fuera, agentes, process.platform === 'win32' ? 'junction' : 'dir');
  const huellaFuera = () => legacy.huellaArbol(fuera);
  const antes = huellaFuera();
  const r = await correr(p.root);
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.reason, 'ENLACE_FUERA_DEL_PROYECTO');
  assert.match(r.errors[0].message, /fuera del proyecto/);
  assert.deepEqual(huellaFuera(), antes, 'nada se escribió a través del enlace');
});

test('owned.json declara qué significa cada hash', async () => {
  const p = legacy.proyectoReal('3.20.0', 'owned');
  assert.ok((await correr(p.root)).ok);
  const owned = JSON.parse(fs.readFileSync(path.join(p.root, '.agentic', '_update', 'owned.json'), 'utf8'));
  assert.match(owned.semantica.archivos, /tal como Agentix lo dej/);
  assert.match(owned.semantica.sha256, /paquete/);
  assert.ok(Object.keys(owned.archivos).length > 100);
  for (const rel of Object.keys(owned.archivos)) assert.ok(manifest.esManaged(rel), rel + ' no es un archivo del framework');
});

// ── verificación funcional: la búsqueda solo exige lo que recall puede devolver ──
const marcar = (dbPath, sql) => { const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(dbPath); try { d.exec(sql); } finally { d.close(); } };

test('búsqueda funcional: sin nodos recuperables por recall no es un fallo, es una advertencia honesta', async () => {
  const p = legacy.proyectoReal('3.20.0', 'busq-historica');
  marcar(p.dbPath, "UPDATE nodos SET vigencia_tipo = 'HISTORICO'");
  const r = await update({ projectPath: p.root, salir: false, silent: true });
  assert.equal(r.status, 'VERIFIED_WITH_WARNINGS', JSON.stringify([r.errors, r.warnings, r.not_verified]));
  const b = r.functional.checks.find((c) => c.name === 'busqueda_real');
  assert.equal(b.status, 'PASS');
  assert.ok(r.warnings.some((w) => /recuperables por recall/.test(w)), 'lo dice: no se pudo probar aciertos');
});

test('búsqueda funcional: con un nodo ACTIVO vigente exige y encuentra un acierto real', async () => {
  const p = legacy.proyectoReal('3.20.0', 'busq-vigente');
  marcar(p.dbPath, "UPDATE nodos SET estado = 'OBSOLETO', vigencia_tipo = 'OBSOLETO'; INSERT INTO nodos (tipo,titulo,contenido,area,confianza,estado,vigencia_tipo) VALUES ('patron','Zanahoria cuantica unica','contenido buscable','busq','ALTA','ACTIVO','VIGENTE')");
  const r = await update({ projectPath: p.root, salir: false, silent: true });
  assert.ok(['VERIFIED', 'VERIFIED_WITH_WARNINGS'].includes(r.status), JSON.stringify([r.status, r.errors]));
  const b = r.functional.checks.find((c) => c.name === 'busqueda_real');
  assert.equal(b.status, 'PASS');
  assert.ok(/devolvió [1-9]/.test(b.detail), b.detail);
});
