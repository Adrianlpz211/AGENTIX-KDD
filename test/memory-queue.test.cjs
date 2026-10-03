'use strict';
/* C02 — Cola durable: claim atómico, fencing, recuperación idempotente, dead-letter, reglas deterministas. */
const test = require('node:test');
const { SIN_DRIVER } = require('./helpers/db-real.cjs');
if (SIN_DRIVER) { test(require('node:path').basename(__filename) + ' (omitido: ' + SIN_DRIVER + ')', { skip: SIN_DRIVER }, () => {}); return; }
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { proyecto, REPO } = require('./helpers/memoria-proyecto.cjs');
const G = path.join(REPO, '.agentic', 'grafo');
const core = require(path.join(G, 'memory-core.cjs'));
const queue = require(path.join(G, 'memory-queue.cjs'));

const T0 = Date.parse('2026-10-03T12:00:00Z');
const ev = (o = {}) => ({ host: 'cursor', session_id: 's1', host_event_id: 'h' + Math.random().toString(36).slice(2), event_type: 'test_run', task_id: 'T1', input: 'npm test', output: 'ok', ...o });
const filas = (p, sql, ...a) => { const d = p.abrirR(); try { return d.all(sql, ...a); } finally { d.close(); } };
const uno = (p, sql, ...a) => filas(p, sql, ...a)[0];

test('dos workers NO confirman el mismo job: solo uno gana el claim', () => {
  const p = proyecto('q-dos-workers');
  try {
    core.capturar(p.root, ev(), { now: T0 });
    const a = queue.reclamar(p.root, { owner: 'w-a', now: T0 });
    const b = queue.reclamar(p.root, { owner: 'w-b', now: T0 });
    assert.ok(a.job);
    assert.equal(b.job, null, 'el segundo no recibe el job que ya tiene dueño');
    assert.equal(a.job.state, 'RUNNING');
    assert.equal(a.job.lease_token, 1);
    assert.equal(a.events.length, 1);
    // Solo el dueño vigente confirma.
    assert.equal(queue.completar(p.root, a.job.job_id, a.job.lease_token, 'w-b', { now: T0 }).code, 'LEASE_LOST');
    assert.equal(queue.completar(p.root, a.job.job_id, 999, 'w-a', { now: T0 }).code, 'LEASE_LOST');
    assert.ok(queue.completar(p.root, a.job.job_id, a.job.lease_token, 'w-a', { now: T0 }).ok);
    assert.equal(uno(p, 'SELECT state FROM mem_jobs').state, 'DONE');
    assert.equal(queue.completar(p.root, a.job.job_id, a.job.lease_token, 'w-a', { now: T0 }).code, 'LEASE_LOST', 'confirmar dos veces no es posible');
  } finally { p.limpiar(); }
});

test('FENCING: un worker viejo cuyo lease venció y fue reclamado recibe LEASE_LOST y su resultado se descarta', () => {
  const p = proyecto('q-fencing');
  try {
    core.capturar(p.root, ev(), { now: T0 });
    const a = queue.reclamar(p.root, { owner: 'w-lento', now: T0, lease_ms: 1000 });
    const b = queue.reclamar(p.root, { owner: 'w-nuevo', now: T0 + 5000, lease_ms: 60000 });
    assert.ok(b.job, 'el lease vencido se recupera');
    assert.equal(b.job.lease_token, a.job.lease_token + 1, 'cada claim incrementa el fencing token');
    assert.equal(queue.completar(p.root, a.job.job_id, a.job.lease_token, 'w-lento', { now: T0 + 6000 }).code, 'LEASE_LOST');
    assert.equal(queue.fallar(p.root, a.job.job_id, a.job.lease_token, 'w-lento', { now: T0 + 6000 }).code, 'LEASE_LOST');
    assert.equal(queue.renovar(p.root, a.job.job_id, a.job.lease_token, 'w-lento', { now: T0 + 6000 }).code, 'LEASE_LOST');
    assert.ok(queue.completar(p.root, b.job.job_id, b.job.lease_token, 'w-nuevo', { now: T0 + 6000 }).ok);
    // Un lease vencido pero aún sin reclamar tampoco puede confirmarse tarde.
    core.capturar(p.root, ev({ host_event_id: 'otro' }), { now: T0 });
    const c = queue.reclamar(p.root, { owner: 'w-c', now: T0, lease_ms: 1000 });
    assert.equal(queue.completar(p.root, c.job.job_id, c.job.lease_token, 'w-c', { now: T0 + 5000 }).code, 'LEASE_LOST');
  } finally { p.limpiar(); }
});

