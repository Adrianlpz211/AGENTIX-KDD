/**
 * Juez tipado (decision-oracle) con el motor `reglas`.
 *
 * Fijan lo que hace que el juez sea confiable y no una opinión con número:
 *   1. el motor de reglas distingue lo evidente (tarea vs conversación, riesgo)
 *   2. la sombra NO influye en nada y NO rompe nunca
 *   3. la autoridad está acotada: tope por pregunta, subir exige evidencia
 *   4. un falso negativo en un caso decidido degrada al motor
 *   5. las métricas dan los números correctos sobre casos conocidos
 *   6. el historial se repite y se etiqueta sin duplicar
 *
 * La parte 6 necesita SQLite: sin driver se OMITE con su motivo (ver helpers/sqlite.cjs).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { abrir, motivoSinDriver } = require('./helpers/sqlite.cjs');
const J = require('../.agentic/grafo/decision-oracle.cjs');
const reglas = require('../.agentic/grafo/oraculo-motor-reglas.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'oraculo-'));
const p = (q, estado) => reglas.evaluar(J.PREGUNTAS[q], estado).p;

/* Motor de pruebas: contesta lo que se le diga, para fabricar casos conocidos. */
let _fijo = 0.5;
J.registrarMotor({ nombre: 'fijo', version: '1', externo: false, evaluar: () => ({ p: _fijo, razones: ['prueba'] }) });
const configFijo = (datos, modos) => J.guardarConfig(datos, { version: 1, motores: { reglas: { Q0: 'off', Q1: 'off', Q2: 'off' }, fijo: modos } });

function sembrar(datos, n, { p, y, q = 'Q0', ciclos = 1 }) {
  _fijo = p;
  const ids = [];
  for (let i = 0; i < n; i++) {
    const r = J.responder(datos, q, { tarea: 'caso ' + i }, { datos });
    const id = r.respuestas[0].id; ids.push(id);
    J.etiquetarManual(datos, id, y, { fuente: 'humano' });
  }
  return ids;
}

/* ── 1. el motor de reglas ─────────────────────────────────────────────────── */

test('Q0 distingue una tarea de una conversación', () => {
  assert.ok(p('Q0', { tarea: 'aa: arregla el login' }) >= 0.95);
  assert.ok(p('Q0', { tarea: 'implementa la paginación en src/api/users.ts' }) > 0.8);
  assert.ok(p('Q0', { tarea: '¿cómo funciona el goal-check?' }) < 0.1);
  assert.ok(p('Q0', { tarea: 'sigo sin entender pero ahora que mencionas eso el protocolo' }) < 0.3);
  assert.equal(p('Q0', { tarea: '' }), 0.5, 'sin texto no hay información: neutro');
});

test('Q1 sube con el nivel de la predicción y con las zonas críticas', () => {
  const t = 'cambia el formato de la respuesta';
  const bajo = p('Q1', { tarea: t, nivel: 'BAJO' });
  const medio = p('Q1', { tarea: t, nivel: 'MEDIO' });
  const alto = p('Q1', { tarea: t, nivel: 'ALTO' });
  assert.ok(bajo < medio && medio < alto, `${bajo} < ${medio} < ${alto}`);
  assert.ok(p('Q1', { tarea: 'actualiza el middleware de auth y migra el schema', nivel: 'BAJO' }) > bajo);
});

test('Q1 no ve riesgo donde no hay trabajo (una conversación no puede romperse)', () => {
  assert.ok(p('Q1', { tarea: 'sigo sin entender, gracias', nivel: 'ALTO' }) <= 0.05);
});

test('Q2 reconoce los valores que vigila el Spec Gate', () => {
  assert.ok(p('Q2', { tarea: 'cambia trial_days de 14 a 7' }) >= 0.8);
  assert.ok(p('Q2', { tarea: 'ajusta el precio del plan anual' }) > 0.3);
  assert.ok(p('Q2', { tarea: 'renombra una variable' }) < 0.1);
});

