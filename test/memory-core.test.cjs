'use strict';
// Canarios: valores FALSOS con formato de secreto, codificados para que el escáner de secretos del repo no los confunda con una filtración real.
const dec = (b) => Buffer.from(b, 'base64').toString('utf8');
/* C01 — Memoria trazable, validada y privada: actividad → observación → conocimiento → evidencia.
 * Mapa de aceptación del documento 01 (1–10) en los nombres de los tests. */
const test = require('node:test');
const { SIN_DRIVER } = require('./helpers/db-real.cjs');
if (SIN_DRIVER) { test(require('node:path').basename(__filename) + ' (omitido: ' + SIN_DRIVER + ')', { skip: SIN_DRIVER }, () => {}); return; }
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { proyecto, REPO } = require('./helpers/memoria-proyecto.cjs');
const G = path.join(REPO, '.agentic', 'grafo');
const core = require(path.join(G, 'memory-core.cjs'));
const store = require(path.join(G, 'evidence-store.cjs'));
const queue = require(path.join(G, 'memory-queue.cjs'));

const ev = (o = {}) => ({ host: 'cursor', session_id: 's1', host_event_id: 'h1', event_type: 'test_run', task_id: 'T1', input: 'npm test', output: 'ok', ...o });
const contar = (p, sql, ...a) => { const d = p.abrirR(); try { return Number(d.get(sql, ...a).n); } finally { d.close(); } };

test('C01-1: reenviar el MISMO evento deja una actividad y un job (cuenta intentos)', () => {
  const p = proyecto('c01-1');
  try {
    const a = core.capturar(p.root, ev());
    const b = core.capturar(p.root, ev({ output: 'otro texto: el contenido no es la clave' }));
    const c = core.capturar(p.root, ev());
    assert.equal(a.status, 'CAPTURED');
    assert.equal(b.status, 'DUPLICATE');
    assert.equal(c.attempts, 3);
    assert.equal(a.event_id, b.event_id);
    assert.equal(a.job_id, b.job_id);
    assert.equal(contar(p, 'SELECT count(*) AS n FROM mem_events'), 1);
    assert.equal(contar(p, 'SELECT count(*) AS n FROM mem_jobs'), 1);
    assert.equal(contar(p, 'SELECT attempts AS n FROM mem_events'), 3);
  } finally { p.limpiar(); }
});

test('C01-2: dos ejecuciones reales de payload IGUAL en momentos distintos son dos actividades', () => {
  const p = proyecto('c01-2');
  try {
    const a = core.capturar(p.root, ev({ host_event_id: 'h1', occurred_at: '2026-10-03T10:00:00Z' }));
    const b = core.capturar(p.root, ev({ host_event_id: 'h2', occurred_at: '2026-10-03T10:05:00Z' }));
    assert.notEqual(a.event_id, b.event_id);
    assert.equal(contar(p, 'SELECT count(*) AS n FROM mem_events'), 2);
    assert.equal(contar(p, 'SELECT count(*) AS n FROM mem_jobs'), 2);
  } finally { p.limpiar(); }
});

test('C01: sin host_event_id el adaptador pone una identidad durable con secuencia (no hora de llegada)', () => {
  const p = proyecto('c01-adapter');
  try {
    const ad = core.crearAdaptador(p.root, { host: 'claude-code', session_id: 'sx', capacidad: 'pipeline' });
    const r = [ad.registrar({ event_type: 'file_edit', paths: ['a.js'] }), ad.registrar({ event_type: 'file_edit', paths: ['b.js'] }), ad.registrar({ event_type: 'file_edit', paths: ['c.js'] })];
    assert.deepEqual(r.map((x) => x.sequence), [1, 2, 3]);
    const d = p.abrirR();
    try { assert.deepEqual(d.all('SELECT host_event_id FROM mem_events ORDER BY sequence').map((x) => x.host_event_id), ['adapter:1', 'adapter:2', 'adapter:3']); } finally { d.close(); }
  } finally { p.limpiar(); }
});

