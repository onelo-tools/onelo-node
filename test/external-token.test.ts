/**
 * Own sign-in (#799, ADR-0032): an App that signs users in with its own
 * issuer sends that issuer's token to the developer's server. `verifyToken`
 * and every adapter identify the App User through the exchange endpoint.
 */
import { describe, expect, it } from 'vitest'
import {
  OneloAuthError,
  OneloAuthForbidden,
  OneloAuthInvalidToken,
  OneloAuthRateLimited,
  OneloAuthUnavailable,
} from '../src/auth/errors'
import { AuthHttpError, createResolver } from '../src/auth/resolve'
import { verifyToken, verifyWithRetry } from '../src/auth/verify'
import { requireUser as expressRequireUser } from '../src/express'
import { requireUser as fastifyRequireUser } from '../src/fastify'
import { requireUser as honoRequireUser } from '../src/hono'
import { withUser } from '../src/next'
import {
  EXCHANGE_OK,
  OK_USER,
  issuerToken,
  jwt,
  oneloToken,
  publishableClient,
  refusal,
  routedFetch,
  secretClient,
} from './helpers'

describe('verifyToken with an issuer token', () => {
  it('identifies the App User through the exchange, with the Secret Key', async () => {
    const { fetchImpl, calls } = routedFetch({ exchange: [200, EXCHANGE_OK] })
    const token = issuerToken()
    const user = await verifyToken(secretClient(fetchImpl), token)

    expect(user.id).toBe('user_ext')
    expect(user.email).toBe('ext@b.co')
    expect(user.emailVerified).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.path).toBe('/api/sdk/auth/exchange')
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.body).toEqual({ publishableKey: 'onelo_sk_test_abc123', token })
  })

  it('refuses a publishable-key client before any call', async () => {
    const { fetchImpl, calls } = routedFetch({ exchange: [200, EXCHANGE_OK] })
    await expect(verifyToken(publishableClient(fetchImpl), issuerToken())).rejects.toBeInstanceOf(
      OneloAuthError,
    )
    expect(calls).toHaveLength(0)
  })

  it('treats a 200 without a user id as Unavailable', async () => {
    const { fetchImpl } = routedFetch({ exchange: [200, { session: {}, user: { email: 'x@y.co' } }] })
    await expect(verifyToken(secretClient(fetchImpl), issuerToken())).rejects.toBeInstanceOf(
      OneloAuthUnavailable,
    )
  })

  it('treats a 200 without a user object as Unavailable', async () => {
    const { fetchImpl } = routedFetch({ exchange: [200, { session: {} }] })
    await expect(verifyToken(secretClient(fetchImpl), issuerToken())).rejects.toBeInstanceOf(
      OneloAuthUnavailable,
    )
  })
})

