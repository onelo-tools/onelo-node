/**
 * Shared consumer plumbing — the options both the SSE and polling consumers take,
 * plus the SDK User-Agent (the backend derives the platform tag from it, so it
 * MUST read `onelo-node/<version>` for discovery to record `sdk_platform=node`).
 */
import type { FetchLike } from '../auth/verify'
import type { FeatureCache } from './cache'
import { VERSION } from '../version'

/** The SDK platform tag sent to the backend (stream `sdk_platform`, UA-derived). */
export const SDK_PLATFORM = 'node'

/** `User-Agent` — backend `_UA_LANGUAGE_MAP` maps `onelo-node` → `node`. */
export const USER_AGENT = `onelo-node/${VERSION}`

export interface ConsumerOptions {
  apiUrl: string
  /** The primary (secret/publishable) key. */
  key: string
  cache: FeatureCache
  getUserId: () => string | null
  requestTimeout: number // ms
  fetchImpl?: FetchLike
  featureEnvironment: string | null
  /** Called on first successful contact (connected / up_to_date / poll 200|304). */
  onFirstEvent: () => void
  /** Called when the backend flags a pending discovery request. */
  onDiscoveryRequested?: () => void
  appVersion?: string | null
}

/** A running feature consumer (SSE or polling). */
export interface FeatureConsumer {
  run(): Promise<void>
  stop(): void
  /** Force an immediate reconnect (SSE); no-op for polling (next cycle picks up). */
  forceReconnect(): void
}

export function resolveFetch(fetchImpl?: FetchLike): FetchLike | null {
  return fetchImpl ?? (typeof fetch === 'function' ? (fetch as FetchLike) : null)
}