test('C01: eventos FUERA DE ORDEN conservan occurred_at/sequence del host (no se falsifica con la llegada)', () => {
  const p = proyecto('c01-orden');
  try {
    core.capturar(p.root, ev({ host_event_id: 'b', sequence: 2, occurred_at: '2026-10-03T10:00:02Z' }));
    core.capturar(p.root, ev({ host_event_id: 'a', sequence: 1, occurred_at: '2026-10-03T10:00:01Z' }));
    const d = p.abrirR();
    try {
      const filas = d.all('SELECT host_event_id, sequence, occurred_at, received_at FROM mem_events ORDER BY sequence');
      assert.deepEqual(filas.map((f) => f.host_event_id), ['a', 'b']);
      assert.equal(filas[0].occurred_at, '2026-10-03T10:00:01.000Z');
      assert.notEqual(filas[0].received_at, filas[0].occurred_at);
    } finally { d.close(); }
  } finally { p.limpiar(); }
});

test('C01-3: crear una observación NO valida ningún nodo ni cierra un gate', () => {
  const p = proyecto('c01-3');
  try {
    const e = core.capturar(p.root, ev());
    const o = core.observar(p.root, { event_ids: [e.event_id], kind: 'test_pass', summary: 'todo verde' });
    assert.ok(o.ok);
    const k = core.proponerConocimiento(p.root, { titulo: 'Regla nueva', contenido: 'Siempre validar el token', tipo: 'decision', area: 'auth', observation_ids: [o.observation_id], event_ids: [e.event_id] });
    assert.equal(k.state, 'PROPOSED');
    const d = p.abrirR();
    try { assert.equal(core.estadoDe(d, k.node_id).state, 'PROPOSED'); assert.equal(d.get('SELECT vigencia_tipo AS v FROM nodos WHERE CAST(id AS TEXT) = ?', k.node_id).v, 'SOSPECHOSO', 'se entrega "con verificación", no como regla firme'); } finally { d.close(); }
    // Validar sin evidencia, o con un validador que es el modelo/resumen, se rechaza.
    assert.equal(core.validarConocimiento(p.root, k.node_id, { validated_by: 'gate', evidence_ids: [] }).code, 'EVIDENCE_REQUIRED');
    assert.equal(core.validarConocimiento(p.root, k.node_id, { validated_by: 'model', evidence_ids: ['ev_' + 'a'.repeat(40)] }).code, 'VALIDATOR_NOT_ALLOWED');
    assert.equal(core.validarConocimiento(p.root, k.node_id, { validated_by: 'gate', evidence_ids: ['ev_' + 'a'.repeat(40)] }).code, 'EVIDENCE_NOT_CURRENT');
    const d2 = p.abrirR();
    try { assert.equal(core.estadoDe(d2, k.node_id).state, 'PROPOSED', 'nada lo validó'); } finally { d2.close(); }
  } finally { p.limpiar(); }
});

test('C01: con evidencia ACTUAL y un validador permitido sí se valida; si el código cambia pasa a SUSPECT', () => {
  const p = proyecto('c01-validar');
  try {
    fs.mkdirSync(path.join(p.root, 'src'));
    fs.writeFileSync(path.join(p.root, 'src', 'auth.js'), 'module.exports = 1;');
    const evid = store.guardar(p.root, { text: 'PASS 12/12 tests de auth' }, { kind: 'test_log', retention: 'durable_audit' });
    const k = core.proponerConocimiento(p.root, { titulo: 'Auth valida firma', contenido: 'El token se valida con la firma antes de leer claims', tipo: 'patron', area: 'auth', archivos: ['src/auth.js'], evidence_ids: [evid.evidence_id] });
    const v = core.validarConocimiento(p.root, k.node_id, { validated_by: 'test', evidence_ids: [evid.evidence_id], criterio: 'suite de auth en verde' });
    assert.ok(v.ok, JSON.stringify(v));
    let d = p.abrirR();
    try { const s = core.estadoDe(d, k.node_id); assert.equal(s.state, 'VALIDATED'); assert.equal(s.provenance, 'VERIFIED'); assert.equal(d.get('SELECT vigencia_tipo AS v FROM nodos WHERE CAST(id AS TEXT) = ?', k.node_id).v, 'VIGENTE'); } finally { d.close(); }
    const inv = core.invalidarPorArchivos(p.root, ['src/auth.js']);
    assert.deepEqual(inv.suspect, [k.node_id]);
    d = p.abrirR();
    try { const s = core.estadoDe(d, k.node_id); assert.equal(s.state, 'SUSPECT'); assert.ok(s.stale_since); } finally { d.close(); }
  } finally { p.limpiar(); }
});

