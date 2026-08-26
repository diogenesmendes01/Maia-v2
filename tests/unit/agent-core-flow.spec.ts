import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Smoke spec for the post-refactor agent loop. Covers structural wiring:
 * given a deterministic ReAct turn, the orchestrator dispatches to the
 * correct output channel (PDF / voice / text / poll). Not exhaustive —
 * branch-specific behaviour is covered in pdf-flow.spec, voice-flow.spec,
 * one-tap-poll.spec and view-once.spec. This file only guards the seams
 * introduced by Issue #3.
 */

const SANDBOX = join(tmpdir(), 'maia-agent-core-flow-' + Date.now());

const { flagState, dbState } = vi.hoisted(() => ({
  flagState: {
    FEATURE_OUTBOUND_VOICE: true,
    FEATURE_VIEW_ONCE_SENSITIVE: false,
    FEATURE_ONE_TAP: true,
    FEATURE_PENDING_GATE: false,
    FEATURE_PDF_REPORTS: true,
  },
  dbState: { conversaResult: [] as unknown[] },
}));

const sendOutboundText = vi.fn();
const sendOutboundDocument = vi.fn();
const sendOutboundVoice = vi.fn();
const sendPoll = vi.fn();
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
// Issue #511: reconfigurable per test so the "blocked turn never hydrates the
// prompt" case can drive the engine to a block.
const runDecisionEngineForTurn = vi.fn();

