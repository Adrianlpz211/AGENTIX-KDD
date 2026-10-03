'use strict';

/* D05/D06/D08/D09/D21 — el dashboard lee memoria.db en solo lectura, con
   cualquier driver disponible, y lo que no puede leer lo muestra como
   "sin dato", nunca como 0. Abrirlo no sincroniza ni escribe nada. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { crearFixture, arrancarDashboard, REPO } = require('./fixtures/dashboard-fixture.cjs');

const datos = require(path.join(REPO, '.agentic', 'grafo', 'dashboard-datos.cjs'));
const adapter = require(path.join(REPO, '.agentic', 'grafo', 'db-adapter.cjs'));
const summaries = require(path.join(REPO, '.agentic', 'grafo', 'code-summaries.cjs'));

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-datos-' + p + '-'));
const dbDe = (dir) => path.join(dir, '.agentic', 'memoria.db');

const CONTRATOS = [
  ['pagos', 'cobro idempotente', 'verified'], ['pagos', 'total en centavos', 'protected'],
  ['pedidos', 'cantidad entera', 'broken'], ['pedidos', 'stock reservado', 'candidate'],
  ['auth', 'tenant obligatorio', 'deprecated'],
];

function conContratos(dir) {
  const db = new DatabaseSync(dbDe(dir));
  db.exec('CREATE TABLE verified_contracts (id INTEGER PRIMARY KEY, module TEXT, name TEXT, status TEXT, verification_count INTEGER, failure_count INTEGER, updated_at TEXT)');
  CONTRATOS.forEach(([m, n, s], i) => db.prepare('INSERT INTO verified_contracts (module,name,status,verification_count,failure_count,updated_at) VALUES (?,?,?,?,?,?)').run(m, n, s, i, 0, '2026-09-0' + (i + 1)));
  db.close();
}

/** Esquema, user_version y filas: si abrir el panel cambia algo, cambia esto. */
function huella(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const esquema = db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
    const version = db.prepare('PRAGMA user_version').get().user_version;
    const filas = esquema.filter((t) => t.type === 'table').map((t) => [t.name, db.prepare(`SELECT * FROM "${t.name}" ORDER BY rowid`).all()]);
    return { esquema: JSON.stringify(esquema), version, logico: crypto.createHash('sha256').update(JSON.stringify(filas)).digest('hex') };
  } finally { db.close(); }
}
const bytes = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const sinFecha = (s) => { const c = JSON.parse(JSON.stringify(s)); delete c.updated_at; delete c.driver; return c; };

/** Cifras de una tarjeta: { Etiqueta: { cls, v, sinDato } } */
function tarjeta(html, desde, hasta) {
  const i = html.indexOf(desde);
  const trozo = html.slice(i, html.indexOf(hasta, i));
  const out = {};
  for (const m of trozo.matchAll(/<div class="il-stat-val ([^"]*)"([^>]*)>([^<]*)<\/div><div class="il-stat-lbl">([^<]+)</g)) {
    out[m[4]] = { cls: m[1], v: m[3], sinDato: /data-sin-dato/.test(m[2]) };
  }
  return { cifras: out, trozo };
}
const pedir = async (url) => { const r = await fetch(url); return { status: r.status, html: await r.text() }; };

// ─── D06: mismo resultado con cada driver; driver ausente = sin dato ─────────
test('D06: cada driver usable da los mismos contratos, por estado, sobre el mismo fixture', (t) => {
  const dir = tmp('drv'); crearFixture(dir); conContratos(dir);
  const antes = huella(dbDe(dir)); const b0 = bytes(dbDe(dir));
  const porDriver = {};
  const noUsables = [];
  for (const drv of ['better-sqlite3', 'node-sqlite', 'sqljs']) {
    const r = datos.contratos(dbDe(dir), { abrir: (p) => adapter.openReadOnly(p, { drivers: [drv] }) });
    if (r.status === 'UNAVAILABLE' && r.reason_code === 'DRIVER_AUSENTE') { noUsables.push(drv); continue; }
    assert.strictEqual(r.status, 'OK', drv + ': ' + JSON.stringify(r));
    assert.strictEqual(r.driver, drv);
    porDriver[drv] = sinFecha(r);
  }
  const usados = Object.keys(porDriver);
  assert.ok(usados.length >= 1, 'ningún driver usable');
  t.diagnostic('drivers comparados: ' + usados.join(', ') + (noUsables.length ? ' · no usables aquí: ' + noUsables.join(', ') : ''));
  for (const drv of usados.slice(1)) assert.deepStrictEqual(porDriver[drv], porDriver[usados[0]], drv + ' difiere de ' + usados[0]);
  const v = porDriver[usados[0]].value;
  assert.deepStrictEqual(v.por_estado, { CANDIDATE: 1, VERIFIED: 1, PROTECTED: 1, VIOLATED: 1, UNVERIFIED: 0 });
  assert.strictEqual(v.total, 4, 'deprecated no cuenta');
  assert.strictEqual(v.violaciones, null, 'sin tabla de violaciones: desconocido, no 0');
  assert.deepStrictEqual(huella(dbDe(dir)), antes, 'leer no cambia esquema, user_version ni datos');
  assert.strictEqual(bytes(dbDe(dir)), b0);
  assert.ok(!fs.existsSync(dbDe(dir) + '-wal') && !fs.existsSync(dbDe(dir) + '-journal'));
});

