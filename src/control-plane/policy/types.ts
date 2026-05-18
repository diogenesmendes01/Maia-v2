/**
 * P8e — Types for the policy_rules table + PolicyDescriptorResolver.
 *
 * Master spec v3.1.1 §2.1, §2.2. `rule_body` is OPAQUE in P8e (DSL/AST
 * evaluator lives in P9d). Here we only expose the JSON object shape.
 *
 * The `const X = {} as const` + `type X = typeof X[keyof typeof X]` pattern
 * is legitimate in TS (same name in value + type space). `no-redeclare`
 * sees that as a conflict; disable here as enums.ts does.
 */
/* eslint-disable @typescript-eslint/no-redeclare */

/**
 * 4 kinds of governance rule. hard_limit gets the strictest activation
 * guard (dual approval required, validated by P8.5 Admin UI in the future).
 */
export const PolicyRuleKind = {
  HARD_LIMIT: 'hard_limit',
  SOFT_GUIDANCE: 'soft_guidance',
  DUAL_APPROVAL: 'dual_approval',
  LOCKDOWN_TRIGGER: 'lockdown_trigger',
} as const;
export type PolicyRuleKind = (typeof PolicyRuleKind)[keyof typeof PolicyRuleKind];

/**
 * Lifecycle status of a policy_rule row. Append-only versioning:
 *   proposed -> active|rolled_back   (rolled_back terminal)
 *   active   -> deprecated|rolled_back
 *   deprecated -> rolled_back (terminal otherwise)
 *   rolled_back terminal.
 */
export const PolicyRuleStatus = {
  PROPOSED: 'proposed',
  ACTIVE: 'active',
  DEPRECATED: 'deprecated',
  ROLLED_BACK: 'rolled_back',
} as const;
export type PolicyRuleStatus = (typeof PolicyRuleStatus)[keyof typeof PolicyRuleStatus];

/**
 * Provenance of the rule. Drives audit reporting; not consulted by resolver.
 */
export const PolicySourceOfTruth = {
  FOUNDER_EXPLICIT: 'founder_explicit',
  LEGAL_COMPLIANCE: 'legal_compliance',
  TENANT_CULTURE: 'tenant_culture',
  INCIDENT_POSTMORTEM: 'incident_postmortem',
} as const;
export type PolicySourceOfTruth = (typeof PolicySourceOfTruth)[keyof typeof PolicySourceOfTruth];

/**
 * Scope filter: rule applies only when input.scope matches every key set in
 * rule.scope. An empty rule.scope ({}) matches any input. P8e treats scope
 * as an open dict — channel/domain/skill_category are the established keys
 * but consumers may add more without DB migration.
 */
export interface PolicyRuleScope {
  channel?: string;
  domain?: string;
  skill_category?: string;
  [key: string]: string | undefined;
}

/**
 * rule_body is OPAQUE in P8e. P9d (Policy DSL evaluator) reads it. The DB
 * CHECK only enforces `jsonb_typeof = 'object'`. Consumers must not assume
 * shape beyond "JSON object".
 */
export type PolicyRuleBody = Record<string, unknown>;

/**
 * Row shape as returned by the repo (post-mapping from drizzle row).
 */
export interface PolicyRule {
  id: string;
  tenant_id: string;
  agent_id: string | null;
  rule_kind: PolicyRuleKind;
  rule_descriptor: string;
  rule_body: PolicyRuleBody;
  scope: PolicyRuleScope;
  source_of_truth: PolicySourceOfTruth;
  status: PolicyRuleStatus;
  version: number;
  proposed_by: string;
  proposed_reason: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  activated_at: Date | null;
  deprecated_at: Date | null;
  rolled_back_at: Date | null;
  rollback_reason: string | null;
  created_at: Date;
}

/**
 * Lifecycle events emitted on activate/deprecate/rollback. Consumed by the
 * cache via Redis pub/sub on channel CACHE_INVALIDATION_CHANNEL.
 */
export type PolicyLifecycleEventName =
  | 'policy_rule_activated'
  | 'policy_rule_deprecated'
  | 'policy_rule_rolled_back';

export interface PolicyLifecycleEvent {
  event: PolicyLifecycleEventName;
  tenant_id: string;
  agent_id: string | null;
  descriptor: string;
}

/** Master §2.2 — Resolver input. */
export interface PolicyDescriptorResolverInput {
  tenant_id: string;
  agent_id?: string;
  descriptors: string[];
  scope?: PolicyRuleScope;
}

/** Master §2.2 — Resolved row stripped to the minimum the consumer needs. */
export interface ResolvedPolicy {
  descriptor: string;
  policy_id: string;
  version: number;
  rule_kind: PolicyRuleKind;
}

/**
 * Why a descriptor ended up in `unresolved`. The resolver MUST distinguish
 * "no policy exists" (`not_found`) from "the policy store is unavailable"
 * (`db_error`) so PEP callers can fail closed on the latter. Treating
 * `db_error` as `not_found` would let traffic continue without the hard
 * limit during a DB outage — the exact failure-open mode the master spec
 * §0.2 invariant #5 forbids.
 *
 * - `not_found`: no active policy matches the descriptor (and scope filter
 *   if any). The resolver cached the miss; safe to proceed.
 * - `scope_mismatch`: a row exists, but its scope doesn't intersect the
 *   input.scope. Same handling as `not_found` from the caller's POV.
 * - `db_error`: the repo threw. The resolver could not determine whether a
 *   policy exists. Callers MUST treat the descriptor as "policy active,
 *   block by default" (RESOLVER_FAILURE_DEFAULT='block'). Tested in
 *   resolver fail-closed unit spec.
 * - `tenant_mismatch`: input.tenant_id differs from the active tenant
 *   context. Programmer error; resolver refuses to resolve cross-tenant.
 */
export type ResolverFailureReason =
  | 'not_found'
  | 'scope_mismatch'
  | 'db_error'
  | 'tenant_mismatch';

export interface UnresolvedDescriptor {
  descriptor: string;
  reason: ResolverFailureReason;
}

/** Master §2.2 — Resolver output. Invariant: resolved.length + unresolved.length === input.descriptors.length.
 *
 * `unresolved` (string[]) preserved for back-compat with the original spec
 * shape. `failures` (typed) is the source of truth for fail-closed
 * decision-making — callers MUST consult `failures.find(f => f.reason ===
 * 'db_error')` and BLOCK if any exists. See RESOLVER_FAILURE_DEFAULT below.
 */
export interface PolicyDescriptorResolverOutput {
  resolved: ResolvedPolicy[];
  unresolved: string[];
  failures: UnresolvedDescriptor[];
}

/**
 * Fail-closed default for resolver consumers. When the resolver returns a
 * descriptor with `reason: 'db_error'`, the PEP / slice builder MUST default
 * to BLOCK (NEVER auto-allow). Exported as a constant so consumers can
 * reference it in their own invariant checks (and so tests can pin the
 * value to 'block' and fail if someone flips it).
 *
 * Codex review #93 finding: previously the resolver collapsed repo errors
 * into "unresolved" (string), which is indistinguishable from "no policy
 * exists" — letting traffic continue without the hard limit during a DB
 * outage. The new contract: `failures: UnresolvedDescriptor[]` with typed
 * reasons, and this constant pins the caller default.
 */
export const RESOLVER_FAILURE_DEFAULT = 'block' as const;
export type ResolverFailureDefault = typeof RESOLVER_FAILURE_DEFAULT;
