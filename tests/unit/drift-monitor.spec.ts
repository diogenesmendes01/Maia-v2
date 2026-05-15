/**
 * P4 Task 10 — `drift-monitor` worker (semanal).
 *
 * Scenarios:
 *   1. Tenant com active profile + zero evidences → log "no_drift", sem
 *      chamadas a decideAndApply.
 *   2. Tenant com active profile + 2 evidences (baixo+critico) → decideAndApply
 *      chamado com ambas; breakdown por severidade contabilizado.
 *   3. Tenant SEM active profile → skip (sem chamadas ao orchestrator nem
 *      ao decision-engine).
 *   4. Múltiplos tenants → cada um abre seu próprio tenant context e o
 *      isolamento entre eles é preservado.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DriftType, DriftSeverity, DriftDecision } from '@/types/enums.js';
import type { DriftEvidence } from '@/cognition/drift/types.js';
import type { DriftDecisionResult } from '@/cognition/drift/decision-engine.js';

// In-memory state — populated por scenário.
const tenantsState: Array<{ id: string; nome: string; status: string }> = [];
// active profile por tenant_id; null = sem perfil ativo.
const activeProfileByTenant = new Map<string, { id: string } | null>();

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
    tenantsRepo: {
      list: vi.fn(async () => tenantsState.slice()),
      findById: vi.fn(async (id: string) => tenantsState.find((t) => t.id === id) ?? null),
      create: vi.fn(),
    },
    operationalProfileVersionsRepo: {
      ...actual.operationalProfileVersionsRepo,
      getActive: vi.fn(async () => {
        const { getCurrentTenant } = await import('@/db/tenant-context.js');
        const tid = getCurrentTenant();
        return activeProfileByTenant.get(tid) ?? null;
      }),
    },
    // Skill repo retorna vazio — testes não dependem desse caminho.
    capabilitiesSkillRepo: {
      ...actual.capabilitiesSkillRepo,
      listAll: vi.fn(async () => []),
    },
  };
});

// Mock direct db.select chain (mensagens + procedure_definitions). Cada teste
// não vai depender dos dados; só precisamos que os fetches não joguem.
vi.mock('@/db/client.js', async () => {
  const noop = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => [],
            // some chains call .orderBy then await directly (no limit) — return a thenable
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
    tenantsState.length = 0;
    activeProfileByTenant.clear();
    runAllDriftDetectorsMock.mockReset();
    decideAndApplyMock.mockReset();
    loggerInfoMock.mockReset();
    loggerWarnMock.mockReset();
  });

  it('cenário 1: active profile + zero evidences → loga "no_drift" e não chama decideAndApply', async () => {
    tenantsState.push({ id: 'tenant-a', nome: 'A', status: 'active' });
    activeProfileByTenant.set('tenant-a', { id: 'prof-a' });
    runAllDriftDetectorsMock.mockResolvedValueOnce([]);

    await runDriftMonitor();

    expect(runAllDriftDetectorsMock).toHaveBeenCalledTimes(1);
    expect(decideAndApplyMock).not.toHaveBeenCalled();

    // "no_drift" log com tenant_id presente
    const noDriftCall = loggerInfoMock.mock.calls.find(
      (c) => c[1] === 'drift_monitor.no_drift',
    );
    expect(noDriftCall).toBeDefined();
    expect((noDriftCall![0] as Record<string, unknown>).tenant_id).toBe('tenant-a');

    // log final 'drift_monitor.done' com total_alerts=0
    const doneCall = loggerInfoMock.mock.calls.find((c) => c[1] === 'drift_monitor.done');
    expect(doneCall).toBeDefined();
    expect((doneCall![0] as Record<string, unknown>).total_alerts).toBe(0);
  });

  it('cenário 2: active profile + 2 evidences (baixo+critico) → decideAndApply chamado, total_alerts=2, breakdown contabilizado', async () => {
    tenantsState.push({ id: 'tenant-a', nome: 'A', status: 'active' });
    activeProfileByTenant.set('tenant-a', { id: 'prof-a' });

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

    // log "tenant_done" presente com alerts=2
    const tenantDone = loggerInfoMock.mock.calls.find(
      (c) => c[1] === 'drift_monitor.tenant_done',
    );
    expect(tenantDone).toBeDefined();
    expect((tenantDone![0] as Record<string, unknown>).alerts).toBe(2);
    expect((tenantDone![0] as Record<string, unknown>).by_severity_local).toEqual([
      'baixo',
      'critico',
    ]);

    // log final 'drift_monitor.done' com breakdown agregado
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

  it('cenário 3: tenant SEM active profile → skip (sem detector, sem decision-engine)', async () => {
    tenantsState.push({ id: 'tenant-a', nome: 'A', status: 'active' });
    activeProfileByTenant.set('tenant-a', null);

    await runDriftMonitor();

    expect(runAllDriftDetectorsMock).not.toHaveBeenCalled();
    expect(decideAndApplyMock).not.toHaveBeenCalled();

    const skipCall = loggerInfoMock.mock.calls.find(
      (c) => c[1] === 'drift_monitor.no_active_profile_skip',
    );
    expect(skipCall).toBeDefined();
    expect((skipCall![0] as Record<string, unknown>).tenant_id).toBe('tenant-a');
  });

  it('cenário 4: múltiplos tenants isolados — getActive chamado dentro do contexto de cada tenant', async () => {
    tenantsState.push({ id: 'tenant-a', nome: 'A', status: 'active' });
    tenantsState.push({ id: 'tenant-b', nome: 'B', status: 'active' });
    activeProfileByTenant.set('tenant-a', { id: 'prof-a' });
    activeProfileByTenant.set('tenant-b', null); // b não tem perfil — vai pular

    // a → 1 evidence; b → skip antes do orchestrator.
    runAllDriftDetectorsMock.mockResolvedValueOnce([makeEvidence(DriftType.TOM)]);
    decideAndApplyMock.mockResolvedValueOnce([
      makeDecisionResult(DriftType.TOM, DriftSeverity.MEDIO, DriftDecision.QUEUED_HUMAN),
    ]);

    await runDriftMonitor();

    // orchestrator só rodou 1x (para tenant-a; tenant-b foi pulado por falta
    // de perfil ativo)
    expect(runAllDriftDetectorsMock).toHaveBeenCalledTimes(1);
    // decideAndApply só rodou 1x e usou o profile_id de tenant-a
    expect(decideAndApplyMock).toHaveBeenCalledTimes(1);
    const call = decideAndApplyMock.mock.calls[0]![0] as {
      active_profile_id: string;
    };
    expect(call.active_profile_id).toBe('prof-a');

    // tenant-b emitiu o skip log
    const skipCall = loggerInfoMock.mock.calls.find(
      (c) =>
        c[1] === 'drift_monitor.no_active_profile_skip' &&
        (c[0] as Record<string, unknown>).tenant_id === 'tenant-b',
    );
    expect(skipCall).toBeDefined();

    // Tanto a quanto b apareceram na iteração (cada um produziu seu próprio
    // log de ciclo) — assert: getActive foi chamado uma vez por tenant.
    // No mock acima, getActive() lê o tenant via getCurrentTenant — então
    // verificar que cada tenant foi processado isoladamente equivale a
    // verificar que os logs por tenant_id existem.
    const aLogs = loggerInfoMock.mock.calls.filter(
      (c) => (c[0] as Record<string, unknown>).tenant_id === 'tenant-a',
    );
    const bLogs = loggerInfoMock.mock.calls.filter(
      (c) => (c[0] as Record<string, unknown>).tenant_id === 'tenant-b',
    );
    expect(aLogs.length).toBeGreaterThan(0);
    expect(bLogs.length).toBeGreaterThan(0);

    // Aggregate done log: total=1, medio=1
    const done = loggerInfoMock.mock.calls.find((c) => c[1] === 'drift_monitor.done');
    expect(done).toBeDefined();
    const payload = done![0] as Record<string, unknown>;
    expect(payload.total_alerts).toBe(1);
    const bySev = payload.by_severity as Record<string, number>;
    expect(bySev.medio).toBe(1);
  });
});
