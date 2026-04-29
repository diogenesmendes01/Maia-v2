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

const MAIA_JID = '5500000000000@s.whatsapp.net';

describe('dispatchPollVote', () => {
  it('decrypts vote with persisted pollCreatorJid, hash-matches a label, dispatches', async () => {
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
        poll_creator_jid: MAIA_JID,
      },
    });
    conversaById.mockResolvedValueOnce({ id: 'c1', pessoa_id: 'p1' });
    findById.mockResolvedValueOnce({ id: 'p1' });
    const hash = createHash('sha256').update('Restaurante').digest();
    decryptPollVote.mockReturnValueOnce({ selectedOptions: [hash] });
    resolveAndDispatch.mockResolvedValueOnce({ resolved: true });
    const { dispatchPollVote } = await import('../../src/agent/one-tap.js');
    await dispatchPollVote(pollUpdateMsg);
    // The HMAC inside Baileys uses `pollCreatorJid` — for polls Maia sent,
    // that's Maia's normalized JID (persisted at send time), NOT the inbound
    // vote's `remoteJid` (which is the user). Asserting the ctx prevents a
    // regression where votes silently fail to decrypt.
    expect(decryptPollVote).toHaveBeenCalledWith(
      expect.objectContaining({ encPayload: expect.anything(), encIv: expect.anything() }),
      expect.objectContaining({
        pollCreatorJid: MAIA_JID,
        pollMsgId: 'WAID-POLL',
        pollEncKey: expect.any(Buffer),
        voterJid: 'jid',
      }),
    );
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

  it('metadata missing poll_creator_jid → audit missing_poll_metadata, no decrypt attempt', async () => {
    findByWhatsappId.mockResolvedValueOnce({
      id: 'out-1', conversa_id: 'c1',
      metadata: {
        pending_question_id: 'pq-1',
        poll_options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }, { key: 'c', label: 'C' }],
        poll_message_secret: Buffer.from('secret').toString('base64'),
        // poll_creator_jid intentionally absent
      },
    });
    const { dispatchPollVote } = await import('../../src/agent/one-tap.js');
    await dispatchPollVote(pollUpdateMsg);
    expect(decryptPollVote).not.toHaveBeenCalled();
    expect(resolveAndDispatch).not.toHaveBeenCalled();
    expect(audit.mock.calls.some(
      (c) => c[0].acao === 'one_tap_dispatch_error' && c[0].metadata?.reason === 'missing_poll_metadata',
    )).toBe(true);
  });

  it('decryption throws → audit one_tap_dispatch_error', async () => {
    findByWhatsappId.mockResolvedValueOnce({
      id: 'out-1', conversa_id: 'c1',
      metadata: {
        pending_question_id: 'pq-1',
        poll_options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }, { key: 'c', label: 'C' }],
        poll_message_secret: Buffer.from('secret').toString('base64'),
        poll_creator_jid: MAIA_JID,
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
        poll_creator_jid: MAIA_JID,
      },
    });
    decryptPollVote.mockReturnValueOnce({ selectedOptions: [Buffer.from('garbage')] });
    const { dispatchPollVote } = await import('../../src/agent/one-tap.js');
    await dispatchPollVote(pollUpdateMsg);
    expect(resolveAndDispatch).not.toHaveBeenCalled();
    expect(audit.mock.calls.some((c) => c[0].acao === 'one_tap_dispatch_error')).toBe(true);
  });
});
