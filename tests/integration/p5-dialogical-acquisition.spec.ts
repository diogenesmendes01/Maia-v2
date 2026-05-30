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
// Issue #346: import the ALS getters statically (not via `await import`) so the
// repo mocks can read the current (tenant, agent) SYNCHRONOUSLY. A dynamic
// `await import` inside a mock would add microtask hops that desynchronise the
// fire-and-forget proposer in cenário 1 from `flushMicrotasks()`.
import {
  runWithTenantContext,
  getCurrentTenant,
  getCurrentAgent,
} from '@/db/tenant-context.js';
import { FeatureFlagName, GapLevel } from '@/types/enums.js';
// Runtime import (not type-only): the open-gap enumeration assertion below
// checks the production query targets THIS exact table object. `@/db/schema.js`
// is not mocked, so this is the same reference gap-escalation-monitor uses.
import { agent_capability_gaps } from '@/db/schema.js';
import type {
  AgentCapabilityGap,
  CapabilityProposal,
  CapabilityTestResult,
  GapEscalationRule,
  Tenant,
} from '@/db/schema.js';

// ---------- real (tenant, agent) under test (issue #346) ----------
// These fixtures used to seed the legacy `'default'` sentinel for agent_id
// (and tenant_id in several scenarios), so they never exercised the post-#323
// per-agent fan-out path with a REAL agent. Migrate to a realistic tenant slug
// + a concrete agent so every scenario proves the non-default `(tenant, agent)`
// path end-to-end. `'default'` is the legacy bucket the tenant-context guard
// meters/rejects — a regression that re-introduced it would now fail here.
const TEST_TENANT_ID = 'acme';
const TEST_AGENT_ID = 'test-agent-1';

// ---------- in-memory state ----------
const gapsState: Record<string, AgentCapabilityGap> = {};
const proposalsState: Record<string, CapabilityProposal> = {};
const testResultsState: Record<string, CapabilityTestResult> = {};
const tenantsState: Tenant[] = [];
// Issue #346: every (tenant_id, agent_id) the gap-escalation-monitor opens via
// runWithTenantContext is captured here (read off the ALS inside the
// capabilityGapsRepo.listByLevels mock, which the worker calls once per tuple).
// Lets a scenario assert the worker ran under the REAL agent — never `'default'`.
const monitorContextsSeen: Array<{ tenant_id: string; agent_id: string }> = [];

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
  selectDistinctFromSpy,
  selectDistinctWhereSpy,
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
  // Issue #323 review (NITPICK): capture the args the production
  // enumeration passes to db.selectDistinct().from(...).where(...), so the
  // mock can be asserted against the EXPECTED table + level filter — a future
  // regression that queries the wrong table or breaks the open-level filter is
  // caught instead of silently returning the fixed open-gap set.
  selectDistinctFromSpy: vi.fn(),
  selectDistinctWhereSpy: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => {
  const Anthropic = vi.fn(function (this: unknown) {
    return { messages: { create: anthropicCreateMock } };
  });
  return { default: Anthropic };
});

// ---------- db/client mock ----------
// Issue #323 (Phase 3): runGapEscalationMonitor now enumerates DISTINCT
// (tenant_id, agent_id) tuples with at least one OPEN-level gap
// (silent/dashboard/mentionable) directly via `db.selectDistinct(...)` on the
// `agent_capability_gaps` table (work-table fan-out, replacing the old
// tenantsRepo.list() loop). That call bypasses the repositories mock below and
// would otherwise hit the real pg pool (ECONNREFUSED in the no-DB unit lane).
// Mirror the enumeration over the in-memory `gapsState` so the dispatcher
// yields exactly the seeded open-gap tuples before opening per-tuple context —
// same idiom as the sibling reaper integration spec (p3c) and the rewritten
// unit spec (tests/unit/gap-escalation-monitor.spec.ts). The OPEN levels
// (silent/dashboard/mentionable) are inlined to avoid any hoisting/TDZ
// coupling with the vi.mock factory.
vi.mock('@/db/client.js', () => ({
  db: {
    selectDistinct: () => ({
      // Record the table passed to .from() and the predicate passed to
      // .where() so a test can assert the enumeration targets
      // `agent_capability_gaps` filtered by the open levels (see spies below).
      from: (table: unknown) => {
        selectDistinctFromSpy(table);
        return {
          where: async (predicate: unknown) => {
            selectDistinctWhereSpy(predicate);
            const openLevels = new Set<string>(['silent', 'dashboard', 'mentionable']);
            const seen = new Set<string>();
            const pairs: Array<{ tenant_id: string; agent_id: string }> = [];
            for (const g of Object.values(gapsState)) {
              if (!openLevels.has(g.current_level)) continue;
              const key = `${g.tenant_id}|${g.agent_id}`;
              if (seen.has(key)) continue;
              seen.add(key);
              pairs.push({ tenant_id: g.tenant_id, agent_id: g.agent_id });
            }
            return pairs;
          },
        };
      },
    }),
  },
  pool: {},
  withTx: vi.fn(),
  shutdownDb: vi.fn(),
  isDbConnected: () => true,
  probeDb: async () => true,
}));

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
    tenant_id: TEST_TENANT_ID,
    agent_id: TEST_AGENT_ID,
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
    tenant_id: TEST_TENANT_ID,
    agent_id: TEST_AGENT_ID,
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

