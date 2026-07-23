/**
 * Shared request-context builder for the framework monitor adapters — the Node
 * analog of Python's `onelo/monitor/_request_context.py`. Each adapter normalises
 * its framework's request into `{ method, url, headers }` and calls
 * {@link attachRequestToScope}, so every event captured during the request
 * automatically carries scrubbed request context. Scrubbing / drop-list logic
 * lives here, in exactly one place, shared by Express/Next/Fastify/Hono.
 */
import { scrubHeaders, scrubUrl } from './scrub'

/** Minimal monitor surface these helpers need — `MonitorClient` satisfies it. */
export interface ScopeMonitor {
  setContext(key: string, value: Record<string, unknown>): void
  setUser(user: Record<string, unknown> | null): void
  setTag(key: string, value: string): void
}

// Never send these even after scrubbing — they bloat the payload without
// diagnostic value (cookies are already redacted, but they're also huge).
// Matches Python `_request_context._DROP_HEADERS`.
const DROP_HEADERS = new Set(['cookie', 'set-cookie', 'authorization'])

/** A Web `Headers` object, a plain record, or nothing — normalised below. */
export type HeadersInput =
  | Record<string, string | string[] | undefined>
  | { forEach(cb: (value: string, key: string) => void): void }
  | null
  | undefined

/** Collapse a framework's headers into a lowercase `Record<string, string>`. */
function normalizeHeaders(headers: HeadersInput): Record<string, string> | null {
  if (!headers) return null
  const out: Record<string, string> = {}
  const maybeForEach = (headers as { forEach?: unknown }).forEach
  if (typeof maybeForEach === 'function' && !Array.isArray(headers)) {
    // Web `Headers` (Next.js route handlers / the fetch `Request`).
    ;(headers as { forEach(cb: (v: string, k: string) => void): void }).forEach((v, k) => {
      out[k.toLowerCase()] = v
    })
    return out
  }
  for (const [k, v] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (v == null) continue
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v)
  }
  return out
}

/**
 * Build the `contexts.request` object for an event: uppercase method, scrubbed
 * full URL (query/path/fragment redacted), and scrubbed headers minus the
 * drop-list. Mirrors OTel `http.*` where possible (parity with Python's
 * `build_request_context`).
 */
export function buildRequestContext(input: {
  method: string
  url?: string | null
  headers?: HeadersInput
}): Record<string, unknown> {
  const ctx: Record<string, unknown> = { method: (input.method || '').toUpperCase() }
  const url = scrubUrl(input.url)
  if (url) ctx.url = url
  const normalized = normalizeHeaders(input.headers)
  const scrubbed = normalized ? scrubHeaders(normalized) : null
  if (scrubbed) {
    const kept = Object.fromEntries(
      Object.entries(scrubbed).filter(([k]) => !DROP_HEADERS.has(k.toLowerCase())),
    )
    if (Object.keys(kept).length > 0) ctx.headers = kept
  }
  return ctx
}

/**
 * Populate the active isolation scope with request context (+ user id). Call
 * early in the request so any event captured during it carries this data.
 * Mirrors Python `attach_request_to_scope`.
 */
export function attachRequestToScope(
  monitor: ScopeMonitor,
  input: { method: string; url?: string | null; headers?: HeadersInput; userId?: string | null },
): void {
  monitor.setContext('request', buildRequestContext(input))
  if (input.userId != null) monitor.setUser({ id: input.userId })
}

/**
 * Tag the active scope with the response status code so dashboards can filter on
 * it. Mirrors Python `attach_response_to_scope` (the status-code half; the scope
 * `level` it also sets is not emitted by either SDK).
 */
export function attachResponseToScope(monitor: ScopeMonitor, statusCode: number): void {
  if (Number.isFinite(statusCode)) monitor.setTag('http.status_code', String(statusCode))
}
