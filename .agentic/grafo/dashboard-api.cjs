'use strict';

/**
 * dashboard-api — GET /api/v1/* de solo lectura para el tablero.
 *
 * Cada respuesta va en el mismo sobre (schema_version 1) con la revisión del
 * snapshot, la ventana pedida y la cobertura. Una petición = una transacción
 * de lectura. Nada aquí escribe la base, corre sync, ni llama a un modelo.
 *
 * /api/v1/events con Accept: text/event-stream es un canal SSE: avisa cuando
 * cambia la revisión, con id incremental, Last-Event-ID y keepalive. Mientras
 * no hay nadie conectado no se consulta la base.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const datos = require('./dashboard-datos.cjs');
const ec = require('./estado-ciclo.cjs');
const fu = require('./fecha-utc.cjs');
const servicio = require('./metricas-servicio.cjs');
const operativa = require('./operativa.cjs');

const SCHEMA_VERSION = 1;
const LIMITE_MAX = 200;
const LIMITE_DEF = 50;
const FILTROS_TEXTO = ['kind', 'id', 'type', 'host', 'status', 'state', 'provenance', 'task', 'role', 'origen', 'plan', 'sprint', 'phase', 'correction'];
const hash = (x) => crypto.createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex').slice(0, 16);
const iso = (x) => { const d = fu.fechaUtc(x); return d ? d.toISOString() : null; };

/* Integraciones del onboarding: instalada no es activa, y ninguna se declara
   probada sin una huella propia; las pruebas con fixtures no la sustituyen. */
function integraciones(projectPath) {
  const hay = (f) => fs.existsSync(path.join(projectPath, '.agentic', 'grafo', f));
  return [
    hay('whatsapp-manager.cjs')
      ? { id: 'whatsapp', estado: 'instalada', detalle: 'el módulo existe; activo solo tras ws: activar con respuesta ACTIVE', accion: 'ws: activar (lo escribe la persona)' }
      : { id: 'whatsapp', estado: 'no_instalada', detalle: '', accion: '' },
    { id: 'hosts', estado: 'sin_evidencia', detalle: 'integración entre hosts no probada: las pruebas con fixtures no la demuestran', accion: 'correr el flujo en los dos hosts y guardar la evidencia' },
  ];
}

class ErrorPeticion extends Error {
  constructor(status, code, msg) { super(msg); this.status = status; this.code = code; }
}

/** Valida la query contra los parámetros permitidos de la ruta. */
function leerQuery(qs, permitidos, projectId) {
  const q = {};
  for (const [k, v] of qs) {
    if (!permitidos.includes(k)) throw new ErrorPeticion(400, 'PARAMETRO_DESCONOCIDO', `parámetro no admitido: ${k}`);
    if (k in q) throw new ErrorPeticion(400, 'PARAMETRO_REPETIDO', `parámetro repetido: ${k}`);
    if (v.length > 200) throw new ErrorPeticion(400, 'PARAMETRO_LARGO', `parámetro demasiado largo: ${k}`);
    q[k] = v;
  }
  if ('limit' in q) {
    if (!/^\d{1,4}$/.test(q.limit) || Number(q.limit) < 1 || Number(q.limit) > LIMITE_MAX) throw new ErrorPeticion(400, 'LIMIT_INVALIDO', `limit entre 1 y ${LIMITE_MAX}`);
    q.limit = Number(q.limit);
  } else q.limit = LIMITE_DEF;
  if ('cursor' in q) {
    if (!/^\d{1,9}$/.test(q.cursor)) throw new ErrorPeticion(400, 'CURSOR_INVALIDO', 'cursor debe ser un entero no negativo');
    q.cursor = Number(q.cursor);
  }
  // 3.20.1 (paneles Memoria/Contexto): filtros con lista cerrada de caracteres. Nunca se concatenan a SQL: se enlazan.
  for (const k of FILTROS_TEXTO) {
    if (k in q && !/^[\w:.-]{1,120}$/.test(q[k])) throw new ErrorPeticion(400, 'PARAMETRO_INVALIDO', `valor no admitido en ${k}`);
  }
  // eslint-disable-next-line no-control-regex
  if ('q' in q && /[\u0000-\u001f\u007f]/.test(q.q)) throw new ErrorPeticion(400, 'PARAMETRO_INVALIDO', 'valor no admitido en q');
  for (const k of ['from', 'to']) {
    if (k in q) { const d = fu.fechaUtc(q[k]); if (!d) throw new ErrorPeticion(400, 'FECHA_INVALIDA', `${k} no es una fecha válida`); q[k] = d; }
  }
  if (q.from && q.to && q.from > q.to) throw new ErrorPeticion(400, 'VENTANA_INVALIDA', 'from es posterior a to');
  if ('project_id' in q && q.project_id !== projectId) throw new ErrorPeticion(404, 'PROYECTO_DESCONOCIDO', 'este tablero sirve un solo proyecto');
  return q;
}

const enVentana = (q, valor) => {
  if (!q.from && !q.to) return true;
  const d = fu.fechaUtc(valor);
  if (!d) return false;
  return (!q.from || d >= q.from) && (!q.to || d <= q.to);
};

