/**
 * La memoria de diseño se llena sola, y solo grita cuando algo retrocede.
 *
 * Historia: la v1 solo vigilaba lo que alguien registrara a mano con `record`.
 * En un proyecto real con meses de trabajo hubo CERO registros — la tabla ni
 * llegó a existir. El post-cycle lo invocaba (eso estaba bien), corría, no
 * encontraba nada que vigilar, y protegía cero. Pedir que se documente cada
 * decisión de diseño a mano es pedir que no se documente.
 *
 * El equilibrio que hace esto usable está en dos propiedades opuestas y ambas
 * necesarias:
 *   · captura MUCHO   — si captura poco, no protege nada
 *   · avisa POCO      — si avisa de cada cambio, se desactiva en una semana
 * Solo se avisa de lo que casi seguro es un error: volver a un valor ya
 * abandonado, o perder una propiedad. Estos tests fijan las dos.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const uilm = require('../.agentic/grafo/ui-layout-memory.cjs');
const { extraerValores, guard, normSel } = uilm;
const { abrir, disponible, motivoSinDriver } = require('./helpers/sqlite.cjs');

/* ── extracción ────────────────────────────────────────────────────────────── */

test('captura estilos en línea de elementos con id', () => {
  const v = extraerValores('<div id="tour-panel" style="right: 12px; font-size: 15px">hola</div>');
  assert.equal(v.get('#tour-panel right').valor, '12px');
  assert.equal(v.get('#tour-panel font-size').valor, '15px');
});

test('captura reglas CSS de un solo selector', () => {
  const v = extraerValores('.cmp-card { padding: 8px; border-radius: 10px; }\n#hdr { height: 48px }');
  assert.equal(v.get('.cmp-card padding').valor, '8px');
  assert.equal(v.get('#hdr height').valor, '48px');
});

test('ignora selectores compuestos: son demasiados y cambian por mil motivos', () => {
  const v = extraerValores('.a .b:hover > span { color: red }');
  assert.equal(v.size, 0, 'un selector compuesto no es una decisión de diseño identificable');
});

test('ignora propiedades que no son de diseño', () => {
  const v = extraerValores('.x { cursor: pointer; transition: all .2s; padding: 4px }');
  assert.ok(!v.has('.x cursor'), 'cursor cambia por motivos funcionales, no de diseño');
  assert.ok(v.has('.x padding'), 'padding sí es una decisión de diseño');
});

test('no registra un valor ambiguo (el mismo selector declarado dos veces)', () => {
  /* Caso típico: la regla base y su variante dentro de un @media. No hay forma
     de saber cuál es "la" decisión — registrar una produciría una regresión
     falsa cada vez que el otro valor gane. */
  const v = extraerValores('.card { width: 100% }\n@media (min-width: 900px) {\n  .card { width: 480px }\n}');
  assert.ok(!v.has('.card width'), 'ante dos valores para el mismo selector, mejor no vigilar que vigilar mal');
});

test('un id con y sin almohadilla son el mismo elemento', () => {
  assert.equal(normSel('tour-panel'), '#tour-panel');
  assert.equal(normSel('#tour-panel'), '#tour-panel');
  assert.equal(normSel('.card'), '.card');
});

/* ── el ciclo completo, contra una base real ───────────────────────────────── */

function proyectoDePrueba() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-uilm-'));
  fs.mkdirSync(path.join(root, '.agentic'));
  const db = abrir(path.join(root, '.agentic', 'memoria.db'));
  if (!db) return null;
  try { db.close(); } catch {}
  return root;
}
const escribir = (root, css) => {
  fs.writeFileSync(path.join(root, 'estilo.css'), css);
  return 'estilo.css';
};

test('nadie registra nada a mano y aun así queda vigilado', (t) => {
  const root = proyectoDePrueba();
  if (!root) return t.skip(motivoSinDriver());
  const f = escribir(root, '#panel { right: 12px; width: 380px }');
  const r = guard(root, { files: [f], motivo: 'prueba' });
  assert.equal(r.capturados, 2, 'debe registrar los dos valores sin que nadie escriba un comando');
  assert.equal(r.findings.length, 0, 'la primera pasada establece la base, no acusa a nadie');
});

