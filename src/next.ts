/**
 * Next.js App Router adapter for Onelo auth (route handlers).
 *
 *   import { Onelo } from '@onelo/node'
 *   import { withUser } from '@onelo/node/next'
 *
 *   const onelo = new Onelo({ secretKey: process.env.ONELO_SECRET_KEY!, apiUrl: process.env.ONELO_API_URL! })
 *
 *   // app/api/me/route.ts
 *   export const GET = withUser(onelo, async (req, user) => {
 *     return Response.json({ id: user.id, email: user.email })
 *   })
 *
 * On auth failure the wrapper returns a JSON `Response` with the mapped status
 * (401 / 403 / 503) — your handler is only called with a verified user.
 *
 * Works with the Web `Request`/`Response` globals (Node 18+ / the Next runtime),
 * so no `next` dependency is needed.
 */
import type { AuthClient } from './client'
import { AuthHttpError, createResolver, type ResolverOptions } from './auth/resolve'
import type { OneloUser } from './auth/user'
import type { MonitorClient } from './monitor/client'
import { attachRequestToScope } from './monitor/request-context'

/** A Next.js route handler that receives the verified user as its 2nd arg. */
export type UserRouteHandler<Ctx = unknown> = (
  req: Request,
  user: OneloUser,
  ctx: Ctx,
) => Response | Promise<Response>

/** A Next.js route handler that receives `user | null` as its 2nd arg. */
export type OptionalUserRouteHandler<Ctx = unknown> = (
  req: Request,
  user: OneloUser | null,
  ctx: Ctx,
) => Response | Promise<Response>

function getQueryToken(req: Request): string | null {
  try {
    return new URL(req.url).searchParams.get('token')
  } catch {
    return null
  }
}

/**
 * Build a JSON error Response without relying on the static `Response.json`
 * (only present on Node >= 18.13 / the Next runtime) — `new Response(...)` works
 * on every Node 18. The success path returns the handler's own Response.
 */
function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Wrap a route handler so it only runs for a verified Onelo user. Returns a
 * handler with the standard `(req, ctx)` signature Next expects.
 */
export function withUser<Ctx = unknown>(
  client: AuthClient,
  handler: UserRouteHandler<Ctx>,
  options: ResolverOptions = {},
): (req: Request, ctx: Ctx) => Promise<Response> {
  const { resolve } = createResolver(client, options)
  return async (req, ctx) => {
    let user: OneloUser
    try {
      user = await resolve(req.headers.get('authorization'), getQueryToken(req))
    } catch (err) {
      if (err instanceof AuthHttpError) {
        return jsonResponse(err.body, err.status)
      }
      throw err
    }
    return handler(req, user, ctx)
  }
}

/**
 * Like {@link withUser} but calls the handler with `user = null` on missing /
 * invalid / forbidden tokens. A backend outage (503) still returns early.
 */
export function withOptionalUser<Ctx = unknown>(
  client: AuthClient,
  handler: OptionalUserRouteHandler<Ctx>,
  options: ResolverOptions = {},
): (req: Request, ctx: Ctx) => Promise<Response> {
  const { resolve } = createResolver(client, options)
  return async (req, ctx) => {
    let user: OneloUser | null = null
    try {
      user = await resolve(req.headers.get('authorization'), getQueryToken(req))
    } catch (err) {
      if (err instanceof AuthHttpError) {
        if (err.status === 401 || err.status === 403) {
          user = null
        } else {
          return jsonResponse(err.body, err.status) // 503 surfaces
        }
      } else {
        throw err
      }
    }
    return handler(req, user, ctx)
  }
}

// ── Monitor ─────────────────────────────────────────────────────────────────

interface WithMonitor {
  monitor: MonitorClient
}

/**
 * Wrap a route handler so the whole request runs in a fresh monitor isolation
 * scope and any thrown error is reported to Onelo Monitor (then re-thrown, so
 * Next still renders your error page / 500). Compose with {@link withUser}:
 *
 *   export const GET = withMonitor(onelo, withUser(onelo, async (req, user) => { ... }))
 */
export function withMonitor<Ctx = unknown>(
  onelo: WithMonitor,
  handler: (req: Request, ctx: Ctx) => Response | Promise<Response>,
): (req: Request, ctx: Ctx) => Promise<Response> {
  return (req, ctx) =>
    onelo.monitor.runWithIsolationScope(async () => {
      attachRequestToScope(onelo.monitor, {
        method: req.method,
        url: req.url,
        headers: req.headers,
      })
      try {
        return await handler(req, ctx)
      } catch (err) {
        onelo.monitor.captureException(err)
        throw err
      }
    })
}
