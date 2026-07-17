import { Table, newId, type Row } from '../../db/store.ts';
import type { PlanTier } from '../../config/business-rules.ts';
import type { TenantContext } from '../../lib/tenant-context.ts';
import { requirePlatform } from '../../middleware/require-role.ts';

export interface Tenant extends Row {
  name: string;
  plan: PlanTier;
  createdAt: number;
}

const tenants = new Table<Tenant>();

/** Crear un tenant es operación de PLATAFORMA (superadmin). */
export function createTenant(ctx: TenantContext, name: string, plan: PlanTier = 'free', now = Date.now()): Tenant {
  requirePlatform(ctx);
  const id = newId('ten');
  return tenants.insert({ id, tenantId: id, name, plan, createdAt: now });
}

export function getPlan(tenantId: string): PlanTier {
  const t = tenants._allUnsafe().find((x) => x.id === tenantId);
  return t?.plan ?? 'free';
}

export function seedTenant(name: string, plan: PlanTier, now = Date.now()): Tenant {
  const id = newId('ten');
  return tenants.insert({ id, tenantId: id, name, plan, createdAt: now });
}

export function _resetTenants(): void { tenants.clear(); }
