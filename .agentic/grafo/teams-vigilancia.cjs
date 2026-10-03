'use strict';

/**
 * Vigilancia PROPIA de TEAMS: la tarea de Windows, el proceso del watch, su apagado y lo que el host da de verdad
 * (spec TEAMS §6 y §12).
 *
 * Qué hace este módulo y qué NO:
 *   · El Programador de tareas inicia y supervisa UN proceso Node con fs.watch (teams-watch.cjs). La tarea por sí
 *     sola no se suscribe a las ediciones del MD ni despierta a ningún chat.
 *   · Ese proceso DETECTA. Que Claude Code o Cursor lean de verdad lo detectado depende del loop de su sesión (cada
 *     180 s) o de un adapter que lo confirme. `capacidades()` declara EVENT_WAKE_UNSUPPORTED / MANUAL_ONLY según
 *     corresponda: no se anuncia una autonomía que el host no da.
 *   · Instalar es una decisión de la persona: sin `aprobar:true` solo se MUESTRA el script. Nada de esto se invoca
 *     al actualizar Agentix. Sin privilegios altos (RunLevel Limited, logon interactivo del propio usuario), sin
 *     contraseñas, con todos los valores escapados.
 *   · Solo se toca lo PROPIO: la tarea registrada por este módulo (nombre por proyecto + rol + usuario, anotada en
 *     `vigilancia-recursos.json`) y el proceso cuyo pid y línea de comandos prueban que es nuestro watch. Jamás se
 *     mata por nombre (`node`, `claude`, `cursor`) ni se toca una tarea ajena.
 *   · Apagar VERIFICA (tarea ausente, proceso muerto, latido retirado). Si algo sigue vivo: STOP_FAILED con el
 *     diagnóstico, no un «apagado» declarado.
 *   · El lanzador oculto se COMPRUEBA en la máquina: `conhost --headless` no existe en toda instalación de Windows 10.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');

const PREFIJO_TAREA = 'AgentixTeams-';
const DESCRIPCION = 'Vigilante TEAMS de Agentix (propio, sin credenciales)';
const ROLES = ['builder', 'director'];
const INTERVALO_DEFECTO_MS = 180000;
const sha = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');

const dirTeams = (root) => path.join(root, '.agentic', '_teams');
const archivoRegistro = (root) => path.join(dirTeams(root), 'vigilancia-recursos.json');
const archivoLatido = (root, rol) => path.join(dirTeams(root), 'heartbeat-' + rol + '.json');
const leerJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

function escribirAtomico(f, contenido) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.' + process.pid + '.' + crypto.randomBytes(3).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, contenido);
  fs.renameSync(tmp, f);
}

// ───────────────────────────── identidad ────────────────────────────────────

const hashProyecto = (root) => sha(path.resolve(root).toLowerCase()).slice(0, 8);
const usuarioActual = () => { try { return os.userInfo().username || 'usuario'; } catch { return process.env.USERNAME || process.env.USER || 'usuario'; } };

/** Un nombre por proyecto + rol + usuario: dos proyectos, dos roles o dos usuarios de la misma máquina no se pisan. */
function nombreTarea(root, rol, usuario) {
  return PREFIJO_TAREA + hashProyecto(root) + '-' + rol + '-' + sha(String(usuario || usuarioActual()).toLowerCase()).slice(0, 4);
}
/** Marca en la línea de comandos: es lo que prueba que un pid es NUESTRO watch. */
const idVigilante = (root, rol) => hashProyecto(root) + '-' + rol;

// ───────────────────────────── PowerShell ───────────────────────────────────

/** Literal entre comillas simples de PowerShell. Rechaza lo que no se puede escapar con seguridad. */
function psq(valor) {
  const s = String(valor);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) { const e = new Error('VALOR_NO_ESCAPABLE: contiene caracteres de control'); e.code = 'VALOR_NO_ESCAPABLE'; throw e; }
  return "'" + s.replace(/['‘’‚‛]/g, (c) => c + c) + "'";
}

/** Ejecuta PowerShell sin pasar el script por una línea de comandos: -EncodedCommand no tiene problemas de comillas. */
function ejecutarPowerShell(script, { timeoutMs = 30000 } = {}) {
  const b64 = Buffer.from(String(script), 'utf16le').toString('base64');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64], { encoding: 'utf8', windowsHide: true, timeout: timeoutMs });
  return { status: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || ''), error: r.error ? r.error.code || r.error.message : null };
}

const esWindows = (o) => (o && o.plataforma ? o.plataforma : process.platform) === 'win32';

/**
 * ¿Qué lanzador oculto existe de verdad en ESTA máquina?
 *   conhost-headless    el proceso corre sin ventana (si `conhost --headless` responde)
 *   powershell-oculto   PowerShell con la ventana oculta (puede verse un parpadeo al arrancar)
 *   directo             node.exe tal cual (ventana de consola visible)
 */
function detectarLanzadores(opts = {}) {
  if (opts.lanzadores) return opts.lanzadores;
  if (!esWindows(opts)) return { elegido: 'directo', disponibles: ['directo'], comprobado: false, nota: 'no es Windows' };
  const disponibles = [];
  try {
    const r = spawnSync('conhost.exe', ['--headless', process.env.ComSpec || 'cmd.exe', '/c', 'exit', '0'], { timeout: 8000, windowsHide: true });
    if (r.status === 0 && !r.error) disponibles.push('conhost-headless');
  } catch { /* no disponible */ }
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { timeout: 15000, windowsHide: true });
    if (r.status === 0 && !r.error) disponibles.push('powershell-oculto');
  } catch { /* no disponible */ }
  disponibles.push('directo');
  return { elegido: disponibles[0], disponibles, comprobado: true };
}

// ───────────────────────────── la tarea ─────────────────────────────────────

/**
 * Descriptor de la tarea para un proyecto y rol: el comando exacto, el script de cada operación y los límites.
 * No ejecuta nada.
 */
