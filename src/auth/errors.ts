/**
 * Onelo auth error taxonomy — 1:1 with the Python SDK (`onelo.auth`).
 *
 * The class hierarchy is load-bearing: adapters map each type to an HTTP
 * status, and the retry loop keys off `OneloAuthUnavailable`. Keep the
 * inheritance exactly as-is:
 *
 *   OneloAuthError
 *   ├── OneloAuthMissingToken   → 401 (no/blank/malformed bearer token)
 *   ├── OneloAuthInvalidToken   → 401 (backend 401: expired/revoked/refused)
 *   ├── OneloAuthForbidden      → 403 (backend 403, a failed gate, or 409 for
 *   │                                  an issuer token: e-mail already in use)
 *   └── OneloAuthUnavailable    → 503 (backend 5xx after retries / network)
 *       └── OneloAuthRateLimited → still 503, but the retry loop skips it
 *
 * Every error carries `code`: the refusal code Onelo named, or `null`.
 */

export class OneloAuthError extends Error {
  /**
   * The refusal code Onelo sent, when it sent one — e.g. `token_expired`,
   * `banned`, `email_in_use` for an issuer token (own sign-in). `null` when
   * the backend named no code.
   */
  readonly code: string | null

  constructor(message?: string, code: string | null = null) {
    super(message)
    this.code = code
    // Restore the prototype chain so `instanceof` works even when this file is
    // transpiled to a target where `extends Error` breaks it. `new.target`
    // resolves to the actual subclass being constructed.
    Object.setPrototypeOf(this, new.target.prototype)
    this.name = new.target.name
  }
}

/** No bearer token was supplied (header missing / malformed / empty). */
export class OneloAuthMissingToken extends OneloAuthError {}

/** Backend returned 401 — token expired, revoked, or malformed. */
export class OneloAuthInvalidToken extends OneloAuthError {}

/**
 * Backend returned 403 — token valid but principal not allowed. Also thrown by
 * the resolver when an authenticated user fails an extra gate
 * (`requireEmailVerified` / `requirePlan`).
 */
export class OneloAuthForbidden extends OneloAuthError {}

/** Onelo backend returned a 5xx (retries exhausted) or the network failed. */
export class OneloAuthUnavailable extends OneloAuthError {}

/**
 * Backend returned 429 Too Many Requests.
 *
 * Subclass of {@link OneloAuthUnavailable} so existing "backend unavailable →
 * 503" handlers keep working — BUT the retry loops treat it specially: they do
 * NOT retry a rate-limit (retrying immediately only makes it worse and burns
 * the wall-clock budget). `retryAfter` carries the parsed `Retry-After`
 * seconds when the backend supplied one, else `null`.
 */
export class OneloAuthRateLimited extends OneloAuthUnavailable {
  readonly retryAfter: number | null

  constructor(message?: string, retryAfter: number | null = null, code: string | null = null) {
    super(message, code)
    this.retryAfter = retryAfter
  }
}
