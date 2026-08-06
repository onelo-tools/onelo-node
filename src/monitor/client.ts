/**
 * `onelo.monitor` — server-side error / event tracking. 1:1 with Python's
 * `onelo.monitor` package, collapsed into one instance-based facade (no module
 * globals): capture exceptions with full stack frames, per-request breadcrumbs,
 * feature-flag correlation, and batched delivery to the Onelo dashboard.
 */
import { randomUUID } from 'node:crypto'

import type { FetchLike } from '../auth/verify'
import { VERSION } from '../version'
import { ScopeManager } from './scope'
import { applyCarrier, buildCarrier, type CarrierOptions, unwrapCarrier } from './propagation'
import { configureSensitiveKeys, scrubMeta, scrubText, setStrictEmailScrub } from './scrub'
import {
  captureCurrentStack,
  captureExceptionInfo,
  capturedExceptionToWire,
  stackFrameToWire,
} from './stacktrace'
import { MonitorTransport } from './transport'
import {
  type ConsoleCaptureOptions,
  installConsoleCapture,
  installFetchBreadcrumbs,
} from './integrations'
import {
  type Breadcrumb,
  type BreadcrumbCategory,
  type EventLevel,
  type MonitorEvent,
  makeEvent,
} from './types'

const SDK_NAME = 'onelo-node'

// eslint-disable-next-line no-console
const warn = (...args: unknown[]) => console.warn('[onelo.monitor]', ...args)

/** What the MonitorClient needs from its parent Onelo client. */
export interface MonitorDeps {
  key: string
  apiUrl: string
  requestTimeout: number
  fetchImpl?: FetchLike
  /** Active feature-flag snapshot (`{ name: status }`) for flag↔error correlation. */
  flagProvider: () => Record<string, string>
}

export interface MonitorInitOptions {
  /** Build id — e.g. $GIT_COMMIT_SHA. Falls back to ONELO_RELEASE / GIT_COMMIT_SHA. */
  release?: string
  /** production / staging / development. Falls back to ONELO_ENVIRONMENT / ENVIRONMENT / NODE_ENV. */
  environment?: string
  /** Hostname / pod id. Falls back to HOSTNAME / POD_NAME. */
  serverName?: string
  /** Install global uncaughtException + unhandledRejection capture. Default true. */
  installGlobalHandlers?: boolean
  /** Redact email addresses from event text/meta (GDPR-strict). Default false. */
  strictEmailScrub?: boolean
  /** Extra header/meta key names to redact (substring, dash→underscore). */
  sensitiveHeaders?: string[]
  /** Keep-probability for ERROR events (ok=false), [0,1]. Default 1. */
  sampleRate?: number
  /** Keep-probability for non-error events (ok=true), [0,1]. Default 1. */
  successSampleRate?: number
  bufferSize?: number
  flushInterval?: number // ms
  requestTimeout?: number // ms
  /** fetch override (tests). Defaults to the parent client's. */
  fetchImpl?: FetchLike
  /**
   * Auto-capture `console.error` (→ event; an `Error` arg → full
   * captureException) and `console.warn` (→ breadcrumb). Pass an object to tune
   * which methods. Default off. Parity with Python's logging integration.
   */
  captureConsole?: boolean | ConsoleCaptureOptions
  /**
   * Add an `http` breadcrumb for every outgoing global `fetch` (method, scrubbed
   * URL, status, duration). The SDK's own traffic is excluded. Default off.
   * Parity with Python's httpx/requests integrations.
   */
  httpBreadcrumbs?: boolean
}

export interface CaptureExceptionOptions {
  featureName?: string
  meta?: Record<string, unknown>
}

export interface CaptureMessageOptions {
  level?: EventLevel
  featureName?: string
  attachStacktrace?: boolean
  meta?: Record<string, unknown>
}

export interface TrackOptions {
  meta?: Record<string, unknown>
}

export interface AddBreadcrumbOptions {
  category?: BreadcrumbCategory
  level?: EventLevel
  data?: Record<string, unknown>
}

export class MonitorClient {
  private readonly scopes = new ScopeManager()
  private transport: MonitorTransport | null = null
  private sessionId: string | null = null
  private deployRelease: string | null = null
  private deployEnvironment: string | null = null
  private errorSampleRate = 1.0
  private successSampleRate = 1.0

  private uncaughtHandler: ((err: unknown) => void) | null = null
  private rejectionHandler: ((reason: unknown) => void) | null = null
  private consoleUninstall: (() => void) | null = null
  private fetchUninstall: (() => void) | null = null
  // Dedup so an error re-raised to preserve crash semantics isn't captured twice.
  private readonly capturedErrors = new WeakSet<object>()

