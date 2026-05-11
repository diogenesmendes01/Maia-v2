import { describe, it, expect, vi, beforeEach } from 'vitest';

const workflowsCreateMock = vi.fn();
const workflowsByIdMock = vi.fn();
const workflowsSetStatusMock = vi.fn();
const workflowsSetProximaMock = vi.fn();
const stepsCreateManyMock = vi.fn();
const stepsByWorkflowMock = vi.fn();
const pessoasFindByIdMock = vi.fn();
const conversasFindActiveMock = vi.fn();
const pendingCreateMock = vi.fn();

vi.mock('../../src/db/repositories.js', () => ({
  workflowsRepo: {
    create: workflowsCreateMock,
    byId: workflowsByIdMock,
    setStatus: workflowsSetStatusMock,
    setProximaAcaoEm: workflowsSetProximaMock,
  },
  workflowStepsRepo: {
    createMany: stepsCreateManyMock,
    byWorkflow: stepsByWorkflowMock,
  },
  pessoasRepo: {
    findById: pessoasFindByIdMock,
  },
  conversasRepo: {
    findActive: conversasFindActiveMock,
  },
  pendingQuestionsRepo: {
    create: pendingCreateMock,
  },
}));

const dbUpdateChain = {
  set: vi.fn().mockReturnThis(),
  where: vi.fn().mockResolvedValue(undefined),
};
const dbUpdateMock = vi.fn().mockReturnValue(dbUpdateChain);
const dbSelectChain = {
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  limit: vi.fn().mockResolvedValue([]),
};
const dbSelectMock = vi.fn().mockReturnValue(dbSelectChain);
vi.mock('../../src/db/client.js', () => ({
  db: { update: dbUpdateMock, select: dbSelectMock },
}));

const sendOutboundTextMock = vi.fn().mockResolvedValue('WAID');
vi.mock('../../src/gateway/baileys.js', () => ({
  sendOutboundText: sendOutboundTextMock,
}));

const auditMock = vi.fn();
vi.mock('../../src/governance/audit.js', () => ({ audit: auditMock }));

const sendAlertMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/lib/alerts.js', () => ({ sendAlert: sendAlertMock }));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('../../src/lib/brazilian.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/brazilian.js')>(
    '../../src/lib/brazilian.js',
  );
  return actual;
});

beforeEach(() => {
  workflowsCreateMock.mockReset();
  workflowsByIdMock.mockReset();
  workflowsSetStatusMock.mockReset();
  workflowsSetProximaMock.mockReset();
  stepsCreateManyMock.mockReset();
  stepsByWorkflowMock.mockReset();
  pessoasFindByIdMock.mockReset();
  conversasFindActiveMock.mockReset();
  pendingCreateMock.mockReset();
  sendOutboundTextMock.mockReset().mockResolvedValue('WAID');
  auditMock.mockReset();
  sendAlertMock.mockReset();
  sendAlertMock.mockResolvedValue(undefined);
  dbUpdateChain.set.mockClear();
  dbUpdateChain.where.mockClear();
  dbUpdateChain.where.mockResolvedValue(undefined);
  dbSelectChain.limit.mockReset();
  dbSelectChain.limit.mockResolvedValue([]);
});

