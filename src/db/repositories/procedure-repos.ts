import { eq, and, desc, sql, lt, ne } from 'drizzle-orm';
import { db, withTx } from '../client.js';
import { procedure_status_events } from '../schema.js';
import {
  procedure_definitions,
  procedure_assignments,
  procedure_executions,
  procedure_execution_events,
  procedure_selector_decisions,
  procedure_tests,
  procedure_metrics,
} from '../schema.js';
import { applyTenantGuard } from '../tenant-guard.js';
import { getCurrentTenant, getCurrentAgent } from '../tenant-context.js';
import type {
  ProcedureDefinition,
  ProcedureAssignment,
  ProcedureExecution,
  ProcedureExecutionEvent,
  ProcedureSelectorDecision,
  ProcedureTest,
  ProcedureMetric,
  ProcedureStatusEvent,
  ProcedureStatusUpdate,
} from '../schema.js';
import { OptimisticLockError } from './core.js';
import type { ProcedureStatus } from './core.js';

export const procedureDefinitionsRepo = {
  async create(
    input: Omit<ProcedureDefinition, 'id' | 'created_at' | 'updated_at' | 'tenant_id' | 'agent_id'>,
  ): Promise<ProcedureDefinition> {
    const guarded = applyTenantGuard(input);
    const [row] = await db
      .insert(procedure_definitions)
      .values(guarded as typeof procedure_definitions.$inferInsert)
      .returning();
    return row!;
  },

  async findActiveByName(nome: string): Promise<ProcedureDefinition | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(procedure_definitions)
      .where(and(
        eq(procedure_definitions.tenant_id, tenant_id),
        eq(procedure_definitions.agent_id, agent_id),
        eq(procedure_definitions.nome, nome),
        eq(procedure_definitions.status, 'active'),
      ))
      .orderBy(desc(procedure_definitions.version_number))
      .limit(1);
    return rows[0] ?? null;
  },

  /**
   * Tenant-scoped findById. Returns null if the row exists but belongs
   * to a different tenant/agent (P83-H5: prevent cross-tenant access by id).
   */
  async findById(id: string): Promise<ProcedureDefinition | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(procedure_definitions)
      .where(and(
        eq(procedure_definitions.id, id),
        eq(procedure_definitions.tenant_id, tenant_id),
        eq(procedure_definitions.agent_id, agent_id),
      ))
      .limit(1);
    return rows[0] ?? null;
  },

  async listByStatus(status: string, limit = 100): Promise<ProcedureDefinition[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(procedure_definitions)
      .where(and(
        eq(procedure_definitions.tenant_id, tenant_id),
        eq(procedure_definitions.agent_id, agent_id),
        eq(procedure_definitions.status, status),
      ))
      .orderBy(desc(procedure_definitions.created_at))
      .limit(limit);
  },

  /**
   * Tenant-scoped status update. (P83-H5)
   * Returns number of affected rows so callers can detect cross-tenant
   * attempts (0 rows updated = id belongs to another tenant or doesn't exist).
   */
  async updateStatus(id: string, updates: ProcedureStatusUpdate): Promise<number> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .update(procedure_definitions)
      .set({ ...updates, updated_at: new Date() })
      .where(and(
        eq(procedure_definitions.id, id),
        eq(procedure_definitions.tenant_id, tenant_id),
        eq(procedure_definitions.agent_id, agent_id),
      ))
      .returning({ id: procedure_definitions.id });
    return rows.length;
  },

  async listAllVersionsByName(nome: string): Promise<ProcedureDefinition[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(procedure_definitions)
      .where(and(
        eq(procedure_definitions.tenant_id, tenant_id),
        eq(procedure_definitions.agent_id, agent_id),
        eq(procedure_definitions.nome, nome),
      ))
      .orderBy(desc(procedure_definitions.version_number));
  },

  /**
   * Atomically activate `target_id` and freeze any other active version
   * of the same `nome` within the same tenant/agent. The whole operation
   * runs in a single transaction with row-level locking so concurrent
   * approvers cannot leave two rows in `status='active'`. Combined with
   * the UNIQUE partial index `procedure_def_active_uniq_idx`, this makes
   * dual-active a hard impossibility at both the application and DB
   * layers. (P83-C4)
   */
  async atomicActivate(args: {
    target_id: string;
    actor: string;
    preserve_activated_at?: boolean;
    expected_from_status: ProcedureStatus;
  }): Promise<{
    activated: ProcedureDefinition;
    deactivated: ProcedureDefinition | null;
  }> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const now = new Date();

    return withTx(async (tx) => {
      // 1) Lock the row we want to activate FOR UPDATE. Also confirms
      // tenant-scope.
      const targetRows = await tx
        .select()
        .from(procedure_definitions)
        .where(and(
          eq(procedure_definitions.id, args.target_id),
          eq(procedure_definitions.tenant_id, tenant_id),
          eq(procedure_definitions.agent_id, agent_id),
        ))
        .for('update');
      const target = targetRows[0];
      if (!target) {
        throw new Error(`procedure_definition ${args.target_id} not found in current tenant`);
      }

      // Round-3 fix: after acquiring the row lock, verify the persisted status
      // still matches what the caller observed at read time (owned.status). If a
      // concurrent transaction already advanced the row — including to a terminal
      // state like rolled_back — this guard catches the race and throws instead of
      // silently promoting a terminal row to active.
      if (target.status !== args.expected_from_status) {
        throw new OptimisticLockError(
          `atomicActivate: locked row status='${target.status}' does not match expected_from_status='${args.expected_from_status}' for procedure ${args.target_id} — concurrent write raced ahead`,
        );
      }

      // 2) Lock any currently active sibling rows (same nome) so two
      // concurrent activations serialize on this set.
      const activeSiblings = await tx
        .select()
        .from(procedure_definitions)
        .where(and(
          eq(procedure_definitions.tenant_id, tenant_id),
          eq(procedure_definitions.agent_id, agent_id),
          eq(procedure_definitions.nome, target.nome),
          eq(procedure_definitions.status, 'active'),
          ne(procedure_definitions.id, target.id),
        ))
        .for('update');

      let deactivated: ProcedureDefinition | null = null;
      if (activeSiblings.length > 0) {
        // Migrate constraint guarantees at most one, but we defensively
        // handle a list. Freeze each, then return the first as the
        // deactivated row.
        for (const sib of activeSiblings) {
          const [updated] = await tx
            .update(procedure_definitions)
            .set({ status: 'frozen', deactivated_at: now, updated_at: now })
            .where(eq(procedure_definitions.id, sib.id))
            .returning();
          if (updated && !deactivated) deactivated = updated;
        }
      }

      // 3) Promote the target to active. Preserve original activated_at
      // if it was already set (H1 — keep first-activation timestamp).
      const setPayload: ProcedureStatusUpdate & { updated_at: Date } = {
        status: 'active',
        approved_by: args.actor,
        approved_at: now,
        deactivated_at: null,
        updated_at: now,
      };
      if (!args.preserve_activated_at || target.activated_at == null) {
        setPayload.activated_at = now;
      }
      const [activated] = await tx
        .update(procedure_definitions)
        .set(setPayload)
        .where(eq(procedure_definitions.id, target.id))
        .returning();
      if (!activated) {
        throw new Error(`procedure_definition ${target.id} disappeared mid-transaction`);
      }

      // 4) Append event-sourcing rows for the audit trail (H2).
      await tx.insert(procedure_status_events).values({
        tenant_id,
        agent_id,
        definition_id: target.id,
        from_status: target.status,
        to_status: 'active',
        actor: args.actor,
      });
      if (deactivated) {
        await tx.insert(procedure_status_events).values({
          tenant_id,
          agent_id,
          definition_id: deactivated.id,
          from_status: 'active',
          to_status: 'frozen',
          actor: args.actor,
          reason: `superseded by ${target.id}`,
        });
      }

      return { activated, deactivated };
    });
  },
};

