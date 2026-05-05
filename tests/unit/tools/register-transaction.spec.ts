import { describe, it, expect, vi, beforeEach } from 'vitest';

const contasById = vi.fn();
const contasAddToBalance = vi.fn();
const findRecentSimilar = vi.fn();
const transacoesCreate = vi.fn();
const categoriasByNomeNatureza = vi.fn();

vi.mock('../../../src/db/repositories.js', () => ({
  contasRepo: {
    byId: contasById,
    addToBalance: contasAddToBalance,
  },
  transacoesRepo: {
    findRecentSimilar,
    create: transacoesCreate,
  },
  contrapartesRepo: {},
  categoriasRepo: {
    byNomeNatureza: categoriasByNomeNatureza,
  },
}));

vi.mock('../../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  contasById.mockReset();
  contasAddToBalance.mockReset();
  findRecentSimilar.mockReset();
  transacoesCreate.mockReset();
  categoriasByNomeNatureza.mockReset();
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
    transacoesCreate.mockResolvedValueOnce({ id: 'tx-1' });
    contasAddToBalance.mockResolvedValueOnce({ id: C1, saldo_atual: '1500.00' });

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
    expect(transacoesCreate).toHaveBeenCalledTimes(1);
    expect(contasAddToBalance).toHaveBeenCalledWith(C1, 500);
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
    expect(transacoesCreate).not.toHaveBeenCalled();
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
    expect(transacoesCreate).not.toHaveBeenCalled();
  });
});