function generarTarea(root, rol, opts = {}) {
  if (!ROLES.includes(rol)) { const e = new Error('ROL_DESCONOCIDO: ' + rol); e.code = 'ROL_DESCONOCIDO'; throw e; }
  const raiz = path.resolve(root);
  const usuario = opts.usuario || usuarioActual();
  const nombre = nombreTarea(raiz, rol, usuario);
  const id = idVigilante(raiz, rol);
  const nodo = opts.node || process.execPath;
  const script = path.join(raiz, '.agentic', 'grafo', 'teams-watch.cjs');
  const log = path.join(dirTeams(raiz), 'watch-' + rol + '.log');
  const intervalo = Number(opts.intervaloMs) > 0 ? Number(opts.intervaloMs) : INTERVALO_DEFECTO_MS;
  const lanz = opts.lanzador || detectarLanzadores(opts).elegido;
  const argsWatch = ['--rol=' + rol, '--entregar', '--vigilante=' + id, '--intervalo=' + intervalo, '--log=' + log];
  let ejecutable; let argumentos;
  if (lanz === 'conhost-headless') {
    ejecutable = 'conhost.exe';
    argumentos = ['--headless', '"' + nodo + '"', '"' + script + '"', ...argsWatch.map((a) => (/\s/.test(a) ? '"' + a + '"' : a))].join(' ');
  } else if (lanz === 'powershell-oculto') {
    ejecutable = 'powershell.exe';
    const cmd = '& ' + psq(nodo) + ' ' + [psq(script), ...argsWatch.map(psq)].join(' ');
    argumentos = '-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ' + Buffer.from(cmd, 'utf16le').toString('base64');
  } else {
    ejecutable = nodo;
    argumentos = ['"' + script + '"', ...argsWatch.map((a) => (/\s/.test(a) ? '"' + a + '"' : a))].join(' ');
  }
  const consulta = (n) => [
    '$ErrorActionPreference = \'Stop\'',
    `$t = Get-ScheduledTask -TaskName ${psq(n)} -ErrorAction SilentlyContinue`,
    "if (-not $t) { '{\"instalada\":false}'; exit 0 }",
    `$i = Get-ScheduledTaskInfo -TaskName ${psq(n)}`,
    '[pscustomobject]@{ instalada = $true; estado = "$($t.State)"; ejecutable = $t.Actions[0].Execute; argumentos = $t.Actions[0].Arguments; directorio = $t.Actions[0].WorkingDirectory; usuario = $t.Principal.UserId; nivel = "$($t.Principal.RunLevel)"; logon = "$($t.Principal.LogonType)"; descripcion = $t.Description; ultima_ejecucion = "$($i.LastRunTime)"; ultimo_resultado = $i.LastTaskResult } | ConvertTo-Json -Compress',
  ].join('\n');
  return {
    nombre, rol, usuario, vigilante: id, lanzador: lanz, oculto: lanz === 'conhost-headless' ? 'sí (conhost --headless, comprobado en esta máquina)' : lanz === 'powershell-oculto' ? 'ventana oculta (puede verse un parpadeo)' : 'no: node.exe con consola visible',
    accion: { ejecutable, argumentos, directorio: raiz }, log, intervalo_ms: intervalo,
    instalar: [
      '$ErrorActionPreference = \'Stop\'',
      '$usuario = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name',
      `$a = New-ScheduledTaskAction -Execute ${psq(ejecutable)} -Argument ${psq(argumentos)} -WorkingDirectory ${psq(raiz)}`,
      // Arranque con el inicio de sesión + un disparo repetido que lo REINICIA si murió (MultipleInstances IgnoreNew evita duplicados).
      '$t1 = New-ScheduledTaskTrigger -AtLogOn -User $usuario',
      '$t2 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)',
      // Sin privilegios altos ni credenciales: el propio usuario, sesión interactiva, nivel limitado.
      '$p = New-ScheduledTaskPrincipal -UserId $usuario -LogonType Interactive -RunLevel Limited',
      '$s = New-ScheduledTaskSettingsSet -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -MultipleInstances IgnoreNew -Hidden',
      // -Force: reinstalar la misma tarea la reemplaza (idempotente).
      `Register-ScheduledTask -TaskName ${psq(nombre)} -Action $a -Trigger @($t1, $t2) -Settings $s -Principal $p -Description ${psq(DESCRIPCION)} -Force | Out-Null`,
      // Arranque inmediato: no se espera al próximo inicio de sesión.
      `Start-ScheduledTask -TaskName ${psq(nombre)}`,
    ].join('\n'),
    estado: consulta(nombre),
    desinstalar: [
      '$ErrorActionPreference = \'Stop\'',
      `Stop-ScheduledTask -TaskName ${psq(nombre)} -ErrorAction SilentlyContinue`,
      `Unregister-ScheduledTask -TaskName ${psq(nombre)} -Confirm:$false`,
    ].join('\n'),
    limites: [
      'instalar es una decisión de la persona: sin aprobación solo se muestra este script',
      'la tarea mantiene vivo UN proceso con fs.watch; no despierta al modelo ni entra al chat del IDE',
      'sin un adapter que confirme la lectura (VISTO) el proceso no hace ACK: una tarea que solo imprime no cierra la integración',
      'sin privilegios altos, sin contraseñas; solo recursos propios registrados en vigilancia-recursos.json',
    ],
  };
}

// ───────────────────────────── registro de recursos propios ─────────────────

function leerRegistro(root) { return leerJson(archivoRegistro(root), { schema: 1, tareas: {}, procesos: {} }); }
function guardarRegistro(root, reg) { escribirAtomico(archivoRegistro(root), JSON.stringify(reg, null, 2)); }

