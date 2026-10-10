'use strict';
/* 10/10/2026 (protocolo_reserva): a un chat de CURSOR (el constructor) le llegó solo, encolado, «[TEAMS] No termines todavía: eres el DIRECTOR…».
   Cursor también carga los ganchos de Claude Code del proyecto y los corre con --host=claude, que hablan como el Director.
   Los eventos que hablan por un rol (parar y mensaje del usuario) ya no se atienden cuando la llamada trae la huella de Cursor;
   los de seguridad (comandos, ediciones) siguen corriendo igual. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const G = path.join(__dirname, '..', '.agentic', 'grafo');
const T = require(path.join(G, 'teams.cjs'));
const canal = require(path.join(G, 'teams-canal.cjs'));
const H = require(path.join(G, 'host-guard.cjs'));

function proyecto() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-cursordis-'));
  fs.mkdirSync(path.join(root, '.agentic'), { recursive: true });
  const run = (...a) => T.ejecutar(a, root);
  run('activar'); run('modo', 'completo'); run('iniciar');
  run('tarea', 'Trabajo', '--criterio=hecho', '--sin-contexto');
  const est = T.leerEstado(root); est.rondas = { builder: Date.now() - 60000, director: Date.now() - 60000 };
  fs.writeFileSync(path.join(canal.dirEstado(root), 'estado.json'), JSON.stringify(est));
  return root;
}

const ENTRADA_CLAUDE = { session_id: 's-1', transcript_path: 'C:/Users/x/.claude/projects/p/s-1.jsonl', hook_event_name: 'Stop', stop_hook_active: false };
const ENTRADA_CURSOR = { conversation_id: 'c-1', generation_id: 'g-1', workspace_roots: ['/p'], hook_event_name: 'stop', loop_count: 0 };

test('CD-1 Cursor con su propio gancho: el constructor recibe SU mensaje', () => {
  const root = proyecto();
  const r = H.procesar('cursor', 'stop', ENTRADA_CURSOR, root);
  assert.ok(r && r.followup_message, 'Cursor sigue recibiendo su aviso de constructor');
  assert.match(r.followup_message, /CONSTRUCTOR/);
  assert.doesNotMatch(r.followup_message, /DIRECTOR/);
});

test('CD-2 Claude Code real: el Director sigue recibiendo el suyo', () => {
  const root = proyecto();
  const r = H.procesar('claude', 'stop', ENTRADA_CLAUDE, root);
  assert.ok(r && r.decision === 'block', 'Claude Code real no cambia');
  assert.match(r.reason, /DIRECTOR/);
});

test('CD-3 el gancho de Claude Code corrido DESDE Cursor se ignora: ni parada ni mensaje de usuario con voz de Director', () => {
  const root = proyecto();
  assert.equal(H.procesar('claude', 'stop', ENTRADA_CURSOR, root), null, 'huella de Cursor en los campos');
  assert.equal(H.procesar('claude', 'stop', Object.assign({}, ENTRADA_CLAUDE, { transcript_path: 'C:\\Users\\x\\.cursor\\projects\\p\\agent-transcripts\\c.jsonl' }), root), null, 'transcripción dentro de .cursor');
  assert.equal(H.procesar('claude', 'prompt', Object.assign({ prompt: 'implementa algo en src/a.js' }, ENTRADA_CURSOR), root), null, 'tampoco inyecta contexto del Director en el prompt');
});

test('CD-4 queda rastro de quién llamó (solo nombres de campos, nunca contenido)', () => {
  const root = proyecto();
  H.procesar('claude', 'stop', Object.assign({ prompt: 'SECRETO-NO-DEBE-QUEDAR' }, ENTRADA_CURSOR), root);
  H.procesar('claude', 'stop', ENTRADA_CLAUDE, root);
  const lineas = fs.readFileSync(path.join(root, '.agentic', '_hooks-roles.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lineas.length, 2);
  assert.equal(lineas[0].ignorada, true); assert.equal(lineas[1].ignorada, false);
  assert.ok(lineas[0].claves.includes('conversation_id'));
  assert.doesNotMatch(JSON.stringify(lineas), /SECRETO-NO-DEBE-QUEDAR/);
});

test('CD-5 la seguridad no se toca: un comando peligroso sigue denegándose aunque llegue por el gancho de Claude desde Cursor', () => {
  const root = proyecto();
  const r = H.procesar('claude', 'shell', Object.assign({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }, ENTRADA_CURSOR), root);
  assert.ok(r && r.hookSpecificOutput, 'la guardia respondió');
  assert.notEqual(r.hookSpecificOutput.permissionDecision, 'allow', 'no se permitió: ' + JSON.stringify(r).slice(0, 200));
});

test('CD-6 esCursorDisfrazado no confunde a Claude Code real', () => {
  assert.equal(H.esCursorDisfrazado(ENTRADA_CLAUDE), false);
  assert.equal(H.esCursorDisfrazado({}), false);
  assert.equal(H.esCursorDisfrazado(null), false);
  assert.equal(H.esCursorDisfrazado(ENTRADA_CURSOR), true);
  assert.equal(H.esCursorDisfrazado({ cursor_version: '1.7' }), true);
});
