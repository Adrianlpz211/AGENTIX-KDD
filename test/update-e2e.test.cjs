/**
 * `akdd update` de punta a punta, sobre un proyecto con datos que se pueden perder.
 *
 * POR QUÉ ESTE TEST EXISTE
 * ------------------------
 * `akdd update` es el comando que reparte el framework a todos los proyectos, y
 * el único de todo Agentix que, si se equivoca, DESTRUYE trabajo ajeno: pisa
 * CLAUDE.md, .agentic/agentes, .agentic/grafo, dashboard.cjs y .cursorrules.
 * Hasta hoy nunca se había ejecutado completo — solo se probó la función de
 * migración en aislamiento, que es como probar el cinturón sin el coche.
 *
 * CÓMO SE PRUEBA SIN PUBLICAR NADA
 * --------------------------------
 * El comando descarga main de GitHub, así que probar los cambios locales sería
 * un huevo y la gallina. Aquí se empaqueta el repo LOCAL en un tarball con la
 * misma forma que el de GitHub (un directorio raíz, que `--strip-components=1`
 * quita) y se intercepta ÚNICAMENTE la descarga. Todo lo demás —extracción,
 * copias, migración, orden de pasos— es el código real.
 *
 * LO QUE VIGILA
 * -------------
 * Las dos mitades que importan y que se contradicen entre sí:
 *   · lo del usuario SOBREVIVE  (memoria, reglas propias, base de datos)
 *   · lo del framework SE ACTUALIZA  (scripts nuevos, dashboard nuevo)
 * Un update que preserva todo no actualiza nada, y uno que actualiza todo borra
 * el proyecto. Las dos se comprueban en la misma corrida.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, execSync } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');

/* Texto del usuario, con encabezados markdown propios: exactamente lo que una
   versión anterior de la migración se comió al cortar por "líneas que empiezan
   con #". */
const REGLAS_DEL_USUARIO = [
  '## MI REGLA CRITICA',
  '',
  'Nunca tocar la tabla de facturas sin avisar a contabilidad.',
  '',
  '### Detalle',
  '',
  '- El cierre mensual corre el dia 3',
  '- Los precios van en bolivares, no en dolares',
].join('\n');

/** Un proyecto de mentira pero con la forma de uno real. */
function proyectoConDatos() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-e2e-'));

  fs.mkdirSync(path.join(root, '.agentic', 'memoria'), { recursive: true });
  fs.mkdirSync(path.join(root, '.agentic', 'grafo'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });

  /* Sin config.md el comando se niega a correr, y con razón. */
  fs.writeFileSync(path.join(root, '.agentic', 'config.md'),
    '# Config\n\nCONFIGURADO: SI\nProyecto: clinica-de-prueba\n');

  /* Memoria del usuario: meses de trabajo que no se pueden perder. */
  fs.writeFileSync(path.join(root, '.agentic', 'memoria', 'patrones.md'),
    '# Patrones\n\n- Los combos se cierran al scrollear (confianza ALTA)\n');
  fs.writeFileSync(path.join(root, '.agentic', 'memoria', 'trabajo.md'),
    '# Trabajo\n\nTarea activa: cierre de compras\n');
  fs.writeFileSync(path.join(root, '.agentic', 'memoria.db'),
    'no es una base de verdad, pero si un archivo que no se debe tocar');

  /* CLAUDE.md tal como queda en un proyecto: la plantilla del framework y,
     detrás del marcador, lo que escribió el usuario. */
  const plantilla = fs.readFileSync(path.join(RAIZ, 'CLAUDE.md'), 'utf8');
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), plantilla + '\n' + REGLAS_DEL_USUARIO + '\n');

  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'console.log("codigo del usuario");\n');
  return root;
}

/** El repo local, empaquetado con la misma forma que el tarball de GitHub. */
function tarballDelRepoLocal() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-pack-'));
  const tar = path.join(dir, 'fuente.tar.gz');
  /* Un directorio raíz, porque el extractor usa --strip-components=1. */
  const padre = path.dirname(RAIZ).replace(/\\/g, '/');
  const nombre = path.basename(RAIZ);
  execSync(
    `tar --force-local -czf "${tar.replace(/\\/g, '/')}" -C "${padre}" ` +
    `--exclude=node_modules --exclude=.git "${nombre}"`,
    { stdio: 'pipe', timeout: 180000 }
  );
  return tar;
}

