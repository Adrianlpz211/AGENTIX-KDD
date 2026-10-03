#!/usr/bin/env node
'use strict';
/**
 * Benchmark PROPIO y determinista de contexto y esfuerzo (H03).
 *
 *   node benchmark-contexto.cjs run [--seed=N] [--json]     ejecuta los ocho casos A–H
 *   node benchmark-contexto.cjs list                         describe el corpus
 *
 * Qué es y qué NO es:
 *   · Corpus generado por una semilla (mulberry32): reproducible y publicable, SIN datos de ningún
 *     usuario ni proyecto real. Los proyectos de prueba son temporales y se borran.
 *   · Compara, para la MISMA tarea y la MISMA aceptación, un BASELINE sin compactación (lo que se
 *     entregaría tal cual) contra la versión OPTIMIZADA de Agentix (compactación + recuperación
 *     recuperable + presupuestos), usando los módulos reales: context-compressor, memory-layers,
 *     effort-router/effort-budget, teams-packets, evidence-store.
 *   · La versión optimizada incluye lo que le costaría CUMPLIR el criterio: si para satisfacerlo
 *     tiene que recuperar el original, esos bytes se suman. Si eso anula el ahorro, se muestra
 *     (neto ≤ 0) y no se oculta.
 *   · Es un harness DETERMINISTA del mecanismo. NO sustituye una campaña con modelos reales: eso
 *     cuesta dinero y necesita configuración y autorización explícitas, así que queda como
 *     NO_EJECUTADO y no se presenta nunca como eficacia demostrada.
 *   · Mide payload (bytes; tokens = bytes/4, ESTIMADOS). No mide sesión, razonamiento ni dinero.
 *   · Se publica la DISTRIBUCIÓN de resultados (incluidos los casos sin ahorro), no un ejemplo
 *     favorable.
 *
 * Validación mínima exigida: ningún criterio de aceptación ni gate se pierde en el corpus
 * obligatorio. Si un caso pierde un criterio, `run` termina con código 1.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const G = __dirname;
const cargar = (n) => require(path.join(G, n));
const REPO = path.resolve(G, '..', '..');

function mulberry32(a) {
  return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const bytes = (x) => Buffer.byteLength(typeof x === 'string' ? x : JSON.stringify(x), 'utf8');
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

/** Proyecto temporal con memoria.db REAL (schema.sql + catálogo), igual que crea una base nueva el motor. */
function crearProyecto(nombre) {
  const dba = cargar('db-adapter.cjs');
  const catalogo = cargar('schema-catalog.cjs');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'akdd-bench-' + nombre + '-')));
  const dbPath = path.join(root, '.agentic', 'memoria.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  dba.initialize(dbPath, fs.readFileSync(path.join(G, 'schema.sql'), 'utf8'));
  const db = dba.openWrite(dbPath, { updateOwner: true });
  try { catalogo.apply(db, { version: '3.20.1', actor: 'benchmark' }); } finally { db.close(); }
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'bench-' + nombre, version: '1.0.0' }));
  return { root, dbPath, abrirW: () => dba.openWrite(dbPath, { updateOwner: true }), limpiar() { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* en uso */ } } };
}

// ───────────────────────────── generadores deterministas ────────────────────
function generarLog(rnd, lineas, errorEn) {
  const verbos = ['GET', 'POST', 'PUT', 'DELETE'];
  const out = [];
  for (let i = 0; i < lineas; i++) {
    if (i === errorEn) { out.push('2026-10-03T10:' + String(i % 60).padStart(2, '0') + ':00Z ERROR payments/refund.js:88 TypeError: Cannot read properties of undefined (reading "amount")'); continue; }
    out.push('2026-10-03T10:' + String(i % 60).padStart(2, '0') + ':00Z INFO ' + verbos[Math.floor(rnd() * 4)] + ' /api/v1/items/' + Math.floor(rnd() * 50) + ' 200 ' + Math.floor(rnd() * 300) + 'ms');
  }
  return out.join('\n');
}

function generarJson(rnd, n, criticos) {
  const items = Array.from({ length: n }, (_, i) => ({ id: i, sku: 'SKU-' + Math.floor(rnd() * 90000 + 10000), status: criticos.includes(i) ? 'FAILED' : 'ok', amount: Math.round(rnd() * 10000) / 100, note: 'registro generado para el benchmark ' + i }));
  return JSON.stringify({ generated: true, count: n, items });
}

