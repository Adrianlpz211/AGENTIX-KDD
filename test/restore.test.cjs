'use strict';

/**
 * Carpeta 05 — puntos de restauración reales y apply seguro.
 * Todo corre en un repositorio Git de prueba: se comparan bytes en disco,
 * HEAD, index y refs, no nombres ni metadatos.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RM_PATH = path.join(__dirname, '..', '.agentic', 'grafo', 'restore-manager.cjs');
const TM_PATH = path.join(__dirname, '..', '.agentic', 'grafo', 'teams-manager.cjs');
const rm = require(RM_PATH);

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-restore-'));
  const g = (...a) => {
    const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: root, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(a.join(' ') + ': ' + r.stderr);
    return r.stdout.trim();
  };
  g('init', '-q');
  g('config', 'core.autocrlf', 'true');
  fs.mkdirSync(path.join(root, '.agentic'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(root, 'src', 'b.js'), 'module.exports = 2;\n');
  fs.writeFileSync(path.join(root, 'src', 'c.js'), 'module.exports = "c";\n');
  fs.writeFileSync(path.join(root, 'run.sh'), '#!/bin/sh\necho hola\n');
  fs.writeFileSync(path.join(root, '.gitignore'), '.agentic/_restore/\n.agentic/_teams/\n.agentic/memoria.db*\n.legion/\n');
  fs.writeFileSync(path.join(root, '.agentic', 'config.md'), 'CONFIGURADO: SI\n');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fixture-restore"}');
  require(path.join(__dirname, '..', '.agentic', 'grafo', 'db-adapter.cjs')).openWrite(path.join(root, '.agentic', 'memoria.db')).close();
  g('add', '-A');
  g('update-index', '--chmod=+x', 'run.sh');
  g('commit', '-q', '-m', 'base');
  return { root, g, leer: (f) => fs.readFileSync(path.join(root, f)), escribir: (f, c) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), c); } };
}

function estadoUsuario(fx) {
  return { head: fx.g('rev-parse', 'HEAD'), rama: fx.g('symbolic-ref', 'HEAD'), index: fx.g('ls-files', '-s'), status: fx.g('status', '--porcelain') };
}

const tarea = (id, archivo) => ({ id, objective: 'tarea ' + id, acceptance: ['criterio ' + id], allowed_files: [archivo], risk: 'LOW', change_type: 'text' });
function teams(fx, tareas) {
  const tm = require(TM_PATH);
  assert.strictEqual(tm.init(fx.root, { aprobarMigracion: true, mismoHost: true }).status, 'ACTIVO');
  const p = tm.crearPlan(fx.root, { id: 'P1', objective: 'restore', sprints: [{ id: 'S1', tasks: tareas }] });
  assert.ok(!p.status || !/INVALIDO|DESACTIVADO/.test(p.status), JSON.stringify(p));
  return tm;
}

function restaurar(root, ref, extra) {
  const p = rm.preview(root, ref, extra);
  return { p, r: rm.aplicar(root, ref, Object.assign({ expected_current_hash: p.expected_current_hash }, extra)) };
}

// ─── 01: puntos reales ───────────────────────────────────────────────────────

test('sin Git no hay puntos: UNSUPPORTED, no metadatos fingidos', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-nogit-'));
  assert.strictEqual(rm.disponible(root), false);
  assert.strictEqual(rm.crear(root, { label: 'x' }).status, 'UNSUPPORTED');
  assert.strictEqual(rm.listar(root).status, 'UNSUPPORTED');
});

test('crear no toca HEAD, rama, index ni status del usuario; queda en refs privadas', () => {
  const fx = fixture();
  fx.escribir('src/a.js', 'module.exports = 10;\n');
  fx.g('add', 'src/b.js');
  const antes = estadoUsuario(fx);
  const c = rm.crear(fx.root, { label: 'antes de tocar' });
  assert.strictEqual(c.status, 'OK');
  assert.deepStrictEqual(estadoUsuario(fx), antes);
  assert.match(fx.g('for-each-ref', '--format=%(refname)', 'refs/agentix/'), new RegExp('refs/agentix/restore/' + c.punto.id));
  assert.strictEqual(fx.g('branch', '--list').split('\n').length, 1, 'no crea ramas');
});

test('tracked dirty y archivo nuevo permitido se recuperan byte a byte (CRLF incluido)', () => {
  const fx = fixture();
  const sucio = Buffer.from('linea uno\r\nlinea dos\r\n');
  fx.escribir('src/a.js', sucio);
  fx.escribir('src/nuevo.js', 'nuevo\n');
  const c = rm.crear(fx.root, { archivos: ['src/a.js', 'src/nuevo.js'], label: 'sucio' });
  assert.strictEqual(c.punto.state, 'VERIFIED');
  fx.escribir('src/a.js', 'roto\n');
  fs.unlinkSync(path.join(fx.root, 'src', 'nuevo.js'));
  const { r } = restaurar(fx.root, c.punto.id);
  assert.strictEqual(r.status, 'RESTAURADO');
  assert.ok(fx.leer('src/a.js').equals(sucio), 'los bytes exactos del working tree, sin normalizar CRLF');
  assert.strictEqual(fx.leer('src/nuevo.js').toString(), 'nuevo\n');
});

test('borrado, rename y modo quedan representados en el punto', () => {
  const fx = fixture();
  fs.renameSync(path.join(fx.root, 'src', 'c.js'), path.join(fx.root, 'src', 'd.js'));
  fs.unlinkSync(path.join(fx.root, 'src', 'b.js'));
  const c = rm.crear(fx.root, { archivos: ['src/b.js', 'src/c.js', 'src/d.js', 'run.sh'] });
  const m = rm.mostrar(fx.root, c.punto.id).manifiesto;
  assert.strictEqual(m.files['src/b.js'].exists, false);
  assert.strictEqual(m.files['src/c.js'].exists, false);
  assert.strictEqual(m.files['src/d.js'].exists, true);
  assert.ok(m.cambios_vs_head.some((x) => x.status.startsWith('R') && x.from === 'src/c.js' && x.path === 'src/d.js'), JSON.stringify(m.cambios_vs_head));
  assert.ok(m.cambios_vs_head.some((x) => x.status === 'D' && x.path === 'src/b.js'));
  assert.strictEqual(m.files['run.sh'].mode, '100755');
  assert.ok(!m.cambios_vs_head.some((x) => x.path === 'run.sh'), 'sin cambio de modo inventado');
  assert.strictEqual(fx.g('ls-tree', m.commit, 'run.sh').split(' ')[0], '100755');
});

test('secreto excluido: el punto es PARTIAL y el límite queda visible', () => {
  const fx = fixture();
  fx.escribir('.env', 'TOKEN=no-se-guarda\n');
  const c = rm.crear(fx.root, { archivos: ['src/a.js', '.env'] });
  assert.strictEqual(c.punto.state, 'PARTIAL');
  const m = rm.mostrar(fx.root, c.punto.id).manifiesto;
  assert.deepStrictEqual(m.excluded, [{ path: '.env', motivo: 'SECRETO' }]);
  assert.strictEqual(m.motivo_estado, 'ARCHIVOS_EXCLUIDOS');
  assert.ok(!fx.g('ls-tree', '-r', '--name-only', m.commit).split('\n').includes('.env'));
  const p = rm.preview(fx.root, c.punto.id);
  assert.deepStrictEqual(p.excluidos.map((e) => e.path), ['.env']);
});

test('lo no rastreado sin permiso no se captura y se reporta como no capturado', () => {
  const fx = fixture();
  fx.escribir('borrador.txt', 'privado\n');
  const c = rm.crear(fx.root, {});
  const m = rm.mostrar(fx.root, c.punto.id).manifiesto;
  assert.ok(!m.scope.includes('borrador.txt'));
  assert.ok(m.no_capturados.includes('borrador.txt'));
});

test('cambio concurrente durante la captura no produce un VERIFIED falso', () => {
  const fx = fixture();
  let n = 0;
  const c = rm.crear(fx.root, { archivos: ['src/a.js'], alCapturar: () => fx.escribir('src/a.js', 'cambio ' + (n++) + '\n') });
  assert.strictEqual(c.status, 'OK');
  assert.strictEqual(c.punto.state, 'UNVERIFIED');
  assert.strictEqual(c.punto.motivo_estado, 'CAMBIO_DURANTE_CAPTURA');
  assert.strictEqual(rm.preview(fx.root, c.punto.id).status, 'BLOQUEADO', 'un punto no verificado no se restaura');
});

test('IDs y zona horaria desambiguan: fecha sola u hora repetida piden elegir', () => {
  const fx = fixture();
  fs.writeFileSync(path.join(fx.root, '.agentic', 'restore-policy.json'), JSON.stringify({ zona_horaria: 'America/Caracas' }));
  const a = rm.crear(fx.root, { archivos: ['src/a.js'], label: 'uno' });
  fx.escribir('src/a.js', 'otro\n');
  const b = rm.crear(fx.root, { archivos: ['src/a.js'], label: 'dos' });
  assert.notStrictEqual(a.punto.id, b.punto.id);
  assert.strictEqual(a.punto.zona, 'America/Caracas');
  assert.strictEqual(a.punto.offset, '-04:00');
  assert.strictEqual(rm.resolverReferencia(fx.root, b.punto.id).manifiesto.point_id, b.punto.id);
  const fecha = a.punto.local.slice(0, 10);
  assert.strictEqual(rm.resolverReferencia(fx.root, fecha).status, 'SELECCION_REQUERIDA');
  if (a.punto.local.slice(0, 16) === b.punto.local.slice(0, 16)) {
    const r = rm.resolverReferencia(fx.root, a.punto.local.slice(0, 16));
    assert.strictEqual(r.status, 'SELECCION_REQUERIDA');
    assert.strictEqual(r.candidatos.length, 2);
  }
  assert.strictEqual(rm.resolverReferencia(fx.root, 'rp-x; rm -rf /').status, 'REFERENCIA_INVALIDA');
});

test('dedup y supervivencia: mismo estado no duplica; tras reiniciar sigue disponible', () => {
  const fx = fixture();
  const a = rm.crear(fx.root, { archivos: ['src/a.js'] });
  const b = rm.crear(fx.root, { archivos: ['src/a.js'] });
  assert.strictEqual(b.deduplicado, true);
  assert.strictEqual(b.punto.id, a.punto.id);
  delete require.cache[require.resolve(RM_PATH)];
  const rm2 = require(RM_PATH);
  const l = rm2.listar(fx.root);
  assert.deepStrictEqual(l.puntos.map((p) => p.id), [a.punto.id]);
  fs.rmSync(path.join(fx.root, '.agentic', '_restore'), { recursive: true, force: true });
  assert.strictEqual(rm2.listar(fx.root).puntos.length, 0, 'sin journal "disponible" un punto no se ofrece');
});

test('sin Git utilizable no crea nada y dice la causa', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-sin-git-'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
  const l = rm.listar(dir);
  assert.strictEqual(l.status, 'UNSUPPORTED');
  assert.match(l.detalle, /sin repositorio Git/);
  const c = rm.crear(dir, { tipo: 'MANUAL' });
  assert.strictEqual(c.status, 'UNSUPPORTED');
  assert.ok(!fs.existsSync(path.join(dir, '.agentic', '_restore')), 'no deja journal sin punto');
});

test('CLI, MCP y reglas usan el mismo servicio; "restore point" lista y no crea', () => {
  const fx = fixture();
  const cli = (...a) => JSON.parse(spawnSync(process.execPath, [RM_PATH, ...a], { cwd: fx.root, encoding: 'utf8' }).stdout);
  assert.deepStrictEqual(cli('list', '--json').puntos, []);
  const c = cli('create', '--label=antes del refactor', '--files=src/a.js');
  assert.strictEqual(c.punto.label, 'antes del refactor');
  assert.strictEqual(cli('list').puntos.length, 1);
  assert.strictEqual(cli('show', c.punto.id).manifiesto.point_id, c.punto.id);
  fx.escribir('src/a.js', 'cambio\n');
  const p = cli('preview', c.punto.id);
  assert.strictEqual(p.status, 'LISTO');
  assert.strictEqual(cli('apply', c.punto.id, '--expected-current-hash=' + p.expected_current_hash).status, 'RESTAURADO');
  const raiz = path.join(__dirname, '..');
  assert.match(fs.readFileSync(path.join(raiz, 'bin', 'akdd.js'), 'utf8'), /case 'restore'[\s\S]{0,300}restore-manager\.cjs/);
  assert.match(fs.readFileSync(path.join(raiz, '.agentic', 'grafo', 'mcp-server.cjs'), 'utf8'), /name: 'restore'[\s\S]*restore-manager\.cjs/);
  const reglas = fs.readFileSync(path.join(raiz, 'CLAUDE.md'), 'utf8');
  assert.match(reglas, /`aa: restore point` \| `list` — solo lista, nunca crea/);
});

// ─── 02: apply seguro ────────────────────────────────────────────────────────

test('hash cambiado tras el preview: apply rechaza y no escribe nada', () => {
  const fx = fixture();
  const c = rm.crear(fx.root, { archivos: ['src/a.js'] });
  fx.escribir('src/a.js', 'v2\n');
  const p = rm.preview(fx.root, c.punto.id);
  assert.strictEqual(p.status, 'LISTO');
  fx.escribir('src/a.js', 'v3 de otra persona\n');
  const r = rm.aplicar(fx.root, c.punto.id, { expected_current_hash: p.expected_current_hash });
  assert.strictEqual(r.status, 'HASH_CAMBIO_DESDE_PREVIEW');
  assert.strictEqual(fx.leer('src/a.js').toString(), 'v3 de otra persona\n');
  assert.strictEqual(rm.aplicar(fx.root, c.punto.id, {}).status, 'HASH_CAMBIO_DESDE_PREVIEW', 'sin hash no hay apply');
});

test('archivo nuevo propio se quita; el no rastreado ajeno permanece', () => {
  const fx = fixture();
  const c = rm.crear(fx.root, { archivos: ['src/a.js', 'src/propio.js'], task_id: 'T1', tipo: 'BASELINE' });
  fx.escribir('src/propio.js', 'creado por la tarea\n');
  fx.escribir('src/ajeno.js', 'de otra persona\n');
  const { p, r } = restaurar(fx.root, c.punto.id);
  assert.deepStrictEqual(p.ops.map((o) => [o.op, o.path]), [['DELETE', 'src/propio.js']]);
  assert.strictEqual(r.status, 'RESTAURADO');
  assert.ok(!fs.existsSync(path.join(fx.root, 'src', 'propio.js')));
  assert.strictEqual(fx.leer('src/ajeno.js').toString(), 'de otra persona\n');
});

test('protegido, junction y escape se rechazan', () => {
  const fx = fixture();
  const c = rm.crear(fx.root, { archivos: ['src/a.js'] });
  fx.escribir('src/a.js', 'cambiado\n');
  fs.writeFileSync(path.join(fx.root, '.agentic', 'protected_files'), 'src/a.js\n');
  const p = rm.preview(fx.root, c.punto.id);
  assert.strictEqual(p.status, 'BLOQUEADO');
  assert.ok(p.motivos.some((m) => m.startsWith('PROTEGIDO')));
  assert.strictEqual(rm.aplicar(fx.root, c.punto.id, { expected_current_hash: p.expected_current_hash }).status, 'BLOQUEADO');
  assert.strictEqual(fx.leer('src/a.js').toString(), 'cambiado\n');

  const fuera = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-fuera-'));
  fs.writeFileSync(path.join(fuera, 'x.js'), 'fuera\n');
  fs.symlinkSync(fuera, path.join(fx.root, 'lnk'), 'junction');
  assert.strictEqual(rm.rutaSegura(fx.root, 'lnk/x.js'), 'ENLACE_O_JUNCTION');
  assert.strictEqual(rm.rutaSegura(fx.root, '../fuera.js'), 'RUTA_INVALIDA');
  assert.strictEqual(rm.rutaSegura(fx.root, 'C:/Windows/x'), 'RUTA_INVALIDA');
  const j = rm.crear(fx.root, { archivos: ['lnk/x.js', '../fuera.js'] });
  assert.deepStrictEqual(rm.mostrar(fx.root, j.punto.id).manifiesto.excluded.map((e) => e.motivo).sort(), ['ENLACE_O_JUNCTION', 'RUTA_INVALIDA']);
  assert.strictEqual(fs.readFileSync(path.join(fuera, 'x.js'), 'utf8'), 'fuera\n');
});

test('código restablecido con DB externa cambiada: nunca anuncia recuperación total', () => {
  const fx = fixture();
  const efectos = [{ tipo: 'DB', detalle: 'migración aplicada a la base local', compensacion: null }];
  const c = rm.crear(fx.root, { archivos: ['src/a.js'], side_effects: efectos });
  fx.escribir('src/a.js', 'cambiado\n');
  const { p, r } = restaurar(fx.root, c.punto.id);
  assert.deepStrictEqual(p.efectos_externos_no_revertibles, efectos);
  assert.strictEqual(r.status, 'RESTAURADO');
  assert.strictEqual(r.recuperacion, 'SOLO_CODIGO');
  assert.deepStrictEqual(r.efectos_externos_no_revertidos, efectos);
  assert.match(p.nota, /no revierte bases de datos/);
});

test('fallo durante el apply: el journal vuelve al rescate, nunca PASS', () => {
  const fx = fixture();
  const c = rm.crear(fx.root, { archivos: ['src/a.js', 'src/b.js'] });
  fx.escribir('src/a.js', 'a actual\n');
  fx.escribir('src/b.js', 'b actual\n');
  const p = rm.preview(fx.root, c.punto.id);
  const r = rm.aplicar(fx.root, c.punto.id, { expected_current_hash: p.expected_current_hash, inyectarFallo: (i) => i === 1 });
  assert.strictEqual(r.status, 'FALLO_RECUPERADO');
  assert.strictEqual(fx.leer('src/a.js').toString(), 'a actual\n', 'el paso ya escrito se deshizo');
  assert.strictEqual(fx.leer('src/b.js').toString(), 'b actual\n');
});

test('fallo del apply y también del rescate: INCIDENTE y STOP RESTORE_FAILED en TEAMS', () => {
  const fx = fixture();
  const tm = teams(fx, [tarea('T1', 'src/a.js')]);
  const c = rm.crear(fx.root, { archivos: ['src/a.js'], task_id: 'T1' });
  fx.escribir('src/a.js', 'actual\n');
  const r2 = rm.aplicar(fx.root, c.punto.id, {
    expected_current_hash: rm.preview(fx.root, c.punto.id).expected_current_hash, task_id: 'T1',
    inyectarFallo: (i) => i === 0, inyectarFalloRescate: () => true,
  });
  assert.strictEqual(r2.status, 'INCIDENTE');
  assert.deepStrictEqual(r2.archivos, ['src/a.js']);
  assert.ok(tm.pendientes(fx.root).some((s) => s.reason_code === 'RESTORE_FAILED'));
});

test('reinicio a mitad del rollback: se retoma por journal sin repetir pasos a ciegas', () => {
  const fx = fixture();
  const c = rm.crear(fx.root, { archivos: ['src/a.js', 'src/b.js', 'src/nuevo.js'] });
  fx.escribir('src/a.js', 'a tarde\n');
  fx.escribir('src/b.js', 'b tarde\n');
  fx.escribir('src/nuevo.js', 'nuevo tarde\n');
  const p = rm.preview(fx.root, c.punto.id);
  assert.strictEqual(p.ops.length, 3);
  const script = path.join(fx.root, 'crash.cjs');
  fs.writeFileSync(script, `const rm = require(${JSON.stringify(RM_PATH)});
rm.aplicar(process.cwd(), ${JSON.stringify(c.punto.id)}, { expected_current_hash: ${JSON.stringify(p.expected_current_hash)}, inyectarFallo: (i) => { if (i === 1) process.exit(7); return false; } });`);
  const hijo = spawnSync(process.execPath, [script], { cwd: fx.root });
  assert.strictEqual(hijo.status, 7, 'el proceso murió a mitad del apply');
  assert.strictEqual(fx.leer('src/a.js').toString(), 'module.exports = 1;\n', 'el paso 0 sí quedó escrito');
  const ap = fs.readFileSync(path.join(fx.root, '.agentic', '_restore', 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const applyId = ap.find((e) => e.op === 'apply' && e.fase === 'preparado').apply;
  const r = rm.reanudar(fx.root);
  assert.strictEqual(r.reanudados.length, 1);
  assert.strictEqual(r.reanudados[0].status, 'RESTAURADO');
  assert.strictEqual(r.reanudados[0].pasos_aplicados, 2, 'solo los pasos pendientes');
  const pasos = fs.readFileSync(path.join(fx.root, '.agentic', '_restore', 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse)
    .filter((e) => e.op === 'apply-step' && e.apply === applyId);
  assert.strictEqual(pasos.filter((e) => e.path === 'src/a.js').length, 1, 'el paso ya hecho no se repitió');
  assert.strictEqual(fx.leer('src/b.js').toString(), 'module.exports = 2;\n');
  assert.strictEqual(rm.reanudar(fx.root).reanudados.length, 0, 'cerrado: no se vuelve a aplicar');
});

test('reinicio con un archivo cambiado por otro: no sobrescribe a ciegas, vuelve al rescate', () => {
  const fx = fixture();
  const c = rm.crear(fx.root, { archivos: ['src/a.js', 'src/b.js'] });
  fx.escribir('src/a.js', 'a tarde\n');
  fx.escribir('src/b.js', 'b tarde\n');
  const p = rm.preview(fx.root, c.punto.id);
  const script = path.join(fx.root, 'crash.cjs');
  fs.writeFileSync(script, `const rm = require(${JSON.stringify(RM_PATH)});
rm.aplicar(process.cwd(), ${JSON.stringify(c.punto.id)}, { expected_current_hash: ${JSON.stringify(p.expected_current_hash)}, inyectarFallo: (i) => { if (i === 1) process.exit(7); return false; } });`);
  spawnSync(process.execPath, [script], { cwd: fx.root });
  fx.escribir('src/b.js', 'alguien lo editó mientras tanto\n');
  const r = rm.reanudar(fx.root).reanudados[0];
  assert.notStrictEqual(r.status, 'RESTAURADO');
  assert.ok(['FALLO_RECUPERADO', 'INCIDENTE'].includes(r.status));
});

// ─── rollback de TEAMS ───────────────────────────────────────────────────────

function teamsConTareas(fx, tareas) {
  const tm = teams(fx, tareas);
  fs.writeFileSync(path.join(fx.root, '.agentic', 'restore-policy.json'), JSON.stringify({ rollback_automatico: true }));
  return tm;
}

test('rollback de la tarea A conserva el cambio ajeno B; la tarea queda REVERTED, no cerrada', () => {
  const fx = fixture();
  const tm = teamsConTareas(fx, [tarea('A', 'src/a.js')]);
  assert.strictEqual(rm.crear(fx.root, { tipo: 'BASELINE', task_id: 'A', archivos: ['src/a.js'] }).punto.state, 'VERIFIED');
  fx.escribir('src/a.js', 'module.exports = "bug";\n');
  rm.crear(fx.root, { tipo: 'AFTER_UNVERIFIED', task_id: 'A', archivos: ['src/a.js'] });
  fx.escribir('src/b.js', 'cambio de B, de otra persona\n');
  const r = rm.rollbackAutomatico(fx.root, { task_id: 'A', attempt: 1, fallo_reproducible: true });
  assert.strictEqual(r.status, 'REVERTIDA', JSON.stringify(r));
  assert.strictEqual(fx.leer('src/a.js').toString(), 'module.exports = 1;\n');
  assert.strictEqual(fx.leer('src/b.js').toString(), 'cambio de B, de otra persona\n');
  assert.strictEqual(tm.leerTarea(fx.root, 'A').state, 'REVERTED');
  const goal = require(path.join(__dirname, '..', '.agentic', 'grafo', 'goal-check.cjs')).evaluar(fx.root, {});
  assert.ok(goal.codigo, JSON.stringify(goal));
  assert.notStrictEqual(goal.codigo, 'GOAL_OK', 'una tarea revertida no cuenta como terminada');
  assert.strictEqual(tm.reintentar(fx.root, { task_id: 'A' }).status, 'OK');
  assert.strictEqual(tm.leerTarea(fx.root, 'A').state, 'READY');
});

test('mismo archivo tocado por otra persona después: el rollback se bloquea y abre STOP', () => {
  const fx = fixture();
  const tm = teamsConTareas(fx, [tarea('A', 'src/a.js')]);
  rm.crear(fx.root, { tipo: 'BASELINE', task_id: 'A', archivos: ['src/a.js'] });
  fx.escribir('src/a.js', 'entrega de A\n');
  rm.crear(fx.root, { tipo: 'AFTER_UNVERIFIED', task_id: 'A', archivos: ['src/a.js'] });
  fx.escribir('src/a.js', 'entrega de A\n+ arreglo manual de otra persona\n');
  const r = rm.rollbackAutomatico(fx.root, { task_id: 'A', attempt: 1, fallo_reproducible: true });
  assert.strictEqual(r.status, 'NO_ELEGIBLE');
  assert.ok(r.motivos.some((m) => m.startsWith('TRABAJO_AJENO_EN_ALCANCE')));
  assert.strictEqual(fx.leer('src/a.js').toString(), 'entrega de A\n+ arreglo manual de otra persona\n');
  assert.ok(tm.pendientes(fx.root).some((s) => s.reason_code === 'ROLLBACK_NO_ELEGIBLE'));
});

test('rollback sin autorización, con efectos externos o sin fallo reproducible: no elegible', () => {
  const fx = fixture();
  teamsConTareas(fx, [tarea('A', 'src/a.js')]);
  rm.crear(fx.root, { tipo: 'BASELINE', task_id: 'A', archivos: ['src/a.js'] });
  fx.escribir('src/a.js', 'entrega\n');
  rm.crear(fx.root, { tipo: 'AFTER_UNVERIFIED', task_id: 'A', archivos: ['src/a.js'] });
  assert.ok(rm.elegibilidadRollback(fx.root, { task_id: 'A', fallo_reproducible: false }).motivos.includes('FALLO_NO_REPRODUCIBLE'));
  assert.ok(rm.elegibilidadRollback(fx.root, { task_id: 'A', fallo_reproducible: true, side_effects: [{ tipo: 'DB' }] }).motivos.includes('EFECTOS_EXTERNOS'));
  fs.writeFileSync(path.join(fx.root, '.agentic', 'restore-policy.json'), JSON.stringify({ rollback_automatico: false }));
  assert.ok(rm.elegibilidadRollback(fx.root, { task_id: 'A', fallo_reproducible: true }).motivos.includes('POLITICA_NO_AUTORIZA'));
});

test('restaurar código ya verificado invalida esa tarea DONE: vuelve a REVERTED', () => {
  const fx = fixture();
  const tm = teams(fx, [tarea('A', 'src/a.js')]);
  const base = rm.crear(fx.root, { archivos: ['src/a.js'] });
  const db = require(path.join(__dirname, '..', '.agentic', 'grafo', 'db-adapter.cjs')).openWrite(path.join(fx.root, '.agentic', 'memoria.db'));
  try { db.prepare("UPDATE teams_tasks SET state = 'DONE_VERIFIED' WHERE id = 'A'").run(); } finally { db.close(); }
  fx.escribir('src/a.js', 'implementado y verificado\n');
  const { r } = restaurar(fx.root, base.punto.id);
  assert.strictEqual(r.status, 'RESTAURADO');
  assert.deepStrictEqual(r.tareas_revertidas, ['A']);
  assert.strictEqual(tm.leerTarea(fx.root, 'A').state, 'REVERTED');
});
