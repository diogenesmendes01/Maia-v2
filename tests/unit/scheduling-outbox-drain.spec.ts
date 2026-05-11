import { describe, it, expect, vi, beforeEach } from 'vitest';

const outboxClaimDueMock = vi.fn();
// Returns IDs (the reclaim resets rows to 'pending'; claimDue picks them up).
const outboxReclaimExpiredMock = vi.fn().mockResolvedValue([] as string[]);
const outboxMarkSentMock = vi.fn().mockResolvedValue(undefined);
const outboxMarkFailedRetryableMock = vi.fn().mockResolvedValue(undefined);
const outboxMarkDeadMock = vi.fn().mockResolvedValue(undefined);
const outboxReturnToPendingMock = vi.fn().mockResolvedValue(undefined);
const tasksSetStatusMock = vi.fn().mockResolvedValue(undefined);
const occByIdMock = vi.fn();
const occSetStatusMock = vi.fn().mockResolvedValue(undefined);

const tasksByOccMock = vi.fn().mockResolvedValue([]);
vi.mock('../../src/scheduling/repos.js', () => ({
  outboxRepo: {
    claimDue: outboxClaimDueMock,
    reclaimExpiredLeases: outboxReclaimExpiredMock,
    markSent: outboxMarkSentMock,
    markFailedRetryable: outboxMarkFailedRetryableMock,
    markDead: outboxMarkDeadMock,
    returnToPending: outboxReturnToPendingMock,
  },
  tasksRepo: { setStatus: tasksSetStatusMock, byOccurrence: tasksByOccMock },
  occurrencesRepo: { byId: occByIdMock, setStatus: occSetStatusMock },
}));

const sendOutboundTextMock = vi.fn();
const isBaileysConnectedMock = vi.fn().mockReturnValue(true);
vi.mock('../../src/gateway/baileys.js', () => ({
  sendOutboundText: sendOutboundTextMock,
  isBaileysConnected: () => isBaileysConnectedMock(),
}));

const tryAcquireMock = vi.fn();
const releasePaceMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/scheduling/backpressure.js', () => ({
  tryAcquireSendSlot: tryAcquireMock,
  releasePaceKey: releasePaceMock,
}));

const sendAlertMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/lib/alerts.js', () => ({ sendAlert: sendAlertMock }));

const auditMock = vi.fn();
vi.mock('../../src/governance/audit.js', () => ({ audit: auditMock }));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('../../src/config/env.js', () => ({
  config: {
    FEATURE_SCHEDULING_V2: true,
    OUTBOX_WORKER_CONCURRENCY: 2,
    OUTBOX_LEASE_TTL_SECONDS: 300,
  },
}));

const okMsg = (id: string, attempts = 0, max = 5) => ({
  id,
  task_id: 't1',
  occurrence_id: 'o1',
  kind: 'whatsapp_text',
  payload: { jid: 'mariana@s.whatsapp.net', text: 'Oi' },
  status: 'claimed',
  attempts,
  max_attempts: max,
  next_attempt_at: new Date(),
  dedup_key: `${id}:k`,
  sent_at: null,
  last_error: null,
  claimed_by: 'w1',
  claimed_at: new Date(),
  created_at: new Date(),
});

beforeEach(() => {
  outboxClaimDueMock.mockReset();
  outboxMarkSentMock.mockReset().mockResolvedValue(undefined);
  outboxMarkFailedRetryableMock.mockReset().mockResolvedValue(undefined);
  outboxMarkDeadMock.mockReset().mockResolvedValue(undefined);
  outboxReturnToPendingMock.mockReset().mockResolvedValue(undefined);
  tasksSetStatusMock.mockReset().mockResolvedValue(undefined);
  tasksByOccMock.mockReset().mockResolvedValue([
    { id: 't1', kind: 'fire_reminder', status: 'in_progress' },
  ]);
  occByIdMock.mockReset();
  occSetStatusMock.mockReset().mockResolvedValue(undefined);
  sendOutboundTextMock.mockReset();
  isBaileysConnectedMock.mockReset().mockReturnValue(true);
  tryAcquireMock.mockReset();
  releasePaceMock.mockReset().mockResolvedValue(undefined);
  sendAlertMock.mockReset().mockResolvedValue(undefined);
  auditMock.mockReset();
});