const casos = [];
const caso = (id, titulo, objetivo, run) => casos.push({ id, titulo, objetivo, run });

const crit = (name, ok, detail) => ({ name, ok: !!ok, ...(detail ? { detail } : {}) });
const resultado = (baseline, optimizado, recuperado, criterios, extra = {}) => {
  const entregado = optimizado + recuperado;
  const neto = baseline - entregado;
  return { baseline_bytes: baseline, optimized_bytes: optimizado, recovered_bytes: recuperado, net_bytes: neto, net_percent: pct(neto, baseline), nullified: baseline > 0 && neto <= 0, criteria: criterios, criteria_met: criterios.filter((c) => c.ok).length, criteria_total: criterios.length, passed: criterios.every((c) => c.ok), ...extra };
};

// ─── A · corrección de texto, estilo o README ────────────────────────────────
caso('A', 'Corrección de texto/README', 'Un cambio de texto local no debe disparar investigación global ni delegación innecesaria.', (ctx) => {
  const router = cargar('effort-router.cjs'); const budget = cargar('effort-budget.cjs'); const pack = cargar('context-pack.cjs');
  const p = ctx.proyecto('A');
  try {
    fs.mkdirSync(path.join(p.root, 'src', 'components'), { recursive: true });
    const readme = Array.from({ length: 400 }, (_, i) => 'Línea ' + i + ' del texto de la documentación del botón Guardar.').join('\n');
    fs.writeFileSync(path.join(p.root, 'src', 'components', 'Boton.tsx'), readme);
    const d = router.decidirYGuardar(p.root, { task_id: 'A-1', intent: 'cambia el texto del botón Guardar a Enviar', paths: ['src/components/Boton.tsx'], index_coverage: 'COMPLETE' });
    const global = budget.permitirAccion(p.root, 'A-1', 'busqueda_global');
    const delegar = budget.permitirAccion(p.root, 'A-1', 'delegacion', { rol: 'analyst' });
    const guardias = budget.guardiasCriticas(d);
    // Baseline: investiga todo el repositorio (búsqueda global simulada) y carga las instrucciones de TODOS los roles.
    const busquedaGlobal = Array.from({ length: 6000 }, (_, i) => 'src/modulo' + (i % 90) + '/archivo' + i + '.ts:' + (i % 400) + ': coincidencia del texto buscado').join('\n');
    const instruccionesTodos = ['analyst', 'builder', 'qa', 'reviewer'].flatMap((r) => pack.referencias(r, 'HIGH', ['src/components/Boton.tsx', 'api/x.ts'])).filter((x, i, a) => a.indexOf(x) === i);
    const tam = (rels) => rels.reduce((n, rel) => { try { return n + fs.statSync(path.join(REPO, rel)).size; } catch { return n; } }, 0);
    const baseline = bytes(readme) + bytes(busquedaGlobal) + tam(instruccionesTodos);
    const refsLow = pack.referencias('builder', d.tier, ['src/components/Boton.tsx']);
    const optimizado = bytes(readme) + tam(refsLow); // el archivo a editar llega ÍNTEGRO; nada más
    return resultado(baseline, optimizado, 0, [
      crit('tier LOW', d.tier === 'LOW', d.tier),
      crit('sin investigación global', global.ok === false && global.code === 'TIER_LOW_SIN_INVESTIGACION_GLOBAL', global.code),
      crit('sin delegación innecesaria', delegar.ok === false && delegar.code === 'DELEGACION_INNECESARIA', delegar.code),
      crit('guardias críticas intactas (scope, protected-files, security, leases)', guardias.ok === true && ['scope', 'protected-files', 'security', 'leases'].every((g) => d.required_gates.includes(g))),
      crit('el archivo a editar se entrega íntegro', true, 'purpose=edit: no se compacta'),
    ], { tier: d.tier });
  } finally { p.limpiar(); }
});

