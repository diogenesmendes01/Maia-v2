/**
 * Issue #409 — `SkillUsagePolicy`: the NATIVE, typed governance contract that
 * declares not just WHAT a skill does, but WHO it may be used with, on WHICH
 * channels, WHAT data it may access/expose, and whether it needs trust /
 * confirmation / a risk ceiling.
 *
 * This COMPLEMENTS (never replaces) the existing `policy_descriptors` (P8e DSL)
 * and `constraints` columns — those stay as the descriptor/DSL layer; this is
 * the strongly-typed, per-audience admission layer enforced at TWO points
 * (defense-in-depth, tech-lead refinement):
 *
 *   1. Candidate filter (EARLY, conservative) — `skill-selector` removes
 *      candidates whose policy does not admit the resolved `AudienceContext`
 *      BEFORE any tool reaches the LLM (invariant #2: backend disposes BEFORE
 *      the LLM gets tools).
 *   2. Execution gate (LATE, fail-closed) — `skill-runner` gate ~4.6
 *      re-evaluates the policy against the audience, closing the TOCTOU window
 *      between selection and execution (invariant #5).
 *
 * The enums are the canonical ones from `src/shared/audience.ts`
 * (`AudienceType`, `TrustLevel`, `DataScope`) — NOT redefined here, to prevent
 * the drift that would let a policy decide against a value the resolver can
 * never produce.
 */
import { z } from 'zod';
import {
  AUDIENCE_TYPES,
  DATA_SCOPES,
  type AudienceType,
  type DataScope,
  type TrustLevel,
} from '@/shared/audience.js';

// z.enum needs a non-empty *mutable tuple*; the canonical arrays are
// `readonly`. Spreading into a fresh array preserves the literal element types
// while satisfying the tuple constraint (single source of truth unchanged).
const audienceEnum = z.enum([...AUDIENCE_TYPES] as [AudienceType, ...AudienceType[]]);
const dataScopeEnum = z.enum([...DATA_SCOPES] as [DataScope, ...DataScope[]]);

/** Exposure posture — how widely the skill's OUTPUT may travel. */
export const EXPOSURE_POLICIES = [
  'internal_only',
  'subject_only',
  'public_safe',
  'approval_required',
] as const;
export type ExposurePolicy = (typeof EXPOSURE_POLICIES)[number];

/**
 * Minimum trust posture a skill requires of its audience. A SUBSET of the
 * canonical `TrustLevel` vocabulary (only the "permitting" levels make sense as
 * a requirement; `unverified`/`unknown`/`blocked` are never a *requirement*).
 */
export const REQUIRED_AUTH_LEVELS = [
  'trusted_internal',
  'known_external',
  'verified_subject',
] as const;
export type RequiredAuthLevel = (typeof REQUIRED_AUTH_LEVELS)[number];

/** Risk ceiling vocabulary — `blocked_when_risk_at_or_above`. */
export const RISK_CEILING_LEVELS = ['medium', 'high', 'critical'] as const;
export type RiskCeilingLevel = (typeof RISK_CEILING_LEVELS)[number];

/**
 * The `SkillUsagePolicy` Zod contract (issue #409 body, verbatim shape).
 *
 * `.strict()` so an unknown key in a persisted/edited policy is a VALIDATION
 * FAILURE rather than a silently-ignored field — a malformed policy must be
 * caught, not waved through (the no-policy default below is the deliberate,
 * documented conservative fallback; a *malformed* policy is not).
 */
export const SkillUsagePolicySchema = z
  .object({
    /** Audiences explicitly ALLOWED to use this skill. Required, ≥1. */
    allowed_audience: z.array(audienceEnum).min(1),
    /** Audiences explicitly BLOCKED — wins over `allowed_audience`. */
    blocked_audience: z.array(audienceEnum).optional(),
    /** Channels the skill is restricted to (when present, an allow-list). */
    allowed_channels: z.array(z.string().min(1)).optional(),
    /** Channels explicitly blocked — wins over `allowed_channels`. */
    blocked_channels: z.array(z.string().min(1)).optional(),
    /** Data classes the skill may access/expose. Required, ≥1. */
    data_scope: z.array(dataScopeEnum).min(1),
    /** How widely the skill output may travel. */
    exposure_policy: z.enum(EXPOSURE_POLICIES),
    /** Minimum trust posture required of the audience. */
    requires_auth_level: z.enum(REQUIRED_AUTH_LEVELS),
    /** Whether the skill needs an explicit confirmation before acting. */
    requires_confirmation: z.boolean(),
    /** Risk ceiling: block when the turn risk is AT OR ABOVE this level. */
    blocked_when_risk_at_or_above: z.enum(RISK_CEILING_LEVELS).optional(),
  })
  .strict();

