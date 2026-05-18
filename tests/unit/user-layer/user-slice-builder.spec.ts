import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildUserSlice } from '@/user-layer/user-slice-builder.js';
import * as memoryResolverModule from '@/user-layer/resolvers/memory-resolver.js';
import * as hintsResolverModule from '@/user-layer/resolvers/hints-resolver.js';
import * as interlocutorResolverModule from '@/user-layer/resolvers/interlocutor-resolver.js';
import type { MemoryItem } from '@/user-layer/resolvers/memory-resolver.js';
import type { HintItem } from '@/user-layer/resolvers/hints-resolver.js';

// PR #94 round-2: enforceTenantBoundary now fails closed (throws when no ALS
// context). These unit tests focus on slice composition logic, not boundary
// enforcement. The boundary is mocked to return a stable decision so tests
// can run without runWithTenantContext.
vi.mock('@/user-layer/internal/tenant-boundary.js', () => ({
  enforceTenantBoundary: vi.fn(({ tenant_id }: { tenant_id: string; agent_id?: string }) => ({
    tenant_id,
    agent_id: 'agent-test',
  })),
  TenantBoundaryViolation: class TenantBoundaryViolation extends Error {},
}));

const mockInterlocutor = {
  pessoa_id: 'pessoa-1',
  nome: 'João Silva',
  apelido: 'João',
  tipo: 'pessoa',
  status: 'ativa' as const,
  preferencias: { language: 'pt-BR' },
  modelo_mental: { patience_level: 'high' },
};