test('caída DESPUÉS de procesar y ANTES de confirmar: la recuperación reprocesa y NO duplica observaciones (idempotente)', async () => {
  const p = proyecto('q-caida');
  try {
    const e = core.capturar(p.root, ev({ output: '3 failed' }), { now: T0 });
    const a = queue.reclamar(p.root, { owner: 'w-muere', now: T0, lease_ms: 1000 });
    queue.procesarDeterminista(p.root, a.events); // efectos hechos... y el proceso "muere" sin completar
    assert.equal(filas(p, 'SELECT count(*) AS n FROM mem_observations')[0].n, 1);
    const r = await queue.drenar(p.root, { owner: 'w-recupera', now: T0 + 10000 });
    assert.equal(r.done, 1);
    assert.equal(filas(p, 'SELECT count(*) AS n FROM mem_observations')[0].n, 1, 'mismo job + mismos eventos = misma observación');
    assert.equal(uno(p, 'SELECT state, attempts FROM mem_jobs WHERE job_id = ?', e.job_id).state, 'DONE');
    assert.equal(uno(p, 'SELECT attempts FROM mem_jobs WHERE job_id = ?', e.job_id).attempts, 2, 'el claim vencido cuenta como intento');
  } finally { p.limpiar(); }
});

test('caída ANTES del claim (evento confirmado, job intacto): el siguiente worker lo procesa una vez', async () => {
  const p = proyecto('q-antes');
  try {
    core.capturar(p.root, ev(), { now: T0 });
    const r = await queue.drenar(p.root, { owner: 'w', now: T0 });
    assert.equal(r.processed, 1);
    assert.equal(r.done, 1);
    const r2 = await queue.drenar(p.root, { owner: 'w', now: T0 });
    assert.equal(r2.processed, 0, 'ya procesado: no se repite');
  } finally { p.limpiar(); }
});

test('reintentos con backoff exponencial acotado; al agotarse → DEAD_LETTER visible; reintento manual limitado a 3', () => {
  const p = proyecto('q-dead');
  try {
    const e = core.capturar(p.root, ev(), { now: T0 });
    const d = p.abrirW(); try { d.run('UPDATE mem_jobs SET max_attempts = 3 WHERE job_id = ?', e.job_id); } finally { d.close(); }
    let t = T0; const esperas = [];
    for (let i = 1; i <= 3; i++) {
      const c = queue.reclamar(p.root, { owner: 'w', now: t });
      assert.ok(c.job, 'intento ' + i);
      const f = queue.fallar(p.root, c.job.job_id, c.job.lease_token, 'w', { now: t, error_code: 'BOOM' });
      assert.ok(f.ok);
      if (f.status === 'RETRY') { esperas.push(Date.parse(f.next_attempt_at) - t); t = Date.parse(f.next_attempt_at); } else assert.equal(f.status, 'DEAD_LETTER');
    }
    assert.deepEqual(esperas, [5000, 10000], 'backoff exponencial');
    assert.equal(uno(p, 'SELECT state, error_code FROM mem_jobs').state, 'DEAD_LETTER');
    assert.equal(queue.reclamar(p.root, { owner: 'w', now: t + 3600000 }).job, null, 'un dead-letter no vuelve a correr solo (sin bucle infinito)');
    const st = queue.estadisticas(p.root, { now: t });
    assert.equal(st.by_state.DEAD_LETTER, 1);
    assert.equal(st.dead_letter[0].error_code, 'BOOM');
    assert.equal(st.healthy, false);
    assert.equal(queue.backoff(30, {}), 15 * 60 * 1000, 'el backoff tiene techo');
    // Reintento manual: validado y limitado.
    for (let i = 1; i <= 3; i++) {
      const r = queue.reintentar(p.root, e.job_id, { now: t });
      assert.ok(r.ok, 'reintento ' + i);
      const c = queue.reclamar(p.root, { owner: 'w', now: t });
      d2(p, e.job_id);
      queue.fallar(p.root, c.job.job_id, c.job.lease_token, 'w', { now: t });
    }
    assert.equal(queue.reintentar(p.root, e.job_id, { now: t }).code, 'REINTENTOS_AGOTADOS');
    assert.equal(queue.reintentar(p.root, 'job_inexistente').code, 'JOB_NO_EXISTE');
  } finally { p.limpiar(); }
  function d2(pp, id) { const d = pp.abrirW(); try { d.run('UPDATE mem_jobs SET max_attempts = 1 WHERE job_id = ?', id); } finally { d.close(); } }
});

