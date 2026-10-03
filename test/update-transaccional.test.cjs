'use strict';

/* H25 — update atómico y reversible: fallo intermedio, muerte a mitad,
   archivo hostil, dos proyectos a la vez, personalizados y obsoletos. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const { update, rollback } = require('../src/update.js');
const txm = require('../src/update-tx.js');
const { createTarGz } = require('../src/tar-extract.js');
const real = require('./helpers/db-real.cjs');

const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
function escribir(base, rel, texto) {
  const f = path.join(base, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, texto);
  return f;
}

/* Un framework mínimo con la forma del real. `grafo.cjs migrate` deja una
   marca: así se ve si alguien migró sin que se lo pidieran. */
function framework(version, extra = {}) {
  const dir = tmp('akdd-fw-');
  const raiz = path.join(dir, 'AGENTIX-KDD-main');
  escribir(raiz, '.agentic/grafo/framework.json', JSON.stringify({ name: 'agentic-kdd', version, schema: {} }));
  escribir(raiz, '.agentic/grafo/grafo.cjs',
    "if (process.argv[2] === 'migrate') require('fs').writeFileSync('MIGRADO', '1');\n// v" + version + '\n');
  escribir(raiz, '.agentic/grafo/util.cjs', `module.exports = '${version}';\n`);
  escribir(raiz, '.agentic/agentes/01-orquestador.md', `# Orquestador ${version}\n`);
  escribir(raiz, 'dashboard.cjs', `// dashboard ${version}\n`);
  escribir(raiz, 'CLAUDE.md', `# Agentix ${version}\n\n# INSTRUCCIONES DEL PROYECTO\n# =====\n`);
  for (const [rel, txt] of Object.entries(extra)) escribir(raiz, rel, txt);
  const tar = path.join(dir, 'fw.tar.gz');
  createTarGz(tar, dir, 'AGENTIX-KDD-main', [], { timeout: 60000 });
  return tar;
}

function proyecto() {
  const root = tmp('akdd-proj-');
  escribir(root, '.agentic/config.md', '# Config\n\nCONFIGURADO: SI\nNombre: clinica\n');
  escribir(root, '.agentic/memoria/patrones.md', '# Patrones del usuario\n');
  escribir(root, 'src/app.js', 'console.log(1);\n');
  return root;
}

const silencio = async (fn) => {
  const log = console.log; const err = console.error;
  console.log = () => {}; console.error = () => {};
  try { return await fn(); } finally { console.log = log; console.error = err; }
};
const correr = (root, opts) => silencio(() => update({ projectPath: root, salir: false, ...opts }));

test('H25: fallo a mitad revierte el framework completo y la config', async () => {
  const root = proyecto();
  assert.ok((await correr(root, { archivo: framework('1.0.0') })).ok);
  const antes = {};
  for (const rel of ['.agentic/grafo/grafo.cjs', '.agentic/grafo/util.cjs', 'dashboard.cjs', 'CLAUDE.md', '.agentic/config.md', '.agentic/_update/owned.json']) {
    antes[rel] = md5(path.join(root, rel));
  }

  const r = await correr(root, { archivo: framework('2.0.0', { '.agentic/grafo/nuevo.cjs': '1;\n' }), fallarTras: 2 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'FALLO_INYECTADO');
  assert.ok(r.revertidos >= 2);
  for (const [rel, h] of Object.entries(antes)) assert.strictEqual(md5(path.join(root, rel)), h, `${rel} vuelve a la versión anterior`);
  assert.ok(!fs.existsSync(path.join(root, '.agentic/grafo/nuevo.cjs')), 'lo creado a mitad se retira');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(root, '.agentic/grafo/framework.json'), 'utf8')).version, '1.0.0');
});

