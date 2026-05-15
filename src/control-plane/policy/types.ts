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

/** Master §2.2 — Resolver output. Invariant: resolved.length + unresolved.length === input.descriptors.length. */
export interface PolicyDescriptorResolverOutput {
  resolved: ResolvedPolicy[];
  unresolved: string[];
}
