/**
 * Agentic KDD — Harness v1.0
 * Motor PRE/EXEC/POST de enforcement determinista para el pipeline aa:
 *
 * PRINCIPIO: "El modelo propone, el harness verifica."
 * Ningún paso avanza sin que el harness haya validado su postcondición.
 *
 * Cinco capas:
 *   (a) Reglas re-inyectadas por paso (importadas desde harness-rules.md)
 *   (b) Gates deterministas (schema + asserts) — esta capa
 *   (c) Restricción de acciones (allowlist/denylist por paso)
 *   (d) Detección de desviación (scope + predicción)
 *   (e) Fallback estructurado (retry → abort → escalate)
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── TIPOS DE RESULTADO ────────────────────────────────────────────────────────

/** @typedef {{ ok: true }} PassResult */
/** @typedef {{ ok: false, reason: string, retry: boolean, abort: boolean }} FailResult */
/** @typedef {PassResult | FailResult} GateResult */

const pass = () => ({ ok: true });
const block = (reason) => ({ ok: false, reason, retry: false, abort: true });
const retry = (reason) => ({ ok: false, reason, retry: true, abort: false });
const escalate = (reason) => ({ ok: false, reason, retry: false, abort: false, escalate: true });

// ─── SCHEMA VALIDATION (zod-lite, sin dependencias) ───────────────────────────

/**
 * Valida un objeto contra un schema definido como objeto de validadores.
 * @param {object} obj - objeto a validar
 * @param {object} schema - {campo: validator_fn}
 * @returns {{ valid: boolean, errors: string[] }}
 */
function assertSchema(obj, schema) {
  const errors = [];
  for (const [field, validator] of Object.entries(schema)) {
    const result = validator(obj[field], field);
    if (result !== true) errors.push(result);
  }
  return { valid: errors.length === 0, errors };
}

// Validators reutilizables
const v = {
  required:      (val, f) => val !== undefined && val !== null ? true : `${f}: requerido`,
  string:        (val, f) => typeof val === 'string' ? true : `${f}: debe ser string`,
  boolean:       (val, f) => typeof val === 'boolean' ? true : `${f}: debe ser boolean`,
  array:         (val, f) => Array.isArray(val) ? true : `${f}: debe ser array`,
  minArray: (n) => (val, f) => Array.isArray(val) && val.length >= n ? true : `${f}: debe tener al menos ${n} elemento(s)`,
  literal: (x)  => (val, f) => val === x ? true : `${f}: debe ser exactamente '${x}'`,
  oneOf: (xs)   => (val, f) => xs.includes(val) ? true : `${f}: debe ser uno de [${xs.join(', ')}]`,
  optional:      (_val, _f) => true,
  truthy:        (val, f) => val ? true : `${f}: debe ser truthy`,
};

// ─── DEFINICIÓN DE GATES POR PASO ─────────────────────────────────────────────

/**
 * Cada gate define:
 *   name        — nombre del paso
 *   agent       — agente responsable
 *   pre         — función PRE: valida que el contexto está listo para ejecutar
 *   post        — función POST: valida que el output prueba cumplimiento
 *   allowlist   — archivos/rutas permitidas (null = sin restricción)
 *   denylist    — archivos/rutas prohibidas
 */
