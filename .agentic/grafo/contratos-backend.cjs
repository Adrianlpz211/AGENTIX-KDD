'use strict';

/**
 * Contratos de comportamiento de backend (P07).
 *
 * Un contrato describe una operación (API o servicio) y las dimensiones que
 * debe sostener: entradas válidas e inválidas, salida, errores, autorización,
 * tenant, idempotencia, dinero/fechas y concurrencia. Cada dimensión exigida
 * se mapea a un escenario ejecutable propio; una suite global que pasa no
 * verifica un contrato que no tiene su escenario.
 *
 *   .agentic/contratos/<id>.json
 *   {
 *     "id": "pedidos.crear", "operacion": "POST /pedidos",
 *     "fuentes": ["src/pedidos.js"],
 *     "dimensiones": ["salida", "errores", "autorizacion", "tenant", "idempotencia", "dinero", "concurrencia"],
 *     "escenarios": [{ "id": "http", "test": "test/pedidos-http.test.js", "cubre": ["salida", "errores"] }],
 *     "fixtures": ["test/fixtures/pedidos.json"],
 *     "api": { "archivo": "openapi.json", "consumidores": ["test/consumidor.test.js"] }
 *   }
 *
 * Estado por contrato en .agentic/contratos/_estado.json: candidate hasta una
 * corrida completa en PASS; verified vale mientras no cambien el contrato ni
 * sus fixtures (vigencia por hash).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const esc = require('./escenarios.cjs');

const DIMENSIONES = ['entradas', 'salida', 'errores', 'autorizacion', 'tenant', 'idempotencia', 'dinero', 'fechas', 'concurrencia', 'efectos'];
const dir = (root) => path.join(root, '.agentic', 'contratos');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const leerSeguro = (f) => { try { return fs.readFileSync(f); } catch { return null; } };

function validarContrato(c) {
  const e = [];
  if (!c || typeof c !== 'object') return ['NO_ES_OBJETO'];
  if (!/^[\w.-]{1,80}$/.test(String(c.id || ''))) e.push('ID_INVALIDO');
  if (!Array.isArray(c.fuentes) || !c.fuentes.length) e.push('SIN_FUENTES');
  if (!Array.isArray(c.dimensiones) || !c.dimensiones.length) e.push('SIN_DIMENSIONES');
  else for (const d of c.dimensiones) if (!DIMENSIONES.includes(d)) e.push('DIMENSION_DESCONOCIDA:' + d);
  if (!Array.isArray(c.escenarios)) e.push('SIN_ESCENARIOS');
  return e;
}

function cargar(root) {
  let archivos = [];
  try { archivos = fs.readdirSync(dir(root)).filter((f) => f.endsWith('.json') && !f.startsWith('_')); } catch { return { contratos: [], invalidos: [] }; }
  const contratos = [];
  const invalidos = [];
  for (const f of archivos) {
    const raw = leerSeguro(path.join(dir(root), f));
    let c = null;
    try { c = JSON.parse(String(raw)); } catch { invalidos.push({ archivo: f, errores: ['JSON_INVALIDO'] }); continue; }
    const errores = validarContrato(c);
    if (errores.length) invalidos.push({ archivo: f, errores });
    else contratos.push(Object.assign({}, c, { _hash: sha(raw) }));
  }
  return { contratos, invalidos };
}

/** Contratos tocados por el cambio: directo o por una dependencia de sus fuentes. */
function afectados(root, cambiados, contratos) {
  const { cubre } = require('./regression-guard.cjs');
  const tocados = (cambiados || []).map(esc.norm);
  let transitivos = null;
  let parcial = null;
  try {
    const dbPath = path.join(root, '.agentic', 'memoria.db');
    if (fs.existsSync(dbPath)) {
      const db = require('./db-adapter.cjs').openReadOnly(dbPath);
      try {
        const br = require('./blast-radius.cjs');
        const g = br.aristas(db);
        if (g) transitivos = br.cierre(g, tocados).nodos.map((n) => esc.norm(n.file));
        else parcial = 'SIN_INDICE_AST';
      } finally { db.close(); }
    } else parcial = 'SIN_INDICE_AST';
  } catch { parcial = 'SIN_INDICE_AST'; }
  const alcance = new Set([...tocados, ...(transitivos || [])]);
  const lista = contratos.filter((c) => c.fuentes.some((f) => [...alcance].some((t) => cubre(f, t) || cubre(t, f))));
  return { lista, parcial };
}

