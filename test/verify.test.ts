import { describe, expect, it } from 'vitest'
import {
  extractBearerToken,
  parseRetryAfter,
  verifyToken,
  verifyWithRetry,
} from '../src/auth/verify'
import {
  OneloAuthError,
  OneloAuthForbidden,
  OneloAuthInvalidToken,
  OneloAuthMissingToken,
  OneloAuthRateLimited,
  OneloAuthUnavailable,
} from '../src/auth/errors'
import {
  OK_USER,
  jsonFetch,
  publishableClient,
  secretClient,
  sequenceFetch,
  throwingFetch,
} from './helpers'

describe('extractBearerToken', () => {
  it('extracts a bearer token, case-insensitively', () => {
    expect(extractBearerToken('Bearer abc')).toBe('abc')
    expect(extractBearerToken('bearer abc')).toBe('abc')
    expect(extractBearerToken('BEARER   abc  ')).toBe('abc')
  })
  it('returns null for missing / non-bearer / empty', () => {
    expect(extractBearerToken(null)).toBeNull()
    expect(extractBearerToken('')).toBeNull()
    expect(extractBearerToken('Basic xyz')).toBeNull()
    expect(extractBearerToken('Bearer ')).toBeNull()
  })
})

describe('parseRetryAfter', () => {
  it('parses seconds, rejects invalid/negative', () => {
    expect(parseRetryAfter('30')).toBe(30)
    expect(parseRetryAfter(' 5 ')).toBe(5)
    expect(parseRetryAfter('2.5')).toBe(2.5)
    expect(parseRetryAfter(null)).toBeNull()
    expect(parseRetryAfter('soon')).toBeNull()
    expect(parseRetryAfter('-1')).toBeNull()
  })

  it('rejects whitespace-only and exotic numeric forms (D1 — parity with Python float())', () => {
    expect(parseRetryAfter('   ')).toBeNull() // was 0 with bare Number()
    expect(parseRetryAfter('')).toBeNull()
    expect(parseRetryAfter('0x1A')).toBeNull()
    expect(parseRetryAfter('Infinity')).toBeNull()
    expect(parseRetryAfter('1_000')).toBeNull()
  })
})

