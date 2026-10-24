/**
 * The authenticated Onelo user returned by `GET /api/sdk/auth/user`, or by
 * `POST /api/sdk/auth/exchange` (its `user`) for an App with its own sign-in.
 *
 * Mirrors Python's `onelo.auth.OneloUser`. The backend response schema today is
 * `{ id, email, created_at, metadata }`; `email_verified` and `plan` are not
 * always present at the top level, so `fromPayload` falls back to `metadata`.
 * The full payload is preserved on `raw`.
 */
declare class OneloUser {
    /** Stable Onelo user id (`app_user_id` or Supabase user id). */
    readonly id: string;
    /** User's primary email. */
    readonly email: string;
    /** Whether the email is verified. Defaults to `false` when unknown. */
    readonly emailVerified: boolean;
    /** The user's current plan (`free` / `pro` / ...), or `null` if unknown. */
    readonly plan: string | null;
    /** Free-form metadata dict surfaced by the backend. */
    readonly metadata: Record<string, unknown>;
    /** Full JSON payload returned by the backend. */
    readonly raw: Record<string, unknown>;
    constructor(
    /** Stable Onelo user id (`app_user_id` or Supabase user id). */
    id: string, 
    /** User's primary email. */
    email: string, 
    /** Whether the email is verified. Defaults to `false` when unknown. */
    emailVerified: boolean, 
    /** The user's current plan (`free` / `pro` / ...), or `null` if unknown. */
    plan: string | null, 
    /** Free-form metadata dict surfaced by the backend. */
    metadata: Record<string, unknown>, 
    /** Full JSON payload returned by the backend. */
    raw: Record<string, unknown>);
    /**
     * Map a backend `/api/sdk/auth/user` response to an OneloUser. Tolerant of
     * missing fields — `email_verified` / `plan` fall back to `metadata`.
     */
    static fromPayload(payload: Record<string, unknown>): OneloUser;
}

/**
 * Token verification — the framework-agnostic core. 1:1 with Python's
 * `onelo.auth.verify_token` + `_map_response`, collapsed to a single async
 * function (Node has no sync/async split).
 */

/** A `fetch`-compatible function. Injectable for tests / custom transports. */
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
/**
 * Parse a `Retry-After` header (seconds form). Returns `null` when absent,
 * invalid, or negative. HTTP-date form is not supported (Onelo sends seconds).
 */
declare function parseRetryAfter(value: string | null | undefined): number | null;
/**
 * Pull a bearer token out of an `Authorization` header value. Returns `null`
 * when the header is absent, not a `bearer` scheme, or the token is empty. The
 * scheme match is case-insensitive.
 */
declare function extractBearerToken(authorization: string | null | undefined): string | null;
/**
 * Verify a user-supplied token against the Onelo backend.
 *
 * Low-level helper for any Node stack (websockets, queue workers, custom
 * middleware). The framework adapters layer caching, retries, and gates on top.
 *
 * The token is either an Onelo session token or, for an App that brings its
 * own sign-in, the token of its issuer (Supabase, Clerk, Firebase, any OpenID
 * Connect issuer). An issuer token is exchanged at Onelo, which verifies it
 * and answers with the App User; nothing about it is trusted here.
 *
 * @param client An {@link AuthClient} constructed with a **secret** key —
 *   verifying a user token requires server-side credentials.
 * @param token  The user's token (NOT your secret key).
 * @throws {OneloAuthMissingToken} token is empty / whitespace.
 * @throws {OneloAuthError}        client was built with a publishable key.
 * @throws {OneloAuthInvalidToken} backend returned 401.
 * @throws {OneloAuthForbidden}    backend returned 403, or 409 for an issuer token.
 * @throws {OneloAuthRateLimited}  backend returned 429.
 * @throws {OneloAuthUnavailable}  backend 5xx, network failure, unexpected status.
 */
declare function verifyToken(client: AuthClient, token: string): Promise<OneloUser>;
/** Options for {@link verifyWithRetry}. */
interface VerifyRetryOptions {
    /** Total attempts on 5xx (including the initial try). Default 3. */
    retryAttempts?: number;
    /** Hard wall-clock cap (ms) on the entire retry sequence. Default 2000. */
    retryTotalTimeout?: number;
}
/**
 * `verifyToken` + a 5xx retry policy with a wall-clock budget. Exponential
 * backoff (100, 200, 400 ...), bounded by `retryTotalTimeout`. A 429 rate-limit
 * is NOT retried (retrying immediately only deepens it). Mirrors Python's
 * `RequireUser._verify_with_retry` / `verify_token_sync`.
 */
