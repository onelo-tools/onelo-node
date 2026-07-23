/**
 * PII / secret scrubbing — 1:1 with Python's `onelo.monitor._scrub` (which
 * mirrors the backend denylist). Every event passes through this so secrets in
 * URLs, headers, error strings, and meta never leave the host.
 *
 * ASCII-only lookarounds (not `\b`) so a secret padded with non-ASCII can't
 * escape the boundary; underscore is intentionally NOT a boundary char (it's the
 * env-var separator, so `ENV_sk_live_…` still latches).
 */
export const REDACTED = '[REDACTED]'
const MAX_DEPTH = 10

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
  'x-onelo-secret',
  'www-authenticate',
])

const SENSITIVE_QUERY_KEYS = new Set([
  'token', 'access_token', 'refresh_token', 'id_token',
  'key', 'api_key', 'apikey',
  'secret', 'client_secret',
  'password', 'passwd',
  'auth', 'authorization',
  'code',
  'session',
])

const PII_KEY_SUBSTRINGS = [
  'password', 'passwd', 'secret', 'token', 'api_key', 'apikey',
  'authorization', 'cookie', 'credential', 'private_key',
  'client_secret', 'cvv', 'ssn',
]

const LB = '(?<![A-Za-z0-9])'
const LA = '(?![A-Za-z0-9])'

const VALUE_PATTERNS: RegExp[] = [
  new RegExp(`${LB}Bearer\\s+[A-Za-z0-9\\-._~+/]+=*`, 'gi'),
  new RegExp(`${LB}eyJ[A-Za-z0-9\\-_]+\\.[A-Za-z0-9\\-_]+\\.[A-Za-z0-9\\-_]+${LA}`, 'g'),
  new RegExp(`${LB}(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}${LA}`, 'g'),
  new RegExp(`${LB}onelo_(?:pk|sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}${LA}`, 'g'),
  // Credit cards — separated
  new RegExp(
    `${LB}(?:4[0-9]{3}|5[1-5][0-9]{2}|3[47][0-9]{2}|6(?:011|5[0-9]{2}))[\\s-][0-9]{4}[\\s-][0-9]{4}[\\s-][0-9]{4}${LA}`,
    'g',
  ),
  // Credit cards — unseparated Visa/MC/Discover
  new RegExp(`${LB}(?:4|5[1-5]|6(?:011|5))[0-9]{14,}(?![0-9])`, 'g'),
  // Credit cards — unseparated Amex
  new RegExp(`${LB}3[47][0-9]{13,}(?![0-9])`, 'g'),
]

// Domain labels are `[\w-]+` (NO dot) joined by mandatory literal dots, so every
// quantifier is bounded by an anchor — no overlapping-quantifier backtracking
// (the previous `[\w.-]+\.[A-Za-z]{2,}` form was super-linear / ReDoS). Slightly
// looser than an RFC TLD, but over-redaction is safe for a PII scrubber.
const EMAIL_PATTERN = new RegExp(`${LB}[\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)+${LA}`, 'g')

let strictEmailScrub = false
let extraSensitiveKeys = new Set<string>()

export function setStrictEmailScrub(enabled: boolean): void {
  strictEmailScrub = enabled
}

export function configureSensitiveKeys(names: Iterable<string> | null | undefined): void {
  extraSensitiveKeys = new Set()
  if (names) {
    for (const n of names) extraSensitiveKeys.add(n.toLowerCase().replace(/-/g, '_'))
  }
}

export function isPiiKey(key: string): boolean {
  const normalised = key.toLowerCase().replace(/-/g, '_')
  if (PII_KEY_SUBSTRINGS.some((n) => normalised.includes(n))) return true
  if ([...extraSensitiveKeys].some((n) => normalised.includes(n))) return true
  // segment "key" catches x-anthropic-key etc without matching "monkey".
  return normalised.split('_').includes('key')
}

export function scrubText(text: string | null | undefined): string | null | undefined {
  if (!text) return text
  let out = text
  for (const pattern of VALUE_PATTERNS) out = out.replace(pattern, REDACTED)
  if (strictEmailScrub) out = out.replace(EMAIL_PATTERN, REDACTED)
  return out
}

export function scrubHeaders(
  headers: Record<string, string> | null | undefined,
): Record<string, string> | null | undefined {
  if (!headers) return headers
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) || isPiiKey(k) ? REDACTED : v
  }
  return out
}

export function scrubUrl(url: string | null | undefined): string | null | undefined {
  if (!url) return url
  let parsed: URL
  try {
    // A relative URL needs a base to parse; fall back to text scrub if it fails.
    parsed = new URL(url, url.includes('://') ? undefined : 'http://placeholder.invalid')
  } catch {
    return scrubText(url)
  }
  const wasRelative = !url.includes('://')
  for (const key of [...parsed.searchParams.keys()]) {
    if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) parsed.searchParams.set(key, REDACTED)
  }
  // Path may carry emails/tokens.
  const scrubbedPath = scrubText(parsed.pathname) ?? parsed.pathname
  parsed.pathname = scrubbedPath
  // Fragment (OAuth implicit grant returns #access_token=…).
  if (parsed.hash && parsed.hash.length > 1) {
    const frag = parsed.hash.slice(1)
    if (frag.includes('=')) {
      const fp = new URLSearchParams(frag)
      for (const key of [...fp.keys()]) {
        if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) fp.set(key, REDACTED)
      }
      parsed.hash = '#' + (scrubText(fp.toString()) ?? fp.toString())
    } else {
      parsed.hash = '#' + (scrubText(frag) ?? frag)
    }
  }
  if (wasRelative) {
    return parsed.pathname + parsed.search + parsed.hash
  }
  return parsed.toString()
}

export function scrubMeta(
  meta: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null | undefined {
  if (meta == null) return meta
  const redacted = new Set<string>()
  const cleaned = scrubDict(meta, redacted, 0)
  if (redacted.size > 0) cleaned._onelo_redacted = [...redacted].sort()
  return cleaned
}

function scrubDict(
  value: Record<string, unknown>,
  redacted: Set<string>,
  depth: number,
): Record<string, unknown> {
  if (depth >= MAX_DEPTH) {
    redacted.add('_onelo_depth_exceeded')
    return { _onelo_depth_exceeded: true }
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    if (k === '_onelo_redacted') {
      out[k] = v
      continue
    }
    if (isPiiKey(k)) {
      redacted.add(k)
      out[k] = REDACTED
      continue
    }
    out[k] = scrubValue(v, redacted, depth + 1)
  }
  return out
}

function scrubValue(value: unknown, redacted: Set<string>, depth: number): unknown {
  if (typeof value === 'string') return scrubText(value)
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) {
      redacted.add('_onelo_depth_exceeded')
      return [REDACTED]
    }
    return value.map((v) => scrubValue(v, redacted, depth + 1))
  }
  if (value !== null && typeof value === 'object') {
    return scrubDict(value as Record<string, unknown>, redacted, depth)
  }
  return value
}
