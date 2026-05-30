/**
 * Issue #345 (Phase 4 of #323) — Cross-tenant isolation invariant for the
 * `pending-reminder` worker.
 *
 * Product invariant (project north star):
 *   "Maias de empresas diferentes NUNCA se comunicam, compartilham dados ou
 *    herdam aprendizado. Sem exceção."
 *
 * Worker-specific contract this spec PROVES (after the #345 fix):
 *
 *   1. `runPendingReminder` is a DISPATCHER that enumerates the DISTINCT
 *      (tenant_id, agent_id) tuples with a remindable pending_question
 *      (`pendingQuestionsRepo.listTenantAgentPairsWithRemindableQuestions`) and
 *      runs the inner ONCE PER tuple inside `runWithTenantContext`.
 *
 *   2. The hardcoded `default/default` shim is GONE — when real tuples exist the
 *      inner never runs under `default`.
 *
 *   3. Behavior-preserving in single-tenant mode; empty enumeration → no-op;
 *      fail-isolated per tuple.
 *
 *   4. READ ISOLATION: the inner's RAW `db.execute()` JOIN over
 *      pending_questions/pessoas/mensagens is now scoped — it binds
 *      `pq.tenant_id`/`pq.agent_id` (from `getCurrentTenant()`/`getCurrentAgent()`)
 *      and pins the joins to the same tenant/agent. Asserted via the interpolated
 *      params of the captured SQL.
 *
 *   5. MUTATION ISOLATION (the test that would have caught the #345 review bug):
 *      `processOne`'s reminder-bookkeeping UPDATE
 *      (`db.update(pending_questions).set({metadata}).where(...)`) is scoped to
 *      the CURRENT (tenant_id, agent_id) IN ADDITION to the row id. Driven
 *      against the shared in-memory store (`_tenant-mutation-store.ts`) whose
 *      UPDATE applies the REAL drizzle predicate: feeding `processOne` a
 *      tenant-B row while running under tenant-A leaves the store's tenant-B row
 *      UNTOUCHED (the bound tenant predicate spares it). Before the fix the WHERE
 *      bound only `id`, so a per-tuple run could have stamped a reminder on a
 *      foreign-tenant row.
 *
 * Strategy: a store-backed `@/db/client.js` provides `update` (REAL predicate
 * evaluation) + a thin `execute` (returns seeded JOIN rows, records the live
 * context and bound params). The enumeration helper, baileys, audit and config
 * are mocked; `quotedReplyContext` is kept REAL (valid outbound metadata drives
 * the send/UPDATE branch).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext, tryGetCurrentContext } from '@/db/tenant-context.js';
import {
  makeTenantScopedUpdateStore,
  parsePredicate as parsePredicateForTest,
  type StoreRow,
} from './_tenant-mutation-store.js';

type Pair = { tenant_id: string; agent_id: string };
type JoinRow = {
  id: string;
  tipo: string;
  pergunta: string;
  telefone_whatsapp: string;
  outbound_metadata: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
};

/** Interpolated scalar values of a drizzle `sql` template (see pattern-detector spec). */
function boundValues(query: unknown): unknown[] {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks ?? [];
  return chunks.filter((c) => typeof c === 'string' || typeof c === 'number');
}

let enumeratedPairs: Pair[] = [];
/** Context active each time the inner JOIN SELECT fires. */
const contextsSeen: Pair[] = [];
let throwForTuple: Set<string> = new Set();
let lastExecuteParams: unknown[] = [];
/** Rows the next inner `db.execute` JOIN returns. */
let joinRows: JoinRow[] = [];

const listRemindablePairsMock = vi.fn(async (): Promise<Pair[]> => enumeratedPairs);

// Shared mutation store (UPDATE path). The inner JOIN SELECT is `db.execute`,
// which the store does not model — we add our own `execute` that records the
// live context + params and returns the seeded JOIN rows.
const mutationStore = makeTenantScopedUpdateStore();
const dbExecuteMock = vi.fn(async (query: unknown) => {
  const ctx = tryGetCurrentContext();
  if (!ctx) {
    throw new Error(
      'pending-reminder inner JOIN ran outside tenant context — getCurrentTenant would throw in prod',
    );
  }
  contextsSeen.push({ tenant_id: ctx.tenant_id, agent_id: ctx.agent_id });
  lastExecuteParams = boundValues(query);
  const key = `${ctx.tenant_id}|${ctx.agent_id}`;
  if (throwForTuple.has(key)) throw new Error(`synthetic pending-reminder failure for ${key}`);
  return { rows: joinRows };
});

