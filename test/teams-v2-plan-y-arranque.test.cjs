'use strict';

/**
 * TEAMS v2 — activación, esquema, plan, incorporación del constructor y arranque (T01, T02, T03, T24 parcial, T26 parcial).
 * Nivel A: mecanismo determinista. Nivel B: la prueba de `ejecutar` usa un constructor SIMULADO con verificador real.
 * El nivel C (Claude Code + Cursor reales) NO se ejecuta aquí.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/teams-v2.cjs');
const { tm, bld, corr, G } = H;
const dba = require(path.join(G, 'db-adapter.cjs'));
const { verificadorReal } = require(path.join(G, 'teams-verificador.cjs'));

test('[A][T01] activar es idempotente: repetirlo y conectar al constructor no tocan session_generation; reconfigurar es explícito', () => {
  const root = H.proyecto();
  const a = H.activar(root);
  assert.equal(a.session_generation, 1);
  const otra = tm.init(root, { aprobarMigracion: true });
  assert.equal(otra.status, 'ACTIVO');
  assert.equal(otra.idempotente, true);
  assert.equal(otra.session_generation, 1, 'repetir activar no invalida la sesión');
  const c = bld.conectar(root, { session_id: 'ses-cursor-aaaa', proyecto: root });
  assert.equal(c.status, 'BUILDER_CONECTADO');
  assert.equal(c.session_generation, 1, 'incorporar al constructor NO es otro activar');
  assert.equal(tm.estado(root).session_generation, 1);
  assert.equal(tm.init(root, { aprobarMigracion: true }).session_generation, 1, 'activar después de conectar tampoco cambia la generación');
  assert.equal(tm.estado(root).builder.session_id, 'ses-cursor-aaaa', 'y la incorporación sigue en pie');
  const cambio = tm.init(root, { aprobarMigracion: true, roles: { builder: { host: 'claude-code' } }, mismoHost: true });
  assert.equal(cambio.status, 'RECONFIGURACION_REQUIERE_TRANSICION', 'otros roles = transición explícita');
  tm.crearPlan(root, { objective: 'o', sprints: [{ tasks: [H.tarea('A')] }] });
  const b = H.constructor(root);
  H.paso(root, b);
  assert.equal(tm.init(root, { aprobarMigracion: true, reconfigurar: true, roles: { builder: { host: 'claude-code' } }, mismoHost: true }).status, 'TAREAS_ACTIVAS', 'con tareas en vuelo no se reconfigura');
  tm.desactivar(root);
  assert.equal(H.activar(root).session_generation, 2, 'reactivar tras desactivar sí es explícito y sube la generación');
});

test('[A][T01][T24] una base v1 no se migra al leer: lo nuevo pide MIGRACION_PENDIENTE y --aprobar-migracion la lleva a v2 conservando lo anterior', () => {
  const root = H.proyecto();
  const dbp = path.join(root, '.agentic', 'memoria.db');
  dba.migrate(dbp, { statements: tm.SCHEMA_V1, run: (db) => db.run("INSERT OR REPLACE INTO teams_meta (key, value) VALUES ('schema_version', '1')") });
  const w = dba.openWrite(dbp);
  w.run('INSERT INTO teams_sessions (id, enabled, paused, session_generation, project_id, roles, updated_at) VALUES (1, 1, 0, 1, ?, ?, ?)', 'p', JSON.stringify({ director: { host: 'claude-code' }, builder: { host: 'cursor' } }), new Date().toISOString());
  w.close();
  assert.equal(tm.versionEsquema(root), 'V1');
  const plan = tm.crearPlan(root, { id: 'P-V1', objective: 'plan de la era v1', sprints: [{ tasks: [H.tarea('A')] }] });
  assert.equal(plan.status, 'PLAN_GUARDADO', 'el esquema v1 sigue funcionando');
  const e = tm.estado(root);
  assert.equal(e.esquema, 'V1');
  assert.equal(e.v2, false);
  assert.match(e.nota, /aprobar-migracion/);
  assert.equal(tm.versionEsquema(root), 'V1', 'leer el estado no migra');
  assert.throws(() => corr.añadir(root, { severity: 'HALLAZGO', criterion: 'x', acceptance: 'y', proposal: 'z', location: 'src/a.js:1' }), (err) => err.code === 'MIGRACION_PENDIENTE');
  assert.equal(tm.versionEsquema(root), 'V1', 'ni una escritura nueva migra a escondidas');
  assert.equal(tm.init(root).status, 'MIGRACION_PENDIENTE');
  assert.equal(tm.versionEsquema(root), 'V1');
  const m = tm.init(root, { aprobarMigracion: true });
  assert.equal(m.status, 'ACTIVO');
  assert.equal(m.idempotente, true, 'la sesión v1 ya activa no se invalida al migrar');
  assert.equal(m.session_generation, 1);
  assert.equal(m.migracion.desde, 'V1');
  assert.ok(fs.existsSync(m.migracion.respaldo), 'respaldo previo a la migración');
  assert.equal(tm.versionEsquema(root), 'V2');
  assert.equal(tm.estado(root).tareas.length, 1, 'el plan v1 se conserva');
  const b = H.constructor(root);
  const log = H.paso(root, b);
  assert.equal(log.find((x) => x.paso === 'resultado').status, 'VERIFICANDO', 'una tarea nacida en v1 se entrega después de migrar');
});

test('[A][T02] plan: sprints → fases → tareas con criterios de revisión, referencias del dueño y primer lote antes de arrancar', () => {
  const root = H.proyecto();
  H.activar(root);
  const malo = tm.crearPlan(root, { objective: 'o', referencias: ['javascript:alert(1)', 'https://ok.example.com/doc'], sprints: [{ tasks: [H.tarea('A')] }] });
  assert.equal(malo.status, 'PLAN_INVALIDO');
  assert.ok(malo.errores.some((x) => x.code === 'REFERENCIA_INVALIDA'), 'solo http/https: otra cosa no es una referencia');
  assert.equal(tm.crearPlan(root, { objective: 'o', sprints: [{ tasks: [H.tarea('A', { criterios_de_revision: 'no es lista' })] }] }).status, 'PLAN_INVALIDO');
  const p = tm.crearPlan(root, H.planSecuencial());
  assert.equal(p.status, 'PLAN_GUARDADO');
  assert.deepEqual(p.primer_lote, ['A'], 'el primer lote existe al guardar, antes de arrancar a nadie');
  assert.equal(p.referencias, 1);
  const e = tm.estado(root);
  assert.deepEqual(e.referencias, [{ url: 'https://example.com/spec', nota: 'spec del dueño', revision: 1, descargada: false }], 'se guardan; descargarlas no es trabajo del plan');
  const porId = Object.fromEntries(e.tareas.map((t) => [t.id, t]));
  assert.equal(porId.A.fase, 'F1');
  assert.equal(porId.B.fase, 'F2');
  assert.equal(porId.C.fase, 'F1', 'una tarea plana también declara su fase');
  assert.equal(porId.B.state, 'PENDING', 'B espera a A: no hay "primer lote" con dependencias sin satisfacer');
  const r = tm.revisarPlan(root, { agregar: [H.tarea('D', { depends_on: ['C'] })], referencias: ['https://example.com/nueva'], motivo: 'alcance ampliado' });
  assert.equal(r.status, 'PLAN_REVISADO');
  assert.equal(r.revision, 2, 'un cambio de plan es una revisión con delta');
  assert.equal(tm.estado(root).plan.revision, 2);
  assert.equal(tm.estado(root).referencias.length, 2);
  assert.equal(tm.revisarPlan(root, { agregar: [H.tarea('D')] }).status, 'PLAN_INVALIDO', 'un id existente no se reemplaza en silencio');
  const b = H.constructor(root);
  H.paso(root, b);
  assert.equal(tm.revisarPlan(root, { cancelar: ['A'] }).status, 'TAREA_YA_ACEPTADA', 'lo aceptado/en curso no se cancela por la puerta de atrás');
  assert.equal(tm.revisarPlan(root, { cancelar: ['D'] }).status, 'PLAN_REVISADO');
  assert.equal(tm.leerTarea(root, 'D').state, 'CANCELLED');
});

test('[A][T03] ejecutar valida primer lote + incorporación + vigilancia + verificador antes de correr y no duplica la ejecución', () => {
  const root = H.proyecto();
  H.activar(root);
  const sinPlan = bld.ejecutar(root, {});
  assert.equal(sinPlan.status, 'NO_LISTO');
  assert.ok(sinPlan.faltan.some((f) => f.code === 'SIN_PLAN'));
  tm.crearPlan(root, { objective: 'rota', sprints: [{ tasks: [H.tarea('A', { depends_on: ['NO_EXISTE'] })] }] });
  const sinLote = bld.ejecutar(root, {});
  assert.ok(sinLote.faltan.some((f) => f.code === 'SIN_PRIMER_LOTE'), 'sin tareas listas no se arranca al constructor');
  const root2 = H.proyecto();
  H.activar(root2);
  tm.crearPlan(root2, H.planSecuencial());
  const sinBuilder = bld.ejecutar(root2, {});
  assert.ok(sinBuilder.faltan.some((f) => f.code === 'BUILDER_NO_CONECTADO'));
  assert.equal(sinBuilder.pasos, undefined, 'validar no corre nada');
  assert.equal(bld.conectar(root2, { session_id: 'ses-cursor-aaaa', proyecto: root2 }).state, 'CONECTADO');
  assert.ok(bld.ejecutar(root2, {}).faltan.some((f) => f.code === 'BUILDER_NO_LISTO'), 'conectado no es listo: falta el READY de arranque');
  assert.equal(tm.estado(root2).tareas.find((t) => t.id === 'A').state, 'READY', 'nada se asignó al validar');
  const ready = bld.listo(root2, { session_id: 'ses-cursor-aaaa', loop: 'no', watch: 'no' });
  assert.equal(ready.vigilancia.modo, 'MANUAL_ONLY');
  const b = H.constructor(root2);
  const corrida = bld.ejecutar(root2, { adapters: b });
  assert.equal(corrida.status, 'EJECUTANDO');
  assert.equal(corrida.verificador, 'REAL');
  assert.equal(corrida.modo.autonomia, 'MANUAL_ONLY', 'sin loop ni watch no se anuncia autonomía');
  assert.ok(corrida.advertencias.some((x) => x.code === 'VIGILANCIA_MANUAL_ONLY'));
  assert.ok(corrida.advertencias.some((x) => x.code === 'REVISOR_NO_REGISTRADO'));
  const otra = bld.ejecutar(root2, { adapters: b });
  assert.equal(otra.run_id, corrida.run_id);
  assert.equal(otra.ya_en_ejecucion, true, 'repetir ejecutar reconoce la ejecución existente');
  assert.equal(tm.estado(root2).ejecucion.ticks, 2);
});

test('[B][T03] run con verificador REAL: los gates con comprobador mecánico dan PASS con evidencia; los que no, UNVERIFIED y nunca un PASS inventado', () => {
  const root = H.proyecto();
  H.activar(root);
  tm.crearPlan(root, { objective: 'real', sprints: [{ tasks: [H.tarea('A')] }] });
  bld.conectar(root, { session_id: 'ses-cursor-aaaa', proyecto: root, listo: true, loop: true, watch: true });
  const b = H.constructor(root);
  const sin = bld.ejecutar(root, { adapters: b });
  const ver = sin.pasos.find((p) => p.paso === 'verificar');
  assert.equal(ver.status, 'SIN_EVIDENCIA_SUFICIENTE', 'sin comprobador para preservation el director no cierra solo');
  assert.ok(ver.faltan.includes('preservation'), 'lo que falta se dice: ' + JSON.stringify(ver.faltan));
  assert.ok(!ver.faltan.includes('protected-files') && !ver.faltan.includes('security') && !ver.faltan.includes('relevant-check'), 'protected-files, security y las pruebas sí se comprobaron de verdad');
  assert.equal(tm.leerTarea(root, 'A').state, 'VERIFYING');
  /* El punto de extensión del verificador: un comprobador propio por gate (aquí, uno de laboratorio) pasa por la misma ruta de evidencia. */
  const v = verificadorReal(root, { extra: { preservation: () => ({ status: 'PASS', assertions: 1 }), 'test-integrity': () => ({ status: 'PASS', assertions: 1 }) } });
  const res = { task_id: 'A', event_id: 'x1', subject_hash: tm.leerTarea(root, 'A').subject_hash };
  const gates = v(res);
  assert.ok(gates.length >= 5 && gates.every((g) => g.status === 'PASS' && g.execution_id), 'cada PASS lleva su artefacto de ejecución: ' + JSON.stringify(gates.map((g) => [g.gate, g.status, g.reason_code])));
  assert.equal(tm.verificar(root, { task_id: 'A', event_id: 'ver-real-1', gates }).status, 'DONE_VERIFIED');
});

