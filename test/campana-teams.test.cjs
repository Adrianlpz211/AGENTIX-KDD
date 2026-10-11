'use strict';
/* PRUEBA DE CAMPAÑA — varios días de trabajo con pausa y reanudación, sobre un proyecto real con git, de punta a punta:
   el Director encola, Cursor trabaja empujado por el gancho de parada, el trabajo sin commit queda como PROVISIONAL, el commit lo cierra, y el auditor
   de engranajes lo ve girar. Cubre los huecos que se descubrieron a mano en medinet y protocolo_reserva (octubre 2026). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const G = path.join(__dirname, '..', '.agentic', 'grafo');
const T = require(path.join(G, 'teams.cjs'));
const canal = require(path.join(G, 'teams-canal.cjs'));
const C = require(path.join(G, 'teams-continuidad.cjs'));
const P = require(path.join(G, 'ciclo-provisional.cjs'));
const E = require(path.join(G, 'engranajes.cjs'));
process.env.AKDD_TEAMS_NO_AVISO = '1';

const git = (root, ...a) => cp.spawnSync('git', a, { cwd: root, encoding: 'utf8', windowsHide: true });
function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-campana-'));
  git(root, 'init', '-q'); git(root, 'config', 'user.email', 'a@b.c'); git(root, 'config', 'user.name', 'x'); git(root, 'config', 'commit.gpgsign', 'false');
  fs.mkdirSync(path.join(root, '.agentic'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'exports.a = 1;\n');
  fs.writeFileSync(path.join(root, '.gitignore'), '.agentic/\n.legion/\n');
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'base', '--no-verify');
  return root;
}
const run = (root, ...a) => T.ejecutar(a, root);
function vigilantes(root) {
  const f = path.join(canal.dirEstado(root), 'vigilantes'); fs.mkdirSync(f, { recursive: true });
  for (const rol of ['director', 'builder']) fs.writeFileSync(path.join(f, rol + '.json'), JSON.stringify({ pid: process.pid, latido: new Date().toISOString(), sondeo_s: 10, desde: new Date().toISOString() }));
}

test('CAM-1 trabajo sin commit: queda PROVISIONAL, se refresca sin perder el arranque y el commit lo cierra con su tiempo real', () => {
  const root = repo();
  assert.equal(P.actualizar(root), null, 'árbol limpio: nada provisional');
  fs.writeFileSync(path.join(root, 'src', 'b.js'), 'exports.b = 2;\n');
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'exports.a = 9;\n');
  const p1 = P.actualizar(root);
  assert.equal(p1.estado, 'PROVISIONAL'); assert.equal(p1.total, 2); assert.ok(p1.modulos.includes('(raíz)') || p1.modulos.length);
  const p2 = P.actualizar(root);
  assert.equal(p2.desde, p1.desde, 'el arranque no se pierde al refrescar');
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'trabajo', '--no-verify');
  const cerrado = P.cerrar(root, 'HEAD');
  assert.equal(cerrado.archivos_absorbidos, 2);
  assert.equal(P.estado(root), null, 'ya no hay nada provisional');
  assert.equal(fs.readFileSync(P.HISTORIAL(root), 'utf8').trim().split('\n').length, 1);
});

test('CAM-2 un commit que NO toca lo provisional no lo cierra; uno parcial deja lo que falta', () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'src', 'x.js'), '1'); fs.writeFileSync(path.join(root, 'src', 'y.js'), '2');
  P.actualizar(root);
  git(root, 'add', 'src/x.js'); git(root, 'commit', '-q', '-m', 'solo x', '--no-verify');
  const r = P.cerrar(root, 'HEAD');
  assert.equal(r.archivos_absorbidos, 1);
  assert.deepEqual(P.estado(root).archivos, ['src/y.js']);
  git(root, 'commit', '-q', '--allow-empty', '-m', 'vacío', '--no-verify');
  assert.equal(P.cerrar(root, 'HEAD'), null, 'un commit sin esos archivos no cierra nada');
  assert.ok(P.estado(root));
});

test('CAM-3 campaña de varios días: encola, empuja, pausa 3 días, continúa, y Cursor retoma con la tarea completa sin que nadie escriba 4 mensajes', () => {
  const root = repo();
  run(root, 'activar'); run(root, 'modo', 'completo'); run(root, 'iniciar'); vigilantes(root);
  run(root, 'tarea', 'Pantalla de pagos', '--criterio=valida el monto', '--sin-contexto');
  run(root, 'tarea', 'Pantalla de citas', '--criterio=no duplica citas', '--sin-contexto');
  run(root, 'continuar', '--rol=builder');
  let r = C.decidir(root, 'cursor', { loop_count: 0 });
  assert.equal(r.continuar, true);
  assert.match(r.mensaje, /^aa: \[TEAMS\] Trabaja T-001/);
  // el trabajo avanza más allá del tope viejo de seguimientos (Cursor corta a 5 si no se pide null)
  r = C.decidir(root, 'cursor', { loop_count: 8 });
  assert.equal(r.continuar, true, 'sigue empujando: ya no corta en 2');
  // pausa de 3 días
  run(root, 'pausa');
  const est = T.leerEstado(root); est.pausado_at = Date.now() - 3 * 86400000; T.guardarEstado(root, est);
  const rp = C.decidir(root, 'cursor', { loop_count: 0 });
  assert.notEqual(rp.continuar, true, 'pausado: no empuja');
  const cont = run(root, 'continuar', '--rol=builder');
  assert.match(cont.out, /RETOMA|retoma|PEGA/i, 'continuar da el punto de retoma');
  vigilantes(root);
  const r2 = C.decidir(root, 'cursor', { loop_count: 0 });
  assert.equal(r2.continuar, true, 'tras 3 días de pausa el gancho vuelve a empujar de inmediato');
  assert.match(r2.mensaje, /^aa: \[TEAMS\] Trabaja T-00[12]/);
});

test('CAM-4 el auditor de engranajes corre sobre el proyecto de la campaña, no revienta y su --reparar no toca la configuración de git', () => {
  const root = repo();
  const r = E.auditar(root);
  assert.ok(r.total >= 10 && r.engranajes.every((g) => ['OK', 'ATENCION', 'ROTO', 'SIN_DATO'].includes(g.estado)));
  const antes = git(root, 'config', '--get', 'core.hooksPath').stdout;
  const rp = E.reparar(root);
  assert.ok(Array.isArray(rp));
  assert.equal(git(root, 'config', '--get', 'core.hooksPath').stdout, antes, 'core.hooksPath intacto');
});

test('CAM-5 reparar: si core.hooksPath apunta a la nada NO lo cambia (solo la persona), y lo dice', () => {
  const root = repo();
  git(root, 'config', 'core.hooksPath', 'no-existe-esta-carpeta');
  const rp = E.reparar(root).find((x) => x.id === 'ganchos-de-git');
  assert.ok(rp && rp.omitido, JSON.stringify(rp));
  assert.match(rp.msg, /unset core\.hooksPath/);
  assert.equal(git(root, 'config', '--get', 'core.hooksPath').stdout.trim(), 'no-existe-esta-carpeta');
});
