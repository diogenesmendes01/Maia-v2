/**
 * Issue #514 review round 1 [P1] — a failed MANDATORY runtime-trace envelope
 * must block the turn, at the FULL CALLER.
 *
 * Why this file exists rather than another assertion in
 * `tests/unit/observability/turn-trace.spec.ts`: that spec proved
 * `traceTurnDecision` throws. It could not — and did not — prove that anything
 * downstream honoured the throw. `src/agent/core.ts` only recognises typed
 * block errors; a raw error was caught, logged `wiring_error_continuing`, and
 * the turn fell straight through to `runReActLoop`, so a tool or an outbound
 * could execute with no evidence record. Testing at the emission point proved
 * nothing about the guarantee the PR claimed.
 *
 * So this spec drives `runAgentForMensagem` — the real orchestrator — and
 * asserts on the three things that must NOT happen: no LLM/ReAct, no tool
 * dispatch, no ReAct-produced outbound.
 *
 * Harness mirrors `tests/unit/agent-core-flow.spec.ts` (same seams, same
 * mocks) so the two stay comparable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { flagState, dbState } = vi.hoisted(() => ({
  flagState: {
    FEATURE_OUTBOUND_VOICE: false,
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
const runDecisionEngineForTurn = vi.fn();

/**
 * The REAL error class from the module under test. Importing it (instead of
 * redeclaring a stub, as `agent-core-flow.spec.ts` does for the engine error)
 * is the point: if someone renames it, drops the `instanceof` branch, or
 * changes what `traceTurnDecision` throws, this spec breaks.
 */
const { MandatoryTraceEnvelopeError } = await import('@/observability/turn-trace.js');

vi.mock('../../src/gateway/baileys.js', () => ({
  sendOutboundText, sendOutboundDocument, sendOutboundVoice,
  isBaileysConnected: () => true,
}));
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
// Only `runDecisionEngineForTurn` is stubbed — the error classes are the REAL
// ones so `instanceof` in core.ts is exercised for real.
vi.mock('../../src/runtime/decision/integration.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../src/runtime/decision/integration.js')
  >();
  return { ...actual, runDecisionEngineForTurn };
});
vi.mock('../../src/lib/tts.js', () => ({
  synthesizeSpeech: vi.fn(),
  OUTBOUND_VOICE_MAX_CHARS: 400,
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
  factsRepo: {
    listForScopes: vi.fn().mockResolvedValue([]),
    listMentionableForScopes: vi.fn().mockResolvedValue([]),
  },
  rulesRepo: { listActive: vi.fn().mockResolvedValue([]) },
  entityStatesRepo: { byId: vi.fn().mockResolvedValue(null) },
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
vi.mock('../../src/db/schema.js', () => ({
  conversas: {}, pessoas: {}, mensagens: { metadata: {}, id: {} },
}));
vi.mock('drizzle-orm', () => ({ eq: () => ({}) }));
vi.mock('../../src/governance/audit.js', () => ({ audit }));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../../src/config/env.js', () => ({
  config: new Proxy({} as Record<string, unknown>, {
    get(_t, prop) {
      if (prop === 'OWNER_TELEFONE_WHATSAPP') return '+5511999999999';
      if (typeof prop === 'string' && prop in flagState) {
        return (flagState as Record<string, boolean>)[prop];
      }
      return undefined;
    },
  }),
}));
vi.mock('../../src/tools/_dispatcher.js', () => ({ dispatchTool }));
vi.mock('../../src/tools/_registry.js', () => ({
  REGISTRY: { generate_report: { sensitive: false, side_effect: 'read' } },
  getToolSchemas: () => [],
}));
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
  conteudo: 'transfere 5000 pro fornecedor', metadata: { whatsapp_id: 'WAID-IN' },
  processada_em: null,
};

const FAIL_CLOSED_REPLY = 'Sistema indisponível temporariamente. Tente novamente em alguns instantes.';

