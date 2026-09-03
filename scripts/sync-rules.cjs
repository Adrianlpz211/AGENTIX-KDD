#!/usr/bin/env node
/**
 * sync-rules — una sola fuente de reglas, varios destinos.
 *
 * EL PROBLEMA QUE CIERRA
 * ----------------------
 * CLAUDE.md y .cursorrules se mantenían a mano. Divergieron: 966 líneas
 * contra 169, y a Cursor dejaron de llegarle MODO LEGIÓN, Regression Guard,
 * Security Gate, Spec Gate, RECOVERY, POST-CYCLE y el Lock Manager. Nadie se
 * enteró porque dos ficheros mantenidos a mano divergen siempre y en silencio.
 *
 * El README prometía paridad y no existía.
 *
 * CÓMO LO CIERRA
 * --------------
 * La fuente es CLAUDE.md — el que ya se mantiene. De ahí se genera
 * .cursorrules. No hay un tercer formato que aprender ni un directorio nuevo
 * de reglas: el que escribe una regla la escribe donde siempre.
 *
 * Y lo que lo hace definitivo: test/reglas-paridad.test.cjs regenera y compara.
 * Si alguien toca CLAUDE.md y no regenera, el CI se pone ROJO. La divergencia
 * deja de poder ocurrir en silencio, que es la única forma en que ocurre.
 *
 *   node scripts/sync-rules.cjs           escribe los destinos
 *   node scripts/sync-rules.cjs --check   no escribe; sale 1 si hay divergencia
 */

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const FUENTE = path.join(RAIZ, 'CLAUDE.md');

/* Marcador tras el cual empieza el territorio del usuario. Lo que va después
   NO se propaga: es de cada proyecto, no de Agentix. */
const MARCADOR_USUARIO = /^#\s*INSTRUCCIONES DEL PROYECTO/m;

/* Bloques que solo tienen sentido en Claude Code y que a Cursor le sobran. */
const SOLO_CLAUDE = [
  /^## RECUPERACIÓN DE SESIÓN[\s\S]*?(?=^## |\Z)/m,
];

function leerFuente() {
  const txt = fs.readFileSync(FUENTE, 'utf8');
  const m = txt.match(MARCADOR_USUARIO);
  /* Solo la parte de Agentix; lo del usuario se queda donde está. */
  return m ? txt.slice(0, m.index) : txt;
}

function generarCursorrules() {
  let cuerpo = leerFuente();

  for (const re of SOLO_CLAUDE) cuerpo = cuerpo.replace(re, '');

  /* La cabecera propia de Cursor: reemplaza la de CLAUDE.md. */
  cuerpo = cuerpo.replace(
    /^# ={10,}\n# AGENTIC KDD[^\n]*\n# ={10,}\n(?:#[^\n]*\n)*/m, ''
  );

  const cabecera = [
    '# ============================================================',
    '# AGENTIC KDD — CONTROL TOTAL  (Cursor)',
    '# ============================================================',
    '# GENERADO por scripts/sync-rules.cjs desde CLAUDE.md.',
    '# NO editar a mano: el siguiente sync lo sobrescribe y el CI',
    '# se pone rojo si este archivo y CLAUDE.md divergen.',
    '#',
    '# Para cambiar una regla: edítala en CLAUDE.md y ejecuta',
    '#   node scripts/sync-rules.cjs',
    '#',
    '# Tus reglas propias van en .agentic/INSTRUCCIONES-PROYECTO.md',
    '# ============================================================',
    ''
  ].join('\n');

  /* Normalización: sin CRLF y sin colas de espacios, para que la comparación
     del test no salte por diferencias invisibles entre sistemas. */
  const limpio = cuerpo
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();

  return cabecera + '\n' + limpio + '\n';
}

const DESTINOS = [
  { archivo: '.cursorrules', generar: generarCursorrules }
];

function main() {
  const check = process.argv.includes('--check');
  let divergentes = 0;

  for (const d of DESTINOS) {
    const ruta = path.join(RAIZ, d.archivo);
    const esperado = d.generar();
    const actual = fs.existsSync(ruta)
      ? fs.readFileSync(ruta, 'utf8').replace(/\r\n/g, '\n')
      : null;

    if (actual === esperado) {
      console.log('  = ' + d.archivo + ' al día');
      continue;
    }

    divergentes++;
    if (check) {
      const a = actual ? actual.split('\n').length : 0;
      const e = esperado.split('\n').length;
      console.log('  ! ' + d.archivo + ' DIVERGE de CLAUDE.md  (' + a + ' líneas vs ' + e + ' esperadas)');
    } else {
      fs.writeFileSync(ruta, esperado, 'utf8');
      console.log('  + ' + d.archivo + ' regenerado (' + esperado.split('\n').length + ' líneas)');
    }
  }

  if (check && divergentes) {
    console.log('');
    console.log('  Ejecuta:  node scripts/sync-rules.cjs');
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { generarCursorrules, DESTINOS, RAIZ };
