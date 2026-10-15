import { Onelo } from '../src/client'
import type { FetchLike } from '../src/auth/verify'

const enc = (s: string) => new TextEncoder().encode(s)

/** A controllable open SSE stream Response — push frames + close on demand. */
export function openSseStream(initialFrames: string[] = []): {
  response: () => Response
  push: (frame: string) => void
  close: () => void
} {
  let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null
  const response = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          ctrl = c
          for (const f of initialFrames) c.enqueue(enc(f))
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  return {
    response,
    push: (frame) => ctrl?.enqueue(enc(frame)),
    close: () => ctrl?.close(),
  }
}

export interface FeatureRoutes {
  stream?: () => Response
  poll?: () => Response
  resolve?: () => Response
  batchPing?: () => Response
}

/** Route a fetch by Onelo feature endpoint. Records per-endpoint call counts. */
export function featuresFetch(routes: FeatureRoutes): {
  fetchImpl: FetchLike
  calls: { stream: number; poll: number; resolve: number; batchPing: number }
  lastResolveBody: () => unknown
  lastPoll: () => { url: string; headers: Record<string, string> } | undefined
} {
  const calls = { stream: 0, poll: 0, resolve: 0, batchPing: 0 }
  let lastResolveBody: unknown
  let lastPoll: { url: string; headers: Record<string, string> } | undefined
  const fetchImpl: FetchLike = async (url, init) => {
    if (url.includes('/features/stream')) {
      calls.stream++
      return routes.stream ? routes.stream() : new Response(null, { status: 204 })
    }
    if (url.includes('/features/poll')) {
      calls.poll++
      lastPoll = { url, headers: (init?.headers ?? {}) as Record<string, string> }
      return routes.poll ? routes.poll() : new Response('{}', { status: 200 })
    }
    if (url.includes('/features/resolve')) {
      calls.resolve++
      if (init?.body) lastResolveBody = JSON.parse(String(init.body))
      return routes.resolve ? routes.resolve() : new Response('{"features":{}}', { status: 200 })
    }
    if (url.includes('/features/batch-ping')) {
      calls.batchPing++
      return routes.batchPing ? routes.batchPing() : new Response(null, { status: 204 })
    }
    return new Response(null, { status: 404 })
  }
  return { fetchImpl, calls, lastResolveBody: () => lastResolveBody, lastPoll: () => lastPoll }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export function client(fetchImpl: FetchLike, extra: Record<string, unknown> = {}): Onelo {
  return new Onelo({
    secretKey: 'onelo_sk_test_feat',
    apiUrl: 'https://api.test.onelo.tools',
    fetchImpl,
    ...extra,
  })
}

/** SSE `connected` frame for the given features + config version. */
export function connectedFrame(features: Record<string, unknown>, configVersion = 1): string {
  return `event: connected\ndata: ${JSON.stringify({ config_version: configVersion, features })}\n\n`
}
