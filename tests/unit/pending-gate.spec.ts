import { describe, it, expect, vi, beforeEach } from 'vitest';

const findActiveSnapshot = vi.fn();
const findActiveForUpdate = vi.fn();
const resolveTx = vi.fn();
const cancelTx = vi.fn();

vi.mock('../../src/db/repositories.js', () => ({
  pendingQuestionsRepo: {
    findActiveSnapshot,
    findActiveForUpdate,
    resolveTx,
    cancelTx,
  },
}));

const callLLM = vi.fn();
vi.mock('../../src/lib/claude.js', () => ({ callLLM }));

const withTx = vi.fn(async (fn) => fn({} as never));
vi.mock('../../src/db/client.js', () => ({ withTx, db: {} as never }));

const audit = vi.fn();
vi.mock('../../src/governance/audit.js', () => ({ audit }));

vi.mock('../../src/config/env.js', () => ({
  config: { FEATURE_PENDING_GATE: true },
}));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const pessoa = { id: 'p1' } as never;
const conversa = { id: 'c1' } as never;
const inbound = { id: 'm1', conteudo: 'sim' } as never;

beforeEach(() => {
  findActiveSnapshot.mockReset();
  findActiveForUpdate.mockReset();
  resolveTx.mockReset();
  cancelTx.mockReset();
  callLLM.mockReset();
  audit.mockReset();
});

