import { describe, it, expect, vi, beforeEach } from 'vitest';
import { canTransition, validateTransition, transitionProcedureStatus, ProcedureNotFoundError, OptimisticLockError, StatusMismatchError } from '@/cognition/procedure-status.js';
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
//
// The hoisted factory only creates the vi.fn wrapper; the real implementation
// is set via mockImplementation in a shared setup block so it can close over
// mockState and mockEvents at test-call time (not at hoisting time).
// ---------------------------------------------------------------------------
const { withTxMock } = vi.hoisted(() => {
  const withTxMock = vi.fn();
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
// Helper: build a drizzle-like tx sentinel that writes to mockState/mockEvents.
// Used by the default withTxMock implementation and by test D1/D3 overrides.
//
// tx.update(table).set(patch).where(cond).returning()
//   → applies patch to all rows in mockState that have a status field,
//     filtered by status match (the WHERE clause includes status = owned.status
//     for optimistic lock). Returns [] if none matched (0 rows = lock conflict).
// tx.insert(table).values(vals)
//   → pushes vals to mockEvents and resolves.
//
// The sentinel intentionally simulates the optimistic lock: it only updates a
// row if its CURRENT status in mockState matches the from_status passed in vals
// (the implementation supplies the original owned.status in the WHERE clause).
// ---------------------------------------------------------------------------
function buildTxSentinel(
  state: Record<string, any>,
  events: Array<Record<string, any>>,
  opts?: {
    insertShouldThrow?: boolean;
    insertError?: string;
    updateShouldThrow?: boolean;
    // expectedFromStatus: the status value in the WHERE clause (owned.status at call time).
    // If provided, the sentinel enforces the optimistic lock: only updates rows
    // whose current status matches expectedFromStatus. Pass undefined to apply
    // to any row (non-lock mode, for tests that don't test races).
    expectedFromStatus?: string;
  },
): any {
  return {
    update: (_table: any) => ({
      set: (patch: any) => ({
        where: (_cond: any) => ({
          returning: () => {
            if (opts?.updateShouldThrow) {
              return Promise.reject(new Error(opts?.insertError ?? 'update failed'));
            }
            const updated: any[] = [];
            for (const [k, v] of Object.entries(state)) {
              const row = v as any;
              if (!row || !('status' in row)) continue;
              // Simulate optimistic lock: only update if the current row status
              // matches the expectedFromStatus (the owned.status the implementation
              // captured before entering the transaction).
              // If expectedFromStatus is not provided, apply to first row found
              // (covers simple non-race test cases where only 1 row exists).
              if (opts?.expectedFromStatus !== undefined && row.status !== opts.expectedFromStatus) {
                continue; // Row already moved — WHERE predicate fails → 0 rows
              }
              state[k] = { ...row, ...patch };
              updated.push({ id: k });
            }
            return Promise.resolve(updated);
          },
        }),
      }),
    }),
    insert: (_table: any) => ({
      values: (vals: any) => {
        if (opts?.insertShouldThrow) {
          return Promise.reject(new Error(opts?.insertError ?? 'insert failed'));
        }
        events.push(vals);
        return Promise.resolve();
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// Default withTxMock implementation:
//   - Snapshots mockState + mockEvents (simulates BEGIN)
//   - Calls fn with a tx sentinel that writes to mockState/mockEvents
//   - On throw: restores both (simulates ROLLBACK)
//   - On success: leaves changes in place (simulates COMMIT)
// Per-test overrides use withTxMock.mockImplementationOnce(...)
// ---------------------------------------------------------------------------
beforeEach(() => {
  withTxMock.mockImplementation(async (fn: (tx: any) => Promise<any>) => {
    const snapshot = JSON.parse(JSON.stringify(mockState));
    const eventsLen = mockEvents.length;
    const tx = buildTxSentinel(mockState, mockEvents);
    try {
      return await fn(tx);
    } catch (err) {
      for (const k of Object.keys(mockState)) delete mockState[k];
      Object.assign(mockState, snapshot);
      mockEvents.splice(eventsLen);
      throw err;
    }
  });
});

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
      const { procedureTestsRepo } = await import('@/db/repositories.js');

      // Step 1: draft → proposed (non-active path → tx.insert pushes to mockEvents)
      const def1 = seedDef('walk-1', 'draft');
      await transitionProcedureStatus({ definition: def1, to: 'proposed', actor: 'actor-a' });

      // Step 2: proposed → active (active path → atomicActivate mock pushes its own event)
      const proposed = mockState['walk-1'];
      await procedureTestsRepo.create({ definition_id: 'walk-1', name: 'p', scenario: {}, expected_outcome: 'ok' });
      await transitionProcedureStatus({ definition: proposed, to: 'active', actor: 'actor-a' });

      // Step 3: separate def active → frozen (non-active path → tx.insert pushes event)
      const def2 = seedDef('walk-frozen', 'active');
      await transitionProcedureStatus({ definition: def2, to: 'frozen', actor: 'actor-b' });

      // Events are now in mockEvents (tx.insert writes directly, atomicActivate mock also pushes)
      const walk1Events = mockEvents.filter((e) => e.definition_id === 'walk-1');
      const frozenEvents = mockEvents.filter((e) => e.definition_id === 'walk-frozen');

      expect(walk1Events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ definition_id: 'walk-1', from_status: 'draft', to_status: 'proposed', actor: 'actor-a' }),
        ]),
      );
      expect(frozenEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ definition_id: 'walk-frozen', from_status: 'active', to_status: 'frozen', actor: 'actor-b' }),
        ]),
      );
      // At minimum 2 events total (walk-1 proposed + walk-frozen frozen; walk-1 active is from atomicActivate mock)
      expect(mockEvents.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('Test A2: draft→proposed→active (full lifecycle) — event is in mockEvents for the proposed step', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const { procedureTestsRepo } = await import('@/db/repositories.js');

      const def = seedDef('lifecycle-1', 'draft');
      await transitionProcedureStatus({ definition: def, to: 'proposed', actor: 'tester' });

      // draft→proposed goes through tx.insert → event in mockEvents
      expect(mockEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ definition_id: 'lifecycle-1', from_status: 'draft', to_status: 'proposed' }),
        ]),
      );

      const proposed = mockState['lifecycle-1'];
      await procedureTestsRepo.create({ definition_id: 'lifecycle-1', name: 'p', scenario: {}, expected_outcome: 'ok' });
      await transitionProcedureStatus({ definition: proposed, to: 'active', actor: 'tester' });

      // Active transition goes through atomicActivate (mock records its own event),
      // so total mockEvents has exactly 2 entries: proposed + active
      expect(mockEvents.length).toBe(2);
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
// Test C2 (round-1 finding 2, updated for round-2): non-active path must be
// atomic (update+event). After round-2 fix, both writes go through tx handles;
// rollback covers both. Test uses a tx sentinel with insertShouldThrow=true.
// ---------------------------------------------------------------------------
describe('transitionProcedureStatus — atomic non-active transition [round-1-C2]', () => {
  beforeEach(() => {
    for (const k of Object.keys(mockState)) delete mockState[k];
    for (const k of Object.keys(mockTests)) delete mockTests[k];
    mockEvents.length = 0;
    vi.clearAllMocks();
    // Default withTxMock (set by top-level beforeEach) provides a tx sentinel
    // that correctly simulates rollback via snapshot restore. No override needed
    // here — per-test will use mockImplementationOnce where a throwing insert
    // is needed.
  });

  it('Test C2: when tx.insert (event) throws after tx.update (status), error propagates and status is rolled back', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const def = seedDef('atomic-test-id', 'draft');
      const originalStatus = def.status; // 'draft'

      // Override withTx to provide a tx sentinel whose insert throws (simulates event DB failure)
      withTxMock.mockImplementationOnce(async (fn: (tx: any) => Promise<any>) => {
        const snapshot = JSON.parse(JSON.stringify(mockState));
        const eventsLen = mockEvents.length;
        const tx = buildTxSentinel(mockState, mockEvents, {
          insertShouldThrow: true,
          insertError: 'event insert failed',
        });
        try {
          return await fn(tx);
        } catch (err) {
          // ROLLBACK: restore both state and events
          for (const k of Object.keys(mockState)) delete mockState[k];
          Object.assign(mockState, snapshot);
          mockEvents.splice(eventsLen);
          throw err;
        }
      });

      await expect(
        transitionProcedureStatus({ definition: def, to: 'proposed', actor: 'tester' }),
      ).rejects.toThrow('event insert failed');

      // The status must NOT be permanently changed (transaction rolled back)
      expect(mockState['atomic-test-id']?.status).toBe(originalStatus);
      // No event must have been committed
      expect(mockEvents.length).toBe(0);
    });
  });

  it('Test C2b: successful transition writes both update and event atomically', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const def = seedDef('atomic-ok-id', 'draft');

      const result = await transitionProcedureStatus({ definition: def, to: 'proposed', actor: 'tester' });

      expect(result.ok).toBe(true);
      expect(mockState['atomic-ok-id']?.status).toBe('proposed');
      // tx.insert pushed event to mockEvents
      expect(mockEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ definition_id: 'atomic-ok-id', from_status: 'draft', to_status: 'proposed' }),
        ]),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Test D1 (round-2): tx handle must actually be used for writes.
