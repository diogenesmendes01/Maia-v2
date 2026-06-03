import { describe, it, expect, vi, beforeEach } from 'vitest';

// save_rule is now an unconditional wrapper over propose_rule (KSM always-on);
// rules always land in pending_review. Mock the proposer so this unit test
// stays focused on save_rule's own behaviour: delegation + status surface.
const proposeRuleHandlerMock = vi.fn();

vi.mock('../../../src/tools/propose-rule.js', () => ({
  proposeRuleTool: { handler: proposeRuleHandlerMock },
}));

vi.mock('../../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  proposeRuleHandlerMock.mockReset();
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
  it('happy path: routes through propose_rule (KSM) and reports pending_review', async () => {
    proposeRuleHandlerMock.mockResolvedValueOnce({ proposal_id: 'rule-uuid-1' });
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
    expect(result).toEqual({ rule_id: 'rule-uuid-1', status: 'pending_review' });
    expect(proposeRuleHandlerMock).toHaveBeenCalledTimes(1);
    const arg = proposeRuleHandlerMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.tipo).toBe('classificacao');
    expect(arg.contexto).toBe('descricao contem "uber"');
    expect(arg.acao).toBe('categoria=transporte');
  });

  it('schema invalid: rejects unknown tipo', async () => {
    const { saveRuleTool } = await import('../../../src/tools/save-rule.js');
    const parsed = saveRuleTool.input_schema.safeParse({
      tipo: 'desconhecida',
      contexto: 'x',
      acao: 'y',
    });
    expect(parsed.success).toBe(false);
    expect(proposeRuleHandlerMock).not.toHaveBeenCalled();
  });

  it('fills default jsonb objects when omitted', async () => {
    proposeRuleHandlerMock.mockResolvedValueOnce({ proposal_id: 'rule-uuid-2' });
    const { saveRuleTool } = await import('../../../src/tools/save-rule.js');
    const parsed = saveRuleTool.input_schema.parse({
      tipo: 'tom_resposta',
      contexto: 'usuario formal',
      acao: 'tom=formal',
    });
    await saveRuleTool.handler(parsed as never, ctx);
    const arg = proposeRuleHandlerMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.contexto_jsonb).toEqual({});
    expect(arg.acoes_jsonb).toEqual({});
  });
});
