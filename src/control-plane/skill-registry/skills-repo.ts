/**
 * P9a — skillsRepo (Source of Truth para Skill Contracts).
 *
 * Convenções:
 *  - Toda skill nasce em status='proposed' (DEFAULT na DB).
 *  - propose() incrementa version automaticamente (v1, v2, ...).
 *  - activate() é transacional: deprecate previous active + activate this one.
 *  - rollback() é transacional: marca como rolled_back + reativa version-1
 *    (que estava deprecated).
 *  - Lookups respeitam tenant_id do contexto E agent scope:
 *      * findActive sem agent_id explícito → restringe a (agent atual OR
 *        tenant-wide). NUNCA retorna skill de outro agente do mesmo tenant.
 *      * propose / activate / deprecate / rollback rejeitam mismatched
 *        agent_id (review #99 finding 1).
 *
 * Master spec v3.1.1 §2.4. Plan P9a Tasks 4.
 */
import { eq, and, desc, or, sql, type SQL } from 'drizzle-orm';
import { db, withTx } from '@/db/client.js';
import { skills, admin_audit_log } from '@/db/schema.js';
import type { SkillRow, SkillContract } from '@/db/schema.js';
import { getCurrentTenant, getCurrentAgent } from '@/db/tenant-context.js';

export type ProposeInput = SkillContract & {
  proposed_by: string;
  proposed_reason?: string;
  agent_id?: string | null;
  tenant_id?: string;
};

/**
 * Audit payload for the atomic mutation+audit path (PR #213 governance gap).
 *
 * Every skills mutation is a governance change on a versioned, audited table,
 * so the `admin_audit_log` row MUST commit in the SAME transaction as the skill
 * change — never as a separate post-commit append (which can lose the forensic
 * record if the audit insert fails or the request is interrupted between the
 * two statements). This mirrors `tenantsRepo.updateStatusAtomic` /
 * `createWithAuditAtomic` and `operationalProfileVersionsRepo.approveAndActivateAtomic`.
 *
 * The repo owns ONLY the `admin_audit_log` INSERT shape it can build from the
 * mutation result; the CALLER supplies the actor + the `action` verb + any
 * extra `change_summary` context (e.g. the resolved target tenant/agent for
 * cross-tenant founder forensics). The repo merges the before/after status it
 * computes inside the tx into `change_summary` so the trail always reflects the
 * real transition, never the caller's stale pre-flight read.
 *
 * Passing `audit` is OPTIONAL: omitting it keeps the legacy behaviour (mutate
 * only, no audit row) so non-admin-ui callers / older tests are unaffected.
 */
export interface SkillAuditPayload {
  actor_id: string;
  actor_role: string;
  action: 'skill_proposed' | 'skill_activated' | 'skill_deprecated' | 'skill_rolled_back';
  /** Tenant the audit row is filed under (the resolved target tenant). */
  tenant_id: string;
  /** Extra context merged into change_summary (status fields are added here). */
  change_summary?: Record<string, unknown>;
}

/**
 * Summary projection for the Admin UI list view (review PR #209 finding 2).
 * Deliberately EXCLUDES the large JSONB columns (procedure, input_schema,
 * output_schema, constraints, success_criteria, failure_modes, runtime_hints,
 * allowed_tools, policy_descriptors) — the list path only needs the table
 * columns; the full contract is fetched per-row via getById. Keeps the list
 * response bounded in size regardless of how big the contracts are.
 */
export type SkillSummary = Pick<
  SkillRow,
  | 'id'
  | 'tenant_id'
  | 'agent_id'
  | 'skill_descriptor'
  | 'category'
  | 'execution_mode'
  | 'version'
  | 'status'
  | 'activated_at'
  | 'created_at'
>;

/**
 * Column set selected for SkillSummary (no large JSONB).
 *
 * A FUNCTION (not a module-level const) so `skills.*` is dereferenced lazily at
 * query time, never at import. A module-load deref crashes any test that
 * partially mocks `@/db/schema` without a `skills` export and transitively
 * imports this repo (e.g. via `runtime/decision/prod-env.ts`). See PR #213 CI.
 */
const summaryColumns = () =>
  ({
    id: skills.id,
    tenant_id: skills.tenant_id,
    agent_id: skills.agent_id,
    skill_descriptor: skills.skill_descriptor,
    category: skills.category,
    execution_mode: skills.execution_mode,
    version: skills.version,
    status: skills.status,
    activated_at: skills.activated_at,
    created_at: skills.created_at,
  }) as const;

