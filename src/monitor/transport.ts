/**
 * HTTP transport for monitor events. 1:1 with Python's `onelo.monitor._transport`
 * behaviour, Node-native: no background thread — a recurring (unref'd) timer
 * flushes every ~15s, error events flush immediately, and all drains are
 * serialised through one promise chain so a timer flush and an explicit flush()
 * can't drain concurrently.
 *
 *  - bounded buffer (drops oldest when full — monitoring must never OOM);
 *  - retry 5xx/network with exponential backoff, drop 4xx (won't help);
 *  - honour 429 Retry-After + X-Onelo-Quota-Remaining self-throttle;
 *  - `beforeExit` best-effort drain for short scripts; servers call close()/flush().
 */
import type { FetchLike } from '../auth/verify'
import { USER_AGENT } from '../features/consumer'
import type { MonitorEvent } from './types'

export const DEFAULT_BUFFER_SIZE = 200
export const DEFAULT_FLUSH_INTERVAL_MS = 15_000
export const DEFAULT_REQUEST_TIMEOUT_MS = 5_000
const MAX_RETRY_ATTEMPTS = 3
const QUOTA_LOW_WATERMARK = 50
const QUOTA_EXHAUSTED_HOLDOFF_MS = 300_000
const MAX_RETRY_AFTER_MS = 3_600_000

// eslint-disable-next-line no-console
const warn = (...args: unknown[]) => console.warn('[onelo.monitor]', ...args)

export interface MonitorTransportOptions {
  apiUrl: string
  publishableKey: string
  bufferSize?: number
  flushIntervalMs?: number
  requestTimeout?: number
  fetchImpl?: FetchLike
}

export class MonitorTransport {
  private readonly apiUrl: string
  private readonly key: string
  private readonly bufferSize: number
  private readonly flushIntervalMs: number
  private readonly requestTimeout: number
  private readonly fetchImpl?: FetchLike

  private buffer: MonitorEvent[] = []
  private dropped = 0
  private droppedReported = 0
  private retryAfterUntil = 0 // performance.now() ms; while future, hold off
  private _quotaRemaining: number | null = null

  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private flushChain: Promise<void> = Promise.resolve()
  private beforeExitHandler: (() => void) | null = null

  constructor(opts: MonitorTransportOptions) {
    this.apiUrl = opts.apiUrl.replace(/\/+$/, '')
    this.key = opts.publishableKey
    this.bufferSize = opts.bufferSize ?? DEFAULT_BUFFER_SIZE
    this.flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS
    this.requestTimeout = opts.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.fetchImpl = opts.fetchImpl
  }

  start(): void {
    this.scheduleFlush()
    // Best-effort drain for short-lived scripts. Servers should call close().
    this.beforeExitHandler = () => {
      void this.flush()
    }
    process.once('beforeExit', this.beforeExitHandler)
  }

  get quotaRemaining(): number | null {
    return this._quotaRemaining
  }

  get droppedCount(): number {
    return this.dropped
  }

  get bufferLength(): number {
    return this.buffer.length
  }

  /** Enqueue an event. Returns immediately, never throws. */
  send(event: MonitorEvent): void {
    if (this.stopped) return
    if (this.buffer.length >= this.bufferSize) {
      this.buffer.shift()
      this.dropped++
    }
    this.buffer.push(event)
    // Errors flush immediately — don't wait for the periodic timer.
    if (!event.ok || event.source === 'global_error') void this.doFlush()
  }

