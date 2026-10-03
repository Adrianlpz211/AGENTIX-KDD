'use strict';
/**
 * Panel TEAMS del dashboard (spec §11): construidas · auditadas · verificadas · REGISTRADAS por separado, cobertura
 * derivada del ledger del plan, vigilancia y auditoría; filtros origen/plan/sprint/fase/rol/corrección; dato faltante
 * = desconocido, nunca 0; ADITIVO (los grafos y su diseño no cambian).
 *
 * Qué prueba y con qué: proyectos temporales con una memoria.db REAL y el dashboard REAL arrancado como proceso.
 * Los cierres de los casos rápidos usan un ejecutor FIXTURE (nivel B); el caso T15 usa post-cycle REAL (nivel A).
 * Nada de aquí demuestra una campaña con Claude Code + Cursor reales (nivel C).
 */
const test = require('node:test');
const { SIN_DRIVER } = require('./helpers/db-real.cjs');
if (SIN_DRIVER) { test(require('node:path').basename(__filename) + ' (omitido: ' + SIN_DRIVER + ')', { skip: SIN_DRIVER }, () => {}); return; }
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { proyectoTeams, tareaBase, REPO } = require('./helpers/teams-proyecto.cjs');
const { arrancarDashboard } = require('./fixtures/dashboard-fixture.cjs');

const G = path.join(REPO, '.agentic', 'grafo');
const nucleo = require(path.join(G, 'teams-nucleo.cjs'));
const panel = require(path.join(G, 'teams-panel.cjs'));
const pagina = require(path.join(G, 'teams-pagina.cjs'));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const get = async (d, ruta, init) => { const r = await fetch(d.url.replace(/\/$/, '') + ruta, init); const texto = await r.text(); let json = null; try { json = JSON.parse(texto); } catch { /* no JSON */ } return { status: r.status, texto, json, headers: r.headers }; };

const TODO = [];
const limpiable = (p) => { TODO.push(p); return p; };
test.after(() => { for (const p of TODO) { try { p.limpiar(); } catch { /* en uso */ } } });

function ejecutorOk(p) {
  return (root, ev) => { const db = p.abrirW(); try { db.run("INSERT OR IGNORE INTO ciclos (ciclo_id, tarea, estado, area) VALUES (?, ?, 'COMPLETADO_VERIFICADO', 'x')", ev.cycle_id, 'tarea ' + ev.task_id); } finally { db.close(); } return { ok: true }; };
}
function entregar(p, owner, hash) {
  const asg = p.tm.asignar(p.root, { owner_id: owner });
  assert.equal(asg.status, 'ASIGNADA', JSON.stringify(asg));
  const a = p.tm.ack(p.root, { delivery_id: asg.assignment.delivery_id, owner_id: owner });
  const e = p.tm.entregarResultado(p.root, { event_id: 'res-' + asg.assignment.task.id, task_id: asg.assignment.task.id, owner_id: owner, fencing: asg.assignment.fencing, expected_revision: a.revision, subject_hash: hash, files: asg.assignment.task.allowed_files });
  assert.equal(e.status, 'VERIFICANDO', JSON.stringify(e));
  return { task_id: asg.assignment.task.id, hash, files: asg.assignment.task.allowed_files };
}

/** Campaña de prueba: 3 tareas en 2 sprints; 2 entregadas, 1 con informes, 1 verificada, 1 registrada en el núcleo. */
function campana(nombre) {
  const p = limpiable(proyectoTeams(nombre, { plan: false }));
  const c = p.tm.crearPlan(p.root, { objective: 'Plan <script>alert(1)</script> del dashboard', sprints: [
    { tasks: [tareaBase('A'), tareaBase('B')] }, { tasks: [tareaBase('C', ['src/C.js'], { depends_on: ['A'] })] },
  ] });
  assert.equal(c.status, 'PLAN_GUARDADO', JSON.stringify(c));
  p.plan_id = c.plan_id;
  return p;
}