vi.mock('@/db/client.js', () => ({
  db: {
    execute: dbExecuteMock,
    update: (...args: unknown[]) => mutationStore.db.update(...args),
  },
}));

vi.mock('@/db/repositories.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db/repositories.js')>();
  return {
    ...actual,
    pendingQuestionsRepo: {
      ...actual.pendingQuestionsRepo,
      listTenantAgentPairsWithRemindableQuestions: listRemindablePairsMock,
    },
  };
});

const sendOutboundTextMock = vi.fn(async () => 'WAID-REMINDER');
vi.mock('@/gateway/baileys.js', () => ({
  sendOutboundText: sendOutboundTextMock,
  isBaileysConnected: () => true,
}));

const auditMock = vi.fn(async () => undefined);
vi.mock('@/governance/audit.js', () => ({ audit: auditMock }));

vi.mock('@/config/env.js', () => ({
  config: { FEATURE_PENDING_REMINDER: true, OWNER_TELEFONE_WHATSAPP: '+5511999999999' },
}));

vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const A: Pair = { tenant_id: 'tenant-A', agent_id: 'agent-A' };
const B: Pair = { tenant_id: 'tenant-B', agent_id: 'agent-B' };
const DEFAULT: Pair = { tenant_id: 'default', agent_id: 'default' };

const VALID_OUTBOUND = {
  whatsapp_id: 'WAID-Q',
  remote_jid: '5511988888888@s.whatsapp.net',
};

beforeEach(() => {
  enumeratedPairs = [];
  contextsSeen.length = 0;
  throwForTuple = new Set();
  lastExecuteParams = [];
  joinRows = [];
  listRemindablePairsMock.mockClear();
  dbExecuteMock.mockClear();
  sendOutboundTextMock.mockReset();
  sendOutboundTextMock.mockResolvedValue('WAID-REMINDER');
  auditMock.mockReset();
  mutationStore.reset([]);
});

describe('Issue #345 — runPendingReminder is per-tenant scoped (no default/default leak)', () => {
  it('MULTI-TENANT — inner runs once per enumerated tuple under its own context', async () => {
    enumeratedPairs = [A, B];

    const { runPendingReminder } = await import('@/workers/pending-reminder.js');
    await runPendingReminder();

    expect(listRemindablePairsMock).toHaveBeenCalledTimes(1);
    expect(contextsSeen).toHaveLength(2);
    const seen = new Set(contextsSeen.map((c) => `${c.tenant_id}|${c.agent_id}`));
    expect(seen).toEqual(new Set(['tenant-A|agent-A', 'tenant-B|agent-B']));
  });

  it('NO default/default — inner never runs under the legacy sentinel when real tuples exist', async () => {
    enumeratedPairs = [A, B];

    const { runPendingReminder } = await import('@/workers/pending-reminder.js');
    await runPendingReminder();

    for (const c of contextsSeen) {
      expect(c.tenant_id).not.toBe('default');
      expect(c.agent_id).not.toBe('default');
    }
  });

  it('SINGLE-TENANT PRESERVED — only (default,default) enumerated → inner runs once under default', async () => {
    enumeratedPairs = [DEFAULT];

    const { runPendingReminder } = await import('@/workers/pending-reminder.js');
    await runPendingReminder();

    expect(contextsSeen).toEqual([DEFAULT]);
  });

  it('EMPTY enumeration → no-op (inner JOIN never fires)', async () => {
    enumeratedPairs = [];

    const { runPendingReminder } = await import('@/workers/pending-reminder.js');
    await runPendingReminder();

    expect(dbExecuteMock).not.toHaveBeenCalled();
    expect(contextsSeen).toHaveLength(0);
  });

  it('FAIL-ISOLATED — a throw under tenant-A does not abort tenant-B', async () => {
    enumeratedPairs = [A, B];
    throwForTuple = new Set(['tenant-A|agent-A']);

    const { runPendingReminder } = await import('@/workers/pending-reminder.js');
    await expect(runPendingReminder()).resolves.toBeUndefined();

    const seen = new Set(contextsSeen.map((c) => `${c.tenant_id}|${c.agent_id}`));
    expect(seen).toEqual(new Set(['tenant-A|agent-A', 'tenant-B|agent-B']));
  });

  it('DISPATCHER runs without an ambient tenant context (cron path)', async () => {
    enumeratedPairs = [A];

    const { runPendingReminder } = await import('@/workers/pending-reminder.js');
    await expect(runPendingReminder()).resolves.toBeUndefined();
    expect(contextsSeen).toEqual([A]);
  });

  it('NOT COUPLED TO CALLER CONTEXT — ambient tenant-A does not override enumerated tenant-B', async () => {
    enumeratedPairs = [B];

    const { runPendingReminder } = await import('@/workers/pending-reminder.js');
    await runWithTenantContext(A, runPendingReminder);

    expect(contextsSeen).toEqual([B]);
  });

  it('passes MAX_REMINDERS to the enumeration so the cap stays in lockstep with the inner', async () => {
    enumeratedPairs = [A];

    const { runPendingReminder } = await import('@/workers/pending-reminder.js');
    await runPendingReminder();

    expect(listRemindablePairsMock).toHaveBeenCalledWith(2); // MAX_REMINDERS
  });
});

