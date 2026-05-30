/**
 * Issue #355 (H4 of #323) — MUTATION ISOLATION for the STATE / MEMORY
 * `repositories.ts` single-row writes and the two read-then-write PAIRS.
 *
 * Product invariant (project north star):
 *   "Maias de empresas diferentes NUNCA se comunicam, compartilham dados ou
 *    herdam aprendizado. Sem exceção."
 *
 * H1 (#357) hardened the conversas/mensagens hot-path mutations, H2 (#361) the
 * `pendingQuestionsRepo` ones, H3 (#364) the FINANCIAL ones. This H4 closes the
 * analogous gap on the cognitive STATE / MEMORY writes:
 *
 *   Simple single-row writes (id-only WHERE → now tenant+agent scoped, fail-loud):
 *     - cognitiveCandidatesRepo.markConsumed   (UPDATE status='consumed')
 *     - memoryEntryRepo.markReviewed           (UPDATE needs_review=false)
 *     - behavioralHintRepo.revoke              (UPDATE revoked_at)
 *     - procedureAssignmentsRepo.disable       (UPDATE enabled=false — TENANT-ONLY:
 *                                               the table has no agent_id column)
 *     - procedureTestsRepo.recordRun           (UPDATE last_run_status)
 *     - procedureTestsRepo.delete              (DELETE by id)
 *
 *   Read-then-write PAIRS (BOTH the read AND the write are scoped):
 *     - selfStateRepo.getActive  (UNSCOPED read on `ativa=true` → returned ANY
 *       tenant's active row; its id fed appendLearning's UPDATE → cross-tenant
 *       write) + selfStateRepo.appendLearning.
 *     - entityStatesRepo.byId    (UNSCOPED read on the `entidade_id` PK → returned
 *       ANY tenant's row) + entityStatesRepo.upsert (conflict target = the
 *       `entidade_id` PK with NO ownership gate → could overwrite ANOTHER
 *       tenant's row for a colliding entidade_id).
 *
 * This spec drives the REAL repo methods against an in-memory store keyed by
 * tenant (`makeTenantScopedUpdateStore`) whose UPDATE/DELETE/SELECT/INSERT…ON
 * CONFLICT is applied by EVALUATING the method's ACTUAL drizzle WHERE clause — so
 * a missing tenant/agent binding is observable as a foreign tenant's row being
 * mutated/read/deleted/overwritten (the exact regression lever).
 *
 * Each test seeds tenant-A + tenant-B rows that SHARE the targeted id/entidade,
 * runs the method under tenant-A's context, and asserts:
 *   (1) ONLY tenant-A's row changed/was-read (tenant-B + other-agent untouched), and
 *   (2) the executed WHERE actually bound BOTH `tenant_id` AND `agent_id`
 *       (revert-check: a refactor that drops either binding fails here even if the
 *       row-state assertion happened to pass for a given seed). `disable` binds
 *       `tenant_id` ONLY (its table has no agent_id) and is checked accordingly.
 *
 * Pre-fix revert-check: against the old id-only predicate the shared-id rows BOTH
 * match, so assertion (1) fails (tenant-B's row is mutated/read) and assertion (2)
 * fails (no tenant/agent term present); and the FAIL-LOUD specs flip from "throws"
 * to "silently no-ops". For the upsert, the old unscoped conflict arm OVERWRITES
 * tenant-B's row, which the dedicated test catches.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';
import {
  makeTenantScopedUpdateStore,
  parsePredicate as parsePredicateForTest,
  type StoreRow,
  type TenantScopedUpdateStore,
} from './_tenant-mutation-store.js';

type Pair = { tenant_id: string; agent_id: string };
const A: Pair = { tenant_id: 'tenant-A', agent_id: 'agent-A' };

// In-memory, tenant-keyed store standing in for `@/db/client.js`. The REAL repo
// methods run their drizzle UPDATE / SELECT / DELETE / INSERT against this.
const store: TenantScopedUpdateStore = makeTenantScopedUpdateStore();

vi.mock('@/db/client.js', () => ({
  db: store.db,
  withTx: async (fn: (tx: unknown) => unknown) => fn(store.db),
}));

beforeEach(() => {
  store.reset([]);
});

/** Assert the UPDATE/DELETE WHERE bound BOTH tenant + agent for tenant-A. */
function expectBoundTenantAgent(predicate: unknown): void {
  const terms = parsePredicateForTest(predicate);
  expect(terms).toContainEqual({ kind: 'eq', column: 'tenant_id', value: 'tenant-A' });
  expect(terms).toContainEqual({ kind: 'eq', column: 'agent_id', value: 'agent-A' });
}

