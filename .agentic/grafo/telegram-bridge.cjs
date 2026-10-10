#!/usr/bin/env node
'use strict';
/**
 * Puente con Telegram — el chat del dueño con Agentix, desde cualquier sitio y sin abrir tu PC a internet.
 *
 * Por qué Telegram: su Bot API se consulta SALIENDO desde tu PC (long polling), así que no hace falta túnel, dominio ni servidor. La app de
 * Telegram del teléfono es el chat. Es opcional y está apagado por defecto.
 *
 *   tú → Agentix   texto libre → buzón (`@cursor …` para el constructor, `@director …`, `@todos …`; sin prefijo → Director)
 *                  `D-001 <decisión>` o el botón de una decisión → responde esa decisión del dueño
 *                  /estado /barra /tareas /decisiones /buzon /ayuda /desemparejar   (vista de PRODUCCIÓN, nunca código ni secretos)
 *   Agentix → tú   los mismos avisos que ntfy (tarea aceptada, decisión con botones A/B/C, algo no marcha, cierre…) y los acuses de tus
 *                  mensajes: 👀 entregado → 📖 leído → ✅ atendido (con la respuesta), y ⏰ si nadie lo atiende.
 *
 * Seguridad (leer):
 *   · el bot solo obedece a UN usuario: se empareja con `/start <PIN>` (PIN de 6 dígitos, vale 15 min, 5 intentos) y desde entonces solo
 *     atiende ese chat privado y ese usuario; cualquier otro es ignorado sin respuesta;
 *   · el token del bot es un secreto: queda en `.agentic/_telegram/config.json` (ignorado por git) y nunca se imprime ni se registra;
 *   · todo lo que escribes es DATO del dueño: responder una decisión «D-xxx» o pedir el estado es lo único que se ejecuta solo; lo demás lo
 *     lee el Director/constructor, que confirma en el chat cualquier acción destructiva o sensible;
 *   · se envía texto plano (sin formato interpretado) y hay tope de mensajes por minuto y por día.
 *
 *   node telegram-bridge.cjs activar [--token=…] [--sin-esperar]     (o AKDD_TELEGRAM_TOKEN en el entorno; sin token lo pide)
 *   node telegram-bridge.cjs estado | desactivar [--olvidar] | probar | pin | desemparejar
 *   node telegram-bridge.cjs enviar "texto"
 *   node telegram-bridge.cjs servir        (servicio: recibe tus mensajes, avisa y escala lo que nadie atiende)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const dir = (root) => path.join(root, '.agentic', '_telegram');
const arch = (root, n) => path.join(dir(root), n);
const leerJ = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
function escribirJ(p, o, privado) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const t = p + '.' + process.pid + '.tmp'; fs.writeFileSync(t, JSON.stringify(o, null, 2), privado ? { mode: 0o600 } : undefined);
  try { fs.renameSync(t, p); } catch { fs.writeFileSync(p, JSON.stringify(o, null, 2)); try { fs.unlinkSync(t); } catch { /* ya */ } }
}
const corto = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const hoy = () => new Date().toISOString().slice(0, 10);
const NL = String.fromCharCode(10);

const PIN_VALE_MS = 15 * 60 * 1000;
const PIN_INTENTOS = 5;
const MAX_POR_MIN = 20;
const TICK_CADA_MS = 20 * 1000;

const leerConfigPropia = (root) => leerJ(arch(root, 'config.json'), null);
const guardarConfig = (root, c) => escribirJ(arch(root, 'config.json'), c, true);
/** Un proyecto usa SU bot si lo activó; si no, el bot único del dueño (telegram-hub.cjs) cuando el proyecto está registrado en él. */
function leerConfig(root) {
  const own = leerConfigPropia(root);
  if (own && own.activo) return own;
  try { const v = require('./telegram-hub.cjs').vistaProyecto(root); if (v) return v; } catch { /* sin hub */ }
  return own;
}
const leerEstado = (root) => leerJ(arch(root, 'estado.json'), { offset: 0, enviados: 0, dia: '' });
const guardarEstado = (root, e) => escribirJ(arch(root, 'estado.json'), e);

/** El token y los mensajes son privados: que nunca se suban a git por descuido. */
function asegurarIgnorado(root) {
  try {
    if (!fs.existsSync(path.join(root, '.git'))) return;
    const g = path.join(root, '.gitignore'); let t = fs.existsSync(g) ? fs.readFileSync(g, 'utf8') : '';
    for (const d of ['.agentic/_telegram/', '.agentic/_buzon/']) {
      if (!t.split(NL).some((l) => l.trim().replace(/\/$/, '') === d.replace(/\/$/, ''))) t = t + (t && !t.endsWith(NL) ? NL : '') + d + NL;
    }
    fs.writeFileSync(g, t);
  } catch { /* si no se puede, el aviso de activar lo recuerda */ }
}

