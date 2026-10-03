'use strict';

/**
 * Ejecutar procesos sin armar líneas de shell.
 *
 *   nodo(script, args, opts)   el mismo Node que corre el CLI, argv directo
 *   herramienta(cmd, args)     binarios externos (curl, tar, npm, claude)
 *
 * Los dos lanzan si el proceso falla (como execSync) y devuelven stdout.
 * En Windows, npm/npx/claude son shims .cmd que solo arrancan vía cmd.exe:
 * ahí cada argumento va entre comillas y se rechaza cualquiera que cmd.exe
 * pudiera reinterpretar (comillas, %, !, ^, saltos de línea).
 */

const { spawnSync } = require('child_process');

const SHIMS_WIN = new Set(['npm', 'npx', 'claude', 'yarn', 'pnpm']);
const PELIGROSO_CMD = /["%!^\r\n]/;

function resultado(r, etiqueta) {
  if (r.error) throw r.error;
  if (r.status !== 0) {
    const err = new Error(`${etiqueta} terminó con código ${r.status}${r.signal ? ' (' + r.signal + ')' : ''}`);
    err.status = r.status; err.signal = r.signal; err.stdout = r.stdout; err.stderr = r.stderr;
    throw err;
  }
  return r.stdout;
}

function nodo(script, args, opts) {
  const o = Object.assign({ stdio: 'pipe' }, opts || {});
  return resultado(spawnSync(process.execPath, [script, ...(args || []).map(String)], o), 'node ' + require('path').basename(script));
}

function herramienta(cmd, args, opts) {
  const o = Object.assign({ stdio: 'pipe', windowsHide: true }, opts || {});
  const lista = (args || []).map(String);
  if (process.platform === 'win32' && SHIMS_WIN.has(cmd)) {
    const malo = lista.find((a) => PELIGROSO_CMD.test(a));
    if (malo !== undefined) {
      const err = new Error(`argumento no admitido para ${cmd} en Windows: ${JSON.stringify(malo)}`);
      err.code = 'UNSAFE_ARG';
      throw err;
    }
    const linea = [cmd, ...lista.map((a) => `"${a}"`)].join(' ');
    return resultado(spawnSync('cmd.exe', ['/d', '/s', '/c', `"${linea}"`], Object.assign({}, o, { windowsVerbatimArguments: true })), cmd);
  }
  return resultado(spawnSync(cmd, lista, o), cmd);
}

module.exports = { nodo, herramienta, PELIGROSO_CMD };
