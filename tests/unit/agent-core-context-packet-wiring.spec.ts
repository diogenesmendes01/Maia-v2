/**
 * P8a — agent/core.ts context-packet wiring tests.
 *
 * Four tests verify the dual-path callsite added at ~line 711 of core.ts:
 *   T1 (flag off)       → legacy buildPrompt called; buildContextPacket NOT called.
 *   T2 (flag on)        → buildContextPacket + buildPromptFromPacket called; legacy NOT called.
 *   T3 (kill switch)    → kill switch wins → legacy path used.
 *   T4 (error fallback) → buildContextPacket throws → falls back to legacy + warns.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted shared state ──────────────────────────────────────────────────────
const { packetState, loggerMock, findMensagemMock, buildContextPacketMock, buildPromptFromPacketMock, isContextPacketV1EnabledMock } = vi.hoisted(() => {
  const findMensagemMock = vi.fn();
  const buildContextPacketMock = vi.fn();
  const buildPromptFromPacketMock = vi.fn();
  const isContextPacketV1EnabledMock = vi.fn();
  const loggerMock = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  };
  const packetState = {
    flagEnabled: false as boolean,
    throwError: null as Error | null,
  };
  return { packetState, loggerMock, findMensagemMock, buildContextPacketMock, buildPromptFromPacketMock, isContextPacketV1EnabledMock };
});

// ─── P8a module mocks ─────────────────────────────────────────────────────────
vi.mock('@/runtime/feature-flags/context-packet-flag.js', () => ({
  isContextPacketV1Enabled: isContextPacketV1EnabledMock,
}));

vi.mock('@/runtime/context-packet/build-context-packet.js', () => ({
  buildContextPacket: buildContextPacketMock,
}));

vi.mock('@/runtime/prompt/build-prompt-from-packet.js', () => ({
  buildPromptFromPacket: buildPromptFromPacketMock,
}));

vi.mock('@/runtime/context-packet/decision-packet-stub.js', () => ({
  createDecisionPacketStub: vi.fn((base: unknown) => ({
    ...base as object,
    context_requirements: {
      identity: {},
      user: {},
      knowledge: {},
      soul: {},
      policy: {},
      skill: {},
      history: { depth: 'none' },
    },
    routing: { agent_id: 'default', candidate_skill_ids: [] },
    tool_permissions: { allowed_tools: [], blocked_tools: [], requires_confirmation: [] },
    policy_decisions: [],
    intent: { label: 'default_flow', confidence: 0.5, alternatives: [] },
    risk_profile: { level: 'low', reasons: [], requires_human_review: false },
    action_mode: 'respond',
    evaluation_plan: { validators: [], llm_judge_required: false, human_review_required: false },
    rationale: 'stub',
  })),
}));

vi.mock('@/runtime/context-packet/production-builder-set.js', () => ({
  getProductionBuilderSet: vi.fn(() => ({ builders: {}, cache: {} })),
}));

// ─── Infrastructure mocks ──────────────────────────────────────────────────────
const buildPromptMock = vi.fn();
const runReActLoopMock = vi.fn();

vi.mock('@/lib/logger.js', () => ({ logger: loggerMock }));

vi.mock('@/agent/prompt-builder.js', () => ({
  buildPrompt: buildPromptMock,
  PROMPT_TOKEN_BUDGET_INPUT: 11000,
  PROMPT_TOKEN_BUDGET_OUTPUT: 1024,
}));

vi.mock('@/agent/react-loop.js', () => ({
  runReActLoop: runReActLoopMock,
}));

vi.mock('@/db/repositories.js', () => ({
  mensagensRepo: {
    findById: findMensagemMock,
    markProcessed: vi.fn().mockResolvedValue(undefined),
    setConversaId: vi.fn().mockResolvedValue(undefined),
    setConversaIdMany: vi.fn().mockResolvedValue(undefined),
    listUnprocessedByTelefone: vi.fn().mockResolvedValue([]),
  },
  conversasRepo: {
    touch: vi.fn().mockResolvedValue(undefined),
    mergeMetadata: vi.fn().mockResolvedValue(undefined),
  },
  procedureExecutionsRepo: {
    findActiveForConversa: vi.fn().mockResolvedValue(null),
    findById: vi.fn().mockResolvedValue(null),
  },
  procedureDefinitionsRepo: { findById: vi.fn().mockResolvedValue(null) },
  procedureSelectorDecisionsRepo: { record: vi.fn().mockResolvedValue(undefined) },
  channelPoliciesRepo: { getByChannelId: vi.fn().mockResolvedValue(null) },
  rolesRepo: { listActive: vi.fn().mockResolvedValue([]), getById: vi.fn().mockResolvedValue(null) },
  pendingQuestionsRepo: { findActiveSnapshot: vi.fn().mockResolvedValue(null) },
  pessoasRepo: { findById: vi.fn(), findByPhone: vi.fn().mockResolvedValue(null) },
}));

vi.mock('@/db/client.js', () => {
  const fakeQuery = {
    select: () => fakeQuery,
    from: () => fakeQuery,
    innerJoin: () => fakeQuery,
    where: () => fakeQuery,
    limit: () =>
      Promise.resolve([
        {
          conversas: { id: 'c1', pessoa_id: 'p1', status: 'ativa', metadata: {} },
          pessoas: {
            id: 'p1',
            telefone_whatsapp: '+5511888888888',
            nome: 'Usr',
            tipo: 'owner',
            preferencias: {},
          },
        },
      ]),
  };
  return {
    db: { select: () => fakeQuery },
    withTx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
  };
});

vi.mock('@/db/schema.js', () => ({
  conversas: {},
  pessoas: {},
  mensagens: { metadata: {}, id: {}, created_at: {} },
}));
vi.mock('drizzle-orm', () => ({ eq: () => ({}) }));

vi.mock('@/db/tenant-context.js', () => ({
  runWithTenantContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  getCurrentTenant: vi.fn(() => 'default'),
  getCurrentAgent: vi.fn(() => 'default'),
}));

vi.mock('@/governance/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/governance/permissions.js', () => ({
  resolveScope: vi.fn().mockResolvedValue({ entidades: [], byEntity: new Map() }),
}));
vi.mock('@/gateway/rate-limit.js', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ kind: 'allow' }),
  formatPoliteReply: vi.fn(),
}));
vi.mock('@/gateway/presence.js', () => ({
  startTyping: vi.fn(() => ({ stop: vi.fn() })),
  sendReaction: vi.fn(),
  quotedReplyContext: vi.fn(),
  sendPoll: vi.fn(),
}));
vi.mock('@/gateway/debouncer.js', () => ({
  clearDebounceState: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/gateway/channel-resolver.js', () => ({
  resolveChannel: vi.fn().mockResolvedValue({
    tenant_id: 'default',
    agent_id: 'default',
    channel_id: null,
  }),
}));

vi.mock('@/config/feature-flags.js', () => ({
  featureFlags: { isEnabled: vi.fn(() => false) },
}));
vi.mock('@/config/env.js', () => ({
  config: new Proxy({} as Record<string, unknown>, {
    get(_t, prop) {
      if (prop === 'OWNER_TELEFONE_WHATSAPP') return '+5511999999999';
      if (prop === 'FEATURE_MESSAGE_DEBOUNCE') return false;
      if (prop === 'FEATURE_SCHEDULING_V2') return false;
      return undefined;
    },
  }),
}));

vi.mock('@/identity/resolver.js', () => ({ resolveIdentity: vi.fn() }));
vi.mock('@/identity/quarantine.js', () => ({
  handleQuarantineFirstContact: vi.fn(),
  handleOwnerIdentityReply: vi.fn(),
}));
vi.mock('@/agent/pending-gate.js', () => ({
  checkPendingFirst: vi.fn().mockResolvedValue({ kind: 'no_pending' }),
}));
vi.mock('@/agent/reflection.js', () => ({
  detectCorrection: vi.fn().mockReturnValue(false),
  reflectOnCorrection: vi.fn(),
  findPreviousAssistantMessage: vi.fn(),
}));
vi.mock('@/agent/success-detector.js', () => ({
  detectSuccess: vi.fn().mockReturnValue(false),
}));
vi.mock('@/agent/scope-hash.js', () => ({ hashScope: vi.fn(() => 'hash-x') }));
vi.mock('@/agent/output-dispatch.js', () => ({ sendOutbound: vi.fn().mockResolvedValue('WAID') }));
vi.mock('@/tools/_registry.js', () => ({ getToolSchemas: vi.fn(() => []) }));
vi.mock('@/lib/claude.js', () => ({ callLLM: vi.fn() }));
vi.mock('@/cognition/procedure-selector.js', () => ({
  selectProcedure: vi.fn().mockResolvedValue({
    decision: 'none',
    candidates: [],
    conflicts: [],
    selected_procedure_id: null,
    reason: '',
  }),
}));
vi.mock('@/cognition/role-selector/engine.js', () => ({ selectRole: vi.fn() }));
vi.mock('@/cognition/reflector.js', () => ({ reflect: vi.fn() }));
vi.mock('@/cognition/classifier.js', () => ({ classify: vi.fn() }));
vi.mock('@/cognition/persister.js', () => ({ persistCandidate: vi.fn() }));
vi.mock('@/cognition/capability-tracker.js', () => ({ recordSuccess: vi.fn() }));
vi.mock('@/cognition/step-evaluator.js', () => ({ evaluateCurrentStep: vi.fn() }));
vi.mock('@/procedures/engine.js', () => ({
  startExecution: vi.fn(),
  abortExecution: vi.fn(),
  completeExecution: vi.fn(),
  advanceStep: vi.fn(),
  recordEvent: vi.fn(),
  recordToolCalled: vi.fn(),
  recordCriterionChecked: vi.fn(),
}));
vi.mock('@/cognitive-graph/orchestrator.js', () => ({
  runNodes: vi.fn().mockResolvedValue({ nodes: {} }),
}));
vi.mock('@/cognitive-graph/preturn-graph.js', () => ({ buildPreturnNodes: vi.fn(() => []) }));
vi.mock('@/cognitive-graph/postturn-graph.js', () => ({ buildPostturnNodes: vi.fn(() => []) }));

// ─── Fixture ───────────────────────────────────────────────────────────────────
const INBOUND = {
  id: 'msg1',
  conversa_id: 'c1',
  direcao: 'in' as const,
  tipo: 'texto' as const,
  conteudo: 'oi',
  metadata: {
    whatsapp_id: 'WA-IN',
    remote_jid: '+5511888888888@s.whatsapp.net',
    telefone: '+5511888888888',
  },
  processada_em: null,
  created_at: new Date(),
};

/** Minimal valid packet returned by the mock when buildContextPacket succeeds. */
const FAKE_PACKET = {
  trace_id: 'tr1',
  tenant_id: 'default',
  agent_id: 'default',
  conversation_id: 'c1',
  base_ref: 'base',
  decision_ref: 'dec',
  identity: {
    role_descriptor: '',
    voice: { tone: '', formality: 'medium', verbosity: 'concise' },
    cognitive_limits: {
      max_inference_depth: 0,
      max_speculation_in_response: 0,
      confidence_floor_for_action: 0.5,
    },
    priorities: [],
    learned_voice_modifiers: [],
    schema_version: 'v3',
    version_id: '',
  },
  user: { pessoa: null, preferences: {}, memories: [], behavioral_hints: [], truncated: false },
  knowledge: { facts: [], rules: [], truncated: { facts: false, rules: false } },
  soul: {
    active_biases: [],
    rendered_block: null,
    total_active: 0,
    truncated_to: 0,
    cache_key: '',
    resolved_at: new Date(0),
  },
  policy: {
    applicable_rules: [],
    truncated: false,
    version: 'v0',
    policy_id: 'p0',
    evaluated_at: new Date(0),
  },
  skill: { mode: 'candidates', selected_skill: null, candidate_skills: [] },
  tool: { available_tools: [], blocked_tools: [], requires_confirmation: [] },
  history: { turns: [], truncated: false },
  assembly_meta: {
    started_at_ms: 0,
    finished_at_ms: 0,
    duration_ms: 5,
    cache_hits: {},
    fallback_depths_applied: {},
    builder_durations_ms: {},
  },
};