// ───────────────────────────── datos del panel ───────────────────────────────

test('etapas por separado: construidas, auditadas, verificadas y REGISTRADAS no se mezclan', () => {
  const p = campana('etapas');
  const a = entregar(p, 'b1', 'hash-a-0001'); const b = entregar(p, 'b2', 'hash-b-0002');
  let r = panel.resumen(p.root, {});
  assert.equal(r.status, 'OK'); assert.equal(r.data.inicializado, true);
  assert.deepEqual(r.data.etapas.construidas, { n: 2, de: 3, desconocido: false });
  assert.deepEqual(r.data.etapas.verificadas, { n: 0, de: 3, desconocido: false }, 'medido: ninguna verificada todavía (0 REAL)');
  assert.deepEqual(r.data.etapas.registradas, { n: 0, de: 3, desconocido: false });
  // Un informe de revisor: auditada ≠ verificada ≠ registrada.
  const db = p.abrirW();
  try {
    db.run("INSERT INTO teams_reviews (role, scope_kind, task_id, subject_hash, verdict, event_id, created_at) VALUES ('frontend', 'TASK', 'A', 'hash-a-0001', 'PASS', 'r1', ?)", new Date().toISOString());
    db.run("UPDATE teams_tasks SET state = 'DONE_VERIFIED' WHERE id = 'B'");
  } finally { db.close(); }
  nucleo.registrarCierre(p.root, { plan_id: p.plan_id, task_id: a.task_id, attempt: 1, subject_hash: a.hash, files: a.files, area: 'src' }, { ejecutor: ejecutorOk(p) });
  r = panel.resumen(p.root, {});
  assert.equal(r.data.etapas.construidas.n, 2); assert.equal(r.data.etapas.auditadas.n, 1); assert.equal(r.data.etapas.verificadas.n, 1); assert.equal(r.data.etapas.registradas.n, 1);
  const porId = Object.fromEntries(r.data.tareas.map((t) => [t.id, t]));
  assert.deepEqual([porId.A.construida, porId.A.auditada, porId.A.verificada, porId.A.registrada], [true, true, false, 'REGISTRADO']);
  assert.deepEqual([porId.B.construida, porId.B.auditada, porId.B.verificada, porId.B.registrada], [true, false, true, 'NO_ENCOLADA'], 'verificada pero NO registrada: el panel lo muestra');
  assert.deepEqual([porId.C.construida, porId.C.auditada, porId.C.verificada], [false, false, false]);
  // Esperadas: 2 cierres de construcción (A, B) + 1 informe de revisor (frontend sobre A) = 3; registrada solo la construcción de A → 1/3.
  assert.equal(r.data.cobertura.cobertura_pct, 33.3); assert.equal(r.data.cobertura.por_categoria.revision.registradas, 0);
  assert.equal(r.data.memoria.listo_para_cierre, true);
  void b;
});

test('dato faltante = desconocido, nunca 0: sin TEAMS, sin tabla de revisiones, sin base de cierres', () => {
  const { proyecto } = require('./helpers/memoria-proyecto.cjs');
  const q = limpiable(proyecto('panel-sin-teams'));
  const s = panel.resumen(q.root, {});
  assert.equal(s.reason_code, 'SIN_TEAMS'); assert.equal(s.data.inicializado, false);
  for (const e of panel.ETAPAS) assert.deepEqual(s.data.etapas[e], { n: null, de: null, desconocido: true });
  assert.equal(s.data.cobertura, null);
  assert.equal(panel.resumen(path.join(q.root, 'no-existe'), {}).status, 'UNAVAILABLE');

  const p = campana('desconocido');
  entregar(p, 'b1', 'hash-a-0001');
  const db = p.abrirW(); try { db.exec('DROP TABLE teams_reviews'); } finally { db.close(); }
  const r = panel.resumen(p.root, {});
  assert.deepEqual(r.data.etapas.auditadas, { n: null, de: 3, desconocido: true }, 'sin la tabla de revisiones, «auditadas» es desconocido (no 0)');
  assert.equal(r.data.tareas[0].auditada, null);
  assert.equal(r.data.etapas.construidas.n, 1, 'lo demás se sigue midiendo');
  assert.ok(r.faltan.some((f) => f.startsWith('teams_reviews')));
  assert.equal(panel.vigilancia(p.root, {}).data.roles[0].host_acepta.atenciones, null, 'sin métricas: desconocido');
});

