import { A as AuthClient, R as ResolverOptions, O as OneloUser, M as MonitorClient } from './resolve-C99eM3-Q.js';

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

interface FastifyRequest {
    headers: Record<string, string | string[] | undefined>;
    query?: unknown;
    /** Set by the adapter — the verified user (`null` in optionalUser). */
    oneloUser?: OneloUser | null;
    [key: string]: unknown;
}
interface FastifyReply {
    code(statusCode: number): FastifyReply;
    send(payload: unknown): unknown;
}
type PreHandlerHook = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
/**
 * A `preHandler` hook that requires a verified Onelo user. On success attaches
 * `req.oneloUser`. On auth failure it sends the mapped status/body and returns
 * the reply (Fastify then stops the chain). Unexpected errors rethrow into
 * Fastify's error handling.
 */
declare function requireUser(client: AuthClient, options?: ResolverOptions): PreHandlerHook;
/**
 * Like {@link requireUser} but sets `req.oneloUser = null` and continues on
 * missing / invalid / forbidden tokens. A backend outage (503) still short-
 * circuits.
 */
declare function optionalUser(client: AuthClient, options?: ResolverOptions): PreHandlerHook;
interface WithMonitor {
    monitor: MonitorClient;
}
interface FastifyLike {
    addHook(name: 'onRequest', fn: (req: FastifyRequest, reply: FastifyReply, done: () => void) => void): unknown;
    addHook(name: 'onError', fn: (req: FastifyRequest, reply: FastifyReply, error: unknown, done: () => void) => void): unknown;
}
/**
 * Register Onelo Monitor on a Fastify instance: each request runs in a fresh
 * isolation scope (via `onRequest`) so per-request user/breadcrumbs don't bleed,
 * and thrown errors are reported (via `onError`) within that same scope.
 *
 *   const fastify = Fastify()
 *   registerOneloMonitor(fastify, onelo)
 */
declare function registerOneloMonitor(fastify: FastifyLike, onelo: WithMonitor): void;

export { optionalUser, registerOneloMonitor, requireUser };
