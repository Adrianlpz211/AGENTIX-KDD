'use strict';

/* P07 — contratos de backend por escenario. Se siembran cambios de status
   HTTP, permisos, tipos, redondeo, duplicación y una carrera realista: el
   escenario afectado lo detecta corriendo de verdad. Un cambio interno
   equivalente pasa. Un contrato sin escenario propio nunca queda verificado. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cb = require('../.agentic/grafo/contratos-backend.cjs');
const cg = require('../.agentic/grafo/contract-guard.cjs');

const SERVICIO = `
const creados = new Map();
let seq = 0;
async function crear(req, db) {
  const { usuario, tenant, body, idemKey } = req;
  if (!usuario) return { status: 401, error: 'NO_AUTENTICADO' };
  if (!usuario.roles.includes('ventas')) return { status: 403, error: 'SIN_PERMISO' };
  if (usuario.tenant !== tenant) return { status: 403, error: 'OTRO_TENANT' };
  if (!Number.isInteger(body.cantidad) || body.cantidad <= 0) return { status: 400, error: 'CANTIDAD_INVALIDA' };
  if (typeof body.precio !== 'number') return { status: 400, error: 'PRECIO_INVALIDO' };
  const k = tenant + ':' + idemKey;
  if (creados.has(k)) return creados.get(k);
  const p = (async () => {
    await new Promise((r) => setTimeout(r, 5));
    const total = Math.round(body.precio * body.cantidad * 100) / 100;
    const pedido = { id: ++seq, tenant, total };
    db.pedidos.push(pedido);
    return { status: 201, pedido };
  })();
  creados.set(k, p);
  return p;
}
module.exports = { crear };
`;

const cabecera = "const test = require('node:test'); const assert = require('node:assert'); const { crear } = require('../src/pedidos.js');\n" +
  "const u = { roles: ['ventas'], tenant: 'A' }; const nuevo = () => ({ pedidos: [] });\n";
const TESTS = {
  'test/pedidos-http.test.js': "test('201 al crear', async () => assert.equal((await crear({ usuario: u, tenant: 'A', body: { cantidad: 1, precio: 2 }, idemKey: 'h1' }, nuevo())).status, 201));\n" +
    "test('401 sin usuario', async () => assert.equal((await crear({ tenant: 'A', body: {} }, nuevo())).status, 401));",
  'test/pedidos-permisos.test.js': "test('403 sin rol y sin efecto', async () => { const db = nuevo(); const r = await crear({ usuario: { roles: [], tenant: 'A' }, tenant: 'A', body: { cantidad: 1, precio: 1 }, idemKey: 'p1' }, db); assert.equal(r.status, 403); assert.equal(db.pedidos.length, 0); });\n" +
    "test('403 otro tenant', async () => assert.equal((await crear({ usuario: u, tenant: 'B', body: { cantidad: 1, precio: 1 }, idemKey: 'p2' }, nuevo())).status, 403));",
  'test/pedidos-tipos.test.js': "test('cantidad texto es 400', async () => assert.equal((await crear({ usuario: u, tenant: 'A', body: { cantidad: '2', precio: 1 }, idemKey: 't1' }, nuevo())).status, 400));",
  'test/pedidos-dinero.test.js': "test('redondeo a centavos', async () => assert.equal((await crear({ usuario: u, tenant: 'A', body: { cantidad: 1, precio: 0.125 }, idemKey: 'm1' }, nuevo())).pedido.total, 0.13));",
  'test/pedidos-idempotencia.test.js': "test('misma clave no duplica', async () => { const db = nuevo(); const q = { usuario: u, tenant: 'A', body: { cantidad: 1, precio: 1 }, idemKey: 'i1' }; await crear(q, db); await crear(q, db); assert.equal(db.pedidos.length, 1); });",
  'test/pedidos-concurrencia.test.js': "test('dos a la vez con la misma clave crean uno', async () => { const db = nuevo(); const q = { usuario: u, tenant: 'A', body: { cantidad: 1, precio: 1 }, idemKey: 'c1' }; await Promise.all([crear(q, db), crear(q, db)]); assert.equal(db.pedidos.length, 1); });",
};

const CONTRATO = {
  id: 'pedidos.crear', operacion: 'POST /pedidos', fuentes: ['src/pedidos.js'],
  dimensiones: ['salida', 'errores', 'autorizacion', 'tenant', 'entradas', 'dinero', 'idempotencia', 'concurrencia'],
  escenarios: [
    { id: 'http', test: 'test/pedidos-http.test.js', cubre: ['salida', 'errores'] },
    { id: 'permisos', test: 'test/pedidos-permisos.test.js', cubre: ['autorizacion', 'tenant'] },
    { id: 'tipos', test: 'test/pedidos-tipos.test.js', cubre: ['entradas'] },
    { id: 'dinero', test: 'test/pedidos-dinero.test.js', cubre: ['dinero'] },
    { id: 'idempotencia', test: 'test/pedidos-idempotencia.test.js', cubre: ['idempotencia'] },
    { id: 'concurrencia', test: 'test/pedidos-concurrencia.test.js', cubre: ['concurrencia'] },
  ],
};

function proyecto(contrato = CONTRATO) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-p07-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'test'));
  fs.mkdirSync(path.join(root, '.agentic', 'contratos'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fx","scripts":{"test":"node --test"}}');
  fs.writeFileSync(path.join(root, 'src', 'pedidos.js'), SERVICIO);
  for (const [f, c] of Object.entries(TESTS)) fs.writeFileSync(path.join(root, f), cabecera + c + '\n');
  fs.writeFileSync(path.join(root, '.agentic', 'contratos', 'pedidos.json'), JSON.stringify(contrato));
  return root;
}

const correr = (root) => cb.verificar(root, ['src/pedidos.js'], { todos: true, comando: 'node --test', subject_hash: 'S' });

const MUTACIONES = [
  ['status HTTP', "return { status: 201, pedido }", "return { status: 200, pedido }", 'http'],
  ['permisos', "if (!usuario.roles.includes('ventas')) return { status: 403, error: 'SIN_PERMISO' };", '', 'permisos'],
  ['tenant cruzado', "if (usuario.tenant !== tenant) return { status: 403, error: 'OTRO_TENANT' };", '', 'permisos'],
  ['tipos', '!Number.isInteger(body.cantidad)', '!(Number(body.cantidad) > 0)', 'tipos'],
  ['redondeo', 'Math.round(body.precio * body.cantidad * 100)', 'Math.floor(body.precio * body.cantidad * 100)', 'dinero'],
  ['duplicación', "  if (creados.has(k)) return creados.get(k);\n", '', 'idempotencia'],
  ['carrera', "  creados.set(k, p);\n  return p;", "  return p.then((x) => { creados.set(k, Promise.resolve(x)); return x; });", 'concurrencia'],
];

test('P07: el contrato completo pasa con evidencia por escenario y queda verificado', { timeout: 120000 }, () => {
  const root = proyecto();
  const r = correr(root);
  assert.strictEqual(r.status, 'PASS', JSON.stringify(r.contratos[0].escenarios));
  assert.strictEqual(r.contratos[0].escenarios.length, 6);
  for (const e of r.contratos[0].escenarios) assert.ok(e.execution_id, e.id + ' sin ejecución');
  assert.strictEqual(r.contratos[0].estado, 'verified');
  assert.ok(cb.vigente(root, 'pedidos.crear'));
  const porCambio = cb.verificar(root, ['src/pedidos.js'], { comando: 'node --test', subject_hash: 'S' });
  assert.strictEqual(porCambio.status, 'UNVERIFIED', 'sin índice de dependencias la selección por cambio es parcial');
  assert.strictEqual(porCambio.reason_code, 'SIN_INDICE_AST');
  fs.mkdirSync(path.join(root, 'test', 'fixtures'));
  const conFixture = Object.assign({}, CONTRATO, { fixtures: ['test/fixtures/x.json'] });
  fs.writeFileSync(path.join(root, '.agentic', 'contratos', 'pedidos.json'), JSON.stringify(conFixture));
  assert.strictEqual(cb.vigente(root, 'pedidos.crear'), false, 'otro contrato o fixture: la verificación deja de valer');
});

for (const [nombre, de, a, escenario] of MUTACIONES) {
  test(`P07: sembrar ${nombre} lo detecta el escenario ${escenario}`, { timeout: 120000 }, () => {
    const root = proyecto();
    const f = path.join(root, 'src', 'pedidos.js');
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(src.includes(de), 'la mutación debe aplicar: ' + de);
    fs.writeFileSync(f, src.replace(de, a));
    const r = correr(root);
    assert.strictEqual(r.status, 'FAIL', nombre);
    const rotos = r.contratos[0].escenarios.filter((e) => e.status === 'FAIL').map((e) => e.id);
    assert.ok(rotos.includes(escenario), `${nombre}: rotos ${rotos}`);
  });
}

test('P07: un cambio interno equivalente pasa', { timeout: 120000 }, () => {
  const root = proyecto();
  const f = path.join(root, 'src', 'pedidos.js');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('Math.round(body.precio * body.cantidad * 100) / 100',
    'Number((Math.round(body.cantidad * body.precio * 100) / 100).toFixed(2))'));
  assert.strictEqual(correr(root).status, 'PASS');
});

test('P07: dimensión sin escenario propio no queda verificada aunque todo pase', { timeout: 120000 }, () => {
  const sinConcurrencia = Object.assign({}, CONTRATO, { escenarios: CONTRATO.escenarios.filter((e) => e.id !== 'concurrencia') });
  const r = correr(proyecto(sinConcurrencia));
  assert.strictEqual(r.status, 'UNVERIFIED');
  assert.ok(r.contratos[0].reparar.some((x) => /concurrencia/.test(x)), 'dice qué falta');
  assert.strictEqual(r.contratos[0].estado, 'candidate');

  const conFantasma = Object.assign({}, CONTRATO, { escenarios: CONTRATO.escenarios.concat({ id: 'x', test: 'test/no-existe.test.js', cubre: ['fechas'] }), dimensiones: CONTRATO.dimensiones.concat('fechas') });
  const r2 = correr(proyecto(conFantasma));
  assert.strictEqual(r2.status, 'UNVERIFIED');
  assert.ok(r2.contratos[0].escenarios.some((e) => e.reason_code === 'ESCENARIO_NO_EXISTE'));
});

test('P07: DTO público con snapshot versionado y consumidor', { timeout: 120000 }, () => {
  const conApi = Object.assign({}, CONTRATO, { api: { archivo: 'openapi.json', consumidores: [] } });
  const root = proyecto(conApi);
  fs.writeFileSync(path.join(root, 'openapi.json'), '{"pedido":{"id":"int","total":"number"}}');
  assert.strictEqual(correr(root).contratos[0].api.reason_code, 'SIN_SNAPSHOT_API');
  assert.strictEqual(cb.aprobarApi(root, 'pedidos.crear', {}).reason_code, 'SIN_DECISION');
  assert.ok(cb.aprobarApi(root, 'pedidos.crear', { aprobador: 'ana', motivo: 'base' }).ok);
  assert.strictEqual(correr(root).status, 'PASS');
  fs.writeFileSync(path.join(root, 'openapi.json'), '{"pedido":{"uuid":"string","importe":"number"}}');
  const r = correr(root);
  assert.strictEqual(r.status, 'FAIL');
  assert.strictEqual(r.contratos[0].api.reason_code, 'DTO_CAMBIO_SIN_CONSUMIDOR');
});

test('runTests dentro de otro node --test: un fallo real sigue siendo FAIL', () => {
  const tdd = require('../.agentic/grafo/tdd-gate.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-ctx-'));
  fs.mkdirSync(path.join(root, 'test'));
  fs.writeFileSync(path.join(root, 'test', 'x.test.js'), "require('node:test')('rompe', () => { throw new Error('x'); });\n");
  const previo = process.env.NODE_TEST_CONTEXT;
  process.env.NODE_TEST_CONTEXT = 'child-v8';
  try {
    const r = tdd.runTests('node --test', root, ['test/x.test.js'], { subject_hash: 'S' });
    assert.strictEqual(r.status, 'FAIL', r.output);
    assert.strictEqual(r.failed, 1);
  } finally {
    if (previo === undefined) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT = previo;
  }
});

test('P07: contract-guard no promueve por salida de texto ni por suite global', (t) => {
  const { abrir, motivoSinDriver } = require('./helpers/sqlite.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-p07cg-'));
  const db = abrir(path.join(root, 'm.db'));
  if (!db) return t.skip(motivoSinDriver());
  try {
    cg.migrateSchema(db);
    const salida = 'PASS test/pagos.test.js\n  ✓ cobra el total correcto (3 ms)\n';
    for (let i = 0; i < 8; i++) cg.ingestFromCycle(db, root, 'c' + i, salida);
    const filas = db.prepare('SELECT name, status, verification_count FROM verified_contracts').all();
    assert.ok(filas.length >= 1);
    for (const f of filas) assert.strictEqual(f.status, 'candidate', `${f.name} subió sin test propio`);
    assert.ok(filas.every((f) => f.verification_count === 1), 'repetir la misma salida no suma pasadas');
  } finally { db.close(); }
});
