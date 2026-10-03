'use strict';
// Canarios: valores FALSOS con formato de secreto, codificados para que el escáner de secretos del repo no los confunda con una filtración real.
const dec = (b) => Buffer.from(b, 'base64').toString('utf8');
/* Almacén de evidencias (C01 "Seguridad de evidencias", H01 "Almacén"). */
const test = require('node:test');
const { SIN_DRIVER } = require('./helpers/db-real.cjs');
if (SIN_DRIVER) { test(require('node:path').basename(__filename) + ' (omitido: ' + SIN_DRIVER + ')', { skip: SIN_DRIVER }, () => {}); return; }
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { proyecto, REPO, dba } = require('./helpers/memoria-proyecto.cjs');
const G = path.join(REPO, '.agentic', 'grafo');
const store = require(path.join(G, 'evidence-store.cjs'));
const core = require(path.join(G, 'memory-core.cjs'));

const filas = (p, sql, ...a) => { const d = p.abrirR(); try { return d.all(sql, ...a); } finally { d.close(); } };
const lineas = (n) => Array.from({ length: n }, (_, i) => 'línea ' + (i + 1) + ' ñandú').join('\n');

test('guardar → obtener: el original autorizado se recupera íntegro con el mismo hash', () => {
  const p = proyecto('ev-basico');
  try {
    const txt = lineas(50);
    const g = store.guardar(p.root, { text: txt }, { kind: 'test_log', retention: 'durable_audit', task_id: 'T1' });
    assert.ok(g.ok, JSON.stringify(g));
    assert.equal(g.sha256, crypto.createHash('sha256').update(txt).digest('hex'));
    assert.match(g.evidence_id, /^ev_[a-f0-9]{40}$/);
    const o = store.obtener(p.root, g.evidence_id, { offset: 0, length: 1 << 20 });
    assert.equal(o.content, txt);
    assert.equal(o.sha256, g.sha256);
    assert.equal(o.complete, true);
    assert.equal(o.has_more, false);
    // Mismo contenido, mismo id: identidad por proyecto + hash (no duplica).
    assert.equal(store.guardar(p.root, { text: txt }, { kind: 'test_log' }).evidence_id, g.evidence_id);
    assert.equal(filas(p, 'SELECT count(*) AS n FROM mem_evidence')[0].n, 1);
  } finally { p.limpiar(); }
});

test('paginación: por bytes (sin partir un carácter UTF-8), por líneas y por cursor; has_more exacto', () => {
  const p = proyecto('ev-paginas');
  try {
    const txt = lineas(400);
    const g = store.guardar(p.root, { text: txt }, { kind: 'tool_output' });
    // Por bytes con un tamaño que cae en medio de una ñ: nunca debe producir caracteres corruptos.
    let cursor = { offset: 0 }; let acumulado = ''; let vueltas = 0;
    while (cursor && vueltas++ < 500) {
      const o = store.obtener(p.root, g.evidence_id, { cursor, length: 777 });
      assert.ok(o.ok);
      assert.ok(!o.content.includes('�'), 'carácter cortado por la mitad');
      acumulado += o.content; cursor = o.next_cursor;
    }
    assert.equal(acumulado, txt, 'paginar y concatenar reconstruye el original exacto');
    // Por líneas.
    const l = store.obtener(p.root, g.evidence_id, { line_from: 10, line_to: 12 });
    assert.equal(l.content, ['línea 10 ñandú', 'línea 11 ñandú', 'línea 12 ñandú'].join('\n'));
    assert.equal(l.has_more, true);
    const ultimas = store.obtener(p.root, g.evidence_id, { line_from: 399, line_to: 400 });
    assert.equal(ultimas.has_more, false, 'llegó exactamente al final: no hay más páginas');
    assert.equal(store.obtener(p.root, g.evidence_id, { offset: 99999999 }).status, 'RANGE_OUT_OF_BOUNDS');
  } finally { p.limpiar(); }
});

