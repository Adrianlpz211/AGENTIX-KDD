'use strict';
// D10–D15 — retrabajo, incidentes, fricción, top-N, actividad y tiempos.
// La pantalla, el reporte y la API leen operativa.cjs: nadie vuelve a contar.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');
const op = require(path.join(REPO, '.agentic', 'grafo', 'operativa.cjs'));
const fx = require('./fixtures/dashboard-fixture.cjs');

const T0 = Date.parse('2026-09-01T10:00:00.000Z');
const ev = (o) => Object.assign({ id: 1, ts: '2026-09-01T10:00:00.000Z', gate: 'tdd', verdict: 'STOP', file: 'src/pagos.js', event_id: 'e1' }, o);

test('D11: tres lecturas del mismo error son un incidente; cierre + nueva falla = recurrencia', () => {
  const incs = op.incidentes([
    ev({ id: 1, event_id: 'a', verdict: 'STOP', ts: '2026-09-01T10:00:00.000Z' }),
    ev({ id: 2, event_id: 'b', verdict: 'STOP', ts: '2026-09-01T10:05:00.000Z' }),
    ev({ id: 3, event_id: 'c', verdict: 'STOP', ts: '2026-09-01T10:10:00.000Z' }),
    ev({ id: 4, event_id: 'd', verdict: 'PASS', ts: '2026-09-01T11:00:00.000Z', detalle: JSON.stringify({ subject_hash: 's1', execution_id: 'x1' }) }),
    ev({ id: 5, event_id: 'e', verdict: 'STOP', ts: '2026-09-01T12:00:00.000Z', detalle: JSON.stringify({ subject_hash: 's2' }) }),
  ]);
  assert.strictEqual(incs.length, 1);
  assert.strictEqual(incs[0].occurrences, 4);
  assert.strictEqual(incs[0].estado, 'RECURRENTE');
  assert.strictEqual(incs[0].recurrencias.length, 1);
});

test('D11: el mismo event_id no se cuenta dos veces', () => {
  const incs = op.incidentes([ev({ id: 1, event_id: 'mismo' }), ev({ id: 2, event_id: 'mismo' })]);
  assert.strictEqual(incs[0].occurrences, 1);
});

test('D10: un fix sin vínculo no es retrabajo; reabrir una entrega verificada sí', () => {
  const ciclos = [
    { ciclo_id: 'v1', estado: 'COMPLETADO_VERIFICADO', tipo_tarea: 'feature', modulo: 'pagos', fecha_inicio: '2026-09-01' },
    { ciclo_id: 'f1', estado: 'COMPLETADO', tipo_tarea: 'fix', modulo: 'pagos', fecha_inicio: '2026-09-02' },
    { ciclo_id: 'r1', estado: 'COMPLETADO', tipo_tarea: 'fix', modulo: 'pagos', fecha_inicio: '2026-09-03', original_task_id: 'v1' },
  ];
  const r = op.retrabajo(ciclos, []);
  assert.strictEqual(r.entregas_verificadas, 1);
  assert.strictEqual(r.reaperturas, 1);
  assert.strictEqual(r.arreglos_sin_vinculo, 1);
  assert.strictEqual(r.denominador, 'entregas verificadas');
});

test('D12: cien avisos sin tiempo medido no inventan horas; dos bloqueos a la vez son una hora de calendario', () => {
  const avisos = Array.from({ length: 100 }, (_, i) => ev({ id: i + 1, event_id: 'w' + i, verdict: 'WARN', file: 'src/a.js', gate: 'ui' }));
  const f1 = op.friccion(op.incidentes(avisos), { snapshotAt: T0 + 3600000 });
  assert.strictEqual(f1.incidentes, 1);
  assert.strictEqual(f1.eventos, 100);
  assert.strictEqual(f1.bloqueo.medido.calendario_ms, null);
  assert.strictEqual(f1.bloqueo.en_curso.n, 0);

  const bloqueos = op.incidentes([
    ev({ id: 1, event_id: 's1', verdict: 'STOP', file: 'a.js', gate: 'tdd', ts: '2026-09-01T10:00:00.000Z' }),
    ev({ id: 2, event_id: 's2', verdict: 'STOP', file: 'b.js', gate: 'reg', ts: '2026-09-01T10:00:00.000Z' }),
    ev({ id: 3, event_id: 'p1', verdict: 'PASS', file: 'a.js', gate: 'tdd', ts: '2026-09-01T11:00:00.000Z' }),
    ev({ id: 4, event_id: 'p2', verdict: 'PASS', file: 'b.js', gate: 'reg', ts: '2026-09-01T11:00:00.000Z' }),
  ]);
  const f2 = op.friccion(bloqueos, { snapshotAt: T0 + 2 * 3600000 });
  assert.strictEqual(f2.bloqueo.medido.acumulado_ms, 2 * 3600000);
  assert.strictEqual(f2.bloqueo.medido.calendario_ms, 3600000);
});

