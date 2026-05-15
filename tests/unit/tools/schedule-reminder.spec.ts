import { describe, it, expect, vi, beforeEach } from 'vitest';

const createWithFirstOccurrenceMock = vi.fn();
vi.mock('../../../src/scheduling/repos.js', () => ({
  seriesRepo: { createWithFirstOccurrence: createWithFirstOccurrenceMock },
}));

const auditMock = vi.fn();
vi.mock('../../../src/governance/audit.js', () => ({ audit: auditMock }));

vi.mock('../../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  createWithFirstOccurrenceMock.mockReset();
  auditMock.mockReset();
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

describe('schedule_reminder tool (spec 18)', () => {
  it('happy path: creates a one_shot_reminder series with an occurrence + reminder task', async () => {
    const scheduled = '2027-01-15T09:00:00Z';
    createWithFirstOccurrenceMock.mockResolvedValue({
      series: { id: 'series-1', tipo: 'one_shot_reminder' },
      occurrence: { id: 'occ-1', scheduled_for: new Date(scheduled) },
      tasks: [{ id: 'task-1', ordem: 1, kind: 'fire_reminder' }],
    });
    const { scheduleReminderTool } = await import('../../../src/tools/schedule-reminder.js');
    const result = await scheduleReminderTool.handler(
      {
        entidade_id: E1,
        quando: scheduled,
        texto: 'Pagar Vivo',
        canal: 'whatsapp',
      } as never,
      ctx,
    );
    expect(result.series_id).toBe('series-1');
    expect(result.occurrence_id).toBe('occ-1');
    expect(result.scheduled_for).toBe(new Date(scheduled).toISOString());

    expect(createWithFirstOccurrenceMock).toHaveBeenCalledTimes(1);
    const arg = createWithFirstOccurrenceMock.mock.calls[0]![0] as {
      tipo: string;
      one_shot_at: Date;
      contexto_template: { texto: string };
      initial_occurrence: {
        scheduled_for: Date;
        contexto_snapshot: { texto: string };
        tasks: Array<{ kind: string }>;
      };
    };
    expect(arg.tipo).toBe('one_shot_reminder');
    expect(arg.contexto_template.texto).toBe('Pagar Vivo');
    expect(arg.initial_occurrence.tasks.map((t) => t.kind)).toEqual(['fire_reminder']);

    // Audit fired for series_created + occurrence_scheduled.
    const actions = auditMock.mock.calls.map((c) => (c[0] as { acao: string }).acao);
    expect(actions).toContain('series_created');
    expect(actions).toContain('occurrence_scheduled');
  });

  it('schema invalid: empty texto rejected by zod', async () => {
    const { scheduleReminderTool } = await import('../../../src/tools/schedule-reminder.js');
    const parsed = scheduleReminderTool.input_schema.safeParse({
      quando: '2027-01-15T09:00:00Z',
      texto: '',
    });
    expect(parsed.success).toBe(false);
    expect(createWithFirstOccurrenceMock).not.toHaveBeenCalled();
  });

  it('flags warn_far_future when quando > 1 year ahead', async () => {
    createWithFirstOccurrenceMock.mockResolvedValue({
      series: { id: 's' },
      occurrence: { id: 'o', scheduled_for: new Date('2030-01-01T00:00:00Z') },
      tasks: [],
    });
    const { scheduleReminderTool } = await import('../../../src/tools/schedule-reminder.js');
    const result = await scheduleReminderTool.handler(
      { quando: '2030-01-01T00:00:00Z', texto: 'X', canal: 'whatsapp' } as never,
      ctx,
    );
    expect(result.warn_far_future).toBe(true);
  });
});
