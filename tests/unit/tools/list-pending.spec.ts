import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * list_pending uses drizzle's fluent query builder directly via
 * `db.select().from(table).where(...).orderBy(...).limit(...)`.
 *
 * We mock `db.select()` to return a chain that records which table was
 * queried, then yields a queue of result arrays in the exact order that the
 * handler calls them: (1) pending_questions, (2) workflows, (3) transacoes.
 *
 * The schema/table tokens are mocked as opaque markers; the handler only
 * needs them to pass through the chain — column accesses are also stubbed.
 */

const fromCalls: unknown[] = [];
const resultsQueue: unknown[][] = [];

const makeChain = () => {
  const chain: Record<string, (...args: unknown[]) => unknown> & { then?: unknown } = {};
  chain.from = (table: unknown) => {
    fromCalls.push(table);
    return chain;
  };
  chain.where = (..._a: unknown[]) => chain;
  chain.orderBy = (..._a: unknown[]) => chain;
  // .limit is awaited — return a thenable that resolves with the next queued
  // result.
  chain.limit = (..._a: unknown[]) => {
    const rows = resultsQueue.shift() ?? [];
    return Promise.resolve(rows);
  };
  return chain;
};

const dbSelect = vi.fn(() => makeChain());

vi.mock('../../../src/db/client.js', () => ({
  db: { select: dbSelect },
}));

// Schema tables: opaque tokens. Column references are proxied so any access
// returns a no-op marker (the handler does eq(table.col, ...) and similar).
const colProxy = new Proxy(
  {},
  {
    get: () => 'col',
  },
);
vi.mock('../../../src/db/schema.js', () => ({
  pending_questions: colProxy,
  workflows: colProxy,
  transacoes: colProxy,
}));

vi.mock('../../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  fromCalls.length = 0;
  resultsQueue.length = 0;
  dbSelect.mockClear();
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
    resultsQueue.push(
      // pending_questions
      [
        {
          id: 'pq-1',
          pergunta: 'Confirma?',
          created_at: now,
          expira_em: null,
          pessoa_id: 'p1',
        },
      ],
      // workflows
      [
        {
          id: 'wf-1',
          tipo: 'parse_pdf',
          contexto: { intent: { tool: 'parse_pdf' } },
          iniciado_em: now,
          proxima_acao_em: null,
          entidade_id: E1,
        },
      ],
      // transacoes pendentes
      [
        {
          id: 'tx-1',
          natureza: 'despesa',
          descricao: 'Aluguel',
          valor: '1500.00',
          created_at: now,
          entidade_id: E1,
        },
      ],
    );

    const { listPendingTool } = await import('../../../src/tools/list-pending.js');
    const out = await listPendingTool.handler({} as never, ctx);

    expect(out.itens).toHaveLength(3);
    expect(out.itens.map((i) => i.kind).sort()).toEqual(
      ['pergunta', 'transacao_pendente', 'workflow'].sort(),
    );
    expect(out.total).toBe(3);
    // 3 SELECTs were issued (one per category)
    expect(dbSelect).toHaveBeenCalledTimes(3);
  });

  it('empty result: returns empty itens and total=0', async () => {
    resultsQueue.push([], [], []);
    const { listPendingTool } = await import('../../../src/tools/list-pending.js');
    const out = await listPendingTool.handler({} as never, ctx);
    expect(out).toEqual({ itens: [], total: 0 });
  });

  it('scope filter: when entidade_id is outside scope, returns empty without querying', async () => {
    const { listPendingTool } = await import('../../../src/tools/list-pending.js');
    const out = await listPendingTool.handler(
      { entidade_id: E_OTHER } as never,
      ctx,
    );
    expect(out).toEqual({ itens: [], total: 0 });
    // short-circuit: the handler returns before issuing any DB query.
    expect(dbSelect).not.toHaveBeenCalled();
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
