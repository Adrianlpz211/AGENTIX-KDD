'use strict';

/**
 * WhatsApp por el navegador del agente (C03). El proceso de Node no puede
 * llamar a las herramientas de navegador del modelo: le deja tareas tipadas y
 * la sesión del agente (Claude Code con navegador, conector o extensión) las
 * ejecuta en su siguiente pase y deja el resultado con evidencia.
 *
 *   .agentic/_whatsapp/navegador.json           capacidad que reporta la sesión
 *   .agentic/_whatsapp/tareas-navegador.jsonl    tareas (las escribe el manager)
 *   .agentic/_whatsapp/resultados-navegador.jsonl resultados (los escribe la sesión)
 *
 * Reglas: sin reporte de capacidad vigente no hay envío; una vía que necesita
 * extensión sin extensión es MISSING_EXTENSION; sin sesión de WhatsApp Web es
 * AUTH_REQUIRED; un host sin herramientas de navegador es UNSUPPORTED (no por
 * el nombre del modelo). SENT significa observado en el chat correcto, no
 * entregado al teléfono. Mientras la sesión no responde, el envío queda
 * pendiente y la consulta lo dice: nunca se reenvía a ciegas.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VIGENCIA_CAPACIDAD_MS = 15 * 60 * 1000;
const dir = (root) => path.join(root, '.agentic', '_whatsapp');
const fCap = (root) => path.join(dir(root), 'navegador.json');
const fTareas = (root) => path.join(dir(root), 'tareas-navegador.jsonl');
const fResultados = (root) => path.join(dir(root), 'resultados-navegador.jsonl');

const leerJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
function leerLineas(f) {
  let txt = '';
  try { txt = fs.readFileSync(f, 'utf8'); } catch { return []; }
  return txt.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function agregar(f, obj) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, JSON.stringify(Object.assign({ at: new Date().toISOString() }, obj)) + '\n');
}

/* ─── lado de la sesión del agente ────────────────────────────────────────── */

/**
 * La sesión declara lo que de verdad tiene expuesto: herramientas de
 * navegador, si su vía necesita extensión y si está instalada, y si WhatsApp
 * Web tiene sesión iniciada por la persona en ese perfil.
 */
function reportarCapacidad(root, { host, herramientas = [], via = 'nativa', extension_instalada = false, whatsapp_sesion = 'DESCONOCIDA', perfil = null, llamadas = false }) {
  const cap = { host: host || null, herramientas, via, extension_instalada: !!extension_instalada, whatsapp_sesion, perfil, llamadas: !!llamadas, reportado_at: new Date().toISOString() };
  fs.mkdirSync(dir(root), { recursive: true });
  const tmp = fCap(root) + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cap, null, 2));
  fs.renameSync(tmp, fCap(root));
  return { status: 'OK', capacidad: cap };
}

/** Tareas que la sesión debe ejecutar: sin resultado y sin cancelar. */
function tareasPendientes(root) {
  const hechas = new Set(leerLineas(fResultados(root)).map((r) => r.task_id));
  const ts = leerLineas(fTareas(root));
  const canceladas = new Set(ts.filter((t) => t.tipo === 'cancelar').map((t) => t.task_id));
  return ts.filter((t) => t.tipo !== 'cancelar' && !hechas.has(t.task_id) && !canceladas.has(t.task_id));
}

/**
 * Resultado de una tarea, con la evidencia de lo observado en el navegador.
 * enviar → { status: SENT_OBSERVED | FAILED, chat_id, message_id, evidencia }
 * buscar → { status: OK | AMBIGUOUS | NOT_FOUND, candidatos }
 */
