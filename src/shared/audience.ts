/**
 * Canonical audience enums — the single source of truth for per-agent
 * audience governance (issue #407).
 *
 * Why a shared module (and not inline in schema.ts): the downstream chain
 * (#410 → #408 → #409) reuses these exact literals to drive skill-by-audience
 * policy (`SkillUsagePolicy.allowed_audience`). Defining them once here, as
 * `as const` arrays with derived union types, prevents the enum drift that
 * would silently let a policy decide against a value the resolver can never
 * produce.
 *
 * Scope for #407 is deliberately narrow: ONLY `AudienceType` + `TrustLevel`.
 * `DataScope` (and any further audience-governance vocabulary) is #409's job
 * — adding it here pre-emptively would couple this foundation to a contract
 * that isn't designed yet.
 *
 * Invariant #3 (confidence/trust is computed): `trust_level` is DERIVED from
 * the pessoa↔agent relationship and governance state — it is never declared
 * by the LLM. This module only enumerates the legal values; the derivation
 * lives in the migration backfill + `agent_audience_profiles` writes.
 */

/**
 * Who a contact is *to a specific agent* (per `tenant_id + agent_id +
 * contact_id`), not who they are globally. The same human/phone can be a
 * `customer` for Agent X and an `employee` for Agent Y.
 */
export const AUDIENCE_TYPES = [
  'owner',
  'manager',
  'employee',
  'accountant',
  'customer',
  'vendor',
  'lead',
  'system_user',
  'unknown',
] as const;

export type AudienceType = (typeof AUDIENCE_TYPES)[number];

/**
 * Computed trust posture of the relationship. Derived from the relationship +
 * governance state (invariant #3) — NEVER self-declared by the model.
 */
export const TRUST_LEVELS = [
  'trusted_internal',
  'known_external',
  'unverified',
  'unknown',
  'blocked',
] as const;

export type TrustLevel = (typeof TRUST_LEVELS)[number];

/**
 * The CLASS of data a skill may access/expose (issue #409). This is the
 * canonical vocabulary for `SkillUsagePolicy.data_scope` — a skill DECLARES the
 * data classes it touches, and the per-turn enforcement decides whether the
 * resolved audience may receive that class. Defined HERE (the single source of
 * truth) so the Zod contract in `src/skills/usage-policy.ts` and the runtime
 * filters reuse the same literals — preventing the same enum drift the audience
 * module already guards against.
 *
 * Ordering from most-internal to most-public:
 *   - internal_business_summary : aggregate internal state (not financial).
 *   - financial_summary         : money figures / balances / revenue.
 *   - operations_summary        : operational metrics (volume, throughput).
 *   - own_customer_data_only    : data scoped to the SUBJECT themselves only.
 *   - public_info               : safe-to-share-with-anyone information.
 *
 * `#409`-scoped on purpose: it does NOT enumerate `exposure_policy` or
 * `requires_auth_level` — those stay typed inside the skill usage-policy Zod
 * contract because they are not reused by any resolver outside skills.
 */
export const DATA_SCOPES = [
  'internal_business_summary',
  'financial_summary',
  'operations_summary',
  'own_customer_data_only',
  'public_info',
] as const;

export type DataScope = (typeof DATA_SCOPES)[number];

/** Type guards — useful for validating values read from the DB / external input. */
export function isAudienceType(value: unknown): value is AudienceType {
  return (
    typeof value === 'string' && (AUDIENCE_TYPES as readonly string[]).includes(value)
  );
}

export function isTrustLevel(value: unknown): value is TrustLevel {
  return (
    typeof value === 'string' && (TRUST_LEVELS as readonly string[]).includes(value)
  );
}

export function isDataScope(value: unknown): value is DataScope {
  return (
    typeof value === 'string' && (DATA_SCOPES as readonly string[]).includes(value)
  );
}
