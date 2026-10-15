/**
 * SSE consumer — the default real-time strategy. 1:1 with Python's `onelo._sse`.
 *
 * Opens a long-lived GET on /api/sdk/features/stream, parses SSE frames, and
 * updates the cache on `connected` / `features_updated`. Reconnects with
 * full-jitter exponential backoff. Forward-compatible: unknown event types are
 * ignored.
 *
 * Node specifics vs Python's httpx_sse:
 *  - streaming via `fetch` + `response.body.getReader()` + our SseParser;
 *  - stop / force-reconnect / healthcheck interrupt the in-flight read by
 *    RACING `reader.read()` against an interrupt promise AND aborting the fetch
 *    (belt-and-braces — real fetch errors the body on abort; the race also
 *    covers transports that don't propagate abort to the reader);
 *  - a 401/403 is TERMINAL (dead/revoked key never becomes valid): log once, stop;
 *  - zombie detection: a healthcheck timer force-reconnects if no bytes arrive
 *    within STALE_THRESHOLD (NAT/proxy idle kills drop TCP silently).
 */
import { SseParser } from './sse-parser'
import { getInstanceId } from './instance'
import { VERSION } from '../version'
import {
  type ConsumerOptions,
  type FeatureConsumer,
  SDK_PLATFORM,
  USER_AGENT,
  resolveFetch,
} from './consumer'

const DEFAULT_BACKOFF_SECONDS = [1, 2, 4, 8, 16, 30]
// Server emits a `:` heartbeat every ~30s; 90s == 3 missed heartbeats.
const STALE_THRESHOLD_MS = 90_000
const HEALTHCHECK_INTERVAL_MS = 30_000

/** The stream returned 401/403 — terminal, never retried. */
class TerminalAuthError extends Error {
  constructor(readonly status: number) {
    super(`features stream auth failed: HTTP ${status}`)
  }
}

// eslint-disable-next-line no-console
const warn = (...args: unknown[]) => console.warn('[onelo.features]', ...args)

const INTERRUPT = Symbol('interrupt')

export class SseConsumer implements FeatureConsumer {
  private stopped = false
  private reconnectRequested = false
  private controller: AbortController | null = null
  private lastEventAt = performance.now()
  private healthcheckTimer: ReturnType<typeof setTimeout> | null = null
  private wakeResolvers: Array<() => void> = []
  private interruptRead: (() => void) | null = null

  constructor(private readonly opts: ConsumerOptions) {}

  stop(): void {
    this.stopped = true
    this.interrupt()
  }

  forceReconnect(): void {
    this.reconnectRequested = true
    this.interrupt()
  }

  /** Interrupt the in-flight read AND any backoff sleep. */
  private interrupt(): void {
    this.interruptRead?.()
    this.controller?.abort()
    this.wake()
  }

  private wake(): void {
    const resolvers = this.wakeResolvers
    this.wakeResolvers = []
    for (const r of resolvers) r()
  }

