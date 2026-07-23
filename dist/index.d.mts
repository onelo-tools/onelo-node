export { a as AddBreadcrumbOptions, b as AuthCache, A as AuthClient, c as AuthHttpError, B as Breadcrumb, d as BreadcrumbCategory, e as Breadcrumbs, C as CaptureExceptionOptions, f as CaptureMessageOptions, g as CaptureMonitor, h as CapturedException, i as CarrierOptions, j as ConsoleCaptureOptions, E as EventLevel, F as Feature, k as FeaturesClient, l as FetchBreadcrumbOptions, m as FetchLike, n as ForUserOptions, I as InProcessAuthCache, M as MonitorClient, o as MonitorEvent, p as MonitorInitOptions, q as OnAuthEvent, r as Onelo, s as OneloConfig, O as OneloUser, t as Resolver, R as ResolverOptions, S as StackFrame, T as TrackOptions, U as UserFeatures, V as VerifyRetryOptions, u as createResolver, v as extractBearerToken, w as installConsoleCapture, x as installFetchBreadcrumbs, y as parseRetryAfter, z as verifyToken, D as verifyWithRetry } from './resolve-djpcxzNJ.mjs';

/**
 * Onelo auth error taxonomy — 1:1 with the Python SDK (`onelo.auth`).
 *
 * The class hierarchy is load-bearing: adapters map each type to an HTTP
 * status, and the retry loop keys off `OneloAuthUnavailable`. Keep the
 * inheritance exactly as-is:
 *
 *   OneloAuthError
 *   ├── OneloAuthMissingToken   → 401 (no/blank/malformed bearer token)
 *   ├── OneloAuthInvalidToken   → 401 (backend 401: expired/revoked)
 *   ├── OneloAuthForbidden      → 403 (backend 403, or a failed gate)
 *   └── OneloAuthUnavailable    → 503 (backend 5xx after retries / network)
 *       └── OneloAuthRateLimited → still 503, but the retry loop skips it
 */
declare class OneloAuthError extends Error {
    constructor(message?: string);
}
/** No bearer token was supplied (header missing / malformed / empty). */
declare class OneloAuthMissingToken extends OneloAuthError {
}
/** Backend returned 401 — token expired, revoked, or malformed. */
declare class OneloAuthInvalidToken extends OneloAuthError {
}
/**
 * Backend returned 403 — token valid but principal not allowed. Also thrown by
 * the resolver when an authenticated user fails an extra gate
 * (`requireEmailVerified` / `requirePlan`).
 */
declare class OneloAuthForbidden extends OneloAuthError {
}
/** Onelo backend returned a 5xx (retries exhausted) or the network failed. */
declare class OneloAuthUnavailable extends OneloAuthError {
}
/**
 * Backend returned 429 Too Many Requests.
 *
 * Subclass of {@link OneloAuthUnavailable} so existing "backend unavailable →
 * 503" handlers keep working — BUT the retry loops treat it specially: they do
 * NOT retry a rate-limit (retrying immediately only makes it worse and burns
 * the wall-clock budget). `retryAfter` carries the parsed `Retry-After`
 * seconds when the backend supplied one, else `null`.
 */
declare class OneloAuthRateLimited extends OneloAuthUnavailable {
    readonly retryAfter: number | null;
    constructor(message?: string, retryAfter?: number | null);
}

/**
 * Strategy resolution. 1:1 with Python's `onelo._detection`. In v1, "auto" maps
 * to "sse". This function exists so multi-worker heuristics / a Redis
 * coordinator can be added later without changing the public API.
 */
type Strategy = 'sse' | 'polling';

declare function getInstanceId(): string;

declare const VERSION = "0.5.0-staging";

export { OneloAuthError, OneloAuthForbidden, OneloAuthInvalidToken, OneloAuthMissingToken, OneloAuthRateLimited, OneloAuthUnavailable, type Strategy, VERSION, getInstanceId };
