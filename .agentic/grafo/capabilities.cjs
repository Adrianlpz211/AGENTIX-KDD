#!/usr/bin/env node
'use strict';

/**
 * capabilities — qué del motor está instalado, cableado, ejecutado y verificado.
 *
 * Son cuatro cosas distintas y se confundían:
 *
 *   installed  el archivo existe.
 *   wired      es alcanzable desde un punto de entrada real (CLI, hooks de git,
 *              servidor MCP) siguiendo requires y lanzamientos por ruta.
 *              Un test, un comentario, una mención suelta o la carga que hace
 *              un diagnóstico no cuentan: no hacen que corra. Si lo lanza una
 *              persona o el modelo a propósito, PAPEL-ACEPTADO.json lo declara
 *              y queda como 'declarado', no como true.
 *   executed   hay huella de que corrió (libreta de gates o evidencia en disco).
 *              Sin fuente de huella conocida = null (no se sabe), no false.
 *   verified   un test que lo usa pasó en la última corrida registrada por
 *              scripts/run-tests.cjs, y el módulo no cambió después.
 *
 * Capacidades que aún no tienen integración (restauración,
 * WhatsApp) se listan como 'no_integrada' hasta que exista el módulo: no se
 * anuncian por haberse escrito en un documento.
 *
 *   node .agentic/grafo/capabilities.cjs [--json] [modulo...]
 */

const fs = require('fs');
const path = require('path');

/* Fuente de huella de ejecución por módulo. Solo lo que de verdad deja rastro. */
const EVIDENCIA = {
  'spec-value-scan.cjs': { gate: 'spec' },
  'ui-layout-memory.cjs': { gate: 'ui-layout' },
  'context-enricher.cjs': { gate: 'reloj' },
  'gate-telemetry.cjs': { gate: 'memoria' },
  'regression-guard.cjs': { gate: 'regression' },
  'tdd-gate.cjs': { gate: 'tdd' },
  'contract-guard.cjs': { gate: 'preservation' },
  'lock-manager.cjs': { gate: 'legion' },
  'browser-gate.cjs': { gate: 'browser' },
  'hook-runner.cjs': { archivo: '.agentic/_hooks/pre-commit.json' },
};

/* Capacidades prometidas por el plan que todavía no pueden anunciarse. */
const PENDIENTES = [
  { id: 'restore', patron: /^restore[-.]/ },
  { id: 'whatsapp', patron: /^(ws|whatsapp)[-.]/ },
];

/* Quita comentarios respetando strings: un '/*' dentro de 'src/**' no abre
   comentario. Las líneas '# ...' de los shims de shell también son comentario. */