test('un lease vencido con los intentos agotados NO vuelve a correr: va a dead-letter', () => {
  const p = proyecto('q-lease-max');
  try {
    const e = core.capturar(p.root, ev(), { now: T0 });
    const d = p.abrirW(); try { d.run('UPDATE mem_jobs SET max_attempts = 1 WHERE job_id = ?', e.job_id); } finally { d.close(); }
    assert.ok(queue.reclamar(p.root, { owner: 'w1', now: T0, lease_ms: 1000 }).job);
    assert.equal(queue.reclamar(p.root, { owner: 'w2', now: T0 + 9000 }).job, null);
    assert.equal(uno(p, 'SELECT state, error_code FROM mem_jobs').state, 'DEAD_LETTER');
    assert.equal(uno(p, 'SELECT error_code FROM mem_jobs').error_code, 'LEASE_EXPIRED_MAX_ATTEMPTS');
  } finally { p.limpiar(); }
});

test('el resumidor es opt-in; si FALLA queda la observación determinista, el job se reintenta y capturar sigue funcionando', async () => {
  const p = proyecto('q-resumidor');
  try {
    core.capturar(p.root, ev({ output: '2 failed' }), { now: T0 });
    const r = await queue.drenar(p.root, { owner: 'w', now: T0, summarizer: async () => { throw new Error('proveedor caído'); } });
    assert.equal(r.retried, 1);
    assert.equal(r.errors[0].message, 'proveedor caído');
    assert.equal(filas(p, "SELECT count(*) AS n FROM mem_observations WHERE kind = 'test_failure'")[0].n, 1, 'la observación determinista no se perdió');
    assert.equal(uno(p, 'SELECT state FROM mem_jobs').state, 'RETRY');
    assert.equal(core.capturar(p.root, ev({ host_event_id: 'sigue' }), { now: T0 }).status, 'CAPTURED', 'el agente no se bloquea');
    // Sin summarizer no se llama a ningún modelo: el procesamiento es 100% determinista.
    const r2 = await queue.drenar(p.root, { owner: 'w', now: T0 + 3600000 });
    assert.equal(r2.errors.length, 0);
  } finally { p.limpiar(); }
});

test('lecturas repetidas se AGRUPAN: 60 lecturas = UNA observación, no un aprendizaje por cada Read', async () => {
  const p = proyecto('q-lecturas');
  try {
    for (let i = 0; i < 60; i++) core.capturar(p.root, ev({ event_type: 'file_read', host_event_id: 'r' + i, paths: [i % 2 ? 'src/a.js' : 'src/b.js'], input: 'leer' }), { now: T0 });
    const r = await queue.drenar(p.root, { owner: 'w', now: T0, max: 100 });
    assert.equal(r.done, 60);
    const o = filas(p, "SELECT kind, summary FROM mem_observations WHERE kind = 'reads_grouped'");
    assert.ok(o.length < 60, 'no se genera una observación por lectura');
    assert.ok(o.length >= 1);
    assert.equal(filas(p, "SELECT count(*) AS n FROM mem_knowledge")[0].n, 0, 'leer no aprende nada');
  } finally { p.limpiar(); }
});

