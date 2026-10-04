'use strict';
/* TEAMS v4 — el protocolo manual del dueño hecho comando. Cada prueba cubre un dolor real de usarlo a mano:
   que el constructor se salte partes del MD, que no reporte de forma puntual, que los vigilantes no despierten
   o se queden esperando para siempre tras el cierre, y que nada de lo hecho quede registrado en Agentix. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const G = path.join(__dirname, '..', '.agentic', 'grafo');
const T = require(path.join(G, 'teams.cjs'));
const canal = require(path.join(G, 'teams-canal.cjs'));
const TEAMS_CLI = path.join(G, 'teams.cjs');

function proyecto() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-teams4-'));
  fs.mkdirSync(path.join(root, '.agentic'), { recursive: true });
  return root;
}
const run = (root, ...args) => T.ejecutar(args, root);
const salida = (root, ...args) => run(root, ...args).out;
/** Proyecto con el flujo completo ya recorrido: activar → modo completo → iniciar (canal ACTIVO). */
function arrancado(root) { run(root, 'activar'); run(root, 'modo', 'completo'); run(root, 'iniciar'); }

function stubPostCycle(root) {
  const f = path.join(root, 'stub-post-cycle.cjs');
  fs.writeFileSync(f, "const fs=require('fs'),path=require('path');const d=path.join(process.cwd(),'.agentic','_teams');fs.mkdirSync(d,{recursive:true});fs.appendFileSync(path.join(d,'stub-calls.jsonl'),JSON.stringify({args:process.argv.slice(2),ciclo:process.env.AKDD_CYCLE_ID,files:JSON.parse(process.env.AKDD_TEAMS_FILES||'[]'),actor:process.env.AKDD_ACTOR})+'\\n');");
  process.env.AKDD_TEAMS_POSTCYCLE = f;
  return () => { delete process.env.AKDD_TEAMS_POSTCYCLE; };
}
const llamadasStub = (root) => { try { return fs.readFileSync(path.join(root, '.agentic', '_teams', 'stub-calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };

function lanzar(root, args, env) {
  return spawnSync(process.execPath, [TEAMS_CLI, '--root=' + root, ...args], { encoding: 'utf8', timeout: 30000, env: Object.assign({}, process.env, env || {}) });
}

// ───────────────────────────── activar ──────────────────────────────────────

test('activar crea el canal, la metodología y la regla de recuperación; repetirlo no duplica ni pisa nada', () => {
  const root = proyecto();
  assert.match(salida(root, 'activar'), /canal creado/);
  assert.ok(fs.existsSync(path.join(root, '.legion', 'AUDITORIA-CURSOR.md')));
  assert.ok(fs.existsSync(path.join(root, '.legion', 'METODOLOGIA.md')));
  assert.ok(fs.existsSync(path.join(root, '.legion', 'CONTINUIDAD.md')));
  const instr = fs.readFileSync(path.join(root, '.agentic', 'INSTRUCCIONES-PROYECTO.md'), 'utf8');
  assert.match(instr, /PROTOCOLO TEAMS — recuperación de contexto/);
  fs.appendFileSync(path.join(root, '.legion', 'AUDITORIA-CURSOR.md'), '\nTEXTO DEL USUARIO\n');
  const otra = salida(root, 'activar');
  assert.match(otra, /ADOPTADO/);
  assert.match(fs.readFileSync(path.join(root, '.legion', 'AUDITORIA-CURSOR.md'), 'utf8'), /TEXTO DEL USUARIO/);
  assert.equal((fs.readFileSync(path.join(root, '.agentic', 'INSTRUCCIONES-PROYECTO.md'), 'utf8').match(/PROTOCOLO TEAMS — recuperación/g) || []).length, 1);
});

test('adopta el canal de la carpeta manual del dueño (plantilla con comentarios y marcas de ejemplo) sin falsos pendientes', () => {
  const root = proyecto();
  fs.mkdirSync(path.join(root, '.legion'));
  fs.writeFileSync(path.join(root, '.legion', 'AUDITORIA-CURSOR.md'), [
    '# Canal de trabajo — Protocolo TEAMS (MECÁNICA: INVERTIDA)', '', 'texto', '',
    '## Correcciones pendientes', '<!-- formato: `✅ RESUELTO [fecha]` y BLOQUEANTE/HALLAZGO/NOTA -->', '', '_Vacía — nada pendiente de corrección todavía._', '',
    '## Tareas para Cursor', '<!-- REGLA DURA -->', '', '_[Completar con el primer lote real]_', '',
    '## Reporte de Cursor', '', '_Sin rondas todavía._', '',
    '## Auditoría del Director (interna, no la llena Cursor)', '', '_Nada que auditar todavía._', '',
  ].join('\r\n'));
  salida(root, 'activar');
  const e = T.calcular(root);
  assert.equal(e.canal, 'ACTIVO');
  assert.equal(e.mecanica, 'INVERTIDA');
  assert.equal(e.corrPend.length, 0);
  assert.equal(e.tareas.length, 0);
  assert.match(salida(root, 'tarea', 'Primera', '--criterio=a'), /T-001/);
  assert.ok(/\r\n/.test(fs.readFileSync(path.join(root, '.legion', 'AUDITORIA-CURSOR.md'), 'utf8')), 'respeta el fin de línea del archivo');
});

test('sin canal: los comandos dicen cómo activarlo, no se rompen', () => {
  const root = proyecto();
  assert.match(salida(root, 'estado'), /teams: activar/);
  assert.equal(run(root, 'ronda', '--rol=builder').code, 1);
});

// ───────────────────────────── la ronda no se salta nada ────────────────────

test('la ronda del constructor imprime TODO lo pendiente: correcciones primero, luego tareas completas', () => {
  const root = proyecto(); arrancado(root);
  salida(root, 'tarea', 'Login con correo', '--criterio=valida correo', '--criterio=muestra error', '--archivos=src/login.js');
  salida(root, 'corregir', 'falta escapar HTML', '--sev=HALLAZGO', '--archivo=src/login.js:12', '--tarea=T-001');
  const r = salida(root, 'ronda', '--rol=builder');
  assert.ok(r.indexOf('CORRECCIONES PENDIENTES') < r.indexOf('TAREAS PENDIENTES'), 'correcciones primero');
  assert.match(r, /falta escapar HTML/);
  assert.match(r, /- \[ \] valida correo/);
  assert.match(r, /- \[ \] muestra error/);
});

test('reporte puntual: una tarea con casillas marcadas y SIN reporte es una omisión que la ronda no deja cerrar', () => {
  const root = proyecto(); arrancado(root);
  salida(root, 'tarea', 'Logout', '--criterio=cierra sesión');
  const f = canal.rutaCanal(root);
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('- [ ] cierra sesión', '- [x] cierra sesión'));
  const c1 = salida(root, 'ronda', '--rol=builder', '--cierre');
  assert.match(c1, /SIN_REPORTE/);
  assert.match(c1, /RONDA_INCOMPLETA/);
  salida(root, 'reportar', 'T-001', '--estado=HECHO', '--detalle=cerrado y probado', '--verif=npm test: 3 pass', '--archivos=src/logout.js');
  const c2 = salida(root, 'ronda', '--rol=builder', '--cierre');
  assert.match(c2, /RONDA_COMPLETA/);
  assert.ok(!/SIN_REPORTE/.test(c2));
});

test('lo que NO se implementó queda visible: HECHO con casillas abiertas, y NO_HECHO/PARCIAL sin motivo, se detectan', () => {
  const root = proyecto(); arrancado(root);
  salida(root, 'tarea', 'Exportar PDF', '--criterio=botón', '--criterio=archivo');
  salida(root, 'reportar', 'T-001', '--estado=HECHO', '--detalle=listo');
  assert.ok(T.calcular(root).omisiones.some((o) => o.codigo === 'HECHO_CON_CASILLAS_ABIERTAS'));
  salida(root, 'tarea', 'Importar', '--criterio=x');
  salida(root, 'reportar', 'T-002', '--estado=NO_HECHO', '--detalle=no');
  assert.ok(T.calcular(root).omisiones.some((o) => o.codigo === 'SIN_MOTIVO' && o.id === 'T-002'));
  salida(root, 'reportar', 'T-002', '--estado=NO_HECHO', '--detalle=falta la API de terceros, queda para el lote 2');
  const t2 = T.calcular(root).tareas.find((t) => t.id === 'T-002');
  assert.equal(t2.estado, 'DEVUELTA');
  assert.match(salida(root, 'reporte'), /NO implementado[\s\S]*T-002\] NO_HECHO: falta la API/);
});

test('una corrección «resuelta» sin decir qué se hizo se marca como omisión; con detalle, no', () => {
  const root = proyecto(); arrancado(root);
  salida(root, 'corregir', 'validar tenant en la consulta', '--sev=BLOQUEANTE', '--archivo=src/q.js:4');
  fs.writeFileSync(canal.rutaCanal(root), fs.readFileSync(canal.rutaCanal(root), 'utf8').replace('validar tenant en la consulta', 'validar tenant en la consulta\n✅ RESUELTO'));
  assert.ok(T.calcular(root).omisiones.some((o) => o.codigo === 'RESUELTO_SIN_DETALLE'));
  salida(root, 'resolver', 'C-001', 'añadido filtro tenant_id y prueba');
  const e = T.calcular(root);
  assert.equal(e.corrPend.length, 0);
  assert.ok(!e.omisiones.some((o) => o.codigo === 'RESUELTO_SIN_DETALLE'));
});

test('la auditoría nunca gatea: una corrección nueva no cambia el estado de las tareas en cola ni las detiene', () => {
  const root = proyecto(); arrancado(root);
  salida(root, 'tarea', 'A', '--criterio=a'); salida(root, 'tarea', 'B', '--criterio=b');
  salida(root, 'corregir', 'detalle menor', '--sev=NOTA', '--tarea=T-001');
  const e = T.calcular(root);
  assert.equal(e.tareasPend.length, 2, 'las dos siguen en la cola del constructor');
  assert.match(salida(root, 'ronda', '--rol=builder'), /TAREAS PENDIENTES \(2\)/);
});

test('el aviso de «espera a que se audite» salta al escribirlo (el error más fácil de cometer)', () => {
  const root = proyecto(); arrancado(root);
  assert.match(salida(root, 'tarea', 'Migrar tablas', '--detalle=espera a que se audite la tarea anterior'), /gatea el avance/);
  assert.ok(!/gatea/.test(salida(root, 'tarea', 'Otra', '--detalle=usa el módulo ya existente')));
});

// ───────────────────────────── aceptar → núcleo ─────────────────────────────

test('aceptar registra la tarea en el núcleo (post-cycle con origen teams, ciclo teams_…, archivos reales) y es idempotente', () => {
  const root = proyecto(); const restaurar = stubPostCycle(root);
  try {
    arrancado(root);
    salida(root, 'tarea', 'Login con correo', '--criterio=valida', '--archivos=src/auth/login.js');
    salida(root, 'reportar', 'T-001', '--estado=HECHO', '--detalle=listo', '--verif=npm test: 12 pass', '--archivos=src/auth/login.js,src/auth/mail.js');
    const r = salida(root, 'aceptar', 'T-001', '--verifico=npm test: 12 pass', '--tests=12');
    assert.match(r, /ACEPTADA/);
    assert.match(r, /registrada en el núcleo/);
    const l = llamadasStub(root);
    assert.equal(l.length, 1);
    assert.ok(l[0].args.includes('--origen=teams'));
    assert.ok(l[0].args.includes('--tests=12'));
    assert.match(l[0].ciclo, /^teams_[a-f0-9]{24}$/);
    assert.deepEqual(l[0].files.sort(), ['src/auth/login.js', 'src/auth/mail.js']);
    salida(root, 'aceptar', 'T-001');
    assert.ok(!/registrada en el núcleo/.test(salida(root, 'observar')), 'repetir no vuelve a anunciar un registro');
    assert.equal(llamadasStub(root).length, 1, 'repetir no duplica el ciclo');
    assert.equal(require(path.join(G, 'teams-registro.cjs')).resumen(root).registradas, 1);
    assert.equal(T.calcular(root).avance, 100);
  } finally { restaurar(); }
});

test('si el registro falla NO frena nada: queda pendiente y observar lo reintenta hasta lograrlo', () => {
  const root = proyecto();
  process.env.AKDD_TEAMS_POSTCYCLE = path.join(root, 'no-existe.cjs');
  try {
    arrancado(root); salida(root, 'tarea', 'X', '--criterio=a');
    salida(root, 'reportar', 'T-001', '--estado=HECHO', '--detalle=hecho');
    const r = salida(root, 'aceptar', 'T-001');
    assert.match(r, /PENDIENTE/);
    assert.match(r, /no frena nada/);
    assert.equal(T.calcular(root).tareas[0].estado, 'ACEPTADA', 'la aceptación del Director vale aunque el registro tarde');
  } finally { delete process.env.AKDD_TEAMS_POSTCYCLE; }
  const restaurar = stubPostCycle(root);
  try {
    salida(root, 'observar');
    assert.equal(llamadasStub(root).length, 1);
    assert.equal(require(path.join(G, 'teams-registro.cjs')).resumen(root).registradas, 1);
  } finally { restaurar(); }
});

test('aceptar con avisos (sin reporte, casillas abiertas) los muestra pero NO bloquea: la decisión es del Director', () => {
  const root = proyecto(); const restaurar = stubPostCycle(root);
  try {
    arrancado(root); salida(root, 'tarea', 'X', '--criterio=a', '--criterio=b');
    const r = salida(root, 'aceptar', 'T-001');
    assert.match(r, /ACEPTADA/);
    assert.match(r, /no dejó reporte puntual/);
    assert.match(r, /casilla\(s\) sin marcar/);
  } finally { restaurar(); }
});

test('el ciclo registrado se reconoce como origen teams en el tablero (prefijo teams_)', () => {
  const root = proyecto(); const restaurar = stubPostCycle(root);
  try {
    arrancado(root); salida(root, 'tarea', 'X', '--criterio=a'); salida(root, 'aceptar', 'T-001');
    assert.ok(String(llamadasStub(root)[0].ciclo).startsWith('teams_'));
    const api = fs.readFileSync(path.join(G, 'dashboard-api.cjs'), 'utf8');
    assert.match(api, /startsWith\('teams_'\)/);
  } finally { restaurar(); }
});

// ───────────────────────────── decisiones ───────────────────────────────────

test('decisión del dueño: queda abierta, no frena lo independiente, y al contestarla el Director la ve', () => {
  const root = proyecto(); arrancado(root);
  salida(root, 'tarea', 'Independiente', '--criterio=a');
  salida(root, 'decision', '¿Qué moneda usa la factura?', '--tipo=dueno', '--opciones=COP|USD', '--recomendacion=COP');
  let e = T.calcular(root);
  assert.equal(e.decisionesDueno.length, 1);
  assert.equal(e.tareasPend.length, 1, 'el trabajo independiente continúa');
  assert.match(salida(root, 'avance'), /decisiones tuyas[\s\S]*D-001/);
  salida(root, 'decidir', 'D-001', 'COP');
  e = T.calcular(root);
  assert.equal(e.decisionesDueno.length, 0);
  assert.ok(T.accionable(e, 'director').razones.some((r) => /DECISION DEL DUEÑO D-001/.test(r)));
});

test('decisión del Director: se escribe con su porqué y fuentes, y NO se le pregunta al dueño', () => {
  const root = proyecto(); arrancado(root);
  const r = salida(root, 'decision', '¿Cómo paginar?', '--tipo=director', '--elegida=cursor-based', '--porque=estable con inserciones', '--fuentes=https://ejemplo.org/doc');
  assert.match(r, /decidida por el Director/);
  const txt = fs.readFileSync(canal.rutaCanal(root), 'utf8');
  assert.match(txt, /Elegida: cursor-based/);
  assert.match(txt, /Fuentes: https:\/\/ejemplo\.org\/doc/);
  assert.equal(T.calcular(root).decisionesDueno.length, 0);
});

test('el protocolo del Director no limita la investigación a los links del dueño', () => {
  const P = require(path.join(G, 'teams-prompts.cjs'));
  const d = P.prompt('director', {});
  assert.match(d, /INVESTIGA en internet por tu cuenta[^\n]*con o sin links/);
  assert.match(d, /Solo escala al dueño lo que NO está en internet/);
  assert.match(d, /Lanza los 3 sub-agentes EN PARALELO/);
  assert.match(P.prompt('builder', {}), /RONDA_COMPLETA/);
});

// ───────────────────────────── vigilantes ───────────────────────────────────

test('vigilante del constructor: despierta con lo pendiente y NO vuelve a despertar por lo que ya atendió', () => {
  const root = proyecto(); arrancado(root);
  salida(root, 'tarea', 'A', '--criterio=a');
  const env = { AKDD_TEAMS_SONDEO_MS: '200', AKDD_TEAMS_MAX_MS: '2500' };
  const w1 = lanzar(root, ['esperar', '--rol=builder', '--despertar'], env);
  assert.match(w1.stdout, /AGENT_LOOP_WAKE_builder/);
  assert.match(w1.stdout, /TAREA T-001/);
  salida(root, 'ronda', '--rol=builder');
  const w2 = lanzar(root, ['esperar', '--rol=builder', '--despertar'], env);
  assert.match(w2.stdout, /AGENT_LOOP_RELAUNCH_builder/, 'visto no despierta; solo renueva la espera');
  salida(root, 'corregir', 'algo nuevo', '--sev=HALLAZGO');
  const w3 = lanzar(root, ['esperar', '--rol=builder', '--despertar'], env);
  assert.match(w3.stdout, /AGENT_LOOP_WAKE_builder[\s\S]*CORRECCION C-001/);
});

test('vigilante: se despierta a media espera cuando llega algo al canal (no solo al arrancar)', async () => {
  const root = proyecto(); arrancado(root);
  salida(root, 'ronda', '--rol=builder');
  const p = spawn(process.execPath, [TEAMS_CLI, '--root=' + root, 'esperar', '--rol=builder', '--despertar'], { env: Object.assign({}, process.env, { AKDD_TEAMS_SONDEO_MS: '300', AKDD_TEAMS_MAX_MS: '20000' }) });
  let out = ''; p.stdout.on('data', (d) => { out += d; });
  await new Promise((r) => setTimeout(r, 1200));
  salida(root, 'tarea', 'Llegó después', '--criterio=x');
  const codigo = await new Promise((res) => { p.on('exit', res); setTimeout(() => { p.kill(); res('timeout'); }, 8000); });
  assert.equal(codigo, 0);
  assert.match(out, /AGENT_LOOP_WAKE_builder[\s\S]*Llegó después/);
});

test('vigilante del Director: despierta con la entrega del constructor, y con constructor ocioso', () => {
  const root = proyecto(); arrancado(root);
  salida(root, 'tarea', 'A', '--criterio=a');
  salida(root, 'revisar');
  const env = { AKDD_TEAMS_SONDEO_MS: '200', AKDD_TEAMS_MAX_MS: '1500' };
  assert.match(lanzar(root, ['esperar', '--rol=director'], env).stdout, /RELAUNCH/, 'sin entrega no despierta al Director');
  salida(root, 'reportar', 'T-001', '--estado=HECHO', '--detalle=listo');
  assert.match(lanzar(root, ['esperar', '--rol=director'], env).stdout, /AGENT_LOOP_WAKE_director[\s\S]*ENTREGA T-001/);
  salida(root, 'revisar');
  salida(root, 'aceptar', 'T-001');
  salida(root, 'revisar');
  // todo aceptado y cola vacía: LISTO_PARA_CERRAR (una sola vez)
  const listo = T.accionable(T.calcular(root), 'director');
  assert.ok(listo.razones.some((r) => /LISTO_PARA_CERRAR/.test(r)));
});

test('constructor ocioso: el Director recibe el aviso de que la cola se vació (su responsabilidad), el constructor no se despierta', () => {
  const root = proyecto(); arrancado(root);
  salida(root, 'tarea', 'A', '--criterio=a'); salida(root, 'tarea', 'B', '--criterio=b');
  salida(root, 'reportar', 'T-001', '--estado=HECHO', '--detalle=listo'); salida(root, 'reportar', 'T-002', '--estado=NO_HECHO', '--detalle=falta una decisión de negocio sobre B');
  const e = T.calcular(root, { ahora: Date.now() + 60 * 60000 });
  assert.equal(e.constructorSinTrabajo, true, 'el constructor entregó todo: ahora la pelota está del lado del Director');
  assert.ok(T.accionable(e, 'director').razones.some((r) => /ENTREGA T-001/.test(r)) && T.accionable(e, 'director').razones.some((r) => /DEVUELTA T-002/.test(r)));
  salida(root, 'aceptar', 'T-001'); salida(root, 'cancelar', 'T-002', 'se aplaza a otro proyecto');
  const e2 = T.calcular(root, { ahora: Date.now() + 60 * 60000, ociosoMs: 1000 });
  assert.equal(e2.listo, true);
  const e3 = T.calcular(root, { ahora: Date.now() + 60 * 60000 });
  assert.equal(T.accionable(e3, 'builder').digest, '', 'el constructor no tiene nada: no se despierta');
});

test('CIERRE: cerrar manda terminar a los vigilantes de los DOS roles (nadie queda esperando algo que no llegará)', () => {
  const root = proyecto(); const restaurar = stubPostCycle(root);
  try {
    arrancado(root); salida(root, 'tarea', 'A', '--criterio=a');
    const antes = run(root, 'cerrar');
    assert.equal(antes.code, 2, 'con trabajo vivo no cierra sin --forzar');
    assert.match(antes.out, /en cola: T-001/);
    salida(root, 'reportar', 'T-001', '--estado=HECHO', '--detalle=listo'); salida(root, 'aceptar', 'T-001');
    const c = run(root, 'cerrar');
    assert.equal(c.code, 0);
    assert.match(c.out, /Canal CERRADO/);
    assert.ok(fs.existsSync(path.join(root, '.legion', 'REPORTE.md')));
    assert.match(fs.readFileSync(path.join(root, '.legion', 'REPORTE.md'), 'utf8'), /FINAL/);
    for (const rol of ['builder', 'director']) {
      const w = lanzar(root, ['esperar', '--rol=' + rol, '--despertar'], { AKDD_TEAMS_SONDEO_MS: '200' });
      assert.equal(w.status, 0);
      assert.match(w.stdout, new RegExp('AGENT_LOOP_END_' + rol));
      assert.match(w.stdout, /NO relances/);
    }
    assert.match(salida(root, 'ronda', '--rol=builder'), /CANAL CERRADO/);
    salida(root, 'reabrir');
    assert.equal(T.calcular(root).canal, 'ACTIVO');
  } finally { restaurar(); }
});

test('comprobar es honesto: sin vigilante vivo no anuncia autonomía', () => {
  const root = proyecto(); arrancado(root);
  const r = salida(root, 'comprobar');
  assert.match(r, /builder: NO_HAY_VIGILANTE/);
  assert.match(r, /Despertar NO verificado/);
});

test('despertar verificado: un aviso seguido de la ronda del rol se cuenta', () => {
  const root = proyecto(); arrancado(root); salida(root, 'tarea', 'A', '--criterio=a');
  lanzar(root, ['esperar', '--rol=builder'], { AKDD_TEAMS_SONDEO_MS: '200' });
  salida(root, 'ronda', '--rol=builder');
  assert.match(salida(root, 'comprobar'), /Despertar VERIFICADO/);
});

// ───────────────────────────── escritura concurrente ────────────────────────

test('dos agentes escribiendo a la vez no se pisan: ids distintos y el archivo íntegro', async () => {
  const root = proyecto(); arrancado(root);
  const lanz = (n) => new Promise((res) => { const p = spawn(process.execPath, [TEAMS_CLI, '--root=' + root, 'tarea', 'tarea paralela ' + n, '--criterio=c' + n]); p.on('exit', res); });
  await Promise.all(Array.from({ length: 10 }, (_, i) => lanz(i)));
  const e = T.calcular(root);
  assert.equal(e.tareas.length, 10);
  assert.equal(new Set(e.tareas.map((t) => t.id)).size, 10, 'ningún id repetido');
  assert.match(fs.readFileSync(canal.rutaCanal(root), 'utf8'), /## Auditoría del Director/);
});

// ───────────────────────────── conexión con Agentix ─────────────────────────

test('la CLI y el chat apuntan al mismo script, y el TEAMS viejo ya no existe', () => {
  const bin = fs.readFileSync(path.join(__dirname, '..', 'bin', 'akdd.js'), 'utf8');
  assert.match(bin, /case 'teams'[\s\S]{0,200}teams\.cjs/);
  const claude = fs.readFileSync(path.join(__dirname, '..', 'CLAUDE.md'), 'utf8');
  assert.match(claude, /teams: activar/);
  assert.match(claude, /teams: iniciar/);
  for (const viejo of ['teams-manager.cjs', 'teams-adapters.cjs', 'teams-nucleo.cjs', 'teams-vigilancia.cjs']) assert.ok(!fs.existsSync(path.join(G, viejo)), viejo);
});

test('continuidad y reporte se generan solos con la hora real del sistema', () => {
  const root = proyecto(); arrancado(root); salida(root, 'tarea', 'A', '--criterio=a');
  salida(root, 'revisar');
  const c = fs.readFileSync(path.join(root, '.legion', 'CONTINUIDAD.md'), 'utf8');
  assert.match(c, /Backlog pendiente[\s\S]*T-001/);
  assert.match(c, /\d{4}-\d{2}-\d{2} \d{2}:\d{2} \(reloj del sistema\)/);
});

test('canal real con historial en texto libre (sin ids): no inventa pendientes, muestra lo vivo al adoptar y «heredar» deja limpio al constructor', () => {
  const root = proyecto();
  fs.mkdirSync(path.join(root, '.legion'));
  fs.writeFileSync(path.join(root, '.legion', 'AUDITORIA-CURSOR.md'), [
    '# Canal de trabajo — Protocolo TEAMS (MECÁNICA: INVERTIDA)', '',
    '## Correcciones pendientes', '', '### HALLAZGO — api/citas.ts:40', 'Falta validar la fecha. ✅ RESUELTO 2026-10-01 — hecho', '',
    '### BLOQUEANTE — api/pagos.ts:12', 'Se pierde el recibo al reintentar.', '',
    '## Tareas para Cursor', '', '### Lote 14 — Agenda semanal', 'Vista semanal. ✅ HECHO', '',
    '### Lote 15 — Recordatorios', 'Enviar 24 h antes.', '',
    '## Reporte de Cursor', '', 'Ronda 31: terminé el lote 14.', '',
    '## Auditoría del Director (interna, no la llena Cursor)', '', 'Lote 14 revisado.', '',
  ].join(String.fromCharCode(10)));
  const r = salida(root, 'activar');
  assert.match(r, /ADOPTADO/);
  assert.ok(r.includes('1 corrección(es) sin resolver · 1 tarea(s) en cola · 1 hecha(s) sin aceptar'), r);
  assert.match(r, /teams: heredar/);
  const e = T.calcular(root);
  assert.equal(e.omisiones.length, 0, 'un RESUELTO corto («hecho») no es una omisión');
  assert.ok(salida(root, 'heredar').includes('2 elemento(s)'));
  const e2 = T.calcular(root);
  assert.equal(e2.corrPend.length, 0);
  assert.equal(e2.tareasPend.length, 0);
  assert.equal(e2.tareas.find((t) => /Lote 15/.test(t.titulo)).estado, 'HEREDADA');
  assert.ok(!e2.tareas.some((t) => t.estado === 'HEREDADA' && T.accionable(e2, 'builder').razones.some((x) => x.includes(t.id))));
  assert.match(salida(root, 'tarea', 'Lote 17 nuevo', '--criterio=x'), /encolada/);
  assert.equal(T.calcular(root).tareasPend.length, 1, 'lo nuevo sí cuenta');
});

test('el piloto de release solo exige herramientas MCP que el servidor realmente define (no una retirada como teams_packet)', () => {
  const piloto = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'release-integration.cjs'), 'utf8');
  const lista = /for \(const n of \[([^\]]+)\]\) assert\.ok\(tools\.tools\.some/.exec(piloto);
  assert.ok(lista, 'no se encontró la lista de herramientas exigidas');
  const exigidas = [...lista[1].matchAll(/'(\w+)'/g)].map((m) => m[1]);
  const fuentes = fs.readdirSync(G).filter((n) => /^mcp-.*\.cjs$/.test(n)).map((n) => fs.readFileSync(path.join(G, n), 'utf8')).join(String.fromCharCode(10));
  for (const n of exigidas) assert.ok(new RegExp("name:\\s*'" + n + "'").test(fuentes), 'el piloto exige ' + n + ' pero el servidor no la define');
});

test('ningún script de release ni del laboratorio requiere un archivo que ya no existe (restos del TEAMS retirado)', () => {
  const raiz = path.join(__dirname, '..');
  const rotos = [];
  for (const dir of ['scripts', 'sandbox']) {
    for (const n of fs.readdirSync(path.join(raiz, dir)).filter((x) => /\.c?js$/.test(x))) {
      const src = fs.readFileSync(path.join(raiz, dir, n), 'utf8');
      for (const m of src.matchAll(/require\(\s*'(\.{1,2}\/[^']+)'\s*\)/g)) {
        const destino = path.resolve(raiz, dir, m[1]);
        if (!fs.existsSync(destino) && !fs.existsSync(destino + '.cjs') && !fs.existsSync(destino + '.js') && !fs.existsSync(destino + '.json')) rotos.push(dir + '/' + n + ' → ' + m[1]);
      }
    }
  }
  assert.deepEqual(rotos, []);
});

// ───────────────────────────── el flujo del dueño: activar → modo → plan → builder → iniciar → pausa/continuar ─────

test('FLUJO 1 — activar deja el canal PREPARADO y manda preguntar el modo (completo o individual); el agente no lo elige solo', () => {
  const root = proyecto();
  const r = salida(root, 'activar');
  assert.match(r, /estado PREPARADO, modo por definir/);
  assert.match(r, /PREGUNTA al dueño/);
  assert.match(r, /COMPLETO[\s\S]*INDIVIDUAL/);
  assert.match(r, /agente auditor EXTRA/);
  const e = T.calcular(root);
  assert.equal(e.canal, 'PREPARADO');
  assert.equal(e.mecanica, 'POR DEFINIR');
  assert.match(salida(root, 'estado'), /modo POR DEFINIR/);
});

test('FLUJO 2 — modo completo: Director + 3 sub-agentes + Cursor como constructor; entrega el prompt de Cursor listo', () => {
  const root = proyecto(); salida(root, 'activar');
  const r = salida(root, 'modo', 'completo');
  assert.match(r, /Modo COMPLETO \(mecánica INVERTIDA\)/);
  assert.match(r, /teams: plan/);
  assert.match(r, /teams: builder/);
  assert.match(r, /Eres el CONSTRUCTOR/);
  assert.ok(fs.existsSync(path.join(root, '.legion', 'PROMPT-builder.md')));
  const txt = fs.readFileSync(canal.rutaCanal(root), 'utf8');
  assert.match(txt, /MECÁNICA: INVERTIDA/);
  assert.match(txt, /Cursor construye/);
  assert.equal(T.calcular(root).canal, 'PREPARADO', 'elegir el modo no inicia nada');
});

test('FLUJO 2b — modo individual: Claude Code también construye, sin Cursor ni vigilantes; y un auditor extra se suma a los 3', () => {
  const root = proyecto(); salida(root, 'activar');
  const r = salida(root, 'modo', 'individual', '--extra=seguridad: authz y secretos');
  assert.match(r, /Modo INDIVIDUAL/);
  assert.match(r, /auditores extra: seguridad: authz y secretos/);
  assert.doesNotMatch(r, /teams: builder/);
  assert.match(fs.readFileSync(canal.rutaCanal(root), 'utf8'), /MECÁNICA: INDIVIDUAL[\s\S]*modo INDIVIDUAL/);
  salida(root, 'tarea', 'X', '--criterio=a');
  assert.match(salida(root, 'auditar', 'T-001'), /4\) EXTRA — seguridad: authz y secretos/);
  assert.match(salida(root, 'comprobar'), /modo INDIVIDUAL \(sin vigilantes: no hacen falta\)/);
  assert.match(require(path.join(G, 'teams-prompts.cjs')).prompt('individual'), /Director Y constructor/);
});

