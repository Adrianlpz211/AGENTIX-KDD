/**
 * Los dos huecos de seguridad que el gate no miraba: A03 y A06 de OWASP.
 *
 * Medido el 05/09/2026 sobre Agentix: el security-gate revisaba secretos, fugas
 * entre inquilinos y bypass de JWT, y sobre **inyección SQL tenía CERO
 * comprobaciones** — en un ecosistema de proyectos escritos con SQL crudo. Y de
 * dependencias vulnerables, nada: lo único que había era `npm audit signatures`
 * en el workflow de publicación, que verifica firmas del registro y **no busca
 * vulnerabilidades**.
 *
 * LA REGLA QUE ESTOS TESTS PROTEGEN
 * ---------------------------------
 * **Determinista puede frenar; heurístico solo avisa.**
 *
 * `npm audit` es determinista: cada hallazgo tiene su CVE. El detector de SQL es
 * heurístico, y su primera versión lo demostró: dio **48 falsos positivos en 40
 * archivos** del código real, todos por `WHERE ${where}` donde `where` es un
 * fragmento que el propio código arma con parámetros. Código correcto, marcado
 * como agujero.
 *
 * Cuarenta y ocho avisos falsos es el gate que alguien desactiva el primer día,
 * y con él se pierden los deterministas que sí funcionaban. Por eso el test más
 * importante de este archivo es el que comprueba que el código BIEN escrito no
 * dispara nada.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const sql = require('../.agentic/grafo/sql-injection-scan.cjs');
const deps = require('../.agentic/grafo/deps-audit.cjs');
const RAIZ = path.join(__dirname, '..');

/* ── 1 · lo que SÍ es un agujero ───────────────────────────────────────────── */

test('dato de la petición interpolado en SQL → avisa', () => {
  const h = sql.escanear(
    "const r = await query(`SELECT * FROM paciente WHERE nombre = '${req.query.q}'`);",
    'a.ts'
  );
  assert.equal(h.length, 1);
  assert.equal(h[0].type, 'SQL_INTERPOLADO');
  assert.match(h[0].message, /viene de la petición/);
});

test('concatenación con + sobre una cadena SQL → avisa', () => {
  const h = sql.escanear(
    'const r = await db.query("SELECT * FROM cita WHERE id = " + params.id);',
    'a.ts'
  );
  assert.equal(h.length, 1);
  assert.equal(h[0].type, 'SQL_CONCATENADO');
});

test('el aviso señala la línea del código, no la del comentario', () => {
  /* Primera versión: la ventana deslizante reportaba la línea de arranque, que
     suele ser un comentario, y mandaba al dev a mirar donde no estaba. */
  const h = sql.escanear([
    '// esto de abajo es el agujero',
    '',
    'const r = await query(`SELECT * FROM p WHERE n = \'${req.body.n}\'`);',
  ].join('\n'), 'a.ts');
  assert.equal(h.length, 1);
  assert.equal(h[0].line, 3);
});

test('una sola consulta produce UN aviso, no cinco', () => {
  /* Sin deduplicar, la ventana reportaba el mismo agujero una vez por cada
     línea desde la que se veía. */
  const h = sql.escanear([
    'const r = await query(`',
    '  SELECT *',
    '  FROM paciente',
    "  WHERE nombre = '${req.query.q}'",
    '`);',
  ].join('\n'), 'a.ts');
  assert.equal(h.length, 1, 'una consulta, un aviso');
});

/* ── 2 · lo que NO puede disparar (el test que decide si el gate sobrevive) ── */

test('SQL parametrizado no dispara nada', () => {
  const h = sql.escanear(
    "const r = await consulta('SELECT * FROM paciente WHERE id = @id', { id });",
    'a.ts'
  );
  assert.deepEqual(h, []);
});

test('plantilla sin interpolar nada no dispara nada', () => {
  const h = sql.escanear(
    'const r = await consulta(`SELECT id, estado FROM cln_cita WHERE id_tenant = @t`, { t });',
    'a.ts'
  );
  assert.deepEqual(h, []);
});

test('interpolar una CONSTANTE no dispara nada', () => {
  /* Una constante en mayúsculas la arma el propio código: no viene de fuera. */
  const h = sql.escanear(
    'const r = await consulta(`SELECT * FROM ${TABLA_CITAS} WHERE id_tenant = @t`, { t });',
    'a.ts'
  );
  assert.deepEqual(h, []);
});

test('EL CASO DE LAS 48 FALSAS ALARMAS: fragmento propio en un archivo que parametriza', () => {
  /* Reproducción literal del patrón de salud360 que rompió la primera versión.
     `where` es SQL que el propio archivo compuso con parámetros y ató con
     `.input(...)`. Es código CORRECTO y no puede avisar. */
  const codigo = [
    'const whereParts = ["(@incl = 1 OR CAST(a.borrado AS INT) = 0)", "LOWER(a.nombre) LIKE LOWER(@pat)"];',
    'const where = whereParts.join(" AND ");',
    'const reqC = pool.request();',
    'reqC.input("incl", sql.Bit, 1);',
    'reqC.input("pat", sql.NVarChar(400), pattern);',
    'const total = await reqC.query(`SELECT COUNT(*) AS t FROM dbo.area a WHERE ${where}`);',
  ].join('\n');
  assert.deepEqual(sql.escanear(codigo, 'route.ts'), [],
    'el patrón que dio 48 falsos positivos tiene que quedar en cero');
});

