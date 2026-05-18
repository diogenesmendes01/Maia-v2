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
import { logger } from '@/lib/logger.js';
import { getCurrentTenant } from '@/db/tenant-context.js';
import type {
  PolicyDescriptorResolverInput,
  PolicyDescriptorResolverOutput,
  PolicyRule,
  PolicyRuleScope,
  ResolvedPolicy,
  UnresolvedDescriptor,
} from './types.js';
import { RESOLVER_FAILURE_DEFAULT } from './types.js';

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
    const failures: UnresolvedDescriptor[] = [];

    const agent_id = input.agent_id ?? null;
    const scope = input.scope ?? {};

    // Tenant context cross-check (Codex #93 finding): if the caller's
    // declared tenant_id disagrees with the active AsyncLocalStorage tenant
    // context, refuse the whole batch as a programming error. The repo
    // would otherwise silently use the active context and a leaked
    // resolver call could query the wrong tenant. We surface it as
    // typed failures so callers fail closed (block) per
    // RESOLVER_FAILURE_DEFAULT.
    let activeTenant: string | undefined;
    try {
      activeTenant = getCurrentTenant();
    } catch {
      activeTenant = undefined;
    }
    if (activeTenant && activeTenant !== input.tenant_id) {
      logger.warn(
        {
          declared_tenant: input.tenant_id,
          active_tenant: activeTenant,
          descriptors: input.descriptors,
          failure_default: RESOLVER_FAILURE_DEFAULT,
        },
        'policy_resolver.tenant_mismatch',
      );
      for (const descriptor of input.descriptors) {
        unresolved.push(descriptor);
        failures.push({ descriptor, reason: 'tenant_mismatch' });
      }
      return { resolved, unresolved, failures };
    }

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
        failures.push({ descriptor, reason: 'not_found' });
        continue;
      }
      if (cached) {
        resolved.push(cached);
        continue;
      }

      // 2) repo lookup (agent_id-specific then tenant-wide via repo)
      let row: PolicyRule | null;
      try {
        row = await this.repo.findActiveByDescriptor({
          descriptor,
          agent_id: input.agent_id ?? null,
        });
      } catch (err) {
        // Fail-closed contract (Codex review #93): a repo error is NOT a
        // miss. Surface a typed `db_error` reason so callers can BLOCK
        // (RESOLVER_FAILURE_DEFAULT='block'). We do NOT cache this — a
        // transient outage shouldn't pin "no policy" for ttl_ms.
        logger.error(
          {
            err: (err as Error).message,
            tenant_id: input.tenant_id,
            agent_id: input.agent_id ?? null,
            descriptor,
            failure_default: RESOLVER_FAILURE_DEFAULT,
          },
          'policy_resolver.db_error_fail_closed',
        );
        unresolved.push(descriptor);
        failures.push({ descriptor, reason: 'db_error' });
        continue;
      }

      if (!row) {
        this.cache.setUnresolved(key);
        unresolved.push(descriptor);
        failures.push({ descriptor, reason: 'not_found' });
        continue;
      }

      // 3) scope filter
      if (!matchesScope(row.scope, input.scope)) {
        this.cache.setUnresolved(key);
        unresolved.push(descriptor);
        failures.push({ descriptor, reason: 'scope_mismatch' });
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

    return { resolved, unresolved, failures };
  }
}

/**
 * Helper for PEP / slice-builder callers (Codex review #93): returns true
 * iff the resolver output contains at least one descriptor that the caller
 * MUST block on. `db_error` and `tenant_mismatch` are always blocking;
 * `not_found` and `scope_mismatch` are NOT (caller decides based on the
 * descriptor's role).
 *
 * Pin the failure default at the call site: never inline `'block'` — read
 * RESOLVER_FAILURE_DEFAULT. That way changing the invariant requires
 * touching one constant + sweeping tests, never grepping for strings.
 */
export function hasBlockingFailure(output: PolicyDescriptorResolverOutput): boolean {
  return output.failures.some(
    (f) => f.reason === 'db_error' || f.reason === 'tenant_mismatch',
  );
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