function dependenciasFuente(root, archivo, vistos = new Set()) {
  const n = esc.norm(archivo);
  if (vistos.has(n) || vistos.size > 40) return [];
  vistos.add(n);
  const buf = leerSeguro(path.join(root, archivo));
  if (!buf) return [n + ':AUSENTE'];
  const out = [n];
  const dirn = path.posix.dirname(n);
  for (const m of String(buf).matchAll(/require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g)) {
    let rel = path.posix.normalize(path.posix.join(dirn, m[1]));
    if (!/\.[a-z]+$/i.test(rel)) {
      const hallado = ['.js', '.cjs', '.json'].map((x) => rel + x).find((p) => leerSeguro(path.join(root, p)));
      if (hallado) rel = hallado;
    }
    out.push(...dependenciasFuente(root, rel, vistos));
  }
  return out;
}

function huellaVigencia(root, c) {
  const archivos = []
    .concat((c.fuentes || []).flatMap((f) => dependenciasFuente(root, f)))
    .concat(c.fixtures || [])
    .concat((c.escenarios || []).map((s) => s.test).filter(Boolean))
    .concat(c.api && c.api.archivo ? [c.api.archivo] : []);
  const partes = [c._hash];
  for (const f of [...new Set(archivos)]) {
    if (String(f).endsWith(':AUSENTE')) { partes.push(f); continue; }
    const buf = leerSeguro(path.join(root, f));
    partes.push(f + ':' + (buf ? sha(buf) : 'AUSENTE'));
  }
  const pkg = leerSeguro(path.join(root, 'package.json'));
  if (pkg) partes.push('package.json:' + sha(pkg));
  const lock = leerSeguro(path.join(root, 'package-lock.json')) || leerSeguro(path.join(root, 'pnpm-lock.yaml'));
  if (lock) partes.push('lock:' + sha(lock));
  return sha(partes.join('\n'));
}

function estado(root) {
  try { return JSON.parse(fs.readFileSync(path.join(dir(root), '_estado.json'), 'utf8')); } catch { return {}; }
}
function guardarEstado(root, e) {
  fs.mkdirSync(dir(root), { recursive: true });
  const f = path.join(dir(root), '_estado.json');
  fs.writeFileSync(f + '.tmp', JSON.stringify(e, null, 2));
  fs.renameSync(f + '.tmp', f);
}

/** Snapshot versionado del contrato público (OpenAPI, schema, DTO). */
function snapshotApi(root, c) {
  if (!c.api || !c.api.archivo) return null;
  const actual = leerSeguro(path.join(root, c.api.archivo));
  if (!actual) return { status: 'UNVERIFIED', reason_code: 'API_NO_EXISTE', archivo: c.api.archivo };
  const f = path.join(dir(root), 'snapshots', c.id + '.json');
  let snap = null;
  try { snap = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* sin snapshot */ }
  const h = sha(actual);
  if (!snap) return { status: 'UNVERIFIED', reason_code: 'SIN_SNAPSHOT_API', hash: h, reparar: `aprobar el snapshot de ${c.api.archivo} (aprobarApi)` };
  return h === snap.sha256 ? { status: 'PASS', hash: h, version: snap.version } : { status: 'CAMBIO', hash: h, anterior: snap.sha256, version: snap.version };
}

function aprobarApi(root, id, { aprobador, motivo } = {}) {
  if (!String(aprobador || '').trim() || !String(motivo || '').trim()) return { ok: false, reason_code: 'SIN_DECISION' };
  const c = cargar(root).contratos.find((x) => x.id === id);
  if (!c || !c.api) return { ok: false, reason_code: 'CONTRATO_SIN_API' };
  const actual = leerSeguro(path.join(root, c.api.archivo));
  if (!actual) return { ok: false, reason_code: 'API_NO_EXISTE' };
  const f = path.join(dir(root), 'snapshots', id + '.json');
  let previo = null;
  try { previo = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* primero */ }
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const snap = { sha256: sha(actual), version: previo ? previo.version + 1 : 1, aprobador, motivo, at: new Date().toISOString(), anterior: previo ? previo.sha256 : null };
  fs.writeFileSync(f, JSON.stringify(snap, null, 2));
  return { ok: true, version: snap.version };
}

