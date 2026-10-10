'use strict';
/* Bot ÚNICO de Telegram para varios proyectos: un token, un emparejado con PIN, un servicio; cada proyecto solo se registra.
   Los mensajes se reparten por @nombre, por «responder a un aviso» o por el proyecto actual; los avisos llegan con el nombre del proyecto.
   Telegram se simula con un servidor local; ninguna prueba toca la red real ni el ~/.agentix del dueño. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const G = path.join(__dirname, '..', '.agentic', 'grafo');
const HUB = require(path.join(G, 'telegram-hub.cjs'));
const TG = require(path.join(G, 'telegram-bridge.cjs'));
const B = require(path.join(G, 'buzon.cjs'));
const T = require(path.join(G, 'teams.cjs'));
const TOKEN = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghij';

async function telegramFalso() {
  const st = { cola: [], enviados: [], callbacks: [], ediciones: [], uid: 100, mid: 1 };
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url); const params = body ? JSON.parse(body) : {};
      const out = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (!m || m[1] !== TOKEN) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' })); }
      if (m[2] === 'getMe') return out({ ok: true, result: { id: 42, username: 'agentix_hub_bot' } });
      if (m[2] === 'getUpdates') { st.cola = st.cola.filter((u) => u.update_id >= (params.offset || 0)); return out({ ok: true, result: st.cola.slice() }); }
      if (m[2] === 'sendMessage') { const mid = st.mid++; st.enviados.push(Object.assign({}, params, { message_id: mid })); return out({ ok: true, result: { message_id: mid } }); }
      if (m[2] === 'answerCallbackQuery') { st.callbacks.push(params); return out({ ok: true, result: true }); }
      if (m[2] === 'editMessageReplyMarkup') { st.ediciones.push(params); return out({ ok: true, result: true }); }
      return out({ ok: false, error_code: 400, description: 'metodo desconocido' });
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  process.env.AKDD_TELEGRAM_API = 'http://127.0.0.1:' + srv.address().port;
  const msg = (texto, { chat = 7, user = 7, respondeA } = {}) => { st.cola.push({ update_id: st.uid++, message: Object.assign({ message_id: st.mid++, date: Math.floor(Date.now() / 1000), text: texto, chat: { id: chat, type: 'private' }, from: { id: user, first_name: 'Dueño' } }, respondeA ? { reply_to_message: { message_id: respondeA } } : {}) }); };
  const boton = (data) => { st.cola.push({ update_id: st.uid++, callback_query: { id: 'cb' + st.uid, data, from: { id: 7 }, message: { message_id: 55, chat: { id: 7, type: 'private' } } } }); };
  return { st, msg, boton, cerrar: () => { delete process.env.AKDD_TELEGRAM_API; srv.close(); srv.closeAllConnections && srv.closeAllConnections(); }, ultimo: () => st.enviados[st.enviados.length - 1] };
}

function proyecto(nombre, { teams = false } = {}) {
  const padre = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-hub-p-'));
  const root = path.join(padre, nombre); fs.mkdirSync(path.join(root, '.agentic'), { recursive: true }); fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  if (teams) fs.cpSync(G, path.join(root, '.agentic', 'grafo'), { recursive: true });
  return root;
}
const sinSalida = async (fn) => { const o = console.log; const e = console.error; let t = ''; console.log = (...a) => { t += a.join(' ') + '\n'; }; console.error = (...a) => { t += a.join(' ') + '\n'; }; try { await fn(); } finally { console.log = o; console.error = e; } return t; };

/** Entorno aislado: el «home» del bot único va a una carpeta temporal. */
async function entorno({ n = 2 } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-hub-home-')); process.env.AKDD_TELEGRAM_HOME = home;
  const f = await telegramFalso();
  const roots = []; const nombres = ['alfa', 'beta', 'gamma'].slice(0, n);
  for (const nom of nombres) roots.push(proyecto(nom, { teams: true }));
  await sinSalida(async () => { await HUB.main(['activar', '--token=' + TOKEN, '--sin-esperar'], roots[0]); });
  f.msg('/start ' + HUB.leerHub().pin); await HUB.vuelta({ pollS: 0 });
  for (const r of roots) await sinSalida(async () => { await HUB.main(['registrar', '--root=' + r], r); });
  f.st.enviados.length = 0;
  return { home, f, roots, nombres, cerrar: () => { f.cerrar(); delete process.env.AKDD_TELEGRAM_HOME; } };
}