// #634 — a mídia de saída passa por `src/runtime/outbound/media-store.ts`, que
// resolve a raiz por `MEDIA_ROOT`. O double precisa fornecê-la: sem ela os
// ramos de documento e voz falham ANTES do canal (fail-closed correto em
// produção, falso vermelho aqui). `SANDBOX` é a mesma raiz onde a spec escreve
// o PDF de fixture.
vi.mock('../../src/gateway/baileys.js', () => ({
  sendOutboundText, sendOutboundDocument, sendOutboundVoice,
  isBaileysConnected: () => true,
  MEDIA_ROOT: SANDBOX,
}));
// Fase 0 do roteamento multi-linha (spec 2026-07-09 §1.6): todo envio físico
// passa pela fronteira única `LineOutput` resolvida via forCurrentAgentChannel.
// Wire the line's methods to the SAME spies the assertions below observe so
// the routing contract (text/PDF/voice/poll) keeps being verified end-to-end.
vi.mock('../../src/gateway/line-output.js', () => ({
  forCurrentAgentChannel: vi.fn(async () => ({
    scope: { tenant_id: 'primary', agent_id: 'primary', channel_id: 'ch-primary' },
    sendText: sendOutboundText,
    sendDocument: sendOutboundDocument,
    sendVoice: sendOutboundVoice,
    sendPoll,
    sendReaction: vi.fn(),
    startTyping: vi.fn(() => ({ stop: vi.fn() })),
    markRead: vi.fn(),
    isConnected: () => true,
  })),
}));
// P11: the Decision Engine is always-on and would otherwise hit real prod
// adapters (DB/Redis) here. Mock it to a no-op pass-through (engine_ran:false →
// agent/core.ts proceeds straight to the LLM path, the behaviour these output-
// channel smoke tests assert).
vi.mock('../../src/runtime/decision/integration.js', () => ({
  runDecisionEngineForTurn,
  DecisionEngineFailClosedError: class DecisionEngineFailClosedError extends Error {},
}));
vi.mock('../../src/lib/tts.js', () => ({
  synthesizeSpeech,
  OUTBOUND_VOICE_MAX_CHARS: 400,
  // #634 — o artefato durável de `audio` persiste o mimetype REAL da síntese.
  OUTBOUND_VOICE_MIMETYPE: 'audio/ogg; codecs=opus',
}));
vi.mock('../../src/db/repositories.js', () => ({
  pessoasRepo: { findById },
  mensagensRepo: {
    create: createMensagem, findById: findMensagem, markProcessed,
    recentInConversation, setConversaId: vi.fn(), createInbound: vi.fn(),
  },
  pendingQuestionsRepo: { findActiveSnapshot: vi.fn().mockResolvedValue(null) },
  conversasRepo: { touch: vi.fn() },
  selfStateRepo: { getActive: vi.fn().mockResolvedValue(null) },
  factsRepo: { listForScopes: vi.fn().mockResolvedValue([]), listMentionableForScopes: vi.fn().mockResolvedValue([]) },
  rulesRepo: { listActive: vi.fn().mockResolvedValue([]) },
  entityStatesRepo: { byId: vi.fn().mockResolvedValue(null), byIds: vi.fn().mockResolvedValue([]) },
  entidadesRepo: { byIds: vi.fn().mockResolvedValue([]) },
}));
vi.mock('../../src/db/client.js', () => {
  const fakeQuery = {
    from: () => fakeQuery, innerJoin: () => fakeQuery, where: () => fakeQuery,
    limit: () => Promise.resolve(dbState.conversaResult),
  };
  return {
    db: { select: () => fakeQuery },
    withTx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
  };
});
// `mensagens` is needed by the channel-resolution probe in runAgentForMensagem
// (it reads `mensagens.metadata` before the resolver). Without it the probe
// deref throws and, post-#417 fail-closed, that propagates instead of being
// silently swallowed.
vi.mock('../../src/db/schema.js', () => ({ conversas: {}, pessoas: {}, mensagens: { metadata: {}, id: {} } }));
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
vi.mock('../../src/tools/_registry.js', () => ({
  REGISTRY: {
    ask_pending_question: { sensitive: false, side_effect: 'communication' },
    generate_report: { sensitive: false, side_effect: 'read' },
  },
  getToolSchemas: () => [],
}));
// Issue #408 — core.ts now computes the LLM-visible tool set via the Runtime
// Tool Filter. These flow tests don't assert on tool visibility, so we stub it
// to an empty set (the same shape getToolSchemas previously returned).
vi.mock('../../src/tools/runtime-filter.js', () => ({
  computeRuntimeVisibleTools: vi.fn(async () => ({
    tools: [],
    requires_confirmation: [],
    grant: { granted_packs: ['baseline.core'], granted_tools: [], denied_tools: [] },
  })),
}));
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
  sendReaction: vi.fn(),
  quotedReplyContext: vi.fn(),
  sendPoll,
}));
vi.mock('../../src/agent/reflection.js', () => ({
  detectCorrection: vi.fn().mockReturnValue(false),
  reflectOnCorrection: vi.fn(),
  findPreviousAssistantMessage: vi.fn(),
}));

const PESSOA = {
  id: 'p1', telefone_whatsapp: '+5511888888888', nome: 'Owner',
  tipo: 'owner', preferencias: {},
} as never;
const CONVERSA = { id: 'c1', pessoa_id: 'p1', status: 'ativa' } as never;
const TEXT_INBOUND = {
  id: 'in1', conversa_id: 'c1', direcao: 'in' as const, tipo: 'texto' as const,
  conteudo: 'oi', metadata: { whatsapp_id: 'WAID-IN' }, processada_em: null,
};
const VOICE_INBOUND = {
  id: 'in1', conversa_id: 'c1', direcao: 'in' as const, tipo: 'audio' as const,
  conteudo: '[transcribed: oi]', metadata: { whatsapp_id: 'WAID-IN' }, processada_em: null,
};

