'use strict';
/**
 * Órgano "mods": instala los mods de Claude Code que trae Agentix en
 * .claude/skills/<nombre>/ sin pisar nada ajeno, y sabe si la copia está al día.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mm = require('../.agentic/grafo/mods-manager.cjs');

function raizConMod(nombre = 'panel-demo') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-mods-'));
  const src = path.join(root, mm.FUENTE, nombre);
  fs.mkdirSync(path.join(src, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(src, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(src, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: nombre, version: '0.1.0', description: 'demo' }));
  fs.writeFileSync(path.join(src, 'hooks', 'hooks.json'), JSON.stringify({ modules: ['./register.ts'] }));
  fs.writeFileSync(path.join(src, 'hooks', 'register.ts'), 'export const register = () => {}\n');
  return { root, src, dest: path.join(root, mm.DESTINO, nombre) };
}

test('mods: on copia la fuente a .claude/skills, deja marca y registro; status dice AL_DIA', () => {
  const { root, dest } = raizConMod();
  const r = mm.encender(root, 'panel-demo');
  assert.strictEqual(r.ok, true);
  assert.ok(fs.existsSync(path.join(dest, '.claude-plugin', 'plugin.json')));
  assert.ok(fs.existsSync(path.join(dest, 'hooks', 'register.ts')));
  assert.ok(fs.existsSync(path.join(dest, mm.MARCA)), 'la copia lleva la marca de Agentix');
  const reg = JSON.parse(fs.readFileSync(path.join(root, mm.REGISTRO), 'utf8'));
  assert.strictEqual(reg['panel-demo'].hash, r.hash);
  assert.strictEqual(mm.estado(root)[0].situacion, 'AL_DIA');
});

test('mods: si la fuente cambia, status dice DESACTUALIZADO y refresh la pone al día', () => {
  const { root, src } = raizConMod();
  mm.encender(root, 'panel-demo');
  fs.writeFileSync(path.join(src, 'hooks', 'register.ts'), 'export const register = () => { /* v2 */ }\n');
  assert.strictEqual(mm.estado(root)[0].situacion, 'DESACTUALIZADO');
  const ref = mm.refrescar(root);
  assert.strictEqual(ref.length, 1);
  assert.strictEqual(mm.estado(root)[0].situacion, 'AL_DIA');
});

test('mods: refresh no enciende lo que el dueño no había encendido', () => {
  const { root } = raizConMod();
  assert.deepStrictEqual(mm.refrescar(root), []);
  assert.strictEqual(mm.estado(root)[0].situacion, 'APAGADO');
});

test('mods: una carpeta ajena con el mismo nombre no se pisa ni se borra', () => {
  const { root, dest } = raizConMod();
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'SKILL.md'), '# skill del usuario\n');
  const on = mm.encender(root, 'panel-demo');
  assert.strictEqual(on.ok, false);
  assert.strictEqual(on.reason_code, 'AJENO');
  const off = mm.apagar(root, 'panel-demo');
  assert.strictEqual(off.ok, false);
  assert.strictEqual(off.reason_code, 'AJENO');
  assert.strictEqual(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), '# skill del usuario\n');
  assert.strictEqual(mm.estado(root)[0].situacion, 'AJENO');
});

test('mods: off quita solo la copia propia y el registro; la fuente queda intacta', () => {
  const { root, src, dest } = raizConMod();
  mm.encender(root, 'panel-demo');
  const off = mm.apagar(root, 'panel-demo');
  assert.strictEqual(off.ok, true);
  assert.strictEqual(off.quitado, true);
  assert.ok(!fs.existsSync(dest));
  assert.ok(fs.existsSync(path.join(src, 'hooks', 'register.ts')), 'la fuente no se toca');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(root, mm.REGISTRO), 'utf8')), {});
});

test('mods: un mod desconocido se rechaza con reason_code, sin crear nada', () => {
  const { root } = raizConMod();
  const r = mm.encender(root, 'no-existe');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason_code, 'MOD_DESCONOCIDO');
  assert.ok(!fs.existsSync(path.join(root, mm.DESTINO, 'no-existe')));
});

test('mods: el mod real agentix-live viaja en el repo con su manifiesto y su módulo', () => {
  const root = path.resolve(__dirname, '..');
  assert.ok(mm.disponibles(root).includes('agentix-live'));
  for (const f of ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/register.tsx', 'types/index.d.ts']) {
    assert.ok(fs.existsSync(path.join(root, mm.FUENTE, 'agentix-live', f)), f);
  }
  const files = require('../package.json').files;
  assert.ok(files.includes('.agentic/mods/'), 'package.json publica .agentic/mods/');
});

// ───────────────────────────── ámbito global (--global) ─────────────────────────────

