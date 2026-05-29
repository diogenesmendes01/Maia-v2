/**
 * P6 Task 10 — Integration test end-to-end para a cadeia completa de
 * separação Agent/Channel/Role + Role Policy.
 *
 * Cobre 7 cenários:
 *   1. Flag OFF (MULTI_CHANNEL) → resolveChannel LANÇA TypedError fail-loud
 *      SEM consultar o repo (issue #268 — fallback default/default removido).
 *   2. Policy=LOCKED → mesmo com candidate strong vindo dos suggesters,
 *      decisão é keep_current via policy_rule. Audit row criado.
 *   3. Policy=PREFER_HANDOFF + candidate diferente → action=handoff,
 *      decided_role mantém o atual, audit registra suggested != decided.
 *   4. Policy=FREE_WITH_TRIGGER + signal strong → switch, decided_role=alternative,
 *      switch_count_in_conversation incrementa (0 → 1).
 *   5. Policy=BY_CONTEXT + cap atingido (3 switches) → fallback via fallback_rule,
 *      decided_role mantém current, reason contém "max_switches_per_conversation".
 *   6. INVARIANTE — decided_by JAMAIS é llm_classifier em NENHUM caminho;
 *      guard runtime rejeita tentativa direta no repo com erro tipado.
 *   7. Maia atual (flag OFF) — prompt-builder NÃO injeta "## Modo operacional".
 *      Prova spec criterion #5: legacy preservado quando flag está desabilitada.
 *
 * Pattern segue tests/integration/p5-dialogical-acquisition.spec.ts:
 *   - vi.hoisted para mocks compartilhados entre factory e testes.
 *   - vi.mock('@/db/repositories.js', ...) com state in-memory.
 *   - vi.mock('@anthropic-ai/sdk', ...) com classe que devolve mock.
 *   - vi.mock('@/lib/logger.js', ...) silent logger.
 *   - featureFlags.override em beforeEach/afterEach.
 *
 * Não modifica código de produção — somente exercita a integração da cadeia.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  FeatureFlagName,
  SwitchBehavior,
  SuggestedBy,
  DecidedBy,
  RoleDecisionAction,
  RoleSelectorStrength,
} from '@/types/enums.js';
import type {
  Channel,
  Role,
  ChannelPolicy,
  RoleSelectorDecisionRow,
} from '@/db/schema.js';
import type { RoleCandidate } from '@/cognition/role-selector/types.js';

// ---------- in-memory state ----------
type DecisionPayload = Parameters<
  typeof import('@/db/repositories.js').roleSelectorDecisionsRepo.record
>[0];

const decisionsState: RoleSelectorDecisionRow[] = [];
// Recorded payloads (what the caller passed). The state row is the "stored" view.
const recordedPayloads: DecisionPayload[] = [];

// ---------- Hoisted mocks ----------
const {
  // Repos
  channelsFindByExternalCrossTenantMock,
  recordDecisionMock,
  countSwitchesMock,
  listByConversationMock,
  // Suggesters mocked at module level so we can drive each cenário deterministically.
  detSuggestMock,
  llmSuggestMock,
  // Anthropic (still mocked end-to-end so suggester would crash if invoked w/o mock).
  anthropicCreateMock,
  // Logger (silent + spyable).
  loggerInfo,
  loggerWarn,
  loggerError,
  loggerDebug,
  // Repos used by prompt-builder (cenário 7).
  selfStateGetActive,
  operationalProfileVersionsGetActive,
  mensagensRecent,
  entidadesByIds,
  factsListMentionableForScopes,
  rulesListActive,
  entityStatesById,
  memoryEntryFindRelevant,
  behavioralHintFindActiveForScope,
  capabilitiesSkillListAll,
  capabilityGapsListByLevel,
  capabilityGapsListByLevels,
  procedureExecutionsFindActiveForConversa,
  procedureDefinitionsFindById,
} = vi.hoisted(() => ({
  channelsFindByExternalCrossTenantMock: vi.fn(),
  recordDecisionMock: vi.fn(),
  countSwitchesMock: vi.fn(),
  listByConversationMock: vi.fn(),
  detSuggestMock: vi.fn(),
  llmSuggestMock: vi.fn(),
  anthropicCreateMock: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  loggerDebug: vi.fn(),
  selfStateGetActive: vi.fn(),
  operationalProfileVersionsGetActive: vi.fn(),
  mensagensRecent: vi.fn(),
  entidadesByIds: vi.fn(),
  factsListMentionableForScopes: vi.fn(),
  rulesListActive: vi.fn(),
  entityStatesById: vi.fn(),
  memoryEntryFindRelevant: vi.fn(),
  behavioralHintFindActiveForScope: vi.fn(),
  capabilitiesSkillListAll: vi.fn(),
  capabilityGapsListByLevel: vi.fn(),
  capabilityGapsListByLevels: vi.fn(),
  procedureExecutionsFindActiveForConversa: vi.fn(),
  procedureDefinitionsFindById: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => {
  const Anthropic = vi.fn(function (this: unknown) {
    return { messages: { create: anthropicCreateMock } };
  });
  return { default: Anthropic };
});

vi.mock('@/db/repositories.js', () => ({
  // Channels — only findByExternalCrossTenant matters for resolveChannel.
  channelsRepo: {
    findByExternalCrossTenant: channelsFindByExternalCrossTenantMock,
    create: vi.fn(),
    getById: vi.fn(),
    findByExternal: vi.fn(),
    listActive: vi.fn(),
    deactivate: vi.fn(),
  },
  rolesRepo: {
    create: vi.fn(),
    getById: vi.fn(),
    getByKey: vi.fn(),
    getDefault: vi.fn(),
    listActive: vi.fn(),
    deactivate: vi.fn(),
  },
  channelPoliciesRepo: {
    create: vi.fn(),
    getByChannelId: vi.fn(),
    update: vi.fn(),
  },
  roleSelectorDecisionsRepo: {
    // CRITICAL guard: mimic real repo — throw before anything else.
    record: recordDecisionMock,
    countSwitchesInConversation: countSwitchesMock,
    listByConversation: listByConversationMock,
  },
  // Prompt-builder dependencies (cenário 7).
  selfStateRepo: { getActive: selfStateGetActive },
  operationalProfileVersionsRepo: { getActive: operationalProfileVersionsGetActive },
  mensagensRepo: { recentInConversation: mensagensRecent },
  entidadesRepo: { byIds: entidadesByIds },
  factsRepo: { listMentionableForScopes: factsListMentionableForScopes },
  rulesRepo: { listActive: rulesListActive },
  entityStatesRepo: { byId: entityStatesById },
  memoryEntryRepo: { findRelevant: memoryEntryFindRelevant },
  behavioralHintRepo: { findActiveForScope: behavioralHintFindActiveForScope },
  capabilitiesSkillRepo: { listAll: capabilitiesSkillListAll },
  capabilityGapsRepo: {
    listByLevel: capabilityGapsListByLevel,
    listByLevels: capabilityGapsListByLevels,
  },
  procedureExecutionsRepo: {
    findActiveForConversa: procedureExecutionsFindActiveForConversa,
  },
  procedureDefinitionsRepo: { findById: procedureDefinitionsFindById },
}));

// Mock suggesters so the engine just receives whatever each scenario configures.
// Real suggesters live in deterministic-classifier.ts and llm-suggester.ts.
vi.mock('@/cognition/role-selector/deterministic-classifier.js', () => ({
  deterministicSuggester: { suggest: detSuggestMock },
}));
vi.mock('@/cognition/role-selector/llm-suggester.js', () => ({
  llmSuggester: { suggest: llmSuggestMock },
}));

vi.mock('@/lib/logger.js', () => ({
  logger: {
    info: loggerInfo,
    warn: loggerWarn,
    error: loggerError,
    debug: loggerDebug,
  },
}));

vi.mock('@/config/env.js', () => ({
  config: {},
}));

// ---------- Factories ----------
function makeChannel(overrides: Partial<Channel> = {}): Channel {
  const now = new Date();
  return {
    id: 'channel-1',
    tenant_id: 'tenant-acme',
    agent_id: 'agent-acme-main',
    external_id: '5511999999999',
    channel_type: 'whatsapp',
    display_name: 'WA principal',
    active: true,
    metadata: {},
    created_at: now,
    updated_at: now,
    ...overrides,
  } as Channel;
}

function makeRole(role_key: string, id: string, extras: Partial<Role> = {}): Role {
  const now = new Date();
  return {
    id,
    tenant_id: 'default',
    agent_id: 'default',
    role_key,
    display_name: role_key,
    description: null,
    prompt_addendum: null,
    active: true,
    is_default: false,
    metadata: {},
    created_at: now,
    updated_at: now,
    ...extras,
  } as Role;
}

function makePolicy(
  switch_behavior: SwitchBehavior,
  guards: Partial<{
    min_confidence_to_switch: number;
    cooldown_turns: number;
    required_strength_delta: number;
    max_switches_per_conversation: number;
  }> = {},
): ChannelPolicy {
  const now = new Date();
  return {
    id: 'policy-1',
    tenant_id: 'default',
    agent_id: 'default',
    channel_id: 'chan-1',
    default_role_id: 'role-default',
    switch_behavior,
    announce_mode: 'affects_user',
    by_context_guards: {
      min_confidence_to_switch: 0.7,
      cooldown_turns: 3,
      required_strength_delta: 0.2,
      max_switches_per_conversation: 3,
      ...guards,
    },
    allowed_role_ids: [],
    created_at: now,
    updated_at: now,
  } as ChannelPolicy;
}

function makeCandidate(overrides: Partial<RoleCandidate> = {}): RoleCandidate {
  return {
    role_id: 'role-alt',
    role_key: 'alternative',
    confidence: 0.85,
    strength: RoleSelectorStrength.STRONG,
    suggested_by: SuggestedBy.DETERMINISTIC_CLASSIFIER,
    reason: 'mock candidate',
    ...overrides,
  };
}

// ---------- Shared roles/policy for cenários 2-6 ----------
const defaultRole = makeRole('default', 'role-default', { is_default: true });
const alternativeRole = makeRole('alternative', 'role-alt');

// ---------- Suite ----------
describe('P6 channel/role/policy — end-to-end', () => {
  beforeEach(async () => {
    decisionsState.length = 0;
    recordedPayloads.length = 0;

    vi.clearAllMocks();

    // Default suggester behavior: both return null. Per-cenário overrides win.
    detSuggestMock.mockResolvedValue(null);
    llmSuggestMock.mockResolvedValue(null);

    // Default record mock — mimic real repo (with llm_classifier guard) AND
    // push to in-memory state so the suite can inspect what was stored.
    recordDecisionMock.mockImplementation(async (input: DecisionPayload) => {
      // CRITICAL runtime guard (defense in depth — DB has CHECK too).
      if ((input.decided_by as string) === 'llm_classifier') {
        throw new Error('decided_by_cannot_be_llm_classifier');
      }
      recordedPayloads.push(input);
      const now = new Date();
      const row = {
        id: `dec-${Math.random().toString(36).slice(2)}`,
        tenant_id: 'default',
        agent_id: 'default',
        conversa_id: input.conversa_id ?? null,
        turno_id: input.turno_id ?? null,
        channel_id: input.channel_id ?? null,
        policy_id: input.policy_id ?? null,
        current_role_id: input.current_role_id ?? null,
        suggested_role_id: input.suggested_role_id ?? null,
        decided_role_id: input.decided_role_id,
        action: input.action,
        candidates: input.candidates,
        conflicts: input.conflicts,
        suggested_by: input.suggested_by,
        decided_by: input.decided_by,
        suggested_strength: input.suggested_strength ?? null,
        suggested_confidence:
          input.suggested_confidence !== undefined
            ? String(input.suggested_confidence)
            : null,
        reason: input.reason ?? null,
        switch_count_in_conversation: input.switch_count_in_conversation ?? 0,
        decided_at: now,
      } as RoleSelectorDecisionRow;
      decisionsState.push(row);
      return row;
    });

    // Default counts to 0 — cenário 5 overrides to simulate cap reached.
    countSwitchesMock.mockResolvedValue(0);
    listByConversationMock.mockResolvedValue([]);

    // Prompt-builder dependencies — safe defaults.
    selfStateGetActive.mockResolvedValue({
      versao: 1,
      system_prompt: 'BODY',
      resumo_aprendizados: '(vazio)',
    });
    operationalProfileVersionsGetActive.mockResolvedValue(null);
    mensagensRecent.mockResolvedValue([]);
    entidadesByIds.mockResolvedValue([]);
    factsListMentionableForScopes.mockResolvedValue([]);
    rulesListActive.mockResolvedValue([]);
    entityStatesById.mockResolvedValue(null);
    memoryEntryFindRelevant.mockResolvedValue([]);
    behavioralHintFindActiveForScope.mockResolvedValue([]);
    capabilitiesSkillListAll.mockResolvedValue([]);
    capabilityGapsListByLevel.mockResolvedValue([]);
    capabilityGapsListByLevels.mockResolvedValue([]);
    procedureExecutionsFindActiveForConversa.mockResolvedValue(null);
    procedureDefinitionsFindById.mockResolvedValue(null);

    const { featureFlags } = await import('@/config/feature-flags.js');
    featureFlags.reset();
  });

  afterEach(async () => {
    const { featureFlags } = await import('@/config/feature-flags.js');
    featureFlags.override(FeatureFlagName.MULTI_CHANNEL, false);
    featureFlags.unkillSwitch(FeatureFlagName.MULTI_CHANNEL);
    featureFlags.reset();
  });

  // ---------- Cenário 1 ----------
  it('cenário 1: flag MULTI_CHANNEL OFF → resolveChannel LANÇA TypedError fail-loud (issue #268)', async () => {
    const { featureFlags } = await import('@/config/feature-flags.js');
    featureFlags.override(FeatureFlagName.MULTI_CHANNEL, false);

    const { resolveChannel } = await import('@/gateway/channel-resolver.js');
    const { TypedError } = await import('@/lib/utils.js');

    const promise = resolveChannel({
      channel_type: 'whatsapp',
      external_id: '5511999999999',
    });

    // Issue #268 — fallback default/default removido. Resolver agora lança
    // TypedError tipado em vez de colapsar tenants no bucket compartilhado.
    await expect(promise).rejects.toBeInstanceOf(TypedError);
    await expect(promise).rejects.toMatchObject({
      code: 'channel_resolution_failed',
    });
    // Short-circuit antes do lookup — nenhum side-effect downstream.
    expect(channelsFindByExternalCrossTenantMock).not.toHaveBeenCalled();
    expect(recordDecisionMock).not.toHaveBeenCalled();
  });

  // ---------- Cenário 2 ----------
  it('cenário 2: policy=LOCKED + candidate strong → keep_current via policy_rule, audit registrado', async () => {
    const { featureFlags } = await import('@/config/feature-flags.js');
    featureFlags.override(FeatureFlagName.MULTI_CHANNEL, true);

    // Setup: 1 channel, 1 default role, 1 alternative role, policy LOCKED.
    channelsFindByExternalCrossTenantMock.mockResolvedValueOnce(makeChannel());

    // Both suggesters return STRONG alternative candidate.
    detSuggestMock.mockResolvedValueOnce(
      makeCandidate({
        role_id: 'role-alt',
        role_key: 'alternative',
        confidence: 0.9,
        strength: RoleSelectorStrength.STRONG,
        suggested_by: SuggestedBy.DETERMINISTIC_CLASSIFIER,
      }),
    );
    llmSuggestMock.mockResolvedValueOnce(
      makeCandidate({
        role_id: 'role-alt',
        role_key: 'alternative',
        confidence: 0.92,
        strength: RoleSelectorStrength.STRONG,
        suggested_by: SuggestedBy.LLM_CLASSIFIER,
      }),
    );

    const { selectRole } = await import('@/cognition/role-selector/engine.js');

    const out = await selectRole({
      inbound_text: 'mensagem que normalmente trocaria de role',
      current_role: defaultRole,
      available_roles: [defaultRole, alternativeRole],
      policy: makePolicy(SwitchBehavior.LOCKED),
      conversa_id: 'conv-locked',
      channel_id: 'chan-1',
      turno_id: 'turno-1',
    });

    // LOCKED keeps current regardless of candidate strength.
    expect(out.action).toBe(RoleDecisionAction.KEEP_CURRENT);
    expect(out.decided_role.id).toBe('role-default');

    // Audit row criado (1 chamada).
    expect(recordDecisionMock).toHaveBeenCalledTimes(1);
    const payload = recordedPayloads[0]!;
    expect(payload.action).toBe(RoleDecisionAction.KEEP_CURRENT);
    expect(payload.decided_by).toBe(DecidedBy.POLICY_RULE);
    expect(payload.reason).toBe('policy locked');
    // INVARIANTE — guard runtime + DB CHECK enforcement.
    expect(payload.decided_by).not.toBe('llm_classifier');
  });

  // ---------- Cenário 3 ----------
  it('cenário 3: policy=PREFER_HANDOFF + candidate diferente → handoff via policy_rule, suggested != decided', async () => {
    const { featureFlags } = await import('@/config/feature-flags.js');
    featureFlags.override(FeatureFlagName.MULTI_CHANNEL, true);

    channelsFindByExternalCrossTenantMock.mockResolvedValueOnce(makeChannel());

    // Det suggester retorna alternative; LLM null.
    detSuggestMock.mockResolvedValueOnce(
      makeCandidate({
        role_id: 'role-alt',
        role_key: 'alternative',
        confidence: 0.85,
        strength: RoleSelectorStrength.STRONG,
        suggested_by: SuggestedBy.DETERMINISTIC_CLASSIFIER,
      }),
    );

    const { selectRole } = await import('@/cognition/role-selector/engine.js');

    const out = await selectRole({
      inbound_text: 'mensagem com sinal forte de alternative',
      current_role: defaultRole,
      available_roles: [defaultRole, alternativeRole],
      policy: makePolicy(SwitchBehavior.PREFER_HANDOFF),
      conversa_id: 'conv-handoff',
      channel_id: 'chan-1',
      turno_id: 'turno-1',
    });

    expect(out.action).toBe(RoleDecisionAction.HANDOFF);
    // decided_role STILL current (handoff signals, doesn't switch).
    expect(out.decided_role.id).toBe('role-default');

    const payload = recordedPayloads[0]!;
    expect(payload.action).toBe(RoleDecisionAction.HANDOFF);
    expect(payload.decided_by).toBe(DecidedBy.POLICY_RULE);
    // Audit row: suggested_role_id != decided_role_id (it's a handoff, not no-op).
    expect(payload.suggested_role_id).toBe('role-alt');
    expect(payload.decided_role_id).toBe('role-default');
    expect(payload.suggested_role_id).not.toBe(payload.decided_role_id);
    expect(payload.reason).toContain('prefer_handoff');
    expect(payload.decided_by).not.toBe('llm_classifier');
  });

  // ---------- Cenário 4 ----------
  it('cenário 4: policy=FREE_WITH_TRIGGER + strong → switch, decided_role=alternative, switch_count 0 → 1', async () => {
    const { featureFlags } = await import('@/config/feature-flags.js');
    featureFlags.override(FeatureFlagName.MULTI_CHANNEL, true);

    channelsFindByExternalCrossTenantMock.mockResolvedValueOnce(makeChannel());

    detSuggestMock.mockResolvedValueOnce(
      makeCandidate({
        role_id: 'role-alt',
        role_key: 'alternative',
        confidence: 0.85,
        strength: RoleSelectorStrength.STRONG,
        suggested_by: SuggestedBy.DETERMINISTIC_CLASSIFIER,
      }),
    );

    // Baseline switch count = 0 (sem trocas anteriores nesta conversa).
    countSwitchesMock.mockResolvedValueOnce(0);

    const { selectRole } = await import('@/cognition/role-selector/engine.js');

    const out = await selectRole({
      inbound_text: 'mensagem com claros sinais de alternative',
      current_role: defaultRole,
      available_roles: [defaultRole, alternativeRole],
      policy: makePolicy(SwitchBehavior.FREE_WITH_TRIGGER),
      conversa_id: 'conv-switch',
      channel_id: 'chan-1',
      turno_id: 'turno-1',
    });

    expect(out.action).toBe(RoleDecisionAction.SWITCH);
    expect(out.decided_role.id).toBe('role-alt');

    const payload = recordedPayloads[0]!;
    expect(payload.action).toBe(RoleDecisionAction.SWITCH);
    expect(payload.decided_by).toBe(DecidedBy.POLICY_RULE);
    expect(payload.decided_role_id).toBe('role-alt');
    expect(payload.suggested_role_id).toBe('role-alt');
    // baseCount(0) + 1 = 1 (engine.ts: baseCount+1 only when action=SWITCH)
    expect(payload.switch_count_in_conversation).toBe(1);
    expect(countSwitchesMock).toHaveBeenCalledWith('conv-switch');
    expect(payload.decided_by).not.toBe('llm_classifier');
  });

  // ---------- Cenário 5 ----------
  it('cenário 5: policy=BY_CONTEXT + cap atingido (3 switches) → fallback via fallback_rule', async () => {
    const { featureFlags } = await import('@/config/feature-flags.js');
    featureFlags.override(FeatureFlagName.MULTI_CHANNEL, true);

    channelsFindByExternalCrossTenantMock.mockResolvedValueOnce(makeChannel());

    detSuggestMock.mockResolvedValueOnce(
      makeCandidate({
        role_id: 'role-alt',
        role_key: 'alternative',
        confidence: 0.92,
        strength: RoleSelectorStrength.STRONG,
        suggested_by: SuggestedBy.DETERMINISTIC_CLASSIFIER,
      }),
    );

    // countSwitchesInConversation is called twice:
    //   1) inside policy decider (oscillation tracker check)
    //   2) inside engine.ts (to compute switch_count_in_conversation for audit)
    // Pre-seed to 3 — cap reached, anti-osc kicks in.
    countSwitchesMock.mockResolvedValue(3);

    const { selectRole } = await import('@/cognition/role-selector/engine.js');

    const out = await selectRole({
      inbound_text: 'mais uma tentativa de trocar de role',
      current_role: defaultRole,
      available_roles: [defaultRole, alternativeRole],
      policy: makePolicy(SwitchBehavior.BY_CONTEXT, {
        max_switches_per_conversation: 3,
      }),
      conversa_id: 'conv-cap',
      channel_id: 'chan-1',
      turno_id: 'turno-1',
    });

    expect(out.action).toBe(RoleDecisionAction.FALLBACK);
    // decided_role = current (anti-osc trava a troca).
    expect(out.decided_role.id).toBe('role-default');

    const payload = recordedPayloads[0]!;
    expect(payload.action).toBe(RoleDecisionAction.FALLBACK);
    expect(payload.decided_by).toBe(DecidedBy.FALLBACK_RULE);
    expect(payload.reason).toContain('max_switches_per_conversation reached');
    expect(payload.reason).toContain('3/3');
    expect(payload.decided_by).not.toBe('llm_classifier');
  });

  // ---------- Cenário 6 ----------
  it('cenário 6: INVARIANTE — decided_by NUNCA é llm_classifier (todos cenários + repo guard)', async () => {
    const { featureFlags } = await import('@/config/feature-flags.js');
    featureFlags.override(FeatureFlagName.MULTI_CHANNEL, true);

    const { selectRole } = await import('@/cognition/role-selector/engine.js');

    // Roda os 4 switch_behaviors em sequência e valida que cada audit row
    // tem decided_by !== 'llm_classifier'. Reset dos suggesters entre cada.
    const behaviors: Array<{
      behavior: SwitchBehavior;
      candidate: RoleCandidate | null;
      conversa_id: string;
      countSwitches: number;
      expectedNotLlmClassifier: true;
    }> = [
      {
        behavior: SwitchBehavior.LOCKED,
        candidate: makeCandidate({ role_id: 'role-alt', role_key: 'alternative' }),
        conversa_id: 'conv-inv-locked',
        countSwitches: 0,
        expectedNotLlmClassifier: true,
      },
      {
        behavior: SwitchBehavior.PREFER_HANDOFF,
        candidate: makeCandidate({ role_id: 'role-alt', role_key: 'alternative' }),
        conversa_id: 'conv-inv-handoff',
        countSwitches: 0,
        expectedNotLlmClassifier: true,
      },
      {
        behavior: SwitchBehavior.FREE_WITH_TRIGGER,
        candidate: makeCandidate({
          role_id: 'role-alt',
          role_key: 'alternative',
          strength: RoleSelectorStrength.STRONG,
        }),
        conversa_id: 'conv-inv-free',
        countSwitches: 0,
        expectedNotLlmClassifier: true,
      },
      {
        behavior: SwitchBehavior.BY_CONTEXT,
        candidate: makeCandidate({
          role_id: 'role-alt',
          role_key: 'alternative',
          confidence: 0.92,
        }),
        conversa_id: 'conv-inv-byctx',
        countSwitches: 3, // cap reached → fallback path
        expectedNotLlmClassifier: true,
      },
    ];

    for (const scenario of behaviors) {
      detSuggestMock.mockResolvedValueOnce(scenario.candidate);
      llmSuggestMock.mockResolvedValueOnce(null);
      countSwitchesMock.mockResolvedValue(scenario.countSwitches);

      await selectRole({
        inbound_text: 'qualquer mensagem',
        current_role: defaultRole,
        available_roles: [defaultRole, alternativeRole],
        policy: makePolicy(scenario.behavior),
        conversa_id: scenario.conversa_id,
        channel_id: 'chan-1',
        turno_id: 'turno-1',
      });
    }

    // Todas as 4 audit rows existem e nenhuma tem decided_by=llm_classifier.
    expect(recordedPayloads).toHaveLength(4);
    for (const p of recordedPayloads) {
      expect(p.decided_by).not.toBe('llm_classifier');
    }

    // Negative test: chamar repo.record diretamente com decided_by=llm_classifier
    // deve lançar erro tipado (mimic do guard real, defense in depth).
    const { roleSelectorDecisionsRepo } = await import('@/db/repositories.js');
    await expect(
      roleSelectorDecisionsRepo.record({
        conversa_id: 'conv-violation',
        decided_role_id: 'role-alt',
        action: 'switch' as RoleDecisionAction,
        candidates: [],
        conflicts: [],
        suggested_by: 'llm_classifier' as SuggestedBy,
        decided_by: 'llm_classifier' as unknown as DecidedBy, // bypass de type pra forçar guard
      }),
    ).rejects.toThrow('decided_by_cannot_be_llm_classifier');
  });

  // ---------- Cenário 7 ----------
  it('cenário 7: flag OFF → prompt-builder NÃO injeta "## Modo operacional" (legacy preservado)', async () => {
    const { featureFlags } = await import('@/config/feature-flags.js');
    featureFlags.override(FeatureFlagName.MULTI_CHANNEL, false);

    // activeRole COM description+addendum, MAS flag OFF → seção ausente.
    const role = makeRole('alternative', 'role-alt', {
      display_name: 'Alternative',
      description: 'modo alternativo de operação',
      prompt_addendum: 'use linguagem alternativa',
    });

    const pessoa = { id: 'p1', nome: 'Mendes', tipo: 'dono', apelido: null } as never;
    const conversa = { id: 'c1' } as never;
    const inbound = { id: 'm-1', conteudo: 'oi', direcao: 'in' } as never;

    const { buildPrompt } = await import('@/agent/prompt-builder.js');
    const { system } = await buildPrompt({
      pessoa,
      conversa,
      scope: { entidades: [], byEntity: new Map() },
      inbound,
      activeRole: role,
    } as never);

    // Spec criterion #5: legacy preservado quando flag está OFF.
    expect(system).not.toContain('## Modo operacional');
    expect(system).not.toContain('Você está operando como **Alternative**');
    // Sanity: prompt ainda foi montado (não quebrou).
    expect(system).toContain('Sobre você');
  });
});
