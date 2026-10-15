/**
 * An App may bring its own sign-in (ADR-0032). Its frontend then sends the
 * developer's server the token of its own issuer (Supabase, Clerk, Firebase,
 * any OpenID Connect issuer) instead of an Onelo session token. The server
 * identifies the App User through `POST /api/sdk/auth/exchange`, with its
 * Secret Key.
 *
 * This file holds what is particular to that door: telling the two kinds of
 * token apart, reading the door's answer, and remembering that an App is on
 * Onelo Auth. `verifyToken` in verify.ts does the calls.
 */
import { OneloUser } from './user'
import {
  OneloAuthForbidden,
  OneloAuthInvalidToken,
  OneloAuthRateLimited,
  OneloAuthUnavailable,
} from './errors'

/** The door's refusal for an App whose Sign-in Mode is Onelo Auth. */
const SIGN_IN_MODE_ONELO = 'sign_in_mode_onelo'

/**
 * How long "this App is on Onelo Auth" is remembered. A Sign-in Mode can
 * change only while the App has no App Users, so the answer rarely moves.
 */
const ONELO_AUTH_MEMORY_MS = 5 * 60 * 1000

/**
 * The exchange is not this token's door: the App is on Onelo Auth, or the
 * backend has no exchange endpoint (404/405 from a deployment older than the
 * door). Ask `/user` instead, as before.
 */
export const APP_IS_ON_ONELO_AUTH = Symbol('app-is-on-onelo-auth')

/**
 * Whether a token goes to the exchange rather than to `/user`.
 *
 * An Onelo session token is a JWT whose payload says `type: "sdk_user"`. Any
 * other JWT may be an issuer's. The payload is read WITHOUT verifying it: this
 * only chooses which Onelo endpoint is asked, and that endpoint verifies the
 * token. A forged `type` sends the token to `/user`, which refuses it.
 */
export function isIssuerToken(token: string): boolean {
  const claims = unverifiedClaims(token)
  return claims !== null && claims.type !== 'sdk_user'
}

/** A JWT's payload, read without verifying it. `null` when the token is not a JWT. */
function unverifiedClaims(token: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'))
  } catch {
    return null // not a JWT: an opaque token, as before
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null
  return payload as Record<string, unknown>
}

/** The Onelo session the exchange minted for an issuer token. */
export interface IssuedSession {
  /** An ordinary Onelo session token; `/user` verifies it like any other. */
  accessToken: string
  /** Seconds until it lapses. */
  expiresIn: number
}

/** What the exchange answered: the App User, and the session when it sent one. */
export interface Exchanged {
  user: OneloUser
  session: IssuedSession | null
}

/**
 * For how many seconds the session minted for an issuer token may stand in
 * for it: until the session lapses, and never past the issuer token's own
 * `exp` — a token its issuer no longer honours must not be accepted here.
 * (`exp` is read after Onelo verified the token, so the claim is the signed one.)
 */
export function sessionLifetime(issuerToken: string, session: IssuedSession): number {
  const exp = unverifiedClaims(issuerToken)?.exp
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return session.expiresIn
  return Math.min(session.expiresIn, exp - Date.now() / 1000)
}

function issuedSession(payload: Record<string, unknown>): IssuedSession | null {
  const session = payload.session
  if (session === null || typeof session !== 'object') return null
  const { access_token: accessToken, expires_in: expiresIn } = session as Record<string, unknown>
  if (typeof accessToken !== 'string' || !accessToken) return null
  if (typeof expiresIn !== 'number') return null
  return { accessToken, expiresIn }
}

/** Per client: until when (monotonic ms) its App is known to be on Onelo Auth. */
const oneloAuthUntil = new WeakMap<object, number>()

export function isKnownOneloAuth(client: object): boolean {
  const until = oneloAuthUntil.get(client)
  if (until === undefined) return false
  if (performance.now() < until) return true
  oneloAuthUntil.delete(client)
  return false
}

export function rememberOneloAuth(client: object): void {
  oneloAuthUntil.set(client, performance.now() + ONELO_AUTH_MEMORY_MS)
}

/** The refusal code in `{"detail": {"error": "..."}}`, when the body has one. */
export async function refusalCode(res: Response): Promise<string | null> {
  let body: unknown
  try {
    body = await res.json()
  } catch {
    return null
  }
  if (body === null || typeof body !== 'object') return null
  const detail = (body as Record<string, unknown>).detail
  if (detail === null || typeof detail !== 'object') return null
  // The no-plan gate names its code `error_code`; every other refusal `error`.
  const code = (detail as Record<string, unknown>).error ?? (detail as Record<string, unknown>).error_code
  return typeof code === 'string' && code ? code : null
}

/**
 * Map the exchange's answer to the App User and session, to {@link APP_IS_ON_ONELO_AUTH},
 * or throw the typed auth error. Statuses map as they do for `/user`, with one
 * addition: 409 (`email_in_use`) is a refusal of this person, not an outage.
 * Each error carries the backend's refusal code on `code`.
 */
export async function mapExchangeResponse(
  res: Response,
  retryAfter: number | null,
): Promise<Exchanged | typeof APP_IS_ON_ONELO_AUTH> {
  const status = res.status
  if (status === 200) {
    let payload: unknown
    try {
      payload = await res.json()
    } catch (exc) {
      throw new OneloAuthUnavailable(`backend returned 200 with invalid JSON: ${String(exc)}`)
    }
    const user =
      payload !== null && typeof payload === 'object'
        ? (payload as Record<string, unknown>).user
        : undefined
    if (user === null || typeof user !== 'object' || Array.isArray(user)) {
      throw new OneloAuthUnavailable('backend returned 200 without a user')
    }
    const oneloUser = OneloUser.fromPayload(user as Record<string, unknown>)
    if (!oneloUser.id) throw new OneloAuthUnavailable('backend returned 200 without a user id')
    return { user: oneloUser, session: issuedSession(payload as Record<string, unknown>) }
  }
  // No such endpoint: a backend without it has no external Sign-in Mode either.
  if (status === 404 || status === 405) return APP_IS_ON_ONELO_AUTH

  const code = await refusalCode(res)
  const named = code ?? `status ${status}`
  if (status === 403 && code === SIGN_IN_MODE_ONELO) return APP_IS_ON_ONELO_AUTH
  if (status === 401) throw new OneloAuthInvalidToken(`token refused (${named})`, code)
  if (status === 403 || status === 409) {
    throw new OneloAuthForbidden(`token valid but principal forbidden (${named})`, code)
  }
  if (status === 429) {
    throw new OneloAuthRateLimited(`backend rate-limited auth (${named})`, retryAfter, code)
  }
  if (status >= 500 && status < 600) {
    throw new OneloAuthUnavailable(`backend returned ${status} (${named})`, code)
  }
  throw new OneloAuthUnavailable(`unexpected status ${status}`, code)
}