// Event insert throws after status update → status MUST roll back.
// Fails pre-fix because withTx callback ignores tx; repo methods use module-level
// db (autocommit). After fix, tx.update+tx.insert are inlined — rollback is real.
// ---------------------------------------------------------------------------
describe('transitionProcedureStatus — D1: tx-aware writes + real rollback [round-2-D1]', () => {
  beforeEach(() => {
    for (const k of Object.keys(mockState)) delete mockState[k];
    for (const k of Object.keys(mockTests)) delete mockTests[k];
    mockEvents.length = 0;
    vi.clearAllMocks();
  });

  it('D1: when tx.insert (event) throws after tx.update (status), status is NOT committed — tx-bound rollback', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const def = seedDef('d1-atomic-id', 'draft');
      const originalStatus = def.status; // 'draft'

      // Track which object the writes go through.
      const txWriteCalls: string[] = [];

      // Build a drizzle-like tx sentinel. The fixed code calls
      // tx.update(procedure_definitions).set(...).where(...) — returning a
      // thenable that updates mockState — then tx.insert(procedure_status_events)
      // which we make throw to simulate DB failure.
      const txSentinel = {
        update: vi.fn((table: any) => {
          txWriteCalls.push('tx.update');
          return {
            set: (patch: any) => ({
              where: (cond: any) => ({
                returning: () => {
                  // Simulate the update succeeding in the tx (not committed yet)
                  if (mockState['d1-atomic-id']) {
                    mockState['d1-atomic-id'] = { ...mockState['d1-atomic-id'], ...patch };
                  }
                  return Promise.resolve([{ id: 'd1-atomic-id' }]);
                },
              }),
            }),
          };
        }),
        insert: vi.fn((table: any) => {
          txWriteCalls.push('tx.insert');
          return {
            values: (_vals: any) => Promise.reject(new Error('event insert failed — simulated DB error')),
          };
        }),
      };

      withTxMock.mockImplementationOnce(async (fn: (tx: any) => Promise<any>) => {
        // Snapshot BEFORE the callback (simulates BEGIN)
        const snapshot = JSON.parse(JSON.stringify(mockState));
        const eventsLen = mockEvents.length;
        try {
          return await fn(txSentinel as any);
        } catch (err) {
          // ROLLBACK: restore to pre-transaction state
          for (const k of Object.keys(mockState)) delete mockState[k];
          Object.assign(mockState, snapshot);
          mockEvents.splice(eventsLen);
          throw err;
        }
      });

      await expect(
        transitionProcedureStatus({ definition: def, to: 'proposed', actor: 'tester' }),
      ).rejects.toThrow('event insert failed');

      // After rollback, status must be the original
      expect(mockState['d1-atomic-id']?.status).toBe(originalStatus);

      // The writes must have gone through the tx sentinel (not module-level db)
      expect(txWriteCalls).toContain('tx.update');
      expect(txWriteCalls).toContain('tx.insert');
    });
  });
});

