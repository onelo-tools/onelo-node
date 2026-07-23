import { describe, expect, it } from 'vitest'
import { monitorErrorHandler, monitorRequestHandler } from '../src/express'
import { withMonitor } from '../src/next'
import { registerOneloMonitor } from '../src/fastify'
import { oneloMonitor } from '../src/hono'
import { monitorFetch, oneloWith } from './monitor-helpers'

describe('express monitor adapter', () => {
  it('captures within the request isolation scope (user + request context)', async () => {
    const { fetchImpl, allEvents } = monitorFetch()
    const onelo = oneloWith(fetchImpl)
    onelo.monitor.init({ installGlobalHandlers: false })
    const reqMw = monitorRequestHandler(onelo)
    const errMw = monitorErrorHandler(onelo)

    await new Promise<void>((resolve) => {
      reqMw({ method: 'GET', url: '/pay?token=secret' } as never, {} as never, () => {
        onelo.monitor.setUser({ id: 'u-req' })
        errMw(new Error('boom'), {} as never, {} as never, () => resolve())
      })
    })

    await onelo.monitor.flush()
    const [e] = allEvents()
    expect(e?.error).toBe('boom')
    expect(e?.userId).toBe('u-req')
    const ctx = e?.meta?.contexts as { request: { method: string; url: string } }
    expect(ctx.request.method).toBe('GET')
    // Full URL now (Python parity via request-context), sensitive query scrubbed.
    expect(ctx.request.url).toContain('/pay')
    expect(ctx.request.url).not.toContain('secret')
    await onelo.close()
  })
})

describe('next monitor adapter', () => {
  it('captures a thrown error and re-throws', async () => {
    const { fetchImpl, allEvents } = monitorFetch()
    const onelo = oneloWith(fetchImpl)
    onelo.monitor.init({ installGlobalHandlers: false })
    const handler = withMonitor(onelo, async () => {
      throw new Error('next-boom')
    })
    await expect(handler(new Request('http://x/api/thing'), {})).rejects.toThrow('next-boom')
    await onelo.monitor.flush()
    expect(allEvents()[0]?.error).toBe('next-boom')
    await onelo.close()
  })
})

describe('fastify monitor adapter', () => {
  it('registers onRequest + onError hooks and captures', async () => {
    const { fetchImpl, allEvents } = monitorFetch()
    const onelo = oneloWith(fetchImpl)
    onelo.monitor.init({ installGlobalHandlers: false })
    const hooks: Record<string, (...args: never[]) => void> = {}
    const fake = { addHook: (name: string, fn: (...args: never[]) => void) => { hooks[name] = fn } }
    registerOneloMonitor(fake as never, onelo)

    await new Promise<void>((resolve) => {
      ;(hooks.onRequest as (r: unknown, y: unknown, d: () => void) => void)(
        { method: 'POST', url: '/jobs', headers: {} },
        {},
        () => {
          // A user set during the request must be seen by the onError capture
          // (same isolation scope propagated from onRequest's als.run).
          onelo.monitor.setUser({ id: 'job-user' })
          ;(hooks.onError as (r: unknown, y: unknown, e: unknown, d: () => void) => void)(
            {},
            {},
            new Error('fastify-boom'),
            () => resolve(),
          )
        },
      )
    })

    await onelo.monitor.flush()
    expect(allEvents()[0]?.error).toBe('fastify-boom')
    expect(allEvents()[0]?.userId).toBe('job-user')
    await onelo.close()
  })
})

describe('hono monitor adapter', () => {
  it('captures a thrown error and re-throws', async () => {
    const { fetchImpl, allEvents } = monitorFetch()
    const onelo = oneloWith(fetchImpl)
    onelo.monitor.init({ installGlobalHandlers: false })
    const mw = oneloMonitor(onelo)
    const c = {
      req: { method: 'GET', url: 'http://x/y', header: () => undefined, query: () => undefined },
      set: () => {},
      json: () => new Response(null),
    }
    await expect(
      mw(c as never, async () => {
        throw new Error('hono-boom')
      }),
    ).rejects.toThrow('hono-boom')
    await onelo.monitor.flush()
    expect(allEvents()[0]?.error).toBe('hono-boom')
    await onelo.close()
  })
})
