'use strict';

/**
 * Spec Value Scan — Agentic KDD v3.15 (Plan 7, T2)
 *
 * La mitad MECANIZABLE del Spec Gate: los valores de negocio vigilados
 * (trial_days, rate_limit, …) son números CONOCIDOS guardados en la memoria.
 * Detectar que un diff los toca con un número distinto es aritmética y grep —
 * la misma disciplina "números, no prosa" del Plan 1 — y por lo tanto NO
 * debe depender de que el modelo se acuerde de revisar.
 *
 * Qué hace: escanea las líneas AGREGADAS del diff (staged por defecto) en
 * busca de claves vigiladas con un valor numérico; compara contra el valor
 * recordado en la memoria (nodos patron/decision con confianza HIGH/MEDIA
 * cuyo texto contiene la clave y un número). Discrepancia → WARN + evento
 * mecánico en la libreta (gate:'spec', source:'mechanical').
 *
 * Qué NO hace (la franja honesta que queda en el modelo): juicios semánticos
 * sobre prosa ("¿esto contradice el ESPÍRITU de la decisión?"). Eso sigue
 * siendo protocolo del Spec Gate en CLAUDE.md.
 *
 * SIEMPRE exit 0 (visible, no bloqueante — misma filosofía que ui-native-gate;
 * la escalada a bloqueo se gana con datos, no se regala).
 *
 * Uso:
 *   node .agentic/grafo/spec-value-scan.cjs --staged
 *   node .agentic/grafo/spec-value-scan.cjs --files=a.ts,b.ts
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const safe = (fn, fb = null) => { try { return fn(); } catch { return fb; } };

// La misma lista que vigila el Spec Gate de CLAUDE.md — una sola fuente
// conceptual; agregar una clave aquí Y allá.
const WATCHED_KEYS = [
  'trial_days', 'trial_period', 'yearly_discount', 'password_min',
  'invoice_prefix', 'max_users', 'max_api_calls', 'rate_limit', 'timeout',
];

function openDB(projectRoot) {
  const dbPath = path.join(projectRoot, '.agentic', 'memoria.db');
  if (!fs.existsSync(dbPath)) return null;
  try { return new (require('better-sqlite3'))(dbPath, { readonly: true }); } catch {}
  try { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(dbPath, { readOnly: true }); } catch {}
  return null;
}

function openDBWrite(projectRoot) {
  const dbPath = path.join(projectRoot, '.agentic', 'memoria.db');
  if (!fs.existsSync(dbPath)) return null;
  try { return new (require('better-sqlite3'))(dbPath); } catch {}
  try { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(dbPath); } catch {}
  return null;
}

/**
 * Claves de negocio DERIVADAS de la memoria del proyecto — no solo la lista
 * hardcodeada en inglés. El Coliseo (2026-07-20) mostró el hueco: un valor
 * como `fuel_surcharge_pct` vivía como decisión ALTA en la memoria de FLOTA360
 * pero spec-value-scan era ciego a él porque no estaba en WATCHED_KEYS. Ahora
 * se extraen los identificadores snake_case que aparecen JUNTO A un número en
 * cualquier nodo decision/patron ALTA/MEDIA — es decir, lo que el propio
 * proyecto ya marcó como regla de negocio con un valor. Así la protección
 * mecánica cubre lo que de verdad está en la memoria, no un vocabulario fijo.
 */
function memoryDerivedKeys(db) {
  if (!db) return [];
  const rows = safe(() => db.prepare(
    `SELECT titulo, contenido FROM nodos
     WHERE tipo IN ('patron','decision') AND confianza IN ('ALTA','MEDIA')`
  ).all()) || [];
  const keys = new Set();
  for (const r of rows) {
    const texto = `${r.titulo}\n${r.contenido || ''}`;
    for (const linea of texto.split('\n')) {
      if (!/\d/.test(linea)) continue; // solo líneas con un número
      // identificadores snake_case de 2+ segmentos (fuel_surcharge_pct,
      // sla_penalty_threshold_hours…) — evita palabras sueltas comunes.
      const ids = linea.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) || [];
      ids.forEach(id => keys.add(id));
    }
  }
  return [...keys];
}

