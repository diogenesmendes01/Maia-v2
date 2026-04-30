import { describe, it, expect, vi, beforeEach } from 'vitest';

const { flagState, dbState } = vi.hoisted(() => ({
  flagState: {
    FEATURE_OUTBOUND_VOICE: true,
    FEATURE_VIEW_ONCE_SENSITIVE: false,
    FEATURE_ONE_TAP: false,
    FEATURE_PENDING_GATE: false,
    FEATURE_PDF_REPORTS: false,
  },
  dbState: { conversaResult: [] as unknown[] },
}));

const sendOutboundText = vi.fn();
const sendOutboundDocument = vi.fn();
const sendOutboundVoice = vi.fn();
const findById = vi.fn();
const audit = vi.fn();
const createMensagem = vi.fn();
const findMensagem = vi.fn();
const markProcessed = vi.fn();
const recentInConversation = vi.fn();
const dispatchTool = vi.fn();
const callLLM = vi.fn();
const buildPrompt = vi.fn();
const synthesizeSpeech = vi.fn();

vi.mock('../../src/gateway/baileys.js', () => ({
  sendOutboundText, sendOutboundDocument, sendOutboundVoice,
  isBaileysConnected: () => true,
}));
vi.mock('../../src/lib/tts.js', () => ({
  synthesizeSpeech,
  OUTBOUND_VOICE_MAX_CHARS: 400,
}));
vi.mock('../../src/db/repositories.js', () => ({
  pessoasRepo: { findById },
  mensagensRepo: {
    create: createMensagem, findById: findMensagem, markProcessed,
    recentInConversation, setConversaId: vi.fn(), createInbound: vi.fn(),
  },
  pendingQuestionsRepo: { findActiveSnapshot: vi.fn() },
  conversasRepo: { touch: vi.fn() },
  selfStateRepo: { getActive: vi.fn().mockResolvedValue(null) },
  factsRepo: { listForScopes: vi.fn().mockResolvedValue([]) },
  rulesRepo: { listActive: vi.fn().mockResolvedValue([]) },
  entityStatesRepo: { byId: vi.fn().mockResolvedValue(null) },
  entidadesRepo: { byIds: vi.fn().mockResolvedValue([]) },
}));
vi.mock('../../src/db/client.js', () => {
  const fakeQuery = {
    from: () => fakeQuery, innerJoin: () => fakeQuery, where: () => fakeQuery,
    limit: () => Promise.resolve(dbState.conversaResult),
  };
  return { db: { select: () => fakeQuery }, withTx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})) };
});
vi.mock('../../src/db/schema.js', () => ({ conversas: {}, pessoas: {} }));
vi.mock('drizzle-orm', () => ({ eq: () => ({}) }));
vi.mock('../../src/governance/audit.js', () => ({ audit }));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../../src/config/env.js', () => ({
  config: new Proxy({} as Record<string, unknown>, {
    get(_t, prop) {
      if (prop === 'FEATURE_OUTBOUND_VOICE') return flagState.FEATURE_OUTBOUND_VOICE;
      if (prop === 'FEATURE_VIEW_ONCE_SENSITIVE') return flagState.FEATURE_VIEW_ONCE_SENSITIVE;
      if (prop === 'FEATURE_ONE_TAP') return flagState.FEATURE_ONE_TAP;
      if (prop === 'FEATURE_PENDING_GATE') return flagState.FEATURE_PENDING_GATE;
      if (prop === 'FEATURE_PDF_REPORTS') return flagState.FEATURE_PDF_REPORTS;
      if (prop === 'OWNER_TELEFONE_WHATSAPP') return '+5511999999999';
      return undefined;
    },
  }),
}));
vi.mock('../../src/tools/_dispatcher.js', () => ({ dispatchTool }));
vi.mock('../../src/lib/claude.js', () => ({ callLLM }));
vi.mock('../../src/agent/prompt-builder.js', () => ({
  buildPrompt, PROMPT_TOKEN_BUDGET_INPUT: 11000, PROMPT_TOKEN_BUDGET_OUTPUT: 1024,
}));
vi.mock('../../src/agent/pending-gate.js', () => ({
  checkPendingFirst: vi.fn().mockResolvedValue({ kind: 'no_pending' }),
}));
vi.mock('../../src/identity/resolver.js', () => ({ resolveIdentity: vi.fn() }));
vi.mock('../../src/identity/quarantine.js', () => ({
  handleQuarantineFirstContact: vi.fn(), handleOwnerIdentityReply: vi.fn(),
}));
vi.mock('../../src/governance/permissions.js', () => ({
  resolveScope: vi.fn().mockResolvedValue({ entidades: [], byEntity: new Map() }),
}));
vi.mock('../../src/gateway/rate-limit.js', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ kind: 'allow' }),
  formatPoliteReply: vi.fn(),
}));
vi.mock('../../src/gateway/presence.js', () => ({
  startTyping: vi.fn(() => ({ stop: vi.fn() })),
  sendReaction: vi.fn(), quotedReplyContext: vi.fn(), sendPoll: vi.fn(),
}));
vi.mock('../../src/workflows/pending-questions.js', () => ({
  getActivePending: vi.fn().mockReturnValue(null),
}));
vi.mock('../../src/agent/reflection.js', () => ({
  detectCorrection: vi.fn().mockReturnValue(false),
  reflectOnCorrection: vi.fn(), findPreviousAssistantMessage: vi.fn(),
}));

