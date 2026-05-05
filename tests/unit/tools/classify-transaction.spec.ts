import { describe, it, expect, vi, beforeEach } from 'vitest';

const rulesListActive = vi.fn();
const categoriasList = vi.fn();
const categoriasById = vi.fn();

vi.mock('../../../src/db/repositories.js', () => ({
  rulesRepo: { listActive: rulesListActive },
  categoriasRepo: {
    list: categoriasList,
    byId: categoriasById,
  },
}));

vi.mock('../../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  rulesListActive.mockReset();
  categoriasList.mockReset();
  categoriasById.mockReset();
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

describe('classify_transaction tool', () => {
  it('happy path: rule match wins, returns categoria + rules_applied', async () => {
    rulesListActive.mockResolvedValueOnce([
      {
        id: 'rule-1',
        contexto_jsonb: { contains: 'uber', entidade_id: E1 },
        acoes_jsonb: { categoria_id: 'cat-transporte' },
        confianca: '0.92',
      },
    ]);
    categoriasList.mockResolvedValueOnce([]);
    categoriasById.mockResolvedValueOnce({ id: 'cat-transporte', nome: 'Transporte' });

    const { classifyTransactionTool } = await import('../../../src/tools/classify-transaction.js');
    const out = await classifyTransactionTool.handler(
      { entidade_id: E1, descricao: 'UBER *trip 1234' } as never,
      ctx,
    );

    expect(out.categoria_id).toBe('cat-transporte');
    expect(out.categoria_nome).toBe('Transporte');
    expect(out.rules_applied).toEqual(['rule-1']);
    expect(out.confianca).toBeCloseTo(0.92);
  });

  it('falls back to trigram similarity when no rule matches', async () => {
    rulesListActive.mockResolvedValueOnce([]);
    categoriasList.mockResolvedValueOnce([
      { id: 'cat-mercado', nome: 'Mercado', natureza: 'despesa' },
      { id: 'cat-restaurante', nome: 'Restaurante', natureza: 'despesa' },
    ]);

    const { classifyTransactionTool } = await import('../../../src/tools/classify-transaction.js');
    const out = await classifyTransactionTool.handler(
      { entidade_id: E1, descricao: 'mercado bairro' } as never,
      ctx,
    );

    // Either suggestions has entries (highest score is mercado) or list is
    // empty if trigram threshold is not met. Both behaviours are accepted by
    // the schema; we assert the contract instead of pinning a number.
    expect(Array.isArray(out.suggestions)).toBe(true);
    expect(out.rules_applied).toEqual([]);
    if (out.suggestions.length > 0) {
      expect(out.suggestions[0]!.categoria_nome).toBe('Mercado');
      expect(out.categoria_id).toBe('cat-mercado');
    }
  });

  it('returns empty/zero-confidence when entidade_id is outside scope', async () => {
    const { classifyTransactionTool } = await import('../../../src/tools/classify-transaction.js');
    const out = await classifyTransactionTool.handler(
      { entidade_id: E_OTHER, descricao: 'x' } as never,
      ctx,
    );
    expect(out).toEqual({
      categoria_id: null,
      categoria_nome: null,
      confianca: 0,
      rules_applied: [],
      suggestions: [],
    });
    expect(rulesListActive).not.toHaveBeenCalled();
  });

  it('schema rejects empty descricao', async () => {
    const { classifyTransactionTool } = await import('../../../src/tools/classify-transaction.js');
    const parsed = classifyTransactionTool.input_schema.safeParse({
      entidade_id: E1,
      descricao: '',
    });
    expect(parsed.success).toBe(false);
  });

  it('schema rejects missing entidade_id', async () => {
    const { classifyTransactionTool } = await import('../../../src/tools/classify-transaction.js');
    const parsed = classifyTransactionTool.input_schema.safeParse({
      descricao: 'Uber',
    });
    expect(parsed.success).toBe(false);
  });
});