// ───────────────────────────── red ─────────────────────────────
const base = () => String(process.env.AKDD_TELEGRAM_API || 'https://api.telegram.org').replace(/\/$/, '');
/** Nada que salga de aquí lleva el token. */
const limpiar = (s, token) => { let t = String(s == null ? '' : s); if (token) t = t.split(token).join('***'); return corto(t.replace(/bot\d+:[A-Za-z0-9_-]{20,}/g, 'bot***'), 140); };

/** Cortes de red típicos de una conexión reutilizada que el servidor ya cerró: no llegaron a procesarse, se reintenta una vez. */
const CORTE_DE_CONEXION = /ECONNRESET|UND_ERR_SOCKET|EPIPE|socket hang up|other side closed/i;
async function api(cfg, metodo, params, timeoutMs) {
  let ultimo = null;
  for (let intento = 0; intento < 2; intento++) {
    try {
      const r = await fetch(base() + '/bot' + cfg.token + '/' + metodo, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params || {}), signal: AbortSignal.timeout(timeoutMs || 15000) });
      const j = await r.json().catch(() => null);
      if (!j || !j.ok) return { ok: false, causa: 'HTTP_' + r.status + (j && j.description ? ': ' + limpiar(j.description, cfg.token) : ''), codigo: (j && j.error_code) || r.status, esperar: j && j.parameters && j.parameters.retry_after };
      return { ok: true, resultado: j.result };
    } catch (e) {
      const msg = String(e && (e.cause ? (e.cause.code || e.cause.message) : e.message));
      ultimo = { ok: false, causa: 'RED: ' + limpiar(e && (e.cause ? e.cause.message : e.message), cfg.token), codigo: 0 };
      if (!(CORTE_DE_CONEXION.test(msg) || CORTE_DE_CONEXION.test(String(e && e.message)))) return ultimo;
    }
  }
  return ultimo;
}

/** Parte un texto largo en trozos que caben en un mensaje de Telegram (4096), cortando por líneas. */
function trocear(texto, max = 3800) {
  const t = String(texto == null ? '' : texto); if (t.length <= max) return [t];
  const out = []; let cur = '';
  for (const linea of t.split(NL)) {
    if (linea.length > max) { if (cur) { out.push(cur); cur = ''; } for (let i = 0; i < linea.length; i += max) out.push(linea.slice(i, i + max)); continue; }
    if ((cur + NL + linea).length > max && cur) { out.push(cur); cur = linea; } else cur = cur ? cur + NL + linea : linea;
  }
  if (cur) out.push(cur);
  return out;
}

/** Opciones de una decisión («A|B|C» o «A, B»). */
function opcionesDe(texto) {
  return String(texto || '').split(/\s*[|;]\s*|\s*,\s*(?![^()]*\))/).map((x) => x.trim()).filter(Boolean).slice(0, 6);
}
function tecladoDecision(decision, slug) {
  if (!decision || !decision.id) return undefined;
  const ops = opcionesDe(decision.opciones); if (!ops.length) return undefined;
  const filas = []; for (let i = 0; i < ops.length; i += 2) filas.push(ops.slice(i, i + 2).map((o, k) => ({ text: corto(o, 40), callback_data: (slug ? `d|${slug}|` : 'd|') + `${decision.id}|${i + k}` })));
  return { inline_keyboard: filas };
}

async function enviarA(cfg, chatId, texto, extra) {
  if (cfg.prefijo && !String(texto).startsWith(cfg.prefijo)) texto = cfg.prefijo + String(texto == null ? '' : texto); // bot único: cada aviso dice de qué proyecto es
  const trozos = trocear(texto); let ult = { ok: true };
  for (let i = 0; i < trozos.length; i++) {
    const p = Object.assign({ chat_id: chatId, text: trozos[i], disable_web_page_preview: true }, extra || {});
    if (i < trozos.length - 1) { delete p.reply_markup; }
    ult = await api(cfg, 'sendMessage', p);
    if (!ult.ok && ult.esperar) { await new Promise((r) => setTimeout(r, Math.min(ult.esperar, 5) * 1000)); ult = await api(cfg, 'sendMessage', p); }
    if (!ult.ok) return ult;
    if (cfg.hub && ult.resultado) { try { require('./telegram-hub.cjs').recordarMensaje(ult.resultado.message_id, cfg.slug); } catch { /* auxiliar */ } }
  }
  return ult;
}

