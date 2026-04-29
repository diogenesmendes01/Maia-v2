import { describe, it, expect, vi, beforeEach } from 'vitest';

const insertedRow = { id: 'pq-uuid-1' };
const repoMock = {
  create: vi.fn().mockResolvedValue(insertedRow),
  createTx: vi.fn().mockResolvedValue(insertedRow),
  cancelOpenForConversaTx: vi.fn().mockResolvedValue({ cancelled_ids: [] }),
};
const auditMock = vi.fn();
const withTxMock = vi.fn(async (fn) => fn({} as never));

vi.mock('../../src/db/repositories.js', () => ({
  pendingQuestionsRepo: repoMock,
}));
vi.mock('../../src/db/client.js', () => ({
  withTx: withTxMock,
  db: {} as never,
}));
vi.mock('../../src/governance/audit.js', () => ({ audit: auditMock }));
vi.mock('../../src/config/env.js', () => ({
  config: { PENDING_QUESTION_TTL_MINUTES: 120 },
}));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  repoMock.create.mockClear();
  repoMock.createTx.mockClear();
  repoMock.cancelOpenForConversaTx.mockClear();
  repoMock.cancelOpenForConversaTx.mockResolvedValue({ cancelled_ids: [] });
  auditMock.mockClear();
  withTxMock.mockClear();
});

const ctx = {
  pessoa: { id: 'p1' },
  conversa: { id: 'c1' },
  scope: { entidades: ['e1'], byEntity: new Map() },
  mensagem_id: 'm1',
  request_id: 'r1',
  idempotency_key: 'ik1',
} as never;

describe('ask_pending_question — schema + affirmative-first', () => {
  it('rejects binary opcoes whose first key is not affirmative', async () => {
    const { askPendingQuestionTool } = await import('../../src/tools/ask-pending-question.js');
    const result = await askPendingQuestionTool.handler(
      {
        pergunta: 'Confirma?',
        opcoes_validas: [
          { key: 'cancela', label: 'Cancela' },
          { key: 'sim', label: 'Sim' },
        ],
      } as never,
      ctx,
    );
    expect((result as { error?: string }).error).toBe('binary_options_must_be_affirmative_first');
    expect(repoMock.create).not.toHaveBeenCalled();
  });

  it('accepts canonical "sim/nao" binary', async () => {
    const { askPendingQuestionTool } = await import('../../src/tools/ask-pending-question.js');
    const result = await askPendingQuestionTool.handler(
      {
        pergunta: 'Confirma?',
        opcoes_validas: [
          { key: 'sim', label: 'Sim' },
          { key: 'nao', label: 'Não' },
        ],
      } as never,
      ctx,
    );
    expect((result as { pending_question_id: string }).pending_question_id).toBe('pq-uuid-1');
    expect(repoMock.cancelOpenForConversaTx).toHaveBeenCalledWith(
      expect.anything(),
      'c1',
      'substituted',
    );
    // Insert must go through createTx so it shares the cancel's transaction;
    // the legacy `create` (uses global db pool) must NOT be called.
    expect(repoMock.createTx).toHaveBeenCalled();
    expect(repoMock.create).not.toHaveBeenCalled();
  });

  it('substitutes prior open pending and audits pending_substituted with prior ids', async () => {
    repoMock.cancelOpenForConversaTx.mockResolvedValueOnce({ cancelled_ids: ['old-pq'] });
    const { askPendingQuestionTool } = await import('../../src/tools/ask-pending-question.js');
    await askPendingQuestionTool.handler(
      {
        pergunta: 'Qual categoria?',
        opcoes_validas: [
          { key: 'mercado', label: 'Mercado' },
          { key: 'restaurante', label: 'Restaurante' },
          { key: 'outro', label: 'Outro' },
        ],
      } as never,
      ctx,
    );
    const subs = auditMock.mock.calls.filter((c) => c[0]?.acao === 'pending_substituted');
    expect(subs.length).toBe(1);
    expect(subs[0][0].metadata.cancelled_ids).toEqual(['old-pq']);
  });

  it('does NOT audit pending_created from the handler (dispatcher does it)', async () => {
    const { askPendingQuestionTool } = await import('../../src/tools/ask-pending-question.js');
    await askPendingQuestionTool.handler(
      {
        pergunta: 'Confirma?',
        opcoes_validas: [
          { key: 'sim', label: 'Sim' },
          { key: 'nao', label: 'Não' },
        ],
      } as never,
      ctx,
    );
    const creates = auditMock.mock.calls.filter((c) => c[0]?.acao === 'pending_created');
    expect(creates.length).toBe(0); // dispatcher fires this audit, not the handler
  });
});