describe('advancePaymentDue', () => {
  it('Stage 1: posts pending_question, audits, and moves workflow to aguardando_humano', async () => {
    const wf = {
      id: 'wf-1',
      tipo: 'payment_due',
      status: 'pendente',
      contexto: {
        rrule: 'FREQ=MONTHLY;BYMONTHDAY=10',
        conta_id: '00000000-0000-0000-0000-000000000001',
        valor: 4500,
        descricao: 'Aluguel Empresa 3',
        entidade_id: '00000000-0000-0000-0000-000000000002',
        requester_pessoa_id: 'owner-id',
      },
      entidade_id: '00000000-0000-0000-0000-000000000002',
      pessoa_envolvida: 'owner-id',
      proxima_acao_em: new Date(Date.now() - 1000), // due now
      iniciado_em: new Date(),
      concluido_em: null,
      metadata: {},
      chain_id: 'chain-1',
    };
    pessoasFindByIdMock.mockResolvedValue({
      id: 'owner-id',
      nome: 'Mendes',
      telefone_whatsapp: '+5511987654321',
      status: 'ativa',
    });
    conversasFindActiveMock.mockResolvedValue({ id: 'conv-1' });
    stepsByWorkflowMock.mockResolvedValue([
      { id: 's1', ordem: 1, status: 'pendente', resultado: {} },
      { id: 's2', ordem: 2, status: 'pendente', resultado: {} },
      { id: 's3', ordem: 3, status: 'pendente', resultado: {} },
      { id: 's4', ordem: 4, status: 'pendente', resultado: {} },
    ]);
    dbSelectChain.limit.mockResolvedValue([{ resultado: {} }]);

    const { advancePaymentDue } = await import('../../src/workflows/recurring.js');
    const ok = await advancePaymentDue(wf as never);

    expect(ok).toBe(true);
    expect(pendingCreateMock).toHaveBeenCalledTimes(1);
    const pq = pendingCreateMock.mock.calls[0]![0] as {
      tipo: string;
      pergunta: string;
      acao_proposta: { tool: string };
      metadata: { workflow_id: string };
    };
    expect(pq.tipo).toBe('payment_confirmation');
    expect(pq.pergunta).toContain('Aluguel Empresa 3');
    expect(pq.acao_proposta.tool).toBe('register_transaction');
    expect(pq.metadata.workflow_id).toBe('wf-1');
    expect(workflowsSetStatusMock).toHaveBeenCalledWith('wf-1', 'aguardando_humano');
    expect(
      auditMock.mock.calls.some(
        (c) => (c[0] as { acao: string }).acao === 'payment_due_proposed',
      ),
    ).toBe(true);
  });

  it('Expiration: marks workflow falhou + sends alert when escalate window passes', async () => {
    const wf = {
      id: 'wf-2',
      tipo: 'payment_due',
      status: 'aguardando_humano',
      contexto: {
        rrule: 'FREQ=MONTHLY;BYMONTHDAY=10',
        conta_id: '00000000-0000-0000-0000-000000000001',
        valor: 4500,
        descricao: 'Aluguel',
        entidade_id: '00000000-0000-0000-0000-000000000002',
        requester_pessoa_id: 'owner-id',
        escalate_after_hours: 1,
      },
      entidade_id: null,
      pessoa_envolvida: 'owner-id',
      proxima_acao_em: null,
      iniciado_em: new Date(),
      concluido_em: null,
      metadata: {},
      chain_id: 'chain-2',
    };
    // step 1 finished 2 hours ago (past the 1-hour escalate window)
    stepsByWorkflowMock.mockResolvedValue([
      { id: 's1', ordem: 1, status: 'concluido', concluido_em: new Date(Date.now() - 2 * 3600_000) },
    ]);
    const { advancePaymentDue } = await import('../../src/workflows/recurring.js');
    const ok = await advancePaymentDue(wf as never);
    expect(ok).toBe(true);
    expect(workflowsSetStatusMock).toHaveBeenCalledWith('wf-2', 'falhou');
    expect(sendAlertMock).toHaveBeenCalledTimes(1);
    expect(
      auditMock.mock.calls.some(
        (c) => (c[0] as { acao: string }).acao === 'payment_due_unanswered',
      ),
    ).toBe(true);
  });
});

