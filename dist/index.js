"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  AuthHttpError: () => AuthHttpError,
  Breadcrumbs: () => Breadcrumbs,
  Feature: () => Feature,
  InProcessAuthCache: () => InProcessAuthCache,
  Onelo: () => Onelo,
  OneloAuthError: () => OneloAuthError,
  OneloAuthForbidden: () => OneloAuthForbidden,
  OneloAuthInvalidToken: () => OneloAuthInvalidToken,
  OneloAuthMissingToken: () => OneloAuthMissingToken,
  OneloAuthRateLimited: () => OneloAuthRateLimited,
  OneloAuthUnavailable: () => OneloAuthUnavailable,
  OneloUser: () => OneloUser,
  UserFeatures: () => UserFeatures,
  VERSION: () => VERSION,
  createResolver: () => createResolver,
  extractBearerToken: () => extractBearerToken,
  getInstanceId: () => getInstanceId,
  installConsoleCapture: () => installConsoleCapture,
  installFetchBreadcrumbs: () => installFetchBreadcrumbs,
  parseRetryAfter: () => parseRetryAfter2,
  verifyToken: () => verifyToken,
  verifyWithRetry: () => verifyWithRetry
});
module.exports = __toCommonJS(index_exports);

// src/features/cache.ts
var FeatureCache = class {
  features = /* @__PURE__ */ new Map();
  _configVersion = 0;
  /** Canonicalise a per-feature value: full wire dict (copied) or bare status string. */
  normalize(value) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return { ...value };
    }
    return { status: String(value) };
  }
  /** Full wire state dict for `name`, or `{status:'hidden'}` on miss. Defensive copy. */
  getState(name) {
    const state = this.features.get(name);
    return state !== void 0 ? { ...state } : { status: "hidden" };
  }
  /** Wire status string for `name`, or 'hidden' on miss. Status-only convenience. */
  get(name) {
    const state = this.features.get(name);
    if (state === void 0) return "hidden";
    return typeof state.status === "string" ? state.status : "hidden";
  }
  /** Atomically replace the entire snapshot. Values may be dicts or status strings. */
  replaceAll(features, version) {
    const next = /* @__PURE__ */ new Map();
    for (const [name, value] of Object.entries(features ?? {})) {
      next.set(name, this.normalize(value));
    }
    this.features = next;
    this._configVersion = Number.isFinite(version) ? version : 0;
  }
  get configVersion() {
    return this._configVersion;
  }
  /**
   * Stable `{ name: status }` copy. Status-only by design — used by the monitor
   * module to stamp active flag values on captured events (F3).
   */
  snapshot() {
    const out = {};
    for (const [name, state] of this.features) {
      out[name] = typeof state.status === "string" ? state.status : "hidden";
    }
    return out;
  }
};

// src/version.ts
var VERSION = "0.5.0-staging";

// src/features/consumer.ts
var SDK_PLATFORM = "node";
var USER_AGENT = `onelo-node/${VERSION}`;
function resolveFetch(fetchImpl) {
  return fetchImpl ?? (typeof fetch === "function" ? fetch : null);
}

// src/features/feature.ts
var ENABLED_STATUSES = /* @__PURE__ */ new Set(["enabled", "new", "beta"]);
var VISIBLE_STATUSES = /* @__PURE__ */ new Set(["enabled", "new", "beta", "coming_soon", "greyed", "upsell"]);
var KNOWN_STATUSES = /* @__PURE__ */ new Set([...VISIBLE_STATUSES, "hidden"]);
var GATED_STATUSES = /* @__PURE__ */ new Set(["upsell", "greyed"]);
function str(value, fallback = "") {
  return typeof value === "string" ? value : value == null ? fallback : String(value);
}
var Feature = class _Feature {
  constructor(name, status, reason = null, requiredPlan = null, requiredPlanLabel = null, upgradeCta = false) {
    this.name = name;
    this.status = status;
    this.reason = reason;
    this.requiredPlan = requiredPlan;
    this.requiredPlanLabel = requiredPlanLabel;
    this.upgradeCta = upgradeCta;
  }
  name;
  status;
  reason;
  requiredPlan;
  requiredPlanLabel;
  upgradeCta;
  /**
   * Build a Feature from a backend wire state dict. Tolerates a bare status
   * string, ignores unknown extra keys (forward-compat). Missing status →
   * hidden (fail-closed).
   */
  static fromWire(name, state) {
    if (state === null || typeof state !== "object" || Array.isArray(state)) {
      return new _Feature(name, str(state, "hidden") || "hidden");
    }
    const s = state;
    return new _Feature(
      name,
      typeof s.status === "string" ? s.status : "hidden",
      s.reason == null ? null : String(s.reason),
      s.required_plan == null ? null : String(s.required_plan),
      s.required_plan_label == null ? null : String(s.required_plan_label),
      Boolean(s.upgrade_cta)
    );
  }
  /** True for enabled / new / beta — the default check for binary gating. */
  get isEnabled() {
    return ENABLED_STATUSES.has(this.status);
  }
  /**
   * True for any user-visible status. False for hidden AND for any status this
   * SDK build does not recognise — fail-closed, so a typo or a newer backend
   * status never renders as a blank visible item.
   */
  get isVisible() {
    return VISIBLE_STATUSES.has(this.status);
  }
  get isGreyed() {
    return this.status === "greyed";
  }
  get isNew() {
    return this.status === "new";
  }
  get isBeta() {
    return this.status === "beta";
  }
  get isComingSoon() {
    return this.status === "coming_soon";
  }
  /** Feature is in upsell mode — a paid/locked teaser shown to the user. */
  get isUpsell() {
    return this.status === "upsell";
  }
  /**
   * True if `status` is one this SDK build understands. False means the backend
   * returned a status newer than this SDK (treated as hidden) — surface it as a
   * hint to upgrade the SDK.
   */
  get isKnown() {
    return KNOWN_STATUSES.has(this.status);
  }
  /**
   * The human plan LABEL to show as an upsell (e.g. "Pro"), or null when the
   * backend attached no label. Render as `Available in ${feature.upgradeHint}`.
   * The backend is the authority — it attaches the label only to a
   * blocked-but-visible feature a real upgrade would unlock.
   */
  get upgradeHint() {
    return this.requiredPlanLabel || null;
  }
};
var UserFeatures = class {
  constructor(userId, states) {
    this.userId = userId;
    this.states = states;
  }
  userId;
  states;
  /** This feature's state (incl. upsell metadata) FOR THIS USER. Missing → hidden. */
  feature(name) {
    return Feature.fromWire(name, this.states[name] ?? { status: "hidden" });
  }
  /** Shorthand for `feature(name).isEnabled`. */
  isEnabled(name) {
    return this.feature(name).isEnabled;
  }
};

// src/features/user-snapshot-cache.ts
var USER_SNAPSHOT_MAX_ENTRIES = 1e4;
var UserSnapshotCache = class {
  constructor(maxEntries = USER_SNAPSHOT_MAX_ENTRIES) {
    this.maxEntries = maxEntries;
  }
  maxEntries;
  map = /* @__PURE__ */ new Map();
  get(userId) {
    const entry = this.map.get(userId);
    if (entry === void 0) return null;
    if (entry.deadline > performance.now()) return entry.snapshot;
    this.map.delete(userId);
    return null;
  }
  put(userId, snapshot, ttlSeconds) {
    this.map.set(userId, { deadline: performance.now() + ttlSeconds * 1e3, snapshot });
    if (this.map.size > this.maxEntries) this.evict();
  }
  evict() {
    const now = performance.now();
    for (const [k, entry] of this.map) {
      if (entry.deadline <= now) this.map.delete(k);
    }
    const overflow = this.map.size - this.maxEntries;
    if (overflow > 0) {
      const soonest = [...this.map.entries()].sort((a, b) => a[1].deadline - b[1].deadline).slice(0, overflow);
      for (const [k] of soonest) this.map.delete(k);
    }
  }
  invalidate(userId) {
    this.map.delete(userId);
  }
  clear() {
    this.map.clear();
  }
};

