import { describe, expect, it, vi } from 'vitest'
import { VERSION } from '../src/version'
import { directMonitor, monitorFetch, oneloWith } from './monitor-helpers'

describe('captureMessage / captureException', () => {
  it('captureMessage(error) → ok=false, error set, platform node', async () => {
    const { fetchImpl, allEvents } = monitorFetch()
    const onelo = oneloWith(fetchImpl)
    onelo.monitor.init({ installGlobalHandlers: false })
    onelo.monitor.captureMessage('something broke', { level: 'error' })
    await onelo.monitor.flush()
    const [e] = allEvents()
    expect(e?.ok).toBe(false)
    expect(e?.error).toBe('something broke')
    expect(e?.platform).toBe('node')
    expect((e?.meta?.sdk as { name: string; version: string })).toEqual({ name: 'onelo-node', version: VERSION })
    expect(e?.sessionId).toMatch(/^[0-9a-f]{32}$/)
    await onelo.close()
  })

  it('captureMessage(info) → ok=true, no error', async () => {
    const { fetchImpl, allEvents } = monitorFetch()
    const onelo = oneloWith(fetchImpl)
    onelo.monitor.init({ installGlobalHandlers: false })
    onelo.monitor.captureMessage('hello')
    await onelo.monitor.flush()
    expect(allEvents()[0]?.ok).toBe(true)
    expect(allEvents()[0]?.error).toBeUndefined()
    await onelo.close()
  })

  it('captureException attaches exception + stack to meta', async () => {
    const { fetchImpl, allEvents } = monitorFetch()
    const onelo = oneloWith(fetchImpl)
    onelo.monitor.init({ installGlobalHandlers: false })
    try {
      throw new Error('kaboom')
    } catch (e) {
      onelo.monitor.captureException(e)
    }
    await onelo.monitor.flush()
    const [e] = allEvents()
    expect(e?.error).toBe('kaboom')
    expect(e?.ok).toBe(false)
    const exc = e?.meta?.exception as { type: string; message: string; frames: unknown[] }
    expect(exc.type).toBe('Error')
    expect(exc.message).toBe('kaboom')
    expect(exc.frames.length).toBeGreaterThan(0)
    await onelo.close()
  })
})

