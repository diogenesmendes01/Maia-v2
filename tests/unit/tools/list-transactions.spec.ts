import { describe, it, expect, vi, beforeEach } from 'vitest';

const byScope = vi.fn();

vi.mock('../../../src/db/repositories.js', () => ({
  transacoesRepo: { byScope },
}));

vi.mock('../../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  byScope.mockReset();
});

const E1 = '00000000-0000-0000-0000-0000000000e1';
const E_OTHER = '00000000-0000-0000-0000-0000000000e9';

const ctx = {
  pessoa: { id: 'p1' },
  conversa: { id: 'c1' },
  scope: { entidades: [E1], byEntity: new Map() },
  mensagem_id: 'm1',
  request_id: 'r1',
  idempotency_key: 'ik1',
} as never;

describe('list_transactions tool', () => {
  it('happy path: returns transactions filtered by date range', async () => {
    byScope.mockResolvedValueOnce([
      {
        id: 'tx-1',
        data_competencia: '2026-04-05',
        natureza: 'receita',
        valor: '1500.00',
        descricao: 'Venda',
        categoria_id: 'cat-1',
        status: 'recebida',
      },
      {
        id: 'tx-2',
        data_competencia: '2026-04-10',
        natureza: 'despesa',
        valor: '300.50',
        descricao: 'Aluguel',
        categoria_id: null,
        status: 'paga',
      },
    ]);
    const { listTransactionsTool } = await import('../../../src/tools/list-transactions.js');
    const out = await listTransactionsTool.handler(
      {
        entidade_id: E1,
        date_from: '2026-04-01',
        date_to: '2026-04-30',
        limit: 50,
        offset: 0,
      } as never,
      ctx,
    );

    expect(out.items).toHaveLength(2);
    expect(out.items[0]).toMatchObject({ id: 'tx-1', valor: 1500, status: 'recebida' });
    expect(out.items[1]).toMatchObject({ id: 'tx-2', valor: 300.5, categoria_id: null });
    expect(byScope).toHaveBeenCalledWith(
      { pessoa_id: 'p1', entidades: [E1] },
      expect.objectContaining({ date_from: '2026-04-01', date_to: '2026-04-30', limit: 50, offset: 0 }),
    );
  });

  it('returns empty list when entidade_id is outside scope', async () => {
    const { listTransactionsTool } = await import('../../../src/tools/list-transactions.js');
    const out = await listTransactionsTool.handler(
      { entidade_id: E_OTHER, limit: 50, offset: 0 } as never,
      ctx,
    );
    expect(out).toEqual({ items: [] });
    expect(byScope).not.toHaveBeenCalled();
  });

  it('schema rejects missing entidade_id', async () => {
    const { listTransactionsTool } = await import('../../../src/tools/list-transactions.js');
    const parsed = listTransactionsTool.input_schema.safeParse({
      date_from: '2026-04-01',
    });
    expect(parsed.success).toBe(false);
  });

  it('schema rejects limit > 200 (pagination guard)', async () => {
    const { listTransactionsTool } = await import('../../../src/tools/list-transactions.js');
    const parsed = listTransactionsTool.input_schema.safeParse({
      entidade_id: E1,
      limit: 999,
    });
    expect(parsed.success).toBe(false);
  });

  it('schema applies default limit=50 and offset=0 when omitted', async () => {
    const { listTransactionsTool } = await import('../../../src/tools/list-transactions.js');
    const parsed = listTransactionsTool.input_schema.safeParse({ entidade_id: E1 });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.limit).toBe(50);
      expect(parsed.data.offset).toBe(0);
    }
  });
});
