'use strict';
/* El empaquetado del checkout (H26, update-e2e) corre mientras otros tests
 * escriben estado en .agentic/. GNU tar avisa "file changed as we read it" y
 * sale con 1 aunque el archivo esté completo. Esa salida NO es un fallo de la
 * barrera; un error real de tar (código 2, otro mensaje) sí lo sigue siendo. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { avisoTolerable, EXCLUIR_ESTADO_VOLATIL, createTarGz, listarTarGz } = require('../src/tar-extract.js');

const err = (status, stderr) => Object.assign(new Error('tar terminó con código ' + status), { status, stderr: Buffer.from(stderr) });

test('tar: "file changed as we read it" con código 1 se tolera', () => {
  assert.equal(avisoTolerable(err(1, 'tar: AGENTIX/.agentic: file changed as we read it\n')), true);
  assert.equal(avisoTolerable(err(1, 'tar: a/x: file changed as we read it\ntar: Exiting with failure status due to previous errors\n')), true);
});

test('tar: un error real nunca se tolera', () => {
  assert.equal(avisoTolerable(err(2, 'tar: AGENTIX: Cannot stat: No such file or directory\n')), false, 'código 2 es fatal');
  assert.equal(avisoTolerable(err(1, 'tar: Cannot open: Permission denied\n')), false, 'otro mensaje con código 1');
  assert.equal(avisoTolerable(err(1, 'tar: a: file changed as we read it\ntar: b: Cannot open: Permission denied\n')), false, 'mezcla: manda el error');
  assert.equal(avisoTolerable(err(1, '')), false, 'código 1 mudo no se asume benigno');
  assert.equal(avisoTolerable(null), false);
});

test('tar: la lista de estado volátil no toca lo managed y sí deja fuera lo que cambia solo', () => {
  const { archivos } = require('../src/managed-manifest');
  const managed = archivos(path.resolve(__dirname, '..'));
  for (const rel of managed) {
    for (const seg of rel.split('/')) assert.ok(!EXCLUIR_ESTADO_VOLATIL.includes(seg), rel + ' es managed y quedaría excluido por ' + seg);
  }
  for (const n of ['memoria.db', 'memoria.db-wal', 'telemetria', '_executions', '_output', 'node_modules']) assert.ok(EXCLUIR_ESTADO_VOLATIL.includes(n), 'falta ' + n);
});

test('tar: createTarGz con la lista deja fuera el estado y conserva el framework', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-tar-'));
  const w = (rel, txt) => { const f = path.join(dir, 'proj', rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, txt); };
  w('.agentic/grafo/grafo.cjs', '// motor\n');
  w('_LOCKS.md', '# locks\n');
  w('.agentic/memoria.db', 'x');
  w('.agentic/telemetria/trace_1.jsonl', '{}');
  w('.agentic/_executions/e1.json', '{}');
  w('_output/log.md', 'x');
  const tar = path.join(dir, 'p.tar.gz');
  createTarGz(tar, dir, 'proj', EXCLUIR_ESTADO_VOLATIL, { timeout: 60000 });
  const lista = listarTarGz(tar).map((l) => l.split(String.fromCharCode(92)).join('/'));
  assert.ok(lista.some((l) => l.endsWith('.agentic/grafo/grafo.cjs')));
  assert.ok(lista.some((l) => l.endsWith('_LOCKS.md')), '_LOCKS.md es managed y viaja');
  for (const fuera of ['memoria.db', 'telemetria', '_executions', '_output']) assert.ok(!lista.some((l) => l.includes(fuera)), fuera + ' no debía viajar');
  fs.rmSync(dir, { recursive: true, force: true });
});
