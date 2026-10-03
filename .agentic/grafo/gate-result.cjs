'use strict';

/**
 * Resultado único de un gate. CLI, MCP, hooks y el controlador leen este
 * mismo objeto: un booleano suelto no cierra un ciclo.
 *
 * PASS solo sale si hay evidencia del sujeto exacto. SKIP, ERROR y
 * UNVERIFIED no se tratan como aprobación aunque blocking sea false.
 */

const STATUSES = new Set(['PASS', 'FAIL', 'SKIP', 'UNVERIFIED', 'ERROR']);
const SCOPES = new Set(['TASK', 'DEPENDENCY_CHAIN', 'GLOBAL']);

function evidenceDelSujeto(subjectHash, evidence) {
  if (!subjectHash || !Array.isArray(evidence) || evidence.length === 0) return false;
  return evidence.some((item) => item
    && item.subject_hash === subjectHash
    && typeof item.kind === 'string'
    && item.kind.length > 0);
}

function createGateResult(input) {
  if (!input || typeof input !== 'object') {
    throw new TypeError('gate result requiere un objeto');
  }
  if (!STATUSES.has(input.status)) {
    throw new TypeError('status de gate desconocido: ' + input.status);
  }
  if (input.scope && !SCOPES.has(input.scope)) {
    throw new TypeError('scope de gate desconocido: ' + input.scope);
  }

  let status = input.status;
  let reason = input.reason_code || null;
  const evidence = Array.isArray(input.evidence) ? input.evidence : [];

  if (status === 'PASS' && !evidenceDelSujeto(input.subject_hash, evidence)) {
    status = 'UNVERIFIED';
    reason = 'PASS_WITHOUT_SUBJECT_EVIDENCE';
  }

  const blocking = typeof input.blocking === 'boolean'
    ? input.blocking
    : status !== 'PASS';

  return {
    schema_version: 1,
    gate: input.gate,
    status,
    reason_code: reason,
    blocking,
    scope: input.scope || 'TASK',
    cycle_id: input.cycle_id || null,
    execution_id: input.execution_id || null,
    subject_hash: input.subject_hash || null,
    evidence,
    started_at: input.started_at || null,
    finished_at: input.finished_at || null,
    passed: status === 'PASS',
  };
}

function allowsVerifiedClose(result, context = {}) {
  if (!result || result.schema_version !== 1) return false;
  if (result.status !== 'PASS') return false;
  if (!evidenceDelSujeto(result.subject_hash, result.evidence) || !context.root || !result.execution_id) return false;
  const v = require('./escenarios.cjs').validarArtefacto(context.root, result.execution_id, { gate: context.gate || result.gate, subject_hash: result.subject_hash, cycle_id: context.cycle_id, paths: context.paths });
  return v.ok && !v.no_aplica;
}

module.exports = {
  STATUSES,
  SCOPES,
  createGateResult,
  allowsVerifiedClose,
  evidenceDelSujeto,
};
