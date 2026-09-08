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

const {
  flagState,
  dbState,
  sendOutboundDelegate,
  checkRateLimit,
  formatPoliteReply,
  executeSelectedSkill,
} = vi.hoisted(() => ({
  flagState: {
    FEATURE_OUTBOUND_VOICE: false,
    FEATURE_VIEW_ONCE_SENSITIVE: false,
    FEATURE_ONE_TAP: false,
    FEATURE_PENDING_GATE: false,
    FEATURE_PDF_REPORTS: false,
  },
  dbState: { conversaResult: [] as unknown[] },
  sendOutboundDelegate: vi.fn(),
  checkRateLimit: vi.fn(),
  formatPoliteReply: vi.fn(),
  executeSelectedSkill: vi.fn(),
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
const ensureTurnHandle = vi.fn(async (): Promise<unknown> => null);
const failTurnRetryable = vi.fn(async () => undefined);
const concludeTurn = vi.fn(async () => undefined);
const findAudienceProfile = vi.fn();
const getChannelPolicy = vi.fn();
const listActiveRoles = vi.fn();
const getRoleById = vi.fn();
const findActiveProcedure = vi.fn();
const runNodes = vi.fn();
const touchConversation = vi.fn();

/**
 * The REAL error class from the module under test. Importing it (instead of
 * redeclaring a stub, as `agent-core-flow.spec.ts` does for the engine error)
 * is the point: if someone renames it, drops the `instanceof` branch, or
 * changes what `traceTurnDecision` throws, this spec breaks.
 */
const { MandatoryTraceEnvelopeError } =
  await import('@/observability/turn-trace.js');

vi.mock('../../src/gateway/baileys.js', () => ({
  sendOutboundText,
  sendOutboundDocument,
  sendOutboundVoice,
  isBaileysConnected: () => true,
}));
vi.mock('../../src/gateway/line-output.js', () => ({
  forCurrentAgentChannel: vi.fn(async () => ({
    scope: {
      tenant_id: 'primary',
      agent_id: 'primary',
      channel_id: 'ch-primary',
    },
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
  const actual =
    await importOriginal<
      typeof import('../../src/runtime/decision/integration.js')
    >();
  return { ...actual, runDecisionEngineForTurn };
});
type SendOutboundFn =
  (typeof import('../../src/agent/output-dispatch.js'))['sendOutbound'];
vi.mock('../../src/agent/output-dispatch.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/agent/output-dispatch.js')>();
  return {
    ...actual,
    sendOutbound: (...args: Parameters<SendOutboundFn>) =>
      sendOutboundDelegate(actual.sendOutbound, ...args),
  };
});
vi.mock('../../src/lib/tts.js', () => ({
  synthesizeSpeech: vi.fn(),
  OUTBOUND_VOICE_MAX_CHARS: 400,
}));
vi.mock('../../src/db/repositories.js', () => ({
  pessoasRepo: { findById },
  mensagensRepo: {
    create: createMensagem,
    findById: findMensagem,
    markProcessed,
    recentInConversation,
    setConversaId: vi.fn(),
    createInbound: vi.fn(),
  },
  pendingQuestionsRepo: { findActiveSnapshot: vi.fn().mockResolvedValue(null) },
  conversasRepo: {
    byIdWithPessoa: vi.fn(async () => {
      const row = dbState.conversaResult[0] as
        | { conversas: unknown; pessoas: unknown }
        | undefined;
      return row ? { conversa: row.conversas, pessoa: row.pessoas } : null;
    }),
    touch: touchConversation,
    mergeMetadata: vi.fn(),
  },
  agentAudienceProfilesRepo: { findByPessoa: findAudienceProfile },
  channelPoliciesRepo: { getByChannelId: getChannelPolicy },
  rolesRepo: { listActive: listActiveRoles, getById: getRoleById },
  procedureExecutionsRepo: { findActiveForConversa: findActiveProcedure },
  procedureDefinitionsRepo: { findById: vi.fn() },
  procedureSelectorDecisionsRepo: { record: vi.fn() },
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
    from: () => fakeQuery,
    innerJoin: () => fakeQuery,
    where: () => fakeQuery,
    limit: () => Promise.resolve(dbState.conversaResult),
  };
  return {
    db: { select: () => fakeQuery },
    withTx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
  };
});
vi.mock('../../src/db/schema.js', () => ({
  conversas: {},
  pessoas: {},
  mensagens: { metadata: {}, id: {} },
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
    grant: {
      granted_packs: ['baseline.core'],
      granted_tools: [],
      denied_tools: [],
    },
  })),
}));
vi.mock('../../src/lib/claude.js', () => ({ callLLM }));
vi.mock('../../src/agent/prompt-builder.js', () => ({
  buildPrompt,
  PROMPT_TOKEN_BUDGET_INPUT: 11000,
  PROMPT_TOKEN_BUDGET_OUTPUT: 1024,
}));
vi.mock('../../src/agent/pending-gate.js', () => ({
  checkPendingFirst: vi.fn().mockResolvedValue({ kind: 'no_pending' }),
}));
vi.mock('../../src/identity/resolver.js', () => ({ resolveIdentity: vi.fn() }));
vi.mock('../../src/identity/quarantine.js', () => ({
  handleQuarantineFirstContact: vi.fn(),
  handleOwnerIdentityReply: vi.fn(),
}));
vi.mock('../../src/governance/permissions.js', () => ({
  resolveScope: vi
    .fn()
    .mockResolvedValue({ entidades: [], byEntity: new Map() }),
}));
vi.mock('../../src/gateway/rate-limit.js', () => ({
  checkRateLimit,
  formatPoliteReply,
}));
vi.mock('../../src/agent/execute-skill.js', () => ({ executeSelectedSkill }));
vi.mock('../../src/gateway/presence.js', () => ({
  startTyping: vi.fn(() => ({ stop: vi.fn() })),
  sendReaction: vi.fn(),
  quotedReplyContext: vi.fn(),
  sendPoll,
}));
// #503 (merged) — the durable turn state machine. Only `failTurnRetryable` is
// spied; everything else keeps its real implementation so the wiring under test
// is the real one.
vi.mock('../../src/runtime/turns/lifecycle.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../src/runtime/turns/lifecycle.js')
    >();
  return { ...actual, ensureTurnHandle, failTurnRetryable, concludeTurn };
});
vi.mock('../../src/cognitive-graph/orchestrator.js', () => ({ runNodes }));
vi.mock('../../src/agent/reflection.js', () => ({
  detectCorrection: vi.fn().mockReturnValue(false),
  reflectOnCorrection: vi.fn(),
  findPreviousAssistantMessage: vi.fn(),
}));

