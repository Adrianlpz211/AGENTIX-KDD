'use strict';

/**
 * Dos vigilantes para un rol de TEAMS, independientes entre sí (spec TEAMS §6):
 *
 *   principal  fs.watch sobre `.agentic/_teams/rev-<rol>.json` (la señal de revisión que publica el manager) y,
 *              aparte, sobre el canal `.legion/` (AUDITORIA-CURSOR.md y las colas de respuesta), con debounce
 *   respaldo   timer que compara el último seq y detecta un watcher muerto. NO depende del watch y NO se
 *              reinicia con las señales: sigue su ritmo (por defecto 180 s) pase lo que pase.
 *
 * La señal solo despierta: lo que se procesa sale siempre del delta en la base desde el último ACK (revisión /
 * sequence), así que coalescer señales, perder un evento del sistema o reabrir el watcher nunca pierde una
 * revisión. Sin trabajo nuevo no se llama al manejador: no se gasta un turno de modelo. Una señal NO es una tarea
 * ni un ACK.
 *
 * Detectado, solicitado, atendido y aceptado son cosas distintas, y se MIDEN por separado
 * (`detectado → solicitado → atendido → ACK`; el progreso real lo mide `medirProgreso`). El ACK del rol solo avanza
 * cuando el manejador confirma aceptación duradera (`true` o `{ aceptado: true, hasta_seq }`); si devuelve una
 * Promise se espera su resultado. Fallo, rechazo o cualquier otra respuesta: sin ACK, y el siguiente pase lo
 * reintenta (at-least-once; idempotente por event_id).
 *
 * LÍMITE HONESTO: este proceso DETECTA; no despierta al modelo del host. Que una sesión de Cursor o de Claude Code
 * lea de verdad lo detectado depende de su loop propio o de un adapter que lo confirme (VISTO). Lo que el host sí
 * da o no da se declara en teams-vigilancia.capacidades (EVENT_WAKE_UNSUPPORTED / MANUAL_ONLY), no aquí.
 *
 * `cursor: 'propio'` es para diagnóstico: guarda su posición aparte y nunca consume el ACK del rol operativo.
 */

const fs = require('fs');
const path = require('path');
const tm = require('./teams-manager.cjs');

const DEBOUNCE = { min: 300, max: 1000, defecto: 500 };
/* 180 s es el ritmo pedido para el respaldo; el techo deja margen al dueño sin permitir un respaldo irrelevante. */
const INTERVALO = { min: 30000, max: 300000, defecto: 180000 };
const MAX_ESPERA_SENAL_MS = 5000; // con señales continuas el debounce no puede posponer el pase indefinidamente
const acotar = (v, r) => Math.min(Math.max(Number.isFinite(Number(v)) ? Number(v) : r.defecto, r.min), r.max);
const monotonico = () => Number(process.hrtime.bigint() / 1000000n);

/** Reloj inyectable: las pruebas simulan los 180 s sin esperarlos. */
const RELOJ_REAL = Object.freeze({
  setInterval: (...a) => setInterval(...a), clearInterval: (t) => clearInterval(t),
  setTimeout: (...a) => setTimeout(...a), clearTimeout: (t) => clearTimeout(t),
  ahora: monotonico, ahoraMs: () => Date.now(),
});

/** Nombres del canal que importan a cada rol. Sus propios logs/latidos/temporales NUNCA están aquí (sin eco). */
const ARCHIVOS_CANAL = Object.freeze({
  builder: ['AUDITORIA-CURSOR.md'],
  director: ['AUDITORIA-CURSOR.md', 'cola-builder.jsonl'],
});

