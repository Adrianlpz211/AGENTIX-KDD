/**
 * El Creative Engine tenía once tipos de sugerencia y estaba ciego.
 *
 * LO QUE SE MIDIÓ (03/09/2026, sobre D:\360 con 155 ciclos cerrados)
 * ------------------------------------------------------------------
 *   · 4 de 11 tipos NO tenían ni una línea que los generara: etiquetas.
 *   · 4 tipos con detector nunca disparaban, y el motivo NO era su lógica:
 *     los campos que leen nadie los llenaba —`failure_count` a 0 en los 102
 *     contratos, `regressed_by` sin una sola fila.
 *   · El único que actuaba (ERROR_LIKELY_FIXED) decidía con evidencia de ruido:
 *     dos palabras compartidas, y en el caso real fueron ["compras", "como"] —
 *     el nombre del módulo y una palabra vacía sin filtrar.
 *   · Y se saltaba su propio veto: el tipo declara `auto_apply_at: null`
 *     ("nunca auto-aplica"), y la auto-confirmación lo aplicaba a los 3 días
 *     llamándose `{ manual: true }`.
 *
 * LA CAUSA RAÍZ estaba más abajo: `runPreservationGate` es la ÚNICA función que
 * incrementa `failure_count`, está bien escrita, y el post-cycle nunca la
 * llamaba. Un gate que existe, funciona y nadie invoca protege cero — el mismo
 * fallo que la memoria de diseño de la v1, dos capas más abajo.
 *
 * Estos tests vigilan las cuatro cosas que se arreglaron.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { abrir, motivoSinDriver } = require('./helpers/sqlite.cjs');
const RAIZ = path.join(__dirname, '..');

const CG = fs.readFileSync(path.join(RAIZ, '.agentic', 'grafo', 'creative-engine.cjs'), 'utf8');
const PC = fs.readFileSync(path.join(RAIZ, '.agentic', 'grafo', 'post-cycle.cjs'), 'utf8');

/**
 * El mismo texto sin comentarios.
 *
 * Hace falta porque estos módulos explican en prosa el fallo que arreglaron —
 * "antes esto llamaba a `applySuggestion`" — y un test que busque esa cadena
 * salta por el comentario que documenta el arreglo. Ya pasó: dos de estos tests
 * fallaron contra código correcto por mirar sus propias explicaciones.
 */
/* Un salto de linea sin escapes: este archivo ha pasado por varias capas de
   comillas y un backslash-n se convierte en salto real por el camino, lo que
   parte la expresion regular sin decir donde. */
const NL = String.fromCharCode(10);

const soloCodigo = (t) => String(t)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split(NL)
  .filter((l) => !/^\s*(\/\/|\*)/.test(l))
  .join(NL);

const CG_COD = soloCodigo(CG);
const PC_COD = soloCodigo(PC);

/* ── 1 · el Preservation Gate tiene que CORRER ─────────────────────────────── */

test('post-cycle invoca el Preservation Gate', () => {
  /* Es la pieza que llena failure_count y contract_violations. Sin esta
     llamada, FRAGILITY y REFACTOR quedan ciegos para siempre. */
  /* Se exige la LLAMADA, no la mencion. La primera version de este test solo
     buscaba la palabra en el archivo, y al sabotear la llamada seguia pasando
     porque el nombre aparecia en la comprobacion de `typeof`. Un canario que
     no se pone rojo al desconectar la pieza no vigila nada. */
  assert.match(PC_COD, /cg\.runPreservationGate\s*\(/,
    'post-cycle debe LLAMAR al Preservation Gate, no solo mencionarlo: es lo unico que registra las roturas');
  assert.match(PC, /2\.11 Preservation Gate/,
    'debe ser un paso visible del post-cycle, no una llamada escondida');
});

test('el gate no se llama con un initDB que no existe', () => {
  /* El fallo que casi se cuela: contract-guard NO exporta initDB. Llamar a
     `cg.initDB(...)` daba undefined y el gate caía por el camino silencioso de
     "sin base" — con un mensaje idéntico al de un proyecto sin memoria, o sea
     invisible. */
  assert.ok(!/cg\.initDB/.test(PC_COD),
    'contract-guard no exporta initDB: la base se abre con el helper de post-cycle');
  const i = PC_COD.indexOf('runPreservationGate');
  const antes = PC_COD.slice(Math.max(0, i - 900), i);
  assert.match(antes, /openDB\(\)/,
    'el paso debe abrir la base con openDB() antes de llamar al gate');
});

test('las roturas alimentan las aristas de regresión', () => {
  assert.match(PC, /registrarRegresiones/,
    'sin la arista regressed_by, el detector REFACTOR nunca puede disparar');
  const iG = PC.indexOf('runPreservationGate');
  const iR = PC.indexOf('registrarRegresiones', iG);
  assert.ok(iR > iG, 'las aristas se crean DESPUÉS de saber qué se rompió');
});

/* ── 2 · las aristas de regresión, de verdad ───────────────────────────────── */

function baseDePrueba() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-regr-'));
  fs.mkdirSync(path.join(root, '.agentic'));
  return abrir(path.join(root, '.agentic', 'memoria.db'));
}

