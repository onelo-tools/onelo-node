// src/auth/cache.ts
var InProcessAuthCache = class {
  store = /* @__PURE__ */ new Map();
  maxSize;
  constructor(maxSize = 1e4) {
    if (maxSize < 1) throw new Error("maxSize must be >= 1");
    this.maxSize = maxSize;
  }
  async get(tokenHash) {
    const entry = this.store.get(tokenHash);
    if (entry === void 0) return null;
    if (performance.now() >= entry.expiry) {
      this.store.delete(tokenHash);
      return null;
    }
    this.store.delete(tokenHash);
    this.store.set(tokenHash, entry);
    return entry.user;
  }
  async set(tokenHash, user, ttl) {
    if (ttl <= 0) return;
    const expiry = performance.now() + ttl * 1e3;
    this.store.delete(tokenHash);
    this.store.set(tokenHash, { user, expiry });
    while (this.store.size > this.maxSize) {
      const oldest = this.store.keys().next().value;
      if (oldest === void 0) break;
      this.store.delete(oldest);
    }
  }
  async invalidate(tokenHash) {
    this.store.delete(tokenHash);
  }
};

// src/auth/errors.ts
var OneloAuthError = class extends Error {
  /**
   * The refusal code Onelo sent, when it sent one — e.g. `token_expired`,
   * `banned`, `email_in_use` for an issuer token (own sign-in). `null` when
   * the backend named no code.
   */
  code;
  constructor(message, code = null) {
    super(message);
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }
};
var OneloAuthMissingToken = class extends OneloAuthError {
};
var OneloAuthInvalidToken = class extends OneloAuthError {
};
var OneloAuthForbidden = class extends OneloAuthError {
};
var OneloAuthUnavailable = class extends OneloAuthError {
};
var OneloAuthRateLimited = class extends OneloAuthUnavailable {
  retryAfter;
  constructor(message, retryAfter = null, code = null) {
    super(message, code);
    this.retryAfter = retryAfter;
  }
};

// src/auth/user.ts
var OneloUser = class _OneloUser {
  constructor(id, email, emailVerified, plan, metadata, raw) {
    this.id = id;
    this.email = email;
    this.emailVerified = emailVerified;
    this.plan = plan;
    this.metadata = metadata;
    this.raw = raw;
  }
  id;
  email;
  emailVerified;
  plan;
  metadata;
  raw;
  /**
   * Map a backend `/api/sdk/auth/user` response to an OneloUser. Tolerant of
   * missing fields — `email_verified` / `plan` fall back to `metadata`.
   */
  static fromPayload(payload) {
    const rawMeta = payload.metadata;
    const metadata = rawMeta !== null && typeof rawMeta === "object" && !Array.isArray(rawMeta) ? rawMeta : {};
    let ev = payload.email_verified;
    if (ev === void 0 || ev === null) ev = metadata.email_verified ?? false;
    const emailVerified = Boolean(ev);
    let plan = payload.plan;
    if (plan === void 0 || plan === null) plan = metadata.plan ?? null;
    const planValue = plan === void 0 || plan === null ? null : plan;
    const id = payload.id ? String(payload.id) : "";
    const email = payload.email ? String(payload.email) : "";
    return new _OneloUser(id, email, emailVerified, planValue, metadata, { ...payload });
  }
};

