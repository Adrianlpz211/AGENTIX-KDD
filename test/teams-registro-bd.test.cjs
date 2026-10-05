'use strict';
/**
 * TEAMS no da por registrado lo que no está en la base.
 *
 * El caso real (proyecto «dashboard 3d», instalación manual): memoria.db sin las tablas base (`ciclos`, `nodos`, …).
 * post-cycle salía con 0 sin dejar nada y `teams-registro` marcaba 15 tareas REGISTRADA. El tablero decía «15 ciclos
 * registrados» y las pestañas de grafo KDD, Preservation Intel y línea de tiempo estaban vacías.
 *
 * Estos tests fijan:
 *   1. esquema base ausente → PENDIENTE con la causa y el comando de reparación, y NO se gastan los tests de la tarea
 *   2. post-cycle sale con 0 pero no deja el ciclo → PENDIENTE (antes: REGISTRADA)
 *   3. deja el ciclo → REGISTRADA y verificada
 *   4. lo que ya figuraba REGISTRADA sin comprobar se contrasta con la base y se reabre si no está
 *   5. una ronda no lanza un aluvión de registros
 *   6. sin archivos no se manda `AKDD_TEAMS_FILES=[]` (anulaba el respaldo de post-cycle)
 *   7. sin Git, los archivos de la tarea salen de lo modificado desde que empezó
 *
 * Sin driver de SQLite se OMITE con su motivo (helpers/sqlite.cjs).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { abrir, motivoSinDriver } = require('./helpers/sqlite.cjs');
const reg = require('../.agentic/grafo/teams-registro.cjs');
const HELPER = path.join(__dirname, 'helpers', 'sqlite.cjs').replace(/\\/g, '/');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-reg-bd-'));
const TAREA = (id = 'T-001') => ({ id, titulo: 'Hacer algo ' + id, texto: 'Archivos: src/a.ts' });
const ACEPT = { fecha: '2026-10-05', tests: 3 };

/** tablas: 'ninguna' (sin memoria.db) | 'parcial' (solo libreta, como dashboard 3d) | 'completa' (esquema base) */
function proyecto(t, tablas) {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.agentic'), { recursive: true });
  if (tablas === 'ninguna') return root;
  const db = abrir(path.join(root, '.agentic', 'memoria.db'));
  if (!db) { t.skip(motivoSinDriver()); return null; }
  db.exec('CREATE TABLE gate_events (id INTEGER PRIMARY KEY, ts TEXT, gate TEXT, verdict TEXT)');
  if (tablas === 'completa') {
    db.exec('CREATE TABLE ciclos (id INTEGER PRIMARY KEY, ciclo_id TEXT, estado TEXT)');
    for (const n of ['nodos', 'fases', 'episodios', 'relaciones']) db.exec(`CREATE TABLE ${n} (id INTEGER PRIMARY KEY)`);
  }
  if (db.close) db.close();
  return root;
}

/** post-cycle de mentira: anota que corrió (y con qué lista de archivos), y opcionalmente deja el ciclo en la base. */
function stub(root, { dejaCiclo, estado = 'COMPLETADO', salida = 0 } = {}) {
  const f = path.join(root, 'stub-post-cycle.cjs');
  fs.writeFileSync(f, `
const fs = require('fs'), path = require('path');
fs.appendFileSync(path.join(process.cwd(), 'stub-corrio.txt'), (process.env.AKDD_TEAMS_FILES === undefined ? '<ausente>' : process.env.AKDD_TEAMS_FILES) + '\\n');
${dejaCiclo ? `const db = require('${HELPER}').abrir(path.join(process.cwd(), '.agentic', 'memoria.db'));
db.prepare('INSERT INTO ciclos (ciclo_id, estado) VALUES (?, ?)').run(process.env.AKDD_CYCLE_ID, '${estado}'); if (db.close) db.close();` : ''}
process.exit(${salida});
`);
  return f;
}
const corridas = (root) => { try { return fs.readFileSync(path.join(root, 'stub-corrio.txt'), 'utf8').trim().split('\n'); } catch { return []; } };

