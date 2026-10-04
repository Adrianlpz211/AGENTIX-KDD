'use strict';
/* El tablero no se cuelga ni se vuelve UNAVAILABLE cuando un escritor largo retiene memoria.db (caso real medido en glowly:
   `/api/v1/summary` → DB_BLOQUEADA y >15 s de espera mientras el indexador escribía). Sirve la última lectura buena MARCADA
   como `stale`, y si nunca hubo una lectura buena lo dice honestamente en vez de inventar datos. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { crearFixture, arrancarDashboard } = require('./fixtures/dashboard-fixture.cjs');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-dashblk-' + p + '-'));
const dbDe = (dir) => path.join(dir, '.agentic', 'memoria.db');
async function json(url) { const t0 = Date.now(); const r = await fetch(url); return { status: r.status, ms: Date.now() - t0, body: await r.json() }; }

test('base bloqueada por un escritor: se sirve la última lectura buena marcada stale, rápido; liberada, vuelve lo fresco', async () => {
  const dir = tmp('stale'); crearFixture(dir);
  const d = await arrancarDashboard(dir, { AKDD_DASH_BUSY_MS: '300' });
  let bloqueo = null;
  try {
    const base = d.url.replace(/\/$/, '');
    const bueno = await json(base + '/api/v1/summary');
    assert.equal(bueno.body.status, 'OK');
    assert.equal(bueno.body.stale, undefined);
    bloqueo = new DatabaseSync(dbDe(dir));
    bloqueo.exec('BEGIN EXCLUSIVE');
    const viejo = await json(base + '/api/v1/summary');
    assert.equal(viejo.body.status, 'OK', JSON.stringify(viejo.body).slice(0, 300));
    assert.equal(viejo.body.stale, true);
    assert.equal(viejo.body.stale_reason, 'DB_BLOQUEADA');
    assert.ok(viejo.body.stale_since);
    assert.deepEqual(viejo.body.data, bueno.body.data, 'son los mismos datos de la última lectura buena');
    assert.ok(viejo.ms < 5000, 'no se cuelga: ' + viejo.ms + ' ms');
    // una ruta que nunca tuvo lectura buena NO inventa nada
    const nunca = await json(base + '/api/v1/contracts');
    assert.equal(nunca.body.status, 'UNAVAILABLE');
    assert.equal(nunca.body.reason_code, 'DB_BLOQUEADA');
    bloqueo.exec('COMMIT'); bloqueo.close(); bloqueo = null;
    const fresco = await json(base + '/api/v1/summary');
    assert.equal(fresco.body.status, 'OK');
    assert.equal(fresco.body.stale, undefined, 'liberada la base ya no está marcado como viejo');
  } finally { try { if (bloqueo) { bloqueo.exec('ROLLBACK'); bloqueo.close(); } } catch { /* ya cerrada */ } d.cerrar(); }
});
