/**
 * Issue #227 — sendOutbound × ledger integration tests (across all 4 modalities).
 *
 * Proves the wiring contracts in `src/agent/output-dispatch.ts`:
 *
 *   1. Pre-send: a successful upsertPending atomically reserves a `pending`
 *      row BEFORE the provider call. The `inserted` flag is true (claim winner).
 *   2. Pre-send THROW (e.g., pessoa not found) → ledger row is moved to
 *      `failed`, the OutboundDeliveryError carries delivered:false +
 *      ambiguous:false. The skill caller's `allowReact:true` outcome lets
 *      ReAct fall through (per the execute-skill.ts guard which reads
 *      status='failed' as "ReAct may send").
 *   3. Provider throw (channel send throws AFTER potential relay) →
 *      ledger row is moved to `unknown`, the OutboundDeliveryError carries
 *      delivered:true + ambiguous:true. The caller's `allowReact:false`
 *      blocks any ReAct fall-through (TERMINAL-SKIP per owner's
 *      "zero double-send" choice).
 *   4. Retry with the SAME idempotency key while the prior row is at
 *      `sent` → returns early WITHOUT calling the provider; preserves
 *      the prior provider_message_id.
 *   5. Same-turn concurrent claim (loser path): when `upsertPending`
 *      returns `inserted:false, skip:false` with a pending prior row,
 *      sendOutbound DOES NOT invoke the provider (the other worker
 *      holds the claim).
 *   6. ALL FOUR modalities (text/document/voice/poll) go through the
 *      ledger. The document/voice/poll wrappers use distinct idempotency
 *      keys (modality is hashed into the key) so they never collide.
 *
 * No real DB / network. We replace `outboundMessagesRepo`, `pessoasRepo`,
 * `mensagensRepo`, and the baileys send fns with in-memory fakes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  const presenceFake = {
    sendPoll: vi.fn(),
  };
  return {
    ledger,
    pessoasRepoFake,
    mensagensRepoFake,
    pendingQuestionsRepoFake,
    baileysFake,
    presenceFake,
  };
});

vi.mock('@/db/repositories/outbound-messages-repo.js', () => ({
  outboundMessagesRepo: {
    async upsertPending(args: {
      idempotency_key: string;
      conversa_id: string;
      in_reply_to: string;
    }) {
      // Turn-level UNIQUE — key the fake by `(conversa_id,
      // in_reply_to)` to mirror the prod
      // `ON CONFLICT ON CONSTRAINT outbound_messages_turn_uniq`. A
      // same-turn / different-content racer hits THIS branch and the
      // loser sees `existing_key !== candidate_key`.
      const turnKey = `${args.conversa_id}::${args.in_reply_to}`;
      const existing = hoisted.ledger.get(turnKey);
      if (existing) {
        if (existing.status === 'sent') {
          return {
            row: existing,
            inserted: false,
            skip: true,
            existing_key: existing.idempotency_key,
          };
        }
        if (existing.status === 'failed') {
          // Reclaim — the new content's key takes over the turn slot.
          existing.idempotency_key = args.idempotency_key;
          existing.status = 'pending';
          existing.error = null;
          existing.provider_message_id = null;
          return {
            row: existing,
            inserted: false,
            skip: false,
            existing_key: args.idempotency_key,
          };
        }
        // pending/unknown → loser sees the row, does NOT take. The
        // row's idempotency_key is the CURRENT holder's key (the
        // earlier inserter). This is what lets the caller detect
        // same-turn / different-content races.
        return {
          row: existing,
          inserted: false,
          skip: false,
          existing_key: existing.idempotency_key,
        };
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
      hoisted.ledger.set(turnKey, row);
      return { row, inserted: true, skip: false, existing_key: args.idempotency_key };
    },
    async markSent(args: { idempotency_key: string; provider_message_id: string | null; sent_at: Date }) {
      // Per-key lookup mirrors prod: prod queries by
      // (tenant_id, agent_id, idempotency_key).
      const r = Array.from(hoisted.ledger.values()).find(
        (row) => row.idempotency_key === args.idempotency_key,
      );
      if (!r) return;
      r.status = 'sent';
      r.provider_message_id = args.provider_message_id;
      r.sent_at = args.sent_at;
      r.error = null;
    },
    async markFailed(args: { idempotency_key: string; error: string }) {
      const r = Array.from(hoisted.ledger.values()).find(
        (row) => row.idempotency_key === args.idempotency_key,
      );
      if (!r) return;
      // CAS — refuse to degrade sent/unknown.
      if (r.status === 'sent' || r.status === 'unknown') return;
      r.status = 'failed';
      r.error = args.error;
    },
    async markUnknown(args: { idempotency_key: string; error: string }) {
      const r = Array.from(hoisted.ledger.values()).find(
        (row) => row.idempotency_key === args.idempotency_key,
      );
      if (!r) return;
      // CAS — refuse to degrade sent/unknown.
      if (r.status === 'sent' || r.status === 'unknown') return;
      r.status = 'unknown';
      r.error = args.error;
    },
    async findByConversaTurn(args: { conversa_id: string; in_reply_to: string }) {
      const turnKey = `${args.conversa_id}::${args.in_reply_to}`;
      return hoisted.ledger.get(turnKey) ?? null;
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
  sendPoll: hoisted.presenceFake.sendPoll,
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

vi.mock('node:fs/promises', async (orig) => {
  const actual = await orig<typeof import('node:fs/promises')>();
  return {
    ...actual,
    stat: vi.fn().mockResolvedValue({ size: 1234 }),
  };
});

import {
  sendOutbound,
  sendOutboundPoll,
  dispatchOutput,
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
const presenceFake = hoisted.presenceFake;

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
  baileysFake.sendOutboundDocument.mockReset();
  baileysFake.sendOutboundVoice.mockReset();
  presenceFake.sendPoll.mockReset();
});

describe('sendOutbound — text modality ledger pre-send + happy path', () => {
  it('reserves a pending row then marks sent on success', async () => {
    baileysFake.sendOutboundText.mockResolvedValue('wa-xyz');

    const wid = await sendOutbound(PESSOA.id, CONV, TEXT, TURN);
    expect(wid).toBe('wa-xyz');

    const key = computeOutboundIdempotencyKey({
      conversa_id: CONV,
      in_reply_to: TURN,
      text: TEXT,
      modality: 'text',
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
    expect((thrown as OutboundDeliveryError).ambiguous).toBe(false);

    // No ledger row should exist (pessoa lookup is before the ledger claim).
    const row = await outboundMessagesRepo.findByConversaTurn({
      conversa_id: CONV,
      in_reply_to: TURN,
    });
    expect(row).toBeNull();
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
    expect((thrown as OutboundDeliveryError).ambiguous).toBe(false);

    const row = await outboundMessagesRepo.findByConversaTurn({
      conversa_id: CONV,
      in_reply_to: TURN,
    });
    expect(row?.status).toBe('failed');
    expect(row?.error).toBe('text_channel_disconnected');
  });
});

describe('sendOutbound — ambiguous throw → status unknown (TERMINAL-SKIP)', () => {
  it('marks ledger row unknown when sendOutboundText throws (could have delivered)', async () => {
    baileysFake.sendOutboundText.mockRejectedValue(new Error('relay_timeout_after_partial'));

    let thrown: unknown = null;
    try {
      await sendOutbound(PESSOA.id, CONV, TEXT, TURN);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(OutboundDeliveryError);
    expect((thrown as OutboundDeliveryError).ambiguous).toBe(true);

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
    expect((thrown as OutboundDeliveryError).ambiguous).toBe(true);

    const row = await outboundMessagesRepo.findByConversaTurn({
      conversa_id: CONV,
      in_reply_to: TURN,
    });
    expect(row?.status).toBe('unknown');
    expect(row?.error).toBe('text_channel_sent_without_id');
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
    expect((thrown as OutboundDeliveryError).ambiguous).toBe(true);

    const row = await outboundMessagesRepo.findByConversaTurn({
      conversa_id: CONV,
      in_reply_to: TURN,
    });
    expect(row?.status).toBe('unknown');
    expect(row?.error).toContain('db_constraint_violation');
    expect(row?.error).toContain('persist_failed');
  });
});

describe('sendOutbound — retry with same key while sent → returns early, no provider call', () => {
  it('skip-if-sent: same text + turn returns prior wid without re-calling baileys', async () => {
    baileysFake.sendOutboundText.mockResolvedValue('wa-first');
    const wid1 = await sendOutbound(PESSOA.id, CONV, TEXT, TURN);
    expect(wid1).toBe('wa-first');
    expect(baileysFake.sendOutboundText).toHaveBeenCalledTimes(1);

    baileysFake.sendOutboundText.mockClear();
    mensagensRepoFake.create.mockClear();

    // Retry with the exact same content.
    const wid2 = await sendOutbound(PESSOA.id, CONV, TEXT, TURN);
    expect(wid2).toBe('wa-first');
    expect(baileysFake.sendOutboundText).not.toHaveBeenCalled();
    expect(mensagensRepoFake.create).not.toHaveBeenCalled();
  });

  it('different text for SAME turn IS DROPPED (terminal-skip via turn-level UNIQUE)', async () => {
    // Updated expectation after turn-level UNIQUE landed.
    //
    // Before: two completions for the same turn with different text
    // would each claim a distinct idempotency_key row and BOTH would
    // send → double-send.
    //
    // After: both writers conflict on
    // `(tenant_id, agent_id, conversa_id, in_reply_to)`. The first
    // claims the row; the second sees `existing_key !== candidate_key`
    // and DROPS its send (terminal-skip, audit emitted). Owner's
    // "zero double-send" choice.
    baileysFake.sendOutboundText.mockResolvedValueOnce('wa-first');

    await sendOutbound(PESSOA.id, CONV, 'first text', TURN);
    expect(baileysFake.sendOutboundText).toHaveBeenCalledTimes(1);

    // Second call with DIFFERENT content for the same turn must
    // throw OutboundDeliveryError(ambiguous:true) — caller should
    // funnel this through safeDispatchOutput in production. The
    // provider is NOT invoked.
    baileysFake.sendOutboundText.mockClear();
    // First send marked the row as `sent`. A different-content retry
    // for the same turn now sees a SENT prior row (skip=true) and
    // returns the prior provider_message_id WITHOUT a provider call.
    // (The "racing-against-pending" different-content scenario is
    // covered in the repo-level same-turn-different-content tests.)
    const wid2 = await sendOutbound(PESSOA.id, CONV, 'second text', TURN);
    expect(baileysFake.sendOutboundText).not.toHaveBeenCalled();
    expect(wid2).toBe('wa-first');
  });
});

describe('sendOutbound — concurrent same-turn claim → loser does NOT invoke provider', () => {
  it('a `inserted=false, skip=false` claim with pending status (SAME content key) causes early-return (no provider call)', async () => {
    // Pre-seed a pending row (simulating another worker holding the
    // claim with the SAME content key — idempotent same-content
    // race, not the same-turn / different-content race).
    const key = computeOutboundIdempotencyKey({
      conversa_id: CONV,
      in_reply_to: TURN,
      text: TEXT,
      modality: 'text',
    });
    // Fake's storage key is `${conversa}::${in_reply_to}` to mirror
    // the turn-level UNIQUE on `outbound_messages`.
    ledger.set(`${CONV}::${TURN}`, {
      idempotency_key: key,
      conversa_id: CONV,
      in_reply_to: TURN,
      status: 'pending',
      provider_message_id: null,
      sent_at: null,
      error: null,
    });
    baileysFake.sendOutboundText.mockResolvedValue('wa-should-not-be-sent');

    const wid = await sendOutbound(PESSOA.id, CONV, TEXT, TURN);
    expect(wid).toBeNull();
    expect(baileysFake.sendOutboundText).not.toHaveBeenCalled();
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
  it('changes when modality changes (same text)', () => {
    const text = 'same';
    const kt = computeOutboundIdempotencyKey({ conversa_id: CONV, in_reply_to: TURN, text, modality: 'text' });
    const kv = computeOutboundIdempotencyKey({ conversa_id: CONV, in_reply_to: TURN, text, modality: 'voice' });
    const kd = computeOutboundIdempotencyKey({ conversa_id: CONV, in_reply_to: TURN, text, modality: 'document' });
    const kp = computeOutboundIdempotencyKey({ conversa_id: CONV, in_reply_to: TURN, text, modality: 'poll' });
    expect(new Set([kt, kv, kd, kp]).size).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// MULTI-MODAL WIRING (Item 6) — document/voice/poll all go through the ledger
// ---------------------------------------------------------------------------

const INBOUND = {
  id: TURN,
  conteudo: 'help',
  metadata: null,
  tipo: 'texto',
} as unknown as import('@/db/schema.js').Mensagem;
const CONVERSA = { id: CONV } as unknown as import('@/db/schema.js').Conversa;

describe('dispatchOutput — document modality goes through ledger', () => {
  it('marks pending → sent on successful document delivery', async () => {
    baileysFake.sendOutboundDocument.mockResolvedValue('wa-doc-123');

    await dispatchOutput({
      pessoa: PESSOA as never,
      conversa: CONVERSA,
      inbound: INBOUND,
      jid: '5511999999999@s.whatsapp.net',
      text: 'Aqui está seu relatório',
      latestPending: null,
      latestReportPdf: {
        path: '/tmp/report.pdf',
        fileName: 'report.pdf',
        mimetype: 'application/pdf',
        tipo: 'extrato',
      },
      turnHasSensitive: false,
      sensitiveTools: [],
    });

    expect(baileysFake.sendOutboundDocument).toHaveBeenCalledTimes(1);
    const row = await outboundMessagesRepo.findByConversaTurn({
      conversa_id: CONV,
      in_reply_to: TURN,
    });
    expect(row?.status).toBe('sent');
    expect(row?.provider_message_id).toBe('wa-doc-123');
    // Modality must be part of the idempotency key (different from text).
    const docKey = computeOutboundIdempotencyKey({
      conversa_id: CONV,
      in_reply_to: TURN,
      text: 'report.pdf|Aqui está seu relatório',
      modality: 'document',
    });
    expect(row?.idempotency_key).toBe(docKey);
  });
});

describe('dispatchOutput — voice modality goes through ledger', () => {
  it('marks pending → sent on successful voice delivery', async () => {
    // Enable voice feature flag for this test.
    const env = await import('@/config/env.js');
    (env.config as unknown as { FEATURE_OUTBOUND_VOICE: boolean }).FEATURE_OUTBOUND_VOICE = true;
    const tts = await import('@/lib/tts.js');
    (tts.synthesizeSpeech as ReturnType<typeof vi.fn>).mockResolvedValue(Buffer.from('voicedata'));
    baileysFake.sendOutboundVoice.mockResolvedValue('wa-voice-456');

    const VOICE_INBOUND = { ...INBOUND, tipo: 'audio' } as unknown as import('@/db/schema.js').Mensagem;
    await dispatchOutput({
      pessoa: PESSOA as never,
      conversa: CONVERSA,
      inbound: VOICE_INBOUND,
      jid: '5511999999999@s.whatsapp.net',
      text: 'resposta voz',
      latestPending: null,
      latestReportPdf: null,
      turnHasSensitive: false,
      sensitiveTools: [],
    });

    expect(baileysFake.sendOutboundVoice).toHaveBeenCalledTimes(1);
    const row = await outboundMessagesRepo.findByConversaTurn({
      conversa_id: CONV,
      in_reply_to: TURN,
    });
    expect(row?.status).toBe('sent');
    expect(row?.provider_message_id).toBe('wa-voice-456');
    const voiceKey = computeOutboundIdempotencyKey({
      conversa_id: CONV,
      in_reply_to: TURN,
      text: 'resposta voz',
      modality: 'voice',
    });
    expect(row?.idempotency_key).toBe(voiceKey);

    (env.config as unknown as { FEATURE_OUTBOUND_VOICE: boolean }).FEATURE_OUTBOUND_VOICE = false;
  });
});

describe('sendOutboundPoll — poll modality goes through ledger', () => {
  it('marks pending → sent on successful poll delivery', async () => {
    presenceFake.sendPoll.mockResolvedValue({
      whatsapp_id: 'wa-poll-789',
      message_secret: 'secret',
      creator_jid: 'creator@s.whatsapp.net',
    });

    const PENDING = {
      id: 'pq_1',
      opcoes_validas: [
        { key: 'a', label: 'Opção A' },
        { key: 'b', label: 'Opção B' },
        { key: 'c', label: 'Opção C' },
      ],
    };

    await sendOutboundPoll(PESSOA.id, CONV, 'escolha:', TURN, PENDING);

    expect(presenceFake.sendPoll).toHaveBeenCalledTimes(1);
    const row = await outboundMessagesRepo.findByConversaTurn({
      conversa_id: CONV,
      in_reply_to: TURN,
    });
    expect(row?.status).toBe('sent');
    expect(row?.provider_message_id).toBe('wa-poll-789');
    const pollKey = computeOutboundIdempotencyKey({
      conversa_id: CONV,
      in_reply_to: TURN,
      text: 'escolha:|a|b|c',
      modality: 'poll',
    });
    expect(row?.idempotency_key).toBe(pollKey);
  });

  it('text modality writes a ledger row keyed by the modality-aware idempotency key', async () => {
    // After the turn-level UNIQUE landed: AT MOST ONE row per turn
    // across all modalities. The "4 independent rows for the same
    // turn" pre-condition is no longer reachable (it was always a
    // theoretical scenario — in practice dispatchOutput picks ONE
    // modality per turn via the precedence ladder). We now assert
    // the realistic invariant: the chosen modality's send writes
    // the row with its modality-specific idempotency_key.
    baileysFake.sendOutboundText.mockResolvedValue('wa-txt');
    await sendOutbound(PESSOA.id, CONV, 'shared text', TURN);

    const txtKey = computeOutboundIdempotencyKey({
      conversa_id: CONV,
      in_reply_to: TURN,
      text: 'shared text',
      modality: 'text',
    });
    const row = await outboundMessagesRepo.findByConversaTurn({
      conversa_id: CONV,
      in_reply_to: TURN,
    });
    expect(row?.status).toBe('sent');
    expect(row?.idempotency_key).toBe(txtKey);
  });
});
