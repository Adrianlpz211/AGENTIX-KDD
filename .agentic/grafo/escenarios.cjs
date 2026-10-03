'use strict';

/**
 * Evidencia por escenario de preservación.
 *
 * Un escenario protegido es un archivo de test. Su veredicto sale de un proceso
 * que corrió de verdad sobre el sujeto actual: exit, señal, timeout, conteo y
 * descubrimiento del archivo pedido. Nunca de que un texto NO diga "FAIL".
 *
 *   PASS        el archivo se ejecutó y el proceso lo aprobó
 *   FAIL        se ejecutó y falló (o el runner salió con error)
 *   UNVERIFIED  cero tests, archivo no ejecutado, descubrimiento no demostrado,
 *               argumento rechazado o sin evidencia
 *   ERROR       el runner no arrancó, timeout o señal
 *   SKIP        omitido: nunca aprueba
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const POLICY_ID = 'preservacion/1';
const STATUSES = ['PASS', 'FAIL', 'UNVERIFIED', 'ERROR', 'SKIP'];
const EXEC_RE = /^[\w.-]{8,80}$/;
const DIR_EXEC = path.join('.agentic', '_executions');

/** Quién puede producir evidencia: el runner mecánico, no un JSON inventado. */
const PROVENANCE_OK = new Set(['mecanica', 'browser', 'visual', 'backend-contracts', 'gate-check']);

function rutaArtefacto(root, executionId) {
  if (!root || !EXEC_RE.test(String(executionId || ''))) return null;
  return path.join(root, DIR_EXEC, executionId + '.json');
}

function leerArtefacto(root, executionId) {
  const f = rutaArtefacto(root, executionId);
  if (!f) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

function guardarArtefacto(root, art) {
  if (!root || !art || !EXEC_RE.test(String(art.execution_id || ''))) return { ok: false, reason_code: 'ID_INVALIDO' };
  const f = rutaArtefacto(root, art.execution_id);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  if (fs.existsSync(f)) {
    const prev = leerArtefacto(root, art.execution_id);
    if (prev && prev.immutable) return { ok: false, reason_code: 'ARTEFACTO_INMUTABLE', path: f };
  }
  const cuerpo = Object.assign({
    schema_version: 1, policy_id: POLICY_ID,
    written_at: new Date().toISOString(),
  }, art, { immutable: true });
  const tmp = f + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cuerpo, null, 2));
  fs.renameSync(tmp, f);
  return { ok: true, path: f, artifact: cuerpo };
}

