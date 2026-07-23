import { describe, expect, it, vi } from 'vitest'
import type { FetchLike } from '../src/auth/verify'
import { Onelo } from '../src/client'
import {
  client,
  connectedFrame,
  featuresFetch,
  json,
  openSseStream,
} from './features-helpers'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('features — lazy start', () => {
  it('opens no connection until features are used', async () => {
    const { fetchImpl, calls } = featuresFetch({})
    const c = client(fetchImpl)
    await sleep(10)
    expect(calls.stream).toBe(0)
    expect(calls.poll).toBe(0)
    await c.close()
  })
})

describe('features — SSE strategy', () => {
  it('applies a connected snapshot and resolves ready()', async () => {
    const stream = openSseStream([connectedFrame({ exp: { status: 'enabled' } }, 1)])
    const { fetchImpl, calls } = featuresFetch({ stream: stream.response })
    const c = client(fetchImpl)

    // Before the stream lands, a lookup is hidden (fail-closed) and starts the stream.
    expect(c.features.feature('exp').status).toBe('hidden')
    expect(await c.ready(1000)).toBe(true)
    expect(c.features.feature('exp').isEnabled).toBe(true)
    expect(calls.stream).toBe(1)
    await c.close()
  })

  it('flushes discovery immediately on a discovery_requested event', async () => {
    const stream = openSseStream([connectedFrame({ exp: { status: 'enabled' } }, 1)])
    const { fetchImpl, calls } = featuresFetch({ stream: stream.response })
    const c = client(fetchImpl)
    c.features.feature('exp') // discovers 'exp'
    expect(await c.ready(1000)).toBe(true)

    stream.push('event: discovery_requested\ndata: {}\n\n')
    await sleep(30)
    expect(calls.batchPing).toBeGreaterThanOrEqual(1)
    await c.close()
  })

  it('sends the identified userId on the stream URL', async () => {
    let streamUrl = ''
    const stream = openSseStream([connectedFrame({}, 1)])
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes('/features/stream')) {
        streamUrl = url
        return stream.response()
      }
      return new Response(null, { status: 204 })
    }
    const c = new Onelo({
      secretKey: 'onelo_sk_test_feat',
      apiUrl: 'https://api.test.onelo.tools',
      fetchImpl,
    })
    c.identify('user-99')
    await c.ready(1000)
    expect(streamUrl).toContain('userId=user-99')
    expect(streamUrl).toContain('sdk_platform=node')
    await c.close()
  })
})

describe('features — polling strategy', () => {
  it('applies a poll snapshot and resolves ready()', async () => {
    const { fetchImpl, calls } = featuresFetch({
      poll: () => json({ config_version: 1, features: { p: { status: 'enabled' } }, discovery_requested: false }),
    })
    const c = client(fetchImpl, { strategy: 'polling' })
    c.features.feature('p')
    expect(await c.ready(1000)).toBe(true)
    expect(c.features.feature('p').isEnabled).toBe(true)
    expect(calls.poll).toBeGreaterThanOrEqual(1)
    expect(calls.stream).toBe(0)
    await c.close()
  })
})

