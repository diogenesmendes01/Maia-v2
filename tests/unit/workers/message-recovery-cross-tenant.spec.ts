/**
 * Issue #345 (Phase 4 of #323) — Cross-tenant isolation invariant for the
 * `message-recovery` worker.
 *
 * Product invariant (project north star):
 *   "Maias de empresas diferentes NUNCA se comunicam, compartilham dados ou
 *    herdam aprendizado. Sem exceção."
 *
 * Worker-specific contract this spec PROVES (after the #345 fix):
 *
 *   1. `runMessageRecovery` is a DISPATCHER that enumerates the DISTINCT
 *      (tenant_id, agent_id) tuples owning a stuck inbound message
 *      (`mensagensRepo.listTenantAgentPairsWithUnprocessedOlderThan`) and runs
 *      the inner ONCE PER tuple inside `runWithTenantContext`.
 *
 *   2. The hardcoded `default/default` shim is GONE — when real tuples exist the
 *      inner never runs under `default`.
 *
 *   3. Behavior-preserving in single-tenant mode; empty enumeration → no-op;
 *      fail-isolated per tuple.
 *
 *   4. READ ISOLATION (the test that proves the inner is scoped): the inner reads
 *      via `mensagensRepo.listUnprocessedOlderThan`, whose drizzle `.select()`
 *      WHERE clause binds the ALS `tenant_id` AND `agent_id`. Running the inner
 *      under tenant-A therefore reads ONLY tenant-A/agent-A's stuck rows — proved
 *      by capturing the REAL repo's `.where(...)` predicate and asserting it
 *      contains `eq(tenant_id, 'tenant-A')` AND `eq(agent_id, 'agent-A')`, and by
 *      a store-backed read that returns ONLY the rows matching that predicate so
 *      a tenant-B row is never handed to `enqueueAgent`.
 *
 *   (There is no inner mutation to scope: `enqueueAgent({ mensagem_id })` only
 *    pushes the id onto the queue — the row is never written here.)
 *
 * Strategy: the DISPATCH-routing block mocks the enumeration helper and
 * `listUnprocessedOlderThan` (capturing the live context). The READ-ISOLATION
 * block keeps the REAL `mensagensRepo.listUnprocessedOlderThan` (via
 * `importOriginal`) and backs it with a `db.select` mock that (a) captures the
 * bound predicate and (b) filters seeded rows by tenant/agent, so only the
 * running tuple's rows reach `enqueueAgent`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext, tryGetCurrentContext } from '@/db/tenant-context.js';

type Pair = { tenant_id: string; agent_id: string };

/** A parsed equality term `eq(col, value)`. */
type EqTerm = { column: string; value: unknown };

/**
 * Recursively collect every `eq(col, value)` term from a drizzle predicate,
 * tolerating (skipping) `isNull(...)` and raw `sql\`…\`` fragments the
 * `listUnprocessedOlderThan` WHERE also contains. drizzle emits each `eq` as a
 * nested SQL node whose chunks are `[StringChunk, Column, StringChunk(" = "),
 * Param, StringChunk]`; an `and(...)` wraps child SQL nodes. We descend into
 * nested SQL and, for any node carrying BOTH a Column and a Param, record the
 * pair. Anything else is ignored (so this never throws on the non-eq terms).
 */
function extractEqTerms(predicate: unknown): EqTerm[] {
  const out: EqTerm[] = [];
  const ctor = (o: unknown) => (o as { constructor?: { name?: string } } | null)?.constructor?.name;
  const isSql = (o: unknown) =>
    ctor(o) === 'SQL' && Array.isArray((o as { queryChunks?: unknown[] }).queryChunks);
  const isParam = (o: unknown) => ctor(o) === 'Param';
  const isColumn = (o: unknown) => {
    const c = ctor(o);
    return (
      typeof (o as { name?: unknown })?.name === 'string' &&
      c !== 'SQL' &&
      c !== 'StringChunk' &&
      c !== 'Param'
    );
  };
  const visit = (node: unknown): void => {
    if (!isSql(node)) return;
    const chunks = (node as { queryChunks: unknown[] }).queryChunks;
    const col = chunks.find(isColumn) as { name?: string } | undefined;
    const param = chunks.find(isParam) as { value?: unknown } | undefined;
    if (col?.name && param) {
      out.push({ column: col.name, value: param.value });
    }
    for (const c of chunks) if (isSql(c)) visit(c);
  };
  visit(predicate);
  return out;
}

