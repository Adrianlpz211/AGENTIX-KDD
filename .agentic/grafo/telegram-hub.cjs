#!/usr/bin/env node
'use strict';
/**
 * Bot ÚNICO de Telegram para TODOS tus proyectos con Agentix.
 *
 * Por qué existe: un bot de Telegram solo puede ser leído por UN proceso a la vez (dos servicios con el mismo token se roban los mensajes),
 * así que con un bot por proyecto había que crear N bots y repetir el emparejado N veces. Aquí hay UN bot, UN emparejado con PIN y UN servicio
 * en tu PC; cada proyecto solo se REGISTRA (un comando). Los avisos de cada proyecto llegan al mismo chat con su nombre delante: «[medinet] …».
 *
 * Dónde vive (fuera de cualquier repo, nunca se sube a git):  ~/.agentix/telegram/   (o AKDD_TELEGRAM_HOME)
 *   hub.json (token y emparejado, modo 0600) · estado.json (offset de Telegram) · mensajes.json (a qué proyecto pertenece cada aviso) · servicio.json
 *
 * Cómo le hablas:
 *   @medinet estado              → a ese proyecto (también @medinet @cursor sigue con T-12, @medinet D-003 A)
 *   respondiendo a un aviso      → al proyecto de ESE aviso (no hace falta escribir el nombre)
 *   sin nombre ni respuesta      → al proyecto actual (/proyecto <nombre> lo cambia; si hay uno solo, ese)
 *   /proyectos · /proyecto <n> · /estado [n|todos] · /barra [n] · /tareas [n] · /decisiones [n] · /buzon [n] · /ayuda · /desemparejar
 *
 * Seguridad: la misma que el bot por proyecto — un solo usuario emparejado con PIN (6 dígitos, 15 min, 5 intentos), el token nunca se imprime,
 * cualquier otro chat se ignora sin respuesta, texto plano y topes de mensajes. Lo que escribes es DATO del dueño: solo responder una
 * decisión y pedir el estado se ejecutan solos; lo demás lo lee el Director/constructor del proyecto, que confirma lo destructivo en su chat.
 *
 *   node telegram-hub.cjs activar [--token=…] [--sin-esperar]    (o AKDD_TELEGRAM_TOKEN; sin token lo pide)
 *   node telegram-hub.cjs registrar [--root=<carpeta>] [--nombre=<alias>]     (este proyecto pasa a usar el bot único)
 *   node telegram-hub.cjs quitar [<nombre>] | proyectos | estado | pin [--reemparejar] | desactivar [--olvidar]
 *   node telegram-hub.cjs servir        (el servicio único: recibe tus mensajes, reparte a cada proyecto y envía sus avisos)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const TG = () => require('./telegram-bridge.cjs');
const NL = String.fromCharCode(10);
const PIN_VALE_MS = 15 * 60 * 1000;
const PIN_INTENTOS = 5;
const MAX_POR_MIN = 20;
const TICK_CADA_MS = 20 * 1000;
const MAX_MENSAJES_RECORDADOS = 400;
const RESERVADOS = new Set(['cursor', 'director', 'todos', 'todas', 'all']);

const homeDir = () => (process.env.AKDD_TELEGRAM_HOME ? path.resolve(process.env.AKDD_TELEGRAM_HOME) : path.join(os.homedir(), '.agentix', 'telegram'));
const arch = (n) => path.join(homeDir(), n);
const leerJ = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
function escribirJ(p, o, privado) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const t = p + '.' + process.pid + '.tmp'; fs.writeFileSync(t, JSON.stringify(o, null, 2), privado ? { mode: 0o600 } : undefined);
  try { fs.renameSync(t, p); } catch { fs.writeFileSync(p, JSON.stringify(o, null, 2)); try { fs.unlinkSync(t); } catch { /* ya */ } }
}
const corto = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

const leerHub = () => leerJ(arch('hub.json'), null);
const guardarHub = (h) => escribirJ(arch('hub.json'), h, true);
const leerEstado = () => leerJ(arch('estado.json'), { offset: 0 });
const guardarEstado = (e) => escribirJ(arch('estado.json'), e);
const normRoot = (r) => path.resolve(String(r)).split('\\').join('/').replace(/\/+$/, '').toLowerCase();

