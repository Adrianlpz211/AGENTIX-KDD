'use strict';

/**
 * UI Layout Memory — Agentic KDD (L4, item 2/3, 2026-07-18)
 *
 * El caso real que motivó esto: en esta misma sesión el panel de "visita
 * guiada" se reposicionó (top-left → right, más ancho, texto más grande)
 * porque el dev lo pidió explícitamente. Ese tipo de decisión de layout NO
 * quedaba en ningún lado — a diferencia de un valor de negocio (spec-gate)
 * o un patrón de código (patrones.md), una posición/tamaño de UI no tenía
 * memoria propia. Si un cambio futuro (otra sesión, otro modelo, un merge)
 * vuelve a mover el panel a su posición vieja, nada lo detecta — es
 * exactamente el síntoma "el select volvió a su lugar viejo" señalado en el
 * análisis externo de Agentix.
 *
 * Qué hace: igual disciplina que spec-value-scan.cjs (números/valores
 * conocidos, no prosa) pero para propiedades de layout de elementos
 * vigilados — id HTML + propiedad CSS inline (`style="...prop:valor..."`).
 * Guarda un HISTORIAL de decisiones (no solo la última), así puede distinguir
 * "cambio nuevo distinto a la memoria" de "reversión exacta a un valor que YA
 * habíamos abandonado" (señal más fuerte — casi siempre es sin querer).
 *
 * Qué NO hace: no infiere selectores nuevos solo, no parsea CSS externo/
 * hojas de estilo completas — solo vigila los ids que alguien registró
 * explícitamente con `record`. Sin registro, sin vigilancia — evita el
 * riesgo de "empezar a disparar en cosas que no ameritan tanta
 * funcionalidad" (la misma preocupación que ya se discutió para el piso de
 * proporcionalidad de QA Legion).
 *
 * Uso:
 *   node .agentic/grafo/ui-layout-memory.cjs record --id=tour-panel --prop=right --value=12px --reason="pedido del dev: más visible"
 *   node .agentic/grafo/ui-layout-memory.cjs check --files=dashboard.cjs
 *   node .agentic/grafo/ui-layout-memory.cjs list [--id=tour-panel]
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const safe = (fn, fb = null) => { try { return fn(); } catch { return fb; } };

function openDB(projectRoot, { write = false } = {}) {
  const dbPath = path.join(projectRoot, '.agentic', 'memoria.db');
  if (!fs.existsSync(dbPath)) return null;
  try {
    const BS3 = require('better-sqlite3');
    return write ? new BS3(dbPath) : new BS3(dbPath, { readonly: true });
  } catch {}
  try {
    const { DatabaseSync } = require('node:sqlite');
    return new DatabaseSync(dbPath, write ? {} : { readOnly: true });
  } catch {}
  return null;
}

function ensureSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ui_layout_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    element_id TEXT NOT NULL,
    property   TEXT NOT NULL,
    value      TEXT NOT NULL,
    reason     TEXT,
    superseded INTEGER DEFAULT 0,
    decided_at TEXT DEFAULT (datetime('now'))
  )`);
}

/** Registra una decisión nueva; marca cualquier decisión previa (mismo id+prop) como superada. */
function recordDecision(projectRoot, { elementId, property, value, reason }) {
  const db = openDB(projectRoot, { write: true });
  if (!db) return { ok: false, reason: 'sin memoria.db' };
  ensureSchema(db);
  try {
    db.prepare(`UPDATE ui_layout_decisions SET superseded = 1
                WHERE element_id = ? AND property = ? AND superseded = 0`)
      .run(elementId, property);
    db.prepare(`INSERT INTO ui_layout_decisions (element_id, property, value, reason)
                VALUES (?, ?, ?, ?)`)
      .run(elementId, property, String(value), reason || null);
    return { ok: true };
  } finally { safe(() => db.close()); }
}

