#!/usr/bin/env node
'use strict';

/**
 * Agentic KDD — Area Backfill
 *
 * Re-etiqueta nodos ya existentes en memoria.db que quedaron en area='global'
 * porque errores.md/decisiones.md nunca tuvieron un campo "Área:" explícito
 * (ver area-detector.cjs para el detalle completo del bug). Corre el mismo
 * inferidor sobre título+contenido de cada nodo 'global' y actualiza el área
 * SOLO si se infiere algo más específico que 'global'.
 *
 * Uso:
 *   node .agentic/grafo/area-backfill.cjs           → dry-run, solo reporta
 *   node .agentic/grafo/area-backfill.cjs --apply    → aplica los cambios
 */

const path = require('path');
const { inferirAreaDesdeTexto } = require('./area-detector.cjs');

const ROOT = process.cwd();
const DB_PATH = path.join(ROOT, '.agentic', 'memoria.db');

function openDB() {
  try { return { db: new (require('better-sqlite3'))(DB_PATH), tipo: 'better-sqlite3' }; } catch {}
  try { const { DatabaseSync } = require('node:sqlite'); return { db: new DatabaseSync(DB_PATH), tipo: 'node:sqlite' }; } catch {}
  throw new Error('No hay driver de SQLite disponible (ni better-sqlite3 ni node:sqlite)');
}

function main() {
  const apply = process.argv.includes('--apply');
  const { db } = openDB();

  const nodos = db.prepare(`
    SELECT id, tipo, titulo, contenido, area
    FROM nodos
    WHERE area = 'global'
  `).all();

  const cambios = [];
  for (const n of nodos) {
    const nuevaArea = inferirAreaDesdeTexto(n.titulo, n.contenido || '');
    if (nuevaArea !== 'global') {
      cambios.push({ id: n.id, tipo: n.tipo, titulo: n.titulo.slice(0, 70), de: n.area, a: nuevaArea });
    }
  }

  console.log(`\nArea Backfill — ${apply ? 'APLICANDO' : 'DRY-RUN (usa --apply para escribir)'}`);
  console.log(`Nodos en 'global': ${nodos.length}`);
  console.log(`Se re-etiquetarían: ${cambios.length}\n`);

  cambios.forEach(c => {
    console.log(`  [${c.tipo}] "${c.titulo}" — global → ${c.a}`);
  });

  if (apply && cambios.length > 0) {
    const update = db.prepare(`UPDATE nodos SET area = ?, fecha_update = datetime('now') WHERE id = ?`);
    for (const c of cambios) update.run(c.a, c.id);
    console.log(`\n✅ ${cambios.length} nodos actualizados en memoria.db`);
  } else if (!apply && cambios.length > 0) {
    console.log(`\nNada escrito todavía — corre con --apply para aplicar estos cambios.`);
  } else {
    console.log(`\nNo hay nada que cambiar.`);
  }

  if (db.close) db.close();
}

if (require.main === module) main();

module.exports = { main };
