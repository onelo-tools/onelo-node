/**
 * The shared auth resolver — the logic every framework adapter runs. This is
 * where extraction → cache → verify(+retry) → gates → error-mapping lives, so
 * the four adapters (Express/Next/Fastify/Hono) stay thin: each only translates
 * its framework's request/response into calls here.
 *
 * Mirrors the per-request `_resolve` shared by Python's `onelo.fastapi` /
 * `onelo.flask` — including the exact 401/403/503 mapping and `auth.*` events.
 */
import { createHash } from 'node:crypto'

import type { AuthClient } from '../client'
import { type AuthCache, InProcessAuthCache } from './cache'
import {
  OneloAuthError,
  OneloAuthForbidden,
  OneloAuthInvalidToken,
  OneloAuthMissingToken,
  OneloAuthUnavailable,
} from './errors'
import type { OneloUser } from './user'
import { extractBearerToken, verifyWithRetry } from './verify'

/** `(userIdOrNull, eventName)` — fired on every verification result. */
export type OnAuthEvent = (userId: string | null, event: string) => void

export interface ResolverOptions {
  /**
   * Pluggable cache. Defaults to a fresh {@link InProcessAuthCache} per
   * resolver — so different resolvers don't share by default.
   *
   * ⚠️ The cache key is `sha256(token)` only (never the client/tenant). Do NOT
   * share one cache instance across resolvers bound to different Onelo clients
   * (different backend / app / tenant): a token verified against backend A
   * could be served from cache to backend B's resolver without re-verifying.
   * One cache per credential set.
   */
  cache?: AuthCache
  /** TTL (seconds) for cached verifications. Default 30. */
  cacheTtl?: number
  /**
   * When `true`, fall back to `?token=...` if the `Authorization` header is
   * missing — for SSE / EventSource clients that can't set headers. Opt-in
   * (default `false`) because a token in a URL can leak via access logs.
   */
  acceptQueryToken?: boolean
  /** Reject users whose `emailVerified` is falsy with 403. */
  requireEmailVerified?: boolean
  /** When set, the user's `plan` must be in this list or they get 403. */
  requirePlan?: string[]
  /** Total attempts on backend 5xx (including the initial try). Default 3. */
  retryAttempts?: number
  /** Hard wall-clock cap (ms) on the whole retry sequence. Default 2000. */
  retryTotalTimeout?: number
  /** Optional callback fired on each result. Exceptions are swallowed. */
  onAuthEvent?: OnAuthEvent
  /**
   * Attach the verified user's id to the per-request Monitor scope
   * (`monitor.setUser({ id })`) so errors captured during the request carry the
   * user. Default `true`. Takes effect ONLY when a monitor request handler /
   * withMonitor has forked a per-request isolation scope — outside such a scope
   * it is a safe no-op (never writes the shared process-root scope), so it can
   * never leak a user across concurrent requests. Mirrors Python's per-request
   * `identify_monitor` (Node attaches to the already-forked scope rather than
   * forking its own).
   */
  identifyMonitor?: boolean
}

/**
 * Internal signal carrying the (status, body) an adapter should return. Each
 * adapter catches this and renders it in its framework's idiom. Mirrors Flask's
 * `_AuthError`.
 */
export class AuthHttpError extends Error {
  readonly status: number
  readonly body: Record<string, unknown>

  constructor(status: number, body: Record<string, unknown>) {
    super(typeof body.error === 'string' ? body.error : 'auth_error')
    Object.setPrototypeOf(this, AuthHttpError.prototype)
    this.name = 'AuthHttpError'
    this.status = status
    this.body = body
  }
}

/** sha256(token) hex — never store plaintext tokens in the cache. */
function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function safeEmit(cb: OnAuthEvent | undefined, userId: string | null, event: string): void {
  if (!cb) return
  try {
    cb(userId, event)
  } catch (err) {
    // A callback must NEVER take down the request — log then swallow.
    // eslint-disable-next-line no-console
    console.warn('[onelo] onAuthEvent callback threw; suppressing.', err)
  }
}

/** Minimal Monitor surface the auth→monitor bridge needs. */
interface MonitorLike {
  setUser(user: Record<string, unknown> | null): void
  /** True only inside a per-request monitor scope — gates the bridge (see below). */
  hasActiveRequestScope(): boolean
}

/** The client's monitor, if it exposes the bridge surface — else null (bare AuthClient). */
function getMonitor(client: AuthClient): MonitorLike | null {
  const m = (client as { monitor?: { setUser?: unknown; hasActiveRequestScope?: unknown } }).monitor
  return m && typeof m.setUser === 'function' && typeof m.hasActiveRequestScope === 'function'
    ? (m as MonitorLike)
    : null
}

/** The resolver returned by {@link createResolver}. */
export interface Resolver {
  /**
   * Resolve a request to a verified {@link OneloUser} or throw
   * {@link AuthHttpError}. `authorization` is the raw header value;
   * `queryToken` is the `?token=` value (only used when `acceptQueryToken`).
   */
  resolve(authorization: string | null, queryToken: string | null): Promise<OneloUser>
  /** The cache in use (shared across all requests through this resolver). */
  cache: AuthCache
}

/**
 * Build a resolver bound to a client + options. Validates the client and retry
 * config once, up front (throws synchronously) — same as Python's adapters
 * rejecting a publishable key at construction time.
 */
