'use strict';
/* La 3.20.0 publicó .agentic/grafo/post-cycle.log (log de la máquina que
 * publicó): "files" incluye .agentic/grafo/ entero y manda sobre el
 * .npmignore de la raíz. Se excluye en "files" y el release check rechaza .log. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const RAIZ = path.resolve(__dirname, '..');

test('paquete: "files" excluye los .log de .agentic/grafo', () => {
  const files = require(path.join(RAIZ, 'package.json')).files;
  assert.ok(files.includes('.agentic/grafo/'), 'la carpeta del motor sigue incluida');
  assert.ok(files.includes('!.agentic/grafo/*.log'), 'falta la exclusión de logs');
});

test('paquete: el release check rechaza cualquier .log como dato privado', () => {
  const src = fs.readFileSync(path.join(RAIZ, 'scripts', 'release-check.cjs'), 'utf8');
  const m = src.match(/const bad=packed\.files\.filter\(f=>(\/.*\/)\.test\(f\.path\)\)/);
  assert.ok(m, 'no encontré la regex de privacidad');
  const re = eval(m[1]); // eslint-disable-line no-eval -- literal del propio repo
  assert.ok(re.test('.agentic/grafo/post-cycle.log'));
  assert.ok(!re.test('.agentic/grafo/grafo.cjs'));
});

test('paquete: npm pack real no trae ningún .log', { timeout: 120000 }, () => {
  const out = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], { cwd: RAIZ, encoding: 'utf8', shell: process.platform === 'win32' });
  const lista = JSON.parse(out)[0].files.map((f) => f.path);
  assert.deepEqual(lista.filter((p) => p.endsWith('.log')), []);
});
