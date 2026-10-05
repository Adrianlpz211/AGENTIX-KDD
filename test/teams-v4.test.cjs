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

test('activar crea el canal y la metodología; NO toca CLAUDE.md ni INSTRUCCIONES-PROYECTO (si no, akdd update lo vería como cambio propio); repetirlo no pisa nada', () => {
  const root = proyecto();
  assert.match(salida(root, 'activar'), /canal creado/);
  assert.ok(fs.existsSync(path.join(root, '.legion', 'AUDITORIA-CURSOR.md')));
  assert.ok(fs.existsSync(path.join(root, '.legion', 'METODOLOGIA.md')));
  assert.ok(fs.existsSync(path.join(root, '.legion', 'CONTINUIDAD.md')));
  assert.equal(fs.existsSync(path.join(root, 'CLAUDE.md')), false, 'no crea ni escribe CLAUDE.md');
  assert.equal(fs.existsSync(path.join(root, '.agentic', 'INSTRUCCIONES-PROYECTO.md')), false, 'ni INSTRUCCIONES-PROYECTO.md');
  const claudeGestionado = fs.readFileSync(path.join(__dirname, '..', 'CLAUDE.md'), 'utf8');
  assert.match(claudeGestionado, /### Recuperación de contexto \(sesión nueva, compactada o reiniciada\)/, 'la regla de recuperación viaja en el CLAUDE.md gestionado');
  fs.appendFileSync(path.join(root, '.legion', 'AUDITORIA-CURSOR.md'), '\nTEXTO DEL USUARIO\n');
  const otra = salida(root, 'activar');
  assert.match(otra, /ADOPTADO/);
  assert.match(fs.readFileSync(path.join(root, '.legion', 'AUDITORIA-CURSOR.md'), 'utf8'), /TEXTO DEL USUARIO/);
  assert.equal(fs.existsSync(path.join(root, 'CLAUDE.md')), false);
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
    assert.match(salida(root, 'observar'), /Observado/);
    assert.equal(llamadasStub(root).length, 0, 'recién fallado: está en espera, no reintenta de inmediato (espera progresiva)');
    salida(root, 'observar', '--reintentar');
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
  assert.match(r, /teams: constructor/);
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
  assert.doesNotMatch(r, /teams: constructor/);
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
  assert.match(r, /teams: constructor/);
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
  assert.match(r, /activar tus DOS vigilantes/);
  assert.match(r, /vigilante de archivo en segundo plano: +node \.agentic\/grafo\/teams\.cjs esperar --rol=builder --despertar/);
  assert.match(r, /loop de respaldo cada ~3 minutos/);
  assert.match(r, /comprobar\s+\(debe decir builder: VIGILANTE_VIVO\)/);
  assert.match(r, /ACTIVA YA tus DOS vigilantes/);
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
  for (const c of ['teams: activar', 'teams: plan', 'teams: constructor', 'teams: iniciar', 'teams: pausa', 'teams: continuar']) assert.ok(claude.includes(c), c);
  const d = require(path.join(G, 'teams-prompts.cjs')).prompt('director', {});
  for (const c of ['teams: activar', 'teams: plan', 'teams: iniciar', 'teams: pausa', 'teams: continuar']) assert.ok(d.includes(c), 'el prompt del Director no menciona ' + c);
  assert.match(d, /PREGUNTAS al dueño el modo/);
});

test('CURSOR — la regla que le enseña a Cursor los comandos teams: viaja con Agentix, siempre activa, y define teams: constructor', () => {
  const f = path.join(__dirname, '..', '.cursor', 'rules', 'teams.mdc');
  assert.ok(fs.existsSync(f), 'falta .cursor/rules/teams.mdc: sin ella Cursor responde «teams: constructor no está definido»');
  const t = fs.readFileSync(f, 'utf8');
  assert.match(t, /alwaysApply: true/);
  assert.match(t, /teams: constructor/);
  assert.match(t, /node \.agentic\/grafo\/teams\.cjs constructor/);
  assert.match(t, /DOS vigilantes/);
  for (const c of ['teams: continuar', 'teams: pausa']) assert.ok(t.includes(c), c);
  const pk = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(pk.files.includes('.cursor/rules/'), 'la regla se empaqueta');
  const mm = fs.readFileSync(path.join(__dirname, '..', 'src', 'managed-manifest.js'), 'utf8');
  assert.match(mm, /\.cursor\/rules/, 'y el actualizador la distribuye');
});

test('la palabra del comando es «constructor» (builder sigue entendiéndose), y --rol=constructor vale', () => {
  const root = proyecto(); salida(root, 'activar'); salida(root, 'modo', 'completo');
  assert.match(salida(root, 'constructor'), /CONSTRUCTOR CONECTADO/);
  assert.match(salida(root, 'builder'), /CONSTRUCTOR CONECTADO/);
  salida(root, 'iniciar'); salida(root, 'pausa');
  assert.match(salida(root, 'continuar', '--rol=constructor'), /CONTINÚAS como CONSTRUCTOR/);
  const claude = fs.readFileSync(path.join(__dirname, '..', 'CLAUDE.md'), 'utf8');
  assert.ok(claude.includes('teams: constructor'));
  assert.ok(!claude.includes('teams: builder'));
});

test('el vigilante deja su propia bitácora (inicio, fin) para poder diagnosticar un despertar que no llega', () => {
  const root = proyecto(); arrancado(root);
  salida(root, 'tarea', 'Algo', '--criterio=a');
  lanzar(root, ['esperar', '--rol=builder', '--despertar'], { AKDD_TEAMS_SONDEO_MS: '200', AKDD_TEAMS_MAX_MS: '3000' });
  const log = fs.readFileSync(path.join(root, '.agentic', '_teams', 'vigilantes', 'builder.log'), 'utf8');
  assert.match(log, /INICIO sondeo=200ms/);
  assert.match(log, /FIN AGENT_LOOP_WAKE_builder/);
});

// ───────────────────────────── blindaje tras la prueba real en glowly ─────────────────────────────

test('GLOWLY-1 — vigilante CONTINUO: no termina al avisar, avisa de lo siguiente solo, y termina con la pausa', async () => {
  const root = proyecto(); arrancado(root);
  salida(root, 'tarea', 'Primera', '--criterio=a', '--sin-contexto');
  const p = spawn(process.execPath, [TEAMS_CLI, '--root=' + root, 'esperar', '--rol=builder', '--despertar', '--continuo'], { env: Object.assign({}, process.env, { AKDD_TEAMS_SONDEO_MS: '200', AKDD_TEAMS_MAX_MS: '60000' }) });
  let out = ''; p.stdout.on('data', (d) => { out += d; });
  let salio = null; p.on('exit', (c) => { salio = c; });
  const esperarHasta = async (cond, ms = 8000) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 100)); return cond(); };
  try {
    assert.ok(await esperarHasta(() => /AGENT_LOOP_WAKE_builder[\s\S]*Primera/.test(out)), 'primer aviso: ' + out);
    assert.equal(salio, null, 'sigue vivo tras avisar');
    assert.match(out, /NO relances este vigilante: sigue vivo/);
    salida(root, 'corregir', 'algo urgente', '--sev=HALLAZGO');
    assert.ok(await esperarHasta(() => /CORRECCION C-001/.test(out)), 'segundo aviso sin relanzar: ' + out);
    assert.equal(salio, null);
    salida(root, 'pausa');
    assert.ok(await esperarHasta(() => salio !== null, 6000), 'termina con la pausa');
    assert.match(out, /AGENT_LOOP_PAUSE_builder/);
    assert.equal(salio, 0);
  } finally { try { p.kill(); } catch { /* ya terminó */ } }
});

