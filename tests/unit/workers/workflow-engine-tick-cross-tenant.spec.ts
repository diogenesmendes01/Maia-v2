/**
 * Issue #345 (Phase 4 of #323), Batch D — Cross-tenant isolation invariant for
 * the `workflow_engine_tick` worker (the final production worker migrated off
 * the `default/default` sentinel).
 *
 * Product invariant (project north star):
 *   "Maias de empresas diferentes NUNCA se comunicam, compartilham dados ou
 *    herdam aprendizado. Sem exceção."
 *
 * `tickEngine()` READS and MUTATES `workflows` + `workflow_steps` (advancing /
 * cancelling dual-approval workflows). A cross-tenant leak would let one
 * tenant's engine tick advance or cancel ANOTHER tenant's workflow rows — a
 * severe isolation breach.
 *
 * Worker-specific contract this spec PROVES (after the #345 Batch-D fix):
 *
 *   1. `runWorkflowEngineTick` is a DISPATCHER that enumerates the DISTINCT
 *      (tenant_id, agent_id) tuples owning an active workflow
 *      (`workflowsRepo.listTenantAgentPairsWithActiveWorkflows`) and runs
 *      `tickEngine()` ONCE PER tuple inside `runWithTenantContext`.
 *
 *   2. The hardcoded `default/default` shim is GONE — when real tuples exist the
 *      engine's workflow SELECTs never execute under `default`.
 *
 *   3. Behavior-preserving in single-tenant mode; empty enumeration → no-op;
 *      fail-isolated per tuple; not coupled to any ambient caller context.
 *
 *   4. MUTATION ISOLATION (the test that would have caught a #345-class bug):
 *      the engine's reads (`workflowsRepo.listPending` →
 *      `db.select(workflows)`) and writes (`workflowsRepo.setStatus` →
 *      `db.update(workflows)`) are scoped to the current (tenant_id, agent_id).
 *      Ticking tuple A expires ONLY tenant-A's due dual-approval workflow and
 *      leaves tenant-B's row UNTOUCHED — proved against an in-memory store
 *      keyed by tenant whose SELECT/UPDATE apply the REAL drizzle predicate. An
 *      unscoped read/write would surface tenant-B's row in the result and the
 *      cross-tenant assertion would fail.
 *
 * Strategy (mirrors `conversation-summarizer-cross-tenant.spec.ts`): a single
 * store-backed `@/db/client.js` mock serves both blocks. The DISPATCH block runs
 * with an EMPTY store (`listPending` → []) while a thin wrapper records the
 * ACTIVE tenant context at each `db.select()` call site. The MUTATION-ISOLATION
 * block seeds tenant-A + tenant-B due workflows and lets the REAL `tickEngine`
 * (+ `expireDueDualApprovals` + `workflowsRepo`) run; only the enumeration helper
 * and `pessoasRepo.findById` are overridden (the latter to skip the WhatsApp
 * notify branch). `audit` + baileys are stubbed defensively.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext, tryGetCurrentContext } from '@/db/tenant-context.js';
import {
  makeTenantScopedUpdateStore,
  parsePredicate as parsePredicateForTest,
  type StoreRow,
} from './_tenant-mutation-store.js';

type Pair = { tenant_id: string; agent_id: string };

let enumeratedPairs: Pair[] = [];
/** Context active each time the engine's workflow SELECT fires. */
const contextsSeen: Pair[] = [];
let throwForTuple: Set<string> = new Set();

const listActiveWorkflowPairsMock = vi.fn(async (): Promise<Pair[]> => enumeratedPairs);

// Store-backed `db` (select + update). The MUTATION-ISOLATION block seeds it and
// drives the REAL engine reads + `workflowsRepo.setStatus()`. The DISPATCH block
// leaves it empty so `listPending` returns [].
const mutationStore = makeTenantScopedUpdateStore();

// Thin wrapper over the store's `select` that ALSO records the live ALS context
// at the SELECT call site (preserving the dispatch-routing assertions) and lets
// a tuple synthesise an engine failure (fail-isolation tests).
const dbSelectMock = vi.fn(() => {
  const ctx = tryGetCurrentContext();
  if (!ctx) {
    throw new Error(
      'workflow_engine_tick SELECT ran outside tenant context — getCurrentTenant would throw in prod',
    );
  }
  contextsSeen.push({ tenant_id: ctx.tenant_id, agent_id: ctx.agent_id });
  const key = `${ctx.tenant_id}|${ctx.agent_id}`;
  if (throwForTuple.has(key)) throw new Error(`synthetic engine failure for ${key}`);
  return mutationStore.db.select();
});

vi.mock('@/db/client.js', () => ({
  db: {
    select: dbSelectMock,
    update: (...args: unknown[]) => mutationStore.db.update(...args),
  },
  withTx: async (fn: (tx: unknown) => unknown) => fn(mutationStore.db),
}));

