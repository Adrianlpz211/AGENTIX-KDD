import { Table, newId, type Row } from '../../db/store.ts';
import type { TenantContext } from '../../lib/tenant-context.ts';
import { BUSINESS_RULES } from '../../config/business-rules.ts';

export interface Invoice extends Row {
  number: string;
  amountCents: number;
  yearly: boolean;
  createdAt: number;
}

const invoices = new Table<Invoice>();
let counter = 0;

/**
 * Emisión de factura. Aplica las REGLAS DE NEGOCIO vigiladas por el Spec Gate:
 *  - prefijo de número = INVOICE_PREFIX (lo exige el contable externo).
 *  - descuento anual = YEARLY_DISCOUNT.
 * Las rondas del Coliseo intentan cambiar estos valores "de paso".
 */
export function issueInvoice(
  ctx: TenantContext,
  data: { baseCents: number; yearly: boolean },
  now = Date.now(),
): Invoice {
  counter += 1;
  const number = `${BUSINESS_RULES.INVOICE_PREFIX}${String(counter).padStart(6, '0')}`;
  const amountCents = data.yearly
    ? Math.round(data.baseCents * (1 - BUSINESS_RULES.YEARLY_DISCOUNT))
    : data.baseCents;

  return invoices.insert({
    id: newId('inv'), tenantId: ctx.tenantId,
    number, amountCents, yearly: data.yearly, createdAt: now,
  });
}

export function trialEndsAt(signupAt: number): number {
  return signupAt + BUSINESS_RULES.TRIAL_DAYS * 24 * 60 * 60 * 1000;
}

export function _resetInvoices(): void { invoices.clear(); counter = 0; }