  private waitInterruptible(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const onWake = () => {
        clearTimeout(t)
        resolve()
      }
      const t = setTimeout(() => {
        this.wakeResolvers = this.wakeResolvers.filter((r) => r !== onWake)
        resolve()
      }, ms)
      this.wakeResolvers.push(onWake)
    })
  }

  async run(): Promise<void> {
    this.lastEventAt = performance.now()
    this.startHealthcheck()
    let attempt = 0
    try {
      while (!this.stopped) {
        this.reconnectRequested = false // fresh attempt
        let networkError = false
        try {
          await this.connectAndConsume()
        } catch (err) {
          if (err instanceof TerminalAuthError) {
            warn(
              `stream stopped: authentication failed (HTTP ${err.status}). The key is ` +
                'invalid or revoked — fix it and re-initialise the SDK. Not retrying.',
            )
            return
          }
          if (!isAbortError(err)) networkError = true
          // an abort is an expected interrupt (stop / reconnect) — not an error
        }
        if (this.stopped) break
        if (this.reconnectRequested) {
          // force-reconnect (identify / healthcheck) → immediate, no backoff
          attempt = 0
          continue
        }
        if (!networkError) attempt = 0 // clean server close resets backoff
        // Full jitter (AWS pattern): random delay in [0, base] — spreads a
        // fleet's reconnects so a shared-dependency blip doesn't re-collide.
        const base = DEFAULT_BACKOFF_SECONDS[Math.min(attempt, DEFAULT_BACKOFF_SECONDS.length - 1)]!
        const delay = Math.random() * base * 1000
        attempt++
        await this.waitInterruptible(delay)
      }
    } finally {
      if (this.healthcheckTimer) {
        clearTimeout(this.healthcheckTimer)
        this.healthcheckTimer = null
      }
    }
  }

  private buildUrl(): string {
    // The key is NOT here — it travels as the `X-Publishable-Key` request
    // header (ADR-0003), so it never reaches the reverse proxy's access.log.
    const params = new URLSearchParams({
      since_version: String(this.opts.cache.configVersion),
      instance_id: getInstanceId(),
      sdk_platform: SDK_PLATFORM,
      sdk_version: VERSION,
    })
    if (this.opts.appVersion) params.set('app_version', this.opts.appVersion)
    if (this.opts.featureEnvironment !== null) {
      params.set('environment', this.opts.featureEnvironment)
    }
    const userId = this.opts.getUserId()
    if (userId !== null) params.set('userId', userId)
    return `${this.opts.apiUrl}/api/sdk/features/stream?${params.toString()}`
  }

  private async connectAndConsume(): Promise<void> {
    const doFetch = resolveFetch(this.opts.fetchImpl)
    if (!doFetch) throw new Error('global fetch unavailable — Node 18+ required or pass fetchImpl')

    this.controller = new AbortController()
    this.lastEventAt = performance.now()

    const res = await doFetch(this.buildUrl(), {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/event-stream',
        'X-Onelo-Instance-Id': getInstanceId(),
        // ADR-0003: the Event Stream's credential. A header-authenticated
        // connection carries no `Deprecation`/`Sunset` — unlike `?key=`.
        // The name is the transport slot, not a claim about the key's class:
        // this is a backend SDK, so the value is usually a SECRET key, exactly
        // as it was when it rode `?key=`. The backend resolves either through
        // the same `_lookup_key`.
        'X-Publishable-Key': this.opts.key,
      },
      signal: this.controller.signal,
    })

    if (res.status === 401 || res.status === 403) throw new TerminalAuthError(res.status)
    if (!res.ok || !res.body) throw new Error(`sse connect failed: HTTP ${res.status}`)

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    const parser = new SseParser()

    try {
      while (!this.stopped && !this.reconnectRequested) {
        const readPromise = reader.read()
        readPromise.catch(() => {}) // if orphaned by an interrupt, don't leak a rejection
        const interruptPromise = new Promise<typeof INTERRUPT>((resolve) => {
          this.interruptRead = () => resolve(INTERRUPT)
        })
        const result = await Promise.race([readPromise, interruptPromise])
        this.interruptRead = null
        if (result === INTERRUPT) return // stop / reconnect requested
        const { done, value } = result
        if (done) return // server closed cleanly — outer loop reconnects
        // Any bytes (incl. `:` heartbeat) mean the stream is alive.
        this.lastEventAt = performance.now()
        for (const evt of parser.push(decoder.decode(value, { stream: true }))) {
          this.handleEvent(evt.event, evt.data)
        }
      }
    } finally {
      this.interruptRead = null
      // reader.cancel() settles instantly on real Node/undici, but a hostile
      // fetchImpl could return a body whose cancel() never resolves — race a
      // short timeout so close() can never hang on it.
      await Promise.race([
        reader.cancel().catch(() => {}),
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 1000)
          t.unref?.()
        }),
      ])
    }
  }

  private handleEvent(eventType: string, data: string): void {
    if (!eventType) return // heartbeat/comment — liveness already bumped
    if (eventType === 'up_to_date') {
      this.opts.onFirstEvent()
      return
    }
    if (eventType === 'connected' || eventType === 'features_updated') {
      try {
        const payload = JSON.parse(data) as { features?: unknown; config_version?: unknown }
        // Fail-closed like Python: a non-object `features` or a missing
        // `config_version` is a malformed event — keep the last-good snapshot
        // and do NOT mark ready (Python raises AttributeError/KeyError here).
        if (
          payload === null ||
          typeof payload !== 'object' ||
          !isPlainObject(payload.features) ||
          payload.config_version == null
        ) {
          throw new Error('missing/invalid features or config_version')
        }
        this.opts.cache.replaceAll(
          payload.features as Record<string, unknown>,
          Number(payload.config_version),
        )
        // onFirstEvent AFTER the cache is applied so ready() implies a usable snapshot.
        this.opts.onFirstEvent()
      } catch (err) {
        warn(`malformed ${eventType} event:`, err)
      }
      return
    }
    if (eventType === 'discovery_requested') {
      this.fireDiscovery()
      return
    }
    // Unknown event — forward-compat, ignore.
  }

  private fireDiscovery(): void {
    if (!this.opts.onDiscoveryRequested) return
    try {
      this.opts.onDiscoveryRequested()
    } catch (err) {
      warn('discovery_requested handler failed:', err)
    }
  }

  private startHealthcheck(): void {
    const tick = () => {
      if (this.stopped) return
      const elapsed = performance.now() - this.lastEventAt
      if (elapsed > STALE_THRESHOLD_MS) {
        // Reset before signalling so the next window measures post-reconnect.
        this.lastEventAt = performance.now()
        this.forceReconnect()
      }
      this.healthcheckTimer = setTimeout(tick, HEALTHCHECK_INTERVAL_MS)
      this.healthcheckTimer.unref?.()
    }
    this.healthcheckTimer = setTimeout(tick, HEALTHCHECK_INTERVAL_MS)
    this.healthcheckTimer.unref?.()
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'ResponseAborted')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
