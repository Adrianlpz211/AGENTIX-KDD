'use strict';

/**
 * Hierro o papel — qué del protocolo se ejecuta y qué solo se lee.
 *
 * EL PROBLEMA QUE CIERRA
 * ----------------------
 * CLAUDE.md mezcla dos cosas que se ven exactamente igual: reglas que las
 * ejecuta una máquina y reglas que dependen de que el modelo las lea y
 * obedezca. Nadie puede distinguirlas mirando el archivo.
 *
 * Y eso no es teórico. Tres ejemplos medidos el 03/09/2026:
 *   · el reloj de la línea de tiempo prometía medir       → 96 de 155 ciclos sin dato
 *   · `stops_count` prometía contar frenos                → 0 en 155, con 68 STOPs en la libreta
 *   · `ui-native-gate` estaba escrito como regla de prosa → nunca se invocó desde ningún sitio
 *
 * Ninguno era un bug. Eran promesas de papel que se degradaron en silencio,
 * que es la única forma en que se degradan.
 *
 * CÓMO LO DETECTA — sin que nadie tenga que anotar nada
 * ----------------------------------------------------
 * Cada sección de CLAUDE.md que nombra un script `.cjs` está prometiendo que
 * ese script corre. Esto comprueba las dos condiciones de esa promesa:
 *
 *   1. el archivo EXISTE
 *   2. alguien lo INVOCA de verdad — un hook, el post-cycle, u otro script.
 *      Nombrarlo solo en CLAUDE.md no cuenta: eso es justo el problema.
 *
 * Una sección que nombra un script que nadie invoca es papel disfrazado de
 * hierro. Eso es lo que el test convierte en rojo de CI.
 *
 *   node .agentic/grafo/hierro-papel.cjs            inventario legible
 *   node .agentic/grafo/hierro-papel.cjs --check    sale 1 si hay promesas rotas
 */

const fs = require('fs');
const path = require('path');

const safe = (fn, fb = null) => { try { return fn(); } catch { return fb; } };

/* Sitios desde los que una invocación cuenta como real. CLAUDE.md y
   .cursorrules quedan fuera a propósito: son la promesa, no su cumplimiento. */
const INVOCADORES = [
  { dir: '.agentic/grafo', patron: /\.cjs$/ },
  { dir: '.agentic/grafo/git-hooks', patron: /.*/ },
  { dir: 'scripts', patron: /\.(cjs|js|sh)$/ },
  { dir: 'src', patron: /\.js$/ },
  { dir: 'bin', patron: /.*/ },
  /* Un test que invoca un script SI cuenta como hierro: el CI lo corre en
     cada push, que es exactamente la definicion de "alguien lo ejecuta". */
  { dir: 'test', patron: /\.cjs$/ },
];

function ficherosInvocadores(raiz) {
  const out = [];
  for (const { dir, patron } of INVOCADORES) {
    const abs = path.join(raiz, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of safe(() => fs.readdirSync(abs), []) || []) {
      const p = path.join(abs, f);
      if (!safe(() => fs.statSync(p).isFile(), false)) continue;
      if (!patron.test(f)) continue;
      out.push({ rel: path.join(dir, f).replace(/\\/g, '/'), abs: p });
    }
  }
  return out;
}