const { registrarRegresiones } = require('../.agentic/grafo/post-cycle.cjs');

const violacion = (nombre) => ({
  contract_id: 'c-' + nombre, contract_name: nombre,
  module: 'compras', severity: 'CRITICAL', message: 'contrato roto: ' + nombre,
});

test('una rotura deja su arista archivo → contrato', (t) => {
  const db = baseDePrueba();
  if (!db) return t.skip(motivoSinDriver());

  const n = registrarRegresiones(db, [violacion('combo abre')], ['src/combo.ts', 'README.md']);
  assert.equal(n, 1, 'una violación y un archivo de código = una arista');

  const fila = db.prepare(
    "SELECT desde_entidad, hacia_entidad, tipo FROM relaciones_semanticas WHERE tipo='regressed_by'"
  ).get();
  assert.equal(fila.desde_entidad, 'src/combo.ts', 'desde = el archivo que cambió');
  assert.equal(fila.hacia_entidad, 'contrato:combo abre', 'hacia = lo que se rompió');
});

test('la documentación no rompe tests: no genera aristas', (t) => {
  const db = baseDePrueba();
  if (!db) return t.skip(motivoSinDriver());
  /* Meter los .md enturbiaría la señal justo cuando más falta hace que sea
     limpia: "¿qué rompe este archivo cuando lo toco?". */
  const n = registrarRegresiones(db, [violacion('x')], ['README.md', 'docs/guia.md']);
  assert.equal(n, 0);
});

test('la misma rotura dos veces en el mismo ciclo cuenta una vez', (t) => {
  const db = baseDePrueba();
  if (!db) return t.skip(motivoSinDriver());
  registrarRegresiones(db, [violacion('y')], ['src/a.ts']);
  const segunda = registrarRegresiones(db, [violacion('y')], ['src/a.ts']);
  assert.equal(segunda, 0, 'el mismo hecho registrado dos veces inflaría el contador');
});

test('sin violaciones no escribe nada', (t) => {
  const db = baseDePrueba();
  if (!db) return t.skip(motivoSinDriver());
  assert.equal(registrarRegresiones(db, [], ['src/a.ts']), 0);
  assert.equal(registrarRegresiones(db, null, ['src/a.ts']), 0);
});

/* ── 3 · evidencia real, no palabras compartidas ───────────────────────────── */

test('ERROR_LIKELY_FIXED ya no decide por palabras compartidas', () => {
  /* El caso real: shared_tokens ["compras", "como"]. El nombre del módulo —que
     comparten TODAS las tareas del área— y una palabra vacía sin filtrar. */
  const i = CG.indexOf("type: 'ERROR_LIKELY_FIXED'");
  assert.ok(i > 0, 'el detector debe seguir existiendo');
  const bloque = CG_COD.slice(Math.max(0, CG_COD.indexOf("type: 'ERROR_LIKELY_FIXED'") - 4000), CG_COD.indexOf("type: 'ERROR_LIKELY_FIXED'") + 1200);
  assert.ok(!/shared_tokens/.test(bloque),
    'compartir palabras no es evidencia: es el mismo ruido de los 397 enlaces resuelto_por');
});

test('exige un hecho: archivo tocado o contrato en verde', () => {
  const i = CG.indexOf("type: 'ERROR_LIKELY_FIXED'");
  const bloque = CG.slice(Math.max(0, i - 4000), i + 1200);
  assert.match(bloque, /archivos_aplica/,
    'debe cruzar los archivos que el error declara suyos con los que tocó el ciclo');
  assert.match(bloque, /consecutive_passes/,
    'o comprobar que el contrato que cubre el área lleva rachas en verde');
  assert.match(bloque, /archivos_compartidos|contrato_verde/,
    'la evidencia guardada debe ser el hecho, no la coincidencia');
});

