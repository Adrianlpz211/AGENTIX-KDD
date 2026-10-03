'use strict';

/* P19 — el arnés del benchmark: inventario finito con la matriz mínima del
   02, cada prueba asignada existe, un SKIP o una prueba no seleccionada no
   cuentan como detección, un caso sin prueba sigue en el denominador y no
   hay promedio compuesto. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const bp = require('../.agentic/grafo/benchmark-preservacion.cjs');
const TEST_DIR = __dirname;

test('P19: el inventario tiene la matriz mínima completa y ids únicos', () => {
  const ids = bp.CASOS.map((c) => c.id);
  assert.strictEqual(new Set(ids).size, ids.length);
  assert.strictEqual(bp.CASOS.filter((c) => c.lado === 'backend' && c.tipo === 'mutante').length, 20);
  assert.strictEqual(bp.CASOS.filter((c) => c.lado === 'frontend' && c.tipo === 'mutante').length, 30);
  const sanos = bp.CASOS.filter((c) => c.tipo === 'sano').map((c) => c.caso).join(' | ');
  for (const k of ['texto local', 'refactor equivalente', 'cambio intencional', 'dependencia no afectada', 'documentación', 'escenario alternativo', 'estilos fuera']) assert.ok(sanos.includes(k), 'falta el control sano: ' + k);
  for (const c of bp.CASOS.filter((x) => !x.pruebas.length)) assert.ok(c.arreglo, `${c.id} sin prueba debe decir su arreglo exacto`);
});

test('P19: cada prueba asignada existe en su archivo', () => {
  for (const c of bp.CASOS) for (const p of c.pruebas) {
    const f = path.join(TEST_DIR, p.archivo);
    assert.ok(fs.existsSync(f), `${c.id}: falta ${p.archivo}`);
    const src = fs.readFileSync(f, 'utf8');
    // Los títulos generados por plantilla se comprueban por su parte variable.
    const resto = p.patron.replace(/^P\d+:? (sembrar )?/, '');
    assert.ok(src.includes(p.patron) || src.includes(resto), `${c.id}: "${p.patron}" no está en ${p.archivo}`);
  }
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-bench-arnes-'));
  fs.mkdirSync(path.join(root, 'test'));
  fs.writeFileSync(path.join(root, 'test', 'x.test.cjs'), [
    "const { test } = require('node:test');",
    "test('detecta A', () => {});",
    "test('detecta B', () => { throw new Error('sobrevive'); });",
    "test('omitida C', (t) => t.skip('sin navegador'));",
    "test('sano D', () => {});",
  ].join('\n'));
  return root;
}

test('P19: SKIP y prueba no seleccionada no son detección; sin prueba sigue en el denominador', { timeout: 60000 }, () => {
  const root = fixture();
  const P = (patron) => ({ archivo: 'x.test.cjs', patron });
  const casos = [
    { id: 'B01', lado: 'backend', tipo: 'mutante', criticidad: 'CRITICA', caso: 'a', pruebas: [P('detecta A')] },
    { id: 'B02', lado: 'backend', tipo: 'mutante', criticidad: 'CRITICA', caso: 'b', pruebas: [P('detecta B')] },
    { id: 'B03', lado: 'backend', tipo: 'mutante', criticidad: 'ALTA', caso: 'c', pruebas: [P('omitida C')] },
    { id: 'B04', lado: 'backend', tipo: 'mutante', criticidad: 'ALTA', caso: 'd', pruebas: [P('detecta A'), P('no existe Z')] },
    { id: 'B05', lado: 'backend', tipo: 'mutante', criticidad: 'ALTA', caso: 'e', pruebas: [], arreglo: 'escribir la prueba' },
    { id: 'S01', lado: 'backend', tipo: 'sano', caso: 's', pruebas: [P('sano D')] },
  ];
  const r = bp.ejecutar(root, { casos });
  const est = Object.fromEntries(r.filas.map((f) => [f.case_id, f.estado]));
  assert.deepStrictEqual(est, { B01: 'DETECTADO', B02: 'SOBREVIVIO', B03: 'NO_EJECUTADA', B04: 'NO_EJECUTADA', B05: 'SIN_PRUEBA', S01: 'PASA' });
  for (const f of r.filas.filter((x) => x.estado !== 'SIN_PRUEBA')) {
    assert.strictEqual(f.execution_id, r.execution_id);
    assert.strictEqual(f.subject_hash, r.subject_hash);
  }
  const m = bp.metricas(r.filas).backend;
  assert.strictEqual(m.cobertura.texto, '4/5', 'el caso sin prueba cuenta en el denominador');
  assert.strictEqual(m.deteccion.texto, '1/2', 'el SKIP y la prueba no seleccionada no son detección');
  assert.strictEqual(m.vigencia.texto, '2/4');
  assert.deepStrictEqual(m.sobrevivientes, ['B02']);
  assert.strictEqual(m.falsa_alarma.texto, '0/1');
  assert.strictEqual(m.criticos_detectados.texto, '1/2');
  assert.strictEqual(bp.metricas(r.filas).frontend.deteccion.texto, 'no medible (0 observaciones)');
  assert.ok(!Object.keys(bp.metricas(r.filas)).some((k) => /promedio|total|global/.test(k)), 'sin promedio compuesto');
});
