'use strict';
/**
 * Páginas /memoria y /contexto del dashboard (3.20.1, C03 + H03).
 *
 * Son PÁGINAS PROPIAS servidas por el mismo dashboard: no añaden ni mueven ningún
 * control de los grafos KDD / combinado / code structure (su interfaz y diseño quedan
 * exactamente como estaban). Leen /api/v1/memory-health, memory, memory-items,
 * memory-item y context, y se mantienen al día con el canal SSE existente
 * (/api/v1/events?topics=memory) con respaldo por sondeo.
 *
 * Todo dato del servidor llega al DOM con textContent: nada se interpreta como HTML
 * (un <script> en un título se ve como texto). Sin recursos externos.
 *
 * El código de cliente evita comillas invertidas, ${} y barras invertidas a propósito:
 * vive dentro de una plantilla de texto y así no hay nada que se escape mal.
 */

const CSS = `
  :root { --bg:#0A0E14; --panel:#111823; --line:#1f2a3a; --txt:#d6dde8; --dim:#8A97A6; --ok:#3FE2E8; --warn:#D9A33C; --bad:#ff6b6b; }
  @media (prefers-color-scheme: light) { :root { --bg:#f6f8fb; --panel:#fff; --line:#d9e0ea; --txt:#17202e; --dim:#5c6b7e; --ok:#0a8f96; --warn:#9a6a00; --bad:#c0392b; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--txt); font:14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { padding:20px 24px 8px; display:flex; flex-wrap:wrap; align-items:baseline; gap:12px; }
  h1 { margin:0; font-size:20px; } .sub { color:var(--dim); }
  nav { display:flex; gap:14px; padding:0 24px 6px; flex-wrap:wrap; } nav a { color:var(--dim); text-decoration:none; border-bottom:1px solid transparent; } nav a:hover, nav a.on { color:var(--txt); border-color:var(--ok); }
  main { padding:8px 24px 40px; display:grid; gap:14px; grid-template-columns:repeat(auto-fit, minmax(320px, 1fr)); max-width:1280px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px 16px; min-width:0; }
  .card h2 { margin:0 0 8px; font-size:12px; letter-spacing:.06em; text-transform:uppercase; color:var(--dim); font-weight:600; }
  .big { font-size:20px; font-weight:650; margin-bottom:6px; } .row { display:flex; justify-content:space-between; gap:12px; padding:3px 0; border-bottom:1px dashed var(--line); } .row:last-child { border:0; }
  .k { color:var(--dim); } .v { text-align:right; overflow-wrap:anywhere; }
  .pill { display:inline-block; padding:1px 9px; border-radius:99px; font-size:12px; font-weight:600; border:1px solid currentColor; white-space:nowrap; }
  .ok { color:var(--ok); } .warn { color:var(--warn); } .bad { color:var(--bad); } .dim { color:var(--dim); }
  .wide { grid-column:1 / -1; } ul { margin:6px 0 0; padding-left:18px; } li { margin:3px 0; overflow-wrap:anywhere; }
  button, select, input { background:transparent; color:var(--txt); border:1px solid var(--line); border-radius:7px; padding:5px 10px; font:inherit; }
  button { cursor:pointer; } button:hover { border-color:var(--ok); } button:disabled { opacity:.5; cursor:default; }
  button:focus-visible, select:focus-visible, input:focus-visible { outline:2px solid var(--ok); outline-offset:2px; }
  .chk { padding:6px 0; border-bottom:1px dashed var(--line); } .chk:last-child { border:0; }
  .chk .head { display:flex; gap:10px; align-items:center; flex-wrap:wrap; } .chk .meta { color:var(--dim); font-size:12px; margin-top:2px; overflow-wrap:anywhere; }
  .tabs { display:flex; gap:8px; margin-bottom:8px; flex-wrap:wrap; } .tabs button.on { border-color:var(--ok); color:var(--ok); }
  .filtros { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:8px; }
  table { width:100%; border-collapse:collapse; } th, td { text-align:left; padding:4px 8px; border-bottom:1px solid var(--line); vertical-align:top; overflow-wrap:anywhere; } th { color:var(--dim); font-weight:600; font-size:12px; }
  tr.fila { cursor:pointer; } tr.fila:hover td { background:rgba(63,226,232,.06); }
  .tag { display:inline-block; padding:0 7px; border-radius:6px; font-size:11px; font-weight:600; border:1px solid currentColor; }
  .bar { height:8px; background:var(--line); border-radius:4px; overflow:hidden; margin:4px 0; } .bar > span { display:block; height:100%; background:var(--ok); } .bar.over > span { background:var(--bad); }
  .tarea { border:1px solid var(--line); border-radius:8px; padding:10px 12px; margin-bottom:10px; }
  .foot { padding:0 24px 24px; color:var(--dim); font-size:12px; }
  .aviso { background:rgba(217,163,60,.12); border:1px solid var(--warn); border-radius:8px; padding:6px 10px; margin-bottom:8px; }
`;

