/**
 * Review 3 BLOCKER — `claimInProgressForAdvance()` must NOT return
 * `one_shot_reminder` occurrences. Previously it returned any `in_progress`
 * row regardless of series tipo. If the outbox row was still pending
 * (rate-limited, baileys disconnected, retry pending), the engine would
 * mark the occurrence `completed/fired` on the next tick — phantom success
 * while the underlying message never reached WhatsApp.
 *
 * The fix restricts the claim at the SQL level (JOIN series, filter
 * `tipo='recurring_outreach'`) AND adds a defensive branch in
 * `advanceInProgressOccurrence`: if the tipo is not recurring_outreach,
 * release the claim and warn — never mark `completed`.
 *
 * The first three specs simulate a misbehaving claim returning the
 * wrong tipo (e.g., a manual data fix or a race against series cancellation)
 * to exercise the engine-side defence-in-depth. The fourth verifies the
 * normal `one_shot_reminder` flow: completion belongs to outbox-drain
 * after a confirmed send, not to the engine.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const claimDueMock = vi.fn().mockResolvedValue([]);
const reclaimMock = vi.fn().mockResolvedValue([]);
const claimInProgressMock = vi.fn();
const listAwaitingTimedOutMock = vi.fn().mockResolvedValue([]);
const setStatusMock = vi.fn().mockResolvedValue(undefined);
const releaseClaimMock = vi.fn().mockResolvedValue(undefined);
const hasOpenExclMock = vi.fn().mockResolvedValue(false);
const listOverdueMock = vi.fn().mockResolvedValue([]);
const findSeriesMock = vi.fn();
const byIdMock = vi.fn();
const tasksByOccMock = vi.fn().mockResolvedValue([]);
const tasksSetStatusMock = vi.fn().mockResolvedValue(undefined);
const enqueueMock = vi.fn().mockResolvedValue({ id: 'ob' });
const insertNextMock = vi.fn().mockResolvedValue({ occurrence: null, tasks: [] });

vi.mock('../../src/scheduling/repos.js', () => ({
  seriesRepo: { findById: findSeriesMock, insertNextOccurrenceIfActive: insertNextMock },
  occurrencesRepo: {
    claimDue: claimDueMock,
    reclaimExpiredLeases: reclaimMock,
    claimInProgressForAdvance: claimInProgressMock,
    listAwaitingTimedOut: listAwaitingTimedOutMock,
    setStatus: setStatusMock,
    releaseClaim: releaseClaimMock,
    hasOpenForDestinatarioExcluding: hasOpenExclMock,
    listOverdueForSeries: listOverdueMock,
    byId: byIdMock,
  },
  tasksRepo: { byOccurrence: tasksByOccMock, setStatus: tasksSetStatusMock },
  outboxRepo: { enqueue: enqueueMock },
  advanceWithTx: vi.fn(async (fn) =>
    fn(
      {},
      {
        occurrences: { setStatus: setStatusMock },
        tasks: { setStatus: tasksSetStatusMock },
        outbox: { enqueue: enqueueMock },
      },
    ),
  ),
}));

vi.mock('../../src/db/repositories.js', () => ({
  pessoasRepo: { findById: vi.fn() },
  conversasRepo: { findActive: vi.fn() },
  pendingQuestionsRepo: { createTx: vi.fn() },
}));

const auditMock = vi.fn();
vi.mock('../../src/governance/audit.js', () => ({ audit: auditMock }));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('../../src/config/env.js', () => ({
  config: {
    FEATURE_SCHEDULING_V2: true,
    OCCURRENCE_LEASE_TTL_SECONDS: 300,
    VALOR_LIMITE_DURO: 50000,
  },
}));

const occBase = {
  id: 'occ-rem-1',
  series_id: 's-rem-1',
  scheduled_for: new Date(Date.now() - 60_000),
  status: 'in_progress',
  contexto_snapshot: { texto: 'pagar luz' },
};

beforeEach(() => {
  vi.clearAllMocks();
  claimDueMock.mockResolvedValue([]);
  reclaimMock.mockResolvedValue([]);
  listAwaitingTimedOutMock.mockResolvedValue([]);
  setStatusMock.mockResolvedValue(undefined);
  releaseClaimMock.mockResolvedValue(undefined);
  hasOpenExclMock.mockResolvedValue(false);
  listOverdueMock.mockResolvedValue([]);
  tasksByOccMock.mockResolvedValue([]);
  tasksSetStatusMock.mockResolvedValue(undefined);
  enqueueMock.mockResolvedValue({ id: 'ob' });
  insertNextMock.mockResolvedValue({ occurrence: null, tasks: [] });
});

describe('advanceInProgressOccurrence — one_shot_reminder must not be finalized by scheduler', () => {
  it('one_shot_reminder in_progress: engine RELEASES claim, does NOT mark completed', async () => {
    // Simulate the claim returning a row whose tipo is NOT recurring_outreach
    // (defence-in-depth: even if the SQL filter is bypassed by a race or a
    // manual data fix, the engine must not lie about completion).
    claimInProgressMock.mockResolvedValue([occBase]);
    findSeriesMock.mockResolvedValue({
      id: 's-rem-1',
      tipo: 'one_shot_reminder',
      status: 'active',
      version: 1,
      staleness_threshold_hours: 24,
      missed_run_policy: 'fire_latest_only',
      month_end_policy: 'skip_invalid_month',
      exclusive_per_destinatario: false,
      owner_pessoa_id: 'owner-id',
      rrule: null,
    });

    const { runSchedulingTick } = await import('../../src/scheduling/engine.js');
    await runSchedulingTick();

    // No `completed` mutation.
    expect(
      setStatusMock.mock.calls.find((c) => c[1] === 'completed'),
    ).toBeUndefined();
    // Claim released — outbox-drain owns completion.
    expect(releaseClaimMock).toHaveBeenCalledWith(occBase.id, 30);
    // No occurrence_completed audit.
    expect(
      auditMock.mock.calls.some(
        (c) => (c[0] as { acao: string }).acao === 'occurrence_completed',
      ),
    ).toBe(false);
  });

  it('recurring_payment in_progress (also unexpected): release claim, no false success', async () => {
    claimInProgressMock.mockResolvedValue([
      { ...occBase, id: 'occ-pay-1', series_id: 's-pay-1' },
    ]);
    findSeriesMock.mockResolvedValue({
      id: 's-pay-1',
      tipo: 'recurring_payment',
      status: 'active',
      version: 1,
      staleness_threshold_hours: 24,
      missed_run_policy: 'fire_latest_only',
      month_end_policy: 'skip_invalid_month',
      exclusive_per_destinatario: false,
      owner_pessoa_id: 'owner-id',
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=5',
    });

    const { runSchedulingTick } = await import('../../src/scheduling/engine.js');
    await runSchedulingTick();

    expect(
      setStatusMock.mock.calls.find((c) => c[1] === 'completed'),
    ).toBeUndefined();
    expect(releaseClaimMock).toHaveBeenCalledWith('occ-pay-1', 30);
    expect(insertNextMock).not.toHaveBeenCalled();
  });

  it('cancelled series caught in flight: marks cancelled (not completed)', async () => {
    claimInProgressMock.mockResolvedValue([occBase]);
    findSeriesMock.mockResolvedValue({
      id: 's-rem-1',
      tipo: 'one_shot_reminder',
      status: 'cancelled',
      version: 2,
      staleness_threshold_hours: 24,
      missed_run_policy: 'fire_latest_only',
      month_end_policy: 'skip_invalid_month',
      exclusive_per_destinatario: false,
      owner_pessoa_id: 'owner-id',
      rrule: null,
    });

    const { runSchedulingTick } = await import('../../src/scheduling/engine.js');
    await runSchedulingTick();

    // Cancelled — not completed/fired.
    expect(setStatusMock).toHaveBeenCalledWith(occBase.id, 'cancelled');
    expect(
      setStatusMock.mock.calls.find((c) => c[1] === 'completed'),
    ).toBeUndefined();
  });

  it('with the SQL fix in place, claim returns empty for non-outreach in_progress (normal happy path)', async () => {
    // This is the prod-shaped scenario: the SQL claim no longer surfaces
    // `one_shot_reminder` rows at all. The engine completes the tick
    // without touching the reminder — outbox-drain alone owns completion.
    claimInProgressMock.mockResolvedValue([]);
    const { runSchedulingTick } = await import('../../src/scheduling/engine.js');
    const r = await runSchedulingTick();
    expect(r.in_progress_advanced).toBe(0);
    expect(setStatusMock).not.toHaveBeenCalled();
    expect(releaseClaimMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });
});
