import { describe, it, expect, vi, beforeEach } from 'vitest';

const byIdMock = vi.fn();
const setStatusMock = vi.fn();
const listByChainMock = vi.fn();
vi.mock('../../../src/db/repositories.js', () => ({
  workflowsRepo: {
    byId: byIdMock,
    setStatus: setStatusMock,
    listByChain: listByChainMock,
  },
}));

const auditMock = vi.fn();
vi.mock('../../../src/governance/audit.js', () => ({ audit: auditMock }));

vi.mock('../../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  byIdMock.mockReset();
  setStatusMock.mockReset();
  listByChainMock.mockReset();
  auditMock.mockReset();
});

const ctx = {
  pessoa: { id: 'owner-id' },
  conversa: { id: 'c1' },
  scope: { entidades: [], byEntity: new Map() },
  mensagem_id: 'm1',
  request_id: 'r1',
  idempotency_key: 'ik1',
} as never;

describe('cancel_workflow tool', () => {
  it('returns empty when workflow does not exist', async () => {
    byIdMock.mockResolvedValue(null);
    const { cancelWorkflowTool } = await import('../../../src/tools/cancel-workflow.js');
    const result = await cancelWorkflowTool.handler(
      { workflow_id: '00000000-0000-0000-0000-000000000099', cancel_chain: true },
      ctx,
    );
    expect(result.cancelled_ids).toEqual([]);
    expect(result.chain_cancelled).toBe(false);
  });

  it('rejects when caller is not the creator', async () => {
    byIdMock.mockResolvedValue({
      id: 'wf-1',
      status: 'pendente',
      pessoa_envolvida: 'someone-else',
      chain_id: null,
    });
    const { cancelWorkflowTool } = await import('../../../src/tools/cancel-workflow.js');
    await expect(
      cancelWorkflowTool.handler(
        { workflow_id: '00000000-0000-0000-0000-000000000001', cancel_chain: true },
        ctx,
      ),
    ).rejects.toThrow(/apenas o criador/);
  });

  it('cancels the single workflow when no chain_id', async () => {
    byIdMock.mockResolvedValue({
      id: 'wf-2',
      status: 'pendente',
      pessoa_envolvida: 'owner-id',
      chain_id: null,
    });
    const { cancelWorkflowTool } = await import('../../../src/tools/cancel-workflow.js');
    const result = await cancelWorkflowTool.handler(
      { workflow_id: '00000000-0000-0000-0000-000000000002', cancel_chain: true },
      ctx,
    );
    expect(result.cancelled_ids).toEqual(['wf-2']);
    expect(result.chain_cancelled).toBe(false);
    expect(setStatusMock).toHaveBeenCalledWith('wf-2', 'cancelada');
  });

  it('cancels every workflow in the chain when cancel_chain=true and chain_id present', async () => {
    byIdMock.mockResolvedValue({
      id: 'wf-3',
      status: 'pendente',
      pessoa_envolvida: 'owner-id',
      chain_id: 'chain-x',
    });
    listByChainMock.mockResolvedValue([
      { id: 'wf-3', status: 'pendente', pessoa_envolvida: 'owner-id', chain_id: 'chain-x' },
      { id: 'wf-4', status: 'pendente', pessoa_envolvida: 'owner-id', chain_id: 'chain-x' },
      { id: 'wf-5-done', status: 'concluido', pessoa_envolvida: 'owner-id', chain_id: 'chain-x' },
    ]);
    const { cancelWorkflowTool } = await import('../../../src/tools/cancel-workflow.js');
    const result = await cancelWorkflowTool.handler(
      { workflow_id: '00000000-0000-0000-0000-000000000003', cancel_chain: true },
      ctx,
    );
    expect(result.cancelled_ids.sort()).toEqual(['wf-3', 'wf-4']); // already-concluido skipped
    expect(result.chain_cancelled).toBe(true);
    expect(setStatusMock).toHaveBeenCalledTimes(2);
  });

  it('audits each cancellation', async () => {
    byIdMock.mockResolvedValue({
      id: 'wf-6',
      status: 'pendente',
      pessoa_envolvida: 'owner-id',
      chain_id: null,
    });
    const { cancelWorkflowTool } = await import('../../../src/tools/cancel-workflow.js');
    await cancelWorkflowTool.handler(
      { workflow_id: '00000000-0000-0000-0000-000000000006', reason: 'mudei de ideia', cancel_chain: true },
      ctx,
    );
    expect(auditMock).toHaveBeenCalledTimes(1);
    const call = auditMock.mock.calls[0]![0] as { acao: string; metadata: { reason: string } };
    expect(call.acao).toBe('workflow_cancelled');
    expect(call.metadata.reason).toBe('mudei de ideia');
  });
});
