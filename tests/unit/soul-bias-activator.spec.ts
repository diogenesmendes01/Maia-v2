/**
 * P8b — Tests for soul-bias-activator worker.
 *
 * Mocks soulBiasesRepo + logger. Validates: idempotent (no double-materialize);
 * activate failure surfaces typed reason; happy path emits info log.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SoulBiasProposalSpec } from '@/cognition/capability-proposer.js';

type Bias = {
  id: string;
  status: string;
  proposal_id: string | null;
  scope: string;
  scope_value: string;
  principle: string;
  guidance: string;
  origin: string;
  strength: string;
};

const biasState: Record<string, Bias> = {};
let proposeMock: ReturnType<typeof vi.fn> = vi.fn();
let activateMock: ReturnType<typeof vi.fn> = vi.fn();
let listProposedMock: ReturnType<typeof vi.fn> = vi.fn();
let findActiveForScopeMock: ReturnType<typeof vi.fn> = vi.fn();

vi.mock('@/control-plane/soul/soul-biases-repo.js', () => ({
  soulBiasesRepo: {
    get propose() {
      return proposeMock;
    },
    get activate() {
      return activateMock;
    },
    get listProposed() {
      return listProposedMock;
    },
    get findActiveForScope() {
      return findActiveForScopeMock;
    },
  },
}));

vi.mock('@/lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

function defaultSpec(): SoulBiasProposalSpec {
  return {
    scope: 'tenant',
    scope_value: '*',
    principle: 'test_principle',
    guidance: 'guidance with enough text',
    suggested_strength: 0.8,
    suggested_activation_context: {},
    suggested_origin: 'human_approved',
  };
}

beforeEach(() => {
  for (const k of Object.keys(biasState)) delete biasState[k];

  listProposedMock = vi.fn(async () => Object.values(biasState).filter((b) => b.status === 'proposed'));
  findActiveForScopeMock = vi.fn(async () => Object.values(biasState).filter((b) => b.status === 'active'));

  proposeMock = vi.fn(async (input: { proposal_id?: string; principle: string }) => {
    const id = `bias-${Math.random().toString(36).slice(2, 8)}`;
    const row: Bias = {
      id,
      status: 'proposed',
      proposal_id: input.proposal_id ?? null,
      scope: 'tenant',
      scope_value: '*',
      principle: input.principle,
      guidance: 'g',
      origin: 'human_approved',
      strength: '0.800',
    };
    biasState[id] = row;
    return row;
  });

  activateMock = vi.fn(async (args: { id: string }) => {
    const row = biasState[args.id];
    if (!row) return { ok: false as const, reason: 'bias_not_found' as const };
    biasState[args.id] = { ...row, status: 'active' };
    return { ok: true as const, bias: biasState[args.id]! };
  });

  vi.clearAllMocks();
});

describe('processSoulBiasProposalApproval (P8b worker)', () => {
  it('happy path: propõe + ativa a bias e retorna created_and_activated', async () => {
    const { processSoulBiasProposalApproval } = await import('@/workers/soul-bias-activator.js');
    const r = await processSoulBiasProposalApproval({
      proposal_id: 'prop-1',
      spec: defaultSpec(),
      decided_by: 'admin@maia',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.action).toBe('created_and_activated');
    expect(proposeMock).toHaveBeenCalledTimes(1);
    expect(activateMock).toHaveBeenCalledTimes(1);
  });

  it('idempotência: se bias com mesmo proposal_id já existe, retorna already_materialized', async () => {
    // seed bias com proposal_id='prop-1'
    biasState['existing'] = {
      id: 'existing',
      status: 'active',
      proposal_id: 'prop-1',
      scope: 'tenant',
      scope_value: '*',
      principle: 'p',
      guidance: 'g',
      origin: 'human_approved',
      strength: '0.800',
    };

    const { processSoulBiasProposalApproval } = await import('@/workers/soul-bias-activator.js');
    const r = await processSoulBiasProposalApproval({
      proposal_id: 'prop-1',
      spec: defaultSpec(),
      decided_by: 'admin@maia',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.action).toBe('already_materialized');
    expect(proposeMock).not.toHaveBeenCalled();
    expect(activateMock).not.toHaveBeenCalled();
  });

  it('falha de propose surfaceia typed reason', async () => {
    proposeMock = vi.fn(async () => {
      throw new Error('db_unique_violation');
    });
    const { processSoulBiasProposalApproval } = await import('@/workers/soul-bias-activator.js');
    const r = await processSoulBiasProposalApproval({
      proposal_id: 'prop-2',
      spec: defaultSpec(),
      decided_by: 'admin@maia',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/propose_failed/);
  });

  it('falha de activate surfaceia o reason do repo', async () => {
    activateMock = vi.fn(async () => ({ ok: false as const, reason: 'one_active_constraint_violation' as const }));
    const { processSoulBiasProposalApproval } = await import('@/workers/soul-bias-activator.js');
    const r = await processSoulBiasProposalApproval({
      proposal_id: 'prop-3',
      spec: defaultSpec(),
      decided_by: 'admin@maia',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('one_active_constraint_violation');
  });
});
