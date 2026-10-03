'use strict';

/**
 * Pipeline controller — el que de verdad pasa cada paso por el harness.
 *
 * Antes `harness.cjs` existía y nadie llamaba a `ejecutarPaso`: importarlo
 * para el health-check no garantizaba nada. Aquí cada entrada (CLI, MCP,
 * aa:, sprint, hook) registra sus pasos por la misma puerta:
 *
 *   paso(root, { cycle_id, step, output, event_id, subject_hash })
 *     → PRE / EXEC / POST del harness, con estado persistido por ciclo.
 *
 * Pasos de razonamiento (analista, implementación, review…) los hace un
 * agente: si no llega su salida, el paso queda NEEDS_AGENT_ACTION. No se
 * simula al agente. El paso `tdd` es mecánico: lo corre el propio gate.
 *
 * El mismo evento (event_id) entrando por dos caminos (hook y MCP) se
 * ejecuta una vez; la segunda devuelve el resultado guardado.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const harness = require('./harness.cjs');

const DIR = path.join('.agentic', '_pipeline');
const ORDEN = ['context_guard', 'analyst', 'implementation', 'tdd', 'qa', 'review', 'memory'];
const MECANICOS = new Set(['tdd']);

function politica(estado) {
  const p = estado.policy || {};
  return {
    required: Array.isArray(p.required) && p.required.length ? p.required : ['tdd', 'qa'],
    requires_full_suite: !!p.requires_full_suite,
  };
}

function ruta(root, cycleId) {
  if (!/^[\w-]{1,80}$/.test(String(cycleId || ''))) {
    const e = new Error('cycle_id inválido');
    e.code = 'INVALID_CYCLE_ID';
    throw e;
  }
  return path.join(root, DIR, cycleId + '.json');
}

function cargar(root, cycleId) {
  try { return JSON.parse(fs.readFileSync(ruta(root, cycleId), 'utf8')); }
  catch (e) { if (e.code === 'INVALID_CYCLE_ID') throw e; return null; }
}

function guardar(root, estado) {
  const r = ruta(root, estado.cycle_id);
  fs.mkdirSync(path.dirname(r), { recursive: true });
  const tmp = r + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(estado, null, 2));
  fs.renameSync(tmp, r);
}

function abrir(root, opciones) {
  const o = opciones || {};
  const cycleId = o.cycle_id || crypto.randomUUID();
  const previo = cargar(root, cycleId);
  if (previo) return previo;
  // Router de esfuerzo: una consulta por tarea. Una tarea HIGH sin política
  // explícita exige revisión y suite completa; LOW/MEDIUM no pierden tdd ni qa.
  let effort = null;
  try {
    effort = require('./effort-router.cjs').decidirYGuardar(root, Object.assign({
      task_id: cycleId, intent: String(o.task || ''), paths: o.paths || [], subject_hash: o.subject_hash || null,
    }, o.effort_input || {}));
  } catch { /* sin router: política por defecto */ }
  let policy = o.policy || {};
  if (!o.policy && effort && effort.tier === 'HIGH') policy = { required: ['tdd', 'qa', 'review'], requires_full_suite: true, from: 'effort-router' };
  let revisorExterno = null;
  if (effort) { try { revisorExterno = require('./revisor-externo.cjs').estado(root, effort); } catch { /* opcional */ } }
  const estado = {
    schema_version: 1,
    cycle_id: cycleId,
    task: String(o.task || ''),
    policy,
    effort,
    revisor_externo: revisorExterno,
    subject_hash: o.subject_hash || null,
    paths: o.paths || [],
    steps: {},
    processed: {},
    events: [],
    created_at: new Date().toISOString(),
  };
  guardar(root, estado);
  return estado;
}

