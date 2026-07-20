/**
 * Agentic KDD — Knowledge Validator v1.0
 * Brecha (d): Validación de conocimiento
 *
 * Problema: la memoria puede volverse obsoleta o corrompida.
 * - Obsolescencia: un patrón correcto hace 6 meses ya no aplica
 * - Memory poisoning: MINJA logra >95% de inyección vía recuperación
 *
 * Solución (patrón SSGM + OWASP):
 *   1. Frontmatter YAML por entrada: fecha, última_validación, estado, hash_contexto
 *   2. hash_contexto = hash de los archivos a los que aplica la entrada
 *   3. Si esos archivos cambiaron desde última_validación → marcar SOSPECHOSO
 *   4. Temporal decay: entradas > 60 días sin validación pierden peso
 *   5. validate_knowledge() MCP tool que agentes llaman antes de aplicar un patrón
 *
 * Estados posibles:
 *   ACTIVO      → válido, confiable
 *   SOSPECHOSO  → archivos de referencia cambiaron — revisar antes de aplicar
 *   OBSOLETO    → no validado en > 90 días Y decay < 10%
 *   HISTORICO   → invalidado explícitamente, preservado para auditoría
 *
 * Uso:
 *   node knowledge-validator.cjs scan           — escanear toda la memoria
 *   node knowledge-validator.cjs validate <id>  — validar una entrada
 *   node knowledge-validator.cjs report         — reporte de estado
 *   node knowledge-validator.cjs revalidate <id> — marcar como revalidado
 */

'use strict';

const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');

const DECAY_LAMBDA      = 0.05;  // mismo que kdd-memory
const SUSPECT_DAYS      = 30;    // días sin validar → SOSPECHOSO
const OBSOLETE_DAYS     = 90;    // días sin validar → OBSOLETO
const OBSOLETE_DECAY    = 0.10;  // si decay < 10% → candidato a OBSOLETO
const POISON_SIMILARITY = 0.95;  // Jaccard para detectar entradas inyectadas

// ─── DB ───────────────────────────────────────────────────────────────────────

