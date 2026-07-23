/**
 * Token verification — the framework-agnostic core. 1:1 with Python's
 * `onelo.auth.verify_token` + `_map_response`, collapsed to a single async
 * function (Node has no sync/async split).
 */
import type { AuthClient } from '../client'
import { OneloUser } from './user'
import {
  OneloAuthError,
  OneloAuthForbidden,
  OneloAuthInvalidToken,
  OneloAuthMissingToken,
  OneloAuthRateLimited,
  OneloAuthUnavailable,
} from './errors'

/** A `fetch`-compatible function. Injectable for tests / custom transports. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** Base retry backoff (ms): 100, 200, 400 ... — mirrors Python `_BACKOFF_BASE`. */
const BACKOFF_BASE_MS = 100

/**
 * Parse a `Retry-After` header (seconds form). Returns `null` when absent,
 * invalid, or negative. HTTP-date form is not supported (Onelo sends seconds).
 */
export function parseRetryAfter(value: string | null | undefined): number | null {
  if (!value) return null
  const trimmed = value.trim()
  // Strict decimal seconds only (Onelo sends seconds). Reject empty / hex / octal
  // / Infinity / underscore-digits so a whitespace-only or exotic header yields
  // null — matching Python's `float(...)`→ValueError→None contract, not `Number`'s
  // lenient coercion (e.g. Number("") === 0).
  if (!/^[+-]?\d+(\.\d+)?$/.test(trimmed)) return null
  const seconds = Number(trimmed)
  if (!Number.isFinite(seconds)) return null
  return seconds >= 0 ? seconds : null
}

/**
 * Pull a bearer token out of an `Authorization` header value. Returns `null`
 * when the header is absent, not a `bearer` scheme, or the token is empty. The
 * scheme match is case-insensitive.
 */
export function extractBearerToken(authorization: string | null | undefined): string | null {
  if (!authorization) return null
  const stripped = authorization.trim()
  if (stripped.toLowerCase().startsWith('bearer ')) {
    const token = stripped.slice(7).trim()
    return token || null
  }
  // Header present but not a bearer scheme — treat as missing.
  return null
}

/**
 * Map a `/api/sdk/auth/user` response to an OneloUser or throw the typed auth
 * error. Shared status contract — async/sync can never drift (there is only one
 * path in Node). Mirrors Python `_map_response`.
 */
async function mapResponse(res: Response): Promise<OneloUser> {
  const status = res.status
  if (status === 200) {
    let payload: unknown
    try {
      payload = await res.json()
    } catch (exc) {
      throw new OneloAuthUnavailable(`backend returned 200 with invalid JSON: ${String(exc)}`)
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      // Valid JSON but not an object (null / list / string — e.g. a proxy or CDN
      // error page served as application/json). Malformed, not an anonymous user.
      throw new OneloAuthUnavailable('backend returned 200 with a non-object body')
    }
    const user = OneloUser.fromPayload(payload as Record<string, unknown>)
    if (!user.id) {
      // A 200 without a usable id is a malformed backend response, NOT a valid
      // anonymous user — never let it pass as authenticated.
      throw new OneloAuthUnavailable('backend returned 200 without a user id')
    }
    return user
  }
  if (status === 401) throw new OneloAuthInvalidToken('invalid or expired token')
  if (status === 403) throw new OneloAuthForbidden('token valid but principal forbidden')
  if (status === 429) {
    // NOT a generic 5xx: retrying a rate-limit immediately makes it worse. The
    // retry loops skip it (see verifyWithRetry).
    throw new OneloAuthRateLimited(
      'backend rate-limited auth (429)',
      parseRetryAfter(res.headers.get('retry-after')),
    )
  }
  if (status >= 500 && status < 600) throw new OneloAuthUnavailable(`backend returned ${status}`)
  // Any other unexpected status — treat as auth failure conservatively.
  throw new OneloAuthUnavailable(`unexpected status ${status}`)
}