const PESSOA = {
  id: 'p1',
  telefone_whatsapp: '+5511888888888',
  nome: 'Owner',
  tenant_id: 'primary',
  agent_id: 'primary',
  tipo: 'owner',
  status: 'ativa',
  preferencias: {},
} as never;
const CONVERSA = {
  id: 'c1',
  pessoa_id: 'p1',
  status: 'ativa',
  channel_id: 'ch-primary',
} as never;
const AUDIENCE_PROFILE = {
  id: 'aud-1',
  tenant_id: 'primary',
  agent_id: 'primary',
  pessoa_id: 'p1',
  audience_type: 'owner',
  trust_level: 'trusted_internal',
  status: 'active',
  permission_profile_ids: [],
  labels: [],
  metadata: {},
} as never;
const DEFAULT_ROLE = {
  id: 'role-default',
  tenant_id: 'primary',
  agent_id: 'primary',
  role_key: 'default',
  display_name: 'Default',
  description: null,
  prompt_addendum: null,
  granted_packs: [],
  active: true,
  is_default: true,
  metadata: {},
} as never;
const CHANNEL_POLICY = {
  id: 'policy-1',
  tenant_id: 'primary',
  agent_id: 'primary',
  channel_id: 'ch-primary',
  default_role_id: 'role-default',
  switch_behavior: 'fixed',
  announce_mode: 'never',
  by_context_guards: {},
  allowed_role_ids: [],
} as never;
const TEXT_INBOUND = {
  id: 'in1',
  conversa_id: 'c1',
  direcao: 'in' as const,
  tipo: 'texto' as const,
  conteudo: 'transfere 5000 pro fornecedor',
  metadata: { whatsapp_id: 'WAID-IN' },
  processada_em: null,
};

const FAIL_CLOSED_REPLY =
  'Sistema indisponível temporariamente. Tente novamente em alguns instantes.';
const ALLOWING_DECISION = {
  engine_ran: true,
  result: {
    block: false,
    packet: {
      action_mode: 'respond',
      tool_permissions: {
        allowed_tools: [],
        blocked_tools: [],
        requires_confirmation: [],
      },
      risk_profile: {
        level: 'low',
        reasons: [],
        requires_human_review: false,
      },
      routing: { agent_id: 'primary', candidate_skill_ids: [] },
    },
  },
} as const;

