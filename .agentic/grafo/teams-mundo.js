/* Oficina TEAMS en 3D. Solo lectura: se alimenta de /api/v1/teams (window.mundoActualizar(data)).
   Lo que se ve ES lo que pasa: cada persona y cada perro se mueven según el canal real y la bitácora de comandos.
   - Sin TEAMS activo: los cinco juegan videojuegos en la sala de descanso; los perros duermen en su cama.
   - teams: activar → el Director va a su puesto. plan → llegan los tres sub-agentes. constructor → el Constructor (Cursor) va al suyo.
   - Cuando un vigilante arranca, su dueño le da una galleta y el perro se pone a vigilar; si el vigilante muere, el perro se va a dormir.
   - Trabajo real: construir, entregar (sobre que viaja), auditar (sub-agentes), aceptar (confeti), devolver, corregir.
   - A los 3 min sin nada que hacer, quien espera se levanta a descansar. Sin charla inventada: solo textos de lo que hacen.
   Pizarra, flujo del proyecto y semáforo están DENTRO de la oficina (acércate o usa los botones). */
(function () {
  'use strict';
  var cont = document.getElementById('escena');
  if (!cont || typeof THREE === 'undefined') { var c0 = document.getElementById('mundo'); if (c0) c0.style.display = 'none'; return; }
  var ESPERA_S = 180;           // sin nada que hacer 3 min → se levanta a descansar
  var sim = null;               // null = datos reales; si no, { escenario, timers }

  // ═════════ renderer ═════════
  var renderer;
  try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false }); } catch (e) { var c1 = document.getElementById('mundo'); if (c1) { var n1 = c1.querySelector('.nota3d'); if (n1) n1.textContent = 'Tu navegador no pudo iniciar WebGL: la vista 3D no está disponible (los datos de abajo sí).'; cont.style.display = 'none'; } return; }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  if ('outputColorSpace' in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.3;
  cont.appendChild(renderer.domElement);
  var cv = renderer.domElement; cv.style.display = 'block'; cv.style.width = '100%'; cv.style.height = '100%'; cv.style.cursor = 'grab'; cv.style.touchAction = 'none';
  var scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0f1a);

  // ═════════ cámaras: isométrica (ortográfica) y libre (perspectiva) — las dos giran SIEMPRE alrededor del centro ═════════
  var camO = new THREE.OrthographicCamera(-1, 1, 1, -1, -80, 220);
  var camP = new THREE.PerspectiveCamera(36, 1, 0.1, 160);
  var camera = camO, vista = 'iso';
  var ORB = { yaw: 0.785, pitch: 0.61, dist: 23, zoom: 15.2, tx: 0, ty: 1.0, tz: 0 };   // el pivote es el centro de la oficina
  var PRESETS = {
    oficina: { iso: true, yaw: 0.785, pitch: 0.61, zoom: 15.2, dist: 23, tx: 0, ty: 1.0, tz: 0 },
    pizarra: { yaw: 0.0, pitch: 0.05, dist: 6.5, tx: -6, ty: 3.5, tz: -7 },
    flujo: { yaw: 0.0, pitch: 0.05, dist: 7.0, tx: 0.6, ty: 3.5, tz: -7 },
    semaforo: { yaw: 0.0, pitch: 0.05, dist: 6.0, tx: 7.6, ty: 3.5, tz: -7 },
    sala: { yaw: 0.9, pitch: 0.5, dist: 10.5, tx: -6.2, ty: 0.9, tz: 3.6 },
    reloj: { yaw: 1.5708, pitch: 0.05, dist: 6.5, tx: -9.9, ty: 4.3, tz: -5.8 },
  };
  var vuelo = null, seguir = null, seguirDist = 6.5;
  function aplicarCamara() {
    var w = cont.clientWidth || 640, h = cont.clientHeight || 400, asp = w / h, cp = Math.cos(ORB.pitch);
    var dx = Math.sin(ORB.yaw) * cp, dy = Math.sin(ORB.pitch), dz = Math.cos(ORB.yaw) * cp;
    if (vista === 'iso') {
      var s = ORB.zoom; camO.left = -s * asp / 2; camO.right = s * asp / 2; camO.top = s / 2; camO.bottom = -s / 2; camO.updateProjectionMatrix();
      camO.position.set(ORB.tx + dx * 60, ORB.ty + dy * 60, ORB.tz + dz * 60); camO.lookAt(ORB.tx, ORB.ty, ORB.tz); camera = camO;
    } else {
      camP.aspect = asp; camP.updateProjectionMatrix();
      camP.position.set(ORB.tx + dx * ORB.dist, ORB.ty + dy * ORB.dist, ORB.tz + dz * ORB.dist); camP.lookAt(ORB.tx, ORB.ty, ORB.tz); camera = camP;
    }
    // la maqueta tiene dos paredes: si la cámara pasa por detrás de una, esa pared se oculta para poder ver dentro
    var cx = camera.position.x, cz = camera.position.z;
    if (typeof paredFondo !== 'undefined') { var vf = cz > -HD - 0.3, vi = cx > -HW - 0.3; paredFondo.visible = vf; ledFondo.visible = vf; paredIzq.visible = vi; }
  }
  function tamano() { var w = cont.clientWidth || 640, h = cont.clientHeight || 400; renderer.setSize(w, h, false); aplicarCamara(); }
  if (window.ResizeObserver) new ResizeObserver(tamano).observe(cont); else window.addEventListener('resize', tamano);
  function marcarBotones() {
    var bs = document.querySelectorAll('[data-vista]'); for (var i = 0; i < bs.length; i++) bs[i].classList.toggle('on', bs[i].getAttribute('data-vista') === vista);
    var ss = document.querySelectorAll('[data-seguir]'); for (var j = 0; j < ss.length; j++) ss[j].classList.toggle('on', ss[j].getAttribute('data-seguir') === seguir);
  }
  window.mundoVista = function (v) {
    seguir = null; vuelo = null;
    if (v === 'iso') { vista = 'iso'; } else { vista = 'libre'; }
    aplicarCamara(); marcarBotones();
  };
  window.mundoIr = function (nombre) {
    var p = PRESETS[nombre]; if (!p) return; seguir = null;
    vista = p.iso ? 'iso' : 'libre';
    vuelo = { desde: JSON.parse(JSON.stringify(ORB)), hasta: p, t: 0, dur: 1.15 }; marcarBotones();
  };
  // seguir a alguien: el pivote lo acompaña mientras se mueve; arrastrar sigue girando alrededor de esa persona
  window.mundoSeguir = function (k) {
    if (k === seguir) { seguir = null; marcarBotones(); return; }
    if (k !== 'clawd' && !P[k]) return; seguir = k; vuelo = null; vista = 'libre'; seguirDist = 6.5; marcarBotones();
  };
  function posSeguida() { return seguir === 'clawd' ? clawd.position : P[seguir].raiz.position; }
  // entrada: arrastrar = girar alrededor del centro (arriba/abajo = inclinar); clic derecho, mayús o rueda del medio = mover el centro; rueda = zoom
  var arr = null, moved = 0;
  cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  cv.addEventListener('pointerdown', function (e) { arr = { x: e.clientX, y: e.clientY, mover: e.button === 2 || e.shiftKey || e.button === 1 }; moved = 0; vuelo = null; cv.style.cursor = 'grabbing'; try { cv.setPointerCapture(e.pointerId); } catch (x) { /* sin captura */ } });
  cv.addEventListener('pointerup', function (e) { var fue = arr && moved < 5; arr = null; cv.style.cursor = 'grab'; if (fue) pulsar(e); });
  cv.addEventListener('pointermove', function (e) {
    if (!arr) return; var dx = e.clientX - arr.x, dy = e.clientY - arr.y; arr.x = e.clientX; arr.y = e.clientY; moved += Math.abs(dx) + Math.abs(dy);
    if (arr.mover) {
      seguir = null; marcarBotones();
      var u = (vista === 'iso' ? ORB.zoom : ORB.dist * 0.8) / (cont.clientHeight || 400), rx = Math.cos(ORB.yaw), rz = -Math.sin(ORB.yaw), fx = -Math.sin(ORB.yaw), fz = -Math.cos(ORB.yaw);
      ORB.tx += -rx * dx * u + fx * dy * u * 1.4; ORB.tz += -rz * dx * u + fz * dy * u * 1.4;
      ORB.tx = Math.max(-12, Math.min(12, ORB.tx)); ORB.tz = Math.max(-9, Math.min(9, ORB.tz));
    } else { ORB.yaw -= dx * 0.006; ORB.pitch = Math.max(0.05, Math.min(1.5, ORB.pitch + dy * 0.005)); }
    aplicarCamara();
  });
  cv.addEventListener('wheel', function (e) {
    e.preventDefault(); vuelo = null; var f = 1 + e.deltaY * 0.0011;
    if (seguir) seguirDist = Math.max(2.5, Math.min(24, seguirDist * f)); else if (vista === 'iso') ORB.zoom = Math.max(7, Math.min(32, ORB.zoom * f)); else ORB.dist = Math.max(4, Math.min(40, ORB.dist * f));
    aplicarCamara();
  }, { passive: false });
  cv.addEventListener('dblclick', function () { window.mundoIr('oficina'); });

  // ═════════ luces ═════════
  scene.add(new THREE.HemisphereLight(0xc9d8f5, 0x3a3640, 1.0));
  var sol = new THREE.DirectionalLight(0xfff0d6, 1.05); sol.position.set(9, 17, 11);
  sol.castShadow = true; sol.shadow.mapSize.set(2048, 2048); sol.shadow.bias = -0.0006; sol.shadow.normalBias = 0.03;
  sol.shadow.camera.left = -17; sol.shadow.camera.right = 17; sol.shadow.camera.top = 15; sol.shadow.camera.bottom = -13; sol.shadow.camera.near = 1; sol.shadow.camera.far = 50;
  scene.add(sol);
  function luzPuntual(color, inten, dist, x, y, z) { var l = new THREE.PointLight(color, inten, dist, 1.6); l.position.set(x, y, z); scene.add(l); return l; }
  luzPuntual(0xffc58a, 0.7, 9, -4, 3.3, -2); luzPuntual(0xffc58a, 0.7, 9, 3, 3.3, -2); luzPuntual(0xffd7a8, 0.5, 8, 7, 3, 1);
  var luzTV = luzPuntual(0x6aa8ff, 0.6, 8, -8.5, 1.6, 3.6);

  // ═════════ utilidades ═════════
  var mats = {};
  function mat(color, o) {
    o = o || {}; var k = color + '|' + (o.e || 0) + '|' + (o.r === undefined ? '' : o.r) + '|' + (o.m || 0) + '|' + (o.op || 1);
    if (!mats[k]) mats[k] = new THREE.MeshStandardMaterial({ color: color, roughness: o.r === undefined ? 0.8 : o.r, metalness: o.m || 0, emissive: o.e ? color : 0x000000, emissiveIntensity: o.e || 0, transparent: !!o.op && o.op < 1, opacity: o.op || 1 });
    return mats[k];
  }
  function malla(geo, color, x, y, z, padre, o) { var m = new THREE.Mesh(geo, mat(color, o)); m.position.set(x || 0, y || 0, z || 0); if (!(o && o.nosombra)) { m.castShadow = true; m.receiveShadow = true; } (padre || scene).add(m); return m; }
  function caja(w, h, d, color, x, y, z, padre, o) { return malla(new THREE.BoxGeometry(w, h, d), color, x, y, z, padre, o); }
  function cil(rt, rb, h, color, x, y, z, padre, seg, o) { return malla(new THREE.CylinderGeometry(rt, rb, h, seg || 10), color, x, y, z, padre, o); }
  function esf(r, color, x, y, z, padre, o, sx, sy, sz) { var m = malla(new THREE.SphereGeometry(r, 14, 10), color, x, y, z, padre, o); if (sx) m.scale.set(sx, sy, sz); return m; }
  function lienzo(w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function textura(c) { var t = new THREE.CanvasTexture(c); t.minFilter = THREE.LinearFilter; t.generateMipmaps = false; if ('colorSpace' in t) t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t; }
  function pantalla(c, w, h, x, y, z, padre, rotY) {
    var t = textura(c), m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: t, toneMapped: false }));
    m.position.set(x, y, z); if (rotY) m.rotation.y = rotY; (padre || scene).add(m); m._tex = t; m._canvas = c; return m;
  }
  function sprite(c, ancho, orden) {
    var t = textura(c), s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: false, toneMapped: false }));
    s.scale.set(ancho, ancho * c.height / c.width, 1); s.renderOrder = orden || 10; s._tex = t; s._canvas = c; return s;
  }
  function recorte(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  function cortar(t, n) { t = String(t == null ? '' : t); return t.length > n ? t.slice(0, n - 1) + '…' : t; }
  function envolver(g, texto, x, y, ancho, alto, maxLineas) {
    var pal = String(texto).split(/\s+/), linea = '', n = 0;
    for (var i = 0; i < pal.length; i++) {
      var prueba = linea ? linea + ' ' + pal[i] : pal[i];
      if (g.measureText(prueba).width > ancho && linea) { g.fillText(linea, x, y + n * alto); n++; linea = pal[i]; if (n >= maxLineas) return n; } else linea = prueba;
    }
    if (linea && n < maxLineas) { g.fillText(linea, x, y + n * alto); n++; }
    return n;
  }
  function lerp(a, b, k) { return a + (b - a) * k; }
  function haciaAngulo(a, b, k) { var d = ((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI; return a + d * Math.min(1, k); }
  function dist2(a, b) { var dx = a.x - b.x, dz = a.z - b.z; return Math.sqrt(dx * dx + dz * dz); }
  var AHORA = function () { return Date.now(); };

  // ═════════ la oficina (20 × 14) — esquina abierta: pared del fondo (z=-7) e izquierda (x=-10) ═════════
  var HW = 10, HD = 7;
  (function suelo() {
    var c = lienzo(1024, 716), g = c.getContext('2d'); g.fillStyle = '#5a4637'; g.fillRect(0, 0, 1024, 716);
    var s = 7; for (var y = 0; y < 716; y += 51) { for (var x = -((y / 51) % 3) * 110; x < 1024; x += 330) { var v = (s = (s * 9301 + 49297) % 233280) / 233280; g.fillStyle = 'rgb(' + Math.round(86 + v * 22) + ',' + Math.round(68 + v * 18) + ',' + Math.round(52 + v * 14) + ')'; g.fillRect(x + 1, y + 1, 328, 49); } }
    g.strokeStyle = 'rgba(0,0,0,0.28)'; g.lineWidth = 2; for (var yy = 0; yy <= 716; yy += 51) { g.beginPath(); g.moveTo(0, yy); g.lineTo(1024, yy); g.stroke(); }
    var f = new THREE.Mesh(new THREE.BoxGeometry(HW * 2, 0.3, HD * 2), [mat(0x2a2220), mat(0x2a2220), new THREE.MeshStandardMaterial({ map: textura(c), roughness: 0.75 }), mat(0x2a2220), mat(0x2a2220), mat(0x2a2220)]);
    f.position.set(0, -0.15, 0); f.receiveShadow = true; scene.add(f);
    caja(HW * 2 + 0.6, 0.5, 0.3, 0x1b2030, 0, -0.45, HD + 0.15); caja(0.3, 0.5, HD * 2 + 0.3, 0x1b2030, HW + 0.15, -0.45, 0);   // canto de la maqueta
  })();
  var pared = 0x3a4766;
  var paredFondo = caja(HW * 2 + 0.3, 6.4, 0.3, pared, 0, 3.2, -HD - 0.15), paredIzq = caja(0.3, 6.4, HD * 2, pared, -HW - 0.15, 3.2, 0);
  caja(HW * 2, 0.22, 0.12, 0x1a2133, 0, 0.11, -HD + 0.06); caja(0.12, 0.22, HD * 2, 0x1a2133, -HW + 0.06, 0.11, 0);   // zócalos
  var ledFondo = caja(HW * 2 + 0.3, 0.08, 0.32, 0x3fe2e8, 0, 6.3, -HD - 0.15, null, { e: 1.2, nosombra: true });   // tira de luz arriba
  // ventanas con atardecer en la pared izquierda
  (function ventanas() {
    var c = lienzo(256, 320), g = c.getContext('2d'), gr = g.createLinearGradient(0, 0, 0, 320); gr.addColorStop(0, '#1d2b52'); gr.addColorStop(0.55, '#6d5a8a'); gr.addColorStop(1, '#e49a62'); g.fillStyle = gr; g.fillRect(0, 0, 256, 320);
    g.fillStyle = '#0f1424'; var s = 11; for (var x = 0; x < 256; x += 22) { s = (s * 9301 + 49297) % 233280; var h = 40 + (s / 233280) * 90; g.fillRect(x, 320 - h, 20, h); g.fillStyle = '#ffd89a'; for (var wy = 320 - h + 8; wy < 312; wy += 14) { s = (s * 9301 + 49297) % 233280; if (s % 3 === 0) g.fillRect(x + 4, wy, 4, 5); } g.fillStyle = '#0f1424'; }
    [-3.2, -0.3].forEach(function (z) {
      caja(0.14, 3.0, 2.5, 0x161b29, -HW + 0.05, 3.3, z); var p = pantalla(c, 2.3, 2.8, -HW + 0.14, 3.3, z, null, Math.PI / 2); p.castShadow = false;
      caja(0.1, 0.1, 2.5, 0x161b29, -HW + 0.18, 3.3, z); caja(0.1, 3.0, 0.1, 0x161b29, -HW + 0.18, 3.3, z);
    });
  })();
  // reloj de pared con números y la hora REAL (analógico + digital)
  var relojC = lienzo(256, 310), relojP = pantalla(relojC, 1.9, 2.3, -HW + 0.12, 5.0, -5.8, null, Math.PI / 2); var relojSeg = -1;
  relojP.userData.clic = 'reloj';
  function pintarReloj() {
    var d = new Date(), s = d.getSeconds(); if (s === relojSeg) return; relojSeg = s; var g = relojC.getContext('2d'); g.clearRect(0, 0, 256, 310);
    g.fillStyle = '#0d1424'; recorte(g, 4, 4, 248, 302, 22); g.fill(); g.strokeStyle = '#3fe2e8'; g.lineWidth = 4; g.stroke();
    g.fillStyle = '#141d33'; g.beginPath(); g.arc(128, 128, 112, 0, 7); g.fill(); g.strokeStyle = '#3fe2e8'; g.lineWidth = 3; g.stroke();
    g.fillStyle = '#e8eef9'; g.font = 'bold 27px sans-serif'; g.textAlign = 'center';
    for (var i = 1; i <= 12; i++) { var a = i * Math.PI / 6; g.fillText(String(i), 128 + Math.sin(a) * 86, 128 - Math.cos(a) * 86 + 9); }
    g.strokeStyle = '#4b5a7a'; g.lineWidth = 2; for (var m = 0; m < 60; m++) { var b = m * Math.PI / 30, l = m % 5 ? 5 : 0; g.beginPath(); g.moveTo(128 + Math.sin(b) * (104 - l), 128 - Math.cos(b) * (104 - l)); g.lineTo(128 + Math.sin(b) * 110, 128 - Math.cos(b) * 110); g.stroke(); }
    function mano(ang, len, w, col) { g.strokeStyle = col; g.lineWidth = w; g.lineCap = 'round'; g.beginPath(); g.moveTo(128 - Math.sin(ang) * 14, 128 + Math.cos(ang) * 14); g.lineTo(128 + Math.sin(ang) * len, 128 - Math.cos(ang) * len); g.stroke(); }
    mano(((d.getHours() % 12) + d.getMinutes() / 60) * Math.PI / 6, 54, 9, '#e8eef9'); mano((d.getMinutes() + s / 60) * Math.PI / 30, 80, 6, '#e8eef9'); mano(s * Math.PI / 30, 92, 3, '#ff7a59');
    g.fillStyle = '#ff7a59'; g.beginPath(); g.arc(128, 128, 7, 0, 7); g.fill();
    function dos(n) { return (n < 10 ? '0' : '') + n; }
    g.fillStyle = '#3fe2e8'; g.font = 'bold 44px monospace'; g.fillText(dos(d.getHours()) + ':' + dos(d.getMinutes()) + ':' + dos(s), 128, 288);
    relojP._tex.needsUpdate = true;
  }

  // ═════════ pizarra, flujo y semáforo en la pared del fondo ═════════
  var ZP = -HD + 0.05;
  function marco(cx, w, h, y) { caja(w + 0.34, h + 0.34, 0.04, 0x10151f, cx, y, -HD + 0.02); caja(w + 0.34, 0.06, 0.08, 0x3fe2e8, cx, y + h / 2 + 0.17, -HD + 0.04, null, { e: 0.9, nosombra: true }); }
  var cPizarra = lienzo(1200, 640), cFlujo = lienzo(1280, 720), cSem = lienzo(640, 720);
  marco(-6, 6, 3.2, 3.5); marco(0.6, 6.4, 3.6, 3.5); marco(7.1, 3.2, 3.6, 3.5);
  var pPizarra = pantalla(cPizarra, 6, 3.2, -6, 3.5, ZP), pFlujo = pantalla(cFlujo, 6.4, 3.6, 0.6, 3.5, ZP), pSem = pantalla(cSem, 3.2, 3.6, 7.1, 3.5, ZP);
  pPizarra.userData.clic = 'pizarra'; pFlujo.userData.clic = 'flujo'; pSem.userData.clic = 'semaforo';
  // semáforo físico (cuerpo con tres luces) junto al panel
  var semCuerpo = new THREE.Group(); semCuerpo.position.set(9.35, 3.5, -HD + 0.4); scene.add(semCuerpo);
  caja(0.7, 2.3, 0.5, 0x10151f, 0, 0, 0, semCuerpo); semCuerpo.userData.clic = 'semaforo';
  var lamparas = { ROJO: esf(0.24, 0x3a1010, 0, 0.7, 0.26, semCuerpo), AMARILLO: esf(0.24, 0x3a2e0c, 0, 0, 0.26, semCuerpo), VERDE: esf(0.24, 0x0f2e1a, 0, -0.7, 0.26, semCuerpo) };
  var luzSemaforo = luzPuntual(0x3ddc84, 0.9, 6, 9.0, 3.5, -5.6);
  var COL_SEM = { VERDE: 0x3ddc84, AMARILLO: 0xffc233, ROJO: 0xff4d4d }, APAGADA = { VERDE: 0x0f2e1a, AMARILLO: 0x3a2e0c, ROJO: 0x3a1010 };

  // ═════════ muebles ═════════
  var ESC = { director: -7.4, fe: -4.4, be: -1.2, neg: 2.0, cons: 6.6 }, ZESC = -3.5;
  var monitores = {};   // por dueño: { pantallas:[{c,g,t,m}], modo }
  var codigoLineas = (function () { var l = [], s = 5; for (var i = 0; i < 40; i++) { s = (s * 9301 + 49297) % 233280; l.push({ ind: Math.floor((s / 233280) * 4) * 10, len: 30 + ((s / 233280) * 90) % 90, col: ['#7ee0a8', '#9fc4ff', '#e8b977', '#c3a6ff', '#8892a8'][i % 5] }); } return l; })();
  function crearMonitor(dueno, x, y, z, w, h, escritorio) {
    var c = lienzo(192, 120), g = c.getContext('2d'), grp = new THREE.Group(); grp.position.set(x, y, z); escritorio.add(grp);
    caja(w + 0.08, h + 0.08, 0.05, 0x0c0f16, 0, h / 2 + 0.12, 0, grp); caja(0.1, 0.16, 0.06, 0x20242f, 0, 0.08, 0, grp); caja(0.38, 0.03, 0.22, 0x20242f, 0, 0.015, 0.02, grp);
    var p = pantalla(c, w, h, 0, h / 2 + 0.12, 0.03, grp);
    var o = { c: c, g: g, tex: p._tex, modo: 'off', ultimo: 0 }; (monitores[dueno] = monitores[dueno] || []).push(o); return o;
  }
  function pintarMonitor(o, t, dueno) {
    var g = o.g; g.fillStyle = o.modo === 'off' ? '#07090e' : '#0c1220'; g.fillRect(0, 0, 192, 120);
    if (o.modo === 'code') {
      var off = Math.floor(t * 4) % 40; for (var i = 0; i < 12; i++) { var l = codigoLineas[(i + off) % 40]; g.fillStyle = l.col; g.globalAlpha = 0.85; g.fillRect(10 + l.ind, 10 + i * 9, Math.min(l.len, 170 - l.ind), 4); }
      g.globalAlpha = 1; if (Math.floor(t * 2) % 2) { g.fillStyle = '#e8eef9'; g.fillRect(14, 112, 6, 3); }
    } else if (o.modo === 'idle') {
      g.fillStyle = '#16233a'; g.fillRect(0, 0, 192, 120); g.fillStyle = '#3fe2e8'; g.globalAlpha = 0.5; g.fillRect(14, 16, 60, 4); g.globalAlpha = 0.25; g.fillRect(14, 28, 110, 3); g.fillRect(14, 38, 90, 3); g.fillRect(14, 48, 124, 3); g.globalAlpha = 1;
    } else if (o.modo === 'off') { g.fillStyle = '#10131b'; g.fillRect(0, 0, 192, 120); }
    o.tex.needsUpdate = true;
  }
  function silla(x, z, giro) {
    var g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = giro || 0; scene.add(g);
    caja(0.62, 0.09, 0.6, 0x232a3a, 0, 0.45, 0, g); caja(0.58, 0.62, 0.08, 0x232a3a, 0, 0.82, 0.3, g); cil(0.04, 0.04, 0.4, 0x11151d, 0, 0.22, 0, g, 8); cil(0.34, 0.34, 0.04, 0x11151d, 0, 0.04, 0, g, 5);
    return g;
  }
  function escritorio(clave, x, etiqueta, color, nMon) {
    var g = new THREE.Group(); g.position.set(x, 0, ZESC); scene.add(g);
    caja(2.3, 0.07, 1.05, 0x8a6a4a, 0, 0.76, 0, g); caja(0.07, 0.72, 0.95, 0x1d2231, -1.05, 0.38, 0, g); caja(0.07, 0.72, 0.95, 0x1d2231, 1.05, 0.38, 0, g); caja(2.1, 0.5, 0.05, 0x1d2231, 0, 0.55, -0.45, g);
    caja(0.55, 0.025, 0.2, 0x232834, 0, 0.81, 0.18, g); caja(0.1, 0.018, 0.14, 0x232834, 0.5, 0.81, 0.18, g);
    var xs = nMon === 2 ? [-0.62, 0.62] : [0]; xs.forEach(function (mx) { crearMonitor(clave, mx, 0.8, -0.28, nMon === 2 ? 1.05 : 1.15, nMon === 2 ? 0.58 : 0.66, g); });
    cil(0.07, 0.06, 0.12, 0xe8eef9, 1.0, 0.86, 0.1, g, 8);   // taza
    caja(2.3, 0.03, 0.03, parseInt(color.slice(1), 16), 0, 0.745, 0.53, g, { e: 0.5, nosombra: true });
    silla(x, ZESC + 1.05, 0);
    return g;
  }
  var NOMBRE_ESC = { director: ['CLAUDE CODE', '#d97757'], fe: ['UI / UX', '#8b6bd9'], be: ['BACKEND', '#2f9e9a'], neg: ['NEGOCIO', '#d9a33c'], cons: ['CURSOR', '#e8eef9'] };
  Object.keys(ESC).forEach(function (k) { escritorio(k, ESC[k], NOMBRE_ESC[k][0], NOMBRE_ESC[k][1], k === 'cons' || k === 'director' ? 2 : 1); });
  // sala de descanso: alfombra, TV con consola, sofá, pufs, mesa
  caja(7.4, 0.03, 6.2, 0x232f4a, -6.2, 0.015, 3.6, null, { nosombra: true }); caja(7.0, 0.035, 5.8, 0x2c3a5a, -6.2, 0.02, 3.6, null, { nosombra: true });
  var cTV = lienzo(256, 144), tvP = pantalla(cTV, 3.0, 1.7, -HW + 0.25, 1.9, 3.6, null, Math.PI / 2);
  caja(0.2, 1.9, 3.2, 0x0c0f16, -HW + 0.14, 1.9, 3.6); caja(0.5, 0.7, 3.4, 0x1d2231, -HW + 0.3, 0.35, 3.6); caja(0.3, 0.08, 0.5, 0x3fe2e8, -HW + 0.4, 0.74, 3.6, null, { e: 0.6 });
  tvP.position.x = -HW + 0.26;
  var sofa = new THREE.Group(); sofa.position.set(-5.2, 0, 3.5); sofa.rotation.y = -Math.PI / 2; scene.add(sofa);   // mira a la TV (−x)
  caja(3.9, 0.45, 1.05, 0x344a7a, 0, 0.3, 0, sofa); caja(3.9, 0.7, 0.26, 0x2b3d66, 0, 0.7, -0.46, sofa); caja(0.26, 0.55, 1.05, 0x2b3d66, -1.82, 0.52, 0, sofa); caja(0.26, 0.55, 1.05, 0x2b3d66, 1.82, 0.52, 0, sofa);
  [[-8.2, 1.6], [-8.2, 5.7]].forEach(function (p) { esf(0.6, 0xc0603f, p[0], 0.36, p[1], null, null, 1, 0.62, 1); });
  cil(0.7, 0.7, 0.05, 0x1d2231, -6.7, 0.42, 3.6, null, 14); cil(0.08, 0.08, 0.4, 0x1d2231, -6.7, 0.2, 3.6, null, 8);
  caja(0.22, 0.05, 0.3, 0x0c0f16, -6.8, 0.48, 3.4); caja(0.22, 0.05, 0.3, 0x0c0f16, -6.55, 0.48, 3.8);   // mandos sobre la mesa
  // rincón de café y plantas
  caja(3.4, 0.95, 0.75, 0x232a3a, 6.8, 0.48, 6.2); caja(0.5, 0.45, 0.4, 0x11151d, 5.9, 1.2, 6.2); caja(0.18, 0.5, 0.18, 0xc7ccd6, 7.6, 1.2, 6.2);
  function planta(x, z, s) { cil(0.26 * s, 0.2 * s, 0.4 * s, 0xa6633f, x, 0.2 * s, z, null, 8); for (var i = 0; i < 5; i++) { var a = i * 1.26; esf(0.2 * s, 0x2f8f56, x + Math.sin(a) * 0.13 * s, 0.6 * s + (i % 2) * 0.12 * s, z + Math.cos(a) * 0.13 * s, null, null, 1, 1.5, 1); } }
  planta(-9.2, -6.2, 1.5); planta(9.3, 6.4, 1.3); planta(-9.2, 6.4, 1.2); planta(9.3, -6.2, 1.2); planta(-3.1, 6.4, 1);
  caja(0.5, 2.2, 2.0, 0x1d2231, -HW + 0.3, 1.1, -6.0);   // librería pegada a la pared izquierda, al fondo
  [0.55, 1.2, 1.85].forEach(function (y, i) { for (var j = 0; j < 5; j++) caja(0.34, 0.45, 0.28, [0xd97757, 0x3fe2e8, 0x8b6bd9, 0xd9a33c, 0x2f9e9a, 0x9fb4d8][(i + j) % 6], -HW + 0.52, y, -6.75 + j * 0.3); });
  // camas de los perros
  var CAMA = { director: { x: -9.15, z: -1.4 }, cons: { x: 9.2, z: -1.4 } };
  Object.keys(CAMA).forEach(function (k) { cil(0.55, 0.6, 0.16, 0x3b4a6a, CAMA[k].x, 0.08, CAMA[k].z, null, 14); cil(0.4, 0.4, 0.08, 0xd9c9a8, CAMA[k].x, 0.17, CAMA[k].z, null, 14); });

  // ═════════ navegación: grafo de puntos libres (pasillo, huecos entre escritorios) ═════════
  var G = {};
  function nodo(n, x, z) { G[n] = { x: x, z: z, v: [] }; }
  function enlace(a, b) { G[a].v.push(b); G[b].v.push(a); }
  (function () {
    var xs = [-9, -7.5, -6, -4.5, -3, -1.5, 0, 1.5, 3, 4.5, 6, 7.5, 9]; xs.forEach(function (x, i) { nodo('a' + i, x, 0.5); if (i) enlace('a' + i, 'a' + (i - 1)); });
    function aislle(x) { var b = 0, m = 99; xs.forEach(function (v, i) { if (Math.abs(v - x) < m) { m = Math.abs(v - x); b = i; } }); return 'a' + b; }
    Object.keys(ESC).forEach(function (k) { nodo('f_' + k, ESC[k], -1.25); enlace('f_' + k, aislle(ESC[k])); });
    [-5.9, -2.8, 0.4, 4.3].forEach(function (x, i) { nodo('gf' + i, x, -1.25); enlace('gf' + i, aislle(x)); nodo('gb' + i, x, -5.4); enlace('gb' + i, 'gf' + i); });
  })();
  function nodoCercano(p) {
    var mejor = null, m = 1e9; Object.keys(G).forEach(function (n) { var nd = G[n]; if (p.z < -4.3 && n.indexOf('gb') !== 0) return; if (p.z >= -4.3 && p.z < -1.4 && n.indexOf('f') !== 0 && n.indexOf('gf') !== 0) return; if (p.z >= -1.4 && (n.indexOf('gb') === 0)) return; var d = dist2(p, nd); if (d < m) { m = d; mejor = n; } });
    return mejor || 'a6';
  }
  function ruta(desde, hasta) {
    if (desde === hasta) return [desde]; var d = {}, prev = {}, cola = [desde]; d[desde] = 0;
    while (cola.length) { cola.sort(function (a, b) { return d[a] - d[b]; }); var u = cola.shift(); if (u === hasta) break; G[u].v.forEach(function (v) { var nd = d[u] + dist2(G[u], G[v]); if (d[v] === undefined || nd < d[v]) { d[v] = nd; prev[v] = u; if (cola.indexOf(v) < 0) cola.push(v); } }); }
    var out = [], c = hasta; while (c) { out.unshift(c); c = prev[c]; } return out[0] === desde ? out : [desde, hasta];
  }
  // sitios donde una persona puede estar
  var SITIOS = {};
  Object.keys(ESC).forEach(function (k) { SITIOS['esc_' + k] = { id: 'esc_' + k, nodo: 'f_' + k, aprox: [], pos: { x: ESC[k], z: -2.5 }, giro: Math.PI, pose: 'sit', asiento: 0.53, zona: 'trabajo' }; });
  SITIOS.sofa1 = { id: 'sofa1', nodo: 'a4', aprox: [{ x: -3.4, z: 3.5 }], pos: { x: -5.3, z: 3.5 }, giro: -Math.PI / 2, pose: 'sit', asiento: 0.56, zona: 'sala', juega: true };
  SITIOS.sofa0 = { id: 'sofa0', nodo: 'a4', aprox: [{ x: -3.4, z: 2.2 }], pos: { x: -5.3, z: 2.35 }, giro: -Math.PI / 2, pose: 'sit', asiento: 0.56, zona: 'sala', juega: true };
  SITIOS.sofa2 = { id: 'sofa2', nodo: 'a4', aprox: [{ x: -3.4, z: 4.8 }], pos: { x: -5.3, z: 4.65 }, giro: -Math.PI / 2, pose: 'sit', asiento: 0.56, zona: 'sala' };
  SITIOS.bean0 = { id: 'bean0', nodo: 'a2', aprox: [{ x: -8.2, z: 0.7 }], pos: { x: -8.2, z: 1.55 }, giro: -Math.PI / 2, pose: 'sit', asiento: 0.42, zona: 'sala' };
  SITIOS.bean1 = { id: 'bean1', nodo: 'a4', aprox: [{ x: -3.4, z: 6.4 }, { x: -8.2, z: 6.4 }], pos: { x: -8.2, z: 5.65 }, giro: -Math.PI / 2, pose: 'sit', asiento: 0.42, zona: 'sala' };
  SITIOS.pizarra = { id: 'pizarra', nodo: 'gb0', aprox: [], pos: { x: -5.9, z: -6.1 }, giro: Math.PI, pose: 'escribir', zona: 'pared' };
  SITIOS.flujo = { id: 'flujo', nodo: 'gb2', aprox: [], pos: { x: 0.4, z: -6.1 }, giro: Math.PI, pose: 'escribir', zona: 'pared' };
  var ASIENTOS_SALA = ['sofa1', 'sofa0', 'bean0', 'sofa2', 'bean1'], ocupados = {};

  // ═════════ personajes ═════════
  var DEF = {
    director: { nombre: 'Director', sub: 'Claude Code', camisa: 0xd97757, pantalon: 0x232938, piel: 0xe2b18c, pelo: 0x2a1c14, estilo: 'corto' },
    fe: { nombre: 'UI / UX', sub: 'sub-agente', camisa: 0x8b6bd9, pantalon: 0x1f2433, piel: 0xc58c63, pelo: 0x17120e, estilo: 'largo' },
    be: { nombre: 'Backend', sub: 'sub-agente', camisa: 0x2f9e9a, pantalon: 0x232938, piel: 0xf0c9a6, pelo: 0x5a3a22, estilo: 'corto' },
    neg: { nombre: 'Negocio', sub: 'sub-agente', camisa: 0xd9a33c, pantalon: 0x1f2433, piel: 0x8d5a3b, pelo: 0x0d0d10, estilo: 'rizado' },
    cons: { nombre: 'Constructor', sub: 'Cursor', camisa: 0x1c1f27, pantalon: 0x2d3347, piel: 0xe8bf9a, pelo: 0xa8642a, estilo: 'corto' },
  };
  var P = {}, ORDEN = ['director', 'fe', 'be', 'neg', 'cons'];
  function eje(padre, x, y, z) { var g = new THREE.Group(); g.position.set(x, y, z); padre.add(g); return g; }
  function crearPersona(k) {
    var d = DEF[k], raiz = new THREE.Group(); scene.add(raiz);
    var cuerpo = eje(raiz, 0, 0, 0), pelvis = eje(cuerpo, 0, 0.94, 0);
    caja(0.36, 0.2, 0.22, d.pantalon, 0, 0, 0, pelvis);
    var torso = eje(pelvis, 0, 0.1, 0);
    caja(0.4, 0.5, 0.24, d.camisa, 0, 0.26, 0, torso); caja(0.44, 0.12, 0.27, d.camisa, 0, 0.5, 0, torso, { r: 0.7 });
    if (k === 'cons') caja(0.14, 0.14, 0.02, 0xe8eef9, 0, 0.3, 0.125, torso);
    if (k === 'director') caja(0.12, 0.1, 0.02, 0xfff1e4, 0, 0.34, 0.125, torso);
    cil(0.06, 0.07, 0.1, d.piel, 0, 0.58, 0, torso, 8);
    var cabeza = eje(torso, 0, 0.72, 0);
    esf(0.14, d.piel, 0, 0, 0, cabeza, null, 1, 1.1, 1.02);
    var pelo = malla(new THREE.SphereGeometry(0.157, 14, 9, 0, Math.PI * 2, 0, Math.PI * 0.56), d.pelo, 0, 0.02, -0.012, cabeza); pelo.rotation.x = -0.5; pelo.scale.set(1, 1.08, 1.04);
    if (d.estilo === 'largo') caja(0.3, 0.3, 0.1, d.pelo, 0, -0.08, -0.12, cabeza);
    if (d.estilo === 'rizado') { esf(0.1, d.pelo, 0.1, 0.1, 0, cabeza); esf(0.1, d.pelo, -0.1, 0.1, 0, cabeza); esf(0.1, d.pelo, 0, 0.14, -0.05, cabeza); }
    caja(0.035, 0.04, 0.02, 0x10131a, -0.05, 0.0, 0.146, cabeza, { nosombra: true }); caja(0.035, 0.04, 0.02, 0x10131a, 0.05, 0.0, 0.146, cabeza, { nosombra: true });
    function brazo(lado) {
      var h = eje(torso, lado * 0.26, 0.46, 0), up = cil(0.05, 0.045, 0.3, d.camisa, 0, -0.15, 0, h, 8), cod = eje(h, 0, -0.3, 0);
      cil(0.045, 0.04, 0.28, d.piel, 0, -0.14, 0, cod, 8); esf(0.05, d.piel, 0, -0.29, 0, cod); return { h: h, cod: cod };
    }
    function pierna(lado) {
      var h = eje(pelvis, lado * 0.1, -0.08, 0); cil(0.075, 0.065, 0.41, d.pantalon, 0, -0.205, 0, h, 8);
      var rod = eje(h, 0, -0.41, 0); cil(0.065, 0.055, 0.41, d.pantalon, 0, -0.205, 0, rod, 8); caja(0.11, 0.08, 0.25, 0x14171f, 0, -0.41, 0.06, rod);
      return { h: h, rod: rod };
    }
    var bI = brazo(-1), bD = brazo(1), lI = pierna(-1), lD = pierna(1);
    var tag = sprite(lienzo(360, 84), 2.55, 12); tag.position.set(0, 2.45 + ORDEN.indexOf(k) % 3 * 0.42, 0); raiz.add(tag);
    var bub = sprite(lienzo(380, 96), 2.7, 13); bub.position.set(0, 3.9, 0); bub.visible = false; raiz.add(bub);
    var p = {
      k: k, def: d, raiz: raiz, cuerpo: cuerpo, pelvis: pelvis, torso: torso, cabeza: cabeza, bI: bI, bD: bD, lI: lI, lD: lD, tag: tag, bub: bub, bubHasta: 0,
      sitio: null, destino: null, ruta: [], fase: 'parado', sentado: 0, fase_p: 0, camina: 0, modo: 'normal', arm: { iu: 0, ic: 0, du: 0, dc: 0 },
      base: null, intr: null, etqTxt: '', etqCol: '', trabajando: false, asientoSala: null, lleva: 0,
    };
    raiz.userData.persona = k; return p;
  }
  ORDEN.forEach(function (k) { P[k] = crearPersona(k); });
  function pintarEtiqueta(p, linea1, linea2, col) {
    var key = linea1 + '|' + linea2 + '|' + col; if (p.etqTxt === key) return; p.etqTxt = key;
    var c = p.tag._canvas, g = c.getContext('2d'); g.clearRect(0, 0, c.width, c.height);
    g.fillStyle = 'rgba(8,12,22,0.82)'; recorte(g, 3, 3, c.width - 6, c.height - 6, 16); g.fill(); g.strokeStyle = col; g.lineWidth = 3; g.stroke();
    g.fillStyle = col; g.beginPath(); g.arc(24, 28, 8, 0, 7); g.fill();
    g.fillStyle = '#f2f6ff'; g.font = 'bold 26px sans-serif'; g.textAlign = 'left'; g.fillText(cortar(linea1, 26), 42, 36);
    g.fillStyle = '#aebbd3'; g.font = '22px sans-serif'; g.fillText(cortar(linea2, 32), 18, 68);
    p.tag._tex.needsUpdate = true;
  }
  function decir(ent, txt, ms) {
    var s = ent.bub, c = s._canvas, g = c.getContext('2d'); g.clearRect(0, 0, c.width, c.height);
    g.fillStyle = 'rgba(244,248,255,0.97)'; g.strokeStyle = '#17233d'; g.lineWidth = 4; recorte(g, 6, 6, c.width - 12, 64, 16); g.fill(); g.stroke();
    g.beginPath(); g.moveTo(c.width / 2 - 14, 68); g.lineTo(c.width / 2, 90); g.lineTo(c.width / 2 + 14, 68); g.fill();
    g.fillStyle = '#10182c'; g.font = 'bold 29px sans-serif'; g.textAlign = 'center'; g.fillText(cortar(txt, 24), c.width / 2, 49);
    s._tex.needsUpdate = true; s.visible = true; ent.bubHasta = AHORA() + (ms || 4500);
  }

  // ═════════ animación de una persona ═════════
  function objetivoBrazos(p, t) {
    var m = p.modo, ph = p.fase_p, sw = p.camina * 0.55, a = { iu: -Math.sin(ph) * sw, ic: -0.1 - p.camina * 0.2, du: Math.sin(ph) * sw, dc: -0.1 - p.camina * 0.2 };
    if (m === 'type') { a = { iu: -0.7 + Math.sin(t * 13) * 0.03, ic: -1.15 + Math.sin(t * 17) * 0.1, du: -0.7 + Math.sin(t * 15 + 1) * 0.03, dc: -1.15 + Math.sin(t * 19 + 2) * 0.1 }; }
    else if (m === 'read') { a = { iu: -0.45, ic: -0.9, du: -0.5, dc: -1.0 + Math.sin(t * 2) * 0.03 }; }
    else if (m === 'game') { a = { iu: -0.75, ic: -1.25 + Math.sin(t * 9) * 0.05, du: -0.75, dc: -1.25 + Math.sin(t * 11 + 1) * 0.05 }; }
    else if (m === 'lap') { a = { iu: -0.25, ic: -1.2, du: -0.25, dc: -1.2 }; }
    else if (m === 'cheer') { a = { iu: -2.9 + Math.sin(t * 8) * 0.3, ic: -0.2, du: -2.9 + Math.sin(t * 8 + 1) * 0.3, dc: -0.2 }; }
    else if (m === 'escribir') { a.du = -2.45 + Math.sin(t * 3.2) * 0.18; a.dc = -0.45 + Math.sin(t * 6) * 0.1; }
    else if (m === 'dar') { a.du = -1.15; a.dc = -0.4; }
    else if (m === 'wave') { a.du = -2.6 + Math.sin(t * 10) * 0.25; a.dc = -0.3 + Math.sin(t * 10) * 0.35; }
    return a;
  }
  function animar(p, dt, t) {
    p.modo = p.fase === 'parado' ? p.modoDeseado || 'lap' : 'normal';
    if (p.saludo > 0) { p.saludo -= dt; if (p.fase === 'parado' && p.modo !== 'escribir' && p.modo !== 'dar') p.modo = 'wave'; }
    var a = objetivoBrazos(p, t), k = Math.min(1, dt * 10);
    p.arm.iu += (a.iu - p.arm.iu) * k; p.arm.ic += (a.ic - p.arm.ic) * k; p.arm.du += (a.du - p.arm.du) * k; p.arm.dc += (a.dc - p.arm.dc) * k;
    p.bI.h.rotation.x = p.arm.iu; p.bI.cod.rotation.x = p.arm.ic; p.bD.h.rotation.x = p.arm.du; p.bD.cod.rotation.x = p.arm.dc;
    var s = p.sentado, ph = p.fase_p, w = p.camina * (1 - s), seat = p.sitio && p.sitio.asiento ? p.sitio.asiento : 0.53;
    p.pelvis.position.y = lerp(0.94 + Math.abs(Math.sin(ph)) * 0.035 * w, seat, s);
    p.lI.h.rotation.x = lerp(Math.sin(ph) * 0.6 * w, -1.5, s); p.lD.h.rotation.x = lerp(-Math.sin(ph) * 0.6 * w, -1.5, s);
    p.lI.rod.rotation.x = lerp(Math.max(0, Math.sin(ph + 1.3)) * 0.9 * w, 1.5, s); p.lD.rod.rotation.x = lerp(Math.max(0, -Math.sin(ph + 1.3)) * 0.9 * w, 1.5, s);
    var inclina = (p.modo === 'type' ? 0.14 : p.modo === 'game' ? 0.1 : p.modo === 'read' ? 0.08 : 0) * s; p.torso.rotation.x += (inclina - p.torso.rotation.x) * k;
    p.cabeza.rotation.x += ((p.modo === 'type' || p.modo === 'read' ? 0.12 : 0) - p.cabeza.rotation.x) * k;
    p.raiz.position.y = 0;
    if (p.bub.visible && AHORA() > p.bubHasta) p.bub.visible = false;
  }
  function posSitio(s) { return { x: s.pos.x, z: s.pos.z }; }
  function replanificar(p) {
    var dest = p.destino, pos = { x: p.raiz.position.x, z: p.raiz.position.z }, pts = [];
    var desde;
    if (p.sitio && dist2(pos, p.sitio.pos) < 0.35) { for (var i = p.sitio.aprox.length - 1; i >= 0; i--) pts.push(p.sitio.aprox[i]); desde = p.sitio.nodo; }
    else desde = nodoCercano(pos);
    var cam = ruta(desde, dest.nodo); cam.forEach(function (n) { pts.push({ x: G[n].x, z: G[n].z }); });
    dest.aprox.forEach(function (q) { pts.push(q); }); pts.push(dest.pos);
    p.ruta = pts;
  }
  function angDif(a, b) { return ((a - b + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI; }
  function moverPersona(p, dt) {
    var dest = p.destino;
    if (dest && p.destinoVigente !== dest) {
      if (p.sentado > 0.02) { p.sentado = Math.max(0, p.sentado - dt * 3.2); p.camina = 0; return; }   // primero se levanta
      replanificar(p); p.destinoVigente = dest; p.fase = 'caminando'; p.sitio = null;
    }
    if (p.fase === 'caminando') {
      var q = p.ruta[0];
      if (!q) p.fase = 'llegando';
      else {
        var dx = q.x - p.raiz.position.x, dz = q.z - p.raiz.position.z, d = Math.sqrt(dx * dx + dz * dz), v = 1.85 * dt;
        if (d <= v) { p.raiz.position.x = q.x; p.raiz.position.z = q.z; p.ruta.shift(); }
        else { p.raiz.position.x += dx / d * v; p.raiz.position.z += dz / d * v; p.raiz.rotation.y = haciaAngulo(p.raiz.rotation.y, Math.atan2(dx, dz), dt * 9); }
        p.camina = Math.min(1, p.camina + dt * 6); p.fase_p += dt * 7.4; return;
      }
    }
    p.camina = Math.max(0, p.camina - dt * 6);
    if (p.fase === 'llegando' && dest) {
      p.raiz.rotation.y = haciaAngulo(p.raiz.rotation.y, dest.giro, dt * 8);
      if (Math.abs(angDif(p.raiz.rotation.y, dest.giro)) < 0.08) { p.sitio = dest; p.fase = 'parado'; }
    }
    if (p.sitio) {
      p.raiz.rotation.y = haciaAngulo(p.raiz.rotation.y, p.sitio.giro, dt * 8);
      if (p.fase === 'parado') p.sentado = p.sitio.pose === 'sit' ? Math.min(1, p.sentado + dt * 3.2) : Math.max(0, p.sentado - dt * 3.2);
    }
  }

  // ═════════ perros (los vigilantes) ═════════
  var PERROS = {}, galletas = [];
  var DEFP = { director: { rol: 'Director', cuerpo: 0xd9a441, oreja: 0xa97a2c, pecho: 0xe8c47e }, cons: { rol: 'Constructor', cuerpo: 0x23262f, oreja: 0x14161c, pecho: 0xe9eef5 } };
  function crearPerro(k) {
    var d = DEFP[k], raiz = new THREE.Group(), cuerpo; scene.add(raiz); cuerpo = eje(raiz, 0, 0, 0);
    var tronco = eje(cuerpo, 0, 0.36, 0); caja(0.28, 0.28, 0.54, d.cuerpo, 0, 0, 0, tronco); caja(0.2, 0.2, 0.2, d.pecho, 0, -0.03, 0.2, tronco);
    var cuello = eje(tronco, 0, 0.12, 0.3), cab = eje(cuello, 0, 0.1, 0.08);
    caja(0.2, 0.2, 0.22, d.cuerpo, 0, 0, 0, cab); caja(0.13, 0.1, 0.14, d.pecho, 0, -0.04, 0.17, cab); caja(0.05, 0.04, 0.04, 0x0c0e12, 0, -0.01, 0.25, cab);
    caja(0.04, 0.04, 0.02, 0x0c0e12, -0.06, 0.05, 0.11, cab, { nosombra: true }); caja(0.04, 0.04, 0.02, 0x0c0e12, 0.06, 0.05, 0.11, cab, { nosombra: true });
    var oI = eje(cab, -0.11, 0.08, -0.02), oD = eje(cab, 0.11, 0.08, -0.02); caja(0.05, 0.16, 0.1, d.oreja, 0, -0.06, 0, oI); caja(0.05, 0.16, 0.1, d.oreja, 0, -0.06, 0, oD);
    var cola = eje(tronco, 0, 0.1, -0.3); caja(0.06, 0.06, 0.3, d.oreja, 0, 0.06, -0.12, cola);
    function pata(x, z) { var h = eje(tronco, x, -0.1, z); caja(0.07, 0.28, 0.08, d.cuerpo, 0, -0.14, 0, h); return h; }
    var patas = [pata(-0.1, 0.2), pata(0.1, 0.2), pata(-0.1, -0.2), pata(0.1, -0.2)];
    var tag = sprite(lienzo(360, 84), 2.1, 12); tag.position.set(0, 1.35, 0); raiz.add(tag);
    var bub = sprite(lienzo(380, 96), 2.8, 13); bub.position.set(0, 2.1, 0); bub.visible = false; raiz.add(bub);
    var zz = sprite(lienzo(128, 128), 0.8, 12); zz.position.set(0.2, 0.9, 0); raiz.add(zz); var gz = zz._canvas.getContext('2d'); gz.fillStyle = '#9fc4ff'; gz.font = 'bold 70px sans-serif'; gz.fillText('z', 20, 90); gz.font = 'bold 44px sans-serif'; gz.fillText('Z', 64, 56); zz._tex.needsUpdate = true;
    raiz.userData.perro = k;
    var pf = { k: k, def: d, raiz: raiz, cuerpo: cuerpo, tronco: tronco, cuello: cuello, cab: cab, cola: cola, patas: patas, orejas: [oI, oD], tag: tag, bub: bub, bubHasta: 0, zz: zz,
      estado: 'dormido', despierto: 0, x: CAMA[k].x, z: CAMA[k].z, meta: null, espera: 0, rumbo: 0, etq: '', alerta: false, comiendo: 0, vivo: false };
    raiz.position.set(pf.x, 0, pf.z); return pf;
  }
  Object.keys(DEFP).forEach(function (k) { PERROS[k] = crearPerro(k); });
  function etiquetaPerro(pf) {
    var linea2 = pf.vivo ? (pf.alerta ? 'te llama' : 'vigilando') : 'durmiendo', key = linea2 + pf.vivo; if (pf.etq === key) return; pf.etq = key;
    var c = pf.tag._canvas, g = c.getContext('2d'), col = pf.vivo ? '#3ddc84' : '#6b7690'; g.clearRect(0, 0, c.width, c.height);
    g.fillStyle = 'rgba(8,12,22,0.82)'; recorte(g, 3, 3, c.width - 6, c.height - 6, 16); g.fill(); g.strokeStyle = col; g.lineWidth = 3; g.stroke();
    g.fillStyle = col; g.beginPath(); g.arc(24, 28, 8, 0, 7); g.fill(); g.fillStyle = '#f2f6ff'; g.font = 'bold 26px sans-serif'; g.fillText('Vigilante · ' + pf.def.rol, 42, 36);
    g.fillStyle = '#aebbd3'; g.font = '22px sans-serif'; g.fillText(linea2, 18, 68); pf.tag._tex.needsUpdate = true;
  }
  function animarPerro(pf, dt, t) {
    var cama = CAMA[pf.k], duenoP = P[pf.k], objetivoDespierto = pf.vivo ? 1 : 0;
    if (pf.vivo && pf.estado === 'dormido') { pf.estado = 'despertando'; pf.espera = 1.2; }
    if (!pf.vivo && pf.estado !== 'dormido' && pf.estado !== 'yendoCama') { pf.estado = 'yendoCama'; pf.meta = { x: cama.x, z: cama.z }; }
    var correr = 0, v = 0;
    if (pf.estado === 'despertando') { pf.espera -= dt; if (pf.espera <= 0) { pf.estado = 'patrulla'; pf.espera = 0; } }
    else if (pf.estado === 'patrulla' || pf.estado === 'alerta') {
      var dp = pf.alerta ? { x: duenoP.raiz.position.x + 0.7, z: duenoP.raiz.position.z + 0.9 } : null;
      if (pf.alerta) { pf.meta = dp; }
      else if (!pf.meta || pf.espera > 0) { pf.espera -= dt; if (pf.espera <= 0 && !pf.meta) { var cx = duenoP.sitio && duenoP.sitio.zona === 'trabajo' ? CAMA[pf.k].x + (pf.k === 'director' ? 1.8 : -1.8) : duenoP.raiz.position.x, cz = duenoP.sitio && duenoP.sitio.zona === 'trabajo' ? 0.2 : duenoP.raiz.position.z + 1.1; pf.meta = { x: Math.max(-9.3, Math.min(9.3, cx + (Math.random() - 0.5) * 3)), z: Math.max(-1.6, Math.min(6.4, cz + (Math.random() - 0.5) * 2.4)) }; } }
    }
    if (pf.meta && pf.estado !== 'despertando' && pf.estado !== 'dormido') {
      var dx = pf.meta.x - pf.x, dz = pf.meta.z - pf.z, d = Math.sqrt(dx * dx + dz * dz); v = (pf.alerta || pf.estado === 'yendoCama' ? 2.6 : 1.2) * dt;
      if (d <= v + 0.05) { pf.x = pf.meta.x; pf.z = pf.meta.z; pf.meta = null; pf.espera = 1.5 + Math.random() * 3.5; if (pf.estado === 'yendoCama') { pf.estado = 'dormido'; } v = 0; }
      else { pf.x += dx / d * v; pf.z += dz / d * v; pf.rumbo = haciaAngulo(pf.rumbo, Math.atan2(dx, dz), dt * 9); correr = 1; }
    }
    var dormido = pf.estado === 'dormido', curl = dormido ? 1 : 0; pf.curl = lerp(pf.curl || 0, curl, Math.min(1, dt * 4));
    pf.raiz.position.set(pf.x, 0, pf.z); pf.raiz.rotation.y = dormido ? haciaAngulo(pf.raiz.rotation.y, 0.6, dt * 3) : pf.rumbo;
    var ph = t * 14; pf.patas.forEach(function (pa, i) { var sw = Math.sin(ph + (i === 1 || i === 2 ? Math.PI : 0)) * 0.7 * correr; pa.rotation.x = lerp(sw, i < 2 ? -1.35 : 1.35, pf.curl); });
    pf.tronco.position.y = lerp(0.36 + Math.abs(Math.sin(ph)) * 0.02 * correr, 0.22 + 0.0, pf.curl) + (pf.estado === 'despertando' ? Math.sin(t * 10) * 0.01 : 0);
    pf.cuello.rotation.x = lerp(correr ? 0.05 : -0.15, 0.7, pf.curl); pf.cab.rotation.x = lerp(pf.comiendo > 0 ? 0.5 : 0, 0.3, pf.curl);
    if (pf.saludo > 0) { pf.saludo -= dt; pf.tronco.position.y += Math.abs(Math.sin(t * 9)) * 0.05; }
    pf.cola.rotation.y = Math.sin(t * (pf.saludo > 0 || (pf.vivo && !correr) ? 18 : 6)) * (pf.vivo || pf.saludo > 0 ? 0.5 : 0.1); pf.cola.rotation.x = lerp(-0.3, 0.9, pf.curl);
    pf.orejas.forEach(function (o, i) { o.rotation.z = (i ? -1 : 1) * (pf.alerta ? 0.0 : 0.28) + (pf.curl * (i ? -0.2 : 0.2)); });
    pf.zz.visible = dormido; if (dormido) { var q = (t * 0.6) % 1; pf.zz.position.set(0.25 + q * 0.2, 0.7 + q * 0.5, 0); pf.zz.material.opacity = 1 - q; }
    if (pf.comiendo > 0) pf.comiendo -= dt;
    if (pf.bub.visible && AHORA() > pf.bubHasta) pf.bub.visible = false;
    etiquetaPerro(pf);
  }

  // ═════════ mascota Clawd: camina por la oficina saludando a todos (clic = dice algo) ═════════
  var clawd = new THREE.Group(); clawd.position.set(-0.3, 0, 2.2); scene.add(clawd);
  var clawdCuerpo = eje(clawd, 0, 0.3, 0);
  caja(0.74, 0.4, 0.4, 0xd97757, 0, 0.3, 0, clawdCuerpo); caja(0.12, 0.12, 0.12, 0xd97757, -0.43, 0.34, 0, clawdCuerpo); caja(0.12, 0.12, 0.12, 0xd97757, 0.43, 0.34, 0, clawdCuerpo);
  var clawdPatas = [-0.24, -0.08, 0.08, 0.24].map(function (x) { var h = eje(clawd, x, 0.3, 0); caja(0.1, 0.3, 0.1, 0xc2603f, 0, -0.15, 0, h); return h; });
  var ojosClawd = [caja(0.08, 0.13, 0.02, 0x1a0f0a, -0.14, 0.36, 0.205, clawdCuerpo, { nosombra: true }), caja(0.08, 0.13, 0.02, 0x1a0f0a, 0.14, 0.36, 0.205, clawdCuerpo, { nosombra: true })];
  clawd.userData.clic = 'clawd'; var clawdBub = sprite(lienzo(380, 96), 2.7, 13); clawdBub.position.set(0, 1.55, 0); clawdBub.visible = false; clawd.add(clawdBub); var clawdHasta = 0, clawdSalto = 0, clawdTag = sprite(lienzo(300, 84), 1.5, 12);
  (function () { var c = clawdTag._canvas, g = c.getContext('2d'); g.fillStyle = 'rgba(8,12,22,0.8)'; recorte(g, 3, 3, c.width - 6, c.height - 6, 16); g.fill(); g.strokeStyle = '#d97757'; g.lineWidth = 3; g.stroke(); g.fillStyle = '#f2f6ff'; g.font = 'bold 34px sans-serif'; g.textAlign = 'center'; g.fillText('Clawd', 150, 38); g.fillStyle = '#aebbd3'; g.font = '22px sans-serif'; g.fillText('mascota · pulsa', 150, 68); clawdTag._tex.needsUpdate = true; clawdTag.position.set(0, 1.18, 0); clawd.add(clawdTag); })();
  var FRASES_CLAWD = ['¡Hola! Soy Clawd.', 'Los perritos vigilan; yo animo.', 'Un test en verde alegra el día.', 'Respira. Compila. Repite.', '¿Ya probaste correr los tests?', 'Menos bugs, más galletas.', 'Aquí nadie se queda dormido… ¿o sí?'];
  var iFrase = 0;
  function clawdHabla() { iFrase = (iFrase + 1) % FRASES_CLAWD.length; var c = clawdBub._canvas, g = c.getContext('2d'); g.clearRect(0, 0, c.width, c.height); g.fillStyle = 'rgba(244,248,255,0.97)'; g.strokeStyle = '#d97757'; g.lineWidth = 4; recorte(g, 6, 6, c.width - 12, 64, 16); g.fill(); g.stroke(); g.beginPath(); g.moveTo(c.width / 2 - 14, 68); g.lineTo(c.width / 2, 90); g.lineTo(c.width / 2 + 14, 68); g.fill(); g.fillStyle = '#10182c'; g.font = 'bold 26px sans-serif'; g.textAlign = 'center'; g.fillText(cortar(FRASES_CLAWD[iFrase], 28), c.width / 2, 49); clawdBub._tex.needsUpdate = true; clawdBub.visible = true; clawdHasta = AHORA() + 4200; clawdSalto = 1; }
  // paseo: elige a alguien (persona o perro), va hasta él, lo saluda con un salto y sigue con otro
  var cw = { estado: 'espera', espera: 2.5, ruta: [], objetivo: null, previo: null, fase: 0 };
  function clawdElegir() {
    var cand = ORDEN.map(function (k) { return 'p:' + k; }).concat(['d:director', 'd:cons']).filter(function (x) { return x !== cw.previo; });
    var c = cand[Math.floor(Math.random() * cand.length)], k = c.slice(2), esP = c[0] === 'p', pos = esP ? P[k].raiz.position : { x: PERROS[k].x, z: PERROS[k].z };
    var enSala = pos.z > -1.4, dest = { x: Math.max(-9.2, Math.min(9.2, pos.x + (enSala ? 1.3 : 0))), z: Math.max(-1.55, Math.min(6.4, enSala ? pos.z + 0.4 : pos.z + 1.0)) };
    if (!esP && pos.z < -0.4) dest = { x: pos.x + (k === 'director' ? 1.2 : -1.2), z: pos.z + 0.9 };
    var desde = nodoCercano({ x: clawd.position.x, z: clawd.position.z }), hasta = nodoCercano(dest), pts = [];
    ruta(desde, hasta).forEach(function (n) { pts.push({ x: G[n].x, z: G[n].z }); }); pts.push(dest);
    cw.objetivo = { esP: esP, k: k }; cw.previo = c; cw.ruta = pts; cw.estado = 'camina';
  }
  function clawdPaso(dt, t) {
    var salto = 0;
    if (cw.estado === 'espera') { cw.espera -= dt; if (cw.espera <= 0) clawdElegir(); }
    else if (cw.estado === 'camina') {
      var q = cw.ruta[0];
      if (!q) { cw.estado = 'saluda'; cw.espera = 2.6; clawdSalto = 1; var o = cw.objetivo; if (o.esP) P[o.k].saludo = 2.2; else PERROS[o.k].saludo = 2.2; }
      else {
        var dx = q.x - clawd.position.x, dz = q.z - clawd.position.z, d = Math.sqrt(dx * dx + dz * dz), v = 1.6 * dt;
        if (d <= v) { clawd.position.x = q.x; clawd.position.z = q.z; cw.ruta.shift(); }
        else { clawd.position.x += dx / d * v; clawd.position.z += dz / d * v; clawd.rotation.y = haciaAngulo(clawd.rotation.y, Math.atan2(dx, dz), dt * 9); }
        cw.fase += dt * 11; salto = Math.abs(Math.sin(cw.fase)) * 0.07;
      }
    } else if (cw.estado === 'saluda') {
      var ob = cw.objetivo, tp = ob.esP ? P[ob.k].raiz.position : { x: PERROS[ob.k].x, z: PERROS[ob.k].z };
      clawd.rotation.y = haciaAngulo(clawd.rotation.y, Math.atan2(tp.x - clawd.position.x, tp.z - clawd.position.z), dt * 8);
      cw.espera -= dt; if (cw.espera <= 0) { cw.estado = 'espera'; cw.espera = 3 + Math.random() * 5; }
    }
    clawdPatas.forEach(function (h, i) { h.rotation.x = cw.estado === 'camina' ? Math.sin(cw.fase + i * 1.6) * 0.6 : 0; });
    clawdCuerpo.position.y = 0.3 + salto + Math.sin(t * 2) * 0.01 + (clawdSalto > 0 ? Math.abs(Math.sin((1 - clawdSalto) * Math.PI * 3)) * 0.3 : 0);
    if (clawdSalto > 0) clawdSalto = Math.max(0, clawdSalto - dt * 0.9);
    var parp = (t % 4.5) < 0.12; ojosClawd.forEach(function (o) { o.scale.y = parp ? 0.15 : 1; });
    if (clawdBub.visible && AHORA() > clawdHasta) clawdBub.visible = false;
  }

  // ═════════ confeti y sobres ═════════
  var confeti = [], vuelos = [];
  for (var ci = 0; ci < 60; ci++) { var cm = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.02, 0.06), new THREE.MeshBasicMaterial({ color: [0x3fe2e8, 0xffc233, 0xff7a59, 0x8b6bd9, 0x3ddc84][ci % 5] })); cm.visible = false; scene.add(cm); confeti.push({ m: cm, vida: 0, v: new THREE.Vector3() }); }
  function lanzarConfeti(x, y, z) { confeti.forEach(function (c) { c.vida = 1.8 + Math.random() * 0.8; c.m.position.set(x + (Math.random() - 0.5) * 0.6, y, z + (Math.random() - 0.5) * 0.6); c.v.set((Math.random() - 0.5) * 3.2, 3.5 + Math.random() * 2.5, (Math.random() - 0.5) * 3.2); c.m.visible = true; }); }
  function sobre(desde, hacia, color) {
    var m = new THREE.Group(); caja(0.34, 0.04, 0.24, 0xf2f6ff, 0, 0, 0, m, { nosombra: true }); caja(0.34, 0.045, 0.1, color, 0, 0.02, -0.07, m, { e: 0.6, nosombra: true }); scene.add(m);
    vuelos.push({ m: m, a: { x: desde.x, z: desde.z }, b: { x: hacia.x, z: hacia.z }, t: 0, dur: 2.4 });
  }

  // ═════════ pantallas de la pared ═════════
  var ACT = null;               // actividad de aa: por modelo (marcas de tiempo), sirve aunque TEAMS no esté activo
  var D = null, Dprev = null, recibido = 0, estadoTarea = {}, aparecio = {}, eventosVistos = {}, ultimoAvance = -1, firma = {};
  function colorEstado(e, auditando, construyendo) {
    if (auditando) return '#8b6bd9'; if (e === 'ACEPTADA') return '#3ddc84'; if (e === 'HECHA_SIN_ACEPTAR') return '#ffc233'; if (e === 'DEVUELTA') return '#ff5a5a'; if (e === 'CANCELADA' || e === 'HEREDADA') return '#566178'; return construyendo ? '#4aa3ff' : '#7f8aa3';
  }
  function fondoVidrio(g, w, h, titulo, der) {
    var gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, '#111b30'); gr.addColorStop(1, '#0a1120'); g.fillStyle = gr; g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(63,226,232,0.35)'; g.lineWidth = 2; g.strokeRect(6, 6, w - 12, h - 12);
    g.fillStyle = '#3fe2e8'; g.font = 'bold 32px sans-serif'; g.textAlign = 'left'; g.fillText(titulo, 26, 50); if (der) { g.fillStyle = '#9fb0cf'; g.font = '26px sans-serif'; g.textAlign = 'right'; g.fillText(der, w - 26, 46); g.textAlign = 'left'; }
  }
  function pintarPizarra(d) {
    var g = cPizarra.getContext('2d'), W = 1200, H = 640; fondoVidrio(g, W, H, 'PIZARRA', d ? 'modo ' + String(d.modo || 'por definir').toUpperCase() + ' · canal ' + d.canal : 'sin canal');
    if (!d) { g.fillStyle = '#7f8aa3'; g.font = '34px sans-serif'; g.textAlign = 'center'; g.fillText('Sin TEAMS activo', W / 2, H / 2 - 10); g.font = '24px sans-serif'; g.fillText('Escribe  teams: activar  en Claude Code', W / 2, H / 2 + 34); pPizarra._tex.needsUpdate = true; return; }
    var cols = [['EN COLA', d.cola.tareas, '#4aa3ff'], ['POR ACEPTAR', d.cola.por_aceptar.concat(d.cola.devueltas), '#ffc233'], ['CORRECCIONES', d.cola.correcciones, '#ff5a5a'], ['DECISIONES TUYAS', d.cola.decisiones_dueno, '#8b6bd9']], cw = (W - 52) / 4;
    cols.forEach(function (c, i) {
      var x = 26 + i * cw; g.fillStyle = c[2]; g.font = 'bold 26px sans-serif'; g.textAlign = 'left'; g.fillText(c[0] + '  ' + c[1].length, x, 104);
      g.fillStyle = 'rgba(255,255,255,0.07)'; g.fillRect(x, 112, cw - 14, 2);
      g.font = 'bold 26px sans-serif'; var n = Math.min(c[1].length, 5); for (var j = 0; j < n; j++) { var it = c[1][j]; g.fillStyle = c[2]; g.fillText(it.id, x, 156 + j * 84); g.fillStyle = '#dbe5f7'; g.font = '23px sans-serif'; envolver(g, it.titulo || '', x, 156 + j * 84 + 28, cw - 20, 25, 2); g.font = 'bold 26px sans-serif'; }
      if (c[1].length > n) { g.fillStyle = '#7f8aa3'; g.fillText('+ ' + (c[1].length - n) + ' más', x, 156 + n * 84); }
      if (!c[1].length) { g.fillStyle = '#4b566e'; g.font = '20px sans-serif'; g.fillText('—', x, 150); }
    });
    g.fillStyle = '#9fb0cf'; g.font = '24px sans-serif'; g.textAlign = 'left'; g.fillText('Plan: ' + (d.plan ? 'guardado' : 'sin plan') + ' · ' + (d.extras ? d.extras + ' auditor(es) extra · ' : '') + 'avance ' + (d.avance === null || d.avance === undefined ? 'n/d' : d.avance + ' %'), 26, H - 24);
    pPizarra._tex.needsUpdate = true;
  }
  function pintarSemaforo(d) {
    var g = cSem.getContext('2d'), W = 640, H = 720; fondoVidrio(g, W, H, 'SEMÁFORO', d ? d.canal : '');
    var estado = d ? d.semaforo : 'APAGADO', activo = COL_SEM[estado] ? estado : null;
    ['ROJO', 'AMARILLO', 'VERDE'].forEach(function (n, i) { g.fillStyle = activo === n ? '#' + COL_SEM[n].toString(16).padStart(6, '0') : '#1a2236'; g.beginPath(); g.arc(90, 140 + i * 110, 40, 0, 7); g.fill(); if (activo === n) { g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 5; g.stroke(); } });
    g.textAlign = 'left'; g.fillStyle = activo ? '#' + COL_SEM[activo].toString(16).padStart(6, '0') : '#9fb0cf'; g.font = 'bold 40px sans-serif';
    g.fillText(!d ? 'SIN CANAL' : activo ? ({ VERDE: 'TODO BIEN', AMARILLO: 'ATENCIÓN', ROJO: 'ALGUIEN PARADO' })[activo] : estado, 160, 128);
    g.font = '26px sans-serif'; g.fillStyle = '#dbe5f7';
    if (d) {
      var y = 168, al = d.alertas || []; if (!al.length) { g.fillStyle = '#7f8aa3'; g.fillText(activo ? 'Sin alertas.' : 'Canal en ' + d.canal.toLowerCase() + '.', 160, y); }
      for (var i = 0; i < Math.min(al.length, 4); i++) { g.fillStyle = al[i].nivel === 'ROJO' ? '#ff8a8a' : '#ffd36a'; y += envolver(g, '• ' + al[i].msg.replace(/\s*\(.*$/, ''), 160, y, 440, 30, 2) * 30 + 8; }
      var ry = 484; [['director', 'Director'], ['builder', 'Constructor']].forEach(function (r) { var ro = d.roles[r[0]]; g.fillStyle = '#9fb0cf'; g.font = 'bold 28px sans-serif'; g.fillText(r[1], 36, ry); g.font = '24px sans-serif'; g.fillStyle = ro.vigilante.vivo ? '#3ddc84' : '#ff6b6b'; g.fillText('vigilante ' + (ro.vigilante.vivo ? 'vivo' : 'APAGADO'), 36, ry + 30); g.fillStyle = ro.loop === 'ACTIVO' ? '#3ddc84' : ro.loop === 'n/a' ? '#7f8aa3' : '#ffc233'; g.fillText('loop ' + (ro.loop === 'ACTIVO' ? 'activo' : ro.loop === 'n/a' ? 'n/a' : 'no figura'), 300, ry + 30); ry += 84; });
    }
    pSem._tex.needsUpdate = true;
    var col = activo ? COL_SEM[activo] : 0x2a3350; ['ROJO', 'AMARILLO', 'VERDE'].forEach(function (n) { var on = activo === n; lamparas[n].material = mat(on ? COL_SEM[n] : APAGADA[n], on ? { e: 1.6 } : {}); }); luzSemaforo.color.setHex(col); luzSemaforo.intensity = activo ? 1.0 : 0.15;
  }
  function pintarFlujo(d, t) {
    var g = cFlujo.getContext('2d'), W = 1280, H = 720, N;
    fondoVidrio(g, W, H, 'FLUJO DEL PROYECTO', d ? 'aceptadas ' + d.aceptadas + ' / ' + d.total + (d.avance !== null && d.avance !== undefined ? '  ·  ' + d.avance + ' %' : '') : '');
    if (!d || !d.tareas_todas || !d.tareas_todas.length) { g.fillStyle = '#7f8aa3'; g.font = '34px sans-serif'; g.textAlign = 'center'; g.fillText(d ? 'Aún no hay tareas: el diagrama se construye solo' : 'Sin TEAMS activo', W / 2, H / 2); g.font = '24px sans-serif'; g.fillText(d ? 'cada módulo aparece aquí cuando el Director lo encola' : 'teams: activar  →  teams: plan  →  teams: constructor', W / 2, H / 2 + 44); pFlujo._tex.needsUpdate = true; return; }
    var todas = d.tareas_todas, MAXN = 15, oculto = Math.max(0, todas.length - MAXN), vis = todas.slice(oculto), POR = 5, nw = 210, nh = 118, gx = (W - 70 - POR * nw) / (POR - 1), gy = 62, x0 = 35, y0 = 96;
    var aud = d.auditoria && d.auditoria.id, primeraPend = null; vis.forEach(function (tt) { if (!primeraPend && tt.estado === 'PENDIENTE') primeraPend = tt.id; });
    var cons = (d.roles.builder.pendiente > 0) ? primeraPend : null, ahora = AHORA(), pos = {};
    vis.forEach(function (tt, i) { var fila = Math.floor(i / POR), col = i % POR, serp = fila % 2; var cx = x0 + (serp ? (POR - 1 - col) : col) * (nw + gx), cy = y0 + fila * (nh + gy); pos[tt.id] = { x: cx, y: cy, i: i }; });
    g.lineWidth = 4; vis.forEach(function (tt, i) {
      if (!i) return; var a = pos[vis[i - 1].id], b = pos[tt.id], seg = (ahora - (aparecio[tt.id] || 0)) / 700; if (seg < 0) seg = 0; seg = Math.min(1, seg);
      var ax = a.x + nw / 2, ay = a.y + nh / 2, bx = b.x + nw / 2, by = b.y + nh / 2; if (Math.abs(ay - by) < 5) { var dir = b.x > a.x ? 1 : -1; ax = a.x + (dir > 0 ? nw : 0); bx = b.x + (dir > 0 ? 0 : nw); } else { ay = a.y + nh; by = b.y; }
      g.strokeStyle = vis[i - 1].estado === 'ACEPTADA' ? '#2d9a63' : '#3a465f'; g.beginPath(); g.moveTo(ax, ay); g.lineTo(ax + (bx - ax) * seg, ay + (by - ay) * seg); g.stroke();
    });
    vis.forEach(function (tt) {
      var p = pos[tt.id], esc = Math.min(1, (ahora - (aparecio[tt.id] || 0)) / 600), e = 0.55 + 0.45 * (1 - Math.pow(1 - esc, 3)), auditando = aud === tt.id, constru = cons === tt.id, col = colorEstado(tt.estado, auditando, constru);
      g.save(); g.translate(p.x + nw / 2, p.y + nh / 2); g.scale(e, e); g.globalAlpha = Math.min(1, esc * 1.4); g.translate(-nw / 2, -nh / 2);
      g.fillStyle = 'rgba(12,19,34,0.96)'; recorte(g, 0, 0, nw, nh, 14); g.fill(); g.lineWidth = auditando || constru ? 5 : 3; g.strokeStyle = col; if (tt.estado === 'PENDIENTE' && !constru) g.setLineDash([9, 7]); g.stroke(); g.setLineDash([]);
      g.fillStyle = col; g.font = 'bold 28px sans-serif'; g.textAlign = 'left'; g.fillText(tt.id, 14, 34);
      g.fillStyle = '#dbe5f7'; g.font = '22px sans-serif'; envolver(g, tt.titulo, 14, 64, nw - 24, 24, 2);
      var etq = auditando ? 'auditando' : tt.estado === 'ACEPTADA' ? '✔ aceptada' : tt.estado === 'HECHA_SIN_ACEPTAR' ? 'entregada' : tt.estado === 'DEVUELTA' ? (tt.reporte === 'PARCIAL' ? 'parcial · bloqueada' : 'devuelta') : constru ? 'construyendo' : tt.estado === 'CANCELADA' ? 'cancelada' : tt.estado === 'HEREDADA' ? 'heredada' : 'en cola';
      g.fillStyle = col; g.font = 'bold 20px sans-serif'; g.fillText(etq, 14, nh - 12);
      if (constru || auditando) { var ang = t * 3; g.strokeStyle = col; g.lineWidth = 4; g.beginPath(); g.arc(nw - 28, nh - 26, 11, ang, ang + 4.2); g.stroke(); }
      g.restore();
    });
    if (oculto) { g.fillStyle = '#7f8aa3'; g.font = '20px sans-serif'; g.textAlign = 'left'; g.fillText('+' + oculto + ' módulos anteriores', 35, y0 - 14); }
    var abiertas = (d.correcciones_todas || []).filter(function (k) { return !k.resuelta; }); if (abiertas.length) { g.fillStyle = '#ff8a8a'; g.font = 'bold 20px sans-serif'; g.textAlign = 'left'; g.fillText('Correcciones abiertas: ' + abiertas.slice(0, 6).map(function (k) { return k.id; }).join('  ') + (abiertas.length > 6 ? '  …' : ''), 35, H - 44); }
    g.fillStyle = '#1a2540'; g.fillRect(35, H - 28, W - 70, 10); g.fillStyle = '#3ddc84'; g.fillRect(35, H - 28, (W - 70) * (d.avance || 0) / 100, 10);
    pFlujo._tex.needsUpdate = true;
  }
  var tvT = 0;
  function pintarTV(t, encendida) {
    var g = cTV.getContext('2d'); g.fillStyle = encendida ? '#0a1430' : '#06080e'; g.fillRect(0, 0, 256, 144);
    if (encendida) {
      g.fillStyle = '#16264d'; g.fillRect(0, 0, 256, 18); g.fillStyle = '#e8eef9'; g.fillRect(122, 20, 4, 108);
      var bx = 128 + Math.sin(t * 2.1) * 100, by = 72 + Math.sin(t * 3.3) * 46; g.fillStyle = '#ffc233'; g.fillRect(bx - 5, by - 5, 10, 10);
      g.fillStyle = '#3fe2e8'; g.fillRect(10, 72 + Math.sin(t * 3.3 + 0.6) * 40 - 14, 7, 28); g.fillStyle = '#ff7a59'; g.fillRect(239, 72 + Math.sin(t * 3.3 - 0.5) * 40 - 14, 7, 28);
      g.fillStyle = '#9fb0cf'; g.font = 'bold 14px monospace'; g.fillText('PONG', 108, 14);
    } else { g.fillStyle = '#1a1f2e'; g.font = '14px monospace'; g.fillText('standby', 100, 76); }
    tvP._tex.needsUpdate = true; luzTV.intensity = encendida ? 0.7 + Math.sin(t * 5) * 0.12 : 0.1;
  }

  // ═════════ decidir qué hace cada quien (todo sale de los datos reales) ═════════
  var intrP = {};   // interrupciones por persona
  function asientoLibre(k) {
    if (P[k].asientoSala && ocupados[P[k].asientoSala] === k) return P[k].asientoSala;
    for (var i = 0; i < ASIENTOS_SALA.length; i++) { var s = ASIENTOS_SALA[i]; if (!ocupados[s]) { ocupados[s] = k; P[k].asientoSala = s; return s; } }
    return ASIENTOS_SALA[0];
  }
  function soltarAsiento(k) { var s = P[k].asientoSala; if (s && ocupados[s] === k) delete ocupados[s]; P[k].asientoSala = null; }
  function actividadSeg() { return D ? (D.actividad_seg || 0) + (AHORA() - recibido) / 1000 : 9999; }
  function decidir() {
    var d = D, individual = d && d.modo === 'individual', ocioso = actividadSeg() >= ESPERA_S;
    var enMarcha = !!d && (d.canal === 'ACTIVO' || d.canal === 'PREPARADO');
    var cola = d ? d.cola : { tareas: [], por_aceptar: [], devueltas: [], correcciones: [], decisiones_dueno: [] };
    var aud = d && d.auditoria, ro = d ? d.roles : null;
    var trabajaDir = !!d && (cola.por_aceptar.length > 0 || cola.devueltas.length > 0 || !!aud);
    var trabajaCons = !!d && (cola.tareas.length > 0 || cola.correcciones.length > 0);
    var A = (ACT && ACT.actores ? ACT.actores : []).filter(function (a) { return a.activa; });
    var actCons = A.filter(function (a) { return /cursor/i.test(a.actor); })[0] || null, actDir = A.filter(function (a) { return !/cursor/i.test(a.actor); })[0] || null;
    var construyeDir = !!d && individual && (cola.tareas.length > 0 || cola.correcciones.length > 0);   // modo individual: Claude Code también construye
    trabajaDir = trabajaDir || construyeDir || !!actDir; trabajaCons = trabajaCons || !!actCons;
    var parado = !!(ro && ro.builder && ro.builder.sin_novedad && ro.builder.sin_novedad.veredicto === 'PARADO' && ro.builder.sin_novedad.n >= 2);
    if (parado) trabajaCons = false;
    var meta = {};
    meta.director = { sala: actDir ? false : (!enMarcha || (ocioso && !trabajaDir)), trab: trabajaDir };
    var subsAqui = enMarcha && (d.plan || d.total > 0 || d.canal === 'ACTIVO');
    ['fe', 'be', 'neg'].forEach(function (k) { meta[k] = { sala: !subsAqui || (ocioso && !aud), trab: !!aud }; });
    meta.cons = { sala: actCons ? false : (!enMarcha || individual || !(d.builder_conectado || ro.builder.vigilante.vivo) || (ocioso && !trabajaCons)), trab: trabajaCons };
    ORDEN.forEach(function (k) {
      var p = P[k], m = meta[k], tag = DEF[k], linea2, col;
      var sitio;
      if (intrP[k] && intrP[k].sitio) sitio = intrP[k].sitio;
      else if (m.sala) sitio = SITIOS[asientoLibre(k)];
      else { soltarAsiento(k); sitio = SITIOS['esc_' + k]; }
      if (!(intrP[k] && intrP[k].sitio) && !m.sala) soltarAsiento(k);
      if (p.destino !== sitio) { p.destino = sitio; }
      var enSitio = p.sitio === sitio && p.fase === 'parado';
      // postura según lo que hace en ese sitio
      var modo = 'lap';
      if (sitio.zona === 'sala') modo = sitio.juega ? 'game' : 'lap';
      else if (sitio.zona === 'trabajo') modo = m.trab ? 'type' : 'read';
      else if (sitio.pose === 'escribir') modo = 'escribir';
      else if (sitio.zona === 'perro') modo = 'dar';
      p.modoDeseado = modo; p.trabajando = m.trab;
      // texto de la etiqueta: solo lo que hace
      var texto, colEtq;
      if (sitio.zona === 'perro') { texto = 'Da una galleta al vigilante'; colEtq = '#3ddc84'; }
      else if (sitio.zona === 'sala') { texto = p.fase !== 'parado' ? 'Va a descansar' : sitio.juega ? 'Jugando' : 'Descansando'; colEtq = '#7f8aa3'; }
      else if (sitio.pose === 'escribir') { texto = sitio.id === 'pizarra' ? 'Escribiendo en la pizarra' : 'Mirando el flujo'; colEtq = '#3fe2e8'; }
      else if (k === 'director' && actDir) { texto = 'aa: ' + cortar(actDir.tarea, 22); colEtq = '#d97757'; }
      else if (k === 'cons' && actCons) { texto = 'aa: ' + cortar(actCons.tarea, 22); colEtq = '#4aa3ff'; }
      else if (k === 'director' && construyeDir) { texto = 'Construyendo ' + (cola.correcciones.length ? cola.correcciones[0].id : cola.tareas[0].id); colEtq = '#d97757'; }
      else if (k === 'director') { texto = cola.por_aceptar.length ? 'Revisando ' + cola.por_aceptar[0].id : aud ? 'Revisando ' + (aud.id || 'entrega') : cola.devueltas.length ? 'Decidiendo ' + cola.devueltas[0].id : 'Esperando entrega'; colEtq = m.trab ? '#d97757' : '#7f8aa3'; }
      else if (k === 'cons' && parado) { texto = 'Parado: espera que le escriban'; colEtq = '#ff5a5a'; }
      else if (k === 'cons') { texto = cola.correcciones.length ? 'Corrigiendo ' + cola.correcciones[0].id : cola.tareas.length ? 'Construyendo ' + cola.tareas[0].id : cola.devueltas.length ? 'Bloqueado: espera decisión' : 'Esperando tarea'; colEtq = m.trab ? '#4aa3ff' : '#7f8aa3'; }
      else { var area = { fe: 'UI/UX', be: 'backend', neg: 'negocio' }[k]; texto = aud ? 'Auditando ' + (aud.id || '') + ' · ' + area : 'En espera'; colEtq = aud ? '#8b6bd9' : '#7f8aa3'; }
      if (p.fase !== 'parado' && sitio.zona === 'trabajo') { texto = 'Va a su puesto'; colEtq = '#3fe2e8'; }
      pintarEtiqueta(p, tag.sub === 'sub-agente' ? tag.nombre : tag.nombre + ' · ' + tag.sub, texto, colEtq);
      // pantalla de su escritorio
      var ms = monitores[k]; if (ms) { var modoM = p.sitio && p.sitio.zona === 'trabajo' && p.fase === 'parado' ? (m.trab ? 'code' : 'idle') : 'off'; ms.forEach(function (o) { if (o.modo !== modoM) { o.modo = modoM; o.sucio = true; } }); }
    });
    // perros: vivos = su vigilante corre
    ['director', 'cons'].forEach(function (k) {
      var rol = k === 'cons' ? 'builder' : 'director', pf = PERROS[k], v = !!(ro && ro[rol].vigilante.vivo && d.canal === 'ACTIVO');
      if (d && d.canal !== 'ACTIVO') v = false;
      pf.vivo = v; var aviso = !!(ro && ro[rol].aviso_sin_atender_min > 0);
      if (v && aviso && !pf.alerta) { pf.alerta = true; pf.estado = 'alerta'; decir(pf, '¡guau!', 3500); } if (!aviso) { pf.alerta = false; if (pf.estado === 'alerta') pf.estado = 'patrulla'; }
    });
  }

  // ═════════ reacciones a los cambios (en el momento en que llegan) ═════════
  function interrumpir(k, sitio, modo, dur, alLlegar) { intrP[k] = { sitio: sitio, modo: modo, dur: dur, llegado: 0, alLlegar: alLlegar || null, hecho: false }; }
  function galleta(k) {
    var pf = PERROS[k], cama = CAMA[k], sitio = { id: 'galleta_' + k, nodo: nodoCercano({ x: cama.x, z: 0.6 }), aprox: [{ x: cama.x + (k === 'director' ? 0.9 : -0.9), z: 0.4 }], pos: { x: cama.x + (k === 'director' ? 0.9 : -0.9), z: cama.z + 0.5 }, giro: k === 'director' ? -Math.PI / 2 - 0.3 : Math.PI / 2 + 0.3, pose: 'stand', zona: 'perro' };
    if (k === 'director') sitio.nodo = 'a0'; else sitio.nodo = 'a12';
    interrumpir(k, sitio, 'dar', 2.8, function () {
      var p = P[k], m = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.025, 10), new THREE.MeshBasicMaterial({ color: 0xd9a05b })); m.position.set(p.raiz.position.x, 1.0, p.raiz.position.z); scene.add(m);
      vuelos.push({ m: m, a: { x: p.raiz.position.x, z: p.raiz.position.z }, b: { x: pf.x, z: pf.z }, t: 0, dur: 0.7, galleta: true, perro: pf, y0: 1.0, y1: 0.4 }); decir(P[k], 'Galleta para el vigilante', 3000);
    });
  }
  var FRASE_EVENTO = { activar: ['director', 'Canal activado'], plan: ['director', 'Plan guardado'], constructor: ['cons', 'Conectado a TEAMS'], pausa: ['director', 'En pausa'], continuar: ['director', 'Retomamos'], cerrar: ['director', 'Proyecto cerrado'], reabrir: ['director', 'Proyecto reabierto'], iniciar: ['director', 'Equipo en marcha'] };
  var cargado = false;
  function reaccionar(prev, d, silencioso) {
    var now = AHORA();
    if (silencioso) { (d.tareas_todas || []).forEach(function (t) { estadoTarea[t.id] = t.estado; aparecio[t.id] = now - 5000; }); (d.eventos || []).forEach(function (e) { eventosVistos[e.t + e.cmd] = 1; }); return; }
    (d.tareas_todas || []).forEach(function (t) {
      var a = estadoTarea[t.id];
      if (a === undefined) { aparecio[t.id] = now; interrumpir('director', SITIOS.pizarra, 'escribir', 6, function () { decir(P.director, 'Encola ' + t.id, 4000); }); }
      else if (a !== t.estado) {
        if (t.estado === 'HECHA_SIN_ACEPTAR') { sobre(P.cons.raiz.position, P.director.raiz.position, 0xffc233); decir(P.cons, 'Entrega ' + t.id, 4500); }
        else if (t.estado === 'ACEPTADA') { lanzarConfeti(P.director.raiz.position.x, 1.8, P.director.raiz.position.z); decir(P.director, 'Aceptada ' + t.id + ' ✔', 4500); }
        else if (t.estado === 'DEVUELTA') { sobre(P.director.raiz.position, P.cons.raiz.position, 0xff5a5a); decir(P.director, 'Devuelta ' + t.id, 4500); }
      }
      estadoTarea[t.id] = t.estado;
    });
    var viejas = {}; ((prev && prev.correcciones_todas) || []).forEach(function (k) { viejas[k.id] = 1; });
    (d.correcciones_todas || []).forEach(function (k) { if (!viejas[k.id] && !k.resuelta) { sobre(P.director.raiz.position, P.cons.raiz.position, 0xff5a5a); decir(P.director, 'Corrección ' + k.id, 4500); } });
    (d.eventos || []).forEach(function (e) {
      var kk = e.t + e.cmd; if (eventosVistos[kk]) return; eventosVistos[kk] = 1;
      var f = FRASE_EVENTO[e.cmd]; if (f) { decir(P[f[0]], f[1], 3800); if (e.cmd === 'cerrar') lanzarConfeti(0.6, 2.5, -4); }
      if (e.cmd === 'plan') interrumpir('director', SITIOS.pizarra, 'escribir', 7);
      if (e.cmd === 'auditar') decir(P.director, 'Auditando ' + (e.arg || ''), 4500);
    });
    ['director', 'builder'].forEach(function (r) { var k = r === 'builder' ? 'cons' : 'director', a = !!(prev && prev.roles[r].vigilante.vivo && prev.canal === 'ACTIVO'), b = d.roles[r].vigilante.vivo; if (!a && b && d.canal === 'ACTIVO') galleta(k); });
    if (prev && prev.canal !== 'CERRADO' && d.canal === 'CERRADO') lanzarConfeti(0.6, 2.5, -4);
  }
  function teletransportar() {
    ORDEN.forEach(function (k) { var p = P[k], s = p.destino || SITIOS.sofa1; p.sitio = s; p.destinoVigente = s; p.fase = 'parado'; p.ruta = []; p.raiz.position.set(s.pos.x, 0, s.pos.z); p.raiz.rotation.y = s.giro; p.sentado = s.pose === 'sit' ? 1 : 0; p.camina = 0; delete intrP[k]; });
    Object.keys(PERROS).forEach(function (k) { var pf = PERROS[k]; pf.meta = null; pf.espera = 1; if (pf.vivo) { pf.estado = 'patrulla'; pf.curl = 0; pf.x = CAMA[k].x + (k === 'director' ? 1.6 : -1.6); pf.z = 0.4; } else { pf.estado = 'dormido'; pf.curl = 1; pf.x = CAMA[k].x; pf.z = CAMA[k].z; } });
  }

  // ═════════ API pública ═════════
  window.mundoActualizar = function (d, j, act) {
    window.__ultimoReal = { d: d, j: j, act: act };
    if (sim) return;
    aplicarDatos(d, j, act);
  };
  function aplicarDatos(d, j, act) {
    var prev = D, silencioso = !cargado; D = d || null; ACT = act || null; recibido = AHORA(); cargado = true;
    if (d) reaccionar(prev, d, silencioso); else estadoTarea = {};
    decidir(); if (silencioso) { teletransportar(); decidir(); }
    pintarPizarra(D); pintarSemaforo(D); pintarFlujo(D, AHORA() / 1000);
    var n = document.getElementById('nota3d'); if (n) n.textContent = d ? 'Semáforo ' + d.semaforo + ' · canal ' + d.canal + (j && j.stale ? ' · (dato viejo)' : '') + (sim ? ' · DEMOSTRACIÓN' : ' · en vivo') : (sim ? 'DEMOSTRACIÓN · sin TEAMS' : 'Sin TEAMS activo · en vivo');
  }

  // ═════════ demostración: datos sintéticos por la MISMA ruta que los reales ═════════
  function role(vivo, pend, aviso) { return { nombre: '', vigilante: { vivo: vivo }, ultima_ronda_hace_min: vivo ? 1 : null, loop: vivo ? 'ACTIVO' : 'NO FIGURA', pendiente: pend || 0, razones: [], aviso_sin_atender_min: aviso || null }; }
  function tarea(id, titulo, estado, rep) { return { id: id, titulo: titulo, estado: estado, reporte: rep || null }; }
  function demo(o) {
    var tt = o.tareas || [], ac = tt.filter(function (t) { return t.estado === 'ACEPTADA'; }).length, tot = tt.filter(function (t) { return t.estado !== 'CANCELADA'; }).length;
    var base = { canal: 'ACTIVO', modo: 'completo', semaforo: 'VERDE', alertas: [], roles: { director: role(true), builder: role(true) }, quieto_min: 0, actividad_seg: 8, plan: true, builder_conectado: true, extras: 0, auditoria: null, eventos: [], correcciones_todas: [],
      tareas_todas: tt, aceptadas: ac, total: tot, avance: tot ? Math.round(ac / tot * 100) : null,
      cola: { tareas: tt.filter(function (t) { return t.estado === 'PENDIENTE'; }), por_aceptar: tt.filter(function (t) { return t.estado === 'HECHA_SIN_ACEPTAR'; }), devueltas: tt.filter(function (t) { return t.estado === 'DEVUELTA'; }), correcciones: [], decisiones_dueno: [] }, generado: new Date().toISOString() };
    for (var k in o) if (o[k] !== undefined && k !== 'tareas') base[k] = o[k];
    return base;
  }
  var T0 = [tarea('T-001', 'Login con roles', 'ACEPTADA'), tarea('T-002', 'Tablero de pacientes', 'ACEPTADA'), tarea('T-003', 'Agenda de citas', 'HECHA_SIN_ACEPTAR'), tarea('T-004', 'Facturación electrónica', 'PENDIENTE'), tarea('T-005', 'Reportes mensuales', 'PENDIENTE')];
  var ESCENARIOS = {
    apagado: function () { return null; },
    activar: function () { return demo({ canal: 'PREPARADO', plan: false, builder_conectado: false, roles: { director: role(false), builder: role(false) }, tareas: [] }); },
    plan: function () { return demo({ canal: 'PREPARADO', plan: true, builder_conectado: false, roles: { director: role(false), builder: role(false) }, tareas: [tarea('T-001', 'Login con roles', 'PENDIENTE'), tarea('T-002', 'Tablero de pacientes', 'PENDIENTE')] }); },
    constructor: function () { return demo({ roles: { director: role(false), builder: role(false, 1) }, semaforo: 'ROJO', alertas: [{ nivel: 'ROJO', msg: 'Constructor (Cursor): su vigilante NO está vivo y tiene trabajo esperando' }], tareas: [tarea('T-001', 'Login con roles', 'PENDIENTE'), tarea('T-002', 'Tablero de pacientes', 'PENDIENTE')] }); },
    vigilantes: function () { return demo({ roles: { director: role(true), builder: role(true, 1) }, tareas: [tarea('T-001', 'Login con roles', 'PENDIENTE'), tarea('T-002', 'Tablero de pacientes', 'PENDIENTE')] }); },
    trabajo: function () { return demo({ roles: { director: role(true, 1), builder: role(true, 1) }, tareas: T0 }); },
    auditoria: function () { return demo({ roles: { director: role(true, 1), builder: role(true, 1) }, auditoria: { id: 'T-003', desde: new Date().toISOString() }, tareas: T0 }); },
    celebrar: function () { var t = T0.map(function (x) { return x.id === 'T-003' ? tarea('T-003', 'Agenda de citas', 'ACEPTADA') : x; }); return demo({ roles: { director: role(true, 0), builder: role(true, 1) }, tareas: t }); },
    espera3: function () { var t = T0.map(function (x) { return tarea(x.id, x.titulo, 'ACEPTADA'); }); return demo({ actividad_seg: 200, roles: { director: role(true), builder: role(true) }, tareas: t }); },
    alarma: function () { return demo({ semaforo: 'ROJO', alertas: [{ nivel: 'ROJO', msg: 'Director (Claude Code): su vigilante NO está vivo' }, { nivel: 'ROJO', msg: 'Constructor (Cursor): su vigilante NO está vivo y tiene trabajo esperando' }], roles: { director: role(false, 1), builder: role(false, 1) }, tareas: T0 }); },
    parado: function () { var r = { director: role(true, 1), builder: role(true, 1) }; r.builder.sin_novedad = { n: 3, min: 9, pedido: 'D-001', umbral: 3, veredicto: 'PARADO', evidencia: 'ningún archivo tocado', empujon: 'Continúa con T-004' }; return demo({ semaforo: 'AMARILLO', alertas: [{ nivel: 'AMARILLO', msg: 'Constructor (Cursor): 3 rondas sin trabajo (~9 min)' }], roles: r, tareas: T0 }); },
    aviso: function () { return demo({ semaforo: 'AMARILLO', alertas: [{ nivel: 'AMARILLO', msg: 'Director (Claude Code): aviso sin atender hace 4 min' }], roles: { director: role(true, 1, 4), builder: role(true, 1) }, tareas: T0 }); },
    pausa: function () { return demo({ canal: 'PAUSADO', semaforo: 'PAUSADO', roles: { director: role(false), builder: role(false) }, tareas: T0 }); },
  };
  var RECORRIDO = [['apagado', 5], ['activar', 7], ['plan', 8], ['constructor', 8], ['vigilantes', 9], ['trabajo', 9], ['auditoria', 8], ['celebrar', 8], ['aviso', 6], ['espera3', 12], ['alarma', 9], ['pausa', 8]];
  function actor(a, tarea) { return { actores: [{ actor: a, tarea: tarea, activa: true, desde_seg: 60 }] }; }
  var ACT_SIM = { solo_claude: function () { return actor('claude', 'refactorizar el login'); }, solo_cursor: function () { return actor('cursor', 'corregir el formulario de citas'); } };
  ESCENARIOS.solo_claude = ESCENARIOS.solo_cursor = function () { return null; };
  var PRE = { celebrar: 'trabajo', vigilantes: 'constructor', aviso: 'trabajo', auditoria: 'trabajo' };
  window.mundoSimular = function (nombre, opc) {
    opc = opc || {}; var yaSim = !!sim;
    if (sim && sim.timers) sim.timers.forEach(clearTimeout);
    if (!nombre || nombre === 'real') { sim = null; cargado = false; estadoTarea = {}; var rr = window.__ultimoReal; aplicarDatos(rr ? rr.d : null, rr ? rr.j : null, rr ? rr.act : null); return; }
    sim = { nombre: nombre, timers: [] };
    if (!yaSim || opc.silencioso) { cargado = false; estadoTarea = {}; D = null; }
    function poner(n) { if (sim) aplicarDatos(ESCENARIOS[n](), null, ACT_SIM[n] ? ACT_SIM[n]() : null); }
    if (nombre === 'recorrido') { var acum = 0; RECORRIDO.forEach(function (st) { var n = st[0], dur = st[1]; sim.timers.push(setTimeout(function () { poner(n); }, acum * 1000)); acum += dur; }); sim.timers.push(setTimeout(function () { window.mundoSimular('real'); }, acum * 1000)); }
    else if (ESCENARIOS[nombre]) { if (!cargado && PRE[nombre]) poner(PRE[nombre]); poner(nombre); }
  };
  window.mundoEstado = function () {
    var cl = { k: 'clawd', x: +clawd.position.x.toFixed(2), z: +clawd.position.z.toFixed(2), estado: cw.estado };
    return ORDEN.map(function (k) { var p = P[k]; return { k: k, sitio: p.sitio ? p.sitio.id : null, destino: p.destino ? p.destino.id : null, sentado: p.sentado > 0.9, modo: p.modo, x: +p.raiz.position.x.toFixed(2), z: +p.raiz.position.z.toFixed(2), caminando: p.fase === 'caminando' }; })
      .concat(Object.keys(PERROS).map(function (k) { var f = PERROS[k]; return { k: 'perro_' + k, estado: f.estado, vivo: f.vivo }; })).concat([cl]);
  };
  window.mundoCamara = function () { return { vista: vista, yaw: ORB.yaw, pitch: ORB.pitch, dist: ORB.dist, zoom: ORB.zoom, tx: +ORB.tx.toFixed(3), ty: +ORB.ty.toFixed(3), tz: +ORB.tz.toFixed(3), siguiendo: seguir };
  };
  window.mundoPaso = function (seg) { var n = Math.max(1, Math.round((seg || 1) * 30)); for (var i = 0; i < n; i++) paso(1 / 30, i < n - 1); return window.mundoEstado(); };

  // ═════════ clic en objetos ═════════
  var rayo = new THREE.Raycaster(), vec = new THREE.Vector2();
  function pulsar(e) {
    var r = cv.getBoundingClientRect(); vec.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); rayo.setFromCamera(vec, camera);
    var hits = rayo.intersectObjects(scene.children, true);
    for (var i = 0; i < hits.length; i++) {
      var o = hits[i].object; while (o) {
        if (o.userData && o.userData.clic) { var c = o.userData.clic; if (c === 'clawd') clawdHabla(); else window.mundoIr(c); return; }
        if (o.userData && o.userData.perro) { var pf = PERROS[o.userData.perro]; decir(pf, pf.vivo ? '¡guau!' : 'zzz…', 2500); if (pf.vivo) pf.comiendo = 0.6; return; }
        if (o.userData && o.userData.persona) { var pp = P[o.userData.persona]; decir(pp, pp.etqTxt.split('|')[1] || '', 3000); return; }
        o = o.parent;
      }
    }
  }

  var etiquetas = null;
  function etiquetasEscala() {
    if (!etiquetas) { etiquetas = []; ORDEN.forEach(function (k) { etiquetas.push([P[k].tag, P[k].tag.scale.x, P[k].tag.scale.y, P[k].raiz]); }); Object.keys(PERROS).forEach(function (k) { etiquetas.push([PERROS[k].tag, PERROS[k].tag.scale.x, PERROS[k].tag.scale.y, PERROS[k].raiz]); }); etiquetas.push([clawdTag, clawdTag.scale.x, clawdTag.scale.y, clawd]); }
    etiquetas.forEach(function (e) { var k = camera === camP ? Math.max(0.3, Math.min(1, camP.position.distanceTo(e[3].position) / 15)) : 1; e[0].scale.set(e[1] * k, e[2] * k, 1); });
  }
  // ═════════ bucle ═════════
  var reloj = new THREE.Clock(), vivo = true, tAcum = 0, tDec = 0, tFlujo = 0, tTV = 0, tMon = 0, cuerpoTs = 0;
  document.addEventListener('visibilitychange', function () { vivo = !document.hidden; if (vivo) { reloj.getDelta(); bucle(); } });
  function bucle() { if (!vivo) return; requestAnimationFrame(bucle); paso(Math.min(reloj.getDelta(), 0.1)); }
  function paso(dt, sinDibujar) {
    tAcum += dt; var t = tAcum;
    if (vuelo) { vuelo.t += dt / vuelo.dur; var kk = Math.min(1, vuelo.t), ee = kk < 0.5 ? 2 * kk * kk : 1 - Math.pow(-2 * kk + 2, 2) / 2; ['yaw', 'pitch', 'dist', 'zoom', 'tx', 'ty', 'tz'].forEach(function (n) { if (vuelo.hasta[n] !== undefined) ORB[n] = lerp(vuelo.desde[n], vuelo.hasta[n], ee); }); aplicarCamara(); if (kk >= 1) { vuelo = null; marcarBotones(); } }
    if (seguir) { var ps = posSeguida(), kf = Math.min(1, dt * 3.5); ORB.tx += (ps.x - ORB.tx) * kf; ORB.ty += (1.15 - ORB.ty) * kf; ORB.tz += (ps.z - ORB.tz) * kf; ORB.dist += (seguirDist - ORB.dist) * Math.min(1, dt * 2.5); if (ORB.pitch > 0.7) ORB.pitch += (0.5 - ORB.pitch) * Math.min(1, dt * 1.2); aplicarCamara(); }
    tDec += dt; if (tDec > 1) { tDec = 0; decidir(); }
    ORDEN.forEach(function (k) {
      var p = P[k]; moverPersona(p, dt); animar(p, dt, t);
      var it = intrP[k]; if (it) {
        if (p.sitio === it.sitio && p.fase === 'parado') { it.llegado += dt; if (!it.hecho && it.alLlegar && it.llegado > 0.7) { it.hecho = true; it.alLlegar(); } if (it.llegado >= it.dur) { delete intrP[k]; decidir(); } }
      }
    });
    Object.keys(PERROS).forEach(function (k) { animarPerro(PERROS[k], dt, t); });
    // el perro come la galleta cuando llega
    for (var i = vuelos.length - 1; i >= 0; i--) {
      var v = vuelos[i]; v.t += dt / v.dur; var q = Math.min(1, v.t);
      v.m.position.x = lerp(v.a.x, v.b.x, q); v.m.position.z = lerp(v.a.z, v.b.z, q);
      if (v.galleta) { v.m.position.y = lerp(v.y0, v.y1, q) + Math.sin(q * Math.PI) * 0.4; } else { v.m.position.y = 2.3 + Math.sin(q * Math.PI) * 1.4; v.m.rotation.y = q * 6; }
      if (q >= 1) { if (v.galleta && v.perro) { v.perro.comiendo = 1.4; if (v.perro.vivo && v.perro.estado === 'despertando') v.perro.espera = 0.4; } scene.remove(v.m); vuelos.splice(i, 1); }
    }
    confeti.forEach(function (c) { if (c.vida > 0) { c.vida -= dt; c.v.y -= 9 * dt; c.m.position.addScaledVector(c.v, dt); c.m.rotation.x += dt * 8; c.m.rotation.z += dt * 6; if (c.m.position.y < 0.05) { c.m.position.y = 0.05; c.v.set(0, 0, 0); } if (c.vida <= 0) c.m.visible = false; } });
    clawdPaso(dt, t);
    etiquetasEscala();
    // pantallas
    tMon += dt; if (tMon > 0.16) { tMon = 0; Object.keys(monitores).forEach(function (k) { monitores[k].forEach(function (o) { if (o.modo === 'code' || o.sucio) { pintarMonitor(o, t, k); o.sucio = false; } }); }); }
    tTV += dt; if (tTV > 0.1) { tTV = 0; var jug = !!(ocupados.sofa0 || ocupados.sofa1) && (P[ocupados.sofa0 || ocupados.sofa1] && P[ocupados.sofa0 || ocupados.sofa1].sentado > 0.9); pintarTV(t, jug); }
    tFlujo += dt; if (tFlujo > 0.2) { tFlujo = 0; pintarFlujo(D, t); }
    pintarReloj();
    if (!sinDibujar) renderer.render(scene, camera);
  }
  tamano(); marcarBotones(); decidir(); pintarPizarra(null); pintarSemaforo(null); pintarFlujo(null, 0); pintarReloj();
  teletransportar();
  bucle();
})();