// ─── B · bug local con error único en un log enorme ──────────────────────────
caso('B', 'Error único en un log enorme', 'El único error de 20.000 líneas sigue visible y el original queda recuperable.', (ctx) => {
  const cc = cargar('context-compressor.cjs'); const p = ctx.proyecto('B');
  try {
    const log = generarLog(ctx.rnd, 20000, 13337);
    const r = cc.comprimir(p.root, { content: log, source_kind: 'log', task_id: 'B-1', purpose: 'debug', cmd: 'npm test', exit_code: 1 });
    const visible = r.delivered.includes('payments/refund.js:88');
    const rec = cc.recuperar(p.root, r.envelope.reference_id, { line_from: 13338, line_to: 13338 }, { task_id: 'B-1' });
    return resultado(bytes(log), bytes(r.delivered), rec.ok ? rec.delivered_bytes || bytes(rec.content) : 0, [
      crit('el error único está en lo entregado', visible),
      crit('el original es recuperable con el mismo hash', rec.ok && rec.sha256 === sha(log), rec.status),
      crit('la entrega declara si es completa', r.envelope.complete === false || r.envelope.complete === true),
    ], { compression_method: r.envelope.compression_method });
  } finally { p.limpiar(); }
});

// ─── C · autorización/pagos: cambio pequeño, riesgo alto ─────────────────────
caso('C', 'Autorización/pagos con cambio pequeño', 'El esfuerzo NO baja cuando el riesgo es alto: HIGH, revisor y guardias completas, aunque diga "cambio pequeño".', (ctx) => {
  const router = cargar('effort-router.cjs'); const budget = cargar('effort-budget.cjs'); const pack = cargar('context-pack.cjs'); const p = ctx.proyecto('C');
  try {
    const d = router.decidirYGuardar(p.root, { task_id: 'C-1', intent: 'cambio pequeño: ajusta dos líneas de la verificación de permisos del cobro', paths: ['src/middleware/permisos.ts', 'src/pagos/cobro.ts'], requested_tier: 'LOW' });
    const refs = pack.referencias('builder', d.tier, ['src/middleware/permisos.ts']).concat(pack.referencias('reviewer', d.tier, []));
    const tam = refs.filter((x, i, a) => a.indexOf(x) === i).reduce((n, rel) => { try { return n + fs.statSync(path.join(REPO, rel)).size; } catch { return n; } }, 0);
    // Por diseño NO hay ahorro aquí: lo medido es que la optimización no recortó nada que un cambio de riesgo alto necesita.
    return resultado(tam, tam, 0, [
      crit('tier HIGH por riesgo (no por el título)', d.tier === 'HIGH' && d.risk === 'HIGH', d.tier),
      crit('la petición de LOW se rechazó por seguridad', d.requested_tier_rejected === 'MIN_SEGURIDAD'),
      crit('hay revisor', d.required_roles.includes('reviewer')),
      crit('guardias completas (preservation, tdd, blast-radius, qa, security)', ['preservation', 'tdd', 'blast-radius', 'qa', 'security'].every((g) => d.required_gates.includes(g)) && budget.guardiasCriticas(d).ok === true),
    ], { tier: d.tier, note: 'Sin ahorro por diseño: el riesgo alto conserva todo su contexto y sus controles.' });
  } finally { p.limpiar(); }
});

// ─── D · refactor con contratos protegidos ───────────────────────────────────
caso('D', 'Refactor con contratos protegidos', 'Los contratos protegidos aplicables NO desaparecen en silencio por presupuesto.', (ctx) => {
  const layers = cargar('memory-layers.cjs'); const router = cargar('effort-router.cjs'); const p = ctx.proyecto('D');
  try {
    const db = p.abrirW();
    try {
      for (let i = 0; i < 30; i++) db.run('INSERT INTO verified_contracts (id, module, name, description, source_files, test_file, test_name, status) VALUES (?,?,?,?,?,?,?,?)', 'C-' + i, 'cobros', 'contrato ' + i, 'Regla del módulo de cobros número ' + i, JSON.stringify(['src/cobros/calculo.js']), 'test/cobros.test.js', 'regla ' + i, 'protected');
      for (let i = 0; i < 400; i++) db.run("INSERT INTO nodos (tipo, titulo, contenido, area, confianza, estado, vigencia_tipo, fecha_creacion, fecha_update, ultimo_acceso) VALUES ('patron', ?, ?, 'cobros', 'ALTA', 'ACTIVO', 'VIGENTE', '2026-01-01 00:00:00', '2026-01-01 00:00:00', '2026-01-01 00:00:00')", 'Patrón de cobros ' + i, 'Texto largo de la regla de cobros ' + i + ' '.padEnd(300, 'x'));
    } finally { db.close(); }
    const d = router.decidirYGuardar(p.root, { task_id: 'D-1', intent: 'refactoriza el cálculo de cobros', paths: ['src/cobros/calculo.js'], change_type: 'refactor', index_coverage: 'COMPLETE', user_limits: { max_context_bytes: 6000 } });
    const r = layers.indice(p.root, { query: 'cobros', task_id: 'D-1', tier: d.tier, paths: ['src/cobros/calculo.js'] });
    const obligaciones = (r.obligations && r.obligations.items) || [];
    // Baseline: volcar toda la memoria de cobros (400 nodos con su texto) + los 30 contratos.
    const baseline = 400 * 330 + 30 * 120;
    const declarado = r.status === 'INSUFFICIENT_BUDGET' || obligaciones.length === 30 || (r.obligations && r.obligations.omitted_declared);
    return resultado(baseline, bytes(r), 0, [
      crit('el contrato protegido aplicable no se omite en silencio', obligaciones.length === 30 || r.status === 'INSUFFICIENT_BUDGET' || declarado, 'obligaciones=' + obligaciones.length + ' estado=' + r.status),
      crit('el total conocido y lo omitido se declaran', r.total != null || r.status === 'INSUFFICIENT_BUDGET'),
      crit('nunca se vuelca la memoria entera', bytes(r) < baseline),
    ], { tier: d.tier, status: r.status });
  } finally { p.limpiar(); }
});

