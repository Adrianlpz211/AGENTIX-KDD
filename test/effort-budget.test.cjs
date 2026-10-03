'use strict';
/* H02 — Presupuesto de esfuerzo ACUMULADO por tarea.
   Cubre las pruebas 1, 2, 3, 4 y 12 de la sección "Pruebas" de H02 (los demás casos viven en
   context-reuse.test.cjs y teams-packets.test.cjs).
   Todo es fixture determinista: el router, la base y los hashes son reales; NO hay host real.
   Lo que un host real (Cursor / Claude Code) haga con estas respuestas no se prueba aquí. */
const test = require('node:test');
const { SIN_DRIVER } = require('./helpers/db-real.cjs');
if (SIN_DRIVER) { test(require('node:path').basename(__filename) + ' (omitido: ' + SIN_DRIVER + ')', { skip: SIN_DRIVER }, () => {}); return; }
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { proyecto, REPO } = require('./helpers/memoria-proyecto.cjs');
const G = path.join(REPO, '.agentic', 'grafo');
const router = require(path.join(G, 'effort-router.cjs'));
const budget = require(path.join(G, 'effort-budget.cjs'));
const usage = require(path.join(G, 'context-usage.cjs'));

const nuevo = (nombre) => {
  const p = proyecto(nombre);
  fs.writeFileSync(path.join(p.root, 'package.json'), JSON.stringify({ name: 'fx', version: '1.0.0' }));
  return p;
};
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

test('[prueba 1] un cambio de texto local usa LOW: sin investigación global ni delegación innecesaria, y sin perder guardias', () => {
  const p = nuevo('low');
  try {
    const d = router.decidirYGuardar(p.root, { task_id: 'txt-1', intent: 'cambia el texto del botón Guardar a Enviar', paths: ['src/components/Boton.tsx'], index_coverage: 'COMPLETE' });
    assert.equal(d.tier, 'LOW');
    assert.deepEqual(d.required_roles, ['builder'], 'LOW solo pide builder');
    // No investiga globalmente...
    const g = budget.permitirAccion(p.root, 'txt-1', 'busqueda_global');
    assert.equal(g.ok, false);
    assert.equal(g.code, 'TIER_LOW_SIN_INVESTIGACION_GLOBAL');
    // ...ni delega a quien su política no pide...
    const del = budget.permitirAccion(p.root, 'txt-1', 'delegacion', { rol: 'analyst' });
    assert.equal(del.ok, false);
    assert.equal(del.code, 'DELEGACION_INNECESARIA');
    assert.equal(budget.permitirAccion(p.root, 'txt-1', 'delegacion', { rol: 'builder' }).ok, true);
    // ...pero leer lo que hace falta NUNCA se niega (ni el archivo en alcance ni uno de fuera para reparar).
    assert.equal(budget.permitirAccion(p.root, 'txt-1', 'lectura', { path: 'src/components/Boton.tsx' }).ok, true);
    const fuera = budget.permitirAccion(p.root, 'txt-1', 'lectura', { path: 'src/otra/cosa.ts', reparacion: true });
    assert.equal(fuera.ok, true);
    assert.equal(budget.permitirAccion(p.root, 'txt-1', 'lectura', { path: 'src/otra/cosa.ts' }).aviso, 'FUERA_DEL_ALCANCE_DECLARADO', 'se permite pero avisa');
    // Ahorrar no quita seguridad, archivos protegidos, scope ni leases.
    assert.equal(budget.guardiasCriticas(d).ok, true);
    for (const g2 of ['scope', 'protected-files', 'security', 'leases']) assert.ok(d.required_gates.includes(g2), g2);
  } finally { p.limpiar(); }
});