/** Avisos hacia el teléfono (los mismos que ntfy). → { ok, causa } */
async function difundir(root, { titulo, texto, prioridad, decision }) {
  const cfg = leerConfig(root); if (!cfg || !cfg.activo || !cfg.chat_id) return { ok: false, causa: 'NO_EMPAREJADO' };
  const est = leerEstado(root); if (est.dia !== hoy()) { est.dia = hoy(); est.enviados = 0; }
  if (est.enviados >= (cfg.max_dia || 300)) return { ok: false, causa: 'TOPE_DIARIO' };
  const r = await enviarA(cfg, cfg.chat_id, (titulo ? titulo + NL + NL : '') + String(texto == null ? '' : texto), { disable_notification: (prioridad || 3) <= 2, reply_markup: tecladoDecision(decision, cfg.hub ? cfg.slug : undefined) });
  if (r.ok) { const f = leerEstado(root); f.enviados = (f.dia === est.dia ? (f.enviados || 0) : 0) + 1; f.dia = est.dia; guardarEstado(root, f); }
  return { ok: r.ok, causa: r.ok ? undefined : r.causa };
}

// ───────────────────────────── datos de producción (solo lectura) ─────────────────────────────
function salud(root) { try { const f = path.join(root, '.agentic', 'grafo', 'teams.cjs'); return fs.existsSync(f) ? require(f).salud(root) : null; } catch { return null; } }
function barraTexto(d) {
  if (!d || !d.segmentos || !d.segmentos.total) return 'Aún no hay tareas medibles.';
  const g = d.segmentos; const L = [`🟩 ${g.verde} terminadas (${g.pct.verde}%)  🟦 ${g.azul} en curso (${g.pct.azul}%)  🟧 ${g.naranja} parciales (${g.pct.naranja}%)  🟥 ${g.rojo} faltan (${g.pct.rojo}%)`];
  if (d.fin === 'TERMINADO') L.push('✅ Todo en verde: nada más que hacer.'); else if (d.fin === 'ESPERA_DUENO') L.push('⏸ Recorrido completo: solo queda lo que depende de ti.');
  return L.join(NL);
}
function resumen(root) {
  const d = salud(root); if (!d) return 'Sin canal TEAMS activo en este proyecto.';
  let base0 = ''; try { base0 = require('./ntfy-bridge.cjs').resumenTexto(root, d); } catch { base0 = `Canal ${d.canal} · semáforo ${d.semaforo}`; }
  return base0 + NL + NL + barraTexto(d);
}
function tareasTexto(root) {
  const d = salud(root); if (!d || !d.cola) return 'Sin canal TEAMS activo en este proyecto.';
  const L = []; const lista = (t, arr) => { if (arr && arr.length) { L.push(t + ' (' + arr.length + '):'); for (const x of arr.slice(0, 8)) L.push(`  · ${x.id} ${corto(x.titulo, 80)}`); if (arr.length > 8) L.push(`  … y ${arr.length - 8} más`); } };
  lista('🟦 Por aceptar', d.cola.por_aceptar); lista('🟧 Devueltas / parciales', d.cola.devueltas); lista('🟥 En cola', d.cola.tareas);
  return L.length ? L.join(NL) : 'No hay tareas en cola.';
}

// ───────────────────────────── procesar lo que llega ─────────────────────────────
const AYUDA = [
  'Agentix en Telegram. Escribe normal y le llega al Director (Claude Code); con «@cursor …» al constructor; «@todos …» a los dos.',
  '',
  '/estado — avance, tiempo y lo que falta',
  '/barra — la barra de avance (verde · azul · naranja · rojo)',
  '/tareas — qué hay por aceptar, devuelto y en cola',
  '/decisiones — lo que espera tu respuesta (con botones)',
  '/buzon — tus mensajes y en qué punto van (recibido · entregado · leído · atendido)',
  'D-001 <decisión> — responde una decisión escribiendo',
  '/desemparejar — este chat deja de ser el del dueño',
].join(NL);

function decidir(root, id, resp, via) {
  const T = path.join(root, '.agentic', 'grafo', 'teams.cjs');
  const r = spawnSync(process.execPath, [T, 'decidir', id, resp, '--porque=respondida por el dueño desde ' + via], { cwd: root, encoding: 'utf8', timeout: 60000 });
  return { ok: r.status === 0, salida: corto((r.stdout || '') + ' ' + (r.stderr || ''), 160) };
}

