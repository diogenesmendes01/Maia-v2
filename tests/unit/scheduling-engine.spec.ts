import { describe, it, expect, vi, beforeEach } from 'vitest';

const claimDueMock = vi.fn();
const reclaimMock = vi.fn().mockResolvedValue([]);
const setStatusMock = vi.fn().mockResolvedValue(undefined);
const findByIdMock = vi.fn();
const tasksByOccMock = vi.fn();
const tasksSetStatusMock = vi.fn().mockResolvedValue(undefined);
const enqueueMock = vi.fn().mockResolvedValue({ id: 'ob-1' });
const listOverdueMock = vi.fn().mockResolvedValue([]);
const insertNextMock = vi.fn().mockResolvedValue({ occurrence: null, tasks: [] });

vi.mock('../../src/scheduling/repos.js', () => ({
  seriesRepo: { findById: findByIdMock, insertNextOccurrenceIfActive: insertNextMock },
  occurrencesRepo: {
    claimDue: claimDueMock,
    reclaimExpiredLeases: reclaimMock,
    setStatus: setStatusMock,
    listOverdueForSeries: listOverdueMock,
    byId: vi.fn(),
  },
  tasksRepo: { byOccurrence: tasksByOccMock, setStatus: tasksSetStatusMock },
  outboxRepo: { enqueue: enqueueMock },
}));