/** Consulta la tarea. Sin Windows o sin ejecutor: consultada:false (desconocido, no «no instalada»). */
function consultarTarea(root, rol, opts = {}) {
  const t = generarTarea(root, rol, opts);
  if (!esWindows(opts) && !opts.ejecutorPS) return { nombre: t.nombre, consultada: false, instalada: null, motivo: 'PLATAFORMA_NO_WINDOWS' };
  const ejec = opts.ejecutorPS || ejecutarPowerShell;
  const r = ejec(t.estado);
  if (r.status !== 0) return { nombre: t.nombre, consultada: false, instalada: null, motivo: 'CONSULTA_FALLIDA', detalle: (r.stderr || r.error || '').slice(0, 200) };
  let j = null;
  try { j = JSON.parse(r.stdout.trim().split(/\r?\n/).pop()); } catch { return { nombre: t.nombre, consultada: false, instalada: null, motivo: 'RESPUESTA_ILEGIBLE' }; }
  if (!j.instalada) return { nombre: t.nombre, consultada: true, instalada: false };
  // Se diagnostica lo INSTALADO de verdad contra lo esperado (no se asume que coincide).
  const drift = [];
  if (String(j.ejecutable).toLowerCase() !== t.accion.ejecutable.toLowerCase()) drift.push('EJECUTABLE_DISTINTO');
  if (String(j.argumentos) !== t.accion.argumentos) drift.push('ARGUMENTOS_DISTINTOS');
  if (path.resolve(String(j.directorio || '')).toLowerCase() !== t.accion.directorio.toLowerCase()) drift.push('DIRECTORIO_DISTINTO');
  if (/highest/i.test(String(j.nivel))) drift.push('PRIVILEGIOS_ALTOS');
  if (!String(j.descripcion || '').includes('Vigilante TEAMS de Agentix')) drift.push('NO_ES_NUESTRA');
  return { nombre: t.nombre, consultada: true, instalada: true, estado: j.estado, usuario: j.usuario, nivel: j.nivel, logon: j.logon, ultima_ejecucion: j.ultima_ejecucion, ultimo_resultado: j.ultimo_resultado, accion_instalada: { ejecutable: j.ejecutable, argumentos: j.argumentos, directorio: j.directorio }, coincide: drift.length === 0, drift };
}

/**
 * Instala la tarea. SIN `aprobar:true` solo devuelve el script (REQUIERE_APROBACION): ninguna actualización de
 * Agentix ni ningún flujo automático instala nada persistente. Idempotente: reinstalar reemplaza la misma tarea.
 */
function instalarTarea(root, rol, opts = {}) {
  const t = generarTarea(root, rol, opts);
  if (!opts.aprobar) return { status: 'REQUIERE_APROBACION', nombre: t.nombre, lanzador: t.lanzador, oculto: t.oculto, script: t.instalar, limites: t.limites, comando: 'node .agentic/grafo/teams-vigilancia.cjs instalar --rol=' + rol + ' --aprobar' };
  if (!esWindows(opts) && !opts.ejecutorPS) return { status: 'PLATAFORMA_NO_SOPORTADA', nombre: t.nombre, nota: 'el Programador de tareas es de Windows; en otros sistemas inicia el watch con `iniciar`' };
  const ejec = opts.ejecutorPS || ejecutarPowerShell;
  const r = ejec(t.instalar);
  if (r.status !== 0) return { status: 'INSTALACION_FALLIDA', nombre: t.nombre, detalle: (r.stderr || r.error || '').slice(0, 400), script: t.instalar };
  const reg = leerRegistro(root);
  reg.tareas[t.nombre] = { rol, usuario: t.usuario, vigilante: t.vigilante, lanzador: t.lanzador, accion: t.accion, instalada_at: new Date().toISOString(), raiz: path.resolve(root) };
  guardarRegistro(root, reg);
  const est = consultarTarea(root, rol, opts);
  return { status: est.instalada && est.coincide ? 'INSTALADA' : (est.instalada ? 'INSTALADA_CON_DIFERENCIAS' : 'NO_VERIFICADA'), nombre: t.nombre, lanzador: t.lanzador, oculto: t.oculto, verificacion: est };
}

/** Si lo instalado difiere de lo esperado (o falta), la reinstala. Misma regla de aprobación. */
function repararTarea(root, rol, opts = {}) {
  const est = consultarTarea(root, rol, opts);
  if (est.consultada && est.instalada && est.coincide) return { status: 'SIN_CAMBIOS', verificacion: est };
  if (est.consultada === false && !opts.ejecutorPS) return { status: 'NO_VERIFICABLE', verificacion: est };
  const r = instalarTarea(root, rol, opts);
  return Object.assign({ antes: est }, r);
}

/** Retira SOLO la tarea registrada por este módulo (nombre + registro + marca en su descripción). */
function desinstalarTarea(root, rol, opts = {}) {
  const t = generarTarea(root, rol, opts);
  const reg = leerRegistro(root);
  if (!reg.tareas[t.nombre]) {
    const est = consultarTarea(root, rol, opts);
    return { status: est.instalada ? 'NO_REGISTRADA_COMO_PROPIA' : 'NO_INSTALADA', nombre: t.nombre, nota: est.instalada ? 'existe una tarea con ese nombre que este módulo no registró: no se toca' : null };
  }
  if (!opts.aprobar) return { status: 'REQUIERE_APROBACION', nombre: t.nombre, script: t.desinstalar };
  if (!esWindows(opts) && !opts.ejecutorPS) return { status: 'PLATAFORMA_NO_SOPORTADA', nombre: t.nombre };
  const antes = consultarTarea(root, rol, opts);
  if (antes.instalada && antes.drift && antes.drift.includes('NO_ES_NUESTRA')) return { status: 'NO_ES_PROPIA', nombre: t.nombre, nota: 'la tarea con ese nombre ya no es la que registramos: no se toca' };
  const ejec = opts.ejecutorPS || ejecutarPowerShell;
  if (antes.instalada !== false) { const r = ejec(t.desinstalar); if (r.status !== 0) return { status: 'DESINSTALACION_FALLIDA', nombre: t.nombre, detalle: (r.stderr || r.error || '').slice(0, 300) }; }
  const despues = consultarTarea(root, rol, opts);
  if (despues.instalada === true) return { status: 'STOP_FAILED', nombre: t.nombre, diagnostico: ['la tarea sigue registrada tras Unregister-ScheduledTask'] };
  delete reg.tareas[t.nombre];
  guardarRegistro(root, reg);
  return { status: 'DESINSTALADA', nombre: t.nombre, verificada: despues.consultada === true };
}

