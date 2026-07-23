import { describe, expect, it } from 'vitest'
import { InProcessAuthCache } from '../src/auth/cache'
import { OneloUser } from '../src/auth/user'

const user = (id: string) => new OneloUser(id, `${id}@x.co`, false, null, {}, {})
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('InProcessAuthCache', () => {
  it('rejects maxSize < 1', () => {
    expect(() => new InProcessAuthCache(0)).toThrow(/maxSize/)
  })

  it('stores and retrieves a user', async () => {
    const c = new InProcessAuthCache()
    await c.set('h1', user('a'), 30)
    expect((await c.get('h1'))?.id).toBe('a')
  })

  it('does not cache when ttl <= 0', async () => {
    const c = new InProcessAuthCache()
    await c.set('h1', user('a'), 0)
    expect(await c.get('h1')).toBeNull()
  })

  it('expires entries after the ttl', async () => {
    const c = new InProcessAuthCache()
    await c.set('h1', user('a'), 0.01) // 10ms
    expect((await c.get('h1'))?.id).toBe('a')
    await sleep(25)
    expect(await c.get('h1')).toBeNull()
  })

  it('evicts the oldest entry when over maxSize', async () => {
    const c = new InProcessAuthCache(2)
    await c.set('h1', user('a'), 30)
    await c.set('h2', user('b'), 30)
    await c.set('h3', user('c'), 30) // evicts h1
    expect(await c.get('h1')).toBeNull()
    expect((await c.get('h2'))?.id).toBe('b')
    expect((await c.get('h3'))?.id).toBe('c')
  })

  it('a get() promotes an entry to MRU (protecting it from eviction)', async () => {
    const c = new InProcessAuthCache(2)
    await c.set('h1', user('a'), 30)
    await c.set('h2', user('b'), 30)
    await c.get('h1') // h1 becomes MRU, h2 now oldest
    await c.set('h3', user('c'), 30) // evicts h2
    expect((await c.get('h1'))?.id).toBe('a')
    expect(await c.get('h2')).toBeNull()
  })

  it('invalidate removes an entry', async () => {
    const c = new InProcessAuthCache()
    await c.set('h1', user('a'), 30)
    await c.invalidate('h1')
    expect(await c.get('h1')).toBeNull()
  })
})
