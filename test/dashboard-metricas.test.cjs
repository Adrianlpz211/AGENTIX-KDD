'use strict';

/* D01/D02/D03/D04/D16/D22 — una sola definición de cierre, STOP, tasa de
   tests y fecha para todo el tablero. Un parcial no es un cierre, un STOP
   no se cuenta dos veces, una tasa no pasa de 100% y lo que no se sabe
   queda como "—". */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { crearFixture, arrancarDashboard, REPO } = require('./fixtures/dashboard-fixture.cjs');

const ec = require(path.join(REPO, '.agentic', 'grafo', 'estado-ciclo.cjs'));
const fu = require(path.join(REPO, '.agentic', 'grafo', 'fecha-utc.cjs'));

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-metr-' + p + '-'));
const dbDe = (dir) => path.join(dir, '.agentic', 'memoria.db');
const pedir = async (url) => (await fetch(url)).text();

function conDb(dir, fn) {
  const db = new DatabaseSync(dbDe(dir));
  try { fn(db); } finally { db.close(); }
}
function ciclo(db, f) {
  const fila = Object.assign({ tarea: 'Tarea ' + f.ciclo_id, modulo: 'pedidos', area: 'pedidos', tipo_tarea: 'feature', fases_total: 4, fases_completadas: 4, tests_generados: 0, tests_pasando: 0, stops_count: 0, post_cycle_ran: 1, patrones_aplicados: '[]', errores_evitados: '[]' }, f);
  const k = Object.keys(fila);
  db.prepare(`INSERT INTO ciclos (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`).run(...k.map((x) => fila[x]));
}
const kpi = (html, id) => {
  const m = html.match(new RegExp(`data-kpi="${id}"([^>]*)>([^<]*)<`));
  return m ? { attrs: m[1], v: m[2].trim(), sinDato: /data-sin-dato/.test(m[1]) } : null;
};
async function conTablero(dir, fn) {
  const d = await arrancarDashboard(dir);
  try { return await fn(await pedir(d.url)); } finally { d.cerrar(); }
}

// ─── D01: catálogo de estados ────────────────────────────────────────────────
test('D01: cada estado del catálogo cae en su clase y un estado raro queda DESCONOCIDO', () => {
  const casos = {
    COMPLETADO_VERIFICADO: 'VERIFICADO', COMPLETADO: 'COMPLETADO_SIN_VEREDICTO', COMPLETADO_CON_PENDIENTES: 'CON_PENDIENTES',
    STOP: 'DETENIDO', BLOQUEADO: 'DETENIDO', ESPERA_HUMANA: 'DETENIDO', FALLIDO: 'FALLIDO', ERROR: 'FALLIDO',
    CANCELADO: 'CANCELADO', ABORTADO: 'CANCELADO', EN_CURSO: 'EN_CURSO', INICIADO: 'EN_CURSO',
    'algo-raro': 'DESCONOCIDO', '': 'DESCONOCIDO', null: 'DESCONOCIDO',
  };
  for (const [estado, clase] of Object.entries(casos)) assert.strictEqual(ec.clasificar(estado === 'null' ? null : estado), clase, String(estado));
  const r = ec.resumenCierre(Object.keys(casos).map((e, i) => ({ ciclo_id: 'c' + i, estado: e })));
  assert.strictEqual(r.total, 15);
  assert.strictEqual(r.cerrados, 2, 'solo verificado y completado son cierre íntegro');
  assert.strictEqual(r.por_clase.CON_PENDIENTES, 1);
  assert.strictEqual(r.por_clase.DESCONOCIDO, 3);
  assert.strictEqual(ec.resumenCierre([]).tasa_cierre, null, 'sin ciclos: sin dato, no 0% ni 100%');
});