test('el motor explica sus respuestas y nunca lanza', () => {
  const r = reglas.evaluar(J.PREGUNTAS.Q1, { tarea: 'borra la tabla de usuarios', nivel: 'ALTO' });
  assert.ok(r.razones.length >= 2);
  assert.doesNotThrow(() => reglas.evaluar(J.PREGUNTAS.Q1, null));
  assert.equal(reglas.evaluar({ id: 'Q9' }, {}).soportada, false);
});

/* ── 2. la sombra ──────────────────────────────────────────────────────────── */

test('la sombra registra y no devuelve nada que pueda influir', () => {
  const d = tmp();
  const salida = J.sombra(d, { tarea: 'aa: algo', nivel: 'ALTO', prediccion_id: 'pred-1' }, { datos: d });
  assert.equal(salida, undefined);
  const log = J.leer(d);
  assert.deepEqual(log.respuestas.map((r) => r.pregunta).sort(), ['Q0', 'Q1', 'Q2']);
  assert.ok(log.respuestas.every((r) => r.modo === 'sombra' && r.motor === 'reglas'));
  const r = J.responder(d, 'Q0', { tarea: 'aa: algo' }, { datos: d });
  assert.equal(r.decision, null);
  assert.equal(r.consejo, null);
});

test('la sombra no rompe aunque no pueda escribir (fail-soft)', () => {
  const d = tmp();
  const archivo = path.join(d, 'no-es-un-directorio');
  fs.writeFileSync(archivo, 'x');
  assert.doesNotThrow(() => J.sombra(d, { tarea: 'aa: x' }, { datos: archivo }));
});

test('el registro guarda la tarea redactada y recortada, no el texto completo', () => {
  const d = tmp();
  J.sombra(d, { tarea: 'aa: usa la clave ' + 'sk-' + 'abcdefghijklmnop1234 ' + 'x'.repeat(500) }, { datos: d });
  const r = J.leer(d).respuestas[0];
  assert.ok(r.estado_min.tarea.length <= 200);
  assert.ok(!new RegExp('sk-' + 'abcdefghijklmnop1234').test(r.estado_min.tarea), 'un secreto no puede quedar en el registro');
});

/* ── 3. la autoridad ───────────────────────────────────────────────────────── */

test('el tope de la pregunta recorta la configuración', () => {
  const cfg = { motores: { reglas: { Q1: 'decide', Q2: 'decide' } } };
  assert.equal(J.modoEfectivo(cfg, 'reglas', 'Q1'), 'asesor', 'Q1 nunca decide: es riesgo, no una acción reversible');
  assert.equal(J.modoEfectivo(cfg, 'reglas', 'Q2'), 'asesor');
  assert.equal(J.modoEfectivo(cfg, 'reglas', 'Q3'), 'off', 'Q3 aún no existe');
});

test('un motor nuevo arranca apagado y reglas arranca en sombra', () => {
  assert.equal(J.modoEfectivo({ motores: {} }, 'reglas', 'Q1'), 'sombra');
  assert.equal(J.modoEfectivo({ motores: {} }, 'fijo', 'Q1'), 'off');
});

test('subir de modo exige evidencia; --forzar queda registrado', () => {
  const d = tmp();
  const r = J.fijarModo(d, { datos: d, motor: 'reglas', pregunta: 'Q0', modo: 'asesor' });
  assert.equal(r.status, 'RECHAZADO');
  assert.match(r.motivo, /evidencia/);
  assert.ok(r.veredicto.A.some((x) => !x.cumple));

  const tope = J.fijarModo(d, { datos: d, motor: 'reglas', pregunta: 'Q1', modo: 'decide', forzar: true });
  assert.equal(tope.status, 'RECHAZADO', 'ni forzando se supera el tope de la pregunta');

  const f = J.fijarModo(d, { datos: d, motor: 'reglas', pregunta: 'Q0', modo: 'asesor', forzar: true });
  assert.equal(f.status, 'OK');
  assert.ok(J.leer(d).eventos.some((e) => e.tipo === 'FORZADO'));
});

