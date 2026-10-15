/**
 * #800: the server assertion. A server with no issuer tokens (classic server
 * sessions) tells Onelo who its user is with an identity-only key, and gets
 * back an ordinary Onelo session for that External Identity.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertIdentity,
  OneloAuthError,
  OneloAuthForbidden,
  OneloAuthInvalidToken,
  OneloAuthRateLimited,
  OneloAuthUnavailable,
  OneloUser,
} from '../src/index'

const KEY = 'onelo_ik_live_secretvalue123'
const API = 'https://api.example.test/'

function reply(status: number, body: unknown, headers: Record<string, string> = {}) {
  return vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } }),
  )
}

const OK = {
  session: { access_token: 'onelo.session.token', token_type: 'bearer', expires_in: 1800 },
  user: { id: 'u_1', email: 'ada@example.com', email_verified: true },
}

const refused = (code: string) => ({ detail: { error: code, message: 'no' } })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('assertIdentity — the request', () => {
  it('posts the key and the identity to /api/sdk/auth/assert', async () => {
    const fetchImpl = reply(200, OK)
    await assertIdentity({
      apiUrl: API, identityKey: KEY, externalId: 'user-42',
      email: 'ada@example.com', emailVerified: true, fetchImpl,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://api.example.test/api/sdk/auth/assert')
    expect(init!.method).toBe('POST')
    expect((init!.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(JSON.parse(init!.body as string)).toEqual({
      identityKey: KEY, externalId: 'user-42', email: 'ada@example.com', emailVerified: true,
    })
  })

  it('sends emailVerified false and no email when the server gives none', async () => {
    const fetchImpl = reply(200, OK)
    await assertIdentity({ apiUrl: API, identityKey: KEY, externalId: 'user-42', fetchImpl })
    expect(JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string)).toEqual({
      identityKey: KEY, externalId: 'user-42', emailVerified: false,
    })
  })

  it.each([
    [{ apiUrl: '', identityKey: KEY, externalId: 'x' }, /apiUrl/],
    [{ apiUrl: 'ftp://x', identityKey: KEY, externalId: 'x' }, /apiUrl/],
    [{ apiUrl: API, identityKey: '', externalId: 'x' }, /identityKey/],
    [{ apiUrl: API, identityKey: 'onelo_sk_live_abc', externalId: 'x' }, /identity key/],
    [{ apiUrl: API, identityKey: KEY, externalId: '' }, /externalId/],
  ])('refuses a bad configuration before any request (%#)', async (opts, message) => {
    const fetchImpl = reply(200, OK)
    await expect(assertIdentity({ ...opts, fetchImpl })).rejects.toThrow(message)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('assertIdentity — the answer', () => {
  it('returns the App User and the minted session', async () => {
    const answer = await assertIdentity({ apiUrl: API, identityKey: KEY, externalId: 'user-42', fetchImpl: reply(200, OK) })
    expect(answer.user).toBeInstanceOf(OneloUser)
    expect(answer.user.id).toBe('u_1')
    expect(answer.user.email).toBe('ada@example.com')
    expect(answer.session).toEqual({ accessToken: 'onelo.session.token', expiresIn: 1800 })
  })

  it('treats a 200 without a session as an outage', async () => {
    const run = assertIdentity({ apiUrl: API, identityKey: KEY, externalId: 'x', fetchImpl: reply(200, { user: OK.user }) })
    await expect(run).rejects.toBeInstanceOf(OneloAuthUnavailable)
  })

  it.each([
    [401, 'invalid_identity_key', OneloAuthInvalidToken],
    [403, 'ip_not_allowed', OneloAuthForbidden],
    [403, 'banned', OneloAuthForbidden],
    [403, 'sign_in_mode_onelo', OneloAuthForbidden],
    [409, 'email_in_use', OneloAuthForbidden],
    [503, 'unavailable', OneloAuthUnavailable],
  ])('maps %s %s to the typed error carrying the code', async (status, code, type) => {
    const run = assertIdentity({ apiUrl: API, identityKey: KEY, externalId: 'x', fetchImpl: reply(status, refused(code)) })
    await expect(run).rejects.toBeInstanceOf(type)
    await expect(
      assertIdentity({ apiUrl: API, identityKey: KEY, externalId: 'x', fetchImpl: reply(status, refused(code)) }),
    ).rejects.toMatchObject({ code })
  })

  it('maps 400 to a refusal of the request, not an outage', async () => {
    const run = assertIdentity({ apiUrl: API, identityKey: KEY, externalId: 'x', fetchImpl: reply(400, refused('invalid_email')) })
    await expect(run).rejects.toMatchObject({ code: 'invalid_email' })
    await expect(
      assertIdentity({ apiUrl: API, identityKey: KEY, externalId: 'x', fetchImpl: reply(400, refused('invalid_email')) }),
    ).rejects.not.toBeInstanceOf(OneloAuthUnavailable)
  })

  it('maps 429 to a rate limit with Retry-After', async () => {
    const run = assertIdentity({
      apiUrl: API, identityKey: KEY, externalId: 'x',
      fetchImpl: reply(429, refused('rate_limited'), { 'Retry-After': '30' }),
    })
    await expect(run).rejects.toMatchObject({ code: 'rate_limited', retryAfter: 30 })
    await expect(run).rejects.toBeInstanceOf(OneloAuthRateLimited)
  })

  it('treats a backend without the endpoint as unavailable', async () => {
    const run = assertIdentity({ apiUrl: API, identityKey: KEY, externalId: 'x', fetchImpl: reply(404, { detail: 'Not Found' }) })
    await expect(run).rejects.toBeInstanceOf(OneloAuthUnavailable)
  })

  it('wraps a network failure and never puts the key in the message', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error(`boom ${KEY}`) })
    const err = await assertIdentity({ apiUrl: API, identityKey: KEY, externalId: 'x', fetchImpl }).catch((e) => e)
    expect(err).toBeInstanceOf(OneloAuthUnavailable)
    expect(String(err.message)).not.toContain(KEY)
  })
})

describe('assertIdentity — refuses browser use', () => {
  it('throws before any request when running in a browser', async () => {
    vi.stubGlobal('window', {})
    vi.stubGlobal('document', {})
    const fetchImpl = reply(200, OK)
    const err = await assertIdentity({ apiUrl: API, identityKey: KEY, externalId: 'x', fetchImpl }).catch((e) => e)
    expect(err).toBeInstanceOf(OneloAuthError)
    expect(err.code).toBe('browser_not_allowed')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
