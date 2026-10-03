'use strict';
// Visita guiada automática: sin comando Node, sin escribir memoria.db.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const REPO = path.join(__dirname, '..');
const fx = require('./fixtures/dashboard-fixture.cjs');
const tour = require(path.join(REPO, '.agentic', 'grafo', 'tour-servicio.cjs'));

test('tour: se arma al abrir y no escribe memoria.db ni pide akdd tour', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-tour-'));
  fx.crearFixture(dir);
  const db = path.join(dir, '.agentic', 'memoria.db');
  const antes = crypto.createHash('sha256').update(fs.readFileSync(db)).digest('hex');
  const srv = await fx.arrancarDashboard(dir);
  try {
    const html = await (await fetch(srv.url)).text();
    assert.ok(!/Pide <code>akdd tour<\/code>/.test(html));
    const api = await (await fetch(srv.url + 'api/v1/tour')).json();
    assert.ok(api.schema_version === 1);
    assert.ok(api.status === 'OK' || api.status === 'EMPTY');
    if (api.data) {
      assert.ok(Array.isArray(api.data.front));
      assert.ok(Array.isArray(api.data.back));
    }
  } finally { srv.cerrar(); }
  const despues = crypto.createHash('sha256').update(fs.readFileSync(db)).digest('hex');
  assert.strictEqual(despues, antes);
  assert.ok(!fs.existsSync(path.join(dir, '.agentic', 'tour.json')));
});

test('tour: cache corrupto se reconstruye y no rompe', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-tourc-'));
  fx.crearFixture(dir);
  fs.mkdirSync(path.join(dir, '.agentic', '_cache'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.agentic', '_cache', 'tour-' + tour.hashFuente(dir) + '.json'), '{no-es-json');
  const r = tour.obtener(dir, { writeCache: false });
  assert.ok(r.status === 'OK' || r.status === 'EMPTY' || r.status === 'UNAVAILABLE');
  assert.ok(r.tour === null || tour.validar(r.tour));
});