// src/auth/exchange.ts
var SIGN_IN_MODE_ONELO = "sign_in_mode_onelo";
var ONELO_AUTH_MEMORY_MS = 5 * 60 * 1e3;
var APP_IS_ON_ONELO_AUTH = /* @__PURE__ */ Symbol("app-is-on-onelo-auth");
function isIssuerToken(token) {
  const claims = unverifiedClaims(token);
  return claims !== null && claims.type !== "sdk_user";
}
function unverifiedClaims(token) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  return payload;
}
function sessionLifetime(issuerToken, session) {
  const exp = unverifiedClaims(issuerToken)?.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return session.expiresIn;
  return Math.min(session.expiresIn, exp - Date.now() / 1e3);
}
function issuedSession(payload) {
  const session = payload.session;
  if (session === null || typeof session !== "object") return null;
  const { access_token: accessToken, expires_in: expiresIn } = session;
  if (typeof accessToken !== "string" || !accessToken) return null;
  if (typeof expiresIn !== "number") return null;
  return { accessToken, expiresIn };
}
var oneloAuthUntil = /* @__PURE__ */ new WeakMap();
function isKnownOneloAuth(client) {
  const until = oneloAuthUntil.get(client);
  if (until === void 0) return false;
  if (performance.now() < until) return true;
  oneloAuthUntil.delete(client);
  return false;
}
function rememberOneloAuth(client) {
  oneloAuthUntil.set(client, performance.now() + ONELO_AUTH_MEMORY_MS);
}
async function refusalCode(res) {
  let body;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  if (body === null || typeof body !== "object") return null;
  const detail = body.detail;
  if (detail === null || typeof detail !== "object") return null;
  const code = detail.error ?? detail.error_code;
  return typeof code === "string" && code ? code : null;
}
async function mapExchangeResponse(res, retryAfter) {
  const status = res.status;
  if (status === 200) {
    let payload;
    try {
      payload = await res.json();
    } catch (exc) {
      throw new OneloAuthUnavailable(`backend returned 200 with invalid JSON: ${String(exc)}`);
    }
    const user = payload !== null && typeof payload === "object" ? payload.user : void 0;
    if (user === null || typeof user !== "object" || Array.isArray(user)) {
      throw new OneloAuthUnavailable("backend returned 200 without a user");
    }
    const oneloUser = OneloUser.fromPayload(user);
    if (!oneloUser.id) throw new OneloAuthUnavailable("backend returned 200 without a user id");
    return { user: oneloUser, session: issuedSession(payload) };
  }
  if (status === 404 || status === 405) return APP_IS_ON_ONELO_AUTH;
  const code = await refusalCode(res);
  const named = code ?? `status ${status}`;
  if (status === 403 && code === SIGN_IN_MODE_ONELO) return APP_IS_ON_ONELO_AUTH;
  if (status === 401) throw new OneloAuthInvalidToken(`token refused (${named})`, code);
  if (status === 403 || status === 409) {
    throw new OneloAuthForbidden(`token valid but principal forbidden (${named})`, code);
  }
  if (status === 429) {
    throw new OneloAuthRateLimited(`backend rate-limited auth (${named})`, retryAfter, code);
  }
  if (status >= 500 && status < 600) {
    throw new OneloAuthUnavailable(`backend returned ${status} (${named})`, code);
  }
  throw new OneloAuthUnavailable(`unexpected status ${status}`, code);
}

