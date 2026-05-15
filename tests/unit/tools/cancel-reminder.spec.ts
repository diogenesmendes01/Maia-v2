import { describe, it, expect, vi, beforeEach } from 'vitest';

const cancelAtomicMock = vi.fn();
vi.mock('../../../src/scheduling/repos.js', () => ({
  seriesRepo: { cancelAtomic: cancelAtomicMock },
}));

const auditMock = vi.fn();
vi.mock('../../../src/governance/audit.js', () => ({ audit: auditMock }));

vi.mock('../../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  cancelAtomicMock.mockReset();
  auditMock.mockReset();
});

const ctx = {
  pessoa: { id: 'owner-id' },
  conversa: { id: 'c1' },
  scope: { entidades: [], byEntity: new Map() },
  mensagem_id: 'm1',
  request_id: 'r1',
  idempotency_key: 'ik1',
} as never;

describe('cancel_reminder tool (spec 18)', () => {
  it('returns not_found when no series matches the id', async () => {
    cancelAtomicMock.mockResolvedValue({ series: null, cancelled_occurrence_ids: [] });
    const { cancelReminderTool } = await import('../../../src/tools/cancel-reminder.js');
    const result = await cancelReminderTool.handler(
      { series_id: '00000000-0000-0000-0000-000000000001' },
      ctx,
    );
    expect(result).toEqual({
      cancelled: false,
      cancelled_occurrence_count: 0,
      reason: 'not_found',
    });
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('returns already_cancelled when atomic cancel found no active series', async () => {
    cancelAtomicMock.mockResolvedValue({
      series: { id: 's1', status: 'cancelled', version: 5 },
      cancelled_occurrence_ids: [],
    });
    const { cancelReminderTool } = await import('../../../src/tools/cancel-reminder.js');
    const result = await cancelReminderTool.handler(
      { series_id: '00000000-0000-0000-0000-000000000001' },
      ctx,
    );
    expect(result).toEqual({
      cancelled: false,
      cancelled_occurrence_count: 0,
      reason: 'already_cancelled',
    });
  });

  it('happy path: returns count of cancelled occurrences and audits', async () => {
    cancelAtomicMock.mockResolvedValue({
      series: { id: 's2', status: 'cancelled', version: 2 },
      cancelled_occurrence_ids: ['o1', 'o2', 'o3'],
    });
    const { cancelReminderTool } = await import('../../../src/tools/cancel-reminder.js');
    const result = await cancelReminderTool.handler(
      { series_id: '00000000-0000-0000-0000-000000000002', reason: 'mudei de ideia' },
      ctx,
    );
    expect(result).toEqual({ cancelled: true, cancelled_occurrence_count: 3 });
    expect(auditMock).toHaveBeenCalledTimes(1);
    const call = auditMock.mock.calls[0]![0] as { acao: string; metadata: { reason: string; cancelled_occurrences: string[] } };
    expect(call.acao).toBe('series_cancelled');
    expect(call.metadata.reason).toBe('mudei de ideia');
    expect(call.metadata.cancelled_occurrences).toEqual(['o1', 'o2', 'o3']);
  });
});