export const procedureStatusEventsRepo = {
  async record(input: {
    definition_id: string;
    from_status: string;
    to_status: string;
    actor: string;
    reason?: string;
  }): Promise<void> {
    const guarded = applyTenantGuard({
      definition_id: input.definition_id,
      from_status: input.from_status,
      to_status: input.to_status,
      actor: input.actor,
      reason: input.reason ?? null,
    });
    await db.insert(procedure_status_events).values(guarded);
  },

  async listByDefinition(definition_id: string): Promise<ProcedureStatusEvent[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(procedure_status_events)
      .where(and(
        eq(procedure_status_events.tenant_id, tenant_id),
        eq(procedure_status_events.agent_id, agent_id),
        eq(procedure_status_events.definition_id, definition_id),
      ))
      .orderBy(desc(procedure_status_events.occurred_at));
  },
};

export const procedureAssignmentsRepo = {
  /**
   * Create an assignment. P83-H6: refuses to assign a procedure whose
   * `definition_id` belongs to a different tenant. The FK only enforces
   * referential integrity, not tenant-isolation, so we cross-check here.
   */
  async create(
    input: Omit<ProcedureAssignment, 'id' | 'activated_at' | 'tenant_id'>,
  ): Promise<ProcedureAssignment> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();

    // Verify the referenced definition is in the caller's tenant.
    const defRows = await db
      .select({
        id: procedure_definitions.id,
        tenant_id: procedure_definitions.tenant_id,
        agent_id: procedure_definitions.agent_id,
      })
      .from(procedure_definitions)
      .where(eq(procedure_definitions.id, input.definition_id))
      .limit(1);
    const def = defRows[0];
    if (!def) {
      throw new Error(`procedure_definition ${input.definition_id} does not exist`);
    }
    if (def.tenant_id !== tenant_id || def.agent_id !== agent_id) {
      throw new Error(
        `cross-tenant assignment refused: definition ${input.definition_id} belongs to a different tenant/agent`,
      );
    }

    const [row] = await db
      .insert(procedure_assignments)
      .values({ ...input, tenant_id } as typeof procedure_assignments.$inferInsert)
      .returning();
    return row!;
  },

  async listForTarget(target_type: string, target_id: string): Promise<ProcedureAssignment[]> {
    const tenant_id = getCurrentTenant();
    return db
      .select()
      .from(procedure_assignments)
      .where(and(
        eq(procedure_assignments.tenant_id, tenant_id),
        eq(procedure_assignments.target_type, target_type),
        eq(procedure_assignments.target_id, target_id),
        eq(procedure_assignments.enabled, true),
      ));
  },

  async disable(id: string): Promise<void> {
    // Flip-readiness (#323, H4 of #355) — TENANT-ONLY scope. NOTE: the
    // `procedure_assignments` table has a `tenant_id` column but NO `agent_id`
    // column (schema) — assignments are tenant-scoped, not agent-scoped (the
    // agent dimension lives on the referenced `procedure_definitions`, which
    // `create` cross-checks). So this WHERE binds `tenant_id` ONLY, exactly
    // matching the already-scoped `listForTarget` / `create` on this same table.
    // `tenant_id` is NOT NULL. This method has NO live caller in `src` today
    // (repo governance surface); because it now READS ALS, any FUTURE caller MUST
    // run inside `runWithTenantContext` (an unwrapped caller throws
    // MissingTenantContextError).
    //
    // FAIL-LOUD (throw on !=1): disabling sets `enabled=false` + `deactivated_at`
    // on one specific assignment id, removing it from `listForTarget` (which
    // filters `enabled=true`). A 0-row result under the tenant predicate means
    // the id is NOT owned by the running tenant — a cross-tenant disable that
    // must be surfaced, not silently swallowed (which would report the
    // assignment as disabled while it stayed active for its real owner). Same
    // `.returning({id})` + `.length` idiom as `mensagensRepo.markProcessed`.
    const tenant_id = getCurrentTenant();
    const updated = await db
      .update(procedure_assignments)
      .set({ enabled: false, deactivated_at: new Date() })
      .where(
        and(
          eq(procedure_assignments.id, id),
          eq(procedure_assignments.tenant_id, tenant_id),
        ),
      )
      .returning({ id: procedure_assignments.id });
    if (updated.length !== 1) {
      throw new Error(
        `procedureAssignmentsRepo.disable matched ${updated.length} rows for assignment ${id} ` +
          `under tenant ${tenant_id} — expected 1 (tenant context does not match the target ` +
          `assignment; the disable would have been silently lost while the assignment stayed ` +
          `active for its real owner)`,
      );
    }
  },
};

