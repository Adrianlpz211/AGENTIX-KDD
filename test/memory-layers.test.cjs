'use strict';
// Canarios: valores FALSOS con formato de secreto, codificados para que el escáner de secretos del repo no los confunda con una filtración real.
const dec = (b) => Buffer.from(b, 'base64').toString('utf8');
/* C02 — Recuperación por capas: índice → detalle → cronología → evidencia (CLI y MCP), presupuesto acumulado, caché, obligaciones. */
const test = require('node:test');
const { SIN_DRIVER } = require('./helpers/db-real.cjs');
if (SIN_DRIVER) { test(require('node:path').basename(__filename) + ' (omitido: ' + SIN_DRIVER + ')', { skip: SIN_DRIVER }, () => {}); return; }
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const { proyecto, REPO, dba, catalogo } = require('./helpers/memoria-proyecto.cjs');
const GRAFO = path.join(REPO, '.agentic', 'grafo');
const core = require(path.join(GRAFO, 'memory-core.cjs'));
const store = require(path.join(GRAFO, 'evidence-store.cjs'));
const usage = require(path.join(GRAFO, 'context-usage.cjs'));
const layers = require(path.join(GRAFO, 'memory-layers.cjs'));
const mcp = require(path.join(GRAFO, 'mcp-memory-tools.cjs'));
const effort = require(path.join(GRAFO, 'effort-router.cjs'));
const SCHEMA = fs.readFileSync(path.join(GRAFO, 'schema.sql'), 'utf8');
const CLI = path.join(GRAFO, 'memory-layers.cjs');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
/**
 * Una base con la forma de la 3.19: solo schema.sql (sin tablas mem_* ni columnas añadidas por el catálogo).
 * El helper compartido no sirve aquí: su semilla escribe vigencia_tipo, que solo existe con el catálogo aplicado.
 */
function sinCatalogo(nombre) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-3190-' + nombre + '-')));
  const dbPath = path.join(root, '.agentic', 'memoria.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  dba.initialize(dbPath, SCHEMA);
  const db = dba.openWrite(dbPath, { updateOwner: true });
  try { for (let i = 0; i < 3; i++) db.run('INSERT INTO nodos (tipo, titulo, contenido, area, confianza, estado) VALUES (?,?,?,?,?,?)', 'patron', 'REGLA_' + i, 'Memoria original ' + i, 'auth', 'MEDIA', 'ACTIVO'); } finally { db.close(); }
  return { root, dbPath, abrirW: () => dba.openWrite(dbPath, { updateOwner: true }), abrirR: () => dba.openReadOnly(dbPath), limpiar() { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* en uso */ } } };
}
const listaTablas = (p) => { const d = p.abrirR(); try { return d.all("SELECT name FROM sqlite_master ORDER BY name").map((r) => r.name); } finally { d.close(); } };

/** Ejecuta la CLI como proceso real. */
function cli(args, root) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--root=' + root], { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  let out = null; try { out = JSON.parse(r.stdout); } catch { /* salida no JSON */ }
  return { status: r.status, out, stdout: r.stdout, stderr: r.stderr };
}

function insNodo(p, { titulo, contenido, tipo = 'patron', area = 'auth', confianza = 'MEDIA', archivos = null, vigencia = 'VIGENTE', estado = 'ACTIVO' }) {
  const d = p.abrirW();
  try {
    d.run('INSERT INTO nodos (tipo, titulo, contenido, area, confianza, estado, vigencia_tipo, archivos_aplica) VALUES (?,?,?,?,?,?,?,?)', tipo, titulo, contenido, area, confianza, estado, vigencia, archivos ? JSON.stringify(archivos) : null);
    return Number(d.get('SELECT last_insert_rowid() AS id').id);
  } finally { d.close(); }
}

/** Actividad, observación, evidencia y un conocimiento propuesto que las enlaza. */
function sembrar(p, task = 'T-1') {
  const root = p.root;
  const evs = [0, 1, 2, 3].map((i) => core.capturar(root, { session_id: 's1', host: 'cursor', event_type: 'tool', task_id: task, host_event_id: 'h' + i, input: 'entrada ' + i, output: 'salida ' + i, paths: ['src/auth.js'] }));
  evs.forEach((e) => assert.equal(e.status, 'CAPTURED', JSON.stringify(e)));
  const obs = core.observar(root, { event_ids: [evs[0].event_id, evs[1].event_id], kind: 'note', summary: 'observación de prueba', task_id: task });
  const ev = store.guardar(root, { text: 'linea1\nlinea2\nlinea3\nlinea4\n' }, { kind: 'tool_output', task_id: task });
  assert.equal(ev.ok, true, JSON.stringify(ev));
  const k = core.proponerConocimiento(root, { titulo: 'Regla JWT', contenido: 'Validar jwt en el middleware de auth', area: 'auth', archivos: ['src/auth.js'], event_ids: [evs[0].event_id], observation_ids: [obs.observation_id], evidence_ids: [ev.evidence_id] });
  assert.equal(k.ok, true, JSON.stringify(k));
  return { evs, obs, ev, k };
}

const insContrato = (p, c) => {
  const d = p.abrirW();
  try { d.run('INSERT INTO verified_contracts (id, module, name, description, source_files, test_file, test_name, status) VALUES (?,?,?,?,?,?,?,?)', c.id, c.module || 'auth', c.name || 'contrato ' + c.id, c.description || 'El login exige el token firmado', JSON.stringify(c.source_files || ['src/auth.js']), c.test_file || 'test/auth.test.js', c.test_name || 'login firma', c.status || 'protected'); } finally { d.close(); }
};

const decision = (root, task, maxBytes) => effort.decidirYGuardar(root, { intent: 'ajustar texto', task_id: task, paths: ['README.md'], change_type: 'text', index_coverage: 'COMPLETE', user_limits: { max_context_bytes: maxBytes } });

// ─────────────────────────────────────────────────────────────────────────────
test('índice → lote de detalles → cronología → evidencia, por CLI (proceso real) y por el módulo MCP', () => {
  layers.limpiarCache();
  const p = proyecto('flujo');
  try {
    const s = sembrar(p);
    const id = s.k.node_id;
    // ── CLI
    const i = cli(['index', '--query=jwt middleware', '--task=T-1', '--tier=MEDIUM'], p.root);
    assert.equal(i.status, 0, i.stdout + i.stderr);
    assert.equal(i.out.status, 'OK');
    assert.equal(i.out.contract_version, 'memory-layers/1');
    const hit = i.out.results.find((r) => String(r.id) === id);
    assert.ok(hit, 'el índice encuentra el conocimiento');
    assert.equal(hit.knowledge_state, 'PROPOSED');
    assert.equal(hit.provenance_kind, 'OBSERVED');
    assert.deepEqual([hit.provenance.events, hit.provenance.observations, hit.provenance.evidence], [2, 1, 1], 'resumen de procedencia');
    assert.equal(hit.cost.estimacion, 'bytes/4', 'el coste se declara como estimación');
    for (const campo of ['id', 'title', 'type', 'vigencia', 'summary', 'relevance', 'provenance', 'cost']) assert.ok(campo in hit, 'falta ' + campo);

    const d = cli(['detail', id, '1', '--task=T-1', '--tier=MEDIUM'], p.root);
    assert.equal(d.out.status, 'OK');
    assert.equal(d.out.results.length, 2, 'un lote: dos ids en una sola llamada');
    const det = d.out.results.find((r) => String(r.id) === id);
    assert.match(det.content, /jwt/);
    assert.equal(det.provenance.evidence_ids[0], s.ev.evidence_id, 'el detalle apunta a la evidencia');
    const legado = d.out.results.find((r) => String(r.id) === '1');
    assert.equal(legado.provenance_kind, 'LEGACY_UNVERIFIED_PROVENANCE');

    const t = cli(['timeline', '--node=' + id, '--task=T-1'], p.root);
    assert.equal(t.out.status, 'OK', t.stdout);
    assert.equal(t.out.total, 4);
    assert.equal(t.out.events.length, 4);
    assert.ok(t.out.events.some((e) => e.is_anchor), 'marca el evento ancla');
    assert.equal(t.out.events.find((e) => e.event_id === s.evs[0].event_id).observations[0].summary, 'observación de prueba');

    const e = cli(['evidence', det.provenance.evidence_ids[0], '--task=T-1'], p.root);
    assert.equal(e.out.status, 'OK', e.stdout);
    assert.equal(e.out.content, 'linea1\nlinea2\nlinea3\nlinea4\n');
    assert.equal(e.out.sha256, s.ev.sha256);
    assert.equal(e.out.complete, true);

    const u = usage.acumulado(p.root, 'T-1');
    for (const kind of ['recall_index', 'recall_detail', 'timeline', 'evidence_retrieval']) assert.ok(u.by_kind[kind], 'el uso de ' + kind + ' quedó registrado');

    // ── MCP (misma cadena por la interfaz del módulo)
    layers.limpiarCache();
    const mi = mcp.handle('memory_index', { query: 'jwt middleware', task_id: 'T-2', tier: 'MEDIUM' }, p.root);
    assert.equal(mi.status, 'OK');
    const mid = mi.results.find((r) => String(r.id) === id).id;
    const md = mcp.handle('memory_detail', { ids: [mid, 1], task_id: 'T-2', tier: 'MEDIUM' }, p.root);
    assert.equal(md.results.length, 2);
    const mt = mcp.handle('memory_timeline', { node_id: String(mid), task_id: 'T-1' }, p.root);
    assert.equal(mt.status, 'OK');
    const me = mcp.handle('memory_evidence', { evidence_id: md.results[0].provenance.evidence_ids[0] || s.ev.evidence_id, task_id: 'T-2' }, p.root);
    assert.equal(me.status, 'OK');
    assert.equal(me.sha256, s.ev.sha256);
  } finally { p.limpiar(); }
});