test('C01: si la evidencia cambia o desaparece, validar deja de ser posible (no se valida con prueba vieja)', () => {
  const p = proyecto('c01-evid-cambia');
  try {
    fs.writeFileSync(path.join(p.root, 'log.txt'), 'v1');
    const e = store.guardarArchivo(p.root, 'log.txt', { copy: false, kind: 'test_log' });
    const k = core.proponerConocimiento(p.root, { titulo: 'X', contenido: 'regla X con evidencia', evidence_ids: [e.evidence_id] });
    fs.writeFileSync(path.join(p.root, 'log.txt'), 'v2 cambiado');
    const r = core.validarConocimiento(p.root, k.node_id, { validated_by: 'gate', evidence_ids: [e.evidence_id] });
    assert.equal(r.code, 'EVIDENCE_NOT_CURRENT');
    assert.equal(r.evidence_status, 'EVIDENCE_CHANGED');
    fs.rmSync(path.join(p.root, 'log.txt'));
    assert.equal(core.validarConocimiento(p.root, k.node_id, { validated_by: 'gate', evidence_ids: [e.evidence_id] }).evidence_status, 'EVIDENCE_UNAVAILABLE');
  } finally { p.limpiar(); }
});

test('C01: conocimiento idéntico y mismo ámbito suma ocurrencia; parecido crea candidato de revisión; nunca fusiona', () => {
  const p = proyecto('c01-dup');
  try {
    const a = core.proponerConocimiento(p.root, { titulo: 'Usar paginación', contenido: 'Toda lista del panel se pagina por cursor con límite máximo', tipo: 'patron', area: 'panel', scope: 'cliente-a', event_ids: ['evt_1'] });
    const b = core.proponerConocimiento(p.root, { titulo: 'Usar paginación', contenido: 'Toda lista del panel se pagina por cursor con límite máximo', tipo: 'patron', area: 'panel', scope: 'cliente-a', event_ids: ['evt_2'] });
    assert.equal(a.action, 'CREATED');
    assert.equal(b.action, 'OCCURRENCE');
    assert.equal(b.node_id, a.node_id);
    assert.equal(contar(p, "SELECT count(*) AS n FROM nodos WHERE titulo = 'Usar paginación'"), 1);
    assert.equal(contar(p, 'SELECT occurrences AS n FROM mem_knowledge WHERE node_id = ?', a.node_id), 2);
    // Mismo texto en OTRO ámbito (otro cliente): NO se mezcla.
    const otro = core.proponerConocimiento(p.root, { titulo: 'Usar paginación', contenido: 'Toda lista del panel se pagina por cursor con límite máximo', tipo: 'patron', area: 'panel', scope: 'cliente-b' });
    assert.equal(otro.action, 'CREATED');
    assert.notEqual(otro.node_id, a.node_id);
    // Parecido (no idéntico): nodo nuevo + candidato de revisión, sin fusión destructiva.
    const casi = core.proponerConocimiento(p.root, { titulo: 'Usar paginación', contenido: 'Toda lista del panel se pagina por cursor con límite máximo fijo', tipo: 'patron', area: 'panel', scope: 'cliente-c' });
    assert.equal(casi.action, 'CREATED');
    assert.ok(casi.review_candidates.length >= 1);
    assert.equal(casi.merged, false);
  } finally { p.limpiar(); }
});