test('D06: sin driver usable el panel queda UNAVAILABLE, no en cero', () => {
  const dir = tmp('nodrv'); crearFixture(dir); conContratos(dir);
  const r = datos.contratos(dbDe(dir), { abrir: (p) => adapter.openReadOnly(p, { drivers: ['ninguno'] }) });
  assert.strictEqual(r.status, 'UNAVAILABLE');
  assert.strictEqual(r.reason_code, 'DRIVER_AUSENTE');
  assert.strictEqual(r.value, null);
});

// ─── D05: cada forma de fallar dice por qué y no da cero ─────────────────────
test('D05: base ausente, bloqueada, corrupta y tabla faltante → UNAVAILABLE con motivo', () => {
  const ausente = datos.contratos(path.join(tmp('aus'), 'no-existe.db'));
  assert.deepStrictEqual([ausente.status, ausente.reason_code, ausente.value], ['UNAVAILABLE', 'DB_AUSENTE', null]);

  const dc = tmp('corr'); const pc = path.join(dc, 'memoria.db');
  fs.writeFileSync(pc, Buffer.from('esto no es una base sqlite '.repeat(200)));
  const corrupta = datos.contratos(pc);
  assert.deepStrictEqual([corrupta.status, corrupta.reason_code], ['UNAVAILABLE', 'DB_CORRUPTA']);

  const dt = tmp('tabla'); crearFixture(dt);
  const sinTabla = datos.contratos(dbDe(dt));
  assert.deepStrictEqual([sinTabla.status, sinTabla.reason_code, sinTabla.value], ['UNAVAILABLE', 'TABLA_AUSENTE', null]);

  const dl = tmp('lock'); crearFixture(dl); conContratos(dl);
  const w = new DatabaseSync(dbDe(dl));
  w.exec('BEGIN EXCLUSIVE');
  try {
    const bloqueada = datos.contratos(dbDe(dl), { abrir: (p) => adapter.openReadOnly(p, { busyTimeout: 100, drivers: ['node-sqlite'] }) });
    assert.deepStrictEqual([bloqueada.status, bloqueada.reason_code], ['UNAVAILABLE', 'DB_BLOQUEADA']);
  } finally { w.exec('ROLLBACK'); w.close(); }

  const vacia = tmp('vacia'); crearFixture(vacia);
  const db = new DatabaseSync(dbDe(vacia));
  db.exec('CREATE TABLE verified_contracts (id INTEGER PRIMARY KEY, module TEXT, name TEXT, status TEXT, verification_count INTEGER, failure_count INTEGER, updated_at TEXT)');
  db.close();
  const empty = datos.contratos(dbDe(vacia));
  assert.strictEqual(empty.status, 'EMPTY', 'tabla válida sin filas: aquí el 0 sí es verdad');
  assert.strictEqual(empty.value.total, 0);
});

