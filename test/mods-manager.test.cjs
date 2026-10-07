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
