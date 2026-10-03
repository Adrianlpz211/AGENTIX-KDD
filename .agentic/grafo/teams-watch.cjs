'use strict';

/**
 * Dos vigilantes para un rol de TEAMS, independientes entre sí:
 *
 *   principal  fs.watch sobre `.agentic/_teams/rev-<rol>.json` con debounce
 *   respaldo   timer que compara el último seq y detecta un watcher muerto
 *
 * La señal solo despierta: lo que se procesa sale siempre del delta en la
 * base desde el último ACK, así que coalescer señales nunca pierde una
 * revisión. Sin trabajo nuevo no se llama al manejador: no se gasta un turno
 * de modelo.
 *
 * Detectado, entregado y aceptado son tres cosas distintas. El ACK del rol
 * solo avanza cuando el manejador confirma aceptación duradera (`true` o
 * `{ aceptado: true, hasta_seq }`); si devuelve una Promise se espera su
 * resultado. Fallo, rechazo o cualquier otra respuesta: sin ACK, y el
 * siguiente pase lo reintenta (at-least-once; idempotente por event_id).
 *
 * `cursor: 'propio'` es para diagnóstico: guarda su posición aparte y nunca
 * consume el ACK del rol operativo. Despertar un modelo es trabajo del
 * adapter del host; este proceso no lo hace por sí mismo.
 */

const fs = require('fs');
const path = require('path');
const tm = require('./teams-manager.cjs');

const DEBOUNCE = { min: 300, max: 1000, defecto: 500 };
const INTERVALO = { min: 30000, max: 60000, defecto: 45000 };
const acotar = (v, r) => Math.min(Math.max(Number.isFinite(Number(v)) ? Number(v) : r.defecto, r.min), r.max);
const monotonico = () => Number(process.hrtime.bigint() / 1000000n);

class Vigilancia {
  /**
   * @param {string} root
   * @param {{ rol: string, onTrabajo: (eventos) => any, debounceMs?, intervaloMs?, watcher?: boolean, timer?: boolean,
   *           watchFactory?, sinLimites?: boolean }} o  `sinLimites` solo para pruebas
   */
  constructor(root, o) {
    this.root = root;
    this.rol = o.rol;
    this.onTrabajo = o.onTrabajo;
    this.debounceMs = o.sinLimites ? Number(o.debounceMs) || 0 : acotar(o.debounceMs, DEBOUNCE);
    this.intervaloMs = o.sinLimites ? Number(o.intervaloMs) || 50 : acotar(o.intervaloMs, INTERVALO);
    this.usarWatcher = o.watcher !== false;
    this.usarTimer = o.timer !== false;
    this.watchFactory = o.watchFactory || fs.watch;
    this.dir = path.join(root, '.agentic', '_teams');
    this.w = null;
    this.t = null;
    this.deb = null;
    this.reabrir = null;
    this.vivo = { watcher: false, timer: false };
    this.procesando = false;
    this.pendiente = false;
    this.cursorPropio = o.cursor === 'propio';
    this.archivoCursor = path.join(this.dir, 'cursor-diag-' + this.rol + '.json');
    this.enCurso = null;
    this.stats = {
      pases: 0, detectados: 0, entregados: 0, aceptados: 0, no_aceptados: 0, rechazos: 0,
      entregas: 0, eventos: 0, errores_watcher: 0, reaperturas: 0, ultimo_pase_ms: null, ultimo_origen: null,
      ultima_aceptacion_ms: null, ultimo_rechazo: null,
    };
  }

  leerDelta() {
    if (!this.cursorPropio) return tm.delta(this.root, { rol: this.rol });
    let desde = 0;
    try { desde = Number(JSON.parse(fs.readFileSync(this.archivoCursor, 'utf8')).seq) || 0; } catch { /* sin cursor: desde el principio */ }
    return tm.delta(this.root, { rol: this.rol, desde });
  }