test('reglas deterministas: prueba fallida, archivos tocados, decisión explícita (PROPOSED, no validada), gate; sin regla → SUPPRESSED', async () => {
  const p = proyecto('q-reglas');
  try {
    core.capturar(p.root, ev({ event_type: 'test_run', host_event_id: '1', output: '5 failed ✖ auth' }), { now: T0 });
    core.capturar(p.root, ev({ event_type: 'file_edit', host_event_id: '2', paths: ['src/auth.js'] }), { now: T0 });
    core.capturar(p.root, ev({ event_type: 'decision', host_event_id: '3', input: 'Usaremos rotación de refresh tokens cada 7 días', paths: ['src/auth.js'] }), { now: T0 });
    core.capturar(p.root, ev({ event_type: 'gate_result', host_event_id: '4', output: 'TDD gate PASS' }), { now: T0 });
    core.capturar(p.root, ev({ event_type: 'evento_raro', host_event_id: '5' }), { now: T0 });
    const r = await queue.drenar(p.root, { owner: 'w', now: T0 });
    assert.equal(r.done, 5);
    const kinds = filas(p, 'SELECT kind FROM mem_observations ORDER BY kind').map((x) => x.kind);
    assert.deepEqual(kinds, ['decision_explicit', 'files_touched', 'gate_result', 'test_failure']);
    const k = filas(p, 'SELECT state, provenance FROM mem_knowledge');
    assert.equal(k.length, 1);
    assert.equal(k[0].state, 'PROPOSED', 'una decisión explícita se PROPONE; no se valida sola');
    assert.equal(uno(p, "SELECT status FROM mem_events WHERE event_type = 'evento_raro'").status, 'SUPPRESSED');
    assert.equal(uno(p, "SELECT status FROM mem_events WHERE event_type = 'test_run'").status, 'PROCESSED');
    // La procedencia une conocimiento → observación → evento.
    const nodo = filas(p, 'SELECT node_id FROM mem_knowledge')[0].node_id;
    const pr = core.procedencia(p.root, nodo);
    assert.ok(pr.events.some((e) => e.event_type === 'decision'));
    assert.ok(pr.observations.some((o) => o.kind === 'decision_explicit'));
  } finally { p.limpiar(); }
});

test('jobs OBLIGATORIOS pendientes se ven en las estadísticas: un gate no puede darse por registrado con ellos abiertos', () => {
  const p = proyecto('q-obligatorios');
  try {
    core.capturar(p.root, ev({ event_type: 'gate_result' }), { now: T0, required: true });
    core.capturar(p.root, ev(), { now: T0 });
    let st = queue.estadisticas(p.root, { now: T0 });
    assert.equal(st.required_pending, 1);
    assert.equal(st.by_state.PENDING, 2);
    // Los obligatorios se reclaman primero.
    const c = queue.reclamar(p.root, { owner: 'w', now: T0 });
    assert.equal(c.job.required, 1);
    queue.completar(p.root, c.job.job_id, c.job.lease_token, 'w', { now: T0 });
    st = queue.estadisticas(p.root, { now: T0 });
    assert.equal(st.required_pending, 0);
  } finally { p.limpiar(); }
});

test('sin tablas la cola no lanza: informa SCHEMA_MISSING con la acción', async () => {
  const p = proyecto('q-sin-tablas', { catalogo: false, nodos: 0 });
  try {
    assert.equal(queue.reclamar(p.root, { owner: 'w' }).code, 'SCHEMA_MISSING');
    const r = await queue.drenar(p.root, { owner: 'w' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'SCHEMA_MISSING');
    assert.match(r.hint, /akdd update/);
    assert.equal(queue.estadisticas(p.root).code, 'SCHEMA_MISSING');
  } finally { p.limpiar(); }
});

test('VARIOS PROCESOS reales drenando a la vez: cada job se confirma exactamente una vez', async () => {
  const p = proyecto('q-concurrente');
  try {
    for (let i = 0; i < 24; i++) core.capturar(p.root, ev({ host_event_id: 'c' + i, event_type: 'file_edit', paths: ['src/f' + i + '.js'], task_id: 'T' + (i % 4) }));
    const script = 'const q=require(' + JSON.stringify(path.join(G, 'memory-queue.cjs')) + ');q.drenar(' + JSON.stringify(p.root) + ',{owner:"proc-"+process.pid,max:30}).then(r=>{process.stdout.write(JSON.stringify(r));process.exit(0)});';
    const correr = () => new Promise((res) => { const c = spawn(process.execPath, ['-e', script], { env: { ...process.env, NODE_NO_WARNINGS: '1' } }); let out = ''; c.stdout.on('data', (b) => { out += b; }); c.on('close', () => { try { res(JSON.parse(out)); } catch { res({ done: 0, error: out }); } }); });
    const r = await Promise.all([correr(), correr(), correr()]);
    const total = r.reduce((n, x) => n + (x.done || 0), 0);
    assert.equal(total, 24, 'ni de más ni de menos: ' + JSON.stringify(r));
    assert.equal(filas(p, "SELECT count(*) AS n FROM mem_jobs WHERE state = 'DONE'")[0].n, 24);
    assert.equal(filas(p, 'SELECT count(*) AS n FROM mem_jobs WHERE attempts <> 1')[0].n, 0, 'ningún job se procesó dos veces');
  } finally { p.limpiar(); }
});
