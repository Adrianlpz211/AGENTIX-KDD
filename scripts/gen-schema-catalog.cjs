#!/usr/bin/env node
'use strict';
/**
 * Genera .agentic/grafo/schema-catalog.data.json a partir de EVIDENCIA:
 * los esquemas reales que producen los motores publicados (3.19.0 y 3.20.0),
 * más las tablas/columnas que el motor crea de forma perezosa y que no
 * aparecen hasta que alguien usa esa función.
 *
 *   node scripts/gen-schema-catalog.cjs <memoria-3.19.db> <memoria-3.20.db>
 *
 * No se escribe a mano un catálogo de 35 tablas: sale de bases reales y un
 * test (test/schema-catalog.test.cjs) comprueba que un motor recién arrancado
 * no crea nada que el catálogo desconozca.
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const [, , db319, db320] = process.argv;
if (!db319 || !db320) { console.error('uso: gen-schema-catalog.cjs <memoria-3.19.db> <memoria-3.20.db>'); process.exit(2); }

function leer(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  const tablas = {}, objetos = {};
  for (const o of db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()) {
    if (o.type === 'table') {
      tablas[o.name] = {
        sql: o.sql,
        cols: db.prepare(`PRAGMA table_info("${o.name}")`).all().map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, dflt: c.dflt_value, pk: c.pk })),
      };
    } else {
      objetos[o.name] = { type: o.type, tbl: o.tbl_name, sql: o.sql };
    }
  }
  db.close();
  return { tablas, objetos };
}

const v319 = leer(db319), v320 = leer(db320);
const ifNotExists = (sql) => sql.replace(/^\s*CREATE\s+(UNIQUE\s+)?(TABLE|INDEX|TRIGGER)\s+(?!IF NOT EXISTS)/i, (m, u, k) => `CREATE ${u ? 'UNIQUE ' : ''}${k.toUpperCase()} IF NOT EXISTS `);
const sinComentarios = (sql) => sql.replace(/--[^\n]*/g, '').replace(/[ \t]+\n/g, '\n');

/* Funciones que el motor crea al usarlas y que una corrida corta no dispara.
   DDL tomado literalmente del código fuente que las crea. */
const TABLAS_EXTRA = {
  file_fingerprints: { since: '3.19.0', create: "CREATE TABLE IF NOT EXISTS file_fingerprints (file TEXT PRIMARY KEY, content_hash TEXT NOT NULL, structural_sig TEXT, supported INTEGER DEFAULT 0, updated_at TEXT DEFAULT (datetime('now')), body_hash TEXT)", fuente: 'change-classifier.cjs' },
  code_summaries: { since: '3.19.0', create: "CREATE TABLE IF NOT EXISTS code_summaries (file TEXT NOT NULL, symbol TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL, lang TEXT DEFAULT 'es', structural_sig TEXT, content_hash TEXT, generated_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (file, symbol))", fuente: 'code-summaries.cjs' },
  contract_executions: { since: '3.20.0', create: "CREATE TABLE IF NOT EXISTS contract_executions (contract_id TEXT NOT NULL, execution_id TEXT NOT NULL, subject_hash TEXT, status TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (contract_id, execution_id))", fuente: 'contract-guard.cjs migrateSchemaV2' },
  metadata: { since: '3.19.0', create: 'CREATE TABLE IF NOT EXISTS metadata (clave TEXT PRIMARY KEY, valor TEXT)', fuente: 'grafo.cjs' },
};
/* Columnas que solo añade una migración explícita del motor (no existen en una
   base que nunca la corrió) o una función poco usada. */
const COLUMNAS_EXTRA = [
  { table: 'verified_contracts', column: 'test_id', type: 'TEXT', since: '3.20.0', fuente: 'contract-guard.cjs migrateSchemaV2' },
  { table: 'verified_contracts', column: 'runner_id', type: 'TEXT', since: '3.20.0', fuente: 'contract-guard.cjs migrateSchemaV2' },
  { table: 'verified_contracts', column: 'runner_command', type: 'TEXT', since: '3.20.0', fuente: 'contract-guard.cjs migrateSchemaV2' },
  { table: 'verified_contracts', column: 'mapping_status', type: 'TEXT', dflt: "'RESOLVED'", since: '3.20.0', fuente: 'contract-guard.cjs migrateSchemaV2' },
  { table: 'verified_contracts', column: 'last_execution_id', type: 'TEXT', since: '3.20.0', fuente: 'contract-guard.cjs migrateSchemaV2' },
];
/* SQLite NO permite ALTER TABLE ... ADD COLUMN con un DEFAULT no constante
   (p. ej. DEFAULT (datetime('now'))). Esas columnas fallaban en silencio en bases
   antiguas. Se detectan por su default y se migran explícitamente: columna sin
   default + relleno declarado + trigger que reproduce el default. */
/* Derivadas: se reconstruyen desde otra fuente (código, FTS). */
const DERIVADAS = ['ast_symbols', 'ast_edges', 'ast_index_runs', 'file_fingerprints'];

