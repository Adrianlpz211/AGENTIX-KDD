'use strict';

/* Proyecto sintético y no sensible para el dashboard: nodos, aristas, ciclos,
   fases, AST, resúmenes y eventos de gate fijos. Con `payload` los textos que
   vienen de la memoria llevan cargas de inyección (D25). */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const net = require('net');

const REPO = path.join(__dirname, '..', '..');

const PAYLOADS = [
  '<svg onload="window.__akddXss=1">',
  '</script><script>window.__akddXss=2</script>',
  "'\";window.__akddXss=3;//",
  'linea\u2028separada\u2029',
  'javascript:window.__akddXss=4',
  '<img src=x onerror="window.__akddXss=5">',
];

const TABLAS = {
  nodos: 'id INTEGER PRIMARY KEY, tipo TEXT NOT NULL, titulo TEXT NOT NULL, contenido TEXT, area TEXT, confianza TEXT, aplicado INTEGER, util INTEGER, estado TEXT, ultimo_acceso TEXT, accesos_total INTEGER, decay_score REAL, embedding BLOB, embedding_modelo TEXT, ultima_validacion TEXT, fecha_creacion TEXT, fecha_update TEXT, vigencia_tipo TEXT, hash_contexto TEXT, archivos_aplica TEXT, validation_score REAL, anclas TEXT',
  relaciones: 'id INTEGER PRIMARY KEY, desde_id INTEGER NOT NULL, tipo TEXT NOT NULL, hacia_id INTEGER NOT NULL, peso REAL, fecha TEXT',
  ciclos: 'id INTEGER PRIMARY KEY, ciclo_id TEXT NOT NULL, tarea TEXT NOT NULL, tipo_tarea TEXT, modulo TEXT, area TEXT, estado TEXT, context_guard TEXT, fases_total INTEGER, fases_completadas INTEGER, patrones_aplicados TEXT, errores_evitados TEXT, decisiones_usadas TEXT, memory_trace TEXT, tests_generados INTEGER, tests_pasando INTEGER, review_blockers INTEGER, review_required INTEGER, stops_count INTEGER, sync_grafo INTEGER, duracion_ms INTEGER, snapshot_inicio TEXT, snapshot_fin TEXT, fecha_inicio TEXT, fecha_fin TEXT, ast_indexed INTEGER, knowledge_loaded INTEGER, modules_touched TEXT, stack_detected TEXT, post_cycle_ran INTEGER, duracion_origen TEXT',
  fases: 'id INTEGER PRIMARY KEY, ciclo_id TEXT NOT NULL, fase_num INTEGER NOT NULL, fase_nombre TEXT, agente TEXT, estado TEXT, memoria_leida TEXT, decision_tomada TEXT, resultado TEXT, intentos INTEGER, duracion_ms INTEGER, tokens_aprox INTEGER, fecha_inicio TEXT, fecha_fin TEXT, gate_result TEXT, harness_passed INTEGER',
  ast_symbols: 'id INTEGER PRIMARY KEY, file TEXT NOT NULL, language TEXT NOT NULL, symbol_name TEXT NOT NULL, kind TEXT NOT NULL, line_start INTEGER, line_end INTEGER, exported INTEGER, signature TEXT, pagerank REAL, last_indexed TEXT, content_hash TEXT',
  ast_edges: 'id INTEGER PRIMARY KEY, from_file TEXT NOT NULL, to_file TEXT, from_symbol TEXT, to_symbol TEXT, kind TEXT NOT NULL, weight REAL, pagerank_src REAL, last_indexed TEXT',
  gate_events: 'id INTEGER PRIMARY KEY, ts TEXT, gate TEXT NOT NULL, verdict TEXT NOT NULL, behavior_id TEXT, file TEXT, detalle TEXT, cycle_hint TEXT, source TEXT, cycle_id TEXT, event_id TEXT, incident_id TEXT',
  code_summaries: 'file TEXT NOT NULL, symbol TEXT NOT NULL, summary TEXT NOT NULL, lang TEXT, structural_sig TEXT, content_hash TEXT, generated_at TEXT',
  relaciones_semanticas: 'id INTEGER PRIMARY KEY, desde_entidad TEXT NOT NULL, tipo TEXT NOT NULL, hacia_entidad TEXT NOT NULL, peso REAL, descripcion TEXT, fecha TEXT, valid_at TEXT, invalid_at TEXT, expired_at TEXT, episode_id TEXT, confidence REAL, context TEXT, source TEXT',
};

function insertar(db, tabla, fila) {
  const k = Object.keys(fila);
  db.prepare(`INSERT INTO ${tabla} (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`).run(...k.map((x) => fila[x]));
}

/**
 * Las tablas de este fixture son una versión reducida. Un proyecto real llega a
 * tener el esquema COMPLETO porque `akdd update` lo migra con el catálogo; el
 * motor (desde 3.20.1) ya no migra en silencio al abrir. Se completa igual que
 * lo haría un update: el catálogo, estricto, sin tocar los datos.
 */
