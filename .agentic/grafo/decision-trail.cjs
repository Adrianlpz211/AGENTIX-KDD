/**
 * Agentic KDD — Decision Trail v1.0
 * Observabilidad de decisiones: qué cambió, por qué, qué memoria influyó, impacto, qué quedó invalidado.
 *
 * Cierra el Gap #2 de observabilidad identificado en el análisis de frameworks 2026.
 * El sistema ya tiene la data — este módulo la hace queryable y explicable.
 *
 * Uso:
 *   node .agentic/grafo/decision-trail.cjs ciclo [ciclo_id]
 *   node .agentic/grafo/decision-trail.cjs recent [N]
 *   node .agentic/grafo/decision-trail.cjs why [archivo_o_entidad]
 *   node .agentic/grafo/decision-trail.cjs diff [desde_ciclo] [hasta_ciclo]
 *   node .agentic/grafo/decision-trail.cjs timeline [módulo]
 */

'use strict';

const fs   = require('fs');
const path = require('path');

function openDB(projectRoot) {
  const dbPath = path.join(projectRoot, '.agentic/memoria.db');
  try { return new (require('better-sqlite3'))(dbPath); } catch {}
  try { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(dbPath); } catch {}
  throw new Error('No SQLite driver disponible');
}

// ─── TRAIL COMPLETO DE UN CICLO ───────────────────────────────────────────────

/**
 * Retorna el trail completo de un ciclo: qué pasó, qué memoria se leyó,
 * qué se decidió, qué cambió, qué quedó en memoria.
 */
function getCicloTrail(db, cicloId) {
  // Datos del ciclo
  let ciclo;
  try {
    ciclo = db.prepare(`SELECT * FROM ciclos WHERE ciclo_id = ?`).get(cicloId);
  } catch { return null; }
  if (!ciclo) return null;

  // Fases del ciclo
  let fases = [];
  try {
    fases = db.prepare(`SELECT * FROM fases WHERE ciclo_id = ? ORDER BY fase_num`).all(cicloId);
  } catch {}

  // Episodios del ciclo
  let episodios = [];
  try {
    episodios = db.prepare(`SELECT * FROM episodios WHERE ciclo_id = ? ORDER BY fecha`).all(cicloId);
  } catch {}

  // Nodos creados/actualizados en este ciclo (por fecha)
  let nodosAfectados = [];
  try {
    nodosAfectados = db.prepare(`
      SELECT titulo, tipo, confianza, estado, area, fecha_update
      FROM nodos
      WHERE fecha_update >= ? AND fecha_update <= COALESCE(?, datetime('now'))
      ORDER BY fecha_update
    `).all(ciclo.fecha_inicio, ciclo.fecha_fin);
  } catch {}

  // Edges causales creados en este ciclo (via episode_id)
  let edgesCausales = [];
  try {
    const episodeIds = episodios.map(e => e.episodio_id).filter(Boolean);
    if (episodeIds.length > 0) {
      const placeholders = episodeIds.map(() => '?').join(',');
      edgesCausales = db.prepare(`
        SELECT desde_entidad, tipo, hacia_entidad, descripcion, valid_at
        FROM relaciones_semanticas
        WHERE episode_id IN (${placeholders})
        ORDER BY valid_at
      `).all(...episodeIds);
    }
  } catch {}

  // Parsear memory_trace
  let memoryTrace = [];
  try {
    memoryTrace = JSON.parse(ciclo.memory_trace || '[]');
  } catch {}

  // Construir trail explicable
  const trail = {
    ciclo_id: cicloId,
    tarea: ciclo.tarea,
    modulo: ciclo.modulo,
    resultado: ciclo.estado,
    fecha: ciclo.fecha_inicio,
    duracion_ms: ciclo.duracion_ms,

    // Qué cambió
    cambios: {
      fases_ejecutadas: fases.length,
      tests_generados: ciclo.tests_generados || 0,
      tests_pasando: ciclo.tests_pasando || 0,
      review_blockers: ciclo.review_blockers || 0,
      nodos_afectados: nodosAfectados.length,
      edges_causales_nuevos: edgesCausales.length,
    },

    // Por qué (memoria que influyó)
    memoria_que_influyo: memoryTrace,
    patrones_aplicados: _parseJsonField(ciclo.patrones_aplicados),
    errores_evitados: _parseJsonField(ciclo.errores_evitados),
    decisiones_usadas: _parseJsonField(ciclo.decisiones_usadas),

    // Qué quedó invalidado / creado
    edges_causales: edgesCausales,
    nodos_modificados: nodosAfectados,

    // Detalle por fase
    fases: fases.map(f => ({
      num: f.fase_num,
      nombre: f.fase_nombre,
      agente: f.agente,
      estado: f.estado,
      gate_result: f.gate_result,
      decision: f.decision_tomada,
      intentos: f.intentos,
    })),

    // Episodios crudos
    episodios: episodios.map(e => ({
      tipo: e.tipo,
      descripcion: e.descripcion,
      resultado: e.resultado,
      razon: e.razon_resultado,
    })),
  };

  return trail;
}