/** Un update de Telegram. Idempotente: el mismo update_id nunca se procesa dos veces (lo garantiza el offset + el id del buzón). */
async function procesarUpdate(root, cfg, u, ctx) {
  const msg = u.message; const cb = u.callback_query;
  const chat = msg ? msg.chat : (cb && cb.message ? cb.message.chat : null); const from = msg ? msg.from : (cb ? cb.from : null);
  if (!chat || !from) return { accion: 'IGNORADO' };

  // ── emparejado: solo /start <PIN> es válido mientras no hay chat; después, solo ese chat privado y ese usuario ──
  if (!cfg.chat_id) {
    const m = msg && /^\/start(?:@\w+)?(?:\s+(\d{6}))?\s*$/.exec(String(msg.text || ''));
    if (!m || chat.type !== 'private') return { accion: 'IGNORADO' };
    if (!m[1]) { // «Iniciar» sin PIN: solo se contesta si hay un emparejado pendiente (si no, el bot guarda silencio)
      if (cfg.pin && Date.now() < (cfg.pin_expira || 0)) await enviarA(cfg, chat.id, 'Para emparejar este chat escribe:  /start y los 6 dígitos del PIN que te dio tu PC (telegram-bridge.cjs pin).');
      return { accion: 'IGNORADO' };
    }
    const ok = !!(cfg.pin && Date.now() < (cfg.pin_expira || 0) && (cfg.pin_fallos || 0) < PIN_INTENTOS
      && crypto.timingSafeEqual(crypto.createHash('sha256').update(m[1]).digest(), crypto.createHash('sha256').update(String(cfg.pin)).digest()));
    if (!ok) {
      cfg.pin_fallos = (cfg.pin_fallos || 0) + 1; if (cfg.pin_fallos >= PIN_INTENTOS) { cfg.pin = null; }
      guardarConfig(root, cfg);
      await enviarA(cfg, chat.id, 'No pude emparejar este chat (PIN incorrecto o vencido). Pide uno nuevo en tu PC: telegram-bridge.cjs pin');
      return { accion: 'PIN_MALO' };
    }
    Object.assign(cfg, { chat_id: chat.id, user_id: from.id, nombre: corto(from.first_name || from.username || '', 40), pin: null, pin_expira: null, pin_fallos: 0, emparejado_at: new Date().toISOString() });
    guardarConfig(root, cfg);
    await enviarA(cfg, chat.id, '✅ Emparejado. Desde ahora este chat es el del dueño de «' + path.basename(root) + '».' + NL + NL + AYUDA);
    return { accion: 'EMPAREJADO' };
  }
  if (chat.id !== cfg.chat_id || from.id !== cfg.user_id || chat.type !== 'private') return { accion: 'IGNORADO' };

  // ── tope por minuto (en memoria del servicio) ──
  const ahora = Date.now(); ctx.ventana = (ctx.ventana || []).filter((t) => ahora - t < 60000); ctx.ventana.push(ahora);
  if (ctx.ventana.length > MAX_POR_MIN) { if (!ctx.avisoTope || ahora - ctx.avisoTope > 60000) { ctx.avisoTope = ahora; await enviarA(cfg, chat.id, 'Demasiados mensajes seguidos: espera un minuto.'); } return { accion: 'TOPE' }; }

  // ── botón de una decisión ──
  if (cb) {
    const m = /^d\|(D-\d+)\|(\d)$/.exec(String(cb.data || ''));
    if (!m) { await api(cfg, 'answerCallbackQuery', { callback_query_id: cb.id }); return { accion: 'IGNORADO' }; }
    const d = salud(root); const x = d && d.cola && d.cola.decisiones_dueno.find((y) => y.id === m[1]);
    const op = x ? opcionesDe(x.opciones)[Number(m[2])] : null;
    if (!x || !op) { await api(cfg, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'Esa decisión ya no está abierta.' }); return { accion: 'DECISION_CERRADA' }; }
    const r = decidir(root, m[1], op, 'Telegram (botón)');
    await api(cfg, 'answerCallbackQuery', { callback_query_id: cb.id, text: r.ok ? 'Registrada: ' + corto(op, 60) : 'No pude registrarla.' });
    if (cb.message) await api(cfg, 'editMessageReplyMarkup', { chat_id: chat.id, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } });
    await enviarA(cfg, chat.id, r.ok ? `✔ ${m[1]} resuelta: ${op}. El Director la verá en su próxima revisión.` : `✖ No pude resolver ${m[1]}: ${r.salida}`);
    return { accion: 'DECISION', ok: r.ok };
  }

  const texto = String(msg.text || '').trim(); if (!texto) return { accion: 'IGNORADO' };
  const cmd = /^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(texto);
  if (cmd) {
    const c = cmd[1].toLowerCase();
    if (c === 'start' || c === 'ayuda' || c === 'help') { await enviarA(cfg, chat.id, AYUDA); return { accion: 'AYUDA' }; }
    if (c === 'estado') { await enviarA(cfg, chat.id, '📊 Estado' + NL + NL + resumen(root)); return { accion: 'ESTADO' }; }
    if (c === 'barra') { await enviarA(cfg, chat.id, barraTexto(salud(root))); return { accion: 'BARRA' }; }
    if (c === 'tareas') { await enviarA(cfg, chat.id, tareasTexto(root)); return { accion: 'TAREAS' }; }
    if (c === 'decisiones') {
      const d = salud(root); const ds = (d && d.cola && d.cola.decisiones_dueno) || [];
      if (!ds.length) await enviarA(cfg, chat.id, 'No hay decisiones tuyas pendientes.');
      for (const x of ds.slice(0, 5)) await enviarA(cfg, chat.id, `❓ ${x.id} — ${x.titulo}${x.detalle ? NL + corto(x.detalle, 500) : ''}${x.opciones ? NL + 'Opciones: ' + x.opciones : ''}${x.recomendacion ? NL + 'Recomiendo: ' + x.recomendacion : ''}`, { reply_markup: tecladoDecision(x, cfg.hub ? cfg.slug : undefined) });
      return { accion: 'DECISIONES' };
    }
    if (c === 'buzon') {
      const B = require('./buzon.cjs'); const l = B.listar(root).filter((m) => m.canal === 'telegram').slice(-8);
      const ic = { recibido: '📥', entregado: '👀', leido: '📖', atendido: '✅' };
      await enviarA(cfg, chat.id, l.length ? l.map((m) => `${ic[m.estado] || '·'} ${m.estado} → ${m.para === 'builder' ? 'Cursor' : 'Director'}: ${corto(m.texto, 70)}`).join(NL) : 'Aún no me has escrito nada.');
      return { accion: 'BUZON' };
    }
    if (c === 'desemparejar') { cfg.chat_id = null; cfg.user_id = null; cfg.nombre = null; guardarConfig(root, cfg); await enviarA({ token: cfg.token }, chat.id, 'Listo: este chat ya no es el del dueño. Para volver a emparejar, genera un PIN en tu PC.'); return { accion: 'DESEMPAREJADO' }; }
    await enviarA(cfg, chat.id, 'No conozco /' + c + '. Escribe /ayuda.'); return { accion: 'COMANDO_DESCONOCIDO' };
  }
  const dec = /^(D-\d+)[\s:,-]+([\s\S]+)$/i.exec(texto);
  if (dec) {
    const id = dec[1].toUpperCase(); const r = decidir(root, id, dec[2].trim(), 'Telegram');
    await enviarA(cfg, chat.id, r.ok ? `✔ ${id} resuelta: ${corto(dec[2], 200)}. El Director la verá en su próxima revisión.` : `✖ No pude resolver ${id}: ${r.salida}`);
    return { accion: 'DECISION', ok: r.ok };
  }
  if (/^(estado|\?|avance|reporte)$/i.test(texto)) { await enviarA(cfg, chat.id, '📊 Estado' + NL + NL + resumen(root)); return { accion: 'ESTADO' }; }

  // texto libre → buzón (idempotente por update_id)
  const B = require('./buzon.cjs');
  const r = B.agregar(root, { id: 'tg-' + u.update_id, canal: 'telegram', texto, t: new Date((msg.date || Math.floor(ahora / 1000)) * 1000).toISOString() });
  if (r.duplicado || r.vacio || !r.agregados.length) return { accion: 'DUPLICADO' };
  const quien = r.agregados.map((x) => (x.para === 'builder' ? 'el constructor (Cursor)' : 'el Director (Claude Code)')).join(' y ');
  await enviarA(cfg, chat.id, `📥 Recibido (${r.agregados[0].id}) → ${quien}.${NL}Te aviso cuando lo vea, lo lea y lo atienda.`, { reply_to_message_id: msg.message_id });
  return { accion: 'BUZON', ids: r.agregados.map((x) => x.id) };
}