/** Entorno aislado: ni ~/.claude ni ~/.agentix reales se tocan. */
function entornoGlobal() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-mods-global-'));
  const prev = { c: process.env.CLAUDE_CONFIG_DIR, a: process.env.AKDD_HOME };
  process.env.CLAUDE_CONFIG_DIR = path.join(base, 'claude'); process.env.AKDD_HOME = path.join(base, 'agentix');
  return { base, cfg: process.env.CLAUDE_CONFIG_DIR, casa: process.env.AKDD_HOME, restaurar() { for (const [k, v] of [['CLAUDE_CONFIG_DIR', prev.c], ['AKDD_HOME', prev.a]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } } };
}

test('mods --global: instala en la carpeta de usuario de Claude Code, con su marca y su registro, sin tocar el proyecto', () => {
  const env = entornoGlobal();
  try {
    const { root } = raizConMod();
    const r = mm.encender(root, 'panel-demo', { global: true });
    assert.strictEqual(r.ok, true); assert.strictEqual(r.ambito, 'global');
    const dest = path.join(env.cfg, 'skills', 'panel-demo');
    assert.ok(fs.existsSync(path.join(dest, '.claude-plugin', 'plugin.json')));
    assert.ok(fs.existsSync(path.join(dest, mm.MARCA)));
    assert.ok(!fs.existsSync(path.join(root, mm.DESTINO, 'panel-demo')), 'el proyecto no recibe copia local');
    assert.ok(!fs.existsSync(path.join(root, mm.REGISTRO)), 'el registro del proyecto no cambia');
    const reg = JSON.parse(fs.readFileSync(path.join(env.casa, '_mods-host.json'), 'utf8'));
    assert.strictEqual(reg['panel-demo'].hash, r.hash);
    assert.strictEqual(mm.estado(root, { global: true })[0].situacion, 'AL_DIA');
    assert.strictEqual(mm.estado(root)[0].situacion, 'APAGADO', 'lo global no enciende el ámbito del proyecto');
  } finally { env.restaurar(); }
});

test('mods --global: sin fuente en el proyecto usa la del paquete (funciona desde cualquier carpeta)', () => {
  const env = entornoGlobal();
  try {
    const vacio = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-sin-agentix-'));
    assert.deepStrictEqual(mm.disponibles(vacio, { global: true }), ['agentix-live'], 'viene del .agentic/mods del paquete');
    const r = mm.encender(vacio, 'agentix-live', { global: true });
    assert.strictEqual(r.ok, true);
    assert.ok(fs.existsSync(path.join(env.cfg, 'skills', 'agentix-live', 'hooks', 'register.tsx')));
  } finally { env.restaurar(); }
});

test('mods --global: una carpeta ajena no se pisa ni se borra; off quita solo lo propio y el registro global', () => {
  const env = entornoGlobal();
  try {
    const { root } = raizConMod();
    const ajena = path.join(env.cfg, 'skills', 'panel-demo'); fs.mkdirSync(ajena, { recursive: true }); fs.writeFileSync(path.join(ajena, 'mio.txt'), 'x');
    const r = mm.encender(root, 'panel-demo', { global: true });
    assert.strictEqual(r.ok, false); assert.strictEqual(r.reason_code, 'AJENO');
    assert.strictEqual(mm.apagar(root, 'panel-demo', { global: true }).reason_code, 'AJENO');
    assert.ok(fs.existsSync(path.join(ajena, 'mio.txt')));
    fs.rmSync(ajena, { recursive: true, force: true });
    mm.encender(root, 'panel-demo', { global: true });
    const o = mm.apagar(root, 'panel-demo', { global: true });
    assert.strictEqual(o.ok, true); assert.strictEqual(o.quitado, true);
    assert.ok(!fs.existsSync(path.join(env.cfg, 'skills', 'panel-demo')));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(env.casa, '_mods-host.json'), 'utf8')), {});
  } finally { env.restaurar(); }
});

test('mods --global: si el proyecto ya tiene su copia local avisa del doble cargado', () => {
  const env = entornoGlobal();
  try {
    const { root } = raizConMod();
    mm.encender(root, 'panel-demo');
    const r = mm.encender(root, 'panel-demo', { global: true });
    assert.strictEqual(r.ok, true); assert.match(r.aviso, /dos veces/);
    assert.match(mm.estado(root, { global: true })[0].aviso, /dos veces/);
  } finally { env.restaurar(); }
});

test('mods --global: refresh solo toca lo que se había encendido en global', () => {
  const env = entornoGlobal();
  try {
    const { root, src } = raizConMod();
    assert.deepStrictEqual(mm.refrescar(root, { global: true }), [], 'nada encendido → nada se enciende solo');
    mm.encender(root, 'panel-demo', { global: true });
    fs.writeFileSync(path.join(src, 'hooks', 'register.ts'), 'export const register = () => { /* v2 */ }\n');
    assert.strictEqual(mm.estado(root, { global: true })[0].situacion, 'DESACTUALIZADO');
    assert.strictEqual(mm.refrescar(root, { global: true })[0].ok, true);
    assert.strictEqual(mm.estado(root, { global: true })[0].situacion, 'AL_DIA');
  } finally { env.restaurar(); }
});
