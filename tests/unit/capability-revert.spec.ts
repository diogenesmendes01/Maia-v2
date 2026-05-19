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
 *
 * Round-2 review #99 finding 2:
 *  3. skill com delivery_artifact_ref — rollback falha → retorna revert_failed,
 *     NÃO cria gap (audit não pode mentir).
 *  4. skill SEM delivery_artifact_ref → retorna revert_failed (artifact obrigatório).
 *  5. skill com rollback OK → gap criado, retorna ok=true com technical_gap_id.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { createGapMock, rollbackMock } = vi.hoisted(() => ({
  createGapMock: vi.fn(),
  rollbackMock: vi.fn(),
}));

vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>(
    '@/db/repositories.js',
  );
  return {
    ...actual,
    capabilityGapsRepo: { create: createGapMock },
    skillsRepo: { rollback: rollbackMock },
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
  rollbackMock.mockReset();
});

describe('revertCapability — non-skill proposals', () => {
  it('cria novo technical gap com descrição prefixada [técnica] e tipo=technical', async () => {
    createGapMock.mockResolvedValueOnce({ id: 'gap-tech-1' });

    const result = await revertCapability({
      proposal: makeProposal({ title: 'Rastreador de Pedidos' }),
      reason: 'scenario "feliz" falhou: timeout 5s',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
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

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) throw new Error('expected ok');
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

describe('revertCapability — round-2 finding 2: skill revert atomicity', () => {
  it('[neg] skill com rollback que falha → retorna revert_failed; gap NÃO criado', async () => {
    // Simula falha do skillsRepo.rollback (ex: skill_not_found ou scope mismatch).
    rollbackMock.mockRejectedValueOnce(new Error('skill_not_found'));

    const result = await revertCapability({
      proposal: makeProposal({
        capability_type: 'skill',
        delivery_artifact_ref: 'skill-id-bad',
        title: 'Skill Ruim',
      }),
      reason: 'test falhou',
    });

    // Must return failure — not create a gap that lies about revert status.
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.revert_failed).toBe(true);
    expect(result.reason).toContain('skill_not_found');
    // Gap must NOT be created — audit must not say revert happened.
    expect(createGapMock).not.toHaveBeenCalled();
  });

  it('[neg] skill SEM delivery_artifact_ref → retorna revert_failed sem chamar rollback', async () => {
    const result = await revertCapability({
      proposal: makeProposal({
        capability_type: 'skill',
        delivery_artifact_ref: null, // missing!
        title: 'Skill Sem Ref',
      }),
      reason: 'fail reason',
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.revert_failed).toBe(true);
    expect(result.reason).toMatch(/delivery_artifact_ref|missing_artifact/);
    // Neither rollback nor gap creation should be attempted.
    expect(rollbackMock).not.toHaveBeenCalled();
    expect(createGapMock).not.toHaveBeenCalled();
  });

  it('[pos] skill com rollback OK → gap criado, triggered_revert pode ser true', async () => {
    rollbackMock.mockResolvedValueOnce({ id: 'skill-id-ok', status: 'rolled_back' });
    createGapMock.mockResolvedValueOnce({ id: 'gap-skill-tech-1' });

    const result = await revertCapability({
      proposal: makeProposal({
        capability_type: 'skill',
        delivery_artifact_ref: 'skill-id-ok',
        title: 'Skill OK',
      }),
      reason: 'scenario falhou',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.technical_gap_id).toBe('gap-skill-tech-1');
    expect(rollbackMock).toHaveBeenCalledTimes(1);
    expect(rollbackMock).toHaveBeenCalledWith('skill-id-ok', 'scenario falhou', 'capability-revert');
    expect(createGapMock).toHaveBeenCalledTimes(1);
  });
});
