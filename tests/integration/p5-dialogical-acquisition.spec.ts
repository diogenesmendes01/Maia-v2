/**
 * P5 Task 11 — Integration test end-to-end para a cadeia completa de
 * aquisição dialógica de capacidades (P5).
 *
 * Cobre 6 cenários:
 *   1. Gap escalation chain (silent → dashboard → mentionable → proposed +
 *      proposer disparado). A cada nova chamada do monitor, o gap é bumpado
 *      e o engine determinístico promove o nível; somente na transição final
 *      o proposer LLM é acionado (mocked Anthropic) e uma capability_proposal
 *      `draft` é criada.
 *   2. Owner aprova proposta (state machine draft → submitted → approved →
 *      delivered). Tentativa inválida (submitted → delivered direto) retorna
 *      { ok:false, reason:'invalid_transition' }.
 *   3. Test loop pass: proposal delivered + 2 echo_test scenarios em que
 *      `when` contém `then` → outcome='pass', sem revert, sem gap técnico,
 *      capability_test_result registrado.
 *   4. Test loop fail → revert path: scenario onde `when` NÃO contém `then`
 *      → outcome='fail', triggered_revert=true, novo gap com tipo='technical'
 *      e descrição com prefixo `[técnica]` criado, technical_gap_id referenciado.
 *   5. SILENT não notifica (acceptance criterion #1 do P5): channel='none',
 *      notified=false. Garantia dura — nenhum side-effect.
 *   6. Flag OFF gates proposer (no Sonnet spend): monitor ainda processa gaps
 *      (engine determinístico não depende de flag), mas o proposer retorna
 *      { ok:false, reason:'llm_unavailable', message:'flag_off' } sem chamar
 *      Anthropic.
 *
 * Pattern segue tests/integration/p4-operational-identity.spec.ts:
 *   - vi.hoisted para mocks compartilhados entre factory e testes.
 *   - vi.mock('@/db/repositories.js', ...) com state in-memory.
 *   - vi.mock('@anthropic-ai/sdk', ...) com classe que devolve mock.
 *   - vi.mock('@/lib/logger.js', ...) silent logger.
 *   - featureFlags.override em beforeEach/afterEach.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { FeatureFlagName, GapLevel } from '@/types/enums.js';
import type {
  AgentCapabilityGap,
  CapabilityProposal,
  CapabilityTestResult,
  GapEscalationRule,
  Tenant,
} from '@/db/schema.js';

// ---------- in-memory state ----------
const gapsState: Record<string, AgentCapabilityGap> = {};
const proposalsState: Record<string, CapabilityProposal> = {};
const testResultsState: Record<string, CapabilityTestResult> = {};
const tenantsState: Tenant[] = [];

// ---------- Hoisted mocks ----------
const {
  anthropicCreateMock,
  capabilityGapsListByLevels,
  capabilityGapsDaysSinceLastProposed,
  capabilityGapsUpdateLevel,
  capabilityGapsCreate,
  capabilityGapsListByLevel,
  capabilityProposalsCreate,
  capabilityProposalsGetById,
  capabilityProposalsTransition,
  capabilityTestResultsRecord,
  gapEscalationRulesGetForCurrentAgent,
  tenantsList,
  cognitiveModuleLogRecord,
  cognitiveModuleLogRecent,
  loggerInfo,
  loggerWarn,
  loggerError,
  loggerDebug,
} = vi.hoisted(() => ({
  anthropicCreateMock: vi.fn(),
  capabilityGapsListByLevels: vi.fn(),
  capabilityGapsDaysSinceLastProposed: vi.fn(),
  capabilityGapsUpdateLevel: vi.fn(),
  capabilityGapsCreate: vi.fn(),
  capabilityGapsListByLevel: vi.fn(),
  capabilityProposalsCreate: vi.fn(),
  capabilityProposalsGetById: vi.fn(),
  capabilityProposalsTransition: vi.fn(),
  capabilityTestResultsRecord: vi.fn(),
  gapEscalationRulesGetForCurrentAgent: vi.fn(),
  tenantsList: vi.fn(),
  cognitiveModuleLogRecord: vi.fn(),
  cognitiveModuleLogRecent: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  loggerDebug: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => {
  const Anthropic = vi.fn().mockImplementation(() => ({
    messages: { create: anthropicCreateMock },
  }));
  return { default: Anthropic };
});

vi.mock('@/db/repositories.js', () => ({
  tenantsRepo: {
    list: tenantsList,
    findById: vi.fn(async (id: string) => tenantsState.find((t) => t.id === id) ?? null),
    create: vi.fn(),
  },
  capabilityGapsRepo: {
    listByLevels: capabilityGapsListByLevels,
    daysSinceLastProposed: capabilityGapsDaysSinceLastProposed,
    updateLevel: capabilityGapsUpdateLevel,
    create: capabilityGapsCreate,
    listByLevel: capabilityGapsListByLevel,
    upsert: vi.fn(),
    escalateLevel: vi.fn(),
  },
  capabilityProposalsRepo: {
    create: capabilityProposalsCreate,
    getById: capabilityProposalsGetById,
    transition: capabilityProposalsTransition,
    listByStatus: vi.fn(),
    listByGap: vi.fn(),
  },
  capabilityTestResultsRepo: {
    record: capabilityTestResultsRecord,
    listByProposal: vi.fn(),
    latestByProposal: vi.fn(),
  },
  gapEscalationRulesRepo: {
    getForCurrentAgent: gapEscalationRulesGetForCurrentAgent,
    upsert: vi.fn(),
  },
  cognitiveModuleLogRepo: {
    record: cognitiveModuleLogRecord,
    recentByModule: cognitiveModuleLogRecent,
  },
}));

vi.mock('@/lib/logger.js', () => ({
  logger: {
    info: loggerInfo,
    warn: loggerWarn,
    error: loggerError,
    debug: loggerDebug,
  },
}));

// ---------- Helpers / factories ----------
function makeGap(overrides: Partial<AgentCapabilityGap> = {}): AgentCapabilityGap {
  const now = new Date();
  return {
    id: 'gap-1',
    tenant_id: 'tenant-a',
    agent_id: 'default',
    capability_description: 'consultar status do pedido por id',
    tipo: 'tool',
    contexto: null,
    frequency_score: 1,
    severity_score: 1,
    current_level: GapLevel.SILENT,
    source_candidate_id: null,
    last_observed: now,
    last_level_change_at: now,
    created_at: now,
    ...overrides,
  } as AgentCapabilityGap;
}

function makeProposal(overrides: Partial<CapabilityProposal> = {}): CapabilityProposal {
  const now = new Date();
  return {
    id: 'prop-1',
    tenant_id: 'default',
    agent_id: 'default',
    gap_id: 'gap-1',
    capability_type: 'tool',
    title: 'Rastreador de Pedidos',
    description: 'Tool para consultar status de pedido por id',
    proposed_spec: { inputs: ['order_id'], outputs: ['status'] },
    motivation: 'pergunta recorrente sem capability disponível',
    expected_impact: 'resolve 5+ casos/semana',
    test_scenarios: [],
    status: 'draft',
    submitted_at: null,
    decided_at: null,
    decided_by: null,
    decision_reason: null,
    delivered_at: null,
    delivery_artifact_ref: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  } as CapabilityProposal;
}

function happyJson(): string {
  return JSON.stringify({
    capability_type: 'tool',
    title: 'Rastreador de Pedidos',
    description: 'Tool para consultar status de pedido por id',
    proposed_spec: { inputs: ['order_id'], outputs: ['status'] },
    motivation: 'pergunta recorrente sem capability disponível',
    expected_impact: 'resolve 5+ casos/semana',
    test_scenarios: [
      {
        name: 'feliz',
        given: 'pedido existe',
        when: 'consulta retorna status enviado',
        then: 'status enviado',
      },
    ],
  });
}

async function flushMicrotasks(): Promise<void> {
  // Allow fire-and-forget proposer promise + .then to run before assertions.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// Sets up in-memory implementations on the hoisted mocks for repos.
function wireRepoImplementations() {
  // tenantsRepo.list
  tenantsList.mockImplementation(async () => tenantsState.slice());

  // capabilityGapsRepo.listByLevels — filter from gapsState by current tenant.
  capabilityGapsListByLevels.mockImplementation(async (levels: GapLevel[]) => {
    const { getCurrentTenant, getCurrentAgent } = await import('@/db/tenant-context.js');
    const tid = getCurrentTenant();
    const aid = getCurrentAgent();
    return Object.values(gapsState).filter(
      (g) =>
        g.tenant_id === tid &&
        g.agent_id === aid &&
        levels.includes(g.current_level as GapLevel),
    );
  });

  // capabilityGapsRepo.daysSinceLastProposed — always null in this suite
  // (cooldown not the focus of these scenarios). Per-scenario overrides allowed.
  capabilityGapsDaysSinceLastProposed.mockResolvedValue(null);

  // capabilityGapsRepo.updateLevel — mutate in-memory and set timestamp.
  capabilityGapsUpdateLevel.mockImplementation(
    async (args: { id: string; new_level: GapLevel }) => {
      const row = gapsState[args.id];
      if (!row) return;
      gapsState[args.id] = {
        ...row,
        current_level: args.new_level,
        last_level_change_at: new Date(),
      };
    },
  );

  // capabilityGapsRepo.create — insert a fresh gap row (used by revert path).
  capabilityGapsCreate.mockImplementation(
    async (input: { capability_description: string; tipo: string; contexto?: string }) => {
      const id = `gap-${Math.random().toString(36).slice(2)}`;
      const now = new Date();
      const row: AgentCapabilityGap = {
        id,
        tenant_id: 'default',
        agent_id: 'default',
        capability_description: input.capability_description,
        tipo: input.tipo,
        contexto: input.contexto ?? null,
        frequency_score: 1,
        severity_score: 1,
        current_level: GapLevel.SILENT,
        source_candidate_id: null,
        last_observed: now,
        last_level_change_at: now,
        created_at: now,
      } as AgentCapabilityGap;
      gapsState[id] = row;
      return row;
    },
  );

  // capabilityGapsRepo.listByLevel — single-level variant.
  capabilityGapsListByLevel.mockImplementation(async (level: string) => {
    const { getCurrentTenant, getCurrentAgent } = await import('@/db/tenant-context.js');
    const tid = getCurrentTenant();
    const aid = getCurrentAgent();
    return Object.values(gapsState).filter(
      (g) => g.tenant_id === tid && g.agent_id === aid && g.current_level === level,
    );
  });

  // gapEscalationRulesRepo.getForCurrentAgent — null by default (uses DEFAULTs).
  gapEscalationRulesGetForCurrentAgent.mockResolvedValue(null);

  // capabilityProposalsRepo.create — insert a new draft proposal.
  capabilityProposalsCreate.mockImplementation(
    async (input: {
      gap_id?: string;
      capability_type: 'tool' | 'knowledge' | 'procedure' | 'integration' | 'other';
      title: string;
      description: string;
      proposed_spec: unknown;
      motivation: string;
      expected_impact?: string;
      test_scenarios: unknown[];
    }) => {
      const id = `prop-${Math.random().toString(36).slice(2)}`;
      const now = new Date();
      const row: CapabilityProposal = {
        id,
        tenant_id: 'default',
        agent_id: 'default',
        gap_id: input.gap_id ?? null,
        capability_type: input.capability_type,
        title: input.title,
        description: input.description,
        proposed_spec: input.proposed_spec,
        motivation: input.motivation,
        expected_impact: input.expected_impact ?? null,
        test_scenarios: input.test_scenarios,
        status: 'draft',
        submitted_at: null,
        decided_at: null,
        decided_by: null,
        decision_reason: null,
        delivered_at: null,
        delivery_artifact_ref: null,
        created_at: now,
        updated_at: now,
      } as CapabilityProposal;
      proposalsState[id] = row;
      return row;
    },
  );

  // capabilityProposalsRepo.getById — direct lookup.
  capabilityProposalsGetById.mockImplementation(
    async (id: string) => proposalsState[id] ?? null,
  );

  // capabilityProposalsRepo.transition — full state-machine emulation.
  // Mirrors production rules incl. P87-C3 (testing intermediate + reverted).
  capabilityProposalsTransition.mockImplementation(
    async (args: {
      id: string;
      to: 'submitted' | 'approved' | 'rejected' | 'testing' | 'delivered' | 'reverted';
      decided_by?: string;
      decision_reason?: string;
      delivery_artifact_ref?: string;
      revert_reason?: string;
      last_test_outcome?: 'pass' | 'fail' | 'error';
    }) => {
      const row = proposalsState[args.id];
      if (!row) return { ok: false as const, reason: 'not_found' as const };
      const from = row.status as
        | 'draft'
        | 'submitted'
        | 'approved'
        | 'rejected'
        | 'testing'
        | 'delivered'
        | 'reverted';
      if (from === 'rejected' || from === 'reverted') {
        return { ok: false as const, reason: 'invalid_transition' as const };
      }
      if (from === args.to) {
        return { ok: false as const, reason: 'invalid_transition' as const };
      }
      const allowed: Record<string, string[]> = {
        draft: ['submitted'],
        submitted: ['approved', 'rejected'],
        approved: ['testing'],
        testing: ['delivered', 'reverted'],
        delivered: ['reverted'],
      };
      if (!allowed[from]?.includes(args.to)) {
        return { ok: false as const, reason: 'invalid_transition' as const };
      }
      const now = new Date();
      const patch: Partial<CapabilityProposal> = {
        status: args.to,
        updated_at: now,
      };
      if (args.to === 'submitted') {
        patch.submitted_at = now;
      } else if (args.to === 'approved' || args.to === 'rejected') {
        patch.decided_at = now;
        if (args.decided_by) patch.decided_by = args.decided_by;
        if (args.decision_reason) patch.decision_reason = args.decision_reason;
      } else if (args.to === 'delivered') {
        patch.delivered_at = now;
        if (args.delivery_artifact_ref) patch.delivery_artifact_ref = args.delivery_artifact_ref;
        if (args.last_test_outcome) {
          (patch as Record<string, unknown>).last_test_outcome = args.last_test_outcome;
          (patch as Record<string, unknown>).last_test_at = now;
        }
      } else if (args.to === 'reverted') {
        (patch as Record<string, unknown>).reverted_at = now;
        if (args.revert_reason)
          (patch as Record<string, unknown>).revert_reason = args.revert_reason;
        if (args.last_test_outcome) {
          (patch as Record<string, unknown>).last_test_outcome = args.last_test_outcome;
          (patch as Record<string, unknown>).last_test_at = now;
        }
      }
      const updated = { ...row, ...patch } as CapabilityProposal;
      proposalsState[args.id] = updated;
      return { ok: true as const, updated };
    },
  );

  // capabilityTestResultsRepo.record — append to state and return row.
  capabilityTestResultsRecord.mockImplementation(
    async (input: {
      proposal_id: string;
      gap_id?: string;
      outcome: 'pass' | 'fail' | 'error';
      scenarios_run: unknown[];
      scenarios_passed: number;
      scenarios_failed: number;
      details?: unknown;
      triggered_revert?: boolean;
      technical_gap_id?: string;
    }) => {
      const id = `tres-${Math.random().toString(36).slice(2)}`;
      const now = new Date();
      const row: CapabilityTestResult = {
        id,
        tenant_id: 'default',
        agent_id: 'default',
        proposal_id: input.proposal_id,
        gap_id: input.gap_id ?? null,
        outcome: input.outcome,
        scenarios_run: input.scenarios_run,
        scenarios_passed: input.scenarios_passed,
        scenarios_failed: input.scenarios_failed,
        details: input.details ?? {},
        triggered_revert: input.triggered_revert ?? false,
        technical_gap_id: input.technical_gap_id ?? null,
        ran_at: now,
      } as CapabilityTestResult;
      testResultsState[id] = row;
      return row;
    },
  );

  // cognitiveModuleLogRepo — no-op + empty (runCognitiveModule depends on it).
  cognitiveModuleLogRecord.mockResolvedValue(undefined);
  cognitiveModuleLogRecent.mockResolvedValue([]);
}

// ---------- Suite ----------
describe('P5 dialogical acquisition — end-to-end', () => {
  beforeEach(async () => {
    for (const k of Object.keys(gapsState)) delete gapsState[k];
    for (const k of Object.keys(proposalsState)) delete proposalsState[k];
    for (const k of Object.keys(testResultsState)) delete testResultsState[k];
    tenantsState.length = 0;
    vi.clearAllMocks();
    wireRepoImplementations();

    const { featureFlags } = await import('@/config/feature-flags.js');
    featureFlags.reset();
  });

  afterEach(async () => {
    const { featureFlags } = await import('@/config/feature-flags.js');
    featureFlags.override(FeatureFlagName.DIALOGICAL_ACQUISITION, false);
    featureFlags.unkillSwitch(FeatureFlagName.DIALOGICAL_ACQUISITION);
    featureFlags.reset();
  });

  // ---------- Cenário 1 ----------
  it('cenário 1: gap escalation chain (silent → dashboard → mentionable → proposed + proposer)', async () => {
    const { featureFlags } = await import('@/config/feature-flags.js');
    featureFlags.override(FeatureFlagName.DIALOGICAL_ACQUISITION, true);

    const now = new Date();
    const tenant: Tenant = {
      id: 'tenant-a',
      nome: 'Tenant A',
      status: 'active',
      metadata: {},
      created_at: now,
      updated_at: now,
    } as Tenant;
    tenantsState.push(tenant);

    // Initial: silent gap, freq=1, sev=1 (below dashboard threshold of 3).
    const gapId = 'gap-chain-1';
    gapsState[gapId] = makeGap({
      id: gapId,
      tenant_id: 'tenant-a',
      capability_description: 'rastrear pedido',
      current_level: GapLevel.SILENT,
      frequency_score: 1,
      severity_score: 1,
      contexto: null,
    });

    const { runGapEscalationMonitor } = await import(
      '@/workers/gap-escalation-monitor.js'
    );

    // Step 1: bump freq to 3 → silent → dashboard.
    gapsState[gapId]!.frequency_score = 3;
    await runGapEscalationMonitor();
    await flushMicrotasks();

    expect(gapsState[gapId]!.current_level).toBe(GapLevel.DASHBOARD);
    const step1Changed = loggerInfo.mock.calls.find(
      (c) => c[1] === 'gap_escalation.changed',
    );
    expect(step1Changed).toBeDefined();
    expect(step1Changed![0]).toMatchObject({
      from: GapLevel.SILENT,
      to: GapLevel.DASHBOARD,
      tenant_id: 'tenant-a',
    });

    // Step 2: bump sev to 6 → dashboard → mentionable.
    loggerInfo.mockClear();
    gapsState[gapId]!.severity_score = 6;
    await runGapEscalationMonitor();
    await flushMicrotasks();

    expect(gapsState[gapId]!.current_level).toBe(GapLevel.MENTIONABLE);
    const step2Changed = loggerInfo.mock.calls.find(
      (c) => c[1] === 'gap_escalation.changed',
    );
    expect(step2Changed).toBeDefined();
    expect(step2Changed![0]).toMatchObject({
      from: GapLevel.DASHBOARD,
      to: GapLevel.MENTIONABLE,
    });

    // Step 3: bump freq=5 + sev=5 (combined=10 >= 8), set contexto so
    // distinct_contexts_count=2 >= 2 → mentionable → proposed +
    // proposer fires. Mock Anthropic returns valid JSON.
    loggerInfo.mockClear();
    gapsState[gapId]!.frequency_score = 5;
    gapsState[gapId]!.severity_score = 5;
    gapsState[gapId]!.contexto = 'cliente perguntou rastreamento de novo';
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: happyJson() }],
    });

    await runGapEscalationMonitor();
    await flushMicrotasks();

    expect(gapsState[gapId]!.current_level).toBe(GapLevel.PROPOSED);

    const step3Changed = loggerInfo.mock.calls.find(
      (c) => c[1] === 'gap_escalation.changed',
    );
    expect(step3Changed).toBeDefined();
    expect(step3Changed![0]).toMatchObject({
      from: GapLevel.MENTIONABLE,
      to: GapLevel.PROPOSED,
    });

    // Proposer fired: Anthropic called, capability_proposal row created in draft.
    expect(anthropicCreateMock).toHaveBeenCalledTimes(1);
    expect(capabilityProposalsCreate).toHaveBeenCalledTimes(1);
    const proposals = Object.values(proposalsState);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.status).toBe('draft');
    expect(proposals[0]!.gap_id).toBe(gapId);
    expect(proposals[0]!.title).toBe('Rastreador de Pedidos');

    // proposal_created log emitted (after fire-and-forget resolves).
    const proposalLog = loggerInfo.mock.calls.find(
      (c) => c[1] === 'gap_escalation.proposal_created',
    );
    expect(proposalLog).toBeDefined();
    expect((proposalLog![0] as Record<string, unknown>).proposal_id).toBe(
      proposals[0]!.id,
    );
  });

  // ---------- Cenário 2 ----------
  // P87-C3 (PR #87 review) — fluxo de produção agora exige
  // approved → testing → delivered via orchestrator. Direto approved → delivered
  // é invalid_transition (bypass do test gate é proibido).
  it('cenário 2: owner aprova proposta (draft → submitted → approved → testing → delivered); approved→delivered direto é invalid', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        // Pre-seed a draft proposal in mocked state.
        const seeded = makeProposal({
          id: 'prop-flow-1',
          status: 'draft',
          test_scenarios: [
            { name: 'smoke', given: 'on', when: 'returns status', then: 'status' },
          ],
        });
        proposalsState['prop-flow-1'] = seeded;

        const { capabilityProposalsRepo } = await import('@/db/repositories.js');

        // draft → submitted
        const r1 = await capabilityProposalsRepo.transition({
          id: 'prop-flow-1',
          to: 'submitted',
        });
        expect(r1.ok).toBe(true);
        if (r1.ok) {
          expect(r1.updated.status).toBe('submitted');
          expect(r1.updated.submitted_at).toBeInstanceOf(Date);
        }

        // submitted → approved (with decided_by)
        const r2 = await capabilityProposalsRepo.transition({
          id: 'prop-flow-1',
          to: 'approved',
          decided_by: 'owner-1',
        });
        expect(r2.ok).toBe(true);
        if (r2.ok) {
          expect(r2.updated.status).toBe('approved');
          expect(r2.updated.decided_by).toBe('owner-1');
          expect(r2.updated.decided_at).toBeInstanceOf(Date);
        }

        // approved → delivered DIRETO: invalid_transition (gate de teste).
        const bypass = await capabilityProposalsRepo.transition({
          id: 'prop-flow-1',
          to: 'delivered',
          delivery_artifact_ref: 'pr-123',
        });
        expect(bypass.ok).toBe(false);
        if (!bypass.ok) {
          expect(bypass.reason).toBe('invalid_transition');
        }
        // State unchanged: ainda em approved.
        expect(proposalsState['prop-flow-1']!.status).toBe('approved');

        // Caminho válido: orchestrator activateApprovedCapability faz
        // approved → testing → delivered + invoca runCapabilityTests.
        const { activateApprovedCapability } = await import(
          '@/cognition/capability-test-runner.js'
        );
        const r3 = await activateApprovedCapability({
          proposal_id: 'prop-flow-1',
          delivery_artifact_ref: 'pr-123',
        });
        expect(r3.ok).toBe(true);
        if (r3.ok) {
          expect(r3.outcome).toBe('pass');
          expect(r3.final_status).toBe('delivered');
        }
        expect(proposalsState['prop-flow-1']!.status).toBe('delivered');
        expect(proposalsState['prop-flow-1']!.delivery_artifact_ref).toBe('pr-123');
        // Test gate recorded:
        expect(
          (proposalsState['prop-flow-1'] as unknown as Record<string, unknown>)
            .last_test_outcome,
        ).toBe('pass');

        // Invalid path: re-seed a submitted and try submitted → delivered directly.
        proposalsState['prop-flow-2'] = makeProposal({
          id: 'prop-flow-2',
          status: 'submitted',
        });
        const bad = await capabilityProposalsRepo.transition({
          id: 'prop-flow-2',
          to: 'delivered',
        });
        expect(bad.ok).toBe(false);
        if (!bad.ok) {
          expect(bad.reason).toBe('invalid_transition');
        }
        // State unchanged.
        expect(proposalsState['prop-flow-2']!.status).toBe('submitted');
      },
    );
  });

  // ---------- Cenário 3 ----------
  it('cenário 3: test loop pass — 2 echo_test scenarios passam → outcome=pass, no revert', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        // 2 scenarios where `when` contains `then` → echo_test passes.
        proposalsState['prop-pass'] = makeProposal({
          id: 'prop-pass',
          gap_id: 'gap-pass',
          status: 'delivered',
          test_scenarios: [
            {
              name: 'feliz-1',
              given: 'sistema online',
              when: 'consulta retorna status disponivel',
              then: 'status disponivel',
            },
            {
              name: 'feliz-2',
              given: 'sistema online',
              when: 'consulta devolve status enviado',
              then: 'status enviado',
            },
          ],
        });

        const { runCapabilityTests } = await import(
          '@/cognition/capability-test-runner.js'
        );
        const r = await runCapabilityTests({ proposal_id: 'prop-pass' });

        expect(r.outcome).toBe('pass');
        expect(r.result_id).toBeTruthy();
        expect(capabilityGapsCreate).not.toHaveBeenCalled();

        // capability_test_result row recorded with triggered_revert=false.
        const recordCall = capabilityTestResultsRecord.mock.calls[0]?.[0] as {
          proposal_id: string;
          outcome: string;
          scenarios_passed: number;
          scenarios_failed: number;
          triggered_revert: boolean;
          technical_gap_id?: string;
        };
        expect(recordCall.proposal_id).toBe('prop-pass');
        expect(recordCall.outcome).toBe('pass');
        expect(recordCall.scenarios_passed).toBe(2);
        expect(recordCall.scenarios_failed).toBe(0);
        expect(recordCall.triggered_revert).toBe(false);
        expect(recordCall.technical_gap_id).toBeUndefined();

        // Stored row reflects the same outcome.
        const stored = Object.values(testResultsState)[0]!;
        expect(stored.outcome).toBe('pass');
        expect(stored.triggered_revert).toBe(false);
        expect(stored.technical_gap_id).toBeNull();
      },
    );
  });

  // ---------- Cenário 4 ----------
  it('cenário 4: test loop fail → revert path cria gap technical com prefixo [técnica]', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        // 1 scenario where `when` does NOT contain `then` → fail.
        proposalsState['prop-fail'] = makeProposal({
          id: 'prop-fail',
          gap_id: 'gap-original',
          status: 'delivered',
          title: 'Rastreador',
          test_scenarios: [
            {
              name: 'cenario-falha',
              given: 'sistema online',
              when: 'algo completamente diferente do esperado',
              then: 'resultado-X',
            },
          ],
        });

        const { runCapabilityTests } = await import(
          '@/cognition/capability-test-runner.js'
        );
        const r = await runCapabilityTests({ proposal_id: 'prop-fail' });

        expect(r.outcome).toBe('fail');
        expect(r.result_id).toBeTruthy();

        // capabilityGapsRepo.create called for the technical gap.
        expect(capabilityGapsCreate).toHaveBeenCalledTimes(1);
        const createArgs = capabilityGapsCreate.mock.calls[0]?.[0] as {
          capability_description: string;
          tipo: string;
          contexto: string;
        };
        expect(createArgs.tipo).toBe('technical');
        expect(createArgs.capability_description.startsWith('[técnica]')).toBe(true);
        expect(createArgs.capability_description).toContain('Rastreador');

        // Test result row: triggered_revert=true + technical_gap_id populated.
        const recordCall = capabilityTestResultsRecord.mock.calls[0]?.[0] as {
          proposal_id: string;
          outcome: string;
          scenarios_failed: number;
          triggered_revert: boolean;
          technical_gap_id: string;
        };
        expect(recordCall.proposal_id).toBe('prop-fail');
        expect(recordCall.outcome).toBe('fail');
        expect(recordCall.scenarios_failed).toBe(1);
        expect(recordCall.triggered_revert).toBe(true);
        expect(recordCall.technical_gap_id).toBeTruthy();

        // The created gap exists in state with tipo=technical.
        const createdGap = Object.values(gapsState).find(
          (g) => g.id === recordCall.technical_gap_id,
        );
        expect(createdGap).toBeDefined();
        expect(createdGap!.tipo).toBe('technical');
        expect(createdGap!.capability_description.startsWith('[técnica]')).toBe(true);
      },
    );
  });

  // ---------- Cenário 5 ----------
  it('cenário 5: SILENT não notifica (acceptance criterion #1 — hard guarantee)', async () => {
    const { notifyOwnerForGap } = await import('@/agent/notification-adapter.js');

    const gap = makeGap({
      id: 'gap-silent',
      current_level: GapLevel.SILENT,
      capability_description: 'capacidade qualquer',
      frequency_score: 1,
      severity_score: 1,
    });

    const result = await notifyOwnerForGap({ gap });

    expect(result.channel).toBe('none');
    expect(result.notified).toBe(false);

    // Defesa em profundidade: nenhum log/queue side-effect para gaps silent.
    const queuedLog = loggerInfo.mock.calls.find(
      (c) => c[1] === 'owner_notification.queued_for_proposed_gap',
    );
    expect(queuedLog).toBeUndefined();
  });

  // ---------- Cenário 6 ----------
  // P87-C2 (PR #87 review): atomicidade artifact-first. Para a transição
  // mentionable → proposed, o worker agora invoca o proposer ANTES de flipar
  // o nível e só promove se ok:true. Com flag OFF o proposer retorna
  // { ok:false, reason:'llm_unavailable' } → o gap fica em mentionable
  // (sem órfão em proposed sem proposal). O engine determinístico
  // continua independente da flag para as transições SILENT/DASHBOARD/MENTIONABLE.
  it('cenário 6: flag OFF gates proposer (no Sonnet spend); gap NÃO promove a proposed sem artifact (P87-C2)', async () => {
    const { featureFlags } = await import('@/config/feature-flags.js');
    featureFlags.override(FeatureFlagName.DIALOGICAL_ACQUISITION, false);

    const now = new Date();
    const tenant: Tenant = {
      id: 'tenant-flag-off',
      nome: 'Flag OFF',
      status: 'active',
      metadata: {},
      created_at: now,
      updated_at: now,
    } as Tenant;
    tenantsState.push(tenant);

    // Pre-seed a mentionable gap que satisfaz TODOS os thresholds proposed.
    // Sem flag, o proposer falha → gap permanece em mentionable (P87-C2).
    const gapId = 'gap-flag-off';
    gapsState[gapId] = makeGap({
      id: gapId,
      tenant_id: 'tenant-flag-off',
      current_level: GapLevel.MENTIONABLE,
      frequency_score: 5,
      severity_score: 5,
      contexto: 'contexto recorrente',
    });

    const { runGapEscalationMonitor } = await import(
      '@/workers/gap-escalation-monitor.js'
    );
    await runGapEscalationMonitor();
    await flushMicrotasks();

    // P87-C2: gap NÃO foi promovido a proposed porque o proposer falhou
    // (flag OFF). Sem artifact em capability_proposals, o nível fica como
    // estava — re-tentado no próximo tick quando flag estiver ON.
    expect(gapsState[gapId]!.current_level).toBe(GapLevel.MENTIONABLE);

    // Proposer short-circuits sem chamar Anthropic e sem criar capability_proposal.
    expect(anthropicCreateMock).not.toHaveBeenCalled();
    expect(capabilityProposalsCreate).not.toHaveBeenCalled();

    // proposer_failed log emitted with reason llm_unavailable.
    const failedLog = loggerWarn.mock.calls.find(
      (c) => c[1] === 'gap_escalation.proposal_failed',
    );
    expect(failedLog).toBeDefined();
    const failedMeta = failedLog![0] as Record<string, unknown>;
    expect(failedMeta.gap_id).toBe(gapId);
    expect(failedMeta.reason).toBe('llm_unavailable');

    // Nenhum log gap_escalation.changed para esta promoção (não houve
    // promoção, pois proposer falhou). Sanity: changed só dispara em
    // promoções confirmadas.
    const changedLog = loggerInfo.mock.calls.find(
      (c) =>
        c[1] === 'gap_escalation.changed' &&
        (c[0] as Record<string, unknown>).to === GapLevel.PROPOSED,
    );
    expect(changedLog).toBeUndefined();
  });

  // ---------- Cenário 7 (P87-C4) ----------
  // Burst-protection: múltiplos gaps elegíveis a proposed em uma rodada
  // não devem todos promover. Após a primeira promoção bem-sucedida, o
  // cooldown local é debitado para 0 e os demais ficam em mentionable.
  it('cenário 7: P87-C4 — múltiplos gaps elegíveis, apenas 1 promove por rodada (cooldown atomic in-loop)', async () => {
    const { featureFlags } = await import('@/config/feature-flags.js');
    featureFlags.override(FeatureFlagName.DIALOGICAL_ACQUISITION, true);

    const now = new Date();
    const tenant: Tenant = {
      id: 'tenant-burst',
      nome: 'Burst',
      status: 'active',
      metadata: {},
      created_at: now,
      updated_at: now,
    } as Tenant;
    tenantsState.push(tenant);

    // Duas regras com cooldown 14 dias (DEFAULT_RULES).
    // daysSinceLastProposed=null (nenhuma proposed ainda) → primeiro gap
    // passa; depois deve ser debitado para 0 → segundo gap NÃO passa o gate.
    for (let i = 1; i <= 2; i++) {
      const id = `gap-burst-${i}`;
      gapsState[id] = makeGap({
        id,
        tenant_id: 'tenant-burst',
        current_level: GapLevel.MENTIONABLE,
        frequency_score: 5,
        severity_score: 5,
        contexto: `contexto-${i}`,
      });
    }

    // Anthropic responde apenas uma vez — se o worker chamasse 2x seria spam.
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: happyJson() }],
    });

    const { runGapEscalationMonitor } = await import(
      '@/workers/gap-escalation-monitor.js'
    );
    await runGapEscalationMonitor();
    await flushMicrotasks();

    // Exatamente 1 dos gaps avançou para proposed.
    const promotedCount = Object.values(gapsState).filter(
      (g) => g.current_level === GapLevel.PROPOSED,
    ).length;
    expect(promotedCount).toBe(1);

    // 1 capability_proposal criada (não 2).
    expect(capabilityProposalsCreate).toHaveBeenCalledTimes(1);
    expect(anthropicCreateMock).toHaveBeenCalledTimes(1);
  });
});