export type SkillUsagePolicy = z.infer<typeof SkillUsagePolicySchema>;

/**
 * The typed reasons a usage-policy evaluation can BLOCK on. These map 1:1 to the
 * new `SkillFailureReason` values (skills/types.ts) and drive the new
 * `AUDIT_ACTIONS` (`skill_blocked_by_*`).
 */
export type UsagePolicyBlockReason =
  | 'audience_blocked'
  | 'channel_blocked'
  | 'data_scope_blocked'
  | 'auth_level_insufficient'
  | 'risk_blocked';

export type UsagePolicyDecision =
  | { allowed: true }
  | { allowed: false; reason: UsagePolicyBlockReason; detail: string };

/**
 * The audience/channel/risk facts a usage-policy decision is made against. A
 * NARROW projection of `AudienceContext` (#407) + the turn risk so the
 * evaluator stays pure and trivially unit-testable, and so BOTH enforcement
 * points (selector early, runner late) feed it the same shape.
 */
export interface UsagePolicyEvalContext {
  audience_type: AudienceType;
  trust_level: TrustLevel;
  /** The channel the turn arrived on (e.g. `whatsapp`). */
  channel_type: string;
  /**
   * The classes of data this turn is allowed to expose to the audience, when
   * known. When provided, the skill's declared `data_scope` MUST be a subset:
   * a skill that touches a data class the audience may not receive is blocked.
   * When `undefined`, the data_scope check is skipped (no allowed set to test
   * against) — the audience/auth checks still apply.
   */
  allowed_data_scope?: readonly DataScope[];
  /** Pre-execution turn risk level (RiskScorer), when known. */
  risk_level?: RiskCeilingLevel | 'low';
}

/**
 * Trust-level ranking used to satisfy `requires_auth_level`. A higher number is
 * "more trusted". `verified_subject` is the SUBJECT axis: a `known_external`
 * contact acting on their OWN data satisfies a `verified_subject` requirement
 * (that is exactly the "customer skill limited to own_customer_data_only" case
 * from the issue). We therefore treat `known_external` as satisfying
 * `verified_subject` AND `known_external`; only `trusted_internal` satisfies the
 * `trusted_internal` requirement.
 */
const TRUST_RANK: Record<TrustLevel, number> = {
  blocked: 0,
  unknown: 1,
  unverified: 1,
  known_external: 2,
  trusted_internal: 3,
};

const REQUIRED_AUTH_MIN_RANK: Record<RequiredAuthLevel, number> = {
  // A known_external contact (rank 2) is the floor for a verified subject.
  verified_subject: 2,
  known_external: 2,
  trusted_internal: 3,
};

const RISK_RANK: Record<RiskCeilingLevel | 'low', number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/**
 * Pure, side-effect-free admission decision for a single skill's usage policy
 * against the resolved audience/channel/risk. Fail-closed by construction: any
 * declared restriction that the context does NOT satisfy returns a typed block;
 * only a context that clears EVERY declared restriction returns `allowed`.
 *
 * Evaluation order (most-specific deny first → then requirements):
 *   1. blocked_audience  → `audience_blocked`
 *   2. allowed_audience (membership) → `audience_blocked`
 *   3. blocked_channels  → `channel_blocked`
 *   4. allowed_channels (membership) → `channel_blocked`
 *   5. data_scope ⊄ allowed_data_scope → `data_scope_blocked`
 *   6. trust < requires_auth_level → `auth_level_insufficient`
 *   7. risk ≥ blocked_when_risk_at_or_above → `risk_blocked`
 */