const GATE_DEFINITIONS = {

  // ── PASO 0: Context Guard ──────────────────────────────────────────────────
  context_guard: {
    name: 'Context Guard',
    agent: '00-setup / 01-orquestador',
    pre: (ctx) => {
      if (!ctx.task || typeof ctx.task !== 'string' || ctx.task.length < 3)
        return block('Context Guard PRE: tarea no definida o demasiado corta');
      if (!ctx.project_root)
        return block('Context Guard PRE: project_root no definido');
      return pass();
    },
    post: (output) => {
      const schema = {
        scope_confirmed: v.boolean,
        concepts: v.array,
        is_project_related: v.boolean,
      };
      const { valid, errors } = assertSchema(output, schema);
      if (!valid) return block(`Context Guard POST: ${errors.join('; ')}`);
      if (!output.is_project_related)
        return block('Context Guard POST: tarea fuera del scope del proyecto — STOP');
      return pass();
    },
    allowlist: null,
    denylist: [],
  },

  // ── PASO 1: Analista ───────────────────────────────────────────────────────
  analyst: {
    name: 'Analista',
    agent: '02-analista',
    pre: (ctx) => {
      if (!ctx.task) return block('Analyst PRE: tarea no definida');
      if (!ctx.config_loaded) return block('Analyst PRE: config.md no cargado');
      return pass();
    },
    post: (output) => {
      const schema = {
        plan: v.required,
        phases: v.minArray(1),
        area_kdd: v.string,
        spec_file: v.optional,
      };
      const { valid, errors } = assertSchema(output, schema);
      if (!valid) return block(`Analyst POST: ${errors.join('; ')}`);
      // Gate: el plan no puede salirse de la spec si existe
      if (output.spec_file && output.spec_violated)
        return block('Analyst POST: el plan contradice la spec existente del módulo');
      return pass();
    },
    allowlist: null,
    denylist: [],
  },

  // ── PASO 2/3: Front / Back Agent ──────────────────────────────────────────
  implementation: {
    name: 'Front/Back',
    agent: '03-front / 04-back',
    pre: (ctx) => {
      if (!ctx.plan) return block('Implementation PRE: plan no existe — ejecutar Analyst primero');
      if (!ctx.allowed_files || !Array.isArray(ctx.allowed_files))
        return block('Implementation PRE: allowed_files no definidos en el plan');
      return pass();
    },
    post: (output) => {
      const schema = {
        files_touched: v.minArray(1),
        diff_summary: v.string,
        within_scope: v.boolean,
      };
      const { valid, errors } = assertSchema(output, schema);
      if (!valid) return retry(`Implementation POST: ${errors.join('; ')}`);
      if (!output.within_scope)
        return block('Implementation POST: archivos tocados fuera del scope del plan — STOP');
      return pass();
    },
    allowlist: null, // se llena desde ctx.allowed_files en tiempo de ejecución
    denylist: ['.agentic/grafo/', '.agentic/agentes/', 'node_modules/'],
  },

  // ── PASO 4: TDD + Self-Healing ─────────────────────────────────────────────
  tdd: {
    name: 'TDD + Self-Healing',
    agent: '06-tdd',
    pre: (ctx) => {
      if (!ctx.test_command) return block('TDD PRE: test_command no definido en config.md');
      if (!ctx.implementation_done) return block('TDD PRE: implementación no completada — ejecutar Front/Back primero');
      return pass();
    },
    post: (output) => {
      // GATE DURO: tests deben EXISTIR y PASAR
      const schema = {
        tests_found: v.minArray(1),
        tests_passing: v.truthy,
        all_passed: v.boolean,
        iterations: v.required,
      };
      const { valid, errors } = assertSchema(output, schema);
      if (!valid) return block(`TDD POST: ${errors.join('; ')}`);

      if (output.tests_found.length === 0)
        return block('TDD POST ⛔ GATE DURO: No existen tests. Crear tests es OBLIGATORIO antes de avanzar.');
      if (!output.all_passed)
        return block(`TDD POST ⛔ GATE DURO: Tests fallando: ${output.failing_tests?.join(', ')}. No se avanza sin tests en verde.`);
      if (output.iterations > 3)
        return block('TDD POST: Se superó el máximo de 3 iteraciones de self-healing — STOP con reporte.');
      return pass();
    },
    allowlist: null,
    denylist: [],
  },

  // ── PASO 5: QA ─────────────────────────────────────────────────────────────
  qa: {
    name: 'QA',
    agent: '05-qa',
    pre: (ctx) => {
      if (!ctx.tdd_passed) return block('QA PRE ⛔: TDD no completado — no se puede ejecutar QA sin tests en verde');
      return pass();
    },
    post: (output) => {
      // GATE DURO: QA no es opinión del agente, es un assert
      const schema = {
        acceptance_criteria_checked: v.boolean,
        full_suite_passed: v.boolean,
        regressions: v.array,
        qa_verdict: v.oneOf(['PASS', 'FAIL', 'WARN']),
      };
      const { valid, errors } = assertSchema(output, schema);
      if (!valid) return block(`QA POST: ${errors.join('; ')}`);

      if (!output.acceptance_criteria_checked)
        return block('QA POST ⛔ GATE DURO: Criterios de aceptación no verificados. QA no completado.');
      if (!output.full_suite_passed)
        return block(`QA POST ⛔ GATE DURO: Suite completa no pasa. Regresiones: ${output.regressions?.join(', ')}`);
      if (output.qa_verdict === 'FAIL')
        return block('QA POST ⛔: QA verdict = FAIL. No se avanza.');
      return pass();
    },
    allowlist: null,
    denylist: [],
  },

  // ── PASO 6: ag:review ──────────────────────────────────────────────────────
  review: {
    name: 'ag:review',
    agent: 'pro/ag-review',
    pre: (ctx) => {
      if (!ctx.qa_passed) return block('Review PRE: QA no completado — no se puede hacer review sin QA en verde');
      return pass();
    },
    post: (output) => {
      const schema = {
        blockers: v.array,
        required: v.array,
        review_verdict: v.oneOf(['CLEAN', 'BLOCKERS', 'REQUIRED']),
      };
      const { valid, errors } = assertSchema(output, schema);
      if (!valid) return block(`Review POST: ${errors.join('; ')}`);

      if (output.review_verdict === 'BLOCKERS')
        return block(`Review POST: BLOCKERS detectados — ${output.blockers.join('; ')}`);
      // REQUIRED no bloquea, pero se incluye en el reporte
      return pass();
    },
    allowlist: null,
    denylist: [],
  },

  // ── PASO 7: Memoria ────────────────────────────────────────────────────────
  memory: {
    name: 'Memoria',
    agent: '07-memoria',
    pre: (ctx) => {
      if (!ctx.review_done) return block('Memory PRE: Review no completado — memoria solo se sincroniza después de review');
      return pass();
    },
    post: (output) => {
      const schema = {
        episodio_registrado: v.boolean,
        grafo_synced: v.boolean,
        specs_updated: v.array,
      };
      const { valid, errors } = assertSchema(output, schema);
      if (!valid) return retry(`Memory POST: ${errors.join('; ')}`);
      if (!output.grafo_synced)
        return retry('Memory POST: grafo no sincronizado — reintentar sync');
      return pass();
    },
    allowlist: ['.agentic/', '_output/'],
    denylist: [],
  },
};

