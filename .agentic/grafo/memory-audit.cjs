/**
 * Agentic KDD — Memory Audit v1.0
 * Consolidación reviewable: la memoria se puede auditar, cuestionar y depurar con evidencia.
 *
 * Cierra el Gap #5: la memoria crecía en silencio. Ahora el dev puede:
 *   - Ver qué hay en memoria y cuán confiable es
 *   - Detectar contradicciones, duplicados, entradas obsoletas
 *   - Aprobar o rechazar consolidaciones propuestas
 *   - Forzar el olvido de algo incorrecto con registro de razón
 *
 * Uso:
 *   node .agentic/grafo/memory-audit.cjs report
 *   node .agentic/grafo/memory-audit.cjs stale          — entradas sin validar 30+ ciclos
 *   node .agentic/grafo/memory-audit.cjs contradictions — patrones que se contradicen
 *   node .agentic/grafo/memory-audit.cjs propose        — consolidaciones sugeridas
 *   node .agentic/grafo/memory-audit.cjs forget <id> <razón>
 *   node .agentic/grafo/memory-audit.cjs approve <id>   — confirmar vigencia
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

const AUDIT_LOG_PATH = '.agentic/memoria_audit.log';

// ─── ESQUEMA: VIGENCIA_TIPO ───────────────────────────────────────────────────
// Cierra también el Gap #1: distinción entre memoria vigente / histórica / evidencia

const VIGENCIA_TIPOS = {
  VIGENTE:    'VIGENTE',    // regla activa, se aplica hoy
  HISTORICO:  'HISTORICO',  // referencia, no se aplica pero no se borra
  EVIDENCIA:  'EVIDENCIA',  // registro de algo que pasó (episodio consolidado)
  OBSOLETO:   'OBSOLETO',   // ya no aplica
};

/**
 * Migrar nodos existentes para agregar vigencia_tipo si no existe.
 */
function migrateVigenciaTipo(db) {
  try {
    db.exec("ALTER TABLE nodos ADD COLUMN vigencia_tipo TEXT DEFAULT 'VIGENTE'");
  } catch {}

  // Inferir vigencia_tipo para registros existentes
  try {
    // Nodos OBSOLETO → OBSOLETO
    db.prepare("UPDATE nodos SET vigencia_tipo='OBSOLETO' WHERE estado='OBSOLETO' AND vigencia_tipo='VIGENTE'").run();
    // Nodos CONSOLIDADO → HISTORICO
    db.prepare("UPDATE nodos SET vigencia_tipo='HISTORICO' WHERE estado='CONSOLIDADO' AND vigencia_tipo='VIGENTE'").run();
    // Nodos tipo 'aprendizaje' o 'episodio_consolidado' → EVIDENCIA
    db.prepare("UPDATE nodos SET vigencia_tipo='EVIDENCIA' WHERE tipo LIKE '%episodio%' AND vigencia_tipo='VIGENTE'").run();
    // Crear índice
    db.exec("CREATE INDEX IF NOT EXISTS idx_nodos_vigencia ON nodos(vigencia_tipo)");
  } catch {}

  return true;
}

// ─── FUNCIÓN verdadVigente ────────────────────────────────────────────────────

/**
 * Retorna SOLO la memoria vigente — patrones y reglas que aplican HOY.
 * Excluye: HISTORICO (referencia), EVIDENCIA (episodio), OBSOLETO.
 *
 * @param {object} db
 * @param {string} area
 * @param {string} tipo - 'error' | 'patron' | 'decision' | null (todos)
 * @param {number} limit
 */
function verdadVigente(db, area = null, tipo = null, limit = 20) {
  let query = `
    SELECT id, titulo, contenido, tipo, confianza, area, aplicado, util,
           decay_score, vigencia_tipo, ultima_validacion
    FROM nodos
    WHERE estado = 'ACTIVO'
      AND (vigencia_tipo = 'VIGENTE' OR vigencia_tipo IS NULL)
      AND decay_score > 0.2
  `;
  const params = [];

  if (area) { query += ' AND (area = ? OR area = \'global\')'; params.push(area); }
  if (tipo)  { query += ' AND tipo = ?'; params.push(tipo); }
  query += ` ORDER BY confianza DESC, decay_score DESC LIMIT ${limit}`;

  try {
    return db.prepare(query).all(...params);
  } catch { return []; }
}