test('[prueba 2] dos líneas en auth o migración mantienen HIGH aunque el título diga "cambio pequeño"', () => {
  const p = nuevo('high');
  try {
    const a = router.decidirYGuardar(p.root, { task_id: 'auth-2l', intent: 'cambio pequeño: ajusta dos líneas de la verificación de permisos', paths: ['src/middleware/permisos.ts'], change_type: 'LOCAL_TEXT_CHANGE', requested_tier: 'LOW' });
    assert.equal(a.tier, 'HIGH');
    assert.equal(a.risk, 'HIGH');
    assert.equal(a.requested_tier_rejected, 'MIN_SEGURIDAD');
    assert.ok(a.required_roles.includes('reviewer'));
    const m = router.decidirYGuardar(p.root, { task_id: 'mig-2l', intent: 'cambio mínimo, solo dos líneas en la migración de la columna', paths: ['db/migrations/0042_add_col.sql'] });
    assert.equal(m.tier, 'HIGH');
    // Las guardias valen igual en HIGH y no se perdieron al "ahorrar".
    assert.equal(budget.guardiasCriticas(a).ok, true);
    // Y acotar el alcance JAMÁS baja de ese piso.
    assert.equal(budget.acotarAlcance(p.root, 'auth-2l', 'solo dos líneas').decision.tier, 'HIGH');
    // Una tarea que parece LOW pero descubre rutas de riesgo alto sube a HIGH.
    router.decidirYGuardar(p.root, { task_id: 'sube-1', intent: 'cambia el texto del título', paths: ['src/a.html'], index_coverage: 'COMPLETE' });
    const s = budget.evaluarSenales(p.root, 'sube-1', { paths: ['src/auth/login.ts'], intent: 'además toca el login' });
    assert.equal(s.tier, 'HIGH');
    assert.equal(s.cambios[0].evento, 'RISK_DISCOVERED');
  } finally { p.limpiar(); }
});

test('[prueba 3] recuperar detalle/original afecta el presupuesto ACUMULADO (en el router y en el registro de uso)', () => {
  const p = nuevo('acum');
  try {
    router.decidirYGuardar(p.root, { task_id: 'acum-1', intent: 'cambia el texto del título', paths: ['src/a.html'], index_coverage: 'COMPLETE' });
    const r1 = budget.registrar(p.root, 'acum-1', { kind: 'context_pack', role: 'builder', delivered_bytes: 2000, original_bytes: 2000 });
    assert.equal(r1.ok, true);
    assert.equal(r1.persistencia.detalle_en_base, 'OK');
    budget.registrar(p.root, 'acum-1', { kind: 'recall_detail', role: 'builder', recovered_bytes: 3000, original_bytes: 3000 });
    const r3 = budget.registrar(p.root, 'acum-1', { kind: 'evidence_retrieval', role: 'builder', recovered_bytes: 4000, original_bytes: 4000 });
    assert.equal(r3.uso.context_bytes, 9000, 'lo recuperado también se entregó al modelo');
    assert.equal(r3.uso.retrieved_bytes, 7000);
    assert.equal(r3.uso.retrievals, 2);
    assert.equal(r3.uso.tool_calls, 2, 'cada recuperación gasta una llamada');
    assert.equal(r3.status, 'OK');
    // El registro durable coincide con el contador del router (no son dos verdades).
    const acum = usage.acumulado(p.root, 'acum-1');
    assert.equal(acum.recovered_bytes, 7000);
    assert.equal(acum.by_kind.recall_detail.recovered_bytes, 3000);
    assert.equal(acum.total_delivered_bytes, 9000);
    // Otra recuperación cruza el límite blando de LOW (12 000 B): se reevalúa, no se corta.
    const r4 = budget.registrar(p.root, 'acum-1', { kind: 'evidence_retrieval', role: 'builder', recovered_bytes: 4000 });
    assert.equal(r4.status, 'REEVALUAR');
    assert.equal(r4.reason_code, 'SOFT_LIMIT');
    const e = budget.estado(p.root, 'acum-1');
    assert.equal(e.reevaluacion_pendiente, true);
    assert.equal(e.restante_blando.context_bytes, 0);
  } finally { p.limpiar(); }
});

