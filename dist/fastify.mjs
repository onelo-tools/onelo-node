import {
  attachRequestToScope
} from "./chunk-NDCIQ6ZJ.mjs";
import {
  AuthHttpError,
  createResolver
} from "./chunk-KZQMTYWC.mjs";

// src/fastify.ts
function getAuthHeader(req) {
  const h = req.headers["authorization"];
  if (Array.isArray(h)) return h[0] ?? null;
  return h ?? null;
}
function getQueryToken(req) {
  const q = req.query;
  if (q && typeof q === "object") {
    const t = q.token;
    if (typeof t === "string") return t;
    if (Array.isArray(t) && typeof t[0] === "string") return t[0];
  }
  return null;
}
function requireUser(client, options = {}) {
  const { resolve } = createResolver(client, options);
  return async (req, reply) => {
    try {
      req.oneloUser = await resolve(getAuthHeader(req), getQueryToken(req));
    } catch (err) {
      if (err instanceof AuthHttpError) {
        reply.code(err.status).send(err.body);
        return reply;
      }
      throw err;
    }
  };
}
function optionalUser(client, options = {}) {
  const { resolve } = createResolver(client, options);
  return async (req, reply) => {
    try {
      req.oneloUser = await resolve(getAuthHeader(req), getQueryToken(req));
    } catch (err) {
      if (err instanceof AuthHttpError) {
        if (err.status === 401 || err.status === 403) {
          req.oneloUser = null;
          return;
        }
        reply.code(err.status).send(err.body);
        return reply;
      }
      throw err;
    }
  };
}
function registerOneloMonitor(fastify, onelo) {
  fastify.addHook("onRequest", (req, _reply, done) => {
    onelo.monitor.runWithIsolationScope(() => {
      const r = req;
      attachRequestToScope(onelo.monitor, {
        method: String(r.method ?? ""),
        url: String(r.url ?? ""),
        headers: req.headers
      });
      done();
    });
  });
  fastify.addHook("onError", (_req, _reply, error, done) => {
    onelo.monitor.captureException(error);
    done();
  });
}
export {
  optionalUser,
  registerOneloMonitor,
  requireUser
};
