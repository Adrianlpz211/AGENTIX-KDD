'use strict';

/**
 * Transporte de WhatsApp. Contrato:
 *   capabilities() → { transport_id, send, lookup, call, heartbeat }
 *   health()       → { status: OK | MISSING_EXTENSION | BROWSER_UNAVAILABLE | AUTH_REQUIRED | UNSUPPORTED, detalle }
 *   resolveContact({ query, tipo })  → OK {contact} | CONTACT_NOT_FOUND | AMBIGUOUS_CONTACT {candidatos}
 *   sendMessage({ contact_id, text, correlation_id }) → SENT {message_id} | TIMEOUT | FAILED {motivo}
 *   lookupMessage({ message_id, correlation_id }) → FOUND {message_id, chat_id, estado} | NOT_FOUND | UNSUPPORTED
 *   callContact({ contact_id })      → opcional
 *   cancelOwned()                    → cancela solo lo propio
 *
 * No hay un transporte real probado en este entorno: una extensión de Chrome
 * no expone una API universal y WhatsApp Web no se automatiza sin la sesión,
 * el perfil y el permiso de la persona. Por eso el adapter por defecto dice
 * UNSUPPORTED y explica qué falta. Nunca se simula un envío escribiendo un log.
 */

const fs = require('fs');
const path = require('path');

class AdapterNoDisponible {
  capabilities() { return { transport_id: 'none', send: false, lookup: false, call: false, heartbeat: false }; }
  health() {
    return {
      status: 'UNSUPPORTED',
      detalle: 'no hay un transporte de WhatsApp instalado y probado para este host. Hace falta un conector o una automatización de navegador '
        + 'autorizada sobre el WhatsApp Web de la persona (sesión iniciada por ella, sin QR automático ni cambio de perfil). Agentix sigue funcionando sin WhatsApp.',
    };
  }
  resolveContact() { return { status: 'UNSUPPORTED' }; }
  sendMessage() { return { status: 'UNSUPPORTED' }; }
  lookupMessage() { return { status: 'UNSUPPORTED' }; }
  cancelOwned() { return { status: 'OK', cancelados: 0 }; }
}

/**
 * Solo para pruebas de lógica. Lleva su propio "teléfono" en memoria para
 * poder afirmar qué se habría enviado; no habla con WhatsApp.
 */
class AdapterPrueba {
  constructor(o = {}) {
    this.o = Object.assign({ salud: 'OK', contactos: [], llamadas: false, heartbeat: true, lookup: true }, o);
    this.enviados = [];
    this.llamadas = [];
    this.cancelados = 0;
    this.intentosEnvio = 0;
    this.fallarEnvio = o.fallarEnvio || null;
  }
  capabilities() { return { transport_id: 'prueba', send: true, lookup: this.o.lookup, call: this.o.llamadas, heartbeat: this.o.heartbeat }; }
  health() { return { status: typeof this.o.salud === 'function' ? this.o.salud() : this.o.salud }; }
  resolveContact({ query, tipo }) {
    const q = String(query).toLowerCase();
    const hits = this.o.contactos.filter((c) => (tipo === 'numero' ? c.numero === query : c.nombre.toLowerCase().includes(q)));
    if (!hits.length) return { status: 'CONTACT_NOT_FOUND' };
    if (hits.length > 1) return { status: 'AMBIGUOUS_CONTACT', candidatos: hits.map((c) => ({ id: c.id, display: c.nombre })) };
    return { status: 'OK', contact: { id: hits[0].id, display: hits[0].nombre } };
  }
  sendMessage({ contact_id, text, correlation_id }) {
    const modo = typeof this.fallarEnvio === 'function' ? this.fallarEnvio(this.intentosEnvio++) : this.fallarEnvio;
    if (modo === 'FAILED') return { status: 'FAILED', motivo: 'transporte caído' };
    const m = { message_id: 'm-' + (this.enviados.length + 1), chat_id: contact_id, text, correlation_id, estado: 'SENT' };
    if (modo === 'TIMEOUT_PERDIDO') return { status: 'TIMEOUT' };
    this.enviados.push(m);
    if (modo === 'TIMEOUT') return { status: 'TIMEOUT' };
    return { status: 'SENT', message_id: m.message_id };
  }
  lookupMessage({ message_id, correlation_id }) {
    if (!this.o.lookup) return { status: 'UNSUPPORTED' };
    const m = this.enviados.find((x) => (message_id && x.message_id === message_id) || (correlation_id && x.correlation_id === correlation_id));
    return m ? { status: 'FOUND', message_id: m.message_id, chat_id: m.chat_id, estado: m.estado } : { status: 'NOT_FOUND' };
  }
  callContact({ contact_id }) {
    if (!this.o.llamadas) return { status: 'UNSUPPORTED' };
    this.llamadas.push(contact_id);
    return { status: 'CALLED' };
  }
  cancelOwned() { this.cancelados++; return { status: 'OK' }; }
}

const REGISTRO = {
  none: () => new AdapterNoDisponible(),
  'browser-agent': (root) => new (require('./whatsapp-browser-agent.cjs').AdapterBrowserAgent)(root),
};

/**
 * El adapter que corresponde al proyecto. Si la sesión del agente reportó su
 * navegador, se usa esa vía sin que la persona tenga que elegir transporte.
 */
function adapterDe(transportId, root) {
  let id = transportId || 'none';
  if (id === 'none' && root) {
    try { if (fs.existsSync(path.join(root, '.agentic', '_whatsapp', 'navegador.json'))) id = 'browser-agent'; } catch { /* sin reporte */ }
  }
  const f = REGISTRO[id] || REGISTRO.none;
  return id === 'browser-agent' && !root ? REGISTRO.none() : f(root);
}

module.exports = { AdapterNoDisponible, AdapterPrueba, adapterDe, REGISTRO };
