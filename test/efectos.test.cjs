'use strict';

/* P08 — efectos externos. Un fallo a mitad de un lote no deja estado parcial;
   restaurar código con un efecto externo pendiente no declara el sistema
   restaurado; tenants distintos y repeticiones no se fugan ni se duplican. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ef = require('../.agentic/grafo/efectos.cjs');
const rm = require('../.agentic/grafo/restore-manager.cjs');

const tmp = () => { const r = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-ef-')); fs.mkdirSync(path.join(r, '.agentic')); return r; };
const fila = (k, extra) => Object.assign({ tipo: 'db', recurso_id: 'pedidos/' + k, idempotency_key: k, reversible: true, tenant: 'A' }, extra);
const diario = (root) => path.join(root, '.agentic', 'efectos.jsonl');

test('P08: un lote con un efecto inválido no escribe ninguno', () => {
  const root = tmp();
  const r = ef.registrarLote(root, [fila('1'), fila('2', { reversible: undefined })]);
  assert.strictEqual(r.status, 'RECHAZADO');
  assert.deepStrictEqual(r.rechazos[0].errores, ['REVERSIBILIDAD_NO_DECLARADA']);
  assert.strictEqual(ef.listar(root).length, 0);
});

test('P08: una escritura cortada a mitad no deja el lote a medias ni contamina el siguiente', () => {
  const root = tmp();
  assert.strictEqual(ef.registrarLote(root, [fila('1'), fila('2')]).escritos, 2);
  const completa = fs.readFileSync(diario(root), 'utf8');
  ef.registrarLote(root, [fila('3'), fila('4')]);
  const conSegundo = fs.readFileSync(diario(root), 'utf8');
  const cortada = conSegundo.slice(0, completa.length + Math.floor((conSegundo.length - completa.length) / 2));
  fs.writeFileSync(diario(root), cortada);
  assert.deepStrictEqual(ef.listar(root).map((e) => e.idempotency_key).sort(), ['1', '2'], 'el lote cortado no cuenta entero');
  assert.strictEqual(ef.registrarLote(root, [fila('5')]).escritos, 1);
  assert.deepStrictEqual(ef.listar(root).map((e) => e.idempotency_key).sort(), ['1', '2', '5']);
});

test('P08: repetir la misma clave no duplica; otro tenant con la misma clave sí es otro efecto', () => {
  const root = tmp();
  ef.registrar(root, fila('k'));
  const otra = ef.registrar(root, fila('k'));
  assert.strictEqual(otra.escritos, 0);
  assert.strictEqual(otra.duplicados.length, 1);
  assert.strictEqual(ef.registrarLote(root, [fila('z'), fila('z')]).escritos, 1, 'duplicado dentro del mismo lote');
  assert.strictEqual(ef.registrar(root, fila('k', { tenant: 'B' })).escritos, 1);
  assert.strictEqual(ef.listar(root, { tenant: 'A' }).length, 2);
  assert.ok(ef.listar(root, { tenant: 'B' }).every((e) => e.tenant === 'B'), 'B no ve efectos de A');
  assert.strictEqual(ef.listar(root, { tenant: 'C' }).length, 0);
});

test('P08: sin secretos en el diario', () => {
  const root = tmp();
  ef.registrar(root, fila('s', { detalle: { password: 'hunter2', url: 'postgres://u:clave@db/x', nota: 'ok' }, api_key: 'sk_live_abcdefghijklmnop' }));
  const txt = fs.readFileSync(diario(root), 'utf8');
  assert.ok(!/hunter2|clave@|sk_live_/.test(txt), txt);
  assert.match(txt, /\[REDACTADO\]/);
  assert.match(txt, /"nota":"ok"/);
});

test('P08: pago o mensaje irreversible sin aprobación humana es STOP', () => {
  const root = tmp();
  const pago = fila('p', { tipo: 'pago', reversible: false, compensacion: 'reembolso manual' });
  assert.strictEqual(ef.registrar(root, pago).status, 'STOP_HUMANO');
  assert.ok(ef.registrar(root, fila('q', { reversible: false })).rechazos[0].errores.includes('SIN_PLAN_DE_COMPENSACION'));
  assert.strictEqual(ef.registrar(root, Object.assign({}, pago, { aprobacion: { aprobador: 'ana', motivo: 'cobro real acordado' } })).status, 'OK');
  assert.strictEqual(ef.listar(root).length, 1);
});

test('P08: compensar exige evidencia y saca el efecto de pendientes', () => {
  const root = tmp();
  const { ids: [id] } = ef.registrar(root, fila('c'));
  assert.strictEqual(ef.compensar(root, id, {}).reason_code, 'SIN_EVIDENCIA_DE_COMPENSACION');
  assert.strictEqual(ef.compensar(root, id, { evidencia: 'fila borrada, ver log 812' }).status, 'OK');
  assert.strictEqual(ef.listar(root, { pendientes: true }).length, 0);
  assert.strictEqual(ef.listar(root).length, 1, 'el historial no se borra');
});

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-ef-restore-'));
  const g = (...a) => {
    const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: root, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(a.join(' ') + ': ' + r.stderr);
    return r.stdout.trim();
  };
  g('init', '-q');
  fs.mkdirSync(path.join(root, '.agentic'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(root, '.gitignore'), '.agentic/_restore/\n.agentic/memoria.db*\n');
  fs.writeFileSync(path.join(root, '.agentic', 'config.md'), 'CONFIGURADO: SI\n');
  require('../.agentic/grafo/db-adapter.cjs').openWrite(path.join(root, '.agentic', 'memoria.db')).close();
  g('add', '-A');
  g('commit', '-q', '-m', 'base');
  return root;
}

test('P08: restore con efecto externo pendiente no declara el sistema restaurado', (t) => {
  if (spawnSync('git', ['--version']).status !== 0) return t.skip('sin git en este entorno');
  const root = repo();
  const punto = rm.crear(root, { label: 'antes del cobro' });
  assert.strictEqual(punto.status, 'OK', JSON.stringify(punto));
  const pid = punto.punto.id;
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 2;\n');
  ef.registrar(root, fila('fila-1', { compensacion: 'borrar la fila' }));
  ef.registrar(root, { tipo: 'mensaje', recurso_id: 'cliente-9', idempotency_key: 'm1', reversible: false, compensacion: 'enviar aclaración', aprobacion: { aprobador: 'ana', motivo: 'aviso pactado' } });
  const antes = fs.readFileSync(diario(root), 'utf8');

  const p = rm.preview(root, pid);
  assert.strictEqual(p.efectos_externos_no_revertibles.length, 2, JSON.stringify(p.efectos_externos_no_revertibles));
  assert.ok(!p.ops.some((o) => o.path === '.agentic/efectos.jsonl'), 'restaurar código no toca el diario de efectos');
  const r = rm.aplicar(root, pid, { expected_current_hash: p.expected_current_hash });
  assert.strictEqual(r.status, 'RESTAURADO', JSON.stringify(r));
  assert.strictEqual(r.sistema_restaurado, false);
  assert.strictEqual(r.recuperacion, 'SOLO_CODIGO');
  assert.strictEqual(fs.readFileSync(path.join(root, 'src', 'a.js'), 'utf8').replace(/\r/g, ''), 'module.exports = 1;\n');
  assert.strictEqual(fs.readFileSync(diario(root), 'utf8'), antes, 'el diario sobrevive al restore');

  for (const e of ef.listar(root, { pendientes: true })) ef.compensar(root, e.id, { evidencia: 'hecho a mano' });
  const p2 = rm.preview(root, pid);
  assert.strictEqual(p2.efectos_externos_no_revertibles.length, 0);
});