  constructor(private readonly deps: MonitorDeps) {}

  // ── lifecycle ───────────────────────────────────────────────────────────

  init(options: MonitorInitOptions = {}): void {
    for (const [name, rate] of [
      ['sampleRate', options.sampleRate ?? 1.0],
      ['successSampleRate', options.successSampleRate ?? 1.0],
    ] as const) {
      if (!(rate >= 0 && rate <= 1)) throw new Error(`${name} must be between 0 and 1, got ${rate}`)
    }

    if (this.transport) {
      warn('monitor.init called twice; closing previous transport')
      void this.close()
    }

    const release =
      options.release ?? process.env.ONELO_RELEASE ?? process.env.GIT_COMMIT_SHA ?? null
    const environment =
      options.environment ??
      process.env.ONELO_ENVIRONMENT ??
      process.env.ENVIRONMENT ??
      process.env.NODE_ENV ??
      null
    const serverName = options.serverName ?? process.env.HOSTNAME ?? process.env.POD_NAME ?? null

    const g = this.scopes.getGlobalScope()
    if (release) g.setTag('release', release)
    if (environment) g.setTag('environment', environment)
    if (serverName) g.setTag('server_name', serverName)
    this.deployRelease = release
    this.deployEnvironment = environment

    this.errorSampleRate = options.sampleRate ?? 1.0
    this.successSampleRate = options.successSampleRate ?? 1.0

    setStrictEmailScrub(options.strictEmailScrub ?? false)
    configureSensitiveKeys(options.sensitiveHeaders ?? null)

    this.transport = new MonitorTransport({
      apiUrl: this.deps.apiUrl,
      publishableKey: this.deps.key,
      bufferSize: options.bufferSize,
      flushIntervalMs: options.flushInterval,
      requestTimeout: options.requestTimeout ?? this.deps.requestTimeout,
      fetchImpl: options.fetchImpl ?? this.deps.fetchImpl,
    })
    this.transport.start()

    // One session id per process, stamped on every event without one — the
    // server-side analogue of a mobile install id (groups a worker/pod).
    this.sessionId = randomUUID().replace(/-/g, '')

    if (options.installGlobalHandlers !== false) this.installGlobalHandlers()

    if (options.captureConsole) {
      this.consoleUninstall = installConsoleCapture(
        this,
        typeof options.captureConsole === 'object' ? options.captureConsole : {},
      )
    }
    if (options.httpBreadcrumbs) {
      this.fetchUninstall = installFetchBreadcrumbs(this, { ignoreUrlPrefix: this.deps.apiUrl })
    }

    // Auto-emit one unconditional event per init(). A service that gates every
    // instrumented operation behind auth middleware / a feature flag would
    // otherwise emit NOTHING on a cold start — the dashboard would look
    // "not integrated" even though every line of the snippet was followed
    // correctly. This event needs no gate to exist: it fires the moment the
    // SDK finishes initialising, so Feature Health always has at least one row.
    // Parity with onelo-js's constructor-time `session_opened` push.
    this.emit(makeEvent({ featureName: 'session_opened', ok: true, source: 'event' }))
  }

  isInitialised(): boolean {
    return this.transport !== null
  }

  async close(): Promise<void> {
    this.uninstallGlobalHandlers()
    setStrictEmailScrub(false)
    const t = this.transport
    this.transport = null
    this.sessionId = null
    this.deployRelease = null
    this.deployEnvironment = null
    this.errorSampleRate = 1.0
    this.successSampleRate = 1.0
    if (t) await t.stop()
  }

  /** Synchronously drain the buffer (end of a job / before exit). */
  async flush(): Promise<void> {
    if (this.transport) await this.transport.flush()
  }

  // ── capture API ───────────────────────────────────────────────────────────

  captureException(err: unknown, options: CaptureExceptionOptions = {}): void {
    const captured = captureExceptionInfo(err)
    if (!captured) return
    const meta: Record<string, unknown> = { ...(options.meta ?? {}) }
    meta.exception = capturedExceptionToWire(captured)
    if (!('error_type' in meta)) meta.error_type = captured.type
    this.emit(
      makeEvent({
        featureName: options.featureName ?? 'manual',
        ok: false,
        error: captured.message,
        source: 'event',
        meta,
      }),
    )
  }

  captureMessage(message: string, options: CaptureMessageOptions = {}): void {
    const level = options.level ?? 'info'
    const meta: Record<string, unknown> = { ...(options.meta ?? {}) }
    meta.level = level
    if (options.attachStacktrace) meta.stack = captureCurrentStack(1).map(stackFrameToWire)
    const isError = level === 'error' || level === 'fatal'
    this.emit(
      makeEvent({
        featureName: options.featureName ?? 'manual',
        ok: !isError,
        error: isError ? message : null,
        source: 'event',
        meta,
      }),
    )
  }