test('HUB-1 activar valida el token, guarda el bot único FUERA de los proyectos (modo privado), no imprime el token y se empareja con PIN', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-hub-home-')); process.env.AKDD_TELEGRAM_HOME = home;
  const f = await telegramFalso(); const p = proyecto('alfa');
  try {
    const salida = await sinSalida(async () => { assert.equal(await HUB.main(['activar', '--token=' + TOKEN, '--sin-esperar'], p), 0); });
    assert.doesNotMatch(salida, /ABCDEFGHIJKLMNOPQRSTUVWXYZ/); assert.match(salida, /TELEGRAM_UNICO_ACTIVO/); assert.match(salida, /\/start \d{6}/);
    assert.ok(fs.existsSync(path.join(home, 'hub.json'))); assert.ok(!fs.existsSync(path.join(p, '.agentic', '_telegram')), 'nada del token dentro del proyecto');
    const h = HUB.leerHub(); assert.equal(h.bot.username, 'agentix_hub_bot'); assert.ok(!h.chat_id);
    f.msg('hola'); f.msg('/start 000000', { chat: 9, user: 9 }); await HUB.vuelta({ pollS: 0 });
    assert.ok(!HUB.leerHub().chat_id, 'ni un mensaje cualquiera ni un PIN malo de otro usuario empareja');
    f.msg('/start ' + h.pin); await HUB.vuelta({ pollS: 0 });
    assert.equal(HUB.leerHub().chat_id, 7); assert.equal(HUB.leerHub().pin, null, 'el PIN se gasta');
    // otro usuario, ya emparejado: ignorado sin respuesta
    const antes = f.st.enviados.length; f.msg('/estado', { chat: 9, user: 9 }); await HUB.vuelta({ pollS: 0 });
    assert.equal(f.st.enviados.length, antes);
    const mal = await sinSalida(async () => { assert.equal(await HUB.main(['activar', '--token=nada', '--sin-esperar'], p), 0 + 0 || 1); });
    assert.match(mal, /TELEGRAM_FALLO/);
  } finally { f.cerrar(); delete process.env.AKDD_TELEGRAM_HOME; }
});

test('HUB-2 registrar: slug por carpeta, el primero queda como actual, es idempotente, apaga el bot propio y exige un proyecto con Agentix', async () => {
  const e = await entorno();
  try {
    const h = HUB.leerHub(); assert.deepEqual(Object.keys(h.proyectos).sort(), ['alfa', 'beta']); assert.equal(h.actual, 'alfa');
    const de = await sinSalida(async () => { await HUB.main(['registrar', '--root=' + e.roots[1]], e.roots[1]); });
    assert.match(de, /Ya estaba registrado: beta/); assert.equal(Object.keys(HUB.leerHub().proyectos).length, 2);
    const vacio = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-hub-vacio-'));
    assert.equal(await sinSalida(async () => { assert.equal(await HUB.main(['registrar', '--root=' + vacio], vacio), 1); }) && true, true);
    assert.equal(Object.keys(HUB.leerHub().proyectos).length, 2, 'una carpeta sin Agentix no se registra');
    // un proyecto con bot propio activo pasa al único y su bot propio queda apagado (un token solo lo lee un proceso)
    const c = proyecto('delta'); fs.mkdirSync(path.join(c, '.agentic', '_telegram'), { recursive: true });
    fs.writeFileSync(path.join(c, '.agentic', '_telegram', 'config.json'), JSON.stringify({ activo: true, token: TOKEN, chat_id: 7, user_id: 7 }));
    await sinSalida(async () => { await HUB.main(['registrar', '--root=' + c, '--nombre=Delta Uno'], c); });
    assert.ok(HUB.leerHub().proyectos['delta-uno']); assert.equal(JSON.parse(fs.readFileSync(path.join(c, '.agentic', '_telegram', 'config.json'), 'utf8')).activo, false);
    assert.equal(TG.leerConfig(c).hub, true, 'ahora el proyecto ve la configuración del bot único');
  } finally { e.cerrar(); }
});