// ─── ENTRADAS OBSOLETAS (stale) ───────────────────────────────────────────────

function detectStale(db) {
  const stale = [];

  // Sin validar en más de 30 ciclos (usando fecha como proxy)
  try {
    const old = db.prepare(`
      SELECT id, tipo, titulo, confianza, area, ultima_validacion, aplicado, util
      FROM nodos
      WHERE estado = 'ACTIVO'
        AND vigencia_tipo IN ('VIGENTE', NULL)
        AND (ultima_validacion IS NULL OR
             julianday('now') - julianday(ultima_validacion) > 90)
      ORDER BY ultima_validacion ASC LIMIT 50
    `).all();
    old.forEach(n => stale.push({ ...n, razon: 'Sin validar en 90+ días' }));
  } catch {}

  // Confianza ALTA con decay_score < 0.5 (desapareciendo del radar)
  try {
    const decaying = db.prepare(`
      SELECT id, tipo, titulo, confianza, decay_score, area, ultima_validacion
      FROM nodos
      WHERE confianza = 'ALTA' AND decay_score < 0.5 AND estado = 'ACTIVO'
      ORDER BY decay_score ASC LIMIT 20
    `).all();
    decaying.forEach(n => stale.push({ ...n, razon: `ALTA pero decay_score=${n.decay_score?.toFixed(2)} — revisar vigencia` }));
  } catch {}

  // Aplicado ≥ 5 pero Útil/Aplicado < 0.3
  try {
    const lowUtility = db.prepare(`
      SELECT id, tipo, titulo, confianza, aplicado, util, area
      FROM nodos
      WHERE aplicado >= 5 AND util * 1.0 / aplicado < 0.3 AND estado = 'ACTIVO'
      ORDER BY util * 1.0 / aplicado ASC LIMIT 20
    `).all();
    lowUtility.forEach(n => {
      const ratio = n.aplicado > 0 ? (n.util / n.aplicado).toFixed(2) : '0';
      stale.push({ ...n, razon: `Baja utilidad: ${ratio} (${n.util}/${n.aplicado})` });
    });
  } catch {}

  return stale;
}

// ─── DETECTAR CONTRADICCIONES ────────────────────────────────────────────────

function detectContradictions(db) {
  const contradictions = [];

  // Buscar relaciones tipo 'contradice' en tabla relaciones
  try {
    const contras = db.prepare(`
      SELECT n1.titulo as desde, n1.confianza as conf_desde,
             n2.titulo as hacia, n2.confianza as conf_hacia,
             r.tipo
      FROM relaciones r
      JOIN nodos n1 ON r.desde_id = n1.id
      JOIN nodos n2 ON r.hacia_id = n2.id
      WHERE r.tipo = 'contradice'
        AND n1.estado = 'ACTIVO' AND n2.estado = 'ACTIVO'
      LIMIT 20
    `).all();
    contradictions.push(...contras.map(c => ({ tipo: 'relacion_contradice', ...c })));
  } catch {}

  // Buscar pares con título similar pero confianza diferente (posibles duplicados)
  try {
    const similar = db.prepare(`
      SELECT n1.id as id1, n1.titulo as t1, n1.confianza as c1,
             n2.id as id2, n2.titulo as t2, n2.confianza as c2
      FROM nodos n1
      JOIN nodos n2 ON n1.id < n2.id
        AND n1.tipo = n2.tipo
        AND n1.area = n2.area
        AND n1.estado = 'ACTIVO' AND n2.estado = 'ACTIVO'
        AND (lower(n1.titulo) LIKE '%' || lower(substr(n2.titulo, 1, 15)) || '%'
          OR lower(n2.titulo) LIKE '%' || lower(substr(n1.titulo, 1, 15)) || '%')
      LIMIT 15
    `).all();
    similar.forEach(p => {
      if (p.c1 !== p.c2) {
        contradictions.push({
          tipo: 'posible_duplicado',
          desde: p.t1,
          hacia: p.t2,
          conf_desde: p.c1,
          conf_hacia: p.c2,
          nota: 'Títulos similares con confianza diferente — posible duplicado'
        });
      }
    });
  } catch {}

  return contradictions;
}

// ─── CONSOLIDACIONES PROPUESTAS ───────────────────────────────────────────────

/**
 * Propone consolidaciones basadas en evidencia — no las ejecuta.
 * El dev aprueba o rechaza cada una.
 */
