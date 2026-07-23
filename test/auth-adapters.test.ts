import { describe, expect, it } from 'vitest'
import { withOptionalUser, withUser } from '../src/next'
import { requireUser as fastifyRequireUser, optionalUser as fastifyOptionalUser } from '../src/fastify'
import { requireUser as honoRequireUser, optionalUser as honoOptionalUser } from '../src/hono'
import { jsonFetch, secretClient, OK_USER } from './helpers'

// ── Next.js ─────────────────────────────────────────────────────────────────

describe('next withUser / withOptionalUser', () => {
  const req = (auth?: string) =>
    new Request('http://x/api/me', auth ? { headers: { authorization: auth } } : undefined)

  it('runs the handler with the verified user on success', async () => {
    const { fetchImpl } = jsonFetch(200, OK_USER)
    const handler = withUser(secretClient(fetchImpl), async (_r, user) =>
      Response.json({ id: user.id }),
    )
    const res = await handler(req('Bearer tok'), {})
    expect(res.status).toBe(200)
    expect((await res.json()).id).toBe('user_1')
  })

  it('returns 401 on a missing token', async () => {
    const { fetchImpl } = jsonFetch(200, OK_USER)
    const handler = withUser(secretClient(fetchImpl), async () => Response.json({}))
    expect((await handler(req(), {})).status).toBe(401)
  })

  it('returns 503 on a backend outage', async () => {
    const { fetchImpl } = jsonFetch(500, { error: 'x' })
    const handler = withUser(secretClient(fetchImpl), async () => Response.json({}), {
      retryAttempts: 1,
    })
    expect((await handler(req('Bearer tok'), {})).status).toBe(503)
  })

  it('withOptionalUser calls the handler with null on invalid token, but 503 surfaces', async () => {
    const bad = jsonFetch(401, { error: 'x' })
    const okHandler = withOptionalUser(secretClient(bad.fetchImpl), async (_r, user) =>
      Response.json({ anon: user === null }),
    )
    expect((await okHandler(req('Bearer bad'), {}).then((r) => r.json())).anon).toBe(true)

    const down = jsonFetch(500, { error: 'x' })
    const downHandler = withOptionalUser(secretClient(down.fetchImpl), async () => Response.json({}), {
      retryAttempts: 1,
    })
    expect((await downHandler(req('Bearer tok'), {})).status).toBe(503)
  })
})

// ── Fastify ─────────────────────────────────────────────────────────────────

function fastifyReply() {
  return {
    statusCode: null as number | null,
    body: undefined as unknown,
    code(n: number) {
      this.statusCode = n
      return this
    },
    send(b: unknown) {
      this.body = b
      return this
    },
  }
}

describe('fastify requireUser / optionalUser', () => {
  it('attaches request.oneloUser on success', async () => {
    const { fetchImpl } = jsonFetch(200, OK_USER)
    const req = { headers: { authorization: 'Bearer tok' } } as Record<string, unknown>
    const reply = fastifyReply()
    await fastifyRequireUser(secretClient(fetchImpl))(req as never, reply as never)
    expect((req.oneloUser as { id: string }).id).toBe('user_1')
    expect(reply.statusCode).toBeNull()
  })

  it('sends 401 on a missing token', async () => {
    const { fetchImpl } = jsonFetch(200, OK_USER)
    const reply = fastifyReply()
    await fastifyRequireUser(secretClient(fetchImpl))({ headers: {} } as never, reply as never)
    expect(reply.statusCode).toBe(401)
  })

  it('optionalUser sets null on invalid token, 503 still sends', async () => {
    const bad = jsonFetch(401, { error: 'x' })
    const req = { headers: { authorization: 'Bearer bad' } } as Record<string, unknown>
    const reply = fastifyReply()
    await fastifyOptionalUser(secretClient(bad.fetchImpl))(req as never, reply as never)
    expect(req.oneloUser).toBeNull()
    expect(reply.statusCode).toBeNull()

    const down = jsonFetch(500, { error: 'x' })
    const reply2 = fastifyReply()
    await fastifyOptionalUser(secretClient(down.fetchImpl), { retryAttempts: 1 })(
      { headers: { authorization: 'Bearer tok' } } as never,
      reply2 as never,
    )
    expect(reply2.statusCode).toBe(503)
  })
})

// ── Hono ────────────────────────────────────────────────────────────────────

function honoCtx(auth?: string) {
  const store: Record<string, unknown> = {}
  return {
    store,
    req: {
      header: (n: string) => (n.toLowerCase() === 'authorization' ? auth : undefined),
      query: () => undefined,
    },
    set: (k: string, v: unknown) => {
      store[k] = v
    },
    json: (b: unknown, s?: number) => new Response(JSON.stringify(b), { status: s ?? 200 }),
  }
}

describe('hono requireUser / optionalUser', () => {
  it('stashes oneloUser and calls next on success', async () => {
    const { fetchImpl } = jsonFetch(200, OK_USER)
    const c = honoCtx('Bearer tok')
    let nextCalled = false
    await honoRequireUser(secretClient(fetchImpl))(c as never, async () => {
      nextCalled = true
    })
    expect(nextCalled).toBe(true)
    expect((c.store.oneloUser as { id: string }).id).toBe('user_1')
  })

  it('returns 401 on a missing token and does not call next', async () => {
    const { fetchImpl } = jsonFetch(200, OK_USER)
    const c = honoCtx()
    let nextCalled = false
    const res = (await honoRequireUser(secretClient(fetchImpl))(c as never, async () => {
      nextCalled = true
    })) as Response
    expect(res.status).toBe(401)
    expect(nextCalled).toBe(false)
  })

  it('optionalUser sets null on invalid token, 503 returns a response', async () => {
    const bad = jsonFetch(401, { error: 'x' })
    const c = honoCtx('Bearer bad')
    let nextCalled = false
    await honoOptionalUser(secretClient(bad.fetchImpl))(c as never, async () => {
      nextCalled = true
    })
    expect(nextCalled).toBe(true)
    expect(c.store.oneloUser).toBeNull()

    const down = jsonFetch(500, { error: 'x' })
    const c2 = honoCtx('Bearer tok')
    const res = (await honoOptionalUser(secretClient(down.fetchImpl), { retryAttempts: 1 })(
      c2 as never,
      async () => {},
    )) as Response
    expect(res.status).toBe(503)
  })
})