describe('Onelo session tokens are unchanged', () => {
  it('an Onelo session token makes one /user call and no exchange', async () => {
    const { fetchImpl, calls } = routedFetch({ user: [200, OK_USER] })
    const token = oneloToken()
    const user = await verifyToken(secretClient(fetchImpl), token)

    expect(user.id).toBe('user_1')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.path).toBe('/api/sdk/auth/user')
    expect(calls[0]!.method).toBe('GET')
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${token}`)
    expect(calls[0]!.headers['X-Onelo-Secret-Key']).toBe('onelo_sk_test_abc123')
  })

  it.each([
    ['an opaque token', 'tok'],
    ['three dotted parts that are not JSON', 'a.b.c'],
    ['a JWT whose payload is not an object', `${'e30'}.${Buffer.from('[1]').toString('base64url')}.s`],
  ])('%s goes to /user only', async (_name, token) => {
    const { fetchImpl, calls } = routedFetch({ user: [200, OK_USER] })
    await verifyToken(secretClient(fetchImpl), token)
    expect(calls.map((c) => c.path)).toEqual(['/api/sdk/auth/user'])
  })
})

describe('refused issuer tokens map to the existing auth errors', () => {
  async function refusedWith(status: number, body: unknown, headers?: Record<string, string>) {
    const { fetchImpl, count } = routedFetch({ exchange: [status, body, headers] })
    const err = await verifyWithRetry(secretClient(fetchImpl), issuerToken(), {
      retryAttempts: 3,
      retryTotalTimeout: 2000,
    }).catch((e) => e)
    return { err: err as OneloAuthError, attempts: count('exchange') }
  }

  it('401 token_expired → OneloAuthInvalidToken', async () => {
    const { err, attempts } = await refusedWith(401, refusal('token_expired'))
    expect(err).toBeInstanceOf(OneloAuthInvalidToken)
    expect(err.code).toBe('token_expired')
    expect(attempts).toBe(1)
  })

  it('401 for an unknown key (string detail) → OneloAuthInvalidToken without a code', async () => {
    const { err } = await refusedWith(401, { detail: 'Invalid publishable key' })
    expect(err).toBeInstanceOf(OneloAuthInvalidToken)
    expect(err.code).toBeNull()
  })

  it('403 banned → OneloAuthForbidden', async () => {
    const { err, attempts } = await refusedWith(403, { detail: { error: 'banned' } })
    expect(err).toBeInstanceOf(OneloAuthForbidden)
    expect(err.code).toBe('banned')
    expect(attempts).toBe(1)
  })

  it('403 no-plan gate → OneloAuthForbidden with its error_code', async () => {
    const { err } = await refusedWith(403, { detail: { error_code: 'no_plan_available' } })
    expect(err).toBeInstanceOf(OneloAuthForbidden)
    expect(err.code).toBe('no_plan_available')
  })

  it('409 email_in_use → OneloAuthForbidden, not retried', async () => {
    const { err, attempts } = await refusedWith(409, refusal('email_in_use'))
    expect(err).toBeInstanceOf(OneloAuthForbidden)
    expect(err.code).toBe('email_in_use')
    expect(attempts).toBe(1)
  })

  it('429 rate_limited → OneloAuthRateLimited with retryAfter, not retried', async () => {
    const { err, attempts } = await refusedWith(429, refusal('rate_limited'), { 'retry-after': '7' })
    expect(err).toBeInstanceOf(OneloAuthRateLimited)
    expect((err as OneloAuthRateLimited).retryAfter).toBe(7)
    expect(err.code).toBe('rate_limited')
    expect(attempts).toBe(1)
  })

  it('503 issuer_unavailable → OneloAuthUnavailable, retried', async () => {
    const { err, attempts } = await refusedWith(503, refusal('issuer_unavailable'))
    expect(err).toBeInstanceOf(OneloAuthUnavailable)
    expect(err).not.toBeInstanceOf(OneloAuthRateLimited)
    expect(err.code).toBe('issuer_unavailable')
    expect(attempts).toBe(3)
  })

  it('a retried outage that recovers resolves the user', async () => {
    const { fetchImpl, count } = routedFetch({
      exchange: [
        [503, refusal('issuer_unavailable')],
        [200, EXCHANGE_OK],
      ],
    })
    const user = await verifyWithRetry(secretClient(fetchImpl), issuerToken())
    expect(user.id).toBe('user_ext')
    expect(count('exchange')).toBe(2)
  })

  it('the resolver keeps its status and error, and adds the code as reason', async () => {
    const cases: Array<[number, unknown, number, Record<string, unknown>]> = [
      [401, refusal('token_expired'), 401, { error: 'invalid_token', reason: 'token_expired' }],
      [403, { detail: { error: 'banned' } }, 403, { error: 'forbidden', reason: 'banned' }],
      [409, refusal('email_in_use'), 403, { error: 'forbidden', reason: 'email_in_use' }],
      [429, refusal('rate_limited'), 503, { error: 'auth_service_unavailable' }],
    ]
    for (const [status, body, expectedStatus, expectedBody] of cases) {
      const { fetchImpl } = routedFetch({ exchange: [status, body] })
      const { resolve } = createResolver(secretClient(fetchImpl))
      const err = (await resolve(`Bearer ${issuerToken()}`, null).catch((e) => e)) as AuthHttpError
      expect(err).toBeInstanceOf(AuthHttpError)
      expect(err.status).toBe(expectedStatus)
      expect(err.body).toEqual(expectedBody)
    }
  })

  it('a refused Onelo session token keeps its body exactly', async () => {
    const { fetchImpl } = routedFetch({ user: [401, { detail: { error: 'invalid_token' } }] })
    const { resolve } = createResolver(secretClient(fetchImpl))
    const err = (await resolve(`Bearer ${oneloToken()}`, null).catch((e) => e)) as AuthHttpError
    expect(err.status).toBe(401)
    expect(err.body).toEqual({ error: 'invalid_token' })
  })
})

describe('an App on Onelo Auth', () => {
  it('a foreign JWT falls back to /user, and the answer is remembered', async () => {
    const { fetchImpl, count } = routedFetch({
      exchange: [403, refusal('sign_in_mode_onelo')],
      user: [200, OK_USER],
    })
    const client = secretClient(fetchImpl)

    const first = await verifyToken(client, jwt({ sub: 'legacy-1' }))
    expect(first.id).toBe('user_1')
    expect(count('exchange')).toBe(1)
    expect(count('user')).toBe(1)

    await verifyToken(client, jwt({ sub: 'legacy-2' }))
    expect(count('exchange')).toBe(1) // remembered: no second exchange
    expect(count('user')).toBe(2)
  })

  it('the memory belongs to one client, not to every client', async () => {
    const onelo = routedFetch({ exchange: [403, refusal('sign_in_mode_onelo')], user: [200, OK_USER] })
    await verifyToken(secretClient(onelo.fetchImpl), jwt({ sub: 'legacy-1' }))

    const external = routedFetch({ exchange: [200, EXCHANGE_OK] })
    const user = await verifyToken(secretClient(external.fetchImpl), issuerToken())
    expect(user.id).toBe('user_ext')
    expect(external.count('exchange')).toBe(1)
  })

  it('the /user refusal of the fallback is what the caller sees', async () => {
    const { fetchImpl } = routedFetch({
      exchange: [403, refusal('sign_in_mode_onelo')],
      user: [401, { detail: 'Invalid token' }],
    })
    await expect(verifyToken(secretClient(fetchImpl), jwt({ sub: 'x' }))).rejects.toBeInstanceOf(
      OneloAuthInvalidToken,
    )
  })
})

describe('caching', () => {
  it('a second resolve with the same issuer token does not call Onelo', async () => {
    const { fetchImpl, calls } = routedFetch({ exchange: [200, EXCHANGE_OK] })
    const { resolve } = createResolver(secretClient(fetchImpl))
    const header = `Bearer ${issuerToken()}`
    await resolve(header, null)
    const again = await resolve(header, null)
    expect(again.id).toBe('user_ext')
    expect(calls).toHaveLength(1)
  })

  it('ten concurrent resolves of one issuer token make one exchange', async () => {
    const { fetchImpl, calls } = routedFetch({ exchange: [200, EXCHANGE_OK] })
    const { resolve } = createResolver(secretClient(fetchImpl))
    const header = `Bearer ${issuerToken()}`
    const users = await Promise.all(Array.from({ length: 10 }, () => resolve(header, null)))
    expect(users.every((u) => u.id === 'user_ext')).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('concurrent resolves of different tokens each make their own exchange', async () => {
    const { fetchImpl, calls } = routedFetch({ exchange: [200, EXCHANGE_OK] })
    const { resolve } = createResolver(secretClient(fetchImpl))
    await Promise.all([
      resolve(`Bearer ${issuerToken('a')}`, null),
      resolve(`Bearer ${issuerToken('b')}`, null),
    ])
    expect(calls).toHaveLength(2)
  })

  it('a refusal shared by concurrent callers is not cached: the next resolve asks again', async () => {
    const { fetchImpl, count } = routedFetch({
      exchange: [
        [401, refusal('token_expired')],
        [200, EXCHANGE_OK],
      ],
    })
    const { resolve } = createResolver(secretClient(fetchImpl))
    const header = `Bearer ${issuerToken()}`
    const results = await Promise.all(
      Array.from({ length: 3 }, () => resolve(header, null).catch((e) => e as AuthHttpError)),
    )
    expect(results.every((r) => r instanceof AuthHttpError && r.status === 401)).toBe(true)
    expect(count('exchange')).toBe(1)

    const user = await resolve(header, null)
    expect(user.id).toBe('user_ext')
    expect(count('exchange')).toBe(2)
  })

  it('the gates run on a user from the exchange', async () => {
    const unverified = { ...EXCHANGE_OK, user: { ...EXCHANGE_OK.user, email_verified: false } }
    const { fetchImpl } = routedFetch({ exchange: [200, unverified] })
    const { resolve } = createResolver(secretClient(fetchImpl), { requireEmailVerified: true })
    const err = (await resolve(`Bearer ${issuerToken()}`, null).catch((e) => e)) as AuthHttpError
    expect(err.status).toBe(403)
    expect(err.body).toEqual({ error: 'forbidden', reason: 'email_unverified' })
  })
})

describe('the exchange is a sign-in, so it happens once per issuer token', () => {
  // cacheTtl 0 caches no user: every resolve is what a cache expiry looks like.
  const expired = { cacheTtl: 0 }
  const session = (accessToken: string) => ({
    ...EXCHANGE_OK,
    session: { ...EXCHANGE_OK.session, access_token: accessToken },
  })

  it('after the cache expires, the minted session is checked through /user: no second exchange', async () => {
    const minted = oneloToken('user_ext')
    const { fetchImpl, calls, count } = routedFetch({
      exchange: [200, session(minted)],
      user: [200, { id: 'user_ext', email: 'ext@b.co', email_verified: true }],
    })
    const { resolve } = createResolver(secretClient(fetchImpl), expired)
    const header = `Bearer ${issuerToken()}`

    await resolve(header, null)
    const again = await resolve(header, null)
    await resolve(header, null)

    expect(again.id).toBe('user_ext')
    expect(count('exchange')).toBe(1)
    expect(count('user')).toBe(2)
    expect(calls[1]!.headers.Authorization).toBe(`Bearer ${minted}`)
  })

  it('when /user refuses the kept session with 401, the issuer token is exchanged again', async () => {
    const { fetchImpl, count } = routedFetch({
      exchange: [200, EXCHANGE_OK],
      user: [
        [401, { detail: { error: 'invalid_token' } }],
        [200, { id: 'user_ext', email: 'ext@b.co' }],
      ],
    })
    const { resolve } = createResolver(secretClient(fetchImpl), expired)
    const header = `Bearer ${issuerToken()}`

    await resolve(header, null)
    const again = await resolve(header, null) // /user 401 → exchange
    expect(again.id).toBe('user_ext')
    expect(count('exchange')).toBe(2)
    expect(count('user')).toBe(1)

    await resolve(header, null) // the new session is kept in turn
    expect(count('exchange')).toBe(2)
    expect(count('user')).toBe(2)
  })

  it('when the door refuses the re-exchange, the caller gets its refusal', async () => {
    const { fetchImpl, count } = routedFetch({
      exchange: [
        [200, EXCHANGE_OK],
        [401, refusal('token_expired')],
      ],
      user: [401, { detail: { error: 'invalid_token' } }],
    })
    const { resolve } = createResolver(secretClient(fetchImpl), expired)
    const header = `Bearer ${issuerToken()}`
    await resolve(header, null)
    const err = (await resolve(header, null).catch((e) => e)) as AuthHttpError
    expect(err.status).toBe(401)
    expect(err.body).toEqual({ error: 'invalid_token', reason: 'token_expired' })
    expect(count('user')).toBe(1)

    // The refused session is gone: the next request goes straight to the door.
    await resolve(header, null).catch(() => null)
    expect(count('user')).toBe(1)
    expect(count('exchange')).toBe(3)
  })

  it('a 403 from /user for the kept session is final: no exchange around it', async () => {
    const { fetchImpl, count } = routedFetch({
      exchange: [200, EXCHANGE_OK],
      user: [403, { detail: { error: 'banned' } }],
    })
    const { resolve } = createResolver(secretClient(fetchImpl), expired)
    const header = `Bearer ${issuerToken()}`
    await resolve(header, null)
    const err = (await resolve(header, null).catch((e) => e)) as AuthHttpError
    expect(err.status).toBe(403)
    expect(count('exchange')).toBe(1)
  })

  it('an outage of /user for the kept session is 503, not a new sign-in', async () => {
    const { fetchImpl, count } = routedFetch({
      exchange: [200, EXCHANGE_OK],
      user: [503, {}],
    })
    const { resolve } = createResolver(secretClient(fetchImpl), { ...expired, retryAttempts: 1 })
    const header = `Bearer ${issuerToken()}`
    await resolve(header, null)
    const err = (await resolve(header, null).catch((e) => e)) as AuthHttpError
    expect(err.status).toBe(503)
    expect(count('exchange')).toBe(1)
  })

  it('the session never outlives the issuer token: past its exp the door is asked again', async () => {
    const { fetchImpl, count } = routedFetch({
      exchange: [200, EXCHANGE_OK],
      user: [200, { id: 'user_ext', email: 'ext@b.co' }],
    })
    const { resolve } = createResolver(secretClient(fetchImpl), expired)
    const header = `Bearer ${issuerToken('ext-1', -5)}` // already past exp
    await resolve(header, null)
    await resolve(header, null)
    expect(count('exchange')).toBe(2)
    expect(count('user')).toBe(0)
  })

  it('an answer without a usable session keeps nothing', async () => {
    const { fetchImpl, count } = routedFetch({
      exchange: [200, { user: EXCHANGE_OK.user, session: { access_token: 'x', expires_in: 0 } }],
      user: [200, { id: 'user_ext', email: 'ext@b.co' }],
    })
    const { resolve } = createResolver(secretClient(fetchImpl), expired)
    const header = `Bearer ${issuerToken()}`
    await resolve(header, null)
    await resolve(header, null)
    expect(count('exchange')).toBe(2)
    expect(count('user')).toBe(0)
  })

  it('each issuer token keeps its own session', async () => {
    const { fetchImpl, calls, count } = routedFetch({
      exchange: [
        [200, session('session-a')],
        [200, session('session-b')],
      ],
      user: [200, { id: 'user_ext', email: 'ext@b.co' }],
    })
    const { resolve } = createResolver(secretClient(fetchImpl), expired)
    const a = `Bearer ${issuerToken('a')}`
    const b = `Bearer ${issuerToken('b')}`
    await resolve(a, null)
    await resolve(b, null)
    await resolve(b, null)
    await resolve(a, null)
    expect(count('exchange')).toBe(2)
    expect(calls.slice(2).map((c) => c.headers.Authorization)).toEqual([
      'Bearer session-b',
      'Bearer session-a',
    ])
  })
})

describe('a backend without the exchange endpoint', () => {
  it.each([404, 405])('%i from the exchange falls back to /user and is remembered', async (status) => {
    const { fetchImpl, count } = routedFetch({
      exchange: [status, { detail: 'Not Found' }],
      user: [200, OK_USER],
    })
    const client = secretClient(fetchImpl)
    const user = await verifyWithRetry(client, jwt({ sub: 'legacy-1' }))
    expect(user.id).toBe('user_1')
    await verifyWithRetry(client, jwt({ sub: 'legacy-2' }))
    expect(count('exchange')).toBe(1)
    expect(count('user')).toBe(2)
  })
})

describe('every adapter resolves an App User from an issuer token', () => {
  const header = () => `Bearer ${issuerToken()}`

  it('express', async () => {
    const { fetchImpl, count } = routedFetch({ exchange: [200, EXCHANGE_OK] })
    const req = { headers: { authorization: header() }, query: {} } as {
      headers: Record<string, string>
      oneloUser?: { id: string }
    }
    let nextCalled = false
    await expressRequireUser(secretClient(fetchImpl))(req as never, {} as never, () => {
      nextCalled = true
    })
    expect(nextCalled).toBe(true)
    expect(req.oneloUser!.id).toBe('user_ext')
    expect(count('exchange')).toBe(1)
  })

  it('express answers 401 with the refusal code', async () => {
    const { fetchImpl } = routedFetch({ exchange: [401, refusal('token_issuer_mismatch')] })
    const sent: { status?: number; body?: unknown } = {}
    const res = {
      status(code: number) {
        sent.status = code
        return this
      },
      json(body: unknown) {
        sent.body = body
        return this
      },
    }
    let nextCalled = false
    await expressRequireUser(secretClient(fetchImpl))(
      { headers: { authorization: header() }, query: {} } as never,
      res as never,
      () => {
        nextCalled = true
      },
    )
    expect(nextCalled).toBe(false)
    expect(sent).toEqual({
      status: 401,
      body: { error: 'invalid_token', reason: 'token_issuer_mismatch' },
    })
  })

  it('fastify', async () => {
    const { fetchImpl, count } = routedFetch({ exchange: [200, EXCHANGE_OK] })
    const req = { headers: { authorization: header() }, query: {} } as {
      headers: Record<string, string>
      oneloUser?: { id: string }
    }
    await fastifyRequireUser(secretClient(fetchImpl))(req as never, {} as never)
    expect(req.oneloUser!.id).toBe('user_ext')
    expect(count('exchange')).toBe(1)
  })

  it('hono', async () => {
    const { fetchImpl, count } = routedFetch({ exchange: [200, EXCHANGE_OK] })
    const vars: Record<string, unknown> = {}
    const c = {
      req: {
        header: (name: string) => (name.toLowerCase() === 'authorization' ? header() : undefined),
        query: () => undefined,
      },
      set: (key: string, value: unknown) => {
        vars[key] = value
      },
      get: (key: string) => vars[key],
      json: (body: unknown, status?: number) => ({ body, status }),
    }
    let nextCalled = false
    await honoRequireUser(secretClient(fetchImpl))(c as never, async () => {
      nextCalled = true
    })
    expect(nextCalled).toBe(true)
    expect((vars.oneloUser as { id: string }).id).toBe('user_ext')
    expect(count('exchange')).toBe(1)
  })

  it('next withUser', async () => {
    const { fetchImpl, count } = routedFetch({ exchange: [200, EXCHANGE_OK] })
    const handler = withUser(secretClient(fetchImpl), async (_req, user) =>
      Response.json({ id: user.id }),
    )
    const res = await handler(
      new Request('https://app.example/api/me', { headers: { authorization: header() } }) as never,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 'user_ext' })
    expect(count('exchange')).toBe(1)
  })
})