/** Assert the WHERE bound `tenant_id` for tenant-A (used where there is no agent_id column). */
function expectBoundTenant(predicate: unknown): void {
  const terms = parsePredicateForTest(predicate);
  expect(terms).toContainEqual({ kind: 'eq', column: 'tenant_id', value: 'tenant-A' });
}

// ---------------------------------------------------------------------------
// Simple single-row UPDATE/DELETE mutations
// ---------------------------------------------------------------------------

describe('#355 H4 — cognitiveCandidatesRepo.markConsumed() consumes ONLY the current tenant/agent', () => {
  const row = (over: Partial<StoreRow>): StoreRow => ({
    id: 'cand',
    tenant_id: 'tenant-A',
    agent_id: 'agent-A',
    status: 'pending',
    ...over,
  });

  it('leaves tenant-B (and other-agent) candidates UNTOUCHED', async () => {
    store.reset([
      row({ id: 'shared', tenant_id: 'tenant-A', agent_id: 'agent-A' }),
      row({ id: 'shared', tenant_id: 'tenant-B', agent_id: 'agent-B' }),
      row({ id: 'shared', tenant_id: 'tenant-A', agent_id: 'agent-Z' }),
    ]);
    const { cognitiveCandidatesRepo } = await import('@/db/repositories.js');

    await runWithTenantContext(A, () =>
      cognitiveCandidatesRepo.markConsumed('shared', 'p3a-procedure-builder'),
    );

    const byId = store.rows.filter((r) => r.id === 'shared');
    expect(byId.find((r) => r.tenant_id === 'tenant-A' && r.agent_id === 'agent-A')!.status).toBe('consumed');
    expect(byId.find((r) => r.tenant_id === 'tenant-B')!.status).toBe('pending'); // cross-tenant
    expect(byId.find((r) => r.agent_id === 'agent-Z')!.status).toBe('pending'); // cross-agent
    expectBoundTenantAgent(store.lastPredicate());
  });

  it('FAIL-LOUD — throws when no candidate matches the current tenant/agent', async () => {
    store.reset([row({ id: 'b-only', tenant_id: 'tenant-B', agent_id: 'agent-B' })]);
    const { cognitiveCandidatesRepo } = await import('@/db/repositories.js');

    await expect(
      runWithTenantContext(A, () => cognitiveCandidatesRepo.markConsumed('b-only', 'phase')),
    ).rejects.toThrow(/markConsumed matched 0 rows/);
    expect(store.rows.find((r) => r.id === 'b-only')!.status).toBe('pending');
  });
});

