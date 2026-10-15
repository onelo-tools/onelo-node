import { M as MonitorClient, A as AuthClient, R as ResolverOptions } from './resolve-MQ3XTnzg.mjs';

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

interface HonoContext {
    req: {
        header(name: string): string | undefined;
        header(): Record<string, string>;
        query(name: string): string | undefined;
        method?: string;
        url?: string;
    };
    set(key: string, value: unknown): void;
    json(body: unknown, status?: number): Response;
}
type HonoMiddleware = (c: HonoContext, next: () => Promise<void>) => Promise<Response | void>;
/**
 * Middleware requiring a verified Onelo user. On success stashes the user at
 * `c.set('oneloUser', user)` and calls `next()`. On auth failure returns a JSON
 * response with the mapped status (401 / 403 / 503) and does NOT call `next()`.
 */
declare function requireUser(client: AuthClient, options?: ResolverOptions): HonoMiddleware;
/**
 * Like {@link requireUser} but stashes `oneloUser = null` and continues on
 * missing / invalid / forbidden tokens. A backend outage (503) still returns
 * early.
 */
declare function optionalUser(client: AuthClient, options?: ResolverOptions): HonoMiddleware;
interface WithMonitor {
    monitor: MonitorClient;
}
/**
 * Hono middleware: runs each request in a fresh monitor isolation scope and
 * reports any thrown error to Onelo Monitor (then re-throws so Hono's own error
 * handling still runs). Register before your routes: `app.use('*', oneloMonitor(onelo))`.
 */
declare function oneloMonitor(onelo: WithMonitor): HonoMiddleware;

export { oneloMonitor, optionalUser, requireUser };
