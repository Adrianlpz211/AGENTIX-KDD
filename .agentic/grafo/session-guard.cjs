/**
 * Agentic KDD — Session Guard v1.0
 *
 * Problema que resuelve:
 *   - Cursor se cierra y pierdes el hilo
 *   - Cambias de PC y empiezas chat nuevo
 *   - No recuerdas en qué ibas exactamente
 *
 * Solución:
 *   - Cada 5 ciclos aa: guarda un checkpoint en .agentic/checkpoint.md
 *   - akdd historial muestra el checkpoint listo para pegar en el chat nuevo
 *   - El chat nuevo recupera el contexto exacto de donde se quedó
 *
 * Uso:
 *   node session-guard.cjs checkpoint   — genera checkpoint ahora
 *   node session-guard.cjs historial    — muestra el último checkpoint
 *   node session-guard.cjs status       — cuántos ciclos hasta el próximo checkpoint
 */

'use strict';

const path = require('path');
const fs   = require('fs');

const CHECKPOINT_EVERY = 5;
const CHECKPOINT_PATH  = '.agentic/checkpoint.md';
const COUNTER_KEY      = 'session_guard_cycle_count';

// ─── DB ───────────────────────────────────────────────────────────────────────

function openDB(projectRoot) {
  const dbPath = path.join(projectRoot, '.agentic/memoria.db');
  try { return new (require('better-sqlite3'))(dbPath); } catch {}
  try { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(dbPath); } catch {}
  return null;
}

// ─── LEER CICLOS RECIENTES ────────────────────────────────────────────────────

function getRecentCycles(db, limit = 5) {
  try {
    return db.prepare(`
      SELECT ciclo_id, descripcion, tipo, estado, fecha_inicio, fecha_fin,
             tests_corridos, patrones_aplicados, errores_encontrados, fases_completadas
      FROM ciclos
      ORDER BY fecha_inicio DESC
      LIMIT ?
    `).all(limit);
  } catch { return []; }
}

function getProjectStats(db) {
  try {
    const nodes    = db.prepare("SELECT COUNT(*) as n FROM nodos WHERE estado='ACTIVO'").get()?.n || 0;
    const high     = db.prepare("SELECT COUNT(*) as n FROM nodos WHERE confianza='ALTA' AND estado='ACTIVO'").get()?.n || 0;
    const cycles   = db.prepare("SELECT COUNT(*) as n FROM ciclos").get()?.n || 0;
    const stops    = db.prepare("SELECT COUNT(*) as n FROM ciclos WHERE estado='STOP'").get()?.n || 0;
    const errors   = db.prepare("SELECT COUNT(*) as n FROM nodos WHERE tipo='error' AND estado='ACTIVO'").get()?.n || 0;
    return { nodes, high, cycles, stops, errors };
  } catch { return { nodes: 0, high: 0, cycles: 0, stops: 0, errors: 0 }; }
}

function getLastModifiedFiles(db, cicloId) {
  try {
    const trail = db.prepare(`
      SELECT descripcion FROM decisiones
      WHERE ciclo_id = ?
        AND (descripcion LIKE '%.ts%' OR descripcion LIKE '%.js%'
             OR descripcion LIKE '%.tsx%' OR descripcion LIKE '%.jsx%'
             OR descripcion LIKE '%.py%')
      LIMIT 5
    `).all(cicloId);
    return trail.map(t => t.descripcion?.substring(0, 60)).filter(Boolean);
  } catch { return []; }
}

// ─── GENERAR CHECKPOINT ───────────────────────────────────────────────────────

function generateCheckpoint(projectRoot) {
  projectRoot = projectRoot || process.cwd();
  const db = openDB(projectRoot);
  if (!db) return null;

  const cycles  = getRecentCycles(db, 5);
  const stats   = getProjectStats(db);
  const now     = new Date();
  const dateStr = now.toLocaleDateString('es-ES', { day:'2-digit', month:'2-digit', year:'numeric' });
  const timeStr = now.toTimeString().substring(0, 5);

  if (cycles.length === 0) {
    db.close();
    return null;
  }

  const latest  = cycles[0];
  const prev    = cycles.slice(1);

  // Parsear fases completadas del último ciclo
  let fasesInfo = '';
  try {
    const fases = JSON.parse(latest.fases_completadas || '[]');
    if (fases.length > 0) fasesInfo = ` — ${fases.length} fases completadas`;
  } catch {}

  // Parsear patrones del último ciclo
  let patronesInfo = '';
  try {
    const pats = JSON.parse(latest.patrones_aplicados || '[]');
    if (pats.length > 0) patronesInfo = `, ${pats.length} patrones aplicados`;
  } catch {}

  // Archivos del último ciclo
  const files = getLastModifiedFiles(db, latest.ciclo_id);
  const filesStr = files.length > 0 ? `\nArchivos: ${files.join(', ')}` : '';

  // Construir checkpoint
  const lines = [
    `# Checkpoint Agentic KDD — ${dateStr} ${timeStr}`,
    '',
    `> Proyecto: ${path.basename(projectRoot)}`,
    `> Ciclos totales: ${stats.cycles}`,
    '',
    '---',
    '',
    `## Última tarea (ciclo ${stats.cycles})`,
    `**${latest.descripcion || 'Sin descripción'}**`,
    `Estado: ${latest.estado || 'completado'}${fasesInfo}${patronesInfo}${filesStr}`,
    '',
  ];

  if (prev.length > 0) {
    lines.push('## Las anteriores');
    prev.forEach((c, i) => {
      const fecha = c.fecha_inicio ? new Date(c.fecha_inicio).toLocaleDateString('es-ES', {day:'2-digit', month:'2-digit'}) : '';
      lines.push(`${i + 1}. ${fecha ? `[${fecha}] ` : ''}${c.descripcion?.substring(0, 80) || 'Sin descripción'}`);
    });
    lines.push('');
  }

  lines.push('## Estado del proyecto');
  lines.push(`- ${stats.nodes} nodos en memoria · ${stats.high} reglas HIGH`);
  lines.push(`- ${stats.cycles} ciclos completados · ${stats.stops} stops`);
  lines.push(`- ${stats.errors} errores documentados`);
  lines.push('');
  lines.push('## Para retomar en un chat nuevo');
  lines.push('```');
  lines.push('akdd historial');
  lines.push('```');
  lines.push('Pega el output al inicio del nuevo chat y escribe:');
  lines.push('```');
  lines.push(`aa: continúa — ${latest.descripcion?.substring(0, 60) || 'la última tarea'}`);
  lines.push('```');
  lines.push('');
  lines.push(`---`);
  lines.push(`*Generado automáticamente por Session Guard · ${dateStr} ${timeStr}*`);

  const checkpointContent = lines.join('\n');
  const checkpointPath = path.join(projectRoot, CHECKPOINT_PATH);

  try {
    fs.writeFileSync(checkpointPath, checkpointContent);
  } catch {}

  db.close();
  return checkpointContent;
}

