/**
 * Agentic KDD — Creative Engine v1.0
 * Directed Creative Autonomy (DCA)
 *
 * El agente no solo ejecuta lo pedido — interpreta el proyecto y aporta valor
 * adicional dentro de los límites del libreto.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  NIVELES DE AUTONOMÍA:                                                  │
 * │                                                                         │
 * │  NIVEL 0 — ESTRICTO                                                     │
 * │    Ejecuta exactamente lo pedido. Sin sugerencias.                      │
 * │    Activar para: cambios sensibles, bugs críticos, reglas de negocio    │
 * │                                                                         │
 * │  NIVEL 1 — ASISTIDO (DEFAULT)                                           │
 * │    Ejecuta y sugiere mejoras al final del ciclo.                        │
 * │    NUNCA aplica sugerencias sin permiso explícito.                      │
 * │    Activo desde el primer ciclo.                                        │
 * │                                                                         │
 * │  NIVEL 2 — CREATIVO CONTROLADO (auto-eleva con 10+ contratos)          │
 * │    Puede aplicar mejoras locales si:                                    │
 * │      - blast_radius == LOW (≤ 3 contratos)                             │
 * │      - No rompe ningún contrato VERIFIED o PROTECTED                   │
 * │      - La mejora está respaldada por memoria del proyecto               │
 * │      - El impacto es local (< 3 archivos)                               │
 * │                                                                         │
 * │  NIVEL 3 — EXPLORATORIO (manual, solo para prototipos)                  │
 * │    Para proyectos con poca documentación. Infiere más, propone más.     │
 * │    Activo solo con: aa: explore <tarea>                                 │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * GUARDRAILS (siempre activos independientemente del nivel):
 *   1. Nunca toca contratos PROTECTED
 *   2. Blast radius CRITICAL → bloquea cualquier acción creativa
 *   3. Toda acción creativa queda auditada y es reversible
 *   4. Mejoras creativas se guardan como creative_win en memoria
 *
 * Uso:
 *   node creative-engine.cjs level          — ver nivel actual
 *   node creative-engine.cjs suggest <area> — ver sugerencias pendientes
 *   node creative-engine.cjs apply <id>     — aplicar una sugerencia
 *   node creative-engine.cjs dismiss <id>   — descartar una sugerencia
 *   node creative-engine.cjs wins           — ver mejoras creativas previas
 */

'use strict';

const path = require('path');
const fs   = require('fs');

// ─── CONSTANTES ───────────────────────────────────────────────────────────────

const LEVEL_NAMES = {
  0: 'STRICT',
  1: 'ASSISTED',
  2: 'CREATIVE_CONTROLLED',
  3: 'EXPLORATORY',
};

const LEVEL_2_MIN_CONTRACTS   = 10;  // contratos protegidos mínimos para auto-elevar a nivel 2
const MAX_SUGGESTIONS_STORED  = 50;  // máx sugerencias pendientes en DB

// Tipos de sugerencia con metadata
const SUGGESTION_TYPES = {
  SIMPLIFICATION:   { label: 'Simplification',   risk: 'LOW',    auto_apply_at: 2 },
  ABSTRACTION:      { label: 'Abstraction',       risk: 'MEDIUM', auto_apply_at: 3 },
  REFACTOR:         { label: 'Refactor',          risk: 'MEDIUM', auto_apply_at: 3 },
  PATTERN:          { label: 'Pattern',           risk: 'LOW',    auto_apply_at: 2 },
  FRAGILITY:        { label: 'Fragility warning', risk: 'HIGH',   auto_apply_at: null }, // nunca auto-aplica
  DEAD_CODE:        { label: 'Dead code',         risk: 'LOW',    auto_apply_at: 2 },
  MISSING_TEST:     { label: 'Missing test',      risk: 'MEDIUM', auto_apply_at: null },
  OPPORTUNITY:      { label: 'Opportunity',       risk: 'LOW',    auto_apply_at: 2 },
  ARCHITECTURE:     { label: 'Architecture',      risk: 'HIGH',   auto_apply_at: null },
  ROOT_CAUSE:       { label: 'Root cause',        risk: 'HIGH',   auto_apply_at: null }, // nunca auto-aplica
  ERROR_LIKELY_FIXED: { label: 'Error likely fixed', risk: 'MEDIUM', auto_apply_at: null }, // nunca auto-aplica — cambia estado en memoria, siempre requiere confirmación
};