test('H25: si el proceso muere a mitad, la siguiente corrida revierte antes de seguir', async () => {
  const root = proyecto();
  await correr(root, { archivo: framework('1.0.0') });
  const original = md5(path.join(root, '.agentic/grafo/util.cjs'));

  const staging = txm.prepararStaging(framework('2.0.0'));
  const j = txm.abrirJournal(root, { version: '2.0.0' });
  assert.throws(() => txm.aplicar(root, staging, j, { fallarTras: 1 }));
  fs.rmSync(staging, { recursive: true, force: true });
  assert.strictEqual(JSON.parse(fs.readFileSync(j.archivo, 'utf8')).estado, 'aplicando', 'muerto sin revertir');

  const recuperados = txm.recuperarPendientes(root);
  assert.strictEqual(recuperados.length, 1);
  assert.strictEqual(md5(path.join(root, '.agentic/grafo/util.cjs')), original);
  assert.strictEqual(JSON.parse(fs.readFileSync(j.archivo, 'utf8')).estado, 'revertido');
  assert.ok((await correr(root, { archivo: framework('2.0.0') })).ok, 'después se actualiza normal');
});

/* Tar ustar escrito a mano: lo que un atacante puede poner y tar no fabrica. */
function tarHostil(entradas) {
  const bloques = [];
  for (const e of entradas) {
    const h = Buffer.alloc(512);
    h.write(e.name, 0, 100);
    h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    const datos = Buffer.from(e.data || '');
    h.write(datos.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write(e.type || '0', 156);
    if (e.link) h.write(e.link, 157, 100);
    h.write('ustar\0', 257); h.write('00', 263);
    let suma = 0; for (const b of h) suma += b;
    h.write(suma.toString(8).padStart(6, '0') + '\0 ', 148);
    bloques.push(h, datos, Buffer.alloc((512 - (datos.length % 512)) % 512));
  }
  bloques.push(Buffer.alloc(1024));
  const f = path.join(tmp('akdd-hostil-'), 'hostil.tar.gz');
  fs.writeFileSync(f, zlib.gzipSync(Buffer.concat(bloques)));
  return f;
}

test('H25: archivo hostil (.. y enlace) se rechaza sin escribir nada', async () => {
  const root = proyecto();
  await correr(root, { archivo: framework('1.0.0') });
  const antes = md5(path.join(root, '.agentic/grafo/grafo.cjs'));
  const testigo = 'akdd-evil-' + crypto.randomBytes(4).toString('hex') + '.txt';

  const viaje = tarHostil([
    { name: 'raiz/.agentic/grafo/grafo.cjs', data: '1;\n' },
    { name: `raiz/../../${testigo}`, data: 'pwned' },
  ]);
  let r = await correr(root, { archivo: viaje });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'ARCHIVO_HOSTIL');
  assert.ok(!fs.existsSync(path.join(os.tmpdir(), testigo)) && !fs.existsSync(path.join(path.dirname(os.tmpdir()), testigo)));

  const enlace = tarHostil([
    { name: 'raiz/.agentic/grafo/grafo.cjs', data: '1;\n' },
    { name: 'raiz/.agentic/grafo/x.cjs', type: '2', link: '../../../../etc/passwd' },
  ]);
  r = await correr(root, { archivo: enlace });
  assert.strictEqual(r.reason, 'ARCHIVO_HOSTIL');
  assert.strictEqual(md5(path.join(root, '.agentic/grafo/grafo.cjs')), antes, 'el proyecto ni se tocó');
});

test('H25: staging único por corrida; dos proyectos a la vez no se pisan', async () => {
  const fw = framework('1.0.0');
  const a = txm.prepararStaging(fw);
  const b = txm.prepararStaging(fw);
  assert.notStrictEqual(a, b);
  fs.rmSync(a, { recursive: true, force: true }); fs.rmSync(b, { recursive: true, force: true });

  const p1 = proyecto(); const p2 = proyecto();
  const hijo = (root) => new Promise((res) => {
    const c = spawn(process.execPath, ['-e',
      `require(${JSON.stringify(path.join(RAIZ, 'src', 'update.js'))}).update({ archivo: ${JSON.stringify(fw)}, salir: false }).then(r => process.exit(r.ok ? 0 : 3))`],
    { cwd: root, stdio: 'ignore' });
    c.on('exit', res);
  });
  const codigos = await Promise.all([hijo(p1), hijo(p2)]);
  assert.deepStrictEqual(codigos, [0, 0]);
  for (const p of [p1, p2]) assert.strictEqual(JSON.parse(fs.readFileSync(path.join(p, '.agentic/grafo/framework.json'), 'utf8')).version, '1.0.0');
});

