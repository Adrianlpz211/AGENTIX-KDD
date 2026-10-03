#!/usr/bin/env node
'use strict';

/**
 * `node --check` sobre todos los .cjs del repo, igual en Windows y en Linux.
 * El CI usaba `find` + bash, que no existe en un runner de Windows.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const IGNORAR = new Set(['node_modules', '.git', '_output']);

function recorrer(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORAR.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) recorrer(p, out);
    else if (e.name.endsWith('.cjs')) out.push(p);
  }
  return out;
}

const archivos = recorrer(RAIZ, []);
const malos = [];
for (const f of archivos) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) malos.push({ f: path.relative(RAIZ, f), err: (r.stderr || '').split('\n').slice(0, 4).join('\n') });
}

if (malos.length) {
  for (const m of malos) console.error('❌ ' + m.f + '\n' + m.err);
  process.exit(1);
}
console.log('✅ ' + archivos.length + ' archivos .cjs pasan node --check');
