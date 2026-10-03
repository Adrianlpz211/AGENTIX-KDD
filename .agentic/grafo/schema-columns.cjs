'use strict';

/**
 * Schema Columns — compatibilidad (3.20.1)
 *
 * Hasta 3.19 este archivo lanzaba cada ALTER TABLE conocido y se tragaba el
 * error ("falla si ya existe, que es el caso normal"). Eso mezclaba "ya existe"
 * con "falló de verdad": SQLite no admite ALTER ... ADD COLUMN con un DEFAULT no
 * constante (p. ej. DEFAULT (datetime('now'))) y esas columnas no se añadían
 * NUNCA en bases antiguas, sin que nadie lo notara.
 *
 * Ahora la fuente de verdad es schema-catalog.cjs, que INSPECCIONA la estructura,
 * aplica solo lo que falta, aborta ante un fallo y verifica las postcondiciones.
 *
 *   node schema-columns.cjs check   — qué falta, sin tocar nada
 *   node schema-columns.cjs fix     — migra con respaldo coherente y transacción
 *
 * Las funciones ensureAllColumns/checkMissingColumns se conservan por
 * compatibilidad, pero ya NO modifican la base: abrir para trabajar no migra.
 */
const path = require('path');
const fs = require('fs');
const catalogo = require('./schema-catalog.cjs');

/** Solo diagnóstico: qué falta de verdad. No escribe. */
function checkMissingColumns(db) { return catalogo.faltantes(db); }

/** Compatibilidad: ya no migra. Informa lo pendiente; la migración es `akdd update` o `fix`. */
function ensureAllColumns(db) {
  const faltan = catalogo.faltantes(db);
  return { total: catalogo.unidades().length, aplicadas: 0, pendientes: faltan };
}

if (require.main === module) {
  const cmd = process.argv[2] || 'check';
  const root = process.cwd();
  const dbPath = path.join(root, '.agentic', 'memoria.db');
  if (!fs.existsSync(dbPath)) { console.log('Sin memoria.db en este proyecto.'); process.exit(0); }
  const dba = require('./db-adapter.cjs');
  if (cmd === 'check') {
    const db = dba.openReadOnly(dbPath);
    try {
      const r = catalogo.inspect(db);
      if (r.status === 'COMPLETE') console.log('✅ El esquema coincide con el catálogo.');
      else { console.log('⚠️  Esquema ' + r.status + ': ' + (r.pending.map((p) => p.id).join(', ') || r.conflicts.map((c) => c.message).join('; ')) + '\n   Corre: akdd update'); process.exitCode = 1; }
    } finally { db.close(); }
  } else if (cmd === 'fix') {
    const r = dba.migrate(dbPath, { run(db) { const a = catalogo.apply(db, { actor: 'schema-columns fix' }); return { applied: a.applied.length, adopted: a.adopted.length }; } });
    console.log('✅ Esquema migrado (respaldo: ' + r.backupPath + ') — ' + JSON.stringify(r.detalle));
  } else {
    console.log('Uso: node schema-columns.cjs <check|fix>');
  }
}

module.exports = { ensureAllColumns, checkMissingColumns };