function slugDe(nombre) {
  const s = String(nombre || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 16).replace(/-+$/, '');
  return s || 'proyecto';
}
function slugLibre(h, base, root) {
  const prox = h.proyectos || {};
  let s = RESERVADOS.has(base) ? base + '-1' : base; let i = 2;
  while (prox[s] && normRoot(prox[s].root) !== normRoot(root)) { s = base.slice(0, 13) + '-' + i; i++; }
  return s;
}

/** La configuración que ve el resto de Agentix de un proyecto registrado en el bot único (null si no lo está). */
function vistaProyecto(root) {
  const h = leerHub(); if (!h || !h.activo || !h.token) return null;
  const hallado = Object.entries(h.proyectos || {}).find(([, p]) => normRoot(p.root) === normRoot(root));
  if (!hallado) return null;
  return { activo: true, hub: true, slug: hallado[0], prefijo: '[' + hallado[0] + '] ', token: h.token, bot: h.bot, chat_id: h.chat_id || null, user_id: h.user_id || null, nombre: h.nombre, max_dia: h.max_dia || 300, escalar_min: h.escalar_min || 10 };
}

/** A qué proyecto pertenece cada aviso enviado: es lo que permite contestar «respondiendo» sin escribir el nombre. */
function recordarMensaje(messageId, slug) {
  try {
    if (!messageId) return;
    const m = leerJ(arch('mensajes.json'), {}); m[String(messageId)] = slug;
    const ks = Object.keys(m); if (ks.length > MAX_MENSAJES_RECORDADOS) for (const k of ks.slice(0, ks.length - MAX_MENSAJES_RECORDADOS)) delete m[k];
    escribirJ(arch('mensajes.json'), m);
  } catch { /* sin disco: solo se pierde la comodidad de responder sin nombre */ }
}
const proyectoDeMensaje = (messageId) => (leerJ(arch('mensajes.json'), {}) || {})[String(messageId)] || null;

function vistaPor(h, slug) {
  const p = (h.proyectos || {})[slug]; if (!p) return null;
  return { activo: true, hub: true, slug, prefijo: '[' + slug + '] ', token: h.token, bot: h.bot, chat_id: h.chat_id, user_id: h.user_id, nombre: h.nombre, max_dia: h.max_dia || 300, escalar_min: h.escalar_min || 10 };
}

function lineaProyecto(h, slug) {
  const p = h.proyectos[slug]; const d = fs.existsSync(p.root) ? TG()._i.salud(p.root) : null;
  const marca = h.actual === slug ? '▶' : '·';
  if (!d) return `${marca} ${slug} — sin canal TEAMS activo`;
  const av = d.avance == null ? '' : ` · avance ${d.avance}%`;
  return `${marca} ${slug} — canal ${d.canal} · semáforo ${d.semaforo}${av}`;
}
function listaProyectos(h) {
  const ks = Object.keys(h.proyectos || {}); if (!ks.length) return 'No hay proyectos registrados. En cada proyecto: node .agentic/grafo/telegram-hub.cjs registrar';
  return ks.map((k) => lineaProyecto(h, k)).join(NL) + NL + NL + '▶ = proyecto actual. Cámbialo con /proyecto <nombre>, o escribe @<nombre> delante.';
}

const AYUDA = [
  'Agentix en Telegram — un solo bot para todos tus proyectos.',
  '',
  '@proyecto texto — le habla a ese proyecto (@proyecto @cursor … → su constructor; @proyecto D-001 A → responde una decisión)',
  'Si respondes a un aviso, va al proyecto de ese aviso. Sin nombre: al proyecto actual.',
  '',
  '/proyectos — tus proyectos con su estado',
  '/proyecto <nombre> — cambia el proyecto actual',
  '/estado [nombre|todos] — avance, tiempo y lo que falta',
  '/barra [nombre] · /tareas [nombre] · /decisiones [nombre] · /buzon [nombre]',
  '/desemparejar — este chat deja de ser el del dueño',
].join(NL);

// ───────────────────────────── procesar lo que llega ─────────────────────────────
const CMD_PROYECTO = new Set(['estado', 'barra', 'tareas', 'decisiones', 'buzon']);