/**
 * Issue #323 review (NITPICK) — introspect a drizzle `inArray(column, values)`
 * SQL predicate (the one the open-gap enumeration builds) and return
 * { column, values } in a way tolerant of drizzle internals: walk
 * `queryChunks`, pull the column name from the column chunk and the literal
 * values from the `Array` param chunk. Returns nulls if the shape is
 * unexpected so the caller's assertion fails loudly rather than throwing.
 */
function introspectInArrayPredicate(predicate: unknown): {
  column: string | null;
  values: unknown[] | null;
} {
  const chunks = (predicate as { queryChunks?: unknown[] } | null)?.queryChunks;
  if (!Array.isArray(chunks)) return { column: null, values: null };
  let column: string | null = null;
  let values: unknown[] | null = null;
  for (const chunk of chunks) {
    // Column chunk: a Column instance exposes a `.name`.
    if (column === null && chunk && typeof (chunk as { name?: unknown }).name === 'string') {
      column = (chunk as { name: string }).name;
    }
    // Value chunk: `inArray` inlines the list as a JS array of Param objects,
    // each carrying the literal under `.value`.
    if (values === null && Array.isArray(chunk)) {
      values = (chunk as Array<{ value?: unknown }>).map((p) =>
        p && typeof p === 'object' && 'value' in p ? (p as { value: unknown }).value : p,
      );
    }
  }
  return { column, values };
}