test('en un archivo que NO parametriza en ningún sitio, la interpolación sí avisa', () => {
  /* Ahí no hay ninguna vía segura por la que el dato pudiera estar pasando. */
  const h = sql.escanear(
    'const r = await conn.query(`SELECT * FROM paciente WHERE id = ${elId}`);',
    'sin-params.js'
  );
  assert.equal(h.length, 1);
  assert.match(h[0].message, /no parametriza/);
});

test('la prosa que menciona select y from no dispara nada', () => {
  assert.deepEqual(sql.escanear('const t = "el select viene from la base";', 'a.ts'), []);
});

test('los archivos de test no se escanean: su SQL malo es a propósito', () => {
  const r = sql.filtrarArchivos([
    'src/api/route.ts', 'test/algo.test.cjs', 'src/__tests__/x.js', 'docs/guia.md',
  ]);
  assert.deepEqual(r, ['src/api/route.ts']);
});

test('H15: un ejemplo de SQL malo dentro de un comentario no es un hallazgo', () => {
  const codigo = [
    '/**',
    " *     `SELECT * FROM paciente WHERE nombre = '${req.query.q}'`",
    ' */',
    "// const r = `SELECT * FROM p WHERE n = '${req.body.n}'`;",
    'const url = "http://x//y"; const ok = 1;',
  ].join('\n');
  assert.deepEqual(sql.escanear(codigo, 'a.js'), []);
});

test('H15: alias del dato de la petición junto a una consulta segura se detecta', () => {
  /* El archivo parametriza en otro sitio; eso no exime a la consulta insegura. */
  const codigo = [
    'const seguro = await db.prepare("SELECT * FROM p WHERE id = ?").get(id);',
    'const { q } = req.query;',
    'const filtro = q.trim();',
    'const r = await db.query(`SELECT * FROM p WHERE nombre = \'${filtro}\'`);',
  ].join('\n');
  const h = sql.escanear(codigo, 'a.js');
  assert.equal(h.length, 1);
  assert.equal(h[0].line, 4);
  assert.match(h[0].message, /a través de `filtro`/);
});

test('H15: archivo ilegible o binario queda UNKNOWN, no limpio', () => {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-sqlcov-'));
  fs.writeFileSync(path.join(dir, 'bin.js'), Buffer.from([0x61, 0x00, 0x62]));
  const r = sql.escanearConCobertura(['bin.js', 'falta.js'], dir);
  assert.equal(r.status, 'UNVERIFIED');
  assert.deepEqual(r.unknown.map((u) => u.reason).sort(), ['BINARIO', 'ILEGIBLE']);
});

/* ── 3 · el escaneo de dependencias ────────────────────────────────────────── */

function proyectoNpm() {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-deps-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}');
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3}');
  return dir;
}

test('H15: ENOAUDIT, basura, timeout o formato desconocido nunca dan "0 vulnerabilidades"', () => {
  const dir = proyectoNpm();
  const casos = [
    [{ stdout: '{"error":{"code":"ENOAUDIT","summary":"no audit"}}', code: 1 }, 'ENOAUDIT'],
    [{ stdout: '<html>bad gateway</html>', code: 1 }, 'SALIDA_INVALIDA'],
    [{ stdout: '', code: null, timedOut: true }, 'TIMEOUT'],
    [{ stdout: '{"auditReportVersion":2}', code: 0 }, 'FORMATO_DESCONOCIDO'],
    [{ stdout: '[]', code: 0 }, 'SALIDA_INVALIDA'],
  ];
  for (const [salida, codigo] of casos) {
    const r = deps.auditar(dir, { ejecutar: () => salida });
    assert.equal(r.status, 'ERROR', codigo);
    assert.equal(r.reason_code, codigo);
    assert.equal(r.disponible, false);
    assert.equal(r.total, undefined, 'un error no trae un total');
  }
});

test('H15: respuesta válida con vulnerabilidades = FAIL; sin ellas = PASS', () => {
  const dir = proyectoNpm();
  const conVulns = JSON.stringify({
    vulnerabilities: { lodash: { severity: 'high', via: ['Prototype pollution'], fixAvailable: true } },
    metadata: { vulnerabilities: { critical: 0, high: 1, moderate: 0, low: 0, info: 0 } },
  });
  const r = deps.auditar(dir, { ejecutar: () => ({ stdout: conVulns, code: 1 }) });
  assert.equal(r.status, 'FAIL');
  assert.equal(r.graves, 1);
  const limpio = JSON.stringify({ vulnerabilities: {}, metadata: { vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0, info: 0 } } });
  assert.equal(deps.auditar(dir, { ejecutar: () => ({ stdout: limpio, code: 0 }) }).status, 'PASS');
});