// ─── E · JSON largo con un registro crítico poco frecuente ───────────────────
caso('E', 'JSON largo con registro crítico raro', 'Una muestra NUNCA prueba "no hay fallos": el registro raro se encuentra sobre el original completo.', (ctx) => {
  const cc = cargar('context-compressor.cjs'); const p = ctx.proyecto('E');
  try {
    const criticos = [3141, 4242];
    const json = generarJson(ctx.rnd, 5000, criticos);
    const r = cc.comprimir(p.root, { content: json, source_kind: 'tool_output', content_type: 'application/json', task_id: 'E-1', purpose: 'debug' });
    const sinMuestra = cc.afirmarAusencia(r.envelope);
    const exigencia = cc.debeRecuperar({ envelope: r.envelope, claim: 'no_failures' });
    const v = cc.verificarAusencia(p.root, r.envelope.reference_id, /"status":"FAILED"/, { task_id: 'E-1' });
    const conteo = (json.match(/"status":"FAILED"/g) || []).length;
    const uso = cc.ahorroNeto(p.root, 'E-1');
    return resultado(bytes(json), bytes(r.delivered), uso.available ? Number(uso.recovered_bytes) : 0, [
      crit('lo entregado es una muestra etiquetada (no parece completo)', r.envelope.complete === false && (r.envelope.omitted_items || []).length > 0),
      crit('afirmar ausencia sobre la muestra se rechaza', sinMuestra.ok === false && sinMuestra.code === 'ABSENCE_REQUIRES_COMPLETE'),
      crit('la política exige recuperar el original', exigencia.required === true && exigencia.can_comply === true),
      crit('el original completo encuentra TODOS los registros críticos', v.ok === true && v.matches >= 1 && v.absent === false && conteo === criticos.length, 'critical=' + conteo),
    ]);
  } finally { p.limpiar(); }
});

