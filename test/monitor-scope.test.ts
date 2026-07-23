import { describe, expect, it, vi } from 'vitest'
import { ScopeManager } from '../src/monitor/scope'
import { Breadcrumbs, makeEvent } from '../src/monitor/types'

describe('ScopeManager', () => {
  it('applies user/tags/breadcrumbs onto an event', () => {
    const sm = new ScopeManager()
    sm.getIsolationScope().setUser({ id: 'u1' })
    sm.getIsolationScope().setTag('area', 'checkout')
    sm.getIsolationScope().addBreadcrumb(Breadcrumbs.info('loaded'))
    const event = makeEvent({ featureName: 'x', ok: false })
    sm.applyScopesToEvent(event)
    expect(event.userId).toBe('u1')
    expect((event.meta.tags as Record<string, string>).area).toBe('checkout')
    expect((event.meta.breadcrumbs as unknown[]).length).toBe(1)
  })

  it('hasActiveIsolationScope is true only inside a runWithIsolationScope', () => {
    const sm = new ScopeManager()
    expect(sm.hasActiveIsolationScope()).toBe(false)
    sm.runWithIsolationScope(() => {
      expect(sm.hasActiveIsolationScope()).toBe(true)
    })
    expect(sm.hasActiveIsolationScope()).toBe(false)
  })

  it('does not override an explicit event.userId', () => {
    const sm = new ScopeManager()
    sm.getIsolationScope().setUser({ id: 'scope-user' })
    const event = makeEvent({ featureName: 'x', ok: true, userId: 'explicit' })
    sm.applyScopesToEvent(event)
    expect(event.userId).toBe('explicit')
  })

  it('isolates scopes across concurrent runs (no user bleed)', async () => {
    const sm = new ScopeManager()
    const seen: Record<string, string | null | undefined> = {}
    const run = (id: string) =>
      sm.runWithIsolationScope(async () => {
        sm.getIsolationScope().setUser({ id })
        await new Promise((r) => setTimeout(r, 5))
        const event = makeEvent({ featureName: 'x', ok: false })
        sm.applyScopesToEvent(event)
        seen[id] = event.userId
      })
    await Promise.all([run('A'), run('B'), run('C')])
    expect(seen).toEqual({ A: 'A', B: 'B', C: 'C' })
  })

  it('runIdentified attaches the user for the block only', () => {
    const sm = new ScopeManager()
    sm.runIdentified('req-user', () => {
      const event = makeEvent({ featureName: 'x', ok: false })
      sm.applyScopesToEvent(event)
      expect(event.userId).toBe('req-user')
    })
    // Outside the block, root isolation has no user.
    const outside = makeEvent({ featureName: 'x', ok: false })
    sm.applyScopesToEvent(outside)
    expect(outside.userId).toBeUndefined()
  })

  it('does not throw when a reserved meta key holds a non-object (guards + warns)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sm = new ScopeManager()
    sm.getIsolationScope().setTag('a', 'b')
    sm.getIsolationScope().addBreadcrumb(Breadcrumbs.info('x'))
    const event = makeEvent({
      featureName: 'x',
      ok: false,
      meta: { tags: 'oops', breadcrumbs: 'nope' },
    })
    expect(() => sm.applyScopesToEvent(event)).not.toThrow()
    // The caller's wrong-typed values are NOT clobbered.
    expect(event.meta.tags).toBe('oops')
    expect(event.meta.breadcrumbs).toBe('nope')
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('a forked isolation scope inherits tags but not breadcrumbs', () => {
    const sm = new ScopeManager()
    sm.getIsolationScope().setTag('inherited', 'yes')
    sm.getIsolationScope().addBreadcrumb(Breadcrumbs.info('root-crumb'))
    sm.runWithIsolationScope(() => {
      const event = makeEvent({ featureName: 'x', ok: false })
      sm.applyScopesToEvent(event)
      expect((event.meta.tags as Record<string, string>).inherited).toBe('yes')
      // breadcrumbs are NOT inherited (fresh buffer per request)
      expect(event.meta.breadcrumbs).toBeUndefined()
    })
  })
})