/**
 * Verifica los contratos afectados. Por contrato: mapeo completo (cada
 * dimensión exigida tiene escenario que existe), cada escenario corrido con
 * evidencia propia, y el DTO público igual al snapshot o cubierto por sus
 * consumidores. Un mapeo faltante devuelve la reparación concreta.
 */
function verificar(root, cambiados, opts = {}) {
  const { contratos, invalidos } = cargar(root);
  const execution_id = crypto.randomUUID();
  const base = { gate: 'backend-contracts', policy_id: esc.POLICY_ID, execution_id, subject_hash: opts.subject_hash || null };
  if (invalidos.length) return Object.assign(base, { status: 'UNVERIFIED', reason_code: 'CONTRATO_INVALIDO', invalidos, contratos: [] });
  const { lista, parcial } = opts.todos ? { lista: contratos, parcial: null } : afectados(root, cambiados, contratos);
  if (!lista.length) {
    return Object.assign(base, parcial
      ? { status: 'UNVERIFIED', reason_code: parcial, contratos: [] }
      : { status: 'NO_APLICA', reason_code: 'SIN_ESCENARIOS_PROTEGIDOS', contratos: [] });
  }
  const est = estado(root);
  const ejecutar = opts.ejecutar || ((archivo) => esc.ejecutarEscenario(root, archivo, { comando: opts.comando, subject_hash: opts.subject_hash }));
  const resultados = [];
  for (const c of lista) {
    const r = { id: c.id, operacion: c.operacion || null, escenarios: [], reparar: [] };
    const cubiertas = new Set(c.escenarios.flatMap((s) => s.cubre || []));
    for (const d of c.dimensiones) if (!cubiertas.has(d)) r.reparar.push(`agregar un escenario de "${d}" para ${c.id}`);
    for (const s of c.escenarios) {
      if (!s.test || !fs.existsSync(path.join(root, s.test))) {
        r.escenarios.push({ id: s.id || s.test, test: s.test, status: 'UNVERIFIED', reason_code: 'ESCENARIO_NO_EXISTE' });
        r.reparar.push(`crear ${s.test || '(sin ruta)'} para ${s.id || 'el escenario'} de ${c.id}`);
        continue;
      }
      const ev = ejecutar(s.test);
      const ok = esc.aprobado(ev, s.test, opts.subject_hash, { root, policy_id: esc.POLICY_ID });
      const e = ev && ev.escenarios ? ev.escenarios[esc.norm(s.test)] : null;
      const st = ok ? 'PASS' : (e && e.status === 'FAIL' ? 'FAIL' : (e && e.status === 'ERROR' ? 'ERROR' : 'UNVERIFIED'));
      r.escenarios.push({ id: s.id || s.test, test: s.test, cubre: s.cubre || [], status: st,
        reason_code: ok ? null : (e ? (e.reason_code || 'EVIDENCIA_NO_VIGENTE') : 'SIN_EVIDENCIA'),
        execution_id: e ? e.execution_id : null, subject_hash: e ? e.subject_hash : null,
        policy_id: e ? e.policy_id : null });
    }
    const api = snapshotApi(root, c);
    if (api) {
      r.api = api;
      if (api.status === 'CAMBIO') {
        const consumidores = (c.api.consumidores || []);
        if (!consumidores.length) { r.api.status = 'FAIL'; r.api.reason_code = 'DTO_CAMBIO_SIN_CONSUMIDOR'; }
        else {
          const ok = consumidores.every((t) => esc.aprobado(ejecutar(t), t, opts.subject_hash, { root }));
          r.api.status = ok ? 'PASS_CON_CAMBIO' : 'FAIL';
          r.api.reason_code = ok ? 'REQUIERE_APROBAR_SNAPSHOT' : 'CONSUMIDOR_ROTO';
          if (ok) r.reparar.push(`aprobar la versión nueva de ${c.api.archivo} (aprobarApi ${c.id})`);
        }
      } else if (api.status === 'UNVERIFIED') r.reparar.push(api.reparar || `revisar ${c.api.archivo}`);
    }
    const st = r.escenarios.map((s) => s.status);
    r.status = st.includes('FAIL') || st.includes('ERROR') || (r.api && r.api.status === 'FAIL') ? 'FAIL'
      : r.reparar.length || st.some((s) => s !== 'PASS') || (r.api && !['PASS'].includes(r.api.status)) ? 'UNVERIFIED' : 'PASS';
    const vig = huellaVigencia(root, c);
    const prev = est[c.id] || {};
    if (r.status === 'PASS' && r.escenarios.every((s) => s.execution_id && esc.leerArtefacto(root, s.execution_id))) {
      est[c.id] = { estado: 'verified', vigencia: vig, execution_id, subject_hash: opts.subject_hash || null, verificado_at: new Date().toISOString() };
    } else if (r.status === 'PASS') {
      r.status = 'UNVERIFIED';
      r.reason_code = 'SIN_ARTEFACTO';
      est[c.id] = Object.assign({ estado: 'candidate' }, prev);
    }
    else if (r.status === 'FAIL') est[c.id] = Object.assign({}, prev, { estado: prev.estado === 'verified' ? 'violated' : 'candidate', ultimo_fallo: execution_id });
    else est[c.id] = Object.assign({ estado: 'candidate' }, prev.estado === 'verified' && prev.vigencia === vig ? prev : { estado: 'candidate' });
    r.estado = est[c.id].estado;
    resultados.push(r);
  }
  guardarEstado(root, est);
  const todos = resultados.map((r) => r.status);
  const status = todos.includes('FAIL') ? 'FAIL' : todos.every((s) => s === 'PASS') ? (parcial ? 'UNVERIFIED' : 'PASS') : 'UNVERIFIED';
  return Object.assign(base, { status, reason_code: status === 'UNVERIFIED' && parcial ? parcial : null, contratos: resultados });
}