function validarArtefacto(root, executionId, esperado = {}) {
  const art = leerArtefacto(root, executionId);
  if (!art) return { ok: false, reason_code: 'SIN_ARTEFACTO' };
  if (art.schema_version !== 1) return { ok: false, reason_code: 'SCHEMA_INVALIDO' };
  if (!art.execution_id || art.execution_id !== executionId) return { ok: false, reason_code: 'ID_INTERNO_DISTINTO' };
  if (!art.provenance) return { ok: false, reason_code: 'SIN_PROCEDENCIA' };
  if (!PROVENANCE_OK.has(art.provenance)) return { ok: false, reason_code: 'PROVENANCE_RECHAZADA' };
  const gateKey = name => ['tdd','tests','relevant-check','affected-tests','full-suite'].includes(name) ? 'tests' : name;
  if (esperado.gate === 'full-suite' && art.run_scope !== 'suite') return { ok: false, reason_code: 'SUITE_COMPLETA_NO_DEMOSTRADA' };
  if (!art.gate || esperado.gate && gateKey(art.gate) !== gateKey(esperado.gate)) return { ok: false, reason_code: 'ARTEFACTO_GATE_DISTINTO' };
  if (esperado.cycle_id && art.cycle_id !== esperado.cycle_id) return { ok: false, reason_code: 'ARTEFACTO_CICLO_DISTINTO' };
  if (!art.subject_hash || esperado.subject_hash && art.subject_hash !== esperado.subject_hash) return { ok: false, reason_code: 'ARTEFACTO_SUJETO_DISTINTO' };
  if (art.policy_id !== (esperado.policy_id || POLICY_ID)) return { ok: false, reason_code: 'ARTEFACTO_POLITICA_DISTINTA' };
  if (art.stale) return { ok: false, reason_code: 'STALE' };
  if (art.signal || art.timeout) return { ok: false, reason_code: 'RUNNER_INTERRUMPIDO' };
  if (art.exit_code != null && (typeof art.exit_code !== 'number' || art.exit_code !== 0)) return { ok: false, reason_code: 'RUNNER_NO_APROBO' };
  if (art.runner_status && art.runner_status !== 'PASS' && !(art.status === 'NO_APLICA' && art.runner_status === 'NO_APLICA')) return { ok: false, reason_code: 'RUNNER_NO_APROBO' };
  const expected = Array.isArray(esperado.expected) ? esperado.expected : (art.expected || []);
  if (!Array.isArray(art.expected) || !Array.isArray(art.executed) || !Array.isArray(expected)) return { ok: false, reason_code: 'ESCENARIOS_INVALIDOS' };
  if (art.status === 'NO_APLICA') {
    if (expected.length || art.expected.length || art.executed.length) return { ok: false, reason_code: 'NO_APLICA_CON_ESCENARIOS' };
    return { ok: true, no_aplica: true, artifact: art };
  }
  if (esperado.na) return { ok: false, reason_code: 'NO_APLICA_NO_DECLARADO' };
  if (art.status && art.status !== 'PASS') return { ok: false, reason_code: 'ARTEFACTO_NO_PASS' };
  if (art.runner_status !== 'PASS' && !(['browser', 'visual'].includes(art.provenance) && art.status === 'PASS')) return { ok: false, reason_code: 'SIN_RESULTADO_RUNNER' };
  if (art.provenance === 'mecanica' && art.exit_code !== 0) return { ok: false, reason_code: 'SIN_RESULTADO_RUNNER' };
  if (['browser', 'visual', 'backend-contracts', 'gate-check'].includes(art.provenance) && !art.comprobador && !art.runner) return { ok: false, reason_code: 'SIN_COMPROBADOR' };
  if (art.provenance === 'gate-check' && (!(art.assertions > 0) || !art.runner_hash || !art.source_files)) return { ok: false, reason_code: 'CHECK_INCOMPLETO' };
  if (art.runner_hash && art.runner_hash !== require('./evidence-cache.cjs').huellaRunner(root)) return { ok: false, reason_code: 'RUNNER_CAMBIO' };
  const escenarios = art.escenarios || {};
  if (Object.values(escenarios).some(e => !e || e.status !== 'PASS')) return { ok: false, reason_code: 'ESCENARIO_NO_PASS' };
  const ejecutados = new Set(art.executed.map(clave));
  const pruebas = new Map(Object.entries(escenarios).map(([k,v]) => [clave(k),v]));
  const faltan = [...new Set([...expected, ...art.expected])].filter(file => {
    const e = pruebas.get(clave(file));
    return !ejecutados.has(clave(file)) || !e || e.status !== 'PASS' || !e.descubrimiento || e.descubrimiento === 'desconocido';
  });
  if (faltan.length) return { ok: false, reason_code: 'COBERTURA_PARCIAL', faltan };
  if (!expected.length && !art.expected.length && art.provenance === 'mecanica' && !(art.tests_total > 0)) return { ok: false, reason_code: 'CERO_TESTS' };
  if (art.source_manifest_hash && require('./source-evidence.cjs').capture(root).hash !== art.source_manifest_hash) return { ok: false, reason_code: 'SUJETO_CAMBIO' };
  if (art.source_files) {
    const files = Object.entries(art.source_files);
    if (!files.length) return { ok: false, reason_code: 'SIN_ARCHIVOS_SUJETO' };
    for (const [file, hash] of files) {
      const abs = path.resolve(root, file), base = path.resolve(root);
      if (!abs.startsWith(base + path.sep)) return { ok: false, reason_code: 'ARCHIVO_FUERA_DE_RAIZ' };
      try { if (!fs.realpathSync(abs).startsWith(fs.realpathSync(root) + path.sep)) return { ok: false, reason_code: 'ARCHIVO_FUERA_DE_RAIZ' }; if (crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex') !== hash) return { ok: false, reason_code: 'SUJETO_CAMBIO' }; }
      catch { return { ok: false, reason_code: 'SUJETO_CAMBIO' }; }
    }
    if ((esperado.paths || []).some(f => !Object.keys(art.source_files).some(k => clave(k) === clave(f)))) return { ok: false, reason_code: 'SUJETO_PARCIAL' };
  } else if (esperado.paths && esperado.paths.length) return { ok: false, reason_code: 'SIN_ARCHIVOS_SUJETO' };
  return { ok: true, artifact: art };
}
const norm = (p) => String(p == null ? '' : p).replace(/\\/g, '/').replace(/^\.\//, '');
const FS_INSENSIBLE = process.platform === 'win32' || process.platform === 'darwin';
const clave = (p) => (FS_INSENSIBLE ? norm(p).toLowerCase() : norm(p));

/** Archivos que ESTA corrida ejecutó. Cache global sin execution_id no acredita otra. */
function ejecutadosSegunRunner(root, desde, opts = {}) {
  if (opts.execution_id) {
    const art = leerArtefacto(root, opts.execution_id);
    if (art && art.archivos && typeof art.archivos === 'object') {
      if (opts.subject_hash && art.subject_hash && art.subject_hash !== opts.subject_hash) return null;
      return Object.fromEntries(Object.entries(art.archivos).map(([k, v]) => [clave(k), v]));
    }
  }
  const f = path.join(root, '.agentic', '_cache', 'test-run.json');
  try {
    const r = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (opts.execution_id && (!r.execution_id || r.execution_id !== opts.execution_id)) return null;
    if (opts.subject_hash && (!r.subject_hash || r.subject_hash !== opts.subject_hash)) return null;
    if (desde && r.ts && Date.parse(r.ts) < Date.parse(desde)) return null;
    const archivos = r.archivos && typeof r.archivos === 'object' ? r.archivos : null;
    if (!archivos) return null;
    return Object.fromEntries(Object.entries(archivos).map(([k, v]) => [clave(k), v]));
  } catch { return null; }
}

/**
 * ¿Qué archivos pedidos se ejecutaron?
 *   modo 'runner'  el runner dejó resultado por archivo (junit/cache) — exacto
 *   modo 'salida'  la salida nombra el archivo (jest, vitest, pytest -v)
 *   modo 'unico'   se pidió un solo archivo explícito y el proceso corrió tests
 *   modo 'desconocido' no hay forma de demostrarlo → no se cuenta como ejecutado
 */
function descubrimiento(root, pedidos, salida, resultado, desde, explicito, opts = {}) {
  const porRunner = ejecutadosSegunRunner(root, desde, {
    execution_id: (resultado && resultado.gate && resultado.gate.execution_id) || opts.execution_id,
    subject_hash: (resultado && resultado.gate && resultado.gate.subject_hash) || opts.subject_hash,
  });
  const texto = String(salida || '').replace(/\\/g, '/');
  const out = {};
  for (const p of pedidos) {
    const k = clave(p);
    if (porRunner) {
      const e = porRunner[k];
      out[norm(p)] = e ? { ejecutado: true, modo: 'runner', fallos: e.fail || 0, omitidos: e.skip || 0, pasaron: e.pass || 0 }
        : { ejecutado: false, modo: 'runner' };
      continue;
    }
    const n = norm(p);
    if (texto.includes(n) || (path.posix.basename(n).length > 8 && texto.includes(path.posix.basename(n)))) {
      out[n] = { ejecutado: true, modo: 'salida' };
    } else if (explicito && pedidos.length === 1 && resultado && resultado.total > 0) {
      /* Solo adaptadores que reciben el archivo en argv (node --test, pytest).
         Un runner que ignora el filtro no puede acreditar por ser el único pedido. */
      const argv = [].concat(resultado.args || resultado.argumentos || []).map(String);
      const cmd = String(resultado.comando || resultado.command || '');
      const base = path.posix.basename(n);
      const enArgv = argv.some((a) => a.replace(/\\/g, '/').includes(n) || a.includes(base));
      const adapterOk = /node --test|pytest|node:test/.test(cmd) || enArgv || (!cmd && !argv.length);
      if (adapterOk) out[n] = { ejecutado: true, modo: 'unico' };
      else out[n] = { ejecutado: false, modo: 'desconocido' };
    } else {
      out[n] = { ejecutado: false, modo: 'desconocido' };
    }
  }
  return out;
}

/**
 * Evidencia de una corrida para un conjunto de escenarios.
 * `resultado` es la salida de tdd-gate.parseTestOutput / runTests.
 */
function evidenciaDeCorrida(root, resultado, pedidos, opts = {}) {
  const gate = (resultado && resultado.gate) || {};
  const runnerExecution = gate.execution_id || opts.execution_id || null;
  const previous = runnerExecution && leerArtefacto(root, runnerExecution);
  const execution_id = previous && previous.gate !== (opts.gate || 'preservation') ? crypto.createHash('sha256').update(runnerExecution + ':' + (opts.gate || 'preservation')).digest('hex') : runnerExecution;
  const subject_hash = gate.subject_hash || opts.subject_hash || null;
  const desde = gate.started_at || opts.started_at || null;
  const desc = descubrimiento(root, pedidos, resultado && resultado.output, resultado, desde, !!opts.explicito, {
    execution_id: runnerExecution, subject_hash,
  });
  const escenarios = {};
  for (const p of pedidos) {
    const n = norm(p);
    const d = desc[n];
    let status;
    let reason = null;
    if (!resultado) { status = 'UNVERIFIED'; reason = 'SIN_EVIDENCIA'; }
    else if (resultado.status === 'ERROR') { status = 'ERROR'; reason = resultado.reason_code; }
    else if (!d.ejecutado) { status = 'UNVERIFIED'; reason = d.modo === 'desconocido' ? 'EJECUCION_NO_DEMOSTRADA' : 'NO_EJECUTADO'; }
    else if (d.modo === 'runner' && d.fallos > 0) { status = 'FAIL'; reason = 'TESTS_FAILED'; }
    else if (d.modo === 'runner' && d.pasaron === 0 && d.omitidos > 0) { status = 'SKIP'; reason = 'SOLO_OMITIDOS'; }
    else if (resultado.status === 'FAIL') {
      if (opts.explicito) { status = 'FAIL'; reason = resultado.reason_code; }
      else { status = 'UNVERIFIED'; reason = d.modo === 'runner' ? 'CORRIDA_FALLIDA_EN_OTRO_ESCENARIO' : 'FALLO_NO_ATRIBUIBLE'; }
    }
    else if (resultado.status !== 'PASS') { status = 'UNVERIFIED'; reason = resultado.reason_code || 'SIN_PASS'; }
    else if (!subject_hash || !execution_id) { status = 'UNVERIFIED'; reason = 'SIN_SUJETO'; }
    else { status = 'PASS'; }
    escenarios[n] = {
      scenario_id: idEscenario(n), status, reason_code: reason, descubrimiento: d.modo,
      execution_id, subject_hash, policy_id: POLICY_ID,
      evidence_id: execution_id ? crypto.createHash('sha256').update(execution_id + '|' + n).digest('hex').slice(0, 16) : null,
    };
  }
  const ev = {
    execution_id, subject_hash, policy_id: POLICY_ID,
    exit_code: resultado ? resultado.exitCode : null,
    runner_status: resultado ? resultado.status : null, tests_total: resultado ? resultado.total : 0,
    started_at: desde, finished_at: new Date().toISOString(),
    run_scope: resultado && resultado.run_scope || null,
    source_files: resultado && resultado.source_evidence && Object.keys(resultado.source_evidence.files).length ? resultado.source_evidence.files : undefined,
    source_manifest_hash: resultado && resultado.source_evidence ? resultado.source_evidence.hash : undefined,
    provenance: opts.provenance || 'mecanica',
    gate: opts.gate || 'preservation',
    cycle_id: opts.cycle_id || null,
    expected: pedidos.map(norm),
    executed: Object.keys(escenarios).filter((k) => escenarios[k].descubrimiento !== 'desconocido'),
    escenarios,
  };
  if (root && execution_id && ev.provenance !== 'declarada') {
    guardarArtefacto(root, ev);
  }
  return ev;
}

function idEscenario(archivo) {
  return 'esc_' + crypto.createHash('sha256').update(clave(archivo)).digest('hex').slice(0, 12);
}

/**
 * Corre UN escenario con el runner del proyecto: argv validado (se rechaza, no se
 * "limpia"), sin cambiar la ruta pedida, con su propio execution_id.
 */
function ejecutarEscenario(root, archivo, opts = {}) {
  const tdd = require(path.join(__dirname, 'tdd-gate.cjs'));
  const comando = opts.comando || tdd.detectTestCommand(root);
  if (!comando) {
    const ev = evidenciaDeCorrida(root, null, [archivo], { provenance: 'mecanica' });
    ev.escenarios[norm(archivo)].reason_code = 'RUNNER_NO_DETECTADO';
    return ev;
  }
  /* Python con backend/ corre desde ese directorio: el archivo se pasa relativo a él. */
  const cwd = opts.cwd || root;
  const argumento = cwd === root ? archivo : norm(path.relative(cwd, path.join(root, archivo)));
  const subject = opts.subject_hash || tdd.subjectHash(root);
  const r = tdd.runTests(comando, cwd, [argumento], { subject_hash: subject, execution_id: crypto.randomUUID() });
  return evidenciaDeCorrida(root, r, [archivo], { provenance: 'mecanica', explicito: true });
}

/** Un escenario cuenta como aprobado solo con PASS sobre el sujeto y la política. */
function aprobado(evidencia, archivo, sujeto, extra = {}) {
  if (!evidencia || !evidencia.escenarios) return false;
  const e = evidencia.escenarios[norm(archivo)];
  if (!e || !e.execution_id) return false;
  if (!extra.root) return false;
  const art = leerArtefacto(extra.root, e.execution_id);
  if (!art) return false;
  const delArt = art.escenarios && (art.escenarios[norm(archivo)] || art.escenarios[clave(archivo)]);
  if (delArt && delArt.status !== 'PASS') return false;
  if (e.status === 'PASS' && delArt && delArt.status !== 'PASS') return false;
  if (!delArt && e.status !== 'PASS') return false;
  if (delArt && e.status === 'PASS' && delArt.status === 'FAIL') return false;
  const v = validarArtefacto(extra.root, e.execution_id, {
    subject_hash: sujeto || e.subject_hash, policy_id: extra.policy_id || POLICY_ID, gate: extra.gate,
  });
  if (!v.ok) return false;
  if (sujeto && (delArt || e).subject_hash && (delArt || e).subject_hash !== sujeto) return false;
  if (((delArt && delArt.policy_id) || e.policy_id || evidencia.policy_id) !== POLICY_ID) return false;
  return (delArt ? delArt.status : e.status) === 'PASS';
}

module.exports = {
  POLICY_ID, STATUSES, norm, clave, idEscenario,
  descubrimiento, evidenciaDeCorrida, ejecutarEscenario, aprobado, ejecutadosSegunRunner,
  guardarArtefacto, leerArtefacto, validarArtefacto, PROVENANCE_OK,
};
