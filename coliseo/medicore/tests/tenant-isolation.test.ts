import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patientRepo } from '../src/modules/patients/patient.repo.ts';
import { createPatient, getPatient, listPatients } from '../src/modules/patients/patient.service.ts';
import { seedTenant, _resetTenants } from '../src/modules/tenants/tenant.service.ts';
import type { TenantContext } from '../src/lib/tenant-context.ts';
import { NotFoundError } from '../src/lib/errors.ts';

function ctxFor(tenantId: string, role: TenantContext['role'] = 'admin'): TenantContext {
  return { userId: 'u_' + tenantId, tenantId, role };
}

test('AISLAMIENTO: un tenant NO ve pacientes de otro', () => {
  patientRepo._reset(); _resetTenants();
  const a = seedTenant('Clínica A', 'pro');
  const b = seedTenant('Clínica B', 'pro');

  createPatient(ctxFor(a.id), { name: 'Ana', email: 'ana@a.com', phone: '1' });
  createPatient(ctxFor(b.id), { name: 'Beto', email: 'beto@b.com', phone: '2' });

  assert.equal(listPatients(ctxFor(a.id)).length, 1);
  assert.equal(listPatients(ctxFor(a.id))[0].name, 'Ana');
  assert.equal(listPatients(ctxFor(b.id)).length, 1);
  assert.equal(listPatients(ctxFor(b.id))[0].name, 'Beto');
});

test('AISLAMIENTO: get por id de otro tenant → NotFound (no fuga)', () => {
  patientRepo._reset(); _resetTenants();
  const a = seedTenant('Clínica A', 'pro');
  const b = seedTenant('Clínica B', 'pro');
  const pa = createPatient(ctxFor(a.id), { name: 'Ana', email: 'ana@a.com', phone: '1' });

  assert.throws(() => getPatient(ctxFor(b.id), pa.id), NotFoundError);
});

test('REGLA: plan free topa en 50 pacientes', () => {
  patientRepo._reset(); _resetTenants();
  const free = seedTenant('Clínica Free', 'free');
  for (let i = 0; i < 50; i++) {
    createPatient(ctxFor(free.id), { name: 'P' + i, email: `p${i}@x.com`, phone: '0' });
  }
  assert.throws(() => createPatient(ctxFor(free.id), { name: 'P51', email: 'p51@x.com', phone: '0' }));
});