const pessoasFindByIdMock = vi.fn();
const conversasFindActiveMock = vi.fn();
const pendingCreateMock = vi.fn().mockResolvedValue({ id: 'pq-1' });
vi.mock('../../src/db/repositories.js', () => ({
  pessoasRepo: { findById: pessoasFindByIdMock },
  conversasRepo: { findActive: conversasFindActiveMock },
  pendingQuestionsRepo: { create: pendingCreateMock },
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

beforeEach(() => {
  claimDueMock.mockReset();
  reclaimMock.mockReset().mockResolvedValue([]);
  setStatusMock.mockReset().mockResolvedValue(undefined);
  findByIdMock.mockReset();
  tasksByOccMock.mockReset();
  tasksSetStatusMock.mockReset().mockResolvedValue(undefined);
  enqueueMock.mockReset().mockResolvedValue({ id: 'ob-1' });
  listOverdueMock.mockReset().mockResolvedValue([]);
  insertNextMock.mockReset().mockResolvedValue({ occurrence: null, tasks: [] });
  pessoasFindByIdMock.mockReset();
  conversasFindActiveMock.mockReset();
  pendingCreateMock.mockReset().mockResolvedValue({ id: 'pq-1' });
  auditMock.mockReset();
});

const owner = {
  id: 'owner-id',
  nome: 'Mendes',
  telefone_whatsapp: '+5519989777265',
  status: 'ativa',
};

describe('runSchedulingTick', () => {
  it('one_shot_reminder: enqueues outbox text, moves occurrence to in_progress, audits', async () => {
    claimDueMock.mockResolvedValue([
      {
        id: 'occ-1',
        series_id: 's1',
        scheduled_for: new Date(Date.now() - 60_000),
        status: 'claimed',
        contexto_snapshot: { texto: 'Pagar Vivo', canal: 'whatsapp' },
      },
    ]);
    findByIdMock.mockResolvedValue({
      id: 's1',
      tipo: 'one_shot_reminder',
      status: 'active',
      version: 1,
      staleness_threshold_hours: 24,
      missed_run_policy: 'fire_latest_only',
      owner_pessoa_id: owner.id,
    });
    pessoasFindByIdMock.mockResolvedValue(owner);
    tasksByOccMock.mockResolvedValue([{ id: 't1', kind: 'fire_reminder', status: 'pending' }]);

    const { runSchedulingTick } = await import('../../src/scheduling/engine.js');
    const r = await runSchedulingTick();
    expect(r.advanced).toBe(1);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const enqueued = enqueueMock.mock.calls[0]![0] as { kind: string; payload: { text: string } };
    expect(enqueued.kind).toBe('whatsapp_text');
    expect(enqueued.payload.text).toContain('Pagar Vivo');
    expect(setStatusMock).toHaveBeenCalledWith('occ-1', 'in_progress');
  });

  it('series cancelled mid-claim: occurrence marked cancelled, audit fired (Requirement 5)', async () => {
    claimDueMock.mockResolvedValue([
      {
        id: 'occ-cancel',
        series_id: 's-cancel',
        scheduled_for: new Date(Date.now() - 60_000),
        status: 'claimed',
        contexto_snapshot: {},
      },
    ]);
    findByIdMock.mockResolvedValue({
      id: 's-cancel',
      tipo: 'one_shot_reminder',
      status: 'cancelled',
      version: 2,
      staleness_threshold_hours: 24,
      missed_run_policy: 'fire_latest_only',
      owner_pessoa_id: owner.id,
    });

    const { runSchedulingTick } = await import('../../src/scheduling/engine.js');
    await runSchedulingTick();
    expect(setStatusMock).toHaveBeenCalledWith('occ-cancel', 'cancelled');
    expect(
      auditMock.mock.calls.some(
        (c) => (c[0] as { acao: string }).acao === 'series_cancelled_during_advance',
      ),
    ).toBe(true);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('missed_run_policy=fire_latest_only: older overdue is aged_skipped (Requirement 4)', async () => {
    const oldOcc = {
      id: 'occ-old',
      series_id: 's-monthly',
      scheduled_for: new Date(Date.now() - 5 * 86400_000), // 5 days ago
      status: 'claimed',
      contexto_snapshot: {},
    };
    claimDueMock.mockResolvedValue([oldOcc]);
    findByIdMock.mockResolvedValue({
      id: 's-monthly',
      tipo: 'recurring_payment',
      status: 'active',
      version: 1,
      staleness_threshold_hours: 24,
      missed_run_policy: 'fire_latest_only',
      owner_pessoa_id: owner.id,
    });
    // A more recent overdue sibling exists.
    listOverdueMock.mockResolvedValue([
      {
        id: 'occ-recent',
        series_id: 's-monthly',
        scheduled_for: new Date(Date.now() - 2 * 86400_000),
        status: 'pending',
      },
    ]);

    const { runSchedulingTick } = await import('../../src/scheduling/engine.js');
    await runSchedulingTick();
    // The older one should be aged_skipped.
    expect(setStatusMock).toHaveBeenCalledWith(
      'occ-old',
      'aged_out',
      expect.objectContaining({ outcome: 'aged_out' }),
    );
    expect(
      auditMock.mock.calls.some(
        (c) => (c[0] as { acao: string }).acao === 'occurrence_aged_skipped',
      ),
    ).toBe(true);
  });

  it('recurring_payment with valor above hard limit: rejected at claim (C-008)', async () => {
    claimDueMock.mockResolvedValue([
      {
        id: 'occ-big',
        series_id: 's-big',
        scheduled_for: new Date(Date.now() - 60_000),
        status: 'claimed',
        contexto_snapshot: {
          conta_id: '00000000-0000-0000-0000-000000000001',
          valor: 60000, // above default 50k
          descricao: 'Aluguel mansão',
          escalate_after_hours: 4,
        },
      },
    ]);
    findByIdMock.mockResolvedValue({
      id: 's-big',
      tipo: 'recurring_payment',
      status: 'active',
      version: 1,
      staleness_threshold_hours: 24,
      missed_run_policy: 'fire_latest_only',
      owner_pessoa_id: owner.id,
      entidade_id: 'ent-1',
    });
    pessoasFindByIdMock.mockResolvedValue(owner);

    const { runSchedulingTick } = await import('../../src/scheduling/engine.js');
    await runSchedulingTick();
    expect(setStatusMock).toHaveBeenCalledWith(
      'occ-big',
      'failed',
      expect.objectContaining({ metadata_patch: expect.any(Object) }),
    );
    expect(
      auditMock.mock.calls.some(
        (c) => (c[0] as { acao: string }).acao === 'occurrence_rejected_limit',
      ),
    ).toBe(true);
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});