class Vigilancia {
  /**
   * @param {string} root
   * @param {{ rol: string, onTrabajo: (eventos) => any, onCanal?: (info) => any, debounceMs?, intervaloMs?, watcher?: boolean,
   *           timer?: boolean, canal?: boolean, watchFactory?, reloj?, vigilante?: string, metricas?: boolean,
   *           sinLimites?: boolean }} o  `sinLimites` solo para pruebas
   */
  constructor(root, o) {
    this.root = root;
    this.rol = o.rol;
    this.onTrabajo = o.onTrabajo;
    this.onCanal = typeof o.onCanal === 'function' ? o.onCanal : null;
    this.reloj = Object.assign({}, RELOJ_REAL, o.reloj || {});
    this.debounceMs = o.sinLimites ? Number(o.debounceMs) || 0 : acotar(o.debounceMs, DEBOUNCE);
    this.intervaloMs = o.sinLimites ? Number(o.intervaloMs) || 50 : acotar(o.intervaloMs, INTERVALO);
    this.usarWatcher = o.watcher !== false;
    this.usarTimer = o.timer !== false;
    this.usarCanal = o.canal !== false && this.usarWatcher;
    this.registrarMetricas = o.metricas !== false;
    this.vigilante = o.vigilante || null;
    this.watchFactory = o.watchFactory || fs.watch;
    this.dir = path.join(root, '.agentic', '_teams');
    this.dirCanal = path.join(root, '.legion');
    this.w = null;          // watcher PRINCIPAL (señal de revisión)
    this.wCanal = null;     // watcher del canal MD (auxiliar: sin él el principal y el timer siguen)
    this.t = null;
    this.deb = null;
    this.primeraSenal = null;
    this.reabrir = null;
    this.vivo = { watcher: false, timer: false, canal: false };
    this.procesando = false;
    this.pendiente = false;
    this.cursorPropio = o.cursor === 'propio';
    this.archivoCursor = path.join(this.dir, 'cursor-diag-' + this.rol + '.json');
    this.archivoMetricas = path.join(this.dir, 'metricas-' + this.rol + '.jsonl');
    this.enCurso = null;
    this.hashesCanal = {};
    this.iniciadoMs = null;
    this.metricas = [];
    this.stats = {
      pases: 0, detectados: 0, entregados: 0, aceptados: 0, no_aceptados: 0, rechazos: 0,
      entregas: 0, eventos: 0, errores_watcher: 0, reaperturas: 0, ultimo_pase_ms: null, ultimo_origen: null,
      ultima_aceptacion_ms: null, ultimo_rechazo: null, senales: 0, senales_canal: 0, cambios_canal: 0, pases_vacios: 0,
      por_origen: {},
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
    this.stats.ultima_aceptacion_ms = this.reloj.ahora();
    return true;
  }

  rechazo(e) {
    this.stats.rechazos += 1;
    this.stats.ultimo_rechazo = String((e && e.message) || e).slice(0, 200);
  }

  start() {
    fs.mkdirSync(this.dir, { recursive: true });
    this.iniciadoMs = this.reloj.ahoraMs();
    // El del canal primero: el principal es el último que se abre (y el que manda sobre la salud).
    if (this.usarCanal) this.abrirCanal();
    if (this.usarWatcher) this.abrirWatcher();
    if (this.usarTimer) {
      this.t = this.reloj.setInterval(() => {
        // Primero el pase del respaldo (NO depende de que el watch esté vivo); después se intenta reabrir lo caído.
        this.revisar('timer');
        if (this.usarWatcher && !this.vivo.watcher && !this.reabrir) this.abrirWatcher();
        if (this.usarCanal && !this.vivo.canal) this.abrirCanal();
        this.latido();
      }, this.intervaloMs);
      if (this.t && this.t.unref) this.t.unref();
      this.vivo.timer = true;
    }
    this.latido();
    this.revisar('arranque');
    return this;
  }

  abrirWatcher() {
    try {
      this.w = this.watchFactory(this.dir, { persistent: false }, (_tipo, archivo) => {
        if (!archivo || String(archivo).startsWith('rev-' + this.rol)) this.senal();
      });
      this.w.on('error', () => this.watcherCaido());
      const reabierto = this.reabrir !== null || this.stats.errores_watcher > 0 && !this.vivo.watcher;
      this.vivo.watcher = true;
      if (this.reabrir !== null) this.stats.reaperturas += 1;
      this.reabrir = null;
      // Catch-up tras reabrir: lo ocurrido mientras no había watcher se recupera por revisión/sequence, no por señal.
      if (reabierto && this.iniciadoMs != null) this.revisar('reapertura');
    } catch {
      this.watcherCaido();
    }
  }

  /** El canal MD es auxiliar: si `.legion` no existe o el watcher cae, el principal y el timer siguen igual. */
  abrirCanal() {
    if (!fs.existsSync(this.dirCanal) && this.watchFactory === fs.watch) { this.vivo.canal = false; return; }
    try {
      this.wCanal = this.watchFactory(this.dirCanal, { persistent: false }, (_tipo, archivo) => this.cambioCanal(archivo));
      this.wCanal.on('error', () => { this.vivo.canal = false; try { if (this.wCanal) this.wCanal.close(); } catch { /* ya cerrado */ } this.wCanal = null; this.stats.errores_watcher += 1; this.revisar('canal-caido'); });
      this.vivo.canal = true;
      this.sellarCanal();
    } catch { this.vivo.canal = false; this.wCanal = null; }
  }

  /** Hash de contenido de los archivos del canal: un reemplazo atómico con el mismo contenido NO es un cambio. */
  hashCanal(nombre) {
    try { return require('crypto').createHash('sha256').update(fs.readFileSync(path.join(this.dirCanal, nombre))).digest('hex').slice(0, 16); } catch { return null; }
  }

  sellarCanal() { for (const n of ARCHIVOS_CANAL[this.rol] || []) this.hashesCanal[n] = this.hashCanal(n); }

  cambioCanal(archivo) {
    const nombre = archivo ? String(archivo) : null;
    const relevantes = ARCHIVOS_CANAL[this.rol] || [];
    // Temporales del reemplazo atómico, logs y latidos propios, subcarpetas: nunca despiertan (sin eco).
    if (nombre && !relevantes.includes(nombre)) return;
    this.stats.senales_canal += 1;
    const candidatos = nombre ? [nombre] : relevantes; // sin nombre (overflow): se revisan todos
    let huboCambio = false;
    for (const n of candidatos) {
      const h = this.hashCanal(n);
      const anterior = this.hashesCanal[n] == null ? null : this.hashesCanal[n];
      if (h === anterior) continue;
      this.hashesCanal[n] = h;
      huboCambio = true;
      this.stats.cambios_canal += 1;
      if (this.onCanal) { try { this.onCanal({ archivo: n, hash: h, anterior, detectado_ms: this.reloj.ahoraMs(), rol: this.rol }); } catch (e) { this.rechazo(e); } }
    }
    // Un reemplazo atómico con el MISMO contenido no trae nada nuevo: no se pide un pase. Sin nombre (overflow) sí: se perdió información.
    if (huboCambio || !nombre) this.senal();
  }

  watcherCaido() {
    this.stats.errores_watcher += 1;
    this.vivo.watcher = false;
    try { if (this.w) this.w.close(); } catch { /* ya cerrado */ }
    this.w = null;
    /* Un overflow puede haber perdido señales: el delta lo recupera. */
    this.revisar('watcher-caido');
    if (!this.usarTimer && !this.reabrir) {
      this.reabrir = this.reloj.setTimeout(() => { this.reabrir = null; this.abrirWatcher(); }, Math.max(this.debounceMs, 100));
    }
  }

  senal() {
    this.stats.senales += 1;
    const ahora = this.reloj.ahora();
    if (this.primeraSenal == null) this.primeraSenal = ahora;
    this.reloj.clearTimeout(this.deb);
    // Debounce con tope: una ráfaga continua se coalesce, pero no puede posponer el pase para siempre.
    const espera = Math.max(0, Math.min(this.debounceMs, this.primeraSenal + MAX_ESPERA_SENAL_MS - ahora));
    this.deb = this.reloj.setTimeout(() => { this.primeraSenal = null; this.revisar('watcher'); }, espera);
  }

  /** Marca de escritura de la señal de revisión (la hora en que el manager publicó), para medir detección. */
  escrituraSenal(hastaSeq) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(this.dir, 'rev-' + this.rol + '.json'), 'utf8'));
      const t = Date.parse(j.at);
      return Number.isFinite(t) && Number(j.seq) >= hastaSeq ? t : null;
    } catch { return null; }
  }

  cerrarMetrica(rec) {
    rec.lat_deteccion_ms = rec.escrito_ms != null ? Math.max(0, rec.detectado_ms - rec.escrito_ms) : null;
    rec.lat_solicitud_ms = rec.solicitado_ms - rec.detectado_ms;
    rec.lat_atencion_ms = rec.atendido_ms != null ? rec.atendido_ms - rec.detectado_ms : null;
    rec.lat_ack_ms = rec.ack_ms != null ? rec.ack_ms - rec.detectado_ms : null;
    // Si el host está ocupado se ve aquí: detectar fue rápido y atender no.
    rec.diagnostico = rec.aceptado ? (rec.lat_atencion_ms > Math.max(5000, 4 * Math.max(1, rec.lat_deteccion_ms || 0)) ? 'DETECTADO_RAPIDO_ATENCION_LENTA' : 'OK') : (rec.error ? 'ENTREGA_FALLIDA' : 'SIN_ACEPTACION');
    this.metricas.push(rec);
    if (this.metricas.length > 200) this.metricas.shift();
    this.stats.por_origen[rec.origen] = (this.stats.por_origen[rec.origen] || 0) + 1;
    if (!this.registrarMetricas) return;
    try {
      let tam = 0; try { tam = fs.statSync(this.archivoMetricas).size; } catch { /* nuevo */ }
      if (tam > 512 * 1024) { try { fs.renameSync(this.archivoMetricas, this.archivoMetricas + '.1'); } catch { /* sin rotar */ } }
      fs.appendFileSync(this.archivoMetricas, JSON.stringify(rec) + '\n');
    } catch { /* la métrica es informativa */ }
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
        this.stats.ultimo_pase_ms = this.reloj.ahora();
        this.stats.ultimo_origen = origen;
        let d;
        try { d = this.leerDelta(); } catch { break; /* base ocupada o sin TEAMS: el siguiente pase reintenta */ }
        if (!d.eventos.length) { this.stats.pases_vacios += 1; continue; }
        this.stats.detectados += d.eventos.length;
        const ultimoSeq = d.eventos[d.eventos.length - 1].seq;
        const rec = { rol: this.rol, origen, desde_seq: d.eventos[0].seq, hasta_seq: ultimoSeq, eventos: d.eventos.length, escrito_ms: this.escrituraSenal(ultimoSeq), detectado_ms: this.reloj.ahoraMs(), solicitado_ms: null, atendido_ms: null, ack_ms: null, aceptado: false };
        rec.solicitado_ms = this.reloj.ahoraMs();
        let r;
        try { r = this.onTrabajo(d.eventos); } catch (e) { this.rechazo(e); rec.error = String(e && e.message || e).slice(0, 120); this.cerrarMetrica(rec); continue; }
        this.stats.entregados += d.eventos.length;
        if (r && typeof r.then === 'function') {
          return Promise.resolve(r).then((v) => {
            rec.atendido_ms = this.reloj.ahoraMs();
            try { rec.aceptado = this.aceptar(d.eventos, v); if (rec.aceptado) rec.ack_ms = this.reloj.ahoraMs(); } catch (e) { this.rechazo(e); }
          }, (e) => { this.rechazo(e); rec.error = String(e && e.message || e).slice(0, 120); })
            .then(() => { this.cerrarMetrica(rec); return this.pendiente ? bucle() : null; });
        }
        rec.atendido_ms = this.reloj.ahoraMs();
        try { rec.aceptado = this.aceptar(d.eventos, r); if (rec.aceptado) rec.ack_ms = this.reloj.ahoraMs(); } catch (e) { this.rechazo(e); }
        this.cerrarMetrica(rec);
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
      const tmp = f + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({
        schema: 1, pid: process.pid, rol: this.rol, vigilante: this.vigilante, at: new Date(this.reloj.ahoraMs()).toISOString(),
        iniciado_at: this.iniciadoMs ? new Date(this.iniciadoMs).toISOString() : null, intervalo_ms: this.intervaloMs, debounce_ms: this.debounceMs,
        vivo: this.vivo, pases: this.stats.pases, detectados: this.stats.detectados, aceptados: this.stats.aceptados,
      }));
      fs.renameSync(tmp, f);
    } catch { /* el latido es informativo */ }
  }

  health() {
    const watcher = !this.usarWatcher ? 'DESHABILITADO' : this.vivo.watcher ? 'VIVO' : 'MUERTO';
    const timer = !this.usarTimer ? 'DESHABILITADO' : this.vivo.timer ? 'VIVO' : 'MUERTO';
    const canal = !this.usarCanal ? 'DESHABILITADO' : this.vivo.canal ? 'VIVO' : 'NO_DISPONIBLE';
    const alguno = watcher === 'VIVO' || timer === 'VIVO';
    return { watcher, timer, canal, estado: watcher === 'VIVO' && timer === 'VIVO' ? 'OK' : alguno ? 'DEGRADED' : 'SIN_VIGILANCIA', stats: this.stats };
  }

  stop() {
    this.reloj.clearTimeout(this.deb);
    this.reloj.clearTimeout(this.reabrir);
    this.reloj.clearInterval(this.t);
    for (const w of [this.w, this.wCanal]) { try { if (w) w.close(); } catch { /* ya cerrado */ } }
    this.vivo = { watcher: false, timer: false, canal: false };
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

/**
 * Progreso REAL del rol tras ser atendido: el primer evento que ÉL produjo (ACK de tarea, resultado, latido…) después
 * de que lo atendieron. Despertar y progresar son cosas distintas: una lectura sin trabajo posterior no es progreso.
 */
function medirProgreso(root, { rol, desde_ms }) {
  try {
    const desde = new Date(desde_ms).toISOString();
    const dba = require('./db-adapter.cjs');
    const f = path.join(root, '.agentic', 'memoria.db');
    if (!fs.existsSync(f)) return { medido: false, motivo: 'SIN_BASE' };
    const db = dba.openReadOnly(f);
    try {
      const hay = db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='teams_events'");
      if (!hay) return { medido: false, motivo: 'SIN_TEAMS' };
      const e = db.get('SELECT seq, kind, created_at FROM teams_events WHERE producer_role = ? AND created_at >= ? ORDER BY seq LIMIT 1', rol, desde);
      return e ? { medido: true, progreso: true, evento: e.kind, seq: e.seq, progreso_at: e.created_at, lat_ms: Math.max(0, Date.parse(e.created_at) - desde_ms) } : { medido: true, progreso: false };
    } finally { db.close(); }
  } catch (err) { return { medido: false, motivo: 'ERROR:' + String(err.message || err).slice(0, 80) }; }
}

/** Resumen de las métricas guardadas de un rol: percentiles de detección/atención/ACK y cuántas atenciones no trajeron progreso. */
function resumenMetricas(root, rol, { limite = 200, conProgreso = true } = {}) {
  let lineas = [];
  try { lineas = fs.readFileSync(path.join(root, '.agentic', '_teams', 'metricas-' + rol + '.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).slice(-limite).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return { disponible: false, motivo: 'SIN_METRICAS', n: null }; }
  if (!lineas.length) return { disponible: false, motivo: 'SIN_METRICAS', n: null };
  const serie = (k) => lineas.map((m) => m[k]).filter((x) => x != null).sort((a, b) => a - b);
  const pct = (s, p) => (s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : null);
  const resumen = (k) => { const s = serie(k); return { n: s.length, p50: pct(s, 50), p95: pct(s, 95), max: s.length ? s[s.length - 1] : null }; };
  const out = {
    disponible: true, rol, n: lineas.length, aceptadas: lineas.filter((m) => m.aceptado).length,
    por_origen: lineas.reduce((a, m) => { a[m.origen] = (a[m.origen] || 0) + 1; return a; }, {}),
    lat_deteccion_ms: resumen('lat_deteccion_ms'), lat_solicitud_ms: resumen('lat_solicitud_ms'), lat_atencion_ms: resumen('lat_atencion_ms'), lat_ack_ms: resumen('lat_ack_ms'),
    atencion_lenta: lineas.filter((m) => m.diagnostico === 'DETECTADO_RAPIDO_ATENCION_LENTA').length, sin_aceptacion: lineas.filter((m) => !m.aceptado).length,
  };
  if (conProgreso) {
    const aceptadas = lineas.filter((m) => m.aceptado && m.atendido_ms);
    const med = aceptadas.map((m) => medirProgreso(root, { rol, desde_ms: m.atendido_ms }));
    out.progreso = { medidas: med.filter((x) => x.medido).length, con_progreso: med.filter((x) => x.progreso).length, sin_progreso: med.filter((x) => x.medido && !x.progreso).length, no_medibles: med.filter((x) => !x.medido).length };
  }
  return out;
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
 * LEGADO — script para revisar (no se ejecuta solo). Asume `conhost --headless`, que no existe en toda instalación
 * de Windows 10, y no registra recursos propios. El flujo controlado (instalar / estado / reparar / desinstalar /
 * apagar, por proyecto, rol y usuario, con lanzador comprobado) está en teams-vigilancia.cjs.
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
      'LEGADO: asume conhost --headless; usa teams-vigilancia.cjs para el flujo controlado',
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
    const onCanal = (info) => escribir(JSON.stringify({ canal: info.archivo, cambio: true, hash: info.hash }));
    const v = new Vigilancia(process.cwd(), {
      rol, debounceMs: opt.debounce, intervaloMs: opt.intervalo, cursor: opt.entregar ? 'rol' : 'propio', onTrabajo, onCanal,
      vigilante: typeof opt.vigilante === 'string' ? opt.vigilante : null,
    }).start();
    escribir(`[teams-watch] rol ${rol}, ${modo} (debounce ${v.debounceMs} ms, respaldo ${v.intervaloMs} ms, canal ${v.health().canal}). Una señal no despierta a un modelo por sí sola.`);
    setInterval(() => {}, 1 << 30);
  }
}

module.exports = { Vigilancia, scriptTareaWindows, entregarConAdapter, logRotado, medirProgreso, resumenMetricas, DEBOUNCE, INTERVALO, ARCHIVOS_CANAL, MAX_ESPERA_SENAL_MS, RELOJ_REAL };
