'use strict';
// Canarios: valores FALSOS con formato de secreto, codificados para que el escáner de secretos del repo no los confunda con una filtración real.
const dec = (b) => Buffer.from(b, 'base64').toString('utf8');
/* C03 + H03 — Salud funcional, panel Memoria y panel Contexto y esfuerzo del dashboard (3.20.1).
 *
 * Qué prueba y con qué: proyectos temporales con una memoria.db REAL (schema.sql + catálogo, la misma
 * construcción que hace el motor) y el dashboard REAL arrancado como proceso. Las actividades capturadas
 * son FIXTURES inyectadas por la API de captura de memory-core: NO provienen de Cursor ni de Claude Code,
 * así que nada de aquí demuestra captura nativa de un host. Navegador real: no se usa (ver informe).
 */
const test = require('node:test');
const { SIN_DRIVER } = require('./helpers/db-real.cjs');
if (SIN_DRIVER) { test(require('node:path').basename(__filename) + ' (omitido: ' + SIN_DRIVER + ')', { skip: SIN_DRIVER }, () => {}); return; }
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const { proyecto, REPO, dba, catalogo } = require('./helpers/memoria-proyecto.cjs');
const { arrancarDashboard } = require('./fixtures/dashboard-fixture.cjs');

const G = path.join(REPO, '.agentic', 'grafo');
const core = require(path.join(G, 'memory-core.cjs'));
const queue = require(path.join(G, 'memory-queue.cjs'));
const salud = require(path.join(G, 'memoria-salud.cjs'));
const panel = require(path.join(G, 'memoria-panel.cjs'));
const usage = require(path.join(G, 'context-usage.cjs'));
const evidence = require(path.join(G, 'evidence-store.cjs'));
const paginas = require(path.join(G, 'memoria-pagina.cjs'));

const SCHEMA = fs.readFileSync(path.join(G, 'schema.sql'), 'utf8');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const hasta = async (cond, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (cond()) return true; await esperar(40); } return false; };

/** Proyecto con config.md (el dashboard lo exige). */
function montar(nombre, opts) {
  const p = proyecto(nombre, opts);
  fs.writeFileSync(path.join(p.root, '.agentic', 'config.md'), '# Configuración\n\nCONFIGURADO: SI\n');
  return p;
}
/** Igual, pero en una ruta con un nombre de carpeta dado (para dos proyectos con el MISMO nombre). */
function montarEn(padre, nombre) {
  const root = path.join(fs.realpathSync(padre), nombre);
  const dbPath = path.join(root, '.agentic', 'memoria.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(path.join(root, '.agentic', 'config.md'), '# Configuración\n\nCONFIGURADO: SI\n');
  dba.initialize(dbPath, SCHEMA);
  const db = dba.openWrite(dbPath, { updateOwner: true });
  try { catalogo.apply(db, { version: '3.20.1', actor: 'test' }); } finally { db.close(); }
  return { root, dbPath };
}
const adaptador = (root, extra) => core.crearAdaptador(root, { host: 'fixture-host', session_id: 'sesion-1', task_id: 'T-1', role: 'builder', ...extra });
const get = async (d, ruta, init) => { const r = await fetch(d.url.replace(/\/$/, '') + ruta, init); const texto = await r.text(); let json = null; try { json = JSON.parse(texto); } catch { /* no JSON */ } return { status: r.status, texto, json, headers: r.headers }; };

/** POST con control total de cabeceras (fetch no deja fijar Origin como un navegador). */
function post(d, ruta, { cabeceras = {}, cuerpo = '{}' } = {}) {
  const u = new URL(d.url);
  return new Promise((res, rej) => {
    const req = http.request({ host: u.hostname, port: u.port, path: ruta, method: 'POST', headers: { Host: u.host, 'Content-Length': Buffer.byteLength(cuerpo), ...cabeceras } }, (r) => {
      let t = ''; r.setEncoding('utf8'); r.on('data', (x) => { t += x; }); r.on('end', () => { let j = null; try { j = JSON.parse(t); } catch { /* no JSON */ } res({ status: r.statusCode, texto: t, json: j }); });
    });
    req.on('error', rej); req.end(cuerpo);
  });
}
const cabeceraOk = (d) => ({ Origin: 'http://' + new URL(d.url).host, 'Content-Type': 'application/json', 'X-Akdd-Action': 'memory-retry' });

/** SSE: junta eventos { id, tipo, data } y el texto crudo. */
function sse(url, headers) {
  const eventos = []; let crudo = ''; let req;
  const listo = new Promise((res, rej) => {
    req = http.get(url, { headers: Object.assign({ Accept: 'text/event-stream' }, headers) }, (r) => {
      let buf = ''; r.setEncoding('utf8');
      r.on('data', (d) => {
        crudo += d; buf += d; let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const bloque = buf.slice(0, i); buf = buf.slice(i + 2); const ev = {};
          for (const l of bloque.split('\n')) { const m = /^(id|event|data): (.*)$/.exec(l); if (m) ev[m[1]] = m[2]; }
          if (ev.event) eventos.push({ id: Number(ev.id), tipo: ev.event, data: JSON.parse(ev.data) });
        }
      });
      res(r);
    });
    req.on('error', rej);
  });
  return { eventos, listo, crudo: () => crudo, cerrar: () => req.destroy() };
}

const TODO = {}; // limpieza al final
const limpiable = (p) => { (TODO.lista = TODO.lista || []).push(p); return p; };
test.after(() => { for (const p of TODO.lista || []) { try { if (p.limpiar) p.limpiar(); else fs.rmSync(path.dirname(p.root), { recursive: true, force: true }); } catch { /* en uso */ } } });