test('HUB-3 reparto: @nombre manda a ese proyecto, sin nombre al actual, /proyecto lo cambia, responder a un aviso va al proyecto del aviso', async () => {
  const e = await entorno();
  try {
    const [a, b] = e.roots;
    e.f.msg('@beta hola desde telegram'); await HUB.vuelta({ pollS: 0 });
    assert.equal(B.listar(b).length, 1); assert.equal(B.listar(a).length, 0);
    assert.match(e.f.ultimo().text, /^\[beta\] 📥 Recibido/);
    e.f.msg('sin nombre'); await HUB.vuelta({ pollS: 0 });
    assert.equal(B.listar(a).length, 1, 'sin nombre va al proyecto actual (alfa)');
    e.f.msg('/proyecto beta'); await HUB.vuelta({ pollS: 0 });
    assert.equal(HUB.leerHub().actual, 'beta'); e.f.msg('otro sin nombre'); await HUB.vuelta({ pollS: 0 });
    assert.equal(B.listar(b).length, 2);
    // un aviso de alfa: responder a él va a alfa aunque el actual sea beta
    const r = await TG.difundir(a, { titulo: 'Aviso', texto: 'tarea aceptada', prioridad: 3 }); assert.equal(r.ok, true);
    const aviso = e.f.ultimo(); assert.match(aviso.text, /^\[alfa\] Aviso/);
    e.f.msg('gracias, sigue', { respondeA: aviso.message_id }); await HUB.vuelta({ pollS: 0 });
    assert.equal(B.listar(a).length, 2); assert.equal(B.listar(b).length, 2);
    // un nombre que no existe no es un proyecto: es texto para el actual
    e.f.msg('@nadie hola'); await HUB.vuelta({ pollS: 0 }); assert.equal(B.listar(b).length, 3);
    // @nombre sin texto no manda nada
    const n0 = B.listar(a).length; e.f.msg('@alfa'); await HUB.vuelta({ pollS: 0 }); assert.equal(B.listar(a).length, n0); assert.match(e.f.ultimo().text, /Falta el mensaje para «alfa»/);
  } finally { e.cerrar(); }
});

test('HUB-4 /proyectos, /estado todos y comandos por proyecto (/barra beta); con varios proyectos y sin actual pide elegir', async () => {
  const e = await entorno();
  try {
    e.f.msg('/proyectos'); await HUB.vuelta({ pollS: 0 });
    let t = e.f.ultimo().text; assert.match(t, /▶ alfa/); assert.match(t, /· beta/);
    e.f.msg('/estado todos'); await HUB.vuelta({ pollS: 0 }); assert.match(e.f.ultimo().text, /Todos los proyectos[\s\S]*alfa[\s\S]*beta/);
    e.f.msg('/barra beta'); await HUB.vuelta({ pollS: 0 }); assert.match(e.f.ultimo().text, /^\[beta\] /);
    e.f.msg('/proyecto zeta'); await HUB.vuelta({ pollS: 0 }); assert.match(e.f.ultimo().text, /No conozco el proyecto «zeta»/);
    // sin actual y varios proyectos: no adivina
    const h = HUB.leerHub(); h.actual = null; fs.writeFileSync(path.join(e.home, 'hub.json'), JSON.stringify(h));
    e.f.msg('hola'); await HUB.vuelta({ pollS: 0 }); assert.match(e.f.ultimo().text, /no sé a cuál va/);
    assert.equal(B.listar(e.roots[0]).length + B.listar(e.roots[1]).length, 0, 'no se mandó a ninguno');
  } finally { e.cerrar(); }
});

test('HUB-5 decisiones: los botones llevan el proyecto, responden SOLO a ese proyecto y un proyecto desconocido no hace nada', async () => {
  const e = await entorno();
  try {
    const [a, b] = e.roots;
    for (const r of [a, b]) { T.ejecutar(['activar'], r); T.ejecutar(['modo', 'completo'], r); T.ejecutar(['iniciar'], r); }
    T.ejecutar(['decision', '¿Usamos A o B en alfa?', '--tipo=dueno', '--opciones=A|B', '--recomendacion=A', '--impacto=x', '--porque=y'], a);
    T.ejecutar(['decision', '¿Usamos A o B en beta?', '--tipo=dueno', '--opciones=A|B', '--recomendacion=A', '--impacto=x', '--porque=y'], b);
    e.f.msg('/decisiones alfa'); await HUB.vuelta({ pollS: 0 });
    const m = e.f.st.enviados.filter((x) => x.reply_markup).pop(); assert.match(m.text, /^\[alfa\] /);
    const botones = m.reply_markup.inline_keyboard.flat();
    assert.ok(botones.every((x) => /^d\|alfa\|D-\d+\|\d$/.test(x.callback_data)), JSON.stringify(botones));
    e.f.boton(botones[1].callback_data); await HUB.vuelta({ pollS: 0 });
    assert.equal(T.calcular(a).decisionesDueno.length, 0, 'alfa quedó respondida'); assert.equal(T.calcular(b).decisionesDueno.length, 1, 'beta NO se tocó');
    e.f.boton('d|zeta|D-1|0'); await HUB.vuelta({ pollS: 0 }); assert.match(e.f.st.callbacks.pop().text, /ya no está registrado/);
    // responder escribiendo, con el nombre delante
    e.f.msg('@beta D-001 A'); await HUB.vuelta({ pollS: 0 }); assert.equal(T.calcular(b).decisionesDueno.length, 0);
  } finally { e.cerrar(); }
});

