'use strict';

/**
 * Canario Gate — un arreglo no se cierra sin un test que lo detecte.
 *
 * POR QUÉ EXISTE
 * -------------
 * "Que los errores no se repitan" no se consigue con memoria ni con buena
 * intención: se consigue con un test que se ponga rojo si el error vuelve.
 * Un error arreglado sin canario no está cerrado, está pospuesto — y cuando
 * vuelve, vuelve en silencio, que es la única forma en que vuelve.
 *
 * Eso ya estaba escrito como disciplina en el protocolo. La disciplina que
 * depende de que alguien se acuerde no ocurre: en la memoria de D:\360 hay 29
 * errores registrados y 3 protected_behaviors. Veintinueve arreglos, tres
 * canarios.
 *
 * QUÉ HACE
 * --------
 * Mira los archivos del cambio. Si toca código de producción y no toca ningún
 * test, lo dice. Y distingue el caso que de verdad importa:
 *
 *   · una FUNCIONALIDAD nueva sin test        → aviso (se escribe deuda a diario)
 *   · un ARREGLO sin test                     → freno (es la regresión de mañana)
 *
 * El arreglo se detecta del mensaje del commit (`fix`, `arregla`, `corrige`,
 * `hotfix`, `bug`) o del tipo de tarea que declara el pipeline. No se adivina
 * por el contenido del diff: adivinar produce falsos frenos, y un freno falso
 * es lo que hace que alguien desactive el control.
 *
 * LO QUE NO HACE
 * --------------
 * No juzga si el test es bueno. Un test vacío lo pasaría. Eso es a propósito:
 * la calidad del canario la pone quien lo escribe; esto solo garantiza que
 * exista uno. Un control mecánico que intenta juzgar calidad se equivoca y se
 * desactiva; uno que cuenta archivos no se equivoca nunca.
 *
 *   node .agentic/grafo/canario-gate.cjs --staged
 *   node .agentic/grafo/canario-gate.cjs --commit
 *   node .agentic/grafo/canario-gate.cjs --files=a.ts,b.ts --tipo=fix
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const safe = (fn, fb = null) => { try { return fn(); } catch { return fb; } };

/* Un test es cualquier cosa que un corredor de tests reconocería como tal. */
const ES_TEST = /(^|[\\/])(test|tests|spec|__tests__|e2e)[\\/]|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(py|go|rb)$|test_[^\\/]+\.py$/i;

/* Código que corre en producción. Se excluye a propósito lo que no puede
   romper nada en caliente: documentación, configuración de herramientas,
   migraciones (su prueba es correrlas) y el propio andamiaje de Agentix. */
const ES_PRODUCCION = /\.(js|jsx|ts|tsx|mjs|cjs|py|rb|php|go|java|cs|sql|css|scss|html?|vue|svelte)$/i;
const NO_CUENTA = [
  /(^|[\\/])(docs?|documentation|\.github|\.vscode|\.idea)[\\/]/i,
  /(^|[\\/])(node_modules|dist|build|out|coverage|\.next)[\\/]/i,
  /(^|[\\/])migrations?[\\/]/i,
  /\.(md|json|ya?ml|lock|txt|svg|png|jpe?g|gif|ico|woff2?)$/i,
  /(^|[\\/])\.agentic[\\/]/i,
];

const PISTAS_ARREGLO = /\b(fix|fixes|fixed|bug|bugfix|hotfix|arregl\w*|corri\w*|repar\w*|soluciona\w*|regres\w*)\b/i;

function clasificar(files) {
  const tests = [];
  const produccion = [];
  for (const f of files) {
    const r = String(f).trim();
    if (!r) continue;
    if (ES_TEST.test(r)) { tests.push(r); continue; }
    if (!ES_PRODUCCION.test(r)) continue;
    if (NO_CUENTA.some((re) => re.test(r))) continue;
    produccion.push(r);
  }
  return { tests, produccion };
}

