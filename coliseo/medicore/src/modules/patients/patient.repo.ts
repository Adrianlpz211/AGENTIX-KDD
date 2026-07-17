import { Table, newId, type Row } from '../../db/store.ts';
import type { TenantContext } from '../../lib/tenant-context.ts';

export interface Patient extends Row {
  name: string;
  email: string;
  phone: string;
  createdAt: number;
}

const patients = new Table<Patient>();

/**
 * REPO de pacientes.  🛡️ COMPORTAMIENTO PROTEGIDO: aislamiento de tenant.
 * TODAS las lecturas pasan por ctx.tenantId. No existe (a propósito) un método
 * que devuelva pacientes de todos los tenants. Si una tarea futura agrega uno
 * "para el panel de admin" sin filtrar, rompe el aislamiento — y eso es lo que
 * el Regression Guard + Security Gate deben atajar.
 */
export const patientRepo = {
  list(ctx: TenantContext): Patient[] {
    return patients.allForTenant(ctx.tenantId);
  },
  get(ctx: TenantContext, id: string): Patient | undefined {
    return patients.findForTenant(ctx.tenantId, id);
  },
  create(ctx: TenantContext, data: { name: string; email: string; phone: string }, now = Date.now()): Patient {
    return patients.insert({
      id: newId('pat'), tenantId: ctx.tenantId,
      name: data.name, email: data.email, phone: data.phone, createdAt: now,
    });
  },
  count(ctx: TenantContext): number {
    return patients.allForTenant(ctx.tenantId).length;
  },
  _reset(): void { patients.clear(); },
};