// ─── Tests ─────────────────────────────────────────────────────────────────────
describe('agent/core.ts — P8a context-packet wiring (T1–T4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Reset packet state defaults
    packetState.flagEnabled = false;
    packetState.throwError = null;

    // Flag mock reads packetState.flagEnabled
    isContextPacketV1EnabledMock.mockImplementation(async () => packetState.flagEnabled);

    // Packet builder succeeds by default (or throws if packetState.throwError is set)
    buildContextPacketMock.mockImplementation(async () => {
      if (packetState.throwError) throw packetState.throwError;
      return FAKE_PACKET;
    });

    // Packet renderer returns a system+messages shape
    buildPromptFromPacketMock.mockReturnValue({
      system: 'packet-system',
      messages: [],
    });

    // Legacy builder returns a valid prompt
    buildPromptMock.mockResolvedValue({
      system: 'legacy-system',
      messages: [{ role: 'user', content: 'oi' }],
    });

    // ReAct loop resolves cleanly
    runReActLoopMock.mockResolvedValue({
      totalTokens: 10,
      outboundText: 'resposta',
      toolsCalled: [],
    });

    // Inbound message lookup
    findMensagemMock.mockResolvedValue({ ...INBOUND });
  });

  /**
   * T1 — Flag OFF: the legacy buildPrompt is called exactly once;
   * buildContextPacket and buildPromptFromPacket are NOT called.
   */
  it('T1 (flag off): legacy buildPrompt called once; buildContextPacket not called', async () => {
    packetState.flagEnabled = false;

    const { runAgentForMensagem } = await import('@/agent/core.js');
    await runAgentForMensagem('msg1');

    expect(buildContextPacketMock).not.toHaveBeenCalled();
    expect(buildPromptFromPacketMock).not.toHaveBeenCalled();
    expect(buildPromptMock).toHaveBeenCalledTimes(1);
  });

  /**
   * T2 — Flag ON (kill switch off): buildContextPacket + buildPromptFromPacket
   * are each called once; legacy buildPrompt is NOT called.
   */
  it('T2 (flag on): buildContextPacket + buildPromptFromPacket called; legacy not called', async () => {
    packetState.flagEnabled = true;

    const { runAgentForMensagem } = await import('@/agent/core.js');
    await runAgentForMensagem('msg1');

    expect(buildContextPacketMock).toHaveBeenCalledTimes(1);
    expect(buildPromptFromPacketMock).toHaveBeenCalledTimes(1);
    expect(buildPromptMock).not.toHaveBeenCalled();
  });

  /**
   * T3 — Kill switch ON (flag also on): isContextPacketV1Enabled returns false
   * (kill switch precedence) → legacy path is used; buildContextPacket NOT called.
   *
   * In production the kill switch is checked inside isContextPacketV1Enabled.
   * Here we simulate that by having the mock return false even when the "flag"
   * would otherwise be on — this is exactly the observable behaviour of the
   * kill switch: isContextPacketV1Enabled returns false, so core.ts takes the
   * else branch.
   */
  it('T3 (kill switch): kill switch wins; legacy path used; buildContextPacket not called', async () => {
    // Simulate kill switch: flag is notionally "on" but the function returns false.
    packetState.flagEnabled = false;
    isContextPacketV1EnabledMock.mockResolvedValue(false);

    const { runAgentForMensagem } = await import('@/agent/core.js');
    await runAgentForMensagem('msg1');

    expect(buildContextPacketMock).not.toHaveBeenCalled();
    expect(buildPromptMock).toHaveBeenCalledTimes(1);
  });

  /**
   * T4 — Error fallback: flag ON + buildContextPacket throws → falls back to
   * legacy buildPrompt + logs a warn with the fallback message key.
   */
  it('T4 (error fallback): buildContextPacket throws → legacy called + warn logged', async () => {
    packetState.flagEnabled = true;
    packetState.throwError = new Error('slice builder exploded');

    const { runAgentForMensagem } = await import('@/agent/core.js');
    await runAgentForMensagem('msg1');

    // Packet path was attempted …
    expect(buildContextPacketMock).toHaveBeenCalledTimes(1);
    // … but the render step was never reached (threw before it)
    expect(buildPromptFromPacketMock).not.toHaveBeenCalled();
    // Fell back to legacy
    expect(buildPromptMock).toHaveBeenCalledTimes(1);
    // Warn logged with the fallback key
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'slice builder exploded' }),
      'agent.context_packet_path_failed_fallback_legacy',
    );
  });
});
