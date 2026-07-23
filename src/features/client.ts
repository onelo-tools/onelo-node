/**
 * Public `onelo.features` façade. 1:1 with Python's `onelo._features.FeaturesClient`.
 *
 * Cache-backed reads + auto-discovery: every `feature(name)` / `declare([...])`
 * records the slug and schedules a debounced batch-ping so the dashboard registry
 * fills in without explicit wiring. `forUser()` is the stateless, multi-user-safe
 * path (POST /resolve, per-user TTL cache) — no global identity mutation.
 */
import type { FetchLike } from '../auth/verify'
import { VERSION } from '../version'
import type { FeatureCache, FeatureState } from './cache'
import { SDK_PLATFORM, USER_AGENT, resolveFetch } from './consumer'
import { Feature, GATED_STATUSES, UserFeatures } from './feature'
import { UserSnapshotCache } from './user-snapshot-cache'

// eslint-disable-next-line no-console
const warn = (...args: unknown[]) => console.warn('[onelo.features]', ...args)

export interface FeaturesClientOptions {
  cache: FeatureCache
  /** Ask the client to schedule a debounced discovery batch-ping. */
  scheduleBatchPing: () => void
  /** Block until first backend contact (or timeout). */
  ready: (timeoutMs: number) => Promise<boolean>
  /** Lazily start the background consumer on first feature use. Idempotent. */
  ensureStarted: () => void
  apiUrl: string
  /** The primary key (used for the stateless /resolve call). */
  publishableKey: string
  requestTimeout: number
  fetchImpl?: FetchLike
  featureEnvironment: string | null
}

export interface ForUserOptions {
  /** Per-user cache TTL in seconds. Default 30. */
  ttl?: number
}

export class FeaturesClient {
  private readonly discovered = new Set<string>()
  private readonly userCache = new UserSnapshotCache()
  private readonly warnedGated = new Set<string>()

  constructor(private readonly opts: FeaturesClientOptions) {}

  /**
   * The Feature for `name`. Cache miss → hidden (fail-closed). Side effect: the
   * first sighting of `name` schedules a debounced batch-ping and lazily starts
   * the background stream. Mirrors Swift/Python `feature(_:)`.
   */
  feature(name: string): Feature {
    this.opts.ensureStarted()
    if (!this.discovered.has(name)) {
      this.discovered.add(name)
      this.opts.scheduleBatchPing()
    }
    const state = this.opts.cache.getState(name)
    const status = typeof state.status === 'string' ? state.status : 'hidden'
    if (GATED_STATUSES.has(status)) this.maybeWarnGated(name, status)
    return Feature.fromWire(name, state)
  }

  /** Shorthand for `feature(name).isEnabled`. */
  isEnabled(name: string): boolean {
    return this.feature(name).isEnabled
  }

  /**
   * Register feature names so they appear in the dashboard registry without
   * waiting for a code path to execute. Same debounce as `feature()`.
   */
  declare(names: string[]): void {
    this.opts.ensureStarted()
    let added = false
    for (const name of names) {
      if (!this.discovered.has(name)) {
        this.discovered.add(name)
        added = true
      }
    }
    if (added) this.opts.scheduleBatchPing()
  }

  /** Slug names this process has ever asked about (drives the batch-ping). */
  snapshotDiscovered(): string[] {
    return [...this.discovered]
  }

  /** Block until the first backend snapshot lands (or timeout). Default 1500ms. */
  ready(timeoutMs = 1500): Promise<boolean> {
    this.opts.ensureStarted()
    return this.opts.ready(timeoutMs)
  }

  /**
   * Resolve features for a SPECIFIC user — the multi-user-safe path. Stateless
   * POST /resolve for THIS user; never touches global identity. Cached per-user
   * for `ttl` seconds. Fail-closed: any network/HTTP error → every feature
   * hidden (empty snapshot). Throws only for an empty user_id (programmer error).
   */
  async forUser(userId: string, options: ForUserOptions = {}): Promise<UserFeatures> {
    if (!userId) throw new Error('forUser requires a non-empty userId')
    let snapshot = this.userCache.get(userId)
    if (snapshot === null) {
      snapshot = await this.resolveUser(userId)
      this.userCache.put(userId, snapshot, options.ttl ?? 30)
    }
    return new UserFeatures(userId, snapshot)
  }

  private async resolveUser(userId: string): Promise<Record<string, FeatureState>> {
    if (!this.opts.apiUrl || !this.opts.publishableKey) {
      warn('forUser: SDK missing apiUrl/key — resolving empty')
      return {}
    }
    const doFetch = resolveFetch(this.opts.fetchImpl)
    if (!doFetch) {
      warn('forUser: global fetch unavailable — resolving empty')
      return {}
    }
    const body: Record<string, unknown> = {
      publishableKey: this.opts.publishableKey,
      userId,
      sdk_platform: SDK_PLATFORM,
      sdk_version: VERSION,
    }
    if (this.opts.featureEnvironment !== null) body.environment = this.opts.featureEnvironment

    try {
      const res = await doFetch(`${this.opts.apiUrl}/api/sdk/features/resolve`, {
        method: 'POST',
        headers: { 'User-Agent': USER_AGENT, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.requestTimeout),
      })
      if (!res.ok) {
        warn(`forUser resolve failed (fail-closed → hidden): HTTP ${res.status}`)
        return {}
      }
      const data = (await res.json()) as { features?: unknown }
      const feats = data?.features
      if (feats === null || typeof feats !== 'object' || Array.isArray(feats)) return {}
      const out: Record<string, FeatureState> = {}
      for (const [name, state] of Object.entries(feats as Record<string, unknown>)) {
        out[name] =
          state !== null && typeof state === 'object' && !Array.isArray(state)
            ? { ...(state as FeatureState) }
            : { status: String(state) }
      }
      return out
    } catch (err) {
      warn('forUser resolve failed (fail-closed → hidden):', err)
      return {}
    }
  }

  /**
   * Drop the cached per-user snapshot so the NEXT `forUser(userId)` re-fetches.
   * Call it the moment your backend learns a user's plan changed. Pass a userId
   * to invalidate one user, or nothing to clear EVERY cached user.
   */
  invalidateUser(userId?: string): void {
    if (userId === undefined) this.userCache.clear()
    else this.userCache.invalidate(userId)
  }

  private maybeWarnGated(name: string, status: string): void {
    if (process.env.ONELO_SUPPRESS_GATING_WARNING) return
    if (this.warnedGated.has(name)) return
    this.warnedGated.add(name)
    warn(
      `feature('${name}') resolved to '${status}' under the process-global identity. ` +
        'On a multi-user backend resolve per request instead — ' +
        `await onelo.features.forUser(userId).then(u => u.feature('${name}')) — so plan ` +
        'gating is evaluated for the actual user, not a shared identity. ' +
        '(Set ONELO_SUPPRESS_GATING_WARNING=1 to silence if this is intentional.)',
    )
  }
}
