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
import type { FetchLike } from './auth/verify'
import { FeatureCache } from './features/cache'
import { FeaturesClient } from './features/client'
import { resolveStrategy, type Strategy } from './features/detection'
import { getInstanceId } from './features/instance'
import { PollingConsumer } from './features/polling-consumer'
import { assertSecretKeyForUser } from './features/secret-key'
import { SseConsumer } from './features/sse-consumer'
import { USER_AGENT, resolveFetch, type FeatureConsumer } from './features/consumer'
import { MonitorClient } from './monitor/client'

const ANY_KEY_RE = /^onelo_(pk|sk)_[a-zA-Z0-9_]+$/

// Debounce window for the auto-discovery batch-ping. Matches Python/Swift's ~1s
// so the cross-platform "first feature() reaches the dashboard within ~1s" holds.
const BATCH_PING_DEBOUNCE_MS = 1000

// Recognised OneloConfig keys — anything else triggers a forward-compat warning
// (parity with Python's warn-and-ignore of unknown constructor kwargs).
const KNOWN_CONFIG_KEYS = new Set<string>([
  'key',
  'publishableKey',
  'secretKey',
  'apiUrl',
  'strategy',
  'pollInterval',
  'appVersion',
  'requestTimeout',
  'fetchImpl',
  'featureEnvironment',
])

// eslint-disable-next-line no-console
const warn = (...args: unknown[]) => console.warn('[onelo]', ...args)

/**
 * The minimal surface `verifyToken` and the adapters depend on. `Onelo`
 * implements it, so passing a full client works everywhere an `AuthClient` is
 * expected.
 */
export interface AuthClient {
  readonly apiUrl: string
  readonly key: string
  readonly isSecretKey: boolean
  /** Request timeout in milliseconds. */
  readonly requestTimeout: number
  /** Optional `fetch` override (tests / custom transport). */
  readonly fetchImpl?: FetchLike
}

export interface OneloConfig {
  /** Generic key — classified as secret/publishable by its `_sk_`/`_pk_` prefix. */
  key?: string
  /**
   * Publishable key (`onelo_pk_*`) — public client identifier.
   *
   * @deprecated A server SDK should hold the secret key: pass `secretKey`
   * (or `key`). With a publishable key, auth verification refuses to run and
   * per-user Features calls (`features.forUser()`, `identify(userId)`) throw.
   * Still accepted so existing code keeps compiling.
   */
  publishableKey?: string
  /**
   * Secret key (`onelo_sk_*`) — server credential, required for auth
   * verification and for per-user Features calls (`features.forUser()`,
   * `identify(userId)`).
   */
  secretKey?: string
  /**
   * Base URL of the Onelo backend, e.g. `https://st.backend.onelo.tools`.
   * REQUIRED — the dashboard snippet pre-fills it. Missing/invalid → throws.
   */
  apiUrl: string
  /** Feature-sync strategy: `auto` (→ sse), `sse`, or `polling`. Default `auto`. */
  strategy?: 'auto' | 'sse' | 'polling'
  /** Seconds between polls when strategy is `polling`. Default 30. */
  pollInterval?: number
  /** Your app's version — surfaced on the feature stream + monitor events. */
  appVersion?: string
  /** Request timeout in milliseconds. Default 5000. */
  requestTimeout?: number
  /** Optional `fetch` override (tests / custom transport). */
  fetchImpl?: FetchLike
  /**
   * Explicit feature snapshot environment (`test` | `live`). Decouples the
   * feature snapshot from the key prefix. Falls back to the
   * `ONELO_FEATURE_ENVIRONMENT` env var, then `null` (backend uses key prefix).
   */
  featureEnvironment?: 'test' | 'live'
}

export class Onelo implements AuthClient {
  readonly key: string
  readonly isSecretKey: boolean
  readonly apiUrl: string
  readonly requestTimeout: number
  readonly fetchImpl?: FetchLike
  readonly featureEnvironment: 'test' | 'live' | null

  /** The Features module — `onelo.features.feature('slug')`, `.forUser(id)`, etc. */
  readonly features: FeaturesClient