// Mismo criterio de "palabras clave compartidas" que reasoning-bank.cjs usa para
// fusionar estrategias parecidas — duplicado aquí (no importado) a propósito:
// cada módulo de .agentic/grafo/ es standalone y se apaga solo si falla, nunca
// se lleva a otro módulo consigo.
const STOPWORDS = new Set([
  'fix', 'real', 'critico', 'crítico', 'bug', 'error', 'feature', 'chore', 'ux', 'ui',
  'de', 'la', 'el', 'en', 'no', 'se', 'y', 'a', 'un', 'una', 'del', 'con', 'para', 'por',
  'que', 'los', 'las', 'al', 'sin', 'ya', 'su', 'lo', 'es', 'o', 'u', 'e',
  'the', 'and', 'to', 'of', 'for', 'in', 'on', 'is', 'it', 'be', 'was', 'were', 'are',
]);
const MIN_SHARED_TOKENS = 2;

function tokenize(s) {
  return [...new Set((String(s || '').toLowerCase().match(/[a-z0-9áéíóúñü]{2,}/gi) || []))];
}

function significantTokens(s) {
  return tokenize(s).filter(t => !STOPWORDS.has(t) && t.length >= 2);
}

// ─── DB ───────────────────────────────────────────────────────────────────────

function openDB(projectRoot) {
  const dbPath = path.join(projectRoot, '.agentic/memoria.db');
  try { return new (require('better-sqlite3'))(dbPath); } catch {}
  try { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(dbPath); } catch {}
  return null;
}

// ─── SCHEMA ───────────────────────────────────────────────────────────────────

function migrateSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS creative_suggestions (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      file TEXT,
      module TEXT,
      area TEXT DEFAULT 'global',
      risk_level TEXT DEFAULT 'LOW',
      blast_radius INTEGER DEFAULT 0,
      evidence TEXT,
      auto_applicable INTEGER DEFAULT 0,
      applied INTEGER DEFAULT 0,
      dismissed INTEGER DEFAULT 0,
      ciclo_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      applied_at TEXT,
      result TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS creative_wins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      suggestion_id TEXT,
      description TEXT NOT NULL,
      type TEXT NOT NULL,
      module TEXT,
      file TEXT,
      impact TEXT,
      ciclo_id TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  try { db.exec("CREATE INDEX IF NOT EXISTS idx_suggestions_module ON creative_suggestions(module)"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_suggestions_applied ON creative_suggestions(applied, dismissed)"); } catch {}
}

// ─── NIVEL ACTUAL ─────────────────────────────────────────────────────────────

/**
 * Determina el nivel de autonomía creativa basado en:
 *   - config.md (override manual del dev)
 *   - cantidad de contratos protegidos en DB
 */
function getCurrentLevel(db, projectRoot) {
  // 1. Verificar override manual en config.md
  const configPath = path.join(projectRoot, '.agentic/config.md');
  if (fs.existsSync(configPath)) {
    const config = fs.readFileSync(configPath, 'utf8');
    const levelMatch = config.match(/creative_mode:\s*(\d+)/i);
    if (levelMatch) {
      const manualLevel = parseInt(levelMatch[1]);
      return {
        level: manualLevel,
        name: LEVEL_NAMES[manualLevel] || 'CUSTOM',
        source: 'manual (config.md)',
        auto_apply: manualLevel >= 2,
      };
    }
    // Modo strict explícito
    if (/creative_mode:\s*strict/i.test(config)) {
      return { level: 0, name: 'STRICT', source: 'manual (config.md)', auto_apply: false };
    }
  }

  // 2. Auto-determinar por cantidad de contratos protegidos
  if (db) {
    try {
      const protectedCount = db.prepare(
        "SELECT COUNT(*) as n FROM verified_contracts WHERE status IN ('protected','verified')"
      ).get()?.n || 0;

      if (protectedCount >= LEVEL_2_MIN_CONTRACTS) {
        return {
          level: 2,
          name: 'CREATIVE_CONTROLLED',
          source: `auto (${protectedCount} verified contracts)`,
          auto_apply: true,
          protected_contracts: protectedCount,
        };
      }

      return {
        level: 1,
        name: 'ASSISTED',
        source: `auto (${protectedCount}/${LEVEL_2_MIN_CONTRACTS} contracts for level 2)`,
        auto_apply: false,
        protected_contracts: protectedCount,
        contracts_needed: LEVEL_2_MIN_CONTRACTS - protectedCount,
      };
    } catch {}
  }

  return { level: 1, name: 'ASSISTED', source: 'default', auto_apply: false };
}

// ─── REGISTRAR SUGERENCIA ─────────────────────────────────────────────────────

function addSuggestion(db, suggestion, cicloId) {
  if (!db) return null;

  const id = require('crypto')
    .createHash('md5')
    .update(`${suggestion.type}:${suggestion.title}:${suggestion.file || ''}`)
    .digest('hex')
    .substring(0, 8);

  const typeConfig = SUGGESTION_TYPES[suggestion.type] || SUGGESTION_TYPES.OPPORTUNITY;
  const currentLevel = getCurrentLevel(db, process.cwd());
  const autoApplicable = currentLevel.auto_apply &&
                          typeConfig.auto_apply_at !== null &&
                          currentLevel.level >= typeConfig.auto_apply_at &&
                          (suggestion.blast_radius || 0) <= 3;

  try {
    db.prepare(`
      INSERT OR IGNORE INTO creative_suggestions
        (id, type, title, description, file, module, area, risk_level,
         blast_radius, evidence, auto_applicable, ciclo_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, suggestion.type, suggestion.title,
      suggestion.description || '', suggestion.file || null,
      suggestion.module || 'global', suggestion.area || 'global',
      typeConfig.risk, suggestion.blast_radius || 0,
      JSON.stringify(suggestion.evidence || []),
      autoApplicable ? 1 : 0, cicloId
    );
  } catch {}

  return { id, auto_applicable: autoApplicable };
}

// ─── DETECTAR OPORTUNIDADES ───────────────────────────────────────────────────

/**
 * Analiza el proyecto y detecta oportunidades de mejora.
 * Llamar después de cada ciclo completado.
 */
function detectOpportunities(db, projectRoot, cicloId, context = {}) {
  const suggestions = [];

  if (!db) return suggestions;

  // ── 1. Código sin tests (missing test coverage) ───────────────────────────
  try {
    const highRiskNodes = db.prepare(`
      SELECT titulo, area, contenido FROM nodos
      WHERE tipo = 'error'
        AND confianza IN ('ALTA', 'MEDIA')
        AND estado = 'ACTIVO'
        AND (vigencia_tipo = 'VIGENTE' OR vigencia_tipo IS NULL)
    `).all();

    for (const node of highRiskNodes.slice(0, 5)) {
      // Verificar si existe un contrato que cubra esta área
      const contractExists = db.prepare(`
        SELECT COUNT(*) as n FROM verified_contracts
        WHERE module = ? AND status IN ('verified', 'protected')
      `).get(node.area)?.n || 0;

      if (!contractExists) {
        const s = addSuggestion(db, {
          type: 'MISSING_TEST',
          title: `No verified contract for error area: ${node.area}`,
          description: `Error "${node.titulo}" has no verified contract protecting it. Consider adding tests.`,
          module: node.area,
          risk_level: 'MEDIUM',
          evidence: [{ type: 'error_node', titulo: node.titulo }],
        }, cicloId);
        if (s) suggestions.push(s);
      }
    }
  } catch {}

  // ── 2. Módulos con alta tasa de regresiones ───────────────────────────────
  try {
    const regressionProne = db.prepare(`
      SELECT module, COUNT(*) as fails
      FROM verified_contracts
      WHERE failure_count > 0
      GROUP BY module
      HAVING fails >= 2
      ORDER BY fails DESC
      LIMIT 5
    `).all();

    for (const mod of regressionProne) {
      const s = addSuggestion(db, {
        type: 'FRAGILITY',
        title: `Module "${mod.module}" has ${mod.fails} contract failures — fragility detected`,
        description: `This module has had repeated contract violations. Consider architecture review.`,
        module: mod.module,
        risk_level: 'HIGH',
        evidence: [{ type: 'regression_count', count: mod.fails }],
      }, cicloId);
      if (s) suggestions.push(s);
    }
  } catch {}

  // ── 3. Patrones repetidos sin abstracción ─────────────────────────────────
  try {
    const patterns = db.prepare(`
      SELECT titulo, area, aplicado FROM nodos
      WHERE tipo = 'patron'
        AND confianza = 'ALTA'
        AND aplicado >= 5
        AND (vigencia_tipo = 'VIGENTE' OR vigencia_tipo IS NULL)
      ORDER BY aplicado DESC LIMIT 5
    `).all();

    for (const p of patterns) {
      const s = addSuggestion(db, {
        type: 'ABSTRACTION',
        title: `Pattern "${p.titulo}" applied ${p.aplicado}× — abstraction opportunity`,
        description: `This pattern appears frequently in ${p.area}. Consider extracting it into a shared utility.`,
        module: p.area,
        risk_level: 'LOW',
        evidence: [{ type: 'pattern', titulo: p.titulo, count: p.aplicado }],
      }, cicloId);
      if (s) suggestions.push(s);
    }
  } catch {}

  // ── 4. Causal edges de regresiones → oportunidad de refactor ─────────────
  try {
    const regressions = db.prepare(`
      SELECT desde_entidad, COUNT(*) as n
      FROM relaciones_semanticas
      WHERE tipo = 'regressed_by'
        AND (invalid_at IS NULL OR invalid_at = '')
      GROUP BY desde_entidad
      HAVING n >= 2
      LIMIT 5
    `).all();

    for (const r of regressions) {
      const s = addSuggestion(db, {
        type: 'REFACTOR',
        title: `"${r.desde_entidad}" regressed ${r.n} times — refactor candidate`,
        description: `This component has caused ${r.n} regressions. A refactor could reduce coupling and fragility.`,
        file: r.desde_entidad,
        module: r.desde_entidad.split('/')[0] || 'global',
        risk_level: 'MEDIUM',
        evidence: [{ type: 'regression_edge', file: r.desde_entidad, count: r.n }],
      }, cicloId);
      if (s) suggestions.push(s);
    }
  } catch {}

  // ── 5. Síntomas repetidos sin resolver → clúster de causa raíz ────────────
  // Lo inverso de un contrato: un contrato dice "esto funcionó N veces →
  // protegido"; esto dice "esto falló con la misma área/raíz N veces → alerta
  // de que hay que investigarlo". Errores runtime (ej. caídas de sesión de un
  // servicio externo) no pasan por verified_contracts porque no hay un test
  // automatizado que los reproduzca, así que el bloque 2 (arriba) no los ve.
  try {
    const clusters = db.prepare(`
      SELECT area, COUNT(*) as n
      FROM nodos
      WHERE tipo = 'error' AND estado = 'ACTIVO' AND area != 'global'
      GROUP BY area
      HAVING n >= 3
      ORDER BY n DESC
      LIMIT 5
    `).all();

    for (const c of clusters) {
      const examples = db.prepare(`
        SELECT titulo FROM nodos
        WHERE tipo = 'error' AND estado = 'ACTIVO' AND area = ?
        ORDER BY fecha_creacion DESC LIMIT 3
      `).all(c.area).map(r => r.titulo.slice(0, 70));

      const s = addSuggestion(db, {
        type: 'ROOT_CAUSE',
        title: `${c.n} errores activos sin resolver en "${c.area}" — posible causa raíz común`,
        description: `Se acumularon ${c.n} errores distintos en el área "${c.area}" sin marcar como resueltos. Aunque se vean distintos, vale la pena revisar si comparten una misma causa de fondo antes de que sigan creciendo. Ejemplos:\n- ${examples.join('\n- ')}`,
        module: c.area,
        area: c.area,
        risk_level: 'HIGH',
        evidence: [{ type: 'error_cluster', area: c.area, count: c.n, examples }],
      }, cicloId);
      if (s) suggestions.push(s);
    }
  } catch {}

  // ── 6. Ciclo reciente coincide con error(es) activos → posible resuelto ──
  // Cuando un ciclo soluciona un bug, casi nadie vuelve al grafo a marcar el
  // nodo de error como resuelto — se queda ACTIVO para siempre aunque ya no
  // exista. No cruzamos por área porque no coincide de forma confiable (ej.
  // un fix de WhatsApp cae en ciclos.area='whatsapp' pero el error real quedó
  // archivado en nodos.area='auth'); en vez de eso cruzamos por palabras clave
  // compartidas entre la tarea del ciclo y el título del error — mismo umbral
  // (>=2 tokens de dominio) que reasoning-bank.cjs usa para fusionar
  // estrategias parecidas. Nunca marca nada solo: crea una sugerencia que hay
  // que confirmar con `creative-engine.cjs apply <id>`.
  try {
    const recentCycles = db.prepare(`
      SELECT id, tarea, area FROM ciclos
      WHERE estado = 'COMPLETADO' AND tarea IS NOT NULL
      ORDER BY fecha_inicio DESC LIMIT 5
    `).all();

    const activeErrors = db.prepare(`
      SELECT id, titulo, area FROM nodos
      WHERE tipo = 'error' AND estado = 'ACTIVO'
      ORDER BY fecha_creacion DESC LIMIT 200
    `).all();

    for (const cycle of recentCycles) {
      const cTerms = significantTokens(cycle.tarea);
      if (cTerms.length < MIN_SHARED_TOKENS) continue;

      const matches = [];
      for (const node of activeErrors) {
        const nTerms = significantTokens(node.titulo);
        const shared = cTerms.filter(t => nTerms.includes(t));
        if (shared.length >= MIN_SHARED_TOKENS) matches.push({ node, shared });
      }
      matches.sort((a, b) => b.shared.length - a.shared.length);

      for (const { node, shared } of matches.slice(0, 3)) {
        const s = addSuggestion(db, {
          type: 'ERROR_LIKELY_FIXED',
          title: `Ciclo #${cycle.id} parece resolver el error activo #${node.id}: "${node.titulo.slice(0, 70)}"`,
          description: `La tarea del ciclo #${cycle.id} ("${cycle.tarea.slice(0, 140)}") comparte palabras clave (${shared.join(', ')}) con un error que sigue marcado ACTIVO en memoria. Si el fix realmente lo cubrió, aplica esta sugerencia para archivarlo como resuelto (pasa a OBSOLETO) — si no, descártala y no vuelve a aparecer.`,
          module: node.area,
          area: node.area,
          risk_level: 'MEDIUM',
          evidence: [{ type: 'cycle_fix_match', ciclo_id: cycle.id, error_node_id: node.id, shared_tokens: shared, area_ciclo: cycle.area, area_error: node.area }],
        }, cicloId);
        if (s) suggestions.push(s);
      }
    }
  } catch {}

  return suggestions;
}

