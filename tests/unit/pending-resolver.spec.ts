import { describe, it, expect, vi, beforeEach } from 'vitest';

const findActiveForUpdate = vi.fn();
const resolveTx = vi.fn();
vi.mock('../../src/db/repositories.js', () => ({
  pendingQuestionsRepo: { findActiveForUpdate, resolveTx },
}));

const withTx = vi.fn(async (fn) => fn({} as never));
vi.mock('../../src/db/client.js', () => ({ withTx, db: {} as never }));

const dispatchTool = vi.fn();
vi.mock('../../src/tools/_dispatcher.js', () => ({ dispatchTool }));

const resolveScope = vi.fn().mockResolvedValue({ entidades: [], byEntity: new Map() });
vi.mock('../../src/governance/permissions.js', () => ({ resolveScope }));

const audit = vi.fn();
vi.mock('../../src/governance/audit.js', () => ({ audit }));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const pessoa = { id: 'p1' } as never;
const conversa = { id: 'c1' } as never;

beforeEach(() => {
  findActiveForUpdate.mockReset();
  resolveTx.mockReset();
  dispatchTool.mockReset();
  audit.mockReset();
  resolveScope.mockResolvedValue({ entidades: [], byEntity: new Map() });
});

describe('resolveAndDispatch', () => {
  it('resolves, audits source, and dispatches the action', async () => {
    findActiveForUpdate.mockResolvedValueOnce({
      id: 'pq-1',
      acao_proposta: { tool: 'register_transaction', args: { valor: 50 } },
    });
    resolveTx.mockResolvedValueOnce(undefined);
    const { resolveAndDispatch } = await import('../../src/agent/pending-resolver.js');
    const out = await resolveAndDispatch({
      pessoa, conversa, mensagem_id: 'm1',
      expected_pending_id: 'pq-1',
      option_chosen: 'sim',
      confidence: 1.0,
      source: 'reaction',
    });
    expect(out).toEqual({ resolved: true, action_tool: 'register_transaction' });
    expect(resolveTx).toHaveBeenCalledWith(
      expect.anything(),
      'pq-1',
      expect.objectContaining({ option_chosen: 'sim' }),
    );
    expect(audit.mock.calls.some((c) => c[0].acao === 'pending_resolved_by_reaction')).toBe(true);
    expect(audit.mock.calls.some((c) => c[0].acao === 'pending_action_dispatched')).toBe(true);
    expect(dispatchTool).toHaveBeenCalledTimes(1);
    expect(dispatchTool.mock.calls[0]![0].args).toMatchObject({ valor: 50, _pending_choice: 'sim' });
  });

  it('race-loss: re-check id mismatch → audit pending_race_lost, no dispatch', async () => {
    findActiveForUpdate.mockResolvedValueOnce({ id: 'pq-different', acao_proposta: {} });
    const { resolveAndDispatch } = await import('../../src/agent/pending-resolver.js');
    const out = await resolveAndDispatch({
      pessoa, conversa, mensagem_id: 'm1',
      expected_pending_id: 'pq-1',
      option_chosen: 'sim',
      confidence: 1.0,
      source: 'reaction',
    });
    expect(out).toEqual({ resolved: false, race_lost: true });
    expect(resolveTx).not.toHaveBeenCalled();
    expect(dispatchTool).not.toHaveBeenCalled();
    expect(audit.mock.calls.some((c) => c[0].acao === 'pending_race_lost')).toBe(true);
  });

  it('source=gate audits pending_resolved_by_gate', async () => {
    findActiveForUpdate.mockResolvedValueOnce({
      id: 'pq-1',
      acao_proposta: { tool: 'register_transaction', args: {} },
    });
    const { resolveAndDispatch } = await import('../../src/agent/pending-resolver.js');
    await resolveAndDispatch({
      pessoa, conversa, mensagem_id: 'm1',
      expected_pending_id: 'pq-1',
      option_chosen: 'sim',
      confidence: 0.8,
      source: 'gate',
    });
    expect(audit.mock.calls.some((c) => c[0].acao === 'pending_resolved_by_gate')).toBe(true);
  });

  it('no action_proposta → resolves but no dispatch', async () => {
    findActiveForUpdate.mockResolvedValueOnce({ id: 'pq-1', acao_proposta: {} });
    const { resolveAndDispatch } = await import('../../src/agent/pending-resolver.js');
    const out = await resolveAndDispatch({
      pessoa, conversa, mensagem_id: 'm1',
      expected_pending_id: 'pq-1',
      option_chosen: 'sim',
      confidence: 1.0,
      source: 'poll_vote',
    });
    expect(out.resolved).toBe(true);
    expect(out.action_tool).toBeUndefined();
    expect(dispatchTool).not.toHaveBeenCalled();
    expect(audit.mock.calls.some((c) => c[0].acao === 'pending_resolved_by_poll')).toBe(true);
  });
});
