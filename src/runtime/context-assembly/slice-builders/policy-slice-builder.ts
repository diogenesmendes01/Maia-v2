/**
 * P8a — PolicySliceBuilder (consumes P8e PolicyDescriptorResolver stub).
 *
 * Reads `policy_rules` filtered by scope (channel/domain). Always preserves
 * `rule_kind='hard_limit'` rules regardless of any budget fallback — they are
 * non-negotiable per master §3.8.
 *
 * Spec §3.7 / Plan Task 9.
 *
 * TODO(P8e): replace stub resolver binding with real PolicyDescriptorResolver.
 */
import { createHash } from 'node:crypto';
import type {
  BaseContextPacket,
  PolicyRuleKind,
  PolicySlice,
} from '../../context-packet/types.js';
import { sliceCacheKey, type SliceCache } from '../../context-packet/cache/slice-cache.js';
import { getTTLForSlice } from '../../context-packet/cache/ttl-policy.js';
import type {
  SliceBuilder,
  SliceBuilderInput,
  SliceBuilderResult,
} from './_types.js';

export interface PolicyRequirements {
  depth: 'basic' | 'domain' | 'risk';
  max_rules?: number;
}

export interface PolicyRuleRecord {
  policy_id: string;
  version: number;
  rule_descriptor: string;
  rule_kind: PolicyRuleKind;
  applies_to_peps: Array<'early' | 'mid' | 'late'>;
  rule_body_ref: string;
}

/**
 * Resolver port — P8e provides the real impl. P8a uses the stub which returns
 * `unresolved: []` and `resolved: []`. The builder degrades gracefully.
 */
export interface PolicyDescriptorResolverPort {
  resolveDescriptors(
    tenant_id: string,
    channel_kind: string,
    depth: PolicyRequirements['depth'],
  ): Promise<{ resolved: PolicyRuleRecord[]; unresolved: string[] }>;
}

/**
 * Stub resolver returning empty. Real impl in P8e.
 * TODO(P8e): replace when P8e lands.
 */
export const stubPolicyDescriptorResolver: PolicyDescriptorResolverPort = {
  async resolveDescriptors() {
    return { resolved: [], unresolved: [] };
  },
};

export class PolicySliceBuilder
  implements SliceBuilder<PolicyRequirements, PolicySlice>
{
  readonly name = 'policy' as const;

  constructor(
    private readonly resolver: PolicyDescriptorResolverPort,
    private readonly cache: SliceCache,
  ) {}

  cacheKey(base: BaseContextPacket, req: PolicyRequirements): string {
    const scope = hashShort({
      channel_kind: base.channel.kind,
      depth: req.depth,
      max_rules: req.max_rules ?? 20,
    });
    return sliceCacheKey(base.tenant_id, 'policy', scope);
  }

  async build(
    input: SliceBuilderInput<PolicyRequirements>,
  ): Promise<SliceBuilderResult<PolicySlice>> {
    const start = performance.now();
    throwIfAborted(input.signal);
    const key = this.cacheKey(input.base, input.requirements);

    const cached = await this.cache.get<PolicySlice>(key);
    if (cached) {
      return {
        slice: cached,
        cache_hit: true,
        duration_ms: performance.now() - start,
      };
    }

    throwIfAborted(input.signal);
    const { resolved } = await this.resolver.resolveDescriptors(
      input.base.tenant_id,
      input.base.channel.kind,
      input.requirements.depth,
    );

    const max = input.requirements.max_rules ?? 20;

    // hard_limit rules MUST always be preserved. Soft rules + others get
    // budget-capped after hard_limits are accounted for.
    const hardLimits = resolved.filter((r) => r.rule_kind === 'hard_limit');
    const others = resolved.filter((r) => r.rule_kind !== 'hard_limit');
    const remaining = Math.max(0, max - hardLimits.length);
    const truncated = others.length > remaining;
    const finalRules = [...hardLimits, ...others.slice(0, remaining)];

    const slice: PolicySlice = {
      applicable_rules: finalRules.map((r) => ({
        policy_id: r.policy_id,
        version: r.version,
        rule_descriptor: r.rule_descriptor,
        rule_kind: r.rule_kind,
        applies_to_peps: r.applies_to_peps,
        rule_body_ref: r.rule_body_ref,
      })),
      resolver_cache_key: key,
      truncated,
    };

    await this.cache.set(key, slice, getTTLForSlice('policy'));
    return {
      slice,
      cache_hit: false,
      duration_ms: performance.now() - start,
    };
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}

function hashShort(obj: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify(obj))
    .digest('hex')
    .substring(0, 12);
}