function proposeConsolidations(db) {
  const proposals = [];

  // Patrones que superan el umbral de consolidación
  try {
    const candidates = db.prepare(`
      SELECT id, tipo, titulo, confianza, aplicado, util, area
      FROM nodos
      WHERE confianza = 'ALTA'
        AND aplicado >= 10
        AND util * 1.0 / aplicado >= 0.8
        AND estado = 'ACTIVO'
        AND vigencia_tipo = 'VIGENTE'
      ORDER BY aplicado DESC LIMIT 20
    `).all();

    candidates.forEach(n => {
      proposals.push({
        id: n.id,
        accion: 'CONSOLIDAR',
        titulo: n.titulo,
        razon: `Aplicado ${n.aplicado} veces, ${Math.round(n.util/n.aplicado*100)}% útil → mover a CONSOLIDADO`,
        evidencia: `aplicado=${n.aplicado}, util=${n.util}`,
        tipo: n.tipo,
        area: n.area,
      });
    });
  } catch {}

  // Entradas BAJA con baja utilidad → proponer OBSOLETO
  try {
    const lowConf = db.prepare(`
      SELECT id, tipo, titulo, confianza, aplicado, util
      FROM nodos
      WHERE confianza = 'BAJA' AND aplicado >= 3 AND util * 1.0 / aplicado < 0.3 AND estado = 'ACTIVO'
      LIMIT 15
    `).all();

    lowConf.forEach(n => {
      proposals.push({
        id: n.id,
        accion: 'MARCAR_OBSOLETO',
        titulo: n.titulo,
        razon: `BAJA confianza + utilidad ${Math.round(n.util/(n.aplicado||1)*100)}% → candidato a obsoleto`,
        evidencia: `aplicado=${n.aplicado}, util=${n.util}`,
      });
    });
  } catch {}

  return proposals;
}

// ─── FORGET — OLVIDO EXPLÍCITO CON RAZÓN ─────────────────────────────────────

/**
 * Marca un nodo como OBSOLETO con vigencia_tipo OBSOLETO y registra la razón.
 * NO borra — preserva historial. El agente no volverá a aplicarlo.
 */
function forgetMemory(db, nodeId, reason, projectRoot) {
  try {
    const node = db.prepare('SELECT titulo, tipo FROM nodos WHERE id = ?').get(nodeId);
    if (!node) return { error: `Nodo ${nodeId} no encontrado` };

    db.prepare(`
      UPDATE nodos SET estado='OBSOLETO', vigencia_tipo='OBSOLETO',
        contenido = contenido || ' | OLVIDADO: ' || ?,
        fecha_update = datetime('now')
      WHERE id = ?
    `).run(reason, nodeId);

    // Registrar en audit log
    const logEntry = `[${new Date().toISOString()}] FORGET id=${nodeId} titulo="${node.titulo}" razón="${reason}"\n`;
    try {
      fs.appendFileSync(path.join(projectRoot, AUDIT_LOG_PATH), logEntry);
    } catch {}

    return { ok: true, titulo: node.titulo, estado: 'OBSOLETO' };
  } catch (e) { return { error: e.message }; }
}

/**
 * Confirma la vigencia de un nodo — actualiza ultima_validacion.
 */
function approveMemory(db, nodeId, projectRoot) {
  try {
    db.prepare(`
      UPDATE nodos SET ultima_validacion = datetime('now'),
        vigencia_tipo = 'VIGENTE',
        fecha_update = datetime('now')
      WHERE id = ?
    `).run(nodeId);

    const logEntry = `[${new Date().toISOString()}] APPROVE id=${nodeId}\n`;
    try { fs.appendFileSync(path.join(projectRoot, AUDIT_LOG_PATH), logEntry); } catch {}

    return { ok: true };
  } catch (e) { return { error: e.message }; }
}

// ─── REPORTE COMPLETO ─────────────────────────────────────────────────────────

