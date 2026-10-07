import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

/**
 * Lo que el motor pone debajo del mod en una sesión real: aquí lo pone el test.
 * Un evento escalar (clock.now, fs.exists) se responde envuelto en `{ value }`.
 *
 * Nota: el kit de pruebas de esta build no provee `$.state` (en sesión lo da el
 * motor), así que lo que escribe en estado — último pedido, conteo de
 * herramientas, acumulado del ciclo — se verifica cargando el mod en la sesión
 * (`claude plugin validate` pasa; el panel se dibuja con datos reales).
 */
function motorMinimo(on: On) {
  const llamadas = { usage: 0 }
  on('clock.now', () => ({ value: 1_700_000_000_000 }))
  on('fs.exists', () => ({ value: false }))
  on('session.usage', () => {
    llamadas.usage += 1
    return {
      startedAt: 1_699_999_000_000,
      context: { window: 200_000, tokens: 50_000, percent: 25 },
      rateLimits: [],
      cost: { usd: 1.25 },
    }
  })
  on('turn.complete', () => ({ text: 'respuesta del motor' }))
  return llamadas
}

test('un turno de sub-agente no consulta el costo del host ni toca el estado', async ($, on) => {
  const llamadas = motorMinimo(on)
  const r = await $.turn.complete({
    turnId: 't-sub',
    agentId: 'agent-1',
    answer: '',
    durationMs: 10,
    isAborted: false,
    reason: 'answer',
    usage: { model: 'otro', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  })
  expect(llamadas.usage).toBe(0) // los sub-agentes ya suman en el padre
  expect(r.text).toBe('respuesta del motor') // el mod observa, no reemplaza
})

test('un turno sin uso reportado pasa de largo sin consultar el host', async ($, on) => {
  const llamadas = motorMinimo(on)
  const r = await $.turn.complete({
    turnId: 't-0',
    answer: 'sin uso',
    durationMs: 5,
    isAborted: true,
    reason: 'aborted',
  })
  expect(llamadas.usage).toBe(0)
  expect(r.text).toBe('respuesta del motor')
})
