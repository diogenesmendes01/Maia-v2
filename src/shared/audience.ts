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
