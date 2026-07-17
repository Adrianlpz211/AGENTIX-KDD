/**
 * Rutas HTTP de pacientes (estilo Express, sin framework — el "router" es un
 * mapa para que el índice AST detecte endpoints). Cada handler recibe el
 * TenantContext ya resuelto por el middleware authenticate.
 */
import type { TenantContext } from '../../lib/tenant-context.ts';
import { listPatients, getPatient, createPatient } from './patient.service.ts';

export const patientRoutes = {
  'GET /patients': (ctx: TenantContext) => listPatients(ctx),
  'GET /patients/:id': (ctx: TenantContext, params: { id: string }) => getPatient(ctx, params.id),
  'POST /patients': (ctx: TenantContext, _p: unknown, body: { name: string; email: string; phone: string }) =>
    createPatient(ctx, body),
};
