/**
 * Hueco B — `akdd update` no puede destruir las instrucciones del usuario.
 *
 * Hasta v3.18 `update` copiaba CLAUDE.md con overwrite:true y cero
 * preservación, mientras el propio archivo invitaba al usuario a pegar sus
 * instrucciones al final. Ya mordió: el encabezado «INSTRUCCIONES DEL
 * PROYECTO» acabó duplicado en la plantilla del repo.
 *
 * El cierre no es preservar mejor: es que Agentix NO escriba ese territorio.
 * Lo del usuario vive en .agentic/INSTRUCCIONES-PROYECTO.md, que update solo
 * LEE y vuelve a pegar. Este test vigila que siga siendo así.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

/* Se prueba la función real de src/update.js, extraída sin ejecutar el update
   entero (que descarga de GitHub). fs-extra se sustituye por fs nativo más
   los dos métodos que la función usa. */
function cargarMigrar() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'update.js'), 'utf8');
  const i = src.indexOf('function migrarInstruccionesUsuario');
  assert.ok(i > -1, 'src/update.js debe seguir teniendo migrarInstruccionesUsuario');
  const fn = src.slice(i);
  const fsx = Object.assign({}, fs, {
    ensureDirSync: (d) => fs.mkdirSync(d, { recursive: true })
  });
  return new Function('fs', 'path', 'return ' + fn.slice(0, fn.lastIndexOf('}') + 1))(fsx, path);
}

const TEXTO_DEL_USUARIO = [
  '## MI REGLA CRITICA',
  'No tocar dbo.pedido ni dbo.pedlinea, son de farmacia.',
  '',
  '## OTRA COSA MIA',
  'Los tiempos se miden con --actor.'
].join('\n');

test('update no destruye las instrucciones del usuario (Hueco B)', () => {
  const migrar = cargarMigrar();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-huecob-'));

  try {
    fs.mkdirSync(path.join(tmp, '.agentic'), { recursive: true });
    const claudePath = path.join(tmp, 'CLAUDE.md');
    const userPath = path.join(tmp, '.agentic', 'INSTRUCCIONES-PROYECTO.md');

    /* CLAUDE.md «viejo»: plantilla + marcador + texto del usuario debajo */
    fs.writeFileSync(claudePath, [
      '# AGENTIC KDD',
      '## PRIORIDAD ABSOLUTA',
      'aa: y audit: anulan todo.',
      '',
      '# ============================================================',
      '# INSTRUCCIONES DEL PROYECTO — agregar las tuyas aquí abajo',
      '# ============================================================',
      '',
      TEXTO_DEL_USUARIO,
      ''
    ].join('\n'), 'utf8');

    /* 1 · el primer update migra */
    assert.equal(migrar(tmp, userPath), true,
      'el primer update debe detectar el texto del usuario y migrarlo');
    assert.ok(fs.existsSync(userPath),
      'debe crear .agentic/INSTRUCCIONES-PROYECTO.md');

    const guardado = fs.readFileSync(userPath, 'utf8');
    assert.match(guardado, /MI REGLA CRITICA/,
      'el archivo del usuario debe conservar su primera sección');
    assert.match(guardado, /OTRA COSA MIA/,
      'y también la segunda — una limpieza por «#» se comía los títulos markdown');

    /* 2 · update pisa CLAUDE.md con la plantilla nueva y vuelve a pegar lo suyo */
    fs.writeFileSync(claudePath, [
      '# AGENTIC KDD v4',
      '## PRIORIDAD ABSOLUTA',
      'aa: y audit: anulan todo.',
      '## SECCION NUEVA DE LA VERSION',
      'algo nuevo.',
      '',
      '# ============================================================',
      '# INSTRUCCIONES DEL PROYECTO',
      '# ============================================================',
      '# Lo tuyo va en .agentic/INSTRUCCIONES-PROYECTO.md',
      '# ============================================================',
      ''
    ].join('\n'), 'utf8');
    fs.appendFileSync(claudePath, '\n' + fs.readFileSync(userPath, 'utf8').trim() + '\n');

    const final = fs.readFileSync(claudePath, 'utf8');
    assert.match(final, /MI REGLA CRITICA/,
      'tras el update la regla del usuario debe seguir en CLAUDE.md');
    assert.match(final, /SECCION NUEVA DE LA VERSION/,
      'y lo nuevo de la versión también debe haber llegado');
    assert.equal((final.match(/# INSTRUCCIONES DEL PROYECTO/g) || []).length, 1,
      'el encabezado no puede duplicarse — es la prueba de que el bug volvió');

    /* 3 · un segundo update no vuelve a migrar */
    assert.equal(migrar(tmp, userPath), false,
      'con el archivo del usuario ya creado, update no debe volver a migrar');

  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('update nunca escribe el archivo del usuario', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'update.js'), 'utf8');
  /* La única escritura permitida sobre INSTRUCCIONES-PROYECTO.md es la de la
     migración, dentro de migrarInstruccionesUsuario. Cualquier otra reabre el hueco. */
  const i = src.indexOf('function migrarInstruccionesUsuario');
  const fuera = src.slice(0, i);
  assert.ok(!/writeFileSync\([^)]*userInstrPath/.test(fuera),
    'fuera de la migración no puede haber ninguna escritura a INSTRUCCIONES-PROYECTO.md');
  assert.ok(!/copySync\([^)]*INSTRUCCIONES-PROYECTO/.test(src),
    'ni copias sobre ese archivo');
});