let enumeratedPairs: Pair[] = [];
/** Context active each time the inner read fires. */
const contextsSeen: Pair[] = [];
let throwForTuple: Set<string> = new Set();

const {
  enqueueAgentMock,
  listPairsMock,
  listUnprocessedMock,
  listTurnPairsMock,
  findRecoverableMock,
  noteTurnQueuedMock,
  flags,
} = vi.hoisted(() => ({
  enqueueAgentMock: vi.fn(async () => undefined),
  listPairsMock: vi.fn(),
  listUnprocessedMock: vi.fn(),
  listTurnPairsMock: vi.fn(),
  findRecoverableMock: vi.fn(),
  noteTurnQueuedMock: vi.fn(async () => undefined),
  /**
   * #504 — o REGIME é escolha EXPLÍCITA do teste, nunca o default do contrato.
   *
   * `runMessageRecovery` tem dois inners e escolhe por `turnStateAuthoritative()`.
   * Enquanto este arquivo herdava o default, ele provava a isolação de tenant
   * em UM inner só — e, quando o default virou `true` na #504, provou no
   * inner errado e quebrou. O contrato afirmado aqui (fan-out por tupla,
   * ausência do sentinel `default/default`, fail-isolation) vale nos DOIS, e
   * agora é exercitado nos dois.
   */
  flags: { authoritative: true },
}));

class QueueRedisUnavailableError extends Error {
  readonly code = 'QUEUE_REDIS_UNAVAILABLE';
  readonly oom: boolean;
  constructor(opts?: { oom?: boolean }) {
    super('test queue unavailable');
    this.name = 'QueueRedisUnavailableError';
    this.oom = opts?.oom ?? false;
  }
}

vi.mock('@/gateway/queue.js', () => ({
  enqueueAgent: enqueueAgentMock,
  QueueRedisUnavailableError,
}));

vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// === Store-backed db.select for the READ-ISOLATION block ===
// `listUnprocessedOlderThan` issues `db.select().from(mensagens).where(pred)
// .orderBy(...).limit(n)`. This mock captures `pred` and returns only the seeded
// rows whose tenant_id/agent_id match the eq-terms in it — so an unscoped SELECT
// would leak other tenants' rows (and the worker would enqueue them).
let storeRows: Array<{ id: string; tenant_id: string; agent_id: string }> = [];
let lastSelectPredicate: unknown = undefined;
const dbSelectMock = vi.fn(() => {
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: (pred: unknown) => {
      lastSelectPredicate = pred;
      return chain;
    },
    orderBy: () => chain,
    limit: async (n: number) => {
      const terms = extractEqTerms(lastSelectPredicate);
      const tEq = terms.find((t) => t.column === 'tenant_id');
      const aEq = terms.find((t) => t.column === 'agent_id');
      return storeRows
        .filter((r) => (!tEq || r.tenant_id === tEq.value) && (!aEq || r.agent_id === aEq.value))
        .slice(0, n);
    },
  };
  return chain;
});

vi.mock('@/db/client.js', () => ({
  db: { select: dbSelectMock },
}));

// Default repo mock for the DISPATCH-routing block (overridden per-block below
// for READ-ISOLATION, which wants the REAL `listUnprocessedOlderThan`).
vi.mock('@/db/repositories.js', () => ({
  mensagensRepo: {
    listTenantAgentPairsWithUnprocessedOlderThan: listPairsMock,
    listUnprocessedOlderThan: listUnprocessedMock,
  },
  agentTurnsRepo: {
    listTenantAgentPairsWithRecoverableTurns: listTurnPairsMock,
    findRecoverableTurns: findRecoverableMock,
  },
}));

vi.mock('@/runtime/turns/index.js', () => ({
  turnStateAuthoritative: () => flags.authoritative,
  turnStateMachineEnabled: () => true,
  noteTurnQueued: noteTurnQueuedMock,
  reportLegacyProjectionDivergence: vi.fn(async () => null),
}));

const A: Pair = { tenant_id: 'tenant-A', agent_id: 'agent-A' };
const B: Pair = { tenant_id: 'tenant-B', agent_id: 'agent-B' };
const DEFAULT: Pair = { tenant_id: 'default', agent_id: 'default' };

