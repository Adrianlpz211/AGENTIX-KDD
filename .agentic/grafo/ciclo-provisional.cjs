#!/usr/bin/env node
'use strict';
/* CICLO PROVISIONAL — el trabajo editado y aún sin commit ya existe para Agentix.
 *
 * Hasta ahora, lo que se editaba y no se commiteaba era invisible: ni memoria, ni tiempo, ni tablero (68 archivos, 3 días, medinet). Este módulo lleva un
 * registro PROVISIONAL en `.agentic/_provisional.json` (archivo, no base: sin bloqueos, no ensucia métricas ni contratos):
 *   · `actualizar(root)` — fin de turno: guarda desde cuándo hay trabajo abierto, qué archivos, qué módulos y cuántas líneas;
 *   · `cerrar(root, sha)` — el cierre del ciclo (commit) lo convierte en definitivo: lo pasa al historial con el commit que lo absorbió y el tiempo real
 *     transcurrido desde que se abrió (dato que el reloj derivado usa como huella de arranque).
 * Nunca cuenta como ciclo ni como contrato: es constancia, no verificación. Nunca lanza.
 *
 *   node .agentic/grafo/ciclo-provisional.cjs [estado]
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ARCHIVO = (root) => path.join(root, '.agentic', '_provisional.json');
const HISTORIAL = (root) => path.join(root, '.agentic', '_provisional-historial.jsonl');

const git = (root, args) => { try { const r = spawnSync('git', ['-c', 'safe.directory=*', ...args], { cwd: root, encoding: 'utf8', timeout: 15000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }); return r.status === 0 ? r.stdout : null; } catch { return null; } };
const leer = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

function modulosDe(archivos) {
  const s = new Set();
  for (const f of archivos) { const p = f.split('/'); s.add(p.length > 1 ? (p[0] === 'src' && p[1] ? p[1] : p[0]) : '(raíz)'); }
  return [...s].slice(0, 12);
}

function lineas(root) {
  const out = git(root, ['diff', '--shortstat', 'HEAD']);
  const m = out && out.match(/(\d+) insertion.*?(\d+) deletion|(\d+) insertion|(\d+) deletion/);
  if (!out) return null;
  const ins = Number((out.match(/(\d+) insertion/) || [])[1] || 0); const del = Number((out.match(/(\d+) deletion/) || [])[1] || 0);
  return m ? ins + del : 0;
}

/** Fin de turno: abre o refresca el provisional. Con el árbol limpio, lo borra (nada abierto). */
function actualizar(root) {
  try {
    const archivos = require('./cobertura.cjs').archivosSinCommit(root);
    if (archivos == null) return null;
    const f = ARCHIVO(root);
    if (!archivos.length) { try { fs.unlinkSync(f); } catch { /* no había */ } return null; }
    const prev = leer(f); const ahora = new Date().toISOString();
    const dato = { estado: 'PROVISIONAL', desde: (prev && prev.desde) || ahora, ultimo: ahora, total: archivos.length, archivos: archivos.slice(0, 200), modulos: modulosDe(archivos), lineas_cambiadas: lineas(root) };
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(dato, null, 2));
    return dato;
  } catch { return null; }
}

/** Cierre del ciclo de un commit: lo provisional que ese commit absorbió pasa al historial. Devuelve el registro cerrado o null. */
function cerrar(root, sha) {
  try {
    const f = ARCHIVO(root); const p = leer(f);
    if (!p) return null;
    const commit = (git(root, ['rev-parse', '--verify', (sha && /^[0-9a-f]{7,64}$/i.test(sha)) ? sha : 'HEAD']) || '').trim() || null;
    const tocados = new Set((git(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', commit || 'HEAD']) || '').split(/\r?\n/).filter(Boolean));
    const absorbidos = (p.archivos || []).filter((a) => tocados.has(a));
    if (!absorbidos.length) return null;   // ese commit no era este trabajo
    const ms = Math.max(0, Date.now() - Date.parse(p.desde));
    const reg = { cerrado: new Date().toISOString(), commit, desde: p.desde, transcurrido_ms: ms, archivos_absorbidos: absorbidos.length, de_total: p.total, modulos: p.modulos };
    fs.appendFileSync(HISTORIAL(root), JSON.stringify(reg) + '\n');
    const quedan = (p.archivos || []).filter((a) => !tocados.has(a));
    if (quedan.length) fs.writeFileSync(f, JSON.stringify({ ...p, total: quedan.length, archivos: quedan, modulos: modulosDe(quedan) }, null, 2));
    else { try { fs.unlinkSync(f); } catch { /* ya no está */ } }
    return reg;
  } catch { return null; }
}

function estado(root) { return leer(ARCHIVO(root)); }

module.exports = { actualizar, cerrar, estado, ARCHIVO, HISTORIAL };

if (require.main === module) {
  const root = path.resolve(process.argv.find((a, i) => i > 1 && !a.startsWith('-') && a !== 'estado') || process.cwd());
  const e = actualizar(root);
  console.log(e ? `PROVISIONAL desde ${e.desde}: ${e.total} archivo(s) en ${e.modulos.join(', ')} (${e.lineas_cambiadas} líneas). Se cierra solo al hacer commit.` : 'Nada provisional: todo lo editado está commiteado.');
}
