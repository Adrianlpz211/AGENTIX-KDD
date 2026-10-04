'use strict';
/* H03 "Docs": los comandos que el README documenta existen. No se anuncian funciones planificadas como operativas. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'akdd.js');
const memoriaCli = fs.readFileSync(path.join(ROOT, '.agentic', 'grafo', 'memory-cli.cjs'), 'utf8');
const bin = fs.readFileSync(BIN, 'utf8');

/** Líneas `akdd <grupo> <sub> ...` dentro de bloques de código de un README. */
function comandos(readme, grupo) {
  const out = [];
  let dentro = false;
  for (const l of fs.readFileSync(path.join(ROOT, readme), 'utf8').split(/\r?\n/)) {
    if (/^```/.test(l)) { dentro = !dentro; continue; }
    if (!dentro) continue;
    const m = new RegExp('^akdd ' + grupo + ' ([a-z][\\w-]*)').exec(l.trim());
    if (m) out.push(m[1]);
  }
  return [...new Set(out)];
}

for (const readme of ['README.md', 'README.es.md']) {
  test('comandos documentados (' + readme + '): akdd memory solo usa subcomandos que existen', () => {
    const subs = comandos(readme, 'memory');
    assert.ok(subs.length >= 10, 'el README documenta los comandos de memoria');
    for (const s of subs) assert.ok(new RegExp("case '" + s + "'").test(memoriaCli), 'akdd memory ' + s + ' no existe en memory-cli.cjs');
  });

  test('comandos documentados (' + readme + '): context, effort budget y benchmark contexto existen en la CLI', () => {
    for (const s of comandos(readme, 'context')) assert.ok(bin.includes("'" + s + "'") || bin.includes('arg1 === \'' + s + '\''), 'akdd context ' + s);
    assert.match(bin, /sub === 'budget'/);
    assert.match(bin, /arg1 === 'contexto'/);
    for (const s of comandos(readme, 'benchmark')) assert.equal(s, 'contexto');
    for (const s of comandos(readme, 'effort')) assert.ok(['decide', 'budget', 'reevaluar', 'show'].includes(s), 'akdd effort ' + s);
  });
}

test('comandos documentados: los módulos que la CLI invoca existen en el paquete', () => {
  for (const m of ['memory-cli.cjs', 'effort-budget.cjs', 'context-reuse.cjs', 'benchmark-contexto.cjs', 'context-compressor.cjs', 'memory-layers.cjs', 'memoria-salud.cjs']) {
    assert.ok(fs.existsSync(path.join(ROOT, '.agentic', 'grafo', m)), m);
  }
});

test('comandos documentados: la ayuda de la CLI lista lo nuevo y los comandos responden con su uso (no se anuncia lo inexistente)', () => {
  const h = spawnSync(process.execPath, [BIN, '--help'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  assert.match(h.stdout, /akdd memory status\|capabilities/);
  assert.match(h.stdout, /akdd benchmark contexto/);
  const u = spawnSync(process.execPath, [path.join(ROOT, '.agentic', 'grafo', 'memory-cli.cjs')], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  assert.equal(u.status, 2);
  assert.match(u.stderr, /status\|capabilities/);
});

test('comandos documentados: el README no promete lo que no existe (sin proxy instalado, sin ahorro de pensamiento interno)', () => {
  for (const readme of ['README.md', 'README.es.md']) {
    const t = fs.readFileSync(path.join(ROOT, readme), 'utf8');
    assert.match(t, /HOST_NATIVE_UNCONTROLLED/, readme);
    assert.match(t, /NO_EJECUTADO/, readme);
    assert.doesNotMatch(t, /akdd headroom|akdd claude-mem|install(a|s) Headroom/i, readme + ': no se anuncian comandos de terceros');
  }
});