export const procedureExecutionsRepo = {
  async create(
    input: Omit<ProcedureExecution, 'id' | 'started_at' | 'last_activity_at' | 'tenant_id' | 'agent_id'>,
  ): Promise<ProcedureExecution> {
    const guarded = applyTenantGuard(input);
    const [row] = await db.insert(procedure_executions).values(guarded as any).returning();
    return row!;
  },

  async findActiveForConversa(conversa_id: string): Promise<ProcedureExecution | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(procedure_executions)
      .where(and(
        eq(procedure_executions.tenant_id, tenant_id),
        eq(procedure_executions.agent_id, agent_id),
        eq(procedure_executions.conversa_id, conversa_id),
        eq(procedure_executions.status, 'in_progress'),
      ))
      .orderBy(desc(procedure_executions.last_activity_at))
      .limit(1);
    return rows[0] ?? null;
  },

  // P84-C1: tenant-scoped read. The previous implementation queried by id
  // alone — UUID collisions are astronomically unlikely but the project's
  // tenant-isolation invariant is structural, not probabilistic. Every
  // cross-tenant query path must be closed by code.
  async findById(id: string): Promise<ProcedureExecution | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(procedure_executions)
      .where(and(
        eq(procedure_executions.id, id),
        eq(procedure_executions.tenant_id, tenant_id),
        eq(procedure_executions.agent_id, agent_id),
      ))
      .limit(1);
    return rows[0] ?? null;
  },

  // P84-C2: tenant-scoped create with ON CONFLICT no-op on the
  // (tenant,agent,conversa) WHERE status='in_progress' partial unique index
  // shipped in migration 023. When two workers race and both see
  // activeExecution=null → both call startExecution, the second insert is
  // rejected by the constraint; we swallow it and return null so the caller
  // re-loads the active row.
  async createOrFindActive(
    input: Omit<ProcedureExecution, 'id' | 'started_at' | 'last_activity_at' | 'tenant_id' | 'agent_id'>,
  ): Promise<{ execution: ProcedureExecution; created: boolean }> {
    const guarded = applyTenantGuard(input);
    const rows = await db
      .insert(procedure_executions)
      .values(guarded as any)
      .onConflictDoNothing({
        target: [
          procedure_executions.tenant_id,
          procedure_executions.agent_id,
          procedure_executions.conversa_id,
        ],
        // index_predicate for the partial unique index defined in
        // migration 023_p3b_unique_in_progress_per_conversa.sql. The
        // predicate MUST match the migration's `WHERE` exactly so Postgres'
        // partial-index inference engine can match this ON CONFLICT to the
        // index — relying on column-presence inference alone is brittle.
        where: sql`status = 'in_progress' AND conversa_id IS NOT NULL`,
      })
      .returning();

    if (rows[0]) {
      return { execution: rows[0], created: true };
    }

    // Conflict path: another worker created an in_progress execution for
    // the same conversa concurrently. Re-load and return it. conversa_id
    // is guaranteed non-null here because the partial index only applies
    // when conversa_id IS NOT NULL (and a null conversa_id can't conflict).
    if (guarded.conversa_id == null) {
      throw new Error('procedureExecutionsRepo.createOrFindActive: insert returned no row and conversa_id is null');
    }
    const existing = await procedureExecutionsRepo.findActiveForConversa(guarded.conversa_id as string);
    if (!existing) {
      throw new Error('procedureExecutionsRepo.createOrFindActive: conflict but no active row found');
    }
    return { execution: existing, created: false };
  },

  // P84-C5 / P3c fix P85-I1: transaction-aware variant. When called from
  // inside a withTx() block, all writes commit together with the caller's
  // events. Used by the engine (advance/complete/abort) and by the reaper
  // (auto_abandoned event + status update must be atomic — without this, a
  // process crash between event-write and status-write produces a duplicate
  // auto_abandoned event on the next reaper tick).
  async updateStateTx(
    tx: typeof db,
    id: string,
    updates: Partial<{
      current_step_id: string | null;
      execution_state: any;
      completed_steps: any;
      last_activity_at: Date;
      status: string;
      outcome: string;
      ended_at: Date;
      notes: string;
    }>,
  ): Promise<void> {
    // Issue #323 review (BLOCKING): tenant- AND agent-scope the WHERE.
    // Previously this write matched on `id` alone, relying solely on the
    // caller's AsyncLocalStorage context for isolation. Tenant isolation is
    // a structural (not probabilistic) invariant of this system, so it must
    // be enforced defense-in-depth at the DB layer — mirroring the sibling
    // reads `findById`/`findActiveForConversa`/`listStaleInProgress`, which
    // all gate on (tenant_id, agent_id). agent_id is included because every
    // caller of updateStateTx runs inside runWithTenantContext with a REAL
    // agent: the reaper (procedure-execution-reaper.ts) enumerates real
    // (tenant,agent) tuples from the work table, and the engine
    // (advance/complete/abort) only acts on an execution it loaded via the
    // agent-scoped findById/findActiveForConversa first. Uses the composite
    // `procedure_exec_tenant_agent_status_idx`.
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    // Issue #323 review iteration-2 (BLOCKING): assert the write hit exactly
    // one row. With the tenant+agent predicate above, an UPDATE issued under a
    // context whose (tenant_id, agent_id) does NOT match the target row (a
    // single-tenant default/default path, or any other mismatch) matches 0 rows
    // and would SILENTLY no-op — the state transition
    // (complete/abort/advance/auto_abandon) would be LOST. The previous id-only
    // WHERE always matched, so a silent miss here is a data-loss regression.
    // Turn that into a loud, debuggable failure while preserving tenant
    // isolation. We DELIBERATELY do NOT add `status` to the WHERE: that would
    // break legitimate repeated/idempotent transitions and conflict with this
    // exactly-one assertion. Uses the same `.returning({ id })` + `.length`
    // idiom as the sibling compare-and-swap writes in this file (e.g.
    // adoptToResolvedTenantCrossTenant / channelsRepo.deactivate) — `.length`
    // is the portable row count (node-postgres `rowCount` is typed `number |
    // null`). In legitimate single-tenant operation the row IS default/default,
    // so the predicate matches and length === 1.
    const updated = await tx
      .update(procedure_executions)
      .set({ ...updates, last_activity_at: new Date() } as any)
      .where(and(
        eq(procedure_executions.id, id),
        eq(procedure_executions.tenant_id, tenant_id),
        eq(procedure_executions.agent_id, agent_id),
      ))
      .returning({ id: procedure_executions.id });
    if (updated.length !== 1) {
      throw new Error(
        `procedureExecutionsRepo.updateStateTx matched ${updated.length} rows ` +
          `for execution ${id} under ${tenant_id}/${agent_id} — expected 1 ` +
          `(tenant/agent context does not match the target row; the state ` +
          `transition would have been silently lost)`,
      );
    }
  },

  // P3c Task 9 — reaper helper. Retorna execuções do (tenant, agent) atual
  // ainda em status='in_progress' cuja last_activity_at < now() - ttl_days.
  // Workers chamam dentro de runWithTenantContext para isolar por par.
  //
  // Issue #323 (Phase 3): a query agora filtra por agent_id ADEMAIS de
  // tenant_id. Antes só filtrava tenant_id — o reaper rodava sob o agent
  // 'default' e varria as execuções de TODOS os agents do tenant numa única
  // passada, gravando o event `auto_abandoned` com agent_id='default' (audit
  // mis-attribution: o event de um agent real ficava carimbado como 'default').
  // Com o worker agora iterando tuplas (tenant, agent) reais, esta query
  // PRECISA escopar por agent — senão cada uma das N iterações por tenant
  // reprocessaria o mesmo conjunto tenant-wide (N× trabalho + N× events).
  // Usa o índice `procedure_exec_tenant_agent_status_idx
  // (tenant_id, agent_id, status, last_activity_at)`.
  //
  // PR #85 fix P85-I6: cap result size with `limit` (default 1000) to keep
  // the per-tick cost bounded. After a long outage this prevents one cron
  // tick from grinding through tens of thousands of stale rows in a single
  // sequential pass and overlapping with the next tick. Reaper is
  // idempotent across runs (combined with P85-I1's transactional write),
  // so the leftover backlog drains on subsequent ticks.
  async listStaleInProgress(opts: {
    ttl_days: number;
    limit?: number;
  }): Promise<ProcedureExecution[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const cutoff = new Date(Date.now() - opts.ttl_days * 86_400_000);
    const cap = opts.limit ?? 1000;
    return db
      .select()
      .from(procedure_executions)
      .where(
        and(
          eq(procedure_executions.tenant_id, tenant_id),
          eq(procedure_executions.agent_id, agent_id),
          eq(procedure_executions.status, 'in_progress'),
          lt(procedure_executions.last_activity_at, cutoff),
        ),
      )
      .limit(cap);
  },
};