// ─── MOTOR DE EJECUCIÓN DE PASOS ──────────────────────────────────────────────

/**
 * Envuelve la ejecución de un paso en el ciclo PRE → EXEC → POST.
 * Si el POST falla → retry o abort según el GateResult.
 *
 * @param {string} gateKey - clave en GATE_DEFINITIONS
 * @param {object} ctx - contexto del ciclo actual
 * @param {Function} execFn - async () => output: la función que ejecuta el agente
 * @param {object} [opts] - { maxRetries: number, onRetry: Function, onAbort: Function }
 * @returns {Promise<{ success: boolean, output: object, gate: GateResult, attempts: number }>}
 */
async function ejecutarPaso(gateKey, ctx, execFn, opts = {}) {
  const gate = GATE_DEFINITIONS[gateKey];
  if (!gate) throw new Error(`Gate '${gateKey}' no definido en harness`);

  const maxRetries = opts.maxRetries ?? 3;
  let attempt = 0;

  // ── PRE-GATE ──────────────────────────────────────────────────────────────
  const preResult = gate.pre(ctx);
  if (!preResult.ok) {
    _logGate(gate.name, 'PRE', preResult);
    if (opts.onAbort) opts.onAbort(preResult);
    return { success: false, output: null, gate: preResult, attempts: 0 };
  }
  _logGate(gate.name, 'PRE', preResult);

  // ── ACTION RESTRICTION CHECK ──────────────────────────────────────────────
  if (gate.denylist && gate.denylist.length > 0) {
    ctx._denylist = gate.denylist;
  }
  if (gate.allowlist) {
    ctx._allowlist = gate.allowlist;
  }

  // ── EXEC + POST LOOP ──────────────────────────────────────────────────────
  while (attempt < maxRetries) {
    attempt++;
    let output;

    try {
      output = await execFn(ctx, attempt);
    } catch (err) {
      const failResult = retry(`${gate.name} EXEC error (intento ${attempt}): ${err.message}`);
      _logGate(gate.name, 'EXEC', failResult, attempt);
      if (attempt >= maxRetries) {
        if (opts.onAbort) opts.onAbort(failResult);
        return { success: false, output: null, gate: failResult, attempts: attempt };
      }
      if (opts.onRetry) opts.onRetry(failResult, attempt);
      continue;
    }

    // ── POST-GATE ────────────────────────────────────────────────────────────
    const postResult = gate.post(output);
    _logGate(gate.name, 'POST', postResult, attempt);

    if (postResult.ok) {
      return { success: true, output, gate: postResult, attempts: attempt };
    }

    if (postResult.abort) {
      if (opts.onAbort) opts.onAbort(postResult);
      return { success: false, output, gate: postResult, attempts: attempt };
    }

    if (postResult.retry && attempt < maxRetries) {
      if (opts.onRetry) opts.onRetry(postResult, attempt);
      // Devolver el error al contexto para el próximo intento
      ctx._last_gate_error = postResult.reason;
      continue;
    }

    // Sin más reintentos
    if (opts.onAbort) opts.onAbort(postResult);
    return { success: false, output, gate: postResult, attempts: attempt };
  }

  const exhaustedResult = block(`${gate.name}: máximo de ${maxRetries} intentos agotado sin pasar el gate`);
  if (opts.onAbort) opts.onAbort(exhaustedResult);
  return { success: false, output: null, gate: exhaustedResult, attempts: maxRetries };
}

// ─── DEVIATION DETECTION (Capa d) ─────────────────────────────────────────────

