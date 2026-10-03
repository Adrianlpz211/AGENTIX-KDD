'use strict';
/**
 * Proyectos temporales con una memoria.db REAL de 3.20.1 para las pruebas de
 * memoria con evidencia, cola, compresión y TEAMS.
 *
 *   const { proyecto } = require('./helpers/memoria-proyecto.cjs');
 *   const p = proyecto('captura');                          // esquema completo (catálogo aplicado)
 *   const q = proyecto('sin-tablas', { catalogo: false });  // solo schema.sql: sin tablas mem_*
 *   const t = proyecto('texto', { idTexto: true });         // nodos.id TEXT (bases históricas)
 *
 * Es la misma construcción que hace grafo.cjs al crear una base nueva
 * (schema.sql + catálogo), no un esquema escrito a mano.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const real = require('./db-real.cjs');

const { dba, REPO } = real;
const catalogo = require(path.join(REPO, '.agentic', 'grafo', 'schema-catalog.cjs'));
const SCHEMA = fs.readFileSync(path.join(REPO, '.agentic', 'grafo', 'schema.sql'), 'utf8');

function proyecto(nombre, { catalogo: aplicar = true, nodos = 3, idTexto = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-mem-' + String(nombre).replace(/[^\w-]/g, '') + '-')));
  const dbPath = path.join(root, '.agentic', 'memoria.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  dba.initialize(dbPath, SCHEMA);
  const db = dba.openWrite(dbPath, { updateOwner: true });
  try {
    if (idTexto) {
      // Variante con id TEXT: así existen bases históricas de algunos consumidores.
      const cols = db.all('PRAGMA table_info(nodos)').map((c) => (c.name === 'id' ? 'id TEXT PRIMARY KEY' : c.name + ' ' + (c.type || '') + (c.dflt_value != null ? ' DEFAULT (' + c.dflt_value + ')' : '')));
      db.exec('DROP TABLE nodos; CREATE TABLE nodos (' + cols.join(', ') + ')');
    }
    if (aplicar) catalogo.apply(db, { version: '3.20.1', actor: 'test' });
    // Sin catálogo aplicado la tabla solo tiene las columnas de schema.sql: no hay vigencia_tipo.
    const conVigencia = db.all('PRAGMA table_info(nodos)').some((c) => c.name === 'vigencia_tipo');
    for (let i = 0; i < nodos; i++) {
      const valores = [...(idTexto ? ['regla_' + i] : []), 'patron', 'REGLA_' + i, 'Memoria original ' + i + ' ñandú', 'auth', i % 2 ? 'ALTA' : 'MEDIA', 'ACTIVO', ...(conVigencia ? ['VIGENTE'] : [])];
      db.run('INSERT INTO nodos (' + (idTexto ? 'id, ' : '') + 'tipo, titulo, contenido, area, confianza, estado' + (conVigencia ? ', vigencia_tipo' : '') + ') VALUES (' + valores.map(() => '?').join(',') + ')', valores);
    }
  } finally { db.close(); }
  const abrirW = () => dba.openWrite(dbPath, { updateOwner: true });
  const abrirR = () => dba.openReadOnly(dbPath);
  return { root, dbPath, abrirW, abrirR, limpiar() { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* en uso */ } } };
}

module.exports = { proyecto, REPO, dba, catalogo };
