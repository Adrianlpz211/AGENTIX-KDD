/**
 * La predicción se apunta y se califica. Antes ni lo uno ni lo otro.
 *
 * `prediccion.cjs` estimaba el riesgo de cada tarea, el enricher lo llamaba, y
 * la tabla `prediction_log` —con una columna literalmente llamada
 * `fue_correcto`— tenía CERO filas. El sistema predecía y nadie sabía si
 * acertaba. Una predicción que no se apunta es una opinión que se olvida.
 *
 * LA DECISIÓN QUE ESTOS TESTS PROTEGEN
 * ------------------------------------
 * Lo obvio sería contar "predijo ALTO y no pasó nada" como falsa alarma. Es un
 * error, y del que se paga caro: **un aviso atendido previene el problema**. Si
 * se penaliza ese caso, el camino natural es bajar la sensibilidad hasta que la
 * alerta no avisa de nada — y entonces el sistema parece perfecto y no sirve.
 *
 * Así que solo se califica lo que tiene verdad conocida, y el número que se
 * puede exigir que baje es uno solo: el FALSO NEGATIVO — predijo BAJO y se
 * rompió algo. Ese no admite interpretación.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { abrir, motivoSinDriver } = require('./helpers/sqlite.cjs');
const reg = require('../.agentic/grafo/prediccion-registro.cjs');
const RAIZ = path.join(__dirname, '..');

/** Un proyecto de mentira con la memoria mínima que hace falta. */
function proyecto() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-pred-'));
  fs.mkdirSync(path.join(root, '.agentic'));
  const db = abrir(path.join(root, '.agentic', 'memoria.db'));
  if (!db) return null;
  reg.asegurarEsquema(db);
  /* Las tablas de las que sale la verdad. */
  db.exec(`CREATE TABLE gate_events (id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT, gate TEXT, verdict TEXT, source TEXT, detalle TEXT)`);
  db.exec(`CREATE TABLE contract_violations (id INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id TEXT, created_at TEXT DEFAULT (datetime('now')))`);
  db.exec(`CREATE TABLE ciclos (id INTEGER PRIMARY KEY AUTOINCREMENT,
    stops_count INTEGER DEFAULT 0, fecha_fin TEXT)`);
  db.close();
  return root;
}

const romperAlgo = (root, gate = 'canario') => {
  const db = abrir(path.join(root, '.agentic', 'memoria.db'));
  db.prepare(`INSERT INTO gate_events (ts, gate, verdict, source)
              VALUES (datetime('now'), ?, 'STOP', 'mechanical')`).run(gate);
  db.close();
};

/* ── apuntar ───────────────────────────────────────────────────────────────── */

test('la predicción queda apuntada antes de tocar nada', (t) => {
  const root = proyecto();
  if (!root) return t.skip(motivoSinDriver());

  const id = reg.registrarPrediccion(root, {
    tarea: 'cambiar el manejo de sesiones', modulo: 'auth',
    nivel: 'ALTO', alertas: ['contrato protegido en riesgo'],
  });
  assert.ok(id && id.startsWith('pred-'), 'debe devolver un identificador');

  const db = abrir(path.join(root, '.agentic', 'memoria.db'));
  const f = db.prepare('SELECT * FROM prediction_log WHERE prediccion_id = ?').get(id);
  db.close();
  assert.equal(f.nivel_predicho, 'ALTO');
  assert.equal(f.modulo, 'auth');
  assert.match(String(f.alertas), /contrato protegido/, 'las alertas se guardan, no solo el nivel');
  assert.equal(f.evaluado_en, null, 'recién apuntada, sin calificar');
});

test('apuntar no puede tumbar el pipeline', () => {
  /* Fail-soft: sin memoria.db devuelve null y sigue. La predicción es un plus,
     nunca un requisito para poder trabajar. */
  const vacio = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-nada-'));
  assert.equal(reg.registrarPrediccion(vacio, { tarea: 'x' }), null);
});

/* ── la tabla de verdad, los cuatro casos ──────────────────────────────────── */

test('predijo BAJO y no pasó nada → ACIERTO', (t) => {
  const root = proyecto();
  if (!root) return t.skip(motivoSinDriver());
  reg.registrarPrediccion(root, { tarea: 'cambio trivial', nivel: 'BAJO' });
  const r = reg.evaluarPendientes(root, 'c1');
  assert.equal(r.aciertos, 1);
  assert.equal(r.falsosNegativos, 0);
});

test('predijo ALTO y se rompió algo → ACIERTO', (t) => {
  const root = proyecto();
  if (!root) return t.skip(motivoSinDriver());
  reg.registrarPrediccion(root, { tarea: 'tocar auth', nivel: 'ALTO' });
  romperAlgo(root, 'security');
  const r = reg.evaluarPendientes(root, 'c2');
  assert.equal(r.aciertos, 1, 'avisó y efectivamente pasó: la señal era buena');
});