test('selector JSON limitado: ruta, rango y proyección de campos; sin eval; prototipos bloqueados', () => {
  const p = proyecto('ev-json');
  try {
    const datos = { items: Array.from({ length: 100 }, (_, i) => ({ id: i, estado: i === 77 ? 'FALLO' : 'ok', detalle: 'x'.repeat(50) })), total: 100 };
    const g = store.guardar(p.root, { text: JSON.stringify(datos) }, { kind: 'tool_output', content_type: 'application/json' });
    const r = store.obtener(p.root, g.evidence_id, { json: { path: 'items', fields: ['id', 'estado'], offset: 75, limit: 5 } });
    assert.ok(r.ok, JSON.stringify(r));
    const sel = JSON.parse(r.content);
    assert.equal(sel.length, 5);
    assert.deepEqual(Object.keys(sel[0]), ['id', 'estado']);
    assert.equal(sel[2].estado, 'FALLO');
    assert.equal(r.complete, false, 'una selección NO se presenta como el original completo');
    assert.equal(r.selection_total, 100);
    assert.equal(r.paginated.total, 100);
    assert.equal(store.obtener(p.root, g.evidence_id, { json: { path: 'items[0:2]' } }).ok, true);
    for (const malo of ['__proto__.polluted', 'constructor.prototype', 'items;process.exit()', 'items[a]', 'a b']) {
      const x = store.obtener(p.root, g.evidence_id, { json: { path: malo } });
      assert.equal(x.ok, false, malo);
    }
    assert.equal(({}).polluted, undefined);
    const noJson = store.guardar(p.root, { text: 'no es json' }, { kind: 'tool_output' });
    assert.equal(store.obtener(p.root, noJson.evidence_id, { json: { path: 'a' } }).status, 'NOT_JSON');
  } finally { p.limpiar(); }
});

test('hash o tamaño cambiado → EVIDENCE_CHANGED; ausente → EVIDENCE_UNAVAILABLE; nunca PASS ni contenido inventado', () => {
  const p = proyecto('ev-integridad');
  try {
    const g = store.guardar(p.root, { text: 'contenido original del log' }, { kind: 'test_log', retention: 'durable_audit' });
    const archivo = store.rutaObjeto(p.root, g.sha256);
    assert.equal(store.verificar(p.root, g.evidence_id).status, 'OK');
    // Alterar el contenido manteniendo el tamaño (el caso que un chequeo de tamaño no ve).
    const bytes = fs.readFileSync(archivo); bytes[0] = bytes[0] ^ 1; fs.writeFileSync(archivo, bytes);
    const c1 = store.obtener(p.root, g.evidence_id, {});
    assert.equal(c1.status, 'EVIDENCE_CHANGED');
    assert.equal(c1.ok, false);
    assert.equal(c1.content, undefined, 'no se entrega el contenido alterado');
    // Alterar también el tamaño.
    fs.writeFileSync(archivo, 'más corto');
    assert.equal(store.verificar(p.root, g.evidence_id).status, 'EVIDENCE_CHANGED');
    // Borrar.
    fs.unlinkSync(archivo);
    assert.equal(store.verificar(p.root, g.evidence_id).status, 'EVIDENCE_UNAVAILABLE');
    assert.equal(store.obtener(p.root, g.evidence_id, {}).status, 'EVIDENCE_UNAVAILABLE');
    assert.equal(store.verificar(p.root, 'ev_' + 'f'.repeat(40)).status, 'UNKNOWN_REFERENCE');
    assert.equal(store.verificar(p.root, '../../etc/passwd').status, 'UNKNOWN_REFERENCE');
  } finally { p.limpiar(); }
});

