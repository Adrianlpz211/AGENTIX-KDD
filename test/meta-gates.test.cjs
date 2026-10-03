'use strict';

/* P20 — meta-tests: el fallo se siembra en el GATE, no en el producto. Cada
   mutante va sobre una copia del motor en una carpeta temporal (el original
   no se toca) y la prueba negativa de ese control tiene que ponerse roja. La
   misma prueba sobre la copia sin mutar tiene que pasar: así se sabe que el
   rojo lo causa la mutación y no la copia. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');

/** El catálogo es exportable: el benchmark lo usa para su denominador. */
const MUTANTES = [
  { id: 'GATE-EXIT', archivo: 'tdd-gate.cjs', busca: "else if (exitCode !== 0) { status = 'FAIL'; reason = 'RUNNER_EXIT_NONZERO'; }", pone: "else if (false) { status = 'FAIL'; reason = 'RUNNER_EXIT_NONZERO'; }", prueba: 'preservacion-escenarios.test.cjs', patron: 'P01: vac' },
  { id: 'GATE-CACHE-VIEJA', archivo: 'evidence-cache.cjs', busca: "function buscar(root, q, { ahora = Date.now() } = {}) {", pone: "function buscar(root, q, { ahora = Date.now() } = {}) {\n  return { hit: true, entrada: { resultado: { status: 'PASS' } }, motivo: 'IDENTICO' };", prueba: 'preservacion-p14-c10.test.cjs', patron: 'P15: LOW en auth' },
  { id: 'GATE-REPLAY', archivo: 'regression-guard.cjs', busca: "event_id: `pres:${behavior.id}:${e.execution_id}`", pone: "event_id: `pres:${behavior.id}:${e.execution_id}:${Math.random()}`", prueba: 'preservacion-escenarios.test.cjs', patron: 'P05: un replay' },
  { id: 'GATE-RESTORE-HASH', archivo: 'restore-manager.cjs', busca: 'if (!expected_current_hash || expected_current_hash !== p.expected_current_hash) return', pone: 'if (false) return', prueba: 'restore.test.cjs', patron: 'hash cambiado tras el preview' },
  { id: 'GATE-PAYLOAD', archivo: 'host-guard.cjs', busca: "const PAYLOAD_INVALIDO = { decision: DENY,", pone: "const PAYLOAD_INVALIDO = { decision: 'allow',", prueba: 'preservacion-p14-c10.test.cjs', patron: 'P16: stdin' },
  { id: 'GATE-EVIDENCIA-AJENA', archivo: 'teams-adapters.cjs', busca: 'const gates = verificador(res) || [];', pone: 'const gates = (res.evidence && res.evidence.length ? res.evidence : null) || verificador(res) || [];', prueba: 'preservacion-p14-c10.test.cjs', patron: 'C08: TEAMS no acepta' },
];

function copia(m) {
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-meta-'));
  fs.cpSync(path.join(REPO, '.agentic', 'grafo'), path.join(dst, '.agentic', 'grafo'), { recursive: true });
  fs.mkdirSync(path.join(dst, 'test'));
  fs.copyFileSync(path.join(REPO, 'test', m.prueba), path.join(dst, 'test', m.prueba));
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(dst, 'package.json'));
  return dst;
}

function correr(dst, m) {
  const env = Object.assign({}, process.env, { NODE_PATH: path.join(REPO, 'node_modules') });
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--test', `--test-name-pattern=${m.patron}`, path.join('test', m.prueba)], { cwd: dst, env, encoding: 'utf8', timeout: 240000, windowsHide: true });
  const pasaron = Number((/ℹ pass (\d+)/.exec(r.stdout || '') || [])[1] || 0);
  return { status: r.status, pasaron, salida: (r.stdout || '').slice(-1500) };
}

for (const m of MUTANTES) {
  test(`P20 ${m.id}: sembrado en ${m.archivo}, la prueba negativa lo detecta`, { timeout: 300000 }, () => {
    const fuente = fs.readFileSync(path.join(REPO, '.agentic', 'grafo', m.archivo), 'utf8');
    assert.ok(fuente.includes(m.busca), `el punto de mutación sigue existiendo en ${m.archivo}`);
    const dst = copia(m);
    try {
      const sano = correr(dst, m);
      assert.strictEqual(sano.status, 0, 'la copia sin mutar pasa: ' + sano.salida);
      assert.ok(sano.pasaron >= 1, 'el patrón seleccionó al menos una prueba');
      const f = path.join(dst, '.agentic', 'grafo', m.archivo);
      fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(m.busca, m.pone));
      const mut = correr(dst, m);
      assert.notStrictEqual(mut.status, 0, `el mutante ${m.id} sobrevivió: ` + mut.salida);
    } finally {
      try { fs.rmSync(dst, { recursive: true, force: true }); } catch { /* temporal */ }
    }
  });
}

module.exports = { MUTANTES };
