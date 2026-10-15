/**
 * The authenticated Onelo user returned by `GET /api/sdk/auth/user`, or by
 * `POST /api/sdk/auth/exchange` (its `user`) for an App with its own sign-in.
 *
 * Mirrors Python's `onelo.auth.OneloUser`. The backend response schema today is
 * `{ id, email, created_at, metadata }`; `email_verified` and `plan` are not
 * always present at the top level, so `fromPayload` falls back to `metadata`.
 * The full payload is preserved on `raw`.
 */
export class OneloUser {
  constructor(
    /** Stable Onelo user id (`app_user_id` or Supabase user id). */
    readonly id: string,
    /** User's primary email. */
    readonly email: string,
    /** Whether the email is verified. Defaults to `false` when unknown. */
    readonly emailVerified: boolean,
    /** The user's current plan (`free` / `pro` / ...), or `null` if unknown. */
    readonly plan: string | null,
    /** Free-form metadata dict surfaced by the backend. */
    readonly metadata: Record<string, unknown>,
    /** Full JSON payload returned by the backend. */
    readonly raw: Record<string, unknown>,
  ) {}

  /**
   * Map a backend `/api/sdk/auth/user` response to an OneloUser. Tolerant of
   * missing fields — `email_verified` / `plan` fall back to `metadata`.
   */
  static fromPayload(payload: Record<string, unknown>): OneloUser {
    const rawMeta = payload.metadata
    const metadata: Record<string, unknown> =
      rawMeta !== null && typeof rawMeta === 'object' && !Array.isArray(rawMeta)
        ? (rawMeta as Record<string, unknown>)
        : {}

    // email_verified: top-level wins, otherwise metadata, otherwise false.
    let ev = payload.email_verified
    if (ev === undefined || ev === null) ev = metadata.email_verified ?? false
    const emailVerified = Boolean(ev)

    // plan: top-level wins, otherwise metadata.plan, otherwise null.
    let plan = payload.plan
    if (plan === undefined || plan === null) plan = metadata.plan ?? null
    const planValue = plan === undefined || plan === null ? null : (plan as string)

    // `x || ''` mirrors Python's `str(payload.get("id") or "")` — falsy → "".
    const id = payload.id ? String(payload.id) : ''
    const email = payload.email ? String(payload.email) : ''

    return new OneloUser(id, email, emailVerified, planValue, metadata, { ...payload })
  }
}
