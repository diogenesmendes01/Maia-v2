import { describe, it, expect, vi, beforeEach } from 'vitest';

const contasById = vi.fn();
const contasByEntity = vi.fn();
const contasByEntities = vi.fn();

vi.mock('../../../src/db/repositories.js', () => ({
  contasRepo: {
    byId: contasById,
    byEntity: contasByEntity,
    byEntities: contasByEntities,
  },
}));

vi.mock('../../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  contasById.mockReset();
  contasByEntity.mockReset();
  contasByEntities.mockReset();
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

describe('query_balance tool', () => {
  it('happy path: lists contas for entidade in scope with decimal-correct totals', async () => {
    contasByEntity.mockResolvedValueOnce([
      { id: 'c1', apelido: 'Conta A', saldo_atual: '1000.10', banco: 'X', entidade_id: E1 },
      { id: 'c2', apelido: 'Conta B', saldo_atual: '0.20', banco: 'Y', entidade_id: E1 },
    ]);

    const { queryBalanceTool } = await import('../../../src/tools/query-balance.js');
    const out = await queryBalanceTool.handler({ entidade_id: E1 } as never, ctx);

    expect(out.contas).toHaveLength(2);
    // Decimal-safe sum: 1000.10 + 0.20 = 1000.30 (no float drift)
    expect(out.total).toBe(1000.3);
    expect(out.contas[0]).toMatchObject({ id: 'c1', saldo: 1000.1, banco: 'X' });
  });

  it('returns empty list when entidade_id is outside scope (forbidden silent)', async () => {
    const { queryBalanceTool } = await import('../../../src/tools/query-balance.js');
    const out = await queryBalanceTool.handler({ entidade_id: E_OTHER } as never, ctx);
    expect(out).toEqual({ contas: [], total: 0 });
    expect(contasByEntity).not.toHaveBeenCalled();
    expect(contasByEntities).not.toHaveBeenCalled();
  });

  it('schema rejects non-uuid entidade_id', async () => {
    const { queryBalanceTool } = await import('../../../src/tools/query-balance.js');
    const parsed = queryBalanceTool.input_schema.safeParse({ entidade_id: 'not-a-uuid' });
    expect(parsed.success).toBe(false);
  });

  it('with no args, queries all contas in scope via byEntities', async () => {
    contasByEntities.mockResolvedValueOnce([
      { id: 'c1', apelido: 'A', saldo_atual: '500.00', banco: 'X', entidade_id: E1 },
    ]);
    const { queryBalanceTool } = await import('../../../src/tools/query-balance.js');
    const out = await queryBalanceTool.handler({} as never, ctx);
    expect(contasByEntities).toHaveBeenCalledWith({
      pessoa_id: 'p1',
      entidades: [E1],
    });
    expect(out.total).toBe(500);
  });

  it('conta_id outside scope returns empty list', async () => {
    contasById.mockResolvedValueOnce({
      id: 'cX',
      apelido: 'Out',
      saldo_atual: '999.00',
      banco: 'X',
      entidade_id: E_OTHER,
    });
    const { queryBalanceTool } = await import('../../../src/tools/query-balance.js');
    const out = await queryBalanceTool.handler(
      { conta_id: '00000000-0000-0000-0000-0000000000cc' } as never,
      ctx,
    );
    expect(out).toEqual({ contas: [], total: 0 });
  });
});