  /** Drain the buffer now. Serialised with all other flushes. */
  flush(): Promise<void> {
    return this.doFlush()
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.beforeExitHandler) {
      process.removeListener('beforeExit', this.beforeExitHandler)
      this.beforeExitHandler = null
    }
    // Force the final drain past any self-imposed 429/quota hold-off — on
    // shutdown a best-effort send beats silently dropping the buffered tail
    // (the transport won't flush again after stop). Mirrors Python's atexit drain.
    await this.doFlush(true)
  }

  // ── internals ─────────────────────────────────────────────────────────

  private scheduleFlush(): void {
    this.timer = setTimeout(() => {
      void this.doFlush().finally(() => {
        if (!this.stopped) this.scheduleFlush()
      })
    }, this.flushIntervalMs)
    this.timer.unref?.()
  }

  private doFlush(force = false): Promise<void> {
    // Chain so drains never overlap: an explicit flush() awaits any in-flight
    // error-triggered send before it observes an empty buffer.
    this.flushChain = this.flushChain.then(() => this.drainOnce(force)).catch(() => {})
    return this.flushChain
  }

  private async drainOnce(force = false): Promise<void> {
    if (!force && this.retryAfterUntil && performance.now() < this.retryAfterUntil) return
    if (this.buffer.length === 0) return
    const batch = this.buffer
    this.buffer = [] // atomic swap on the single-threaded loop
    await this.sendBatchWithRetry(batch)
    this.maybeReportDrops()
  }

  private async sendBatchWithRetry(batch: MonitorEvent[]): Promise<void> {
    let backoff = 500
    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
      let done = false
      try {
        done = await this.sendOnce(batch)
      } catch {
        // network/programming error — retry
      }
      if (done) return
      if (attempt < MAX_RETRY_ATTEMPTS) {
        await sleep(backoff)
        backoff *= 2
      }
    }
    warn(`dropping batch of ${batch.length} events after ${MAX_RETRY_ATTEMPTS} attempts`)
  }

  /** Returns true when the batch is done (success OR non-retryable failure). */
  private async sendOnce(batch: MonitorEvent[]): Promise<boolean> {
    const doFetch = this.fetchImpl ?? (typeof fetch === 'function' ? (fetch as FetchLike) : null)
    if (!doFetch) return true // no fetch — nothing we can do; drop
    const payload = {
      publishableKey: this.key,
      events: batch.map(eventToWire),
    }
    let res: Response
    try {
      res = await doFetch(`${this.apiUrl}/api/sdk/monitor/events/batch`, {
        method: 'POST',
        headers: { 'User-Agent': USER_AGENT, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.requestTimeout),
      })
    } catch {
      return false // network — retry
    }
    if (res.status >= 200 && res.status < 300) {
      this.noteQuota(res.headers.get('X-Onelo-Quota-Remaining'))
      return true
    }
    if (res.status === 429) {
      const retryAfterMs = parseRetryAfter(res.headers.get('Retry-After'))
      if (retryAfterMs > 0) this.retryAfterUntil = performance.now() + retryAfterMs
      return true // don't retry — quota won't move
    }
    if (res.status >= 400 && res.status < 500) return true // 401/403/422 — pointless to retry
    return false // 5xx — retry
  }

  private noteQuota(header: string | null): void {
    if (header === null) return
    const h = header.trim()
    if (h === '') return // blank (e.g. a proxy stripped the value) — not "0 remaining"
    if (h.toLowerCase() === 'unlimited') {
      this._quotaRemaining = null
      return
    }
    const remaining = Number(h)
    if (!Number.isFinite(remaining)) return
    this._quotaRemaining = remaining
    if (remaining <= 0) {
      this.retryAfterUntil = Math.max(this.retryAfterUntil, performance.now() + QUOTA_EXHAUSTED_HOLDOFF_MS)
      warn(`event quota exhausted; holding off ~${QUOTA_EXHAUSTED_HOLDOFF_MS / 1000}s before retry`)
    } else if (remaining <= QUOTA_LOW_WATERMARK) {
      warn(`event quota low — ${remaining} remaining this hour`)
    }
  }

  private maybeReportDrops(): void {
    const newly = this.dropped - this.droppedReported
    this.droppedReported = this.dropped
    if (newly > 0) {
      warn(
        `dropped ${newly} event(s) — buffer full (max ${this.bufferSize}). ` +
          'Raise bufferSize or lower volume via sampleRate.',
      )
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    t.unref?.()
  })
}

/** Serialise a MonitorEvent to the JSON shape the backend expects. */
export function eventToWire(event: MonitorEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {
    featureName: event.featureName,
    ok: event.ok,
    platform: event.platform,
    source: event.source,
    // Real event time, so a batched/retried/drained event isn't mis-dated to
    // ingest time. Backend stores it as display-only clamped event_ts.
    ts: new Date(event.timestamp).toISOString(),
  }
  if (event.durationMs != null) out.durationMs = event.durationMs
  if (event.error != null) out.error = event.error
  if (event.userId != null) out.userId = event.userId
  if (event.sessionId != null) out.sessionId = event.sessionId
  if (event.meta && Object.keys(event.meta).length > 0) out.meta = event.meta
  return out
}

function parseRetryAfter(value: string | null): number {
  if (!value) return 0
  const seconds = Number(value.trim())
  if (!Number.isFinite(seconds)) return 0
  return Math.max(0, Math.min(seconds * 1000, MAX_RETRY_AFTER_MS))
}
