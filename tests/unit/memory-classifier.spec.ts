import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classifyMemory } from '@/cognition/memory-classifier.js';
import { runWithTenantContext } from '@/db/tenant-context.js';

vi.mock('@/lib/claude.js', () => ({
  callLLM: vi.fn(),
}));

vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>('@/db/repositories.js');
  return {
    ...actual,
    cognitiveModuleLogRepo: {
      record: vi.fn(async () => {}),
      recentByModule: vi.fn(async () => []),
    },
  };
});

import { callLLM } from '@/lib/claude.js';

describe('classifyMemory', () => {
  beforeEach(() => vi.clearAllMocks());

  it('CNPJ → operational', async () => {
    (callLLM as any).mockResolvedValueOnce({
      content: JSON.stringify({ memory_type: 'operational', scope_type: 'agent', sensitivity: 'low' }),
    });
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const result = await classifyMemory('CNPJ da empresa X: 12.345.678/0001-99');
      expect(result?.memory_type).toBe('operational');
      expect(result?.proactive_use).toBe(true);
      expect(result?.mention_allowed).toBe(true);
    });
  });

  it('"prefere matutino" → preference + scope=interlocutor', async () => {
    (callLLM as any).mockResolvedValueOnce({
      content: JSON.stringify({ memory_type: 'preference', scope_type: 'interlocutor', sensitivity: 'low' }),
    });
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const result = await classifyMemory('Marina prefere atendimento matutino');
      expect(result?.memory_type).toBe('preference');
      expect(result?.scope_type).toBe('interlocutor');
    });
  });

  it('"comentou divórcio" → personal com mention_allowed=false', async () => {
    (callLLM as any).mockResolvedValueOnce({
      content: JSON.stringify({ memory_type: 'personal', scope_type: 'role', sensitivity: 'medium' }),
    });
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const result = await classifyMemory('Cliente comentou que está em processo de divórcio');
      expect(result?.memory_type).toBe('personal');
      expect(result?.mention_allowed).toBe(false);
      expect(result?.proactive_use).toBe(false);
    });
  });

  it('"filha doente" → sensitive com mention_allowed=false e ttl baixo', async () => {
    (callLLM as any).mockResolvedValueOnce({
      content: JSON.stringify({ memory_type: 'sensitive', scope_type: 'conversation', sensitivity: 'high' }),
    });
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const result = await classifyMemory('Cliente disse que filha dela está doente');
      expect(result?.memory_type).toBe('sensitive');
      expect(result?.mention_allowed).toBe(false);
      expect(result?.proactive_use).toBe(false);
      expect(result?.ttl_days).toBeLessThanOrEqual(7);
    });
  });

  it('conservadora: classifier retorna null/erro → defaults pra personal+restricted', async () => {
    (callLLM as any).mockResolvedValueOnce({ content: 'invalid json' });
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const result = await classifyMemory('algo ambíguo');
      // Conservative fallback: returns personal + restricted (or null indicating caller should default)
      expect(result?.memory_type === 'personal' || result === null).toBe(true);
      if (result) {
        expect(result.mention_allowed).toBe(false);
      }
    });
  });
});
