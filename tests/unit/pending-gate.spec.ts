import { describe, it, expect, vi, beforeEach } from 'vitest';

const findActiveSnapshot = vi.fn();
const findActiveForUpdate = vi.fn();
const cancelTx = vi.fn();

vi.mock('../../src/db/repositories.js', () => ({
  pendingQuestionsRepo: {
    findActiveSnapshot,
    findActiveForUpdate,
    cancelTx,
  },
}));

const resolveAndDispatch = vi.fn();
vi.mock('../../src/agent/pending-resolver.js', () => ({ resolveAndDispatch }));

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
  cancelTx.mockReset();
  resolveAndDispatch.mockReset();
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
      content: '{"resolves_pending":true,"option_chosen":"sim","confidence":0.95}',
      usage: { input_tokens: 0, output_tokens: 0 },
      tool_uses: [],
      stop_reason: 'end_turn',
      model: 'haiku',
    });
    resolveAndDispatch.mockResolvedValueOnce({ resolved: false, race_lost: true });
    const { checkPendingFirst } = await import('../../src/agent/pending-gate.js');
    const out = await checkPendingFirst({ pessoa, conversa, inbound });
    expect(callLLM).toHaveBeenCalledTimes(1);
    const args = callLLM.mock.calls[0]![0];
    expect(args.messages[0].content).toContain('Confirma?');
    expect(args.messages[0].content).toContain('sim');
    // Per-pessoa cost breakdown: classifier must forward the id so the
    // call shows up under the right pessoa, not just the global aggregate.
    expect(args.pessoa_id).toBe('p1');
    expect(out.kind).toBe('race_lost'); // perna perdedora: desfecho TERMINAL
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
    resolveAndDispatch.mockResolvedValueOnce({
      resolved: true,
      action_tool: 'register_transaction',
    });
    const { checkPendingFirst } = await import('../../src/agent/pending-gate.js');
    const out = await checkPendingFirst({ pessoa, conversa, inbound });
    expect(out.kind).toBe('resolved');
    expect(resolveAndDispatch).toHaveBeenCalledTimes(1);
    expect(resolveAndDispatch.mock.calls[0]![0]).toMatchObject({
      pessoa,
      conversa,
      mensagem_id: 'm1',
      expected_pending_id: 'pq-1',
      option_chosen: 'sim',
      source: 'gate',
    });
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
    const wrongAudit = audit.mock.calls.filter((c) => c[0].acao === 'pending_cancelled');
    expect(wrongAudit.length).toBe(0);
    expect(resolveAndDispatch).not.toHaveBeenCalled();
  });

  it('explicit cancellation cancels with reason "user_cancelled" and audits separately', async () => {
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
    expect(cancelTx).toHaveBeenCalledWith(expect.anything(), 'pq-cancel', 'user_cancelled');
    const audits = audit.mock.calls.filter((c) => c[0].acao === 'pending_cancelled');
    expect(audits.length).toBe(1);
    // Topic-change audit must NOT fire on explicit cancellation.
    const topicAudits = audit.mock.calls.filter(
      (c) => c[0].acao === 'pending_unresolved_topic_change',
    );
    expect(topicAudits.length).toBe(0);
    expect(resolveAndDispatch).not.toHaveBeenCalled();
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
    const { checkPendingFirst } = await import('../../src/agent/pending-gate.js');
    const out = await checkPendingFirst({ pessoa, conversa, inbound });
    expect(out).toEqual({ kind: 'unresolved', reason: 'low_confidence' });
    expect(cancelTx).not.toHaveBeenCalled();
    expect(resolveAndDispatch).not.toHaveBeenCalled();
    const lc = audit.mock.calls.filter((c) => c[0].acao === 'pending_unresolved_low_confidence');
    expect(lc.length).toBe(1);
  });

  it('race-loss na resolução: resolveAndDispatch recusa → race_lost/resolution, NUNCA no_pending', async () => {
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
    resolveAndDispatch.mockResolvedValueOnce({ resolved: false, race_lost: true });
    const { checkPendingFirst } = await import('../../src/agent/pending-gate.js');
    const out = await checkPendingFirst({ pessoa, conversa, inbound });
    // `no_pending` aqui faria o core rodar o turno normal do agente sobre uma
    // mensagem já classificada como resposta à pendência — reinterpretação
    // perigosa num caminho que só existe sob concorrência.
    expect(out).toEqual({ kind: 'race_lost', stage: 'resolution' });
  });
});

