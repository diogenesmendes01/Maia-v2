import { describe, it, expect, vi, beforeEach } from 'vitest';

const contasById = vi.fn();
// #364 review blocker 2 — the handler now bundles the ledger INSERT + balance
// credit inside ONE `withTx`, using the tx-aware repo variants. We mock those
// variants (they receive the fake `tx` handle as their first arg) and `withTx`
// itself (runs the callback with that handle), so the unit test exercises the
// real atomic flow without a live Postgres.
const contasAddToBalanceTx = vi.fn();
const findRecentSimilar = vi.fn();
const transacoesCreateTx = vi.fn();
const categoriasByNomeNatureza = vi.fn();

// A sentinel standing in for the in-tx drizzle handle; we only assert it is the
// SAME object threaded into both tx-aware writes (proving one shared tx).
const FAKE_TX = { __tx: true } as const;

vi.mock('../../../src/db/repositories.js', () => ({
  contasRepo: {
    byId: contasById,
    addToBalanceTx: contasAddToBalanceTx,
  },
  transacoesRepo: {
    findRecentSimilar,
    createTx: transacoesCreateTx,
  },
  contrapartesRepo: {},
  categoriasRepo: {
    byNomeNatureza: categoriasByNomeNatureza,
  },
}));

// withTx runs its callback with the fake tx handle and returns its result —
// mirroring `@/db/client.js`'s real contract (BEGIN → fn(tx) → COMMIT; a throw
// inside rolls back). A throw therefore propagates exactly as in production.
const withTxMock = vi.fn(async (fn: (tx: unknown) => unknown) => fn(FAKE_TX));
vi.mock('../../../src/db/client.js', () => ({
  withTx: withTxMock,
}));

vi.mock('../../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  contasById.mockReset();
  contasAddToBalanceTx.mockReset();
  findRecentSimilar.mockReset();
  transacoesCreateTx.mockReset();
  categoriasByNomeNatureza.mockReset();
  withTxMock.mockClear();
});

const E1 = '00000000-0000-0000-0000-0000000000e1';
const C1 = '00000000-0000-0000-0000-0000000000c1';

const ctx = {
  pessoa: { id: 'p1' },
  conversa: { id: 'conv1' },
  scope: { entidades: [E1], byEntity: new Map() },
  mensagem_id: 'm1',
  request_id: 'r1',
  idempotency_key: 'ik1',
} as never;