declare function verifyWithRetry(client: AuthClient, token: string, options?: VerifyRetryOptions): Promise<OneloUser>;

/**
 * In-memory feature-state cache. 1:1 with Python's `onelo._cache.ThreadSafeCache`
 * minus the lock — Node is single-threaded, so reads/writes on the Map are
 * already atomic on the event loop.
 *
 * Stores the FULL per-feature wire state dict (`{ status, reason, required_plan,
 * required_plan_label, upgrade_cta }`) so callers can surface upsell metadata,
 * not just the binary status. Missing feature → `{ status: 'hidden' }`
 * (fail-closed default per the SDK protocol).
 */
type FeatureState = Record<string, unknown>;
declare class FeatureCache {
    private features;
    private _configVersion;
    /** Canonicalise a per-feature value: full wire dict (copied) or bare status string. */
    private normalize;
    /** Full wire state dict for `name`, or `{status:'hidden'}` on miss. Defensive copy. */
    getState(name: string): FeatureState;
    /** Wire status string for `name`, or 'hidden' on miss. Status-only convenience. */
    get(name: string): string;
    /** Atomically replace the entire snapshot. Values may be dicts or status strings. */
    replaceAll(features: Record<string, unknown> | null | undefined, version: number): void;
    get configVersion(): number;
    /**
     * Stable `{ name: status }` copy. Status-only by design — used by the monitor
     * module to stamp active flag values on captured events (F3).
     */
    snapshot(): Record<string, string>;
}

/**
 * The `Feature` value object + `UserFeatures` snapshot. 1:1 with Python's
 * `onelo._features.Feature` / `UserFeatures`, including the exact status
 * vocabulary and the fail-closed `isVisible`/`isKnown` semantics.
 */

/**
 * A single feature's resolved state. Carries the backend's full upsell metadata
 * so a server-rendered app (Next.js SSR, Express+templates) can build an
 * "Available in Pro" CTA — not just a binary on/off.
 */
declare class Feature {
    readonly name: string;
    readonly status: string;
    readonly reason: string | null;
    readonly requiredPlan: string | null;
    readonly requiredPlanLabel: string | null;
    readonly upgradeCta: boolean;
    constructor(name: string, status: string, reason?: string | null, requiredPlan?: string | null, requiredPlanLabel?: string | null, upgradeCta?: boolean);
    /**
     * Build a Feature from a backend wire state dict. Tolerates a bare status
     * string, ignores unknown extra keys (forward-compat). Missing status →
     * hidden (fail-closed).
     */
    static fromWire(name: string, state: unknown): Feature;
    /** True for enabled / new / beta — the default check for binary gating. */
    get isEnabled(): boolean;
    /**
     * True for any user-visible status. False for hidden AND for any status this
     * SDK build does not recognise — fail-closed, so a typo or a newer backend
     * status never renders as a blank visible item.
     */
    get isVisible(): boolean;
    get isGreyed(): boolean;
    get isNew(): boolean;
    get isBeta(): boolean;
    get isComingSoon(): boolean;
    /** Feature is in upsell mode — a paid/locked teaser shown to the user. */
    get isUpsell(): boolean;
    /**
     * True if `status` is one this SDK build understands. False means the backend
     * returned a status newer than this SDK (treated as hidden) — surface it as a
     * hint to upgrade the SDK.
     */
    get isKnown(): boolean;
    /**
     * The human plan LABEL to show as an upsell (e.g. "Pro"), or null when the
     * backend attached no label. Render as `Available in ${feature.upgradeHint}`.
     * The backend is the authority — it attaches the label only to a
     * blocked-but-visible feature a real upgrade would unlock.
     */
    get upgradeHint(): string | null;
}
/**
 * Resolved feature snapshot for ONE specific user — returned by
 * `features.forUser()`. Read-only; safe to share across async work. Unlike the
 * process-global `feature()` path, this never mutates SDK identity, so it is
 * SAFE per request/connection in a multi-user backend.
 */
declare class UserFeatures {
    readonly userId: string;
    private readonly states;
    constructor(userId: string, states: Record<string, FeatureState>);
    /** This feature's state (incl. upsell metadata) FOR THIS USER. Missing → hidden. */
    feature(name: string): Feature;
    /** Shorthand for `feature(name).isEnabled`. */
    isEnabled(name: string): boolean;
}