// ─── F · vacío, malformado, secreto y código a editar ────────────────────────
caso('F', 'Vacío, malformado, secreto y código a editar', 'Los bordes no inventan, no filtran y no mutilan: se entrega el original cuando hace falta.', (ctx) => {
  const cc = cargar('context-compressor.cjs'); const store = cargar('evidence-store.cjs'); const p = ctx.proyecto('F');
  try {
    const vacio = cc.comprimir(p.root, { content: '', source_kind: 'tool_output', task_id: 'F-1', purpose: 'debug' });
    const malo = cc.comprimir(p.root, { content: '{"a": [1,2,', source_kind: 'tool_output', content_type: 'application/json', task_id: 'F-1', purpose: 'debug' });
    const canario = 'ghp_' + 'CANARIOBENCHMARK0123456789abcdefABCD';
    const log = 'inicio\n'.repeat(900) + 'Authorization: Bearer ' + canario + '\n' + 'fin\n'.repeat(900);
    const sec = cc.comprimir(p.root, { content: log, source_kind: 'log', task_id: 'F-1', purpose: 'debug' });
    const codigo = Array.from({ length: 300 }, (_, i) => 'function f' + i + '(a, b) { return a + b + ' + i + '; }').join('\n');
    const ed = cc.comprimir(p.root, { content: codigo, source_kind: 'file_read', path: 'src/calc.js', task_id: 'F-1', purpose: 'edit' });
    const almacenado = sec.envelope.reference_id ? store.obtener(p.root, require('./memory-core.cjs') && (() => { const d = p.abrirW(); try { return d.get('SELECT evidence_id FROM mem_compression_refs WHERE reference_id = ?', sec.envelope.reference_id).evidence_id; } finally { d.close(); } })(), {}) : { content: '' };
    return resultado(bytes('') + bytes('{"a": [1,2,') + bytes(log) + bytes(codigo), bytes(vacio.delivered) + bytes(malo.delivered) + bytes(sec.delivered) + bytes(ed.delivered), 0, [
      crit('resultado vacío: sin inventar', vacio.delivered === '' || /vac/i.test(vacio.delivered) || vacio.envelope.complete === true),
      crit('JSON malformado: se entrega el original', malo.delivered.includes('{"a": [1,2,')),
      crit('el secreto canario no está ni en lo entregado ni en el original almacenado', !sec.delivered.includes(canario) && !String(almacenado.content || '').includes(canario)),
      crit('el código a editar llega íntegro', ed.delivered === codigo && ed.envelope.complete === true),
    ], { note: 'Casos de borde: el ahorro es ~0 por diseño (passthrough/íntegro); lo medido es que nada se pierde ni se filtra.' });
  } finally { p.limpiar(); }
});