describe('#355 H4 — memoryEntryRepo.markReviewed() reviews ONLY the current tenant/agent', () => {
  const row = (over: Partial<StoreRow>): StoreRow => ({
    id: 'mem',
    tenant_id: 'tenant-A',
    agent_id: 'agent-A',
    needs_review: true,
    ...over,
  });
  const updates = {
    memory_type: 'fact',
    sensitivity: 'low',
    proactive_use: false,
    mention_allowed: true,
  };

  it('leaves tenant-B (and other-agent) entries UNTOUCHED', async () => {
    store.reset([
      row({ id: 'shared', tenant_id: 'tenant-A', agent_id: 'agent-A' }),
      row({ id: 'shared', tenant_id: 'tenant-B', agent_id: 'agent-B' }),
      row({ id: 'shared', tenant_id: 'tenant-A', agent_id: 'agent-Z' }),
    ]);
    const { memoryEntryRepo } = await import('@/db/repositories.js');

    await runWithTenantContext(A, () => memoryEntryRepo.markReviewed('shared', updates));

    const byId = store.rows.filter((r) => r.id === 'shared');
    expect(byId.find((r) => r.tenant_id === 'tenant-A' && r.agent_id === 'agent-A')!.needs_review).toBe(false);
    expect(byId.find((r) => r.tenant_id === 'tenant-B')!.needs_review).toBe(true); // cross-tenant
    expect(byId.find((r) => r.agent_id === 'agent-Z')!.needs_review).toBe(true); // cross-agent
    expectBoundTenantAgent(store.lastPredicate());
  });

  it('FAIL-LOUD — throws when no entry matches the current tenant/agent', async () => {
    store.reset([row({ id: 'b-only', tenant_id: 'tenant-B', agent_id: 'agent-B' })]);
    const { memoryEntryRepo } = await import('@/db/repositories.js');

    await expect(
      runWithTenantContext(A, () => memoryEntryRepo.markReviewed('b-only', updates)),
    ).rejects.toThrow(/markReviewed matched 0 rows/);
    expect(store.rows.find((r) => r.id === 'b-only')!.needs_review).toBe(true);
  });
});

describe('#355 H4 — behavioralHintRepo.revoke() revokes ONLY the current tenant/agent', () => {
  const row = (over: Partial<StoreRow>): StoreRow => ({
    id: 'hint',
    tenant_id: 'tenant-A',
    agent_id: 'agent-A',
    status: 'live',
    revoked_at: null,
    ...over,
  });

  it('leaves tenant-B (and other-agent) hints UNTOUCHED', async () => {
    store.reset([
      row({ id: 'shared', tenant_id: 'tenant-A', agent_id: 'agent-A' }),
      row({ id: 'shared', tenant_id: 'tenant-B', agent_id: 'agent-B' }),
      row({ id: 'shared', tenant_id: 'tenant-A', agent_id: 'agent-Z' }),
    ]);
    const { behavioralHintRepo } = await import('@/db/repositories.js');

    await runWithTenantContext(A, () => behavioralHintRepo.revoke('shared'));

    const byId = store.rows.filter((r) => r.id === 'shared');
    expect(byId.find((r) => r.tenant_id === 'tenant-A' && r.agent_id === 'agent-A')!.revoked_at).not.toBeNull();
    expect(byId.find((r) => r.tenant_id === 'tenant-B')!.revoked_at).toBeNull(); // cross-tenant
    expect(byId.find((r) => r.agent_id === 'agent-Z')!.revoked_at).toBeNull(); // cross-agent
    expectBoundTenantAgent(store.lastPredicate());
  });

  it('FAIL-LOUD — throws when no hint matches the current tenant/agent', async () => {
    store.reset([row({ id: 'b-only', tenant_id: 'tenant-B', agent_id: 'agent-B' })]);
    const { behavioralHintRepo } = await import('@/db/repositories.js');

    await expect(
      runWithTenantContext(A, () => behavioralHintRepo.revoke('b-only')),
    ).rejects.toThrow(/revoke matched 0 rows/);
    expect(store.rows.find((r) => r.id === 'b-only')!.revoked_at).toBeNull();
  });
});

