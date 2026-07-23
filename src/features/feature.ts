/**
 * The `Feature` value object + `UserFeatures` snapshot. 1:1 with Python's
 * `onelo._features.Feature` / `UserFeatures`, including the exact status
 * vocabulary and the fail-closed `isVisible`/`isKnown` semantics.
 */
import type { FeatureState } from './cache'

// Availability model — kept 1:1 with Swift/Python so cross-language docs match:
//   available (usable):    enabled, new, beta
//   visible, not usable:   coming_soon, greyed, upsell
//   not visible:           hidden — AND any status this SDK build doesn't know
//                          (fail-closed)
const ENABLED_STATUSES = new Set(['enabled', 'new', 'beta'])
const VISIBLE_STATUSES = new Set(['enabled', 'new', 'beta', 'coming_soon', 'greyed', 'upsell'])
const KNOWN_STATUSES = new Set([...VISIBLE_STATUSES, 'hidden'])

/** Statuses whose visibility depends on the user's plan (misuse signal on the global path). */
export const GATED_STATUSES = new Set(['upsell', 'greyed'])

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : value == null ? fallback : String(value)
}

/**
 * A single feature's resolved state. Carries the backend's full upsell metadata
 * so a server-rendered app (Next.js SSR, Express+templates) can build an
 * "Available in Pro" CTA — not just a binary on/off.
 */
export class Feature {
  constructor(
    readonly name: string,
    readonly status: string,
    readonly reason: string | null = null,
    readonly requiredPlan: string | null = null,
    readonly requiredPlanLabel: string | null = null,
    readonly upgradeCta: boolean = false,
  ) {}

  /**
   * Build a Feature from a backend wire state dict. Tolerates a bare status
   * string, ignores unknown extra keys (forward-compat). Missing status →
   * hidden (fail-closed).
   */
  static fromWire(name: string, state: unknown): Feature {
    if (state === null || typeof state !== 'object' || Array.isArray(state)) {
      return new Feature(name, str(state, 'hidden') || 'hidden')
    }
    const s = state as FeatureState
    return new Feature(
      name,
      typeof s.status === 'string' ? s.status : 'hidden',
      s.reason == null ? null : String(s.reason),
      s.required_plan == null ? null : String(s.required_plan),
      s.required_plan_label == null ? null : String(s.required_plan_label),
      Boolean(s.upgrade_cta),
    )
  }

  /** True for enabled / new / beta — the default check for binary gating. */
  get isEnabled(): boolean {
    return ENABLED_STATUSES.has(this.status)
  }

  /**
   * True for any user-visible status. False for hidden AND for any status this
   * SDK build does not recognise — fail-closed, so a typo or a newer backend
   * status never renders as a blank visible item.
   */
  get isVisible(): boolean {
    return VISIBLE_STATUSES.has(this.status)
  }

  get isGreyed(): boolean {
    return this.status === 'greyed'
  }

  get isNew(): boolean {
    return this.status === 'new'
  }

  get isBeta(): boolean {
    return this.status === 'beta'
  }

  get isComingSoon(): boolean {
    return this.status === 'coming_soon'
  }

  /** Feature is in upsell mode — a paid/locked teaser shown to the user. */
  get isUpsell(): boolean {
    return this.status === 'upsell'
  }

  /**
   * True if `status` is one this SDK build understands. False means the backend
   * returned a status newer than this SDK (treated as hidden) — surface it as a
   * hint to upgrade the SDK.
   */
  get isKnown(): boolean {
    return KNOWN_STATUSES.has(this.status)
  }

  /**
   * The human plan LABEL to show as an upsell (e.g. "Pro"), or null when the
   * backend attached no label. Render as `Available in ${feature.upgradeHint}`.
   * The backend is the authority — it attaches the label only to a
   * blocked-but-visible feature a real upgrade would unlock.
   */
  get upgradeHint(): string | null {
    return this.requiredPlanLabel || null
  }
}

/**
 * Resolved feature snapshot for ONE specific user — returned by
 * `features.forUser()`. Read-only; safe to share across async work. Unlike the
 * process-global `feature()` path, this never mutates SDK identity, so it is
 * SAFE per request/connection in a multi-user backend.
 */
export class UserFeatures {
  constructor(
    readonly userId: string,
    private readonly states: Record<string, FeatureState>,
  ) {}

  /** This feature's state (incl. upsell metadata) FOR THIS USER. Missing → hidden. */
  feature(name: string): Feature {
    return Feature.fromWire(name, this.states[name] ?? { status: 'hidden' })
  }

  /** Shorthand for `feature(name).isEnabled`. */
  isEnabled(name: string): boolean {
    return this.feature(name).isEnabled
  }
}
