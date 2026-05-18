import { performance } from 'perf_hooks';
import { factsResolver } from './resolvers/facts-resolver.js';
import { rulesResolver } from './resolvers/rules-resolver.js';
import { getKnowledgeMaxes } from './internal/depth-mapping.js';
import { buildKnowledgeSliceCacheKey } from './internal/cache-keys.js';
import { enforceTenantBoundary } from './internal/tenant-boundary.js';
import type { KnowledgeSlice, KnowledgeDepth } from './types.js';

export interface BuildKnowledgeSliceOutput {
  slice: KnowledgeSlice;
  latency_ms: number;
  cache_key: string;
}

export async function buildKnowledgeSlice(input: {
  tenant_id: string;
  depth: KnowledgeDepth;
  max_facts?: number;
  max_rules?: number;
  scope_hint?: Array<'global' | 'tenant' | 'domain' | 'entity'>;
  domain?: string;
  entidade_ids?: string[];
  intent_label?: string;
  /** Optional cross-check against AsyncLocalStorage agent_id; see tenant-boundary.ts */
  agent_id?: string;
  trace_id: string;
}): Promise<BuildKnowledgeSliceOutput> {
  // PR #94 Codex review high #3: enforce tenant trust boundary AT THE FACADE
  // before any resolver is touched. Throws TenantBoundaryViolation if the
  // caller passes a tenant_id that doesn't match the AsyncLocalStorage ctx.
  enforceTenantBoundary({ tenant_id: input.tenant_id, agent_id: input.agent_id });

  const start = performance.now();
  const maxes = getKnowledgeMaxes(input.depth, {
    facts: input.max_facts,
    rules: input.max_rules,
  });
  const cache_key = buildKnowledgeSliceCacheKey({
    tenant_id: input.tenant_id,
    depth: input.depth,
    scope_hint: input.scope_hint,
    domain: input.domain,
    intent_label: input.intent_label,
  });

  try {
    let facts: any[] = [];
    let rules: any[] = [];

    if (input.depth !== 'none') {
      facts = await factsResolver.list({
        tenant_id: input.tenant_id,
        scope: input.scope_hint,
        limit: maxes.facts,
      });

      rules = await rulesResolver.list({
        tenant_id: input.tenant_id,
        intent_filter: input.intent_label,
        // PR #94 Codex review high #4: mirror rulesRepo.listActive('classificacao')
        // used by the prompt path. Inactive rules MUST NOT enter KnowledgeSlice;
        // the prompt-builder filter exists specifically because disabled rules
        // often represent superseded / bad behavior.
        tipo: 'classificacao',
        only_active: true,
        limit: maxes.rules,
      });
    }

    const slice: KnowledgeSlice = {
      depth: input.depth,
      facts,
      rules,
      meta: {
        cache_hit: false, // P8b will set this
        truncated: facts.length >= maxes.facts || rules.length >= maxes.rules,
        facts_total: facts.length,
        rules_total: rules.length,
      },
    };

    return {
      slice,
      latency_ms: performance.now() - start,
      cache_key,
    };
  } catch (error) {
    throw new Error(`Failed to build KnowledgeSlice: ${error}`, { cause: error });
  }
}
