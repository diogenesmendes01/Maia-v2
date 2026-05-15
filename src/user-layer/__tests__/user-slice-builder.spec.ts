import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildUserSlice } from '../user-slice-builder.js';
import * as memoryResolverModule from '../resolvers/memory-resolver.js';
import * as hintsResolverModule from '../resolvers/hints-resolver.js';
import * as interlocutorResolverModule from '../resolvers/interlocutor-resolver.js';

describe('user-slice-builder', () => {
  const mockInterlocutor = {
    pessoa_id: 'pessoa-1',
    nome: 'João Silva',
    apelido: 'João',
    tipo: 'pessoa',
    status: 'ativa' as const,
    preferencias: { language: 'pt-BR' },
    modelo_mental: { patience_level: 'high' },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(interlocutorResolverModule.interlocutorResolver, 'get').mockResolvedValue(
      mockInterlocutor
    );
  });

  it('depth=none: empty slice with interlocutor only', async () => {
    const mockMemoryResolver = vi.spyOn(memoryResolverModule.memoryResolver, 'list');
    const mockHintsResolver = vi.spyOn(hintsResolverModule.hintsResolver, 'list');

    mockMemoryResolver.mockResolvedValue([]);
    mockHintsResolver.mockResolvedValue([]);

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
    expect(mockMemoryResolver).not.toHaveBeenCalled();
    expect(mockHintsResolver).not.toHaveBeenCalled();
  });

  it('depth=minimal: max 5 memories, no hints', async () => {
    const mockMemories = Array.from({ length: 3 }, (_, i) => ({
      id: `mem-${i}`,
      conteudo: `memory ${i}`,
      memory_type: 'observation',
      scope: 'personal',
      sensitivity: 'low' as const,
      proactive_use: false,
      mention_allowed: true,
      confidence: 0.8,
      lifecycle_status: 'active' as const,
      created_at: new Date().toISOString(),
    }));

    vi.spyOn(memoryResolverModule.memoryResolver, 'list').mockResolvedValue(mockMemories);
    vi.spyOn(hintsResolverModule.hintsResolver, 'list').mockResolvedValue([]);

    const result = await buildUserSlice({
      tenant_id: 'tenant-1',
      pessoa_id: 'pessoa-1',
      depth: 'minimal',
      trace_id: 'trace-1',
    });

    expect(result.slice.depth).toBe('minimal');
    expect(result.slice.memories).toHaveLength(3);
    expect(result.slice.behavioral_hints).toHaveLength(0);
    expect(result.slice.meta.truncated).toBe(false);
  });

  it('depth=relevant: max 15 memories, up to 5 hints', async () => {
    const mockMemories = Array.from({ length: 12 }, (_, i) => ({
      id: `mem-${i}`,
      conteudo: `memory ${i}`,
      memory_type: 'preference',
      scope: 'personal',
      sensitivity: 'medium' as const,
      proactive_use: true,
      mention_allowed: true,
      confidence: 0.85,
      lifecycle_status: 'active' as const,
      created_at: new Date().toISOString(),
    }));

    const mockHints = Array.from({ length: 4 }, (_, i) => ({
      id: `hint-${i}`,
      hint: `hint ${i}`,
      scope: 'behavioral',
      confidence: 0.9,
      lifecycle_status: 'active' as const,
    }));

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
    expect(result.slice.meta.truncated).toBe(false);
  });

  it('depth=deep: max 50 memories, all hints', async () => {
    const mockMemories = Array.from({ length: 45 }, (_, i) => ({
      id: `mem-${i}`,
      conteudo: `memory ${i}`,
      memory_type: 'experience',
      scope: 'personal',
      sensitivity: 'high' as const,
      proactive_use: true,
      mention_allowed: true,
      confidence: 0.95,
      lifecycle_status: 'active' as const,
      created_at: new Date().toISOString(),
    }));

    const mockHints = Array.from({ length: 20 }, (_, i) => ({
      id: `hint-${i}`,
      hint: `hint ${i}`,
      scope: 'behavioral',
      confidence: 0.92,
      lifecycle_status: 'active' as const,
    }));

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

  it('detects truncation when memories exceed limit', async () => {
    const mockMemories = Array.from({ length: 16 }, (_, i) => ({
      id: `mem-${i}`,
      conteudo: `memory ${i}`,
      memory_type: 'observation',
      scope: 'personal',
      sensitivity: 'low' as const,
      proactive_use: false,
      mention_allowed: true,
      confidence: 0.8,
      lifecycle_status: 'active' as const,
      created_at: new Date().toISOString(),
    }));

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

  it('returns cache key with all parameters', async () => {
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

    expect(result.cache_key).toBeDefined();
    expect(result.cache_key).toMatch(/^user_slice:v1:/);
    expect(typeof result.latency_ms).toBe('number');
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('includes profile data in slice', async () => {
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

  it('respects max_items override', async () => {
    const mockMemoryResolver = vi.spyOn(memoryResolverModule.memoryResolver, 'list');
    mockMemoryResolver.mockResolvedValue([]);
    vi.spyOn(hintsResolverModule.hintsResolver, 'list').mockResolvedValue([]);

    await buildUserSlice({
      tenant_id: 'tenant-1',
      pessoa_id: 'pessoa-1',
      depth: 'relevant',
      max_items: 25,
      trace_id: 'trace-1',
    });

    expect(mockMemoryResolver).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 25 })
    );
  });
});
