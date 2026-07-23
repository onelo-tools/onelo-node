import { describe, expect, it } from 'vitest'
import { Onelo } from '../src/client'

describe('Onelo client construction', () => {
  it('requires a key', () => {
    // @ts-expect-error missing key
    expect(() => new Onelo({ apiUrl: 'https://api.test' })).toThrow(/requires a key/)
  })

  it('rejects providing multiple keys', () => {
    expect(
      () =>
        new Onelo({
          secretKey: 'onelo_sk_test_a',
          publishableKey: 'onelo_pk_test_b',
          apiUrl: 'https://api.test',
        }),
    ).toThrow(/exactly one/)
  })

  it('rejects a malformed key', () => {
    expect(() => new Onelo({ key: 'not_a_key', apiUrl: 'https://api.test' })).toThrow(/Key must match/)
  })

  it('classifies a generic secret key by prefix', () => {
    const c = new Onelo({ key: 'onelo_sk_live_x', apiUrl: 'https://api.test' })
    expect(c.isSecretKey).toBe(true)
  })

  it('classifies a generic publishable key by prefix', () => {
    const c = new Onelo({ key: 'onelo_pk_live_x', apiUrl: 'https://api.test' })
    expect(c.isSecretKey).toBe(false)
  })

  it('requires apiUrl (no default)', () => {
    // @ts-expect-error missing apiUrl
    expect(() => new Onelo({ secretKey: 'onelo_sk_test_a' })).toThrow(/requires apiUrl/)
  })

  it('rejects a non-http apiUrl', () => {
    expect(() => new Onelo({ secretKey: 'onelo_sk_test_a', apiUrl: 'ftp://x' })).toThrow(
      /http\(s\) URL/,
    )
  })

  it('rejects an empty-authority apiUrl (new URL throws before our check)', () => {
    expect(() => new Onelo({ secretKey: 'onelo_sk_test_a', apiUrl: 'https://' })).toThrow(
      /http\(s\) URL/,
    )
  })

  it('strips trailing slashes from apiUrl', () => {
    const c = new Onelo({ secretKey: 'onelo_sk_test_a', apiUrl: 'https://api.test///' })
    expect(c.apiUrl).toBe('https://api.test')
  })

  it('defaults requestTimeout to 5000ms', () => {
    const c = new Onelo({ secretKey: 'onelo_sk_test_a', apiUrl: 'https://api.test' })
    expect(c.requestTimeout).toBe(5000)
  })

  it('rejects an invalid featureEnvironment', () => {
    expect(
      () =>
        new Onelo({
          secretKey: 'onelo_sk_test_a',
          apiUrl: 'https://api.test',
          // @ts-expect-error invalid value
          featureEnvironment: 'bogus',
        }),
    ).toThrow(/featureEnvironment must be/)
  })

  it('treats a blank feature-env value as unset', () => {
    const c = new Onelo({
      secretKey: 'onelo_sk_test_a',
      apiUrl: 'https://api.test',
      featureEnvironment: '   ' as unknown as 'test',
    })
    expect(c.featureEnvironment).toBeNull()
  })
})
