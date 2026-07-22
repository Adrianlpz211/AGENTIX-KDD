'use strict';

/**
 * Doctor — reparación generalizada del proyecto (v3.16.9)
 *
 * `akdd health --fix` ya reparaba el schema (columnas faltantes). Este
 * comando une TODOS los mecanismos de reparación que ya existían sueltos en
 * el motor, en un solo paso — para que un cliente con un proyecto dañado
 * (por el motivo que sea, no solo el bug de columnas) tenga un único comando
 * que correr, en vez de tener que saber cuál de 5 scripts distintos usar.
 *
 * No inventa reparaciones nuevas — orquesta las que ya existen:
 *   1. schema-columns.cjs   — columnas de tabla faltantes (v3.16.8)
 *   2. grafo.cjs sync       — tablas base + nodos de memoria desde los .md
 *   3. ast-indexer.cjs      — reconstruye el grafo de código (atrapa
 *      symbol_errors/alertas si algo no persiste, v3.16.9)
 *   4. graph-reviewer.cjs   — limpia relaciones colgantes/fantasma/contratos rotos
 *   5. lock-manager.cjs     — purga locks vencidos (efecto lateral de status)
 *
 * Uso: node .agentic/grafo/doctor.cjs
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const GRAFO_DIR = __dirname;
const ROOT = process.cwd();

/** @param scriptPath ruta del script que este paso necesita, para saltar con
 *  gracia (no crashear) si un motor más viejo todavía no lo trae instalado —
 *  encontrado real probando contra biocaresoft-saas (instalado antes de que
 *  graph-reviewer.cjs existiera en el motor). */
function paso(nombre, cmd, scriptPath) {
  process.stdout.write(`\n  ── ${nombre} ──\n`);
  if (scriptPath && !fs.existsSync(scriptPath)) {
    console.log(`  ⏭️  omitido — ${path.basename(scriptPath)} no está instalado en este proyecto (motor viejo). Corre: akdd update`);
    return { ok: true, skipped: true };
  }
  try {
    const out = execSync(cmd, { cwd: ROOT, stdio: 'pipe', timeout: 120000 }).toString();
    console.log(out.trim().split('\n').map(l => '  ' + l).join('\n'));
    return { ok: true };
  } catch (e) {
    const out = (e.stdout || '').toString() + (e.stderr || '').toString();
    console.log((out || e.message).trim().split('\n').slice(0, 15).map(l => '  ' + l).join('\n'));
    return { ok: false, reason: e.message.slice(0, 120) };
  }
}

function main() {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  🩺 Agentix Doctor — reparación generalizada');
  console.log('═══════════════════════════════════════════════════');

  const resultados = {};
  const p = (name) => path.join(GRAFO_DIR, name);

  resultados.schema = paso(
    '1/5 — Columnas de tabla (schema-columns)',
    `node "${p('schema-columns.cjs')}" fix`, p('schema-columns.cjs')
  );

  resultados.sync = paso(
    '2/5 — Tablas base + memoria (grafo sync)',
    `node "${p('grafo.cjs')}" sync`, p('grafo.cjs')
  );

  resultados.ast = paso(
    '3/5 — Grafo de código (ast-indexer)',
    `node "${p('ast-indexer.cjs')}" index`, p('ast-indexer.cjs')
  );

  resultados.graph = paso(
    '4/5 — Integridad de memoria.db (graph-reviewer --fix)',
    `node "${p('graph-reviewer.cjs')}" --fix`, p('graph-reviewer.cjs')
  );

  resultados.locks = paso(
    '5/5 — Locks vencidos (purga automática vía status)',
    `node "${p('lock-manager.cjs')}" status`, p('lock-manager.cjs')
  );

  console.log('\n═══════════════════════════════════════════════════');
  const fallidos = Object.entries(resultados).filter(([, r]) => !r.ok);
  if (fallidos.length === 0) {
    console.log('  ✅ Doctor completo — sin fallos en ningún paso.');
  } else {
    console.log(`  ⚠️  ${fallidos.length} paso(s) con problemas: ${fallidos.map(([k]) => k).join(', ')}`);
    console.log('  (revisa el detalle arriba — algunos son informativos, no errores)');
  }
  console.log('═══════════════════════════════════════════════════\n');
}

if (require.main === module) main();

module.exports = { main };
