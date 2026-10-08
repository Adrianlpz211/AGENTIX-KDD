'use strict';

/**
 * Lo que Agentix instala y mantiene en un proyecto — una sola lista para init
 * y para update. Todo lo que no está aquí es del proyecto y ninguno de los dos
 * comandos lo escribe.
 *
 *   dir   se recorre entero (cada archivo es managed)
 *   file  un archivo suelto
 *
 * Lo que va en `excluir` viaja en el repo de Agentix pero es del propio repo
 * (su memoria, sus specs, su conocimiento): no se siembra en otro proyecto.
 */

const fs = require('fs');
const path = require('path');

const MANAGED = [
  { rel: '.agentic/agentes', tipo: 'dir' },
  { rel: '.agentic/grafo', tipo: 'dir' },
  { rel: '.agentic/nucleo-reglas.md', tipo: 'file' },
  { rel: '.audit', tipo: 'dir' },
  { rel: '.cursor/rules', tipo: 'dir' },
  { rel: 'dashboard.cjs', tipo: 'file' },
  { rel: 'CLAUDE.md', tipo: 'file' },
  { rel: '_LOCKS.md', tipo: 'file' },
  { rel: '.cursorrules', tipo: 'file' },
];

/* Dentro de los directorios managed, nada de estado ni de datos locales. */
const EXCLUIR = [
  /(^|\/)node_modules\//,
  /(^|\/)\.model_cache\//,
  /\.agentix-backup$/,
  /(^|\/)_hooks\//,
  /\.db(-wal|-shm)?$/,
  /\.log$/,
];

const barra = (p) => String(p).split(path.sep).join('/');

function excluido(rel) {
  return EXCLUIR.some((re) => re.test(rel));
}

/** Archivos managed presentes bajo `base` (rutas relativas con '/'). */
function archivos(base) {
  const out = [];
  for (const m of MANAGED) {
    const abs = path.join(base, m.rel);
    let st;
    try { st = fs.lstatSync(abs); } catch { continue; }
    if (m.tipo === 'file') {
      if (st.isFile()) out.push(m.rel);
      continue;
    }
    if (!st.isDirectory()) continue;
    const pila = [abs];
    while (pila.length) {
      const dir = pila.pop();
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        const rel = barra(path.relative(base, p));
        if (e.isDirectory()) { if (!excluido(rel + '/')) pila.push(p); }
        else if (e.isFile() && !excluido(rel)) out.push(rel);
      }
    }
  }
  return out.sort();
}

function esManaged(rel) {
  const r = barra(rel);
  if (excluido(r)) return false;
  return MANAGED.some((m) => (m.tipo === 'file' ? r === m.rel : r.startsWith(m.rel + '/')));
}

module.exports = { MANAGED, EXCLUIR, archivos, esManaged, excluido };