// src/features/client.ts
var warn = (...args) => console.warn("[onelo.features]", ...args);
var FeaturesClient = class {
  constructor(opts) {
    this.opts = opts;
  }
  opts;
  discovered = /* @__PURE__ */ new Set();
  userCache = new UserSnapshotCache();
  warnedGated = /* @__PURE__ */ new Set();
  /**
   * The Feature for `name`. Cache miss → hidden (fail-closed). Side effect: the
   * first sighting of `name` schedules a debounced batch-ping and lazily starts
   * the background stream. Mirrors Swift/Python `feature(_:)`.
   */
  feature(name) {
    this.opts.ensureStarted();
    if (!this.discovered.has(name)) {
      this.discovered.add(name);
      this.opts.scheduleBatchPing();
    }
    const state = this.opts.cache.getState(name);
    const status = typeof state.status === "string" ? state.status : "hidden";
    if (GATED_STATUSES.has(status)) this.maybeWarnGated(name, status);
    return Feature.fromWire(name, state);
  }
  /** Shorthand for `feature(name).isEnabled`. */
  isEnabled(name) {
    return this.feature(name).isEnabled;
  }
  /**
   * Register feature names so they appear in the dashboard registry without
   * waiting for a code path to execute. Same debounce as `feature()`.
   */
  declare(names) {
    this.opts.ensureStarted();
    let added = false;
    for (const name of names) {
      if (!this.discovered.has(name)) {
        this.discovered.add(name);
        added = true;
      }
    }
    if (added) this.opts.scheduleBatchPing();
  }
  /** Slug names this process has ever asked about (drives the batch-ping). */
  snapshotDiscovered() {
    return [...this.discovered];
  }
  /** Block until the first backend snapshot lands (or timeout). Default 1500ms. */
  ready(timeoutMs = 1500) {
    this.opts.ensureStarted();
    return this.opts.ready(timeoutMs);
  }
  /**
   * Resolve features for a SPECIFIC user — the multi-user-safe path. Stateless
   * POST /resolve for THIS user; never touches global identity. Cached per-user
   * for `ttl` seconds. Fail-closed: any network/HTTP error → every feature
   * hidden (empty snapshot). Throws only for an empty user_id (programmer error).
   */
  async forUser(userId, options = {}) {
    if (!userId) throw new Error("forUser requires a non-empty userId");
    let snapshot = this.userCache.get(userId);
    if (snapshot === null) {
      snapshot = await this.resolveUser(userId);
      this.userCache.put(userId, snapshot, options.ttl ?? 30);
    }
    return new UserFeatures(userId, snapshot);
  }
  async resolveUser(userId) {
    if (!this.opts.apiUrl || !this.opts.publishableKey) {
      warn("forUser: SDK missing apiUrl/key \u2014 resolving empty");
      return {};
    }
    const doFetch = resolveFetch(this.opts.fetchImpl);
    if (!doFetch) {
      warn("forUser: global fetch unavailable \u2014 resolving empty");
      return {};
    }
    const body = {
      publishableKey: this.opts.publishableKey,
      userId,
      sdk_platform: SDK_PLATFORM,
      sdk_version: VERSION
    };
    if (this.opts.featureEnvironment !== null) body.environment = this.opts.featureEnvironment;
    try {
      const res = await doFetch(`${this.opts.apiUrl}/api/sdk/features/resolve`, {
        method: "POST",
        headers: { "User-Agent": USER_AGENT, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.requestTimeout)
      });
      if (!res.ok) {
        warn(`forUser resolve failed (fail-closed \u2192 hidden): HTTP ${res.status}`);
        return {};
      }
      const data = await res.json();
      const feats = data?.features;
      if (feats === null || typeof feats !== "object" || Array.isArray(feats)) return {};
      const out = {};
      for (const [name, state] of Object.entries(feats)) {
        out[name] = state !== null && typeof state === "object" && !Array.isArray(state) ? { ...state } : { status: String(state) };
      }
      return out;
    } catch (err) {
      warn("forUser resolve failed (fail-closed \u2192 hidden):", err);
      return {};
    }
  }
  /**
   * Drop the cached per-user snapshot so the NEXT `forUser(userId)` re-fetches.
   * Call it the moment your backend learns a user's plan changed. Pass a userId
   * to invalidate one user, or nothing to clear EVERY cached user.
   */
  invalidateUser(userId) {
    if (userId === void 0) this.userCache.clear();
    else this.userCache.invalidate(userId);
  }
  maybeWarnGated(name, status) {
    if (process.env.ONELO_SUPPRESS_GATING_WARNING) return;
    if (this.warnedGated.has(name)) return;
    this.warnedGated.add(name);
    warn(
      `feature('${name}') resolved to '${status}' under the process-global identity. On a multi-user backend resolve per request instead \u2014 await onelo.features.forUser(userId).then(u => u.feature('${name}')) \u2014 so plan gating is evaluated for the actual user, not a shared identity. (Set ONELO_SUPPRESS_GATING_WARNING=1 to silence if this is intentional.)`
    );
  }
};

// src/features/detection.ts
var VALID_STRATEGIES = /* @__PURE__ */ new Set(["auto", "sse", "polling"]);
var DEFERRED_STRATEGIES = /* @__PURE__ */ new Set(["redis"]);
function resolveStrategy(strategy) {
  if (DEFERRED_STRATEGIES.has(strategy)) {
    throw new Error(
      `strategy='${strategy}' is not supported in v1. Use 'sse' or 'polling'. A Redis pub/sub coordinator may land in v1.x.`
    );
  }
  if (!VALID_STRATEGIES.has(strategy)) {
    throw new Error(`strategy must be one of 'auto', 'sse', 'polling', got '${strategy}'.`);
  }
  return strategy === "auto" ? "sse" : strategy;
}

// src/features/instance.ts
var import_node_crypto = require("crypto");
var import_node_fs = require("fs");
var import_node_os = require("os");
var import_node_path = require("path");
var cachedFileId = null;
var ephemeralId = null;
function instanceDir() {
  return process.env.ONELO_INSTANCE_DIR || (0, import_node_path.join)((0, import_node_os.homedir)(), ".onelo");
}
function getInstanceId() {
  const env = process.env.ONELO_INSTANCE_ID;
  if (env) return env;
  if (cachedFileId) return cachedFileId;
  try {
    const dir = instanceDir();
    (0, import_node_fs.mkdirSync)(dir, { recursive: true });
    const file = (0, import_node_path.join)(dir, "onelo-instance-id");
    if ((0, import_node_fs.existsSync)(file)) {
      const existing = (0, import_node_fs.readFileSync)(file, "utf8").trim();
      if (existing) {
        cachedFileId = existing;
        return existing;
      }
    }
    const id = (0, import_node_crypto.randomUUID)();
    (0, import_node_fs.writeFileSync)(file, id);
    cachedFileId = id;
    return id;
  } catch {
    if (!ephemeralId) ephemeralId = (0, import_node_crypto.randomUUID)();
    return ephemeralId;
  }
}

// src/features/polling-consumer.ts
var warn2 = (...args) => console.warn("[onelo.features]", ...args);
var PollingConsumer = class {
  constructor(opts) {
    this.opts = opts;
    this.intervalMs = (opts.pollIntervalSeconds ?? 30) * 1e3;
  }
  opts;
  stopped = false;
  intervalMs;
  wakeResolvers = [];
  controller = null;
  stop() {
    this.stopped = true;
    this.controller?.abort();
    this.wake();
  }
  // Polling reads getUserId() fresh each cycle, so an identify() is picked up
  // naturally within one interval — no forced reconnect needed.
  forceReconnect() {
  }
  wake() {
    const resolvers = this.wakeResolvers;
    this.wakeResolvers = [];
    for (const r of resolvers) r();
  }
  waitInterruptible(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.wakeResolvers = this.wakeResolvers.filter((r) => r !== onWake);
        resolve();
      }, ms);
      t.unref?.();
      const onWake = () => {
        clearTimeout(t);
        resolve();
      };
      this.wakeResolvers.push(onWake);
    });
  }
  async run() {
    while (!this.stopped) {
      await this.pollOnce();
      if (this.stopped) break;
      await this.waitInterruptible(this.intervalMs);
    }
  }
  buildUrl() {
    const params = new URLSearchParams({
      key: this.opts.key,
      since_version: String(this.opts.cache.configVersion)
    });
    if (this.opts.featureEnvironment !== null) {
      params.set("environment", this.opts.featureEnvironment);
    }
    const userId = this.opts.getUserId();
    if (userId !== null) params.set("userId", userId);
    return `${this.opts.apiUrl}/api/sdk/features/poll?${params.toString()}`;
  }
  async pollOnce() {
    const doFetch = resolveFetch(this.opts.fetchImpl);
    if (!doFetch) {
      warn2("global fetch unavailable \u2014 Node 18+ required or pass fetchImpl");
      return;
    }
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), this.opts.requestTimeout);
    timeout.unref?.();
    let res;
    try {
      res = await doFetch(this.buildUrl(), {
        method: "GET",
        headers: { "User-Agent": USER_AGENT },
        signal: controller.signal
      });
    } catch {
      return;
    } finally {
      clearTimeout(timeout);
      this.controller = null;
    }
    if (res.status === 304) {
      this.opts.onFirstEvent();
      return;
    }
    if (res.status === 200) {
      let data;
      try {
        data = await res.json();
      } catch (err) {
        warn2("poll response not JSON:", err);
        return;
      }
      if (data === null || typeof data !== "object" || Array.isArray(data)) {
        warn2("poll response not a JSON object");
        return;
      }
      const body = data;
      if (body.up_to_date || !("features" in body)) {
        this.maybeRequestDiscovery(body);
        this.opts.onFirstEvent();
        return;
      }
      const feats = body.features;
      if (feats === null || typeof feats !== "object" || Array.isArray(feats) || body.config_version == null) {
        warn2("poll response malformed features/config_version");
        return;
      }
      try {
        this.opts.cache.replaceAll(feats, Number(body.config_version));
      } catch (err) {
        warn2("poll response malformed:", err);
        return;
      }
      this.maybeRequestDiscovery(body);
      this.opts.onFirstEvent();
    } else if (res.status === 401) {
      warn2("poll: 401 Unauthorized \u2014 check the SDK key");
    } else if (res.status >= 500 && res.status < 600) {
      warn2(`poll: ${res.status} server error`);
    }
  }
  maybeRequestDiscovery(body) {
    if (!body.discovery_requested || !this.opts.onDiscoveryRequested) return;
    try {
      this.opts.onDiscoveryRequested();
    } catch (err) {
      warn2("discovery_requested handler failed:", err);
    }
  }
};

// src/features/sse-parser.ts
var SseParser = class {
  buffer = "";
  eventType = "";
  dataLines = [];
  /** Feed a text chunk; return any events completed by it. */
  push(chunk) {
    this.buffer += chunk;
    const events = [];
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const rawLine of lines) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line === "") {
        if (this.dataLines.length > 0 || this.eventType !== "") {
          events.push({ event: this.eventType, data: this.dataLines.join("\n") });
        }
        this.eventType = "";
        this.dataLines = [];
        continue;
      }
      if (line.startsWith(":")) {
        continue;
      }
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") this.eventType = value;
      else if (field === "data") this.dataLines.push(value);
    }
    return events;
  }
};