test('aislamiento: traversal, symlink hacia fuera, referencia de otro proyecto y ruta privada son rechazados', () => {
  const p = proyecto('ev-aislamiento');
  const q = proyecto('ev-aislamiento-b');
  const fuera = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-fuera-'));
  try {
    fs.writeFileSync(path.join(fuera, 'secreto.txt'), 'fuera del proyecto');
    assert.equal(store.guardarArchivo(p.root, '../x.txt').status, 'DENIED');
    assert.equal(store.guardarArchivo(p.root, path.join(fuera, 'secreto.txt')).status, 'DENIED');
    assert.equal(store.guardarArchivo(p.root, 'noexiste.txt').status, 'EVIDENCE_UNAVAILABLE');
    fs.writeFileSync(path.join(p.root, '.env'), 'API_KEY=zzzz');
    assert.equal(store.guardarArchivo(p.root, '.env').status, 'PRIVATE_NOT_STORED');
    let enlace = false;
    try { fs.symlinkSync(path.join(fuera, 'secreto.txt'), path.join(p.root, 'enlace.txt')); enlace = true; } catch { /* sin permiso de symlink en este sistema */ }
    if (enlace) assert.equal(store.guardarArchivo(p.root, 'enlace.txt').status, 'DENIED', 'el enlace apunta fuera de la raíz');
    // Otro proyecto: la referencia de A no se resuelve en B (distinto project_id / almacén).
    const g = store.guardar(p.root, { text: 'solo del proyecto A' }, { kind: 'tool_output' });
    core.capturar(q.root, { host: 'h', session_id: 's', host_event_id: '1', event_type: 'x' });
    assert.equal(store.obtener(q.root, g.evidence_id, {}).status, 'UNKNOWN_REFERENCE');
    // Fila copiada a mano a otra memoria con otro project_id: se rechaza por pertenecer a otro proyecto.
    const filaA = filas(p, 'SELECT * FROM mem_evidence')[0];
    const dq = q.abrirW();
    try { dq.run('INSERT INTO mem_evidence (evidence_id, project_id, kind, store, locator, sha256, bytes, retention, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', filaA.evidence_id, 'prj_otro', 'tool_output', 'evidence_store', filaA.locator, filaA.sha256, filaA.bytes, 'cache', 'AVAILABLE', 'ahora'); } finally { dq.close(); }
    assert.equal(store.obtener(q.root, filaA.evidence_id, {}).status, 'DENIED');
    // locator manipulado en la tabla: ni el almacén ni el proyecto salen de su raíz.
    const dp = p.abrirW();
    try { dp.run("UPDATE mem_evidence SET locator = '../../../../../etc/hosts' WHERE evidence_id = ?", g.evidence_id); } finally { dp.close(); }
    assert.notEqual(store.obtener(p.root, g.evidence_id, {}).status, 'OK');
  } finally { p.limpiar(); q.limpiar(); fs.rmSync(fuera, { recursive: true, force: true }); }
});

test('colisión de id: el mismo evidence_id con otro contenido se rechaza (no se pisa la evidencia)', () => {
  const p = proyecto('ev-colision');
  try {
    const g = store.guardar(p.root, { text: 'original A' }, { kind: 'tool_output' });
    const d = p.abrirW();
    try { d.run('UPDATE mem_evidence SET sha256 = ? WHERE evidence_id = ?', 'e'.repeat(64), g.evidence_id); } finally { d.close(); }
    const r = store.guardar(p.root, { text: 'original A' }, { kind: 'tool_output' });
    assert.equal(r.status, 'EVIDENCE_ID_COLLISION');
  } finally { p.limpiar(); }
});

test('privacidad: el secreto no existe en el original almacenado; binarios y rutas privadas no se guardan sin permiso', () => {
  const p = proyecto('ev-privado');
  try {
    const g = store.guardar(p.root, { text: dec('b2sKQXV0aG9yaXphdGlvbjogQmVhcmVyIFpaWnN1cGVyc2VjcmV0b1paWjEyMzQ1NgpwYXNzd29yZD1odW50ZXIyaHVudGVyMgpmaW4=') }, { kind: 'tool_output' });
    assert.equal(g.privacy_class, 'redacted');
    const o = store.obtener(p.root, g.evidence_id, {});
    assert.ok(!/ZZZsuper|hunter2/.test(o.content));
    assert.ok(o.content.includes('ok') && o.content.includes('fin'), 'el resto del original se conserva');
    assert.equal(store.guardar(p.root, { bytes: Buffer.from([0, 1, 2, 3]) }, {}).status, 'BINARY_NOT_ALLOWED');
    assert.equal(store.guardar(p.root, { bytes: Buffer.from([0, 1, 2, 3]) }, { allow_binary: true, kind: 'screenshot' }).ok, true);
    assert.equal(store.guardar(p.root, { text: 'x' }, { source_path: 'config/.env.local' }).status, 'PRIVATE_NOT_STORED');
  } finally { p.limpiar(); }
});

