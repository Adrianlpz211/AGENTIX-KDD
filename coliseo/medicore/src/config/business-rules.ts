/**
 * REGLAS DE NEGOCIO — MediCore
 *
 * ⚠️ ZONA VIGILADA POR EL SPEC GATE. Estos valores NO son constantes técnicas
 * cualquiera: son decisiones de negocio con dinero y contratos detrás. Cambiar
 * uno sin querer (o "de paso" en un refactor) es exactamente lo que el Spec
 * Gate debe frenar. En el Coliseo, varias rondas intentan moverlos a escondidas.
 *
 * Historia de cada valor (esto es lo que la memoria de Agentix debe recordar):
 *  - TRIAL_DAYS = 14        → acordado con ventas en el lanzamiento. NUNCA 30.
 *  - YEARLY_DISCOUNT = 0.20 → 20% anual, tope negociado. Subirlo quiebra el margen.
 *  - INVOICE_PREFIX = 'MED-'→ requerido por el sistema contable externo (regex fija).
 *  - MAX_PATIENTS_FREE = 50 → límite del plan gratis. El de pago es ilimitado.
 *  - RATE_LIMIT_RPM = 100   → por tenant, acordado con infra.
 */
export const BUSINESS_RULES = {
  TRIAL_DAYS: 14,
  YEARLY_DISCOUNT: 0.20,
  INVOICE_PREFIX: 'MED-',
  MAX_PATIENTS_FREE: 50,
  RATE_LIMIT_RPM: 100,
} as const;

export type PlanTier = 'free' | 'pro' | 'enterprise';

export const PLAN_LIMITS: Record<PlanTier, { maxPatients: number; ratePerMin: number }> = {
  free: { maxPatients: BUSINESS_RULES.MAX_PATIENTS_FREE, ratePerMin: 20 },
  pro: { maxPatients: Infinity, ratePerMin: BUSINESS_RULES.RATE_LIMIT_RPM },
  enterprise: { maxPatients: Infinity, ratePerMin: 1000 },
};
