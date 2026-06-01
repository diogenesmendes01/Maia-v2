/**
 * Issue #363 — CROSS-TENANT ISOLATION for the `list_pending` LLM tool.
 *
 * Product invariant (project north star):
 *   "Maias de empresas diferentes NUNCA se comunicam, compartilham dados ou
 *    herdam aprendizado. Sem exceção."
 *
 * The tool is registered for the LLM tool registry and its result
 * (`q.pergunta`, workflow state, transação descriptions) is injected back into
 * the prompt context. Before the fix its three SELECTs filtered ONLY by
 * `pessoa_id` / `entidade_id` (both GLOBAL UUIDs) + status — NOT by
 * `tenant_id`+`agent_id`. So if a `pessoa_id`/`entidade_id` were shared/guessed
 * across tenants, another tenant's pending questions / workflows / pending
 * transações would leak into the LLM context (same R2 LLM-context-contamination
 * class as #357).
 *
 * This spec drives the REAL `list_pending` handler against an in-memory store
 * keyed by tenant (`makeTenantScopedUpdateStore`) whose SELECT is applied by
 * EVALUATING the handler's ACTUAL drizzle WHERE predicate — so a missing
 * tenant/agent binding is observable as a FOREIGN tenant's row being returned
 * (the exact regression lever), not asserted away with a hand-rolled filter.
 *
 * Each test seeds tenant-A rows that SHARE the queried pessoa_id/entidade_id
 * with tenant-B's running context (the lever: id-only predicates would match
 * them), runs the handler under tenant-B, and asserts:
 *   (1) ZERO of tenant-A's rows are returned (no cross-tenant leak), and
 *   (2) EVERY SELECT's executed WHERE bound BOTH `tenant_id` AND `agent_id`
 *       (revert-check: a refactor that drops either binding fails here even if
 *       the row assertion happened to pass for a given seed).
 *
 * Pre-fix revert-check: against the old id-only predicate the shared-id rows
 * match, so assertion (1) fails (tenant-A's pergunta/workflow/transação leak
 * into the result) and assertion (2) fails (no tenant/agent term present).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';
import {
  makeTenantScopedUpdateStore,
  parsePredicate as parsePredicateForTest,
  type StoreRow,
  type TenantScopedUpdateStore,
} from '../workers/_tenant-mutation-store.js';

type Pair = { tenant_id: string; agent_id: string };
// tenant-A appears only as seeded row data (the leak lever); the handler always
// runs under tenant-B's context.
const B: Pair = { tenant_id: 'tenant-B', agent_id: 'agent-B' };

// In-memory, tenant-keyed store standing in for `@/db/client.js`. The REAL
// list_pending handler runs its drizzle SELECTs (via the scoped repo methods)
// against this.
const store: TenantScopedUpdateStore = makeTenantScopedUpdateStore();

vi.mock('@/db/client.js', () => ({
  db: store.db,
  withTx: async (fn: (tx: unknown) => unknown) => fn(store.db),
}));

vi.mock('@/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  store.reset([]);
});

// Both tenants operate on the SAME pessoa_id + entidade_id. These are global
// UUIDs in production (no tenant column), so an id-only predicate cannot tell
// the two tenants' rows apart — only an explicit tenant_id+agent_id WHERE can.
const PESSOA_ID = '00000000-0000-0000-0000-0000000000a1';
const ENTIDADE_ID = '00000000-0000-0000-0000-0000000000e1';

/** Tool ctx: tenant-B's interlocutor, scoped to the SHARED entidade. */
const ctxB = {
  pessoa: { id: PESSOA_ID },
  conversa: { id: 'conv-B' },
  scope: { entidades: [ENTIDADE_ID], byEntity: new Map() },
  mensagem_id: 'm1',
  request_id: 'r1',
  idempotency_key: 'ik1',
} as never;

/** Assert a SELECT predicate bound BOTH tenant + agent for tenant-B. */
function expectBoundTenantAgent(predicate: unknown): void {
  const terms = parsePredicateForTest(predicate);
  expect(terms).toContainEqual({ kind: 'eq', column: 'tenant_id', value: 'tenant-B' });
  expect(terms).toContainEqual({ kind: 'eq', column: 'agent_id', value: 'agent-B' });
}