test('presupuesto ACUMULADO: los detalles, el timeline y otro rol cuentan; no se reinicia por llamada', () => {
  layers.limpiarCache();
  const p = proyecto('acumulado');
  try {
    const s = sembrar(p, 'T-A');
    const id = s.k.node_id;
    const r1 = layers.indice(p.root, { query: 'jwt', task_id: 'T-A', tier: 'LOW' });
    assert.equal(r1.budget.usado_acumulado, 0);
    const r2 = layers.detalle(p.root, [id], { task_id: 'T-A', tier: 'LOW', role: 'builder' });
    assert.equal(r2.budget.usado_acumulado, r1.budget.este_llamado, 'el detalle ya arranca con lo gastado en el índice');
    const r3 = layers.indice(p.root, { query: 'jwt', task_id: 'T-A', tier: 'LOW', role: 'qa' });
    assert.equal(r3.budget.usado_acumulado, r1.budget.este_llamado + r2.budget.este_llamado, 'cambiar de rol no reinicia');
    assert.equal(r3.budget.restante, r3.budget.limite - r3.budget.usado_acumulado - r3.budget.este_llamado);
    const u = usage.acumulado(p.root, 'T-A');
    assert.equal(u.by_kind.recall_detail.delivered_bytes, r2.budget.este_llamado, 'el coste del detalle está en el acumulado');
    assert.equal(u.measures.estimated_bytes4, 3, 'la medición es una estimación declarada');
    assert.equal(r1.budget.estimacion, 'bytes/4');
    // sin task_id no hay acumulado y se dice
    const sin = layers.indice(p.root, { query: 'jwt', tier: 'LOW' });
    assert.equal(sin.budget.accumulated, false);
    assert.match(sin.budget.note, /task_id/);
  } finally { p.limpiar(); }
});

test('la decisión de esfuerzo manda sobre el tier pedido y su límite se agota: INSUFFICIENT_BUDGET explícito', () => {
  layers.limpiarCache();
  const p = proyecto('esfuerzo');
  try {
    sembrar(p, 'T-E');
    const dec = decision(p.root, 'T-E', 1500);
    assert.equal(dec.context_budget_bytes, 1500);
    const pedido = dec.tier === 'HIGH' ? 'LOW' : 'HIGH';
    const r = layers.indice(p.root, { query: 'jwt', task_id: 'T-E', tier: pedido });
    assert.equal(r.budget.tier, dec.tier, 'no se puede bajar/subir el tier para esquivar la decisión');
    assert.equal(r.budget.requested_tier_ignored, pedido);
    assert.equal(r.budget.limite, 1500);
    assert.equal(r.budget.tier_source, 'effort_decision');
    // consumo hasta agotar
    layers.detalle(p.root, [1, 2, 3], { task_id: 'T-E' });
    layers.detalle(p.root, [1, 2, 3], { task_id: 'T-E' });
    const agotado = layers.indice(p.root, { query: 'jwt', task_id: 'T-E' });
    assert.equal(agotado.status, 'INSUFFICIENT_BUDGET');
    assert.equal(agotado.code, 'INDEX_DOES_NOT_FIT');
    assert.ok(agotado.needed_bytes > 0, 'dice cuánto haría falta');
    assert.ok(agotado.total >= 1, 'sabe que hay resultados: no los confunde con "sin resultados"');
  } finally { p.limpiar(); }
});