test('filtros: sprint, fase, rol, corrección y origen se aplican; el origen separa los ciclos de aa: y de teams:', () => {
  const p = campana('filtros');
  const db = p.abrirW();
  try {
    db.run("UPDATE teams_flow SET phase = 'F1' WHERE task_id IN ('A', 'B')");
    db.run("UPDATE teams_flow SET phase = 'F2' WHERE task_id = 'C'");
    db.run("INSERT INTO ciclos (ciclo_id, tarea, estado) VALUES ('aa-viejo-1', 'a mano con aa:', 'COMPLETADO_VERIFICADO')");
    for (const [id, origin, st] of [['F-1', 'frontend', 'OPEN'], ['F-2', 'backend', 'VERIFIED_RESOLVED'], ['F-3', 'frontend', 'REOPENED']]) {
      db.run("INSERT INTO teams_findings (id, task_id, severity, state, origin, event_id) VALUES (?, 'A', 'HIGH', ?, ?, ?)", id, st, origin, 'e-' + id);
    }
  } finally { db.close(); }
  const sid = panel.resumen(p.root, {}).data.tareas.find((t) => t.id === 'C').sprint_id;
  assert.deepEqual(panel.resumen(p.root, { sprint: sid }).data.tareas.map((t) => t.id), ['C']);
  assert.deepEqual(panel.resumen(p.root, { phase: 'F1' }).data.tareas.map((t) => t.id), ['A', 'B']);
  assert.equal(panel.resumen(p.root, { phase: 'F2' }).data.etapas.construidas.de, 1, 'los totales de las etapas siguen al filtro');
  // Rol → los hallazgos de ese origen; corrección → solo ese hallazgo.
  const f = panel.resumen(p.root, { role: 'frontend' }).data.correcciones;
  assert.equal(f.total, 2); assert.equal(f.abiertas, 2); assert.equal(f.reabiertas, 1);
  assert.deepEqual(panel.resumen(p.root, { correction: 'F-2' }).data.correcciones.items.map((x) => x.id), ['F-2']);
  assert.equal(panel.resumen(p.root, {}).data.correcciones.por_estado.VERIFIED_RESOLVED, 1);
  // Origen: mismo backend de ciclos.
  nucleo.registrarCierre(p.root, { plan_id: p.plan_id, task_id: 'A', attempt: 1, subject_hash: 'h-0001', files: ['src/A.js'] }, { ejecutor: ejecutorOk(p) });
  const t = panel.resumen(p.root, { origen: 'teams' }).data.ciclos; const a = panel.resumen(p.root, { origen: 'aa' }).data.ciclos; const todos = panel.resumen(p.root, {}).data.ciclos;
  assert.deepEqual([t.total, a.total, todos.total], [1, 1, 2]);
  assert.deepEqual(t.por_origen, { aa: 1, teams: 1 });
  // El plan se puede elegir (plan inexistente → sin tareas, no el último plan).
  assert.deepEqual(panel.resumen(p.root, { plan: 'otro-plan' }).data.tareas, []);
});

