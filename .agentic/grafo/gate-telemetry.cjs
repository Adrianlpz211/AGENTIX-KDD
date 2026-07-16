'use strict';

/**
 * Gate Telemetry + Potenciadores de Memoria — Agentic KDD v3.14 (Plan 5)
 *
 * La pieza madre de los 6 potenciadores:
 *   T1  recordGateEvent/gateStats — la LIBRETA donde por fin se anotan los
 *       veredictos de los gates (antes: HIT/MISS/DOUBT/STOP se perdían al
 *       cerrar el chat — debilidad D5). Es la materia prima de "Agentix te
 *       frenó N roturas este mes" y del hueco L5-1.
 *   T2  anchorRecentErrors — errores de la memoria con ANCLA de símbolo
 *       (mismo formato que protected_symbols: nombres estables, jamás líneas).
 *   T3  linkErrorFixes — empareja error→fix por INTERSECCIÓN DE ANCLAS
 *       (números/igualdad exacta — cero fuzzy de títulos: esa clase de
 *       matching de texto produjo 3 bugs reales el 2026-07-15).
 *   T4  revalidateAnchors — curación anti-pudrición: marca anclas huérfanas,
 *       JAMÁS borra behaviors ni baja confianza.
 *   T7  applyMeritPromotion — confianza por MÉRITO (protecciones reales /
 *       verificación en navegador), no solo por calendario. Solo promueve,
 *       nunca degrada (v1) — ataca la debilidad D3 (3/48 HIGH).
 *
 * REGLA DE ORO (heredada de Planes 1-4): fail-soft TOTAL. Si cualquier pieza
 * de este módulo falla, el gate/ciclo que la llamó sigue como si el módulo no
 * existiera. La telemetría jamás bloquea; los potenciadores jamás rompen.
 *
 * Uso CLI:
 *   node .agentic/grafo/gate-telemetry.cjs stats [--desde=YYYY-MM-DD]
 *   node .agentic/grafo/gate-telemetry.cjs revalidate
 */

const fs = require('fs');
const path = require('path');

const safe = (fn, fb = null) => { try { return fn(); } catch { return fb; } };

// ─── SCHEMA (migración tolerante — patrón del repo) ───────────────────────────

function ensureTelemetrySchema(db) {
  safe(() => db.exec(`
    CREATE TABLE IF NOT EXISTS gate_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          TEXT DEFAULT (datetime('now')),
      gate        TEXT NOT NULL,
      verdict     TEXT NOT NULL,
      behavior_id TEXT,
      file        TEXT,
      detalle     TEXT DEFAULT '{}',
      cycle_hint  TEXT
    );
  `));
  safe(() => db.exec(`CREATE INDEX IF NOT EXISTS idx_ge_gate ON gate_events(gate, verdict)`));
  safe(() => db.exec(`CREATE INDEX IF NOT EXISTS idx_ge_behavior ON gate_events(behavior_id)`));
  // T2: anclas en la memoria KDD (errores/patrones/decisiones)
  safe(() => db.exec(`ALTER TABLE nodos ADD COLUMN anclas TEXT DEFAULT '[]'`));
  // Plan 7 (T5): quién protegió — hierro o protocolo. 'mechanical' = código que
  // corre sin depender del modelo; 'protocol' = el modelo siguiendo instrucción.
  // Publicable: "qué % de tus protecciones es hierro".
  safe(() => db.exec(`ALTER TABLE gate_events ADD COLUMN source TEXT DEFAULT 'mechanical'`));
  // T4: anclas retiradas por obsolescencia (rastro, no borrado)
  safe(() => db.exec(`ALTER TABLE protected_behaviors ADD COLUMN anclas_obsoletas TEXT DEFAULT '[]'`));
}

// ─── T1: LA LIBRETA ───────────────────────────────────────────────────────────