  /** The Monitor module — `onelo.monitor.init()`, `.captureException(err)`, etc. */
  readonly monitor: MonitorClient

  private readonly strategy: Strategy
  private readonly pollInterval: number
  private readonly appVersion: string | null
  private readonly cache: FeatureCache

  private userId: string | null = null
  private consumer: FeatureConsumer | null = null
  private consumerRun: Promise<void> | null = null
  private started = false
  private closed = false

  private pingTimer: ReturnType<typeof setTimeout> | null = null
  private pingInFlight: Promise<void> | null = null
  private pingController: AbortController | null = null

  private firstEventResolved = false
  private firstEventWaiters: Array<(ok: boolean) => void> = []

  // identify() churn guard — timestamps of identity SWITCHES in the last window.
  private identifySwitches: number[] = []
  private identifyChurnWarned = false

  constructor(config: OneloConfig) {
    // Forward-compat: warn (don't throw) on unrecognised config keys — mirrors
    // Python's `Onelo(**deprecated)` tolerance so a newer dashboard snippet
    // passing an option this SDK build predates never crashes the app.
    for (const k of Object.keys(config)) {
      if (!KNOWN_CONFIG_KEYS.has(k)) warn(`unknown config option ${JSON.stringify(k)} ignored`)
    }

    // ── Primary key resolution — exactly one of key/publishableKey/secretKey ──
    const provided = [config.key, config.publishableKey, config.secretKey].filter(
      (k): k is string => typeof k === 'string' && k.length > 0,
    )
    if (provided.length === 0) {
      throw new Error('Onelo requires a key — pass key, publishableKey, or secretKey.')
    }
    if (provided.length > 1) {
      throw new Error('Provide exactly one of key, publishableKey, secretKey — not multiple.')
    }
    const chosen = provided[0]!
    if (!ANY_KEY_RE.test(chosen)) {
      throw new Error(
        `Key must match onelo_pk_* or onelo_sk_* (${ANY_KEY_RE.source}), got ${JSON.stringify(chosen)}.`,
      )
    }
    if (config.secretKey !== undefined) this.isSecretKey = true
    else if (config.publishableKey !== undefined) this.isSecretKey = false
    else this.isSecretKey = chosen.includes('_sk_')

    // ── apiUrl — REQUIRED, must be http(s) ────────────────────────────────
    if (!config.apiUrl) {
      throw new Error(
        'Onelo requires apiUrl — the dashboard snippet pre-fills it from your environment. ' +
          'Missing apiUrl is a configuration error, not a default.',
      )
    }
    let parsed: URL
    try {
      parsed = new URL(config.apiUrl)
    } catch {
      throw new Error(`apiUrl must be an http(s) URL, got ${JSON.stringify(config.apiUrl)}.`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`apiUrl must be an http(s) URL, got ${JSON.stringify(config.apiUrl)}.`)
    }
    // Note: `new URL()` already throws on an empty authority (e.g. "https://"),
    // so a host-degenerate http(s) URL can't reach here.

    // ── Feature environment ───────────────────────────────────────────────
    let featEnv: string | undefined =
      config.featureEnvironment ?? process.env.ONELO_FEATURE_ENVIRONMENT
    if (typeof featEnv === 'string') featEnv = featEnv.trim() || undefined
    if (featEnv !== undefined && featEnv !== 'test' && featEnv !== 'live') {
      throw new Error(
        "featureEnvironment must be 'test', 'live', or undefined " +
          `(ONELO_FEATURE_ENVIRONMENT), got ${JSON.stringify(featEnv)}.`,
      )
    }

    this.key = chosen
    this.apiUrl = config.apiUrl.replace(/\/+$/, '')
    this.requestTimeout = config.requestTimeout ?? 5000
    this.fetchImpl = config.fetchImpl
    this.featureEnvironment = (featEnv as 'test' | 'live' | undefined) ?? null

    // strategy validation throws early on a bad value (before any network work).
    this.strategy = resolveStrategy(config.strategy ?? 'auto')
    this.pollInterval = config.pollInterval ?? 30
    this.appVersion = config.appVersion ?? null

    this.cache = new FeatureCache()
    this.features = new FeaturesClient({
      cache: this.cache,
      scheduleBatchPing: () => this.scheduleBatchPing(),
      ready: (timeoutMs) => this.readyImpl(timeoutMs),
      ensureStarted: () => this.ensureStarted(),
      apiUrl: this.apiUrl,
      key: this.key,
      requestTimeout: this.requestTimeout,
      fetchImpl: this.fetchImpl,
      featureEnvironment: this.featureEnvironment,
    })
    this.monitor = new MonitorClient({
      key: this.key,
      apiUrl: this.apiUrl,
      requestTimeout: this.requestTimeout,
      fetchImpl: this.fetchImpl,
      // Feature-flag correlation: every captured event ships the live flag
      // snapshot (empty until the features stream is used).
      flagProvider: () => this.cache.snapshot(),
    })
  }

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
  identify(userId: string | null): void {
    if (userId !== null) assertSecretKeyForUser(this.key, 'onelo.identify(userId)')
    const previous = this.userId
    this.userId = userId
    if (userId !== previous) this.trackIdentifyChurn()
    if (this.started) {
      this.consumer?.forceReconnect()
    } else {
      this.ensureStarted()
    }
  }