test('FLUJO 3 — plan: se guarda lo asimilado con sus documentos fuente, avisa de los que no existen y dice qué sigue', () => {
  const root = proyecto(); salida(root, 'activar'); salida(root, 'modo', 'completo');
  fs.mkdirSync(path.join(root, 'docs')); fs.writeFileSync(path.join(root, 'docs', 'spec.md'), '# spec');
  const r = salida(root, 'plan', 'Construir el módulo de citas en 3 lotes: agenda, recordatorios, reportes', '--docs=docs/spec.md,docs/falta.md');
  assert.match(r, /Plan guardado/);
  assert.match(r, /no encuentro docs\/falta\.md/);
  assert.match(r, /teams: builder/);
  const plan = fs.readFileSync(path.join(root, '.legion', 'PLAN.md'), 'utf8');
  assert.match(plan, /módulo de citas/);
  assert.match(plan, /docs\/spec\.md/);
  assert.match(salida(root, 'estado'), /plan guardado/);
  assert.equal(T.calcular(root).canal, 'PREPARADO', 'el plan tampoco inicia nada');
});

test('FLUJO 4 — builder (Cursor): queda conectado, se prepara solo y espera; sin iniciar NO se le pide trabajo ni lo despiertan', () => {
  const root = proyecto(); salida(root, 'activar'); salida(root, 'modo', 'completo');
  assert.match(salida(root, 'estado'), /constructor NO conectado/);
  const r = salida(root, 'builder');
  assert.match(r, /CONSTRUCTOR CONECTADO/);
  assert.match(r, /LISTO y a la espera de `teams: iniciar`/);
  assert.match(salida(root, 'estado'), /constructor conectado/);
  salida(root, 'tarea', 'Lote anticipado', '--criterio=x');
  const ronda = salida(root, 'ronda', '--rol=builder');
  assert.match(ronda, /CANAL PREPARADO/);
  assert.match(ronda, /NO hay nada que construir aún/);
  assert.doesNotMatch(ronda, /Lote anticipado/);
  const w = lanzar(root, ['esperar', '--rol=builder', '--despertar'], { AKDD_TEAMS_SONDEO_MS: '200', AKDD_TEAMS_MAX_MS: '1500' });
  assert.match(w.stdout, /RELAUNCH/, 'preparado: el vigilante espera, no despierta');
});

