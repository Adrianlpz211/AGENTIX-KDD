'use strict';
/**
 * Agentic KDD — ReasoningBank v1.0 (MARK 3)
 *
 * "La armadura que aprende de lo que funcionó."
 * Registra las ESTRATEGIAS de los ciclos exitosos y las hace recuperables para
 * tareas futuras similares. Cada vez que una estrategia vuelve a funcionar, sube
 * de confianza (EMERGING → TRUSTED → PROVEN); si falla, baja.
 *
 * Diseño (garantías):
 *   - ADITIVO: tabla propia `reasoning_bank`, no toca ninguna otra tabla.
 *   - MIGRACIÓN SEGURA: CREATE TABLE IF NOT EXISTS, nunca borra/reescribe datos.
 *   - JS PURO: sin dependencias nativas nuevas (usa la BD que ya existe).
 *   - FALLBACK: sin DB o sin tabla → no-op silencioso, jamás rompe el ciclo.
 *   - DEDUP: misma intención+área refuerza una entrada (no infla la BD).
 *
 * Uso CLI:
 *   node reasoning-bank.cjs recall "consulta" [area]
 *   node reasoning-bank.cjs status
 *   node reasoning-bank.cjs list [area]
 *
 * API (para post-cycle.cjs):
 *   record(db, { intent, area, strategy, signals })
 *   recall(db, query, { area, topK })
 *   reinforce(db, id, ok)
 */

const path = require('path');

// ── DB (better-sqlite3 → node:sqlite → null) ─────────────────────────────────
function openDB(projectRoot) {
  const root = projectRoot || process.cwd();
  const dbPath = path.join(root, '.agentic', 'memoria.db');
  try {
    const nm = path.join(root, 'node_modules');
    if (!module.paths.includes(nm)) module.paths.unshift(nm);
    return new (require('better-sqlite3'))(dbPath);
  } catch {}
  try { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(dbPath); } catch {}
  return null;
}