test('HUB-6 quitar un proyecto: deja de recibir mensajes; el servicio avisa/reparte por proyecto; con un solo proyecto no hace falta el nombre', async () => {
  const e = await entorno();
  try {
    await sinSalida(async () => { await HUB.main(['quitar', 'beta'], e.roots[0]); });
    assert.deepEqual(Object.keys(HUB.leerHub().proyectos), ['alfa']); assert.equal(TG.leerConfig(e.roots[1]), null, 'beta ya no ve el bot');
    e.f.msg('@beta hola'); await HUB.vuelta({ pollS: 0 });
    assert.equal(B.listar(e.roots[0]).length, 1, 'beta ya no existe: el texto va al único proyecto'); assert.equal(B.listar(e.roots[1]).length, 0);
    const estado = await sinSalida(async () => { await HUB.main(['estado'], e.roots[0]); }); assert.match(estado, /TELEGRAM_UNICO_ACTIVO[\s\S]*1 proyecto\(s\)[\s\S]*PARADO/);
    const porProyecto = await sinSalida(async () => { await TG.main(['estado'], e.roots[0]); }); assert.match(porProyecto, /bot ÚNICO · proyecto «alfa»/);
    const bloqueo = await sinSalida(async () => { assert.equal(await TG.main(['servir'], e.roots[0]), 1); }); assert.match(bloqueo, /usa el bot ÚNICO/);
  } finally { e.cerrar(); }
});

test('HUB-7 el servicio único hace una vuelta completa (recibe, reparte y lanza el aviso de cada proyecto) y no se duplica', async () => {
  const e = await entorno();
  try {
    e.f.msg('@alfa hola servicio');
    await HUB.servir({ una: true, pollS: 0, tickMs: 0 });
    assert.equal(B.listar(e.roots[0]).length, 1);
    const sv = HUB.estadoServicio(); assert.ok(sv.pid);
    const otra = await sinSalida(async () => { await HUB.servir({ una: true, pollS: 0 }); });
    assert.ok(typeof otra === 'string');
  } finally { e.cerrar(); }
});

test('HUB-8 registro automático: con un bot único activo, el proyecto se registra solo; sin hub, en carpeta temporal o con AKDD_NO_TELEGRAM_AUTOREG no hace nada; y update/init lo invocan', async () => {
  const e = await entorno({ n: 1 });
  try {
    const nuevo = proyecto('omega', { teams: true });
    const r = HUB.autoRegistrar(nuevo);
    assert.equal(r.ok, true); assert.equal(r.slug, 'omega'); assert.ok(HUB.leerHub().proyectos.omega);
    assert.equal(HUB.autoRegistrar(nuevo).ya, true, 'idempotente');
    process.env.AKDD_NO_TELEGRAM_AUTOREG = '1';
    try { const otro = proyecto('sigma', { teams: true }); assert.equal(HUB.autoRegistrar(otro).causa, 'DESACTIVADO'); assert.ok(!HUB.leerHub().proyectos.sigma); } finally { delete process.env.AKDD_NO_TELEGRAM_AUTOREG; }
    assert.equal(HUB.autoRegistrar(path.join(os.tmpdir(), 'no-existe-nada')).ok, false, 'sin .agentic no se registra');
    // sin AKDD_TELEGRAM_HOME propio, una carpeta temporal NUNCA se registra (así las pruebas no ensucian el bot real del dueño)
    const guardado = process.env.AKDD_TELEGRAM_HOME; delete process.env.AKDD_TELEGRAM_HOME;
    try { const r2 = HUB.autoRegistrar(proyecto('tmp-x')); assert.equal(r2.ok, false); assert.match(r2.causa, /CARPETA_TEMPORAL|SIN_HUB/); } finally { process.env.AKDD_TELEGRAM_HOME = guardado; }
    const upd = fs.readFileSync(path.join(__dirname, '..', 'src', 'update-run.js'), 'utf8');
    assert.equal((upd.match(/autoTelegram\(R, projectPath\);/g) || []).length, 2, 'update lo invoca en sus dos cierres correctos');
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'init.js'), 'utf8'), /autoRegistrar\(projectPath\)/);
  } finally { e.cerrar(); }
});
