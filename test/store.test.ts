import { describe, it, expect } from 'vitest'
import { Onelo } from '../src/client'
import { OneloStoreError } from '../src/store/client'
import type { FetchLike } from '../src/auth/verify'

const SK = 'onelo_sk_live_abc123'
const PK = 'onelo_pk_live_abc123'

function recording(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} })
    return new Response(JSON.stringify(body), { status })
  }
  return { fetchImpl, calls }
}

describe('onelo.store.listPlans()', () => {
  it('GETs /api/sdk/store/plans with the secret key and maps plans', async () => {
    const { fetchImpl, calls } = recording(200, {
      plans: [{
        plan: 'pro', name: 'Pro', short_label: null, mode: 'subscription', currency: 'eur',
        price_amount: 1900, annual_price_amount: 19000, trial_period_days: 14,
        is_active: true, sort_order: 2,
      }],
    })
    const onelo = new Onelo({ secretKey: SK, apiUrl: 'https://api.example.test', fetchImpl })
    const plans = await onelo.store.listPlans()
    expect(plans).toEqual([{
      plan: 'pro', name: 'Pro', shortLabel: null, mode: 'subscription', currency: 'eur',
      priceAmount: 1900, annualPriceAmount: 19000, trialPeriodDays: 14,
      isActive: true, sortOrder: 2,
    }])
    expect(calls[0]!.url).toBe('https://api.example.test/api/sdk/store/plans')
    expect((calls[0]!.init.headers as Record<string, string>)['X-Onelo-Secret-Key']).toBe(SK)
  })

  it('refuses a publishable key before any request', async () => {
    const { fetchImpl, calls } = recording(200, { plans: [] })
    const onelo = new Onelo({ publishableKey: PK, apiUrl: 'https://api.example.test', fetchImpl })
    await expect(onelo.store.listPlans()).rejects.toThrow(/Secret Key/)
    expect(calls).toHaveLength(0)
  })

  it('raises OneloStoreError with the status on a refusal', async () => {
    const { fetchImpl } = recording(403, { detail: 'nope' })
    const onelo = new Onelo({ secretKey: SK, apiUrl: 'https://api.example.test', fetchImpl })
    const err = await onelo.store.listPlans().catch((e) => e)
    expect(err).toBeInstanceOf(OneloStoreError)
    expect(err.status).toBe(403)
  })
})