test('GLOWLY-2 — sin vigilante vivo, la ronda lo dice en su PRIMERA línea (y no lo dice si lo hay, ni en modo individual)', () => {
  const root = proyecto(); arrancado(root);
  const sin = salida(root, 'ronda', '--rol=builder');
  assert.match(sin.split('\n')[0], /TU VIGILANTE \(builder\) NO ESTÁ VIVO\. Relánzalo AHORA, ANTES de trabajar/);
  assert.match(salida(root, 'revisar').split('\n')[0], /TU VIGILANTE \(director\) NO ESTÁ VIVO/);
  const dir = path.join(root, '.agentic', '_teams', 'vigilantes'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'builder.json'), JSON.stringify({ rol: 'builder', pid: process.pid, desde: new Date().toISOString(), latido: new Date().toISOString(), sondeo_s: 10 }));
  assert.doesNotMatch(salida(root, 'ronda', '--rol=builder'), /NO ESTÁ VIVO/);
  fs.writeFileSync(path.join(dir, 'builder.json'), JSON.stringify({ rol: 'builder', pid: process.pid, latido: new Date(Date.now() - 10 * 60000).toISOString(), sondeo_s: 10 }));
  assert.match(salida(root, 'ronda', '--rol=builder'), /NO ESTÁ VIVO/, 'un latido viejo no cuenta como vivo');
  const ind = proyecto(); salida(ind, 'activar'); salida(ind, 'modo', 'individual'); salida(ind, 'iniciar');
  assert.doesNotMatch(salida(ind, 'ronda', '--rol=builder'), /NO ESTÁ VIVO/);
});

test('GLOWLY-3 — una ENTREGA sin revisar se le recuerda al Director cada ~8 min (huella nueva = vigilante lo despierta otra vez)', () => {
  const root = proyecto(); arrancado(root);
  salida(root, 'tarea', 'Entrega olvidada', '--criterio=a', '--sin-contexto');
  salida(root, 'reportar', 'T-001', '--estado=HECHO', '--detalle=listo');
  const t0 = Date.now();
  const a0 = T.accionable(T.calcular(root, { ahora: t0 }), 'director');
  assert.ok(a0.razones.some((r) => /ENTREGA T-001 por revisar/.test(r)));
  assert.ok(!a0.razones.some((r) => /SIN REVISAR/.test(r)), 'recién entregada: sin recordatorio');
  const a1 = T.accionable(T.calcular(root, { ahora: t0 + 9 * 60000 }), 'director');
  const a2 = T.accionable(T.calcular(root, { ahora: t0 + 18 * 60000 }), 'director');
  assert.ok(a1.razones.some((r) => /ENTREGA SIN REVISAR hace \d+ min: T-001/.test(r)));
  assert.notEqual(a1.digest, a0.digest);
  assert.notEqual(a2.digest, a1.digest, 'cada tanda de 8 min es un aviso nuevo');
  salida(root, 'aceptar', 'T-001');
  assert.ok(!T.accionable(T.calcular(root, { ahora: t0 + 30 * 60000 }), 'director').razones.some((r) => /SIN REVISAR/.test(r)), 'aceptada: se acaba el recordatorio');
});