describe('issue #514 [P1] — mandatory trace envelope failure blocks the whole turn', () => {
  beforeEach(() => {
    callLLM.mockReset();
    dispatchTool.mockReset();
    sendOutboundText.mockReset().mockResolvedValue('WAID-OUT');
    sendOutboundDocument.mockReset();
    sendOutboundVoice.mockReset();
    sendPoll.mockReset();
    // `audit()` is awaited-then-`.catch()`ed in core.ts, so the mock must
    // resolve — a bare `mockReset()` returns undefined and blows up on
    // `.catch`, masking the error under test.
    audit.mockReset().mockResolvedValue(undefined);
    createMensagem.mockReset();
    findById.mockReset().mockResolvedValue(PESSOA);
    findMensagem.mockReset().mockResolvedValue({ ...TEXT_INBOUND });
    markProcessed.mockReset();
    recentInConversation.mockReset().mockResolvedValue([]);
    runDecisionEngineForTurn.mockReset();
    ensureTurnHandle.mockReset().mockResolvedValue(null);
    failTurnRetryable.mockReset().mockResolvedValue(undefined);
    concludeTurn.mockReset().mockResolvedValue(undefined);
    findAudienceProfile.mockReset().mockResolvedValue(AUDIENCE_PROFILE);
    getChannelPolicy.mockReset().mockResolvedValue(CHANNEL_POLICY);
    listActiveRoles.mockReset().mockResolvedValue([DEFAULT_ROLE]);
    getRoleById.mockReset().mockResolvedValue(DEFAULT_ROLE);
    findActiveProcedure.mockReset().mockResolvedValue(null);
    runNodes.mockReset().mockResolvedValue({
      total_latency_ms: 0,
      nodes: {
        'role-selector': {
          status: 'success',
          output: {
            decided_role: DEFAULT_ROLE,
            action: 'keep_current',
            decision_id: 'role-decision-1',
          },
          latency_ms: 0,
          fallback_triggered: false,
        },
      },
    });
    touchConversation.mockReset().mockResolvedValue(undefined);
    buildPrompt.mockReset().mockResolvedValue({ system: 's', messages: [] });
    checkRateLimit.mockReset().mockResolvedValue({ kind: 'allow' });
    formatPoliteReply
      .mockReset()
      .mockReturnValue('Muitas mensagens; tente novamente depois.');
    executeSelectedSkill.mockReset().mockResolvedValue({
      handled: false,
      reason: 'no_pinned_identity',
    });
    sendOutboundDelegate
      .mockReset()
      .mockImplementation(
        (real: SendOutboundFn, ...args: Parameters<SendOutboundFn>) =>
          real(...args),
      );
    dbState.conversaResult = [{ conversas: CONVERSA, pessoas: PESSOA }];
  });

  it('does NOT reach the LLM / ReAct loop', async () => {
    runDecisionEngineForTurn.mockRejectedValue(
      new MandatoryTraceEnvelopeError(
        new Error('postgres unavailable'),
        'primary',
        'medium',
      ),
    );
    // If the LLM were reached it would answer and the turn would proceed.
    callLLM.mockResolvedValue({
      content: 'transferência feita!',
      tool_uses: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await expect(runAgentForMensagem('in1')).rejects.toBeInstanceOf(
      MandatoryTraceEnvelopeError,
    );

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
    await expect(runAgentForMensagem('in1')).rejects.toThrow();

    expect(dispatchTool).not.toHaveBeenCalled();
  });

  it('sends NO outbound at all — the retry may still answer the user', async () => {
    // Round 2 [P1]: round 1 replied "Sistema indisponível" and completed the
    // job. Now the job fails and BullMQ retries, so an apology followed by a
    // successful retry answer would be worse than a slightly slower answer.
    runDecisionEngineForTurn.mockRejectedValue(
      new MandatoryTraceEnvelopeError(
        new Error('db down'),
        'primary',
        'medium',
      ),
    );
    callLLM.mockResolvedValue({
      content: 'pronto, transferi!',
      tool_uses: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await expect(runAgentForMensagem('in1')).rejects.toThrow();

    expect(sendOutboundText).not.toHaveBeenCalled();
    expect(sendOutboundDocument).not.toHaveBeenCalled();
    expect(sendOutboundVoice).not.toHaveBeenCalled();
    expect(sendPoll).not.toHaveBeenCalled();
  });

  it('PROPAGATES so the job fails — no retry/dead-letter is silently skipped', async () => {
    // The core of round 2 [P1]: the turn must not end as a success.
    runDecisionEngineForTurn.mockRejectedValue(
      new MandatoryTraceEnvelopeError(
        new Error('db down'),
        'primary',
        'critical',
      ),
    );
    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await expect(runAgentForMensagem('in1')).rejects.toMatchObject({
      code: 'MANDATORY_TRACE_ENVELOPE_FAILED',
    });
  });

  it('leaves the inbound UNPROCESSED so the recovery sweep can re-enqueue it', async () => {
    // A `processada_em` stamp would make `runMessageRecovery` skip the row
    // forever — the exact "turno perdido em silêncio" the review flagged.
    runDecisionEngineForTurn.mockRejectedValue(
      new MandatoryTraceEnvelopeError(
        new Error('db down'),
        'primary',
        'critical',
      ),
    );
    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await expect(runAgentForMensagem('in1')).rejects.toThrow();
    expect(markProcessed).not.toHaveBeenCalled();
  });

  it('audits the refusal — the audit log is the only durable record left', async () => {
    // The trace write is what failed, so the trace cannot carry this evidence.
    runDecisionEngineForTurn.mockRejectedValue(
      new MandatoryTraceEnvelopeError(new Error('db down'), 'primary', 'high'),
    );
    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await expect(runAgentForMensagem('in1')).rejects.toThrow();

    const row = audit.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .find((a) => a.acao === 'runtime_trace_envelope_blocked_turn');
    expect(row).toBeDefined();
    expect(row!.alvo_id).toBe('in1');
    expect((row!.metadata as Record<string, unknown>).side_effect_level).toBe(
      'high',
    );
    // No message content in the audit metadata.
    expect(JSON.stringify(row)).not.toContain('transfere 5000');
  });

  it('marks the turn through the #503 state machine, not just the BullMQ job', async () => {
    // #503 merged while this issue was in review. The job failing and the
    // durable turn row agreeing are two halves of one contract — a job that
    // fails while the turn row still says `running` is the same silent loss in
    // a different table. `failTurnRetryable` owns the retry-vs-dead-letter
    // decision, so this adds no parallel retry mechanism.
    runDecisionEngineForTurn.mockRejectedValue(
      new MandatoryTraceEnvelopeError(
        new Error('db down'),
        'primary',
        'medium',
      ),
    );
    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await expect(runAgentForMensagem('in1')).rejects.toThrow();

    expect(failTurnRetryable).toHaveBeenCalledTimes(1);
    expect(failTurnRetryable.mock.calls[0]?.[1]).toMatchObject({
      code: 'runtime_trace_envelope_failed',
      mensagem_id: 'in1',
    });
  });

  it('a failing audit write does not mask the original error', async () => {
    runDecisionEngineForTurn.mockRejectedValue(
      new MandatoryTraceEnvelopeError(
        new Error('db down'),
        'primary',
        'medium',
      ),
    );
    // The per-turn positive audience decision is audited first; fail the
    // later mandatory-trace refusal audit that this regression targets.
    audit
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error('audit table unreachable'));
    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await expect(runAgentForMensagem('in1')).rejects.toBeInstanceOf(
      MandatoryTraceEnvelopeError,
    );
  });

  it('REGRESSION: a plain Decision Engine error fails closed instead of reaching ReAct', async () => {
    runDecisionEngineForTurn.mockRejectedValue(
      new Error('postgres unavailable'),
    );
    callLLM.mockResolvedValue({
      content: 'oi',
      tool_uses: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await expect(runAgentForMensagem('in1')).rejects.toThrow(
      'postgres unavailable',
    );

    expect(callLLM).not.toHaveBeenCalled();
    expect(dispatchTool).not.toHaveBeenCalled();
    expect(sendOutboundText).not.toHaveBeenCalled();
    expect(markProcessed).not.toHaveBeenCalled();
    expect(failTurnRetryable).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        code: 'decision_engine_wiring_failed',
        mensagem_id: 'in1',
      }),
    );
  });

  it('fails closed when the production Decision Engine returns no packet', async () => {
    runDecisionEngineForTurn.mockResolvedValue({ engine_ran: false });

    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await expect(runAgentForMensagem('in1')).rejects.toThrow(
      'without an authoritative packet',
    );

    expect(failTurnRetryable).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        code: 'decision_engine_wiring_failed',
        mensagem_id: 'in1',
      }),
    );
    expect(callLLM).not.toHaveBeenCalled();
    expect(sendOutboundText).not.toHaveBeenCalled();
    expect(markProcessed).not.toHaveBeenCalled();
  });

  it('the happy path still reaches the LLM (the block is not unconditional)', async () => {
    runDecisionEngineForTurn.mockResolvedValue(ALLOWING_DECISION);
    callLLM.mockResolvedValue({
      content: 'oi!',
      tool_uses: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');

    expect(callLLM).toHaveBeenCalled();
    expect(sendOutboundText).toHaveBeenCalledTimes(1);
    expect(String(sendOutboundText.mock.calls[0]?.[1] ?? '')).not.toBe(
      FAIL_CLOSED_REPLY,
    );
  });

  it('quarantines an existing conversation when its audience profile is missing', async () => {
    findAudienceProfile.mockResolvedValue(null);
    runDecisionEngineForTurn.mockResolvedValue(ALLOWING_DECISION);
    callLLM.mockResolvedValue({
      content: 'this must never be produced',
      tool_uses: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        acao: 'audience_blocked_no_profile',
        pessoa_id: 'p1',
      }),
    );
    expect(concludeTurn).toHaveBeenCalledWith(
      null,
      'quarantined',
      expect.objectContaining({ pessoa_id: 'p1', mensagem_id: 'in1' }),
    );
    expect(markProcessed).toHaveBeenCalled();
    expect(runDecisionEngineForTurn).not.toHaveBeenCalled();
    expect(callLLM).not.toHaveBeenCalled();
    expect(sendOutboundText).not.toHaveBeenCalled();
  });

  it('blocks an existing conversation whose pessoa is no longer active', async () => {
    dbState.conversaResult = [
      {
        conversas: CONVERSA,
        pessoas: { ...PESSOA, status: 'bloqueada' },
      },
    ];

    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');

    expect(concludeTurn).toHaveBeenCalledWith(
      null,
      'identity_blocked',
      expect.objectContaining({ pessoa_id: 'p1', mensagem_id: 'in1' }),
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        acao: 'identity_status_blocked',
        pessoa_id: 'p1',
        metadata: expect.objectContaining({ pessoa_status: 'bloqueada' }),
      }),
    );
    expect(findAudienceProfile).not.toHaveBeenCalled();
    expect(runDecisionEngineForTurn).not.toHaveBeenCalled();
    expect(callLLM).not.toHaveBeenCalled();
    expect(sendOutboundText).not.toHaveBeenCalled();
  });

  it('quarantines an inactive audience relation instead of serving it', async () => {
    findAudienceProfile.mockResolvedValue({
      ...AUDIENCE_PROFILE,
      status: 'inactive',
    });

    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        acao: 'audience_quarantined',
        metadata: expect.objectContaining({ profile_status: 'inactive' }),
      }),
    );
    expect(concludeTurn).toHaveBeenCalledWith(
      null,
      'quarantined',
      expect.objectContaining({ mensagem_id: 'in1' }),
    );
    expect(runDecisionEngineForTurn).not.toHaveBeenCalled();
  });

  it('retries and propagates when the audience store is unavailable', async () => {
    findAudienceProfile.mockRejectedValue(new Error('audience db unavailable'));

    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await expect(runAgentForMensagem('in1')).rejects.toThrow(
      'audience db unavailable',
    );

    expect(failTurnRetryable).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        code: 'audience_context_resolution_failed',
        mensagem_id: 'in1',
      }),
    );
    expect(markProcessed).not.toHaveBeenCalled();
    expect(runDecisionEngineForTurn).not.toHaveBeenCalled();
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('fails closed for an unknown future pessoa status', async () => {
    dbState.conversaResult = [
      {
        conversas: CONVERSA,
        pessoas: { ...PESSOA, status: 'future_suspended' },
      },
    ];

    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');

    expect(concludeTurn).toHaveBeenCalledWith(
      null,
      'identity_blocked',
      expect.objectContaining({ pessoa_id: 'p1', mensagem_id: 'in1' }),
    );
    expect(findAudienceProfile).not.toHaveBeenCalled();
    expect(runDecisionEngineForTurn).not.toHaveBeenCalled();
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('blocks before the cognitive graph and LLM when the channel policy is absent', async () => {
    getChannelPolicy.mockResolvedValue(null);

    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        acao: 'channel_resolution_failed',
        metadata: expect.objectContaining({
          error_code: 'channel_policy_missing',
        }),
      }),
    );
    expect(concludeTurn).toHaveBeenCalledWith(
      null,
      'blocked_by_policy',
      expect.objectContaining({ pessoa_id: 'p1', mensagem_id: 'in1' }),
    );
    expect(runNodes).not.toHaveBeenCalled();
    expect(runDecisionEngineForTurn).not.toHaveBeenCalled();
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('retries and propagates a channel-policy lookup failure', async () => {
    getChannelPolicy.mockRejectedValue(new Error('policy db unavailable'));

    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await expect(runAgentForMensagem('in1')).rejects.toThrow(
      'policy db unavailable',
    );

    expect(failTurnRetryable).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        code: 'channel_policy_resolution_failed',
        mensagem_id: 'in1',
      }),
    );
    expect(markProcessed).not.toHaveBeenCalled();
    expect(runNodes).not.toHaveBeenCalled();
    expect(runDecisionEngineForTurn).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'the default role is missing',
      arrange: () => getRoleById.mockResolvedValue(null),
      reason: 'channel_default_role_missing',
    },
    {
      name: 'the default role is inactive',
      arrange: () =>
        getRoleById.mockResolvedValue({ ...DEFAULT_ROLE, active: false }),
      reason: 'channel_default_role_inactive',
    },
    {
      name: 'there are no active roles',
      arrange: () => listActiveRoles.mockResolvedValue([]),
      reason: 'channel_roles_unavailable',
    },
    {
      name: 'the role allowlist is malformed',
      arrange: () =>
        getChannelPolicy.mockResolvedValue({
          ...CHANNEL_POLICY,
          allowed_role_ids: 'role-default',
        }),
      reason: 'channel_role_allowlist_invalid',
    },
    {
      name: 'the default role is excluded by the channel allowlist',
      arrange: () =>
        getChannelPolicy.mockResolvedValue({
          ...CHANNEL_POLICY,
          allowed_role_ids: ['role-other'],
        }),
      reason: 'channel_default_role_not_allowed',
    },
    {
      name: 'the default role is absent from the active role set',
      arrange: () =>
        listActiveRoles.mockResolvedValue([
          { ...DEFAULT_ROLE, id: 'role-other' },
        ]),
      reason: 'channel_default_role_not_active',
    },
  ])('blocks before cognition when $name', async ({ arrange, reason }) => {
    arrange();

    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        acao: 'channel_resolution_failed',
        metadata: expect.objectContaining({ error_code: reason }),
      }),
    );
    expect(concludeTurn).toHaveBeenCalledWith(
      null,
      'blocked_by_policy',
      expect.objectContaining({ mensagem_id: 'in1' }),
    );
    expect(runNodes).not.toHaveBeenCalled();
    expect(runDecisionEngineForTurn).not.toHaveBeenCalled();
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('passes only policy-allowed active roles into the selector graph', async () => {
    const allowedRole = {
      ...DEFAULT_ROLE,
      id: 'role-allowed',
      role_key: 'allowed',
    };
    const deniedRole = {
      ...DEFAULT_ROLE,
      id: 'role-denied',
      role_key: 'denied',
    };
    getChannelPolicy.mockResolvedValue({
      ...CHANNEL_POLICY,
      allowed_role_ids: [DEFAULT_ROLE.id, allowedRole.id],
    });
    listActiveRoles.mockResolvedValue([DEFAULT_ROLE, allowedRole, deniedRole]);
    runDecisionEngineForTurn.mockResolvedValue(ALLOWING_DECISION);
    callLLM.mockResolvedValue({
      content: 'ok',
      tool_uses: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');

    expect(runNodes).toHaveBeenCalled();
    const graphContext = runNodes.mock.calls[0]?.[1] as {
      role_inputs?: { available_roles?: Array<{ id: string }> };
    };
    expect(
      graphContext.role_inputs?.available_roles?.map((role) => role.id),
    ).toEqual([DEFAULT_ROLE.id, allowedRole.id]);
  });

  it('completes a visible Decision Engine refusal as a delivered fallback', async () => {
    runDecisionEngineForTurn.mockResolvedValue({
      engine_ran: true,
      result: {
        block: true,
        packet: {
          action_mode: 'respond',
          tool_permissions: {
            allowed_tools: [],
            blocked_tools: [],
            requires_confirmation: [],
          },
          risk_profile: {
            level: 'low',
            reasons: [],
            requires_human_review: false,
          },
          routing: { agent_id: 'primary', candidate_skill_ids: [] },
        },
      },
    });

    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');

    expect(sendOutboundText).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        acao: 'decision_engine_policy_refused',
        mensagem_id: 'in1',
        metadata: expect.objectContaining({ decision: 'block' }),
      }),
    );
    expect(concludeTurn).toHaveBeenCalledWith(
      null,
      'fallback_delivered',
      expect.objectContaining({ mensagem_id: 'in1' }),
    );
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('retries a Decision Engine refusal when delivery fails before commit', async () => {
    runDecisionEngineForTurn.mockResolvedValue({
      engine_ran: true,
      result: {
        block: true,
        packet: {
          action_mode: 'respond',
          tool_permissions: {
            allowed_tools: [],
            blocked_tools: [],
            requires_confirmation: [],
          },
          risk_profile: {
            level: 'low',
            reasons: [],
            requires_human_review: false,
          },
          routing: { agent_id: 'primary', candidate_skill_ids: [] },
        },
      },
    });
    findById.mockResolvedValue(null);

    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await expect(runAgentForMensagem('in1')).rejects.toThrow(
      'pessoa_not_found',
    );

    expect(failTurnRetryable).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        code: 'decision_engine_policy_refusal_not_committed',
        mensagem_id: 'in1',
      }),
    );
    expect(markProcessed).not.toHaveBeenCalled();
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('does not retry a refusal whose channel delivery is ambiguous', async () => {
    runDecisionEngineForTurn.mockResolvedValue({
      engine_ran: true,
      result: {
        block: true,
        packet: {
          action_mode: 'respond',
          tool_permissions: {
            allowed_tools: [],
            blocked_tools: [],
            requires_confirmation: [],
          },
          risk_profile: {
            level: 'low',
            reasons: [],
            requires_human_review: false,
          },
          routing: { agent_id: 'primary', candidate_skill_ids: [] },
        },
      },
    });
    sendOutboundText.mockRejectedValue(
      new Error('transport acknowledgement lost'),
    );

    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');

    expect(failTurnRetryable).not.toHaveBeenCalled();
    expect(concludeTurn).toHaveBeenCalledWith(
      null,
      'reply_delivery_unknown',
      expect.objectContaining({ mensagem_id: 'in1' }),
    );
    expect(markProcessed).toHaveBeenCalled();
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('keeps FIFO closed when fallback delivery fails after the durable commit', async () => {
    const turn = {
      turn_id: 'turn-1',
      status: 'running' as 'running' | 'outbound_pending',
      state_version: 4,
      attempt_count: 1,
      conversa_id: 'c1',
      lease: null,
    };
    ensureTurnHandle.mockResolvedValue(turn);
    runDecisionEngineForTurn.mockResolvedValue({
      engine_ran: true,
      result: {
        block: true,
        packet: {
          action_mode: 'respond',
          tool_permissions: {
            allowed_tools: [],
            blocked_tools: [],
            requires_confirmation: [],
          },
          risk_profile: {
            level: 'low',
            reasons: [],
            requires_human_review: false,
          },
          routing: { agent_id: 'primary', candidate_skill_ids: [] },
        },
      },
    });
    const { OutboundDeliveryError } =
      await import('../../src/agent/output-dispatch.js');
    sendOutboundDelegate.mockImplementation(async () => {
      turn.status = 'outbound_pending';
      turn.state_version += 1;
      throw new OutboundDeliveryError(false, 'post-commit transport failure');
    });

    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await expect(runAgentForMensagem('in1')).rejects.toThrow(
      'post-commit transport failure',
    );

    expect(turn.status).toBe('outbound_pending');
    expect(concludeTurn).not.toHaveBeenCalled();
    expect(failTurnRetryable).not.toHaveBeenCalled();
    expect(markProcessed).not.toHaveBeenCalled();
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('completes a delivered rate-limit warning as fallback_delivered', async () => {
    checkRateLimit.mockResolvedValue({ kind: 'warn', count: 4, threshold: 3 });

    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');

    expect(sendOutboundText).toHaveBeenCalledTimes(1);
    expect(concludeTurn).toHaveBeenCalledWith(
      null,
      'fallback_delivered',
      expect.objectContaining({ mensagem_id: 'in1' }),
    );
    expect(concludeTurn).not.toHaveBeenCalledWith(
      null,
      'rate_limited_silent',
      expect.anything(),
    );
    expect(markProcessed).toHaveBeenCalled();
    expect(runDecisionEngineForTurn).not.toHaveBeenCalled();
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('keeps FIFO closed when a rate-limit warning fails after durable commit', async () => {
    const releaseLease = vi.fn(async () => undefined);
    const turn = {
      turn_id: 'turn-rate-limit',
      status: 'running' as 'running' | 'outbound_pending',
      state_version: 4,
      attempt_count: 1,
      conversa_id: 'c1',
      lease: { context: () => null, release: releaseLease },
    };
    ensureTurnHandle.mockResolvedValue(turn);
    checkRateLimit.mockResolvedValue({ kind: 'warn', count: 4, threshold: 3 });
    const { OutboundDeliveryError } =
      await import('../../src/agent/output-dispatch.js');
    sendOutboundDelegate.mockImplementation(async () => {
      turn.status = 'outbound_pending';
      turn.state_version += 1;
      throw new OutboundDeliveryError(false, 'rate-limit transport deferred');
    });

    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await expect(runAgentForMensagem('in1')).rejects.toThrow(
      'rate-limit transport deferred',
    );

    expect(turn.status).toBe('outbound_pending');
    expect(concludeTurn).not.toHaveBeenCalled();
    expect(failTurnRetryable).not.toHaveBeenCalled();
    expect(markProcessed).not.toHaveBeenCalled();
    expect(runDecisionEngineForTurn).not.toHaveBeenCalled();
    expect(callLLM).not.toHaveBeenCalled();
    expect(releaseLease).toHaveBeenCalledTimes(1);
  });

  it('finishes a rate-limit warning as silent when delivery fails before commit', async () => {
    const turn = {
      turn_id: 'turn-rate-limit-precommit',
      status: 'running' as 'running' | 'outbound_pending',
      state_version: 4,
      attempt_count: 1,
      conversa_id: 'c1',
      lease: null,
    };
    ensureTurnHandle.mockResolvedValue(turn);
    checkRateLimit.mockResolvedValue({ kind: 'warn', count: 4, threshold: 3 });
    const { OutboundDeliveryError } =
      await import('../../src/agent/output-dispatch.js');
    sendOutboundDelegate.mockRejectedValue(
      new OutboundDeliveryError(false, 'rate-limit pre-commit failure'),
    );

    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');

    expect(turn.status).toBe('running');
    expect(concludeTurn).toHaveBeenCalledWith(
      turn,
      'rate_limited_silent',
      expect.objectContaining({ mensagem_id: 'in1' }),
    );
    expect(failTurnRetryable).not.toHaveBeenCalled();
    expect(markProcessed).toHaveBeenCalled();
  });

  it('records ambiguous rate-limit delivery without durable commit', async () => {
    const turn = {
      turn_id: 'turn-rate-limit-ambiguous',
      status: 'running' as 'running' | 'outbound_pending',
      state_version: 4,
      attempt_count: 1,
      conversa_id: 'c1',
      lease: null,
    };
    ensureTurnHandle.mockResolvedValue(turn);
    checkRateLimit.mockResolvedValue({ kind: 'warn', count: 4, threshold: 3 });
    const { OutboundDeliveryError } =
      await import('../../src/agent/output-dispatch.js');
    sendOutboundDelegate.mockRejectedValue(
      new OutboundDeliveryError(true, 'rate-limit acknowledgement unknown'),
    );

    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');

    expect(concludeTurn).toHaveBeenCalledWith(
      turn,
      'reply_delivery_unknown',
      expect.objectContaining({ mensagem_id: 'in1' }),
    );
    expect(failTurnRetryable).not.toHaveBeenCalled();
    expect(markProcessed).toHaveBeenCalled();
  });

  it('records a null rate-limit send result as unknown without durable commit', async () => {
    const turn = {
      turn_id: 'turn-rate-limit-null',
      status: 'running' as 'running' | 'outbound_pending',
      state_version: 4,
      attempt_count: 1,
      conversa_id: 'c1',
      lease: null,
    };
    ensureTurnHandle.mockResolvedValue(turn);
    checkRateLimit.mockResolvedValue({ kind: 'warn', count: 4, threshold: 3 });
    sendOutboundDelegate.mockResolvedValue(null);

    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');

    expect(concludeTurn).toHaveBeenCalledWith(
      turn,
      'reply_delivery_unknown',
      expect.objectContaining({ mensagem_id: 'in1' }),
    );
    expect(markProcessed).toHaveBeenCalled();
  });

  it('keeps FIFO closed when a null rate-limit result follows durable commit', async () => {
    const releaseLease = vi.fn(async () => undefined);
    const turn = {
      turn_id: 'turn-rate-limit-null-committed',
      status: 'running' as 'running' | 'outbound_pending',
      state_version: 4,
      attempt_count: 1,
      conversa_id: 'c1',
      lease: { context: () => null, release: releaseLease },
    };
    ensureTurnHandle.mockResolvedValue(turn);
    checkRateLimit.mockResolvedValue({ kind: 'warn', count: 4, threshold: 3 });
    sendOutboundDelegate.mockImplementation(async () => {
      turn.status = 'outbound_pending';
      turn.state_version += 1;
      return null;
    });

    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await expect(runAgentForMensagem('in1')).rejects.toThrow(
      'rate_limit_delivery_unconfirmed_after_commit',
    );

    expect(concludeTurn).not.toHaveBeenCalled();
    expect(markProcessed).not.toHaveBeenCalled();
    expect(releaseLease).toHaveBeenCalledTimes(1);
  });

  it('keeps a silenced rate-limited turn free of outbound work', async () => {
    checkRateLimit.mockResolvedValue({ kind: 'silence' });

    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');

    expect(sendOutboundText).not.toHaveBeenCalled();
    expect(concludeTurn).toHaveBeenCalledWith(
      null,
      'rate_limited_silent',
      expect.objectContaining({ mensagem_id: 'in1' }),
    );
    expect(markProcessed).toHaveBeenCalled();
  });

  it('stops execute_skill fallthrough after an outbound was committed', async () => {
    const turn = {
      turn_id: 'turn-skill',
      status: 'running' as 'running' | 'outbound_pending',
      state_version: 4,
      attempt_count: 1,
      conversa_id: 'c1',
      lease: null,
    };
    ensureTurnHandle.mockResolvedValue(turn);
    runDecisionEngineForTurn.mockResolvedValue({
      engine_ran: true,
      result: {
        block: false,
        packet: {
          action_mode: 'execute_skill',
          tool_permissions: {
            allowed_tools: [],
            blocked_tools: [],
            requires_confirmation: [],
          },
          risk_profile: {
            level: 'low',
            reasons: [],
            requires_human_review: false,
          },
          routing: {
            agent_id: 'primary',
            candidate_skill_ids: ['skill-1'],
            selected_skill_descriptor: 'faq',
            selected_skill_version: 1,
            selected_skill_id: 'skill-1',
          },
        },
      },
    });
    executeSelectedSkill.mockImplementation(async () => {
      turn.status = 'outbound_pending';
      turn.state_version += 1;
      return { handled: false, reason: 'dispatch_send_failed' };
    });

    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await expect(runAgentForMensagem('in1')).rejects.toThrow(
      'skill_dispatch_failed_after_outbound_commit',
    );

    expect(turn.status).toBe('outbound_pending');
    expect(buildPrompt).not.toHaveBeenCalled();
    expect(callLLM).not.toHaveBeenCalled();
    expect(dispatchTool).not.toHaveBeenCalled();
    expect(concludeTurn).not.toHaveBeenCalled();
    expect(failTurnRetryable).not.toHaveBeenCalled();
    expect(markProcessed).not.toHaveBeenCalled();
    expect(touchConversation).not.toHaveBeenCalled();
  });

  it('defers an unconverged execute_skill send to recovery after durable commit', async () => {
    const releaseLease = vi.fn(async () => undefined);
    const turn = {
      turn_id: 'turn-skill-recovery',
      status: 'running' as 'running' | 'outbound_pending',
      state_version: 4,
      attempt_count: 1,
      conversa_id: 'c1',
      lease: { context: () => null, release: releaseLease },
    };
    ensureTurnHandle.mockResolvedValue(turn);
    runDecisionEngineForTurn.mockResolvedValue({
      engine_ran: true,
      result: {
        block: false,
        packet: {
          action_mode: 'execute_skill',
          tool_permissions: {
            allowed_tools: [],
            blocked_tools: [],
            requires_confirmation: [],
          },
          risk_profile: {
            level: 'low',
            reasons: [],
            requires_human_review: false,
          },
          routing: {
            agent_id: 'primary',
            candidate_skill_ids: ['skill-1'],
            selected_skill_descriptor: 'faq',
            selected_skill_version: 1,
            selected_skill_id: 'skill-1',
          },
        },
      },
    });
    executeSelectedSkill.mockImplementation(async () => {
      turn.status = 'outbound_pending';
      turn.state_version += 1;
      return {
        handled: true,
        recovery_pending: true,
        error: 'skill history persist failed',
      };
    });

    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await expect(runAgentForMensagem('in1')).rejects.toThrow(
      'skill history persist failed',
    );

    expect(turn.status).toBe('outbound_pending');
    expect(concludeTurn).not.toHaveBeenCalled();
    expect(markProcessed).not.toHaveBeenCalled();
    expect(touchConversation).not.toHaveBeenCalled();
    expect(buildPrompt).not.toHaveBeenCalled();
    expect(callLLM).not.toHaveBeenCalled();
    expect(releaseLease).toHaveBeenCalledTimes(1);
  });

  it('records unconverged execute_skill delivery as unknown before durable commit', async () => {
    const turn = {
      turn_id: 'turn-skill-unknown',
      status: 'running' as 'running' | 'outbound_pending',
      state_version: 4,
      attempt_count: 1,
      conversa_id: 'c1',
      lease: null,
    };
    ensureTurnHandle.mockResolvedValue(turn);
    runDecisionEngineForTurn.mockResolvedValue({
      engine_ran: true,
      result: {
        block: false,
        packet: {
          action_mode: 'execute_skill',
          tool_permissions: {
            allowed_tools: [],
            blocked_tools: [],
            requires_confirmation: [],
          },
          risk_profile: {
            level: 'low',
            reasons: [],
            requires_human_review: false,
          },
          routing: {
            agent_id: 'primary',
            candidate_skill_ids: ['skill-1'],
            selected_skill_descriptor: 'faq',
            selected_skill_version: 1,
            selected_skill_id: 'skill-1',
          },
        },
      },
    });
    executeSelectedSkill.mockResolvedValue({
      handled: true,
      recovery_pending: true,
      error: 'skill delivery unknown',
    });

    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');

    expect(concludeTurn).toHaveBeenCalledWith(
      turn,
      'reply_delivery_unknown',
      expect.objectContaining({ mensagem_id: 'in1' }),
    );
    expect(markProcessed).toHaveBeenCalled();
    expect(touchConversation).toHaveBeenCalled();
    expect(buildPrompt).not.toHaveBeenCalled();
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('still lets execute_skill fall through before any outbound commit', async () => {
    const turn = {
      turn_id: 'turn-skill-precommit',
      status: 'running' as 'running' | 'outbound_pending',
      state_version: 4,
      attempt_count: 1,
      conversa_id: 'c1',
      lease: null,
    };
    ensureTurnHandle.mockResolvedValue(turn);
    runDecisionEngineForTurn.mockResolvedValue({
      engine_ran: true,
      result: {
        block: false,
        packet: {
          action_mode: 'execute_skill',
          tool_permissions: {
            allowed_tools: [],
            blocked_tools: [],
            requires_confirmation: [],
          },
          risk_profile: {
            level: 'low',
            reasons: [],
            requires_human_review: false,
          },
          routing: { agent_id: 'primary', candidate_skill_ids: [] },
        },
      },
    });
    executeSelectedSkill.mockResolvedValue({
      handled: false,
      reason: 'dispatch_send_failed',
    });
    callLLM.mockResolvedValue({
      content: 'resposta do ReAct',
      tool_uses: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');

    expect(turn.status).toBe('running');
    expect(buildPrompt).toHaveBeenCalled();
    expect(callLLM).toHaveBeenCalled();
  });

  it('never falls through to ReAct when post-decision finalization fails', async () => {
    runDecisionEngineForTurn.mockResolvedValue({
      engine_ran: true,
      result: {
        block: true,
        packet: {
          action_mode: 'respond',
          tool_permissions: {
            allowed_tools: [],
            blocked_tools: [],
            requires_confirmation: [],
          },
          risk_profile: {
            level: 'low',
            reasons: [],
            requires_human_review: false,
          },
          routing: { agent_id: 'primary', candidate_skill_ids: [] },
        },
      },
    });
    touchConversation.mockRejectedValue(new Error('conversation touch failed'));

    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await expect(runAgentForMensagem('in1')).rejects.toThrow(
      'conversation touch failed',
    );

    expect(sendOutboundText).toHaveBeenCalledTimes(1);
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('keeps the governed default role when the optional preturn graph fails', async () => {
    runNodes.mockRejectedValue(new Error('selector unavailable'));
    runDecisionEngineForTurn.mockResolvedValue(ALLOWING_DECISION);
    callLLM.mockResolvedValue({
      content: 'safe reply',
      tool_uses: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');

    expect(buildPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ activeRole: DEFAULT_ROLE }),
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        acao: 'role_selector_defaulted',
        pessoa_id: 'p1',
        conversa_id: 'c1',
        mensagem_id: 'in1',
        metadata: expect.objectContaining({
          role_id: DEFAULT_ROLE.id,
          role_key: DEFAULT_ROLE.role_key,
          channel_id: 'ch-primary',
          reason: 'preturn_graph_failed',
        }),
      }),
    );
  });

  it('audits the governed default role when the role-selector node returns its fallback', async () => {
    runNodes.mockResolvedValue({
      total_latency_ms: 3,
      nodes: {
        'role-selector': {
          status: 'timeout',
          output: null,
          latency_ms: 3,
          fallback_triggered: true,
        },
      },
    });
    runDecisionEngineForTurn.mockResolvedValue(ALLOWING_DECISION);
    callLLM.mockResolvedValue({
      content: 'safe reply',
      tool_uses: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const { runAgentForMensagem } = await import('../../src/agent/core.js');
    await runAgentForMensagem('in1');

    expect(buildPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ activeRole: DEFAULT_ROLE }),
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        acao: 'role_selector_defaulted',
        metadata: expect.objectContaining({
          reason: 'role_selector_no_result',
          node_status: 'timeout',
          fallback_triggered: true,
        }),
      }),
    );
  });
});
