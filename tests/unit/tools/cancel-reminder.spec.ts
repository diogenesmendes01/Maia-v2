import { describe, it, expect, vi, beforeEach } from 'vitest';

const getByKeyMock = vi.fn();
const upsertMock = vi.fn();

vi.mock('../../../src/db/repositories.js', () => ({
  factsRepo: {
    getByKey: getByKeyMock,
    upsert: upsertMock,
  },
}));

vi.mock('../../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  getByKeyMock.mockReset();
  upsertMock.mockReset();
  upsertMock.mockResolvedValue({ id: 'fact-row' });
});

const ctx = {
  pessoa: { id: 'p1' },
  conversa: { id: 'c1' },
  scope: { entidades: [], byEntity: new Map() },
  mensagem_id: 'm1',
  request_id: 'r1',
  idempotency_key: 'ik1',
} as never;

describe('cancel_reminder tool', () => {
  it('returns not_found when the fact does not exist', async () => {
    getByKeyMock.mockResolvedValue(null);
    const { cancelReminderTool } = await import('../../../src/tools/cancel-reminder.js');
    const result = await cancelReminderTool.handler({ reminder_id: 'rem-x' }, ctx);
    expect(result).toEqual({ cancelled: false, reason: 'not_found' });
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('returns already_fired when the reminder already fired', async () => {
    getByKeyMock.mockResolvedValue({
      escopo: 'pessoa:p1',
      chave: 'reminder.rem-x',
      valor: {
        id: 'rem-x',
        pessoa_id: 'p1',
        quando: '2026-01-01T00:00:00Z',
        texto: 'X',
        fired_at: '2026-01-02T00:00:00Z',
      },
      fonte: 'configurado',
    });
    const { cancelReminderTool } = await import('../../../src/tools/cancel-reminder.js');
    const result = await cancelReminderTool.handler({ reminder_id: 'rem-x' }, ctx);
    expect(result).toEqual({ cancelled: false, reason: 'already_fired' });
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('returns already_cancelled when the reminder was cancelled previously', async () => {
    getByKeyMock.mockResolvedValue({
      escopo: 'pessoa:p1',
      chave: 'reminder.rem-y',
      valor: {
        id: 'rem-y',
        pessoa_id: 'p1',
        quando: '2026-01-01T00:00:00Z',
        texto: 'Y',
        fired_at: '2026-01-01T12:00:00Z',
        cancel_reason: 'owner_request',
      },
      fonte: 'configurado',
    });
    const { cancelReminderTool } = await import('../../../src/tools/cancel-reminder.js');
    const result = await cancelReminderTool.handler({ reminder_id: 'rem-y' }, ctx);
    expect(result).toEqual({ cancelled: false, reason: 'already_cancelled' });
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('cancels happy path: writes fired_at + cancel_reason and reports success', async () => {
    getByKeyMock.mockResolvedValue({
      escopo: 'pessoa:p1',
      chave: 'reminder.rem-z',
      valor: {
        id: 'rem-z',
        pessoa_id: 'p1',
        quando: '2027-01-01T00:00:00Z',
        texto: 'Z',
      },
      fonte: 'configurado',
    });
    const { cancelReminderTool } = await import('../../../src/tools/cancel-reminder.js');
    const result = await cancelReminderTool.handler({ reminder_id: 'rem-z' }, ctx);
    expect(result).toEqual({ cancelled: true });
    expect(upsertMock).toHaveBeenCalledTimes(1);
    const arg = upsertMock.mock.calls[0]![0] as { valor: Record<string, unknown> };
    expect(arg.valor.fired_at).toBeTypeOf('string');
    expect(arg.valor.cancel_reason).toBe('owner_request');
  });
});