const tablas = {};
for (const [nombre, t] of Object.entries(v320.tablas)) {
  const en319 = !!v319.tablas[nombre];
  const cols319 = new Set(en319 ? v319.tablas[nombre].cols.map((c) => c.name) : []);
  tablas[nombre] = {
    since: en319 ? '3.19.0' : '3.20.0',
    create: ifNotExists(sinComentarios(t.sql)),
    columns: t.cols.map((c) => ({ name: c.name, type: c.type, pk: c.pk, notnull: c.notnull, dflt: c.dflt, since: !en319 || cols319.has(c.name) ? (en319 ? '3.19.0' : '3.20.0') : '3.20.0' })),
    indexes: [],
  };
}
for (const [nombre, t] of Object.entries(TABLAS_EXTRA)) {
  if (tablas[nombre]) continue;
  tablas[nombre] = { since: t.since, create: t.create, columns: [], indexes: [], fuente: t.fuente };
}
for (const c of COLUMNAS_EXTRA) {
  const t = tablas[c.table];
  if (!t.columns.some((x) => x.name === c.column)) t.columns.push({ name: c.column, type: c.type, dflt: c.dflt || null, pk: 0, since: c.since, fuente: c.fuente });
}
/* Columnas de las tablas extra: se leen del propio DDL con SQLite en memoria. */
{
  const mem = new DatabaseSync(':memory:');
  for (const [nombre, t] of Object.entries(TABLAS_EXTRA)) {
    mem.exec(t.create);
    tablas[nombre].columns = mem.prepare(`PRAGMA table_info("${nombre}")`).all().map((c) => ({ name: c.name, type: c.type, pk: c.pk, notnull: c.notnull, dflt: c.dflt_value, since: t.since }));
  }
  mem.close();
}
/* Tablas que añade 3.20.1 (memoria con evidencia, cola, compresión, TEAMS): el DDL vive
   en scripts/memory-ddl-3201.cjs. Ningún motor publicado las tiene. */
{
  const { TABLAS_3_20_1, SINCE } = require('./memory-ddl-3201.cjs');
  const mem = new DatabaseSync(':memory:');
  for (const [nombre, t] of Object.entries(TABLAS_3_20_1)) {
    if (v319.tablas[nombre] || v320.tablas[nombre]) throw new Error('la tabla ' + nombre + ' ya existe en un motor publicado: no es nueva de ' + SINCE);
    mem.exec(t.create);
    const columns = mem.prepare('PRAGMA table_info("' + nombre + '")').all().map((c) => ({ name: c.name, type: c.type, pk: c.pk, notnull: c.notnull, dflt: c.dflt_value, since: SINCE }));
    const indexes = t.indexes.map((ddl) => { mem.exec(ddl); const m = /INDEX\s+IF NOT EXISTS\s+(\w+)/i.exec(ddl); return { name: m[1], since: SINCE, unique: /^\s*CREATE\s+UNIQUE/i.test(ddl), ddl }; });
    tablas[nombre] = { since: SINCE, create: t.create, columns, indexes, fuente: 'scripts/memory-ddl-3201.cjs' };
  }
  mem.close();
}
const RELLENO_GENERICO = ['fecha_update', 'fecha_creacion', 'created_at', 'fecha'];
for (const [nt, t] of Object.entries(tablas)) {
  for (const c of t.columns) {
    if (c.dflt && /\w\s*\(/.test(String(c.dflt))) c.dynamicDefault = { expr: String(c.dflt), relleno: RELLENO_GENERICO.filter((x) => x !== c.name) };
  }
}
const triggers = [], indices = [];
for (const [nombre, o] of Object.entries(v320.objetos)) {
  if (o.type === 'index') {
    tablas[o.tbl].indexes.push({ name: nombre, since: v319.objetos[nombre] ? '3.19.0' : '3.20.0', unique: /^\s*CREATE\s+UNIQUE/i.test(o.sql), ddl: ifNotExists(o.sql) });
    indices.push(nombre);
  } else if (o.type === 'trigger') {
    triggers.push({ name: nombre, table: o.tbl, ddl: ifNotExists(o.sql), since: v319.objetos[nombre] ? '3.19.0' : '3.20.0' });
  }
}
for (const t of Object.values(tablas)) t.indexes.sort((a, b) => a.name.localeCompare(b.name));

const salida = {
  catalog_version: 1,
  generated_from: { engines: ['3.19.0', '3.20.0'], note: 'esquemas reales de los paquetes publicados + DDL de funciones perezosas del código fuente + tablas nuevas de 3.20.1 (scripts/memory-ddl-3201.cjs)' },
  derived_tables: DERIVADAS,
  tables: Object.fromEntries(Object.entries(tablas).sort(([a], [b]) => a.localeCompare(b))),
  triggers,
};
const destino = path.join(__dirname, '..', '.agentic', 'grafo', 'schema-catalog.data.json');
fs.writeFileSync(destino, JSON.stringify(salida, null, 1) + '\n');
console.log('catálogo escrito:', path.relative(process.cwd(), destino));
console.log('tablas:', Object.keys(salida.tables).length, '· columnas:', Object.values(salida.tables).reduce((n, t) => n + t.columns.length, 0), '· índices:', indices.length, '· triggers:', triggers.length);
