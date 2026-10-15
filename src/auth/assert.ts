/**
 * The server assertion (#800, ADR-0032). For an App in an external Sign-in
 * Mode whose backend has no issuer tokens (classic server sessions): the
 * developer's server says "this is App User external id X with e-mail Y" with
 * an identity-only key (`onelo_ik_…`) and gets back an ordinary Onelo session
 * for that External Identity — 30 minutes, no refresh token.
 *
 * The identity-only key can do nothing but this. It is not a Secret Key, so it
 * is not part of the `Onelo` client: it is passed here and nowhere else. It is
 * a server credential, so this function refuses to run in a browser.
 */
import { OneloUser } from './user'
import { OneloAuthError, OneloAuthForbidden, OneloAuthUnavailable } from './errors'
import { APP_IS_ON_ONELO_AUTH, mapExchangeResponse, type IssuedSession } from './exchange'
import { parseRetryAfter, type FetchLike } from './verify'

const IDENTITY_KEY_PREFIX = 'onelo_ik_'
const DEFAULT_TIMEOUT_MS = 10_000

export interface AssertIdentityOptions {
  /** Your Onelo API URL. Required, no default. */
  apiUrl: string
  /** The identity-only key (`onelo_ik_…`) from the dashboard's API Keys page. */
  identityKey: string
  /** Your own id for the user. The External Identity is (App, issuer, this id). */
  externalId: string
  /** The user's e-mail, when you have one. */
  email?: string
  /** Whether YOUR server verified that e-mail. Default false. */
  emailVerified?: boolean
  /** Optional `fetch` override (tests / custom transport). */
  fetchImpl?: FetchLike
  /** Request timeout in ms. Default 10000. */
  timeoutMs?: number
}

/** The App User and the Onelo session minted for them. */
export interface AssertedIdentity {
  user: OneloUser
  session: IssuedSession
}

/** True in a browser build: a page has both `window` and `document`. */
function inBrowser(): boolean {
  const g = globalThis as Record<string, unknown>
  return typeof g.window !== 'undefined' && typeof g.document !== 'undefined'
}

function apiBase(apiUrl: string): string {
  let parsed: URL | null = null
  try {
    parsed = apiUrl ? new URL(apiUrl) : null
  } catch {
    parsed = null
  }
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    throw new Error(`assertIdentity requires apiUrl as an http(s) URL, got ${JSON.stringify(apiUrl)}.`)
  }
  return apiUrl.replace(/\/+$/, '')
}

/**
 * `POST /api/sdk/auth/assert`: sign the user your server already knows into
 * Onelo. Throws the auth error taxonomy, each error carrying Onelo's refusal
 * `code` (`invalid_identity_key`, `ip_not_allowed`, `sign_in_mode_onelo`,
 * `banned`, `email_in_use`, `rate_limited`, …).
 */
export async function assertIdentity(options: AssertIdentityOptions): Promise<AssertedIdentity> {
  if (inBrowser()) {
    throw new OneloAuthError(
      'assertIdentity runs only on your server: the identity key must never reach a browser.',
      'browser_not_allowed',
    )
  }
  const base = apiBase(options.apiUrl)
  const key = options.identityKey
  if (!key) throw new Error('assertIdentity requires identityKey (onelo_ik_…).')
  if (!key.startsWith(IDENTITY_KEY_PREFIX)) {
    throw new Error('assertIdentity takes an identity key (onelo_ik_…), not a Secret or Publishable Key.')
  }
  if (!options.externalId || !options.externalId.trim()) {
    throw new Error('assertIdentity requires externalId.')
  }

  const body: Record<string, unknown> = {
    identityKey: key,
    externalId: options.externalId,
    emailVerified: options.emailVerified === true,
  }
  if (options.email !== undefined) body.email = options.email

  const doFetch: FetchLike = options.fetchImpl ?? (globalThis.fetch as FetchLike)
  let res: Response
  try {
    res = await doFetch(`${base}/api/sdk/auth/assert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
  } catch (exc) {
    throw new OneloAuthUnavailable(`network error: ${String(exc).split(key).join('[identity key]')}`)
  }

  // A backend without the endpoint: not a refusal of this user.
  if (res.status === 404 || res.status === 405) {
    throw new OneloAuthUnavailable(`backend has no assertion endpoint (status ${res.status})`)
  }
  if (res.status === 400) {
    const code = await bodyCode(res)
    throw new OneloAuthError(`assertion refused (${code ?? 'status 400'})`, code)
  }
  const answer = await mapExchangeResponse(res, parseRetryAfter(res.headers.get('retry-after')))
  if (answer === APP_IS_ON_ONELO_AUTH) {
    // The exchange treats this as "ask /user instead"; an assertion has no such fallback.
    throw new OneloAuthForbidden(
      'assertion refused (sign_in_mode_onelo): the App uses Onelo Auth',
      'sign_in_mode_onelo',
    )
  }
  if (!answer.session) throw new OneloAuthUnavailable('backend returned 200 without a session')
  return { user: answer.user, session: answer.session }
}

async function bodyCode(res: Response): Promise<string | null> {
  try {
    const detail = ((await res.json()) as { detail?: { error?: unknown } }).detail
    return typeof detail?.error === 'string' && detail.error ? detail.error : null
  } catch {
    return null
  }
}
