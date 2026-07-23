import {
  scrubHeaders,
  scrubUrl
} from "./chunk-5SIT4NER.mjs";

// src/monitor/request-context.ts
var DROP_HEADERS = /* @__PURE__ */ new Set(["cookie", "set-cookie", "authorization"]);
function normalizeHeaders(headers) {
  if (!headers) return null;
  const out = {};
  const maybeForEach = headers.forEach;
  if (typeof maybeForEach === "function" && !Array.isArray(headers)) {
    ;
    headers.forEach((v, k) => {
      out[k.toLowerCase()] = v;
    });
    return out;
  }
  for (const [k, v] of Object.entries(headers)) {
    if (v == null) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
}
function buildRequestContext(input) {
  const ctx = { method: (input.method || "").toUpperCase() };
  const url = scrubUrl(input.url);
  if (url) ctx.url = url;
  const normalized = normalizeHeaders(input.headers);
  const scrubbed = normalized ? scrubHeaders(normalized) : null;
  if (scrubbed) {
    const kept = Object.fromEntries(
      Object.entries(scrubbed).filter(([k]) => !DROP_HEADERS.has(k.toLowerCase()))
    );
    if (Object.keys(kept).length > 0) ctx.headers = kept;
  }
  return ctx;
}
function attachRequestToScope(monitor, input) {
  monitor.setContext("request", buildRequestContext(input));
  if (input.userId != null) monitor.setUser({ id: input.userId });
}

export {
  attachRequestToScope
};
