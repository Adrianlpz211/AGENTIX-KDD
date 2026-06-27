/**
 * Spec Gate — Step 2 of the enhanced aa: pipeline
 *
 * Brecha 1 cerrada: antes de implementar cualquier cambio,
 * verifica si el prompt pide modificar valores que existen
 * en memoria como reglas de negocio HIGH confidence.
 *
 * Ejemplo: "cambia trial_days de 14 a 7"
 * → Memoria tiene: "trial_days = 14 SPEC (HIGH)"
 * → Spec Gate detecta la contradicción → STOP con explicación
 */

'use strict';

const path = require('path');
const fs   = require('fs');

const safe = (fn, fb = null) => { try { return fn(); } catch { return fb; } };

function openDB(projectRoot) {
  const dbPath = path.join(projectRoot, '.agentic/memoria.db');
  if (!fs.existsSync(dbPath)) return null;
  try { return new (require('better-sqlite3'))(dbPath); } catch { return null; }
}

/**
 * Extrae valores numéricos y strings del prompt.
 * Detecta patrones como "cambia X de 14 a 7", "set X to 7", "X = 7"
 */
function extractValuesFromPrompt(prompt) {
  const changes = [];

  // "cambia X de N a M" / "change X from N to M"
  const fromTo = prompt.matchAll(/(?:cambia|change|update|modify)\s+(\w+)\s+(?:de|from)\s+([\d.]+)\s+(?:a|to)\s+([\d.]+)/gi);
  for (const m of fromTo) {
    changes.push({ field: m[1], from: m[2], to: m[3] });
  }

  // "X = N" / "X: N"
  const assignments = prompt.matchAll(/(\w+(?:_\w+)*)\s*[=:]\s*([\d.]+)/g);
  for (const m of assignments) {
    changes.push({ field: m[1], value: m[2] });
  }

  // Numbers in context of known business fields
  const businessFields = [
    // SaaS Billing (original)
    'trial_days', 'trial_period', 'trial',
    'discount', 'yearly_discount',
    'password', 'min_password', 'password_min',
    'invoice_prefix', 'invoice_number',
    'max_users', 'max_api_calls', 'max_storage',
    'rate_limit', 'timeout', 'retries',
    // Agency OS
    'hourly_rate', 'hourly_rate_default',
    'overtime_threshold', 'overtime_multiplier', 'overtime',
    'invoice_due', 'invoice_due_days', 'due_days',
    'budget_warning', 'campaign_budget_warning',
    'tax_rate', 'tax_rate_default',
    'password_min_length',
    'retainer_billing_day', 'billing_day',
  ];

  businessFields.forEach(field => {
    const regex = new RegExp(`${field}[^\\d]*(\\d+)`, 'gi');
    const matches = prompt.matchAll(regex);
    for (const m of matches) {
      changes.push({ field, value: m[1] });
    }
  });

  return changes;
}

/**
 * Verifica si el cambio pedido contradice una regla en memoria.
 */
function checkAgainstMemory(db, changes) {
  const violations = [];

  changes.forEach(change => {
    const fieldLower = (change.field || '').toLowerCase();

    // Search for HIGH/MEDIA confidence nodes related to this field
    const nodes = safe(() =>
      db.prepare(`
        SELECT id, titulo, contenido, confianza, area
        FROM nodos
        WHERE estado = 'ACTIVO'
          AND confianza IN ('ALTA', 'MEDIA')
          AND (
            titulo LIKE ? OR contenido LIKE ?
            OR titulo LIKE ? OR contenido LIKE ?
          )
        LIMIT 5
      `).all(
        `%${fieldLower}%`, `%${fieldLower}%`,
        `%${change.field}%`, `%${change.field}%`
      )
    ) || [];

    nodes.forEach(node => {
      const content = (node.titulo + ' ' + node.contenido).toLowerCase();

      // Check if memory contains a specific value for this field
      const valueInMemory = content.match(new RegExp(`${fieldLower}[^\\d]*(\\d+)`, 'i'));
      if (valueInMemory && change.to && valueInMemory[1] !== change.to) {
        violations.push({
          field:       change.field,
          from:        change.from,
          to:          change.to,
          memory_says: valueInMemory[1],
          node_id:     node.id,
          confidence:  node.confianza,
          rule:        node.titulo.substring(0, 80),
          severity:    node.confianza === 'ALTA' ? 'STOP' : 'WARN',
        });
      }
    });
  });

  return violations;
}

/**
 * Main: run spec gate check against a prompt.
 */
function runSpecGate(prompt, projectRoot) {
  projectRoot = projectRoot || process.cwd();
  const db = openDB(projectRoot);

  if (!db) return { passed: true, reason: 'No DB — skipping spec gate' };

  const changes = extractValuesFromPrompt(prompt);
  if (changes.length === 0) return { passed: true, reason: 'No value changes detected in prompt' };

  const violations = checkAgainstMemory(db, changes);
  db.close();

  if (violations.length === 0) {
    return { passed: true, changes_checked: changes.length };
  }

  const stops = violations.filter(v => v.severity === 'STOP');
  const warns = violations.filter(v => v.severity === 'WARN');

  return {
    passed:     stops.length === 0,
    violations,
    stops,
    warns,
    message: stops.length > 0
      ? `SPEC GATE STOP: ${stops.map(v =>
          `"${v.field}" in memory = ${v.memory_says} but prompt requests ${v.to} — contradicts ${v.confidence} confidence rule: "${v.rule}"`
        ).join('; ')}`
      : `SPEC GATE WARN: ${warns.map(v =>
          `"${v.field}" change may contradict memory rule: "${v.rule}"`
        ).join('; ')}`,
  };
}

if (require.main === module) {
  const prompt = process.argv.slice(2).join(' ');
  if (!prompt) {
    console.log('Usage: node spec-gate.cjs "your prompt here"');
    process.exit(0);
  }
  const result = runSpecGate(prompt, process.cwd());
  if (!result.passed) {
    console.log('\n🛑 SPEC GATE STOP');
    console.log(result.message);
    console.log('\nViolations:');
    result.violations.forEach(v => {
      console.log(`  ${v.severity} — ${v.field}: memory says ${v.memory_says}, prompt says ${v.to}`);
      console.log(`  Rule: "${v.rule}" (${v.confidence})`);
    });
    process.exit(1);
  } else if (result.warns?.length > 0) {
    console.log('\n⚠️  SPEC GATE WARN');
    console.log(result.message);
    process.exit(0);
  } else {
    console.log(`✅ SPEC GATE PASS (checked ${result.changes_checked || 0} value changes)`);
    process.exit(0);
  }
}

module.exports = { runSpecGate, extractValuesFromPrompt };