function contexto(root, estado, extra) {
  const ok = (s) => estado.steps[s] && estado.steps[s].status === 'PASS';
  const out = (s) => (estado.steps[s] && estado.steps[s].output) || {};
  return Object.assign({
    task: estado.task,
    project_root: root,
    config_loaded: fs.existsSync(path.join(root, '.agentic', 'config.md')),
    plan: out('analyst').plan || null,
    allowed_files: [].concat(out('analyst').allowed_files || out('analyst').files || [],
      (estado.scope_extensions || []).flatMap((x) => x.files)),
    implementation_done: ok('implementation') || !politica(estado).required.includes('implementation'),
    test_command: (extra && extra.test_command) || require('./tdd-gate.cjs').detectTestCommand(root),
    tdd_passed: ok('tdd'),
    qa_passed: ok('qa'),
    review_done: ok('review') || !politica(estado).required.includes('review'),
    subject_hash: estado.subject_hash,
    qa_policy: { requires_full_suite: politica(estado).requires_full_suite },
  }, extra || {});
}

function ejecutarTdd(root, estado, opciones) {
  const tdd = require('./tdd-gate.cjs');
  const r = tdd.runSelfHealingLoop({
    projectRoot: root,
    area: (opciones && opciones.area) || 'global',
    scope: (opciones && opciones.scope) || [],
    subjectHash: estado.subject_hash || undefined,
    cycleId: estado.cycle_id,
  });
  if (!estado.subject_hash && r.subject_hash) estado.subject_hash = r.subject_hash;
  // La preservación sale de la misma corrida: el cierre no vuelve a interpretar texto.
  const p = r.preservation;
  if (p && p.status) {
    estado.gates = estado.gates || {};
    estado.gates.preservation = {
      status: p.status, reason_code: p.status === 'NO_APLICA' ? 'SIN_ESCENARIOS_PROTEGIDOS' : (p.reason_code || null),
      execution_id: p.execution_id || null, subject_hash: p.subject_hash || r.subject_hash || estado.subject_hash || null,
      policy_id: require('./politica-gates.cjs').POLICY_ID, source: 'tdd', at: new Date().toISOString(),
    };
  }
  try {
    const paths = estado.paths || (estado.effort && estado.effort.paths) || [];
    const cb = require('./contratos-backend.cjs');
    if (paths.length) {
      cb.verificarEnCiclo(root, paths, {
        cycle_id: estado.cycle_id, subject_hash: estado.subject_hash || r.subject_hash,
        comando: (opciones && opciones.comando) || undefined, source: 'tdd',
      });
    }
  } catch { /* sin contratos: el cierre no los exige */ }
  return {
    tests_found: r.tests_found || [],
    tests_passing: r.tests_passing || 0,
    all_passed: r.status === 'PASS',
    iterations: r.iterations || 0,
    failing_tests: r.failing_tests || [],
    status: r.status,
    reason_code: r.reason_code || null,
    evidence: r.gate && r.gate.evidence ? r.gate.evidence.map((e) => Object.assign({ ref: 'tdd:' + r.gate.execution_id, status: r.status }, e)) : [],
  };
}

/**
 * Registra un paso. Devuelve { status, reason, attempts, duplicate }.
 * status: PASS | FAIL | NEEDS_AGENT_ACTION | ERROR.
 */