/**
 * Verify a user-supplied access token against the Onelo backend.
 *
 * Low-level helper for any Node stack (websockets, queue workers, custom
 * middleware). The framework adapters layer caching, retries, and gates on top.
 *
 * @param client An {@link AuthClient} constructed with a **secret** key —
 *   verifying a user token requires server-side credentials.
 * @param token  The user's access token (NOT your secret key).
 * @throws {OneloAuthMissingToken} token is empty / whitespace.
 * @throws {OneloAuthError}        client was built with a publishable key.
 * @throws {OneloAuthInvalidToken} backend returned 401.
 * @throws {OneloAuthForbidden}    backend returned 403.
 * @throws {OneloAuthRateLimited}  backend returned 429.
 * @throws {OneloAuthUnavailable}  backend 5xx, network failure, unexpected status.
 */
export async function verifyToken(client: AuthClient, token: string): Promise<OneloUser> {
  if (!token || !token.trim()) throw new OneloAuthMissingToken('token is empty')

  if (!client.isSecretKey) {
    throw new OneloAuthError(
      'verifyToken requires an Onelo client constructed with secretKey: ...; ' +
        'you supplied a publishable key. Backends must use ' +
        "new Onelo({ secretKey: 'onelo_sk_live_...' }).",
    )
  }

  const url = `${client.apiUrl}/api/sdk/auth/user`
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    // Send both — backend prefers the dedicated header, but the legacy
    // X-Publishable-Key path still works on older deployments.
    'X-Onelo-Secret-Key': client.key,
    'X-Publishable-Key': client.key,
  }

  const doFetch: FetchLike | undefined =
    client.fetchImpl ?? (typeof fetch === 'function' ? (fetch as FetchLike) : undefined)
  if (!doFetch) {
    throw new OneloAuthUnavailable(
      'global fetch is unavailable — Node 18+ is required, or pass fetchImpl in the Onelo config.',
    )
  }

  let res: Response
  try {
    res = await doFetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(client.requestTimeout),
    })
  } catch (exc) {
    throw new OneloAuthUnavailable(`network error: ${String(exc)}`)
  }

  return mapResponse(res)
}

/** Options for {@link verifyWithRetry}. */
export interface VerifyRetryOptions {
  /** Total attempts on 5xx (including the initial try). Default 3. */
  retryAttempts?: number
  /** Hard wall-clock cap (ms) on the entire retry sequence. Default 2000. */
  retryTotalTimeout?: number
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * `verifyToken` + a 5xx retry policy with a wall-clock budget. Exponential
 * backoff (100, 200, 400 ...), bounded by `retryTotalTimeout`. A 429 rate-limit
 * is NOT retried (retrying immediately only deepens it). Mirrors Python's
 * `RequireUser._verify_with_retry` / `verify_token_sync`.
 */
export async function verifyWithRetry(
  client: AuthClient,
  token: string,
  options: VerifyRetryOptions = {},
): Promise<OneloUser> {
  const retryAttempts = options.retryAttempts ?? 3
  const retryTotalTimeout = options.retryTotalTimeout ?? 2000
  if (retryAttempts < 1) throw new Error('retryAttempts must be >= 1')
  if (retryTotalTimeout <= 0) throw new Error('retryTotalTimeout must be > 0')

  const deadline = performance.now() + retryTotalTimeout
  let lastExc: OneloAuthUnavailable | null = null

  for (let attempt = 0; attempt < retryAttempts; attempt++) {
    try {
      return await verifyToken(client, token)
    } catch (exc) {
      // Only 5xx/network (Unavailable) is retryable. 401/403/missing rethrow.
      if (!(exc instanceof OneloAuthUnavailable)) throw exc
      lastExc = exc
      // A rate-limit is not transient like a 5xx — fail fast.
      if (exc instanceof OneloAuthRateLimited) break
      const nextAttempt = attempt + 1
      if (nextAttempt >= retryAttempts) break
      const backoff = BACKOFF_BASE_MS * 2 ** attempt // 100, 200, 400
      const remaining = deadline - performance.now()
      if (remaining <= 0) break
      await sleep(Math.min(backoff, remaining))
      if (performance.now() >= deadline) break
    }
  }

  // The loop only exits via `return` (success) or after setting lastExc.
  throw lastExc as OneloAuthUnavailable
}
