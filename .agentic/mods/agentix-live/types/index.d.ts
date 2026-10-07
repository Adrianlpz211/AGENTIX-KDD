/** Lo que la sesión lleva gastado, tal como lo reporta el host (nunca estimado). */
export type AgentixLiveUsage = {
  startedAt: number
  usd: number | null
  percent: number | null
  tokens: number | null
  window: number | null
  rateLimits: { kind: string; percentUsed: number }[]
}

/** El último turno del hilo principal: lo que costó y cuántas herramientas usó. */
export type AgentixLiveTurn = {
  at: number
  model: string
  durationMs: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  tools: number
}

/** Acumulado del ciclo `aa:` abierto (de `.agentic/_ciclo_actual.json`). */
export type AgentixLiveCycle = {
  cycleId: string
  tarea: string
  startedAt: string
  turns: number
  tools: number
  input: number
  output: number
  cacheRead: number
  usd: number
}

/** Lo que Agentix tiene escrito en disco ahora mismo (lectura pura, fail-soft). */
export type AgentixLiveState = {
  readAt: number
  tarea: { texto: string; trabajadoMs: number; sesiones: number } | null
  tdd: { area: string; status: string | null; passed: number; failed: number; at: string } | null
  guard: { allow: number; ask: number; deny: number } | null
  teams: string | null
  hasAgentix: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'agentix-live': {
      usage: AgentixLiveUsage | null
      lastTurn: AgentixLiveTurn | null
      tools: Record<string, number>
      cycle: AgentixLiveCycle | null
      agentix: AgentixLiveState | null
    }
  }
}
