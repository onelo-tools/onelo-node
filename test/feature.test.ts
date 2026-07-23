import { describe, expect, it } from 'vitest'
import { Feature, UserFeatures } from '../src/features/feature'

describe('Feature.fromWire', () => {
  it('maps enabled/new/beta to isEnabled + isVisible', () => {
    for (const status of ['enabled', 'new', 'beta']) {
      const f = Feature.fromWire('x', { status })
      expect(f.isEnabled).toBe(true)
      expect(f.isVisible).toBe(true)
      expect(f.isKnown).toBe(true)
    }
  })

  it('coming_soon/greyed/upsell are visible but not enabled', () => {
    for (const status of ['coming_soon', 'greyed', 'upsell']) {
      const f = Feature.fromWire('x', { status })
      expect(f.isEnabled).toBe(false)
      expect(f.isVisible).toBe(true)
    }
  })

  it('hidden is neither enabled nor visible but is known', () => {
    const f = Feature.fromWire('x', { status: 'hidden' })
    expect(f.isEnabled).toBe(false)
    expect(f.isVisible).toBe(false)
    expect(f.isKnown).toBe(true)
  })

  it('an unknown/newer status is fail-closed (not visible, not known)', () => {
    const f = Feature.fromWire('x', { status: 'quantum' })
    expect(f.isVisible).toBe(false)
    expect(f.isEnabled).toBe(false)
    expect(f.isKnown).toBe(false)
  })

  it('surfaces upsell metadata + upgradeHint', () => {
    const f = Feature.fromWire('x', {
      status: 'upsell',
      reason: 'plan',
      required_plan: 'pro',
      required_plan_label: 'Pro',
      upgrade_cta: true,
    })
    expect(f.isUpsell).toBe(true)
    expect(f.requiredPlan).toBe('pro')
    expect(f.upgradeHint).toBe('Pro')
    expect(f.upgradeCta).toBe(true)
  })

  it('upgradeHint is null without a label', () => {
    const f = Feature.fromWire('x', { status: 'upsell', required_plan: 'pro' })
    expect(f.upgradeHint).toBeNull()
  })

  it('tolerates a bare status string', () => {
    const f = Feature.fromWire('x', 'enabled')
    expect(f.status).toBe('enabled')
    expect(f.isEnabled).toBe(true)
  })

  it('missing status → hidden (fail-closed)', () => {
    const f = Feature.fromWire('x', {})
    expect(f.status).toBe('hidden')
  })
})

describe('UserFeatures', () => {
  it('resolves per-user state and defaults missing to hidden', () => {
    const uf = new UserFeatures('u1', { a: { status: 'enabled' } })
    expect(uf.feature('a').isEnabled).toBe(true)
    expect(uf.isEnabled('a')).toBe(true)
    expect(uf.feature('missing').status).toBe('hidden')
    expect(uf.userId).toBe('u1')
  })
})