test('[prueba 4] cambiar de rol NO reinicia los límites: el presupuesto es de la tarea', () => {
  const p = nuevo('roles');
  try {
    router.decidirYGuardar(p.root, { task_id: 'roles-1', intent: 'cambia el texto del título', paths: ['src/a.html'], index_coverage: 'COMPLETE' });
    // Ningún rol por separado pasa de 12 000 B (límite LOW), pero juntos sí.
    assert.equal(budget.registrar(p.root, 'roles-1', { kind: 'context_pack', role: 'analyst', delivered_bytes: 5000 }).status, 'OK');
    assert.equal(budget.registrar(p.root, 'roles-1', { kind: 'recall_detail', role: 'builder', recovered_bytes: 5000 }).status, 'OK');
    const r = budget.registrar(p.root, 'roles-1', { kind: 'context_pack', role: 'qa', delivered_bytes: 5000 });
    assert.equal(r.status, 'REEVALUAR', 'el tercer rol ve el total acumulado, no un contador propio');
    const e = budget.estado(p.root, 'roles-1');
    assert.equal(e.uso.context_bytes, 15000);
    assert.deepEqual(Object.keys(e.por_rol).sort(), ['analyst', 'builder', 'qa']);
    assert.equal(e.por_rol.analyst.context_bytes, 5000, 'el desglose informa, no mide');
    // Pedir "otro recall" tampoco lo reinicia.
    assert.equal(budget.registrar(p.root, 'roles-1', { kind: 'recall_index', role: 'builder', delivered_bytes: 100 }).status, 'REEVALUAR');
  } finally { p.limpiar(); }
});

test('límite blando = reevaluación DOCUMENTADA; límite duro del usuario = checkpoint y pendientes, nunca completada', () => {
  const p = nuevo('limites');
  try {
    router.decidirYGuardar(p.root, { task_id: 'lim-1', intent: 'refactoriza el módulo de reportes', paths: ['src/reportes/a.ts'], user_limits: { max_tool_calls: 40 } });
    const mucho = budget.registrar(p.root, 'lim-1', { kind: 'tool_call', role: 'builder', delivered_bytes: 100, duration_ms: 10 });
    assert.equal(mucho.status, 'OK');
    for (let i = 0; i < 24; i++) budget.registrar(p.root, 'lim-1', { kind: 'tool_call', role: 'builder' });
    assert.equal(budget.registrar(p.root, 'lim-1', { kind: 'tool_call', role: 'builder' }).status, 'REEVALUAR', 'pasó el límite blando de MEDIUM (24 llamadas)');
    // Sin necesidad y riesgo escritos no hay reevaluación.
    assert.equal(budget.reevaluarDocumentado(p.root, 'lim-1', { decision: 'CONTINUAR' }).reason_code, 'FALTA_NECESIDAD_O_RIESGO');
    const ok = budget.reevaluarDocumentado(p.root, 'lim-1', { decision: 'CONTINUAR', necesidad: 'faltan los tests de reportes', riesgo: 'bajo: módulo aislado' });
    assert.equal(ok.ok, true);
    assert.equal(budget.estado(p.root, 'lim-1').reevaluaciones, 1);
    assert.equal(budget.registrar(p.root, 'lim-1', { kind: 'tool_call', role: 'builder' }).status, 'OK', 'la reevaluación abre otra ventana blanda');
    // El límite duro del usuario NO se mueve con ninguna reevaluación.
    let st;
    for (let i = 0; i < 20; i++) st = budget.registrar(p.root, 'lim-1', { kind: 'tool_call', role: 'builder' });
    assert.equal(st.status, 'CHECKPOINT');
    assert.equal(st.reason_code, 'USER_HARD_LIMIT');
    assert.equal(st.completed, false);
    const cierre = router.cerrar(p.root, 'lim-1', { ok: true });
    assert.equal(cierre.ok, false);
    assert.equal(cierre.estado, 'PENDIENTE');
    assert.equal(budget.permitirAccion(p.root, 'lim-1', 'busqueda_global').code, 'CHECKPOINT_LIMITE_DURO', 'tras el límite duro no se sigue gastando');
    // CERRAR_PARCIAL también queda pendiente, no completada.
    router.decidirYGuardar(p.root, { task_id: 'lim-2', intent: 'refactoriza el módulo de pagos de reportes', paths: ['src/reportes/b.ts'] });
    const parcial = budget.reevaluarDocumentado(p.root, 'lim-2', { decision: 'CERRAR_PARCIAL', necesidad: 'falta el módulo B', riesgo: 'medio' });
    assert.equal(parcial.estado, 'PENDIENTE');
    assert.equal(router.cerrar(p.root, 'lim-2', { ok: true }).reason_code, 'REEVALUACION_PARCIAL');
  } finally { p.limpiar(); }
});

