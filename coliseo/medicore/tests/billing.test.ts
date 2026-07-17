import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issueInvoice, trialEndsAt, _resetInvoices } from '../src/modules/billing/invoice.service.ts';
import { BUSINESS_RULES } from '../src/config/business-rules.ts';
import type { TenantContext } from '../src/lib/tenant-context.ts';

const ctx: TenantContext = { userId: 'u1', tenantId: 'ten_1', role: 'admin' };

test('REGLA: el número de factura usa el prefijo MED-', () => {
  _resetInvoices();
  const inv = issueInvoice(ctx, { baseCents: 10000, yearly: false });
  assert.match(inv.number, /^MED-\d{6}$/);
});

test('REGLA: descuento anual = 20%', () => {
  _resetInvoices();
  const inv = issueInvoice(ctx, { baseCents: 10000, yearly: true });
  assert.equal(inv.amountCents, 8000); // 10000 * (1 - 0.20)
});

test('REGLA: el trial dura 14 días', () => {
  const signup = 0;
  const dias = trialEndsAt(signup) / (24 * 60 * 60 * 1000);
  assert.equal(dias, 14);
  assert.equal(BUSINESS_RULES.TRIAL_DAYS, 14);
});