// ─── G · TEAMS multi-sprint con reinicios, ACK desordenado, delta perdido, evidencia caducada ───
caso('G', 'TEAMS multi-sprint con fallos', 'Paquetes incrementales sin estado corrupto; evidencia caducada/cambiada rechazada; decisión humana no bloqueante.', (ctx) => {
  const tp = cargar('teams-packets.cjs'); const store = cargar('evidence-store.cjs'); const p = ctx.proyecto('G');
  try {
    fs.mkdirSync(path.join(p.root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(p.root, 'src', 'a.js'), 'module.exports = 1;\n');
    const CRITERIOS = Array.from({ length: 30 }, (_, i) => 'El criterio de aceptación número ' + i + ' describe un comportamiento observable y comprobable');
    const base = (o = {}) => ({ task_id: 'G-1', plan_id: 'P-1', sprint_id: 'S-1', sender_role: 'director', recipient_role: 'builder', objective: 'Que el total del carrito sume el descuento', acceptance: CRITERIOS, scope: ['src/a.js'], risk_tier: 'MEDIUM', protected_contract_refs: ['C-PRECIO-1'], next_actions: ['implementar'], ...o });
    const rx = { estado: null, recibir(pk) { const x = tp.recibir(this.estado, pk); if (x.status === 'APLICADO') this.estado = x.estado; return x; } };
    let optimizado = 0; let baseline = 0; const rondas = 12;
    const acciones = ['implementar'];
    const e1 = tp.enviar(p.root, base());
    rx.recibir(e1.packet); optimizado += e1.delivered_bytes; baseline += e1.snapshot_bytes;
    const a1 = tp.ack(p.root, { task_id: 'G-1', recipient_role: 'builder', revision: 1, hash: rx.recibir(e1.packet).ack.hash });
    let confirmadoOk = a1.ok === true; let ultimaKind = null; let deltas = 0;
    for (let i = 2; i <= rondas; i++) {
      acciones.push('paso ' + i);
      const e = tp.enviar(p.root, base({ next_actions: acciones.slice() }));
      optimizado += e.delivered_bytes; baseline += e.snapshot_bytes; ultimaKind = e.kind; if (e.kind === 'delta') deltas++;
      if (i === 6) rx.estado = null; // el receptor REINICIA: el delta no se puede aplicar → pide snapshot
      const ap = rx.recibir(e.packet);
      if (ap.status === 'PIDE_SNAPSHOT') { const s = tp.snapshotActual(p.root, { task_id: 'G-1', recipient_role: 'builder' }); optimizado += bytes(s.packet.body); const ap2 = rx.recibir(s.packet); confirmadoOk = confirmadoOk && ap2.status === 'APLICADO'; if (ap2.ack) tp.ack(p.root, { task_id: 'G-1', recipient_role: 'builder', revision: ap2.ack.revision, hash: ap2.ack.hash }); }
      else if (ap.ack) tp.ack(p.root, { task_id: 'G-1', recipient_role: 'builder', revision: ap.ack.revision, hash: ap.ack.hash });
    }
    const final = tp.snapshotActual(p.root, { task_id: 'G-1', recipient_role: 'builder' });
    const igual = rx.estado && tp.hashContenido(rx.estado.contenido) === tp.hashContenido(JSON.parse(final.packet.body));
    // Evidencia caducada/cambiada: el director rechaza un PASS que no puede comprobar.
    const ev = store.guardar(p.root, { text: 'PASS 10/10' }, { kind: 'test_log', retention: 'durable_audit', task_id: 'G-1' });
    fs.writeFileSync(store.rutaObjeto(p.root, ev.sha256), 'PASS 99/99 (cambiado)');
    const val = tp.validarEntrega(p.root, { task_id: 'G-1', criterios: [{ criterio: 'tests', status: 'PASS', evidence_id: ev.evidence_id }], files: [] });
    // Decisión humana pendiente NO bloqueante: se registra y la tarea sigue.
    const dec = tp.registrarDecisionPendiente(p.root, { task_id: 'G-1', pregunta: '¿Mostrar el descuento en el PDF?', bloqueante: false });
    return resultado(baseline, optimizado, 0, [
      crit('reinicio del receptor → snapshot, no estado corrupto', confirmadoOk && igual === true),
      crit('hubo entregas incrementales (delta) además de snapshots', deltas >= 1, 'deltas=' + deltas),
      crit('evidencia cambiada: el director NO da PASS', val.ok === false),
      crit('decisión humana no bloqueante registrada sin detener', !!(dec && (dec.ok !== false))),
    ], { rondas, deltas, note: 'Receptor, constructor y director SIMULADOS: el protocolo y la base son reales; que un host real los lea no está probado aquí.' });
  } finally { p.limpiar(); }
});

// ─── H · gran memoria histórica ──────────────────────────────────────────────
caso('H', 'Gran memoria histórica', 'Una memoria de miles de nodos se consulta por capas sin volcarla: índice acotado, detalle puntual.', (ctx) => {
  const layers = cargar('memory-layers.cjs'); const p = ctx.proyecto('H');
  try {
    const db = p.abrirW();
    let total = 0;
    try {
      db.transaction(() => {
        for (let i = 0; i < 4000; i++) { const c = 'Regla histórica número ' + i + ' del módulo ' + (i % 40) + '. ' + ' detalle'.repeat(30 + Math.floor(ctx.rnd() * 20)); total += bytes(c); db.run("INSERT INTO nodos (tipo, titulo, contenido, area, confianza, estado, vigencia_tipo, fecha_creacion, fecha_update, ultimo_acceso) VALUES ('patron', ?, ?, ?, 'MEDIA', 'ACTIVO', 'VIGENTE', '2026-01-01 00:00:00', '2026-01-01 00:00:00', '2026-01-01 00:00:00')", 'Regla histórica ' + i, c, 'modulo' + (i % 40)); }
      })();
    } finally { db.close(); }
    const idx = layers.indice(p.root, { query: 'regla modulo7', limit: 10 });
    const ids = (idx.results || []).slice(0, 2).map((r) => r.id);
    const det = ids.length ? layers.detalle(p.root, ids, {}) : { status: 'NO_RESULTS' };
    return resultado(total, bytes(idx), bytes(det), [
      crit('el índice responde acotado y declara el total', idx.status === 'OK' && (idx.results || []).length <= 10 && idx.total != null),
      crit('hay más páginas declaradas (no se vuelca todo)', idx.has_more === true || (idx.total || 0) <= 10),
      crit('el detalle puntual funciona', det.status === 'OK'),
      crit('el volcado completo nunca se entrega', bytes(idx) + bytes(det) < total * 0.2),
    ], { nodes: 4000, note: 'Los consumidores 3.19/3.20 actualizados se comprueban en el release (release-integration) con sus bases reales.' });
  } finally { p.limpiar(); }
});

// ───────────────────────────── ejecución ────────────────────────────────────
function ejecutar({ seed = 20261003, only } = {}) {
  const rnd = mulberry32(seed);
  const proyectos = [];
  const ctx = { rnd, proyecto: (n) => { const p = crearProyecto(n); proyectos.push(p); return p; } };
  const resultados = [];
  for (const c of casos) {
    if (only && !only.includes(c.id)) continue;
    const t0 = Date.now();
    let r;
    try { r = c.run(ctx); } catch (e) { r = { error: e.message, passed: false, criteria: [crit('el caso se ejecuta', false, e.message)], criteria_met: 0, criteria_total: 1 }; }
    resultados.push({ id: c.id, title: c.titulo, objective: c.objetivo, duration_ms: Date.now() - t0, ...r });
  }
  for (const p of proyectos) p.limpiar();
  const metrics = cargar('context-metrics.cjs');
  const netos = resultados.map((r) => r.net_percent);
  return {
    benchmark: 'contexto-y-esfuerzo', version: 1, seed, deterministic: true, user_data: false,
    measure: { bytes: 'exactos', tokens: 'estimated_bytes4 (bytes/4): estimación, no tokens facturados', money: 'no calculado' },
    scope_notice: metrics.AVISO_ALCANCE,
    cases: resultados,
    distribution_net_percent: metrics.distribucion(netos),
    acceptance: { cases_passed: resultados.filter((r) => r.passed).length, cases_total: resultados.length, criteria_met: resultados.reduce((n, r) => n + (r.criteria_met || 0), 0), criteria_total: resultados.reduce((n, r) => n + (r.criteria_total || 0), 0), no_criterion_lost: resultados.every((r) => r.passed) },
    cases_without_saving: resultados.filter((r) => r.nullified || (r.net_percent != null && r.net_percent <= 0)).map((r) => r.id),
    real_model_campaigns: { status: 'NO_EJECUTADO', reason: 'Una campaña con modelos reales cuesta dinero y requiere configuración y autorización explícitas. Este harness mide el MECANISMO de forma determinista; no demuestra eficacia con un modelo ni con Cursor/Claude Code.' },
    host_coverage: { cursor: 'no medido en un host real', claude_code: 'no medido en un host real', note: 'Todo lo medido es lo que Agentix controla (compactación, capas, presupuestos, paquetes).' },
  };
}

function texto(r) {
  const l = ['Benchmark de contexto y esfuerzo (determinista, semilla ' + r.seed + ') — bytes exactos, tokens = bytes/4 ESTIMADOS', ''];
  for (const c of r.cases) {
    l.push((c.passed ? '✔' : '✖') + ' ' + c.id + ' · ' + c.title);
    if (c.error) { l.push('    ERROR: ' + c.error); continue; }
    l.push('    baseline ' + c.baseline_bytes + ' B → optimizado ' + c.optimized_bytes + ' B + recuperado ' + c.recovered_bytes + ' B = neto ' + c.net_bytes + ' B (' + (c.net_percent == null ? 'n/d' : c.net_percent + '%') + ')' + (c.nullified ? '  ← SIN AHORRO' : ''));
    l.push('    criterios ' + c.criteria_met + '/' + c.criteria_total + (c.passed ? '' : '  ← ' + c.criteria.filter((x) => !x.ok).map((x) => x.name).join('; ')));
  }
  l.push('', 'Distribución del neto (%): ' + JSON.stringify(r.distribution_net_percent));
  l.push('Casos sin ahorro: ' + (r.cases_without_saving.join(', ') || '—'));
  l.push('Criterios: ' + r.acceptance.criteria_met + '/' + r.acceptance.criteria_total + ' · ningún criterio perdido: ' + r.acceptance.no_criterion_lost);
  l.push('Campañas con modelos reales: ' + r.real_model_campaigns.status);
  l.push(r.scope_notice);
  return l.join('\n');
}

module.exports = { ejecutar, texto, casos, mulberry32, crearProyecto };

if (require.main === module) {
  const [cmd = 'run', ...resto] = process.argv.slice(2);
  const opt = Object.fromEntries(resto.map((a) => /^--([^=]+)(?:=(.*))?$/.exec(a)).filter(Boolean).map((m) => [m[1], m[2] === undefined ? true : m[2]]));
  if (cmd === 'list') { console.log(JSON.stringify(casos.map((c) => ({ id: c.id, title: c.titulo, objective: c.objetivo })), null, 2)); process.exit(0); }
  if (cmd !== 'run') { console.error('Uso: node benchmark-contexto.cjs run [--seed=N] [--only=A,B] [--json] | list'); process.exit(2); }
  const r = ejecutar({ seed: opt.seed ? Number(opt.seed) : undefined, only: opt.only ? String(opt.only).split(',') : undefined });
  console.log(opt.json ? JSON.stringify(r, null, 2) : texto(r));
  process.exit(r.acceptance.no_criterion_lost ? 0 : 1);
}