test('cambiar memoria, vigencia, código o permisos invalida la caché; el registro de uso no; fallos de BD no se cachean', () => {
  layers.limpiarCache();
  const p = proyecto('cache');
  try {
    sembrar(p, 'T-C');
    const q = { query: 'jwt auth', task_id: 'T-C', tier: 'MEDIUM' };
    assert.equal(layers.indice(p.root, q).cache, 'miss');
    assert.equal(layers.indice(p.root, q).cache, 'hit', 'anotar el consumo no invalida la caché de la siguiente llamada');
    // vigencia
    const d = p.abrirW(); try { d.run("UPDATE nodos SET vigencia_tipo = 'SOSPECHOSO' WHERE id = 1"); } finally { d.close(); }
    assert.equal(layers.indice(p.root, q).cache, 'miss', 'cambio de vigencia');
    assert.equal(layers.indice(p.root, q).cache, 'hit');
    // contenido nuevo
    insNodo(p, { titulo: 'Otra regla auth', contenido: 'jwt otra vez' });
    const tras = layers.indice(p.root, q);
    assert.equal(tras.cache, 'miss', 'memoria nueva');
    assert.ok(tras.results.some((r) => r.title === 'Otra regla auth'), 'y se ve el contenido nuevo, no el viejo');
    // archivo relevante
    fs.mkdirSync(path.join(p.root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(p.root, 'src', 'auth.js'), 'v1');
    const qa = { ...q, paths: ['src/auth.js'] };
    assert.equal(layers.indice(p.root, qa).cache, 'miss');
    assert.equal(layers.indice(p.root, qa).cache, 'hit');
    fs.writeFileSync(path.join(p.root, 'src', 'auth.js'), 'v2');
    assert.equal(layers.indice(p.root, qa).cache, 'miss', 'cambió el código relevante');
    // permisos (política de privacidad)
    assert.equal(layers.indice(p.root, qa).cache, 'hit');
    fs.writeFileSync(path.join(p.root, '.agentic', 'privacy-policy.json'), JSON.stringify({ policy_id: 'otra', deny_paths: ['secretos/**'] }));
    assert.equal(layers.indice(p.root, qa).cache, 'miss', 'cambió la política de privacidad');
    // sesión: aislada
    assert.equal(layers.indice(p.root, { ...q, session_id: 'A' }).cache, 'miss');
    assert.equal(layers.indice(p.root, { ...q, session_id: 'B' }).cache, 'miss', 'otra sesión no recicla la caché de la primera');
    assert.equal(layers.indice(p.root, { ...q, session_id: 'A' }).cache, 'hit');
  } finally { p.limpiar(); }

  // un fallo de BD no se cachea como "sin coincidencias"
  layers.limpiarCache();
  const q2 = sinCatalogo('cache-fallo');
  try {
    const fallo = layers.indice(q2.root, { query: 'REGLA' });
    assert.equal(fallo.status, 'SCHEMA_MISSING');
    const db = q2.abrirW(); try { catalogo.apply(db, { version: '3.20.1', actor: 'test' }); } finally { db.close(); }
    const bien = layers.indice(q2.root, { query: 'REGLA' });
    assert.equal(bien.status, 'OK', 'no se sirvió el fallo anterior');
    assert.equal(bien.cache, 'miss');
    assert.ok(bien.total >= 3);
  } finally { q2.limpiar(); }
});

test('contrato PROTEGIDO aplicable: viaja en obligations y no se omite en silencio por presupuesto', () => {
  layers.limpiarCache();
  const p = proyecto('obligaciones');
  try {
    for (let i = 0; i < 8; i++) insNodo(p, { titulo: 'auth regla ' + i, contenido: 'jwt token sesion '.repeat(40) + i });
    insContrato(p, { id: 'AUTH-001', status: 'protected', source_files: ['src/auth.js'] });
    insContrato(p, { id: 'AUTH-002', status: 'verified', source_files: ['src/auth.js'] });
    insContrato(p, { id: 'PAGO-001', status: 'protected', source_files: ['src/pagos.js'] });

    const sinPaths = layers.indice(p.root, { query: 'jwt' });
    assert.equal(sinPaths.obligations.evaluated, false, 'sin paths no se puede saber qué aplica y se dice');
    assert.match(sinPaths.obligations.reason, /paths/);

    const ok = layers.indice(p.root, { query: 'jwt', paths: ['src/auth.js'], tier: 'MEDIUM' });
    assert.equal(ok.status, 'OK');
    assert.deepEqual(ok.obligations.items.map((o) => o.contract_id), ['AUTH-001'], 'solo el protegido aplicable (no el de otro archivo)');
    assert.equal(ok.obligations.verified_applicable, 1, 'el verificado se cuenta, no es obligación');
    assert.equal(ok.obligations.items[0].status, 'protected');

    // presupuesto justo: se omiten entradas del índice, JAMÁS la obligación
    const justo = layers.indice(p.root, { query: 'jwt', paths: ['src/auth.js'], tier: 'MEDIUM', budget_bytes: 2300, limit: 8 });
    assert.equal(justo.status, 'OK');
    assert.equal(justo.obligations.items.length, 1, 'la obligación llegó');
    assert.ok(justo.omitted.by_reason.presupuesto >= 1, 'y lo omitido se declara con su razón');
    assert.ok(justo.omitted.items.every((x) => x.reason === 'presupuesto' || x.reason === 'filtro_u_obsoleto'));

    // no cabe lo obligatorio: insuficiencia explícita, con lo que haría falta y la lista de contratos
    const no = layers.indice(p.root, { query: 'jwt', paths: ['src/auth.js'], budget_bytes: 300 });
    assert.equal(no.status, 'INSUFFICIENT_BUDGET');
    assert.equal(no.code, 'OBLIGATIONS_DO_NOT_FIT');
    assert.ok(no.needed_bytes > 300);
    assert.deepEqual(no.obligations.items.map((o) => o.contract_id), ['AUTH-001'], 'aunque no quepa el texto, el contrato se nombra');
    assert.equal(no.results, undefined, 'no se entrega un índice como si nada pasara');
    // un tope duro que puso quien llama nunca se amplía
    const duro = layers.indice(p.root, { query: 'jwt', paths: ['src/auth.js'], budget_bytes: 300, expand_reason: 'necesito ver el contrato completo' });
    assert.equal(duro.status, 'INSUFFICIENT_BUDGET');

    // ampliación JUSTIFICADA sobre el límite del tier: se entrega y queda registrada
    const dec = decision(p.root, 'T-O', 1200);
    assert.equal(dec.context_budget_bytes, 1200);
    const sin = layers.indice(p.root, { query: 'jwt', paths: ['src/auth.js'], task_id: 'T-O' });
    assert.equal(sin.status, 'INSUFFICIENT_BUDGET', 'con 1200 B no caben el contrato y el sobre');
    const corta = layers.indice(p.root, { query: 'jwt', paths: ['src/auth.js'], task_id: 'T-O', expand_reason: 'x' });
    assert.equal(corta.status, 'INSUFFICIENT_BUDGET', 'una justificación vacía no amplía nada');
    const amp = layers.indice(p.root, { query: 'jwt', paths: ['src/auth.js'], task_id: 'T-O', expand_reason: 'edito el middleware de login, debo ver el contrato' });
    assert.equal(amp.status, 'OK');
    assert.equal(amp.obligations.items.length, 1);
    assert.ok(amp.budget.expanded.extra_bytes > 0);
    assert.match(amp.budget.expanded.reason, /login/);
  } finally { p.limpiar(); }
});

test('sin embeddings ni FTS la búsqueda léxica funciona (sin acentos) y la lectura no modifica la base', () => {
  layers.limpiarCache();
  const p = proyecto('lexico');
  try {
    const antes = listaTablas(p);
    assert.ok(!antes.includes('nodos_fts'), 'punto de partida: no hay FTS');
    const hash = () => crypto.createHash('sha256').update(fs.readFileSync(p.dbPath)).digest('hex');
    const h0 = hash();
    const d = p.abrirR();
    try { assert.equal(d.get('SELECT count(*) AS n FROM nodos WHERE embedding IS NOT NULL').n, 0, 'no hay embeddings'); } finally { d.close(); }
    const r = layers.indice(p.root, { query: 'nandu' });
    assert.equal(r.status, 'OK');
    assert.equal(r.total, 3, 'ñandú se encuentra escribiendo nandu');
    assert.equal(r.search.semantic, false);
    assert.equal(r.search.fts, 'not_used');
    layers.detalle(p.root, [1]); layers.cronologia(p.root, { around: { node_id: '1' } }); layers.evidencia(p.root, 'ev_' + '0'.repeat(40));
    assert.deepEqual(listaTablas(p), antes, 'no se creó FTS ni ninguna tabla al consultar');
    assert.equal(hash(), h0, 'el archivo de la base quedó byte a byte igual');
    const n = layers.indice(p.root, { query: 'zzzzquenoexiste' });
    assert.equal(n.status, 'NO_RESULTS');
    assert.equal(n.total, 0);
    const corta = layers.indice(p.root, { query: 'ab' });
    assert.equal(corta.status, 'NO_RESULTS');
    assert.match(corta.note, /términos útiles/);
  } finally { p.limpiar(); }
});

test('sin tablas = SCHEMA_MISSING y no se migra; sin base = NO_DB y no se crea nada; son estados distintos de "sin resultados"', () => {
  const p = sinCatalogo('sin-tablas');
  try {
    const antes = listaTablas(p);
    const rs = [
      layers.indice(p.root, { query: 'REGLA' }),
      layers.detalle(p.root, ['1']),
      layers.cronologia(p.root, { around: { node_id: '1' } }),
      layers.evidencia(p.root, 'ev_' + 'a'.repeat(40)),
    ];
    for (const r of rs) assert.equal(r.status, 'SCHEMA_MISSING', JSON.stringify(r));
    assert.ok(rs[0].missing.includes('mem_events'));
    assert.match(rs[0].hint, /akdd update/);
    assert.deepEqual(listaTablas(p), antes, 'no aplicó ninguna migración');
    const c = cli(['index', '--query=REGLA'], p.root);
    assert.equal(c.status, 1);
    assert.equal(c.out.status, 'SCHEMA_MISSING');
  } finally { p.limpiar(); }

  const vacio = tmp('akdd-nodb-');
  try {
    const rs = [
      layers.indice(vacio, { query: 'x' }), layers.detalle(vacio, ['1']), layers.cronologia(vacio, { around: { node_id: '1' } }), layers.evidencia(vacio, 'ev_' + 'a'.repeat(40)),
    ];
    for (const r of rs) assert.equal(r.status, 'NO_DB', JSON.stringify(r));
    assert.ok(!fs.existsSync(path.join(vacio, '.agentic')), 'consultar no crea nada');
    assert.equal(cli(['index', '--query=x'], vacio).out.status, 'NO_DB');
  } finally { fs.rmSync(vacio, { recursive: true, force: true }); }

  // una base ilegible es ERROR (no NO_DB, no "sin resultados")
  const roto = tmp('akdd-roto-');
  try {
    fs.mkdirSync(path.join(roto, '.agentic'));
    fs.writeFileSync(path.join(roto, '.agentic', 'memoria.db'), 'esto no es sqlite, es texto plano '.repeat(50));
    for (const r of [layers.indice(roto, { query: 'x' }), layers.detalle(roto, ['1']), layers.cronologia(roto, { task_id: 't' }), layers.evidencia(roto, 'ev_' + 'a'.repeat(40))]) {
      assert.equal(r.status, 'ERROR', JSON.stringify(r)); assert.equal(r.code, 'DB_UNREADABLE');
    }
  } finally { fs.rmSync(roto, { recursive: true, force: true }); }

  const u = cli(['bogus'], os.tmpdir());
  assert.equal(u.status, 2);
  assert.equal(u.out.code, 'USAGE');
});

test('IDs INTEGER y TEXT: índice, detalle y estado coinciden con memory-core.estadoDe', () => {
  layers.limpiarCache();
  const p = proyecto('ids-texto');
  try {
    const d = p.abrirW();
    try {
      d.exec('DROP TABLE nodos');
      d.exec("CREATE TABLE nodos (id TEXT PRIMARY KEY, tipo TEXT NOT NULL, titulo TEXT NOT NULL, contenido TEXT, area TEXT DEFAULT 'global', confianza TEXT DEFAULT 'BAJA', aplicado INTEGER DEFAULT 0, util INTEGER DEFAULT 0, estado TEXT DEFAULT 'ACTIVO', fecha_creacion TEXT, fecha_update TEXT, archivos_aplica TEXT, vigencia_tipo TEXT)");
      d.run("INSERT INTO nodos (id, tipo, titulo, contenido, area, vigencia_tipo, fecha_update) VALUES ('regla_auth_01','patron','Regla de autenticación','Validar jwt siempre','auth','VIGENTE','2026-01-01')");
      d.run("INSERT INTO nodos (id, tipo, titulo, contenido, area, vigencia_tipo, fecha_update) VALUES ('regla_pago_02','patron','Regla de pagos','Redondear importes','pagos','SOSPECHOSO','2026-01-02')");
    } finally { d.close(); }
    const r = layers.indice(p.root, { query: 'jwt' });
    assert.equal(r.status, 'OK');
    assert.equal(r.results[0].id, 'regla_auth_01', 'el id TEXT sale como texto');
    const det = layers.detalle(p.root, ['regla_auth_01', 'regla_pago_02']);
    assert.equal(det.returned, 2);
    assert.equal(det.results.find((x) => x.id === 'regla_pago_02').knowledge_state, 'SUSPECT');
    const tl = layers.cronologia(p.root, { around: { node_id: 'regla_auth_01' } });
    assert.equal(tl.status, 'NO_RESULTS');
    assert.equal(tl.code, 'NODE_WITHOUT_EVENTS');
    assert.equal(tl.legacy, true, 'conocimiento anterior a la procedencia: se dice');
    const db = p.abrirR();
    try {
      for (const x of det.results) assert.equal(x.knowledge_state, core.estadoDe(db, x.id).state, 'mismo estado que el cálculo oficial');
    } finally { db.close(); }
  } finally { p.limpiar(); }

  const q = proyecto('ids-entero');
  try {
    const a = layers.detalle(q.root, [1]); const b = layers.detalle(q.root, ['1']);
    assert.equal(a.results[0].id, 1, 'el id INTEGER sale como número');
    assert.deepEqual(a.results[0].title, b.results[0].title, 'número o texto: el mismo nodo');
  } finally { q.limpiar(); }
});

test('estados de conocimiento: lo antiguo es LEGACY_UNVERIFIED_PROVENANCE sin reescribirse; propuesto, validado y obsoleto se distinguen', () => {
  layers.limpiarCache();
  const p = proyecto('estados');
  try {
    const s = sembrar(p, 'T-S');
    const contar = () => { const d = p.abrirR(); try { return [d.get('SELECT count(*) AS n FROM mem_knowledge').n, d.get('SELECT count(*) AS n FROM nodos').n]; } finally { d.close(); } };
    const antes = contar();
    const i = layers.indice(p.root, { query: 'memoria original regla', limit: 10 });
    const legado = i.results.filter((r) => r.provenance_kind === 'LEGACY_UNVERIFIED_PROVENANCE');
    assert.equal(legado.length, 3, 'los 3 nodos del esquema anterior salen etiquetados');
    assert.ok(legado.every((r) => r.legacy === true && r.knowledge_state === 'VALIDATED_LEGACY'));
    assert.deepEqual(contar(), antes, 'leer no reescribe nada ni los marca como validados');

    // validar con evidencia ACTUAL → VALIDATED / VERIFIED
    const v = core.validarConocimiento(p.root, s.k.node_id, { evidence_ids: [s.ev.evidence_id], validated_by: 'test' });
    assert.equal(v.ok, true, JSON.stringify(v));
    const dv = layers.detalle(p.root, [s.k.node_id]).results[0];
    assert.equal(dv.knowledge_state, 'VALIDATED');
    assert.equal(dv.provenance_kind, 'VERIFIED');
    assert.equal(dv.validated_by, 'test');

    // obsoleto: no se entrega por defecto, ni su contenido
    const nuevo = core.proponerConocimiento(p.root, { titulo: 'Regla nueva', contenido: 'sustituye a la antigua regla cero', area: 'auth' });
    const rr = core.reemplaza(p.root, nuevo.node_id, '1');
    assert.equal(rr.ok, true);
    const oculto = layers.indice(p.root, { query: 'REGLA_0', limit: 10 });
    assert.ok(!oculto.results.some((r) => String(r.id) === '1'), 'el obsoleto no se entrega');
    assert.ok(oculto.omitted.by_reason.obsoleto >= 1, 'y se dice que se omitió por obsoleto');
    const visible = layers.indice(p.root, { query: 'REGLA_0', include_obsolete: true });
    assert.equal(visible.results.find((r) => String(r.id) === '1').knowledge_state, 'OBSOLETE');
    const dOculto = layers.detalle(p.root, [1]).results[0];
    assert.equal(dOculto.status, 'OBSOLETE');
    assert.equal(dOculto.content, undefined, 'el contenido obsoleto no se entrega sin include_obsolete');
    assert.ok(layers.detalle(p.root, [1], { include_obsolete: true }).results[0].content.includes('Memoria original 0'));
    // el filtro por estado
    const soloPropuestos = layers.indice(p.root, { query: 'regla', state: ['PROPOSED'] });
    assert.ok(soloPropuestos.results.every((r) => r.knowledge_state === 'PROPOSED'));
  } finally { p.limpiar(); }
});

test('dos proyectos con el mismo nombre de carpeta no se mezclan; una copia de la base se rechaza', () => {
  layers.limpiarCache();
  const base1 = tmp('akdd-a-'); const base2 = tmp('akdd-b-'); const base3 = tmp('akdd-c-');
  const iniciar = (root, titulo, canario) => {
    fs.mkdirSync(path.join(root, '.agentic'), { recursive: true });
    const dbPath = path.join(root, '.agentic', 'memoria.db');
    dba.initialize(dbPath, SCHEMA);
    const db = dba.openWrite(dbPath, { updateOwner: true });
    try { catalogo.apply(db, { version: '3.20.1', actor: 'test' }); db.run("INSERT INTO nodos (tipo, titulo, contenido, area, confianza, estado, vigencia_tipo) VALUES ('patron', ?, ?, 'x', 'ALTA', 'ACTIVO', 'VIGENTE')", titulo, 'regla secreta ' + canario); } finally { db.close(); }
    assert.equal(core.capturar(root, { session_id: 's', host: 'h', event_type: 'tool', host_event_id: '1', task_id: 'T' }).ok, true);
    return dbPath;
  };
  try {
    const A = path.join(base1, 'cliente'); const B = path.join(base2, 'cliente'); const C = path.join(base3, 'cliente');
    const dbA = iniciar(A, 'Regla secreta alfa', 'CANARIO_ALFA'); iniciar(B, 'Regla secreta beta', 'CANARIO_BETA');
    assert.notEqual(core.identidad(A).project_id, core.identidad(B).project_id, 'project_id distinto aunque la carpeta se llame igual');
    const q = { query: 'regla secreta', session_id: 'MISMA' };
    const ra = layers.indice(A, q); const rb = layers.indice(B, q);
    assert.equal(ra.cache, 'miss'); assert.equal(rb.cache, 'miss', 'B no recicla la caché de A');
    assert.deepEqual(ra.results.map((r) => r.title), ['Regla secreta alfa']);
    assert.deepEqual(rb.results.map((r) => r.title), ['Regla secreta beta']);
    assert.ok(!JSON.stringify(rb).includes('ALFA') && !JSON.stringify(ra).includes('BETA'));
    assert.equal(layers.indice(A, q).cache, 'hit'); assert.equal(layers.indice(B, q).cache, 'hit');
    assert.deepEqual(layers.indice(B, q).results.map((r) => r.title), ['Regla secreta beta'], 'sigue aislada tras el acierto de caché');
    // copia de A en otra ruta: la memoria dice que es de otra ruta → no se sirve ni se mezcla
    fs.mkdirSync(path.join(C, '.agentic'), { recursive: true });
    fs.copyFileSync(dbA, path.join(C, '.agentic', 'memoria.db'));
    for (const r of [layers.indice(C, q), layers.detalle(C, ['1']), layers.cronologia(C, { task_id: 'T' })]) {
      assert.equal(r.status, 'ERROR');
      assert.equal(r.code, 'PROJECT_ROOT_MISMATCH');
    }
  } finally { for (const b of [base1, base2, base3]) fs.rmSync(b, { recursive: true, force: true }); }
});

test('XSS / HTML en título, contenido y resúmenes llega como TEXTO PLANO sin interpretarse ni escaparse a medias', () => {
  layers.limpiarCache();
  const p = proyecto('xss');
  try {
    const titulo = '<img src=x onerror=alert(1)>';
    const contenido = '<script>alert("x")</script> comilla\' y <b>negrita</b> onerror alert';
    const id = insNodo(p, { titulo, contenido });
    core.capturar(p.root, { session_id: 's', host: 'h', event_type: 'tool', task_id: 'T-X', host_event_id: 'x1', input: '<svg onload=alert(1)>', output: '<b>hecho</b>' });
    const r = layers.indice(p.root, { query: 'onerror alert' });
    const e = r.results.find((x) => x.id === id);
    assert.equal(e.title, titulo, 'el título es el texto, byte a byte');
    assert.equal(typeof e.title, 'string');
    assert.equal(r.content_format, 'plain_text');
    assert.equal(r.untrusted_content, true);
    const d = layers.detalle(p.root, [id]).results[0];
    assert.equal(d.content, contenido);
    const t = layers.cronologia(p.root, { task_id: 'T-X' });
    assert.equal(t.events[0].input_summary, '<svg onload=alert(1)>');
    assert.equal(JSON.parse(JSON.stringify(t)).events[0].output_summary, '<b>hecho</b>', 'sobrevive un viaje por JSON');
    assert.equal(t.content_format, 'plain_text');
  } finally { p.limpiar(); }
});

test('privacidad: un evento privado no se filtra por ninguna capa; los secretos salen tapados', () => {
  layers.limpiarCache();
  const p = proyecto('privado');
  try {
    const s = sembrar(p, 'T-P');
    const pid = core.identidad(p.root).project_id;
    const CANARIO = 'CANARIO_PRIVADO_9f3a';
    const privId = 'evt_privado_0000000000000000000000aa';
    const d = p.abrirW();
    try {
      d.run(`INSERT INTO mem_events (event_id, schema_version, project_id, canonical_project_root, session_id, task_id, host, host_event_id, event_type, sequence, occurred_at, received_at, status, paths, input_summary, output_summary, evidence_refs, redaction_version, privacy_class, attempts)
             VALUES (?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`, privId, pid, core.canonicalRoot(p.root), 's1', 'T-P', 'cursor', 'priv1', 'tool', 99, '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z', 'CAPTURED', '["src/auth.js"]', CANARIO + ' entrada', CANARIO + ' salida', '[]', 'r1', 'private');
      d.run("INSERT INTO mem_provenance (project_id, node_id, relation, observation_id, event_id, evidence_id, related_node_id, note, created_at) VALUES (?,?,?,?,?,'','',?,?)", pid, s.k.node_id, 'originated', '', privId, CANARIO + ' nota', '2026-10-03T00:00:00.000Z');
    } finally { d.close(); }
    // un evento a una ruta denegada: la captura real lo suprime
    assert.equal(core.capturar(p.root, { session_id: 's1', host: 'cursor', event_type: 'tool', task_id: 'T-P', host_event_id: 'env1', paths: ['.env'], input: CANARIO, output: CANARIO }).ok, true);
    core.capturar(p.root, { session_id: 's1', host: 'cursor', event_type: 'tool', task_id: 'T-P', host_event_id: 'sec1', input: 'password=hunter2canario', output: dec('QXV0aG9yaXphdGlvbjogQmVhcmVyIGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6MDEyMw==') });
    insNodo(p, { titulo: 'Regla con secreto', contenido: dec('dXNhIHRva2VuPXNrLUFCQ0RFRkdISUpLTE1OT1BRUlNUVVYxMjMgZW4gZWwgY2xpZW50ZQ==') });

    const salidas = [
      layers.indice(p.root, { query: 'jwt secreto regla', task_id: 'T-P', tier: 'HIGH' }),
      layers.detalle(p.root, [s.k.node_id, 5], { task_id: 'T-P', tier: 'HIGH' }),
      layers.cronologia(p.root, { around: { node_id: s.k.node_id }, task_id: 'T-P', tier: 'HIGH' }),
      layers.cronologia(p.root, { task_id: 'T-P', tier: 'HIGH', limit: 50 }),
      layers.cronologia(p.root, { around: { event_id: privId }, tier: 'HIGH' }),
    ];
    const todo = JSON.stringify(salidas);
    for (const prohibido of [CANARIO, privId, 'hunter2canario', 'abcdefghijklmnopqrstuvwxyz0123', dec('c2stQUJDREVGR0hJSktMTU5PUFFSU1RVVjEyMw==')]) assert.ok(!todo.includes(prohibido), 'se filtró: ' + prohibido);
    assert.equal(salidas[4].status, 'NO_RESULTS', 'preguntar por el evento privado es indistinguible de uno que no existe');
    assert.equal(salidas[4].code, 'ANCHOR_NOT_AVAILABLE');
    assert.ok(salidas[3].omitted.by_reason.privacidad >= 2, 'se cuenta que hubo eventos omitidos por privacidad (privado + suprimido)');
    assert.equal(salidas[1].results[0].provenance.withheld_private, 1);
    assert.deepEqual(salidas[0].results.find((r) => String(r.id) === s.k.node_id).provenance.events, 2, 'el evento privado no cuenta');
    assert.match(JSON.stringify(salidas[1].results[1]), /REDACTADO/, 'el secreto del contenido sale tapado');
  } finally { p.limpiar(); }
});

test('paginación por cursor: total conocido, sin duplicados, tier acota, cursor viejo o ajeno se rechaza', () => {
  layers.limpiarCache();
  const p = proyecto('paginas');
  try {
    for (let i = 0; i < 30; i++) insNodo(p, { titulo: 'paginacion ' + String(i).padStart(2, '0'), contenido: 'cuerpo paginacion ' + i, area: 'pag' });
    const vistos = []; let cursor; let paginas = 0; let primera;
    do {
      const r = layers.indice(p.root, { query: 'paginacion', tier: 'MEDIUM', cursor, limit: 10 });
      assert.equal(r.status, 'OK'); assert.equal(r.total, 30);
      if (!primera) primera = r;
      vistos.push(...r.results.map((x) => x.id)); cursor = r.next_cursor; paginas++;
      assert.ok(paginas <= 5);
    } while (cursor);
    assert.equal(paginas, 3);
    assert.equal(new Set(vistos).size, 30, 'sin duplicados ni huecos');
    assert.equal(primera.has_more, true);
    // orden determinista
    layers.limpiarCache();
    assert.deepEqual(layers.indice(p.root, { query: 'paginacion', tier: 'MEDIUM', limit: 10 }).results.map((x) => x.id), primera.results.map((x) => x.id));
    // el tier acota el tamaño de página aunque se pida más
    const low = layers.indice(p.root, { query: 'paginacion', tier: 'LOW', limit: 500 });
    assert.equal(low.limit, 10);
    assert.ok(low.returned <= 10 && low.has_more);
    // cursor ajeno, roto y viejo
    assert.equal(layers.indice(p.root, { query: 'otra cosa', tier: 'MEDIUM', cursor: primera.next_cursor }).code, 'INVALID_CURSOR');
    assert.equal(layers.indice(p.root, { query: 'paginacion', tier: 'MEDIUM', cursor: 'no-es-un-cursor' }).code, 'INVALID_CURSOR');
    insNodo(p, { titulo: 'paginacion nueva', contenido: 'cambia la memoria' });
    const viejo = layers.indice(p.root, { query: 'paginacion', tier: 'MEDIUM', cursor: primera.next_cursor });
    assert.equal(viejo.status, 'CURSOR_STALE', 'si la memoria cambió, no se pagina sobre contenido viejo');
  } finally { p.limpiar(); }
});

test('un primer resultado grande no impide entregar los demás; nada se corta por bytes; el contenido grande se pagina', () => {
  layers.limpiarCache();
  const p = proyecto('grande');
  try {
    const grande = insNodo(p, { titulo: 'Documento enorme', contenido: 'palabra importante '.repeat(1800) });
    const a = insNodo(p, { titulo: 'Nota pequeña A', contenido: 'corta' });
    const b = insNodo(p, { titulo: 'Nota pequeña B', contenido: 'corta también' });
    const r = layers.detalle(p.root, [grande, a, b], { tier: 'LOW' });
    assert.equal(r.status, 'OK');
    assert.deepEqual(r.results.map((x) => x.id).sort((x, y) => x - y), [a, b], 'las pequeñas llegan');
    assert.equal(r.omitted.by_reason.presupuesto, 1);
    assert.equal(r.omitted.items[0].id, grande);
    assert.ok(r.omitted.items[0].needed_bytes > 12000, 'se dice cuánto haría falta');
    for (const x of r.results) assert.ok(x.content === 'corta' || x.content === 'corta también', 'ninguna entrada llegó recortada');
    // solo el grande: insuficiencia explícita
    const solo = layers.detalle(p.root, [grande], { tier: 'LOW' });
    assert.equal(solo.status, 'INSUFFICIENT_BUDGET');
    assert.equal(solo.code, 'DETAIL_DOES_NOT_FIT');
    // paginarlo es explícito: rango y has_more
    const pag = layers.detalle(p.root, [grande], { tier: 'LOW', content_offset: 0, content_limit: 1000 });
    assert.equal(pag.status, 'OK');
    assert.equal(pag.results[0].content_range.total_chars, 'palabra importante '.length * 1800);
    assert.equal(pag.results[0].has_more_content, true);
    // una ampliación justificada tiene techo (+50 %): 18000 B no alcanza para 34 KB
    assert.equal(layers.detalle(p.root, [grande], { tier: 'LOW', expand_reason: 'necesito leerlo entero' }).status, 'INSUFFICIENT_BUDGET');
    // HIGH sí lo entrega completo
    const alto = layers.detalle(p.root, [grande], { tier: 'HIGH' });
    assert.equal(alto.status, 'OK');
    assert.equal(alto.results[0].content.length, 'palabra importante '.length * 1800);
  } finally { p.limpiar(); }
});

test('lote limitado por tier y entradas hostiles: no lanza, no se inyecta SQL, la raíz no se elige desde fuera', () => {
  layers.limpiarCache();
  const p = proyecto('hostil');
  const otro = proyecto('hostil-otro');
  try {
    insNodo(otro, { titulo: 'Solo en el otro proyecto', contenido: 'canario del otro' });
    const lote = layers.detalle(p.root, [1, 2, 3, 4, 5], { tier: 'LOW' });
    assert.equal(lote.batch_limit, 3);
    assert.equal(lote.returned, 3);
    assert.equal(lote.has_more, true);
    assert.equal(lote.omitted.by_reason.limite_lote, 2);
    assert.deepEqual(lote.next_ids, ['4', '5']);
    const nodosAntes = (() => { const d = p.abrirR(); try { return d.get('SELECT count(*) AS n FROM nodos').n; } finally { d.close(); } })();
    const inj = layers.detalle(p.root, ["1' OR '1'='1", '1; DROP TABLE nodos; --'], {});
    assert.equal(inj.status, 'NO_RESULTS');
    assert.ok(inj.results.every((r) => r.status === 'NOT_FOUND'));
    const q = layers.indice(p.root, { query: '\') OR 1=1 -- "; DROP TABLE nodos' });
    assert.ok(['OK', 'NO_RESULTS'].includes(q.status));
    assert.equal((() => { const d = p.abrirR(); try { return d.get('SELECT count(*) AS n FROM nodos').n; } finally { d.close(); } })(), nodosAntes);
    assert.equal(layers.indice(p.root, { query: 'x'.repeat(5000) }).code, 'INVALID_ARGS');
    assert.equal(layers.detalle(p.root, new Array(1000).fill(1)).code, 'INVALID_ARGS');
    assert.equal(layers.detalle(p.root, [{}, null, '']).code, 'INVALID_ARGS');
    assert.equal(layers.indice(p.root, { tier: 'ULTRA' }).code, 'INVALID_TIER');
    assert.equal(layers.indice(p.root, { task_id: '../../x' }).code, 'INVALID_TASK_ID');
    assert.equal(layers.indice(p.root, { paths: 'src' }).code, 'INVALID_ARGS');
    const rutas = layers.indice(p.root, { query: 'REGLA', paths: ['../../etc/passwd', '/etc/passwd', 'src/ok.js'] });
    assert.equal(rutas.paths_rejected, 2, 'las rutas que escapan de la raíz se descartan');
    assert.deepEqual(rutas.paths, ['src/ok.js']);
    // MCP
    assert.equal(mcp.handle('memory_index', { query: 'canario', root: otro.root }, p.root).total, 0, 'un argumento root no cambia de proyecto');
    assert.equal(mcp.handle('memory_index', ['x'], p.root).code, 'INVALID_ARGS');
    assert.doesNotThrow(() => mcp.handle('memory_index', null, p.root));
    assert.doesNotThrow(() => mcp.handle(undefined, undefined, undefined));
  } finally { p.limpiar(); otro.limpiar(); }
});

test('superficie MCP: solo se anuncia lo registrado, versionado; recall/remember no se tocan', () => {
  const esperadas = ['memory_index', 'memory_detail', 'memory_timeline', 'memory_evidence'];
  assert.deepEqual(mcp.TOOLS.map((t) => t.name), esperadas);
  assert.deepEqual([...mcp.CAPABILITIES.tools], esperadas, 'las capacidades salen de las herramientas con manejador');
  assert.equal(mcp.CAPABILITIES.contract_version, 'memory-layers/1');
  assert.equal(Object.isFrozen(mcp.CAPABILITIES), true);
  for (const t of mcp.TOOLS) {
    assert.equal(t.inputSchema.type, 'object');
    assert.match(t.description, /memory-layers\/1/);
    assert.ok(t.description.length > 40);
    for (const req of t.inputSchema.required) assert.ok(req in t.inputSchema.properties);
  }
  for (const noMia of ['recall', 'remember', 'memory_fantasma']) {
    const r = mcp.handle(noMia, {}, os.tmpdir());
    assert.equal(r.status, 'ERROR');
    assert.equal(r.code, 'UNKNOWN_TOOL', noMia + ' no es de este módulo ni se anuncia');
  }
  assert.equal(mcp.handle('constructor', {}, os.tmpdir()).code, 'UNKNOWN_TOOL', 'no se alcanza por la cadena de prototipos');
  const p = proyecto('capacidades');
  try {
    assert.equal(mcp.capabilities(p.root).availability.state, 'READY');
    assert.equal(mcp.capabilities(os.tmpdir()).availability.state, 'NO_DB');
  } finally { p.limpiar(); }
});

test('capa 4: páginas por bytes con cursor, por líneas, selector JSON; cambiada/ausente/desconocida/otro proyecto: estado explícito', () => {
  layers.limpiarCache();
  const p = proyecto('evidencia');
  const otro = proyecto('evidencia-otro');
  try {
    const lineas = Array.from({ length: 400 }, (_, i) => 'línea ' + String(i + 1).padStart(3, '0') + ' ñ ' + 'x'.repeat(30)).join('\n') + '\n';
    const g = store.guardar(p.root, { text: lineas }, { kind: 'tool_output' });
    let pos = 0; let junto = ''; let n = 0; let ultimo;
    do {
      ultimo = layers.evidencia(p.root, g.evidence_id, pos ? { cursor: { offset: pos } } : { length: 3000 }, { tier: 'HIGH' });
      assert.equal(ultimo.status, 'OK', JSON.stringify(ultimo).slice(0, 300));
      assert.equal(ultimo.sha256, g.sha256);
      junto += ultimo.content; pos = ultimo.next_cursor ? ultimo.next_cursor.offset : 0; n++;
      assert.ok(n < 100);
    } while (ultimo.has_more);
    assert.equal(junto, lineas, 'las páginas reconstruyen el original exacto (UTF-8 sin cortar a la mitad)');
    assert.equal(ultimo.total_bytes, Buffer.byteLength(lineas));
    const rango = layers.evidencia(p.root, g.evidence_id, { line_from: 10, line_to: 12 }, { tier: 'HIGH' });
    assert.equal(rango.content.split('\n').length, 3);
    assert.match(rango.content, /^línea 010/);
    assert.deepEqual(rango.next_cursor, { line_from: 13 });
    const sigue = layers.evidencia(p.root, g.evidence_id, { cursor: rango.next_cursor, line_to: 14 }, { tier: 'HIGH' });
    assert.match(sigue.content, /^línea 013/);

    const j = store.guardar(p.root, { text: JSON.stringify({ items: [{ a: 1, b: 'x' }, { a: 2, b: 'y' }, { a: 3, b: 'z' }] }) }, { kind: 'tool_output' });
    const sel = layers.evidencia(p.root, j.evidence_id, { json: { path: 'items[0:2]', fields: ['a'] } }, { tier: 'HIGH' });
    assert.equal(sel.status, 'OK');
    assert.deepEqual(JSON.parse(sel.content), [{ a: 1 }, { a: 2 }]);
    assert.equal(sel.complete, false, 'una selección no se presenta como el original');

    // estados explícitos
    assert.equal(layers.evidencia(p.root, 'ev_' + '0'.repeat(40), {}, {}).status, 'UNKNOWN_REFERENCE');
    assert.equal(layers.evidencia(p.root, 'no-es-una-referencia', {}, {}).status, 'UNKNOWN_REFERENCE');
    assert.equal(layers.evidencia(p.root, '', {}, {}).code, 'INVALID_ARGS');
    const guardadoEnP = layers.evidencia(otro.root, g.evidence_id, {}, {});
    assert.equal(guardadoEnP.status, 'UNKNOWN_REFERENCE', 'una referencia de otro proyecto no se resuelve');
    const objeto = store.rutaObjeto(p.root, g.sha256);
    fs.appendFileSync(objeto, 'manipulado');
    const cambiada = layers.evidencia(p.root, g.evidence_id, {}, {});
    assert.equal(cambiada.status, 'EVIDENCE_CHANGED');
    assert.equal(cambiada.content, undefined, 'si cambió no se entrega contenido');
    fs.unlinkSync(store.rutaObjeto(p.root, j.sha256));
    assert.equal(layers.evidencia(p.root, j.evidence_id, {}, {}).status, 'EVIDENCE_UNAVAILABLE');
  } finally { p.limpiar(); otro.limpiar(); }
});

test('capa 4: el presupuesto acota la página, registra lo recuperado y agotado da INSUFFICIENT_BUDGET; secretos de un archivo salen tapados', () => {
  layers.limpiarCache();
  const p = proyecto('evidencia-presupuesto');
  try {
    const g = store.guardar(p.root, { text: 'dato '.repeat(6000) }, { kind: 'tool_output', task_id: 'T-V' });
    decision(p.root, 'T-V', 1500);
    const r1 = layers.evidencia(p.root, g.evidence_id, {}, { task_id: 'T-V' });
    assert.equal(r1.status, 'OK');
    assert.equal(r1.has_more, true, 'no entrega más de lo que cabe');
    assert.ok(r1.budget.este_llamado <= 1500, 'cabe: ' + r1.budget.este_llamado);
    assert.ok(Buffer.byteLength(r1.content) > 0 && Buffer.byteLength(r1.content) < 1000);
    const u = usage.acumulado(p.root, 'T-V');
    assert.equal(u.by_kind.evidence_retrieval.recovered_bytes, r1.budget.este_llamado, 'lo recuperado cuenta en el acumulado');
    const r2 = layers.evidencia(p.root, g.evidence_id, { cursor: r1.next_cursor }, { task_id: 'T-V' });
    assert.equal(r2.budget.usado_acumulado, r1.budget.este_llamado);
    // consume el resto y la siguiente ya no cabe
    layers.evidencia(p.root, g.evidence_id, { cursor: r2.next_cursor || { offset: 0 } }, { task_id: 'T-V' });
    const sin = layers.evidencia(p.root, g.evidence_id, { cursor: { offset: 0 } }, { task_id: 'T-V' });
    assert.equal(sin.status, 'INSUFFICIENT_BUDGET');
    assert.equal(sin.code, 'EVIDENCE_PAGE_DOES_NOT_FIT');
    assert.equal(sin.sha256, g.sha256, 'sabe de qué evidencia se trata');
    // con tope duro del llamador
    assert.equal(layers.evidencia(p.root, g.evidence_id, {}, { tier: 'HIGH', budget_bytes: 200 }).status, 'INSUFFICIENT_BUDGET');

    // referencia a un archivo del proyecto con un secreto: el original es íntegro pero se entrega tapado
    fs.mkdirSync(path.join(p.root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(p.root, 'src', 'config.js'), dec('Y29uc3QgYXBpX2tleSA9ICJzay1BQkNERUZHSElKS0xNTk9QUVJTVFVWV1giOwpjb25zdCBvayA9IDE7Cg=='));
    const ref = store.guardarArchivo(p.root, 'src/config.js', { copy: false });
    assert.equal(ref.ok, true, JSON.stringify(ref));
    const v = layers.evidencia(p.root, ref.evidence_id, {}, { tier: 'HIGH' });
    assert.equal(v.status, 'OK');
    assert.ok(!v.content.includes(dec('c2stQUJDREVGR0hJSktMTU5PUFFSU1RVVldY')));
    assert.match(v.content, /REDACTADO/);
    assert.ok(v.redactions >= 1);
    assert.equal(v.sha256, ref.sha256, 'el hash es el del original');
  } finally { p.limpiar(); }
});

test('capa 3: ventana alrededor de un evento, cursores hacia ambos lados, orden por ocurrencia, filtro por tarea y sesión', () => {
  layers.limpiarCache();
  const p = proyecto('timeline');
  try {
    const t = (i) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
    const ids = [];
    for (let i = 0; i < 12; i++) {
      const r = core.capturar(p.root, { session_id: 'sA', host: 'cursor', event_type: 'tool', task_id: 'T-TL', host_event_id: 'e' + i, sequence: i, occurred_at: t(i), input: 'in ' + i, output: 'out ' + i });
      assert.equal(r.status, 'CAPTURED'); ids.push(r.event_id);
    }
    // llega TARDE pero ocurrió entre el 2 y el 3: se ordena por ocurrencia, no por llegada
    const tarde = core.capturar(p.root, { session_id: 'sA', host: 'cursor', event_type: 'tool', task_id: 'T-TL', host_event_id: 'tarde', sequence: 25, occurred_at: new Date(Date.UTC(2026, 0, 1, 0, 0, 2, 500)).toISOString(), input: 'tarde', output: 'tarde' });
    core.capturar(p.root, { session_id: 'sB', host: 'claude', event_type: 'tool', task_id: 'T-TL', host_event_id: 'b0', sequence: 0, occurred_at: t(5), input: 'otra sesión' });
    core.capturar(p.root, { session_id: 'sA', host: 'cursor', event_type: 'tool', task_id: 'T-OTRA', host_event_id: 'o0', sequence: 0, occurred_at: t(5), input: 'otra tarea' });
    core.capturar(p.root, { session_id: 'sA', host: 'cursor', event_type: 'tool', task_id: 'T-TL', host_event_id: 'env', paths: ['.env'], occurred_at: t(6), input: 'x' });

    const w = layers.cronologia(p.root, { around: { event_id: ids[6] }, task_id: 'T-TL', session_id: 'sA', limit: 5, tier: 'HIGH' });
    assert.equal(w.status, 'OK');
    assert.equal(w.mode, 'window');
    assert.equal(w.events.length, 5);
    assert.equal(w.events[2].event_id, ids[6], 'el ancla va en el centro');
    assert.equal(w.events[2].is_anchor, true);
    assert.deepEqual(w.events.map((e) => e.input_summary), ['in 4', 'in 5', 'in 6', 'in 7', 'in 8']);
    assert.equal(w.total, 13, 'solo la tarea y la sesión pedidas (12 + el tardío; sin la otra sesión, otra tarea ni el suprimido)');
    assert.equal(w.has_more_next, true); assert.equal(w.has_more_prev, true);
    assert.ok(w.omitted.by_reason.privacidad >= 1, 'el evento suprimido se cuenta como omitido por privacidad');
    // hacia delante
    const sig = layers.cronologia(p.root, { around: { event_id: ids[6] }, task_id: 'T-TL', session_id: 'sA', limit: 5, tier: 'HIGH', cursor: w.next_cursor });
    assert.deepEqual(sig.events.map((e) => e.input_summary), ['in 9', 'in 10', 'in 11']);
    assert.equal(sig.has_more_next, false);
    // hacia atrás: el evento tardío aparece en su sitio cronológico
    const atras = layers.cronologia(p.root, { around: { event_id: ids[6] }, task_id: 'T-TL', session_id: 'sA', limit: 20, tier: 'HIGH', cursor: w.prev_cursor });
    assert.deepEqual(atras.events.map((e) => e.input_summary), ['in 0', 'in 1', 'in 2', 'tarde', 'in 3']);
    assert.equal(atras.has_more_prev, false);
    // cursor de otro alcance
    assert.equal(layers.cronologia(p.root, { task_id: 'T-OTRA', cursor: w.next_cursor }).code, 'INVALID_CURSOR');
    assert.equal(layers.cronologia(p.root, {}).code, 'ANCHOR_REQUIRED');
    assert.equal(layers.cronologia(p.root, { around: { event_id: 'evt_inexistente' } }).code, 'ANCHOR_NOT_AVAILABLE');
    assert.equal(layers.cronologia(p.root, { around: { node_id: '99999' } }).code, 'ANCHOR_NOT_FOUND');
    assert.equal(layers.cronologia(p.root, { around: { event_id: ids[0], node_id: '1' } }).code, 'INVALID_ARGS');
    // por tarea sin ancla, desde el principio
    const porTarea = layers.cronologia(p.root, { task_id: 'T-TL', session_id: 'sA', limit: 3, tier: 'HIGH' });
    assert.deepEqual(porTarea.events.map((e) => e.input_summary), ['in 0', 'in 1', 'in 2']);
    assert.ok(porTarea.next_cursor);
    // sin actividad en ese rango: no es lo mismo que "sin base"
    assert.equal(layers.cronologia(p.root, { task_id: 'T-NADA' }).status, 'NO_RESULTS');
  } finally { p.limpiar(); }
});

test('capa 3: el presupuesto corta en un hueco contiguo y deja cursor; no cabe ni uno = INSUFFICIENT_BUDGET', () => {
  layers.limpiarCache();
  const p = proyecto('timeline-presupuesto');
  try {
    for (let i = 0; i < 10; i++) core.capturar(p.root, { session_id: 's', host: 'h', event_type: 'tool', task_id: 'T-TB', host_event_id: 'e' + i, sequence: i, occurred_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), input: 'entrada número ' + i, output: 'salida '.repeat(30) });
    decision(p.root, 'T-TB', 1500);
    const sin = layers.cronologia(p.root, { task_id: 'T-TB', limit: 10 });
    assert.equal(sin.status, 'INSUFFICIENT_BUDGET');
    assert.equal(sin.code, 'TIMELINE_DOES_NOT_FIT');
    assert.ok(sin.needed_bytes > 0);
    const amp = layers.cronologia(p.root, { task_id: 'T-TB', limit: 10, expand_reason: 'reconstruyo qué pasó antes del fallo' });
    assert.equal(amp.status, 'OK');
    assert.ok(amp.returned >= 1 && amp.returned < 10, 'entrega lo que cabe: ' + amp.returned);
    assert.ok(amp.omitted.by_reason.presupuesto >= 1);
    assert.equal(amp.has_more, true);
    assert.ok(amp.next_cursor, 'lo omitido sigue alcanzable por cursor');
    assert.ok(amp.budget.expanded.extra_bytes > 0);
    assert.deepEqual(amp.events.map((e) => e.sequence), amp.events.map((_, i) => i), 'contiguo desde el principio');
  } finally { p.limpiar(); }
});

test('relaciones: vecinos afectados solo desde MEDIUM; contradicciones y sustitución visibles en el índice', () => {
  layers.limpiarCache();
  const p = proyecto('vecinos');
  try {
    const a = insNodo(p, { titulo: 'Regla de sesiones', contenido: 'las sesiones caducan', archivos: ['src/sesion.js'] });
    const b = insNodo(p, { titulo: 'Otro tema distinto', contenido: 'nada que ver con la consulta', archivos: ['src/sesion.js'] });
    const c = insNodo(p, { titulo: 'Texto contrario', contenido: 'otra cosa sin las palabras', archivos: ['src/otro.js'] });
    const e0 = core.capturar(p.root, { session_id: 's', host: 'h', event_type: 'tool', host_event_id: '1' });
    core.proponerConocimiento(p.root, { titulo: 'Propuesta sesiones', contenido: 'las sesiones caducan a los 30 minutos', area: 'auth', event_ids: [e0.event_id] });
    assert.equal(core.contradice(p.root, String(a), String(c), { note: 'dicen lo contrario' }).ok, true);
    const low = layers.indice(p.root, { query: 'sesiones caducan', paths: ['src/sesion.js'], tier: 'LOW' });
    assert.equal(low.neighbors, 0, 'LOW no trae vecinos');
    assert.ok(!low.results.some((r) => r.id === b));
    const med = layers.indice(p.root, { query: 'sesiones caducan', paths: ['src/sesion.js'], tier: 'MEDIUM' });
    const vb = med.results.find((r) => r.id === b);
    assert.ok(vb, 'el nodo que toca el mismo archivo aparece como vecino');
    assert.equal(vb.neighbor.via, 'affected_path');
    const vc = med.results.find((r) => r.id === c);
    assert.ok(vc && /^related:contradicts/.test(vc.neighbor.via), 'lo que contradice a un resultado también');
    assert.deepEqual(med.results.find((r) => r.id === a).provenance.contradicts, [String(c)]);
    assert.ok(med.neighbors >= 2);
    // los vecinos también se pagan del presupuesto: nada entra sin coste
    assert.ok(med.results.every((r) => r.cost && r.cost.bytes > 0));
  } finally { p.limpiar(); }
});

test('CLI: opciones, estados y salida JSON; el código de salida distingue OK/NO_RESULTS de los fallos', () => {
  layers.limpiarCache();
  const p = proyecto('cli');
  try {
    sembrar(p, 'T-CLI');
    const ok = cli(['index', 'jwt', 'middleware', '--task=T-CLI', '--tier=LOW', '--paths=src/auth.js', '--limit=3'], p.root);
    assert.equal(ok.status, 0);
    assert.equal(ok.out.query, 'jwt middleware', 'una consulta sin comillas se une');
    assert.deepEqual(ok.out.paths, ['src/auth.js']);
    assert.equal(cli(['index', '--query=zzzzzzz'], p.root).status, 0, 'NO_RESULTS no es un fallo');
    assert.equal(cli(['index', '--query=jwt', '--tier=ULTRA'], p.root).status, 1);
    const sinCursor = cli(['detail', '--ids=1,2', '--tier=LOW'], p.root);
    assert.equal(sinCursor.out.returned, 2);
    const ev = cli(['evidence', 'ev_' + 'b'.repeat(40)], p.root);
    assert.equal(ev.status, 1);
    assert.equal(ev.out.status, 'UNKNOWN_REFERENCE');
    assert.equal(cli(['timeline'], p.root).out.code, 'ANCHOR_REQUIRED');
  } finally { p.limpiar(); }
});

test('payload enorme: se recupera por páginas dentro de los límites, conserva su referencia y no filtra el secreto del final', () => {
  layers.limpiarCache();
  const p = proyecto('enorme');
  try {
    const SECRETO = dec('c2stQUJDREVGR0hJSktMTU5PUFFSU1RVVldYMTIzNA==');
    const texto = ('relleno de salida de herramienta '.repeat(30) + '\n').repeat(2500) + 'api_key=' + SECRETO + '\n';
    const g = store.guardar(p.root, { text: texto }, { kind: 'tool_output', task_id: 'T-G' });
    assert.equal(g.ok, true, JSON.stringify(g));
    assert.ok(g.bytes > 2 * 1024 * 1024, 'más de 2 MB');
    const primera = layers.evidencia(p.root, g.evidence_id, {}, { tier: 'MEDIUM', task_id: 'T-G' });
    assert.equal(primera.status, 'OK');
    assert.ok(primera.budget.este_llamado <= primera.budget.limite_llamada, 'una página enorme nunca excede el tope');
    assert.equal(primera.has_more, true);
    assert.ok(primera.omitted.remaining_bytes > 2 * 1024 * 1024 - 100000);
    assert.equal(primera.sha256, g.sha256, 'la referencia conserva el hash del original');
    const cola = layers.evidencia(p.root, g.evidence_id, { offset: g.bytes - 200, length: 200 }, { tier: 'MEDIUM' });
    assert.equal(cola.status, 'OK');
    assert.match(cola.content, /api_key=\[REDACTADO\]/);
    assert.ok(!JSON.stringify(cola).includes(SECRETO));
    // el índice tampoco se hincha con un nodo gigante
    insNodo(p, { titulo: 'Nodo gigante', contenido: 'gigante '.repeat(200000) });
    const idx = layers.indice(p.root, { query: 'gigante', tier: 'LOW' });
    assert.equal(idx.status, 'OK');
    assert.ok(idx.budget.este_llamado < 3000, 'el resumen es corto aunque el contenido pese 1,6 MB');
    assert.equal(idx.results[0].summary_truncated, true);
  } finally { p.limpiar(); }
});