/** Una vuelta de entrada (getUpdates) — sirve tanto al servicio como a `leer`. */
async function vuelta(root, opts = {}) {
  const cfg = leerConfig(root); if (!cfg || !cfg.activo) return { recibidos: 0, motivo: 'APAGADO' };
  const est = leerEstado(root); const ctx = opts.ctx || {};
  const r = await api(cfg, 'getUpdates', { offset: est.offset || 0, timeout: opts.pollS === undefined ? 25 : opts.pollS, allowed_updates: ['message', 'callback_query'] }, ((opts.pollS === undefined ? 25 : opts.pollS) + 10) * 1000);
  if (!r.ok) return { recibidos: 0, error: r.causa, codigo: r.codigo };
  let n = 0;
  for (const u of (r.resultado || []).sort((a, b) => a.update_id - b.update_id)) {
    let c = leerConfig(root) || cfg;
    try { await procesarUpdate(root, c, u, ctx); n++; } catch (e) { console.error('telegram: update ' + u.update_id + ': ' + limpiar(e.message, cfg.token)); }
    const f = leerEstado(root); f.offset = u.update_id + 1; f.ult_update_at = new Date().toISOString(); guardarEstado(root, f); // el offset avanza SIEMPRE: un update malo no se repite en bucle
  }
  return { recibidos: n };
}

