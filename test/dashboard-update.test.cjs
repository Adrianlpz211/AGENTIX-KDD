'use strict';
/* Dashboard: tarjeta "Actualización y memoria" (3.20.1). Solo lectura, estados reales, sin secretos. */
const test = require('node:test');
const { SIN_DRIVER } = require('./helpers/db-real.cjs');
if (SIN_DRIVER) { require('node:test').test(require('node:path').basename(__filename) + ' (omitido: ' + SIN_DRIVER + ')', { skip: SIN_DRIVER }, () => {}); return; }
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const legacy = require('./helpers/legacy-real.cjs');
const { arrancarDashboard } = require('./fixtures/dashboard-fixture.cjs');
const { update } = require('../src/update.js');
const { dba, REPO } = require('./helpers/db-real.cjs');
const { HTML } = require(path.join(REPO, '.agentic', 'grafo', 'update-panel.cjs'));

const base = (d) => d.url.replace(/\/$/, '');
const pedir = async (url) => { const r = await fetch(url); return { status: r.status, headers: r.headers, texto: await r.text() }; };
const api = async (d, q = '') => { const r = await pedir(base(d) + '/api/v1/update' + q); return { ...r, json: JSON.parse(r.texto) }; };
const actualizar = (root, extra) => update({ projectPath: root, salir: false, silent: true, __sinFuncional: true, ...extra });

test('dashboard: tras un update verificado la tarjeta muestra los estados REALES', async () => {
  const p = legacy.proyectoReal('3.19.0', 'dash');
  const r = await actualizar(p.root);
  assert.ok(r.ok, JSON.stringify(r.errors));
  const d = await arrancarDashboard(p.root);
  try {
    const { json, status } = await api(d);
    assert.equal(status, 200);
    const x = json.data;
    assert.equal(json.status, 'OK');
    assert.match(x.installed_version, /^3\.20\./);
    assert.equal(x.service.responds, true);
    assert.equal(x.memory.can_work, true);
    assert.equal(x.schema.status, 'COMPLETE');
    assert.equal(x.schema.pending, 0);
    assert.equal(x.last_verification.status, 'VERIFIED');
    assert.equal(x.last_verification.op_id, r.op_id);
    assert.equal(x.memory_preserved.database.status, 'PASS');
    assert.equal(x.memory_preserved.own_files.status, 'PASS');
    assert.ok(x.memory_preserved.summary.rows_compared > 0);
    assert.equal(x.backup.available, true);
    assert.equal(x.backup.integrity, 'ok');
    assert.deepEqual(x.actions_needed, [], 'nada pendiente');
  } finally { d.cerrar(); }
});

test('dashboard: "el servicio responde" y "la memoria puede trabajar" son cosas distintas', async () => {
  const p = legacy.proyectoReal('3.19.0', 'dash-pend'); // sin actualizar: la memoria tiene el esquema antiguo
  const d = await arrancarDashboard(p.root);
  try {
    const x = (await api(d)).json.data;
    assert.equal(x.service.responds, true, 'el tablero está vivo');
    assert.equal(x.memory.can_work, false, 'pero el motor se negaría a abrir esa memoria');
    assert.equal(x.memory.reason, 'PENDING');
    assert.equal(x.schema.status, 'PENDING');
    assert.ok(x.schema.pending >= 20);
    assert.equal(x.last_verification, null);
    assert.ok(x.actions_needed.some((a) => a.code === 'MIGRAR'));
    assert.ok(x.actions_needed.some((a) => a.code === 'SIN_VERIFICACION'));
  } finally { d.cerrar(); }
});

