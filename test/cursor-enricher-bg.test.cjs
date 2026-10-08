'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const GRAFO = path.join(__dirname, '..', '.agentic', 'grafo');

test('cursor: una tarea lanza el enricher desacoplado (efectos reales), una pregunta no', async () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'cur-'));
  const g = path.join(t, '.agentic', 'grafo');
  fs.mkdirSync(g, { recursive: true });
  fs.copyFileSync(path.join(GRAFO, 'host-guard.cjs'), path.join(g, 'host-guard.cjs'));
  fs.writeFileSync(path.join(g, 'context-enricher.cjs'), "require('fs').writeFileSync(process.cwd() + '/marca.txt', process.argv[2]);");
  const env0 = process.env.AKDD_NO_ENRICHER_BG;
  delete process.env.AKDD_NO_ENRICHER_BG;
  try {
    const guard = require(path.join(g, 'host-guard.cjs'));
    const r = guard.enriquecerEnSegundoPlano(t, 'aa: arregla el login en src/auth.ts');
    assert.strictEqual(r.lanzado, true);
    const marca = path.join(t, 'marca.txt');
    for (let i = 0; i < 60 && !fs.existsSync(marca); i++) await new Promise((x) => setTimeout(x, 100));
    assert.ok(fs.existsSync(marca), 'el enricher corrió en segundo plano');
    assert.strictEqual(fs.readFileSync(marca, 'utf8'), 'arregla el login en src/auth.ts', 'sin el prefijo aa:');
    process.env.AKDD_NO_ENRICHER_BG = '1';
    assert.strictEqual(guard.enriquecerEnSegundoPlano(t, 'x').lanzado, false, 'apagable');
  } finally {
    if (env0 === undefined) delete process.env.AKDD_NO_ENRICHER_BG; else process.env.AKDD_NO_ENRICHER_BG = env0;
    fs.rmSync(t, { recursive: true, force: true });
  }
});
