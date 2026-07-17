import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schedule, cancel, _resetAppointments } from '../src/modules/appointments/appointment.service.ts';
import { ConflictError } from '../src/lib/errors.ts';
import type { TenantContext } from '../src/lib/tenant-context.ts';

const ctx: TenantContext = { userId: 'u1', tenantId: 'ten_1', role: 'admin' };
const otherTenant: TenantContext = { userId: 'u2', tenantId: 'ten_2', role: 'admin' };

test('CONFLICTO: no permite doble-booking del mismo doctor', () => {
  _resetAppointments();
  schedule(ctx, { patientId: 'p1', doctorId: 'doc1', start: 1000, end: 2000 });
  assert.throws(() => schedule(ctx, { patientId: 'p2', doctorId: 'doc1', start: 1500, end: 2500 }), ConflictError);
});

test('CONFLICTO: citas contiguas (no solapadas) SÍ se permiten', () => {
  _resetAppointments();
  schedule(ctx, { patientId: 'p1', doctorId: 'doc1', start: 1000, end: 2000 });
  assert.doesNotThrow(() => schedule(ctx, { patientId: 'p2', doctorId: 'doc1', start: 2000, end: 3000 }));
});

test('CONFLICTO: una cita cancelada libera el horario', () => {
  _resetAppointments();
  const a = schedule(ctx, { patientId: 'p1', doctorId: 'doc1', start: 1000, end: 2000 });
  cancel(ctx, a.id);
  assert.doesNotThrow(() => schedule(ctx, { patientId: 'p2', doctorId: 'doc1', start: 1500, end: 2500 }));
});

test('CONFLICTO: el solape se mide POR TENANT (otro tenant no colisiona)', () => {
  _resetAppointments();
  schedule(ctx, { patientId: 'p1', doctorId: 'doc1', start: 1000, end: 2000 });
  assert.doesNotThrow(() => schedule(otherTenant, { patientId: 'p9', doctorId: 'doc1', start: 1500, end: 2500 }));
});
