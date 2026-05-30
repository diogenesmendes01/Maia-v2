/**
 * Issue #345 (Phase 4, defense-in-depth) — Cross-tenant MUTATION isolation for
 * `rollbackWorkflow()` (`src/workflows/engine.ts`).
 *
 * Product invariant (project north star):
 *   "Maias de empresas diferentes NUNCA se comunicam, compartilham dados ou
 *    herdam aprendizado. Sem exceção."
 *
 * `rollbackWorkflow()` cancels every unfinished `workflow_steps` row of a failing
 * workflow via a RAW `db.update(workflow_steps)`. Before this fix that UPDATE was
 * scoped by the step `id` ALONE — no tenant predicate. It is safe in practice
 * today (the ids come from `workflowStepsRepo.byWorkflow()` for a workflow already
 * verified against the current tenant+agent via `workflowsRepo.byId()`, and it is
 * not reachable from the tick path), BUT the inviolable isolation standard wants
 * every mutation to self-enforce scope — the same hardening applied to
 * `updateStateTx` (#337), `conversasRepo.close` / `expireDue` (#350).
 *
 * THIS is the test that would have caught the gap: it drives the REAL
 * `rollbackWorkflow` (+ REAL `workflowsRepo.byId` / `workflowStepsRepo.byWorkflow`
 * / `workflowsRepo.setStatus`) against the shared `_tenant-mutation-store` whose
 * SELECT/UPDATE evaluate the ACTUAL drizzle predicate. A foreign-tenant
 * `workflow_steps` row is seeded; rolling back tenant A's workflow under tenant
 * A's context must leave tenant B's step UNTOUCHED. An id-only WHERE would cancel
 * tenant B's step (it shares the same step `id`) and the assertion would fail.
 *
 * It also captures the exact predicate of the `workflow_steps` UPDATE (by table
 * reference identity — no name introspection) and asserts it binds BOTH
 * `tenant_id` and `agent_id`, so a future predicate regression can't silently
 * pass even if the seeded ids happened not to collide.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { workflow_steps } from '@/db/schema.js';
import {
  makeTenantScopedUpdateStore,
  parsePredicate as parsePredicateForTest,
  type StoreRow,
} from './_tenant-mutation-store.js';

// Store-backed `db` (select + update) shared across the engine reads + writes the
// REAL `rollbackWorkflow` performs. We wrap `update` so we can record EACH UPDATE
// predicate keyed by the drizzle table reference — `rollbackWorkflow` fires two
// distinct UPDATEs (the `workflow_steps` step-cancel and, via setStatus, the
// `workflows` status-write); the store's own `lastPredicate()` only keeps the
// most recent, so we capture the step UPDATE explicitly.
const mutationStore = makeTenantScopedUpdateStore();

/** Predicate captured from the most recent UPDATE whose table === workflow_steps. */
let lastStepUpdatePredicate: unknown = undefined;
/** Predicate captured from the most recent SELECT whose target === workflow_steps. */
const dbUpdateMock = vi.fn((table: unknown) => {
  const inner = mutationStore.db.update(table) as {
    set: (patch: Record<string, unknown>) => { where: (p: unknown) => unknown };
  };
  return {
    set: (patch: Record<string, unknown>) => {
      const built = inner.set(patch);
      return {
        where: (predicate: unknown) => {
          if (table === workflow_steps) lastStepUpdatePredicate = predicate;
          return built.where(predicate);
        },
      };
    },
  };
});

vi.mock('@/db/client.js', () => ({
  db: {
    select: (...args: unknown[]) => mutationStore.db.select(...args),
    update: (...args: unknown[]) => dbUpdateMock(...args),
  },
  withTx: async (fn: (tx: unknown) => unknown) => fn(mutationStore.db),
}));

// Keep the REAL repositories so `workflowsRepo.byId`, `workflowStepsRepo.byWorkflow`
// and `workflowsRepo.setStatus` build + run their REAL tenant-scoped WHERE clauses
// against the store. Nothing in this module needs overriding.