describe('pending-gate — races de cancelamento e topic change', () => {
  /** Monta snapshot + classificação e faz o re-check sob lock não achar nada. */
  function armarRacePerdida(classify: string): void {
    findActiveSnapshot.mockResolvedValueOnce({
      id: 'pq-race',
      pergunta: 'Confirma?',
      opcoes_validas: [{ key: 'sim', label: 'Sim' }, { key: 'nao', label: 'Não' }],
      acao_proposta: {},
    });
    callLLM.mockResolvedValueOnce({
      content: classify,
      usage: { input_tokens: 0, output_tokens: 0 },
      tool_uses: [],
      stop_reason: 'end_turn',
      model: 'haiku',
    });
    // Outra perna já resolveu/cancelou a pendência: o SELECT … FOR UPDATE
    // devolve null.
    findActiveForUpdate.mockResolvedValueOnce(null);
  }

  it('cancelamento que perde a race → race_lost/cancellation + audit, sem cancelTx', async () => {
    armarRacePerdida('{"resolves_pending":false,"is_cancellation":true,"confidence":0.95}');
    const { checkPendingFirst } = await import('../../src/agent/pending-gate.js');
    const out = await checkPendingFirst({ pessoa, conversa, inbound });
    // Terminal pelo mesmo motivo da resolução: "cancela" só significa algo
    // amarrado à pendência que já não existe.
    expect(out).toEqual({ kind: 'race_lost', stage: 'cancellation' });
    // Nada a cancelar — a pendência já tinha sumido.
    expect(cancelTx).not.toHaveBeenCalled();
    const raceAudits = audit.mock.calls.filter((c) => c[0].acao === 'pending_race_lost');
    expect(raceAudits.length).toBe(1);
    expect(raceAudits[0]![0].metadata).toMatchObject({
      pending_question_id: 'pq-race',
      source: 'gate',
      stage: 'cancellation',
      observed_id: null,
    });
    // `pending_cancelled` afirmaria que ESTE turno cancelou a pendência.
    expect(audit.mock.calls.filter((c) => c[0].acao === 'pending_cancelled').length).toBe(0);
  });

  it('topic change que perde a race → unresolved/topic_change auditado, NUNCA no_pending', async () => {
    armarRacePerdida('{"resolves_pending":false,"is_topic_change":true,"confidence":0.9}');
    const { checkPendingFirst } = await import('../../src/agent/pending-gate.js');
    const out = await checkPendingFirst({ pessoa, conversa, inbound });
    // NÃO é terminal, e isso é deliberado: o classificador disse que a mensagem
    // não é resposta à pendência, é assunto novo. O significado dela não muda
    // com a race, e o caminho SEM race também devolve unresolved/topic_change —
    // deixá-la seguir para o ReAct é a única leitura possível. O defeito era o
    // `no_pending` (que mente sobre ter havido pendência) e a falta de trilha.
    expect(out).toEqual({ kind: 'unresolved', reason: 'topic_change' });
    expect(cancelTx).not.toHaveBeenCalled();
    const raceAudits = audit.mock.calls.filter((c) => c[0].acao === 'pending_race_lost');
    expect(raceAudits.length).toBe(1);
    expect(raceAudits[0]![0].metadata).toMatchObject({ stage: 'topic_change' });
    // Nada foi cancelado, então o audit de cancelamento por topic change não cabe.
    expect(
      audit.mock.calls.filter((c) => c[0].acao === 'pending_unresolved_topic_change').length,
    ).toBe(0);
  });
});