test('un cambio nuevo NO molesta — es trabajo normal', (t) => {
  const root = proyectoDePrueba();
  if (!root) return t.skip(motivoSinDriver());
  const f = escribir(root, '#panel { right: 12px }');
  guard(root, { files: [f], motivo: 'base' });
  escribir(root, '#panel { right: 24px }');
  const r = guard(root, { files: [f], motivo: 'el dev lo movió' });
  assert.equal(r.findings.length, 0,
    'avisar de cada cambio haría que se desactive, y con ello se pierde el aviso que sí importa');
});

test('volver a un valor ya abandonado SÍ avisa', (t) => {
  const root = proyectoDePrueba();
  if (!root) return t.skip(motivoSinDriver());
  const f = escribir(root, '#panel { right: 12px }');
  guard(root, { files: [f], motivo: 'base' });
  escribir(root, '#panel { right: 24px }');
  guard(root, { files: [f], motivo: 'el dev lo movió' });
  escribir(root, '#panel { right: 12px }');           // un merge lo devuelve
  const r = guard(root, { files: [f], motivo: 'merge' });

  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].esReversion, true);
  assert.equal(r.findings[0].elementId, '#panel');
  assert.equal(r.findings[0].decidido, '24px');
});

test('una propiedad que desaparece SÍ avisa (el bug right→left)', (t) => {
  const root = proyectoDePrueba();
  if (!root) return t.skip(motivoSinDriver());
  const f = escribir(root, '#panel { right: 12px; width: 380px }');
  guard(root, { files: [f], motivo: 'base' });
  escribir(root, '#panel { left: 12px; width: 380px }');
  const r = guard(root, { files: [f], motivo: 'alguien cambió el lado' });

  const ausente = r.findings.find((x) => x.ausente);
  assert.ok(ausente, 'perder una propiedad vigilada es exactamente el fallo que motivó el módulo');
  assert.equal(ausente.property, 'right');
});

test('list no revienta sobre una base sin la tabla', (t) => {
  /* Bug real de la v1: `list` abría la base en solo lectura y llamaba a
     ensureSchema, que hace CREATE TABLE. El comando de consulta fallaba
     siempre con "attempt to write a readonly database". */
  const root = proyectoDePrueba();
  if (!root) return t.skip(motivoSinDriver());
  const db = uilm.recordDecision(root, { elementId: 'x', property: 'top', value: '1px' });
  assert.equal(db.ok, true, 'debe poder registrar sobre una base recién creada');
});

/* ── canario: que post-cycle siga llamándolo, y mirando donde duele ────────── */

test('post-cycle captura de verdad y mira css y js, no solo html', () => {
  const pc = fs.readFileSync(
    path.join(__dirname, '..', '.agentic', 'grafo', 'post-cycle.cjs'), 'utf8');
  const i = pc.indexOf('UI Layout Memory');
  assert.ok(i > 0, 'post-cycle debe seguir invocando la memoria de layout');
  const bloque = pc.slice(i, i + 2200);

  assert.match(bloque, /capturar:\s*true/,
    'sin captura vuelve a depender de que alguien registre a mano — que es no depender de nada');
  for (const ext of ['css', 'js']) {
    assert.ok(new RegExp('\\b' + ext + '\\b').test(bloque),
      `el filtro debe incluir .${ext}: el front real vive ahí, no solo en .html`);
  }
});

/* ── las cinco formas de diseño que la v2 no veía ──────────────────────────
   Se midieron antes de escribir el código: en un proyecto real el diseño vive
   en siete formas y el extractor solo cubría dos. Estos tests fijan las otras. */

test('captura la LISTA DE CLASES de un elemento — el caso de la grilla', () => {
  /* El caso que pidió el dev: una grilla que pasa de tres columnas a dos
     cambiando solo su lista de clases. No hay ni una declaración CSS de por
     medio, y reordena una pantalla entera. */
  const v = extraerValores('<div id="tablero" class="cmp-grid cmp-grid-3 cmp-pad">x</div>');
  assert.equal(v.get('#tablero class').valor, 'cmp-grid cmp-grid-3 cmp-pad');
});

