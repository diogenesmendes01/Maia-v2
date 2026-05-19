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
  /**
   * Authorized entity IDs for this conversation.  When non-empty, only facts
   * whose `entity_id` is null (tenant/global scope) or matches one of the
   * listed IDs will enter the slice.  An empty array means "no entity scope
   * restriction" (tenant-wide access), which applies when the actor has
   * full tenant-admin rights.  Included in the cache key so two different
   * entity sets never share a cached slice (security invariant).
   */
  authorized_entity_ids?: string[];
}

export interface FactRecord {
  key: string;
  value: unknown;
  scope: 'global' | 'tenant' | 'domain' | 'entity';
  /**
   * entity_id is set only when scope === 'entity'.  Null for global/tenant/domain facts.
   */
  entity_id?: string | null;
  confidence: number;
  source: string;
  lifecycle_status: string;
  /** sensitivity indicates whether the fact is mentionable in the prompt */
  sensitivity?: 'public' | 'internal' | 'sensitive' | 'restricted';
}

export interface RuleRecord {
  id: string;
  context: string;
  action: string;
  confidence: number;
  lifecycle_status: string;
  entity_id?: string | null;
}

export interface KnowledgeRepoPort {
  listFacts(
    tenant_id: string,
    opts: {
      depth: KnowledgeRequirements['depth'];
      limit: number;
      authorized_entity_ids?: string[];
    },
  ): Promise<FactRecord[]>;
  listRules(
    tenant_id: string,
    opts: {
      depth: KnowledgeRequirements['depth'];
      limit: number;
      authorized_entity_ids?: string[];
    },
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
    // Sort authorized_entity_ids so different orderings produce the same key.
    const sortedEntityIds = [...(req.authorized_entity_ids ?? [])].sort();
    const scope = hashShort({
      depth: req.depth,
      max_facts: req.max_facts ?? 10,
      max_rules: req.max_rules ?? 5,
      // Include scope set so a cache miss for entity A never serves entity B.
      authorized_entity_ids: sortedEntityIds,
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
    const authorizedEntityIds = input.requirements.authorized_entity_ids ?? [];
    throwIfAborted(input.signal);

    const [rawFacts, rawRules] = await Promise.all([
      // Fetch maxFacts+1 to detect truncation accurately AFTER lifecycle filter
      this.repo.listFacts(input.base.tenant_id, {
        depth: input.requirements.depth,
        limit: maxFacts * 2 + 1,
        authorized_entity_ids: authorizedEntityIds,
      }),
      this.repo.listRules(input.base.tenant_id, {
        depth: input.requirements.depth,
        limit: maxRules * 2 + 1,
        authorized_entity_ids: authorizedEntityIds,
      }),
    ]);

    // Lifecycle allowlist — drop proposed/pending_review/anything else.
    const lifecycleAllowedFacts = rawFacts.filter((f) => isAllowed(f.lifecycle_status));
    const lifecycleAllowedRules = rawRules.filter((r) => isAllowed(r.lifecycle_status));

    // Entity-scope filter: when authorized_entity_ids is non-empty, entity-
    // scoped facts/rules are only allowed when their entity_id is in the set.
    // Non-entity facts (global/tenant/domain, entity_id null/undefined) always
    // pass through — they are tenant-wide and scope-safe.
    const isEntityAuthorized = (entityId: string | null | undefined): boolean => {
      if (authorizedEntityIds.length === 0) return true; // no restriction
      if (entityId == null) return true; // global/tenant/domain scope
      return authorizedEntityIds.includes(entityId);
    };

    const safeFacts = lifecycleAllowedFacts.filter((f) =>
      f.scope !== 'entity' || isEntityAuthorized(f.entity_id),
    );
    const safeRules = lifecycleAllowedRules.filter((r) => isEntityAuthorized(r.entity_id));

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