export function evaluateUsagePolicy(
  policy: SkillUsagePolicy,
  ctx: UsagePolicyEvalContext,
): UsagePolicyDecision {
  // 1. Explicit block-list wins over everything.
  if (policy.blocked_audience?.includes(ctx.audience_type)) {
    return {
      allowed: false,
      reason: 'audience_blocked',
      detail: `audience '${ctx.audience_type}' is in blocked_audience`,
    };
  }

  // 2. Must be in the allow-list.
  if (!policy.allowed_audience.includes(ctx.audience_type)) {
    return {
      allowed: false,
      reason: 'audience_blocked',
      detail: `audience '${ctx.audience_type}' is not in allowed_audience [${policy.allowed_audience.join(', ')}]`,
    };
  }

  // 3. Explicit channel block-list.
  if (policy.blocked_channels?.includes(ctx.channel_type)) {
    return {
      allowed: false,
      reason: 'channel_blocked',
      detail: `channel '${ctx.channel_type}' is in blocked_channels`,
    };
  }

  // 4. Channel allow-list (when present).
  if (
    policy.allowed_channels &&
    policy.allowed_channels.length > 0 &&
    !policy.allowed_channels.includes(ctx.channel_type)
  ) {
    return {
      allowed: false,
      reason: 'channel_blocked',
      detail: `channel '${ctx.channel_type}' is not in allowed_channels [${policy.allowed_channels.join(', ')}]`,
    };
  }

  // 5. Data-scope containment: the skill may only touch data classes the
  // audience is allowed to receive (when an allowed set is known).
  if (ctx.allowed_data_scope) {
    const allowed = new Set(ctx.allowed_data_scope);
    const leaked = policy.data_scope.filter((d) => !allowed.has(d));
    if (leaked.length > 0) {
      return {
        allowed: false,
        reason: 'data_scope_blocked',
        detail: `skill data_scope [${leaked.join(', ')}] exceeds audience-allowed [${[...allowed].join(', ')}]`,
      };
    }
  }

  // 6. Trust / auth-level floor.
  const haveRank = TRUST_RANK[ctx.trust_level] ?? 0;
  const needRank = REQUIRED_AUTH_MIN_RANK[policy.requires_auth_level];
  if (haveRank < needRank) {
    return {
      allowed: false,
      reason: 'auth_level_insufficient',
      detail: `trust_level '${ctx.trust_level}' does not satisfy requires_auth_level '${policy.requires_auth_level}'`,
    };
  }

  // 7. Risk ceiling.
  if (policy.blocked_when_risk_at_or_above && ctx.risk_level) {
    const ceiling = RISK_RANK[policy.blocked_when_risk_at_or_above];
    const turn = RISK_RANK[ctx.risk_level];
    if (turn >= ceiling) {
      return {
        allowed: false,
        reason: 'risk_blocked',
        detail: `turn risk '${ctx.risk_level}' is at or above blocked_when_risk_at_or_above '${policy.blocked_when_risk_at_or_above}'`,
      };
    }
  }

  return { allowed: true };
}

/**
 * Parse a raw `usage_policy` JSONB value into a typed `SkillUsagePolicy`, or
 * `null` when ABSENT (the column is nullable). A PRESENT-but-MALFORMED policy
 * throws (caller decides; the runtime callers fail-closed by treating a parse
 * failure as "not admitted" — a malformed governance policy must never silently
 * widen access).
 */
export function parseUsagePolicy(raw: unknown): SkillUsagePolicy | null {
  if (raw === null || raw === undefined) return null;
  // An empty object `{}` is also treated as "no policy declared" — the seed and
  // many legacy rows default JSONB columns to `{}`; treating it as absent keeps
  // those rows on the documented conservative default rather than failing
  // validation (allowed_audience/data_scope are required).
  if (
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    Object.keys(raw as Record<string, unknown>).length === 0
  ) {
    return null;
  }
  return SkillUsagePolicySchema.parse(raw);
}

/**
 * Safe variant: returns a discriminated result instead of throwing. Used by the
 * runtime gates so a malformed policy is fail-closed (treated as a block) rather
 * than crashing the turn.
 */
export function safeParseUsagePolicy(
  raw: unknown,
):
  | { ok: true; policy: SkillUsagePolicy | null }
  | { ok: false; error: string } {
  if (raw === null || raw === undefined) return { ok: true, policy: null };
  if (
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    Object.keys(raw as Record<string, unknown>).length === 0
  ) {
    return { ok: true, policy: null };
  }
  const parsed = SkillUsagePolicySchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') };
  }
  return { ok: true, policy: parsed.data };
}

