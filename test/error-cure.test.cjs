/**
 * La cura conocida llega, y llega solo cuando hay motivo.
 *
 * Historia: el enricher tenía escrito el mensaje "Cura conocida" y NUNCA lo
 * imprimió. Tres cortocircuitos a la vez — exigía un ancla de símbolo que 0 de
 * 29 errores tenían, consultaba una tabla con 0 filas, y solo corría con riesgo
 * ALTO. La memoria tenía 25 soluciones escritas y nadie las leía.
 *
 * Y la trampa contraria: los 397 edges `resuelto_por` de esa misma base son un
 * producto cartesiano (cada error enlazado a los ~27 patrones de su área). Un
 * arreglo ingenuo — "pues conectemos la tubería" — habría metido 27 curas
 * falsas por error en cada brief. Peor que no tener nada: una cura equivocada
 * manda al dev en la dirección contraria.
 *
 * Por eso estos tests vigilan LAS DOS caras: que la cura buena aparezca, y que
 * el ruido no. Y el último es el canario: si alguien devuelve el enricher a
 * exigir anclas o a consultar was_fixed_by, el CI se pone rojo.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { findCures, parseSecciones } = require('../.agentic/grafo/error-cure.cjs');
const { abrir, disponible, motivoSinDriver } = require('./helpers/sqlite.cjs');

/* ── una base de juguete con los casos que importan ───────────────────────── */
function dbDePrueba() {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-cura-')), 'memoria.db');
  const db = abrir(f);
  if (!db) return null;
  db.exec(`CREATE TABLE nodos (
    id INTEGER PRIMARY KEY, tipo TEXT, titulo TEXT, contenido TEXT,
    area TEXT, confianza TEXT, estado TEXT, archivos_aplica TEXT)`);

  const ins = db.prepare(`INSERT INTO nodos
    (tipo,titulo,contenido,area,confianza,estado,archivos_aplica) VALUES (?,?,?,?,?,?,?)`);

  /* 1. El caso bueno: error con solución escrita y archivo declarado. */
  ins.run('error', 'compras — el import no arrancaba',
    'Error: no definía la función corta.\nSíntoma: el modal no abre, consola con ReferenceError.\n' +
    'Causa: se asumió una global del shell.\nSolución: declarar la función al inicio del IIFE.\n' +
    'Prevención: nunca asumir globales del shell en un JS de legacy.',
    'compras', 'ALTA', 'RESUELTO', '["compras-cotizacion-detalle.js"]');

  /* 2. Ruido: mismo área, ninguna relación con la tarea. */
  ins.run('error', 'compras — el reporte de cierre sale en blanco',
    'Síntoma: PDF vacío.\nSolución: pasar el rango de fechas al generador.',
    'compras', 'ALTA', 'RESUELTO', '[]');

  /* 3. Error SIN solución escrita: no es una cura, es un susto. */
  ins.run('error', 'compras — a veces el tablero parpadea',
    'Síntoma: parpadeo al filtrar en compras-cotizacion-detalle.js.\nCausa: desconocida.',
    'compras', 'BAJA', 'ACTIVO', '["compras-cotizacion-detalle.js"]');

  return db;
}

test('la cura aparece cuando la tarea nombra el archivo del error', (t) => {
  const db = dbDePrueba();
  if (!db) return t.skip(motivoSinDriver());
  const r = findCures(db, {
    task: 'arreglar el modal de importar en compras-cotizacion-detalle.js',
    areas: ['compras'],
  });
  assert.ok(r.length >= 1, 'debe encontrar al menos una cura');
  assert.match(r[0].titulo, /import no arrancaba/);
  assert.match(r[0].solucion, /al inicio del IIFE/,
    'debe traer la solución, no solo el título del error');
});