  captureEvent(event: MonitorEvent): void {
    this.emit(event)
  }

  /**
   * Measure a unit of work and emit one `source="track"` event (ok=true on
   * success, an error event with full stack/breadcrumbs/flags on throw), then
   * let the result/exception propagate unchanged. Works with sync or async fns.
   */
  track<T>(featureName: string, fn: () => T, options: TrackOptions = {}): T {
    const start = performance.now()
    // A private sentinel marks "succeeded" — NOT `undefined`, because
    // `throw undefined` / `Promise.reject(undefined)` is legal and would
    // otherwise be misclassified as success.
    const SUCCESS: unique symbol = Symbol('success')
    const finish = (err: unknown): void => {
      const durationMs = Math.round(performance.now() - start)
      if (err === SUCCESS) {
        this.emit(
          makeEvent({
            featureName,
            ok: true,
            source: 'track',
            durationMs,
            meta: { ...(options.meta ?? {}) },
          }),
        )
        return
      }
      const meta: Record<string, unknown> = { ...(options.meta ?? {}) }
      const captured = captureExceptionInfo(err)
      let error: string
      if (captured) {
        meta.exception = capturedExceptionToWire(captured)
        if (!('error_type' in meta)) meta.error_type = captured.type
        error = captured.message
      } else {
        if (!('error_type' in meta)) meta.error_type = err instanceof Error ? err.name : typeof err
        error = String(err)
      }
      this.emit(makeEvent({ featureName, ok: false, error, source: 'track', durationMs, meta }))
    }

    let result: T
    try {
      result = fn()
    } catch (e) {
      finish(e)
      throw e
    }
    if (result != null && typeof (result as { then?: unknown }).then === 'function') {
      return (result as unknown as Promise<unknown>).then(
        (v) => {
          finish(SUCCESS)
          return v
        },
        (e) => {
          finish(e)
          throw e
        },
      ) as unknown as T
    }
    finish(SUCCESS)
    return result
  }

  addBreadcrumb(crumbOrMessage: Breadcrumb | string, options: AddBreadcrumbOptions = {}): void {
    if (typeof crumbOrMessage === 'object' && 'category' in crumbOrMessage) {
      this.scopes.getIsolationScope().addBreadcrumb(crumbOrMessage)
      return
    }
    const crumb: Breadcrumb = {
      category: options.category ?? 'info',
      message: String(crumbOrMessage),
      timestamp: Date.now() / 1000,
      level: options.level ?? 'info',
      data: options.data,
    }
    this.scopes.getIsolationScope().addBreadcrumb(crumb)
  }

  setUser(user: Record<string, unknown> | null): void {
    this.scopes.getIsolationScope().setUser(user)
  }
  setTag(key: string, value: string): void {
    this.scopes.getIsolationScope().setTag(key, value)
  }
  setContext(key: string, value: Record<string, unknown>): void {
    this.scopes.getIsolationScope().setContext(key, value)
  }
  setExtra(key: string, value: unknown): void {
    this.scopes.getIsolationScope().setExtra(key, value)
  }

  // ── scope forking (used by framework adapters, WS handlers, jobs) ─────────

  /** Run `fn` in a fresh per-request isolation scope (breadcrumbs/user isolated). */
  runWithIsolationScope<T>(fn: () => T): T {
    return this.scopes.runWithIsolationScope(fn)
  }

  /** Fork an isolation scope and attach `userId` for its duration. */
  runIdentified<T>(userId: string | null | undefined, fn: () => T): T {
    return this.scopes.runIdentified(userId, fn)
  }

  /** Push a temporary current scope (transaction-style; changes don't leak out). */
  runWithNewScope<T>(fn: () => T): T {
    return this.scopes.runWithNewScope(fn)
  }

  /**
   * True only when running inside a per-request isolation scope (a monitor
   * request handler / withMonitor forked one). The auth→monitor bridge uses this
   * to avoid writing a user id onto the shared process-root scope, which would
   * leak across concurrent requests.
   */
  hasActiveRequestScope(): boolean {
    return this.scopes.hasActiveIsolationScope()
  }