/**
 * Summary projection for the version-history list in the Admin UI drawer
 * (review PR #209 finding B). The drawer's Versions list only renders scalar
 * version metadata (version / status / timestamps / actors), so listVersions
 * MUST NOT pull the large JSONB contract columns (procedure, input_schema,
 * output_schema, constraints, success_criteria, failure_modes, runtime_hints)
 * for every historical version. The drawer's MAIN contract view still uses
 * getById for the full contract of the selected row.
 */
export type SkillVersionSummary = Pick<
  SkillRow,
  | 'id'
  | 'version'
  | 'status'
  | 'agent_id'
  | 'activated_at'
  | 'deprecated_at'
  | 'rolled_back_at'
  | 'created_at'
  | 'proposed_by'
  | 'approved_by'
>;

/** Column set selected for SkillVersionSummary (no large JSONB). Lazy — see summaryColumns(). */
const versionSummaryColumns = () =>
  ({
    id: skills.id,
    version: skills.version,
    status: skills.status,
    agent_id: skills.agent_id,
    activated_at: skills.activated_at,
    deprecated_at: skills.deprecated_at,
    rolled_back_at: skills.rolled_back_at,
    created_at: skills.created_at,
    proposed_by: skills.proposed_by,
    approved_by: skills.approved_by,
  }) as const;

/**
 * Server-enforced cap on the number of rows returned by the summary list
 * (review PR #209 finding 2). Callers may request fewer but never more; an
 * out-of-range / missing limit is clamped to this value to keep the unbounded
 * select from shipping arbitrarily large result sets to the Admin UI.
 */
export const SKILLS_LIST_MAX_LIMIT = 200;

/**
 * Clamp a caller-supplied limit to (1, SKILLS_LIST_MAX_LIMIT]. Missing,
 * non-positive or oversized limits collapse to the cap so the list path is
 * always bounded server-side (review PR #209 finding 2).
 */
function clampSkillsLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return SKILLS_LIST_MAX_LIMIT;
  }
  return Math.min(Math.floor(limit), SKILLS_LIST_MAX_LIMIT);
}

/**
 * Build the exact scope clause for version-history reads (review PR #209
 * finding 3). Returns null when no extra scoping is needed.
 *   - undefined → legacy "current agent OR tenant-wide";
 *   - string    → exactly that agent_id (must equal the context agent, else
 *     a scope violation — cross-agent reads are rejected);
 *   - null      → exactly tenant-wide (agent_id IS NULL).
 */
function scopeClauseFor(agentId: string | null | undefined, ctxAgent: string): SQL {
  if (agentId === undefined) {
    return or(eq(skills.agent_id, ctxAgent), sql`agent_id IS NULL`)!;
  }
  if (agentId === null) {
    return sql`agent_id IS NULL`;
  }
  if (agentId !== ctxAgent) {
    throw new Error(
      `agent_scope_violation: input agent ${agentId} vs context ${ctxAgent}`,
    );
  }
  return eq(skills.agent_id, agentId);
}

/**
 * Insert the `admin_audit_log` row for a skill mutation inside the caller's
 * transaction (PR #213). MUST be awaited within the same `withTx` callback that
 * performed the skill UPDATE/INSERT so a failed audit insert rolls the whole
 * mutation back. `row` is the mutation's resulting skill row; its descriptor /
 * version / status are recorded into change_summary alongside the caller's
 * extra context. `beforeStatus` is the pre-mutation status (null for propose).
 *
 * `tx` is the in-tx drizzle handle; structurally identical to `db` for inserts.
 */
async function appendSkillAudit(
  tx: typeof db,
  audit: SkillAuditPayload,
  row: SkillRow,
  beforeStatus: string | null,
): Promise<void> {
  await tx.insert(admin_audit_log).values({
    tenant_id: audit.tenant_id,
    actor_id: audit.actor_id,
    actor_role: audit.actor_role,
    action: audit.action,
    resource_type: 'skill',
    resource_id: row.id,
    change_summary: {
      ...(audit.change_summary ?? {}),
      skill_descriptor: row.skill_descriptor,
      version: row.version,
      before_status: beforeStatus,
      after_status: row.status,
    },
  });
}

export interface SkillsRepo {
  /** Lookup hot path por descriptor + status='active'. Tenant-scoped. */
  findActive(descriptor: string, agent_id?: string | null): Promise<SkillRow | null>;

