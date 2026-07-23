import { describe, expect, it } from 'vitest'
import { MonitorTransport, eventToWire } from '../src/monitor/transport'
import { makeEvent } from '../src/monitor/types'
import type { FetchLike } from '../src/auth/verify'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function recordingFetch(responses: Array<{ status: number; headers?: Record<string, string> }>): {
  fetchImpl: FetchLike
  count: () => number
  bodies: () => unknown[]
} {
  let n = 0
  const bodies: unknown[] = []
  const fetchImpl: FetchLike = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    const r = responses[Math.min(n, responses.length - 1)]!
    n++
    return new Response(null, { status: r.status, headers: r.headers ?? {} })
  }
  return { fetchImpl, count: () => n, bodies: () => bodies }
}

describe('eventToWire', () => {
  it('serialises to the backend shape with an ISO ts', () => {
    const wire = eventToWire(
      makeEvent({ featureName: 'checkout', ok: false, error: 'boom', durationMs: 12, userId: 'u1', meta: { a: 1 } }),
    )
    expect(wire).toMatchObject({
      featureName: 'checkout',
      ok: false,
      platform: 'node',
      source: 'event',
      error: 'boom',
      durationMs: 12,
      userId: 'u1',
      meta: { a: 1 },
    })
    expect(typeof wire.ts).toBe('string')
    expect(() => new Date(wire.ts as string).toISOString()).not.toThrow()
  })

  it('omits empty meta and null fields', () => {
    const wire = eventToWire(makeEvent({ featureName: 'x', ok: true }))
    expect(wire).not.toHaveProperty('meta')
    expect(wire).not.toHaveProperty('error')
    expect(wire).not.toHaveProperty('durationMs')
  })
})

describe('MonitorTransport', () => {
  it('batches and flushes events', async () => {
    const { fetchImpl, count } = recordingFetch([{ status: 204 }])
    const t = new MonitorTransport({ apiUrl: 'https://api.test', publishableKey: 'onelo_sk_test_m', fetchImpl })
    t.start()
    t.send(makeEvent({ featureName: 'a', ok: true }))
    t.send(makeEvent({ featureName: 'b', ok: true }))
    await t.flush()
    expect(count()).toBe(1) // one batch, two events
    await t.stop()
  })

  it('flushes an error event immediately', async () => {
    const { fetchImpl, count } = recordingFetch([{ status: 204 }])
    const t = new MonitorTransport({ apiUrl: 'https://api.test', publishableKey: 'onelo_sk_test_m', fetchImpl })
    t.start()
    t.send(makeEvent({ featureName: 'err', ok: false }))
    await t.flush() // chained after the immediate error flush
    expect(count()).toBeGreaterThanOrEqual(1)
    await t.stop()
  })

  it('drops a 4xx batch without retrying', async () => {
    const { fetchImpl, count } = recordingFetch([{ status: 422 }])
    const t = new MonitorTransport({ apiUrl: 'https://api.test', publishableKey: 'onelo_sk_test_m', fetchImpl })
    t.start()
    t.send(makeEvent({ featureName: 'x', ok: true }))
    await t.flush()
    expect(count()).toBe(1) // no retry on 4xx
    await t.stop()
  })

  it('retries a 5xx then succeeds', async () => {
    const { fetchImpl, count } = recordingFetch([{ status: 500 }, { status: 204 }])
    const t = new MonitorTransport({ apiUrl: 'https://api.test', publishableKey: 'onelo_sk_test_m', fetchImpl })
    t.start()
    t.send(makeEvent({ featureName: 'x', ok: true }))
    await t.flush()
    expect(count()).toBe(2)
    await t.stop()
  })

  it('reads X-Onelo-Quota-Remaining', async () => {
    const { fetchImpl } = recordingFetch([{ status: 204, headers: { 'X-Onelo-Quota-Remaining': '17' } }])
    const t = new MonitorTransport({ apiUrl: 'https://api.test', publishableKey: 'onelo_sk_test_m', fetchImpl })
    t.start()
    t.send(makeEvent({ featureName: 'x', ok: true }))
    await t.flush()
    await sleep(5)
    expect(t.quotaRemaining).toBe(17)
    await t.stop()
  })
})
