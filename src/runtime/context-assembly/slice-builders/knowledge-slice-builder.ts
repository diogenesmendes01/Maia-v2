/**
 * P8a — KnowledgeSliceBuilder.
 *
 * Reads `agent_facts` + `learned_rules` and exposes only lifecycle statuses
 * in the allowlist set (master §15 invariant 9):
 *   ephemeral | observed | reinforced | verified | active
 *
 * NEVER exposes:
 *   proposed | pending_review (or anything else not in the allowlist).
 *
 * Spec §3.5 / Plan Task 7.
 */
import { createHash } from 'node:crypto';
import type {
  BaseContextPacket,
  KnowledgeLifecycleStatus,
  KnowledgeSlice,
} from '../../context-packet/types.js';
import { sliceCacheKey, type SliceCache } from '../../context-packet/cache/slice-cache.js';
import { getTTLForSlice } from '../../context-packet/cache/ttl-policy.js';
import type {
  SliceBuilder,
  SliceBuilderInput,
  SliceBuilderResult,
} from './_types.js';

export interface KnowledgeRequirements {
  depth: 'none' | 'relevant' | 'deep';
  max_facts?: number;
  max_rules?: number;
  max_tokens_hint?: number;
}

export interface FactRecord {
  key: string;
  value: unknown;
  scope: 'global' | 'tenant' | 'domain' | 'entity';
  confidence: number;
  source: string;
  lifecycle_status: string;
}

export interface RuleRecord {
  id: string;
  context: string;
  action: string;
  confidence: number;
  lifecycle_status: string;
}

export interface KnowledgeRepoPort {
  listFacts(
    tenant_id: string,
    opts: { depth: KnowledgeRequirements['depth']; limit: number },
  ): Promise<FactRecord[]>;
  listRules(
    tenant_id: string,
    opts: { depth: KnowledgeRequirements['depth']; limit: number },
  ): Promise<RuleRecord[]>;
}

// Allowlist guard — anything outside is suppressed.
const ALLOWED_LIFECYCLE: ReadonlySet<KnowledgeLifecycleStatus> = new Set([
  'ephemeral',
  'observed',
  'reinforced',
  'verified',
  'active',
]);

function isAllowed(status: string): status is KnowledgeLifecycleStatus {
  return (ALLOWED_LIFECYCLE as Set<string>).has(status);
}

export class KnowledgeSliceBuilder
  implements SliceBuilder<KnowledgeRequirements, KnowledgeSlice>
{
  readonly name = 'knowledge' as const;

  constructor(
    private readonly repo: KnowledgeRepoPort,
    private readonly cache: SliceCache,
  ) {}

  cacheKey(base: BaseContextPacket, req: KnowledgeRequirements): string {
    const scope = hashShort({
      depth: req.depth,
      max_facts: req.max_facts ?? 10,
      max_rules: req.max_rules ?? 5,
    });
    return sliceCacheKey(base.tenant_id, 'knowledge', scope);
  }

  async build(
    input: SliceBuilderInput<KnowledgeRequirements>,
  ): Promise<SliceBuilderResult<KnowledgeSlice>> {
    const start = performance.now();
    throwIfAborted(input.signal);

    if (input.requirements.depth === 'none') {
      return {
        slice: { facts: [], rules: [], truncated: { facts: false, rules: false } },
        cache_hit: false,
        duration_ms: performance.now() - start,
      };
    }

    const key = this.cacheKey(input.base, input.requirements);
    const cached = await this.cache.get<KnowledgeSlice>(key);
    if (cached) {
      return {
        slice: cached,
        cache_hit: true,
        duration_ms: performance.now() - start,
      };
    }

    const maxFacts = input.requirements.max_facts ?? 10;
    const maxRules = input.requirements.max_rules ?? 5;
    throwIfAborted(input.signal);

    const [rawFacts, rawRules] = await Promise.all([
      // Fetch maxFacts+1 to detect truncation accurately AFTER lifecycle filter
      this.repo.listFacts(input.base.tenant_id, {
        depth: input.requirements.depth,
        limit: maxFacts * 2 + 1,
      }),
      this.repo.listRules(input.base.tenant_id, {
        depth: input.requirements.depth,
        limit: maxRules * 2 + 1,
      }),
    ]);

    // Lifecycle allowlist — drop proposed/pending_review/anything else.
    const safeFacts = rawFacts.filter((f) => isAllowed(f.lifecycle_status));
    const safeRules = rawRules.filter((r) => isAllowed(r.lifecycle_status));

    const factsTruncated = safeFacts.length > maxFacts;
    const rulesTruncated = safeRules.length > maxRules;
    const facts = factsTruncated ? safeFacts.slice(0, maxFacts) : safeFacts;
    const rules = rulesTruncated ? safeRules.slice(0, maxRules) : safeRules;

    const slice: KnowledgeSlice = {
      facts: facts.map((f) => ({
        key: f.key,
        value: f.value,
        scope: f.scope,
        confidence: f.confidence,
        source: f.source,
        lifecycle_status: f.lifecycle_status as KnowledgeLifecycleStatus,
      })),
      rules: rules.map((r) => ({
        id: r.id,
        context: r.context,
        action: r.action,
        confidence: r.confidence,
        lifecycle_status: r.lifecycle_status as KnowledgeLifecycleStatus,
      })),
      truncated: { facts: factsTruncated, rules: rulesTruncated },
    };

    await this.cache.set(key, slice, getTTLForSlice('knowledge'));
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