  /** Lista todas active dentro de uma category (para slice builder / Admin UI). */
  listByCategory(category: string): Promise<SkillRow[]>;

  /**
   * Lista todas as skills do tenant (Admin UI catalog), opcionalmente
   * filtradas por status. Tenant + agent-scoped (current agent OR tenant-wide),
   * mesma regra de visibilidade que listVersions/getById (review #99 finding 1).
   * Mais recente primeiro (status, descriptor, version desc).
   *
   * Review PR #209 finding 2: retorna rows COMPLETAS (com JSONB grande) e é o
   * caminho legado para callers que precisam do contrato inteiro. O Admin UI
   * usa listSummaries (projeção leve + cap). O `limit` é opcional e é clampado
   * a SKILLS_LIST_MAX_LIMIT no servidor.
   */
  listAll(status?: string, limit?: number): Promise<SkillRow[]>;

  /**
   * Projeção SUMMARY para a list view do Admin UI (review PR #209 finding 2):
   * apenas colunas de tabela, SEM os JSONB grandes (procedure/schemas/etc.).
   * Tenant + agent-scoped igual a listAll. `limit` é clampado a
   * SKILLS_LIST_MAX_LIMIT (default = cap). O contrato completo continua atrás
   * de getById.
   */
  listSummaries(status?: string, limit?: number): Promise<SkillSummary[]>;

  /**
   * Como listSummaries, mas devolve também um sinal de truncamento (review PR
   * #209 finding A). Para detectar "tem mais" de forma barata, busca `limit + 1`
   * linhas (a própria sonda fica capada em SKILLS_LIST_MAX_LIMIT + 1), define
   * `hasMore = rows.length > limit` e corta `items` exatamente em `limit`. Sem
   * paginação por cursor (over-engineering nesta escala) — apenas o aviso de
   * que existem skills além do teto exibido.
   */
  listSummariesPage(
    status?: string,
    limit?: number,
  ): Promise<{ items: SkillSummary[]; hasMore: boolean }>;

  /**
   * Cria uma nova versão em status='proposed' (jamais 'active').
   *
   * PR #213: quando `audit` é fornecido, o INSERT da skill e o INSERT em
   * `admin_audit_log` rodam na MESMA transação (`withTx`) — se o audit falhar,
   * a skill não é persistida. Sem `audit`, mantém o caminho legado (insert só).
   */
  propose(input: ProposeInput, audit?: SkillAuditPayload): Promise<SkillRow>;

  /**
   * Transacional: desativa previous active (deprecated) + marca a target como
   * active. Lança se a target não estiver em 'proposed'. PR #213: `audit` (se
   * fornecido) é inserido na MESMA tx — falha do audit reverte a ativação.
   */
  activate(
    id: string,
    approver: string,
    reason?: string,
    audit?: SkillAuditPayload,
  ): Promise<SkillRow>;

  /**
   * Marca como deprecated sem reativar nada. PR #213: só permite deprecar a
   * partir de 'active' ou 'proposed' (UPDATE status-conditioned); caso contrário
   * lança `cannot_deprecate_from_<status>`. Quando `audit` é fornecido, roda na
   * MESMA tx que o audit (falha do audit reverte).
   */
  deprecate(
    id: string,
    deprecator: string,
    reason: string,
    audit?: SkillAuditPayload,
  ): Promise<SkillRow>;

  /**
   * Transacional: marca a target como rolled_back + reativa version-1 (se
   * existir e estiver deprecated). Versão anterior NÃO precisa ser a mesma
   * agent_id; usa-se (tenant, agent_or_tenant_wide, descriptor, version-1).
   * PR #213: só permite rollback a partir de 'active'; caso contrário lança
   * `cannot_rollback_from_<status>`. `audit` (se fornecido) entra na mesma tx.
   */
  rollback(
    id: string,
    reason: string,
    rolledBackBy: string,
    audit?: SkillAuditPayload,
  ): Promise<SkillRow>;

  /** Lookup por id (tenant-scoped). */
  getById(id: string): Promise<SkillRow | null>;

  /** Lookup por descriptor + version (tenant-scoped). Sem version, retorna a mais recente. */
  getByDescriptor(descriptor: string, version?: number): Promise<SkillRow | null>;

