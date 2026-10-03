#!/usr/bin/env node
'use strict';
/**
 * Verificación POSTERIOR a la publicación (3.20.1).
 *
 *   node scripts/verify-published.cjs [versión]
 *
 * Descarga de npm lo que de verdad se publicó y comprueba:
 *   1. la versión existe en el registro y es la etiqueta `latest` (o la pedida);
 *   2. el tarball descargado es EXACTAMENTE el que verificó release-check
 *      (mismo sha256 y misma integridad que están en verification.json);
 *   3. ese paquete descargado actualiza un consumidor REAL 3.19.0 con un solo
 *      comando: VERIFIED, memoria conservada por contenido, repetición idempotente.
 *
 * No publica nada. Si algo no coincide termina con código distinto de cero.
 */
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto'), assert = require('assert/strict');
const { spawnSync } = require('child_process');
const { herramienta } = require('../src/run-safe');

const ROOT = path.resolve(__dirname, '..');
const version = process.argv[2] || require('../package.json').version;
const informePath = path.join(ROOT, '_output', 'release-' + version, 'verification.json');
const salida = { version, started_at: new Date().toISOString(), checks: [] };
const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const ok = (name, detail) => { salida.checks.push({ name, status: 'PASS', detail }); console.log('  ✔ ' + name + (detail ? ' — ' + detail : '')); };

(async () => {
  console.log('Verificando lo publicado de agentic-kdd@' + version);
  // 1. el registro
  const vista = JSON.parse(herramienta('npm', ['view', 'agentic-kdd@' + version, 'version', 'dist.integrity', 'dist.shasum', '--json'], { encoding: 'utf8', timeout: 120000 }));
  assert.equal(vista.version, version, 'la versión no está en el registro');
  const tags = JSON.parse(herramienta('npm', ['view', 'agentic-kdd', 'dist-tags', '--json'], { encoding: 'utf8', timeout: 120000 }));
  assert.equal(tags.latest, version, 'latest apunta a ' + tags.latest + ', no a ' + version);
  ok('registro', 'versión publicada y etiqueta latest');

  // 2. el artefacto descargado es el verificado
  assert.ok(fs.existsSync(informePath), 'no hay verification.json de esa versión: ' + informePath);
  const informe = JSON.parse(fs.readFileSync(informePath, 'utf8'));
  assert.equal(informe.status, 'PASS');
  const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'agentix-published-'));
  const empaque = JSON.parse(herramienta('npm', ['pack', 'agentic-kdd@' + version, '--ignore-scripts', '--json', '--pack-destination', lab], { cwd: lab, encoding: 'utf8', timeout: 180000 }))[0];
  const tgz = path.join(lab, empaque.filename);
  assert.equal(sha256(tgz), informe.package.sha256, 'el tarball publicado NO es el verificado (sha256)');
  assert.equal(empaque.integrity, informe.package.integrity, 'la integridad del tarball publicado NO es la verificada');
  assert.equal(empaque.integrity, vista['dist.integrity'], 'la integridad descargada no coincide con la del registro');
  ok('artefacto', 'sha256 ' + informe.package.sha256.slice(0, 16) + '… idéntico al que verificó release-check');
  salida.package = { sha256: informe.package.sha256, integrity: empaque.integrity, files: empaque.files.length };

  // 3. upgrade desde 3.19.0 con el paquete DESCARGADO
  const legacy = require('../test/helpers/legacy-real.cjs');
  const real = require('../test/helpers/db-real.cjs');
  const instalacion = path.join(lab, 'instalacion');
  herramienta('npm', ['install', '--prefix', instalacion, tgz, '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'], { encoding: 'utf8', timeout: 240000 });
  const bin = path.join(instalacion, 'node_modules', 'agentic-kdd', 'bin', 'akdd.js');
  const v = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8' }).stdout.trim();
  assert.equal(v, version, 'akdd --version del paquete descargado dice ' + v);
  const p = legacy.proyectoReal('3.19.0', 'publicado');
  const antes = real.inventario(p.dbPath);
  const correr = (args) => { const r = spawnSync(process.execPath, [bin, ...args], { cwd: p.root, encoding: 'utf8', timeout: 600000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NODE_NO_WARNINGS: '1' } }); let j = null; try { j = JSON.parse(r.stdout); } catch { /* sin JSON */ } return { exit: r.status, json: j, err: r.stderr }; };
  const a = correr(['update', '--json']);
  assert.equal(a.exit, 0, 'update falló: ' + (a.err || '').slice(0, 400));
  assert.equal(a.json.status, 'VERIFIED', JSON.stringify([a.json.errors, a.json.warnings]));
  assert.equal(a.json.versions.from, '3.19.0');
  assert.equal(a.json.versions.to, version);
  assert.equal(real.conservada(antes, p.dbPath).status, 'PASS');
  const b = correr(['update', '--json']);
  assert.equal(b.json.status, 'NO_CHANGES_VERIFIED');
  ok('upgrade desde 3.19.0', 'VERIFIED, ' + a.json.preservation.db.summary.rows_compared + ' fila(s) comparadas por contenido, repetición NO_CHANGES_VERIFIED');
  salida.upgrade_from_3_19_0 = { status: a.json.status, migrations_applied: a.json.schema.migrations.applied.length, rows_compared: a.json.preservation.db.summary.rows_compared, idempotent: b.json.status === 'NO_CHANGES_VERIFIED' };

  salida.finished_at = new Date().toISOString();
  salida.status = 'PASS';
  fs.writeFileSync(path.join(path.dirname(informePath), 'published-verification.json'), JSON.stringify(salida, null, 2));
  console.log('\nPASS — lo publicado es lo verificado y actualiza un consumidor real.');
})().catch((e) => {
  salida.status = 'FAIL'; salida.error = e.message; salida.finished_at = new Date().toISOString();
  try { fs.writeFileSync(path.join(path.dirname(informePath), 'published-verification.json'), JSON.stringify(salida, null, 2)); } catch { /* sin carpeta */ }
  console.error('\nFAIL — ' + e.message);
  process.exit(1);
});
