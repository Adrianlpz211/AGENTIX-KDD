'use strict';
/**
 * Puente con el teléfono por ntfy (app «ntfy – PUT/POST to your phone»). Opcional y apagado por defecto.
 *
 *   Agentix → tú:  avisos cuando se acepta una tarea (con avance, tiempo trabajado y lo que falta), cuando todo queda aceptado o se cierra,
 *                  cuando necesita una decisión TUYA (con las opciones y cómo responder), cuando algo no marcha (parado, vigilante muerto,
 *                  constructor dormido…) y un reporte periódico. Sin ruido: se agrupa, se repite poco y hay tope diario.
 *   tú → Agentix:  lo que escribes en el tema desde la app llega a un BUZÓN que el Director lee en su siguiente ronda (y su vigilante se
 *                  despierta con él). Un mensaje «D-001 <decisión>» responde esa decisión del dueño; «estado» te devuelve el avance.
 *
 * Seguridad (leer): el tema es el único secreto. Se genera largo y aleatorio; quien lo sepa puede escribirte y leerte. Para endurecerlo
 * activa un PIN (--pin=…: los mensajes de entrada deben empezar con él) o usa un servidor propio con token (--token=…). Lo que llega por
 * aquí es una indicación del dueño con esa salvedad: nunca dispara por sí solo nada que no sea responder una decisión «D-xxx» o pedir el
 * estado; todo lo demás lo lee el Director, que confirma en el chat cualquier cosa destructiva o sensible.
 *
 *   node ntfy-bridge.cjs activar [--servidor=https://ntfy.sh] [--tema=…] [--pin=…] [--token=…]
 *   node ntfy-bridge.cjs estado | desactivar | probar | resumen
 *   node ntfy-bridge.cjs enviar "texto" [--titulo=…] [--prioridad=1..5]
 *   node ntfy-bridge.cjs leer            (una vuelta de entrada: trae lo que escribiste desde el teléfono)
 *   node ntfy-bridge.cjs servir          (servicio: cada 20 s vigila el proyecto, avisa y lee tus mensajes)
 *   node ntfy-bridge.cjs buzon [--leido=<id|todos>]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const SONDEO_MS = 20 * 1000;
const SOSTENIDO_MS = 5 * 60 * 1000;        // un problema tiene que durar esto para avisar
const REPETIR_ALERTA_MS = 60 * 60 * 1000;  // y se repite como mucho cada hora
const MIN_ENTRE_ALERTAS_MS = 10 * 60 * 1000;
const dir = (root) => path.join(root, '.agentic', '_ntfy');
const arch = (root, n) => path.join(dir(root), n);
const leerJ = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
function escribirJ(p, o) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const t = p + '.' + process.pid + '.tmp'; fs.writeFileSync(t, JSON.stringify(o, null, 2));
  try { fs.renameSync(t, p); } catch { fs.writeFileSync(p, JSON.stringify(o, null, 2)); try { fs.unlinkSync(t); } catch { /* ya */ } }
}
/** El tema es un secreto: que nunca se suba a git por descuido. */
function asegurarIgnorado(root) {
  try {
    if (!fs.existsSync(path.join(root, '.git'))) return;
    const g = path.join(root, '.gitignore'); const t = fs.existsSync(g) ? fs.readFileSync(g, 'utf8') : '';
    const NL = String.fromCharCode(10);
    if (!t.split(NL).some((l) => l.trim().replace(/\/$/, '') === '.agentic/_ntfy')) fs.writeFileSync(g, t + (t && !t.endsWith(NL) ? NL : '') + '.agentic/_ntfy/' + NL);
  } catch { /* si no se puede, el aviso de activar lo recuerda */ }
}
const leerConfig = (root) => leerJ(arch(root, 'config.json'), null);
const leerEstado = (root) => leerJ(arch(root, 'estado.json'), { since: null, aceptadas: [], decisiones: [], ciclos_max: null, alertas: {}, reporte_ult: 0, dia: '', enviados: 0, base: false });
const guardarEstado = (root, e) => escribirJ(arch(root, 'estado.json'), e);
const corto = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const hoy = () => new Date().toISOString().slice(0, 10);