// src/auth/verify.ts
var BACKOFF_BASE_MS = 100;
function parseRetryAfter(value) {
  if (!value) return null;
  const trimmed = value.trim();
  if (!/^[+-]?\d+(\.\d+)?$/.test(trimmed)) return null;
  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds)) return null;
  return seconds >= 0 ? seconds : null;
}
function extractBearerToken(authorization) {
  if (!authorization) return null;
  const stripped = authorization.trim();
  if (stripped.toLowerCase().startsWith("bearer ")) {
    const token = stripped.slice(7).trim();
    return token || null;
  }
  return null;
}
async function mapResponse(res) {
  const status = res.status;
  if (status === 200) {
    let payload;
    try {
      payload = await res.json();
    } catch (exc) {
      throw new OneloAuthUnavailable(`backend returned 200 with invalid JSON: ${String(exc)}`);
    }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw new OneloAuthUnavailable("backend returned 200 with a non-object body");
    }
    const user = OneloUser.fromPayload(payload);
    if (!user.id) {
      throw new OneloAuthUnavailable("backend returned 200 without a user id");
    }
    return user;
  }
  if (status === 401) throw new OneloAuthInvalidToken("invalid or expired token");
  if (status === 403) throw new OneloAuthForbidden("token valid but principal forbidden", await refusalCode(res));
  if (status === 429) {
    throw new OneloAuthRateLimited(
      "backend rate-limited auth (429)",
      parseRetryAfter(res.headers.get("retry-after"))
    );
  }
  if (status >= 500 && status < 600) throw new OneloAuthUnavailable(`backend returned ${status}`);
  throw new OneloAuthUnavailable(`unexpected status ${status}`);
}
async function verifyToken(client, token) {
  return (await verifyTokenWithSession(client, token)).user;
}
async function verifyTokenWithSession(client, token) {
  if (!token || !token.trim()) throw new OneloAuthMissingToken("token is empty");
  if (!client.isSecretKey) {
    throw new OneloAuthError(
      "verifyToken requires an Onelo client constructed with secretKey: ...; you supplied a publishable key. Backends must use new Onelo({ secretKey: 'onelo_sk_live_...' })."
    );
  }
  const doFetch = client.fetchImpl ?? (typeof fetch === "function" ? fetch : void 0);
  if (!doFetch) {
    throw new OneloAuthUnavailable(
      "global fetch is unavailable \u2014 Node 18+ is required, or pass fetchImpl in the Onelo config."
    );
  }
  if (isIssuerToken(token) && !isKnownOneloAuth(client)) {
    const exchanged = await exchangeIssuerToken(client, token, doFetch);
    if (exchanged !== APP_IS_ON_ONELO_AUTH) return exchanged;
    rememberOneloAuth(client);
  }
  const url = `${client.apiUrl}/api/sdk/auth/user`;
  const headers = {
    Authorization: `Bearer ${token}`,
    // Send both — backend prefers the dedicated header, but the legacy
    // X-Publishable-Key path still works on older deployments.
    "X-Onelo-Secret-Key": client.key,
    "X-Publishable-Key": client.key
  };
  let res;
  try {
    res = await doFetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(client.requestTimeout)
    });
  } catch (exc) {
    throw new OneloAuthUnavailable(`network error: ${String(exc)}`);
  }
  return { user: await mapResponse(res), session: null };
}
async function exchangeIssuerToken(client, token, doFetch) {
  let res;
  try {
    res = await doFetch(`${client.apiUrl}/api/sdk/auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publishableKey: client.key, token }),
      signal: AbortSignal.timeout(client.requestTimeout)
    });
  } catch (exc) {
    throw new OneloAuthUnavailable(`network error: ${String(exc)}`);
  }
  return mapExchangeResponse(res, parseRetryAfter(res.headers.get("retry-after")));
}
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function verifyWithRetry(client, token, options = {}) {
  return (await verifyWithRetryAndSession(client, token, options)).user;
}
async function verifyWithRetryAndSession(client, token, options = {}) {
  const retryAttempts = options.retryAttempts ?? 3;
  const retryTotalTimeout = options.retryTotalTimeout ?? 2e3;
  if (retryAttempts < 1) throw new Error("retryAttempts must be >= 1");
  if (retryTotalTimeout <= 0) throw new Error("retryTotalTimeout must be > 0");
  const deadline = performance.now() + retryTotalTimeout;
  let lastExc = null;
  for (let attempt = 0; attempt < retryAttempts; attempt++) {
    try {
      return await verifyTokenWithSession(client, token);
    } catch (exc) {
      if (!(exc instanceof OneloAuthUnavailable)) throw exc;
      lastExc = exc;
      if (exc instanceof OneloAuthRateLimited) break;
      const nextAttempt = attempt + 1;
      if (nextAttempt >= retryAttempts) break;
      const backoff = BACKOFF_BASE_MS * 2 ** attempt;
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      await sleep(Math.min(backoff, remaining));
      if (performance.now() >= deadline) break;
    }
  }
  throw lastExc;
}

// src/auth/resolve.ts
import { createHash } from "crypto";
var AuthHttpError = class _AuthHttpError extends Error {
  status;
  body;
  constructor(status, body) {
    super(typeof body.error === "string" ? body.error : "auth_error");
    Object.setPrototypeOf(this, _AuthHttpError.prototype);
    this.name = "AuthHttpError";
    this.status = status;
    this.body = body;
  }
};
function hashToken(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
function safeEmit(cb, userId, event) {
  if (!cb) return;
  try {
    cb(userId, event);
  } catch (err) {
    console.warn("[onelo] onAuthEvent callback threw; suppressing.", err);
  }
}
var InProcessSessions = class {
  constructor(maxSize = 1e4) {
    this.maxSize = maxSize;
  }
  maxSize;
  store = /* @__PURE__ */ new Map();
  get(tokenHash) {
    const entry = this.store.get(tokenHash);
    if (entry === void 0) return null;
    if (performance.now() >= entry.expiry) {
      this.store.delete(tokenHash);
      return null;
    }
    return entry.accessToken;
  }
  set(tokenHash, accessToken, lifetime) {
    if (!(lifetime > 0)) return;
    this.store.delete(tokenHash);
    this.store.set(tokenHash, { accessToken, expiry: performance.now() + lifetime * 1e3 });
    while (this.store.size > this.maxSize) {
      const oldest = this.store.keys().next().value;
      if (oldest === void 0) break;
      this.store.delete(oldest);
    }
  }
  delete(tokenHash) {
    this.store.delete(tokenHash);
  }
};
function withReason(body, exc) {
  return exc.code ? { ...body, reason: exc.code } : body;
}
function getMonitor(client) {
  const m = client.monitor;
  return m && typeof m.setUser === "function" && typeof m.hasActiveRequestScope === "function" ? m : null;
}
function createResolver(client, options = {}) {
  if (!client.isSecretKey) {
    throw new Error(
      "This adapter requires an Onelo client constructed with secretKey: ...; you supplied a publishable key. Backends must use new Onelo({ secretKey: 'onelo_sk_live_...' })."
    );
  }
  const retryAttempts = options.retryAttempts ?? 3;
  const retryTotalTimeout = options.retryTotalTimeout ?? 2e3;
  if (retryAttempts < 1) throw new Error("retryAttempts must be >= 1");
  if (retryTotalTimeout <= 0) throw new Error("retryTotalTimeout must be > 0");
  const cache = options.cache ?? new InProcessAuthCache();
  const cacheTtl = options.cacheTtl ?? 30;
  const acceptQueryToken = options.acceptQueryToken ?? false;
  const requireEmailVerified = options.requireEmailVerified ?? false;
  const planSet = options.requirePlan && options.requirePlan.length > 0 ? new Set(options.requirePlan) : null;
  const onAuthEvent = options.onAuthEvent;
  const identifyMonitor = options.identifyMonitor ?? true;
  const monitor = getMonitor(client);
  const inFlight = /* @__PURE__ */ new Map();
  const sessions = new InProcessSessions();
  async function verifyFresh(token, tokenHash) {
    const retry = { retryAttempts, retryTotalTimeout };
    const kept = sessions.get(tokenHash);
    if (kept !== null) {
      try {
        return await verifyWithRetry(client, kept, retry);
      } catch (exc) {
        if (!(exc instanceof OneloAuthInvalidToken)) throw exc;
        sessions.delete(tokenHash);
      }
    }
    const { user, session } = await verifyWithRetryAndSession(client, token, retry);
    if (session !== null) {
      sessions.set(tokenHash, session.accessToken, sessionLifetime(token, session));
    }
    return user;
  }
  function bridgeMonitor(user) {
    if (identifyMonitor && monitor && monitor.hasActiveRequestScope()) {
      monitor.setUser({ id: user.id });
    }
  }
  function checkGates(user) {
    if (requireEmailVerified && !user.emailVerified) throw new OneloAuthForbidden("email_unverified");
    if (planSet !== null && !(user.plan !== null && planSet.has(user.plan))) {
      throw new OneloAuthForbidden("plan");
    }
  }
  function extractToken(authorization, queryToken) {
    if (authorization) return extractBearerToken(authorization);
    if (acceptQueryToken && queryToken) {
      const t = queryToken.trim();
      return t || null;
    }
    return null;
  }
  async function resolve(authorization, queryToken) {
    const token = extractToken(authorization, queryToken);
    if (token === null) {
      safeEmit(onAuthEvent, null, "auth.fail.missing_token");
      throw new AuthHttpError(401, { error: "missing_token" });
    }
    const tokenHash = hashToken(token);
    const cached = await cache.get(tokenHash);
    if (cached !== null) {
      try {
        checkGates(cached);
      } catch (exc) {
        if (exc instanceof OneloAuthForbidden) {
          safeEmit(onAuthEvent, cached.id || null, `auth.fail.${exc.message}`);
          throw new AuthHttpError(403, { error: "forbidden", reason: exc.message });
        }
        throw exc;
      }
      safeEmit(onAuthEvent, cached.id, "auth.verify");
      bridgeMonitor(cached);
      return cached;
    }
    let pending = inFlight.get(tokenHash);
    if (pending === void 0) {
      pending = (async () => {
        const verified = await verifyFresh(token, tokenHash);
        await cache.set(tokenHash, verified, cacheTtl);
        return verified;
      })().finally(() => {
        inFlight.delete(tokenHash);
      });
      inFlight.set(tokenHash, pending);
    }
    let user;
    try {
      user = await pending;
    } catch (exc) {
      if (exc instanceof OneloAuthMissingToken) {
        safeEmit(onAuthEvent, null, "auth.fail.missing_token");
        throw new AuthHttpError(401, { error: "missing_token" });
      }
      if (exc instanceof OneloAuthInvalidToken) {
        safeEmit(onAuthEvent, null, "auth.fail.invalid_token");
        throw new AuthHttpError(401, withReason({ error: "invalid_token" }, exc));
      }
      if (exc instanceof OneloAuthForbidden) {
        safeEmit(onAuthEvent, null, "auth.fail.forbidden");
        throw new AuthHttpError(403, withReason({ error: "forbidden" }, exc));
      }
      if (exc instanceof OneloAuthUnavailable) {
        safeEmit(onAuthEvent, null, "auth.fail.unavailable");
        throw new AuthHttpError(503, { error: "auth_service_unavailable" });
      }
      if (exc instanceof OneloAuthError) {
        safeEmit(onAuthEvent, null, "auth.fail.invalid_token");
        throw new AuthHttpError(401, { error: "invalid_token" });
      }
      throw exc;
    }
    try {
      checkGates(user);
    } catch (exc) {
      if (exc instanceof OneloAuthForbidden) {
        safeEmit(onAuthEvent, user.id || null, `auth.fail.${exc.message}`);
        throw new AuthHttpError(403, { error: "forbidden", reason: exc.message });
      }
      throw exc;
    }
    safeEmit(onAuthEvent, user.id, "auth.verify");
    bridgeMonitor(user);
    return user;
  }
  return { resolve, cache };
}

// src/monitor/scrub.ts
var REDACTED = "[REDACTED]";
var MAX_DEPTH = 10;
var SENSITIVE_HEADERS = /* @__PURE__ */ new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-api-key",
  "x-auth-token",
  "x-onelo-secret",
  "www-authenticate"
]);
var SENSITIVE_QUERY_KEYS = /* @__PURE__ */ new Set([
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "key",
  "api_key",
  "apikey",
  "secret",
  "client_secret",
  "password",
  "passwd",
  "auth",
  "authorization",
  "code",
  "session"
]);
var PII_KEY_SUBSTRINGS = [
  "password",
  "passwd",
  "secret",
  "token",
  "api_key",
  "apikey",
  "authorization",
  "cookie",
  "credential",
  "private_key",
  "client_secret",
  "cvv",
  "ssn"
];
var LB = "(?<![A-Za-z0-9])";
var LA = "(?![A-Za-z0-9])";
var VALUE_PATTERNS = [
  new RegExp(`${LB}Bearer\\s+[A-Za-z0-9\\-._~+/]+=*`, "gi"),
  new RegExp(`${LB}eyJ[A-Za-z0-9\\-_]+\\.[A-Za-z0-9\\-_]+\\.[A-Za-z0-9\\-_]+${LA}`, "g"),
  new RegExp(`${LB}(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}${LA}`, "g"),
  new RegExp(`${LB}onelo_(?:pk|sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}${LA}`, "g"),
  // Credit cards — separated
  new RegExp(
    `${LB}(?:4[0-9]{3}|5[1-5][0-9]{2}|3[47][0-9]{2}|6(?:011|5[0-9]{2}))[\\s-][0-9]{4}[\\s-][0-9]{4}[\\s-][0-9]{4}${LA}`,
    "g"
  ),
  // Credit cards — unseparated Visa/MC/Discover
  new RegExp(`${LB}(?:4|5[1-5]|6(?:011|5))[0-9]{14,}(?![0-9])`, "g"),
  // Credit cards — unseparated Amex
  new RegExp(`${LB}3[47][0-9]{13,}(?![0-9])`, "g")
];
var EMAIL_PATTERN = new RegExp(`${LB}[\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)+${LA}`, "g");
var strictEmailScrub = false;
var extraSensitiveKeys = /* @__PURE__ */ new Set();
function setStrictEmailScrub(enabled) {
  strictEmailScrub = enabled;
}
function configureSensitiveKeys(names) {
  extraSensitiveKeys = /* @__PURE__ */ new Set();
  if (names) {
    for (const n of names) extraSensitiveKeys.add(n.toLowerCase().replace(/-/g, "_"));
  }
}
function isPiiKey(key) {
  const normalised = key.toLowerCase().replace(/-/g, "_");
  if (PII_KEY_SUBSTRINGS.some((n) => normalised.includes(n))) return true;
  if ([...extraSensitiveKeys].some((n) => normalised.includes(n))) return true;
  return normalised.split("_").includes("key");
}
function scrubText(text) {
  if (!text) return text;
  let out = text;
  for (const pattern of VALUE_PATTERNS) out = out.replace(pattern, REDACTED);
  if (strictEmailScrub) out = out.replace(EMAIL_PATTERN, REDACTED);
  return out;
}
function scrubHeaders(headers) {
  if (!headers) return headers;
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) || isPiiKey(k) ? REDACTED : v;
  }
  return out;
}
function scrubUrl(url) {
  if (!url) return url;
  let parsed;
  try {
    parsed = new URL(url, url.includes("://") ? void 0 : "http://placeholder.invalid");
  } catch {
    return scrubText(url);
  }
  const wasRelative = !url.includes("://");
  for (const key of [...parsed.searchParams.keys()]) {
    if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) parsed.searchParams.set(key, REDACTED);
  }
  const scrubbedPath = scrubText(parsed.pathname) ?? parsed.pathname;
  parsed.pathname = scrubbedPath;
  if (parsed.hash && parsed.hash.length > 1) {
    const frag = parsed.hash.slice(1);
    if (frag.includes("=")) {
      const fp = new URLSearchParams(frag);
      for (const key of [...fp.keys()]) {
        if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) fp.set(key, REDACTED);
      }
      parsed.hash = "#" + (scrubText(fp.toString()) ?? fp.toString());
    } else {
      parsed.hash = "#" + (scrubText(frag) ?? frag);
    }
  }
  if (wasRelative) {
    return parsed.pathname + parsed.search + parsed.hash;
  }
  return parsed.toString();
}
function scrubMeta(meta) {
  if (meta == null) return meta;
  const redacted = /* @__PURE__ */ new Set();
  const cleaned = scrubDict(meta, redacted, 0);
  if (redacted.size > 0) cleaned._onelo_redacted = [...redacted].sort();
  return cleaned;
}
function scrubDict(value, redacted, depth) {
  if (depth >= MAX_DEPTH) {
    redacted.add("_onelo_depth_exceeded");
    return { _onelo_depth_exceeded: true };
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === "_onelo_redacted") {
      out[k] = v;
      continue;
    }
    if (isPiiKey(k)) {
      redacted.add(k);
      out[k] = REDACTED;
      continue;
    }
    out[k] = scrubValue(v, redacted, depth + 1);
  }
  return out;
}
function scrubValue(value, redacted, depth) {
  if (typeof value === "string") return scrubText(value);
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) {
      redacted.add("_onelo_depth_exceeded");
      return [REDACTED];
    }
    return value.map((v) => scrubValue(v, redacted, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    return scrubDict(value, redacted, depth);
  }
  return value;
}

export {
  InProcessAuthCache,
  OneloAuthError,
  OneloAuthMissingToken,
  OneloAuthInvalidToken,
  OneloAuthForbidden,
  OneloAuthUnavailable,
  OneloAuthRateLimited,
  OneloUser,
  APP_IS_ON_ONELO_AUTH,
  mapExchangeResponse,
  parseRetryAfter,
  extractBearerToken,
  verifyToken,
  verifyWithRetry,
  AuthHttpError,
  createResolver,
  setStrictEmailScrub,
  configureSensitiveKeys,
  scrubText,
  scrubHeaders,
  scrubUrl,
  scrubMeta
};
