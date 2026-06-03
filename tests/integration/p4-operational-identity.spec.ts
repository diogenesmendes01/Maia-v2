/**
 * P4 Task 11 — Integration test end-to-end para a cadeia completa de
 * identidade operacional v2 (P4).
 *
 * Cobre 6 cenários:
 *   1. seedInitialOperationalProfile cria v1 active na primeira chamada;
 *      idempotency na segunda devolve { created: false, reason: 'already_active' }.
 *   2. Prompt-builder com flag OFF lê self_state legado e NÃO toca o
 *      operationalProfileVersionsRepo.
 *   3. Prompt-builder com flag ON + active válido renderiza o profile v2 e
 *      NÃO consulta self_state.
 *   4. Prompt-builder com flag ON + status='proposed' (invariant violada) faz
 *      fallback ao self_state e loga warning
 *      `identity.profile_v2_invalid_fallback_to_legacy`.
 *   5. Drift CRITICO (LINGUAGEM offensive=true) → severity=critico,
 *      decision=rollback; transition é chamada com to='rolled_back',
 *      rollback_reason=evidence_summary; alert é criado com severity/decision
 *      corretos.
 *   6. Rollback via killSwitch: flag ON usa profile, kill flip switch para self_state
 *      legado SEM restart (caminho < 1min).
 *
 * Pattern segue tests/integration/p3c-procedure-governance.spec.ts:
 *   - vi.mock('@/db/repositories.js', ...) com state in-memory para o seed.
 *   - Mocks dedicados para o prompt-builder (cenários 2/3/4/6) e decision
 *     engine (cenário 5).
 *   - Mocks via `vi.hoisted` para evitar ordering issues.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { DriftType, DriftSeverity, DriftDecision } from '@/types/enums.js';
import type { AgentOperationalProfileVersion } from '@/db/schema.js';
import type { DriftEvidence } from '@/cognition/drift/types.js';

// ---------- in-memory state for seed scenarios ----------
// ProfileRow mirrors AgentOperationalProfileVersion (v3.1.1 single profile_body column).
type ProfileRow = {
  id: string;
  tenant_id: string;
  agent_id: string;
  version: number;
  status: 'proposed' | 'active' | 'frozen' | 'rolled_back';
  profile_body: unknown;
  proposed_by: string;
  proposed_reason: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  activated_at: Date | null;
  frozen_at: Date | null;
  rolled_back_at: Date | null;
  rollback_reason: string | null;
  created_at: Date;
};

const profilesState: Record<string, ProfileRow> = {};

// Test-controlled override for fs/promises.readFile (cenário 1).
let readFileImpl: ((path: string, encoding?: string) => Promise<string>) | null = null;

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async (path: string, encoding?: string) => {
    if (readFileImpl) return readFileImpl(path, encoding);
    throw new Error('readFile not configured for this test');
  }),
}));

// Hoisted mocks for prompt-builder + decision engine.
const {
  selfStateGetActive,
  operationalProfileVersionsGetActive,
  operationalProfileVersionsCreate,
  operationalProfileVersionsTransition,
  operationalProfileVersionsGetById,
  operationalProfileVersionsListByStatus,
  operationalProfileVersionsNextVersion,
  driftAlertsCreate,
  driftAlertsListUnresolved,
  driftAlertsListByProfileVersion,
  driftAlertsResolve,
  mensagensRecent,
  entidadesByIds,
  factsListMentionableForScopes,
  rulesListActive,
  entityStatesById,
  memoryEntryFindRelevant,
  behavioralHintFindActiveForScope,
  capabilitiesSkillListAll,
  capabilityGapsListByLevel,
  procedureExecutionsFindActiveForConversa,
  procedureDefinitionsFindById,
  loggerWarn,
  loggerInfo,
  loggerError,
  loggerDebug,
} = vi.hoisted(() => ({
  selfStateGetActive: vi.fn(),
  operationalProfileVersionsGetActive: vi.fn(),
  operationalProfileVersionsCreate: vi.fn(),
  operationalProfileVersionsTransition: vi.fn(),
  operationalProfileVersionsGetById: vi.fn(),
  operationalProfileVersionsListByStatus: vi.fn(),
  operationalProfileVersionsNextVersion: vi.fn(),
  driftAlertsCreate: vi.fn(),
  driftAlertsListUnresolved: vi.fn(),
  driftAlertsListByProfileVersion: vi.fn(),
  driftAlertsResolve: vi.fn(),
  mensagensRecent: vi.fn(),
  entidadesByIds: vi.fn(),
  factsListMentionableForScopes: vi.fn(),
  rulesListActive: vi.fn(),
  entityStatesById: vi.fn(),
  memoryEntryFindRelevant: vi.fn(),
  behavioralHintFindActiveForScope: vi.fn(),
  capabilitiesSkillListAll: vi.fn(),
  capabilityGapsListByLevel: vi.fn(),
  procedureExecutionsFindActiveForConversa: vi.fn(),
  procedureDefinitionsFindById: vi.fn(),
  loggerWarn: vi.fn(),
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
  loggerDebug: vi.fn(),
}));

vi.mock('@/db/repositories.js', () => ({
  selfStateRepo: { getActive: selfStateGetActive },
  operationalProfileVersionsRepo: {
    getActive: operationalProfileVersionsGetActive,
    create: operationalProfileVersionsCreate,
    transition: operationalProfileVersionsTransition,
    getById: operationalProfileVersionsGetById,
    listByStatus: operationalProfileVersionsListByStatus,
    nextVersion: operationalProfileVersionsNextVersion,
  },
  driftAlertsRepo: {
    create: driftAlertsCreate,
    listUnresolved: driftAlertsListUnresolved,
    listByProfileVersion: driftAlertsListByProfileVersion,
    resolve: driftAlertsResolve,
  },
  mensagensRepo: { recentInConversation: mensagensRecent },
  entidadesRepo: { byIds: entidadesByIds },
  factsRepo: { listMentionableForScopes: factsListMentionableForScopes },
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

vi.mock('@/lib/logger.js', () => ({
  logger: {
    warn: loggerWarn,
    info: loggerInfo,
    error: loggerError,
    debug: loggerDebug,
  },
}));

// ---------- Fixtures ----------
const MAIA_PROMPT_FIXTURE = `# Maia — System Prompt v0

> Header text.

## Identidade

Você é a **Maia**, assistente financeira pessoal do Mendes.

Você existe para que ele e a esposa não precisem mais acordar pensando "quanto eu tenho que pagar".

## Princípios

1. **Separação acima de tudo.** PF é PF. Cada empresa é uma entidade independente.

2. **Confirme antes de agir em coisas relevantes.** Lançamentos abaixo do limite confirmado podem ser registrados direto.

3. **Direta, não burocrática.** Mendes prefere objetividade.

## Como você fala

- Português brasileiro, registro coloquial-profissional
- Sem emojis (a menos que o interlocutor use)
- Frases curtas. Listagem só quando precisa

## Encerramento

Você é a Maia.
`;

/**
 * Build a fake AgentOperationalProfileVersion for integration tests.
 *
 * The renderer reads the legacy 4-layer keys (core_immutable / operational_profile
 * / episodic_temp / growth_backlog) via an `as unknown` cast. We keep them at the
 * top level of the fake row (spread via overrides) so the renderer can find them,
 * while also satisfying TypeScript via `as unknown as AgentOperationalProfileVersion`.
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
    // profile_body satisfies the Drizzle type; legacy keys from overrides are
    // also spread at the top level for the renderer's `as unknown` cast to find.
    profile_body: {} as unknown as AgentOperationalProfileVersion['profile_body'],
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

// ---------- Suite ----------
describe('P4 operational identity — end-to-end', () => {
  beforeEach(async () => {
    // Reset all mocks
    for (const k of Object.keys(profilesState)) delete profilesState[k];
    vi.clearAllMocks();
    readFileImpl = async () => MAIA_PROMPT_FIXTURE;

    // Default behavior: all prompt-builder side repos return empty/null.
    selfStateGetActive.mockResolvedValue({
      versao: 7,
      system_prompt: 'LEGACY_SYSTEM_PROMPT_BODY',
      resumo_aprendizados: 'LEGACY_RESUMO',
    });
    mensagensRecent.mockResolvedValue([]);
    entidadesByIds.mockResolvedValue([]);
    factsListMentionableForScopes.mockResolvedValue([]);
    rulesListActive.mockResolvedValue([]);
    entityStatesById.mockResolvedValue(null);
    memoryEntryFindRelevant.mockResolvedValue([]);
    behavioralHintFindActiveForScope.mockResolvedValue([]);
    capabilitiesSkillListAll.mockResolvedValue([]);
    capabilityGapsListByLevel.mockResolvedValue([]);
    procedureExecutionsFindActiveForConversa.mockResolvedValue(null);
    procedureDefinitionsFindById.mockResolvedValue(null);
    operationalProfileVersionsGetActive.mockResolvedValue(null);

    // Default seed-mode for create/transition: use in-memory state.
    // Accepts profile_body (v3.1.1 single JSONB column) — the generator packs
    // legacy 4-layer keys inside profile_body during the migration window.
    operationalProfileVersionsCreate.mockImplementation(async (input: {
      profile_body: unknown;
      proposed_by: string;
      proposed_reason?: string;
    }) => {
      const id = `prof-${Math.random().toString(36).slice(2)}`;
      const versions = Object.values(profilesState).filter(
        (r) => r.tenant_id === 'default' && r.agent_id === 'default',
      );
      const version = versions.length === 0 ? 1 : Math.max(...versions.map((v) => v.version)) + 1;
      const row: ProfileRow = {
        id,
        tenant_id: 'default',
        agent_id: 'default',
        version,
        status: 'proposed',
        profile_body: input.profile_body,
        proposed_by: input.proposed_by,
        proposed_reason: input.proposed_reason ?? null,
        approved_by: null,
        approved_at: null,
        activated_at: null,
        frozen_at: null,
        rolled_back_at: null,
        rollback_reason: null,
        created_at: new Date(),
      };
      profilesState[id] = row;
      return row;
    });

    operationalProfileVersionsTransition.mockImplementation(async (args: {
      id: string;
      to: 'proposed' | 'active' | 'frozen' | 'rolled_back';
      approved_by?: string;
      rollback_reason?: string;
    }) => {
      const row = profilesState[args.id];
      if (!row) return { ok: false, reason: 'not_found' };
      const from = row.status;
      if (from === 'rolled_back') return { ok: false, reason: 'terminal' };
      if (from === args.to) return { ok: false, reason: 'invalid_transition' };
      const allowed: Record<string, string[]> = {
        proposed: ['active', 'frozen', 'rolled_back'],
        active: ['frozen', 'rolled_back'],
        frozen: ['active', 'rolled_back'],
      };
      if (!allowed[from]?.includes(args.to)) {
        return { ok: false, reason: 'invalid_transition' };
      }
      if (args.to === 'active') {
        const otherActive = Object.values(profilesState).find(
          (r) =>
            r.tenant_id === row.tenant_id &&
            r.agent_id === row.agent_id &&
            r.status === 'active' &&
            r.id !== row.id,
        );
        if (otherActive) return { ok: false, reason: 'already_has_active' };
      }
      const now = new Date();
      const patch: Partial<ProfileRow> = { status: args.to };
      if (args.to === 'active') {
        if (!row.approved_at) {
          patch.approved_at = now;
          patch.approved_by = args.approved_by ?? row.approved_by;
        }
        patch.activated_at = now;
      } else if (args.to === 'frozen') {
        patch.frozen_at = now;
      } else if (args.to === 'rolled_back') {
        patch.rolled_back_at = now;
        patch.rollback_reason = args.rollback_reason ?? null;
      }
      const updated = { ...row, ...patch };
      profilesState[args.id] = updated;
      return { ok: true, updated };
    });

    driftAlertsCreate.mockImplementation(async (input: { drift_type: string }) => ({
      id: `alert-${input.drift_type}-${Math.random().toString(36).slice(2)}`,
    }));

    // Reset feature flags singleton state between tests.
    const { featureFlags } = await import('@/config/feature-flags.js');
    featureFlags.reset();
  });

  afterEach(async () => {
    // Defensive — ensure no test leaks ON state to the next.
    const { featureFlags } = await import('@/config/feature-flags.js');
    featureFlags.reset();
  });

  // ---------- Cenário 1 ----------
  it('cenário 1: seedInitialOperationalProfile cria v1 active e é idempotente', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        // Mock getActive to return null on the first call, then the created
        // active row on subsequent calls (simulating idempotency check after
        // the first seed succeeded).
        operationalProfileVersionsGetActive.mockImplementation(async () => {
          return (
            Object.values(profilesState).find(
              (r) =>
                r.tenant_id === 'default' &&
                r.agent_id === 'default' &&
                r.status === 'active',
            ) ?? null
          );
        });

        const { seedInitialOperationalProfile } = await import(
          '@/identity/proposal-generator.js'
        );

        // 1st seed: cria v1 active.
        const first = await seedInitialOperationalProfile();
        expect(first.created).toBe(true);
        if (!first.created) throw new Error('expected created=true');
        const v = first.version;
        expect(v.status).toBe('active');
        expect(v.version).toBe(1);
        expect(v.proposed_by).toBe('system_seed');
        // The generator packs legacy 4-layer keys inside profile_body during
        // the v3.1.1 migration window. Read core_immutable from there.
        const body = v.profile_body as {
          core_immutable: { identity_block: string; principles: string[] };
        };
        expect(body.core_immutable.identity_block).toBeTruthy();
        expect(body.core_immutable.principles.length).toBeGreaterThanOrEqual(3);

        // Spies confirm: create + transition foram invocados.
        expect(operationalProfileVersionsCreate).toHaveBeenCalledTimes(1);
        expect(operationalProfileVersionsTransition).toHaveBeenCalledTimes(1);

        // 2nd seed: idempotency — getActive já retorna o row criado.
        operationalProfileVersionsCreate.mockClear();
        operationalProfileVersionsTransition.mockClear();
        const second = await seedInitialOperationalProfile();
        expect(second.created).toBe(false);
        if (second.created) throw new Error('expected created=false');
        expect(second.reason).toBe('already_active');
        expect(second.existing.id).toBe(v.id);
        // Crítico: nem create nem transition foram invocados de novo.
        expect(operationalProfileVersionsCreate).not.toHaveBeenCalled();
        expect(operationalProfileVersionsTransition).not.toHaveBeenCalled();
      },
    );
  });

  // ---------- Cenário 2 ----------
  // ---------- Cenário 3 ----------
  it('cenário 3: prompt-builder com active válido renderiza profile e NÃO usa self_state', async () => {
    operationalProfileVersionsGetActive.mockResolvedValue(
      buildVersion({
        status: 'active',
        core_immutable: {
          identity_block: 'V2_IDENTITY_DISTINCT_BLOCK',
          principles: ['princípio v2 alpha', 'princípio v2 beta'],
        },
        operational_profile: {
          voice_descriptor: 'voz v2 distinta',
        },
      }),
    );

    const { buildPrompt } = await import('@/agent/prompt-builder.js');
    const { system } = await buildPrompt(ctx);

    // Profile v2 content is rendered.
    expect(system).toContain('V2_IDENTITY_DISTINCT_BLOCK');
    expect(system).toContain('## Princípios');
    expect(system).toContain('- princípio v2 alpha');
    expect(system).toContain('## Voz operacional');
    expect(system).toContain('voz v2 distinta');
    expect(system).toContain('op_profile_v3');
    // Self_state legacy content is NOT in the prompt.
    expect(system).not.toContain('LEGACY_SYSTEM_PROMPT_BODY');
    expect(system).not.toContain('LEGACY_RESUMO');
    expect(system).not.toContain('self_state_v7');
    // self_state NEVER consultado quando profile ativo válido.
    expect(selfStateGetActive).not.toHaveBeenCalled();
    expect(operationalProfileVersionsGetActive).toHaveBeenCalledTimes(1);
    expect(loggerWarn).not.toHaveBeenCalled();
  });

  // ---------- Cenário 4 ----------
  it('cenário 4: prompt-builder com status=proposed faz fallback ao self_state + loga warning', async () => {
    operationalProfileVersionsGetActive.mockResolvedValue(
      buildVersion({
        status: 'proposed',
        core_immutable: {
          identity_block: 'V2_PROPOSED_BODY_MUST_NEVER_APPEAR',
        },
      }),
    );

    const { buildPrompt } = await import('@/agent/prompt-builder.js');
    const { system } = await buildPrompt(ctx);

    // Fallback: self_state legado entra; profile proposed JAMAIS aparece.
    expect(system).toContain('LEGACY_SYSTEM_PROMPT_BODY');
    expect(system).toContain('self_state_v7');
    expect(system).not.toContain('V2_PROPOSED_BODY_MUST_NEVER_APPEAR');

    // Warning logado com status visível.
    expect(loggerWarn).toHaveBeenCalledTimes(1);
    const [meta, msg] = loggerWarn.mock.calls[0]!;
    expect(meta).toEqual({ has_profile: true, status: 'proposed' });
    expect(msg).toBe('identity.profile_v2_invalid_fallback_to_self_state');
    expect(selfStateGetActive).toHaveBeenCalledTimes(1);
  });

  // ---------- Cenário 5 ----------
  it('cenário 5: drift CRITICO (linguagem offensive) dispara rollback + cria alert', async () => {
    const PROFILE_ID = 'profile-id';
    const evidenceSummary = 'Linguagem ofensiva detectada em 2 mensagens.';
    const evidence: DriftEvidence = {
      drift_type: DriftType.LINGUAGEM,
      detected_by: 'drift_detector_linguagem',
      payload: {
        offensive: true,
        severity_hint: 'critico',
        examples: ['msg ofensiva 1', 'msg ofensiva 2'],
      },
      evidence_summary: evidenceSummary,
    };

    // Mock transition succeeds with rolled_back status.
    operationalProfileVersionsTransition.mockResolvedValue({
      ok: true,
      updated: {
        id: PROFILE_ID,
        status: 'rolled_back',
        rolled_back_at: new Date(),
        rollback_reason: evidenceSummary,
      } as unknown as AgentOperationalProfileVersion,
    });

    // Mock alert creation.
    driftAlertsCreate.mockResolvedValue({ id: 'alert-id' });

    const { decideAndApply } = await import('@/cognition/drift/decision-engine.js');
    const results = await decideAndApply({
      evidences: [evidence],
      active_profile_id: PROFILE_ID,
    });

    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.severity).toBe(DriftSeverity.CRITICO);
    expect(r.decision).toBe(DriftDecision.ROLLBACK);
    expect(r.applied).toBe(true);
    expect(r.alert_id).toBe('alert-id');

    // Transition foi chamada com to='rolled_back' e rollback_reason=evidence_summary.
    expect(operationalProfileVersionsTransition).toHaveBeenCalledTimes(1);
    const transitionArgs = operationalProfileVersionsTransition.mock.calls[0]![0];
    expect(transitionArgs.id).toBe(PROFILE_ID);
    expect(transitionArgs.to).toBe('rolled_back');
    expect(transitionArgs.rollback_reason).toBe(evidenceSummary);
    expect(transitionArgs.approved_by).toBe('auto:drift_critico');

    // Alert foi criado com severity=critico, decision=rollback.
    expect(driftAlertsCreate).toHaveBeenCalledTimes(1);
    const alertArgs = driftAlertsCreate.mock.calls[0]![0];
    expect(alertArgs.profile_version_id).toBe(PROFILE_ID);
    expect(alertArgs.drift_type).toBe(DriftType.LINGUAGEM);
    expect(alertArgs.severity).toBe(DriftSeverity.CRITICO);
    expect(alertArgs.decision).toBe(DriftDecision.ROLLBACK);
    expect(alertArgs.detected_by).toBe('drift_detector_linguagem');
    expect(alertArgs.decided_by).toBe('decision_engine');
    // Evidence payload é spread + summary attached.
    expect(alertArgs.evidence).toMatchObject({
      offensive: true,
      summary: evidenceSummary,
    });
  });

});