function makeMemory(i: number, overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: `mem-${i}`,
    conteudo: `memory ${i}`,
    memory_type: 'observation',
    scope: 'personal',
    sensitivity: 'low',
    proactive_use: false,
    mention_allowed: true,
    ttl_days: null,
    expires_at: null,
    needs_review: false,
    confidence: 0.8,
    lifecycle_status: 'active',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeHint(i: number, overrides: Partial<HintItem> = {}): HintItem {
  return {
    id: `hint-${i}`,
    hint: `hint ${i}`,
    scope: 'behavioral',
    confidence: 0.9,
    lifecycle_status: 'active',
    ...overrides,
  };
}

describe('user-slice-builder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(interlocutorResolverModule.interlocutorResolver, 'get').mockResolvedValue(
      mockInterlocutor,
    );
  });

  it('depth=none: empty slice with interlocutor only (no DB calls for memories/hints)', async () => {
    const memorySpy = vi.spyOn(memoryResolverModule.memoryResolver, 'list');
    const hintsSpy = vi.spyOn(hintsResolverModule.hintsResolver, 'list');
    memorySpy.mockResolvedValue([]);
    hintsSpy.mockResolvedValue([]);

    const result = await buildUserSlice({
      tenant_id: 'tenant-1',
      pessoa_id: 'pessoa-1',
      depth: 'none',
      trace_id: 'trace-1',
    });

    expect(result.slice.depth).toBe('none');
    expect(result.slice.interlocutor.pessoa_id).toBe('pessoa-1');
    expect(result.slice.interlocutor.nome_preferido).toBe('João Silva');
    expect(result.slice.memories).toEqual([]);
    expect(result.slice.behavioral_hints).toEqual([]);
    expect(memorySpy).not.toHaveBeenCalled();
    expect(hintsSpy).not.toHaveBeenCalled();
  });

  it('depth=minimal: loads memories (≤5), no hints', async () => {
    const mockMemories = Array.from({ length: 3 }, (_, i) => makeMemory(i));
    vi.spyOn(memoryResolverModule.memoryResolver, 'list').mockResolvedValue(mockMemories);
    const hintsSpy = vi.spyOn(hintsResolverModule.hintsResolver, 'list').mockResolvedValue([]);

    const result = await buildUserSlice({
      tenant_id: 'tenant-1',
      pessoa_id: 'pessoa-1',
      depth: 'minimal',
      trace_id: 'trace-1',
    });

    expect(result.slice.depth).toBe('minimal');
    expect(result.slice.memories).toHaveLength(3);
    expect(result.slice.behavioral_hints).toEqual([]);
    expect(hintsSpy).not.toHaveBeenCalled();
  });

  it('depth=relevant: loads memories + hints (≤5)', async () => {
    const mockMemories = Array.from({ length: 12 }, (_, i) => makeMemory(i));
    const mockHints = Array.from({ length: 4 }, (_, i) => makeHint(i));
    vi.spyOn(memoryResolverModule.memoryResolver, 'list').mockResolvedValue(mockMemories);
    vi.spyOn(hintsResolverModule.hintsResolver, 'list').mockResolvedValue(mockHints);

    const result = await buildUserSlice({
      tenant_id: 'tenant-1',
      pessoa_id: 'pessoa-1',
      depth: 'relevant',
      trace_id: 'trace-1',
    });

    expect(result.slice.depth).toBe('relevant');
    expect(result.slice.memories).toHaveLength(12);
    expect(result.slice.behavioral_hints).toHaveLength(4);
  });

  it('depth=deep: loads memories + all hints', async () => {
    const mockMemories = Array.from({ length: 45 }, (_, i) => makeMemory(i));
    const mockHints = Array.from({ length: 20 }, (_, i) => makeHint(i));
    vi.spyOn(memoryResolverModule.memoryResolver, 'list').mockResolvedValue(mockMemories);
    vi.spyOn(hintsResolverModule.hintsResolver, 'list').mockResolvedValue(mockHints);

    const result = await buildUserSlice({
      tenant_id: 'tenant-1',
      pessoa_id: 'pessoa-1',
      depth: 'deep',
      trace_id: 'trace-1',
    });

    expect(result.slice.depth).toBe('deep');
    expect(result.slice.memories).toHaveLength(45);
    expect(result.slice.behavioral_hints).toHaveLength(20);
  });

  it('detects truncation when memories returned >= limit', async () => {
    const mockMemories = Array.from({ length: 15 }, (_, i) => makeMemory(i));
    vi.spyOn(memoryResolverModule.memoryResolver, 'list').mockResolvedValue(mockMemories);
    vi.spyOn(hintsResolverModule.hintsResolver, 'list').mockResolvedValue([]);

    const result = await buildUserSlice({
      tenant_id: 'tenant-1',
      pessoa_id: 'pessoa-1',
      depth: 'relevant',
      trace_id: 'trace-1',
    });

    expect(result.slice.meta.truncated).toBe(true);
  });

  it('returns cache key with v1 prefix and latency_ms', async () => {
    vi.spyOn(memoryResolverModule.memoryResolver, 'list').mockResolvedValue([]);
    vi.spyOn(hintsResolverModule.hintsResolver, 'list').mockResolvedValue([]);

    const result = await buildUserSlice({
      tenant_id: 'tenant-1',
      pessoa_id: 'pessoa-1',
      depth: 'relevant',
      intent_label: 'support-request',
      scope_hint: ['personal'],
      trace_id: 'trace-1',
    });

    expect(result.cache_key).toMatch(/^user_slice:v1:/);
    expect(typeof result.latency_ms).toBe('number');
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('includes profile (preferencias + modelo_mental) in slice', async () => {
    vi.spyOn(memoryResolverModule.memoryResolver, 'list').mockResolvedValue([]);
    vi.spyOn(hintsResolverModule.hintsResolver, 'list').mockResolvedValue([]);

    const result = await buildUserSlice({
      tenant_id: 'tenant-1',
      pessoa_id: 'pessoa-1',
      depth: 'minimal',
      trace_id: 'trace-1',
    });

    expect(result.slice.profile).toBeDefined();
    expect(result.slice.profile.preferencias).toEqual({ language: 'pt-BR' });
    expect(result.slice.profile.modelo_mental).toEqual({ patience_level: 'high' });
  });

  it('respects max_items override in resolver call', async () => {
    const memorySpy = vi.spyOn(memoryResolverModule.memoryResolver, 'list').mockResolvedValue([]);
    vi.spyOn(hintsResolverModule.hintsResolver, 'list').mockResolvedValue([]);

    await buildUserSlice({
      tenant_id: 'tenant-1',
      pessoa_id: 'pessoa-1',
      depth: 'relevant',
      max_items: 25,
      trace_id: 'trace-1',
    });

    expect(memorySpy).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 25, tenant_id: 'tenant-1' }),
    );
  });

  it('forwards tenant_id to resolvers (cross-tenant isolation)', async () => {
    const memorySpy = vi
      .spyOn(memoryResolverModule.memoryResolver, 'list')
      .mockResolvedValue([]);
    const hintsSpy = vi
      .spyOn(hintsResolverModule.hintsResolver, 'list')
      .mockResolvedValue([]);

    await buildUserSlice({
      tenant_id: 'tenant-isolated',
      pessoa_id: 'pessoa-1',
      depth: 'relevant',
      trace_id: 'trace-1',
    });

    expect(memorySpy).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: 'tenant-isolated' }),
    );
    expect(hintsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: 'tenant-isolated' }),
    );
  });
});