describe('pending-gate — snapshot path', () => {
  it('returns no_pending when there is no active row', async () => {
    findActiveSnapshot.mockResolvedValueOnce(null);
    const { checkPendingFirst } = await import('../../src/agent/pending-gate.js');
    const out = await checkPendingFirst({ pessoa, conversa, inbound });
    expect(out).toEqual({ kind: 'no_pending' });
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('calls Haiku with pergunta + opcoes_validas + inbound conteudo', async () => {
    findActiveSnapshot.mockResolvedValueOnce({
      id: 'pq-1',
      pergunta: 'Confirma?',
      opcoes_validas: [{ key: 'sim', label: 'Sim' }, { key: 'nao', label: 'Não' }],
      acao_proposta: { tool: 'register_transaction', args: { valor: 50 } },
    });
    callLLM.mockResolvedValueOnce({
      content: '{"resolves_pending":false,"confidence":0.4}',
      usage: { input_tokens: 0, output_tokens: 0 },
      tool_uses: [],
      stop_reason: 'end_turn',
      model: 'haiku',
    });
    findActiveForUpdate.mockResolvedValueOnce(null); // simulate someone else won
    const { checkPendingFirst } = await import('../../src/agent/pending-gate.js');
    const out = await checkPendingFirst({ pessoa, conversa, inbound });
    expect(callLLM).toHaveBeenCalledTimes(1);
    const args = callLLM.mock.calls[0]![0];
    expect(args.messages[0].content).toContain('Confirma?');
    expect(args.messages[0].content).toContain('sim');
    expect(out.kind).toBe('no_pending'); // re-check failed → no_pending
  });
});

describe('pending-gate — resolve path', () => {
  it('resolves and dispatches when classify succeeds and re-check finds the row', async () => {
    findActiveSnapshot.mockResolvedValueOnce({
      id: 'pq-1',
      pergunta: 'Confirma?',
      opcoes_validas: [{ key: 'sim', label: 'Sim' }, { key: 'nao', label: 'Não' }],
      acao_proposta: { tool: 'register_transaction', args: { valor: 50 } },
    });
    callLLM.mockResolvedValueOnce({
      content: '{"resolves_pending":true,"option_chosen":"sim","confidence":0.95}',
      usage: { input_tokens: 0, output_tokens: 0 },
      tool_uses: [],
      stop_reason: 'end_turn',
      model: 'haiku',
    });
    findActiveForUpdate.mockResolvedValueOnce({
      id: 'pq-1',
      acao_proposta: { tool: 'register_transaction', args: { valor: 50 } },
    });
    resolveTx.mockResolvedValueOnce(undefined);
    const { checkPendingFirst } = await import('../../src/agent/pending-gate.js');
    const out = await checkPendingFirst({ pessoa, conversa, inbound });
    expect(out.kind).toBe('resolved');
    if (out.kind === 'resolved') {
      expect(out.option_chosen).toBe('sim');
      expect(out.action).toEqual({ tool: 'register_transaction', args: { valor: 50 } });
    }
    expect(resolveTx).toHaveBeenCalled();
  });

  it('topic change cancels the row with reason "topic_change" and audits accordingly', async () => {
    findActiveSnapshot.mockResolvedValueOnce({
      id: 'pq-2',
      pergunta: 'Confirma?',
      opcoes_validas: [{ key: 'sim', label: 'Sim' }, { key: 'nao', label: 'Não' }],
      acao_proposta: {},
    });
    callLLM.mockResolvedValueOnce({
      content: '{"resolves_pending":false,"is_topic_change":true,"confidence":0.9}',
      usage: { input_tokens: 0, output_tokens: 0 },
      tool_uses: [],
      stop_reason: 'end_turn',
      model: 'haiku',
    });
    findActiveForUpdate.mockResolvedValueOnce({ id: 'pq-2', acao_proposta: {} });
    cancelTx.mockResolvedValueOnce(undefined);
    const { checkPendingFirst } = await import('../../src/agent/pending-gate.js');
    const out = await checkPendingFirst({ pessoa, conversa, inbound });
    expect(out).toEqual({ kind: 'unresolved', reason: 'topic_change' });
    expect(cancelTx).toHaveBeenCalledWith(expect.anything(), 'pq-2', 'topic_change');
    const audits = audit.mock.calls.filter((c) => c[0].acao === 'pending_unresolved_topic_change');
    expect(audits.length).toBe(1);
    // Cancellation must NOT be audited under topic_change.
    const wrongAudit = audit.mock.calls.filter((c) => c[0].acao === 'pending_unresolved_cancelled');
    expect(wrongAudit.length).toBe(0);
  });

  it('explicit cancellation cancels with reason "cancelled" and audits separately', async () => {
    findActiveSnapshot.mockResolvedValueOnce({
      id: 'pq-cancel',
      pergunta: 'Confirma?',
      opcoes_validas: [{ key: 'sim', label: 'Sim' }, { key: 'nao', label: 'Não' }],
      acao_proposta: {},
    });
    callLLM.mockResolvedValueOnce({
      content: '{"resolves_pending":false,"is_cancellation":true,"confidence":0.95}',
      usage: { input_tokens: 0, output_tokens: 0 },
      tool_uses: [],
      stop_reason: 'end_turn',
      model: 'haiku',
    });
    findActiveForUpdate.mockResolvedValueOnce({ id: 'pq-cancel', acao_proposta: {} });
    cancelTx.mockResolvedValueOnce(undefined);
    const { checkPendingFirst } = await import('../../src/agent/pending-gate.js');
    const out = await checkPendingFirst({ pessoa, conversa, inbound });
    expect(out).toEqual({ kind: 'unresolved', reason: 'cancelled' });
    expect(cancelTx).toHaveBeenCalledWith(expect.anything(), 'pq-cancel', 'cancelled');
    const audits = audit.mock.calls.filter((c) => c[0].acao === 'pending_unresolved_cancelled');
    expect(audits.length).toBe(1);
    // Topic-change audit must NOT fire on explicit cancellation.
    const topicAudits = audit.mock.calls.filter(
      (c) => c[0].acao === 'pending_unresolved_topic_change',
    );
    expect(topicAudits.length).toBe(0);
  });

  it('low confidence: no DB write, audits pending_unresolved_low_confidence', async () => {
    findActiveSnapshot.mockResolvedValueOnce({
      id: 'pq-3',
      pergunta: 'Confirma?',
      opcoes_validas: [{ key: 'sim', label: 'Sim' }, { key: 'nao', label: 'Não' }],
      acao_proposta: {},
    });
    callLLM.mockResolvedValueOnce({
      content: '{"resolves_pending":false,"confidence":0.4}',
      usage: { input_tokens: 0, output_tokens: 0 },
      tool_uses: [],
      stop_reason: 'end_turn',
      model: 'haiku',
    });
    findActiveForUpdate.mockResolvedValueOnce({ id: 'pq-3', acao_proposta: {} });
    const { checkPendingFirst } = await import('../../src/agent/pending-gate.js');
    const out = await checkPendingFirst({ pessoa, conversa, inbound });
    expect(out).toEqual({ kind: 'unresolved', reason: 'low_confidence' });
    expect(resolveTx).not.toHaveBeenCalled();
    expect(cancelTx).not.toHaveBeenCalled();
    const lc = audit.mock.calls.filter((c) => c[0].acao === 'pending_unresolved_low_confidence');
    expect(lc.length).toBe(1);
  });

  it('race-loss: re-check returns null → race_lost audit + no_pending', async () => {
    findActiveSnapshot.mockResolvedValueOnce({
      id: 'pq-4',
      pergunta: 'Confirma?',
      opcoes_validas: [{ key: 'sim', label: 'Sim' }, { key: 'nao', label: 'Não' }],
      acao_proposta: {},
    });
    callLLM.mockResolvedValueOnce({
      content: '{"resolves_pending":true,"option_chosen":"sim","confidence":0.95}',
      usage: { input_tokens: 0, output_tokens: 0 },
      tool_uses: [],
      stop_reason: 'end_turn',
      model: 'haiku',
    });
    findActiveForUpdate.mockResolvedValueOnce(null);
    const { checkPendingFirst } = await import('../../src/agent/pending-gate.js');
    const out = await checkPendingFirst({ pessoa, conversa, inbound });
    expect(out).toEqual({ kind: 'no_pending' });
    const lost = audit.mock.calls.filter((c) => c[0].acao === 'pending_race_lost');
    expect(lost.length).toBe(1);
    expect(lost[0][0].metadata.pending_question_id).toBe('pq-4');
  });
});