/**
 * Public `onelo.features` façade. 1:1 with Python's `onelo._features.FeaturesClient`.
 *
 * Cache-backed reads + auto-discovery: every `feature(name)` / `declare([...])`
 * records the slug and schedules a debounced batch-ping so the dashboard registry
 * fills in without explicit wiring. `forUser()` is the stateless, multi-user-safe
 * path (POST /resolve, per-user TTL cache) — no global identity mutation.
 */

interface FeaturesClientOptions {
    cache: FeatureCache;
    /** Ask the client to schedule a debounced discovery batch-ping. */
    scheduleBatchPing: () => void;
    /** Block until first backend contact (or timeout). */
    ready: (timeoutMs: number) => Promise<boolean>;
    /** Lazily start the background consumer on first feature use. Idempotent. */
    ensureStarted: () => void;
    apiUrl: string;
    /**
     * The client's key, sent as the `publishableKey` wire field. Per-user calls
     * (`forUser`) require it to be a secret key (#520).
     */
    key: string;
    requestTimeout: number;
    fetchImpl?: FetchLike;
    featureEnvironment: string | null;
}
interface ForUserOptions {
    /** Per-user cache TTL in seconds. Default 30. */
    ttl?: number;
}
declare class FeaturesClient {
    private readonly opts;
    private readonly discovered;
    private readonly userCache;
    private readonly warnedGated;
    constructor(opts: FeaturesClientOptions);
    /**
     * The Feature for `name`. Cache miss → hidden (fail-closed). Side effect: the
     * first sighting of `name` schedules a debounced batch-ping and lazily starts
     * the background stream. Mirrors Swift/Python `feature(_:)`.
     */
    feature(name: string): Feature;
    /** Shorthand for `feature(name).isEnabled`. */
    isEnabled(name: string): boolean;
    /**
     * Register feature names so they appear in the dashboard registry without
     * waiting for a code path to execute. Same debounce as `feature()`.
     */
    declare(names: string[]): void;
    /** Slug names this process has ever asked about (drives the batch-ping). */
    snapshotDiscovered(): string[];
    /** Block until the first backend snapshot lands (or timeout). Default 1500ms. */
    ready(timeoutMs?: number): Promise<boolean>;
    /**
     * Resolve features for a SPECIFIC user — the multi-user-safe path. Stateless
     * POST /resolve for THIS user; never touches global identity. Cached per-user
     * for `ttl` seconds. Fail-closed: any network/HTTP error → every feature
     * hidden (empty snapshot). Throws only for programmer/config errors: an empty
     * userId, or a client configured with a publishable key — a per-user call must
     * be signed with the secret key (#520).
     */
    forUser(userId: string, options?: ForUserOptions): Promise<UserFeatures>;
    private resolveUser;
    /**
     * Drop the cached per-user snapshot so the NEXT `forUser(userId)` re-fetches.
     * Call it the moment your backend learns a user's plan changed. Pass a userId
     * to invalidate one user, or nothing to clear EVERY cached user.
     */
    invalidateUser(userId?: string): void;
    private maybeWarnGated;
}

type BreadcrumbCategory = 'navigation' | 'http' | 'feature' | 'lifecycle' | 'user' | 'info' | 'error' | 'log' | 'auth' | 'db';
type EventLevel = 'debug' | 'info' | 'warning' | 'error' | 'fatal';
interface Breadcrumb {
    category: BreadcrumbCategory;
    message: string;
    /** Epoch seconds (matches Python `time()`). */
    timestamp: number;
    level: EventLevel;
    data?: Record<string, unknown>;
}
interface StackFrame {
    function: string | null;
    module: string | null;
    filename: string | null;
    lineno: number | null;
    colno: number | null;
    inApp: boolean;
    contextLine?: string | null;
}
interface CapturedException {
    type: string;
    message: string;
    frames: StackFrame[];
    /** For a chained cause (`throw new Error(msg, { cause })`). */
    cause?: CapturedException | null;
}
/** The wire envelope POSTed to /api/sdk/monitor/events/batch. */
interface MonitorEvent {
    featureName: string;
    ok: boolean;
    /** Epoch MILLISECONDS at event creation (serialised to ISO `ts` on the wire). */
    timestamp: number;
    durationMs?: number | null;
    error?: string | null;
    source: string;
    userId?: string | null;
    platform: string;
    sessionId?: string | null;
    meta: Record<string, unknown>;
}
declare const Breadcrumbs: {
    info(message: string, data?: Record<string, unknown>): Breadcrumb;
    http(method: string, url: string, status?: number, durationMs?: number, extra?: Record<string, unknown>): Breadcrumb;
    feature(name: string, value: string): Breadcrumb;
    lifecycle(event: string): Breadcrumb;
};

