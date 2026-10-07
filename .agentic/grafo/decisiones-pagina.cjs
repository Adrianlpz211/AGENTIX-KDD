'use strict';
/**
 * Página «Decisiones» del tablero: /decisiones. Se muestra dentro del dashboard como una pestaña más.
 *
 * Tres columnas con el ciclo de cada pregunta que un modelo le hace al dueño:
 *   Pendientes  → el dueño aún no contestó
 *   Respondidas → el dueño contestó y el modelo todavía no declaró haberla ejecutado
 *   Ejecutadas  → el modelo ya hizo lo decidido
 * Lee /api/v1/decisiones y contesta con POST /api/v1/decision-answer (mismo origen + cabecera de acción: lo valida el servidor).
 * La fuente de verdad es el canal TEAMS; esta página no guarda nada propio. Todo dato llega al DOM con textContent.
 */
const PLANTILLA = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agentix — Decisiones</title>
<style>
  :root { --bg:#0A0E14; --panel:#111823; --line:#1f2a3a; --txt:#d6dde8; --dim:#8A97A6; --ok:#3FE2E8; --warn:#D9A33C; --bad:#ff6b6b; --ac:#8b6bd9; }
  @media (prefers-color-scheme: light) { :root { --bg:#f6f8fb; --panel:#fff; --line:#d9e0ea; --txt:#17202e; --dim:#5c6b7e; --ok:#0a8f96; --warn:#9a6a00; --bad:#c0392b; --ac:#6a4bc0; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--txt); font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
  header { padding:16px 20px 6px; display:flex; flex-wrap:wrap; align-items:center; gap:10px 14px; }
  h1 { margin:0; font-size:19px; } .sub { color:var(--dim); }
  .bar { padding:6px 20px 10px; display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
  input[type=search], textarea { background:var(--panel); color:var(--txt); border:1px solid var(--line); border-radius:7px; padding:6px 10px; font:inherit; }
  input[type=search] { min-width:200px; flex:1 1 200px; max-width:360px; }
  textarea { width:100%; min-height:84px; resize:vertical; }
  button { background:transparent; color:var(--txt); border:1px solid var(--line); border-radius:7px; padding:6px 13px; cursor:pointer; font:inherit; }
  button:hover { border-color:var(--dim); } button.pri { border-color:var(--ac); color:var(--ac); font-weight:600; } button:disabled { opacity:.45; cursor:not-allowed; }
  :focus-visible { outline:2px solid var(--ac); outline-offset:2px; }
  .pill { display:inline-block; padding:1px 9px; border-radius:99px; font-size:12px; font-weight:600; border:1px solid currentColor; }
  .ok { color:var(--ok); } .warn { color:var(--warn); } .bad { color:var(--bad); } .dim { color:var(--dim); }
  main { padding:4px 20px 40px; display:grid; gap:14px; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); align-items:start; }
  .col { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:12px; min-height:120px; }
  .col h2 { margin:0 0 8px; font-size:12px; letter-spacing:.06em; text-transform:uppercase; color:var(--dim); font-weight:600; display:flex; justify-content:space-between; }
  .col .nota { font-size:12px; color:var(--dim); margin:-2px 0 8px; }
  .card { border:1px solid var(--line); border-radius:8px; padding:9px 11px; margin:7px 0; cursor:pointer; background:var(--bg); }
  .card:hover { border-color:var(--ac); } .card b { color:var(--ac); }
  .card small { display:block; color:var(--dim); margin-top:2px; overflow-wrap:anywhere; }
  .vacio { color:var(--dim); font-style:italic; padding:6px 2px; }
  .velo { position:fixed; inset:0; background:rgba(0,0,0,.55); display:none; align-items:flex-start; justify-content:center; padding:24px 12px; overflow-y:auto; z-index:9; }
  .velo.on { display:flex; }
  .modal { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:18px 20px; width:100%; max-width:640px; }
  .modal h3 { margin:0 0 8px; font-size:17px; overflow-wrap:anywhere; } .modal p { margin:6px 0; overflow-wrap:anywhere; }
  .op { display:flex; gap:8px; align-items:flex-start; padding:6px 8px; border:1px solid var(--line); border-radius:8px; margin:5px 0; cursor:pointer; }
  .op.rec { border-color:var(--ok); } .op input { margin-top:4px; }
  .acc { display:flex; flex-wrap:wrap; gap:8px; justify-content:flex-end; margin-top:12px; }
  .toast { position:fixed; bottom:16px; left:50%; transform:translateX(-50%); background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:8px 14px; z-index:12; max-width:92vw; }
  pre { white-space:pre-wrap; overflow-wrap:anywhere; background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:8px 10px; max-height:240px; overflow:auto; }
  label.l { display:block; margin:10px 0 4px; color:var(--dim); font-size:12px; }
</style>
</head>
<body>
<header>
  <h1>🗳️ Decisiones</h1>
  <span class="sub" id="sub">cargando…</span>
  <span id="modelo" class="pill dim" title="Si el Director tiene su vigilante vivo, tu respuesta le llega sola; si no, la verá en su siguiente ronda o mensaje tuyo."></span>
</header>
<div class="bar">
  <input type="search" id="q" placeholder="Buscar por código, pregunta o respuesta…" aria-label="Buscar decisiones">
  <button type="button" id="copiar" title="Texto plano con lo que respondiste y aún no se ejecutó, para pegarlo en el chat si no hay vigilante">Copiar para Claude</button>
  <button type="button" id="recargar">Recargar</button>
</div>
<main id="raiz"></main>
<div class="velo" id="velo"><div class="modal" id="modal" role="dialog" aria-modal="true"></div></div>
<script>
(function () {
  var raiz = document.getElementById('raiz'), sub = document.getElementById('sub'), modelo = document.getElementById('modelo');
  var velo = document.getElementById('velo'), modal = document.getElementById('modal'), buscar = document.getElementById('q');
  var datos = { items: [], resumen: {}, canal: false }, firma = '', abierta = null;
  function el(t, c, x) { var e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; }
  function aviso(txt, mal) { var t = el('div', 'toast ' + (mal ? 'bad' : 'ok'), txt); t.setAttribute('role', 'status'); document.body.appendChild(t); setTimeout(function () { t.remove(); }, 3800); }
  function cerrar() { velo.classList.remove('on'); modal.textContent = ''; abierta = null; }
  velo.addEventListener('click', function (e) { if (e.target === velo) cerrar(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && velo.classList.contains('on')) cerrar(); });
  function coincide(x) {
    var q = buscar.value.trim().toLowerCase(); if (!q) return true;
    return [x.id, x.titulo, x.detalle, x.respuesta, x.recomendacion].join(' ').toLowerCase().indexOf(q) >= 0;
  }
  function tarjeta(x) {
    var c = el('div', 'card'); c.tabIndex = 0; c.setAttribute('role', 'button');
    var t = el('div'); t.appendChild(el('b', null, x.id)); t.appendChild(document.createTextNode(' ' + x.titulo)); c.appendChild(t);
    if (x.estado === 'pendiente' && x.desde) c.appendChild(el('small', null, 'espera desde ' + x.desde + (x.recomendacion ? ' · recomendado: ' + x.recomendacion : '')));
    if (x.estado === 'respondida') c.appendChild(el('small', null, '→ ' + (x.respuesta || '') + (x.respondida_en ? ' · ' + x.respondida_en : '') + (x.via ? ' (' + x.via + ')' : '')));
    if (x.estado === 'ejecutada') c.appendChild(el('small', null, '✔ ' + (x.ejecucion || 'ejecutada') + (x.ejecutada_en ? ' · ' + x.ejecutada_en : '')));
    function ab() { abrir(x); } c.addEventListener('click', ab);
    c.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ab(); } });
    return c;
  }
  function columna(titulo, nota, lista, claseNum) {
    var c = el('section', 'col'); var h = el('h2'); h.appendChild(el('span', null, titulo)); h.appendChild(el('span', claseNum, String(lista.length))); c.appendChild(h);
    if (nota) c.appendChild(el('div', 'nota', nota));
    var vis = lista.filter(coincide);
    if (!vis.length) c.appendChild(el('div', 'vacio', lista.length ? 'Nada coincide con la búsqueda.' : 'Nada por aquí.'));
    vis.forEach(function (x) { c.appendChild(tarjeta(x)); });
    return c;
  }
  function pintar() {
    raiz.textContent = '';
    var p = datos.items.filter(function (x) { return x.estado === 'pendiente'; }), r = datos.items.filter(function (x) { return x.estado === 'respondida'; }), e = datos.items.filter(function (x) { return x.estado === 'ejecutada'; });
    raiz.appendChild(columna('Pendientes', 'Esperan tu respuesta. Frenan solo lo que depende de ellas.', p, p.length ? 'warn' : 'dim'));
    raiz.appendChild(columna('Respondidas', 'Ya contestaste; el modelo debe ejecutarlas y cerrarlas.', r, r.length ? 'warn' : 'dim'));
    raiz.appendChild(columna('Ejecutadas', 'Hecho y declarado por el modelo.', e, 'ok'));
    sub.textContent = datos.canal ? (p.length + ' pendiente(s) · ' + r.length + ' por ejecutar · ' + e.length + ' ejecutada(s)') : 'Sin canal TEAMS: no hay decisiones. Se crean con «teams: activar» y teams.cjs decision --tipo=dueno.';
    document.getElementById('copiar').disabled = !r.length;
  }
  function texto() {
    return datos.items.filter(function (x) { return x.estado === 'respondida'; }).map(function (x) { return x.id + ' — ' + (x.respuesta || ''); }).join('\\n');
  }
  function abrir(x) {
    abierta = x.id; modal.textContent = '';
    modal.appendChild(el('h3', null, x.id + ' — ' + x.titulo));
    if (x.detalle) modal.appendChild(el('p', null, x.detalle));
    if (x.impacto) { var pi = el('p'); pi.appendChild(el('b', null, 'Impacto: ')); pi.appendChild(document.createTextNode(x.impacto)); modal.appendChild(pi); }
    if (x.recomendacion) { var pr = el('p'); pr.appendChild(el('b', 'ok', 'Recomendación: ')); pr.appendChild(document.createTextNode(x.recomendacion + (x.por_que ? ' — ' + x.por_que : ''))); modal.appendChild(pr); }
    if (x.estado !== 'pendiente') {
      var rp = el('p'); rp.appendChild(el('b', null, 'Tu respuesta: ')); rp.appendChild(document.createTextNode(x.respuesta || '')); modal.appendChild(rp);
      if (x.ejecucion) { var pe = el('p'); pe.appendChild(el('b', 'ok', 'Ejecutada: ')); pe.appendChild(document.createTextNode(x.ejecucion)); modal.appendChild(pe); }
      var a0 = el('div', 'acc'), c0 = el('button', null, 'Cerrar'); c0.type = 'button'; c0.addEventListener('click', cerrar); a0.appendChild(c0); modal.appendChild(a0); velo.classList.add('on'); c0.focus(); return;
    }
    var opts = x.opciones.slice(), nombre = 'op', sel = null;
    var grupo = el('div'); modal.appendChild(grupo);
    var ta = el('textarea'); ta.id = 'resp'; ta.maxLength = 2000;
    function fila(valor, texto, rec) {
      var l = el('label', 'op' + (rec ? ' rec' : '')), i = el('input'); i.type = 'radio'; i.name = nombre; i.value = valor;
      i.addEventListener('change', function () { sel = valor; ta.placeholder = valor === '__otra__' ? 'Escribe tu respuesta (obligatorio)…' : 'Comentario opcional a la opción elegida…'; if (valor === '__otra__') ta.focus(); });
      l.appendChild(i); var s = el('span', null, texto + (rec ? '  (recomendada)' : '')); l.appendChild(s); grupo.appendChild(l); return i;
    }
    var recKey = x.recomendacion ? opts.filter(function (o) { return x.recomendacion.toLowerCase().indexOf(o.toLowerCase()) === 0 || o.toLowerCase().indexOf(x.recomendacion.toLowerCase()) === 0; })[0] : null;
    opts.forEach(function (o) { fila(o, o, o === recKey); });
    fila('__otra__', 'Otra: la escribo yo', false);
    var lb = el('label', 'l', 'Tu respuesta propia o un comentario a la opción elegida'); lb.htmlFor = 'resp'; modal.appendChild(lb); modal.appendChild(ta);
    var acc = el('div', 'acc'), bc = el('button', null, 'Cerrar'), br = el('button', null, 'Aceptar recomendación'), bs = el('button', 'pri', 'Responder');
    bc.type = br.type = bs.type = 'button'; bc.addEventListener('click', cerrar); acc.appendChild(bc);
    if (recKey) { br.addEventListener('click', function () { enviar(x.id, recKey, ta.value, br); }); acc.appendChild(br); }
    bs.addEventListener('click', function () {
      if (!sel && !ta.value.trim()) return aviso('Elige una opción o escribe tu respuesta', true);
      if (sel === '__otra__' && !ta.value.trim()) { ta.focus(); return aviso('Elegiste «Otra»: escribe tu respuesta', true); }
      enviar(x.id, sel || '', ta.value, bs);
    });
    modal.addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) bs.click(); });
    acc.appendChild(bs); modal.appendChild(acc); velo.classList.add('on');
  }
  function enviar(id, opcion, texto, boton) {
    boton.disabled = true;
    fetch('/api/v1/decision-answer', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Akdd-Action': 'decision-answer' }, body: JSON.stringify({ id: id, opcion: opcion, texto: texto }) })
      .then(function (r) { return r.json().then(function (j) { return { http: r.status, j: j }; }); })
      .then(function (o) {
        if (o.http === 200) { aviso('Respuesta guardada en el canal. El modelo la verá en su próxima lectura.'); cerrar(); firma = ''; cargar(); }
        else { boton.disabled = false; var e = (o.j.errors && o.j.errors[0]) || {}; aviso(e.message || e.code || 'No se pudo guardar', true); if (o.http === 409) { firma = ''; cargar(); } }
      }).catch(function () { boton.disabled = false; aviso('No pude hablar con el servidor', true); });
  }
  document.getElementById('copiar').addEventListener('click', function () {
    var t = texto(); if (!t) return;
    var cuerpo = 'Respondí estas decisiones en el tablero (ya están en el canal). Ejecútalas y ciérralas con decisiones.cjs aplicada:\\n' + t;
    function mostrar() { modal.textContent = ''; modal.appendChild(el('h3', null, 'Copiar para Claude')); var pre = el('pre', null, cuerpo); modal.appendChild(pre); var a = el('div', 'acc'), c = el('button', null, 'Cerrar'); c.type = 'button'; c.addEventListener('click', cerrar); a.appendChild(c); modal.appendChild(a); velo.classList.add('on'); var r = document.createRange(); r.selectNodeContents(pre); var s = window.getSelection(); s.removeAllRanges(); s.addRange(r); }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(cuerpo).then(function () { aviso('Copiado'); }, mostrar); else mostrar();
  });
  buscar.addEventListener('input', pintar);
  document.getElementById('recargar').addEventListener('click', function () { firma = ''; cargar(); });
  function cargar() {
    fetch('/api/v1/decisiones', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
      var d = j.data || { items: [], resumen: {}, canal: false };
      var f = JSON.stringify(d.items);
      if (f !== firma) { firma = f; datos = d; pintar(); if (abierta && !velo.classList.contains('on')) abierta = null; }
    }).catch(function () { sub.textContent = 'no pude leer las decisiones'; });
    fetch('/api/v1/teams', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
      var v = j.data && j.data.roles && j.data.roles.director && j.data.roles.director.vigilante;
      if (!v) { modelo.textContent = 'Director: sin canal activo'; modelo.className = 'pill dim'; return; }
      modelo.textContent = v.vivo ? 'Director atento: te leerá solo' : 'Director sin vigilante: leerá tu respuesta en su próxima ronda';
      modelo.className = 'pill ' + (v.vivo ? 'ok' : 'warn');
    }).catch(function () { /* el indicador es un extra */ });
  }
  cargar(); setInterval(cargar, 3000);
})();
</script>
</body>
</html>`;

module.exports = { HTML: PLANTILLA };