test('bajar de modo es libre', () => {
  const d = tmp();
  J.guardarConfig(d, { version: 1, motores: { reglas: { Q0: 'asesor' } } });
  assert.equal(J.fijarModo(d, { datos: d, motor: 'reglas', pregunta: 'Q0', modo: 'off' }).status, 'OK');
});

test('en modo decide solo actúa con confianza suficiente; en asesor solo aconseja', () => {
  const d = tmp();
  configFijo(d, { Q0: 'decide' });
  _fijo = 0.97;
  let r = J.responder(d, 'Q0', { tarea: 'x' }, { datos: d });
  assert.equal(r.decision.valor, 'si');
  _fijo = 0.6;
  r = J.responder(d, 'Q0', { tarea: 'x' }, { datos: d });
  assert.equal(r.decision, null, 'confianza baja: no decide');
  configFijo(d, { Q0: 'asesor' });
  _fijo = 0.97;
  r = J.responder(d, 'Q0', { tarea: 'x' }, { datos: d });
  assert.equal(r.decision, null);
  assert.equal(r.consejo.valor, 'si');
});

test('un falso negativo en un caso decidido degrada al motor a asesor', () => {
  const d = tmp();
  configFijo(d, { Q0: 'decide' });
  _fijo = 0.02;                       // dice "no es tarea" con alta confianza
  const r = J.responder(d, 'Q0', { tarea: 'x' }, { datos: d });
  assert.equal(r.decision.valor, 'no');
  const e = J.etiquetarManual(d, r.respuestas[0].id, 1);   // en realidad sí era una tarea
  assert.equal(e.degradados.length, 1);
  assert.equal(J.modoEfectivo(J.cargarConfig(d), 'fijo', 'Q0'), 'asesor');
  assert.equal(J.etiquetarManual(d, r.respuestas[0].id, 1).degradados.length, 0, 'idempotente');
});

/* ── 4. los números ────────────────────────────────────────────────────────── */

test('estadística: Brier, ECE, AUROC y cota sobre casos conocidos', () => {
  const { brier, ece, auroc, cotaSuperior } = J._estadistica;
  assert.ok(Math.abs(brier([0.9, 0.1], [1, 0]) - 0.01) < 1e-12);
  assert.ok(ece([0.95, 0.05, 0.95, 0.05], [1, 0, 1, 0]) < 0.06);
  assert.equal(auroc([0.9, 0.8, 0.2, 0.1], [1, 1, 0, 0]), 1);
  assert.equal(auroc([0.1, 0.2, 0.8, 0.9], [1, 1, 0, 0]), 0);
  assert.equal(auroc([0.5, 0.5], [1, 0]), 0.5, 'empate: sin información');
  assert.equal(auroc([0.5, 0.6], [0, 0]), null, 'sin positivos no hay AUROC');
  /* Regla del tres: 0 fallos en 60 positivos → cota ≈ 4,9 %. */
  assert.ok(Math.abs(cotaSuperior(0, 60) - 0.0487) < 0.001);
  assert.ok(cotaSuperior(0, 20) > 0.13, '20 casos sin fallo NO prueban un 5 %');
  assert.ok(cotaSuperior(3, 20) > 3 / 20);
});

test('métricas: la vara es el predictor constante, no el 50 %', () => {
  const d = tmp();
  configFijo(d, { Q1: 'sombra' });
  sembrar(d, 18, { p: 0.05, y: 0, q: 'Q1' });
  sembrar(d, 2, { p: 0.05, y: 1, q: 'Q1' });     // dos problemas que el motor no vio
  const m = J.metricas(d, { pregunta: 'Q1', motor: 'fijo' });
  assert.equal(m.etiquetadas, 20);
  assert.equal(m.positivos, 2);
  assert.equal(m.confusion.fn, 2);
  assert.equal(m.falso_negativo, 1);
  assert.equal(m.acierto, 0.9);
  assert.equal(m.acierto_constante, 0.9, 'decir siempre «no» ya da 90 %: ese es el número a superar');
});