test('GLOWLY-4 — al encolar, Agentix anota en la tarea su aviso previo (riesgo, antecedentes, curas) y el constructor lo ve en su ronda', () => {
  const root = proyecto(); salida(root, 'activar'); salida(root, 'modo', 'completo'); salida(root, 'iniciar');
  const g = path.join(root, '.agentic', 'grafo'); fs.mkdirSync(g, { recursive: true });
  fs.writeFileSync(path.join(g, 'context-enricher.cjs'), "console.log('## Context Enricher');console.log('**Riesgo estimado:** ALTO');console.log('**Contexto relevante encontrado en memoria:**');console.log('- [error/ALTA] #9 Credenciales dev en el cliente (seguridad)');console.log('  - **Solución que funcionó:** moverlas al servidor');console.log('- 🔮 Predicción: auth falló 2/2 veces');require('fs').writeFileSync(require('path').join(process.cwd(),'enricher-llamado.txt'), process.argv[2]);");
  const r = salida(root, 'tarea', 'Tocar el login', '--criterio=valida', '--criterio=redirige', '--archivos=src/login.js');
  assert.match(r, /Aviso previo de Agentix: riesgo ALTO · 3 dato\(s\)/);
  assert.match(r, /RIESGO ALTO/);
  assert.match(fs.readFileSync(path.join(root, 'enricher-llamado.txt'), 'utf8'), /Tocar el login\. valida\. redirige/, 'el enricher recibe título + criterios');
  const txt = fs.readFileSync(canal.rutaCanal(root), 'utf8');
  assert.match(txt, /> 🧠 Contexto Agentix \(riesgo ALTO\)/);
  assert.match(txt, /> - \[error\/ALTA\] #9 Credenciales dev en el cliente/);
  const t = T.calcular(root).tareas[0];
  assert.equal(t.casillas.total, 2, 'el aviso no se confunde con criterios');
  assert.match(salida(root, 'ronda', '--rol=builder'), /Contexto Agentix \(riesgo ALTO\)[\s\S]*Credenciales dev/);
  fs.rmSync(path.join(root, 'enricher-llamado.txt'));
  salida(root, 'tarea', 'Sin aviso', '--criterio=x', '--sin-contexto');
  assert.equal(fs.existsSync(path.join(root, 'enricher-llamado.txt')), false, '--sin-contexto no lo corre');
});

test('GLOWLY-5 — la duración de un ciclo de TEAMS se sella en la libreta (de que el constructor quedó libre a que se aceptó) y el reloj la prefiere a marcas ajenas', () => {
  const root = proyecto(); const restaurar = stubPostCycle(root);
  try {
    const { DatabaseSync } = require('node:sqlite');
    new DatabaseSync(path.join(root, '.agentic', 'memoria.db')).close();
    arrancado(root);
    salida(root, 'tarea', 'Larga', '--criterio=a', '--sin-contexto');
    const est = T.leerEstado(root); const hace = new Date(Date.now() - 40 * 60000).toISOString();
    est.creadas['T-001'] = hace; fs.writeFileSync(path.join(root, '.agentic', '_teams', 'estado.json'), JSON.stringify(est));
    salida(root, 'reportar', 'T-001', '--estado=HECHO', '--detalle=listo'); salida(root, 'aceptar', 'T-001');
    const db = new DatabaseSync(path.join(root, '.agentic', 'memoria.db'));
    try {
      const f = db.prepare("SELECT ts, cycle_id, event_id FROM gate_events WHERE verdict = 'CICLO_INICIO'").all();
      assert.equal(f.length, 1);
      assert.match(f[0].cycle_id, /^teams_/);
      assert.equal(f[0].ts, new Date(hace).toISOString().replace('T', ' ').slice(0, 19));
      // el reloj usa ESA marca aunque otro flujo (el enricher al encolar la siguiente tarea) deje una más reciente
      const gt = require(path.join(G, 'gate-telemetry.cjs')); gt.ensureTelemetrySchema(db);
      gt.recordGateEvent(db, { gate: 'reloj', verdict: 'CICLO_INICIO', source: 'mechanical', cycle_id: 'otro-ciclo', event_id: 'ajeno-1' });
      const reloj = require(path.join(G, 'reloj-derivado.cjs'));
      const fin = new Date(Date.now() + 60000).toISOString().replace('T', ' ').slice(0, 19);
      const m = reloj.marcaDeArranque(db, { ciclo_id: f[0].cycle_id, fecha_fin: fin });
      assert.ok(m && (m.fin - m.ini) >= 39 * 60000 && (m.fin - m.ini) <= 42 * 60000, 'duración ≈ 40 min, no la de la marca ajena: ' + (m && (m.fin - m.ini)));
      const sinPropia = reloj.marcaDeArranque(db, { ciclo_id: 'sin-marca-propia', fecha_fin: fin });
      assert.ok(sinPropia, 'un ciclo de aa: sin marca propia sigue funcionando como antes (la última)');
      assert.equal(reloj.marcaDeArranque(db, { ciclo_id: 'teams_sin_marca_propia', fecha_fin: fin }), null, 'un ciclo de TEAMS sin marca propia queda sin dato: no toma la marca de otro flujo');
    } finally { db.close(); }
  } finally { restaurar(); }
});

test('GLOWLY-6 — activar archiva solo el canal del TEAMS anterior y detiene a sus vigilantes, que seguían vivos pisando el canal nuevo', async () => {
  const root = proyecto();
  fs.mkdirSync(path.join(root, '.legion'), { recursive: true });
  const viejo = '<!-- Vista generada por akdd teams. No editar -->\n# Canal TEAMS — vista\n\n## 2. Control de campaña\n- Estado: **PAUSADA**\n\n```\n<<<AKDD-TEAMS v1\n{"kind":"EVENT"}\nAKDD-TEAMS>>>\n```\n';
  fs.writeFileSync(path.join(root, '.legion', 'AUDITORIA-CURSOR.md'), viejo);
  const falso = spawn(process.execPath, ['-e', 'setTimeout(function(){},60000)', path.join(root, '.agentic', 'grafo', 'teams-watch.cjs'), '--rol=builder'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 600));
  assert.match(salida(root, 'comprobar'), /PROCESO DEL TEAMS ANTERIOR VIVO/);
  const r = salida(root, 'activar');
  assert.match(r, /detenido un proceso del TEAMS anterior/);
  assert.match(r, /archivado como \.legion\/ANTIGUO-v3-vista\.md/);
  const muerto = await new Promise((res) => { if (falso.exitCode !== null) return res(true); falso.on('exit', () => res(true)); setTimeout(() => res(false), 4000); });
  assert.ok(muerto, 'el proceso viejo se detuvo');
  assert.ok(fs.existsSync(path.join(root, '.legion', 'ANTIGUO-v3-vista.md')));
  assert.equal(fs.readFileSync(path.join(root, '.legion', 'ANTIGUO-v3-vista.md'), 'utf8'), viejo, 'el archivo viejo queda intacto');
  assert.equal(T.calcular(root).canal, 'PREPARADO', 'y el canal nuevo nace limpio');
  assert.doesNotMatch(fs.readFileSync(canal.rutaCanal(root), 'utf8'), /AKDD-TEAMS v1/);
  // un canal NUEVO (v4) existente jamás se archiva
  salida(root, 'tarea', 'Mía', '--criterio=a', '--sin-contexto');
  assert.doesNotMatch(salida(root, 'activar'), /archivado/);
  assert.equal(T.calcular(root).tareas.length, 1);
  // segundo canal viejo: no pisa el archivo anterior
  fs.writeFileSync(canal.rutaCanal(root), viejo);
  salida(root, 'activar');
  assert.ok(fs.existsSync(path.join(root, '.legion', 'ANTIGUO-v3-vista.2.md')));
});

test('MIGRACIÓN — activar retira el bloque de recuperación que escribían las versiones 3.21–3.22.1 (solo el nuestro) para que akdd update no lo vea como cambio propio', () => {
  const root = proyecto(); fs.mkdirSync(path.join(root, '.agentic'), { recursive: true });
  const bloque = '## PROTOCOLO TEAMS — recuperación de contexto AUTOMÁTICA E INCONDICIONAL\n\n**Regla dura: si existe `.legion/AUDITORIA-CURSOR.md` y su ESTADO es ACTIVO...**\n\n1. Ejecuta algo.\n';
  fs.writeFileSync(path.join(root, '.agentic', 'INSTRUCCIONES-PROYECTO.md'), '# Mis reglas\n\nUsar siempre pnpm.\n\n' + bloque + '\n## Otra sección mía\n\nTexto del usuario.\n');
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Reglas\n\ntexto\n\n' + bloque);
  const r = salida(root, 'activar');
  assert.match(r, /retirado el bloque de recuperación[^\n]*INSTRUCCIONES-PROYECTO\.md y CLAUDE\.md/);
  const instr = fs.readFileSync(path.join(root, '.agentic', 'INSTRUCCIONES-PROYECTO.md'), 'utf8');
  assert.doesNotMatch(instr, /PROTOCOLO TEAMS/);
  assert.match(instr, /Usar siempre pnpm\./);
  assert.match(instr, /## Otra sección mía\n\nTexto del usuario\./);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), /PROTOCOLO TEAMS/);
  // un bloque con el mismo título que NO es el nuestro (no habla del canal) se respeta
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# R\n\n## PROTOCOLO TEAMS — recuperación de contexto\n\nalgo del usuario sin relación\n');
  assert.doesNotMatch(salida(root, 'activar'), /retirado el bloque/);
  assert.match(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), /algo del usuario sin relación/);
});

test('post-cycle deduce la duración TAMBIÉN tras cerrar el ciclo (el paso 2.75 corre antes de que exista fecha_fin: así todos los ciclos quedaban en 0)', () => {
  const src = fs.readFileSync(path.join(G, 'post-cycle.cjs'), 'utf8');
  const cierre = src.indexOf('results.cierre = cerrarCicloConGates(db, results);');
  const segunda = src.indexOf('6.95 Reloj (tras el cierre)');
  const primera = src.indexOf('2.75 Reloj...');
  assert.ok(cierre > 0 && segunda > cierre, 'la segunda pasada del reloj va DESPUÉS del cierre del ciclo');
  assert.ok(primera > 0 && primera < cierre, 'la primera pasada sigue donde estaba');
  assert.match(src.slice(segunda - 300, segunda + 200), /completarUltimo\(ROOT\)/);
});

test('REGISTRO — un fallo transitorio (base ocupada) no gasta los 5 intentos en segundos: espera progresiva, enfriamiento y reintento manual', () => {
  const root = proyecto();
  const stub = path.join(root, 'stub-falla.cjs');
  fs.writeFileSync(stub, "const fs=require('fs'),path=require('path');const d=path.join(process.cwd(),'.agentic','_teams');fs.mkdirSync(d,{recursive:true});fs.appendFileSync(path.join(d,'stub-calls.jsonl'),'x'+String.fromCharCode(10));if(fs.existsSync(path.join(process.cwd(),'FALLAR'))){console.error('❌ post-cycle falló: database is locked');process.exit(1);}");
  process.env.AKDD_TEAMS_POSTCYCLE = stub;
  const llamadas = () => { try { return fs.readFileSync(path.join(root, '.agentic', '_teams', 'stub-calls.jsonl'), 'utf8').trim().split('\n').length; } catch { return 0; } };
  const regPath = path.join(root, '.agentic', '_teams', 'registro.json');
  const envejecer = (min, intentos) => { const r = JSON.parse(fs.readFileSync(regPath, 'utf8')); for (const v of Object.values(r.tareas)) { v.at = new Date(Date.now() - min * 60000).toISOString(); if (intentos !== undefined) v.intentos = intentos; } fs.writeFileSync(regPath, JSON.stringify(r)); };
  try {
    arrancado(root); salida(root, 'tarea', 'X', '--criterio=a', '--sin-contexto'); salida(root, 'reportar', 'T-001', '--estado=HECHO', '--detalle=listo');
    fs.writeFileSync(path.join(root, 'FALLAR'), '1');
    salida(root, 'aceptar', 'T-001');
    assert.equal(llamadas(), 1);
    for (let i = 0; i < 6; i++) salida(root, 'observar');
    assert.equal(llamadas(), 1, 'seis revisiones seguidas NO reintentan: están en espera (antes agotaban los 5 intentos en 1 s)');
    assert.equal(JSON.parse(fs.readFileSync(regPath, 'utf8')).tareas[Object.keys(JSON.parse(fs.readFileSync(regPath, 'utf8')).tareas)[0]].intentos, 1);
    envejecer(3);
    salida(root, 'observar');
    assert.equal(llamadas(), 2, 'pasada la espera (1 min) reintenta');
    envejecer(0, 5);
    assert.match(salida(root, 'observar') + '', /Observado/);
    assert.equal(llamadas(), 2, 'con los 5 intentos gastados y reciente, no insiste');
    envejecer(45, 5);
    salida(root, 'observar');
    assert.equal(llamadas(), 3, 'a los 30 min de enfriamiento vuelve a intentarlo solo');
    fs.rmSync(path.join(root, 'FALLAR'));
    envejecer(0, 5);
    assert.match(salida(root, 'observar', '--reintentar'), /registrada en el núcleo/);
    assert.equal(require(path.join(G, 'teams-registro.cjs')).resumen(root).registradas, 1, 'el reintento manual ignora la espera y lo registra');
  } finally { delete process.env.AKDD_TEAMS_POSTCYCLE; }
});

// ───────────────────────────── los dos modelos se quedaron parados (glowly, 22:16) ─────────────────────────────

test('PARADOS-1 — una tarea PARCIAL sin avance pasa a decisión del Director: el constructor no gira en vacío y el Director recibe aviso', () => {
  const root = proyecto(); arrancado(root);
  salida(root, 'tarea', 'Esquema reproducible', '--criterio=exportar', '--criterio=reconstruir BD vacía', '--sin-contexto');
  salida(root, 'tarea', 'Otra independiente', '--criterio=x', '--sin-contexto');
  salida(root, 'reportar', 'T-001', '--estado=PARCIAL', '--detalle=exportado; la BD vacía no se pudo reconstruir porque el daemon de Docker no responde');
  const t0 = Date.now();
  const ya = T.calcular(root, { ahora: t0 });
  assert.equal(ya.tareas[0].estado, 'PENDIENTE', 'recién reportada PARCIAL: el constructor aún puede seguir');
  const tarde = T.calcular(root, { ahora: t0 + 12 * 60000 });
  assert.equal(tarde.tareas[0].estado, 'DEVUELTA');
  assert.equal(tarde.tareas[0].estancada, true);
  assert.deepEqual(tarde.tareasPend.map((t) => t.id), ['T-002'], 'lo propio del constructor es solo lo que sí puede avanzar');
  const dir = T.accionable(tarde, 'director');
  assert.ok(dir.razones.some((r) => /PARCIAL ESTANCADA T-001 \(sin avance hace 1\d min\).*Docker.*decide/.test(r)), dir.razones.join(' | '));
  assert.notEqual(dir.digest, '');
  const b = T.textoRondaBuilder(tarde);
  assert.match(b, /EN ESPERA DE DECISIÓN DEL DIRECTOR \(1\)/);
  assert.match(b, /T-001 PARCIAL: exportado/);
  assert.doesNotMatch((b.split('TAREAS PENDIENTES')[1] || '').split('EN ESPERA')[0], /T-001/, 'no figura entre sus tareas pendientes');
  assert.equal(tarde.listo, false);
  // si el constructor vuelve a reportar, se renueva el plazo (no se devuelve a la fuerza)
  salida(root, 'reportar', 'T-001', '--estado=PARCIAL', '--detalle=avancé: Docker ya responde, falta correr el rebuild');
  assert.equal(T.calcular(root, { ahora: Date.now() }).tareas[0].estado, 'PENDIENTE');
});

test('PARADOS-2 — el loop de respaldo deja huella: comprobar dice cuándo fue la última ronda y la ronda avisa si el loop no figura', () => {
  const root = proyecto(); arrancado(root);
  assert.match(salida(root, 'comprobar'), /director: loop de respaldo NO FIGURA \(sin rondas registradas\)/);
  salida(root, 'revisar'); salida(root, 'ronda', '--rol=builder');
  const c = salida(root, 'comprobar');
  assert.match(c, /director: loop de respaldo ACTIVO \(última ronda hace 0 min\)/);
  assert.match(c, /builder: loop de respaldo ACTIVO/);
  const est = T.leerEstado(root); est.rondas.director = Date.now() - 25 * 60000; fs.writeFileSync(path.join(root, '.agentic', '_teams', 'estado.json'), JSON.stringify(est));
  assert.match(salida(root, 'comprobar'), /director: loop de respaldo NO FIGURA \(última ronda hace 25 min\)/);
  const r = salida(root, 'revisar');
  assert.match(r, /Tu ronda anterior fue hace 25 min/);
  assert.match(r, /LOOP DE RESPALDO de ~3 min NO está activo/);
  assert.match(r, /TEAMS director — corre "node \.agentic\/grafo\/teams\.cjs revisar"/);
  assert.doesNotMatch(salida(root, 'revisar'), /Tu ronda anterior fue hace/, 'tras la ronda ya está al día');
});

test('PARADOS-3 — los protocolos dan el texto EXACTO del loop de cada rol y prohíben terminar el turno «a la espera»', () => {
  const P = require(path.join(G, 'teams-prompts.cjs'));
  const d = P.prompt('director', {}); const b = P.prompt('builder', {});
  assert.match(d, /Loop de respaldo — prográmalo AHORA, es el segundo vigilante/);
  assert.match(d, /CronCreate con `cron: "\*\/3 \* \* \* \*"`/);
  assert.ok(d.includes(P.LOOP_PROMPT('director')) && b.includes(P.LOOP_PROMPT('builder')));
  assert.match(d, /Nunca termines tu turno diciendo que «quedas a la espera»/);
  assert.match(d, /PARCIAL ESTANCADA[\s\S]*DECIDE/);
  const mdc = fs.readFileSync(path.join(__dirname, '..', '.cursor', 'rules', 'teams.mdc'), 'utf8');
  assert.match(mdc, /Tus DOS vigilantes \(obligatorios, los dos\)/);
  assert.match(mdc, /EN ESPERA DE DECISIÓN DEL DIRECTOR/);
});

test('PARADOS-4 — vigilante continuo: si el aviso no se atiende lo REPITE (recordatorio), y se calla en cuanto el rol hace su ronda', async () => {
  const root = proyecto(); arrancado(root);
  salida(root, 'tarea', 'Algo', '--criterio=a', '--sin-contexto');
  const p = spawn(process.execPath, [TEAMS_CLI, '--root=' + root, 'esperar', '--rol=builder', '--despertar', '--continuo'], { env: Object.assign({}, process.env, { AKDD_TEAMS_SONDEO_MS: '200', AKDD_TEAMS_LOOP_MS: '1200', AKDD_TEAMS_MAX_MS: '60000' }) });
  let out = ''; p.stdout.on('data', (d) => { out += d; });
  const hasta = async (cond, ms = 9000) => { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 100)); return cond(); };
  try {
    assert.ok(await hasta(() => /AGENT_LOOP_WAKE_builder\n/.test(out)), 'aviso inicial: ' + out);
    assert.ok(await hasta(() => /RECORDATORIO 2: sigue sin atenderse/.test(out)), 'repite el aviso mientras nadie lo atiende: ' + out);
    salida(root, 'ronda', '--rol=builder');
    const antes = (out.match(/RECORDATORIO/g) || []).length;
    await new Promise((r) => setTimeout(r, 3000));
    assert.equal((out.match(/RECORDATORIO/g) || []).length, antes, 'atendido: deja de recordar');
  } finally { try { p.kill(); } catch { /* ya terminó */ } }
});