function paginar(lista, q) {
  const desde = q.cursor || 0;
  const pagina = lista.slice(desde, desde + q.limit);
  const siguiente = desde + pagina.length < lista.length ? desde + pagina.length : null;
  return { pagina, coverage: { total: lista.length, shown: pagina.length, truncated: lista.length > pagina.length, offset: desde, next_cursor: siguiente } };
}

/**
 * Huella de TODO lo que la página del tablero pinta al generarse (grafo de conocimiento, estructura de código, tiempos, visita, docs…).
 * La revisión de /summary solo cubre las tarjetas; esta cubre además filas de las tablas y los archivos que la página lee, para que el
 * tablero sepa cuándo su contenido quedó viejo SIN reiniciar el servidor. Solo lectura y barata: conteos + último rowid + mtimes.
 */
const TABLAS_PAGINA = ['nodos', 'relaciones', 'ciclos', 'fases', 'verified_contracts', 'protected_behaviors', 'ast_symbols', 'ast_edges', 'ui_layout_decisions', 'code_summaries', 'module_registry', 'spec_registry', 'gate_events', 'prediction_log', 'reasoning_bank', 'episodios'];
function huellaArchivos(projectPath) {
  const partes = [];
  const mt = (p) => { try { return Math.round(fs.statSync(p).mtimeMs); } catch { return '-'; } };
  const ag = path.join(projectPath, '.agentic');
  for (const f of [path.join(ag, 'config.md'), path.join(ag, 'PLAN.md'), path.join(ag, 'diff-overlay.json'), path.join(ag, 'tour.json'), path.join(projectPath, 'package.json')]) partes.push(mt(f));
  for (const dir of [path.join(ag, 'memoria'), path.join(ag, 'specs'), path.join(projectPath, '_output')]) {
    try { for (const f of fs.readdirSync(dir)) if (/\.(md|json)$/.test(f) && (dir.endsWith('_output') ? /^log-/.test(f) : true)) partes.push(f + ':' + mt(path.join(dir, f))); } catch { /* carpeta ausente */ }
  }
  return partes.join('|');
}
function huellaDb(dbPath, opts) {
  const consultas = {};
  for (const t of TABLAS_PAGINA) consultas[t] = { tabla: t, sql: 'SELECT COUNT(*) AS n, COALESCE(MAX(rowid), 0) AS m FROM "' + t + '"' };
  const r = datos.filas(dbPath, consultas, Object.assign({ snapshot: true }, opts || {}));
  if (r.status !== 'OK') return null;                  // base ocupada o ilegible: quien llama conserva la anterior
  return TABLAS_PAGINA.map((t) => { const f = (r.value[t] || [])[0]; return f ? f.n + ':' + f.m : '-'; }).join(',');
}
function huellaPaginaDe({ dbPath, projectPath, busyMs } = {}) {
  const d = huellaDb(dbPath, busyMs ? { busyMs } : null);
  return hash((d === null ? 'sin-db' : d) + '#' + huellaArchivos(projectPath));
}

