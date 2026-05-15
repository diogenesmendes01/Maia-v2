import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildKnowledgeSlice } from '@/user-layer/knowledge-slice-builder.js';
import * as factsResolverModule from '@/user-layer/resolvers/facts-resolver.js';
import * as rulesResolverModule from '@/user-layer/resolvers/rules-resolver.js';
import type { FactItem } from '@/user-layer/resolvers/facts-resolver.js';
import type { RuleItem } from '@/user-layer/resolvers/rules-resolver.js';

function makeFact(i: number, overrides: Partial<FactItem> = {}): FactItem {
  return {
    id: `fact-${i}`,
    key: `key-${i}`,
    value: `value-${i}`,
    scope: 'tenant',
    confidence: 0.9,
    source: 'aprendido',
    ultima_validacao: null,
    lifecycle_status: 'active',
    ...overrides,
  };
}

function makeRule(i: number, overrides: Partial<RuleItem> = {}): RuleItem {
  return {
    id: `rule-${i}`,
    context: `context-${i}`,
    action: `action-${i}`,
    confidence: 0.85,
    acertos: 5,
    erros: 0,
    ativa: true,
    lifecycle_status: 'active',
    ...overrides,
  };
}

describe('knowledge-slice-builder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('depth=none: empty slice, no resolver calls', async () => {
    const factsSpy = vi.spyOn(factsResolverModule.factsResolver, 'list');
    const rulesSpy = vi.spyOn(rulesResolverModule.rulesResolver, 'list');
    factsSpy.mockResolvedValue([]);
    rulesSpy.mockResolvedValue([]);

    const result = await buildKnowledgeSlice({
      tenant_id: 'tenant-1',
      depth: 'none',
      trace_id: 'trace-1',
    });

    expect(result.slice.depth).toBe('none');
    expect(result.slice.facts).toEqual([]);
    expect(result.slice.rules).toEqual([]);
    expect(factsSpy).not.toHaveBeenCalled();
    expect(rulesSpy).not.toHaveBeenCalled();
  });

  it('depth=relevant: ≤10 facts + ≤5 rules', async () => {
    const facts = Array.from({ length: 8 }, (_, i) => makeFact(i));
    const rules = Array.from({ length: 3 }, (_, i) => makeRule(i));
    vi.spyOn(factsResolverModule.factsResolver, 'list').mockResolvedValue(facts);
    vi.spyOn(rulesResolverModule.rulesResolver, 'list').mockResolvedValue(rules);

    const result = await buildKnowledgeSlice({
      tenant_id: 'tenant-1',
      depth: 'relevant',
      trace_id: 'trace-1',
    });

    expect(result.slice.depth).toBe('relevant');
    expect(result.slice.facts).toHaveLength(8);
    expect(result.slice.rules).toHaveLength(3);
  });

  it('depth=deep: up to 50 facts and 30 rules', async () => {
    const facts = Array.from({ length: 45 }, (_, i) => makeFact(i));
    const rules = Array.from({ length: 25 }, (_, i) => makeRule(i));
    vi.spyOn(factsResolverModule.factsResolver, 'list').mockResolvedValue(facts);
    vi.spyOn(rulesResolverModule.rulesResolver, 'list').mockResolvedValue(rules);

    const result = await buildKnowledgeSlice({
      tenant_id: 'tenant-1',
      depth: 'deep',
      trace_id: 'trace-1',
    });

    expect(result.slice.facts).toHaveLength(45);
    expect(result.slice.rules).toHaveLength(25);
  });

  it('detects truncation when facts >= limit', async () => {
    const facts = Array.from({ length: 10 }, (_, i) => makeFact(i));
    vi.spyOn(factsResolverModule.factsResolver, 'list').mockResolvedValue(facts);
    vi.spyOn(rulesResolverModule.rulesResolver, 'list').mockResolvedValue([]);

    const result = await buildKnowledgeSlice({
      tenant_id: 'tenant-1',
      depth: 'relevant',
      trace_id: 'trace-1',
    });

    expect(result.slice.meta.truncated).toBe(true);
  });

  it('returns cache key + latency', async () => {
    vi.spyOn(factsResolverModule.factsResolver, 'list').mockResolvedValue([]);
    vi.spyOn(rulesResolverModule.rulesResolver, 'list').mockResolvedValue([]);

    const result = await buildKnowledgeSlice({
      tenant_id: 'tenant-1',
      depth: 'relevant',
      domain: 'billing',
      trace_id: 'trace-1',
    });

    expect(result.cache_key).toMatch(/^knowledge_slice:v1:/);
    expect(typeof result.latency_ms).toBe('number');
  });

  it('forwards tenant_id to resolvers (cross-tenant isolation)', async () => {
    const factsSpy = vi.spyOn(factsResolverModule.factsResolver, 'list').mockResolvedValue([]);
    const rulesSpy = vi.spyOn(rulesResolverModule.rulesResolver, 'list').mockResolvedValue([]);

    await buildKnowledgeSlice({
      tenant_id: 'tenant-isolated',
      depth: 'relevant',
      trace_id: 'trace-1',
    });

    expect(factsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: 'tenant-isolated' }),
    );
    expect(rulesSpy).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: 'tenant-isolated' }),
    );
  });

  it('respects max_facts override', async () => {
    const factsSpy = vi.spyOn(factsResolverModule.factsResolver, 'list').mockResolvedValue([]);
    vi.spyOn(rulesResolverModule.rulesResolver, 'list').mockResolvedValue([]);

    await buildKnowledgeSlice({
      tenant_id: 'tenant-1',
      depth: 'relevant',
      max_facts: 25,
      trace_id: 'trace-1',
    });

    expect(factsSpy).toHaveBeenCalledWith(expect.objectContaining({ limit: 25 }));
  });

  it('respects max_rules override', async () => {
    vi.spyOn(factsResolverModule.factsResolver, 'list').mockResolvedValue([]);
    const rulesSpy = vi.spyOn(rulesResolverModule.rulesResolver, 'list').mockResolvedValue([]);

    await buildKnowledgeSlice({
      tenant_id: 'tenant-1',
      depth: 'relevant',
      max_rules: 12,
      trace_id: 'trace-1',
    });

    expect(rulesSpy).toHaveBeenCalledWith(expect.objectContaining({ limit: 12 }));
  });
});
