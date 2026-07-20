/**
 * Agentic KDD — Graph Freshness v1.0 (Pieza 2 del plan Understand-Anything)
 *
 * El grafo/memoria hoy no sabe "de qué momento del código soy" — la confianza
 * en él es asumida, no medida. Esta pieza lo ancla a un commit de git:
 *
 *   stampGraph()     → guarda el commit HEAD actual en project_settings
 *                      (key: graph_commit_hash) — se llama al final de post-cycle.
 *   checkFreshness() → compara ese sello contra el estado real del repo:
 *       fresh   → mismo commit, working tree limpio
 *       dirty   → mismo commit, pero hay cambios sin commitear
 *       stale   → el HEAD avanzó desde el sello (con commitsBehind y archivos)
 *       unknown → sin sello previo / sin git / timeout — NUNCA bloquea ni lanza
 *
 * Detalle importado de Understand-Anything: el diff usa pathspec `-- .` desde
 * el root del proyecto — en un monorepo, commits que solo tocan proyectos
 * hermanos NO ensucian este grafo. Un hash distinto con diff vacío = fresh.
 *
 * Todo con timeouts y try/catch: si git no está, si el repo no existe, si el
 * comando cuelga — devuelve 'unknown' con razón, jamás rompe al caller.
 *
 * Uso CLI:
 *   node graph-freshness.cjs stamp    — sellar el grafo con el HEAD actual
 *   node graph-freshness.cjs check    — reporte de frescura
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const { execSync } = require('child_process');

const GIT_TIMEOUT = 5000;

// ─── DB (mismo patrón que change-classifier) ─────────────────────────────────

function resolveDbPath(projectRoot) {
  const candidates = [
    path.join(projectRoot, '.agentic', 'memoria.db'),
    path.join(projectRoot, '.agentic', 'grafo', 'memoria.db'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return candidates[0];
}

function openDB(projectRoot) {
  const dbPath = resolveDbPath(projectRoot);
  let db;
  try { db = new (require('better-sqlite3'))(dbPath); }
  catch { try { const { DatabaseSync } = require('node:sqlite'); db = new DatabaseSync(dbPath); } catch { return null; } }
  // project_settings existe en las generaciones recientes; crearla si no (aditivo)
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS project_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    )`);
  } catch {}
  return db;
}

const safe = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };

// ─── GIT HELPERS (todos con timeout, todos fallan a null) ────────────────────

function git(cmd, projectRoot) {
  try {
    return execSync(`git ${cmd}`, {
      cwd: projectRoot, stdio: 'pipe', timeout: GIT_TIMEOUT,
    }).toString().trim();
  } catch { return null; }
}

// ─── STAMP ────────────────────────────────────────────────────────────────────

function stampGraph(projectRoot, db) {
  projectRoot = projectRoot || process.cwd();
  const head = git('rev-parse HEAD', projectRoot);
  if (!head) return { ok: false, reason: 'git HEAD unavailable' };

  const ownDb = !db;
  if (ownDb) db = openDB(projectRoot);
  if (!db) return { ok: false, reason: 'DB unavailable' };

  const ok = safe(() => {
    db.prepare(`
      INSERT INTO project_settings (key, value, updated_at)
      VALUES ('graph_commit_hash', ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(head);
    return true;
  }, false);

  if (ownDb) safe(() => db.close());
  return ok ? { ok: true, commit: head } : { ok: false, reason: 'write failed' };
}

// ─── CHECK ────────────────────────────────────────────────────────────────────

function checkFreshness(projectRoot) {
  projectRoot = projectRoot || process.cwd();

  const db = openDB(projectRoot);
  if (!db) return { status: 'unknown', reason: 'DB unavailable' };

  const stamped = safe(() => db.prepare(
    `SELECT value, updated_at FROM project_settings WHERE key = 'graph_commit_hash'`
  ).get());
  safe(() => db.close());

  if (!stamped || !stamped.value) {
    return { status: 'unknown', reason: 'grafo sin sello de commit todavía (corre post-cycle o `graph-freshness.cjs stamp`)' };
  }

  const head = git('rev-parse HEAD', projectRoot);
  if (!head) return { status: 'unknown', reason: 'git no disponible en este proyecto' };

  // Verificar que el commit sellado siga siendo resoluble (rebase/gc pueden matarlo).
  // Las comillas alrededor del argumento son OBLIGATORIAS: en Windows execSync corre
  // vía cmd.exe, donde ^ es carácter de escape — sin comillas, "abc^{commit}" llega
  // a git como "abc{commit}" y la verificación falla para TODO commit (confirmado
  // en pruebas reales: el sello recién escrito daba "ya no existe").
  const graphCommit = git(`rev-parse --verify --end-of-options "${stamped.value}^{commit}"`, projectRoot);
  if (!graphCommit) {
    return { status: 'unknown', reason: `el commit sellado (${String(stamped.value).slice(0, 8)}) ya no existe en el repo (¿rebase?)` };
  }

  // Working tree sucio (solo dentro del proyecto — pathspec `-- .`).
  // Formato porcelain: "XY path" — 2 chars de estado + espacio + ruta. Se corta
  // por posición (slice(3)), NUNCA con regex de "letras iniciales": una versión
  // anterior usaba /^[A-Z?!\s]+/i y el flag i hacía que se comiera el inicio del
  // NOMBRE del archivo ("dashboard.cjs" → ".cjs") — confirmado en pruebas.
  // Parseo por token, NO por posición fija: el helper git() hace .trim() del output
  // completo, lo que come el espacio inicial de la PRIMERA línea (" M file" →
  // "M file") y desalinearía un slice(3) solo para ella — confirmado en pruebas
  // (".env.example" salía como "env.example"). Tomar el primer token como estado
  // y el resto como ruta es inmune a ese desalineado.
  const dirtyFiles = (git('status --porcelain -- .', projectRoot) || '')
    .split('\n').filter(l => l.trim())
    .map(l => {
      let p = l.trim().replace(/^\S+\s+/, '');    // quita "XY " / "M " / "??" inicial
      const arrow = p.indexOf(' -> ');            // renames: "R  viejo -> nuevo"
      if (arrow !== -1) p = p.slice(arrow + 4);
      return p.replace(/^"|"$/g, '');             // rutas con espacios vienen quoted
    })
    .filter(Boolean);

  if (graphCommit === head) {
    if (dirtyFiles.length > 0) {
      return {
        status: 'dirty', commit: head, changedFiles: dirtyFiles, commitsBehind: 0,
        reason: `mismo commit pero ${dirtyFiles.length} archivo(s) con cambios sin commitear`,
        stampedAt: stamped.updated_at,
      };
    }
    return { status: 'fresh', commit: head, changedFiles: [], commitsBehind: 0, stampedAt: stamped.updated_at };
  }

  // HEAD distinto — ¿el diff DEL PROYECTO es realmente no-vacío? (regla monorepo)
  const changed = (git(`diff --name-only ${graphCommit} ${head} -- .`, projectRoot) || '')
    .split('\n').map(l => l.trim()).filter(Boolean);

  const behindRaw = git(`rev-list --count ${graphCommit}..${head}`, projectRoot);
  const commitsBehind = behindRaw !== null ? parseInt(behindRaw, 10) || 0 : null;

  if (changed.length === 0 && dirtyFiles.length === 0) {
    // Commits de hermanos del monorepo: hash distinto pero nada de ESTE proyecto cambió
    return {
      status: 'fresh', commit: head, changedFiles: [], commitsBehind: 0,
      reason: 'HEAD avanzó pero ningún archivo de este proyecto cambió (monorepo)',
      stampedAt: stamped.updated_at,
    };
  }

  return {
    status: 'stale',
    commit: head,
    graphCommit,
    commitsBehind,
    changedFiles: [...new Set([...changed, ...dirtyFiles])],
    reason: `el grafo se selló en ${graphCommit.slice(0, 8)} y HEAD está ${commitsBehind ?? '?'} commit(s) adelante (${changed.length} archivo(s) del proyecto cambiaron)`,
    stampedAt: stamped.updated_at,
  };
}

// ─── RESUMEN CORTO (para enricher/dashboard) ─────────────────────────────────

function freshnessLine(projectRoot) {
  const r = safe(() => checkFreshness(projectRoot));
  if (!r) return null;
  if (r.status === 'stale') {
    return `⏳ Grafo ${r.commitsBehind ?? '?'} commit(s) atrás del HEAD (${r.changedFiles.length} archivo(s) cambiados) — considera correr sync/post-cycle`;
  }
  if (r.status === 'dirty') {
    return `✏️ Grafo al día con el último commit, pero hay ${r.changedFiles.length} archivo(s) sin commitear que aún no conoce`;
  }
  return null; // fresh/unknown → sin ruido
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const [,, cmd] = process.argv;
  const projectRoot = process.cwd();

  switch (cmd) {
    case 'stamp': {
      const r = stampGraph(projectRoot);
      console.log(r.ok ? `✅ Grafo sellado en commit ${r.commit.slice(0, 8)}` : `❌ ${r.reason}`);
      break;
    }
    case 'check': {
      const r = checkFreshness(projectRoot);
      const icon = { fresh: '✅', dirty: '✏️', stale: '⏳', unknown: '❓' };
      console.log(`\n  ${icon[r.status]} Estado del grafo: ${r.status.toUpperCase()}`);
      if (r.reason) console.log(`  ${r.reason}`);
      if (r.stampedAt) console.log(`  Sellado: ${r.stampedAt}`);
      if (r.changedFiles && r.changedFiles.length) {
        console.log(`  Archivos: ${r.changedFiles.slice(0, 8).join(', ')}${r.changedFiles.length > 8 ? '…' : ''}`);
      }
      console.log('');
      break;
    }
    default:
      console.log('Uso: node graph-freshness.cjs [stamp | check]');
  }
}

module.exports = { stampGraph, checkFreshness, freshnessLine };
