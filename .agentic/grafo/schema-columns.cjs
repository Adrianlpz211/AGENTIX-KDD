'use strict';

/**
 * Schema Columns — fuente única de verdad de las columnas ALTER TABLE del motor
 * (v3.16.8, arreglo de raíz tras el bug de biocaresoft-saas)
 *
 * Causa estructural encontrada: las columnas de `nodos` se creaban repartidas
 * en 4 archivos distintos (grafo.cjs, knowledge-validator.cjs, gate-telemetry.cjs,
 * memory-audit.cjs), las de `protected_behaviors` en 2 (gate-telemetry.cjs,
 * regression-guard.cjs) — cada uno sin garantía de que otro corriera antes.
 * Además, 39 scripts del motor abren su PROPIA conexión a la DB (no pasan por
 * un punto central). Si un script escribe en una columna que solo otro script
 * crea, y ese otro nunca corrió, el INSERT truena — y como cada write está
 * envuelto en su propio try/catch "por las dudas", el fallo se traga en
 * silencio. Así se perdió el KDD Memory completo de un cliente nuevo.
 *
 * Este archivo no reemplaza los ALTER dispersos (tocar 6+ archivos a la vez
 * es más riesgo que beneficio) — los deja como respaldo redundante e
 * inofensivo (son idempotentes) y agrega EL lugar autoritativo que:
 *   1. Cualquier script nuevo puede llamar con una sola línea para no
 *      convertirse en otro islote más.
 *   2. `akdd health --fix` invoca para reparar CUALQUIER proyecto ya dañado,
 *      sin importar cuál combinación de columnas le falte.
 *   3. `migrateDB()` de grafo.cjs llama en cada `sync` (el camino más
 *      transitado — cada `aa:` y cada `akdd sync` pasa por ahí).
 *
 * Uso:
 *   require('./schema-columns.cjs').ensureAllColumns(db)
 *   node schema-columns.cjs check    — reporta qué falta, sin tocar nada
 *   node schema-columns.cjs fix      — aplica todo lo que falte
 */

const path = require('path');
const fs = require('fs');

const safe = (fn, fb = null) => { try { return fn(); } catch { return fb; } };

// Todas las ALTER TABLE ADD COLUMN conocidas del motor, en un solo lugar.
// Agregar una columna nueva a cualquier tabla = una línea aquí, nada más.
const COLUMNS = [
  // nodos — antes repartidas en grafo.cjs / knowledge-validator.cjs /
  // gate-telemetry.cjs / memory-audit.cjs
  { table: 'nodos', column: 'ultima_validacion', ddl: "ALTER TABLE nodos ADD COLUMN ultima_validacion TEXT DEFAULT (datetime('now'))" },
  { table: 'nodos', column: 'archivos_aplica',   ddl: "ALTER TABLE nodos ADD COLUMN archivos_aplica TEXT DEFAULT '[]'" },
  { table: 'nodos', column: 'hash_contexto',     ddl: "ALTER TABLE nodos ADD COLUMN hash_contexto TEXT" },
  { table: 'nodos', column: 'validation_score',  ddl: "ALTER TABLE nodos ADD COLUMN validation_score REAL DEFAULT 1.0" },
  { table: 'nodos', column: 'vigencia_tipo',     ddl: "ALTER TABLE nodos ADD COLUMN vigencia_tipo TEXT DEFAULT 'VIGENTE'" },
  { table: 'nodos', column: 'anclas',            ddl: "ALTER TABLE nodos ADD COLUMN anclas TEXT DEFAULT '[]'" },

  // protected_behaviors — antes repartidas en gate-telemetry.cjs / regression-guard.cjs
  { table: 'protected_behaviors', column: 'protected_symbols',  ddl: "ALTER TABLE protected_behaviors ADD COLUMN protected_symbols TEXT DEFAULT '[]'" },
  { table: 'protected_behaviors', column: 'anclas_obsoletas',   ddl: "ALTER TABLE protected_behaviors ADD COLUMN anclas_obsoletas TEXT DEFAULT '[]'" },

  // ciclos — antes repartidas en grafo.cjs / post-cycle.cjs
  { table: 'ciclos', column: 'tipo_tarea',        ddl: "ALTER TABLE ciclos ADD COLUMN tipo_tarea TEXT DEFAULT 'feature'" },
  { table: 'ciclos', column: 'memory_trace',      ddl: "ALTER TABLE ciclos ADD COLUMN memory_trace TEXT DEFAULT '[]'" },
  { table: 'ciclos', column: 'snapshot_inicio',   ddl: "ALTER TABLE ciclos ADD COLUMN snapshot_inicio TEXT" },
  { table: 'ciclos', column: 'snapshot_fin',      ddl: "ALTER TABLE ciclos ADD COLUMN snapshot_fin TEXT" },
  { table: 'ciclos', column: 'knowledge_loaded',  ddl: "ALTER TABLE ciclos ADD COLUMN knowledge_loaded TEXT DEFAULT '[]'" },
  { table: 'ciclos', column: 'ast_indexed',       ddl: "ALTER TABLE ciclos ADD COLUMN ast_indexed INTEGER DEFAULT 0" },
  { table: 'ciclos', column: 'modules_touched',   ddl: "ALTER TABLE ciclos ADD COLUMN modules_touched TEXT" },
  { table: 'ciclos', column: 'stack_detected',    ddl: "ALTER TABLE ciclos ADD COLUMN stack_detected TEXT" },
  { table: 'ciclos', column: 'post_cycle_ran',    ddl: "ALTER TABLE ciclos ADD COLUMN post_cycle_ran TEXT" },

  // fases
  { table: 'fases', column: 'duracion_ms',    ddl: "ALTER TABLE fases ADD COLUMN duracion_ms INTEGER DEFAULT 0" },
  { table: 'fases', column: 'tokens_aprox',   ddl: "ALTER TABLE fases ADD COLUMN tokens_aprox INTEGER DEFAULT 0" },
  { table: 'fases', column: 'harness_passed', ddl: "ALTER TABLE fases ADD COLUMN harness_passed INTEGER DEFAULT 1" },
  { table: 'fases', column: 'gate_result',    ddl: "ALTER TABLE fases ADD COLUMN gate_result TEXT" },

  // relaciones_semanticas
  { table: 'relaciones_semanticas', column: 'valid_at',    ddl: "ALTER TABLE relaciones_semanticas ADD COLUMN valid_at TEXT DEFAULT (datetime('now'))" },
  { table: 'relaciones_semanticas', column: 'invalid_at',  ddl: "ALTER TABLE relaciones_semanticas ADD COLUMN invalid_at TEXT" },
  { table: 'relaciones_semanticas', column: 'expired_at',  ddl: "ALTER TABLE relaciones_semanticas ADD COLUMN expired_at TEXT" },
  { table: 'relaciones_semanticas', column: 'episode_id',  ddl: "ALTER TABLE relaciones_semanticas ADD COLUMN episode_id TEXT" },
  { table: 'relaciones_semanticas', column: 'confidence',  ddl: "ALTER TABLE relaciones_semanticas ADD COLUMN confidence REAL DEFAULT 1.0" },
  { table: 'relaciones_semanticas', column: 'source',      ddl: "ALTER TABLE relaciones_semanticas ADD COLUMN source TEXT" },
  { table: 'relaciones_semanticas', column: 'context',     ddl: "ALTER TABLE relaciones_semanticas ADD COLUMN context TEXT" },

  // gate_events / episodios / ast_symbols
  { table: 'gate_events', column: 'source',       ddl: "ALTER TABLE gate_events ADD COLUMN source TEXT DEFAULT 'protocol'" },
  { table: 'episodios',   column: 'embedding',    ddl: "ALTER TABLE episodios ADD COLUMN embedding TEXT" },
  { table: 'ast_symbols', column: 'line_end',     ddl: "ALTER TABLE ast_symbols ADD COLUMN line_end INTEGER DEFAULT 0" },
  { table: 'ast_symbols', column: 'content_hash', ddl: "ALTER TABLE ast_symbols ADD COLUMN content_hash TEXT" },
];

