'use strict';

// H12 — un cambio de comportamiento con la misma firma pública no es cosmético.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cc = require('../.agentic/grafo/change-classifier.cjs');
const { disponible, motivoSinDriver } = require('./helpers/sqlite.cjs');

const base = [
  '// valida al usuario',
  'function puede(u) {',
  '  if (u.rol === "admin") return true;',
  '  return false;',
  '}',
  'module.exports = { puede };',
  '',
].join('\n');

test('H12: return false → true es semántico; formato/comentario no', () => {
  const a = cc.bodyFingerprint(base, 'a.js');
  const formato = cc.bodyFingerprint(base.replace('// valida al usuario', '/* otro comentario */')
    .replace('  return false;', '\n      return   false ;   // sigue igual'), 'a.js');
  const cambio = cc.bodyFingerprint(base.replace('return false', 'return true'), 'a.js');
  const literal = cc.bodyFingerprint(base.replace('"admin"', '"root"'), 'a.js');
  const condicion = cc.bodyFingerprint(base.replace('===', '!=='), 'a.js');
  assert.ok(a.ok);
  assert.equal(formato.hash, a.hash, 'solo formato y comentarios');
  for (const x of [cambio, literal, condicion]) assert.notEqual(x.hash, a.hash);
});

test('H12: en Python la indentación cuenta', () => {
  const py = 'def f(x):\n    if x:\n        return 1\n    return 2\n';
  const fuera = 'def f(x):\n    if x:\n        return 1\n        return 2\n';
  assert.notEqual(cc.bodyFingerprint(py, 'a.py').hash, cc.bodyFingerprint(fuera, 'a.py').hash);
  assert.equal(cc.bodyFingerprint(py, 'a.py').hash, cc.bodyFingerprint(py.replace('return 2', 'return 2  # comentario'), 'a.py').hash);
});

test('H12: texto que no se puede leer o lenguaje sin soporte nunca es cosmético', () => {
  assert.equal(cc.bodyFingerprint('function f( { return 1; }', 'a.js').reason, 'PARSE_FAILED');
  assert.equal(cc.bodyFingerprint('const s = "sin cerrar;\n', 'a.js').reason, 'PARSE_FAILED');
  assert.equal(cc.bodyFingerprint('/* abierto', 'a.ts').reason, 'PARSE_FAILED');
  assert.equal(cc.bodyFingerprint('x', 'a.yaml').reason, 'UNSUPPORTED');
});

test('H12: classifyFile contra baseline — SEMANTIC, COSMETIC y UNKNOWN', (t) => {
  if (!disponible()) { t.skip(motivoSinDriver()); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-cc-'));
  fs.mkdirSync(path.join(root, '.agentic'));
  const f = path.join(root, 'a.js');
  fs.writeFileSync(f, base);
  assert.equal(cc.snapshotFiles(['a.js'], root).saved, 1);

  fs.writeFileSync(f, base.replace('// valida al usuario', '// comentario nuevo'));
  assert.equal(cc.classifyFile('a.js', root).level, 'COSMETIC');

  fs.writeFileSync(f, base.replace('return false', 'return true'));
  const sem = cc.classifyFile('a.js', root);
  assert.equal(sem.level, 'SEMANTIC');
  assert.equal(cc.allCosmetic(['a.js'], root), false, 'el validador de conocimiento no lo suprime');

  fs.writeFileSync(f, base.replace('return false;', 'return false; {'));
  assert.equal(cc.classifyFile('a.js', root).level, 'UNKNOWN', 'parse fallido nunca COSMETIC');

  const d = cc.classifyUpdate([{ file: 'a.js', level: 'SEMANTIC' }], 10);
  assert.notEqual(d.action, 'SKIP');
});