  avanzar(seq) {
    if (!this.cursorPropio) return tm.ackSeq(this.root, { rol: this.rol, seq });
    const tmp = this.archivoCursor + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ seq, at: new Date().toISOString() }));
    fs.renameSync(tmp, this.archivoCursor);
    return { seq };
  }

  /** Solo una aceptación explícita mueve el cursor; nunca más allá de lo entregado. */
  aceptar(eventos, respuesta) {
    const ultimo = eventos[eventos.length - 1].seq;
    let hasta = null;
    if (respuesta === true) hasta = ultimo;
    else if (respuesta && typeof respuesta === 'object' && respuesta.aceptado === true) {
      hasta = respuesta.hasta_seq == null ? ultimo : Math.min(Number(respuesta.hasta_seq), ultimo);
      if (!eventos.some((e) => e.seq === hasta)) hasta = eventos.filter((e) => e.seq <= hasta).map((e) => e.seq).pop() || null;
    }
    if (hasta == null) { this.stats.no_aceptados += eventos.length; return false; }
    this.avanzar(hasta);
    const n = eventos.filter((e) => e.seq <= hasta).length;
    this.stats.aceptados += n;
    this.stats.entregas += 1;
    this.stats.eventos += n;
    this.stats.ultima_aceptacion_ms = monotonico();
    return true;
  }

  rechazo(e) {
    this.stats.rechazos += 1;
    this.stats.ultimo_rechazo = String((e && e.message) || e).slice(0, 200);
  }

  start() {
    fs.mkdirSync(this.dir, { recursive: true });
    if (this.usarWatcher) this.abrirWatcher();
    if (this.usarTimer) {
      this.t = setInterval(() => {
        if (this.usarWatcher && !this.vivo.watcher && !this.reabrir) this.abrirWatcher();
        this.revisar('timer');
        this.latido();
      }, this.intervaloMs);
      if (this.t.unref) this.t.unref();
      this.vivo.timer = true;
    }
    this.revisar('arranque');
    return this;
  }

  abrirWatcher() {
    try {
      this.w = this.watchFactory(this.dir, { persistent: false }, (_tipo, archivo) => {
        if (!archivo || String(archivo).startsWith('rev-' + this.rol)) this.senal();
      });
      this.w.on('error', () => this.watcherCaido());
      this.vivo.watcher = true;
      if (this.reabrir !== null) this.stats.reaperturas += 1;
      this.reabrir = null;
    } catch {
      this.watcherCaido();
    }
  }

  watcherCaido() {
    this.stats.errores_watcher += 1;
    this.vivo.watcher = false;
    try { if (this.w) this.w.close(); } catch { /* ya cerrado */ }
    this.w = null;
    /* Un overflow puede haber perdido señales: el delta lo recupera. */
    this.revisar('watcher-caido');
    if (!this.usarTimer && !this.reabrir) {
      this.reabrir = setTimeout(() => { this.reabrir = null; this.abrirWatcher(); }, Math.max(this.debounceMs, 100));
    }
  }

  senal() {
    clearTimeout(this.deb);
    this.deb = setTimeout(() => this.revisar('watcher'), this.debounceMs);
  }

  /**
   * Un pase. Con manejador síncrono termina aquí mismo; si devuelve una
   * Promise, el pase sigue ocupado hasta que se resuelva (devuelve esa espera).
   */
  revisar(origen) {
    // 3.20.1 — con un akdd update vivo no se entrega nada; el siguiente ciclo del vigilante lo retoma.
    try {
      const g = require('./update-guard.cjs');
      const e = g.estado(this.root);
      if (e.held && !(e.holder && process.env.AKDD_UPDATE_TOKEN === e.holder.token)) { this.pendiente = true; return this.enCurso; }
    } catch { /* motor sin update-guard */ }
    if (this.procesando) { this.pendiente = true; return this.enCurso; }
    this.procesando = true;
    const fin = () => { this.procesando = false; this.enCurso = null; };
    const bucle = () => {
      do {
        this.pendiente = false;
        this.stats.pases += 1;
        this.stats.ultimo_pase_ms = monotonico();
        this.stats.ultimo_origen = origen;
        let d;
        try { d = this.leerDelta(); } catch { break; /* base ocupada o sin TEAMS: el siguiente pase reintenta */ }
        if (!d.eventos.length) continue;
        this.stats.detectados += d.eventos.length;
        let r;
        try { r = this.onTrabajo(d.eventos); } catch (e) { this.rechazo(e); continue; }
        this.stats.entregados += d.eventos.length;
        if (r && typeof r.then === 'function') {
          return Promise.resolve(r).then((v) => { try { this.aceptar(d.eventos, v); } catch (e) { this.rechazo(e); } }, (e) => this.rechazo(e))
            .then(() => (this.pendiente ? bucle() : null));
        }
        try { this.aceptar(d.eventos, r); } catch (e) { this.rechazo(e); }
      } while (this.pendiente);
      return null;
    };
    let espera;
    try { espera = bucle(); } catch (e) { this.rechazo(e); espera = null; }
    if (!espera) { fin(); return null; }
    this.enCurso = espera.then(fin, fin);
    return this.enCurso;
  }

  latido() {
    try {
      const f = path.join(this.dir, 'heartbeat-' + this.rol + '.json');
      fs.writeFileSync(f, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), vivo: this.vivo }));
    } catch { /* el latido es informativo */ }
  }

  health() {
    const watcher = !this.usarWatcher ? 'DESHABILITADO' : this.vivo.watcher ? 'VIVO' : 'MUERTO';
    const timer = !this.usarTimer ? 'DESHABILITADO' : this.vivo.timer ? 'VIVO' : 'MUERTO';
    const alguno = watcher === 'VIVO' || timer === 'VIVO';
    return { watcher, timer, estado: watcher === 'VIVO' && timer === 'VIVO' ? 'OK' : alguno ? 'DEGRADED' : 'SIN_VIGILANCIA', stats: this.stats };
  }

  stop() {
    clearTimeout(this.deb);
    clearTimeout(this.reabrir);
    clearInterval(this.t);
    try { if (this.w) this.w.close(); } catch { /* ya cerrado */ }
    this.vivo = { watcher: false, timer: false };
  }
}

