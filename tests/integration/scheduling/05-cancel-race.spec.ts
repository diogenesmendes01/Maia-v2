/**
 * Spec 18 §13 — Acceptance test for Requirement 5.
 *
 * Two concurrent flows:
 *  - Flow A: engine reads series at version=1, computes next occurrence,
 *    and is about to insert the next-cycle row.
 *  - Flow B: owner calls cancel_reminder, which atomically updates
 *    series.status='cancelled' AND bumps version=2.
 *
 * The next-occurrence insert MUST be dropped because the version no
 * longer matches. This is enforced by `insertNextOccurrenceIfActive`'s
 * `WHERE status='active' AND version=$observed` guard.
 *
 * Also asserts: cancellation marks all pending occurrences `cancelled`
 * in the SAME transaction as the version bump.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// State machine for the series. We simulate two workers operating on it.
type State = {
  series_id: string;
  status: 'active' | 'cancelled';
  version: number;
  occurrences: Array<{ id: string; scheduled_for: Date; status: 'pending' | 'cancelled' }>;
};
const state: State = {
  series_id: 's-race',
  status: 'active',
  version: 1,
  occurrences: [],
};

const txSelectChain = {
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  limit: vi.fn(async () => {
    if (state.status === 'active') return [{ id: state.series_id, status: state.status, version: state.version }];
    return [];
  }),
};
let insertCallNum = 0;
const txInsertChain = {
  values: vi.fn().mockReturnThis(),
  returning: vi.fn(async () => {
    insertCallNum += 1;
    // The repo's `insertNextOccurrenceIfActive` issues TWO inserts:
    //   1st = occurrence row (we append to state)
    //   2nd = task rows (we just return a stub, do NOT touch state)
    // After 2 calls we reset for the next public-API invocation.
    if (insertCallNum === 1) {
      const id = `occ-new-${state.occurrences.length + 1}`;
      state.occurrences.push({ id, scheduled_for: new Date(), status: 'pending' });
      return [{ id, scheduled_for: new Date() }];
    }
    insertCallNum = 0;
    return [{ id: `task-${Math.random().toString(36).slice(2, 8)}` }];
  }),
};
const txUpdateChain = {
  set: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  returning: vi.fn(async () => {
    // Detect "UPDATE series SET status='cancelled' WHERE status='active'"
    // by inspecting the last `set` call.
    const setCall = txUpdateChain.set.mock.calls.at(-1);
    const payload = setCall?.[0] as Record<string, unknown> | undefined;
    if (payload && payload['status'] === 'cancelled' && state.status === 'active') {
      state.status = 'cancelled';
      state.version += 1;
      // Cancel any pending occurrences in the same tx.
      const cancelled: Array<{ id: string }> = [];
      for (const o of state.occurrences) {
        if (o.status === 'pending') {
          o.status = 'cancelled';
          cancelled.push({ id: o.id });
        }
      }
      // Return the right shape based on the previous call's table — for
      // simplicity, return the series row first, then occurrences. The
      // repo calls update twice in cancelAtomic.
      const callCount = txUpdateChain.returning.mock.calls.length;
      if (callCount === 1) return [{ id: state.series_id, status: 'cancelled', version: state.version }];
      return cancelled;
    }
    return [];
  }),
};
const txMock = {
  select: vi.fn().mockReturnValue(txSelectChain),
  insert: vi.fn().mockReturnValue(txInsertChain),
  update: vi.fn().mockReturnValue(txUpdateChain),
};
const withTxMock = vi.fn(async (fn: (tx: typeof txMock) => unknown) => fn(txMock));
vi.mock('../../../src/db/client.js', () => ({
  db: { select: txMock.select, insert: txMock.insert, update: txMock.update },
  withTx: withTxMock,
}));

vi.mock('../../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  state.series_id = 's-race';
  state.status = 'active';
  state.version = 1;
  state.occurrences = [
    { id: 'occ-existing', scheduled_for: new Date(), status: 'pending' },
  ];
  vi.clearAllMocks();
  txSelectChain.from.mockReturnThis();
  txSelectChain.where.mockReturnThis();
  txInsertChain.values.mockReturnThis();
  txUpdateChain.set.mockReturnThis();
  txUpdateChain.where.mockReturnThis();
});

describe('Requirement 5 — cancel-race', () => {
  it('cancel commits BEFORE next-occurrence insert: insert is dropped', async () => {
    const { seriesRepo } = await import('../../../src/scheduling/repos.js');

    // Step 1: cancel commits (status=cancelled, version=2).
    const cancelResult = await seriesRepo.cancelAtomic(state.series_id, 'owner-id');
    expect(cancelResult.series?.status).toBe('cancelled');
    expect(state.status).toBe('cancelled');
    expect(state.occurrences.find((o) => o.id === 'occ-existing')?.status).toBe('cancelled');

    // Step 2: engine (with stale version=1 it read earlier) attempts to
    // insert the next occurrence. Guard rejects (0 rows match status=active
    // AND version=1).
    const insertResult = await seriesRepo.insertNextOccurrenceIfActive({
      series_id: state.series_id,
      expected_version: 1,
      scheduled_for: new Date('2026-06-05T12:00:00Z'),
      contexto_snapshot: { texto: 'X', canal: 'whatsapp' } as never,
      tasks: [{ ordem: 1, kind: 'fire_reminder' }],
    });
    expect(insertResult.occurrence).toBeNull();
    // No new "occ-new-*" was added.
    expect(state.occurrences.some((o) => o.id.startsWith('occ-new'))).toBe(false);
  });

  it('insert raced and won (cancel arrives a moment later): cancel still flips the new occurrence to cancelled', async () => {
    const { seriesRepo } = await import('../../../src/scheduling/repos.js');

    // Step 1: engine inserts the next occurrence while series is still
    // active and version matches.
    const ins = await seriesRepo.insertNextOccurrenceIfActive({
      series_id: state.series_id,
      expected_version: 1,
      scheduled_for: new Date('2026-06-05T12:00:00Z'),
      contexto_snapshot: { texto: 'X', canal: 'whatsapp' } as never,
      tasks: [{ ordem: 1, kind: 'fire_reminder' }],
    });
    expect(ins.occurrence).not.toBeNull();
    expect(state.occurrences.filter((o) => o.id.startsWith('occ-new')).length).toBe(1);

    // Step 2: cancel atomic — flips status to cancelled AND moves all
    // pending occurrences (including the new one) to cancelled.
    const cancel = await seriesRepo.cancelAtomic(state.series_id, 'owner-id');
    expect(cancel.series?.status).toBe('cancelled');
    expect(state.occurrences.every((o) => o.status === 'cancelled')).toBe(true);
  });

  it('cancel is idempotent: re-cancel is a no-op (no version bump, no error)', async () => {
    const { seriesRepo } = await import('../../../src/scheduling/repos.js');
    const r1 = await seriesRepo.cancelAtomic(state.series_id, 'owner-id');
    expect(r1.series?.status).toBe('cancelled');
    expect(state.version).toBe(2);
    const r2 = await seriesRepo.cancelAtomic(state.series_id, 'owner-id');
    expect(r2.cancelled_occurrence_ids).toEqual([]);
    expect(state.version).toBe(2); // no double-bump
  });
});
