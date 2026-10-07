'use strict';
/* Reparaciones nacidas del caso real de medinet (07/10/2026): TEAMS aceptó 16 tareas y Agentix registró 0 ciclos en una semana,
   y tras `akdd update` la pestaña Decisiones no apareció. Cuatro causas independientes, cada una con su prueba:
   1. db-adapter cambiaba la base de WAL a DELETE en cada apertura con better-sqlite3 → «database is locked».
   2. `sync` hacía ~4·n² INSERT sueltos (un commit con fsync cada uno) → minutos; y post-cycle lo mataba a los 30 s dejando el proceso huérfano.
   3. El update trataba como «personalizados» archivos intactos (CRLF de git autocrlf, blancos colapsados, versiones sin manifiesto).
   4. `.agentic/mods` no estaba en los archivos que el update entrega. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const RAIZ = path.join(__dirname, '..');
const G = path.join(RAIZ, '.agentic', 'grafo');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function hayBetterSqlite3() { try { require('better-sqlite3'); return true; } catch { return false; } }

// ───────────────────────────── 1. db-adapter no cambia el journal_mode ─────────────────────────────

test('db-adapter: no hay ningún journal_mode = DELETE al abrir (la base vive en WAL)', () => {
  const src = fs.readFileSync(path.join(G, 'db-adapter.cjs'), 'utf8');
  assert.ok(!/pragma\(\s*['"]journal_mode\s*=\s*DELETE['"]\s*\)/i.test(src), 'abrir no puede forzar DELETE: exige bloqueo exclusivo y falla con otro proceso conectado');
});

test('db-adapter + better-sqlite3: abrir para escribir con otra conexión abierta en WAL no falla ni cambia el modo', { skip: !hayBetterSqlite3() && 'better-sqlite3 no está instalado aquí (el caso real: medinet)' }, () => {
  const { DatabaseSync } = require('node:sqlite');
  const dir = tmp('akdd-wal-');
  const f = path.join(dir, 'memoria.db');
  const otra = new DatabaseSync(f);
  otra.exec('PRAGMA journal_mode=WAL; CREATE TABLE t (x INTEGER)');
  otra.exec('BEGIN'); otra.prepare('select count(*) c from t').get(); // vigilante / MCP / tablero con una lectura abierta
  const adapter = require(path.join(G, 'db-adapter.cjs'));
  let w;
  try {
    w = adapter.openWrite(f, { drivers: ['better-sqlite3'], busyTimeout: 500 });
    assert.equal(w.type, 'better-sqlite3');
    w.run('INSERT INTO t (x) VALUES (1)');
    assert.equal(w.get('PRAGMA journal_mode').journal_mode, 'wal', 'el modo no se toca');
  } finally { try { w && w.close(); } catch { /* ya cerrada */ } otra.exec('COMMIT'); otra.close(); }
});

// ───────────────────────────── 2. sync en una sola transacción, sin procesos huérfanos ─────────────────────────────

test('grafo: detectarRelaciones corre en UNA transacción y rápido aunque haya muchos nodos', () => {
  const adapter = require(path.join(G, 'db-adapter.cjs'));
  const { detectarRelaciones } = require(path.join(G, 'grafo.cjs'));
  assert.equal(typeof detectarRelaciones, 'function');
  const dir = tmp('akdd-rel-');
  const db = adapter.openWrite(path.join(dir, 'memoria.db'), { drivers: ['node-sqlite'] });
  try {
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('CREATE TABLE nodos (id INTEGER PRIMARY KEY, tipo TEXT, area TEXT, confianza TEXT)');
    db.exec('CREATE TABLE relaciones (desde_id INTEGER, tipo TEXT, hacia_id INTEGER, peso REAL, UNIQUE(desde_id, tipo, hacia_id))');
    const tipos = ['error', 'patron', 'decision']; const areas = ['global', 'front', 'back'];
    db.transaction(() => { for (let i = 1; i <= 170; i++) db.run('INSERT INTO nodos (id,tipo,area,confianza) VALUES (?,?,?,?)', i, tipos[i % 3], areas[i % 3], i % 2 ? 'ALTA' : 'MEDIA'); })();
    let transacciones = 0; const original = db.transaction.bind(db);
    db.transaction = (fn, opciones) => { transacciones++; return original(fn, opciones); };
    const t = Date.now();
    detectarRelaciones(db);
    const ms = Date.now() - t;
    assert.equal(transacciones, 1, 'todas las escrituras en una sola transacción (antes: un commit con fsync por INSERT)');
    assert.ok(db.get('SELECT count(*) c FROM relaciones').c > 1000, 'las relaciones se crearon');
    assert.ok(ms < 20000, 'tardó ' + ms + ' ms: con 170 nodos debe ser cuestión de segundos');
  } finally { db.close(); }
});

