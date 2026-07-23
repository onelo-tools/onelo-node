/**
 * Express adapter for Onelo auth.
 *
 *   import { Onelo } from '@onelo/node'
 *   import { requireUser } from '@onelo/node/express'
 *
 *   const onelo = new Onelo({ secretKey: process.env.ONELO_SECRET_KEY!, apiUrl: process.env.ONELO_API_URL! })
 *
 *   app.get('/me', requireUser(onelo), (req, res) => {
 *     res.json({ id: req.oneloUser!.id, email: req.oneloUser!.email })
 *   })
 *
 * Status mapping: 401 missing/invalid · 403 forbidden/gate · 503 backend outage.
 *
 * Adapters are typed against minimal structural interfaces (not `@types/express`)
 * so the SDK stays dependency-free and framework-version-agnostic — the real
 * Express `req`/`res`/`next` satisfy them at runtime.
 */
import type { AuthClient } from './client'
import { AuthHttpError, createResolver, type ResolverOptions } from './auth/resolve'
import type { OneloUser } from './auth/user'
import type { MonitorClient } from './monitor/client'
import { attachRequestToScope } from './monitor/request-context'

// Type the `req.oneloUser` that requireUser/optionalUser set at runtime, on the
// REAL Express Request — so a consumer's TS project sees it. We augment the
// global `Express` namespace (the Passport pattern) rather than the
// `express-serve-static-core` module so this compiles WITHOUT express installed
// as a dependency of the SDK, and still merges with the consumer's @types/express.
// Only active when you import from '@onelo/node/express'. It's optional + nullable
// (undefined before the middleware runs, null in optionalUser), so in a
// requireUser-protected handler assert non-null: `req.oneloUser!.id`.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      oneloUser?: OneloUser | null
    }
  }
}

interface ExpressRequest {
  headers: Record<string, string | string[] | undefined>
  query?: Record<string, unknown>
  /** Set by the adapter — the verified user (`null` in optionalUser). */
  oneloUser?: OneloUser | null
  [key: string]: unknown
}

interface ExpressResponse {
  status(code: number): ExpressResponse
  json(body: unknown): unknown
}

type NextFunction = (err?: unknown) => void

type ExpressMiddleware = (
  req: ExpressRequest,
  res: ExpressResponse,
  next: NextFunction,
) => void | Promise<void>

function getAuthHeader(req: ExpressRequest): string | null {
  // Node lowercases all incoming header names, so 'authorization' is canonical.
  const h = req.headers['authorization']
  if (Array.isArray(h)) return h[0] ?? null
  return h ?? null
}

function getQueryToken(req: ExpressRequest): string | null {
  const q = req.query?.token
  if (typeof q === 'string') return q
  if (Array.isArray(q) && typeof q[0] === 'string') return q[0]
  return null
}

/**
 * Middleware that requires a verified Onelo user. On success, attaches the user
 * to `req.oneloUser` and calls `next()`. On auth failure, responds with the
 * mapped status/body and does NOT call `next()`. Unexpected (non-auth) errors
 * are forwarded to `next(err)` for your error handler.
 */
export function requireUser(client: AuthClient, options: ResolverOptions = {}): ExpressMiddleware {
  const { resolve } = createResolver(client, options)
  return async (req, res, next) => {
    try {
      req.oneloUser = await resolve(getAuthHeader(req), getQueryToken(req))
    } catch (err) {
      if (err instanceof AuthHttpError) {
        res.status(err.status).json(err.body)
        return
      }
      next(err)
      return
    }
    // next() sits outside the try so a downstream synchronous throw can never be
    // caught here and turned into a second next()/response.
    next()
  }
}

/**
 * Like {@link requireUser} but sets `req.oneloUser = null` and continues on
 * missing / invalid / forbidden tokens. A backend outage (503) still short-
 * circuits — silently degrading an outage to anonymous would mask incidents.
 */
export function optionalUser(client: AuthClient, options: ResolverOptions = {}): ExpressMiddleware {
  const { resolve } = createResolver(client, options)
  return async (req, res, next) => {
    try {
      req.oneloUser = await resolve(getAuthHeader(req), getQueryToken(req))
    } catch (err) {
      if (err instanceof AuthHttpError) {
        if (err.status === 401 || err.status === 403) {
          req.oneloUser = null
          next()
          return
        }
        res.status(err.status).json(err.body) // 503 surfaces
        return
      }
      next(err)
      return
    }
    next()
  }
}

// ── Monitor ─────────────────────────────────────────────────────────────────

interface WithMonitor {
  monitor: MonitorClient
}

type ExpressErrorMiddleware = (
  err: unknown,
  req: ExpressRequest,
  res: ExpressResponse,
  next: NextFunction,
) => void

/**
 * Runs each request inside a fresh monitor isolation scope, so `setUser` /
 * breadcrumbs captured during one request never bleed into a concurrent one.
 * Place this EARLY (before your routes). Pair it with {@link monitorErrorHandler}
 * placed LAST so thrown errors are captured within the same scope.
 */
export function monitorRequestHandler(onelo: WithMonitor): ExpressMiddleware {
  return (req, res, next) => {
    onelo.monitor.runWithIsolationScope(() => {
      attachRequestToScope(onelo.monitor, {
        method: String(req.method ?? ''),
        url: String((req.originalUrl ?? req.url ?? '') as string),
        headers: req.headers,
      })
      next()
    })
  }
}

/**
 * Express error-handling middleware that reports the error to Onelo Monitor and
 * re-passes it to the next handler (never swallows). Place it LAST, after your
 * routes — and after {@link monitorRequestHandler} so the report carries that
 * request's user + breadcrumbs.
 */
export function monitorErrorHandler(onelo: WithMonitor): ExpressErrorMiddleware {
  return (err, _req, _res, next) => {
    onelo.monitor.captureException(err)
    next(err)
  }
}
