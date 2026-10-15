/**
 * Polling consumer — opt-in fallback when SSE is unwanted/unavailable. 1:1 with
 * Python's `onelo._polling`.
 *
 * Periodically GETs /api/sdk/features/poll?since_version=N and updates the cache.
 * Backend returns a small `{up_to_date:true}` body when nothing changed, or a
 * full snapshot when it did. Network errors are logged and retried next interval
 * — never propagated.
 */
import {
  type ConsumerOptions,
  type FeatureConsumer,
  USER_AGENT,
  resolveFetch,
} from './consumer'

// eslint-disable-next-line no-console
const warn = (...args: unknown[]) => console.warn('[onelo.features]', ...args)

export interface PollingOptions extends ConsumerOptions {
  /** Seconds between polls. Default 30. */
  pollIntervalSeconds?: number
}

export class PollingConsumer implements FeatureConsumer {
  private stopped = false
  private readonly intervalMs: number
  private wakeResolvers: Array<() => void> = []
  private controller: AbortController | null = null

  constructor(private readonly opts: PollingOptions) {
    this.intervalMs = (opts.pollIntervalSeconds ?? 30) * 1000
  }

  stop(): void {
    this.stopped = true
    // Abort any in-flight poll so close() doesn't stall up to requestTimeout.
    this.controller?.abort()
    this.wake()
  }

  // Polling reads getUserId() fresh each cycle, so an identify() is picked up
  // naturally within one interval — no forced reconnect needed.
  forceReconnect(): void {}

  private wake(): void {
    const resolvers = this.wakeResolvers
    this.wakeResolvers = []
    for (const r of resolvers) r()
  }

  private waitInterruptible(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.wakeResolvers = this.wakeResolvers.filter((r) => r !== onWake)
        resolve()
      }, ms)
      // Don't hold the process open for the inter-poll sleep.
      t.unref?.()
      const onWake = () => {
        clearTimeout(t)
        resolve()
      }
      this.wakeResolvers.push(onWake)
    })
  }

  async run(): Promise<void> {
    while (!this.stopped) {
      await this.pollOnce()
      if (this.stopped) break
      await this.waitInterruptible(this.intervalMs)
    }
  }

  private buildUrl(): string {
    // The key is NOT here — it travels as the `X-Publishable-Key` request
    // header (ADR-0003, #105), exactly as sse-consumer.ts sends it on the
    // stream. `/poll` fires on a timer from a server, so the credential is
    // typically a Secret Key; in the query string it landed in the reverse
    // proxy's access.log on every tick, and from 2027-03-31 the backend
    // refuses `?key=` outright. Sending both would re-arm the Deprecation/
    // Sunset headers, because the backend resolves `?key=` first.
    const params = new URLSearchParams({
      since_version: String(this.opts.cache.configVersion),
    })
    if (this.opts.featureEnvironment !== null) {
      params.set('environment', this.opts.featureEnvironment)
    }
    const userId = this.opts.getUserId()
    if (userId !== null) params.set('userId', userId)
    return `${this.opts.apiUrl}/api/sdk/features/poll?${params.toString()}`
  }

  private async pollOnce(): Promise<void> {
    const doFetch = resolveFetch(this.opts.fetchImpl)
    if (!doFetch) {
      warn('global fetch unavailable — Node 18+ required or pass fetchImpl')
      return
    }

    // One controller carries BOTH the request timeout AND stop() — so a graceful
    // close aborts an in-flight poll immediately instead of waiting the timeout.
    const controller = new AbortController()
    this.controller = controller
    const timeout = setTimeout(() => controller.abort(), this.opts.requestTimeout)
    timeout.unref?.()

    let res: Response
    try {
      res = await doFetch(this.buildUrl(), {
        method: 'GET',
        headers: { 'User-Agent': USER_AGENT, 'X-Publishable-Key': this.opts.key },
        signal: controller.signal,
      })
    } catch {
      // Transient network error / aborted (timeout or stop) — retry next interval.
      return
    } finally {
      clearTimeout(timeout)
      this.controller = null
    }

    // 304 → cache already current: first contact for ready().
    // Note: unlike Python (which marks ready on ANY 200/304 up front), we only
    // signal ready from the successful branches below — so a malformed 200 leaves
    // ready() pending until timeout rather than resolving with an empty cache.
    // Deliberate: ready() should imply a usable snapshot, not just "got a reply".
    if (res.status === 304) {
      this.opts.onFirstEvent()
      return
    }

    if (res.status === 200) {
      let data: unknown
      try {
        data = await res.json()
      } catch (err) {
        warn('poll response not JSON:', err)
        return
      }
      if (data === null || typeof data !== 'object' || Array.isArray(data)) {
        warn('poll response not a JSON object')
        return
      }
      const body = data as Record<string, unknown>
      // Version short-circuit: {config_version, up_to_date:true, ...} with no
      // features payload — the cache is already current.
      if (body.up_to_date || !('features' in body)) {
        this.maybeRequestDiscovery(body)
        this.opts.onFirstEvent()
        return
      }
      // Fail-closed like Python: non-object `features` or missing
      // `config_version` → keep the last-good snapshot and do NOT mark ready.
      const feats = body.features
      if (
        feats === null ||
        typeof feats !== 'object' ||
        Array.isArray(feats) ||
        body.config_version == null
      ) {
        warn('poll response malformed features/config_version')
        return
      }
      try {
        this.opts.cache.replaceAll(feats as Record<string, unknown>, Number(body.config_version))
      } catch (err) {
        warn('poll response malformed:', err)
        return
      }
      this.maybeRequestDiscovery(body)
      // onFirstEvent AFTER the cache is applied so ready() implies a usable snapshot.
      this.opts.onFirstEvent()
    } else if (res.status === 401) {
      warn('poll: 401 Unauthorized — check the SDK key')
    } else if (res.status >= 500 && res.status < 600) {
      warn(`poll: ${res.status} server error`)
    }
  }

  private maybeRequestDiscovery(body: Record<string, unknown>): void {
    if (!body.discovery_requested || !this.opts.onDiscoveryRequested) return
    try {
      this.opts.onDiscoveryRequested()
    } catch (err) {
      warn('discovery_requested handler failed:', err)
    }
  }
}