// ───────────────────────────── el proceso del watch ─────────────────────────

const vivo = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); } };

/** Línea de comandos de un pid (para probar que es NUESTRO watch). null si no se puede leer. */
function cmdlineDe(pid, opts = {}) {
  if (opts.lectorCmdline) return opts.lectorCmdline(pid);
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}').CommandLine`], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
      const t = String(r.stdout || '').trim();
      return r.status === 0 && t ? t : null;
    }
    try { return fs.readFileSync('/proc/' + Number(pid) + '/cmdline', 'utf8').replace(/\0/g, ' ').trim() || null; } catch { /* sin /proc */ }
    const r = spawnSync('ps', ['-o', 'args=', '-p', String(Number(pid))], { encoding: 'utf8', timeout: 5000 });
    const t = String(r.stdout || '').trim();
    return r.status === 0 && t ? t : null;
  } catch { return null; }
}

/** El proceso del watch de un rol: vivo, propio (pid + línea de comandos) y con latido reciente. */
function procesoPropio(root, rol, opts = {}) {
  const lat = leerJson(archivoLatido(root, rol), null);
  const id = idVigilante(root, rol);
  if (!lat || !Number.isInteger(lat.pid)) return { hay_latido: false, pid: null, vivo: false, propio: null };
  const edad = Date.now() - Date.parse(lat.at);
  const intervalo = Number(lat.intervalo_ms) || INTERVALO_DEFECTO_MS;
  const base = { hay_latido: true, pid: lat.pid, latido_at: lat.at, edad_ms: Number.isFinite(edad) ? edad : null, intervalo_ms: intervalo, vigilancia: lat.vivo || null, pases: lat.pases, detectados: lat.detectados, aceptados: lat.aceptados, vigilante: lat.vigilante || null };
  const estaVivo = vivo(lat.pid);
  if (!estaVivo) return Object.assign(base, { vivo: false, propio: null, vigente: false, motivo: 'PID_NO_EXISTE' });
  const cmd = cmdlineDe(lat.pid, opts);
  const propio = cmd == null ? null : (cmd.includes('teams-watch.cjs') && cmd.includes('--vigilante=' + id));
  // Vigente: latido dentro de ~2,5 intervalos (el latido se escribe en cada tick del respaldo).
  const vigente = Number.isFinite(edad) && edad <= intervalo * 2.5 + 10000;
  return Object.assign(base, { vivo: true, propio, vigente, cmdline_leida: cmd != null });
}

/**
 * Inicia el watch PROPIO de un rol como proceso aparte (sin tarea de Windows). Idempotente: si ya hay uno vivo y
 * propio, no duplica. Es el modo de arranque manual y el de los sistemas que no son Windows.
 */
