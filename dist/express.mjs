import {
  attachRequestToScope
} from "./chunk-6VK4B7OZ.mjs";
import {
  AuthHttpError,
  createResolver
} from "./chunk-5SIT4NER.mjs";

// src/express.ts
function getAuthHeader(req) {
  const h = req.headers["authorization"];
  if (Array.isArray(h)) return h[0] ?? null;
  return h ?? null;
}
function getQueryToken(req) {
  const q = req.query?.token;
  if (typeof q === "string") return q;
  if (Array.isArray(q) && typeof q[0] === "string") return q[0];
  return null;
}
function requireUser(client, options = {}) {
  const { resolve } = createResolver(client, options);
  return async (req, res, next) => {
    try {
      req.oneloUser = await resolve(getAuthHeader(req), getQueryToken(req));
    } catch (err) {
      if (err instanceof AuthHttpError) {
        res.status(err.status).json(err.body);
        return;
      }
      next(err);
      return;
    }
    next();
  };
}
function optionalUser(client, options = {}) {
  const { resolve } = createResolver(client, options);
  return async (req, res, next) => {
    try {
      req.oneloUser = await resolve(getAuthHeader(req), getQueryToken(req));
    } catch (err) {
      if (err instanceof AuthHttpError) {
        if (err.status === 401 || err.status === 403) {
          req.oneloUser = null;
          next();
          return;
        }
        res.status(err.status).json(err.body);
        return;
      }
      next(err);
      return;
    }
    next();
  };
}
function monitorRequestHandler(onelo) {
  return (req, res, next) => {
    onelo.monitor.runWithIsolationScope(() => {
      attachRequestToScope(onelo.monitor, {
        method: String(req.method ?? ""),
        url: String(req.originalUrl ?? req.url ?? ""),
        headers: req.headers
      });
      next();
    });
  };
}
function monitorErrorHandler(onelo) {
  return (err, _req, _res, next) => {
    onelo.monitor.captureException(err);
    next(err);
  };
}
export {
  monitorErrorHandler,
  monitorRequestHandler,
  optionalUser,
  requireUser
};
