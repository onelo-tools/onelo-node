import { describe, expect, it } from 'vitest'
import { FeatureCache } from '../src/features/cache'

describe('FeatureCache', () => {
  it('returns hidden on miss (fail-closed)', () => {
    const c = new FeatureCache()
    expect(c.getState('x')).toEqual({ status: 'hidden' })
    expect(c.get('x')).toBe('hidden')
  })

  it('stores full wire state dicts and returns defensive copies', () => {
    const c = new FeatureCache()
    c.replaceAll({ exp: { status: 'upsell', required_plan_label: 'Pro' } }, 3)
    const s = c.getState('exp')
    expect(s).toEqual({ status: 'upsell', required_plan_label: 'Pro' })
    s.status = 'mutated'
    expect(c.get('exp')).toBe('upsell') // copy — internal state untouched
    expect(c.configVersion).toBe(3)
  })

  it('normalizes a bare status string to a state dict', () => {
    const c = new FeatureCache()
    c.replaceAll({ a: 'enabled' }, 1)
    expect(c.getState('a')).toEqual({ status: 'enabled' })
    expect(c.get('a')).toBe('enabled')
  })

  it('replaceAll swaps the whole snapshot atomically', () => {
    const c = new FeatureCache()
    c.replaceAll({ a: 'enabled' }, 1)
    c.replaceAll({ b: 'greyed' }, 2)
    expect(c.get('a')).toBe('hidden') // gone
    expect(c.get('b')).toBe('greyed')
    expect(c.configVersion).toBe(2)
  })

  it('snapshot() returns status-only map', () => {
    const c = new FeatureCache()
    c.replaceAll({ a: { status: 'enabled', reason: 'x' }, b: 'greyed' }, 1)
    expect(c.snapshot()).toEqual({ a: 'enabled', b: 'greyed' })
  })

  it('tolerates a non-finite version', () => {
    const c = new FeatureCache()
    c.replaceAll({ a: 'enabled' }, Number.NaN)
    expect(c.configVersion).toBe(0)
  })
})
