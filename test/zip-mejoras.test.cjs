'use strict';

/* 03-mejoras-del-zip — simple gate, guardia y hooks de host, revisor
   externo opt-in, vecinos dirigidos, contrato único de sync, config de llms
   y finales de línea. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const sg = require('../.agentic/grafo/simple-gate.cjs');
const guard = require('../.agentic/grafo/host-guard.cjs');
const hh = require('../.agentic/grafo/host-hooks.cjs');
const rev = require('../.agentic/grafo/revisor-externo.cjs');
const llms = require('../.agentic/grafo/llms-generator.cjs');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-zip-' + p + '-'));

// ─── simple gate ─────────────────────────────────────────────────────────────

test('03 simple: dependencia con equivalente nativo, función existente y bloque duplicado', () => {
  const root = tmp('sg');
  fs.mkdirSync(path.join(root, 'src'));
  const bloque = ['const total = items.reduce((a, b) => a + b.precio, 0);', 'const iva = total * 0.16;', 'const conIva = total + iva;', 'const redondeado = Math.round(conIva * 100) / 100;', 'registrar("calculo", redondeado);', 'notificar(usuario, redondeado);'].join('\n');
  fs.writeFileSync(path.join(root, 'src', 'util.js'), `function formatearMoneda(x) { return x.toFixed(2); }\nfunction otro() {\n${bloque}\n}\nfunction auxiliarLocal() {}\nmodule.exports = { formatearMoneda, otro };\n`);
  const r = sg.analizar(root, [
    { path: 'package.json', previo: JSON.stringify({ dependencies: {} }), nuevo: JSON.stringify({ dependencies: { axios: '^1', express: '^4' } }) },
    { path: 'src/nuevo.js', previo: null, nuevo: `function formatearMoneda(v) { return v.toFixed(2); }\nfunction auxiliarLocal() {}\nfunction main() {}\nfunction calcular() {\n${bloque}\n}\n` },
  ]);
  assert.ok(!r.sugerencias.some((s) => /auxiliarLocal|"main"/.test(s.detalle)), 'un helper local o un nombre genérico no es señal de reutilización');
  const tipos = r.sugerencias.map((s) => s.tipo).sort();
  assert.deepStrictEqual(tipos, ['DEPENDENCIA_EVITABLE', 'DUPLICACION', 'REUTILIZAR']);
  assert.ok(r.sugerencias.find((s) => s.tipo === 'DEPENDENCIA_EVITABLE').detalle.includes('fetch'));
  assert.ok(!r.sugerencias.some((s) => /express/.test(s.detalle)), 'una dependencia sin equivalente nativo no se señala');
  assert.strictEqual(r.blocking, false);
  assert.ok(r.costo.archivos_leidos >= 1 && Number.isFinite(r.costo.ms));
  assert.strictEqual(r.diagnostico.nota, 'solo diagnóstico, no mide calidad');
});

test('03 simple: cambio limpio no sugiere nada; riesgo alto añade la nota de prioridad', () => {
  const root = tmp('sg2');
  const limpio = sg.analizar(root, [{ path: 'a.js', previo: 'const a = 1;\n', nuevo: 'const a = 2;\n' }]);
  assert.strictEqual(limpio.status, 'PASS');
  assert.strictEqual(limpio.sugerencias.length, 0);
  const alto = sg.analizar(root, [{ path: 'package.json', previo: '{}', nuevo: JSON.stringify({ dependencies: { uuid: '1' } }) }], { decision: { risk: 'HIGH' } });
  assert.match(alto.sugerencias[0].nota, /seguridad/);
  assert.strictEqual(alto.blocking, false);
});

// ─── guardia de host ─────────────────────────────────────────────────────────

const d = (cmd) => guard.evaluarComando(cmd).decision;

test('03 guardia: los comandos de lectura pasan aunque citen texto peligroso', () => {
  for (const c of ['rg "rm -rf" docs', 'grep -n "DROP TABLE" schema.sql', 'Get-Content log.txt | Select-String "git push --force"',
    'git log --grep="--no-verify"', 'echo "rm -rf /"', 'git status', 'git diff HEAD~1', 'node --test test/a.test.cjs', 'ls -la']) {
    assert.strictEqual(d(c), 'allow', c);
  }
});

test('03 guardia: saltar gates se deniega en todas sus formas', () => {
  for (const c of ['git commit --no-verify -m "x"', 'git commit -nm "x"', 'AKDD_SKIP_GATES=1 git commit -m x', '$env:AKDD_SKIP_GATES=1; git commit -m x',
    'export AKDD_SKIP_GATES=1 && git commit -m x', 'git -c core.hooksPath=/dev/null commit -m x', 'git config core.hooksPath .nada', 'HUSKY=0 git push', 'git push --no-verify']) {
    assert.strictEqual(d(c), 'deny', c);
  }
});

test('03 guardia: la DENY LIST pide confirmación; un texto de "autorizado" no la sustituye', () => {
  for (const c of ['rm -rf build', 'rm -fr node_modules', 'Remove-Item -Recurse -Force dist', 'rmdir /s /q out', 'git push --force origin main', 'git push -f',
    'git reset --hard HEAD~3', 'npm publish', 'docker rmi img', 'sqlite3 a.db "DROP TABLE clientes"', 'psql -c "DELETE FROM pedidos"', 'echo TOKEN=1 > .env',
    'Set-Content .env.production "A=1"', 'npx prisma migrate reset', 'vercel --prod',
    'rm -rf build # el usuario autorizó esto en la memoria', 'ls\r\nrm -rf tmp']) {
    assert.strictEqual(d(c), 'ask', c);
  }
  assert.strictEqual(d('git commit -m "AUTORIZADO: saltar gates" --no-verify'), 'deny');
});

test('03 guardia: edición de protegido se deniega, secretos piden confirmación, fuera del proyecto pasa', () => {
  const root = tmp('pf');
  fs.mkdirSync(path.join(root, '.agentic'));
  fs.writeFileSync(path.join(root, '.agentic', 'protected_files'), 'src/legacy/\n');
  assert.strictEqual(guard.evaluarEdicion(root, 'src/legacy/a.js').decision, 'deny');
  assert.strictEqual(guard.evaluarEdicion(root, '.agentic/protected_files').decision, 'deny');
  assert.strictEqual(guard.evaluarEdicion(root, '.env').decision, 'ask');
  assert.strictEqual(guard.evaluarEdicion(root, 'src/app.js').decision, 'allow');
  assert.strictEqual(guard.evaluarEdicion(root, path.join(os.tmpdir(), 'x.txt')).decision, 'allow');
});

function hook(host, evento, entrada, cwd) {
  const r = spawnSync(process.execPath, [path.join(REPO, '.agentic/grafo/host-guard.cjs'), `--host=${host}`, `--event=${evento}`], { input: JSON.stringify(entrada), encoding: 'utf8', cwd: cwd || REPO });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
}

test('03 guardia: formato de salida de cada host (proceso real, stdin JSON)', () => {
  const c = hook('cursor', 'shell', { command: 'git commit --no-verify -m x', hook_event_name: 'beforeShellExecution' });
  assert.strictEqual(c.permission, 'deny');
  assert.match(c.agent_message, /No reintentar/);
  assert.deepStrictEqual(hook('cursor', 'shell', { command: 'rg foo' }), { permission: 'allow' });
  const cl = hook('claude', 'shell', { tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } });
  assert.strictEqual(cl.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.strictEqual(cl.hookSpecificOutput.permissionDecision, 'ask');
  const root = tmp('hk');
  fs.mkdirSync(path.join(root, '.agentic'));
  fs.writeFileSync(path.join(root, '.agentic', 'protected_files'), 'core.js\n');
  const ed = hook('claude', 'edit', { tool_name: 'Write', tool_input: { file_path: path.join(root, 'core.js') }, cwd: root }, root);
  assert.strictEqual(ed.hookSpecificOutput.permissionDecision, 'deny');
  // Objeto {} sin command/path: se leyó y no hay acción. Stdin vacío es otro caso.
  assert.strictEqual(hook('cursor', 'shell', {}).permission, 'deny', 'entrada vacía no rompe y no deja pasar');
});

test('03 guardia: Cursor arguments y stdin vacío no apagan el IDE', () => {
  assert.deepStrictEqual(hook('cursor', 'shell', { arguments: { command: 'rg foo' } }), { permission: 'allow' });
  assert.strictEqual(hook('cursor', 'shell', { arguments: { command: 'git commit --no-verify -m x' } }).permission, 'deny');
  assert.strictEqual(hook('cursor', 'edit', { arguments: { path: path.join(REPO, 'package.json') } }).permission, 'allow');
  const vacio = spawnSync(process.execPath, [path.join(REPO, '.agentic/grafo/host-guard.cjs'), '--host=cursor', '--event=shell'], { input: '', encoding: 'utf8', cwd: REPO });
  assert.strictEqual(vacio.status, 0, vacio.stderr);
  assert.strictEqual(JSON.parse(vacio.stdout).permission, 'allow');
  const str = hook('cursor', 'shell', { tool_input: JSON.stringify({ command: 'rg foo' }) });
  assert.deepStrictEqual(str, { permission: 'allow' });
});

test('03 enriquecimiento: solo aa:, sin repetir, con presupuesto visible', () => {
  const root = tmp('en');
  fs.mkdirSync(path.join(root, '.agentic'));
  assert.strictEqual(guard.enriquecer(root, 'explícame el módulo').motivo, 'NO_ES_AA');
  const antes = guard.ENRIQ.maxBytes;
  guard.ENRIQ.maxBytes = 200;
  try {
    const a = guard.enriquecer(root, 'aa: cambia el texto del botón');
    assert.ok(['OK', 'TRUNCADO', 'ERROR', 'TIMEOUT'].includes(a.motivo));
    assert.ok(a.contexto, 'siempre deja algo visible, aunque sea el aviso de no disponible');
    if (a.motivo === 'OK' || a.motivo === 'TRUNCADO') {
      assert.strictEqual(guard.enriquecer(root, 'aa: cambia el texto del botón').motivo, 'YA_ENRIQUECIDO');
      assert.ok(Buffer.byteLength(a.contexto) <= 200 + 80);
    }
  } finally { guard.ENRIQ.maxBytes = antes; }
});

// ─── instalación de hooks de host ────────────────────────────────────────────

test('03 host-hooks: merge sin tocar lo ajeno, idempotente, desinstala solo lo propio', () => {
  const root = tmp('hh');
  fs.mkdirSync(path.join(root, '.cursor'));
  const ajeno = { version: 1, hooks: { afterFileEdit: [{ command: '.cursor/hooks/format.sh' }], beforeShellExecution: [{ command: './mio.sh', matcher: 'curl' }] } };
  fs.writeFileSync(path.join(root, '.cursor', 'hooks.json'), JSON.stringify(ajeno));
  hh.instalar(root, 'cursor');
  hh.instalar(root, 'cursor');
  const cfg = JSON.parse(fs.readFileSync(path.join(root, '.cursor', 'hooks.json'), 'utf8'));
  assert.strictEqual(cfg.hooks.beforeShellExecution.length, 2, 'el propio una sola vez + el ajeno');
  assert.deepStrictEqual(cfg.hooks.afterFileEdit, ajeno.hooks.afterFileEdit);
  assert.strictEqual(hh.estado(root).find((x) => x.host === 'cursor').verificado, 'NO_VERIFICADO');
  const u = hh.desinstalar(root, 'cursor');
  assert.strictEqual(u.quitadas, Object.values(hh.HOSTS.cursor.entradas()).flat().length, 'exactamente las entradas propias');
  assert.strictEqual(u.archivo_borrado, false, 'el archivo era del usuario');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(root, '.cursor', 'hooks.json'), 'utf8')), ajeno);
});

test('03 host-hooks: Claude conserva otras claves; archivo propio vacío se borra; JSON roto no se pisa', () => {
  const root = tmp('hh2');
  fs.mkdirSync(path.join(root, '.claude'));
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(npm test)'] } }));
  hh.instalar(root, 'claude');
  const cfg = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
  assert.deepStrictEqual(cfg.permissions, { allow: ['Bash(npm test)'] });
  assert.ok(cfg.hooks.PreToolUse.length === 3 && cfg.hooks.UserPromptSubmit.length === 1);
  assert.ok(cfg.hooks.PreToolUse.some((e) => e.matcher === 'mcp__.*'), 'las herramientas MCP también pasan por la guardia');
  hh.desinstalar(root, 'claude');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8')), { permissions: { allow: ['Bash(npm test)'] }, hooks: {} });

  const nuevo = tmp('hh3');
  hh.instalar(nuevo, 'cursor');
  assert.ok(fs.existsSync(path.join(nuevo, '.cursor', 'hooks.json')));
  assert.strictEqual(hh.desinstalar(nuevo, 'cursor').archivo_borrado, true);

  const roto = tmp('hh4');
  fs.mkdirSync(path.join(roto, '.cursor'));
  fs.writeFileSync(path.join(roto, '.cursor', 'hooks.json'), '{ esto no es json');
  assert.strictEqual(hh.instalar(roto, 'cursor').reason_code, 'ARCHIVO_ILEGIBLE');
  assert.strictEqual(fs.readFileSync(path.join(roto, '.cursor', 'hooks.json'), 'utf8'), '{ esto no es json');
});

// ─── revisor externo ─────────────────────────────────────────────────────────

test('03 revisor externo: opt-in; ausente = no disponible, nunca PASS inventado', () => {
  const root = tmp('rv');
  fs.mkdirSync(path.join(root, '.agentic'));
  assert.strictEqual(rev.estado(root, { tier: 'HIGH' }).reason_code, 'NO_CONFIGURADO');
  fs.writeFileSync(path.join(root, rev.ARCHIVO), JSON.stringify({ enabled: true, provider: 'x', model: 'y', credential_env: 'AKDD_TEST_NO_EXISTE_CRED', required_for_close: true }));
  assert.strictEqual(rev.estado(root, { tier: 'LOW' }).reason_code, 'TIER_MENOR', 'una tarea menor no paga revisión');
  const e = rev.estado(root, { tier: 'HIGH' });
  assert.strictEqual(e.status, 'UNVERIFIED');
  assert.strictEqual(e.reason_code, 'REVISION_EXTERNA_NO_DISPONIBLE');
  assert.strictEqual(e.puede_cerrar, false, 'la política exige revisor: no cierra sin él');
  process.env.AKDD_TEST_NO_EXISTE_CRED = '1';
  try {
    const f = rev.estado(root, { tier: 'HIGH' }, { veredicto: 'FAIL', resumen: 'race en sesión' });
    assert.strictEqual(f.reason_code, 'DISCREPANCIA_REVISOR');
    assert.strictEqual(f.puede_cerrar, false);
  } finally { delete process.env.AKDD_TEST_NO_EXISTE_CRED; }
  fs.writeFileSync(path.join(root, 'k.js'), 'const k = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd";\n');
  const s = rev.snapshot(root, ['k.js']);
  assert.ok(Object.isFrozen(s) && Object.isFrozen(s.items[0]));
  assert.ok(!s.items[0].contenido.includes('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd'));
});

// ─── vecinos dirigidos ───────────────────────────────────────────────────────

test('03 vecinos: el paquete trae callers y callees directos con tope', async () => {
  const root = tmp('vc');
  fs.mkdirSync(path.join(root, '.agentic'));
  const db = require('../.agentic/grafo/db-adapter.cjs').openWrite(path.join(root, '.agentic', 'memoria.db'));
  db.exec('CREATE TABLE ast_edges (id INTEGER PRIMARY KEY, from_file TEXT, to_file TEXT, kind TEXT)');
  db.run("INSERT INTO ast_edges (from_file, to_file, kind) VALUES ('src/a.js','src/b.js','IMPORTS'), ('src/b.js','src/c.js','IMPORTS'), ('src/d.js','src/b.js','CALLS')");
  db.close();
  const p = await require('../.agentic/grafo/context-pack.cjs').armar(root, { task_id: 'vc-1', objetivo: 'arregla el bug del cálculo', paths: ['src/b.js'] });
  assert.strictEqual(p.vecinos.fuente, 'ast');
  assert.deepStrictEqual(p.vecinos.archivos['src/b.js'].callers.sort(), ['src/a.js', 'src/d.js']);
  assert.deepStrictEqual(p.vecinos.archivos['src/b.js'].callees, ['src/c.js']);
});

// ─── contrato único de sync ──────────────────────────────────────────────────

test('03 sync: CLI y motor corren el mismo conjunto de pasos', () => {
  const root = tmp('sy');
  fs.cpSync(path.join(REPO, '.agentic', 'grafo'), path.join(root, '.agentic', 'grafo'), { recursive: true, filter: (s) => !/node_modules|\.model_cache|_hooks/.test(s) });
  fs.mkdirSync(path.join(root, '.agentic', 'memoria'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agentic', 'memoria', 'patrones.md'), '# Patrones\n');
  const env = (f) => ({ ...process.env, AKDD_SYNC_REPORT: path.join(root, f), AGENTIC_MEMORIA_PATH_OVERRIDE: '' });
  const cli = spawnSync(process.execPath, ['.agentic/grafo/grafo.cjs', 'sync'], { cwd: root, env: env('cli.json'), encoding: 'utf8', timeout: 120000 });
  assert.strictEqual(cli.status, 0, cli.stderr);
  const motor = spawnSync(process.execPath, ['-e', "require('./.agentic/grafo/grafo.cjs').sincronizar()"], { cwd: root, env: env('motor.json'), encoding: 'utf8', timeout: 120000 });
  assert.strictEqual(motor.status, 0, motor.stderr);
  const a = JSON.parse(fs.readFileSync(path.join(root, 'cli.json'), 'utf8'));
  const b = JSON.parse(fs.readFileSync(path.join(root, 'motor.json'), 'utf8'));
  const esperado = require(path.join(root, '.agentic/grafo/grafo.cjs')).pasosSync();
  assert.deepStrictEqual(a.pasos.map((x) => x.paso), esperado);
  assert.deepStrictEqual(b.pasos.map((x) => x.paso), esperado);
  assert.strictEqual(a.via, 'cli');
  assert.strictEqual(b.via, 'motor');
});

// ─── config de llms ──────────────────────────────────────────────────────────

test('03 llms: reconoce el config real y el antiguo, y reporta claves desconocidas', () => {
  const real = tmp('ll');
  fs.mkdirSync(path.join(real, '.agentic'));
  fs.copyFileSync(path.join(REPO, '.agentic', 'config.md'), path.join(real, '.agentic', 'config.md'));
  const r = llms.leerConfigProyecto(real);
  assert.strictEqual(r.schema_version, 1);
  assert.strictEqual(r.campos.proyecto, 'agentic-kdd');
  assert.match(r.campos.descripcion, /^Autonomous/);
  assert.match(r.campos.stack, /Node\.js/);
  assert.ok(r.campos.modulos.length > 0);
  assert.deepStrictEqual(r.origen, { proyecto: 'Nombre', descripcion: 'Descripción', stack: '## Stack', modulos: '## Módulos' });

  const viejo = tmp('ll2');
  fs.mkdirSync(path.join(viejo, '.agentic'));
  fs.writeFileSync(path.join(viejo, '.agentic', 'config.md'), 'PROYECTO: tienda\r\nSTACK: Next.js, Prisma\r\nDESCRIPCIÓN: venta en línea\r\nColor favorito: azul\r\n');
  const v = llms.leerConfigProyecto(viejo);
  assert.deepStrictEqual([v.campos.proyecto, v.campos.stack, v.campos.descripcion], ['tienda', 'Next.js, Prisma', 'venta en línea']);
  assert.deepStrictEqual(v.desconocidos, ['Color favorito']);
  assert.deepStrictEqual(llms.leerConfigProyecto(tmp('ll3')).campos, {}, 'sin config: vacío, no error');
});

// ─── finales de línea ────────────────────────────────────────────────────────

test('03 EOL: .gitattributes fija LF en código y hooks; los git hooks no traen CR', () => {
  const ga = fs.readFileSync(path.join(REPO, '.gitattributes'), 'utf8');
  assert.match(ga, /^\*\.cjs\s+text eol=lf$/m);
  assert.match(ga, /^\.agentic\/grafo\/git-hooks\/\*\s+text eol=lf$/m);
  for (const h of fs.readdirSync(path.join(REPO, '.agentic', 'grafo', 'git-hooks'))) {
    assert.ok(!fs.readFileSync(path.join(REPO, '.agentic', 'grafo', 'git-hooks', h), 'utf8').includes('\r'), h + ' sin CRLF');
  }
});