async function emparejar(h, msg, chat, from) {
  const m = /^\/start(?:@\w+)?(?:\s+(\d{6}))?\s*$/.exec(String(msg && msg.text || ''));
  if (!m || chat.type !== 'private') return { accion: 'IGNORADO' };
  const t = TG()._i;
  if (!m[1]) {
    if (h.pin && Date.now() < (h.pin_expira || 0)) await t.enviarA(h, chat.id, 'Para emparejar este chat escribe:  /start y los 6 dígitos del PIN que te dio tu PC (telegram-hub.cjs pin).');
    return { accion: 'IGNORADO' };
  }
  const ok = !!(h.pin && Date.now() < (h.pin_expira || 0) && (h.pin_fallos || 0) < PIN_INTENTOS
    && crypto.timingSafeEqual(crypto.createHash('sha256').update(m[1]).digest(), crypto.createHash('sha256').update(String(h.pin)).digest()));
  if (!ok) {
    h.pin_fallos = (h.pin_fallos || 0) + 1; if (h.pin_fallos >= PIN_INTENTOS) h.pin = null; guardarHub(h);
    await t.enviarA(h, chat.id, 'No pude emparejar este chat (PIN incorrecto o vencido). Pide uno nuevo en tu PC: telegram-hub.cjs pin');
    return { accion: 'PIN_MALO' };
  }
  Object.assign(h, { chat_id: chat.id, user_id: from.id, nombre: corto(from.first_name || from.username || '', 40), pin: null, pin_expira: null, pin_fallos: 0, emparejado_at: new Date().toISOString() });
  guardarHub(h);
  await t.enviarA(h, chat.id, '✅ Emparejado. Desde ahora este chat es el del dueño de tus proyectos con Agentix.' + NL + NL + AYUDA + NL + NL + listaProyectos(h));
  return { accion: 'EMPAREJADO' };
}

/** Elige el proyecto de un mensaje: @nombre explícito → respuesta a un aviso → proyecto actual → el único. */
function elegirProyecto(h, texto, replyId) {
  const ks = Object.keys(h.proyectos || {});
  const m = /^@([\w-]+)\b\s*([\s\S]*)$/.exec(texto);
  if (m && (h.proyectos || {})[m[1].toLowerCase()]) return { slug: m[1].toLowerCase(), resto: m[2], via: '@' };
  const r = replyId ? proyectoDeMensaje(replyId) : null;
  if (r && (h.proyectos || {})[r]) return { slug: r, resto: texto, via: 'respuesta' };
  if (h.actual && (h.proyectos || {})[h.actual]) return { slug: h.actual, resto: texto, via: 'actual' };
  if (ks.length === 1) return { slug: ks[0], resto: texto, via: 'unico' };
  return { slug: null, resto: texto, via: 'ninguno' };
}

const clonarConTexto = (u, texto) => { const c = JSON.parse(JSON.stringify(u)); if (c.message) c.message.text = texto; return c; };

