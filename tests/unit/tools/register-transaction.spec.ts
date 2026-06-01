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
// Issue #366 — the handler now also writes its audit row TRANSACTIONALLY via
// `auditTx(tx, …)` inside the same `withTx`. We mock it as a spy so we can (a)
// assert exactly ONE audit row is written on the happy path (no duplicate from
// the dispatcher) and (b) force it to throw INSIDE the tx and prove the ledger
// row + balance change roll back (no orphan money without audit).
const auditTx = vi.fn();

// A sentinel standing in for the in-tx drizzle handle; we only assert it is the
// SAME object threaded into all tx-aware writes (proving one shared tx).
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

vi.mock('../../../src/governance/audit.js', () => ({
  auditTx,
}));

// withTx simulates `@/db/client.js`'s real contract against an in-memory
// committed store: it runs the callback with the fake tx handle, and if the
// callback THROWS, it discards the staged writes (ledger row + balance change)
// exactly as a Postgres ROLLBACK would — so a throw mid-tx leaves the committed
// store unchanged. The tx-aware repo mocks (below, per test) stage their writes
// into `staged`; on commit they flush to `committed`, on rollback they are
// dropped. This makes the orphan-money assertion LITERAL: after a failed audit
// the committed `transacoes` row and `saldo_atual` delta are both absent.
const committed = { transacoes: [] as Array<{ id: string }>, saldoDelta: 0 };
const staged = { transacoes: [] as Array<{ id: string }>, saldoDelta: 0 };
const withTxMock = vi.fn(async (fn: (tx: unknown) => unknown) => {
  staged.transacoes = [];
  staged.saldoDelta = 0;
  try {
    const result = await fn(FAKE_TX);
    // COMMIT: flush staged writes into the committed store.
    committed.transacoes.push(...staged.transacoes);
    committed.saldoDelta += staged.saldoDelta;
    return result;
  } catch (err) {
    // ROLLBACK: drop staged writes — committed store is untouched.
    staged.transacoes = [];
    staged.saldoDelta = 0;
    throw err;
  }
});
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
  auditTx.mockReset();
  withTxMock.mockClear();
  committed.transacoes = [];
  committed.saldoDelta = 0;
  staged.transacoes = [];
  staged.saldoDelta = 0;
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
    auditTx.mockResolvedValueOnce(undefined);

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
    // Issue #366 — EXACTLY ONE audit row, written TRANSACTIONALLY on the same tx
    // handle (no duplicate: the dispatcher skips its post-commit audit() because
    // the tool sets `audits_in_tx`). alvo_id is the new ledger id; metadata
    // mirrors what the dispatcher would have recorded.
    expect(auditTx).toHaveBeenCalledTimes(1);
    expect(auditTx.mock.calls[0]![0]).toBe(FAKE_TX);
    expect(auditTx.mock.calls[0]![1]).toMatchObject({
      acao: 'transaction_created',
      entidade_alvo: E1,
      alvo_id: 'tx-1',
      metadata: { tool: 'register_transaction' },
    });
  });

  it('declares audits_in_tx so the dispatcher does NOT also write a (duplicate) audit row', async () => {
    // Issue #366 — the durability contract: the dispatcher checks `audits_in_tx`
    // at its post-commit audit() and skips it for tools that self-audit in-tx.
    const { registerTransactionTool } = await import('../../../src/tools/register-transaction.js');
    expect(registerTransactionTool.audits_in_tx).toBe(true);
  });

  it('review #374 — auditedInTx is TRUE for the mutating result (self-audited in-tx → dispatcher skips fallback)', async () => {
    const { registerTransactionTool } = await import('../../../src/tools/register-transaction.js');
    expect(registerTransactionTool.auditedInTx).toBeDefined();
    // Happy-path result: auditTx ran inside withTx → dispatcher must SKIP fallback.
    expect(
      registerTransactionTool.auditedInTx!({ transacao_id: 'tx-1', saldo_apos: 1500 } as never),
    ).toBe(true);
  });

  it('review #374 — auditedInTx is FALSE for the duplicate-suspected early return (dispatcher must still fallback-audit)', async () => {
    // The duplicate-suspected path exits BEFORE any withTx/auditTx. The
    // dispatcher's static `audits_in_tx` skip would otherwise drop the audit
    // row entirely for this invocation — `auditedInTx` returning false keeps
    // the fallback audit() firing (append-only trail per invocation).
    const { registerTransactionTool } = await import('../../../src/tools/register-transaction.js');
    expect(
      registerTransactionTool.auditedInTx!({
        duplicate_suspected: true,
        existing: {
          transacao_id: 'tx-existing',
          data_competencia: '2026-05-01',
          valor: 500,
          descricao: 'Venda X',
        },
      } as never),
    ).toBe(false);
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

  it('issue #366 — a failed audit insert INSIDE the tx rolls back BOTH the ledger row and the saldo change (no orphan money without audit)', async () => {
    // The compliance invariant: money must NEVER move without its audit row.
    // Here createTx + addToBalanceTx succeed (staged into the tx), then the
    // in-tx `auditTx` throws (simulating a DB error on the audit insert). Because
    // all three run inside ONE withTx and auditTx does NOT swallow the error, the
    // throw propagates out of withTx → ROLLBACK. We assert (1) the throw
    // surfaces, (2) the committed `transacoes` store is empty (ledger row rolled
    // back), and (3) the committed saldo delta is 0 (balance change rolled back).
    contasById.mockResolvedValueOnce({
      id: C1,
      entidade_id: E1,
      saldo_atual: '1000.00',
      apelido: 'Conta',
      banco: 'X',
    });
    findRecentSimilar.mockResolvedValueOnce([]);
    categoriasByNomeNatureza.mockResolvedValueOnce({ id: 'cat-receita-default' });
    // Stage the ledger INSERT into the tx (flushed to committed only on COMMIT).
    transacoesCreateTx.mockImplementationOnce(async (_tx: unknown) => {
      staged.transacoes.push({ id: 'tx-doomed' });
      return { id: 'tx-doomed' };
    });
    // Stage the balance credit into the tx.
    contasAddToBalanceTx.mockImplementationOnce(async (_tx: unknown, _id: string, delta: number) => {
      staged.saldoDelta += delta;
      return { id: C1, saldo_atual: '1500.00' };
    });
    // The audit insert fails inside the tx (DB slow/OOM, etc.). Fail-loud.
    auditTx.mockRejectedValueOnce(new Error('audit insert failed'));

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
    ).rejects.toThrow(/audit insert failed/);

    // All three writes shared the SAME tx handle — so the audit failure aborts
    // the transaction the ledger + balance writes are bound to.
    expect(transacoesCreateTx.mock.calls[0]![0]).toBe(FAKE_TX);
    expect(contasAddToBalanceTx.mock.calls[0]![0]).toBe(FAKE_TX);
    expect(auditTx.mock.calls[0]![0]).toBe(FAKE_TX);
    // ROLLBACK proof: nothing committed. No orphan ledger row, no balance change.
    expect(committed.transacoes).toEqual([]);
    expect(committed.saldoDelta).toBe(0);
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
