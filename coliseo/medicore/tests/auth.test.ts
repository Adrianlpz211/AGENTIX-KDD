import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signToken, verifyToken, hashPassword, verifyPassword } from '../src/lib/auth.ts';
import { authenticate } from '../src/middleware/authenticate.ts';
import { UnauthorizedError } from '../src/lib/errors.ts';

test('TOKEN: firma y verifica ida y vuelta', () => {
  const t = signToken({ userId: 'u1', tenantId: 'ten_1', role: 'admin' });
  const claims = verifyToken(t);
  assert.equal(claims.tenantId, 'ten_1');
  assert.equal(claims.role, 'admin');
});

test('TOKEN: firma manipulada → rechazada', () => {
  const t = signToken({ userId: 'u1', tenantId: 'ten_1', role: 'admin' });
  const tampered = t.slice(0, -2) + (t.endsWith('AA') ? 'BB' : 'AA');
  assert.throws(() => verifyToken(tampered));
});

test('TOKEN: expirado → rechazado', () => {
  const t = signToken({ userId: 'u1', tenantId: 'ten_1', role: 'admin' }, -1000);
  assert.throws(() => verifyToken(t));
});

test('MIDDLEWARE: sin Bearer → 401', () => {
  assert.throws(() => authenticate(undefined), UnauthorizedError);
  assert.throws(() => authenticate('Basic xyz'), UnauthorizedError);
});

test('PASSWORD: hash nunca guarda el claro y verifica bien', () => {
  const stored = hashPassword('secreto123');
  assert.ok(!stored.includes('secreto123'));
  assert.equal(verifyPassword('secreto123', stored), true);
  assert.equal(verifyPassword('otra', stored), false);
});
