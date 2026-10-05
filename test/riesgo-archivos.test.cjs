'use strict';
/* La predicción de riesgo dejó de ser casi siempre MEDIO (glowly, 05/10/2026: 54 de 60). Causas: (1) el piso «contexto de confianza BAJA»
   subía el riesgo aunque TODA la memoria estuviera en BAJA, y (2) el motor de predicción nunca recibía archivos. Ahora el nivel sale de la
   evidencia sobre los archivos que la tarea nombra (dependientes en el AST, comportamientos protegidos selectivos, errores registrados). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { crearFixture, REPO } = require('./fixtures/dashboard-fixture.cjs');
const ra = require(path.join(REPO, '.agentic', 'grafo', 'riesgo-archivos.cjs'));

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-riesgo-' + p + '-'));

function baseConMuchosDependientes(dir, { dependientes = 40, archivo = 'lib\\core\\nucleo.ts' } = {}) {
  const db = new DatabaseSync(path.join(dir, '.agentic', 'memoria.db'));
  const ins = db.prepare("INSERT INTO ast_edges (from_file, to_file, kind, weight) VALUES (?, ?, 'imports', 1)");
  for (let i = 0; i < dependientes; i++) ins.run('src\\mod' + i + '.ts', archivo);
  db.close();
}

test('RIESGO-1 — archivosDeTexto: saca rutas de archivos del texto, no URLs ni versiones, con :línea y sin duplicar', () => {
  const t = 'Tocar lib/utils/ics.ts:12 y app\\api\\citas\\route.ts; ver https://ejemplo.com/a/b.js, v1.2.3 y lib/utils/ics.ts otra vez. También docs/guia.md.';
  const a = ra.archivosDeTexto(t);
  assert.ok(a.includes('lib/utils/ics.ts'));
  assert.ok(a.includes('app/api/citas/route.ts'), 'barras de Windows normalizadas');
  assert.ok(a.includes('docs/guia.md'));
  assert.equal(a.filter((x) => x === 'lib/utils/ics.ts').length, 1);
  assert.ok(!a.some((x) => /ejemplo\.com|1\.2\.3/.test(x)), JSON.stringify(a));
});

test('RIESGO-2 — sin evidencia es BAJO; con muchos dependientes en el AST sube (MEDIO desde 8, ALTO desde 30)', () => {
  const dir = tmp('dep'); crearFixture(dir);
  const db = () => new DatabaseSync(path.join(dir, '.agentic', 'memoria.db'), { readOnly: true });
  let d = db();
  assert.equal(ra.evaluar(d, ['lib/core/nucleo.ts']).nivel, 'BAJO', 'archivo sin dependientes ni historia: BAJO'); d.close();
  baseConMuchosDependientes(dir, { dependientes: 10 });
  d = db(); const medio = ra.evaluar(d, ['lib/core/nucleo.ts']); d.close();
  assert.equal(medio.nivel, 'MEDIO'); assert.match(medio.razones[0], /lo importan 10 archivos/);
  baseConMuchosDependientes(dir, { dependientes: 30 });
  d = db(); const alto = ra.evaluar(d, ['lib/core/nucleo.ts']); d.close();
  assert.equal(alto.nivel, 'ALTO'); assert.match(alto.razones[0], /radio de explosión grande/);
  d = db(); assert.equal(ra.evaluar(d, ['otro/archivo.ts']).nivel, 'BAJO', 'otro archivo sigue BAJO'); d.close();
});

test('RIESGO-3 — un comportamiento protegido que lista TODO el repo como relacionado no es evidencia; uno selectivo sí', () => {
  const dir = tmp('pb'); crearFixture(dir);
  const w = new DatabaseSync(path.join(dir, '.agentic', 'memoria.db'));
  w.exec('CREATE TABLE IF NOT EXISTS protected_behaviors (id TEXT PRIMARY KEY, module TEXT, description TEXT, critical_flows TEXT, test_patterns TEXT, related_files TEXT, pass_count INTEGER, confidence TEXT, status TEXT, last_verified_at TEXT, created_at TEXT)');
  const todos = JSON.stringify(Array.from({ length: 677 }, (_, i) => 'src/f' + i + '.ts').concat(['lib/pagos/cobro.ts']));
  w.prepare("INSERT INTO protected_behaviors (id, module, related_files, confidence, status) VALUES ('pb_todo', 'todo', ?, 'MEDIA', 'active')").run(todos);
  w.close();
  let d = new DatabaseSync(path.join(dir, '.agentic', 'memoria.db'), { readOnly: true });
  assert.equal(ra.evaluar(d, ['lib/pagos/cobro.ts']).nivel, 'BAJO', 'el comportamiento que lista 678 archivos no discrimina'); d.close();
  const w2 = new DatabaseSync(path.join(dir, '.agentic', 'memoria.db'));
  w2.prepare("INSERT INTO protected_behaviors (id, module, related_files, confidence, status) VALUES ('pb_cobro', 'pagos', ?, 'ALTA', 'active')").run(JSON.stringify(['lib/pagos/cobro.ts', 'lib/pagos/iva.ts']));
  w2.close();
  d = new DatabaseSync(path.join(dir, '.agentic', 'memoria.db'), { readOnly: true });
  const r = ra.evaluar(d, ['lib/pagos/cobro.ts']); d.close();
  assert.equal(r.nivel, 'ALTO', JSON.stringify(r)); assert.match(r.razones.join(' '), /comportamiento\(s\) protegido\(s\) lo tocan \(pagos\)/);
});

test('RIESGO-4 — memoriaDistingueConfianza: si TODO está en BAJA, la confianza BAJA no sube el riesgo', () => {
  const dir = tmp('conf'); crearFixture(dir);
  const w = new DatabaseSync(path.join(dir, '.agentic', 'memoria.db'));
  w.exec("UPDATE nodos SET confianza = 'BAJA'"); w.close();
  let d = new DatabaseSync(path.join(dir, '.agentic', 'memoria.db'), { readOnly: true });
  assert.equal(ra.memoriaDistingueConfianza(d), false); d.close();
  const w2 = new DatabaseSync(path.join(dir, '.agentic', 'memoria.db'));
  w2.exec("UPDATE nodos SET confianza = 'ALTA' WHERE id = (SELECT MIN(id) FROM nodos)"); w2.close();
  d = new DatabaseSync(path.join(dir, '.agentic', 'memoria.db'), { readOnly: true });
  assert.equal(ra.memoriaDistingueConfianza(d), true); d.close();
});

test('RIESGO-5 — el enricher de punta a punta: memoria toda en BAJA + tarea sin archivos → no es MEDIO por inercia; con un archivo de radio grande → ALTO', () => {
  const dir = tmp('enr'); crearFixture(dir, { esquemaCompleto: true });
  const w = new DatabaseSync(path.join(dir, '.agentic', 'memoria.db'));
  w.exec("UPDATE nodos SET confianza = 'BAJA'"); w.close();
  baseConMuchosDependientes(dir, { dependientes: 35 });
  const correr = (tarea) => {
    const r = spawnSync(process.execPath, [path.join(REPO, '.agentic', 'grafo', 'context-enricher.cjs'), tarea], { cwd: dir, encoding: 'utf8', windowsHide: true });
    return r.stdout;
  };
  const sinArchivos = correr('Validar la cantidad entera en pedidos');
  assert.match(sinArchivos, /Riesgo estimado:\*\*\s*BAJO/, 'antes: MEDIO por el piso de confianza BAJA aunque toda la memoria lo fuera\n' + sinArchivos.slice(0, 500));
  const conArchivo = correr('Refactorizar lib/core/nucleo.ts para pedidos');
  assert.match(conArchivo, /Riesgo estimado:\*\*\s*ALTO/, conArchivo.slice(0, 600));
  assert.match(conArchivo, /Riesgo por archivo: lib\/core\/nucleo\.ts: lo importan 35 archivos/);
});

test('RIESGO-6 — el post-cycle rotula ciclos.ast_indexed cuando indexa el AST (la columna existía y nadie la escribía)', () => {
  const pc = fs.readFileSync(path.join(REPO, '.agentic', 'grafo', 'post-cycle.cjs'), 'utf8');
  const i = pc.indexOf('results.ast = indexarAst();');
  assert.ok(i > 0);
  assert.match(pc.slice(i, i + 800), /UPDATE ciclos SET ast_indexed = 1 WHERE ciclo_id = \?/);
});
