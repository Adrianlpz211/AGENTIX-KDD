'use strict';
/* Puente con el teléfono (ntfy), contra un servidor ntfy FALSO local: avisos de salida (tarea aceptada, decisión del dueño, problema sostenido),
   entrada desde el teléfono (responder «D-001 …», dejar un mensaje en el buzón del Director, «estado») y las salvaguardas (PIN, tope diario,
   el tema nunca a git, apagado si no hay red). Nada sale a internet. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const REPO = path.join(__dirname, '..');

function proyecto() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-ntfy-'));
  fs.mkdirSync(path.join(root, '.agentic'), { recursive: true });
  fs.cpSync(path.join(REPO, '.agentic', 'grafo'), path.join(root, '.agentic', 'grafo'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'));
  const stub = path.join(root, 'stub-post-cycle.cjs'); fs.writeFileSync(stub, 'process.exit(0);');
  process.env.AKDD_TEAMS_POSTCYCLE = stub;
  return root;
}
const puente = (root) => require(path.join(root, '.agentic', 'grafo', 'ntfy-bridge.cjs'));
const equipo = (root) => require(path.join(root, '.agentic', 'grafo', 'teams.cjs'));
const teams = (root, ...a) => equipo(root).ejecutar(a, root).out;

function ntfyFalso() {
  const msgs = []; let n = 0;
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      if (req.method === 'POST' && u.pathname === '/') { const j = JSON.parse(body); const m = { id: 'm' + (++n), time: Math.floor(Date.now() / 1000), event: 'message', topic: j.topic, title: j.title, message: j.message, tags: j.tags || [], priority: j.priority }; msgs.push(m); res.end(JSON.stringify(m)); return; }
      if (req.method === 'GET' && /\/json$/.test(u.pathname)) {
        const since = u.searchParams.get('since'); const i = since && since !== 'latest' && since !== 'all' ? msgs.findIndex((m) => m.id === since) + 1 : (since === 'latest' ? Math.max(0, msgs.length - 1) : 0);
        res.end(msgs.slice(i).map((m) => JSON.stringify(m)).join('\n') + '\n'); return;
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({
    msgs, url: 'http://127.0.0.1:' + srv.address().port,
    telefono: (texto) => { msgs.push({ id: 'm' + (++n), time: Math.floor(Date.now() / 1000) + 1, event: 'message', topic: 'x', message: texto, tags: [] }); },
    titulos: () => msgs.map((m) => m.title),
    cerrar: () => srv.close(),
  })));
}
const activar = async (root, f, extra = []) => puente(root).main(['activar', '--servidor=' + f.url, '--tema=tema-secreto-de-prueba', ...extra], root);
function arrancado(root) { teams(root, 'activar'); teams(root, 'modo', 'completo'); teams(root, 'iniciar'); }

test('NTFY-1 — activar manda el aviso de prueba, deja el tema fuera de git y NO queda activo si no hay red', async () => {
  const f = await ntfyFalso(); const root = proyecto();
  try {
    assert.equal(await activar(root, f), 0);
    assert.equal(puente(root).leerConfig(root).activo, true);
    assert.deepStrictEqual(f.titulos(), ['Agentix conectado']);
    assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /^\.agentic\/_ntfy\/$/m, 'el tema es un secreto: no se sube a git');
    assert.equal(await puente(root).main(['estado'], root), 0);
  } finally { f.cerrar(); }
  const sinRed = proyecto();
  assert.equal(await puente(sinRed).main(['activar', '--servidor=http://127.0.0.1:1', '--tema=x'], sinRed), 1);
  assert.equal(puente(sinRed).leerConfig(sinRed).activo, false, 'honestidad: sin aviso de prueba entregado no se declara activo');
});

test('NTFY-2 — avisa la tarea aceptada (avance, tiempo, lo que falta) y la decisión del dueño con cómo responder; no repite ni avisa lo que ya existía', async () => {
  const f = await ntfyFalso(); const root = proyecto();
  try {
    arrancado(root);
    teams(root, 'tarea', 'Login con correo', '--criterio=a', '--sin-contexto'); teams(root, 'tarea', 'Perfil', '--criterio=a', '--sin-contexto');
    teams(root, 'reportar', 'T-001', '--estado=HECHO', '--detalle=listo', '--verif=npm test');
    await activar(root, f); const nb = puente(root);
    await nb.tick(root); assert.deepStrictEqual(f.titulos(), ['Agentix conectado'], 'la primera vuelta solo toma la foto: no avisa de lo que ya había');
    teams(root, 'aceptar', 'T-001', '--verifico=npm test', '--tests=1');
    const r = await nb.tick(root); assert.equal(r.enviados, 1);
    const m = f.msgs.at(-1); assert.equal(m.title, '✅ T-001 aceptada');
    assert.match(m.message, /T-001 — Login con correo/); assert.match(m.message, /Avance: 1\/2 tareas aceptadas \(50 %\)/); assert.match(m.message, /Falta: 1 tarea\(s\)/);
    assert.ok(m.tags.includes('agentix') && m.tags.includes('white_check_mark'));
    assert.equal((await nb.tick(root)).enviados, 0, 'sin cambios no repite');
    teams(root, 'decision', '¿Qué proveedor de correo uso?', '--tipo=dueno', '--opciones=Resend|SES', '--recomendacion=Resend');
    await nb.tick(root);
    const q = f.msgs.at(-1); assert.equal(q.title, '❓ Necesito tu decisión: D-001');
    assert.match(q.message, /Opciones: Resend\|SES/); assert.match(q.message, /Recomiendo: Resend/); assert.match(q.message, /Responde aquí mismo: D-001 <tu decisión>/);
    assert.equal((await nb.tick(root)).enviados, 0);
  } finally { f.cerrar(); }
});

test('NTFY-3 — lo que escribes desde el teléfono: «D-001 …» resuelve la decisión, un mensaje libre va al buzón del Director (que se despierta con él) y «estado» responde', async () => {
  const f = await ntfyFalso(); const root = proyecto();
  try {
    arrancado(root); teams(root, 'tarea', 'Algo', '--criterio=a', '--sin-contexto');
    teams(root, 'decision', '¿Usar Resend?', '--tipo=dueno', '--opciones=Resend|SES');
    await activar(root, f); const nb = puente(root);
    f.telefono('D-001 Resend, ya lo usamos');
    await nb.entrada(root);
    assert.equal(equipo(root).salud(root).cola.decisiones_dueno.length, 0, 'la decisión quedó resuelta desde el teléfono');
    assert.match(fs.readFileSync(path.join(root, '.legion', 'AUDITORIA-CURSOR.md'), 'utf8'), /Decisión del dueño[^\n]*Resend, ya lo usamos/);
    assert.equal(f.msgs.at(-1).title, '✔ D-001 resuelta');
    f.telefono('Prioriza el login antes que el perfil');
    await nb.entrada(root);
    assert.equal(nb.sinLeer(root).length, 1); assert.equal(nb.sinLeer(root)[0].texto, 'Prioriza el login antes que el perfil');
    assert.equal(f.msgs.at(-1).title, '📥 Recibido');
    const T = equipo(root); const razones = T.accionable(T.calcular(root), 'director').razones;
    assert.ok(razones.some((x) => /MENSAJE DEL DUEÑO desde el teléfono[^\n]*Prioriza el login/.test(x)), 'el Director lo recibe como aviso');
    assert.notEqual(T.accionable(T.calcular(root), 'director').digest, '');
    assert.equal(T.salud(root).ntfy.buzon_sin_leer, 1);
    f.telefono('estado'); await nb.entrada(root);
    assert.equal(f.msgs.at(-1).title, '📊 Estado'); assert.match(f.msgs.at(-1).message, /Avance: 0\/1/);
    const total = f.msgs.length; await nb.entrada(root); assert.equal(f.msgs.length, total, 'no vuelve a leer lo ya procesado ni sus propias respuestas');
    assert.equal(nb.sinLeer(root).length, 1);
    await nb.main(['buzon', '--leido=todos'], root); assert.equal(nb.sinLeer(root).length, 0);
    assert.ok(!T.accionable(T.calcular(root), 'director').razones.some((x) => /MENSAJE DEL DUEÑO/.test(x)));
  } finally { f.cerrar(); }
});

test('NTFY-4 — con PIN, lo que no empieza con él se ignora; el tope diario corta los envíos', async () => {
  const f = await ntfyFalso(); const root = proyecto();
  try {
    await activar(root, f, ['--pin=7391']); const nb = puente(root);
    f.telefono('hola sin pin'); await nb.entrada(root);
    assert.equal(nb.sinLeer(root).length, 0); assert.match(f.msgs.at(-1).message, /falta el PIN/);
    f.telefono('7391 hola con pin'); await nb.entrada(root);
    assert.equal(nb.sinLeer(root)[0].texto, 'hola con pin', 'el PIN se quita del texto');
    const cfg = nb.leerConfig(root); cfg.max_dia = 1; fs.writeFileSync(path.join(root, '.agentic', '_ntfy', 'config.json'), JSON.stringify(cfg));
    const r = await nb.publicar(root, nb.leerConfig(root), { titulo: 't', texto: 'x' }); assert.equal(r.ok, false); assert.equal(r.causa, 'TOPE_DIARIO');
  } finally { f.cerrar(); }
});

test('NTFY-5 — un problema solo se avisa si se sostiene 5 min, una sola vez, y no antes', async () => {
  const f = await ntfyFalso(); const root = proyecto();
  try {
    arrancado(root); teams(root, 'tarea', 'Algo', '--criterio=a', '--sin-contexto');   // trabajo en cola y sin vigilantes → semáforo ROJO
    await activar(root, f); const nb = puente(root); const t0 = Date.now();
    await nb.tick(root, { ahora: t0 });                         // foto
    await nb.tick(root, { ahora: t0 + 60 * 1000 });
    assert.ok(!f.titulos().includes('⚠️ Algo no marcha'), 'un minuto de problema no avisa');
    await nb.tick(root, { ahora: t0 + 6 * 60 * 1000 });
    const avisos = () => f.titulos().filter((t) => t === '⚠️ Algo no marcha').length;
    assert.equal(avisos(), 1); assert.match(f.msgs.filter((m) => m.title === '⚠️ Algo no marcha')[0].message, /vigilante NO está vivo/);
    await nb.tick(root, { ahora: t0 + 12 * 60 * 1000 }); assert.equal(avisos(), 1, 'no repite en menos de una hora');
  } finally { f.cerrar(); }
});
