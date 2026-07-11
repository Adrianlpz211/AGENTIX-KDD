'use strict';
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Sandbox: proyecto de prueba aislado en un directorio temporal
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-native-test-'));
fs.mkdirSync(path.join(tmpRoot, '.agentic'), { recursive: true });
fs.writeFileSync(path.join(tmpRoot, 'a.js'), `
function foo() { return bar(); }
function bar() { return 1; }
`);
fs.writeFileSync(path.join(tmpRoot, 'b.js'), `
const { foo } = require('./a.js');
function usaFoo() { return foo(); }
`);

const { indexProject } = require('../.agentic/grafo/ast-indexer.cjs');
const { detectRecentChangesNative, tracePathNative } = require('../.agentic/grafo/causal-edges.cjs');

// Driver SQLite: better-sqlite3 si está disponible (requiere compilación nativa),
// si no, node:sqlite (built-in, experimental) — mismo fallback dual que ya usan
// openDB() en ast-indexer.cjs y causal-edges.cjs. En este entorno no hay
// Visual Studio Build Tools, así que better-sqlite3 no puede compilar y se
// usa node:sqlite.
function openDb(dbPath, opts = {}) {
  try {
    const BS3 = require('better-sqlite3');
    return opts.readonly ? new BS3(dbPath, { readonly: true }) : new BS3(dbPath);
  } catch {
    const { DatabaseSync } = require('node:sqlite');
    return new DatabaseSync(dbPath, { readOnly: !!opts.readonly });
  }
}

const result = indexProject(tmpRoot);
assert.ok(result.changedFiles.length >= 2, `esperaba >= 2 archivos cambiados, obtuve ${result.changedFiles.length}`);

const db = openDb(path.join(tmpRoot, '.agentic', 'memoria.db'));

const changes = detectRecentChangesNative(db);
assert.ok(changes.ran_at, 'esperaba un ran_at no nulo');
assert.ok(changes.changed.includes('a.js') || changes.changed.includes('b.js'), 'esperaba a.js o b.js en changed');

console.log('✅ causal-edges.native.test.cjs (parte 1: detect-changes) — PASS');

// Limpieza
db.close();
fs.rmSync(tmpRoot, { recursive: true, force: true });

// Parte 2: tracePathNative contra datos REALES de Lumo (no sandbox).
// C:\lumo es un proyecto de desarrollo local de esta sesión — no existe en
// ninguna máquina que instale este paquete por npm. Sin este guard, la Parte 2
// revienta con una excepción sin capturar en cualquier instalación real.
const lumoDbPath = 'C:\\lumo\\.agentic\\memoria.db';
if (fs.existsSync(lumoDbPath)) {
  const dbLumo = openDb(lumoDbPath, { readonly: true });
  const anyImport = dbLumo.prepare(`SELECT from_file, to_file FROM ast_edges WHERE kind='IMPORTS' AND to_file IS NOT NULL LIMIT 1`).get();
  if (anyImport) {
    const trace = tracePathNative(dbLumo, anyImport.from_file, anyImport.to_file);
    assert.ok(Array.isArray(trace) && trace.length >= 2, 'esperaba una ruta de al menos 2 archivos');
    console.log('✅ causal-edges.native.test.cjs (parte 2: trace real en Lumo) — PASS', trace);
  } else {
    console.log('⚠️  Sin edges IMPORTS en Lumo para probar trace — revisar Task 1');
  }
  dbLumo.close();
} else {
  console.log('⚠️ Parte 2 omitida — C:\\lumo no existe en esta máquina (verificación específica de esta sesión de desarrollo)');
}
