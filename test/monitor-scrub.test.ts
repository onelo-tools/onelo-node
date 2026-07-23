import { afterEach, describe, expect, it } from 'vitest'
import {
  REDACTED,
  configureSensitiveKeys,
  isPiiKey,
  scrubHeaders,
  scrubMeta,
  scrubText,
  scrubUrl,
  setStrictEmailScrub,
} from '../src/monitor/scrub'
import { Breadcrumbs } from '../src/monitor/types'

afterEach(() => {
  setStrictEmailScrub(false)
  configureSensitiveKeys(null)
})

describe('scrubText', () => {
  it('redacts Bearer tokens, JWTs, Stripe + Onelo keys', () => {
    expect(scrubText('Authorization: Bearer abc123DEF')).toContain(REDACTED)
    expect(scrubText('tok eyJhbGci.eyJzdWIi.SflKxwRJ here')).toContain(REDACTED)
    expect(scrubText('key sk_live_ABCDEFGHIJ1234567 end')).toContain(REDACTED)
    expect(scrubText('onelo_sk_live_ABCDEFGH123 leak')).toContain(REDACTED)
  })

  it('redacts a credit-card number', () => {
    expect(scrubText('card 4111 1111 1111 1111 done')).toContain(REDACTED)
    expect(scrubText('4111111111111111')).toBe(REDACTED)
  })

  it('leaves ordinary text alone', () => {
    expect(scrubText('nothing secret here')).toBe('nothing secret here')
  })

  it('only redacts emails in strict mode', () => {
    expect(scrubText('a@b.co')).toBe('a@b.co')
    setStrictEmailScrub(true)
    expect(scrubText('a@b.co')).toBe(REDACTED)
  })
})

describe('isPiiKey', () => {
  it('matches secret-ish keys, dash-normalised', () => {
    expect(isPiiKey('password')).toBe(true)
    expect(isPiiKey('X-API-KEY')).toBe(true)
    expect(isPiiKey('authorization')).toBe(true)
    expect(isPiiKey('x-anthropic-key')).toBe(true) // "key" segment
    expect(isPiiKey('monkey')).toBe(false)
    expect(isPiiKey('username')).toBe(false)
  })

  it('honours app-declared extra sensitive keys', () => {
    configureSensitiveKeys(['x-weird-secret-header'])
    expect(isPiiKey('x-weird-secret-header')).toBe(true)
  })
})

describe('scrubHeaders', () => {
  it('redacts sensitive header values', () => {
    const out = scrubHeaders({ Authorization: 'Bearer x', 'X-Api-Key': 'k', accept: 'json' })!
    expect(out.Authorization).toBe(REDACTED)
    expect(out['X-Api-Key']).toBe(REDACTED)
    expect(out.accept).toBe('json')
  })
})

describe('scrubUrl', () => {
  it('redacts sensitive query params, keeps the rest', () => {
    const out = scrubUrl('https://x.co/p?token=abc&page=2')!
    expect(out).toContain('token=' + encodeURIComponent(REDACTED))
    expect(out).toContain('page=2')
  })

  it('redacts an OAuth token in the fragment', () => {
    const out = scrubUrl('https://x.co/cb#access_token=eyJsecret&state=ok')!
    expect(out).toContain(encodeURIComponent(REDACTED))
    expect(out).toContain('state=ok')
  })
})

describe('scrubMeta', () => {
  it('redacts pii keys and records _onelo_redacted', () => {
    const out = scrubMeta({ password: 'p', nested: { api_key: 'k', ok: 1 }, plain: 'hi' })!
    expect(out.password).toBe(REDACTED)
    expect((out.nested as Record<string, unknown>).api_key).toBe(REDACTED)
    expect((out.nested as Record<string, unknown>).ok).toBe(1)
    expect(out.plain).toBe('hi')
    expect(out._onelo_redacted).toEqual(expect.arrayContaining(['password', 'api_key']))
  })

  it('scrubs secret patterns inside string values', () => {
    const out = scrubMeta({ note: 'my Bearer abc123XYZ token' })!
    expect(out.note).toContain(REDACTED)
  })

  it('Breadcrumbs.http scrubs an opaque query secret eagerly', () => {
    const c = Breadcrumbs.http('GET', 'https://app/cb?code=abc123opaquesecret&page=2')
    // scrubUrl redacts then URL-encodes ([REDACTED] → %5BREDACTED%5D), like Python.
    expect(String(c.data!.url)).toContain('REDACTED')
    expect(String(c.data!.url)).not.toContain('abc123opaquesecret')
    expect(String(c.data!.url)).toContain('page=2')
    expect(c.message).not.toContain('abc123opaquesecret')
  })

  it('email regex is not ReDoS-prone on adversarial input', () => {
    setStrictEmailScrub(true)
    const evil = 'x@' + 'a.'.repeat(20000) + '!'
    const start = performance.now()
    scrubText(evil)
    expect(performance.now() - start).toBeLessThan(100) // linear, not seconds
  })

  it('collapses over-deep nesting', () => {
    let deep: Record<string, unknown> = { secretInside: 'sk_live_ABCDEFGHIJ1234567' }
    for (let i = 0; i < 15; i++) deep = { nested: deep }
    const out = scrubMeta(deep)!
    expect(JSON.stringify(out)).toContain('_onelo_depth_exceeded')
  })
})
