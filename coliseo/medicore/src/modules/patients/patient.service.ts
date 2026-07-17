import { patientRepo, type Patient } from './patient.repo.ts';
import type { TenantContext } from '../../lib/tenant-context.ts';
import { getPlan } from '../tenants/tenant.service.ts';
import { PLAN_LIMITS } from '../../config/business-rules.ts';
import { RuleViolationError, NotFoundError } from '../../lib/errors.ts';

export function listPatients(ctx: TenantContext): Patient[] {
  return patientRepo.list(ctx);
}

export function getPatient(ctx: TenantContext, id: string): Patient {
  const p = patientRepo.get(ctx, id);
  if (!p) throw new NotFoundError('Paciente no existe en este tenant');
  return p;
}

export function createPatient(ctx: TenantContext, data: { name: string; email: string; phone: string }): Patient {
  // Regla de negocio: el plan free topa en MAX_PATIENTS_FREE pacientes.
  const plan = getPlan(ctx.tenantId);
  const limit = PLAN_LIMITS[plan].maxPatients;
  if (patientRepo.count(ctx) >= limit) {
    throw new RuleViolationError(`Plan ${plan}: límite de ${limit} pacientes alcanzado`);
  }
  return patientRepo.create(ctx, data);
}
