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
import type { OneloUser } from './user'

/** Pluggable cache contract for verified Onelo users. */
export interface AuthCache {
  get(tokenHash: string): Promise<OneloUser | null>
  set(tokenHash: string, user: OneloUser, ttl: number): Promise<void>
  invalidate(tokenHash: string): Promise<void>
}

interface Entry {
  user: OneloUser
  /** Absolute expiry on the monotonic clock (ms). */
  expiry: number
}

/**
 * Default in-process LRU-with-TTL cache.
 *
 * - Bounded by `maxSize` — the oldest entry is evicted when full.
 * - Each entry carries its own absolute expiry (`now + ttl` at write time).
 * - TTL checks use `performance.now()` (monotonic — immune to wall-clock jumps).
 * - `Map` preserves insertion order; a hit is re-inserted to become MRU.
 */
export class InProcessAuthCache implements AuthCache {
  private readonly store = new Map<string, Entry>()
  private readonly maxSize: number

  constructor(maxSize = 10_000) {
    if (maxSize < 1) throw new Error('maxSize must be >= 1')
    this.maxSize = maxSize
  }

  async get(tokenHash: string): Promise<OneloUser | null> {
    const entry = this.store.get(tokenHash)
    if (entry === undefined) return null
    if (performance.now() >= entry.expiry) {
      // Expired — evict and miss.
      this.store.delete(tokenHash)
      return null
    }
    // Move to MRU end (delete + re-insert).
    this.store.delete(tokenHash)
    this.store.set(tokenHash, entry)
    return entry.user
  }

  async set(tokenHash: string, user: OneloUser, ttl: number): Promise<void> {
    if (ttl <= 0) return // do not cache
    const expiry = performance.now() + ttl * 1000 // ttl is in seconds
    // Replace + move-to-end semantics.
    this.store.delete(tokenHash)
    this.store.set(tokenHash, { user, expiry })
    // Evict oldest entries until under the size cap.
    while (this.store.size > this.maxSize) {
      const oldest = this.store.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.store.delete(oldest)
    }
  }

  async invalidate(tokenHash: string): Promise<void> {
    this.store.delete(tokenHash)
  }
}
