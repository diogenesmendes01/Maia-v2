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
  updateLevelTxMock,
  createProposalTxMock,
  generateDraftMock,
  withTxMock,
  loggerInfoMock,
  loggerWarnMock,
  loggerErrorMock,
} = vi.hoisted(() => ({
  updateLevelMock: vi.fn(),
  updateLevelTxMock: vi.fn(),
  createProposalTxMock: vi.fn(),
  generateDraftMock: vi.fn(),
  withTxMock: vi.fn(),
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
      updateLevelTx: updateLevelTxMock,
    },
    capabilityProposalsRepo: {
      ...actual.capabilityProposalsRepo,
      createTx: createProposalTxMock,
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

// PR #87 follow-up — worker agora abre uma transação para fazer
// INSERT capability_proposals + UPDATE agent_capability_gaps atomicamente.
// Por padrão o mock executa o closure passando um stub-tx (qualquer valor;
// os repos *Tx são mockados acima); testes que querem simular falha
// transient na transação substituem este mock.
vi.mock('@/db/client.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/client.js')>('@/db/client.js');
  return { ...actual, withTx: withTxMock };
});

vi.mock('@/cognition/capability-proposer.js', () => ({
  generateCapabilityProposalDraft: generateDraftMock,
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
    updateLevelTxMock.mockReset();
    createProposalTxMock.mockReset();
    generateDraftMock.mockReset();
    withTxMock.mockReset();
    loggerInfoMock.mockReset();
    loggerWarnMock.mockReset();
    loggerErrorMock.mockReset();

    // Default: withTx executa o closure com um stub-tx (os repos *Tx já
    // estão mockados, então o valor passado não importa). Testes que
    // querem simular falha transient (rollback) sobrescrevem este mock
    // com mockImplementationOnce(() => { throw ... }).
    withTxMock.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      return fn({} as unknown);
    });
    // createProposalTx por padrão devolve uma row mínima válida.
    createProposalTxMock.mockResolvedValue({ id: 'prop-default' });
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
    expect(generateDraftMock).not.toHaveBeenCalled();
    expect(withTxMock).not.toHaveBeenCalled();

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

    generateDraftMock.mockResolvedValueOnce({
      ok: true,
      draft: { capability_type: 'tool', title: 't', description: 'd', proposed_spec: {}, motivation: 'm', expected_impact: '', test_scenarios: [] },
    });
    createProposalTxMock.mockResolvedValueOnce({ id: 'prop-1' });

    await runGapEscalationMonitor();
    await flushMicrotasks();

    // PR #87 follow-up — promoção a proposed acontece dentro de withTx;
    // updateLevelTx é chamado em vez do updateLevel não-transacional.
    expect(withTxMock).toHaveBeenCalledTimes(1);
    expect(createProposalTxMock).toHaveBeenCalledTimes(1);
    const createArgs = createProposalTxMock.mock.calls[0]![1] as { gap_id: string };
    expect(createArgs.gap_id).toBe('gap-mention');
    expect(updateLevelTxMock).toHaveBeenCalledWith(expect.anything(), {
      id: 'gap-mention',
      new_level: GapLevel.PROPOSED,
    });
    // updateLevel (non-tx) NÃO foi chamado para o path proposed.
    expect(updateLevelMock).not.toHaveBeenCalledWith({
      id: 'gap-mention',
      new_level: GapLevel.PROPOSED,
    });

    expect(generateDraftMock).toHaveBeenCalledTimes(1);
    const arg = generateDraftMock.mock.calls[0]![0] as { gap: AgentCapabilityGap };
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
    expect(updateLevelTxMock).not.toHaveBeenCalled();
    expect(generateDraftMock).not.toHaveBeenCalled();
    expect(withTxMock).not.toHaveBeenCalled();

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
    expect(updateLevelTxMock).not.toHaveBeenCalled();
    expect(generateDraftMock).not.toHaveBeenCalled();
    expect(withTxMock).not.toHaveBeenCalled();

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
    expect(updateLevelTxMock).not.toHaveBeenCalled();
    expect(generateDraftMock).not.toHaveBeenCalled();
    expect(withTxMock).not.toHaveBeenCalled();
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

    generateDraftMock.mockResolvedValueOnce({
      ok: true,
      draft: { capability_type: 'tool', title: 't', description: 'd', proposed_spec: {}, motivation: 'm', expected_impact: '', test_scenarios: [] },
    });
    createProposalTxMock.mockResolvedValueOnce({ id: 'prop-a' });

    await runGapEscalationMonitor();
    await flushMicrotasks();

    // só tenant-a sofreu promoção; agora via withTx + updateLevelTx.
    expect(withTxMock).toHaveBeenCalledTimes(1);
    expect(updateLevelTxMock).toHaveBeenCalledTimes(1);
    expect(updateLevelTxMock).toHaveBeenCalledWith(expect.anything(), {
      id: 'gap-a',
      new_level: GapLevel.PROPOSED,
    });
    // updateLevel (não-tx) não foi chamado em nenhum dos tenants.
    expect(updateLevelMock).not.toHaveBeenCalled();

    // proposer só foi chamado para tenant-a
    expect(generateDraftMock).toHaveBeenCalledTimes(1);
    const arg = generateDraftMock.mock.calls[0]![0] as { gap: AgentCapabilityGap };
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

  it('PR #87 follow-up — withTx throw inside closure: rollback atômico (sem proposal persistida, sem level flip, gap permanece mentionable)', async () => {
    // Cenário: a chamada LLM retorna draft válido, mas o updateLevel
    // dentro da transação falha (DB blip / lock timeout / qualquer throw).
    // Comportamento esperado:
    //   - withTx propaga o throw após ROLLBACK; o catch externo do worker
    //     loga 'gap_escalation.atomic_promotion_failed' e segue.
    //   - Como o mock de withTx joga ANTES do createProposalTx executar
    //     (closure inteiro abortado), nenhuma row em capability_proposals
    //     foi simulada como persistida.
    //   - updateLevel (caminho não-tx) nunca é chamado para PROPOSED.
    //   - total_proposed_triggered = 0 (promoção não aconteceu).
    //   - gap_escalation.proposal_created NÃO é emitido.
    //   - Próximo tick re-tentaria do zero — sem duplicate row.
    tenantsState.push({ id: 'tenant-a', nome: 'A', status: 'active' });
    gapsByTenant.set('tenant-a', [
      makeGap({
        id: 'gap-atomic',
        current_level: GapLevel.MENTIONABLE,
        frequency_score: 4,
        severity_score: 5,
        contexto: 'ctx-atomic',
      }),
    ]);
    rulesByTenant.set('tenant-a', null);
    daysSinceProposedByTenant.set('tenant-a', null);

    generateDraftMock.mockResolvedValueOnce({
      ok: true,
      draft: {
        capability_type: 'tool',
        title: 't',
        description: 'd',
        proposed_spec: {},
        motivation: 'm',
        expected_impact: '',
        test_scenarios: [],
      },
    });

    // Sobrescreve o default: withTx executa o closure mas o updateLevelTx
    // (segundo write dentro da transação) joga. O closure inteiro é
    // abortado e withTx propaga o erro — exatamente como o pg client real
    // faria após ROLLBACK.
    let createTxCalled = false;
    createProposalTxMock.mockImplementationOnce(async () => {
      createTxCalled = true;
      return { id: 'prop-would-have-been-rolled-back' };
    });
    updateLevelTxMock.mockImplementationOnce(async () => {
      throw new Error('simulated db blip during updateLevel');
    });

    await runGapEscalationMonitor();
    await flushMicrotasks();

    // Worker recuperou-se: error logado, continuou para próxima iteração.
    const atomicFailLog = loggerErrorMock.mock.calls.find(
      (c) => c[1] === 'gap_escalation.atomic_promotion_failed',
    );
    expect(atomicFailLog).toBeDefined();
    expect((atomicFailLog![0] as Record<string, unknown>).gap_id).toBe('gap-atomic');

    // Asserções centrais:
    // 1) withTx foi chamado (worker tentou a promoção atômica).
    expect(withTxMock).toHaveBeenCalledTimes(1);
    // 2) Em produção, INSERT + UPDATE seriam rolled back. Aqui, dado que
    //    withTx propagou o throw, nenhuma row é considerada persistida.
    //    O log de proposal_created NÃO foi emitido — proxy para "nada
    //    persistido com sucesso da perspectiva do worker".
    const proposalCreatedLog = loggerInfoMock.mock.calls.find(
      (c) => c[1] === 'gap_escalation.proposal_created',
    );
    expect(proposalCreatedLog).toBeUndefined();
    // 3) gap_escalation.changed NÃO foi emitido — gap permanece mentionable
    //    do ponto de vista observável do worker.
    const changedLog = loggerInfoMock.mock.calls.find(
      (c) =>
        c[1] === 'gap_escalation.changed' &&
        (c[0] as Record<string, unknown>).gap_id === 'gap-atomic',
    );
    expect(changedLog).toBeUndefined();
    // 4) updateLevel não-tx jamais foi chamado para esse gap (caminho
    //    proposed sempre passa por updateLevelTx dentro do withTx).
    expect(updateLevelMock).not.toHaveBeenCalled();

    // 5) Contador agregado reflete a falha: nenhuma promoção contabilizada.
    const done = loggerInfoMock.mock.calls.find((c) => c[1] === 'gap_escalation_monitor.done');
    expect(done).toBeDefined();
    const payload = done![0] as Record<string, unknown>;
    expect(payload.total_changed).toBe(0);
    expect(payload.total_proposed_triggered).toBe(0);

    // sanity: o closure entrou (createTx foi chamado) — confirma que o
    // throw aconteceu DENTRO da transação, não antes; em produção essa
    // INSERT teria sido revertida pelo ROLLBACK do withTx real.
    expect(createTxCalled).toBe(true);
  });
});