test('auditoría: por revisor, con sujeto exacto: un informe de un hash VIEJO no cuenta como revisado', () => {
  const p = campana('auditoria');
  entregar(p, 'b1', 'hash-nuevo-0002');
  const db = p.abrirW();
  try {
    db.run("INSERT INTO teams_reviewers (role, agent_id, modality, scope, coverage, registered_at) VALUES ('frontend', 'agente-front-1', 'SUBAGENTE', 'UI de A', 'interacción y visual', ?)", new Date().toISOString());
    db.run("INSERT INTO teams_reviewers (role, agent_id, modality, scope, coverage, registered_at) VALUES ('backend', NULL, 'SECUENCIAL', 'API', 'secuencial', ?)", new Date().toISOString());
    db.run("INSERT INTO teams_reviews (role, scope_kind, task_id, subject_hash, verdict, agent_id, event_id, created_at) VALUES ('frontend', 'TASK', 'A', 'hash-viejo-0001', 'PASS', 'agente-front-1', 'r1', ?)", '2026-10-03T10:00:00Z');
    db.run("INSERT INTO teams_reviews (role, scope_kind, task_id, subject_hash, verdict, agent_id, event_id, created_at) VALUES ('backend', 'TASK', 'A', 'hash-nuevo-0002', 'FAIL', NULL, 'r2', ?)", '2026-10-03T11:00:00Z');
  } finally { db.close(); }
  const a = panel.resumen(p.root, {}).data.auditoria;
  const por = Object.fromEntries(a.revisores.map((r) => [r.role, r]));
  assert.deepEqual([por.frontend.modality, por.frontend.agent_id, por.frontend.scope], ['SUBAGENTE', 'agente-front-1', 'UI de A']);
  assert.equal(por.frontend.pendientes, 1, 'el informe de hash-viejo no cubre el sujeto actual'); assert.deepEqual(por.frontend.tareas_pendientes, ['A']);
  assert.equal(por.backend.pendientes, 0); assert.equal(por.backend.ultimo.verdict, 'FAIL');
  assert.equal(por.negocio.registrado, false); assert.equal(por.negocio.informes, 0);
  assert.equal(por.frontend.ultimo.subject_hash, 'hash-viejo-0001');
  // Detalle paginado con filtros.
  const todos = panel.auditoria(p.root, {}, { limit: 1 });
  assert.equal(todos.coverage.total, 2); assert.equal(todos.coverage.truncated, true); assert.equal(todos.coverage.next_cursor, 1);
  assert.equal(panel.auditoria(p.root, { role: 'backend' }, {}).data.informes.length, 1);
  assert.equal(panel.auditoria(p.root, { correction: 'no-hay' }, {}).status, 'EMPTY');
});

