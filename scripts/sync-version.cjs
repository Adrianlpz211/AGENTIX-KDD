#!/usr/bin/env node
'use strict';

/**
 * sync-version — una sola versión, y ningún contador escrito a mano.
 *
 * LA FUENTE es package.json. De ahí se genera .agentic/grafo/framework.json,
 * que viaja con el motor al proyecto consumidor (allí el package.json es del
 * proyecto, no de Agentix) y es lo que leen el servidor MCP y el CLI.
 *
 * Los protocolos de esquema (gate-result, telemetría, estado del pipeline) se
 * versionan aparte: una versión de producto no dice nada sobre el formato de
 * un registro.
 *
 *   node scripts/sync-version.cjs              escribe framework.json
 *   node scripts/sync-version.cjs --check      no escribe; sale 1 si hay deriva
 *   node scripts/sync-version.cjs --inventario contadores vivos
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const GRAFO = path.join(RAIZ, '.agentic', 'grafo');
const MANIFIESTO = path.join(GRAFO, 'framework.json');

/* Documentos derivados: no pueden llevar contadores fijos de módulos,
   herramientas o tests — se desfasan en silencio. */
const DERIVADOS = ['AGENTS.md', 'ARCHITECTURE.md', 'README.md', 'README.es.md',
  'GEMINI.md', path.join('.github', 'copilot-instructions.md')];
const CONTADOR = /(?:~\s*)?\b\d{2,3}\s+(?:Node\.js\s+)?(?:módulos|modules|herramientas|tools|archivos de test|test files)\b/gi;

function protocolos() {
  const leer = (archivo, patron) => {
    try {
      const m = fs.readFileSync(path.join(GRAFO, archivo), 'utf8').match(patron);
      return m ? Number(m[1]) : null;
    } catch { return null; }
  };
  return {
    gate_result: leer('gate-result.cjs', /schema_version:\s*(\d+)/),
    telemetry: leer('telemetry.cjs', /SCHEMA_VERSION\s*=\s*(\d+)/),
    pipeline_state: leer('pipeline-controller.cjs', /schema_version:\s*(\d+)/),
  };
}

function esperado(raiz = RAIZ) {
  const pkg = JSON.parse(fs.readFileSync(path.join(raiz, 'package.json'), 'utf8'));
  return { name: pkg.name, version: pkg.version, schema: protocolos() };
}

function inventario(raiz = RAIZ) {
  const grafo = path.join(raiz, '.agentic', 'grafo');
  const mcp = preguntarMcp(path.join(grafo, 'mcp-server.cjs'), raiz);
  const contar = (dir, fin) => { try { return fs.readdirSync(dir).filter((f) => f.endsWith(fin)).length; } catch { return null; } };
  return {
    version: esperado(raiz).version,
    modulos: contar(grafo, '.cjs'),
    version_mcp: mcp ? mcp.version : null,
    herramientas_mcp: mcp ? mcp.herramientas : null,
    tests: contar(path.join(raiz, 'test'), '.test.cjs'),
  };
}

/* Lo que el servidor MCP anuncia de verdad al arrancar, no lo que dice su
   código fuente: un comentario o una lista sin registrar no cuenta. */
function preguntarMcp(servidor, cwd) {
  if (!fs.existsSync(servidor)) return null;
  const r = spawnSync(process.execPath, [servidor], {
    cwd,
    input: '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}\n'
      + '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n',
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 32 * 1024 * 1024,
  });
  let version = null;
  let herramientas = null;
  for (const linea of String(r.stdout || '').split(/\r?\n/)) {
    let msg;
    try { msg = JSON.parse(linea); } catch { continue; }
    if (msg.id === 0 && msg.result && msg.result.serverInfo) version = msg.result.serverInfo.version;
    if (msg.id === 1 && msg.result && Array.isArray(msg.result.tools)) herramientas = msg.result.tools.length;
  }
  return { version, herramientas };
}

function contadoresFijos(raiz = RAIZ) {
  const hallazgos = [];
  for (const rel of DERIVADOS) {
    let texto;
    try { texto = fs.readFileSync(path.join(raiz, rel), 'utf8'); } catch { continue; }
    texto.split(/\r?\n/).forEach((linea, i) => {
      for (const m of linea.matchAll(CONTADOR)) hallazgos.push({ file: rel, line: i + 1, texto: m[0] });
    });
  }
  return hallazgos;
}

function check(raiz = RAIZ, opts = {}) {
  const problemas = [];
  const want = esperado(raiz);
  let actual = null;
  try { actual = JSON.parse(fs.readFileSync(path.join(raiz, '.agentic', 'grafo', 'framework.json'), 'utf8')); } catch { /* ausente */ }
  if (!actual) problemas.push('framework.json ausente o ilegible');
  else if (JSON.stringify(actual) !== JSON.stringify(want)) {
    problemas.push(`framework.json desfasado: ${JSON.stringify(actual)} ≠ ${JSON.stringify(want)}`);
  }
  for (const h of contadoresFijos(raiz)) problemas.push(`contador fijo en ${h.file}:${h.line} — "${h.texto}"`);
  if (opts.mcp !== false) {
    const mcp = preguntarMcp(path.join(raiz, '.agentic', 'grafo', 'mcp-server.cjs'), raiz);
    if (mcp && mcp.version !== want.version) problemas.push(`el servidor MCP anuncia ${mcp.version}, el manifiesto dice ${want.version}`);
  }
  return { ok: problemas.length === 0, problemas };
}

function escribir(raiz = RAIZ) {
  const destino = path.join(raiz, '.agentic', 'grafo', 'framework.json');
  fs.writeFileSync(destino, JSON.stringify(esperado(raiz), null, 2) + '\n');
  alinearConfig(raiz);
  return destino;
}

/* `npm version` solo cambia package.json; la VERSION de config.md (el número
   que ve quien abre el proyecto) se quedaba atrás y la barrera de release lo
   frenaba (3.20.1, 03/10/2026). Se alinea aquí, en el mismo paso. */
function alinearConfig(raiz = RAIZ) {
  const f = path.join(raiz, '.agentic', 'config.md');
  try {
    const txt = fs.readFileSync(f, 'utf8');
    const nuevo = txt.replace(/^(\s*VERSION:\s*)\S+/m, '$1' + esperado(raiz).version);
    if (nuevo !== txt) fs.writeFileSync(f, nuevo);
  } catch { /* sin config.md: nada que alinear */ }
}

if (require.main === module) {
  const arg = process.argv[2];
  if (arg === '--check') {
    const r = check();
    if (r.ok) console.log('  ✔ versión y documentos derivados sin deriva');
    else { for (const p of r.problemas) console.error('  ✘ ' + p); process.exitCode = 1; }
  } else if (arg === '--inventario') {
    console.log(JSON.stringify(inventario(), null, 2));
  } else {
    console.log('  ✔ ' + path.relative(RAIZ, escribir()));
  }
}

module.exports = { esperado, inventario, contadoresFijos, check, escribir, MANIFIESTO, DERIVADOS };