/** Corre TODOS los ALTER conocidos. Idempotente y silencioso a propósito
 *  (fallan si la columna ya existe, que es el caso normal) — pero a
 *  diferencia de las copias dispersas, este es el lugar que TODO entry point
 *  nuevo debería llamar, en vez de inventar su propio islote de migración. */
function ensureAllColumns(db) {
  let aplicadas = 0;
  for (const c of COLUMNS) {
    const ok = safe(() => { db.exec(c.ddl); return true; }, false);
    if (ok) aplicadas++;
  }
  return { total: COLUMNS.length, aplicadas };
}

/** Solo diagnóstico — qué columnas faltan de verdad, sin tocar nada. Usa
 *  PRAGMA table_info, que no falla si la tabla no existe (da lista vacía). */
function checkMissingColumns(db) {
  const faltantes = [];
  const porTabla = {};
  for (const c of COLUMNS) {
    if (!porTabla[c.table]) {
      porTabla[c.table] = safe(() => db.prepare(`PRAGMA table_info(${c.table})`).all().map(r => r.name), []);
    }
    if (!porTabla[c.table].includes(c.column)) faltantes.push(`${c.table}.${c.column}`);
  }
  return faltantes;
}

function openDB(root) {
  const dbPath = path.join(root, '.agentic', 'memoria.db');
  if (!fs.existsSync(dbPath)) return null;
  try { return new (require('better-sqlite3'))(dbPath); }
  catch { try { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(dbPath); } catch { return null; } }
}

if (require.main === module) {
  const cmd = process.argv[2] || 'check';
  const root = process.cwd();
  const db = openDB(root);
  if (!db) { console.log('Sin memoria.db en este proyecto.'); process.exit(0); }

  if (cmd === 'check') {
    const faltan = checkMissingColumns(db);
    console.log(faltan.length
      ? `⚠️  Faltan ${faltan.length} columna(s): ${faltan.join(', ')}\n   Corre: node .agentic/grafo/schema-columns.cjs fix`
      : '✅ Todas las columnas conocidas están presentes.');
  } else if (cmd === 'fix') {
    const r = ensureAllColumns(db);
    console.log(`✅ Schema verificado — ${r.total} columnas conocidas revisadas/aplicadas.`);
  } else {
    console.log('Uso: node schema-columns.cjs <check|fix>');
  }
  safe(() => db.close());
}

module.exports = { ensureAllColumns, checkMissingColumns, COLUMNS };