test('C01-4: una contradicción conserva ambos orígenes sin fusionar ni cambiar estados', () => {
  const p = proyecto('c01-4');
  try {
    const a = core.proponerConocimiento(p.root, { titulo: 'Trial 14 días', contenido: 'El periodo de prueba es de 14 días', tipo: 'decision', area: 'planes', event_ids: ['evt_a'] });
    const b = core.proponerConocimiento(p.root, { titulo: 'Trial 7 días', contenido: 'El periodo de prueba es de 7 días', tipo: 'decision', area: 'planes', event_ids: ['evt_b'] });
    const c = core.contradice(p.root, a.node_id, b.node_id, { note: 'valores distintos' });
    assert.ok(c.ok);
    assert.equal(c.merged, false);
    const pa = core.procedencia(p.root, a.node_id);
    const pb = core.procedencia(p.root, b.node_id);
    assert.ok(pa.relations.some((r) => r.relation === 'contradicts' && r.related_node_id === b.node_id));
    assert.ok(pb.relations.some((r) => r.relation === 'contradicts' && r.related_node_id === a.node_id));
    assert.ok(pa.relations.some((r) => r.relation === 'originated' && r.event_id === 'evt_a'), 'su origen sigue ahí');
    assert.ok(pb.relations.some((r) => r.relation === 'originated' && r.event_id === 'evt_b'));
    assert.equal(pa.status.state, 'PROPOSED');
    assert.equal(pb.status.state, 'PROPOSED');
    assert.equal(contar(p, "SELECT count(*) AS n FROM nodos WHERE tipo = 'decision'"), 2);
  } finally { p.limpiar(); }
});

test('C01: reemplazar deja el anterior OBSOLETE (no se borra) y enlazado con supersedes', () => {
  const p = proyecto('c01-reemplaza');
  try {
    const a = core.proponerConocimiento(p.root, { titulo: 'Vieja regla', contenido: 'regla antigua del cobro', tipo: 'decision', area: 'cobros' });
    const b = core.proponerConocimiento(p.root, { titulo: 'Nueva regla', contenido: 'regla nueva del cobro con otro monto', tipo: 'decision', area: 'cobros' });
    assert.ok(core.reemplaza(p.root, b.node_id, a.node_id).ok);
    const d = p.abrirR();
    try {
      assert.equal(core.estadoDe(d, a.node_id).state, 'OBSOLETE');
      assert.equal(d.get('SELECT estado AS e FROM nodos WHERE CAST(id AS TEXT) = ?', a.node_id).e, 'OBSOLETO');
    } finally { d.close(); }
    assert.ok(core.procedencia(p.root, b.node_id).relations.some((r) => r.relation === 'supersedes' && r.related_node_id === a.node_id));
  } finally { p.limpiar(); }
});

test('C01-5: un reinicio (proceso nuevo) no pierde un evento confirmado', () => {
  const p = proyecto('c01-5');
  try {
    const script = 'const c=require(' + JSON.stringify(path.join(G, 'memory-core.cjs')) + ');const r=c.capturar(' + JSON.stringify(p.root) + ',{host:"cursor",session_id:"s9",host_event_id:"h9",event_type:"gate_result",output:"PASS"});process.stdout.write(JSON.stringify(r));process.exit(0);';
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
    assert.equal(r.status, 0, r.stderr);
    const confirmado = JSON.parse(r.stdout);
    assert.equal(confirmado.status, 'CAPTURED');
    // El proceso murió "sin cerrar": otro proceso lee el evento y su job.
    assert.equal(contar(p, 'SELECT count(*) AS n FROM mem_events WHERE event_id = ?', confirmado.event_id), 1);
    assert.equal(contar(p, "SELECT count(*) AS n FROM mem_jobs WHERE job_id = ? AND state = 'PENDING'", confirmado.job_id), 1);
    assert.equal(contar(p, 'SELECT count(*) AS n FROM mem_job_events WHERE event_id = ?', confirmado.event_id), 1, 'evento y job enlazados por la misma transacción');
  } finally { p.limpiar(); }
});

