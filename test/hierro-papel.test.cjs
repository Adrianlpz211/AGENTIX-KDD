/**
 * Ninguna sección del protocolo puede prometer un script que nadie ejecuta.
 *
 * El problema de fondo de Agentix, medido el 03/09/2026: CLAUDE.md mezcla
 * reglas que ejecuta una máquina con reglas que dependen de que el modelo las
 * lea, y AMBAS SE VEN IGUAL. Tres casos reales de degradación silenciosa:
 *
 *   · el reloj prometía medir            → 96 de 155 ciclos sin duración
 *   · `stops_count` prometía contar      → 0 en 155, con 68 STOPs en la libreta
 *   · `ui-native-gate` era regla escrita → nunca se invocó desde ningún sitio
 *
 * Ninguno fue un bug. Fueron promesas que se cayeron sin que nada avisara.
 *
 * Este test cierra la categoría entera: si una sección nombra un `.cjs`, ese
 * script tiene que existir Y tener quien lo llame. Si no, o se declara en
 * PAPEL-ACEPTADO.json con su motivo — dejando constancia de la deuda — o el CI
 * se pone rojo. No hay tercera opción, que era justo la que existía antes.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const { analizar, secciones } = require('../.agentic/grafo/hierro-papel.cjs');

test('ninguna promesa de script queda sin quien la ejecute', () => {
  const r = analizar(RAIZ);
  assert.ok(!r.error, 'debe poder analizar CLAUDE.md');

  if (r.rotas.length) {
    const detalle = r.rotas
      .map((f) => `        · "${f.seccion}" nombra ${f.script} — ` +
        (f.existe ? 'existe pero nada lo invoca' : 'el archivo NO existe'))
      .join('\n');
    assert.fail(
      `${r.rotas.length} promesa(s) de papel disfrazadas de hierro:\n${detalle}\n` +
      '      O lo invoca alguien de verdad, o se declara en\n' +
      '      .agentic/grafo/PAPEL-ACEPTADO.json con el motivo.'
    );
  }
});

test('la mayoría del protocolo es hierro, no prosa', () => {
  /* No es un umbral estético: es la propiedad que hace que Agentix funcione
     igual con Claude, con Cursor o con el modelo de reserva al que se cae
     cuando se agota la cuota. Si la proporción se hunde, el framework vuelve a
     depender de que el modelo lea y obedezca. */
  const r = analizar(RAIZ);
  const proporcion = r.total ? r.hierro / r.total : 0;
  assert.ok(proporcion >= 0.7,
    `solo ${r.hierro} de ${r.total} promesas (${Math.round(proporcion * 100)}%) tienen quien las ejecute; ` +
    'el mínimo es 70% — por debajo, el protocolo vuelve a ser prosa que hay que recordar');
});

test('cada excepción declarada trae su motivo escrito', () => {
  /* Una lista de excepciones sin motivos se convierte en el basurero donde se
     esconde todo lo que no funciona. Con el motivo escrito, cada línea es una
     deuda que alguien puede leer y discutir. */
  const p = path.join(RAIZ, '.agentic', 'grafo', 'PAPEL-ACEPTADO.json');
  if (!fs.existsSync(p)) return;
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const [script, motivo] of Object.entries(j.aceptados || {})) {
    assert.ok(typeof motivo === 'string' && motivo.trim().length >= 25,
      `${script} está declarado como papel aceptado sin un motivo de verdad`);
  }
});

test('el analizador parte CLAUDE.md por secciones', () => {
  const s = secciones('# T\n\n## Uno\ntexto a.cjs\n\n## Dos\ntexto b\n');
  assert.equal(s.length, 2);
  assert.equal(s[0].titulo, 'Uno');
  assert.match(s[0].cuerpo, /a\.cjs/);
});
