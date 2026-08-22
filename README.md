# @onelo/node

The Onelo SDK for Node.js backends — verify users, gate features by plan, and monitor errors. Ships adapters for Express, Next.js, Fastify and Hono.

Part of [Onelo](https://onelo.tools): hosted sign-in, a paywall on **your own Stripe** account, plan-gated feature flags, uptime monitoring, in-app feedback, a public roadmap and a waitlist.

## Install

```bash
npm install github:onelo-tools/onelo-node
```

## Quick start

```ts
import { Onelo } from '@onelo/node'
import { requireUser } from '@onelo/node/express'

const onelo = new Onelo({
  secretKey: process.env.ONELO_SECRET_KEY!,   // onelo_sk_live_…  (NEVER commit)
  apiUrl: 'https://api.onelo.tools',
})

app.get('/me', requireUser(onelo), (req, res) => {
  res.json({ id: req.oneloUser!.id, email: req.oneloUser!.email })
})
```

A backend authenticates with your **secret key** (`onelo_sk_live_…`), not a publishable one — token verification refuses to run with a publishable key. Both `secretKey` and `apiUrl` are required; the client throws at construction if either is missing.

## Framework adapters

Each adapter is typed against a minimal structural interface, so the SDK itself depends on **no** framework — install whichever you already use.

**Express** — `@onelo/node/express`

```ts
import { requireUser, optionalUser, monitorRequestHandler, monitorErrorHandler } from '@onelo/node/express'

app.use(monitorRequestHandler(onelo))   // first
app.get('/me', requireUser(onelo), handler)
app.use(monitorErrorHandler(onelo))     // last
```

**Next.js** (App Router) — `@onelo/node/next`

```ts
import { withUser, withMonitor } from '@onelo/node/next'

export const GET = withMonitor(onelo, withUser(onelo, async (req, user) => {
  return Response.json({ id: user.id })
}))
```

**Fastify** — `@onelo/node/fastify`

```ts
import { requireUser, registerOneloMonitor } from '@onelo/node/fastify'

registerOneloMonitor(fastify, onelo)
fastify.get('/me', { preHandler: requireUser(onelo) }, handler)
```

**Hono** — `@onelo/node/hono`

```ts
import { requireUser, oneloMonitor } from '@onelo/node/hono'

app.use(oneloMonitor(onelo))
app.get('/me', requireUser(onelo), (c) => c.json({ id: c.get('oneloUser').id }))
```

Every adapter maps failures the same way: **401** for a missing or invalid token, **403** when the user is forbidden or fails a plan gate, **503** when Onelo is unreachable — so an outage never silently degrades into anonymous access.

Not using any of these? `verifyToken` works anywhere:

```ts
import { verifyToken, extractBearerToken } from '@onelo/node'

const user = await verifyToken(onelo, extractBearerToken(req.headers.authorization)!)
```

## Modules

| Module | What it does | Key API |
|---|---|---|
| **auth** | Verify tokens issued to your users by Onelo | `verifyToken()`, `verifyWithRetry()`, `extractBearerToken()`, `createResolver()` |
| `onelo.features` | Plan-gated feature flags, streamed live | `feature()`, `isEnabled()`, `declare()`, `forUser()`, `ready()` |
| `onelo.monitor` | Error and event reporting, breadcrumbs | `init()`, `captureException()`, `track()`, `setUser()`, `flush()` |

Feature checks are synchronous and **fail closed** — if the snapshot is unavailable, a flag reads as hidden rather than accidentally granting access:

```ts
onelo.features.declare(['export-api'])
await onelo.ready(2000)

if (onelo.features.isEnabled('export-api')) { /* … */ }

// Per-user resolution against their real plan
const flags = await onelo.features.forUser(user.id)
```

Monitoring, including a clean shutdown so buffered events are not lost:

```ts
onelo.monitor.init({ release: process.env.GIT_SHA, environment: 'production' })

process.on('SIGTERM', async () => {
  await onelo.close()
  process.exit(0)
})
```

## Requirements

- **Node 18+**
- Ships both CommonJS and ESM builds, with TypeScript declarations
- **Zero runtime dependencies**

## Links

- **Docs:** [onelo.tools/docs](https://onelo.tools/docs)
- **Dashboard:** [onelo.tools](https://onelo.tools) — your app's snippet comes pre-filled with your keys
- **Issues:** please report them on this repository

## License

MIT
