'use strict';

/* C03 — WhatsApp por el navegador del agente. La "sesión del agente" se
   simula escribiendo su capacidad y sus resultados; ningún mensaje real sale. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const G = path.join(__dirname, '..', '.agentic', 'grafo');
const ws = require(path.join(G, 'whatsapp-manager.cjs'));
const ba = require(path.join(G, 'whatsapp-browser-agent.cjs'));
const { adapterDe, AdapterNoDisponible } = require(path.join(G, 'whatsapp-adapters.cjs'));
const hg = require(path.join(G, 'host-guard.cjs'));

function proyecto() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-c03-'));
  fs.mkdirSync(path.join(root, '.agentic'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agentic', 'config.md'), 'CONFIGURADO: SI\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'tienda' }));
  require(path.join(G, 'db-adapter.cjs')).openWrite(path.join(root, '.agentic', 'memoria.db')).close();
  return root;
}
const escribe = (root, texto) => hg.procesar('cursor', 'prompt', { prompt: texto }, root);
const capacidadSana = (root, extra = {}) => ba.reportarCapacidad(root, Object.assign({ host: 'claude-code', herramientas: ['browser_navigate', 'browser_click'], via: 'nativa', whatsapp_sesion: 'ACTIVA' }, extra));

function activar(root, contacto) {
  escribe(root, 'ws: activar');
  const a = ws.activar(root, { origen: 'hook-prompt' });
  escribe(root, contacto);
  return { a, r: ws.contacto(root, { activation_id: a.activation_id, texto: contacto, origen: 'hook-prompt', adapter: ws.adapterActual(root) }) };
}

test('C03: la capacidad la declara la sesión, no el nombre del modelo', () => {
  const root = proyecto();
  assert.ok(adapterDe('none', root) instanceof AdapterNoDisponible, 'sin reporte no se elige navegador');
  ba.reportarCapacidad(root, { host: 'otro', herramientas: [], whatsapp_sesion: 'ACTIVA' });
  const a = adapterDe('none', root);
  assert.strictEqual(a.capabilities().transport_id, 'browser-agent', 'se elige solo, sin cargar a la persona');
  assert.strictEqual(a.health().status, 'UNSUPPORTED');
  ba.reportarCapacidad(root, { host: 'claude-code', herramientas: ['browser_navigate'], via: 'extension', extension_instalada: false, whatsapp_sesion: 'ACTIVA' });
  assert.strictEqual(adapterDe('none', root).health().status, 'MISSING_EXTENSION');
  capacidadSana(root, { whatsapp_sesion: 'SIN_SESION' });
  assert.strictEqual(adapterDe('none', root).health().status, 'AUTH_REQUIRED');
  capacidadSana(root);
  assert.strictEqual(adapterDe('none', root).health().status, 'OK');
  const viejo = new ba.AdapterBrowserAgent(root, { ahora: () => Date.now() + ba.VIGENCIA_CAPACIDAD_MS + 1000 });
  assert.strictEqual(viejo.health().status, 'BROWSER_UNAVAILABLE', 'un reporte vencido no vale');
});

test('C03: sin extensión la activación falla con la acción, sin instalar nada', () => {
  const root = proyecto();
  capacidadSana(root, { via: 'extension', extension_instalada: false });
  const { r } = activar(root, '+584121234567');
  assert.strictEqual(r.status, 'ACTIVATION_FAILED');
  assert.strictEqual(r.motivo, 'MISSING_EXTENSION');
  assert.match(r.detalle, /instálala tú/);
  assert.ok(!fs.existsSync(path.join(root, '.agentic', '_whatsapp', 'tareas-navegador.jsonl')), 'no se encoló ningún envío');
});

test('C03: envío por tarea tipada; ACTIVE solo cuando la sesión lo observó en el chat correcto', () => {
  const root = proyecto();
  capacidadSana(root);
  const { a, r } = activar(root, '+584121234567');
  assert.strictEqual(r.status, 'DELIVERY_UNKNOWN', 'mientras la sesión no responde no se afirma nada');
  const pend = ba.tareasPendientes(root);
  assert.strictEqual(pend.length, 1);
  assert.strictEqual(pend[0].tipo, 'enviar');
  assert.ok(pend[0].correlation_id);
  assert.strictEqual(pend[0].verificar_destinatario, true);

  const r2 = ws.reintentar(root, { activation_id: a.activation_id, adapter: ws.adapterActual(root) });
  assert.strictEqual(r2.status, 'DELIVERY_UNKNOWN', 'consulta antes de repetir; no reenvía');
  assert.strictEqual(fs.readFileSync(path.join(root, '.agentic', '_whatsapp', 'tareas-navegador.jsonl'), 'utf8').trim().split('\n').length, 1, 'una sola tarea de envío');

  ba.registrarResultado(root, pend[0].task_id, { status: 'SENT_OBSERVED', chat_id: pend[0].chat_esperado, message_id: 'm-1', evidencia: { captura: 'x.png' } });
  const r3 = ws.reintentar(root, { activation_id: a.activation_id, adapter: ws.adapterActual(root) });
  assert.strictEqual(r3.status, 'ACTIVE');
  assert.match(r3.nota, /no significa que ya se haya leído/);
});

test('C03: si apareció en otro chat no se activa', () => {
  const root = proyecto();
  capacidadSana(root);
  const { a } = activar(root, '+584121234567');
  const t = ba.tareasPendientes(root)[0];
  ba.registrarResultado(root, t.task_id, { status: 'SENT_OBSERVED', chat_id: 'otro-chat', message_id: 'm-2' });
  const r = ws.reintentar(root, { activation_id: a.activation_id, adapter: ws.adapterActual(root) });
  assert.notStrictEqual(r.status, 'ACTIVE');
  assert.strictEqual(ws.estado(root).estado, 'ACTIVATION_FAILED');
});

test('C03: un nombre ambiguo se pregunta; la búsqueda la hace la sesión', () => {
  const root = proyecto();
  capacidadSana(root);
  const { a, r } = activar(root, 'Ana');
  assert.strictEqual(r.status, 'ESPERANDO_NAVEGADOR');
  const b = ba.tareasPendientes(root).find((t) => t.tipo === 'buscar');
  assert.strictEqual(b.query, 'Ana');
  ba.registrarResultado(root, b.task_id, { status: 'AMBIGUOUS', query: 'Ana', candidatos: [{ id: 'c-1', display: 'Ana Pérez' }, { id: 'c-2', display: 'Ana Gómez' }] });
  const r2 = ws.reintentar(root, { activation_id: a.activation_id, adapter: ws.adapterActual(root) });
  assert.strictEqual(r2.status, 'ELEGIR_CONTACTO');
  assert.strictEqual(r2.candidatos.length, 2);
  assert.ok(!ba.tareasPendientes(root).some((t) => t.tipo === 'enviar'), 'nada se envía antes de elegir');
});

test('C03: desactivar cancela las tareas sin resultado', () => {
  const root = proyecto();
  capacidadSana(root);
  activar(root, '+584121234567');
  assert.strictEqual(ba.tareasPendientes(root).length, 1);
  ws.desactivar(root, { adapter: ws.adapterActual(root) });
  assert.strictEqual(ba.tareasPendientes(root).length, 0);
});