export function createResolver(client: AuthClient, options: ResolverOptions = {}): Resolver {
  if (!client.isSecretKey) {
    throw new Error(
      'This adapter requires an Onelo client constructed with secretKey: ...; ' +
        'you supplied a publishable key. Backends must use ' +
        "new Onelo({ secretKey: 'onelo_sk_live_...' }).",
    )
  }
  const retryAttempts = options.retryAttempts ?? 3
  const retryTotalTimeout = options.retryTotalTimeout ?? 2000
  if (retryAttempts < 1) throw new Error('retryAttempts must be >= 1')
  if (retryTotalTimeout <= 0) throw new Error('retryTotalTimeout must be > 0')

  const cache: AuthCache = options.cache ?? new InProcessAuthCache()
  const cacheTtl = options.cacheTtl ?? 30
  const acceptQueryToken = options.acceptQueryToken ?? false
  const requireEmailVerified = options.requireEmailVerified ?? false
  const planSet =
    options.requirePlan && options.requirePlan.length > 0 ? new Set(options.requirePlan) : null
  const onAuthEvent = options.onAuthEvent
  const identifyMonitor = options.identifyMonitor ?? true
  const monitor = getMonitor(client)

  function bridgeMonitor(user: OneloUser): void {
    // Only attach when a per-request monitor scope is active (a monitor request
    // handler forked one). Outside such a scope, setUser would write the shared
    // process-root scope and leak the id across concurrent requests — so no-op
    // instead. Safe by default; correct when the monitor handler is mounted.
    if (identifyMonitor && monitor && monitor.hasActiveRequestScope()) {
      monitor.setUser({ id: user.id })
    }
  }

  function checkGates(user: OneloUser): void {
    if (requireEmailVerified && !user.emailVerified) throw new OneloAuthForbidden('email_unverified')
    if (planSet !== null && !(user.plan !== null && planSet.has(user.plan))) {
      throw new OneloAuthForbidden('plan')
    }
  }

  function extractToken(authorization: string | null, queryToken: string | null): string | null {
    // Header present (even if not bearer) → use it exclusively; don't fall
    // through to the query param. Matches Python `_extract_token`.
    if (authorization) return extractBearerToken(authorization)
    if (acceptQueryToken && queryToken) {
      const t = queryToken.trim()
      return t || null
    }
    return null
  }

  async function resolve(
    authorization: string | null,
    queryToken: string | null,
  ): Promise<OneloUser> {
    const token = extractToken(authorization, queryToken)
    if (token === null) {
      safeEmit(onAuthEvent, null, 'auth.fail.missing_token')
      throw new AuthHttpError(401, { error: 'missing_token' })
    }

    const tokenHash = hashToken(token)

    // Cache lookup BEFORE any network work.
    const cached = await cache.get(tokenHash)
    if (cached !== null) {
      try {
        checkGates(cached)
      } catch (exc) {
        if (exc instanceof OneloAuthForbidden) {
          safeEmit(onAuthEvent, cached.id || null, `auth.fail.${exc.message}`)
          throw new AuthHttpError(403, { error: 'forbidden', reason: exc.message })
        }
        throw exc
      }
      safeEmit(onAuthEvent, cached.id, 'auth.verify')
      bridgeMonitor(cached)
      return cached
    }

    // Miss — verify, with retries on 5xx.
    let user: OneloUser
    try {
      user = await verifyWithRetry(client, token, { retryAttempts, retryTotalTimeout })
    } catch (exc) {
      if (exc instanceof OneloAuthMissingToken) {
        safeEmit(onAuthEvent, null, 'auth.fail.missing_token')
        throw new AuthHttpError(401, { error: 'missing_token' })
      }
      if (exc instanceof OneloAuthInvalidToken) {
        safeEmit(onAuthEvent, null, 'auth.fail.invalid_token')
        throw new AuthHttpError(401, { error: 'invalid_token' })
      }
      if (exc instanceof OneloAuthForbidden) {
        safeEmit(onAuthEvent, null, 'auth.fail.forbidden')
        throw new AuthHttpError(403, { error: 'forbidden' })
      }
      // OneloAuthRateLimited is a subclass of Unavailable → also 503 here.
      if (exc instanceof OneloAuthUnavailable) {
        safeEmit(onAuthEvent, null, 'auth.fail.unavailable')
        throw new AuthHttpError(503, { error: 'auth_service_unavailable' })
      }
      if (exc instanceof OneloAuthError) {
        // Catch-all for any future OneloAuthError subclass.
        safeEmit(onAuthEvent, null, 'auth.fail.invalid_token')
        throw new AuthHttpError(401, { error: 'invalid_token' })
      }
      throw exc
    }

    // Cache the raw verification result; gates are per-request.
    await cache.set(tokenHash, user, cacheTtl)

    try {
      checkGates(user)
    } catch (exc) {
      if (exc instanceof OneloAuthForbidden) {
        safeEmit(onAuthEvent, user.id || null, `auth.fail.${exc.message}`)
        throw new AuthHttpError(403, { error: 'forbidden', reason: exc.message })
      }
      throw exc
    }

    safeEmit(onAuthEvent, user.id, 'auth.verify')
    bridgeMonitor(user)
    return user
  }

  return { resolve, cache }
}