// ───────────────────────────── salud: ¿están vivos?, ¿alguien parado?, ¿esperan los dos? ─────────────────────────────

function vigilanteFalso(root, rol, extra) {
  const dir = path.join(root, '.agentic', '_teams', 'vigilantes'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, rol + '.json'), JSON.stringify(Object.assign({ rol, pid: process.pid, desde: new Date().toISOString(), latido: new Date().toISOString(), sondeo_s: 10 }, extra || {})));
}
function rondaReciente(root, rol, minAtras) {
  const est = T.leerEstado(root); est.rondas = est.rondas || {}; est.rondas[rol] = Date.now() - (minAtras || 0) * 60000;
  fs.mkdirSync(path.join(root, '.agentic', '_teams'), { recursive: true }); fs.writeFileSync(path.join(root, '.agentic', '_teams', 'estado.json'), JSON.stringify(est));
}

test('SALUD-1 — VERDE solo si los dos roles tienen vigilante vivo y loop; sin ellos el semáforo lo dice con nombre y apellido', () => {
  const root = proyecto(); arrancado(root);
  salida(root, 'tarea', 'Algo', '--criterio=a', '--sin-contexto');
  let s = T.salud(root);
  assert.equal(s.semaforo, 'ROJO', 'con trabajo en cola y sin vigilantes no está bien');
  assert.ok(s.alertas.some((a) => /Constructor \(Cursor\): su vigilante NO está vivo y tiene trabajo esperando/.test(a.msg)));
  assert.ok(s.alertas.some((a) => /Director \(Claude Code\): su loop de respaldo no figura \(sin rondas registradas\)/.test(a.msg)));
  for (const rol of ['director', 'builder']) { vigilanteFalso(root, rol); rondaReciente(root, rol, 1); }
  s = T.salud(root);
  assert.equal(s.semaforo, 'VERDE', JSON.stringify(s.alertas));
  assert.equal(s.roles.builder.vigilante.vivo, true);
  assert.equal(s.roles.director.loop, 'ACTIVO');
  assert.equal(s.cola.tareas[0].id, 'T-001');
  // un latido viejo no cuenta como vivo
  vigilanteFalso(root, 'director', { latido: new Date(Date.now() - 10 * 60000).toISOString() });
  assert.equal(T.salud(root).roles.director.vigilante.vivo, false);
});

