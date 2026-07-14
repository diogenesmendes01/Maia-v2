/**
 * Issue #268 + Issue #411 — agent/core.ts caller behavior for channel
 * resolution. MULTI_CHANNEL removed: o resolver SEMPRE roda.
 *
 * Antes (legacy): falhas de resolução eram silenciadas via try/catch e o agente
 * seguia processando como `primary/primary`. Isso colapsava buckets de
 * rate-limit entre tenants.
 *
 * Agora (sempre roda o resolver):
 *   - probe com telefone + resolveChannel sucesso (single-tenant) → resolve
 *     para (primary, primary, <primary channel id>); adoção é skipada (resolved
 *     == primary/primary).
 *   - probe com telefone + resolveChannel sucesso (multi-tenant) → adoção CAS
 *     move a row → runWithTenantContext com tenant/agent reais.
 *   - probe com telefone + resolveChannel throw (multi-tenant miss) → emite
 *     audit `channel_resolution_failed` e propaga o erro (BullMQ retry/DLQ).
 *   - probe sem telefone → mantém primary/primary e SEGUE processando (o inner
 *     trata o caso "sem telefone"); NÃO emite audit de falha.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted shared state ──────────────────────────────────────────────────────
const {
  resolveChannelMock,
  isContextPacketV1EnabledMock,
  auditMock,
  loggerMock,
  findMensagemMock,
  adoptToResolvedTenantMock,
  findOwnerByIdCrossTenantMock,
  runWithTenantContextMock,
  buildPromptMock,
  runReActLoopMock,
  probeQueryMock,
} = vi.hoisted(() => {
  const resolveChannelMock = vi.fn();
  const isContextPacketV1EnabledMock = vi.fn();
  const auditMock = vi.fn().mockResolvedValue(undefined);
  const loggerMock = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  };
  const findMensagemMock = vi.fn();
  // [Codex review #311] adoption is now a compare-and-swap returning a boolean
  // (`true` = this call won the swap out of primary/primary). Default the mock
  // to `true` so existing happy-path specs keep exercising the "we adopted it"
  // branch. The dedicated race specs override per-case.
  const adoptToResolvedTenantMock = vi.fn().mockResolvedValue(true);
  const findOwnerByIdCrossTenantMock = vi.fn();
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
    isContextPacketV1EnabledMock,
    auditMock,
    loggerMock,
    findMensagemMock,
    adoptToResolvedTenantMock,
    findOwnerByIdCrossTenantMock,
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

// Both toggles are gone (MULTI_CHANNEL #411, COGNITIVE_GRAPH #412): core.ts no
// longer reads any feature flag and the cognitive graph always runs. This mock
// of the (now-empty) singleton is retained only because core.ts's module graph
// still resolves it transitively; the resolver/adoption behavior under test is
// independent of it. The pre-turn graph is mocked separately below (runNodes /
// buildPreturnNodes), so these specs focus purely on channel resolution.
vi.mock('@/config/feature-flags.js', () => ({
  featureFlags: {
    isEnabled: vi.fn(() => false),
  },
}));

vi.mock('@/governance/audit.js', () => ({ audit: auditMock }));
vi.mock('@/lib/logger.js', () => ({ logger: loggerMock }));

vi.mock('@/db/tenant-context.js', () => ({
  runWithTenantContext: runWithTenantContextMock,
  getCurrentTenant: vi.fn(() => 'primary'),
  getCurrentAgent: vi.fn(() => 'primary'),
  PRIMARY_TENANT_ID: 'primary',
  PRIMARY_AGENT_ID: 'primary',
  isPrimaryContext: (ctx: { tenant_id: string; agent_id: string }) =>
    ctx.tenant_id === 'primary' && ctx.agent_id === 'primary',
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
    adoptToResolvedTenantCrossTenant: adoptToResolvedTenantMock,
    findOwnerByIdCrossTenant: findOwnerByIdCrossTenantMock,
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
// Issue #408 — core.ts computes the LLM-visible set via the Runtime Tool
// Filter. This channel-resolution test doesn't assert on tools; stub it.
vi.mock('@/tools/runtime-filter.js', () => ({
  computeRuntimeVisibleTools: vi.fn(async () => ({
    tools: [],
    requires_confirmation: [],
    grant: { granted_packs: ['baseline.core'], granted_tools: [], denied_tools: [] },
  })),
}));
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
describe('runAgentForMensagem — channel resolution (#268 fail-loud + #411 catch-all)', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Defaults: no packet, healthy mensagem
    isContextPacketV1EnabledMock.mockResolvedValue(false);
    // [Codex review #311] Default adoption to "we won the swap" so the
    // happy-path specs never reach the owner re-check. Race specs override.
    adoptToResolvedTenantMock.mockResolvedValue(true);
    findOwnerByIdCrossTenantMock.mockResolvedValue(null);

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

  it('#411 single-tenant: resolveChannel devolve primary/primary → adoção skipada, segue em primary/primary sem audit de falha', async () => {
    // O catch-all do resolver mapeia o remetente para o canal primary semeado.
    resolveChannelMock.mockResolvedValueOnce({
      tenant_id: 'primary',
      agent_id: 'primary',
      channel_id: 'primary-channel-uuid',
    });

    const { runAgentForMensagem } = await import('@/agent/core.js');
    await runAgentForMensagem('msg1');

    // O resolver SEMPRE roda agora (com telefone na metadata).
    expect(resolveChannelMock).toHaveBeenCalledTimes(1);
    expect(resolveChannelMock).toHaveBeenCalledWith({
      channel_type: 'whatsapp',
      external_id: '+5511888888888',
    });
    // Nenhum audit de falha — resolução bem-sucedida.
    const auditCalls = auditMock.mock.calls.filter(
      (call) => call[0]?.acao === 'channel_resolution_failed',
    );
    expect(auditCalls).toHaveLength(0);
    // resolved == primary/primary → adoção é skipada (sem UPDATE no-op).
    expect(adoptToResolvedTenantMock).not.toHaveBeenCalled();
    // Inner path executou via runWithTenantContext em primary/primary.
    expect(runWithTenantContextMock).toHaveBeenCalled();
    expect(runWithTenantContextMock.mock.calls[0]![0]).toEqual({
      tenant_id: 'primary',
      agent_id: 'primary',
    });
  });

  it('multi-tenant: resolveChannel sucesso → tenant/agent reais, sem audit de falha, adoção chamada ANTES do runWithTenantContext', async () => {
    resolveChannelMock.mockResolvedValueOnce({
      tenant_id: 'tenant-acme',
      agent_id: 'agent-main',
      channel_id: 'ch-abc',
    });

    // Track ordem de chamadas: a adoção tem que rodar ANTES do
    // runWithTenantContext, senão o findById tenant-scoped lá dentro
    // veria a row ainda em primary/primary e retornaria null.
    const callOrder: string[] = [];
    adoptToResolvedTenantMock.mockImplementationOnce(async () => {
      callOrder.push('adopt');
      // [Codex review #311] return true = THIS call won the compare-and-swap
      // out of primary/primary. Without this the caller would treat the
      // adoption as a lost race and reach the owner re-check.
      return true;
    });
    runWithTenantContextMock.mockImplementationOnce(async (_ctx, fn) => {
      callOrder.push('runWithTenantContext');
      return fn();
    });

    const { runAgentForMensagem } = await import('@/agent/core.js');
    await runAgentForMensagem('msg1');

    expect(resolveChannelMock).toHaveBeenCalledTimes(1);
    const failedAudits = auditMock.mock.calls.filter(
      (call) => call[0]?.acao === 'channel_resolution_failed',
    );
    expect(failedAudits).toHaveLength(0);

    // [Codex review #277] Adoção: move row de primary/primary → tenant resolvido
    // ANTES de entrar no contexto tenant-scoped (caso contrário findById retorna
    // null porque baileys persistiu o inbound em primary/primary).
    expect(adoptToResolvedTenantMock).toHaveBeenCalledTimes(1);
    expect(adoptToResolvedTenantMock).toHaveBeenCalledWith({
      id: 'msg1',
      tenant_id: 'tenant-acme',
      agent_id: 'agent-main',
    });
    expect(callOrder).toEqual(['adopt', 'runWithTenantContext']);

    expect(runWithTenantContextMock).toHaveBeenCalled();
    expect(runWithTenantContextMock.mock.calls[0]![0]).toEqual({
      tenant_id: 'tenant-acme',
      agent_id: 'agent-main',
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // [Codex review #311 — CRITICAL P0] cross-tenant adoption race at the caller.
  //
  // adoptToResolvedTenantCrossTenant is a compare-and-swap: it returns `false`
  // when the row was NOT still primary/primary. The caller must then re-check
  // the owner and ONLY proceed when it matches the tenant WE resolved. A row
  // owned by a DIFFERENT tenant must abort the turn (throw + audit) — never
  // run under our resolved context (that is the cross-tenant leak this fix
  // closes).
  // ──────────────────────────────────────────────────────────────────────────
  it('Flag ON + adoção retorna false + row pertence a OUTRO tenant → aborta (throw + audit), NÃO entra em runWithTenantContext', async () => {
    resolveChannelMock.mockResolvedValueOnce({
      tenant_id: 'tenant-B',
      agent_id: 'agent-B',
      channel_id: 'ch-b',
    });
    // We tried to adopt into tenant-B but lost the swap: the row is no longer
    // primary/primary.
    adoptToResolvedTenantMock.mockResolvedValueOnce(false);
    // Cross-tenant owner re-check: the row was already adopted by tenant-A.
    findOwnerByIdCrossTenantMock.mockResolvedValueOnce({
      tenant_id: 'tenant-A',
      agent_id: 'agent-A',
    });

    const { TypedError } = await import('@/lib/utils.js');
    const { runAgentForMensagem } = await import('@/agent/core.js');

    await expect(runAgentForMensagem('msg1')).rejects.toBeInstanceOf(TypedError);

    expect(adoptToResolvedTenantMock).toHaveBeenCalledTimes(1);
    expect(findOwnerByIdCrossTenantMock).toHaveBeenCalledWith('msg1');

    // CRITICAL: the turn must NOT run under tenant-B (the tenant we resolved)
    // because the row belongs to tenant-A. No runWithTenantContext at all.
    expect(runWithTenantContextMock).not.toHaveBeenCalled();

    // A conflict audit is emitted so operators can spot the race.
    const conflictAudits = auditMock.mock.calls.filter(
      (call) =>
        call[0]?.metadata?.error_code === 'cross_tenant_adoption_conflict',
    );
    expect(conflictAudits).toHaveLength(1);
    expect(conflictAudits[0]![0].mensagem_id).toBe('msg1');
    // The audit must NOT carry the foreign owner's tenant/agent (minimal leak
    // surface) — only that an owner was present.
    expect(conflictAudits[0]![0].metadata.owner_present).toBe(true);
    expect(conflictAudits[0]![0].metadata).not.toHaveProperty('owner_tenant_id');
  });

  it('Flag ON + adoção retorna false + row JÁ pertence ao tenant resolvido → idempotente, segue processando', async () => {
    // BullMQ retry: a prior attempt already adopted the row into tenant-acme.
    // The second attempt loses the swap (false) but the owner re-check confirms
    // WE own it → safe to proceed under tenant-acme.
    resolveChannelMock.mockResolvedValueOnce({
      tenant_id: 'tenant-acme',
      agent_id: 'agent-main',
      channel_id: 'ch-abc',
    });
    adoptToResolvedTenantMock.mockResolvedValueOnce(false);
    findOwnerByIdCrossTenantMock.mockResolvedValueOnce({
      tenant_id: 'tenant-acme',
      agent_id: 'agent-main',
    });

    const { runAgentForMensagem } = await import('@/agent/core.js');
    await runAgentForMensagem('msg1');

    expect(findOwnerByIdCrossTenantMock).toHaveBeenCalledWith('msg1');
    // No conflict audit — this is a benign idempotent re-run.
    const conflictAudits = auditMock.mock.calls.filter(
      (call) =>
        call[0]?.metadata?.error_code === 'cross_tenant_adoption_conflict',
    );
    expect(conflictAudits).toHaveLength(0);
    // Proceeds under the tenant we resolved (and that we confirmed we own).
    expect(runWithTenantContextMock).toHaveBeenCalled();
    expect(runWithTenantContextMock.mock.calls[0]![0]).toEqual({
      tenant_id: 'tenant-acme',
      agent_id: 'agent-main',
    });
  });

  it('Flag ON + adoção retorna false + row sumiu (owner null) → aborta (throw + audit), NÃO processa', async () => {
    // Defensive: the row vanished between persist and adoption (GC, manual
    // delete). We must not fabricate a context — abort.
    resolveChannelMock.mockResolvedValueOnce({
      tenant_id: 'tenant-acme',
      agent_id: 'agent-main',
      channel_id: 'ch-abc',
    });
    adoptToResolvedTenantMock.mockResolvedValueOnce(false);
    findOwnerByIdCrossTenantMock.mockResolvedValueOnce(null);

    const { TypedError } = await import('@/lib/utils.js');
    const { runAgentForMensagem } = await import('@/agent/core.js');

    await expect(runAgentForMensagem('msg1')).rejects.toBeInstanceOf(TypedError);
    expect(runWithTenantContextMock).not.toHaveBeenCalled();
    const conflictAudits = auditMock.mock.calls.filter(
      (call) =>
        call[0]?.metadata?.error_code === 'cross_tenant_adoption_conflict',
    );
    expect(conflictAudits).toHaveLength(1);
    expect(conflictAudits[0]![0].metadata.owner_present).toBe(false);
  });

  it('#411 single-tenant: resolveChannel devolve primary/primary → adoção NÃO é chamada (no-op skip)', async () => {
    // O catch-all do resolver (#411) devolve o canal primary semeado para
    // qualquer remetente em runtime single-tenant. Como resolved == primary/
    // primary, NÃO chamamos adoção (seria um UPDATE no-op que polui logs).
    resolveChannelMock.mockResolvedValueOnce({
      tenant_id: 'primary',
      agent_id: 'primary',
      channel_id: 'ch-degenerate',
    });

    const { runAgentForMensagem } = await import('@/agent/core.js');
    await runAgentForMensagem('msg1');

    expect(resolveChannelMock).toHaveBeenCalledTimes(1);
    expect(adoptToResolvedTenantMock).not.toHaveBeenCalled();
    expect(runWithTenantContextMock).toHaveBeenCalled();
    expect(runWithTenantContextMock.mock.calls[0]![0]).toEqual({
      tenant_id: 'primary',
      agent_id: 'primary',
    });
  });

  it('multi-tenant: resolveChannel throw → adoção NÃO é chamada (não há tenant resolvido)', async () => {
    const { TypedError } = await import('@/lib/utils.js');
    resolveChannelMock.mockRejectedValueOnce(
      new TypedError(
        'channel_resolution_failed',
        'channel not found or inactive',
        { resolver_path: 'unknown_or_inactive_channel' },
      ),
    );

    const { runAgentForMensagem } = await import('@/agent/core.js');
    await expect(runAgentForMensagem('msg1')).rejects.toBeInstanceOf(TypedError);

    expect(adoptToResolvedTenantMock).not.toHaveBeenCalled();
  });

  it('multi-tenant: resolveChannel throw → emite audit channel_resolution_failed e propaga o erro', async () => {
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

  it('#411: probe sem telefone → NÃO chama resolveChannel, NÃO emite audit de falha, segue em primary/primary', async () => {
    // Override probe: primeiro call (probeMessageForChannel) retorna mensagem
    // sem telefone na metadata → probe null.
    probeQueryMock.mockResolvedValueOnce([{ metadata: {} }]);

    const { runAgentForMensagem } = await import('@/agent/core.js');
    // NÃO propaga erro — probe-null é tratado como turno single-tenant primary/primary.
    await runAgentForMensagem('msg1');

    // resolveChannel jamais foi chamado — probe null nunca alcança o resolver
    // (e portanto nunca colapsa buckets cross-tenant: nenhum tenant foi resolvido).
    expect(resolveChannelMock).not.toHaveBeenCalled();

    // Nenhum audit de falha — não é mais um erro.
    const failedAudits = auditMock.mock.calls.filter(
      (call) => call[0]?.acao === 'channel_resolution_failed',
    );
    expect(failedAudits).toHaveLength(0);

    // adoção skipada (resolved == primary/primary) e o inner roda em primary/primary.
    expect(adoptToResolvedTenantMock).not.toHaveBeenCalled();
    expect(runWithTenantContextMock).toHaveBeenCalled();
    expect(runWithTenantContextMock.mock.calls[0]![0]).toEqual({
      tenant_id: 'primary',
      agent_id: 'primary',
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // [🔴 HIGH fix #417] probe DB read FAILURE must fail-closed (NOT collapse to
  // primary/primary). Before the fix, `probeMessageForChannel`'s blanket
  // `catch { return null }` mapped a transient DB error to the SAME null used
  // for "no telefone". Since the resolver only runs when the probe is truthy, a
  // DB error skipped resolver + adoption and routed a possibly-multi-tenant
  // message straight to the `primary/primary` bucket — a silent #268 violation.
  //
  // This negative spec drives the probe's `db.select()...limit()` to REJECT and
  // asserts: (a) we do NOT silently process under primary/primary; (b) the
  // error propagates (BullMQ retry/DLQ); (c) a `channel_resolution_failed`
  // audit is emitted with the distinguishable `channel_probe_failed` code; and
  // (d) the resolver is never consulted (no tenant was resolved).
  // ──────────────────────────────────────────────────────────────────────────
  it('#417 HIGH: probe com ERRO DE DB → fail-closed (propaga, audita channel_probe_failed, NÃO cai em primary/primary)', async () => {
    // The probe's metadata read is the FIRST (and here only) `.limit()` call —
    // make it reject (DB blip). Persisted (not Once) so a single invocation
    // can't accidentally fall through to a stale default.
    probeQueryMock.mockReset();
    const dbErr = new Error('connection terminated unexpectedly');
    probeQueryMock.mockRejectedValue(dbErr);

    const { TypedError } = await import('@/lib/utils.js');
    const { runAgentForMensagem } = await import('@/agent/core.js');

    // (b) the error propagates — the worker fails the job (retry/DLQ), it does
    //     NOT swallow the failure and continue. Capture it once and assert both
    //     the type and the distinguishable code.
    let caught: unknown;
    try {
      await runAgentForMensagem('msg1');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TypedError);
    expect((caught as { code?: string }).code).toBe('channel_probe_failed');

    // (d) the resolver was never reached — a DB error must not be confused with
    //     "no telefone" (which would skip the resolver legitimately).
    expect(resolveChannelMock).not.toHaveBeenCalled();

    // (a) fail-closed: we never entered a tenant context (no silent
    //     primary/primary routing) and never adopted anything.
    expect(runWithTenantContextMock).not.toHaveBeenCalled();
    expect(adoptToResolvedTenantMock).not.toHaveBeenCalled();

    // (c) a fail-closed audit is emitted, distinguishable from a resolver miss
    //     by the `channel_probe_failed` error_code.
    const failedAudits = auditMock.mock.calls.filter(
      (call) => call[0]?.acao === 'channel_resolution_failed',
    );
    expect(failedAudits.length).toBeGreaterThanOrEqual(1);
    const auditPayload = failedAudits[0]![0];
    expect(auditPayload.mensagem_id).toBe('msg1');
    expect(auditPayload.metadata.error_code).toBe('channel_probe_failed');
    // The probe never produced a telefone, so probe context is null.
    expect(auditPayload.metadata.probe_external_id).toBeNull();
    expect(auditPayload.metadata.resolver_details).toMatchObject({
      resolver_path: 'probe_db_error',
    });
  });
});