/* Utilidades comunes del cliente: construyen DOM con textContent, nunca HTML. */
const BASE_JS = `
  var raiz = document.getElementById('raiz'), sub = document.getElementById('sub'), vivo = document.getElementById('vivo');
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt !== undefined && txt !== null) e.textContent = String(txt); return e; }
  function nd(v) { return v === null || v === undefined ? 'no disponible' : (typeof v === 'number' ? v.toLocaleString() : String(v)); }
  function bytes(n) { if (n === null || n === undefined) return 'no disponible'; return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : (n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B'); }
  function fecha(x) { if (!x) return 'no disponible'; var d = new Date(x); return isNaN(d) ? String(x) : d.toLocaleString(); }
  function hace(ms) { if (ms === null || ms === undefined) return 'no disponible'; var s = Math.round(ms / 1000); if (s < 90) return s + ' s'; var m = Math.round(s / 60); if (m < 90) return m + ' min'; var h = Math.round(m / 60); return h < 48 ? h + ' h' : Math.round(h / 24) + ' d'; }
  function fila(c, k, v, cls) { var r = el('div', 'row'); r.appendChild(el('span', 'k', k)); r.appendChild(el('span', 'v' + (cls ? ' ' + cls : ''), v)); c.appendChild(r); return r; }
  function card(titulo, wide) { var c = el('section', 'card' + (wide ? ' wide' : '')); c.appendChild(el('h2', null, titulo)); raiz.appendChild(c); return c; }
  function cls(s) { return s === 'OK' || s === 'READY' || s === 'PASS' ? 'ok' : (s === 'FAIL' || s === 'NOT_READY' ? 'bad' : 'warn'); }
  function pill(s) { return el('span', 'pill ' + cls(s), s); }
  function getJSON(url) { return fetch(url, { cache: 'no-store' }).then(function (r) { return r.json(); }); }
  function ul(items) { var u = el('ul'); for (var i = 0; i < items.length; i++) u.appendChild(el('li', null, items[i])); return u; }
  var EPI = { asserted: ['Afirmado por el agente', 'warn'], observed: ['Observado', ''], verified: ['Verificado', 'ok'] };
  function epi(k) { var p = EPI[k]; return p ? el('span', 'tag ' + p[1], p[0]) : el('span', 'tag dim', 'sin clasificar'); }
  /* Canal en vivo: el SSE existente con topics=memory. Solo trae sellos; al cambiar se reconsulta la API paginada.
     Eventos duplicados o repetidos son inocuos (se compara el sello). Si falla, sondeo cada 30 s. */
  function conectarVivo(alCambiar, sello) {
    var sondeo = null, fallos = 0;
    function estado(t) { if (vivo) vivo.textContent = t; }
    function sondear() { if (sondeo) return; estado('sondeo cada 30 s'); sondeo = setInterval(function () { alCambiar(true); }, 30000); }
    if (!window.EventSource) { sondear(); return; }
    function abrir() {
      var es = new EventSource('/api/v1/events?topics=memory');
      es.addEventListener('open', function () { fallos = 0; if (sondeo) { clearInterval(sondeo); sondeo = null; } estado('en vivo'); });
      es.addEventListener('memory', function (e) { try { var d = JSON.parse(e.data); if (sello(d) !== undefined && sello(d) !== window.__sello) alCambiar(false); } catch (x) { alCambiar(false); } });
      es.addEventListener('snapshot', function () { alCambiar(true); });
      es.addEventListener('error', function () { fallos++; if (es.readyState === 2) { sondear(); setTimeout(abrir, 90000); } else if (fallos >= 3) sondear(); else estado('reconectando'); });
    }
    abrir();
  }
`;

