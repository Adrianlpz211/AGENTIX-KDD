'use strict';

/**
 * Verificador REAL del director para `teams: ejecutar`. Hasta ahora `run` llamaba a tick sin verificador: una pasada vacía que
 * entregaba y recogía pero no verificaba nada. Aquí el DIRECTOR (no el constructor) corre sus propios comprobadores sobre el
 * sujeto exacto entregado y produce gate-results con evidencia real (gate-evidence.comprobar guarda el artefacto):
 *
 *   protected-files               manifiesto de archivos protegidos sobre los archivos de la tarea
 *   security                      escudo + checks de seguridad (secretos, PII, inyección, tenant) sobre esos archivos
 *   test-integrity                ningún título de test protegido desapareció (UNVERIFIED si no hay versión anterior que comparar)
 *   relevant-check, affected-tests, tests, tdd, full-suite
 *                                 el comando de pruebas del proyecto (una corrida por verificación)
 *
 * Todo gate requerido que NO tenga comprobador mecánico aquí (preservation, qa, qa-directed, blast-radius, …) devuelve UNVERIFIED
 * con motivo SIN_COMPROBADOR_TEAMS: no se inventa un PASS. La tarea queda VERIFYING (SIN_EVIDENCIA_SUFICIENTE) hasta que el director
 * aporte ese resultado con `akdd teams verify <id> --gates=<json>`. Eso es honestidad, no un hueco escondido.
 */

const tm = require('./teams-manager.cjs');
const gr = require('./gate-result.cjs');
const ev = require('./gate-evidence.cjs');

const GATES_DE_PRUEBAS = new Set(['relevant-check', 'affected-tests', 'tests', 'tdd', 'full-suite']);

function sinComprobador(gate, t) {
  return gr.createGateResult({ gate, status: 'UNVERIFIED', subject_hash: t.subject_hash, reason_code: 'SIN_COMPROBADOR_TEAMS', evidence: [] });
}

/**
 * `extra` permite añadir comprobadores propios por nombre de gate: `(ctx) => ({ status, assertions })` con ctx = { root, task, paths }.
 * Un comprobador que lanza se traduce en UNVERIFIED (nunca en PASS).
 */
function verificadorReal(root, { extra = {}, comando = null } = {}) {
  return (res) => {
    const t0 = tm.leerTarea(root, res.task_id);
    if (!t0) return [];
    /* En una revalidación el sujeto es el vigente (tras la corrección), no el de la entrega original. */
    const t = res.subject_hash && res.subject_hash !== t0.subject_hash ? Object.assign({}, t0, { subject_hash: res.subject_hash }) : t0;
    const paths = t.allowed_files;
    let corridaTests = null;
    const correrTests = () => {
      if (corridaTests) return corridaTests;
      const tdd = require('./tdd-gate.cjs');
      const cmd = comando || tdd.detectTestCommand(root);
      if (!cmd) return (corridaTests = { status: 'UNVERIFIED', reason: 'SIN_COMANDO_DE_TESTS' });
      const r = tdd.runTests(cmd, root);
      if (r.error) corridaTests = { status: 'ERROR', reason: String(r.error).slice(0, 80) };
      else if (r.allPassed && r.passed > 0) corridaTests = { status: 'PASS', assertions: r.passed };
      else if (r.failed > 0 || (r.exitCode != null && r.exitCode !== 0)) corridaTests = { status: 'FAIL', reason: 'TESTS_FALLAN' };
      else corridaTests = { status: 'UNVERIFIED', reason: 'SIN_TESTS_EJECUTADOS' };
      return corridaTests;
    };
    const comprobadores = {
      'protected-files': () => {
        const r = require('./protected-files.cjs').verificar(root, paths);
        return { status: r.status === 'PASS' ? 'PASS' : (r.status === 'ERROR' ? 'ERROR' : 'FAIL'), assertions: paths.length, reason_code: r.reason_code || null };
      },
      'test-integrity': () => {
        const r = require('./test-integrity-gate.cjs').evaluar(root, { files: paths, subject_hash: t.subject_hash });
        return { status: r.status === 'PASS' || r.status === 'FAIL' ? r.status : 'UNVERIFIED', assertions: Math.max(1, paths.length), reason: r.reason_code || null };
      },
      security: () => {
        const r = require('./security-gate.cjs').runSecurityGate(paths, root);
        return { status: r.passed ? 'PASS' : 'FAIL', assertions: (r.scanned || []).length, reason_code: r.passed ? null : 'SECURITY_CRITICAL' };
      },
    };
    for (const g of GATES_DE_PRUEBAS) comprobadores[g] = () => correrTests();
    for (const [g, fn] of Object.entries(extra || {})) comprobadores[g] = () => fn({ root, task: t, paths });
    return tm.gatesRequeridos(t).map((gate) => {
      const fn = comprobadores[gate];
      if (!fn) return sinComprobador(gate, t);
      try {
        const salida = () => {
          const r = fn();
          /* `comprobar` exige assertions > 0 para PASS y vuelve a hashear el sujeto: si cambió durante el check, queda UNVERIFIED. */
          return { status: r.status === 'PASS' || r.status === 'FAIL' ? r.status : 'UNVERIFIED', assertions: r.assertions || 0, reason: r.reason || r.reason_code || null };
        };
        const input = { gate, subject_hash: t.subject_hash };
        const g = ev.comprobar(root, input, { paths, checker: 'teams-verificador:' + gate, check: salida });
        return g;
      } catch (e) {
        return gr.createGateResult({ gate, status: 'UNVERIFIED', subject_hash: t.subject_hash, reason_code: String(e.message || e).slice(0, 80), evidence: [] });
      }
    });
  };
}

module.exports = { verificadorReal, GATES_DE_PRUEBAS };
