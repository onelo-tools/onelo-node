import {
  attachRequestToScope
} from "./chunk-6VK4B7OZ.mjs";
import {
  AuthHttpError,
  createResolver
} from "./chunk-5SIT4NER.mjs";

// src/next.ts
function getQueryToken(req) {
  try {
    return new URL(req.url).searchParams.get("token");
  } catch {
    return null;
  }
}
function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
function withUser(client, handler, options = {}) {
  const { resolve } = createResolver(client, options);
  return async (req, ctx) => {
    let user;
    try {
      user = await resolve(req.headers.get("authorization"), getQueryToken(req));
    } catch (err) {
      if (err instanceof AuthHttpError) {
        return jsonResponse(err.body, err.status);
      }
      throw err;
    }
    return handler(req, user, ctx);
  };
}
function withOptionalUser(client, handler, options = {}) {
  const { resolve } = createResolver(client, options);
  return async (req, ctx) => {
    let user = null;
    try {
      user = await resolve(req.headers.get("authorization"), getQueryToken(req));
    } catch (err) {
      if (err instanceof AuthHttpError) {
        if (err.status === 401 || err.status === 403) {
          user = null;
        } else {
          return jsonResponse(err.body, err.status);
        }
      } else {
        throw err;
      }
    }
    return handler(req, user, ctx);
  };
}
function withMonitor(onelo, handler) {
  return (req, ctx) => onelo.monitor.runWithIsolationScope(async () => {
    attachRequestToScope(onelo.monitor, {
      method: req.method,
      url: req.url,
      headers: req.headers
    });
    try {
      return await handler(req, ctx);
    } catch (err) {
      onelo.monitor.captureException(err);
      throw err;
    }
  });
}
export {
  withMonitor,
  withOptionalUser,
  withUser
};
