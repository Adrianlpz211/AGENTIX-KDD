'use strict';
/* Chat nativo con el dueño: Telegram (long polling saliente, un solo usuario emparejado por PIN) + buzón común con acuses
   (recibido → entregado → leído → atendido), escalado y entrega también a Cursor. Telegram se simula con un servidor local
   que habla el mismo Bot API; ninguna prueba toca la red real. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const G = path.join(__dirname, '..', '.agentic', 'grafo');
const TG = require(path.join(G, 'telegram-bridge.cjs'));
const B = require(path.join(G, 'buzon.cjs'));
const NB = require(path.join(G, 'ntfy-bridge.cjs'));
const T = require(path.join(G, 'teams.cjs'));
const TOKEN = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghij';

/** Telegram falso: getMe, getUpdates (con cola y offset), sendMessage, answerCallbackQuery, editMessageReplyMarkup. */
async function telegramFalso(opts = {}) {
  const st = { cola: [], enviados: [], callbacks: [], ediciones: [], llamadas: [], uid: 100, mid: 1, tokenOk: opts.token || TOKEN, caido: false };
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url); const params = body ? JSON.parse(body) : {};
      const out = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (st.caido) { req.socket.destroy(); return; }
      if (!m || m[1] !== st.tokenOk) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' })); }
      st.llamadas.push(m[2]);
      if (m[2] === 'getMe') return out({ ok: true, result: { id: 42, username: 'agentix_test_bot' } });
      if (m[2] === 'getUpdates') {
        st.cola = st.cola.filter((u) => u.update_id >= (params.offset || 0));
        if (!st.cola.length && params.timeout > 0) await new Promise((r) => setTimeout(r, 120));
        return out({ ok: true, result: st.cola.slice() });
      }
      if (m[2] === 'sendMessage') { st.enviados.push(params); return out({ ok: true, result: { message_id: st.mid++ } }); }
      if (m[2] === 'answerCallbackQuery') { st.callbacks.push(params); return out({ ok: true, result: true }); }
      if (m[2] === 'editMessageReplyMarkup') { st.ediciones.push(params); return out({ ok: true, result: true }); }
      return out({ ok: false, error_code: 400, description: 'metodo desconocido' });
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  process.env.AKDD_TELEGRAM_API = 'http://127.0.0.1:' + srv.address().port;
  const msg = (texto, { chat = 7, user = 7, tipo = 'private' } = {}) => { st.cola.push({ update_id: st.uid++, message: { message_id: st.mid++, date: Math.floor(Date.now() / 1000), text: texto, chat: { id: chat, type: tipo }, from: { id: user, first_name: 'Dueño' } } }); return st.uid - 1; };
  const boton = (data, { chat = 7, user = 7 } = {}) => { st.cola.push({ update_id: st.uid++, callback_query: { id: 'cb' + st.uid, data, from: { id: user }, message: { message_id: 55, chat: { id: chat, type: 'private' } } } }); };
  return { st, msg, boton, cerrar: () => { delete process.env.AKDD_TELEGRAM_API; srv.close(); srv.closeAllConnections && srv.closeAllConnections(); }, ultimo: () => st.enviados[st.enviados.length - 1] };
}