// ───────────────────────────── red ─────────────────────────────
function cabeceras(cfg) { const h = { 'Content-Type': 'application/json' }; if (cfg.token) h.Authorization = 'Bearer ' + cfg.token; return h; }
async function publicar(root, cfg, { titulo, texto, prioridad, tags }) {
  const est = leerEstado(root);
  if (est.dia !== hoy()) { est.dia = hoy(); est.enviados = 0; }
  if (est.enviados >= (cfg.max_dia || 120)) return { ok: false, causa: 'TOPE_DIARIO' };
  try {
    const r = await fetch(cfg.servidor.replace(/\/$/, '') + '/', {
      method: 'POST', headers: cabeceras(cfg), signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ topic: cfg.tema, title: corto(titulo || 'Agentix', 80), message: String(texto).slice(0, 3500), priority: prioridad || 3, tags: ['agentix'].concat(tags || []) }),
    });
    if (!r.ok) return { ok: false, causa: 'HTTP_' + r.status };
    const j = await r.json().catch(() => ({}));
    est.enviados++; est.dia = hoy(); guardarEstado(root, est);
    return { ok: true, id: j.id || null };
  } catch (e) { return { ok: false, causa: 'RED: ' + corto(e.message || e, 80) }; }
}
async function traerEntrada(cfg, since) {
  const url = cfg.servidor.replace(/\/$/, '') + '/' + cfg.tema + '/json?poll=1&since=' + encodeURIComponent(since || 'latest');
  const r = await fetch(url, { headers: cfg.token ? { Authorization: 'Bearer ' + cfg.token } : {}, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('HTTP_' + r.status);
  return (await r.text()).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((m) => m && m.event === 'message');
}

// ───────────────────────────── datos del proyecto ─────────────────────────────
function cargarTeams(root) { try { const f = path.join(root, '.agentic', 'grafo', 'teams.cjs'); return fs.existsSync(f) ? require(f) : null; } catch { return null; } }
function salud(root) { try { const T = cargarTeams(root); return T ? T.salud(root) : null; } catch { return null; } }
function dur(ms) { if (!Number.isFinite(ms) || ms <= 0) return '0 min'; const m = Math.round(ms / 60000); return m >= 60 ? Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0') + ' min' : m + ' min'; }
function tiempos(root) {
  try {
    const { openReadOnly } = require('./db-adapter.cjs'); const db = openReadOnly(path.join(root, '.agentic', 'memoria.db'));
    try {
      const r = db.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN duracion_ms > 0 THEN 1 ELSE 0 END) AS medidos, SUM(CASE WHEN duracion_ms > 0 THEN duracion_ms ELSE 0 END) AS ms FROM ciclos WHERE ciclo_id LIKE 'teams\\_%' ESCAPE '\\'").get();
      return { n: r.n || 0, medidos: r.medidos || 0, ms: r.ms || 0 };
    } finally { db.close(); }
  } catch { return null; }
}
function inicioCampana(root) {
  try { const T = cargarTeams(root); const ev = T ? T.leerEventos(root, 400) : []; const e = ev.find((x) => x.cmd === 'iniciar'); return e ? Date.parse(e.t) : null; } catch { return null; }
}
/** El resumen que se manda: avance, cuánto se ha trabajado (medido), cuánto transcurrió y cuánto falta (estimación honesta por promedio). */
function resumenTexto(root, d) {
  if (!d) return 'Sin canal TEAMS activo en este proyecto.';
  const t = tiempos(root), ini = inicioCampana(root), faltan = Math.max(0, d.total - d.aceptadas);
  const L = [`Avance: ${d.aceptadas}/${d.total} tareas aceptadas${d.avance === null ? '' : ' (' + d.avance + ' %)'} · canal ${d.canal} · semáforo ${d.semaforo}`];
  if (t && t.medidos) L.push(`Trabajado: ${dur(t.ms)} (medido en ${t.medidos} de ${t.n} ciclos de TEAMS${t.medidos < t.n ? '; los demás sin dato' : ''})`);
  if (ini) L.push(`Transcurrido desde «iniciar»: ${dur(Date.now() - ini)} (incluye esperas y pausas)`);
  if (faltan) {
    if (t && t.medidos >= 3) L.push(`Falta: ${faltan} tarea(s) · estimación ≈ ${dur(faltan * (t.ms / t.medidos))} de trabajo (promedio de ${t.medidos} tareas medidas; es una estimación, no una promesa)`);
    else L.push(`Falta: ${faltan} tarea(s) · aún no hay base para estimar el tiempo`);
  } else if (d.total) L.push('Falta: nada en cola.');
  if (d.cola.decisiones_dueno.length) L.push(`Esperan TU decisión: ${d.cola.decisiones_dueno.map((x) => x.id).join(', ')}`);
  const rojas = (d.alertas || []).filter((a) => a.nivel === 'ROJO'); if (rojas.length) L.push('Problemas: ' + rojas.map((a) => corto(a.msg.replace(/\s*\(.*$/, ''), 110)).join(' · '));
  return L.join('\n');
}

// ───────────────────────────── salida: qué se avisa y cuándo ─────────────────────────────
async function tick(root, opts = {}) {
  const cfg = leerConfig(root); if (!cfg || !cfg.activo) return { enviados: 0, motivo: 'APAGADO' };
  const est = leerEstado(root); const ahora = opts.ahora || Date.now(); const d = salud(root);
  const out = []; const manda = async (titulo, texto, prioridad, tags) => { const r = await publicar(root, cfg, { titulo, texto, prioridad, tags }); out.push({ titulo, ok: r.ok, causa: r.causa }); return r; };
  const fresco = leerEstado(root); Object.assign(est, { enviados: fresco.enviados, dia: fresco.dia });

  if (d) {
    const aceptadas = d.tareas_todas.filter((t) => t.estado === 'ACEPTADA');
    const decisiones = d.cola.decisiones_dueno;
    if (!est.base) { est.aceptadas = aceptadas.map((t) => t.id); est.decisiones = decisiones.map((x) => x.id); est.base = true; est.canal = d.canal; est.reporte_ult = ahora; }
    else {
      // 1) tareas aceptadas desde la última vuelta (agrupadas)
      const nuevas = aceptadas.filter((t) => !est.aceptadas.includes(t.id));
      if (nuevas.length) {
        const r = await manda(nuevas.length === 1 ? `✅ ${nuevas[0].id} aceptada` : `✅ ${nuevas.length} tareas aceptadas`, nuevas.map((t) => `${t.id} — ${corto(t.titulo, 90)}`).join('\n') + '\n\n' + resumenTexto(root, d), 3, ['white_check_mark']);
        if (r.ok || r.causa === 'TOPE_DIARIO') { est.aceptadas = aceptadas.map((t) => t.id); est.reporte_ult = ahora; }
        // 2) todo aceptado
        if (r.ok && d.total > 0 && d.aceptadas === d.total && !d.cola.tareas.length && !d.cola.por_aceptar.length) await manda('🏁 Todo aceptado', 'Todas las tareas del plan están aceptadas. Falta que el Director cierre el proyecto (`teams: cerrar`).\n\n' + resumenTexto(root, d), 4, ['checkered_flag']);
      }
      // 3) decisiones que necesitan al dueño
      for (const x of decisiones.filter((y) => !est.decisiones.includes(y.id))) {
        const r = await manda(`❓ Necesito tu decisión: ${x.id}`, `${x.titulo}\n${x.detalle ? corto(x.detalle, 500) + '\n' : ''}${x.opciones ? 'Opciones: ' + x.opciones + '\n' : ''}${x.recomendacion ? 'Recomiendo: ' + x.recomendacion + '\n' : ''}\nResponde aquí mismo: ${x.id} <tu decisión>`, 4, ['question']);
        if (r.ok || r.causa === 'TOPE_DIARIO') est.decisiones.push(x.id);
      }
      est.decisiones = est.decisiones.filter((id) => decisiones.some((y) => y.id === id));   // resueltas: ya no cuentan
      // 4) cierre del canal
      if (est.canal && est.canal !== 'CERRADO' && d.canal === 'CERRADO') await manda('🔒 Proyecto cerrado', resumenTexto(root, d), 4, ['lock']);
      // 5) algo no marcha (debe sostenerse 5 min; como mucho cada hora por problema y una cada 10 min en total)
      const problemas = (d.alertas || []).filter((a) => a.nivel === 'ROJO' || /sin trabajo|dormido|parado|NO está vivo/i.test(a.msg));
      const vigentes = {};
      for (const a of problemas) {
        const clave = corto(a.msg.replace(/\d+/g, '#').replace(/\s*\(.*$/, ''), 120); vigentes[clave] = true;
        const p = est.alertas[clave] = est.alertas[clave] || { desde: ahora, ult: 0 };
        if (ahora - p.desde >= SOSTENIDO_MS && ahora - p.ult >= REPETIR_ALERTA_MS && ahora - (est.ult_alerta || 0) >= MIN_ENTRE_ALERTAS_MS) {
          const r = await manda('⚠️ Algo no marcha', `${a.msg}\n\n${resumenTexto(root, d)}`, 4, ['warning']);
          if (r.ok) { p.ult = ahora; est.ult_alerta = ahora; }
        }
      }
      for (const k of Object.keys(est.alertas)) if (!vigentes[k]) delete est.alertas[k];
      // 6) reporte periódico (solo con el canal en marcha)
      const cada = (cfg.reporte_cada_min || 60) * 60000;
      if (d.canal === 'ACTIVO' && ahora - (est.reporte_ult || 0) >= cada) { const r = await manda('📊 Reporte', resumenTexto(root, d), 2, ['bar_chart']); if (r.ok) est.reporte_ult = ahora; }
      est.canal = d.canal;
    }
  }
  // 7) ciclos de aa: (uso individual) — los de TEAMS ya salen como «tarea aceptada»
  try {
    const { openReadOnly } = require('./db-adapter.cjs'); const db = openReadOnly(path.join(root, '.agentic', 'memoria.db'));
    try {
      const max = (db.prepare('SELECT MAX(id) AS m FROM ciclos').get() || {}).m || 0;
      if (est.ciclos_max === null || est.ciclos_max === undefined) est.ciclos_max = max;
      else if (max > est.ciclos_max) {
        const nuevos = db.prepare("SELECT id, ciclo_id, tarea, estado, tests_pasando, duracion_ms FROM ciclos WHERE id > ? AND ciclo_id NOT LIKE 'teams\\_%' ESCAPE '\\' ORDER BY id").all(est.ciclos_max);
        est.ciclos_max = max;
        if (nuevos.length) await manda(nuevos.length === 1 ? '✅ Ciclo aa: cerrado' : `✅ ${nuevos.length} ciclos aa: cerrados`, nuevos.slice(0, 5).map((c) => `· ${corto(c.tarea, 90)}${c.estado ? ' — ' + c.estado : ''}${c.tests_pasando ? ' · ' + c.tests_pasando + ' tests' : ''}${c.duracion_ms > 0 ? ' · ' + dur(c.duracion_ms) : ''}`).join('\n'), 3, ['white_check_mark']);
      }
    } finally { db.close(); }
  } catch { /* sin base: no hay ciclos que avisar */ }
  const post = leerEstado(root); est.enviados = post.enviados; est.dia = post.dia;
  guardarEstado(root, est);
  return { enviados: out.filter((x) => x.ok).length, detalle: out };
}

// ───────────────────────────── entrada: lo que escribes desde el teléfono ─────────────────────────────
async function entrada(root) {
  const cfg = leerConfig(root); if (!cfg || !cfg.activo) return { recibidos: 0, motivo: 'APAGADO' };
  const est = leerEstado(root); let msgs;
  try { msgs = await traerEntrada(cfg, est.since); } catch (e) { return { recibidos: 0, error: corto(e.message, 80) }; }
  let recibidos = 0;
  for (const m of msgs) {
    est.since = m.id;
    if ((m.tags || []).includes('agentix') || m.time < Math.floor(Date.parse(cfg.activado_at || 0) / 1000)) continue;
    let texto = String(m.message || '').trim(); if (!texto) continue;
    if (cfg.pin) { if (!texto.startsWith(cfg.pin)) { await publicar(root, cfg, { titulo: 'Agentix', texto: '🔒 Mensaje ignorado: falta el PIN al principio.', prioridad: 2, tags: ['lock'] }); continue; } texto = texto.slice(cfg.pin.length).replace(/^[\s:,-]+/, ''); if (!texto) continue; }
    recibidos++;
    const dec = /^(D-\d+)[\s:,-]+([\s\S]+)$/i.exec(texto);
    if (dec) {
      const id = dec[1].toUpperCase(), resp = dec[2].trim();
      const r = spawnSync(process.execPath, [path.join(root, '.agentic', 'grafo', 'teams.cjs'), 'decidir', id, resp, '--porque=respondida por el dueño desde el teléfono (ntfy)'], { cwd: root, encoding: 'utf8', timeout: 60000 });
      await publicar(root, cfg, { titulo: r.status === 0 ? `✔ ${id} resuelta` : `✖ No pude resolver ${id}`, texto: r.status === 0 ? `Quedó registrada tu decisión: ${corto(resp, 200)}. El Director la verá en su próxima revisión.` : corto((r.stdout || '') + (r.stderr || ''), 300) || 'Esa decisión no existe o ya estaba resuelta.', prioridad: 3, tags: [r.status === 0 ? 'white_check_mark' : 'x'] });
      continue;
    }
    if (/^(estado|\?|avance|reporte)$/i.test(texto)) { await publicar(root, cfg, { titulo: '📊 Estado', texto: resumenTexto(root, salud(root)), prioridad: 3, tags: ['bar_chart'] }); continue; }
    fs.mkdirSync(dir(root), { recursive: true });
    fs.appendFileSync(arch(root, 'buzon.jsonl'), JSON.stringify({ id: m.id, t: new Date((m.time || 0) * 1000).toISOString(), texto: corto(texto, 1500), leido: false }) + '\n');
    await publicar(root, cfg, { titulo: '📥 Recibido', texto: `Se lo pasé al Director: ${corto(texto, 160)}\nLo verá en su próxima ronda y te responde aquí.`, prioridad: 2, tags: ['inbox_tray'] });
  }
  const fr = leerEstado(root); fr.since = est.since; guardarEstado(root, fr);
  return { recibidos };
}

// ───────────────────────────── buzón (lo lee el Director) ─────────────────────────────
function leerBuzon(root) { try { return fs.readFileSync(arch(root, 'buzon.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } }
function marcarLeidos(root, cual) {
  const todos = leerBuzon(root); let n = 0;
  for (const m of todos) if (!m.leido && (cual === 'todos' || m.id === cual)) { m.leido = true; n++; }
  fs.writeFileSync(arch(root, 'buzon.jsonl'), todos.map((m) => JSON.stringify(m)).join('\n') + (todos.length ? '\n' : ''));
  return n;
}
const sinLeer = (root) => leerBuzon(root).filter((m) => !m.leido);

// ───────────────────────────── servicio ─────────────────────────────
function estadoServicio(root) {
  const v = leerJ(arch(root, 'servicio.json'), null); if (!v) return { vivo: false };
  let proceso = false; try { process.kill(v.pid, 0); proceso = true; } catch { proceso = false; }
  const hace = Math.round((Date.now() - Date.parse(v.latido)) / 1000);
  return { vivo: proceso && hace < 90, pid: v.pid, latido_hace_s: hace };
}
async function servir(root, opts = {}) {
  const cfg0 = leerConfig(root); if (!cfg0 || !cfg0.activo) { console.log('ntfy está apagado: «activar» primero.'); return; }
  console.log('ntfy: servicio en marcha (cada ' + SONDEO_MS / 1000 + ' s). Ctrl+C para detener.');
  let corriendo = true; const parar = () => { corriendo = false; try { fs.unlinkSync(arch(root, 'servicio.json')); } catch { /* ya */ } };
  process.on('SIGINT', () => { parar(); process.exit(0); }); process.on('SIGTERM', () => { parar(); process.exit(0); });
  while (corriendo) {
    try { const c = leerConfig(root); if (!c || !c.activo) { console.log('ntfy desactivado: el servicio termina.'); parar(); return; } escribirJ(arch(root, 'servicio.json'), { pid: process.pid, latido: new Date().toISOString() }); await entrada(root); await tick(root); }
    catch (e) { console.error('ntfy: ' + corto(e.message, 120)); }
    if (opts.una) return;
    await new Promise((r) => setTimeout(r, opts.sondeoMs || SONDEO_MS));
  }
}

// ───────────────────────────── comandos ─────────────────────────────
function parseArgs(a) { const opt = {}; const libres = []; for (const x of a) { const m = /^--([^=]+)(?:=(.*))?$/.exec(x); if (m) opt[m[1]] = m[2] === undefined ? true : m[2]; else libres.push(x); } return { opt, libres }; }
async function main(argv, root) {
  const { opt, libres } = parseArgs(argv); const cmd = libres[0] || 'estado';
  if (cmd === 'activar') {
    const prev = leerConfig(root) || {};
    const slug = path.basename(root).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20) || 'proyecto';
    const cfg = { activo: false, servidor: String(opt.servidor && opt.servidor !== true ? opt.servidor : (prev.servidor || 'https://ntfy.sh')), tema: String(opt.tema && opt.tema !== true ? opt.tema : (prev.tema || `agentix-${slug}-${crypto.randomBytes(12).toString('hex')}`)), pin: opt.pin && opt.pin !== true ? String(opt.pin) : (prev.pin || null), token: opt.token && opt.token !== true ? String(opt.token) : (prev.token || null), reporte_cada_min: Number(opt['reporte-cada']) || prev.reporte_cada_min || 60, max_dia: prev.max_dia || 120, activado_at: new Date().toISOString() };
    escribirJ(arch(root, 'config.json'), cfg); asegurarIgnorado(root);
    const r = await publicar(root, cfg, { titulo: 'Agentix conectado', texto: `Este es el aviso de prueba de «${path.basename(root)}». Si lo ves, el puente funciona. Responde cualquier cosa para probar la entrada.`, prioridad: 3, tags: ['tada'] });
    if (!r.ok) { console.log(`NTFY_FALLO: no pude enviar el aviso de prueba (${r.causa}). No quedó activo. Revisa la red o el servidor y repite «activar».`); return 1; }
    cfg.activo = true; escribirJ(arch(root, 'config.json'), cfg);
    const est = leerEstado(root); est.since = r.id || 'latest'; guardarEstado(root, est);
    console.log([
      'NTFY_ACTIVO — te mandé un aviso de prueba al teléfono.',
      '',
      'En la app «ntfy» de tu teléfono:',
      `  1) Pulsa «+» y suscríbete a este tema EXACTO:  ${cfg.tema}${cfg.servidor !== 'https://ntfy.sh' ? '   (servidor: ' + cfg.servidor + ')' : ''}`,
      '  2) Ajustes → General → «Mostrar barra de mensajes»: así podrás ESCRIBIRLE a Agentix desde el mismo tema.',
      '',
      'El tema es el único secreto: no lo compartas.' + (cfg.pin ? ` Tus mensajes deben empezar con el PIN «${cfg.pin}».` : ' Para exigir un PIN: activar --pin=…'),
      'Para que Agentix vigile y te avise, deja corriendo en segundo plano:  node .agentic/grafo/ntfy-bridge.cjs servir',
    ].join('\n'));
    return 0;
  }
  const cfg = leerConfig(root);
  if (cmd === 'estado') {
    if (!cfg || !cfg.activo) { console.log('NTFY_APAGADO — «activar» lo enciende (opcional; Agentix funciona igual sin esto).'); return 0; }
    const sv = estadoServicio(root), est = leerEstado(root);
    console.log(`NTFY_ACTIVO · servidor ${cfg.servidor} · tema ${cfg.tema.slice(0, 14)}… · PIN ${cfg.pin ? 'sí' : 'no'} · servicio ${sv.vivo ? 'VIVO (latido hace ' + sv.latido_hace_s + ' s)' : 'PARADO — lánzalo: node .agentic/grafo/ntfy-bridge.cjs servir'} · enviados hoy ${est.dia === hoy() ? est.enviados : 0}/${cfg.max_dia || 120} · buzón sin leer ${sinLeer(root).length}`);
    return 0;
  }
  if (cmd === 'desactivar') { if (cfg) { cfg.activo = false; escribirJ(arch(root, 'config.json'), cfg); } console.log('NTFY_APAGADO.'); return 0; }
  if (!cfg || !cfg.activo) { console.log('ntfy está apagado: «activar» primero.'); return 1; }
  if (cmd === 'enviar' || cmd === 'avisar') {
    const texto = libres.slice(1).join(' ').trim(); if (!texto) { console.log('Uso: enviar "texto" [--titulo=…] [--prioridad=1..5]'); return 2; }
    const r = await publicar(root, cfg, { titulo: opt.titulo && opt.titulo !== true ? String(opt.titulo) : 'Agentix', texto, prioridad: Number(opt.prioridad) || 3, tags: [] });
    console.log(r.ok ? 'Enviado al teléfono.' : 'NO se envió: ' + r.causa); return r.ok ? 0 : 1;
  }
  if (cmd === 'probar') { const r = await publicar(root, cfg, { titulo: 'Prueba', texto: 'Prueba de Agentix ' + new Date().toLocaleTimeString(), prioridad: 3, tags: ['tada'] }); console.log(r.ok ? 'Enviado.' : 'NO se envió: ' + r.causa); return r.ok ? 0 : 1; }
  if (cmd === 'resumen') { console.log(resumenTexto(root, salud(root))); return 0; }
  if (cmd === 'leer') { const r = await entrada(root); console.log(JSON.stringify(r)); return 0; }
  if (cmd === 'buzon') {
    if (opt.leido) { const n = marcarLeidos(root, opt.leido === true ? 'todos' : String(opt.leido)); console.log(n + ' mensaje(s) marcado(s) como leídos.'); return 0; }
    const s = sinLeer(root); if (!s.length) console.log('Buzón vacío: no hay mensajes tuyos sin leer.'); else for (const m of s) console.log(`[${m.id}] ${m.t} — ${m.texto}`);
    return 0;
  }
  if (cmd === 'servir') { await servir(root); return 0; }
  console.log('Uso: ntfy-bridge.cjs activar | estado | desactivar | probar | resumen | enviar "texto" | leer | buzon [--leido=id|todos] | servir');
  return 2;
}

module.exports = { activar: (root, a) => main(['activar', ...(a || [])], root), main, tick, entrada, publicar, leerConfig, leerBuzon, sinLeer, marcarLeidos, estadoServicio, resumenTexto, servir };

if (require.main === module) {
  let root = process.cwd(); const a = process.argv.slice(2); const i = a.findIndex((x) => x.startsWith('--root='));
  if (i >= 0) { root = path.resolve(a[i].slice(7)); a.splice(i, 1); }
  main(a, root).then((c) => { if (typeof c === 'number') process.exitCode = c; }).catch((e) => { console.error('ntfy: ' + e.message); process.exitCode = 1; });
}