function sinComentarios(texto) {
  let out = '';
  let i = 0;
  let cadena = null;
  while (i < texto.length) {
    const c = texto[i];
    const d = texto[i + 1];
    if (cadena) {
      out += c;
      if (c === '\\') { out += d || ''; i += 2; continue; }
      if (c === cadena || (c === '\n' && cadena !== '`')) cadena = null;
      i++;
      continue;
    }
    if (c === '/' && d === '*') {
      const fin = texto.indexOf('*/', i + 2);
      i = fin < 0 ? texto.length : fin + 2;
      continue;
    }
    if (c === '/' && d === '/' && texto[i - 1] !== ':' && texto[i - 1] !== '\\') {
      while (i < texto.length && texto[i] !== '\n') i++;
      continue;
    }
    if (c === '#' && (i === 0 || texto[i - 1] === '\n') && d !== '!') {
      while (i < texto.length && texto[i] !== '\n') i++;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') cadena = c;
    out += c;
    i++;
  }
  return out;
}

function listar(dir, filtro) {
  try { return fs.readdirSync(dir).filter(filtro).map((f) => path.join(dir, f)); } catch { return []; }
}

function invocadoresRuntime(raiz) {
  const grafo = path.join(raiz, '.agentic', 'grafo');
  return [
    ...listar(grafo, (f) => f.endsWith('.cjs')),
    ...listar(path.join(grafo, 'git-hooks'), () => true),
    ...listar(path.join(raiz, 'bin'), (f) => /\.(c?js)$/.test(f)),
    ...listar(path.join(raiz, 'src'), (f) => /\.(c?js)$/.test(f)),
  ].filter((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
}

/* Una mención suelta ('harness' en una lista de rutas sensibles) no es una
   invocación: hace falta la ruta del módulo — require('./x'), 'x.cjs'. */
function referencia(nombre) {
  const base = nombre.replace(/\.cjs$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`['"\`](?:[^'"\`\\n]*[\\\\/])?${base}\\.cjs['"\`]|require\\(\\s*['"\`][^'"\`\\n]*[\\\\/]${base}(?:\\.cjs)?['"\`]`);
}

/* Diagnóstico: cargan módulos para comprobar que existen, no para usarlos. */
const DIAGNOSTICO = new Set(['health-check.cjs', 'hierro-papel.cjs', 'capabilities.cjs', 'madurez-lint.cjs']);

function esEntrada(raiz, file) {
  const rel = path.relative(raiz, file).split(path.sep).join('/');
  return rel.startsWith('bin/') || rel.startsWith('src/') || rel.startsWith('.agentic/grafo/git-hooks/')
    || rel === '.agentic/grafo/mcp-server.cjs';
}

/* Alcanzables desde un punto de entrada real siguiendo requires y lanzamientos. */
function alcanzables(raiz, fuentes, papel) {
  const grafo = path.join(raiz, '.agentic', 'grafo');
  const modulos = listar(grafo, (f) => f.endsWith('.cjs')).map((f) => path.basename(f));
  const regex = new Map(modulos.map((m) => [m, referencia(m)]));
  const camino = new Map();
  const cola = [];
  for (const s of fuentes) {
    if (esEntrada(raiz, s.file)) cola.push(s);
  }
  for (const m of Object.keys(papel)) {
    const s = fuentes.find((f) => path.basename(f.file) === m && path.dirname(f.file) === grafo);
    if (s) { camino.set(m, 'declarado'); cola.push(s); }
  }
  while (cola.length) {
    const s = cola.shift();
    const nombre = path.basename(s.file);
    if (DIAGNOSTICO.has(nombre)) continue;
    for (const [m, re] of regex) {
      if (m === nombre || camino.has(m) || !re.test(s.texto)) continue;
      camino.set(m, path.relative(raiz, s.file).split(path.sep).join('/'));
      const sig = fuentes.find((f) => path.basename(f.file) === m && path.dirname(f.file) === grafo);
      if (sig) cola.push(sig);
    }
  }
  return camino;
}

function papelAceptado(raiz) {
  try {
    return JSON.parse(fs.readFileSync(path.join(raiz, '.agentic', 'grafo', 'PAPEL-ACEPTADO.json'), 'utf8')).aceptados || {};
  } catch { return {}; }
}

function ultimaCorrida(raiz) {
  try { return JSON.parse(fs.readFileSync(path.join(raiz, '.agentic', '_cache', 'test-run.json'), 'utf8')); } catch { return null; }
}

function huellas(raiz) {
  const dbPath = path.join(raiz, '.agentic', 'memoria.db');
  if (!fs.existsSync(dbPath)) return null;
  let db;
  try {
    db = require('./db-adapter.cjs').openReadOnly(dbPath);
    const filas = db.all('SELECT gate, COUNT(*) AS n, MAX(ts) AS ultimo FROM gate_events GROUP BY gate');
    return Object.fromEntries(filas.map((f) => [f.gate, { n: f.n, ultimo: f.ultimo }]));
  } catch { return null; } finally { try { if (db) db.close(); } catch { /* ya cerrada */ } }
}

function analizar(raiz, opts = {}) {
  const grafo = path.join(raiz, '.agentic', 'grafo');
  const modulos = opts.modulos && opts.modulos.length
    ? opts.modulos
    : listar(grafo, (f) => f.endsWith('.cjs')).map((f) => path.basename(f));

  const fuentes = invocadoresRuntime(raiz).map((f) => {
    try { return { file: f, texto: sinComentarios(fs.readFileSync(f, 'utf8')) }; } catch { return null; }
  }).filter(Boolean);
  const tests = listar(path.join(raiz, 'test'), (f) => f.endsWith('.test.cjs')).map((f) => {
    try { return { rel: path.relative(raiz, f).split(path.sep).join('/'), texto: sinComentarios(fs.readFileSync(f, 'utf8')) }; } catch { return null; }
  }).filter(Boolean);
  const papel = papelAceptado(raiz);
  const corrida = ultimaCorrida(raiz);
  const libreta = huellas(raiz);
  const camino = alcanzables(raiz, fuentes, papel);

  const filas = modulos.map((nombre) => {
    const abs = path.join(grafo, nombre);
    const installed = fs.existsSync(abs);
    const re = referencia(nombre);
    const via = camino.get(nombre) || null;
    const wired = !installed ? false : via === 'declarado' ? 'declarado' : !!via;

    let executed = null;
    let evidencia = 'sin fuente de huella';
    const fuente = EVIDENCIA[nombre];
    if (fuente && fuente.gate) {
      if (libreta === null) evidencia = 'libreta no disponible';
      else {
        const h = libreta[fuente.gate];
        executed = !!h;
        evidencia = h ? `gate '${fuente.gate}': ${h.n} evento(s), último ${h.ultimo}` : `gate '${fuente.gate}': 0 eventos`;
      }
    } else if (fuente && fuente.archivo) {
      const ev = path.join(raiz, fuente.archivo);
      executed = fs.existsSync(ev);
      evidencia = executed ? `${fuente.archivo} (${fs.statSync(ev).mtime.toISOString()})` : `${fuente.archivo} ausente`;
    }

    const conTest = tests.filter((t) => re.test(t.texto)).map((t) => t.rel);
    let verified = false;
    let verificacion = conTest.length ? 'sin corrida registrada' : 'ningún test lo usa';
    if (conTest.length && corrida) {
      const pasaron = conTest.filter((t) => corrida.archivos && corrida.archivos[t] && corrida.archivos[t].pass > 0 && corrida.archivos[t].fail === 0);
      const cambioDespues = installed && fs.statSync(abs).mtimeMs > Date.parse(corrida.ts);
      if (cambioDespues) verificacion = 'el módulo cambió después de la última corrida';
      else if (pasaron.length) { verified = true; verificacion = 'pasó: ' + pasaron.join(', '); }
      else verificacion = 'sus tests no pasaron (o no se corrieron) en la última corrida';
    }

    return { modulo: nombre, installed, wired, via, executed, evidencia, verified, verificacion };
  });

  const presentes = listar(grafo, (f) => f.endsWith('.cjs')).map((f) => path.basename(f));
  const pendientes = PENDIENTES.map((p) => {
    const mods = presentes.filter((m) => p.patron.test(m));
    return { id: p.id, estado: mods.length ? 'instalada' : 'no_integrada', modulos: mods };
  });

  return { modulos: filas, pendientes, corrida: corrida ? { ts: corrida.ts, status: corrida.status } : null };
}

function formatear(r) {
  const s = (v) => (v === true ? 'sí' : v === false ? 'no' : v === null ? '¿?' : String(v));
  const lineas = ['CAPACIDADES — instalado / cableado / ejecutado / verificado', ''];
  for (const m of r.modulos) {
    lineas.push(`  ${m.modulo.padEnd(28)} inst:${s(m.installed).padEnd(3)} cabl:${s(m.wired).padEnd(9)} ejec:${s(m.executed).padEnd(3)} verif:${s(m.verified)}`);
  }
  lineas.push('', '  Capacidades del plan aún sin anunciar:');
  for (const p of r.pendientes) lineas.push(`   · ${p.id}: ${p.estado}${p.modulos.length ? ' (' + p.modulos.join(', ') + ')' : ''}`);
  lineas.push('', r.corrida ? `  Última corrida de tests: ${r.corrida.ts} (status ${r.corrida.status})` : '  Sin corrida de tests registrada — nada cuenta como verificado.');
  return lineas.join('\n');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const modulos = args.filter((a) => !a.startsWith('--'));
  const r = analizar(process.cwd(), { modulos });
  console.log(json ? JSON.stringify(r, null, 2) : formatear(r));
}

module.exports = { analizar, formatear, sinComentarios, EVIDENCIA, PENDIENTES };