describe('track', () => {
  it('emits ok=true with duration on success and returns the value', async () => {
    const { fetchImpl, allEvents } = monitorFetch()
    const onelo = oneloWith(fetchImpl)
    onelo.monitor.init({ installGlobalHandlers: false })
    const result = onelo.monitor.track('compute', () => 21 * 2)
    expect(result).toBe(42)
    await onelo.monitor.flush()
    const [e] = allEvents()
    expect(e?.ok).toBe(true)
    expect(e?.source).toBe('track')
    expect(e?.durationMs).toBeGreaterThanOrEqual(0)
    await onelo.close()
  })

  it('classifies a thrown undefined as an error, not success', async () => {
    const { fetchImpl, allEvents } = monitorFetch()
    const onelo = oneloWith(fetchImpl)
    onelo.monitor.init({ installGlobalHandlers: false })
    let threw = false
    try {
      onelo.monitor.track('x', () => {
        throw undefined
      })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    await onelo.monitor.flush()
    expect(allEvents()[0]?.ok).toBe(false)
    await onelo.close()
  })

  it('emits an error event on throw and rethrows (async)', async () => {
    const { fetchImpl, allEvents } = monitorFetch()
    const onelo = oneloWith(fetchImpl)
    onelo.monitor.init({ installGlobalHandlers: false })
    await expect(
      onelo.monitor.track('io', async () => {
        throw new Error('disk full')
      }),
    ).rejects.toThrow('disk full')
    await onelo.monitor.flush()
    const [e] = allEvents()
    expect(e?.ok).toBe(false)
    expect(e?.error).toBe('disk full')
    expect(e?.source).toBe('track')
    await onelo.close()
  })
})

describe('scope + enrichment in the pipeline', () => {
  it('attaches user / tags / breadcrumbs from the isolation scope', async () => {
    const { fetchImpl, allEvents } = monitorFetch()
    const onelo = oneloWith(fetchImpl)
    onelo.monitor.init({ installGlobalHandlers: false })
    onelo.monitor.setUser({ id: 'u42' })
    onelo.monitor.setTag('area', 'billing')
    onelo.monitor.addBreadcrumb('charged card', { category: 'db' })
    onelo.monitor.captureMessage('later error', { level: 'error' })
    await onelo.monitor.flush()
    const [e] = allEvents()
    expect(e?.userId).toBe('u42')
    expect((e?.meta?.tags as Record<string, string>).area).toBe('billing')
    expect((e?.meta?.breadcrumbs as unknown[]).length).toBe(1)
    await onelo.close()
  })

  it('isolates scopes across concurrent requests', async () => {
    const { fetchImpl, allEvents } = monitorFetch()
    const onelo = oneloWith(fetchImpl)
    onelo.monitor.init({ installGlobalHandlers: false })
    const run = (id: string) =>
      onelo.monitor.runWithIsolationScope(async () => {
        onelo.monitor.setUser({ id })
        await new Promise((r) => setTimeout(r, 5))
        onelo.monitor.captureMessage('err', { level: 'error' })
      })
    await Promise.all([run('A'), run('B')])
    await onelo.monitor.flush()
    const users = allEvents().map((e) => e.userId).sort()
    expect(users).toEqual(['A', 'B'])
    await onelo.close()
  })

  it('scrubs PII in meta and error text', async () => {
    const { fetchImpl, allEvents } = monitorFetch()
    const onelo = oneloWith(fetchImpl)
    onelo.monitor.init({ installGlobalHandlers: false })
    onelo.monitor.captureMessage('failed with Bearer abc123XYZ token', {
      level: 'error',
      meta: { password: 'hunter2', ok: true },
    })
    await onelo.monitor.flush()
    const [e] = allEvents()
    expect(e?.error).toContain('[REDACTED]')
    expect(e?.meta?.password).toBe('[REDACTED]')
    expect(e?.meta?.ok).toBe(true)
    await onelo.close()
  })
})

describe('sampling', () => {
  it('drops error events at sampleRate 0', async () => {
    const { fetchImpl, allEvents } = monitorFetch()
    const onelo = oneloWith(fetchImpl)
    onelo.monitor.init({ installGlobalHandlers: false, sampleRate: 0 })
    onelo.monitor.captureMessage('dropped', { level: 'error' })
    await onelo.monitor.flush()
    expect(allEvents()).toHaveLength(0)
    await onelo.close()
  })

  it('rejects an out-of-range sample rate', () => {
    const { fetchImpl } = monitorFetch()
    const onelo = oneloWith(fetchImpl)
    expect(() => onelo.monitor.init({ sampleRate: 2 })).toThrow(/between 0 and 1/)
  })
})

describe('deploy context + flags', () => {
  it('stamps environment + app.version on the exact backend meta paths', async () => {
    const { fetchImpl, allEvents } = monitorFetch()
    const m = directMonitor(fetchImpl)
    m.init({ installGlobalHandlers: false, release: 'abc123', environment: 'production' })
    m.captureMessage('x', { level: 'error' })
    await m.flush()
    const [e] = allEvents()
    expect(e?.meta?.environment).toBe('production')
    expect((e?.meta?.app as { version: string }).version).toBe('abc123')
    await m.close()
  })

  it('attaches the active feature-flag snapshot', async () => {
    const { fetchImpl, allEvents } = monitorFetch()
    const m = directMonitor(fetchImpl, () => ({ 'new-checkout': 'enabled' }))
    m.init({ installGlobalHandlers: false })
    m.captureMessage('x', { level: 'error' })
    await m.flush()
    expect((allEvents()[0]?.meta?.flags as Record<string, string>)['new-checkout']).toBe('enabled')
    await m.close()
  })
})

describe('lifecycle', () => {
  it('capture before init is a silent no-op', async () => {
    const { fetchImpl, postCount } = monitorFetch()
    const onelo = oneloWith(fetchImpl)
    expect(() => onelo.monitor.captureException(new Error('x'))).not.toThrow()
    expect(onelo.monitor.isInitialised()).toBe(false)
    await new Promise((r) => setTimeout(r, 10))
    expect(postCount()).toBe(0)
    await onelo.close()
  })

  it('init twice warns and re-inits cleanly', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { fetchImpl } = monitorFetch()
    const onelo = oneloWith(fetchImpl)
    onelo.monitor.init({ installGlobalHandlers: false })
    onelo.monitor.init({ installGlobalHandlers: false })
    expect(warnSpy.mock.calls.some((a) => String(a[1] ?? '').includes('init called twice'))).toBe(true)
    await onelo.close()
    warnSpy.mockRestore()
  })
})
