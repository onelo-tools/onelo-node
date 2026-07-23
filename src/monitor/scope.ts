/**
 * Three-scope state model — global / isolation / current. 1:1 with Python's
 * `onelo.monitor._scope`, using `AsyncLocalStorage` where Python uses
 * `contextvars` (both propagate across async continuations; ALS is the Node
 * equivalent of PEP 567).
 *
 *   global     — one per process (release, environment, server_name)
 *   isolation  — one per request (user, breadcrumbs, tags isolated per request)
 *   current    — innermost newScope() block
 *
 * On capture the three merge in order global ⊕ isolation ⊕ current; later scopes
 * override scalars, breadcrumbs concatenate.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

import { BreadcrumbBuffer, DEFAULT_CAPACITY } from './breadcrumbs'
import type { Breadcrumb, EventLevel, MonitorEvent } from './types'

export class Scope {
  user: Record<string, unknown> | null = null
  tags: Record<string, string> = {}
  contexts: Record<string, Record<string, unknown>> = {}
  extra: Record<string, unknown> = {}
  level: EventLevel | null = null
  transaction: string | null = null
  breadcrumbs: BreadcrumbBuffer

  constructor(breadcrumbCapacity = DEFAULT_CAPACITY) {
    this.breadcrumbs = new BreadcrumbBuffer(breadcrumbCapacity)
  }

  setUser(user: Record<string, unknown> | null): void {
    this.user = user ? { ...user } : null
  }
  setTag(key: string, value: string): void {
    this.tags[key] = value
  }
  setContext(key: string, value: Record<string, unknown>): void {
    this.contexts[key] = { ...value }
  }
  setExtra(key: string, value: unknown): void {
    this.extra[key] = value
  }
  setLevel(level: EventLevel): void {
    this.level = level
  }
  setTransaction(name: string | null): void {
    this.transaction = name
  }
  addBreadcrumb(crumb: Breadcrumb): void {
    this.breadcrumbs.add(crumb)
  }

  /** Shallow-copy inheriting user/tags/contexts but a FRESH breadcrumb buffer. */
  clone(): Scope {
    const next = new Scope(this.breadcrumbs.capacity)
    next.user = this.user ? { ...this.user } : null
    next.tags = { ...this.tags }
    next.contexts = Object.fromEntries(Object.entries(this.contexts).map(([k, v]) => [k, { ...v }]))
    next.extra = { ...this.extra }
    next.level = this.level
    next.transaction = this.transaction
    return next
  }

  /** Layer this scope's data onto an outgoing event. */
  applyTo(event: MonitorEvent): void {
    if (this.user && event.userId == null) {
      const uid = this.user.id
      // `!= null` not truthiness: 0 / "" / false are valid opaque ids.
      if (uid != null) event.userId = String(uid)
    }
    if (Object.keys(this.tags).length > 0) {
      const tags = ensureObjectBucket(event.meta, 'tags')
      if (tags) Object.assign(tags, this.tags)
    }
    if (Object.keys(this.contexts).length > 0) {
      const ctx = ensureObjectBucket(event.meta, 'contexts')
      if (ctx) for (const [k, v] of Object.entries(this.contexts)) ctx[k] = { ...v }
    }
    if (Object.keys(this.extra).length > 0) {
      const extra = ensureObjectBucket(event.meta, 'extra')
      if (extra) Object.assign(extra, this.extra)
    }
    if (this.transaction && !('transaction' in event.meta)) {
      event.meta.transaction = this.transaction
    }
    if (this.breadcrumbs.length > 0) {
      const existing = ensureArrayBucket(event.meta, 'breadcrumbs')
      if (existing) existing.push(...this.breadcrumbs.toWire())
    }
  }
}

// eslint-disable-next-line no-console
const warn = (...args: unknown[]) => console.warn('[onelo.monitor]', ...args)

/**
 * Return `meta[key]` as a plain object, creating it if absent. If the caller
 * already put a NON-object there (e.g. `meta: { tags: 'oops' }`), skip merging
 * (return null) instead of throwing / clobbering — and log it (no silent swallow).
 */