// ───────────────────────────── servicio ─────────────────────────────
function estadoServicio(root) {
  const v = leerJ(arch(root, 'servicio.json'), null); if (!v) return { vivo: false };
  let proceso = false; try { process.kill(v.pid, 0); proceso = true; } catch { proceso = false; }
  const hace = Math.round((Date.now() - Date.parse(v.latido)) / 1000);
  return { vivo: proceso && hace < 90, pid: v.pid, latido_hace_s: hace };
}
async function servir(root, opts = {}) {
  const cfg0 = leerConfig(root); if (!cfg0 || !cfg0.activo) { console.log('Telegram está apagado: «activar» primero.'); return; }
  const otro = estadoServicio(root); if (otro.vivo && otro.pid !== process.pid) { console.log('Ya hay un servicio de Telegram vivo (pid ' + otro.pid + '): no lanzo otro.'); return; }
  console.log('telegram: servicio en marcha. Ctrl+C para detener.');
  let corriendo = true; const parar = () => { corriendo = false; try { const v = leerJ(arch(root, 'servicio.json'), null); if (v && v.pid === process.pid) fs.unlinkSync(arch(root, 'servicio.json')); } catch { /* ya */ } };
  process.on('SIGINT', () => { parar(); process.exit(0); }); process.on('SIGTERM', () => { parar(); process.exit(0); });
  const ctx = {}; let fallos = 0; let ultTick = 0;
  while (corriendo) {
    const c = leerConfig(root); if (!c || !c.activo) { console.log('telegram desactivado: el servicio termina.'); parar(); return; }
    escribirJ(arch(root, 'servicio.json'), { pid: process.pid, latido: new Date().toISOString() });
    const r = await vuelta(root, { ctx, pollS: opts.pollS });
    if (r.error) {
      if (r.codigo === 401) { console.error('telegram: el token fue rechazado (401). Servicio detenido: revisa el token con «activar».'); parar(); return; }
      fallos++; const espera = Math.min(60000, 1000 * Math.pow(2, Math.min(fallos, 6)));
      if (fallos === 1 || fallos % 10 === 0) console.error('telegram: ' + r.error + ' (reintento en ' + Math.round(espera / 1000) + ' s)');
      if (opts.una) return;
      await new Promise((res) => setTimeout(res, opts.sinEsperas ? 10 : espera));
    } else fallos = 0;
    if (c.chat_id && Date.now() - ultTick >= (opts.tickMs || TICK_CADA_MS)) {
      ultTick = Date.now();
      try { await require('./ntfy-bridge.cjs').tick(root); } catch (e) { console.error('telegram: tick: ' + limpiar(e.message, c.token)); }
    }
    heartbeat(root);
    if (opts.una) return;
    if (!r.error && (opts.pollS === 0)) await new Promise((res) => setTimeout(res, opts.esperaMs || 1000));
  }
}
const heartbeat = (root) => { try { escribirJ(arch(root, 'servicio.json'), { pid: process.pid, latido: new Date().toISOString() }); } catch { /* sin disco */ } };

