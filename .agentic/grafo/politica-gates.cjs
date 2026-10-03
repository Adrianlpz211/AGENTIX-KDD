'use strict';

/**
 * Política única de preservación por superficie afectada.
 *
 * La consultan el router de esfuerzo (y por él TEAMS y el controlador del
 * ciclo), así que aa:, sprint, TEAMS, CLI, MCP y hooks exigen lo mismo con el
 * mismo policy_id:
 *
 *   backend → preservation + test-integrity
 *   UI      → preservation + browser (+ visual si la vista tiene referencia aprobada)
 *
 * Un gate requerido solo cierra con PASS del mismo sujeto y la misma política.
 * NO_APLICA vale únicamente con una razón comprobable (superficie no tocada,
 * o selección completa sin escenarios protegidos), nunca por ser tarea LOW.
 */

const fs = require('fs');
const path = require('path');
const { POLICY_ID } = require('./escenarios.cjs');

const GATES_PRESERVACION = ['preservation', 'test-integrity', 'browser', 'visual', 'backend-contracts'];

const RE_TEST = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$/i;
const RE_DOC = /\.(md|mdx|txt|rst|adoc)$/i;
const RE_UI_EXT = /\.(html?|css|scss|sass|less|jsx|tsx|vue|svelte|astro)$/i;
const RE_UI_DIR = /(^|\/)(components?|pages|views|app|layouts?|public|static|styles?|ui|frontend|client|templates?)\//i;
const RE_CODIGO = /\.(c?js|mjs|ts|py|go|rb|php|java|kt|cs|rs|sql|prisma|graphql)$/i;
const RE_API = /(^|\/)((app|pages|src)\/)?api\/|(^|\/)route\.(ts|js|mjs|cjs)$/i;
const RE_PAGE = /(^|\/)(page|layout|template|error|loading|not-found)\.(tsx|jsx|ts|js)$/i;

const normal = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');

function hayContratos(root) {
  try {
    return fs.readdirSync(path.join(root, '.agentic', 'contratos'))
      .some((f) => f.endsWith('.json') && !f.startsWith('_'));
  } catch { return false; }
}