test('D13: 60 grupos — los 20 ocultos siguen en el total y "otros"', () => {
  const grupos = Array.from({ length: 60 }, (_, i) => ({ archivo: 'f' + String(i).padStart(2, '0'), gate: 'tdd', verdict: 'WARN', n: 60 - i }));
  const t = op.topN(grupos, 40, grupos.reduce((a, g) => a + g.n, 0));
  assert.strictEqual(t.filas.length, 40);
  assert.strictEqual(t.otros_grupos, 20);
  assert.ok(t.cuadra);
  assert.strictEqual(t.filas.reduce((a, g) => a + g.n, 0) + t.otros_eventos, t.total);
});

test('D14: un módulo terminado hace meses es ESTABLE; uno abierto sin latido, posible inactividad', () => {
  const ahora = T0 + 90 * 86400000;
  const a = op.actividad({
    ahora,
    modulos: [{ m: 'pagos' }, { m: 'pedidos' }],
    ciclos: [
      { modulo: 'pagos', estado: 'COMPLETADO_VERIFICADO', fecha_inicio: '2026-06-01', fecha_fin: '2026-06-02' },
      { modulo: 'pedidos', estado: 'EN_CURSO', fecha_inicio: '2026-06-01' },
    ],
    locks: [],
  });
  assert.strictEqual(a.modulos.find((x) => x.m === 'pagos').estado, 'ESTABLE');
  assert.strictEqual(a.modulos.find((x) => x.m === 'pedidos').estado, 'POSIBLE_INACTIVIDAD');
});

test('D15: dos agentes a la vez una hora → calendario 1 h, acumulado 2 h; sin fecha no es cero', () => {
  const ciclos = [
    { modulo: 'pagos', duracion_ms: 3600000, fecha_fin: '2026-09-01T11:00:00.000Z', fecha_inicio: '2026-09-01T10:00:00.000Z' },
    { modulo: 'pagos', duracion_ms: 3600000, fecha_fin: '2026-09-01T11:00:00.000Z', fecha_inicio: '2026-09-01T10:00:00.000Z' },
    { modulo: 'pedidos', duracion_ms: null, fecha_fin: null, fecha_inicio: '2026-09-01T10:00:00.000Z' },
  ];
  const t = op.tiempos({
    ciclos,
    fases: [
      { agente: 'front', duracion_ms: 3600000, fecha_fin: '2026-09-01T11:00:00.000Z' },
      { agente: 'back', duracion_ms: 3600000, fecha_fin: '2026-09-01T11:00:00.000Z' },
    ],
  });
  assert.strictEqual(t.total.acumulado_ms, 2 * 3600000);
  assert.strictEqual(t.total.calendario_ms, 3600000);
  assert.strictEqual(t.total.sin_dato, 1);
  assert.strictEqual(t.por_agente.front.acumulado_ms, 3600000);
  assert.strictEqual(t.por_agente.back.acumulado_ms, 3600000);
});

test('D10/D14: el tablero no usa % de fixes ni "21 días" como retrabajo o estancamiento', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-op-'));
  fx.crearFixture(dir);
  const srv = await fx.arrancarDashboard(dir);
  try {
    const html = await (await fetch(srv.url)).text();
    assert.ok(!/fueron arreglos/.test(html), 'sigue midiendo retrabajo como cantidad de fixes');
    assert.ok(!/21 días o más sin cerrar nada/.test(html), 'sigue llamando estancado a un módulo viejo');
    assert.match(html, /entregas verificadas|reaperturas|sin vínculo|ESTABLE|posible inactividad|calendario/i);
  } finally { srv.cerrar(); }
});
