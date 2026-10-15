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

/** An unsigned JWT-shaped token. The SDK never verifies a signature; Onelo does. */
export function jwt(payload: Record<string, unknown>, alg = 'RS256'): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg, typ: 'JWT', kid: 'k1' })}.${part(payload)}.sig`
}

/** A token as an external issuer (Supabase, Clerk, Firebase) would hand it out. */
export function issuerToken(sub = 'ext-1', expiresInSeconds = 3600): string {
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds
  return jwt({ iss: 'https://issuer.example', sub, aud: 'project', exp })
}

/** A token shaped like an Onelo session token (`type: sdk_user`). */
export function oneloToken(sub = 'user_1'): string {
  return jwt({ sub, type: 'sdk_user', aud: 'sdk_user', app_id: 'app_1' }, 'HS256')
}

export const EXCHANGE_OK = {
  session: { access_token: 'onelo-access', token_type: 'bearer', expires_in: 1800 },
  user: { id: 'user_ext', email: 'ext@b.co', entitlement: 'none', allowed_in: true, email_verified: true },
}

export interface RecordedCall {
  path: string
  method: string
  headers: Record<string, string>
  body: Record<string, unknown> | null
}

type Answer = [number, unknown, Record<string, string>?]

/**
 * A fetchImpl that answers by path and records every call. Each route is one
 * answer or a queue of answers (the last one repeats).
 */
export function routedFetch(routes: {
  exchange?: Answer | Answer[]
  user?: Answer | Answer[]
}): { fetchImpl: FetchLike; calls: RecordedCall[]; count: (path: 'exchange' | 'user') => number } {
  const calls: RecordedCall[] = []
  const served = { exchange: 0, user: 0 }
  const fetchImpl: FetchLike = async (input, init) => {
    const path = new URL(input).pathname
    const name = path.endsWith('/exchange') ? 'exchange' : 'user'
    calls.push({
      path,
      method: String(init?.method ?? 'GET'),
      headers: { ...((init?.headers as Record<string, string>) ?? {}) },
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    })
    const route = routes[name]
    if (!route) throw new Error(`unexpected call to ${path}`)
    const queue = (Array.isArray(route[0]) ? route : [route]) as Answer[]
    const [status, body, headers] = queue[Math.min(served[name], queue.length - 1)]!
    served[name]++
    // Let concurrent callers overlap, as a real network call would.
    await new Promise((resolve) => setTimeout(resolve, 5))
    return new Response(JSON.stringify(body), { status, headers: headers ?? {} })
  }
  const suffix = { exchange: '/api/sdk/auth/exchange', user: '/api/sdk/auth/user' }
  return { fetchImpl, calls, count: (name) => calls.filter((c) => c.path === suffix[name]).length }
}

/** A refusal body as the exchange endpoint sends it. */
export function refusal(code: string): { detail: { error: string; message: string } } {
  return { detail: { error: code, message: code } }
}