// Sets up in-memory implementations on the hoisted mocks for repos.
function wireRepoImplementations() {
  // tenantsRepo.list
  tenantsList.mockImplementation(async () => tenantsState.slice());

  // capabilityGapsRepo.listByLevels — filter from gapsState by current tenant.
  capabilityGapsListByLevels.mockImplementation(async (levels: GapLevel[]) => {
    const tid = getCurrentTenant();
    const aid = getCurrentAgent();
    // Issue #346: record the (tenant, agent) the monitor opened so a scenario
    // can assert the worker ran under the REAL agent — never `'default'`.
    // `getCurrentAgent()` rejects/meters the `'default'` sentinel, so the value
    // it returned is the post-migration proof point.
    monitorContextsSeen.push({ tenant_id: tid, agent_id: aid });
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
      // Issue #346: the real repo stamps tenant_id/agent_id from the ALS via
      // applyTenantGuard. Mirror that (synchronously — see static import note)
      // so the created gap is scoped to the REAL (tenant, agent) the revert
      // path runs under — never `'default'`.
      const id = `gap-${Math.random().toString(36).slice(2)}`;
      const now = new Date();
      const row: AgentCapabilityGap = {
        id,
        tenant_id: getCurrentTenant(),
        agent_id: getCurrentAgent(),
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
      // Issue #346: the real repo stamps tenant_id/agent_id from the ALS via
      // applyTenantGuard. The proposer fires inside the worker's per-tuple
      // context, so read the live ALS (synchronously — see static import note)
      // to scope the draft to the REAL (tenant, agent) — never `'default'`.
      const id = `prop-${Math.random().toString(36).slice(2)}`;
      const now = new Date();
      const row: CapabilityProposal = {
        id,
        tenant_id: getCurrentTenant(),
        agent_id: getCurrentAgent(),
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
  capabilityProposalsTransition.mockImplementation(
    async (args: {
      id: string;
      to: 'submitted' | 'approved' | 'rejected' | 'delivered';
      decided_by?: string;
      decision_reason?: string;
      delivery_artifact_ref?: string;
    }) => {
      const row = proposalsState[args.id];
      if (!row) return { ok: false as const, reason: 'not_found' as const };
      const from = row.status as 'draft' | 'submitted' | 'approved' | 'rejected' | 'delivered';
      if (from === 'rejected' || from === 'delivered') {
        return { ok: false as const, reason: 'invalid_transition' as const };
      }
      if (from === args.to) {
        return { ok: false as const, reason: 'invalid_transition' as const };
      }
      const allowed: Record<string, string[]> = {
        draft: ['submitted'],
        submitted: ['approved', 'rejected'],
        approved: ['delivered'],
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
      // Issue #346: the real repo stamps tenant_id/agent_id from the ALS via
      // applyTenantGuard. Mirror that (synchronously — see static import note)
      // so the result row is scoped to the REAL (tenant, agent) the test loop
      // runs under — never `'default'`.
      const id = `tres-${Math.random().toString(36).slice(2)}`;
      const now = new Date();
      const row: CapabilityTestResult = {
        id,
        tenant_id: getCurrentTenant(),
        agent_id: getCurrentAgent(),
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
    monitorContextsSeen.length = 0;
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
      id: TEST_TENANT_ID,
      nome: 'Acme',
      status: 'active',
      metadata: {},
      created_at: now,
      updated_at: now,
    } as Tenant;
    tenantsState.push(tenant);

    // Initial: silent gap, freq=1, sev=1 (below dashboard threshold of 3).
    // Issue #346: owned by the REAL (tenant, agent) — 'acme' / 'test-agent-1'
    // (agent_id comes from makeGap's updated default). The monitor enumerates
    // this tuple off gapsState and opens per-tuple context with that exact
    // agent, exercising the post-#323 per-agent fan-out (no `agent_id:'default'`).
    const gapId = 'gap-chain-1';
    gapsState[gapId] = makeGap({
      id: gapId,
      tenant_id: TEST_TENANT_ID,
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
      tenant_id: TEST_TENANT_ID,
      agent_id: TEST_AGENT_ID,
    });

    // Issue #346: the monitor opened context for the REAL (tenant, agent) and
    // never the `'default'` literal. Captured off the ALS inside the
    // listByLevels mock (called once per tuple inside the worker context).
    expect(monitorContextsSeen).toContainEqual({
      tenant_id: TEST_TENANT_ID,
      agent_id: TEST_AGENT_ID,
    });
    for (const ctx of monitorContextsSeen) {
      expect(ctx.tenant_id).not.toBe('default');
      expect(ctx.agent_id).not.toBe('default');
    }

    // Issue #323 review (NITPICK): the open-gap enumeration must target the
    // `agent_capability_gaps` table filtered by the open levels. Without these
    // assertions the db.selectDistinct mock returns the fixed open-gap set
    // regardless of which table/predicate the production code passes, so a
    // regression that queried the wrong table or broke the level filter would
    // pass silently. Assert the exact table reference + the level filter shape.
    expect(selectDistinctFromSpy).toHaveBeenCalledWith(agent_capability_gaps);
    expect(selectDistinctWhereSpy).toHaveBeenCalled();
    const wherePredicate =
      selectDistinctWhereSpy.mock.calls[selectDistinctWhereSpy.mock.calls.length - 1]![0];
    const { column: filterColumn, values: filterValues } =
      introspectInArrayPredicate(wherePredicate);
    expect(filterColumn).toBe('current_level');
    expect(filterValues).not.toBeNull();
    expect([...(filterValues as unknown[])].sort()).toEqual(
      [GapLevel.SILENT, GapLevel.DASHBOARD, GapLevel.MENTIONABLE].sort(),
    );

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
    // Issue #346: the proposal the fire-and-forget proposer created is scoped
    // to the REAL (tenant, agent) the worker opened per tuple — never
    // `'default'`. Proves the proposer inherited the post-migration context.
    expect(proposals[0]!.tenant_id).toBe(TEST_TENANT_ID);
    expect(proposals[0]!.agent_id).toBe(TEST_AGENT_ID);

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
  it('cenário 2: owner aprova proposta (draft → submitted → approved → delivered); invalid transition rejected', async () => {
    await runWithTenantContext(
      { tenant_id: TEST_TENANT_ID, agent_id: TEST_AGENT_ID },
      async () => {
        // Pre-seed a draft proposal in mocked state.
        const seeded = makeProposal({ id: 'prop-flow-1', status: 'draft' });
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

        // approved → delivered (with delivery_artifact_ref)
        const r3 = await capabilityProposalsRepo.transition({
          id: 'prop-flow-1',
          to: 'delivered',
          delivery_artifact_ref: 'pr-123',
        });
        expect(r3.ok).toBe(true);
        if (r3.ok) {
          expect(r3.updated.status).toBe('delivered');
          expect(r3.updated.delivery_artifact_ref).toBe('pr-123');
          expect(r3.updated.delivered_at).toBeInstanceOf(Date);
        }

        // Invalid path: re-seed a draft and try submitted → delivered directly.
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
      { tenant_id: TEST_TENANT_ID, agent_id: TEST_AGENT_ID },
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
        // Issue #346: the result row is scoped to the REAL (tenant, agent) the
        // test loop ran under — never `'default'`.
        expect(stored.tenant_id).toBe(TEST_TENANT_ID);
        expect(stored.agent_id).toBe(TEST_AGENT_ID);
        expect(stored.tenant_id).not.toBe('default');
        expect(stored.agent_id).not.toBe('default');
      },
    );
  });

  // ---------- Cenário 4 ----------
  it('cenário 4: test loop fail → revert path cria gap technical com prefixo [técnica]', async () => {
    await runWithTenantContext(
      { tenant_id: TEST_TENANT_ID, agent_id: TEST_AGENT_ID },
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
        // Issue #346: the revert-derived gap is owned by the REAL (tenant,
        // agent) the test loop ran under — never `'default'`. The technical gap
        // must stay scoped to the agent whose capability failed.
        expect(createdGap!.tenant_id).toBe(TEST_TENANT_ID);
        expect(createdGap!.agent_id).toBe(TEST_AGENT_ID);
        expect(createdGap!.tenant_id).not.toBe('default');
        expect(createdGap!.agent_id).not.toBe('default');
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
  it('cenário 6: flag OFF gates proposer (no Sonnet spend) mas engine determinístico ainda escala', async () => {
    const { featureFlags } = await import('@/config/feature-flags.js');
    featureFlags.override(FeatureFlagName.DIALOGICAL_ACQUISITION, false);

    // Issue #346: a SECOND real (tenant, agent) — distinct from the suite-wide
    // 'acme' / 'test-agent-1' — so this scenario also proves the per-#323
    // fan-out enumerates whichever real tuple owns the open gap (not a single
    // hard-coded pair, and never `'default'`).
    const FLAG_OFF_TENANT_ID = 'globex';
    const FLAG_OFF_AGENT_ID = 'test-agent-2';
    const now = new Date();
    const tenant: Tenant = {
      id: FLAG_OFF_TENANT_ID,
      nome: 'Globex',
      status: 'active',
      metadata: {},
      created_at: now,
      updated_at: now,
    } as Tenant;
    tenantsState.push(tenant);

    // Pre-seed a mentionable gap that satisfies ALL proposed thresholds:
    // freq=5 + sev=5 (combined=10 >= 8), contexto present (distinct=2 >= 2),
    // no cooldown. Engine would promote silent path → proposed regardless of flag.
    const gapId = 'gap-flag-off';
    gapsState[gapId] = makeGap({
      id: gapId,
      tenant_id: FLAG_OFF_TENANT_ID,
      agent_id: FLAG_OFF_AGENT_ID,
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

    // Engine still promotes the gap (deterministic, doesn't depend on flag).
    expect(gapsState[gapId]!.current_level).toBe(GapLevel.PROPOSED);

    // Issue #346: the monitor opened context for the REAL (tenant, agent) that
    // owns the gap and never for the `'default'` literal.
    expect(monitorContextsSeen).toContainEqual({
      tenant_id: FLAG_OFF_TENANT_ID,
      agent_id: FLAG_OFF_AGENT_ID,
    });
    for (const ctx of monitorContextsSeen) {
      expect(ctx.tenant_id).not.toBe('default');
      expect(ctx.agent_id).not.toBe('default');
    }

    // BUT proposer short-circuits without calling Anthropic and without
    // creating a capability_proposal.
    expect(anthropicCreateMock).not.toHaveBeenCalled();
    expect(capabilityProposalsCreate).not.toHaveBeenCalled();

    // proposer_failed log emitted with reason llm_unavailable (from worker
    // .then handler since proposer returns ok:false).
    const failedLog = loggerWarn.mock.calls.find(
      (c) => c[1] === 'gap_escalation.proposal_failed',
    );
    expect(failedLog).toBeDefined();
    const failedMeta = failedLog![0] as Record<string, unknown>;
    expect(failedMeta.gap_id).toBe(gapId);
    expect(failedMeta.reason).toBe('llm_unavailable');
  });
});