test('FLUJO 5 — iniciar: sin modo no arranca; sin plan avisa; al iniciar el canal queda ACTIVO y el vigilante de Cursor despierta solo', () => {
  const root = proyecto(); salida(root, 'activar');
  assert.equal(run(root, 'iniciar').code, 2, 'sin modo no inicia');
  salida(root, 'modo', 'completo');
  const sinPlan = salida(root, 'iniciar');
  assert.match(sinPlan, /INICIADO — modo COMPLETO, canal ACTIVO/);
  assert.match(sinPlan, /Constructor NO conectado todavía/);
  assert.match(sinPlan, /No hay plan ni tareas/);
  assert.match(sinPlan, /descompón el plan en lotes/);
  assert.equal(T.calcular(root).canal, 'ACTIVO');
  salida(root, 'tarea', 'Primer lote', '--criterio=a');
  const w = lanzar(root, ['esperar', '--rol=builder', '--despertar'], { AKDD_TEAMS_SONDEO_MS: '200', AKDD_TEAMS_MAX_MS: '3000' });
  assert.match(w.stdout, /AGENT_LOOP_WAKE_builder[\s\S]*Primer lote/);
});

test('FLUJO 6 — pausa: el canal pasa a PAUSADO, los vigilantes de los DOS terminan solos y el constructor recibe la orden de parar y cancelar su loop', () => {
  const root = proyecto(); arrancado(root);
  salida(root, 'tarea', 'Algo en curso', '--criterio=a');
  assert.match(salida(root, 'pausa'), /Canal PAUSADO/);
  assert.equal(T.calcular(root).canal, 'PAUSADO');
  for (const rol of ['builder', 'director']) {
    const w = lanzar(root, ['esperar', '--rol=' + rol, '--despertar'], { AKDD_TEAMS_SONDEO_MS: '200' });
    assert.equal(w.status, 0);
    assert.match(w.stdout, new RegExp('AGENT_LOOP_PAUSE_' + rol));
    assert.match(w.stdout, /CANCELA tu loop de respaldo/);
  }
  const ronda = salida(root, 'ronda', '--rol=builder');
  assert.match(ronda, /CANAL PAUSADO/);
  assert.match(ronda, /CANCELA tu loop de respaldo/);
  assert.doesNotMatch(ronda, /Algo en curso/, 'en pausa no se le imprime trabajo');
  assert.equal(T.accionable(T.calcular(root), 'builder').digest, '', 'nadie es despertado en pausa');
  assert.match(salida(root, 'revisar'), /CANAL PAUSADO/);
});