interface CarrierOptions {
    /** Also forward breadcrumbs (off by default — they bloat every queue message). */
    includeBreadcrumbs?: boolean;
    /** Shared secret (your publishable key) — HMAC-signs the carrier so the worker can verify integrity. */
    key?: string;
}

/** Minimal capture surface these integrations need — `MonitorClient` satisfies it. */
interface CaptureMonitor {
    captureException(err: unknown, opts?: {
        featureName?: string;
        meta?: Record<string, unknown>;
    }): void;
    captureMessage(msg: string, opts?: {
        level?: EventLevel;
        featureName?: string;
    }): void;
    addBreadcrumb(msg: string, opts?: {
        category?: BreadcrumbCategory;
        level?: EventLevel;
        data?: Record<string, unknown>;
    }): void;
}
type ConsoleMethod = 'error' | 'warn' | 'info' | 'log' | 'debug';
interface ConsoleCaptureOptions {
    /**
     * Which console methods to capture. `error` → a Monitor event (an `Error`
     * argument becomes a full `captureException` with stack); the rest → a `log`
     * breadcrumb. Default `{ error: true, warn: true }` — info/log/debug are off
     * because Node apps log a lot and every line would become a breadcrumb.
     */
    methods?: Partial<Record<ConsoleMethod, boolean>>;
}
/**
 * Wrap `console` methods so errors/warnings feed Monitor (parity with Python's
 * logging integration). The developer's original console output is ALWAYS passed
 * through — we never swallow a log. Returns an uninstall function.
 */
declare function installConsoleCapture(monitor: CaptureMonitor, options?: ConsoleCaptureOptions): () => void;
interface FetchBreadcrumbOptions {
    /**
     * Skip requests whose URL starts with this prefix — used to exclude the SDK's
     * OWN traffic (event/feature calls), which would otherwise recurse: sending an
     * event issues a fetch → breadcrumb → attached to the next event → …
     */
    ignoreUrlPrefix?: string;
}
/**
 * Wrap the global `fetch` so every outgoing request adds an `http` breadcrumb
 * (method, scrubbed URL, status, duration) — parity with Python's httpx/requests
 * integrations. Returns an uninstall function. No-op on runtimes without `fetch`.
 */
declare function installFetchBreadcrumbs(monitor: CaptureMonitor, options?: FetchBreadcrumbOptions): () => void;