test('vigilancia: viva / detecta / el host acepta / último progreso / loop y watch, sin consultar el sistema; lo declarado va aparte de lo observado', () => {
  const p = campana('vigilancia');
  const dir = path.join(p.root, '.agentic', '_teams');
  fs.mkdirSync(dir, { recursive: true });
  const db = p.abrirW();
  try { db.run("INSERT INTO teams_builder (id, session_id, host, state, watchers, project, connected_at, updated_at) VALUES (1, 'cursor-abc12345', 'cursor', 'READY', ?, ?, ?, ?)", JSON.stringify({ loop: true, watch: true }), p.root, new Date().toISOString(), new Date().toISOString()); } finally { db.close(); }
  // Sin latido: «sin proceso», no «0».
  let v = panel.vigilancia(p.root, {}).data.roles.find((r) => r.rol === 'builder');
  assert.equal(v.vivo.pid, null); assert.equal(v.vivo.latido_vigente, false); assert.equal(v.detecta.watcher, 'DESCONOCIDO');
  assert.deepEqual(v.declarado_por_la_sesion, { loop: true, watch: true }, 'lo declarado por la sesión se muestra aparte');
  assert.equal(v.loop_host.estado, 'MANUAL_ONLY', 'declarar no basta: sin lecturas confirmadas es MANUAL_ONLY');
  assert.equal(v.despertar_modelo.estado, 'EVENT_WAKE_UNSUPPORTED');
  // Con latido vigente de un proceso vivo y métricas.
  fs.writeFileSync(path.join(dir, 'heartbeat-builder.json'), JSON.stringify({ schema: 1, pid: process.pid, rol: 'builder', at: new Date().toISOString(), intervalo_ms: 180000, vivo: { watcher: true, timer: true, canal: false }, pases: 9, detectados: 3, aceptados: 3 }));
  const t0 = Date.now();
  fs.writeFileSync(path.join(dir, 'metricas-builder.jsonl'), [{ origen: 'watcher', aceptado: true, detectado_ms: t0, atendido_ms: t0 + 1200, lat_deteccion_ms: 300, lat_atencion_ms: 1200, diagnostico: 'OK' }, { origen: 'timer', aceptado: false, detectado_ms: t0, lat_atencion_ms: null, diagnostico: 'SIN_ACEPTACION' }].map((x) => JSON.stringify(x)).join('\n') + '\n');
  v = panel.vigilancia(p.root, { role: 'builder' }).data.roles[0];
  assert.deepEqual([v.vivo.proceso_existe, v.vivo.latido_vigente], [true, true]);
  assert.deepEqual(v.detecta, { watcher: 'VIVO', respaldo: 'VIVO', canal: 'NO_DISPONIBLE', intervalo_ms: 180000 });
  assert.equal(v.host_acepta.atenciones, 2); assert.equal(v.host_acepta.aceptadas, 1); assert.equal(v.host_acepta.sin_aceptacion, 1);
  assert.equal(v.ultimo_progreso.con_progreso, 0, 'la lectura sin trabajo posterior no es progreso'); assert.equal(v.ultimo_progreso.sin_progreso, 1);
  assert.equal(v.veredicto, 'ACTIVA_PROPIEDAD_NO_VERIFICADA', 'el panel no lee la línea de comandos: no afirma que sea el proceso propio');
  assert.equal(panel.vigilancia(p.root, {}).data.roles.length, 2);
});

// ───────────────────────────── API y página ──────────────────────────────────

test('API /api/v1/teams*: sobre versionado, filtros validados, paginación, solo lectura y la base NO cambia', async () => {
  const p = campana('api');
  entregar(p, 'b1', 'hash-a-0001');
  const d = await arrancarDashboard(p.root);
  try {
    const antes = sha(p.dbPath);
    const t = await get(d, '/api/v1/teams?limit=2');
    assert.equal(t.status, 200);
    for (const k of ['schema_version', 'status', 'project_id', 'snapshot_revision', 'generated_at', 'coverage', 'data']) assert.ok(k in t.json, 'falta ' + k);
    assert.equal(t.json.schema_version, 1); assert.equal(t.json.source, 'teams-panel');
    assert.equal(t.json.data.tareas.length, 2); assert.equal(t.json.coverage.total, 3); assert.equal(t.json.coverage.next_cursor, 2);
    assert.equal((await get(d, '/api/v1/teams?limit=2&cursor=2')).json.data.tareas.length, 1);
    assert.deepEqual(Object.keys(t.json.data.etapas), ['construidas', 'auditadas', 'verificadas', 'registradas']);
    assert.equal(t.json.data.etapas.construidas.n, 1);
    // Validación.
    for (const [ruta, code] of [['/api/v1/teams?origen=otro', 'PARAMETRO_INVALIDO'], ['/api/v1/teams?x=1', 'PARAMETRO_DESCONOCIDO'], ['/api/v1/teams?plan=a%20b%3Bdrop', 'PARAMETRO_INVALIDO'], ['/api/v1/teams?limit=0', 'LIMIT_INVALIDO'], ['/api/v1/teams?role=x&role=y', 'PARAMETRO_REPETIDO'],
      ['/api/v1/teams-vigilancia?role=frontend', 'PARAMETRO_INVALIDO'], ['/api/v1/teams-auditoria?origen=aa', 'PARAMETRO_DESCONOCIDO'], ['/api/v1/tasks?origen=zzz', 'PARAMETRO_INVALIDO']]) {
      const r = await get(d, ruta);
      assert.equal(r.status, 400, ruta); assert.equal(r.json.reason_code, code, ruta);
    }
    assert.equal((await get(d, '/api/v1/teams?project_id=otro')).status, 404);
    assert.equal((await get(d, '/api/v1/teams-vigilancia?role=builder')).json.data.roles[0].rol, 'builder');
    assert.ok(['OK', 'EMPTY'].includes((await get(d, '/api/v1/teams-auditoria')).json.status));
    assert.equal((await get(d, '/api/v1/teams', { headers: { Origin: 'http://evil.example' } })).status, 403);
    assert.equal((await fetch(d.url + 'api/v1/teams', { method: 'POST', body: '{}' })).status, 405);
    assert.equal((await fetch(d.url + 'api/v1/teams', { method: 'DELETE' })).status, 405);
    assert.equal(sha(p.dbPath), antes, 'ninguna llamada escribe en la base');
    // ETag: cambia la base → cambia la revisión.
    const e1 = t.headers.get('etag');
    assert.equal((await fetch(d.url + 'api/v1/teams?limit=2', { headers: { 'If-None-Match': e1 } })).status, 304);
  } finally { d.cerrar(); }
});

