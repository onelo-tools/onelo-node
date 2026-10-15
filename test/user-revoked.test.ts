/**
 * #831: Onelo refuses a banned or deleted App User at `/user` with
 * `403 {"detail":{"error":"user_revoked"}}`. `requireUser` refuses them at its
 * next re-check — for an Onelo session token and for an issuer token — and
 * lets them back in once the ban is lifted.
 */
import { describe, expect, it } from 'vitest'
import { OneloAuthForbidden } from '../src/auth/errors'
import { AuthHttpError, createResolver } from '../src/auth/resolve'
import { verifyToken } from '../src/auth/verify'
import { EXCHANGE_OK, OK_USER, issuerToken, oneloToken, routedFetch, secretClient } from './helpers'

const REVOKED: [number, unknown] = [403, { detail: { error: 'user_revoked', message: "You don't have access" } }]
// cacheTtl 0: every resolve is what the next re-check after a cache expiry looks like.
const recheck = { cacheTtl: 0 }

describe('a banned App User (#831)', () => {
  it('verifyToken throws OneloAuthForbidden carrying user_revoked', async () => {
    const { fetchImpl } = routedFetch({ user: REVOKED })
    const err = await verifyToken(secretClient(fetchImpl), oneloToken()).catch((e) => e)
    expect(err).toBeInstanceOf(OneloAuthForbidden)
    expect(err.code).toBe('user_revoked')
  })

  it('an Onelo session token is refused at the next re-check and let back in after the unban', async () => {
    const { fetchImpl, count } = routedFetch({ user: [[200, OK_USER], REVOKED, [200, OK_USER]] })
    const { resolve } = createResolver(secretClient(fetchImpl), recheck)
    const header = `Bearer ${oneloToken()}`

    expect((await resolve(header, null)).id).toBe('user_1')
    const err = (await resolve(header, null).catch((e) => e)) as AuthHttpError
    expect(err).toBeInstanceOf(AuthHttpError)
    expect(err.status).toBe(403)
    expect(err.body).toEqual({ error: 'forbidden', reason: 'user_revoked' })
    expect((await resolve(header, null)).id).toBe('user_1')
    expect(count('user')).toBe(3)
  })

  it('an issuer token is refused at the next re-check of its kept session, with no new sign-in', async () => {
    const { fetchImpl, count } = routedFetch({ exchange: [200, EXCHANGE_OK], user: REVOKED })
    const { resolve } = createResolver(secretClient(fetchImpl), recheck)
    const header = `Bearer ${issuerToken()}`

    await resolve(header, null)
    const err = (await resolve(header, null).catch((e) => e)) as AuthHttpError
    expect(err.status).toBe(403)
    expect(err.body).toEqual({ error: 'forbidden', reason: 'user_revoked' })
    expect(count('exchange')).toBe(1)
  })
})