// ── Schema (idempotente) ──────────────────────────────────────────────────────
function ensureSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS reasoning_bank (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    key           TEXT UNIQUE,
    intent        TEXT NOT NULL,
    area          TEXT,
    strategy      TEXT NOT NULL,
    signals       TEXT DEFAULT '{}',
    success_count INTEGER DEFAULT 1,
    fail_count    INTEGER DEFAULT 0,
    confidence    TEXT DEFAULT 'EMERGING',
    created_at    TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now')),
    last_used_at  TEXT
  )`);
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_rb_area ON reasoning_bank(area)"); } catch {}
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function normKey(intent, area) {
  const i = String(intent || '').toLowerCase()
    .replace(/\b[0-9a-f]{7,40}\b/g, ' ')       // quita hashes de commit
    .replace(/[^a-z0-9áéíóúñü ]/gi, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 120);
  return `${String(area || 'general').toLowerCase().trim()}::${i}`;
}

function confidenceFor(success, fail) {
  const net = (success || 0) - (fail || 0);
  if (net >= 7) return 'PROVEN';
  if (net >= 3) return 'TRUSTED';
  return 'EMERGING';
}

function tokenize(s) {
  return [...new Set((String(s || '').toLowerCase().match(/[a-z0-9áéíóúñü]{2,}/gi) || []))];
}

// Tareas reales casi nunca repiten el intent textual exacto (cada fix describe
// algo distinto), así que el match por `key` casi nunca reincide y todo se queda
// EMERGING para siempre. Antes de crear una fila nueva, buscamos si ya existe una
// estrategia parecida en la misma área — mismas palabras clave de dominio, no solo
// conectores — y, si la hay, la reforzamos en vez de diluir el aprendizaje en filas
// nuevas. Se usa conteo de tokens compartidos (no ratio): descripciones cortas y
// variadas del mismo bug recurrente suelen compartir 2-3 palabras clave y difieren
// en el resto, así que un ratio sobre el total castiga demasiado la redacción libre.
const STOPWORDS = new Set([
  'fix', 'real', 'critico', 'crítico', 'bug', 'error', 'feature', 'chore', 'ux', 'ui',
  'de', 'la', 'el', 'en', 'no', 'se', 'y', 'a', 'un', 'una', 'del', 'con', 'para', 'por',
  'que', 'los', 'las', 'al', 'sin', 'ya', 'su', 'lo', 'es', 'o', 'u', 'e',
  'the', 'and', 'to', 'of', 'for', 'in', 'on', 'is', 'it', 'be', 'was', 'were', 'are',
]);
const MIN_SHARED_TOKENS = 2;

function significantTokens(s) {
  // >=2 (no >2): acrónimos de 2 letras como "ia"/"ux"/"db" sí son palabras clave
  // de dominio; el ruido de 2 letras ya lo filtra STOPWORDS explícitamente.
  return tokenize(s).filter(t => !STOPWORDS.has(t) && t.length >= 2);
}

function findSimilar(db, area, intent) {
  const areaNorm = String(area || 'general').toLowerCase().trim();
  const qTerms = significantTokens(intent);
  if (qTerms.length < MIN_SHARED_TOKENS) return null;

  let rows = [];
  try {
    rows = db.prepare('SELECT id, intent, success_count, fail_count FROM reasoning_bank WHERE lower(area) = ?').all(areaNorm);
  } catch { return null; }

  let best = null, bestShared = 0;
  for (const r of rows) {
    const rTerms = significantTokens(r.intent);
    const shared = qTerms.filter(t => rTerms.includes(t)).length;
    if (shared > bestShared) { bestShared = shared; best = r; }
  }
  return bestShared >= MIN_SHARED_TOKENS ? best : null;
}

// ── record: aprende de un ciclo exitoso ──────────────────────────────────────
function record(db, entry) {
  if (!db) return { ok: false, reason: 'no-db' };
  try { ensureSchema(db); } catch (e) { return { ok: false, reason: e.message }; }

  const intent   = String((entry && entry.intent) || '').trim();
  const area     = String((entry && entry.area) || 'general').trim();
  const strategy = String((entry && entry.strategy) || '').trim();
  if (!intent || !strategy) return { ok: false, reason: 'faltan intent/strategy' };

  const key     = normKey(intent, area);
  const signals = JSON.stringify((entry && entry.signals) || {});

  try {
    const existing = db.prepare('SELECT id, success_count, fail_count FROM reasoning_bank WHERE key = ?').get(key)
      || findSimilar(db, area, intent);
    if (existing) {
      const sc   = (existing.success_count || 0) + 1;
      const conf = confidenceFor(sc, existing.fail_count || 0);
      db.prepare(`UPDATE reasoning_bank
        SET success_count=?, confidence=?, strategy=?, signals=?, updated_at=datetime('now')
        WHERE id=?`).run(sc, conf, strategy, signals, existing.id);
      return { ok: true, action: 'reinforced', id: existing.id, confidence: conf, success_count: sc };
    }
    const info = db.prepare(`INSERT INTO reasoning_bank (key, intent, area, strategy, signals)
      VALUES (?, ?, ?, ?, ?)`).run(key, intent, area, strategy, signals);
    return { ok: true, action: 'created', id: info.lastInsertRowid, confidence: 'EMERGING' };
  } catch (e) { return { ok: false, reason: e.message }; }
}

// ── recall: recupera estrategias relevantes que funcionaron ───────────────────
function recall(db, query, opts) {
  opts = opts || {};
  if (!db) return [];
  try { ensureSchema(db); } catch { return []; }

  const area = opts.area ? String(opts.area).toLowerCase().trim() : null;
  const topK = opts.topK || 5;

  let rows = [];
  try {
    rows = area
      ? db.prepare('SELECT * FROM reasoning_bank WHERE lower(area)=? ORDER BY updated_at DESC LIMIT 300').all(area)
      : db.prepare('SELECT * FROM reasoning_bank ORDER BY updated_at DESC LIMIT 300').all();
  } catch { return []; }

  const qTerms = tokenize(query);
  const scored = rows.map(r => {
    const text = `${r.intent || ''} ${r.strategy || ''} ${r.area || ''}`.toLowerCase();
    let kw = 0;
    if (qTerms.length) { let h = 0; for (const t of qTerms) if (text.indexOf(t) !== -1) h++; kw = h / qTerms.length; }
    const confBoost = r.confidence === 'PROVEN' ? 0.25 : r.confidence === 'TRUSTED' ? 0.12 : 0.03;
    return { ...r, score: kw + confBoost };
  }).sort((a, b) => b.score - a.score).slice(0, topK);

  // marcar uso (best-effort)
  try {
    const ids = scored.map(s => s.id).filter(Boolean);
    if (ids.length) db.prepare(`UPDATE reasoning_bank SET last_used_at=datetime('now') WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
  } catch {}

  return scored;
}