function proyecto({ teams = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-tg-'));
  fs.mkdirSync(path.join(root, '.agentic'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  if (teams) fs.cpSync(G, path.join(root, '.agentic', 'grafo'), { recursive: true });
  return root;
}
const activar = (root, extra = []) => TG.main(['activar', '--token=' + TOKEN, '--sin-esperar', ...extra], root);
async function emparejado(root, fake) {
  await activar(root);
  fake.msg('/start ' + TG.leerConfig(root).pin);
  await TG.vuelta(root, { pollS: 0 });
  assert.equal(TG.leerConfig(root).chat_id, 7);
}
const sinSalida = async (fn) => { const o = console.log; const e = console.error; let t = ''; console.log = (...a) => { t += a.join(' ') + '\n'; }; console.error = (...a) => { t += a.join(' ') + '\n'; }; try { await fn(); } finally { console.log = o; console.error = e; } return t; };

test('TG-1 activar valida el token con Telegram, guarda PIN y config privada, ignora git y NUNCA imprime el token', async () => {
  const f = await telegramFalso(); const root = proyecto();
  try {
    const salida = await sinSalida(() => activar(root));
    assert.doesNotMatch(salida, /ABCDEFGHIJKLMNOPQRSTUVWXYZ/, 'el token no sale por pantalla');
    assert.match(salida, /TELEGRAM_ACTIVO/); assert.match(salida, /\/start \d{6}/);
    const c = TG.leerConfig(root);
    assert.equal(c.activo, true); assert.equal(c.bot.username, 'agentix_test_bot'); assert.match(c.pin, /^\d{6}$/); assert.equal(c.chat_id, null);
    const gi = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    assert.match(gi, /\.agentic\/_telegram\//); assert.match(gi, /\.agentic\/_buzon\//);
    // token mal formado y token rechazado por Telegram: no quedan activos
    const otra = proyecto();
    assert.equal(await sinSalida(async () => { assert.equal(await TG.main(['activar', '--token=nada', '--sin-esperar'], otra), 1); }) && TG.leerConfig(otra), null);
    f.st.tokenOk = 'otro:token';
    const rech = proyecto(); const txt = await sinSalida(async () => { assert.equal(await TG.main(['activar', '--token=' + TOKEN, '--sin-esperar'], rech), 1); });
    assert.match(txt, /TELEGRAM_FALLO/); assert.equal(TG.leerConfig(rech), null);
  } finally { f.cerrar(); }
});

test('TG-2 emparejado: solo /start <PIN> sirve; el PIN se gasta; otro usuario/grupo es ignorado sin respuesta; 5 fallos invalidan el PIN', async () => {
  const f = await telegramFalso(); const root = proyecto();
  try {
    await activar(root); const pin = TG.leerConfig(root).pin;
    f.msg('hola'); f.msg('/start 000000', { chat: 9, user: 9 }); f.msg('/start ' + pin, { chat: -5, user: 7, tipo: 'group' });
    await TG.vuelta(root, { pollS: 0 });
    assert.equal(TG.leerConfig(root).chat_id, null, 'nada de eso empareja');
    f.msg('/start ' + pin); await TG.vuelta(root, { pollS: 0 });
    const c = TG.leerConfig(root);
    assert.equal(c.chat_id, 7); assert.equal(c.user_id, 7); assert.equal(c.pin, null, 'PIN de un solo uso');
    assert.match(f.ultimo().text, /Emparejado/);
    const antes = f.st.enviados.length;
    f.msg('quiero entrar', { chat: 9, user: 9 }); f.msg('/estado', { chat: 9, user: 9 }); f.msg('/estado', { chat: 7, user: 8 });
    await TG.vuelta(root, { pollS: 0 });
    assert.equal(f.st.enviados.length, antes, 'un extraño no recibe ni una respuesta');
    assert.equal(B.listar(root).length, 0, 'ni deja mensajes en el buzón');
    // 5 PIN malos invalidan el PIN
    const r2 = proyecto(); await activar(r2); const pin2 = TG.leerConfig(r2).pin;
    for (let i = 0; i < 5; i++) f.msg('/start 111111');
    await TG.vuelta(r2, { pollS: 0 }); f.msg('/start ' + pin2); await TG.vuelta(r2, { pollS: 0 });
    assert.equal(TG.leerConfig(r2).chat_id, null, 'tras 5 intentos el PIN ya no vale aunque sea el correcto');
  } finally { f.cerrar(); }
});

test('TG-3 texto libre al buzón con enrutado @cursor/@director/@todos, idempotente por update, con acuse inmediato', async () => {
  const f = await telegramFalso(); const root = proyecto();
  try {
    await emparejado(root, f);
    const u1 = f.msg('cambia el color del botón'); f.msg('@cursor revisa el combobox'); f.msg('@todos pausa a las 6');
    await TG.vuelta(root, { pollS: 0 });
    const l = B.listar(root).filter((m) => m.canal === 'telegram');
    assert.deepEqual(l.map((m) => m.para), ['director', 'builder', 'director', 'builder']);
    assert.equal(l[0].texto, 'cambia el color del botón'); assert.equal(l[1].texto, 'revisa el combobox', 'el prefijo se quita');
    assert.ok(f.st.enviados.some((m) => /Recibido/.test(m.text) && /constructor/.test(m.text)));
    // el mismo update llegando otra vez (reintento de Telegram) no duplica
    f.st.cola.push({ update_id: u1, message: { message_id: 1, date: 1, text: 'cambia el color del botón', chat: { id: 7, type: 'private' }, from: { id: 7 } } });
    const n = B.listar(root).length;
    const c = TG.leerConfig(root); await TG.procesarUpdate(root, c, f.st.cola[f.st.cola.length - 1], {});
    assert.equal(B.listar(root).length, n, 'idempotente');
  } finally { f.cerrar(); }
});

test('TG-4 comandos de producción: /estado /barra /tareas /ayuda /buzon; sin datos lo dice; un comando raro no rompe nada', async () => {
  const f = await telegramFalso(); const root = proyecto({ teams: true });
  try {
    await emparejado(root, f);
    for (const c of ['/estado', '/barra', '/tareas', '/ayuda', '/buzon', '/inventado']) f.msg(c);
    await TG.vuelta(root, { pollS: 0 });
    const textos = f.st.enviados.map((m) => m.text).join('\n---\n');
    assert.match(textos, /Sin canal TEAMS|Aún no hay tareas medibles|No hay tareas en cola/);
    assert.match(textos, /\/estado — avance/); assert.match(textos, /No conozco \/inventado/);
    // con TEAMS en marcha la barra sale de los datos reales
    const run = (...a) => T.ejecutar(a, root);
    run('activar'); run('modo', 'completo'); run('iniciar'); run('tarea', 'Una', '--criterio=a', '--sin-contexto'); run('tarea', 'Dos', '--criterio=a', '--sin-contexto');
    f.msg('/barra'); f.msg('/tareas'); await TG.vuelta(root, { pollS: 0 });
    const ult = f.st.enviados.slice(-2).map((m) => m.text).join('\n');
    assert.match(ult, /🟥 2 faltan/); assert.match(ult, /T-001/);
  } finally { f.cerrar(); }
});

test('TG-5 decisión del dueño: llega con botones, tocar uno la RESUELVE y quita los botones; una decisión ya cerrada no se vuelve a decidir', async () => {
  const f = await telegramFalso(); const root = proyecto({ teams: true });
  try {
    await emparejado(root, f);
    const run = (...a) => T.ejecutar(a, root);
    run('activar'); run('modo', 'completo'); run('iniciar');
    run('decision', '¿Usamos A o B?', '--tipo=dueno', '--opciones=A|B|C', '--recomendacion=A', '--impacto=x', '--porque=y');
    f.msg('/decisiones'); await TG.vuelta(root, { pollS: 0 });
    const m = f.st.enviados.filter((x) => x.reply_markup).pop();
    assert.ok(m && /D-\d+/.test(m.text), 'la decisión llega por Telegram');
    const botones = m.reply_markup.inline_keyboard.flat(); assert.deepEqual(botones.map((b) => b.text), ['A', 'B', 'C']);
    f.boton(botones[1].callback_data); await TG.vuelta(root, { pollS: 0 });
    assert.equal(T.calcular(root).decisionesDueno.length, 0, 'quedó respondida');
    assert.ok(f.st.callbacks.length >= 1); assert.equal(f.st.ediciones.length, 1, 'se quitaron los botones');
    assert.match(f.ultimo().text, /resuelta: B/);
    f.boton(botones[0].callback_data); await TG.vuelta(root, { pollS: 0 });
    assert.match(f.st.callbacks.pop().text, /ya no está abierta/);
    // un botón con datos inventados no hace nada
    f.boton('d|D-999|0'); f.boton('x|y'); await TG.vuelta(root, { pollS: 0 });
  } finally { f.cerrar(); }
});

test('TG-6 difundir: sin emparejar no sale; trocea lo largo; respeta el tope diario; el fallo de red no incluye el token', async () => {
  const f = await telegramFalso(); const root = proyecto();
  try {
    await activar(root);
    assert.equal((await TG.difundir(root, { titulo: 'x', texto: 'y' })).causa, 'NO_EMPAREJADO');
    await emparejado(proyecto(), f); // otro proyecto: no afecta
    const r2 = proyecto(); await emparejado(r2, f);
    const largo = Array.from({ length: 400 }, (_, i) => 'línea ' + i + ' ' + 'x'.repeat(30)).join('\n');
    const antes = f.st.enviados.length; const r = await TG.difundir(r2, { titulo: 'Reporte', texto: largo });
    assert.equal(r.ok, true); assert.ok(f.st.enviados.length - antes >= 3, 'se partió en varios mensajes'); assert.ok(f.st.enviados.slice(antes).every((m) => m.text.length <= 4096));
    const c = TG.leerConfig(r2); c.max_dia = 1; fs.writeFileSync(path.join(r2, '.agentic', '_telegram', 'config.json'), JSON.stringify(c));
    assert.equal((await TG.difundir(r2, { titulo: 'a', texto: 'b' })).causa, 'TOPE_DIARIO');
    f.st.caido = true; c.max_dia = 300; fs.writeFileSync(path.join(r2, '.agentic', '_telegram', 'config.json'), JSON.stringify(c));
    const fallo = await TG.vuelta(r2, { pollS: 0 });
    assert.ok(fallo.error); assert.doesNotMatch(JSON.stringify(fallo), /ABCDEFGHIJ/);
    assert.equal(TG.limpiar('error en https://x/bot' + TOKEN + '/getUpdates', TOKEN).includes('ABCDEFGHIJ'), false);
  } finally { f.cerrar(); }
});

test('TG-7 servicio: un solo servicio, procesa lo que llega, avanza el offset y para si lo desactivas', async () => {
  const f = await telegramFalso(); const root = proyecto({ teams: true });
  try {
    await emparejado(root, f);
    f.msg('mensaje para el servicio');
    await sinSalida(() => TG.servir(root, { una: true, pollS: 0, tickMs: 1e9 }));
    assert.ok(B.listar(root).some((m) => m.texto === 'mensaje para el servicio'));
    assert.ok(TG.leerConfig(root) && JSON.parse(fs.readFileSync(path.join(root, '.agentic', '_telegram', 'estado.json'), 'utf8')).offset > 0);
    // otro servicio vivo → no lanza un segundo
    fs.writeFileSync(path.join(root, '.agentic', '_telegram', 'servicio.json'), JSON.stringify({ pid: process.ppid, latido: new Date().toISOString() }));
    const txt = await sinSalida(() => TG.servir(root, { una: true, pollS: 0 }));
    assert.match(txt, /Ya hay un servicio/);
    // un token rechazado (401) detiene el servicio sin bucle
    fs.rmSync(path.join(root, '.agentic', '_telegram', 'servicio.json'));
    f.st.tokenOk = 'cambiado:token'; const t2 = await sinSalida(() => TG.servir(root, { pollS: 0, sinEsperas: true }));
    assert.match(t2, /rechazado \(401\)/);
  } finally { f.cerrar(); }
});

test('BUZON-1 ciclo de vida con acuses al dueño: entregado → leído → atendido (con la respuesta), una sola vez cada uno, por el canal de origen', async () => {
  const f = await telegramFalso(); const root = proyecto({ teams: true });
  try {
    await emparejado(root, f);
    const r = B.agregar(root, { id: 'tg-1', canal: 'telegram', texto: '@cursor corrige el combobox' });
    const id = r.agregados[0].id; assert.equal(r.agregados[0].para, 'builder');
    assert.equal(B.acusesPendientes(root).length, 0, 'recién recibido: nada que avisar (el acuse de recibo ya lo da el servicio)');
    B.marcarEntregado(root, 'director', [id]); assert.equal(B.listar(root)[0].entregado_at, undefined, 'el Director no entrega lo del constructor');
    B.marcarEntregado(root, 'builder', [id]);
    await NB.procesarAcuses(root, TG.leerConfig(root));
    assert.match(f.ultimo().text, /👀 Entregado/); assert.match(f.ultimo().text, /constructor \(Cursor\)/);
    const n1 = f.st.enviados.length; await NB.procesarAcuses(root, {}); assert.equal(f.st.enviados.length, n1, 'cada acuse sale una vez');
    B.marcarLeido(root, id, 'builder'); await NB.procesarAcuses(root, {});
    assert.match(f.ultimo().text, /📖 Leído/);
    B.atender(root, id, 'Lo corregí y agregué la prueba'); await NB.procesarAcuses(root, {});
    assert.match(f.ultimo().text, /✅ Atendido/); assert.match(f.ultimo().text, /agregué la prueba/);
    assert.equal(B.listar(root)[0].estado, 'atendido');
  } finally { f.cerrar(); }
});

test('BUZON-2 un mensaje que nadie atiende se escala una sola vez (⏰); migra el buzón antiguo de ntfy sin perder nada', async () => {
  const f = await telegramFalso(); const root = proyecto();
  try {
    await emparejado(root, f);
    B.agregar(root, { id: 'tg-9', canal: 'telegram', texto: 'urgente', t: new Date(Date.now() - 30 * 60000).toISOString() });
    await NB.procesarAcuses(root, { escalar_min: 10 });
    assert.match(f.ultimo().text, /⏰ Sin atender/);
    const n = f.st.enviados.length; await NB.procesarAcuses(root, { escalar_min: 10 }); assert.equal(f.st.enviados.length, n, 'el escalado no se repite');
    // buzón antiguo de ntfy
    const v = proyecto(); fs.mkdirSync(path.join(v, '.agentic', '_ntfy'), { recursive: true });
    fs.writeFileSync(path.join(v, '.agentic', '_ntfy', 'buzon.jsonl'), JSON.stringify({ id: 'a1', t: '2026-10-01T00:00:00Z', texto: 'viejo sin leer', leido: false }) + '\n' + JSON.stringify({ id: 'a2', t: '2026-10-01T00:00:00Z', texto: 'viejo leído', leido: true }) + '\n');
    assert.deepEqual(B.sinLeer(v).map((m) => m.id), ['a1']); assert.equal(NB.sinLeer(v).length, 1, 'la API antigua sigue funcionando');
    assert.equal(NB.marcarLeidos(v, 'todos'), 1); assert.equal(B.sinLeer(v).length, 0);
  } finally { f.cerrar(); }
});

test('BUZON-3 Cursor ya recibe los mensajes del dueño: su vigilante se despierta, su ronda los muestra y los marca entregados; el Director no ve los del constructor', async () => {
  const root = proyecto({ teams: true });
  const run = (...a) => T.ejecutar(a, root);
  run('activar'); run('modo', 'completo'); run('iniciar');
  B.agregar(root, { id: 'tg-5', canal: 'telegram', texto: '@cursor prioriza el login' });
  B.agregar(root, { id: 'tg-6', canal: 'telegram', texto: 'resume el avance' });
  const e = T.calcular(root, { sinRecuperar: true });
  const ab = T.accionable(e, 'builder'); const ad = T.accionable(e, 'director');
  assert.ok(ab.razones.some((r) => /MENSAJE DEL DUEÑO.*tg-5/.test(r)), 'el constructor se despierta con su mensaje');
  assert.ok(!ab.razones.some((r) => /tg-6/.test(r)), 'no con el del Director');
  assert.ok(ad.razones.some((r) => /tg-6/.test(r)) && !ad.razones.some((r) => /tg-5/.test(r)));
  const out = run('ronda', '--rol=builder').out;
  assert.match(out, /prioriza el login/); assert.match(out, /buzon\.cjs responder tg-5/);
  assert.equal(B.listar(root).find((m) => m.id === 'tg-5').estado, 'entregado');
  assert.equal(B.listar(root).find((m) => m.id === 'tg-6').estado, 'recibido', 'el del Director sigue sin entregar');
  // en modo individual, Claude Code atiende los dos
  const est = T.leerEstado(root); est.modo = 'individual'; fs.writeFileSync(path.join(root, '.agentic', '_teams', 'estado.json'), JSON.stringify(est));
  const ai = T.accionable(T.calcular(root, { sinRecuperar: true }), 'director');
  assert.ok(ai.razones.some((r) => /tg-5/.test(r)) && ai.razones.some((r) => /tg-6/.test(r)));
});

test('BUZON-4 el hook del mensaje de Claude Code inyecta lo que el dueño escribió desde fuera y lo marca entregado', () => {
  const root = proyecto({ teams: true });
  B.agregar(root, { id: 'tg-7', canal: 'telegram', texto: 'cuando termines avísame' });
  const guard = require(path.join(G, 'host-guard.cjs'));
  const out = guard.procesar('claude', 'prompt', { prompt: 'hola', cwd: root }, root);
  const txt = JSON.stringify(out);
  assert.match(txt, /MENSAJE\(S\) DEL DUEÑO/); assert.match(txt, /cuando termines avísame/); assert.match(txt, /buzon\.cjs responder tg-7/);
  assert.equal(B.listar(root)[0].estado, 'entregado');
  // Cursor no puede recibir contexto del hook: no se marca entregado por ahí
  const r2 = proyecto({ teams: true }); B.agregar(r2, { id: 'tg-8', canal: 'telegram', texto: '@cursor hola' });
  guard.procesar('cursor', 'prompt', { prompt: 'hola', workspace_roots: [r2] }, r2);
  assert.equal(B.listar(r2)[0].estado, 'recibido');
});

test('NTFY-1 los avisos salen también por Telegram, y las decisiones llevan botones en ntfy que responden publicando en el mismo tema', async () => {
  const f = await telegramFalso(); const root = proyecto();
  const llamadas = []; const fetchReal = global.fetch;
  try {
    await emparejado(root, f);
    fs.mkdirSync(path.join(root, '.agentic', '_ntfy'), { recursive: true });
    fs.writeFileSync(path.join(root, '.agentic', '_ntfy', 'config.json'), JSON.stringify({ activo: true, servidor: 'https://ntfy.test', tema: 'tema-secreto', pin: '' }));
    global.fetch = async (url, init) => { if (String(url).startsWith('https://ntfy.test')) { llamadas.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ id: 'n1' }) }; } return fetchReal(url, init); };
    const r = await NB.difundir(root, { titulo: '❓ Decisión', texto: 'cuerpo', prioridad: 4, decision: { id: 'D-004', opciones: 'Sí|No' } });
    assert.deepEqual(r.map((x) => [x.canal, x.ok]), [['ntfy', true], ['telegram', true]]);
    assert.deepEqual(llamadas[0].actions.map((a) => [a.label, a.method, a.body]), [['Sí', 'POST', 'D-004 Sí'], ['No', 'POST', 'D-004 No']]);
    assert.ok(f.ultimo().reply_markup, 'y en Telegram, botones');
    // solo por el canal de origen cuando se pide
    const antes = llamadas.length; const r2 = await NB.difundir(root, { titulo: 't', texto: 'x', canalOrigen: 'telegram' });
    assert.deepEqual(r2.map((x) => x.canal), ['telegram']); assert.equal(llamadas.length, antes);
  } finally { global.fetch = fetchReal; f.cerrar(); }
});

test('BUZON-5 escrituras simultáneas desde varios procesos (servicio, hook, comandos) no pierden ni duplican mensajes', async () => {
  const { spawn } = require('child_process');
  const root = proyecto(); const buzon = path.join(G, 'buzon.cjs').split(path.sep).join('/');
  const codigo = (n) => `const B=require(${JSON.stringify(buzon)});for(let i=0;i<8;i++)B.agregar(${JSON.stringify(root)},{id:'p${n}-'+i,canal:'telegram',texto:'msg '+${n}+'-'+i});`;
  await Promise.all([0, 1, 2, 3, 4, 5].map((n) => new Promise((res, rej) => { const p = spawn(process.execPath, ['-e', codigo(n)], { stdio: 'ignore' }); p.on('exit', (c) => (c === 0 ? res() : rej(new Error('salió ' + c)))); })));
  const l = B.listar(root);
  assert.equal(l.length, 48, 'ninguno se perdió');
  assert.equal(new Set(l.map((m) => m.id)).size, 48, 'ninguno se duplicó');
  // y un cambio de estado en paralelo con altas tampoco pisa nada
  await Promise.all([new Promise((res) => { const p = spawn(process.execPath, ['-e', `const B=require(${JSON.stringify(buzon)});B.marcarLeido(${JSON.stringify(root)},'todos');`], { stdio: 'ignore' }); p.on('exit', res); }),
    new Promise((res) => { const p = spawn(process.execPath, ['-e', codigo(9)], { stdio: 'ignore' }); p.on('exit', res); })]);
  assert.equal(B.listar(root).length, 56);
});