// ─── ÚLTIMOS N CICLOS ─────────────────────────────────────────────────────────

function getRecentTrails(db, n = 5) {
  let ciclos = [];
  try {
    ciclos = db.prepare(`
      SELECT ciclo_id, tarea, modulo, estado, fecha_inicio, tests_pasando, stops_count
      FROM ciclos ORDER BY fecha_inicio DESC LIMIT ?
    `).all(n);
  } catch { return []; }
  return ciclos;
}

// ─── POR QUÉ EXISTE ALGO ─────────────────────────────────────────────────────

/**
 * "¿Por qué está X en el código/memoria?"
 * Retorna la cadena causal completa: episodios → edges → decisiones relacionadas.
 */
function whyExists(db, target) {
  const chain = {
    target,
    causal_edges: [],
    episodios_relacionados: [],
    decisiones_relacionadas: [],
    adrs_relacionados: [],
  };

  // Edges causales
  try {
    chain.causal_edges = db.prepare(`
      SELECT desde_entidad, tipo, hacia_entidad, descripcion, valid_at, confidence
      FROM relaciones_semanticas
      WHERE (desde_entidad LIKE ? OR hacia_entidad LIKE ?)
        AND tipo IN ('caused_failure','was_fixed_by','tested_by','regressed_by','depends_on_decision')
        AND (invalid_at IS NULL OR invalid_at = '')
      ORDER BY valid_at DESC LIMIT 20
    `).all(`%${target}%`, `%${target}%`);
  } catch {}

  // Episodios relacionados
  try {
    chain.episodios_relacionados = db.prepare(`
      SELECT tipo, descripcion, resultado, razon_resultado, fecha
      FROM episodios
      WHERE archivos_tocados LIKE ? OR descripcion LIKE ?
      ORDER BY fecha DESC LIMIT 10
    `).all(`%${target}%`, `%${target}%`);
  } catch {}

  // Decisiones (nodos tipo decision)
  try {
    chain.decisiones_relacionadas = db.prepare(`
      SELECT titulo, contenido, confianza, area, fecha_creacion, vigencia_tipo
      FROM nodos
      WHERE tipo IN ('decision','adr','conocimiento_adr') AND (titulo LIKE ? OR contenido LIKE ?)
      ORDER BY confianza DESC, fecha_creacion DESC LIMIT 10
    `).all(`%${target}%`, `%${target}%`);
  } catch {
    try {
      chain.decisiones_relacionadas = db.prepare(`
        SELECT titulo, contenido, confianza, area, fecha_creacion
        FROM nodos
        WHERE tipo IN ('decision','adr') AND (titulo LIKE ? OR contenido LIKE ?)
        ORDER BY confianza DESC LIMIT 10
      `).all(`%${target}%`, `%${target}%`);
    } catch {}
  }

  // ADRs del knowledge base
  try {
    chain.adrs_relacionados = db.prepare(`
      SELECT doc_id, titulo, decision, status
      FROM knowledge_docs
      WHERE (afecta LIKE ? OR titulo LIKE ?) AND status = 'accepted'
      LIMIT 5
    `).all(`%${target}%`, `%${target}%`);
  } catch {}

  return chain;
}

// ─── TIMELINE DE UN MÓDULO ────────────────────────────────────────────────────

/**
 * Historia completa de un módulo: todos los ciclos que lo tocaron, en orden.
 */
function getModuleTimeline(db, modulo) {
  let ciclos = [];
  try {
    ciclos = db.prepare(`
      SELECT ciclo_id, tarea, estado, fecha_inicio, tests_pasando, stops_count, patrones_aplicados
      FROM ciclos WHERE modulo LIKE ? OR tarea LIKE ?
      ORDER BY fecha_inicio ASC LIMIT 50
    `).all(`%${modulo}%`, `%${modulo}%`);
  } catch { return []; }

  return ciclos.map(c => ({
    ...c,
    patrones_aplicados: _parseJsonField(c.patrones_aplicados),
  }));
}