/** Valor recordado de una clave: primer número en un nodo HIGH/MEDIA que la mencione. */
function rememberedValue(db, key) {
  const rows = safe(() => db.prepare(
    `SELECT titulo, contenido, confianza FROM nodos
     WHERE tipo IN ('patron','decision') AND confianza IN ('ALTA','MEDIA')
       AND (titulo LIKE ? OR contenido LIKE ?)
     ORDER BY CASE confianza WHEN 'ALTA' THEN 0 ELSE 1 END LIMIT 3`
  ).all(`%${key}%`, `%${key}%`)) || [];
  for (const r of rows) {
    const texto = `${r.titulo}\n${r.contenido || ''}`;
    // el número más cercano a la mención de la clave (misma línea)
    const linea = texto.split('\n').find(l => l.toLowerCase().includes(key.toLowerCase()) && /\d/.test(l));
    const m = linea && linea.match(/(\d+(?:\.\d+)?)/);
    if (m) return { valor: m[1], nodo: r.titulo.slice(0, 60), confianza: r.confianza };
  }
  return null;
}

function scan(projectRoot, { staged = true, files = null } = {}) {
  const findings = [];
  let diff = '';
  if (files && files.length) {
    // modo archivos: escanear contenido completo (para verificación/tests)
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

  const agregadas = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
  const db = openDB(projectRoot);

  // Lista fija (SaaS genérico) ∪ lo que el propio proyecto marcó como regla de
  // negocio con un valor en su memoria. Set para no escanear dos veces la misma.
  const claves = [...new Set([...WATCHED_KEYS, ...memoryDerivedKeys(db)])];

  for (const key of claves) {
    const re = new RegExp(`${key}\\s*[:=]\\s*['"]?(\\d+(?:\\.\\d+)?)`, 'i');
    for (const linea of agregadas) {
      const m = linea.match(re);
      if (!m) continue;
      const valorNuevo = m[1];
      const recordado = db ? rememberedValue(db, key) : null;
      if (recordado && recordado.valor !== valorNuevo) {
        findings.push({
          key, valorNuevo, valorMemoria: recordado.valor,
          confianza: recordado.confianza, nodo: recordado.nodo,
          linea: linea.slice(0, 120),
          nivel: recordado.confianza === 'ALTA' ? 'HIGH' : 'MEDIUM',
        });
      } else if (!recordado) {
        findings.push({ key, valorNuevo, valorMemoria: null, nivel: 'INFO', linea: linea.slice(0, 120) });
      }
      break; // una detección por clave basta
    }
  }
  safe(() => db && db.close());

  // A la libreta — mecánico registrando mecánico (fail-soft)
  if (findings.length) {
    try {
      const gt = require(path.join(__dirname, 'gate-telemetry.cjs'));
      const wdb = openDBWrite(projectRoot);
      if (wdb) {
        findings.forEach(f => gt.recordGateEvent(wdb, {
          gate: 'spec', verdict: f.nivel === 'INFO' ? 'INFO' : 'WARN', source: 'mechanical',
          detalle: { key: f.key, nuevo: f.valorNuevo, memoria: f.valorMemoria },
        }));
        safe(() => wdb.close());
      }
    } catch {}
  }
  return { findings, scanned: true };
}

function formatear(res) {
  if (!res.scanned) return 'SPEC VALUE SCAN — sin diff que escanear.';
  if (!res.findings.length) return '✅ SPEC VALUE SCAN — ningún valor de negocio vigilado tocado.';
  const L = [`⚠️  SPEC VALUE SCAN — ${res.findings.length} valor(es) vigilado(s) tocado(s):`];
  res.findings.forEach(f => {
    if (f.valorMemoria) L.push(`  🟡 [${f.nivel}] ${f.key}: el diff pone ${f.valorNuevo} pero la memoria (${f.confianza}) dice ${f.valorMemoria} — "${f.nodo}". ¿Cambio de regla intencional? Confírmalo.`);
    else L.push(`  ℹ️  ${f.key} = ${f.valorNuevo} aparece en el diff (sin valor previo en memoria — se vigilará desde ahora).`);
  });
  return L.join('\n');
}

if (require.main === module) {
  const filesArg = process.argv.find(a => a.startsWith('--files='));
  const res = scan(process.cwd(), {
    staged: !filesArg,
    files: filesArg ? filesArg.split('=')[1].split(',').filter(Boolean) : null,
  });
  console.log(formatear(res));
  process.exit(0); // SIEMPRE 0 — visible, no bloqueante (v1)
}

module.exports = { scan, formatear, WATCHED_KEYS };