// ── reinforce / penalize ──────────────────────────────────────────────────────
function reinforce(db, id, ok) {
  if (!db || !id) return { ok: false };
  try {
    ensureSchema(db);
    const row = db.prepare('SELECT success_count, fail_count FROM reasoning_bank WHERE id=?').get(id);
    if (!row) return { ok: false, reason: 'not-found' };
    let sc = row.success_count || 0, fc = row.fail_count || 0;
    if (ok === false) fc += 1; else sc += 1;
    const conf = confidenceFor(sc, fc);
    db.prepare(`UPDATE reasoning_bank SET success_count=?, fail_count=?, confidence=?, updated_at=datetime('now') WHERE id=?`)
      .run(sc, fc, conf, id);
    return { ok: true, confidence: conf, success_count: sc, fail_count: fc };
  } catch (e) { return { ok: false, reason: e.message }; }
}

// ── status ────────────────────────────────────────────────────────────────────
function status(db) {
  if (!db) return { total: 0 };
  try { ensureSchema(db); } catch { return { total: 0 }; }
  const g = (sql, ...a) => { try { return db.prepare(sql).get(...a); } catch { return null; } };
  return {
    total:    g("SELECT COUNT(*) n FROM reasoning_bank")?.n || 0,
    proven:   g("SELECT COUNT(*) n FROM reasoning_bank WHERE confidence='PROVEN'")?.n || 0,
    trusted:  g("SELECT COUNT(*) n FROM reasoning_bank WHERE confidence='TRUSTED'")?.n || 0,
    emerging: g("SELECT COUNT(*) n FROM reasoning_bank WHERE confidence='EMERGING'")?.n || 0,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const [, , cmd, arg1, arg2] = process.argv;
  const db = openDB(process.cwd());
  if (!db) { console.log('[REASONING] memoria.db no disponible.'); process.exit(0); }

  if (cmd === 'recall') {
    const res = recall(db, arg1 || '', { area: arg2, topK: 5 });
    if (!res.length) { console.log('[REASONING] Sin estrategias registradas todavía.'); }
    else {
      console.log(`\n🧠 Estrategias que funcionaron (top ${res.length}):\n`);
      res.forEach((r, i) => console.log(`  ${i + 1}. [${r.confidence}] (${r.area}) ${r.intent}\n     → ${r.strategy}`));
      console.log('');
    }
  } else if (cmd === 'list') {
    const res = recall(db, '', { area: arg1, topK: 50 });
    console.log(JSON.stringify(res.map(r => ({ id: r.id, conf: r.confidence, area: r.area, intent: r.intent })), null, 2));
  } else {
    const s = status(db);
    console.log(`\n🧠 ReasoningBank — ${s.total} estrategias (PROVEN ${s.proven} · TRUSTED ${s.trusted} · EMERGING ${s.emerging})\n`);
  }
  try { db.close && db.close(); } catch {}
}

module.exports = { record, recall, reinforce, status, ensureSchema, openDB };