test('H15: la caché depende del hash del lock y de la fecha', () => {
  const dir = proyectoNpm();
  const limpio = JSON.stringify({ vulnerabilities: {}, metadata: { vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0, info: 0 } } });
  const ahora = Date.parse('2026-10-01T10:00:00Z');
  const primero = deps.auditar(dir, { ejecutar: () => ({ stdout: limpio, code: 0 }), ahora });
  assert.equal(primero.status, 'PASS');
  // la caché se escribe tras una consulta real; se simula guardándola por la vía pública
  const cachePath = path.join(dir, '.agentic', '_cache', 'deps-audit.json');
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify({ huella: deps.huellaLock(dir), fecha: new Date(ahora).toISOString(), resultado: primero }));
  assert.ok(deps.auditar(dir, { ahora: ahora + 1000 }).cache, 'mismo lock y reciente: se reutiliza');
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3,"x":1}');
  const otro = deps.auditar(dir, { ahora: ahora + 2000, timeoutMs: 1 });
  assert.equal(otro.cache, undefined, 'lock distinto: no se reutiliza');
});

test('solo mira si las dependencias cambiaron de verdad', () => {
  /* La preocupación explícita del dev: que no haga consultas de red por gusto.
     Las dependencias no cambian en cada commit — cambian cuando se instala
     algo. */
  assert.equal(deps.hayCambioDeDependencias(['src/a.ts', 'README.md']), false);
  assert.equal(deps.hayCambioDeDependencias(['package.json']), true);
  assert.equal(deps.hayCambioDeDependencias(['package-lock.json']), true);
  assert.equal(deps.hayCambioDeDependencias(['app/pnpm-lock.yaml']), true);
  assert.equal(deps.hayCambioDeDependencias([]), false);
  assert.equal(deps.hayCambioDeDependencias(null), false);
});

test('sin package.json se sale limpio, no revienta', () => {
  const os = require('os');
  const vacio = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-sinpkg-'));
  const r = deps.auditar(vacio);
  assert.equal(r.disponible, false);
  assert.match(r.motivo, /package\.json/);
});

test('el informe dice qué paquete y si tiene arreglo', () => {
  const texto = deps.formatear({
    disponible: true, total: 2, graves: 2,
    conteo: { critical: 1, high: 1, moderate: 0, low: 0, info: 0 },
    paquetes: [
      { nombre: 'protobufjs', severidad: 'critical', via: 'Arbitrary code execution', arreglable: true },
      { nombre: 'sharp', severidad: 'high', via: 'CVE-2026-33327', arreglable: false },
    ],
  });
  assert.match(texto, /protobufjs/);
  assert.match(texto, /npm audit fix lo arregla/);
  assert.match(texto, /sin arreglo disponible/);
});

/* ── 4 · canarios: que sigan enchufados y que no bloqueen ──────────────────── */

const NL = String.fromCharCode(10);
const soloCodigo = (t) => String(t)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split(NL).filter((l) => !/^\s*(\/\/|\*)/.test(l)).join(NL);

test('el security-gate llama al detector de SQL', () => {
  const sg = soloCodigo(fs.readFileSync(
    path.join(RAIZ, '.agentic', 'grafo', 'security-gate.cjs'), 'utf8'));
  assert.match(sg, /sqlScan\.escanear\s*\(/,
    'el detector solo protege si el gate lo invoca');
});

test('el detector de SQL nunca sube a CRITICAL', () => {
  /* CRITICAL bloquea el commit. Bloquear por una heurística es lo único de lo
     que un control así no se recupera. */
  const src = fs.readFileSync(
    path.join(RAIZ, '.agentic', 'grafo', 'sql-injection-scan.cjs'), 'utf8');
  assert.ok(!/severity:\s*'CRITICAL'/.test(src),
    'determinista puede frenar, heurístico solo avisa');
  assert.match(src, /severity:\s*'HIGH'/);
});

test('post-cycle revisa dependencias solo cuando cambiaron', () => {
  const pc = soloCodigo(fs.readFileSync(
    path.join(RAIZ, '.agentic', 'grafo', 'post-cycle.cjs'), 'utf8'));
  assert.match(pc, /da\.hayCambioDeDependencias\s*\(/,
    'sin la condición, cada commit haría una consulta de red inútil');
  assert.match(pc, /2\.13 Deps Audit/, 'debe ser un paso visible');
});

test('el propio Agentix pasa su detector de SQL', () => {
  /* Coherencia: un control que su propio proyecto no pasaría no es creíble. */
  const suyos = fs.readdirSync(path.join(RAIZ, '.agentic', 'grafo'))
    .filter((f) => f.endsWith('.cjs'))
    .map((f) => path.join('.agentic', 'grafo', f));
  const h = sql.escanearArchivos(suyos, RAIZ);
  assert.deepEqual(h.map((x) => x.file + ':' + x.line), [],
    'Agentix arma SQL pegando datos en: ' + h.map((x) => x.file).join(', '));
});