describe('features — forUser (stateless multi-user path)', () => {
  it('resolves a user snapshot with the right request body', async () => {
    const { fetchImpl, calls, lastResolveBody } = featuresFetch({
      resolve: () =>
        json({ features: { f: { status: 'upsell', required_plan_label: 'Pro' } }, ttl: 300 }),
    })
    const c = client(fetchImpl)
    const uf = await c.features.forUser('user-42')
    expect(uf.feature('f').isUpsell).toBe(true)
    expect(uf.feature('f').upgradeHint).toBe('Pro')
    expect(lastResolveBody()).toMatchObject({
      publishableKey: 'onelo_sk_test_feat',
      userId: 'user-42',
      sdk_platform: 'node',
    })
    // forUser is stateless — it must NOT start the stream.
    expect(calls.stream).toBe(0)
    await c.close()
  })

  it('caches per user and re-fetches after invalidate', async () => {
    const { fetchImpl, calls } = featuresFetch({
      resolve: () => json({ features: { f: { status: 'enabled' } } }),
    })
    const c = client(fetchImpl)
    await c.features.forUser('u')
    await c.features.forUser('u')
    expect(calls.resolve).toBe(1) // cached
    c.features.invalidateUser('u')
    await c.features.forUser('u')
    expect(calls.resolve).toBe(2)
    await c.close()
  })

  it('is fail-closed on a backend error (every feature hidden)', async () => {
    const { fetchImpl } = featuresFetch({ resolve: () => new Response('boom', { status: 500 }) })
    const c = client(fetchImpl)
    const uf = await c.features.forUser('u')
    expect(uf.feature('anything').status).toBe('hidden')
    await c.close()
  })

  it('throws on an empty userId (programmer error)', async () => {
    const { fetchImpl } = featuresFetch({})
    const c = client(fetchImpl)
    await expect(c.features.forUser('')).rejects.toThrow(/non-empty/)
    await c.close()
  })
})

describe('features — plan-gating misuse warning', () => {
  it('warns once when the global path resolves a gated status', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const stream = openSseStream([connectedFrame({ locked: { status: 'upsell' } }, 1)])
    const { fetchImpl } = featuresFetch({ stream: stream.response })
    const c = client(fetchImpl)
    c.features.feature('locked')
    await c.ready(1000)
    c.features.feature('locked')
    c.features.feature('locked')
    const gatingWarns = warnSpy.mock.calls.filter((a) =>
      String(a[1] ?? '').includes("resolved to 'upsell'"),
    )
    expect(gatingWarns.length).toBe(1)
    await c.close()
    warnSpy.mockRestore()
  })
})

describe('features — malformed events are fail-closed', () => {
  it('keeps the last-good snapshot when features arrives as a non-object', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const stream = openSseStream([connectedFrame({ ok: { status: 'enabled' } }, 1)])
    const { fetchImpl } = featuresFetch({ stream: stream.response })
    const c = client(fetchImpl)
    c.features.feature('ok')
    expect(await c.ready(1000)).toBe(true)
    expect(c.features.feature('ok').isEnabled).toBe(true)

    // Malformed: features as an array (stray proxy body) must NOT clobber cache.
    stream.push('event: features_updated\ndata: {"features":["x"],"config_version":2}\n\n')
    await sleep(20)
    expect(c.features.feature('ok').isEnabled).toBe(true) // unchanged
    expect(c.features.feature('x').status).toBe('hidden') // garbage not applied
    await c.close()
    warnSpy.mockRestore()
  })

  it('rejects a connected event missing config_version (does not mark ready)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const stream = openSseStream([
      'event: connected\ndata: {"features":{"a":{"status":"enabled"}}}\n\n',
    ])
    const { fetchImpl } = featuresFetch({ stream: stream.response })
    const c = client(fetchImpl)
    c.features.feature('a')
    expect(await c.ready(100)).toBe(false) // malformed → never ready
    expect(c.features.feature('a').status).toBe('hidden')
    await c.close()
    warnSpy.mockRestore()
  })
})

describe('features — identify churn guard', () => {
  it('warns once when identity switches 5+ times', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const stream = openSseStream([])
    const { fetchImpl } = featuresFetch({ stream: stream.response })
    const c = client(fetchImpl)
    for (const id of ['a', 'b', 'c', 'd', 'e']) c.identify(id)
    const churn = warnSpy.mock.calls.filter((a) => String(a[1] ?? '').includes('switched identity'))
    expect(churn.length).toBe(1)
    await c.close()
    warnSpy.mockRestore()
  })
})

describe('features — ready() timeout', () => {
  it('resolves false when no snapshot arrives in time', async () => {
    // Stream never sends a frame → ready times out.
    const stream = openSseStream([])
    const { fetchImpl } = featuresFetch({ stream: stream.response })
    const c = client(fetchImpl)
    const ok = await c.features.ready(50)
    expect(ok).toBe(false)
    await c.close()
  })
})