function generateAuditReport(db) {
  const stale = detectStale(db);
  const contradictions = detectContradictions(db);
  const proposals = proposeConsolidations(db);

  // Resumen de vigencia_tipo
  let vigenciaSummary = {};
  try {
    const rows = db.prepare("SELECT vigencia_tipo, COUNT(*) as n FROM nodos GROUP BY vigencia_tipo").all();
    rows.forEach(r => { vigenciaSummary[r.vigencia_tipo || 'sin_clasificar'] = r.n; });
  } catch {}

  return {
    fecha: new Date().toISOString(),
    vigencia: vigenciaSummary,
    stale_count: stale.length,
    stale: stale.slice(0, 20),
    contradictions_count: contradictions.length,
    contradictions: contradictions,
    proposals_count: proposals.length,
    proposals: proposals,
    action_needed: stale.length > 0 || contradictions.length > 0 || proposals.length > 0,
  };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const [,, cmd, ...args] = process.argv;
  const projectRoot = process.cwd();
  const db = openDB(projectRoot);

  // Migrar vigencia_tipo si necesario
  migrateVigenciaTipo(db);

  switch (cmd) {
    case 'report': {
      const report = generateAuditReport(db);
      console.log('\n═══════════════════════════════════════════════════');
      console.log('  Memory Audit Report');
      console.log('═══════════════════════════════════════════════════');
      console.log(`  Fecha: ${report.fecha}`);
      console.log(`\n  Vigencia de memoria:`);
      Object.entries(report.vigencia).forEach(([k, v]) => console.log(`    ${k}: ${v}`));
      console.log(`\n  Entradas stale: ${report.stale_count}`);
      report.stale.slice(0, 5).forEach(s => console.log(`    ⚠️  [${s.id}] ${s.titulo}: ${s.razon}`));
      console.log(`\n  Contradicciones: ${report.contradictions_count}`);
      report.contradictions.slice(0, 3).forEach(c => console.log(`    🔴 "${c.desde}" ↔ "${c.hacia}"`));
      console.log(`\n  Consolidaciones propuestas: ${report.proposals_count}`);
      report.proposals.slice(0, 5).forEach(p => console.log(`    📋 [${p.id}] ${p.accion}: ${p.titulo}`));
      console.log('\n  Comandos:');
      console.log('    node .agentic/grafo/memory-audit.cjs forget <id> "<razón>"');
      console.log('    node .agentic/grafo/memory-audit.cjs approve <id>');
      console.log('═══════════════════════════════════════════════════\n');
      break;
    }
    case 'stale': {
      const stale = detectStale(db);
      console.log(`\nEntradas stale (${stale.length}):\n`);
      stale.slice(0, 20).forEach(s =>
        console.log(`  [${s.id}] ${s.tipo.padEnd(12)} ${s.titulo.substring(0,50)} | ${s.razon}`)
      );
      break;
    }
    case 'contradictions': {
      const cons = detectContradictions(db);
      console.log(`\nContradicciones (${cons.length}):\n`);
      cons.forEach(c => console.log(`  "${c.desde}" ↔ "${c.hacia}" (${c.tipo})`));
      break;
    }
    case 'propose': {
      const props = proposeConsolidations(db);
      console.log(`\nConsolidaciones propuestas (${props.length}):\n`);
      props.forEach(p => console.log(`  [${p.id}] ${p.accion}: ${p.titulo}\n       ${p.razon}`));
      break;
    }
    case 'forget': {
      const [id, ...reasonParts] = args;
      if (!id || reasonParts.length === 0) {
        console.error('Uso: memory-audit.cjs forget <id> "<razón>"'); process.exit(1);
      }
      const result = forgetMemory(db, parseInt(id), reasonParts.join(' '), projectRoot);
      console.log(result.ok ? `✅ Olvidado: "${result.titulo}"` : `Error: ${result.error}`);
      break;
    }
    case 'approve': {
      const [id] = args;
      if (!id) { console.error('Uso: memory-audit.cjs approve <id>'); process.exit(1); }
      const result = approveMemory(db, parseInt(id), projectRoot);
      console.log(result.ok ? `✅ Vigencia confirmada para id=${id}` : `Error: ${result.error}`);
      break;
    }
    case 'migrate': {
      migrateVigenciaTipo(db);
      console.log('✅ vigencia_tipo migrado');
      break;
    }
    default:
      console.log('Uso: node memory-audit.cjs [report | stale | contradictions | propose | forget <id> <razón> | approve <id> | migrate]');
  }
}

module.exports = {
  migrateVigenciaTipo,
  verdadVigente,
  detectStale,
  detectContradictions,
  proposeConsolidations,
  forgetMemory,
  approveMemory,
  generateAuditReport,
  VIGENCIA_TIPOS,
};