test('métricas: sin etiquetas no inventa nada', () => {
  const d = tmp();
  J.sombra(d, { tarea: 'aa: x' }, { datos: d });
  const m = J.metricas(d, { pregunta: 'Q1', motor: 'reglas' });
  assert.equal(m.etiquetadas, 0);
  assert.equal(m.brier, undefined);
});

test('veredicto: pocos datos no prueban nada, aunque el acierto sea perfecto', () => {
  const d = tmp();
  configFijo(d, { Q1: 'sombra' });
  sembrar(d, 9, { p: 0.95, y: 1, q: 'Q1' });
  sembrar(d, 11, { p: 0.05, y: 0, q: 'Q1' });
  const v = J.veredicto(d, { pregunta: 'Q1', motor: 'fijo' });
  assert.equal(v.nivel_permitido, 'sombra');
  assert.match(v.nota, /insuficientes/);
});

test('veredicto: con evidencia suficiente permite asesor, y Q1 nunca pasa de ahí', () => {
  const d = tmp();
  configFijo(d, { Q1: 'sombra' });
  sembrar(d, 40, { p: 0.95, y: 1, q: 'Q1' });
  sembrar(d, 70, { p: 0.05, y: 0, q: 'Q1' });
  const v = J.veredicto(d, { pregunta: 'Q1', motor: 'fijo' });
  assert.equal(v.nivel_por_evidencia, 'asesor', 'sin 30 días de datos no llega a decide');
  assert.equal(v.nivel_permitido, 'asesor');
  assert.equal(v.tope_pregunta, 'asesor');
  assert.ok(v.B.find((x) => /30 días/.test(x.id)).cumple === false);
});

test('las etiquetas sintéticas no cuentan para promover', () => {
  const d = tmp();
  configFijo(d, { Q1: 'sombra' });
  _fijo = 0.9;
  for (let i = 0; i < 5; i++) {
    const r = J.responder(d, 'Q1', { tarea: 'm' + i }, { datos: d });
    J.etiquetarManual(d, r.respuestas[0].id, 1, { fuente: 'mutante' });
  }
  assert.equal(J.metricas(d, { pregunta: 'Q1', motor: 'fijo', fuente: 'real' }).etiquetadas, 0);
  assert.equal(J.metricas(d, { pregunta: 'Q1', motor: 'fijo', fuente: 'sintetico' }).etiquetadas, 5);
});

/* ── 5. el cableado ────────────────────────────────────────────────────────── */

test('el enricher llama al juez dentro de un try: medir nunca es un requisito', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '.agentic', 'grafo', 'context-enricher.cjs'), 'utf8');
  const i = src.indexOf("require(path.join(__dirname, 'decision-oracle.cjs'))");
  assert.ok(i > 0, 'el enricher debe invocar al juez');
  const antes = src.slice(Math.max(0, i - 60), i);
  assert.match(antes, /try\s*\{/);
  assert.match(src.slice(i, i + 700), /catch/);
});

test('el juez no tiene forma de tocar un gate (solo devuelve datos)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '.agentic', 'grafo', 'decision-oracle.cjs'), 'utf8');
  for (const prohibido of ['gate-telemetry', 'tdd-gate', 'security-gate', 'regression-guard', 'host-guard', 'child_process']) {
    assert.ok(!new RegExp(`require\\([^)]*${prohibido}`).test(src), `no debe importar ${prohibido}`);
  }
});

/* ── 6. historial y etiquetas desde la memoria del proyecto ────────────────── */

