/**
 * P4 Task 7 — prompt-builder dual-read sob feature flag.
 *
 * Cenários:
 *   1. Flag OFF                                  → comportamento legado (self_state)
 *   2. Flag ON + profile.status === 'active'     → usa renderOperationalProfile
 *   3. Flag ON + profile.status === 'proposed'   → fallback + warning
 *   4. Flag ON + profile.status === 'frozen'     → fallback + warning
 *   5. Flag ON + profile === null                → fallback silencioso a self_state
 *
 * Defesa em runtime: o caso (3)/(4) garante que `proposed`/`frozen` NUNCA
 * entram no system prompt mesmo se a invariant da DB (unique index parcial
 * `agent_op_profile_unique_active_idx`) for violada.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentOperationalProfileVersion } from '../../src/db/schema.js';

const selfStateGetActive = vi.fn();
const operationalProfileVersionsGetActive = vi.fn();
const mensagensRecent = vi.fn();
const entidadesByIds = vi.fn();
const factsListForScopes = vi.fn();
const factsListMentionableForScopes = vi.fn();
const rulesListActive = vi.fn();
const entityStatesById = vi.fn();
const memoryEntryFindRelevant = vi.fn();
const behavioralHintFindActiveForScope = vi.fn();
const capabilitiesSkillListAll = vi.fn();
const capabilityGapsListByLevel = vi.fn();
const procedureExecutionsFindActiveForConversa = vi.fn();
const procedureDefinitionsFindById = vi.fn();

vi.mock('../../src/db/repositories.js', () => ({
  selfStateRepo: { getActive: selfStateGetActive },
  operationalProfileVersionsRepo: { getActive: operationalProfileVersionsGetActive },
  mensagensRepo: { recentInConversation: mensagensRecent },
  entidadesRepo: { byIds: entidadesByIds },
  factsRepo: {
    listForScopes: factsListForScopes,
    listMentionableForScopes: factsListMentionableForScopes,
  },
  rulesRepo: { listActive: rulesListActive },
  entityStatesRepo: { byId: entityStatesById },
  memoryEntryRepo: { findRelevant: memoryEntryFindRelevant },
  behavioralHintRepo: { findActiveForScope: behavioralHintFindActiveForScope },
  capabilitiesSkillRepo: { listAll: capabilitiesSkillListAll },
  capabilityGapsRepo: { listByLevel: capabilityGapsListByLevel },
  procedureExecutionsRepo: {
    findActiveForConversa: procedureExecutionsFindActiveForConversa,
  },
  procedureDefinitionsRepo: { findById: procedureDefinitionsFindById },
}));

vi.mock('../../src/config/env.js', () => ({
  config: {},
}));

// Mock the logger so we can assert that warnings are emitted on fallback.
const loggerWarn = vi.fn();
vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    warn: loggerWarn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

/**
 * Build a fake AgentOperationalProfileVersion for prompt-builder tests.
 *
 * The renderer reads legacy 4-layer keys via an `as unknown` cast. During the
 * migration window the generator also packs them inside profile_body. We keep
 * them at the top level of the fake row so the renderer/prompt-builder can
 * find them regardless of which access path is active, and cast the result to
 * satisfy TypeScript without touching production code.
 */
function buildVersion(
  overrides: Record<string, unknown>,
): AgentOperationalProfileVersion {
  return {
    id: 'prof-1',
    tenant_id: 'default',
    agent_id: 'default',
    version: 3,
    status: 'active',
    // profile_body satisfies the Drizzle type; legacy keys are merged at the
    // top level so the renderer's `(version as unknown).core_immutable` cast works.
    profile_body: {
      core_immutable: {
        identity_block: 'V2_IDENTITY_BLOCK',
        principles: ['princípio A', 'princípio B'],
      },
      operational_profile: {
        voice_descriptor: 'voz V2',
        thresholds: { confirm_limit_brl: 500 },
      },
      episodic_temp: {},
      growth_backlog: {},
    } as unknown as AgentOperationalProfileVersion['profile_body'],
    proposed_by: 'system_seed',
    proposed_reason: null,
    approved_by: null,
    approved_at: null,
    activated_at: null,
    frozen_at: null,
    rolled_back_at: null,
    rollback_reason: null,
    created_at: new Date(),
    ...overrides,
  } as unknown as AgentOperationalProfileVersion;
}

const pessoa = {
  id: 'p1',
  nome: 'Mendes',
  tipo: 'dono',
  apelido: null,
} as never;
const conversa = { id: 'c1' } as never;
const inbound = {
  id: 'm-1',
  conteudo: 'oi',
  direcao: 'in',
} as never;
const ctx = {
  pessoa,
  conversa,
  scope: { entidades: [], byEntity: new Map() },
  inbound,
} as never;