test('C01-6: un secreto canario no aparece en la base (ni en su WAL), ni en la cola, ni en las evidencias', () => {
  const p = proyecto('c01-6');
  try {
    const canarios = [dec('Z2hwX0NBTkFSSU9jYW5hcmlvQ0FOQVJJT2NhbmFyaW8xMjM0NTY='), 'hunter2-super-secreta-777', 'Zz9-canario-bearer-token-XYZ'];
    core.capturar(p.root, ev({ input: 'curl -H "Authorization: Bearer ' + canarios[2] + '" https://x', output: 'password=' + canarios[1] + ' token ' + canarios[0] }));
    core.capturar(p.root, ev({ host_event_id: 'h2', input: { api_key: canarios[0], nota: 'ok password=' + canarios[1] }, output: { headers: { Authorization: 'Bearer ' + canarios[2] } }, paths: ['src/a.js'] }));
    store.guardar(p.root, { text: 'log\npassword=' + canarios[1] + '\nBearer ' + canarios[2] + ' ' + canarios[0] }, { kind: 'tool_output' });
    core.proponerConocimiento(p.root, { titulo: 'Config', contenido: 'la clave es ' + canarios[0] + ' y password: ' + canarios[1], tipo: 'patron' });
    queue.procesarDeterminista(p.root, []);
    const buscar = [p.dbPath, p.dbPath + '-wal', p.dbPath + '-shm'];
    const rec = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) rec(f); else buscar.push(f); } };
    if (fs.existsSync(path.join(p.root, '.agentic', '_evidence'))) rec(path.join(p.root, '.agentic', '_evidence'));
    for (const f of buscar.filter((x) => fs.existsSync(x))) {
      const bytes = fs.readFileSync(f).toString('latin1');
      for (const c of canarios) assert.ok(!bytes.includes(c), 'el canario ' + c.slice(0, 8) + '… sobrevivió en ' + path.basename(f));
    }
  } finally { p.limpiar(); }
});

test('C01: una ruta privada (.env) deja la actividad como metadatos: sin payload, sin preview, sin job de proceso', () => {
  const p = proyecto('c01-privado');
  try {
    const r = core.capturar(p.root, ev({ event_type: 'file_read', paths: ['.env.production'], input: 'cat .env.production', output: 'DB_PASSWORD=zzzz1234' }));
    assert.equal(r.privacy_class, 'private');
    const d = p.abrirR();
    try {
      const f = d.get('SELECT * FROM mem_events WHERE event_id = ?', r.event_id);
      assert.equal(f.input_summary, null);
      assert.equal(f.output_summary, null);
      assert.equal(f.paths, '[]');
      assert.equal(f.status, 'SUPPRESSED');
      assert.equal(d.get('SELECT state FROM mem_jobs WHERE job_id = ?', r.job_id).state, 'SUPPRESSED');
    } finally { d.close(); }
  } finally { p.limpiar(); }
});

test('C01-9/10: sin tablas la captura NO migra en silencio: DEGRADED con la acción; nada cambia', () => {
  const p = proyecto('c01-sin-tablas', { catalogo: false, nodos: 0 });
  try {
    const antes = fs.readFileSync(p.dbPath);
    const r = core.capturar(p.root, ev());
    assert.equal(r.ok, false);
    assert.equal(r.status, 'DEGRADED');
    assert.equal(r.code, 'SCHEMA_MISSING');
    assert.match(r.message, /akdd update/);
    assert.ok(r.missing.includes('mem_events'));
    assert.deepEqual(fs.readFileSync(p.dbPath), antes, 'la base no se tocó');
    assert.equal(core.disponibilidad(p.root).state, 'SCHEMA_MISSING');
    assert.equal(core.identidad(p.root).state, 'SCHEMA_MISSING');
  } finally { p.limpiar(); }
});