// ─── APLICAR SUGERENCIA ───────────────────────────────────────────────────────

/**
 * Aplica una sugerencia si es auto_aplicable y el nivel lo permite.
 * Level 2: aplica si blast_radius ≤ 3 y no toca contratos PROTECTED.
 */
function applySuggestion(db, suggestionId, projectRoot, cicloId, opts = {}) {
  const { manual = false } = opts;
  if (!db) return { applied: false, reason: 'DB unavailable' };

  const suggestion = db.prepare('SELECT * FROM creative_suggestions WHERE id = ?').get(suggestionId);
  if (!suggestion) return { applied: false, reason: 'Suggestion not found' };
  if (suggestion.applied) return { applied: false, reason: 'Already applied' };
  if (suggestion.dismissed) return { applied: false, reason: 'Dismissed' };

  const level = getCurrentLevel(db, projectRoot);

  // Estos dos gates existen para el camino AUTOMÁTICO (runCreativePass decidiendo
  // solo, sin humano de por medio). Cuando `manual` viene de un humano invocando
  // `creative-engine.cjs apply <id>` explícitamente, ese comando YA ES la revisión
  // manual que el mensaje de error pide — bloquearlo también sería contradictorio
  // (nunca habría forma de aplicar nada por debajo de Nivel 2).
  if (!manual) {
    if (level.level < 2 && !suggestion.auto_applicable) {
      return { applied: false, reason: `Level ${level.level} (${level.name}) — apply manually (creative-engine.cjs apply <id>) or upgrade to Level 2` };
    }
    if (suggestion.blast_radius > 3) {
      return { applied: false, reason: `Blast radius ${suggestion.blast_radius} > 3 — requires manual review` };
    }
  }

  // Marcar como aplicada
  db.prepare(`
    UPDATE creative_suggestions SET applied = 1, applied_at = datetime('now')
    WHERE id = ?
  `).run(suggestionId);

  // Registrar como creative_win
  db.prepare(`
    INSERT INTO creative_wins (suggestion_id, description, type, module, file, impact, ciclo_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    suggestionId, suggestion.title, suggestion.type,
    suggestion.module, suggestion.file,
    `Applied at level ${level.level}`, cicloId
  );

  // Registrar en memoria como patrón
  try {
    db.prepare(`
      INSERT OR IGNORE INTO nodos (tipo, titulo, contenido, area, confianza, estado, vigencia_tipo, fecha_creacion, fecha_update)
      VALUES ('creative_win', ?, ?, ?, 'MEDIA', 'ACTIVO', 'VIGENTE', datetime('now'), datetime('now'))
    `).run(
      suggestion.title,
      `Creative improvement applied at level ${level.level}: ${suggestion.description}`,
      suggestion.module
    );
  } catch {}

  // Efecto real de un ERROR_LIKELY_FIXED: archivar el nodo de error en memoria.
  // Se marca OBSOLETO (valor ya existente en el schema, no uno nuevo) para que
  // desaparezca automáticamente de todas las consultas `estado='ACTIVO'` que ya
  // existen en el proyecto (clusters de causa raíz, contadores del dashboard,
  // etc.) sin tener que tocar cada una de ellas por separado.
  if (suggestion.type === 'ERROR_LIKELY_FIXED') {
    try {
      const evidence = JSON.parse(suggestion.evidence || '[]');
      const match = evidence.find(e => e.type === 'cycle_fix_match');
      if (match && match.error_node_id) {
        db.prepare(`
          UPDATE nodos
          SET estado = 'OBSOLETO',
              ultima_validacion = datetime('now'),
              fecha_update = datetime('now'),
              contenido = COALESCE(contenido, '') || ?
          WHERE id = ? AND tipo = 'error'
        `).run(`\n\n[Marcado OBSOLETO por creative-engine — sugerencia ${suggestionId}, ciclo #${match.ciclo_id}]`, match.error_node_id);
      }
    } catch {}
  }

  return { applied: true, suggestion_id: suggestionId, level_used: level.level, manual };
}