// ───────────────────────────── salud ─────────────────────────────────────────
test('salud: mirar NO escribe; la escritura se verifica con un comando explícito, con fecha, y esa verificación caduca', () => {
  const p = limpiable(montar('salud'));
  const antes = sha(p.dbPath);
  const h = salud.leer(p.root);
  assert.equal(h.status, 'READY');
  assert.equal(h.ready, true);
  assert.deepEqual(Object.keys(h.checks), ['service_available', 'db_readable', 'schema_compatible', 'memory_search_ready', 'memory_write_verified_at', 'queue_healthy', 'update_state']);
  assert.equal(h.checks.memory_write_verified_at.status, 'NOT_VERIFIED', 'sin comando explícito la escritura NO está verificada');
  assert.equal(h.verified_complete, false, 'READY no es "todo verificado"');
  for (const c of Object.values(h.checks)) { assert.ok(c.source && c.scope, c.name + ': fuente y alcance'); assert.ok('checked_at' in c && 'age_ms' in c && 'expires_at' in c, c.name + ': fecha, antigüedad y expiración'); }
  assert.equal(sha(p.dbPath), antes, 'leer la salud no modifica la base');

  const n0 = (() => { const d = p.abrirR(); try { return d.get('SELECT count(*) AS n FROM nodos').n; } finally { d.close(); } })();
  const v = salud.verificarEscritura(p.root);
  assert.equal(v.status, 'PASS', JSON.stringify(v));
  assert.equal(v.copy, 'PASS'); assert.equal(v.real, 'PASS'); assert.equal(v.persisted, true);
  const d = p.abrirR();
  try {
    assert.equal(d.get('SELECT count(*) AS n FROM nodos').n, n0, 'la prueba no deja filas');
    assert.equal(d.get("SELECT count(*) AS n FROM nodos WHERE titulo LIKE '__verificacion%'").n, 0);
    assert.equal(d.get("SELECT count(*) AS n FROM mem_health WHERE check_name = 'write_verification'").n, 1);
  } finally { d.close(); }
  const h2 = salud.leer(p.root);
  assert.equal(h2.checks.memory_write_verified_at.status, 'OK');
  assert.equal(h2.checks.memory_write_verified_at.checked_at, v.checked_at);
  assert.ok(h2.checks.memory_write_verified_at.expires_at, 'la verificación trae su expiración');
  // Pasadas 25 h la caché ya no demuestra nada sobre hoy.
  const h3 = salud.leer(p.root, { now: Date.now() + 25 * 3600 * 1000 });
  assert.equal(h3.checks.memory_write_verified_at.status, 'STALE');
  assert.equal(h3.checks.memory_write_verified_at.expired, true);
  assert.ok(h3.needs_attention.includes('memory_write_verified_at'));
});

test('salud: servicio vivo + esquema roto => NOT_READY (no verde) y HTTP 503 en readiness, y lo dice en lenguaje simple', async () => {
  const p = limpiable(montar('roto'));
  const w = p.abrirW(); try { w.exec('DROP TABLE mem_jobs'); } finally { w.close(); }
  const h = salud.leer(p.root);
  assert.equal(h.checks.service_available.status, 'OK', 'el servicio responde');
  assert.equal(h.checks.schema_compatible.status, 'FAIL');
  assert.equal(h.status, 'NOT_READY');
  assert.equal(h.ready, false);
  assert.ok(h.failing.includes('schema_compatible') && h.failing.includes('memory_search_ready'));
  assert.ok(h.actions.some((a) => a.action === 'akdd update'), 'indica la acción');
  assert.match(h.explanation, /NO está lista/);
  const d = await arrancarDashboard(p.root);
  try {
    const r = await get(d, '/api/v1/memory-health');
    assert.equal(r.status, 503, 'readiness falla aunque el servicio responda');
    assert.equal(r.json.data.ready, false);
    assert.equal(r.json.data.status, 'NOT_READY');
    assert.equal(r.json.reason_code, 'NOT_READY');
    assert.equal(r.json.data.checks.service_available.status, 'OK');
  } finally { d.cerrar(); }
});

test('salud: BD de solo lectura => la búsqueda funciona, la escritura muestra la limitación real', async (t) => {
  const p = limpiable(montar('solo-lectura'));
  assert.equal(salud.verificarEscritura(p.root).status, 'PASS'); // verificada ANTES de que cambie el permiso
  fs.chmodSync(p.dbPath, 0o444);
  try {
    try { fs.accessSync(p.dbPath, fs.constants.W_OK); t.skip('este sistema no hace efectivo el permiso de solo lectura'); return; } catch { /* es de solo lectura de verdad */ }
    const h = salud.leer(p.root);
    assert.equal(h.checks.memory_search_ready.status, 'OK', 'buscar funciona');
    assert.equal(h.checks.db_readable.status, 'OK');
    assert.equal(h.checks.memory_write_verified_at.status, 'FAIL');
    assert.equal(h.checks.memory_write_verified_at.code, 'BD_SOLO_LECTURA');
    assert.match(h.checks.memory_write_verified_at.detail, /hoy el permiso cambió/, 'no se fía de la caché antigua');
    assert.equal(h.status, 'DEGRADED');
    assert.equal(h.ready, true, 'se puede leer: no es NOT_READY');
    const v = salud.verificarEscritura(p.root);
    assert.equal(v.status, 'FAIL');
    assert.equal(v.code, 'BD_SOLO_LECTURA');
    assert.equal(v.copy, 'PASS', 'la copia pasa: por eso la base real se prueba aparte');
    assert.equal(v.persisted, false);
    // El panel sigue listando (lectura).
    assert.equal(panel.listar(p.root, { kind: 'knowledge' }).status, 'OK');
  } finally { fs.chmodSync(p.dbPath, 0o666); }
});

