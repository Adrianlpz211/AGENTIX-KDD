#!/usr/bin/env node
'use strict';

/**
 * Runtime y entorno (C10). Separa tres diagnósticos que antes salían como un
 * solo "no funciona":
 *
 *   · versión de Node frente a `engines` y frente a lo que el CI prueba de verdad
 *   · driver SQLite disponible (better-sqlite3, node:sqlite, sql.js) — un Node
 *     válido sin driver es otro problema, con otra solución
 *   · Git: "dubious ownership" con la ruta exacta y la opción acotada a esa
 *     ruta. Aquí no se ejecuta: cambiar la config global de Git lo autoriza la
 *     persona. Nunca safe.directory=*.
 *
 * Solo lee. No instala, no cambia engines ni la matriz del CI: si no
 * coinciden, devuelve la propuesta para que la persona decida.
 */

const fs = require('fs');
const path = require('path');

const mayor = (v) => Number(String(v || '').replace(/^v/, '').split('.')[0]) || null;

function enginesMin(root) {
  try {
    const e = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).engines || {};
    const m = /(\d+)/.exec(String(e.node || ''));
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

function versionesCI(root) {
  const dir = path.join(root, '.github', 'workflows');
  const out = new Set();
  let archivos = [];
  try { archivos = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)); } catch { return []; }
  for (const f of archivos) {
    const txt = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of txt.matchAll(/node-version:\s*\[([^\]]+)\]/g)) for (const v of m[1].split(',')) { const n = mayor(v.replace(/['"\s]/g, '')); if (n) out.add(n); }
    for (const m of txt.matchAll(/node-version:\s*['"]?(\d+)/g)) out.add(Number(m[1]));
  }
  return [...out].sort((a, b) => a - b);
}

function drivers(probar = (m) => require(m)) {
  const lista = [];
  for (const [id, mod] of [['better-sqlite3', 'better-sqlite3'], ['node:sqlite', 'node:sqlite'], ['sql.js', 'sql.js']]) {
    try { probar(mod); lista.push({ id, disponible: true }); } catch (e) { lista.push({ id, disponible: false, motivo: String(e.code || e.message).slice(0, 80) }); }
  }
  return lista;
}

function diagnosticoGit(root, ejecutar) {
  const run = ejecutar || ((args) => require('child_process').spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 5000 }));
  const r = run(['rev-parse', '--show-toplevel']);
  if (r.error) return { status: 'SIN_GIT', detalle: 'git no está instalado o no está en el PATH' };
  const err = String(r.stderr || '');
  if (/dubious ownership/i.test(err)) {
    const m = /safe\.directory\s+'?([^'\n]+?)'?\s*$/m.exec(err);
    const ruta = (m && m[1].trim()) || path.resolve(root).replace(/\\/g, '/');
    return {
      status: 'DUBIOUS_OWNERSHIP', ruta,
      detalle: 'Git no confía en esta carpeta porque su dueño es otro usuario; restore y test-integrity quedan sin base',
      opcion_acotada: `git config --global --add safe.directory "${ruta}"`,
      requiere: 'autorización de la persona: cambia su configuración global de Git, solo para esta ruta',
      nunca: 'safe.directory=*',
    };
  }
  if (r.status !== 0) return { status: /not a git repository/i.test(err) ? 'NO_ES_REPO' : 'ERROR', detalle: err.trim().slice(0, 200) };
  return { status: 'OK', raiz: String(r.stdout || '').trim() };
}

function diagnostico(root, { version = process.version, probar, ejecutarGit } = {}) {
  const min = enginesMin(root);
  const ci = versionesCI(root);
  const actual = mayor(version);
  const ds = drivers(probar);
  const elegido = ds.find((d) => d.disponible) || null;
  const problemas = [];
  if (min && actual < min) problemas.push({ codigo: 'NODE_NO_SOPORTADO', detalle: `Agentix pide Node >=${min}; este es ${version}` });
  if (!elegido) problemas.push({ codigo: 'SIN_DRIVER_SQLITE', detalle: 'Node sirve, pero ningún driver SQLite carga: npm install (sql.js viene en dependencias)' });
  const sinCi = min && ci.length ? Array.from({ length: Math.max(0, ci[0] - min) }, (_, i) => min + i).filter((v) => !ci.includes(v)) : [];
  const propuesta = sinCi.length
    ? { codigo: 'ENGINES_SIN_CI', detalle: `engines admite Node ${sinCi.join(', ')} pero el CI no lo prueba`, opciones: [`agregar ${sinCi.join(', ')} a la matriz del CI`, `elevar engines a >=${ci[0]}`], decide: 'la persona' }
    : null;
  return {
    status: problemas.length ? 'NO_SOPORTADO' : (propuesta ? 'SOPORTADO_SIN_CI' : 'OK'),
    node: version, engines_min: min, ci, driver: elegido ? elegido.id : null, drivers: ds,
    problemas, propuesta, git: diagnosticoGit(root, ejecutarGit),
  };
}

/** Pasos del piloto en una copia; aquí solo se listan, no se ejecutan. */
function planPiloto(root, destino) {
  return {
    status: 'PLAN', origen: path.resolve(root), copia: destino || '(carpeta temporal fuera del proyecto)',
    pasos: [
      'copiar el proyecto a la carpeta del piloto (el original no se toca)',
      'akdd update en la copia; repetir para comprobar que es idempotente',
      'health y capabilities en la copia',
      'un ciclo aa: pequeño con post-cycle',
      'restore real de un punto creado en la copia',
      'WhatsApp: solo si la persona escribe ws: activar en ese momento',
    ],
    nunca: ['komerza, ktalogo, 360 u otros proyectos originales', 'migrar la base real sin permiso específico'],
  };
}

module.exports = { diagnostico, diagnosticoGit, drivers, versionesCI, enginesMin, planPiloto };

if (require.main === module) {
  const [cmd = 'check', destino] = process.argv.slice(2);
  const r = cmd === 'piloto' ? planPiloto(process.cwd(), destino) : diagnostico(process.cwd());
  console.log(JSON.stringify(r, null, 2));
  if (r.status === 'NO_SOPORTADO') process.exitCode = 1;
}