/** Vigencia: un verified cuyo contrato o fixtures cambió deja de valer. */
function vigente(root, id) {
  const c = cargar(root).contratos.find((x) => x.id === id);
  const e = estado(root)[id];
  if (!c || !e || e.estado !== 'verified') return false;
  return e.vigencia === huellaVigencia(root, c);
}

/** Consumidor del ciclo normal: no pide CLI auxiliar. */
function verificarEnCiclo(root, cambiados, opts = {}) {
  const before = require('./source-evidence.cjs').capture(root);
  const r = verificar(root, cambiados, opts);
  const after = require('./source-evidence.cjs').capture(root);
  if (!before.complete || before.hash !== after.hash) { r.status='UNVERIFIED'; r.reason_code='SOURCE_CHANGED_OR_INCOMPLETE'; }
  if (opts.cycle_id && r.execution_id) {
    esc.guardarArtefacto(root, {
      source_files: Object.keys(before.files).length ? before.files : undefined, source_manifest_hash: before.hash,
      execution_id: r.execution_id, subject_hash: r.subject_hash, policy_id: r.policy_id,
      gate: 'backend-contracts', cycle_id: opts.cycle_id, provenance: 'backend-contracts',
      comprobador: 'contratos-backend', runner_status: r.status,
      expected: (r.contratos || []).flatMap((c) => c.escenarios.map((s) => s.test)),
      executed: (r.contratos || []).flatMap((c) => c.escenarios.filter((s) => s.status === 'PASS').map((s) => s.test)),
      escenarios: Object.fromEntries((r.contratos || []).flatMap(c => c.escenarios.map(s => [s.test, { ...s, descubrimiento: s.status === 'PASS' ? 'runner' : 'desconocido' }]))),
      status: r.status, contratos: (r.contratos || []).map((c) => ({ id: c.id, status: c.status })),
    });
    try {
      require('./pipeline-controller.cjs').registrarGate(root, opts.cycle_id, {
        gate: 'backend-contracts', status: r.status, reason_code: r.reason_code,
        source_files: Object.keys(before.files).length ? before.files : undefined, source_manifest_hash: before.hash,
      execution_id: r.execution_id, subject_hash: r.subject_hash, policy_id: r.policy_id, source: opts.source || 'ciclo',
      });
    } catch { /* el artefacto ya quedó; el cierre lo resolverá */ }
  }
  return r;
}

module.exports = { DIMENSIONES, cargar, validarContrato, afectados, verificar, vigente, aprobarApi, snapshotApi, verificarEnCiclo, huellaVigencia };

if (require.main === module) {
  const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const r = verificar(process.cwd(), files, { todos: process.argv.includes('--todos') });
  console.log(JSON.stringify(r, null, 2));
  process.exitCode = r.status === 'FAIL' ? 1 : 0;
}