test('predijo BAJO y se rompió algo → FALSO NEGATIVO', (t) => {
  /* EL ÚNICO NÚMERO SIN INTERPRETACIÓN POSIBLE. El sistema dijo "tranquilo" y
     no lo estaba. Es el que se puede exigir que baje. */
  const root = proyecto();
  if (!root) return t.skip(motivoSinDriver());
  reg.registrarPrediccion(root, { tarea: 'parecia inofensivo', nivel: 'BAJO' });
  romperAlgo(root);
  const r = reg.evaluarPendientes(root, 'c3');
  assert.equal(r.falsosNegativos, 1);
  assert.equal(r.aciertos, 0);

  const db = abrir(path.join(root, '.agentic', 'memoria.db'));
  const f = db.prepare('SELECT fue_correcto, hubo_problema, evidencia FROM prediction_log').get();
  db.close();
  assert.equal(f.fue_correcto, 0);
  assert.equal(f.hubo_problema, 1);
  assert.match(String(f.evidencia), /STOP/, 'debe guardar POR QUÉ se considera fallo');
});

test('predijo ALTO y no pasó nada → SIN VERDAD, no falsa alarma', (t) => {
  /* La decisión de fondo de todo este módulo. Un aviso atendido previene el
     problema; contarlo como error empuja a bajar la sensibilidad hasta que la
     alerta deja de servir. */
  const root = proyecto();
  if (!root) return t.skip(motivoSinDriver());
  reg.registrarPrediccion(root, { tarea: 'aviso atendido', nivel: 'ALTO' });
  const r = reg.evaluarPendientes(root, 'c4');
  assert.equal(r.sinVerdad, 1);
  assert.equal(r.falsosNegativos, 0, 'un aviso que funcionó NO es un fallo del sistema');
  assert.equal(r.aciertos, 0, 'y tampoco se apunta como acierto: no hay verdad que registrar');

  const db = abrir(path.join(root, '.agentic', 'memoria.db'));
  const f = db.prepare('SELECT fue_correcto FROM prediction_log').get();
  db.close();
  assert.equal(f.fue_correcto, null, 'sin verdad conocida se guarda NULL, no 0');
});

/* ── el informe ────────────────────────────────────────────────────────────── */

test('el acierto se calcula solo sobre lo comprobable', (t) => {
  const root = proyecto();
  if (!root) return t.skip(motivoSinDriver());

  reg.registrarPrediccion(root, { tarea: 'a', nivel: 'BAJO' });
  reg.evaluarPendientes(root, 'c');                    // acierto
  reg.registrarPrediccion(root, { tarea: 'b', nivel: 'ALTO' });
  reg.evaluarPendientes(root, 'c');                    // sin verdad

  const p = reg.precision(root);
  assert.equal(p.total, 2);
  assert.equal(p.conVerdad, 1, 'solo una tiene verdad conocida');
  assert.equal(p.acierto, 100,
    'meter las de verdad desconocida en el denominador bajaría el número por avisos que funcionaron');
});

test('una predicción de hace días no se cuelga del ciclo de hoy', (t) => {
  /* Sin ventana, una predicción huérfana de un trabajo abandonado se calificaría
     con lo que pasó tres días después. */
  const root = proyecto();
  if (!root) return t.skip(motivoSinDriver());
  const db = abrir(path.join(root, '.agentic', 'memoria.db'));
  db.prepare(`INSERT INTO prediction_log (prediccion_id, tarea, nivel_predicho, fecha)
              VALUES ('vieja', 'trabajo abandonado', 'BAJO', datetime('now','-3 days'))`).run();
  db.close();

  const r = reg.evaluarPendientes(root, 'c');
  assert.equal(r.evaluadas, 0, 'fuera de la ventana no se califica');
  assert.ok(reg.VENTANA_HORAS <= 24, 'la ventana debe ser de horas, no de días');
});

/* ── canarios de que el bucle sigue enchufado ──────────────────────────────── */

const soloCodigo = (t) => String(t)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split(String.fromCharCode(10))
  .filter((l) => !/^\s*(\/\/|\*)/.test(l))
  .join(String.fromCharCode(10));

test('el enricher apunta la predicción', () => {
  const ce = soloCodigo(fs.readFileSync(
    path.join(RAIZ, '.agentic', 'grafo', 'context-enricher.cjs'), 'utf8'));
  assert.match(ce, /registrarPrediccion\s*\(/,
    'el enricher corre al principio de todos los ciclos: es el único momento en que apuntar significa algo');
});

test('el post-cycle la califica', () => {
  const pc = soloCodigo(fs.readFileSync(
    path.join(RAIZ, '.agentic', 'grafo', 'post-cycle.cjs'), 'utf8'));
  assert.match(pc, /evaluarPendientes\s*\(/,
    'sin calificar al cerrar, la columna fue_correcto vuelve a quedarse vacía para siempre');

  /* Después de los gates: la verdad sale de lo que ellos registraron. */
  const iGate = pc.indexOf('runPreservationGate');
  const iEval = pc.indexOf('evaluarPendientes');
  assert.ok(iEval > iGate,
    'calificar antes de que los controles dejen su rastro es calificar contra nada');
});
