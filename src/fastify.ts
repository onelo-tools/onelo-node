/**
 * Fastify adapter for Onelo auth (preHandler hook).
 *
 *   import { Onelo } from '@onelo/node'
 *   import { requireUser } from '@onelo/node/fastify'
 *
 *   const onelo = new Onelo({ secretKey: process.env.ONELO_SECRET_KEY!, apiUrl: process.env.ONELO_API_URL! })
 *
 *   fastify.get('/me', { preHandler: requireUser(onelo) }, async (req) => {
 *     return { id: req.oneloUser.id, email: req.oneloUser.email }
 *   })
 *
 * Status mapping: 401 missing/invalid · 403 forbidden/gate · 503 backend outage.
 *
 * Typed against minimal structural interfaces so no `fastify` dependency is
 * required — the real `FastifyRequest`/`FastifyReply` satisfy them at runtime.
 */
import type { AuthClient } from './client'
import { AuthHttpError, createResolver, type ResolverOptions } from './auth/resolve'
import type { OneloUser } from './auth/user'
import type { MonitorClient } from './monitor/client'
import { attachRequestToScope } from './monitor/request-context'

// requireUser/optionalUser set `request.oneloUser` at runtime. To type it in your
// own project, add this module augmentation once (Fastify augmentations must live
// in YOUR app — the SDK can't ship one without taking a hard dependency on
// fastify). `OneloUser` is exported from '@onelo/node':
//
//   declare module 'fastify' {
//     interface FastifyRequest { oneloUser?: import('@onelo/node').OneloUser | null }
//   }
//
// Then in a requireUser-protected handler assert non-null: `request.oneloUser!.id`.

interface FastifyRequest {
  headers: Record<string, string | string[] | undefined>
  query?: unknown
  /** Set by the adapter — the verified user (`null` in optionalUser). */
  oneloUser?: OneloUser | null
  [key: string]: unknown
}

interface FastifyReply {
  code(statusCode: number): FastifyReply
  send(payload: unknown): unknown
}

type PreHandlerHook = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>

function getAuthHeader(req: FastifyRequest): string | null {
  const h = req.headers['authorization']
  if (Array.isArray(h)) return h[0] ?? null
  return h ?? null
}

function getQueryToken(req: FastifyRequest): string | null {
  const q = req.query
  if (q && typeof q === 'object') {
    const t = (q as Record<string, unknown>).token
    if (typeof t === 'string') return t
    if (Array.isArray(t) && typeof t[0] === 'string') return t[0]
  }
  return null
}

/**
 * A `preHandler` hook that requires a verified Onelo user. On success attaches
 * `req.oneloUser`. On auth failure it sends the mapped status/body and returns
 * the reply (Fastify then stops the chain). Unexpected errors rethrow into
 * Fastify's error handling.
 */
export function requireUser(client: AuthClient, options: ResolverOptions = {}): PreHandlerHook {
  const { resolve } = createResolver(client, options)
  return async (req, reply) => {
    try {
      req.oneloUser = await resolve(getAuthHeader(req), getQueryToken(req))
    } catch (err) {
      if (err instanceof AuthHttpError) {
        reply.code(err.status).send(err.body)
        return reply
      }
      throw err
    }
  }
}

/**
 * Like {@link requireUser} but sets `req.oneloUser = null` and continues on
 * missing / invalid / forbidden tokens. A backend outage (503) still short-
 * circuits.
 */
export function optionalUser(client: AuthClient, options: ResolverOptions = {}): PreHandlerHook {
  const { resolve } = createResolver(client, options)
  return async (req, reply) => {
    try {
      req.oneloUser = await resolve(getAuthHeader(req), getQueryToken(req))
    } catch (err) {
      if (err instanceof AuthHttpError) {
        if (err.status === 401 || err.status === 403) {
          req.oneloUser = null
          return
        }
        reply.code(err.status).send(err.body) // 503 surfaces
        return reply
      }
      throw err
    }
  }
}

// ── Monitor ─────────────────────────────────────────────────────────────────

interface WithMonitor {
  monitor: MonitorClient
}

interface FastifyLike {
  addHook(name: 'onRequest', fn: (req: FastifyRequest, reply: FastifyReply, done: () => void) => void): unknown
  addHook(name: 'onError', fn: (req: FastifyRequest, reply: FastifyReply, error: unknown, done: () => void) => void): unknown
}

/**
 * Register Onelo Monitor on a Fastify instance: each request runs in a fresh
 * isolation scope (via `onRequest`) so per-request user/breadcrumbs don't bleed,
 * and thrown errors are reported (via `onError`) within that same scope.
 *
 *   const fastify = Fastify()
 *   registerOneloMonitor(fastify, onelo)
 */
export function registerOneloMonitor(fastify: FastifyLike, onelo: WithMonitor): void {
  fastify.addHook('onRequest', (req, _reply, done) => {
    // als.run wraps done() — the rest of the request (handler + hooks) inherits
    // this isolation scope through Fastify's async continuation.
    onelo.monitor.runWithIsolationScope(() => {
      const r = req as { method?: string; url?: string }
      attachRequestToScope(onelo.monitor, {
        method: String(r.method ?? ''),
        url: String(r.url ?? ''),
        headers: req.headers,
      })
      done()
    })
  })
  fastify.addHook('onError', (_req, _reply, error, done) => {
    onelo.monitor.captureException(error)
    done()
  })
}