export const procedureExecutionEventsRepo = {
  async record(
    input: Omit<ProcedureExecutionEvent, 'id' | 'created_at' | 'tenant_id' | 'agent_id'>,
  ): Promise<void> {
    const guarded = applyTenantGuard(input);
    await db.insert(procedure_execution_events).values(guarded as any);
  },

  // P84-C5 / P3c fix P85-I1: transaction-aware variant. Lets the engine
  // commit recordEvent+updateState atomically inside withTx(), and lets the
  // reaper atomically pair the audit-event INSERT with the
  // procedure-execution UPDATE. The applyTenantGuard call still binds
  // tenant/agent from AsyncLocalStorage so tenant isolation is preserved
  // across the transaction boundary.
  async recordTx(
    tx: typeof db,
    input: Omit<ProcedureExecutionEvent, 'id' | 'created_at' | 'tenant_id' | 'agent_id'>,
  ): Promise<void> {
    const guarded = applyTenantGuard(input);
    await tx.insert(procedure_execution_events).values(guarded as any);
  },

  // P84-C1: tenant-scoped read. Mirror the pattern in findById — never
  // trust the execution_id alone, even though FKs make a cross-tenant
  // collision unlikely. Audit trail reads must respect tenant boundaries.
  async listByExecution(execution_id: string): Promise<ProcedureExecutionEvent[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(procedure_execution_events)
      .where(and(
        eq(procedure_execution_events.execution_id, execution_id),
        eq(procedure_execution_events.tenant_id, tenant_id),
        eq(procedure_execution_events.agent_id, agent_id),
      ))
      .orderBy(procedure_execution_events.created_at);
  },
};