test('FLUJO 7 — continuar (sobre todo en Cursor): reactiva el canal y le dice al rol que relance su vigilante y su loop; vuelve a despertar', () => {
  const root = proyecto(); arrancado(root);
  salida(root, 'tarea', 'Pendiente al pausar', '--criterio=a');
  salida(root, 'pausa');
  const r = salida(root, 'continuar', '--rol=builder');
  assert.match(r, /Canal ACTIVO otra vez/);
  assert.match(r, /CONTINÚAS como CONSTRUCTOR/);
  assert.match(r, /relanza tu vigilante `esperar --rol=builder --despertar`/);
  assert.match(r, /reactiva tu loop de respaldo/);
  assert.equal(T.calcular(root).canal, 'ACTIVO');
  const w = lanzar(root, ['esperar', '--rol=builder', '--despertar'], { AKDD_TEAMS_SONDEO_MS: '200', AKDD_TEAMS_MAX_MS: '3000' });
  assert.match(w.stdout, /AGENT_LOOP_WAKE_builder[\s\S]*Pendiente al pausar/);
  const d = salida(root, 'continuar');
  assert.match(d, /ya estaba ACTIVO/);
  assert.match(d, /CONTINÚAS como DIRECTOR/);
  assert.match(d, /también necesita que el dueño escriba `teams: continuar` en SU chat/);
});

