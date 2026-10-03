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
const hash = (x) => crypto.createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex').slice(0, 16);
const iso = (x) => { const d = fu.fechaUtc(x); return d ? d.toISOString() : null; };

/* Integraciones del onboarding: instalada no es activa, y ninguna se declara
   probada sin una huella propia; las pruebas con fixtures no la sustituyen. */
function integraciones(projectPath) {
  const hay = (f) => fs.existsSync(path.join(projectPath, '.agentic', 'grafo', f));
  const teams = (() => {
    if (!hay('teams-manager.cjs')) return { id: 'teams', estado: 'no_instalada', detalle: '', accion: 'akdd update' };
    try {
      const tm = require('./teams-manager.cjs');
      const st = typeof tm.estado === 'function' ? tm.estado(projectPath) : null;
      if (st && (st.status === 'ACTIVE' || st.activo === true)) {
        return { id: 'teams', estado: 'activa', detalle: 'coordinación activa', accion: '' };
      }
      if (st && st.status) {
        return { id: 'teams', estado: 'instalada', detalle: 'módulo presente; estado=' + st.status + ' — no verificado por existir el archivo', accion: 'teams: activar' };
      }
    } catch { /* el archivo fixture no es el módulo real */ }
    return { id: 'teams', estado: 'instalada', detalle: 'módulo presente; sin evidencia de host nativo ni ACTIVE', accion: 'teams: activar' };
  })();
  return [
    teams,
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

function crearApi({ dbPath, projectPath, projectId, pollMs, maxClientes, abrir } = {}) {
  const opts = abrir ? { abrir } : {};
  const intervalo = Number(pollMs || process.env.AKDD_DASH_POLL_MS || 2000);
  const tope = Number(maxClientes || process.env.AKDD_DASH_MAX_SSE || 8);

  /** Lectura única del resumen: métricas, contratos y memoria en una transacción. */
  function leerResumen() {
    const r = datos.filas(dbPath, Object.assign({}, servicio.CONSULTAS, {
      contratos: { tabla: 'verified_contracts', sql: "SELECT status, COUNT(*) AS n FROM verified_contracts WHERE status IS NULL OR status != 'deprecated' GROUP BY status" },
      nodos: { tabla: 'nodos', sql: 'SELECT tipo, COUNT(*) AS n FROM nodos GROUP BY tipo' },
    }), Object.assign({ snapshot: true }, opts));
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

  function revision() {
    const r = leerResumen();
    return r.data ? hash(r.data) : 'sin-dato-' + (r.reason_code || r.status);
  }

  function sobre(res, req, { status, data, errors, coverage, window, reason_code, extraEtag, source, cause, accion, incompletos }, http) {
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
    const etag = `"${hash(snapshot_revision + '|' + (extraEtag || ''))}"`;
    const base = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache', ETag: etag, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
    if ((http || 200) === 200 && req.headers['if-none-match'] === etag) { res.writeHead(304, base); return res.end(); }
    res.writeHead(http || 200, base);
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify(cuerpo));
  }

  const ventana = (q) => ({ from: q.from ? q.from.toISOString() : null, to: q.to ? q.to.toISOString() : null });

  const RUTAS = {
    summary: { params: ['project_id'], fn: () => {
      const r = leerResumen();
      return { status: r.data ? r.status : 'UNAVAILABLE', data: r.data, reason_code: r.reason_code, errors: r.faltan.map((t) => ({ code: 'TABLA_AUSENTE', source: t })) };
    } },
    tasks: { params: ['project_id', 'plan_id', 'from', 'to', 'cursor', 'limit', 'estado'], fn: (q) => {
      if ('plan_id' in q) return { status: 'UNAVAILABLE', data: [], reason_code: 'PLAN_SIN_FUENTE', errors: [{ code: 'PLAN_SIN_FUENTE', message: 'este proyecto no tiene planes registrados en la base' }] };
      const r = datos.filas(dbPath, { ciclos: { tabla: 'ciclos', sql: 'SELECT id, ciclo_id, tarea, modulo, tipo_tarea, estado, tests_generados, tests_pasando, stops_count, fecha_inicio, fecha_fin FROM ciclos' } }, Object.assign({ snapshot: true }, opts));
      if (r.status !== 'OK') return { status: 'UNAVAILABLE', data: null, reason_code: r.reason_code };
      if ((r.faltan || []).includes('ciclos')) return { status: 'UNAVAILABLE', data: null, reason_code: 'TABLA_AUSENTE' };
      let lista = r.value.ciclos.filter((c) => enVentana(q, c.fecha_inicio));
      if (q.estado) lista = lista.filter((c) => ec.clasificar(c.estado) === q.estado);
      lista.sort((a, b) => -fu.compararPorFecha(a, b, 'fecha_inicio'));
      const { pagina, coverage } = paginar(lista, q);
      return { status: lista.length ? 'OK' : 'EMPTY', coverage, data: pagina.map((c) => Object.assign({}, c, { clase: ec.clasificar(c.estado), fecha_inicio: iso(c.fecha_inicio), fecha_fin: iso(c.fecha_fin) })) };
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

  const firma = () => ['', '-wal'].map((s) => { try { const st = fs.statSync(dbPath + s); return st.size + ':' + st.mtimeMs; } catch { return '-'; } }).join('|');
  const enviar = (res, ev) => res.write(`id: ${ev.id}\nevent: ${ev.tipo}\ndata: ${JSON.stringify(ev.data)}\n\n`);

  function sondear() {
    const f = firma();
    if (f === firmaArchivo && actual !== null) return;
    firmaArchivo = f;
    const rev = revision();
    if (rev === actual) return;
    actual = rev;
    const ev = { id: ++seq, tipo: 'revision', data: { snapshot_revision: rev, at: new Date().toISOString() } };
    buffer.push(ev);
    if (buffer.length > 100) buffer.shift();
    for (const c of clientes) enviar(c, ev);
  }
  function arrancar() { if (!temporizador) { temporizador = setInterval(sondear, intervalo); temporizador.unref(); } }
  function parar() { if (temporizador && !clientes.size) { clearInterval(temporizador); temporizador = null; } }

  function abrirStream(req, res) {
    if (clientes.size >= tope) {
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
    if (nombre === 'events' && /text\/event-stream/.test(String(req.headers.accept || ''))) { abrirStream(req, res); return true; }
    let q;
    try { q = leerQuery(qs, def.params, projectId); } catch (e) {
      if (!(e instanceof ErrorPeticion)) throw e;
      sobre(res, req, { status: 'UNAVAILABLE', data: null, errors: [{ code: e.code, message: e.message }], reason_code: e.code }, e.status);
      return true;
    }
    const r = def.fn(q);
    sobre(res, req, Object.assign({ window: ventana(q), extraEtag: JSON.stringify([nombre, [...qs].sort()]) }, r));
    return true;
  }

  function cerrar() {
    for (const c of clientes) { try { c.end(); } catch { /* ya cerrado */ } }
    clientes.clear();
    if (temporizador) { clearInterval(temporizador); temporizador = null; }
  }

  return { manejar, cerrar, revision, leerResumen, clientes: () => clientes.size };
}

module.exports = { crearApi, integraciones, leerQuery, SCHEMA_VERSION, LIMITE_MAX };