  /**
   * Lista as versões de um descriptor (projeção SUMMARY), mais recente primeiro.
   *
   * Review PR #209 finding 3 (scope-exact version history): o histórico DEVE
   * ser exato por escopo. `agentId` é opcional para retrocompat:
   *   - undefined → comportamento legado (agent atual OU tenant-wide);
   *   - string    → SOMENTE aquele agent_id (deve ser o agent do contexto);
   *   - null      → SOMENTE tenant-wide (agent_id IS NULL).
   * Assim uma skill agent-scoped e uma tenant-wide com o mesmo descriptor não
   * se misturam no histórico de versões.
   *
   * Review PR #209 finding B: retorna apenas colunas escalares de versão (SEM
   * os JSONB grandes — procedure/schemas/constraints/etc.), capado em
   * SKILLS_LIST_MAX_LIMIT, pois a lista de versões do drawer só mostra metadados
   * escalares. O contrato completo de uma versão continua atrás de getById.
   */
  listVersions(
    descriptor: string,
    agentId?: string | null,
  ): Promise<SkillVersionSummary[]>;
}

export const skillsRepo: SkillsRepo = {
  async findActive(descriptor, agent_id): Promise<SkillRow | null> {
    const tenant_id = getCurrentTenant();
    // Derive default scope from tenant context. Agent-isolation rule
    // (review #99 finding 1): when caller omits agent_id we scope to
    // (current agent OR tenant-wide). We NEVER fall through to "any agent
    // in tenant".
    const ctxAgent = getCurrentAgent();
    let scopeClause;
    if (agent_id === undefined) {
      // Default: current agent OR tenant-wide. Prefer agent-scoped match
      // (ORDER BY agent_id NULLS LAST) so an agent-specific skill beats
      // a tenant-wide one with the same descriptor.
      scopeClause = or(eq(skills.agent_id, ctxAgent), sql`agent_id IS NULL`);
    } else if (agent_id === null) {
      // Explicit tenant-wide request: only NULL agent_id matches.
      scopeClause = sql`agent_id IS NULL`;
    } else {
      // Explicit agent_id: must match the context agent (cross-agent reads
      // are rejected; admin paths use a dedicated method, not findActive).
      if (agent_id !== ctxAgent) {
        throw new Error(`agent_scope_violation: input agent ${agent_id} vs context ${ctxAgent}`);
      }
      scopeClause = eq(skills.agent_id, agent_id);
    }
    const rows = await db
      .select()
      .from(skills)
      .where(
        and(
          eq(skills.tenant_id, tenant_id),
          eq(skills.skill_descriptor, descriptor),
          eq(skills.status, 'active'),
          scopeClause,
        ),
      )
      // Prefer agent-scoped match over tenant-wide when both exist for the
      // same descriptor. NULLS LAST mimics "real agent_id first" ordering.
      .orderBy(sql`agent_id IS NULL`)
      .limit(1);
    return rows[0] ?? null;
  },

  async listByCategory(category): Promise<SkillRow[]> {
    const tenant_id = getCurrentTenant();
    const ctxAgent = getCurrentAgent();
    return db
      .select()
      .from(skills)
      .where(
        and(
          eq(skills.tenant_id, tenant_id),
          eq(skills.category, category),
          eq(skills.status, 'active'),
          // Agent scope (review #99 finding 1).
          or(eq(skills.agent_id, ctxAgent), sql`agent_id IS NULL`),
        ),
      );
  },

  async listAll(status, limit): Promise<SkillRow[]> {
    const tenant_id = getCurrentTenant();
    const ctxAgent = getCurrentAgent();
    const filters = [
      eq(skills.tenant_id, tenant_id),
      // Agent scope (review #99 finding 1): current agent OR tenant-wide.
      // Never expose another agent's skills within the same tenant.
      or(eq(skills.agent_id, ctxAgent), sql`agent_id IS NULL`),
    ];
    if (status !== undefined) {
      filters.push(eq(skills.status, status));
    }
    // Review PR #209 finding 2: bound the result set even on the full-row
    // path. Clamp to the server cap so no caller can request an unbounded
    // select of the large JSONB columns.
    return db
      .select()
      .from(skills)
      .where(and(...filters))
      .orderBy(skills.skill_descriptor, desc(skills.version))
      .limit(clampSkillsLimit(limit));
  },

  async listSummaries(status, limit): Promise<SkillSummary[]> {
    const tenant_id = getCurrentTenant();
    const ctxAgent = getCurrentAgent();
    const filters = [
      eq(skills.tenant_id, tenant_id),
      // Same visibility rule as listAll (review #99 finding 1).
      or(eq(skills.agent_id, ctxAgent), sql`agent_id IS NULL`),
    ];
    if (status !== undefined) {
      filters.push(eq(skills.status, status));
    }
    // Summary projection (review PR #209 finding 2): only the table columns,
    // never the big JSONB contract fields, capped at SKILLS_LIST_MAX_LIMIT.
    return db
      .select(summaryColumns())
      .from(skills)
      .where(and(...filters))
      .orderBy(skills.skill_descriptor, desc(skills.version))
      .limit(clampSkillsLimit(limit));
  },

  async listSummariesPage(status, limit): Promise<{ items: SkillSummary[]; hasMore: boolean }> {
    const tenant_id = getCurrentTenant();
    const ctxAgent = getCurrentAgent();
    const filters = [
      eq(skills.tenant_id, tenant_id),
      // Same visibility rule as listSummaries (review #99 finding 1).
      or(eq(skills.agent_id, ctxAgent), sql`agent_id IS NULL`),
    ];
    if (status !== undefined) {
      filters.push(eq(skills.status, status));
    }
    // Review PR #209 finding A: cheapest truncation signal. Clamp the effective
    // page size to the cap, then fetch ONE extra row (the probe stays bounded at
    // SKILLS_LIST_MAX_LIMIT + 1). If we got more than the page size there are
    // more skills than we display; slice back down so callers never see the
    // probe row. Same projection/scope as listSummaries.
    const effectiveLimit = clampSkillsLimit(limit);
    const rows = await db
      .select(summaryColumns())
      .from(skills)
      .where(and(...filters))
      .orderBy(skills.skill_descriptor, desc(skills.version))
      .limit(effectiveLimit + 1);
    const hasMore = rows.length > effectiveLimit;
    return { items: hasMore ? rows.slice(0, effectiveLimit) : rows, hasMore };
  },

  async propose(input, audit): Promise<SkillRow> {
    const ctxTenant = getCurrentTenant();
    const ctxAgent = getCurrentAgent();
    const tenant_id = input.tenant_id ?? ctxTenant;
    if (input.tenant_id && input.tenant_id !== ctxTenant) {
      throw new Error(`tenant mismatch: input ${input.tenant_id} vs context ${ctxTenant}`);
    }
    // Validate agent scope (review #99 finding 1): explicit input.agent_id
    // must match context agent OR be null (tenant-wide). undefined → defaults
    // to current agent (NOT to tenant-wide, to avoid accidental privilege
    // escalation when caller forgot to scope).
    let agent_id: string | null;
    if (input.agent_id === undefined) {
      agent_id = ctxAgent;
    } else if (input.agent_id === null) {
      // Round-2 review #99 finding 1: proposing a tenant-wide skill from agent
      // context is a privilege escalation. Tenant-admin authorization required.
      throw new Error(
        'tenant_admin_required: tenant-wide skills (agent_id=null) cannot be proposed from agent context; use admin authorization',
      );
    } else if (input.agent_id !== ctxAgent) {
      throw new Error(
        `agent_scope_violation: input agent ${input.agent_id} vs context ${ctxAgent}`,
      );
    } else {
      agent_id = input.agent_id;
    }
    // Validate evaluator-mode skills cannot declare allowed_tools (review
    // #99 mission item 4). Evaluators only inspect candidate outputs; tool
    // access on evaluation pipelines is a category error and a potential
    // privilege-escalation surface.
    if (
      input.execution_mode === 'evaluator' &&
      input.allowed_tools &&
      input.allowed_tools.length > 0
    ) {
      throw new Error(
        'evaluator_mode_disallows_tools: skills with execution_mode=evaluator must have empty allowed_tools',
      );
    }

    // Determinar próxima version monotônica para (tenant, agent_or_tenant_wide, descriptor)
    const latestRows = await db
      .select({ version: skills.version })
      .from(skills)
      .where(
        and(
          eq(skills.tenant_id, tenant_id),
          eq(skills.skill_descriptor, input.skill_descriptor),
          agent_id === null ? sql`agent_id IS NULL` : eq(skills.agent_id, agent_id),
        ),
      )
      .orderBy(desc(skills.version))
      .limit(1);
    const nextVersion = (latestRows[0]?.version ?? 0) + 1;

    const values = {
      tenant_id,
      agent_id,
      skill_descriptor: input.skill_descriptor,
      category: input.category,
      execution_mode: input.execution_mode,
      goal: input.goal,
      when_to_use: input.when_to_use,
      procedure: input.procedure,
      constraints: input.constraints ?? [],
      input_schema: input.input_schema,
      output_schema: input.output_schema,
      allowed_tools: input.allowed_tools ?? [],
      policy_descriptors: input.policy_descriptors ?? [],
      success_criteria: input.success_criteria ?? [],
      failure_modes: input.failure_modes ?? [],
      runtime_hints: input.runtime_hints ?? {},
      status: 'proposed' as const,
      version: nextVersion,
      proposed_by: input.proposed_by,
      proposed_reason: input.proposed_reason ?? null,
    };

    // PR #213 atomicity: when an audit payload is supplied, the skill INSERT and
    // its admin_audit_log row commit together (withTx). A failed audit insert
    // rolls the proposed row back — no unaudited skill version. Without audit,
    // keep the legacy single-INSERT path for non-admin-ui callers.
    if (audit) {
      return withTx(async (tx) => {
        const [row] = await tx.insert(skills).values(values).returning();
        await appendSkillAudit(tx, audit, row!, null);
        return row!;
      });
    }
    const [row] = await db.insert(skills).values(values).returning();
    return row!;
  },

  async activate(id, approver, reason, audit): Promise<SkillRow> {
    const tenant_id = getCurrentTenant();
    const ctxAgent = getCurrentAgent();
    return withTx(async (tx) => {
      // Round-2 review FIX A: close the activation TOCTOU race. Take a row
      // lock (SELECT ... FOR UPDATE) on the target FIRST, before any check or
      // write. A concurrent `deprecate` (which also locks/updates this same
      // row) then BLOCKS until this tx commits, serializing the two; combined
      // with the status-conditioned write below it guarantees exactly one of
      // {activate, concurrent deprecate} wins — the loser sees the row already
      // moved and fails its own status-conditioned guard.
      const targetRows = await tx
        .select()
        .from(skills)
        .where(and(eq(skills.tenant_id, tenant_id), eq(skills.id, id)))
        .for('update');
      const target = targetRows[0];
      if (!target) throw new Error('skill_not_found');
      const beforeStatus = target.status;
      // Agent-scope check (round-2 review #99 finding 1): caller cannot
      // activate a skill owned by a different agent, AND cannot activate
      // tenant-wide skills (agent_id=null) from a regular agent context —
      // those require explicit tenant-admin authorization (a separate path
      // not available in the per-agent repo methods).
      if (target.agent_id === null) {
        throw new Error(
          'tenant_admin_required: tenant-wide skills (agent_id=null) cannot be activated from agent context; use admin authorization',
        );
      }
      if (target.agent_id !== ctxAgent) {
        throw new Error(
          `agent_scope_violation: target agent ${target.agent_id} vs context ${ctxAgent}`,
        );
      }
      // Fast-fail on the locked read so a clearly non-proposed target short
      // circuits before the deprecate step. The status-conditioned UPDATE
      // below is the AUTHORITATIVE guard — this check is an early-out only.
      if (target.status !== 'proposed') {
        throw new Error(`cannot_activate_from_${target.status}`);
      }

      // Deprecate previous active for the same (tenant, agent_or_tenant_wide, descriptor)
      await tx
        .update(skills)
        .set({ status: 'deprecated', deprecated_at: new Date() })
        .where(
          and(
            eq(skills.tenant_id, tenant_id),
            eq(skills.skill_descriptor, target.skill_descriptor),
            target.agent_id === null
              ? sql`agent_id IS NULL`
              : eq(skills.agent_id, target.agent_id),
            eq(skills.status, 'active'),
          ),
        );

      const now = new Date();
      // Status-conditioned activation (FIX A): only flip a row that is STILL
      // 'proposed' at write time. If a concurrent deprecate (or any other
      // transition) moved it out of 'proposed' after our read — including the
      // TOCTOU window between the lock release and a serialized writer — this
      // UPDATE matches 0 rows and we throw `cannot_activate_from_<status>`
      // instead of blindly resurrecting a deprecated/rolled_back row via an
      // unconditioned `WHERE id = ?`. Mirrors deprecate/rollback's guarded
      // UPDATE + RETURNING pattern.
      const [updated] = await tx
        .update(skills)
        .set({
          status: 'active',
          activated_at: now,
          approved_by: approver,
          approved_at: now,
          // Append reason as a hint into proposed_reason chain when supplied;
          // dedicated approval_reason column is not in v3.1.1 schema.
          proposed_reason: reason
            ? `${target.proposed_reason ?? ''}${target.proposed_reason ? ' | ' : ''}approved: ${reason}`
            : target.proposed_reason,
        })
        .where(
          and(
            eq(skills.tenant_id, tenant_id),
            eq(skills.id, id),
            eq(skills.status, 'proposed'),
          ),
        )
        .returning();
      if (!updated) {
        // Re-read the current status for an accurate conflict message (the row
        // raced out of 'proposed' under us). Stays inside the tx; the failure
        // rolls the prior-active deprecation back too.
        const currentRows = await tx
          .select()
          .from(skills)
          .where(and(eq(skills.tenant_id, tenant_id), eq(skills.id, id)))
          .limit(1);
        const current = currentRows[0];
        throw new Error(`cannot_activate_from_${current?.status ?? 'unknown'}`);
      }
      // PR #213: audit in the SAME tx — a failed audit insert rolls the
      // activation (and the prior-active deprecation) back.
      if (audit) await appendSkillAudit(tx, audit, updated, beforeStatus);
      return updated;
    });
  },

  async deprecate(id, _deprecator, _reason, audit): Promise<SkillRow> {
    const tenant_id = getCurrentTenant();
    const ctxAgent = getCurrentAgent();
    // PR #213: wrap in a tx so the status-conditioned UPDATE and the audit
    // insert commit together. The read-for-scope, the guarded UPDATE, and the
    // audit row are one atomic unit.
    return withTx(async (tx) => {
      // Read first to enforce agent scope (review #99 finding 1). Round-2
      // review FIX A: lock the row (FOR UPDATE) so a concurrent activate on
      // the SAME target serializes against us — only one of {activate,
      // deprecate} can hold the lock at a time, and the status-conditioned
      // UPDATE below makes the loser a no-op (→ typed conflict).
      const existingRows = await tx
        .select()
        .from(skills)
        .where(and(eq(skills.tenant_id, tenant_id), eq(skills.id, id)))
        .for('update');
      const existing = existingRows[0];
      if (!existing) throw new Error('skill_not_found');
      // Round-2 review #99 finding 1: tenant-wide skills (agent_id=null)
      // require tenant-admin authorization — not available in agent-context
      // repo methods. Reject to prevent any agent from deprecating shared skills.
      if (existing.agent_id === null) {
        throw new Error(
          'tenant_admin_required: tenant-wide skills (agent_id=null) cannot be deprecated from agent context; use admin authorization',
        );
      }
      if (existing.agent_id !== ctxAgent) {
        throw new Error(
          `agent_scope_violation: target agent ${existing.agent_id} vs context ${ctxAgent}`,
        );
      }
      // PR #213 FIX 2: lifecycle guard, server-authoritative. Only deprecate
      // from 'active' or 'proposed'. Status-conditioned UPDATE so a concurrent
      // transition can't slip through; 0 rows affected ⇒ wrong status ⇒ typed
      // conflict (do NOT rely on the UI to block invalid transitions).
      const [updated] = await tx
        .update(skills)
        .set({ status: 'deprecated', deprecated_at: new Date() })
        .where(
          and(
            eq(skills.tenant_id, tenant_id),
            eq(skills.id, id),
            or(eq(skills.status, 'active'), eq(skills.status, 'proposed')),
          ),
        )
        .returning();
      if (!updated) {
        throw new Error(`cannot_deprecate_from_${existing.status}`);
      }
      if (audit) await appendSkillAudit(tx, audit, updated, existing.status);
      return updated;
    });
  },

  async rollback(id, reason, _rolledBackBy, audit): Promise<SkillRow> {
    const tenant_id = getCurrentTenant();
    const ctxAgent = getCurrentAgent();
    return withTx(async (tx) => {
      // Round-2 review FIX A: lock the target (FOR UPDATE) so a concurrent
      // activate/deprecate on the same row serializes; the status-conditioned
      // UPDATE below (status='active') then makes the loser a typed conflict.
      const targetRows = await tx
        .select()
        .from(skills)
        .where(and(eq(skills.tenant_id, tenant_id), eq(skills.id, id)))
        .for('update');
      const target = targetRows[0];
      if (!target) throw new Error('skill_not_found');
      // Agent-scope check (round-2 review #99 finding 1): tenant-wide skills
      // require tenant-admin context, not agent context.
      if (target.agent_id === null) {
        throw new Error(
          'tenant_admin_required: tenant-wide skills (agent_id=null) cannot be rolled back from agent context; use admin authorization',
        );
      }
      if (target.agent_id !== ctxAgent) {
        throw new Error(
          `agent_scope_violation: target agent ${target.agent_id} vs context ${ctxAgent}`,
        );
      }

      const now = new Date();
      // PR #213 FIX 2: lifecycle guard, server-authoritative. Only rollback
      // from 'active'. Status-conditioned UPDATE; 0 rows affected ⇒ wrong
      // status ⇒ typed conflict.
      const [updated] = await tx
        .update(skills)
        .set({
          status: 'rolled_back',
          rolled_back_at: now,
          rollback_reason: reason,
        })
        .where(and(eq(skills.id, id), eq(skills.status, 'active')))
        .returning();
      if (!updated) {
        throw new Error(`cannot_rollback_from_${target.status}`);
      }

      // Try to reactivate v-1 (deprecated). Best-effort: respects tenant +
      // agent_or_tenant_wide + descriptor + version-1.
      const previousRows = await tx
        .select()
        .from(skills)
        .where(
          and(
            eq(skills.tenant_id, tenant_id),
            eq(skills.skill_descriptor, target.skill_descriptor),
            target.agent_id === null
              ? sql`agent_id IS NULL`
              : eq(skills.agent_id, target.agent_id),
            eq(skills.version, target.version - 1),
          ),
        )
        .limit(1);
      const previous = previousRows[0];
      if (previous && previous.status === 'deprecated') {
        await tx
          .update(skills)
          .set({ status: 'active', activated_at: now })
          .where(eq(skills.id, previous.id));
      }

      // PR #213: audit in the SAME tx — a failed audit insert rolls the
      // rolled_back flip (and any v-1 reactivation) back. Before status is
      // 'active' (guaranteed by the status-conditioned UPDATE above).
      if (audit) await appendSkillAudit(tx, audit, updated, 'active');
      return updated;
    });
  },

  async getById(id): Promise<SkillRow | null> {
    const tenant_id = getCurrentTenant();
    const ctxAgent = getCurrentAgent();
    const rows = await db
      .select()
      .from(skills)
      .where(and(eq(skills.tenant_id, tenant_id), eq(skills.id, id)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    // Agent-scope check (review #99 finding 1): hide skills owned by other
    // agents in the same tenant. Tenant-wide (agent_id=null) skills are
    // visible to all agents.
    if (row.agent_id !== null && row.agent_id !== ctxAgent) {
      return null;
    }
    return row;
  },

  async getByDescriptor(descriptor, version): Promise<SkillRow | null> {
    const tenant_id = getCurrentTenant();
    const ctxAgent = getCurrentAgent();
    const filters = [
      eq(skills.tenant_id, tenant_id),
      eq(skills.skill_descriptor, descriptor),
      // Same scope rule as findActive: current agent OR tenant-wide.
      or(eq(skills.agent_id, ctxAgent), sql`agent_id IS NULL`),
    ];
    if (typeof version === 'number') {
      filters.push(eq(skills.version, version));
    }
    const rows = await db
      .select()
      .from(skills)
      .where(and(...filters))
      .orderBy(desc(skills.version))
      .limit(1);
    return rows[0] ?? null;
  },

  async listVersions(descriptor, agentId): Promise<SkillVersionSummary[]> {
    const tenant_id = getCurrentTenant();
    const ctxAgent = getCurrentAgent();
    // Review PR #209 finding 3: scope-exact version history. When agentId is
    // provided we match ONLY that scope (an explicit null means tenant-wide
    // only) so an agent-scoped skill and a tenant-wide one that share a
    // descriptor never bleed into each other's version list. undefined keeps
    // the legacy (current agent OR tenant-wide) behaviour for old callers.
    //
    // Review PR #209 finding B: project only scalar version columns (no large
    // JSONB) and cap the row count at SKILLS_LIST_MAX_LIMIT — the drawer's
    // Versions list never needs the full contract per version.
    return db
      .select(versionSummaryColumns())
      .from(skills)
      .where(
        and(
          eq(skills.tenant_id, tenant_id),
          eq(skills.skill_descriptor, descriptor),
          scopeClauseFor(agentId, ctxAgent),
        ),
      )
      .orderBy(desc(skills.version))
      .limit(SKILLS_LIST_MAX_LIMIT);
  },
};