// ---------------------------------------------------------------------------
// Test D2 (round-2): persisted status (owned.status) must be used for
// validation/gating, NOT args.definition.status.
// Pre-fix: validates from args.definition.status (caller-supplied, potentially stale/forged).
// Post-fix: validates from owned.status (tenant-scoped DB read).
// ---------------------------------------------------------------------------
describe('transitionProcedureStatus — D2: persisted status is source of truth [round-2-D2]', () => {
  beforeEach(() => {
    for (const k of Object.keys(mockState)) delete mockState[k];
    for (const k of Object.keys(mockTests)) delete mockTests[k];
    mockEvents.length = 0;
    vi.clearAllMocks();
  });

  it('D2: caller passes definition.status="frozen" but DB has "proposed", to="active" → throw StatusMismatchError (stale caller status rejected)', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      // DB has the procedure in 'proposed' status
      seedDef('d2-stale-id', 'proposed');

      // Caller supplies a forged/stale definition object claiming status='frozen'.
      // frozen→active is a valid schema transition, so the pre-fix code would
      // bypass proposed→active gate entirely and go to atomicActivate.
      // Post-fix: owned.status='proposed' is used, validateTransition catches the mismatch.
      const forgedDef = { id: 'd2-stale-id', status: 'frozen', nome: 'proc' } as any;

      await expect(
        transitionProcedureStatus({ definition: forgedDef, to: 'active', actor: 'attacker' }),
      ).rejects.toThrow(StatusMismatchError);
    });
  });

  it('D2b: gate check uses owned.status not caller.status — proposed→active gate fires correctly from DB row', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      // DB has 'proposed' (correct gate should fire — no tests → tests_required)
      seedDef('d2b-gate-id', 'proposed');

      // Caller honestly reflects proposed, gate should fire (no tests)
      const def = { id: 'd2b-gate-id', status: 'proposed', nome: 'proc' } as any;
      const result = await transitionProcedureStatus({ definition: def, to: 'active', actor: 'reviewer' });

      // Gate fires because owned.status='proposed' and no tests exist
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('tests_required');
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Test D3 (round-2): optimistic lock — concurrent update race.
// Simulates the scenario where two calls both pass the StatusMismatchError check
// (both read owned.status='draft'), but the first tx commits before the second.
// The second tx.update(WHERE status='draft') returns 0 rows → OptimisticLockError.
//
// Pre-fix: no expected-status WHERE predicate → second call succeeds silently.
// Post-fix: WHERE status=owned.status → 0 rows → throw OptimisticLockError.
// ---------------------------------------------------------------------------
describe('transitionProcedureStatus — D3: optimistic lock prevents silent overwrite [round-2-D3]', () => {
  beforeEach(() => {
    for (const k of Object.keys(mockState)) delete mockState[k];
    for (const k of Object.keys(mockTests)) delete mockTests[k];
    mockEvents.length = 0;
    vi.clearAllMocks();
  });

  it('D3: tx.update returns 0 rows (concurrent write already advanced the row) → throw OptimisticLockError', async () => {
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      // Row starts as 'draft'
      seedDef('d3-race-id', 'draft');

      // Simulate: another concurrent tx already moved the row to 'proposed' just
      // before our tx.update fires. We do this by overriding withTx to provide
      // a tx sentinel whose update() returns [] (0 rows affected), as if the
      // WHERE status='draft' predicate matched nothing (row already at 'proposed').
      withTxMock.mockImplementationOnce(async (fn: (tx: any) => Promise<any>) => {
        const snapshot = JSON.parse(JSON.stringify(mockState));
        const eventsLen = mockEvents.length;
        // Sentinel that returns 0 rows from update (optimistic lock conflict)
        const tx = {
          update: (_table: any) => ({
            set: (_patch: any) => ({
              where: (_cond: any) => ({
                returning: () => Promise.resolve([]), // 0 rows = lock conflict
              }),
            }),
          }),
          insert: (_table: any) => ({
            values: (_vals: any) => Promise.resolve(),
          }),
        };
        try {
          return await fn(tx as any);
        } catch (err) {
          for (const k of Object.keys(mockState)) delete mockState[k];
          Object.assign(mockState, snapshot);
          mockEvents.splice(eventsLen);
          throw err;
        }
      });

      // findById returns the row (status='draft') — caller and DB agree so no StatusMismatchError
      // But tx.update returns 0 rows → OptimisticLockError
      const def = { id: 'd3-race-id', status: 'draft', nome: 'proc' } as any;
      await expect(
        transitionProcedureStatus({ definition: def, to: 'proposed', actor: 'race-actor' }),
      ).rejects.toThrow(OptimisticLockError);

      // State must be unchanged (rollback)
      expect(mockState['d3-race-id']?.status).toBe('draft');
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
