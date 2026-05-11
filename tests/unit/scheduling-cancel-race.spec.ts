import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Requirement 5: cancellation must prevent NEW occurrences even with a
 * concurrent worker tick. The repo's `insertNextOccurrenceIfActive`
 * gates the INSERT on (series.status='active' AND series.version=$v).
 *
 * We test the gate contract here at the repo level by mocking the
 * underlying drizzle transaction's `select` to return the post-cancel
 * series state and asserting the function reports `occurrence: null`
 * without ever calling `insert`.
 */

const txSelectChain = {
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  limit: vi.fn(),
};
const txInsertChain = {
  values: vi.fn().mockReturnThis(),
  returning: vi.fn(),
};
const txUpdateChain = {
  set: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  returning: vi.fn(),
};
const txMock = {
  select: vi.fn().mockReturnValue(txSelectChain),
  insert: vi.fn().mockReturnValue(txInsertChain),
  update: vi.fn().mockReturnValue(txUpdateChain),
};
const transactionMock = vi.fn(async (fn: (tx: typeof txMock) => unknown) => fn(txMock));

vi.mock('../../src/db/client.js', () => ({
  db: { transaction: transactionMock, select: txMock.select, insert: txMock.insert, update: txMock.update },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  txSelectChain.limit.mockReset();
  txInsertChain.values.mockClear();
  txInsertChain.returning.mockReset();
  txUpdateChain.set.mockClear();
  txUpdateChain.where.mockClear();
  txUpdateChain.returning.mockReset();
  txMock.select.mockClear();
  txMock.insert.mockClear();
  txMock.update.mockClear();
  transactionMock.mockClear();
});

describe('seriesRepo.insertNextOccurrenceIfActive — Requirement 5', () => {
  it('drops the insert when the series has been cancelled (status check)', async () => {
    // Engine read version=1 earlier; cancel fired in between and bumped to v=2.
    txSelectChain.limit.mockResolvedValue([]); // guard returns 0 rows.
    const { seriesRepo } = await import('../../src/scheduling/repos.js');
    const result = await seriesRepo.insertNextOccurrenceIfActive({
      series_id: 'series-1',
      expected_version: 1,
      scheduled_for: new Date('2026-06-05T12:00:00Z'),
      contexto_snapshot: { texto: 'x', canal: 'whatsapp' } as never,
      tasks: [{ ordem: 1, kind: 'fire_reminder' }],
    });
    expect(result).toEqual({ occurrence: null, tasks: [] });
    expect(txMock.insert).not.toHaveBeenCalled();
  });

  it('drops the insert when version has changed (concurrent edit)', async () => {
    // Series still active but at version=3 now; engine had v=1.
    txSelectChain.limit.mockResolvedValue([]); // guard fails — no row with v=1+active
    const { seriesRepo } = await import('../../src/scheduling/repos.js');
    const result = await seriesRepo.insertNextOccurrenceIfActive({
      series_id: 'series-1',
      expected_version: 1,
      scheduled_for: new Date('2026-06-05T12:00:00Z'),
      contexto_snapshot: { texto: 'x', canal: 'whatsapp' } as never,
      tasks: [{ ordem: 1, kind: 'fire_reminder' }],
    });
    expect(result).toEqual({ occurrence: null, tasks: [] });
    expect(txMock.insert).not.toHaveBeenCalled();
  });

  it('inserts when the version matches and series is active', async () => {
    txSelectChain.limit.mockResolvedValue([{ id: 'series-1', status: 'active', version: 1 }]);
    txInsertChain.returning
      .mockResolvedValueOnce([{ id: 'occ-new', scheduled_for: new Date() }])
      .mockResolvedValueOnce([{ id: 'task-new', ordem: 1, kind: 'fire_reminder' }]);
    const { seriesRepo } = await import('../../src/scheduling/repos.js');
    const result = await seriesRepo.insertNextOccurrenceIfActive({
      series_id: 'series-1',
      expected_version: 1,
      scheduled_for: new Date('2026-06-05T12:00:00Z'),
      contexto_snapshot: { texto: 'x', canal: 'whatsapp' } as never,
      tasks: [{ ordem: 1, kind: 'fire_reminder' }],
    });
    expect(result.occurrence).not.toBeNull();
    expect(txInsertChain.values).toHaveBeenCalledTimes(2); // occurrence + tasks
  });

  it('returns null when UNIQUE (series_id, scheduled_for) conflicts (idempotent dedup)', async () => {
    txSelectChain.limit.mockResolvedValue([{ id: 'series-1', status: 'active', version: 1 }]);
    txInsertChain.returning.mockRejectedValueOnce(
      new Error('duplicate key value violates unique constraint'),
    );
    const { seriesRepo } = await import('../../src/scheduling/repos.js');
    const result = await seriesRepo.insertNextOccurrenceIfActive({
      series_id: 'series-1',
      expected_version: 1,
      scheduled_for: new Date('2026-06-05T12:00:00Z'),
      contexto_snapshot: { texto: 'x', canal: 'whatsapp' } as never,
      tasks: [{ ordem: 1, kind: 'fire_reminder' }],
    });
    expect(result).toEqual({ occurrence: null, tasks: [] });
  });
});

describe('seriesRepo.cancelAtomic — Requirement 5', () => {
  it('cancels series + all pending/claimed occurrences in one transaction', async () => {
    txUpdateChain.returning
      .mockResolvedValueOnce([{ id: 'series-1', status: 'cancelled', version: 2 }]) // series update
      .mockResolvedValueOnce([{ id: 'occ-1' }, { id: 'occ-2' }]); // occurrences update
    const { seriesRepo } = await import('../../src/scheduling/repos.js');
    const result = await seriesRepo.cancelAtomic('series-1', 'owner-id');
    expect(result.series?.status).toBe('cancelled');
    expect(result.cancelled_occurrence_ids.sort()).toEqual(['occ-1', 'occ-2']);
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });

  it('no-op when series is already cancelled (returns existing)', async () => {
    txUpdateChain.returning.mockResolvedValueOnce([]); // UPDATE matched 0 rows
    txSelectChain.limit.mockResolvedValueOnce([
      { id: 'series-1', status: 'cancelled', version: 5 },
    ]);
    const { seriesRepo } = await import('../../src/scheduling/repos.js');
    const result = await seriesRepo.cancelAtomic('series-1', 'owner-id');
    expect(result.series?.status).toBe('cancelled');
    expect(result.cancelled_occurrence_ids).toEqual([]);
  });
});