beforeEach(() => {
  enumeratedPairs = [];
  contextsSeen.length = 0;
  throwForTuple = new Set();
  storeRows = [];
  lastSelectPredicate = undefined;
  enqueueAgentMock.mockReset();
  enqueueAgentMock.mockResolvedValue(undefined);
  listPairsMock.mockReset();
  listPairsMock.mockImplementation(async () => enumeratedPairs);
  listTurnPairsMock.mockReset();
  listTurnPairsMock.mockImplementation(async () => enumeratedPairs);
  noteTurnQueuedMock.mockReset();
  noteTurnQueuedMock.mockResolvedValue(undefined);
  // Default inner read: record the active context, return nothing (loop no-op).
  // Os DOIS inners recebem o mesmo recorder, porque o que este arquivo afirma —
  // "a leitura de dentro roda sob o contexto da tupla enumerada, e só dela" —
  // é a mesma afirmação nos dois regimes.
  const innerRead = async (): Promise<never[]> => {
    const ctx = tryGetCurrentContext();
    if (!ctx) {
      throw new Error('inner read ran outside tenant context — repo would throw in prod');
    }
    contextsSeen.push({ tenant_id: ctx.tenant_id, agent_id: ctx.agent_id });
    const key = `${ctx.tenant_id}|${ctx.agent_id}`;
    if (throwForTuple.has(key)) throw new Error(`synthetic message-recovery failure for ${key}`);
    return [];
  };
  listUnprocessedMock.mockReset();
  listUnprocessedMock.mockImplementation(innerRead);
  findRecoverableMock.mockReset();
  findRecoverableMock.mockImplementation(innerRead);
  dbSelectMock.mockClear();
});

/** Enumeração do regime corrente — é ela que o dispatcher chama. */
const enumerationMock = () => (flags.authoritative ? listTurnPairsMock : listPairsMock);
/** Leitura do inner do regime corrente. */
const innerReadMock = () => (flags.authoritative ? findRecoverableMock : listUnprocessedMock);

for (const regime of [
  { label: 'AUTORITATIVO (padrão desde #504)', authoritative: true },
  { label: 'LEGADO (caminho de rollback emergencial)', authoritative: false },
] as const) {
describe(`Issue #345 — runMessageRecovery is per-tenant scoped (no default/default leak) — ${regime.label}`, () => {
  beforeEach(() => {
    flags.authoritative = regime.authoritative;
  });

  it('MULTI-TENANT — inner runs once per enumerated tuple under its own context', async () => {
    enumeratedPairs = [A, B];

    const { runMessageRecovery } = await import('@/workers/message-recovery.js');
    await runMessageRecovery();

    expect(enumerationMock()).toHaveBeenCalledTimes(1);
    expect(contextsSeen).toHaveLength(2);
    const seen = new Set(contextsSeen.map((c) => `${c.tenant_id}|${c.agent_id}`));
    expect(seen).toEqual(new Set(['tenant-A|agent-A', 'tenant-B|agent-B']));
  });

  it('NO default/default — inner never runs under the legacy sentinel when real tuples exist', async () => {
    enumeratedPairs = [A, B];

    const { runMessageRecovery } = await import('@/workers/message-recovery.js');
    await runMessageRecovery();

    for (const c of contextsSeen) {
      expect(c.tenant_id).not.toBe('default');
      expect(c.agent_id).not.toBe('default');
    }
  });

  it('SINGLE-TENANT PRESERVED — only (default,default) enumerated → inner runs once under default', async () => {
    enumeratedPairs = [DEFAULT];

    const { runMessageRecovery } = await import('@/workers/message-recovery.js');
    await runMessageRecovery();

    expect(contextsSeen).toEqual([DEFAULT]);
  });

  it('EMPTY enumeration → no-op (inner read never fires)', async () => {
    enumeratedPairs = [];

    const { runMessageRecovery } = await import('@/workers/message-recovery.js');
    await runMessageRecovery();

    expect(innerReadMock()).not.toHaveBeenCalled();
    expect(contextsSeen).toHaveLength(0);
  });

  it('FAIL-ISOLATED — a throw under tenant-A does not abort tenant-B', async () => {
    enumeratedPairs = [A, B];
    throwForTuple = new Set(['tenant-A|agent-A']);

    const { runMessageRecovery } = await import('@/workers/message-recovery.js');
    await expect(runMessageRecovery()).resolves.toBeUndefined();

    const seen = new Set(contextsSeen.map((c) => `${c.tenant_id}|${c.agent_id}`));
    expect(seen).toEqual(new Set(['tenant-A|agent-A', 'tenant-B|agent-B']));
  });

  it('DISPATCHER runs without an ambient tenant context (cron path)', async () => {
    enumeratedPairs = [A];

    const { runMessageRecovery } = await import('@/workers/message-recovery.js');
    await expect(runMessageRecovery()).resolves.toBeUndefined();
    expect(contextsSeen).toEqual([A]);
  });

  it('NOT COUPLED TO CALLER CONTEXT — ambient tenant-A does not override enumerated tenant-B', async () => {
    enumeratedPairs = [B];

    const { runMessageRecovery } = await import('@/workers/message-recovery.js');
    await runWithTenantContext(A, runMessageRecovery);

    expect(contextsSeen).toEqual([B]);
  });

  it('the dispatcher passes the SAME staleness threshold (STUCK_AFTER_MS) to enumeration', async () => {
    enumeratedPairs = [A];

    const { runMessageRecovery } = await import('@/workers/message-recovery.js');
    await runMessageRecovery();

    // STUCK_AFTER_MS = 2 * 60 * 1000. Enumeration must receive it so dispatcher
    // and inner agree on which messages are "stuck".
    expect(enumerationMock()).toHaveBeenCalledWith(2 * 60 * 1000);
  });
});

}

