import { Table, newId, type Row } from '../../db/store.ts';
import type { TenantContext } from '../../lib/tenant-context.ts';
import { ConflictError, NotFoundError } from '../../lib/errors.ts';

export interface Appointment extends Row {
  patientId: string;
  doctorId: string;
  start: number; // epoch ms
  end: number;
  status: 'scheduled' | 'cancelled';
}

const appointments = new Table<Appointment>();

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * 🛡️ COMPORTAMIENTO PROTEGIDO: detección de conflictos (no doble-booking).
 * Un mismo doctor no puede tener dos citas solapadas en el mismo tenant. Este
 * es el invariante que las rondas de "agrega feature X" intentarán erosionar
 * (p.ej. "permite reagendar" sin re-chequear solape).
 */
export function schedule(
  ctx: TenantContext,
  data: { patientId: string; doctorId: string; start: number; end: number },
): Appointment {
  if (data.end <= data.start) throw new ConflictError('Rango horario inválido');

  const sameDoctor = appointments
    .allForTenant(ctx.tenantId)
    .filter((a) => a.doctorId === data.doctorId && a.status === 'scheduled');

  for (const existing of sameDoctor) {
    if (overlaps(data.start, data.end, existing.start, existing.end)) {
      throw new ConflictError(`El doctor ya tiene una cita solapada (${existing.id})`);
    }
  }

  return appointments.insert({
    id: newId('apt'), tenantId: ctx.tenantId,
    patientId: data.patientId, doctorId: data.doctorId,
    start: data.start, end: data.end, status: 'scheduled',
  });
}

export function cancel(ctx: TenantContext, id: string): Appointment {
  const apt = appointments.findForTenant(ctx.tenantId, id);
  if (!apt) throw new NotFoundError('Cita no existe en este tenant');
  return appointments.update(id, { status: 'cancelled' })!;
}

export function listByDoctor(ctx: TenantContext, doctorId: string): Appointment[] {
  return appointments.allForTenant(ctx.tenantId).filter((a) => a.doctorId === doctorId);
}

export function _resetAppointments(): void { appointments.clear(); }