test('SALUD-2 — un aviso sin atender sube de amarillo a rojo con los minutos, y avisa que solo el dueño puede despertarlo', () => {
  const root = proyecto(); arrancado(root);
  for (const rol of ['director', 'builder']) { vigilanteFalso(root, rol); rondaReciente(root, rol, 1); }
  const est = T.leerEstado(root); const t0 = Date.now();
  est.wakes = [{ rol: 'director', at: new Date(t0 - 4 * 60000).toISOString(), digest: 'x' }]; fs.writeFileSync(path.join(root, '.agentic', '_teams', 'estado.json'), JSON.stringify(est));
  assert.equal(T.salud(root, { ahora: t0 }).semaforo, 'AMARILLO');
  const rojo = T.salud(root, { ahora: t0 + 9 * 60000 });
  assert.equal(rojo.semaforo, 'ROJO');
  assert.ok(rojo.alertas.some((a) => /Director \(Claude Code\): aviso sin atender hace 13 min.*solo tú puedes despertarlo/.test(a.msg)));
  assert.equal(rojo.roles.director.aviso_sin_atender_min, 13);
});

test('SALUD-3 — «los dos esperando al otro» ya no es silencioso: el OCIOSO se repite y el semáforo avisa de que nadie avanza', () => {
  const root = proyecto(); arrancado(root);
  for (const rol of ['director', 'builder']) { vigilanteFalso(root, rol); rondaReciente(root, rol, 1); }
  salida(root, 'tarea', 'A', '--criterio=a', '--sin-contexto'); salida(root, 'reportar', 'T-001', '--estado=HECHO', '--detalle=listo'); salida(root, 'aceptar', 'T-001');
  salida(root, 'tarea', 'B', '--criterio=b', '--sin-contexto'); salida(root, 'reportar', 'T-002', '--estado=NO_HECHO', '--detalle=falta una decisión de negocio sobre B que el Director debe tomar');
  salida(root, 'cancelar', 'T-002', 'se aplaza');
  salida(root, 'tarea', 'C', '--criterio=c', '--sin-contexto');
  salida(root, 'reportar', 'T-003', '--estado=PARCIAL', '--detalle=bloqueada: el servicio externo no responde');
  const t0 = Date.now();
  const e1 = T.calcular(root, { ahora: t0 + 12 * 60000 });
  assert.equal(e1.tareas.find((t) => t.id === 'T-003').estado, 'DEVUELTA');
  const d1 = T.accionable(e1, 'director'); const d2 = T.accionable(T.calcular(root, { ahora: t0 + 32 * 60000 }), 'director');
  assert.ok(d1.razones.some((r) => /CONSTRUCTOR_OCIOSO/.test(r)), d1.razones.join(' | '));
  assert.ok(d2.razones.some((r) => /CONSTRUCTOR_OCIOSO/.test(r)));
  assert.notEqual(d1.digest, d2.digest, 'el aviso de ocioso se REPITE cada 10 min mientras nadie actúe (antes: una sola vez)');
  const s = T.salud(root, { ahora: t0 + 25 * 60000 });
  assert.equal(s.semaforo, 'ROJO');
  assert.ok(s.alertas.some((a) => /Nadie avanza: hay \d+ cosa\(s\) pendiente\(s\) y el canal lleva 2\d min sin cambios/.test(a.msg)), JSON.stringify(s.alertas));
  assert.equal(s.cola.devueltas[0].estancada, true);
});

