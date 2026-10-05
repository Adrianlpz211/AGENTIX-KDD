'use strict';
/**
 * Página «Oficina» del tablero: /oficina (y /teams, el nombre anterior). Se muestra dentro del tablero como una pestaña más.
 *
 * Solo lectura. Lee /api/v1/teams, que sale de `teams.cjs salud`: el canal, los dos roles (vigilante vivo, última ronda,
 * loop de respaldo, avisos sin atender), la cola y el registro en el núcleo de Agentix. El SEMÁFORO está arriba y dice,
 * en palabras, qué pasa y quién tiene que moverse; se refresca solo cada 5 s.
 * Todo dato llega al DOM con textContent: nada del servidor se interpreta como HTML.
 */
const fs = require('fs');
const path = require('path');
const MUNDO = fs.readFileSync(path.join(__dirname, 'teams-mundo.js'), 'utf8');

const PLANTILLA = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agentix — Oficina</title>
<style>
  :root { --bg:#0A0E14; --panel:#111823; --line:#1f2a3a; --txt:#d6dde8; --dim:#8A97A6; --ok:#3FE2E8; --warn:#D9A33C; --bad:#ff6b6b; }
  @media (prefers-color-scheme: light) { :root { --bg:#f6f8fb; --panel:#fff; --line:#d9e0ea; --txt:#17202e; --dim:#5c6b7e; --ok:#0a8f96; --warn:#9a6a00; --bad:#c0392b; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--txt); font:14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { padding:20px 24px 8px; display:flex; flex-wrap:wrap; align-items:baseline; gap:12px; }
  h1 { margin:0; font-size:20px; } .sub { color:var(--dim); }
  main { padding:8px 24px 40px; display:grid; gap:14px; grid-template-columns:repeat(auto-fit, minmax(320px, 1fr)); max-width:1300px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
  .card h2 { margin:0 0 8px; font-size:12px; letter-spacing:.06em; text-transform:uppercase; color:var(--dim); font-weight:600; }
  .big { font-size:22px; font-weight:650; margin-bottom:6px; }
  .row { display:flex; justify-content:space-between; gap:12px; padding:3px 0; border-bottom:1px dashed var(--line); }
  .row:last-child { border:0; } .k { color:var(--dim); } .v { text-align:right; overflow-wrap:anywhere; }
  .pill { display:inline-block; padding:1px 9px; border-radius:99px; font-size:12px; font-weight:600; border:1px solid currentColor; }
  .ok { color:var(--ok); } .warn { color:var(--warn); } .bad { color:var(--bad); } .dim { color:var(--dim); }
  .wide { grid-column:1 / -1; } ul { margin:6px 0 0; padding-left:18px; } li { margin:3px 0; overflow-wrap:anywhere; }
  .sem { border-width:2px; } .sem.VERDE { border-color:var(--ok); } .sem.AMARILLO { border-color:var(--warn); } .sem.ROJO { border-color:var(--bad); }
  .bar { height:8px; background:var(--line); border-radius:99px; overflow:hidden; margin:6px 0 10px; } .bar > i { display:block; height:100%; background:var(--ok); }
  button { background:transparent; color:var(--txt); border:1px solid var(--line); border-radius:7px; padding:5px 12px; cursor:pointer; font:inherit; }
  .dueno { max-height:340px; overflow-y:auto; }
  .dueno .it { border:1px solid var(--line); border-radius:8px; padding:8px 10px; margin:6px 0; cursor:pointer; }
  .dueno .it:hover { border-color:var(--ok); }
  .dueno .it b { color:var(--warn); } .dueno .it small { display:block; color:var(--dim); }
  .velo { position:fixed; inset:0; background:rgba(0,0,0,.6); display:none; align-items:center; justify-content:center; z-index:50; padding:16px; }
  .velo.on { display:flex; }
  .modal { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:18px 20px; width:min(640px,100%); max-height:90vh; overflow-y:auto; }
  .modal h3 { margin:0 0 6px; font-size:16px; } .modal p { margin:6px 0; overflow-wrap:anywhere; }
  .modal textarea { width:100%; min-height:90px; background:var(--bg); color:var(--txt); border:1px solid var(--line); border-radius:8px; padding:8px; font:inherit; }
  .modal .acc { display:flex; gap:8px; justify-content:flex-end; margin-top:10px; flex-wrap:wrap; }
  .modal pre { background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:8px; white-space:pre-wrap; overflow-wrap:anywhere; margin:8px 0; }
  .foot { padding:0 24px 24px; color:var(--dim); font-size:12px; }
  #mundo { margin:8px 24px 0; max-width:1300px; padding:0; overflow:hidden; }
  #mundo h2 { margin:0; padding:12px 16px 0; }
  #escena { height:min(74vh, 660px); min-height:340px; margin-top:8px; background:#0a0f1a; }
  .ctl { display:flex; flex-wrap:wrap; align-items:center; gap:6px; padding:8px 12px 10px; }
  .ctl button { padding:3px 10px; font-size:12px; }
  .ctl button.on { border-color:var(--ok); color:var(--ok); }
  .ctl .sep { width:1px; height:18px; background:var(--line); margin:0 6px; }
  .nota3d { color:var(--dim); font-size:12px; margin-left:6px; }
</style>
</head>
<body>
<header>
  <h1>Oficina — agencia de desarrollo</h1>
  <span class="sub" id="sub">cargando…</span>
  <button id="recargar" type="button">Actualizar vista</button>
</header>
<section id="mundo" class="card">
  <h2>Oficina en vivo · lo que ves es lo que pasa ahora mismo · arrastra para girar, clic derecho para mover, rueda para acercar</h2>
  <div id="escena" aria-label="Escena 3D de la oficina: director, tres sub-agentes, constructor y sus vigilantes"></div>
  <div class="ctl">
    <span class="dim">Vista:</span>
    <button type="button" data-vista="iso" class="on" onclick="window.mundoVista && mundoVista('iso')">Isométrica</button>
    <button type="button" data-vista="libre" onclick="window.mundoVista && mundoVista('libre')">Libre</button>
    <span class="sep"></span><span class="dim">Ir a:</span>
    <button type="button" onclick="window.mundoIr && mundoIr('oficina')">Oficina</button>
    <button type="button" onclick="window.mundoIr && mundoIr('pizarra')">Pizarra</button>
    <button type="button" onclick="window.mundoIr && mundoIr('flujo')">Flujo</button>
    <button type="button" onclick="window.mundoIr && mundoIr('semaforo')">Semáforo</button>
    <button type="button" onclick="window.mundoIr && mundoIr('sala')">Sala</button>
    <button type="button" onclick="window.mundoIr && mundoIr('reloj')">Reloj</button>
    <span class="sep"></span><span class="dim">Seguir a:</span>
    <button type="button" data-seguir="director" onclick="window.mundoSeguir && mundoSeguir('director')">Director</button>
    <button type="button" data-seguir="fe" onclick="window.mundoSeguir && mundoSeguir('fe')">UI/UX</button>
    <button type="button" data-seguir="be" onclick="window.mundoSeguir && mundoSeguir('be')">Backend</button>
    <button type="button" data-seguir="neg" onclick="window.mundoSeguir && mundoSeguir('neg')">Negocio</button>
    <button type="button" data-seguir="cons" onclick="window.mundoSeguir && mundoSeguir('cons')">Constructor</button>
    <button type="button" data-seguir="clawd" onclick="window.mundoSeguir && mundoSeguir('clawd')">Clawd</button>
    <span id="nota3d" class="nota3d"></span>
  </div>
</section>
<main id="raiz" aria-live="polite"></main>
<div class="foot">Solo lectura, en vivo (se refresca cada 2 s). «Vigilante vivo» = el proceso que avisa al modelo cuando hay algo; «loop de respaldo» = su ronda periódica de ~3 min. Si un rol está en rojo, solo tú puedes despertarlo escribiéndole en su chat.</div>
<div class="velo" id="velo"><div class="modal" id="modal" role="dialog" aria-modal="true"></div></div>
<script src="/vendor/three.min.js"></script>
<script>
/*__MUNDO__*/
</script>
<script>
(function () {
  'use strict';
  var raiz = document.getElementById('raiz'), sub = document.getElementById('sub');
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt !== undefined && txt !== null) e.textContent = String(txt); return e; }
  function fila(card, k, v, cls) { var r = el('div', 'row'); r.appendChild(el('span', 'k', k)); r.appendChild(el('span', 'v' + (cls ? ' ' + cls : ''), v)); card.appendChild(r); }
  function card(titulo, wide, cls) { var c = el('section', 'card' + (wide ? ' wide' : '') + (cls ? ' ' + cls : '')); c.appendChild(el('h2', null, titulo)); raiz.appendChild(c); return c; }
  function hora(x) { if (!x) return '—'; var d = new Date(x); return isNaN(d) ? String(x) : d.toLocaleTimeString(); }
  function lista(c, items, vacio, fmt) { if (!items || !items.length) { c.appendChild(el('div', 'dim', vacio)); return; } var ul = el('ul'); for (var i = 0; i < items.length; i++) ul.appendChild(el('li', null, fmt(items[i]))); c.appendChild(ul); }

  function actividadCard(act) {
    var c = card('Quién trabaja con aa: ahora', false);
    var vivos = act && act.actores ? act.actores.filter(function (a) { return a.activa; }) : [];
    if (!vivos.length) { c.appendChild(el('div', 'dim', 'Nadie tiene una tarea aa: abierta. Cada modelo se marca con «linea-tiempo inicio --actor=<quién eres>» al arrancar.')); return; }
    vivos.forEach(function (a) { fila(c, a.actor === 'default' ? 'agente' : a.actor, a.tarea + (a.desde_seg !== null ? ' · hace ' + Math.max(1, Math.round(a.desde_seg / 60)) + ' min' : ''), 'ok'); });
  }
  // Modal de una decisión del dueño. NO escribe nada: prepara el texto para que lo pegues en el chat de Claude Code
  // (así la respuesta sigue entrando por el único canal que el Director lee y el tablero se mantiene de solo lectura).
  var velo = document.getElementById('velo'), modal = document.getElementById('modal');
  function cerrarModal() { velo.classList.remove('on'); modal.textContent = ''; }
  velo.addEventListener('click', function (e) { if (e.target === velo) cerrarModal(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') cerrarModal(); });
  function abrirDecision(x) {
    modal.textContent = '';
    modal.appendChild(el('h3', null, x.id + ' — ' + x.titulo));
    if (x.detalle) modal.appendChild(el('p', null, x.detalle));
    if (x.opciones) { var po = el('p'); po.appendChild(el('b', null, 'Opciones: ')); po.appendChild(document.createTextNode(x.opciones)); modal.appendChild(po); }
    if (x.recomendacion) { var pr = el('p'); pr.appendChild(el('b', 'ok', 'Recomendación del Director: ')); pr.appendChild(document.createTextNode(x.recomendacion)); modal.appendChild(pr); }
    modal.appendChild(el('p', 'dim', 'Escribe tu respuesta y copia el mensaje: pégalo en el chat de Claude Code (Director). Cuando la decisión quede resuelta en el canal, desaparece de este tablero.'));
    var ta = el('textarea'); ta.placeholder = 'Tu decisión, con el porqué si lo tienes…'; modal.appendChild(ta);
    var pre = el('pre', null, ''); modal.appendChild(pre);
    function armar() { pre.textContent = 'teams: resolver ' + x.id + ' ' + (ta.value.trim() || '<tu decisión>'); }
    ta.addEventListener('input', armar); armar();
    var acc = el('div', 'acc'), cp = el('button', null, 'Copiar mensaje'), ce = el('button', null, 'Cerrar');
    cp.type = 'button'; ce.type = 'button';
    cp.addEventListener('click', function () {
      var txt = pre.textContent, ok = function () { cp.textContent = 'Copiado ✔'; };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(ok, function () { pre.focus(); });
      else { var r = document.createRange(); r.selectNodeContents(pre); var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r); try { document.execCommand('copy'); ok(); } catch (e) { /* queda seleccionado: copiar a mano */ } }
    });
    ce.addEventListener('click', cerrarModal); acc.appendChild(ce); acc.appendChild(cp); modal.appendChild(acc);
    velo.classList.add('on'); ta.focus();
  }
  function pintar(j) {
    var d = j.data; raiz.textContent = '';
    if (!d) {
      var c0 = card('Sin canal TEAMS', true);
      c0.appendChild(el('div', 'dim', j.reason_code === 'SIN_CANAL' ? 'Este proyecto no tiene un canal TEAMS activo: la oficina sigue viva con lo que cada modelo hace con aa:. Para trabajar en equipo escribe «teams: activar» en Claude Code.' : j.reason_code === 'TEAMS_NO_INSTALADO' ? 'Este proyecto no trae TEAMS: la oficina muestra lo que cada modelo hace con aa:.' : 'No hay datos (' + (j.reason_code || j.status) + ').'));
      actividadCard(j.actividad); sub.textContent = (j.actividad && j.actividad.actores.some(function (a) { return a.activa; })) ? 'trabajando con aa:' : 'sin actividad'; return;
    }
    sub.textContent = 'canal ' + d.canal + (d.modo ? ' · modo ' + d.modo.toUpperCase() : '') + ' · ' + hora(d.generado) + (j.stale ? ' · dato VIEJO (la base está ocupada)' : '');

    var sem = card('Semáforo', true, 'sem ' + d.semaforo);
    var cls = d.semaforo === 'VERDE' ? 'ok' : (d.semaforo === 'AMARILLO' ? 'warn' : (d.semaforo === 'ROJO' ? 'bad' : 'dim'));
    sem.appendChild(el('div', 'big ' + cls, d.semaforo === 'VERDE' ? 'Todo fluye' : (d.semaforo === 'AMARILLO' ? 'Atención' : (d.semaforo === 'ROJO' ? 'Alguien está parado' : 'Canal ' + d.canal))));
    if (d.alertas.length) lista(sem, d.alertas, '', function (a) { return (a.nivel === 'ROJO' ? '🔴 ' : '🟡 ') + a.msg; });
    else sem.appendChild(el('div', 'dim', d.canal === 'ACTIVO' ? 'Los dos roles con vigilante y loop, sin avisos sin atender.' : 'El semáforo solo se evalúa con el canal ACTIVO.'));
    if (d.avance !== null && d.avance !== undefined) { var b = el('div', 'bar'); var i = el('i'); i.style.width = d.avance + '%'; b.appendChild(i); sem.appendChild(b); sem.appendChild(el('div', 'dim', 'Avance medido: ' + d.avance + ' % (' + d.aceptadas + ' de ' + d.total + ' tareas aceptadas por el Director)')); }

    ['director', 'builder'].forEach(function (rol) {
      var r = d.roles[rol]; var c = card(r.nombre);
      var v = r.vigilante;
      fila(c, 'Vigilante de fondo', v.vivo ? 'VIVO (pid ' + v.pid + ', latido hace ' + v.latido_hace_s + ' s)' : 'NO está vivo', v.vivo ? 'ok' : (d.canal === 'ACTIVO' && d.modo !== 'individual' ? 'bad' : 'dim'));
      fila(c, 'Loop de respaldo (~3 min)', r.loop === 'n/a' ? 'no aplica' : r.loop + (r.ultima_ronda_hace_min !== null ? ' · última ronda hace ' + r.ultima_ronda_hace_min + ' min' : ' · sin rondas'), r.loop === 'ACTIVO' ? 'ok' : (r.loop === 'n/a' ? 'dim' : 'warn'));
      fila(c, 'Aviso sin atender', r.aviso_sin_atender_min === null ? 'ninguno' : 'hace ' + r.aviso_sin_atender_min + ' min', r.aviso_sin_atender_min === null ? 'ok' : (r.aviso_sin_atender_min >= 10 ? 'bad' : 'warn'));
      fila(c, 'Tiene por hacer', r.pendiente + ' cosa(s)', r.pendiente ? 'warn' : 'ok');
      if (r.razones.length) { var ul = el('ul'); r.razones.forEach(function (x) { ul.appendChild(el('li', null, x)); }); c.appendChild(ul); }
    });

    var dc = card('Decisiones del dueño' + (d.cola.decisiones_dueno.length ? ' · ' + d.cola.decisiones_dueno.length : ''), false, 'dueno');
    if (!d.cola.decisiones_dueno.length) dc.appendChild(el('div', 'ok', 'Nada espera por ti: el Director no tiene preguntas abiertas.'));
    else {
      dc.appendChild(el('div', 'dim', 'Preguntas que frenan trabajo. Pulsa una para verla completa y preparar tu respuesta; se quitan solas cuando quedan resueltas.'));
      d.cola.decisiones_dueno.forEach(function (x) {
        var it = el('div', 'it'); it.appendChild(el('b', null, x.id)); it.appendChild(document.createTextNode(' ' + x.titulo));
        if (x.desde) it.appendChild(el('small', null, 'abierta desde ' + x.desde));
        it.addEventListener('click', function () { abrirDecision(x); }); dc.appendChild(it);
      });
    }
    var q = card('Cola y revisión', true);
    fila(q, 'En cola del constructor', d.cola.tareas.length); lista(q, d.cola.tareas, 'Cola vacía.', function (t) { return t.id + ' — ' + t.titulo; });
    fila(q, 'Por aceptar (esperan al Director)', d.cola.por_aceptar.length, d.cola.por_aceptar.length ? 'warn' : ''); if (d.cola.por_aceptar.length) lista(q, d.cola.por_aceptar, '', function (t) { return t.id + ' — ' + t.titulo; });
    fila(q, 'Devueltas / PARCIAL estancada', d.cola.devueltas.length, d.cola.devueltas.length ? 'warn' : ''); if (d.cola.devueltas.length) lista(q, d.cola.devueltas, '', function (t) { return t.id + (t.estancada ? ' (PARCIAL sin avance)' : '') + ' — ' + t.titulo; });
    fila(q, 'Correcciones sin resolver', d.cola.correcciones.length, d.cola.correcciones.length ? 'warn' : ''); if (d.cola.correcciones.length) lista(q, d.cola.correcciones, '', function (k) { return k.id + ' (' + k.sev + ') — ' + k.titulo; });
    fila(q, 'Decisiones tuyas abiertas', d.cola.decisiones_dueno.length, d.cola.decisiones_dueno.length ? 'warn' : ''); if (d.cola.decisiones_dueno.length) lista(q, d.cola.decisiones_dueno, '', function (x) { return x.id + ' — ' + x.titulo; });

    var rg = card('Registro en Agentix');
    fila(rg, 'Ciclos registrados (origen teams)', d.registro.registradas, 'ok');
    fila(rg, 'Pendientes de registro', d.registro.pendientes, d.registro.pendientes ? 'warn' : '');
    fila(rg, 'Abandonados tras reintentos', d.registro.abandonadas, d.registro.abandonadas ? 'bad' : '');
    fila(rg, 'Entradas a la memoria KDD', d.registro.memoria);
    rg.appendChild(el('div', 'dim', 'Cada tarea aceptada por el Director entra sola a ciclos, contratos, AST, diseño y memoria.'));

    var av = card('Últimos avisos de los vigilantes');
    lista(av, d.avisos.slice().reverse(), 'Todavía no hubo avisos.', function (a) { return hora(a.at) + ' · ' + (a.rol === 'director' ? 'Director' : 'Constructor') + ' · ' + (a.atendido ? 'atendido' : 'SIN ATENDER'); });
    actividadCard(j.actividad);
  }

  var firma = '';
  function cargar() {
    fetch('/api/v1/oficina', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
      var o = j.data || { teams: null, teams_instalado: false, actividad: { actores: [] } };
      var d = o.teams || null, t = { status: d ? 'OK' : (o.teams_instalado ? 'EMPTY' : 'UNAVAILABLE'), reason_code: d ? null : (o.teams_instalado ? 'SIN_CANAL' : 'TEAMS_NO_INSTALADO'), data: d, stale: j.stale, actividad: o.actividad };
      if (window.mundoActualizar) { try { window.mundoActualizar(d, t, o.actividad); } catch (e) { /* la escena es un adorno: nunca rompe los datos */ } }
      var f = (d ? JSON.stringify([d.semaforo, d.canal, d.alertas, d.roles, d.cola, d.registro, d.avisos, d.avance, d.quieto_min]) : 'sin') + JSON.stringify(o.actividad.actores.map(function (a) { return [a.actor, a.tarea, a.activa]; }));
      if (f !== firma || !raiz.firstChild) { firma = f; pintar(t); }
    }).catch(function () { sub.textContent = 'no pude leer el tablero'; });
  }
  document.getElementById('recargar').addEventListener('click', function () { firma = ''; cargar(); });
  cargar(); setInterval(cargar, 2000);
})();
</script>
</body>
</html>`;

const HTML = PLANTILLA.replace('/*__MUNDO__*/', () => MUNDO);

module.exports = { HTML };