/** What the MonitorClient needs from its parent Onelo client. */
interface MonitorDeps {
    key: string;
    apiUrl: string;
    requestTimeout: number;
    fetchImpl?: FetchLike;
    /** Active feature-flag snapshot (`{ name: status }`) for flag↔error correlation. */
    flagProvider: () => Record<string, string>;
}
interface MonitorInitOptions {
    /** Build id — e.g. $GIT_COMMIT_SHA. Falls back to ONELO_RELEASE / GIT_COMMIT_SHA. */
    release?: string;
    /** production / staging / development. Falls back to ONELO_ENVIRONMENT / ENVIRONMENT / NODE_ENV. */
    environment?: string;
    /** Hostname / pod id. Falls back to HOSTNAME / POD_NAME. */
    serverName?: string;
    /** Install global uncaughtException + unhandledRejection capture. Default true. */
    installGlobalHandlers?: boolean;
    /** Redact email addresses from event text/meta (GDPR-strict). Default false. */
    strictEmailScrub?: boolean;
    /** Extra header/meta key names to redact (substring, dash→underscore). */
    sensitiveHeaders?: string[];
    /** Keep-probability for ERROR events (ok=false), [0,1]. Default 1. */
    sampleRate?: number;
    /** Keep-probability for non-error events (ok=true), [0,1]. Default 1. */
    successSampleRate?: number;
    bufferSize?: number;
    flushInterval?: number;
    requestTimeout?: number;
    /** fetch override (tests). Defaults to the parent client's. */
    fetchImpl?: FetchLike;
    /**
     * Auto-capture `console.error` (→ event; an `Error` arg → full
     * captureException) and `console.warn` (→ breadcrumb). Pass an object to tune
     * which methods. Default off. Parity with Python's logging integration.
     */
    captureConsole?: boolean | ConsoleCaptureOptions;
    /**
     * Add an `http` breadcrumb for every outgoing global `fetch` (method, scrubbed
     * URL, status, duration). The SDK's own traffic is excluded. Default off.
     * Parity with Python's httpx/requests integrations.
     */
    httpBreadcrumbs?: boolean;
}
interface CaptureExceptionOptions {
    featureName?: string;
    meta?: Record<string, unknown>;
}
interface CaptureMessageOptions {
    level?: EventLevel;
    featureName?: string;
    attachStacktrace?: boolean;
    meta?: Record<string, unknown>;
}
interface TrackOptions {
    meta?: Record<string, unknown>;
}
interface AddBreadcrumbOptions {
    category?: BreadcrumbCategory;
    level?: EventLevel;
    data?: Record<string, unknown>;
}
declare class MonitorClient {
    private readonly deps;
    private readonly scopes;
    private transport;
    private sessionId;
    private deployRelease;
    private deployEnvironment;
    private errorSampleRate;
    private successSampleRate;
    private uncaughtHandler;
    private rejectionHandler;
    private consoleUninstall;
    private fetchUninstall;
    private readonly capturedErrors;
    constructor(deps: MonitorDeps);
    init(options?: MonitorInitOptions): void;
    isInitialised(): boolean;
    close(): Promise<void>;
    /** Synchronously drain the buffer (end of a job / before exit). */
    flush(): Promise<void>;
    captureException(err: unknown, options?: CaptureExceptionOptions): void;
    captureMessage(message: string, options?: CaptureMessageOptions): void;
    captureEvent(event: MonitorEvent): void;
    /**
     * Measure a unit of work and emit one `source="track"` event (ok=true on
     * success, an error event with full stack/breadcrumbs/flags on throw), then
     * let the result/exception propagate unchanged. Works with sync or async fns.
     */
    track<T>(featureName: string, fn: () => T, options?: TrackOptions): T;
    addBreadcrumb(crumbOrMessage: Breadcrumb | string, options?: AddBreadcrumbOptions): void;
    setUser(user: Record<string, unknown> | null): void;
    setTag(key: string, value: string): void;
    setContext(key: string, value: Record<string, unknown>): void;
    setExtra(key: string, value: unknown): void;
    /** Run `fn` in a fresh per-request isolation scope (breadcrumbs/user isolated). */
    runWithIsolationScope<T>(fn: () => T): T;
    /** Fork an isolation scope and attach `userId` for its duration. */
    runIdentified<T>(userId: string | null | undefined, fn: () => T): T;
    /** Push a temporary current scope (transaction-style; changes don't leak out). */
    runWithNewScope<T>(fn: () => T): T;
    /**
     * True only when running inside a per-request isolation scope (a monitor
     * request handler / withMonitor forked one). The auth→monitor bridge uses this
     * to avoid writing a user id onto the shared process-root scope, which would
     * leak across concurrent requests.
     */
    hasActiveRequestScope(): boolean;
    /**
     * Serialise the active scope (user.id + scrubbed tags/contexts/transaction,
     * optionally breadcrumbs) into a JSON-safe carrier you attach to a queued job,
     * so the worker can restore it via {@link continueTrace}. Pass `key` (your
     * publishable key) to HMAC-sign it — the worker verifies before trusting.
     * Parity with Python's `monitor.carrier()`.
     *
     * Producer (dispatch side):
     *   await queue.add('job', { ...payload, onelo: onelo.monitor.carrier({ key: onelo.key }) })
     */
    carrier(options?: CarrierOptions): Record<string, unknown>;
    /**
     * Restore a carrier onto a FRESH isolation scope (forked from global, so it
     * never inherits an ambient request's user/tags) for the duration of `fn` (the
     * job body), then unwind. A forged, tampered, or signed-but-key-missing carrier
     * is rejected — the job still runs, just with an empty scope, so a single bad
     * message never crashes the worker. `AsyncLocalStorage` keeps the restored
     * scope across `await`s inside `fn`. Returns whatever `fn` returns. Parity with
     * Python's `monitor.continue_trace()`.
     *
     * Worker (job handler side):
     *   await onelo.monitor.continueTrace(job.data.onelo, async () => {
     *     // ... work; captured errors carry the dispatching request's user/tags
     *   }, { key: onelo.key })
     */
    continueTrace<T>(carrier: Record<string, unknown> | null | undefined, fn: () => T, options?: {
        key?: string;
    }): T;
    private shouldKeep;
    private emit;
    private installGlobalHandlers;
    /** WeakSet dedup for objects; non-objects can't be deduped (rare) → always capture. */
    private markCaptured;
    private uninstallGlobalHandlers;
}