describe('register_transaction tool', () => {
  it('happy path: registers a paid receita and returns updated saldo_apos', async () => {
    contasById.mockResolvedValueOnce({
      id: C1,
      entidade_id: E1,
      saldo_atual: '1000.00',
      apelido: 'Conta',
      banco: 'X',
    });
    findRecentSimilar.mockResolvedValueOnce([]);
    categoriasByNomeNatureza.mockResolvedValueOnce({ id: 'cat-receita-default' });
    transacoesCreateTx.mockResolvedValueOnce({ id: 'tx-1' });
    contasAddToBalanceTx.mockResolvedValueOnce({ id: C1, saldo_atual: '1500.00' });

    const { registerTransactionTool } = await import('../../../src/tools/register-transaction.js');
    const out = await registerTransactionTool.handler(
      {
        entidade_id: E1,
        conta_id: C1,
        natureza: 'receita',
        valor: 500,
        data_competencia: '2026-05-01',
        status: 'recebida',
        descricao: 'Venda X',
        origem: 'whatsapp',
      } as never,
      ctx,
    );

    expect(out).toEqual({ transacao_id: 'tx-1', saldo_apos: 1500 });
    // Ledger INSERT + balance credit ran inside ONE withTx, both on the SAME tx
    // handle (atomic — #364 blocker 2).
    expect(withTxMock).toHaveBeenCalledTimes(1);
    expect(transacoesCreateTx).toHaveBeenCalledTimes(1);
    expect(transacoesCreateTx.mock.calls[0]![0]).toBe(FAKE_TX);
    expect(contasAddToBalanceTx).toHaveBeenCalledWith(FAKE_TX, C1, 500);
  });

  it('atomicity: a fail-loud addToBalanceTx throw aborts the tx so NO ledger row is committed', async () => {
    // #364 blocker 2 — drive the real handler flow: createTx succeeds (its
    // INSERT is buffered in the tx), then the fail-loud addToBalanceTx throws on
    // a 0-row tenant/agent mismatch. Because both run inside the same withTx, the
    // throw propagates out of withTx (which, in production, ROLLs the BEGUN tx
    // back — so the just-INSERTed ledger row never commits). We assert the throw
    // surfaces AND that createTx + addToBalanceTx shared the one tx handle, i.e.
    // the ledger write is bound to the same transaction the credit aborted.
    contasById.mockResolvedValueOnce({
      id: C1,
      entidade_id: E1,
      saldo_atual: '1000.00',
      apelido: 'Conta',
      banco: 'X',
    });
    findRecentSimilar.mockResolvedValueOnce([]);
    categoriasByNomeNatureza.mockResolvedValueOnce({ id: 'cat-receita-default' });
    transacoesCreateTx.mockResolvedValueOnce({ id: 'tx-doomed' });
    // Mirror the repo's fail-loud guard message on a cross-tenant 0-row miss.
    contasAddToBalanceTx.mockRejectedValueOnce(
      new Error('contasRepo.addToBalance matched 0 rows for conta ' + C1),
    );

    const { registerTransactionTool } = await import('../../../src/tools/register-transaction.js');
    await expect(
      registerTransactionTool.handler(
        {
          entidade_id: E1,
          conta_id: C1,
          natureza: 'receita',
          valor: 500,
          data_competencia: '2026-05-01',
          status: 'recebida',
          descricao: 'Venda X',
          origem: 'whatsapp',
        } as never,
        ctx,
      ),
    ).rejects.toThrow(/addToBalance matched 0 rows/);

    // Both writes were issued on the SAME tx handle — so the ledger INSERT is
    // part of the transaction that just aborted (rolled back together): no orphan
    // ledger row without its balance credit.
    expect(withTxMock).toHaveBeenCalledTimes(1);
    expect(transacoesCreateTx.mock.calls[0]![0]).toBe(FAKE_TX);
    expect(contasAddToBalanceTx.mock.calls[0]![0]).toBe(FAKE_TX);
  });

  it('schema rejects payload missing required field (descricao)', async () => {
    const { registerTransactionTool } = await import('../../../src/tools/register-transaction.js');
    const parsed = registerTransactionTool.input_schema.safeParse({
      entidade_id: E1,
      conta_id: C1,
      natureza: 'despesa',
      valor: 100,
      data_competencia: '2026-05-01',
      status: 'paga',
      // descricao omitted
    });
    expect(parsed.success).toBe(false);
  });

  it('throws when conta does not belong to entidade (cross-entity guard)', async () => {
    contasById.mockResolvedValueOnce({
      id: C1,
      entidade_id: '00000000-0000-0000-0000-0000000000e2',
      saldo_atual: '0.00',
      apelido: 'Conta',
      banco: 'X',
    });
    const { registerTransactionTool } = await import('../../../src/tools/register-transaction.js');
    await expect(
      registerTransactionTool.handler(
        {
          entidade_id: E1,
          conta_id: C1,
          natureza: 'despesa',
          valor: 50,
          data_competencia: '2026-05-01',
          status: 'paga',
          descricao: 'X',
          origem: 'whatsapp',
        } as never,
        ctx,
      ),
    ).rejects.toThrow(/entidade_conta_mismatch|não pertence/);
    expect(transacoesCreateTx).not.toHaveBeenCalled();
  });

  it('returns duplicate_suspected when a similar recent transaction exists', async () => {
    contasById.mockResolvedValueOnce({
      id: C1,
      entidade_id: E1,
      saldo_atual: '1000.00',
      apelido: 'Conta',
      banco: 'X',
    });
    findRecentSimilar.mockResolvedValueOnce([
      {
        id: 'tx-existing',
        data_competencia: '2026-05-01',
        valor: '500.00',
        descricao: 'Venda X',
      },
    ]);

    const { registerTransactionTool } = await import('../../../src/tools/register-transaction.js');
    const out = await registerTransactionTool.handler(
      {
        entidade_id: E1,
        conta_id: C1,
        natureza: 'receita',
        valor: 500,
        data_competencia: '2026-05-01',
        status: 'recebida',
        descricao: 'Venda X',
        origem: 'whatsapp',
      } as never,
      ctx,
    );

    expect(out).toMatchObject({
      duplicate_suspected: true,
      existing: { transacao_id: 'tx-existing', valor: 500 },
    });
    expect(transacoesCreateTx).not.toHaveBeenCalled();
  });
});
