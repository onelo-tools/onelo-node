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
export type FeatureState = Record<string, unknown>

export class FeatureCache {
  private features = new Map<string, FeatureState>()
  private _configVersion = 0

  /** Canonicalise a per-feature value: full wire dict (copied) or bare status string. */
  private normalize(value: unknown): FeatureState {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return { ...(value as FeatureState) }
    }
    return { status: String(value) }
  }

  /** Full wire state dict for `name`, or `{status:'hidden'}` on miss. Defensive copy. */
  getState(name: string): FeatureState {
    const state = this.features.get(name)
    return state !== undefined ? { ...state } : { status: 'hidden' }
  }

  /** Wire status string for `name`, or 'hidden' on miss. Status-only convenience. */
  get(name: string): string {
    const state = this.features.get(name)
    if (state === undefined) return 'hidden'
    return typeof state.status === 'string' ? state.status : 'hidden'
  }

  /** Atomically replace the entire snapshot. Values may be dicts or status strings. */
  replaceAll(features: Record<string, unknown> | null | undefined, version: number): void {
    const next = new Map<string, FeatureState>()
    for (const [name, value] of Object.entries(features ?? {})) {
      next.set(name, this.normalize(value))
    }
    this.features = next
    this._configVersion = Number.isFinite(version) ? version : 0
  }

  get configVersion(): number {
    return this._configVersion
  }

  /**
   * Stable `{ name: status }` copy. Status-only by design — used by the monitor
   * module to stamp active flag values on captured events (F3).
   */
  snapshot(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [name, state] of this.features) {
      out[name] = typeof state.status === 'string' ? state.status : 'hidden'
    }
    return out
  }
}