describe('Issue #363 — list_pending does not leak another tenant\'s rows into LLM context', () => {
  it('pending_questions: tenant-A\'s open question for the SHARED pessoa is NOT returned under tenant-B', async () => {
    store.reset([
      // tenant-A's open question for the shared pessoa — the leak lever.
      {
        id: 'pq-A',
        __table: 'pending_questions',
        tenant_id: 'tenant-A',
        agent_id: 'agent-A',
        status: 'aberta',
        pessoa_id: PESSOA_ID,
        pergunta: 'SEGREDO do tenant A',
        created_at: new Date('2026-05-01T12:00:00Z'),
        expira_em: null,
      } as unknown as StoreRow,
    ]);

    const { listPendingTool } = await import('@/tools/list-pending.js');
    const out = await runWithTenantContext(B, () => listPendingTool.handler({} as never, ctxB));

    // ZERO of tenant-A's rows leak into tenant-B's result.
    expect(out.itens).toHaveLength(0);
    expect(out.total).toBe(0);
    expect(JSON.stringify(out)).not.toContain('SEGREDO');
    // Every executed SELECT bound tenant+agent (revert-check).
    for (const pred of store.selectPredicates()) expectBoundTenantAgent(pred);
  });

  it('workflows: tenant-A\'s in-progress workflow for the SHARED entidade is NOT returned under tenant-B', async () => {
    store.reset([
      {
        id: 'wf-A',
        __table: 'workflows',
        tenant_id: 'tenant-A',
        agent_id: 'agent-A',
        status: 'em_andamento',
        tipo: 'dual_approval',
        entidade_id: ENTIDADE_ID,
        contexto: { intent: { tool: 'segredo_tool' } },
        iniciado_em: new Date('2026-05-01T12:00:00Z'),
        proxima_acao_em: null,
      } as unknown as StoreRow,
    ]);

    const { listPendingTool } = await import('@/tools/list-pending.js');
    const out = await runWithTenantContext(B, () => listPendingTool.handler({} as never, ctxB));

    expect(out.itens).toHaveLength(0);
    expect(out.total).toBe(0);
    expect(JSON.stringify(out)).not.toContain('segredo_tool');
    for (const pred of store.selectPredicates()) expectBoundTenantAgent(pred);
  });

  it('transacoes: tenant-A\'s pending transação for the SHARED entidade is NOT returned under tenant-B', async () => {
    store.reset([
      {
        id: 'tx-A',
        __table: 'transacoes',
        tenant_id: 'tenant-A',
        agent_id: 'agent-A',
        status: 'pendente',
        entidade_id: ENTIDADE_ID,
        natureza: 'despesa',
        descricao: 'Pagamento SECRETO',
        valor: '999.00',
        confirmada_em: null,
        data_competencia: '2026-05-01',
        created_at: new Date('2026-05-01T12:00:00Z'),
      } as unknown as StoreRow,
    ]);

    const { listPendingTool } = await import('@/tools/list-pending.js');
    const out = await runWithTenantContext(B, () => listPendingTool.handler({} as never, ctxB));

    expect(out.itens).toHaveLength(0);
    expect(out.total).toBe(0);
    expect(JSON.stringify(out)).not.toContain('SECRETO');
    for (const pred of store.selectPredicates()) expectBoundTenantAgent(pred);
  });

  it('POSITIVE — tenant-B sees its OWN rows (proves the predicate is not over-filtering)', async () => {
    store.reset([
      // tenant-B's own open question + workflow + pending transação.
      {
        id: 'pq-B',
        __table: 'pending_questions',
        tenant_id: 'tenant-B',
        agent_id: 'agent-B',
        status: 'aberta',
        pessoa_id: PESSOA_ID,
        pergunta: 'pergunta do B',
        created_at: new Date('2026-05-02T12:00:00Z'),
        expira_em: null,
      } as unknown as StoreRow,
      {
        id: 'wf-B',
        __table: 'workflows',
        tenant_id: 'tenant-B',
        agent_id: 'agent-B',
        status: 'em_andamento',
        tipo: 'parse_pdf',
        entidade_id: ENTIDADE_ID,
        contexto: {},
        iniciado_em: new Date('2026-05-02T12:00:00Z'),
        proxima_acao_em: null,
      } as unknown as StoreRow,
      {
        id: 'tx-B',
        __table: 'transacoes',
        tenant_id: 'tenant-B',
        agent_id: 'agent-B',
        status: 'pendente',
        entidade_id: ENTIDADE_ID,
        natureza: 'receita',
        descricao: 'recebimento do B',
        valor: '10.00',
        confirmada_em: null,
        data_competencia: '2026-05-02',
        created_at: new Date('2026-05-02T12:00:00Z'),
      } as unknown as StoreRow,
      // tenant-A noise that MUST NOT appear.
      {
        id: 'pq-A',
        __table: 'pending_questions',
        tenant_id: 'tenant-A',
        agent_id: 'agent-A',
        status: 'aberta',
        pessoa_id: PESSOA_ID,
        pergunta: 'A noise',
        created_at: new Date('2026-05-01T12:00:00Z'),
        expira_em: null,
      } as unknown as StoreRow,
    ]);

    const { listPendingTool } = await import('@/tools/list-pending.js');
    const out = await runWithTenantContext(B, () => listPendingTool.handler({} as never, ctxB));

    const ids = out.itens.map((i) => i.id).sort();
    expect(ids).toEqual(['pq-B', 'tx-B', 'wf-B']);
    expect(JSON.stringify(out)).not.toContain('A noise');
    for (const pred of store.selectPredicates()) expectBoundTenantAgent(pred);
  });
});