test('dashboard: un update en curso, un fallo recuperado y un conflicto se ven con su acción', async () => {
  const p = legacy.proyectoReal('3.20.0', 'dash-estados');
  const fw = path.join(p.root, '.agentic', 'agentes', '01-orquestador.md');
  fs.appendFileSync(fw, '\nregla propia\n');
  const r = await actualizar(p.root);
  assert.equal(r.status, 'VERIFIED_WITH_WARNINGS');
  const d = await arrancarDashboard(p.root);
  try {
    let x = (await api(d)).json.data;
    assert.equal(x.customizations.conflicts, 1);
    assert.equal(x.customizations.preserved[0].file, '.agentic/agentes/01-orquestador.md');
    assert.ok(x.actions_needed.some((a) => a.code === 'CONFLICTOS'));

    // Un update vivo: la memoria no puede trabajar mientras dure.
    const guard = require(path.join(REPO, '.agentic', 'grafo', 'update-guard.cjs'));
    const h = guard.acquire(p.root, { opId: 'en-curso', timeoutMs: 100, phase: 'apply' });
    try {
      x = (await api(d)).json.data;
      assert.equal(x.memory.can_work, false);
      assert.equal(x.memory.reason, 'UPDATE_EN_CURSO');
      assert.equal(x.memory.update.phase, 'apply');
      assert.equal(x.service.responds, true);
    } finally { guard.release(h); }

    // Un fallo recuperado deja su aviso.
    const ult = path.join(p.root, '.agentic', '_update', 'last-result.json');
    const j = JSON.parse(fs.readFileSync(ult, 'utf8'));
    fs.writeFileSync(ult, JSON.stringify({ ...j, status: 'ROLLED_BACK', ok: false, errors: [{ code: 'FALLO', message: 'x'.repeat(500) }] }));
    x = (await api(d)).json.data;
    assert.ok(x.actions_needed.some((a) => a.code === 'REVISAR_FALLO'));
    assert.ok(x.last_verification.errors[0].message.length <= 200, 'los mensajes se acotan');
  } finally { d.cerrar(); }
});

test('dashboard: es de SOLO LECTURA, paginado, sin SQL del navegador y sin exponer rutas absolutas ni contenido', async () => {
  const p = legacy.proyectoReal('3.20.0', 'dash-ro');
  assert.ok((await actualizar(p.root)).ok);
  const d = await arrancarDashboard(p.root);
  try {
    assert.equal((await api(d, '?sql=DROP%20TABLE%20nodos')).status, 400, 'ningún parámetro libre');
    assert.equal((await api(d, '?limit=0')).status, 400);
    assert.equal((await api(d, '?limit=20&cursor=0')).status, 200);
    const post = await fetch(base(d) + '/api/v1/update', { method: 'POST', body: '{}' });
    assert.equal(post.status, 405, 'solo GET');
    const crudo = (await pedir(base(d) + '/api/v1/update')).texto;
    assert.ok(!crudo.includes(p.root) && !crudo.includes(p.root.replace(/\\/g, '/')), 'ninguna ruta absoluta del equipo');
    assert.ok(!/Memoria original|REGLA_|trial_days/.test(crudo), 'ningún contenido de la memoria');
    const antes = fs.readFileSync(p.dbPath);
    await api(d); await api(d);
    assert.ok(antes.equals(fs.readFileSync(p.dbPath)), 'leer el estado no modifica la base');
    const j = (await api(d, '?limit=1')).json;
    assert.equal(j.coverage.shown <= 1, true);
  } finally { d.cerrar(); }
});

test('dashboard: la página /actualizacion se sirve con CSP, sin tocar el tablero de grafos', async () => {
  const p = legacy.proyectoReal('3.20.0', 'dash-pag');
  assert.ok((await actualizar(p.root)).ok);
  const d = await arrancarDashboard(p.root);
  try {
    const pag = await pedir(base(d) + '/actualizacion');
    assert.equal(pag.status, 200);
    assert.match(pag.headers.get('content-type'), /text\/html/);
    assert.match(pag.headers.get('content-security-policy'), /default-src|script-src/);
    assert.match(pag.texto, /Actualización y memoria/);
    assert.match(pag.texto, /\/api\/v1\/update/);
    const raiz = await pedir(base(d) + '/');
    assert.match(raiz.texto, /<a class="mode-link" href="\/actualizacion"/, 'la barra de pestañas solo ENLAZA a la página (una ancla)');
    assert.ok(!/Actualización y memoria|api\/v1\/update/i.test(raiz.texto), 'el tablero de grafos no cargó nada de la página: ni su contenido ni su API');
    assert.equal((await pedir(base(d) + '/actualizacion/../../etc/passwd')).status, 404);
  } finally { d.cerrar(); }
});

test('dashboard: la página nunca interpreta datos como HTML', () => {
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(HTML), 'solo textContent');
  assert.ok(/textContent/.test(HTML));
  assert.ok(!/<script src=|https?:\/\/(?!www\.w3\.org)/.test(HTML), 'sin recursos externos');
});
