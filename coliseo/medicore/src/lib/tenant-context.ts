import type { Role } from './auth.ts';

/**
 * El contexto que viaja con CADA operación. Es la columna vertebral del
 * aislamiento multi-tenant: ninguna consulta de datos de tenant debe correr
 * sin uno de estos. Los repos lo exigen por tipo.
 */
export interface TenantContext {
  userId: string;
  tenantId: string;
  role: Role;
}

/** superadmin = plataforma (cruza tenants). admin = dueño de SU tenant. staff = operativo. */
export function isPlatformAdmin(ctx: TenantContext): boolean {
  return ctx.role === 'superadmin';
}
