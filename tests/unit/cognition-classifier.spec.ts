import { describe, it, expect, vi } from 'vitest';
import { classify } from '@/cognition/classifier.js';
import { runWithTenantContext } from '@/db/tenant-context.js';

vi.mock('@/lib/claude.js', () => ({
  callLLM: vi.fn(async ({ messages }) => {
    const user = messages[0].content as string;
    if (user.includes('FATO_X')) return { content: JSON.stringify({ type: 'fato', content: 'X', scope: 'agent' }) };
    if (user.includes('REGRA_X')) return { content: JSON.stringify({ type: 'regra', contexto: 'X', acao: 'Y', tipo: 'classificacao', confianca: 0.7 }) };
    if (user.includes('LACUNA_X')) return { content: JSON.stringify({ type: 'lacuna', capability_description: 'X', tipo: 'tool', contexto: 'Y' }) };
    if (user.includes('DESCARTE_X')) return { content: JSON.stringify({ type: 'descarte', reason: 'irrelevant' }) };
    return { content: JSON.stringify({ type: 'descarte', reason: 'fallback' }) };
  }),
}));

describe('classify', () => {
  it('classifica como fato', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const r = await classify('FATO_X: cliente prefere matutino');
      expect(r?.type).toBe('fato');
    });
  });

  it('classifica como regra', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const r = await classify('REGRA_X: se ver X, faça Y');
      expect(r?.type).toBe('regra');
    });
  });

  it('classifica como lacuna', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const r = await classify('LACUNA_X: faltou tool');
      expect(r?.type).toBe('lacuna');
    });
  });

  it('classifica como descarte', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const r = await classify('DESCARTE_X: ruído');
      expect(r?.type).toBe('descarte');
    });
  });
});
