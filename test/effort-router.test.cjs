'use strict';

/* 02-esfuerzo-y-tokens — router universal, paquete de contexto y caché de
   evidencia. Cada test es un criterio de aceptación del paquete. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const router = require('../.agentic/grafo/effort-router.cjs');
const ec = require('../.agentic/grafo/evidence-cache.cjs');
const cp = require('../.agentic/grafo/context-pack.cjs');
const pc = require('../.agentic/grafo/pipeline-controller.cjs');

function proyecto() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-effort-'));
  fs.mkdirSync(path.join(root, '.agentic', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agentic', 'specs', 'ui.md'), '# spec activa de ui\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fx', version: '1.0.0' }));
  return root;
}

test('02: texto localizado sigue LOW aunque exista spec activa', () => {
  const root = proyecto();
  const d = router.decidir({ intent: 'cambia el texto del botón Guardar a Enviar', paths: ['src/components/Boton.tsx'], index_coverage: 'COMPLETE' }, { root });
  assert.strictEqual(d.tier, 'LOW');
  for (const g of router.MINIMOS) assert.ok(d.required_gates.includes(g), `mínimo ${g} presente`);
  assert.strictEqual(d.host_effort, 'no_controlable');
});

test('02: dos líneas de autorización quedan HIGH por riesgo, con reviewer', () => {
  const root = proyecto();
  const d = router.decidir({ intent: 'cambia dos líneas en la verificación de permisos', paths: ['src/middleware/permisos.ts'], change_type: 'LOCAL_TEXT_CHANGE' }, { root });
  assert.strictEqual(d.risk, 'HIGH');
  assert.strictEqual(d.tier, 'HIGH');
  assert.ok(d.required_roles.includes('reviewer'));
});

test('02: un LOW pedido sobre riesgo alto se rechaza por MIN_SEGURIDAD', () => {
  const root = proyecto();
  const d = router.decidir({ intent: 'ajusta la validación del token de sesión', paths: ['src/auth.ts'], requested_tier: 'LOW' }, { root });
  assert.strictEqual(d.tier, 'HIGH');
  assert.strictEqual(d.requested_tier_rejected, 'MIN_SEGURIDAD');
});

test('02: bug acotado usa MEDIUM con tests dirigidos; dependencia crítica nueva lo escala', () => {
  const root = proyecto();
  const d = router.decidirYGuardar(root, { task_id: 'bug-1', intent: 'arregla el bug del total del carrito', paths: ['src/cart/total.ts'], index_coverage: 'COMPLETE' });
  assert.strictEqual(d.tier, 'MEDIUM');
  assert.ok(d.required_gates.includes('affected-tests'));
  assert.ok(!d.required_gates.includes('tdd'), 'MEDIUM no exige la suite completa');
  const r = router.reevaluar(root, 'bug-1', 'UNEXPECTED_DEPENDENCY', 'importa el módulo de pagos');
  assert.ok(r.ok && r.cambio);
  assert.strictEqual(r.decision.tier, 'HIGH');
  const h = router.leer(root, 'bug-1').historial;
  assert.strictEqual(h[h.length - 1].evento, 'UNEXPECTED_DEPENDENCY');
  // Desescalar nunca baja del piso de riesgo
  const crit = router.decidirYGuardar(root, { task_id: 'crit-1', intent: 'cambia el login', paths: ['src/auth.ts'] });
  assert.strictEqual(router.reevaluar(root, 'crit-1', 'SCOPE_BOUNDED').decision.tier, crit.tier);
});

test('02: individual y TEAMS producen la misma política para la misma tarea', () => {
  const root = proyecto();
  const base = { intent: 'agrega validación de correo al formulario de registro', paths: ['src/forms/registro.ts'] };
  const a = router.decidir({ ...base, origen: 'aa' }, { root });
  const t = router.decidir({ ...base, origen: 'teams' }, { root });
  assert.deepStrictEqual(a, t);
});

test('02: límite duro → CHECKPOINT con evidencia y pendientes, nunca completada', () => {
  const root = proyecto();
  router.decidirYGuardar(root, { task_id: 'lim-1', intent: 'refactoriza el módulo de reportes', paths: ['src/reportes/a.ts'], user_limits: { max_tool_calls: 3 } });
  assert.strictEqual(router.consumir(root, 'lim-1', { tool_calls: 2 }).status, 'OK');
  const c = router.consumir(root, 'lim-1', { tool_calls: 2, evidencia: ['test/a.test.js PASS'], pendientes: ['migrar b.ts'] });
  assert.strictEqual(c.status, 'CHECKPOINT');
  assert.strictEqual(c.completed, false);
  const cierre = router.cerrar(root, 'lim-1', { ok: true });
  assert.strictEqual(cierre.ok, false);
  assert.strictEqual(cierre.estado, 'PENDIENTE');
  assert.deepStrictEqual(cierre.checkpoint.pendientes, ['migrar b.ts']);
  assert.deepStrictEqual(cierre.checkpoint.evidencia, ['test/a.test.js PASS']);
});

test('02: límite blando → REEVALUAR, no corta ni completa', () => {
  const root = proyecto();
  router.decidirYGuardar(root, { task_id: 'soft-1', intent: 'cambia el texto del título', paths: ['src/a.html'] });
  const r = router.consumir(root, 'soft-1', { tool_calls: 50 });
  assert.strictEqual(r.status, 'REEVALUAR');
  assert.strictEqual(r.estado, 'EN_CURSO');
});

test('02: política inválida cae a la conservadora con error visible', () => {
  const root = proyecto();
  fs.writeFileSync(path.join(root, '.agentic', 'effort-policy.json'), JSON.stringify({ policy_version: 1, tiers: { LOW: { required_gates: [] } } }));
  const d = router.decidir({ intent: 'cambia el texto', paths: ['a.html'] }, { root });
  assert.ok(d.policy_error);
  for (const g of router.MINIMOS) assert.ok(d.required_gates.includes(g));
});

test('02: cambio de import o de lock invalida la evidencia; dirigido no certifica suite', () => {
  const root = proyecto();
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'a.js'), "const b = require('./b');\nmodule.exports = () => b() + 1;\n");
  fs.writeFileSync(path.join(root, 'src', 'b.js'), 'module.exports = () => 1;\n');
  const q = { comando: 'node --test test/a.test.js', tipo: 'dirigido', alcance: ['src/a.js'] };
  assert.strictEqual(ec.buscar(root, q).motivo, 'SIN_EVIDENCIA');
  ec.guardar(root, q, { status: 'PASS', pass: 3, fail: 0, resumen: 'x'.repeat(5000) });
  const hit = ec.buscar(root, q);
  assert.ok(hit.hit);
  assert.ok(hit.entrada.resultado.resumen.length <= 500, 'guarda resumen, no salida entera');
  assert.strictEqual(ec.buscar(root, { ...q, tipo: 'suite' }).hit, false, 'dirigido no vale como suite');

  fs.writeFileSync(path.join(root, 'src', 'b.js'), 'module.exports = () => 2;\n');
  const m1 = ec.buscar(root, q);
  assert.strictEqual(m1.hit, false);
  assert.strictEqual(m1.motivo, 'SUJETO_CAMBIO', 'import transitivo cambia el sujeto');

  ec.guardar(root, q, { status: 'PASS' });
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/x': { version: '2.0.0' } } }));
  assert.strictEqual(ec.buscar(root, q).motivo, 'RUNNER_O_DEPENDENCIAS_CAMBIO');

  ec.guardar(root, { ...q, ttlMs: 1000 }, { status: 'PASS' });
  assert.strictEqual(ec.buscar(root, q, { ahora: Date.now() + 5000 }).motivo, 'VENCIDA');
});

test('02: el paquete no duplica enriquecimiento y respeta presupuesto por tier', async () => {
  const root = proyecto();
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'a.html'), '<h1>Hola</h1>');
  const e = { task_id: 'pk-1', objetivo: 'cambia el texto del título a Bienvenido', aceptacion: ['el título dice Bienvenido'], paths: ['src/a.html'] };
  const p1 = await cp.armar(root, e);
  assert.strictEqual(p1.reutilizado, false);
  assert.strictEqual(p1.tier, 'LOW');
  assert.ok(p1.bytes <= 12000);
  const p2 = await cp.armar(root, e);
  assert.strictEqual(p2.reutilizado, true, 'misma tarea + mismo contexto = no se vuelve a enriquecer');
  fs.writeFileSync(path.join(root, 'src', 'a.html'), '<h1>Otro</h1>');
  assert.strictEqual((await cp.armar(root, e)).reutilizado, false, 'cambió el archivo → paquete nuevo');
  const builder = cp.paraRol(root, p1, 'builder');
  assert.deepStrictEqual(builder.instrucciones, [cp.NUCLEO], 'LOW carga solo el núcleo');
  const refsHigh = cp.referencias('builder', 'HIGH', ['src/auth.ts', 'src/components/Login.tsx']);
  assert.ok(refsHigh.includes('.agentic/agentes/03-front.md') && refsHigh.includes('.agentic/agentes/04-back.md'));
});

test('02: el paquete redacta secretos del objetivo', async () => {
  const root = proyecto();
  const p = await cp.armar(root, { task_id: 'pk-2', objetivo: 'usa la clave sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd para el cliente', paths: [] });
  assert.ok(!/ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd/.test(JSON.stringify(p)));
});

test('02: sprint aplica el mismo router que aa: al activar cada tarea', () => {
  const root = proyecto();
  require('../.agentic/grafo/db-adapter.cjs').openWrite(path.join(root, '.agentic', 'memoria.db')).close();
  const ss = require('../.agentic/grafo/sprint-state.cjs');
  const st = ss.startSprint(root, 'obj', [{ titulo: 'cambia el texto del botón', paths: ['src/a.html'] }, { titulo: 'cambia la verificación de permisos', paths: ['src/middleware/auth.ts'] }]);
  assert.ok(st, 'el sprint persiste');
  assert.strictEqual(st.tareas[0].effort.tier, 'LOW');
  const st2 = ss.advance(root, 1, 'COMPLETADA');
  const aa = router.decidir({ intent: 'cambia la verificación de permisos', paths: ['src/middleware/auth.ts'] }, { root });
  assert.strictEqual(st2.tareas[1].effort.tier, aa.tier);
  assert.strictEqual(st2.tareas[1].effort.tier, 'HIGH');
});

test('02: pipeline-controller guarda la decisión y endurece la política en HIGH', () => {
  const root = proyecto();
  const e = pc.abrir(root, { cycle_id: 'cy-auth', task: 'cambia la verificación de permisos del middleware', paths: ['src/middleware/auth.ts'] });
  assert.strictEqual(e.effort.tier, 'HIGH');
  assert.strictEqual(e.policy.requires_full_suite, true);
  const low = pc.abrir(root, { cycle_id: 'cy-txt', task: 'cambia el texto del botón', paths: ['src/a.html'] });
  assert.strictEqual(low.effort.tier, 'LOW');
  assert.notStrictEqual(low.policy.requires_full_suite, true);
});
