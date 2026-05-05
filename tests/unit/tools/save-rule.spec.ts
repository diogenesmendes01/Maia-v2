import { describe, it, expect, vi, beforeEach } from 'vitest';

const rulesCreateMock = vi.fn();

vi.mock('../../../src/db/repositories.js', () => ({
  rulesRepo: {
    create: rulesCreateMock,
  },
}));

vi.mock('../../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  rulesCreateMock.mockReset();
});

const ctx = {
  pessoa: { id: 'p1' },
  conversa: { id: 'c1' },
  scope: { entidades: ['e1'], byEntity: new Map() },
  mensagem_id: 'm1',
  request_id: 'r1',
  idempotency_key: 'ik1',
} as never;

describe('save_rule tool', () => {
  it('happy path: creates a learned rule in probatory state with default confidence/counters', async () => {
    rulesCreateMock.mockResolvedValueOnce({ id: 'rule-uuid-1' });
    const { saveRuleTool } = await import('../../../src/tools/save-rule.js');
    const result = await saveRuleTool.handler(
      {
        tipo: 'classificacao',
        contexto: 'descricao contem "uber"',
        acao: 'categoria=transporte',
        contexto_jsonb: { tokens: ['uber'] },
        acoes_jsonb: { categoria: 'transporte' },
      } as never,
      ctx,
    );
    expect(result).toEqual({ rule_id: 'rule-uuid-1', status: 'probatoria' });
    expect(rulesCreateMock).toHaveBeenCalledTimes(1);
    const arg = rulesCreateMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.tipo).toBe('classificacao');
    expect(arg.contexto).toBe('descricao contem "uber"');
    expect(arg.acao).toBe('categoria=transporte');
    // Probatory state: never trusted; reflexão promotes later.
    expect(arg.confianca).toBe('0.50');
    expect(arg.acertos).toBe(0);
    expect(arg.erros).toBe(0);
    expect(arg.ativa).toBe(true);
    expect(arg.exemplo_origem_id).toBeNull();
  });

  it('schema invalid: rejects unknown tipo', async () => {
    const { saveRuleTool } = await import('../../../src/tools/save-rule.js');
    const parsed = saveRuleTool.input_schema.safeParse({
      tipo: 'desconhecida',
      contexto: 'x',
      acao: 'y',
    });
    expect(parsed.success).toBe(false);
    expect(rulesCreateMock).not.toHaveBeenCalled();
  });

  it('fills default jsonb objects when omitted', async () => {
    rulesCreateMock.mockResolvedValueOnce({ id: 'rule-uuid-2' });
    const { saveRuleTool } = await import('../../../src/tools/save-rule.js');
    const parsed = saveRuleTool.input_schema.parse({
      tipo: 'tom_resposta',
      contexto: 'usuario formal',
      acao: 'tom=formal',
    });
    await saveRuleTool.handler(parsed as never, ctx);
    const arg = rulesCreateMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.contexto_jsonb).toEqual({});
    expect(arg.acoes_jsonb).toEqual({});
  });
});
