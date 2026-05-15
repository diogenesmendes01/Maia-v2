/**
 * P8e — PolicyDescriptorResolver: single canonical path
 * `string descriptor → active (policy_id, version)` for the 6 hot-path
 * call sites (master §0.3, §2.2):
 *   1. policy-slice-builder.ts (P8d)
 *   2. SkillRunner (resolve skill.policy_descriptors at runtime)
 *   3. Early PEP
 *   4. Mid PEP
 *   5. Late PEP
 *   6. Trace writer
 *
 * Architecture Lock: resolver lives in src/control-plane/policy/. NOT
 * importable from src/agent/ or src/cognition/ (callers go through
 * slice builders or PEPs). Enforced by lint rule + code review.
 *
 * Behavior:
 *   - Cache hit: returns immediately (positive or 'unresolved').
 *   - Cache miss: repo.findActiveByDescriptor (agent-specific override),
 *     scope filter, cache write, return.
 *   - Invariant: resolved.length + unresolved.length === input.descriptors.length
 *
 * NO DSL evaluation here. rule_body stays opaque; P9d will read it.
 */
import type { PolicyRulesRepo } from './policy-rules-repo.js';
import { policyRulesRepo } from './policy-rules-repo.js';
import { policyResolverCache } from './policy-cache.js';
import type { PolicyResolverCache, CacheKey } from './policy-cache.js';
import type {
  PolicyDescriptorResolverInput,
  PolicyDescriptorResolverOutput,
  PolicyRule,
  PolicyRuleScope,
  ResolvedPolicy,
} from './types.js';

export interface PolicyDescriptorResolver {
  resolveDescriptors(
    input: PolicyDescriptorResolverInput,
  ): Promise<PolicyDescriptorResolverOutput>;
}

/**
 * Match-by-omission semantics:
 *   - rule.scope empty {}: matches any input.scope (universal).
 *   - rule.scope set: every set key in rule.scope must equal the same key
 *     in input.scope. Missing keys in input.scope -> no match.
 */
export function matchesScope(
  ruleScope: PolicyRuleScope,
  inputScope?: PolicyRuleScope,
): boolean {
  const ruleKeys = Object.entries(ruleScope).filter(
    ([, v]) => v !== undefined && v !== null && v !== '',
  );
  if (ruleKeys.length === 0) return true;
  if (!inputScope) return false;
  for (const [k, v] of ruleKeys) {
    if (inputScope[k] !== v) return false;
  }
  return true;
}

export class PolicyDescriptorResolverImpl implements PolicyDescriptorResolver {
  constructor(
    private readonly repo: PolicyRulesRepo,
    private readonly cache: PolicyResolverCache,
  ) {}

  async resolveDescriptors(
    input: PolicyDescriptorResolverInput,
  ): Promise<PolicyDescriptorResolverOutput> {
    const resolved: ResolvedPolicy[] = [];
    const unresolved: string[] = [];

    const agent_id = input.agent_id ?? null;
    const scope = input.scope ?? {};

    for (const descriptor of input.descriptors) {
      const key: CacheKey = {
        tenant_id: input.tenant_id,
        agent_id,
        descriptor,
        scope,
      };

      // 1) cache lookup
      const cached = this.cache.get(key);
      if (cached === 'unresolved') {
        unresolved.push(descriptor);
        continue;
      }
      if (cached) {
        resolved.push(cached);
        continue;
      }

      // 2) repo lookup (agent_id-specific then tenant-wide via repo)
      let row: PolicyRule | null = null;
      try {
        row = await this.repo.findActiveByDescriptor({
          descriptor,
          agent_id: input.agent_id ?? null,
        });
      } catch (err) {
        // Defense in depth: a repo error should NOT crash the entire batch.
        // Treat as unresolved; caller's audit log captures the gap.
        void err;
        unresolved.push(descriptor);
        continue;
      }

      if (!row) {
        this.cache.setUnresolved(key);
        unresolved.push(descriptor);
        continue;
      }

      // 3) scope filter
      if (!matchesScope(row.scope, input.scope)) {
        this.cache.setUnresolved(key);
        unresolved.push(descriptor);
        continue;
      }

      const r: ResolvedPolicy = {
        descriptor,
        policy_id: row.id,
        version: row.version,
        rule_kind: row.rule_kind,
      };
      this.cache.set(key, r);
      resolved.push(r);
    }

    return { resolved, unresolved };
  }
}

/**
 * Singleton: hot-path resolver wired to the singleton repo + cache.
 */
export const policyDescriptorResolver: PolicyDescriptorResolver =
  new PolicyDescriptorResolverImpl(policyRulesRepo, policyResolverCache);

/**
 * Factory for tests: pass mocks of the repo / cache.
 */
export function createPolicyDescriptorResolver(
  repo: PolicyRulesRepo,
  cache: PolicyResolverCache,
): PolicyDescriptorResolver {
  return new PolicyDescriptorResolverImpl(repo, cache);
}