/**
 * Manejador operativo: entrega los eventos al adapter real del rol y solo
 * confirma lo que el adapter acepta de forma duradera. Un adapter sin vía de
 * entrega programática (manual, host sin integración) no acepta: no hay ACK.
 */
function entregarConAdapter(adapter) {
  return async (eventos) => {
    if (!adapter || typeof adapter.entregarEventos !== 'function') return { aceptado: false, motivo: 'ADAPTER_SIN_ENTREGA' };
    const r = await adapter.entregarEventos(eventos);
    if (r === true) return true;
    if (r && r.aceptado === true) return { aceptado: true, hasta_seq: r.hasta_seq };
    return { aceptado: false, motivo: (r && r.motivo) || 'NO_ACEPTADO' };
  };
}

/** Log propio con rotación simple: al pasar del tope se guarda una copia y se empieza otro. */
function logRotado(archivo, { maxBytes = 1024 * 1024, copias = 3 } = {}) {
  return (linea) => {
    try {
      fs.mkdirSync(path.dirname(archivo), { recursive: true });
      let tam = 0;
      try { tam = fs.statSync(archivo).size; } catch { /* nuevo */ }
      if (tam > maxBytes) {
        for (let i = copias - 1; i >= 1; i--) { try { fs.renameSync(`${archivo}.${i}`, `${archivo}.${i + 1}`); } catch { /* no había */ } }
        fs.renameSync(archivo, archivo + '.1');
      }
      fs.appendFileSync(archivo, new Date().toISOString() + ' ' + linea + '\n');
    } catch { /* el log es informativo */ }
  };
}

