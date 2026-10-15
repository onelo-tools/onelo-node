/**
 * #520: a per-user Features call from a server SDK must be signed with the
 * SECRET key. A publishable key is public, so a pk-signed call naming a userId
 * is exactly as spoofable as a client — the SDK refuses it loudly instead of
 * sending it. Anonymous/global calls with a publishable key keep working.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FetchLike } from '../src/auth/verify'
import { Onelo } from '../src/client'
import { featuresFetch, openSseStream } from './features-helpers'

const API = 'https://api.test.onelo.tools'

function pkClient(fetchImpl: FetchLike, extra: Record<string, unknown> = {}) {
  return new Onelo({ publishableKey: 'onelo_pk_test_feat', apiUrl: API, fetchImpl, ...extra })
}

afterEach(() => vi.restoreAllMocks())

describe('#520 — per-user Features calls require the secret key', () => {
  it('forUser with a publishable key throws and sends nothing', async () => {
    const { fetchImpl, calls } = featuresFetch({})
    const c = pkClient(fetchImpl)
    await expect(c.features.forUser('user-42')).rejects.toThrow(/secret key \(onelo_sk_/)
    expect(calls.resolve).toBe(0)
    await c.close()
  })

  it('forUser with a pk passed through the generic `key` option also throws', async () => {
    const { fetchImpl, calls } = featuresFetch({})
    const c = new Onelo({ key: 'onelo_pk_live_x', apiUrl: API, fetchImpl })
    await expect(c.features.forUser('u')).rejects.toThrow(/use your secret key/)
    expect(calls.resolve).toBe(0)
    await c.close()
  })

  it('a publishable key whose tail contains _sk_ is still a publishable key', async () => {
    const { fetchImpl, calls } = featuresFetch({})
    const c = new Onelo({ key: 'onelo_pk_live_sk_abc', apiUrl: API, fetchImpl })
    await expect(c.features.forUser('u')).rejects.toThrow(/use your secret key/)
    expect(calls.resolve).toBe(0)
    await c.close()
  })

  it('identify(userId) with a publishable key throws and opens no stream', async () => {
    const { fetchImpl, calls } = featuresFetch({})
    const c = pkClient(fetchImpl)
    expect(() => c.identify('user-99')).toThrow(/secret key \(onelo_sk_/)
    expect(calls.stream + calls.poll).toBe(0)
    await c.close()
  })

  it('identify(null) and anonymous reads keep working with a publishable key', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const stream = openSseStream([])
    const { fetchImpl } = featuresFetch({ stream: stream.response })
    const c = pkClient(fetchImpl)
    expect(() => c.identify(null)).not.toThrow()
    expect(c.features.isEnabled('anything')).toBe(false)
    expect(() => c.features.declare(['a'])).not.toThrow()
    await c.close()
  })

  it('secret-key forUser is unchanged: resolves with the key and userId on the wire', async () => {
    const { fetchImpl, calls, lastResolveBody } = featuresFetch({})
    const c = new Onelo({ secretKey: 'onelo_sk_test_feat', apiUrl: API, fetchImpl })
    await c.features.forUser('user-42')
    expect(calls.resolve).toBe(1)
    expect(lastResolveBody()).toMatchObject({ publishableKey: 'onelo_sk_test_feat', userId: 'user-42' })
    await c.close()
  })

  it('secret-key identify(userId) is unchanged', async () => {
    const stream = openSseStream([])
    const { fetchImpl } = featuresFetch({ stream: stream.response })
    const c = new Onelo({ secretKey: 'onelo_sk_test_feat', apiUrl: API, fetchImpl })
    expect(() => c.identify('user-99')).not.toThrow()
    await c.close()
  })
})
