import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deriveBehavioralHint } from '@/cognition/behavioral-hint-deriver.js';
import { runWithTenantContext } from '@/db/tenant-context.js';

vi.mock('@/lib/claude.js', () => ({
  callLLM: vi.fn(),
}));

vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>('@/db/repositories.js');
  return {
    ...actual,
    cognitiveModuleLogRepo: { record: vi.fn(async () => {}), recentByModule: vi.fn(async () => []) },
  };
});

import { callLLM } from '@/lib/claude.js';

describe('deriveBehavioralHint', () => {
  beforeEach(() => vi.clearAllMocks());

  it('gera hint genérico sem mencionar conteúdo bruto', async () => {
    (callLLM as any).mockResolvedValueOnce({
      content: JSON.stringify({
        hint_text: 'usar tom mais paciente neste relacionamento',
        derived_sensitivity: 'medium',
      }),
    });
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const result = await deriveBehavioralHint('Cliente disse que filha dela está doente');
      expect(result?.hint_text).toBeDefined();
      expect(result?.hint_text.toLowerCase()).not.toContain('filha');
      expect(result?.hint_text.toLowerCase()).not.toContain('doente');
      expect(result?.hint_text.toLowerCase()).not.toContain('doença');
      expect(result?.derived_sensitivity).toBe('medium');
    });
  });

  it('retorna null quando LLM output inválido', async () => {
    (callLLM as any).mockResolvedValueOnce({ content: 'invalid json' });
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const result = await deriveBehavioralHint('algum conteúdo');
      expect(result).toBeNull();
    });
  });
});
