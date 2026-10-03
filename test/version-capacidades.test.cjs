'use strict';

/* H30 — versión única, documentos derivados sin contadores fijos, y la
   distinción instalado / cableado / ejecutado / verificado. */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const sv = require('../scripts/sync-version.cjs');
const cap = require('../.agentic/grafo/capabilities.cjs');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-h30-')); }
function escribir(raiz, rel, texto) {
  const f = path.join(raiz, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, texto);
  return f;
}

test('H30: el servidor MCP y el CLI anuncian la misma versión que package.json', () => {
  const pkg = require('../package.json');
  const inv = sv.inventario(RAIZ);
  assert.strictEqual(inv.version_mcp, pkg.version, 'serverInfo.version del MCP');
  const cli = spawnSync(process.execPath, [path.join(RAIZ, 'bin', 'akdd.js'), '--version'], { encoding: 'utf8' });
  assert.strictEqual(cli.stdout.trim(), pkg.version);
  assert.ok(inv.herramientas_mcp > 0, 'el conteo sale del servidor, no de un número escrito');
});

test('H30: el repo no tiene deriva (lo que corre el CI)', () => {
  const r = sv.check(RAIZ);
  assert.ok(r.ok, r.problemas.join('\n'));
});

test('H30: manifiesto desfasado y contador fijo en un derivado se detectan', () => {
  const raiz = tmp();
  escribir(raiz, 'package.json', JSON.stringify({ name: 'agentic-kdd', version: '9.9.9' }));
  escribir(raiz, '.agentic/grafo/framework.json', JSON.stringify({ name: 'agentic-kdd', version: '1.0.0', schema: {} }));
  escribir(raiz, 'AGENTS.md', '- `.agentic/grafo/` — 38 Node.js modules\n');
  const r = sv.check(raiz, { mcp: false });
  assert.strictEqual(r.ok, false);
  assert.ok(r.problemas.some((p) => /framework\.json desfasado/.test(p)));
  assert.ok(r.problemas.some((p) => /AGENTS\.md:1/.test(p)));

  sv.escribir(raiz);
  fs.writeFileSync(path.join(raiz, 'AGENTS.md'), '- `.agentic/grafo/` — engine modules\n');
  assert.ok(sv.check(raiz, { mcp: false }).ok, 'regenerado y sin contador: verde');
});

test('H30: harness presente pero desconectado = wired:false (import, mención y test no cuentan)', () => {
  const raiz = tmp();
  escribir(raiz, '.agentic/grafo/harness.cjs', 'module.exports = { ejecutarPaso() {} };\n');
  escribir(raiz, '.agentic/grafo/health-check.cjs', "require(require('path').join(__dirname, 'harness.cjs'));\n");
  escribir(raiz, '.agentic/grafo/autonomous-decision.cjs', "const SENSITIVE = ['collab-manager', 'harness'];\n");
  escribir(raiz, '.agentic/grafo/otro.cjs', "// require('./harness.cjs')\n/* 'harness.cjs' */\nmodule.exports = 1;\n");
  escribir(raiz, 'bin/akdd.js', "require('../.agentic/grafo/otro.cjs');\n");
  escribir(raiz, 'test/h.test.cjs', "require('../.agentic/grafo/harness.cjs');\n");

  let r = cap.analizar(raiz, { modulos: ['harness.cjs'] }).modulos[0];
  assert.strictEqual(r.installed, true);
  assert.strictEqual(r.wired, false, JSON.stringify(r));
  assert.strictEqual(r.verified, false);

  escribir(raiz, '.agentic/grafo/pipeline-controller.cjs', "const harness = require('./harness.cjs');\n");
  escribir(raiz, 'bin/akdd.js', "const s = 'src/**/*.ts';\nrequire('../.agentic/grafo/pipeline-controller.cjs');\n");
  r = cap.analizar(raiz, { modulos: ['harness.cjs'] }).modulos[0];
  assert.strictEqual(r.wired, true, 'alcanzable desde el CLI vía pipeline-controller');
  assert.strictEqual(r.via, '.agentic/grafo/pipeline-controller.cjs');
});

test('H30: verificado exige test que pasó DESPUÉS del último cambio del módulo', () => {
  const raiz = tmp();
  const mod = escribir(raiz, '.agentic/grafo/x.cjs', 'module.exports = 1;\n');
  escribir(raiz, 'test/x.test.cjs', "require('../.agentic/grafo/x.cjs');\n");
  const corrida = (ts, pass, fail) => escribir(raiz, '.agentic/_cache/test-run.json',
    JSON.stringify({ ts, status: fail ? 1 : 0, archivos: { 'test/x.test.cjs': { pass, fail, skip: 0 } } }));

  corrida(new Date(Date.now() + 60000).toISOString(), 3, 0);
  assert.strictEqual(cap.analizar(raiz, { modulos: ['x.cjs'] }).modulos[0].verified, true);

  corrida(new Date(Date.now() + 60000).toISOString(), 2, 1);
  assert.strictEqual(cap.analizar(raiz, { modulos: ['x.cjs'] }).modulos[0].verified, false, 'un fallo no verifica');

  corrida(new Date(Date.now() - 3600000).toISOString(), 3, 0);
  fs.utimesSync(mod, new Date(), new Date());
  const r = cap.analizar(raiz, { modulos: ['x.cjs'] }).modulos[0];
  assert.strictEqual(r.verified, false);
  assert.match(r.verificacion, /cambió después/);
});

test('H30: sin fuente de huella, ejecutado es desconocido (null), no false', () => {
  const raiz = tmp();
  escribir(raiz, '.agentic/grafo/y.cjs', 'module.exports = 1;\n');
  const r = cap.analizar(raiz, { modulos: ['y.cjs'] }).modulos[0];
  assert.strictEqual(r.executed, null);
});

test('H30: TEAMS, restauración y WhatsApp no se anuncian sin módulo integrado', () => {
  const raiz = tmp();
  escribir(raiz, '.agentic/grafo/y.cjs', 'module.exports = 1;\n');
  const p = cap.analizar(raiz).pendientes;
  for (const id of ['teams', 'restore', 'whatsapp']) {
    assert.strictEqual(p.find((x) => x.id === id).estado, 'no_integrada');
  }
});
