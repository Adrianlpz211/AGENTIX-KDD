'use strict';
const path = require('path');
const fs   = require('fs');

function exportGraph(projectRoot) {
  const dbPath = path.join(projectRoot, '.agentic', 'memoria.db');
  if (!fs.existsSync(dbPath)) return { nodes: [], links: [], stats: {} };

  let db;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(dbPath);
  } catch {
    try { db = new (require('better-sqlite3'))(dbPath, { readonly: true }); } catch { return { nodes: [], links: [], stats: {} }; }
  }

  const nodes = [];
  const links = [];
  const nodeIds = new Set();

  // ── Nodos KDD ────────────────────────────────────────────────────────────────
  try {
    const nodos = db.prepare(`
      SELECT id, titulo, tipo, area, confianza, estado, aplicado, util, accesos_total, decay_score
      FROM nodos WHERE estado != 'OBSOLETO' ORDER BY accesos_total DESC LIMIT 600
    `).all();
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
  } catch {}

  // ── Contratos verificados ────────────────────────────────────────────────────
  try {
    const contratos = db.prepare(`
      SELECT id, name, module, risk_level, consecutive_passes, verification_count
      FROM verified_contracts WHERE status != 'deprecated' LIMIT 150
    `).all();
    contratos.forEach(c => {
      const id = 'c_' + c.id;
      nodeIds.add(id);
      nodes.push({
        id,
        label: (c.name || '').substring(0, 50),
        tipo: 'contrato',
        area: c.module || '',
        confianza: 'ALTA',
        estado: 'ACTIVO',
        aplicado: c.verification_count || 0,
        accesos: c.consecutive_passes || 0,
        val: Math.max(3, Math.log((c.consecutive_passes || 0) + 1) * 3 + 3),
      });
    });
  } catch {}

  // ── Ciclos recientes ─────────────────────────────────────────────────────────
  try {
    const ciclos = db.prepare(`
      SELECT id, ciclo_id, modulo, area, estado, tests_pasando, fecha_fin
      FROM ciclos WHERE estado = 'COMPLETADO' ORDER BY fecha_inicio DESC LIMIT 60
    `).all();
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
        aplicado: c.tests_pasando || 0,
        accesos: 1,
        val: 2.5,
      });
    });
  } catch {}

  // ── Relaciones ───────────────────────────────────────────────────────────────
  try {
    const rels = db.prepare('SELECT desde_id, hacia_id, tipo FROM relaciones').all();
    rels.forEach(r => {
      const src = 'n_' + r.desde_id;
      const tgt = 'n_' + r.hacia_id;
      if (nodeIds.has(src) && nodeIds.has(tgt)) {
        links.push({ source: src, target: tgt, tipo: r.tipo || 'rel' });
      }
    });
  } catch {}

  // ── Stats ────────────────────────────────────────────────────────────────────
  const counts = {};
  nodes.forEach(n => { counts[n.tipo] = (counts[n.tipo] || 0) + 1; });

  return { nodes, links, stats: { total_nodes: nodes.length, total_links: links.length, by_type: counts } };
}

module.exports = { exportGraph };

if (require.main === module) {
  process.stdout.write(JSON.stringify(exportGraph(process.cwd())));
}