const PESSOA = {
  id: 'p1', telefone_whatsapp: '+5511888888888', nome: 'Owner',
  tipo: 'owner', preferencias: {},
} as never;
const CONVERSA = { id: 'c1', pessoa_id: 'p1', status: 'ativa' } as never;
const VOICE_INBOUND = {
  id: 'in1', conversa_id: 'c1', direcao: 'in' as const, tipo: 'audio' as const,
  conteudo: '[transcribed: registra cinco reais do café]',
  metadata: { whatsapp_id: 'WAID-IN' }, processada_em: null,
};
const TEXT_INBOUND = {
  id: 'in1', conversa_id: 'c1', direcao: 'in' as const, tipo: 'texto' as const,
  conteudo: 'registra cinco reais', metadata: { whatsapp_id: 'WAID-IN' },
  processada_em: null,
};

describe('agent loop — B4 voice flow', () => {
  beforeEach(() => {
    callLLM.mockReset();
    dispatchTool.mockReset();
    sendOutboundText.mockReset();
    sendOutboundDocument.mockReset();
    sendOutboundVoice.mockReset();
    audit.mockReset();
    createMensagem.mockReset();
    findById.mockReset();
    findMensagem.mockReset();
    markProcessed.mockReset();
    recentInConversation.mockReset().mockResolvedValue([]);
    synthesizeSpeech.mockReset();
    buildPrompt.mockResolvedValue({ system: 's', messages: [] });
    findById.mockResolvedValue(PESSOA);
    sendOutboundVoice.mockResolvedValue('WAID-OUT-VOICE');
    sendOutboundText.mockResolvedValue('WAID-OUT-TEXT');
    dbState.conversaResult = [{ conversas: CONVERSA, pessoas: PESSOA }];
    flagState.FEATURE_OUTBOUND_VOICE = true;
  });

  it('voice-in + flag on + reply ≤400 chars → calls sendOutboundVoice + audit + mensagens row', async () => {
    findMensagem.mockResolvedValue({ ...VOICE_INBOUND });
    callLLM.mockResolvedValueOnce({
      content: '✅ R$ 5 registrado em transporte.', tool_uses: [],
      usage: { input_tokens: 50, output_tokens: 10 },
    });
    synthesizeSpeech.mockResolvedValueOnce(Buffer.from([0x4F, 0x67, 0x67, 0x53, 0x00]));
    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');

    expect(synthesizeSpeech).toHaveBeenCalledWith('✅ R$ 5 registrado em transporte.');
    expect(sendOutboundVoice).toHaveBeenCalledTimes(1);
    expect(sendOutboundText).not.toHaveBeenCalled();

    const auditAcoes = audit.mock.calls.map((c) => c[0].acao);
    expect(auditAcoes).toContain('outbound_sent_voice');
    const voiceAudit = audit.mock.calls.find((c) => c[0].acao === 'outbound_sent_voice')![0];
    expect(voiceAudit.metadata).toEqual(expect.objectContaining({
      whatsapp_id: 'WAID-OUT-VOICE',
      char_count: '✅ R$ 5 registrado em transporte.'.length,
      byte_size: 5,
    }));

    const audioRow = createMensagem.mock.calls.find((c) => c[0].tipo === 'audio')?.[0];
    expect(audioRow).toBeDefined();
    expect(audioRow.midia_url).toBeNull();
    expect(audioRow.metadata.voice).toBe('nova');
  });

  it('voice-in + flag on + reply >400 chars → text path; no voice call', async () => {
    findMensagem.mockResolvedValue({ ...VOICE_INBOUND });
    const longText = 'a'.repeat(500);
    callLLM.mockResolvedValueOnce({
      content: longText, tool_uses: [],
      usage: { input_tokens: 50, output_tokens: 100 },
    });
    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');
    expect(synthesizeSpeech).not.toHaveBeenCalled();
    expect(sendOutboundVoice).not.toHaveBeenCalled();
    expect(sendOutboundText).toHaveBeenCalledTimes(1);
    const auditAcoes = audit.mock.calls.map((c) => c[0].acao);
    expect(auditAcoes).not.toContain('outbound_sent_voice');
  });

  it('text-in + flag on + reply short → text path; no voice call', async () => {
    findMensagem.mockResolvedValue({ ...TEXT_INBOUND });
    callLLM.mockResolvedValueOnce({
      content: 'reply curto', tool_uses: [],
      usage: { input_tokens: 50, output_tokens: 10 },
    });
    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');
    expect(synthesizeSpeech).not.toHaveBeenCalled();
    expect(sendOutboundVoice).not.toHaveBeenCalled();
    expect(sendOutboundText).toHaveBeenCalledTimes(1);
  });

  it('voice-in + flag OFF → text path; synthesizeSpeech never called', async () => {
    flagState.FEATURE_OUTBOUND_VOICE = false;
    findMensagem.mockResolvedValue({ ...VOICE_INBOUND });
    callLLM.mockResolvedValueOnce({
      content: 'reply', tool_uses: [],
      usage: { input_tokens: 50, output_tokens: 5 },
    });
    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');
    expect(synthesizeSpeech).not.toHaveBeenCalled();
    expect(sendOutboundVoice).not.toHaveBeenCalled();
    expect(sendOutboundText).toHaveBeenCalledTimes(1);
  });

  it('TTS failure → text fallback; no voice audit; warn log', async () => {
    findMensagem.mockResolvedValue({ ...VOICE_INBOUND });
    callLLM.mockResolvedValueOnce({
      content: 'reply curto', tool_uses: [],
      usage: { input_tokens: 50, output_tokens: 10 },
    });
    synthesizeSpeech.mockRejectedValueOnce(new Error('tts_failed: 500 boom'));
    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');
    expect(synthesizeSpeech).toHaveBeenCalledTimes(1);
    expect(sendOutboundVoice).not.toHaveBeenCalled();
    expect(sendOutboundText).toHaveBeenCalledTimes(1);
    const auditAcoes = audit.mock.calls.map((c) => c[0].acao);
    expect(auditAcoes).not.toContain('outbound_sent_voice');
  });

  it('Baileys disconnected (null wid) → no audit, no mensagens row', async () => {
    findMensagem.mockResolvedValue({ ...VOICE_INBOUND });
    callLLM.mockResolvedValueOnce({
      content: 'reply curto', tool_uses: [],
      usage: { input_tokens: 50, output_tokens: 10 },
    });
    synthesizeSpeech.mockResolvedValueOnce(Buffer.from([0]));
    sendOutboundVoice.mockResolvedValueOnce(null);
    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');
    expect(sendOutboundVoice).toHaveBeenCalledTimes(1);
    const auditAcoes = audit.mock.calls.map((c) => c[0].acao);
    expect(auditAcoes).not.toContain('outbound_sent_voice');
    const audioRow = createMensagem.mock.calls.find((c) => c[0].tipo === 'audio');
    expect(audioRow).toBeUndefined();
    expect(sendOutboundText).not.toHaveBeenCalled();
  });
});