/**
 * The Store module — `onelo.store.listPlans()` (#909).
 *
 * Reads the App's plan catalog from `GET /api/sdk/store/plans` so a backend
 * can show plan prices without copying them from the dashboard. Secret Key
 * only: the endpoint refuses a publishable key.
 */

/** One active plan of the App, prices in minor units (e.g. 1900 = 19.00). */
interface OneloPlan {
    /** The plan key — the same key as `OneloUser.plan` and feature plan rules. */
    plan: string | null;
    name: string;
    shortLabel: string | null;
    mode: 'subscription' | 'one_time';
    currency: string;
    priceAmount: number;
    annualPriceAmount: number | null;
    trialPeriodDays: number | null;
    isActive: boolean;
    sortOrder: number;
}
/** A non-2xx answer or network failure from the Store endpoint. */
declare class OneloStoreError extends Error {
    /** HTTP status, or `null` for a network error. */
    readonly status: number | null;
    constructor(message: string, status: number | null);
}
interface StoreClientOptions {
    apiUrl: string;
    key: string;
    isSecretKey: boolean;
    requestTimeout: number;
    fetchImpl?: FetchLike;
}
declare class StoreClient {
    private readonly opts;
    constructor(opts: StoreClientOptions);
    /** The App's active plans, ordered by sort order. Requires the Secret Key. */
    listPlans(): Promise<OneloPlan[]>;
}

/**
 * The Onelo client — the one class users construct. Holds credentials +
 * transport config (satisfies {@link AuthClient} for the auth path) AND owns the
 * Features module: a background SSE/polling consumer feeding an in-memory cache
 * that `onelo.features.feature()` reads synchronously.
 *
 * Mirrors Python's `onelo._client.Onelo`, with deliberate Node divergences:
 *  - `apiUrl` is REQUIRED (no default) — per the repo SDK Auth Design Rules.
 *  - The features stream starts LAZILY on first use (feature/declare/ready/
 *    identify), not in the constructor — so auth-only or CLI usage opens no
 *    connection and never keeps the event loop alive. (Python eagerly starts a
 *    daemon thread; a Node background task would otherwise hold the process open
 *    and fire network calls an auth-only integrator never asked for.)
 *  - No fork handling — Node cluster workers are separate processes, each
 *    constructing its own client (no inherited event loop to rebuild).
 */

/**
 * The minimal surface `verifyToken` and the adapters depend on. `Onelo`
 * implements it, so passing a full client works everywhere an `AuthClient` is
 * expected.
 */
