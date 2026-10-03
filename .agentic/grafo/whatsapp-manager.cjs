'use strict';

/**
 * WhatsApp opcional: avisos importantes del proyecto a una sola persona.
 *
 *   OFF → WAITING_CONTACT → CHECKING_CAPABILITIES → RESOLVING_CONTACT
 *       → (WAITING_SELECTION) → SENDING_TEST → ACTIVE
 *   cualquier fallo → ACTIVATION_FAILED con motivo (reintento con el mismo id)
 *   envío ambiguo sin forma de verificar → DELIVERY_UNKNOWN (nunca ACTIVE)
 *   ACTIVE → DEGRADED si se pierde el transporte; ws: desactivar → OFF
 *
 * Solo `ws: activar` escrito por la persona (hook de prompt o terminal) abre
 * una activación, y solo su respuesta elige el contacto. Activar autoriza el
 * mensaje de prueba y los eventos de la política mostrada; nada más. Lo que
 * llega por el chat de WhatsApp es dato, no orden.
 *
 * Sin WhatsApp, Agentix y TEAMS funcionan igual: nada aquí bloquea tareas.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA_VERSION = 1;
const ESTADOS = ['OFF', 'WAITING_CONTACT', 'CHECKING_CAPABILITIES', 'RESOLVING_CONTACT', 'WAITING_SELECTION', 'SENDING_TEST', 'ACTIVE', 'DEGRADED', 'ACTIVATION_FAILED', 'DELIVERY_UNKNOWN'];
const EMERGENCIAS = ['INCIDENTE_GLOBAL', 'SIN_TAREAS_POR_DECISION', 'RECUPERACION_AGOTADA', 'CONSTRUCTOR_INTERRUMPIDO'];
const EVENTOS = [...EMERGENCIAS, 'REPORTE_FINAL', 'PROGRESO'];
const POLITICA_DEFECTO = {
  eventos: { INCIDENTE_GLOBAL: true, SIN_TAREAS_POR_DECISION: true, RECUPERACION_AGOTADA: true, CONSTRUCTOR_INTERRUMPIDO: true, REPORTE_FINAL: true, PROGRESO: false },
  limites: { progreso_cada_min: 15, cooldown_emergencia_min: 5, max_intentos: 3 },
  llamadas: { enabled: false, cooldown_min: 30 },
};
const ORIGEN_TTL_MS = 30 * 60 * 1000;
const PREGUNTA = '¿Cuál es el número o contacto al que debo escribirte?';

// ─── archivos ────────────────────────────────────────────────────────────────

const dir = (root) => path.join(root, '.agentic', '_whatsapp');
const fConfig = (root) => path.join(dir(root), 'config.json');
const fEntregas = (root) => path.join(dir(root), 'entregas.json');
const fAuditoria = (root) => path.join(dir(root), 'auditoria.jsonl');
const fOrigen = (root) => path.join(dir(root), 'origen-humano.jsonl');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function escribirAtomico(f, contenido) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.' + process.pid + '-' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, contenido);
  fs.renameSync(tmp, f);
}
function leerJson(f, defecto) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return defecto; } }

function proyectoId(root) {
  let r = path.resolve(root);
  try { r = fs.realpathSync.native(r); } catch { /* ruta tal cual */ }
  return sha(r.toLowerCase()).slice(0, 16);
}
function nombreProyecto(root) {
  const p = leerJson(path.join(root, 'package.json'), null);
  return String((p && p.name) || path.basename(path.resolve(root))).slice(0, 60);
}

function configBase(root) {
  return {
    schema_version: SCHEMA_VERSION, project_id: proyectoId(root), state: 'OFF', generation: 0,
    transport_id: 'none', country: null, contact: null, anterior: null, activation: null,
    politica: JSON.parse(JSON.stringify(POLITICA_DEFECTO)), teams_cursor: 0, ultima_llamada: null,
  };
}
function leerConfig(root) {
  const c = leerJson(fConfig(root), null);
  return c ? Object.assign(configBase(root), c, { politica: Object.assign({}, POLITICA_DEFECTO, c.politica || {}) }) : configBase(root);
}
function guardarConfig(root, c) { escribirAtomico(fConfig(root), JSON.stringify(c, null, 2)); }
function entregas(root) { return leerJson(fEntregas(root), []); }
function guardarEntregas(root, l) { escribirAtomico(fEntregas(root), JSON.stringify(l, null, 2)); }

/** Auditoría sin el número: el destino va como huella. */
function auditar(root, ev) {
  fs.mkdirSync(dir(root), { recursive: true });
  fs.appendFileSync(fAuditoria(root), JSON.stringify(Object.assign({ at: new Date().toISOString() }, ev)) + '\n');
}

