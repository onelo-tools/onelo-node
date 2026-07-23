/**
 * TTL cache of per-user feature snapshots keyed by user_id. 1:1 with Python's
 * `onelo._features._UserSnapshotCache`. Stops a busy multi-user backend from
 * calling /resolve on every request for the same user.
 *
 * Bounded two ways so a long tail of one-shot user_ids can't leak:
 *   1. lazy prune — an expired entry is deleted on the get() that finds it;
 *   2. hard cap — over `maxEntries`, put() purges expired then evicts
 *      soonest-to-expire.
 */
import type { FeatureState } from './cache'

export const USER_SNAPSHOT_MAX_ENTRIES = 10_000

interface Entry {
  deadline: number // monotonic ms
  snapshot: Record<string, FeatureState>
}

export class UserSnapshotCache {
  private map = new Map<string, Entry>()

  constructor(private readonly maxEntries = USER_SNAPSHOT_MAX_ENTRIES) {}

  get(userId: string): Record<string, FeatureState> | null {
    const entry = this.map.get(userId)
    if (entry === undefined) return null
    if (entry.deadline > performance.now()) return entry.snapshot
    // Expired — delete now so a long tail of one-shot users can't accumulate.
    this.map.delete(userId)
    return null
  }

  put(userId: string, snapshot: Record<string, FeatureState>, ttlSeconds: number): void {
    this.map.set(userId, { deadline: performance.now() + ttlSeconds * 1000, snapshot })
    if (this.map.size > this.maxEntries) this.evict()
  }

  private evict(): void {
    const now = performance.now()
    // Drop expired first (free to remove).
    for (const [k, entry] of this.map) {
      if (entry.deadline <= now) this.map.delete(k)
    }
    const overflow = this.map.size - this.maxEntries
    if (overflow > 0) {
      // Evict entries closest to expiry (least valuable).
      const soonest = [...this.map.entries()]
        .sort((a, b) => a[1].deadline - b[1].deadline)
        .slice(0, overflow)
      for (const [k] of soonest) this.map.delete(k)
    }
  }

  invalidate(userId: string): void {
    this.map.delete(userId)
  }

  clear(): void {
    this.map.clear()
  }
}