describe('Issue #345 — pending-reminder inner JOIN binds ONLY the current tenant/agent (read isolation)', () => {
  it('running the inner under tuple A interpolates tenant-A/agent-A into the JOIN query', async () => {
    enumeratedPairs = [A];
    joinRows = []; // we only assert the bound params here

    const { runPendingReminder } = await import('@/workers/pending-reminder.js');
    await runPendingReminder();

    expect(contextsSeen).toEqual([A]);
    expect(lastExecuteParams).toContain('tenant-A');
    expect(lastExecuteParams).toContain('agent-A');
    expect(lastExecuteParams).not.toContain('default');
  });
});

/**
 * MUTATION ISOLATION — the #345 regression lever. `processOne` runs the REAL
 * reminder UPDATE against the shared store. We seed the store with a tenant-A
 * row AND a tenant-B row, then (under tenant-A's context) feed the inner JOIN a
 * tenant-B row id as if an UNSCOPED select had leaked it. The scoped UPDATE
 * binds tenant-A, so it must NOT mutate the store's tenant-B row.
 */
describe('Issue #345 — pending-reminder UPDATE mutates ONLY the current tenant/agent', () => {
  const row = (over: Partial<JoinRow>): JoinRow => ({
    id: 'pq',
    tipo: 'gate',
    pergunta: 'Confirma?',
    telefone_whatsapp: '+5511988888888',
    outbound_metadata: { ...VALID_OUTBOUND },
    metadata: {},
    ...over,
  });

  beforeEach(() => {
    // Store holds the persisted rows the UPDATE targets, keyed by tenant.
    mutationStore.reset([
      { id: 'A-pq', tenant_id: 'tenant-A', agent_id: 'agent-A', status: 'aberta', metadata: {} },
      { id: 'B-pq', tenant_id: 'tenant-B', agent_id: 'agent-B', status: 'aberta', metadata: {} },
    ] as StoreRow[]);
  });

  it('reminder bookkeeping UPDATE under tenant-A touches ONLY tenant-A row; a leaked tenant-B row is spared', async () => {
    enumeratedPairs = [A];
    // Simulate the WORST case: the inner JOIN hands back BOTH a tenant-A row and
    // a tenant-B row (as an unscoped SELECT would have). The scoped UPDATE must
    // still spare the tenant-B persisted row.
    joinRows = [row({ id: 'A-pq' }), row({ id: 'B-pq' })];

    const { runPendingReminder } = await import('@/workers/pending-reminder.js');
    await runPendingReminder();

    const byId = (id: string) => mutationStore.rows.find((r) => r.id === id)!;
    // Tenant-A's row got the reminder bookkeeping (reminder_count incremented).
    expect((byId('A-pq').metadata as { reminder_count?: number }).reminder_count).toBe(1);
    // Cross-tenant isolation: tenant-B's persisted row is UNTOUCHED — even though
    // the (simulated-leaked) tenant-B row reached `processOne`, the tenant-scoped
    // WHERE matched no store row, so reminder_count stays unset.
    expect((byId('B-pq').metadata as { reminder_count?: number }).reminder_count).toBeUndefined();
    expect(byId('B-pq').status).toBe('aberta');

    // The UPDATE predicate actually bound tenant_id AND agent_id (in addition to
    // id) on every call — never just `id`.
    const terms = parsePredicateForTest(mutationStore.lastPredicate());
    expect(terms).toContainEqual({ kind: 'eq', column: 'tenant_id', value: 'tenant-A' });
    expect(terms).toContainEqual({ kind: 'eq', column: 'agent_id', value: 'agent-A' });
  });
});
