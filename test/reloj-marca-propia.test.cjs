'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { marcaDeArranque } = require(path.join(__dirname, '..', '.agentic', 'grafo', 'reloj-derivado.cjs'));

function base() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE gate_events (ts TEXT, verdict TEXT, cycle_id TEXT); CREATE TABLE ciclos (ciclo_id TEXT, fecha_fin TEXT)');
  return db;
}

test('reloj: una marca ajena que otro ciclo ya cerró no es el arranque de este', () => {
  const db = base();
  db.prepare("INSERT INTO gate_events VALUES ('2026-10-07 10:00:00','CICLO_INICIO','otro')").run();
  db.prepare("INSERT INTO ciclos VALUES ('otro','2026-10-07 10:30:00')").run();
  db.prepare("INSERT INTO ciclos VALUES ('mio','2026-10-07 11:00:00')").run();
  assert.strictEqual(marcaDeArranque(db, { ciclo_id: 'mio', fecha_fin: '2026-10-07 11:00:00' }), null, 'la marca de las 10:00 ya la usó "otro"');
});

test('reloj: la marca propia siempre vale; la ajena sin reclamar también', () => {
  const db = base();
  db.prepare("INSERT INTO gate_events VALUES ('2026-10-07 10:00:00','CICLO_INICIO','mio')").run();
  db.prepare("INSERT INTO ciclos VALUES ('mio','2026-10-07 10:20:00')").run();
  const r = marcaDeArranque(db, { ciclo_id: 'mio', fecha_fin: '2026-10-07 10:20:00' });
  assert.ok(r && r.fin - r.ini === 20 * 60000);
  const db2 = base();
  db2.prepare("INSERT INTO gate_events VALUES ('2026-10-07 10:00:00','CICLO_INICIO',NULL)").run();
  db2.prepare("INSERT INTO ciclos VALUES ('x','2026-10-07 10:10:00')").run();
  const s = marcaDeArranque(db2, { ciclo_id: 'x', fecha_fin: '2026-10-07 10:10:00' });
  assert.ok(s && s.fin - s.ini === 10 * 60000, 'sin competidores, la última marca sigue valiendo');
});

test('reloj: una marca con el id de otro ciclo no se hereda aunque ese ciclo cierre después', () => {
  const db = base();
  db.prepare("INSERT INTO gate_events VALUES ('2026-10-07 10:10:00','CICLO_INICIO','teams_1')").run();
  db.prepare("INSERT INTO ciclos VALUES ('teams_1','2026-10-07 16:10:00')").run();
  db.prepare("INSERT INTO ciclos VALUES ('commit-1','2026-10-07 10:23:00')").run();
  assert.strictEqual(marcaDeArranque(db, { ciclo_id: 'commit-1', fecha_fin: '2026-10-07 10:23:00' }), null);
});
