import { describe, it, expect, vi, beforeEach } from 'vitest';

const findByWhatsappId = vi.fn();
const conversaById = vi.fn();
const findById = vi.fn();
const findActiveSnapshot = vi.fn();
vi.mock('../../src/db/repositories.js', () => ({
  mensagensRepo: { findByWhatsappId },
  conversasRepo: { byId: conversaById },
  pessoasRepo: { findById },
  pendingQuestionsRepo: { findActiveSnapshot },
}));

const resolveAndDispatch = vi.fn();
vi.mock('../../src/agent/pending-resolver.js', () => ({ resolveAndDispatch }));

const audit = vi.fn();
vi.mock('../../src/governance/audit.js', () => ({ audit }));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  findByWhatsappId.mockReset();
  conversaById.mockReset();
  findById.mockReset();
  findActiveSnapshot.mockReset();
  resolveAndDispatch.mockReset();
  audit.mockReset();
});

const reactionMsg = (emoji: string) => ({
  message: {
    reactionMessage: {
      key: { id: 'WAID-PARENT', remoteJid: 'jid' },
      text: emoji,
    },
  },
}) as never;

describe('dispatchReactionAsAnswer', () => {
  it('maps ✅ to opcoes_validas[0].key and calls resolveAndDispatch', async () => {
    findByWhatsappId.mockResolvedValueOnce({
      id: 'msg-out-1',
      conversa_id: 'c1',
      metadata: { pending_question_id: 'pq-1', whatsapp_id: 'WAID-PARENT' },
    });
    conversaById.mockResolvedValueOnce({ id: 'c1', pessoa_id: 'p1' });
    findById.mockResolvedValueOnce({ id: 'p1' });
    findActiveSnapshot.mockResolvedValueOnce({
      id: 'pq-1',
      opcoes_validas: [{ key: 'sim', label: 'Sim' }, { key: 'nao', label: 'Não' }],
    });
    resolveAndDispatch.mockResolvedValueOnce({ resolved: true });
    const { dispatchReactionAsAnswer } = await import('../../src/agent/one-tap.js');
    await dispatchReactionAsAnswer(reactionMsg('✅'));
    expect(resolveAndDispatch).toHaveBeenCalledWith(expect.objectContaining({
      expected_pending_id: 'pq-1',
      option_chosen: 'sim',
      confidence: 1,
      source: 'reaction',
    }));
  });

  it('maps ❌ to opcoes_validas[1].key', async () => {
    findByWhatsappId.mockResolvedValueOnce({
      id: 'msg-out-1', conversa_id: 'c1',
      metadata: { pending_question_id: 'pq-1', whatsapp_id: 'WAID-PARENT' },
    });
    conversaById.mockResolvedValueOnce({ id: 'c1', pessoa_id: 'p1' });
    findById.mockResolvedValueOnce({ id: 'p1' });
    findActiveSnapshot.mockResolvedValueOnce({
      id: 'pq-1',
      opcoes_validas: [{ key: 'sim', label: 'Sim' }, { key: 'nao', label: 'Não' }],
    });
    resolveAndDispatch.mockResolvedValueOnce({ resolved: true });
    const { dispatchReactionAsAnswer } = await import('../../src/agent/one-tap.js');
    await dispatchReactionAsAnswer(reactionMsg('❌'));
    expect(resolveAndDispatch).toHaveBeenCalledWith(expect.objectContaining({ option_chosen: 'nao' }));
  });

  it('unmapped emoji → audit reaction_ignored_unmapped_emoji, no resolve', async () => {
    findByWhatsappId.mockResolvedValueOnce({
      id: 'msg-out-1', conversa_id: 'c1',
      metadata: { pending_question_id: 'pq-1' },
    });
    const { dispatchReactionAsAnswer } = await import('../../src/agent/one-tap.js');
    await dispatchReactionAsAnswer(reactionMsg('🎉'));
    expect(resolveAndDispatch).not.toHaveBeenCalled();
    expect(audit.mock.calls.some((c) => c[0].acao === 'reaction_ignored_unmapped_emoji')).toBe(true);
  });

  it('parent without pending_question_id → audit one_tap_no_pending_anchor', async () => {
    findByWhatsappId.mockResolvedValueOnce({
      id: 'msg-out-1', conversa_id: 'c1',
      metadata: { whatsapp_id: 'WAID-PARENT' },
    });
    const { dispatchReactionAsAnswer } = await import('../../src/agent/one-tap.js');
    await dispatchReactionAsAnswer(reactionMsg('✅'));
    expect(resolveAndDispatch).not.toHaveBeenCalled();
    expect(audit.mock.calls.some((c) => c[0].acao === 'one_tap_no_pending_anchor')).toBe(true);
  });

  it('non-binary pending → does not handle (3+ opts use poll)', async () => {
    findByWhatsappId.mockResolvedValueOnce({
      id: 'msg-out-1', conversa_id: 'c1',
      metadata: { pending_question_id: 'pq-1' },
    });
    conversaById.mockResolvedValueOnce({ id: 'c1', pessoa_id: 'p1' });
    findById.mockResolvedValueOnce({ id: 'p1' });
    findActiveSnapshot.mockResolvedValueOnce({
      id: 'pq-1',
      opcoes_validas: [
        { key: 'a', label: 'A' }, { key: 'b', label: 'B' }, { key: 'c', label: 'C' },
      ],
    });
    const { dispatchReactionAsAnswer } = await import('../../src/agent/one-tap.js');
    await dispatchReactionAsAnswer(reactionMsg('✅'));
    expect(resolveAndDispatch).not.toHaveBeenCalled();
  });
});