function completarEsquema(dbPath) {
  const dba = require('../../.agentic/grafo/db-adapter.cjs');
  const sc = require('../../.agentic/grafo/schema-catalog.cjs');
  const db = dba.openWrite(dbPath, { updateOwner: true });
  try { sc.apply(db, { version: 'fixture' }); } finally { db.close(); }
}

/** Crea el proyecto en `dir`. Devuelve su hash de contenido (fixture_hash). */
function crearFixture(dir, { payload = false, esquemaCompleto = false } = {}) {
  const { DatabaseSync } = require('node:sqlite');
  const ag = path.join(dir, '.agentic');
  fs.mkdirSync(path.join(ag, 'memoria'), { recursive: true });
  const P = (i, normal) => (payload ? PAYLOADS[i % PAYLOADS.length] + ' ' + normal : normal);
  fs.writeFileSync(path.join(ag, 'config.md'), [
    '# Configuración del proyecto', '', 'CONFIGURADO: SI', '',
    '## Proyecto', `Nombre: ${P(0, 'Fixture Tienda')}`, `Stack: ${P(1, 'Node.js')}`,
    ...(payload ? [`Descripción: ${P(5, 'Tienda de prueba')}`, `Tipo: ${P(0, 'api')}`, `  framework: ${P(2, 'Express')}`, `  dev: ${P(1, 'npm run dev')}`, `  test: ${P(5, 'npm test')}`] : []), '',
    '## Módulos implementados', '- pedidos', '- pagos', ...(payload ? ['- ' + PAYLOADS[2] + 'envios', '- ' + PAYLOADS[0] + 'cobros'] : []), '', '## Módulos pendientes', '- reportes', '',
    '## Reglas', `- ${P(1, 'Los totales se redondean a centavos')}`, '',
  ].join('\n'));
  fs.writeFileSync(path.join(ag, 'memoria', 'patrones.md'), `## ${P(2, 'Validar cantidad entera')}\nestado: ACTIVO\nárea: pedidos\nconfianza: ALTA\n\nSe valida en la frontera.\n`);
  fs.writeFileSync(path.join(ag, 'memoria', 'decisiones.md'), `## ${P(3, 'Redondeo bancario')}\nárea: pagos\n\nSe usa Math.round sobre centavos.\n`);
  fs.writeFileSync(path.join(ag, 'memoria', 'errores.md'), `## ${P(4, 'Doble cobro')}\nárea: pagos\n\nSíntoma: dos cargos.\nSolución: ${P(5, 'clave de idempotencia')}\n`);
  fs.writeFileSync(path.join(ag, 'memoria', 'trabajo.md'), '# Trabajo\n');

  const db = new DatabaseSync(path.join(ag, 'memoria.db'));
  for (const [t, cols] of Object.entries(TABLAS)) db.exec(`CREATE TABLE ${t} (${cols})`);
  const F = '2026-09-01T10:00:00.000Z';
  const nodos = [
    ['error', 'Doble cobro', 'pagos'], ['patron', 'Validar cantidad entera', 'pedidos'], ['decision', 'Redondeo bancario', 'pagos'],
    ['patron', 'Idempotencia por clave', 'pagos'], ['error', 'Total sin redondear', 'pedidos'], ['decision', 'Tenant en cada consulta', 'auth'],
  ];
  if (payload) nodos[5][2] = PAYLOADS[0] + PAYLOADS[2] + 'auth';
  nodos.forEach(([tipo, titulo, area], i) => insertar(db, 'nodos', {
    id: i + 1, tipo, titulo: P(i, titulo), contenido: P(i + 1, 'Contenido de ' + titulo) + '\nárea: ' + area, area, confianza: payload && i === 5 ? '" onmouseover="window.__akddXss=6" x="' : (i % 2 ? 'ALTA' : 'MEDIA'),
    aplicado: i, util: i, estado: 'ACTIVO', fecha_creacion: F, fecha_update: F, archivos_aplica: JSON.stringify(['src/' + area + '.js']),
  }));
  [[1, 'resuelto_por', 4], [2, 'relacionado', 5], [3, payload ? PAYLOADS[5] : 'aplica_a', 6], [4, 'relacionado', 1]].forEach(([a, tipo, b], i) => insertar(db, 'relaciones', { id: i + 1, desde_id: a, tipo, hacia_id: b, peso: 1, fecha: F }));
  [['c1', 'pedidos', 'COMPLETADO', 'feature', 600000], ['c2', 'pagos', 'COMPLETADO_CON_PENDIENTES', 'fix', null], ['c3', 'pagos', 'STOP', 'fix', 120000]].forEach(([id, modulo, estado, tipo, ms], i) => insertar(db, 'ciclos', {
    id: i + 1, ciclo_id: id, tarea: P(i, 'Tarea ' + id + ' de ' + modulo), tipo_tarea: tipo, modulo, area: modulo, estado, fases_total: 4, fases_completadas: estado === 'STOP' ? 2 : 4,
    tests_generados: 10, tests_pasando: estado === 'STOP' ? 7 : 10, stops_count: estado === 'STOP' ? 1 : 0, duracion_ms: ms,
    fecha_inicio: `2026-09-0${i + 1}T09:00:00.000Z`, fecha_fin: `2026-09-0${i + 1}T10:00:00.000Z`, post_cycle_ran: 1, patrones_aplicados: '[]', errores_evitados: '[]',
  }));
  insertar(db, 'fases', { id: 1, ciclo_id: 'c1', fase_num: 1, fase_nombre: 'Analista', agente: 'analista', estado: 'COMPLETADO', resultado: P(0, 'plan'), fecha_inicio: F, fecha_fin: F });
  const RARO = "x');window.__akddXss=7;('/raro.js";
  const archivos = [['src/pedidos.js', 'javascript'], ['src/pagos.js', 'javascript'], ['src/auth.js', 'javascript'], ['public/app.js', 'javascript'], ...(payload ? [[RARO, 'javascript']] : [])];
  archivos.forEach(([file, language], i) => {
    insertar(db, 'ast_symbols', { file, language, symbol_name: 'crear' + i, kind: 'function', line_start: 1, line_end: 9, exported: 1, signature: P(i, 'crear' + i + '()'), pagerank: 0.4 - i * 0.05, content_hash: 'h' + i });
    insertar(db, 'ast_symbols', { file, language, symbol_name: 'nota' + i, kind: 'note', line_start: 10, line_end: 10, exported: 0, signature: P(i + 2, 'nota del archivo'), pagerank: 0.1, content_hash: 'h' + i });
    insertar(db, 'code_summaries', { file, symbol: '*', summary: P(i + 3, 'Recibe pedidos y los guarda'), lang: 'es', content_hash: 'h' + i, generated_at: F });
  });
  [['src/pedidos.js', 'src/pagos.js', 'IMPORTS'], ['src/pagos.js', 'src/auth.js', 'CALLS'], ['public/app.js', 'src/pedidos.js', 'IMPORTS'], ...(payload ? [[RARO, 'src/pagos.js', 'IMPORTS']] : [])].forEach(([a, b, kind]) => insertar(db, 'ast_edges', { from_file: a, to_file: b, kind, weight: 1 }));
  [['tdd', 'STOP', 'src/pagos.js'], ['regression', 'WARN', 'src/pedidos.js']].forEach(([gate, verdict, file], i) => insertar(db, 'gate_events', { ts: `2026-09-0${i + 1}T09:30:00.000Z`, gate, verdict, file, detalle: P(i, 'detalle'), source: 'mechanical', event_id: 'e' + i }));
  db.close();
  // Solo cuando una prueba ejecuta el MOTOR sobre el fixture (el tablero lee con un adaptador de solo lectura y tolera tablas ausentes).
  if (esquemaCompleto) completarEsquema(path.join(ag, 'memoria.db'));

  const h = crypto.createHash('sha256');
  for (const f of ['config.md', 'memoria/patrones.md', 'memoria/decisiones.md', 'memoria/errores.md']) h.update(fs.readFileSync(path.join(ag, f)));
  h.update(JSON.stringify({ TABLAS, payload }));
  return h.digest('hex').slice(0, 16);
}