function proyectoConHistorial(t) {
  const raiz = tmp();
  fs.mkdirSync(path.join(raiz, '.agentic'), { recursive: true });
  const db = abrir(path.join(raiz, '.agentic', 'memoria.db'));
  if (!db) { t.skip(motivoSinDriver()); return null; }
  db.exec(`CREATE TABLE prediction_log (id INTEGER PRIMARY KEY AUTOINCREMENT, tarea TEXT, modulo TEXT, archivos TEXT,
    nivel_predicho TEXT, alertas TEXT, precondiciones TEXT, fue_correcto INTEGER, ciclo_id TEXT, fecha TEXT,
    hubo_problema INTEGER, evidencia TEXT, evaluado_en TEXT, prediccion_id TEXT)`);
  const ins = db.prepare(`INSERT INTO prediction_log (tarea, modulo, archivos, nivel_predicho, hubo_problema, evidencia, evaluado_en, prediccion_id)
    VALUES (?, 'global', '[]', ?, ?, ?, '2026-10-01', ?)`);
  ins.run('aa: arregla el login', 'BAJO', 0, null, 'pred-a');
  ins.run('aa: migra el schema de auth', 'ALTO', 1, '1 STOP de security', 'pred-b');
  ins.run('sigo sin entender pero ahora que mencionas eso', 'ALTO', 0, null, 'pred-c');
  db.close && db.close();
  return raiz;
}

test('backfill repite el historial, etiqueta Q1 con prediction_log y es idempotente', (t) => {
  const raiz = proyectoConHistorial(t); if (!raiz) return;
  const datos = tmp();
  const r1 = J.backfill(raiz, { datos });
  assert.equal(r1.filas, 3);
  assert.equal(r1.positivos, 1);
  const r2 = J.backfill(raiz, { datos });
  assert.equal(r2.nuevas, 0, 'una segunda pasada no duplica');
  const m = J.metricas(datos, { pregunta: 'Q1', motor: 'reglas' });
  assert.equal(m.etiquetadas, 3);
  assert.equal(m.positivos, 1);
  assert.equal(m.origen.backfill, 3);
  assert.equal(J.metricas(datos, { pregunta: 'Q0', motor: 'reglas' }).etiquetadas, 0, 'Q0 solo se etiqueta a mano');
  /* No se escribió nada en el proyecto leído. */
  assert.deepEqual(fs.readdirSync(path.join(raiz, '.agentic')).sort(), ['memoria.db']);
});

test('etiquetar liga la respuesta viva de Q1 con la calificación del post-cycle', (t) => {
  const raiz = proyectoConHistorial(t); if (!raiz) return;
  const datos = tmp();
  J.responder(raiz, 'Q1', { tarea: 'aa: migra el schema de auth', nivel: 'ALTO', prediccion_id: 'pred-b' }, { datos });
  J.responder(raiz, 'Q1', { tarea: 'aa: otra', nivel: 'BAJO', prediccion_id: 'pred-sin-calificar' }, { datos });
  const r = J.etiquetar(raiz, { datos });
  assert.equal(r.etiquetadas, 1);
  const m = J.metricas(datos, { pregunta: 'Q1', motor: 'reglas' });
  assert.equal(m.etiquetadas, 1);
  assert.equal(m.positivos, 1);
  assert.equal(m.sin_etiqueta, 1);
});

test('post-cycle etiqueta las respuestas del juez (sin esto la sombra responde y nadie le pone la verdad)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '.agentic', 'grafo', 'post-cycle.cjs'), 'utf8');
  const i = src.indexOf("decision-oracle.cjs");
  assert.ok(i > 0, 'post-cycle debe invocar al juez');
  assert.match(src.slice(Math.max(0, i - 200), i), /try\s*\{/);
  assert.match(src.slice(i, i + 400), /etiquetar\(ROOT/);
  assert.ok(src.indexOf('Step 2.12b') > src.indexOf('Step 2.12:'), 'va después de calificar la predicción: la verdad de Q1 sale de ahí');
});
