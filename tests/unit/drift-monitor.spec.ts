/**
 * P4 Task 10 — `drift-monitor` worker (semanal).
 *
 * Issue #323 (Phase 3) — per-agent fan-out: o worker enumera tuplas
 * (tenant_id, agent_id) DISTINCT que têm um perfil ATIVO em
 * `agent_operational_profile_versions` e abre `runWithTenantContext` por
 * tupla REAL — nunca mais `agent_id:'default'`.
 *
 * Scenarios:
 *   1. (tenant, agent) com active profile + zero evidences → log "no_drift",
 *      sem chamadas a decideAndApply.
 *   2. (tenant, agent) com active profile + 2 evidences (baixo+critico) →
 *      decideAndApply chamado; breakdown por severidade contabilizado.
 *   3. Tupla sem active profile (race) → skip.
 *   4. Múltiplas tuplas isoladas — cada uma abre seu próprio contexto REAL.
 *   5. Dois agents NO MESMO tenant → AMBOS processados (regressão do bug
 *      latente de cobertura per-agent; antes só 'default' rodava).
 *   6. Nenhum contexto 'default' é jamais aberto (anti-regressão do flip).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DriftType, DriftSeverity, DriftDecision } from '@/types/enums.js';
import type { DriftEvidence } from '@/cognition/drift/types.js';
import type { DriftDecisionResult } from '@/cognition/drift/decision-engine.js';

// In-memory state — populated por scenário.
// Tuplas (tenant_id, agent_id) que o dispatcher enumera (DISTINCT active).
const activeTuples: Array<{ tenant_id: string; agent_id: string }> = [];
// active profile por "tenant_id|agent_id"; ausente/null = sem perfil ativo.
const activeProfileByTuple = new Map<string, { id: string } | null>();
// Cada (tenant_id, agent_id) em que o worker ABRIU runWithTenantContext, na
// ordem em que `getActive()` foi chamado — base da asserção de isolamento.
const contextsSeen: Array<{ tenant_id: string; agent_id: string }> = [];

const {
  runAllDriftDetectorsMock,
  decideAndApplyMock,
  loggerInfoMock,
  loggerWarnMock,
} = vi.hoisted(() => ({
  runAllDriftDetectorsMock: vi.fn(),
  decideAndApplyMock: vi.fn(),
  loggerInfoMock: vi.fn(),
  loggerWarnMock: vi.fn(),
}));

vi.mock('@/lib/logger.js', () => ({
  logger: {
    info: loggerInfoMock,
    warn: loggerWarnMock,
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>(
    '@/db/repositories.js',
  );
  return {
    ...actual,
    operationalProfileVersionsRepo: {
      ...actual.operationalProfileVersionsRepo,
      getActive: vi.fn(async () => {
        const { getCurrentTenant, getCurrentAgent } = await import(
          '@/db/tenant-context.js'
        );
        const tid = getCurrentTenant();
        const aid = getCurrentAgent();
        contextsSeen.push({ tenant_id: tid, agent_id: aid });
        return activeProfileByTuple.get(`${tid}|${aid}`) ?? null;
      }),
    },
    // Skill repo retorna vazio — testes não dependem desse caminho.
    capabilitiesSkillRepo: {
      ...actual.capabilitiesSkillRepo,
      listAll: vi.fn(async () => []),
    },
  };
});

// Mock db: selectDistinct → enumeração de tuplas; select → mensagens/procedures
// (vazio, os fetches são best-effort e não importam aqui).
vi.mock('@/db/client.js', async () => {
  const noop = {
    selectDistinct: () => ({
      from: () => ({
        where: async () => activeTuples.slice(),
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => [],
            then: (resolve: (v: unknown[]) => unknown) => resolve([]),
          }),
        }),
      }),
    }),
  };
  return {
    db: noop,
    pool: {},
    withTx: vi.fn(),
    shutdownDb: vi.fn(),
    isDbConnected: () => true,
    probeDb: async () => true,
  };
});

vi.mock('@/cognition/drift/index.js', () => ({
  runAllDriftDetectors: runAllDriftDetectorsMock,
}));

vi.mock('@/cognition/drift/decision-engine.js', () => ({
  decideAndApply: decideAndApplyMock,
}));

import { runDriftMonitor } from '@/workers/drift-monitor.js';

function seedTuple(tenant_id: string, agent_id: string, profile: { id: string } | null) {
  activeTuples.push({ tenant_id, agent_id });
  activeProfileByTuple.set(`${tenant_id}|${agent_id}`, profile);
}

function makeEvidence(t: DriftType): DriftEvidence {
  return {
    drift_type: t,
    detected_by: `drift_detector_${t}`,
    payload: {},
    evidence_summary: `evidence ${t}`,
  };
}

function makeDecisionResult(
  drift_type: DriftType,
  severity: DriftSeverity,
  decision: DriftDecision,
): DriftDecisionResult {
  return {
    drift_type,
    severity,
    decision,
    evidence: makeEvidence(drift_type),
    applied: true,
    alert_id: 'alert-' + drift_type,
  };
}

describe('runDriftMonitor', () => {
  beforeEach(() => {
    activeTuples.length = 0;
    activeProfileByTuple.clear();
    contextsSeen.length = 0;
    runAllDriftDetectorsMock.mockReset();
    decideAndApplyMock.mockReset();
    loggerInfoMock.mockReset();
    loggerWarnMock.mockReset();
  });

  it('cenário 1: active profile + zero evidences → loga "no_drift" e não chama decideAndApply', async () => {
    seedTuple('tenant-a', 'agent-1', { id: 'prof-a' });
    runAllDriftDetectorsMock.mockResolvedValueOnce([]);

    await runDriftMonitor();

    expect(runAllDriftDetectorsMock).toHaveBeenCalledTimes(1);
    expect(decideAndApplyMock).not.toHaveBeenCalled();

    // "no_drift" log com tenant_id + agent_id REAIS presentes
    const noDriftCall = loggerInfoMock.mock.calls.find(
      (c) => c[1] === 'drift_monitor.no_drift',
    );
    expect(noDriftCall).toBeDefined();
    expect((noDriftCall![0] as Record<string, unknown>).tenant_id).toBe('tenant-a');
    expect((noDriftCall![0] as Record<string, unknown>).agent_id).toBe('agent-1');

    // contexto aberto foi (tenant-a, agent-1) — NUNCA 'default'
    expect(contextsSeen).toEqual([{ tenant_id: 'tenant-a', agent_id: 'agent-1' }]);

    const doneCall = loggerInfoMock.mock.calls.find((c) => c[1] === 'drift_monitor.done');
    expect(doneCall).toBeDefined();
    expect((doneCall![0] as Record<string, unknown>).total_alerts).toBe(0);
    expect((doneCall![0] as Record<string, unknown>).agents_processed).toBe(1);
  });

  it('cenário 2: active profile + 2 evidences (baixo+critico) → decideAndApply chamado, total_alerts=2, breakdown contabilizado', async () => {
    seedTuple('tenant-a', 'agent-1', { id: 'prof-a' });

    const ev1 = makeEvidence(DriftType.TOM);
    const ev2 = makeEvidence(DriftType.LINGUAGEM);
    runAllDriftDetectorsMock.mockResolvedValueOnce([ev1, ev2]);
    decideAndApplyMock.mockResolvedValueOnce([
      makeDecisionResult(DriftType.TOM, DriftSeverity.BAIXO, DriftDecision.AUTO_APPROVED),
      makeDecisionResult(DriftType.LINGUAGEM, DriftSeverity.CRITICO, DriftDecision.ROLLBACK),
    ]);

    await runDriftMonitor();

    expect(decideAndApplyMock).toHaveBeenCalledTimes(1);
    const call = decideAndApplyMock.mock.calls[0]![0] as {
      evidences: DriftEvidence[];
      active_profile_id: string;
    };
    expect(call.evidences).toHaveLength(2);
    expect(call.active_profile_id).toBe('prof-a');

    // log "tenant_done" presente com alerts=2 e agent_id real
    const tenantDone = loggerInfoMock.mock.calls.find(
      (c) => c[1] === 'drift_monitor.tenant_done',
    );
    expect(tenantDone).toBeDefined();
    expect((tenantDone![0] as Record<string, unknown>).alerts).toBe(2);
    expect((tenantDone![0] as Record<string, unknown>).agent_id).toBe('agent-1');
    expect((tenantDone![0] as Record<string, unknown>).by_severity_local).toEqual([
      'baixo',
      'critico',
    ]);

    const done = loggerInfoMock.mock.calls.find((c) => c[1] === 'drift_monitor.done');
    expect(done).toBeDefined();
    const payload = done![0] as Record<string, unknown>;
    expect(payload.total_alerts).toBe(2);
    const bySev = payload.by_severity as Record<string, number>;
    expect(bySev.baixo).toBe(1);
    expect(bySev.critico).toBe(1);
    expect(bySev.medio).toBe(0);
    expect(bySev.alto).toBe(0);
  });

  it('cenário 3: tupla sem active profile (race entre enumeração e leitura) → skip', async () => {
    // O dispatcher enumerou a tupla, mas getActive devolve null (rollback
    // concorrente). Worker pula sem chamar orchestrator/decision-engine.
    seedTuple('tenant-a', 'agent-1', null);

    await runDriftMonitor();

    expect(runAllDriftDetectorsMock).not.toHaveBeenCalled();
    expect(decideAndApplyMock).not.toHaveBeenCalled();

    const skipCall = loggerInfoMock.mock.calls.find(
      (c) => c[1] === 'drift_monitor.no_active_profile_skip',
    );
    expect(skipCall).toBeDefined();
    expect((skipCall![0] as Record<string, unknown>).tenant_id).toBe('tenant-a');
    expect((skipCall![0] as Record<string, unknown>).agent_id).toBe('agent-1');
  });

  it('cenário 4: múltiplas tuplas isoladas — getActive chamado dentro do contexto REAL de cada uma', async () => {
    seedTuple('tenant-a', 'agent-1', { id: 'prof-a' });
    seedTuple('tenant-b', 'agent-9', null); // b não tem perfil — vai pular

    // a → 1 evidence; b → skip antes do orchestrator.
    runAllDriftDetectorsMock.mockResolvedValueOnce([makeEvidence(DriftType.TOM)]);
    decideAndApplyMock.mockResolvedValueOnce([
      makeDecisionResult(DriftType.TOM, DriftSeverity.MEDIO, DriftDecision.QUEUED_HUMAN),
    ]);

    await runDriftMonitor();

    expect(runAllDriftDetectorsMock).toHaveBeenCalledTimes(1);
    expect(decideAndApplyMock).toHaveBeenCalledTimes(1);
    const call = decideAndApplyMock.mock.calls[0]![0] as { active_profile_id: string };
    expect(call.active_profile_id).toBe('prof-a');

    // ambos contextos REAIS foram abertos, na ordem de enumeração
    expect(contextsSeen).toEqual([
      { tenant_id: 'tenant-a', agent_id: 'agent-1' },
      { tenant_id: 'tenant-b', agent_id: 'agent-9' },
    ]);

    // tenant-b emitiu o skip log com agent real
    const skipCall = loggerInfoMock.mock.calls.find(
      (c) =>
        c[1] === 'drift_monitor.no_active_profile_skip' &&
        (c[0] as Record<string, unknown>).tenant_id === 'tenant-b',
    );
    expect(skipCall).toBeDefined();
    expect((skipCall![0] as Record<string, unknown>).agent_id).toBe('agent-9');

    const done = loggerInfoMock.mock.calls.find((c) => c[1] === 'drift_monitor.done');
    expect(done).toBeDefined();
    const payload = done![0] as Record<string, unknown>;
    expect(payload.total_alerts).toBe(1);
    expect(payload.agents_processed).toBe(2);
    const bySev = payload.by_severity as Record<string, number>;
    expect(bySev.medio).toBe(1);
  });

  it('cenário 5 (regressão #323): DOIS agents no MESMO tenant → AMBOS processados, nenhum sob "default"', async () => {
    // Antes do fix, o worker abria {tenant, agent:'default'} e só o profile do
    // agent 'default' era avaliado — o segundo agent NUNCA passava por drift.
    seedTuple('tenant-a', 'agent-1', { id: 'prof-1' });
    seedTuple('tenant-a', 'agent-2', { id: 'prof-2' });

    // Cada agent produz 1 evidence própria → decideAndApply chamado 2x.
    runAllDriftDetectorsMock
      .mockResolvedValueOnce([makeEvidence(DriftType.TOM)])
      .mockResolvedValueOnce([makeEvidence(DriftType.LINGUAGEM)]);
    decideAndApplyMock
      .mockResolvedValueOnce([
        makeDecisionResult(DriftType.TOM, DriftSeverity.BAIXO, DriftDecision.AUTO_APPROVED),
      ])
      .mockResolvedValueOnce([
        makeDecisionResult(DriftType.LINGUAGEM, DriftSeverity.ALTO, DriftDecision.QUEUED_HUMAN),
      ]);

    await runDriftMonitor();

    // AMBOS agents rodaram o orchestrator + decision-engine.
    expect(runAllDriftDetectorsMock).toHaveBeenCalledTimes(2);
    expect(decideAndApplyMock).toHaveBeenCalledTimes(2);
    const profileIds = decideAndApplyMock.mock.calls.map(
      (c) => (c[0] as { active_profile_id: string }).active_profile_id,
    );
    expect(profileIds.sort()).toEqual(['prof-1', 'prof-2']);

    // contextos abertos: os DOIS agents reais — e NENHUM 'default'.
    expect(contextsSeen).toEqual([
      { tenant_id: 'tenant-a', agent_id: 'agent-1' },
      { tenant_id: 'tenant-a', agent_id: 'agent-2' },
    ]);
    expect(contextsSeen.some((c) => c.agent_id === 'default')).toBe(false);

    const done = loggerInfoMock.mock.calls.find((c) => c[1] === 'drift_monitor.done');
    const payload = done![0] as Record<string, unknown>;
    expect(payload.total_alerts).toBe(2);
    expect(payload.agents_processed).toBe(2);
  });

  it('cenário 6: nenhuma tupla com perfil ativo → done com agents_processed=0, sem abrir contexto', async () => {
    // Enumeração vazia (nenhum agent tem perfil ativo). Worker faz no-op.
    await runDriftMonitor();

    expect(contextsSeen).toHaveLength(0);
    expect(runAllDriftDetectorsMock).not.toHaveBeenCalled();
    const done = loggerInfoMock.mock.calls.find((c) => c[1] === 'drift_monitor.done');
    expect(done).toBeDefined();
    expect((done![0] as Record<string, unknown>).total_alerts).toBe(0);
  });
});
