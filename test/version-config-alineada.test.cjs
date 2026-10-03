'use strict';
/* `npm version patch` cambia package.json, no la VERSION de config.md. En
 * 3.20.1 eso dejó la barrera de release en rojo (03/10/2026). sync-version
 * (el script "version" de npm) ahora alinea config.md en el mismo paso. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sv = require('../scripts/sync-version.cjs');

function raiz(version, cfgVersion) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-ver-'));
  fs.mkdirSync(path.join(r, '.agentic', 'grafo'), { recursive: true });
  fs.writeFileSync(path.join(r, 'package.json'), JSON.stringify({ name: 'agentic-kdd', version }));
  fs.writeFileSync(path.join(r, '.agentic', 'config.md'), `# Config\nVERSION: ${cfgVersion}\nCONFIGURADO: SI\nNombre: x\n`);
  return r;
}

test('version: escribir() alinea la VERSION de config.md con package.json y no toca lo demás', () => {
  const r = raiz('3.20.1', '3.20.0');
  sv.escribir(r);
  const cfg = fs.readFileSync(path.join(r, '.agentic', 'config.md'), 'utf8');
  assert.equal(cfg, '# Config\nVERSION: 3.20.1\nCONFIGURADO: SI\nNombre: x\n');
  assert.equal(JSON.parse(fs.readFileSync(path.join(r, '.agentic', 'grafo', 'framework.json'), 'utf8')).version, '3.20.1');
});

test('version: sin config.md no falla; ya alineado no reescribe', () => {
  const r = raiz('1.2.3', '1.2.3');
  const f = path.join(r, '.agentic', 'config.md');
  const antes = fs.statSync(f).mtimeMs;
  sv.escribir(r);
  assert.equal(fs.statSync(f).mtimeMs, antes);
  fs.rmSync(f);
  assert.doesNotThrow(() => sv.escribir(r));
});

test('version: el script "version" de npm incluye config.md en el commit', () => {
  const s = require('../package.json').scripts.version;
  assert.match(s, /\.agentic\/config\.md/);
});