test('C01: la captura nunca lanza ni bloquea: entradas vacías, hostiles o sin base devuelven un estado explícito', () => {
  const sinBase = require('node:fs').mkdtempSync(path.join(require('node:os').tmpdir(), 'akdd-sinbase-'));
  const p = proyecto('c01-robusta');
  try {
    assert.equal(core.capturar(p.root, undefined).status, 'REJECTED');
    assert.equal(core.capturar(p.root, {}).status, 'REJECTED');
    assert.equal(core.capturar(p.root, { host: 'x', session_id: 's', event_type: 't', sequence: 'no' }).status, 'REJECTED');
    assert.equal(core.capturar(p.root, { host: 'x', session_id: 's', event_type: 't', occurred_at: 'ayer' }).status, 'REJECTED');
    const hostil = { host: 'x', session_id: 's', event_type: 't', input: { get a() { throw new Error('boom'); } } };
    const r = core.capturar(p.root, hostil);
    // Un objeto hostil no se puede resumir ni clasificar: se registra solo como metadatos (unknown), jamás su contenido.
    assert.ok(r.ok === true ? r.privacy_class === 'unknown' : ['DEGRADED', 'REJECTED'].includes(r.status));
    if (r.ok) { const d = p.abrirR(); try { assert.equal(d.get('SELECT input_summary AS s FROM mem_events WHERE event_id = ?', r.event_id).s, '[REDACCION_FALLIDA]'); } finally { d.close(); } }
    const nb = core.capturar(sinBase, ev());
    assert.equal(nb.status, 'DEGRADED');
    assert.equal(nb.code, 'NO_DB');
    assert.equal(fs.existsSync(path.join(sinBase, '.agentic', 'memoria.db')), false, 'no crea la base');
  } finally { p.limpiar(); fs.rmSync(sinBase, { recursive: true, force: true }); }
});

test('C01: un payload enorme entra en límites: solo viaja el resumen acotado y queda marcado', () => {
  const p = proyecto('c01-grande');
  try {
    const r = core.capturar(p.root, ev({ output: dec('bMOtbmVhIGxhcmdhIGNvbiBnaHBfQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5Cg==').repeat(20000) }));
    assert.equal(r.status, 'CAPTURED');
    assert.equal(r.truncated, true);
    const d = p.abrirR();
    try {
      const f = d.get('SELECT output_summary FROM mem_events WHERE event_id = ?', r.event_id);
      assert.ok(f.output_summary.length <= core.LIMITES.summary_chars);
      assert.ok(!f.output_summary.includes('ghp_ABCDEFGH'));
    } finally { d.close(); }
  } finally { p.limpiar(); }
});

test('C01: backpressure explícito — con la cola llena el evento NO se registra y se dice; lo ya confirmado se conserva', () => {
  const p = proyecto('c01-bp');
  try {
    const a = core.capturar(p.root, ev({ host_event_id: 'a' }), { maxPending: 2 });
    const b = core.capturar(p.root, ev({ host_event_id: 'b' }), { maxPending: 2 });
    const c = core.capturar(p.root, ev({ host_event_id: 'c' }), { maxPending: 2 });
    assert.equal(a.status, 'CAPTURED');
    assert.equal(b.status, 'CAPTURED');
    assert.equal(c.status, 'BACKPRESSURE');
    assert.equal(c.ok, false);
    assert.equal(contar(p, 'SELECT count(*) AS n FROM mem_events'), 2, 'no se dijo "capturado" sin estarlo');
    // El reenvío de uno ya confirmado sigue siendo idempotente aun con la cola llena.
    assert.equal(core.capturar(p.root, ev({ host_event_id: 'a' }), { maxPending: 2 }).status, 'DUPLICATE');
  } finally { p.limpiar(); }
});