test('reordenar clases NO cuenta como cambio de diseño', () => {
  /* Si la lista se guardara tal cual, mover una clase de sitio saltaría como
     regresión. Se guarda ordenada para que solo cuente qué clases hay. */
  const a = extraerValores('<div id="x" class="uno dos tres">a</div>');
  const b = extraerValores('<div id="x" class="tres uno dos">a</div>');
  assert.equal(a.get('#x class').valor, b.get('#x class').valor);
});

test('las clases de estado no se vigilan: cambian solas', () => {
  const v = extraerValores('<div id="p" class="cmp-card is-active js-hook cmp-pad">x</div>');
  const clases = v.get('#p class').valor;
  assert.ok(!clases.includes('is-active'), 'is-active es estado, no diseño');
  assert.ok(!clases.includes('js-hook'), 'js- es un gancho de código');
  assert.ok(clases.includes('cmp-card') && clases.includes('cmp-pad'));
});

test('captura las variables CSS: son el sistema de diseño', () => {
  /* Un token cambiado repinta la aplicación entera. Es la señal de más valor y
     la lista blanca de propiedades la descartaba por no ser CSS "normal". */
  const v = extraerValores(':root { --color-marca: #26706e; --radio: 10px; }');
  assert.equal(v.get(':root --color-marca').valor, '#26706e');
  assert.equal(v.get(':root --radio').valor, '10px');
});

test('captura el estilo asignado desde JavaScript', () => {
  /* El caso del panel de la visita guiada: no hay CSS ni atributo que mirar. */
  const v = extraerValores(
    "document.getElementById('tour-panel').style.right = '12px';\n" +
    "document.getElementById('tour-panel').style.width = '380px';"
  );
  assert.equal(v.get('#tour-panel right').valor, '12px');
  assert.equal(v.get('#tour-panel width').valor, '380px');
});

test('un elemento sin ancla estable no se vigila', () => {
  /* `flex mt-4` no identifica nada: vigilar `.flex` sería vigilar media
     aplicación bajo un mismo nombre y dar avisos sin sentido. */
  const v = extraerValores('<div class="flex items-center gap-4">x</div>');
  assert.equal(v.size, 0);
});

test('data-testid vale como ancla', () => {
  /* En React casi nada lleva id, pero un testid lo puso alguien a propósito
     para referirse a ese elemento. */
  const v = extraerValores('<div data-testid="panel-kpi" class="cmp-card cmp-pad">x</div>');
  assert.equal(v.get('[panel-kpi] class').valor, 'cmp-card cmp-pad');
});

test('dos elementos con la misma primera clase y distinto contenido no se vigilan', () => {
  /* Ambigüedad: no se puede saber cuál es "la" decisión. Mejor no vigilar que
     dar una regresión falsa, porque una falsa enseña a ignorar los avisos. */
  const v = extraerValores(
    '<div class="cmp-card cmp-pad">a</div><div class="cmp-card cmp-ancho">b</div>'
  );
  assert.ok(!v.has('.cmp-card class'));
});

test('los tokens de tailwind.config SÍ se capturan', () => {
  /* En un proyecto de clases utilitarias esto es el sistema de diseño: las
     clases por elemento no se pueden vigilar, la paleta sí. Sin esto, la
     captura daba CERO en todo proyecto Tailwind. */
  const v = uilm.extraerTokensTailwind(`
    colors: {
      marca: { 600: '#26706e', 700: '#215a59' },
      tinta: { 900: '#3a3e40' },
    },
    fontSize: { base: '15px' },
  `);
  assert.equal(v.get('tailwind:marca 600').valor, '#26706e');
  assert.equal(v.get('tailwind:tinta 900').valor, '#3a3e40');
  assert.equal(v.get('tailwind:fontSize base').valor, '15px');
});

test('del tailwind.config no se captura lo que no es diseño', () => {
  const v = uilm.extraerTokensTailwind("content: './src/**/*.tsx',\n  prefix: 'tw-',");
  assert.equal(v.size, 0, 'una ruta de archivos no es una decisión visual');
});
