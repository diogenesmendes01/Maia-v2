import { describe, it, expect, vi, beforeEach } from 'vitest';

const workflowsCreate = vi.fn();
const workflowStepsCreateMany = vi.fn();
const auditMock = vi.fn();

vi.mock('../../../src/db/repositories.js', () => ({
  workflowsRepo: {
    create: workflowsCreate,
  },
  workflowStepsRepo: {
    createMany: workflowStepsCreateMany,
  },
}));

vi.mock('../../../src/governance/audit.js', () => ({ audit: auditMock }));

vi.mock('../../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  workflowsCreate.mockReset();
  workflowStepsCreateMany.mockReset();
  auditMock.mockReset();
});

const E1 = '00000000-0000-0000-0000-0000000000e1';
const E_OUT = '00000000-0000-0000-0000-0000000000ee';

const ctx = {
  pessoa: { id: 'p1' },
  conversa: { id: 'c1' },
  scope: { entidades: [E1], byEntity: new Map() },
  mensagem_id: 'm1',
  request_id: 'r1',
  idempotency_key: 'ik1',
} as never;

describe('start_workflow tool', () => {
  it('happy path: creates workflow + steps and audits reminder_scheduled', async () => {
    workflowsCreate.mockResolvedValueOnce({ id: 'wf-uuid-1' });
    workflowStepsCreateMany.mockResolvedValueOnce([
      { id: 's1' },
      { id: 's2' },
    ]);
    const { startWorkflowTool } = await import('../../../src/tools/start-workflow.js');
    const result = await startWorkflowTool.handler(
      {
        tipo: 'fechamento_mes',
        entidade_id: E1,
        resumo: 'Fechar abril',
        steps: [
          { ordem: 1, descricao: 'Conferir saldos' },
          { ordem: 2, descricao: 'Gerar relatório', tool: 'generate_report', args: { tipo: 'extrato' } },
        ],
      } as never,
      ctx,
    );
    expect(result).toEqual({ workflow_id: 'wf-uuid-1', steps_count: 2 });
    expect(workflowsCreate).toHaveBeenCalledTimes(1);
    const wfArg = workflowsCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(wfArg.tipo).toBe('fechamento_mes');
    expect(wfArg.status).toBe('pendente');
    expect(wfArg.entidade_id).toBe(E1);
    expect(wfArg.pessoa_envolvida).toBe('p1');
    // contexto fills defaults: resumo + requester_pessoa_id.
    expect(wfArg.contexto).toMatchObject({ resumo: 'Fechar abril', requester_pessoa_id: 'p1' });
    expect(wfArg.metadata).toMatchObject({ idempotency_key: 'ik1' });
    expect(wfArg.proxima_acao_em).toBeInstanceOf(Date);

    expect(workflowStepsCreateMany).toHaveBeenCalledTimes(1);
    const stepRows = workflowStepsCreateMany.mock.calls[0]![0] as Array<Record<string, unknown>>;
    expect(stepRows).toHaveLength(2);
    expect(stepRows[0]!).toMatchObject({
      workflow_id: 'wf-uuid-1',
      ordem: 1,
      descricao: 'Conferir saldos',
      status: 'pendente',
    });
    // Step 2 has a tool: resultado must include tool/args/depends_on.
    expect(stepRows[1]!.resultado).toMatchObject({
      tool: 'generate_report',
      args: { tipo: 'extrato' },
      depends_on: [],
    });

    // Audit fires once with action reminder_scheduled.
    const fired = auditMock.mock.calls.find((c) => c[0]?.acao === 'reminder_scheduled');
    expect(fired).toBeTruthy();
    expect(fired![0].alvo_id).toBe('wf-uuid-1');
    expect(fired![0].metadata).toMatchObject({ tipo: 'fechamento_mes', steps: 2 });
  });

  it('schema invalid: rejects unknown tipo', async () => {
    const { startWorkflowTool } = await import('../../../src/tools/start-workflow.js');
    const parsed = startWorkflowTool.input_schema.safeParse({
      tipo: 'tipo_que_nao_existe',
      entidade_id: E1,
      resumo: 'x',
      steps: [{ ordem: 1, descricao: 'a' }],
    });
    expect(parsed.success).toBe(false);
    expect(workflowsCreate).not.toHaveBeenCalled();
  });

  it('rejects when entidade_id is outside caller scope', async () => {
    const { startWorkflowTool } = await import('../../../src/tools/start-workflow.js');
    await expect(
      startWorkflowTool.handler(
        {
          tipo: 'follow_up',
          entidade_id: E_OUT,
          resumo: 'x',
          steps: [{ ordem: 1, descricao: 'a' }],
        } as never,
        ctx,
      ),
    ).rejects.toThrow('entidade fora do escopo');
    expect(workflowsCreate).not.toHaveBeenCalled();
    expect(workflowStepsCreateMany).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });
});
