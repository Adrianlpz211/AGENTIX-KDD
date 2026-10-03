'use strict';
/**
 * Bases SQLite reales para las pruebas de update.
 *
 * Un `memoria.db` de texto plano no es una base: el update lo trata (con razón)
 * como ilegible y se bloquea. Estas bases se crean con el MISMO esquema que
 * produce el motor publicado y con contenido que un consumidor sí podría perder.
 */
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const dba = require(path.join(REPO, '.agentic', 'grafo', 'db-adapter.cjs'));
const inv = require(path.join(REPO, '.agentic', 'grafo', 'memory-inventory.cjs'));
const SCHEMA = fs.readFileSync(path.join(REPO, '.agentic', 'grafo', 'schema.sql'), 'utf8');

/** Base con el esquema de schema.sql (la línea base 3.19), datos del consumidor y tablas propias. */
function crearBase(dbPath, { nodos = 5, propias = true } = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  dba.initialize(dbPath, SCHEMA);
  const db = dba.openWrite(dbPath, { updateOwner: true });
  try {
    for (let i = 0; i < nodos; i++) {
      db.run('INSERT INTO nodos (tipo, titulo, contenido, area, confianza) VALUES (?,?,?,?,?)', ['patron', 'REGLA_' + i, 'Memoria original ' + i + ' ñandú', 'auth', i % 2 ? 'ALTA' : 'MEDIA']);
    }
    if (propias) {
      db.exec('CREATE TABLE consumidor (a INTEGER, b TEXT, c BLOB, d, PRIMARY KEY (a, b)) WITHOUT ROWID');
      db.run('INSERT INTO consumidor VALUES (?,?,?,?)', [9223372036854775807n, 'ñ', Buffer.from([0, 255, 1]), 1.5]);
      db.run('INSERT INTO consumidor VALUES (?,?,?,?)', [-5n, '', null, null]);
      db.exec('CREATE TABLE duplicados (x TEXT)');
      db.run("INSERT INTO duplicados VALUES ('a')");
      db.run("INSERT INTO duplicados VALUES ('a')");
      db.exec('CREATE INDEX idx_consumidor_propio ON duplicados(x)');
      db.exec('CREATE VIEW v_consumidor AS SELECT x FROM duplicados');
    }
  } finally { db.close(); }
  return dbPath;
}

/** Inventario de contenido de una base (solo lectura). */
function inventario(dbPath, opts) {
  const db = dba.openReadOnly(dbPath);
  try { return inv.takeInventory(db, opts); } finally { db.close(); }
}

/** ¿Se conservó todo lo que había antes? Compara por CONTENIDO, no por bytes del archivo. */
function conservada(antes, dbPath) {
  const despues = inventario(dbPath, { columnsFrom: antes });
  return inv.compare(antes, despues);
}

module.exports = { crearBase, inventario, conservada, dba, inv, REPO };
