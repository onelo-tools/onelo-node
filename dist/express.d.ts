import { O as OneloUser, M as MonitorClient, A as AuthClient, R as ResolverOptions } from './resolve-C99eM3-Q.js';

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

declare global {
    namespace Express {
        interface Request {
            oneloUser?: OneloUser | null;
        }
    }
}
interface ExpressRequest {
    headers: Record<string, string | string[] | undefined>;
    query?: Record<string, unknown>;
    /** Set by the adapter — the verified user (`null` in optionalUser). */
    oneloUser?: OneloUser | null;
    [key: string]: unknown;
}
interface ExpressResponse {
    status(code: number): ExpressResponse;
    json(body: unknown): unknown;
}
type NextFunction = (err?: unknown) => void;
type ExpressMiddleware = (req: ExpressRequest, res: ExpressResponse, next: NextFunction) => void | Promise<void>;
/**
 * Middleware that requires a verified Onelo user. On success, attaches the user
 * to `req.oneloUser` and calls `next()`. On auth failure, responds with the
 * mapped status/body and does NOT call `next()`. Unexpected (non-auth) errors
 * are forwarded to `next(err)` for your error handler.
 */
declare function requireUser(client: AuthClient, options?: ResolverOptions): ExpressMiddleware;
/**
 * Like {@link requireUser} but sets `req.oneloUser = null` and continues on
 * missing / invalid / forbidden tokens. A backend outage (503) still short-
 * circuits — silently degrading an outage to anonymous would mask incidents.
 */
declare function optionalUser(client: AuthClient, options?: ResolverOptions): ExpressMiddleware;
interface WithMonitor {
    monitor: MonitorClient;
}
type ExpressErrorMiddleware = (err: unknown, req: ExpressRequest, res: ExpressResponse, next: NextFunction) => void;
/**
 * Runs each request inside a fresh monitor isolation scope, so `setUser` /
 * breadcrumbs captured during one request never bleed into a concurrent one.
 * Place this EARLY (before your routes). Pair it with {@link monitorErrorHandler}
 * placed LAST so thrown errors are captured within the same scope.
 */
declare function monitorRequestHandler(onelo: WithMonitor): ExpressMiddleware;
/**
 * Express error-handling middleware that reports the error to Onelo Monitor and
 * re-passes it to the next handler (never swallows). Place it LAST, after your
 * routes — and after {@link monitorRequestHandler} so the report carries that
 * request's user + breadcrumbs.
 */
declare function monitorErrorHandler(onelo: WithMonitor): ExpressErrorMiddleware;

export { monitorErrorHandler, monitorRequestHandler, optionalUser, requireUser };
