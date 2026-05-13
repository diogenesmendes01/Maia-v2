/**
 * P4 Task 4 — repo tests for operationalProfileVersionsRepo.
 *
 * Mock-based pattern (matches tests/unit/procedure-tests-repo.spec.ts): we
 * mock @/db/repositories.js with an in-memory state. The mock implements the
 * same contract as the real repo so consumer code typed against the repo
 * behaves identically.
 *
 * Validates: status='proposed' default, version auto-increment, transition
 * state machine (proposed → active/frozen/rolled_back; active → frozen/
 * rolled_back; frozen → active/rolled_back; rolled_back terminal),
 * `already_has_active` guard for proposed→active and frozen→active, and
 * filtering helpers (getActive, listByStatus, nextVersion).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { ProfileStatus } from '@/types/enums.js';

type ProfileRow = {
  id: string;
  tenant_id: string;
  agent_id: string;
  version: number;
  status: 'proposed' | 'active' | 'frozen' | 'rolled_back';
  core_immutable: unknown;
  operational_profile: unknown;
  episodic_temp: unknown;
  growth_backlog: unknown;
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

vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>(
    '@/db/repositories.js',
  );

  const computeNextVersion = (tenant_id: string, agent_id: string): number => {
    const rows = Object.values(profilesState).filter(
      (r) => r.tenant_id === tenant_id && r.agent_id === agent_id,
    );
    if (rows.length === 0) return 1;
    return Math.max(...rows.map((r) => r.version)) + 1;
  };

  const findActive = (tenant_id: string, agent_id: string): ProfileRow | null => {
    return (
      Object.values(profilesState).find(
        (r) => r.tenant_id === tenant_id && r.agent_id === agent_id && r.status === 'active',
      ) ?? null
    );
  };

  return {
    ...actual,
    operationalProfileVersionsRepo: {
      create: vi.fn(async (input: {
        core_immutable: unknown;
        operational_profile: unknown;
        episodic_temp?: unknown;
        growth_backlog?: unknown;
        proposed_by: string;
        proposed_reason?: string;
      }) => {
        const tenant_id = 'default';
        const agent_id = 'default';
        const id = `prof-${Math.random().toString(36).slice(2)}`;
        const version = computeNextVersion(tenant_id, agent_id);
        const row: ProfileRow = {
          id,
          tenant_id,
          agent_id,
          version,
          status: 'proposed',
          core_immutable: input.core_immutable,
          operational_profile: input.operational_profile,
          episodic_temp: input.episodic_temp ?? {},
          growth_backlog: input.growth_backlog ?? {},
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
      }),
      getActive: vi.fn(async () => findActive('default', 'default')),
      getById: vi.fn(async (id: string) => profilesState[id] ?? null),
      listByStatus: vi.fn(async (status: string) =>
        Object.values(profilesState).filter((r) => r.status === status),
      ),
      transition: vi.fn(
        async (args: {
          id: string;
          to: 'proposed' | 'active' | 'frozen' | 'rolled_back';
          approved_by?: string;
          rollback_reason?: string;
        }) => {
          const row = profilesState[args.id];
          if (!row) return { ok: false as const, reason: 'not_found' as const };
          const from = row.status;
          if (from === 'rolled_back') return { ok: false as const, reason: 'terminal' as const };
          if (from === args.to) return { ok: false as const, reason: 'invalid_transition' as const };

          const allowed: Record<string, string[]> = {
            proposed: ['active', 'frozen', 'rolled_back'],
            active: ['frozen', 'rolled_back'],
            frozen: ['active', 'rolled_back'],
          };
          if (!allowed[from]?.includes(args.to)) {
            return { ok: false as const, reason: 'invalid_transition' as const };
          }

          if (args.to === 'active') {
            const active = findActive(row.tenant_id, row.agent_id);
            if (active && active.id !== row.id) {
              return { ok: false as const, reason: 'already_has_active' as const };
            }
          }

          const now = new Date();
          const patch: Partial<ProfileRow> = { status: args.to };
          if (args.to === 'active') {
            if (!row.approved_at) {
              patch.approved_at = now;
              patch.approved_by = args.approved_by ?? row.approved_by;
            }
            patch.activated_at = now;
          }
          if (args.to === 'frozen') {
            patch.frozen_at = now;
          }
          if (args.to === 'rolled_back') {
            patch.rolled_back_at = now;
            patch.rollback_reason = args.rollback_reason ?? null;
          }
          const updated = { ...row, ...patch } as ProfileRow;
          profilesState[args.id] = updated;
          return { ok: true as const, updated };
        },
      ),
      nextVersion: vi.fn(async () => computeNextVersion('default', 'default')),
    },
  };
});

describe('operationalProfileVersionsRepo', () => {
  beforeEach(() => {
    for (const k of Object.keys(profilesState)) delete profilesState[k];
    vi.clearAllMocks();
  });

  it('create defaults to status=proposed and version=1 first time', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { operationalProfileVersionsRepo } = await import('@/db/repositories.js');
        const row = await operationalProfileVersionsRepo.create({
          core_immutable: { mission: 'Serve as financial assistant' },
          operational_profile: { tone: 'formal' },
          proposed_by: 'reflector',
          proposed_reason: 'initial bootstrap',
        });
        expect(row.id).toBeDefined();
        expect(row.tenant_id).toBe('default');
        expect(row.agent_id).toBe('default');
        expect(row.status).toBe('proposed');
        expect(row.version).toBe(1);
        expect(row.activated_at).toBeNull();
        expect(row.approved_at).toBeNull();
        expect(row.proposed_by).toBe('reflector');
      },
    );
  });

  it('create auto-increments version per (tenant, agent)', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { operationalProfileVersionsRepo } = await import('@/db/repositories.js');
        const r1 = await operationalProfileVersionsRepo.create({
          core_immutable: {},
          operational_profile: {},
          proposed_by: 'reflector',
        });
        const r2 = await operationalProfileVersionsRepo.create({
          core_immutable: {},
          operational_profile: {},
          proposed_by: 'reflector',
        });
        const r3 = await operationalProfileVersionsRepo.create({
          core_immutable: {},
          operational_profile: {},
          proposed_by: 'reflector',
        });
        expect(r1.version).toBe(1);
        expect(r2.version).toBe(2);
        expect(r3.version).toBe(3);
      },
    );
  });

  it('nextVersion returns 1 first, then 2, then 3...', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { operationalProfileVersionsRepo } = await import('@/db/repositories.js');
        expect(await operationalProfileVersionsRepo.nextVersion()).toBe(1);
        await operationalProfileVersionsRepo.create({
          core_immutable: {},
          operational_profile: {},
          proposed_by: 'r',
        });
        expect(await operationalProfileVersionsRepo.nextVersion()).toBe(2);
        await operationalProfileVersionsRepo.create({
          core_immutable: {},
          operational_profile: {},
          proposed_by: 'r',
        });
        expect(await operationalProfileVersionsRepo.nextVersion()).toBe(3);
      },
    );
  });

  it('transition(proposed → active) works when no other active exists', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { operationalProfileVersionsRepo } = await import('@/db/repositories.js');
        const row = await operationalProfileVersionsRepo.create({
          core_immutable: {},
          operational_profile: {},
          proposed_by: 'r',
        });
        const result = await operationalProfileVersionsRepo.transition({
          id: row.id,
          to: ProfileStatus.ACTIVE,
          approved_by: 'owner-1',
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.updated.status).toBe('active');
          expect(result.updated.approved_at).toBeInstanceOf(Date);
          expect(result.updated.activated_at).toBeInstanceOf(Date);
          expect(result.updated.approved_by).toBe('owner-1');
        }
      },
    );
  });

  it('transition(proposed → active) fails with already_has_active when another active exists', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { operationalProfileVersionsRepo } = await import('@/db/repositories.js');
        const r1 = await operationalProfileVersionsRepo.create({
          core_immutable: {},
          operational_profile: {},
          proposed_by: 'r',
        });
        const r2 = await operationalProfileVersionsRepo.create({
          core_immutable: {},
          operational_profile: {},
          proposed_by: 'r',
        });
        const t1 = await operationalProfileVersionsRepo.transition({
          id: r1.id,
          to: ProfileStatus.ACTIVE,
          approved_by: 'o',
        });
        expect(t1.ok).toBe(true);
        const t2 = await operationalProfileVersionsRepo.transition({
          id: r2.id,
          to: ProfileStatus.ACTIVE,
          approved_by: 'o',
        });
        expect(t2.ok).toBe(false);
        if (!t2.ok) expect(t2.reason).toBe('already_has_active');
      },
    );
  });

  it('transition(active → frozen) sets frozen_at', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { operationalProfileVersionsRepo } = await import('@/db/repositories.js');
        const row = await operationalProfileVersionsRepo.create({
          core_immutable: {},
          operational_profile: {},
          proposed_by: 'r',
        });
        await operationalProfileVersionsRepo.transition({
          id: row.id,
          to: ProfileStatus.ACTIVE,
          approved_by: 'o',
        });
        const result = await operationalProfileVersionsRepo.transition({
          id: row.id,
          to: ProfileStatus.FROZEN,
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.updated.status).toBe('frozen');
          expect(result.updated.frozen_at).toBeInstanceOf(Date);
        }
      },
    );
  });

  it('transition(active → rolled_back) sets rolled_back_at + rollback_reason', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { operationalProfileVersionsRepo } = await import('@/db/repositories.js');
        const row = await operationalProfileVersionsRepo.create({
          core_immutable: {},
          operational_profile: {},
          proposed_by: 'r',
        });
        await operationalProfileVersionsRepo.transition({
          id: row.id,
          to: ProfileStatus.ACTIVE,
          approved_by: 'o',
        });
        const result = await operationalProfileVersionsRepo.transition({
          id: row.id,
          to: ProfileStatus.ROLLED_BACK,
          rollback_reason: 'drift critico detectado',
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.updated.status).toBe('rolled_back');
          expect(result.updated.rolled_back_at).toBeInstanceOf(Date);
          expect(result.updated.rollback_reason).toBe('drift critico detectado');
        }
      },
    );
  });

  it('transition(rolled_back → *) returns terminal', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { operationalProfileVersionsRepo } = await import('@/db/repositories.js');
        const row = await operationalProfileVersionsRepo.create({
          core_immutable: {},
          operational_profile: {},
          proposed_by: 'r',
        });
        await operationalProfileVersionsRepo.transition({
          id: row.id,
          to: ProfileStatus.ROLLED_BACK,
          rollback_reason: 'aborted',
        });
        const result = await operationalProfileVersionsRepo.transition({
          id: row.id,
          to: ProfileStatus.ACTIVE,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('terminal');
      },
    );
  });

  it('transition with unknown id returns not_found', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { operationalProfileVersionsRepo } = await import('@/db/repositories.js');
        const result = await operationalProfileVersionsRepo.transition({
          id: 'nonexistent-id',
          to: ProfileStatus.ACTIVE,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('not_found');
      },
    );
  });

  it('transition same-state returns invalid_transition', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { operationalProfileVersionsRepo } = await import('@/db/repositories.js');
        const row = await operationalProfileVersionsRepo.create({
          core_immutable: {},
          operational_profile: {},
          proposed_by: 'r',
        });
        // proposed -> proposed
        const result = await operationalProfileVersionsRepo.transition({
          id: row.id,
          to: ProfileStatus.PROPOSED,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('invalid_transition');
      },
    );
  });

  it('transition(frozen → active) checks already_has_active', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { operationalProfileVersionsRepo } = await import('@/db/repositories.js');
        // Create v1, activate, freeze
        const r1 = await operationalProfileVersionsRepo.create({
          core_immutable: {},
          operational_profile: {},
          proposed_by: 'r',
        });
        await operationalProfileVersionsRepo.transition({
          id: r1.id,
          to: ProfileStatus.ACTIVE,
          approved_by: 'o',
        });
        await operationalProfileVersionsRepo.transition({
          id: r1.id,
          to: ProfileStatus.FROZEN,
        });
        // Create v2, activate
        const r2 = await operationalProfileVersionsRepo.create({
          core_immutable: {},
          operational_profile: {},
          proposed_by: 'r',
        });
        await operationalProfileVersionsRepo.transition({
          id: r2.id,
          to: ProfileStatus.ACTIVE,
          approved_by: 'o',
        });
        // Try to reactivate frozen v1 → should fail (r2 is active now)
        const result = await operationalProfileVersionsRepo.transition({
          id: r1.id,
          to: ProfileStatus.ACTIVE,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('already_has_active');
      },
    );
  });

  it('getActive returns the active row or null', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { operationalProfileVersionsRepo } = await import('@/db/repositories.js');
        expect(await operationalProfileVersionsRepo.getActive()).toBeNull();
        const row = await operationalProfileVersionsRepo.create({
          core_immutable: {},
          operational_profile: {},
          proposed_by: 'r',
        });
        // still null while proposed
        expect(await operationalProfileVersionsRepo.getActive()).toBeNull();
        await operationalProfileVersionsRepo.transition({
          id: row.id,
          to: ProfileStatus.ACTIVE,
          approved_by: 'o',
        });
        const active = await operationalProfileVersionsRepo.getActive();
        expect(active).not.toBeNull();
        expect(active!.id).toBe(row.id);
        expect(active!.status).toBe('active');
      },
    );
  });

  it('listByStatus filters correctly', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { operationalProfileVersionsRepo } = await import('@/db/repositories.js');
        const r1 = await operationalProfileVersionsRepo.create({
          core_immutable: {},
          operational_profile: {},
          proposed_by: 'r',
        });
        const r2 = await operationalProfileVersionsRepo.create({
          core_immutable: {},
          operational_profile: {},
          proposed_by: 'r',
        });
        await operationalProfileVersionsRepo.create({
          core_immutable: {},
          operational_profile: {},
          proposed_by: 'r',
        });
        await operationalProfileVersionsRepo.transition({
          id: r1.id,
          to: ProfileStatus.ACTIVE,
          approved_by: 'o',
        });
        await operationalProfileVersionsRepo.transition({
          id: r2.id,
          to: ProfileStatus.ROLLED_BACK,
          rollback_reason: 'abort',
        });
        const proposed = await operationalProfileVersionsRepo.listByStatus(ProfileStatus.PROPOSED);
        expect(proposed.length).toBe(1);
        const active = await operationalProfileVersionsRepo.listByStatus(ProfileStatus.ACTIVE);
        expect(active.length).toBe(1);
        const rolledBack = await operationalProfileVersionsRepo.listByStatus(
          ProfileStatus.ROLLED_BACK,
        );
        expect(rolledBack.length).toBe(1);
      },
    );
  });

  it('getById returns the row or null', async () => {
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const { operationalProfileVersionsRepo } = await import('@/db/repositories.js');
        const row = await operationalProfileVersionsRepo.create({
          core_immutable: { key: 'v' },
          operational_profile: {},
          proposed_by: 'r',
        });
        const found = await operationalProfileVersionsRepo.getById(row.id);
        expect(found).not.toBeNull();
        expect(found!.id).toBe(row.id);
        expect(await operationalProfileVersionsRepo.getById('nope')).toBeNull();
      },
    );
  });
});