test('FLUJO 8 — continuar no salta etapas: preparado pide iniciar primero; cerrado pide reabrir', () => {
  const root = proyecto(); salida(root, 'activar'); salida(root, 'modo', 'completo');
  assert.equal(run(root, 'continuar').code, 2);
  assert.match(salida(root, 'continuar'), /aún no se inició/);
  salida(root, 'iniciar'); salida(root, 'tarea', 'A', '--criterio=a'); salida(root, 'cancelar', 'T-001', 'prueba');
  salida(root, 'tarea', 'B', '--criterio=b'); salida(root, 'cancelar', 'T-002', 'prueba');
  run(root, 'cerrar', '--forzar');
  assert.match(salida(root, 'continuar'), /CERRADO/);
  assert.match(salida(root, 'pausa'), /CERRADO/);
});

test('FLUJO 9 — los comandos del chat (activar, modo, plan, builder, iniciar, pausa, continuar) están en la tabla de CLAUDE.md y en el protocolo del Director', () => {
  const claude = fs.readFileSync(path.join(__dirname, '..', 'CLAUDE.md'), 'utf8');
  for (const c of ['teams: activar', 'teams: plan', 'teams: builder', 'teams: iniciar', 'teams: pausa', 'teams: continuar']) assert.ok(claude.includes(c), c);
  const d = require(path.join(G, 'teams-prompts.cjs')).prompt('director', {});
  for (const c of ['teams: activar', 'teams: plan', 'teams: iniciar', 'teams: pausa', 'teams: continuar']) assert.ok(d.includes(c), 'el prompt del Director no menciona ' + c);
  assert.match(d, /PREGUNTAS al dueño el modo/);
});
