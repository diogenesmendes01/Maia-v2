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