test('esquema base ausente: queda PENDIENTE con la causa y la reparación, y NO se lanza post-cycle', (t) => {
  const root = proyecto(t, 'parcial'); if (!root) return;
  const r = reg.registrarTarea(root, TAREA(), ACEPT, { postCycle: stub(root, { dejaCiclo: false }) });
  assert.equal(r.estado, 'PENDIENTE');
  assert.match(r.causa, /ESQUEMA_SIN_MIGRAR/);
  assert.match(r.causa, /nodos.*ciclos|ciclos.*nodos/);
  assert.match(r.causa, /schema-columns\.cjs fix/, 'dice cómo repararlo');
  assert.deepEqual(corridas(root), [], 'no se gastan los tests de la tarea en algo que no puede quedar escrito');
  assert.equal(reg.estadoBase(root, { sinCache: true }).estado, 'SIN_MIGRAR');
});

test('post-cycle sale con 0 pero no deja el ciclo: PENDIENTE, no REGISTRADA', (t) => {
  const root = proyecto(t, 'completa'); if (!root) return;
  const r = reg.registrarTarea(root, TAREA(), ACEPT, { postCycle: stub(root, { dejaCiclo: false }) });
  assert.equal(r.estado, 'PENDIENTE');
  assert.match(r.causa, /CICLO_NO_REGISTRADO/);
  assert.equal(reg.resumen(root).registradas, 0, 'el tablero no cuenta lo que no está en la base');
  assert.equal(reg.pendientes(root).length, 1);
});

test('un ciclo que quedó EN_CURSO tampoco cuenta como registrado', (t) => {
  const root = proyecto(t, 'completa'); if (!root) return;
  const r = reg.registrarTarea(root, TAREA(), ACEPT, { postCycle: stub(root, { dejaCiclo: true, estado: 'EN_CURSO' }) });
  assert.equal(r.estado, 'PENDIENTE');
  assert.match(r.causa, /CICLO_NO_CERRADO/);
});

test('post-cycle deja el ciclo cerrado: REGISTRADA y verificada en la base', (t) => {
  const root = proyecto(t, 'completa'); if (!root) return;
  const r = reg.registrarTarea(root, TAREA(), ACEPT, { postCycle: stub(root, { dejaCiclo: true }) });
  assert.equal(r.estado, 'REGISTRADA');
  assert.equal(r.verificada, true);
  const s = reg.resumen(root);
  assert.equal(s.registradas, 1); assert.equal(s.verificadas, 1); assert.equal(s.sin_verificar, 0);
  assert.equal(reg.registrarTarea(root, TAREA(), ACEPT, { postCycle: stub(root, { dejaCiclo: true }) }).estado, 'YA_REGISTRADA', 'idempotente');
  assert.equal(corridas(root).length, 1);
});

test('sin memoria.db no se puede comprobar: sigue como antes, pero queda marcada «sin verificar»', (t) => {
  const root = proyecto(t, 'ninguna'); if (!root) return;
  const r = reg.registrarTarea(root, TAREA(), ACEPT, { postCycle: stub(root, { dejaCiclo: false }) });
  assert.equal(r.estado, 'REGISTRADA');
  assert.equal(r.verificada, false);
  assert.equal(reg.resumen(root).sin_verificar, 1);
});

test('lo que figuraba REGISTRADA sin comprobar se contrasta con la base: sin ciclo se reabre, con ciclo se confirma', (t) => {
  const root = proyecto(t, 'completa'); if (!root) return;
  const db = abrir(path.join(root, '.agentic', 'memoria.db'));
  db.prepare('INSERT INTO ciclos (ciclo_id, estado) VALUES (?, ?)').run('teams_esta', 'COMPLETADO'); if (db.close) db.close();
  fs.mkdirSync(path.join(root, '.agentic', '_teams'), { recursive: true });
  const vieja = (id, ciclo) => ({ id, titulo: id, ciclo, area: 'x', archivos: 1, intentos: 1, at: '2026-10-05T00:00:00.000Z', estado: 'REGISTRADA', causa: null });
  fs.writeFileSync(path.join(root, '.agentic', '_teams', 'registro.json'), JSON.stringify({ tareas: { a: vieja('T-001', 'teams_esta'), b: vieja('T-002', 'teams_falta') }, memoria: {} }));
  const r = reg.reverificar(root);
  assert.deepEqual(r, { revisadas: 2, reabiertas: 1 });
  const tareas = reg.leerRegistro(root).tareas;
  assert.equal(tareas.a.estado, 'REGISTRADA'); assert.equal(tareas.a.verificada, true);
  assert.equal(tareas.b.estado, 'PENDIENTE'); assert.match(tareas.b.causa, /REVERIFICADA: CICLO_NO_REGISTRADO/);
  assert.equal(tareas.b.intentos, 0, 'puede reintentarse enseguida');
  assert.deepEqual(reg.reverificar(root), { revisadas: 0, reabiertas: 0 }, 'ya no quedan dudosas');
});

