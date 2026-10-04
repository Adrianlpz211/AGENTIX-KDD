'use strict';
/**
 * Inventario de accesos SQLite (3.20.1).
 *
 * El db-adapter es el punto de entrada que sabe respetar la exclusión de un
 * `akdd update` y comprobar capacidades reales. Muchos módulos del motor abren
 * SQLite DIRECTAMENTE con better-sqlite3 o node:sqlite: es deuda conocida y se
 * declara aquí, archivo por archivo, en lugar de esconderla.
 *
 * Qué hace este test:
 *   · La lista de accesos directos debe ser EXACTAMENTE esta. Un módulo nuevo que
 *     abra SQLite por su cuenta falla el test (hay que pasar por el adaptador o
 *     declararlo aquí a propósito). Convertir uno a adaptador también obliga a
 *     quitarlo de la lista: la lista no puede mentir en ninguna dirección.
 *   · Los escritores que importan durante un update SÍ respetan la exclusión.
 *   · Ya no quedan migraciones que se prueben con "ALTER y callar el error".
 *
 * Qué NO garantiza: los accesos directos de la lista no consultan la exclusión.
 * Durante un update los cubre el bloqueo de escritura de SQLite (la migración es una
 * transacción) y el sondeo previo que bloquea el update si la base está tomada.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const leer = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const DIRECTO = /new\s*\(\s*require\('better-sqlite3'\)\s*\)|new\s+BS3\s*\(|new\s+Database\s*\(|new\s+DatabaseSync\s*\(|new\s*\(\s*require\('node:sqlite'\)\.DatabaseSync\s*\)/;

const ACCESO_DIRECTO_CONOCIDO = [
  ".agentic/grafo/adr-ingestor.cjs",
  ".agentic/grafo/akdd-analyze.cjs",
  ".agentic/grafo/area-backfill.cjs",
  ".agentic/grafo/ast-indexer.cjs",
  ".agentic/grafo/autonomous-decision.cjs",
  ".agentic/grafo/causal-edges.cjs",
  ".agentic/grafo/change-classifier.cjs",
  ".agentic/grafo/clickup-bridge.cjs",
  ".agentic/grafo/collab-manager.cjs",
  ".agentic/grafo/context-enricher.cjs",
  ".agentic/grafo/coverage-meter.cjs",
  ".agentic/grafo/creative-engine.cjs",
  ".agentic/grafo/css-token-gate.cjs",
  ".agentic/grafo/decision-trail.cjs",
  ".agentic/grafo/diff-overlay.cjs",
  ".agentic/grafo/effectiveness-report.cjs",
  ".agentic/grafo/error-cure.cjs",
  ".agentic/grafo/gate-telemetry.cjs",
  ".agentic/grafo/graph-export.cjs",
  ".agentic/grafo/graph-freshness.cjs",
  ".agentic/grafo/graph-reviewer.cjs",
  ".agentic/grafo/impact-analyzer.cjs",
  ".agentic/grafo/knowledge-ingestor.cjs",
  ".agentic/grafo/knowledge-validator.cjs",
  ".agentic/grafo/linea-tiempo.cjs",
  ".agentic/grafo/llms-generator.cjs",
  ".agentic/grafo/lock-manager.cjs",
  ".agentic/grafo/mcp-server.cjs",
  ".agentic/grafo/mem-curator.cjs",
  ".agentic/grafo/memory-audit.cjs",
  ".agentic/grafo/metrics.cjs",
  ".agentic/grafo/parallel-guard.cjs",
  ".agentic/grafo/post-cycle.cjs",
  ".agentic/grafo/prediccion-registro.cjs",
  ".agentic/grafo/reasoning-bank.cjs",
  ".agentic/grafo/reloj-derivado.cjs",
  ".agentic/grafo/security-gate.cjs",
  ".agentic/grafo/session-guard.cjs",
  ".agentic/grafo/spec-gate.cjs",
  ".agentic/grafo/spec-value-scan.cjs",
  ".agentic/grafo/sprint-state.cjs",
  ".agentic/grafo/stack-profile.cjs",
  ".agentic/grafo/tdd-gate.cjs",
  ".agentic/grafo/ts-enricher.cjs",
  ".agentic/grafo/ui-native-gate.cjs",
  ".agentic/grafo/watch-errors.cjs"
];

const archivos = () => [
  ...fs.readdirSync(path.join(REPO, '.agentic', 'grafo')).filter((n) => n.endsWith('.cjs')).map((n) => '.agentic/grafo/' + n),
  'dashboard.cjs',
  ...fs.readdirSync(path.join(REPO, 'src')).filter((n) => n.endsWith('.js')).map((n) => 'src/' + n),
];

test('accesos SQLite: la lista de aperturas directas es exactamente la declarada', () => {
  const hoy = archivos().filter((f) => f !== '.agentic/grafo/db-adapter.cjs' && DIRECTO.test(leer(f))).sort();
  const nuevos = hoy.filter((f) => !ACCESO_DIRECTO_CONOCIDO.includes(f));
  const convertidos = ACCESO_DIRECTO_CONOCIDO.filter((f) => !hoy.includes(f));
  assert.deepEqual(nuevos, [], 'abren SQLite por su cuenta sin estar declarados: pasen por db-adapter.cjs o declárenlo a propósito');
  assert.deepEqual(convertidos, [], 'ya no abren SQLite directamente: quítenlos de la lista');
});

test('accesos SQLite: los escritores que importan durante un update respetan la exclusión', () => {
  for (const f of ['.agentic/grafo/db-adapter.cjs', '.agentic/grafo/post-cycle.cjs', '.agentic/grafo/hook-runner.cjs', '.agentic/grafo/lock-manager.cjs',
    '.agentic/grafo/gate-telemetry.cjs', '.agentic/grafo/mcp-server.cjs']) {
    assert.match(leer(f), /update-guard\.cjs/, f + ' debe consultar update-guard');
  }
  assert.match(leer('.agentic/grafo/mcp-server.cjs'), /registerWriter/, 'el MCP se registra como escritor con pausa y ack');
});

test('esquema estricto: ni grafo.cjs ni schema-columns.cjs prueban "ALTER y callar el error"', () => {
  for (const f of ['.agentic/grafo/grafo.cjs', '.agentic/grafo/schema-columns.cjs']) {
    const t = leer(f);
    assert.ok(!/ALTER TABLE[^\n]*catch\s*(\(\w*\))?\s*\{\s*\}/.test(t), f + ' aún traga el error de un ALTER');
    assert.ok(!/db\.exec\(\s*sql\s*\)\s*;?\s*\}\s*catch\s*\(?\w*\)?\s*\{\s*\}/.test(t), f + ' aún ejecuta migraciones con catch vacío');
  }
  assert.match(leer('.agentic/grafo/grafo.cjs'), /schema-catalog\.cjs/, 'grafo.cjs usa el catálogo');
});

test('esquema estricto: el único lugar que decide la estructura es el catálogo', () => {
  const sc = require('../.agentic/grafo/schema-catalog.cjs');
  assert.ok(sc.unidades().length > 50);
  assert.ok(sc.CATALOG_CHECKSUM.length === 64);
});

test('conectores: la declaración de Node del README coincide con lo que el código exige', () => {
  const pkg = require('../package.json');
  const adaptador = leer('.agentic/grafo/db-adapter.cjs');
  assert.match(adaptador, /selectDriverForUpdate/, 'el update elige conector por pruebas reales');
  assert.ok(pkg.optionalDependencies && pkg.optionalDependencies['better-sqlite3'], 'better-sqlite3 sigue siendo opcional');
});