function iniciarProceso(root, rol, opts = {}) {
  const previo = procesoPropio(root, rol, opts);
  if (previo.vivo && previo.propio && previo.vigente) return { status: 'YA_ACTIVO', pid: previo.pid };
  const id = idVigilante(root, rol);
  const script = path.join(path.resolve(root), '.agentic', 'grafo', 'teams-watch.cjs');
  if (!fs.existsSync(script)) return { status: 'SIN_MOTOR', detalle: 'falta .agentic/grafo/teams-watch.cjs' };
  const args = [script, '--rol=' + rol, '--entregar', '--vigilante=' + id, '--intervalo=' + (opts.intervaloMs || INTERVALO_DEFECTO_MS), '--log=' + path.join(dirTeams(root), 'watch-' + rol + '.log')];
  const hijo = spawn(opts.node || process.execPath, args, { cwd: path.resolve(root), detached: true, stdio: 'ignore', windowsHide: true });
  hijo.unref();
  const limite = Date.now() + (opts.esperaMs || 8000);
  while (Date.now() < limite) {
    const lat = leerJson(archivoLatido(root, rol), null);
    if (lat && lat.pid === hijo.pid) {
      const reg = leerRegistro(root);
      reg.procesos[rol] = { pid: hijo.pid, vigilante: id, iniciado_at: new Date().toISOString() };
      guardarRegistro(root, reg);
      return { status: 'INICIADO', pid: hijo.pid, vigilante: id };
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  return { status: 'SIN_LATIDO', pid: hijo.pid, detalle: 'el proceso no escribió su latido en el tiempo esperado' };
}

// ───────────────────────────── estado ───────────────────────────────────────

/** Estado completo de la vigilancia de un rol: tarea (si se puede consultar), proceso, latido y veredicto. */
function estado(root, rol, opts = {}) {
  const tarea = opts.consultarSistema === false ? { consultada: false, instalada: null, motivo: 'NO_CONSULTADA' } : consultarTarea(root, rol, opts);
  const proc = procesoPropio(root, rol, opts);
  const reg = leerRegistro(root);
  const nombre = nombreTarea(root, rol, opts.usuario);
  let veredicto;
  if (proc.vivo && proc.propio && proc.vigente) veredicto = 'ACTIVA';
  else if (proc.vivo && proc.propio === false) veredicto = 'PID_AJENO';
  else if (proc.vivo && proc.vigente && proc.propio === null) veredicto = 'ACTIVA_PROPIEDAD_NO_VERIFICADA'; // latido vigente de un pid vivo, sin poder leer su línea de comandos
  else if (tarea.instalada === true) veredicto = 'INSTALADA_SIN_PROCESO_VIGENTE';
  else if (proc.hay_latido) veredicto = 'LATIDO_OBSOLETO';
  else if (tarea.instalada === false) veredicto = 'NO_INSTALADA';
  else veredicto = 'DESCONOCIDA';
  return { rol, plataforma: process.platform, vigilante: idVigilante(root, rol), tarea, proceso: proc, registrada: !!reg.tareas[nombre], veredicto, vigilancia: proc.vigilancia || null };
}

// ───────────────────────────── apagado ──────────────────────────────────────

function esperarMuerte(pid, ms) {
  const limite = Date.now() + ms;
  while (Date.now() < limite) { if (!vivo(pid)) return true; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); }
  return !vivo(pid);
}

/**
 * Apaga los vigilantes PROPIOS de un rol y VERIFICA: (1) la tarea registrada por este módulo, (2) el proceso del
 * watch si su pid y su línea de comandos prueban que es nuestro, (3) el latido residual. El loop del HOST (el que
 * vive en la sesión de Claude/Cursor) no lo puede detener este proceso: se declara como acción de la sesión.
 * Si algo propio sigue vivo: STOP_FAILED con el diagnóstico. Nunca se mata por nombre ni se toca lo ajeno.
 */
function apagarVigilantes(root, rol, opts = {}) {
  const diag = [];
  const hecho = { tarea: 'NO_APLICA', proceso: 'NO_HABIA', latido: 'NO_HABIA' };
  const reg = leerRegistro(root);
  const nombre = nombreTarea(root, rol, opts.usuario);
  // 1. La tarea propia (solo si este módulo la registró).
  if (reg.tareas[nombre]) {
    if (esWindows(opts) || opts.ejecutorPS) {
      const r = desinstalarTarea(root, rol, Object.assign({}, opts, { aprobar: true }));
      hecho.tarea = r.status;
      if (!['DESINSTALADA', 'NO_INSTALADA'].includes(r.status)) diag.push('tarea ' + nombre + ': ' + r.status + (r.diagnostico ? ' (' + r.diagnostico.join('; ') + ')' : ''));
    } else { hecho.tarea = 'PLATAFORMA_NO_SOPORTADA'; diag.push('la tarea ' + nombre + ' está registrada pero esta plataforma no puede consultarla'); }
  }
  // 2. El proceso del watch: solo con pid vivo Y línea de comandos propia.
  const p = procesoPropio(root, rol, opts);
  if (p.hay_latido && p.vivo) {
    if (p.propio === true) {
      try { process.kill(p.pid); } catch (e) { diag.push('no se pudo enviar la señal de parada al pid ' + p.pid + ': ' + (e && e.code)); }
      const murio = esperarMuerte(p.pid, opts.esperaMs || 8000);
      hecho.proceso = murio ? 'DETENIDO' : 'SIGUE_VIVO';
      if (!murio) diag.push('el proceso propio pid ' + p.pid + ' sigue vivo tras la señal de parada');
    } else {
      // pid vivo pero que NO podemos probar nuestro (otra cosa reutilizó el pid, o no se pudo leer su línea de comandos): no se toca.
      hecho.proceso = p.propio === false ? 'NO_ES_PROPIO_NO_SE_TOCA' : 'NO_VERIFICABLE_NO_SE_TOCA';
      diag.push('el pid ' + p.pid + ' del latido está vivo pero ' + (p.propio === false ? 'su línea de comandos no es la del watch de este proyecto/rol' : 'no se pudo leer su línea de comandos') + ': NO se detiene (no es demostrablemente nuestro)');
    }
  } else if (p.hay_latido) hecho.proceso = 'YA_NO_EXISTIA';
  // 3. El latido residual (recurso propio): se retira solo cuando ya no hay proceso propio vivo detrás.
  const sigue = hecho.proceso === 'SIGUE_VIVO' || String(hecho.proceso).startsWith('NO_');
  if (p.hay_latido && !sigue) { try { fs.unlinkSync(archivoLatido(root, rol)); hecho.latido = 'RETIRADO'; } catch { hecho.latido = 'NO_SE_PUDO_RETIRAR'; diag.push('no se pudo retirar el latido'); } }
  else if (p.hay_latido) hecho.latido = 'CONSERVADO';
  if (reg.procesos[rol] && !sigue) { delete reg.procesos[rol]; reg.apagados = Object.assign(reg.apagados || {}, { [rol]: new Date().toISOString() }); guardarRegistro(root, reg); }
  // 4. Verificación final contra el sistema (no contra lo que acabamos de hacer).
  const despues = procesoPropio(root, rol, opts);
  const verificacion = { proceso_vivo: despues.hay_latido ? !!despues.vivo : false, latido_residual: despues.hay_latido, tarea_instalada: null };
  if (reg.tareas[nombre] && (esWindows(opts) || opts.ejecutorPS)) { const t = consultarTarea(root, rol, opts); verificacion.tarea_instalada = t.consultada ? t.instalada : null; if (t.instalada) diag.push('la tarea sigue instalada'); }
  const ok = diag.length === 0 && !verificacion.proceso_vivo;
  return {
    status: ok ? 'APAGADO' : 'STOP_FAILED', rol, hecho, verificacion, diagnostico: diag.length ? diag : null,
    loop_host: { estado: 'REQUIERE_ACCION_DE_LA_SESION', nota: 'el loop de 180 s vive en la sesión de ' + (rol === 'builder' ? 'Cursor' : 'Claude Code') + ': tras leer el cierre, la sesión debe detenerlo y confirmarlo por el canal (este proceso no puede pararlo)' },
  };
}

/** Apaga los de los dos roles. */
function apagarTodos(root, opts = {}) {
  const por_rol = Object.fromEntries(ROLES.map((r) => [r, apagarVigilantes(root, r, opts)]));
  return { status: Object.values(por_rol).every((r) => r.status === 'APAGADO') ? 'APAGADO' : 'STOP_FAILED', por_rol };
}

// ───────────────────────────── lo que el host da de verdad ──────────────────

function ultimoVisto(root, rol) {
  let lineas = [];
  try { lineas = fs.readFileSync(path.join(root, '.legion', 'cola-' + rol + '.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean); } catch { return null; }
  let ultimo = null;
  for (const l of lineas) { try { const m = JSON.parse(l); if (m && m.kind === 'VISTO' && m.at) { const t = Date.parse(m.at); if (Number.isFinite(t) && (!ultimo || t > ultimo.t)) ultimo = { t, at: m.at, hasta_seq: m.hasta_seq }; } } catch { /* línea ilegible */ } }
  return ultimo;
}

/**
 * Qué puede y qué NO puede hacer la vigilancia en este entorno. Honesto por construcción:
 *   deteccion         lo que el proceso Node ve (watch, respaldo, canal) según su latido
 *   despertar_modelo  EVENT_WAKE_UNSUPPORTED sin espera activa; EVENT_WAKE_POR_TAREA_DEL_HOST con `esperar --despertar` vivo como
 *                     tarea en segundo plano del host; EVENT_WAKE_VERIFICADO solo cuando la sesión confirma una lectura (VISTO) tras un aviso
 *   loop_host         MANUAL_ONLY si no hay rastro de un loop; DECLARADO_SIN_ACTIVIDAD / ACTIVO_OBSERVADO según el rastro
 *                     real (lecturas confirmadas por la sesión: VISTO), nunca por lo que la sesión dice de sí misma
 *   autonomia         qué se puede afirmar. Un hook, un proceso o una tarea de Windows no demuestran integración.
 */
function capacidades(root, rol, opts = {}) {
  const p = procesoPropio(root, rol, opts);
  const intervalo = (p.intervalo_ms) || INTERVALO_DEFECTO_MS;
  const v = ultimoVisto(root, rol);
  const ahora = Date.now();
  const deteccion = p.hay_latido && p.vivo && p.vigente
    ? { estado: 'ACTIVA', watcher: p.vigilancia ? (p.vigilancia.watcher ? 'VIVO' : 'MUERTO') : 'DESCONOCIDO', respaldo: p.vigilancia ? (p.vigilancia.timer ? 'VIVO' : 'MUERTO') : 'DESCONOCIDO', canal: p.vigilancia ? (p.vigilancia.canal ? 'VIVO' : 'NO_DISPONIBLE') : 'DESCONOCIDO', pid: p.pid, propio: p.propio }
    : { estado: p.hay_latido ? 'LATIDO_OBSOLETO_O_SIN_PROCESO' : 'SIN_PROCESO', watcher: 'DESCONOCIDO', respaldo: 'DESCONOCIDO', canal: 'DESCONOCIDO' };
  let adapterWake = null;
  try { adapterWake = opts.adapter && typeof opts.adapter.capabilities === 'function' ? opts.adapter.capabilities().wake : null; } catch { /* sin adapter */ }
  // Espera activa lanzada como TAREA EN SEGUNDO PLANO del host (`esperar --despertar`): al haber trabajo imprime
  // AGENT_LOOP_WAKE_<rol> y termina, y el host entrega eso a la sesión como notificación. Se declara VERIFICADO solo cuando
  // la sesión confirma después una lectura (VISTO posterior al aviso); un proceso vivo solo prueba que la espera existe.
  const wk = leerWake(root, rol);
  const wakeVivo = !!(wk && wk.esperando && pidVivo(wk.pid));
  const wakeProbado = !!(wk && wk.ultimo_wake_at && v && v.t >= Date.parse(wk.ultimo_wake_at));
  const VIA = 'tarea en segundo plano del host (esperar --despertar → AGENT_LOOP_WAKE_' + rol + ')';
  const despertar_modelo = adapterWake === 'EVENT' && opts.verificadoEnHost
    ? { estado: 'EVENT_WAKE_VERIFICADO', verificado: true }
    : wakeProbado
      ? { estado: 'EVENT_WAKE_VERIFICADO', verificado: true, via: VIA, ultimo_aviso_at: wk.ultimo_wake_at, lectura_confirmada_at: v.at }
      : wakeVivo
        ? { estado: 'EVENT_WAKE_POR_TAREA_DEL_HOST', verificado: false, via: VIA, desde: wk.desde, motivo: 'la espera activa está viva; falta que la sesión confirme una lectura (VISTO) tras un aviso para darla por verificada' }
        : { estado: 'EVENT_WAKE_UNSUPPORTED', verificado: false, motivo: 'no hay una espera activa viva: lanza `esperar --rol=' + rol + ' --despertar` como tarea en segundo plano del host para que el aviso llegue a la sesión; mientras tanto la sesión solo lee en su loop' };
  let loop_host;
  if (v && ahora - v.t <= intervalo * 2 + 15000) loop_host = { estado: 'ACTIVO_OBSERVADO', ultima_lectura_confirmada: v.at, hasta_seq: v.hasta_seq, nota: 'lecturas confirmadas por la propia sesión (VISTO); no prueba el intervalo exacto' };
  else if (v) loop_host = { estado: 'DECLARADO_SIN_ACTIVIDAD', ultima_lectura_confirmada: v.at, nota: 'hubo lecturas pero no recientes: el loop pudo detenerse' };
  else loop_host = { estado: 'MANUAL_ONLY', nota: 'sin rastro de lecturas confirmadas por la sesión: solo atiende cuando alguien le dice que lea' };
  const eventoOk = despertar_modelo.estado === 'EVENT_WAKE_VERIFICADO';
  const eventoDeclarado = despertar_modelo.estado === 'EVENT_WAKE_POR_TAREA_DEL_HOST';
  const autonomia = eventoOk && loop_host.estado === 'ACTIVO_OBSERVADO'
    ? 'POR_EVENTO_VERIFICADA: aviso por tarea del host + lectura confirmada + loop de respaldo observado'
    : eventoDeclarado
      ? 'POR_EVENTO_DECLARADA: espera activa viva como tarea del host; aún sin una lectura confirmada tras un aviso'
      : loop_host.estado === 'ACTIVO_OBSERVADO' && deteccion.estado === 'ACTIVA'
    ? 'PARCIAL: detección por evento + lectura periódica observada; el despertar por evento del modelo NO está soportado'
    : (loop_host.estado === 'ACTIVO_OBSERVADO' ? 'PARCIAL: lectura periódica observada; sin vigilancia por evento activa y el despertar por evento del modelo NO está soportado' : 'MANUAL: no se puede anunciar un modo autónomo');
  return { rol, intervalo_respaldo_ms: intervalo, deteccion, despertar_modelo, loop_host, autonomia, capacidad_completa: eventoOk && loop_host.estado === 'ACTIVO_OBSERVADO' };
}

/**
 * Medición del smoke de despertar (nivel C, host real): a partir de la hora de edición del MD y de lo que quedó
 * registrado (métricas del watch + VISTO de la sesión) clasifica si la lectura real ocurrió ANTES del próximo tick.
 * Distingue detección de atención: un host ocupado detecta rápido y atiende lento. No garantiza ningún SLA.
 */
function evaluarSmokeDespertar(root, rol, { editado_at, intervalo_ms = INTERVALO_DEFECTO_MS, objetivo_lab_ms = 15000 } = {}) {
  const t0 = Date.parse(editado_at);
  if (!Number.isFinite(t0)) return { status: 'PARAMETROS_INVALIDOS', motivo: 'editado_at no es una fecha' };
  let metricas = [];
  try { metricas = fs.readFileSync(path.join(dirTeams(root), 'metricas-' + rol + '.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { /* sin métricas */ }
  const m = metricas.find((x) => x.detectado_ms >= t0 - 1000);
  const v = ultimoVisto(root, rol);
  const detectado = m ? m.detectado_ms - t0 : null;
  const lectura = v && v.t >= t0 ? v.t - t0 : null;
  const ack = m && m.ack_ms ? m.ack_ms - t0 : null;
  let veredicto;
  if (detectado == null) veredicto = 'NO_DETECTADO';
  else if (lectura == null) veredicto = 'SOLO_DETECCION';
  else if (lectura < intervalo_ms) veredicto = 'LECTURA_ANTES_DEL_TICK';
  else veredicto = 'LECTURA_TARDIA';
  return { status: 'MEDIDO', rol, editado_at, detectado_ms: detectado, lectura_host_ms: lectura, ack_ms: ack, origen_deteccion: m ? m.origen : null, veredicto, objetivo_lab_cumplido: lectura != null ? lectura <= objetivo_lab_ms : false, nota: veredicto === 'SOLO_DETECCION' ? 'detectar no es leer: sin VISTO de la sesión no hay lectura real (EVENT_WAKE_UNSUPPORTED)' : 'una prueba sintética no garantiza un SLA universal' };
}

// ───────────────────────────── espera por evento (dentro del turno de la sesión) ──

/**
 * Espera BLOQUEANTE a que haya trabajo para un rol: el comando termina en cuanto el delta del rol (eventos
 * posteriores a su último ACK) deja de estar vacío, o al cumplirse `maxMs`. NO hace ACK ni consume nada: la sesión
 * confirma después con `visto`.
 *
 * Es la vía por la que un watch de archivos llega al MODELO sin que nadie finja despertar un chat ocioso: la sesión
 * (Cursor, Claude Code) deja este comando en su terminal y su host la retoma al terminar el comando. Si el host
 * corta los comandos largos, vuelve el loop de 180 s: por eso el loop nunca se elimina. Dos mecanismos
 * independientes dentro: fs.watch (señal de revisión y canal) y un sondeo de respaldo cada `sondeoMs`.
 */
/** Marca de la espera activa de un rol (.agentic/_teams/wake-<rol>.json): vive aparte del latido del watch. */
const archivoWake = (root, rol) => path.join(dirTeams(root), 'wake-' + rol + '.json');
function leerWake(root, rol) { try { return JSON.parse(fs.readFileSync(archivoWake(root, rol), 'utf8')); } catch { return null; } }
function marcarWake(root, rol, extra) {
  try {
    fs.mkdirSync(dirTeams(root), { recursive: true });
    const previa = leerWake(root, rol) || {};
    const tmp = archivoWake(root, rol) + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(Object.assign({}, previa, { rol, pid: process.pid }, extra)));
    fs.renameSync(tmp, archivoWake(root, rol));
  } catch { /* la marca es observabilidad: nunca rompe la espera */ }
}
const pidVivo = (pid) => { if (!Number.isInteger(pid)) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

function esperarTrabajo(root, rol, opts = {}) {
  const tm = require('./teams-manager.cjs');
  // Modo despertar: espera activa PERSISTENTE lanzada como tarea del host. No expira cada 170 s (cada salida sin trabajo
  // costaría un turno de modelo): solo termina cuando hay trabajo. El tope (12 h) evita un proceso eterno olvidado.
  const despertar = opts.despertar === true;
  const maxMs = despertar ? Math.min(Math.max(Number(opts.maxMs) || 43200000, 1000), 43200000) : Math.min(Math.max(Number(opts.maxMs) || 170000, 1000), 600000);
  const marca = (extra) => marcarWake(root, rol, extra);
  if (despertar) marca({ esperando: true, desde: new Date().toISOString(), pid: process.pid });
  const sondeoMs = Math.max(Number(opts.sondeoMs) || 5000, 200);
  const dirT = dirTeams(root); const dirL = path.join(root, '.legion');
  const inicio = Date.now();
  return new Promise((resolve) => {
    let hecho = false; const ws = []; let timerSondeo = null; let timerMax = null; let deb = null;
    const fin = (r) => {
      if (hecho) return; hecho = true;
      clearTimeout(timerMax); clearInterval(timerSondeo); clearTimeout(deb);
      for (const w of ws) { try { w.close(); } catch { /* ya cerrado */ } }
      if (despertar) marca(Object.assign({ esperando: false, ultimo_estado: r.estado }, r.estado === 'TRABAJO' ? { ultimo_wake_at: new Date().toISOString() } : {}));
      resolve(Object.assign({ rol, esperado_ms: Date.now() - inicio, nota: 'detectar no es leer ni confirmar: tras leer, confirma con teams-md-session.cjs visto' }, r));
    };
    const revisar = (origen) => {
      let d; try { d = tm.delta(root, { rol }); } catch { return; }
      if (d && d.eventos && d.eventos.length) fin({ estado: 'TRABAJO', origen, eventos: d.eventos.length, desde_seq: d.eventos[0].seq, hasta_seq: d.eventos[d.eventos.length - 1].seq, tipos: [...new Set(d.eventos.map((e) => e.kind))].slice(0, 8), latencia_ms: Date.now() - inicio });
    };
    const senal = (origen) => { clearTimeout(deb); deb = setTimeout(() => revisar(origen), 150); };
    revisar('inicial');
    if (hecho) return;
    const abrir = (dir, relevante, origen) => { try { const w = fs.watch(dir, { persistent: false }, (_t, n) => { if (!n || relevante(String(n))) senal(origen); }); w.on('error', () => { /* el sondeo de respaldo sigue */ }); ws.push(w); } catch { /* sin directorio: el sondeo cubre */ } };
    fs.mkdirSync(dirT, { recursive: true });
    abrir(dirT, (n) => n.startsWith('rev-' + rol), 'watch');
    if (fs.existsSync(dirL)) abrir(dirL, (n) => (require('./teams-watch.cjs').ARCHIVOS_CANAL[rol] || []).includes(n), 'watch-canal');
    timerSondeo = setInterval(() => revisar('sondeo'), sondeoMs);
    timerMax = setTimeout(() => fin({ estado: 'SIN_TRABAJO', origen: 'tiempo' }), maxMs);
  });
}

// ───────────────────────────── CLI ──────────────────────────────────────────

async function cli(argv) {
  const opt = Object.fromEntries(argv.filter((a) => a.startsWith('--')).map((a) => { const [k, ...v] = a.slice(2).split('='); return [k.replace(/-/g, '_'), v.length ? v.join('=') : true]; }));
  const cmd = argv.find((a) => !a.startsWith('--')) || 'estado';
  const root = process.cwd();
  const rol = opt.rol || 'builder';
  const o = { aprobar: opt.aprobar === true };
  let r;
  try {
    if (cmd === 'estado') r = estado(root, rol, { consultarSistema: opt.consultar !== false });
    else if (cmd === 'capacidades') r = capacidades(root, rol);
    else if (cmd === 'instalar') r = instalarTarea(root, rol, o);
    else if (cmd === 'reparar') r = repararTarea(root, rol, o);
    else if (cmd === 'desinstalar') r = desinstalarTarea(root, rol, o);
    else if (cmd === 'iniciar') r = iniciarProceso(root, rol);
    else if (cmd === 'apagar') r = (opt.rol && opt.rol !== 'todos') ? apagarVigilantes(root, rol) : apagarTodos(root);
    else if (cmd === 'metricas') r = require('./teams-watch.cjs').resumenMetricas(root, rol);
    else if (cmd === 'smoke') r = evaluarSmokeDespertar(root, rol, { editado_at: opt.editado, intervalo_ms: opt.intervalo ? Number(opt.intervalo) : undefined });
    else if (cmd === 'script') r = generarTarea(root, rol);
    else if (cmd === 'esperar') {
      r = await esperarTrabajo(root, rol, { despertar: opt.despertar === true, maxMs: opt.max ? Number(opt.max) * (Number(opt.max) < 1000 ? 1000 : 1) : undefined });
      // La línea fija que el host recibe como notificación (tarea en segundo plano de Claude Code o de Cursor).
      if (opt.despertar === true && r && r.estado === 'TRABAJO') console.log('AGENT_LOOP_WAKE_' + rol);
    }
    else r = { status: 'COMANDO_DESCONOCIDO', uso: 'estado|capacidades|instalar [--aprobar]|reparar [--aprobar]|desinstalar [--aprobar]|iniciar|esperar [--max=<segundos>] [--despertar]|apagar [--rol=builder|director|todos]|metricas|smoke --editado=<iso>|script  (--rol=builder|director)' };
  } catch (e) { r = { status: 'ERROR', code: e.code || null, detalle: e.message }; }
  console.log(JSON.stringify(r, null, 2));
  if (r && /FALLID|STOP_FAILED|ERROR|PARAMETROS_INVALIDOS|DESCONOCIDO/.test(String(r.status))) process.exitCode = 1;
}

if (require.main === module) cli(process.argv.slice(2)).catch((e) => { console.log(JSON.stringify({ status: 'ERROR', detalle: e.message })); process.exitCode = 1; });

module.exports = {
  PREFIJO_TAREA, ROLES, INTERVALO_DEFECTO_MS,
  nombreTarea, idVigilante, hashProyecto, psq, ejecutarPowerShell, detectarLanzadores, generarTarea,
  consultarTarea, instalarTarea, repararTarea, desinstalarTarea, procesoPropio, cmdlineDe, iniciarProceso, estado,
  apagarVigilantes, apagarTodos, capacidades, evaluarSmokeDespertar, ultimoVisto, leerRegistro, esperarTrabajo,
};
