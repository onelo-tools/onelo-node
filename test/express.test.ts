import { describe, expect, it } from 'vitest'
import { optionalUser, requireUser } from '../src/express'
import { jsonFetch, secretClient, OK_USER } from './helpers'

interface FakeRes {
  statusCode: number | null
  body: unknown
  status(code: number): FakeRes
  json(body: unknown): FakeRes
}

function fakeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: null,
    body: undefined,
    status(code) {
      this.statusCode = code
      return this
    },
    json(body) {
      this.body = body
      return this
    },
  }
  return res
}

function fakeReq(authorization?: string, query?: Record<string, unknown>) {
  return {
    headers: authorization ? { authorization } : {},
    query: query ?? {},
  } as {
    headers: Record<string, string | string[] | undefined>
    query?: Record<string, unknown>
    oneloUser?: unknown
  }
}

describe('express requireUser', () => {
  it('attaches req.oneloUser and calls next() on success', async () => {
    const { fetchImpl } = jsonFetch(200, OK_USER)
    const mw = requireUser(secretClient(fetchImpl))
    const req = fakeReq('Bearer tok')
    const res = fakeRes()
    let nextCalled = false
    await mw(req as never, res as never, () => {
      nextCalled = true
    })
    expect(nextCalled).toBe(true)
    expect((req.oneloUser as { id: string }).id).toBe('user_1')
    expect(res.statusCode).toBeNull()
  })

  it('responds 401 and does NOT call next() on a missing token', async () => {
    const { fetchImpl } = jsonFetch(200, OK_USER)
    const mw = requireUser(secretClient(fetchImpl))
    const req = fakeReq()
    const res = fakeRes()
    let nextCalled = false
    await mw(req as never, res as never, () => {
      nextCalled = true
    })
    expect(nextCalled).toBe(false)
    expect(res.statusCode).toBe(401)
    expect(res.body).toEqual({ error: 'missing_token' })
  })

  it('responds 503 on backend outage', async () => {
    const { fetchImpl } = jsonFetch(500, { error: 'x' })
    const mw = requireUser(secretClient(fetchImpl), { retryAttempts: 1 })
    const req = fakeReq('Bearer tok')
    const res = fakeRes()
    await mw(req as never, res as never, () => {})
    expect(res.statusCode).toBe(503)
  })
})

describe('express optionalUser', () => {
  it('sets req.oneloUser = null and continues on invalid token', async () => {
    const { fetchImpl } = jsonFetch(401, { error: 'x' })
    const mw = optionalUser(secretClient(fetchImpl))
    const req = fakeReq('Bearer bad')
    const res = fakeRes()
    let nextCalled = false
    await mw(req as never, res as never, () => {
      nextCalled = true
    })
    expect(nextCalled).toBe(true)
    expect(req.oneloUser).toBeNull()
    expect(res.statusCode).toBeNull()
  })

  it('still responds 503 on backend outage', async () => {
    const { fetchImpl } = jsonFetch(500, { error: 'x' })
    const mw = optionalUser(secretClient(fetchImpl), { retryAttempts: 1 })
    const req = fakeReq('Bearer tok')
    const res = fakeRes()
    let nextCalled = false
    await mw(req as never, res as never, () => {
      nextCalled = true
    })
    expect(nextCalled).toBe(false)
    expect(res.statusCode).toBe(503)
  })
})