async function procesarUpdate(h, u, ctx) {
  const t = TG()._i;
  const msg = u.message; const cb = u.callback_query;
  const chat = msg ? msg.chat : (cb && cb.message ? cb.message.chat : null); const from = msg ? msg.from : (cb ? cb.from : null);
  if (!chat || !from) return { accion: 'IGNORADO' };
  if (!h.chat_id) return await emparejar(h, msg, chat, from);
  if (chat.id !== h.chat_id || from.id !== h.user_id || chat.type !== 'private') return { accion: 'IGNORADO' };

  const ahora = Date.now(); ctx.ventana = (ctx.ventana || []).filter((x) => ahora - x < 60000); ctx.ventana.push(ahora);
  if (ctx.ventana.length > MAX_POR_MIN) { if (!ctx.avisoTope || ahora - ctx.avisoTope > 60000) { ctx.avisoTope = ahora; await t.enviarA(h, chat.id, 'Demasiados mensajes seguidos: espera un minuto.'); } return { accion: 'TOPE' }; }

  // botón de una decisión: d|<proyecto>|D-001|<opción>
  if (cb) {
    const m = /^d\|([a-z0-9-]{1,16})\|(D-\d+)\|(\d)$/.exec(String(cb.data || ''));
    const v = m ? vistaPor(h, m[1]) : null;
    if (!m || !v) { await t.api(h, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'Ese proyecto ya no está registrado.' }); return { accion: 'IGNORADO' }; }
    const u2 = JSON.parse(JSON.stringify(u)); u2.callback_query.data = 'd|' + m[2] + '|' + m[3];
    return await t.procesarUpdate(h.proyectos[m[1]].root, v, u2, ctx);
  }

  const texto = String(msg.text || '').trim(); if (!texto) return { accion: 'IGNORADO' };
  const replyId = msg.reply_to_message && msg.reply_to_message.message_id;
  const cmd = /^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(texto);

  if (cmd) {
    const c = cmd[1].toLowerCase(); const arg = String(cmd[2] || '').trim();
    if (c === 'start' || c === 'ayuda' || c === 'help') { await t.enviarA(h, chat.id, AYUDA + NL + NL + listaProyectos(h)); return { accion: 'AYUDA' }; }
    if (c === 'proyectos') { await t.enviarA(h, chat.id, listaProyectos(h)); return { accion: 'PROYECTOS' }; }
    if (c === 'proyecto') {
      const slug = arg.replace(/^@/, '').toLowerCase();
      if (!slug) { await t.enviarA(h, chat.id, 'Proyecto actual: ' + (h.actual || '(ninguno)') + NL + NL + listaProyectos(h)); return { accion: 'PROYECTO' }; }
      if (!(h.proyectos || {})[slug]) { await t.enviarA(h, chat.id, 'No conozco el proyecto «' + slug + '».' + NL + NL + listaProyectos(h)); return { accion: 'PROYECTO_DESCONOCIDO' }; }
      h.actual = slug; guardarHub(h); await t.enviarA(h, chat.id, '▶ Proyecto actual: ' + slug); return { accion: 'PROYECTO_CAMBIADO' };
    }
    if (c === 'desemparejar') { h.chat_id = null; h.user_id = null; h.nombre = null; guardarHub(h); await t.enviarA({ token: h.token }, chat.id, 'Listo: este chat ya no es el del dueño. Para volver a emparejar, genera un PIN en tu PC (telegram-hub.cjs pin).'); return { accion: 'DESEMPAREJADO' }; }
    if (CMD_PROYECTO.has(c)) {
      const primera = arg.split(/\s+/)[0].replace(/^@/, '').toLowerCase();
      if (c === 'estado' && (primera === 'todos' || (!primera && !h.actual && Object.keys(h.proyectos || {}).length > 1 && !replyId))) {
        await t.enviarA(h, chat.id, '📊 Todos los proyectos' + NL + NL + listaProyectos(h)); return { accion: 'ESTADO_TODOS' };
      }
      let slug = (h.proyectos || {})[primera] ? primera : null;
      if (!slug) { const e = elegirProyecto(h, '', replyId); slug = e.slug; }
      if (!slug) { await t.enviarA(h, chat.id, 'Dime de qué proyecto: /' + c + ' <nombre>' + NL + NL + listaProyectos(h)); return { accion: 'ELEGIR_PROYECTO' }; }
      return await t.procesarUpdate(h.proyectos[slug].root, vistaPor(h, slug), clonarConTexto(u, '/' + c), ctx);
    }
    await t.enviarA(h, chat.id, 'No conozco /' + c + '. Escribe /ayuda.'); return { accion: 'COMANDO_DESCONOCIDO' };
  }

  const e = elegirProyecto(h, texto, replyId);
  if (!e.slug) { await t.enviarA(h, chat.id, 'Tienes varios proyectos y no sé a cuál va. Escribe @<nombre> delante, responde a un aviso, o elige uno con /proyecto <nombre>.' + NL + NL + listaProyectos(h)); return { accion: 'ELEGIR_PROYECTO' }; }
  if (!e.resto.trim()) { await t.enviarA(h, chat.id, 'Falta el mensaje para «' + e.slug + '». Ejemplo: @' + e.slug + ' estado'); return { accion: 'VACIO' }; }
  return await t.procesarUpdate(h.proyectos[e.slug].root, vistaPor(h, e.slug), clonarConTexto(u, e.resto.trim()), ctx);
}

