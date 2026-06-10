import { eq, and, inArray, desc, sql } from 'drizzle-orm';
import { db } from '../client.js';
import {
  audit_log,
  workflows,
  workflow_steps,
  system_health_events,
  dead_letter_jobs,
  } from '../schema.js';
import { applyTenantGuard } from '../tenant-guard.js';
import {
  getCurrentTenant,
  getCurrentAgent,
  SYSTEM_TENANT_ID,
  SYSTEM_AGENT_ID,
} from '../tenant-context.js';
import type { AuditEntry, Workflow, WorkflowStep } from '../schema.js';

export const auditRepo = {
  async write(input: Omit<AuditEntry, 'id' | 'tenant_id' | 'agent_id' | 'created_at'>): Promise<void> {
    const guarded = applyTenantGuard(input);
    await db.insert(audit_log).values(guarded);
  },
  /**
   * Issue #366 — TRANSACTIONAL audit writer. Identical to `write` (same
   * `applyTenantGuard` tenant/agent stamping) but runs the INSERT on the passed
   * `tx` handle so the audit row commits (or rolls back) with the enclosing
   * `withTx`. Used by money-moving tools (`auditTx` in `governance/audit.ts`)
   * so a balance change can never commit without its audit row — and a failed
   * audit insert is fail-loud (it aborts the whole transaction). Mirrors the
   * `tenantsRepo.createWithAuditAtomic` precedent (admin_audit_log appended in
   * the same tx as the tenant insert, "else the audit row was lost forever").
   */
  async writeTx(
    tx: typeof db,
    input: Omit<AuditEntry, 'id' | 'tenant_id' | 'agent_id' | 'created_at'>,
  ): Promise<void> {
    const guarded = applyTenantGuard(input);
    await tx.insert(audit_log).values(guarded);
  },
  async listByPessoa(pessoa_id: string, n = 100): Promise<AuditEntry[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(audit_log)
      .where(
        and(
          eq(audit_log.tenant_id, tenant_id),
          eq(audit_log.agent_id, agent_id),
          eq(audit_log.pessoa_id, pessoa_id),
        ),
      )
      .orderBy(desc(audit_log.created_at))
      .limit(n);
  },
  async findByMensagemId(mensagem_id: string): Promise<AuditEntry[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(audit_log)
      .where(
        and(
          eq(audit_log.tenant_id, tenant_id),
          eq(audit_log.agent_id, agent_id),
          eq(audit_log.mensagem_id, mensagem_id),
        ),
      );
  },
  /**
   * Issue #345 (Phase 4 of #323) — dispatcher enumeration for `pattern-detector`.
   *
   * Returns the DISTINCT (tenant_id, agent_id) tuples with at least one
   * `audit_log` row in the SAME 24h window the inner scans. Each enumerated
   * tuple owns the audit rows `runPatternDetector`'s inner aggregates; the inner
   * then applies its own per-pattern `HAVING count(*) >= MIN_OCCURRENCES` filter
   * (a tuple may be enumerated yet emit no event if no single pattern clears the
   * threshold — that is a cheap no-op, not a correctness issue, and mirrors the
   * conversation-summarizer enumeration which also bounds only "has any work").
   *
   * Runs OUTSIDE tenant context (it IS the dispatcher); no tenant guard
   * (cross-tenant iteration is the worker's contract). Belt-and-suspenders
   * `tenant_id/agent_id IS NOT NULL` predicate mirrors #251/#292 (schema already
   * enforces NOT NULL with a legacy 'default' default; this guards against a
   * future schema relaxation). Before this fix the inner ran under a hardcoded
   * `tenant_id='default' AND agent_id='default'` literal, so real tenants' audit
   * patterns were NEVER reflected on.
   */
  async listTenantAgentPairsWithRecentAudit(): Promise<
    Array<{ tenant_id: string; agent_id: string }>
  > {
    const result = await db.execute<{ tenant_id: string; agent_id: string }>(sql`
      SELECT DISTINCT tenant_id, agent_id
      FROM ${audit_log}
      WHERE tenant_id IS NOT NULL
        AND agent_id IS NOT NULL
        AND created_at >= now() - interval '24 hours'
    `);
    return Array.from(
      result.rows as unknown as Array<{ tenant_id: string; agent_id: string }>,
    );
  },
};

