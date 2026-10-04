/* Oficina TEAMS en 3D (low-poly). Solo lectura: se alimenta de /api/v1/teams (window.mundoActualizar(data)).
   Director + 3 sub-agentes + constructor (Cursor) como personajes que reflejan el estado REAL:
   trabajando (con cola/entregas), sentados esperando (< 3 min), y a los 3 min sin trabajo se levantan e interactúan.
   Los «perros» son los vigilantes: despiertos si el proceso está vivo, dormidos (zzz) si no. */
(function () {
  'use strict';
  var cont = document.getElementById('escena');
  if (!cont || typeof THREE === 'undefined') { var c0 = document.getElementById('mundo'); if (c0) c0.style.display = 'none'; return; }
  var ESPERA_MS = 180000;      // a los 3 min sin trabajo se levantan e interactúan
  var sim = null;              // null = datos reales; o { modo, desde }

  // ───────── renderer / escena / cámara ─────────
  var renderer;
  try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false }); } catch (e) { var c1 = document.getElementById('mundo'); if (c1) { c1.querySelector('.nota3d').textContent = 'Tu navegador no pudo iniciar WebGL: la vista 3D no está disponible (los datos de abajo sí).'; cont.style.display = 'none'; } return; }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6));
  cont.appendChild(renderer.domElement);
  renderer.domElement.style.display = 'block'; renderer.domElement.style.width = '100%'; renderer.domElement.style.height = '100%'; renderer.domElement.style.cursor = 'grab';
  var scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d1626);
  scene.fog = new THREE.Fog(0x0d1626, 26, 52);
  var camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  var orb = { yaw: 0.55, pitch: 0.6, dist: 17.5, tx: 0, ty: 1.2, tz: -0.2 };
  function ponerCamara() {
    var cp = Math.cos(orb.pitch);
    camera.position.set(orb.tx + Math.sin(orb.yaw) * cp * orb.dist, orb.ty + Math.sin(orb.pitch) * orb.dist, orb.tz + Math.cos(orb.yaw) * cp * orb.dist);
    camera.lookAt(orb.tx, orb.ty, orb.tz);
  }
  function tamano() {
    var w = cont.clientWidth || 600, h = cont.clientHeight || 380;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  if (window.ResizeObserver) new ResizeObserver(tamano).observe(cont); else window.addEventListener('resize', tamano);

  // arrastrar = girar, rueda = zoom, doble clic = reiniciar
  var arr = null, ultimoTouch = 0;
  renderer.domElement.addEventListener('pointerdown', function (e) { arr = { x: e.clientX, y: e.clientY }; renderer.domElement.style.cursor = 'grabbing'; ultimoTouch = Date.now(); });
  window.addEventListener('pointerup', function () { arr = null; renderer.domElement.style.cursor = 'grab'; });
  window.addEventListener('pointermove', function (e) { if (!arr) return; orb.yaw -= (e.clientX - arr.x) * 0.006; orb.pitch = Math.max(0.2, Math.min(1.3, orb.pitch + (e.clientY - arr.y) * 0.005)); arr = { x: e.clientX, y: e.clientY }; ultimoTouch = Date.now(); });
  renderer.domElement.addEventListener('wheel', function (e) { e.preventDefault(); orb.dist = Math.max(8, Math.min(34, orb.dist + e.deltaY * 0.02)); ultimoTouch = Date.now(); }, { passive: false });
  renderer.domElement.addEventListener('dblclick', function () { orb.yaw = 0.55; orb.pitch = 0.6; orb.dist = 17.5; });

  // ───────── luces ─────────
  scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x2a3350, 0.95));
  var sol = new THREE.DirectionalLight(0xfff1d6, 0.85); sol.position.set(-8, 16, 10); scene.add(sol);

  // ───────── utilidades ─────────
  var mats = {};
  function mat(color, opts) { var k = color + (opts && opts.e ? 'e' + opts.e : ''); if (!mats[k]) mats[k] = new THREE.MeshStandardMaterial(Object.assign({ color: color, flatShading: true, roughness: 0.85, metalness: 0.05 }, opts && opts.e ? { emissive: color, emissiveIntensity: opts.e } : {})); return mats[k]; }
  function caja(w, h, d, color, x, y, z, padre, opts) { var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color, opts)); m.position.set(x || 0, y || 0, z || 0); (padre || scene).add(m); return m; }
  function texto(ctx, t, x, y, max) { ctx.fillText(t.length > max ? t.slice(0, max - 1) + '…' : t, x, y); }
  function lienzo(w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function sprite(canvas, ancho) { var t = new THREE.CanvasTexture(canvas); t.minFilter = THREE.LinearFilter; var s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: false })); s.scale.set(ancho, ancho * canvas.height / canvas.width, 1); s.renderOrder = 10; s._canvas = canvas; s._tex = t; return s; }

  // ───────── suelo, paredes, ventanas ─────────
  (function () {
    var c = lienzo(256, 256), g = c.getContext('2d');
    for (var i = 0; i < 8; i++) for (var j = 0; j < 8; j++) { g.fillStyle = (i + j) % 2 ? '#26334f' : '#2d3b5c'; g.fillRect(i * 32, j * 32, 32, 32); }
    var tx = new THREE.CanvasTexture(c); tx.wrapS = tx.wrapT = THREE.RepeatWrapping; tx.repeat.set(5.5, 4); tx.magFilter = THREE.NearestFilter;
    var suelo = new THREE.Mesh(new THREE.BoxGeometry(22, 0.4, 16), new THREE.MeshStandardMaterial({ map: tx, flatShading: true, roughness: 1 }));
    suelo.position.set(0, -0.2, 0); scene.add(suelo);
    caja(22.4, 0.5, 16.4, 0x16203a, 0, -0.55, 0);
    caja(22, 6, 0.4, 0x3a4a73, 0, 3, -8.2);             // pared del fondo
    caja(0.4, 6, 16, 0x33426a, -11.2, 3, 0);            // pared izquierda
    for (var k = 0; k < 4; k++) caja(2.2, 2.2, 0.1, 0x9fd0ff, -7.5 + k * 3.4, 3.4, -7.95, null, { e: 0.35 });   // ventanas
    for (var k2 = 0; k2 < 3; k2++) caja(0.1, 2.2, 2.2, 0x9fd0ff, -10.95, 3.4, -4.5 + k2 * 4.2, null, { e: 0.35 });
    // cartel
    var cl = lienzo(512, 128), gl = cl.getContext('2d'); gl.fillStyle = '#0f1830'; gl.fillRect(0, 0, 512, 128);
    gl.fillStyle = '#7cc4ff'; gl.font = 'bold 52px sans-serif'; gl.textAlign = 'center'; gl.fillText('AGENTIX · TEAMS', 256, 62);
    gl.fillStyle = '#8A97A6'; gl.font = '24px sans-serif'; gl.fillText('agencia de desarrollo', 256, 102);
    var cartel = new THREE.Mesh(new THREE.PlaneGeometry(6, 1.5), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cl) })); cartel.position.set(-3.2, 5.0, -7.95); scene.add(cartel);
  })();

  // ───────── muebles ─────────
  function escritorio(x, z, giro, nMon) {
    var g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = giro || 0; scene.add(g);
    caja(3.2, 0.14, 1.5, 0x8a6a46, 0, 1.05, 0, g);
    caja(0.14, 1.0, 1.3, 0x5b4630, -1.5, 0.5, 0, g); caja(0.14, 1.0, 1.3, 0x5b4630, 1.5, 0.5, 0, g);
    var pantallas = [];
    for (var i = 0; i < nMon; i++) {
      var px = nMon === 1 ? 0 : (i - (nMon - 1) / 2) * 1.15;
      caja(1.0, 0.65, 0.07, 0x10131c, px, 1.65, -0.4, g);
      var pant = caja(0.9, 0.55, 0.05, 0x2f6cff, px, 1.65, -0.36, g, { e: 0.5 }); pantallas.push(pant);
      caja(0.1, 0.3, 0.1, 0x10131c, px, 1.3, -0.4, g);
    }
    caja(0.9, 0.04, 0.35, 0x1a1d28, 0, 1.14, 0.2, g);   // teclado
    return { g: g, pantallas: pantallas };
  }
  function silla(x, z, giro) { var g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = giro || 0; scene.add(g); caja(0.7, 0.1, 0.7, 0x2a2f3f, 0, 0.62, 0, g); caja(0.7, 0.75, 0.1, 0x2a2f3f, 0, 1.0, 0.33, g); caja(0.1, 0.6, 0.1, 0x1a1d28, 0, 0.3, 0, g); caja(0.6, 0.06, 0.6, 0x1a1d28, 0, 0.05, 0, g); return g; }
  var escDir = escritorio(0, -5.6, 0, 2);
  var escCons = escritorio(7, -3.2, -Math.PI / 2 * 0.0, 2); escCons.g.rotation.y = -0.3;
  // mesa de auditoría de los sub-agentes
  var mesaAud = new THREE.Group(); mesaAud.position.set(-6.6, 0, -1.8); scene.add(mesaAud);
  caja(5.6, 0.14, 1.5, 0x9a7a52, 0, 1.05, 0, mesaAud); caja(0.14, 1.0, 1.2, 0x5b4630, -2.6, 0.5, 0, mesaAud); caja(0.14, 1.0, 1.2, 0x5b4630, 2.6, 0.5, 0, mesaAud);
  var portatiles = [];
  [-1.9, 0, 1.9].forEach(function (px) { caja(0.8, 0.05, 0.55, 0x1a1d28, px, 1.14, 0.12, mesaAud); var pn = caja(0.8, 0.5, 0.05, 0x2f6cff, px, 1.4, -0.14, mesaAud, { e: 0.5 }); pn.rotation.x = -0.15; portatiles.push(pn); });
  // sala de descanso
  var sofa = new THREE.Group(); sofa.position.set(1.5, 0, 5.0); scene.add(sofa);
  caja(3.6, 0.5, 1.2, 0xc2548b, 0, 0.45, 0, sofa); caja(3.6, 0.8, 0.3, 0xa8447a, 0, 0.95, -0.55, sofa); caja(0.3, 0.7, 1.2, 0xa8447a, -1.65, 0.7, 0, sofa); caja(0.3, 0.7, 1.2, 0xa8447a, 1.65, 0.7, 0, sofa);
  caja(1.4, 0.1, 0.8, 0xd9c7a0, 1.5, 0.45, 3.6);
  var cafetera = new THREE.Group(); cafetera.position.set(-4.4, 0, 5.4); scene.add(cafetera);
  caja(0.9, 1.0, 0.8, 0x3d3f47, 0, 0.5, 0, cafetera); caja(0.9, 0.7, 0.8, 0x6b6d78, 0, 1.35, 0, cafetera); caja(0.35, 0.2, 0.3, 0xff6a3d, 0, 0.95, 0.42, cafetera, { e: 0.6 });
  [[-9.5, 6.4], [9.8, 6.0], [10, -6.6], [-3.1, -7.2]].forEach(function (p) { caja(0.6, 0.5, 0.6, 0x7a4b2e, p[0], 0.25, p[1]); var h = new THREE.Mesh(new THREE.IcosahedronGeometry(0.55, 0), mat(0x3ccf7d)); h.position.set(p[0], 0.95, p[1]); scene.add(h); });
  // alfombra del descanso
  var alf = caja(6.5, 0.04, 4.2, 0x3d4f86, 0, 0.02, 4.6);

  // ───────── pizarra + semáforo ─────────
  var lienzoPz = lienzo(512, 320), ctxPz = lienzoPz.getContext('2d');
  var texPz = new THREE.CanvasTexture(lienzoPz);
  var pizarra = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 2.9), new THREE.MeshBasicMaterial({ map: texPz })); pizarra.position.set(5.6, 3.1, -7.95); scene.add(pizarra);
  caja(4.9, 3.2, 0.08, 0xe9e6dc, 5.6, 3.1, -8.02);
  var luzSem = new THREE.Mesh(new THREE.SphereGeometry(0.42, 8, 6), new THREE.MeshStandardMaterial({ color: 0x3fe2e8, emissive: 0x3fe2e8, emissiveIntensity: 0.9, flatShading: true }));
  luzSem.position.set(-0.2, 4.9, -7.8); scene.add(luzSem); caja(1.1, 0.25, 0.3, 0x10131c, -0.2, 4.35, -7.85);
  function pintarPizarra(d) {
    var g = ctxPz; g.fillStyle = '#f4f1e8'; g.fillRect(0, 0, 512, 320);
    g.fillStyle = '#1b2a4a'; g.font = 'bold 30px sans-serif'; g.textAlign = 'left'; g.fillText('TEAMS · avance', 20, 42);
    g.fillStyle = '#d6d2c4'; g.fillRect(20, 58, 472, 20);
    var av = d && d.avance != null ? d.avance : 0; g.fillStyle = '#17b3b9'; g.fillRect(20, 58, 472 * av / 100, 20);
    g.fillStyle = '#1b2a4a'; g.font = '20px sans-serif'; g.fillText(d ? (av + ' %  (' + d.aceptadas + ' de ' + d.total + ' aceptadas)') : 'sin datos', 20, 108);
    g.font = 'bold 22px sans-serif'; g.fillStyle = '#b25d00'; g.fillText('EN COLA', 20, 144);
    g.font = '19px sans-serif'; g.fillStyle = '#1b2a4a';
    var cola = d ? d.cola.tareas.slice(0, 3) : []; for (var i = 0; i < cola.length; i++) texto(g, cola[i].id + ' ' + cola[i].titulo, 20, 170 + i * 24, 42);
    if (!cola.length) g.fillText('— vacía —', 20, 170);
    g.font = 'bold 22px sans-serif'; g.fillStyle = '#0a7a46'; g.fillText('POR ACEPTAR', 20, 256);
    g.font = '19px sans-serif'; g.fillStyle = '#1b2a4a';
    var pa = d ? d.cola.por_aceptar.slice(0, 2) : []; for (var j = 0; j < pa.length; j++) texto(g, pa[j].id + ' ' + pa[j].titulo, 20, 282 + j * 24, 42);
    if (!pa.length) g.fillText('— nada esperando al Director —', 20, 282);
    texPz.needsUpdate = true;
  }

  // ───────── personajes ─────────
  function personaje(nombre, color, pelo, extra) {
    var raiz = new THREE.Group(); raiz.scale.setScalar(1.45); scene.add(raiz);
    var cuerpo = new THREE.Group(); raiz.add(cuerpo);
    var piel = 0xf1c9a5;
    var torso = caja(0.55, 0.65, 0.32, color, 0, 1.15, 0, cuerpo);
    var cabeza = new THREE.Group(); cabeza.position.set(0, 1.78, 0); cuerpo.add(cabeza);
    var craneo = new THREE.Mesh(new THREE.IcosahedronGeometry(0.27, 0), mat(piel)); cabeza.add(craneo);
    caja(0.56, 0.14, 0.5, pelo, 0, 0.2, -0.02, cabeza);
    caja(0.07, 0.07, 0.04, 0x1a1d28, -0.1, 0.03, 0.25, cabeza); caja(0.07, 0.07, 0.04, 0x1a1d28, 0.1, 0.03, 0.25, cabeza);
    if (extra === 'corbata') caja(0.09, 0.4, 0.05, 0xffc933, 0, 1.15, 0.17, cuerpo);
    if (extra === 'capucha') caja(0.6, 0.14, 0.36, color, 0, 1.52, -0.04, cuerpo);
    if (extra === 'gafas') { caja(0.26, 0.09, 0.04, 0x10131c, -0.1, 0.05, 0.27, cabeza); caja(0.26, 0.09, 0.04, 0x10131c, 0.1, 0.05, 0.27, cabeza); }
    function brazo(x) { var p = new THREE.Group(); p.position.set(x, 1.42, 0); cuerpo.add(p); caja(0.17, 0.6, 0.17, color, 0, -0.28, 0, p); caja(0.17, 0.17, 0.17, piel, 0, -0.62, 0, p); return p; }
    function pierna(x) { var p = new THREE.Group(); p.position.set(x, 0.8, 0); cuerpo.add(p); caja(0.2, 0.5, 0.2, 0x2b3350, 0, -0.25, 0, p); caja(0.22, 0.12, 0.3, 0x14171f, 0, -0.55, 0.05, p); return p; }
    var bI = brazo(-0.38), bD = brazo(0.38), pI = pierna(-0.14), pD = pierna(0.14);
    // sombra falsa
    var sh = new THREE.Mesh(new THREE.CircleGeometry(0.5, 10), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28 })); sh.rotation.x = -Math.PI / 2; sh.position.y = 0.03; raiz.add(sh);
    // etiqueta y bocadillo
    var et = lienzo(256, 64), ge = et.getContext('2d'); ge.fillStyle = 'rgba(10,14,26,0.82)'; ge.fillRect(0, 0, 256, 64); ge.fillStyle = '#fff'; ge.font = 'bold 28px sans-serif'; ge.textAlign = 'center'; ge.fillText(nombre, 128, 42);
    var spEt = sprite(et, 1.7); spEt.position.set(0, 2.55, 0); raiz.add(spEt);
    var bo = lienzo(384, 96), spBo = sprite(bo, 2.9); spBo.position.set(0, 3.3, 0); spBo.visible = false; raiz.add(spBo);
    return { nombre: nombre, raiz: raiz, cuerpo: cuerpo, cabeza: cabeza, bI: bI, bD: bD, pI: pI, pD: pD, bocadillo: spBo, bocadilloCanvas: bo, bocadilloHasta: 0, etiqueta: spEt, sombra: sh,
      estado: 'espera', pose: 'stand', sentadoK: 0, destino: null, caminando: false, idleDesde: Date.now(), charlaProx: 0, fase: Math.random() * 6 };
  }
  var P = {
    director: personaje('Director', 0x2f4ea8, 0x2a1d12, 'corbata'),
    fe: personaje('UI/UX', 0xe8579e, 0x7a2f1a, 'gafas'),
    be: personaje('Backend', 0x2fb36a, 0x1a1a1a, null),
    neg: personaje('Negocio', 0xf28c28, 0xd9b04a, null),
    cons: personaje('Cursor', 0x14b8c4, 0x101820, 'capucha')
  };
  // puestos: dónde se sienta cada uno
  var PUESTO = {
    director: { x: 0, z: -4.75, giro: Math.PI, silla: [0, -4.5] },
    fe: { x: -8.5, z: -1.2, giro: 0, silla: null }, be: { x: -6.6, z: -1.2, giro: 0 }, neg: { x: -4.7, z: -1.2, giro: 0 },
    cons: { x: 7.0, z: -2.0, giro: Math.PI + 0.3 }
  };
  silla(0, -4.55, 0); silla(7.1, -2.25, 0.3 + Math.PI * 0); [-8.5, -6.6, -4.7].forEach(function (x) { silla(x, -0.4, Math.PI); });
  var DESCANSO = [{ x: -5.2, z: 4.4 }, { x: -2.6, z: 3.2 }, { x: 0.4, z: 4.9 }, { x: 3.4, z: 3.3 }, { x: 6.0, z: 4.6 }];
  Object.keys(P).forEach(function (k) { var p = P[k], pu = PUESTO[k]; p.raiz.position.set(pu.x, 0, pu.z); p.raiz.rotation.y = pu.giro; p.estado = 'espera'; p.pose = 'sit'; p.sentadoK = 1; });

  // perros vigilantes
  function perro(x, z, color) {
    var g = new THREE.Group(); g.position.set(x, 0, z); scene.add(g);
    var cu = caja(0.9, 0.38, 0.4, color, 0, 0.4, 0, g); var ca = new THREE.Group(); ca.position.set(0.55, 0.62, 0); g.add(ca);
    caja(0.38, 0.34, 0.34, color, 0, 0, 0, ca); caja(0.18, 0.12, 0.2, 0x2a1d12, 0.22, -0.06, 0, ca); caja(0.1, 0.2, 0.08, 0x2a1d12, -0.02, 0.2, 0.14, ca); caja(0.1, 0.2, 0.08, 0x2a1d12, -0.02, 0.2, -0.14, ca);
    var cola = new THREE.Group(); cola.position.set(-0.5, 0.55, 0); g.add(cola); caja(0.42, 0.1, 0.1, color, -0.2, 0.05, 0, cola);
    [[-0.3, 0.15], [-0.3, -0.15], [0.3, 0.15], [0.3, -0.15]].forEach(function (p) { caja(0.1, 0.25, 0.1, color, p[0], 0.12, p[1], g); });
    var zz = lienzo(128, 64), gz = zz.getContext('2d'); gz.fillStyle = '#9fd0ff'; gz.font = 'bold 44px sans-serif'; gz.fillText('z Z z', 6, 46); var sz = sprite(zz, 1.1); sz.position.set(0.6, 1.5, 0); g.add(sz);
    return { g: g, ca: ca, cola: cola, zz: sz, vivo: true, fase: Math.random() * 6 };
  }
  var perros = { director: perro(1.9, -4.9, 0xc99a5b), cons: perro(5.2, -1.4, 0xb7b7c2) };

  // partículas de celebración
  var conf = { pts: null, vel: [], vida: 0 };
  (function () { var g = new THREE.BufferGeometry(); var n = 90; var pos = new Float32Array(n * 3), col = new Float32Array(n * 3); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3)); conf.pts = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.28, vertexColors: true })); conf.pts.visible = false; scene.add(conf.pts); conf.n = n; })();
  function celebrar() {
    var pos = conf.pts.geometry.attributes.position, col = conf.pts.geometry.attributes.color; conf.vel = [];
    var cols = [[1, 0.8, 0.2], [0.3, 0.9, 0.9], [1, 0.4, 0.7], [0.5, 1, 0.5]];
    for (var i = 0; i < conf.n; i++) { pos.setXYZ(i, (Math.random() - 0.5) * 3, 3 + Math.random() * 1.5, -3 + Math.random() * 2); conf.vel.push([(Math.random() - 0.5) * 3, 2 + Math.random() * 4, (Math.random() - 0.5) * 3]); var c = cols[i % 4]; col.setXYZ(i, c[0], c[1], c[2]); }
    pos.needsUpdate = true; col.needsUpdate = true; conf.pts.visible = true; conf.vida = 2.2;
    ['director', 'cons'].forEach(function (k) { P[k].salto = 1.0; decir(P[k], '¡Aceptada! 🎉', 3500); });
  }

  // ───────── bocadillos y conducta ─────────
  function decir(p, txt, ms) {
    var c = p.bocadilloCanvas, g = c.getContext('2d'); g.clearRect(0, 0, 384, 96);
    g.fillStyle = 'rgba(255,255,255,0.96)'; g.strokeStyle = '#1b2a4a'; g.lineWidth = 4;
    g.beginPath(); g.moveTo(14, 6); g.lineTo(370, 6); g.quadraticCurveTo(378, 6, 378, 14); g.lineTo(378, 62); g.quadraticCurveTo(378, 70, 370, 70); g.lineTo(210, 70); g.lineTo(192, 90); g.lineTo(176, 70); g.lineTo(14, 70); g.quadraticCurveTo(6, 70, 6, 62); g.lineTo(6, 14); g.quadraticCurveTo(6, 6, 14, 6); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = '#1b2a4a'; g.font = 'bold 26px sans-serif'; g.textAlign = 'center'; var t = String(txt); if (t.length > 26) t = t.slice(0, 25) + '…'; g.fillText(t, 192, 48);
    p.bocadillo._tex.needsUpdate = true; p.bocadillo.visible = true; p.bocadilloHasta = ms ? Date.now() + ms : 0; p.bocadilloTxt = txt;
  }
  var FRASES = ['¿un café? ☕', '¿viste ese diff?', 'tsc en verde 🙌', 'esperando tareas…', '¿qué sigue, jefe?', 'ese bug era mío 😅', '¡ping pong!', 'mi parte ya salió', 'cuando quieras 👍', 'el vigilante vigila 🐶', 'más café…', '¿y si lo hacemos mejor?'];
  var D = null;                 // últimos datos
  var objetivo = { director: 'espera', fe: 'espera', be: 'espera', neg: 'espera', cons: 'espera' };
  var textoTrab = { director: '', fe: 'Auditando UI/UX', be: 'Auditando backend', neg: 'Revisando negocio', cons: '' };
  var durmiendo = { director: false, cons: false };
  var ultimaAceptadas = null;

  function mapear(d) {
    if (sim) { var t = sim.modo; var w = t === 'trabajo'; objetivo = { director: w ? 'trabajo' : 'espera', fe: w ? 'trabajo' : 'espera', be: w ? 'trabajo' : 'espera', neg: w ? 'trabajo' : 'espera', cons: w ? 'trabajo' : 'espera' };
      durmiendo = { director: t === 'alarma', cons: t === 'alarma' }; perros.director.vivo = t !== 'alarma'; perros.cons.vivo = t !== 'alarma'; textoTrab.director = 'Revisando T-019'; textoTrab.cons = 'Construyendo T-020…';
      if (t === 'espera3') { Object.keys(P).forEach(function (k) { if (P[k].idleDesde > Date.now() - ESPERA_MS) P[k].idleDesde = Date.now() - ESPERA_MS - 1000; }); }
      return; }
    if (!d) return;
    var cola = d.cola, trabajoCons = cola.tareas.length > 0 || cola.correcciones.length > 0;
    var revisando = cola.por_aceptar.length > 0 || cola.devueltas.length > 0;
    var rolD = d.roles.director, rolB = d.roles.builder;
    var activo = d.canal === 'ACTIVO';
    objetivo.cons = activo && trabajoCons ? 'trabajo' : 'espera';
    objetivo.director = activo && (revisando || (rolD.ultima_ronda_hace_min !== null && rolD.ultima_ronda_hace_min <= 1 && cola.tareas.length > 0)) ? 'trabajo' : 'espera';
    ['fe', 'be', 'neg'].forEach(function (k) { objetivo[k] = activo && revisando ? 'trabajo' : 'espera'; });
    textoTrab.director = cola.por_aceptar.length ? 'Revisando ' + cola.por_aceptar[0].id : (cola.devueltas.length ? 'Decidiendo ' + cola.devueltas[0].id : 'Dirigiendo');
    textoTrab.cons = cola.correcciones.length ? 'Corrigiendo ' + cola.correcciones[0].id : (cola.tareas.length ? 'Construyendo ' + cola.tareas[0].id : '');
    durmiendo.director = activo && d.modo !== 'individual' && !rolD.vigilante.vivo && ((rolD.aviso_sin_atender_min || 0) >= 3 || rolD.pendiente > 0);
    durmiendo.cons = activo && d.modo !== 'individual' && !rolB.vigilante.vivo && ((rolB.aviso_sin_atender_min || 0) >= 3 || rolB.pendiente > 0);
    if (ultimaAceptadas !== null && d.aceptadas > ultimaAceptadas) celebrar();
    ultimaAceptadas = d.aceptadas;
  }

  window.mundoActualizar = function (d, j) {
    D = d; mapear(d);
    pintarPizarra(d);
    if (d) {
      var col = d.semaforo === 'VERDE' ? 0x3fe2e8 : d.semaforo === 'AMARILLO' ? 0xd9a33c : d.semaforo === 'ROJO' ? 0xff4d4d : 0x7f8aa3;
      luzSem.material.color.setHex(col); luzSem.material.emissive.setHex(col);
      if (!sim) { perros.director.vivo = !!d.roles.director.vigilante.vivo; perros.cons.vivo = !!d.roles.builder.vigilante.vivo; }
      var n = document.getElementById('nota3d'); if (n) n.textContent = 'Semáforo ' + d.semaforo + ' · canal ' + d.canal + (j && j.stale ? ' · (dato viejo)' : '') + (sim ? ' · SIMULACIÓN' : '');
    }
  };

  // ───────── bucle ─────────
  var reloj = new THREE.Clock(), vivo = true;
  document.addEventListener('visibilitychange', function () { vivo = !document.hidden; if (vivo) { reloj.getDelta(); bucle(); } });
  function haciaAngulo(a, b, k) { var d = ((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI; return a + d * Math.min(1, k); }
  function irA(p, x, z) { p.destino = { x: x, z: z }; }
  var lastBub = 0;

  function actualizarPersonaje(k, p, t, dt) {
    var pu = PUESTO[k], ahora = Date.now();
    var trab = objetivo[k] === 'trabajo', dorm = (k === 'director' || k === 'cons') && durmiendo[k];
    var estadoNuevo = dorm ? 'sueno' : (trab ? 'trabajo' : 'espera');
    if (estadoNuevo !== p.estado) {
      p.estado = estadoNuevo;
      if (estadoNuevo === 'espera') p.idleDesde = (sim && sim.modo === 'espera3') ? ahora - ESPERA_MS - 1000 : ahora;
      if (estadoNuevo === 'trabajo') { p.destino = { x: pu.x, z: pu.z, sentar: true }; var tx = textoTrab[k]; if (tx) decir(p, tx, 4500); }
      if (estadoNuevo === 'sueno') { p.destino = { x: pu.x, z: pu.z, sentar: true }; decir(p, '💤 sin vigilante', 0); }
      if (estadoNuevo !== 'sueno' && p.bocadilloTxt === '💤 sin vigilante') p.bocadillo.visible = false;
    }
    var idleMs = ahora - p.idleDesde, charlando = p.estado === 'espera' && idleMs >= ESPERA_MS;
    // a los 3 min sin trabajo: se levantan y van al descanso a charlar
    if (charlando && !p.enDescanso) { p.enDescanso = true; var s = DESCANSO[Object.keys(P).indexOf(k) % DESCANSO.length]; irA(p, s.x + (Math.random() - 0.5) * 0.4, s.z + (Math.random() - 0.5) * 0.4); p.charlaProx = ahora + 1500 + Math.random() * 3000; }
    if (!charlando && p.enDescanso) { p.enDescanso = false; p.destino = { x: pu.x, z: pu.z, sentar: p.estado !== 'trabajo' ? true : true }; }
    if (p.estado === 'espera' && !charlando && p.destino === null && p.pose !== 'sit') p.destino = { x: pu.x, z: pu.z, sentar: true };
    // movimiento
    var caminando = false;
    if (p.destino) {
      var dx = p.destino.x - p.raiz.position.x, dz = p.destino.z - p.raiz.position.z, dist = Math.sqrt(dx * dx + dz * dz);
      if (p.sentadoK > 0.02 && dist > 0.12) { p.sentadoK = Math.max(0, p.sentadoK - dt * 3.2); caminando = false; }
      else if (dist > 0.12) { caminando = true; var v = 2.4 * dt; p.raiz.position.x += dx / dist * Math.min(v, dist); p.raiz.position.z += dz / dist * Math.min(v, dist); p.raiz.rotation.y = haciaAngulo(p.raiz.rotation.y, Math.atan2(dx, dz), dt * 8); }
      else { if (p.destino.sentar) { p.raiz.rotation.y = haciaAngulo(p.raiz.rotation.y, pu.giro, dt * 8); p.sentadoK = Math.min(1, p.sentadoK + dt * 3.2); if (p.sentadoK >= 0.99) p.destino = null; } else p.destino = null; }
    }
    // charla: de cara a otro que también esté en el descanso
    if (charlando && !p.destino) {
      var otros = Object.keys(P).filter(function (o) { return o !== k && P[o].enDescanso; });
      if (otros.length) { var q = P[otros[0]]; p.raiz.rotation.y = haciaAngulo(p.raiz.rotation.y, Math.atan2(q.raiz.position.x - p.raiz.position.x, q.raiz.position.z - p.raiz.position.z), dt * 4); }
      if (ahora > p.charlaProx) { decir(p, FRASES[Math.floor(Math.random() * FRASES.length)], 3800); p.charlaProx = ahora + 5000 + Math.random() * 6000; p.gesto = ahora + 1800; }
    }
    // pose
    var s = p.sentadoK; p.cuerpo.position.y = -0.42 * s + (p.salto ? Math.abs(Math.sin(p.salto * Math.PI * 3)) * 0.5 : 0);
    p.cuerpo.position.z = 0.12 * s;
    var camina = caminando ? Math.sin(t * 9 + p.fase) : 0;
    p.pI.rotation.x = -1.45 * s + camina * 0.7 * (1 - s); p.pD.rotation.x = -1.45 * s - camina * 0.7 * (1 - s);
    var tecla = (p.estado === 'trabajo' && s > 0.9);
    var gest = p.gesto && ahora < p.gesto;
    p.bI.rotation.x = tecla ? -1.15 + Math.sin(t * 13 + p.fase) * 0.22 : (-camina * 0.6 * (1 - s) + (s > 0.5 ? -0.5 : 0));
    p.bD.rotation.x = tecla ? -1.15 + Math.cos(t * 12 + p.fase) * 0.22 : (camina * 0.6 * (1 - s) + (s > 0.5 ? -0.5 : 0));
    if (gest) p.bD.rotation.x = -2.4 + Math.sin(t * 12) * 0.5;
    if (p.salto) { p.bI.rotation.x = -2.8; p.bD.rotation.x = -2.8; p.salto = Math.max(0, p.salto - dt * 0.9); }
    p.cabeza.rotation.x = dorm ? 0.7 : (tecla ? -0.12 : 0); p.cabeza.rotation.y = (p.estado === 'espera' && !charlando && s > 0.9) ? Math.sin(t * 0.7 + p.fase) * 0.6 : 0;
    p.cuerpo.scale.y = 1 + (caminando ? 0 : Math.sin(t * 2 + p.fase) * 0.012);
    p.sombra.position.y = 0.03 - p.cuerpo.position.y * 0;
    // bocadillo: se apaga solo
    if (p.bocadillo.visible && p.bocadilloHasta && ahora > p.bocadilloHasta) p.bocadillo.visible = false;
    if (p.estado === 'trabajo' && !p.bocadillo.visible && textoTrab[k] && ahora - lastBub > 9000 && Math.random() < 0.004) decir(p, textoTrab[k], 3500);
    p.etiqueta.position.y = 2.55 - 0.42 * s; p.bocadillo.position.y = (k === 'be' ? 4.2 : (k === 'neg' ? 3.7 : 3.3)) - 0.35 * s;
  }

  var tiempo = 0;
  function bucle() { if (!vivo) return; requestAnimationFrame(bucle); paso(Math.min(reloj.getDelta(), 0.1)); }
  /** Un paso de simulación + dibujo. Lo usa el bucle y `mundoPaso` (pruebas y capturas sin depender de requestAnimationFrame). */
  function paso(dt) {
    tiempo += dt; var t = tiempo;
    Object.keys(P).forEach(function (k) { actualizarPersonaje(k, P[k], t, dt); });
    // pantallas: brillan si se trabaja
    var brD = objetivo.director === 'trabajo' ? 0.55 + Math.sin(t * 6) * 0.15 : 0.12, brC = objetivo.cons === 'trabajo' ? 0.55 + Math.sin(t * 7) * 0.15 : 0.12, brA = objetivo.fe === 'trabajo' ? 0.55 + Math.sin(t * 5) * 0.15 : 0.12;
    escDir.pantallas.forEach(function (p) { p.material = p.material.clone(); p.material.emissiveIntensity = brD; });
    escCons.pantallas.forEach(function (p) { p.material = p.material.clone(); p.material.emissiveIntensity = brC; p.material.color.setHex(0x1a1d28); p.material.emissive.setHex(0x14b8c4); });
    portatiles.forEach(function (p) { p.material = p.material.clone(); p.material.emissiveIntensity = brA; });
    // perros vigilantes
    [['director', perros.director], ['cons', perros.cons]].forEach(function (par) {
      var pr = par[1]; pr.zz.visible = !pr.vivo; pr.ca.position.y = pr.vivo ? 0.62 + Math.sin(t * 2 + pr.fase) * 0.015 : 0.42; pr.ca.rotation.z = pr.vivo ? 0 : -0.5;
      pr.cola.rotation.y = pr.vivo ? Math.sin(t * 9 + pr.fase) * 0.6 : 0; pr.zz.position.y = 1.3 + Math.sin(t * 1.5) * 0.12;
    });
    // semáforo pulsa si hay alarma
    if (D && D.semaforo === 'ROJO') luzSem.material.emissiveIntensity = 0.6 + Math.abs(Math.sin(t * 4)) * 0.9; else luzSem.material.emissiveIntensity = 0.9;
    // confeti
    if (conf.vida > 0) { conf.vida -= dt; var pos = conf.pts.geometry.attributes.position; for (var i = 0; i < conf.n; i++) { var v = conf.vel[i]; v[1] -= 6 * dt; pos.setXYZ(i, pos.getX(i) + v[0] * dt, Math.max(0.05, pos.getY(i) + v[1] * dt), pos.getZ(i) + v[2] * dt); } pos.needsUpdate = true; if (conf.vida <= 0) conf.pts.visible = false; }
    // cámara: balanceo lento si nadie la toca
    if (Date.now() - ultimoTouch > 6000) orb.yaw += Math.sin(t * 0.15) * 0.0009;
    ponerCamara(); renderer.render(scene, camera);
  }
  window.mundoPaso = function (seg) { var n = Math.max(1, Math.round((seg || 1) * 30)); for (var i = 0; i < n; i++) paso(1 / 30); return Object.keys(P).map(function (k) { return k + ':' + P[k].estado + (P[k].enDescanso ? '/descanso' : '') + '@' + P[k].raiz.position.x.toFixed(1) + ',' + P[k].raiz.position.z.toFixed(1) + (P[k].sentadoK > 0.5 ? ' sentado' : ''); }).join(' | '); };

  // ───────── simulación (ver estados sin esperar 3 min) ─────────
  window.mundoSimular = function (modo) {
    sim = modo === 'real' ? null : { modo: modo };
    Object.keys(P).forEach(function (k) { P[k].idleDesde = Date.now(); P[k].enDescanso = false; });
    if (modo === 'celebrar') { celebrar(); sim = null; }
    mapear(D); if (D) window.mundoActualizar(D);
    var n = document.getElementById('nota3d'); if (n && !D) n.textContent = sim ? 'SIMULACIÓN' : '';
  };
  tamano(); ponerCamara(); pintarPizarra(null); paso(0.016); bucle();
})();
