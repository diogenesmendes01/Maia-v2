/**
 * Issue #345 (Phase 4 of #323) — Cross-tenant isolation invariant for the
 * `pattern-detector` worker.
 *
 * Product invariant (project north star):
 *   "Maias de empresas diferentes NUNCA se comunicam, compartilham dados ou
 *    herdam aprendizado. Sem exceção."
 *
 * Worker-specific contract this spec PROVES (after the #345 fix):
 *
 *   1. `runPatternDetector` is a DISPATCHER that enumerates the DISTINCT
 *      (tenant_id, agent_id) tuples with recent audit rows
 *      (`auditRepo.listTenantAgentPairsWithRecentAudit`) and runs the inner
 *      aggregation ONCE PER tuple inside `runWithTenantContext`.
 *
 *   2. The hardcoded `default/default` shim is GONE — when real tuples exist the
 *      inner aggregation never executes under `default`.
 *
 *   3. Behavior-preserving in single-tenant mode; empty enumeration → no-op;
 *      fail-isolated per tuple.
 *
 *   4. READ ISOLATION (the test that would have caught the #345 review bug): the
 *      inner's RAW `db.execute()` aggregation over `audit_log` is scoped to the
 *      current (tenant_id, agent_id) — the worker REPLACED the old hardcoded SQL
 *      literal `WHERE tenant_id='default' AND agent_id='default'` with
 *      `getCurrentTenant()`/`getCurrentAgent()` bindings. The interpolated SQL
 *      therefore carries the running tenant/agent as bound params, so a per-tuple
 *      run can never `array_agg(alvo_id)` across tenants. Before the fix the
 *      aggregation was pinned to `default`, so real tenants were never reflected
 *      on AND (had the literal been naively dropped) it would have read every
 *      tenant's audit rows.
 *
 * Strategy: a single `@/db/client.js` `db.execute` mock serves both blocks. It
 * records the ACTIVE tenant context at every call site (dispatch-routing
 * assertions) AND captures the interpolated SQL so the READ-ISOLATION block can
 * assert the bound tenant/agent params. The cognition modules are stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext, tryGetCurrentContext } from '@/db/tenant-context.js';

type Pair = { tenant_id: string; agent_id: string };

/**
 * Extract the interpolated scalar values from a drizzle `sql` template. A
 * top-level `sql\`… ${tenant_id} … ${agent_id} …\`` inlines string/number
 * interpolations as RAW primitives directly inside `queryChunks` (the static
 * SQL text lives in `StringChunk` objects). So the bound params are exactly the
 * primitive `string`/`number` chunks — which is what the worker interpolates for
 * `${tenant_id}` / `${agent_id}` / `${MIN_OCCURRENCES}`.
 */
function boundValues(query: unknown): unknown[] {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks ?? [];
  return chunks.filter((c) => typeof c === 'string' || typeof c === 'number');
}

let enumeratedPairs: Pair[] = [];
/** Context active each time the inner's audit aggregation fires. */
const contextsSeen: Pair[] = [];
let throwForTuple: Set<string> = new Set();
/** Bound params of the most-recent inner `db.execute` SQL (its `.params`). */
let lastExecuteParams: unknown[] = [];
/** Rows the next `db.execute` returns (READ-ISOLATION drives the loop body). */
let executeRows: Array<{ pattern: string; count: number; alvo_ids: string[] }> = [];

const listRecentAuditMock = vi.fn(async (): Promise<Pair[]> => enumeratedPairs);

// A thin `db.execute` that records the live ALS context + the interpolated SQL
// params, lets a tuple synthesise a failure, and returns the seeded rows.
const dbExecuteMock = vi.fn(async (query: unknown) => {
  const ctx = tryGetCurrentContext();
  if (!ctx) {
    throw new Error(
      'pattern-detector inner aggregation ran outside tenant context — getCurrentTenant would throw in prod',
    );
  }
  contextsSeen.push({ tenant_id: ctx.tenant_id, agent_id: ctx.agent_id });
  // The worker interpolates `${tenant_id}` / `${agent_id}` into the `sql`
  // template; those land as raw primitives in `queryChunks` (see `boundValues`).
  lastExecuteParams = boundValues(query);
  const key = `${ctx.tenant_id}|${ctx.agent_id}`;
  if (throwForTuple.has(key)) throw new Error(`synthetic pattern-detector failure for ${key}`);
  return { rows: executeRows };
});

vi.mock('@/db/client.js', () => ({
  db: { execute: dbExecuteMock },
}));

// Keep the REAL repo and override ONLY the dispatcher-enumeration helper.
vi.mock('@/db/repositories.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db/repositories.js')>();
  return {
    ...actual,
    auditRepo: {
      ...actual.auditRepo,
      listTenantAgentPairsWithRecentAudit: listRecentAuditMock,
    },
  };
});

// Cognition stubs — defensive (the loop body only runs in the READ-ISOLATION
// block, which seeds `executeRows`). `reflect → null` short-circuits so we never
// reach classify/persist, keeping the module graph side-effect free.
const reflectMock = vi.fn(async () => null);
vi.mock('@/cognition/reflector.js', () => ({ reflect: reflectMock }));
vi.mock('@/cognition/classifier.js', () => ({ classify: vi.fn(async () => null) }));
vi.mock('@/cognition/persister.js', () => ({ persistCandidate: vi.fn(async () => undefined) }));

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
  lastExecuteParams = [];
  executeRows = [];
  listRecentAuditMock.mockClear();
  dbExecuteMock.mockClear();
  reflectMock.mockClear();
});

