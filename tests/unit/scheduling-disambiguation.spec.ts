import { describe, it, expect, vi, beforeEach } from 'vitest';

const occByIdMock = vi.fn();
const findActiveByCorrelationMock = vi.fn();
const listAwaitingForDestinatarioMock = vi.fn();
const setStatusMock = vi.fn();
const tasksByOccurrenceMock = vi.fn();
const tasksSetStatusMock = vi.fn();
const outboxEnqueueMock = vi.fn();

vi.mock('../../src/scheduling/repos.js', () => ({
  seriesRepo: {},
  occurrencesRepo: {
    byId: occByIdMock,
    findActiveByCorrelation: findActiveByCorrelationMock,
    listAwaitingForDestinatario: listAwaitingForDestinatarioMock,
    setStatus: setStatusMock,
  },
  tasksRepo: {
    byOccurrence: tasksByOccurrenceMock,
    setStatus: tasksSetStatusMock,
  },
  outboxRepo: { enqueue: outboxEnqueueMock },
}));

const pessoasFindByIdMock = vi.fn();
const conversasFindActiveMock = vi.fn();
const pendingCreateMock = vi.fn();
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

vi.mock('../../src/db/client.js', () => ({ db: { update: vi.fn() } }));

beforeEach(() => {
  occByIdMock.mockReset();
  findActiveByCorrelationMock.mockReset();
  listAwaitingForDestinatarioMock.mockReset();
  setStatusMock.mockReset();
  tasksByOccurrenceMock.mockReset().mockResolvedValue([]);
  tasksSetStatusMock.mockReset();
  outboxEnqueueMock.mockReset();
  pessoasFindByIdMock.mockReset();
  conversasFindActiveMock.mockReset();
  pendingCreateMock.mockReset();
  auditMock.mockReset();
});

const sender = {
  id: 'mariana-id',
  nome: 'Mariana',
  telefone_whatsapp: '+5511955555555',
  status: 'ativa',
};
const owner = {
  id: 'owner-id',
  nome: 'Mendes',
  telefone_whatsapp: '+5519989777265',
  status: 'ativa',
};

describe('captureInboundForOutreach — Requirement 6', () => {
  it('token in reply: routes directly to the matching occurrence', async () => {
    findActiveByCorrelationMock.mockResolvedValue({
      id: 'occ-A',
      contexto_snapshot: { destinatario_pessoa_id: 'mariana-id' },
    });
    tasksByOccurrenceMock.mockResolvedValue([
      { id: 'task-await', kind: 'await_response', status: 'in_progress' },
    ]);
    const { captureInboundForOutreach } = await import(
      '../../src/scheduling/disambiguation.js'
    );
    const result = await captureInboundForOutreach({
      sender: sender as never,
      inbound: { id: 'inb-1', conteudo: 'segue _ref: A4F2_' } as never,
      owner_pessoa_id: 'owner-id',
    });
    expect(result).toEqual({ kind: 'routed', occurrence_id: 'occ-A' });
    expect(setStatusMock).toHaveBeenCalledWith('occ-A', 'in_progress');
  });

  it('no token + single candidate: routes there', async () => {
    findActiveByCorrelationMock.mockResolvedValue(null);
    listAwaitingForDestinatarioMock.mockResolvedValue([
      { id: 'occ-1', contexto_snapshot: { destinatario_pessoa_id: 'mariana-id' } },
    ]);
    tasksByOccurrenceMock.mockResolvedValue([
      { id: 'task-await', kind: 'await_response', status: 'in_progress' },
    ]);
    const { captureInboundForOutreach } = await import(
      '../../src/scheduling/disambiguation.js'
    );
    const result = await captureInboundForOutreach({
      sender: sender as never,
      inbound: { id: 'inb-2', conteudo: 'segue em anexo' } as never,
      owner_pessoa_id: 'owner-id',
    });
    expect(result).toEqual({ kind: 'routed', occurrence_id: 'occ-1' });
  });

  it('no token + multiple candidates: enqueues disambiguation pending_question (no auto-route)', async () => {
    findActiveByCorrelationMock.mockResolvedValue(null);
    listAwaitingForDestinatarioMock.mockResolvedValue([
      {
        id: 'occ-A',
        scheduled_for: new Date('2026-05-05T12:00:00Z'),
        contexto_snapshot: {
          destinatario_pessoa_id: 'mariana-id',
          message_template: 'Oi, relatório Empresa A',
        },
      },
      {
        id: 'occ-B',
        scheduled_for: new Date('2026-05-06T12:00:00Z'),
        contexto_snapshot: {
          destinatario_pessoa_id: 'mariana-id',
          message_template: 'Oi, relatório Empresa B',
        },
      },
    ]);
    pessoasFindByIdMock.mockResolvedValue(owner);
    conversasFindActiveMock.mockResolvedValue({ id: 'owner-conv' });
    pendingCreateMock.mockResolvedValue({ id: 'pq-1' });

    const { captureInboundForOutreach } = await import(
      '../../src/scheduling/disambiguation.js'
    );
    const result = await captureInboundForOutreach({
      sender: sender as never,
      inbound: { id: 'inb-3', conteudo: 'segue' } as never,
      owner_pessoa_id: 'owner-id',
    });
    expect(result).toEqual({
      kind: 'disambiguation_requested',
      pending_question_id: 'pq-1',
    });
    // Auto-route MUST NOT happen.
    expect(setStatusMock).not.toHaveBeenCalled();
    // Pending question was created with both candidates.
    const pq = pendingCreateMock.mock.calls[0]![0] as {
      tipo: string;
      opcoes_validas: Array<{ key: string }>;
      acao_proposta: { candidates: Array<{ key: string; occurrence_id: string }> };
    };
    expect(pq.tipo).toBe('outreach_disambiguation');
    expect(pq.opcoes_validas.map((o) => o.key)).toEqual(['A', 'B']);
    expect(pq.acao_proposta.candidates).toEqual([
      { key: 'A', occurrence_id: 'occ-A' },
      { key: 'B', occurrence_id: 'occ-B' },
    ]);
    // Owner notification went into the outbox (transactional!).
    expect(outboxEnqueueMock).toHaveBeenCalledTimes(1);
    // Audit fired.
    expect(
      auditMock.mock.calls.some(
        (c) =>
          (c[0] as { acao: string }).acao === 'outreach_response_disambiguation_required',
      ),
    ).toBe(true);
  });

  it('token mismatch (different series): falls back to candidate resolution', async () => {
    // Token found but matches an occurrence for OTHER destinatario.
    findActiveByCorrelationMock.mockResolvedValue({
      id: 'occ-other',
      contexto_snapshot: { destinatario_pessoa_id: 'someone-else' },
    });
    // No candidates for this sender → no_match.
    listAwaitingForDestinatarioMock.mockResolvedValue([]);

    const { captureInboundForOutreach } = await import(
      '../../src/scheduling/disambiguation.js'
    );
    const result = await captureInboundForOutreach({
      sender: sender as never,
      inbound: { id: 'inb-4', conteudo: 'algo _ref: ZZZZ_' } as never,
      owner_pessoa_id: 'owner-id',
    });
    expect(result).toEqual({ kind: 'no_match' });
    expect(setStatusMock).not.toHaveBeenCalled();
  });
});
