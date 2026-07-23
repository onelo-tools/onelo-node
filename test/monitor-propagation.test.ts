import { describe, expect, it } from 'vitest'
import { monitorFetch, oneloWith } from './monitor-helpers'

describe('monitor carrier / continueTrace (cross-process scope propagation)', () => {
  it('carrier → continueTrace round-trips user.id + tags + trace_id', async () => {
    const { fetchImpl, allEvents } = monitorFetch()
    const onelo = oneloWith(fetchImpl)
    onelo.monitor.init({ installGlobalHandlers: false })
    onelo.monitor.setUser({ id: 'u1', email: 'secret@x.co' })
    onelo.monitor.setTag('region', 'eu')

    const carrier = onelo.monitor.carrier()
    // Privacy whitelist: user.id ONLY (never email), plus tags + trace_id.
    expect(carrier.user).toEqual({ id: 'u1' })
    expect((carrier.tags as Record<string, string>).region).toBe('eu')
    expect(carrier.trace_id).toMatch(/^[0-9a-f]{32}$/)

    const result = await onelo.monitor.continueTrace(carrier, async () => {
      onelo.monitor.captureMessage('inside-job')
      return 'done'
    })
    expect(result).toBe('done')
    await onelo.monitor.flush()

    const [e] = allEvents()
    expect(e?.userId).toBe('u1')
    expect((e?.meta?.tags as Record<string, string>).region).toBe('eu')
    expect((e?.meta?.tags as Record<string, string>).trace_id).toBe(carrier.trace_id)
    await onelo.close()
  })

  it('HMAC-signed carrier verifies and applies', async () => {
    const { fetchImpl, allEvents } = monitorFetch()
    const onelo = oneloWith(fetchImpl)
    onelo.monitor.init({ installGlobalHandlers: false })
    onelo.monitor.setUser({ id: 'u9' })

    const signed = onelo.monitor.carrier({ key: 'shared-key' })
    expect(signed._data).toBeDefined()
    expect(signed._sig).toBeDefined()

    await onelo.monitor.continueTrace(signed, async () => onelo.monitor.captureMessage('x'), {
      key: 'shared-key',
    })
    await onelo.monitor.flush()
    expect(allEvents()[0]?.userId).toBe('u9')
    await onelo.close()
  })

  it('rejects a tampered signed payload (empty scope, no attribution)', async () => {
    const { fetchImpl, allEvents } = monitorFetch()
    const onelo = oneloWith(fetchImpl)
    onelo.monitor.init({ installGlobalHandlers: false })
    onelo.monitor.setUser({ id: 'victim' })

    const signed = onelo.monitor.carrier({ key: 'k' })
    ;(signed._data as { user: { id: string } }).user.id = 'attacker' // tamper without re-signing

    await onelo.monitor.continueTrace(signed, async () => onelo.monitor.captureMessage('x'), { key: 'k' })
    await onelo.monitor.flush()
    expect(allEvents()[0]?.userId).toBeUndefined()
    await onelo.close()
  })

  it('rejects a signed carrier when no key is supplied to verify it', async () => {
    const { fetchImpl, allEvents } = monitorFetch()
    const onelo = oneloWith(fetchImpl)
    onelo.monitor.init({ installGlobalHandlers: false })
    onelo.monitor.setUser({ id: 'u' })

    const signed = onelo.monitor.carrier({ key: 'k' })
    await onelo.monitor.continueTrace(signed, async () => onelo.monitor.captureMessage('x')) // no key
    await onelo.monitor.flush()
    expect(allEvents()[0]?.userId).toBeUndefined()
    await onelo.close()
  })

  it('does NOT inherit the ambient scope user (forks from global)', async () => {
    const { fetchImpl, allEvents } = monitorFetch()
    const onelo = oneloWith(fetchImpl)
    onelo.monitor.init({ installGlobalHandlers: false })
    onelo.monitor.setUser({ id: 'ambient' })

    // Carrier carries a tag but NO user — a fork-from-global scope must therefore
    // have no user (if it forked from the ambient scope it would inherit 'ambient').
    await onelo.monitor.continueTrace({ tags: { job: 'x' } }, async () => {
      onelo.monitor.captureMessage('inside')
    })
    await onelo.monitor.flush()
    const [e] = allEvents()
    expect(e?.userId).toBeUndefined()
    expect((e?.meta?.tags as Record<string, string>).job).toBe('x')
    await onelo.close()
  })

  it('restores the previous scope after the block', async () => {
    const { fetchImpl, allEvents } = monitorFetch()
    const onelo = oneloWith(fetchImpl)
    onelo.monitor.init({ installGlobalHandlers: false })
    onelo.monitor.setUser({ id: 'outer' })

    await onelo.monitor.continueTrace({ user: { id: 'inner' } }, async () => {
      onelo.monitor.captureMessage('inside')
    })
    onelo.monitor.captureMessage('after')
    await onelo.monitor.flush()

    const events = allEvents()
    expect(events[0]?.userId).toBe('inner') // inside the block
    expect(events[1]?.userId).toBe('outer') // ambient scope restored afterwards
    await onelo.close()
  })
})
