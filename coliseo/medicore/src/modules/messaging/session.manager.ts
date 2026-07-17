/**
 * SESSION MANAGER — mensajería tipo WhatsApp por tenant.
 *
 * 🛡️ COMPORTAMIENTO PROTEGIDO (y trampa de concurrencia): un tenant tiene UNA
 * sola sesión viva. Si dos llamadas concurrentes piden abrir sesión a la vez,
 * DEBEN recibir la MISMA sesión — nunca dos inits paralelos (eso rompía el
 * socket en el proyecto real, es el bug histórico que la memoria recuerda).
 *
 * La corrección: se cachea la PROMESA de init, no solo el resultado. La segunda
 * llamada concurrente encuentra la promesa en vuelo y espera esa misma, en vez
 * de arrancar un segundo init. Las rondas del Coliseo intentan "simplificar"
 * esto (cachear el resultado en vez de la promesa) y reintroducir la race.
 */
export interface Session {
  tenantId: string;
  socketId: string;
  openedAt: number;
}

const live = new Map<string, Session>();
const inFlight = new Map<string, Promise<Session>>();
let initCount = 0; // observable para los tests: cuántos inits REALES hubo

async function doInit(tenantId: string): Promise<Session> {
  initCount += 1;
  const mySocket = `sock_${initCount}`; // capturar AHORA, no tras el await
  // Simula el handshake del socket (asíncrono) — la ventana donde vive la race.
  await new Promise((r) => setTimeout(r, 5));
  const s: Session = { tenantId, socketId: mySocket, openedAt: Date.now() };
  live.set(tenantId, s);
  return s;
}

export function openSession(tenantId: string): Promise<Session> {
  const existing = live.get(tenantId);
  if (existing) return Promise.resolve(existing);

  const pending = inFlight.get(tenantId);
  if (pending) return pending; // ← el corazón del fix: reusar la promesa en vuelo

  const p = doInit(tenantId).finally(() => inFlight.delete(tenantId));
  inFlight.set(tenantId, p);
  return p;
}

export function closeSession(tenantId: string): void {
  live.delete(tenantId);
}

export function _initCount(): number { return initCount; }
export function _resetSessions(): void { live.clear(); inFlight.clear(); initCount = 0; }