test('[A][T26] el constructor de otro proyecto o de otra sesión no se mezcla: proyecto distinto, sesión equivocada y protocolo desconocido', () => {
  const root = H.proyecto();
  const otro = H.proyecto();
  H.activar(root);
  assert.equal(bld.conectar(root, { session_id: 'ses-cursor-aaaa' }).status, 'FALTA_PROYECTO');
  assert.equal(bld.conectar(root, { session_id: 'ses-cursor-aaaa', proyecto: otro }).status, 'PROYECTO_DISTINTO', 'mismo nombre de proyecto en otra carpeta no se mezcla');
  assert.equal(bld.conectar(root, { session_id: 'x', proyecto: root }).status, 'SESSION_ID_INVALIDO');
  assert.equal(bld.conectar(root, { session_id: 'ses-cursor-aaaa', proyecto: root, protocolo: 'v9' }).status, 'PROTOCOLO_NO_SOPORTADO');
  assert.equal(bld.conectar(root, { session_id: 'ses-cursor-aaaa', proyecto: root }).status, 'BUILDER_CONECTADO');
  assert.equal(bld.listo(root, { session_id: 'ses-OTRA-sesion', loop: true, watch: true }).status, 'SESION_NO_REGISTRADA');
  const r = bld.conectar(root, { session_id: 'ses-cursor-bbbb', proyecto: root, listo: true, loop: true, watch: false });
  assert.equal(r.reconectado, true, 'otra sesión del mismo constructor es una reconexión explícita');
  assert.equal(r.vigilancia.modo, 'SOLO_LOOP');
  assert.equal(r.vigilancia.autonomia, 'EVENT_WAKE_UNSUPPORTED', 'sin watch se declara, no se oculta');
  assert.equal(tm.estado(root).builder.prev_session_id, 'ses-cursor-aaaa');
  assert.equal(tm.estado(otro).inicializado, false, 'el otro proyecto no recibió nada');
  const reg = JSON.parse(fs.readFileSync(path.join(root, '.legion', 'sesiones', 'builder.json'), 'utf8'));
  assert.equal(reg.session_id, 'ses-cursor-bbbb', 'la sesión también quedó en el canal MD, solo de este proyecto');
  assert.ok(!fs.existsSync(path.join(otro, '.legion')));
});