/**
 * The DOCUMENTED behaviour for a skill with NO `usage_policy` (NULL / `{}`).
 *
 * DECISION (tech-lead DoD: "default conservador OU baseline permissivo seguro"):
 * a skill without a usage_policy is admitted ONLY for INTERNAL, trusted
 * audiences — the conservative default. This means an operator who adds a new
 * skill without thinking about audience governance does NOT accidentally expose
 * it to customers/leads/vendors; they must OPT IN by declaring a policy.
 *
 * The #410 baseline skills are handled SEPARATELY: migration 077 backfills them
 * with an explicit permissive-but-safe policy (they are safe-conversation /
 * clarify / confirm / handoff / audit skills usable by ANY audience), so they
 * keep working for every audience. We do NOT rely on the NULL default for them —
 * we give them a real policy. This function is the fallback for any OTHER
 * policy-less skill.
 *
 * Returned policy:
 *   - allowed_audience : the internal roles (owner/manager/employee/accountant/
 *     system_user) — NOT customer/lead/vendor.
 *   - data_scope       : `internal_business_summary` only.
 *   - exposure_policy  : `internal_only`.
 *   - requires_auth_level : `trusted_internal`.
 */
export const CONSERVATIVE_DEFAULT_USAGE_POLICY: SkillUsagePolicy = {
  allowed_audience: ['owner', 'manager', 'employee', 'accountant', 'system_user'],
  data_scope: ['internal_business_summary'],
  exposure_policy: 'internal_only',
  requires_auth_level: 'trusted_internal',
  requires_confirmation: false,
};

/**
 * Deterministic mapping from a resolved audience to the DATA CLASSES that
 * audience may RECEIVE (issue #409 — drives the `data_scope_blocked` check).
 *
 * This is the audience→data governance table. It is intentionally conservative
 * and explicit: a skill whose declared `data_scope` is NOT a subset of the set
 * returned here is removed/refused for that audience. Examples from the issue:
 *   - owner / manager : full internal visibility (all classes).
 *   - accountant      : financial + operations summaries + public (no raw
 *                       customer data axis beyond the business view).
 *   - employee        : operations summary + public (internal ops, not finance).
 *   - customer / lead / vendor (external subjects): ONLY their OWN data +
 *     public info — this is the `daily_business_summary` (financial_summary)
 *     leak guard, and the "customer skill limited to own_customer_data_only".
 *   - system_user     : full internal visibility (automation/integration).
 *   - unknown         : public info only (fail-closed floor).
 *
 * `trust_level` is accepted for future refinement (e.g. an `unverified`
 * internal contact) but the current table keys on `audience_type` — the
 * governance-derived role is the primary axis (#407 invariant #3).
 */
export function allowedDataScopesForAudience(
  audience_type: AudienceType,
  _trust_level: TrustLevel,
): DataScope[] {
  switch (audience_type) {
    case 'owner':
    case 'manager':
    case 'system_user':
      return [
        'internal_business_summary',
        'financial_summary',
        'operations_summary',
        'own_customer_data_only',
        'public_info',
      ];
    case 'accountant':
      return ['financial_summary', 'operations_summary', 'public_info'];
    case 'employee':
      return ['internal_business_summary', 'operations_summary', 'public_info'];
    case 'customer':
    case 'lead':
    case 'vendor':
      return ['own_customer_data_only', 'public_info'];
    case 'unknown':
    default:
      return ['public_info'];
  }
}

/**
 * Resolve the EFFECTIVE policy for a skill: the declared policy when present and
 * valid, otherwise the conservative default. A malformed policy returns `null`
 * to signal the caller to fail-closed (the malformed case is NOT the same as
 * "absent" — we do not silently fall back to a default for a broken policy).
 */
export function resolveEffectiveUsagePolicy(
  raw: unknown,
):
  | { ok: true; policy: SkillUsagePolicy; source: 'declared' | 'conservative_default' }
  | { ok: false; error: string } {
  const parsed = safeParseUsagePolicy(raw);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (parsed.policy === null) {
    return {
      ok: true,
      policy: CONSERVATIVE_DEFAULT_USAGE_POLICY,
      source: 'conservative_default',
    };
  }
  return { ok: true, policy: parsed.policy, source: 'declared' };
}