async function paso(root, entrada) {
  const e = entrada || {};
  const estado = cargar(root, e.cycle_id) || abrir(root, e);
  if (!ORDEN.includes(e.step)) return { status: 'ERROR', reason: 'paso desconocido: ' + e.step };
  if (e.subject_hash) estado.subject_hash = e.subject_hash;

  const eventId = e.event_id || crypto.createHash('sha256')
    .update([e.step, estado.subject_hash || '', JSON.stringify(e.output || null)].join('\u0000')).digest('hex').slice(0, 32);
  if (estado.processed[eventId]) {
    return Object.assign({}, estado.processed[eventId], { duplicate: true });
  }

  if (!MECANICOS.has(e.step) && (e.output === undefined || e.output === null)) {
    const r = { status: 'NEEDS_AGENT_ACTION', reason: `el paso ${e.step} lo hace un agente: falta su salida`, attempts: 0 };
    estado.steps[e.step] = Object.assign({ at: new Date().toISOString() }, r);
    guardar(root, estado);
    return r;
  }

  const fases = [];
  const silencio = console.log;
  console.log = (m) => { if (typeof m === 'string' && m.startsWith('[HARNESS]')) fases.push(m); else if (!e.quiet) silencio(m); };
  let res;
  try {
    const ctx = contexto(root, estado, e.ctx);
    res = await harness.ejecutarPaso(e.step, ctx, async () => (
      MECANICOS.has(e.step) ? ejecutarTdd(root, estado, e) : e.output
    ), { maxRetries: 1 });
  } catch (err) {
    res = { success: false, output: null, gate: { ok: false, reason: err.message }, attempts: 0 };
  } finally {
    console.log = silencio;
  }

  const r = {
    status: res.success ? 'PASS' : (res.attempts === 0 && /PRE/.test(res.gate.reason || '') ? 'BLOCKED_PRE' : 'FAIL'),
    reason: res.success ? null : res.gate.reason,
    attempts: res.attempts,
    phases: fases.map((f) => (f.match(/ (PRE|EXEC|POST)\b/) || [])[1]).filter(Boolean),
  };
  estado.steps[e.step] = Object.assign({ at: new Date().toISOString(), output: res.output || null }, r);
  estado.processed[eventId] = r;
  estado.events.push({ event_id: eventId, step: e.step, status: r.status, source: e.source || 'cli', at: new Date().toISOString() });
  guardar(root, estado);
  registrarEnLibreta(root, estado.cycle_id, e.step, r, eventId);
  try {
    require('./telemetry.cjs').recordStep(e.step, r, { cycle_id: estado.cycle_id, event_id: eventId, via: e.source || 'cli' }, root);
  } catch (err) { if (err.code === 'TELEMETRY_WRITE_FAILED') r.audit_error = err.message; }
  return r;
}

function registrarEnLibreta(root, cycleId, step, r, eventId) {
  try {
    const dbPath = path.join(root, '.agentic', 'memoria.db');
    if (!fs.existsSync(dbPath)) return;
    const db = require('./db-adapter.cjs').openWrite(dbPath);
    try {
      require('./gate-telemetry.cjs').recordGateEvent(db, {
        gate: 'harness:' + step,
        verdict: r.status === 'PASS' ? 'PASS' : (r.status === 'NEEDS_AGENT_ACTION' ? 'PENDING' : 'STOP'),
        cycle_id: cycleId,
        event_id: 'harness-' + eventId,
        detalle: { reason: r.reason ? String(r.reason).slice(0, 200) : null },
      });
    } finally { db.close(); }
  } catch { /* el estado del controlador ya quedó guardado en su archivo */ }
}

/**
 * Ampliar el alcance del plan deja rastro: quién, cuándo, qué archivos y por
 * qué. Lo que se escapa de la raíz no se acepta ni así.
 */
function ampliarAlcance(root, cycleId, files, motivo) {
  const pn = require('./path-norm.cjs');
  const estado = cargar(root, cycleId);
  if (!estado) return { ok: false, reason_code: 'NO_STATE' };
  if (!String(motivo || '').trim()) return { ok: false, reason_code: 'MOTIVO_REQUERIDO' };
  const rechazados = [];
  const aceptados = [];
  for (const f of files || []) {
    const r = pn.resolverEnRaiz(root, f);
    if (r.ok) aceptados.push(r.rel); else rechazados.push({ file: f, reason: r.reason });
  }
  if (rechazados.length) return { ok: false, reason_code: 'ESCAPE', rechazados };
  estado.scope_extensions = (estado.scope_extensions || []).concat({ files: aceptados, motivo: String(motivo), at: new Date().toISOString() });
  guardar(root, estado);
  registrarEnLibreta(root, cycleId, 'scope', { status: 'PASS', reason: 'ampliación: ' + aceptados.join(', ') + ' — ' + motivo }, 'scope-' + Date.now());
  return { ok: true, files: aceptados };
}