function recordGateEvent(db, ev) {
  try {
    if (!db || !ev || !ev.gate || !ev.verdict) return false;
    ensureTelemetrySchema(db);
    db.prepare(`
      INSERT INTO gate_events (gate, verdict, behavior_id, file, detalle, cycle_hint, source)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(ev.gate), String(ev.verdict),
      ev.behavior_id ? String(ev.behavior_id) : null,
      ev.file ? String(ev.file) : null,
      JSON.stringify(ev.detalle || {}),
      ev.cycle_hint ? String(ev.cycle_hint) : null,
      ev.source === 'protocol' ? 'protocol' : 'mechanical'
    );
    return true;
  } catch { return false; } // la telemetría JAMÁS tumba al que la llama
}

function gateStats(db, opts = {}) {
  const out = { total: 0, porGate: {}, porSource: {}, protecciones: 0, desde: opts.desde || null };
  try {
    ensureTelemetrySchema(db);
    const where = opts.desde ? `WHERE ts >= '${String(opts.desde).slice(0, 10)}'` : '';
    const rows = safe(() => db.prepare(
      `SELECT gate, verdict, COALESCE(source, 'mechanical') src, COUNT(*) n FROM gate_events ${where} GROUP BY gate, verdict, src`
    ).all()) || [];
    rows.forEach(r => {
      out.total += r.n;
      (out.porGate[r.gate] = out.porGate[r.gate] || {})[r.verdict] = ((out.porGate[r.gate] || {})[r.verdict] || 0) + r.n;
      out.porSource[r.src] = (out.porSource[r.src] || 0) + r.n;
      // "protección activada" = el guardia hizo su trabajo de verdad
      if (['HIT', 'STOP', 'FAIL'].includes(r.verdict)) out.protecciones += r.n;
    });
  } catch {}
  return out;
}

// ─── Helper compartido: anclas de un changeset (nombres estables) ─────────────
// Reusa computeTouchedSymbols del Plan 1 (regression-guard) — una sola fuente.

function anchorsForChangeset(db, changedFiles, projectRoot) {
  return safe(() => {
    const guard = require(path.join(__dirname, 'regression-guard.cjs'));
    if (typeof guard.computeTouchedSymbols !== 'function') return [];
    return guard.computeTouchedSymbols(db, changedFiles, projectRoot) || [];
  }, []);
}

const anchorKey = a => `${a.file}|${a.symbol_name}|${a.kind}`.toLowerCase().replace(/\\/g, '/');

// ─── T2: ERRORES CON DIRECCIÓN EXACTA ─────────────────────────────────────────
// Ancla los nodos error RECIENTES (últimos 7 días) del área del ciclo que aún
// no tienen anclas, usando los símbolos tocados por el changeset del ciclo.
// Conservador: solo llena anclas VACÍAS de nodos NUEVOS — jamás pisa anclas.

function anchorRecentErrors(db, { area, anchors }) {
  const out = { anclados: 0 };
  try {
    if (!anchors || !anchors.length) return out;
    ensureTelemetrySchema(db);
    const candidatos = safe(() => db.prepare(`
      SELECT id, titulo FROM nodos
      WHERE tipo = 'error' AND (anclas IS NULL OR anclas = '[]')
        AND (area = ? OR area LIKE ?)
        AND datetime(COALESCE(creado, ts, datetime('now'))) >= datetime('now', '-7 days')
    `).all(area, `%${area}%`), null);
    // el nombre de la columna de fecha varía entre versiones del schema —
    // si el query truena (columna inexistente), degradar a solo-área sin fecha
    const filas = candidatos !== null ? candidatos : (safe(() => db.prepare(`
      SELECT id, titulo FROM nodos
      WHERE tipo = 'error' AND (anclas IS NULL OR anclas = '[]')
        AND (area = ? OR area LIKE ?)
      ORDER BY id DESC LIMIT 3
    `).all(area, `%${area}%`)) || []);

    const json = JSON.stringify(anchors.slice(0, 30));
    for (const f of filas) {
      safe(() => db.prepare(`UPDATE nodos SET anclas = ? WHERE id = ? AND (anclas IS NULL OR anclas = '[]')`).run(json, f.id));
      out.anclados++;
    }
  } catch {}
  return out;
}

// ─── T3: ERROR → FIX POR INTERSECCIÓN DE ANCLAS (números, no títulos) ─────────
// Si los símbolos tocados por ESTE ciclo intersectan las anclas de un error
// ACTIVO registrado ANTES → ese ciclo probablemente lo arregló: se crea el
// edge causal error --was_fixed_by--> ciclo y sube `aplicado` del nodo.
// Cambiar el ESTADO del error sigue siendo decisión del curator/humano.

function linkErrorFixes(db, { anchors, cycleId, taskName, projectRoot }) {
  const out = { enlazados: 0 };
  try {
    if (!anchors || !anchors.length || !cycleId) return out;
    ensureTelemetrySchema(db);
    const tocados = new Set(anchors.map(anchorKey));
    const errores = safe(() => db.prepare(
      `SELECT id, titulo, anclas FROM nodos WHERE tipo = 'error' AND anclas IS NOT NULL AND anclas != '[]'`
    ).all()) || [];

    let addCausalEdge = null;
    safe(() => { addCausalEdge = require(path.join(__dirname, 'causal-edges.cjs')).addCausalEdge; });

    for (const e of errores) {
      const propias = safe(() => JSON.parse(e.anclas), []) || [];
      const hit = propias.some(a => a && a.symbol_name && tocados.has(anchorKey(a)));
      if (!hit) continue;
      // ¿ya está enlazado a este ciclo? — no duplicar
      const ya = safe(() => db.prepare(
        `SELECT 1 FROM relaciones_semanticas WHERE tipo='was_fixed_by' AND desde_entidad = ? AND hacia_entidad = ? LIMIT 1`
      ).get(`nodo:error:${e.titulo}`, `ciclo:${cycleId}`));
      if (ya) continue;
      if (addCausalEdge) {
        // firma REAL de causal-edges.cjs: desde_entidad / hacia_entidad
        safe(() => addCausalEdge(db, {
          desde_entidad: `nodo:error:${e.titulo}`,
          hacia_entidad: `ciclo:${cycleId}`,
          tipo: 'was_fixed_by',
          descripcion: `anclas intersectadas por el ciclo "${String(taskName || '').slice(0, 80)}"`,
          confidence: 'MEDIA',
        }));
      } else {
        safe(() => db.prepare(`
          INSERT INTO relaciones_semanticas (desde_entidad, hacia_entidad, tipo, peso, descripcion)
          VALUES (?, ?, 'was_fixed_by', 1.0, ?)
        `).run(`nodo:error:${e.titulo}`, `ciclo:${cycleId}`, `anclas intersectadas (${taskName || ''})`.slice(0, 120)));
      }
      safe(() => db.prepare(`UPDATE nodos SET aplicado = COALESCE(aplicado, 0) + 1 WHERE id = ?`).run(e.id));
      recordGateEvent(db, { gate: 'memoria', verdict: 'FIX_LINKED', file: null, detalle: { error: e.titulo.slice(0, 80), ciclo: cycleId }, cycle_hint: taskName });
      out.enlazados++;
    }
  } catch {}
  return out;
}

// ─── T4: CURACIÓN ANTI-PUDRICIÓN DE ANCLAS ────────────────────────────────────
// Marca (jamás borra): ancla cuyo símbolo ya no existe en el índice →
// stale_since la primera vez; >30 días stale → se mueve a anclas_obsoletas.
// El efecto natural sigue siendo el correcto: sin ancla → nivel archivo (hoy).

const STALE_DAYS = 30;

function revalidateAnchors(db, projectRoot) {
  const out = { revisadas: 0, marcadas: 0, retiradas: 0 };
  try {
    ensureTelemetrySchema(db);
    const resolver = (a) => {
      if (!a || !a.symbol_name || !a.kind) return true; // malformada: se deja quieta
      const candidates = [String(a.file || ''), String(a.file || '').replace(/\//g, '\\'), String(a.file || '').replace(/\\/g, '/')];
      for (const k of [...new Set(candidates)]) {
        const row = safe(() => db.prepare(
          `SELECT 1 FROM ast_symbols WHERE file = ? AND kind = ? AND symbol_name = ? LIMIT 1`
        ).get(k, a.kind, a.symbol_name));
        if (row) return true;
      }
      return false;
    };
    const ahora = Date.now();
    const procesa = (lista) => {
      const vivas = [], obsoletas = [];
      for (const a of lista) {
        out.revisadas++;
        if (resolver(a)) { delete a.stale_since; vivas.push(a); continue; }
        if (!a.stale_since) { a.stale_since = new Date().toISOString().slice(0, 10); out.marcadas++; vivas.push(a); continue; }
        const dias = (ahora - new Date(a.stale_since).getTime()) / 86400000;
        if (dias > STALE_DAYS) { obsoletas.push(a); out.retiradas++; }
        else vivas.push(a);
      }
      return { vivas, obsoletas };
    };

    const behaviors = safe(() => db.prepare(
      `SELECT id, protected_symbols, anclas_obsoletas FROM protected_behaviors WHERE status = 'active' AND protected_symbols IS NOT NULL AND protected_symbols != '[]'`
    ).all()) || [];
    for (const b of behaviors) {
      const lista = safe(() => JSON.parse(b.protected_symbols), []) || [];
      if (!lista.length) continue;
      const { vivas, obsoletas } = procesa(lista);
      if (out.marcadas || obsoletas.length) {
        const prevObs = safe(() => JSON.parse(b.anclas_obsoletas), []) || [];
        safe(() => db.prepare(`UPDATE protected_behaviors SET protected_symbols = ?, anclas_obsoletas = ? WHERE id = ?`)
          .run(JSON.stringify(vivas), JSON.stringify([...prevObs, ...obsoletas].slice(-50)), b.id));
        if (obsoletas.length) recordGateEvent(db, { gate: 'curator', verdict: 'WARN', behavior_id: b.id, detalle: { anclas_retiradas: obsoletas.length } });
      }
    }

    const nodosAnclados = safe(() => db.prepare(
      `SELECT id, anclas FROM nodos WHERE anclas IS NOT NULL AND anclas != '[]'`
    ).all()) || [];
    for (const n of nodosAnclados) {
      const lista = safe(() => JSON.parse(n.anclas), []) || [];
      if (!lista.length) continue;
      const { vivas, obsoletas } = procesa(lista);
      if (obsoletas.length || vivas.some(v => v.stale_since)) {
        safe(() => db.prepare(`UPDATE nodos SET anclas = ? WHERE id = ?`).run(JSON.stringify(vivas), n.id));
      }
    }
  } catch {}
  return out;
}

// ─── T7: PROMOCIÓN POR MÉRITO (solo promueve, jamás degrada — v1) ─────────────
// MEDIA con pass_count >= 3 Y evidencia real:
//   ≥1 protección activada (HIT/STOP del regression guard sobre este behavior)
//   o ≥2 verificaciones en navegador (browser PASS) → HIGH anticipado.

function applyMeritPromotion(db) {
  const out = { promovidos: [] };
  try {
    ensureTelemetrySchema(db);
    const candidatos = safe(() => db.prepare(
      `SELECT id, module, pass_count FROM protected_behaviors WHERE status = 'active' AND confidence = 'MEDIA' AND pass_count >= 3`
    ).all()) || [];
    for (const b of candidatos) {
      const hits = safe(() => db.prepare(
        `SELECT COUNT(*) n FROM gate_events WHERE behavior_id = ? AND gate = 'regression' AND verdict IN ('HIT','STOP')`
      ).get(b.id)?.n, 0) || 0;
      const passes = safe(() => db.prepare(
        `SELECT COUNT(*) n FROM gate_events WHERE behavior_id = ? AND gate = 'browser' AND verdict = 'PASS'`
      ).get(b.id)?.n, 0) || 0;
      if (hits >= 1 || passes >= 2) {
        safe(() => db.prepare(`UPDATE protected_behaviors SET confidence = 'HIGH' WHERE id = ?`).run(b.id));
        recordGateEvent(db, { gate: 'curator', verdict: 'PROMOTED', behavior_id: b.id, detalle: { hits, passes, pass_count: b.pass_count } });
        out.promovidos.push({ id: b.id, module: b.module, hits, passes });
      }
    }
  } catch {}
  return out;
}

// ─── C4 (Plan 6): ESTADÍSTICAS DEL BUCLE DE RECUPERACIÓN ─────────────────────
// La maquinaria del protocolo RECOVERY (CLAUDE.md): cuando un gate frena y el
// pipeline intenta arreglar-y-reverificar, el desenlace se anota con verdicts
// RECOVERED (lo logró) / RECOVERY_FAILED (escaló al humano). recordGateEvent
// ya los acepta (es genérico) — esto solo los cuenta para el reporte:
// "N recuperaciones autónomas este mes, M escaladas".

function recoveryStats(db, opts = {}) {
  const out = { recovered: 0, failed: 0, tasa: null };
  try {
    ensureTelemetrySchema(db);
    const where = opts.desde ? `AND ts >= '${String(opts.desde).slice(0, 10)}'` : '';
    out.recovered = safe(() => db.prepare(`SELECT COUNT(*) n FROM gate_events WHERE verdict = 'RECOVERED' ${where}`).get()?.n, 0) || 0;
    out.failed = safe(() => db.prepare(`SELECT COUNT(*) n FROM gate_events WHERE verdict = 'RECOVERY_FAILED' ${where}`).get()?.n, 0) || 0;
    const total = out.recovered + out.failed;
    out.tasa = total ? Math.round((out.recovered / total) * 100) : null;
  } catch {}
  return out;
}

// ─── ORQUESTADOR PARA POST-CYCLE (un solo punto de inserción) ─────────────────

function memoriaPostCycle(db, { area, cycleId, taskName, projectRoot }) {
  const resumen = { anclados: 0, enlazados: 0, promovidos: 0, anclasMarcadas: 0 };
  try {
    ensureTelemetrySchema(db);
    // archivos del último commit (mismo criterio que el episodio del post-cycle)
    let changedFiles = [];
    safe(() => {
      const { execSync } = require('child_process');
      changedFiles = execSync('git diff-tree --no-commit-id --name-only -r HEAD', { cwd: projectRoot, stdio: 'pipe', timeout: 5000 })
        .toString().split('\n').map(f => f.trim()).filter(Boolean);
    });
    const anchors = changedFiles.length ? anchorsForChangeset(db, changedFiles, projectRoot) : [];
    resumen.anclados = anchorRecentErrors(db, { area, anchors }).anclados;
    resumen.enlazados = linkErrorFixes(db, { anchors, cycleId, taskName, projectRoot }).enlazados;
    resumen.promovidos = applyMeritPromotion(db).promovidos.length;
    resumen.anclasMarcadas = revalidateAnchors(db, projectRoot).marcadas;
  } catch {}
  return resumen;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const cmd = process.argv[2] || 'stats';
  const dbPath = path.join(process.cwd(), '.agentic', 'memoria.db');
  if (!fs.existsSync(dbPath)) { console.log('Sin memoria.db — corre akdd init/sync primero.'); process.exit(0); }
  let db;
  try { db = new (require('better-sqlite3'))(dbPath); }
  catch { db = new (require('node:sqlite').DatabaseSync)(dbPath); }

  if (cmd === 'stats') {
    const desdeArg = process.argv.find(a => a.startsWith('--desde='));
    const s = gateStats(db, { desde: desdeArg ? desdeArg.split('=')[1] : null });
    console.log('\n🛡️  Telemetría de gates' + (s.desde ? ` (desde ${s.desde})` : ''));
    console.log(`  Eventos totales: ${s.total} | Protecciones activadas (HIT/STOP/FAIL): ${s.protecciones}`);
    Object.entries(s.porGate).forEach(([g, vs]) => {
      console.log(`  ${g.padEnd(12)} ${Object.entries(vs).map(([v, n]) => `${v}:${n}`).join('  ')}`);
    });
  } else if (cmd === 'revalidate') {
    const r = revalidateAnchors(db, process.cwd());
    console.log(`Anclas revisadas: ${r.revisadas} | marcadas stale: ${r.marcadas} | retiradas (> ${STALE_DAYS} días): ${r.retiradas}`);
  } else {
    console.log('Uso: gate-telemetry.cjs [stats [--desde=YYYY-MM-DD] | revalidate]');
  }
  try { db.close(); } catch {}
}

module.exports = {
  ensureTelemetrySchema,
  recordGateEvent,
  gateStats,
  recoveryStats,
  anchorRecentErrors,
  linkErrorFixes,
  revalidateAnchors,
  applyMeritPromotion,
  memoriaPostCycle,
  anchorsForChangeset,
};
