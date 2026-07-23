import { Onelo } from '../src/client'
import type { FetchLike } from '../src/auth/verify'

/** A fetchImpl that returns a fixed JSON Response. Records call count. */
export function jsonFetch(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): { fetchImpl: FetchLike; calls: () => number } {
  let n = 0
  const fetchImpl: FetchLike = async () => {
    n++
    const init: ResponseInit = { status, headers }
    const payload = body === undefined ? '' : JSON.stringify(body)
    return new Response(payload, init)
  }
  return { fetchImpl, calls: () => n }
}

/** A fetchImpl driven by a queue of [status, body] responses (for retry tests). */
export function sequenceFetch(
  responses: Array<[number, unknown, Record<string, string>?]>,
): { fetchImpl: FetchLike; calls: () => number } {
  let n = 0
  const fetchImpl: FetchLike = async () => {
    const entry = responses[Math.min(n, responses.length - 1)]!
    n++
    const [status, body, headers] = entry
    return new Response(body === undefined ? '' : JSON.stringify(body), {
      status,
      headers: headers ?? {},
    })
  }
  return { fetchImpl, calls: () => n }
}

/** A fetchImpl that always throws (network error). */
export function throwingFetch(): FetchLike {
  return async () => {
    throw new TypeError('network down')
  }
}

export function secretClient(fetchImpl: FetchLike): Onelo {
  return new Onelo({
    secretKey: 'onelo_sk_test_abc123',
    apiUrl: 'https://api.test.onelo.tools',
    fetchImpl,
  })
}

export function publishableClient(fetchImpl: FetchLike): Onelo {
  return new Onelo({
    publishableKey: 'onelo_pk_test_abc123',
    apiUrl: 'https://api.test.onelo.tools',
    fetchImpl,
  })
}

export const OK_USER = { id: 'user_1', email: 'a@b.co', metadata: { plan: 'pro' } }