function pagina(titulo, activo, js) {
  const link = (href, txt, id) => '<a href="' + href + '"' + (id === activo ? ' class="on"' : '') + '>' + txt + '</a>';
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agentix — ${titulo}</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <h1>${titulo}</h1>
  <span class="sub" id="sub">cargando…</span>
  <span class="sub">· <span id="vivo">conectando…</span></span>
  <button id="recargar" type="button">Actualizar vista</button>
</header>
<nav>${link('/', 'Tablero de grafos', 'grafos')}${link('/memoria', 'Memoria', 'memoria')}${link('/contexto', 'Contexto y esfuerzo', 'contexto')}${link('/actualizacion', 'Actualización', 'actualizacion')}${link('/teams', 'Campaña TEAMS', 'teams')}</nav>
<main id="raiz" aria-live="polite"></main>
<div class="foot" id="pie"></div>
<script>
(function () {
  'use strict';
${BASE_JS}
${js}
})();
</script>
</body>
</html>
`;
}

// ───────────────────────────── /memoria ──────────────────────────────────────
const MEMORIA_JS = `
  document.getElementById('pie').textContent = 'Muestra estados, recuentos y resúmenes ya redactados; nunca el contenido original de tus archivos ni secretos. Solo lectura, salvo reintentar un job fallido (máx. 3 por job).';
  var NOMBRES = { service_available: 'Servicio', db_readable: 'Base legible', schema_compatible: 'Esquema compatible', memory_search_ready: 'Búsqueda lista', memory_write_verified_at: 'Escritura verificada', queue_healthy: 'Cola sana', update_state: 'Actualización' };
  var ORDEN = ['service_available', 'db_readable', 'schema_compatible', 'memory_search_ready', 'memory_write_verified_at', 'queue_healthy', 'update_state'];
  var kind = 'events', cursores = [], cursorActual = null, filtros = {}, hayCambios = false;
  window.__sello = undefined;
  var zonaLista = null, zonaDetalle = null, zonaMensaje = null, mensajeCola = '';

  function pintarSalud(h) {
    var c = card('Salud de la memoria', true);
    if (!h) { c.appendChild(el('div', 'bad', 'No se pudo leer la salud.')); return; }
    var g = el('div', 'big ' + cls(h.status), h.status === 'READY' ? 'La memoria está lista' : (h.status === 'DEGRADED' ? 'La memoria funciona con limitaciones' : 'La memoria NO está lista'));
    c.appendChild(g); c.appendChild(el('div', 'dim', h.explanation));
    for (var i = 0; i < ORDEN.length; i++) {
      var k = ORDEN[i], x = h.checks[k]; if (!x) continue;
      var d = el('div', 'chk'), hd = el('div', 'head');
      hd.appendChild(el('strong', null, NOMBRES[k] || k)); hd.appendChild(pill(x.status)); if (x.code) hd.appendChild(el('span', 'dim', x.code));
      d.appendChild(hd); d.appendChild(el('div', null, x.detail || ''));
      var meta = 'fuente: ' + nd(x.source) + ' · alcance: ' + nd(x.scope) + ' · comprobado: ' + fecha(x.checked_at) + (x.age_ms !== null && x.age_ms !== undefined ? ' (hace ' + hace(x.age_ms) + ')' : '') + (x.expires_at ? ' · ' + (x.expired ? 'EXPIRÓ el ' : 'expira el ') + fecha(x.expires_at) : '');
      d.appendChild(el('div', 'meta', meta));
      if (x.action) d.appendChild(el('div', 'meta warn', 'Qué hacer: ' + x.action));
      c.appendChild(d);
    }
    c.appendChild(el('div', 'dim', 'Mirar esta página nunca escribe en la memoria. La prueba de escritura es un comando explícito y su resultado caduca.'));
  }

  function pintarInventario(m) {
    var c = card('Qué hay guardado');
    var inv = m.inventory;
    fila(c, 'Conocimientos (nodos)', nd(inv.nodes_total));
    fila(c, 'Sin procedencia (registros antiguos)', nd(inv.legacy_without_provenance), inv.legacy_without_provenance ? 'warn' : '');
    fila(c, 'Actividades capturadas', nd(inv.events_total));
    fila(c, 'Evidencias', nd(inv.evidence_total));
    if (inv.by_type) { var t = el('table'), th = el('tr'); ['Tipo', 'Total', 'Vigentes', 'Sospechosos', 'Obsoletos'].forEach(function (h) { th.appendChild(el('th', null, h)); }); t.appendChild(th);
      inv.by_type.forEach(function (r) { var tr = el('tr'); [r.tipo, r.count, r.current, r.suspect, r.obsolete].forEach(function (v) { tr.appendChild(el('td', null, v)); }); t.appendChild(tr); }); c.appendChild(t); }
    else c.appendChild(el('div', 'dim', 'Inventario de tipos: no disponible.'));
    c.appendChild(el('div', 'k', 'Por grado de certeza'));
    if (inv.knowledge_by_state) { if (!inv.knowledge_by_state.length) c.appendChild(el('div', 'dim', 'Aún no hay conocimiento con procedencia nueva.')); else c.appendChild(ul(inv.knowledge_by_state.map(function (r) { return r.state + ' · ' + r.provenance + ': ' + r.count; }))); }
    else c.appendChild(el('div', 'dim', 'no disponible (faltan tablas: akdd update)'));
    c.appendChild(el('div', 'k', 'Observaciones'));
    c.appendChild(inv.observations_by_status ? (inv.observations_by_status.length ? ul(inv.observations_by_status.map(function (r) { return r.status + ': ' + r.count; })) : el('div', 'dim', 'ninguna todavía')) : el('div', 'dim', 'no disponible'));
  }

  function pintarCola(m) {
    var c = card('Cola de procesamiento'), q = m.queue;
    if (!q || !q.available) { c.appendChild(el('div', 'warn', 'Cola no disponible' + (q && q.hint ? ': ' + q.hint : '.'))); return; }
    c.appendChild(el('span', 'pill ' + (q.healthy ? 'ok' : 'bad'), q.healthy ? 'sana' : 'con problemas'));
    fila(c, 'Pendientes', q.pending); fila(c, 'En proceso (activos)', q.active); fila(c, 'En reintento', q.retry); fila(c, 'Fallidos definitivos', q.failed, q.failed ? 'bad' : '');
    fila(c, 'Hechos', q.done); fila(c, 'Leases vencidos', q.expired_leases, q.expired_leases ? 'warn' : ''); fila(c, 'Obligatorios sin cerrar', q.required_pending);
    fila(c, 'Trabajo pendiente más antiguo', q.pending + q.active + q.retry ? hace(q.oldest_pending_age_ms) : 'nada pendiente');
    zonaMensaje = el('div', 'dim', mensajeCola); c.appendChild(zonaMensaje);
    if (q.dead_letter.length) {
      c.appendChild(el('div', 'k', 'Jobs fallidos (reintento manual, máx. ' + q.max_manual_retries + ' por job)'));
      q.dead_letter.forEach(function (d) {
        var r = el('div', 'row'); r.appendChild(el('span', 'k', d.job_id.slice(0, 16) + '… · ' + nd(d.error_code) + ' · reintentos ' + d.manual_retries));
        var b = el('button', null, d.can_retry ? 'Reintentar' : 'Sin reintentos'); b.type = 'button'; b.disabled = !d.can_retry;
        b.addEventListener('click', function () { reintentar(d.job_id, b); }); r.appendChild(b); c.appendChild(r);
      });
    }
  }
  function reintentar(id, b) {
    b.disabled = true;
    fetch('/api/v1/memory-retry', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Akdd-Action': 'memory-retry' }, body: JSON.stringify({ job_id: id }) })
      .then(function (r) { return r.json(); }).then(function (j) { mensajeCola = j.status === 'OK' ? 'Reencolado: ' + id.slice(0, 16) + '…' : 'No se pudo reintentar: ' + (j.reason_code || 'error'); cargarTodo(); })
      .catch(function (e) { mensajeCola = 'Error: ' + e.message; if (zonaMensaje) zonaMensaje.textContent = mensajeCola; b.disabled = false; });
  }

  function pintarHuecos(m) {
    var c = card('Huecos de captura');
    c.appendChild(el('div', 'dim', 'Lo que NO se capturó se muestra aquí; nada se omite en silencio.'));
    var g = m.capture_gaps || [];
    if (!g.length) { c.appendChild(el('div', 'ok', 'Sin huecos conocidos.')); return; }
    var u = el('ul'); g.forEach(function (x) { var li = el('li', x.info ? 'dim' : 'warn', x.message); if (x.hosts) li.textContent += ' — ' + x.hosts.map(function (h) { return h.host + ': ' + h.events; }).join(', '); u.appendChild(li); }); c.appendChild(u);
  }

  function pintarUpdate(m) {
    var c = card('Última actualización y conservación'), u = m.update;
    if (!u || !u.available) { c.appendChild(el('div', 'dim', 'no disponible')); return; }
    fila(c, 'Versión instalada', nd(u.installed_version));
    fila(c, 'Esquema', u.schema.status + (u.schema.pending ? ' (' + u.schema.pending + ' pendientes)' : ''), u.schema.status === 'COMPLETE' ? 'ok' : 'warn');
    if (!u.last_verification) c.appendChild(el('div', 'warn', 'Sin verificación de actualización registrada.'));
    else { fila(c, 'Estado', u.last_verification.status, cls(/VERIFIED/.test(u.last_verification.status) && u.last_verification.status !== 'VERIFIED_WITH_WARNINGS' ? 'OK' : 'WARN')); fila(c, 'Terminó', fecha(u.last_verification.finished_at)); }
    var mp = u.memory_preserved;
    fila(c, 'Memoria conservada', mp && mp.database ? mp.database.status : 'no disponible', mp && mp.database && mp.database.status === 'PASS' ? 'ok' : 'warn');
    fila(c, 'Archivos propios conservados', mp && mp.own_files ? mp.own_files.status : 'no disponible', mp && mp.own_files && mp.own_files.status === 'PASS' ? 'ok' : 'warn');
    fila(c, 'Respaldo', u.backup_available ? 'disponible' : 'no hay');
  }

  function pintarResumen(h, m) {
    raiz.textContent = ''; zonaLista = null;
    pintarSalud(h);
    if (!m || !m.data) { var c0 = card('Memoria', true); c0.appendChild(el('div', 'bad', 'El servicio no devolvió datos de memoria' + (m && m.reason_code ? ' (' + m.reason_code + ')' : '') + '.')); return; }
    var d = m.data;
    if (!d.available) { var c1 = card('Memoria', true); c1.appendChild(el('div', 'bad', 'La memoria no está disponible: ' + (d.code || 'desconocido') + (d.hint ? ' — ' + d.hint : ''))); pintarUpdate(d); return; }
    window.__sello = d.stamp ? d.stamp.memory : undefined;
    if (d.identity && d.identity.hint) { var ci = card('Identidad del proyecto', true); ci.appendChild(el('div', 'warn', d.identity.hint)); }
    if (!d.schema_ready) { var cs = card('Esquema de memoria con procedencia', true); cs.appendChild(el('div', 'warn', 'Faltan tablas' + (d.missing_tables && d.missing_tables.length ? ': ' + d.missing_tables.join(', ') : '') + '. Esta página no migra nada: ejecuta akdd update.')); }
    pintarInventario(d); pintarCola(d); pintarHuecos(d); pintarUpdate(d);
    var a = card('Actividad guardada', true);
    var tabs = el('div', 'tabs');
    [['events', 'Actividades (eventos)'], ['observations', 'Observaciones'], ['knowledge', 'Conocimientos']].forEach(function (t) {
      var b = el('button', kind === t[0] ? 'on' : '', t[1]); b.type = 'button'; b.addEventListener('click', function () { kind = t[0]; cursores = []; cursorActual = null; filtros = {}; cargarTodo(); }); tabs.appendChild(b);
    });
    a.appendChild(tabs);
    a.appendChild(el('div', 'dim', 'Etiquetas: Afirmado = lo dijo el agente sin respaldo · Observado = nace de actividad registrada, aún sin validar · Verificado = validado con evidencia vigente.'));
    var fl = el('div', 'filtros');
    var campos = kind === 'events' ? [['type', 'tipo'], ['host', 'host'], ['status', 'estado'], ['task', 'tarea']] : (kind === 'observations' ? [['type', 'clase'], ['status', 'estado'], ['task', 'tarea']] : [['type', 'tipo'], ['state', 'estado'], ['provenance', 'procedencia']]);
    campos.concat([['q', 'texto']]).forEach(function (cm) { var i = el('input'); i.placeholder = cm[1]; i.value = filtros[cm[0]] || ''; i.setAttribute('aria-label', 'filtro ' + cm[1]); i.addEventListener('change', function () { filtros[cm[0]] = i.value.trim(); cursores = []; cursorActual = null; cargarLista(); }); fl.appendChild(i); });
    a.appendChild(fl);
    if (hayCambios) { var av = el('div', 'aviso', 'Hay actividad nueva. '); var rb = el('button', null, 'Ver lo último'); rb.type = 'button'; rb.addEventListener('click', function () { cursores = []; cursorActual = null; hayCambios = false; cargarTodo(); }); av.appendChild(rb); a.appendChild(av); }
    zonaLista = el('div'); a.appendChild(zonaLista);
    zonaDetalle = card('Detalle', true); zonaDetalle.appendChild(el('div', 'dim', 'Elige un elemento de la lista para ver su explicación, origen, archivos, evidencias y validación.'));
    cargarLista();
  }

  function cabecera(cols) { var t = el('table'), tr = el('tr'); cols.forEach(function (h) { tr.appendChild(el('th', null, h)); }); t.appendChild(tr); return t; }
  function pintarLista(j) {
    zonaLista.textContent = '';
    if (!j.data) { zonaLista.appendChild(el('div', 'warn', 'No disponible' + (j.reason_code ? ' (' + j.reason_code + ')' : '') + (j.accion ? ': ' + j.accion : ''))); return; }
    if (!j.data.length) { zonaLista.appendChild(el('div', 'dim', 'Nada que mostrar con estos filtros.')); }
    var t;
    if (kind === 'events') t = cabecera(['Cuándo', 'Tipo', 'Host', 'Tarea', 'Estado', 'Resumen']);
    else if (kind === 'observations') t = cabecera(['Creada', 'Clase', 'Estado', 'Certeza', 'Resumen']);
    else t = cabecera(['Tipo', 'Título', 'Estado', 'Procedencia', 'Certeza']);
    j.data.forEach(function (r) {
      var tr = el('tr', 'fila'); tr.tabIndex = 0;
      var abrir = function () { cargarDetalle(kind, kind === 'events' ? r.event_id : (kind === 'observations' ? r.observation_id : r.node_id)); };
      tr.addEventListener('click', abrir); tr.addEventListener('keydown', function (e) { if (e.key === 'Enter') abrir(); });
      var celdas;
      if (kind === 'events') celdas = [fecha(r.occurred_at), r.event_type, r.host, nd(r.task_id), r.status + (r.summary_hidden ? ' · privado' : ''), r.summary_hidden ? '(contenido privado: solo metadatos)' : nd(r.summary)];
      else if (kind === 'observations') celdas = [fecha(r.created_at), r.kind, r.status, null, nd(r.summary)];
      else celdas = [r.tipo, nd(r.titulo), r.state, r.provenance, null];
      celdas.forEach(function (v) { var td = el('td'); if (v === null) td.appendChild(epi(r.epistemic)); else td.textContent = String(v); tr.appendChild(td); });
      t.appendChild(tr);
    });
    zonaLista.appendChild(t);
    var nav = el('div', 'filtros');
    if (cursores.length) { var a = el('button', null, 'Más recientes'); a.type = 'button'; a.addEventListener('click', function () { cursores.pop(); cursorActual = cursores.length ? cursores[cursores.length - 1] : null; cargarLista(); }); nav.appendChild(a); }
    if (j.coverage && j.coverage.next_cursor !== null && j.coverage.next_cursor !== undefined) { var b = el('button', null, 'Ver más antiguos'); b.type = 'button'; b.addEventListener('click', function () { cursores.push(j.coverage.next_cursor); cursorActual = j.coverage.next_cursor; cargarLista(); }); nav.appendChild(b); }
    nav.appendChild(el('span', 'dim', 'Mostrando ' + (j.coverage ? j.coverage.shown : 0) + ' (total: no calculado para no recorrer toda la base)'));
    zonaLista.appendChild(nav);
  }
  function cargarLista() {
    var q = '/api/v1/memory-items?kind=' + encodeURIComponent(kind) + '&limit=25' + (cursorActual ? '&cursor=' + cursorActual : '');
    Object.keys(filtros).forEach(function (k) { if (filtros[k]) q += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(filtros[k]); });
    getJSON(q).then(pintarLista).catch(function (e) { if (zonaLista) { zonaLista.textContent = ''; zonaLista.appendChild(el('div', 'bad', 'No se pudo leer la lista: ' + e.message)); } });
  }

  function seccion(c, titulo, items) { c.appendChild(el('div', 'k', titulo)); c.appendChild(items.length ? ul(items) : el('div', 'dim', 'ninguno')); }
  function enlace(c, kindDestino, id) { var b = el('button', null, id); b.type = 'button'; b.addEventListener('click', function () { cargarDetalle(kindDestino, id); }); var li = el('li'); li.appendChild(b); return li; }
  function pintarDetalle(j, kind) {
    zonaDetalle.textContent = ''; zonaDetalle.appendChild(el('h2', null, 'Detalle'));
    if (!j.data) { zonaDetalle.appendChild(el('div', 'warn', j.reason_code === 'NO_ENCONTRADO' ? 'No se encontró ese elemento en este proyecto.' : 'No disponible (' + (j.reason_code || 'error') + ').')); return; }
    var d = j.data, it = d.item;
    var cab = el('div', 'big'); cab.textContent = nd(it.titulo || it.summary || it.event_type || it.observation_id) + ' '; cab.appendChild(epi(d.validation.epistemic)); zonaDetalle.appendChild(cab);
    zonaDetalle.appendChild(el('div', null, d.explanation));
    zonaDetalle.appendChild(el('div', 'dim', d.validation.label));
    Object.keys(it).forEach(function (k) { var v = it[k]; if (v === null || v === undefined || typeof v === 'object') return; fila(zonaDetalle, k, v); });
    if (d.origin) Object.keys(d.origin).forEach(function (k) { fila(zonaDetalle, 'origen · ' + k, nd(d.origin[k])); });
    if (d.files) seccion(zonaDetalle, 'Archivos', d.files);
    if (d.evidence) { zonaDetalle.appendChild(el('div', 'k', 'Evidencias')); zonaDetalle.appendChild(d.evidence.length ? ul(d.evidence.map(function (e) { return e.evidence_id + ' · ' + nd(e.status) + (e.kind ? ' · ' + e.kind : '') + (e.bytes !== undefined ? ' · ' + bytes(e.bytes) : '') + (e.last_verified_at ? ' · verificada ' + fecha(e.last_verified_at) : ''); })) : el('div', 'dim', 'sin evidencia vinculada')); }
    if (d.validation.state !== undefined) { fila(zonaDetalle, 'Estado de validación', d.validation.state); fila(zonaDetalle, 'Validado por', nd(d.validation.validated_by)); fila(zonaDetalle, 'Validado el', fecha(d.validation.validated_at)); fila(zonaDetalle, 'Evidencia vigente', d.validation.evidence_current === null ? 'no hay evidencia' : (d.validation.evidence_current ? 'sí' : 'no')); }
    if (d.processing) fila(zonaDetalle, 'Procesamiento', d.processing.state + ' (intentos ' + d.processing.attempts + ')');
    var rel = function (titulo, arr, destino, campo) { zonaDetalle.appendChild(el('div', 'k', titulo)); if (!arr || !arr.length) { zonaDetalle.appendChild(el('div', 'dim', arr ? 'ninguno' : 'no disponible')); return; } var u = el('ul'); arr.forEach(function (x) { u.appendChild(enlace(zonaDetalle, destino, typeof x === 'string' ? x : x[campo])); }); zonaDetalle.appendChild(u); };
    if (kind === 'events') { rel('Observaciones que lo usan', d.observations, 'observations', 'observation_id'); rel('Conocimientos relacionados', d.knowledge, 'knowledge', 'node_id'); }
    if (kind === 'observations') { rel('Actividades de origen', d.events, 'events', 'event_id'); rel('Conocimientos que la usan', d.knowledge, 'knowledge', 'node_id'); }
    if (kind === 'knowledge') { rel('Actividades de origen', d.events, 'events', 'x'); rel('Observaciones de origen', d.observations, 'observations', 'x'); }
    zonaDetalle.scrollIntoView({ block: 'nearest' });
  }
  function cargarDetalle(k, id) {
    getJSON('/api/v1/memory-item?kind=' + encodeURIComponent(k) + '&id=' + encodeURIComponent(id)).then(function (j) { pintarDetalle(j, k); }).catch(function (e) { zonaDetalle.textContent = ''; zonaDetalle.appendChild(el('div', 'bad', 'No se pudo leer el detalle: ' + e.message)); });
  }

  function cargarTodo() {
    Promise.all([getJSON('/api/v1/memory-health').catch(function () { return null; }), getJSON('/api/v1/memory')]).then(function (r) {
      var h = r[0] && r[0].data ? r[0].data : null, m = r[1];
      sub.textContent = 'actualizado ' + fecha(m.generated_at);
      pintarResumen(h, m);
    }).catch(function (e) { raiz.textContent = ''; var c = card('Sin conexión', true); c.appendChild(el('div', 'bad', 'No se pudo leer la memoria: ' + e.message)); });
  }
  document.getElementById('recargar').addEventListener('click', function () { cursores = []; cursorActual = null; hayCambios = false; cargarTodo(); });
  conectarVivo(function (sondeo) {
    if (cursores.length) { hayCambios = true; return; } // el usuario está paginando: no se le mueve la lista
    cargarTodo();
  }, function (d) { return d.memory_stamp; });
  cargarTodo();
`;

// ───────────────────────────── /contexto ─────────────────────────────────────
const CONTEXTO_JS = `
  document.getElementById('pie').textContent = 'Cada cifra declara cómo se midió. Una estimación (bytes ÷ 4) no son tokens facturados; lo no observado no es cero; no hay ranking de IA o rol por tokens.';
  var cursores = [], cursorActual = null, filtros = {};
  window.__sello = undefined;
  function medida(t) { return t ? (t.type === 'mixed' ? 'mezcla de medidas: sin total' : (t.value === null ? 'no disponible' : t.value.toLocaleString() + ' tokens (' + t.label + ')')) : 'no disponible'; }
  function neta(n) { if (!n) return 'no disponible'; if (!n.baseline_comparable) return 'sin línea base comparable'; return bytes(n.net_bytes) + ' (' + n.net_pct + ' %)'; }

  function pintarTarea(c, t) {
    var d = el('div', 'tarea'), hd = el('div', 'head');
    hd.appendChild(el('strong', null, t.task_id)); hd.appendChild(document.createTextNode(' '));
    if (t.effort) { hd.appendChild(el('span', 'pill ' + (t.effort.tier === 'HIGH' ? 'bad' : (t.effort.tier === 'MEDIUM' ? 'warn' : 'ok')), 'nivel ' + t.effort.tier)); hd.appendChild(document.createTextNode(' ')); hd.appendChild(el('span', 'dim', 'riesgo ' + t.effort.risk + ' · dificultad ' + t.effort.difficulty + ' · ' + t.effort.state)); }
    else hd.appendChild(el('span', 'dim', 'sin decisión de esfuerzo guardada (nivel: no disponible)'));
    d.appendChild(hd);
    if (t.effort) {
      d.appendChild(el('div', null, 'Por qué: ' + (t.effort.reasons.length ? t.effort.reasons.map(function (r) { return r.text; }).join('; ') : 'no registrado')));
      d.appendChild(el('div', 'dim', 'Roles requeridos: ' + (t.effort.roles.join(', ') || 'no disponible') + ' · control del razonamiento del host: ' + nd(t.effort.host_effort)));
      if (t.effort.history.length) d.appendChild(el('div', 'dim', 'Cambios: ' + t.effort.history.map(function (h) { return h.text + (h.tier ? ' → ' + h.tier : ''); }).join(' · ')));
    }
    if (t.budget_use) {
      d.appendChild(el('div', null, 'Presupuesto: ' + bytes(t.budget_use.consumed_bytes) + ' de ' + bytes(t.budget_use.budget_bytes) + ' (' + t.budget_use.consumed_pct + ' %)'));
      var b = el('div', 'bar' + (t.budget_use.over_budget ? ' over' : '')), s = el('span'); s.style.width = Math.min(100, t.budget_use.consumed_pct) + '%'; b.appendChild(s); d.appendChild(b);
    } else d.appendChild(el('div', 'dim', 'Presupuesto / consumo: no disponible' + (t.effort ? '' : ' (sin decisión de esfuerzo)')));
    var u = t.usage;
    fila(d, 'Acciones observadas', u.observed_calls + (u.unobserved_calls ? ' (+' + u.unobserved_calls + ' no observadas)' : ''));
    fila(d, 'Entregado / recuperado', bytes(u.delivered_bytes) + ' / ' + bytes(u.recovered_bytes));
    fila(d, 'Referencias recuperadas', u.retrievals);
    fila(d, 'Tokens (tipo de medición)', medida(u.tokens));
    fila(d, 'Reducción neta (payload)', neta(u.net_reduction), u.net_reduction && u.net_reduction.net_bytes < 0 ? 'bad' : '');
    if (u.net_reduction && u.net_reduction.note) d.appendChild(el('div', 'dim', u.net_reduction.note));
    if (u.unobserved_kinds.length) d.appendChild(el('div', 'warn', 'No observado por Agentix: ' + u.unobserved_kinds.join(', ')));
    c.appendChild(d);
  }

  function pintar(j) {
    raiz.textContent = '';
    var d = j.data;
    if (!d || !d.available) { var c0 = card('Contexto y esfuerzo', true); c0.appendChild(el('div', 'bad', 'No disponible' + (d && d.code ? ' (' + d.code + ')' : '') + (d && d.hint ? ': ' + d.hint : '') + '.')); return; }
    window.__sello = d.stamp;
    var cm = card('Cómo leer esta página', true);
    cm.appendChild(el('div', null, 'Esto mide el contexto que AGENTIX entrega (bytes, llamadas, referencias). No controla ni mide el razonamiento interno del host.' + (d.provider && d.provider.note ? ' ' + d.provider.note : '')));
    cm.appendChild(ul(Object.keys(d.measurement.types).map(function (k) { return k + ': ' + d.measurement.types[k]; })));
    var degr = card('Qué está pasando', true);
    if (!d.degradations.length) degr.appendChild(el('div', 'ok', 'Sin degradaciones conocidas.'));
    else { var ud = el('ul'); d.degradations.forEach(function (x) { ud.appendChild(el('li', x.level === 'warn' ? 'warn' : 'dim', x.message)); }); degr.appendChild(ud); }
    var tt = card('Totales del proyecto'), T = d.totals;
    if (!T) tt.appendChild(el('div', 'warn', 'Uso de contexto: no disponible (falta la tabla o el proyecto aún no tiene identidad).'));
    else {
      fila(tt, 'Acciones observadas', T.observed_calls); fila(tt, 'Acciones no observadas', T.unobserved_calls, T.unobserved_calls ? 'warn' : '');
      fila(tt, 'Entregado', bytes(T.delivered_bytes)); fila(tt, 'Recuperado después', bytes(T.recovered_bytes)); fila(tt, 'Referencias recuperadas', T.retrievals);
      fila(tt, 'Tokens (tipo de medición)', medida(T.tokens)); fila(tt, 'Reducción neta (payload)', neta(T.net_reduction), T.net_reduction && T.net_reduction.net_bytes < 0 ? 'bad' : '');
      if (T.net_reduction && T.net_reduction.note) tt.appendChild(el('div', 'dim', T.net_reduction.note));
      fila(tt, 'Coste en dinero', 'no disponible', 'dim');
    }
    var hc = card('Cobertura del host'), H = d.host_coverage;
    if (!H) hc.appendChild(el('div', 'dim', 'no disponible'));
    else { hc.appendChild(el('span', 'pill ' + (H.quality === 'completa' ? 'ok' : 'warn'), H.quality)); fila(hc, 'Filas observadas', H.observed_rows); fila(hc, 'Filas no observadas', H.unobserved_rows, H.unobserved_rows ? 'warn' : ''); fila(hc, '% observado', H.observed_pct === null ? 'no disponible' : H.observed_pct + ' %');
      if (H.not_observed.length) hc.appendChild(ul(H.not_observed.map(function (x) { return 'no observado: ' + x.what + ' (' + x.rows + ')'; }))); hc.appendChild(el('div', 'dim', H.note)); }
    var cp = card('Compresión y recuperación'), C = d.compression;
    if (!C || !C.available) cp.appendChild(el('div', 'dim', 'no disponible' + (C && C.note ? ': ' + C.note : '')));
    else { fila(cp, 'Referencias', C.references); fila(cp, 'Original → entregado', bytes(C.original_bytes) + ' → ' + bytes(C.delivered_bytes)); fila(cp, 'Recuperado', bytes(C.recovered_bytes)); fila(cp, 'Recuperaciones', C.retrievals); fila(cp, 'Incompletas', C.incomplete_references, C.incomplete_references ? 'warn' : ''); cp.appendChild(el('div', 'dim', C.note)); }
    if (d.by_role && d.by_role.length) { var rc = card('Por rol', true); rc.appendChild(el('div', 'dim', d.by_role_note)); var t = el('table'), th = el('tr'); ['Rol', 'Acciones', 'Entregado', 'Recuperado'].forEach(function (h) { th.appendChild(el('th', null, h)); }); t.appendChild(th);
      d.by_role.forEach(function (r) { var tr = el('tr'); [r.role, r.calls, bytes(r.delivered_bytes), bytes(r.recovered_bytes)].forEach(function (v) { tr.appendChild(el('td', null, v)); }); t.appendChild(tr); }); rc.appendChild(t); }
    var tc = card('Tareas', true); tc.appendChild(el('div', 'dim', 'Orden: ' + d.tasks_order + '.'));
    var fl = el('div', 'filtros');
    [['task', 'tarea'], ['role', 'rol']].forEach(function (cm2) { var i = el('input'); i.placeholder = cm2[1]; i.value = filtros[cm2[0]] || ''; i.setAttribute('aria-label', 'filtro ' + cm2[1]); i.addEventListener('change', function () { filtros[cm2[0]] = i.value.trim(); cursores = []; cursorActual = null; cargar(); }); fl.appendChild(i); });
    tc.appendChild(fl);
    if (!d.tasks.length) tc.appendChild(el('div', 'dim', 'Ninguna tarea con uso de contexto registrado. No es cero consumo: es ausencia de medición.'));
    d.tasks.forEach(function (t2) { pintarTarea(tc, t2); });
    var nav = el('div', 'filtros');
    if (cursores.length) { var a = el('button', null, 'Más recientes'); a.type = 'button'; a.addEventListener('click', function () { cursores.pop(); cursorActual = cursores.length ? cursores[cursores.length - 1] : null; cargar(); }); nav.appendChild(a); }
    if (j.coverage && j.coverage.next_cursor !== null && j.coverage.next_cursor !== undefined) { var b = el('button', null, 'Ver más antiguas'); b.type = 'button'; b.addEventListener('click', function () { cursores.push(j.coverage.next_cursor); cursorActual = j.coverage.next_cursor; cargar(); }); nav.appendChild(b); }
    tc.appendChild(nav);
    if (d.tasks_without_usage && d.tasks_without_usage.length) { var su = card('Tareas con decisión de esfuerzo pero sin uso registrado', true); d.tasks_without_usage.forEach(function (t3) { pintarTarea(su, Object.assign({}, t3, { budget_use: null, usage: { observed_calls: 0, unobserved_calls: 0, delivered_bytes: null, recovered_bytes: null, retrievals: null, tokens: null, net_reduction: null, unobserved_kinds: [] } })); }); }
  }
  function cargar() {
    var q = '/api/v1/context?limit=10' + (cursorActual ? '&cursor=' + cursorActual : '');
    Object.keys(filtros).forEach(function (k) { if (filtros[k]) q += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(filtros[k]); });
    getJSON(q).then(function (j) { sub.textContent = 'actualizado ' + fecha(j.generated_at); pintar(j); })
      .catch(function (e) { raiz.textContent = ''; var c = card('Sin conexión', true); c.appendChild(el('div', 'bad', 'No se pudo leer el contexto: ' + e.message)); });
  }
  document.getElementById('recargar').addEventListener('click', function () { cursores = []; cursorActual = null; cargar(); });
  conectarVivo(function () { if (!cursores.length) cargar(); }, function (d) { return d.context_stamp; });
  cargar();
`;

const MEMORIA_HTML = pagina('Memoria', 'memoria', MEMORIA_JS);
const CONTEXTO_HTML = pagina('Contexto y esfuerzo', 'contexto', CONTEXTO_JS);

module.exports = { MEMORIA_HTML, CONTEXTO_HTML };