beforeEach(async () => {
  selfStateGetActive.mockReset();
  operationalProfileVersionsGetActive.mockReset();
  mensagensRecent.mockReset();
  entidadesByIds.mockReset();
  factsListForScopes.mockReset();
  factsListMentionableForScopes.mockReset();
  rulesListActive.mockReset();
  entityStatesById.mockReset();
  memoryEntryFindRelevant.mockReset();
  behavioralHintFindActiveForScope.mockReset();
  capabilitiesSkillListAll.mockReset();
  capabilityGapsListByLevel.mockReset();
  procedureExecutionsFindActiveForConversa.mockReset();
  procedureDefinitionsFindById.mockReset();
  loggerWarn.mockReset();

  // Default: self_state legado disponível.
  selfStateGetActive.mockResolvedValue({
    versao: 7,
    system_prompt: 'LEGACY_SYSTEM_PROMPT_BODY',
    resumo_aprendizados: 'LEGACY_RESUMO',
  });
  mensagensRecent.mockResolvedValue([]);
  entidadesByIds.mockResolvedValue([]);
  factsListForScopes.mockResolvedValue([]);
  factsListMentionableForScopes.mockResolvedValue([]);
  rulesListActive.mockResolvedValue([]);
  entityStatesById.mockResolvedValue(null);
  memoryEntryFindRelevant.mockResolvedValue([]);
  behavioralHintFindActiveForScope.mockResolvedValue([]);
  capabilitiesSkillListAll.mockResolvedValue([]);
  capabilityGapsListByLevel.mockResolvedValue([]);
  procedureExecutionsFindActiveForConversa.mockResolvedValue(null);
  procedureDefinitionsFindById.mockResolvedValue(null);

  // Reset feature flags singleton state between tests.
  const { featureFlags } = await import('../../src/config/feature-flags.js');
  featureFlags.reset();
});

afterEach(async () => {
  // Defensive — ensure no test leaks ON state to the next.
  const { featureFlags } = await import('../../src/config/feature-flags.js');
  const { FeatureFlagName } = await import('../../src/types/enums.js');
  featureFlags.override(FeatureFlagName.OPERATIONAL_PROFILE_V2, false);
  featureFlags.reset();
});

