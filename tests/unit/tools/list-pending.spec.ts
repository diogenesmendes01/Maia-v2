import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `list_pending` reads through the tenant+agent-scoped repo methods (issue
 * #363): `pendingQuestionsRepo.listOpenForPessoa`,
 * `workflowsRepo.listPendingForEntidades`, and
 * `transacoesRepo.listPendingForEntidades`. The direct `db.select()` it used to
 * issue (which had NO tenant predicate) is gone.
 *
 * These behavioral specs mock the three repo methods to return fixed rows so we
 * can assert the handler's MERGE / SHAPE / scope-short-circuit / schema-cap
 * logic in isolation. The CROSS-TENANT isolation guarantee (that each repo
 * read binds tenant_id+agent_id and cannot surface another tenant's rows) is
 * proved against the REAL repo methods in `list-pending-cross-tenant.spec.ts`.
 */

const listOpenForPessoa = vi.fn();
const listPendingWorkflows = vi.fn();
const listPendingTransacoes = vi.fn();

vi.mock('../../../src/db/repositories.js', () => ({
  pendingQuestionsRepo: { listOpenForPessoa },
  workflowsRepo: { listPendingForEntidades: listPendingWorkflows },
  transacoesRepo: { listPendingForEntidades: listPendingTransacoes },
}));

vi.mock('../../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  listOpenForPessoa.mockReset().mockResolvedValue([]);
  listPendingWorkflows.mockReset().mockResolvedValue([]);
  listPendingTransacoes.mockReset().mockResolvedValue([]);
});

const E1 = '00000000-0000-0000-0000-0000000000e1';
const E_OTHER = '00000000-0000-0000-0000-0000000000e9';

const ctx = {
  pessoa: { id: 'p1' },
  conversa: { id: 'c1' },
  scope: { entidades: [E1], byEntity: new Map() },
  mensagem_id: 'm1',
  request_id: 'r1',
  idempotency_key: 'ik1',
} as never;

describe('list_pending tool', () => {
  it('happy path: returns merged perguntas + workflows + transacoes_pendentes', async () => {
    const now = new Date('2026-05-01T12:00:00Z');
    listOpenForPessoa.mockResolvedValue([
      { id: 'pq-1', pergunta: 'Confirma?', created_at: now, expira_em: null, pessoa_id: 'p1' },
    ]);
    listPendingWorkflows.mockResolvedValue([
      {
        id: 'wf-1',
        tipo: 'parse_pdf',
        contexto: { intent: { tool: 'parse_pdf' } },
        iniciado_em: now,
        proxima_acao_em: null,
        entidade_id: E1,
      },
    ]);
    listPendingTransacoes.mockResolvedValue([
      { id: 'tx-1', natureza: 'despesa', descricao: 'Aluguel', valor: '1500.00', created_at: now, entidade_id: E1 },
    ]);

    const { listPendingTool } = await import('../../../src/tools/list-pending.js');
    const out = await listPendingTool.handler({} as never, ctx);

    expect(out.itens).toHaveLength(3);
    expect(out.itens.map((i) => i.kind).sort()).toEqual(
      ['pergunta', 'transacao_pendente', 'workflow'].sort(),
    );
    expect(out.total).toBe(3);
    // The handler delegates to the three scoped repo reads (one per category).
    expect(listOpenForPessoa).toHaveBeenCalledTimes(1);
    expect(listPendingWorkflows).toHaveBeenCalledTimes(1);
    expect(listPendingTransacoes).toHaveBeenCalledTimes(1);
    // pessoa.id + the in-scope entidade are threaded to the scoped reads.
    expect(listOpenForPessoa).toHaveBeenCalledWith('p1', 20);
    expect(listPendingWorkflows).toHaveBeenCalledWith([E1], 20);
    expect(listPendingTransacoes).toHaveBeenCalledWith([E1], 20);
  });

  it('empty result: returns empty itens and total=0', async () => {
    const { listPendingTool } = await import('../../../src/tools/list-pending.js');
    const out = await listPendingTool.handler({} as never, ctx);
    expect(out).toEqual({ itens: [], total: 0 });
  });

  it('scope filter: when entidade_id is outside scope, returns empty without querying', async () => {
    const { listPendingTool } = await import('../../../src/tools/list-pending.js');
    const out = await listPendingTool.handler({ entidade_id: E_OTHER } as never, ctx);
    expect(out).toEqual({ itens: [], total: 0 });
    // short-circuit: the handler returns before issuing any repo read.
    expect(listOpenForPessoa).not.toHaveBeenCalled();
    expect(listPendingWorkflows).not.toHaveBeenCalled();
    expect(listPendingTransacoes).not.toHaveBeenCalled();
  });

  it('schema rejects limit > 50 (cap)', async () => {
    const { listPendingTool } = await import('../../../src/tools/list-pending.js');
    const parsed = listPendingTool.input_schema.safeParse({ limit: 999 });
    expect(parsed.success).toBe(false);
  });

  it('schema rejects non-uuid entidade_id', async () => {
    const { listPendingTool } = await import('../../../src/tools/list-pending.js');
    const parsed = listPendingTool.input_schema.safeParse({ entidade_id: 'not-uuid' });
    expect(parsed.success).toBe(false);
  });
});