test('post-cycle: sync y AST corren sin shell (con shell, en Windows, el timeout deja el node huérfano)', () => {
  const src = fs.readFileSync(path.join(G, 'post-cycle.cjs'), 'utf8');
  assert.ok(!/execSync\(`node "\$\{(grafoCjs|astCjs)\}"/.test(src), 'execSync(`node …`) con timeout deja procesos huérfanos peleando por la base');
  assert.match(src, /correrNode\(grafoCjs, \['sync'\]/);
  assert.match(src, /correrNode\(astCjs, \['index'\]/);
});

// ───────────────────────────── 3. el update reconoce los archivos intactos ─────────────────────────────

function proyectoConArchivo(rel, contenido) {
  const dir = tmp('akdd-clas-');
  const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, contenido);
  return dir;
}
function stagingCon(rel, contenido) {
  const dir = tmp('akdd-stg-');
  const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, contenido);
  return dir;
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

test('update: un archivo del framework con CRLF y blancos colapsados (versión publicada, owned.json desfasado) NO es personalizado', () => {
  const { clasificar } = require(path.join(RAIZ, 'src', 'update-classify.js'));
  const publicado = fs.readFileSync(path.join(RAIZ, 'dashboard.cjs'), 'utf8').replace(/\r\n/g, '\n'); // = 3.24.0, está en el manifiesto
  // lo que dejó git con autocrlf=true + un editor que colapsó líneas en blanco dobles
  // (y líneas en blanco de más / espacios al final: un editor que reacomoda blancos; la diferencia es REAL en bytes, no solo CRLF)
  const alterado = publicado.replace('\n\n', '\n\n\n\n').replace(/^(.+)$/m, '$1   ');
  assert.notEqual(alterado.replace(/\r\n/g, '\n'), publicado, 'la prueba debe alterar de verdad el contenido');
  const enDisco = alterado.replace(/\n/g, '\r\n');
  const proyecto = proyectoConArchivo('dashboard.cjs', enDisco);
  const staging = stagingCon('dashboard.cjs', publicado + '\n// versión más nueva\n');
  const owned = { archivos: { 'dashboard.cjs': sha(Buffer.from(publicado, 'utf8')) } }; // hash LF registrado al instalar: no coincide con el CRLF de disco
  const r = clasificar({ projectPath: proyecto, staging, owned, filtro: null });
  const e = r.entries.find((x) => x.rel === 'dashboard.cjs');
  assert.equal(e.clase, 'FRAMEWORK_SIN_CAMBIOS', e.motivo);
  assert.equal(e.accion, 'ESCRIBIR');
  assert.equal(r.conflicts.length, 0);
});

test('update: una edición REAL del usuario sigue siendo personalizada', () => {
  const { clasificar } = require(path.join(RAIZ, 'src', 'update-classify.js'));
  const publicado = fs.readFileSync(path.join(RAIZ, 'dashboard.cjs'), 'utf8').replace(/\r\n/g, '\n');
  const editado = publicado.replace('<title>', '<title>MI CAMBIO ');
  assert.notEqual(editado, publicado);
  const proyecto = proyectoConArchivo('dashboard.cjs', editado);
  const staging = stagingCon('dashboard.cjs', publicado + '\n// nueva\n');
  const r = clasificar({ projectPath: proyecto, staging, owned: { archivos: { 'dashboard.cjs': sha(Buffer.from(publicado)) } }, filtro: null });
  const e = r.entries.find((x) => x.rel === 'dashboard.cjs');
  assert.equal(e.clase, 'PERSONALIZADO'); assert.equal(e.accion, 'CONSERVAR_Y_APARTAR');
});

test('update: el manifiesto de versiones publicadas llega hasta la última publicada y hash/generador coinciden', () => {
  const m = require(path.join(RAIZ, 'src', 'release-manifests.json'));
  const versiones = m.versions.map((v) => v.version);
  for (const v of ['3.20.4', '3.21.0', '3.22.0', '3.23.9', '3.24.0']) assert.ok(versiones.includes(v), 'falta ' + v + ' en el manifiesto: sus archivos intactos se verían como personalizados');
  const { hashNorm } = require(path.join(RAIZ, 'src', 'update-classify.js'));
  const { hashNormalizado } = require(path.join(RAIZ, 'scripts', 'gen-release-manifests.cjs'));
  for (const muestra of ['a\r\nb\r\n', 'a\n\n\n\nb  \n', 'x']) assert.equal(hashNorm(Buffer.from(muestra)), hashNormalizado(Buffer.from(muestra)), 'el clasificador y el generador deben hashear igual');
});

// ───────────────────────────── 4. el mod viaja con el update ─────────────────────────────

test('update: .agentic/mods es un archivo administrado (el update entrega el mod agentix-live)', () => {
  const manifest = require(path.join(RAIZ, 'src', 'managed-manifest.js'));
  assert.equal(manifest.esManaged('.agentic/mods/agentix-live/SKILL.md'), true);
  assert.equal(manifest.esManaged('.agentic/mods/agentix-live/hooks/register.tsx'), true);
  const lista = manifest.archivos(RAIZ).filter((r) => r.startsWith('.agentic/mods/'));
  assert.ok(lista.length >= 5, 'el paquete debe listar los archivos del mod: ' + lista.length);
});
