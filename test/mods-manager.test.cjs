'use strict';
/**
 * Órgano "mods": un mod de Claude Code se instala COMO PLUGIN desde un marketplace local («agentix-mods»), no como carpeta suelta
 * en ~/.claude/skills (ahí solo carga el SKILL.md: el panel y /agentix nunca aparecían). Aquí se prueba la copia, el marketplace,
 * el registro, la limpieza de la copia legada y el CLI real de Claude Code (si existe).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const mm = require('../.agentic/grafo/mods-manager.cjs');

/** Entorno aislado: ni ~/.claude ni ~/.agentix reales se tocan, y por defecto no se invoca `claude`. */
function entorno({ conClaude = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-mods-'));
  const prev = { c: process.env.CLAUDE_CONFIG_DIR, a: process.env.AKDD_HOME, s: process.env.AKDD_MODS_SIN_CLAUDE };
  process.env.CLAUDE_CONFIG_DIR = path.join(base, 'claude'); process.env.AKDD_HOME = path.join(base, 'agentix');
  if (conClaude) delete process.env.AKDD_MODS_SIN_CLAUDE; else process.env.AKDD_MODS_SIN_CLAUDE = '1';
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  return { base, cfg: process.env.CLAUDE_CONFIG_DIR, casa: process.env.AKDD_HOME, restaurar() { for (const [k, v] of [['CLAUDE_CONFIG_DIR', prev.c], ['AKDD_HOME', prev.a], ['AKDD_MODS_SIN_CLAUDE', prev.s]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } } };
}

function raizConMod(nombre = 'panel-demo') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-mods-root-'));
  const src = path.join(root, mm.FUENTE, nombre);
  fs.mkdirSync(path.join(src, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(src, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(src, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: nombre, version: '0.1.0', description: 'demo' }));
  fs.writeFileSync(path.join(src, 'hooks', 'hooks.json'), JSON.stringify({ modules: ['./register.ts'] }));
  fs.writeFileSync(path.join(src, 'hooks', 'register.ts'), 'export const register = () => {}\n');
  return { root, src };
}

test('mods: on copia la fuente al marketplace local y lo declara; deja marca y registro; status dice AL_DIA', () => {
  const e = entorno();
  try {
    const { root } = raizConMod();
    const r = mm.encender(root, 'panel-demo');
    assert.strictEqual(r.ok, true);
    const dest = path.join(e.casa, 'mods-marketplace', 'plugins', 'panel-demo');
    assert.ok(fs.existsSync(path.join(dest, '.claude-plugin', 'plugin.json')));
    assert.ok(fs.existsSync(path.join(dest, 'hooks', 'register.ts')));
    assert.ok(fs.existsSync(path.join(dest, mm.MARCA)), 'la copia lleva la marca de Agentix');
    const mk = JSON.parse(fs.readFileSync(path.join(e.casa, 'mods-marketplace', '.claude-plugin', 'marketplace.json'), 'utf8'));
    assert.strictEqual(mk.name, 'agentix-mods');
    assert.deepStrictEqual(mk.plugins.map((p) => [p.name, p.source]), [['panel-demo', './plugins/panel-demo']]);
    const reg = JSON.parse(fs.readFileSync(path.join(root, mm.REGISTRO), 'utf8'));
    assert.strictEqual(reg['panel-demo'].hash, r.hash);
    assert.strictEqual(reg['panel-demo'].scope, 'local');
    assert.strictEqual(r.carga, 'PENDIENTE_CLAUDE_CLI');
    assert.match(r.siguiente, /claude plugin install panel-demo@agentix-mods --scope local/);
    assert.strictEqual(mm.estado(root)[0].situacion, 'AL_DIA');
    assert.strictEqual(fs.existsSync(path.join(root, '.claude', 'skills', 'panel-demo')), false, 'ya NO se copia a .claude/skills (ahí no carga el módulo)');
  } finally { e.restaurar(); }
});

test('mods: si la fuente cambia, status dice DESACTUALIZADO y refresh la pone al día', () => {
  const e = entorno();
  try {
    const { root, src } = raizConMod();
    mm.encender(root, 'panel-demo');
    fs.writeFileSync(path.join(src, 'hooks', 'register.ts'), 'export const register = () => { /* v2 */ }\n');
    assert.strictEqual(mm.estado(root)[0].situacion, 'DESACTUALIZADO');
    assert.strictEqual(mm.refrescar(root).length, 1);
    assert.strictEqual(mm.estado(root)[0].situacion, 'AL_DIA');
  } finally { e.restaurar(); }
});

test('mods: refresh no enciende lo que el dueño no había encendido', () => {
  const e = entorno();
  try {
    const { root } = raizConMod();
    assert.deepStrictEqual(mm.refrescar(root), []);
    assert.strictEqual(mm.estado(root)[0].situacion, 'APAGADO');
  } finally { e.restaurar(); }
});

test('mods: la copia LEGADA de 3.24.x (skills/<mod> con nuestra marca) se limpia; una carpeta ajena del usuario no se toca', () => {
  const e = entorno();
  try {
    const { root } = raizConMod();
    const propia = path.join(root, mm.DESTINO, 'panel-demo');
    fs.mkdirSync(propia, { recursive: true });
    fs.writeFileSync(path.join(propia, mm.MARCA), '{}');
    fs.writeFileSync(path.join(propia, 'SKILL.md'), 'legado');
    assert.match(mm.estado(root)[0].aviso || '', /LEGADA/);
    const on = mm.encender(root, 'panel-demo');
    assert.strictEqual(on.legado_quitado, true);
    assert.strictEqual(fs.existsSync(propia), false);
    // una carpeta del usuario con ese nombre (sin nuestra marca) NO se borra
    fs.mkdirSync(propia, { recursive: true });
    fs.writeFileSync(path.join(propia, 'SKILL.md'), '# skill del usuario\n');
    mm.encender(root, 'panel-demo'); mm.apagar(root, 'panel-demo');
    assert.ok(fs.existsSync(path.join(propia, 'SKILL.md')), 'lo ajeno sigue ahí');
  } finally { e.restaurar(); }
});

test('mods: off quita el registro y la copia compartida solo si el otro ámbito no la usa; la fuente queda intacta', () => {
  const e = entorno();
  try {
    const { root, src } = raizConMod();
    mm.encender(root, 'panel-demo'); mm.encender(root, 'panel-demo', { global: true });
    const dest = path.join(e.casa, 'mods-marketplace', 'plugins', 'panel-demo');
    assert.strictEqual(mm.apagar(root, 'panel-demo').ok, true);
    assert.ok(fs.existsSync(dest), 'el global aún la usa');
    assert.strictEqual(mm.estado(root)[0].situacion, 'APAGADO');
    assert.strictEqual(mm.apagar(root, 'panel-demo', { global: true }).ok, true);
    assert.strictEqual(fs.existsSync(dest), false, 'ya nadie la usa');
    assert.ok(fs.existsSync(path.join(src, 'hooks', 'register.ts')));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(root, mm.REGISTRO), 'utf8')), {});
  } finally { e.restaurar(); }
});

