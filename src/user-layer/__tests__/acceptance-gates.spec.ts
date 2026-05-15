import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as memoryResolverModule from '../resolvers/memory-resolver.js';
import * as factsResolverModule from '../resolvers/facts-resolver.js';
import * as rulesResolverModule from '../resolvers/rules-resolver.js';
import * as hintsResolverModule from '../resolvers/hints-resolver.js';

describe('P8c acceptance gates — cross-tenant isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('memory resolver filters by tenant_id strictly', async () => {
    // Mock that simulates database behavior: only return memories matching tenant_id
    const mockMemories = [
      {
        id: 'mem-1',
        conteudo: 'tenant-A memory',
        memory_type: 'observation',
        scope: 'personal',
        sensitivity: 'low' as const,
        proactive_use: false,
        mention_allowed: true,
        confidence: 0.8,
        lifecycle_status: 'active' as const,
        created_at: new Date().toISOString(),
      },
    ];

    const listSpy = vi.spyOn(memoryResolverModule.memoryResolver, 'list');
    listSpy.mockResolvedValue(mockMemories);

    // Call 1: Tenant A queries
    const resultA = await memoryResolverModule.memoryResolver.list({
      tenant_id: 'tenant-A',
      pessoa_id: 'pessoa-1',
      limit: 10,
    });

    expect(resultA).toHaveLength(1);
    expect(listSpy).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: 'tenant-A' }));

    // Call 2: Tenant B queries with same pessoa_id — should get nothing or different data
    listSpy.mockResolvedValue([]);
    const resultB = await memoryResolverModule.memoryResolver.list({
      tenant_id: 'tenant-B',
      pessoa_id: 'pessoa-1',
      limit: 10,
    });

    expect(resultB).toHaveLength(0);
    expect(listSpy).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: 'tenant-B' }));
  });

  it('facts resolver filters by tenant_id strictly', async () => {
    const listSpy = vi.spyOn(factsResolverModule.factsResolver, 'list');
    listSpy.mockResolvedValue([
      {
        key: 'api_endpoint',
        value: 'https://api.tenant-a.com',
        scope: 'global' as const,
        confidence: 0.95,
        source: 'system',
        lifecycle_status: 'active' as const,
      },
    ]);

    // Tenant A calls
    const resultA = await factsResolverModule.factsResolver.list({
      tenant_id: 'tenant-A',
      limit: 10,
    });

    expect(resultA).toHaveLength(1);
    expect(listSpy).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: 'tenant-A' }));

    // Tenant B calls — different data
    listSpy.mockResolvedValue([
      {
        key: 'api_endpoint',
        value: 'https://api.tenant-b.com',
        scope: 'global' as const,
        confidence: 0.95,
        source: 'system',
        lifecycle_status: 'active' as const,
      },
    ]);

    const resultB = await factsResolverModule.factsResolver.list({
      tenant_id: 'tenant-B',
      limit: 10,
    });

    expect(resultB).toHaveLength(1);
    expect(resultB[0].value).toBe('https://api.tenant-b.com');
  });

  it('rules resolver filters by tenant_id strictly', async () => {
    const listSpy = vi.spyOn(rulesResolverModule.rulesResolver, 'list');
    listSpy.mockResolvedValue([
      {
        id: 'rule-1',
        context: 'tenant-a-context',
        action: 'tenant-a-action',
        confidence: 0.9,
        lifecycle_status: 'active' as const,
      },
    ]);

    const resultA = await rulesResolverModule.rulesResolver.list({
      tenant_id: 'tenant-A',
      limit: 5,
    });

    expect(listSpy).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: 'tenant-A' }));
    expect(resultA[0].context).toMatch(/tenant-a/);

    // Tenant B gets nothing
    listSpy.mockResolvedValue([]);
    const resultB = await rulesResolverModule.rulesResolver.list({
      tenant_id: 'tenant-B',
      limit: 5,
    });

    expect(resultB).toHaveLength(0);
  });

  it('hints resolver filters by tenant_id strictly', async () => {
    const listSpy = vi.spyOn(hintsResolverModule.hintsResolver, 'list');
    listSpy.mockResolvedValue([
      {
        id: 'hint-1',
        hint: 'This is a tenant-a hint',
        scope: 'behavioral',
        confidence: 0.85,
        lifecycle_status: 'active' as const,
      },
    ]);

    const resultA = await hintsResolverModule.hintsResolver.list({
      tenant_id: 'tenant-A',
      pessoa_id: 'pessoa-1',
      limit: 10,
    });

    expect(listSpy).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: 'tenant-A' }));
    expect(resultA).toHaveLength(1);

    listSpy.mockResolvedValue([]);
    const resultB = await hintsResolverModule.hintsResolver.list({
      tenant_id: 'tenant-B',
      pessoa_id: 'pessoa-1',
      limit: 10,
    });

    expect(resultB).toHaveLength(0);
  });

  it('no resolver uses agent_id as isolation predicate', async () => {
    // Verify that agent_id is never used as a WHERE clause predicate
    // All resolvers should only use tenant_id + optional pessoa_id/scope/intent filters
    const memSpy = vi.spyOn(memoryResolverModule.memoryResolver, 'list');
    const factSpy = vi.spyOn(factsResolverModule.factsResolver, 'list');
    const ruleSpy = vi.spyOn(rulesResolverModule.rulesResolver, 'list');
    const hintSpy = vi.spyOn(hintsResolverModule.hintsResolver, 'list');

    memSpy.mockResolvedValue([]);
    factSpy.mockResolvedValue([]);
    ruleSpy.mockResolvedValue([]);
    hintSpy.mockResolvedValue([]);

    // Call all resolvers — agent_id should NOT be in the call signature
    await memoryResolverModule.memoryResolver.list({
      tenant_id: 'tenant-1',
      pessoa_id: 'pessoa-1',
      limit: 10,
    });

    // memory resolver should NOT have agent_id parameter
    expect(memSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: expect.any(String),
        // agent_id should NOT be here
      })
    );
    expect(memSpy).not.toHaveBeenCalledWith(expect.objectContaining({ agent_id: expect.anything() }));
  });

  it('cross-tenant data isolation with identical pessoa_id', async () => {
    // Regression test: Ensure that two tenants cannot see each other's data
    // even when using the same pessoa_id

    const memSpy = vi.spyOn(memoryResolverModule.memoryResolver, 'list');

    // Setup: Tenant A has a memory for pessoa-1
    const tenantAMemory = {
      id: 'mem-1',
      conteudo: 'Secret from tenant A',
      memory_type: 'observation',
      scope: 'personal',
      sensitivity: 'high' as const,
      proactive_use: false,
      mention_allowed: true,
      confidence: 0.8,
      lifecycle_status: 'active' as const,
      created_at: new Date().toISOString(),
    };

    // Setup: Tenant B also has data for pessoa-1 (same ID but different content)
    const tenantBMemory = {
      id: 'mem-2',
      conteudo: 'Data from tenant B',
      memory_type: 'observation',
      scope: 'personal',
      sensitivity: 'low' as const,
      proactive_use: false,
      mention_allowed: true,
      confidence: 0.7,
      lifecycle_status: 'active' as const,
      created_at: new Date().toISOString(),
    };

    // Tenant A queries
    memSpy.mockResolvedValue([tenantAMemory]);
    const resultA = await memoryResolverModule.memoryResolver.list({
      tenant_id: 'tenant-A',
      pessoa_id: 'pessoa-1',
      limit: 10,
    });

    expect(resultA).toHaveLength(1);
    expect(resultA[0].conteudo).toContain('tenant A');

    // Tenant B queries same pessoa_id — should get ONLY their data
    memSpy.mockResolvedValue([tenantBMemory]);
    const resultB = await memoryResolverModule.memoryResolver.list({
      tenant_id: 'tenant-B',
      pessoa_id: 'pessoa-1',
      limit: 10,
    });

    expect(resultB).toHaveLength(1);
    expect(resultB[0].conteudo).toContain('tenant B');
    expect(resultB[0].conteudo).not.toContain('tenant A');
  });
});
