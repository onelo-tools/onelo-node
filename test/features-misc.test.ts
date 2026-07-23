import { describe, expect, it } from 'vitest'
import { resolveStrategy } from '../src/features/detection'
import { UserSnapshotCache } from '../src/features/user-snapshot-cache'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('resolveStrategy', () => {
  it('maps auto → sse', () => {
    expect(resolveStrategy('auto')).toBe('sse')
  })
  it('passes sse/polling through', () => {
    expect(resolveStrategy('sse')).toBe('sse')
    expect(resolveStrategy('polling')).toBe('polling')
  })
  it('rejects deferred redis with a clear message', () => {
    expect(() => resolveStrategy('redis')).toThrow(/not supported in v1/)
  })
  it('rejects an invalid strategy', () => {
    expect(() => resolveStrategy('bogus')).toThrow(/strategy must be one of/)
  })
})

describe('UserSnapshotCache', () => {
  it('stores and retrieves a snapshot', () => {
    const c = new UserSnapshotCache()
    c.put('u1', { a: { status: 'enabled' } }, 30)
    expect(c.get('u1')).toEqual({ a: { status: 'enabled' } })
  })

  it('expires and lazily prunes an entry', async () => {
    const c = new UserSnapshotCache()
    c.put('u1', { a: { status: 'enabled' } }, 0.01) // 10ms
    await sleep(25)
    expect(c.get('u1')).toBeNull()
  })

  it('evicts soonest-to-expire over the cap', () => {
    const c = new UserSnapshotCache(2)
    c.put('u1', {}, 100)
    c.put('u2', {}, 200)
    c.put('u3', {}, 300) // over cap → evicts u1 (soonest)
    expect(c.get('u1')).toBeNull()
    expect(c.get('u2')).not.toBeNull()
    expect(c.get('u3')).not.toBeNull()
  })

  it('invalidate and clear', () => {
    const c = new UserSnapshotCache()
    c.put('u1', {}, 30)
    c.put('u2', {}, 30)
    c.invalidate('u1')
    expect(c.get('u1')).toBeNull()
    expect(c.get('u2')).not.toBeNull()
    c.clear()
    expect(c.get('u2')).toBeNull()
  })
})