  /**
   * Warn ONCE if identify() switches identity 5+ times within 60s. Identity is
   * process-global — a multi-user backend calling identify(user.id) per request
   * races (user A evaluated with B's targeting) and forces an SSE reconnect on
   * every switch. The fix is `features.forUser(userId)`. Mirrors Python's guard.
   */
  private trackIdentifyChurn(): void {
    if (this.identifyChurnWarned) return
    const now = performance.now()
    this.identifySwitches.push(now)
    this.identifySwitches = this.identifySwitches.filter((t) => now - t <= 60_000)
    if (this.identifySwitches.length >= 5) {
      this.identifyChurnWarned = true
      warn(
        'identify() switched identity 5+ times within 60s. Identity is process-global — ' +
          'on a multi-user backend resolve per request instead: ' +
          'await onelo.features.forUser(userId). Calling identify() per request races and ' +
          'reconnects the stream on every switch.',
      )
    }
  }

  /** Block until the first backend snapshot lands (or timeout). Alias of `features.ready`. */
  ready(timeoutMs = 1500): Promise<boolean> {
    return this.features.ready(timeoutMs)
  }

  /**
   * Stop the background stream and release timers. Idempotent. Call at graceful
   * shutdown; after close(), `feature()` reads the last cached snapshot but the
   * stream no longer updates.
   */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.pingTimer) {
      clearTimeout(this.pingTimer)
      this.pingTimer = null
    }
    // Abort an in-flight discovery ping so it doesn't keep the loop alive.
    this.pingController?.abort()
    // Drain + stop the monitor transport (no-op if never initialised).
    await this.monitor.close()
    this.consumer?.stop()
    // Resolve any pending ready() waiters so they don't hang past shutdown.
    this.resolveFirstEvent(this.firstEventResolved)
    if (this.consumerRun) {
      try {
        await this.consumerRun
      } catch {
        /* consumer errors are already logged */
      }
    }
    if (this.pingInFlight) {
      try {
        await this.pingInFlight
      } catch {
        /* ping errors are swallowed internally */
      }
    }
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private ensureStarted(): void {
    if (this.started || this.closed) return
    this.started = true
    this.consumer =
      this.strategy === 'sse'
        ? new SseConsumer({
            apiUrl: this.apiUrl,
            key: this.key,
            cache: this.cache,
            getUserId: () => this.userId,
            requestTimeout: this.requestTimeout,
            fetchImpl: this.fetchImpl,
            featureEnvironment: this.featureEnvironment,
            onFirstEvent: () => this.resolveFirstEvent(true),
            onDiscoveryRequested: () => this.onDiscoveryRequested(),
            appVersion: this.appVersion,
          })
        : new PollingConsumer({
            apiUrl: this.apiUrl,
            key: this.key,
            cache: this.cache,
            getUserId: () => this.userId,
            requestTimeout: this.requestTimeout,
            fetchImpl: this.fetchImpl,
            featureEnvironment: this.featureEnvironment,
            onFirstEvent: () => this.resolveFirstEvent(true),
            onDiscoveryRequested: () => this.onDiscoveryRequested(),
            appVersion: this.appVersion,
            pollIntervalSeconds: this.pollInterval,
          })
    // Fire-and-forget; the consumer never rejects (it logs internally), but
    // guard anyway so an unexpected throw can't become an unhandled rejection.
    this.consumerRun = this.consumer.run().catch((err) => {
      warn('features consumer crashed:', err)
    })
  }

  private resolveFirstEvent(ok: boolean): void {
    if (!this.firstEventResolved) this.firstEventResolved = ok
    const waiters = this.firstEventWaiters
    this.firstEventWaiters = []
    for (const w of waiters) w(ok)
  }

  private readyImpl(timeoutMs: number): Promise<boolean> {
    if (this.firstEventResolved) return Promise.resolve(true)
    // After close() no event will ever fire — don't make the caller wait out the
    // full timeout for a guaranteed false.
    if (this.closed) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.firstEventWaiters = this.firstEventWaiters.filter((w) => w !== onEvent)
        resolve(false)
      }, timeoutMs)
      const onEvent = (ok: boolean) => {
        clearTimeout(timer)
        resolve(ok)
      }
      this.firstEventWaiters.push(onEvent)
    })
  }

  private scheduleBatchPing(): void {
    if (this.closed) return
    if (this.pingTimer) clearTimeout(this.pingTimer)
    this.pingTimer = setTimeout(() => {
      this.pingTimer = null
      const names = this.features.snapshotDiscovered()
      if (names.length > 0) this.pingInFlight = this.fireBatchPing(names)
    }, BATCH_PING_DEBOUNCE_MS)
    // Don't hold the process open for a pending discovery ping.
    this.pingTimer.unref?.()
  }

  private onDiscoveryRequested(): void {
    if (this.closed) return
    // Dashboard "Discover Features" — flush the full known slug set immediately,
    // bypassing the debounce (parity with Python `_on_discovery_requested`).
    const names = this.features.snapshotDiscovered()
    if (names.length > 0) this.pingInFlight = this.fireBatchPing(names)
  }

  private async fireBatchPing(names: string[]): Promise<void> {
    const doFetch = resolveFetch(this.fetchImpl)
    if (!doFetch) return
    const body: Record<string, unknown> = { publishableKey: this.key, features: names }
    if (this.featureEnvironment !== null) body.environment = this.featureEnvironment
    // One controller carries the timeout AND close() — so shutdown aborts an
    // in-flight ping immediately instead of letting AbortSignal.timeout's
    // (non-unref'd) timer keep the event loop alive up to requestTimeout.
    const controller = new AbortController()
    this.pingController = controller
    const timeout = setTimeout(() => controller.abort(), this.requestTimeout)
    timeout.unref?.()
    try {
      const res = await doFetch(`${this.apiUrl}/api/sdk/features/batch-ping`, {
        method: 'POST',
        headers: {
          'User-Agent': USER_AGENT,
          'content-type': 'application/json',
          // Test keys REQUIRE X-Onelo-Instance-Id (dual-anchor TOFU binding);
          // live keys ignore it — always send (cheap belt-and-braces).
          'X-Onelo-Instance-Id': getInstanceId(),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (res.status >= 400) {
        // A 4xx is usually a bound test key rejecting a different device/app —
        // surface it so discovery-does-nothing is diagnosable.
        const text = await res.text().catch(() => '')
        warn(`batch-ping rejected (HTTP ${res.status}): ${text.slice(0, 300)}`)
      }
    } catch {
      // Network failure / aborted — transient; the next discovery reschedules.
    } finally {
      clearTimeout(timeout)
      if (this.pingController === controller) this.pingController = null
    }
  }
}