describe('buildPrompt — dual-read sob FEATURE_OPERATIONAL_PROFILE_V2', () => {
  it('1. Flag OFF → usa self_state legado (operationalProfileVersionsRepo NÃO é consultado)', async () => {
    const { featureFlags } = await import('../../src/config/feature-flags.js');
    const { FeatureFlagName } = await import('../../src/types/enums.js');
    featureFlags.override(FeatureFlagName.OPERATIONAL_PROFILE_V2, false);

    const { buildPrompt } = await import('../../src/agent/prompt-builder.js');
    const { system } = await buildPrompt(ctx);

    expect(system).toContain('LEGACY_SYSTEM_PROMPT_BODY');
    expect(system).toContain('self_state_v7');
    expect(system).toContain('LEGACY_RESUMO');
    expect(system).not.toContain('V2_IDENTITY_BLOCK');
    // Flag OFF: o repo do profile v2 não é tocado.
    expect(operationalProfileVersionsGetActive).not.toHaveBeenCalled();
    expect(selfStateGetActive).toHaveBeenCalledTimes(1);
    expect(loggerWarn).not.toHaveBeenCalled();
  });

  it('2. Flag ON + profile.status === active → injeta renderOperationalProfile e NÃO usa self_state', async () => {
    const { featureFlags } = await import('../../src/config/feature-flags.js');
    const { FeatureFlagName } = await import('../../src/types/enums.js');
    featureFlags.override(FeatureFlagName.OPERATIONAL_PROFILE_V2, true);

    operationalProfileVersionsGetActive.mockResolvedValue(
      buildVersion({
        status: 'active',
        core_immutable: {
          identity_block: 'V2_IDENTITY_BLOCK',
          principles: ['princípio A'],
        },
        operational_profile: {
          voice_descriptor: 'voz V2',
        },
        growth_backlog: ['feature G1'],
        episodic_temp: {
          entries: [
            {
              summary: 'episódio recente OK',
              mention_allowed: true,
              proactive_use: true,
            },
          ],
        },
      }),
    );

    const { buildPrompt } = await import('../../src/agent/prompt-builder.js');
    const { system } = await buildPrompt(ctx);

    expect(system).toContain('V2_IDENTITY_BLOCK');
    expect(system).toContain('## Princípios');
    expect(system).toContain('- princípio A');
    expect(system).toContain('## Voz operacional');
    expect(system).toContain('voz V2');
    // Versão indicada vem do op_profile, não do self_state.
    expect(system).toContain('op_profile_v3');
    expect(system).not.toContain('self_state_v7');
    // Bloco legado NÃO deve aparecer.
    expect(system).not.toContain('LEGACY_SYSTEM_PROMPT_BODY');
    expect(system).not.toContain('LEGACY_RESUMO');
    // v3.1.1: growth_hints_block e episodic_summary_block foram removidos do
    // RenderedProfile. growth_backlog → Evolution Pipeline (P5/P9
    // capability_proposals); episodic_temp → User Layer (P8c). Identity Layer
    // nao carrega esse conteudo.
    expect(system).not.toContain('## Capacidades em desenvolvimento');
    expect(system).not.toContain('## Contexto recente');
    // self_state NUNCA é consultado quando há profile ativo.
    expect(selfStateGetActive).not.toHaveBeenCalled();
    expect(operationalProfileVersionsGetActive).toHaveBeenCalledTimes(1);
    expect(loggerWarn).not.toHaveBeenCalled();
  });

  it('3. Flag ON + profile.status === proposed → loga warning e cai pro self_state legado', async () => {
    const { featureFlags } = await import('../../src/config/feature-flags.js');
    const { FeatureFlagName } = await import('../../src/types/enums.js');
    featureFlags.override(FeatureFlagName.OPERATIONAL_PROFILE_V2, true);

    operationalProfileVersionsGetActive.mockResolvedValue(
      buildVersion({
        status: 'proposed',
        core_immutable: {
          identity_block: 'V2_IDENTITY_BLOCK_PROPOSED',
        },
      }),
    );

    const { buildPrompt } = await import('../../src/agent/prompt-builder.js');
    const { system } = await buildPrompt(ctx);

    // Fallback para self_state — o conteúdo `proposed` JAMAIS entra no prompt.
    expect(system).toContain('LEGACY_SYSTEM_PROMPT_BODY');
    expect(system).toContain('self_state_v7');
    expect(system).not.toContain('V2_IDENTITY_BLOCK_PROPOSED');
    // Warning emitido com status visível.
    expect(loggerWarn).toHaveBeenCalledTimes(1);
    const [meta, msg] = loggerWarn.mock.calls[0]!;
    expect(meta).toEqual({ has_profile: true, status: 'proposed' });
    expect(msg).toBe('identity.profile_v2_invalid_fallback_to_legacy');
    // self_state foi consultado depois da falha do v2.
    expect(selfStateGetActive).toHaveBeenCalledTimes(1);
  });

  it('4. Flag ON + profile.status === frozen → loga warning e cai pro self_state legado', async () => {
    const { featureFlags } = await import('../../src/config/feature-flags.js');
    const { FeatureFlagName } = await import('../../src/types/enums.js');
    featureFlags.override(FeatureFlagName.OPERATIONAL_PROFILE_V2, true);

    operationalProfileVersionsGetActive.mockResolvedValue(
      buildVersion({
        status: 'frozen',
        core_immutable: {
          identity_block: 'V2_IDENTITY_BLOCK_FROZEN',
        },
      }),
    );

    const { buildPrompt } = await import('../../src/agent/prompt-builder.js');
    const { system } = await buildPrompt(ctx);

    expect(system).toContain('LEGACY_SYSTEM_PROMPT_BODY');
    expect(system).toContain('self_state_v7');
    expect(system).not.toContain('V2_IDENTITY_BLOCK_FROZEN');
    expect(loggerWarn).toHaveBeenCalledTimes(1);
    const [meta, msg] = loggerWarn.mock.calls[0]!;
    expect(meta).toEqual({ has_profile: true, status: 'frozen' });
    expect(msg).toBe('identity.profile_v2_invalid_fallback_to_legacy');
    expect(selfStateGetActive).toHaveBeenCalledTimes(1);
  });

  it('5. Flag ON + profile === null → fallback silencioso a self_state (sem warning)', async () => {
    const { featureFlags } = await import('../../src/config/feature-flags.js');
    const { FeatureFlagName } = await import('../../src/types/enums.js');
    featureFlags.override(FeatureFlagName.OPERATIONAL_PROFILE_V2, true);

    operationalProfileVersionsGetActive.mockResolvedValue(null);

    const { buildPrompt } = await import('../../src/agent/prompt-builder.js');
    const { system } = await buildPrompt(ctx);

    expect(system).toContain('LEGACY_SYSTEM_PROMPT_BODY');
    expect(system).toContain('self_state_v7');
    // null não é um estado anômalo — apenas significa "ainda não migrou pra v2".
    // Não emite warning (ruído desnecessário em logs de produção).
    expect(loggerWarn).not.toHaveBeenCalled();
    expect(selfStateGetActive).toHaveBeenCalledTimes(1);
    expect(operationalProfileVersionsGetActive).toHaveBeenCalledTimes(1);
  });
});
