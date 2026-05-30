/**
 * P5 Task 9 — `gap-escalation-monitor` worker tests.
 *
 * O worker orquestra (a cada 30 min) o engine determinístico (Task 6) e, na
 * transição para `proposed`, dispara o proposer (Task 7) em fire-and-forget.
 *
 * Issue #323 (Phase 3) — per-agent fan-out: o worker enumera tuplas
 * (tenant_id, agent_id) DISTINCT que têm gaps em nível aberto em
 * `agent_capability_gaps` e abre `runWithTenantContext` por tupla REAL —
 * nunca mais `agent_id:'default'`.
 *
 * Cenários cobertos:
 *   1. Gap silent + freq=3 (threshold default) → escala para dashboard.
 *   2. Gap mentionable + condições satisfeitas → escala para proposed +
 *      proposer chamado.
 *   3. Gap mentionable + cooldown vigente → sem mudança.
 *   4. (sem tuplas) → no-op.
 *   5. Rules customizadas via getForCurrentAgent() sobrescrevem defaults.
 *   6. Multi-tupla: itera contextos REAIS isolados.
 *   7. (regressão #323) DOIS agents no MESMO tenant → AMBOS processados; o
 *      gap do agent não-default é escalado; nenhum contexto 'default' aberto.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GapLevel } from '@/types/enums.js';
import type { AgentCapabilityGap, GapEscalationRule } from '@/db/schema.js';

// Estado por "tenant_id|agent_id": gaps + rule + dias desde último proposed.
const gapsByTuple = new Map<string, AgentCapabilityGap[]>();
const rulesByTuple = new Map<string, GapEscalationRule | null>();
const daysSinceProposedByTuple = new Map<string, number | null>();
// Tuplas (tenant_id, agent_id) que o dispatcher enumera (DISTINCT open gaps).
const openTuples: Array<{ tenant_id: string; agent_id: string }> = [];
// Contextos REAIS abertos pelo worker, na ordem de processamento.
const contextsSeen: Array<{ tenant_id: string; agent_id: string }> = [];

const {
  updateLevelMock,
  proposeCapabilityForGapMock,
  loggerInfoMock,
  loggerWarnMock,
  loggerErrorMock,
} = vi.hoisted(() => ({
  updateLevelMock: vi.fn(),
  proposeCapabilityForGapMock: vi.fn(),
  loggerInfoMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  loggerErrorMock: vi.fn(),
}));

vi.mock('@/lib/logger.js', () => ({
  logger: {
    info: loggerInfoMock,
    warn: loggerWarnMock,
    debug: vi.fn(),
    error: loggerErrorMock,
  },
}));

// db.selectDistinct → enumeração de tuplas com gaps abertos.
vi.mock('@/db/client.js', () => ({
  db: {
    selectDistinct: () => ({
      from: () => ({
        where: async () => openTuples.slice(),
      }),
    }),
  },
  pool: {},
  withTx: vi.fn(),
  shutdownDb: vi.fn(),
  isDbConnected: () => true,
  probeDb: async () => true,
}));

async function currentKey(): Promise<string> {
  const { getCurrentTenant, getCurrentAgent } = await import('@/db/tenant-context.js');
  const tid = getCurrentTenant();
  const aid = getCurrentAgent();
  return `${tid}|${aid}`;
}

vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>(
    '@/db/repositories.js',
  );
  return {
    ...actual,
    capabilityGapsRepo: {
      ...actual.capabilityGapsRepo,
      listByLevels: vi.fn(async () => {
        const { getCurrentTenant, getCurrentAgent } = await import(
          '@/db/tenant-context.js'
        );
        const tid = getCurrentTenant();
        const aid = getCurrentAgent();
        contextsSeen.push({ tenant_id: tid, agent_id: aid });
        return gapsByTuple.get(`${tid}|${aid}`) ?? [];
      }),
      daysSinceLastProposed: vi.fn(async () => {
        const key = await currentKey();
        return daysSinceProposedByTuple.get(key) ?? null;
      }),
      updateLevel: updateLevelMock,
    },
    gapEscalationRulesRepo: {
      ...actual.gapEscalationRulesRepo,
      getForCurrentAgent: vi.fn(async () => {
        const key = await currentKey();
        return rulesByTuple.get(key) ?? null;
      }),
    },
  };
});

vi.mock('@/cognition/capability-proposer.js', () => ({
  proposeCapabilityForGap: proposeCapabilityForGapMock,
}));

import { runGapEscalationMonitor } from '@/workers/gap-escalation-monitor.js';

function seedTuple(
  tenant_id: string,
  agent_id: string,
  opts: {
    gaps: AgentCapabilityGap[];
    rules?: GapEscalationRule | null;
    daysSinceProposed?: number | null;
  },
) {
  openTuples.push({ tenant_id, agent_id });
  const key = `${tenant_id}|${agent_id}`;
  gapsByTuple.set(key, opts.gaps);
  rulesByTuple.set(key, opts.rules ?? null);
  daysSinceProposedByTuple.set(key, opts.daysSinceProposed ?? null);
}

function makeGap(overrides: Partial<AgentCapabilityGap> = {}): AgentCapabilityGap {
  const now = new Date();
  return {
    id: 'gap-1',
    tenant_id: 'tenant-a',
    agent_id: 'agent-1',
    capability_description: 'test gap',
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

function makeRules(overrides: Partial<GapEscalationRule> = {}): GapEscalationRule {
  const now = new Date();
  return {
    id: 'r-1',
    tenant_id: 'tenant-a',
    agent_id: 'agent-1',
    dashboard_freq_threshold: 3,
    mentionable_severity_threshold: 5,
    proposed_combined_threshold: 8,
    proposed_min_distinct_contexts: 2,
    cooldown_days_proposed_to_proposed: 14,
    created_at: now,
    updated_at: now,
    ...overrides,
  } as GapEscalationRule;
}

// Aguarda microtasks (fire-and-forget .then) processarem antes da asserção.
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('runGapEscalationMonitor', () => {
  beforeEach(() => {
    openTuples.length = 0;
    contextsSeen.length = 0;
    gapsByTuple.clear();
    rulesByTuple.clear();
    daysSinceProposedByTuple.clear();
    updateLevelMock.mockReset();
    proposeCapabilityForGapMock.mockReset();
    loggerInfoMock.mockReset();
    loggerWarnMock.mockReset();
    loggerErrorMock.mockReset();
  });

  it('cenário 1: silent + freq=3 (threshold default) → escala para dashboard, log emitido, proposer NÃO chamado', async () => {
    seedTuple('tenant-a', 'agent-1', {
      gaps: [
        makeGap({ id: 'gap-1', current_level: GapLevel.SILENT, frequency_score: 3, severity_score: 1 }),
      ],
    });

    await runGapEscalationMonitor();
    await flushMicrotasks();

    expect(updateLevelMock).toHaveBeenCalledTimes(1);
    expect(updateLevelMock).toHaveBeenCalledWith({ id: 'gap-1', new_level: GapLevel.DASHBOARD });
    expect(proposeCapabilityForGapMock).not.toHaveBeenCalled();

    const changed = loggerInfoMock.mock.calls.find((c) => c[1] === 'gap_escalation.changed');
    expect(changed).toBeDefined();
    const payload = changed![0] as Record<string, unknown>;
    expect(payload.from).toBe(GapLevel.SILENT);
    expect(payload.to).toBe(GapLevel.DASHBOARD);
    expect(payload.tenant_id).toBe('tenant-a');
    expect(payload.agent_id).toBe('agent-1');

    // contexto aberto foi (tenant-a, agent-1) — nunca 'default'
    expect(contextsSeen).toEqual([{ tenant_id: 'tenant-a', agent_id: 'agent-1' }]);

    const done = loggerInfoMock.mock.calls.find((c) => c[1] === 'gap_escalation_monitor.done');
    expect(done).toBeDefined();
    const donePayload = done![0] as Record<string, unknown>;
    expect(donePayload.total_changed).toBe(1);
    expect(donePayload.total_proposed_triggered).toBe(0);
    expect(donePayload.agents_processed).toBe(1);
  });

  it('cenário 2: mentionable + todas condições satisfeitas → escala para proposed E proposer chamado', async () => {
    seedTuple('tenant-a', 'agent-1', {
      gaps: [
        // freq=4 + sev=5 = 9 >= 8 (combined); contexto presente → distinct=2 >= 2
        makeGap({
          id: 'gap-mention',
          current_level: GapLevel.MENTIONABLE,
          frequency_score: 4,
          severity_score: 5,
          contexto: 'ctx-A',
        }),
      ],
    });

    proposeCapabilityForGapMock.mockResolvedValueOnce({
      ok: true,
      proposal_id: 'prop-1',
      draft: { capability_type: 'tool', title: 't', description: 'd', proposed_spec: {}, motivation: 'm', expected_impact: '', test_scenarios: [] },
    });

    await runGapEscalationMonitor();
    await flushMicrotasks();

    expect(updateLevelMock).toHaveBeenCalledWith({ id: 'gap-mention', new_level: GapLevel.PROPOSED });
    expect(proposeCapabilityForGapMock).toHaveBeenCalledTimes(1);
    const arg = proposeCapabilityForGapMock.mock.calls[0]![0] as { gap: AgentCapabilityGap };
    expect(arg.gap.id).toBe('gap-mention');
    expect(arg.gap.current_level).toBe(GapLevel.PROPOSED);

    const done = loggerInfoMock.mock.calls.find((c) => c[1] === 'gap_escalation_monitor.done');
    expect(done).toBeDefined();
    expect((done![0] as Record<string, unknown>).total_proposed_triggered).toBe(1);

    const proposalLog = loggerInfoMock.mock.calls.find(
      (c) => c[1] === 'gap_escalation.proposal_created',
    );
    expect(proposalLog).toBeDefined();
    expect((proposalLog![0] as Record<string, unknown>).proposal_id).toBe('prop-1');
  });

  it('cenário 3: mentionable + cooldown vigente → sem mudança, sem proposer', async () => {
    seedTuple('tenant-a', 'agent-1', {
      gaps: [
        makeGap({
          id: 'gap-cooldown',
          current_level: GapLevel.MENTIONABLE,
          frequency_score: 4,
          severity_score: 5,
          contexto: 'ctx',
        }),
      ],
      daysSinceProposed: 3, // 3 < 14 → cooldown ativo
    });

    await runGapEscalationMonitor();
    await flushMicrotasks();

    expect(updateLevelMock).not.toHaveBeenCalled();
    expect(proposeCapabilityForGapMock).not.toHaveBeenCalled();

    const done = loggerInfoMock.mock.calls.find((c) => c[1] === 'gap_escalation_monitor.done');
    expect(done).toBeDefined();
    const payload = done![0] as Record<string, unknown>;
    expect(payload.total_changed).toBe(0);
    expect(payload.total_proposed_triggered).toBe(0);
  });

  it('cenário 4: nenhuma tupla com gaps abertos → no-op, sem proposer, sem contexto', async () => {
    await runGapEscalationMonitor();
    await flushMicrotasks();

    expect(contextsSeen).toHaveLength(0);
    expect(updateLevelMock).not.toHaveBeenCalled();
    expect(proposeCapabilityForGapMock).not.toHaveBeenCalled();

    const done = loggerInfoMock.mock.calls.find((c) => c[1] === 'gap_escalation_monitor.done');
    expect(done).toBeDefined();
    expect((done![0] as Record<string, unknown>).total_changed).toBe(0);
    expect((done![0] as Record<string, unknown>).agents_processed).toBe(0);
  });

  it('cenário 5: rules customizadas sobrescrevem defaults — freq_threshold=5; gap freq=4 permanece em silent', async () => {
    seedTuple('tenant-a', 'agent-1', {
      gaps: [
        makeGap({ id: 'gap-5', current_level: GapLevel.SILENT, frequency_score: 4, severity_score: 1 }),
      ],
      rules: makeRules({ dashboard_freq_threshold: 5 }),
    });

    await runGapEscalationMonitor();
    await flushMicrotasks();

    // freq 4 < 5 → sem mudança
    expect(updateLevelMock).not.toHaveBeenCalled();
    expect(proposeCapabilityForGapMock).not.toHaveBeenCalled();
  });

  it('cenário 6: multi-tupla — itera contextos REAIS isolados; proposer disparado pela tupla elegível', async () => {
    // tenant-a/agent-1: gap mentionable totalmente elegível → proposed + proposer
    seedTuple('tenant-a', 'agent-1', {
      gaps: [
        makeGap({
          id: 'gap-a',
          tenant_id: 'tenant-a',
          agent_id: 'agent-1',
          current_level: GapLevel.MENTIONABLE,
          frequency_score: 4,
          severity_score: 5,
          contexto: 'ctx-a',
        }),
      ],
    });
    // tenant-b/agent-7: gap silent baixa frequência → no change
    seedTuple('tenant-b', 'agent-7', {
      gaps: [
        makeGap({
          id: 'gap-b',
          tenant_id: 'tenant-b',
          agent_id: 'agent-7',
          current_level: GapLevel.SILENT,
          frequency_score: 1,
          severity_score: 1,
        }),
      ],
    });

    proposeCapabilityForGapMock.mockResolvedValueOnce({
      ok: true,
      proposal_id: 'prop-a',
      draft: { capability_type: 'tool', title: 't', description: 'd', proposed_spec: {}, motivation: 'm', expected_impact: '', test_scenarios: [] },
    });

    await runGapEscalationMonitor();
    await flushMicrotasks();

    expect(updateLevelMock).toHaveBeenCalledTimes(1);
    expect(updateLevelMock).toHaveBeenCalledWith({ id: 'gap-a', new_level: GapLevel.PROPOSED });

    expect(proposeCapabilityForGapMock).toHaveBeenCalledTimes(1);
    const arg = proposeCapabilityForGapMock.mock.calls[0]![0] as { gap: AgentCapabilityGap };
    expect(arg.gap.id).toBe('gap-a');

    // ambos contextos REAIS abertos
    expect(contextsSeen).toEqual([
      { tenant_id: 'tenant-a', agent_id: 'agent-1' },
      { tenant_id: 'tenant-b', agent_id: 'agent-7' },
    ]);

    const changedA = loggerInfoMock.mock.calls.find(
      (c) =>
        c[1] === 'gap_escalation.changed' &&
        (c[0] as Record<string, unknown>).tenant_id === 'tenant-a',
    );
    expect(changedA).toBeDefined();
    expect((changedA![0] as Record<string, unknown>).agent_id).toBe('agent-1');

    const done = loggerInfoMock.mock.calls.find((c) => c[1] === 'gap_escalation_monitor.done');
    expect(done).toBeDefined();
    const payload = done![0] as Record<string, unknown>;
    expect(payload.total_changed).toBe(1);
    expect(payload.total_proposed_triggered).toBe(1);
    expect(payload.agents_processed).toBe(2);
  });

  it('cenário 7 (regressão #323): DOIS agents no MESMO tenant → AMBOS escalados, nenhum sob "default"', async () => {
    // Antes do fix, o worker abria {tenant, agent:'default'} e só os gaps do
    // agent 'default' eram avaliados — o gap do segundo agent NUNCA escalava.
    seedTuple('tenant-a', 'agent-1', {
      gaps: [
        makeGap({
          id: 'gap-a1',
          tenant_id: 'tenant-a',
          agent_id: 'agent-1',
          current_level: GapLevel.SILENT,
          frequency_score: 3,
          severity_score: 1,
        }),
      ],
    });
    seedTuple('tenant-a', 'agent-2', {
      gaps: [
        makeGap({
          id: 'gap-a2',
          tenant_id: 'tenant-a',
          agent_id: 'agent-2',
          current_level: GapLevel.SILENT,
          frequency_score: 3,
          severity_score: 1,
        }),
      ],
    });

    await runGapEscalationMonitor();
    await flushMicrotasks();

    // AMBOS os gaps (de agents distintos no mesmo tenant) escalaram.
    expect(updateLevelMock).toHaveBeenCalledTimes(2);
    const escalatedIds = updateLevelMock.mock.calls
      .map((c) => (c[0] as { id: string }).id)
      .sort();
    expect(escalatedIds).toEqual(['gap-a1', 'gap-a2']);

    // contextos: os DOIS agents reais — e NENHUM 'default'.
    expect(contextsSeen).toEqual([
      { tenant_id: 'tenant-a', agent_id: 'agent-1' },
      { tenant_id: 'tenant-a', agent_id: 'agent-2' },
    ]);
    expect(contextsSeen.some((c) => c.agent_id === 'default')).toBe(false);

    const done = loggerInfoMock.mock.calls.find((c) => c[1] === 'gap_escalation_monitor.done');
    expect((done![0] as Record<string, unknown>).total_changed).toBe(2);
    expect((done![0] as Record<string, unknown>).agents_processed).toBe(2);
  });
});