test('escalado: fallo repetido, dependencia, impacto y criterio ambiguo suben un escalón; más reparaciones que la política obligan a reevaluar', () => {
  const p = nuevo('escala');
  try {
    router.decidirYGuardar(p.root, { task_id: 'esc-1', intent: 'arregla el bug del total del carrito', paths: ['src/cart/total.ts'], index_coverage: 'COMPLETE' });
    const s = budget.evaluarSenales(p.root, 'esc-1', { repeated_failure: 'mismo test falla dos veces' });
    assert.equal(s.tier, 'HIGH', 'MEDIUM → HIGH');
    router.decidirYGuardar(p.root, { task_id: 'esc-2', intent: 'cambia el texto del título', paths: ['src/a.html'], index_coverage: 'COMPLETE' });
    assert.equal(budget.evaluarSenales(p.root, 'esc-2', { unexpected_dependency: true, ambiguous_criteria: true }).tier, 'HIGH', 'LOW → MEDIUM → HIGH');
    // Reparaciones: LOW permite 1; la segunda ya es "fallo repetido" y se reevalúa.
    router.decidirYGuardar(p.root, { task_id: 'esc-3', intent: 'cambia el texto del título', paths: ['src/a.html'], index_coverage: 'COMPLETE' });
    assert.equal(budget.registrar(p.root, 'esc-3', { kind: 'repair', role: 'builder' }).status, 'OK');
    const r = budget.registrar(p.root, 'esc-3', { kind: 'repair', role: 'builder' });
    assert.equal(r.status, 'REEVALUAR');
    assert.equal(r.reason_code, 'REPAIR_LIMIT');
  } finally { p.limpiar(); }
});

test('herramientas del host fuera de Agentix: "no observadas", nunca un 0 que parezca prueba', () => {
  const p = nuevo('host');
  try {
    router.decidirYGuardar(p.root, { task_id: 'host-1', intent: 'cambia el texto del título', paths: ['src/a.html'], index_coverage: 'COMPLETE' });
    const antes = budget.estado(p.root, 'host-1');
    assert.equal(antes.cobertura.alcance, 'SOLO_LO_QUE_PASA_POR_AGENTIX');
    assert.match(antes.cobertura.nota, /no prueba que no se usaron/);
    const r = budget.registrarNoObservado(p.root, 'host-1', { role: 'builder', detail: 'el host abrió el terminal sin pasar por Agentix' });
    assert.equal(r.ok, true);
    assert.equal(r.uso.context_bytes, 0, 'no consume presupuesto de contexto');
    assert.equal(r.uso.host_unobserved, 1);
    const e = budget.estado(p.root, 'host-1');
    assert.equal(e.cobertura.herramientas_host_no_observadas, 1);
    assert.deepEqual(e.medicion.unobserved, ['host_tool'], 'el registro durable lo marca no observado');
    assert.equal(e.medicion.calls, 0, 'y no lo cuenta entre las llamadas observadas');
    // Una tarea sin decisión no tiene "0": no hay dato.
    assert.equal(budget.estado(p.root, 'no-existe').disponible, false);
    assert.equal(budget.resumenParaPaquete(p.root, 'no-existe').disponible, false);
  } finally { p.limpiar(); }
});