test('reverificar sin base accesible no reabre nada (no se inventan fallos)', (t) => {
  const root = proyecto(t, 'ninguna'); if (!root) return;
  fs.mkdirSync(path.join(root, '.agentic', '_teams'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agentic', '_teams', 'registro.json'), JSON.stringify({ tareas: { a: { id: 'T-001', ciclo: 'teams_x', estado: 'REGISTRADA' } }, memoria: {} }));
  assert.deepEqual(reg.reverificar(root), { revisadas: 0, reabiertas: 0 });
  assert.equal(reg.leerRegistro(root).tareas.a.estado, 'REGISTRADA');
});

test('una ronda no lanza más registros que su presupuesto', (t) => {
  const root = proyecto(t, 'completa'); if (!root) return;
  const presupuesto = { restantes: 1 };
  const s = stub(root, { dejaCiclo: true });
  const a = reg.registrarTarea(root, TAREA('T-001'), ACEPT, { postCycle: s, presupuesto });
  const b = reg.registrarTarea(root, TAREA('T-002'), ACEPT, { postCycle: s, presupuesto });
  assert.equal(a.estado, 'REGISTRADA');
  assert.equal(b.estado, 'EN_ESPERA'); assert.equal(b.causa, 'PRESUPUESTO_DE_RONDA');
  assert.equal(corridas(root).length, 1);
  assert.equal(Object.keys(reg.leerRegistro(root).tareas).length, 1, 'lo que no se intentó no deja registro');
  const c = reg.registrarTarea(root, TAREA('T-002'), ACEPT, { postCycle: s, presupuesto: { restantes: 1 } });
  assert.equal(c.estado, 'REGISTRADA', 'en la ronda siguiente le toca');
});

test('el fallo del esquema no gasta el presupuesto de la ronda (no cuesta nada comprobarlo)', (t) => {
  const root = proyecto(t, 'parcial'); if (!root) return;
  const presupuesto = { restantes: 1 };
  reg.registrarTarea(root, TAREA('T-001'), ACEPT, { postCycle: stub(root), presupuesto });
  assert.equal(presupuesto.restantes, 1);
});

test('sin archivos no se manda AKDD_TEAMS_FILES vacío; con archivos sí', (t) => {
  const root = proyecto(t, 'completa'); if (!root) return;
  const s = stub(root, { dejaCiclo: true });
  reg.registrarTarea(root, { id: 'T-001', titulo: 'sin archivos', texto: '' }, ACEPT, { postCycle: s });
  reg.registrarTarea(root, TAREA('T-002'), ACEPT, { postCycle: s });
  const [sin, con] = corridas(root);
  assert.equal(sin, '<ausente>', '«[]» es verdadero para post-cycle y anulaba su respaldo');
  assert.deepEqual(JSON.parse(con), ['src/a.ts']);
});

test('sin Git, los archivos de la tarea son los modificados desde que empezó (sin node_modules ni .agentic)', () => {
  const root = tmp();
  const poner = (rel, edadMs) => {
    const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'x');
    const t = new Date(Date.now() - edadMs); fs.utimesSync(p, t, t);
  };
  poner('src/nuevo.ts', 1000); poner('src/viejo.ts', 3600 * 1000);
  poner('node_modules/x/index.js', 1000); poner('.agentic/estado.json', 1000); poner('captura.png', 1000);
  const inicio = Date.now() - 10 * 60 * 1000;
  assert.deepEqual(reg.archivosPorFecha(root, inicio), ['src/nuevo.ts']);
  assert.deepEqual(reg.archivosDe(root, { texto: '' }, null, inicio), ['src/nuevo.ts'], 'archivosDe usa el respaldo cuando no es un repositorio Git');
  assert.deepEqual(reg.archivosDe(root, { texto: '' }, null, null), [], 'sin hora de inicio no se inventa');
  assert.deepEqual(reg.archivosPorFecha(root, NaN), []);
});

test('el panel de Teams avisa de la base sin migrar y separa lo comprobado de lo no comprobado', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '.agentic', 'grafo', 'teams-pagina.cjs'), 'utf8');
  assert.match(src, /SIN MIGRAR/);
  assert.match(src, /d\.registro\.verificadas/);
  assert.match(src, /sin_verificar/);
  const teams = fs.readFileSync(path.join(__dirname, '..', '.agentic', 'grafo', 'teams.cjs'), 'utf8');
  assert.match(teams, /reg\.reverificar\(root\)/, 'observar contrasta lo viejo con la base');
  assert.match(teams, /presupuesto/);
});