function registrarResultado(root, task_id, resultado) {
  const t = leerLineas(fTareas(root)).find((x) => x.task_id === task_id && x.tipo !== 'cancelar');
  if (!t) return { status: 'TAREA_DESCONOCIDA' };
  if (t.cancelled || t.generation && resultado && resultado.generation && t.generation !== resultado.generation) {
    return { status: 'RECHAZADO', reason_code: 'OPERACION_VIEJA_O_CANCELADA' };
  }
  if (leerLineas(fResultados(root)).some((r) => r.task_id === task_id)) return { status: 'OK', duplicado: true };
  const r = resultado || {};
  if (t.tipo === 'enviar') {
    if (r.status === 'SENT_OBSERVED') {
      if (t.chat_esperado && r.chat_id && r.chat_id !== t.chat_esperado) {
        agregar(fResultados(root), Object.assign({ task_id, tipo: t.tipo, correlation_id: t.correlation_id || null }, r, {
          status: 'FAILED', reason_code: 'CHAT_INCORRECTO',
        }));
        return { status: 'RECHAZADO', reason_code: 'CHAT_INCORRECTO' };
      }
      if (!r.message_id || !r.evidencia) return { status: 'RECHAZADO', reason_code: 'SIN_MENSAJE_NI_EVIDENCIA' };
    }
  }
  agregar(fResultados(root), Object.assign({ task_id, tipo: t.tipo, correlation_id: t.correlation_id || null }, r));
  return { status: 'OK' };
}

/* ─── lado del manager ────────────────────────────────────────────────────── */

const VIAS_CON_EXTENSION = new Set(['extension']);
const HERRAMIENTA_NAVEGADOR = /navigate|browser|navegador|page|tab/i;

class AdapterBrowserAgent {
  constructor(root, { ahora = () => Date.now() } = {}) { this.root = root; this.ahora = ahora; }

  capacidad() {
    const c = leerJson(fCap(this.root));
    if (!c) return null;
    return Object.assign({}, c, { vigente: this.ahora() - Date.parse(c.reportado_at) <= VIGENCIA_CAPACIDAD_MS });
  }

  capabilities() {
    const c = this.capacidad();
    const nav = !!(c && c.herramientas.some((h) => HERRAMIENTA_NAVEGADOR.test(h)));
    return { transport_id: 'browser-agent', send: nav, lookup: nav, call: false, heartbeat: false, asincrono: true };
  }

  health() {
    const c = this.capacidad();
    if (!c) return { status: 'UNSUPPORTED', detalle: 'la sesión del agente no ha reportado capacidad de navegador: desde Claude Code con navegador corre node .agentic/grafo/whatsapp-browser-agent.cjs capacidad ...' };
    if (!c.herramientas.some((h) => HERRAMIENTA_NAVEGADOR.test(h))) return { status: 'UNSUPPORTED', detalle: `el host ${c.host || 'actual'} no expone herramientas de navegador al agente` };
    if (!c.vigente) return { status: 'BROWSER_UNAVAILABLE', detalle: 'el reporte de capacidad venció: la sesión del agente debe volver a reportarlo' };
    if (VIAS_CON_EXTENSION.has(c.via) && !c.extension_instalada) return { status: 'MISSING_EXTENSION', detalle: 'la vía de navegador de este host necesita su extensión; instálala tú en tu perfil y vuelve a reportar' };
    if (c.whatsapp_sesion !== 'ACTIVA') return { status: 'AUTH_REQUIRED', detalle: 'WhatsApp Web no tiene sesión iniciada en ese perfil; iníciala tú (el QR no se escanea solo)' };
    return { status: 'OK' };
  }

  encolar(tarea) {
    const t = Object.assign({ task_id: 'nav-' + crypto.randomUUID().slice(0, 12) }, tarea);
    agregar(fTareas(this.root), t);
    return t;
  }

  resultadoDe(pred) { return leerLineas(fResultados(this.root)).filter(pred).pop() || null; }

