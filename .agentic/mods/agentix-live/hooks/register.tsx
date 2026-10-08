import type { EngineInterface, Register } from 'claude-code'

import type {
  AgentixLiveCycle,
  AgentixLiveState,
  AgentixLiveTurn,
  AgentixLiveUsage,
} from '../types'

const PANE = 'agentix-live'
const PLUGIN = 'agentix-live'

// Referencias literales a los valores de $.state (declarados en types/index.d.ts).
// El motor exige que cada referencia de $.state sea un objeto con `plugin` y `key` como cadenas LITERALES, escrito en la llamada o en una
// const de este archivo (no un miembro como R.usage): así se pueden listar los valores que el módulo lee y escribe. Antes un
// `R.usage` hacía que el módulo NO cargara y ni /agentix ni el panel aparecían.
const R_USAGE = { plugin: 'agentix-live', key: 'usage' }
const R_LASTTURN = { plugin: 'agentix-live', key: 'lastTurn' }
const R_TOOLS = { plugin: 'agentix-live', key: 'tools' }
const R_CYCLE = { plugin: 'agentix-live', key: 'cycle' }
const R_AGENTIX = { plugin: 'agentix-live', key: 'agentix' }

// Archivos de estado que Agentix escribe solo (ninguno se inventa aquí).
const F = {
  ciclo: '.agentic/_ciclo_actual.json',
  tarea: '.agentic/_tarea_en_curso.json',
  tdd: '.agentic/_tdd_ultimo.json',
  guard: '.agentic/_hooks-eventos.jsonl',
  teams: '.legion/AUDITORIA-CURSOR.md',
  costo: '.agentic/grafo/costo-uso.cjs',
}
const MAX_READ = 3 * 1024 * 1024 // $.fs.read rechaza > 4 MiB; dejamos margen

// ─── utilidades puras ────────────────────────────────────────────────────────

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const miles = (v: number | null) =>
  v === null ? 'n/d' : String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
const usd = (v: number | null) => (v === null ? 'n/d' : `$${v.toFixed(2)}`)
const hms = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const pad = (x: number) => String(x).padStart(2, '0')
  return h > 0 ? `${h}h ${pad(m)}m` : `${m}m ${pad(s % 60)}s`
}
const barra = (pct: number | null, ancho: number) => {
  if (pct === null) return '░'.repeat(ancho)
  const lleno = Math.round((Math.min(100, Math.max(0, pct)) / 100) * ancho)
  return '█'.repeat(lleno) + '░'.repeat(ancho - lleno)
}
const corta = (s: string, max: number) => (s.length > max ? s.slice(0, Math.max(1, max - 1)) + '…' : s)
const cicloVacio = (c: { cycleId: string; tarea: string; startedAt: string }): AgentixLiveCycle => ({
  ...c,
  turns: 0,
  tools: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  usd: 0,
})

// ─── lecturas (host y disco) ─────────────────────────────────────────────────

async function leerJson($: EngineInterface, ruta: string): Promise<unknown> {
  try {
    if (!(await $.fs.exists(ruta))) return null
    return JSON.parse(await $.fs.read(ruta))
  } catch {
    return null
  }
}

async function leerUsage($: EngineInterface): Promise<AgentixLiveUsage | null> {
  try {
    const u = await $.session.usage()
    return {
      startedAt: u.startedAt,
      usd: u.cost?.usd ?? null,
      percent: u.context.percent ?? null,
      tokens: u.context.tokens ?? null,
      window: u.context.window ?? null,
      rateLimits: u.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed })),
    }
  } catch {
    return null
  }
}

/** El ciclo `aa:` abierto según Agentix: actor `default` o, si no, el primero. */
async function cicloAbierto($: EngineInterface) {
  const d = (await leerJson($, F.ciclo)) as Record<string, { cycle_id?: string; tarea?: string; started_at?: string }> | null
  if (!d || typeof d !== 'object') return null
  const c = d.default ?? Object.values(d)[0]
  return c && c.cycle_id ? { cycleId: c.cycle_id, tarea: c.tarea ?? '', startedAt: c.started_at ?? '' } : null
}

