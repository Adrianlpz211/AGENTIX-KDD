import type { TenantContext } from '../../lib/tenant-context.ts';
import { schedule, cancel, listByDoctor } from './appointment.service.ts';

export const appointmentRoutes = {
  'POST /appointments': (ctx: TenantContext, _p: unknown, body: { patientId: string; doctorId: string; start: number; end: number }) =>
    schedule(ctx, body),
  'DELETE /appointments/:id': (ctx: TenantContext, params: { id: string }) => cancel(ctx, params.id),
  'GET /doctors/:id/appointments': (ctx: TenantContext, params: { id: string }) => listByDoctor(ctx, params.id),
};