// ─── contacto ────────────────────────────────────────────────────────────────

function enmascarar(numero) {
  const d = String(numero).replace(/\D/g, '');
  return d.length < 6 ? '•••' : '+' + d.slice(0, 2) + '•••' + d.slice(-4);
}

/** Número con país o nombre. Sin país configurado no se adivina. */
function validarContacto(texto, country) {
  const s = String(texto || '').trim();
  const limpio = s.replace(/[\s().-]/g, '');
  if (/^\+\d{8,15}$/.test(limpio)) return { tipo: 'numero', valor: limpio };
  if (/^00\d{8,15}$/.test(limpio)) return { tipo: 'numero', valor: '+' + limpio.slice(2) };
  if (/^\d{6,15}$/.test(limpio)) {
    if (!country) return { error: 'PAIS_REQUERIDO', detalle: 'escribe el número con el código de país (ej. +58...) o configura el país del proyecto' };
    return { tipo: 'numero', valor: '+' + String(country).replace(/\D/g, '') + limpio.replace(/^0+/, '') };
  }
  if (/^[\p{L}][\p{L}\p{N} .'_-]{1,60}$/u.test(s)) return { tipo: 'nombre', valor: s };
  return { error: 'CONTACTO_INVALIDO', detalle: 'no parece un número ni un nombre de contacto' };
}

// ─── origen humano ───────────────────────────────────────────────────────────

const normal = (t) => String(t || '').trim().replace(/\s+/g, ' ').toLowerCase();

/** Lo llama el hook de prompt con el texto que escribió la persona. */
function registrarOrigenHumano(root, { texto, host }) {
  fs.mkdirSync(dir(root), { recursive: true });
  fs.appendFileSync(fOrigen(root), JSON.stringify({ hash: sha(normal(texto)), host: host || null, at: Date.now() }) + '\n');
}

function consumirOrigen(root, texto, ahora) {
  let lineas = [];
  try { lineas = fs.readFileSync(fOrigen(root), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return null; }
  const h = sha(normal(texto));
  const i = lineas.findIndex((e) => e.hash === h && ahora - e.at <= ORIGEN_TTL_MS);
  if (i < 0) return null;
  const e = lineas[i];
  const resto = lineas.filter((x, j) => j !== i && ahora - x.at <= ORIGEN_TTL_MS);
  escribirAtomico(fOrigen(root), resto.map((x) => JSON.stringify(x)).join('\n') + (resto.length ? '\n' : ''));
  return e;
}

function origenValido(root, origen, texto, ahora) {
  if (origen === 'cli-tty') return true;
  if (origen === 'hook-prompt') return !!consumirOrigen(root, texto, ahora);
  return false;
}
const SIN_ORIGEN = { status: 'ORIGEN_NO_VERIFICADO', detalle: 'tiene que escribirlo la persona en el chat (con los hooks del host instalados) o en una terminal' };

/**
 * El hook de prompt decide qué guardar: un `ws:` al inicio, o la respuesta
 * corta que sigue a una pregunta de activación abierta.
 */
function origenDesdePrompt(root, prompt, host) {
  const t = String(prompt || '').trim();
  if (/^ws:/i.test(t)) { registrarOrigenHumano(root, { texto: t, host }); return 'comando'; }
  const c = leerJson(fConfig(root), null);
  if (c && ['WAITING_CONTACT', 'WAITING_SELECTION'].includes(c.state) && t.length > 0 && t.length <= 80 && !t.includes('\n')) {
    registrarOrigenHumano(root, { texto: t, host });
    return 'respuesta';
  }
  return null;
}

// ─── política ────────────────────────────────────────────────────────────────

function textoPolitica(p) {
  const on = EVENTOS.filter((e) => p.eventos[e]);
  return `Avisaré solo de: ${on.join(', ')}. Progreso periódico: ${p.eventos.PROGRESO ? `sí, como máximo 1 cada ${p.limites.progreso_cada_min} min` : 'no (opt-in)'}. `
    + `Emergencias agrupadas por incidente, una cada ${p.limites.cooldown_emergencia_min} min como mucho. Llamadas: ${p.llamadas.enabled ? 'habilitadas' : 'deshabilitadas'}. `
    + 'Los números se pueden cambiar con ws: politica.';
}

function configurarPolitica(root, cambios = {}) {
  const c = leerConfig(root);
  const p = c.politica;
  if (cambios.progreso != null) p.eventos.PROGRESO = !!cambios.progreso;
  if (Number(cambios.progreso_cada_min) >= 1) p.limites.progreso_cada_min = Number(cambios.progreso_cada_min);
  if (Number(cambios.cooldown_emergencia_min) >= 1) p.limites.cooldown_emergencia_min = Number(cambios.cooldown_emergencia_min);
  if (cambios.llamadas != null) p.llamadas.enabled = !!cambios.llamadas;
  if (cambios.country !== undefined) c.country = cambios.country ? String(cambios.country).replace(/\D/g, '') : null;
  for (const e of EVENTOS) if (cambios[e] != null) p.eventos[e] = !!cambios[e];
  guardarConfig(root, c);
  return { status: 'OK', politica: p, texto: textoPolitica(p) };
}

// ─── activación ──────────────────────────────────────────────────────────────

function fallar(root, c, motivo, detalle) {
  c.state = 'ACTIVATION_FAILED';
  c.activation.fallo = { motivo, detalle: detalle || null };
  guardarConfig(root, c);
  auditar(root, { op: 'activacion', fase: 'fallo', activation_id: c.activation.id, motivo });
  return { status: 'ACTIVATION_FAILED', motivo, detalle: detalle || null, activation_id: c.activation.id, reintento: `ws reintentar ${c.activation.id}` };
}

function activar(root, { origen, texto = 'ws: activar', ahora = Date.now() } = {}) {
  if (!origenValido(root, origen, texto, ahora)) return SIN_ORIGEN;
  const c = leerConfig(root);
  if (c.state === 'ACTIVE' || c.state === 'DEGRADED') {
    return { status: 'YA_ACTIVO', contacto: c.contact.display, estado: c.state, nota: 'para cambiar de contacto: ws: desactivar y luego ws: activar' };
  }
  if (c.activation && !['OFF'].includes(c.state)) {
    return { status: 'ACTIVACION_EN_CURSO', activation_id: c.activation.id, estado: c.state, pregunta: c.state === 'WAITING_CONTACT' ? PREGUNTA : null };
  }
  c.activation = { id: 'wa-' + crypto.randomBytes(4).toString('hex'), created_at: new Date(ahora).toISOString(), consulta: null, candidatos: null, contacto: null, correlation: null, fallo: null };
  c.state = 'WAITING_CONTACT';
  guardarConfig(root, c);
  auditar(root, { op: 'activacion', fase: 'inicio', activation_id: c.activation.id });
  return {
    status: 'ESPERANDO_CONTACTO', activation_id: c.activation.id, pregunta: PREGUNTA, politica: textoPolitica(c.politica),
    anterior: c.anterior ? `el contacto anterior era ${c.anterior} — no se reutiliza sin que lo escribas de nuevo` : null,
  };
}

function contacto(root, { activation_id, texto, origen, adapter, ahora = Date.now() }) {
  const c = leerConfig(root);
  if (!c.activation || c.activation.id !== activation_id) return { status: 'ACTIVACION_DESCONOCIDA' };
  if (!['WAITING_CONTACT', 'ACTIVATION_FAILED'].includes(c.state)) return { status: 'TRANSICION_INVALIDA', estado: c.state };
  if (!origenValido(root, origen, texto, ahora)) return SIN_ORIGEN;
  const v = validarContacto(texto, c.country);
  if (v.error) { c.state = 'WAITING_CONTACT'; guardarConfig(root, c); return { status: v.error, detalle: v.detalle, pregunta: PREGUNTA }; }
  c.activation.consulta = v;
  c.activation.fallo = null;
  guardarConfig(root, c);
  return avanzar(root, adapter);
}

function avanzar(root, adapter) {
  const c = leerConfig(root);
  c.state = 'CHECKING_CAPABILITIES';
  guardarConfig(root, c);
  const caps = adapter.capabilities();
  const h = adapter.health();
  if (!caps.send) return fallar(root, c, 'UNSUPPORTED', h.detalle || 'el transporte no puede enviar mensajes');
  if (h.status !== 'OK') return fallar(root, c, h.status, h.detalle || explicacion(h.status));
  c.transport_id = caps.transport_id;
  if (c.activation.contacto) return enviarPrueba(root, adapter);
  c.state = 'RESOLVING_CONTACT';
  guardarConfig(root, c);
  const r = adapter.resolveContact({ query: c.activation.consulta.valor, tipo: c.activation.consulta.tipo });
  if (r.status === 'PENDING') {
    /* El navegador del agente busca en su siguiente pase: se espera, no se falla ni se inventa. */
    return { status: 'ESPERANDO_NAVEGADOR', activation_id: c.activation.id, detalle: r.detalle || 'la sesión del agente busca el contacto; luego ws: reintentar' };
  }
  if (r.status === 'AMBIGUOUS_CONTACT') {
    c.state = 'WAITING_SELECTION';
    c.activation.candidatos = r.candidatos.map((x, i) => ({ n: i + 1, id: x.id, display: x.display }));
    guardarConfig(root, c);
    return { status: 'ELEGIR_CONTACTO', activation_id: c.activation.id, candidatos: c.activation.candidatos.map(({ n, display }) => ({ n, display })), pregunta: 'Hay varios contactos con ese nombre: ¿cuál es? (responde con el número de la lista)' };
  }
  if (r.status !== 'OK') return fallar(root, c, r.status === 'UNSUPPORTED' ? 'UNSUPPORTED' : 'CONTACT_NOT_FOUND');
  c.activation.contacto = { id: r.contact.id, display: c.activation.consulta.tipo === 'numero' ? enmascarar(c.activation.consulta.valor) : r.contact.display };
  guardarConfig(root, c);
  return enviarPrueba(root, adapter);
}

function elegir(root, { activation_id, eleccion, origen, adapter, ahora = Date.now() }) {
  const c = leerConfig(root);
  if (!c.activation || c.activation.id !== activation_id) return { status: 'ACTIVACION_DESCONOCIDA' };
  if (c.state !== 'WAITING_SELECTION') return { status: 'TRANSICION_INVALIDA', estado: c.state };
  if (!origenValido(root, origen, String(eleccion), ahora)) return SIN_ORIGEN;
  const x = c.activation.candidatos.find((k) => String(k.n) === String(eleccion).trim());
  if (!x) return { status: 'ELECCION_INVALIDA', candidatos: c.activation.candidatos.map(({ n, display }) => ({ n, display })) };
  c.activation.contacto = { id: x.id, display: x.display };
  guardarConfig(root, c);
  return enviarPrueba(root, adapter);
}

/** Una vez. Si el resultado es ambiguo, se consulta antes de repetir. */
function enviarPrueba(root, adapter) {
  const c = leerConfig(root);
  const a = c.activation;
  c.state = 'SENDING_TEST';
  a.correlation = a.correlation || sha([c.project_id, a.id, c.generation, sha(a.contacto.id)].join('|')).slice(0, 24);
  guardarConfig(root, c);
  let messageId = null;
  const previo = adapter.lookupMessage({ correlation_id: a.correlation });
  if (previo.status === 'FOUND') messageId = previo.message_id;
  else {
    const texto = `Agentix: mensaje de prueba. Este chat recibirá los avisos autorizados del proyecto ${nombreProyecto(root)}.`;
    const s = adapter.sendMessage({ contact_id: a.contacto.id, text: texto, correlation_id: a.correlation });
    auditar(root, { op: 'activacion', fase: 'envio', activation_id: a.id, target: sha(a.contacto.id).slice(0, 12), resultado: s.status });
    if (s.status === 'SENT') messageId = s.message_id;
    else if (s.status === 'TIMEOUT') {
      const l = adapter.lookupMessage({ correlation_id: a.correlation });
      if (l.status === 'FOUND') messageId = l.message_id;
      else if (l.status === 'NOT_FOUND') return fallar(root, leerConfig(root), 'ENVIO_NO_CONFIRMADO', 'no salió: se puede reintentar sin duplicar');
      else return desconocido(root);
    } else return fallar(root, leerConfig(root), 'SEND_FAILED', s.motivo);
  }
  return confirmarActivo(root, adapter, messageId);
}

function desconocido(root) {
  const c = leerConfig(root);
  c.state = 'DELIVERY_UNKNOWN';
  guardarConfig(root, c);
  auditar(root, { op: 'activacion', fase: 'desconocido', activation_id: c.activation.id });
  return { status: 'DELIVERY_UNKNOWN', activation_id: c.activation.id, detalle: 'no se puede saber si el mensaje de prueba salió: revisa el chat y responde; no se reenvía a ciegas' };
}

function confirmarActivo(root, adapter, messageId) {
  const c = leerConfig(root);
  const v = adapter.lookupMessage({ message_id: messageId });
  if (v.status !== 'FOUND') return desconocido(root);
  if (v.chat_id !== c.activation.contacto.id) return fallar(root, c, 'CHAT_INCORRECTO', 'el mensaje apareció en otro chat');
  c.state = 'ACTIVE';
  c.generation += 1;
  c.contact = { id: c.activation.contacto.id, display: c.activation.contacto.display, target_hash: sha(c.activation.contacto.id).slice(0, 12) };
  c.activation = null;
  guardarConfig(root, c);
  auditar(root, { op: 'activacion', fase: 'activo', target: c.contact.target_hash, generation: c.generation, estado_entrega: v.estado });
  return {
    status: 'ACTIVE', mensaje: 'Protocolo WhatsApp activo', contacto: c.contact.display, generation: c.generation,
    entrega: v.estado, nota: v.estado === 'READ' ? 'leído' : 'enviado; eso no significa que ya se haya leído en el teléfono',
  };
}

function reintentar(root, { activation_id, adapter }) {
  const c = leerConfig(root);
  if (!c.activation || c.activation.id !== activation_id) return { status: 'ACTIVACION_DESCONOCIDA' };
  if (c.state === 'DELIVERY_UNKNOWN') {
    const l = adapter.lookupMessage({ correlation_id: c.activation.correlation });
    if (l.status === 'FOUND') return confirmarActivo(root, adapter, l.message_id);
    if (l.status !== 'NOT_FOUND') return { status: 'DELIVERY_UNKNOWN', detalle: 'sigue sin poder verificarse; no se reenvía' };
  } else if (!['ACTIVATION_FAILED', 'RESOLVING_CONTACT'].includes(c.state)) return { status: 'TRANSICION_INVALIDA', estado: c.state };
  if (!c.activation.consulta) { c.state = 'WAITING_CONTACT'; guardarConfig(root, c); return { status: 'ESPERANDO_CONTACTO', pregunta: PREGUNTA }; }
  return avanzar(root, adapter);
}

function explicacion(status) {
  return {
    MISSING_EXTENSION: 'falta la extensión del navegador que usa el transporte; instálala tú y vuelve a intentar',
    BROWSER_UNAVAILABLE: 'no hay un navegador disponible para el transporte',
    AUTH_REQUIRED: 'WhatsApp Web no tiene una sesión iniciada; iníciala tú (el QR no se escanea solo) y reintenta',
    UNSUPPORTED: 'este host no tiene un transporte de WhatsApp soportado',
  }[status] || status;
}

/** Corta envíos nuevos, reintentos y activaciones a medias. Lo ya enviado no se deshace. */
function desactivar(root, { adapter } = {}) {
  const c = leerConfig(root);
  c.generation += 1;
  if (c.contact) c.anterior = c.contact.display;
  c.contact = null;
  c.activation = null;
  c.state = 'OFF';
  guardarConfig(root, c);
  const l = entregas(root);
  let cancelados = 0;
  for (const e of l) if (['QUEUED', 'UNKNOWN'].includes(e.state)) { e.state = 'CANCELLED'; e.motivo = 'DESACTIVADO'; cancelados++; }
  guardarEntregas(root, l);
  if (adapter && typeof adapter.cancelOwned === 'function') { try { adapter.cancelOwned(); } catch { /* sin transporte */ } }
  auditar(root, { op: 'desactivar', generation: c.generation, cancelados });
  return { status: 'OFF', generation: c.generation, cancelados, nota: 'los mensajes ya enviados no se pueden deshacer; el historial de auditoría se conserva' };
}

function estado(root) {
  const c = leerConfig(root);
  const l = entregas(root);
  const por = Object.fromEntries(['QUEUED', 'SENT', 'FAILED', 'UNKNOWN', 'CANCELLED'].map((s) => [s, l.filter((e) => e.state === s).length]));
  return {
    status: 'OK', estado: c.state, generation: c.generation, contacto: c.contact ? c.contact.display : null, transporte: c.transport_id,
    activation: c.activation ? { id: c.activation.id, estado: c.state, fallo: c.activation.fallo } : null,
    politica: textoPolitica(c.politica), entregas: por,
  };
}

// ─── avisos ──────────────────────────────────────────────────────────────────

function limpiar(texto) {
  let t = String(texto || '').replace(/[A-Za-z]:[\\/][^\s]+|(?:\.{0,2}\/)?(?:[\w.-]+\/){2,}[\w.-]+/g, '[ruta]').slice(0, 300);
  try { t = require('./telemetry.cjs').redactar(t); } catch { /* sin redactor */ }
  return t;
}

function componerMensaje(root, ev) {
  const etiqueta = { INCIDENTE_GLOBAL: 'Incidente', SIN_TAREAS_POR_DECISION: 'Necesito una decisión', RECUPERACION_AGOTADA: 'Recuperación agotada', CONSTRUCTOR_INTERRUMPIDO: 'Constructor detenido', REPORTE_FINAL: 'Reporte final', PROGRESO: 'Avance' }[ev.evento];
  return [
    `Agentix · ${nombreProyecto(root)}`,
    `${etiqueta}${ev.tarea ? ' · ' + limpiar(ev.tarea) : ''}${ev.incident_id ? ' · ' + limpiar(ev.incident_id) : ''}: ${limpiar(ev.que || '')}`,
    `Sigue: ${limpiar(ev.sigue || 'lo que no depende de esto')}`,
    `Necesito: ${limpiar(ev.accion || 'nada por ahora')}`,
  ].join('\n');
}

/** Encola un aviso si la política lo permite. Nunca envía aquí. */
function notificar(root, ev, { ahora = Date.now() } = {}) {
  const c = leerConfig(root);
  if (c.project_id !== proyectoId(root)) return { status: 'OTRO_PROYECTO', detalle: 'esta configuración no es de este proyecto' };
  if (!['ACTIVE', 'DEGRADED'].includes(c.state)) return { status: 'NO_ACTIVO' };
  if (!EVENTOS.includes(ev.evento) || !c.politica.eventos[ev.evento]) return { status: 'EVENTO_NO_AUTORIZADO' };
  const sujeto = ev.evento === 'REPORTE_FINAL' ? `${ev.plan_id || '-'}#${ev.revision || 0}` : ev.incident_id || ev.tarea || '-';
  const key = sha([c.project_id, ev.plan_id || '-', ev.evento, sujeto, c.generation, c.contact.target_hash].join('|')).slice(0, 32);
  const l = entregas(root);
  if (l.some((e) => e.key === key)) return { status: 'DUPLICADO', key };
  let noAntesDe = ahora;
  if (ev.evento === 'PROGRESO') {
    const ult = l.filter((e) => e.evento === 'PROGRESO' && e.generation === c.generation && e.state !== 'CANCELLED').map((e) => e.created_ms).sort().pop();
    if (ult && ahora - ult < c.politica.limites.progreso_cada_min * 60000) return { status: 'RATE_LIMITED' };
  }
  if (EMERGENCIAS.includes(ev.evento)) {
    const ult = l.filter((e) => EMERGENCIAS.includes(e.evento) && e.state === 'SENT' && e.generation === c.generation).map((e) => e.sent_ms).sort().pop();
    if (ult) noAntesDe = Math.max(ahora, ult + c.politica.limites.cooldown_emergencia_min * 60000);
  }
  const e = {
    id: 'wd-' + crypto.randomBytes(4).toString('hex'), key, evento: ev.evento, incident_id: ev.incident_id || null, generation: c.generation,
    target: c.contact.target_hash, texto: componerMensaje(root, ev), state: 'QUEUED', created_ms: ahora, no_antes_de: noAntesDe, intentos: 0,
  };
  l.push(e);
  guardarEntregas(root, l);
  auditar(root, { op: 'aviso', fase: 'encolado', id: e.id, evento: e.evento, target: e.target });
  return { status: 'ENCOLADO', id: e.id, key };
}

/**
 * Envía lo pendiente. Justo antes de cada envío revalida estado, generación
 * y proyecto. Emergencias listas al mismo tiempo salen en un solo mensaje.
 * Un canal caído deja la cola quieta y el estado DEGRADED, sin más avisos.
 */
function procesarCola(root, { adapter, ahora = Date.now() } = {}) {
  const out = { enviados: 0, cancelados: 0, fallidos: 0, desconocidos: 0, pendientes: 0 };
  let c = leerConfig(root);
  const l = entregas(root);
  const vigente = (e) => ['ACTIVE', 'DEGRADED'].includes(c.state) && c.project_id === proyectoId(root) && e.generation === c.generation && c.contact && e.target === c.contact.target_hash;
  for (const e of l) if (e.state === 'QUEUED' && !vigente(e)) { e.state = 'CANCELLED'; e.motivo = 'GENERACION_O_ESTADO'; out.cancelados++; }
  const listos = l.filter((e) => e.state === 'QUEUED' && e.no_antes_de <= ahora);
  if (!listos.length) { guardarEntregas(root, l); out.pendientes = l.filter((e) => e.state === 'QUEUED').length; return out; }
  const h = adapter.health();
  if (h.status !== 'OK') {
    if (c.state !== 'DEGRADED') { c.state = 'DEGRADED'; guardarConfig(root, c); auditar(root, { op: 'canal', estado: 'DEGRADED', motivo: h.status }); }
    guardarEntregas(root, l);
    out.pendientes = listos.length;
    return out;
  }
  const emerg = listos.filter((e) => EMERGENCIAS.includes(e.evento));
  const grupos = [...(emerg.length ? [emerg] : []), ...listos.filter((e) => !EMERGENCIAS.includes(e.evento)).map((e) => [e])];
  for (const g of grupos) {
    c = leerConfig(root);
    if (!g.every(vigente)) { for (const e of g) { e.state = 'CANCELLED'; e.motivo = 'GENERACION_O_ESTADO'; out.cancelados++; } continue; }
    const texto = g.length === 1 ? g[0].texto : g.map((e) => e.texto).join('\n—\n');
    const correlation = sha(g.map((e) => e.key).join(',')).slice(0, 24);
    const marcar = (estadoNuevo, extra) => { for (const e of g) Object.assign(e, { state: estadoNuevo, correlation }, extra); };
    const ya = adapter.lookupMessage({ correlation_id: correlation });
    if (ya.status === 'FOUND') { marcar('SENT', { message_id: ya.message_id, sent_ms: ahora }); out.enviados++; continue; }
    const s = adapter.sendMessage({ contact_id: c.contact.id, text: texto, correlation_id: correlation });
    if (s.status === 'SENT') { marcar('SENT', { message_id: s.message_id, sent_ms: ahora }); out.enviados++; }
    else if (s.status === 'TIMEOUT') {
      const lk = adapter.lookupMessage({ correlation_id: correlation });
      if (lk.status === 'FOUND') { marcar('SENT', { message_id: lk.message_id, sent_ms: ahora }); out.enviados++; }
      else if (lk.status === 'NOT_FOUND') { for (const e of g) e.intentos++; out.pendientes += g.length; }
      else { marcar('UNKNOWN', {}); out.desconocidos++; }
    } else {
      for (const e of g) { e.intentos++; if (e.intentos >= c.politica.limites.max_intentos) { e.state = 'FAILED'; out.fallidos++; } else out.pendientes++; }
      if (c.state !== 'DEGRADED') { c.state = 'DEGRADED'; guardarConfig(root, c); auditar(root, { op: 'canal', estado: 'DEGRADED', motivo: s.motivo || s.status }); }
      continue;
    }
    if (c.state === 'DEGRADED') { c.state = 'ACTIVE'; guardarConfig(root, c); auditar(root, { op: 'canal', estado: 'ACTIVE' }); }
    for (const e of g) auditar(root, { op: 'aviso', fase: e.state, id: e.id, target: e.target });
  }
  guardarEntregas(root, l);
  return out;
}

// ─── enlace con TEAMS ────────────────────────────────────────────────────────

/**
 * Lee los eventos nuevos de TEAMS y encola los avisos que la política
 * permite. Avanza su propio cursor: no consume el ACK del director.
 */
function desdeTeams(root, { ahora = Date.now() } = {}) {
  let tm;
  try { tm = require('./teams-manager.cjs'); } catch { return { status: 'SIN_TEAMS' }; }
  const est = tm.estado(root);
  if (!est.inicializado) return { status: 'SIN_TEAMS' };
  const c = leerConfig(root);
  const d = tm.delta(root, { rol: 'director', desde: c.teams_cursor || 0, limite: 500 });
  const avisos = [];
  const plan = est.plan ? est.plan.id : null;
  for (const ev of d.eventos) {
    const p = ev.payload || {};
    if (ev.kind === 'INCIDENT' && p.scope === 'GLOBAL') avisos.push({ evento: 'INCIDENTE_GLOBAL', incident_id: p.id, plan_id: plan, que: `alto global (${p.reason_code})`, accion: 'revisar el incidente en el chat del proyecto' });
    if (ev.kind === 'STOP' && ['LIMITE_REPARACIONES', 'RESTORE_FAILED'].includes(p.reason_code)) {
      const t = est.tareas.find((x) => x.id === ev.task_id);
      if (p.reason_code === 'RESTORE_FAILED' || (t && t.tier === 'HIGH')) avisos.push({ evento: 'RECUPERACION_AGOTADA', incident_id: p.id, plan_id: plan, tarea: ev.task_id, que: `sin más intentos automáticos (${p.reason_code})`, accion: 'decidir cómo seguir con esa tarea' });
    }
  }
  const ejecutables = est.tareas.some((t) => ['READY', 'RUNNING', 'VERIFYING', 'PENDING'].includes(t.state));
  const humanas = est.pendientes.filter((x) => x.scope !== 'CHANNEL');
  if (!ejecutables && humanas.length) avisos.push({ evento: 'SIN_TAREAS_POR_DECISION', incident_id: humanas.map((x) => x.id).sort().join(','), plan_id: plan, que: `todo lo que queda espera ${humanas.length} decisión(es)`, accion: 'responder en el chat: teams: resolver <id> <decisión>' });
  const total = est.tareas.length;
  if (total && est.tareas.every((t) => ['DONE_VERIFIED', 'CANCELLED'].includes(t.state))) avisos.push({ evento: 'REPORTE_FINAL', plan_id: plan, revision: total, que: `plan cerrado: ${est.conteo.DONE_VERIFIED || 0} verificadas, ${est.conteo.CANCELLED || 0} canceladas` });
  const resultados = avisos.map((a) => Object.assign({ evento: a.evento }, notificar(root, a, { ahora })));
  const c2 = leerConfig(root);
  c2.teams_cursor = d.eventos.length ? d.eventos[d.eventos.length - 1].seq : c.teams_cursor || 0;
  guardarConfig(root, c2);
  return { status: 'OK', avisos: resultados };
}

// ─── llamadas y mensajes entrantes ───────────────────────────────────────────

/** Llamar solo con soporte real, habilitado a propósito, y un incidente confirmado. */
function llamar(root, { adapter, incident_id, confirmado = false, ahora = Date.now() }) {
  const c = leerConfig(root);
  if (!c.politica.llamadas.enabled) return { status: 'DISABLED', detalle: 'las llamadas están deshabilitadas; se usa mensaje' };
  if (!adapter.capabilities().call) return { status: 'UNSUPPORTED', detalle: 'este transporte no hace llamadas; se usa mensaje' };
  if (!confirmado) return { status: 'NO_CONFIRMADO', detalle: 'una sospecha no justifica una llamada' };
  if (c.state !== 'ACTIVE' || !c.contact) return { status: 'NO_ACTIVO' };
  if (c.ultima_llamada && ahora - c.ultima_llamada < c.politica.llamadas.cooldown_min * 60000) return { status: 'COOLDOWN' };
  const r = adapter.callContact({ contact_id: c.contact.id });
  c.ultima_llamada = ahora;
  guardarConfig(root, c);
  auditar(root, { op: 'llamada', incident_id, target: c.contact.target_hash, resultado: r.status });
  return r;
}

/** Lo que llega por WhatsApp es dato. No aprueba, no resuelve, no amplía permisos. */
function entrante(texto) {
  return { confiable: false, accion: 'NINGUNA', texto: String(texto || '').slice(0, 500), nota: 'las decisiones se toman en el chat del proyecto o en una terminal' };
}

// ─── chat / CLI ──────────────────────────────────────────────────────────────

function parsearIntencion(texto) {
  const m = /^\s*ws:\s*(\S+)?\s*(.*)$/i.exec(String(texto || ''));
  if (!m) return null;
  const mapa = { activar: 'activar', desactivar: 'desactivar', estado: 'estado', politica: 'politica', 'política': 'politica', reintentar: 'reintentar' };
  return { accion: mapa[String(m[1] || '').toLowerCase()] || null, resto: m[2].trim() };
}

function adapterActual(root, inyectado) {
  if (inyectado) return inyectado;
  return require('./whatsapp-adapters.cjs').adapterDe(leerConfig(root).transport_id, root);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; }));
  const pos = args.filter((a) => !a.startsWith('--'));
  const root = process.cwd();
  const origen = process.stdin.isTTY ? 'cli-tty' : 'hook-prompt';
  const ad = adapterActual(root);
  const cmd = pos[0] || 'estado';
  let r;
  if (cmd === 'activar') r = activar(root, { origen });
  else if (cmd === 'contacto') r = contacto(root, { activation_id: pos[1], texto: pos.slice(2).join(' '), origen, adapter: ad });
  else if (cmd === 'elegir') r = elegir(root, { activation_id: pos[1], eleccion: pos[2], origen, adapter: ad });
  else if (cmd === 'reintentar') r = reintentar(root, { activation_id: pos[1], adapter: ad });
  else if (cmd === 'desactivar') r = desactivar(root, { adapter: ad });
  else if (cmd === 'estado') r = estado(root);
  else if (cmd === 'politica') r = configurarPolitica(root, { progreso: opt.progreso == null ? undefined : opt.progreso !== 'off', progreso_cada_min: opt.cada, cooldown_emergencia_min: opt.cooldown, country: opt.pais, llamadas: opt.llamadas == null ? undefined : opt.llamadas === 'on' });
  else if (cmd === 'procesar') r = procesarCola(root, { adapter: ad });
  else if (cmd === 'teams') r = desdeTeams(root);
  else r = { status: 'USO', detalle: 'whatsapp-manager.cjs activar | contacto <id> <número o nombre> | elegir <id> <n> | reintentar <id> | desactivar | estado | politica [--progreso=on|off --cada=15 --cooldown=5 --pais=58 --llamadas=on|off] | procesar | teams' };
  console.log(JSON.stringify(r, null, 2));
}

module.exports = {
  SCHEMA_VERSION, ESTADOS, EVENTOS, EMERGENCIAS, POLITICA_DEFECTO, PREGUNTA,
  activar, contacto, elegir, reintentar, desactivar, estado, configurarPolitica, notificar, procesarCola, desdeTeams, llamar, entrante,
  validarContacto, enmascarar, registrarOrigenHumano, origenDesdePrompt, parsearIntencion, leerConfig, entregas, componerMensaje, adapterActual,
};
