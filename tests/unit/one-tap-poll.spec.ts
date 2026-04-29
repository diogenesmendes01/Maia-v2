import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

const findByWhatsappId = vi.fn();
const conversaById = vi.fn();
const findById = vi.fn();
vi.mock('../../src/db/repositories.js', () => ({
  mensagensRepo: { findByWhatsappId },
  conversasRepo: { byId: conversaById },
  pessoasRepo: { findById },
  pendingQuestionsRepo: { findActiveSnapshot: vi.fn() },
}));

const resolveAndDispatch = vi.fn();
vi.mock('../../src/agent/pending-resolver.js', () => ({ resolveAndDispatch }));

const audit = vi.fn();
vi.mock('../../src/governance/audit.js', () => ({ audit }));

const decryptPollVote = vi.fn();
vi.mock('@whiskeysockets/baileys', () => ({ decryptPollVote }));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  findByWhatsappId.mockReset();
  conversaById.mockReset();
  findById.mockReset();
  resolveAndDispatch.mockReset();
  decryptPollVote.mockReset();
  audit.mockReset();
});

const pollUpdateMsg = {
  key: { remoteJid: 'jid', participant: undefined },
  message: {
    pollUpdateMessage: {
      pollCreationMessageKey: { id: 'WAID-POLL', remoteJid: 'jid' },
      vote: { encPayload: Buffer.from([1, 2]), encIv: Buffer.from([3, 4]) },
    },
  },
} as never;

describe('dispatchPollVote', () => {
  it('decrypts vote, hash-matches a label, calls resolveAndDispatch', async () => {
    findByWhatsappId.mockResolvedValueOnce({
      id: 'out-1', conversa_id: 'c1',
      metadata: {
        pending_question_id: 'pq-1',
        poll_options: [
          { key: 'mercado', label: 'Mercado' },
          { key: 'restaurante', label: 'Restaurante' },
          { key: 'outro', label: 'Outro' },
        ],
        poll_message_secret: Buffer.from('secret').toString('base64'),
      },
    });
    conversaById.mockResolvedValueOnce({ id: 'c1', pessoa_id: 'p1' });
    findById.mockResolvedValueOnce({ id: 'p1' });
    const hash = createHash('sha256').update('Restaurante').digest();
    decryptPollVote.mockReturnValueOnce({ selectedOptions: [hash] });
    resolveAndDispatch.mockResolvedValueOnce({ resolved: true });
    const { dispatchPollVote } = await import('../../src/agent/one-tap.js');
    await dispatchPollVote(pollUpdateMsg);
    expect(resolveAndDispatch).toHaveBeenCalledWith(expect.objectContaining({
      expected_pending_id: 'pq-1',
      option_chosen: 'restaurante',
      confidence: 1,
      source: 'poll_vote',
    }));
  });

  it('parent without pending_question_id → audit no_pending_anchor', async () => {
    findByWhatsappId.mockResolvedValueOnce({
      id: 'out-1', conversa_id: 'c1',
      metadata: { whatsapp_id: 'WAID-POLL' },
    });
    const { dispatchPollVote } = await import('../../src/agent/one-tap.js');
    await dispatchPollVote(pollUpdateMsg);
    expect(resolveAndDispatch).not.toHaveBeenCalled();
    expect(audit.mock.calls.some((c) => c[0].acao === 'one_tap_no_pending_anchor')).toBe(true);
  });

  it('decryption throws → audit one_tap_dispatch_error', async () => {
    findByWhatsappId.mockResolvedValueOnce({
      id: 'out-1', conversa_id: 'c1',
      metadata: {
        pending_question_id: 'pq-1',
        poll_options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }, { key: 'c', label: 'C' }],
        poll_message_secret: Buffer.from('secret').toString('base64'),
      },
    });
    decryptPollVote.mockImplementationOnce(() => { throw new Error('decrypt failed'); });
    const { dispatchPollVote } = await import('../../src/agent/one-tap.js');
    await dispatchPollVote(pollUpdateMsg);
    expect(resolveAndDispatch).not.toHaveBeenCalled();
    expect(audit.mock.calls.some((c) => c[0].acao === 'one_tap_dispatch_error')).toBe(true);
  });

  it('hash matches no label → audit one_tap_dispatch_error', async () => {
    findByWhatsappId.mockResolvedValueOnce({
      id: 'out-1', conversa_id: 'c1',
      metadata: {
        pending_question_id: 'pq-1',
        poll_options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }, { key: 'c', label: 'C' }],
        poll_message_secret: Buffer.from('secret').toString('base64'),
      },
    });
    decryptPollVote.mockReturnValueOnce({ selectedOptions: [Buffer.from('garbage')] });
    const { dispatchPollVote } = await import('../../src/agent/one-tap.js');
    await dispatchPollVote(pollUpdateMsg);
    expect(resolveAndDispatch).not.toHaveBeenCalled();
    expect(audit.mock.calls.some((c) => c[0].acao === 'one_tap_dispatch_error')).toBe(true);
  });
});