function archivos(root, { staged, commit, files }) {
  if (files && files.length) return files;
  const cmd = staged
    ? 'git diff --cached --name-only --diff-filter=ACM'
    : 'git diff-tree --no-commit-id --name-only -r HEAD';
  if (!staged && !commit) return [];
  const out = safe(() => execSync(cmd, { cwd: root, stdio: 'pipe', timeout: 15000 }).toString(), '');
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

function mensajeDelCambio(root, { staged }) {
  if (staged) {
    /* El mensaje aún no existe cuando corre el pre-commit; se usa el que
       git deja preparado si lo hay (merge, squash, -m con plantilla). */
    for (const f of ['.git/COMMIT_EDITMSG', '.git/MERGE_MSG', '.git/SQUASH_MSG']) {
      const p = path.join(root, f);
      if (fs.existsSync(p)) return safe(() => fs.readFileSync(p, 'utf8'), '') || '';
    }
    return '';
  }
  return safe(() => execSync('git log -1 --format=%s%n%b', {
    cwd: root, stdio: 'pipe', timeout: 10000,
  }).toString(), '') || '';
}

/**
 * @returns {veredicto:'PASS'|'WARN'|'STOP', esArreglo, produccion, tests, motivo}
 */
function revisar(root, { staged = false, commit = false, files = null, tipo = null } = {}) {
  const lista = archivos(root, { staged, commit, files });
  const { tests, produccion } = clasificar(lista);

  if (!produccion.length) {
    return { veredicto: 'PASS', esArreglo: false, produccion, tests, motivo: 'el cambio no toca código de producción' };
  }
  if (tests.length) {
    return { veredicto: 'PASS', esArreglo: false, produccion, tests, motivo: `${tests.length} archivo(s) de test en el cambio` };
  }

  /* El tipo que declara el pipeline manda sobre la adivinanza del mensaje.
     Si no se declara ninguno, se cae al mensaje del cambio — pero mezclar los
     dos hacía que un repo cuyo commit anterior decía "fix" frenara TODA
     funcionalidad nueva. Un freno falso es lo que lleva a desactivar el
     control, y con él se pierde el freno que sí importa. */
  const esArreglo = tipo
    ? PISTAS_ARREGLO.test(String(tipo))
    : PISTAS_ARREGLO.test(mensajeDelCambio(root, { staged }));

  return {
    veredicto: esArreglo ? 'STOP' : 'WARN',
    esArreglo,
    produccion,
    tests,
    motivo: esArreglo
      ? 'es un arreglo y no trae ningún test que detecte el error si vuelve'
      : 'toca producción sin tocar ningún test',
  };
}

function formatear(r) {
  if (r.veredicto === 'PASS') return `✅ CANARIO — ${r.motivo}.`;

  const L = [];
  const muestra = r.produccion.slice(0, 6).map((f) => '       · ' + f);
  if (r.veredicto === 'STOP') {
    L.push('🛑 CANARIO — un arreglo sin test es la regresión de mañana.');
    L.push('');
    L.push('     Este cambio arregla algo y no añade ni modifica ningún test.');
    L.push('     Cuando el error vuelva, volverá en silencio.');
    L.push('');
    L.push('     Archivos de producción tocados:');
    L.push(...muestra);
    if (r.produccion.length > 6) L.push(`       … y ${r.produccion.length - 6} más`);
    L.push('');
    L.push('     Añade un test que se ponga ROJO con el error que acabas de arreglar.');
    L.push('     Si de verdad no aplica:  AKDD_SKIP_GATES=1 git commit ...');
  } else {
    L.push(`⚠️  CANARIO — ${r.produccion.length} archivo(s) de producción sin ningún test en el cambio.`);
    L.push(...muestra);
    if (r.produccion.length > 6) L.push(`       … y ${r.produccion.length - 6} más`);
  }
  return L.join('\n');
}

if (require.main === module) {
  const root = safe(() => execSync('git rev-parse --show-toplevel', {
    stdio: 'pipe', timeout: 10000,
  }).toString().trim(), process.cwd()) || process.cwd();

  const args = process.argv.slice(2);
  const opt = {};
  for (const a of args) {
    if (a === '--staged') opt.staged = true;
    else if (a === '--commit') opt.commit = true;
    else if (a.startsWith('--files=')) opt.files = a.slice(8).split(',').filter(Boolean);
    else if (a.startsWith('--tipo=')) opt.tipo = a.slice(7);
  }
  if (!opt.staged && !opt.commit && !opt.files) opt.staged = true;

  const r = revisar(root, opt);
  console.log(formatear(r));
  process.exit(r.veredicto === 'STOP' ? 1 : 0);
}

module.exports = { revisar, clasificar, formatear, ES_TEST, PISTAS_ARREGLO };