/** Lee lo que Agentix dejó en disco. Lo que falta es null, nunca 0. */
async function leerAgentix($: EngineInterface, desdeMs: number): Promise<AgentixLiveState> {
  const now = await $.clock.now()
  const hasAgentix = await $.fs.exists('.agentic')
  const out: AgentixLiveState = { readAt: now, tarea: null, tdd: null, guard: null, teams: null, hasAgentix }
  if (!hasAgentix) return out

  const marca = (await leerJson($, F.tarea)) as {
    actores?: Record<string, { abierta?: { tarea: string; sesiones: { inicio: string; fin: string | null }[] } | null }>
  } | null
  const actores = marca?.actores ?? {}
  const abierta = (actores.default ?? Object.values(actores)[0])?.abierta ?? null
  if (abierta) {
    let ms = 0
    for (const s of abierta.sesiones ?? []) ms += (s.fin ? Date.parse(s.fin) : now) - Date.parse(s.inicio)
    out.tarea = { texto: abierta.tarea, trabajadoMs: ms, sesiones: (abierta.sesiones ?? []).length }
  }

  const tdd = (await leerJson($, F.tdd)) as { area?: string; status?: string | null; passed?: number; failed?: number; finished_at?: string } | null
  if (tdd && tdd.finished_at) {
    out.tdd = { area: tdd.area ?? 'general', status: tdd.status ?? null, passed: n(tdd.passed), failed: n(tdd.failed), at: tdd.finished_at }
  }

  try {
    if (await $.fs.exists(F.guard)) {
      const st = await $.fs.stat(F.guard)
      if (st.size <= MAX_READ) {
        const g = { allow: 0, ask: 0, deny: 0 }
        for (const linea of (await $.fs.read(F.guard)).split('\n')) {
          if (!linea) continue
          try {
            const ev = JSON.parse(linea) as { at?: string; decision?: string }
            if (Date.parse(ev.at ?? '') < desdeMs) continue
            if (ev.decision === 'allow' || ev.decision === 'ask' || ev.decision === 'deny') g[ev.decision] += 1
          } catch {
            /* línea rota: se ignora */
          }
        }
        out.guard = g
      }
    }
  } catch {
    /* sin guardia legible */
  }

  try {
    if (await $.fs.exists(F.teams)) {
      const m = /ESTADO DEL CANAL:\s*\**\s*([A-ZÁÉÍÓÚ_]+)/i.exec(await $.fs.read(F.teams))
      out.teams = m ? m[1].toUpperCase() : 'DESCONOCIDO'
    }
  } catch {
    /* sin canal */
  }
  return out
}

/** Relee host y disco; el acumulado del ciclo sigue al ciclo, no a la sesión. */
async function refrescar($: EngineInterface) {
  const u = await leerUsage($)
  if (u) await $.state.set(R_USAGE, u)
  const a = await leerAgentix($, u?.startedAt ?? 0)
  await $.state.set(R_AGENTIX, a)
  const abierto = await cicloAbierto($)
  const prev = (await $.state.get(R_CYCLE)).value ?? null
  if (!abierto) {
    if (prev) await $.state.set(R_CYCLE, null)
  } else if (!prev || prev.cycleId !== abierto.cycleId) {
    await $.state.set(R_CYCLE, cicloVacio(abierto))
  }
}

/** Reporta a Agentix el uso REAL del turno con su propio normalizador (costo-uso.cjs). */
async function reportarAgentix($: EngineInterface, t: AgentixLiveTurn, c: AgentixLiveCycle | null) {
  try {
    if (!(await $.fs.exists(F.costo))) return
    const usage = JSON.stringify({
      input_tokens: t.input,
      output_tokens: t.output,
      cache_read_input_tokens: t.cacheRead,
      cache_creation_input_tokens: t.cacheWrite,
    })
    const argv = ['node', F.costo, 'registrar', '--provider=anthropic', `--usage=${usage}`, `--model=${t.model}`, `--ms=${t.durationMs}`]
    if (c) argv.push(`--cycle_id=${c.cycleId}`, `--tarea=${c.cycleId}`)
    await $.process.run(argv, { timeoutMs: 15000 })
  } catch {
    /* la telemetría es un extra: nunca frena el turno */
  }
}

// ─── registro ────────────────────────────────────────────────────────────────