test('guardado atómico: la referencia solo existe con el original confirmado; sin tablas no hay referencia', () => {
  const p = proyecto('ev-atomico');
  const q = proyecto('ev-atomico-sin', { catalogo: false, nodos: 0 });
  try {
    const g = store.guardar(p.root, { text: 'confirmado' }, { kind: 'tool_output' });
    assert.ok(fs.existsSync(store.rutaObjeto(p.root, g.sha256)));
    assert.deepEqual(fs.readdirSync(path.join(store.raizAlmacen(p.root), 'tmp')), [], 'no quedan temporales');
    const s = store.guardar(q.root, { text: 'sin tablas' }, { kind: 'tool_output' });
    assert.equal(s.ok, false);
    assert.equal(s.status, 'SCHEMA_MISSING');
    assert.ok(!s.evidence_id, 'sin tablas no se entrega referencia');
  } finally { p.limpiar(); q.limpiar(); }
});

test('límites: objeto demasiado grande y almacén lleno se declaran (NO se comprime perdiendo el original)', () => {
  const p = proyecto('ev-limites');
  try {
    const grande = store.guardar(p.root, { text: 'x'.repeat(5000) }, { max_object_bytes: 1000 });
    assert.equal(grande.status, 'TOO_LARGE');
    assert.equal(grande.ok, false);
    const a = store.guardar(p.root, { text: 'a'.repeat(600) }, { retention: 'durable_audit', max_store_bytes: 1000 });
    assert.ok(a.ok);
    const b = store.guardar(p.root, { text: 'b'.repeat(600) }, { retention: 'durable_audit', max_store_bytes: 1000 });
    assert.equal(b.status, 'NO_SPACE', 'lo durable no se purga para hacer sitio');
    assert.equal(filas(p, 'SELECT count(*) AS n FROM mem_evidence')[0].n, 1);
  } finally { p.limpiar(); }
});

test('retención: la caducidad purga solo caché sin pin; durable_audit y pins sobreviven; lo purgado es EXPIRED', () => {
  const p = proyecto('ev-retencion');
  try {
    const t0 = Date.now();
    const cache = store.guardar(p.root, { text: 'caché sin pin' }, { retention: 'cache', ttl_ms: 1000, now: t0 });
    const fijada = store.guardar(p.root, { text: 'caché CON pin' }, { retention: 'cache', ttl_ms: 1000, now: t0 });
    const durable = store.guardar(p.root, { text: 'evidencia de gate' }, { retention: 'durable_audit', now: t0 });
    assert.ok(store.fijar(p.root, fijada.evidence_id, 'task', 'T-9').ok);
    const futuro = t0 + 30 * 24 * 3600 * 1000;
    const r = store.limpiar(p.root, { now: futuro });
    assert.deepEqual(r.expired, [cache.evidence_id]);
    assert.equal(store.verificar(p.root, cache.evidence_id).status, 'EXPIRED', 'caducada: nunca se reconstruye');
    assert.equal(store.verificar(p.root, fijada.evidence_id).status, 'OK', 'el pin la protege');
    assert.equal(store.verificar(p.root, durable.evidence_id).status, 'OK', 'durable no caduca');
    // El pin persiste el reinicio (vive en la base) y se libera explícitamente.
    assert.equal(store.estadisticas(p.root).pinned, 1);
    assert.equal(store.soltar(p.root, 'task', 'T-9').released, 1);
    const r2 = store.limpiar(p.root, { now: futuro });
    assert.deepEqual(r2.expired, [fijada.evidence_id]);
    // dry_run no borra nada.
    const x = store.guardar(p.root, { text: 'otra caché' }, { retention: 'cache', ttl_ms: 1, now: t0 });
    assert.equal(store.limpiar(p.root, { now: futuro, dry_run: true }).expired.length, 1);
    assert.equal(store.verificar(p.root, x.evidence_id).status, 'OK');
  } finally { p.limpiar(); }
});

test('retención: LRU con límite de espacio solo sacrifica caché sin pin, la menos usada primero', () => {
  const p = proyecto('ev-lru');
  try {
    const t = Date.now();
    const a = store.guardar(p.root, { text: 'a'.repeat(400) }, { retention: 'cache', now: t });
    const b = store.guardar(p.root, { text: 'b'.repeat(400) }, { retention: 'cache', now: t + 10 });
    const c = store.guardar(p.root, { text: 'c'.repeat(400) }, { retention: 'cache', now: t + 20 });
    store.fijar(p.root, a.evidence_id, 'sprint', 'S1');
    const r = store.limpiar(p.root, { now: t + 30, max_bytes: 800 });
    assert.deepEqual(r.expired, [b.evidence_id], 'a tiene pin: se sacrifica la siguiente menos reciente');
    assert.equal(store.verificar(p.root, c.evidence_id).status, 'OK');
  } finally { p.limpiar(); }
});