function ensureObjectBucket(
  meta: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const existing = meta[key]
  if (existing === undefined) {
    const fresh: Record<string, unknown> = {}
    meta[key] = fresh
    return fresh
  }
  if (existing !== null && typeof existing === 'object' && !Array.isArray(existing)) {
    return existing as Record<string, unknown>
  }
  warn(`scope: meta.${key} is not an object (${typeof existing}); skipping scope merge for it`)
  return null
}

function ensureArrayBucket(
  meta: Record<string, unknown>,
  key: string,
): Array<Record<string, unknown>> | null {
  const existing = meta[key]
  if (existing === undefined) {
    const fresh: Array<Record<string, unknown>> = []
    meta[key] = fresh
    return fresh
  }
  if (Array.isArray(existing)) return existing as Array<Record<string, unknown>>
  warn(`scope: meta.${key} is not an array (${typeof existing}); skipping breadcrumb merge`)
  return null
}

interface ScopeStore {
  isolation: Scope
  current?: Scope
}

/**
 * Owns the three scope layers. One instance per MonitorClient (not module
 * globals) — cleaner for Node and avoids cross-client bleed.
 */
export class ScopeManager {
  private globalScope = new Scope()
  private rootIsolation: Scope | null = null
  private readonly als = new AsyncLocalStorage<ScopeStore>()

  getGlobalScope(): Scope {
    return this.globalScope
  }

  /**
   * Active isolation scope. Inside a `runWithIsolationScope` it's the forked
   * per-request scope; outside (CLI / startup) it's a lazily-cloned process
   * root — so setUser/breadcrumbs from a script still behave.
   */
  getIsolationScope(): Scope {
    const store = this.als.getStore()
    if (store) return store.isolation
    if (!this.rootIsolation) this.rootIsolation = this.globalScope.clone()
    return this.rootIsolation
  }

  /** True only inside a `runWithIsolationScope` (a per-request fork is active). */
  hasActiveIsolationScope(): boolean {
    return this.als.getStore() !== undefined
  }

  getCurrentScope(): Scope {
    const store = this.als.getStore()
    if (store?.current) return store.current
    return this.getIsolationScope()
  }

  /** Fork a fresh isolation scope for the duration of `fn` (per-request). */
  runWithIsolationScope<T>(fn: () => T): T {
    const parent = this.getIsolationScope()
    const forked = parent.clone()
    return this.als.run({ isolation: forked }, fn)
  }

  /**
   * Fork a fresh isolation scope FROM THE GLOBAL scope (not the ambient one) and
   * run `fn` inside it. `continueTrace` uses this so a restored queue-job scope
   * never inherits an ambient request's user/tags — mirrors Python
   * `continue_trace` forking from `get_global_scope()`.
   */
  runWithGlobalIsolationScope<T>(fn: () => T): T {
    const forked = this.globalScope.clone()
    return this.als.run({ isolation: forked }, fn)
  }

  /** Fork an isolation scope and attach `userId` — for WS handlers / jobs. */
  runIdentified<T>(userId: string | null | undefined, fn: () => T): T {
    return this.runWithIsolationScope(() => {
      if (userId != null) this.getIsolationScope().setUser({ id: String(userId) })
      return fn()
    })
  }

  /** Push a temporary current scope (transaction-style nesting). */
  runWithNewScope<T>(fn: () => T): T {
    const store = this.als.getStore()
    const isolation = store?.isolation ?? this.getIsolationScope()
    const forked = (store?.current ?? isolation).clone()
    return this.als.run({ isolation, current: forked }, fn)
  }

  /** Layer global, isolation, current onto the event in that order. */
  applyScopesToEvent(event: MonitorEvent): void {
    this.globalScope.applyTo(event)
    const store = this.als.getStore()
    const iso = store?.isolation ?? this.rootIsolation
    if (iso) iso.applyTo(event)
    if (store?.current && store.current !== iso) store.current.applyTo(event)
  }
}