/** Preload que sustituye la descarga por una copia del tarball local. */
function preloadSinRed(dir, tarLocal) {
  const f = path.join(dir, 'sin-red.cjs');
  fs.writeFileSync(f, `
const cp = require('child_process');
const fs = require('fs');
const real = cp.execSync;
cp.execSync = function (cmd, opts) {
  /* Solo se intercepta la descarga; el resto (tar, git…) corre de verdad. */
  if (typeof cmd === 'string' && cmd.startsWith('curl')) {
    const m = cmd.match(/-o "([^"]+)"/);
    if (m) { fs.copyFileSync(${JSON.stringify(tarLocal.replace(/\\/g, '/'))}, m[1]); return Buffer.from(''); }
  }
  return real.call(this, cmd, opts);
};
`);
  return f;
}

test('akdd update actualiza el framework sin destruir el proyecto', { timeout: 300000 }, () => {
  const root = proyectoConDatos();
  const tar = tarballDelRepoLocal();
  const preload = preloadSinRed(path.dirname(tar), tar);

  const antes = {
    db: md5(path.join(root, '.agentic', 'memoria.db')),
    patrones: md5(path.join(root, '.agentic', 'memoria', 'patrones.md')),
    codigo: md5(path.join(root, 'src', 'app.js')),
  };

  /* En un hijo, para que un process.exit(1) del comando no mate al runner y se
     pueda leer el código de salida como lo leería una persona. */
  let salida = '';
  try {
    salida = execFileSync(process.execPath, [
      '--require', preload,
      '-e', `require(${JSON.stringify(path.join(RAIZ, 'src', 'update.js').replace(/\\/g, '/'))}).update()`,
    ], { cwd: root, stdio: 'pipe', timeout: 240000, encoding: 'utf8' });
  } catch (err) {
    assert.fail('akdd update falló con código ' + err.status + '\n' +
      String(err.stdout || '') + String(err.stderr || ''));
  }

  /* ── mitad 1: lo del usuario sobrevive ─────────────────────────────────── */

  assert.equal(md5(path.join(root, '.agentic', 'memoria.db')), antes.db,
    'memoria.db NO se puede tocar: es el trabajo acumulado del proyecto');
  assert.equal(md5(path.join(root, '.agentic', 'memoria', 'patrones.md')), antes.patrones,
    'la memoria del usuario no se actualiza, se respeta');
  assert.equal(md5(path.join(root, 'src', 'app.js')), antes.codigo,
    'el código del proyecto no se toca jamás');

  const claude = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
  assert.match(claude, /MI REGLA CRITICA/,
    'las reglas propias deben seguir en CLAUDE.md después de actualizar');
  assert.match(claude, /Los precios van en bolivares/,
    'y completas, no solo el primer encabezado');
  assert.match(claude, /### Detalle/,
    'los encabezados del usuario no se pueden comer al cortar el bloque');

  const propias = path.join(root, '.agentic', 'INSTRUCCIONES-PROYECTO.md');
  assert.ok(fs.existsSync(propias),
    'las reglas del usuario deben quedar en su propio archivo, fuera de la zona que se sobrescribe');
  assert.match(fs.readFileSync(propias, 'utf8'), /MI REGLA CRITICA/);

  /* ── mitad 2: el framework SÍ se actualiza ─────────────────────────────── */

  for (const nuevo of ['error-cure.cjs', 'canario-gate.cjs', 'reloj-derivado.cjs', 'hierro-papel.cjs']) {
    assert.ok(fs.existsSync(path.join(root, '.agentic', 'grafo', nuevo)),
      `${nuevo} debe llegar al proyecto: un update que no actualiza no sirve de nada`);
  }

  const dash = fs.readFileSync(path.join(root, 'dashboard.cjs'), 'utf8');
  assert.match(dash, /setMode\('tiempos'/,
    'el dashboard nuevo, con la pestaña de Línea de Tiempo, debe llegar');

  const hook = path.join(root, '.agentic', 'grafo', 'git-hooks', 'pre-commit');
  if (fs.existsSync(hook)) {
    assert.match(fs.readFileSync(hook, 'utf8'), /canario-gate/,
      'el hook actualizado debe traer el canario');
  }

  assert.ok(!/error|Error|fail/i.test(salida.split('\n').filter((l) => !/errores|Errors/.test(l)).join('\n')) ||
    /completo|complete|✓/i.test(salida),
    'la salida no debe reportar fallos');
});

test('akdd update se niega a correr donde Agentix no está instalado', () => {
  const vacio = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-vacio-'));
  let status = 0;
  try {
    execFileSync(process.execPath, [
      '-e', `require(${JSON.stringify(path.join(RAIZ, 'src', 'update.js').replace(/\\/g, '/'))}).update()`,
    ], { cwd: vacio, stdio: 'pipe', timeout: 60000 });
  } catch (err) { status = err.status; }
  assert.equal(status, 1,
    'sin .agentic/config.md debe salir con error, no crear medio proyecto');
});