test('SALUD-4 — fuera de ACTIVO no hay alarma: PAUSADO, PREPARADO y CERRADO se muestran como lo que son; y comprobar pone el semáforo primero', () => {
  const root = proyecto(); arrancado(root);
  assert.match(salida(root, 'comprobar').split('\n')[0], /SEMÁFORO (AMARILLO|ROJO):/);
  salida(root, 'pausa');
  const p = T.salud(root); assert.equal(p.semaforo, 'PAUSADO'); assert.deepEqual(p.alertas, []);
  assert.doesNotMatch(salida(root, 'comprobar'), /SEMÁFORO/);
  const r2 = proyecto(); salida(r2, 'activar'); assert.equal(T.salud(r2).semaforo, 'PREPARADO');
  assert.equal(T.salud(proyecto()), null, 'sin canal no hay salud');
  assert.match(JSON.parse(salida(root, 'salud')).semaforo, /PAUSADO/);
});

test('TORMENTA — relanzar el vigilante tras un aviso NO lo dispara de nuevo por el mismo aviso; lo recuerda pasado el plazo; y la ronda atiende TODOS los avisos', () => {
  const root = proyecto(); arrancado(root);
  salida(root, 'tarea', 'Una', '--criterio=a', '--sin-contexto');
  const env = { AKDD_TEAMS_SONDEO_MS: '200', AKDD_TEAMS_MAX_MS: '1500', AKDD_TEAMS_LOOP_MS: '700' };
  assert.match(lanzar(root, ['esperar', '--rol=builder', '--despertar'], env).stdout, /AGENT_LOOP_WAKE_builder\n/);
  const re = lanzar(root, ['esperar', '--rol=builder', '--despertar'], Object.assign({}, env, { AKDD_TEAMS_LOOP_MS: '60000' }));
  assert.match(re.stdout, /RELAUNCH/, 'el vigilante relanzado enseguida NO vuelve a disparar por el mismo aviso (antes: tormenta de avisos cada pocos ms)');
  const t0 = Date.now(); while (Date.now() - t0 < 900) { /* pasa el plazo del recordatorio */ }
  const rec = lanzar(root, ['esperar', '--rol=builder', '--despertar'], env);
  assert.match(rec.stdout, /AGENT_LOOP_WAKE_builder \(RECORDATORIO: el aviso anterior sigue sin atenderse\)/);
  // varios avisos acumulados: la ronda los marca TODOS como atendidos
  const est = T.leerEstado(root); const dir = path.join(root, '.agentic', '_teams');
  est.wakes = [1, 2, 3].map((n) => ({ rol: 'builder', at: new Date(Date.now() - n * 60000).toISOString(), digest: 'd' + n })); fs.writeFileSync(path.join(dir, 'estado.json'), JSON.stringify(est));
  salida(root, 'ronda', '--rol=builder');
  assert.ok(T.leerEstado(root).wakes.every((w) => w.visto_at), 'ningún aviso viejo queda «sin atender» (daba falsas alarmas de «31 min» en el semáforo)');
  assert.equal(T.salud(root).roles.builder.aviso_sin_atender_min, null);
});

// ───────────────────────────── oficina 3D: bitácora de comandos y datos de la escena ─────────────────────────────

test('OFICINA-1 — cada comando que mueve algo deja su evento (rol, comando, objetivo) y salud() lo expone junto a las tareas', () => {
  const root = proyecto(); const restaurar = stubPostCycle(root);
  try {
    arrancado(root);
    salida(root, 'tarea', 'Login con correo', '--criterio=valida', '--sin-contexto');
    salida(root, 'constructor');
    salida(root, 'estado'); // solo lectura: no deja evento
    const evs = T.leerEventos(root, 50);
    assert.deepEqual(evs.map((e) => e.cmd + ':' + e.rol), ['activar:director', 'modo:director', 'iniciar:director', 'tarea:director', 'constructor:builder']);
    assert.ok(evs.every((e) => Number.isFinite(Date.parse(e.t))));
    const s = T.salud(root);
    assert.equal(s.eventos.at(-1).cmd, 'constructor');
    assert.equal(s.builder_conectado, true);
    assert.equal(s.tareas_todas[0].id, 'T-001'); assert.equal(s.tareas_todas[0].estado, 'PENDIENTE');
    assert.equal(s.auditoria, null);
    assert.equal(typeof s.actividad_seg, 'number');
  } finally { restaurar(); }
});

