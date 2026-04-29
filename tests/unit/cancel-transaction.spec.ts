import { describe, it, expect, vi, beforeEach } from 'vitest';

const transacoesByIdMock = vi.fn();
const updateMock = vi.fn();

vi.mock('../../src/db/repositories.js', () => ({
  transacoesRepo: {
    byId: transacoesByIdMock,
    update: updateMock,
  },
}));

const auditMock = vi.fn();
vi.mock('../../src/governance/audit.js', () => ({ audit: auditMock }));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  transacoesByIdMock.mockReset();
  updateMock.mockReset();
  auditMock.mockReset();
});

const ctx = {
  pessoa: { id: 'p1' },
  conversa: { id: 'c1' },
  scope: { entidades: ['e1', 'e2'], byEntity: new Map() },
  mensagem_id: 'm1',
  request_id: 'r1',
  idempotency_key: 'ik1',
} as never;

describe('cancel_transaction tool', () => {
  it('cancels a transaction in scope and audits transaction_cancelled', async () => {
    transacoesByIdMock.mockResolvedValueOnce({
      id: 'tx-1',
      entidade_id: 'e1',
      status: 'paga',
    });
    updateMock.mockResolvedValueOnce(undefined);
    const { cancelTransactionTool } = await import('../../src/tools/cancel-transaction.js');
    const result = await cancelTransactionTool.handler(
      { transacao_id: 'tx-1', motivo: 'edit_review' } as never,
      ctx,
    );
    expect(result).toEqual({ ok: true, transacao_id: 'tx-1' });
    expect(updateMock).toHaveBeenCalledWith(
      'tx-1',
      expect.objectContaining({ status: 'cancelada' }),
    );
    expect(auditMock.mock.calls.some((c) => c[0].acao === 'transaction_cancelled')).toBe(true);
  });

  it('refuses out-of-scope transaction with forbidden', async () => {
    transacoesByIdMock.mockResolvedValueOnce({
      id: 'tx-2',
      entidade_id: 'e_other',
      status: 'paga',
    });
    const { cancelTransactionTool } = await import('../../src/tools/cancel-transaction.js');
    const result = await cancelTransactionTool.handler(
      { transacao_id: 'tx-2' } as never,
      ctx,
    );
    expect(result).toEqual({ error: 'forbidden' });
    expect(updateMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('returns error when transaction missing', async () => {
    transacoesByIdMock.mockResolvedValueOnce(null);
    const { cancelTransactionTool } = await import('../../src/tools/cancel-transaction.js');
    const result = await cancelTransactionTool.handler(
      { transacao_id: 'tx-missing' } as never,
      ctx,
    );
    expect(result).toEqual({ error: 'not_found' });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('is idempotent on already-cancelada transaction (no-op success)', async () => {
    transacoesByIdMock.mockResolvedValueOnce({
      id: 'tx-3',
      entidade_id: 'e1',
      status: 'cancelada',
    });
    const { cancelTransactionTool } = await import('../../src/tools/cancel-transaction.js');
    const result = await cancelTransactionTool.handler(
      { transacao_id: 'tx-3' } as never,
      ctx,
    );
    expect(result).toEqual({ ok: true, transacao_id: 'tx-3' });
    expect(updateMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });
});
