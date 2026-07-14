/**
 * Spec 18 §13 — Acceptance test for Requirement 1.
 *
 * Simulates a crash between the engine committing the advance transaction
 * (task→in_progress + outbox enqueue) and the outbox-drain sending the
 * WhatsApp message. The next outbox-drain tick must still send.
 *
 * The DB-side guarantee comes from the transactional outbox: the engine
 * commits BOTH the task state advance AND the outbox row in the same
 * transaction. Either both exist post-crash, or neither.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const claimDueMock = vi.fn();
const reclaimOccMock = vi.fn().mockResolvedValue([]);
const claimInProgressMock = vi.fn().mockResolvedValue([]);
const listAwaitingTimedOutMock = vi.fn().mockResolvedValue([]);
const occSetStatusMock = vi.fn().mockResolvedValue(undefined);
const releaseClaimMock = vi.fn().mockResolvedValue(undefined);
const hasOpenExclMock = vi.fn().mockResolvedValue(false);
const listOverdueMock = vi.fn().mockResolvedValue([]);
const findSeriesByIdMock = vi.fn();
const occByIdMock = vi.fn();
const tasksByOccMock = vi.fn();
const tasksSetStatusMock = vi.fn().mockResolvedValue(undefined);

// In-memory outbox simulating the DB. Engine "enqueue" inserts; outbox-drain
// "claimDue" returns rows. We can crash the drain mid-send to test recovery.
type OutboxRow = {
  id: string;
  task_id: string | null;
  occurrence_id: string | null;
  kind: 'whatsapp_text';
  payload: { jid: string; text: string };
  status: 'pending' | 'claimed' | 'sent' | 'failed' | 'dead';
  attempts: number;
  max_attempts: number;
  next_attempt_at: Date;
  dedup_key: string | null;
  sent_at: Date | null;
  last_error: string | null;
  claimed_by: string | null;
  claimed_at: Date | null;
  created_at: Date;
};
const outbox: OutboxRow[] = [];
const dedupSet = new Set<string>();

const outboxEnqueueMock = vi.fn(async (input: {
  occurrence_id?: string | null;
  task_id?: string | null;
  kind: 'whatsapp_text';
  payload: { jid: string; text: string };
  dedup_key?: string | null;
}) => {
  if (input.dedup_key && dedupSet.has(input.dedup_key)) return null;
  if (input.dedup_key) dedupSet.add(input.dedup_key);
  const row: OutboxRow = {
    id: `ob-${outbox.length + 1}`,
    task_id: input.task_id ?? null,
    occurrence_id: input.occurrence_id ?? null,
    kind: input.kind,
    payload: input.payload,
    status: 'pending',
    attempts: 0,
    max_attempts: 5,
    next_attempt_at: new Date(),
    dedup_key: input.dedup_key ?? null,
    sent_at: null,
    last_error: null,
    claimed_by: null,
    claimed_at: null,
    created_at: new Date(),
  };
  outbox.push(row);
  return row;
});
const outboxClaimDueMock = vi.fn(async (_w: string, limit: number) => {
  const due = outbox.filter((r) => r.status === 'pending').slice(0, limit);
  for (const r of due) {
    r.status = 'claimed';
    r.claimed_at = new Date();
  }
  return due;
});
const outboxReclaimMock = vi.fn(async (_w: string, _ttl: number, _l: number) => {
  const expired = outbox.filter((r) => r.status === 'claimed');
  for (const r of expired) {
    r.status = 'pending';
    r.claimed_by = null;
    r.claimed_at = null;
  }
  return expired.map((r) => r.id);
});
const outboxMarkSentMock = vi.fn(async (id: string) => {
  const r = outbox.find((x) => x.id === id);
  if (r) {
    r.status = 'sent';
    r.sent_at = new Date();
  }
});
const outboxMarkFailedRetryableMock = vi.fn(async (id: string, err: string, backoff: number) => {
  const r = outbox.find((x) => x.id === id);
  if (r) {
    r.status = 'pending';
    r.last_error = err;
    r.attempts += 1;
    r.next_attempt_at = new Date(Date.now() + backoff * 1000);
    r.claimed_by = null;
    r.claimed_at = null;
  }
});
const outboxMarkDeadMock = vi.fn(async (id: string, err: string) => {
  const r = outbox.find((x) => x.id === id);
  if (r) {
    r.status = 'dead';
    r.last_error = err;
  }
});
const outboxReturnToPendingMock = vi.fn(async (id: string) => {
  const r = outbox.find((x) => x.id === id);
  if (r) {
    r.status = 'pending';
    r.claimed_by = null;
    r.claimed_at = null;
  }
});

const advanceWithTxMock = vi.fn(async (fn: (tx: unknown, repos: unknown) => unknown) => {
  // Atomic stub: both writes succeed together OR throw (no half-state).
  const repos = {
    occurrences: { setStatus: occSetStatusMock },
    tasks: { setStatus: tasksSetStatusMock },
    outbox: { enqueue: outboxEnqueueMock },
  };
  return fn({}, repos);
});

vi.mock('../../../src/scheduling/repos.js', () => ({
  seriesRepo: {
    findById: findSeriesByIdMock,
    insertNextOccurrenceIfActive: vi.fn(async () => ({ occurrence: null, tasks: [] })),
    listActiveWithoutPendingOccurrence: vi.fn(async () => []),
  },
  occurrencesRepo: {
    claimDue: claimDueMock,
    reclaimExpiredLeases: reclaimOccMock,
    claimInProgressForAdvance: claimInProgressMock,
    listAwaitingTimedOut: listAwaitingTimedOutMock,
    setStatus: occSetStatusMock,
    releaseClaim: releaseClaimMock,
    hasOpenForDestinatarioExcluding: hasOpenExclMock,
    listOverdueForSeries: listOverdueMock,
    byId: occByIdMock,
  },
  tasksRepo: { byOccurrence: tasksByOccMock, setStatus: tasksSetStatusMock },
  outboxRepo: {
    enqueue: outboxEnqueueMock,
    claimDue: outboxClaimDueMock,
    reclaimExpiredLeases: outboxReclaimMock,
    markSent: outboxMarkSentMock,
    markFailedRetryable: outboxMarkFailedRetryableMock,
    markDead: outboxMarkDeadMock,
    returnToPending: outboxReturnToPendingMock,
  },
  advanceWithTx: advanceWithTxMock,
}));

const pessoasFindByIdMock = vi.fn();
vi.mock('../../../src/db/repositories.js', () => ({
  pessoasRepo: { findById: pessoasFindByIdMock },
  conversasRepo: { findActive: vi.fn() },
  pendingQuestionsRepo: { createTx: vi.fn() },
}));

const sendOutboundTextMock = vi.fn();
vi.mock('../../../src/gateway/baileys.js', () => ({
  sendOutboundText: sendOutboundTextMock,
  isBaileysConnected: () => true,
}));

const tryAcquireMock = vi.fn().mockResolvedValue({ kind: 'allow' });
vi.mock('../../../src/scheduling/backpressure.js', () => ({
  tryAcquireSendSlot: tryAcquireMock,
  releasePaceKey: vi.fn().mockResolvedValue(undefined),
}));

const sendAlertMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../src/lib/alerts.js', () => ({ sendAlert: sendAlertMock }));

const auditMock = vi.fn();
vi.mock('../../../src/governance/audit.js', () => ({ audit: auditMock }));

vi.mock('../../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/config/env.js', () => ({
  config: {
    FEATURE_SCHEDULING_V2: true,
    OUTBOX_WORKER_CONCURRENCY: 2,
    OUTBOX_LEASE_TTL_SECONDS: 300,
    OCCURRENCE_LEASE_TTL_SECONDS: 300,
    VALOR_LIMITE_DURO: 50000,
  },
}));

beforeEach(() => {
  outbox.length = 0;
  dedupSet.clear();
  vi.clearAllMocks();
  tryAcquireMock.mockResolvedValue({ kind: 'allow' });
});

describe('Requirement 1 — outbox never loses a message', () => {
  it('engine + outbox-drain crash recovery: message still delivered on next tick', async () => {
    const owner = {
      id: 'owner-id',
      nome: 'Mendes',
      telefone_whatsapp: '+5511987654321',
      status: 'ativa',
    };
    claimDueMock.mockResolvedValue([
      {
        id: 'occ-1',
        series_id: 's-1',
        scheduled_for: new Date(Date.now() - 60_000),
        status: 'claimed',
        contexto_snapshot: { texto: 'Pagar Vivo', canal: 'whatsapp' },
      },
    ]);
    findSeriesByIdMock.mockResolvedValue({
      id: 's-1',
      tipo: 'one_shot_reminder',
      status: 'active',
      version: 1,
      staleness_threshold_hours: 168,
      missed_run_policy: 'fire_latest_only',
      owner_pessoa_id: owner.id,
    });
    pessoasFindByIdMock.mockResolvedValue(owner);
    tasksByOccMock.mockResolvedValue([{ id: 't-1', kind: 'fire_reminder', status: 'pending' }]);

    // Step 1: engine tick → enqueues the outbox row inside one tx.
    const { runSchedulingTick } = await import('../../../src/scheduling/engine.js');
    await runSchedulingTick();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.status).toBe('pending');
    expect(outbox[0]!.payload.text).toContain('Pagar Vivo');

    // Step 2: outbox-drain tick #1 — send THROWS (simulating crash mid-send).
    sendOutboundTextMock.mockRejectedValueOnce(new Error('baileys crashed'));
    const { runOutboxDrain } = await import('../../../src/scheduling/outbox-drain.js');
    await runOutboxDrain();
    // Send was attempted, but failed. Row is back to pending with attempts=1.
    expect(outbox[0]!.status).toBe('pending');
    expect(outbox[0]!.attempts).toBe(1);
    expect(outbox[0]!.last_error).toContain('baileys crashed');

    // Step 3: outbox-drain tick #2 — send succeeds. Reset next_attempt_at to now.
    outbox[0]!.next_attempt_at = new Date();
    sendOutboundTextMock.mockResolvedValueOnce('WAID-OK');
    await runOutboxDrain();
    expect(outbox[0]!.status).toBe('sent');
    expect(outbox[0]!.sent_at).not.toBeNull();
  });

  it('crash between engine advance commit and outbox claim: next tick picks up pending', async () => {
    const owner = {
      id: 'owner-id',
      nome: 'Mendes',
      telefone_whatsapp: '+5511987654321',
      status: 'ativa',
    };
    claimDueMock.mockResolvedValue([
      {
        id: 'occ-2',
        series_id: 's-2',
        scheduled_for: new Date(Date.now() - 60_000),
        status: 'claimed',
        contexto_snapshot: { texto: 'Apenas teste', canal: 'whatsapp' },
      },
    ]);
    findSeriesByIdMock.mockResolvedValue({
      id: 's-2',
      tipo: 'one_shot_reminder',
      status: 'active',
      version: 1,
      staleness_threshold_hours: 168,
      missed_run_policy: 'fire_latest_only',
      owner_pessoa_id: owner.id,
    });
    pessoasFindByIdMock.mockResolvedValue(owner);
    tasksByOccMock.mockResolvedValue([{ id: 't-2', kind: 'fire_reminder', status: 'pending' }]);

    const { runSchedulingTick } = await import('../../../src/scheduling/engine.js');
    await runSchedulingTick();
    expect(outbox).toHaveLength(1);
    // Simulate process killed between engine commit and outbox-drain. Row
    // sits `pending`. Restart: a fresh outbox-drain still claims and sends.
    sendOutboundTextMock.mockResolvedValueOnce('WAID-RECOVERED');
    const { runOutboxDrain } = await import('../../../src/scheduling/outbox-drain.js');
    await runOutboxDrain();
    expect(outbox[0]!.status).toBe('sent');
  });

  it('dedup_key prevents double-send when engine tick fires twice', async () => {
    // Engine retries the same advance (e.g. lease was reclaimed). The second
    // enqueue with the same dedup_key must be a no-op — DB-side UNIQUE
    // partial index does this; our in-memory stub mirrors the behaviour.
    const owner = {
      id: 'owner-id',
      nome: 'Mendes',
      telefone_whatsapp: '+5511987654321',
      status: 'ativa',
    };
    const occ = {
      id: 'occ-3',
      series_id: 's-3',
      scheduled_for: new Date(Date.now() - 60_000),
      status: 'claimed',
      contexto_snapshot: { texto: 'Dedup', canal: 'whatsapp' },
    };
    claimDueMock
      .mockResolvedValueOnce([occ])
      .mockResolvedValueOnce([occ]); // same row, re-claimed after lease reaper
    findSeriesByIdMock.mockResolvedValue({
      id: 's-3',
      tipo: 'one_shot_reminder',
      status: 'active',
      version: 1,
      staleness_threshold_hours: 168,
      missed_run_policy: 'fire_latest_only',
      owner_pessoa_id: owner.id,
    });
    pessoasFindByIdMock.mockResolvedValue(owner);
    tasksByOccMock.mockResolvedValue([{ id: 't-3', kind: 'fire_reminder', status: 'pending' }]);

    const { runSchedulingTick } = await import('../../../src/scheduling/engine.js');
    await runSchedulingTick();
    await runSchedulingTick();
    expect(outbox).toHaveLength(1); // dedup_key collapsed the second insert
  });
});