function openDB(projectRoot) {
  const dbPath = path.join(projectRoot, '.agentic/memoria.db');
  let db;
  try { db = new (require('better-sqlite3'))(dbPath); }
  catch { try { const { DatabaseSync } = require('node:sqlite'); db = new DatabaseSync(dbPath); } catch { return null; } }

  // Migrar schema para campos de validación
  try {
    db.exec(`ALTER TABLE nodos ADD COLUMN hash_contexto TEXT`);
  } catch {}
  try {
    db.exec(`ALTER TABLE nodos ADD COLUMN ultima_validacion TEXT`);
  } catch {}
  try {
    db.exec(`ALTER TABLE nodos ADD COLUMN archivos_aplica TEXT DEFAULT '[]'`);
  } catch {}
  try {
    db.exec(`ALTER TABLE nodos ADD COLUMN validation_score REAL DEFAULT 1.0`);
  } catch {}
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_nodos_vigencia ON nodos(vigencia_tipo)`);
  } catch {}

  return db;
}

const safe = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };

// ─── HASH DE CONTEXTO ─────────────────────────────────────────────────────────
/**
 * Genera hash de los archivos referenciados por una entrada.
 * Si los archivos cambian, el hash cambia → SOSPECHOSO.
 */
function computeContextHash(archivosAplica, projectRoot) {
  if (!archivosAplica || archivosAplica.length === 0) return null;

  const hasher = crypto.createHash('sha256');
  let anyFound = false;

  archivosAplica.forEach(filePath => {
    const fullPath = path.isAbsolute(filePath)
      ? filePath
      : path.join(projectRoot, filePath);

    if (fs.existsSync(fullPath)) {
      try {
        const stat = fs.statSync(fullPath);
        hasher.update(`${filePath}:${stat.size}:${stat.mtimeMs}`);
        anyFound = true;
      } catch {}
    }
  });

  return anyFound ? hasher.digest('hex').substring(0, 16) : null;
}

// ─── TEMPORAL DECAY ──────────────────────────────────────────────────────────

function computeDecay(ultimaValidacion, fechaCreacion) {
  const dateStr = ultimaValidacion || fechaCreacion;
  if (!dateStr) return 0.5;
  const deltaDays = (Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24);
  return Math.exp(-DECAY_LAMBDA * deltaDays);
}

// ─── DETECTAR POSIBLE MEMORY POISONING ───────────────────────────────────────
/**
 * Detecta entradas sospechosas por similitud extrema con otras entradas.
 * Similitud > 95% Jaccard entre entradas de la misma área = posible inyección.
 * Patrón MINJA/MemoryGraft: inyección de variantes de entradas existentes.
 */
function detectPoisoning(db) {
  const suspicious = [];

  const nodes = safe(() =>
    db.prepare(`
      SELECT id, titulo, contenido, area, tipo, fecha_creacion
      FROM nodos
      WHERE estado = 'ACTIVO' AND tipo IN ('patron','error','decision')
      ORDER BY area, tipo
    `).all()
  ) || [];

  const jaccardSim = (a, b) => {
    const setA = new Set((a || '').toLowerCase().split(/\W+/).filter(Boolean));
    const setB = new Set((b || '').toLowerCase().split(/\W+/).filter(Boolean));
    if (setA.size === 0 || setB.size === 0) return 0;
    const inter = new Set([...setA].filter(x => setB.has(x)));
    const union = new Set([...setA, ...setB]);
    return inter.size / union.size;
  };

  // Comparar por área y tipo para reducir complejidad
  const byAreaType = {};
  nodes.forEach(n => {
    const key = `${n.area}:${n.tipo}`;
    if (!byAreaType[key]) byAreaType[key] = [];
    byAreaType[key].push(n);
  });

  Object.values(byAreaType).forEach(group => {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const textA = `${group[i].titulo} ${group[i].contenido}`;
        const textB = `${group[j].titulo} ${group[j].contenido}`;
        const sim = jaccardSim(textA, textB);

        if (sim >= POISON_SIMILARITY) {
          // La más reciente es la sospechosa
          const newer = new Date(group[i].fecha_creacion) > new Date(group[j].fecha_creacion)
            ? group[i] : group[j];
          suspicious.push({
            id:         newer.id,
            similarity: Math.round(sim * 100),
            reason:     `Near-duplicate of existing entry (${Math.round(sim*100)}% similarity) — possible memory injection`,
            compared_to: newer === group[i] ? group[j].id : group[i].id,
          });
        }
      }
    }
  });

  return suspicious;
}

// ─── VALIDAR UNA ENTRADA ─────────────────────────────────────────────────────

function validateEntry(db, nodeId, projectRoot) {
  const node = safe(() =>
    db.prepare(`
      SELECT id, titulo, contenido, area, tipo, confianza, vigencia_tipo,
             hash_contexto, ultima_validacion, archivos_aplica, fecha_creacion, fecha_update
      FROM nodos WHERE id = ?
    `).get(nodeId)
  );

  if (!node) return { ok: false, reason: 'not_found' };

  const result = {
    id:            node.id,
    titulo:        node.titulo,
    area:          node.area,
    tipo:          node.tipo,
    status:        'ACTIVO',
    decay:         0,
    issues:        [],
    recommendation:'',
  };

  // 1. Temporal decay
  result.decay = computeDecay(node.ultima_validacion, node.fecha_creacion);

  const daysSinceValidation = node.ultima_validacion
    ? (Date.now() - new Date(node.ultima_validacion).getTime()) / (1000 * 60 * 60 * 24)
    : (Date.now() - new Date(node.fecha_creacion).getTime()) / (1000 * 60 * 60 * 24);

  // 2. Verificar hash de archivos referenciados
  let archivos = [];
  try { archivos = JSON.parse(node.archivos_aplica || '[]'); } catch {}

  if (archivos.length > 0) {
    const currentHash = computeContextHash(archivos, projectRoot);
    if (currentHash && node.hash_contexto && currentHash !== node.hash_contexto) {
      // PIEZA 1 (aditivo — change-classifier): computeContextHash usa size+mtime,
      // así que hasta re-guardar un archivo idéntico o cambiar un comentario dispara
      // esta alerta. Antes de marcar SOSPECHOSO, preguntar al clasificador si TODOS
      // los archivos cambiaron solo cosméticamente (misma estructura de símbolos/
      // imports/firmas). Solo se suprime con certeza total: cualquier cambio
      // STRUCTURAL o archivo sin baseline → la alerta se emite igual que siempre.
      // Si el clasificador no existe o falla → comportamiento original intacto.
      let cosmeticOnly = false;
      try { cosmeticOnly = require('./change-classifier.cjs').allCosmetic(archivos, projectRoot); } catch {}

      if (cosmeticOnly) {
        result.cosmetic_skip = true;   // visible para debugging, no afecta estado
      } else {
        result.issues.push({
          type:    'stale_context',
          message: `Referenced files changed since last validation. Hash: ${node.hash_contexto} → ${currentHash}`,
          files:   archivos,
        });
      }
    }
  }

  // 3. Determinar estado
  if (daysSinceValidation > OBSOLETE_DAYS && result.decay < OBSOLETE_DECAY) {
    result.status = 'OBSOLETO';
    result.issues.push({ type: 'obsolete', message: `Not validated in ${Math.round(daysSinceValidation)} days and decay < 10%` });
  } else if (daysSinceValidation > SUSPECT_DAYS || result.issues.some(i => i.type === 'stale_context')) {
    result.status = 'SOSPECHOSO';
    if (daysSinceValidation > SUSPECT_DAYS) {
      result.issues.push({ type: 'stale', message: `Not validated in ${Math.round(daysSinceValidation)} days` });
    }
  }

  // 4. Score de validación (0-1)
  const issuesPenalty = result.issues.reduce((p, issue) => {
    return p * (issue.type === 'stale_context' ? 0.6 : issue.type === 'obsolete' ? 0.2 : 0.8);
  }, 1.0);

  result.validation_score = Math.max(0.05, result.decay * issuesPenalty);

  // 5. Recomendación
  result.recommendation = result.status === 'ACTIVO' ? 'Apply normally'
    : result.status === 'SOSPECHOSO' ? 'Verify before applying — context may have changed'
    : 'Do not apply — revalidate manually or mark as HISTORICO';

  // 6. Actualizar estado en DB si cambió
  if (result.status !== 'ACTIVO' && node.vigencia_tipo !== result.status) {
    safe(() => db.prepare(`
      UPDATE nodos SET
        vigencia_tipo = ?,
        validation_score = ?,
        fecha_update = datetime('now')
      WHERE id = ?
    `).run(result.status, result.validation_score, nodeId));
  } else {
    safe(() => db.prepare(`UPDATE nodos SET validation_score = ? WHERE id = ?`)
      .run(result.validation_score, nodeId));
  }

  return result;
}

// ─── SCAN COMPLETO ────────────────────────────────────────────────────────────

function scanAll(projectRoot) {
  projectRoot = projectRoot || process.cwd();
  const db = openDB(projectRoot);
  if (!db) return { error: 'DB unavailable' };

  const nodes = safe(() =>
    db.prepare(`
      SELECT id FROM nodos
      WHERE estado = 'ACTIVO'
        AND tipo IN ('patron','error','decision','regla')
      ORDER BY fecha_update ASC
      LIMIT 500
    `).all()
  ) || [];

  const results = { total: nodes.length, activo: 0, sospechoso: 0, obsoleto: 0, poison_candidates: 0 };

  nodes.forEach(n => {
    const r = validateEntry(db, n.id, projectRoot);
    if (r.status === 'ACTIVO') results.activo++;
    else if (r.status === 'SOSPECHOSO') results.sospechoso++;
    else if (r.status === 'OBSOLETO') results.obsoleto++;
  });

  // Detectar posible memory poisoning
  const poisonCandidates = detectPoisoning(db);
  results.poison_candidates = poisonCandidates.length;

  // Marcar candidatos sospechosos de poisoning
  poisonCandidates.forEach(p => {
    safe(() => db.prepare(`
      UPDATE nodos SET vigencia_tipo = 'SOSPECHOSO', fecha_update = datetime('now')
      WHERE id = ? AND vigencia_tipo = 'VIGENTE'
    `).run(p.id));
  });

  results.poison_suspects = poisonCandidates.slice(0, 5);
  db.close();
  return results;
}

// ─── VALIDATE_KNOWLEDGE — MCP TOOL ───────────────────────────────────────────
/**
 * El agente Analista llama esto antes de aplicar un patrón de memoria.
 * Retorna si el patrón es confiable o debe ser revisado.
 */
function validateKnowledge(nodeId, projectRoot) {
  projectRoot = projectRoot || process.cwd();
  const db = openDB(projectRoot);
  if (!db) return { trusted: true, reason: 'DB unavailable — proceeding' };

  const result = validateEntry(db, nodeId, projectRoot);
  db.close();

  return {
    trusted:           result.status === 'ACTIVO',
    status:            result.status,
    validation_score:  result.validation_score,
    decay:             Math.round(result.decay * 100) / 100,
    issues:            result.issues,
    recommendation:    result.recommendation,
    apply:             result.status !== 'OBSOLETO',
    warn:              result.status === 'SOSPECHOSO',
  };
}

// ─── REVALIDAR ────────────────────────────────────────────────────────────────

function revalidate(nodeId, projectRoot) {
  projectRoot = projectRoot || process.cwd();
  const db = openDB(projectRoot);
  if (!db) return { ok: false };

  const archivos = safe(() => {
    const n = db.prepare("SELECT archivos_aplica FROM nodos WHERE id = ?").get(nodeId);
    return JSON.parse(n?.archivos_aplica || '[]');
  }) || [];

  const newHash = computeContextHash(archivos, projectRoot);

  safe(() => db.prepare(`
    UPDATE nodos SET
      vigencia_tipo = 'VIGENTE',
      ultima_validacion = datetime('now'),
      hash_contexto = ?,
      validation_score = 1.0,
      fecha_update = datetime('now')
    WHERE id = ?
  `).run(newHash, nodeId));

  // PIEZA 1 (aditivo): al revalidar, refrescar también el fingerprint baseline de
  // esos archivos — el estado actual pasa a ser la nueva referencia estructural.
  try { require('./change-classifier.cjs').snapshotFiles(archivos, projectRoot); } catch {}

  db.close();
  return { ok: true, id: nodeId, new_hash: newHash, revalidated_at: new Date().toISOString() };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const [,, cmd, arg] = process.argv;
  const projectRoot = process.cwd();

  switch (cmd) {
    case 'scan': {
      console.log('\n[VALIDATOR] Scanning memory...');
      const r = scanAll(projectRoot);
      if (r.error) { console.log(`❌ ${r.error}`); break; }
      console.log(`\n  Knowledge Validation Report`);
      console.log(`  Total scanned:     ${r.total}`);
      console.log(`  ✅ ACTIVO:         ${r.activo}`);
      console.log(`  ⚠️  SOSPECHOSO:     ${r.sospechoso}`);
      console.log(`  ❌ OBSOLETO:        ${r.obsoleto}`);
      console.log(`  🔍 Poison suspects: ${r.poison_candidates}`);
      if (r.poison_suspects?.length > 0) {
        console.log('\n  Possible injections:');
        r.poison_suspects.forEach(p => console.log(`    - ${p.id}: ${p.reason}`));
      }
      console.log('');
      break;
    }

    case 'validate': {
      if (!arg) { console.log('Uso: knowledge-validator.cjs validate <node_id>'); break; }
      const r = validateKnowledge(arg, projectRoot);
      console.log(`\n  ID: ${arg}`);
      console.log(`  Status: ${r.status} | Score: ${r.validation_score}`);
      console.log(`  Trusted: ${r.trusted} | Apply: ${r.apply}`);
      console.log(`  → ${r.recommendation}\n`);
      break;
    }

    case 'revalidate': {
      if (!arg) { console.log('Uso: knowledge-validator.cjs revalidate <node_id>'); break; }
      const r = revalidate(arg, projectRoot);
      console.log(r.ok ? `✅ Revalidated: ${arg}` : `❌ Failed`);
      break;
    }

    case 'report': {
      const r = scanAll(projectRoot);
      const health = r.total > 0 ? Math.round((r.activo / r.total) * 100) : 0;
      console.log(`\n  Memory Health: ${health}% (${r.activo}/${r.total} entries valid)`);
      if (r.sospechoso > 0) console.log(`  ⚠️  ${r.sospechoso} entries need review`);
      if (r.obsoleto > 0) console.log(`  ❌ ${r.obsoleto} entries are obsolete`);
      if (r.poison_candidates > 0) console.log(`  🔍 ${r.poison_candidates} possible injections detected`);
      console.log('');
      break;
    }

    default:
      console.log('Uso: node knowledge-validator.cjs [scan | validate <id> | revalidate <id> | report]');
  }
}

module.exports = { validateKnowledge, validateEntry, revalidate, scanAll, detectPoisoning, computeContextHash };
