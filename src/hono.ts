/**
 * Hono adapter for Onelo auth (middleware).
 *
 *   import { Onelo } from '@onelo/node'
 *   import { requireUser } from '@onelo/node/hono'
 *
 *   const onelo = new Onelo({ secretKey: process.env.ONELO_SECRET_KEY!, apiUrl: process.env.ONELO_API_URL! })
 *
 *   app.use('/me', requireUser(onelo))
 *   app.get('/me', (c) => {
 *     const user = c.get('oneloUser')  // OneloUser
 *     return c.json({ id: user.id, email: user.email })
 *   })
 *
 * Status mapping: 401 missing/invalid · 403 forbidden/gate · 503 backend outage.
 *
 * Typed against a minimal structural `Context` so no `hono` dependency is
 * required — the real Hono `Context` satisfies it at runtime. The verified user
 * is stashed via `c.set('oneloUser', ...)`; read it with `c.get('oneloUser')`.
 */
import type { AuthClient } from './client'
import { AuthHttpError, createResolver, type ResolverOptions } from './auth/resolve'
import type { OneloUser } from './auth/user'
import type { MonitorClient } from './monitor/client'
import { attachRequestToScope } from './monitor/request-context'

interface HonoContext {
  req: {
    header(name: string): string | undefined
    header(): Record<string, string>
    query(name: string): string | undefined
    method?: string
    url?: string
  }
  set(key: string, value: unknown): void
  json(body: unknown, status?: number): Response
}

type HonoMiddleware = (c: HonoContext, next: () => Promise<void>) => Promise<Response | void>

/**
 * Middleware requiring a verified Onelo user. On success stashes the user at
 * `c.set('oneloUser', user)` and calls `next()`. On auth failure returns a JSON
 * response with the mapped status (401 / 403 / 503) and does NOT call `next()`.
 */
export function requireUser(client: AuthClient, options: ResolverOptions = {}): HonoMiddleware {
  const { resolve } = createResolver(client, options)
  return async (c, next) => {
    let user: OneloUser
    try {
      user = await resolve(c.req.header('authorization') ?? null, c.req.query('token') ?? null)
    } catch (err) {
      if (err instanceof AuthHttpError) {
        return c.json(err.body, err.status)
      }
      throw err
    }
    c.set('oneloUser', user)
    await next()
  }
}

/**
 * Like {@link requireUser} but stashes `oneloUser = null` and continues on
 * missing / invalid / forbidden tokens. A backend outage (503) still returns
 * early.
 */
export function optionalUser(client: AuthClient, options: ResolverOptions = {}): HonoMiddleware {
  const { resolve } = createResolver(client, options)
  return async (c, next) => {
    let user: OneloUser | null = null
    try {
      user = await resolve(c.req.header('authorization') ?? null, c.req.query('token') ?? null)
    } catch (err) {
      if (err instanceof AuthHttpError) {
        if (err.status !== 401 && err.status !== 403) {
          return c.json(err.body, err.status) // 503 surfaces
        }
        user = null
      } else {
        throw err
      }
    }
    c.set('oneloUser', user)
    await next()
  }
}

// ── Monitor ─────────────────────────────────────────────────────────────────

interface WithMonitor {
  monitor: MonitorClient
}

/**
 * Hono middleware: runs each request in a fresh monitor isolation scope and
 * reports any thrown error to Onelo Monitor (then re-throws so Hono's own error
 * handling still runs). Register before your routes: `app.use('*', oneloMonitor(onelo))`.
 */
export function oneloMonitor(onelo: WithMonitor): HonoMiddleware {
  return (c, next) =>
    onelo.monitor.runWithIsolationScope(async () => {
      attachRequestToScope(onelo.monitor, {
        method: String(c.req.method ?? ''),
        url: c.req.url,
        headers: c.req.header(),
      })
      try {
        await next()
      } catch (err) {
        onelo.monitor.captureException(err)
        throw err
      }
    })
}