/** Secciones de CLAUDE.md: desde cada `## ` hasta el siguiente. */
function secciones(texto) {
  const lineas = texto.split(/\r?\n/);
  const out = [];
  let actual = null;
  for (const l of lineas) {
    if (/^##\s+\S/.test(l)) {
      if (actual) out.push(actual);
      actual = { titulo: l.replace(/^#+\s*/, '').trim(), cuerpo: [] };
    } else if (actual) {
      actual.cuerpo.push(l);
    }
  }
  if (actual) out.push(actual);
  return out.map((s) => ({ titulo: s.titulo, cuerpo: s.cuerpo.join('\n') }));
}

/**
 * Scripts que a proposito los invoca una persona o el modelo.
 * Declararlos es una decision consciente que queda escrita; lo que no este
 * aqui y nadie invoque pone el CI en rojo. Sin esta lista el control gritaria
 * por casos legitimos, y un control que grita por todo se desactiva.
 */
function papelAceptado(raiz) {
  const p = path.join(raiz, '.agentic', 'grafo', 'PAPEL-ACEPTADO.json');
  const j = safe(() => JSON.parse(fs.readFileSync(p, 'utf8')), null);
  return (j && j.aceptados) || {};
}

/**
 * Un fichero de test no lo "invoca" otro script: lo corre el corredor de tests
 * con un glob. Se considera hierro si package.json tiene un script `test` que
 * apunta al directorio donde vive. Si el proyecto no corre sus tests, entonces
 * si es papel — y eso es exactamente lo que hay que ver.
 */
function loCorreElCI(raiz, script) {
  if (!/\.(test|spec)\.[a-z]*js$/i.test(script)) return null;
  const enTest = ['test', 'tests', '__tests__', 'spec']
    .some((d) => fs.existsSync(path.join(raiz, d, script)));
  if (!enTest) return null;
  const pkg = safe(() => JSON.parse(fs.readFileSync(path.join(raiz, 'package.json'), 'utf8')), null);
  const cmd = (pkg && pkg.scripts && pkg.scripts.test) || '';
  return cmd ? 'lo corre npm test' : null;
}

function analizar(raiz) {
  const claudeMd = path.join(raiz, 'CLAUDE.md');
  if (!fs.existsSync(claudeMd)) return { error: 'sin CLAUDE.md' };

  const texto = fs.readFileSync(claudeMd, 'utf8');
  /* Solo la parte de Agentix: lo que el usuario escriba en su territorio es su
     asunto y no promete nada del framework. */
  const marcador = texto.match(/^#\s*INSTRUCCIONES DEL PROYECTO/m);
  const propio = marcador ? texto.slice(0, marcador.index) : texto;

  const aceptados = papelAceptado(raiz);
  const invocadores = ficherosInvocadores(raiz);
  const contenidos = invocadores.map((f) => ({
    rel: f.rel,
    txt: safe(() => fs.readFileSync(f.abs, 'utf8'), '') || '',
  }));

  const filas = [];
  for (const sec of secciones(propio)) {
    const scripts = [...new Set(
      [...sec.cuerpo.matchAll(/([a-z0-9][a-z0-9._-]*\.cjs)/gi)].map((m) => m[1])
    )];
    if (!scripts.length) {
      filas.push({ seccion: sec.titulo, tipo: 'PAPEL', scripts: [], roto: false });
      continue;
    }
    for (const sc of scripts) {
      const existe = ['.agentic/grafo', '.', 'test', 'scripts', 'src', 'bin']
        .some((d) => fs.existsSync(path.join(raiz, d, sc)));
      const quienLoLlama = contenidos
        .filter((f) => !f.rel.endsWith('/' + sc) && f.txt.includes(sc))
        .map((f) => f.rel);
      const porCI = loCorreElCI(raiz, sc);
      if (porCI) quienLoLlama.push('npm test');

      filas.push({
        seccion: sec.titulo,
        tipo: existe && quienLoLlama.length ? 'HIERRO' : 'PAPEL',
        script: sc,
        existe,
        invocadoPor: quienLoLlama,
        /* Roto = la sección promete un script que no existe, o que existe y
           nadie llama. Lo segundo es el caso ui-native-gate: la regla estaba
           escrita, el script estaba escrito, y no había nada que lo corriera. */
        aceptado: !!aceptados[sc],
        razonAceptado: aceptados[sc] || null,
        roto: !existe || (quienLoLlama.length === 0 && !aceptados[sc]),
      });
    }
  }

  const hierro = filas.filter((f) => f.tipo === 'HIERRO').length;
  const rotas = filas.filter((f) => f.roto && f.script);
  return { filas, hierro, total: filas.filter((f) => f.script).length, rotas };
}

function formatear(r) {
  if (r.error) return 'HIERRO/PAPEL — ' + r.error;
  const L = [];
  L.push(`HIERRO / PAPEL — ${r.hierro} de ${r.total} promesa(s) de script tienen quien las ejecute.`);
  L.push('');

  const conScript = r.filas.filter((f) => f.script);
  const porSeccion = new Map();
  for (const f of conScript) {
    if (!porSeccion.has(f.seccion)) porSeccion.set(f.seccion, []);
    porSeccion.get(f.seccion).push(f);
  }
  for (const [sec, fs_] of porSeccion) {
    L.push('  ' + sec);
    for (const f of fs_) {
      const marca = f.tipo === 'HIERRO' ? '[hierro]' : (f.aceptado ? '[papel ok]' : '[PAPEL]');
      const nota = !f.existe ? 'NO EXISTE'
        : !f.invocadoPor.length ? (f.aceptado ? 'papel declarado: ' + String(f.razonAceptado).slice(0, 58) : 'existe pero NADIE lo invoca')
        : 'lo corre ' + f.invocadoPor.slice(0, 2).map((x) => path.basename(x)).join(', ');
      L.push(`     ${marca} ${f.script.padEnd(26)} ${nota}`);
    }
  }

  if (r.rotas.length) {
    L.push('');
    L.push(`  ⚠️  ${r.rotas.length} promesa(s) de papel disfrazadas de hierro:`);
    for (const f of r.rotas) L.push(`     · "${f.seccion}" nombra ${f.script} y nada lo ejecuta`);
  }
  return L.join('\n');
}

if (require.main === module) {
  const raiz = process.cwd();
  const r = analizar(raiz);
  console.log(formatear(r));
  process.exit(process.argv.includes('--check') && r.rotas && r.rotas.length ? 1 : 0);
}

module.exports = { analizar, secciones, formatear };