test('D01: un tablero con solo parciales no muestra 100% ni verde', async () => {
  const dir = tmp('parc'); crearFixture(dir);
  conDb(dir, (db) => { db.exec('DELETE FROM ciclos'); for (let i = 1; i <= 3; i++) ciclo(db, { ciclo_id: 'p' + i, estado: 'COMPLETADO_CON_PENDIENTES', fecha_inicio: `2026-09-0${i}T09:00:00Z`, fecha_fin: `2026-09-0${i}T10:00:00Z` }); });
  await conTablero(dir, (html) => {
    const g = kpi(html, 'goal');
    assert.ok(g, 'falta la tarjeta de cierre');
    assert.strictEqual(g.v, '0%', 'tres parciales = 0 cierres íntegros');
    assert.match(g.attrs, /Con pendientes 3/);
    assert.ok(!/color:#34d399/.test(g.attrs));
    const clases = [...html.matchAll(/data-clase="([A-Z_]+)"/g)].map((m) => m[1]);
    assert.deepStrictEqual([...new Set(clases)], ['CON_PENDIENTES']);
    assert.strictEqual(kpi(html, 'completed').v, '0');
  });
});

test('D01: fixture mixto — completado, parcial y STOP dan 33%, no 66%', async () => {
  const dir = tmp('mix'); crearFixture(dir);
  await conTablero(dir, (html) => {
    assert.strictEqual(kpi(html, 'goal').v, '33%');
    assert.strictEqual(kpi(html, 'completed').v, '1');
  });
});

// ─── D02: STOP únicos ────────────────────────────────────────────────────────
function eventosStop(db) {
  const ins = db.prepare("INSERT INTO gate_events (ts, gate, verdict, file, source, cycle_id, event_id, incident_id) VALUES ('2026-09-03T09:40:00Z','tdd','STOP','src/pagos.js','mechanical',?,?,?)");
  ins.run('c3', 'e10', 'i1'); ins.run('c3', 'e11', 'i1'); ins.run('c3', 'e12', 'i2');
}
test('D02: contador del ciclo y eventos enlazados no se suman; un incidente repetido cuenta una vez', () => {
  const ciclos = [{ ciclo_id: 'c3', estado: 'STOP', stops_count: 1 }, { ciclo_id: 'c4', estado: 'STOP', stops_count: 0 }, { ciclo_id: 'c5', estado: 'COMPLETADO', stops_count: 0 }];
  const ev = [{ id: 1, event_id: 'e0', cycle_id: null }, { id: 2, event_id: 'e10', incident_id: 'i1', cycle_id: 'c3' }, { id: 3, event_id: 'e11', incident_id: 'i1', cycle_id: 'c3' }, { id: 4, event_id: 'e12', incident_id: 'i2', cycle_id: 'c3' }];
  const r = ec.incidentesStop(ciclos, ev);
  assert.deepStrictEqual(r, { total: 4, en_ciclos: 3, sin_ciclo: 1 });
  assert.strictEqual(ec.autonomia(ciclos, ev).sin_intervencion, 1);
});

test('D02: el tablero muestra 4 STOP únicos, no la suma de contadores y eventos', async () => {
  const dir = tmp('stop'); crearFixture(dir);
  conDb(dir, (db) => { eventosStop(db); ciclo(db, { ciclo_id: 'c4', estado: 'STOP', fecha_inicio: '2026-09-04T09:00:00Z', fecha_fin: '2026-09-04T10:00:00Z' }); });
  await conTablero(dir, (html) => {
    const s = kpi(html, 'stops');
    assert.strictEqual(s.v, '4', 'c3 (2 incidentes) + c4 (legado, 1) + e0 sin ciclo (1)');
    assert.match(s.attrs, /3 en ciclos, 1 sin ciclo/);
    const T = JSON.parse(html.match(/const TIEMPOS_DATA = JSON\.parse\((".*?")\);/)[1]);
    assert.strictEqual(JSON.parse(T).stops_unicos, 4, 'el reporte de tiempos usa la misma cuenta');
  });
});

test('D01/D02/D03: tablero, metrics.cjs y grafo.cjs metricas dan el mismo cierre, STOP y tasa', async () => {
  const dir = tmp('canal'); crearFixture(dir, { esquemaCompleto: true }); // este test ejecuta el MOTOR (grafo.cjs metricas): un proyecto ya actualizado
  conDb(dir, (db) => { eventosStop(db); ciclo(db, { ciclo_id: 'c4', estado: 'STOP', tests_generados: 1, tests_pasando: 10, fecha_inicio: '2026-09-04T09:00:00Z', fecha_fin: '2026-09-04T10:00:00Z' }); });
  const metrics = require(path.join(REPO, '.agentic', 'grafo', 'metrics.cjs'));
  const db = new DatabaseSync(dbDe(dir), { readOnly: true });
  const m = metrics.computeCycleMetrics(db); db.close();
  const { execFileSync } = require('child_process');
  // grafo.cjs resuelve la base desde su propia carpeta: sin esto leería la del repo.
  const env = Object.assign({}, process.env, { AGENTIC_MEMORIA_PATH_OVERRIDE: path.join(dir, '.agentic', 'memoria') }); delete env.NODE_TEST_CONTEXT;
  const g = JSON.parse(execFileSync(process.execPath, [path.join(REPO, '.agentic', 'grafo', 'grafo.cjs'), 'metricas'], { cwd: dir, env, encoding: 'utf8' }));
  await conTablero(dir, (html) => {
    const goal = kpi(html, 'goal').v, stops = kpi(html, 'stops').v, tests = kpi(html, 'tests').v;
    assert.strictEqual(goal, '25%');
    assert.strictEqual(m.success_rate + '%', goal); assert.strictEqual(g.goal_attainment + '%', goal);
    assert.strictEqual(String(m.stops_unicos), stops); assert.strictEqual(String(g.stops), stops);
    assert.strictEqual(m.test_pass_rate + '% ⚠', tests); assert.strictEqual(g.test_rate + '% ⚠', tests);
    assert.strictEqual(m.tests_estado, 'DATA_INCONSISTENT');
  });
});

// ─── D03: tasa de tests ──────────────────────────────────────────────────────
test('D03: 10 aprobadas de 1 ejecutada se declara inconsistente y nunca da 1000%', () => {
  const r = ec.tasaTests([{ ciclo_id: 'a', tests_generados: 1, tests_pasando: 10 }, { ciclo_id: 'b', tests_generados: 10, tests_pasando: 9 }, { ciclo_id: 'c' }]);
  assert.strictEqual(r.status, 'DATA_INCONSISTENT');
  assert.deepStrictEqual(r.inconsistentes, ['a']);
  assert.strictEqual(r.tasa, 90, 'el inconsistente no se suma');
  assert.strictEqual(r.sin_ejecucion, 1);
  assert.strictEqual(ec.tasaTests([{ ciclo_id: 'x' }]).tasa, null);
});

test('D03: el tablero marca la tasa inconsistente y no pasa de 100%', async () => {
  const dir = tmp('tst'); crearFixture(dir);
  conDb(dir, (db) => { db.exec('DELETE FROM ciclos'); ciclo(db, { ciclo_id: 'raro', estado: 'COMPLETADO', tests_generados: 1, tests_pasando: 10, fecha_inicio: '2026-09-01T09:00:00Z', fecha_fin: '2026-09-01T10:00:00Z' }); });
  await conTablero(dir, (html) => {
    const t = kpi(html, 'tests');
    assert.ok(!/1000%/.test(html), 'apareció 1000%');
    assert.strictEqual(t.v, '—', 'sin ejecuciones consistentes: sin dato');
    assert.match(t.attrs, /DATOS INCONSISTENTES en 1 ciclo/);
  });
});

// ─── D04: ventana declarada, agregados completos ─────────────────────────────
test('D04: con 100 ciclos la lista muestra 30 y lo declara; las métricas usan los 100', async () => {
  const dir = tmp('cien'); crearFixture(dir);
  conDb(dir, (db) => {
    db.exec('DELETE FROM ciclos');
    for (let i = 0; i < 100; i++) {
      const d = new Date(Date.UTC(2026, 6, 1) + i * 3600e3).toISOString();
      ciclo(db, { ciclo_id: 'k' + i, estado: i < 10 ? 'COMPLETADO' : 'COMPLETADO_CON_PENDIENTES', fecha_inicio: d, fecha_fin: d });
    }
  });
  await conTablero(dir, (html) => {
    assert.match(html, /data-ventana="ciclos"[^>]*>· 30 de 100/);
    assert.strictEqual(kpi(html, 'goal').v, '10%', '10 cerrados de 100, no de los 30 visibles');
    assert.match(kpi(html, 'goal').attrs, /Cerrados íntegros 10 de 100/);
    assert.strictEqual([...html.matchAll(/data-clase="/g)].length <= 30, true);
  });
});

// ─── D16: fechas ─────────────────────────────────────────────────────────────
test('D16: SQLite, ISO-Z e ISO con offset dan el mismo instante; lo inválido queda en null', () => {
  const t = (x) => (fu.fechaUtc(x) ? fu.fechaUtc(x).toISOString() : null);
  assert.strictEqual(t('2026-09-01 10:00:00'), '2026-09-01T10:00:00.000Z', 'SQLite es UTC');
  assert.strictEqual(t('2026-09-01T10:00:00Z'), '2026-09-01T10:00:00.000Z');
  assert.strictEqual(t('2026-09-01T05:00:00-05:00'), '2026-09-01T10:00:00.000Z');
  assert.strictEqual(t('2026-09-01'), '2026-09-01T00:00:00.000Z');
  for (const malo of ['2026-13-01 10:00:00', '2026-02-30', '2026-09-01 25:00:00', 'ayer', '', null, undefined]) assert.strictEqual(t(malo), null, String(malo));
  assert.strictEqual(fu.formatearFecha(null, 'UTC'), 'sin fecha');
});

test('D16: el día cambia según la zona del proyecto y el orden es por instante, no por texto', () => {
  const d = fu.fechaUtc('2026-09-02 03:00:00');
  assert.strictEqual(fu.diaEnZona(d, 'UTC'), '2026-09-02');
  assert.strictEqual(fu.diaEnZona(d, 'America/Mexico_City'), '2026-09-01');
  const filas = [{ id: 1, f: '2026-09-01T09:00:00Z' }, { id: 2, f: '2026-09-01 10:00:00' }, { id: 3, f: '2026-09-01T08:30:00-05:00' }, { id: 10, f: '2026-09-01T09:00:00Z' }];
  assert.deepStrictEqual(filas.slice().sort((a, b) => fu.compararPorFecha(a, b, 'f')).map((x) => x.id), [1, 10, 2, 3]);
  assert.strictEqual(fu.zonaDeConfig('Zona horaria: America/Mexico_City'), 'America/Mexico_City');
  assert.strictEqual(fu.zonaDeConfig('Zona horaria: Marte/Base'), null);
});

test('D16: en el tablero un ciclo SQLite más nuevo sale antes que uno ISO más viejo del mismo día', async () => {
  const dir = tmp('fech'); crearFixture(dir);
  conDb(dir, (db) => {
    db.exec('DELETE FROM ciclos');
    ciclo(db, { ciclo_id: 'iso', tarea: 'Ciclo ISO viejo', estado: 'COMPLETADO', fecha_inicio: '2026-09-01T09:00:00Z', fecha_fin: '2026-09-01T09:30:00Z' });
    ciclo(db, { ciclo_id: 'sql', tarea: 'Ciclo SQLite nuevo', estado: 'COMPLETADO', fecha_inicio: '2026-09-01 11:00:00', fecha_fin: '2026-09-01 11:30:00' });
  });
  await conTablero(dir, (html) => {
    const a = html.indexOf('Ciclo SQLite nuevo'), b = html.indexOf('Ciclo ISO viejo');
    assert.ok(a > 0 && b > 0 && a < b, 'el orden siguió el texto, no el instante');
  });
});

// ─── D22: onboarding con estados reales ──────────────────────────────────────
test('D22: ciclos sin cierre verificado no completan el primer ciclo; config vacío no es configuración', async () => {
  const dir = tmp('onb'); crearFixture(dir);
  await conTablero(dir, (html) => {
    const sec = html.slice(html.indexOf('id="doc-onboarding"'));
    assert.match(sec, /Primer ciclo aa: completado<\/span>\s*<span[^>]*>pending/);
    assert.match(sec, /ningún ciclo con cierre verificado \(1 completados sin veredicto, 1 con pendientes\)/);
    assert.match(sec, /data-integracion="hosts" data-estado="sin_evidencia"/);
    assert.ok(!/data-integracion="whatsapp" data-estado="activ/.test(sec));
  });
  fs.writeFileSync(path.join(dir, '.agentic', 'config.md'), '');
  conDb(dir, (db) => db.exec("UPDATE ciclos SET estado='COMPLETADO_VERIFICADO' WHERE ciclo_id='c1'"));
  await conTablero(dir, (html) => {
    const sec = html.slice(html.indexOf('id="doc-onboarding"'));
    assert.match(sec, /config\.md configurado<\/span>\s*<span[^>]*>pending/);
    assert.match(sec, /config\.md vacío/);
    assert.match(sec, /Primer ciclo aa: completado<\/span>\s*<span[^>]*>done/);
  });
});

test('D22: TEAMS instalado no se afirma degradado ni verificado por el archivo', async () => {
  const dir = tmp('integ'); crearFixture(dir);
  const g = path.join(dir, '.agentic', 'grafo'); fs.mkdirSync(g, { recursive: true });
  fs.writeFileSync(path.join(g, 'teams-manager.cjs'), '// fixture\n');
  fs.writeFileSync(path.join(g, 'whatsapp-manager.cjs'), '// fixture\n');
  await conTablero(dir, (html) => {
    assert.match(html, /data-integracion="teams" data-estado="instalada"/);
    assert.doesNotMatch(html, /data-integracion="teams" data-estado="degradada"/);
    assert.doesNotMatch(html, /data-integracion="teams" data-estado="verificada"/);
    assert.match(html, /data-integracion="whatsapp" data-estado="instalada"/);
  });
});