test('H25: personalizado intacto; obsoleto solo se borra si nadie lo tocó', async () => {
  const root = proyecto();
  await correr(root, { archivo: framework('1.0.0', { '.agentic/grafo/viejo.cjs': '1;\n', '.agentic/grafo/viejo2.cjs': '2;\n' }) });
  fs.writeFileSync(path.join(root, '.agentic/grafo/util.cjs'), "module.exports = 'MIO';\n");
  fs.writeFileSync(path.join(root, '.agentic/grafo/viejo2.cjs'), '// lo cambié yo\n');

  const r = await correr(root, { archivo: framework('2.0.0') });
  assert.ok(r.ok);
  assert.match(fs.readFileSync(path.join(root, '.agentic/grafo/util.cjs'), 'utf8'), /MIO/);
  assert.deepStrictEqual(r.personalizados, ['.agentic/grafo/util.cjs']);
  const nueva = path.join(path.dirname(r.journal), 'personalizados', '.agentic/grafo/util.cjs');
  assert.match(fs.readFileSync(nueva, 'utf8'), /2\.0\.0/, 'la versión nueva queda al lado para comparar');
  assert.ok(!fs.existsSync(path.join(root, '.agentic/grafo/viejo.cjs')));
  assert.ok(fs.existsSync(path.join(root, '.agentic/grafo/viejo2.cjs')));
  assert.deepStrictEqual(r.obsoletosConservados, ['.agentic/grafo/viejo2.cjs']);
  assert.match(fs.readFileSync(path.join(root, '.agentic/grafo/grafo.cjs'), 'utf8'), /v2\.0\.0/);
});

test('H25: integridad y rollback a mano; la memoria se conserva por contenido', async () => {
  const root = proyecto();
  const fw1 = framework('1.0.0');
  const malo = await correr(root, { archivo: fw1, sha256: '0'.repeat(64) });
  assert.strictEqual(malo.reason, 'INTEGRIDAD');
  assert.ok(!fs.existsSync(path.join(root, '.agentic/grafo')), 'sha256 distinto: nada se copió');

  const dbPath = real.crearBase(path.join(root, '.agentic/memoria.db'));
  const antes = real.inventario(dbPath);
  const r1 = await correr(root, { archivo: fw1, sha256: txm.hashArchivo(fw1), __sinFuncional: true }); // el motor de juguete no sabe buscar ni hablar MCP
  assert.ok(r1.ok, JSON.stringify(r1.errors));
  assert.ok(!fs.existsSync(path.join(root, 'MIGRADO')), 'el esquema no se migra ejecutando grafo.cjs migrate: lo hace el catálogo');
  assert.strictEqual(real.conservada(antes, dbPath).status, 'PASS', 'la memoria original se conserva por contenido');
  assert.ok(r1.backup && fs.existsSync(r1.backup.path), 'hay un respaldo verificado de la base');

  const r2 = await correr(root, { archivo: framework('2.0.0'), migrate: true, __sinFuncional: true });
  assert.ok(r2.ok, JSON.stringify(r2.errors));
  assert.strictEqual(real.conservada(antes, dbPath).status, 'PASS');

  const rb = await silencio(() => rollback({ projectPath: root }));
  assert.ok(rb.ok, JSON.stringify(rb.errors || rb));
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(root, '.agentic/grafo/framework.json'), 'utf8')).version, '1.0.0');
  assert.match(fs.readFileSync(path.join(root, '.agentic/memoria/patrones.md'), 'utf8'), /del usuario/);
});