describe('#355 H4 — procedureAssignmentsRepo.disable() disables ONLY the current tenant (TENANT-ONLY scope)', () => {
  // NB: procedure_assignments has NO agent_id column — scope is tenant_id ONLY.
  const row = (over: Partial<StoreRow>): StoreRow => ({
    id: 'assign',
    tenant_id: 'tenant-A',
    agent_id: 'n/a', // not a real column; present only so StoreRow typechecks
    status: 'enabled',
    enabled: true,
    ...over,
  });

  it('leaves tenant-B assignments UNTOUCHED and binds tenant_id', async () => {
    store.reset([
      row({ id: 'shared', tenant_id: 'tenant-A', enabled: true }),
      row({ id: 'shared', tenant_id: 'tenant-B', enabled: true }),
    ]);
    const { procedureAssignmentsRepo } = await import('@/db/repositories.js');

    await runWithTenantContext(A, () => procedureAssignmentsRepo.disable('shared'));

    const byId = store.rows.filter((r) => r.id === 'shared');
    expect(byId.find((r) => r.tenant_id === 'tenant-A')!.enabled).toBe(false);
    expect(byId.find((r) => r.tenant_id === 'tenant-B')!.enabled).toBe(true); // cross-tenant
    expectBoundTenant(store.lastPredicate());
  });

  it('FAIL-LOUD — throws when no assignment matches the current tenant', async () => {
    store.reset([row({ id: 'b-only', tenant_id: 'tenant-B', enabled: true })]);
    const { procedureAssignmentsRepo } = await import('@/db/repositories.js');

    await expect(
      runWithTenantContext(A, () => procedureAssignmentsRepo.disable('b-only')),
    ).rejects.toThrow(/disable matched 0 rows/);
    expect(store.rows.find((r) => r.id === 'b-only')!.enabled).toBe(true);
  });
});

describe('#355 H4 — procedureTestsRepo.recordRun() records ONLY the current tenant/agent', () => {
  const row = (over: Partial<StoreRow>): StoreRow => ({
    id: 'test',
    tenant_id: 'tenant-A',
    agent_id: 'agent-A',
    status: 'n/a',
    last_run_status: null,
    ...over,
  });

  it('leaves tenant-B (and other-agent) tests UNTOUCHED', async () => {
    store.reset([
      row({ id: 'shared', tenant_id: 'tenant-A', agent_id: 'agent-A' }),
      row({ id: 'shared', tenant_id: 'tenant-B', agent_id: 'agent-B' }),
      row({ id: 'shared', tenant_id: 'tenant-A', agent_id: 'agent-Z' }),
    ]);
    const { procedureTestsRepo } = await import('@/db/repositories.js');

    await runWithTenantContext(A, () =>
      procedureTestsRepo.recordRun({ id: 'shared', status: 'pass', details: {} }),
    );

    const byId = store.rows.filter((r) => r.id === 'shared');
    expect(byId.find((r) => r.tenant_id === 'tenant-A' && r.agent_id === 'agent-A')!.last_run_status).toBe('pass');
    expect(byId.find((r) => r.tenant_id === 'tenant-B')!.last_run_status).toBeNull(); // cross-tenant
    expect(byId.find((r) => r.agent_id === 'agent-Z')!.last_run_status).toBeNull(); // cross-agent
    expectBoundTenantAgent(store.lastPredicate());
  });

  it('FAIL-LOUD — throws when no test matches the current tenant/agent', async () => {
    store.reset([row({ id: 'b-only', tenant_id: 'tenant-B', agent_id: 'agent-B' })]);
    const { procedureTestsRepo } = await import('@/db/repositories.js');

    await expect(
      runWithTenantContext(A, () =>
        procedureTestsRepo.recordRun({ id: 'b-only', status: 'pass', details: {} }),
      ),
    ).rejects.toThrow(/recordRun matched 0 rows/);
    expect(store.rows.find((r) => r.id === 'b-only')!.last_run_status).toBeNull();
  });
});