/**
 * Verifica que los archivos que el agente intenta tocar están dentro del
 * scope declarado en el plan. Bloquea antes de actuar si hay desviación.
 *
 * @param {string[]} attempted_files - archivos que el agente propone tocar
 * @param {string[]} allowed_files - archivos declarados en el plan
 * @param {string[]} [denylist] - patrones siempre prohibidos
 * @returns {GateResult}
 */
function checkScopeDeviation(attempted_files, allowed_files, denylist = []) {
  const out_of_scope = attempted_files.filter(f => {
    const inAllowed = allowed_files.some(a =>
      f.startsWith(a) || f === a || path.normalize(f).startsWith(path.normalize(a))
    );
    const inDenied = denylist.some(d => f.includes(d));
    return !inAllowed || inDenied;
  });

  if (out_of_scope.length > 0) {
    return block(`Scope Deviation ⛔: archivos fuera del plan detectados: ${out_of_scope.join(', ')}. Detener antes de actuar.`);
  }
  return pass();
}

// ─── PIPELINE COMPLETO aa: ────────────────────────────────────────────────────

/**
 * Estado del pipeline para tracking del ciclo completo.
 */
class PipelineState {
  constructor(task, projectRoot) {
    this.task = task;
    this.project_root = projectRoot;
    this.steps_completed = [];
    this.steps_failed = [];
    this.current_step = null;
    this.gate_log = [];
    this.config_loaded = false;
    this.implementation_done = false;
    this.tdd_passed = false;
    this.qa_passed = false;
    this.review_done = false;
    this.allowed_files = [];
    this.test_command = null;
    this.plan = null;
    this._last_gate_error = null;
  }

  markStep(stepName, success, gateResult) {
    if (success) this.steps_completed.push(stepName);
    else this.steps_failed.push({ step: stepName, reason: gateResult.reason });
    this.gate_log.push({ step: stepName, ok: success, reason: gateResult.reason ?? null });
  }

  // Setters de estado cross-step
  setConfigLoaded()        { this.config_loaded = true; }
  setImplementationDone()  { this.implementation_done = true; }
  setTDDPassed()           { this.tdd_passed = true; }
  setQAPassed()            { this.qa_passed = true; }
  setReviewDone()          { this.review_done = true; }
  setPlan(plan)            { this.plan = plan; }
  setAllowedFiles(files)   { this.allowed_files = files; }
  setTestCommand(cmd)      { this.test_command = cmd; }

  hasFailed() { return this.steps_failed.length > 0; }

  summary() {
    return {
      task: this.task,
      completed: this.steps_completed,
      failed: this.steps_failed,
      gate_log: this.gate_log,
      success: !this.hasFailed(),
    };
  }
}

// ─── REPORTING ────────────────────────────────────────────────────────────────

function _logGate(stepName, phase, result, attempt) {
  const icon = result.ok ? '✅' : (result.abort ? '⛔' : '🔄');
  const attemptStr = attempt ? ` (intento ${attempt})` : '';
  const msg = result.ok
    ? `${icon} ${stepName} ${phase}${attemptStr}: PASS`
    : `${icon} ${stepName} ${phase}${attemptStr}: ${result.reason}`;
  console.log(`[HARNESS] ${msg}`);
}

function generateHarnessReport(state) {
  const s = state.summary();
  const lines = [
    '',
    '═══════════════════════════════════════════════════',
    '  HARNESS REPORT — Agentic KDD',
    '═══════════════════════════════════════════════════',
    `  Tarea:      ${s.task}`,
    `  Resultado:  ${s.success ? '✅ COMPLETADO' : '🛑 STOP'}`,
    `  Completados: ${s.completed.join(' → ') || 'ninguno'}`,
    '',
  ];

  if (s.failed.length > 0) {
    lines.push('  ── FALLOS ──────────────────────────────────────');
    s.failed.forEach(f => lines.push(`  ⛔ ${f.step}: ${f.reason}`));
    lines.push('');
    lines.push('  Acción requerida: revisar el fallo e intervenir.');
  }

  lines.push('  ── GATE LOG ─────────────────────────────────────');
  s.gate_log.forEach(g => {
    const icon = g.ok ? '✅' : '⛔';
    lines.push(`  ${icon} ${g.step}${g.reason ? ': ' + g.reason : ''}`);
  });
  lines.push('═══════════════════════════════════════════════════');

  return lines.join('\n');
}

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

module.exports = {
  // Core
  ejecutarPaso,
  GATE_DEFINITIONS,
  PipelineState,
  // Validators
  assertSchema,
  v,
  // Results
  pass, block, retry, escalate,
  // Utilities
  checkScopeDeviation,
  generateHarnessReport,
};