/** Justo antes de escribir: se vuelve a resolver (un enlace pudo cambiar). */
function verificarAntesDeEscribir(root, cycleId, archivo) {
  const estado = cargar(root, cycleId);
  if (!estado) return { ok: false, reason_code: 'NO_STATE' };
  const ctx = contexto(root, estado);
  const r = harness.checkScopeDeviation([archivo], ctx.allowed_files, harness.GATE_DEFINITIONS.implementation.denylist, root);
  return r.ok ? { ok: true } : { ok: false, reason_code: 'OUT_OF_SCOPE', reason: r.reason };
}

/**
 * Resultado estructurado de un gate de superficie (browser, visual,
 * test-integrity, preservation). Se guarda tal cual llegó; el cierre decide.
 */
function ctxCierre(root, estado, gate) {
  const paths = estado.paths || (estado.effort && estado.effort.paths) || [];
  const pg = require('./politica-gates.cjs');
  return {
    root,
    cycle_id: estado.cycle_id,
    paths,
    policy: pg.gatesPorSuperficie(paths, { root }),
    requiere_referencia: !!(estado.effort && estado.effort.requiere_referencia),
    gate,
  };
}

function registrarGate(root, cycleId, resultado) {
  const pg = require('./politica-gates.cjs');
  const esc = require('./escenarios.cjs');
  const estado = cargar(root, cycleId);
  if (!estado) return { ok: false, reason_code: 'NO_STATE' };
  const r = resultado || {};
  if (!pg.GATES_PRESERVACION.includes(r.gate)) return { ok: false, reason_code: 'GATE_DESCONOCIDO' };
  const sujetoActual = estado.subject_hash;
  let execution_id = r.execution_id || null;
  let art = execution_id ? esc.leerArtefacto(root, execution_id) : null;
  if (r.status === 'PASS' && execution_id && !art) {
    estado.gates = estado.gates || {};
    estado.gates[r.gate] = {
      status: 'UNVERIFIED', reason_code: 'SIN_ARTEFACTO',
      execution_id, subject_hash: r.subject_hash || sujetoActual, policy_id: r.policy_id || null,
      source: r.source || 'cli', at: new Date().toISOString(),
    };
    guardar(root, estado);
    return { ok: true, cierre: pg.cierraGate(estado.gates[r.gate], sujetoActual, ctxCierre(root, estado, r.gate)) };
  }
  estado.gates = estado.gates || {};
  estado.gates[r.gate] = {
    status: r.status || 'UNVERIFIED', reason_code: r.reason_code || null,
    execution_id, subject_hash: (art && art.subject_hash) || r.subject_hash || null,
    policy_id: (art && art.policy_id) || r.policy_id || null,
    expected: (art && art.expected) || r.expected || null,
    provenance: (art && art.provenance) || r.provenance || null,
    source: r.source || 'cli', at: new Date().toISOString(),
  };
  guardar(root, estado);
  registrarEnLibreta(root, cycleId, 'gate:' + r.gate, { status: r.status === 'PASS' ? 'PASS' : 'FAIL', reason: r.reason_code || r.status }, 'gate-' + r.gate + '-' + (execution_id || Date.now()));
  return { ok: true, cierre: pg.cierraGate(estado.gates[r.gate], sujetoActual, ctxCierre(root, estado, r.gate)) };
}

/** Gates de preservación que exige la superficie de este ciclo. */
function gatesDeSuperficie(estado) {
  const e = estado.effort || {};
  if (Array.isArray(e.preservation_gates)) return e.preservation_gates;
  return [];
}

/**
 * ¿Puede cerrarse el ciclo? Solo si todo paso requerido pasó y cada gate de
 * preservación de su superficie tiene PASS del mismo sujeto y política (o
 * NO_APLICA con razón comprobable). UNVERIFIED/ERROR/FAIL nunca cierran.
 */