describe('verifyToken', () => {
  it('returns a user on 200', async () => {
    const { fetchImpl } = jsonFetch(200, OK_USER)
    const user = await verifyToken(secretClient(fetchImpl), 'tok')
    expect(user.id).toBe('user_1')
    expect(user.email).toBe('a@b.co')
    expect(user.plan).toBe('pro') // from metadata fallback
    expect(user.emailVerified).toBe(false)
  })

  it('reads email_verified and plan from the top level when present', async () => {
    const { fetchImpl } = jsonFetch(200, {
      id: 'u',
      email: 'e@x.co',
      email_verified: true,
      plan: 'business',
    })
    const user = await verifyToken(secretClient(fetchImpl), 'tok')
    expect(user.emailVerified).toBe(true)
    expect(user.plan).toBe('business')
  })

  it('throws OneloAuthMissingToken for empty token', async () => {
    const { fetchImpl } = jsonFetch(200, OK_USER)
    await expect(verifyToken(secretClient(fetchImpl), '  ')).rejects.toBeInstanceOf(
      OneloAuthMissingToken,
    )
  })

  it('rejects a publishable-key client with OneloAuthError', async () => {
    const { fetchImpl } = jsonFetch(200, OK_USER)
    await expect(verifyToken(publishableClient(fetchImpl), 'tok')).rejects.toBeInstanceOf(
      OneloAuthError,
    )
  })

  it('maps 401 → OneloAuthInvalidToken', async () => {
    const { fetchImpl } = jsonFetch(401, { error: 'x' })
    await expect(verifyToken(secretClient(fetchImpl), 'tok')).rejects.toBeInstanceOf(
      OneloAuthInvalidToken,
    )
  })

  it('maps 403 → OneloAuthForbidden', async () => {
    const { fetchImpl } = jsonFetch(403, { error: 'x' })
    await expect(verifyToken(secretClient(fetchImpl), 'tok')).rejects.toBeInstanceOf(
      OneloAuthForbidden,
    )
  })

  it('maps 429 → OneloAuthRateLimited with retryAfter', async () => {
    const { fetchImpl } = jsonFetch(429, { error: 'x' }, { 'retry-after': '12' })
    const err = await verifyToken(secretClient(fetchImpl), 'tok').catch((e) => e)
    expect(err).toBeInstanceOf(OneloAuthRateLimited)
    expect(err).toBeInstanceOf(OneloAuthUnavailable) // subclass relationship
    expect((err as OneloAuthRateLimited).retryAfter).toBe(12)
  })

  it('maps 5xx → OneloAuthUnavailable', async () => {
    const { fetchImpl } = jsonFetch(503, { error: 'x' })
    await expect(verifyToken(secretClient(fetchImpl), 'tok')).rejects.toBeInstanceOf(
      OneloAuthUnavailable,
    )
  })

  it('treats a 200 non-object body as Unavailable', async () => {
    const { fetchImpl } = jsonFetch(200, [1, 2, 3])
    await expect(verifyToken(secretClient(fetchImpl), 'tok')).rejects.toBeInstanceOf(
      OneloAuthUnavailable,
    )
  })

  it('treats a 200 without a user id as Unavailable', async () => {
    const { fetchImpl } = jsonFetch(200, { email: 'e@x.co' })
    await expect(verifyToken(secretClient(fetchImpl), 'tok')).rejects.toBeInstanceOf(
      OneloAuthUnavailable,
    )
  })

  it('treats invalid JSON on 200 as Unavailable', async () => {
    const fetchImpl = async () => new Response('not json', { status: 200 })
    await expect(verifyToken(secretClient(fetchImpl), 'tok')).rejects.toBeInstanceOf(
      OneloAuthUnavailable,
    )
  })

  it('maps a network error to Unavailable', async () => {
    await expect(verifyToken(secretClient(throwingFetch()), 'tok')).rejects.toBeInstanceOf(
      OneloAuthUnavailable,
    )
  })

  it('sends bearer + secret-key headers to the auth/user endpoint', async () => {
    let seenUrl = ''
    let seenHeaders: Record<string, string> = {}
    const fetchImpl = async (url: string, init?: RequestInit) => {
      seenUrl = url
      seenHeaders = init?.headers as Record<string, string>
      return new Response(JSON.stringify(OK_USER), { status: 200 })
    }
    await verifyToken(secretClient(fetchImpl), 'the-token')
    expect(seenUrl).toBe('https://api.test.onelo.tools/api/sdk/auth/user')
    expect(seenHeaders.Authorization).toBe('Bearer the-token')
    expect(seenHeaders['X-Onelo-Secret-Key']).toBe('onelo_sk_test_abc123')
  })
})

describe('verifyWithRetry', () => {
  it('retries a 5xx then succeeds', async () => {
    const { fetchImpl, calls } = sequenceFetch([
      [500, { error: 'x' }],
      [200, OK_USER],
    ])
    const user = await verifyWithRetry(secretClient(fetchImpl), 'tok', {
      retryTotalTimeout: 1000,
    })
    expect(user.id).toBe('user_1')
    expect(calls()).toBe(2)
  })

  it('does NOT retry a 429 rate-limit', async () => {
    const { fetchImpl, calls } = sequenceFetch([
      [429, { error: 'x' }, { 'retry-after': '5' }],
      [200, OK_USER],
    ])
    await expect(
      verifyWithRetry(secretClient(fetchImpl), 'tok', { retryTotalTimeout: 1000 }),
    ).rejects.toBeInstanceOf(OneloAuthRateLimited)
    expect(calls()).toBe(1)
  })

  it('does NOT retry a 401', async () => {
    const { fetchImpl, calls } = sequenceFetch([
      [401, { error: 'x' }],
      [200, OK_USER],
    ])
    await expect(verifyWithRetry(secretClient(fetchImpl), 'tok')).rejects.toBeInstanceOf(
      OneloAuthInvalidToken,
    )
    expect(calls()).toBe(1)
  })

  it('gives up after retryAttempts and throws the last error', async () => {
    const { fetchImpl, calls } = sequenceFetch([[500, { error: 'x' }]])
    await expect(
      verifyWithRetry(secretClient(fetchImpl), 'tok', {
        retryAttempts: 2,
        retryTotalTimeout: 1000,
      }),
    ).rejects.toBeInstanceOf(OneloAuthUnavailable)
    expect(calls()).toBe(2)
  })
})
