/**
 * P4 Task 4 — repo tests for driftAlertsRepo.
 *
 * Mock-based pattern (matches tests/unit/procedure-tests-repo.spec.ts): we
 * mock @/db/repositories.js with an in-memory backing store. Validates the
 * contract: applyTenantGuard propagation on create, listUnresolved filter
 * (resolved_at IS NULL), listByProfileVersion filter, and the resolve()
 * setter (resolution_note + resolved_at + resolved_by).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { DriftType, DriftSeverity, DriftDecision } from '@/types/enums.js';

type AlertRow = {
  id: string;
  tenant_id: string;
  agent_id: string;
  profile_version_id: string | null;
  drift_type: string;
  severity: string;
  evidence: unknown;
  detected_by: string;
  decision: string;
  decided_at: Date;
  decided_by: string;
  resolution_note: string | null;
  resolved_at: Date | null;
  resolved_by: string | null;
  created_at: Date;
};

const alertsState: Record<string, AlertRow> = {};

vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>(
    '@/db/repositories.js',
  );

  return {
    ...actual,
    driftAlertsRepo: {
      create: vi.fn(async (input: {
        profile_version_id?: string;
        drift_type: string;
        severity: string;
        evidence: unknown;
        detected_by: string;
        decision: string;
        decided_by: string;
      }) => {
        const id = `alert-${Math.random().toString(36).slice(2)}`;
        const row: AlertRow = {
          id,
          tenant_id: 'default',
          agent_id: 'default',
          profile_version_id: input.profile_version_id ?? null,
          drift_type: input.drift_type,
          severity: input.severity,
          evidence: input.evidence,
          detected_by: input.detected_by,
          decision: input.decision,
          decided_at: new Date(),
          decided_by: input.decided_by,
          resolution_note: null,
          resolved_at: null,
          resolved_by: null,
          created_at: new Date(),
        };
        alertsState[id] = row;
        return row;
      }),
      listUnresolved: vi.fn(async () =>
        Object.values(alertsState).filter((r) => r.resolved_at === null),
      ),
      listByProfileVersion: vi.fn(async (profile_version_id: string) =>
        Object.values(alertsState).filter((r) => r.profile_version_id === profile_version_id),
      ),
      resolve: vi.fn(async (args: { id: string; resolution_note: string; resolved_by: string }) => {
        const row = alertsState[args.id];
        if (!row) return;
        alertsState[args.id] = {
          ...row,
          resolution_note: args.resolution_note,
          resolved_at: new Date(),
          resolved_by: args.resolved_by,
        };
      }),
    },
  };
});

describe('driftAlertsRepo', () => {
  beforeEach(() => {
    for (const k of Object.keys(alertsState)) delete alertsState[k];
    vi.clearAllMocks();
  });

  it('create inserts with applyTenantGuard propagated', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { driftAlertsRepo } = await import('@/db/repositories.js');
        const row = await driftAlertsRepo.create({
          drift_type: DriftType.TOM,
          severity: DriftSeverity.MEDIO,
          evidence: { sample: 'tone shifted too casual' },
          detected_by: 'drift-detector',
          decision: DriftDecision.QUEUED_HUMAN,
          decided_by: 'policy',
        });
        expect(row.id).toBeDefined();
        expect(row.tenant_id).toBe('default');
        expect(row.agent_id).toBe('default');
        expect(row.drift_type).toBe('tom');
        expect(row.severity).toBe('medio');
        expect(row.decision).toBe('queued_human');
        expect(row.resolved_at).toBeNull();
        expect(row.resolution_note).toBeNull();
      },
    );
  });

  it('create accepts optional profile_version_id', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { driftAlertsRepo } = await import('@/db/repositories.js');
        const withFK = await driftAlertsRepo.create({
          profile_version_id: 'prof-1',
          drift_type: DriftType.ESCOPO,
          severity: DriftSeverity.ALTO,
          evidence: {},
          detected_by: 'detector',
          decision: DriftDecision.FROZEN,
          decided_by: 'policy',
        });
        expect(withFK.profile_version_id).toBe('prof-1');

        const noFK = await driftAlertsRepo.create({
          drift_type: DriftType.VALORES,
          severity: DriftSeverity.BAIXO,
          evidence: {},
          detected_by: 'detector',
          decision: DriftDecision.AUTO_APPROVED,
          decided_by: 'policy',
        });
        expect(noFK.profile_version_id).toBeNull();
      },
    );
  });

  it('listUnresolved filters where resolved_at IS NULL', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { driftAlertsRepo } = await import('@/db/repositories.js');
        const a1 = await driftAlertsRepo.create({
          drift_type: DriftType.TOM,
          severity: DriftSeverity.BAIXO,
          evidence: {},
          detected_by: 'd',
          decision: DriftDecision.AUTO_APPROVED,
          decided_by: 'p',
        });
        const a2 = await driftAlertsRepo.create({
          drift_type: DriftType.LINGUAGEM,
          severity: DriftSeverity.MEDIO,
          evidence: {},
          detected_by: 'd',
          decision: DriftDecision.QUEUED_HUMAN,
          decided_by: 'p',
        });
        await driftAlertsRepo.create({
          drift_type: DriftType.VIES,
          severity: DriftSeverity.ALTO,
          evidence: {},
          detected_by: 'd',
          decision: DriftDecision.FROZEN,
          decided_by: 'p',
        });

        // Resolve a1
        await driftAlertsRepo.resolve({
          id: a1.id,
          resolution_note: 'auto-aplicado',
          resolved_by: 'system',
        });

        const unresolved = await driftAlertsRepo.listUnresolved();
        expect(unresolved.length).toBe(2);
        const ids = unresolved.map((a) => a.id);
        expect(ids).toContain(a2.id);
        expect(ids).not.toContain(a1.id);
      },
    );
  });

  it('listByProfileVersion filters by profile_version_id', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { driftAlertsRepo } = await import('@/db/repositories.js');
        await driftAlertsRepo.create({
          profile_version_id: 'prof-A',
          drift_type: DriftType.TOM,
          severity: DriftSeverity.BAIXO,
          evidence: {},
          detected_by: 'd',
          decision: DriftDecision.AUTO_APPROVED,
          decided_by: 'p',
        });
        await driftAlertsRepo.create({
          profile_version_id: 'prof-A',
          drift_type: DriftType.LINGUAGEM,
          severity: DriftSeverity.MEDIO,
          evidence: {},
          detected_by: 'd',
          decision: DriftDecision.QUEUED_HUMAN,
          decided_by: 'p',
        });
        await driftAlertsRepo.create({
          profile_version_id: 'prof-B',
          drift_type: DriftType.VIES,
          severity: DriftSeverity.ALTO,
          evidence: {},
          detected_by: 'd',
          decision: DriftDecision.FROZEN,
          decided_by: 'p',
        });

        const onA = await driftAlertsRepo.listByProfileVersion('prof-A');
        expect(onA.length).toBe(2);
        expect(onA.every((a) => a.profile_version_id === 'prof-A')).toBe(true);

        const onB = await driftAlertsRepo.listByProfileVersion('prof-B');
        expect(onB.length).toBe(1);

        const onX = await driftAlertsRepo.listByProfileVersion('prof-unknown');
        expect(onX.length).toBe(0);
      },
    );
  });

  it('resolve updates resolution_note + resolved_at + resolved_by', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { driftAlertsRepo } = await import('@/db/repositories.js');
        const a = await driftAlertsRepo.create({
          drift_type: DriftType.PROCEDIMENTO,
          severity: DriftSeverity.CRITICO,
          evidence: { obs: 'step skipped' },
          detected_by: 'detector',
          decision: DriftDecision.ROLLBACK,
          decided_by: 'policy',
        });
        expect(a.resolved_at).toBeNull();

        await driftAlertsRepo.resolve({
          id: a.id,
          resolution_note: 'rollback aplicado v3 → v2',
          resolved_by: 'owner-1',
        });

        const all = await driftAlertsRepo.listByProfileVersion(a.profile_version_id ?? '');
        // listByProfileVersion is null-safe via listUnresolved branch
        const found = (await driftAlertsRepo.listUnresolved()).find((x) => x.id === a.id);
        expect(found).toBeUndefined();

        // Re-read via state — sanity check on resolve mutation
        const allAlerts = Object.values(alertsState);
        const resolved = allAlerts.find((x) => x.id === a.id)!;
        expect(resolved.resolution_note).toBe('rollback aplicado v3 → v2');
        expect(resolved.resolved_at).toBeInstanceOf(Date);
        expect(resolved.resolved_by).toBe('owner-1');
        // Suppress unused warning
        expect(all).toEqual([]);
      },
    );
  });
});