export const workflowsRepo = {
  // P83-C7: tenant-scoped workflow reads/writes.
  async create(input: Omit<Workflow, 'id' | 'tenant_id' | 'agent_id' | 'iniciado_em' | 'concluido_em'>): Promise<Workflow> {
    const guarded = applyTenantGuard(input);
    const rows = await db.insert(workflows).values(guarded).returning();
    return rows[0]!;
  },
  async byId(id: string): Promise<Workflow | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(workflows)
      .where(and(
        eq(workflows.id, id),
        eq(workflows.tenant_id, tenant_id),
        eq(workflows.agent_id, agent_id),
      ))
      .limit(1);
    return rows[0] ?? null;
  },
  async setStatus(id: string, status: Workflow['status']): Promise<void> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const update: Record<string, unknown> = { status };
    if (status === 'concluido') update.concluido_em = new Date();
    await db
      .update(workflows)
      .set(update)
      .where(and(
        eq(workflows.id, id),
        eq(workflows.tenant_id, tenant_id),
        eq(workflows.agent_id, agent_id),
      ));
  },
  async listPending(): Promise<Workflow[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(workflows)
      .where(and(
        eq(workflows.tenant_id, tenant_id),
        eq(workflows.agent_id, agent_id),
        sql`status IN ('pendente','em_andamento','aguardando_humano','aguardando_terceiro')`,
      ));
  },
  /**
   * Issue #363 — tenant-scoped read of open workflows for a set of entidades,
   * for the `list_pending` LLM tool (whose result, incl. workflow `tipo`/intent
   * `tool`, is injected back into the prompt context). `entidade_id` is a GLOBAL
   * uuid, so the tool's old inline `inArray(workflows.entidade_id, …)` did NOT
   * scope by tenant — another tenant's workflow for a shared/guessed entidade
   * would leak into the LLM context (R2 contamination). Bind tenant+agent from
   * ALS (both NOT NULL) so the read returns ONLY the running tuple's rows. The
   * open-status set is kept in lock-step with `listPending()` above.
   */
  async listPendingForEntidades(entidades: string[], limit: number): Promise<Workflow[]> {
    if (entidades.length === 0) return [];
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(workflows)
      .where(and(
        eq(workflows.tenant_id, tenant_id),
        eq(workflows.agent_id, agent_id),
        inArray(workflows.entidade_id, entidades),
        sql`status IN ('pendente','em_andamento','aguardando_humano','aguardando_terceiro')`,
      ))
      .orderBy(desc(workflows.iniciado_em))
      .limit(limit);
  },
  /**
   * Issue #345 (Phase 4 of #323) — enumeration source for the
   * `workflow_engine_tick` dispatcher.
   *
   * Returns the DISTINCT (tenant_id, agent_id) tuples that own at least one
   * workflow in a status `tickEngine()` would process. The status set MUST stay
   * in lock-step with `listPending()` above (the engine's own "which workflows
   * are due" filter) — otherwise the dispatcher would UNDER-enumerate and a
   * tenant with due workflows would silently never get a tick. Read-only and
   * runs OUTSIDE any tenant context (the dispatcher calls it before opening
   * `runWithTenantContext` per tuple), so it cannot itself use the ALS getters;
   * it partitions the table by its own (tenant_id, agent_id) columns instead.
   */
  async listTenantAgentPairsWithActiveWorkflows(): Promise<
    Array<{ tenant_id: string; agent_id: string }>
  > {
    const result = await db.execute<{ tenant_id: string; agent_id: string }>(sql`
      SELECT DISTINCT tenant_id, agent_id
      FROM ${workflows}
      WHERE tenant_id IS NOT NULL
        AND agent_id IS NOT NULL
        AND status IN ('pendente', 'em_andamento', 'aguardando_humano', 'aguardando_terceiro')
    `);
    return Array.from(
      result.rows as unknown as Array<{ tenant_id: string; agent_id: string }>,
    );
  },
};