test('D05/D21: si la consulta falla, la conexión se cierra igual', () => {
  const dir = tmp('cierre'); crearFixture(dir);
  let cerrada = 0;
  const abrir = (p) => { const db = adapter.openReadOnly(p); const c = db.close; db.close = () => { cerrada++; return c.call(db); }; return db; };
  const r = datos.conLectura(dbDe(dir), () => { throw new Error('no such column: inventada'); }, { abrir });
  assert.deepStrictEqual([r.status, r.reason_code], ['UNAVAILABLE', 'ESQUEMA_DISTINTO']);
  assert.strictEqual(cerrada, 1);
  const ok = datos.conLectura(dbDe(dir), (db) => datos.sobre('OK', db.get('SELECT COUNT(*) AS n FROM nodos').n), { abrir });
  assert.strictEqual(ok.value, 6);
  assert.strictEqual(cerrada, 2);
});

// ─── D21: el lector de resúmenes no crea la tabla y dice su estado ───────────
test('D21: base sin code_summaries no cambia y el lector informa EMPTY_LEGACY', () => {
  const dir = tmp('sum'); crearFixture(dir);
  const db = new DatabaseSync(dbDe(dir)); db.exec('DROP TABLE code_summaries'); db.close();
  const antes = huella(dbDe(dir)); const b0 = bytes(dbDe(dir));
  assert.strictEqual(summaries.getFresh('src/pagos.js', dir), null);
  const r = summaries.leerResumen('src/pagos.js', dir);
  assert.deepStrictEqual([r.status, r.reason_code], ['UNAVAILABLE', 'EMPTY_LEGACY']);
  assert.deepStrictEqual(huella(dbDe(dir)), antes);
  assert.strictEqual(bytes(dbDe(dir)), b0);
  assert.ok(!/code_summaries/.test(antes.esquema));
  const sinBase = summaries.leerResumen('src/pagos.js', tmp('sum-vacio'));
  assert.deepStrictEqual([sinBase.status, sinBase.reason_code], ['UNAVAILABLE', 'DB_AUSENTE']);
});

// ─── En el dashboard real (proceso aparte, navegador no hace falta) ──────────
test('D06/D05: el dashboard muestra los contratos de la base y "—" cuando no puede leerlos', async () => {
  const dir = tmp('dash'); crearFixture(dir); conContratos(dir);
  let d = await arrancarDashboard(dir);
  try {
    const { cifras } = tarjeta((await pedir(d.url)).html, 'Contratos verificados', 'Creative Engine');
    assert.deepStrictEqual([cifras.Protected.v, cifras.Verified.v, cifras.Candidate.v], ['1', '1', '1'], JSON.stringify(cifras));
    assert.ok(cifras.Violations.sinDato && cifras.Violations.v === '—', 'sin tabla de violaciones no se pinta 0');
  } finally { d.cerrar(); }

  const sinTabla = tmp('dash-st'); crearFixture(sinTabla);
  d = await arrancarDashboard(sinTabla);
  try {
    const { status, html } = await pedir(d.url);
    assert.strictEqual(status, 200);
    const { cifras, trozo } = tarjeta(html, 'Contratos verificados', 'Creative Engine');
    for (const k of ['Protected', 'Verified', 'Candidate', 'Violations']) {
      assert.ok(cifras[k].sinDato && cifras[k].v === '—' && cifras[k].cls === 'vx', k + ': ' + JSON.stringify(cifras[k]));
    }
    assert.match(trozo, /Sin dato de contratos: TABLA_AUSENTE/);
    assert.ok(!/Sin contratos — corre ciclos/.test(trozo));
    assert.ok(html.includes('id="gc"') && html.includes('Patterns'), 'el resto del tablero sigue ahí');
  } finally { d.cerrar(); }
});

