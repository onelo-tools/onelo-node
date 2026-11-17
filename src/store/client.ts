/**
 * The Store module — `onelo.store.listPlans()` (#909).
 *
 * Reads the App's plan catalog from `GET /api/sdk/store/plans` so a backend
 * can show plan prices without copying them from the dashboard. Secret Key
 * only: the endpoint refuses a publishable key.
 */
import type { FetchLike } from '../auth/verify'
import { USER_AGENT } from '../features/consumer'

/** One active plan of the App, prices in minor units (e.g. 1900 = 19.00). */
export interface OneloPlan {
  /** The plan key — the same key as `OneloUser.plan` and feature plan rules. */
  plan: string | null
  name: string
  shortLabel: string | null
  mode: 'subscription' | 'one_time'
  currency: string
  priceAmount: number
  annualPriceAmount: number | null
  trialPeriodDays: number | null
  isActive: boolean
  sortOrder: number
  /** `'exclusive'`: `priceAmount` is a net price and VAT is added on top. */
  taxBehavior: 'inclusive' | 'exclusive' | null
  /** What a consumer is shown and charged — the price with VAT at the standard
   *  rate of `displayTaxCountry` when the price is net; the price itself when
   *  it already includes VAT. Show this one to buyers. */
  displayPriceAmount: number | null
  displayAnnualPriceAmount: number | null
  /** Country whose VAT `displayPriceAmount` uses (the `country` you passed when
   *  the seller charges the buyer's own rate, else the seller's home country). */
  displayTaxCountry: string | null
}

export interface ListPlansOptions {
  /** Buyer country, ISO 3166-1 alpha-2 (e.g. 'DE'), for the display prices. */
  country?: string
}

/** A non-2xx answer or network failure from the Store endpoint. */
export class OneloStoreError extends Error {
  /** HTTP status, or `null` for a network error. */
  readonly status: number | null
  constructor(message: string, status: number | null) {
    super(message)
    this.name = 'OneloStoreError'
    this.status = status
  }
}

export interface StoreClientOptions {
  apiUrl: string
  key: string
  isSecretKey: boolean
  requestTimeout: number
  fetchImpl?: FetchLike
}

export class StoreClient {
  constructor(private readonly opts: StoreClientOptions) {}

  /** The App's active plans, ordered by sort order. Requires the Secret Key. */
  async listPlans(options: ListPlansOptions = {}): Promise<OneloPlan[]> {
    if (!this.opts.isSecretKey) {
      throw new Error('onelo.store.listPlans() requires the Secret Key — call it from your server.')
    }
    const doFetch: FetchLike | undefined =
      this.opts.fetchImpl ?? (typeof fetch === 'function' ? (fetch as FetchLike) : undefined)
    if (!doFetch) throw new OneloStoreError('global fetch is unavailable — Node 18+ is required.', null)
    let res: Response
    try {
      const query = options.country ? `?country=${encodeURIComponent(options.country)}` : ''
      res = await doFetch(`${this.opts.apiUrl}/api/sdk/store/plans${query}`, {
        method: 'GET',
        headers: { 'X-Onelo-Secret-Key': this.opts.key, 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(this.opts.requestTimeout),
      })
    } catch (exc) {
      throw new OneloStoreError(`network error: ${String(exc)}`, null)
    }
    if (!res.ok) {
      let detail = ''
      try {
        detail = String(((await res.json()) as { detail?: unknown }).detail ?? '')
      } catch {
        // Body was not JSON; the status alone names the failure.
      }
      throw new OneloStoreError(`store/plans failed: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`, res.status)
    }
    const body = (await res.json()) as { plans?: Array<Record<string, unknown>> }
    return (body.plans ?? []).map(toPlan)
  }
}

function toPlan(p: Record<string, unknown>): OneloPlan {
  return {
    plan: (p.plan as string | null) ?? null,
    name: p.name as string,
    shortLabel: (p.short_label as string | null) ?? null,
    mode: p.mode as OneloPlan['mode'],
    currency: p.currency as string,
    priceAmount: p.price_amount as number,
    annualPriceAmount: (p.annual_price_amount as number | null) ?? null,
    trialPeriodDays: (p.trial_period_days as number | null) ?? null,
    isActive: Boolean(p.is_active),
    sortOrder: p.sort_order as number,
    taxBehavior: (p.tax_behavior as OneloPlan['taxBehavior'] | undefined) ?? null,
    displayPriceAmount: (p.display_price_amount as number | null | undefined) ?? null,
    displayAnnualPriceAmount: (p.display_annual_price_amount as number | null | undefined) ?? null,
    displayTaxCountry: (p.display_tax_country as string | null | undefined) ?? null,
  }
}