test('mods: un mod desconocido se rechaza con reason_code, sin crear nada', () => {
  const e = entorno();
  try {
    const { root } = raizConMod();
    const r = mm.encender(root, 'no-existe');
    assert.strictEqual(r.ok, false); assert.strictEqual(r.reason_code, 'MOD_DESCONOCIDO');
    assert.strictEqual(fs.existsSync(path.join(e.casa, 'mods-marketplace')), false);
  } finally { e.restaurar(); }
});

test('mods --global: sin fuente en el proyecto usa la del paquete (funciona desde cualquier carpeta) y usa scope user', () => {
  const e = entorno();
  try {
    const vacio = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-vacio-'));
    assert.ok(mm.disponibles(vacio, { global: true }).includes('agentix-live'));
    const r = mm.encender(vacio, 'agentix-live', { global: true });
    assert.strictEqual(r.ok, true); assert.strictEqual(r.scope, 'user');
    assert.ok(fs.existsSync(path.join(e.casa, '_mods-host.json')), 'registro global en ~/.agentix');
    assert.strictEqual(mm.estado(vacio, { global: true })[0].situacion, 'AL_DIA');
  } finally { e.restaurar(); }
});

test('mods: el mod real agentix-live viaja en el repo con su manifiesto y su módulo', () => {
  const root = path.resolve(__dirname, '..');
  assert.ok(mm.disponibles(root).includes('agentix-live'));
  for (const f of ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/register.tsx', 'types/index.d.ts']) {
    assert.ok(fs.existsSync(path.join(root, mm.FUENTE, 'agentix-live', f)), f);
  }
  assert.ok(require('../package.json').files.includes('.agentic/mods/'), 'package.json publica .agentic/mods/');
});

const hayClaude = (() => { try { return spawnSync('claude', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32', timeout: 15000 }).status === 0; } catch { return false; } })();

test('mods + CLI real de Claude Code: se instala como plugin del marketplace local, aparece en `plugin list` y off lo quita', { skip: !hayClaude && 'HOST_REAL_NO_EJECUTADO: no hay CLI `claude` en esta máquina; la copia, el marketplace y el registro sí se prueban arriba' }, () => {
  const e = entorno({ conClaude: true });
  try {
    const vacio = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-real-'));
    const r = mm.encender(vacio, 'agentix-live', { global: true });
    assert.strictEqual(r.carga, 'INSTALADO', JSON.stringify(r));
    const st = mm.estado(vacio, { global: true })[0];
    assert.strictEqual(st.en_claude, true); assert.strictEqual(st.situacion, 'AL_DIA');
    const lista = spawnSync('claude', ['plugin', 'list'], { encoding: 'utf8', shell: process.platform === 'win32', timeout: 60000, env: process.env });
    assert.match(lista.stdout, /agentix-live@agentix-mods/);
    assert.strictEqual(mm.apagar(vacio, 'agentix-live', { global: true }).desinstalado_en_claude, true);
    assert.doesNotMatch(spawnSync('claude', ['plugin', 'list'], { encoding: 'utf8', shell: process.platform === 'win32', timeout: 60000, env: process.env }).stdout, /agentix-live@agentix-mods/);
  } finally { e.restaurar(); }
});

test('mod agentix-live: las referencias de $.state son literales o consts del archivo, nunca miembros (R.usage hacía que el módulo NO cargara en la app 2.1.289)', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', '.agentic', 'mods', 'agentix-live', 'hooks', 'register.tsx'), 'utf8');
  const llamadas = [...src.matchAll(/\$\.state\.(?:get|set)\(\s*([^,)]+)/g)].map((m) => m[1].trim());
  assert.ok(llamadas.length > 5, 'se encontraron las llamadas');
  for (const ref of llamadas) assert.match(ref, /^[A-Za-z_][A-Za-z0-9_]*$/, 'referencia por identificador, no miembro: ' + ref);
  for (const ref of new Set(llamadas)) assert.match(src, new RegExp('const ' + ref + " = \{ plugin: '[^']+', key: '[^']+' \}"), ref + ' es una const con plugin y key literales');
});
