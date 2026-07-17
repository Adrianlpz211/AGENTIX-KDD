/**
 * Punto de montaje de MediCore. No abre un puerto real (el Coliseo no necesita
 * red); expone un router en memoria que el índice AST de Agentix lee como
 * endpoints, y demuestra el flujo completo: authenticate → require-role →
 * servicio → store, todo acotado por tenant.
 */
import { authenticate } from './middleware/authenticate.ts';
import { patientRoutes } from './modules/patients/patient.routes.ts';
import { appointmentRoutes } from './modules/appointments/appointment.routes.ts';
import { AppError } from './lib/errors.ts';

export const router = {
  ...patientRoutes,
  ...appointmentRoutes,
};

/** Despacha una petición ya con su Authorization header. Resuelve el ctx y llama al handler. */
export function handle(route: keyof typeof router, authHeader: string | undefined, params: any = {}, body: any = {}) {
  try {
    const ctx = authenticate(authHeader);
    const fn = router[route] as (c: any, p: any, b: any) => unknown;
    return { status: 200, data: fn(ctx, params, body) };
  } catch (e) {
    if (e instanceof AppError) return { status: e.status, error: e.message, code: e.code };
    return { status: 500, error: (e as Error).message };
  }
}

console.log('[MediCore] router montado con', Object.keys(router).length, 'endpoints');