// Defensive stubs — `rollbackWorkflow` calls `audit()` (which would otherwise
// write audit_log through the same `db` mock); stub it so the assertions stay
// focused on `workflow_steps`. Logger is silenced.
vi.mock('@/governance/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const A = { tenant_id: 'tenant-A', agent_id: 'agent-A' } as const;

// A workflow row (read by workflowsRepo.byId). `em_andamento` is NOT a terminal
// status, so rollback proceeds past its early-return guard.
const wfRow = (over: Partial<StoreRow>): StoreRow => ({
  id: 'wf',
  tenant_id: 'tenant-A',
  agent_id: 'agent-A',
  tipo: 'generico',
  status: 'em_andamento',
  ...over,
});

// A workflow_steps row (read by workflowStepsRepo.byWorkflow, cancelled by the
// raw UPDATE under test). `workflow_id` lets byWorkflow's predicate pick it up;
// `ordem`/`descricao` satisfy the WorkflowStep shape the engine reads.
const stepRow = (over: Partial<StoreRow>): StoreRow => ({
  id: 'step',
  tenant_id: 'tenant-A',
  agent_id: 'agent-A',
  workflow_id: 'wf',
  ordem: 1,
  descricao: 'passo',
  status: 'pendente',
  resultado: null,
  iniciado_em: null,
  concluido_em: null,
  ...over,
});

describe('Issue #345 — rollbackWorkflow mutates ONLY the current tenant/agent steps', () => {
  beforeEach(() => {
    lastStepUpdatePredicate = undefined;
    dbUpdateMock.mockClear();
    mutationStore.reset([
      // Tenant A's workflow (the one being rolled back) and its pending step.
      wfRow({ id: 'wf', tenant_id: 'tenant-A', agent_id: 'agent-A' }),
      stepRow({ id: 'A-step', workflow_id: 'wf', tenant_id: 'tenant-A', agent_id: 'agent-A' }),
      // FOREIGN tenant: a DIFFERENT tenant whose step shares the SAME workflow_id
      // AND the same primary-key `id` as tenant-A's step. An id-only UPDATE would
      // cancel THIS row too — the cross-tenant breach this test exists to catch.
      stepRow({ id: 'A-step', workflow_id: 'wf', tenant_id: 'tenant-B', agent_id: 'agent-B' }),
      // Same tenant, DIFFERENT agent — must also stay untouched.
      stepRow({ id: 'A-step', workflow_id: 'wf', tenant_id: 'tenant-A', agent_id: 'agent-Z' }),
    ]);
  });

  it('rolling back tenant-A/agent-A cancels ONLY its own pending step', async () => {
    const { rollbackWorkflow } = await import('@/workflows/engine.js');
    await runWithTenantContext(A, () => rollbackWorkflow('wf', 'test reason'));

    const step = (tenant: string, agent: string) =>
      mutationStore.rows.find(
        (r) => r.id === 'A-step' && r.tenant_id === tenant && r.agent_id === agent,
      )!;

    // Tenant-A/agent-A's pending step was cancelled by the rollback.
    expect(step('tenant-A', 'agent-A').status).toBe('cancelada');
    expect(step('tenant-A', 'agent-A').concluido_em).toBeInstanceOf(Date);
    // Cross-tenant isolation: the foreign tenant's identically-keyed step is intact.
    expect(step('tenant-B', 'agent-B').status).toBe('pendente');
    expect(step('tenant-B', 'agent-B').concluido_em).toBeNull();
    // …and tenant-A's OTHER agent is likewise untouched.
    expect(step('tenant-A', 'agent-Z').status).toBe('pendente');
    expect(step('tenant-A', 'agent-Z').concluido_em).toBeNull();
  });

  it("the workflow_steps UPDATE predicate binds tenant_id AND agent_id (not id alone)", async () => {
    const { rollbackWorkflow } = await import('@/workflows/engine.js');
    await runWithTenantContext(A, () => rollbackWorkflow('wf', 'test reason'));

    expect(lastStepUpdatePredicate).toBeDefined();
    const terms = parsePredicateForTest(lastStepUpdatePredicate);
    expect(terms).toContainEqual({ kind: 'eq', column: 'tenant_id', value: 'tenant-A' });
    expect(terms).toContainEqual({ kind: 'eq', column: 'agent_id', value: 'agent-A' });
    // The original id predicate is still present (scope is ADDED, not swapped).
    expect(terms).toContainEqual({ kind: 'eq', column: 'id', value: 'A-step' });
  });
});
