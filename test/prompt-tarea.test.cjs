'use strict';
/* El prefijo `aa:` deja de ser obligatorio: el hook decide si un mensaje es una tarea. Estas pruebas fijan QUÉ cuenta como tarea y qué NUNCA
   (preguntas, acuses de recibo, comandos), que el hook solo actúa en proyectos CONFIGURADOS, que anota cada mensaje (sin guardar su texto)
   y que el informe de cobertura distingue lo exacto (commits) de lo aproximado (mensajes). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const G = path.join(__dirname, '..', '.agentic', 'grafo');
const { clasificarPrompt, proyectoConfigurado } = require(path.join(G, 'prompt-tarea.cjs'));
const guard = require(path.join(G, 'host-guard.cjs'));
const cob = require(path.join(G, 'cobertura.cjs'));

const TAREAS = [
  'arregla el bug del login', 'agrega paginación a la tabla de clientes', 'implementa el módulo de pagos',
  'por favor revisa por qué falla el checkout', 'quiero que el reporte salga en PDF', 'necesito que cambies el color del header',
  'el botón de guardar no funciona en el modal', 'la página de citas da error al guardar', 'ok gracias, ahora hazlo también en pagos',
  'sigue investigando y repara los huecos', '¿puedes arreglar el login?', 'aa: lo que sea', 'fix: el redondeo', 'refactoriza auth.ts',
];
const NO_TAREAS = [
  '¿cómo funciona el hook?', 'qué es un contrato?', 'explícame cómo funciona el hook', 'dame los tiempos de compras', '¿por qué falla el checkout?',
  'sí', 'sí, adelante', 'ok perfecto, gracias', 'continúa', 'gracias por arreglarlo', 'listo, ya lo vi', '/clear', 'teams: estado', 'audit: auditar', '',
];

test('clasificador: tareas reales sí; preguntas, acuses y comandos nunca', () => {
  for (const t of TAREAS) { const r = clasificarPrompt(t); assert.equal(r.esTarea, true, `«${t}» debía ser tarea (p=${r.p}: ${r.razones.join('; ')})`); }
  for (const t of NO_TAREAS) { const r = clasificarPrompt(t); assert.equal(r.esTarea, false, `«${t}» NO debía ser tarea (p=${r.p}: ${r.razones.join('; ')})`); }
  assert.equal(clasificarPrompt('aa: x').explicito, true);
  assert.equal(clasificarPrompt('arregla algo').explicito, false);
});

function proyecto(configurado) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-pt-'));
  fs.mkdirSync(path.join(root, '.agentic'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agentic', 'config.md'), '# Config\nCONFIGURADO: ' + (configurado ? 'SI' : 'NO') + '\n');
  return root;
}
const contexto = (out) => (out && out.hookSpecificOutput && out.hookSpecificOutput.additionalContext) || '';

test('proyectoConfigurado lee CONFIGURADO: SI/SÍ y nada más', () => {
  assert.equal(proyectoConfigurado(proyecto(true)), true);
  assert.equal(proyectoConfigurado(proyecto(false)), false);
  assert.equal(proyectoConfigurado(fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-pt-sin-'))), false);
});

test('hook: SIN aa: pero configurado, una tarea se trata como aa: (nota al modelo); una conversación no', () => {
  const root = proyecto(true);
  const tarea = guard.procesar('claude', 'prompt', { prompt: 'arregla el bug del login' }, root);
  assert.match(contexto(tarea), /\[agentix\] Esto parece una tarea de desarrollo/, 'el modelo recibe la nota de que es una tarea');
  assert.match(contexto(tarea), /trátala como `aa:`/);
  const charla = guard.procesar('claude', 'prompt', { prompt: '¿cómo funciona el hook?' }, root);
  assert.ok(!/Esto parece una tarea/.test(contexto(charla)), 'una pregunta no dispara nada');
  const ack = guard.procesar('claude', 'prompt', { prompt: 'sí, adelante' }, root);
  assert.ok(!/Esto parece una tarea/.test(contexto(ack)));
});

test('hook: en un proyecto SIN configurar, solo el aa: explícito enriquece (el prefijo sigue siendo obligatorio)', () => {
  const root = proyecto(false);
  const out = guard.procesar('claude', 'prompt', { prompt: 'arregla el bug del login' }, root);
  assert.ok(!/Esto parece una tarea/.test(contexto(out)));
});

test('hook: Cursor no recibe nota (no puede inyectar contexto) pero el mensaje también se mide', () => {
  const root = proyecto(true);
  const out = guard.procesar('cursor', 'prompt', { prompt: 'arregla el bug del login' }, root);
  assert.deepEqual(out, { continue: true });
  const ls = fs.readFileSync(cob.ARCHIVO(root), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(ls.length, 1); assert.equal(ls[0].host, 'cursor'); assert.equal(ls[0].tarea, true); assert.equal(ls[0].enriquecido, false);
});

test('cada mensaje se anota SIN su texto (solo clasificación, huella y largo)', () => {
  const root = proyecto(true);
  guard.procesar('claude', 'prompt', { prompt: 'arregla el bug del login con la clave SECRETA-123' }, root);
  const crudo = fs.readFileSync(cob.ARCHIVO(root), 'utf8');
  assert.ok(!/SECRETA|login/.test(crudo), 'el texto del mensaje no se guarda: ' + crudo);
  const l = JSON.parse(crudo.trim());
  assert.equal(l.tarea, true); assert.equal(l.explicito, false); assert.ok(/^[0-9a-f]{8}$/.test(l.h)); assert.ok(l.n > 10);
});

test('fin de turno: anota lo editado SIN commit y el brief lo avisa; el commit lo liquida', () => {
  const root = proyecto(true);
  const g = (...a) => spawnSync('git', ['-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd: root, encoding: 'utf8' });
  g('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(root, '.gitignore'), '.agentic/\n');
  fs.mkdirSync(path.join(root, 'app'), { recursive: true }); fs.writeFileSync(path.join(root, 'app', 'a.ts'), '1'); g('add', '-A'); g('commit', '-q', '-m', 'base');

  assert.equal(guard.procesar('claude', 'stop', { stop_hook_active: false }, root), null, 'el Stop no imprime nada al host');
  assert.equal(cob.avisoSinCommit(root), null, 'limpio: nada que avisar');

  fs.writeFileSync(path.join(root, 'app', 'a.ts'), '2'); fs.writeFileSync(path.join(root, 'app', 'b.ts'), 'nuevo');
  guard.procesar('claude', 'stop', {}, root);
  const d = JSON.parse(fs.readFileSync(cob.SIN_COMMIT(root), 'utf8'));
  assert.deepEqual(d.archivos.sort(), ['app/a.ts', 'app/b.ts']);
  assert.match(cob.avisoSinCommit(root), /2 archivo\(s\) editados SIN COMMIT/);
  assert.match(contexto(guard.procesar('claude', 'prompt', { prompt: 'sí' }, root)), /SIN COMMIT/, 'el aviso llega al modelo en el siguiente mensaje');

  g('add', '-A'); g('commit', '-q', '-m', 'trabajo');
  guard.procesar('claude', 'stop', {}, root);
  assert.ok(!fs.existsSync(cob.SIN_COMMIT(root)), 'tras el commit ya no queda trabajo sin registrar');
});

test('informe: commits exactos (con y sin ciclo), calidad por origen y mensajes aproximados', (t) => {
  const { disponible, motivoSinDriver } = require('./helpers/sqlite.cjs');
  if (!disponible()) return t.skip('HOST_REAL_NO_EJECUTADO: ' + motivoSinDriver());
  const { proyecto: pm } = require('./helpers/memoria-proyecto.cjs');
  const p = pm('cobertura'); const root = p.root;
  const g = (...a) => { const r = spawnSync('git', ['-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd: root, encoding: 'utf8' }); return r.stdout.trim(); };
  g('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(root, '.gitignore'), '.agentic/\n');
  const shas = [];
  for (let i = 0; i < 4; i++) { fs.writeFileSync(path.join(root, 'f' + i + '.ts'), String(i)); g('add', '-A'); g('commit', '-q', '-m', 'c' + i); shas.push(g('rev-parse', 'HEAD')); }
  const db = p.abrirW();
  try {
    for (const sha of shas.slice(0, 3)) db.run("INSERT INTO ciclos (ciclo_id, tarea, estado, post_cycle_ran, duracion_ms, tests_pasando, ast_indexed, fecha_inicio) VALUES (?, ?, 'COMPLETADO', 'true', 5000, 10, 1, datetime('now'))", 'commit-' + sha, 'auto post-commit ' + sha.slice(0, 7));
  } finally { db.close(); }
  guard.procesar('claude', 'prompt', { prompt: 'aa: algo' }, root); guard.procesar('claude', 'prompt', { prompt: 'arregla x en y.ts' }, root); guard.procesar('claude', 'prompt', { prompt: '¿qué tal?' }, root);

  const r = cob.informe(root, { dias: 1 });
  assert.equal(r.commits.en_git, 4); assert.equal(r.commits.con_ciclo, 3); assert.equal(r.commits.pct, 75);
  assert.deepEqual(r.commits.sin_ciclo, [shas[3].slice(0, 7)], 'dice CUÁL commit quedó sin ciclo');
  assert.equal(r.calidad.commit.ciclos, 3); assert.equal(r.calidad.commit['AST indexado'], 100); assert.equal(r.calidad.commit['módulos'], 0, 'un campo vacío se ve vacío, no se maquilla');
  assert.equal(r.mensajes.total, 3); assert.equal(r.mensajes.parecian_tarea, 2); assert.equal(r.mensajes.con_aa_explicito, 1);
  const txt = cob.texto(r);
  assert.match(txt, /3 de 4 commits tienen ciclo en la base → 75 %/);
  assert.match(txt, /Lo que este informe NO dice/);
});

test('un aviso automático del host (task-notification) nunca es una tarea', () => {
  const { clasificarPrompt } = require('../.agentic/grafo/prompt-tarea.cjs');
  const r = clasificarPrompt('<task-notification><summary>Background command "node scripts/run-tests.cjs" failed</summary></task-notification>');
  assert.strictEqual(r.esTarea, false);
});
