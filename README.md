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

### Your own sign-in (Supabase, Clerk, Firebase, any OpenID Connect issuer)

If your App's Sign-in Mode is an external issuer, send your server the token your own sign-in issued — nothing else changes:

```ts
// The frontend sends:  Authorization: Bearer <your provider's ID token>
app.get('/me', requireUser(onelo), (req, res) => {
  res.json({ id: req.oneloUser!.id })   // the Onelo App User behind that identity
})
```

`requireUser`, `withUser` and `verifyToken` accept that token as well as an Onelo session token. Onelo verifies it against the issuer you configured and answers with the App User; the SDK trusts nothing in the token itself. The result is cached like any other verification (30 s by default), and concurrent requests carrying the same token share one call. The exchange is a sign-in — it fires your `user.signed_in` webhook — so the adapters do it once per token: afterwards they re-check the Onelo session it returned, until that session (30 minutes) or your provider's token lapses. `verifyToken` on its own keeps nothing and exchanges on every call; put your own cache in front of it, or use `createResolver`.

A refused token maps to the same errors and statuses as an Onelo token, and carries Onelo's refusal code — on `error.code` from `verifyToken`, and as `reason` in the adapters' response body:

| Onelo answers | Error | Adapter status | Example `code` |
|---|---|---|---|
| 401 | `OneloAuthInvalidToken` | 401 | `token_expired`, `token_issuer_mismatch`, `token_audience_mismatch` |
| 403, 409 | `OneloAuthForbidden` | 403 | `banned`, `account_deleted`, `email_in_use` |
| 429 | `OneloAuthRateLimited` | 503 | `rate_limited`, `plan_limit_exceeded` |
| 5xx | `OneloAuthUnavailable` | 503 | `issuer_unavailable` |

`requireUser(onelo, { requireEmailVerified: true })` (and `createResolver(..., { requireEmailVerified: true })`) refuses users who have not verified their address with `403` (`reason: 'email_unverified'`). It reads `user.emailVerified`, which Onelo sets when Email verification is Optional or Required in the parent App's Auth → Sign-up — with it Off, every password user stays unverified. OAuth, Magic Link and e-mailed password resets count as verified.

## Server assertion (own sign-in without tokens)

For an App whose Sign-in Mode is an external provider but whose backend has no issuer tokens (classic server sessions), your server tells Onelo who the user is with an **identity-only key** (`onelo_ik_live_…`, dashboard → API Keys → Identity keys). That key can do nothing else and is not a Secret Key. `assertIdentity` refuses to run in a browser build.

```ts
import { assertIdentity } from '@onelo/node'

// On YOUR server, after your own sign-in has identified the user.
// The identity key (onelo_ik_live_…) comes from the dashboard: API Keys →
// Identity keys. It can only say who is signed in; it is not a Secret Key.
// Read it from the environment; never send it to a browser.
const { user, session } = await assertIdentity({
  apiUrl: 'https://api.onelo.tools',
  identityKey: process.env.ONELO_IDENTITY_KEY!,
  externalId: account.id,          // your own id for this user
  email: account.email,            // optional
  emailVerified: account.emailVerified === true,
})

// session.accessToken is an ordinary Onelo session (30 minutes, no refresh):
// hand it to your frontend, or use user.id with the other Onelo modules.
// Refusals throw typed errors with .code — invalid_identity_key,
// ip_not_allowed, sign_in_mode_onelo, banned, rate_limited …
```

## Modules

| Module | What it does | Key API |
|---|---|---|
| **auth** | Verify tokens issued to your users by Onelo or by your own sign-in | `verifyToken()`, `verifyWithRetry()`, `extractBearerToken()`, `createResolver()` |
| `onelo.features` | Plan-gated feature flags, streamed live | `feature()`, `isEnabled()`, `declare()`, `forUser()`, `ready()` |
| `onelo.monitor` | Error and event reporting, breadcrumbs | `init()`, `captureException()`, `track()`, `setUser()`, `flush()` |
| `onelo.store` | Your app's plans with prices (secret key) | `listPlans()` |

Feature checks are synchronous and **fail closed** — if the snapshot is unavailable, a flag reads as hidden rather than accidentally granting access:

```ts
onelo.features.declare(['export-api'])
await onelo.ready(2000)

if (onelo.features.isEnabled('export-api')) { /* … */ }

// Per-user resolution against their real plan
const flags = await onelo.features.forUser(user.id)
```

**Per-user calls require the secret key.** `features.forUser(userId)` and `identify(userId)` send a user id that the Onelo backend trusts only from a secret-key caller. A publishable key is public, so a client built with one throws on these calls ("use your secret key (onelo_sk_…) on the server") instead of sending a request anyone could forge. Anonymous calls (`feature()`, `isEnabled()`, `declare()`, `ready()`, `identify(null)`) work with either key. The `publishableKey` option is deprecated for servers; pass `secretKey` (or `key`).

Monitoring, including a clean shutdown so buffered events are not lost:

```ts
onelo.monitor.init({ release: process.env.GIT_SHA, environment: 'production' })

process.on('SIGTERM', async () => {
  await onelo.close()
  process.exit(0)
})
```

Plans with prices, so an admin panel never copies them from the dashboard. `plan` is the same key as `OneloUser.plan`; amounts are in minor units:

```ts
const plans = await onelo.store.listPlans()
// [{ plan: 'pro', name: 'Pro', mode: 'subscription', currency: 'eur',
//    priceAmount: 1900, annualPriceAmount: 19000, trialPeriodDays: 14, ... }]
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
