/**
 * Strategy resolution. 1:1 with Python's `onelo._detection`. In v1, "auto" maps
 * to "sse". This function exists so multi-worker heuristics / a Redis
 * coordinator can be added later without changing the public API.
 */
export type Strategy = 'sse' | 'polling'

const VALID_STRATEGIES = new Set(['auto', 'sse', 'polling'])
const DEFERRED_STRATEGIES = new Set(['redis'])

/** Resolve "auto" → "sse". Throws on invalid / deferred values. */
export function resolveStrategy(strategy: string): Strategy {
  if (DEFERRED_STRATEGIES.has(strategy)) {
    throw new Error(
      `strategy='${strategy}' is not supported in v1. Use 'sse' or 'polling'. ` +
        'A Redis pub/sub coordinator may land in v1.x.',
    )
  }
  if (!VALID_STRATEGIES.has(strategy)) {
    throw new Error(`strategy must be one of 'auto', 'sse', 'polling', got '${strategy}'.`)
  }
  return strategy === 'auto' ? 'sse' : (strategy as Strategy)
}
