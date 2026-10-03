'use strict';
/**
 * Página "Actualización y memoria" del dashboard (3.20.1): /actualizacion
 *
 * Es una página PROPIA, servida por el mismo dashboard y de solo lectura: no
 * añade ni mueve ningún control de los grafos existentes (su diseño, interfaz y
 * comportamiento quedan exactamente como estaban). Lee /api/v1/update.
 *
 * Todo dato llega al DOM con textContent: nada del servidor se interpreta como HTML.
 */
const HTML = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agentix — Actualización y memoria</title>
<style>
  :root { --bg:#0A0E14; --panel:#111823; --line:#1f2a3a; --txt:#d6dde8; --dim:#8A97A6; --ok:#3FE2E8; --warn:#D9A33C; --bad:#ff6b6b; }
  @media (prefers-color-scheme: light) { :root { --bg:#f6f8fb; --panel:#fff; --line:#d9e0ea; --txt:#17202e; --dim:#5c6b7e; --ok:#0a8f96; --warn:#9a6a00; --bad:#c0392b; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--txt); font:14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { padding:20px 24px 8px; display:flex; flex-wrap:wrap; align-items:baseline; gap:12px; }
  h1 { margin:0; font-size:20px; } .sub { color:var(--dim); }
  main { padding:8px 24px 40px; display:grid; gap:14px; grid-template-columns:repeat(auto-fit, minmax(300px, 1fr)); max-width:1200px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
  .card h2 { margin:0 0 8px; font-size:12px; letter-spacing:.06em; text-transform:uppercase; color:var(--dim); font-weight:600; }
  .big { font-size:22px; font-weight:650; } .row { display:flex; justify-content:space-between; gap:12px; padding:3px 0; border-bottom:1px dashed var(--line); } .row:last-child { border:0; }
  .k { color:var(--dim); } .v { text-align:right; overflow-wrap:anywhere; }
  .pill { display:inline-block; padding:1px 9px; border-radius:99px; font-size:12px; font-weight:600; border:1px solid currentColor; }
  .ok { color:var(--ok); } .warn { color:var(--warn); } .bad { color:var(--bad); } .dim { color:var(--dim); }
  .wide { grid-column:1 / -1; } ul { margin:6px 0 0; padding-left:18px; } li { margin:3px 0; overflow-wrap:anywhere; }
  button { background:transparent; color:var(--txt); border:1px solid var(--line); border-radius:7px; padding:5px 12px; cursor:pointer; font:inherit; } button:hover { border-color:var(--ok); }
  button:focus-visible { outline:2px solid var(--ok); outline-offset:2px; }
  .foot { padding:0 24px 24px; color:var(--dim); font-size:12px; }
</style>
</head>
<body>
<header>
  <h1>Actualización y memoria</h1>
  <span class="sub" id="sub">cargando…</span>
  <button id="recargar" type="button">Actualizar vista</button>
</header>
<main id="raiz" aria-live="polite"></main>
<div class="foot">Solo lectura. Muestra estados, recuentos y rutas relativas del proyecto; nunca el contenido de tus archivos ni de la memoria.</div>
<script>
(function () {
  'use strict';
  var raiz = document.getElementById('raiz'), sub = document.getElementById('sub');
  var cursor = 0, acumulados = [];
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt !== undefined && txt !== null) e.textContent = String(txt); return e; }
  function fila(card, k, v, cls) { var r = el('div', 'row'); r.appendChild(el('span', 'k', k)); var s = el('span', 'v' + (cls ? ' ' + cls : ''), v); r.appendChild(s); card.appendChild(r); }
  function card(titulo, wide) { var c = el('section', 'card' + (wide ? ' wide' : '')); c.appendChild(el('h2', null, titulo)); raiz.appendChild(c); return c; }
  function estadoCls(s) { return /^(VERIFIED|NO_CHANGES_VERIFIED|COMPLETE|PASS)$/.test(s) ? 'ok' : (/^(VERIFIED_WITH_WARNINGS|PENDING|SIN_BASE|UNVERIFIED)$/.test(s) ? 'warn' : 'bad'); }
  function fecha(x) { if (!x) return '—'; var d = new Date(x); return isNaN(d) ? String(x) : d.toLocaleString(); }
  function bytes(n) { if (!n && n !== 0) return '—'; return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.ceil(n / 1024) + ' KB'; }

  function pintar(j) {
    var d = j.data; raiz.textContent = '';
    if (!d) { var c0 = card('Sin datos', true); c0.appendChild(el('div', 'bad', 'El servicio no devolvió datos (' + (j.reason_code || j.status) + ').')); return; }
    sub.textContent = 'versión instalada ' + (d.installed_version || '—') + ' · ' + fecha(j.generated_at);

    var s = card('Servicio y memoria');
    s.appendChild(el('div', 'big ' + (d.memory.can_work ? 'ok' : 'bad'), d.memory.can_work ? 'La memoria puede trabajar' : 'La memoria NO puede trabajar ahora'));
    fila(s, 'El servicio responde', d.service.responds ? 'sí' : 'no', d.service.responds ? 'ok' : 'bad');
    fila(s, 'La memoria puede trabajar', d.memory.can_work ? 'sí' : 'no' + (d.memory.reason ? ' (' + d.memory.reason + ')' : ''), d.memory.can_work ? 'ok' : 'bad');
    if (d.memory.update && d.memory.update.in_progress) fila(s, 'Update en curso', (d.memory.update.phase || '') + ' · desde ' + fecha(d.memory.update.since), 'warn');
    s.appendChild(el('div', 'dim', 'Que el tablero esté vivo no significa que la memoria se pueda abrir: son cosas distintas.'));

    var e = card('Esquema de la memoria');
    var es = d.schema;
    e.appendChild(el('span', 'pill ' + estadoCls(es.status), es.status));
    if (es.available) {
      fila(e, 'Nivel detectado / soportado', (es.detected_level === null ? 'sin registro' : es.detected_level) + ' / ' + es.supported_level);
      fila(e, 'Migraciones pendientes', es.pending, es.pending ? 'warn' : '');
      fila(e, 'Migraciones registradas', es.registry_entries);
      fila(e, 'Avisos de tipo/definición', es.warnings);
      fila(e, 'Tablas propias del proyecto', es.foreign_tables);
    } else if (es.note) e.appendChild(el('div', 'dim', es.note));

    var u = card('Última verificación');
    var lv = d.last_verification;
    if (!lv) u.appendChild(el('div', 'warn', 'Sin verificación registrada todavía.'));
    else {
      u.appendChild(el('span', 'pill ' + estadoCls(lv.status), lv.status));
      fila(u, 'Terminó', fecha(lv.finished_at));
      fila(u, 'De → a', ((lv.versions && lv.versions.from) || '?') + ' → ' + ((lv.versions && lv.versions.to) || '?'));
      fila(u, 'Duración', lv.duration_ms === null || lv.duration_ms === undefined ? '—' : (lv.duration_ms / 1000).toFixed(1) + ' s');
      fila(u, 'Advertencias', lv.warnings, lv.warnings ? 'warn' : '');
      if (lv.report) fila(u, 'Informe', lv.report);
      for (var i = 0; i < lv.errors.length; i++) fila(u, lv.errors[i].code || 'error', lv.errors[i].message, 'bad');
      for (var k = 0; k < lv.not_verified.length; k++) fila(u, 'No verificado', lv.not_verified[k], 'warn');
    }

    var m = card('Memoria conservada');
    var mp = d.memory_preserved;
    if (!mp) m.appendChild(el('div', 'dim', 'Aún no hay una comparación registrada.'));
    else {
      fila(m, 'Registros de la base', mp.database ? mp.database.status : '—', mp.database ? estadoCls(mp.database.status) : 'dim');
      if (mp.summary) { fila(m, 'Tablas comparadas por contenido', mp.summary.compared); fila(m, 'Filas comparadas', mp.summary.rows_compared); fila(m, 'Tablas propias del proyecto', (mp.summary.user_tables || []).length); }
      fila(m, 'Archivos propios', mp.own_files ? mp.own_files.status : '—', mp.own_files ? estadoCls(mp.own_files.status) : 'dim');
      if (mp.own_files && mp.own_files.compared !== undefined) fila(m, 'Archivos propios comparados', mp.own_files.compared);
    }

    var b = card('Respaldo');
    if (!d.backup.available) b.appendChild(el('div', 'warn', 'No hay un respaldo verificado en disco.'));
    else {
      b.appendChild(el('span', 'pill ok', 'disponible'));
      fila(b, 'Ruta', d.backup.path); fila(b, 'Tamaño', bytes(d.backup.size)); fila(b, 'Creado', fecha(d.backup.created_at));
      fila(b, 'integrity_check', d.backup.integrity || '—'); fila(b, 'Huella (sha256)', d.backup.sha256 || '—'); fila(b, 'Respaldos conservados', d.backup.kept_count);
    }

    var p = card('Personalizaciones conservadas', true);
    fila(p, 'Archivos conservados por tener cambios propios', d.customizations.preserved.length ? (j.coverage ? j.coverage.total : d.customizations.preserved.length) : 0);
    fila(p, 'Archivos protegidos (protected_files)', d.customizations.protected.length);
    if (d.customizations.preserved.length) {
      var ul = el('ul');
      for (var x = 0; x < d.customizations.preserved.length; x++) { var it = d.customizations.preserved[x]; ul.appendChild(el('li', null, it.file + ' — ' + it.clase + ': ' + it.motivo + ' (versión nueva en ' + it.new_version + ')')); }
      p.appendChild(ul);
    }
    if (j.coverage && j.coverage.next_cursor !== null) {
      var mas = el('button', null, 'Ver más'); mas.type = 'button';
      mas.addEventListener('click', function () { cursor = j.coverage.next_cursor; cargar(); });
      p.appendChild(mas);
    }

    var a = card('Qué hacer ahora', true);
    if (!d.actions_needed.length) a.appendChild(el('div', 'ok', 'Nada pendiente.'));
    else { var ul2 = el('ul'); for (var y = 0; y < d.actions_needed.length; y++) ul2.appendChild(el('li', null, d.actions_needed[y].message)); a.appendChild(ul2); }
  }

  function cargar() {
    fetch('/api/v1/update?limit=20' + (cursor ? '&cursor=' + cursor : ''), { cache: 'no-store' })
      .then(function (r) { return r.json(); }).then(pintar)
      .catch(function (err) { raiz.textContent = ''; var c = card('Sin conexión', true); c.appendChild(el('div', 'bad', 'No se pudo leer /api/v1/update: ' + err.message)); });
  }
  document.getElementById('recargar').addEventListener('click', function () { cursor = 0; cargar(); });
  cargar();
  setInterval(function () { if (!cursor) cargar(); }, 15000);
})();
</script>
</body>
</html>
`;

module.exports = { HTML };
