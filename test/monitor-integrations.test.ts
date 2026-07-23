import { describe, expect, it, vi } from 'vitest'
import { installConsoleCapture, installFetchBreadcrumbs } from '../src/monitor/integrations'

function mockMonitor() {
  return {
    exceptions: [] as unknown[],
    messages: [] as Array<{ msg: string; level?: string }>,
    breadcrumbs: [] as Array<{
      msg: string
      category?: string
      level?: string
      data?: Record<string, unknown>
    }>,
    captureException(err: unknown) {
      this.exceptions.push(err)
    },
    captureMessage(msg: string, opts?: { level?: string }) {
      this.messages.push({ msg, level: opts?.level })
    },
    addBreadcrumb(
      msg: string,
      opts?: { category?: string; level?: string; data?: Record<string, unknown> },
    ) {
      this.breadcrumbs.push({ msg, category: opts?.category, level: opts?.level, data: opts?.data })
    },
  }
}

describe('console capture integration', () => {
  it('routes error(Error)→captureException, error(str)→message, warn→breadcrumb; passes through; uninstalls', () => {
    const m = mockMonitor()
    const origError = console.error
    const origWarn = console.warn
    const seen: string[] = []
    console.error = ((...a: unknown[]) => seen.push('error:' + a.map(String).join(' '))) as never
    console.warn = ((...a: unknown[]) => seen.push('warn:' + a.map(String).join(' '))) as never
    const uninstall = installConsoleCapture(m as never)
    try {
      const e = new Error('boom')
      console.error(e)
      console.error('plain', 'msg')
      console.warn('careful')

      // pass-through: the developer's original console still ran
      expect(seen).toContain('error:Error: boom')
      expect(seen.some((s) => s.startsWith('warn:careful'))).toBe(true)
      // routing
      expect(m.exceptions).toEqual([e])
      expect(m.messages).toEqual([{ msg: 'plain msg', level: 'error' }])
      expect(m.breadcrumbs).toEqual([
        { msg: 'careful', category: 'log', level: 'warning', data: undefined },
      ])

      uninstall()
      m.exceptions.length = 0
      console.error(new Error('after'))
      expect(m.exceptions).toEqual([]) // no longer captured after uninstall
    } finally {
      console.error = origError
      console.warn = origWarn
    }
  })
})

describe('fetch breadcrumbs integration', () => {
  it('adds an http breadcrumb per request (scrubbed URL), skips the ignored prefix, uninstalls', async () => {
    const m = mockMonitor()
    const calls: string[] = []
    const fakeFetch = vi.fn(async (input: unknown) => {
      calls.push(String(input))
      return new Response('ok', { status: 200 })
    })
    const g = globalThis as { fetch?: unknown }
    const orig = g.fetch
    g.fetch = fakeFetch
    const uninstall = installFetchBreadcrumbs(m as never, {
      ignoreUrlPrefix: 'https://api.onelo.tools',
    })
    try {
      await (globalThis.fetch as typeof fetch)('http://example.com/data?token=secret', {
        method: 'GET',
      })
      await (globalThis.fetch as typeof fetch)(
        'https://api.onelo.tools/api/sdk/monitor/events/batch',
        { method: 'POST' },
      )

      expect(calls.length).toBe(2) // both requests went through (pass-through)
      expect(m.breadcrumbs.length).toBe(1) // only the non-ignored one breadcrumbed
      const bc = m.breadcrumbs[0]!
      expect(bc.category).toBe('http')
      expect(bc.msg).toContain('GET')
      expect(bc.msg).not.toContain('secret') // sensitive query scrubbed
      expect((bc.data as { status_code: number }).status_code).toBe(200)

      uninstall()
      expect(globalThis.fetch).toBe(fakeFetch) // restored to what we wrapped
    } finally {
      g.fetch = orig
    }
  })
})
