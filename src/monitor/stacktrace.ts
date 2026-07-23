/**
 * Parse a Node `Error.stack` string into transport-safe StackFrame lists.
 * The JS analogue of Python's `onelo.monitor._stacktrace`. Most-recent frame
 * is FIRST in JS stacks; we preserve JS order (opposite of Python) — the
 * backend groups on (type, frames[*].function) regardless of order.
 *
 * For EXCEPTION frames we read one line of the developer's own source (in-app
 * only) through a bounded linecache — parity with Python's `_stacktrace` — so
 * the dashboard can show `context_line`. Bundled / minified / serverless files
 * that aren't on disk are skipped gracefully.
 */
import { readFileSync } from 'node:fs'

import { scrubText } from './scrub'
import type { CapturedException, StackFrame } from './types'

// linecache-style source cache: filename → split lines (or null = unreadable).
// Bounded (drop-oldest) so a long-running process reading many files stays flat.
const SOURCE_CACHE = new Map<string, string[] | null>()
const SOURCE_CACHE_MAX = 200
const MAX_CONTEXT_LINE_LEN = 512

/** Read + cache one stripped source line (1-indexed). Best-effort — null on any miss. */
function readSourceLine(filename: string, lineno: number): string | null {
  if (lineno < 1) return null
  let lines = SOURCE_CACHE.get(filename)
  if (lines === undefined) {
    try {
      lines = readFileSync(filename, 'utf8').split('\n')
    } catch {
      lines = null // bundled / minified / serverless — no source on disk
    }
    if (SOURCE_CACHE.size >= SOURCE_CACHE_MAX) {
      const oldest = SOURCE_CACHE.keys().next().value
      if (oldest !== undefined) SOURCE_CACHE.delete(oldest)
    }
    SOURCE_CACHE.set(filename, lines)
  }
  if (!lines || lineno > lines.length) return null
  const raw = lines[lineno - 1]
  if (raw == null) return null
  const trimmed = raw.trim() // Python `.strip()` — indentation isn't diagnostic here
  if (!trimmed) return null
  return trimmed.length > MAX_CONTEXT_LINE_LEN
    ? trimmed.slice(0, MAX_CONTEXT_LINE_LEN) + '…'
    : trimmed
}

// "at func (file:line:col)"  OR  "at file:line:col"  OR  "at func (native)"
// func may carry "async ", "new ", "Object.", "<anonymous>" etc.
const AT_RE = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/
const AT_NO_LOC_RE = /^\s*at\s+(.+?)\s*$/

/** In-app = the developer's own code (not Node internals, not a dependency). */
function isInApp(filename: string | null): boolean {
  if (!filename) return true
  if (filename.startsWith('node:') || filename.startsWith('internal/')) return false
  if (filename.includes('/node_modules/') || filename.includes('\\node_modules\\')) return false
  return true
}

function moduleFor(filename: string | null): string | null {
  if (!filename) return null
  const base = filename.split(/[/\\]/).pop() ?? filename
  const dot = base.lastIndexOf('.')
  const name = dot > 0 ? base.slice(0, dot) : base
  return name || null
}

function normalizeFile(raw: string): string {
  // Strip a file:// URL scheme so filenames match the on-disk path.
  if (raw.startsWith('file://')) {
    try {
      return decodeURIComponent(new URL(raw).pathname)
    } catch {
      return raw
    }
  }
  return raw
}

function parseFrameLine(line: string, includeContext: boolean): StackFrame | null {
  const m = AT_RE.exec(line)
  if (m) {
    const fn = (m[1] ?? '').trim()
    const filename = normalizeFile(m[2]!)
    const lineno = Number(m[3])
    const inApp = isInApp(filename)
    const frame: StackFrame = {
      function: fn || null,
      module: moduleFor(filename),
      filename,
      lineno,
      colno: Number(m[4]),
      inApp,
    }
    // One source line for the developer's own (in-app) frames — only on
    // exceptions (includeContext), not informational current-stack captures.
    if (includeContext && inApp && filename && lineno) {
      const ctx = readSourceLine(filename, lineno)
      if (ctx) frame.contextLine = ctx
    }
    return frame
  }
  // "at <native>" / "at Object.<anonymous>" without a location.
  const m2 = AT_NO_LOC_RE.exec(line)
  if (m2) {
    const fn = m2[1]!.trim()
    return { function: fn || null, module: null, filename: null, lineno: null, colno: null, inApp: false }
  }
  return null
}

/** Parse a raw `error.stack` into ordered frames (most-recent first). */
export function parseStack(stack: string | undefined, includeContext = false): StackFrame[] {
  if (!stack) return []
  const frames: StackFrame[] = []
  for (const line of stack.split('\n')) {
    if (!/^\s*at\s/.test(line)) continue // skip the "Error: message" header line
    const frame = parseFrameLine(line, includeContext)
    if (frame) frames.push(frame)
  }
  return frames
}

/** Flatten an Error (and its `.cause` chain) into a CapturedException. */
export function captureExceptionInfo(err: unknown, depth = 0): CapturedException | null {
  if (err == null) return null
  // Non-Error throw (string, object) — best-effort envelope.
  if (!(err instanceof Error)) {
    return { type: typeof err === 'object' ? 'Object' : typeof err, message: String(err), frames: [] }
  }
  // Prefer a specific err.name (a custom `this.name` wins), but fall back to the
  // constructor name for a subclass that didn't set one — so `class MyError
  // extends Error {}` reports "MyError", matching Python's `type(exc).__name__`.
  let type = err.name
  const ctorName = err.constructor?.name
  if ((!type || type === 'Error') && ctorName && ctorName !== 'Error') type = ctorName
  type = type || 'Error'
  const frames = parseStack(err.stack, true)
  let cause: CapturedException | null = null
  // Bound the cause chain so a self-referential cause can't recurse forever.
  if (depth < 10 && 'cause' in err && (err as { cause?: unknown }).cause != null) {
    cause = captureExceptionInfo((err as { cause?: unknown }).cause, depth + 1)
  }
  return { type, message: err.message ?? '', frames, cause }
}

/** Capture the current call stack (no exception) — for captureMessage stacktraces. */
export function captureCurrentStack(skip = 1): StackFrame[] {
  const holder: { stack?: string } = {}
  Error.captureStackTrace?.(holder, captureCurrentStack)
  const frames = parseStack(holder.stack)
  return frames.slice(Math.max(0, skip - 1))
}

export function stackFrameToWire(frame: StackFrame): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (frame.function) out.function = frame.function
  if (frame.module) out.module = frame.module
  if (frame.filename) out.filename = frame.filename
  if (frame.lineno) out.lineno = frame.lineno
  if (frame.colno) out.colno = frame.colno
  out.in_app = frame.inApp
  if (frame.contextLine) out.context_line = scrubText(frame.contextLine) ?? frame.contextLine
  return out
}

export function capturedExceptionToWire(exc: CapturedException): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: exc.type,
    message: exc.message,
    frames: exc.frames.map(stackFrameToWire),
  }
  if (exc.cause) out.cause = capturedExceptionToWire(exc.cause)
  return out
}
