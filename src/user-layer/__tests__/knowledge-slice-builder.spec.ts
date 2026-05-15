import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildKnowledgeSlice } from '../knowledge-slice-builder.js';
import * as factsResolverModule from '../resolvers/facts-resolver.js';
import * as rulesResolverModule from '../resolvers/rules-resolver.js';

describe('knowledge-slice-builder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('depth=none: empty slice', async () => {
    const mockFactsResolver = vi.spyOn(factsResolverModule.factsResolver, 'list').mockResolvedValue([]);
    const mockRulesResolver = vi.spyOn(rulesResolverModule.rulesResolver, 'list').mockResolvedValue([]);

    const result = await buildKnowledgeSlice({
      tenant_id: 'tenant-1',
      depth: 'none',
      trace_id: 'trace-1',
    });

    expect(result.slice.depth).toBe('none');
    expect(result.slice.facts).toEqual([]);
    expect(result.slice.rules).toEqual([]);
    expect(result.slice.meta.truncated).toBe(false);
    expect(mockFactsResolver).not.toHaveBeenCalled();
    expect(mockRulesResolver).not.toHaveBeenCalled();
  });

  it('depth=relevant: max 10 facts, max 5 rules', async () => {
    const mockFacts = Array.from({ length: 8 }, (_, i) => ({
      key: `fact-${i}`,
      value: `value-${i}`,
      scope: 'tenant' as const,
      confidence: 0.9,
      source: 'test',
      lifecycle_status: 'active' as const,
    }));

    const mockRules = Array.from({ length: 4 }, (_, i) => ({
      id: `rule-${i}`,
      context: `context-${i}`,
      action: `action-${i}`,
      confidence: 0.85,
      lifecycle_status: 'active' as const,
    }));

    vi.spyOn(factsResolverModule.factsResolver, 'list').mockResolvedValue(mockFacts);
    vi.spyOn(rulesResolverModule.rulesResolver, 'list').mockResolvedValue(mockRules);

    const result = await buildKnowledgeSlice({
      tenant_id: 'tenant-1',
      depth: 'relevant',
      trace_id: 'trace-1',
    });

    expect(result.slice.depth).toBe('relevant');
    expect(result.slice.facts).toHaveLength(8);
    expect(result.slice.rules).toHaveLength(4);
    expect(result.slice.meta.truncated).toBe(false);
    expect(result.slice.meta.facts_total).toBe(8);
    expect(result.slice.meta.rules_total).toBe(4);
  });

  it('depth=deep: max 50 facts, max 30 rules', async () => {
    const mockFacts = Array.from({ length: 45 }, (_, i) => ({
      key: `fact-${i}`,
      value: `value-${i}`,
      scope: 'tenant' as const,
      confidence: 0.9,
      source: 'test',
      lifecycle_status: 'active' as const,
    }));

    const mockRules = Array.from({ length: 25 }, (_, i) => ({
      id: `rule-${i}`,
      context: `context-${i}`,
      action: `action-${i}`,
      confidence: 0.85,
      lifecycle_status: 'active' as const,
    }));

    vi.spyOn(factsResolverModule.factsResolver, 'list').mockResolvedValue(mockFacts);
    vi.spyOn(rulesResolverModule.rulesResolver, 'list').mockResolvedValue(mockRules);

    const result = await buildKnowledgeSlice({
      tenant_id: 'tenant-1',
      depth: 'deep',
      trace_id: 'trace-1',
    });

    expect(result.slice.depth).toBe('deep');
    expect(result.slice.facts).toHaveLength(45);
    expect(result.slice.rules).toHaveLength(25);
    expect(result.slice.meta.truncated).toBe(false);
  });

  it('detects truncation when facts exceed limit', async () => {
    const mockFacts = Array.from({ length: 11 }, (_, i) => ({
      key: `fact-${i}`,
      value: `value-${i}`,
      scope: 'tenant' as const,
      confidence: 0.9,
      source: 'test',
      lifecycle_status: 'active' as const,
    }));

    vi.spyOn(factsResolverModule.factsResolver, 'list').mockResolvedValue(mockFacts);
    vi.spyOn(rulesResolverModule.rulesResolver, 'list').mockResolvedValue([]);

    const result = await buildKnowledgeSlice({
      tenant_id: 'tenant-1',
      depth: 'relevant',
      trace_id: 'trace-1',
    });

    expect(result.slice.meta.truncated).toBe(true);
  });

  it('detects truncation when rules exceed limit', async () => {
    vi.spyOn(factsResolverModule.factsResolver, 'list').mockResolvedValue([]);
    vi.spyOn(rulesResolverModule.rulesResolver, 'list').mockResolvedValue(
      Array.from({ length: 6 }, (_, i) => ({
        id: `rule-${i}`,
        context: `context-${i}`,
        action: `action-${i}`,
        confidence: 0.85,
        lifecycle_status: 'active' as const,
      }))
    );

    const result = await buildKnowledgeSlice({
      tenant_id: 'tenant-1',
      depth: 'relevant',
      trace_id: 'trace-1',
    });

    expect(result.slice.meta.truncated).toBe(true);
  });

  it('returns cache key', async () => {
    vi.spyOn(factsResolverModule.factsResolver, 'list').mockResolvedValue([]);
    vi.spyOn(rulesResolverModule.rulesResolver, 'list').mockResolvedValue([]);

    const result = await buildKnowledgeSlice({
      tenant_id: 'tenant-1',
      depth: 'relevant',
      intent_label: 'test-intent',
      trace_id: 'trace-1',
    });

    expect(result.cache_key).toBeDefined();
    expect(result.cache_key).toMatch(/^knowledge_slice:v1:/);
    expect(typeof result.latency_ms).toBe('number');
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('respects scope_hint filtering', async () => {
    const mockFactsResolver = vi.spyOn(factsResolverModule.factsResolver, 'list');
    const mockRulesResolver = vi.spyOn(rulesResolverModule.rulesResolver, 'list');

    mockFactsResolver.mockResolvedValue([]);
    mockRulesResolver.mockResolvedValue([]);

    await buildKnowledgeSlice({
      tenant_id: 'tenant-1',
      depth: 'relevant',
      scope_hint: ['tenant', 'domain'],
      trace_id: 'trace-1',
    });

    expect(mockFactsResolver).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: 'tenant-1',
        scope: ['tenant', 'domain'],
        limit: 10,
      })
    );
  });

  it('passes custom max_facts and max_rules overrides', async () => {
    const mockFactsResolver = vi.spyOn(factsResolverModule.factsResolver, 'list');
    const mockRulesResolver = vi.spyOn(rulesResolverModule.rulesResolver, 'list');

    mockFactsResolver.mockResolvedValue([]);
    mockRulesResolver.mockResolvedValue([]);

    await buildKnowledgeSlice({
      tenant_id: 'tenant-1',
      depth: 'relevant',
      max_facts: 20,
      max_rules: 10,
      trace_id: 'trace-1',
    });

    expect(mockFactsResolver).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 20 })
    );
    expect(mockRulesResolver).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 10 })
    );
  });
});