describe('runOutboxDrain — Requirement 1 (no message loss) + Requirement 7 (audit)', () => {
  it('sends, marks sent, audits outbox_sent (happy path)', async () => {
    outboxClaimDueMock.mockResolvedValue([okMsg('m1')]);
    tryAcquireMock.mockResolvedValue({ kind: 'allow' });
    sendOutboundTextMock.mockResolvedValue('WAID-1');
    occByIdMock.mockResolvedValue({ id: 'o1', status: 'in_progress' });

    const { runOutboxDrain } = await import('../../src/scheduling/outbox-drain.js');
    const r = await runOutboxDrain();

    expect(r.sent).toBe(1);
    expect(outboxMarkSentMock).toHaveBeenCalledWith('m1');
    expect(auditMock.mock.calls.some((c) => (c[0] as { acao: string }).acao === 'outbox_sent')).toBe(true);
    expect(
      auditMock.mock.calls.some(
        (c) =>
          (c[0] as { acao: string; occurrence_id?: string }).acao === 'outbox_sent' &&
          (c[0] as { occurrence_id?: string }).occurrence_id === 'o1',
      ),
    ).toBe(true);
  });

  it('crash equivalent: send throws → markFailedRetryable, NOT markSent (no message loss)', async () => {
    outboxClaimDueMock.mockResolvedValue([okMsg('m2', 0, 5)]);
    tryAcquireMock.mockResolvedValue({ kind: 'allow' });
    sendOutboundTextMock.mockRejectedValue(new Error('baileys disconnected mid-send'));

    const { runOutboxDrain } = await import('../../src/scheduling/outbox-drain.js');
    await runOutboxDrain();

    expect(outboxMarkSentMock).not.toHaveBeenCalled();
    expect(outboxMarkFailedRetryableMock).toHaveBeenCalledTimes(1);
    expect(
      auditMock.mock.calls.some((c) => (c[0] as { acao: string }).acao === 'outbox_failed'),
    ).toBe(true);
  });

  it('Baileys disconnected: row returned to pending without consuming attempts', async () => {
    isBaileysConnectedMock.mockReturnValue(false);
    outboxClaimDueMock.mockResolvedValue([okMsg('m3')]);
    const { runOutboxDrain } = await import('../../src/scheduling/outbox-drain.js');
    await runOutboxDrain();
    expect(outboxReturnToPendingMock).toHaveBeenCalledWith('m3');
    expect(outboxMarkFailedRetryableMock).not.toHaveBeenCalled();
    expect(outboxMarkSentMock).not.toHaveBeenCalled();
  });

  it('rate gate denies: deferred with backoff, no send attempted', async () => {
    outboxClaimDueMock.mockResolvedValue([okMsg('m4')]);
    tryAcquireMock.mockResolvedValue({ kind: 'deny', reason: 'per_second' });
    const { runOutboxDrain } = await import('../../src/scheduling/outbox-drain.js');
    const r = await runOutboxDrain();
    expect(sendOutboundTextMock).not.toHaveBeenCalled();
    expect(outboxMarkFailedRetryableMock).toHaveBeenCalledWith(
      'm4',
      'rate_limit:per_second',
      1,
    );
    expect(r.rate_limited).toBe(1);
  });

  it('attempts at max-1 → another failure marks dead, alert sent', async () => {
    outboxClaimDueMock.mockResolvedValue([okMsg('m5', 4, 5)]);
    tryAcquireMock.mockResolvedValue({ kind: 'allow' });
    sendOutboundTextMock.mockRejectedValue(new Error('boom'));

    const { runOutboxDrain } = await import('../../src/scheduling/outbox-drain.js');
    await runOutboxDrain();

    expect(outboxMarkDeadMock).toHaveBeenCalledWith('m5', 'boom');
    expect(sendAlertMock).toHaveBeenCalledTimes(1);
    expect(
      auditMock.mock.calls.some((c) => (c[0] as { acao: string }).acao === 'outbox_dead'),
    ).toBe(true);
  });

  it('Requirement 7: every successful send audits with occurrence_id', async () => {
    outboxClaimDueMock.mockResolvedValue([okMsg('m6')]);
    tryAcquireMock.mockResolvedValue({ kind: 'allow' });
    sendOutboundTextMock.mockResolvedValue('WAID');
    occByIdMock.mockResolvedValue({ id: 'o1', status: 'in_progress' });
    const { runOutboxDrain } = await import('../../src/scheduling/outbox-drain.js');
    await runOutboxDrain();
    const sentAudit = auditMock.mock.calls.find(
      (c) => (c[0] as { acao: string }).acao === 'outbox_sent',
    );
    expect(sentAudit).toBeDefined();
    expect((sentAudit![0] as { occurrence_id: string }).occurrence_id).toBe('o1');
  });
});