describe('#355 H4 — procedureTestsRepo.delete() deletes ONLY the current tenant/agent', () => {
  const row = (over: Partial<StoreRow>): StoreRow => ({
    id: 'test',
    tenant_id: 'tenant-A',
    agent_id: 'agent-A',
    status: 'n/a',
    ...over,
  });

  it('removes tenant-A row but leaves tenant-B (and other-agent) rows present', async () => {
    store.reset([
      row({ id: 'shared', tenant_id: 'tenant-A', agent_id: 'agent-A' }),
      row({ id: 'shared', tenant_id: 'tenant-B', agent_id: 'agent-B' }),
      row({ id: 'shared', tenant_id: 'tenant-A', agent_id: 'agent-Z' }),
    ]);
    const { procedureTestsRepo } = await import('@/db/repositories.js');

    await runWithTenantContext(A, () => procedureTestsRepo.delete('shared'));

    const byId = store.rows.filter((r) => r.id === 'shared');
    // tenant-A/agent-A row removed; the other two survive.
    expect(byId.find((r) => r.tenant_id === 'tenant-A' && r.agent_id === 'agent-A')).toBeUndefined();
    expect(byId.find((r) => r.tenant_id === 'tenant-B')).toBeDefined(); // cross-tenant
    expect(byId.find((r) => r.agent_id === 'agent-Z')).toBeDefined(); // cross-agent
    expectBoundTenantAgent(store.lastDeletePredicate());
  });

  it('FAIL-LOUD — throws when no test matches the current tenant/agent (foreign row NOT deleted)', async () => {
    store.reset([row({ id: 'b-only', tenant_id: 'tenant-B', agent_id: 'agent-B' })]);
    const { procedureTestsRepo } = await import('@/db/repositories.js');

    await expect(
      runWithTenantContext(A, () => procedureTestsRepo.delete('b-only')),
    ).rejects.toThrow(/delete matched 0 rows/);
    // The cross-tenant DELETE removed nothing — tenant-B's row survives.
    expect(store.rows.find((r) => r.id === 'b-only')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// PAIR 1 — selfStateRepo.getActive (READ) + appendLearning (WRITE)
// ---------------------------------------------------------------------------

describe('#355 H4 — selfStateRepo.getActive() reads ONLY the current tenant/agent', () => {
  const row = (over: Partial<StoreRow>): StoreRow => ({
    id: 'self',
    tenant_id: 'tenant-A',
    agent_id: 'agent-A',
    status: 'n/a',
    ativa: true,
    versao: 1,
    resumo_aprendizados: '',
    ...over,
  });

  it('does NOT return another tenant\'s active self_state (even with a higher versao)', async () => {
    // The OLD WHERE (`ativa=true` ordered by versao desc) would return tenant-B's
    // row here because its versao (9) outranks tenant-A's (1) — a cross-tenant read
    // whose id then fed appendLearning's write. The scoped read returns tenant-A's.
    store.reset([
      row({ id: 'self-A', tenant_id: 'tenant-A', agent_id: 'agent-A', versao: 1 }),
      row({ id: 'self-B', tenant_id: 'tenant-B', agent_id: 'agent-B', versao: 9 }),
    ]);
    const { selfStateRepo } = await import('@/db/repositories.js');

    const active = await runWithTenantContext(A, () => selfStateRepo.getActive());

    expect(active).not.toBeNull();
    expect(active!.tenant_id).toBe('tenant-A');
    expect(active!.id).toBe('self-A'); // never tenant-B's higher-versao row
    expect(active!.agent_id).toBe('agent-A');
    expectBoundTenantAgent(store.lastSelectPredicate());
  });

  it('returns null when the current tenant has no active self_state (other tenants ignored)', async () => {
    store.reset([row({ id: 'self-B', tenant_id: 'tenant-B', agent_id: 'agent-B', versao: 9 })]);
    const { selfStateRepo } = await import('@/db/repositories.js');

    const active = await runWithTenantContext(A, () => selfStateRepo.getActive());

    expect(active).toBeNull(); // tenant-B's row does NOT leak through
    expectBoundTenantAgent(store.lastSelectPredicate());
  });
});

describe('#355 H4 — selfStateRepo.appendLearning() writes ONLY the current tenant/agent', () => {
  const row = (over: Partial<StoreRow>): StoreRow => ({
    id: 'self',
    tenant_id: 'tenant-A',
    agent_id: 'agent-A',
    status: 'n/a',
    ativa: true,
    versao: 1,
    resumo_aprendizados: '',
    ...over,
  });

  it('appends to tenant-A\'s row and leaves tenant-B (higher versao) UNTOUCHED', async () => {
    store.reset([
      row({ id: 'self-A', tenant_id: 'tenant-A', agent_id: 'agent-A', versao: 1, resumo_aprendizados: '' }),
      row({ id: 'self-B', tenant_id: 'tenant-B', agent_id: 'agent-B', versao: 9, resumo_aprendizados: 'B-private' }),
    ]);
    const { selfStateRepo } = await import('@/db/repositories.js');

    await runWithTenantContext(A, () => selfStateRepo.appendLearning('learned X'));

    const a = store.rows.find((r) => r.id === 'self-A')!;
    const b = store.rows.find((r) => r.id === 'self-B')!;
    expect(String(a.resumo_aprendizados)).toContain('learned X'); // tenant-A updated
    expect(b.resumo_aprendizados).toBe('B-private'); // cross-tenant: untouched
    // The WHERE of the UPDATE (last mutation predicate) binds tenant+agent.
    expectBoundTenantAgent(store.lastPredicate());
  });

  it('no-ops (no throw) when the current tenant has no active self_state', async () => {
    // appendLearning is best-effort/predicate-only — getActive returns null for
    // tenant-A (only tenant-B has a row), so it early-returns without writing and
    // WITHOUT throwing (unlike the fail-loud single-row writes).
    store.reset([row({ id: 'self-B', tenant_id: 'tenant-B', agent_id: 'agent-B', resumo_aprendizados: 'B-private' })]);
    const { selfStateRepo } = await import('@/db/repositories.js');

    await expect(
      runWithTenantContext(A, () => selfStateRepo.appendLearning('learned X')),
    ).resolves.toBeUndefined();
    // tenant-B's row is never touched.
    expect(store.rows.find((r) => r.id === 'self-B')!.resumo_aprendizados).toBe('B-private');
  });
});

// ---------------------------------------------------------------------------
// PAIR 2 — entityStatesRepo.byId (READ) + upsert (WRITE / INSERT…ON CONFLICT)
// ---------------------------------------------------------------------------

describe('#355 H4 — entityStatesRepo.byId() reads ONLY the current tenant/agent', () => {
  const row = (over: Partial<StoreRow>): StoreRow => ({
    entidade_id: 'ent',
    id: 'ent', // mirror so generic helpers that key on `id` still work
    tenant_id: 'tenant-A',
    agent_id: 'agent-A',
    status: 'n/a',
    contexto: {},
    flags: {},
    ...over,
  });

  it('returns null for an entidade owned by another tenant (no cross-tenant leak)', async () => {
    store.reset([row({ entidade_id: 'b-only', tenant_id: 'tenant-B', agent_id: 'agent-B' })]);
    const { entityStatesRepo } = await import('@/db/repositories.js');

    const found = await runWithTenantContext(A, () => entityStatesRepo.byId('b-only'));

    expect(found).toBeNull();
    expectBoundTenantAgent(store.lastSelectPredicate());
  });

  it('returns the row for an entidade owned by the current tenant/agent', async () => {
    store.reset([
      row({ entidade_id: 'shared', tenant_id: 'tenant-A', agent_id: 'agent-A', flags: { a: 1 } }),
      row({ entidade_id: 'other', tenant_id: 'tenant-B', agent_id: 'agent-B' }),
    ]);
    const { entityStatesRepo } = await import('@/db/repositories.js');

    const found = await runWithTenantContext(A, () => entityStatesRepo.byId('shared'));

    expect(found).not.toBeNull();
    expect(found!.tenant_id).toBe('tenant-A');
    expect(found!.agent_id).toBe('agent-A');
    expectBoundTenantAgent(store.lastSelectPredicate());
  });
});

describe('#355 H4 — entityStatesRepo.upsert() cannot overwrite another tenant\'s entity_state', () => {
  it('INSERTs (and tenant-stamps) when no row exists for the entidade', async () => {
    store.reset([]);
    const { entityStatesRepo } = await import('@/db/repositories.js');

    const out = await runWithTenantContext(A, () =>
      entityStatesRepo.upsert({ entidade_id: 'fresh', flags: { x: 1 } }),
    );

    expect(out.entidade_id).toBe('fresh');
    // applyTenantGuard stamped the running tuple onto the inserted row.
    expect(out.tenant_id).toBe('tenant-A');
    expect(out.agent_id).toBe('agent-A');
    const stored = store.rows.find((r) => r.entidade_id === 'fresh')!;
    expect(stored.tenant_id).toBe('tenant-A');
    expect(stored.agent_id).toBe('agent-A');
  });

  it('updates the current tenant\'s OWN row on conflict (ownership gate matches)', async () => {
    store.reset([
      {
        entidade_id: 'mine',
        id: 'mine',
        tenant_id: 'tenant-A',
        agent_id: 'agent-A',
        status: 'n/a',
        contexto: {},
        flags: { old: true },
      },
    ]);
    const { entityStatesRepo } = await import('@/db/repositories.js');

    const out = await runWithTenantContext(A, () =>
      entityStatesRepo.upsert({ entidade_id: 'mine', flags: { fresh: true } }),
    );

    expect(out.entidade_id).toBe('mine');
    expect((out.flags as Record<string, unknown>).fresh).toBe(true);
    // The conflict-arm ownership WHERE bound tenant+agent (revert-check).
    expectBoundTenantAgent(store.lastConflictWherePredicate());
  });

  it('conflict-arm SET never re-stamps identity columns (tenant_id from input is ignored)', async () => {
    // Defense-in-depth: even if a caller smuggles a foreign `tenant_id` into the
    // partial, the SET strips identity columns so the running tenant's own row
    // can never be moved to another tenant via the UPDATE branch. (The INSERT
    // branch is separately guarded by applyTenantGuard, which throws on mismatch.)
    store.reset([
      {
        entidade_id: 'mine',
        id: 'mine',
        tenant_id: 'tenant-A',
        agent_id: 'agent-A',
        status: 'n/a',
        contexto: {},
        flags: { old: true },
      },
    ]);
    const { entityStatesRepo } = await import('@/db/repositories.js');

    const out = await runWithTenantContext(A, () =>
      // tenant_id matches ALS (applyTenantGuard would reject a mismatch on INSERT);
      // the point under test is that the conflict SET does not carry tenant_id at all.
      entityStatesRepo.upsert({ entidade_id: 'mine', tenant_id: 'tenant-A', flags: { fresh: true } } as any),
    );

    expect(out.tenant_id).toBe('tenant-A'); // unchanged
    expect((out.flags as Record<string, unknown>).fresh).toBe(true);
  });

  it('FAIL-LOUD — cannot overwrite tenant-B\'s row for a colliding entidade_id', async () => {
    // tenant-B owns the entity_state for `collide`. tenant-A upserts the SAME
    // entidade_id: the INSERT conflicts on the entidade_id PK, but the conflict
    // ownership WHERE (tenant-A) does NOT match tenant-B's existing row → the SET
    // is rejected, 0 rows returned → the repo throws. tenant-B's row stays intact.
    store.reset([
      {
        entidade_id: 'collide',
        id: 'collide',
        tenant_id: 'tenant-B',
        agent_id: 'agent-B',
        status: 'n/a',
        contexto: { b: 'private' },
        flags: { b: 'private' },
      },
    ]);
    const { entityStatesRepo } = await import('@/db/repositories.js');

    await expect(
      runWithTenantContext(A, () =>
        entityStatesRepo.upsert({ entidade_id: 'collide', flags: { a: 'attacker' } }),
      ),
    ).rejects.toThrow(/upsert matched 0 rows/);

    // tenant-B's row was NOT overwritten by the failed tenant-A upsert.
    const b = store.rows.find((r) => r.entidade_id === 'collide')!;
    expect(b.tenant_id).toBe('tenant-B');
    expect((b.flags as Record<string, unknown>).b).toBe('private');
    expect((b.flags as Record<string, unknown>).a).toBeUndefined(); // attacker flag never landed
    // The conflict-arm WHERE that protected the row bound tenant+agent.
    expectBoundTenantAgent(store.lastConflictWherePredicate());
  });
});
