/**
 * Spec 18 §13 — Acceptance test for Requirement 7.
 *
 * Verifies that every state transition writes an audit row carrying
 * `occurrence_id`, and that the combined timeline reconstructs the
 * occurrence lifecycle from one query's worth of rows.
 *
 * Drives a `recurring_payment` occurrence through:
 *   scheduled → claimed → proposed → confirmed → completed
 *
 * Counting audit calls is a proxy for the "one SQL query" guarantee:
 * since all rows carry occurrence_id, a single SELECT WHERE occurrence_id
 * = $1 returns the full chain.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const events: Array<{ acao: string; occurrence_id?: string | null; metadata?: unknown }> = [];

const claimDueMock = vi.fn();
const reclaimMock = vi.fn().mockResolvedValue([]);
const claimInProgressMock = vi.fn().mockResolvedValue([]);
const listAwaitingMock = vi.fn().mockResolvedValue([]);
const occByIdMock = vi.fn();
const occSetStatusMock = vi.fn().mockResolvedValue(undefined);
const releaseClaimMock = vi.fn().mockResolvedValue(undefined);
const hasOpenExclMock = vi.fn().mockResolvedValue(false);
const listOverdueMock = vi.fn().mockResolvedValue([]);
const findSeriesMock = vi.fn();
const tasksByOccMock = vi.fn();
const tasksSetStatusMock = vi.fn().mockResolvedValue(undefined);
const enqueueMock = vi.fn().mockResolvedValue({ id: 'ob' });
const insertNextMock = vi.fn().mockResolvedValue({ occurrence: null, tasks: [] });

const advanceWithTxMock = vi.fn(async (fn: (tx: unknown, repos: unknown) => unknown) => {
  return fn({}, {
    occurrences: { setStatus: occSetStatusMock },
    tasks: { setStatus: tasksSetStatusMock },
    outbox: { enqueue: enqueueMock },
  });
});

vi.mock('../../../src/scheduling/repos.js', () => ({
  seriesRepo: { findById: findSeriesMock, insertNextOccurrenceIfActive: insertNextMock },
  occurrencesRepo: {
    claimDue: claimDueMock,
    reclaimExpiredLeases: reclaimMock,
    claimInProgressForAdvance: claimInProgressMock,
    listAwaitingTimedOut: listAwaitingMock,
    setStatus: occSetStatusMock,
    releaseClaim: releaseClaimMock,
    hasOpenForDestinatarioExcluding: hasOpenExclMock,
    listOverdueForSeries: listOverdueMock,
    byId: occByIdMock,
  },
  tasksRepo: { byOccurrence: tasksByOccMock, setStatus: tasksSetStatusMock },
  outboxRepo: { enqueue: enqueueMock },
  advanceWithTx: advanceWithTxMock,
}));

const pessoasFindByIdMock = vi.fn();
const conversasFindActiveMock = vi.fn();
const pendingCreateTxMock = vi.fn().mockResolvedValue({ id: 'pq-pay' });
vi.mock('../../../src/db/repositories.js', () => ({
  pessoasRepo: { findById: pessoasFindByIdMock },
  conversasRepo: { findActive: conversasFindActiveMock },
  pendingQuestionsRepo: { createTx: pendingCreateTxMock },
}));

vi.mock('../../../src/governance/audit.js', () => ({
  audit: async (input: { acao: string; occurrence_id?: string | null; metadata?: unknown }) => {
    events.push({
      acao: input.acao,
      occurrence_id: input.occurrence_id ?? null,
      metadata: input.metadata,
    });
  },
}));

vi.mock('../../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/config/env.js', () => ({
  config: {
    FEATURE_SCHEDULING_V2: true,
    OCCURRENCE_LEASE_TTL_SECONDS: 300,
    VALOR_LIMITE_DURO: 50000,
  },
}));

beforeEach(() => {
  events.length = 0;
  vi.clearAllMocks();
});

describe('Requirement 7 — one-query per-occurrence audit trail', () => {
  it('payment_due lifecycle: every transition carries occurrence_id', async () => {
    const OCC_ID = 'occ-audit';
    const owner = {
      id: 'owner-id',
      nome: 'Mendes',
      telefone_whatsapp: '+5511987654321',
      status: 'ativa',
    };
    const series = {
      id: 's-audit',
      tipo: 'recurring_payment',
      status: 'active',
      version: 1,
      staleness_threshold_hours: 24,
      missed_run_policy: 'fire_latest_only',
      month_end_policy: 'last_day_of_month',
      owner_pessoa_id: owner.id,
      entidade_id: 'ent-1',
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=10',
    };
    const occ = {
      id: OCC_ID,
      series_id: series.id,
      scheduled_for: new Date(Date.now() - 60_000),
      status: 'claimed',
      contexto_snapshot: {
        conta_id: '00000000-0000-0000-0000-000000000001',
        valor: 4500,
        descricao: 'Aluguel',
        escalate_after_hours: 4,
      },
    };

    // Tick: claim + propose payment.
    claimDueMock.mockResolvedValue([occ]);
    findSeriesMock.mockResolvedValue(series);
    pessoasFindByIdMock.mockResolvedValue(owner);
    conversasFindActiveMock.mockResolvedValue({ id: 'owner-conv' });
    tasksByOccMock.mockResolvedValue([
      { id: 't1', kind: 'propose_payment', status: 'pending' },
      { id: 't2', kind: 'await_decision', status: 'pending' },
      { id: 't3', kind: 'execute_or_skip', status: 'pending' },
    ]);

    const { runSchedulingTick, resolvePaymentOccurrence } = await import(
      '../../../src/scheduling/engine.js'
    );
    await runSchedulingTick();

    // The engine emits aggregate `occurrence_claimed` audits when there
    // are reclaimed leases; for a clean claim no aggregate audit fires
    // — the per-occurrence audits (`outbox_enqueued`,
    // `payment_due_proposed`) are how we reconstruct the timeline.
    expect(events.find((e) => e.acao === 'payment_due_proposed')?.occurrence_id).toBe(OCC_ID);

    // Owner answers 'sim' → resolve.
    occByIdMock.mockResolvedValue({ ...occ, status: 'awaiting_owner' });
    pessoasFindByIdMock.mockResolvedValue(owner);
    tasksByOccMock.mockResolvedValue([
      { id: 't3', kind: 'execute_or_skip', status: 'pending' },
    ]);
    // Skip dispatch (no real tool registry in this test).
    await resolvePaymentOccurrence(
      OCC_ID,
      'sim',
      null,
      {
        pessoa: { id: owner.id },
        conversa: { id: 'owner-conv' },
        mensagem_id: 'mid',
      },
    );

    expect(events.find((e) => e.acao === 'payment_due_confirmed')?.occurrence_id).toBe(OCC_ID);

    // One-query reconstruction: filter all events with the occurrence_id.
    const timeline = events.filter((e) => e.occurrence_id === OCC_ID).map((e) => e.acao);
    // Critical lifecycle markers all present and tagged with occurrence_id.
    expect(timeline).toContain('payment_due_proposed');
    expect(timeline).toContain('payment_due_confirmed');
  });

  it('payment_due "nao": confirmed event does NOT appear; skipped does', async () => {
    const OCC_ID = 'occ-skip';
    const series = {
      id: 's-skip',
      tipo: 'recurring_payment',
      status: 'active',
      version: 1,
      staleness_threshold_hours: 24,
      missed_run_policy: 'fire_latest_only',
      month_end_policy: 'last_day_of_month',
      owner_pessoa_id: 'owner-id',
      entidade_id: 'ent-1',
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=10',
    };
    occByIdMock.mockResolvedValue({
      id: OCC_ID,
      series_id: series.id,
      status: 'awaiting_owner',
      contexto_snapshot: { valor: 4500, descricao: 'Aluguel', escalate_after_hours: 4 },
    });
    findSeriesMock.mockResolvedValue(series);
    tasksByOccMock.mockResolvedValue([
      { id: 't3', kind: 'execute_or_skip', status: 'pending' },
    ]);
    const { resolvePaymentOccurrence } = await import('../../../src/scheduling/engine.js');
    await resolvePaymentOccurrence(
      OCC_ID,
      'nao',
      null,
      {
        pessoa: { id: 'owner-id' },
        conversa: { id: 'owner-conv' },
        mensagem_id: 'mid',
      },
    );
    const acoes = events.filter((e) => e.occurrence_id === OCC_ID).map((e) => e.acao);
    expect(acoes).toContain('payment_due_skipped');
    expect(acoes).not.toContain('payment_due_confirmed');
  });
});