test('la auto-confirmación CADUCA, no ejecuta', () => {
  /* Aplicar cambia el estado de un error en memoria: de las cosas menos
     reversibles que hay. El tipo declara "nunca auto-aplica" y la función se
     hacía pasar por manual para saltárselo. */
  const i = CG_COD.indexOf('function autoConfirmStaleErrorFixes');
  assert.ok(i > 0);
  const fn = CG_COD.slice(i, CG_COD.indexOf('\n}', i));
  assert.ok(!/applySuggestion/.test(fn),
    'la auto-confirmación no puede aplicar: una sugerencia sin confirmar caduca, no se ejecuta');
  assert.match(fn, /dismissed = 1/, 'debe descartarla');
});

test('ningún tipo se hace pasar por manual para saltarse su veto', () => {
  /* Se permite `{ manual: true }` en el camino del CLI `apply <id>`, que ES
     manual. Lo que no puede volver es una función automática usándolo. */
  for (const m of CG_COD.matchAll(/\{\s*manual:\s*true\s*\}/g)) {
    const antes = CG_COD.slice(Math.max(0, m.index - 700), m.index);
    assert.ok(!/function autoConfirm|auto-confirm-stale/.test(antes),
      'una función automática no puede declararse manual para esquivar auto_apply_at: null');
  }
});

/* ── 4 · ningún tipo sin detector ──────────────────────────────────────────── */

test('todo tipo declarado tiene quien lo produzca', () => {
  /* Cuatro eran etiquetas sin código: SIMPLIFICATION, PATTERN, DEAD_CODE y
     ARCHITECTURE. Un menú con platos que no existen enseña a desconfiar de la
     carta entera. */
  const tabla = CG.slice(CG.indexOf('const SUGGESTION_TYPES'), CG.indexOf('};', CG.indexOf('const SUGGESTION_TYPES')));
  const tipos = [...tabla.matchAll(/^\s{2}([A-Z_]+):/gm)].map((m) => m[1]);
  assert.ok(tipos.length >= 5, 'debe quedar la tabla de tipos');

  /* OPPORTUNITY la produce grafo.cjs (tareas que el motor autónomo aplazó),
     así que se busca en los dos archivos. */
  const grafo = fs.readFileSync(path.join(RAIZ, '.agentic', 'grafo', 'grafo.cjs'), 'utf8');
  const huerfanos = tipos.filter((t) =>
    !new RegExp("type:\\s*'" + t + "'").test(CG) &&
    !new RegExp("type:\\s*'" + t + "'").test(grafo));

  assert.deepEqual(huerfanos, [],
    'estos tipos no los genera nadie: ' + huerfanos.join(', '));
});

test('DEAD_CODE no vuelve sin datos que lo sostengan', () => {
  /* Se intentó y se descartó con medida: 207 candidatos sobre 5.000 símbolos, y
     la muestra eran `main`, `loadEnvFile`, `stubModuleRoot` — todas SÍ se
     llaman, en su propio archivo, y las aristas AST no registran las llamadas
     internas. Un detector con 200 falsos positivos no se corrige: se apaga, y
     con él se pierde la confianza en los demás. */
  assert.ok(!/DEAD_CODE:\s*\{/.test(CG),
    'DEAD_CODE solo puede volver cuando el índice AST registre las llamadas internas');
});

/* ── 5 · el gate no puede tumbar el commit de nadie ────────────────────────── */

test('el post-cycle NO cae a la suite completa', () => {
  /* El Preservation Gate corre tests. Si los contratos en riesgo no tienen
     archivo mapeado, cae a la suite entera — y el post-cycle corre desde un
     hook de git EN CADA COMMIT. En un proyecto ajeno con una suite de cinco
     minutos, lo primero que haria cualquiera es desactivar el hook, perdiendo
     con el todos los demas gates. Invocado a mano el respaldo si tiene sentido;
     desde el hook, no. */
  assert.match(PC_COD, /sinSuiteCompleta:\s*true/,
    'post-cycle debe pedir el tope: un gate que hace lento cada commit se desactiva');

  const cgSrc = soloCodigo(fs.readFileSync(
    path.join(RAIZ, '.agentic', 'grafo', 'contract-guard.cjs'), 'utf8'));
  assert.match(cgSrc, /opts\.sinSuiteCompleta/,
    'contract-guard debe respetar el tope');
});