interface AuthClient {
    readonly apiUrl: string;
    readonly key: string;
    readonly isSecretKey: boolean;
    /** Request timeout in milliseconds. */
    readonly requestTimeout: number;
    /** Optional `fetch` override (tests / custom transport). */
    readonly fetchImpl?: FetchLike;
}
interface OneloConfig {
    /** Generic key — classified as secret/publishable by its `_sk_`/`_pk_` prefix. */
    key?: string;
    /**
     * Publishable key (`onelo_pk_*`) — public client identifier.
     *
     * @deprecated A server SDK should hold the secret key: pass `secretKey`
     * (or `key`). With a publishable key, auth verification refuses to run and
     * per-user Features calls (`features.forUser()`, `identify(userId)`) throw.
     * Still accepted so existing code keeps compiling.
     */
    publishableKey?: string;
    /**
     * Secret key (`onelo_sk_*`) — server credential, required for auth
     * verification and for per-user Features calls (`features.forUser()`,
     * `identify(userId)`).
     */
    secretKey?: string;
    /**
     * Base URL of the Onelo backend, e.g. `https://st.backend.onelo.tools`.
     * REQUIRED — the dashboard snippet pre-fills it. Missing/invalid → throws.
     */
    apiUrl: string;
    /** Feature-sync strategy: `auto` (→ sse), `sse`, or `polling`. Default `auto`. */
    strategy?: 'auto' | 'sse' | 'polling';
    /** Seconds between polls when strategy is `polling`. Default 30. */
    pollInterval?: number;
    /** Your app's version — surfaced on the feature stream + monitor events. */
    appVersion?: string;
    /** Request timeout in milliseconds. Default 5000. */
    requestTimeout?: number;
    /** Optional `fetch` override (tests / custom transport). */
    fetchImpl?: FetchLike;
    /**
     * Explicit feature snapshot environment (`test` | `live`). Decouples the
     * feature snapshot from the key prefix. Falls back to the
     * `ONELO_FEATURE_ENVIRONMENT` env var, then `null` (backend uses key prefix).
     */
    featureEnvironment?: 'test' | 'live';
}
declare class Onelo implements AuthClient {
    readonly key: string;
    readonly isSecretKey: boolean;
    readonly apiUrl: string;
    readonly requestTimeout: number;
    readonly fetchImpl?: FetchLike;
    readonly featureEnvironment: 'test' | 'live' | null;
    /** The Features module — `onelo.features.feature('slug')`, `.forUser(id)`, etc. */
    readonly features: FeaturesClient;
    /** The Monitor module — `onelo.monitor.init()`, `.captureException(err)`, etc. */
    readonly monitor: MonitorClient;
    /** The Store module — `onelo.store.listPlans()` (Secret Key only). */
    readonly store: StoreClient;
    private readonly strategy;
    private readonly pollInterval;
    private readonly appVersion;
    private readonly cache;
    private userId;
    private consumer;
    private consumerRun;
    private started;
    private closed;
    private pingTimer;
    private pingInFlight;
    private pingController;
    private firstEventResolved;
    private firstEventWaiters;
    private identifySwitches;
    private identifyChurnWarned;
    constructor(config: OneloConfig);
    /**
     * Set the PROCESS-GLOBAL user identity for feature targeting, and (re)start
     * the stream so the next `feature()` reflects this user. Meant for
     * single-identity processes (CLI, worker, single-tenant). For a multi-user
     * backend use `features.forUser(userId)` instead — see its docs.
     *
     * Throws for a non-null `userId` when the client holds a publishable key: a
     * per-user call must be signed with the secret key (#520). `identify(null)`
     * (back to anonymous) always works.
     */
    identify(userId: string | null): void;
    /**
     * Warn ONCE if identify() switches identity 5+ times within 60s. Identity is
     * process-global — a multi-user backend calling identify(user.id) per request
     * races (user A evaluated with B's targeting) and forces an SSE reconnect on
     * every switch. The fix is `features.forUser(userId)`. Mirrors Python's guard.
     */
    private trackIdentifyChurn;
    /** Block until the first backend snapshot lands (or timeout). Alias of `features.ready`. */
    ready(timeoutMs?: number): Promise<boolean>;
    /**
     * Stop the background stream and release timers. Idempotent. Call at graceful
     * shutdown; after close(), `feature()` reads the last cached snapshot but the
     * stream no longer updates.
     */
    close(): Promise<void>;
    private ensureStarted;
    private resolveFirstEvent;
    private readyImpl;
    private scheduleBatchPing;
    private onDiscoveryRequested;
    private fireBatchPing;
}

/**
 * Pluggable cache for verified user tokens. 1:1 with Python's
 * `onelo._auth_cache`. Node is single-threaded, so no lock is needed — the
 * get/set bodies contain no `await`, so each is atomic on the event loop.
 *
 * Tokens are never cached in plaintext — callers pass a sha256 hash as the key
 * (see `hashToken` in resolve.ts).
 *
 * The contract is async so a future Redis-backed cache can drop in without any
 * change to the resolver.
 */

/** Pluggable cache contract for verified Onelo users. */
interface AuthCache {
    get(tokenHash: string): Promise<OneloUser | null>;
    set(tokenHash: string, user: OneloUser, ttl: number): Promise<void>;
    invalidate(tokenHash: string): Promise<void>;
}
/**
 * Default in-process LRU-with-TTL cache.
 *
 * - Bounded by `maxSize` — the oldest entry is evicted when full.
 * - Each entry carries its own absolute expiry (`now + ttl` at write time).
 * - TTL checks use `performance.now()` (monotonic — immune to wall-clock jumps).
 * - `Map` preserves insertion order; a hit is re-inserted to become MRU.
 */
declare class InProcessAuthCache implements AuthCache {
    private readonly store;
    private readonly maxSize;
    constructor(maxSize?: number);
    get(tokenHash: string): Promise<OneloUser | null>;
    set(tokenHash: string, user: OneloUser, ttl: number): Promise<void>;
    invalidate(tokenHash: string): Promise<void>;
}