/* ── lo aprendido al aceptar llega a la memoria KDD ───────────────────────────
   En `aa:` los agentes de memoria escriben decisiones, errores y patrones; en TEAMS nadie lo hacía y el grafo KDD
   se quedaba vacío. `aceptar --aprendizaje` es el equivalente: una lección real, una sola vez, y solo si se da. */

test('aceptar --aprendizaje manda la lección a la memoria KDD una sola vez; sin la opción no escribe nada', () => {
  const T = require('../.agentic/grafo/teams.cjs');
  const kdd = require('../.agentic/grafo/kdd-memory.cjs');
  const root = tmp(); fs.mkdirSync(path.join(root, '.agentic'), { recursive: true });
  const original = kdd.remember; const llamadas = [];
  kdd.remember = (entrada, opciones) => { llamadas.push({ entrada, opciones }); return { ok: true, id: 'nodo-' + llamadas.length }; };
  process.env.AKDD_TEAMS_POSTCYCLE = stub(root, { dejaCiclo: false });
  try {
    const run = (...a) => T.ejecutar(a, root).out;
    run('activar'); run('modo', 'completo'); run('iniciar');
    run('tarea', 'Login con correo', '--criterio=valida', '--archivos=src/auth/login.js');
    run('tarea', 'Recibos', '--criterio=emite', '--archivos=src/pagos/recibo.js');
    run('reportar', 'T-001', '--estado=HECHO', '--detalle=listo', '--archivos=src/auth/login.js');
    run('reportar', 'T-002', '--estado=HECHO', '--detalle=listo', '--archivos=src/pagos/recibo.js');

    const sin = run('aceptar', 'T-001');
    assert.equal(llamadas.length, 0, 'sin --aprendizaje no se inventa ninguna lección');
    assert.ok(!/memoria KDD/.test(sin));

    const con = run('aceptar', 'T-002', '--aprendizaje=El recibo se emite al confirmar el pago, no al crearlo: evita recibos huérfanos', '--tipo=error');
    assert.equal(llamadas.length, 1);
    assert.match(llamadas[0].entrada, /^\[T-002\] Recibos\. El recibo se emite al confirmar/);
    assert.equal(llamadas[0].opciones.tipo, 'error');
    assert.equal(llamadas[0].opciones.area, 'src', 'el área sale de los archivos reales');
    assert.deepEqual(llamadas[0].opciones.archivos, ['src/pagos/recibo.js']);
    assert.match(con, /registrado como error/);

    const otra = run('aceptar', 'T-002', '--aprendizaje=El recibo se emite al confirmar el pago, no al crearlo: evita recibos huérfanos', '--tipo=error');
    assert.equal(llamadas.length, 1, 'repetirlo no duplica el nodo');
    assert.match(otra, /ya estaba/);

    const raro = run('aceptar', 'T-001', '--aprendizaje=Otra lección', '--tipo=cualquiera');
    assert.equal(llamadas[1].opciones.tipo, 'decision', 'un tipo desconocido cae en «decision»');
    assert.match(raro, /registrado como decision/);
  } finally { kdd.remember = original; delete process.env.AKDD_TEAMS_POSTCYCLE; }
});

test('si la memoria KDD no responde, aceptar avisa y NO se frena', () => {
  const T = require('../.agentic/grafo/teams.cjs');
  const kdd = require('../.agentic/grafo/kdd-memory.cjs');
  const root = tmp(); fs.mkdirSync(path.join(root, '.agentic'), { recursive: true });
  const original = kdd.remember; kdd.remember = () => ({ ok: false, reason: 'MEMORIA_OCUPADA' });
  process.env.AKDD_TEAMS_POSTCYCLE = stub(root, { dejaCiclo: false });
  try {
    const run = (...a) => T.ejecutar(a, root).out;
    run('activar'); run('modo', 'completo'); run('iniciar');
    run('tarea', 'Algo', '--criterio=hecho', '--archivos=src/a.js');
    run('reportar', 'T-001', '--estado=HECHO', '--detalle=listo');
    const r = run('aceptar', 'T-001', '--aprendizaje=lección');
    assert.match(r, /ACEPTADA/);
    assert.match(r, /memoria KDD pendiente \(MEMORIA_OCUPADA\)/);
  } finally { kdd.remember = original; delete process.env.AKDD_TEAMS_POSTCYCLE; }
});