test('un error SIN solución escrita nunca se ofrece como cura', (t) => {
  const db = dbDePrueba();
  if (!db) return t.skip(motivoSinDriver());
  const r = findCures(db, {
    task: 'el tablero parpadea en compras-cotizacion-detalle.js',
    areas: ['compras'],
  });
  assert.ok(!r.some((c) => /parpadea/.test(c.titulo)),
    'un error sin Solución: no cura nada — ofrecerlo solo asusta');
});

test('compartir área NO basta: es el ruido que hundió los 397 edges', (t) => {
  const db = dbDePrueba();
  if (!db) return t.skip(motivoSinDriver());
  /* Tarea de compras que no tiene nada que ver con el reporte de cierre. */
  const r = findCures(db, { task: 'cambiar el color del botón guardar', areas: ['compras'] });
  assert.ok(!r.some((c) => /reporte de cierre/.test(c.titulo)),
    'el área es desempate, no evidencia — si admitiera, cada brief traería los 27 errores del área');
});

test('la solución llega entera, con su prevención', (t) => {
  const db = dbDePrueba();
  if (!db) return t.skip(motivoSinDriver());
  const r = findCures(db, {
    task: 'modal de importar en compras-cotizacion-detalle.js',
    areas: ['compras'],
  });
  assert.match(r[0].prevencion || '', /globales del shell/,
    'si el nodo declara Prevención, debe llegar: es lo que evita la repetición');
});

test('parseSecciones separa las secciones del nodo', () => {
  const s = parseSecciones(
    'Error: se rompió.\nSíntoma: pantalla en blanco.\nCausa: null.\nSolución: comprobar antes de usar.'
  );
  assert.equal(s.sintoma, 'pantalla en blanco.');
  assert.equal(s.solucion, 'comprobar antes de usar.');
  assert.equal(s.causa, 'null.');
});

/* ── canarios contra la regresión exacta que ocurrió ──────────────────────── */

const ENRICHER = fs.readFileSync(
  path.join(__dirname, '..', '.agentic', 'grafo', 'context-enricher.cjs'), 'utf8');

test('el enricher busca curas SIEMPRE, no solo con riesgo ALTO', () => {
  const i = ENRICHER.indexOf('findCures');
  assert.ok(i > 0, 'el enricher debe llamar a findCures');

  /* Las 12 líneas anteriores a la llamada no pueden condicionarla al riesgo:
     un error se repite igual en una tarea que parecía trivial. */
  const antes = ENRICHER.slice(0, i).split('\n').slice(-12).join('\n');
  assert.ok(!/if\s*\(\s*brief\.riesgo\s*===?\s*'ALTO'/.test(antes),
    'la búsqueda de curas no puede volver a quedar detrás de un if de riesgo ALTO');
});

test('el enricher no vuelve a exigir anclas ni a consultar was_fixed_by', () => {
  /* Los dos cortocircuitos que la mantuvieron apagada. Se permite nombrarlos
     en un comentario (la historia es útil), pero no ejecutarlos. */
  const codigo = ENRICHER.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  assert.ok(!/was_fixed_by/.test(codigo),
    'was_fixed_by tenía 0 filas: consultarlo es garantizar que no dispare');
  assert.ok(!/tipo='error'[\s\S]{0,120}anclas\s+IS\s+NOT\s+NULL/i.test(codigo),
    'exigir ancla de símbolo descartaba los 29 errores: no puede volver');
});

test('el brief IMPRIME la cura, no solo la guarda', () => {
  /* El fallo real durante la implementación: findCures encontraba las curas y
     brief.curas se llenaba, pero la sección de impresión nunca se insertó. Se
     buscaba bien y no se veía nada. */
  const i = ENRICHER.indexOf('function printBrief');
  assert.ok(i > 0);
  const print = ENRICHER.slice(i);
  assert.match(print, /brief\.curas/,
    'printBrief debe emitir las curas — encontrarlas y no mostrarlas es no tenerlas');
  assert.ok(print.indexOf('brief.curas') < print.indexOf("'**Avisos:**'"),
    'la cura va antes de los avisos: es lo único del brief que ya trae la respuesta');
});
