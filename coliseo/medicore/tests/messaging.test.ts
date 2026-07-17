import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSession, closeSession, _initCount, _resetSessions } from '../src/modules/messaging/session.manager.ts';

test('SESIÓN: dos aperturas CONCURRENTES → un solo init (no race)', async () => {
  _resetSessions();
  // Dispara dos aperturas a la vez, antes de que la primera resuelva.
  const [s1, s2] = await Promise.all([openSession('ten_1'), openSession('ten_1')]);
  assert.equal(s1.socketId, s2.socketId, 'ambas deben recibir la MISMA sesión');
  assert.equal(_initCount(), 1, 'debe haber ocurrido UN solo init real');
});

test('SESIÓN: reabrir tras cerrar crea una sesión nueva', async () => {
  _resetSessions();
  const a = await openSession('ten_1');
  closeSession('ten_1');
  const b = await openSession('ten_1');
  assert.notEqual(a.socketId, b.socketId);
  assert.equal(_initCount(), 2);
});

test('SESIÓN: tenants distintos tienen sesiones independientes', async () => {
  _resetSessions();
  const [a, b] = await Promise.all([openSession('ten_1'), openSession('ten_2')]);
  assert.notEqual(a.socketId, b.socketId);
  assert.equal(_initCount(), 2);
});