test('OFICINA-2 — los sub-agentes figuran auditando desde «auditar T-00X» hasta que el Director acepta o corrige; sin comandos viejos que se queden pegados', () => {
  const root = proyecto(); const restaurar = stubPostCycle(root);
  try {
    arrancado(root);
    salida(root, 'tarea', 'Login', '--criterio=a', '--sin-contexto');
    salida(root, 'reportar', 'T-001', '--estado=HECHO', '--detalle=listo', '--verif=npm test');
    salida(root, 'auditar', 'T-001');
    let s = T.salud(root);
    assert.equal(s.auditoria.id, 'T-001');
    salida(root, 'aceptar', 'T-001', '--verifico=npm test', '--tests=1');
    s = T.salud(root);
    assert.equal(s.auditoria, null, 'aceptar cierra la auditoría');
    salida(root, 'tarea', 'Otra', '--criterio=a', '--sin-contexto'); salida(root, 'auditar', 'T-002');
    assert.equal(T.salud(root).auditoria.id, 'T-002');
    assert.equal(T.salud(root, { ahora: Date.now() + 25 * 60000 }).auditoria, null, 'una auditoría de hace 25 min ya no se muestra como activa');
  } finally { restaurar(); }
});

// ───────────────────────────── ocio del constructor: 3 rondas iguales → pide trabajo al Director ─────────────────────────────

test('OCIO-1 — tres rondas seguidas del constructor sin nada que hacer dejan una SOLICITUD que despierta al Director, y encolar tarea la atiende', () => {
  const root = proyecto(); arrancado(root);
  const estadoF = path.join(root, '.agentic', '_teams', 'estado.json');
  const atras = () => { const est = JSON.parse(fs.readFileSync(estadoF, 'utf8')); if (est.sinNovedad && est.sinNovedad.builder) { est.sinNovedad.builder.ultimo -= 100000; est.sinNovedad.builder.desde -= 180000; } fs.writeFileSync(estadoF, JSON.stringify(est)); };
  const ronda = () => salida(root, 'ronda', '--rol=builder');
  assert.doesNotMatch(ronda(), /SIN TRABAJO/);
  assert.doesNotMatch(ronda(), /SIN TRABAJO/, 'dos llamadas pegadas cuentan como UNA ronda');
  atras(); assert.doesNotMatch(ronda(), /SIN TRABAJO/);   // 2.ª ronda
  atras(); const r3 = ronda();                             // 3.ª ronda
  assert.match(r3, /LLEVAS 3 RONDAS \(~\d+ min\) SIN TRABAJO/);
  assert.match(r3, /Ya le pedí tareas al Director en D-001/);
  assert.match(fs.readFileSync(canal.rutaCanal(root), 'utf8'), /\[D-001\] Constructor sin trabajo[\s\S]*Origen: CONSTRUCTOR/);
  const e = T.calcular(root);
  assert.ok(T.accionable(e, 'director').razones.some((x) => /SOLICITUD DEL CONSTRUCTOR D-001/.test(x)), 'el Director recibe el aviso');
  assert.notEqual(T.accionable(e, 'director').digest, '');
  assert.equal(e.decisionesDueno.length, 0, 'no es una decisión del dueño');
  const s = T.salud(root); assert.equal(s.roles.builder.sin_novedad.pedido, 'D-001');
  assert.ok(s.alertas.some((a) => /Constructor \(Cursor\): 3 rondas sin trabajo/.test(a.msg)));
  atras(); assert.doesNotMatch(ronda(), /Ya le pedí/, 'no pide dos veces la misma solicitud');
  salida(root, 'tarea', 'Siguiente lote', '--criterio=a', '--sin-contexto');
  assert.match(fs.readFileSync(canal.rutaCanal(root), 'utf8'), /Atendida [^\n]*el Director encoló T-001/);
  assert.equal(T.calcular(root).solicitudes.length, 0);
  assert.ok(!T.accionable(T.calcular(root), 'director').razones.some((x) => /SOLICITUD DEL CONSTRUCTOR/.test(x)));
});

test('OCIO-2 — si el constructor reporta algo, la cuenta de rondas iguales vuelve a empezar; en modo individual no se pide nada', () => {
  const root = proyecto(); arrancado(root); const restaurar = stubPostCycle(root);
  try {
    const estadoF = path.join(root, '.agentic', '_teams', 'estado.json');
    const atras = () => { const est = JSON.parse(fs.readFileSync(estadoF, 'utf8')); if (est.sinNovedad && est.sinNovedad.builder) est.sinNovedad.builder.ultimo -= 100000; fs.writeFileSync(estadoF, JSON.stringify(est)); };
    salida(root, 'tarea', 'Algo', '--criterio=a', '--sin-contexto');
    salida(root, 'ronda', '--rol=builder'); atras(); salida(root, 'ronda', '--rol=builder'); atras();
    salida(root, 'reportar', 'T-001', '--estado=PARCIAL', '--detalle=voy por la mitad del módulo');
    atras(); salida(root, 'ronda', '--rol=builder');
    assert.equal(JSON.parse(fs.readFileSync(estadoF, 'utf8')).sinNovedad.builder.n, 1, 'reportar reinicia la cuenta');
  } finally { restaurar(); }
  const ind = proyecto(); salida(ind, 'activar'); salida(ind, 'modo', 'individual'); salida(ind, 'iniciar');
  for (let i = 0; i < 4; i++) { const est = JSON.parse(fs.readFileSync(path.join(ind, '.agentic', '_teams', 'estado.json'), 'utf8')); fs.writeFileSync(path.join(ind, '.agentic', '_teams', 'estado.json'), JSON.stringify(est)); assert.doesNotMatch(salida(ind, 'ronda', '--rol=builder'), /SIN TRABAJO/); }
});

test('OCIO-3 — con trabajo esperando, sin vigilante y ~10 min sin rondas, el Director recibe CONSTRUCTOR_DORMIDO (solo el dueño puede despertar a Cursor)', () => {
  const root = proyecto(); arrancado(root);
  salida(root, 'tarea', 'Algo', '--criterio=a', '--sin-contexto');
  const estadoF = path.join(root, '.agentic', '_teams', 'estado.json');
  const poner = (minAtras) => { const est = JSON.parse(fs.readFileSync(estadoF, 'utf8')); est.rondas = { ...(est.rondas || {}), builder: Date.now() - minAtras * 60000 }; fs.writeFileSync(estadoF, JSON.stringify(est)); };
  const razones = () => T.accionable(T.calcular(root), 'director').razones.filter((x) => /CONSTRUCTOR_DORMIDO/.test(x));
  assert.equal(razones().length, 0, 'sin haber hecho nunca una ronda no se le llama dormido');
  poner(4); assert.equal(razones().length, 0, 'una ronda reciente: está vivo');
  poner(15); assert.match(razones()[0], /lleva ~15 min sin hacer rondas.*solo él puede despertarlo/);
  vigilanteFalso(root, 'builder'); assert.equal(razones().length, 0, 'con su vigilante vivo no está dormido');
});