test('latido ≠ progreso; el progreso se demuestra; sin progreso → REVISIÓN, no trabajo inventado', () => {
  const p = nuevo('progreso');
  try {
    router.decidirYGuardar(p.root, { task_id: 'prog-1', intent: 'cambia el texto del título', paths: ['src/a.html'], index_coverage: 'COMPLETE' });
    for (let i = 0; i < 3; i++) assert.equal(budget.registrar(p.root, 'prog-1', { kind: 'heartbeat', role: 'builder' }).reason_code, 'HEARTBEAT_IGNORADO');
    let e = budget.estado(p.root, 'prog-1');
    assert.equal(e.heartbeats_ignorados, 3);
    assert.equal(e.ultimo_actividad_at, null, 'un latido no es actividad');
    assert.equal(e.ultimo_progreso_at, null);
    assert.equal(e.uso.tool_calls, 0);
    // "Voy por el 80 %" sin evidencia no es progreso: queda anotado como error de progreso.
    const sin = budget.declararProgreso(p.root, 'prog-1', { afirmacion: 'voy por el 80 %', role: 'builder' });
    assert.equal(sin.code, 'PROGRESO_NO_DEMOSTRADO');
    assert.equal(budget.estado(p.root, 'prog-1').errores_progreso, 1);
    // Con evidencia verificable sí: un archivo cuyo hash coincide.
    fs.mkdirSync(path.join(p.root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(p.root, 'src', 'a.html'), '<h1>Hola</h1>');
    const falsa = budget.declararProgreso(p.root, 'prog-1', { afirmacion: 'cambié a.html', evidencia: [{ tipo: 'file_hash', path: 'src/a.html', sha256: sha('otro contenido') }] });
    assert.equal(falsa.ok, false, 'un hash que no coincide no demuestra nada');
    const ok = budget.declararProgreso(p.root, 'prog-1', { afirmacion: 'cambié a.html', role: 'builder', evidencia: [{ tipo: 'file_hash', path: 'src/a.html', sha256: sha('<h1>Hola</h1>') }] });
    assert.equal(ok.ok, true);
    e = budget.estado(p.root, 'prog-1');
    assert.ok(e.ultimo_progreso_at);
    // Pasa el tiempo sin progreso: se dispara una REVISIÓN (una vez por ventana) y nada más.
    const futuro = Date.now() + 60 * 60 * 1000;
    const a = budget.sinProgreso(p.root, 'prog-1', { ahora: futuro });
    assert.equal(a.sin_progreso, true);
    assert.equal(a.accion, 'REVISAR_ESTADO');
    assert.equal(a.ya_anotada, false);
    assert.equal(budget.sinProgreso(p.root, 'prog-1', { ahora: futuro + 1000 }).ya_anotada, true, 'no se repite en la misma ventana');
    const hist = router.leer(p.root, 'prog-1').historial.filter((x) => x.evento === 'REVISION_SIN_PROGRESO');
    assert.equal(hist.length, 1);
    assert.equal(router.leer(p.root, 'prog-1').decision.tier, 'LOW', 'el tiempo no escala ni crea tareas');
    assert.equal(budget.sinProgreso(p.root, 'prog-1', { ahora: Date.now() }).sin_progreso, false);
  } finally { p.limpiar(); }
});

test('[prueba 12] límites del host y errores de progreso quedan registrados; no se certifica autonomía con un test de estado', () => {
  const p = nuevo('limiteshost');
  try {
    router.decidirYGuardar(p.root, { task_id: 'lh-1', intent: 'cambia el texto del título', paths: ['src/a.html'], index_coverage: 'COMPLETE' });
    budget.registrarNoObservado(p.root, 'lh-1', { role: 'builder' });
    budget.declararProgreso(p.root, 'lh-1', { afirmacion: 'casi listo' });
    const l = budget.limitesHost(p.root, 'lh-1');
    assert.equal(l.provider_capability, 'HOST_NATIVE_UNCONTROLLED');
    assert.equal(l.can_set_reasoning, false);
    assert.equal(l.host_effort, 'no_controlable');
    assert.equal(l.autonomia_host, 'NO_VERIFICADA', 'ningún dato de estado certifica la autonomía de un host');
    assert.ok(l.no_controla.some((x) => /razonamiento interno/.test(x)));
    assert.equal(l.herramientas_host_no_observadas, 1);
    assert.equal(l.errores_progreso, 1);
    // La decisión del router también declara lo mismo.
    assert.equal(router.leer(p.root, 'lh-1').decision.provider_capability, 'HOST_NATIVE_UNCONTROLLED');
  } finally { p.limpiar(); }
});

test('capacidad del proveedor: solo declarativa; PROVIDER_EFFORT_CONTROLLED exige validación explícita por proyecto', () => {
  const p = nuevo('proveedor');
  try {
    const cfg = path.join(p.root, '.agentic', 'effort-provider.json');
    assert.equal(router.capacidadProveedor(p.root).capability, 'HOST_NATIVE_UNCONTROLLED');
    fs.writeFileSync(cfg, JSON.stringify({ capability: 'CONTEXT_CONTROLLED' }));
    assert.deepEqual([router.capacidadProveedor(p.root).capability, router.capacidadProveedor(p.root).can_set_reasoning], ['CONTEXT_CONTROLLED', false]);
    // Sin validar, la capacidad fuerte se degrada: una promesa no es un control.
    fs.writeFileSync(cfg, JSON.stringify({ capability: 'PROVIDER_EFFORT_CONTROLLED' }));
    const sinValidar = router.capacidadProveedor(p.root);
    assert.equal(sinValidar.capability, 'CONTEXT_CONTROLLED');
    assert.equal(sinValidar.degradada_de, 'PROVIDER_EFFORT_CONTROLLED');
    fs.writeFileSync(cfg, JSON.stringify({ capability: 'PROVIDER_EFFORT_CONTROLLED', validated: true, validated_at: '2026-10-03T00:00:00Z' }));
    const valida = router.capacidadProveedor(p.root);
    assert.deepEqual([valida.capability, valida.can_set_reasoning, valida.project_scoped], ['PROVIDER_EFFORT_CONTROLLED', true, true]);
    assert.equal(router.decidir({ intent: 'cambia el texto', paths: ['a.html'] }, { root: p.root }).host_effort, 'controlado_por_proveedor');
    // Una capacidad inventada se ignora.
    fs.writeFileSync(cfg, JSON.stringify({ capability: 'MAGIA_TOTAL' }));
    assert.equal(router.capacidadProveedor(p.root).capability, 'HOST_NATIVE_UNCONTROLLED');
    assert.ok(router.capacidadProveedor(p.root).error);
  } finally { p.limpiar(); }
});

test('compatibilidad: un estado escrito por la versión anterior (solo context_bytes y tool_calls) se sigue consumiendo', () => {
  const p = nuevo('compat');
  try {
    router.decidirYGuardar(p.root, { task_id: 'viejo-1', intent: 'cambia el texto del título', paths: ['src/a.html'], index_coverage: 'COMPLETE' });
    const f = path.join(p.root, '.agentic', '_effort', 'viejo-1.json');
    const e = JSON.parse(fs.readFileSync(f, 'utf8'));
    e.uso = { context_bytes: 100, tool_calls: 2 };
    delete e.por_rol;
    fs.writeFileSync(f, JSON.stringify(e));
    const r = router.consumir(p.root, 'viejo-1', { context_bytes: 50, tool_calls: 1 });
    assert.equal(r.status, 'OK');
    assert.equal(r.uso.context_bytes, 150);
    assert.equal(r.uso.tool_calls, 3);
    assert.equal(r.uso.retrieved_bytes, 0, 'contadores nuevos rellenados');
  } finally { p.limpiar(); }
});

test('context-pack cuenta lo que entrega en el presupuesto acumulado, también al reutilizarse', async () => {
  const p = nuevo('ctxpack');
  try {
    fs.mkdirSync(path.join(p.root, 'src'));
    fs.writeFileSync(path.join(p.root, 'src', 'a.html'), '<h1>Hola</h1>');
    const cp = require(path.join(G, 'context-pack.cjs'));
    const e = { task_id: 'cp-1', objetivo: 'cambia el texto del título a Bienvenido', aceptacion: ['dice Bienvenido'], paths: ['src/a.html'], rol: 'builder' };
    const p1 = await cp.armar(p.root, e);
    assert.equal(p1.reutilizado, false);
    assert.equal(p1.presupuesto.status, 'OK');
    const p2 = await cp.armar(p.root, e);
    assert.equal(p2.reutilizado, true);
    const est = budget.estado(p.root, 'cp-1');
    assert.equal(est.uso.context_bytes, p1.bytes + p2.bytes, 'cada entrega cuenta aunque no se re-enriquezca');
    assert.equal(est.por_rol.builder.context_bytes, p1.bytes + p2.bytes);
  } finally { p.limpiar(); }
});
