/**
 * Issue #268 — agent/core.ts caller behavior for channel resolution.
 *
 * Antes (legacy): falhas de resolução eram silenciadas via try/catch e o agente
 * seguia processando como `default/default`. Isso colapsava buckets de
 * rate-limit entre tenants.
 *
 * Agora:
 *   - Flag OFF (MULTI_CHANNEL=false)         → não chama resolveChannel, segue
 *                                              em modo legacy default/default
 *                                              (preservado de P0..P5).
 *   - Flag ON + resolveChannel sucesso       → passa pelo runWithTenantContext
 *                                              com tenant/agent reais, sem
 *                                              audit de falha.
 *   - Flag ON + resolveChannel throw         → emite audit
 *                                              `channel_resolution_failed` e
 *                                              propaga o erro (BullMQ
 *                                              retry/DLQ).
 *   - Flag ON + probe sem tel                → emite audit + propaga
 *                                              `channel_resolution_failed`
 *                                              com resolver_path:
 *                                              "probe_missing_metadata".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted shared state ──────────────────────────────────────────────────────
const {
  resolveChannelMock,
  isMultiChannelOn,
  isContextPacketV1EnabledMock,
  auditMock,
  loggerMock,
  findMensagemMock,
  runWithTenantContextMock,
  buildPromptMock,
  runReActLoopMock,
  probeQueryMock,
} = vi.hoisted(() => {
  const resolveChannelMock = vi.fn();
  const isMultiChannelOn = { value: false };
  const isContextPacketV1EnabledMock = vi.fn();
  const auditMock = vi.fn().mockResolvedValue(undefined);
  const loggerMock = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  };
  const findMensagemMock = vi.fn();
  const runWithTenantContextMock = vi.fn(
    async (_ctx: unknown, fn: () => Promise<unknown>) => fn(),
  );
  const buildPromptMock = vi.fn();
  const runReActLoopMock = vi.fn();
  // Mock para o `db.select().from().where().limit()` chain — uma .limit() por chamada.
  // O caller faz primeiro o `probeMessageForChannel` (1 chamada), depois o
  // `runAgentForMensagemInner` faz outra (1 chamada). Cada teste configura.
  const probeQueryMock = vi.fn();
  return {
    resolveChannelMock,
    isMultiChannelOn,
    isContextPacketV1EnabledMock,
    auditMock,
    loggerMock,
    findMensagemMock,
    runWithTenantContextMock,
    buildPromptMock,
    runReActLoopMock,
    probeQueryMock,
  };
});

// ─── Mocks ─────────────────────────────────────────────────────────────────────
vi.mock('@/gateway/channel-resolver.js', () => ({
  resolveChannel: resolveChannelMock,
}));

vi.mock('@/config/feature-flags.js', () => ({
  featureFlags: {
    isEnabled: vi.fn(() => isMultiChannelOn.value),
  },
}));

vi.mock('@/governance/audit.js', () => ({ audit: auditMock }));
vi.mock('@/lib/logger.js', () => ({ logger: loggerMock }));

vi.mock('@/db/tenant-context.js', () => ({
  runWithTenantContext: runWithTenantContextMock,
  getCurrentTenant: vi.fn(() => 'default'),
  getCurrentAgent: vi.fn(() => 'default'),
}));

vi.mock('@/agent/prompt-builder.js', () => ({
  buildPrompt: buildPromptMock,
  PROMPT_TOKEN_BUDGET_INPUT: 11000,
  PROMPT_TOKEN_BUDGET_OUTPUT: 1024,
}));

vi.mock('@/agent/react-loop.js', () => ({ runReActLoop: runReActLoopMock }));

vi.mock('@/runtime/feature-flags/context-packet-flag.js', () => ({
  isContextPacketV1Enabled: isContextPacketV1EnabledMock,
}));

vi.mock('@/runtime/context-packet/build-context-packet.js', () => ({
  buildContextPacket: vi.fn(),
}));
vi.mock('@/runtime/prompt/build-prompt-from-packet.js', () => ({
  buildPromptFromPacket: vi.fn(),
}));
vi.mock('@/runtime/context-packet/decision-packet-stub.js', () => ({
  createDecisionPacketStub: vi.fn(),
}));
vi.mock('@/runtime/context-packet/production-builder-set.js', () => ({
  getProductionBuilderSet: vi.fn(() => ({ builders: {}, cache: {} })),
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
  skillsRepo: {},
}));

vi.mock('@/db/client.js', () => {
  // Chain do drizzle: db.select().from().where().limit() — cada .limit()
  // resolve a uma promise. Por padrão devolve um row mínimo com metadata
  // contendo telefone — testes específicos override via probeQueryMock.
  const fakeQuery: Record<string, unknown> = {};
  fakeQuery.select = () => fakeQuery;
  fakeQuery.from = () => fakeQuery;
  fakeQuery.innerJoin = () => fakeQuery;
  fakeQuery.where = () => fakeQuery;
  fakeQuery.limit = () => probeQueryMock();
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
vi.mock('@/agent/output-dispatch.js', () => ({
  sendOutbound: vi.fn().mockResolvedValue('WAID'),
  safeDispatchOutput: vi.fn(),
}));
vi.mock('@/agent/execute-skill.js', () => ({ executeSelectedSkill: vi.fn() }));
vi.mock('@/skills/index.js', () => ({ runSkill: vi.fn() }));
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

// ─── Tests ─────────────────────────────────────────────────────────────────────
describe('runAgentForMensagem — channel resolution fail-loud (issue #268)', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Defaults: flag OFF, no packet, healthy mensagem
    isMultiChannelOn.value = false;
    isContextPacketV1EnabledMock.mockResolvedValue(false);

    findMensagemMock.mockResolvedValue({
      id: 'msg1',
      conversa_id: 'c1',
      direcao: 'in',
      tipo: 'texto',
      conteudo: 'oi',
      metadata: { telefone: '+5511888888888' },
      processada_em: null,
      created_at: new Date(),
    });

    // Default probe behavior: return mensagem com telefone, depois rows do
    // join interno em runAgentForMensagemInner. Cada teste pode overrideá-las
    // via probeQueryMock.mockResolvedValueOnce(...).
    probeQueryMock.mockResolvedValue([
      {
        // probeMessageForChannel format
        metadata: { telefone: '+5511888888888' },
        // runAgentForMensagemInner join format
        conversas: { id: 'c1', pessoa_id: 'p1', status: 'ativa', metadata: {} },
        pessoas: {
          id: 'p1',
          telefone_whatsapp: '+5511888888888',
          nome: 'Usr',
          tipo: 'owner',
          preferencias: {},
        },
      },
    ]);

    buildPromptMock.mockResolvedValue({
      system: 'legacy-system',
      messages: [{ role: 'user', content: 'oi' }],
    });
    runReActLoopMock.mockResolvedValue({
      totalTokens: 10,
      outboundText: 'resposta',
      toolsCalled: [],
    });
  });

  it('Flag OFF → não chama resolveChannel, não emite audit de falha, segue legacy default/default', async () => {
    isMultiChannelOn.value = false;

    const { runAgentForMensagem } = await import('@/agent/core.js');
    await runAgentForMensagem('msg1');

    expect(resolveChannelMock).not.toHaveBeenCalled();
    // O audit `channel_resolution_failed` NUNCA deve ser emitido em modo legacy.
    const auditCalls = auditMock.mock.calls.filter(
      (call) => call[0]?.acao === 'channel_resolution_failed',
    );
    expect(auditCalls).toHaveLength(0);
    // Inner path executou via runWithTenantContext em default/default.
    expect(runWithTenantContextMock).toHaveBeenCalled();
    expect(runWithTenantContextMock.mock.calls[0]![0]).toEqual({
      tenant_id: 'default',
      agent_id: 'default',
    });
  });

  it('Flag ON + resolveChannel sucesso → tenant/agent reais, sem audit de falha', async () => {
    isMultiChannelOn.value = true;
    resolveChannelMock.mockResolvedValueOnce({
      tenant_id: 'tenant-acme',
      agent_id: 'agent-main',
      channel_id: 'ch-abc',
    });

    const { runAgentForMensagem } = await import('@/agent/core.js');
    await runAgentForMensagem('msg1');

    expect(resolveChannelMock).toHaveBeenCalledTimes(1);
    const failedAudits = auditMock.mock.calls.filter(
      (call) => call[0]?.acao === 'channel_resolution_failed',
    );
    expect(failedAudits).toHaveLength(0);
    expect(runWithTenantContextMock).toHaveBeenCalled();
    expect(runWithTenantContextMock.mock.calls[0]![0]).toEqual({
      tenant_id: 'tenant-acme',
      agent_id: 'agent-main',
    });
  });

  it('Flag ON + resolveChannel throw → emite audit channel_resolution_failed e propaga o erro', async () => {
    isMultiChannelOn.value = true;
    const { TypedError } = await import('@/lib/utils.js');
    const resolverErr = new TypedError(
      'channel_resolution_failed',
      'channel not found or inactive',
      { resolver_path: 'unknown_or_inactive_channel', found: false, active: false },
    );
    resolveChannelMock.mockRejectedValueOnce(resolverErr);

    const { runAgentForMensagem } = await import('@/agent/core.js');

    // O erro DEVE propagar (BullMQ marca o job como failed → retry/DLQ).
    await expect(runAgentForMensagem('msg1')).rejects.toBeInstanceOf(TypedError);

    // Audit emitido com contexto suficiente para triagem.
    const failedAudits = auditMock.mock.calls.filter(
      (call) => call[0]?.acao === 'channel_resolution_failed',
    );
    expect(failedAudits).toHaveLength(1);
    const auditPayload = failedAudits[0]![0];
    expect(auditPayload.mensagem_id).toBe('msg1');
    expect(auditPayload.metadata.error_code).toBe('channel_resolution_failed');
    expect(auditPayload.metadata.probe_external_id).toBe('+5511888888888');
    expect(auditPayload.metadata.probe_channel_type).toBe('whatsapp');
    expect(auditPayload.metadata.resolver_details).toMatchObject({
      resolver_path: 'unknown_or_inactive_channel',
    });

    // Inner path NÃO deve executar — não houve runWithTenantContext após o throw.
    expect(runWithTenantContextMock).not.toHaveBeenCalled();
  });

  it('Flag ON + probe sem tel → audit channel_resolution_failed com resolver_path "probe_missing_metadata" + propaga erro', async () => {
    isMultiChannelOn.value = true;

    // Override probe: primeiro call (probeMessageForChannel) retorna mensagem
    // sem telefone na metadata.
    probeQueryMock.mockResolvedValueOnce([{ metadata: {} }]);

    const { TypedError } = await import('@/lib/utils.js');
    const { runAgentForMensagem } = await import('@/agent/core.js');

    await expect(runAgentForMensagem('msg1')).rejects.toBeInstanceOf(TypedError);

    // resolveChannel jamais foi chamado — falhou antes (probe null).
    expect(resolveChannelMock).not.toHaveBeenCalled();

    const failedAudits = auditMock.mock.calls.filter(
      (call) => call[0]?.acao === 'channel_resolution_failed',
    );
    expect(failedAudits).toHaveLength(1);
    const auditPayload = failedAudits[0]![0];
    expect(auditPayload.metadata.error_code).toBe('channel_resolution_failed');
    expect(auditPayload.metadata.resolver_details).toMatchObject({
      resolver_path: 'probe_missing_metadata',
    });
    // probe_external_id é null porque probe falhou ANTES de obter o tel.
    expect(auditPayload.metadata.probe_external_id).toBeNull();
  });
});