test('salud: falta una tabla nueva => diagnóstico con la acción; leer jamás migra ni crea tablas', async () => {
  const p = limpiable(montar('sin-tablas', { catalogo: false, nodos: 0 }));
  const antes = sha(p.dbPath);
  const tablas = () => { const d = p.abrirR(); try { return d.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY 1").map((r) => r.name); } finally { d.close(); } };
  const t0 = tablas();
  const d = await arrancarDashboard(p.root);
  try {
    const h = (await get(d, '/api/v1/memory-health')).json.data;
    assert.equal(h.status, 'NOT_READY');
    assert.match(h.checks.schema_compatible.detail, /mem_events|faltan las tablas|migraci/);
    assert.equal(h.checks.schema_compatible.action, 'akdd update');
    const m = (await get(d, '/api/v1/memory')).json.data;
    assert.equal(m.schema_ready, false);
    assert.ok(m.missing_tables.includes('mem_events'));
    assert.equal(m.inventory.events_total, null, 'no hay tabla: NO disponible, no 0');
    assert.equal(m.inventory.observations_by_status, null);
    assert.equal(m.queue.available, false);
    const lista = (await get(d, '/api/v1/memory-items?kind=events')).json;
    assert.equal(lista.status, 'UNAVAILABLE'); assert.equal(lista.reason_code, 'SCHEMA_MISSING'); assert.match(lista.accion, /akdd update/);
    const ctx = (await get(d, '/api/v1/context')).json;
    assert.equal(ctx.data.totals, null, 'sin tabla de uso: no disponible'); assert.equal(ctx.data.available, true);
    assert.ok(ctx.data.degradations.some((x) => x.code === 'SIN_TABLAS'));
  } finally { d.cerrar(); }
  assert.deepEqual(tablas(), t0, 'ninguna tabla nueva apareció por mirar');
  assert.equal(sha(p.dbPath), antes, 'la base no cambió ni un byte');
});

test('actualización con tablas nuevas: lo anterior se conserva y se ve como "sin procedencia", sin reescribirlo (FIXTURE: base 3.19 simulada con schema.sql)', () => {
  const p = limpiable(montar('upgrade', { catalogo: false, nodos: 0 }));
  const w = p.abrirW();
  try { for (let i = 0; i < 4; i++) w.run('INSERT INTO nodos (tipo, titulo, contenido, area, confianza) VALUES (?,?,?,?,?)', ['patron', 'REGLA_ANTIGUA_' + i, 'Memoria original ' + i, 'auth', 'ALTA']); } finally { w.close(); }
  assert.equal(panel.resumen(p.root).data.schema_ready, false);
  const w2 = p.abrirW(); try { catalogo.apply(w2, { version: '3.20.1', actor: 'test' }); } finally { w2.close(); } // lo que hace akdd update
  const m = panel.resumen(p.root).data;
  assert.equal(m.schema_ready, true);
  assert.equal(m.inventory.nodes_total, 4, 'ningún nodo anterior se perdió');
  assert.equal(m.inventory.legacy_without_provenance, 4, 'todos quedan etiquetados al leer');
  const l = panel.listar(p.root, { kind: 'knowledge' });
  assert.ok(l.data.every((x) => x.provenance === 'LEGACY_UNVERIFIED_PROVENANCE' && x.epistemic === 'asserted'));
  const d = p.abrirR(); try { assert.equal(d.get('SELECT count(*) AS n FROM mem_knowledge').n, 0, 'no se reescribió ni se rebajó nada en masa'); } finally { d.close(); }
});

// ───────────────────────────── cola y reintento ──────────────────────────────
test('cola atascada: estado visible y reintento seguro, validado, limitado y registrado; nunca borra memoria', async () => {
  const p = limpiable(montar('cola'));
  const a = adaptador(p.root);
  const e1 = a.registrar({ event_type: 'decision', input: 'Usar idempotencia en cobros', paths: ['src/pagos.js'] });
  const e2 = a.registrar({ event_type: 'file_edit', paths: ['src/a.js'] });
  assert.ok(e1.ok && e2.ok);
  const hace2h = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const w = p.abrirW();
  try {
    w.run("UPDATE mem_jobs SET state='DEAD_LETTER', attempts=5, error_code='PROCESS_FAILED', updated_at=? WHERE job_id=?", hace2h, e1.job_id);
    w.run("UPDATE mem_jobs SET created_at=?, next_attempt_at=? WHERE job_id=?", hace2h, hace2h, e2.job_id);
  } finally { w.close(); }
  const h = salud.leer(p.root);
  assert.equal(h.checks.queue_healthy.status, 'FAIL');
  assert.match(h.checks.queue_healthy.detail, /fallido|sin procesarse/);
  const d = await arrancarDashboard(p.root);
  try {
    const m = (await get(d, '/api/v1/memory')).json.data.queue;
    assert.equal(m.failed, 1); assert.equal(m.pending, 1); assert.equal(m.healthy, false);
    assert.ok(m.oldest_pending_age_ms > 1.5 * 3600 * 1000, 'antigüedad visible');
    assert.equal(m.dead_letter[0].job_id, e1.job_id); assert.equal(m.dead_letter[0].can_retry, true);

    // Validaciones de la acción: origen, cabecera, tipo de contenido, id.
    const b = JSON.stringify({ job_id: e1.job_id });
    assert.equal((await post(d, '/api/v1/memory-retry', { cuerpo: b, cabeceras: { 'Content-Type': 'application/json', 'X-Akdd-Action': 'memory-retry' } })).status, 403, 'sin Origin');
    assert.equal((await post(d, '/api/v1/memory-retry', { cuerpo: b, cabeceras: { ...cabeceraOk(d), Origin: 'http://evil.example' } })).status, 403, 'otro origen');
    assert.equal((await post(d, '/api/v1/memory-retry', { cuerpo: b, cabeceras: { Origin: cabeceraOk(d).Origin, 'Content-Type': 'application/json' } })).status, 403, 'sin cabecera de acción');
    assert.equal((await post(d, '/api/v1/memory-retry', { cuerpo: b, cabeceras: { ...cabeceraOk(d), 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal((await post(d, '/api/v1/memory-retry', { cuerpo: JSON.stringify({ job_id: "x'; DROP TABLE nodos;--" }), cabeceras: cabeceraOk(d) })).status, 400, 'id inválido');
    assert.equal((await post(d, '/api/v1/memory-retry', { cuerpo: JSON.stringify({ job_id: 'job_' + 'a'.repeat(32) }), cabeceras: cabeceraOk(d) })).status, 404, 'job inexistente');
    assert.equal((await post(d, '/api/v1/memory-retry', { cuerpo: JSON.stringify({ job_id: e2.job_id }), cabeceras: cabeceraOk(d) })).status, 409, 'solo se reintenta lo muerto, no lo pendiente');
    const inventarioAntes = panel.resumen(p.root).data.inventory;

    const ok = await post(d, '/api/v1/memory-retry', { cuerpo: b, cabeceras: cabeceraOk(d) });
    assert.equal(ok.status, 200, ok.texto);
    assert.equal(ok.json.data.state, 'PENDING'); assert.equal(ok.json.data.manual_retries, 1);
    const dd = p.abrirR();
    try {
      assert.equal(dd.get('SELECT state FROM mem_jobs WHERE job_id = ?', e1.job_id).state, 'PENDING');
      const reg = dd.get("SELECT status, detail FROM mem_health WHERE check_name = 'manual_retry' AND scope = ?", e1.job_id);
      assert.equal(reg.status, 'OK', 'el reintento queda registrado');
    } finally { dd.close(); }
    const inventarioDespues = panel.resumen(p.root).data.inventory;
    assert.equal(inventarioDespues.nodes_total, inventarioAntes.nodes_total, 'no se borró memoria');
    assert.equal(inventarioDespues.events_total, inventarioAntes.events_total);

    // Límite por job: tras 3 reintentos manuales ya no.
    const w3 = p.abrirW(); try { w3.run("UPDATE mem_jobs SET state='DEAD_LETTER', manual_retries=3 WHERE job_id=?", e1.job_id); } finally { w3.close(); }
    const tope = await post(d, '/api/v1/memory-retry', { cuerpo: b, cabeceras: cabeceraOk(d) });
    assert.equal(tope.status, 409); assert.equal(tope.json.reason_code, 'REINTENTOS_AGOTADOS');
    const q2 = (await get(d, '/api/v1/memory')).json.data.queue;
    assert.equal(q2.dead_letter[0].can_retry, false); assert.equal(q2.dead_letter[0].retries_left, 0);
    // Ninguna otra ruta escribe: no existe forma de pasar observado a validado desde el navegador.
    for (const ruta of ['/api/v1/memory-validate', '/api/v1/memory', '/api/v1/memory-item']) assert.equal((await post(d, ruta, { cuerpo: '{}', cabeceras: cabeceraOk(d) })).status, 405, ruta);
  } finally { d.cerrar(); }
});

// ───────────────────────────── aislamiento ───────────────────────────────────
test('dos proyectos con el MISMO nombre: aislamiento completo; el project_id del navegador no abre otro proyecto; una copia ajena no se lista', async () => {
  const padreA = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-iso-a-')); const padreB = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-iso-b-'));
  const A = montarEn(padreA, 'proyecto'); const B = montarEn(padreB, 'proyecto');
  limpiable({ root: A.root, limpiar: () => fs.rmSync(padreA, { recursive: true, force: true }) }); limpiable({ root: B.root, limpiar: () => fs.rmSync(padreB, { recursive: true, force: true }) });
  assert.ok(adaptador(A.root).registrar({ event_type: 'decision', input: 'SOLO_DE_A secreto de negocio A', paths: ['a.js'] }).ok);
  assert.ok(adaptador(B.root).registrar({ event_type: 'decision', input: 'SOLO_DE_B', paths: ['b.js'] }).ok);
  const dA = await arrancarDashboard(A.root); const dB = await arrancarDashboard(B.root);
  try {
    const a = (await get(dA, '/api/v1/memory-items?kind=events')).json; const b = (await get(dB, '/api/v1/memory-items?kind=events')).json;
    assert.equal(a.data.length, 1); assert.equal(b.data.length, 1);
    assert.match(a.data[0].summary, /SOLO_DE_A/); assert.match(b.data[0].summary, /SOLO_DE_B/);
    assert.ok(!JSON.stringify(a).includes('SOLO_DE_B') && !JSON.stringify(b).includes('SOLO_DE_A'), 'ninguna fuga entre proyectos');
    // El proyecto sale del servidor: cambiar el parámetro no abre otro.
    assert.equal((await get(dA, '/api/v1/memory-items?kind=events&project_id=otro-proyecto')).status, 404);
    const idB = core.identidad(B.root).project_id;
    assert.equal((await get(dA, '/api/v1/memory-items?kind=events&project_id=' + idB)).status, 404, 'tampoco con el id interno del otro proyecto');
    assert.ok(!JSON.stringify((await get(dA, '/api/v1/memory')).json).includes(idB), 'el id interno no se expone');
    assert.equal((await get(dA, '/api/v1/memory-items?kind=events&sql=select*from%20mem_events')).status, 400, 'ningún parámetro libre');
  } finally { dA.cerrar(); dB.cerrar(); }
  // Copia de la memoria de A llevada a otra ruta: ROOT_MISMATCH => no se listan sus actividades.
  const padreC = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-iso-c-'));
  limpiable({ root: path.join(padreC, 'x'), limpiar: () => fs.rmSync(padreC, { recursive: true, force: true }) });
  const C = path.join(padreC, 'copia'); fs.mkdirSync(path.join(C, '.agentic'), { recursive: true });
  fs.copyFileSync(A.dbPath, path.join(C, '.agentic', 'memoria.db'));
  const m = panel.resumen(C).data;
  assert.equal(m.identity.state, 'ROOT_MISMATCH');
  assert.match(m.identity.hint, /otra ruta/);
  assert.equal(panel.listar(C, { kind: 'events' }).status, 'EMPTY', 'las actividades de A no se muestran en la copia');
  assert.equal(panel.detalle(C, { kind: 'events', id: panel.listar(A.root, { kind: 'events' }).data[0].event_id }).status, 'EMPTY');
});

// ───────────────────────────── texto, redacción y privacidad ─────────────────
test('XSS: un <script> o <img onerror> en título/contenido/evento es TEXTO — el cuerpo de la API nunca lo trae literal y la página usa textContent', async () => {
  const p = limpiable(montar('xss'));
  const A = '<script>alert(1)</script><img src=x onerror=alert(2)>';
  assert.ok(adaptador(p.root).registrar({ event_type: 'tool_error', input: A, output: 'falló ' + A, paths: ['src/<b>x</b>.js'] }).ok);
  const k = core.proponerConocimiento(p.root, { tipo: 'decision', area: 'xss', titulo: A + ' título', contenido: 'contenido ' + A, archivos: ['src/x.js'] });
  assert.ok(k.ok);
  await queue.drenar(p.root);
  const d = await arrancarDashboard(p.root);
  try {
    const rutas = ['/api/v1/memory', '/api/v1/memory-items?kind=events', '/api/v1/memory-items?kind=observations', '/api/v1/memory-items?kind=knowledge', '/api/v1/memory-item?kind=knowledge&id=' + k.node_id, '/api/v1/context'];
    for (const ruta of rutas) {
      const r = await get(d, ruta);
      assert.ok(r.json, ruta + ' es JSON');
      assert.ok(!/<script|<img|<b>/i.test(r.texto), ruta + ': el cuerpo no contiene HTML literal');
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    }
    const det = (await get(d, '/api/v1/memory-item?kind=knowledge&id=' + k.node_id)).json.data.item;
    assert.ok(det.contenido.includes('<script>alert(1)</script>'), 'al decodificar, el texto se conserva TAL CUAL como texto');
    const ev = (await get(d, '/api/v1/memory-items?kind=events')).json.data[0];
    assert.ok(ev.summary.includes('<script>'));
  } finally { d.cerrar(); }
  for (const [nombre, html] of [['memoria', paginas.MEMORIA_HTML], ['contexto', paginas.CONTEXTO_HTML]]) {
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|\bsrcdoc\b|javascript:/.test(html), nombre + ': nada interpreta datos como HTML');
    assert.ok(/textContent/.test(html));
    assert.ok(!/<script src=|<link [^>]*href="https?:|https?:\/\/(?!www\.w3\.org)/.test(html), nombre + ': sin recursos externos');
  }
});

test('evento REDACTADO o PRIVADO: el original no está por detalle, listado, exportación, SSE ni en la propia base', async () => {
  const p = limpiable(montar('redactado'));
  const SECRETOS = [dec('c2tfbGl2ZV9BQkNERUZHSDEyMzQ1Njc4'), 'abcdefghijklmnopqrstuvwxyz0123456789', 'hunter2hunter2', 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'];
  const a = adaptador(p.root);
  const rojo = a.registrar({ event_type: 'tool_error', input: { clave: SECRETOS[0], nota: 'ok' }, output: 'Authorization: Bearer ' + SECRETOS[1] + ' y ' + SECRETOS[3], paths: ['src/api.js'] });
  const priv = a.registrar({ event_type: 'file_edit', input: 'DB_PASSWORD=' + SECRETOS[2], output: 'contenido del .env ' + SECRETOS[2], paths: ['.env'] });
  assert.ok(rojo.ok && priv.ok);
  assert.equal(priv.privacy_class, 'private');
  await queue.drenar(p.root);
  const d = await arrancarDashboard(p.root, { AKDD_DASH_POLL_MS: '150' });
  const stream = sse(d.url.replace(/\/$/, '') + '/api/v1/events?topics=memory');
  await stream.listo;
  try {
    const crudos = [];
    for (const ruta of ['/api/v1/memory-items?kind=events', '/api/v1/memory-items?kind=observations', '/api/v1/memory-item?kind=events&id=' + rojo.event_id, '/api/v1/memory-item?kind=events&id=' + priv.event_id, '/api/v1/memory']) crudos.push((await get(d, ruta)).texto);
    crudos.push(JSON.stringify(panel.exportar(p.root, { kind: 'events' })), JSON.stringify(panel.exportar(p.root, { kind: 'observations' })));
    // Un evento nuevo mientras el SSE está abierto.
    assert.ok(a.registrar({ event_type: 'tool_error', output: 'otro ' + SECRETOS[0] }).ok);
    await hasta(() => stream.eventos.length >= 2, 4000);
    crudos.push(stream.crudo());
    crudos.push(fs.readFileSync(p.dbPath, 'latin1'));
    for (const s of SECRETOS) for (const c of crudos) assert.ok(!c.includes(s), 'aparece el secreto ' + s.slice(0, 8) + '…');
    const det = (await get(d, '/api/v1/memory-item?kind=events&id=' + priv.event_id)).json.data;
    assert.equal(det.item.summary_hidden, true); assert.equal(det.item.summary, null); assert.equal(det.item.input_summary, null); assert.deepEqual(det.files, []);
    assert.match(det.explanation, /privad/);
    const red = (await get(d, '/api/v1/memory-item?kind=events&id=' + rojo.event_id)).json.data;
    assert.match(red.item.input_summary + red.item.output_summary, /\[REDACTADO\]/);
    // El SSE solo lleva sellos: nada de contenido.
    for (const e of stream.eventos) assert.deepEqual(e.tipo === 'memory' || e.tipo === 'snapshot', true, JSON.stringify(e)); 
    for (const e of stream.eventos) assert.deepEqual(Object.keys(e.data).filter((k) => !['memory_stamp', 'context_stamp', 'at', 'motivo'].includes(k)), []);
  } finally { stream.cerrar(); d.cerrar(); }
});

// ───────────────────────────── base enorme ───────────────────────────────────
test('BD enorme: paginación por cursor con tamaño de página acotado y memoria acotada (30 000 actividades)', async () => {
  const p = limpiable(montar('enorme', { nodos: 50 }));
  assert.ok(adaptador(p.root).registrar({ event_type: 'decision', input: 'semilla', paths: [] }).ok);
  const pid = core.identidad(p.root).project_id; const raiz = core.canonicalRoot(p.root);
  const w = p.abrirW();
  try {
    const ins = w.prepare('INSERT INTO mem_events (event_id, schema_version, project_id, canonical_project_root, session_id, host, host_event_id, event_type, sequence, occurred_at, received_at, status, paths, input_summary, output_summary, evidence_refs, redaction_version, privacy_class, attempts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    w.transaction(() => {
      for (let i = 0; i < 30000; i++) ins.run('evt_' + String(i).padStart(32, '0'), 1, pid, raiz, 'masiva', 'fixture-host', 'h' + i, i % 7 === 0 ? 'file_edit' : 'tool_call', i + 10, '2026-09-01T10:00:00.000Z', '2026-09-01T10:00:00.000Z', 'CAPTURED', '["src/a.js"]', 'entrada ' + i, 'salida '.repeat(30) + i, '[]', 'r1', 'authorized', 1);
    })();
  } finally { w.close(); }
  global.gc && global.gc();
  const base = process.memoryUsage().heapUsed;
  const r = panel.listar(p.root, { kind: 'events', limit: 200 });
  assert.equal(r.data.length, 200); assert.ok(r.coverage.truncated); assert.ok(r.coverage.next_cursor);
  assert.ok(process.memoryUsage().heapUsed - base < 40 * 1024 * 1024, 'una página no carga la tabla en memoria');
  // Resumen y salud con 30 000 filas: siguen acotados en tamaño y tiempo.
  const t0 = Date.now(); const m = panel.resumen(p.root); assert.ok(Date.now() - t0 < 5000, 'el resumen no recorre la historia entera de forma lenta');
  assert.equal(m.data.inventory.events_total, 30001);
  // Recorrido por la API: páginas sin repetir ni saltar, siempre acotadas.
  const d = await arrancarDashboard(p.root);
  try {
    assert.equal((await get(d, '/api/v1/memory-items?kind=events&limit=999')).status, 400, 'el tamaño de página tiene tope');
    const vistos = new Set(); let cursor = null; let paginas = 0;
    while (paginas < 4) {
      const j = (await get(d, '/api/v1/memory-items?kind=events&limit=200' + (cursor ? '&cursor=' + cursor : ''))).json;
      assert.equal(j.data.length, 200);
      assert.ok(JSON.stringify(j).length < 400 * 1024, 'cuerpo acotado');
      for (const e of j.data) { assert.ok(!vistos.has(e.event_id), 'sin repetidos entre páginas'); vistos.add(e.event_id); }
      cursor = j.coverage.next_cursor; paginas++;
    }
    assert.equal(vistos.size, 800);
    const filtrado = (await get(d, '/api/v1/memory-items?kind=events&type=file_edit&limit=50')).json;
    assert.ok(filtrado.data.every((e) => e.event_type === 'file_edit'), 'los filtros se aplican en la base, no en memoria');
  } finally { d.cerrar(); }
});

// ───────────────────────────── procedencia visible ───────────────────────────
test('conocimiento: se rastrea hasta su actividad y evidencia; afirmado / observado / verificado nunca se mezclan; ningún botón valida', async () => {
  const p = limpiable(montar('procedencia'));
  const a = adaptador(p.root);
  const ev = a.registrar({ event_type: 'decision', input: 'Todo cobro usa clave de idempotencia', paths: ['src/pagos.js'] });
  assert.ok(ev.ok);
  const r = await queue.drenar(p.root);
  assert.equal(r.knowledge, 1);
  const lista = panel.listar(p.root, { kind: 'knowledge', provenance: 'OBSERVED' });
  assert.equal(lista.data.length, 1);
  const nodo = lista.data[0];
  assert.equal(nodo.state, 'PROPOSED'); assert.equal(nodo.epistemic, 'observed');
  let det = panel.detalle(p.root, { kind: 'knowledge', id: nodo.node_id }).data;
  assert.equal(det.validation.epistemic, 'observed');
  assert.ok(det.events.includes(ev.event_id), 'rastreable hasta la actividad');
  assert.ok(det.observations.length >= 1);
  assert.equal(det.validation.evidence_current, null, 'sin evidencia: no se dice "vigente"');
  assert.match(det.explanation, /NO lo validan|falta evidencia/);
  assert.deepEqual(det.files, ['src/pagos.js']);
  // Lo antiguo sin procedencia: afirmado.
  const viejo = panel.listar(p.root, { kind: 'knowledge', provenance: 'LEGACY_UNVERIFIED_PROVENANCE' });
  assert.equal(viejo.data.length, 3); assert.ok(viejo.data.every((x) => x.epistemic === 'asserted'));
  assert.equal(panel.detalle(p.root, { kind: 'knowledge', id: viejo.data[0].node_id }).data.origin.legacy, true);
  // Evidencia real + validación por quien puede (no el modelo): pasa a verificado y la evidencia se ve.
  const e = evidence.guardar(p.root, { text: 'resultado de la prueba: PASS 12/12' }, { kind: 'test_result', task_id: 'T-1', retention: 'durable_audit' });
  assert.ok(e.ok);
  assert.ok(core.validarConocimiento(p.root, nodo.node_id, { evidence_ids: [e.evidence_id], validated_by: 'test', criterio: 'prueba verde' }).ok);
  det = panel.detalle(p.root, { kind: 'knowledge', id: nodo.node_id }).data;
  assert.equal(det.validation.epistemic, 'verified'); assert.equal(det.validation.validated_by, 'test');
  assert.equal(det.validation.evidence_current, true);
  assert.equal(det.evidence[0].evidence_id, e.evidence_id); assert.equal(det.evidence[0].status, 'AVAILABLE');
  assert.ok(!('locator' in det.evidence[0]), 'no se expone la ubicación interna del almacén');
  // Detalle de la observación y del evento: el camino de vuelta.
  const obsId = det.observations[0];
  const dObs = panel.detalle(p.root, { kind: 'observations', id: obsId }).data;
  assert.equal(dObs.item.epistemic, 'observed'); assert.ok(dObs.events.some((x) => x.event_id === ev.event_id));
  assert.ok(dObs.knowledge.some((k) => k.node_id === nodo.node_id));
  const dEv = panel.detalle(p.root, { kind: 'events', id: ev.event_id }).data;
  assert.equal(dEv.processing.state, 'DONE'); assert.equal(dEv.origin.host, 'fixture-host');
  assert.ok(dEv.knowledge.some((k) => k.node_id === nodo.node_id));
  // Un resumen de modelo es "afirmado", no "observado".
  assert.equal(core.observar(p.root, { event_ids: [ev.event_id], kind: 'summary_model', summary: 'el modelo cree que…', processor: 'summarizer' }).ok, true);
  assert.ok(panel.listar(p.root, { kind: 'observations', type: 'summary_model' }).data.every((o) => o.epistemic === 'asserted'));
  // Inventario con huecos y vigencia.
  const inv = panel.resumen(p.root).data;
  assert.equal(inv.inventory.legacy_without_provenance, 3);
  assert.ok(inv.inventory.knowledge_by_state.some((k) => k.state === 'VALIDATED' && k.provenance === 'VERIFIED'));
  assert.ok(inv.capture_gaps.some((g) => g.code === 'CAPTURA_POR_HOST'));
  // Ninguna ruta del navegador valida.
  const d = await arrancarDashboard(p.root);
  try { assert.equal((await post(d, '/api/v1/memory-validate', { cuerpo: JSON.stringify({ node_id: nodo.node_id }), cabeceras: cabeceraOk(d) })).status, 405); } finally { d.cerrar(); }
});

test('huecos de captura: secuencia con saltos, actividad privada y herramientas no observadas se muestran, no se omiten', () => {
  const p = limpiable(montar('huecos'));
  const a = adaptador(p.root);
  for (const s of [1, 2, 5]) assert.ok(a.registrar({ event_type: 'tool_call', sequence: s, host_event_id: 'x' + s, paths: [] }).ok);
  assert.ok(a.registrar({ event_type: 'file_edit', paths: ['.env'], input: 'x', host_event_id: 'x9' }).ok);
  assert.ok(usage.registrarNoObservado(p.root, { task_id: 'T-1', role: 'builder', detail: 'terminal del host (comandos de shell)' }).ok);
  const g = panel.resumen(p.root).data.capture_gaps;
  const salto = g.find((x) => x.code === 'SECUENCIA_CON_SALTOS');
  assert.ok(salto && salto.missing === 2, JSON.stringify(g));
  assert.ok(g.some((x) => x.code === 'EVENTOS_PRIVADOS' && x.count === 1));
  assert.ok(g.some((x) => x.code === 'HERRAMIENTA_NO_OBSERVADA' && /terminal/.test(x.message)));
  const vacio = limpiable(montar('sin-captura'));
  const g2 = panel.resumen(vacio.root).data.capture_gaps;
  assert.ok(g2.some((x) => x.code === 'SIN_CAPTURA'), 'sin actividad capturada se dice, no se calla');
  assert.equal(panel.resumen(vacio.root).data.inventory.events_total, null, 'sin identidad todavía: no hay conteo, no 0');
});

// ───────────────────────────── contexto y esfuerzo ───────────────────────────
test('contexto: tier y motivo, presupuesto, reducción NETA con baseline, tipo de medición sin mezclar, cobertura del host y sin ranking', async () => {
  const p = limpiable(montar('contexto'));
  const efforts = path.join(p.root, '.agentic', '_effort'); fs.mkdirSync(efforts, { recursive: true });
  fs.writeFileSync(path.join(efforts, 'T-ALTA.json'), JSON.stringify({ decision: { task_id: 'T-ALTA', tier: 'HIGH', risk: 'HIGH', difficulty: 'MEDIUM', reason_codes: ['PAYMENTS', 'BOUNDED_BUG'], required_roles: ['analyst', 'builder', 'qa', 'reviewer'], context_budget_bytes: 10000, tool_calls_soft_limit: 60, host_effort: 'no_controlable' }, uso: { context_bytes: 4000, tool_calls: 3 }, estado: 'EN_CURSO', historial: [{ ts: '2026-10-03T10:00:00.000Z', evento: 'DECIDIDO', tier: 'HIGH', motivo: 'PAYMENTS,BOUNDED_BUG' }, { ts: '2026-10-03T10:05:00.000Z', evento: 'RISK_DISCOVERED', desde: 'MEDIUM', tier: 'HIGH', motivo: 'toca facturación' }] }));
  fs.writeFileSync(path.join(efforts, 'T-SOLO-DECISION.json'), JSON.stringify({ decision: { task_id: 'T-SOLO-DECISION', tier: 'LOW', risk: 'LOW', difficulty: 'LOW', reason_codes: ['LOCAL_TEXT_CHANGE'], context_budget_bytes: 12000, tool_calls_soft_limit: 8 }, uso: { context_bytes: 0, tool_calls: 0 }, estado: 'EN_CURSO', historial: [] }));
  // T-ALTA: baseline 10000 → entregado 2000, recuperado 1500 ⇒ neta 6500 (65 %). Solo estimaciones bytes/4.
  assert.ok(usage.registrar(p.root, { task_id: 'T-ALTA', role: 'builder', kind: 'compression', original_bytes: 10000, delivered_bytes: 2000 }).ok);
  assert.ok(usage.registrar(p.root, { task_id: 'T-ALTA', role: 'builder', kind: 'evidence_retrieval', recovered_bytes: 1500 }).ok);
  assert.ok(usage.registrar(p.root, { task_id: 'T-ALTA', role: 'qa', kind: 'recall_index', delivered_bytes: 400 }).ok);
  assert.ok(usage.registrarNoObservado(p.root, { task_id: 'T-ALTA', role: 'builder', detail: 'lecturas nativas de archivos del host' }).ok);
  // T-NEG: recuperar costó más de lo reducido ⇒ NEGATIVA, se muestra tal cual.
  assert.ok(usage.registrar(p.root, { task_id: 'T-NEG', role: 'builder', kind: 'compression', original_bytes: 1000, delivered_bytes: 900 }).ok);
  assert.ok(usage.registrar(p.root, { task_id: 'T-NEG', role: 'builder', kind: 'evidence_retrieval', recovered_bytes: 800 }).ok);
  // T-MIX: tokens exactos + estimación ⇒ NO se suman.
  assert.ok(usage.registrar(p.root, { task_id: 'T-MIX', role: 'analyst', kind: 'search', delivered_bytes: 4000 }).ok);
  assert.ok(usage.registrar(p.root, { task_id: 'T-MIX', role: 'analyst', kind: 'host_tool', measure: 'host_reported', delivered_bytes: 100, tokens_delivered: 777 }).ok);
  // T-SIN-BASE: sin tamaño original ⇒ no hay reducción que calcular.
  assert.ok(usage.registrar(p.root, { task_id: 'T-SIN-BASE', role: 'builder', kind: 'file_read', delivered_bytes: 800 }).ok);

  const r = require(path.join(G, 'contexto-panel.cjs')).resumen(p.root, { limit: 50 });
  assert.equal(r.status, 'OK');
  const d = r.data; const por = (id) => d.tasks.find((t) => t.task_id === id);
  const alta = por('T-ALTA');
  assert.equal(alta.effort.tier, 'HIGH');
  assert.deepEqual(alta.effort.reasons.map((x) => x.code), ['PAYMENTS', 'BOUNDED_BUG']);
  assert.match(alta.effort.reasons[0].text, /pagos/);
  assert.ok(alta.effort.history.some((h) => h.event === 'RISK_DISCOVERED' && /riesgo/.test(h.text)));
  assert.equal(alta.effort.budget.context_bytes, 10000);
  assert.equal(alta.budget_use.consumed_bytes, 2000 + 1500 + 400, 'entregado + recuperado');
  assert.equal(alta.budget_use.consumed_pct, 39);
  assert.equal(alta.usage.net_reduction.net_bytes, 6500); assert.equal(alta.usage.net_reduction.net_pct, 65);
  assert.equal(alta.usage.net_reduction.scope, 'payload');
  assert.match(alta.usage.net_reduction.note, /no ahorro de sesión/);
  assert.equal(alta.usage.retrievals, 1);
  assert.equal(alta.usage.observed_calls, 3); assert.equal(alta.usage.unobserved_calls, 1);
  assert.deepEqual(alta.usage.unobserved_kinds, ['host_tool']);
  assert.equal(alta.usage.tokens.type, 'estimated_bytes4'); assert.equal(alta.usage.tokens.value, Math.ceil(3900 / 4));
  assert.match(alta.usage.tokens.label, /no son tokens facturados/);
  assert.equal(alta.usage.cost.available, false);
  assert.ok(por('T-NEG').usage.net_reduction.net_bytes < 0, 'la reducción neta puede ser negativa y se muestra');
  assert.match(por('T-NEG').usage.net_reduction.note, /NEGATIVA/);
  const mix = por('T-MIX').usage.tokens;
  assert.equal(mix.type, 'mixed'); assert.equal(mix.value, null, 'no se suman medidas distintas'); assert.equal(mix.parts.host_reported, 777); assert.equal(mix.parts.estimated_bytes4, 1000);
  const sb = por('T-SIN-BASE').usage.net_reduction;
  assert.equal(sb.baseline_comparable, false); assert.equal(sb.net_bytes, null); assert.equal(sb.net_pct, null, 'sin baseline: null, no 0');
  assert.equal(por('T-SIN-BASE').effort, null, 'sin decisión de esfuerzo: nivel NO disponible');
  assert.equal(por('T-SIN-BASE').budget_use, null);
  // Cobertura del host: lo no observado es "no observado", y la calidad es parcial.
  assert.equal(d.host_coverage.quality, 'parcial'); assert.equal(d.host_coverage.unobserved_rows, 1);
  assert.ok(d.host_coverage.not_observed.some((x) => /lecturas nativas/.test(x.what)));
  assert.ok(d.degradations.some((x) => x.code === 'HERRAMIENTAS_NO_OBSERVADAS'));
  assert.ok(!d.degradations.some((x) => x.code === 'COMPRESOR_SIN_ACTIVIDAD'), 'hay compresiones en el uso registrado: no se dice que el compresor esté inactivo');
  assert.equal(d.compression.available, true); assert.equal(d.compression.references, 0);
  // Sin ranking: roles en orden alfabético, tareas por recencia; nada ordenado por tokens.
  assert.deepEqual(d.by_role.map((x) => x.role), [...d.by_role.map((x) => x.role)].sort());
  assert.match(d.by_role_note, /no hay ranking/i); assert.match(d.tasks_order, /más reciente/);
  assert.deepEqual(d.tasks.map((t) => t.task_id), ['T-SIN-BASE', 'T-MIX', 'T-NEG', 'T-ALTA'], 'más reciente primero, no por consumo');
  assert.equal(d.tasks_without_usage.length, 1); assert.equal(d.tasks_without_usage[0].task_id, 'T-SOLO-DECISION');
  assert.equal(d.tasks_without_usage[0].usage, null, 'sin uso registrado: no disponible, no 0');
  assert.equal(d.totals.cost.available, false);
  // Paginación por cursor y filtros.
  const p1 = require(path.join(G, 'contexto-panel.cjs')).resumen(p.root, { limit: 2 });
  assert.equal(p1.data.tasks.length, 2); assert.ok(p1.coverage.next_cursor);
  const p2 = require(path.join(G, 'contexto-panel.cjs')).resumen(p.root, { limit: 2, cursor: p1.coverage.next_cursor });
  assert.deepEqual([...p1.data.tasks, ...p2.data.tasks].map((t) => t.task_id), ['T-SIN-BASE', 'T-MIX', 'T-NEG', 'T-ALTA']);
  assert.equal(require(path.join(G, 'contexto-panel.cjs')).resumen(p.root, { task: 'T-ALTA' }).data.tasks.length, 1);
  // Por la API y redactado.
  const dash = await arrancarDashboard(p.root);
  try {
    const j = (await get(dash, '/api/v1/context?limit=2')).json;
    assert.equal(j.data.tasks.length, 2); assert.equal(j.coverage.shown, 2); assert.ok(j.coverage.next_cursor);
    assert.equal((await get(dash, '/api/v1/context?limit=500')).status, 400);
  } finally { dash.cerrar(); }
});

test('contexto: sin datos ni decisiones => "no disponible" y degradaciones explicadas; cache de originales caducada se avisa', () => {
  const ctx = require(path.join(G, 'contexto-panel.cjs'));
  const p = limpiable(montar('contexto-vacio'));
  const d = ctx.resumen(p.root).data;
  assert.equal(d.available, true);
  assert.equal(d.totals, null, 'sin identidad/uso: ausente, no 0'); assert.equal(d.host_coverage, null);
  assert.deepEqual(d.tasks, []);
  assert.ok(d.degradations.some((x) => x.code === 'SIN_DECISION_DE_ESFUERZO'));
  assert.equal(d.provider.can_set_reasoning, false);
  assert.match(d.measurement.note, /nunca se suma con tokens exactos/);
  // Evidencia caducada ⇒ aviso sencillo.
  assert.ok(usage.registrar(p.root, { task_id: 'T-1', kind: 'search', delivered_bytes: 10 }).ok);
  const e = evidence.guardar(p.root, { text: 'original grande' }, { kind: 'tool_output', task_id: 'T-1', ttl_ms: 1 });
  assert.ok(e.ok);
  assert.ok(evidence.limpiar(p.root, { now: Date.now() + 5000 }).expired.includes(e.evidence_id));
  const d2 = ctx.resumen(p.root).data;
  const sinComp = d2.degradations.find((x) => x.code === 'COMPRESOR_SIN_ACTIVIDAD');
  assert.ok(sinComp && /desactivado|no haberse usado/.test(sinComp.message) && /original completo/.test(sinComp.message), 'compresor sin actividad explicado en lenguaje simple');
  const ex = d2.degradations.find((x) => x.code === 'EVIDENCIA_EXPIRED');
  assert.ok(ex && /caducó/.test(ex.message), JSON.stringify(d2.degradations));
});

// ───────────────────────────── SSE ───────────────────────────────────────────
test('SSE existente (?topics=memory): reconexión con cursor, idempotente, hueco => reconsulta, y el canal de los grafos no cambia', async () => {
  const p = limpiable(montar('sse'));
  const a = adaptador(p.root);
  assert.ok(a.registrar({ event_type: 'tool_call', paths: [] }).ok);
  const d = await arrancarDashboard(p.root, { AKDD_DASH_POLL_MS: '120' });
  const url = d.url.replace(/\/$/, '') + '/api/v1/events';
  const grafos = sse(url); await grafos.listo;
  const s1 = sse(url + '?topics=memory'); await s1.listo;
  const s2 = sse(url + '?topics=memory'); await s2.listo;
  try {
    assert.ok(await hasta(() => s1.eventos.length >= 1 && s2.eventos.length >= 1), 'evento inicial');
    assert.equal(s1.eventos[0].tipo, 'memory'); assert.ok(s1.eventos[0].data.memory_stamp && s1.eventos[0].data.context_stamp);
    const sello0 = s1.eventos[0].data.memory_stamp;
    // El panel obtiene el MISMO sello que el evento (así puede saber si ya está al día).
    assert.equal((await get(d, '/api/v1/memory')).json.data.stamp.memory, sello0);
    assert.ok(a.registrar({ event_type: 'tool_call', paths: [] }).ok);
    assert.ok(await hasta(() => s1.eventos.length >= 2 && s2.eventos.length >= 2), 'el cambio llega por SSE');
    const cambio = s1.eventos[1];
    assert.notEqual(cambio.data.memory_stamp, sello0);
    assert.equal(s2.eventos[1].id, cambio.id, 'todos los clientes reciben el mismo id (idempotente)');
    assert.equal((await get(d, '/api/v1/memory')).json.data.stamp.memory, cambio.data.memory_stamp);
    // Sin cambios, sin eventos nuevos.
    await esperar(600); assert.equal(s1.eventos.length, 2);
    // Reconexión con cursor: repone solo lo posterior.
    s1.cerrar();
    assert.ok(a.registrar({ event_type: 'tool_call', paths: [] }).ok); // ocurre MIENTRAS el cliente está desconectado (hueco)
    await esperar(500);
    const s3 = sse(url + '?topics=memory', { 'Last-Event-ID': String(cambio.id) }); await s3.listo;
    assert.ok(await hasta(() => s3.eventos.length >= 1), 'lo ocurrido en el hueco se repone al reconectar');
    assert.ok(s3.eventos.every((e) => e.id > cambio.id), 'sin duplicar lo ya visto');
    assert.equal(s3.eventos[0].data.memory_stamp, (await get(d, '/api/v1/memory')).json.data.stamp.memory, 'tras el hueco el sello coincide con la API: reconsulta paginada');
    s3.cerrar();
    // Cursor de otra ejecución => snapshot: el SSE no es la historia, se reconsulta.
    const s4 = sse(url + '?topics=memory', { 'Last-Event-ID': '999999' }); await s4.listo;
    assert.ok(await hasta(() => s4.eventos.length >= 1));
    assert.equal(s4.eventos[0].tipo, 'snapshot'); assert.equal(s4.eventos[0].data.motivo, 'CURSOR_EXPIRADO');
    s4.cerrar();
    // El canal de los grafos no recibió ningún evento de memoria ni cambió de forma.
    assert.ok(grafos.eventos.every((e) => e.tipo !== 'memory'), 'el canal de siempre queda intacto');
    assert.ok(!/event: memory/.test(grafos.crudo()));
  } finally { grafos.cerrar(); s2.cerrar(); d.cerrar(); }
});

// ───────────────────────────── páginas y grafos intactos ─────────────────────
test('páginas /memoria y /contexto: servidas con CSP; el tablero de grafos no cambia; el servidor sigue siendo solo-GET salvo el reintento', async () => {
  const p = limpiable(montar('paginas'));
  const d = await arrancarDashboard(p.root);
  try {
    for (const [ruta, titulo, api] of [['/memoria', 'Memoria', '/api/v1/memory'], ['/contexto', 'Contexto y esfuerzo', '/api/v1/context']]) {
      const r = await get(d, ruta);
      assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /text\/html/);
      assert.match(r.headers.get('content-security-policy'), /default-src|script-src/);
      assert.match(r.texto, new RegExp(titulo)); assert.match(r.texto, new RegExp(api.replace(/\//g, '\\/')));
      assert.match(r.texto, /topics=memory/, 'usa el SSE existente');
    }
    assert.match((await get(d, '/memoria')).texto, /memory-health/);
    assert.equal((await get(d, '/memoria/../../etc/passwd')).status, 404);
    const raiz = (await get(d, '/')).texto;
    // El tablero solo ENLAZA a las páginas desde su barra de pestañas (anclas); no carga sus scripts, su SSE ni su API dentro de los grafos.
    assert.match(raiz, /<a class="mode-link" href="\/memoria"/, 'la barra de pestañas enlaza a /memoria');
    assert.match(raiz, /<a class="mode-link" href="\/contexto"/, 'y a /contexto');
    assert.ok(!/memoria-pagina|topics=memory|api\/v1\/memory/.test(raiz), 'los grafos no cargan nada de la memoria con procedencia');
    assert.equal((await fetch(d.url + 'api/v1/memory', { method: 'DELETE' })).status, 405);
    assert.equal((await fetch(d.url + 'api/v1/memory', { method: 'PUT', body: '{}' })).status, 405);
    // Origen ajeno: la lectura tampoco se entrega.
    assert.equal((await get(d, '/api/v1/memory', { headers: { Origin: 'http://evil.example' } })).status, 403);
  } finally { d.cerrar(); }
});
