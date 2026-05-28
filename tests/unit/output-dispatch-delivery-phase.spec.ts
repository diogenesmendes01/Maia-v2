/**
 * Codex #216 review HIGH-1 — delivery-phase tagging of `dispatchOutput`.
 *
 * The skill-execution caller (execute-skill.ts) decides "fall through to ReAct
 * vs. handled/no-resend" purely from `OutboundDeliveryError.delivered`. These
 * tests prove `dispatchOutput` sets that flag correctly across EVERY phase the
 * skill caller can reach (it passes latestReportPdf/latestPending = null, so the
 * PDF and poll branches are unreachable — quote-lookup, text and voice remain):
 *   - pre-send failure (quote lookup, channel send) → delivered:false
 *     (nothing reached the user → caller may safely fall through to ReAct).
 *   - post-send failure (DB persist after a successful send) → delivered:true
 *     (user already has it → caller must NOT re-send).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pessoa, Conversa, Mensagem } from '@/db/schema.js';

// All doubles live in vi.hoisted so the (hoisted) vi.mock factories can close
// over them without the "cannot access before initialization" trap.
const { cfg, m } = vi.hoisted(() => ({
  cfg: {
    FEATURE_OUTBOUND_VOICE: false,
    FEATURE_VIEW_ONCE_SENSITIVE: false,
    FEATURE_ONE_TAP: false,
  },
  m: {
    sendOutboundText: vi.fn(),
    sendOutboundVoice: vi.fn(),
    sendOutboundDocument: vi.fn(),
    isBaileysConnected: vi.fn(),
    sendPoll: vi.fn(),
    createMensagem: vi.fn(),
    findPessoa: vi.fn(),
    findActiveSnapshot: vi.fn(),
    audit: vi.fn(),
    synthesizeSpeech: vi.fn(),
  },
}));

vi.mock('@/gateway/baileys.js', () => ({
  sendOutboundText: m.sendOutboundText,
  sendOutboundVoice: m.sendOutboundVoice,
  sendOutboundDocument: m.sendOutboundDocument,
  isBaileysConnected: m.isBaileysConnected,
}));
vi.mock('@/db/repositories.js', () => ({
  mensagensRepo: { create: m.createMensagem, findById: vi.fn().mockResolvedValue(null) },
  pessoasRepo: { findById: m.findPessoa },
  pendingQuestionsRepo: { findActiveSnapshot: m.findActiveSnapshot },
}));
vi.mock('@/governance/audit.js', () => ({ audit: m.audit }));
vi.mock('@/config/env.js', () => ({ config: cfg }));
vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/tts.js', () => ({
  synthesizeSpeech: m.synthesizeSpeech,
  OUTBOUND_VOICE_MAX_CHARS: 300,
}));
vi.mock('@/gateway/presence.js', () => ({
  quotedReplyContext: () => undefined,
  sendPoll: m.sendPoll,
}));
vi.mock('@/agent/reflection.js', () => ({ detectCorrection: () => false }));
vi.mock('@/agent/pdf-cleanup.js', () => ({ cleanupPDF: vi.fn() }));

import {
  dispatchOutput,
  safeDispatchOutput,
  OutboundDeliveryError,
} from '@/agent/output-dispatch.js';

const pessoa = { id: 'p_1', telefone_whatsapp: '+5511999999999', preferencias: null } as unknown as Pessoa;
const conversa = { id: 'c_1' } as Conversa;

function mkCtx(overrides?: Partial<Parameters<typeof dispatchOutput>[0]>) {
  return {
    pessoa,
    conversa,
    inbound: { id: 'msg_1', conteudo: 'oi', metadata: null, tipo: 'texto' } as unknown as Mensagem,
    jid: '5511999999999@s.whatsapp.net',
    text: 'Aqui está sua resposta.',
    latestPending: null,
    latestReportPdf: null,
    turnHasSensitive: false,
    sensitiveTools: [],
    ...overrides,
  };
}

const audioInbound = { id: 'msg_1', conteudo: 'oi', metadata: null, tipo: 'audio' } as unknown as Mensagem;

beforeEach(() => {
  vi.clearAllMocks();
  cfg.FEATURE_OUTBOUND_VOICE = false;
  cfg.FEATURE_VIEW_ONCE_SENSITIVE = false;
  cfg.FEATURE_ONE_TAP = false;
  m.findPessoa.mockResolvedValue(pessoa);
  m.findActiveSnapshot.mockResolvedValue(null);
  // Default to DISCONNECTED so a null send id reads as "not sent" (delivered:false);
  // the sent-without-id cases flip this to true explicitly.
  m.isBaileysConnected.mockReturnValue(false);
  m.sendOutboundText.mockResolvedValue('wid_text');
  m.sendOutboundVoice.mockResolvedValue('wid_voice');
  m.sendPoll.mockResolvedValue({
    whatsapp_id: 'wid_poll',
    message_secret: 'secret',
    creator_jid: 'creator_jid',
  });
  m.synthesizeSpeech.mockResolvedValue(Buffer.from('ogg'));
  m.createMensagem.mockResolvedValue(undefined);
});

const pollPending = {
  id: 'pq_1',
  opcoes_validas: [
    { key: 'a', label: 'A' },
    { key: 'b', label: 'B' },
    { key: 'c', label: 'C' },
  ],
};

describe('dispatchOutput — delivery-phase tagging (HIGH-1)', () => {
  it('quote-lookup throws (pre-send) ⇒ OutboundDeliveryError(delivered:false), nothing sent', async () => {
    m.findActiveSnapshot.mockRejectedValue(new Error('db_down'));
    const err = await dispatchOutput(mkCtx()).catch((e) => e);
    expect(err).toBeInstanceOf(OutboundDeliveryError);
    expect((err as OutboundDeliveryError).delivered).toBe(false);
    expect(m.sendOutboundText).not.toHaveBeenCalled();
  });

  it('text channel send throws (pre-send) ⇒ delivered:false (the crux path)', async () => {
    m.sendOutboundText.mockRejectedValue(new Error('socket_closed'));
    const err = await dispatchOutput(mkCtx()).catch((e) => e);
    expect(err).toBeInstanceOf(OutboundDeliveryError);
    expect((err as OutboundDeliveryError).delivered).toBe(false);
    expect(m.createMensagem).not.toHaveBeenCalled(); // never persisted
  });

  it('text sent but DB persist throws (post-send) ⇒ delivered:true (no re-send)', async () => {
    m.sendOutboundText.mockResolvedValue('wid_text');
    m.createMensagem.mockRejectedValue(new Error('persist_failed'));
    const err = await dispatchOutput(mkCtx()).catch((e) => e);
    expect(err).toBeInstanceOf(OutboundDeliveryError);
    expect((err as OutboundDeliveryError).delivered).toBe(true);
    expect(m.sendOutboundText).toHaveBeenCalledOnce(); // sent exactly once
  });

  it('voice channel send throws (pre-send) ⇒ delivered:false', async () => {
    cfg.FEATURE_OUTBOUND_VOICE = true;
    m.sendOutboundVoice.mockRejectedValue(new Error('voice_socket_closed'));
    const err = await dispatchOutput(mkCtx({ inbound: audioInbound })).catch((e) => e);
    expect(err).toBeInstanceOf(OutboundDeliveryError);
    expect((err as OutboundDeliveryError).delivered).toBe(false);
    expect(m.createMensagem).not.toHaveBeenCalled();
  });

  it('voice sent but DB persist throws (post-send) ⇒ delivered:true', async () => {
    cfg.FEATURE_OUTBOUND_VOICE = true;
    m.sendOutboundVoice.mockResolvedValue('wid_voice');
    m.createMensagem.mockRejectedValue(new Error('persist_failed'));
    const err = await dispatchOutput(mkCtx({ inbound: audioInbound })).catch((e) => e);
    expect(err).toBeInstanceOf(OutboundDeliveryError);
    expect((err as OutboundDeliveryError).delivered).toBe(true);
    expect(m.sendOutboundVoice).toHaveBeenCalledOnce();
  });

  it('happy path (text) ⇒ resolves, no error', async () => {
    await expect(dispatchOutput(mkCtx())).resolves.toBeUndefined();
    expect(m.sendOutboundText).toHaveBeenCalledOnce();
    expect(m.createMensagem).toHaveBeenCalledOnce();
  });

  // Codex #216 review (round 2) BLOCKER — a DISCONNECTED gateway makes baileys
  // RETURN null (it does NOT throw). The phase-tagging must convert that null
  // into delivered:false, else HIGH-1's silent drop stays reachable from the
  // skill caller (text + voice) and a phantom whatsapp_id:null row gets written.

  it('text send returns null (gateway disconnected) ⇒ delivered:false, NO phantom persist', async () => {
    m.sendOutboundText.mockResolvedValue(null);
    const err = await dispatchOutput(mkCtx()).catch((e) => e);
    expect(err).toBeInstanceOf(OutboundDeliveryError);
    expect((err as OutboundDeliveryError).delivered).toBe(false);
    expect(m.createMensagem).not.toHaveBeenCalled(); // no whatsapp_id:null row
  });

  it('voice send returns null (gateway disconnected) ⇒ delivered:false, nothing persisted', async () => {
    cfg.FEATURE_OUTBOUND_VOICE = true;
    m.sendOutboundVoice.mockResolvedValue(null);
    const err = await dispatchOutput(mkCtx({ inbound: audioInbound })).catch((e) => e);
    expect(err).toBeInstanceOf(OutboundDeliveryError);
    expect((err as OutboundDeliveryError).delivered).toBe(false);
    expect(m.createMensagem).not.toHaveBeenCalled();
  });

  it('document send returns null (gateway disconnected) ⇒ delivered:false', async () => {
    m.sendOutboundDocument.mockResolvedValue(null);
    const ctx = mkCtx({
      latestReportPdf: {
        path: '/tmp/report.pdf',
        fileName: 'report.pdf',
        mimetype: 'application/pdf',
        tipo: 'extrato',
      },
    });
    const err = await dispatchOutput(ctx).catch((e) => e);
    expect(err).toBeInstanceOf(OutboundDeliveryError);
    expect((err as OutboundDeliveryError).delivered).toBe(false);
    expect(m.createMensagem).not.toHaveBeenCalled();
  });

  // Codex #216 round-3 item 3 — `null` is OVERLOADED: disconnected (not sent)
  // vs sendMessage-resolved-without-key.id (sent, no id). When STILL CONNECTED,
  // a null id means the send most likely happened → delivered:true so the caller
  // does NOT re-send (no double-send), instead of falling through to ReAct.

  it('text send returns null while still CONNECTED (sent-without-id) ⇒ delivered:true, no re-send', async () => {
    m.isBaileysConnected.mockReturnValue(true);
    m.sendOutboundText.mockResolvedValue(null);
    const err = await dispatchOutput(mkCtx()).catch((e) => e);
    expect(err).toBeInstanceOf(OutboundDeliveryError);
    expect((err as OutboundDeliveryError).delivered).toBe(true);
    expect(m.createMensagem).not.toHaveBeenCalled(); // no phantom row
  });

  it('voice send returns null while still CONNECTED (sent-without-id) ⇒ delivered:true', async () => {
    cfg.FEATURE_OUTBOUND_VOICE = true;
    m.isBaileysConnected.mockReturnValue(true);
    m.sendOutboundVoice.mockResolvedValue(null);
    const err = await dispatchOutput(mkCtx({ inbound: audioInbound })).catch((e) => e);
    expect(err).toBeInstanceOf(OutboundDeliveryError);
    expect((err as OutboundDeliveryError).delivered).toBe(true);
  });

  it('pre-send recipient lookup throws ⇒ delivered:false, nothing sent', async () => {
    m.findPessoa.mockRejectedValue(new Error('pessoas_db_down'));
    const err = await dispatchOutput(mkCtx()).catch((e) => e);
    expect(err).toBeInstanceOf(OutboundDeliveryError);
    expect((err as OutboundDeliveryError).delivered).toBe(false);
    expect(m.sendOutboundText).not.toHaveBeenCalled();
  });

  it('recipient not found ⇒ delivered:false, nothing sent', async () => {
    m.findPessoa.mockResolvedValue(null);
    const err = await dispatchOutput(mkCtx()).catch((e) => e);
    expect(err).toBeInstanceOf(OutboundDeliveryError);
    expect((err as OutboundDeliveryError).delivered).toBe(false);
    expect(m.sendOutboundText).not.toHaveBeenCalled();
  });
});

describe('dispatchOutput — PDF + poll phase tagging (Codex #216 round-3)', () => {
  const pdfCtx = () =>
    mkCtx({
      latestReportPdf: {
        path: '/tmp/report.pdf',
        fileName: 'report.pdf',
        mimetype: 'application/pdf',
        tipo: 'extrato',
      },
    });

  it('document send throws (pre-send) ⇒ delivered:false, nothing persisted', async () => {
    m.sendOutboundDocument.mockRejectedValue(new Error('doc_socket_closed'));
    const err = await dispatchOutput(pdfCtx()).catch((e) => e);
    expect(err).toBeInstanceOf(OutboundDeliveryError);
    expect((err as OutboundDeliveryError).delivered).toBe(false);
    expect(m.createMensagem).not.toHaveBeenCalled();
  });

  it('document sent but persist throws (post-send) ⇒ delivered:true', async () => {
    m.sendOutboundDocument.mockResolvedValue('wid_doc');
    m.createMensagem.mockRejectedValue(new Error('persist_failed'));
    const err = await dispatchOutput(pdfCtx()).catch((e) => e);
    expect(err).toBeInstanceOf(OutboundDeliveryError);
    expect((err as OutboundDeliveryError).delivered).toBe(true);
    expect(m.sendOutboundDocument).toHaveBeenCalledOnce();
  });

  it('document returns null while CONNECTED (sent-without-id) ⇒ delivered:true', async () => {
    // After the round-4 fix a connected read-failure THROWS (→ delivered:false,
    // covered above); a connected null can now only mean sent-without-id, so it
    // must be delivered:true (no re-send). A disconnected null stays delivered:false.
    m.isBaileysConnected.mockReturnValue(true);
    m.sendOutboundDocument.mockResolvedValue(null);
    const err = await dispatchOutput(pdfCtx()).catch((e) => e);
    expect(err).toBeInstanceOf(OutboundDeliveryError);
    expect((err as OutboundDeliveryError).delivered).toBe(true);
  });

  it('poll pre-send recipient lookup throws ⇒ delivered:false, poll not sent', async () => {
    cfg.FEATURE_ONE_TAP = true;
    m.findPessoa.mockRejectedValue(new Error('pessoas_db_down'));
    const err = await dispatchOutput(mkCtx({ latestPending: pollPending })).catch((e) => e);
    expect(err).toBeInstanceOf(OutboundDeliveryError);
    expect((err as OutboundDeliveryError).delivered).toBe(false);
    expect(m.sendPoll).not.toHaveBeenCalled();
  });

  it('poll send throws (pre-send) ⇒ delivered:false', async () => {
    cfg.FEATURE_ONE_TAP = true;
    m.sendPoll.mockRejectedValue(new Error('poll_socket_closed'));
    const err = await dispatchOutput(mkCtx({ latestPending: pollPending })).catch((e) => e);
    expect(err).toBeInstanceOf(OutboundDeliveryError);
    expect((err as OutboundDeliveryError).delivered).toBe(false);
    expect(m.createMensagem).not.toHaveBeenCalled();
  });

  it('poll sent but persist throws (post-send) ⇒ delivered:true', async () => {
    cfg.FEATURE_ONE_TAP = true;
    m.createMensagem.mockRejectedValue(new Error('persist_failed'));
    const err = await dispatchOutput(mkCtx({ latestPending: pollPending })).catch((e) => e);
    expect(err).toBeInstanceOf(OutboundDeliveryError);
    expect((err as OutboundDeliveryError).delivered).toBe(true);
    expect(m.sendPoll).toHaveBeenCalledOnce();
  });

  it('poll happy path ⇒ resolves, persisted once', async () => {
    cfg.FEATURE_ONE_TAP = true;
    await expect(
      dispatchOutput(mkCtx({ latestPending: pollPending })),
    ).resolves.toBeUndefined();
    expect(m.sendPoll).toHaveBeenCalledOnce();
    expect(m.createMensagem).toHaveBeenCalledOnce();
  });
});

describe('safeDispatchOutput — centralised, never-throwing wrapper (HIGH-1)', () => {
  it('happy path ⇒ { status: "delivered" }, no failure audit', async () => {
    const out = await safeDispatchOutput(mkCtx());
    expect(out).toEqual({ status: 'delivered' });
    expect(m.audit).not.toHaveBeenCalledWith(
      expect.objectContaining({ acao: 'outbound_dispatch_failed' }),
    );
  });

  it('disconnected gateway (text null) ⇒ not_sent + failure audit (phase pre_send), no phantom row', async () => {
    m.sendOutboundText.mockResolvedValue(null);
    const out = await safeDispatchOutput(mkCtx());
    expect(out).toMatchObject({ status: 'not_sent' });
    expect(m.createMensagem).not.toHaveBeenCalled();
    expect(m.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        acao: 'outbound_dispatch_failed',
        metadata: expect.objectContaining({
          phase: 'pre_send',
          delivered: false,
          idempotency_key: 'c_1:msg_1',
        }),
      }),
    );
  });

  it('post-send persist failure ⇒ sent_no_persist + failure audit (phase post_send), no re-send', async () => {
    m.sendOutboundText.mockResolvedValue('wid_text');
    m.createMensagem.mockRejectedValue(new Error('persist_failed'));
    const out = await safeDispatchOutput(mkCtx());
    expect(out).toMatchObject({ status: 'sent_no_persist' });
    expect(m.sendOutboundText).toHaveBeenCalledOnce();
    expect(m.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        acao: 'outbound_dispatch_failed',
        metadata: expect.objectContaining({ phase: 'post_send', delivered: true }),
      }),
    );
  });
});
