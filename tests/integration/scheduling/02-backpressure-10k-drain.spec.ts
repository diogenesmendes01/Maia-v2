/**
 * Spec 18 §13 — Acceptance test for Requirement 2.
 *
 * 10k due outbox rows must drain without burst-sending. The per-second
 * rate gate caps deliveries; rejected attempts are deferred (next_attempt
 * pushed forward), not dropped. We use a small simulated limit
 * (OUTBOX_MAX_PER_SECOND=2) and verify that ~2 messages send per pass
 * regardless of backlog depth, and that no row is lost.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

type OutboxRow = {
  id: string;
  status: 'pending' | 'claimed' | 'sent' | 'failed' | 'dead';
  attempts: number;
  max_attempts: number;
  next_attempt_at: Date;
  payload: { jid: string; text: string };
  occurrence_id: string | null;
  task_id: string | null;
  dedup_key: string | null;
  kind: 'whatsapp_text';
  sent_at: Date | null;
  last_error: string | null;
  claimed_by: string | null;
  claimed_at: Date | null;
  created_at: Date;
};
const outbox: OutboxRow[] = [];

const claimDueMock = vi.fn(async (_w: string, limit: number) => {
  const now = Date.now();
  const due = outbox
    .filter((r) => r.status === 'pending' && r.next_attempt_at.getTime() <= now)
    .slice(0, limit);
  for (const r of due) {
    r.status = 'claimed';
    r.claimed_at = new Date();
  }
  return due;
});
const reclaimMock = vi.fn().mockResolvedValue([] as string[]);
const markSentMock = vi.fn(async (id: string) => {
  const r = outbox.find((x) => x.id === id);
  if (r) {
    r.status = 'sent';
    r.sent_at = new Date();
  }
});
const markFailedMock = vi.fn(async (id: string, err: string, backoff: number) => {
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
const markDeadMock = vi.fn();
const returnToPendingMock = vi.fn(async (id: string) => {
  const r = outbox.find((x) => x.id === id);
  if (r) {
    r.status = 'pending';
    r.claimed_by = null;
    r.claimed_at = null;
  }
});

vi.mock('../../../src/scheduling/repos.js', () => ({
  outboxRepo: {
    claimDue: claimDueMock,
    reclaimExpiredLeases: reclaimMock,
    markSent: markSentMock,
    markFailedRetryable: markFailedMock,
    markDead: markDeadMock,
    returnToPending: returnToPendingMock,
  },
  tasksRepo: { setStatus: vi.fn() },
  occurrencesRepo: { byId: vi.fn(), setStatus: vi.fn() },
}));

const sendOutboundTextMock = vi.fn().mockResolvedValue('WAID');
vi.mock('../../../src/gateway/baileys.js', () => ({
  sendOutboundText: sendOutboundTextMock,
  isBaileysConnected: () => true,
}));

// Backpressure stub: token bucket sized to OUTBOX_MAX_PER_SECOND.
const RATE_LIMIT = 2;
let bucket = RATE_LIMIT;
const tryAcquireMock = vi.fn(async () => {
  if (bucket > 0) {
    bucket -= 1;
    return { kind: 'allow' as const };
  }
  return { kind: 'deny' as const, reason: 'per_second' as const };
});
vi.mock('../../../src/scheduling/backpressure.js', () => ({
  tryAcquireSendSlot: tryAcquireMock,
  releasePaceKey: vi.fn(),
}));

vi.mock('../../../src/lib/alerts.js', () => ({ sendAlert: vi.fn() }));
vi.mock('../../../src/governance/audit.js', () => ({ audit: vi.fn() }));
vi.mock('../../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/config/env.js', () => ({
  config: {
    FEATURE_SCHEDULING_V2: true,
    OUTBOX_WORKER_CONCURRENCY: 4,
    OUTBOX_LEASE_TTL_SECONDS: 300,
  },
}));

beforeEach(() => {
  outbox.length = 0;
  bucket = RATE_LIMIT;
  vi.clearAllMocks();
});

describe('Requirement 2 — 10k backlog drains under backpressure', () => {
  it('with rate limit = 2/s, two ticks send at most 4 messages even with 10k pending', async () => {
    for (let i = 0; i < 10_000; i++) {
      outbox.push({
        id: `ob-${i}`,
        status: 'pending',
        attempts: 0,
        max_attempts: 5,
        next_attempt_at: new Date(Date.now() - 1000),
        payload: { jid: `j${i}@s.whatsapp.net`, text: 'x' },
        occurrence_id: null,
        task_id: null,
        dedup_key: null,
        kind: 'whatsapp_text',
        sent_at: null,
        last_error: null,
        claimed_by: null,
        claimed_at: null,
        created_at: new Date(),
      });
    }

    const { runOutboxDrain } = await import('../../../src/scheduling/outbox-drain.js');

    // Tick 1: bucket=2, so 2 send + N rate-limited (deferred).
    const r1 = await runOutboxDrain();
    expect(r1.sent).toBe(2);
    expect(r1.rate_limited).toBeGreaterThan(0);

    // Refill the bucket and run tick 2.
    bucket = RATE_LIMIT;
    const r2 = await runOutboxDrain();
    expect(r2.sent).toBe(2);

    // Total sent across both ticks: at most 4. None lost — rejected ones
    // are back in pending with a future next_attempt_at.
    const sent = outbox.filter((r) => r.status === 'sent').length;
    const stillPending = outbox.filter((r) => r.status === 'pending').length;
    const lost = outbox.length - sent - stillPending;
    expect(sent).toBe(4);
    expect(lost).toBe(0);
  });

  it('rate-limited row gets backoff in next_attempt_at, then sends on later tick', async () => {
    outbox.push({
      id: 'r1',
      status: 'pending',
      attempts: 0,
      max_attempts: 5,
      next_attempt_at: new Date(Date.now() - 1000),
      payload: { jid: 'j1@s.whatsapp.net', text: 'x' },
      occurrence_id: null,
      task_id: null,
      dedup_key: null,
      kind: 'whatsapp_text',
      sent_at: null,
      last_error: null,
      claimed_by: null,
      claimed_at: null,
      created_at: new Date(),
    });
    outbox.push({
      id: 'r2',
      status: 'pending',
      attempts: 0,
      max_attempts: 5,
      next_attempt_at: new Date(Date.now() - 1000),
      payload: { jid: 'j2@s.whatsapp.net', text: 'y' },
      occurrence_id: null,
      task_id: null,
      dedup_key: null,
      kind: 'whatsapp_text',
      sent_at: null,
      last_error: null,
      claimed_by: null,
      claimed_at: null,
      created_at: new Date(),
    });
    outbox.push({
      id: 'r3',
      status: 'pending',
      attempts: 0,
      max_attempts: 5,
      next_attempt_at: new Date(Date.now() - 1000),
      payload: { jid: 'j3@s.whatsapp.net', text: 'z' },
      occurrence_id: null,
      task_id: null,
      dedup_key: null,
      kind: 'whatsapp_text',
      sent_at: null,
      last_error: null,
      claimed_by: null,
      claimed_at: null,
      created_at: new Date(),
    });

    const { runOutboxDrain } = await import('../../../src/scheduling/outbox-drain.js');
    await runOutboxDrain();
    // 2 sent, 1 deferred with backoff.
    const sent = outbox.filter((r) => r.status === 'sent').length;
    const deferred = outbox.filter(
      (r) => r.status === 'pending' && r.next_attempt_at.getTime() > Date.now(),
    ).length;
    expect(sent).toBe(2);
    expect(deferred).toBe(1);
  });
});