test('T15: SOLO teams (sin aa:) — los ciclos, la cobertura y las etapas aparecen por SQL Y por la API del dashboard (post-cycle REAL)', { timeout: 600000 }, async () => {
  const p = limpiable(proyectoTeams('t15-api', { conGrafo: true, plan: false }));
  const c = p.tm.crearPlan(p.root, { objective: 'plan t15', sprints: [{ tasks: [tareaBase('A', ['src/A.js'])] }] });
  p.plan_id = c.plan_id;
  fs.mkdirSync(path.join(p.root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(p.root, 'src', 'A.js'), 'function f() { return 1; }\nmodule.exports = { f };\n');
  const e = entregar(p, 'b1', 'hash-t15-0001');
  const r = nucleo.registrarCierre(p.root, { plan_id: p.plan_id, task_id: e.task_id, attempt: 1, subject_hash: e.hash, files: e.files, area: 'src', tests: 1, sin_aprendizaje: 'cambio mecánico' }, { hijo_ms: 540000 });
  assert.equal(r.status, 'REGISTRADO', JSON.stringify(r));
  const db = p.abrirR();
  let sql; try { sql = { ciclos: db.get("SELECT count(*) AS n FROM ciclos WHERE ciclo_id LIKE 'teams\\_%' ESCAPE '\\'").n, episodios: db.get("SELECT count(*) AS n FROM episodios WHERE tipo = 'ciclo_teams'").n, ast: db.get('SELECT count(*) AS n FROM ast_symbols').n }; } finally { db.close(); }
  assert.deepEqual([sql.ciclos, sql.episodios], [1, 1]); assert.ok(sql.ast >= 1);
  const d = await arrancarDashboard(p.root);
  try {
    const teams = (await get(d, '/api/v1/teams')).json.data;
    assert.equal(teams.ciclos.por_origen.teams, 1); assert.equal(teams.ciclos.por_origen.aa, 0);
    assert.equal(teams.etapas.registradas.n, 1); assert.equal(teams.cobertura.cobertura_pct, 100); assert.equal(teams.cobertura.estado, 'COMPLETA');
    const tareas = (await get(d, '/api/v1/tasks?origen=teams')).json;
    assert.equal(tareas.data.length, 1); assert.equal(tareas.data[0].origen, 'teams'); assert.equal(tareas.data[0].ciclo_id, r.cycle_id);
    assert.equal((await get(d, '/api/v1/tasks?origen=aa')).json.data.length, 0, 'sin aa:, no hay ciclos de aa');
    assert.equal((await get(d, '/api/v1/tasks')).json.data.length, 1);
  } finally { d.cerrar(); }
});

test('página /teams: servida con CSP, sin recursos externos, nada interpreta datos como HTML; los grafos no cambian y no enlazan a ella', async () => {
  const p = campana('pagina');
  // Datos hostiles en el plan y en un hallazgo: llegan como TEXTO.
  const db = p.abrirW();
  try { db.run("INSERT INTO teams_findings (id, task_id, severity, state, origin, criterion, event_id) VALUES ('F-X', 'A', 'HIGH', 'OPEN', 'frontend', ?, 'ex')", '<img src=x onerror="window.__xss=1"></script><script>window.__xss=2</script>'); } finally { db.close(); }
  const d = await arrancarDashboard(p.root);
  try {
    const r = await get(d, '/teams');
    assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /text\/html/); assert.match(r.headers.get('content-security-policy'), /default-src|script-src/);
    assert.match(r.texto, /Campaña TEAMS/); assert.match(r.texto, /\/api\/v1\/teams\b/); assert.match(r.texto, /\/api\/v1\/teams-vigilancia/); assert.match(r.texto, /\/api\/v1\/teams-auditoria/);
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|\bsrcdoc\b|javascript:/.test(pagina.TEAMS_HTML), 'nada interpreta datos como HTML');
    assert.ok(/textContent/.test(pagina.TEAMS_HTML));
    assert.ok(!/<script src=|<link [^>]*href="https?:|https?:\/\/(?!www\.w3\.org)/.test(pagina.TEAMS_HTML), 'sin recursos externos');
    for (const etiqueta of ['Construidas', 'Auditadas', 'Verificadas', 'Registradas', 'Cobertura de registro', 'Vigilancia', 'Auditoría', 'Correcciones', 'Ciclos por origen', 'desconocido']) assert.ok(r.texto.includes(etiqueta), 'falta en la página: ' + etiqueta);
    assert.match(r.texto, /nunca como 0/);
    // El cuerpo JSON no trae HTML literal (< > & salen como \uXXXX) y al decodificar se conserva el texto tal cual.
    const j = await get(d, '/api/v1/teams?correction=F-X');
    assert.ok(!/<script|<img/i.test(j.texto), 'sin HTML literal en la respuesta');
    assert.ok(j.json.data.correcciones.items[0].criterion.includes('<img src=x'));
    assert.ok(j.json.data.plan.objective.includes('<script>alert(1)</script>'));
    // Los grafos: el tablero no cambia ni enlaza al panel.
    const raiz = (await get(d, '/')).texto;
    assert.match(raiz, /<a class="mode-link" href="\/teams"/, 'la barra de pestañas enlaza a /teams (solo una ancla)');
    assert.ok(!/teams-pagina|api\/v1\/teams/.test(raiz), 'los grafos no cargan nada de TEAMS');
    // La navegación de las páginas propias sí lo incluye.
    assert.match((await get(d, '/memoria')).texto, /href="\/teams"/);
    assert.equal((await get(d, '/teams/../../etc/passwd')).status, 404);
    assert.equal((await fetch(d.url + 'teams', { method: 'POST', body: '{}' })).status, 405);
  } finally { d.cerrar(); }
});

test('operativa: el TEAMS que ya leía el tablero (estado y pendientes) sigue igual y la API de capacidades no cambia', () => {
  const p = campana('operativa');
  const op = require(path.join(G, 'operativa.cjs'));
  const t = op.leerTeams(p.root);
  assert.ok(t && t.estado && t.estado.inicializado, 'leerTeams sigue funcionando');
  assert.ok(Array.isArray(t.pendientes));
  assert.equal(typeof op.teamsPanel, 'object', 'operativa expone el panel TEAMS (aditivo)');
  assert.equal(op.teamsPanel.resumen, panel.resumen);
});