async function vuelta(opts = {}) {
  const h = leerHub(); if (!h || !h.activo) return { recibidos: 0, motivo: 'APAGADO' };
  const t = TG()._i; const est = leerEstado(); const ctx = opts.ctx || {};
  const pollS = opts.pollS === undefined ? 25 : opts.pollS;
  const r = await t.api(h, 'getUpdates', { offset: est.offset || 0, timeout: pollS, allowed_updates: ['message', 'callback_query'] }, (pollS + 10) * 1000);
  if (!r.ok) return { recibidos: 0, error: r.causa, codigo: r.codigo };
  let n = 0;
  for (const u of (r.resultado || []).sort((a, b) => a.update_id - b.update_id)) {
    const hh = leerHub() || h;
    try { await procesarUpdate(hh, u, ctx); n++; } catch (e) { console.error('telegram-hub: update ' + u.update_id + ': ' + t.limpiar(e.message, h.token)); }
    const f = leerEstado(); f.offset = u.update_id + 1; f.ult_update_at = new Date().toISOString(); guardarEstado(f); // el offset avanza SIEMPRE: un update malo no se repite en bucle
  }
  return { recibidos: n };
}

// ───────────────────────────── servicio ─────────────────────────────
function estadoServicio() {
  const v = leerJ(arch('servicio.json'), null); if (!v) return { vivo: false };
  let proceso = false; try { process.kill(v.pid, 0); proceso = true; } catch { proceso = false; }
  const hace = Math.round((Date.now() - Date.parse(v.latido)) / 1000);
  return { vivo: proceso && hace < 90, pid: v.pid, latido_hace_s: hace };
}
const latido = () => { try { escribirJ(arch('servicio.json'), { pid: process.pid, latido: new Date().toISOString() }); } catch { /* sin disco */ } };

async function servir(opts = {}) {
  const h0 = leerHub(); if (!h0 || !h0.activo) { console.log('El bot único está apagado: «activar» primero.'); return; }
  const otro = estadoServicio(); if (otro.vivo && otro.pid !== process.pid) { console.log('Ya hay un servicio del bot único vivo (pid ' + otro.pid + '): no lanzo otro.'); return; }
  console.log('telegram-hub: servicio en marcha para ' + Object.keys(h0.proyectos || {}).length + ' proyecto(s). Ctrl+C para detener.');
  let corriendo = true; const parar = () => { corriendo = false; try { const v = leerJ(arch('servicio.json'), null); if (v && v.pid === process.pid) fs.unlinkSync(arch('servicio.json')); } catch { /* ya */ } };
  process.on('SIGINT', () => { parar(); process.exit(0); }); process.on('SIGTERM', () => { parar(); process.exit(0); });
  const ctx = {}; let fallos = 0; let ultTick = 0; const t = TG()._i;
  while (corriendo) {
    const h = leerHub(); if (!h || !h.activo) { console.log('telegram-hub desactivado: el servicio termina.'); parar(); return; }
    latido();
    const r = await vuelta({ ctx, pollS: opts.pollS });
    if (r.error) {
      if (r.codigo === 401) { console.error('telegram-hub: el token fue rechazado (401). Servicio detenido: revisa el token con «activar».'); parar(); return; }
      if (r.codigo === 409) console.error('telegram-hub: otro programa está leyendo este mismo bot (¿un servicio de Telegram por proyecto con el mismo token?). Detén el otro: un bot solo lo lee un proceso.');
      fallos++; const espera = Math.min(60000, 1000 * Math.pow(2, Math.min(fallos, 6)));
      if (fallos === 1 || fallos % 10 === 0) console.error('telegram-hub: ' + r.error + ' (reintento en ' + Math.round(espera / 1000) + ' s)');
      if (opts.una) return;
      await new Promise((res) => setTimeout(res, opts.sinEsperas ? 10 : espera));
    } else fallos = 0;
    if (h.chat_id && Date.now() - ultTick >= (opts.tickMs || TICK_CADA_MS)) {
      ultTick = Date.now();
      for (const [slug, p] of Object.entries(h.proyectos || {})) {
        if (!fs.existsSync(path.join(p.root, '.agentic'))) continue;
        try { await require('./ntfy-bridge.cjs').tick(p.root); } catch (e) { console.error('telegram-hub: tick de ' + slug + ': ' + t.limpiar(e.message, h.token)); }
      }
    }
    latido();
    if (opts.una) return;
    if (!r.error && opts.pollS === 0) await new Promise((res) => setTimeout(res, opts.esperaMs || 1000));
  }
}

// ───────────────────────────── comandos ─────────────────────────────
function parseArgs(a) { const opt = {}; const libres = []; for (const x of a) { const m = /^--([^=]+)(?:=(.*))?$/.exec(x); if (m) opt[m[1]] = m[2] === undefined ? true : m[2]; else libres.push(x); } return { opt, libres }; }
const nuevoPin = () => String(crypto.randomInt(100000, 1000000));
async function pedirToken() {
  if (!process.stdin.isTTY) return '';
  const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
  return await new Promise((res) => rl.question('Pega el token de tu bot (lo da @BotFather): ', (x) => { rl.close(); res(String(x || '').trim()); }));
}