export const workflowStepsRepo = {
  async createMany(
    inputs: Omit<WorkflowStep, 'id' | 'tenant_id' | 'agent_id' | 'iniciado_em' | 'concluido_em'>[],
  ): Promise<WorkflowStep[]> {
    if (inputs.length === 0) return [];
    const guarded = inputs.map((i) => applyTenantGuard(i));
    return db.insert(workflow_steps).values(guarded).returning();
  },
  async byWorkflow(workflow_id: string): Promise<WorkflowStep[]> {
    // Issue #345 (Phase 4 of #323) inner-scoping audit: `workflow_steps` carries
    // BOTH tenant_id and agent_id (schema.ts), and this SELECT is reached from
    // the per-tenant `workflow_engine_tick` dispatcher via `tickEngine()`. Before
    // this fix the WHERE clause filtered ONLY by `workflow_id`, relying on the
    // caller having fetched the parent workflow within its own tenant. That is an
    // implicit, ALS-passthrough scoping — exactly the gap Batches A/C found to be
    // a real leak in sibling repos. Bind tenant_id + agent_id explicitly from the
    // ALS so the steps read can NEVER surface another tenant's rows, even if the
    // workflow_id were ever guessed/reused across tenants. TENANT ISOLATION IS
    // THE INVIOLABLE INVARIANT.
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(workflow_steps)
      .where(and(
        eq(workflow_steps.tenant_id, tenant_id),
        eq(workflow_steps.agent_id, agent_id),
        eq(workflow_steps.workflow_id, workflow_id),
      ))
      .orderBy(workflow_steps.ordem);
  },
};

export const healthRepo = {
  async record(input: {
    component: string;
    status: 'ok' | 'degraded' | 'down';
    duration_ms?: number;
    error?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await db.insert(system_health_events).values({
      // issue #323: health events are GLOBAL maintenance. Write under the
      // sanctioned 'system' bucket (the 'default' column-default they relied on
      // was dropped by migration 083). Callers may run without an ALS tenant
      // (HTTP healthcheck, boot), so stamp 'system' explicitly rather than via
      // getCurrentTenant() (which would throw outside a context).
      tenant_id: SYSTEM_TENANT_ID,
      agent_id: SYSTEM_AGENT_ID,
      component: input.component,
      status: input.status,
      duration_ms: input.duration_ms ?? null,
      error: input.error ?? null,
      metadata: input.metadata ?? {},
    });
  },
  async lastForComponent(component: string) {
    const rows = await db
      .select()
      .from(system_health_events)
      .where(eq(system_health_events.component, component))
      .orderBy(desc(system_health_events.created_at))
      .limit(1);
    return rows[0] ?? null;
  },
};

export const dlqRepo = {
  async add(input: {
    queue_name: string;
    job_id: string;
    payload: unknown;
    error: string;
    attempts: number;
  }): Promise<{ id: string }> {
    const now = new Date();
    const rows = await db
      .insert(dead_letter_jobs)
      .values({
        // issue #323: the DLQ is global ops maintenance — write under the
        // sanctioned 'system' bucket (the dropped 'default' column-default). The
        // BullMQ failure-handler caller has no tenant ALS, so stamp explicitly.
        tenant_id: SYSTEM_TENANT_ID,
        agent_id: SYSTEM_AGENT_ID,
        queue_name: input.queue_name,
        job_id: input.job_id,
        payload: input.payload as object,
        error: input.error,
        attempts: input.attempts,
        first_failed_at: now,
        last_failed_at: now,
      })
      .returning({ id: dead_letter_jobs.id });
    return rows[0]!;
  },
  async listOpen(n = 100) {
    return db
      .select()
      .from(dead_letter_jobs)
      .where(eq(dead_letter_jobs.resolved, false))
      .orderBy(desc(dead_letter_jobs.created_at))
      .limit(n);
  },
  async countOpen(): Promise<number> {
    const r = await db.execute<{ c: number }>(sql`
      SELECT COUNT(*)::int AS c FROM ${dead_letter_jobs} WHERE resolved = false
    `);
    return (r.rows[0]?.c as number | undefined) ?? 0;
  },
  async resolve(id: string): Promise<void> {
    await db
      .update(dead_letter_jobs)
      .set({ resolved: true, resolved_at: new Date() })
      .where(eq(dead_letter_jobs.id, id));
  },
};
