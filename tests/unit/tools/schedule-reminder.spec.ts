import { describe, it, expect, vi, beforeEach } from 'vitest';

const factsUpsertMock = vi.fn();

vi.mock('../../../src/db/repositories.js', () => ({
  factsRepo: {
    upsert: factsUpsertMock,
  },
}));

vi.mock('../../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  factsUpsertMock.mockReset();
  factsUpsertMock.mockResolvedValue({ id: 'fact-row' });
});

const E1 = '00000000-0000-0000-0000-0000000000e1';

const ctx = {
  pessoa: { id: 'p1' },
  conversa: { id: 'c1' },
  scope: { entidades: [E1], byEntity: new Map() },
  mensagem_id: 'm1',
  request_id: 'r1',
  idempotency_key: 'ik1',
} as never;

describe('schedule_reminder tool', () => {
  it('happy path: upserts a reminder fact under pessoa scope and returns reminder_id + quando', async () => {
    const { scheduleReminderTool } = await import('../../../src/tools/schedule-reminder.js');
    const result = await scheduleReminderTool.handler(
      {
        entidade_id: E1,
        quando: '2027-01-15T09:00:00Z',
        texto: 'Lembrar de pagar boleto',
        canal: 'whatsapp',
      } as never,
      ctx,
    );
    expect(result.quando).toBe('2027-01-15T09:00:00Z');
    expect(result.reminder_id).toMatch(/^rem-/);

    expect(factsUpsertMock).toHaveBeenCalledTimes(1);
    const arg = factsUpsertMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.escopo).toBe('pessoa:p1');
    expect(arg.chave).toBe(`reminder.${result.reminder_id}`);
    expect(arg.fonte).toBe('configurado');
    const valor = arg.valor as Record<string, unknown>;
    expect(valor.id).toBe(result.reminder_id);
    expect(valor.pessoa_id).toBe('p1');
    expect(valor.entidade_id).toBe(E1);
    expect(valor.quando).toBe('2027-01-15T09:00:00Z');
    expect(valor.texto).toBe('Lembrar de pagar boleto');
    expect(valor.canal).toBe('whatsapp');
  });

  it('schema invalid: rejects empty texto', async () => {
    const { scheduleReminderTool } = await import('../../../src/tools/schedule-reminder.js');
    const parsed = scheduleReminderTool.input_schema.safeParse({
      quando: '2027-01-15T09:00:00Z',
      texto: '',
    });
    expect(parsed.success).toBe(false);
    expect(factsUpsertMock).not.toHaveBeenCalled();
  });

  it('reminder id is a v4 UUID (not Math.random) prefixed with "rem-" and unique per call', async () => {
    const { scheduleReminderTool } = await import('../../../src/tools/schedule-reminder.js');
    const r1 = await scheduleReminderTool.handler(
      { quando: '2027-02-01T10:00:00Z', texto: 'A', canal: 'whatsapp' } as never,
      ctx,
    );
    const r2 = await scheduleReminderTool.handler(
      { quando: '2027-02-01T11:00:00Z', texto: 'B', canal: 'whatsapp' } as never,
      ctx,
    );
    // Each call gets a fresh randomUUID — values must differ.
    expect(r1.reminder_id).not.toBe(r2.reminder_id);
    // Strip the "rem-" prefix and assert v4 UUID shape.
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(r1.reminder_id.replace(/^rem-/, '')).toMatch(uuidRegex);
    expect(r2.reminder_id.replace(/^rem-/, '')).toMatch(uuidRegex);
  });
});