test('C01: project_id estable; una COPIA o un RENOMBRE se detectan y se resuelven de forma explícita', () => {
  const p = proyecto('c01-ident');
  const copia = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'akdd-copia-'));
  try {
    const r1 = core.capturar(p.root, ev());
    assert.ok(r1.ok);
    const id = core.identidad(p.root);
    assert.equal(id.state, 'OK');
    assert.match(id.project_id, /^prj_[a-f0-9]{32}$/);
    assert.equal(core.identidad(p.root).project_id, id.project_id, 'estable entre llamadas');

    // Copiar la carpeta a otra ruta: la memoria "pertenece" a la ruta original.
    fs.mkdirSync(path.join(copia, '.agentic'), { recursive: true });
    fs.copyFileSync(p.dbPath, path.join(copia, '.agentic', 'memoria.db'));
    const mm = core.identidad(copia);
    assert.equal(mm.state, 'ROOT_MISMATCH');
    const rechazo = core.capturar(copia, ev({ host_event_id: 'x' }));
    assert.equal(rechazo.status, 'REJECTED');
    assert.equal(rechazo.code, 'PROJECT_ROOT_MISMATCH');
    assert.equal(contar({ abrirR: () => require('./helpers/db-real.cjs').dba.openReadOnly(path.join(copia, '.agentic', 'memoria.db')) }, 'SELECT count(*) AS n FROM mem_events'), 1, 'no se mezclan eventos por tener el mismo nombre');

    // Es una copia: se bifurca (id nuevo, recuerda el anterior).
    const f = core.bifurcarIdentidad(copia);
    assert.ok(f.ok);
    assert.notEqual(f.project_id, id.project_id);
    assert.equal(f.previous_project_id, id.project_id);
    assert.equal(core.identidad(copia).state, 'OK');
    assert.equal(core.capturar(copia, ev({ host_event_id: 'y' })).status, 'CAPTURED');

    // Renombre del original: se adopta la nueva ruta conservando el id.
    assert.equal(core.adoptarRaiz(p.root).code, 'NADA_QUE_ADOPTAR');
  } finally { p.limpiar(); fs.rmSync(copia, { recursive: true, force: true }); }
});

test('C01-10: histórico con IDs INTEGER y TEXT — estado, procedencia y legado etiquetado sin reescribir', () => {
  for (const idTexto of [false, true]) {
    const p = proyecto('c01-ids-' + idTexto, { idTexto });
    try {
      const d = p.abrirR();
      let primero;
      try { primero = d.get('SELECT id FROM nodos ORDER BY rowid LIMIT 1').id; const s = core.estadoDe(d, primero); assert.equal(s.provenance, 'LEGACY_UNVERIFIED_PROVENANCE'); assert.equal(s.state, 'VALIDATED_LEGACY'); } finally { d.close(); }
      assert.equal(typeof primero, idTexto ? 'string' : 'number');
      const k = core.proponerConocimiento(p.root, { titulo: 'Nuevo ' + idTexto, contenido: 'conocimiento con procedencia nueva ' + idTexto, tipo: 'patron', area: 'x' });
      assert.ok(k.ok, JSON.stringify(k));
      assert.ok(core.procedencia(p.root, k.node_id).ok);
      const inv = core.inventario(p.root);
      assert.equal(inv.legacy_without_provenance, 3, 'los 3 antiguos siguen sin procedencia y recuperables; no se les inventa nada');
      assert.equal(contar(p, 'SELECT count(*) AS n FROM mem_knowledge'), 1, 'no se escribió procedencia para lo antiguo');
    } finally { p.limpiar(); }
  }
});

test('C01: inventario — un dato ausente es null, no 0 (tablas inexistentes)', () => {
  const p = proyecto('c01-inv', { catalogo: false, nodos: 0 });
  try {
    const inv = core.inventario(p.root);
    assert.equal(inv.schema_ready, false);
    assert.equal(inv.events, null);
    assert.equal(inv.observations, null);
    assert.equal(inv.jobs, null);
  } finally { p.limpiar(); }
});

test('C02: con un update EN CURSO la captura y el drenaje se degradan de forma explícita (sin perder ni bloquear) y funcionan al terminar', async () => {
  const guard = require(path.join(G, 'update-guard.cjs'));
  const p = proyecto('c02-update');
  try {
    const h = guard.acquire(p.root, { opId: 'update-en-curso', timeoutMs: 100 });
    const durante = core.capturar(p.root, ev({ host_event_id: 'durante' }));
    assert.equal(durante.ok, false);
    assert.equal(durante.status, 'DEGRADED');
    assert.equal(durante.code, 'UPDATE_IN_PROGRESS', 'el agente sabe por qué y puede reenviar');
    const dr = await queue.drenar(p.root, { owner: 'w' });
    assert.equal(dr.ok, false);
    assert.equal(dr.code, 'UPDATE_IN_PROGRESS');
    guard.release(h);
    const despues = core.capturar(p.root, ev({ host_event_id: 'durante' }));
    assert.equal(despues.status, 'CAPTURED', 'reenviado el mismo evento al terminar el update, se registra una vez');
  } finally { p.limpiar(); }
});