function puedeCerrar(root, cycleId) {
  const estado = cargar(root, cycleId);
  if (!estado) return { ok: false, status: 'NO_STATE', pendientes: [] };
  if (estado.subject_hash && /^[a-f0-9]{40,64}$/i.test(estado.subject_hash)) {
    try {
      const ahora = require('./tdd-gate.cjs').subjectHash(root);
      if (ahora && ahora !== estado.subject_hash) {
        return {
          ok: false, status: 'STALE', reason_code: 'SUJETO_CAMBIO',
          pendientes: ['sujeto'], fallidos: [], gates: {},
          sujeto_guardado: estado.subject_hash, sujeto_actual: ahora,
        };
      }
    } catch { /* sin huella: no se finge STALE ni PASS */ }
  }
  const pg = require('./politica-gates.cjs');
  const ctx = ctxCierre(root, estado);
  const exigidos = [...new Set([].concat(gatesDeSuperficie(estado), ctx.policy.required || []))];
  const pendientes = politica(estado).required.filter((s) => !estado.steps[s] || estado.steps[s].status !== 'PASS');
  const fallidos = pendientes.filter((s) => estado.steps[s] && /FAIL|BLOCKED/.test(estado.steps[s].status));
  const gates = {};
  for (const g of exigidos) {
    const r = (estado.gates || {})[g];
    const c = pg.cierraGate(r, estado.subject_hash, Object.assign({}, ctx, { gate: g }));
    gates[g] = Object.assign({ status: r ? r.status : 'SIN_RESULTADO' }, c);
    if (!c.ok) {
      pendientes.push('gate:' + g);
      if (r && ['FAIL', 'ERROR'].includes(r.status)) fallidos.push('gate:' + g);
    }
  }
  const sinVerificar = Object.entries(gates).filter(([, v]) => !v.ok && v.status !== 'FAIL' && v.status !== 'ERROR').map(([g]) => g);
  return {
    ok: pendientes.length === 0,
    status: pendientes.length === 0 ? 'PASS' : (fallidos.length ? 'FAIL' : (sinVerificar.length && Object.values(gates).some((v) => v.status !== 'SIN_RESULTADO') ? 'UNVERIFIED' : 'PENDING')),
    pendientes,
    fallidos,
    gates,
    policy_id: pg.POLICY_ID,
    no_aplica: (estado.effort && estado.effort.no_aplica) || [],
  };
}

module.exports = { abrir, paso, puedeCerrar, registrarGate, cargar, ampliarAlcance, verificarAntesDeEscribir, ORDEN };

if (require.main === module) {
  const [, , cmd, ...args] = process.argv;
  const flag = (n) => { const a = args.find((x) => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : undefined; };
  const root = process.cwd();
  let cycleId = flag('cycle');
  if (!cycleId) {
    try { const c = require('./ciclo-actual.cjs').actual(root); cycleId = c && c.cycle_id; } catch {}
  }
  (async () => {
    if (!cycleId) { console.error('Sin ciclo: pasa --cycle=<id> o arranca uno con el context-enricher.'); process.exit(2); }
    if (cmd === 'paso') {
      const archivo = flag('output');
      const output = archivo ? JSON.parse(fs.readFileSync(archivo, 'utf8')) : undefined;
      const r = await paso(root, { cycle_id: cycleId, step: args[0], output, event_id: flag('event'), area: flag('area'), source: 'cli' });
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.status === 'PASS' ? 0 : 1);
    } else if (cmd === 'gate') {
      const archivo = flag('input');
      if (!archivo) { console.error('Uso: node pipeline-controller.cjs gate --input=resultado.json [--cycle=id]'); process.exit(2); }
      const r = registrarGate(root, cycleId, Object.assign(JSON.parse(fs.readFileSync(archivo, 'utf8')), { source: 'cli' }));
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.ok && r.cierre.ok ? 0 : 1);
    } else if (cmd === 'estado') {
      console.log(JSON.stringify({ estado: cargar(root, cycleId), cierre: puedeCerrar(root, cycleId) }, null, 2));
    } else {
      console.log('Uso: node pipeline-controller.cjs [paso <context_guard|analyst|implementation|tdd|qa|review|memory> [--output=archivo.json] [--event=id] | estado] [--cycle=id]');
    }
  })();
}