function crearApi({ dbPath, projectPath, projectId, pollMs, maxClientes, abrir } = {}) {
  const opts = abrir ? { abrir } : {};
  const intervalo = Number(pollMs || process.env.AKDD_DASH_POLL_MS || 2000);
  const tope = Number(maxClientes || process.env.AKDD_DASH_MAX_SSE || 8);

  /** Lectura única del resumen: métricas, contratos y memoria en una transacción. */
  function leerResumen(ligero) {
    const r = datos.filas(dbPath, Object.assign({}, servicio.CONSULTAS, {
      contratos: { tabla: 'verified_contracts', sql: "SELECT status, COUNT(*) AS n FROM verified_contracts WHERE status IS NULL OR status != 'deprecated' GROUP BY status" },
      nodos: { tabla: 'nodos', sql: 'SELECT tipo, COUNT(*) AS n FROM nodos GROUP BY tipo' },
    }), Object.assign({ snapshot: true }, opts, ligero ? { busyMs: 150 } : {}));
    if (r.status !== 'OK') return { status: r.status, reason_code: r.reason_code, data: null, faltan: [] };
    const v = r.value;
    const faltan = r.faltan || [];
    const m = servicio.metricasDeCiclos({ ciclos: v.ciclosTodos, eventosStop: v.stopsEventos, fasesAgg: v.fasesAgg[0] || null, snapshots: v.snapshots });
    let contratos = null;
    if (!faltan.includes('verified_contracts')) {
      const por_estado = Object.fromEntries(datos.ESTADOS_CONTRATO.map((e) => [e, 0]));
      for (const f of v.contratos) por_estado[datos.estadoContrato(f.status)] += Number(f.n);
      contratos = { total: Object.values(por_estado).reduce((a, b) => a + b, 0), por_estado };
    }
    const memoria = faltan.includes('nodos') ? null : Object.fromEntries(v.nodos.map((n) => [n.tipo, Number(n.n)]));
    const metricas = m ? {
      total: m.total, completados: m.completados, stops: m.stops, goal_attainment: m.goal_attainment, autonomy_ratio: m.autonomy_ratio,
      handoff_integrity: m.handoff_integrity, test_rate: m.test_rate, cierre: m.cierre, incidentes: m.incidentes, autonomia: m.autonomia, tests: m.tests,
    } : null;
    const data = { metricas, contratos, memoria };
    return { status: m || contratos || memoria ? 'OK' : 'EMPTY', reason_code: faltan.length ? 'TABLAS_AUSENTES' : null, data, faltan };
  }

  function revision(ligero) {
    const r = leerResumen(ligero);
    return r.data ? hash(r.data) : 'sin-dato-' + (r.reason_code || r.status);
  }

  function sobre(res, req, { status, data, errors, coverage, window, reason_code, extraEtag, source, cause, accion, incompletos, stale }, http) {
    const snapshot_revision = data ? hash(data) : 'sin-dato';
    const cuerpo = {
      schema_version: SCHEMA_VERSION, status, project_id: projectId, snapshot_revision,
      generated_at: new Date().toISOString(), source: source || (data == null ? 'none' : 'sqlite'),
      window: window || { from: null, to: null },
      coverage: coverage || null,
      data: data === undefined ? null : data,
      errors: errors || [],
      reason_code: reason_code || null,
    };
    if (cause) cuerpo.cause = cause;
    if (accion) cuerpo.accion = accion;
    if (incompletos) cuerpo.incompletos = incompletos;
    // Dato servido desde la última lectura buena porque la base estaba ocupada (otro proceso escribiendo): se dice, no se oculta.
    if (stale) { cuerpo.stale = true; cuerpo.stale_since = stale.since; cuerpo.stale_reason = stale.reason; }
    const etag = `"${hash(snapshot_revision + '|' + (extraEtag || ''))}"`;
    const base = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache', ETag: etag, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
    if ((http || 200) === 200 && req.headers['if-none-match'] === etag) { res.writeHead(304, base); return res.end(); }
    res.writeHead(http || 200, base);
    // < > & y los separadores de línea Unicode salen como \uXXXX: sigue siendo JSON válido y el mismo texto al
    // decodificarlo, pero el cuerpo nunca contiene un literal <script> que un consumidor pudiera interpretar.
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify(cuerpo).replace(/[<>&\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')));
  }

  const ventana = (q) => ({ from: q.from ? q.from.toISOString() : null, to: q.to ? q.to.toISOString() : null });

  const RUTAS = {
    summary: { params: ['project_id'], fn: () => {
      const r = leerResumen();
      return { status: r.data ? r.status : 'UNAVAILABLE', data: r.data, reason_code: r.reason_code, errors: r.faltan.map((t) => ({ code: 'TABLA_AUSENTE', source: t })) };
    } },
    tasks: { params: ['project_id', 'plan_id', 'from', 'to', 'cursor', 'limit', 'estado', 'origen'], fn: (q) => {
      if ('origen' in q && !['aa', 'teams', 'todos'].includes(q.origen)) return { status: 'UNAVAILABLE', data: null, http: 400, reason_code: 'PARAMETRO_INVALIDO', errors: [{ code: 'PARAMETRO_INVALIDO', message: 'origen: aa | teams | todos' }] };
      if ('plan_id' in q) return { status: 'UNAVAILABLE', data: [], reason_code: 'PLAN_SIN_FUENTE', errors: [{ code: 'PLAN_SIN_FUENTE', message: 'este proyecto no tiene planes registrados en la base' }] };
      const r = datos.filas(dbPath, { ciclos: { tabla: 'ciclos', sql: 'SELECT id, ciclo_id, tarea, modulo, tipo_tarea, estado, tests_generados, tests_pasando, stops_count, fecha_inicio, fecha_fin FROM ciclos' } }, Object.assign({ snapshot: true }, opts));
      if (r.status !== 'OK') return { status: 'UNAVAILABLE', data: null, reason_code: r.reason_code };
      if ((r.faltan || []).includes('ciclos')) return { status: 'UNAVAILABLE', data: null, reason_code: 'TABLA_AUSENTE' };
      let lista = r.value.ciclos.filter((c) => enVentana(q, c.fecha_inicio));
      if (q.estado) lista = lista.filter((c) => ec.clasificar(c.estado) === q.estado);
      // 3.20.1: el mismo backend de ciclos para `aa` y `teams`; el origen se distingue por el prefijo determinista del id (el cierre de TEAMS registra con ese prefijo).
      const origenDe = (c) => (String(c.ciclo_id).startsWith('teams_') ? 'teams' : 'aa');
      if (q.origen && q.origen !== 'todos') lista = lista.filter((c) => origenDe(c) === q.origen);
      lista.sort((a, b) => -fu.compararPorFecha(a, b, 'fecha_inicio'));
      const { pagina, coverage } = paginar(lista, q);
      return { status: lista.length ? 'OK' : 'EMPTY', coverage, data: pagina.map((c) => Object.assign({}, c, { clase: ec.clasificar(c.estado), origen: origenDe(c), fecha_inicio: iso(c.fecha_inicio), fecha_fin: iso(c.fecha_fin) })) };
    } },
    contracts: { params: ['project_id', 'cursor', 'limit', 'estado'], fn: (q) => {
      const r = datos.filas(dbPath, { c: { tabla: 'verified_contracts', sql: "SELECT id, module, name, status, verification_count, failure_count, updated_at FROM verified_contracts WHERE status IS NULL OR status != 'deprecated' ORDER BY id" } }, Object.assign({ snapshot: true }, opts));
      if (r.status !== 'OK' || (r.faltan || []).includes('verified_contracts')) return { status: 'UNAVAILABLE', data: null, reason_code: r.reason_code || 'TABLA_AUSENTE' };
      let lista = r.value.c.map((c) => Object.assign({}, c, { estado: datos.estadoContrato(c.status) }));
      if (q.estado) lista = lista.filter((c) => c.estado === q.estado);
      const { pagina, coverage } = paginar(lista, q);
      return { status: lista.length ? 'OK' : 'EMPTY', coverage, data: pagina };
    } },
    events: { params: ['project_id', 'from', 'to', 'cursor', 'limit', 'gate', 'verdict'], fn: (q) => {
      const r = datos.filas(dbPath, { e: { tabla: 'gate_events', sql: 'SELECT id, ts, gate, verdict, file, cycle_id, event_id, incident_id, source FROM gate_events ORDER BY id DESC' } }, Object.assign({ snapshot: true }, opts));
      if (r.status !== 'OK' || (r.faltan || []).includes('gate_events')) return { status: 'UNAVAILABLE', data: null, reason_code: r.reason_code || 'TABLA_AUSENTE' };
      let lista = r.value.e.filter((e) => enVentana(q, e.ts));
      if (q.gate) lista = lista.filter((e) => e.gate === q.gate);
      if (q.verdict) lista = lista.filter((e) => e.verdict === q.verdict);
      const { pagina, coverage } = paginar(lista, q);
      return { status: lista.length ? 'OK' : 'EMPTY', coverage, data: pagina.map((e) => Object.assign({}, e, { ts: iso(e.ts) })) };
    } },
    capabilities: { params: ['project_id'], fn: () => ({ status: 'OK', data: { integraciones: integraciones(projectPath) } }) },
    // 3.20.1 — actualización y memoria: versión, esquema, última verificación, conservación, respaldo y acciones. Solo lectura.
    update: { params: ['project_id', 'cursor', 'limit'], fn: (q) => {
      try {
        const r = require('./update-estado.cjs').leer(projectPath, { cursor: q.cursor, limit: q.limit });
        return { status: r.status, data: r.data, coverage: r.coverage };
      } catch (e) { return { status: 'UNAVAILABLE', data: null, reason_code: 'ERROR', cause: String(e.message || e).slice(0, 160) }; }
    } },
    // 3.22.5 — pestaña TEAMS: semáforo, vigilantes, cola y registro. Solo lectura (teams.cjs salud); sin TEAMS instalado → UNAVAILABLE honesto.
    teams: { params: ['project_id'], fn: () => {
      try {
        const f = path.join(projectPath, '.agentic', 'grafo', 'teams.cjs');
        if (!fs.existsSync(f)) return { status: 'UNAVAILABLE', data: null, reason_code: 'TEAMS_NO_INSTALADO' };
        const r = require(f).salud(projectPath);
        return r ? { status: 'OK', data: r } : { status: 'EMPTY', data: null, reason_code: 'SIN_CANAL' };
      } catch (e) { return { status: 'UNAVAILABLE', data: null, reason_code: 'ERROR', cause: String(e.message || e).slice(0, 160) }; }
    } },
    // 3.22.6 — Oficina (la agencia 3D): TEAMS si lo hay + la actividad de los modelos con aa: (sirve con un solo modelo). Siempre OK: la oficina vive aunque no haya nada.
    oficina: { params: ['project_id'], fn: () => {
      try { return { status: 'OK', data: require('./oficina-datos.cjs').leer(projectPath) }; }
      catch (e) { return { status: 'UNAVAILABLE', data: null, reason_code: 'ERROR', cause: String(e.message || e).slice(0, 160) }; }
    } },
    // Tablero de decisiones del dueño (pendientes / respondidas / ejecutadas). Lee el canal TEAMS; sin canal → lista vacía.
    decisiones: { params: ['project_id'], fn: () => {
      try { const l = require('./decisiones.cjs').leer(projectPath); return { status: l.canal ? 'OK' : 'EMPTY', data: l, reason_code: l.canal ? null : 'SIN_CANAL' }; }
      catch (e) { return { status: 'UNAVAILABLE', data: null, reason_code: 'ERROR', cause: String(e.message || e).slice(0, 160) }; }
    } },
    // 3.20.1 — salud funcional, panel Memoria y panel Contexto y esfuerzo. Solo lectura; el proyecto lo fija el servidor.
    'memory-health': { params: ['project_id'], fn: () => {
      try {
        const sal = require('./memoria-salud.cjs').leer(projectPath, { source: 'dashboard' });
        // Readiness: con una capacidad imprescindible caída el HTTP NO es 200 aunque el servicio responda.
        return { status: sal.ready ? 'OK' : 'UNAVAILABLE', http: sal.ready ? 200 : 503, data: sal, reason_code: sal.ready ? null : 'NOT_READY', source: 'memoria-salud' };
      } catch (e) { return { status: 'UNAVAILABLE', http: 503, data: null, reason_code: 'ERROR', cause: String(e.message || e).slice(0, 160) }; }
    } },
    memory: { params: ['project_id'], fn: () => {
      try { const r = require('./memoria-panel.cjs').resumen(projectPath); return { status: r.status, data: r.data, reason_code: r.reason_code || null, source: 'memoria-panel' }; }
      catch (e) { return { status: 'UNAVAILABLE', data: null, reason_code: 'ERROR', cause: String(e.message || e).slice(0, 160) }; }
    } },
    'memory-items': { params: ['project_id', 'kind', 'cursor', 'limit', 'type', 'host', 'status', 'state', 'provenance', 'task', 'q'], fn: (q) => {
      try {
        const r = require('./memoria-panel.cjs').listar(projectPath, { kind: q.kind, cursor: q.cursor, limit: q.limit, type: q.type, host: q.host, status: q.status, state: q.state, provenance: q.provenance, task: q.task, q: q.q });
        return { status: r.status, data: r.data, coverage: r.coverage || null, reason_code: r.reason_code || null, accion: r.hint || null, source: 'memoria-panel' };
      } catch (e) { return { status: 'UNAVAILABLE', data: null, reason_code: 'ERROR', cause: String(e.message || e).slice(0, 160) }; }
    } },
    'memory-item': { params: ['project_id', 'kind', 'id'], fn: (q) => {
      try { const r = require('./memoria-panel.cjs').detalle(projectPath, { kind: q.kind, id: q.id }); return { status: r.status, data: r.data, reason_code: r.reason_code || null, source: 'memoria-panel' }; }
      catch (e) { return { status: 'UNAVAILABLE', data: null, reason_code: 'ERROR', cause: String(e.message || e).slice(0, 160) }; }
    } },
    context: { params: ['project_id', 'cursor', 'limit', 'task', 'role'], fn: (q) => {
      try {
        const r = require('./contexto-panel.cjs').resumen(projectPath, { cursor: q.cursor, limit: q.limit, task: q.task, role: q.role });
        return { status: r.status, data: r.data, coverage: r.coverage || null, reason_code: r.reason_code || null, source: 'contexto-panel' };
      } catch (e) { return { status: 'UNAVAILABLE', data: null, reason_code: 'ERROR', cause: String(e.message || e).slice(0, 160) }; }
    } },
    incidents: { params: ['project_id', 'cursor', 'limit'], fn: (q) => {
      const r = datos.filas(dbPath, { e: operativa.CONSULTAS.eventosOperativos }, Object.assign({ snapshot: true }, opts));
      if (r.status !== 'OK' || (r.faltan || []).includes('gate_events')) return { status: 'UNAVAILABLE', data: null, reason_code: r.reason_code || 'TABLA_AUSENTE' };
      const lista = operativa.incidentes(r.value.e);
      const { pagina, coverage } = paginar(lista, q);
      return { status: lista.length ? 'OK' : 'EMPTY', coverage, data: pagina };
    } },
    usage: { params: ['project_id', 'from', 'to'], fn: (q) => {
      try {
        const costo = require('./costo-uso.cjs');
        const u = typeof costo.resumen === 'function' ? costo.resumen(projectPath, q) : null;
        if (!u) return { status: 'UNAVAILABLE', data: null, reason_code: 'SIN_MEDICION' };
        return { status: 'OK', data: u, window: ventana(q) };
      } catch { return { status: 'UNAVAILABLE', data: null, reason_code: 'MODULO_AUSENTE' }; }
    } },
    tour: { params: ['project_id', 'mode', 'area'], fn: (q) => {
      const tourSvc = require('./tour-servicio.cjs');
      const r = tourSvc.obtener(projectPath, { area: q.area || null });
      return { status: r.status, data: r.tour, reason_code: r.reason_code || null };
    } },
    'restore-points': { params: ['project_id', 'cursor', 'limit'], fn: (q) => {
      try {
        const rm = require('./restore-manager.cjs');
        const r = typeof rm.listar === 'function' ? rm.listar(projectPath) : (typeof rm.list === 'function' ? rm.list(projectPath) : { status: 'ERROR', detalle: 'sin listar' });
        if (!r || typeof r !== 'object') return { status: 'UNAVAILABLE', data: [], reason_code: 'CONTRATO_INVALIDO' };
        if (r.status && r.status !== 'OK' && !Array.isArray(r.puntos)) {
          return {
            status: 'UNAVAILABLE', data: [], reason_code: r.status,
            cause: r.detalle || r.motivo || null, source: 'restore-manager',
            accion: r.status === 'UNSUPPORTED' ? 'inicializar Git en una copia de trabajo, no en el original' : null,
          };
        }
        const puntos = Array.isArray(r.puntos) ? r.puntos : (Array.isArray(r) ? r : []);
        const { pagina, coverage } = paginar(puntos, q);
        return {
          status: puntos.length ? 'OK' : 'EMPTY', coverage, data: pagina,
          source: 'restore-manager', incompletos: r.incompletos || [],
        };
      } catch (e) { return { status: 'UNAVAILABLE', data: [], reason_code: 'ERROR', cause: String(e.message || e).slice(0, 160) }; }
    } },
  };

  // ─── SSE ──────────────────────────────────────────────────────────────────
  const clientes = new Set();
  const buffer = [];
  let seq = 0;
  let actual = null;
  let firmaArchivo = null;
  let temporizador = null;
  const suscritosPagina = new Set();

  const firma = () => ['', '-wal'].map((s) => { try { const st = fs.statSync(dbPath + s); return st.size + ':' + st.mtimeMs; } catch { return '-'; } }).join('|');
  const enviar = (res, ev) => res.write(`id: ${ev.id}\nevent: ${ev.tipo}\ndata: ${JSON.stringify(ev.data)}\n\n`);

  // Huella de la página: la parte de la base solo se recalcula si el archivo cambió; la de archivos (mtimes) siempre, es barata.
  let huellaPag = null, huellaDbCache = null, huellaDbFirma = null;
  function huellaPaginaActual() {
    const f = firma();
    if (f !== huellaDbFirma) { const d = huellaDb(dbPath, { busyMs: 150 }); if (d !== null) { huellaDbCache = d; huellaDbFirma = f; } }
    return hash((huellaDbCache === null ? 'sin-db' : huellaDbCache) + '#' + huellaArchivos(projectPath));
  }
  function avisarPagina() {
    const h = huellaPaginaActual();
    if (h === huellaPag) return;
    const primera = huellaPag === null; huellaPag = h;
    if (primera) return;
    // Canal APARTE (?topics=pagina): el de las revisiones de los grafos no recibe estos avisos ni cambia sus ids.
    for (const c of suscritosPagina) c.write(`event: pagina\ndata: ${JSON.stringify({ huella: h, at: new Date().toISOString() })}\n\n`);
  }

  function sondear() {
    if (suscritosPagina.size) { try { avisarPagina(); } catch { /* el aviso es auxiliar */ } }
    const f = firma();
    if (suscritosMemoria.size && (f + '|' + firmaExtra()) !== firmaMem) sondearMemoria();
    if (f === firmaArchivo && actual !== null) return;
    firmaArchivo = f;
    const rev = revision(true);
    if (/^sin-dato-DB_BLOQUEADA/.test(rev)) { firmaArchivo = null; return; }   // base ocupada: no se espera, se reintenta en el próximo turno
    if (rev === actual) return;
    actual = rev;
    const ev = { id: ++seq, tipo: 'revision', data: { snapshot_revision: rev, at: new Date().toISOString() } };
    buffer.push(ev);
    if (buffer.length > 100) buffer.shift();
    for (const c of clientes) enviar(c, ev);
  }
  function arrancar() { if (!temporizador) { temporizador = setInterval(sondear, intervalo); temporizador.unref(); } }
  function parar() { if (temporizador && !clientes.size && !suscritosMemoria.size && !suscritosPagina.size) { clearInterval(temporizador); temporizador = null; } }

  function abrirStream(req, res) {
    if (clientes.size + suscritosMemoria.size >= tope) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '10' });
      return res.end(JSON.stringify({ schema_version: SCHEMA_VERSION, status: 'UNAVAILABLE', reason_code: 'DEMASIADOS_CLIENTES', errors: [{ code: 'DEMASIADOS_CLIENTES' }] }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff' });
    res.write('retry: 3000\n\n');
    if (actual === null) sondear();
    const ultimo = Number(req.headers['last-event-id']);
    if (Number.isInteger(ultimo) && ultimo > 0) {
      const pendientes = buffer.filter((e) => e.id > ultimo);
      if (ultimo > seq || (buffer.length && ultimo < buffer[0].id - 1)) {
        // El cursor ya no está en memoria (o es de otra ejecución): pedir snapshot completo.
        enviar(res, { id: seq, tipo: 'snapshot', data: { snapshot_revision: actual, motivo: 'CURSOR_EXPIRADO' } });
      } else for (const e of pendientes) enviar(res, e);
    } else {
      enviar(res, { id: seq, tipo: 'revision', data: { snapshot_revision: actual, at: new Date().toISOString() } });
    }
    clientes.add(res);
    arrancar();
    const latido = setInterval(() => res.write(': keepalive\n\n'), 15000);
    latido.unref();
    req.on('close', () => { clearInterval(latido); clientes.delete(res); parar(); });
  }

  // ─── SSE de los paneles Memoria/Contexto (3.20.1) ──────────────────────────
  // Mismo endpoint y mismo servidor: /api/v1/events?topics=memory. Canal APARTE (ids y búfer propios) para no
  // alterar el de los grafos. Solo viajan sellos de "algo cambió" (sin contenido): el cliente reconsulta la API
  // paginada. Idempotente (el cliente compara sellos), con Last-Event-ID, límite de clientes y keepalive; un
  // cursor viejo o de otra ejecución recibe `snapshot` y reconsulta: el SSE NO es la historia, es un aviso.
  const suscritosMemoria = new Set();
  const bufferMem = [];
  let seqMem = 0;
  let marcaMem = null;
  let firmaMem = null;
  const panelMem = () => require('./memoria-panel.cjs');
  const mtimeDe = (f) => { try { return String(fs.statSync(f).mtimeMs); } catch { return '-'; } };
  const firmaExtra = () => mtimeDe(path.join(projectPath, '.agentic', '_effort')) + ':' + mtimeDe(path.join(projectPath, '.agentic', '_update', 'last-result.json'));

  function sondearMemoria() {
    let m;
    try { m = panelMem().marca(projectPath); } catch { return; }
    firmaMem = firma() + '|' + firmaExtra();
    if (marcaMem === null) { marcaMem = m; return; } // primera lectura: línea base, no es un cambio
    if (m.memory === marcaMem.memory && m.context === marcaMem.context) return;
    marcaMem = m;
    const ev = { id: ++seqMem, tipo: 'memory', data: { memory_stamp: m.memory, context_stamp: m.context, at: new Date().toISOString() } };
    bufferMem.push(ev);
    if (bufferMem.length > 100) bufferMem.shift();
    for (const c of suscritosMemoria) enviar(c, ev);
  }

  // ─── SSE «la página quedó vieja» (?topics=pagina) ──────────────────────────────
  // Sin ids ni búfer: solo viaja la huella. Al conectarse recibe la actual (el cliente la compara con la de SU página: si ya difiere,
  // nació vieja) y después un evento por cada cambio de lo que la página pinta. El cliente reconsulta la página, no hay nada que reponer.
  function abrirStreamPagina(req, res) {
    if (clientes.size + suscritosMemoria.size + suscritosPagina.size >= tope) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '10' });
      return res.end(JSON.stringify({ schema_version: SCHEMA_VERSION, status: 'UNAVAILABLE', reason_code: 'DEMASIADOS_CLIENTES', errors: [{ code: 'DEMASIADOS_CLIENTES' }] }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff' });
    res.write('retry: 3000\n\n');
    try { avisarPagina(); } catch { /* auxiliar */ }
    res.write(`event: pagina\ndata: ${JSON.stringify({ huella: huellaPag, inicial: true })}\n\n`);
    suscritosPagina.add(res);
    arrancar();
    const latido = setInterval(() => res.write(': keepalive\n\n'), 15000);
    latido.unref();
    req.on('close', () => { clearInterval(latido); suscritosPagina.delete(res); parar(); });
  }

  function abrirStreamMemoria(req, res) {
    if (clientes.size + suscritosMemoria.size >= tope) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '10' });
      return res.end(JSON.stringify({ schema_version: SCHEMA_VERSION, status: 'UNAVAILABLE', reason_code: 'DEMASIADOS_CLIENTES', errors: [{ code: 'DEMASIADOS_CLIENTES' }] }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff' });
    res.write('retry: 3000\n\n');
    // Detecta lo ocurrido mientras nadie escuchaba, ANTES de decidir qué reponer.
    sondearMemoria();
    const ultimo = Number(req.headers['last-event-id']);
    const actualMem = { memory_stamp: marcaMem && marcaMem.memory, context_stamp: marcaMem && marcaMem.context, at: new Date().toISOString() };
    if (Number.isInteger(ultimo) && ultimo > 0) {
      if (ultimo > seqMem || (bufferMem.length && ultimo < bufferMem[0].id - 1)) enviar(res, { id: seqMem, tipo: 'snapshot', data: Object.assign({ motivo: 'CURSOR_EXPIRADO' }, actualMem) });
      else for (const e of bufferMem.filter((x) => x.id > ultimo)) enviar(res, e);
    } else enviar(res, { id: seqMem, tipo: 'memory', data: actualMem });
    suscritosMemoria.add(res); // canal aparte: NO entra en `clientes`, que recibe las revisiones de los grafos
    arrancar();
    const latido = setInterval(() => res.write(': keepalive\n\n'), 15000);
    latido.unref();
    req.on('close', () => { clearInterval(latido); suscritosMemoria.delete(res); parar(); });
  }

  // Única acción de los paneles: reintentar un job muerto de la cola. POST con origen exacto, cabecera de acción,
  // JSON acotado, validación del id y límites (3 por job, 10 por minuto). Nunca borra ni valida memoria.
  function manejarAccion(req, res) {
    const responder = (http, extra) => sobre(res, req, Object.assign({ status: 'UNAVAILABLE', data: null }, extra), http);
    const origen = req.headers.origin;
    if (!origen || origen !== 'http://' + req.headers.host) return responder(403, { errors: [{ code: 'ORIGEN_NO_PERMITIDO' }], reason_code: 'ORIGEN_NO_PERMITIDO' });
    const accion = req.headers['x-akdd-action'];
    if (accion !== 'memory-retry' && accion !== 'decision-answer') return responder(403, { errors: [{ code: 'ACCION_NO_AUTORIZADA' }], reason_code: 'ACCION_NO_AUTORIZADA' });
    const tope = accion === 'decision-answer' ? 8192 : 1024;
    if (!/^application\/json(\s*;|$)/i.test(String(req.headers['content-type'] || ''))) return responder(415, { errors: [{ code: 'CONTENT_TYPE_INVALIDO' }], reason_code: 'CONTENT_TYPE_INVALIDO' });
    let cuerpo = ''; let excedido = false;
    req.setEncoding('utf8');
    req.on('data', (d) => { cuerpo += d; if (cuerpo.length > tope) { excedido = true; req.destroy(); } });
    req.on('error', () => {});
    req.on('end', () => {
      if (excedido) return;
      let j = null;
      try { j = JSON.parse(cuerpo); } catch { return responder(400, { errors: [{ code: 'JSON_INVALIDO' }], reason_code: 'JSON_INVALIDO' }); }
      if (accion === 'decision-answer') {
        if (!j || typeof j !== 'object' || typeof j.id !== 'string') return responder(400, { errors: [{ code: 'ID_REQUERIDO' }], reason_code: 'ID_REQUERIDO' });
        let r;
        try { r = require('./decisiones.cjs').responder(projectPath, j.id, { opcion: j.opcion, texto: j.texto, porque: j.porque, via: 'dashboard' }); } catch (e) { return responder(500, { reason_code: 'ERROR', cause: String(e.message || e).slice(0, 160) }); }
        if (r.ok) return responder(200, { status: 'OK', data: { id: r.id, estado: r.estado } });
        const http = r.code === 'NO_EXISTE' ? 404 : (r.code === 'YA_RESPONDIDA' ? 409 : (r.code === 'SIN_CANAL' ? 409 : 400));
        return responder(http, { errors: [{ code: r.code, message: r.message || null }], reason_code: r.code });
      }
      if (!j || typeof j !== 'object' || typeof j.job_id !== 'string') return responder(400, { errors: [{ code: 'JOB_ID_REQUERIDO' }], reason_code: 'JOB_ID_REQUERIDO' });
      let r;
      try { r = panelMem().reintentar(projectPath, j.job_id, { source: 'dashboard' }); } catch (e) { return responder(500, { reason_code: 'ERROR', cause: String(e.message || e).slice(0, 160) }); }
      if (r.ok) return responder(200, { status: 'OK', data: { job_id: j.job_id, state: r.status, manual_retries: r.manual_retries } });
      const http = r.code === 'JOB_NO_EXISTE' ? 404 : (r.code === 'DEMASIADOS_REINTENTOS' ? 429 : (r.code === 'JOB_ID_INVALIDO' ? 400 : 409));
      return responder(http, { errors: [{ code: r.code, message: r.message || null }], reason_code: r.code });
    });
  }

  // Última respuesta buena por ruta+consulta: si la base está bloqueada por un escritor largo se sirve esto marcado como `stale`.
  const ultimoBueno = new Map();

  function manejar(req, res, ruta, qs) {
    if (!ruta.startsWith('/api/v1/')) return false;
    const nombre = ruta.slice('/api/v1/'.length);
    const origen = req.headers.origin;
    if (origen && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origen)) {
      sobre(res, req, { status: 'UNAVAILABLE', data: null, errors: [{ code: 'ORIGEN_NO_PERMITIDO' }], reason_code: 'ORIGEN_NO_PERMITIDO' }, 403);
      return true;
    }
    const def = RUTAS[nombre];
    if (!def) { sobre(res, req, { status: 'UNAVAILABLE', data: null, errors: [{ code: 'RUTA_DESCONOCIDA' }], reason_code: 'RUTA_DESCONOCIDA' }, 404); return true; }
    if (nombre === 'events' && /text\/event-stream/.test(String(req.headers.accept || ''))) {
      // ?topics=memory: canal propio de los paneles Memoria/Contexto (sus ids y su búfer). Sin topics: el canal de siempre, intacto.
      if (qs.get('topics') === 'memory') abrirStreamMemoria(req, res); else if (qs.get('topics') === 'pagina') abrirStreamPagina(req, res); else abrirStream(req, res);
      return true;
    }
    let q;
    try { q = leerQuery(qs, def.params, projectId); } catch (e) {
      if (!(e instanceof ErrorPeticion)) throw e;
      sobre(res, req, { status: 'UNAVAILABLE', data: null, errors: [{ code: e.code, message: e.message }], reason_code: e.code }, e.status);
      return true;
    }
    let r = def.fn(q);
    const claveCache = nombre + '?' + [...qs].sort().join('&');
    if (r && (r.status === 'OK' || r.status === 'EMPTY')) ultimoBueno.set(claveCache, { r, at: Date.now() });
    else if (r && r.status === 'UNAVAILABLE' && r.reason_code === 'DB_BLOQUEADA') {
      const previo = ultimoBueno.get(claveCache);
      if (previo && Date.now() - previo.at < 15 * 60000) r = Object.assign({}, previo.r, { stale: { since: new Date(previo.at).toISOString(), reason: 'DB_BLOQUEADA' } });
    }
    sobre(res, req, Object.assign({ window: ventana(q), extraEtag: JSON.stringify([nombre, [...qs].sort()]) }, r), r.http);
    return true;
  }

  function cerrar() {
    for (const c of [...clientes, ...suscritosMemoria, ...suscritosPagina]) { try { c.end(); } catch { /* ya cerrado */ } }
    clientes.clear(); suscritosMemoria.clear(); suscritosPagina.clear();
    if (temporizador) { clearInterval(temporizador); temporizador = null; }
  }

  return { manejar, manejarAccion, cerrar, revision, leerResumen, huellaPagina: huellaPaginaActual, clientes: () => clientes.size };
}

module.exports = { crearApi, integraciones, leerQuery, huellaPaginaDe, SCHEMA_VERSION, LIMITE_MAX };
