'use strict';
/**
 * Página «TEAMS» del tablero: /teams  (se muestra dentro del tablero como una pestaña más).
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
<title>Agentix — TEAMS</title>
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
  .foot { padding:0 24px 24px; color:var(--dim); font-size:12px; }
  #mundo { margin:8px 24px 0; max-width:1300px; padding:0; overflow:hidden; }
  #mundo h2 { margin:0; padding:12px 16px 0; }
  #escena { height:min(62vh, 520px); min-height:300px; margin-top:8px; background:#0d1626; }
  .ctl { display:flex; flex-wrap:wrap; align-items:center; gap:6px; padding:8px 12px 10px; }
  .ctl button { padding:3px 10px; font-size:12px; }
  .nota3d { color:var(--dim); font-size:12px; margin-left:6px; }
</style>
</head>
<body>
<header>
  <h1>TEAMS — Director + Constructor</h1>
  <span class="sub" id="sub">cargando…</span>
  <button id="recargar" type="button">Actualizar vista</button>
</header>
<section id="mundo" class="card">
  <h2>Oficina en vivo — arrastra para girar, rueda para acercar, doble clic para reiniciar</h2>
  <div id="escena" aria-label="Escena 3D de la oficina: director, tres sub-agentes y constructor"></div>
  <div class="ctl">
    <span class="dim">Ver:</span>
    <button type="button" onclick="window.mundoSimular && mundoSimular('real')">Datos reales</button>
    <button type="button" onclick="window.mundoSimular && mundoSimular('trabajo')">Simular: trabajando</button>
    <button type="button" onclick="window.mundoSimular && mundoSimular('espera3')">Simular: 3 min sin trabajo</button>
    <button type="button" onclick="window.mundoSimular && mundoSimular('alarma')">Simular: sin vigilante</button>
    <button type="button" onclick="window.mundoSimular && mundoSimular('celebrar')">Simular: tarea aceptada</button>
    <span id="nota3d" class="nota3d"></span>
  </div>
</section>
<main id="raiz" aria-live="polite"></main>
<div class="foot">Solo lectura, se refresca cada 5 s. «Vigilante vivo» = el proceso que avisa al modelo cuando hay algo; «loop de respaldo» = su ronda periódica de ~3 min. Si un rol está en rojo, solo tú puedes despertarlo escribiéndole en su chat.</div>
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

  function pintar(j) {
    var d = j.data; raiz.textContent = '';
    if (window.mundoActualizar) { try { window.mundoActualizar(d, j); } catch (e) { /* la escena es un adorno: nunca rompe los datos */ } }
    if (!d) {
      var c0 = card('Sin canal TEAMS', true);
      c0.appendChild(el('div', 'dim', j.reason_code === 'SIN_CANAL' ? 'Este proyecto no tiene un canal TEAMS. Escribe «teams: activar» en Claude Code.' : 'No hay datos (' + (j.reason_code || j.status) + ').'));
      sub.textContent = 'sin datos'; return;
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
  }

  function cargar() {
    fetch('/api/v1/teams', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(pintar).catch(function () { sub.textContent = 'no pude leer el tablero'; });
  }
  document.getElementById('recargar').addEventListener('click', cargar);
  cargar(); setInterval(cargar, 5000);
})();
</script>
</body>
</html>`;

const HTML = PLANTILLA.replace('/*__MUNDO__*/', () => MUNDO);

module.exports = { HTML };