// src/features/sse-consumer.ts
var DEFAULT_BACKOFF_SECONDS = [1, 2, 4, 8, 16, 30];
var STALE_THRESHOLD_MS = 9e4;
var HEALTHCHECK_INTERVAL_MS = 3e4;
var TerminalAuthError = class extends Error {
  constructor(status) {
    super(`features stream auth failed: HTTP ${status}`);
    this.status = status;
  }
  status;
};
var warn3 = (...args) => console.warn("[onelo.features]", ...args);
var INTERRUPT = /* @__PURE__ */ Symbol("interrupt");
var SseConsumer = class {
  constructor(opts) {
    this.opts = opts;
  }
  opts;
  stopped = false;
  reconnectRequested = false;
  controller = null;
  lastEventAt = performance.now();
  healthcheckTimer = null;
  wakeResolvers = [];
  interruptRead = null;
  stop() {
    this.stopped = true;
    this.interrupt();
  }
  forceReconnect() {
    this.reconnectRequested = true;
    this.interrupt();
  }
  /** Interrupt the in-flight read AND any backoff sleep. */
  interrupt() {
    this.interruptRead?.();
    this.controller?.abort();
    this.wake();
  }
  wake() {
    const resolvers = this.wakeResolvers;
    this.wakeResolvers = [];
    for (const r of resolvers) r();
  }
  waitInterruptible(ms) {
    return new Promise((resolve) => {
      const onWake = () => {
        clearTimeout(t);
        resolve();
      };
      const t = setTimeout(() => {
        this.wakeResolvers = this.wakeResolvers.filter((r) => r !== onWake);
        resolve();
      }, ms);
      this.wakeResolvers.push(onWake);
    });
  }
  async run() {
    this.lastEventAt = performance.now();
    this.startHealthcheck();
    let attempt = 0;
    try {
      while (!this.stopped) {
        this.reconnectRequested = false;
        let networkError = false;
        try {
          await this.connectAndConsume();
        } catch (err) {
          if (err instanceof TerminalAuthError) {
            warn3(
              `stream stopped: authentication failed (HTTP ${err.status}). The key is invalid or revoked \u2014 fix it and re-initialise the SDK. Not retrying.`
            );
            return;
          }
          if (!isAbortError(err)) networkError = true;
        }
        if (this.stopped) break;
        if (this.reconnectRequested) {
          attempt = 0;
          continue;
        }
        if (!networkError) attempt = 0;
        const base = DEFAULT_BACKOFF_SECONDS[Math.min(attempt, DEFAULT_BACKOFF_SECONDS.length - 1)];
        const delay = Math.random() * base * 1e3;
        attempt++;
        await this.waitInterruptible(delay);
      }
    } finally {
      if (this.healthcheckTimer) {
        clearTimeout(this.healthcheckTimer);
        this.healthcheckTimer = null;
      }
    }
  }
  buildUrl() {
    const params = new URLSearchParams({
      key: this.opts.key,
      since_version: String(this.opts.cache.configVersion),
      instance_id: getInstanceId(),
      sdk_platform: SDK_PLATFORM,
      sdk_version: VERSION
    });
    if (this.opts.appVersion) params.set("app_version", this.opts.appVersion);
    if (this.opts.featureEnvironment !== null) {
      params.set("environment", this.opts.featureEnvironment);
    }
    const userId = this.opts.getUserId();
    if (userId !== null) params.set("userId", userId);
    return `${this.opts.apiUrl}/api/sdk/features/stream?${params.toString()}`;
  }
  async connectAndConsume() {
    const doFetch = resolveFetch(this.opts.fetchImpl);
    if (!doFetch) throw new Error("global fetch unavailable \u2014 Node 18+ required or pass fetchImpl");
    this.controller = new AbortController();
    this.lastEventAt = performance.now();
    const res = await doFetch(this.buildUrl(), {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/event-stream",
        "X-Onelo-Instance-Id": getInstanceId()
      },
      signal: this.controller.signal
    });
    if (res.status === 401 || res.status === 403) throw new TerminalAuthError(res.status);
    if (!res.ok || !res.body) throw new Error(`sse connect failed: HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    try {
      while (!this.stopped && !this.reconnectRequested) {
        const readPromise = reader.read();
        readPromise.catch(() => {
        });
        const interruptPromise = new Promise((resolve) => {
          this.interruptRead = () => resolve(INTERRUPT);
        });
        const result = await Promise.race([readPromise, interruptPromise]);
        this.interruptRead = null;
        if (result === INTERRUPT) return;
        const { done, value } = result;
        if (done) return;
        this.lastEventAt = performance.now();
        for (const evt of parser.push(decoder.decode(value, { stream: true }))) {
          this.handleEvent(evt.event, evt.data);
        }
      }
    } finally {
      this.interruptRead = null;
      await Promise.race([
        reader.cancel().catch(() => {
        }),
        new Promise((resolve) => {
          const t = setTimeout(resolve, 1e3);
          t.unref?.();
        })
      ]);
    }
  }
  handleEvent(eventType, data) {
    if (!eventType) return;
    if (eventType === "up_to_date") {
      this.opts.onFirstEvent();
      return;
    }
    if (eventType === "connected" || eventType === "features_updated") {
      try {
        const payload = JSON.parse(data);
        if (payload === null || typeof payload !== "object" || !isPlainObject(payload.features) || payload.config_version == null) {
          throw new Error("missing/invalid features or config_version");
        }
        this.opts.cache.replaceAll(
          payload.features,
          Number(payload.config_version)
        );
        this.opts.onFirstEvent();
      } catch (err) {
        warn3(`malformed ${eventType} event:`, err);
      }
      return;
    }
    if (eventType === "discovery_requested") {
      this.fireDiscovery();
      return;
    }
  }
  fireDiscovery() {
    if (!this.opts.onDiscoveryRequested) return;
    try {
      this.opts.onDiscoveryRequested();
    } catch (err) {
      warn3("discovery_requested handler failed:", err);
    }
  }
  startHealthcheck() {
    const tick = () => {
      if (this.stopped) return;
      const elapsed = performance.now() - this.lastEventAt;
      if (elapsed > STALE_THRESHOLD_MS) {
        this.lastEventAt = performance.now();
        this.forceReconnect();
      }
      this.healthcheckTimer = setTimeout(tick, HEALTHCHECK_INTERVAL_MS);
      this.healthcheckTimer.unref?.();
    };
    this.healthcheckTimer = setTimeout(tick, HEALTHCHECK_INTERVAL_MS);
    this.healthcheckTimer.unref?.();
  }
};
function isAbortError(err) {
  return err instanceof Error && (err.name === "AbortError" || err.name === "ResponseAborted");
}
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// src/monitor/client.ts
var import_node_crypto3 = require("crypto");

// src/monitor/scope.ts
var import_node_async_hooks = require("async_hooks");

// src/monitor/scrub.ts
var REDACTED = "[REDACTED]";
var MAX_DEPTH = 10;
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

// src/monitor/types.ts
function makeEvent(partial) {
  return {
    timestamp: Date.now(),
    source: "event",
    platform: "node",
    meta: {},
    ...partial
  };
}
var nowSeconds = () => Date.now() / 1e3;
var Breadcrumbs = {
  info(message, data) {
    return { category: "info", message, timestamp: nowSeconds(), level: "info", data };
  },
  http(method, url, status, durationMs, extra) {
    const scrubbed = scrubUrl(url) ?? url;
    const data = { method: method.toUpperCase(), url: scrubbed };
    if (status !== void 0) data.status = status;
    if (durationMs !== void 0) data.duration_ms = durationMs;
    if (extra) Object.assign(data, extra);
    return {
      category: "http",
      message: `${method.toUpperCase()} ${scrubbed}`,
      timestamp: nowSeconds(),
      level: "info",
      data
    };
  },
  feature(name, value) {
    return { category: "feature", message: name, timestamp: nowSeconds(), level: "info", data: { value } };
  },
  lifecycle(event) {
    return { category: "lifecycle", message: event, timestamp: nowSeconds(), level: "info" };
  }
};
function breadcrumbToWire(c) {
  const out = {
    category: c.category,
    message: c.message,
    ts: c.timestamp,
    level: c.level
  };
  if (c.data) out.data = c.data;
  return out;
}

// src/monitor/breadcrumbs.ts
var DEFAULT_CAPACITY = 100;
var BreadcrumbBuffer = class {
  buffer = [];
  capacity;
  constructor(capacity = DEFAULT_CAPACITY) {
    if (capacity < 1) throw new Error("capacity must be >= 1");
    this.capacity = capacity;
  }
  add(crumb) {
    this.buffer.push(crumb);
    if (this.buffer.length > this.capacity) this.buffer.shift();
  }
  get length() {
    return this.buffer.length;
  }
  clear() {
    this.buffer = [];
  }
  toWire() {
    return this.buffer.map(breadcrumbToWire);
  }
};

// src/monitor/scope.ts
var Scope = class _Scope {
  user = null;
  tags = {};
  contexts = {};
  extra = {};
  level = null;
  transaction = null;
  breadcrumbs;
  constructor(breadcrumbCapacity = DEFAULT_CAPACITY) {
    this.breadcrumbs = new BreadcrumbBuffer(breadcrumbCapacity);
  }
  setUser(user) {
    this.user = user ? { ...user } : null;
  }
  setTag(key, value) {
    this.tags[key] = value;
  }
  setContext(key, value) {
    this.contexts[key] = { ...value };
  }
  setExtra(key, value) {
    this.extra[key] = value;
  }
  setLevel(level) {
    this.level = level;
  }
  setTransaction(name) {
    this.transaction = name;
  }
  addBreadcrumb(crumb) {
    this.breadcrumbs.add(crumb);
  }
  /** Shallow-copy inheriting user/tags/contexts but a FRESH breadcrumb buffer. */
  clone() {
    const next = new _Scope(this.breadcrumbs.capacity);
    next.user = this.user ? { ...this.user } : null;
    next.tags = { ...this.tags };
    next.contexts = Object.fromEntries(Object.entries(this.contexts).map(([k, v]) => [k, { ...v }]));
    next.extra = { ...this.extra };
    next.level = this.level;
    next.transaction = this.transaction;
    return next;
  }
  /** Layer this scope's data onto an outgoing event. */
  applyTo(event) {
    if (this.user && event.userId == null) {
      const uid = this.user.id;
      if (uid != null) event.userId = String(uid);
    }
    if (Object.keys(this.tags).length > 0) {
      const tags = ensureObjectBucket(event.meta, "tags");
      if (tags) Object.assign(tags, this.tags);
    }
    if (Object.keys(this.contexts).length > 0) {
      const ctx = ensureObjectBucket(event.meta, "contexts");
      if (ctx) for (const [k, v] of Object.entries(this.contexts)) ctx[k] = { ...v };
    }
    if (Object.keys(this.extra).length > 0) {
      const extra = ensureObjectBucket(event.meta, "extra");
      if (extra) Object.assign(extra, this.extra);
    }
    if (this.transaction && !("transaction" in event.meta)) {
      event.meta.transaction = this.transaction;
    }
    if (this.breadcrumbs.length > 0) {
      const existing = ensureArrayBucket(event.meta, "breadcrumbs");
      if (existing) existing.push(...this.breadcrumbs.toWire());
    }
  }
};
var warn4 = (...args) => console.warn("[onelo.monitor]", ...args);
function ensureObjectBucket(meta, key) {
  const existing = meta[key];
  if (existing === void 0) {
    const fresh = {};
    meta[key] = fresh;
    return fresh;
  }
  if (existing !== null && typeof existing === "object" && !Array.isArray(existing)) {
    return existing;
  }
  warn4(`scope: meta.${key} is not an object (${typeof existing}); skipping scope merge for it`);
  return null;
}
function ensureArrayBucket(meta, key) {
  const existing = meta[key];
  if (existing === void 0) {
    const fresh = [];
    meta[key] = fresh;
    return fresh;
  }
  if (Array.isArray(existing)) return existing;
  warn4(`scope: meta.${key} is not an array (${typeof existing}); skipping breadcrumb merge`);
  return null;
}
var ScopeManager = class {
  globalScope = new Scope();
  rootIsolation = null;
  als = new import_node_async_hooks.AsyncLocalStorage();
  getGlobalScope() {
    return this.globalScope;
  }
  /**
   * Active isolation scope. Inside a `runWithIsolationScope` it's the forked
   * per-request scope; outside (CLI / startup) it's a lazily-cloned process
   * root — so setUser/breadcrumbs from a script still behave.
   */
  getIsolationScope() {
    const store = this.als.getStore();
    if (store) return store.isolation;
    if (!this.rootIsolation) this.rootIsolation = this.globalScope.clone();
    return this.rootIsolation;
  }
  /** True only inside a `runWithIsolationScope` (a per-request fork is active). */
  hasActiveIsolationScope() {
    return this.als.getStore() !== void 0;
  }
  getCurrentScope() {
    const store = this.als.getStore();
    if (store?.current) return store.current;
    return this.getIsolationScope();
  }
  /** Fork a fresh isolation scope for the duration of `fn` (per-request). */
  runWithIsolationScope(fn) {
    const parent = this.getIsolationScope();
    const forked = parent.clone();
    return this.als.run({ isolation: forked }, fn);
  }
  /**
   * Fork a fresh isolation scope FROM THE GLOBAL scope (not the ambient one) and
   * run `fn` inside it. `continueTrace` uses this so a restored queue-job scope
   * never inherits an ambient request's user/tags — mirrors Python
   * `continue_trace` forking from `get_global_scope()`.
   */
  runWithGlobalIsolationScope(fn) {
    const forked = this.globalScope.clone();
    return this.als.run({ isolation: forked }, fn);
  }
  /** Fork an isolation scope and attach `userId` — for WS handlers / jobs. */
  runIdentified(userId, fn) {
    return this.runWithIsolationScope(() => {
      if (userId != null) this.getIsolationScope().setUser({ id: String(userId) });
      return fn();
    });
  }
  /** Push a temporary current scope (transaction-style nesting). */
  runWithNewScope(fn) {
    const store = this.als.getStore();
    const isolation = store?.isolation ?? this.getIsolationScope();
    const forked = (store?.current ?? isolation).clone();
    return this.als.run({ isolation, current: forked }, fn);
  }
  /** Layer global, isolation, current onto the event in that order. */
  applyScopesToEvent(event) {
    this.globalScope.applyTo(event);
    const store = this.als.getStore();
    const iso = store?.isolation ?? this.rootIsolation;
    if (iso) iso.applyTo(event);
    if (store?.current && store.current !== iso) store.current.applyTo(event);
  }
};

// src/monitor/propagation.ts
var import_node_crypto2 = require("crypto");
var HMAC_PAYLOAD_KEY = "_data";
var HMAC_SIG_KEY = "_sig";
var warn5 = (...args) => console.warn("[onelo.monitor]", ...args);
function isObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function buildCarrier(scope, includeBreadcrumbs, key) {
  const out = { trace_id: (0, import_node_crypto2.randomUUID)().replace(/-/g, "") };
  if (scope.user) {
    const uid = scope.user.id;
    if (uid != null) out.user = { id: String(uid) };
  }
  if (Object.keys(scope.tags).length > 0) {
    const scrubbed = scrubMeta({ ...scope.tags });
    if (scrubbed && Object.keys(scrubbed).length > 0) out.tags = scrubbed;
  }
  if (Object.keys(scope.contexts).length > 0) {
    const scrubbed = scrubMeta(
      Object.fromEntries(Object.entries(scope.contexts).map(([k, v]) => [k, { ...v }]))
    );
    if (scrubbed && Object.keys(scrubbed).length > 0) out.contexts = scrubbed;
  }
  if (scope.transaction) {
    const cleaned = scrubText(scope.transaction);
    if (cleaned) out.transaction = cleaned;
  }
  if (includeBreadcrumbs && scope.breadcrumbs.length > 0) {
    const scrubbed = scrubMeta({ _: scope.breadcrumbs.toWire() });
    if (scrubbed && Array.isArray(scrubbed._)) out.breadcrumbs = scrubbed._;
  }
  if (key) {
    return { [HMAC_PAYLOAD_KEY]: out, [HMAC_SIG_KEY]: sign(out, key) };
  }
  return out;
}
function unwrapCarrier(data, key) {
  if (data == null) return null;
  const looksSigned = HMAC_SIG_KEY in data && HMAC_PAYLOAD_KEY in data;
  if (!key) {
    if (looksSigned) {
      warn5("continueTrace received a signed carrier but no key was supplied to verify it; rejecting");
      return null;
    }
    return data;
  }
  if (!looksSigned) {
    warn5("continueTrace was given a key but the carrier is not signed; rejecting (producer must pass { key })");
    return null;
  }
  const verified = verify(data, key);
  if (verified === null) warn5("continueTrace HMAC verification failed; rejecting");
  return verified;
}
function applyCarrier(scope, data) {
  if (isObject(data.user)) scope.setUser(data.user);
  if (isObject(data.tags)) {
    for (const [k, v] of Object.entries(data.tags)) {
      if (v == null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        scope.setTag(k, String(v));
      }
    }
  }
  if (isObject(data.contexts)) {
    for (const [k, v] of Object.entries(data.contexts)) {
      if (isObject(v)) scope.setContext(k, v);
    }
  }
  if (typeof data.transaction === "string") scope.setTransaction(data.transaction);
  if (typeof data.trace_id === "string") scope.setTag("trace_id", data.trace_id);
  if (Array.isArray(data.breadcrumbs)) {
    for (const c of data.breadcrumbs) {
      if (!isObject(c)) continue;
      const crumb = {
        category: c.category ?? "info",
        message: String(c.message ?? ""),
        timestamp: Number(c.ts ?? 0),
        level: c.level ?? "info",
        data: isObject(c.data) ? c.data : void 0
      };
      scope.addBreadcrumb(crumb);
    }
  }
}
function sign(data, key) {
  return (0, import_node_crypto2.createHmac)("sha256", key).update(canonical(data)).digest("hex");
}
function verify(envelope, key) {
  const data = envelope[HMAC_PAYLOAD_KEY];
  const sig = envelope[HMAC_SIG_KEY];
  if (!isObject(data) || typeof sig !== "string") return null;
  const expected = Buffer.from(sign(data, key));
  const actual = Buffer.from(sig);
  if (expected.length !== actual.length || !(0, import_node_crypto2.timingSafeEqual)(expected, actual)) return null;
  return data;
}
function canonical(value) {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isObject(value)) {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k]);
    return out;
  }
  return value;
}

// src/monitor/stacktrace.ts
var import_node_fs2 = require("fs");
var SOURCE_CACHE = /* @__PURE__ */ new Map();
var SOURCE_CACHE_MAX = 200;
var MAX_CONTEXT_LINE_LEN = 512;
function readSourceLine(filename, lineno) {
  if (lineno < 1) return null;
  let lines = SOURCE_CACHE.get(filename);
  if (lines === void 0) {
    try {
      lines = (0, import_node_fs2.readFileSync)(filename, "utf8").split("\n");
    } catch {
      lines = null;
    }
    if (SOURCE_CACHE.size >= SOURCE_CACHE_MAX) {
      const oldest = SOURCE_CACHE.keys().next().value;
      if (oldest !== void 0) SOURCE_CACHE.delete(oldest);
    }
    SOURCE_CACHE.set(filename, lines);
  }
  if (!lines || lineno > lines.length) return null;
  const raw = lines[lineno - 1];
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_CONTEXT_LINE_LEN ? trimmed.slice(0, MAX_CONTEXT_LINE_LEN) + "\u2026" : trimmed;
}
var AT_RE = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;
var AT_NO_LOC_RE = /^\s*at\s+(.+?)\s*$/;
function isInApp(filename) {
  if (!filename) return true;
  if (filename.startsWith("node:") || filename.startsWith("internal/")) return false;
  if (filename.includes("/node_modules/") || filename.includes("\\node_modules\\")) return false;
  return true;
}
function moduleFor(filename) {
  if (!filename) return null;
  const base = filename.split(/[/\\]/).pop() ?? filename;
  const dot = base.lastIndexOf(".");
  const name = dot > 0 ? base.slice(0, dot) : base;
  return name || null;
}
function normalizeFile(raw) {
  if (raw.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(raw).pathname);
    } catch {
      return raw;
    }
  }
  return raw;
}
function parseFrameLine(line, includeContext) {
  const m = AT_RE.exec(line);
  if (m) {
    const fn = (m[1] ?? "").trim();
    const filename = normalizeFile(m[2]);
    const lineno = Number(m[3]);
    const inApp = isInApp(filename);
    const frame = {
      function: fn || null,
      module: moduleFor(filename),
      filename,
      lineno,
      colno: Number(m[4]),
      inApp
    };
    if (includeContext && inApp && filename && lineno) {
      const ctx = readSourceLine(filename, lineno);
      if (ctx) frame.contextLine = ctx;
    }
    return frame;
  }
  const m2 = AT_NO_LOC_RE.exec(line);
  if (m2) {
    const fn = m2[1].trim();
    return { function: fn || null, module: null, filename: null, lineno: null, colno: null, inApp: false };
  }
  return null;
}
function parseStack(stack, includeContext = false) {
  if (!stack) return [];
  const frames = [];
  for (const line of stack.split("\n")) {
    if (!/^\s*at\s/.test(line)) continue;
    const frame = parseFrameLine(line, includeContext);
    if (frame) frames.push(frame);
  }
  return frames;
}
function captureExceptionInfo(err, depth = 0) {
  if (err == null) return null;
  if (!(err instanceof Error)) {
    return { type: typeof err === "object" ? "Object" : typeof err, message: String(err), frames: [] };
  }
  let type = err.name;
  const ctorName = err.constructor?.name;
  if ((!type || type === "Error") && ctorName && ctorName !== "Error") type = ctorName;
  type = type || "Error";
  const frames = parseStack(err.stack, true);
  let cause = null;
  if (depth < 10 && "cause" in err && err.cause != null) {
    cause = captureExceptionInfo(err.cause, depth + 1);
  }
  return { type, message: err.message ?? "", frames, cause };
}
function captureCurrentStack(skip = 1) {
  const holder = {};
  Error.captureStackTrace?.(holder, captureCurrentStack);
  const frames = parseStack(holder.stack);
  return frames.slice(Math.max(0, skip - 1));
}
function stackFrameToWire(frame) {
  const out = {};
  if (frame.function) out.function = frame.function;
  if (frame.module) out.module = frame.module;
  if (frame.filename) out.filename = frame.filename;
  if (frame.lineno) out.lineno = frame.lineno;
  if (frame.colno) out.colno = frame.colno;
  out.in_app = frame.inApp;
  if (frame.contextLine) out.context_line = scrubText(frame.contextLine) ?? frame.contextLine;
  return out;
}
function capturedExceptionToWire(exc) {
  const out = {
    type: exc.type,
    message: exc.message,
    frames: exc.frames.map(stackFrameToWire)
  };
  if (exc.cause) out.cause = capturedExceptionToWire(exc.cause);
  return out;
}

// src/monitor/transport.ts
var DEFAULT_BUFFER_SIZE = 200;
var DEFAULT_FLUSH_INTERVAL_MS = 15e3;
var DEFAULT_REQUEST_TIMEOUT_MS = 5e3;
var MAX_RETRY_ATTEMPTS = 3;
var QUOTA_LOW_WATERMARK = 50;
var QUOTA_EXHAUSTED_HOLDOFF_MS = 3e5;
var MAX_RETRY_AFTER_MS = 36e5;
var warn6 = (...args) => console.warn("[onelo.monitor]", ...args);
var MonitorTransport = class {
  apiUrl;
  key;
  bufferSize;
  flushIntervalMs;
  requestTimeout;
  fetchImpl;
  buffer = [];
  dropped = 0;
  droppedReported = 0;
  retryAfterUntil = 0;
  // performance.now() ms; while future, hold off
  _quotaRemaining = null;
  timer = null;
  stopped = false;
  flushChain = Promise.resolve();
  beforeExitHandler = null;
  constructor(opts) {
    this.apiUrl = opts.apiUrl.replace(/\/+$/, "");
    this.key = opts.publishableKey;
    this.bufferSize = opts.bufferSize ?? DEFAULT_BUFFER_SIZE;
    this.flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.requestTimeout = opts.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl;
  }
  start() {
    this.scheduleFlush();
    this.beforeExitHandler = () => {
      void this.flush();
    };
    process.once("beforeExit", this.beforeExitHandler);
  }
  get quotaRemaining() {
    return this._quotaRemaining;
  }
  get droppedCount() {
    return this.dropped;
  }
  get bufferLength() {
    return this.buffer.length;
  }
  /** Enqueue an event. Returns immediately, never throws. */
  send(event) {
    if (this.stopped) return;
    if (this.buffer.length >= this.bufferSize) {
      this.buffer.shift();
      this.dropped++;
    }
    this.buffer.push(event);
    if (!event.ok || event.source === "global_error") void this.doFlush();
  }
  /** Drain the buffer now. Serialised with all other flushes. */
  flush() {
    return this.doFlush();
  }
  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.beforeExitHandler) {
      process.removeListener("beforeExit", this.beforeExitHandler);
      this.beforeExitHandler = null;
    }
    await this.doFlush(true);
  }
  // ── internals ─────────────────────────────────────────────────────────
  scheduleFlush() {
    this.timer = setTimeout(() => {
      void this.doFlush().finally(() => {
        if (!this.stopped) this.scheduleFlush();
      });
    }, this.flushIntervalMs);
    this.timer.unref?.();
  }
  doFlush(force = false) {
    this.flushChain = this.flushChain.then(() => this.drainOnce(force)).catch(() => {
    });
    return this.flushChain;
  }
  async drainOnce(force = false) {
    if (!force && this.retryAfterUntil && performance.now() < this.retryAfterUntil) return;
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    await this.sendBatchWithRetry(batch);
    this.maybeReportDrops();
  }
  async sendBatchWithRetry(batch) {
    let backoff = 500;
    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
      let done = false;
      try {
        done = await this.sendOnce(batch);
      } catch {
      }
      if (done) return;
      if (attempt < MAX_RETRY_ATTEMPTS) {
        await sleep(backoff);
        backoff *= 2;
      }
    }
    warn6(`dropping batch of ${batch.length} events after ${MAX_RETRY_ATTEMPTS} attempts`);
  }
  /** Returns true when the batch is done (success OR non-retryable failure). */
  async sendOnce(batch) {
    const doFetch = this.fetchImpl ?? (typeof fetch === "function" ? fetch : null);
    if (!doFetch) return true;
    const payload = {
      publishableKey: this.key,
      events: batch.map(eventToWire)
    };
    let res;
    try {
      res = await doFetch(`${this.apiUrl}/api/sdk/monitor/events/batch`, {
        method: "POST",
        headers: { "User-Agent": USER_AGENT, "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.requestTimeout)
      });
    } catch {
      return false;
    }
    if (res.status >= 200 && res.status < 300) {
      this.noteQuota(res.headers.get("X-Onelo-Quota-Remaining"));
      return true;
    }
    if (res.status === 429) {
      const retryAfterMs = parseRetryAfter(res.headers.get("Retry-After"));
      if (retryAfterMs > 0) this.retryAfterUntil = performance.now() + retryAfterMs;
      return true;
    }
    if (res.status >= 400 && res.status < 500) return true;
    return false;
  }
  noteQuota(header) {
    if (header === null) return;
    const h = header.trim();
    if (h === "") return;
    if (h.toLowerCase() === "unlimited") {
      this._quotaRemaining = null;
      return;
    }
    const remaining = Number(h);
    if (!Number.isFinite(remaining)) return;
    this._quotaRemaining = remaining;
    if (remaining <= 0) {
      this.retryAfterUntil = Math.max(this.retryAfterUntil, performance.now() + QUOTA_EXHAUSTED_HOLDOFF_MS);
      warn6(`event quota exhausted; holding off ~${QUOTA_EXHAUSTED_HOLDOFF_MS / 1e3}s before retry`);
    } else if (remaining <= QUOTA_LOW_WATERMARK) {
      warn6(`event quota low \u2014 ${remaining} remaining this hour`);
    }
  }
  maybeReportDrops() {
    const newly = this.dropped - this.droppedReported;
    this.droppedReported = this.dropped;
    if (newly > 0) {
      warn6(
        `dropped ${newly} event(s) \u2014 buffer full (max ${this.bufferSize}). Raise bufferSize or lower volume via sampleRate.`
      );
    }
  }
};
function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}
function eventToWire(event) {
  const out = {
    featureName: event.featureName,
    ok: event.ok,
    platform: event.platform,
    source: event.source,
    // Real event time, so a batched/retried/drained event isn't mis-dated to
    // ingest time. Backend stores it as display-only clamped event_ts.
    ts: new Date(event.timestamp).toISOString()
  };
  if (event.durationMs != null) out.durationMs = event.durationMs;
  if (event.error != null) out.error = event.error;
  if (event.userId != null) out.userId = event.userId;
  if (event.sessionId != null) out.sessionId = event.sessionId;
  if (event.meta && Object.keys(event.meta).length > 0) out.meta = event.meta;
  return out;
}
function parseRetryAfter(value) {
  if (!value) return 0;
  const seconds = Number(value.trim());
  if (!Number.isFinite(seconds)) return 0;
  return Math.max(0, Math.min(seconds * 1e3, MAX_RETRY_AFTER_MS));
}

// src/monitor/integrations.ts
var import_node_util = require("util");
function installConsoleCapture(monitor, options = {}) {
  const enabled = {
    error: options.methods?.error ?? true,
    warn: options.methods?.warn ?? true,
    info: options.methods?.info ?? false,
    log: options.methods?.log ?? false,
    debug: options.methods?.debug ?? false
  };
  const con = console;
  const originals = {};
  let capturing = false;
  for (const method of Object.keys(enabled)) {
    if (!enabled[method]) continue;
    const original = con[method].bind(console);
    originals[method] = con[method];
    con[method] = (...args) => {
      original(...args);
      if (capturing) return;
      capturing = true;
      try {
        if (method === "error") {
          const errArg = args.find((a) => a instanceof Error);
          if (errArg) monitor.captureException(errArg, { featureName: "console" });
          else monitor.captureMessage((0, import_node_util.format)(...args), { level: "error", featureName: "console" });
        } else {
          monitor.addBreadcrumb((0, import_node_util.format)(...args), {
            category: "log",
            level: method === "warn" ? "warning" : "info"
          });
        }
      } catch {
      } finally {
        capturing = false;
      }
    };
  }
  return () => {
    for (const method of Object.keys(originals)) {
      const orig = originals[method];
      if (orig) con[method] = orig;
    }
  };
}
function installFetchBreadcrumbs(monitor, options = {}) {
  const g = globalThis;
  const original = g.fetch;
  if (typeof original !== "function") return () => {
  };
  const ignore = options.ignoreUrlPrefix;
  const wrapped = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (ignore && url.startsWith(ignore)) return original(input, init);
    const method = (init?.method ?? (typeof input === "object" && input !== null && "method" in input ? input.method : "GET")).toUpperCase();
    const safeUrl = scrubUrl(url) ?? url;
    const start = performance.now();
    try {
      const res = await original(input, init);
      monitor.addBreadcrumb(`${method} ${safeUrl}`, {
        category: "http",
        level: res.ok ? "info" : "warning",
        data: {
          method,
          url: safeUrl,
          status_code: res.status,
          duration_ms: Math.round(performance.now() - start)
        }
      });
      return res;
    } catch (err) {
      monitor.addBreadcrumb(`${method} ${safeUrl}`, {
        category: "http",
        level: "error",
        data: { method, url: safeUrl, error: String(err), duration_ms: Math.round(performance.now() - start) }
      });
      throw err;
    }
  };
  g.fetch = wrapped;
  return () => {
    if (g.fetch === wrapped) g.fetch = original;
  };
}

// src/monitor/client.ts
var SDK_NAME = "onelo-node";
var warn7 = (...args) => console.warn("[onelo.monitor]", ...args);
var MonitorClient = class {
  constructor(deps) {
    this.deps = deps;
  }
  deps;
  scopes = new ScopeManager();
  transport = null;
  sessionId = null;
  deployRelease = null;
  deployEnvironment = null;
  errorSampleRate = 1;
  successSampleRate = 1;
  uncaughtHandler = null;
  rejectionHandler = null;
  consoleUninstall = null;
  fetchUninstall = null;
  // Dedup so an error re-raised to preserve crash semantics isn't captured twice.
  capturedErrors = /* @__PURE__ */ new WeakSet();
  // ── lifecycle ───────────────────────────────────────────────────────────
  init(options = {}) {
    for (const [name, rate] of [
      ["sampleRate", options.sampleRate ?? 1],
      ["successSampleRate", options.successSampleRate ?? 1]
    ]) {
      if (!(rate >= 0 && rate <= 1)) throw new Error(`${name} must be between 0 and 1, got ${rate}`);
    }
    if (this.transport) {
      warn7("monitor.init called twice; closing previous transport");
      void this.close();
    }
    const release = options.release ?? process.env.ONELO_RELEASE ?? process.env.GIT_COMMIT_SHA ?? null;
    const environment = options.environment ?? process.env.ONELO_ENVIRONMENT ?? process.env.ENVIRONMENT ?? process.env.NODE_ENV ?? null;
    const serverName = options.serverName ?? process.env.HOSTNAME ?? process.env.POD_NAME ?? null;
    const g = this.scopes.getGlobalScope();
    if (release) g.setTag("release", release);
    if (environment) g.setTag("environment", environment);
    if (serverName) g.setTag("server_name", serverName);
    this.deployRelease = release;
    this.deployEnvironment = environment;
    this.errorSampleRate = options.sampleRate ?? 1;
    this.successSampleRate = options.successSampleRate ?? 1;
    setStrictEmailScrub(options.strictEmailScrub ?? false);
    configureSensitiveKeys(options.sensitiveHeaders ?? null);
    this.transport = new MonitorTransport({
      apiUrl: this.deps.apiUrl,
      publishableKey: this.deps.key,
      bufferSize: options.bufferSize,
      flushIntervalMs: options.flushInterval,
      requestTimeout: options.requestTimeout ?? this.deps.requestTimeout,
      fetchImpl: options.fetchImpl ?? this.deps.fetchImpl
    });
    this.transport.start();
    this.sessionId = (0, import_node_crypto3.randomUUID)().replace(/-/g, "");
    if (options.installGlobalHandlers !== false) this.installGlobalHandlers();
    if (options.captureConsole) {
      this.consoleUninstall = installConsoleCapture(
        this,
        typeof options.captureConsole === "object" ? options.captureConsole : {}
      );
    }
    if (options.httpBreadcrumbs) {
      this.fetchUninstall = installFetchBreadcrumbs(this, { ignoreUrlPrefix: this.deps.apiUrl });
    }
    this.emit(makeEvent({ featureName: "session_opened", ok: true, source: "event" }));
  }
  isInitialised() {
    return this.transport !== null;
  }
  async close() {
    this.uninstallGlobalHandlers();
    setStrictEmailScrub(false);
    const t = this.transport;
    this.transport = null;
    this.sessionId = null;
    this.deployRelease = null;
    this.deployEnvironment = null;
    this.errorSampleRate = 1;
    this.successSampleRate = 1;
    if (t) await t.stop();
  }
  /** Synchronously drain the buffer (end of a job / before exit). */
  async flush() {
    if (this.transport) await this.transport.flush();
  }
  // ── capture API ───────────────────────────────────────────────────────────
  captureException(err, options = {}) {
    const captured = captureExceptionInfo(err);
    if (!captured) return;
    const meta = { ...options.meta ?? {} };
    meta.exception = capturedExceptionToWire(captured);
    if (!("error_type" in meta)) meta.error_type = captured.type;
    this.emit(
      makeEvent({
        featureName: options.featureName ?? "manual",
        ok: false,
        error: captured.message,
        source: "event",
        meta
      })
    );
  }
  captureMessage(message, options = {}) {
    const level = options.level ?? "info";
    const meta = { ...options.meta ?? {} };
    meta.level = level;
    if (options.attachStacktrace) meta.stack = captureCurrentStack(1).map(stackFrameToWire);
    const isError = level === "error" || level === "fatal";
    this.emit(
      makeEvent({
        featureName: options.featureName ?? "manual",
        ok: !isError,
        error: isError ? message : null,
        source: "event",
        meta
      })
    );
  }
  captureEvent(event) {
    this.emit(event);
  }
  /**
   * Measure a unit of work and emit one `source="track"` event (ok=true on
   * success, an error event with full stack/breadcrumbs/flags on throw), then
   * let the result/exception propagate unchanged. Works with sync or async fns.
   */
  track(featureName, fn, options = {}) {
    const start = performance.now();
    const SUCCESS = /* @__PURE__ */ Symbol("success");
    const finish = (err) => {
      const durationMs = Math.round(performance.now() - start);
      if (err === SUCCESS) {
        this.emit(
          makeEvent({
            featureName,
            ok: true,
            source: "track",
            durationMs,
            meta: { ...options.meta ?? {} }
          })
        );
        return;
      }
      const meta = { ...options.meta ?? {} };
      const captured = captureExceptionInfo(err);
      let error;
      if (captured) {
        meta.exception = capturedExceptionToWire(captured);
        if (!("error_type" in meta)) meta.error_type = captured.type;
        error = captured.message;
      } else {
        if (!("error_type" in meta)) meta.error_type = err instanceof Error ? err.name : typeof err;
        error = String(err);
      }
      this.emit(makeEvent({ featureName, ok: false, error, source: "track", durationMs, meta }));
    };
    let result;
    try {
      result = fn();
    } catch (e) {
      finish(e);
      throw e;
    }
    if (result != null && typeof result.then === "function") {
      return result.then(
        (v) => {
          finish(SUCCESS);
          return v;
        },
        (e) => {
          finish(e);
          throw e;
        }
      );
    }
    finish(SUCCESS);
    return result;
  }
  addBreadcrumb(crumbOrMessage, options = {}) {
    if (typeof crumbOrMessage === "object" && "category" in crumbOrMessage) {
      this.scopes.getIsolationScope().addBreadcrumb(crumbOrMessage);
      return;
    }
    const crumb = {
      category: options.category ?? "info",
      message: String(crumbOrMessage),
      timestamp: Date.now() / 1e3,
      level: options.level ?? "info",
      data: options.data
    };
    this.scopes.getIsolationScope().addBreadcrumb(crumb);
  }
  setUser(user) {
    this.scopes.getIsolationScope().setUser(user);
  }
  setTag(key, value) {
    this.scopes.getIsolationScope().setTag(key, value);
  }
  setContext(key, value) {
    this.scopes.getIsolationScope().setContext(key, value);
  }
  setExtra(key, value) {
    this.scopes.getIsolationScope().setExtra(key, value);
  }
  // ── scope forking (used by framework adapters, WS handlers, jobs) ─────────
  /** Run `fn` in a fresh per-request isolation scope (breadcrumbs/user isolated). */
  runWithIsolationScope(fn) {
    return this.scopes.runWithIsolationScope(fn);
  }
  /** Fork an isolation scope and attach `userId` for its duration. */
  runIdentified(userId, fn) {
    return this.scopes.runIdentified(userId, fn);
  }
  /** Push a temporary current scope (transaction-style; changes don't leak out). */
  runWithNewScope(fn) {
    return this.scopes.runWithNewScope(fn);
  }
  /**
   * True only when running inside a per-request isolation scope (a monitor
   * request handler / withMonitor forked one). The auth→monitor bridge uses this
   * to avoid writing a user id onto the shared process-root scope, which would
   * leak across concurrent requests.
   */
  hasActiveRequestScope() {
    return this.scopes.hasActiveIsolationScope();
  }
  // ── cross-process scope propagation (queue jobs) ─────────────────────────
  /**
   * Serialise the active scope (user.id + scrubbed tags/contexts/transaction,
   * optionally breadcrumbs) into a JSON-safe carrier you attach to a queued job,
   * so the worker can restore it via {@link continueTrace}. Pass `key` (your
   * publishable key) to HMAC-sign it — the worker verifies before trusting.
   * Parity with Python's `monitor.carrier()`.
   *
   * Producer (dispatch side):
   *   await queue.add('job', { ...payload, onelo: onelo.monitor.carrier({ key: onelo.key }) })
   */
  carrier(options = {}) {
    return buildCarrier(this.scopes.getIsolationScope(), options.includeBreadcrumbs ?? false, options.key);
  }
  /**
   * Restore a carrier onto a FRESH isolation scope (forked from global, so it
   * never inherits an ambient request's user/tags) for the duration of `fn` (the
   * job body), then unwind. A forged, tampered, or signed-but-key-missing carrier
   * is rejected — the job still runs, just with an empty scope, so a single bad
   * message never crashes the worker. `AsyncLocalStorage` keeps the restored
   * scope across `await`s inside `fn`. Returns whatever `fn` returns. Parity with
   * Python's `monitor.continue_trace()`.
   *
   * Worker (job handler side):
   *   await onelo.monitor.continueTrace(job.data.onelo, async () => {
   *     // ... work; captured errors carry the dispatching request's user/tags
   *   }, { key: onelo.key })
   */
  continueTrace(carrier, fn, options = {}) {
    const payload = unwrapCarrier(carrier, options.key);
    return this.scopes.runWithGlobalIsolationScope(() => {
      if (payload) applyCarrier(this.scopes.getIsolationScope(), payload);
      return fn();
    });
  }
  // ── internals ─────────────────────────────────────────────────────────────
  shouldKeep(event) {
    const rate = event.ok ? this.successSampleRate : this.errorSampleRate;
    if (rate >= 1) return true;
    if (rate <= 0) return false;
    return Math.random() < rate;
  }
  emit(event) {
    const transport = this.transport;
    if (!transport) return;
    if (!this.shouldKeep(event)) return;
    this.scopes.applyScopesToEvent(event);
    if (event.sessionId == null && this.sessionId) event.sessionId = this.sessionId;
    if (this.deployEnvironment && !("environment" in event.meta)) {
      event.meta.environment = this.deployEnvironment;
    }
    if (this.deployRelease) {
      const app = event.meta.app ??= {};
      if (app && typeof app === "object" && app.version === void 0) app.version = this.deployRelease;
    }
    try {
      const flags = this.deps.flagProvider();
      if (flags && Object.keys(flags).length > 0 && !("flags" in event.meta)) {
        event.meta.flags = { ...flags };
      }
    } catch {
    }
    if (!("sdk" in event.meta)) event.meta.sdk = { name: SDK_NAME, version: VERSION };
    try {
      event.error = scrubText(event.error) ?? null;
      const scrubbed = scrubMeta(event.meta);
      event.meta = scrubbed ?? {};
    } catch (err) {
      warn7("scrubber failed; dropping event", err);
      return;
    }
    try {
      transport.send(event);
    } catch (err) {
      warn7("transport failed", err);
    }
  }
  installGlobalHandlers() {
    this.uncaughtHandler = (err) => {
      if (this.markCaptured(err)) this.captureException(err, { featureName: "uncaught" });
      void this.flush();
    };
    process.on("uncaughtExceptionMonitor", this.uncaughtHandler);
    this.rejectionHandler = (reason) => {
      if (this.markCaptured(reason)) {
        this.captureException(reason, { featureName: "unhandled_rejection" });
      }
      void this.flush();
      if (process.listenerCount("unhandledRejection") === 1) {
        process.nextTick(() => {
          throw reason;
        });
      }
    };
    process.on("unhandledRejection", this.rejectionHandler);
  }
  /** WeakSet dedup for objects; non-objects can't be deduped (rare) → always capture. */
  markCaptured(err) {
    if (err !== null && typeof err === "object") {
      if (this.capturedErrors.has(err)) return false;
      this.capturedErrors.add(err);
    }
    return true;
  }
  uninstallGlobalHandlers() {
    if (this.uncaughtHandler) {
      process.removeListener("uncaughtExceptionMonitor", this.uncaughtHandler);
      this.uncaughtHandler = null;
    }
    if (this.rejectionHandler) {
      process.removeListener("unhandledRejection", this.rejectionHandler);
      this.rejectionHandler = null;
    }
    if (this.consoleUninstall) {
      this.consoleUninstall();
      this.consoleUninstall = null;
    }
    if (this.fetchUninstall) {
      this.fetchUninstall();
      this.fetchUninstall = null;
    }
  }
};

// src/client.ts
var ANY_KEY_RE = /^onelo_(pk|sk)_[a-zA-Z0-9_]+$/;
var BATCH_PING_DEBOUNCE_MS = 1e3;
var KNOWN_CONFIG_KEYS = /* @__PURE__ */ new Set([
  "key",
  "publishableKey",
  "secretKey",
  "apiUrl",
  "strategy",
  "pollInterval",
  "appVersion",
  "requestTimeout",
  "fetchImpl",
  "featureEnvironment"
]);
var warn8 = (...args) => console.warn("[onelo]", ...args);
var Onelo = class {
  key;
  isSecretKey;
  apiUrl;
  requestTimeout;
  fetchImpl;
  featureEnvironment;
  /** The Features module — `onelo.features.feature('slug')`, `.forUser(id)`, etc. */
  features;
  /** The Monitor module — `onelo.monitor.init()`, `.captureException(err)`, etc. */
  monitor;
  strategy;
  pollInterval;
  appVersion;
  cache;
  userId = null;
  consumer = null;
  consumerRun = null;
  started = false;
  closed = false;
  pingTimer = null;
  pingInFlight = null;
  pingController = null;
  firstEventResolved = false;
  firstEventWaiters = [];
  // identify() churn guard — timestamps of identity SWITCHES in the last window.
  identifySwitches = [];
  identifyChurnWarned = false;
  constructor(config) {
    for (const k of Object.keys(config)) {
      if (!KNOWN_CONFIG_KEYS.has(k)) warn8(`unknown config option ${JSON.stringify(k)} ignored`);
    }
    const provided = [config.key, config.publishableKey, config.secretKey].filter(
      (k) => typeof k === "string" && k.length > 0
    );
    if (provided.length === 0) {
      throw new Error("Onelo requires a key \u2014 pass key, publishableKey, or secretKey.");
    }
    if (provided.length > 1) {
      throw new Error("Provide exactly one of key, publishableKey, secretKey \u2014 not multiple.");
    }
    const chosen = provided[0];
    if (!ANY_KEY_RE.test(chosen)) {
      throw new Error(
        `Key must match onelo_pk_* or onelo_sk_* (${ANY_KEY_RE.source}), got ${JSON.stringify(chosen)}.`
      );
    }
    if (config.secretKey !== void 0) this.isSecretKey = true;
    else if (config.publishableKey !== void 0) this.isSecretKey = false;
    else this.isSecretKey = chosen.includes("_sk_");
    if (!config.apiUrl) {
      throw new Error(
        "Onelo requires apiUrl \u2014 the dashboard snippet pre-fills it from your environment. Missing apiUrl is a configuration error, not a default."
      );
    }
    let parsed;
    try {
      parsed = new URL(config.apiUrl);
    } catch {
      throw new Error(`apiUrl must be an http(s) URL, got ${JSON.stringify(config.apiUrl)}.`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`apiUrl must be an http(s) URL, got ${JSON.stringify(config.apiUrl)}.`);
    }
    let featEnv = config.featureEnvironment ?? process.env.ONELO_FEATURE_ENVIRONMENT;
    if (typeof featEnv === "string") featEnv = featEnv.trim() || void 0;
    if (featEnv !== void 0 && featEnv !== "test" && featEnv !== "live") {
      throw new Error(
        `featureEnvironment must be 'test', 'live', or undefined (ONELO_FEATURE_ENVIRONMENT), got ${JSON.stringify(featEnv)}.`
      );
    }
    this.key = chosen;
    this.apiUrl = config.apiUrl.replace(/\/+$/, "");
    this.requestTimeout = config.requestTimeout ?? 5e3;
    this.fetchImpl = config.fetchImpl;
    this.featureEnvironment = featEnv ?? null;
    this.strategy = resolveStrategy(config.strategy ?? "auto");
    this.pollInterval = config.pollInterval ?? 30;
    this.appVersion = config.appVersion ?? null;
    this.cache = new FeatureCache();
    this.features = new FeaturesClient({
      cache: this.cache,
      scheduleBatchPing: () => this.scheduleBatchPing(),
      ready: (timeoutMs) => this.readyImpl(timeoutMs),
      ensureStarted: () => this.ensureStarted(),
      apiUrl: this.apiUrl,
      publishableKey: this.key,
      requestTimeout: this.requestTimeout,
      fetchImpl: this.fetchImpl,
      featureEnvironment: this.featureEnvironment
    });
    this.monitor = new MonitorClient({
      key: this.key,
      apiUrl: this.apiUrl,
      requestTimeout: this.requestTimeout,
      fetchImpl: this.fetchImpl,
      // Feature-flag correlation: every captured event ships the live flag
      // snapshot (empty until the features stream is used).
      flagProvider: () => this.cache.snapshot()
    });
  }
  /**
   * Set the PROCESS-GLOBAL user identity for feature targeting, and (re)start
   * the stream so the next `feature()` reflects this user. Meant for
   * single-identity processes (CLI, worker, single-tenant). For a multi-user
   * backend use `features.forUser(userId)` instead — see its docs.
   */
  identify(userId) {
    const previous = this.userId;
    this.userId = userId;
    if (userId !== previous) this.trackIdentifyChurn();
    if (this.started) {
      this.consumer?.forceReconnect();
    } else {
      this.ensureStarted();
    }
  }
  /**
   * Warn ONCE if identify() switches identity 5+ times within 60s. Identity is
   * process-global — a multi-user backend calling identify(user.id) per request
   * races (user A evaluated with B's targeting) and forces an SSE reconnect on
   * every switch. The fix is `features.forUser(userId)`. Mirrors Python's guard.
   */
  trackIdentifyChurn() {
    if (this.identifyChurnWarned) return;
    const now = performance.now();
    this.identifySwitches.push(now);
    this.identifySwitches = this.identifySwitches.filter((t) => now - t <= 6e4);
    if (this.identifySwitches.length >= 5) {
      this.identifyChurnWarned = true;
      warn8(
        "identify() switched identity 5+ times within 60s. Identity is process-global \u2014 on a multi-user backend resolve per request instead: await onelo.features.forUser(userId). Calling identify() per request races and reconnects the stream on every switch."
      );
    }
  }
  /** Block until the first backend snapshot lands (or timeout). Alias of `features.ready`. */
  ready(timeoutMs = 1500) {
    return this.features.ready(timeoutMs);
  }
  /**
   * Stop the background stream and release timers. Idempotent. Call at graceful
   * shutdown; after close(), `feature()` reads the last cached snapshot but the
   * stream no longer updates.
   */
  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.pingTimer) {
      clearTimeout(this.pingTimer);
      this.pingTimer = null;
    }
    this.pingController?.abort();
    await this.monitor.close();
    this.consumer?.stop();
    this.resolveFirstEvent(this.firstEventResolved);
    if (this.consumerRun) {
      try {
        await this.consumerRun;
      } catch {
      }
    }
    if (this.pingInFlight) {
      try {
        await this.pingInFlight;
      } catch {
      }
    }
  }
  // ── Internals ───────────────────────────────────────────────────────────
  ensureStarted() {
    if (this.started || this.closed) return;
    this.started = true;
    this.consumer = this.strategy === "sse" ? new SseConsumer({
      apiUrl: this.apiUrl,
      key: this.key,
      cache: this.cache,
      getUserId: () => this.userId,
      requestTimeout: this.requestTimeout,
      fetchImpl: this.fetchImpl,
      featureEnvironment: this.featureEnvironment,
      onFirstEvent: () => this.resolveFirstEvent(true),
      onDiscoveryRequested: () => this.onDiscoveryRequested(),
      appVersion: this.appVersion
    }) : new PollingConsumer({
      apiUrl: this.apiUrl,
      key: this.key,
      cache: this.cache,
      getUserId: () => this.userId,
      requestTimeout: this.requestTimeout,
      fetchImpl: this.fetchImpl,
      featureEnvironment: this.featureEnvironment,
      onFirstEvent: () => this.resolveFirstEvent(true),
      onDiscoveryRequested: () => this.onDiscoveryRequested(),
      appVersion: this.appVersion,
      pollIntervalSeconds: this.pollInterval
    });
    this.consumerRun = this.consumer.run().catch((err) => {
      warn8("features consumer crashed:", err);
    });
  }
  resolveFirstEvent(ok) {
    if (!this.firstEventResolved) this.firstEventResolved = ok;
    const waiters = this.firstEventWaiters;
    this.firstEventWaiters = [];
    for (const w of waiters) w(ok);
  }
  readyImpl(timeoutMs) {
    if (this.firstEventResolved) return Promise.resolve(true);
    if (this.closed) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.firstEventWaiters = this.firstEventWaiters.filter((w) => w !== onEvent);
        resolve(false);
      }, timeoutMs);
      const onEvent = (ok) => {
        clearTimeout(timer);
        resolve(ok);
      };
      this.firstEventWaiters.push(onEvent);
    });
  }
  scheduleBatchPing() {
    if (this.closed) return;
    if (this.pingTimer) clearTimeout(this.pingTimer);
    this.pingTimer = setTimeout(() => {
      this.pingTimer = null;
      const names = this.features.snapshotDiscovered();
      if (names.length > 0) this.pingInFlight = this.fireBatchPing(names);
    }, BATCH_PING_DEBOUNCE_MS);
    this.pingTimer.unref?.();
  }
  onDiscoveryRequested() {
    if (this.closed) return;
    const names = this.features.snapshotDiscovered();
    if (names.length > 0) this.pingInFlight = this.fireBatchPing(names);
  }
  async fireBatchPing(names) {
    const doFetch = resolveFetch(this.fetchImpl);
    if (!doFetch) return;
    const body = { publishableKey: this.key, features: names };
    if (this.featureEnvironment !== null) body.environment = this.featureEnvironment;
    const controller = new AbortController();
    this.pingController = controller;
    const timeout = setTimeout(() => controller.abort(), this.requestTimeout);
    timeout.unref?.();
    try {
      const res = await doFetch(`${this.apiUrl}/api/sdk/features/batch-ping`, {
        method: "POST",
        headers: {
          "User-Agent": USER_AGENT,
          "content-type": "application/json",
          // Test keys REQUIRE X-Onelo-Instance-Id (dual-anchor TOFU binding);
          // live keys ignore it — always send (cheap belt-and-braces).
          "X-Onelo-Instance-Id": getInstanceId()
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (res.status >= 400) {
        const text = await res.text().catch(() => "");
        warn8(`batch-ping rejected (HTTP ${res.status}): ${text.slice(0, 300)}`);
      }
    } catch {
    } finally {
      clearTimeout(timeout);
      if (this.pingController === controller) this.pingController = null;
    }
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

// src/auth/errors.ts
var OneloAuthError = class extends Error {
  constructor(message) {
    super(message);
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
  constructor(message, retryAfter = null) {
    super(message);
    this.retryAfter = retryAfter;
  }
};

// src/auth/verify.ts
var BACKOFF_BASE_MS = 100;
function parseRetryAfter2(value) {
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
  if (status === 403) throw new OneloAuthForbidden("token valid but principal forbidden");
  if (status === 429) {
    throw new OneloAuthRateLimited(
      "backend rate-limited auth (429)",
      parseRetryAfter2(res.headers.get("retry-after"))
    );
  }
  if (status >= 500 && status < 600) throw new OneloAuthUnavailable(`backend returned ${status}`);
  throw new OneloAuthUnavailable(`unexpected status ${status}`);
}
async function verifyToken(client, token) {
  if (!token || !token.trim()) throw new OneloAuthMissingToken("token is empty");
  if (!client.isSecretKey) {
    throw new OneloAuthError(
      "verifyToken requires an Onelo client constructed with secretKey: ...; you supplied a publishable key. Backends must use new Onelo({ secretKey: 'onelo_sk_live_...' })."
    );
  }
  const url = `${client.apiUrl}/api/sdk/auth/user`;
  const headers = {
    Authorization: `Bearer ${token}`,
    // Send both — backend prefers the dedicated header, but the legacy
    // X-Publishable-Key path still works on older deployments.
    "X-Onelo-Secret-Key": client.key,
    "X-Publishable-Key": client.key
  };
  const doFetch = client.fetchImpl ?? (typeof fetch === "function" ? fetch : void 0);
  if (!doFetch) {
    throw new OneloAuthUnavailable(
      "global fetch is unavailable \u2014 Node 18+ is required, or pass fetchImpl in the Onelo config."
    );
  }
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
  return mapResponse(res);
}
var sleep2 = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function verifyWithRetry(client, token, options = {}) {
  const retryAttempts = options.retryAttempts ?? 3;
  const retryTotalTimeout = options.retryTotalTimeout ?? 2e3;
  if (retryAttempts < 1) throw new Error("retryAttempts must be >= 1");
  if (retryTotalTimeout <= 0) throw new Error("retryTotalTimeout must be > 0");
  const deadline = performance.now() + retryTotalTimeout;
  let lastExc = null;
  for (let attempt = 0; attempt < retryAttempts; attempt++) {
    try {
      return await verifyToken(client, token);
    } catch (exc) {
      if (!(exc instanceof OneloAuthUnavailable)) throw exc;
      lastExc = exc;
      if (exc instanceof OneloAuthRateLimited) break;
      const nextAttempt = attempt + 1;
      if (nextAttempt >= retryAttempts) break;
      const backoff = BACKOFF_BASE_MS * 2 ** attempt;
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      await sleep2(Math.min(backoff, remaining));
      if (performance.now() >= deadline) break;
    }
  }
  throw lastExc;
}

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

// src/auth/resolve.ts
var import_node_crypto4 = require("crypto");
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
  return (0, import_node_crypto4.createHash)("sha256").update(token, "utf8").digest("hex");
}
function safeEmit(cb, userId, event) {
  if (!cb) return;
  try {
    cb(userId, event);
  } catch (err) {
    console.warn("[onelo] onAuthEvent callback threw; suppressing.", err);
  }
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
    let user;
    try {
      user = await verifyWithRetry(client, token, { retryAttempts, retryTotalTimeout });
    } catch (exc) {
      if (exc instanceof OneloAuthMissingToken) {
        safeEmit(onAuthEvent, null, "auth.fail.missing_token");
        throw new AuthHttpError(401, { error: "missing_token" });
      }
      if (exc instanceof OneloAuthInvalidToken) {
        safeEmit(onAuthEvent, null, "auth.fail.invalid_token");
        throw new AuthHttpError(401, { error: "invalid_token" });
      }
      if (exc instanceof OneloAuthForbidden) {
        safeEmit(onAuthEvent, null, "auth.fail.forbidden");
        throw new AuthHttpError(403, { error: "forbidden" });
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
    await cache.set(tokenHash, user, cacheTtl);
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  AuthHttpError,
  Breadcrumbs,
  Feature,
  InProcessAuthCache,
  Onelo,
  OneloAuthError,
  OneloAuthForbidden,
  OneloAuthInvalidToken,
  OneloAuthMissingToken,
  OneloAuthRateLimited,
  OneloAuthUnavailable,
  OneloUser,
  UserFeatures,
  VERSION,
  createResolver,
  extractBearerToken,
  getInstanceId,
  installConsoleCapture,
  installFetchBreadcrumbs,
  parseRetryAfter,
  verifyToken,
  verifyWithRetry
});
