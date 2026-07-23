/**
 * Opt-in auto-instrumentation for Monitor — the Node analog of Python's
 * `onelo/monitor/integrations/` (the logging + httpx/requests integrations).
 *
 * Enable via `monitor.init({ captureConsole: true, httpBreadcrumbs: true })`, or
 * install manually with these functions (e.g. to scope options). Each returns an
 * uninstall function; the monitor calls them on `close()`.
 */
import { format } from 'node:util'

import { scrubUrl } from './scrub'
import type { BreadcrumbCategory, EventLevel } from './types'

/** Minimal capture surface these integrations need — `MonitorClient` satisfies it. */
export interface CaptureMonitor {
  captureException(err: unknown, opts?: { featureName?: string; meta?: Record<string, unknown> }): void
  captureMessage(msg: string, opts?: { level?: EventLevel; featureName?: string }): void
  addBreadcrumb(
    msg: string,
    opts?: { category?: BreadcrumbCategory; level?: EventLevel; data?: Record<string, unknown> },
  ): void
}

type ConsoleMethod = 'error' | 'warn' | 'info' | 'log' | 'debug'

export interface ConsoleCaptureOptions {
  /**
   * Which console methods to capture. `error` → a Monitor event (an `Error`
   * argument becomes a full `captureException` with stack); the rest → a `log`
   * breadcrumb. Default `{ error: true, warn: true }` — info/log/debug are off
   * because Node apps log a lot and every line would become a breadcrumb.
   */
  methods?: Partial<Record<ConsoleMethod, boolean>>
}

/**
 * Wrap `console` methods so errors/warnings feed Monitor (parity with Python's
 * logging integration). The developer's original console output is ALWAYS passed
 * through — we never swallow a log. Returns an uninstall function.
 */
export function installConsoleCapture(
  monitor: CaptureMonitor,
  options: ConsoleCaptureOptions = {},
): () => void {
  const enabled: Record<ConsoleMethod, boolean> = {
    error: options.methods?.error ?? true,
    warn: options.methods?.warn ?? true,
    info: options.methods?.info ?? false,
    log: options.methods?.log ?? false,
    debug: options.methods?.debug ?? false,
  }
  const con = console as unknown as Record<ConsoleMethod, (...a: unknown[]) => void>
  const originals: Partial<Record<ConsoleMethod, (...a: unknown[]) => void>> = {}
  // Re-entrancy guard: a capture path (event/breadcrumb → SDK internals) must
  // never re-enter and capture its own console output.
  let capturing = false

  for (const method of Object.keys(enabled) as ConsoleMethod[]) {
    if (!enabled[method]) continue
    const original = con[method].bind(console)
    originals[method] = con[method]
    con[method] = (...args: unknown[]) => {
      original(...args) // pass through first — never swallow the developer's log
      if (capturing) return
      capturing = true
      try {
        if (method === 'error') {
          const errArg = args.find((a): a is Error => a instanceof Error)
          if (errArg) monitor.captureException(errArg, { featureName: 'console' })
          else monitor.captureMessage(format(...args), { level: 'error', featureName: 'console' })
        } else {
          monitor.addBreadcrumb(format(...args), {
            category: 'log',
            level: method === 'warn' ? 'warning' : 'info',
          })
        }
      } catch {
        /* capture must never break the developer's console call */
      } finally {
        capturing = false
      }
    }
  }

  return () => {
    for (const method of Object.keys(originals) as ConsoleMethod[]) {
      const orig = originals[method]
      if (orig) con[method] = orig
    }
  }
}

export interface FetchBreadcrumbOptions {
  /**
   * Skip requests whose URL starts with this prefix — used to exclude the SDK's
   * OWN traffic (event/feature calls), which would otherwise recurse: sending an
   * event issues a fetch → breadcrumb → attached to the next event → …
   */
  ignoreUrlPrefix?: string
}

/**
 * Wrap the global `fetch` so every outgoing request adds an `http` breadcrumb
 * (method, scrubbed URL, status, duration) — parity with Python's httpx/requests
 * integrations. Returns an uninstall function. No-op on runtimes without `fetch`.
 */
export function installFetchBreadcrumbs(
  monitor: CaptureMonitor,
  options: FetchBreadcrumbOptions = {},
): () => void {
  const g = globalThis as { fetch?: typeof fetch }
  const original = g.fetch
  if (typeof original !== 'function') return () => {}
  const ignore = options.ignoreUrlPrefix

  const wrapped: typeof fetch = async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    // The SDK's own event/feature traffic must not breadcrumb (would recurse).
    if (ignore && url.startsWith(ignore)) return original(input, init)
    const method = (
      init?.method ??
      (typeof input === 'object' && input !== null && 'method' in input
        ? (input as Request).method
        : 'GET')
    ).toUpperCase()
    const safeUrl = scrubUrl(url) ?? url
    const start = performance.now()
    try {
      const res = await original(input, init)
      monitor.addBreadcrumb(`${method} ${safeUrl}`, {
        category: 'http',
        level: res.ok ? 'info' : 'warning',
        data: {
          method,
          url: safeUrl,
          status_code: res.status,
          duration_ms: Math.round(performance.now() - start),
        },
      })
      return res
    } catch (err) {
      monitor.addBreadcrumb(`${method} ${safeUrl}`, {
        category: 'http',
        level: 'error',
        data: { method, url: safeUrl, error: String(err), duration_ms: Math.round(performance.now() - start) },
      })
      throw err
    }
  }

  g.fetch = wrapped
  return () => {
    // Only restore if nobody re-wrapped global fetch after us.
    if (g.fetch === wrapped) g.fetch = original
  }
}
