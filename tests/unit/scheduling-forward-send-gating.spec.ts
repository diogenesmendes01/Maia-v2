/**
 * Review 2 — Blocker 3: the FORWARD task of a recurring_outreach must
 * stay `in_progress` until `outbox-drain` confirms the send. Engine
 * MUST NOT mark it `completed` right after enqueue. Occurrence finalization
 * + next-cycle scheduling only happen after the task is `completed` (by
 * outbox-drain) or `skipped` (nothing to forward / forward_to inactive).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const claimDueMock = vi.fn().mockResolvedValue([]);
const reclaimMock = vi.fn().mockResolvedValue([]);
const claimInProgressMock = vi.fn();
const listAwaitingTimedOutMock = vi.fn().mockResolvedValue([]);
const occByIdMock = vi.fn();
const setStatusMock = vi.fn().mockResolvedValue(undefined);
const releaseClaimMock = vi.fn().mockResolvedValue(undefined);
const releaseLeaseOnlyMock = vi.fn().mockResolvedValue(undefined);
const hasOpenExclMock = vi.fn().mockResolvedValue(false);
const listOverdueMock = vi.fn().mockResolvedValue([]);
const findSeriesMock = vi.fn();
const tasksByOccMock = vi.fn();
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
    releaseLeaseOnly: releaseLeaseOnlyMock,
    hasOpenForDestinatarioExcluding: hasOpenExclMock,
    listOverdueForSeries: listOverdueMock,
    byId: occByIdMock,
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

const pessoasFindByIdMock = vi.fn();
vi.mock('../../src/db/repositories.js', () => ({
  pessoasRepo: { findById: pessoasFindByIdMock },
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
  id: 'occ-fwd',
  series_id: 's-fwd',
  scheduled_for: new Date(Date.now() - 60_000),
  status: 'in_progress',
  contexto_snapshot: {
    destinatario_pessoa_id: 'mariana-id',
    forward_to_pessoa_id: 'maria-id',
    message_template: 'Pedido',
    forward_template: 'Segue: {{resposta}}',
    wait_response_hours: 48,
  },
};
const seriesBase = {
  id: 's-fwd',
  tipo: 'recurring_outreach',
  status: 'active',
  version: 1,
  staleness_threshold_hours: 24,
  missed_run_policy: 'fire_latest_only',
  month_end_policy: 'skip_invalid_month',
  exclusive_per_destinatario: false,
  owner_pessoa_id: 'owner-id',
  rrule: 'FREQ=MONTHLY;BYMONTHDAY=5',
};

beforeEach(() => {
  vi.clearAllMocks();
  claimDueMock.mockResolvedValue([]);
  reclaimMock.mockResolvedValue([]);
  listAwaitingTimedOutMock.mockResolvedValue([]);
  setStatusMock.mockResolvedValue(undefined);
  releaseClaimMock.mockResolvedValue(undefined);
  releaseLeaseOnlyMock.mockResolvedValue(undefined);
  hasOpenExclMock.mockResolvedValue(false);
  listOverdueMock.mockResolvedValue([]);
  tasksSetStatusMock.mockResolvedValue(undefined);
  enqueueMock.mockResolvedValue({ id: 'ob' });
  insertNextMock.mockResolvedValue({ occurrence: null, tasks: [] });
});

describe('advanceInProgressOccurrence — Blocker 3 (review 2)', () => {
  it('forward pending + response captured: enqueues outbox, leaves task in_progress, does NOT finalize occurrence', async () => {
    claimInProgressMock.mockResolvedValue([occBase]);
    findSeriesMock.mockResolvedValue(seriesBase);
    tasksByOccMock.mockResolvedValue([
      { id: 'tw', kind: 'await_response', status: 'completed', result: { response_text: 'segue em anexo' } },
      { id: 'tf', kind: 'forward', status: 'pending' },
    ]);
    pessoasFindByIdMock.mockResolvedValue({
      id: 'maria-id',
      nome: 'Maria',
      telefone_whatsapp: '+5511999999999',
      status: 'ativa',
    });

    const { runSchedulingTick } = await import('../../src/scheduling/engine.js');
    await runSchedulingTick();

    // Outbox enqueued.
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const enqueued = enqueueMock.mock.calls[0]![0] as { dedup_key: string };
    expect(enqueued.dedup_key).toBe(`${occBase.id}:forward`);
    // Task set to in_progress, NOT completed.
    expect(tasksSetStatusMock).toHaveBeenCalledWith('tf', 'in_progress');
    expect(
      tasksSetStatusMock.mock.calls.find((c) => c[0] === 'tf' && c[1] === 'completed'),
    ).toBeUndefined();
    // Occurrence NOT completed — engine returns 'advanced' early and waits.
    const completedCall = setStatusMock.mock.calls.find(
      (c) => c[0] === occBase.id && c[1] === 'completed',
    );
    expect(completedCall).toBeUndefined();
    // Next cycle NOT scheduled — only happens after forward is confirmed.
    expect(insertNextMock).not.toHaveBeenCalled();
  });

  it('forward task already in_progress (outbox still sending): release LEASE ONLY, keep status=in_progress, do not finalize', async () => {
    // Codex review #105 round-2 (high): MUST use releaseLeaseOnly here.
    // releaseClaim would regress status to `pending`, letting the next
    // pending-path tick re-run the outreach initial step and silently
    // duplicate the send / reset to awaiting_third_party.
    claimInProgressMock.mockResolvedValue([occBase]);
    findSeriesMock.mockResolvedValue(seriesBase);
    tasksByOccMock.mockResolvedValue([
      { id: 'tw', kind: 'await_response', status: 'completed' },
      { id: 'tf', kind: 'forward', status: 'in_progress' },
    ]);

    const { runSchedulingTick } = await import('../../src/scheduling/engine.js');
    await runSchedulingTick();

    expect(releaseLeaseOnlyMock).toHaveBeenCalledWith(occBase.id);
    // Crucial: must NOT call releaseClaim (which would regress to pending).
    expect(releaseClaimMock).not.toHaveBeenCalled();
    expect(setStatusMock.mock.calls.find((c) => c[1] === 'completed')).toBeUndefined();
    expect(insertNextMock).not.toHaveBeenCalled();
  });

  it('forward task completed by outbox-drain: occurrence finalizes + next cycle scheduled', async () => {
    claimInProgressMock.mockResolvedValue([occBase]);
    findSeriesMock.mockResolvedValue(seriesBase);
    tasksByOccMock.mockResolvedValue([
      { id: 'tw', kind: 'await_response', status: 'completed' },
      { id: 'tf', kind: 'forward', status: 'completed' },
    ]);

    const { runSchedulingTick } = await import('../../src/scheduling/engine.js');
    await runSchedulingTick();

    // Now we finalize.
    expect(setStatusMock).toHaveBeenCalledWith(
      occBase.id,
      'completed',
      expect.objectContaining({ outcome: 'forwarded' }),
    );
    expect(insertNextMock).toHaveBeenCalledTimes(1);
    expect(
      auditMock.mock.calls.some(
        (c) => (c[0] as { acao: string }).acao === 'occurrence_completed',
      ),
    ).toBe(true);
  });

  it('forward task skipped (forward_to_inactive): occurrence finalizes with outcome=fired', async () => {
    claimInProgressMock.mockResolvedValue([occBase]);
    findSeriesMock.mockResolvedValue(seriesBase);
    tasksByOccMock.mockResolvedValue([
      { id: 'tw', kind: 'await_response', status: 'completed' },
      { id: 'tf', kind: 'forward', status: 'skipped' },
    ]);

    const { runSchedulingTick } = await import('../../src/scheduling/engine.js');
    await runSchedulingTick();
    expect(setStatusMock).toHaveBeenCalledWith(
      occBase.id,
      'completed',
      expect.objectContaining({ outcome: 'fired' }),
    );
  });

  // Codex review #105 round-2 (high): full regression for delayed forward.
  // Simulates two consecutive ticks: first tick finds forward in_progress
  // and releases lease only. Between ticks, the row REMAINS in_progress
  // (we mock the in-memory occurrence accordingly). Next tick's pending-path
  // (`claimDue`) MUST NOT pick it up because the row's status is still
  // `in_progress`, not `pending` — so the engine never re-runs the initial
  // outreach step. Only `claimInProgressForAdvance` picks it up again,
  // which then re-enters the forward branch.
  it('round-2 regression: delayed forward — lease release keeps status=in_progress so claimDue does NOT see the row, no outreach re-run', async () => {
    // First tick: forward still in_progress → releaseLeaseOnly fires.
    claimInProgressMock.mockResolvedValueOnce([occBase]);
    // claimDue gets no work (since status=in_progress).
    claimDueMock.mockResolvedValue([]);
    findSeriesMock.mockResolvedValue(seriesBase);
    tasksByOccMock.mockResolvedValue([
      { id: 'tw', kind: 'await_response', status: 'completed' },
      { id: 'tf', kind: 'forward', status: 'in_progress' },
    ]);

    const { runSchedulingTick } = await import('../../src/scheduling/engine.js');
    await runSchedulingTick();

    // Lease cleared, status stays in_progress (verified by mock contract).
    expect(releaseLeaseOnlyMock).toHaveBeenCalledTimes(1);
    expect(releaseLeaseOnlyMock).toHaveBeenCalledWith(occBase.id);
    // No pending-path regression: releaseClaim NEVER called.
    expect(releaseClaimMock).not.toHaveBeenCalled();
    // No outreach re-run: outbox not enqueued again (no forward template
    // dispatch + no initial outreach `send_outreach` enqueue).
    expect(enqueueMock).not.toHaveBeenCalled();
    // No status mutations on the occurrence (in particular: not back to
    // awaiting_third_party, completed, failed, etc.).
    expect(setStatusMock).not.toHaveBeenCalled();
    // Next-cycle insert NEVER fires while waiting.
    expect(insertNextMock).not.toHaveBeenCalled();
  });
});