// ─── DIFF ENTRE CICLOS ───────────────────────────────────────────────────────

/**
 * Qué cambió en la memoria entre el ciclo A y el ciclo B.
 */
function diffCiclos(db, desde, hasta) {
  try {
    const c1 = db.prepare(`SELECT fecha_inicio FROM ciclos WHERE ciclo_id = ?`).get(desde);
    const c2 = db.prepare(`SELECT fecha_inicio FROM ciclos WHERE ciclo_id = ?`).get(hasta);
    if (!c1 || !c2) return { error: 'Ciclo no encontrado' };

    const nodosDiff = db.prepare(`
      SELECT titulo, tipo, confianza, estado, area, fecha_creacion, fecha_update
      FROM nodos
      WHERE fecha_update >= ? AND fecha_update <= ?
      ORDER BY fecha_update
    `).all(c1.fecha_inicio, c2.fecha_inicio);

    const edgesDiff = db.prepare(`
      SELECT desde_entidad, tipo, hacia_entidad, descripcion, valid_at
      FROM relaciones_semanticas
      WHERE valid_at >= ? AND valid_at <= ?
      ORDER BY valid_at
    `).all(c1.fecha_inicio, c2.fecha_inicio);

    return {
      desde_ciclo: desde,
      hasta_ciclo: hasta,
      nodos_cambiados: nodosDiff.length,
      edges_nuevos: edgesDiff.length,
      nodos: nodosDiff,
      edges: edgesDiff,
    };
  } catch (e) { return { error: e.message }; }
}

// ─── FORMATO LEGIBLE ──────────────────────────────────────────────────────────

function formatTrail(trail) {
  if (!trail) return 'Ciclo no encontrado';

  const lines = [
    ``,
    `═══════════════════════════════════════════════════`,
    `  Decision Trail — Ciclo: ${trail.ciclo_id}`,
    `═══════════════════════════════════════════════════`,
    `  Tarea:     ${trail.tarea}`,
    `  Módulo:    ${trail.modulo}`,
    `  Resultado: ${trail.resultado}`,
    `  Fecha:     ${trail.fecha}`,
    ``,
    `  ── QUÉ CAMBIÓ ─────────────────────────────────`,
    `  Fases ejecutadas:  ${trail.cambios.fases_ejecutadas}`,
    `  Tests:             ${trail.cambios.tests_pasando}/${trail.cambios.tests_generados} pasando`,
    `  Nodos memoria:     ${trail.cambios.nodos_afectados} afectados`,
    `  Edges causales:    ${trail.cambios.edges_causales_nuevos} nuevos`,
    `  Review blockers:   ${trail.cambios.review_blockers}`,
    ``,
    `  ── POR QUÉ (memoria que influyó) ───────────────`,
  ];

  if (trail.patrones_aplicados?.length > 0)
    lines.push(`  Patrones: ${trail.patrones_aplicados.join(', ')}`);
  if (trail.errores_evitados?.length > 0)
    lines.push(`  Errores evitados: ${trail.errores_evitados.join(', ')}`);
  if (trail.decisiones_usadas?.length > 0)
    lines.push(`  Decisiones: ${trail.decisiones_usadas.join(', ')}`);
  if (trail.memoria_que_influyo?.length > 0) {
    trail.memoria_que_influyo.slice(0, 5).forEach(m => {
      lines.push(`  [${m.tipo || 'memoria'}] ${m.titulos?.join(', ') || m.area || '—'}`);
    });
  }

  if (trail.fases.length > 0) {
    lines.push('', '  ── FASES ───────────────────────────────────────');
    trail.fases.forEach(f => {
      const gate = f.gate_result ? ` [gate: ${f.gate_result}]` : '';
      lines.push(`  ${f.num}. ${f.nombre || f.agente}${gate} → ${f.estado}`);
      if (f.decision) lines.push(`     → ${f.decision.substring(0, 80)}`);
    });
  }

  if (trail.edges_causales.length > 0) {
    lines.push('', '  ── NUEVOS EDGES CAUSALES ────────────────────────');
    trail.edges_causales.slice(0, 5).forEach(e => {
      lines.push(`  ${e.desde_entidad} --${e.tipo}--> ${e.hacia_entidad}`);
    });
  }

  lines.push('═══════════════════════════════════════════════════');
  return lines.join('\n');
}

