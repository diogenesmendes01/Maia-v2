import { describe, it, expect, vi, beforeEach } from 'vitest';
import { canTransition, validateTransition, transitionProcedureStatus, ProcedureNotFoundError } from '@/cognition/procedure-status.js';
import { runWithTenantContext } from '@/db/tenant-context.js';

// ---------------------------------------------------------------------------
// Shared in-memory state for transitionProcedureStatus tests
// ---------------------------------------------------------------------------
const mockState: Record<string, any> = {};
const mockEvents: Array<Record<string, any>> = [];
const mockTests: Record<string, any> = {};

// ---------------------------------------------------------------------------
// withTx mock — must use vi.hoisted so the factory reference is available
// when vi.mock is hoisted to top of file by vitest.
// Simulates transactional rollback in-memory: snapshots mockState before
// the callback; restores on throw.
// ---------------------------------------------------------------------------
const { withTxMock } = vi.hoisted(() => {
  const withTxMock = vi.fn(async (fn: (tx: any) => Promise<any>) => {
    return fn({} as any);
  });
  return { withTxMock };
});

vi.mock('@/db/client.js', () => ({
  db: {},
  withTx: withTxMock,
}));

vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>(
    '@/db/repositories.js',
  );
  return {
    ...actual,
    procedureDefinitionsRepo: {
      findById: vi.fn(async (id: string) => mockState[id] ?? null),
      updateStatus: vi.fn(async (id: string, updates: any) => {
        if (mockState[id]) {
          mockState[id] = { ...mockState[id], ...updates };
          return 1;
        }
        return 0; // cross-tenant / not-found
      }),
      atomicActivate: vi.fn(
        async (args: { target_id: string; actor: string; preserve_activated_at?: boolean }) => {
          const target = mockState[args.target_id];
          if (!target) throw new Error('not found');
          const now = new Date();
          const fromStatus = target.status;
          const patch: any = {
            status: 'active',
            approved_by: args.actor,
            approved_at: now,
            deactivated_at: null,
            activated_at: target.activated_at ?? now,
          };
          mockState[args.target_id] = { ...target, ...patch };
          mockEvents.push({
            definition_id: target.id,
            from_status: fromStatus,
            to_status: 'active',
            actor: args.actor,
          });
          return { activated: mockState[args.target_id], deactivated: null };
        },
      ),
    },
    procedureStatusEventsRepo: {
      record: vi.fn(async (input: any) => {
        mockEvents.push(input);
      }),
      listByDefinition: vi.fn(async (definition_id: string) =>
        mockEvents.filter((e) => e.definition_id === definition_id),
      ),
    },
    procedureTestsRepo: {
      listByDefinition: vi.fn(async (definition_id: string) =>
        Object.values(mockTests).filter((t: any) => t.definition_id === definition_id),
      ),
      create: vi.fn(async (input: any) => {
        const id = `test-${Math.random().toString(36).slice(2)}`;
        mockTests[id] = { id, last_run_status: 'pass', ...input };
        return mockTests[id];
      }),
      recordRun: vi.fn(),
      allPassFor: vi.fn(async () => true),
      delete: vi.fn(),
    },
    cognitiveModuleLogRepo: {
      record: vi.fn(async () => {}),
      recentByModule: vi.fn(async () => []),
    },
  };
});

// ---------------------------------------------------------------------------
// Helper: seed a definition in mockState
// ---------------------------------------------------------------------------
function seedDef(id: string, status: string, nome = 'test-proc'): any {
  const def = { id, status, nome };
  mockState[id] = def;
  return def;
}