  /** Un número se verifica en el navegador al enviar; un nombre se busca allí. */
  resolveContact({ query, tipo }) {
    if (tipo === 'numero') return { status: 'OK', contact: { id: String(query), display: String(query) } };
    const r = this.resultadoDe((x) => x.tipo === 'buscar' && x.query === query);
    if (!r) {
      if (!tareasPendientes(this.root).some((t) => t.tipo === 'buscar' && t.query === query)) this.encolar({ tipo: 'buscar', query });
      return { status: 'PENDING', detalle: 'la sesión del agente busca el contacto en su siguiente pase' };
    }
    if (r.status === 'AMBIGUOUS') return { status: 'AMBIGUOUS_CONTACT', candidatos: r.candidatos };
    if (r.status === 'OK') return { status: 'OK', contact: r.contacto };
    return { status: 'CONTACT_NOT_FOUND' };
  }

  /** Encola una sola vez por correlation_id; el resultado llega después. */
  sendMessage({ contact_id, text, correlation_id }) {
    const r = this.resultadoDe((x) => x.tipo === 'enviar' && x.correlation_id === correlation_id);
    if (r) return r.status === 'SENT_OBSERVED' ? { status: 'SENT', message_id: r.message_id } : { status: 'FAILED', motivo: r.motivo || 'la sesión no pudo enviarlo' };
    const ya = leerLineas(fTareas(this.root)).some((t) => t.tipo === 'enviar' && t.correlation_id === correlation_id);
    if (!ya) this.encolar({ tipo: 'enviar', chat_esperado: contact_id, texto: text, correlation_id, verificar_destinatario: true });
    return { status: 'TIMEOUT', detalle: 'tarea entregada a la sesión del agente; el resultado se consulta, no se reenvía' };
  }

  lookupMessage({ message_id, correlation_id }) {
    const r = this.resultadoDe((x) => x.tipo === 'enviar' && ((correlation_id && x.correlation_id === correlation_id) || (message_id && x.message_id === message_id)));
    if (r) {
      if (r.status !== 'SENT_OBSERVED') return { status: 'NOT_FOUND' };
      return { status: 'FOUND', message_id: r.message_id, chat_id: r.chat_id, estado: 'SENT', evidencia: r.evidencia || null };
    }
    const pendiente = leerLineas(fTareas(this.root)).some((t) => t.tipo === 'enviar' && t.correlation_id === correlation_id);
    return pendiente ? { status: 'PENDING' } : { status: 'NOT_FOUND' };
  }

  callContact() {
    return { status: 'UNSUPPORTED', detalle: 'call:false — no hay ejecución real de llamadas; se ofrece texto' };
  }

  /** Cancela las tareas propias sin resultado; lo ya enviado no se deshace. */
  cancelOwned() {
    const pend = tareasPendientes(this.root);
    for (const t of pend) agregar(fTareas(this.root), { tipo: 'cancelar', task_id: t.task_id });
    return { status: 'OK', cancelados: pend.length };
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; }));
  const cmd = args.find((a) => !a.startsWith('--')) || 'estado';
  const root = process.cwd();
  let r;
  if (cmd === 'capacidad') {
    r = reportarCapacidad(root, {
      host: opt.host, herramientas: String(opt.herramientas || '').split(',').filter(Boolean), via: opt.via || 'nativa',
      extension_instalada: opt.extension === 'si', whatsapp_sesion: opt.sesion || 'DESCONOCIDA', llamadas: opt.llamadas === 'si',
    });
  } else if (cmd === 'tareas') r = tareasPendientes(root);
  else if (cmd === 'resultado') r = registrarResultado(root, opt.tarea, JSON.parse(fs.readFileSync(path.resolve(root, opt.archivo), 'utf8')));
  else { const a = new AdapterBrowserAgent(root); r = { capabilities: a.capabilities(), health: a.health() }; }
  console.log(JSON.stringify(r, null, 2));
}

module.exports = { AdapterBrowserAgent, reportarCapacidad, tareasPendientes, registrarResultado, VIGENCIA_CAPACIDAD_MS };