function puertoLibre() {
  return new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
}

/** Arranca el dashboard del repo sobre el fixture; resuelve con la URL. */
async function arrancarDashboard(dir, envExtra) {
  const port = await puertoLibre();
  const env = Object.assign({}, process.env, envExtra, { AKDD_DASH_PORT: String(port), AKDD_DASH_NO_OPEN: '1' });
  delete env.NODE_TEST_CONTEXT;
  // AKDD_DASH_SCRIPT: correr la misma prueba contra otra revisión (prueba roja).
  const script = process.env.AKDD_DASH_SCRIPT || path.join(REPO, 'dashboard.cjs');
  const p = spawn(process.execPath, [script], { cwd: dir, env, windowsHide: true });
  let salida = '';
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('el dashboard no arrancó: ' + salida.slice(-400))), 30000);
    const ver = (d) => { salida += d; if (/Dashboard v4|localhost:\d+/.test(salida)) { clearTimeout(t); res(); } };
    p.stdout.on('data', ver); p.stderr.on('data', ver);
    p.on('exit', (c) => { clearTimeout(t); rej(new Error('el dashboard terminó (' + c + '): ' + salida.slice(-400))); });
  });
  return { url: `http://127.0.0.1:${port}/`, proceso: p, cerrar: () => { try { p.kill(); } catch { /* ya terminó */ } } };
}

module.exports = { crearFixture, arrancarDashboard, PAYLOADS, puertoLibre, REPO };
