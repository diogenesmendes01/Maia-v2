/**
 * P5 Task 9 — `gap-escalation-monitor` worker tests.
 *
 * O worker orquestra (a cada 30 min) o engine determinístico (Task 6) e, na
 * transição para `proposed`, dispara o proposer (Task 7) em fire-and-forget.
 *
 * Cenários cobertos:
 *   1. Gap silent + freq=3 (threshold default) → escala para dashboard,
 *      logger.info emitido, proposer NÃO chamado.
 *   2. Gap mentionable + todas as condições satisfeitas → escala para
 *      proposed E proposer chamado (mock).
 *   3. Gap mentionable + cooldown ainda vigente → sem mudança, sem proposer.
 *   4. Lista vazia de gaps → sem ação, sem chamada ao proposer.
 *   5. Rules customizadas via `gapEscalationRulesRepo.getForCurrentAgent()`
 *      sobrescrevem defaults: tenant com freq_threshold=5; gap freq=4 permanece
 *      em silent.
 *   6. Multi-tenant: o worker itera tenants, abrindo o tenant_context próprio
 *      de cada um, e o proposer é disparado pela tenant que cumpriu condições.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GapLevel } from '@/types/enums.js';
import type { AgentCapabilityGap, GapEscalationRule } from '@/db/schema.js';

// Estado por tenant: gaps a retornar em listByLevels + rule a retornar em
// getForCurrentAgent + dias desde último proposed.
const gapsByTenant = new Map<string, AgentCapabilityGap[]>();
const rulesByTenant = new Map<string, GapEscalationRule | null>();
const daysSinceProposedByTenant = new Map<string, number | null>();
const tenantsState: Array<{ id: string; nome: string; status: string }> = [];

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

vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>(
    '@/db/repositories.js',
  );
  return {
    ...actual,
    tenantsRepo: {
      list: vi.fn(async () => tenantsState.slice()),
      findById: vi.fn(async (id: string) => tenantsState.find((t) => t.id === id) ?? null),
      create: vi.fn(),
    },
    capabilityGapsRepo: {
      ...actual.capabilityGapsRepo,
      listByLevels: vi.fn(async () => {
        const { getCurrentTenant } = await import('@/db/tenant-context.js');
        const tid = getCurrentTenant();
        return gapsByTenant.get(tid) ?? [];
      }),
      daysSinceLastProposed: vi.fn(async () => {
        const { getCurrentTenant } = await import('@/db/tenant-context.js');
        const tid = getCurrentTenant();
        return daysSinceProposedByTenant.get(tid) ?? null;
      }),
      updateLevel: updateLevelMock,
    },
    gapEscalationRulesRepo: {
      ...actual.gapEscalationRulesRepo,
      getForCurrentAgent: vi.fn(async () => {
        const { getCurrentTenant } = await import('@/db/tenant-context.js');
        const tid = getCurrentTenant();
        return rulesByTenant.get(tid) ?? null;
      }),
    },
  };
});

vi.mock('@/cognition/capability-proposer.js', () => ({
  proposeCapabilityForGap: proposeCapabilityForGapMock,
}));

import { runGapEscalationMonitor } from '@/workers/gap-escalation-monitor.js';

function makeGap(overrides: Partial<AgentCapabilityGap> = {}): AgentCapabilityGap {
  const now = new Date();
  return {
    id: 'gap-1',
    tenant_id: 'tenant-a',
    agent_id: 'default',
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
    agent_id: 'default',
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
    tenantsState.length = 0;
    gapsByTenant.clear();
    rulesByTenant.clear();
    daysSinceProposedByTenant.clear();
    updateLevelMock.mockReset();
    proposeCapabilityForGapMock.mockReset();
    loggerInfoMock.mockReset();
    loggerWarnMock.mockReset();
    loggerErrorMock.mockReset();
  });

  it('cenário 1: silent + freq=3 (threshold default) → escala para dashboard, log emitido, proposer NÃO chamado', async () => {
    tenantsState.push({ id: 'tenant-a', nome: 'A', status: 'active' });
    gapsByTenant.set('tenant-a', [
      makeGap({ id: 'gap-1', current_level: GapLevel.SILENT, frequency_score: 3, severity_score: 1 }),
    ]);
    rulesByTenant.set('tenant-a', null); // usa defaults
    daysSinceProposedByTenant.set('tenant-a', null);

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

    const done = loggerInfoMock.mock.calls.find((c) => c[1] === 'gap_escalation_monitor.done');
    expect(done).toBeDefined();
    const donePayload = done![0] as Record<string, unknown>;
    expect(donePayload.total_changed).toBe(1);
    expect(donePayload.total_proposed_triggered).toBe(0);
  });

  it('cenário 2: mentionable + todas condições satisfeitas → escala para proposed E proposer chamado', async () => {
    tenantsState.push({ id: 'tenant-a', nome: 'A', status: 'active' });
    gapsByTenant.set('tenant-a', [
      // freq=4 + sev=5 = 9 >= 8 (combined); contexto presente → distinct=2 >= 2
      makeGap({
        id: 'gap-mention',
        current_level: GapLevel.MENTIONABLE,
        frequency_score: 4,
        severity_score: 5,
        contexto: 'ctx-A',
      }),
    ]);
    rulesByTenant.set('tenant-a', null);
    daysSinceProposedByTenant.set('tenant-a', null); // sem proposed prévio → cooldown ok

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
    // worker passa o gap com new_level aplicado
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
    tenantsState.push({ id: 'tenant-a', nome: 'A', status: 'active' });
    gapsByTenant.set('tenant-a', [
      makeGap({
        id: 'gap-cooldown',
        current_level: GapLevel.MENTIONABLE,
        frequency_score: 4,
        severity_score: 5,
        contexto: 'ctx',
      }),
    ]);
    rulesByTenant.set('tenant-a', null);
    daysSinceProposedByTenant.set('tenant-a', 3); // 3 < 14 → cooldown ativo

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

  it('cenário 4: lista vazia → sem ação, sem proposer', async () => {
    tenantsState.push({ id: 'tenant-a', nome: 'A', status: 'active' });
    gapsByTenant.set('tenant-a', []);
    rulesByTenant.set('tenant-a', null);

    await runGapEscalationMonitor();
    await flushMicrotasks();

    expect(updateLevelMock).not.toHaveBeenCalled();
    expect(proposeCapabilityForGapMock).not.toHaveBeenCalled();

    const done = loggerInfoMock.mock.calls.find((c) => c[1] === 'gap_escalation_monitor.done');
    expect(done).toBeDefined();
    expect((done![0] as Record<string, unknown>).total_changed).toBe(0);
  });

  it('cenário 5: rules customizadas sobrescrevem defaults — freq_threshold=5; gap freq=4 permanece em silent', async () => {
    tenantsState.push({ id: 'tenant-a', nome: 'A', status: 'active' });
    gapsByTenant.set('tenant-a', [
      makeGap({ id: 'gap-5', current_level: GapLevel.SILENT, frequency_score: 4, severity_score: 1 }),
    ]);
    rulesByTenant.set('tenant-a', makeRules({ dashboard_freq_threshold: 5 }));
    daysSinceProposedByTenant.set('tenant-a', null);

    await runGapEscalationMonitor();
    await flushMicrotasks();

    // freq 4 < 5 → sem mudança
    expect(updateLevelMock).not.toHaveBeenCalled();
    expect(proposeCapabilityForGapMock).not.toHaveBeenCalled();
  });

  it('cenário 6: multi-tenant — itera tenants em contextos isolados; proposer disparado pela tenant elegível', async () => {
    tenantsState.push({ id: 'tenant-a', nome: 'A', status: 'active' });
    tenantsState.push({ id: 'tenant-b', nome: 'B', status: 'active' });

    // tenant-a: gap mentionable totalmente elegível → vai para proposed + proposer
    gapsByTenant.set('tenant-a', [
      makeGap({
        id: 'gap-a',
        tenant_id: 'tenant-a',
        current_level: GapLevel.MENTIONABLE,
        frequency_score: 4,
        severity_score: 5,
        contexto: 'ctx-a',
      }),
    ]);
    rulesByTenant.set('tenant-a', null);
    daysSinceProposedByTenant.set('tenant-a', null);

    // tenant-b: gap silent baixa frequência → no change
    gapsByTenant.set('tenant-b', [
      makeGap({
        id: 'gap-b',
        tenant_id: 'tenant-b',
        current_level: GapLevel.SILENT,
        frequency_score: 1,
        severity_score: 1,
      }),
    ]);
    rulesByTenant.set('tenant-b', null);
    daysSinceProposedByTenant.set('tenant-b', null);

    proposeCapabilityForGapMock.mockResolvedValueOnce({
      ok: true,
      proposal_id: 'prop-a',
      draft: { capability_type: 'tool', title: 't', description: 'd', proposed_spec: {}, motivation: 'm', expected_impact: '', test_scenarios: [] },
    });

    await runGapEscalationMonitor();
    await flushMicrotasks();

    // só tenant-a sofreu updateLevel
    expect(updateLevelMock).toHaveBeenCalledTimes(1);
    expect(updateLevelMock).toHaveBeenCalledWith({ id: 'gap-a', new_level: GapLevel.PROPOSED });

    // proposer só foi chamado para tenant-a
    expect(proposeCapabilityForGapMock).toHaveBeenCalledTimes(1);
    const arg = proposeCapabilityForGapMock.mock.calls[0]![0] as { gap: AgentCapabilityGap };
    expect(arg.gap.id).toBe('gap-a');

    // log changed para tenant-a presente
    const changedA = loggerInfoMock.mock.calls.find(
      (c) =>
        c[1] === 'gap_escalation.changed' &&
        (c[0] as Record<string, unknown>).tenant_id === 'tenant-a',
    );
    expect(changedA).toBeDefined();

    // log final agrega ambos
    const done = loggerInfoMock.mock.calls.find((c) => c[1] === 'gap_escalation_monitor.done');
    expect(done).toBeDefined();
    const payload = done![0] as Record<string, unknown>;
    expect(payload.total_changed).toBe(1);
    expect(payload.total_proposed_triggered).toBe(1);
  });
});