async function main(argv, rootPorDefecto) {
  const { opt, libres } = parseArgs(argv); const cmd = libres[0] || 'estado'; const t = TG()._i;
  const root = opt.root && opt.root !== true ? path.resolve(opt.root) : (rootPorDefecto || process.cwd());
  let h = leerHub();

  if (cmd === 'activar') {
    const prev = h || {};
    let token = String(opt.token && opt.token !== true ? opt.token : (process.env.AKDD_TELEGRAM_TOKEN || prev.token || '')).trim();
    if (!token) token = await pedirToken();
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) { console.log('TELEGRAM_FALLO: falta un token válido. Créalo hablando con @BotFather en Telegram (/newbot) y pásalo con --token=… o en AKDD_TELEGRAM_TOKEN.'); return 1; }
    const yo = await t.api({ token }, 'getMe', {});
    if (!yo.ok) { console.log('TELEGRAM_FALLO: Telegram no aceptó el token (' + yo.causa + '). No quedó activo.'); return 1; }
    h = Object.assign({ max_dia: 300, escalar_min: 10, proyectos: {}, actual: null }, prev, { activo: true, token, bot: { id: yo.resultado.id, username: yo.resultado.username }, pin: nuevoPin(), pin_expira: Date.now() + PIN_VALE_MS, pin_fallos: 0 });
    if (opt.reemparejar || prev.token !== token) { h.chat_id = null; h.user_id = null; }
    guardarHub(h);
    if (!fs.existsSync(arch('estado.json'))) guardarEstado({ offset: 0 });
    console.log([
      h.chat_id ? 'TELEGRAM_UNICO_ACTIVO — ya había un chat emparejado (usa «pin --reemparejar» para cambiarlo).' : 'TELEGRAM_UNICO_ACTIVO — falta emparejar tu chat:',
      ...(h.chat_id ? [] : ['', `  1) Abre Telegram y busca a @${h.bot.username}  (https://t.me/${h.bot.username})`, `  2) Pulsa «Iniciar» o escríbele:  /start ${h.pin}`, '     (el PIN vale 15 minutos y 5 intentos; solo ese chat quedará autorizado)']),
      '',
      'Después, en CADA proyecto:  node .agentic/grafo/telegram-hub.cjs registrar',
      'Y deja corriendo UNA sola vez (en cualquier carpeta):  node .agentic/grafo/telegram-hub.cjs servir',
    ].join(NL));
    if (!h.chat_id && !opt['sin-esperar']) {
      const limite = Date.now() + (Number(opt.espera) || 120) * 1000; const ctx = {};
      process.stdout.write('Esperando tu /start (hasta ' + (Number(opt.espera) || 120) + ' s)… ');
      while (Date.now() < limite) { await vuelta({ ctx, pollS: 5 }); const c = leerHub(); if (c && c.chat_id) { console.log('emparejado ✔'); return 0; } }
      console.log('no llegó. Cuando abras el chat, el servicio lo empareja solo (el PIN sigue vigente).');
    }
    return 0;
  }

  if (cmd === 'estado') {
    if (!h || !h.activo) { console.log('TELEGRAM_UNICO_APAGADO — «activar» lo enciende (opcional; Agentix funciona igual sin esto).'); return 0; }
    const sv = estadoServicio(); const n = Object.keys(h.proyectos || {}).length;
    console.log(`TELEGRAM_UNICO_ACTIVO · bot @${h.bot && h.bot.username} · chat ${h.chat_id ? 'EMPAREJADO (' + (h.nombre || 'dueño') + ')' : 'SIN EMPAREJAR' + (h.pin && Date.now() < h.pin_expira ? ' (PIN vigente)' : ' (sin PIN: corre «pin»)')} · ${n} proyecto(s) · actual ${h.actual || '—'} · servicio ${sv.vivo ? 'VIVO (latido hace ' + sv.latido_hace_s + ' s)' : 'PARADO — lánzalo: node .agentic/grafo/telegram-hub.cjs servir'}`);
    return 0;
  }
  if (!h || !h.activo) { console.log('El bot único está apagado: «activar» primero.'); return 1; }

  if (cmd === 'registrar') {
    if (!fs.existsSync(path.join(root, '.agentic'))) { console.log('«' + root + '» no tiene Agentix (.agentic). Corre esto dentro de un proyecto con Agentix.'); return 1; }
    const own = t.leerConfigPropia(root);
    if (own && own.activo && t.estadoServicio(root).vivo) { console.log('Este proyecto tiene su PROPIO servicio de Telegram vivo (un bot solo lo lee un proceso). Deténlo y repite.'); return 1; }
    h.proyectos = h.proyectos || {};
    const ya = Object.entries(h.proyectos).find(([, p]) => normRoot(p.root) === normRoot(root));
    const slug = ya ? ya[0] : slugLibre(h, slugDe(opt.nombre && opt.nombre !== true ? opt.nombre : path.basename(root)), root);
    h.proyectos[slug] = { root, nombre: path.basename(root), desde: (ya && ya[1].desde) || new Date().toISOString() };
    if (!h.actual || !h.proyectos[h.actual]) h.actual = slug;
    guardarHub(h); t.asegurarIgnorado(root);
    if (own && own.activo) { own.activo = false; t.guardarConfigPropia(root, own); console.log('(El bot propio de este proyecto quedó apagado: ahora usa el bot único. Su token se conserva en el proyecto.)'); }
    console.log((ya ? 'Ya estaba registrado: ' : 'Registrado: ') + slug + '  →  ' + root + NL + 'Desde Telegram: @' + slug + ' estado' + (h.actual === slug ? '  (es el proyecto actual)' : '  ·  /proyecto ' + slug));
    return 0;
  }
  if (cmd === 'quitar') {
    const pedido = (libres[1] || '').replace(/^@/, '').toLowerCase();
    const slug = pedido || (Object.entries(h.proyectos || {}).find(([, p]) => normRoot(p.root) === normRoot(root)) || [])[0];
    if (!slug || !(h.proyectos || {})[slug]) { console.log('No encuentro ese proyecto. Mira: telegram-hub.cjs proyectos'); return 1; }
    delete h.proyectos[slug]; if (h.actual === slug) h.actual = Object.keys(h.proyectos)[0] || null; guardarHub(h);
    console.log('Quitado: ' + slug); return 0;
  }
  if (cmd === 'proyectos') { console.log(listaProyectos(h)); return 0; }
  if (cmd === 'pin') {
    h.pin = nuevoPin(); h.pin_expira = Date.now() + PIN_VALE_MS; h.pin_fallos = 0; if (opt.reemparejar) { h.chat_id = null; h.user_id = null; }
    guardarHub(h); console.log(h.chat_id ? 'Ya hay un chat emparejado. Para cambiarlo: pin --reemparejar' : `Escribe en @${h.bot.username}:  /start ${h.pin}   (vale 15 minutos)`); return 0;
  }
  if (cmd === 'desemparejar') { h.chat_id = null; h.user_id = null; h.nombre = null; guardarHub(h); console.log('Chat desemparejado.'); return 0; }
  if (cmd === 'desactivar') { h.activo = false; if (opt.olvidar) { h.token = null; h.chat_id = null; h.user_id = null; } guardarHub(h); console.log('TELEGRAM_UNICO_APAGADO.' + (opt.olvidar ? ' Token y chat olvidados.' : '')); return 0; }
  if (cmd === 'leer') { console.log(JSON.stringify(await vuelta({ pollS: 0 }))); return 0; }
  if (cmd === 'servir') { await servir(); return 0; }
  console.log('Uso: telegram-hub.cjs activar [--token=…] | registrar [--root=…] [--nombre=…] | quitar [nombre] | proyectos | estado | pin [--reemparejar] | desemparejar | desactivar [--olvidar] | servir');
  return 2;
}

module.exports = { main, vuelta, procesarUpdate, servir, vistaProyecto, recordarMensaje, proyectoDeMensaje, leerHub, estadoServicio, slugDe, homeDir };

if (require.main === module) {
  main(process.argv.slice(2), process.cwd()).then((c) => { if (typeof c === 'number') process.exitCode = c; }).catch((e) => { console.error('telegram-hub: ' + String(e && e.message || e).replace(/\d+:[A-Za-z0-9_-]{20,}/g, '***')); process.exitCode = 1; });
}
