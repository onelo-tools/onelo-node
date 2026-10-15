/**
 * #520: per-user Features calls from a server SDK must be signed with the
 * SECRET key. The backend trusts a caller-supplied `userId` only from a
 * secret-key caller (it classifies the key by its `onelo_sk_` prefix, exactly as
 * here). A publishable key is public — anyone can copy it and name any user —
 * so a pk-signed per-user call is refused before it is sent, with the fix in
 * the message. Anonymous/global calls with a publishable key are unaffected.
 */
export function isSecretKeyString(key: string): boolean {
  return key.startsWith('onelo_sk_')
}

export function assertSecretKeyForUser(key: string, call: string): void {
  if (isSecretKeyString(key)) return
  throw new Error(
    `${call} needs the secret key: per-user Features calls from a server are trusted ` +
      'only when signed with a secret key, and this client was configured with a ' +
      'publishable key (onelo_pk_…) — use your secret key (onelo_sk_…) on the server: ' +
      "new Onelo({ secretKey: process.env.ONELO_SECRET_KEY, apiUrl }). " +
      'Anonymous calls (feature(), isEnabled(), declare()) keep working with a publishable key.',
  )
}
