/**
 * P5 Task 8 — capability-test-runner.
 *
 * Roda todos os test_scenarios de uma proposal delivered, registra outcome em
 * capability_test_results, e dispara revertCapability se algum scenario falha.
 *
 * Cenários cobertos:
 *  1. Proposal delivered, 2 scenarios, ambos passam echo_test → outcome='pass'.
 *  2. Proposal delivered, 2 scenarios, 1 falha → outcome='fail',
 *     triggered_revert=true, technical_gap_id populado.
 *  3. Proposal status='approved' (não delivered) → outcome='error', skip.
 *  4. Proposal não encontrada → throw 'proposal_not_found'.
 *  5. Empty scenarios → outcome='error', details.error='no_scenarios'.
 *  6. Strategy joga em um scenario → scenario individual marcado failed,
 *     próximo scenario processado normalmente, outcome='fail'.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getByIdMock, recordMock, createGapMock } = vi.hoisted(() => ({
  getByIdMock: vi.fn(),
  recordMock: vi.fn(),
  createGapMock: vi.fn(),
}));

vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>(
    '@/db/repositories.js',
  );
  return {
    ...actual,
    capabilityProposalsRepo: { getById: getByIdMock },
    capabilityTestResultsRepo: { record: recordMock },
    capabilityGapsRepo: { create: createGapMock },
  };
});

import {
  runCapabilityTests,
  TEST_STRATEGIES,
  type TestScenario,
} from '@/cognition/capability-test-runner.js';
import type { CapabilityProposal } from '@/db/schema.js';

function makeProposal(overrides: Partial<CapabilityProposal> = {}): CapabilityProposal {
  return {
    id: 'prop-1',
    tenant_id: 'default',
    agent_id: 'default',
    gap_id: 'gap-1',
    capability_type: 'tool',
    title: 'Rastreador',
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

const PASSING_SCENARIO: TestScenario = {
  name: 'feliz',
  given: 'sistema online',
  when: 'consulta retorna status disponivel',
  then: 'status disponivel',
};

const FAILING_SCENARIO: TestScenario = {
  name: 'triste',
  given: 'sistema online',
  when: 'algo completamente diferente',
  then: 'resultado-X',
};

beforeEach(() => {
  getByIdMock.mockReset();
  recordMock.mockReset();
  createGapMock.mockReset();
});

describe('runCapabilityTests', () => {
  it('proposal delivered, 2 scenarios passam → outcome=pass, sem revert', async () => {
    getByIdMock.mockResolvedValueOnce(
      makeProposal({
        test_scenarios: [PASSING_SCENARIO, PASSING_SCENARIO],
      }),
    );
    recordMock.mockResolvedValueOnce({ id: 'res-1' });

    const r = await runCapabilityTests({ proposal_id: 'prop-1' });

    expect(r.outcome).toBe('pass');
    expect(r.result_id).toBe('res-1');
    expect(createGapMock).not.toHaveBeenCalled();
    expect(recordMock).toHaveBeenCalledTimes(1);
    const recArgs = recordMock.mock.calls[0]?.[0] as {
      outcome: string;
      scenarios_passed: number;
      scenarios_failed: number;
      triggered_revert: boolean;
      technical_gap_id?: string;
    };
    expect(recArgs.outcome).toBe('pass');
    expect(recArgs.scenarios_passed).toBe(2);
    expect(recArgs.scenarios_failed).toBe(0);
    expect(recArgs.triggered_revert).toBe(false);
    expect(recArgs.technical_gap_id).toBeUndefined();
  });

  it('proposal delivered, 1 scenario falha → outcome=fail, triggered_revert=true, technical_gap_id populado', async () => {
    getByIdMock.mockResolvedValueOnce(
      makeProposal({
        test_scenarios: [PASSING_SCENARIO, FAILING_SCENARIO],
      }),
    );
    createGapMock.mockResolvedValueOnce({ id: 'gap-tech-99' });
    recordMock.mockResolvedValueOnce({ id: 'res-2' });

    const r = await runCapabilityTests({ proposal_id: 'prop-1' });

    expect(r.outcome).toBe('fail');
    expect(r.result_id).toBe('res-2');
    expect(createGapMock).toHaveBeenCalledTimes(1);
    const gapArgs = createGapMock.mock.calls[0]?.[0] as {
      capability_description: string;
      tipo: string;
      contexto: string;
    };
    expect(gapArgs.tipo).toBe('technical');
    expect(gapArgs.capability_description).toContain('[técnica]');
    expect(gapArgs.capability_description).toContain('Rastreador');
    expect(gapArgs.contexto).toContain('Rastreador');

    expect(recordMock).toHaveBeenCalledTimes(1);
    const recArgs = recordMock.mock.calls[0]?.[0] as {
      outcome: string;
      scenarios_passed: number;
      scenarios_failed: number;
      triggered_revert: boolean;
      technical_gap_id: string;
    };
    expect(recArgs.outcome).toBe('fail');
    expect(recArgs.scenarios_passed).toBe(1);
    expect(recArgs.scenarios_failed).toBe(1);
    expect(recArgs.triggered_revert).toBe(true);
    expect(recArgs.technical_gap_id).toBe('gap-tech-99');
  });

  it('proposal status=approved (não delivered) → outcome=error, skip warning, não grava', async () => {
    getByIdMock.mockResolvedValueOnce(
      makeProposal({
        status: 'approved',
        test_scenarios: [PASSING_SCENARIO],
      }),
    );

    const r = await runCapabilityTests({ proposal_id: 'prop-approved' });

    expect(r.outcome).toBe('error');
    expect(r.result_id).toBe('');
    expect(recordMock).not.toHaveBeenCalled();
    expect(createGapMock).not.toHaveBeenCalled();
  });

  it('proposal não encontrada → throw proposal_not_found', async () => {
    getByIdMock.mockResolvedValueOnce(null);

    await expect(
      runCapabilityTests({ proposal_id: 'missing' }),
    ).rejects.toThrow('proposal_not_found');

    expect(recordMock).not.toHaveBeenCalled();
    expect(createGapMock).not.toHaveBeenCalled();
  });

  it('empty scenarios → outcome=error, details.error=no_scenarios', async () => {
    getByIdMock.mockResolvedValueOnce(
      makeProposal({
        test_scenarios: [],
      }),
    );
    recordMock.mockResolvedValueOnce({ id: 'res-empty' });

    const r = await runCapabilityTests({ proposal_id: 'prop-empty' });

    expect(r.outcome).toBe('error');
    expect(r.result_id).toBe('res-empty');
    expect(recordMock).toHaveBeenCalledTimes(1);
    const recArgs = recordMock.mock.calls[0]?.[0] as {
      outcome: string;
      details: { error: string };
    };
    expect(recArgs.outcome).toBe('error');
    expect(recArgs.details.error).toBe('no_scenarios');
    expect(createGapMock).not.toHaveBeenCalled();
  });

  it('strategy joga em 1 scenario → scenario individual marcado failed, próximo segue, outcome=fail', async () => {
    // Use uma strategy custom que joga no primeiro scenario e passa no segundo.
    const originalStrategy = TEST_STRATEGIES.echo_test;
    let callCount = 0;
    TEST_STRATEGIES.echo_test = vi.fn(async (_s: TestScenario) => {
      callCount += 1;
      if (callCount === 1) throw new Error('strategy_boom');
      return { passed: true, observed: 'ok' };
    });

    try {
      getByIdMock.mockResolvedValueOnce(
        makeProposal({
          test_scenarios: [PASSING_SCENARIO, PASSING_SCENARIO],
        }),
      );
      createGapMock.mockResolvedValueOnce({ id: 'gap-tech-throw' });
      recordMock.mockResolvedValueOnce({ id: 'res-throw' });

      const r = await runCapabilityTests({ proposal_id: 'prop-throw' });

      expect(r.outcome).toBe('fail');
      expect(callCount).toBe(2); // segundo scenario processado
      expect(recordMock).toHaveBeenCalledTimes(1);
      const recArgs = recordMock.mock.calls[0]?.[0] as {
        outcome: string;
        scenarios_passed: number;
        scenarios_failed: number;
        scenarios_run: Array<{ passed: boolean; observed: string; reason?: string }>;
        triggered_revert: boolean;
      };
      expect(recArgs.outcome).toBe('fail');
      expect(recArgs.scenarios_failed).toBe(1);
      expect(recArgs.scenarios_passed).toBe(1);
      expect(recArgs.triggered_revert).toBe(true);
      expect(recArgs.scenarios_run[0]?.observed).toBe('strategy_threw');
      expect(recArgs.scenarios_run[0]?.reason).toBe('strategy_boom');
      expect(recArgs.scenarios_run[1]?.passed).toBe(true);
    } finally {
      TEST_STRATEGIES.echo_test = originalStrategy;
    }
  });
});