test('huérfanos: un archivo del almacén sin fila (caída entre rename e insert) se repara y no se confunde con una referencia', () => {
  const p = proyecto('ev-huerfano');
  try {
    const g = store.guardar(p.root, { text: 'conocido' }, { retention: 'durable_audit' });
    const hash = crypto.createHash('sha256').update('perdido').digest('hex');
    const destino = store.rutaObjeto(p.root, hash);
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(destino, 'perdido');
    const viejo = new Date(Date.now() - 3 * 3600 * 1000);
    fs.utimesSync(destino, viejo, viejo);
    const r = store.limpiar(p.root, {});
    assert.deepEqual(r.orphans_removed, [hash]);
    assert.equal(store.verificar(p.root, g.evidence_id).status, 'OK');
  } finally { p.limpiar(); }
});

test('referencia a archivo del proyecto (copy:false): se verifica al recuperar y detecta el cambio', () => {
  const p = proyecto('ev-ref-archivo');
  try {
    fs.mkdirSync(path.join(p.root, '_output'));
    fs.writeFileSync(path.join(p.root, '_output', 'tests.log'), 'PASS 3/3');
    const r = store.guardarArchivo(p.root, '_output/tests.log', { copy: false, kind: 'test_log', retention: 'durable_audit' });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.store, 'project_file');
    assert.equal(store.obtener(p.root, r.evidence_id, {}).content, 'PASS 3/3');
    fs.writeFileSync(path.join(p.root, '_output', 'tests.log'), 'FAIL 1/3');
    assert.equal(store.obtener(p.root, r.evidence_id, {}).status, 'EVIDENCE_CHANGED');
    // Con copy:true (gates) el original queda en el almacén durable y no depende del archivo.
    const c = store.guardarArchivo(p.root, '_output/tests.log', { kind: 'test_log' });
    assert.equal(c.ok, true);
    fs.rmSync(path.join(p.root, '_output', 'tests.log'));
    assert.equal(store.obtener(p.root, c.evidence_id, {}).content, 'FAIL 1/3');
  } finally { p.limpiar(); }
});

test('payload enorme: se pagina por bloques sin cargar el archivo entero en una sola lectura', () => {
  const p = proyecto('ev-enorme');
  try {
    const grande = ('x'.repeat(99) + '\n').repeat(60000); // ~6 MB
    const g = store.guardar(p.root, { text: grande }, { kind: 'tool_output', max_object_bytes: 8 * 1024 * 1024 });
    assert.ok(g.ok);
    const antes = process.memoryUsage().heapUsed;
    const o = store.obtener(p.root, g.evidence_id, { line_from: 59990, line_to: 60000 });
    assert.equal(o.content.split('\n').length, 11);
    assert.ok(Buffer.byteLength(o.content) < 4000);
    assert.ok(process.memoryUsage().heapUsed - antes < 40 * 1024 * 1024, 'la página no retiene el archivo');
    const pagina = store.obtener(p.root, g.evidence_id, { length: 10 * 1024 * 1024 });
    assert.ok(pagina.delivered_bytes <= store.LIMITES.max_page_bytes, 'una página nunca excede el máximo');
    assert.equal(pagina.has_more, true);
  } finally { p.limpiar(); }
});

test('la lectura no migra ni crea la base: sin memoria.db → NO_DB, sin tablas → SCHEMA_MISSING', () => {
  const sin = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-ev-sinbase-'));
  const q = proyecto('ev-sin-tablas', { catalogo: false, nodos: 0 });
  try {
    assert.equal(store.verificar(sin, 'ev_' + 'a'.repeat(40)).status, 'NO_DB');
    assert.equal(fs.existsSync(path.join(sin, '.agentic', 'memoria.db')), false);
    const antes = fs.readFileSync(q.dbPath);
    assert.equal(store.verificar(q.root, 'ev_' + 'a'.repeat(40)).status, 'SCHEMA_MISSING');
    assert.equal(store.estadisticas(q.root).code, 'SCHEMA_MISSING');
    assert.deepEqual(fs.readFileSync(q.dbPath), antes);
    void dba;
  } finally { q.limpiar(); fs.rmSync(sin, { recursive: true, force: true }); }
});