test('OFICINA-3 — la decisión del dueño llega al tablero con su pregunta, opciones y recomendación, y desaparece al resolverse', () => {
  const root = proyecto(); arrancado(root);
  salida(root, 'decision', '¿Qué proveedor de correo uso para las confirmaciones?', '--tipo=dueno', '--opciones=Resend|SES', '--recomendacion=Resend: menos configuración');
  let s = T.salud(root); const d = s.cola.decisiones_dueno;
  assert.equal(d.length, 1); assert.equal(d[0].id, 'D-001');
  assert.match(d[0].titulo, /proveedor de correo/);
  assert.equal(d[0].opciones, 'Resend|SES'); assert.match(d[0].recomendacion, /Resend: menos configuración/);
  assert.match(d[0].desde || '', /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/);
  salida(root, 'decidir', 'D-001', 'Resend', '--porque=ya lo usamos');
  s = T.salud(root); assert.equal(s.cola.decisiones_dueno.length, 0, 'resuelta: sale del tablero');
});

test('OCIO-4 — con una tarea sin empezar y SIN archivos tocados: a la 2.ª ronda se le dice que no espere en silencio (reportar BLOQUEADO) y a la 3.ª se pregunta al Director; con archivos recientes espera 8', () => {
  const root = proyecto(); arrancado(root);
  salida(root, 'tarea', 'Una tarea que no se empieza', '--criterio=a', '--sin-contexto');
  const estadoF = path.join(root, '.agentic', '_teams', 'estado.json');
  const atras = () => { const est = JSON.parse(fs.readFileSync(estadoF, 'utf8')); if (est.sinNovedad && est.sinNovedad.builder) est.sinNovedad.builder.ultimo -= 100000; fs.writeFileSync(estadoF, JSON.stringify(est)); };
  const ronda = () => salida(root, 'ronda', '--rol=builder');
  process.env.AKDD_TEAMS_ULTIMO_CAMBIO = String(Date.now() - 30 * 60000);   // el último archivo tocado fue hace 30 min
  try {
    assert.doesNotMatch(ronda(), /SIN EMPEZARLA/);
    atras(); const r2 = ronda();
    assert.match(r2, /LLEVAS 2 RONDAS VIENDO T-001 SIN EMPEZARLA/); assert.match(r2, /reportar T-001 --estado=BLOQUEADO/);
    atras(); const r3 = ronda();
    assert.doesNotMatch(r3, /SIN EMPEZARLA/, 'el aviso de silencio sale una sola vez');
    assert.match(r3, /SIN TRABAJO\. Ya le pedí tareas al Director en D-001/, 'a la 3.ª ronda sin archivos tocados se pregunta al Director (no a la 8.ª)');
  } finally { delete process.env.AKDD_TEAMS_ULTIMO_CAMBIO; }
  const activo = proyecto(); arrancado(activo); salida(activo, 'tarea', 'Tarea larga', '--criterio=a', '--sin-contexto');
  const estadoA = path.join(activo, '.agentic', '_teams', 'estado.json');
  process.env.AKDD_TEAMS_ULTIMO_CAMBIO = String(Date.now() - 60000);          // acaba de tocar archivos: está trabajando
  try {
    for (let i = 0; i < 5; i++) { const est = JSON.parse(fs.readFileSync(estadoA, 'utf8')); if (est.sinNovedad && est.sinNovedad.builder) est.sinNovedad.builder.ultimo -= 100000; fs.writeFileSync(estadoA, JSON.stringify(est)); assert.doesNotMatch(salida(activo, 'ronda', '--rol=builder'), /SIN TRABAJO|SIN EMPEZARLA/); }
  } finally { delete process.env.AKDD_TEAMS_ULTIMO_CAMBIO; }
});

test('OCIO-5 — Cursor parado: evidencia en la solicitud y en el aviso al Director, mensaje listo para pegarle en su chat, diagnóstico por comando y la ronda no deja cerrar con un resumen', () => {
  const root = proyecto(); arrancado(root);
  salida(root, 'tarea', 'Prueba en vivo de la falla a mitad del alta', '--criterio=a', '--sin-contexto');
  const estadoF = path.join(root, '.agentic', '_teams', 'estado.json');
  const atras = () => { const est = JSON.parse(fs.readFileSync(estadoF, 'utf8')); if (est.sinNovedad && est.sinNovedad.builder) est.sinNovedad.builder.ultimo -= 100000; fs.writeFileSync(estadoF, JSON.stringify(est)); };
  process.env.AKDD_TEAMS_ULTIMO_CAMBIO = String(Date.now() - 30 * 60000);
  try {
    const r1 = salida(root, 'ronda', '--rol=builder');
    assert.match(r1, /ESTE TURNO NO TERMINA CON UN RESUMEN/, 'con trabajo pendiente la ronda lo exige');
    atras(); salida(root, 'ronda', '--rol=builder'); atras(); salida(root, 'ronda', '--rol=builder');
    assert.match(fs.readFileSync(canal.rutaCanal(root), 'utf8'), /Evidencia: último archivo tocado hace 30 min[^\n]*sin reportes suyos[^\n]*→ PARADO\./);
    const rz = T.accionable(T.calcular(root), 'director').razones.find((x) => /SOLICITUD DEL CONSTRUCTOR/.test(x));
    assert.match(rz, /\[último archivo tocado hace 30 min/, 'el Director ve la evidencia en su aviso');
    const al = T.salud(root).alertas.find((a) => /rondas sin trabajo/.test(a.msg));
    assert.match(al.msg, /Probablemente terminó su turno y espera que le escribas: pégale en su chat «Continúa con T-001: Prueba en vivo de la falla a mitad del alta\. Después sigue con el resto de la cola\. No te detengas a resumir/);
    const d = salida(root, 'diagnostico');
    assert.match(d, /DIAGNÓSTICO DEL CONSTRUCTOR: PARADO/); assert.match(d, /pendientes: T-001/); assert.match(d, /PARECE PARADO[\s\S]*«Continúa con T-001/);
  } finally { delete process.env.AKDD_TEAMS_ULTIMO_CAMBIO; }
  process.env.AKDD_TEAMS_ULTIMO_CAMBIO = String(Date.now() - 60000);
  try { assert.match(salida(root, 'diagnostico'), /DIAGNÓSTICO DEL CONSTRUCTOR: TRABAJANDO[\s\S]*no lo interrumpas/); } finally { delete process.env.AKDD_TEAMS_ULTIMO_CAMBIO; }
});