test('D05: con la base corrupta el tablero abre, nada sale en verde y el onboarding no da 100%', async () => {
  const dir = tmp('dash-corr'); crearFixture(dir);
  fs.writeFileSync(dbDe(dir), Buffer.from('basura '.repeat(500)));
  const d = await arrancarDashboard(dir);
  try {
    const { status, html } = await pedir(d.url);
    assert.strictEqual(status, 200);
    for (const [desde, hasta] of [['Contratos verificados', 'Creative Engine'], ['Creative Engine', 'MemCurator'], ['Memoria de diseño', 'UI Native Gate'], ['Ojos UI', 'Flujos UI']]) {
      const { cifras } = tarjeta(html, desde, hasta);
      assert.ok(Object.keys(cifras).length, desde);
      for (const [k, c] of Object.entries(cifras)) assert.ok(c.sinDato && c.cls === 'vx' && c.v === '—', desde + '/' + k + ': ' + JSON.stringify(c));
    }
    assert.match(html, /SIN DATO/);
    assert.ok(!/Nivel 1<\/span>/.test(html), 'sin contratos legibles no hay nivel inventado');
    const onboarding = html.match(/showDoc\('onboarding',this\)[^]*?nav-count">(\d+)%/);
    assert.ok(onboarding && onboarding[1] !== '100', 'onboarding: ' + (onboarding && onboarding[1]));
    assert.match(html, /Primer sync del grafo/);
    assert.match(html, /data-fuente="markdown_legado"/, 'la memoria cae al markdown y lo dice');
  } finally { d.cerrar(); }
});

// ─── D08: abrir no sincroniza, no lanza procesos y no escribe ────────────────
test('D08: arrancar y refrescar 100 veces no corre sync, no lanza procesos y no toca la base', async () => {
  const dir = tmp('nosync'); crearFixture(dir); conContratos(dir);
  const marca = path.join(dir, 'sync-corrio.txt');
  fs.mkdirSync(path.join(dir, '.agentic', 'grafo'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.agentic', 'grafo', 'grafo.cjs'), `require('fs').appendFileSync(${JSON.stringify(marca)}, process.argv.slice(2).join(' ') + '\\n');`);
  const log = path.join(dir, 'procesos.log');
  const espia = path.join(dir, 'espia.cjs');
  fs.writeFileSync(espia, `const cp = require('child_process'); const fs = require('fs');
for (const k of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) { const o = cp[k]; cp[k] = function (...a) { fs.appendFileSync(${JSON.stringify(log)}, k + ' ' + String(a[0]) + '\\n'); return o.apply(this, a); }; }`);
  const antes = huella(dbDe(dir)); const b0 = bytes(dbDe(dir));
  const d = await arrancarDashboard(dir, { NODE_OPTIONS: '--require=' + espia });
  try {
    for (let i = 0; i < 100; i++) assert.strictEqual((await pedir(d.url)).status, 200);
  } finally { d.cerrar(); }
  assert.ok(!fs.existsSync(marca), 'sync corrió: ' + (fs.existsSync(marca) ? fs.readFileSync(marca, 'utf8') : ''));
  assert.ok(!fs.existsSync(log), 'procesos lanzados: ' + (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''));
  assert.deepStrictEqual(huella(dbDe(dir)), antes);
  assert.strictEqual(bytes(dbDe(dir)), b0);
  assert.ok(!fs.existsSync(dbDe(dir) + '-wal') && !fs.existsSync(dbDe(dir) + '-journal'));
});

test('D08: src/dashboard.js no invoca sync al abrir', () => {
  const src = fs.readFileSync(path.join(REPO, 'src', 'dashboard.js'), 'utf8');
  assert.ok(!/\[\s*'sync'\s*\]/.test(src) && !/['"]sync['"]\s*\]/.test(src), 'sigue lanzando sync');
});

// ─── D09: la base manda; el markdown es una proyección marcada ───────────────
test('D09: una entrada solo en la base aparece y un markdown atrasado no la reemplaza', async () => {
  const dir = tmp('fuente'); crearFixture(dir);
  const db = new DatabaseSync(dbDe(dir));
  db.prepare("INSERT INTO nodos (tipo,titulo,contenido,area,confianza,aplicado,util,estado,fecha_creacion) VALUES ('patron','Solo en la base de memoria','x','pagos','ALTA',0,0,'ACTIVO','2026-09-05')").run();
  db.close();
  fs.appendFileSync(path.join(dir, '.agentic', 'memoria', 'patrones.md'), '\n## Solo en el markdown viejo\nestado: ACTIVO\n\nNo está en la base.\n');
  const d = await arrancarDashboard(dir);
  try {
    const { html } = await pedir(d.url);
    const pat = html.slice(html.indexOf('id="doc-patterns"'), html.indexOf('id="doc-decisions"'));
    assert.match(pat, /Solo en la base de memoria/);
    assert.ok(!/Solo en el markdown viejo/.test(pat), 'el markdown atrasado se coló');
    assert.ok(!/data-fuente="markdown_legado"/.test(html), 'con base legible no se anuncia fuente heredada');
    const nav = html.match(/showDoc\('patterns',this\)[^]*?nav-count">(\d+)</);
    assert.strictEqual(nav[1], '3', 'dos patrones del fixture + el de la base');
  } finally { d.cerrar(); }
});