/**
 * READ ISOLATION — drives the REAL `mensagensRepo.listUnprocessedOlderThan`
 * (kept via `importOriginal`) under tuple A against a store seeded with stuck
 * rows for BOTH tenant A and tenant B. The store returns ONLY rows matching the
 * predicate's bound tenant/agent, so the worker enqueues exclusively tenant-A's
 * rows. We also assert the captured predicate carries `eq(tenant_id)` AND
 * `eq(agent_id)` — the guarantee that the inner read can never span tenants.
 *
 * REGIME: LEGADO, e DECLARADO (#504). Este bloco existe para exercitar a query
 * drizzle REAL do inner legado — o caminho de rollback emergencial —, e por
 * isso ele fixa `authoritative = false` em vez de herdar o default. A isolação
 * equivalente do inner autoritativo (`findRecoverableTurns`) é provada contra
 * PostgreSQL de verdade em `tests/integration/agent-turns-leak.spec.ts`, onde a
 * pergunta "o WHERE carrega tenant+agent?" pode ser feita ao banco em vez de a
 * um dublê de `db.select`.
 */
describe('Issue #345 — message-recovery reads ONLY the current tenant/agent (regime legado)', () => {
  beforeEach(() => {
    flags.authoritative = false;
    vi.resetModules();
    storeRows = [
      { id: 'A-stuck', tenant_id: 'tenant-A', agent_id: 'agent-A' },
      { id: 'B-stuck', tenant_id: 'tenant-B', agent_id: 'agent-B' },
      { id: 'A-otherAgent', tenant_id: 'tenant-A', agent_id: 'agent-Z' },
    ];
    // Use the REAL repo so its drizzle WHERE predicate is exercised against the
    // store; keep enumeration overridden to return [A].
    vi.doMock('@/db/repositories.js', async () => {
      const actual = await vi.importActual<typeof import('@/db/repositories.js')>(
        '@/db/repositories.js',
      );
      return {
        ...actual,
        mensagensRepo: {
          ...actual.mensagensRepo,
          listTenantAgentPairsWithUnprocessedOlderThan: vi.fn(async () => [A]),
        },
      };
    });
  });

  it('enqueues ONLY tenant-A/agent-A stuck messages; tenant-B (and other-agent) untouched', async () => {
    const { runMessageRecovery } = await import('@/workers/message-recovery.js');
    await runMessageRecovery();

    // Only tenant-A/agent-A's stuck row was re-enqueued.
    const enqueuedIds = enqueueAgentMock.mock.calls.map((c) => (c[0] as { mensagem_id: string }).mensagem_id);
    expect(enqueuedIds).toEqual(['A-stuck']);
    expect(enqueuedIds).not.toContain('B-stuck');
    expect(enqueuedIds).not.toContain('A-otherAgent');

    // The inner read's WHERE predicate actually bound tenant_id AND agent_id.
    const terms = extractEqTerms(lastSelectPredicate);
    expect(terms).toContainEqual({ column: 'tenant_id', value: 'tenant-A' });
    expect(terms).toContainEqual({ column: 'agent_id', value: 'agent-A' });
  });
});