function currentDecision(db, elementId, property) {
  return safe(() => db.prepare(
    `SELECT value, reason, decided_at FROM ui_layout_decisions
     WHERE element_id = ? AND property = ? AND superseded = 0
     ORDER BY id DESC LIMIT 1`
  ).get(elementId, property));
}

function history(db, elementId, property) {
  return safe(() => db.prepare(
    `SELECT value, reason, decided_at FROM ui_layout_decisions
     WHERE element_id = ? AND property = ? AND superseded = 1
     ORDER BY id DESC`
  ).all(elementId, property)) || [];
}

/** Extrae el `style="..."` del tag de apertura que contiene id="elementId" en una línea de texto. */
function extractStyleForId(linea, elementId) {
  const idIdx = linea.indexOf(`id="${elementId}"`) !== -1
    ? linea.indexOf(`id="${elementId}"`)
    : linea.indexOf(`id='${elementId}'`);
  if (idIdx === -1) return null;
  const m = linea.match(new RegExp(`style=["']([^"']*)["']`));
  return m ? m[1] : null;
}

function parseStyleValue(styleStr, property) {
  // property: "right" no debe matchear "border-right" — anclar a inicio de declaración
  const re = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'i');
  const m = styleStr.match(re);
  return m ? m[1].trim() : null;
}

function scanDiff(projectRoot, { staged = false, files = null } = {}) {
  const findings = [];
  let diff = '';
  if (files && files.length) {
    for (const f of files) {
      const abs = path.isAbsolute(f) ? f : path.join(projectRoot, f);
      const contenido = safe(() => fs.readFileSync(abs, 'utf8'), '');
      diff += contenido.split('\n').map(l => '+' + l).join('\n') + '\n';
    }
  } else {
    diff = safe(() => execSync(`git diff ${staged ? '--cached' : 'HEAD'} -U0`, {
      cwd: projectRoot, stdio: 'pipe', timeout: 15000,
    }).toString(), '');
  }
  if (!diff.trim()) return { findings, scanned: false };

  const db = openDB(projectRoot);
  if (!db) return { findings, scanned: false, reason: 'sin memoria.db' };
  ensureSchema(db);

  const agregadas = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
  const watched = safe(() => db.prepare(
    `SELECT DISTINCT element_id, property FROM ui_layout_decisions WHERE superseded = 0`
  ).all()) || [];

  for (const { element_id, property } of watched) {
    for (const linea of agregadas) {
      const style = extractStyleForId(linea, element_id);
      if (!style) continue;
      const nuevoValor = parseStyleValue(style, property);
      const actual = currentDecision(db, element_id, property);

      if (nuevoValor == null) {
        // El tag vigilado fue tocado pero la propiedad ya no aparece en su
        // style — puede ser que se movió a una clase CSS (falso positivo
        // posible) o que se perdió sin querer (el bug real que motivó esto:
        // "right" reemplazado por "left"). Se avisa igual, más débil.
        if (actual) {
          findings.push({
            elementId: element_id, property, nuevoValor: '(ausente)',
            decidido: actual.value, razon: actual.reason,
            esReversion: false, razonVieja: null, ausente: true,
            linea: linea.slice(0, 140),
          });
        }
        break;
      }

      if (actual && actual.value !== nuevoValor) {
        const pasados = history(db, element_id, property);
        const eraViejo = pasados.find(h => h.value === nuevoValor);
        findings.push({
          elementId: element_id, property, nuevoValor,
          decidido: actual.value, razon: actual.reason,
          esReversion: !!eraViejo,
          razonVieja: eraViejo ? eraViejo.reason : null,
          linea: linea.slice(0, 140),
        });
      }
      break; // una detección por (elemento, propiedad) por corrida basta
    }
  }
  safe(() => db.close());

  if (findings.length) {
    try {
      const gt = require(path.join(__dirname, 'gate-telemetry.cjs'));
      const wdb = openDB(projectRoot, { write: true });
      if (wdb) {
        findings.forEach(f => gt.recordGateEvent(wdb, {
          gate: 'ui-layout', verdict: f.esReversion ? 'WARN_REVERSION' : 'WARN', source: 'mechanical',
          detalle: { elementId: f.elementId, property: f.property, nuevo: f.nuevoValor, decidido: f.decidido },
        }));
        safe(() => wdb.close());
      }
    } catch {}
  }

  return { findings, scanned: true };
}

