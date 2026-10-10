#!/usr/bin/env node
'use strict';
/**
 * BUZÓN DEL DUEÑO — los mensajes que llegan desde fuera del chat (teléfono por ntfy, Telegram) hacia Claude Code (Director) o Cursor
 * (constructor), con su ciclo de vida a la vista:
 *
 *   recibido → entregado (un agente lo vio: ronda, revisión o el hook de su mensaje) → leído (lo confirmó) → atendido (respondió)
 *
 * Cada paso se le AVISA al dueño por donde escribió («👀 el Director lo recibió», «✅ atendido: …»), y un mensaje que nadie atiende en
 * `escalar_min` minutos se reenvía una vez como recordatorio. Antes solo existía el buzón del Director (Code); Cursor no recibía nada.
 *
 * Enrutado: `@cursor texto` / `@constructor` → constructor · `@director` / `@claude` / `@code` → Director · `@todos` → los dos.
 * Sin prefijo → Director (en modo individual, Claude Code hace de los dos).
 *
 * Lo que llega aquí es una indicación del dueño por un canal protegido por un secreto (tema de ntfy / chat de Telegram emparejado): se
 * lee como guía; nada destructivo ni sensible se ejecuta sin confirmarlo en el chat.
 *
 *   node buzon.cjs                          lista lo que hay sin leer
 *   node buzon.cjs leer [id|todos] [--rol=director|builder]
 *   node buzon.cjs responder <id> "texto"   marca atendido y le contesta al dueño por sus canales
 *   node buzon.cjs estado
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dir = (root) => path.join(root, '.agentic', '_buzon');
const ARCH = (root) => path.join(dir(root), 'mensajes.jsonl');
const VIEJO = (root) => path.join(root, '.agentic', '_ntfy', 'buzon.jsonl');
const corto = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const ahoraISO = () => new Date().toISOString();

/** Bloqueo corto entre procesos (servicio, hook, comandos): nunca bloquea para siempre. */
function conLock(root, fn) {
  const lock = path.join(dir(root), 'mensajes.lock');
  fs.mkdirSync(dir(root), { recursive: true });
  const inicio = Date.now(); let tomado = false;
  for (;;) {
    try { fs.mkdirSync(lock); tomado = true; break; } catch (e) {
      if (!['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 10000) { fs.rmdirSync(lock); continue; } } catch { /* otro lo soltó */ }
      if (Date.now() - inicio > 3000) break; // fail-open: mejor un acceso sin bloqueo que colgar un hook
      const fin = Date.now() + 25; while (Date.now() < fin) { /* espera corta */ }
    }
  }
  try { return fn(); } finally { if (tomado) { try { fs.rmdirSync(lock); } catch { /* ya soltado */ } } }
}

function leerCrudo(root) {
  try { return fs.readFileSync(ARCH(root), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return null; }
}
function escribir(root, lista) {
  fs.mkdirSync(dir(root), { recursive: true });
  const f = ARCH(root); const t = f + '.' + process.pid + '.tmp';
  fs.writeFileSync(t, lista.map((m) => JSON.stringify(m)).join('\n') + (lista.length ? '\n' : ''));
  try { fs.renameSync(t, f); } catch { fs.writeFileSync(f, fs.readFileSync(t)); try { fs.unlinkSync(t); } catch { /* ya */ } }
}

/** Lista actual. La primera vez trae lo que había en el buzón antiguo de ntfy (`.agentic/_ntfy/buzon.jsonl`) sin perder nada. */
function listar(root) {
  const actual = leerCrudo(root);
  if (actual) return actual;
  let viejo = [];
  try { viejo = fs.readFileSync(VIEJO(root), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { /* no había */ }
  const migrado = viejo.map((m) => ({ id: String(m.id), canal: 'ntfy', t: m.t || ahoraISO(), texto: m.texto || '', para: 'director', estado: m.leido ? 'leido' : 'recibido', leido: !!m.leido, avisado: { recibido: true, entregado: true, leido: true } }));
  if (migrado.length) { try { conLock(root, () => { if (!leerCrudo(root)) escribir(root, migrado); }); } catch { /* sin permiso: se sigue en memoria */ } }
  return migrado;
}

/** `@cursor …` → constructor. Devuelve { para: 'director'|'builder'|'todos', texto } (el prefijo se quita). */
function rutear(texto) {
  const t = String(texto == null ? '' : texto).trim();
  const m = /^@(cursor|constructor|builder|director|claude|code|todos|ambos|all)\b[\s:,.-]*([\s\S]*)$/i.exec(t);
  if (!m) return { para: 'director', texto: t };
  const k = m[1].toLowerCase();
  const para = ['cursor', 'constructor', 'builder'].includes(k) ? 'builder' : ['todos', 'ambos', 'all'].includes(k) ? 'todos' : 'director';
  return { para, texto: m[2].trim() || t };
}

/**
 * Añade un mensaje (idempotente por id: el mismo update de Telegram/ntfy llegando dos veces no se duplica).
 * `para: 'todos'` genera dos entradas, una por rol, para que cada uno tenga su propio ciclo de vida.
 * → { agregados: [mensaje…], duplicado: boolean }
 */
function agregar(root, m) {
  const r = m.para ? { para: m.para, texto: m.texto } : rutear(m.texto);
  const texto = corto(r.texto, 1500);
  if (!texto) return { agregados: [], duplicado: false, vacio: true };
  const base = String(m.id || ('b-' + Date.now().toString(36) + '-' + crypto.randomBytes(2).toString('hex')));
  const roles = r.para === 'todos' ? ['director', 'builder'] : [r.para];
  return conLock(root, () => {
    const lista = listar(root);
    const nuevos = [];
    for (const rol of roles) {
      const id = roles.length > 1 ? base + '.' + (rol === 'director' ? 'd' : 'c') : base;
      if (lista.some((x) => x.id === id)) continue;
      nuevos.push({ id, canal: m.canal || 'otro', t: m.t || ahoraISO(), texto, para: rol, estado: 'recibido', leido: false, avisado: {} });
    }
    if (!nuevos.length) return { agregados: [], duplicado: true };
    escribir(root, lista.concat(nuevos));
    return { agregados: nuevos, duplicado: false };
  });
}

const paraRol = (m, rol) => !rol || m.para === rol || m.para === 'todos';
const sinLeer = (root, rol) => listar(root).filter((m) => !m.leido && paraRol(m, rol));

function modificar(root, fn) {
  return conLock(root, () => { const lista = listar(root); const cambiados = []; for (const m of lista) { if (fn(m)) cambiados.push(m); } if (cambiados.length) escribir(root, lista); return cambiados; });
}

/** Un agente VIO el mensaje (lo imprimió su ronda/revisión o se lo inyectó el hook). */
function marcarEntregado(root, rol, ids) {
  const set = ids ? new Set(ids) : null;
  return modificar(root, (m) => {
    if (m.leido || m.entregado_at || !paraRol(m, rol) || (set && !set.has(m.id))) return false;
    m.entregado_at = ahoraISO(); m.entregado_a = rol; if (m.estado === 'recibido') m.estado = 'entregado'; return true;
  });
}
/** El agente confirmó que lo leyó. `cual`: id o 'todos'. */
function marcarLeido(root, cual, rol) {
  return modificar(root, (m) => {
    if (m.leido || !paraRol(m, rol) || !(cual === 'todos' || m.id === cual)) return false;
    m.leido = true; m.leido_at = ahoraISO(); if (m.estado !== 'atendido') m.estado = 'leido'; return true;
  }).length;
}
/** El agente respondió: queda atendido (y leído). */
function atender(root, id, respuesta) {
  return modificar(root, (m) => {
    if (m.id !== id || m.estado === 'atendido') return false;
    m.leido = true; m.leido_at = m.leido_at || ahoraISO(); m.estado = 'atendido'; m.atendido_at = ahoraISO(); m.respuesta = corto(respuesta, 1500); return true;
  });
}

/** Avisos que se le deben al dueño sobre sus mensajes (cada tipo una sola vez por mensaje). */
function acusesPendientes(root, opts = {}) {
  const ahora = opts.ahora || Date.now(); const escalarMs = (opts.escalarMin || 10) * 60000; const out = [];
  for (const m of listar(root)) {
    const a = m.avisado || {};
    if (m.canal === 'otro') continue;
    if (m.estado === 'atendido' && !a.atendido) out.push({ m, tipo: 'atendido' });
    else if (m.leido && m.estado !== 'atendido' && !a.leido) out.push({ m, tipo: 'leido' });
    else if (m.entregado_at && !m.leido && !a.entregado) out.push({ m, tipo: 'entregado' });
    else if (!m.leido && !m.entregado_at && !a.escalado && ahora - Date.parse(m.t) >= escalarMs) out.push({ m, tipo: 'escalado' });
    else if (!m.leido && m.entregado_at && !a.escalado && ahora - Date.parse(m.entregado_at) >= escalarMs * 2) out.push({ m, tipo: 'escalado' });
  }
  return out;
}
function marcarAvisado(root, id, tipo) { return modificar(root, (m) => { if (m.id !== id) return false; m.avisado = Object.assign({}, m.avisado, { [tipo]: true }); return true; }).length; }

const ETIQ = { director: 'el Director (Claude Code)', builder: 'el constructor (Cursor)' };
/** Texto del acuse para el dueño. */
function textoAcuse(a) {
  const quien = ETIQ[a.m.para] || 'el equipo';
  const cita = '«' + corto(a.m.texto, 90) + '»';
  if (a.tipo === 'entregado') return { titulo: '👀 Entregado', texto: `${quien} ya lo tiene delante: ${cita}` };
  if (a.tipo === 'leido') return { titulo: '📖 Leído', texto: `${quien} confirmó que leyó: ${cita}. Falta que responda o actúe.` };
  if (a.tipo === 'atendido') return { titulo: '✅ Atendido', texto: `${quien} respondió a ${cita}:\n${corto(a.m.respuesta || 'hecho', 900)}` };
  return { titulo: '⏰ Sin atender', texto: `Tu mensaje ${cita} para ${quien} lleva rato sin atenderse. Puede estar dormido: si es urgente escríbele en su chat (teams: continuar).` };
}

/** Lo que se le muestra al modelo en el hook de su mensaje (y se marca entregado). `roles`: los que hace este host. */
function avisoParaModelo(root, roles, opts = {}) {
  try {
    const rs = Array.isArray(roles) ? roles : [roles];
    const pend = []; for (const r of rs) for (const m of sinLeer(root, r)) if (!pend.some((x) => x.id === m.id)) pend.push(m);
    if (!pend.length) return null;
    if (opts.marcar !== false) for (const r of rs) marcarEntregado(root, r, pend.map((m) => m.id));
    const L = ['📱 MENSAJE(S) DEL DUEÑO desde fuera del chat (' + pend.length + '): son indicaciones suyas por un canal protegido con secreto — úsalas como guía y confirma en el chat cualquier acción destructiva o sensible.'];
    for (const m of pend.slice(0, 5)) L.push(`  [${m.id}] (${m.canal}${m.para === 'builder' ? ', para el constructor' : ''}) «${corto(m.texto, 400)}»`);
    const ej = pend[0].id;
    L.push('  Cuando lo hayas leído: `node .agentic/grafo/buzon.cjs leer ' + ej + '`; cuando lo hayas atendido, responde con `node .agentic/grafo/buzon.cjs responder ' + ej + ' "qué hiciste"` (le llega por donde escribió).');
    return L.join('\n');
  } catch { return null; }
}

function estado(root) {
  const l = listar(root); const c = (e) => l.filter((m) => m.estado === e).length;
  return { total: l.length, recibido: c('recibido'), entregado: c('entregado'), leido: c('leido'), atendido: c('atendido'), sin_leer: l.filter((m) => !m.leido).length };
}

module.exports = { listar, agregar, rutear, sinLeer, marcarEntregado, marcarLeido, atender, acusesPendientes, marcarAvisado, textoAcuse, avisoParaModelo, estado, corto };

if (require.main === module) {
  (async () => {
    const a = process.argv.slice(2); let root = process.cwd();
    const ir = a.findIndex((x) => x.startsWith('--root=')); if (ir >= 0) { root = path.resolve(a[ir].slice(7)); a.splice(ir, 1); }
    const ro = a.findIndex((x) => x.startsWith('--rol=')); let rol; if (ro >= 0) { rol = a[ro].slice(6); a.splice(ro, 1); }
    const cmd = a[0] || 'lista';
    if (cmd === 'estado') { console.log(JSON.stringify(estado(root))); return; }
    if (cmd === 'leer' || cmd === 'leido') {
      const n = marcarLeido(root, a[1] || 'todos', rol); console.log(n + ' mensaje(s) marcado(s) como leídos.'); return;
    }
    if (cmd === 'responder') {
      const id = a[1]; const texto = a.slice(2).join(' ').trim();
      if (!id || !texto) { console.log('Uso: buzon.cjs responder <id> "qué hiciste o qué respondes"'); process.exitCode = 2; return; }
      const ch = atender(root, id, texto);
      if (!ch.length) { console.log('No encontré el mensaje ' + id + ' (o ya estaba atendido).'); process.exitCode = 1; return; }
      // el acuse «atendido» lo manda el servicio; si no está corriendo, se manda ya
      try {
        const nb = require('./ntfy-bridge.cjs');
        const ac = acusesPendientes(root).filter((x) => x.m.id === id && x.tipo === 'atendido');
        for (const x of ac) { const t = textoAcuse(x); const r = await nb.difundir(root, { titulo: t.titulo, texto: t.texto, prioridad: 3, canalOrigen: x.m.canal }); if (r.some((y) => y.ok)) marcarAvisado(root, id, 'atendido'); }
      } catch { /* el servicio lo reintenta */ }
      console.log('Atendido: ' + id + '. Le llegó la respuesta al dueño (o le llegará en cuanto el servicio de mensajería corra).'); return;
    }
    const s = sinLeer(root, rol);
    if (!s.length) console.log('Buzón vacío: no hay mensajes del dueño sin leer.');
    else for (const m of s) console.log(`[${m.id}] ${m.t} (${m.canal}, para ${m.para}, ${m.estado}) — ${m.texto}`);
  })().catch((e) => { console.error('buzon: ' + e.message); process.exitCode = 1; });
}