/**
 * Script para mantener vivo el vigilante con el Programador de tareas de
 * Windows. Se entrega para revisar; registrarlo es una decisión de la persona.
 * La tarea vigila y reinicia el supervisor: no tiene acceso al chat del IDE.
 */
function scriptTareaWindows(root, rol) {
  const nombre = 'AgentixTeams-' + require('crypto').createHash('sha256').update(path.resolve(root).toLowerCase()).digest('hex').slice(0, 8) + '-' + rol;
  const nodo = process.execPath.replace(/'/g, "''");
  const dir = path.resolve(root).replace(/'/g, "''");
  const log = `.agentic/_teams/watch-${rol}.log`;
  return {
    nombre,
    instalar: [
      /* conhost --headless: el proceso de consola corre sin ventana visible. */
      `$a = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument '--headless "${nodo}" .agentic/grafo/teams-watch.cjs --rol=${rol} --entregar --log=${log}' -WorkingDirectory '${dir}'`,
      '$t = New-ScheduledTaskTrigger -AtLogOn',
      '$s = New-ScheduledTaskSettingsSet -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -MultipleInstances IgnoreNew -Hidden',
      `Register-ScheduledTask -TaskName '${nombre}' -Action $a -Trigger $t -Settings $s -Description 'Vigilante TEAMS de Agentix (propio, sin credenciales)'`,
    ].join('\n'),
    desinstalar: `Unregister-ScheduledTask -TaskName '${nombre}' -Confirm:$false`,
    estado: `Get-ScheduledTask -TaskName '${nombre}' | Select-Object TaskName, State`,
    log,
    limites: [
      'registrarla es decisión de la persona: este script no se ejecuta solo',
      'la tarea mantiene vivo el supervisor; no despierta al modelo ni entra al chat del IDE',
      'sin un adapter que confirme aceptación, el supervisor no hace ACK: una tarea que solo imprime no cierra la integración',
    ],
  };
}

if (require.main === module) {
  const opt = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.length ? v.join('=') : true]; }));
  const rol = opt.rol || 'builder';
  if (opt.script) {
    console.log(JSON.stringify(scriptTareaWindows(process.cwd(), rol), null, 2));
  } else {
    const escribir = opt.log ? logRotado(path.resolve(process.cwd(), String(opt.log))) : (l) => console.log(l);
    let onTrabajo;
    let modo;
    if (opt.entregar) {
      const adapter = require('./teams-adapters.cjs').adaptersDe(process.cwd())[rol];
      const entregar = entregarConAdapter(adapter);
      modo = 'entrega por adapter ' + (adapter && adapter.capabilities ? adapter.capabilities().transport : 'NINGUNO');
      onTrabajo = async (eventos) => {
        const r = await entregar(eventos);
        escribir(JSON.stringify({ detectados: eventos.length, aceptado: r === true || !!(r && r.aceptado), motivo: r && r.motivo || null }));
        return r;
      };
    } else {
      modo = 'diagnóstico (cursor propio, no hace ACK del rol)';
      onTrabajo = (eventos) => { for (const e of eventos) escribir(JSON.stringify({ seq: e.seq, kind: e.kind, task_id: e.task_id })); return true; };
    }
    const v = new Vigilancia(process.cwd(), {
      rol, debounceMs: opt.debounce, intervaloMs: opt.intervalo, cursor: opt.entregar ? 'rol' : 'propio', onTrabajo,
    }).start();
    escribir(`[teams-watch] rol ${rol}, ${modo} (debounce ${v.debounceMs} ms, respaldo ${v.intervaloMs} ms). Una señal no despierta a un modelo por sí sola.`);
    setInterval(() => {}, 1 << 30);
  }
}

module.exports = { Vigilancia, scriptTareaWindows, entregarConAdapter, logRotado, DEBOUNCE, INTERVALO };
