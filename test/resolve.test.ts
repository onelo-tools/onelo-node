import { describe, expect, it, vi } from 'vitest'
import { AuthHttpError, createResolver } from '../src/auth/resolve'
import { jsonFetch, publishableClient, secretClient, OK_USER } from './helpers'

async function statusOf(promise: Promise<unknown>): Promise<number> {
  const err = await promise.catch((e) => e)
  expect(err).toBeInstanceOf(AuthHttpError)
  return (err as AuthHttpError).status
}

describe('createResolver', () => {
  it('throws synchronously for a publishable-key client', () => {
    const { fetchImpl } = jsonFetch(200, OK_USER)
    expect(() => createResolver(publishableClient(fetchImpl))).toThrow(/publishable key/)
  })

  it('resolves a valid token to a user and emits auth.verify', async () => {
    const { fetchImpl } = jsonFetch(200, OK_USER)
    const events: Array<[string | null, string]> = []
    const { resolve } = createResolver(secretClient(fetchImpl), {
      onAuthEvent: (id, e) => events.push([id, e]),
    })
    const user = await resolve('Bearer tok', null)
    expect(user.id).toBe('user_1')
    expect(events).toContainEqual(['user_1', 'auth.verify'])
  })

  it('identifyMonitor bridge no-ops without a request scope, attaches with one', async () => {
    const { fetchImpl } = jsonFetch(200, OK_USER)
    const monitor = {
      users: [] as unknown[],
      scoped: false,
      setUser(u: unknown) {
        this.users.push(u)
      },
      hasActiveRequestScope() {
        return this.scoped
      },
    }
    const client = {
      apiUrl: 'https://api.test.onelo.tools',
      key: 'onelo_sk_test',
      isSecretKey: true,
      requestTimeout: 5000,
      fetchImpl,
      monitor,
    } as never
    const { resolve } = createResolver(client)
    // No per-request scope → bridge must NOT write the shared root scope.
    await resolve('Bearer tok-a', null)
    expect(monitor.users).toEqual([])
    // Inside a per-request scope → the verified user is attached.
    monitor.scoped = true
    await resolve('Bearer tok-b', null) // different token → cache miss → re-verify
    expect(monitor.users).toEqual([{ id: 'user_1' }])
  })

  it('missing token → 401 missing_token', async () => {
    const { fetchImpl } = jsonFetch(200, OK_USER)
    const { resolve } = createResolver(secretClient(fetchImpl))
    const err = await resolve(null, null).catch((e) => e)
    expect(err).toBeInstanceOf(AuthHttpError)
    expect(err.status).toBe(401)
    expect(err.body).toEqual({ error: 'missing_token' })
  })

  it('a non-bearer Authorization header does NOT fall through to ?token=', async () => {
    const { fetchImpl } = jsonFetch(200, OK_USER)
    const { resolve } = createResolver(secretClient(fetchImpl), { acceptQueryToken: true })
    // Header present but not bearer → missing_token, query ignored.
    expect(await statusOf(resolve('Basic xyz', 'querytok'))).toBe(401)
  })

  it('invalid token → 401', async () => {
    const { fetchImpl } = jsonFetch(401, { error: 'x' })
    const { resolve } = createResolver(secretClient(fetchImpl))
    expect(await statusOf(resolve('Bearer tok', null))).toBe(401)
  })

  it('backend 403 → 403', async () => {
    const { fetchImpl } = jsonFetch(403, { error: 'x' })
    const { resolve } = createResolver(secretClient(fetchImpl))
    expect(await statusOf(resolve('Bearer tok', null))).toBe(403)
  })

  it('backend 5xx → 503', async () => {
    const { fetchImpl } = jsonFetch(500, { error: 'x' })
    const { resolve } = createResolver(secretClient(fetchImpl), { retryAttempts: 1 })
    expect(await statusOf(resolve('Bearer tok', null))).toBe(503)
  })

  it('requireEmailVerified gate → 403', async () => {
    const { fetchImpl } = jsonFetch(200, { id: 'u', email: 'e@x.co', email_verified: false })
    const { resolve } = createResolver(secretClient(fetchImpl), { requireEmailVerified: true })
    const err = await resolve('Bearer tok', null).catch((e) => e)
    expect(err.status).toBe(403)
    expect(err.body.reason).toBe('email_unverified')
  })

  it('requirePlan gate → 403 when plan not allowed', async () => {
    const { fetchImpl } = jsonFetch(200, { id: 'u', email: 'e@x.co', plan: 'free' })
    const { resolve } = createResolver(secretClient(fetchImpl), { requirePlan: ['pro'] })
    const err = await resolve('Bearer tok', null).catch((e) => e)
    expect(err.status).toBe(403)
    expect(err.body.reason).toBe('plan')
  })

  it('requirePlan passes when the plan is allowed', async () => {
    const { fetchImpl } = jsonFetch(200, { id: 'u', email: 'e@x.co', plan: 'pro' })
    const { resolve } = createResolver(secretClient(fetchImpl), { requirePlan: ['pro', 'business'] })
    const user = await resolve('Bearer tok', null)
    expect(user.plan).toBe('pro')
  })

  it('caches the verification — second resolve does not hit the backend', async () => {
    const { fetchImpl, calls } = jsonFetch(200, OK_USER)
    const { resolve } = createResolver(secretClient(fetchImpl))
    await resolve('Bearer tok', null)
    await resolve('Bearer tok', null)
    expect(calls()).toBe(1)
  })

  it('accepts a ?token= when acceptQueryToken is on and no header is present', async () => {
    const { fetchImpl } = jsonFetch(200, OK_USER)
    const { resolve } = createResolver(secretClient(fetchImpl), { acceptQueryToken: true })
    const user = await resolve(null, 'query-token')
    expect(user.id).toBe('user_1')
  })

  it('ignores ?token= when acceptQueryToken is off', async () => {
    const { fetchImpl } = jsonFetch(200, OK_USER)
    const { resolve } = createResolver(secretClient(fetchImpl))
    expect(await statusOf(resolve(null, 'query-token'))).toBe(401)
  })

  it('a throwing onAuthEvent callback never breaks the request', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { fetchImpl } = jsonFetch(200, OK_USER)
    const { resolve } = createResolver(secretClient(fetchImpl), {
      onAuthEvent: () => {
        throw new Error('boom')
      },
    })
    const user = await resolve('Bearer tok', null)
    expect(user.id).toBe('user_1')
    warn.mockRestore()
  })
})
