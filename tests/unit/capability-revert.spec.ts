/**
 * P5 Task 8 — capability-revert.
 *
 * Cria gap derivado (tipo='technical') quando uma proposal delivered falha no
 * loop fechado. Não escala automaticamente; o gap entra no backlog.
 *
 * Cenários:
 *  1. Cria novo technical gap com descrição prefixada `[técnica]` e tipo='technical'.
 *  2. Múltiplos reverts produzem gap_ids distintos (não deduplicam por
 *     descrição — repo.create faz insert direto, sem upsert).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { createGapMock } = vi.hoisted(() => ({
  createGapMock: vi.fn(),
}));

vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>(
    '@/db/repositories.js',
  );
  return {
    ...actual,
    capabilityGapsRepo: { create: createGapMock },
  };
});

import { revertCapability } from '@/agent/capability-revert.js';
import type { CapabilityProposal } from '@/db/schema.js';

function makeProposal(overrides: Partial<CapabilityProposal> = {}): CapabilityProposal {
  return {
    id: 'prop-1',
    tenant_id: 'default',
    agent_id: 'default',
    gap_id: 'gap-1',
    capability_type: 'tool',
    title: 'Rastreador de Pedidos',
    description: 'Tool para consultar status',
    proposed_spec: {},
    motivation: 'pergunta recorrente',
    expected_impact: 'resolve casos',
    test_scenarios: [],
    status: 'delivered',
    submitted_at: new Date(),
    decided_at: new Date(),
    decided_by: 'owner',
    decision_reason: null,
    delivered_at: new Date(),
    delivery_artifact_ref: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as CapabilityProposal;
}

beforeEach(() => {
  createGapMock.mockReset();
});

describe('revertCapability', () => {
  it('cria novo technical gap com descrição prefixada [técnica] e tipo=technical', async () => {
    createGapMock.mockResolvedValueOnce({ id: 'gap-tech-1' });

    const result = await revertCapability({
      proposal: makeProposal({ title: 'Rastreador de Pedidos' }),
      reason: 'scenario "feliz" falhou: timeout 5s',
    });

    expect(result.technical_gap_id).toBe('gap-tech-1');
    expect(createGapMock).toHaveBeenCalledTimes(1);
    const callArgs = createGapMock.mock.calls[0]?.[0] as {
      capability_description: string;
      tipo: string;
      contexto: string;
    };
    expect(callArgs.capability_description).toBe(
      '[técnica] Rastreador de Pedidos falhou pós-ativação',
    );
    expect(callArgs.tipo).toBe('technical');
    expect(callArgs.contexto).toBe('scenario "feliz" falhou: timeout 5s');
  });

  it('múltiplos reverts usam descrições distintas (proposals diferentes)', async () => {
    createGapMock
      .mockResolvedValueOnce({ id: 'gap-tech-a' })
      .mockResolvedValueOnce({ id: 'gap-tech-b' });

    const a = await revertCapability({
      proposal: makeProposal({ id: 'prop-A', title: 'Tool A' }),
      reason: 'A failed',
    });
    const b = await revertCapability({
      proposal: makeProposal({ id: 'prop-B', title: 'Tool B' }),
      reason: 'B failed',
    });

    expect(a.technical_gap_id).toBe('gap-tech-a');
    expect(b.technical_gap_id).toBe('gap-tech-b');
    expect(createGapMock).toHaveBeenCalledTimes(2);
    const args0 = createGapMock.mock.calls[0]?.[0] as { capability_description: string };
    const args1 = createGapMock.mock.calls[1]?.[0] as { capability_description: string };
    expect(args0.capability_description).toBe('[técnica] Tool A falhou pós-ativação');
    expect(args1.capability_description).toBe('[técnica] Tool B falhou pós-ativação');
    expect(args0.capability_description).not.toBe(args1.capability_description);
  });
});