// ─── MOSTRAR HISTORIAL (para pegar en chat nuevo) ─────────────────────────────

function showHistorial(projectRoot) {
  projectRoot = projectRoot || process.cwd();
  const checkpointPath = path.join(projectRoot, CHECKPOINT_PATH);

  if (!fs.existsSync(checkpointPath)) {
    // Generar uno ahora si no existe
    const generated = generateCheckpoint(projectRoot);
    if (!generated) {
      console.log('\n[SESSION] Sin historial todavía — corre ciclos aa: primero.\n');
      return null;
    }
    return generated;
  }

  const content = fs.readFileSync(checkpointPath, 'utf8');

  console.log('\n' + '═'.repeat(60));
  console.log('  📋 HISTORIAL — Pegar al inicio del chat nuevo');
  console.log('═'.repeat(60));
  console.log('\n' + content);
  console.log('═'.repeat(60));
  console.log('\n  Copia todo lo de arriba y pégalo en el nuevo chat.\n');

  return content;
}

// ─── CHECK Y AUTO-CHECKPOINT ──────────────────────────────────────────────────

/**
 * Llamar al final de cada ciclo desde grafo.cjs.
 * Genera checkpoint cada CHECKPOINT_EVERY ciclos.
 */
function maybeCheckpoint(projectRoot, currentCycleCount) {
  if (currentCycleCount % CHECKPOINT_EVERY === 0) {
    generateCheckpoint(projectRoot);
    return true;
  }
  return false;
}

// ─── STATUS ───────────────────────────────────────────────────────────────────

function getStatus(projectRoot) {
  projectRoot = projectRoot || process.cwd();
  const db = openDB(projectRoot);
  if (!db) return { cycles: 0, next_checkpoint: CHECKPOINT_EVERY };

  const cycles = db.prepare("SELECT COUNT(*) as n FROM ciclos").get()?.n || 0;
  db.close();

  const remaining = CHECKPOINT_EVERY - (cycles % CHECKPOINT_EVERY);
  const checkpointExists = fs.existsSync(path.join(projectRoot, CHECKPOINT_PATH));

  return {
    cycles,
    checkpoint_every: CHECKPOINT_EVERY,
    cycles_until_next: remaining === CHECKPOINT_EVERY ? 0 : remaining,
    last_checkpoint: checkpointExists
      ? fs.statSync(path.join(projectRoot, CHECKPOINT_PATH)).mtime.toLocaleDateString('es-ES')
      : 'nunca',
  };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const [,, cmd] = process.argv;
  const projectRoot = process.cwd();

  switch (cmd) {
    case 'checkpoint':
      const c = generateCheckpoint(projectRoot);
      if (c) console.log(`\n✅ Checkpoint guardado en ${CHECKPOINT_PATH}\n`);
      else   console.log('\n❌ Sin ciclos para guardar todavía.\n');
      break;

    case 'historial':
      showHistorial(projectRoot);
      break;

    case 'status': {
      const s = getStatus(projectRoot);
      console.log(`\nSession Guard Status:`);
      console.log(`  Ciclos totales:       ${s.cycles}`);
      console.log(`  Checkpoint cada:      ${s.checkpoint_every} ciclos`);
      console.log(`  Ciclos hasta próximo: ${s.cycles_until_next || CHECKPOINT_EVERY}`);
      console.log(`  Último checkpoint:    ${s.last_checkpoint}\n`);
      break;
    }

    default:
      console.log('Uso: node session-guard.cjs [checkpoint | historial | status]');
  }
}

module.exports = { generateCheckpoint, showHistorial, maybeCheckpoint, getStatus };