// ─── REPORTE DE SUGERENCIAS ───────────────────────────────────────────────────

function getSuggestions(db, module) {
  if (!db) return [];
  try {
    const query = module
      ? `SELECT * FROM creative_suggestions WHERE dismissed=0 AND applied=0 AND module=? ORDER BY created_at DESC LIMIT 20`
      : `SELECT * FROM creative_suggestions WHERE dismissed=0 AND applied=0 ORDER BY created_at DESC LIMIT 20`;
    return module ? db.prepare(query).all(module) : db.prepare(query).all();
  } catch { return []; }
}

function getCreativeWins(db, limit = 10) {
  if (!db) return [];
  try {
    return db.prepare(`SELECT * FROM creative_wins ORDER BY created_at DESC LIMIT ?`).all(limit);
  } catch { return []; }
}

// ─── INTEGRACIÓN CON CICLO ────────────────────────────────────────────────────

/**
 * Punto de entrada principal. Llamar al final de cada ciclo completado.
 * Detecta oportunidades y aplica las auto-aplicables según el nivel.
 */
function runCreativePass(db, projectRoot, cicloId, context = {}) {
  if (!db) return { level: 1, suggestions: [], auto_applied: [] };

  migrateSchema(db);

  const level = getCurrentLevel(db, projectRoot);
  const suggestions = detectOpportunities(db, projectRoot, cicloId, context);

  const autoApplied = [];

  // En nivel 2+, aplicar auto-aplicables
  if (level.level >= 2) {
    const autoApplicable = db.prepare(`
      SELECT id FROM creative_suggestions
      WHERE auto_applicable = 1 AND applied = 0 AND dismissed = 0
        AND blast_radius <= 3
      ORDER BY created_at DESC LIMIT 5
    `).all();

    for (const s of autoApplicable) {
      const result = applySuggestion(db, s.id, projectRoot, cicloId);
      if (result.applied) autoApplied.push(s.id);
    }
  }

  return {
    level: level.level,
    level_name: level.name,
    level_source: level.source,
    new_suggestions: suggestions.length,
    auto_applied: autoApplied.length,
    contracts_needed_for_level2: level.contracts_needed || 0,
  };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const [,, cmd, ...args] = process.argv;
  const projectRoot = process.cwd();

  const db = openDB(projectRoot);
  if (db) migrateSchema(db);

  switch (cmd) {
    case 'level': {
      const level = getCurrentLevel(db, projectRoot);
      console.log('\n══════════════════════════════════════════════');
      console.log('  Creative Engine — Current Level');
      console.log('══════════════════════════════════════════════');
      console.log(`  Level:   ${level.level} — ${level.name}`);
      console.log(`  Source:  ${level.source}`);
      console.log(`  Auto-apply: ${level.auto_apply ? '✅ Yes (LOW risk, LOCAL changes)' : '❌ No — suggestions only'}`);
      if (level.contracts_needed > 0) {
        console.log(`  → Need ${level.contracts_needed} more verified contracts to reach Level 2`);
        console.log(`  → Run more cycles and let contract-guard build the base`);
      }
      console.log('══════════════════════════════════════════════\n');
      break;
    }

    case 'suggest': {
      const suggestions = getSuggestions(db, args[0]);
      const icons = { FRAGILITY: '⚠️', MISSING_TEST: '🧪', REFACTOR: '🔧', PATTERN: '📐', OPPORTUNITY: '💡', ABSTRACTION: '🏗️', DEAD_CODE: '🗑️', SIMPLIFICATION: '✂️', ARCHITECTURE: '🏛️', ROOT_CAUSE: '🕵️', ERROR_LIKELY_FIXED: '✅' };
      console.log(`\nCreative Suggestions${args[0] ? ` [${args[0]}]` : ''} (${suggestions.length}):\n`);
      suggestions.forEach(s => {
        const icon = icons[s.type] || '💡';
        const autoTag = s.auto_applicable ? ' [AUTO]' : '';
        console.log(`  ${icon} [${s.id}]${autoTag} ${s.title}`);
        console.log(`     Type: ${s.type} | Risk: ${s.risk_level} | Module: ${s.module}`);
        if (s.description) console.log(`     ${s.description.substring(0, 100)}`);
        console.log();
      });
      if (suggestions.length === 0) console.log('  No suggestions — run a few cycles first.\n');
      break;
    }

    case 'apply': {
      const id = args[0];
      if (!id) { console.error('Uso: creative-engine.cjs apply <suggestion_id>'); break; }
      const result = applySuggestion(db, id, projectRoot, `manual-${Date.now()}`, { manual: true });
      console.log(result.applied
        ? `✅ Applied suggestion ${id}`
        : `❌ Not applied: ${result.reason}`
      );
      break;
    }

    case 'dismiss': {
      const id = args[0];
      if (!id) { console.error('Uso: creative-engine.cjs dismiss <suggestion_id>'); break; }
      if (db) db.prepare('UPDATE creative_suggestions SET dismissed=1 WHERE id=?').run(id);
      console.log(`✅ Dismissed suggestion ${id}`);
      break;
    }

    case 'wins': {
      const wins = getCreativeWins(db);
      console.log(`\nCreative Wins (${wins.length}):\n`);
      wins.forEach(w => {
        console.log(`  ✨ [${w.type}] ${w.description}`);
        console.log(`     Module: ${w.module} | ${w.created_at?.split('T')[0]}`);
      });
      if (wins.length === 0) console.log('  No creative wins yet.\n');
      break;
    }

    case 'run': {
      const result = runCreativePass(db, projectRoot, `manual-${Date.now()}`);
      console.log(`\nCreative Engine — Level ${result.level} (${result.level_name})`);
      console.log(`New suggestions: ${result.new_suggestions}`);
      console.log(`Auto-applied:   ${result.auto_applied}`);
      if (result.contracts_needed_for_level2 > 0) {
        console.log(`Level 2 in:     ${result.contracts_needed_for_level2} more verified contracts`);
      }
      break;
    }

    default:
      console.log('Uso: node creative-engine.cjs [level | suggest [module] | apply <id> | dismiss <id> | wins | run]');
  }
}

module.exports = {
  migrateSchema,
  getCurrentLevel,
  detectOpportunities,
  addSuggestion,
  applySuggestion,
  runCreativePass,
  getSuggestions,
  getCreativeWins,
  LEVEL_NAMES,
  SUGGESTION_TYPES,
};
