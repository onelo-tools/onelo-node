/**
 * Monitor data model. 1:1 with Python's `onelo.monitor._types`, adapted for JS
 * (colno added — Node stacks carry a column; camelCase field names).
 *
 * The wire envelope (`MonitorEvent`) is FLAT + a `meta` blob; everything rich
 * (exception, breadcrumbs, tags, contexts, flags, release/environment) lives
 * inside `meta`. The backend reads specific meta paths (meta.app.version,
 * meta.environment, meta.flags, meta.exception...).
 */
import { scrubUrl } from './scrub'

export type BreadcrumbCategory =
  | 'navigation'
  | 'http'
  | 'feature'
  | 'lifecycle'
  | 'user'
  | 'info'
  | 'error'
  | 'log'
  | 'auth'
  | 'db'

export type EventLevel = 'debug' | 'info' | 'warning' | 'error' | 'fatal'

export interface Breadcrumb {
  category: BreadcrumbCategory
  message: string
  /** Epoch seconds (matches Python `time()`). */
  timestamp: number
  level: EventLevel
  data?: Record<string, unknown>
}

export interface StackFrame {
  function: string | null
  module: string | null
  filename: string | null
  lineno: number | null
  colno: number | null
  inApp: boolean
  contextLine?: string | null
}

export interface CapturedException {
  type: string
  message: string
  frames: StackFrame[]
  /** For a chained cause (`throw new Error(msg, { cause })`). */
  cause?: CapturedException | null
}

/** The wire envelope POSTed to /api/sdk/monitor/events/batch. */
export interface MonitorEvent {
  featureName: string
  ok: boolean
  /** Epoch MILLISECONDS at event creation (serialised to ISO `ts` on the wire). */
  timestamp: number
  durationMs?: number | null
  error?: string | null
  source: string
  userId?: string | null
  platform: string
  sessionId?: string | null
  meta: Record<string, unknown>
}

/** Build a MonitorEvent with sensible defaults (platform node, timestamp now). */
export function makeEvent(partial: Partial<MonitorEvent> & { featureName: string; ok: boolean }): MonitorEvent {
  return {
    timestamp: Date.now(),
    source: 'event',
    platform: 'node',
    meta: {},
    ...partial,
  }
}

// ── Breadcrumb helpers (mirror Python classmethods) ─────────────────────────

const nowSeconds = () => Date.now() / 1000

export const Breadcrumbs = {
  info(message: string, data?: Record<string, unknown>): Breadcrumb {
    return { category: 'info', message, timestamp: nowSeconds(), level: 'info', data }
  },
  http(
    method: string,
    url: string,
    status?: number,
    durationMs?: number,
    extra?: Record<string, unknown>,
  ): Breadcrumb {
    // Scrub the URL EAGERLY (like Python's Breadcrumb.http) so query-param
    // secrets never sit in the breadcrumb buffer. The deferred meta scrubber
    // only catches regex-shaped secrets — it does NOT apply the query-key
    // denylist (?code= / ?access_token= / ?session=), so an opaque token would
    // otherwise leak verbatim.
    const scrubbed = scrubUrl(url) ?? url
    const data: Record<string, unknown> = { method: method.toUpperCase(), url: scrubbed }
    if (status !== undefined) data.status = status
    if (durationMs !== undefined) data.duration_ms = durationMs
    if (extra) Object.assign(data, extra)
    return {
      category: 'http',
      message: `${method.toUpperCase()} ${scrubbed}`,
      timestamp: nowSeconds(),
      level: 'info',
      data,
    }
  },
  feature(name: string, value: string): Breadcrumb {
    return { category: 'feature', message: name, timestamp: nowSeconds(), level: 'info', data: { value } }
  },
  lifecycle(event: string): Breadcrumb {
    return { category: 'lifecycle', message: event, timestamp: nowSeconds(), level: 'info' }
  },
}

/** Serialise a breadcrumb to the wire shape (`meta.breadcrumbs[]`). */
export function breadcrumbToWire(c: Breadcrumb): Record<string, unknown> {
  const out: Record<string, unknown> = {
    category: c.category,
    message: c.message,
    ts: c.timestamp,
    level: c.level,
  }
  if (c.data) out.data = c.data
  return out
}
