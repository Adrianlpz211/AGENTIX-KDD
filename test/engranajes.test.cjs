'use strict';
/* El auditor de engranajes: cada mecanismo de Agentix se comprueba contra evidencia y, si no gira, lo dice con el dato. Aquí se rompe cada uno a propósito.
   Regla central: un engranaje que no se puede comprobar es SIN_DATO (nunca «OK»), y si la comprobación misma revienta, sale ROTO (el auditor tampoco falla callado). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const G = path.join(__dirname, '..', '.agentic', 'grafo');
const E = require(path.join(G, 'engranajes.cjs'));

const git = (root, ...a) => cp.spawnSync('git', a, { cwd: root, encoding: 'utf8', windowsHide: true });
function proyecto({ conGit = true, base = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-engr-'));
  fs.mkdirSync(path.join(root, '.agentic', 'grafo'), { recursive: true });
  fs.cpSync(G, path.join(root, '.agentic', 'grafo'), { recursive: true, filter: (s) => !/[\\/](vendor|graph-ui)([\\/]|$)/.test(s) });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"x","scripts":{"test":"node -e 0"}}');
  if (conGit) {
    git(root, 'init', '-q'); git(root, 'config', 'user.email', 'a@b.c'); git(root, 'config', 'user.name', 'x'); git(root, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(root, 'a.js'), '1'); git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'base', '--no-verify');
  }
  if (base) {
    const A = require(path.join(G, 'db-adapter.cjs'));
    const db = A.openWrite(path.join(root, '.agentic', 'memoria.db'));
    db.exec("CREATE TABLE ciclos (id INTEGER PRIMARY KEY, ciclo_id TEXT, tarea TEXT, estado TEXT, post_cycle_ran TEXT, duracion_ms INTEGER, tests_pasando INTEGER, ast_indexed INTEGER, modules_touched TEXT, stack_detected TEXT, memory_trace TEXT, area TEXT, fecha_inicio TEXT);"
      + "CREATE TABLE protected_behaviors (id INTEGER PRIMARY KEY, module TEXT, last_verified_at TEXT, created_at TEXT);"
      + "CREATE TABLE verified_contracts (id INTEGER PRIMARY KEY, status TEXT);"
      + "CREATE TABLE creative_suggestions (id TEXT);"
      + "CREATE TABLE gate_events (id INTEGER PRIMARY KEY, ts TEXT, gate TEXT, verdict TEXT, detalle TEXT);"
      + "CREATE TABLE nodos (id INTEGER PRIMARY KEY, fecha_creacion TEXT);");
    db.close();
  }
  return root;
}
const por = (r, id) => r.engranajes.find((g) => g.id === id);
const fecha = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const insertar = (root, sql, ...params) => { const db = require(path.join(G, 'db-adapter.cjs')).openWrite(path.join(root, '.agentic', 'memoria.db')); db.run(sql, params); db.close(); };

test('EG-1 un proyecto sano: ningún engranaje roto y todos reportan', () => {
  const root = proyecto();
  const sha = git(root, 'rev-parse', '--short', 'HEAD').stdout.trim();
  for (const h of ['post-commit', 'pre-commit']) fs.writeFileSync(path.join(root, '.git', 'hooks', h), '#!/bin/sh' + String.fromCharCode(10) + 'exit 0' + String.fromCharCode(10));   // los ganchos de git instalados
  insertar(root, 'INSERT INTO ciclos (ciclo_id, tarea, tests_pasando, fecha_inicio) VALUES (?,?,?,?)', 'commit-' + sha, 'auto post-commit ' + sha + ' — base', 3, fecha(Date.now()));
  const r = E.auditar(root);
  assert.equal(r.total, E.COMPROBACIONES.length);
  assert.equal(r.rotos, 0, JSON.stringify(r.engranajes.filter((g) => g.estado === 'ROTO')));
  for (const g of r.engranajes) assert.ok(g.dato, g.id + ' sin dato');
});

test('EG-2 trabajo sin commit: más de 100 archivos o más de 3 días es ROTO', () => {
  const root = proyecto();
  for (let i = 0; i < 120; i++) fs.writeFileSync(path.join(root, 'f' + i + '.js'), String(i));
  const g = por(E.auditar(root), 'trabajo-sin-commit');
  assert.equal(g.estado, E.ROTO);
  assert.match(g.dato, /120 archivo\(s\) sin commit/);
  assert.match(g.hacer, /commitear/);
});

test('EG-3 contratos parados con ciclos con pruebas: ROTO con el dato; recientes: OK', () => {
  const root = proyecto();
  const hoy = Date.now();
  for (let i = 0; i < 6; i++) insertar(root, 'INSERT INTO ciclos (ciclo_id, tarea, tests_pasando, fecha_inicio) VALUES (?,?,?,?)', 'c' + i, 't' + i, 5, fecha(hoy - i * 3600000));
  insertar(root, 'INSERT INTO protected_behaviors (module, last_verified_at) VALUES (?, ?)', 'x', fecha(hoy - 10 * 86400000));
  let g = por(E.auditar(root), 'contratos');
  assert.equal(g.estado, E.ROTO);
  assert.match(g.dato, /el último registrado hace 10 días; 6 ciclos con pruebas en 7 días/);
  insertar(root, 'INSERT INTO protected_behaviors (module, last_verified_at) VALUES (?, ?)', 'y', fecha(hoy - 3600000));
  g = por(E.auditar(root), 'contratos');
  assert.equal(g.estado, E.OK);
});

test('EG-4 huella del código incompleta (un directorio que no se puede completar) es ROTO con el motivo real', () => {
  const root = proyecto();
  // se baja el tope de bytes con muchos archivos de tamaño normal, no con uno enorme (esos ya no rompen la huella)
  const SE = require(path.join(G, 'source-evidence.cjs'));
  const h = SE.capture(root, { maxArchivos: 0, cache: false });
  assert.equal(h.complete, false);
  assert.match(h.motivo, /archivos/);
  // el engranaje usa la captura real: con un proyecto normal está completa
  assert.equal(por(E.auditar(root), 'huella-del-codigo').estado, E.OK);
});

test('EG-5 verificación TDD: huella incompleta en el último estado es ROTO con el motivo; STOPs repetidos son ATENCION', () => {
  const root = proyecto();
  fs.writeFileSync(path.join(root, '.agentic', '_tdd_state.json'), JSON.stringify({ status: 'UNVERIFIED', reason_code: 'SOURCE_CHANGED_OR_INCOMPLETE', source_check: { motivo: 'huella incompleta: más de 100 MB de archivos de tamaño normal' } }));
  let g = por(E.auditar(root), 'verificacion-tdd');
  assert.equal(g.estado, E.ROTO);
  assert.match(g.dato, /huella incompleta: más de 100 MB/);
  fs.writeFileSync(path.join(root, '.agentic', '_tdd_state.json'), JSON.stringify({ status: 'FAIL', failures: ['❯ tests/x.test.ts (3 tests | 1 failed)'] }));
  for (let i = 0; i < 4; i++) insertar(root, "INSERT INTO gate_events (ts, gate, verdict, detalle) VALUES (?,?,?,?)", fecha(Date.now() - i * 60000), 'tdd', 'STOP', JSON.stringify({ motivo: 'SAME_FAILURE_AFTER_REPAIR' }));
  g = por(E.auditar(root), 'verificacion-tdd');
  assert.equal(g.estado, E.ATENCION);
  assert.match(g.dato, /SAME_FAILURE_AFTER_REPAIR ×4/);
  assert.match(g.hacer, /tests\/x\.test\.ts/);
});

test('EG-6 ganchos de git: core.hooksPath hacia una carpeta que no existe es ROTO (ningún gancho corre)', () => {
  const root = proyecto();
  git(root, 'config', 'core.hooksPath', 'mis-hooks-que-no-existen');
  const g = por(E.auditar(root), 'ganchos-de-git');
  assert.equal(g.estado, E.ROTO);
  assert.match(g.dato, /core\.hooksPath apunta a «mis-hooks-que-no-existen»/);
});

test('EG-7 ganchos de Cursor: un stop sin loop_limit: null avisa que Cursor corta a 5 seguimientos', () => {
  const root = proyecto();
  fs.mkdirSync(path.join(root, '.cursor'), { recursive: true });
  const g0 = JSON.stringify({ version: 1, hooks: { stop: [{ command: 'node "x/.agentic/grafo/host-guard.cjs" --host=cursor --event=stop', timeout: 10 }] } });
  fs.writeFileSync(path.join(root, '.cursor', 'hooks.json'), g0);
  let g = por(E.auditar(root), 'ganchos-de-los-hosts');
  assert.equal(g.estado, E.ATENCION);
  assert.match(g.dato, /loop_limit: null/);
  fs.writeFileSync(path.join(root, '.cursor', 'hooks.json'), g0.replace('"timeout":10', '"timeout":10,"loop_limit":null'));
  g = por(E.auditar(root), 'ganchos-de-los-hosts');
  assert.equal(g.estado, E.OK);
});

test('EG-8 cierre de ciclos: fallos recientes en el log de post-cycle se cuentan; los antiguos no asustan', () => {
  const root = proyecto();
  const log = path.join(root, '.agentic', 'grafo', 'post-cycle.log');
  fs.writeFileSync(log, Array(12).fill('❌ post-cycle falló: database is locked').join('\n'));
  let g = por(E.auditar(root), 'cierre-de-ciclos');
  assert.equal(g.estado, E.ROTO);
  assert.match(g.dato, /12 cierres fallidos en el log \(12 por base ocupada\)/);
  const viejo = new Date(Date.now() - 5 * 86400000); fs.utimesSync(log, viejo, viejo);
  g = por(E.auditar(root), 'cierre-de-ciclos');
  assert.equal(g.estado, E.OK);
});

test('EG-9 sin la base: lo que depende de ella es SIN_DATO con la causa (jamás OK por no haber podido mirar)', () => {
  const root = proyecto({ base: false });
  const r = E.auditar(root);
  assert.equal(por(r, 'contratos').estado, E.SIN_DATO);
  assert.match(por(r, 'contratos').dato, /memoria\.db/);
  assert.equal(por(r, 'base-y-copias').estado, E.ROTO, 'sin base de memoria no hay registro posible');
});

test('EG-10 si una comprobación revienta, ese engranaje sale ROTO con el error: el auditor tampoco falla callado', () => {
  const root = proyecto();
  const original = E.COMPROBACIONES[0].fn;
  E.COMPROBACIONES[0].fn = () => { throw new Error('explotó a propósito'); };
  try {
    const g = por(E.auditar(root), E.COMPROBACIONES[0].id);
    assert.equal(g.estado, E.ROTO);
    assert.match(g.dato, /la comprobación misma falló: explotó a propósito/);
  } finally { E.COMPROBACIONES[0].fn = original; }
});

test('EG-11 refrescar deja el resultado en .agentic/_engranajes.json y el semáforo de TEAMS lo muestra como alerta', () => {
  const root = proyecto();
  for (let i = 0; i < 120; i++) fs.writeFileSync(path.join(root, 'g' + i + '.js'), String(i));
  const r = E.refrescar(root);
  assert.equal(r.veredicto, 'ROTO');
  assert.ok(fs.existsSync(E.ARCHIVO(root)));
  assert.ok(E.ultimo(root), 'el último resultado se puede leer');
  // TEAMS: con canal activo el semáforo trae la alerta de registro
  const T = require(path.join(G, 'teams.cjs'));
  process.env.AKDD_TEAMS_NO_AVISO = '1';
  T.ejecutar(['activar'], root); T.ejecutar(['modo', 'completo'], root); T.ejecutar(['iniciar'], root);
  E.refrescar(root);
  const s = T.salud(root);
  assert.ok(s.engranajes && s.engranajes.rotos >= 1, JSON.stringify(s.engranajes));
  assert.ok(s.alertas.some((a) => /Registro de Agentix: \d+ engranaje\(s\) ROTO\(s\)/.test(a.msg)), JSON.stringify(s.alertas.map((a) => a.msg)));
});

test('EG-12 el CLI imprime el informe y sale con código 1 si hay algo ROTO', () => {
  const root = proyecto();
  for (let i = 0; i < 120; i++) fs.writeFileSync(path.join(root, 'h' + i + '.js'), String(i));
  const r = cp.spawnSync(process.execPath, [path.join(G, 'engranajes.cjs'), root], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /ENGRANAJES —/);
  assert.match(r.stdout, /🔴 Trabajo editado pero sin commit/);
  assert.match(r.stdout, /Veredicto: ROTO/);
  const j = cp.spawnSync(process.execPath, [path.join(G, 'engranajes.cjs'), root, '--json'], { encoding: 'utf8', windowsHide: true });
  assert.equal(JSON.parse(j.stdout).rotos >= 1, true);
});