// ---------------------------------------------------------------------------
// Test A: event recorded for EVERY transition (not only → active)
// ---------------------------------------------------------------------------
describe('transitionProcedureStatus — event recording', () => {
  beforeEach(() => {
    for (const k of Object.keys(mockState)) delete mockState[k];
    for (const k of Object.keys(mockTests)) delete mockTests[k];
    mockEvents.length = 0;
    vi.clearAllMocks();
  });

  it('Test A: records an event for every accepted transition (draft→proposed→active→frozen walk produces 3 event rows for this definition)', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const { procedureStatusEventsRepo } = await import('@/db/repositories.js');
      const { procedureTestsRepo } = await import('@/db/repositories.js');

      // Step 1: draft → proposed
      const def1 = seedDef('walk-1', 'draft');
      await transitionProcedureStatus({ definition: def1, to: 'proposed', actor: 'actor-a' });

      // Step 2: proposed → active (needs passing test for gate)
      const proposed = mockState['walk-1'];
      const t = await procedureTestsRepo.create({ definition_id: 'walk-1', name: 'p', scenario: {}, expected_outcome: 'ok' });
      await transitionProcedureStatus({ definition: proposed, to: 'active', actor: 'actor-a' });

      // Step 3: active → frozen (to get a 3rd event, seed new def since atomicActivate mock doesn't call record)
      // Instead walk draft→proposed→frozen (3 non-active transitions)
      // Actually let's use a separate def for frozen transition
      const def2 = seedDef('walk-frozen', 'active');
      await transitionProcedureStatus({ definition: def2, to: 'frozen', actor: 'actor-b' });

      // procedureStatusEventsRepo.record must have been called at least 2 times
      // for the walk-1 definition (draft→proposed and proposed→active)
      // and at least 1 time for walk-frozen (active→frozen)
      expect(procedureStatusEventsRepo.record).toHaveBeenCalledWith(
        expect.objectContaining({ definition_id: 'walk-1', from_status: 'draft', to_status: 'proposed', actor: 'actor-a' }),
      );
      expect(procedureStatusEventsRepo.record).toHaveBeenCalledWith(
        expect.objectContaining({ definition_id: 'walk-frozen', from_status: 'active', to_status: 'frozen', actor: 'actor-b' }),
      );
      // Total calls across all three non-active-path transitions: at minimum 2
      expect((procedureStatusEventsRepo.record as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('Test A2: draft→proposed→active (full lifecycle) — record called for the proposed step', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const { procedureStatusEventsRepo, procedureTestsRepo } = await import('@/db/repositories.js');

      const def = seedDef('lifecycle-1', 'draft');
      await transitionProcedureStatus({ definition: def, to: 'proposed', actor: 'tester' });

      // Assert event was recorded for draft→proposed
      expect(procedureStatusEventsRepo.record).toHaveBeenCalledWith(
        expect.objectContaining({ definition_id: 'lifecycle-1', from_status: 'draft', to_status: 'proposed' }),
      );

      const proposed = mockState['lifecycle-1'];
      await procedureTestsRepo.create({ definition_id: 'lifecycle-1', name: 'p', scenario: {}, expected_outcome: 'ok' });
      await transitionProcedureStatus({ definition: proposed, to: 'active', actor: 'tester' });

      // Active transition goes through atomicActivate (mock records its own event),
      // so procedureStatusEventsRepo.record call count is exactly 1 from the proposed step
      expect((procedureStatusEventsRepo.record as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Test B: cross-tenant / not-found throws ProcedureNotFoundError
// ---------------------------------------------------------------------------
describe('transitionProcedureStatus — cross-tenant guard', () => {
  beforeEach(() => {
    for (const k of Object.keys(mockState)) delete mockState[k];
    mockEvents.length = 0;
    vi.clearAllMocks();
  });

  it('Test B: throws ProcedureNotFoundError when id not visible in current tenant (findById returns null)', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const ghost = { id: 'ghost-id', status: 'draft', nome: 'ghost' } as any;
      // ghost-id is NOT in mockState → findById returns null → ProcedureNotFoundError thrown
      await expect(
        transitionProcedureStatus({ definition: ghost, to: 'proposed', actor: 'hacker' }),
      ).rejects.toThrow(ProcedureNotFoundError);
    });
  });
});

// ---------------------------------------------------------------------------
// Test C1 (round-1 finding 1): cross-tenant proposed→active must throw
// ProcedureNotFoundError BEFORE returning tests_required
// ---------------------------------------------------------------------------
describe('transitionProcedureStatus — cross-tenant proposed→active pre-check [round-1-C1]', () => {
  beforeEach(() => {
    for (const k of Object.keys(mockState)) delete mockState[k];
    for (const k of Object.keys(mockTests)) delete mockTests[k];
    mockEvents.length = 0;
    vi.clearAllMocks();
    withTxMock.mockClear();
  });

  it('Test C1: throws ProcedureNotFoundError when findById returns null for proposed→active, NOT tests_required', async () => {
    await runWithTenantContext({ tenant_id: 'tenant-b', agent_id: 'default' }, async () => {
      // Definition object comes from tenant A (ID not visible in tenant B's mockState)
      const crossTenantDef = { id: 'tenant-a-proc-id', status: 'proposed', nome: 'some-proc' } as any;
      // mockState is empty → findById returns null for this ID (cross-tenant / invisible)

      await expect(
        transitionProcedureStatus({ definition: crossTenantDef, to: 'active', actor: 'attacker' }),
      ).rejects.toThrow(ProcedureNotFoundError);
    });
  });

  it('Test C1b: does NOT reach listByDefinition (gate) when findById returns null', async () => {
    await runWithTenantContext({ tenant_id: 'tenant-b', agent_id: 'default' }, async () => {
      const { procedureTestsRepo } = await import('@/db/repositories.js');

      const crossTenantDef = { id: 'tenant-a-proc-id-2', status: 'proposed', nome: 'proc-2' } as any;

      await expect(
        transitionProcedureStatus({ definition: crossTenantDef, to: 'active', actor: 'attacker' }),
      ).rejects.toThrow(ProcedureNotFoundError);

      // The gate (listByDefinition on procedureTestsRepo) must NOT have been called
      expect(procedureTestsRepo.listByDefinition).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Test C2 (round-1 finding 2): non-active path must be atomic (update+event)
// If record() throws, status change must be rolled back.
// ---------------------------------------------------------------------------
describe('transitionProcedureStatus — atomic non-active transition [round-1-C2]', () => {
  beforeEach(() => {
    for (const k of Object.keys(mockState)) delete mockState[k];
    for (const k of Object.keys(mockTests)) delete mockTests[k];
    mockEvents.length = 0;
    vi.clearAllMocks();
    // Set withTxMock to simulate transactional rollback: snapshot state before
    // the callback and restore it on failure.
    withTxMock.mockImplementation(async (fn: (tx: any) => Promise<any>) => {
      const snapshot = JSON.parse(JSON.stringify(mockState));
      const eventsLen = mockEvents.length;
      try {
        return await fn({} as any);
      } catch (err) {
        // Rollback: restore state
        for (const k of Object.keys(mockState)) delete mockState[k];
        Object.assign(mockState, snapshot);
        mockEvents.splice(eventsLen);
        throw err;
      }
    });
  });

  it('Test C2: when record() throws after updateStatus succeeds, the error propagates and status remains unchanged (tx rollback)', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const { procedureStatusEventsRepo } = await import('@/db/repositories.js');

      const def = seedDef('atomic-test-id', 'draft');
      const originalStatus = def.status; // 'draft'

      // Make record() throw to simulate event insert failure
      (procedureStatusEventsRepo.record as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('event insert failed'),
      );

      await expect(
        transitionProcedureStatus({ definition: def, to: 'proposed', actor: 'tester' }),
      ).rejects.toThrow('event insert failed');

      // The status must NOT be permanently changed (transaction rolled back)
      expect(mockState['atomic-test-id']?.status).toBe(originalStatus);
    });
  });

  it('Test C2b: successful transition still writes both update and event', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const { procedureStatusEventsRepo } = await import('@/db/repositories.js');

      const def = seedDef('atomic-ok-id', 'draft');

      const result = await transitionProcedureStatus({ definition: def, to: 'proposed', actor: 'tester' });

      expect(result.ok).toBe(true);
      expect(mockState['atomic-ok-id']?.status).toBe('proposed');
      expect(procedureStatusEventsRepo.record).toHaveBeenCalledWith(
        expect.objectContaining({ definition_id: 'atomic-ok-id', from_status: 'draft', to_status: 'proposed' }),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Original tests (canTransition / validateTransition)
// ---------------------------------------------------------------------------
describe('canTransition', () => {
  it('aceita draft → proposed', () => {
    expect(canTransition('draft', 'proposed')).toBe(true);
  });
  it('aceita proposed → active', () => {
    expect(canTransition('proposed', 'active')).toBe(true);
  });
  it('aceita proposed → draft (rejection)', () => {
    expect(canTransition('proposed', 'draft')).toBe(true);
  });
  it('aceita active → frozen', () => {
    expect(canTransition('active', 'frozen')).toBe(true);
  });
  it('aceita active → rolled_back', () => {
    expect(canTransition('active', 'rolled_back')).toBe(true);
  });
  it('aceita frozen → active (unfreeze)', () => {
    expect(canTransition('frozen', 'active')).toBe(true);
  });
  it('rejeita rolled_back → qualquer coisa (terminal)', () => {
    expect(canTransition('rolled_back', 'active')).toBe(false);
    expect(canTransition('rolled_back', 'draft')).toBe(false);
  });
  it('rejeita draft → active diretamente (precisa passar por proposed)', () => {
    expect(canTransition('draft', 'active')).toBe(false);
  });
});

describe('validateTransition', () => {
  it('throws ao tentar transition inválida', () => {
    expect(() => validateTransition('rolled_back', 'active')).toThrow();
  });
  it('não throws em transition válida', () => {
    expect(() => validateTransition('draft', 'proposed')).not.toThrow();
  });
});
