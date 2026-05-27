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
vi.mock('@/gateway/presence.js', () => ({ quotedReplyContext: () => undefined }));
vi.mock('@/agent/reflection.js', () => ({ detectCorrection: () => false }));
vi.mock('@/agent/pdf-cleanup.js', () => ({ cleanupPDF: vi.fn() }));

import { dispatchOutput, OutboundDeliveryError } from '@/agent/output-dispatch.js';

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
  m.sendOutboundText.mockResolvedValue('wid_text');
  m.sendOutboundVoice.mockResolvedValue('wid_voice');
  m.synthesizeSpeech.mockResolvedValue(Buffer.from('ogg'));
  m.createMensagem.mockResolvedValue(undefined);
});

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
});
