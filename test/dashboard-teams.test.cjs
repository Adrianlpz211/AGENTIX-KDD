'use strict';
/* Pestaña TEAMS del tablero: el semáforo, los vigilantes (¿vivos?), la cola y el registro se ven ahí. Solo lectura.
   Honestidad: sin TEAMS instalado o sin canal, lo dice; nunca un verde inventado. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { crearFixture, arrancarDashboard, REPO } = require('./fixtures/dashboard-fixture.cjs');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-dashteams-' + p + '-'));
const teams = (dir, ...args) => spawnSync(process.execPath, [path.join(dir, '.agentic', 'grafo', 'teams.cjs'), ...args], { cwd: dir, encoding: 'utf8', timeout: 60000 });
async function json(url) { const r = await fetch(url); return { status: r.status, csp: r.headers.get('content-security-policy'), texto: await r.text() }; }
function conTeams(dir) { fs.cpSync(path.join(REPO, '.agentic', 'grafo'), path.join(dir, '.agentic', 'grafo'), { recursive: true }); }

test('el tablero trae la pestaña TEAMS (dentro del layout) y su página se sirve embebible solo por el mismo origen', async () => {
  const dir = tmp('pag'); crearFixture(dir); conTeams(dir);
  const d = await arrancarDashboard(dir);
  try {
    const base = d.url.replace(/\/$/, '');
    const raiz = await json(base + '/');
    assert.match(raiz.texto, /setMode\('teams',this\)/);
    assert.match(raiz.texto, /id="mode-teams"[^>]*><iframe data-src="\/teams\?embed=1"/);
    const pag = await json(base + '/teams');
    assert.equal(pag.status, 200);
    assert.match(pag.texto, /TEAMS — Director \+ Constructor/);
    assert.match(pag.csp, /frame-ancestors 'self'/);
    assert.doesNotMatch(pag.texto, /innerHTML/, 'ningún dato del servidor se interpreta como HTML');
    const emb = await json(base + '/teams?embed=1');
    assert.match(emb.texto, /header,nav\{display:none!important\}/);
  } finally { d.cerrar(); }
});

test('/api/v1/teams: el semáforo y los roles salen del canal real; sin canal y sin TEAMS dice la verdad', async () => {
  const dir = tmp('api'); crearFixture(dir); conTeams(dir);
  const d = await arrancarDashboard(dir);
  try {
    const base = d.url.replace(/\/$/, '');
    const vacio = (await (await fetch(base + '/api/v1/teams')).json());
    assert.equal(vacio.status, 'EMPTY'); assert.equal(vacio.reason_code, 'SIN_CANAL');
    for (const a of [['activar'], ['modo', 'completo'], ['iniciar'], ['tarea', 'Algo', '--criterio=a', '--sin-contexto']]) assert.equal(teams(dir, ...a).status, 0);
    const j = await (await fetch(base + '/api/v1/teams')).json();
    assert.equal(j.status, 'OK');
    assert.equal(j.data.canal, 'ACTIVO');
    assert.equal(j.data.modo, 'completo');
    assert.equal(j.data.semaforo, 'ROJO', 'con trabajo en cola y sin vigilantes el tablero NO muestra verde');
    assert.ok(j.data.alertas.some((a) => /vigilante NO está vivo/.test(a.msg)));
    assert.equal(j.data.roles.builder.nombre, 'Constructor (Cursor)');
    assert.equal(j.data.cola.tareas[0].id, 'T-001');
    assert.equal(typeof j.data.registro.registradas, 'number');
    // pausar cambia lo que se ve
    assert.equal(teams(dir, 'pausa').status, 0);
    assert.equal((await (await fetch(base + '/api/v1/teams')).json()).data.semaforo, 'PAUSADO');
  } finally { d.cerrar(); }
  const sin = tmp('sin'); crearFixture(sin);
  const d2 = await arrancarDashboard(sin);
  try {
    const j = await (await fetch(d2.url.replace(/\/$/, '') + '/api/v1/teams')).json();
    assert.equal(j.status, 'UNAVAILABLE'); assert.equal(j.reason_code, 'TEAMS_NO_INSTALADO');
  } finally { d2.cerrar(); }
});

/* La oficina 3D: adorno que nunca rompe los datos. Servida local (sin CDN), sin interpretar nada como HTML,
   y en un navegador real los personajes trabajan sentados o, tras 3 min sin trabajo, se juntan a conversar. */
function hayNavegador() {
  try { require.resolve('playwright-core', { paths: [REPO] }); return true; } catch { return false; }
}