export const procedureSelectorDecisionsRepo = {
  async record(
    input: Omit<ProcedureSelectorDecision, 'id' | 'decided_at' | 'tenant_id' | 'agent_id'>,
  ): Promise<void> {
    const guarded = applyTenantGuard(input);
    await db.insert(procedure_selector_decisions).values(guarded as any);
  },

  async recentByConversa(conversa_id: string, limit = 20): Promise<ProcedureSelectorDecision[]> {
    const tenant_id = getCurrentTenant();
    return db
      .select()
      .from(procedure_selector_decisions)
      .where(and(
        eq(procedure_selector_decisions.tenant_id, tenant_id),
        eq(procedure_selector_decisions.conversa_id, conversa_id),
      ))
      .orderBy(desc(procedure_selector_decisions.decided_at))
      .limit(limit);
  },
};

// P3c: procedure_tests — cenários executáveis usados como gate de promoção
// proposed → active. `recordRun` é chamado pelo test-runner; `allPassFor` é
// o predicado consultado por `transitionProcedureStatus` antes de ativar.
export const procedureTestsRepo = {
  async create(input: {
    definition_id: string;
    name: string;
    description?: string;
    scenario: unknown;
    expected_outcome: 'success' | 'failure' | 'partial' | 'escalated';
    expected_step_path?: unknown;
  }): Promise<ProcedureTest> {
    const guarded = applyTenantGuard({
      definition_id: input.definition_id,
      name: input.name,
      description: input.description ?? null,
      scenario: input.scenario as object,
      expected_outcome: input.expected_outcome,
      expected_step_path: (input.expected_step_path ?? null) as object | null,
    });
    const [row] = await db.insert(procedure_tests).values(guarded as any).returning();
    return row!;
  },

  async listByDefinition(definition_id: string): Promise<ProcedureTest[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(procedure_tests)
      .where(and(
        eq(procedure_tests.tenant_id, tenant_id),
        eq(procedure_tests.agent_id, agent_id),
        eq(procedure_tests.definition_id, definition_id),
      ))
      .orderBy(procedure_tests.created_at);
  },

  async recordRun(args: {
    id: string;
    status: 'pass' | 'fail' | 'error' | 'skipped';
    details: unknown;
  }): Promise<void> {
    // Flip-readiness (#323, H4 of #355) — tenant+agent scope the WHERE (bound
    // from ALS), mirroring the already-scoped `listByDefinition` / `allPassFor`.
    // Both columns are NOT NULL (schema `procedure_tests`). The test id passed
    // here is always one the caller obtained from a tenant+agent-scoped read
    // (`create` / `listByDefinition`) within the same tenant context, so the row
    // belongs to the running tuple and the predicate matches it.
    //
    // FAIL-LOUD (throw on !=1): `recordRun` stamps one specific test's
    // last_run_status, which directly gates `allPassFor` (the proposed→active
    // promotion gate). A 0-row result under the new predicate can ONLY be a
    // tenant/agent mismatch (cross-tenant misroute), never a benign no-op. A
    // silent miss would leave the test's status stale, corrupting the promotion
    // gate (a procedure could be promoted on a never-updated 'pass', or blocked
    // forever) while reporting the run as recorded — so surface it loudly. Same
    // `.returning({id})` + `.length` idiom as `mensagensRepo.markProcessed`.
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const updated = await db
      .update(procedure_tests)
      .set({
        last_run_at: new Date(),
        last_run_status: args.status,
        last_run_details: args.details as object,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(procedure_tests.id, args.id),
          eq(procedure_tests.tenant_id, tenant_id),
          eq(procedure_tests.agent_id, agent_id),
        ),
      )
      .returning({ id: procedure_tests.id });
    if (updated.length !== 1) {
      throw new Error(
        `procedureTestsRepo.recordRun matched ${updated.length} rows for test ${args.id} ` +
          `under ${tenant_id}/${agent_id} — expected 1 (tenant/agent context does not match the ` +
          `target test; the run would have been silently lost, leaving last_run_status stale and ` +
          `corrupting the proposed→active promotion gate while reported as recorded)`,
      );
    }
  },

  // True iff there's >=1 test AND ALL have last_run_status='pass'.
  // Used as gate before promoting proposed → active.
  async allPassFor(definition_id: string): Promise<boolean> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select({ last_run_status: procedure_tests.last_run_status })
      .from(procedure_tests)
      .where(and(
        eq(procedure_tests.tenant_id, tenant_id),
        eq(procedure_tests.agent_id, agent_id),
        eq(procedure_tests.definition_id, definition_id),
      ));
    if (rows.length === 0) return false;
    return rows.every((r) => r.last_run_status === 'pass');
  },

  async delete(id: string): Promise<void> {
    // Flip-readiness (#323, H4 of #355) — tenant+agent scope the WHERE (bound
    // from ALS), mirroring the already-scoped `listByDefinition` / `allPassFor`.
    // Both columns are NOT NULL (schema `procedure_tests`). The id passed here is
    // always one the caller obtained from a tenant+agent-scoped read within the
    // same tenant context, so the row belongs to the running tuple. This is a
    // DELETE — without the predicate an id-only WHERE could remove ANOTHER
    // tenant's test row entirely (irreversible cross-tenant data loss), so the
    // (tenant_id, agent_id, id) predicate is the load-bearing isolation guard
    // and stays.
    //
    // IDEMPOTENT (#355 H5, H4 review follow-up): a 0-row result is a benign
    // no-op, NOT an error. The predicate already guarantees we can only ever
    // touch this tuple's own row, so a 0-row delete means the row is simply
    // already gone — e.g. a concurrent second delete of the same id. Throwing on
    // !=1 turned that legitimate race into a spurious failure. DELETE is
    // naturally idempotent (target end-state: "row absent"), so we drop the
    // row-count assertion and let a missing row resolve to success.
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    await db
      .delete(procedure_tests)
      .where(
        and(
          eq(procedure_tests.id, id),
          eq(procedure_tests.tenant_id, tenant_id),
          eq(procedure_tests.agent_id, agent_id),
        ),
      );
  },
};

// P3c: procedure_metrics — read-only access to the materialized view.
// Refresh is owned by a worker; this repo only exposes reads, filtered by
// tenant/agent context (still applyTenantGuard-equivalent: every select
// includes tenant + agent from the AsyncLocalStorage).
export const procedureMetricsRepo = {
  async getByDefinition(definition_id: string): Promise<ProcedureMetric | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(procedure_metrics)
      .where(and(
        eq(procedure_metrics.tenant_id, tenant_id),
        eq(procedure_metrics.agent_id, agent_id),
        eq(procedure_metrics.definition_id, definition_id),
      ))
      .limit(1);
    return rows[0] ?? null;
  },

  async listByTenantAgent(): Promise<ProcedureMetric[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(procedure_metrics)
      .where(and(
        eq(procedure_metrics.tenant_id, tenant_id),
        eq(procedure_metrics.agent_id, agent_id),
      ));
  },
};
