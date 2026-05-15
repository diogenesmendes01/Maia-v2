/**
 * Review 2 — Blocker 1: payment_due must NOT audit `payment_due_confirmed`
 * when the dispatch returns `{ error }` (forbidden, dual_approval, etc.)
 * or throws. The occurrence is parked as `failed` and the operator is
 * alerted; the next cycle is NOT scheduled.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const byIdMock = vi.fn();
const setStatusMock = vi.fn().mockResolvedValue(undefined);
const findSeriesMock = vi.fn();
const tasksByOccMock = vi.fn();
const tasksSetStatusMock = vi.fn().mockResolvedValue(undefined);
const enqueueMock = vi.fn().mockResolvedValue({ id: 'ob' });
const insertNextMock = vi.fn().mockResolvedValue({ occurrence: null, tasks: [] });

vi.mock('../../src/scheduling/repos.js', () => ({
  seriesRepo: { findById: findSeriesMock, insertNextOccurrenceIfActive: insertNextMock },
  occurrencesRepo: { byId: byIdMock, setStatus: setStatusMock },
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

const dispatchToolMock = vi.fn();
vi.mock('../../src/tools/_dispatcher.js', () => ({
  dispatchTool: dispatchToolMock,
}));

vi.mock('../../src/governance/permissions.js', () => ({
  resolveScope: vi.fn().mockResolvedValue({ entidades: [], byEntity: new Map() }),
}));

vi.mock('../../src/lib/utils.js', () => ({ uuid: () => 'req-1' }));

const auditMock = vi.fn();
vi.mock('../../src/governance/audit.js', () => ({ audit: auditMock }));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('../../src/config/env.js', () => ({
  config: { FEATURE_SCHEDULING_V2: true, VALOR_LIMITE_DURO: 50000 },
}));

const owner = {
  id: 'owner-id',
  nome: 'Mendes',
  telefone_whatsapp: '+5511987654321',
  status: 'ativa',
};
const series = {
  id: 's-pay',
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
  id: 'occ-pay',
  series_id: series.id,
  status: 'awaiting_owner',
  contexto_snapshot: { valor: 4500, descricao: 'Aluguel', escalate_after_hours: 4 },
};

beforeEach(() => {
  vi.clearAllMocks();
  setStatusMock.mockResolvedValue(undefined);
  tasksSetStatusMock.mockResolvedValue(undefined);
  enqueueMock.mockResolvedValue({ id: 'ob' });
  insertNextMock.mockResolvedValue({ occurrence: null, tasks: [] });
});

describe('resolvePaymentOccurrence — Blocker 1 (review 2)', () => {
  it('dispatch returns { error }: occurrence marked failed, NO payment_due_confirmed audit, NO next cycle', async () => {
    byIdMock.mockResolvedValue(occ);
    findSeriesMock.mockResolvedValue(series);
    tasksByOccMock.mockResolvedValue([
      { id: 't3', kind: 'execute_or_skip', status: 'pending' },
    ]);
    pessoasFindByIdMock.mockResolvedValue(owner);
    dispatchToolMock.mockResolvedValue({ error: 'forbidden', details: { rule_id: 'C-001' } });

    const { resolvePaymentOccurrence } = await import('../../src/scheduling/engine.js');
    const r = await resolvePaymentOccurrence(
      occ.id,
      'sim',
      { tool: 'register_transaction', args: { valor: 4500 } },
      { pessoa: { id: owner.id }, conversa: { id: 'c1' }, mensagem_id: 'm1' },
    );
    expect(r.dispatched_tool).toBeNull();
    // Occurrence parked as failed.
    expect(setStatusMock).toHaveBeenCalledWith(
      occ.id,
      'failed',
      expect.objectContaining({
        metadata_patch: expect.objectContaining({ dispatch_error: 'forbidden' }),
      }),
    );
    // Task is failed, not completed.
    expect(tasksSetStatusMock).toHaveBeenCalledWith(
      't3',
      'failed',
      expect.objectContaining({ decision: 'sim', dispatch_error: 'forbidden' }),
    );
    // No payment_due_confirmed audit.
    expect(
      auditMock.mock.calls.some(
        (c) => (c[0] as { acao: string }).acao === 'payment_due_confirmed',
      ),
    ).toBe(false);
    // Owner alerted via outbox.
    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'whatsapp_alert',
        dedup_key: `${occ.id}:dispatch_failure_alert`,
      }),
    );
    // No next cycle scheduled.
    expect(insertNextMock).not.toHaveBeenCalled();
  });

  it('dispatch throws: same failure-handling path, no confirmed audit', async () => {
    byIdMock.mockResolvedValue(occ);
    findSeriesMock.mockResolvedValue(series);
    tasksByOccMock.mockResolvedValue([
      { id: 't3', kind: 'execute_or_skip', status: 'pending' },
    ]);
    pessoasFindByIdMock.mockResolvedValue(owner);
    dispatchToolMock.mockRejectedValue(new Error('redis_down'));

    const { resolvePaymentOccurrence } = await import('../../src/scheduling/engine.js');
    const r = await resolvePaymentOccurrence(
      occ.id,
      'sim',
      { tool: 'register_transaction', args: {} },
      { pessoa: { id: owner.id }, conversa: { id: 'c1' }, mensagem_id: 'm1' },
    );
    expect(r.dispatched_tool).toBeNull();
    expect(setStatusMock).toHaveBeenCalledWith(
      occ.id,
      'failed',
      expect.any(Object),
    );
    expect(
      auditMock.mock.calls.some(
        (c) => (c[0] as { acao: string }).acao === 'payment_due_confirmed',
      ),
    ).toBe(false);
    expect(insertNextMock).not.toHaveBeenCalled();
  });

  it('dispatch succeeds with no error key: full confirm path runs', async () => {
    byIdMock.mockResolvedValue(occ);
    findSeriesMock.mockResolvedValue(series);
    tasksByOccMock.mockResolvedValue([
      { id: 't3', kind: 'execute_or_skip', status: 'pending' },
    ]);
    pessoasFindByIdMock.mockResolvedValue(owner);
    dispatchToolMock.mockResolvedValue({ transacao_id: 't-uuid', saldo_apos: 100 });

    const { resolvePaymentOccurrence } = await import('../../src/scheduling/engine.js');
    const r = await resolvePaymentOccurrence(
      occ.id,
      'sim',
      { tool: 'register_transaction', args: { valor: 4500 } },
      { pessoa: { id: owner.id }, conversa: { id: 'c1' }, mensagem_id: 'm1' },
    );
    expect(r.dispatched_tool).toBe('register_transaction');
    expect(tasksSetStatusMock).toHaveBeenCalledWith(
      't3',
      'completed',
      expect.objectContaining({ decision: 'sim' }),
    );
    expect(setStatusMock).toHaveBeenCalledWith(occ.id, 'completed', { outcome: 'sim' });
    expect(
      auditMock.mock.calls.some(
        (c) => (c[0] as { acao: string }).acao === 'payment_due_confirmed',
      ),
    ).toBe(true);
    expect(insertNextMock).toHaveBeenCalledTimes(1);
  });
});