test('la oficina 3D va dentro de /teams con three.js local, sin innerHTML ni recursos externos', async () => {
  const dir = tmp('3d'); crearFixture(dir); conTeams(dir);
  const d = await arrancarDashboard(dir);
  try {
    const base = d.url.replace(/\/$/, '');
    const pag = await json(base + '/teams');
    assert.match(pag.texto, /id="escena"/);
    assert.match(pag.texto, /<script src="\/vendor\/three\.min\.js"><\/script>/);
    assert.match(pag.texto, /window\.mundoActualizar/);
    assert.doesNotMatch(pag.texto, /\/\*__MUNDO__\*\//, 'la escena quedó inyectada');
    assert.doesNotMatch(pag.texto, /https?:\/\/(?!127\.0\.0\.1|localhost)[^"'\s)]*\.(js|css)/, 'sin scripts ni estilos externos');
    assert.doesNotMatch(pag.texto, /innerHTML|document\.write|eval\(/);
    const three = await fetch(base + '/vendor/three.min.js');
    assert.equal(three.status, 200);
  } finally { d.cerrar(); }
});

test('la oficina 3D en navegador real: sin TEAMS juegan; los comandos los mueven; vigilantes con galleta; 3 min sin trabajo → a descansar; sin errores', { timeout: 150000, skip: hayNavegador() ? false : 'sin playwright-core' }, async () => {
  const dir = tmp('3dnav'); crearFixture(dir); conTeams(dir);
  const d = await arrancarDashboard(dir);
  const bg = require(path.join(REPO, '.agentic', 'grafo', 'browser-gate.cjs'));
  const browser = await bg.launchBrowser('system');
  const errores = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
    page.on('pageerror', (e) => errores.push(String(e.message || e).slice(0, 200)));
    page.on('console', (m) => { if (/Content Security Policy|Refused to (load|execute|apply|connect)/i.test(m.text())) errores.push('CSP: ' + m.text().slice(0, 200)); });
    await page.goto(d.url.replace(/\/$/, '') + '/teams', { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => typeof window.mundoSimular === 'function' && !!document.querySelector('#escena canvas'), null, { timeout: 30000 });
    const sitios = (r) => Object.fromEntries(r.filter((x) => !String(x.k).startsWith('perro')).map((x) => [x.k, x.sitio || ('→' + x.destino)]));
    const zona = (v) => /^(sofa|bean)/.test(v) ? 'sala' : /^esc_/.test(v) ? 'puesto' : v;
    const paso = (nombre, seg, opc) => page.evaluate(([n, sg, o]) => { window.mundoSimular(n, o); return window.mundoPaso(sg); }, [nombre, seg, opc || {}]);
    // 1) sin TEAMS: los cinco en la sala de descanso jugando; los perros duermen
    let r = await paso('apagado', 1, { silencioso: true });
    assert.deepStrictEqual(Object.values(sitios(r)).map(zona), ['sala', 'sala', 'sala', 'sala', 'sala']);
    assert.ok(r.filter((x) => String(x.k).startsWith('perro')).every((x) => x.estado === 'dormido' && !x.vivo));
    // 2) teams: activar → solo el Director va a su puesto
    r = await paso('activar', 14); let z = sitios(r);
    assert.equal(z.director, 'esc_director'); assert.equal(zona(z.fe), 'sala'); assert.equal(zona(z.cons), 'sala');
    // 3) plan → llegan los tres sub-agentes; el constructor sigue descansando
    r = await paso('plan', 16); z = sitios(r);
    assert.deepStrictEqual([z.fe, z.be, z.neg], ['esc_fe', 'esc_be', 'esc_neg']); assert.equal(zona(z.cons), 'sala');
    // 4) teams: constructor → el Constructor deja de jugar y va a su máquina; los perros siguen dormidos (vigilantes apagados)
    r = await paso('constructor', 16); z = sitios(r); assert.equal(z.cons, 'esc_cons');
    assert.ok(r.filter((x) => String(x.k).startsWith('perro')).every((x) => x.estado === 'dormido'));
    // 5) vigilantes arrancan → cada dueño va a darle su galleta y los perros se ponen a vigilar
    r = await paso('vigilantes', 6); z = sitios(r);
    assert.ok(/galleta_director/.test(z.director) && /galleta_cons/.test(z.cons), JSON.stringify(z));
    assert.ok(r.filter((x) => String(x.k).startsWith('perro')).every((x) => x.vivo && x.estado !== 'dormido'));
    // 6) trabajo real: construyen y revisan; la auditoría pone a teclear a los tres sub-agentes
    r = await paso('trabajo', 30); assert.ok(r.find((x) => x.k === 'director').modo === 'type' && r.find((x) => x.k === 'cons').modo === 'type');
    r = await paso('auditoria', 4); assert.deepStrictEqual(['fe', 'be', 'neg'].map((k) => r.find((x) => x.k === k).modo), ['type', 'type', 'type']);
    // 7) sin vigilante los perros se van a dormir, aunque la gente siga en su puesto
    r = await paso('alarma', 14); assert.ok(r.filter((x) => String(x.k).startsWith('perro')).every((x) => x.estado === 'dormido' && !x.vivo));
    // 8) a los 3 min sin nada que hacer se levantan y se van a descansar (se juega en la sala)
    r = await paso('espera3', 40); assert.deepStrictEqual(Object.values(sitios(r)).map(zona), ['sala', 'sala', 'sala', 'sala', 'sala']);
    // vistas y atajos de cámara sin errores
    await page.evaluate(() => { window.mundoVista('libre'); window.mundoIr('pizarra'); window.mundoPaso(2); window.mundoVista('iso'); window.mundoPaso(0.2); });
    assert.deepStrictEqual(errores, []);
  } finally { await browser.close().catch(() => {}); d.cerrar(); }
});