function formatear(res) {
  if (!res.scanned) return res.reason ? `UI LAYOUT MEMORY — ${res.reason}.` : 'UI LAYOUT MEMORY — sin diff que escanear.';
  if (!res.findings.length) return '✅ UI LAYOUT MEMORY — ningún elemento vigilado cambió de valor.';
  const L = [`⚠️  UI LAYOUT MEMORY — ${res.findings.length} cambio(s) sobre decisiones de layout registradas:`];
  res.findings.forEach(f => {
    if (f.esReversion) {
      L.push(`  🔴 #${f.elementId} ${f.property}: vuelve a "${f.nuevoValor}" — un valor que YA se había abandonado (motivo: "${f.razonVieja}"). Probable regresión no intencional.`);
    } else if (f.ausente) {
      L.push(`  🟠 #${f.elementId}: la propiedad "${f.property}" ya no aparece en su style (decisión vigente: "${f.decidido}", motivo: "${f.razon}") — ¿se movió a una clase CSS o se perdió sin querer?`);
    } else {
      L.push(`  🟡 #${f.elementId} ${f.property}: el diff pone "${f.nuevoValor}" pero la decisión vigente es "${f.decidido}" (motivo: "${f.razon}"). ¿Cambio intencional? Confírmalo.`);
    }
  });
  return L.join('\n');
}

// ── CLI ───────────────────────────────────────────────────────────────────

if (require.main === module) {
  const [, , cmd, ...rest] = process.argv;
  const opts = {};
  for (const a of rest.filter(a => a.startsWith('--'))) {
    const [k, v] = a.slice(2).split('=');
    opts[k] = v !== undefined ? v : true;
  }
  const root = process.cwd();

  if (cmd === 'record') {
    if (!opts.id || !opts.prop || opts.value === undefined) {
      console.log('Uso: record --id=<elementId> --prop=<propiedad> --value=<valor> --reason="..."');
      process.exit(1);
    }
    const r = recordDecision(root, { elementId: opts.id, property: opts.prop, value: opts.value, reason: opts.reason });
    console.log(r.ok ? `✅ Decisión registrada: #${opts.id} ${opts.prop} = ${opts.value}` : `⚠️  ${r.reason}`);
    process.exit(r.ok ? 0 : 1);
  }

  if (cmd === 'check') {
    const filesArg = opts.files ? String(opts.files).split(',').filter(Boolean) : null;
    const res = scanDiff(root, { staged: !!opts.staged, files: filesArg });
    console.log(formatear(res));
    process.exit(0); // siempre 0 — visible, no bloqueante (mismo espíritu que spec-value-scan)
  }

  if (cmd === 'list') {
    const db = openDB(root);
    if (db) {
      ensureSchema(db);
      const rows = opts.id
        ? db.prepare(`SELECT * FROM ui_layout_decisions WHERE element_id = ? ORDER BY id`).all(opts.id)
        : db.prepare(`SELECT * FROM ui_layout_decisions WHERE superseded = 0 ORDER BY element_id, property`).all();
      rows.forEach(r => console.log(`#${r.element_id} ${r.property} = ${r.value}${r.superseded ? ' (superada)' : ''} — "${r.reason || ''}" (${r.decided_at})`));
      safe(() => db.close());
    }
    process.exit(0);
  }

  console.log('Uso: node ui-layout-memory.cjs <record|check|list> [opciones]');
  process.exit(0);
}

module.exports = { recordDecision, scanDiff, formatear, currentDecision, history, ensureSchema };