  // ── cross-process scope propagation (queue jobs) ─────────────────────────

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
  carrier(options: CarrierOptions = {}): Record<string, unknown> {
    return buildCarrier(this.scopes.getIsolationScope(), options.includeBreadcrumbs ?? false, options.key)
  }

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
  continueTrace<T>(
    carrier: Record<string, unknown> | null | undefined,
    fn: () => T,
    options: { key?: string } = {},
  ): T {
    const payload = unwrapCarrier(carrier, options.key)
    return this.scopes.runWithGlobalIsolationScope(() => {
      if (payload) applyCarrier(this.scopes.getIsolationScope(), payload)
      return fn()
    })
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private shouldKeep(event: MonitorEvent): boolean {
    const rate = event.ok ? this.successSampleRate : this.errorSampleRate
    if (rate >= 1) return true
    if (rate <= 0) return false
    return Math.random() < rate
  }

  private emit(event: MonitorEvent): void {
    const transport = this.transport
    if (!transport) return // not initialised (or closed) — drop silently
    if (!this.shouldKeep(event)) return // client-side sampling before any work

    this.scopes.applyScopesToEvent(event)

    if (event.sessionId == null && this.sessionId) event.sessionId = this.sessionId

    // Stamp deploy context on the EXACT meta paths the backend aggregates on
    // (meta.environment top-level, meta.app.version nested) — scope tags alone
    // don't populate the dashboard's Release/Environment filters.
    if (this.deployEnvironment && !('environment' in event.meta)) {
      event.meta.environment = this.deployEnvironment
    }
    if (this.deployRelease) {
      const app = (event.meta.app ??= {}) as Record<string, unknown>
      if (app && typeof app === 'object' && app.version === undefined) app.version = this.deployRelease
    }

    // Feature-flag correlation — the killer feature. Cheap in-memory snapshot.
    try {
      const flags = this.deps.flagProvider()
      if (flags && Object.keys(flags).length > 0 && !('flags' in event.meta)) {
        event.meta.flags = { ...flags }
      }
    } catch {
      /* flag provider must never break capture */
    }

    if (!('sdk' in event.meta)) event.meta.sdk = { name: SDK_NAME, version: VERSION }

    // Scrub at the boundary — anything integrations added goes through here.
    try {
      event.error = (scrubText(event.error) ?? null) as string | null
      const scrubbed = scrubMeta(event.meta)
      event.meta = scrubbed ?? {}
    } catch (err) {
      warn('scrubber failed; dropping event', err)
      return
    }

    try {
      transport.send(event)
    } catch (err) {
      warn('transport failed', err)
    }
  }

  private installGlobalHandlers(): void {
    // `uncaughtExceptionMonitor` OBSERVES uncaught exceptions WITHOUT suppressing
    // Node's default fatal handling — so we capture the crash but never change
    // the app's exit behavior. Flush is best-effort (the process may exit first;
    // for guaranteed delivery on shutdown, call onelo.close() from a SIGTERM
    // handler). featureName 'uncaught' matches the Python SDK's bucket.
    this.uncaughtHandler = (err: unknown) => {
      if (this.markCaptured(err)) this.captureException(err, { featureName: 'uncaught' })
      void this.flush()
    }
    process.on('uncaughtExceptionMonitor', this.uncaughtHandler)

    // There is no `unhandledRejectionMonitor`, and merely adding an
    // `unhandledRejection` listener SUPPRESSES Node 15+'s default fatal exit.
    // To avoid silently changing crash semantics, we re-raise the reason as an
    // uncaught exception WHEN WE ARE THE ONLY LISTENER (the app didn't opt to
    // handle rejections itself) — uncaughtExceptionMonitor then observes it
    // (deduped) and Node performs its normal fatal exit. If the app added its
    // own rejection listener, we defer to it and don't force a crash.
    this.rejectionHandler = (reason: unknown) => {
      if (this.markCaptured(reason)) {
        this.captureException(reason, { featureName: 'unhandled_rejection' })
      }
      void this.flush()
      if (process.listenerCount('unhandledRejection') === 1) {
        process.nextTick(() => {
          throw reason
        })
      }
    }
    process.on('unhandledRejection', this.rejectionHandler)
  }

  /** WeakSet dedup for objects; non-objects can't be deduped (rare) → always capture. */
  private markCaptured(err: unknown): boolean {
    if (err !== null && typeof err === 'object') {
      if (this.capturedErrors.has(err)) return false
      this.capturedErrors.add(err)
    }
    return true
  }

  private uninstallGlobalHandlers(): void {
    if (this.uncaughtHandler) {
      process.removeListener('uncaughtExceptionMonitor', this.uncaughtHandler)
      this.uncaughtHandler = null
    }
    if (this.rejectionHandler) {
      process.removeListener('unhandledRejection', this.rejectionHandler)
      this.rejectionHandler = null
    }
    if (this.consoleUninstall) {
      this.consoleUninstall()
      this.consoleUninstall = null
    }
    if (this.fetchUninstall) {
      this.fetchUninstall()
      this.fetchUninstall = null
    }
  }
}