function formatWhyChain(chain) {
  const lines = [`\n¿Por qué existe '${chain.target}'?\n`];

  if (chain.causal_edges.length > 0) {
    lines.push('Cadena causal:');
    chain.causal_edges.forEach(e =>
      lines.push(`  ${e.desde_entidad} --${e.tipo}--> ${e.hacia_entidad}${e.descripcion ? ': ' + e.descripcion.substring(0, 80) : ''}`)
    );
  } else {
    lines.push('Sin cadena causal directa.');
  }

  if (chain.adrs_relacionados.length > 0) {
    lines.push('\nADRs relacionados:');
    chain.adrs_relacionados.forEach(a => lines.push(`  [${a.doc_id}] ${a.titulo}`));
  }

  if (chain.episodios_relacionados.length > 0) {
    lines.push('\nEpisodios históricos:');
    chain.episodios_relacionados.slice(0, 3).forEach(e =>
      lines.push(`  [${e.tipo}] ${e.descripcion?.substring(0, 80)} → ${e.resultado}`)
    );
  }

  return lines.join('\n');
}

// ─── HELPER ───────────────────────────────────────────────────────────────────

function _parseJsonField(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  try { return JSON.parse(val); } catch { return []; }
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const [,, cmd, ...args] = process.argv;
  const projectRoot = process.cwd();
  const db = openDB(projectRoot);

  switch (cmd) {
    case 'ciclo': {
      const [cicloId] = args;
      if (!cicloId) { console.error('Uso: decision-trail.cjs ciclo <ciclo_id>'); process.exit(1); }
      const trail = getCicloTrail(db, cicloId);
      console.log(formatTrail(trail));
      break;
    }
    case 'recent': {
      const n = parseInt(args[0]) || 5;
      const trails = getRecentTrails(db, n);
      console.log(`\nÚltimos ${n} ciclos:\n`);
      trails.forEach(c => {
        const result = c.estado === 'COMPLETADO' ? '✅' : '🛑';
        console.log(`  ${result} [${c.ciclo_id}] ${c.tarea?.substring(0, 60)} → ${c.modulo}`);
      });
      console.log(`\nDetalle: node .agentic/grafo/decision-trail.cjs ciclo <ciclo_id>`);
      break;
    }
    case 'why': {
      const [target] = args;
      if (!target) { console.error('Uso: decision-trail.cjs why <archivo_o_entidad>'); process.exit(1); }
      const chain = whyExists(db, target);
      console.log(formatWhyChain(chain));
      break;
    }
    case 'timeline': {
      const [modulo] = args;
      if (!modulo) { console.error('Uso: decision-trail.cjs timeline <módulo>'); process.exit(1); }
      const timeline = getModuleTimeline(db, modulo);
      console.log(`\nTimeline de '${modulo}' (${timeline.length} ciclos):\n`);
      timeline.forEach(c => {
        const ok = c.estado === 'COMPLETADO' ? '✅' : '🛑';
        console.log(`  ${ok} ${c.fecha_inicio?.substring(0, 10)} [${c.ciclo_id}] ${c.tarea?.substring(0, 60)}`);
      });
      break;
    }
    case 'diff': {
      const [desde, hasta] = args;
      if (!desde || !hasta) { console.error('Uso: decision-trail.cjs diff <desde_ciclo_id> <hasta_ciclo_id>'); process.exit(1); }
      const diff = diffCiclos(db, desde, hasta);
      if (diff.error) { console.error(diff.error); process.exit(1); }
      console.log(`\nDiff entre ${desde} → ${hasta}:`);
      console.log(`  Nodos cambiados: ${diff.nodos_cambiados}`);
      console.log(`  Edges nuevos:    ${diff.edges_nuevos}`);
      if (diff.nodos.length > 0) {
        console.log('\nNodos:');
        diff.nodos.forEach(n => console.log(`  ${n.tipo.padEnd(12)} ${n.titulo} [${n.confianza}]`));
      }
      break;
    }
    default:
      console.log('Uso: node decision-trail.cjs [ciclo <id> | recent [N] | why <target> | timeline <módulo> | diff <desde> <hasta>]');
  }
}

module.exports = {
  getCicloTrail,
  getRecentTrails,
  whyExists,
  getModuleTimeline,
  diffCiclos,
  formatTrail,
  formatWhyChain,
};
