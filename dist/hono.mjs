import {
  attachRequestToScope
} from "./chunk-6VK4B7OZ.mjs";
import {
  AuthHttpError,
  createResolver
} from "./chunk-5SIT4NER.mjs";

// src/hono.ts
function requireUser(client, options = {}) {
  const { resolve } = createResolver(client, options);
  return async (c, next) => {
    let user;
    try {
      user = await resolve(c.req.header("authorization") ?? null, c.req.query("token") ?? null);
    } catch (err) {
      if (err instanceof AuthHttpError) {
        return c.json(err.body, err.status);
      }
      throw err;
    }
    c.set("oneloUser", user);
    await next();
  };
}
function optionalUser(client, options = {}) {
  const { resolve } = createResolver(client, options);
  return async (c, next) => {
    let user = null;
    try {
      user = await resolve(c.req.header("authorization") ?? null, c.req.query("token") ?? null);
    } catch (err) {
      if (err instanceof AuthHttpError) {
        if (err.status !== 401 && err.status !== 403) {
          return c.json(err.body, err.status);
        }
        user = null;
      } else {
        throw err;
      }
    }
    c.set("oneloUser", user);
    await next();
  };
}
function oneloMonitor(onelo) {
  return (c, next) => onelo.monitor.runWithIsolationScope(async () => {
    attachRequestToScope(onelo.monitor, {
      method: String(c.req.method ?? ""),
      url: c.req.url,
      headers: c.req.header()
    });
    try {
      await next();
    } catch (err) {
      onelo.monitor.captureException(err);
      throw err;
    }
  });
}
export {
  oneloMonitor,
  optionalUser,
  requireUser
};
