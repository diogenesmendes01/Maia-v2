/**
 * Issue #227 — sendOutbound × ledger integration tests.
 *
 * Proves the wiring contracts in `src/agent/output-dispatch.ts`:
 *
 *   1. Pre-send: a successful upsertPending reserves a `pending` row
 *      BEFORE the provider call.
 *   2. Pre-send THROW (e.g., pessoa not found) → ledger row is moved to
 *      `failed`, the OutboundDeliveryError carries delivered:false, and
 *      a downstream ReAct fall-through is therefore allowed (per the
 *      execute-skill.ts guard which reads status='failed' as
 *      "ReAct may send").
 *   3. Delivered-but-thrown (channel send throws AFTER potential relay)
 *      → ledger row is moved to `unknown`, OutboundDeliveryError
 *      carries delivered:false (the caller-level error tag is the
 *      conservative #216 phase tag), and the per-turn guard would BLOCK
 *      a second ReAct send (status=unknown).
 *   4. Retry with the SAME idempotency key while the prior row is at
 *      `sent` → returns early WITHOUT calling the provider; preserves
 *      the prior provider_message_id.
 *
 * No real DB / network. We replace `outboundMessagesRepo`, `pessoasRepo`,
 * `mensagensRepo`, and the baileys send fns with in-memory fakes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Test doubles wired through vi.mock factories. Hoisted state must be set up
// via vi.hoisted so the factories below can close over it.
// ---------------------------------------------------------------------------
type LedgerRow = {
  idempotency_key: string;
  conversa_id: string;
  in_reply_to: string;
  status: 'pending' | 'sent' | 'failed' | 'unknown';
  provider_message_id: string | null;
  sent_at: Date | null;
  error: string | null;
};

const hoisted = vi.hoisted(() => {
  const ledger = new Map<string, LedgerRow>();
  const pessoasRepoFake = { findById: vi.fn() };
  const mensagensRepoFake = {
    findById: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({}),
  };
  const pendingQuestionsRepoFake = {
    findActiveSnapshot: vi.fn().mockResolvedValue(null),
  };
  const baileysFake = {
    sendOutboundText: vi.fn(),
    sendOutboundDocument: vi.fn(),
    sendOutboundVoice: vi.fn(),
    isBaileysConnected: vi.fn().mockReturnValue(true),
  };
  return { ledger, pessoasRepoFake, mensagensRepoFake, pendingQuestionsRepoFake, baileysFake };
});

vi.mock('@/db/repositories/outbound-messages-repo.js', () => ({
  outboundMessagesRepo: {
    async upsertPending(args: {
      idempotency_key: string;
      conversa_id: string;
      in_reply_to: string;
    }) {
      const existing = hoisted.ledger.get(args.idempotency_key);
      if (existing) {
        return { row: existing, skip: existing.status === 'sent' };
      }
      const row: LedgerRow = {
        idempotency_key: args.idempotency_key,
        conversa_id: args.conversa_id,
        in_reply_to: args.in_reply_to,
        status: 'pending',
        provider_message_id: null,
        sent_at: null,
        error: null,
      };
      hoisted.ledger.set(args.idempotency_key, row);
      return { row, skip: false };
    },
    async markSent(args: { idempotency_key: string; provider_message_id: string | null; sent_at: Date }) {
      const r = hoisted.ledger.get(args.idempotency_key);
      if (!r) return;
      r.status = 'sent';
      r.provider_message_id = args.provider_message_id;
      r.sent_at = args.sent_at;
      r.error = null;
    },
    async markFailed(args: { idempotency_key: string; error: string }) {
      const r = hoisted.ledger.get(args.idempotency_key);
      if (!r) return;
      r.status = 'failed';
      r.error = args.error;
    },
    async markUnknown(args: { idempotency_key: string; error: string }) {
      const r = hoisted.ledger.get(args.idempotency_key);
      if (!r) return;
      r.status = 'unknown';
      r.error = args.error;
    },
    async findByConversaTurn(args: { conversa_id: string; in_reply_to: string }) {
      const matches = Array.from(hoisted.ledger.values()).filter(
        (r) => r.conversa_id === args.conversa_id && r.in_reply_to === args.in_reply_to,
      );
      return matches[matches.length - 1] ?? null;
    },
  },
}));

vi.mock('@/db/repositories.js', () => ({
  pessoasRepo: hoisted.pessoasRepoFake,
  mensagensRepo: hoisted.mensagensRepoFake,
  pendingQuestionsRepo: hoisted.pendingQuestionsRepoFake,
}));

vi.mock('@/gateway/baileys.js', () => hoisted.baileysFake);

vi.mock('@/governance/audit.js', () => ({
  audit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/lib/tts.js', () => ({
  synthesizeSpeech: vi.fn(),
  OUTBOUND_VOICE_MAX_CHARS: 1000,
}));

vi.mock('@/gateway/presence.js', () => ({
  quotedReplyContext: () => undefined,
  sendPoll: vi.fn(),
}));

vi.mock('@/agent/reflection.js', () => ({
  detectCorrection: () => false,
}));

vi.mock('@/agent/pdf-cleanup.js', () => ({
  cleanupPDF: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/config/env.js', () => ({
  config: {
    FEATURE_OUTBOUND_VOICE: false,
    FEATURE_VIEW_ONCE_SENSITIVE: false,
    FEATURE_ONE_TAP: false,
  },
}));

import {
  sendOutbound,
  OutboundDeliveryError,
  computeOutboundIdempotencyKey,
} from '@/agent/output-dispatch.js';
import { outboundMessagesRepo } from '@/db/repositories/outbound-messages-repo.js';

const PESSOA = {
  id: 'p_1',
  telefone_whatsapp: '+5511999999999',
  preferencias: null,
} as unknown as { id: string; telefone_whatsapp: string; preferencias: null };

const CONV = '00000000-0000-0000-0000-000000000001';
const TURN = '00000000-0000-0000-0000-000000000002';
const TEXT = 'olá, tudo bem?';

const ledger = hoisted.ledger;
const pessoasRepoFake = hoisted.pessoasRepoFake;
const mensagensRepoFake = hoisted.mensagensRepoFake;
const baileysFake = hoisted.baileysFake;

beforeEach(() => {
  ledger.clear();
  vi.clearAllMocks();
  pessoasRepoFake.findById.mockReset();
  pessoasRepoFake.findById.mockResolvedValue(PESSOA);
  mensagensRepoFake.findById.mockReset();
  mensagensRepoFake.findById.mockResolvedValue(null);
  mensagensRepoFake.create.mockReset();
  mensagensRepoFake.create.mockResolvedValue({});
  baileysFake.isBaileysConnected.mockReset();
  baileysFake.isBaileysConnected.mockReturnValue(true);
  baileysFake.sendOutboundText.mockReset();
});

describe('sendOutbound — ledger pre-send + happy path', () => {
  it('reserves a pending row then marks sent on success', async () => {
    baileysFake.sendOutboundText.mockResolvedValue('wa-xyz');

    const wid = await sendOutbound(PESSOA.id, CONV, TEXT, TURN);
    expect(wid).toBe('wa-xyz');

    const key = computeOutboundIdempotencyKey({
      conversa_id: CONV,
      in_reply_to: TURN,
      text: TEXT,
    });
    const row = await outboundMessagesRepo.findByConversaTurn({
      conversa_id: CONV,
      in_reply_to: TURN,
    });
    expect(row).not.toBeNull();
    expect(row?.idempotency_key).toBe(key);
    expect(row?.status).toBe('sent');
    expect(row?.provider_message_id).toBe('wa-xyz');
    expect(row?.sent_at).toBeInstanceOf(Date);
    expect(baileysFake.sendOutboundText).toHaveBeenCalledTimes(1);
  });
});

describe('sendOutbound — pre-send throw → status failed (ReAct may send)', () => {
  it('marks ledger row failed when pessoa lookup fails', async () => {
    pessoasRepoFake.findById.mockResolvedValue(null);

    let thrown: unknown = null;
    try {
      await sendOutbound(PESSOA.id, CONV, TEXT, TURN);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(OutboundDeliveryError);
    expect((thrown as OutboundDeliveryError).delivered).toBe(false);

    const row = await outboundMessagesRepo.findByConversaTurn({
      conversa_id: CONV,
      in_reply_to: TURN,
    });
    // Pre-send (delivered:false) ⇒ failed ⇒ a downstream guard would
    // allow ReAct to send because the user got nothing.
    expect(row?.status).toBe('failed');
    expect(row?.error).toBe('pessoa_not_found');
    expect(baileysFake.sendOutboundText).not.toHaveBeenCalled();
  });

  it('marks failed when channel returns null with isBaileysConnected=false', async () => {
    baileysFake.isBaileysConnected.mockReturnValue(false);
    baileysFake.sendOutboundText.mockResolvedValue(null);

    let thrown: unknown = null;
    try {
      await sendOutbound(PESSOA.id, CONV, TEXT, TURN);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(OutboundDeliveryError);
    expect((thrown as OutboundDeliveryError).delivered).toBe(false);

    const row = await outboundMessagesRepo.findByConversaTurn({
      conversa_id: CONV,
      in_reply_to: TURN,
    });
    expect(row?.status).toBe('failed');
    expect(row?.error).toBe('channel_disconnected');
  });
});

describe('sendOutbound — delivered-but-thrown → status unknown (block ReAct)', () => {
  it('marks ledger row unknown when sendOutboundText throws (could have delivered)', async () => {
    baileysFake.sendOutboundText.mockRejectedValue(new Error('relay_timeout_after_partial'));

    let thrown: unknown = null;
    try {
      await sendOutbound(PESSOA.id, CONV, TEXT, TURN);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(OutboundDeliveryError);

    const row = await outboundMessagesRepo.findByConversaTurn({
      conversa_id: CONV,
      in_reply_to: TURN,
    });
    // Provider throw ⇒ unknown (the owner's "zero double-send" choice).
    expect(row?.status).toBe('unknown');
    expect(row?.error).toBe('relay_timeout_after_partial');
  });

  it('marks unknown when channel returns null with connection still alive', async () => {
    baileysFake.isBaileysConnected.mockReturnValue(true);
    baileysFake.sendOutboundText.mockResolvedValue(null);

    let thrown: unknown = null;
    try {
      await sendOutbound(PESSOA.id, CONV, TEXT, TURN);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(OutboundDeliveryError);
    expect((thrown as OutboundDeliveryError).delivered).toBe(true);

    const row = await outboundMessagesRepo.findByConversaTurn({
      conversa_id: CONV,
      in_reply_to: TURN,
    });
    expect(row?.status).toBe('unknown');
    expect(row?.error).toBe('channel_sent_without_id');
  });

  it('marks unknown when mensagens persist throws AFTER successful send', async () => {
    baileysFake.sendOutboundText.mockResolvedValue('wa-xyz');
    mensagensRepoFake.create.mockRejectedValue(new Error('db_constraint_violation'));

    let thrown: unknown = null;
    try {
      await sendOutbound(PESSOA.id, CONV, TEXT, TURN);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(OutboundDeliveryError);
    expect((thrown as OutboundDeliveryError).delivered).toBe(true);

    const row = await outboundMessagesRepo.findByConversaTurn({
      conversa_id: CONV,
      in_reply_to: TURN,
    });
    expect(row?.status).toBe('unknown');
    expect(row?.error).toContain('mensagens_persist_failed');
  });
});

describe('sendOutbound — retry with same key while sent → returns early, no provider call', () => {
  it('skip-if-sent: same text + turn returns prior wid without re-calling baileys', async () => {
    // First call → success → row at status=sent.
    baileysFake.sendOutboundText.mockResolvedValue('wa-first');
    const wid1 = await sendOutbound(PESSOA.id, CONV, TEXT, TURN);
    expect(wid1).toBe('wa-first');
    expect(baileysFake.sendOutboundText).toHaveBeenCalledTimes(1);

    // Reset the spy so we can assert it's NOT called on the retry.
    baileysFake.sendOutboundText.mockClear();
    mensagensRepoFake.create.mockClear();

    // Retry with the exact same content.
    const wid2 = await sendOutbound(PESSOA.id, CONV, TEXT, TURN);
    expect(wid2).toBe('wa-first');
    expect(baileysFake.sendOutboundText).not.toHaveBeenCalled();
    expect(mensagensRepoFake.create).not.toHaveBeenCalled();
  });

  it('different text for SAME turn does NOT skip (different idempotency_key)', async () => {
    baileysFake.sendOutboundText
      .mockResolvedValueOnce('wa-first')
      .mockResolvedValueOnce('wa-second');

    await sendOutbound(PESSOA.id, CONV, 'first text', TURN);
    expect(baileysFake.sendOutboundText).toHaveBeenCalledTimes(1);

    await sendOutbound(PESSOA.id, CONV, 'second text', TURN);
    expect(baileysFake.sendOutboundText).toHaveBeenCalledTimes(2);
  });
});

describe('sendOutbound — idempotency key derivation', () => {
  it('is stable for the same (conversa, turn, text)', () => {
    const k1 = computeOutboundIdempotencyKey({ conversa_id: CONV, in_reply_to: TURN, text: 'hello' });
    const k2 = computeOutboundIdempotencyKey({ conversa_id: CONV, in_reply_to: TURN, text: 'hello' });
    expect(k1).toBe(k2);
  });
  it('changes when text changes', () => {
    const k1 = computeOutboundIdempotencyKey({ conversa_id: CONV, in_reply_to: TURN, text: 'a' });
    const k2 = computeOutboundIdempotencyKey({ conversa_id: CONV, in_reply_to: TURN, text: 'b' });
    expect(k1).not.toBe(k2);
  });
  it('changes when turn changes', () => {
    const k1 = computeOutboundIdempotencyKey({ conversa_id: CONV, in_reply_to: 'turn-a', text: 'x' });
    const k2 = computeOutboundIdempotencyKey({ conversa_id: CONV, in_reply_to: 'turn-b', text: 'x' });
    expect(k1).not.toBe(k2);
  });
});
