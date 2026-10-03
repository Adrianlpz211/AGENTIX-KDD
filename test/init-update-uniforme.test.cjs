'use strict';

/* H26 — init y update usan el mismo manifiesto, no siembran la memoria del
   repo de Agentix, conservan lo del usuario, son idempotentes y health ve la
   deriva. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const { copyAgenticFiles, leerBanderas } = require('../src/init.js');
const { update } = require('../src/update.js');
const txm = require('../src/update-tx.js');
const manifest = require('../src/managed-manifest.js');
const { createTarGz, EXCLUIR_ESTADO_VOLATIL } = require('../src/tar-extract.js');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
function escribir(base, rel, texto) {
  const f = path.join(base, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, texto);
  return f;
}
const leer = (base, rel) => fs.readFileSync(path.join(base, rel), 'utf8');
const silencio = async (fn) => {
  const log = console.log; const err = console.error;
  console.log = () => {}; console.error = () => {};
  try { return await fn(); } finally { console.log = log; console.error = err; }
};

test('H26: init no siembra memoria, specs, conocimiento, PLAN ni docs del repo de Agentix', () => {
  const p = tmp('akdd-init-');
  copyAgenticFiles(RAIZ, p);

  for (const f of ['errores', 'patrones', 'decisiones', 'trabajo']) {
    assert.strictEqual(leer(p, `.agentic/memoria/${f}.md`), leer(RAIZ, `templates/seed/.agentic/memoria/${f}.md`), `${f}.md es la semilla genérica`);
  }
  const conEntradas = leer(RAIZ, '.agentic/memoria/decisiones.md').replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(/^## /m.test(conEntradas), 'el repo sí tiene decisiones propias (si no, la prueba no prueba nada)');
  assert.ok(!/^## /m.test(leer(p, '.agentic/memoria/decisiones.md').replace(/<!--[\s\S]*?-->/g, '')));
  assert.deepStrictEqual(fs.readdirSync(path.join(p, '.agentic/specs')), ['.gitkeep']);
  assert.ok(!fs.existsSync(path.join(p, 'docs')), 'docs/ del repo no viaja');
  assert.ok(!fs.existsSync(path.join(p, '.agentic/memoria.db')));
  assert.ok(fs.existsSync(path.join(p, '.agentic/grafo/grafo.cjs')) && fs.existsSync(path.join(p, '.cursor/rules/agentic.mdc')));
});

test('H26: init conserva lo que el proyecto ya tenía (respaldo + instrucciones propias)', () => {
  const p = tmp('akdd-init-');
  escribir(p, 'CLAUDE.md', '# Mis reglas\n\nNo tocar facturas.\n');
  escribir(p, '.cursor/mcp.json', '{"mio":true}');
  escribir(p, '.cursor/rules/propia.mdc', 'regla mía');
  escribir(p, '.agentic/memoria/patrones.md', '# mis patrones\n');

  const r = copyAgenticFiles(RAIZ, p);
  assert.deepStrictEqual(r.respaldados, ['CLAUDE.md']);
  assert.strictEqual(leer(p, 'CLAUDE.md.agentix-backup'), '# Mis reglas\n\nNo tocar facturas.\n');
  assert.match(leer(p, '.agentic/INSTRUCCIONES-PROYECTO.md'), /No tocar facturas/);
  assert.match(leer(p, 'CLAUDE.md'), /PRIORIDAD ABSOLUTA[\s\S]*No tocar facturas/, 'plantilla + lo del usuario debajo');
  assert.strictEqual(leer(p, '.cursor/mcp.json'), '{"mio":true}');
  assert.strictEqual(leer(p, '.cursor/rules/propia.mdc'), 'regla mía');
  assert.strictEqual(leer(p, '.agentic/memoria/patrones.md'), '# mis patrones\n', 'la semilla no pisa lo existente');
});

test('H26: una sola lista managed para init y update', () => {
  const src = fs.readFileSync(path.join(RAIZ, 'src', 'init.js'), 'utf8') + fs.readFileSync(path.join(RAIZ, 'src', 'update-tx.js'), 'utf8');
  assert.match(src, /manifest\.archivos\(/);
  assert.doesNotMatch(fs.readFileSync(path.join(RAIZ, 'src', 'init.js'), 'utf8'), /rootFiles|copyDocsFiltered|'memoria', 'specs', 'conocimiento'\]\s*;\s*\n\s*for[\s\S]{0,80}copySync\(src/);
  assert.ok(manifest.esManaged('.agentic/grafo/x.cjs'));
  assert.ok(!manifest.esManaged('.agentic/memoria/patrones.md'));
  assert.ok(!manifest.esManaged('.agentic/grafo/post-cycle.log'));
  assert.ok(!manifest.esManaged('.cursor/mcp.json'));
  const b = leerBanderas(['--yes', '--ref=v3.18.1', '--deps']);
  assert.strictEqual(b.ref, 'v3.18.1'); assert.strictEqual(b.deps, true); assert.strictEqual(b.browser, false);
});

test('H26: post-cycle no instala dependencias al cerrar un ciclo', () => {
  const src = fs.readFileSync(path.join(RAIZ, '.agentic', 'grafo', 'post-cycle.cjs'), 'utf8');
  assert.doesNotMatch(src, /npm install better-sqlite3 --save/);
  assert.doesNotMatch(fs.readFileSync(path.join(RAIZ, 'src', 'update.js'), 'utf8'), /'install', 'playwright-core'/);
});

test('H26: update conserva config y hooks del usuario, el segundo no cambia nada, health ve la deriva', { timeout: 300000 }, async () => {
  const dir = tmp('akdd-pack-');
  const tar = path.join(dir, 'repo.tar.gz');
  createTarGz(tar, path.dirname(RAIZ), path.basename(RAIZ), EXCLUIR_ESTADO_VOLATIL, { timeout: 180000 });

  const p = tmp('akdd-proj-');
  escribir(p, '.agentic/config.md', '# Config\n\nCONFIGURADO: SI\nNombre: clinica\n\n## Reglas del proyecto\n- precios en bolívares\n');
  execFileSync('git', ['init', '-q'], { cwd: p });
  const hook = escribir(p, '.git/hooks/pre-commit', '#!/bin/sh\necho hook-del-usuario\n');

  const r1 = await silencio(() => update({ projectPath: p, archivo: tar, salir: false }));
  assert.ok(r1.ok, r1.message);
  assert.strictEqual(fs.readFileSync(hook, 'utf8'), '#!/bin/sh\necho hook-del-usuario\n', 'hook ajeno intacto');
  assert.match(leer(p, '.agentic/config.md'), /CONFIGURADO: SI[\s\S]*Nombre: clinica[\s\S]*precios en bolívares/);

  const r2 = await silencio(() => update({ projectPath: p, archivo: tar, salir: false }));
  assert.ok(r2.ok);
  assert.deepStrictEqual(r2.escritos, [], 'segundo update idempotente');

  const hc = require(path.join(p, '.agentic', 'grafo', 'health-check.cjs'));
  const drift = () => hc.CHECKS.find((c) => c.id === 'framework_drift').check(p);
  assert.strictEqual(drift().ok, true, drift().msg);
  fs.appendFileSync(path.join(p, '.agentic/grafo/grafo.cjs'), '\n// cambio local\n');
  fs.rmSync(path.join(p, 'dashboard.cjs'));
  const d = drift();
  assert.strictEqual(d.ok, false);
  assert.match(d.msg, /1 cambiado\(s\): \.agentic\/grafo\/grafo\.cjs/);
  assert.match(d.msg, /1 faltante\(s\): dashboard\.cjs/);

  assert.ok(!fs.existsSync(path.join(p, '.agentic/memoria')), 'update no siembra ni toca memoria');
  assert.ok(!fs.existsSync(path.join(p, '.agentic/specs')) && !fs.existsSync(path.join(p, 'docs')));
  assert.strictEqual(typeof txm.ownedPath(p), 'string');
});
