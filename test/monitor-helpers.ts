import type { FetchLike } from '../src/auth/verify'
import { MonitorClient } from '../src/monitor/client'
import { Onelo } from '../src/client'

export interface WireEvent {
  featureName: string
  ok: boolean
  platform: string
  source: string
  ts: string
  durationMs?: number
  error?: string
  userId?: string
  sessionId?: string
  meta?: Record<string, unknown>
}

/** A fetchImpl that records every monitor batch POSTed. */
export function monitorFetch(opts: { status?: number; headers?: Record<string, string> } = {}): {
  fetchImpl: FetchLike
  batches: WireEvent[][]
  allEvents: () => WireEvent[]
  postCount: () => number
} {
  const batches: WireEvent[][] = []
  let posts = 0
  const fetchImpl: FetchLike = async (url, init) => {
    if (url.includes('/monitor/events/batch')) {
      posts++
      const body = JSON.parse(String(init?.body)) as { events: WireEvent[] }
      batches.push(body.events)
      return new Response(null, { status: opts.status ?? 204, headers: opts.headers ?? {} })
    }
    return new Response(null, { status: 404 })
  }
  // `init()` auto-emits one unconditional `session_opened` bootstrap event (see
  // MonitorClient.init) so Feature Health always has a row even when every
  // instrumented call site is gated behind auth/paywall/consent. Tests here
  // assert on the events THEY triggered, so the bootstrap event is filtered
  // out of `allEvents()` — mirroring onelo-js's test idiom of stripping the
  // one extra auto-emitted event right after construction.
  const allEvents = () => batches.flat().filter((e) => e.featureName !== 'session_opened')
  return { fetchImpl, batches, allEvents, postCount: () => posts }
}

export function directMonitor(
  fetchImpl: FetchLike,
  flagProvider: () => Record<string, string> = () => ({}),
): MonitorClient {
  return new MonitorClient({
    key: 'onelo_sk_test_m',
    apiUrl: 'https://api.test.onelo.tools',
    requestTimeout: 5000,
    fetchImpl,
    flagProvider,
  })
}

export function oneloWith(fetchImpl: FetchLike): Onelo {
  return new Onelo({ secretKey: 'onelo_sk_test_m', apiUrl: 'https://api.test.onelo.tools', fetchImpl })
}
