/**
 * compare_entities handler tests.
 *
 * Indirect coverage of this tool exists in tests/unit/cross-entity.spec.ts
 * (constitutional C-004 gate) and view-once.spec.ts (sensitive flag).
 * Neither exercises the handler itself — this spec adds direct happy-path
 * coverage plus scope filtering and schema validation.
 *
 * Mocks all three repos. Asserts:
 *   1. Happy path: per-entity rows + consolidado totals, summed precisely.
 *   2. Out-of-scope ids are silently filtered before any repo call.
 *   3. Schema rejects bad date formats.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const entidadesByIdsMock = vi.fn();
const transacoesByScopeMock = vi.fn();
const contasByEntityMock = vi.fn();

vi.mock('../../../src/db/repositories.js', () => ({
  entidadesRepo: { byIds: (...args: unknown[]) => entidadesByIdsMock(...args) },
  transacoesRepo: { byScope: (...args: unknown[]) => transacoesByScopeMock(...args) },
  contasRepo: { byEntity: (...args: unknown[]) => contasByEntityMock(...args) },
}));

vi.mock('../../../src/lib/logger.js', () => ({
  logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
}));

beforeEach(() => {
  entidadesByIdsMock.mockReset();
  transacoesByScopeMock.mockReset();
  contasByEntityMock.mockReset();
});

const E1 = '11111111-1111-1111-1111-111111111111';
const E2 = '22222222-2222-2222-2222-222222222222';
const E_OUT = '33333333-3333-3333-3333-333333333333';

const ctxWith = (entidades: string[]) =>
  ({
    pessoa: { id: 'p1' },
    conversa: { id: 'c1' },
    scope: { entidades, byEntity: new Map() },
    mensagem_id: 'm1',
    request_id: 'r1',
    idempotency_key: 'ik1',
  }) as never;

describe('compare_entities — handler', () => {
  it('happy path: aggregates rows + consolidado across entidades', async () => {
    entidadesByIdsMock.mockResolvedValueOnce([
      { id: E1, nome: 'Padaria' },
      { id: E2, nome: 'Mercado' },
    ]);
    // E1: 100 receita, 30 despesa, caixa 500
    transacoesByScopeMock.mockResolvedValueOnce([
      { natureza: 'receita', valor: '100.00' },
      { natureza: 'despesa', valor: '30.00' },
    ]);
    contasByEntityMock.mockResolvedValueOnce([{ saldo_atual: '500.00' }]);
    // E2: 200 receita, 50 despesa, caixa 1000.50
    transacoesByScopeMock.mockResolvedValueOnce([
      { natureza: 'receita', valor: '200.00' },
      { natureza: 'despesa', valor: '50.00' },
    ]);
    contasByEntityMock.mockResolvedValueOnce([{ saldo_atual: '1000.50' }]);

    const { compareEntitiesTool } = await import('../../../src/tools/compare-entities.js');
    const out = await compareEntitiesTool.handler(
      { entidade_ids: [E1, E2], date_from: '2026-01-01', date_to: '2026-12-31' },
      ctxWith([E1, E2]),
    );
    expect(out.rows).toHaveLength(2);
    expect(out.rows[0]).toMatchObject({
      entidade_id: E1,
      entidade_nome: 'Padaria',
      receita: 100,
      despesa: 30,
      lucro: 70,
      caixa_final: 500,
    });
    expect(out.rows[1]).toMatchObject({
      entidade_id: E2,
      receita: 200,
      despesa: 50,
      lucro: 150,
      caixa_final: 1000.5,
    });
    expect(out.consolidado).toEqual({
      receita: 300,
      despesa: 80,
      lucro: 220,
      caixa_final: 1500.5,
    });
  });

  it('filters out-of-scope entidade_ids before calling the repo', async () => {
    entidadesByIdsMock.mockResolvedValueOnce([{ id: E1, nome: 'OnlyOne' }]);
    transacoesByScopeMock.mockResolvedValueOnce([]);
    contasByEntityMock.mockResolvedValueOnce([]);

    const { compareEntitiesTool } = await import('../../../src/tools/compare-entities.js');
    const out = await compareEntitiesTool.handler(
      { entidade_ids: [E1, E_OUT], date_from: '2026-01-01', date_to: '2026-12-31' },
      ctxWith([E1, E2]),
    );
    // entidadesRepo.byIds called with the filtered list — only E1.
    expect(entidadesByIdsMock).toHaveBeenCalledWith([E1]);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]?.entidade_id).toBe(E1);
  });

  it('schema rejects malformed date_from', async () => {
    const { compareEntitiesTool } = await import('../../../src/tools/compare-entities.js');
    const r = compareEntitiesTool.input_schema.safeParse({
      entidade_ids: [E1],
      date_from: '01/01/2026',
      date_to: '2026-12-31',
    });
    expect(r.success).toBe(false);
  });

  it('schema rejects empty entidade_ids', async () => {
    const { compareEntitiesTool } = await import('../../../src/tools/compare-entities.js');
    const r = compareEntitiesTool.input_schema.safeParse({
      entidade_ids: [],
      date_from: '2026-01-01',
      date_to: '2026-12-31',
    });
    expect(r.success).toBe(false);
  });
});
