'use strict';
/* H03 "Release 3.20.1 conjunto": consumidores REALES 3.19.0 y 3.20.0 y las tablas/funciones nuevas de memoria con evidencia.
 *   · leer con el motor nuevo NO migra en silencio
 *   · akdd update crea las tablas por el actualizador seguro, conserva todo lo anterior
 *   · índice / detalle / evidencia / cola / compactación / delta funcionan DESPUÉS del upgrade
 *   · el rollback conserva lo aprendido después y un update interrumpido se recupera con las tablas nuevas */
const test = require('node:test');
const { SIN_DRIVER } = require('./helpers/db-real.cjs');
if (SIN_DRIVER) { test(require('node:path').basename(__filename) + ' (omitido: ' + SIN_DRIVER + ')', { skip: SIN_DRIVER }, () => {}); return; }
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const legacy = require('./helpers/legacy-real.cjs');
const real = require('./helpers/db-real.cjs');
const { update, rollback } = require('../src/update.js');
const { dba, REPO } = real;

const MEM = ['mem_project', 'mem_events', 'mem_observations', 'mem_observation_events', 'mem_knowledge', 'mem_provenance', 'mem_evidence', 'mem_evidence_pins', 'mem_jobs', 'mem_job_events', 'mem_compression_refs', 'mem_context_usage', 'mem_context_packets', 'mem_health'];
const correr = (root, opts = {}) => update({ projectPath: root, salir: false, silent: true, __sinFuncional: true, ...opts });
const filas = (dbPath, sql, ...a) => { const d = dba.openReadOnly(dbPath); try { return d.all(sql, ...a); } finally { d.close(); } };
const tablas = (dbPath) => new Set(filas(dbPath, "SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name));

/** Ejecuta un módulo del motor INDICADO (el del repo o el del proyecto ya actualizado) y devuelve su JSON. */
function cli(motor, root, modulo, args) {
  const r = spawnSync(process.execPath, [path.join(motor, '.agentic', 'grafo', modulo), ...args, '--root=' + root], { cwd: root, encoding: 'utf8', timeout: 120000, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  let json = null; try { json = JSON.parse(r.stdout); } catch { /* sin JSON */ }
  return { status: r.status, json, stderr: r.stderr, stdout: r.stdout };
}

/** Todo lo nuevo, ejercitado con el motor que dejó el update DENTRO del proyecto. */
function ejercitarFunciones(root) {
  const m = (args) => cli(root, root, 'memory-cli.cjs', args);
  const st = m(['status']);
  assert.equal(st.json.availability.state, 'READY', JSON.stringify(st.json.availability));
  const cap = m(['capture', '--host=cursor', '--session=upg', '--id=u1', '--type=test_run', '--task=T-UPG', '--input=npm test', '--output=2 failed']);
  assert.equal(cap.json.status, 'CAPTURED', JSON.stringify(cap.json));
  assert.equal(m(['capture', '--host=cursor', '--session=upg', '--id=u1', '--type=test_run', '--task=T-UPG']).json.status, 'DUPLICATE');
  const dr = m(['drain']);
  assert.ok(dr.json.done >= 1, JSON.stringify(dr.json));
  const idx = m(['index', '--query=REGLA']);
  assert.ok(['OK', 'NO_RESULTS'].includes(idx.json.status), JSON.stringify(idx.json).slice(0, 300));
  // Compactar un log y recuperar el original por hash.
  const log = Array.from({ length: 4000 }, (_, i) => (i === 2500 ? 'ERROR: el único fallo' : 'ok ' + i)).join('\n');
  fs.writeFileSync(path.join(root, 'salida.log'), log);
  const cmp = m(['compress', 'salida.log', '--kind=log', '--task=T-UPG', '--purpose=debug']);
  assert.ok(cmp.json.envelope && cmp.json.envelope.reference_id, JSON.stringify(cmp.json).slice(0, 300));
  assert.ok(cmp.json.delivered.includes('el único fallo'));
  const rec = m(['recover', cmp.json.envelope.reference_id, '--lines=2501-2501', '--task=T-UPG']);
  assert.ok(rec.json.ok, JSON.stringify(rec.json).slice(0, 300));
  assert.ok(rec.json.content.includes('único fallo'));
  const ev = m(['evidence', 'verify', cmp.json.envelope.reference_id]);
  assert.ok(ev.json, 'evidence verify responde');
  // Paquete TEAMS: snapshot → ACK → delta.
  const script = "const tp=require(" + JSON.stringify(path.join(root, '.agentic', 'grafo', 'teams-packets.cjs')) + ");const root=" + JSON.stringify(root) + ";"
    + "const base=(o)=>Object.assign({task_id:'T-UPG',plan_id:'P',sprint_id:'S',sender_role:'director',recipient_role:'builder',objective:'objetivo',acceptance:['a','b'],scope:['src/a.js'],risk_tier:'LOW',next_actions:['x']},o||{});"
    + "const e1=tp.enviar(root,base());const rx={estado:null};const r1=tp.recibir(null,e1.packet);tp.ack(root,{task_id:'T-UPG',recipient_role:'builder',revision:1,hash:r1.ack.hash});"
    + "const e2=tp.enviar(root,base({next_actions:['x','y']}));process.stdout.write(JSON.stringify({k1:e1.kind,k2:e2.kind}));";
  const t = spawnSync(process.execPath, ['-e', script], { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  assert.equal(t.status, 0, t.stderr);
  assert.deepEqual(JSON.parse(t.stdout), { k1: 'snapshot', k2: 'delta' });
}

for (const version of ['3.19.0', '3.20.0']) {
  test(version + ' REAL: leer NO migra · update crea las tablas y conserva todo · las funciones nuevas funcionan · el rollback conserva lo aprendido', async () => {
    const p = legacy.proyectoReal(version, 'memev');
    const antes = real.inventario(p.dbPath);
    const bytesAntes = fs.readFileSync(p.dbPath);

    // 1. Lectura con el motor NUEVO sobre la base vieja: sin migración escondida, con diagnóstico.
    const lectura = cli(REPO, p.root, 'memory-cli.cjs', ['status']);
    assert.equal(lectura.json.availability.state, 'SCHEMA_MISSING');
    assert.ok(lectura.json.availability.missing.includes('mem_events'));
    const captura = cli(REPO, p.root, 'memory-cli.cjs', ['capture', '--host=h', '--session=s', '--type=t']);
    assert.equal(captura.json.status, 'DEGRADED');
    assert.equal(captura.json.code, 'SCHEMA_MISSING');
    assert.deepEqual(fs.readFileSync(p.dbPath), bytesAntes, 'leer/capturar con el motor nuevo no tocó ni un byte de la base vieja');
    for (const t of MEM) assert.ok(!tablas(p.dbPath).has(t), t + ' no debía existir antes del update');

    // 2. El actualizador seguro crea las tablas y conserva lo anterior.
    const r = await correr(p.root);
    assert.equal(r.status, 'VERIFIED', JSON.stringify([r.errors, r.warnings]));
    assert.equal(real.conservada(antes, p.dbPath).status, 'PASS', 'todo lo anterior conservado por contenido');
    for (const t of MEM) assert.ok(tablas(p.dbPath).has(t), t + ' debe existir tras el update');
    assert.equal(filas(p.dbPath, 'SELECT count(*) AS n FROM mem_events')[0].n, 0, 'estructuras vacías: nada inventado para lo antiguo');
    assert.equal(filas(p.dbPath, 'SELECT count(*) AS n FROM mem_knowledge')[0].n, 0, 'lo antiguo queda LEGACY_UNVERIFIED_PROVENANCE al leer; no se reescribe');

    // 3. Las funciones nuevas funcionan con el motor que dejó el update en el proyecto.
    ejercitarFunciones(p.root);
    const inventarioTrasUso = real.inventario(p.dbPath);

    // 4. Rollback: archivos atrás, y LO APRENDIDO DESPUÉS (eventos, evidencias, paquetes) se conserva.
    const rb = await rollback({ projectPath: p.root, salir: false, silent: true });
    assert.equal(rb.status, 'ROLLED_BACK', JSON.stringify([rb.errors, rb.reason]));
    assert.ok(filas(p.dbPath, 'SELECT count(*) AS n FROM mem_events')[0].n >= 1, 'el evento capturado después del update sigue ahí');
    assert.ok(filas(p.dbPath, 'SELECT count(*) AS n FROM mem_evidence')[0].n >= 1, 'la evidencia guardada después del update sigue ahí');
    assert.ok(filas(p.dbPath, 'SELECT count(*) AS n FROM mem_context_packets')[0].n >= 2, 'los paquetes TEAMS siguen ahí');
    assert.equal(real.conservada(inventarioTrasUso, p.dbPath).status, 'PASS', 'el rollback no restauró una BD vieja a ciegas');
  });
}

test('update INTERRUMPIDO tras crear las tablas nuevas: se recupera, y al repetirlo todo funciona', async () => {
  const p = legacy.proyectoReal('3.20.0', 'memev-int');
  const antes = real.inventario(p.dbPath);
  const r = await correr(p.root, { __fallar: 'tras_migracion' });
  assert.equal(r.status, 'ROLLED_BACK', JSON.stringify([r.errors, r.recovery]));
  assert.equal(real.conservada(antes, p.dbPath).status, 'PASS', 'datos anteriores intactos tras la interrupción');
  const otra = await correr(p.root);
  assert.ok(otra.ok, JSON.stringify([otra.status, otra.errors]));
  for (const t of MEM) assert.ok(tablas(p.dbPath).has(t), t);
  ejercitarFunciones(p.root);
});

test('base NUEVA (init): se crea con todas las tablas de memoria con evidencia, sin pasar por update', () => {
  const { proyecto } = require('./helpers/memoria-proyecto.cjs');
  const p = proyecto('fresca');
  try {
    for (const t of MEM) assert.ok(tablas(p.dbPath).has(t), t);
    assert.equal(filas(p.dbPath, "SELECT value FROM agentix_schema_meta WHERE key = 'level'")[0].value, '3');
  } finally { p.limpiar(); }
});
