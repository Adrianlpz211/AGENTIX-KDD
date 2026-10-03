'use strict';

/**
 * Resultados por test individual, leídos de la salida real del runner.
 * Lo comparten el TDD gate y el Contract Guard: un contrato se ata a un test
 * concreto (archivo + nombre), no al área ni al comando.
 *
 * Formatos: TAP (node --test sin terminal), reporter spec de node, Jest/Vitest
 * y pytest -v. Lo que no se reconoce no se inventa.
 */

const crypto = require('crypto');

function limpiar(raw) {
  return String(raw || '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

function sinDuracion(nombre) {
  return nombre.replace(/\s+\(\d+(?:\.\d+)?\s*m?s\)\s*$/, '').trim();
}

function extractTestResults(rawOutput, opts = {}) {
  const raw = limpiar(rawOutput);
  const porClave = new Map();
  const agregar = (test_name, status, test_file) => {
    const nombre = sinDuracion(test_name || '');
    if (!nombre || nombre.length < 2) return;
    const archivo = test_file || opts.testFile || null;
    const clave = (archivo || '') + '::' + nombre;
    const previo = porClave.get(clave);
    if (previo && previo.status === 'fail') return;
    porClave.set(clave, { test_file: archivo, test_name: nombre, status });
  };

  const lineas = raw.split(/\r?\n/);
  for (let i = 0; i < lineas.length; i++) {
    const linea = lineas[i];
    let m;
    if ((m = linea.match(/^(not ok|ok)\s+\d+\s+-\s+(.+?)(\s+#\s*(SKIP|TODO).*)?$/))) {
      if (m[3]) continue;
      let archivo = null;
      for (let j = i + 1; j < Math.min(lineas.length, i + 25); j++) {
        if (/^(not ok|ok)\s+\d+/.test(lineas[j])) break;
        const loc = lineas[j].match(/location:\s*'([^']+?):\d+:\d+'/);
        if (loc) { archivo = loc[1]; break; }
      }
      if (/^test[\\/].+\.(c|m)?js$|\.test\.|\.spec\./.test(m[2]) && m[1] === 'ok') continue;
      agregar(m[2], m[1] === 'ok' ? 'pass' : 'fail', archivo);
      continue;
    }
    if ((m = linea.match(/^\s*(?:✔|✓|√)\s+(.+)$/))) { agregar(m[1], 'pass'); continue; }
    if ((m = linea.match(/^\s*(?:✖|✕|✗|×)\s+(.+)$/))) {
      if (/^failing tests:?$/i.test(m[1].trim())) continue;
      agregar(m[1], 'fail');
      continue;
    }
    if ((m = linea.match(/^(\S+?\.py)::(\S.*?)\s+(PASSED|FAILED|ERROR)\b/))) {
      agregar(m[2], m[3] === 'PASSED' ? 'pass' : 'fail', m[1]);
      continue;
    }
    if ((m = linea.match(/^(FAILED|ERROR)\s+(\S+?\.py)::(\S+)/))) {
      agregar(m[3], 'fail', m[2]);
    }
  }
  return [...porClave.values()];
}

function testId(runnerId, test) {
  return crypto.createHash('sha256')
    .update([runnerId || 'desconocido', test.test_file || '', test.test_name].join('\u0000'))
    .digest('hex')
    .slice(0, 16);
}

module.exports = { extractTestResults, testId, limpiar };
