/**
 * Issue #416 — boleto proposal vertical: write/risk policy descriptors.
 *
 * The THREE policy descriptors seeded by `migrations/078_boleto_write_risk_policies.sql`
 * as `policy_rules` rows, surfaced here as typed constants so code, the #415
 * role/skill wiring, and tests reference the EXACT descriptor strings (no magic
 * strings drifting from the seed). These descriptors are resolved at runtime by
 * `policyDescriptorResolver` (`./policy-descriptor-resolver.ts`) exactly like any
 * other `policy_rules` descriptor — this module adds NO new resolution path.
 *
 * Governance contract (capability-taxonomy §3/§6): these policies DECIDE
 * (allow / confirm / block / escalate) and the dispatcher + `constitutionalCheck`
 * ENFORCE; a skill never decides confirmation in its body. The descriptors are
 * attached to a skill via `skills.policy_descriptors` (the #415 role/skill issue
 * wires that — this issue only makes the descriptors exist + makes the packs
 * grantable).
 */

/**
 * Default policy for the sensitive operational WRITES of the vertical. Governs
 * EXACTLY the three write tools below: requires identified company context +
 * explicit user confirmation, audit before/after, blocks on ambiguous identity,
 * and escalates when the risk policy demands it. Seeded ACTIVE (bootstrap).
 */
export const CONFIRM_BEFORE_WRITE_POLICY = 'confirm_before_write_policy' as const;

/**
 * FUTURE variant that MAY allow automatic write execution for low-risk cases.
 * Seeded as `proposed` (NOT active): #416 deliberately does not enable automatic
 * low-risk writes. It exists so the policy model carries the variant instead of
 * hardcoding confirmation in skills.
 */
export const SMALL_RISK_WRITE_POLICY = 'small_risk_write_policy' as const;

/**
 * Variant for cases that require human confirmation / handoff (medium-high risk,
 * legal threat, formal complaint, ambiguous identity, suspicious receipt, value
 * above threshold, formal dispute). Seeded ACTIVE (bootstrap).
 */
export const HUMAN_CONFIRMATION_POLICY = 'human_confirmation_policy' as const;

/** All three #416 write/risk policy descriptors, in seed order. */
export const BOLETO_WRITE_RISK_POLICY_DESCRIPTORS = [
  CONFIRM_BEFORE_WRITE_POLICY,
  SMALL_RISK_WRITE_POLICY,
  HUMAN_CONFIRMATION_POLICY,
] as const;

export type BoletoWriteRiskPolicyDescriptor =
  (typeof BOLETO_WRITE_RISK_POLICY_DESCRIPTORS)[number];

/**
 * Issue #437 — the subset of #416 write/risk descriptors that are ACTIVE and
 * DSL-shaped, so the P9b Decision Engine can resolve + evaluate them at runtime.
 *
 * Why a curated list (and not "all active policies"): the Decision Engine asks
 * the resolver for "all applicable policies" (sentinel `'*'`), but the P9d DSL
 * evaluator can only evaluate `policy_rules` whose `rule_body` uses the kind-
 * tagged `PolicyRuleBody` AST (migration 078). The legacy hard-limit seed
 * (migration 037) still stores the pre-DSL `{all|any}` predicate shape, which the
 * evaluator would (correctly) reject as `evaluation_error` → BLOCK — fail-closed
 * by design, but it would block every turn if resolved indiscriminately. Until
 * 037 is migrated to the DSL shape, the prod resolver adapter expands `'*'` to
 * exactly this curated, DSL-evaluable set (`src/runtime/decision/prod-env.ts`).
 *
 * `small_risk_write_policy` is intentionally absent: it is seeded `proposed`
 * (never `active`), so the resolver would not return it anyway, and #416
 * deliberately does NOT enable automatic low-risk writes.
 */
export const RUNTIME_ENFORCED_WRITE_RISK_DESCRIPTORS = [
  CONFIRM_BEFORE_WRITE_POLICY,
  HUMAN_CONFIRMATION_POLICY,
] as const;

/**
 * The tool registry names that `confirm_before_write_policy` governs — EXACTLY
 * the three sensitive writes (acceptance criterion: "`confirm_before_write_policy`
 * governs `boleto_cancel`, `company_campaign_remove`, and `refund_create`").
 * Each of these tools is `side_effect: 'write'` in the registry and passes the
 * dispatcher guard; this constant documents + lets tests assert the exact
 * governed set. The 078 seed's predicate matches the same three by name.
 */
export const CONFIRM_BEFORE_WRITE_GOVERNED_TOOLS = [
  'boleto_cancel',
  'company_campaign_remove',
  'refund_create',
] as const;

export type ConfirmBeforeWriteGovernedTool =
  (typeof CONFIRM_BEFORE_WRITE_GOVERNED_TOOLS)[number];