describe('issue #514 [P1] — mandatory trace envelope failure blocks the whole turn', () => {
  beforeEach(() => {
    callLLM.mockReset();
    dispatchTool.mockReset();
    sendOutboundText.mockReset().mockResolvedValue('WAID-OUT');
    sendOutboundDocument.mockReset();
    sendOutboundVoice.mockReset();
    sendPoll.mockReset();
    audit.mockReset();
    createMensagem.mockReset();
    findById.mockReset().mockResolvedValue(PESSOA);
    findMensagem.mockReset().mockResolvedValue({ ...TEXT_INBOUND });
    markProcessed.mockReset();
    recentInConversation.mockReset().mockResolvedValue([]);
    runDecisionEngineForTurn.mockReset();
    buildPrompt.mockResolvedValue({ system: 's', messages: [] });
    dbState.conversaResult = [{ conversas: CONVERSA, pessoas: PESSOA }];
  });

  it('does NOT reach the LLM / ReAct loop', async () => {
    runDecisionEngineForTurn.mockRejectedValue(
      new MandatoryTraceEnvelopeError(new Error('postgres unavailable'), 'primary', 'medium'),
    );
    // If the LLM were reached it would answer and the turn would proceed.
    callLLM.mockResolvedValue({
      content: 'transferência feita!', tool_uses: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');

    expect(callLLM).not.toHaveBeenCalled();
  });

  it('does NOT dispatch any tool', async () => {
    runDecisionEngineForTurn.mockRejectedValue(
      new MandatoryTraceEnvelopeError(new Error('db down'), 'primary', 'high'),
    );
    callLLM.mockResolvedValue({
      content: '',
      tool_uses: [{ id: 'tu1', tool: 'generate_report', args: {} }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');

    expect(dispatchTool).not.toHaveBeenCalled();
  });

  it('sends ONLY the fail-closed notice — never a ReAct-produced outbound', async () => {
    runDecisionEngineForTurn.mockRejectedValue(
      new MandatoryTraceEnvelopeError(new Error('db down'), 'primary', 'medium'),
    );
    callLLM.mockResolvedValue({
      content: 'pronto, transferi!', tool_uses: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');

    expect(sendOutboundText).toHaveBeenCalledTimes(1);
    const sentBody = String(sendOutboundText.mock.calls[0]?.[1] ?? '');
    expect(sentBody).toBe(FAIL_CLOSED_REPLY);
    expect(sentBody).not.toContain('transferi');
    expect(sendOutboundDocument).not.toHaveBeenCalled();
    expect(sendOutboundVoice).not.toHaveBeenCalled();
    expect(sendPoll).not.toHaveBeenCalled();
  });

  it('closes the turn out (marks processed) instead of leaving it half-run', async () => {
    runDecisionEngineForTurn.mockRejectedValue(
      new MandatoryTraceEnvelopeError(new Error('db down'), 'primary', 'critical'),
    );
    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');
    expect(markProcessed).toHaveBeenCalled();
  });

  it('REGRESSION: a plain Error still falls through — proving the block comes from the TYPE', async () => {
    // This is the pre-fix behaviour, pinned deliberately. If someone widens the
    // catch to block on every error, this test tells them they changed the
    // contract for unrelated wiring failures. If someone REMOVES the
    // MandatoryTraceEnvelopeError branch, the four tests above fail while this
    // one keeps passing — which is exactly how the regression is localised.
    runDecisionEngineForTurn.mockRejectedValue(new Error('postgres unavailable'));
    callLLM.mockResolvedValue({
      content: 'oi', tool_uses: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');

    expect(callLLM).toHaveBeenCalled();
  });

  it('the happy path still reaches the LLM (the block is not unconditional)', async () => {
    runDecisionEngineForTurn.mockResolvedValue({ engine_ran: false });
    callLLM.mockResolvedValue({
      content: 'oi!', tool_uses: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');

    expect(callLLM).toHaveBeenCalled();
    expect(sendOutboundText).toHaveBeenCalledTimes(1);
    expect(String(sendOutboundText.mock.calls[0]?.[1] ?? '')).not.toBe(FAIL_CLOSED_REPLY);
  });
});