describe('agent core flow — output dispatch routing (smoke)', () => {
  let pdfPath: string;

  beforeAll(async () => {
    await mkdir(join(SANDBOX, 'tmp'), { recursive: true });
  });
  afterAll(async () => {
    await rm(SANDBOX, { recursive: true, force: true });
  });

  beforeEach(async () => {
    callLLM.mockReset(); dispatchTool.mockReset();
    sendOutboundText.mockReset(); sendOutboundDocument.mockReset();
    sendOutboundVoice.mockReset(); sendPoll.mockReset();
    audit.mockReset(); createMensagem.mockReset();
    findById.mockReset(); findMensagem.mockReset(); markProcessed.mockReset();
    synthesizeSpeech.mockReset();
    recentInConversation.mockReset().mockResolvedValue([]);
    buildPrompt.mockReset().mockResolvedValue({ system: 's', messages: [] });
    runDecisionEngineForTurn.mockReset().mockResolvedValue({ engine_ran: false });
    findById.mockResolvedValue(PESSOA);
    sendOutboundText.mockResolvedValue('WAID-OUT');
    sendOutboundDocument.mockResolvedValue('WAID-DOC');
    sendOutboundVoice.mockResolvedValue('WAID-VOICE');
    dbState.conversaResult = [{ conversas: CONVERSA, pessoas: PESSOA }];

    pdfPath = join(SANDBOX, 'tmp', `${Math.random().toString(36).slice(2)}.pdf`);
    await writeFile(pdfPath, '%PDF-1.4 sample\n%%EOF');
  });

  /**
   * Issue #511 — the cheap gate runs BEFORE context hydration.
   *
   * The Decision Engine used to run AFTER `buildPrompt`, so a turn it was about
   * to block had already paid for the entire context — history, entities and
   * states, facts, rules, memories, hints, capabilities, gaps, procedure — and
   * then threw all of it away. These two cases pin the ordering: the blocked
   * and escalated paths must reply to the user without ever hydrating a prompt.
   */
  describe('#511 cheap gate precedes context hydration', () => {
    const blockingDecision = (action_mode: string, block: boolean) => ({
      engine_ran: true,
      result: {
        block,
        packet: {
          action_mode,
          tool_permissions: { allowed_tools: [], blocked_tools: [], requires_confirmation: [] },
          risk_profile: { level: 'low', reasons: [], requires_human_review: false },
          routing: { agent_id: 'primary', candidate_skill_ids: [] },
        },
      },
    });

    it('a BLOCKED turn never builds the prompt', async () => {
      findMensagem.mockResolvedValue({ ...TEXT_INBOUND });
      runDecisionEngineForTurn.mockResolvedValue(blockingDecision('respond', true));

      const { runAgentForMensagem } = await import('../../src/agent/core.js');
      await runAgentForMensagem('in1');

      expect(runDecisionEngineForTurn).toHaveBeenCalledTimes(1);
      expect(buildPrompt).not.toHaveBeenCalled();
      expect(callLLM).not.toHaveBeenCalled();
      // The user still gets an answer — this is about cost, not silence.
      expect(sendOutboundText).toHaveBeenCalledTimes(1);
    });

    it('an ESCALATED turn never builds the prompt', async () => {
      findMensagem.mockResolvedValue({ ...TEXT_INBOUND });
      runDecisionEngineForTurn.mockResolvedValue(blockingDecision('escalate', false));

      const { runAgentForMensagem } = await import('../../src/agent/core.js');
      await runAgentForMensagem('in1');

      expect(buildPrompt).not.toHaveBeenCalled();
      expect(callLLM).not.toHaveBeenCalled();
      expect(sendOutboundText).toHaveBeenCalledTimes(1);
    });

    it('an ALLOWED turn still builds the prompt exactly once', async () => {
      findMensagem.mockResolvedValue({ ...TEXT_INBOUND });
      runDecisionEngineForTurn.mockResolvedValue(blockingDecision('respond', false));
      callLLM.mockResolvedValueOnce({
        content: 'ok', tool_uses: [],
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      const { runAgentForMensagem } = await import('../../src/agent/core.js');
      await runAgentForMensagem('in1');

      expect(buildPrompt).toHaveBeenCalledTimes(1);
      expect(callLLM).toHaveBeenCalled();
    });
  });

  it('plain text turn → sendOutboundText', async () => {
    findMensagem.mockResolvedValue({ ...TEXT_INBOUND });
    callLLM.mockResolvedValueOnce({
      content: 'oi! tudo bem?', tool_uses: [],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');
    expect(sendOutboundText).toHaveBeenCalledTimes(1);
    expect(sendOutboundDocument).not.toHaveBeenCalled();
    expect(sendOutboundVoice).not.toHaveBeenCalled();
    expect(sendPoll).not.toHaveBeenCalled();
  });

  it('generate_report turn → sendOutboundDocument (PDF branch)', async () => {
    findMensagem.mockResolvedValue({ ...TEXT_INBOUND });
    callLLM.mockResolvedValueOnce({
      content: '',
      tool_uses: [{ id: 'tu1', tool: 'generate_report', args: { tipo: 'extrato' } }],
      usage: { input_tokens: 80, output_tokens: 5 },
    });
    callLLM.mockResolvedValueOnce({
      content: 'aqui está o extrato', tool_uses: [],
      usage: { input_tokens: 30, output_tokens: 10 },
    });
    dispatchTool.mockResolvedValue({
      path: pdfPath, fileName: 'extrato.pdf',
      mimetype: 'application/pdf', tipo: 'extrato',
    });
    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');
    expect(sendOutboundDocument).toHaveBeenCalledTimes(1);
    expect(sendOutboundText).not.toHaveBeenCalled();
    expect(sendOutboundVoice).not.toHaveBeenCalled();
    expect(sendPoll).not.toHaveBeenCalled();
  });

  it('voice inbound + short reply → sendOutboundVoice (TTS branch)', async () => {
    findMensagem.mockResolvedValue({ ...VOICE_INBOUND });
    synthesizeSpeech.mockResolvedValue(Buffer.from('audio-bytes'));
    callLLM.mockResolvedValueOnce({
      content: 'curto', tool_uses: [],
      usage: { input_tokens: 10, output_tokens: 2 },
    });
    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');
    expect(sendOutboundVoice).toHaveBeenCalledTimes(1);
    expect(sendOutboundText).not.toHaveBeenCalled();
    expect(sendOutboundDocument).not.toHaveBeenCalled();
    expect(sendPoll).not.toHaveBeenCalled();
  });

  it('ask_pending_question with 3+ options → sendPoll (one-tap branch)', async () => {
    findMensagem.mockResolvedValue({ ...TEXT_INBOUND });
    const opcoes = [
      { key: 'a', label: 'Opção A' },
      { key: 'b', label: 'Opção B' },
      { key: 'c', label: 'Opção C' },
    ];
    callLLM.mockResolvedValueOnce({
      content: '',
      tool_uses: [{ id: 'tu1', tool: 'ask_pending_question', args: { pergunta: 'qual?', opcoes_validas: opcoes } }],
      usage: { input_tokens: 40, output_tokens: 5 },
    });
    callLLM.mockResolvedValueOnce({
      content: 'qual delas?', tool_uses: [],
      usage: { input_tokens: 30, output_tokens: 5 },
    });
    dispatchTool.mockResolvedValue({
      pending_question_id: 'pq1', opcoes_validas: opcoes,
    });
    // Re-validation in react-loop hits findActiveSnapshot — make it match.
    const { pendingQuestionsRepo } = await import('../../src/db/repositories.js');
    (pendingQuestionsRepo.findActiveSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'pq1' });
    sendPoll.mockResolvedValue({
      whatsapp_id: 'WAID-POLL', message_secret: 'sec', creator_jid: 'jid',
    });
    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');
    expect(sendPoll).toHaveBeenCalledTimes(1);
    expect(sendOutboundText).not.toHaveBeenCalled();
    expect(sendOutboundDocument).not.toHaveBeenCalled();
    expect(sendOutboundVoice).not.toHaveBeenCalled();
  });
});
