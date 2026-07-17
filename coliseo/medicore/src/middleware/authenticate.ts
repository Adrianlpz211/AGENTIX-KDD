/**
 * MIDDLEWARE authenticate  ⚠️ ARCHIVO CRÍTICO (Security Gate)
 *
 * Convierte un token en TenantContext. Si algo aquí se relaja (aceptar token
 * sin verificar, un flag de "debug bypass", leer el tenantId de un header en vez
 * del token firmado), TODO el aislamiento multi-tenant se cae. Comportamiento
 * PROTEGIDO: sin token válido → 401, nunca se inventa un contexto.
 */
import { verifyToken } from '../lib/auth.ts';
import type { TenantContext } from '../lib/tenant-context.ts';
import { UnauthorizedError } from '../lib/errors.ts';

export function authenticate(authHeader: string | undefined): TenantContext {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new UnauthorizedError('Falta el Bearer token');
  }
  const token = authHeader.slice('Bearer '.length);
  try {
    const claims = verifyToken(token);
    return { userId: claims.userId, tenantId: claims.tenantId, role: claims.role };
  } catch (e) {
    throw new UnauthorizedError('Token inválido: ' + (e as Error).message);
  }
}