/** `(userIdOrNull, eventName)` — fired on every verification result. */
type OnAuthEvent = (userId: string | null, event: string) => void;
interface ResolverOptions {
    /**
     * Pluggable cache. Defaults to a fresh {@link InProcessAuthCache} per
     * resolver — so different resolvers don't share by default.
     *
     * ⚠️ The cache key is `sha256(token)` only (never the client/tenant). Do NOT
     * share one cache instance across resolvers bound to different Onelo clients
     * (different backend / app / tenant): a token verified against backend A
     * could be served from cache to backend B's resolver without re-verifying.
     * One cache per credential set.
     */
    cache?: AuthCache;
    /** TTL (seconds) for cached verifications. Default 30. */
    cacheTtl?: number;
    /**
     * When `true`, fall back to `?token=...` if the `Authorization` header is
     * missing — for SSE / EventSource clients that can't set headers. Opt-in
     * (default `false`) because a token in a URL can leak via access logs.
     */
    acceptQueryToken?: boolean;
    /** Reject users whose `emailVerified` is falsy with 403. */
    requireEmailVerified?: boolean;
    /** When set, the user's `plan` must be in this list or they get 403. */
    requirePlan?: string[];
    /** Total attempts on backend 5xx (including the initial try). Default 3. */
    retryAttempts?: number;
    /** Hard wall-clock cap (ms) on the whole retry sequence. Default 2000. */
    retryTotalTimeout?: number;
    /** Optional callback fired on each result. Exceptions are swallowed. */
    onAuthEvent?: OnAuthEvent;
    /**
     * Attach the verified user's id to the per-request Monitor scope
     * (`monitor.setUser({ id })`) so errors captured during the request carry the
     * user. Default `true`. Takes effect ONLY when a monitor request handler /
     * withMonitor has forked a per-request isolation scope — outside such a scope
     * it is a safe no-op (never writes the shared process-root scope), so it can
     * never leak a user across concurrent requests. Mirrors Python's per-request
     * `identify_monitor` (Node attaches to the already-forked scope rather than
     * forking its own).
     */
    identifyMonitor?: boolean;
}
/**
 * Internal signal carrying the (status, body) an adapter should return. Each
 * adapter catches this and renders it in its framework's idiom. Mirrors Flask's
 * `_AuthError`.
 */
declare class AuthHttpError extends Error {
    readonly status: number;
    readonly body: Record<string, unknown>;
    constructor(status: number, body: Record<string, unknown>);
}
/** The resolver returned by {@link createResolver}. */
interface Resolver {
    /**
     * Resolve a request to a verified {@link OneloUser} or throw
     * {@link AuthHttpError}. `authorization` is the raw header value;
     * `queryToken` is the `?token=` value (only used when `acceptQueryToken`).
     */
    resolve(authorization: string | null, queryToken: string | null): Promise<OneloUser>;
    /** The cache in use (shared across all requests through this resolver). */
    cache: AuthCache;
}
/**
 * Build a resolver bound to a client + options. Validates the client and retry
 * config once, up front (throws synchronously) — same as Python's adapters
 * rejecting a publishable key at construction time.
 */
declare function createResolver(client: AuthClient, options?: ResolverOptions): Resolver;

export { type AuthClient as A, type Breadcrumb as B, type CaptureExceptionOptions as C, installFetchBreadcrumbs as D, type EventLevel as E, type FetchLike as F, parseRetryAfter as G, verifyToken as H, InProcessAuthCache as I, verifyWithRetry as J, MonitorClient as M, OneloUser as O, type ResolverOptions as R, type StackFrame as S, type TrackOptions as T, UserFeatures as U, type VerifyRetryOptions as V, type AddBreadcrumbOptions as a, type AuthCache as b, AuthHttpError as c, type BreadcrumbCategory as d, Breadcrumbs as e, type CaptureMessageOptions as f, type CaptureMonitor as g, type CapturedException as h, type CarrierOptions as i, type ConsoleCaptureOptions as j, Feature as k, FeaturesClient as l, type FetchBreadcrumbOptions as m, type ForUserOptions as n, type MonitorEvent as o, type MonitorInitOptions as p, type OnAuthEvent as q, Onelo as r, type OneloConfig as s, type OneloPlan as t, OneloStoreError as u, type Resolver as v, StoreClient as w, createResolver as x, extractBearerToken as y, installConsoleCapture as z };