describe('resolvePaymentDue', () => {
  const baseWf = {
    id: 'wf-3',
    tipo: 'payment_due',
    status: 'aguardando_humano',
    contexto: {
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=10',
      requester_pessoa_id: 'owner-id',
      valor: 4500,
      descricao: 'Aluguel',
    },
    entidade_id: null,
    pessoa_envolvida: 'owner-id',
    proxima_acao_em: null,
    iniciado_em: new Date(),
    concluido_em: null,
    metadata: {},
    chain_id: 'chain-3',
  };

  it('decision=sim: audits confirmed + reschedules + closes', async () => {
    workflowsByIdMock.mockResolvedValue(baseWf);
    stepsByWorkflowMock.mockResolvedValue([
      { id: 's1', ordem: 1, status: 'concluido', resultado: {} },
      { id: 's2', ordem: 2, status: 'pendente', resultado: {} },
      { id: 's3', ordem: 3, status: 'pendente', resultado: {} },
      { id: 's4', ordem: 4, status: 'pendente', resultado: {} },
    ]);
    workflowsCreateMock.mockResolvedValue({ id: 'wf-3-next' });
    stepsCreateManyMock.mockResolvedValue([]);
    dbSelectChain.limit.mockResolvedValue([{ resultado: {} }]);

    const { resolvePaymentDue } = await import('../../src/workflows/recurring.js');
    await resolvePaymentDue('wf-3', 'sim');

    expect(
      auditMock.mock.calls.some(
        (c) => (c[0] as { acao: string }).acao === 'payment_due_confirmed',
      ),
    ).toBe(true);
    expect(workflowsCreateMock).toHaveBeenCalledTimes(1); // next cycle created
    expect(workflowsSetStatusMock).toHaveBeenCalledWith('wf-3', 'concluido');
  });

  it('decision=adiar: postpones by 2 days, resets step 1, stays in chain', async () => {
    workflowsByIdMock.mockResolvedValue(baseWf);
    stepsByWorkflowMock.mockResolvedValue([
      { id: 's1', ordem: 1, status: 'concluido', resultado: {} },
      { id: 's3', ordem: 3, status: 'pendente', resultado: {} },
    ]);
    dbSelectChain.limit.mockResolvedValue([{ resultado: {} }]);

    const { resolvePaymentDue } = await import('../../src/workflows/recurring.js');
    await resolvePaymentDue('wf-3', 'adiar');

    expect(workflowsSetProximaMock).toHaveBeenCalledTimes(1);
    const newDate = workflowsSetProximaMock.mock.calls[0]![1] as Date;
    const expected = Date.now() + 2 * 86400_000;
    // Within 60s of expected (test execution clock skew)
    expect(Math.abs(newDate.getTime() - expected)).toBeLessThan(60_000);
    expect(workflowsSetStatusMock).toHaveBeenCalledWith('wf-3', 'pendente');
    expect(
      auditMock.mock.calls.some(
        (c) => (c[0] as { acao: string }).acao === 'payment_due_postponed',
      ),
    ).toBe(true);
  });

  it('decision=nao: audits skipped + reschedules without dispatching', async () => {
    workflowsByIdMock.mockResolvedValue(baseWf);
    stepsByWorkflowMock.mockResolvedValue([
      { id: 's3', ordem: 3, status: 'pendente', resultado: {} },
    ]);
    workflowsCreateMock.mockResolvedValue({ id: 'wf-3-next' });
    stepsCreateManyMock.mockResolvedValue([]);
    dbSelectChain.limit.mockResolvedValue([{ resultado: {} }]);

    const { resolvePaymentDue } = await import('../../src/workflows/recurring.js');
    await resolvePaymentDue('wf-3', 'nao');

    expect(
      auditMock.mock.calls.some(
        (c) => (c[0] as { acao: string }).acao === 'payment_due_skipped',
      ),
    ).toBe(true);
    expect(workflowsCreateMock).toHaveBeenCalledTimes(1);
    expect(workflowsSetStatusMock).toHaveBeenCalledWith('wf-3', 'concluido');
  });
});

describe('advanceOutreach (stage 1 happy path)', () => {
  it('sends initial outreach message, flips to aguardando_terceiro, audits outreach_sent', async () => {
    const wf = {
      id: 'wf-o-1',
      tipo: 'outreach_recorrente',
      status: 'pendente',
      contexto: {
        rrule: 'FREQ=MONTHLY;BYMONTHDAY=5',
        destinatario_pessoa_id: 'mariana-id',
        message_template: 'Oi {{nome}}, o relatório de {{mes_anterior}}?',
        wait_response_hours: 48,
        owner_pessoa_id: 'owner-id',
      },
      entidade_id: null,
      pessoa_envolvida: 'owner-id',
      proxima_acao_em: new Date(Date.now() - 1000),
      iniciado_em: new Date(),
      concluido_em: null,
      metadata: {},
      chain_id: 'chain-o',
    };
    pessoasFindByIdMock.mockResolvedValue({
      id: 'mariana-id',
      nome: 'Mariana',
      telefone_whatsapp: '+5511955555555',
      status: 'ativa',
    });
    stepsByWorkflowMock.mockResolvedValue([
      { id: 's1', ordem: 1, status: 'pendente', resultado: {} },
      { id: 's2', ordem: 2, status: 'pendente', resultado: {} },
    ]);
    dbSelectChain.limit.mockResolvedValue([{ resultado: {} }]);

    const { advanceOutreach } = await import('../../src/workflows/recurring.js');
    const ok = await advanceOutreach(wf as never);

    expect(ok).toBe(true);
    expect(sendOutboundTextMock).toHaveBeenCalledWith(
      '5511955555555@s.whatsapp.net',
      expect.stringContaining('Mariana'),
    );
    expect(workflowsSetStatusMock).toHaveBeenCalledWith('wf-o-1', 'aguardando_terceiro');
    expect(
      auditMock.mock.calls.some(
        (c) => (c[0] as { acao: string }).acao === 'outreach_sent',
      ),
    ).toBe(true);
  });
});
