/**
 * `@onelo/node` — Onelo backend SDK for Node.js.
 *
 * The main entry point exposes the client, the framework-agnostic auth core,
 * the error taxonomy, and the cache. Framework adapters ship as subpath imports
 * so you only pull in the one you use:
 *
 *   import { requireUser } from '@onelo/node/express'
 *   import { withUser }    from '@onelo/node/next'
 *   import { requireUser } from '@onelo/node/fastify'
 *   import { requireUser } from '@onelo/node/hono'
 *
 * The core (`verifyToken`) works with ANY framework — Nest, Koa, raw http — so
 * an adapter is only ergonomic sugar.
 */
export { Onelo } from './client'
export type { OneloConfig, AuthClient } from './client'

export { OneloUser } from './auth/user'

export {
  verifyToken,
  verifyWithRetry,
  extractBearerToken,
  parseRetryAfter,
} from './auth/verify'
export type { FetchLike, VerifyRetryOptions } from './auth/verify'

export { assertIdentity } from './auth/assert'
export type { AssertIdentityOptions, AssertedIdentity } from './auth/assert'
export type { IssuedSession } from './auth/exchange'

export { InProcessAuthCache } from './auth/cache'
export type { AuthCache } from './auth/cache'

export { createResolver, AuthHttpError } from './auth/resolve'
export type { Resolver, ResolverOptions, OnAuthEvent } from './auth/resolve'

export {
  OneloAuthError,
  OneloAuthMissingToken,
  OneloAuthInvalidToken,
  OneloAuthForbidden,
  OneloAuthUnavailable,
  OneloAuthRateLimited,
} from './auth/errors'

// ── Features ──────────────────────────────────────────────────────────────
export { Feature, UserFeatures } from './features/feature'
export type { FeaturesClient, ForUserOptions } from './features/client'
export type { Strategy } from './features/detection'
export { getInstanceId } from './features/instance'

// ── Monitor ─────────────────────────────────────────────────────────────
export { Breadcrumbs } from './monitor/types'
export type {
  Breadcrumb,
  BreadcrumbCategory,
  EventLevel,
  MonitorEvent,
  CapturedException,
  StackFrame,
} from './monitor/types'
export type {
  MonitorClient,
  MonitorInitOptions,
  CaptureExceptionOptions,
  CaptureMessageOptions,
  TrackOptions,
  AddBreadcrumbOptions,
} from './monitor/client'

export type { CarrierOptions } from './monitor/propagation'

export { installConsoleCapture, installFetchBreadcrumbs } from './monitor/integrations'
export type {
  ConsoleCaptureOptions,
  FetchBreadcrumbOptions,
  CaptureMonitor,
} from './monitor/integrations'

export { VERSION } from './version'
