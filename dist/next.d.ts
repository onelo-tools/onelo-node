import { O as OneloUser, M as MonitorClient, A as AuthClient, R as ResolverOptions } from './resolve-djpcxzNJ.js';

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

/** A Next.js route handler that receives the verified user as its 2nd arg. */
type UserRouteHandler<Ctx = unknown> = (req: Request, user: OneloUser, ctx: Ctx) => Response | Promise<Response>;
/** A Next.js route handler that receives `user | null` as its 2nd arg. */
type OptionalUserRouteHandler<Ctx = unknown> = (req: Request, user: OneloUser | null, ctx: Ctx) => Response | Promise<Response>;
/**
 * Wrap a route handler so it only runs for a verified Onelo user. Returns a
 * handler with the standard `(req, ctx)` signature Next expects.
 */
declare function withUser<Ctx = unknown>(client: AuthClient, handler: UserRouteHandler<Ctx>, options?: ResolverOptions): (req: Request, ctx: Ctx) => Promise<Response>;
/**
 * Like {@link withUser} but calls the handler with `user = null` on missing /
 * invalid / forbidden tokens. A backend outage (503) still returns early.
 */
declare function withOptionalUser<Ctx = unknown>(client: AuthClient, handler: OptionalUserRouteHandler<Ctx>, options?: ResolverOptions): (req: Request, ctx: Ctx) => Promise<Response>;
interface WithMonitor {
    monitor: MonitorClient;
}
/**
 * Wrap a route handler so the whole request runs in a fresh monitor isolation
 * scope and any thrown error is reported to Onelo Monitor (then re-thrown, so
 * Next still renders your error page / 500). Compose with {@link withUser}:
 *
 *   export const GET = withMonitor(onelo, withUser(onelo, async (req, user) => { ... }))
 */
declare function withMonitor<Ctx = unknown>(onelo: WithMonitor, handler: (req: Request, ctx: Ctx) => Response | Promise<Response>): (req: Request, ctx: Ctx) => Promise<Response>;

export { type OptionalUserRouteHandler, type UserRouteHandler, withMonitor, withOptionalUser, withUser };
