'use strict';
/**
 * Página /teams del dashboard (3.20.1, spec TEAMS §11): panel de la campaña Claude Code + Cursor.
 *
 * Es una PÁGINA PROPIA servida por el mismo dashboard: no añade ni mueve ningún control de los grafos KDD /
 * combinado / code structure (su interfaz y diseño quedan exactamente como estaban). Lee /api/v1/teams,
 * /api/v1/teams-vigilancia y /api/v1/teams-auditoria (solo lectura).
 *
 * Muestra construidas · auditadas · verificadas · REGISTRADAS por separado, la cobertura de registro (ledger del
 * plan, no cantidad de nodos), la memoria pendiente, la vigilancia y la auditoría. Todo dato faltante se ve como
 * «desconocido», nunca como 0. Todo dato del servidor llega al DOM con textContent (nada se interpreta como HTML).
 *
 * El código de cliente evita comillas invertidas, ${} y barras invertidas a propósito: vive dentro de una
 * plantilla de texto y así no hay nada que se escape mal. Sin recursos externos.
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
  button { cursor:pointer; } button:hover { border-color:var(--ok); }
  button:focus-visible, select:focus-visible, input:focus-visible { outline:2px solid var(--ok); outline-offset:2px; }
  .filtros { display:flex; gap:8px; flex-wrap:wrap; padding:0 24px 8px; align-items:center; } .filtros label { color:var(--dim); font-size:12px; display:flex; gap:6px; align-items:center; }
  table { width:100%; border-collapse:collapse; } th, td { text-align:left; padding:4px 8px; border-bottom:1px solid var(--line); vertical-align:top; overflow-wrap:anywhere; } th { color:var(--dim); font-weight:600; font-size:12px; }
  .tag { display:inline-block; padding:0 7px; border-radius:6px; font-size:11px; font-weight:600; border:1px solid currentColor; }
  .bar { height:8px; background:var(--line); border-radius:4px; overflow:hidden; margin:4px 0; } .bar > span { display:block; height:100%; background:var(--ok); }
  .aviso { background:rgba(217,163,60,.12); border:1px solid var(--warn); border-radius:8px; padding:6px 10px; margin-bottom:8px; }
  .foot { padding:0 24px 24px; color:var(--dim); font-size:12px; }
`;

const JS = `
  var raiz = document.getElementById('raiz'), sub = document.getElementById('sub'), vivo = document.getElementById('vivo');
  var F = { origen: 'todos', plan: '', sprint: '', phase: '', role: '', correction: '' };
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt !== undefined && txt !== null) e.textContent = String(txt); return e; }
  function nd(v) { return v === null || v === undefined ? 'desconocido' : (typeof v === 'number' ? v.toLocaleString() : String(v)); }
  function fecha(x) { if (!x) return 'desconocido'; var d = new Date(x); return isNaN(d) ? String(x) : d.toLocaleString(); }
  function hace(ms) { if (ms === null || ms === undefined) return 'desconocido'; var s = Math.round(ms / 1000); if (s < 90) return s + ' s'; var m = Math.round(s / 60); if (m < 90) return m + ' min'; var h = Math.round(m / 60); return h < 48 ? h + ' h' : Math.round(h / 24) + ' d'; }
  function ms(v) { return v === null || v === undefined ? 'desconocido' : (v < 1000 ? v + ' ms' : (v / 1000).toFixed(1) + ' s'); }
  function fila(c, k, v, cls) { var r = el('div', 'row'); r.appendChild(el('span', 'k', k)); r.appendChild(el('span', 'v' + (cls ? ' ' + cls : ''), v)); c.appendChild(r); return r; }
  function card(titulo, wide) { var c = el('section', 'card' + (wide ? ' wide' : '')); c.appendChild(el('h2', null, titulo)); raiz.appendChild(c); return c; }
  function pill(s, cls) { return el('span', 'pill ' + (cls || ''), s); }
  function getJSON(url) { return fetch(url, { cache: 'no-store' }).then(function (r) { return r.json(); }); }
  function qs(extra) {
    var p = [];
    for (var k in F) { if (F[k]) p.push(k + '=' + encodeURIComponent(F[k])); }
    if (extra) p.push(extra);
    return p.length ? '?' + p.join('&') : '';
  }
  function conteo(c) { return c && !c.desconocido && c.n !== null ? c.n + ' de ' + nd(c.de) : 'desconocido'; }
  function tabla(cols, filas) {
    var t = el('table'), h = el('tr');
    for (var i = 0; i < cols.length; i++) h.appendChild(el('th', null, cols[i]));
    t.appendChild(h);
    for (var j = 0; j < filas.length; j++) { var r = el('tr'); for (var k = 0; k < filas[j].length; k++) r.appendChild(el('td', null, filas[j][k])); t.appendChild(r); }
    return t;
  }

  function pintarSesion(d) {
    var c = card('Sesión y plan');
    if (!d.inicializado) { c.appendChild(el('div', 'big warn', 'TEAMS no está inicializado en este proyecto')); c.appendChild(el('div', 'dim', 'La persona lo activa con teams: activar. Mirar esta página no activa nada.')); return; }
    var s = d.sesion;
    c.appendChild(el('div', 'big ' + (s && s.enabled ? 'ok' : 'warn'), s ? (s.enabled ? (s.paused ? 'Activa, en pausa' : 'Activa') : 'Desactivada') : 'Sin sesión'));
    if (s) { fila(c, 'Generación de sesión', nd(s.generation)); var rs = []; for (var r in (s.roles || {})) rs.push(r + ' = ' + (s.roles[r].host || '?')); fila(c, 'Roles', rs.join(' · ') || 'desconocido'); }
    var b = d.builder;
    if (b && b.disponible === false) fila(c, 'Constructor', 'desconocido');
    else if (b) { fila(c, 'Constructor', (b.host || '?') + ' · ' + b.state); fila(c, 'Sesión del constructor', b.session_id); if (b.declarado) fila(c, 'Declara', 'loop ' + nd(b.declarado.loop) + ' · watch ' + nd(b.declarado.watch) + ' (declarado, no verificado)'); }
    else fila(c, 'Constructor', 'no conectado');
    if (d.plan) { fila(c, 'Plan', d.plan.id); fila(c, 'Objetivo', d.plan.objective); fila(c, 'Estado del plan', d.plan.state + (d.plan.revision ? ' · rev ' + d.plan.revision : '')); }
    else fila(c, 'Plan', 'ninguno');
  }

  function pintarEtapas(d) {
    var c = card('Etapas — cada una por separado');
    var E = d.etapas || {};
    var filas = [['Construidas', 'construidas', 'entregadas por el constructor'], ['Auditadas', 'auditadas', 'con informe de un revisor'], ['Verificadas', 'verificadas', 'cerradas por el director con gates del sujeto exacto'], ['Registradas', 'registradas', 'su cierre está en la memoria (ciclo, episodio, contratos, AST, layout)']];
    for (var i = 0; i < filas.length; i++) { var x = E[filas[i][1]]; var r = fila(c, filas[i][0], conteo(x), x && x.desconocido ? 'warn' : ''); r.title = filas[i][2]; }
    c.appendChild(el('div', 'dim', 'Una entrega no es un cierre ni un registro: cada número cuenta algo distinto. Desconocido no es 0.'));
  }

  function pintarCobertura(d) {
    var c = card('Cobertura de registro');
    var v = d.cobertura;
    if (!v || v.disponible === false) { c.appendChild(el('div', 'big warn', 'desconocida')); c.appendChild(el('div', 'dim', 'Motivo: ' + nd(v && v.motivo))); return; }
    c.appendChild(el('div', 'big ' + (v.cobertura_pct === null ? 'warn' : 'ok'), v.cobertura_pct === null ? 'sin actividad esperada' : v.cobertura_pct + ' %'));
    if (v.cobertura_pct !== null) { var b = el('div', 'bar'); var s = el('span'); s.style.width = Math.min(100, v.cobertura_pct) + '%'; b.appendChild(s); c.appendChild(b); }
    fila(c, 'Estado', v.estado); fila(c, 'Registradas / esperadas', nd(v.registradas) + ' / ' + nd(v.esperadas));
    var pc = v.por_categoria || {};
    for (var k in pc) fila(c, 'Categoría ' + k, pc[k].desconocido ? 'desconocida (fuera del denominador)' : pc[k].registradas + ' de ' + pc[k].esperadas, pc[k].desconocido ? 'warn' : '');
    if (v.aviso) c.appendChild(el('div', 'aviso', v.aviso));
    c.appendChild(el('div', 'dim', 'Fórmula: ' + v.formula));
  }

  function pintarMemoria(d) {
    var c = card('Memoria de TEAMS (cierres)');
    var m = d.memoria;
    if (!m || m.disponible === false) { c.appendChild(el('div', 'big warn', 'desconocida')); c.appendChild(el('div', 'dim', 'Motivo: ' + nd(m && m.motivo))); return; }
    c.appendChild(el('div', 'big ' + (m.listo_para_cierre ? 'ok' : 'warn'), m.listo_para_cierre ? 'Sin pendientes de registro' : 'Con pendientes: el cierre final NO es completo'));
    fila(c, 'Registrados', nd(m.registrados)); fila(c, 'Pendientes (MEMORY_PENDING)', nd(m.pendientes), m.pendientes ? 'warn' : ''); fila(c, 'Dead-letter', nd(m.dead_letter), m.dead_letter ? 'bad' : ''); fila(c, 'En spool local', nd(m.en_spool), m.en_spool ? 'warn' : '');
    if (m.items && m.items.length) { var u = el('ul'); for (var i = 0; i < m.items.length; i++) { var x = m.items[i]; u.appendChild(el('li', null, x.estado + ' · ' + x.tipo + ' · ' + nd(x.task_id) + (x.error_code ? ' · ' + x.error_code : '') + ' · intentos ' + nd(x.attempts))); } c.appendChild(u); }
  }

  function pintarVigilancia(j) {
    var c = card('Vigilancia', true);
    if (!j || j.status !== 'OK') { c.appendChild(el('div', 'bad', 'No se pudo leer la vigilancia.')); return; }
    var filas = [];
    for (var i = 0; i < j.data.roles.length; i++) {
      var r = j.data.roles[i];
      filas.push([r.rol,
        r.instalada && r.instalada.registrada ? 'registrada (' + nd(r.instalada.lanzador) + ')' : 'no registrada',
        (r.vivo && r.vivo.latido_vigente ? 'vivo · pid ' + r.vivo.pid : (r.vivo && r.vivo.pid ? 'latido obsoleto' : 'sin proceso')),
        'watch ' + nd(r.detecta.watcher) + ' · respaldo ' + nd(r.detecta.respaldo) + ' · canal ' + nd(r.detecta.canal),
        r.host_acepta && r.host_acepta.atenciones !== null ? r.host_acepta.aceptadas + ' de ' + r.host_acepta.atenciones + ' aceptadas · atención p50 ' + ms(r.host_acepta.lat_atencion_ms && r.host_acepta.lat_atencion_ms.p50) : 'desconocido',
        r.ultimo_progreso && r.ultimo_progreso.con_progreso !== null ? r.ultimo_progreso.con_progreso + ' con progreso · ' + r.ultimo_progreso.sin_progreso + ' sin' : 'desconocido',
        'loop: ' + r.loop_host.estado + ' · despertar: ' + r.despertar_modelo.estado]);
    }
    c.appendChild(tabla(['Rol', 'Tarea de Windows', 'Proceso', 'Detecta', 'El host acepta', 'Progreso real', 'Loop y despertar'], filas));
    c.appendChild(el('div', 'dim', j.data.nota));
  }

  function pintarAuditoria(d, j) {
    var c = card('Auditoría', true);
    var a = d.auditoria;
    if (!a || a.disponible === false) { c.appendChild(el('div', 'big warn', 'desconocida')); c.appendChild(el('div', 'dim', 'Motivo: ' + nd(a && a.motivo))); return; }
    var filas = [];
    for (var i = 0; i < a.revisores.length; i++) {
      var r = a.revisores[i];
      filas.push([r.role, r.registrado === null ? 'desconocido' : (r.registrado ? (r.modality || '?') + (r.agent_id ? ' · ' + r.agent_id : '') : 'no registrado'), nd(r.scope), r.ultimo ? r.ultimo.verdict + ' · ' + nd(r.ultimo.task_id) + ' · hash ' + nd(r.ultimo.subject_hash) : 'sin informes', nd(r.pendientes) + (r.tareas_pendientes && r.tareas_pendientes.length ? ' (' + r.tareas_pendientes.join(', ') + ')' : '')]);
    }
    c.appendChild(tabla(['Revisor', 'Identidad y modalidad', 'Alcance', 'Último informe', 'Pendientes (sujeto actual)'], filas));
    if (a.hallazgos) fila(c, 'Hallazgos', a.hallazgos.total + ' en total · ' + a.hallazgos.abiertas + ' abiertos');
    if (j && j.data && j.data.informes && j.data.informes.length) {
      c.appendChild(el('h2', null, 'Últimos informes'));
      var f2 = [];
      for (var k = 0; k < Math.min(10, j.data.informes.length); k++) { var x = j.data.informes[k]; f2.push([x.role, x.verdict, nd(x.task_id), nd(x.finding_id), nd(x.subject_hash), fecha(x.at)]); }
      c.appendChild(tabla(['Revisor', 'Veredicto', 'Tarea', 'Hallazgo', 'Hash', 'Cuándo'], f2));
    }
  }

  function pintarCorrecciones(d) {
    var c = card('Correcciones');
    var k = d.correcciones;
    if (!k || k.disponible === false) { c.appendChild(el('div', 'big warn', 'desconocidas')); c.appendChild(el('div', 'dim', 'Motivo: ' + nd(k && k.motivo))); return; }
    c.appendChild(el('div', 'big ' + (k.abiertas ? 'warn' : 'ok'), k.abiertas + ' abiertas de ' + k.total));
    for (var e in k.por_estado) { if (k.por_estado[e]) fila(c, e, k.por_estado[e]); }
    if (k.reabiertas) fila(c, 'Reabiertas', k.reabiertas, 'warn');
    if (k.items && k.items.length) { var u = el('ul'); for (var i = 0; i < k.items.length; i++) { var x = k.items[i]; u.appendChild(el('li', null, x.id + ' · ' + x.severity + ' · ' + x.state + ' · ' + nd(x.task_id) + ' · ' + nd(x.origin))); } c.appendChild(u); }
  }

  function pintarCiclos(d) {
    var c = card('Ciclos por origen (mismo backend que aa:)');
    var x = d.ciclos;
    if (!x || x.disponible === false) { c.appendChild(el('div', 'big warn', 'desconocidos')); return; }
    c.appendChild(el('div', 'big', nd(x.total) + ' ciclos' + (x.filtro_origen !== 'todos' ? ' (' + x.filtro_origen + ')' : '')));
    fila(c, 'aa', nd(x.por_origen.aa)); fila(c, 'teams', nd(x.por_origen.teams));
    for (var e in x.por_estado) fila(c, e, x.por_estado[e]);
  }

  function pintarTareas(d, cob) {
    var c = card('Tareas del plan', true);
    var filas = [];
    for (var i = 0; i < d.tareas.length; i++) {
      var t = d.tareas[i];
      var si = function (v) { return v === null ? 'desconocido' : (v ? 'sí' : 'no'); };
      filas.push([t.id, nd(t.sprint_id), nd(t.phase), t.state, si(t.construida), si(t.auditada), si(t.verificada), t.registrada]);
    }
    c.appendChild(tabla(['Tarea', 'Sprint', 'Fase', 'Estado', 'Construida', 'Auditada', 'Verificada', 'Registrada'], filas));
    if (cob && cob.truncated) c.appendChild(el('div', 'dim', 'Mostrando ' + cob.shown + ' de ' + cob.total + ' tareas.'));
  }

  function pintar(res) {
    raiz.textContent = '';
    var t = res[0], v = res[1], a = res[2];
    if (!t || t.status !== 'OK' || !t.data) { var c = card('Panel TEAMS', true); c.appendChild(el('div', 'bad', 'No se pudo leer el panel: ' + nd(t && t.reason_code))); sub.textContent = 'no disponible'; return; }
    var d = t.data;
    sub.textContent = 'actualizado ' + new Date().toLocaleTimeString();
    pintarSesion(d);
    if (!d.inicializado) { pintarCiclos(d); return; }
    pintarEtapas(d); pintarCobertura(d); pintarMemoria(d); pintarCorrecciones(d); pintarCiclos(d); pintarVigilancia(v); pintarAuditoria(d, a); pintarTareas(d, t.coverage);
  }

  function cargar() {
    Promise.all([getJSON('/api/v1/teams' + qs()), getJSON('/api/v1/teams-vigilancia' + (F.role === 'builder' || F.role === 'director' ? '?role=' + F.role : '')), getJSON('/api/v1/teams-auditoria' + qs('limit=10'))])
      .then(function (res) { vivo.textContent = 'sondeo cada 15 s'; pintar(res); })
      .catch(function () { vivo.textContent = 'sin conexión'; });
  }

  (function filtros() {
    var barra = document.getElementById('filtros');
    function campo(id, etiqueta, ctl) { var l = el('label', null, etiqueta); l.appendChild(ctl); barra.appendChild(l); return ctl; }
    var so = el('select'); ['todos', 'teams', 'aa'].forEach(function (o) { var op = el('option', null, o); op.value = o; so.appendChild(op); }); campo('f-origen', 'Origen', so);
    var sr = el('select'); [['', 'todos los roles'], ['frontend', 'frontend'], ['backend', 'backend'], ['negocio', 'negocio'], ['builder', 'builder'], ['director', 'director']].forEach(function (o) { var op = el('option', null, o[1]); op.value = o[0]; sr.appendChild(op); }); campo('f-role', 'Rol', sr);
    var ip = el('input'); ip.placeholder = 'id del plan'; campo('f-plan', 'Plan', ip);
    var is = el('input'); is.placeholder = 'sprint'; campo('f-sprint', 'Sprint', is);
    var ih = el('input'); ih.placeholder = 'fase'; campo('f-phase', 'Fase', ih);
    var ic = el('input'); ic.placeholder = 'id del hallazgo'; campo('f-correction', 'Corrección', ic);
    var b = el('button', null, 'Aplicar'); b.type = 'button';
    b.addEventListener('click', function () { F.origen = so.value; F.role = sr.value; F.plan = ip.value.trim(); F.sprint = is.value.trim(); F.phase = ih.value.trim(); F.correction = ic.value.trim(); cargar(); });
    barra.appendChild(b);
  })();
  document.getElementById('recargar').addEventListener('click', cargar);
  document.getElementById('pie').textContent = 'Solo lectura. Construidas, auditadas, verificadas y registradas se cuentan por separado; lo que no se puede leer se muestra como desconocido, nunca como 0. El proceso de vigilancia detecta cambios pero no despierta al modelo del host por sí solo.';
  cargar();
  setInterval(cargar, 15000);
`;

const TEAMS_HTML = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agentix — Campaña TEAMS</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <h1>Campaña TEAMS</h1>
  <span class="sub" id="sub">cargando…</span>
  <span class="sub">· <span id="vivo">conectando…</span></span>
  <button id="recargar" type="button">Actualizar vista</button>
</header>
<nav><a href="/">Tablero de grafos</a><a href="/memoria">Memoria</a><a href="/contexto">Contexto y esfuerzo</a><a href="/actualizacion">Actualización</a><a href="/teams" class="on">Campaña TEAMS</a></nav>
<div class="filtros" id="filtros"></div>
<main id="raiz" aria-live="polite"></main>
<div class="foot" id="pie"></div>
<script>
(function () {
  'use strict';
${JS}
})();
</script>
</body>
</html>
`;

module.exports = { TEAMS_HTML };
