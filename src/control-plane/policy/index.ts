/**
 * P8e — Control Plane policy module: barrel export.
 *
 * Architecture Lock: import from `@/control-plane/policy` only from Control
 * Plane callers (slice builders, PEPs). NOT importable from `src/agent/`
 * or `src/cognition/` — see master spec §0.1 Architecture Locks.
 */
export type {
  PolicyRule,
  PolicyRuleKind,
  PolicyRuleStatus,
  PolicySourceOfTruth,
  PolicyRuleScope,
  PolicyRuleBody,
  PolicyDescriptorResolverInput,
  PolicyDescriptorResolverOutput,
  ResolvedPolicy,
  PolicyLifecycleEvent,
  PolicyLifecycleEventName,
} from './types.js';
export {
  PolicyRuleKind as PolicyRuleKindValues,
  PolicyRuleStatus as PolicyRuleStatusValues,
  PolicySourceOfTruth as PolicySourceOfTruthValues,
} from './types.js';
export {
  policyRulesRepo,
  POLICY_LIFECYCLE_CHANNEL,
  type PolicyRulesRepo,
} from './policy-rules-repo.js';
export {
  policyResolverCache,
  PolicyResolverCacheImpl,
  cacheKeyHash,
  startPolicyCacheInvalidationSubscriber,
  type PolicyResolverCache,
  type CacheKey,
  type CacheValue,
  type PolicyCacheConfig,
} from './policy-cache.js';
export {
  policyDescriptorResolver,
  PolicyDescriptorResolverImpl,
  createPolicyDescriptorResolver,
  matchesScope,
  type PolicyDescriptorResolver,
} from './policy-descriptor-resolver.js';
