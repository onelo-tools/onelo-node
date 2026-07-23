/**
 * Propagate monitor scope across a process / queue boundary. A background job
 * (BullMQ, SQS, a `worker_threads` RPC) runs outside the request that scheduled
 * it, so the user / tags / breadcrumbs on that request's scope never reach the
 * worker — `AsyncLocalStorage` does not cross a process/queue boundary. The
 * producer calls {@link MonitorClient.carrier} and attaches the result to the
 * job; the worker wraps its body in {@link MonitorClient.continueTrace}.
 *
 * 1:1 with Python's `onelo.monitor._propagation` (carrier / continue_trace):
 *   - Privacy: only `user.id` is forwarded (never email / metadata — the carrier
 *     lands in the broker payload, possibly persisted). Tags / contexts /
 *     transaction / breadcrumbs run through the same PII scrubber as the wire.
 *   - Integrity: pass a shared `key` (your publishable key — producer and worker
 *     both have it) to HMAC-SHA256-sign the carrier so a different tenant on the
 *     same broker can't forge a `user.id`. Without a key the carrier is unsigned
 *     and accepted best-effort (single-tenant back-compat).
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

import type { Scope } from './scope'
import { scrubMeta, scrubText } from './scrub'
import type { Breadcrumb } from './types'

const HMAC_PAYLOAD_KEY = '_data'
const HMAC_SIG_KEY = '_sig'

// eslint-disable-next-line no-console
const warn = (...args: unknown[]) => console.warn('[onelo.monitor]', ...args)

export interface CarrierOptions {
  /** Also forward breadcrumbs (off by default — they bloat every queue message). */
  includeBreadcrumbs?: boolean
  /** Shared secret (your publishable key) — HMAC-signs the carrier so the worker can verify integrity. */
  key?: string
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Serialise a scope into a JSON-safe carrier (optionally HMAC-signed). */
export function buildCarrier(
  scope: Scope,
  includeBreadcrumbs: boolean,
  key?: string,
): Record<string, unknown> {
  // 32 hex chars — same shape as Python's uuid4().hex — for dashboard correlation.
  const out: Record<string, unknown> = { trace_id: randomUUID().replace(/-/g, '') }

  if (scope.user) {
    // Whitelist: id ONLY. Email / metadata stay on-host.
    const uid = scope.user.id
    if (uid != null) out.user = { id: String(uid) }
  }
  if (Object.keys(scope.tags).length > 0) {
    const scrubbed = scrubMeta({ ...scope.tags })
    if (scrubbed && Object.keys(scrubbed).length > 0) out.tags = scrubbed
  }
  if (Object.keys(scope.contexts).length > 0) {
    const scrubbed = scrubMeta(
      Object.fromEntries(Object.entries(scope.contexts).map(([k, v]) => [k, { ...v }])),
    )
    if (scrubbed && Object.keys(scrubbed).length > 0) out.contexts = scrubbed
  }
  if (scope.transaction) {
    const cleaned = scrubText(scope.transaction)
    if (cleaned) out.transaction = cleaned
  }
  if (includeBreadcrumbs && scope.breadcrumbs.length > 0) {
    // Breadcrumb urls/values already scrub at construction; re-scrub the
    // serialised list before it leaves the process (defense in depth).
    const scrubbed = scrubMeta({ _: scope.breadcrumbs.toWire() })
    if (scrubbed && Array.isArray(scrubbed._)) out.breadcrumbs = scrubbed._
  }

  if (key) {
    return { [HMAC_PAYLOAD_KEY]: out, [HMAC_SIG_KEY]: sign(out, key) }
  }
  return out
}

/**
 * Return the trusted carrier payload, or null if rejected. Acceptance rules
 * mirror Python's `_unwrap_carrier`:
 *   - null carrier                          → null (legacy job)
 *   - no key                                → trust as-is (unless it LOOKS signed
 *                                             → reject: can't verify a signed one)
 *   - key + unsigned carrier                → reject (producer must sign)
 *   - key + signed + HMAC matches           → unwrap and trust
 *   - key + signed + HMAC mismatch          → reject
 */
export function unwrapCarrier(
  data: Record<string, unknown> | null | undefined,
  key?: string,
): Record<string, unknown> | null {
  if (data == null) return null
  const looksSigned = HMAC_SIG_KEY in data && HMAC_PAYLOAD_KEY in data

  if (!key) {
    if (looksSigned) {
      warn('continueTrace received a signed carrier but no key was supplied to verify it; rejecting')
      return null
    }
    return data
  }
  if (!looksSigned) {
    warn('continueTrace was given a key but the carrier is not signed; rejecting (producer must pass { key })')
    return null
  }
  const verified = verify(data, key)
  if (verified === null) warn('continueTrace HMAC verification failed; rejecting')
  return verified
}

/**
 * Apply a trusted carrier payload onto a scope. Mirrors Python's `_apply_carrier`.
 */
export function applyCarrier(scope: Scope, data: Record<string, unknown>): void {
  if (isObject(data.user)) scope.setUser(data.user)
  if (isObject(data.tags)) {
    for (const [k, v] of Object.entries(data.tags)) {
      if (v == null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        scope.setTag(k, String(v))
      }
    }
  }
  if (isObject(data.contexts)) {
    for (const [k, v] of Object.entries(data.contexts)) {
      if (isObject(v)) scope.setContext(k, v)
    }
  }
  if (typeof data.transaction === 'string') scope.setTransaction(data.transaction)
  if (typeof data.trace_id === 'string') scope.setTag('trace_id', data.trace_id)
  if (Array.isArray(data.breadcrumbs)) {
    for (const c of data.breadcrumbs) {
      if (!isObject(c)) continue
      const crumb: Breadcrumb = {
        category: (c.category ?? 'info') as Breadcrumb['category'],
        message: String(c.message ?? ''),
        timestamp: Number(c.ts ?? 0),
        level: (c.level ?? 'info') as Breadcrumb['level'],
        data: isObject(c.data) ? c.data : undefined,
      }
      scope.addBreadcrumb(crumb)
    }
  }
}

// ─── HMAC for cross-process carrier integrity ──────────────────────────────

function sign(data: Record<string, unknown>, key: string): string {
  return createHmac('sha256', key).update(canonical(data)).digest('hex')
}

function verify(envelope: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const data = envelope[HMAC_PAYLOAD_KEY]
  const sig = envelope[HMAC_SIG_KEY]
  if (!isObject(data) || typeof sig !== 'string') return null
  const expected = Buffer.from(sign(data, key))
  const actual = Buffer.from(sig)
  // timingSafeEqual throws on length mismatch — guard first.
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null
  return data
}

/**
 * Canonical JSON — recursively key-sorted, compact — so sign and verify agree
 * byte-for-byte. Mirrors Python's `json.dumps(sort_keys=True, separators=(",",":"))`;
 * the guaranteed case is Node→Node (a Node app's queue worker is Node), so this
 * is deterministic per-language rather than a cross-language byte contract.
 */
function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (isObject(value)) {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k])
    return out
  }
  return value
}