// Keep the REAL repos (so `workflowsRepo.listPending`/`setStatus`'s WHERE
// predicates are exercised in the mutation block) and override ONLY the
// dispatcher-enumeration helper plus `pessoasRepo.findById` (which the expiry
// notify branch would otherwise call — we force it to null so no send fires and
// the harness need not model a `pessoas` query).
vi.mock('@/db/repositories.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db/repositories.js')>();
  return {
    ...actual,
    workflowsRepo: {
      ...actual.workflowsRepo,
      listTenantAgentPairsWithActiveWorkflows: listActiveWorkflowPairsMock,
    },
    pessoasRepo: {
      ...actual.pessoasRepo,
      findById: vi.fn(async () => null),
    },
  };
});

// Defensive stubs — keep the engine's module graph importable without real DB /
// audit / WhatsApp side effects. `audit` writes to audit_log via the same `db`
// mock path otherwise; stub it so the mutation assertions stay focused on the
// workflows table.
vi.mock('@/governance/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('@/gateway/baileys.js', () => ({ sendOutboundText: vi.fn(async () => undefined) }));
vi.mock('@/governance/permissions.js', () => ({ listOwners: vi.fn(async () => []) }));

vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const A: Pair = { tenant_id: 'tenant-A', agent_id: 'agent-A' };
const B: Pair = { tenant_id: 'tenant-B', agent_id: 'agent-B' };
const DEFAULT: Pair = { tenant_id: 'default', agent_id: 'default' };

beforeEach(() => {
  enumeratedPairs = [];
  contextsSeen.length = 0;
  throwForTuple = new Set();
  listActiveWorkflowPairsMock.mockClear();
  dbSelectMock.mockClear();
  // DISPATCH tests run with an EMPTY store (listPending → []); the
  // MUTATION-ISOLATION block re-seeds it in its own beforeEach.
  mutationStore.reset([]);
});

describe('Issue #345 — runWorkflowEngineTick is per-tenant scoped (no default/default leak)', () => {
  it('MULTI-TENANT — engine ticks once per enumerated tuple under its own context', async () => {
    enumeratedPairs = [A, B];

    const { runWorkflowEngineTick } = await import('@/workers/workflow-engine-tick.js');
    await runWorkflowEngineTick();

    expect(listActiveWorkflowPairsMock).toHaveBeenCalledTimes(1);
    // Each tuple's engine fires at least one workflow SELECT (listPending runs
    // inside both expireDueDualApprovals and tickEngine).
    const seen = new Set(contextsSeen.map((c) => `${c.tenant_id}|${c.agent_id}`));
    expect(seen).toEqual(new Set(['tenant-A|agent-A', 'tenant-B|agent-B']));
  });

  it('NO default/default — engine SELECT never runs under the legacy sentinel when real tuples exist', async () => {
    enumeratedPairs = [A, B];

    const { runWorkflowEngineTick } = await import('@/workers/workflow-engine-tick.js');
    await runWorkflowEngineTick();

    expect(contextsSeen.length).toBeGreaterThan(0);
    for (const c of contextsSeen) {
      expect(c.tenant_id).not.toBe('default');
      expect(c.agent_id).not.toBe('default');
    }
  });

  it('SINGLE-TENANT PRESERVED — only (default,default) enumerated → engine runs under default', async () => {
    enumeratedPairs = [DEFAULT];

    const { runWorkflowEngineTick } = await import('@/workers/workflow-engine-tick.js');
    await runWorkflowEngineTick();

    expect(contextsSeen.length).toBeGreaterThan(0);
    for (const c of contextsSeen) expect(c).toEqual(DEFAULT);
  });

  it('EMPTY enumeration → no-op (engine SELECT never fires)', async () => {
    enumeratedPairs = [];

    const { runWorkflowEngineTick } = await import('@/workers/workflow-engine-tick.js');
    await runWorkflowEngineTick();

    expect(dbSelectMock).not.toHaveBeenCalled();
    expect(contextsSeen).toHaveLength(0);
  });

  it('FAIL-ISOLATED — a throw under tenant-A does not abort tenant-B', async () => {
    enumeratedPairs = [A, B];
    throwForTuple = new Set(['tenant-A|agent-A']);

    const { runWorkflowEngineTick } = await import('@/workers/workflow-engine-tick.js');
    await expect(runWorkflowEngineTick()).resolves.toBeUndefined();

    // Tenant-B's engine still ran (its context was seen) despite A throwing.
    const seen = new Set(contextsSeen.map((c) => `${c.tenant_id}|${c.agent_id}`));
    expect(seen.has('tenant-B|agent-B')).toBe(true);
  });

  it('DISPATCHER runs without an ambient tenant context (cron path)', async () => {
    enumeratedPairs = [A];

    const { runWorkflowEngineTick } = await import('@/workers/workflow-engine-tick.js');
    await expect(runWorkflowEngineTick()).resolves.toBeUndefined();
    for (const c of contextsSeen) expect(c).toEqual(A);
  });

  it('NOT COUPLED TO CALLER CONTEXT — ambient tenant-A does not override enumerated tenant-B', async () => {
    enumeratedPairs = [B];

    const { runWorkflowEngineTick } = await import('@/workers/workflow-engine-tick.js');
    await runWithTenantContext(A, runWorkflowEngineTick);

    expect(contextsSeen.length).toBeGreaterThan(0);
    for (const c of contextsSeen) expect(c).toEqual(B);
  });
});

/**
 * MUTATION ISOLATION — drives the REAL `tickEngine` (via the dispatcher) for
 * tuple A ONLY, against a store seeded with DUE dual-approval workflows for BOTH
 * tenant A and tenant B. `expireDueDualApprovals` cancels every due
 * (`proxima_acao_em` in the past) dual-approval workflow returned by
 * `listPending`, so this exercises BOTH scoped operations:
 *   - the `db.select(workflows)` behind `listPending` (must only return
 *     tenant-A's rows), and
 *   - `workflowsRepo.setStatus()`'s UPDATE (must only cancel tenant-A's rows).
 *
 * This is the #345 regression lever: an unscoped read/write would expire
 * tenant-B's workflow under tenant-A's tick — a cross-tenant mutation. The
 * assertion proves tenant-B's workflow keeps its original status.
 */
describe('Issue #345 — workflow_engine_tick mutates ONLY the current tenant/agent', () => {
  const PAST = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago → due
  const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1h ahead → not due

  const wf = (over: Partial<StoreRow>): StoreRow => ({
    id: 'w',
    tenant_id: 'tenant-A',
    agent_id: 'agent-A',
    tipo: 'dual_approval',
    // 'aguardando_terceiro' is in listPending's status set; with a past
    // proxima_acao_em it is "due" and gets cancelled by expireDueDualApprovals.
    status: 'aguardando_terceiro',
    proxima_acao_em: PAST,
    contexto: { requester_pessoa_id: '00000000-0000-0000-0000-000000000001', signatures: [] },
    ...over,
  });

  beforeEach(() => {
    contextsSeen.length = 0;
    mutationStore.reset([
      // Tenant A: due dual-approval (SHOULD be cancelled when ticking as A).
      wf({ id: 'A-due', tenant_id: 'tenant-A', agent_id: 'agent-A' }),
      // Tenant B: due dual-approval, different tenant (MUST stay untouched).
      wf({ id: 'B-due', tenant_id: 'tenant-B', agent_id: 'agent-B' }),
      // Tenant A but a DIFFERENT agent (MUST stay untouched).
      wf({ id: 'A-otherAgent', tenant_id: 'tenant-A', agent_id: 'agent-Z' }),
      // Tenant A but NOT due (future proxima_acao_em) — predicate must spare it
      // from the timeout branch (status stays as-is).
      wf({ id: 'A-notDue', tenant_id: 'tenant-A', agent_id: 'agent-A', proxima_acao_em: FUTURE }),
    ]);
  });

  it('ticking tuple A cancels ONLY tenant-A/agent-A due workflows', async () => {
    enumeratedPairs = [A];

    const { runWorkflowEngineTick } = await import('@/workers/workflow-engine-tick.js');
    await runWorkflowEngineTick();

    const byId = (id: string) => mutationStore.rows.find((r) => r.id === id)!;
    // Only tenant-A/agent-A's due workflow was cancelled (expiry).
    expect(byId('A-due').status).toBe('cancelado');
    // Cross-tenant isolation: tenant-B untouched …
    expect(byId('B-due').status).toBe('aguardando_terceiro');
    // … other agent of tenant-A untouched …
    expect(byId('A-otherAgent').status).toBe('aguardando_terceiro');
    // … and the not-due tenant-A workflow untouched.
    expect(byId('A-notDue').status).toBe('aguardando_terceiro');

    // The engine's listPending SELECT actually bound tenant_id AND agent_id.
    const selectTerms = parsePredicateForTest(mutationStore.lastSelectPredicate());
    expect(selectTerms).toContainEqual({ kind: 'eq', column: 'tenant_id', value: 'tenant-A' });
    expect(selectTerms).toContainEqual({ kind: 'eq', column: 'agent_id', value: 'agent-A' });
    // …and so did the setStatus() UPDATE predicate.
    const updateTerms = parsePredicateForTest(mutationStore.lastPredicate());
    expect(updateTerms).toContainEqual({ kind: 'eq', column: 'tenant_id', value: 'tenant-A' });
    expect(updateTerms).toContainEqual({ kind: 'eq', column: 'agent_id', value: 'agent-A' });
  });
});