describe('Issue #345 — runPatternDetector is per-tenant scoped (no default/default leak)', () => {
  it('MULTI-TENANT — inner aggregation runs once per enumerated tuple under its own context', async () => {
    enumeratedPairs = [A, B];

    const { runPatternDetector } = await import('@/workers/pattern-detector.js');
    await runPatternDetector();

    expect(listRecentAuditMock).toHaveBeenCalledTimes(1);
    expect(contextsSeen).toHaveLength(2);
    const seen = new Set(contextsSeen.map((c) => `${c.tenant_id}|${c.agent_id}`));
    expect(seen).toEqual(new Set(['tenant-A|agent-A', 'tenant-B|agent-B']));
  });

  it('NO default/default — inner aggregation never runs under the legacy sentinel when real tuples exist', async () => {
    enumeratedPairs = [A, B];

    const { runPatternDetector } = await import('@/workers/pattern-detector.js');
    await runPatternDetector();

    for (const c of contextsSeen) {
      expect(c.tenant_id).not.toBe('default');
      expect(c.agent_id).not.toBe('default');
    }
  });

  it('SINGLE-TENANT PRESERVED — only (default,default) enumerated → inner runs once under default', async () => {
    enumeratedPairs = [DEFAULT];

    const { runPatternDetector } = await import('@/workers/pattern-detector.js');
    await runPatternDetector();

    expect(contextsSeen).toEqual([DEFAULT]);
  });

  it('EMPTY enumeration → no-op (inner aggregation never fires)', async () => {
    enumeratedPairs = [];

    const { runPatternDetector } = await import('@/workers/pattern-detector.js');
    await runPatternDetector();

    expect(dbExecuteMock).not.toHaveBeenCalled();
    expect(contextsSeen).toHaveLength(0);
  });

  it('FAIL-ISOLATED — a throw under tenant-A does not abort tenant-B', async () => {
    enumeratedPairs = [A, B];
    throwForTuple = new Set(['tenant-A|agent-A']);

    const { runPatternDetector } = await import('@/workers/pattern-detector.js');
    await expect(runPatternDetector()).resolves.toBeUndefined();

    const seen = new Set(contextsSeen.map((c) => `${c.tenant_id}|${c.agent_id}`));
    expect(seen).toEqual(new Set(['tenant-A|agent-A', 'tenant-B|agent-B']));
  });

  it('DISPATCHER runs without an ambient tenant context (cron path)', async () => {
    enumeratedPairs = [A];

    const { runPatternDetector } = await import('@/workers/pattern-detector.js');
    await expect(runPatternDetector()).resolves.toBeUndefined();
    expect(contextsSeen).toEqual([A]);
  });

  it('NOT COUPLED TO CALLER CONTEXT — ambient tenant-A does not override enumerated tenant-B', async () => {
    enumeratedPairs = [B];

    const { runPatternDetector } = await import('@/workers/pattern-detector.js');
    await runWithTenantContext(A, runPatternDetector);

    expect(contextsSeen).toEqual([B]);
  });
});

/**
 * READ ISOLATION — drives the REAL inner aggregation for tuple A and proves its
 * `db.execute` SQL bound tenant-A/agent-A as params (the old hardcoded literal
 * was `default/default`). This is the #345 regression lever: the aggregation is
 * a raw SQL execute that bypasses the tenant guard, so the only thing keeping
 * `array_agg(alvo_id)` from spanning tenants is the bound (tenant_id, agent_id)
 * predicate — asserted here against the interpolated params.
 */
describe('Issue #345 — pattern-detector aggregation binds ONLY the current tenant/agent', () => {
  it('running the inner under tuple A interpolates tenant-A/agent-A into the audit query', async () => {
    enumeratedPairs = [A];
    // One pattern over the threshold so the loop body runs (reflect → null
    // short-circuits before classify/persist).
    executeRows = [{ pattern: 'transaction_corrected|x', count: 3, alvo_ids: ['id-1', 'id-2'] }];

    const { runPatternDetector } = await import('@/workers/pattern-detector.js');
    await runPatternDetector();

    // The aggregation ran exactly once, under tenant-A.
    expect(contextsSeen).toEqual([A]);
    // Its interpolated SQL carried tenant-A AND agent-A as bound params — never
    // a `default` literal.
    expect(lastExecuteParams).toContain('tenant-A');
    expect(lastExecuteParams).toContain('agent-A');
    expect(lastExecuteParams).not.toContain('default');
    // The event reached the reflection pipeline for THIS tenant (proves the
    // rows aggregated under A flow onward, not silently dropped).
    expect(reflectMock).toHaveBeenCalledTimes(1);
  });

  it('two tenants each bind their OWN params (no bleed between iterations)', async () => {
    enumeratedPairs = [A, B];
    executeRows = [{ pattern: 'p|y', count: 5, alvo_ids: ['z'] }];

    const paramsPerCall: unknown[][] = [];
    dbExecuteMock.mockImplementation(async (query: unknown) => {
      const ctx = tryGetCurrentContext()!;
      contextsSeen.push({ tenant_id: ctx.tenant_id, agent_id: ctx.agent_id });
      paramsPerCall.push(boundValues(query));
      return { rows: executeRows };
    });

    const { runPatternDetector } = await import('@/workers/pattern-detector.js');
    await runPatternDetector();

    expect(paramsPerCall).toHaveLength(2);
    // Call under A carries A's params and NOT B's; vice-versa.
    expect(paramsPerCall[0]).toContain('tenant-A');
    expect(paramsPerCall[0]).not.toContain('tenant-B');
    expect(paramsPerCall[1]).toContain('tenant-B');
    expect(paramsPerCall[1]).not.toContain('tenant-A');
  });
});
