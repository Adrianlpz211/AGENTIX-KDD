'use strict';
const path = require('path');
const fs   = require('fs');

// Límites del grafo 2D. Se declaran en la respuesta: un recorte que nadie ve
// hace creer que el proyecto tiene menos memoria de la que tiene.
const LIMITES = { nodos: 600, contratos: 150, ciclos: 60 };

/** Abre memoria.db SOLO lectura; nunca crea el archivo ni toca su esquema. */
function abrirSoloLectura(dbPath) {
  try {
    const { DatabaseSync } = require('node:sqlite');
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return new (require('better-sqlite3'))(dbPath, { readonly: true, fileMustExist: true });
  }
}

function vacio(estado, errores) {
  return {
    schema_version: 1, status: estado, source: 'sqlite', generated_at: new Date().toISOString(),
    nodes: [], links: [], stats: { total_nodes: 0, total_links: 0, by_type: {} },
    coverage: {}, limits: LIMITES, errors: errores || [],
  };
}

function exportGraph(projectRoot) {
  const dbPath = path.join(projectRoot, '.agentic', 'memoria.db');
  if (!fs.existsSync(dbPath)) return vacio('SIN_MEMORIA', [{ seccion: 'memoria', reason_code: 'DB_AUSENTE' }]);

  let db;
  try { db = abrirSoloLectura(dbPath); } catch (e) { return vacio('ERROR', [{ seccion: 'memoria', reason_code: 'DB_NO_ABRE', detalle: String(e.message).slice(0, 160) }]); }

  const nodes = [];
  const links = [];
  const nodeIds = new Set();
  const coverage = {};
  const errors = [];
  const seccion = (nombre, fn) => { try { fn(); } catch (e) { errors.push({ seccion: nombre, reason_code: /no such table/i.test(e.message) ? 'TABLA_AUSENTE' : 'CONSULTA_FALLA', detalle: String(e.message).slice(0, 160) }); } };
  const contar = (sql) => Number((db.prepare(sql).get() || {}).n || 0);

  try {
    seccion('nodos', () => {
      const total = contar('SELECT COUNT(*) n FROM nodos');
      const obsoletos = contar("SELECT COUNT(*) n FROM nodos WHERE estado = 'OBSOLETO'");
      const nodos = db.prepare(`
        SELECT id, titulo, tipo, area, confianza, estado, aplicado, util, accesos_total, decay_score
        FROM nodos WHERE estado IS NULL OR estado != 'OBSOLETO' ORDER BY accesos_total DESC LIMIT ?
      `).all(LIMITES.nodos);
      nodos.forEach(n => {
        const id = 'n_' + n.id;
        nodeIds.add(id);
        nodes.push({
          id,
          label: (n.titulo || '').substring(0, 50),
          tipo: n.tipo || 'global',
          area: n.area || '',
          confianza: n.confianza || '',
          estado: n.estado || '',
          aplicado: n.aplicado || 0,
          accesos: n.accesos_total || 0,
          val: Math.max(2, Math.log((n.accesos_total || 0) + 1) * 3 + 2),
        });
      });
      coverage.nodos = { total, shown: nodos.length, excluded: { obsoletos }, truncated: total - obsoletos > nodos.length, limit: LIMITES.nodos };
    });

    seccion('contratos', () => {
      const total = contar("SELECT COUNT(*) n FROM verified_contracts WHERE status != 'deprecated'");
      const contratos = db.prepare(`
        SELECT id, name, module, risk_level, status, consecutive_passes, verification_count
        FROM verified_contracts WHERE status != 'deprecated' LIMIT ?
      `).all(LIMITES.contratos);
      contratos.forEach(c => {
        const id = 'c_' + c.id;
        nodeIds.add(id);
        nodes.push({
          id,
          label: (c.name || '').substring(0, 50),
          tipo: 'contrato',
          area: c.module || '',
          confianza: c.risk_level || '',
          // Estado real del contrato: uno sin verificar no se pinta como ACTIVO.
          estado: c.status || '',
          aplicado: c.verification_count || 0,
          accesos: c.consecutive_passes || 0,
          val: Math.max(3, Math.log((c.consecutive_passes || 0) + 1) * 3 + 3),
        });
      });
      coverage.contratos = { total, shown: contratos.length, truncated: total > contratos.length, limit: LIMITES.contratos };
    });

    seccion('ciclos', () => {
      const total = contar("SELECT COUNT(*) n FROM ciclos WHERE estado LIKE 'COMPLETADO%'");
      const ciclos = db.prepare(`
        SELECT id, ciclo_id, modulo, area, estado, tests_pasando, fecha_fin
        FROM ciclos WHERE estado LIKE 'COMPLETADO%' ORDER BY fecha_inicio DESC LIMIT ?
      `).all(LIMITES.ciclos);
      ciclos.forEach(c => {
        const id = 'ci_' + c.id;
        nodeIds.add(id);
        nodes.push({
          id,
          label: (c.modulo || c.area || 'ciclo').substring(0, 40),
          tipo: 'ciclo',
          area: c.area || '',
          confianza: '',
          estado: c.estado || '',
          clase: require('./estado-ciclo.cjs').clasificar(c.estado),
          aplicado: c.tests_pasando || 0,
          accesos: 1,
          val: 2.5,
        });
      });
      coverage.ciclos = { total, shown: ciclos.length, truncated: total > ciclos.length, limit: LIMITES.ciclos };
    });

    seccion('relaciones', () => {
      const rels = db.prepare('SELECT desde_id, hacia_id, tipo FROM relaciones').all();
      rels.forEach(r => {
        const src = 'n_' + r.desde_id;
        const tgt = 'n_' + r.hacia_id;
        if (nodeIds.has(src) && nodeIds.has(tgt)) links.push({ source: src, target: tgt, tipo: r.tipo || 'rel' });
      });
      coverage.relaciones = { total: rels.length, shown: links.length, truncated: links.length < rels.length };
    });
  } finally {
    try { db.close(); } catch { /* ya cerrada */ }
  }

  const counts = {};
  nodes.forEach(n => { counts[n.tipo] = (counts[n.tipo] || 0) + 1; });

  return {
    schema_version: 1,
    status: errors.length ? 'PARCIAL' : 'OK',
    source: 'sqlite',
    generated_at: new Date().toISOString(),
    nodes, links,
    stats: { total_nodes: nodes.length, total_links: links.length, by_type: counts },
    coverage, limits: LIMITES, errors,
  };
}

module.exports = { exportGraph, LIMITES };

if (require.main === module) {
  process.stdout.write(JSON.stringify(exportGraph(process.cwd())));
}
