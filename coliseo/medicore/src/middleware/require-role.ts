/**
 * MIDDLEWARE require-role  ⚠️ ARCHIVO SENSIBLE (Security Gate)
 *
 * La frontera de privilegios. Distinción CLAVE que el Coliseo ataca:
 *   - admin      = manda en SU tenant.
 *   - superadmin = manda en la PLATAFORMA (puede cruzar tenants).
 * Confundirlas — proteger una operación cross-tenant con 'admin' en vez de
 * 'superadmin' — es una escalada de privilegios silenciosa. El Security Gate
 * y la memoria deben cuidar esta línea.
 */
import type { TenantContext } from '../lib/tenant-context.ts';
import { ForbiddenError } from '../lib/errors.ts';
import type { Role } from '../lib/auth.ts';

const RANK: Record<Role, number> = { staff: 1, admin: 2, superadmin: 3 };

export function requireRole(ctx: TenantContext, min: Role): void {
  if (RANK[ctx.role] < RANK[min]) {
    throw new ForbiddenError(`Requiere rol ${min}, tienes ${ctx.role}`);
  }
}

/** Operaciones que cruzan tenants: SOLO plataforma. Nunca 'admin'. */
export function requirePlatform(ctx: TenantContext): void {
  if (ctx.role !== 'superadmin') {
    throw new ForbiddenError('Operación de plataforma: requiere superadmin');
  }
}
