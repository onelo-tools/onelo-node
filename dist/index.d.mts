import { F as FetchLike, O as OneloUser } from './resolve-MQ3XTnzg.mjs';
export { a as AddBreadcrumbOptions, b as AuthCache, A as AuthClient, c as AuthHttpError, B as Breadcrumb, d as BreadcrumbCategory, e as Breadcrumbs, C as CaptureExceptionOptions, f as CaptureMessageOptions, g as CaptureMonitor, h as CapturedException, i as CarrierOptions, j as ConsoleCaptureOptions, E as EventLevel, k as Feature, l as FeaturesClient, m as FetchBreadcrumbOptions, n as ForUserOptions, I as InProcessAuthCache, M as MonitorClient, o as MonitorEvent, p as MonitorInitOptions, q as OnAuthEvent, r as Onelo, s as OneloConfig, t as Resolver, R as ResolverOptions, S as StackFrame, T as TrackOptions, U as UserFeatures, V as VerifyRetryOptions, u as createResolver, v as extractBearerToken, w as installConsoleCapture, x as installFetchBreadcrumbs, y as parseRetryAfter, z as verifyToken, D as verifyWithRetry } from './resolve-MQ3XTnzg.mjs';

/**
 * An App may bring its own sign-in (ADR-0032). Its frontend then sends the
 * developer's server the token of its own issuer (Supabase, Clerk, Firebase,
 * any OpenID Connect issuer) instead of an Onelo session token. The server
 * identifies the App User through `POST /api/sdk/auth/exchange`, with its
 * Secret Key.
 *
 * This file holds what is particular to that door: telling the two kinds of
 * token apart, reading the door's answer, and remembering that an App is on
 * Onelo Auth. `verifyToken` in verify.ts does the calls.
 */

/** The Onelo session the exchange minted for an issuer token. */
interface IssuedSession {
    /** An ordinary Onelo session token; `/user` verifies it like any other. */
    accessToken: string;
    /** Seconds until it lapses. */
    expiresIn: number;
}

/**
 * The server assertion (#800, ADR-0032). For an App in an external Sign-in
 * Mode whose backend has no issuer tokens (classic server sessions): the
 * developer's server says "this is App User external id X with e-mail Y" with
 * an identity-only key (`onelo_ik_…`) and gets back an ordinary Onelo session
 * for that External Identity — 30 minutes, no refresh token.
 *
 * The identity-only key can do nothing but this. It is not a Secret Key, so it
 * is not part of the `Onelo` client: it is passed here and nowhere else. It is
 * a server credential, so this function refuses to run in a browser.
 */

interface AssertIdentityOptions {
    /** Your Onelo API URL. Required, no default. */
    apiUrl: string;
    /** The identity-only key (`onelo_ik_…`) from the dashboard's API Keys page. */
    identityKey: string;
    /** Your own id for the user. The External Identity is (App, issuer, this id). */
    externalId: string;
    /** The user's e-mail, when you have one. */
    email?: string;
    /** Whether YOUR server verified that e-mail. Default false. */
    emailVerified?: boolean;
    /** Optional `fetch` override (tests / custom transport). */
    fetchImpl?: FetchLike;
    /** Request timeout in ms. Default 10000. */
    timeoutMs?: number;
}
/** The App User and the Onelo session minted for them. */
interface AssertedIdentity {
    user: OneloUser;
    session: IssuedSession;
}
/**
 * `POST /api/sdk/auth/assert`: sign the user your server already knows into
 * Onelo. Throws the auth error taxonomy, each error carrying Onelo's refusal
 * `code` (`invalid_identity_key`, `ip_not_allowed`, `sign_in_mode_onelo`,
 * `banned`, `email_in_use`, `rate_limited`, …).
 */
declare function assertIdentity(options: AssertIdentityOptions): Promise<AssertedIdentity>;

/**
 * Onelo auth error taxonomy — 1:1 with the Python SDK (`onelo.auth`).
 *
 * The class hierarchy is load-bearing: adapters map each type to an HTTP
 * status, and the retry loop keys off `OneloAuthUnavailable`. Keep the
 * inheritance exactly as-is:
 *
 *   OneloAuthError
 *   ├── OneloAuthMissingToken   → 401 (no/blank/malformed bearer token)
 *   ├── OneloAuthInvalidToken   → 401 (backend 401: expired/revoked/refused)
 *   ├── OneloAuthForbidden      → 403 (backend 403, a failed gate, or 409 for
 *   │                                  an issuer token: e-mail already in use)
 *   └── OneloAuthUnavailable    → 503 (backend 5xx after retries / network)
 *       └── OneloAuthRateLimited → still 503, but the retry loop skips it
 *
 * Every error carries `code`: the refusal code Onelo named, or `null`.
 */
declare class OneloAuthError extends Error {
    /**
     * The refusal code Onelo sent, when it sent one — e.g. `token_expired`,
     * `banned`, `email_in_use` for an issuer token (own sign-in). `null` when
     * the backend named no code.
     */
    readonly code: string | null;
    constructor(message?: string, code?: string | null);
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
    constructor(message?: string, retryAfter?: number | null, code?: string | null);
}

/**
 * Strategy resolution. 1:1 with Python's `onelo._detection`. In v1, "auto" maps
 * to "sse". This function exists so multi-worker heuristics / a Redis
 * coordinator can be added later without changing the public API.
 */
type Strategy = 'sse' | 'polling';

declare function getInstanceId(): string;

declare const VERSION = "0.10.1";

export { type AssertIdentityOptions, type AssertedIdentity, FetchLike, type IssuedSession, OneloAuthError, OneloAuthForbidden, OneloAuthInvalidToken, OneloAuthMissingToken, OneloAuthRateLimited, OneloAuthUnavailable, OneloUser, type Strategy, VERSION, assertIdentity, getInstanceId };
