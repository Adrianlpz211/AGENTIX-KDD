/**
 * AUTH — MediCore  ⚠️ ARCHIVO CRÍTICO (Security Gate)
 *
 * Crypto real de la stdlib de Node (scrypt para passwords, HMAC-SHA256 para el
 * token) — cero dependencias externas para que el Coliseo corra sin instalar
 * nada raro. NO es JWT de librería, pero el contrato es el mismo: firma +
 * verificación + expiración. Un token multi-tenant SIEMPRE lleva tenantId.
 *
 * Comportamiento PROTEGIDO (el Regression Guard debe cuidarlo):
 *  - verifyToken() rechaza firma inválida, token expirado y token sin tenantId.
 *  - hashPassword()/verifyPassword() nunca guardan el password en claro.
 */
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// En un producto real esto viene de process.env. Aquí es fijo para el Coliseo.
const SECRET = process.env.MEDICORE_SECRET || 'coliseo-demo-secret-no-usar-en-prod';

export interface TokenClaims {
  userId: string;
  tenantId: string;
  role: Role;
  exp: number; // epoch ms
}

export type Role = 'superadmin' | 'admin' | 'staff';

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}

export function signToken(claims: Omit<TokenClaims, 'exp'>, ttlMs = 3600_000, now = Date.now()): string {
  const full: TokenClaims = { ...claims, exp: now + ttlMs };
  const payload = b64url(JSON.stringify(full));
  const sig = createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyToken(token: string, now = Date.now()): TokenClaims {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) throw new Error('token mal formado');

  const expected = createHmac('sha256', SECRET).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('firma inválida');

  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as TokenClaims;
  if (!claims.tenantId) throw new Error('token sin tenantId'); // multi-tenant: obligatorio
  if (claims.exp < now) throw new Error('token expirado');
  return claims;
}

export function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const hash = scryptSync(plain, Buffer.from(saltHex, 'hex'), 32);
  const stored2 = Buffer.from(hashHex, 'hex');
  return hash.length === stored2.length && timingSafeEqual(hash, stored2);
}