// ───────────────────────────── comandos ─────────────────────────────
function parseArgs(a) { const opt = {}; const libres = []; for (const x of a) { const m = /^--([^=]+)(?:=(.*))?$/.exec(x); if (m) opt[m[1]] = m[2] === undefined ? true : m[2]; else libres.push(x); } return { opt, libres }; }
const nuevoPin = () => String(crypto.randomInt(100000, 1000000));
async function pedirToken() {
  if (!process.stdin.isTTY) return '';
  const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
  return await new Promise((res) => rl.question('Pega el token de tu bot (lo da @BotFather): ', (t) => { rl.close(); res(String(t || '').trim()); }));
}
async function main(argv, root) {
  const { opt, libres } = parseArgs(argv); const cmd = libres[0] || 'estado';
  if (cmd === 'hub') return await require('./telegram-hub.cjs').main(libres.slice(1).concat(Object.entries(opt).map(([k, v]) => (v === true ? '--' + k : '--' + k + '=' + v))), root);
  if (cmd === 'activar') {
    const prev = leerConfig(root) || {};
    let token = String(opt.token && opt.token !== true ? opt.token : (process.env.AKDD_TELEGRAM_TOKEN || prev.token || '')).trim();
    if (!token) token = await pedirToken();
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) { console.log('TELEGRAM_FALLO: falta un token válido. Créalo hablando con @BotFather en Telegram (/newbot) y pásalo con --token=… o en AKDD_TELEGRAM_TOKEN.'); return 1; }
    const yo = await api({ token }, 'getMe', {});
    if (!yo.ok) { console.log('TELEGRAM_FALLO: Telegram no aceptó el token (' + yo.causa + '). No quedó activo.'); return 1; }
    const cfg = Object.assign({ max_dia: 300, escalar_min: 10 }, prev, { activo: true, token, bot: { id: yo.resultado.id, username: yo.resultado.username }, pin: nuevoPin(), pin_expira: Date.now() + PIN_VALE_MS, pin_fallos: 0 });
    if (opt.reemparejar || prev.token !== token) { cfg.chat_id = null; cfg.user_id = null; }
    guardarConfig(root, cfg); asegurarIgnorado(root);
    if (!fs.existsSync(arch(root, 'estado.json'))) guardarEstado(root, { offset: 0, enviados: 0, dia: '' });
    console.log([
      cfg.chat_id ? 'TELEGRAM_ACTIVO — este proyecto ya tenía un chat emparejado (usa «pin» + --reemparejar para cambiarlo).' : 'TELEGRAM_ACTIVO — falta emparejar tu chat:',
      ...(cfg.chat_id ? [] : [
        '',
        `  1) Abre Telegram y busca a @${cfg.bot.username}  (https://t.me/${cfg.bot.username})`,
        `  2) Pulsa «Iniciar» o escríbele:  /start ${cfg.pin}`,
        '     (el PIN vale 15 minutos y 5 intentos; solo ese chat quedará autorizado)',
      ]),
      '',
      'Para que Agentix reciba tus mensajes y te avise, deja corriendo en segundo plano:  node .agentic/grafo/telegram-bridge.cjs servir',
    ].join(NL));
    if (!cfg.chat_id && !opt['sin-esperar']) {
      const limite = Date.now() + (Number(opt.espera) || 120) * 1000; const ctx = {};
      process.stdout.write('Esperando tu /start (hasta ' + (Number(opt.espera) || 120) + ' s)… ');
      while (Date.now() < limite) {
        await vuelta(root, { ctx, pollS: 5 });
        const c = leerConfig(root); if (c && c.chat_id) { console.log('emparejado ✔'); return 0; }
      }
      console.log('no llegó. Cuando abras el chat, el servicio lo empareja solo (el PIN sigue vigente).');
    }
    return 0;
  }
  const cfg = leerConfig(root);
  if (cfg && cfg.hub && ['pin', 'desemparejar', 'servir', 'leer', 'desactivar'].includes(cmd)) { console.log('Este proyecto usa el bot ÚNICO («' + cfg.slug + '»): usa  node .agentic/grafo/telegram-hub.cjs ' + cmd + '  (o «hub ' + cmd + '» aquí).'); return 1; }
  if (cmd === 'estado') {
    if (cfg && cfg.hub) { console.log('TELEGRAM_ACTIVO vía el bot ÚNICO · proyecto «' + cfg.slug + '» · bot @' + (cfg.bot && cfg.bot.username) + ' · ' + (cfg.chat_id ? 'chat EMPAREJADO' : 'chat SIN EMPAREJAR') + ' · servicio ' + (require('./telegram-hub.cjs').estadoServicio().vivo ? 'VIVO' : 'PARADO — node .agentic/grafo/telegram-hub.cjs servir')); return 0; }
    if (!cfg || !cfg.activo) { console.log('TELEGRAM_APAGADO — «activar» lo enciende (opcional; Agentix funciona igual sin esto).'); return 0; }
    const sv = estadoServicio(root); const est = leerEstado(root);
    console.log(`TELEGRAM_ACTIVO · bot @${cfg.bot && cfg.bot.username} · chat ${cfg.chat_id ? 'EMPAREJADO (' + (cfg.nombre || 'dueño') + ')' : 'SIN EMPAREJAR' + (cfg.pin && Date.now() < cfg.pin_expira ? ' (PIN vigente)' : ' (sin PIN: corre «pin»)')} · servicio ${sv.vivo ? 'VIVO (latido hace ' + sv.latido_hace_s + ' s)' : 'PARADO — lánzalo: node .agentic/grafo/telegram-bridge.cjs servir'} · avisos hoy ${est.dia === hoy() ? est.enviados : 0}`);
    return 0;
  }
  if (cmd === 'desactivar') { if (cfg) { cfg.activo = false; if (opt.olvidar) { cfg.token = null; cfg.chat_id = null; cfg.user_id = null; } guardarConfig(root, cfg); } console.log('TELEGRAM_APAGADO.' + (opt.olvidar ? ' Token y chat olvidados.' : '')); return 0; }
  if (!cfg || !cfg.activo) { console.log('Telegram está apagado: «activar» primero.'); return 1; }
  if (cmd === 'pin') {
    cfg.pin = nuevoPin(); cfg.pin_expira = Date.now() + PIN_VALE_MS; cfg.pin_fallos = 0; if (opt.reemparejar) { cfg.chat_id = null; cfg.user_id = null; }
    guardarConfig(root, cfg); console.log(cfg.chat_id ? 'Ya hay un chat emparejado. Para cambiarlo: pin --reemparejar' : `Escribe en @${cfg.bot.username}:  /start ${cfg.pin}   (vale 15 minutos)`); return 0;
  }
  if (cmd === 'desemparejar') { cfg.chat_id = null; cfg.user_id = null; cfg.nombre = null; guardarConfig(root, cfg); console.log('Chat desemparejado.'); return 0; }
  if (cmd === 'enviar' || cmd === 'avisar') {
    const texto = libres.slice(1).join(' ').trim(); if (!texto) { console.log('Uso: enviar "texto"'); return 2; }
    const r = await difundir(root, { titulo: 'Agentix', texto, prioridad: 3 }); console.log(r.ok ? 'Enviado a Telegram.' : 'NO se envió: ' + r.causa); return r.ok ? 0 : 1;
  }
  if (cmd === 'probar') { const r = await difundir(root, { titulo: 'Prueba', texto: 'Prueba de Agentix ' + new Date().toLocaleTimeString(), prioridad: 3 }); console.log(r.ok ? 'Enviado.' : 'NO se envió: ' + r.causa); return r.ok ? 0 : 1; }
  if (cmd === 'leer') { const r = await vuelta(root, { pollS: 0 }); console.log(JSON.stringify(r)); return 0; }
  if (cmd === 'servir') { await servir(root); return 0; }
  console.log('Uso: telegram-bridge.cjs activar [--token=…] | estado | desactivar [--olvidar] | probar | pin [--reemparejar] | desemparejar | enviar "texto" | leer | servir');
  return 2;
}

module.exports = { _i: { api, enviarA, salud, procesarUpdate, limpiar, asegurarIgnorado, estadoServicio, leerConfigPropia, guardarConfigPropia: guardarConfig }, main, activar: (root, a) => main(['activar', ...(a || [])], root), difundir, leerConfig, vuelta, procesarUpdate, servir, estadoServicio, opcionesDe, tecladoDecision, trocear, barraTexto, limpiar };

if (require.main === module) {
  let root = process.cwd(); const a = process.argv.slice(2); const i = a.findIndex((x) => x.startsWith('--root='));
  if (i >= 0) { root = path.resolve(a[i].slice(7)); a.splice(i, 1); }
  main(a, root).then((c) => { if (typeof c === 'number') process.exitCode = c; }).catch((e) => { console.error('telegram: ' + String(e && e.message || e).replace(/\d+:[A-Za-z0-9_-]{20,}/g, '***')); process.exitCode = 1; });
}
