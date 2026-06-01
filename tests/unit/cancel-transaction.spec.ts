import { describe, it, expect, vi, beforeEach } from 'vitest';

const transacoesByIdMock = vi.fn();
// Issue #366 — cancel now runs the lifecycle UPDATE + its audit row inside ONE
// `withTx` via the tx-aware variants (`updateTx`, `auditTx`). We mock those (they
// receive the fake `tx` handle as their first arg) and `withTx` itself, so the
// unit test exercises the real atomic flow without a live Postgres.
const updateTxMock = vi.fn();
const auditTxMock = vi.fn();

// Sentinel for the in-tx drizzle handle; asserted to be the SAME object threaded
// into BOTH the cancel UPDATE and the audit write (proving one shared tx).
const FAKE_TX = { __tx: true } as const;

vi.mock('../../src/db/repositories.js', () => ({
  transacoesRepo: {
    byId: transacoesByIdMock,
    updateTx: updateTxMock,
  },
}));

vi.mock('../../src/governance/audit.js', () => ({ auditTx: auditTxMock }));

// withTx runs its callback with the fake tx handle and returns its result —
// mirroring `@/db/client.js`'s real contract (BEGIN → fn(tx) → COMMIT; a throw
// inside rolls back). A throw therefore propagates exactly as in production.
const withTxMock = vi.fn(async (fn: (tx: unknown) => unknown) => fn(FAKE_TX));
vi.mock('../../src/db/client.js', () => ({ withTx: withTxMock }));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  transacoesByIdMock.mockReset();
  updateTxMock.mockReset();
  auditTxMock.mockReset();
  withTxMock.mockClear();
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
    updateTxMock.mockResolvedValueOnce(undefined);
    auditTxMock.mockResolvedValueOnce(undefined);
    const { cancelTransactionTool } = await import('../../src/tools/cancel-transaction.js');
    const result = await cancelTransactionTool.handler(
      { entidade_id: 'e1', transacao_id: 'tx-1', motivo: 'edit_review' } as never,
      ctx,
    );
    expect(result).toEqual({ ok: true, transacao_id: 'tx-1' });
    // Issue #366 — UPDATE + audit ran inside ONE withTx, both on the SAME tx
    // handle (atomic, fail-loud audit). The dispatcher skips its post-commit
    // audit() because the tool sets `audits_in_tx`.
    expect(withTxMock).toHaveBeenCalledTimes(1);
    expect(updateTxMock).toHaveBeenCalledWith(
      FAKE_TX,
      'tx-1',
      expect.objectContaining({ status: 'cancelada' }),
    );
    expect(auditTxMock).toHaveBeenCalledTimes(1);
    expect(auditTxMock.mock.calls[0]![0]).toBe(FAKE_TX);
    expect(auditTxMock.mock.calls[0]![1]).toMatchObject({
      acao: 'transaction_cancelled',
      entidade_alvo: 'e1',
      alvo_id: 'tx-1',
    });
  });

  it('refuses out-of-scope transaction with forbidden', async () => {
    // Caller passed e_other (matches the tx) but it is NOT in their scope —
    // the dispatcher would already have blocked this in production; the
    // handler keeps the scope check as defense in depth.
    transacoesByIdMock.mockResolvedValueOnce({
      id: 'tx-2',
      entidade_id: 'e_other',
      status: 'paga',
    });
    const { cancelTransactionTool } = await import('../../src/tools/cancel-transaction.js');
    const result = await cancelTransactionTool.handler(
      { entidade_id: 'e_other', transacao_id: 'tx-2' } as never,
      ctx,
    );
    expect(result).toEqual({ error: 'forbidden' });
    expect(updateTxMock).not.toHaveBeenCalled();
    expect(auditTxMock).not.toHaveBeenCalled();
  });

  it('refuses when args.entidade_id does not match tx.entidade_id (cross-entity hijack)', async () => {
    // The dispatcher authorized cancel_transaction against `e1`'s profile
    // because the caller (or LLM) passed `entidade_id=e1`. But the actual
    // transaction belongs to `e2`. Without this check, a profile that
    // permits cancel on e1 would be misused to cancel a transaction owned
    // by e2 (or vice versa, blocking a legitimate cancel).
    transacoesByIdMock.mockResolvedValueOnce({
      id: 'tx-cross',
      entidade_id: 'e2',
      status: 'paga',
    });
    const { cancelTransactionTool } = await import('../../src/tools/cancel-transaction.js');
    const result = await cancelTransactionTool.handler(
      { entidade_id: 'e1', transacao_id: 'tx-cross' } as never,
      ctx,
    );
    expect(result).toEqual({ error: 'forbidden' });
    expect(updateTxMock).not.toHaveBeenCalled();
    expect(auditTxMock).not.toHaveBeenCalled();
  });

  it('returns error when transaction missing', async () => {
    transacoesByIdMock.mockResolvedValueOnce(null);
    const { cancelTransactionTool } = await import('../../src/tools/cancel-transaction.js');
    const result = await cancelTransactionTool.handler(
      { entidade_id: 'e1', transacao_id: 'tx-missing' } as never,
      ctx,
    );
    expect(result).toEqual({ error: 'not_found' });
    expect(updateTxMock).not.toHaveBeenCalled();
  });

  it('is idempotent on already-cancelada transaction (no-op success)', async () => {
    transacoesByIdMock.mockResolvedValueOnce({
      id: 'tx-3',
      entidade_id: 'e1',
      status: 'cancelada',
    });
    const { cancelTransactionTool } = await import('../../src/tools/cancel-transaction.js');
    const result = await cancelTransactionTool.handler(
      { entidade_id: 'e1', transacao_id: 'tx-3' } as never,
      ctx,
    );
    expect(result).toEqual({ ok: true, transacao_id: 'tx-3' });
    expect(updateTxMock).not.toHaveBeenCalled();
    expect(auditTxMock).not.toHaveBeenCalled();
  });

  it('issue #366 — a failed audit insert INSIDE the tx propagates so the cancel UPDATE rolls back (no lifecycle change without audit)', async () => {
    // The compliance invariant for the cancel path: a transaction can NEVER flip
    // to 'cancelada' without its audit row. The UPDATE is staged in the tx, then
    // the in-tx `auditTx` throws; because both run inside ONE withTx and auditTx
    // does NOT swallow the error, the throw propagates out of withTx (which in
    // production ROLLs the staged UPDATE back). We assert the throw surfaces AND
    // that the UPDATE + audit shared the one tx handle (bound to the aborted tx).
    transacoesByIdMock.mockResolvedValueOnce({
      id: 'tx-doomed',
      entidade_id: 'e1',
      status: 'paga',
    });
    updateTxMock.mockResolvedValueOnce(undefined);
    auditTxMock.mockRejectedValueOnce(new Error('audit insert failed'));
    const { cancelTransactionTool } = await import('../../src/tools/cancel-transaction.js');
    await expect(
      cancelTransactionTool.handler(
        { entidade_id: 'e1', transacao_id: 'tx-doomed' } as never,
        ctx,
      ),
    ).rejects.toThrow(/audit insert failed/);
    // Both the cancel UPDATE and the audit write were issued on the SAME tx
    // handle — so the audit failure aborts the transaction the UPDATE is bound to.
    expect(withTxMock).toHaveBeenCalledTimes(1);
    expect(updateTxMock.mock.calls[0]![0]).toBe(FAKE_TX);
    expect(auditTxMock.mock.calls[0]![0]).toBe(FAKE_TX);
  });

  it('declares audits_in_tx so the dispatcher does NOT also write a (duplicate) audit row', async () => {
    const { cancelTransactionTool } = await import('../../src/tools/cancel-transaction.js');
    expect(cancelTransactionTool.audits_in_tx).toBe(true);
  });
});