/** Clasifica cada archivo en ui, backend, tests, docs u otros. */
function superficies(paths) {
  const s = { ui: [], backend: [], tests: [], docs: [], otros: [] };
  for (const raw of paths || []) {
    const p = normal(raw);
    if (!p) continue;
    if (RE_TEST.test(p)) s.tests.push(p);
    else if (RE_DOC.test(p)) s.docs.push(p);
    else if (RE_API.test(p) && RE_CODIGO.test(p)) s.backend.push(p);
    else if (RE_UI_EXT.test(p) || RE_PAGE.test(p)) s.ui.push(p);
    else if (RE_UI_DIR.test(p) && /\.(c?js|mjs|ts)$/i.test(p)) {
      if (/(^|\/)(components?|pages|views|public|static|ui|frontend|client|templates?|layouts?)\//i.test(p)) s.ui.push(p);
      else { s.backend.push(p); s.ui.push(p); }
    }
    else if (RE_CODIGO.test(p)) s.backend.push(p);
    else s.otros.push(p);
  }
  return s;
}

function hayReferenciaAprobada(root) {
  if (!root) return false;
  const base = path.join(root, '.agentic', 'snapshots');
  let vistas = [];
  try { vistas = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return false; }
  return vistas.some((v) => {
    try {
      return fs.readdirSync(path.join(base, v.name), { withFileTypes: true })
        .some((d) => d.isDirectory() && fs.existsSync(path.join(base, v.name, d.name, 'aprobado.png')));
    } catch { return false; }
  });
}

/**
 * Gates de preservación que exige el cambio. Sin rutas no se sabe qué se
 * toca: se exige preservación, no se supone N/A.
 */
function gatesPorSuperficie(paths, opciones = {}) {
  const s = superficies(paths);
  const required = new Set();
  const no_aplica = [];
  const conocidas = s.ui.length + s.backend.length + s.tests.length + s.docs.length + s.otros.length;

  if (!conocidas) {
    required.add('preservation');
    return { policy_id: POLICY_ID, required: [...required], no_aplica, superficies: s, motivo: 'ALCANCE_DESCONOCIDO' };
  }
  if (s.backend.length || s.otros.length) {
    required.add('preservation');
    required.add('test-integrity');
    if (opciones.root && hayContratos(opciones.root)) required.add('backend-contracts');
  }
  if (s.tests.length) required.add('test-integrity');
  if (s.ui.length) {
    required.add('preservation');
    required.add('browser');
    if (hayReferenciaAprobada(opciones.root)) required.add('visual');
    else no_aplica.push({ gate: 'visual', razon: 'SIN_REFERENCIA_APROBADA' });
  } else {
    no_aplica.push({ gate: 'browser', razon: 'SIN_ARCHIVOS_DE_INTERFAZ' }, { gate: 'visual', razon: 'SIN_ARCHIVOS_DE_INTERFAZ' });
  }
  if (!required.has('preservation')) no_aplica.push({ gate: 'preservation', razon: s.docs.length && !s.tests.length ? 'SOLO_DOCUMENTACION' : 'SOLO_TESTS' });
  if (!required.has('test-integrity')) no_aplica.push({ gate: 'test-integrity', razon: 'SIN_CODIGO_NI_TESTS' });
  return { policy_id: POLICY_ID, required: [...required], no_aplica, superficies: s };
}

/**
 * ¿Este resultado permite cerrar el gate? PASS del mismo sujeto y política, o
 * NO_APLICA con razón comprobable. UNVERIFIED, ERROR, FAIL, SKIP o un sujeto
 * distinto nunca cierran.
 */
const RAZONES_NA = new Set(['SIN_ESCENARIOS_PROTEGIDOS', 'SIN_ARCHIVOS_DE_INTERFAZ', 'SIN_REFERENCIA_APROBADA', 'SOLO_DOCUMENTACION', 'SOLO_TESTS', 'SIN_CODIGO_NI_TESTS']);

function cierraGate(resultado, sujeto, ctx = {}) {
  if (!resultado) return { ok: false, reason_code: 'SIN_RESULTADO' };
  if (!resultado.policy_id) return { ok: false, reason_code: 'SIN_POLITICA' };
  if (resultado.policy_id !== POLICY_ID) return { ok: false, reason_code: 'POLITICA_DISTINTA' };
  if (sujeto && resultado.subject_hash && resultado.subject_hash !== sujeto) return { ok: false, reason_code: 'SUJETO_DISTINTO' };
  if (resultado.status === 'NO_APLICA') {
    if (!RAZONES_NA.has(resultado.reason_code)) return { ok: false, reason_code: 'NO_APLICA_SIN_RAZON' };
    const pol = ctx.policy || (ctx.paths || ctx.root != null ? gatesPorSuperficie(ctx.paths || [], { root: ctx.root }) : null);
    if (!pol) return { ok: false, reason_code: 'NO_APLICA_SIN_ALCANCE' };
    const naCalculada = (pol.no_aplica || []).some((n) => n.gate === resultado.gate && n.razon === resultado.reason_code);
    const escenariosVacios = resultado.reason_code === 'SIN_ESCENARIOS_PROTEGIDOS' || resultado.reason_code === 'SIN_ESCENARIOS_RELACIONADOS';
    if (escenariosVacios) {
      if (!ctx.root || !resultado.execution_id) return { ok: false, reason_code: 'NO_APLICA_SIN_ARTEFACTO' };
      const v = require('./escenarios.cjs').validarArtefacto(ctx.root, resultado.execution_id, {
        subject_hash: sujeto || resultado.subject_hash, policy_id: POLICY_ID, gate: resultado.gate, cycle_id: ctx.cycle_id,
      });
      if (!v.ok) return { ok: false, reason_code: v.reason_code };
      const esperados = (v.artifact.expected || []).length;
      if (esperados > 0) return { ok: false, reason_code: 'NO_APLICA_CON_ESCENARIOS' };
      return { ok: true, no_aplica: true };
    }
    if (!naCalculada) return { ok: false, reason_code: 'NO_APLICA_NO_CALCULADO' };
    if (resultado.reason_code === 'SIN_REFERENCIA_APROBADA' && ctx.requiere_referencia) {
      return { ok: false, reason_code: 'REFERENCIA_REQUERIDA' };
    }
    return { ok: true, no_aplica: true };
  }
  if (resultado.status !== 'PASS') return { ok: false, reason_code: 'NO_PASS:' + (resultado.status || 'DESCONOCIDO') };
  if (!resultado.execution_id) return { ok: false, reason_code: 'SIN_EJECUCION' };
  if (sujeto && !resultado.subject_hash) return { ok: false, reason_code: 'SIN_SUJETO' };
  if (!ctx.root) return { ok: false, reason_code: 'SIN_ARTEFACTO' };
  const v = require('./escenarios.cjs').validarArtefacto(ctx.root, resultado.execution_id, {
    subject_hash: sujeto || resultado.subject_hash, policy_id: POLICY_ID, gate: resultado.gate, cycle_id: ctx.cycle_id,
  });
  if (!v.ok) return { ok: false, reason_code: v.reason_code };
  return { ok: true };
}

module.exports = { POLICY_ID, GATES_PRESERVACION, superficies, gatesPorSuperficie, cierraGate, RAZONES_NA };

if (require.main === module) {
  const files = process.argv.slice(2);
  console.log(JSON.stringify(gatesPorSuperficie(files, { root: process.cwd() }), null, 2));
}
