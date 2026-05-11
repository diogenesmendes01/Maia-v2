/**
 * Spec 18 §13 — Acceptance test for Requirement 6.
 *
 * Two outreach occurrences exist for Mariana (Empresa A + Empresa B).
 * Mariana replies; behaviour depends on whether the correlation token is
 * present:
 *
 *  - Token in reply → router goes straight to the matching occurrence.
 *  - No token → disambiguation pending_question goes to owner; neither
 *    occurrence is auto-advanced. Owner picks A; only that occurrence is
 *    routed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findActiveByCorrelationMock = vi.fn();
const listAwaitingForDestinatarioMock = vi.fn();
const occByIdMock = vi.fn();
const setStatusMock = vi.fn().mockResolvedValue(undefined);
const tasksByOccMock = vi.fn().mockResolvedValue([]);
const tasksSetStatusMock = vi.fn().mockResolvedValue(undefined);
const outboxEnqueueMock = vi.fn().mockResolvedValue({ id: 'ob' });

vi.mock('../../../src/scheduling/repos.js', () => ({
  seriesRepo: {},
  occurrencesRepo: {
    findActiveByCorrelation: findActiveByCorrelationMock,
    listAwaitingForDestinatario: listAwaitingForDestinatarioMock,
    byId: occByIdMock,
    setStatus: setStatusMock,
  },
  tasksRepo: { byOccurrence: tasksByOccMock, setStatus: tasksSetStatusMock },
  outboxRepo: { enqueue: outboxEnqueueMock },
}));

const pessoasFindByIdMock = vi.fn();
const conversasFindActiveMock = vi.fn();
const pendingCreateMock = vi.fn().mockResolvedValue({ id: 'pq-disambig' });
vi.mock('../../../src/db/repositories.js', () => ({
  pessoasRepo: { findById: pessoasFindByIdMock },
  conversasRepo: { findActive: conversasFindActiveMock },
  pendingQuestionsRepo: { create: pendingCreateMock },
}));

const auditMock = vi.fn();
vi.mock('../../../src/governance/audit.js', () => ({ audit: auditMock }));

vi.mock('../../../src/db/client.js', () => ({ db: { update: vi.fn() } }));

vi.mock('../../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const mariana = {
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

beforeEach(() => {
  vi.clearAllMocks();
  pendingCreateMock.mockResolvedValue({ id: 'pq-disambig' });
  outboxEnqueueMock.mockResolvedValue({ id: 'ob' });
});

describe('Requirement 6 — multi-pending disambiguation', () => {
  it('reply with token A4F2 routes directly, no disambiguation', async () => {
    findActiveByCorrelationMock.mockResolvedValue({
      id: 'occ-A',
      contexto_snapshot: {
        destinatario_pessoa_id: 'mariana-id',
        message_template: 'Empresa A',
      },
    });
    tasksByOccMock.mockResolvedValue([
      { id: 'task-await-A', kind: 'await_response', status: 'in_progress' },
    ]);

    const { captureInboundForOutreach } = await import(
      '../../../src/scheduling/disambiguation.js'
    );
    const result = await captureInboundForOutreach({
      sender: mariana as never,
      inbound: {
        id: 'inb-token',
        conteudo: 'Segue o relatório _ref: A4F2_',
      } as never,
      owner_pessoa_id: owner.id,
    });
    expect(result).toEqual({ kind: 'routed', occurrence_id: 'occ-A' });
    // Disambiguation was NOT enqueued.
    expect(pendingCreateMock).not.toHaveBeenCalled();
    // Other occurrences were NOT mutated.
    const setStatusCalls = setStatusMock.mock.calls.filter((c) => c[0] !== 'occ-A');
    expect(setStatusCalls).toHaveLength(0);
  });

  it('reply without token: owner is prompted; neither occurrence auto-advances', async () => {
    findActiveByCorrelationMock.mockResolvedValue(null);
    listAwaitingForDestinatarioMock.mockResolvedValue([
      {
        id: 'occ-A',
        scheduled_for: new Date('2026-05-05T12:00:00Z'),
        contexto_snapshot: {
          destinatario_pessoa_id: 'mariana-id',
          message_template: 'Relatório Empresa A',
        },
      },
      {
        id: 'occ-B',
        scheduled_for: new Date('2026-05-06T12:00:00Z'),
        contexto_snapshot: {
          destinatario_pessoa_id: 'mariana-id',
          message_template: 'Relatório Empresa B',
        },
      },
    ]);
    pessoasFindByIdMock.mockResolvedValue(owner);
    conversasFindActiveMock.mockResolvedValue({ id: 'owner-conv' });

    const { captureInboundForOutreach } = await import(
      '../../../src/scheduling/disambiguation.js'
    );
    const r = await captureInboundForOutreach({
      sender: mariana as never,
      inbound: { id: 'inb-no-token', conteudo: 'segue' } as never,
      owner_pessoa_id: owner.id,
    });
    expect(r).toEqual({ kind: 'disambiguation_requested', pending_question_id: 'pq-disambig' });

    // Auto-route did NOT happen on either candidate.
    expect(setStatusMock).not.toHaveBeenCalled();
    // The disambiguation pending was created with TWO candidates A and B.
    const pq = pendingCreateMock.mock.calls[0]![0] as {
      acao_proposta: { candidates: Array<{ key: string; occurrence_id: string }> };
    };
    expect(pq.acao_proposta.candidates.map((c) => c.occurrence_id).sort()).toEqual([
      'occ-A',
      'occ-B',
    ]);
    // Outbox got the owner notification.
    expect(outboxEnqueueMock).toHaveBeenCalledTimes(1);
    // Audit fired.
    expect(
      auditMock.mock.calls.some(
        (c) => (c[0] as { acao: string }).acao === 'outreach_response_disambiguation_required',
      ),
    ).toBe(true);
  });

  it('owner picks A: applyDisambiguationDecision routes the held response to occ-A only', async () => {
    occByIdMock.mockResolvedValue({
      id: 'occ-A',
      status: 'awaiting_third_party',
      contexto_snapshot: { destinatario_pessoa_id: 'mariana-id' },
    });
    tasksByOccMock.mockResolvedValue([
      { id: 'task-await-A', kind: 'await_response', status: 'in_progress' },
    ]);
    const { applyDisambiguationDecision } = await import(
      '../../../src/scheduling/disambiguation.js'
    );
    const r = await applyDisambiguationDecision({
      pending_question_id: 'pq-disambig',
      chosen_key: 'A',
      acao_proposta: {
        candidates: [
          { key: 'A', occurrence_id: 'occ-A' },
          { key: 'B', occurrence_id: 'occ-B' },
        ],
        inbound_mensagem_id: 'inb-no-token',
        response_text: 'segue',
      },
    });
    expect(r.routed_to).toBe('occ-A');
    expect(setStatusMock).toHaveBeenCalledWith('occ-A', 'in_progress');
    // occ-B never gets advanced.
    const otherCalls = setStatusMock.mock.calls.filter((c) => c[0] === 'occ-B');
    expect(otherCalls).toHaveLength(0);
  });
});