export const register: Register = on => {
  let toolsEsteTurno = 0
  let avisoContexto = false
  let usdAnterior: number | null = null

  on('session.start', async ($, e, next) => {
    // Huella de vida: prueba en disco de que el módulo SÍ se ejecutó en esta sesión (y con qué host), sea cual sea lo que la interfaz dibuje.
    try {
      await $.fs.write('.agentic/_mod-vivo.json', JSON.stringify({ mod: 'agentix-live', evento: 'session.start', interactiva: !!e.isInteractive, en: await $.clock.now() }, null, 2))
    } catch {
      /* sin permiso de escritura: el panel sigue igual */
    }
    await $.command.register({
      name: 'agentix',
      description: 'Abre el panel Agentix en vivo (consumo de la sesión y estado del ciclo)',
    })
    if (e.isInteractive) {
      void $.ui.open({ id: PANE, title: 'Agentix' })
      $.clock.every(5000, () => {
        void refrescar($)
      })
      void refrescar($)
    }
    return next(e)
  })

  on('command.run', { command: 'agentix' }, async $ => {
    await refrescar($)
    await $.ui.open({ id: PANE, title: 'Agentix', focus: true })
    return { text: 'Panel Agentix abierto.' }
  })

  on('tool.call', async ($, e, next) => {
    toolsEsteTurno += 1
    const nombre = String(e.tool)
    const t = (await $.state.get(R_TOOLS)).value ?? {}
    await $.state.set(R_TOOLS, { ...t, [nombre]: (t[nombre] ?? 0) + 1 })
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const prev = (await $.state.get(R_USAGE)).value ?? null
    await $.state.set(R_USAGE, {
      startedAt: prev?.startedAt ?? 0,
      usd: e.cost?.usd ?? prev?.usd ?? null,
      percent: e.context.percent ?? prev?.percent ?? null,
      tokens: e.context.tokens ?? prev?.tokens ?? null,
      window: e.context.window ?? prev?.window ?? null,
      rateLimits: e.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed })),
    })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e) // los sub-agentes ya suman en el padre
    const herramientas = toolsEsteTurno
    toolsEsteTurno = 0
    const u = e.usage
    if (!u) return next(e)

    const t: AgentixLiveTurn = {
      at: await $.clock.now(),
      model: u.model,
      durationMs: e.durationMs,
      input: n(u.input_tokens),
      output: n(u.output_tokens),
      cacheRead: n(u.cache_read_input_tokens),
      cacheWrite: n(u.cache_creation_input_tokens),
      tools: herramientas,
    }
    await $.state.set(R_LASTTURN, t)

    const su = await leerUsage($)
    if (su) await $.state.set(R_USAGE, su)
    const usdAhora = su?.usd ?? null
    const usdTurno = usdAhora !== null && usdAnterior !== null ? Math.max(0, usdAhora - usdAnterior) : 0
    if (usdAhora !== null) usdAnterior = usdAhora

    const abierto = await cicloAbierto($)
    let acumulado: AgentixLiveCycle | null = null
    if (abierto) {
      const prev = (await $.state.get(R_CYCLE)).value ?? null
      const base = prev && prev.cycleId === abierto.cycleId ? prev : cicloVacio(abierto)
      acumulado = {
        ...base,
        turns: base.turns + 1,
        tools: base.tools + t.tools,
        input: base.input + t.input,
        output: base.output + t.output,
        cacheRead: base.cacheRead + t.cacheRead,
        usd: base.usd + usdTurno,
      }
      await $.state.set(R_CYCLE, acumulado)
      // Compactar a mitad de un ciclo pierde el hilo del ciclo: se avisa una vez.
      const pct = su?.percent ?? 0
      if (pct >= 80 && !avisoContexto) {
        avisoContexto = true
        $.ui.toast(`Contexto al ${pct}% con un ciclo aa: abierto — conviene cerrarlo antes de que compacte`, { timeoutMs: 8000 })
      }
    } else {
      await $.state.set(R_CYCLE, null)
    }
    if ((su?.percent ?? 0) < 70) avisoContexto = false

    void reportarAgentix($, t, acumulado)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const ancho = Math.max(24, e.props.bodyColumns - 2)
    const u = (await $.state.get(R_USAGE)).value ?? null
    const t = (await $.state.get(R_LASTTURN)).value ?? null
    const herr = (await $.state.get(R_TOOLS)).value ?? {}
    const c = (await $.state.get(R_CYCLE)).value ?? null
    const a = (await $.state.get(R_AGENTIX)).value ?? null
    const now = a?.readAt ?? 0
    const barraAncho = Math.max(8, Math.min(30, ancho - 18))
    const top = Object.entries(herr).sort((x, y) => y[1] - x[1]).slice(0, 5)
    const totalHerr = Object.values(herr).reduce((s, v) => s + v, 0)

    return (
      <Box flexDirection="column">
        <Text bold>SESIÓN</Text>
        <Text>
          {'  '}tiempo {u && now ? hms(now - u.startedAt) : 'n/d'}
          {'   '}gasto {usd(u?.usd ?? null)}
        </Text>
        <Text>
          {'  '}contexto {barra(u?.percent ?? null, barraAncho)} {u?.percent ?? 'n/d'}%
        </Text>
        <Text dimColor>
          {'  '}{miles(u?.tokens ?? null)} / {miles(u?.window ?? null)} tokens
          {u && u.rateLimits.length > 0 ? `   límites ${u.rateLimits.map(r => `${r.kind} ${r.percentUsed}%`).join(' · ')}` : ''}
        </Text>
        <Text> </Text>

        <Text bold>ÚLTIMO PEDIDO</Text>
        {t === null ? (
          <Text dimColor>{'  '}todavía ninguno</Text>
        ) : (
          <Box flexDirection="column">
            <Text>
              {'  '}entrada {miles(t.input)}{'  '}salida {miles(t.output)}{'  '}caché {miles(t.cacheRead)}
            </Text>
            <Text dimColor>
              {'  '}{hms(t.durationMs)} · {t.tools} herramientas · {corta(t.model, 28)}
            </Text>
          </Box>
        )}
        <Text> </Text>

        <Text bold>HERRAMIENTAS ({totalHerr})</Text>
        {top.length === 0 ? (
          <Text dimColor>{'  '}ninguna aún</Text>
        ) : (
          top.map(([nombre, veces]) => (
            <Text>
              {'  '}{String(veces).padStart(3)} {corta(nombre.replace(/^mcp__/, ''), ancho - 8)}
            </Text>
          ))
        )}
        <Text> </Text>

        <Text bold>AGENTIX</Text>
        {a && !a.hasAgentix && <Text dimColor>{'  '}esta carpeta no tiene .agentic</Text>}
        {c ? (
          <Box flexDirection="column">
            <Text color="green">{'  '}ciclo aa: {corta(c.tarea || c.cycleId, ancho - 14)}</Text>
            <Text>
              {'  '}{c.turns} pedidos · {c.tools} herr. · {miles(c.input + c.output)} tokens · {usd(c.usd)}
            </Text>
          </Box>
        ) : (
          a?.hasAgentix && <Text dimColor>{'  '}sin ciclo aa: abierto</Text>
        )}
        {a?.tarea && (
          <Text>
            {'  '}reloj {hms(a.tarea.trabajadoMs)} ({a.tarea.sesiones} sesión{a.tarea.sesiones === 1 ? '' : 'es'}) · {corta(a.tarea.texto, ancho - 26)}
          </Text>
        )}
        {a?.tdd && (
          <Text color={a.tdd.failed > 0 || a.tdd.status === 'FAIL' ? 'red' : undefined}>
            {'  '}TDD {a.tdd.area}: {a.tdd.status ?? 'sin veredicto'} · {a.tdd.passed} ok / {a.tdd.failed} fallan
          </Text>
        )}
        {a?.guard && (
          <Text>
            {'  '}guardia: {a.guard.allow} allow · {a.guard.ask} ask · <Text color={a.guard.deny > 0 ? 'red' : undefined}>{a.guard.deny} deny</Text>
          </Text>
        )}
        {a?.teams && <Text>{'  '}TEAMS: canal {a.teams}</Text>}
        <Text> </Text>
        <Box>
          <Button key="refrescar" label="Actualizar" hotkey="r" onPress={() => void refrescar($)} />
        </Box>
      </Box>
    )
  })
}
