#!/usr/bin/env node
'use strict';
/**
 * Lanzador MCP global de Agentix.
 *
 * Una sola entrada global (Cursor ~/.cursor/mcp.json, Claude Code --scope user)
 * sirve a TODOS los proyectos sin mezclar memorias:
 *
 *   1. Averigua el proyecto: AGENTIX_PROJECT_ROOT, PROJECT_ROOT,
 *      CLAUDE_PROJECT_DIR o la carpeta de arranque, subiendo hasta encontrar
 *      .agentic/grafo/mcp-server.cjs. Un valor sin interpolar (${...}) se ignora.
 *   2. Si lo encuentra, arranca EL SERVIDOR DE ESE PROYECTO (su versión del
 *      motor, su memoria.db) con PROJECT_ROOT fijado. Cada proyecto conserva
 *      la versión de Agentix que tiene instalada.
 *   3. Si no hay proyecto Agentix, responde MCP con una sola herramienta que lo
 *      dice, en vez de caerse: el IDE no muestra el servidor en rojo en los
 *      proyectos que no usan Agentix.
 *
 * Sin dependencias: `akdd mcp --global` lo copia a ~/.agentix/ y la entrada
 * global no depende de dónde esté instalado el paquete npm ni de un checkout.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SERVER_REL = path.join('.agentic', 'grafo', 'mcp-server.cjs');

function buscarHaciaArriba(desde) {
  if (!desde || typeof desde !== 'string' || desde.includes('${')) return null;
  let dir;
  try { dir = path.resolve(desde); } catch { return null; }
  for (;;) {
    if (fs.existsSync(path.join(dir, SERVER_REL))) return dir;
    const padre = path.dirname(dir);
    if (padre === dir) return null;
    dir = padre;
  }
}

function resolverProyecto(env = process.env, cwd = process.cwd()) {
  for (const c of [env.AGENTIX_PROJECT_ROOT, env.PROJECT_ROOT, env.CLAUDE_PROJECT_DIR, cwd]) {
    const r = buscarHaciaArriba(c);
    if (r) return r;
  }
  return null;
}

/** Servidor mínimo para cuando la carpeta no es un proyecto Agentix. */
function servirSinProyecto(cwd) {
  const texto = `Esta carpeta (${cwd}) no tiene Agentix instalado: no hay .agentic/grafo/mcp-server.cjs ` +
    'en ella ni en sus carpetas superiores. Para usar memoria, contratos y gates aquí: akdd init. ' +
    'Ninguna otra memoria se consulta desde aquí.';
  const out = (obj) => process.stdout.write(JSON.stringify(Object.assign({ jsonrpc: '2.0' }, obj)) + '\n');
  const rl = require('readline').createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (!m || m.id === undefined || m.id === null) return; // notificación: no lleva respuesta
    if (m.method === 'initialize') {
      out({ id: m.id, result: { protocolVersion: (m.params && m.params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'agentic-kdd', version: 'launcher' } } });
    } else if (m.method === 'ping') {
      out({ id: m.id, result: {} });
    } else if (m.method === 'tools/list') {
      out({ id: m.id, result: { tools: [{ name: 'agentix_status', description: 'Indica si la carpeta abierta tiene Agentix instalado y cómo instalarlo.', inputSchema: { type: 'object', properties: {}, required: [] } }] } });
    } else if (m.method === 'tools/call') {
      out({ id: m.id, result: { content: [{ type: 'text', text: texto }] } });
    } else {
      out({ id: m.id, error: { code: -32601, message: `Método '${m.method}' no soportado sin proyecto Agentix` } });
    }
  });
  rl.on('close', () => process.exit(0));
}

function main() {
  const root = resolverProyecto();
  if (!root) return servirSinProyecto(process.cwd());
  const env = Object.assign({}, process.env, { PROJECT_ROOT: root });
  const hijo = spawn(process.execPath, [path.join(root, SERVER_REL)], { cwd: root, env, stdio: 'inherit', windowsHide: true });
  const reenviar = (sig) => { try { hijo.kill(sig); } catch { /* ya terminó */ } };
  process.on('SIGINT', () => reenviar('SIGINT'));
  process.on('SIGTERM', () => reenviar('SIGTERM'));
  hijo.on('exit', (code, signal) => process.exit(code === null ? (signal ? 1 : 0) : code));
  hijo.on('error', (e) => { process.stderr.write('[agentix-mcp] no se pudo arrancar el servidor del proyecto: ' + e.message + '\n'); process.exit(1); });
}

if (require.main === module) main();
module.exports = { resolverProyecto, buscarHaciaArriba, SERVER_REL };
