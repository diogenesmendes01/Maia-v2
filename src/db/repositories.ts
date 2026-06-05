import { eq, and, inArray, desc, isNull, sql, or, gt, lt, ne, Param } from 'drizzle-orm';
import { db, withTx, pgErrorCode } from './client.js';
import { procedure_status_events } from './schema.js';
import {
  pessoas,
  agent_audience_profiles,
  agent_tool_grants,
  permissoes,
  permission_profiles,
  conversas,
  mensagens,
  entidades,
  contas_bancarias,
  transacoes,
  contrapartes,
  categorias,
  agent_facts,
  learned_rules,
  pending_questions,
  idempotency_keys,
  idempotency_effect_outbox,
  outbound_messages,
  audit_log,
  workflows,
  workflow_steps,
  entity_states,
  self_state,
  system_health_events,
  dead_letter_jobs,
  tenants,
  agents,
  cognitive_module_log,
  cognitive_candidates,
  memory_entry,
  behavioral_hint,
  agent_capabilities_domain,
  agent_capabilities_skill,
  agent_capability_gaps,
  procedure_definitions,
  procedure_assignments,
  procedure_executions,
  procedure_execution_events,
  procedure_selector_decisions,
  procedure_tests,
  procedure_metrics,
  agent_operational_profile_versions,
  agent_drift_alerts,
  gap_escalation_rules,
  capability_proposals,
  capability_test_results,
  channels,
  roles,
  channel_policies,
  role_selector_decisions,
  app_users,
  app_sessions,
  proposal_approvals,
  admin_audit_log,
  debug_snapshot_grants,
  global_settings,
} from './schema.js';
import type {
  AppUser,
  NewAppUser,
  ProposalApproval,
  NewProposalApproval,
  AdminAuditLogEntry,
  NewAdminAuditLogEntry,
  DebugSnapshotGrant,
  NewDebugSnapshotGrant,
  ProposalTypeId,
  RiskLevelId,
  ProposalUnifiedStatus,
} from './schema.js';
import { TypedError } from '@/lib/utils.js';
import { logger } from '@/lib/logger.js';
import { incCounter } from '@/lib/metrics.js';
import { applyTenantGuard } from './tenant-guard.js';
import { getCurrentTenant, getCurrentAgent } from './tenant-context.js';
import type { PlannedEffect } from '@/governance/idempotency-effects.js';
import { isVersionedPayloadHash } from '@/governance/idempotency.js';
import { deriveCapabilityRisk, deriveCapabilityLocks } from './capability-risk.js';
import { LearnedVoiceModifierSchema } from '@/identity/learned-voice-modifier.js';
import type {
  ProfileStatus,
  DriftType,
  DriftSeverity,
  DriftDecision,
  GapLevel,
  ProposalStatus,
  SwitchBehavior,
  AnnounceMode,
  SuggestedBy,
  DecidedBy,
  RoleSelectorStrength,
  RoleDecisionAction,
} from '@/types/enums.js';
import type {
  Pessoa,
  AgentAudienceProfile,
  NewAgentAudienceProfile,
  AgentToolGrantRow,
  NewAgentToolGrant,
  Permissao,
  Conversa,
  Mensagem,
  Entidade,
  Conta,
  Transacao,
  Contraparte,
  Categoria,
  PermissionProfile,
  AgentFact,
  LearnedRule,
  PendingQuestion,
  AuditEntry,
  Workflow,
  WorkflowStep,
  EntityState,
  SelfState,
  Tenant,
  Agent,
  CognitiveModuleLog,
  CognitiveCandidate,
  MemoryEntry,
  BehavioralHint,
  AgentCapabilityDomain,
  AgentCapabilitySkill,
  AgentCapabilityGap,
  ProcedureDefinition,
  ProcedureAssignment,
  ProcedureExecution,
  ProcedureExecutionEvent,
  ProcedureSelectorDecision,
  ProcedureTest,
  ProcedureMetric,
  ProcedureStatusEvent,
  ProcedureStatusUpdate,
  AgentOperationalProfileVersion,
  ProfileBody,
  AgentDriftAlert,
  GapEscalationRule,
  NewGapEscalationRule,
  CapabilityProposal,
  CapabilityTestResult,
  Channel,
  Role,
  ChannelPolicy,
  NewChannelPolicy,
  RoleSelectorDecisionRow,
} from './schema.js';

export type EntityScope = {
  pessoa_id: string;
  entidades: string[];
};

/**
 * Valid procedure lifecycle statuses. Mirrors ProcedureStatus in
 * procedure-status.ts — duplicated here to avoid a circular import
 * (repositories.ts ← procedure-status.ts already).
 */
export type ProcedureStatus = 'draft' | 'proposed' | 'active' | 'frozen' | 'rolled_back';

/**
 * Thrown by atomicActivate when the locked row's status no longer matches
 * the expected_from_status passed by the caller. Indicates a concurrent
 * write raced ahead — callers should re-fetch and retry if appropriate.
 */
export class OptimisticLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OptimisticLockError';
  }
}

export class EmptyScopeError extends TypedError {
  constructor() {
    super('empty_scope', 'Repository called without entity scope');
  }
}

export const pessoasRepo = {
  /**
   * P83-C7: tenant-scoped findById. A row from another tenant is invisible.
   */
  async findById(id: string): Promise<Pessoa | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(pessoas)
      .where(and(
        eq(pessoas.id, id),
        eq(pessoas.tenant_id, tenant_id),
        eq(pessoas.agent_id, agent_id),
      ))
      .limit(1);
    return rows[0] ?? null;
  },
  /**
   * P83-C7: tenant-scoped findByPhone. WhatsApp phone numbers are
   * globally unique but the pessoa record still belongs to a single
   * tenant — we MUST scope the read.
   */
  async findByPhone(telefone: string): Promise<Pessoa | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(pessoas)
      .where(and(
        eq(pessoas.telefone_whatsapp, telefone),
        eq(pessoas.tenant_id, tenant_id),
        eq(pessoas.agent_id, agent_id),
      ))
      .limit(1);
    return rows[0] ?? null;
  },
  async create(input: Omit<Pessoa, 'id' | 'tenant_id' | 'agent_id' | 'created_at' | 'updated_at'>): Promise<Pessoa> {
    const guarded = applyTenantGuard(input);
    const rows = await db.insert(pessoas).values(guarded).returning();
    return rows[0]!;
  },
  async updateStatus(id: string, status: Pessoa['status']): Promise<void> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    await db
      .update(pessoas)
      .set({ status, updated_at: new Date() })
      .where(and(
        eq(pessoas.id, id),
        eq(pessoas.tenant_id, tenant_id),
        eq(pessoas.agent_id, agent_id),
      ));
  },
  async updatePreferencias(id: string, preferencias: Record<string, unknown>): Promise<void> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    await db
      .update(pessoas)
      .set({ preferencias, updated_at: new Date() })
      .where(and(
        eq(pessoas.id, id),
        eq(pessoas.tenant_id, tenant_id),
        eq(pessoas.agent_id, agent_id),
      ));
  },
  async list(): Promise<Pessoa[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(pessoas)
      .where(and(eq(pessoas.tenant_id, tenant_id), eq(pessoas.agent_id, agent_id)));
  },

  /**
   * Issue #345 (Phase 4) — dispatcher enumeration for `audit-mode-expirer`.
   *
   * Returns the DISTINCT (tenant_id, agent_id) tuples that own at least one
   * pessoa whose `preferencias->>'modo_auditoria_ate'` is set AND already past
   * due (`<= now()`) — i.e. exactly the tuples whose `expireAuditModes()` inner
   * has work to do. Runs OUTSIDE tenant context (it IS the dispatcher); the
   * worker opens `runWithTenantContext` per tuple, and the inner re-derives the
   * scope via `pessoasRepo.list()` (which filters by the ALS tenant/agent).
   *
   * Like the other fan-out enumerations in this file
   * (`listPendingTenantPairsForType`, `listAgentsWithOpenGaps`,
   * `outbound-messages-sweeper.listTenantsWithWork`), this method intentionally
   * does NOT apply the tenant guard — iteration across tenants is the worker's
   * contract. `system`/`default` only appear if they genuinely hold an expirable
   * audit-mode pref, so there is no sentinel special-case. Belt-and-suspenders
   * `tenant_id/agent_id IS NOT NULL` mirrors #251/#292 (schema already enforces
   * NOT NULL; the predicate guards against a future schema relaxation).
   *
   * The `modo_auditoria_ate` timestamp is stored as an ISO-8601 string in the
   * `preferencias` jsonb (see `governance/audit-mode.ts`), so the comparison
   * casts it to `timestamptz` and only matches rows where the key is present
   * and parses to a moment at or before now.
   */
  async listTenantAgentPairsWithExpiredAuditMode(): Promise<
    Array<{ tenant_id: string; agent_id: string }>
  > {
    const result = await db.execute<{ tenant_id: string; agent_id: string }>(sql`
      SELECT DISTINCT tenant_id, agent_id
      FROM ${pessoas}
      WHERE tenant_id IS NOT NULL
        AND agent_id IS NOT NULL
        AND (preferencias->>'modo_auditoria_ate') IS NOT NULL
        AND (preferencias->>'modo_auditoria_ate')::timestamptz <= now()
    `);
    return Array.from(
      result.rows as unknown as Array<{ tenant_id: string; agent_id: string }>,
    );
  },

  /**
   * Issue #345 (Phase 4 of #323) — dispatcher enumeration for the briefing
   * workers (`briefing_morning` / `briefing_evening` / `briefing_weekly`).
   *
   * Returns the DISTINCT (tenant_id, agent_id) tuples that own at least one
   * ACTIVE owner pessoa — i.e. exactly the tuples whose briefing would have a
   * recipient. The predicate mirrors `governance/permissions.listOwners()`
   * EXACTLY (`tipo IN ('dono','co_dono') AND status = 'ativa'`), which is the
   * function each briefing's `sendToOwners()` calls to pick recipients. A tuple
   * is therefore enumerated iff `sendToOwners()` would send at least one message
   * under it; a tuple with no active owner is correctly skipped (the old
   * `default/default` run would also have sent nothing if `default` had no owner).
   *
   * This is the recipient-defining enumeration (NOT a financial-data one): a
   * tuple with active owners but zero entities still gets a briefing run — the
   * inner just produces an empty "Saldos por entidade" list, exactly as the old
   * single-tenant path did. That matches `sendToOwners` semantics (briefings are
   * addressed to owners, financial data merely fills the body), and avoids
   * UNDER-enumeration (no owner who would have been briefed is missed).
   *
   * The 3 briefing periods share this one enumeration: all three address the same
   * owner set; only the body window differs (today / 7-day), which is an inner
   * concern, not a recipient concern.
   *
   * Runs OUTSIDE tenant context (it IS the dispatcher); no tenant guard
   * (cross-tenant iteration is the worker's contract). Belt-and-suspenders
   * `tenant_id/agent_id IS NOT NULL` mirrors #251/#292 (schema already enforces
   * NOT NULL with a legacy 'default' default; this guards a future relaxation).
   * Before this fix all three briefings ran under a hardcoded `default/default`
   * context, so only the default agent's owners were ever briefed.
   */
  async listTenantAgentPairsWithActiveOwner(): Promise<
    Array<{ tenant_id: string; agent_id: string }>
  > {
    const result = await db.execute<{ tenant_id: string; agent_id: string }>(sql`
      SELECT DISTINCT tenant_id, agent_id
      FROM ${pessoas}
      WHERE tenant_id IS NOT NULL
        AND agent_id IS NOT NULL
        AND tipo IN ('dono', 'co_dono')
        AND status = 'ativa'
    `);
    return Array.from(
      result.rows as unknown as Array<{ tenant_id: string; agent_id: string }>,
    );
  },
};

/**
 * agentAudienceProfilesRepo — per-agent audience relation (issue #407).
 *
 * Every read/write is scoped to the current (tenant_id, agent_id) via the ALS
 * context, exactly like `pessoasRepo`. A profile belonging to another
 * (tenant, agent) is invisible — this is the per-agent isolation that lets the
 * same phone be `customer` for Agent X and `employee` for Agent Y.
 *
 * `audience_type` / `trust_level` / `status` are returned narrowed to the
 * canonical unions (the DB stores `text` with CHECK constraints from
 * migration 074). The cast at the read boundary is safe because the CHECK
 * constraints guarantee the stored value is one of the legal literals.
 */
export const agentAudienceProfilesRepo = {
  /**
   * Tenant+agent-scoped lookup of the audience profile for a pessoa. The
   * 1:1 (tenant, agent, pessoa) unique guarantees at most one row. A row from
   * another (tenant, agent) is invisible.
   */
  async findByPessoa(pessoa_id: string): Promise<AgentAudienceProfile | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(agent_audience_profiles)
      .where(
        and(
          eq(agent_audience_profiles.tenant_id, tenant_id),
          eq(agent_audience_profiles.agent_id, agent_id),
          eq(agent_audience_profiles.pessoa_id, pessoa_id),
        ),
      )
      .limit(1);
    return (rows[0] ?? null) as AgentAudienceProfile | null;
  },
  async create(
    input: Omit<
      NewAgentAudienceProfile,
      'id' | 'tenant_id' | 'agent_id' | 'created_at' | 'updated_at'
    >,
  ): Promise<AgentAudienceProfile> {
    const guarded = applyTenantGuard(input);
    const rows = await db.insert(agent_audience_profiles).values(guarded).returning();
    return rows[0]! as AgentAudienceProfile;
  },
  async updateStatus(id: string, status: AgentAudienceProfile['status']): Promise<void> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    await db
      .update(agent_audience_profiles)
      .set({ status, updated_at: new Date() })
      .where(
        and(
          eq(agent_audience_profiles.id, id),
          eq(agent_audience_profiles.tenant_id, tenant_id),
          eq(agent_audience_profiles.agent_id, agent_id),
        ),
      );
  },
  async list(): Promise<AgentAudienceProfile[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(agent_audience_profiles)
      .where(
        and(
          eq(agent_audience_profiles.tenant_id, tenant_id),
          eq(agent_audience_profiles.agent_id, agent_id),
        ),
      );
    return rows as AgentAudienceProfile[];
  },
};

/**
 * agentToolGrantsRepo — the per-agent TOOL GRANT (issue #408).
 *
 * Answers "what tools does THIS AGENT have installed?" — the AGENT half of the
 * Runtime Tool Filter (the HUMAN half is `permissoesRepo`/`canAct`). Every
 * read/write is scoped to the current (tenant_id, agent_id) via the ALS
 * context, exactly like `agentAudienceProfilesRepo`. A grant belonging to
 * another (tenant, agent) is invisible (invariant #1).
 *
 * `forCurrentAgent()` is the runtime hot-path accessor used by the tool-slice
 * builder / dispatcher to compute the visible set. It fails CLOSED: if no row
 * exists, it returns the in-code default grant (baseline.core) so a brand-new
 * or un-backfilled agent still gets the conservative floor rather than zero
 * tools (or a thrown error in the hot path).
 */
export const agentToolGrantsRepo = {
  /**
   * Tenant+agent-scoped lookup of the effective grant. The (tenant, agent)
   * unique guarantees at most one row. A row from another (tenant, agent) is
   * invisible. Returns null when no grant row exists yet.
   */
  async findForCurrentAgent(): Promise<AgentToolGrantRow | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(agent_tool_grants)
      .where(
        and(
          eq(agent_tool_grants.tenant_id, tenant_id),
          eq(agent_tool_grants.agent_id, agent_id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },
  /**
   * Insert a grant for the current (tenant, agent). `tenant_id`/`agent_id` are
   * stamped from the ALS context by `applyTenantGuard`.
   */
  async create(
    input: Omit<NewAgentToolGrant, 'id' | 'tenant_id' | 'agent_id' | 'created_at' | 'updated_at'>,
  ): Promise<AgentToolGrantRow> {
    const guarded = applyTenantGuard(input);
    const rows = await db.insert(agent_tool_grants).values(guarded).returning();
    return rows[0]!;
  },
  /**
   * Upsert the effective grant for the current (tenant, agent). One grant per
   * agent, so we conflict on the (tenant_id, agent_id) unique and overwrite the
   * grant arrays + provenance. Bumps updated_at.
   */
  async upsertForCurrentAgent(
    input: Pick<NewAgentToolGrant, 'granted_packs' | 'granted_tools' | 'denied_tools'> &
      Partial<Pick<NewAgentToolGrant, 'granted_by' | 'reason'>>,
  ): Promise<AgentToolGrantRow> {
    const guarded = applyTenantGuard(input);
    const rows = await db
      .insert(agent_tool_grants)
      .values(guarded)
      .onConflictDoUpdate({
        target: [agent_tool_grants.tenant_id, agent_tool_grants.agent_id],
        set: {
          granted_packs: guarded.granted_packs,
          granted_tools: guarded.granted_tools,
          denied_tools: guarded.denied_tools,
          ...(guarded.granted_by !== undefined ? { granted_by: guarded.granted_by } : {}),
          ...(guarded.reason !== undefined ? { reason: guarded.reason } : {}),
          updated_at: new Date(),
        },
      })
      .returning();
    return rows[0]!;
  },
};

export const permissoesRepo = {
  // P83-C7: all permissoes reads + writes scoped to current tenant.
  async forPessoa(pessoa_id: string): Promise<Permissao[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(permissoes)
      .where(and(
        eq(permissoes.tenant_id, tenant_id),
        eq(permissoes.agent_id, agent_id),
        eq(permissoes.pessoa_id, pessoa_id),
        eq(permissoes.status, 'ativa'),
      ));
  },
  async byKey(pessoa_id: string, entidade_id: string): Promise<Permissao | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(permissoes)
      .where(and(
        eq(permissoes.tenant_id, tenant_id),
        eq(permissoes.agent_id, agent_id),
        eq(permissoes.pessoa_id, pessoa_id),
        eq(permissoes.entidade_id, entidade_id),
      ))
      .limit(1);
    return rows[0] ?? null;
  },
  async create(input: Omit<Permissao, 'id' | 'tenant_id' | 'agent_id' | 'created_at'>): Promise<Permissao> {
    const guarded = applyTenantGuard(input);
    const rows = await db.insert(permissoes).values(guarded).returning();
    return rows[0]!;
  },
  async updateStatus(id: string, status: Permissao['status']): Promise<void> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    await db
      .update(permissoes)
      .set({ status })
      .where(and(
        eq(permissoes.id, id),
        eq(permissoes.tenant_id, tenant_id),
        eq(permissoes.agent_id, agent_id),
      ));
  },

  /**
   * Issue #345 (Phase 4) — dispatcher enumeration for `inactivity-sweep`.
   *
   * Returns the DISTINCT (tenant_id, agent_id) tuples that могут have an
   * inactive non-owner permission to suspend — i.e. the tuples whose
   * `runInactivitySweepInner` UPDATE has anything to act on. The predicate
   * mirrors the inner's candidate set (an active `permissoes` row owned by a
   * non-owner pessoa, both in the same tenant/agent) but deliberately OMITS the
   * expensive `NOT EXISTS (recent message)` sub-query: the enumeration only
   * needs the tuple KEYS of agents that могут own inactive conversations; the
   * inner re-applies the full 60-day inactivity filter (scoped to the routed
   * tenant/agent) when it actually runs. Over-enumerating a tuple that turns out
   * to have no due row is harmless — the inner UPDATE simply matches zero rows.
   *
   * Runs OUTSIDE tenant context (it IS the dispatcher). Like the sibling fan-out
   * enumerations, it does NOT apply the tenant guard — cross-tenant iteration is
   * the worker's contract — and joins `permissoes`↔`pessoas` ONLY on matching
   * (tenant_id, agent_id) so the read never crosses a tenant boundary.
   * Belt-and-suspenders NOT NULL predicate mirrors #251/#292.
   */
  async listTenantAgentPairsWithInactiveCandidates(): Promise<
    Array<{ tenant_id: string; agent_id: string }>
  > {
    const result = await db.execute<{ tenant_id: string; agent_id: string }>(sql`
      SELECT DISTINCT p.tenant_id, p.agent_id
      FROM ${permissoes} p
      JOIN ${pessoas} ps
        ON p.pessoa_id = ps.id
       AND ps.tenant_id = p.tenant_id
       AND ps.agent_id = p.agent_id
      WHERE p.tenant_id IS NOT NULL
        AND p.agent_id IS NOT NULL
        AND p.status = 'ativa'
        AND ps.tipo NOT IN ('dono', 'co_dono')
    `);
    return Array.from(
      result.rows as unknown as Array<{ tenant_id: string; agent_id: string }>,
    );
  },
};

export const profilesRepo = {
  async byId(id: string): Promise<PermissionProfile | null> {
    const rows = await db
      .select()
      .from(permission_profiles)
      .where(eq(permission_profiles.id, id))
      .limit(1);
    return rows[0] ?? null;
  },
  async list(): Promise<PermissionProfile[]> {
    return db.select().from(permission_profiles);
  },
};

export const conversasRepo = {
  async findActive(pessoa_id: string): Promise<Conversa | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(conversas)
      .where(
        and(
          eq(conversas.tenant_id, tenant_id),
          eq(conversas.agent_id, agent_id),
          eq(conversas.pessoa_id, pessoa_id),
          eq(conversas.status, 'ativa'),
        ),
      )
      .orderBy(desc(conversas.ultima_atividade_em))
      .limit(1);
    return rows[0] ?? null;
  },
  async byId(id: string): Promise<Conversa | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(conversas)
      .where(
        and(
          eq(conversas.tenant_id, tenant_id),
          eq(conversas.agent_id, agent_id),
          eq(conversas.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },
  async create(input: {
    pessoa_id: string;
    escopo_entidades: string[];
  }): Promise<Conversa> {
    const guarded = applyTenantGuard({
      pessoa_id: input.pessoa_id,
      escopo_entidades: input.escopo_entidades,
    });
    const rows = await db.insert(conversas).values(guarded).returning();
    return rows[0]!;
  },
  async touch(id: string): Promise<void> {
    // Flip-readiness (#323): scope the last-activity bump to the current
    // (tenant_id, agent_id) — bound from ALS — mirroring the hardened `close`
    // above. Both columns are NOT NULL; every caller runs inside
    // `runWithTenantContext` with a real pair (the agent core's
    // `runAgentForMensagemInner`, wrapped at core.ts via
    // `runWithTenantContext({tenant_id, agent_id})`, plus `identity/resolver`
    // which reaches `touch` only after the agent-scoped `findActive`/`create`
    // resolved `c` under the SAME context — so `c.agent_id === getCurrentAgent()`).
    // Deliberately NO row-count assertion: `touch` is a best-effort
    // last-activity bump on the hot path; a 0-row no-op (e.g. a future legacy
    // default/default path) must NEVER crash message processing. Predicate
    // only — defense-in-depth without a hot-path failure mode.
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    await db
      .update(conversas)
      .set({ ultima_atividade_em: new Date() })
      .where(
        and(
          eq(conversas.id, id),
          eq(conversas.tenant_id, tenant_id),
          eq(conversas.agent_id, agent_id),
        ),
      );
  },
  async updateMetadata(id: string, metadata: Record<string, unknown>): Promise<void> {
    // Flip-readiness (#323): tenant+agent scope the WHERE (bound from ALS), as
    // with the sibling metadata writers below. PREDICATE-ONLY (no row-count
    // assertion): this full-object setter currently has NO live caller in
    // `src/` (the lightweight-pending flow that used it was deprecated in favour
    // of the atomic `mergeMetadata`/`unsetMetadataKey` jsonb variants), so there
    // is no caller whose "row must exist" expectation we can confirm — per the
    // brief's "if unsure, scope without the throw" guidance we add the predicate
    // and stop short of fail-loud.
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    await db
      .update(conversas)
      .set({ metadata })
      .where(
        and(
          eq(conversas.id, id),
          eq(conversas.tenant_id, tenant_id),
          eq(conversas.agent_id, agent_id),
        ),
      );
  },
  /**
   * Atomic partial merge into conversas.metadata via the jsonb `||`
   * operator. Issue #73: avoids losing concurrent keys (e.g. pending_question)
   * when two workers race to write metadata. Existing keys in `patch`
   * overwrite existing keys in metadata; everything else is preserved.
   */
  async mergeMetadata(id: string, patch: Record<string, unknown>): Promise<void> {
    // Flip-readiness (#323): tenant+agent scope the WHERE (bound from ALS). The
    // only LIVE caller is the agent core's post-turn scope-hash persist
    // (core.ts), which runs inside `runWithTenantContext({tenant_id, agent_id})`
    // on a conversa `c` it already resolved under the SAME context — so
    // `c.agent_id === getCurrentAgent()` and the predicate matches. (The
    // deprecated `setLightweightPending` path is dead code: no live caller.)
    // PREDICATE-ONLY (no throw): that caller wraps this in try/catch and treats
    // it as explicitly best-effort ("last-writer-wins ... is fine"); a 0-row
    // no-op is benign there, so a fail-loud assertion would only ever degrade to
    // a swallowed warning while risking the hot path. Predicate only.
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    await db
      .update(conversas)
      .set({ metadata: sql`${conversas.metadata} || ${JSON.stringify(patch)}::jsonb` })
      .where(
        and(
          eq(conversas.id, id),
          eq(conversas.tenant_id, tenant_id),
          eq(conversas.agent_id, agent_id),
        ),
      );
  },
  /**
   * Atomic key removal from conversas.metadata via the jsonb `-` operator.
   * Superpowers I3 (PR #74): paired with `mergeMetadata` for the deprecated
   * lightweight-pending-question flow so a clear-pending operation no
   * longer races with concurrent `mergeMetadata` writes (e.g.
   * `last_scope_hash`) — the previous `updateMetadata` full-object set
   * would silently drop concurrent keys.
   */
  async unsetMetadataKey(id: string, key: string): Promise<void> {
    // Flip-readiness (#323): tenant+agent scope the WHERE (bound from ALS),
    // mirroring `mergeMetadata`. PREDICATE-ONLY (no throw): this is reachable
    // only through the deprecated lightweight-pending chain
    // (`clearLightweightPending` ← `applyResolution`), which has NO live caller
    // in `src/` — so there is no caller whose row-existence expectation we can
    // confirm. Per "if unsure, scope without the throw", predicate only.
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    await db
      .update(conversas)
      .set({ metadata: sql`${conversas.metadata} - ${key}` })
      .where(
        and(
          eq(conversas.id, id),
          eq(conversas.tenant_id, tenant_id),
          eq(conversas.agent_id, agent_id),
        ),
      );
  },
  async close(id: string, contexto_resumido: string): Promise<void> {
    // Issue #345 (Phase 4 review): `conversation-summarizer` runs PER enumerated
    // (tenant_id, agent_id) tuple and calls this to close stale conversations.
    // Scope the UPDATE to the current (tenant_id, agent_id) — bound from ALS —
    // as defense-in-depth so a per-tuple run can never close a conversation
    // owned by another tenant even if a caller passed a foreign `id` (the
    // inviolable cross-tenant isolation invariant). Both columns are NOT NULL
    // and the enumeration partitions on the same pair.
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    await db
      .update(conversas)
      .set({ status: 'encerrada', contexto_resumido })
      .where(
        and(
          eq(conversas.id, id),
          eq(conversas.tenant_id, tenant_id),
          eq(conversas.agent_id, agent_id),
        ),
      );
  },
  async invalidateScopeForPessoa(pessoa_id: string): Promise<void> {
    // Flip-readiness (#323): bulk UPDATE by pessoa_id — tenant+agent scope the
    // WHERE (bound from ALS) so a pessoa shared across tenants can never have
    // another tenant's conversa scope invalidated. NO row-count assertion: this
    // is a bulk write (a pessoa may own 0..N conversas) where a variable/0 row
    // count is legitimate. (Currently no live caller in `src/`; predicate added
    // proactively for the flip per the audit.)
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    await db
      .update(conversas)
      .set({ escopo_entidades: [] })
      .where(
        and(
          eq(conversas.pessoa_id, pessoa_id),
          eq(conversas.tenant_id, tenant_id),
          eq(conversas.agent_id, agent_id),
        ),
      );
  },

  /**
   * Issue #345 (Phase 4) — dispatcher enumeration for `conversation-summarizer`.
   *
   * Returns the DISTINCT (tenant_id, agent_id) tuples that own at least one
   * stale conversation needing a summary — i.e. exactly the tuples whose
   * `runConversationSummarizerInner` SELECT would return rows. The predicate
   * mirrors the inner's filter EXACTLY (`status='ativa' AND ultima_atividade_em
   * < now() - interval '7 days'`) so a tuple is enumerated iff the inner has at
   * least one conversation to summarize. (The inner additionally caps at 10 rows
   * per pass; that LIMIT only bounds work volume, not which tuples have work, so
   * it is intentionally not part of the enumeration predicate.)
   *
   * Runs OUTSIDE tenant context (it IS the dispatcher); no tenant guard
   * (cross-tenant iteration is the worker's contract). Belt-and-suspenders
   * NOT NULL predicate mirrors #251/#292.
   */
  async listTenantAgentPairsWithStaleConversations(): Promise<
    Array<{ tenant_id: string; agent_id: string }>
  > {
    const result = await db.execute<{ tenant_id: string; agent_id: string }>(sql`
      SELECT DISTINCT tenant_id, agent_id
      FROM ${conversas}
      WHERE tenant_id IS NOT NULL
        AND agent_id IS NOT NULL
        AND status = 'ativa'
        AND ${conversas.ultima_atividade_em} < now() - interval '7 days'
    `);
    return Array.from(
      result.rows as unknown as Array<{ tenant_id: string; agent_id: string }>,
    );
  },
};

export const mensagensRepo = {
  async create(input: Omit<Mensagem, 'id' | 'tenant_id' | 'agent_id' | 'created_at'>): Promise<Mensagem> {
    const guarded = applyTenantGuard(input);
    const rows = await db.insert(mensagens).values(guarded).returning();
    return rows[0]!;
  },
  async createInbound(
    input: Omit<Mensagem, 'id' | 'tenant_id' | 'agent_id' | 'created_at'>,
  ): Promise<{ row: Mensagem; duplicate: boolean }> {
    const wid = (input.metadata as Record<string, unknown> | null)?.['whatsapp_id'];
    if (typeof wid === 'string' && wid.length > 0) {
      const existing = await this.findByWhatsappId(wid);
      if (existing) return { row: existing, duplicate: true };
    }
    try {
      const guarded = applyTenantGuard(input);
      const rows = await db.insert(mensagens).values(guarded).returning();
      return { row: rows[0]!, duplicate: false };
    } catch (err) {
      // Unique-violation race: re-fetch and treat as duplicate.
      // pgErrorCode unwraps Drizzle's DrizzleQueryError so the underlying pg
      // SQLSTATE (on `.cause`) is read, not the wrapper's undefined code.
      if (typeof wid === 'string' && pgErrorCode(err) === '23505') {
        const existing = await this.findByWhatsappId(wid);
        if (existing) return { row: existing, duplicate: true };
      }
      throw err;
    }
  },
  async listUnprocessedOlderThan(ms: number, limit = 100): Promise<Mensagem[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const cutoff = new Date(Date.now() - ms);
    return db
      .select()
      .from(mensagens)
      .where(
        and(
          eq(mensagens.tenant_id, tenant_id),
          eq(mensagens.agent_id, agent_id),
          isNull(mensagens.processada_em),
          eq(mensagens.direcao, 'in'),
          sql`created_at < ${cutoff.toISOString()}`,
        ),
      )
      .orderBy(mensagens.created_at)
      .limit(limit);
  },
  /**
   * Issue #345 (Phase 4 of #323) — dispatcher enumeration for `message-recovery`.
   *
   * Returns the DISTINCT (tenant_id, agent_id) tuples that own at least one
   * stuck inbound message — i.e. exactly the tuples whose `listUnprocessedOlderThan`
   * inner has rows to re-enqueue. The predicate mirrors that inner's filter
   * EXACTLY (`processada_em IS NULL AND direcao = 'in' AND created_at < cutoff`)
   * so a tuple is enumerated iff the inner would find work for it. `ms` is the
   * same `STUCK_AFTER_MS` the worker passes to the inner, applied here as the
   * cutoff so the dispatcher and inner agree on staleness.
   *
   * Runs OUTSIDE tenant context (it IS the dispatcher); no tenant guard
   * (cross-tenant iteration is the worker's contract). Belt-and-suspenders
   * `tenant_id/agent_id IS NOT NULL` mirrors #251/#292. Before this fix the
   * worker ran the inner under a hardcoded `default/default` context, so only
   * the default agent's stranded messages were ever re-enqueued.
   */
  async listTenantAgentPairsWithUnprocessedOlderThan(
    ms: number,
  ): Promise<Array<{ tenant_id: string; agent_id: string }>> {
    const cutoff = new Date(Date.now() - ms);
    const result = await db.execute<{ tenant_id: string; agent_id: string }>(sql`
      SELECT DISTINCT tenant_id, agent_id
      FROM ${mensagens}
      WHERE tenant_id IS NOT NULL
        AND agent_id IS NOT NULL
        AND processada_em IS NULL
        AND direcao = 'in'
        AND created_at < ${cutoff.toISOString()}
    `);
    return Array.from(
      result.rows as unknown as Array<{ tenant_id: string; agent_id: string }>,
    );
  },
  async findById(id: string): Promise<Mensagem | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(mensagens)
      .where(
        and(
          eq(mensagens.tenant_id, tenant_id),
          eq(mensagens.agent_id, agent_id),
          eq(mensagens.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },
  async findByWhatsappId(whatsapp_id: string): Promise<Mensagem | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(mensagens)
      .where(
        and(
          eq(mensagens.tenant_id, tenant_id),
          eq(mensagens.agent_id, agent_id),
          sql`metadata->>'whatsapp_id' = ${whatsapp_id}`,
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },
  async recentInConversation(conversa_id: string, n = 20): Promise<Mensagem[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(mensagens)
      .where(
        and(
          eq(mensagens.tenant_id, tenant_id),
          eq(mensagens.agent_id, agent_id),
          eq(mensagens.conversa_id, conversa_id),
        ),
      )
      .orderBy(desc(mensagens.created_at))
      .limit(n);
  },
  /**
   * Inbound messages from a given telefone (`metadata->>'telefone'`) that
   * haven't been processed yet, in chronological order (oldest first).
   *
   * Keyed off telefone — NOT conversa_id — because at the moment the
   * debounce worker fires, only the target message has had its
   * conversa_id resolved by the agent. Earlier chunks from the same
   * burst still carry `conversa_id IS NULL` (baileys saves all inbounds
   * with null conversa_id; resolution happens in `runAgentForMensagem`).
   * Querying by conversa_id would silently miss them.
   *
   * `excludeId` lets the caller skip the "target" message that triggered
   * the run. The result includes orphans (`conversa_id IS NULL`) and
   * messages already attached to a conversa — caller filters by
   * conversa_id == target's OR null to avoid cross-conversation leakage
   * (defensive: telefone is 1:1 with pessoa, so leakage is theoretical).
   */
  async listUnprocessedByTelefone(
    telefone: string,
    opts?: { excludeId?: string; limit?: number },
  ): Promise<Mensagem[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const limit = opts?.limit ?? 50;
    const rows = await db
      .select()
      .from(mensagens)
      .where(
        and(
          eq(mensagens.tenant_id, tenant_id),
          eq(mensagens.agent_id, agent_id),
          eq(mensagens.direcao, 'in'),
          isNull(mensagens.processada_em),
          sql`metadata->>'telefone' = ${telefone}`,
        ),
      )
      .orderBy(mensagens.created_at)
      .limit(limit);
    if (opts?.excludeId) return rows.filter((r) => r.id !== opts.excludeId);
    return rows;
  },
  async setConversaId(id: string, conversa_id: string): Promise<void> {
    // Flip-readiness (#323): tenant+agent scope the WHERE (bound from ALS),
    // mirroring `mensagensRepo.findById` which gates on the same pair. Both
    // columns are NOT NULL. The two live callers (agent core, core.ts) both run
    // inside `runWithTenantContext({tenant_id, agent_id})` and act on the
    // `inbound` row that `findById(mensagem_id)` ALREADY resolved under the SAME
    // (tenant_id, agent_id) — so `inbound.agent_id === getCurrentAgent()` and
    // the predicate matches the exact row.
    // FAIL-LOUD (throw on !=1): this targets one specific, known-present row
    // (the inbound just loaded by the agent-scoped findById) and is NOT a
    // best-effort path — a 0-row no-op would silently fail to attach the message
    // to its conversation, corrupting history/recovery linkage. The previous
    // id-only WHERE always matched, so a silent miss under the new predicate
    // would be a regression; turn it into a loud failure. Same
    // `.returning({id})` + `.length` idiom as `updateStateTx` /
    // `adoptToResolvedTenantCrossTenant`.
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const updated = await db
      .update(mensagens)
      .set({ conversa_id })
      .where(
        and(
          eq(mensagens.id, id),
          eq(mensagens.tenant_id, tenant_id),
          eq(mensagens.agent_id, agent_id),
        ),
      )
      .returning({ id: mensagens.id });
    if (updated.length !== 1) {
      throw new Error(
        `mensagensRepo.setConversaId matched ${updated.length} rows for mensagem ` +
          `${id} under ${tenant_id}/${agent_id} — expected 1 (tenant/agent ` +
          `context does not match the target row; the conversa linkage would ` +
          `have been silently lost)`,
      );
    }
  },
  /**
   * Bulk variant for the debounce aggregation path: adopts orphan
   * inbound rows (conversa_id null) into the conversation that the
   * target message resolved to. One UPDATE round-trip instead of N.
   */
  async setConversaIdMany(ids: string[], conversa_id: string): Promise<void> {
    if (ids.length === 0) return;
    // Flip-readiness (#323): bulk UPDATE over `inArray(id, ids)` — tenant+agent
    // scope the WHERE (bound from ALS) so the debounce-adoption pass can only
    // re-home THIS tenant/agent's orphan inbound rows. The sole live caller
    // (agent core, core.ts) runs inside `runWithTenantContext({tenant_id,
    // agent_id})` and passes ids drawn from `aggregateUnprocessedTexts`, which
    // selects via the agent-scoped `listUnprocessedByTelefone` — so every id
    // already belongs to the running pair. NO row-count assertion: this is a
    // bulk write whose matched count is intentionally variable (the method is a
    // documented no-op for ids already attached to the conversa), so an exact-N
    // assertion would be wrong; the caller also treats it as best-effort.
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    await db
      .update(mensagens)
      .set({ conversa_id })
      .where(
        and(
          inArray(mensagens.id, ids),
          eq(mensagens.tenant_id, tenant_id),
          eq(mensagens.agent_id, agent_id),
        ),
      );
  },
  async markProcessed(id: string, tokens: number | null): Promise<void> {
    // Flip-readiness (#323): tenant+agent scope the WHERE (bound from ALS),
    // mirroring `mensagensRepo.findById`. Both columns are NOT NULL. Every live
    // caller is the agent core (core.ts), inside
    // `runWithTenantContext({tenant_id, agent_id})`, marking either the `inbound`
    // row that the agent-scoped `findById` resolved under the SAME pair, or its
    // debounce siblings (selected via the agent-scoped
    // `listUnprocessedByTelefone`) — so every targeted row carries the running
    // (tenant_id, agent_id) and the predicate matches.
    // FAIL-LOUD (throw on !=1): this stamps `processada_em` on one specific,
    // known-present row to mark a turn done. A silent 0-row no-op would leave
    // the row unprocessed and the recovery worker would requeue it forever
    // (or, for the unknown/blocked/quarantined drop paths, re-deliver to the
    // LLM) — a real bug, not a benign miss. The id-only WHERE always matched, so
    // a silent miss under the new predicate is a regression worth surfacing
    // loudly. (Where a caller treats marking as best-effort — the
    // `markAllProcessed` per-row loop in core.ts — it already wraps this in
    // try/catch, so the throw degrades to a logged warning there rather than
    // crashing the turn; the strict paths (unknown/blocked/quarantined drops)
    // get the loud failure.) Same `.returning({id})` + `.length` idiom as the
    // sibling compare-and-swap writes.
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const updated = await db
      .update(mensagens)
      .set({ processada_em: new Date(), tokens_usados: tokens ?? null })
      .where(
        and(
          eq(mensagens.id, id),
          eq(mensagens.tenant_id, tenant_id),
          eq(mensagens.agent_id, agent_id),
        ),
      )
      .returning({ id: mensagens.id });
    if (updated.length !== 1) {
      throw new Error(
        `mensagensRepo.markProcessed matched ${updated.length} rows for mensagem ` +
          `${id} under ${tenant_id}/${agent_id} — expected 1 (tenant/agent ` +
          `context does not match the target row; the message would have been ` +
          `left unprocessed and requeued indefinitely)`,
      );
    }
  },

  // [P88-C1] EXPLICITLY bypasses applyTenantGuard — the channel resolver
  // runs BEFORE tenant context exists (it's the entry point that DISCOVERS
  // which tenant owns the inbound). If a non-default channel resolves to
  // (tenantX, agentX) but the gateway persisted the row under (default,
  // default), the post-resolution tenant-scoped findById would return null
  // and the turn would be silently dropped. This method atomically adopts
  // the row to the resolved triplet so the inner tenant-scoped read finds
  // it. Same sanctioned-bypass pattern as channelsRepo.findByExternalCrossTenant.
  //
  // [Codex review #311 — CRITICAL P0 cross-tenant adoption race]
  // The UPDATE re-asserts `tenant_id='default' AND agent_id='default'` in its
  // WHERE clause. This is the load-bearing safety property, not a cosmetic
  // guard:
  //   - The inbound row is first persisted by the gateway under the legacy
  //     `default/default` context, then ADOPTED into the resolved tenant by
  //     this method. Keying the UPDATE by `id` ALONE meant any caller holding
  //     that id could rewrite `(tenant_id, agent_id)` to an ARBITRARY triplet
  //     at any time — including AFTER the row had already been adopted into
  //     tenant-A. A concurrent worker that re-resolved the same row to
  //     tenant-B (stale resolver cache, mis-seeded channel, BullMQ retry
  //     racing a fresh enqueue) would silently steal the row across the
  //     tenant boundary — a direct violation of the inviolable isolation
  //     contract.
  //   - Re-asserting `default/default` in the WHERE makes adoption a
  //     COMPARE-AND-SWAP: a row can be adopted out of `default/default`
  //     exactly ONCE. Once it belongs to tenant-A, no later call (for any
  //     other tenant, or a duplicate for the same one) can match the WHERE,
  //     so the row can never be re-homed. The single UPDATE is atomic at the
  //     Postgres level (row lock for the duration of the statement), so two
  //     concurrent adoptions cannot both win — exactly one observes
  //     rowCount=1, the loser observes rowCount=0.
  //   - Idempotency for BullMQ retries is preserved: re-running adoption for
  //     the SAME target tenant after the row already moved is simply a
  //     rowCount=0 no-op (the row no longer matches `default/default`), which
  //     the caller treats as "already adopted by me" — see the post-adoption
  //     ownership re-check in agent/core.ts.
  //
  // Returns `true` when THIS call performed the adoption (row was still
  // `default/default` and is now the resolved triplet), `false` when the row
  // was already adopted (by a prior call / concurrent winner) or no longer
  // exists. Callers MUST treat `false` as "I did not win — verify the row's
  // current owner before proceeding" rather than assuming success.
  async adoptToResolvedTenantCrossTenant(args: {
    id: string;
    tenant_id: string;
    agent_id: string;
  }): Promise<boolean> {
    const updated = await db
      .update(mensagens)
      .set({ tenant_id: args.tenant_id, agent_id: args.agent_id })
      .where(
        and(
          eq(mensagens.id, args.id),
          eq(mensagens.tenant_id, 'default'),
          eq(mensagens.agent_id, 'default'),
        ),
      )
      .returning({ id: mensagens.id });
    return updated.length > 0;
  },

  // [Codex review #311 — CRITICAL P0] EXPLICITLY bypasses applyTenantGuard —
  // same sanctioned-entry-point pattern as `adoptToResolvedTenantCrossTenant`.
  // Returns ONLY the owning `(tenant_id, agent_id)` of a row by id, with NO
  // tenant scoping. Sole consumer is the post-adoption ownership re-check in
  // `runAgentForMensagem`: when the compare-and-swap adoption returns `false`
  // (the row was NOT still `default/default`), the caller must learn WHO owns
  // the row now before deciding whether it may proceed. If the row already
  // belongs to the tenant we resolved, we won an earlier idempotent retry and
  // proceed; if it belongs to a DIFFERENT tenant, a concurrent worker adopted
  // it cross-tenant and we MUST abort rather than process it under our context
  // (that would re-introduce the very cross-tenant leak this review closed).
  // Projecting only the two scope columns keeps the leak surface minimal — the
  // caller never sees another tenant's message body via this path.
  async findOwnerByIdCrossTenant(
    id: string,
  ): Promise<{ tenant_id: string; agent_id: string } | null> {
    const rows = await db
      .select({ tenant_id: mensagens.tenant_id, agent_id: mensagens.agent_id })
      .from(mensagens)
      .where(eq(mensagens.id, id))
      .limit(1);
    return rows[0] ?? null;
  },

  // [Codex review #277 v2] EXPLICITLY bypasses applyTenantGuard — same
  // sanctioned-entry-point pattern as `adoptToResolvedTenantCrossTenant`
  // and `channelsRepo.findByExternalCrossTenant`. Used by the Baileys
  // `messages.update` listener (edits + revokes), which runs BEFORE any
  // tenant context exists (Baileys is the inbound entry point — the
  // tenant of the original message is exactly what we need to DISCOVER
  // here so the dispatch can re-enter inside the correct ALS context).
  //
  // Necessity: `runAgentForMensagem` adopts inbound rows from
  // (default, default) into the resolved tenant via
  // `adoptToResolvedTenantCrossTenant`. A subsequent edit/revoke arrives
  // via `messages.update` with NO tenant context — running the tenant-
  // scoped `findByWhatsappId` under `default/default` would miss the
  // (now-adopted) original and the edit/revoke would be silently dropped
  // (Codex BLOQUEADO iteração 2: edit_unknown_original / revoke_unknown_original).
  //
  // Safety: `migrations/003_review_fixes.sql` declares
  //   CREATE UNIQUE INDEX uniq_mensagens_whatsapp_id
  //     ON mensagens ((metadata->>'whatsapp_id')) WHERE metadata ? 'whatsapp_id';
  // So at most one row exists for a given whatsapp_id globally — no
  // cross-tenant ambiguity. The caller (gateway/baileys.ts) re-enters
  // `runWithTenantContext({tenant_id, agent_id})` of the resolved row
  // before invoking `routeMessageUpdate`, restoring full tenant scoping
  // for every downstream read/write.
  async findByWhatsappIdCrossTenant(
    whatsapp_id: string,
  ): Promise<Mensagem | null> {
    const rows = await db
      .select()
      .from(mensagens)
      .where(sql`metadata->>'whatsapp_id' = ${whatsapp_id}`)
      .limit(1);
    return rows[0] ?? null;
  },
};

export const entidadesRepo = {
  /**
   * Issue #345 (Phase 4 of #323) — tenant-scope the entity list.
   *
   * `list()` feeds the briefing inners (morning/evening/weekly), which now run
   * ONCE PER enumerated (tenant_id, agent_id) tuple. An UNSCOPED `select(entidades)`
   * would return EVERY tenant's entities under each tuple's run, and the morning
   * briefing's per-entity `contasRepo.byEntity()` + balance sum would then mix
   * another tenant's accounts into the briefing sent to THIS tenant's owner — a
   * severe cross-tenant financial leak (the inviolable isolation invariant). Bind
   * the current ALS (tenant_id, agent_id) so the list is the running tuple's
   * entities only. `entidades` carries both columns (schema NOT NULL), so the
   * predicate is exact.
   */
  async list(): Promise<Entidade[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(entidades)
      .where(and(eq(entidades.tenant_id, tenant_id), eq(entidades.agent_id, agent_id)));
  },
  async byId(id: string): Promise<Entidade | null> {
    const rows = await db.select().from(entidades).where(eq(entidades.id, id)).limit(1);
    return rows[0] ?? null;
  },
  async byIds(ids: string[]): Promise<Entidade[]> {
    if (ids.length === 0) return [];
    return db.select().from(entidades).where(inArray(entidades.id, ids));
  },
  async create(input: Omit<Entidade, 'id' | 'tenant_id' | 'agent_id' | 'created_at' | 'updated_at'>): Promise<Entidade> {
    const guarded = applyTenantGuard(input);
    const rows = await db.insert(entidades).values(guarded).returning();
    return rows[0]!;
  },
};

export const contasRepo = {
  /**
   * Issue #345 (Phase 4 of #323) — tenant-scope the per-entity account read.
   *
   * `byEntity()` is called by the morning briefing inner (per entity, per tuple)
   * and by read tools (`query-balance`, `compare-entities`). Filtering by
   * `entidade_id` ALONE is not enough: `entidade_id` is a random UUID, but a
   * per-tuple briefing run that already (pre-fix) saw another tenant's entities
   * would then read that entity's accounts and sum their balances into THIS
   * tenant's briefing. Add an EXPLICIT (tenant_id, agent_id) predicate bound from
   * ALS so a row is returned iff it belongs to the running tuple — defense in
   * depth alongside the now-scoped `entidadesRepo.list()`. `contas_bancarias`
   * carries both columns (schema NOT NULL).
   */
  async byEntity(entidade_id: string): Promise<Conta[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(contas_bancarias)
      .where(
        and(
          eq(contas_bancarias.tenant_id, tenant_id),
          eq(contas_bancarias.agent_id, agent_id),
          eq(contas_bancarias.entidade_id, entidade_id),
        ),
      );
  },
  async byId(id: string): Promise<Conta | null> {
    // Flip-readiness (#323, H3 of #355 — PR #364 review blocker 1) — FINANCIAL
    // pre-write lookup: tenant+agent scope the WHERE (bound from ALS), mirroring
    // the now-scoped `byEntity` read and the `addToBalance` write below. Both
    // columns are NOT NULL (schema `contas_bancarias`). Both live callers run
    // inside the agent turn's `runWithTenantContext({tenant_id, agent_id})`
    // (agent/core.ts `runAgentForMensagem`):
    //   - `tools/register-transaction.ts` pre-loads the conta here BEFORE the
    //     balance write; an id-only WHERE would let a misrouted/cross-tenant
    //     account id pass this pre-check and only trip the now-scoped
    //     `addToBalance` 0-row guard AFTER the ledger row committed. Scoping the
    //     read rejects the cross-tenant account EARLY (returns null →
    //     `conta_not_found`), so the transaction is never created.
    //   - `tools/query-balance.ts` already discards an out-of-scope conta via
    //     `ctx.scope.entidades.includes(c.entidade_id)`; the predicate just makes
    //     the read itself tenant-safe (defense in depth — a foreign conta no
    //     longer even loads).
    // Returns null (not throw) on no-match: a missing/foreign account is a
    // legitimate not-found for a READ, and both callers already handle null.
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(contas_bancarias)
      .where(
        and(
          eq(contas_bancarias.tenant_id, tenant_id),
          eq(contas_bancarias.agent_id, agent_id),
          eq(contas_bancarias.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },
  async byEntities(scope: EntityScope): Promise<Conta[]> {
    if (scope.entidades.length === 0) throw new EmptyScopeError();
    return db
      .select()
      .from(contas_bancarias)
      .where(inArray(contas_bancarias.entidade_id, scope.entidades));
  },
  async create(input: Omit<Conta, 'id' | 'tenant_id' | 'agent_id' | 'created_at' | 'updated_at'>): Promise<Conta> {
    const guarded = applyTenantGuard(input);
    const rows = await db.insert(contas_bancarias).values(guarded).returning();
    return rows[0]!;
  },
  async addToBalance(id: string, delta: number): Promise<Conta | null> {
    // Non-tx entry point (kept for callers that don't need to bundle the credit
    // with another write). Delegates to the shared scoped + fail-loud core on
    // the pooled `db` handle. `register-transaction.ts` now uses `addToBalanceTx`
    // so the credit is atomic with its ledger INSERT (see below).
    return addToBalanceWith(db, id, delta);
  },
  /**
   * Flip-readiness (#323, H3 of #355 — PR #364 review blocker 2) — tx-aware
   * balance credit, identical scoping + fail-loud to `addToBalance` but issued
   * on the caller's in-tx handle so it commits ATOMICALLY with a paired
   * `transacoesRepo.createTx` ledger INSERT inside one `withTx`. A 0-row throw
   * (cross-tenant misroute) then rolls the ledger row back too — closing the
   * "committed transaction with no balance credit" inconsistency. Mirrors the
   * `*Tx` convention (`pendingQuestionsRepo.resolveTx`). Caller MUST already be
   * inside `withTx`.
   */
  async addToBalanceTx(tx: typeof db, id: string, delta: number): Promise<Conta | null> {
    return addToBalanceWith(tx, id, delta);
  },
};

/**
 * Shared scoped + FAIL-LOUD core for `contasRepo.addToBalance` /
 * `addToBalanceTx`. Kept as ONE function so the tenant/agent predicate and the
 * 0-row guard can never drift between the pooled-`db` and the in-`tx` paths.
 *
 * Flip-readiness (#323, H3 of #355) — FINANCIAL mutation: tenant+agent scope the
 * WHERE (bound from ALS), mirroring the now-scoped `contasRepo.byEntity` /
 * `byId`. Both columns are NOT NULL (schema `contas_bancarias`). The sole live
 * caller (`tools/register-transaction.ts`) runs inside the agent turn's
 * `runWithTenantContext({tenant_id, agent_id})` (agent/core.ts
 * `runAgentForMensagem`) and only ever adjusts the `conta` it loaded via the
 * now-scoped `contasRepo.byId(conta_id)` + asserted `conta.entidade_id ===
 * args.entidade_id`, where `args.entidade_id` was authorized against the running
 * tuple's entity scope by the dispatcher — so the conta belongs to the running
 * (tenant_id, agent_id) and the predicate matches the exact row.
 *
 * FAIL-LOUD (throw on !=1): this UPDATEs one specific, known-present account's
 * running balance by an exact numeric delta. The id-only WHERE always matched,
 * so a 0-row result under the new predicate can ONLY mean a tenant/agent
 * mismatch (a cross-tenant misroute) — NOT a benign no-op. Silently swallowing
 * that miss would leave `saldo_atual` un-incremented while the matching
 * `transacoes` row already exists: the balance and its ledger would diverge
 * permanently — corrupted money. There is no legitimate 0-row path (the caller
 * gates the call itself behind `status==='paga'|'recebida'`; when it does call,
 * the target account is the one it just loaded), so we surface the miss loudly
 * instead of returning `null`. Same `.returning()` + `.length` idiom as
 * `mensagensRepo.markProcessed` / `pendingQuestionsRepo.resolve`. The thrown
 * message keeps the `addToBalance matched N rows` token across both entry points
 * so dashboards/tests match either path.
 */
async function addToBalanceWith(
  executor: typeof db,
  id: string,
  delta: number,
): Promise<Conta | null> {
  const tenant_id = getCurrentTenant();
  const agent_id = getCurrentAgent();
  const rows = await executor
    .update(contas_bancarias)
    .set({
      saldo_atual: sql`saldo_atual + ${delta}`,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(contas_bancarias.id, id),
        eq(contas_bancarias.tenant_id, tenant_id),
        eq(contas_bancarias.agent_id, agent_id),
      ),
    )
    .returning();
  if (rows.length !== 1) {
    throw new Error(
      `contasRepo.addToBalance matched ${rows.length} rows for conta ${id} ` +
        `under ${tenant_id}/${agent_id} — expected 1 (tenant/agent context does ` +
        `not match the target account; the balance update would have been ` +
        `silently lost while its transaction already committed — corrupted money)`,
    );
  }
  return rows[0] ?? null;
}

export const transacoesRepo = {
  async byScope(
    scope: EntityScope,
    filter?: {
      date_from?: string;
      date_to?: string;
      categoria_id?: string;
      natureza?: string;
      limit?: number;
      offset?: number;
    },
  ): Promise<Transacao[]> {
    if (scope.entidades.length === 0) throw new EmptyScopeError();
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const conds = [
      eq(transacoes.tenant_id, tenant_id),
      eq(transacoes.agent_id, agent_id),
      inArray(transacoes.entidade_id, scope.entidades),
    ];
    if (filter?.date_from) conds.push(sql`data_competencia >= ${filter.date_from}`);
    if (filter?.date_to) conds.push(sql`data_competencia <= ${filter.date_to}`);
    if (filter?.categoria_id) conds.push(eq(transacoes.categoria_id, filter.categoria_id));
    if (filter?.natureza) conds.push(eq(transacoes.natureza, filter.natureza));
    return db
      .select()
      .from(transacoes)
      .where(and(...conds))
      .orderBy(desc(transacoes.data_competencia))
      .limit(filter?.limit ?? 50)
      .offset(filter?.offset ?? 0);
  },
  async create(input: Omit<Transacao, 'id' | 'tenant_id' | 'agent_id' | 'created_at' | 'updated_at'>): Promise<Transacao> {
    const guarded = applyTenantGuard(input);
    const rows = await db.insert(transacoes).values(guarded).returning();
    return rows[0]!;
  },
  /**
   * Flip-readiness (#323, H3 of #355 — PR #364 review blocker 2) — tx-aware
   * INSERT of the ledger row, so a caller can commit it ATOMICALLY with the
   * paired `contasRepo.addToBalanceTx` balance credit inside one `withTx`.
   *
   * `register-transaction.ts` previously committed `create` (ledger row) and
   * THEN called the now-fail-loud `addToBalance`; a 0-row throw there (a
   * cross-tenant misroute the scoped predicate catches) left a committed
   * transaction with NO matching balance credit — the ledger and `saldo_atual`
   * diverge permanently (corrupted money). Running both writes through the SAME
   * `tx` means the `addToBalanceTx` throw rolls the INSERT back too.
   *
   * Identical write to `create` (same `applyTenantGuard` → tenant/agent stamped
   * from ALS) but issued on the caller's in-tx handle. Mirrors the `*Tx`
   * convention used by `pendingQuestionsRepo.resolveTx` /
   * `procedureExecutionsRepo.updateStateTx`. The caller MUST already be inside
   * `withTx`.
   */
  async createTx(
    tx: typeof db,
    input: Omit<Transacao, 'id' | 'tenant_id' | 'agent_id' | 'created_at' | 'updated_at'>,
  ): Promise<Transacao> {
    const guarded = applyTenantGuard(input);
    const rows = await tx.insert(transacoes).values(guarded).returning();
    return rows[0]!;
  },
  async listRecent(limit = 50): Promise<Transacao[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(transacoes)
      .where(and(eq(transacoes.tenant_id, tenant_id), eq(transacoes.agent_id, agent_id)))
      .orderBy(desc(transacoes.created_at))
      .limit(limit);
  },
  /**
   * Issue #363 — tenant-scoped read of PENDING (unconfirmed) transações for a
   * set of entidades, for the `list_pending` LLM tool (whose result, incl.
   * `descricao`/`valor`, is injected back into the prompt context). `entidade_id`
   * is a GLOBAL uuid, so the tool's old inline `inArray(transacoes.entidade_id, …)`
   * did NOT scope by tenant — another tenant's pending transação for a
   * shared/guessed entidade would leak into the LLM context (R2 contamination).
   * Bind tenant+agent from ALS (both NOT NULL) so the read returns ONLY the
   * running tuple's rows. Same `status='pendente' AND confirmada_em IS NULL`
   * filter the tool used.
   */
  async listPendingForEntidades(entidades: string[], limit: number): Promise<Transacao[]> {
    if (entidades.length === 0) return [];
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(transacoes)
      .where(
        and(
          eq(transacoes.tenant_id, tenant_id),
          eq(transacoes.agent_id, agent_id),
          inArray(transacoes.entidade_id, entidades),
          eq(transacoes.status, 'pendente'),
          isNull(transacoes.confirmada_em),
        ),
      )
      .orderBy(desc(transacoes.data_competencia))
      .limit(limit);
  },
  async findRecentSimilar(params: {
    entidade_id: string;
    valor: string;
    descricao: string;
    registrado_por: string;
    sinceMs: number;
  }): Promise<Transacao[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const since = new Date(Date.now() - params.sinceMs);
    return db
      .select()
      .from(transacoes)
      .where(
        and(
          eq(transacoes.tenant_id, tenant_id),
          eq(transacoes.agent_id, agent_id),
          eq(transacoes.entidade_id, params.entidade_id),
          eq(transacoes.valor, params.valor),
          eq(transacoes.registrado_por, params.registrado_por),
          sql`created_at >= ${since.toISOString()}`,
        ),
      );
  },
  async byId(id: string): Promise<Transacao | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(transacoes)
      .where(
        and(
          eq(transacoes.tenant_id, tenant_id),
          eq(transacoes.agent_id, agent_id),
          eq(transacoes.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },
  async update(id: string, patch: Partial<Transacao>): Promise<void> {
    await updateTransacaoWith(db, id, patch);
  },
  /**
   * Issue #366 — TRANSACTIONAL variant of `update`. Same scoped + FAIL-LOUD
   * core (`updateTransacaoWith`) but on the passed `tx` handle, so the cancel
   * UPDATE commits/rolls back together with its audit row (`auditTx`) inside
   * one `withTx` (cancel-transaction). A failed audit insert aborts the cancel
   * — the transaction can never flip to 'cancelada' without its audit row.
   */
  async updateTx(tx: typeof db, id: string, patch: Partial<Transacao>): Promise<void> {
    await updateTransacaoWith(tx, id, patch);
  },
};

/**
 * Shared scoped + FAIL-LOUD core for `transacoesRepo.update` / `updateTx`. Kept
 * as ONE function so the tenant/agent predicate and the 0-row guard can never
 * drift between the pooled-`db` and the in-`tx` paths — mirroring the
 * `addToBalanceWith` precedent for the paired FINANCIAL balance write.
 *
 * Flip-readiness (#323, H3 of #355) — FINANCIAL mutation: tenant+agent scope
 * the WHERE (bound from ALS), mirroring the already-scoped `transacoesRepo.byId`
 * / `byScope`. Both columns are NOT NULL (schema `transacoes`). The sole live
 * caller (`tools/cancel-transaction.ts`) runs inside the agent turn's
 * `runWithTenantContext({tenant_id, agent_id})` (agent/core.ts) and patches the
 * exact `tx` it loaded via the ALREADY tenant+agent-scoped
 * `transacoesRepo.byId(transacao_id)`, after asserting `tx.entidade_id ===
 * args.entidade_id` AND `scope.entidades.includes(tx.entidade_id)` — so the row
 * provably belongs to the running (tenant_id, agent_id) and the predicate
 * matches it.
 *
 * FAIL-LOUD (throw on !=1): this stamps a single, known-present transaction's
 * lifecycle (the cancel path sets `status='cancelada'`). The id-only WHERE
 * always matched, so a 0-row result under the new predicate can ONLY be a
 * tenant/agent mismatch (cross-tenant misroute) — never a benign no-op. The
 * caller short-circuits the idempotent retry BEFORE reaching here (it returns
 * early when `tx.status==='cancelada'`), so there is no legitimate 0-row path:
 * a silent miss would report the cancel as succeeded while the transaction
 * stayed active (and, if a balance reversal is ever added, would desync the
 * ledger) — so surface it loudly. Same `.returning({id})` + `.length` idiom as
 * `mensagensRepo.markProcessed` / `pendingQuestionsRepo.resolve`.
 */
async function updateTransacaoWith(
  executor: typeof db,
  id: string,
  patch: Partial<Transacao>,
): Promise<void> {
  const tenant_id = getCurrentTenant();
  const agent_id = getCurrentAgent();
  const updated = await executor
    .update(transacoes)
    .set(patch)
    .where(
      and(
        eq(transacoes.id, id),
        eq(transacoes.tenant_id, tenant_id),
        eq(transacoes.agent_id, agent_id),
      ),
    )
    .returning({ id: transacoes.id });
  if (updated.length !== 1) {
    throw new Error(
      `transacoesRepo.update matched ${updated.length} rows for transacao ${id} ` +
        `under ${tenant_id}/${agent_id} — expected 1 (tenant/agent context does ` +
        `not match the target transaction; the update would have been silently ` +
        `lost while reported as applied)`,
    );
  }
}

export const categoriasRepo = {
  async list(scope?: EntityScope): Promise<Categoria[]> {
    if (!scope) return db.select().from(categorias);
    return db
      .select()
      .from(categorias)
      .where(
        sql`(${categorias.entidade_id} IS NULL OR ${inArray(categorias.entidade_id, scope.entidades)})`,
      );
  },
  async byId(id: string): Promise<Categoria | null> {
    const rows = await db.select().from(categorias).where(eq(categorias.id, id)).limit(1);
    return rows[0] ?? null;
  },
  async byIds(ids: string[]): Promise<Categoria[]> {
    if (ids.length === 0) return [];
    return db.select().from(categorias).where(inArray(categorias.id, ids));
  },
  async byNomeNatureza(nome: string, natureza: string): Promise<Categoria | null> {
    const rows = await db
      .select()
      .from(categorias)
      .where(and(eq(categorias.nome, nome), eq(categorias.natureza, natureza), isNull(categorias.entidade_id)))
      .limit(1);
    return rows[0] ?? null;
  },
};

export const contrapartesRepo = {
  async byScope(scope: EntityScope): Promise<Contraparte[]> {
    if (scope.entidades.length === 0) throw new EmptyScopeError();
    return db
      .select()
      .from(contrapartes)
      .where(inArray(contrapartes.entidade_id, scope.entidades));
  },
  async byId(id: string): Promise<Contraparte | null> {
    const rows = await db.select().from(contrapartes).where(eq(contrapartes.id, id)).limit(1);
    return rows[0] ?? null;
  },
  async create(input: Omit<Contraparte, 'id' | 'tenant_id' | 'agent_id' | 'created_at' | 'updated_at'>): Promise<Contraparte> {
    const guarded = applyTenantGuard(input);
    const rows = await db.insert(contrapartes).values(guarded).returning();
    return rows[0]!;
  },
};

export const factsRepo = {
  async getByKey(escopo: string, chave: string): Promise<AgentFact | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(agent_facts)
      .where(
        and(
          eq(agent_facts.tenant_id, tenant_id),
          eq(agent_facts.agent_id, agent_id),
          eq(agent_facts.escopo, escopo),
          eq(agent_facts.chave, chave),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },
  async upsert(input: {
    escopo: string;
    chave: string;
    valor: unknown;
    fonte: 'configurado' | 'aprendido' | 'inferido';
    confianca?: number;
  }): Promise<AgentFact> {
    const guarded = applyTenantGuard({
      escopo: input.escopo,
      chave: input.chave,
      valor: input.valor as object,
      fonte: input.fonte,
      confianca: String(input.confianca ?? 1),
    });
    const rows = await db
      .insert(agent_facts)
      .values(guarded)
      .onConflictDoUpdate({
        // PR #82 review (Codex): conflict target must match the
        // (tenant_id, agent_id, escopo, chave) unique introduced in
        // migration 018 — otherwise tenant B can overwrite tenant A's
        // fact by colliding on (escopo, chave).
        target: [
          agent_facts.tenant_id,
          agent_facts.agent_id,
          agent_facts.escopo,
          agent_facts.chave,
        ],
        set: {
          valor: input.valor as object,
          fonte: input.fonte,
          updated_at: new Date(),
        },
      })
      .returning();
    return rows[0]!;
  },
  async listForScopes(escopos: string[]): Promise<AgentFact[]> {
    if (escopos.length === 0) return [];
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    // P10a (review #104 critical): every read path that surfaces knowledge
    // to the LLM MUST filter by lifecycle_status. Without this, a
    // propose_fact row with lifecycle_status='pending_review' (or even
    // 'revoked') reaches the prompt because the legacy path filtered only
    // by tenant/agent/escopo. The 5 visible states mirror
    // visibility.VISIBLE_STATES.
    return db
      .select()
      .from(agent_facts)
      .where(
        and(
          eq(agent_facts.tenant_id, tenant_id),
          eq(agent_facts.agent_id, agent_id),
          inArray(agent_facts.escopo, escopos),
          inArray(agent_facts.lifecycle_status, [
            'ephemeral',
            'observed',
            'reinforced',
            'verified',
            'active',
          ]),
        ),
      );
  },
  /**
   * PR #82 review (Superpowers Critical #1): the legacy factsBlock in the
   * system prompt was rendering every agent_fact unfiltered, bypassing the
   * memory_entry sensitivity/mention_allowed model. This method returns
   * only facts whose content has either (a) no corresponding memory_entry
   * row yet (e.g. classifier hasn't run, or the fact predates P2) or
   * (b) has a memory_entry that is needs_review=false AND mention_allowed=
   * true. Sensitive/personal facts whose memory_entry says do-not-mention
   * are dropped from the prompt.
   *
   * The match is by literal `content` against two known shapes:
   *   1. P2-era persister: valor = { content, subject_id }, so the join
   *      is `me.content = af.valor->>'content'`.
   *   2. Legacy (pre-P2) facts: migration 017 seeded memory_entry with
   *      `content = CONCAT(af.chave, ': ', af.valor::text)`. If the fact's
   *      `valor` happened to already include a `content` key, shape (1)
   *      alone wouldn't catch it until the reclassifier worker rewrote
   *      that entry. We also match shape (2) so the sensitivity filter
   *      is correct during the reclassifier-backlog window.
   *
   * Facts predating P2 with NO memory_entry row at all are still shown —
   * a conservative default for migration-window legacy data, since the
   * 017 seed guarantees they get a needs_review=true entry the reclassifier
   * will eventually re-evaluate.
   */
  async listMentionableForScopes(escopos: string[]): Promise<AgentFact[]> {
    if (escopos.length === 0) return [];
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    // P10a (review #104 critical): lifecycle_status filter is mandatory
    // on every read that the LLM can see. pending_review / deprecated /
    // revoked rows MUST NOT reach the prompt — they live behind the
    // Admin UI Proposal Inbox until a human acts on them.
    //
    // escopos is wrapped in new Param(...) so it binds as one $n (a real PG
    // array). A bare interpolated JS array expands to a parenthesized scalar
    // list ($1, $2, ...), which PG rejects on the right of ANY (42809).
    const result = await db.execute<AgentFact>(sql`
      SELECT af.*
      FROM agent_facts af
      WHERE af.tenant_id = ${tenant_id}
        AND af.agent_id = ${agent_id}
        AND af.escopo = ANY(${new Param(escopos)})
        AND af.lifecycle_status IN ('ephemeral', 'observed', 'reinforced', 'verified', 'active')
        AND NOT EXISTS (
          SELECT 1 FROM memory_entry me
          WHERE me.tenant_id = af.tenant_id
            AND me.agent_id = af.agent_id
            AND (
              me.content = (af.valor->>'content')
              OR me.content = (af.chave || ': ' || af.valor::text)
            )
            AND (
              me.needs_review = true
              OR me.mention_allowed = false
            )
        )
    `);
    return Array.from(result.rows as unknown as AgentFact[]);
  },
};

export const rulesRepo = {
  async listActive(tipo: string): Promise<LearnedRule[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    // Codex round-2 finding 2: lifecycle_status is the source of truth
    // for "is this rule visible to the LLM". The legacy `ativa=true`
    // requirement was double-bookkeeping: KSM-proposed rules transitioned
    // through pending_review → … → active never flipped `ativa`, so
    // approved proposals stayed invisible forever. We drop the
    // `ativa=true` predicate here and rely on lifecycle_status alone.
    // (The `ativa` column is preserved for ops/admin "soft disable"
    // outside the lifecycle pipeline; if it gets set to false in the
    // DB, a follow-up migration can join it back.)
    return db
      .select()
      .from(learned_rules)
      .where(
        and(
          eq(learned_rules.tenant_id, tenant_id),
          eq(learned_rules.agent_id, agent_id),
          eq(learned_rules.tipo, tipo),
          inArray(learned_rules.lifecycle_status, [
            'ephemeral',
            'observed',
            'reinforced',
            'verified',
            'active',
          ]),
        ),
      )
      .orderBy(desc(learned_rules.confianca), desc(learned_rules.updated_at))
      .limit(50);
  },
  async create(
    input: Omit<
      LearnedRule,
      | 'id'
      | 'tenant_id'
      | 'agent_id'
      | 'created_at'
      | 'updated_at'
      // P10a: lifecycle columns have DB defaults — callers don't supply them.
      | 'lifecycle_status'
      | 'evidence_count'
      | 'lifecycle_transitions'
      | 'last_recall_at'
    >,
  ): Promise<LearnedRule> {
    const guarded = applyTenantGuard(input);
    const rows = await db.insert(learned_rules).values(guarded).returning();
    return rows[0]!;
  },
  async findByContext(tipo: string, contexto: string): Promise<LearnedRule | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    // Codex round-2 finding 2: same drop of legacy `ativa=true` here —
    // lifecycle_status is the source of truth for visibility (see
    // listActive comment above).
    const rows = await db
      .select()
      .from(learned_rules)
      .where(
        and(
          eq(learned_rules.tenant_id, tenant_id),
          eq(learned_rules.agent_id, agent_id),
          eq(learned_rules.tipo, tipo),
          eq(learned_rules.contexto, contexto),
          inArray(learned_rules.lifecycle_status, [
            'ephemeral',
            'observed',
            'reinforced',
            'verified',
            'active',
          ]),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },
  async byId(id: string): Promise<LearnedRule | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(learned_rules)
      .where(
        and(
          eq(learned_rules.tenant_id, tenant_id),
          eq(learned_rules.agent_id, agent_id),
          eq(learned_rules.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },
  // ---------------------------------------------------------------------------
  // INVARIANT — TENANT/AGENT-SCOPED MUTATIONS (issue #230, north star):
  //   "Maias de empresas diferentes NUNCA se comunicam, compartilham dados ou
  //    herdam aprendizado. Sem exceção."
  //
  //   The 3 mutators below (incrementAcerto / incrementErro / setStatus) accept
  //   a raw `rule_id`. BEFORE this fix the WHERE clause was `id = ?` only —
  //   any agent in any tenant could mutate ANY rule by knowing the id. That
  //   broke the inviolable cross-tenant isolation invariant for the procedural
  //   memory layer (reads via `listActive` / `findByContext` were already
  //   scoped, but writes leaked).
  //
  //   AFTER this fix every mutator pins `tenant_id = <ctx> AND agent_id = <ctx>`
  //   into the WHERE. A mutation against a foreign-tenant/agent rule matches
  //   0 rows on the UPDATE; we then throw a typed `rule_not_in_scope` error so
  //   callers see a LOUD failure instead of a silent no-op. The silent no-op
  //   was rejected because:
  //     1. The invariant is INVIOLABLE — masking a violation is worse than
  //        surfacing it; a thrown error is a louder signal than a swallowed
  //        write that the calling reflection/promotion logic still trusts.
  //     2. `recordAcerto` / `recordErro` (src/memory/procedural.ts) follow up
  //        with `byId(rule_id)` + `setStatus`. Under the OLD code a foreign
  //        id that somehow surfaced would silently chain to setStatus; throwing
  //        here guarantees the promotion/deactivation side-effects never fire
  //        on out-of-scope rows.
  //     3. Detectable from telemetry: a thrown `rule_not_in_scope` is grep-
  //        pable in logs; a silent no-op is not.
  //
  //   The status-conditioned UPDATE pattern (RETURNING + rows.length check) is
  //   the same one `skillsRepo.deprecate` / `.activate` use for lifecycle
  //   guards (PR #213 FIX 2). It is server-authoritative — no caller has to
  //   remember to pre-filter; the SQL itself enforces the boundary.
  // ---------------------------------------------------------------------------
  async incrementAcerto(id: string): Promise<void> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .update(learned_rules)
      .set({
        acertos: sql`acertos + 1`,
        confianca: sql`LEAST(1.00, confianca + 0.10)`,
        updated_at: new Date(),
      })
      .where(and(
        eq(learned_rules.id, id),
        eq(learned_rules.tenant_id, tenant_id),
        eq(learned_rules.agent_id, agent_id),
      ))
      .returning({ id: learned_rules.id });
    if (rows.length === 0) {
      // Loud failure — see INVARIANT block above. Either the id doesn't exist
      // OR it belongs to a different tenant/agent; both surface as the same
      // typed error so callers can't probe foreign-tenant existence.
      throw new TypedError('rule_not_in_scope', `rule ${id} not found in current tenant/agent scope`);
    }
  },
  async incrementErro(id: string): Promise<void> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .update(learned_rules)
      .set({
        erros: sql`erros + 1`,
        confianca: sql`GREATEST(0.00, confianca - 0.20)`,
        updated_at: new Date(),
      })
      .where(and(
        eq(learned_rules.id, id),
        eq(learned_rules.tenant_id, tenant_id),
        eq(learned_rules.agent_id, agent_id),
      ))
      .returning({ id: learned_rules.id });
    if (rows.length === 0) {
      // Loud failure — see INVARIANT block above.
      throw new TypedError('rule_not_in_scope', `rule ${id} not found in current tenant/agent scope`);
    }
  },
  async setStatus(
    id: string,
    update: { ativa?: boolean; confianca?: number },
  ): Promise<void> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const set: Record<string, unknown> = { updated_at: new Date() };
    if (update.ativa !== undefined) set.ativa = update.ativa;
    if (update.confianca !== undefined) set.confianca = String(update.confianca);
    const rows = await db
      .update(learned_rules)
      .set(set)
      .where(and(
        eq(learned_rules.id, id),
        eq(learned_rules.tenant_id, tenant_id),
        eq(learned_rules.agent_id, agent_id),
      ))
      .returning({ id: learned_rules.id });
    if (rows.length === 0) {
      // Loud failure — see INVARIANT block above.
      throw new TypedError('rule_not_in_scope', `rule ${id} not found in current tenant/agent scope`);
    }
  },
};

// `metadata` is `notNull()` in the schema (with `default '{}'::jsonb`) which
// makes it required on the inferred select type. Existing callers (e.g.
// src/identity/quarantine.ts) that predate the column don't pass metadata —
// the DB default is what they want. We strip metadata from the Omit and
// add it back as optional so those call sites keep typechecking.
type PendingQuestionInsert = Omit<
  PendingQuestion,
  'id' | 'tenant_id' | 'agent_id' | 'created_at' | 'resolvida_em' | 'resposta' | 'metadata'
> & { metadata?: object };

export const pendingQuestionsRepo = {
  async create(input: PendingQuestionInsert): Promise<PendingQuestion> {
    const guarded = applyTenantGuard(input);
    const rows = await db.insert(pending_questions).values(guarded).returning();
    return rows[0]!;
  },
  async findOpen(conversa_id: string): Promise<PendingQuestion | null> {
    const rows = await db
      .select()
      .from(pending_questions)
      .where(and(eq(pending_questions.conversa_id, conversa_id), eq(pending_questions.status, 'aberta')))
      .orderBy(desc(pending_questions.created_at))
      .limit(1);
    return rows[0] ?? null;
  },
  async findOpenByPessoaAndType(pessoa_id: string, tipo: string): Promise<PendingQuestion | null> {
    const rows = await db
      .select()
      .from(pending_questions)
      .where(
        and(
          eq(pending_questions.pessoa_id, pessoa_id),
          eq(pending_questions.tipo, tipo),
          eq(pending_questions.status, 'aberta'),
          sql`(${pending_questions.expira_em} IS NULL OR ${pending_questions.expira_em} > NOW())`,
        ),
      )
      .orderBy(desc(pending_questions.created_at))
      .limit(1);
    return rows[0] ?? null;
  },
  /**
   * Issue #363 — tenant-scoped read of OPEN pending questions for one pessoa,
   * for the `list_pending` LLM tool (whose result `q.pergunta` is injected back
   * into the prompt context). `pessoa_id` is a GLOBAL uuid, so filtering by it
   * alone (as the tool's old inline `db.select` did) does NOT scope by tenant —
   * another tenant's open question for a shared/guessed pessoa_id would leak
   * into the LLM context (R2 contamination, same class as #357). Bind tenant+agent
   * from ALS (both columns NOT NULL) so the read returns ONLY the running tuple's
   * rows. Read-only `list*` shape mirrors `transacoesRepo.listRecent`/`byScope`.
   */
  async listOpenForPessoa(pessoa_id: string, limit: number): Promise<PendingQuestion[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(pending_questions)
      .where(
        and(
          eq(pending_questions.tenant_id, tenant_id),
          eq(pending_questions.agent_id, agent_id),
          eq(pending_questions.pessoa_id, pessoa_id),
          eq(pending_questions.status, 'aberta'),
        ),
      )
      .orderBy(desc(pending_questions.created_at))
      .limit(limit);
  },
  async resolve(id: string, resposta: unknown): Promise<void> {
    // Flip-readiness (#323, H2 of #355): tenant+agent scope the WHERE (bound
    // from ALS), mirroring the already-hardened `expireDue` and
    // `conversasRepo.close`. Both columns are NOT NULL. The two live callers
    // (identity/quarantine.ts → `handleOwnerIdentityReply`) run inside
    // `runWithTenantContext({tenant_id, agent_id})` (the agent core wraps the
    // whole turn — agent/core.ts `runAgentForMensagem`), resolving the `open`
    // row via `findOpenByPessoaAndType(owner.id, …)` under the SAME pair — and
    // the owner pessoa + its pending_question were both created under that pair
    // (`create` → `applyTenantGuard`), so the predicate matches the exact row.
    // FAIL-LOUD (throw on !=1): this targets one specific, known-present row
    // (the open identity_confirmation just resolved under this tenant/agent) to
    // close out the owner's confirmation decision. The WHERE has NO status gate
    // (it overwrites by id regardless of current status), so the ONLY way to
    // match 0 rows under the new predicate is a tenant/agent mismatch — a real
    // cross-tenant misroute, not a benign idempotent retry. A silent 0-row
    // no-op would leave the confirmation `aberta` forever (the contact never
    // gets unblocked/blocked and the owner's reply is lost). Same
    // `.returning({id})` + `.length` idiom as `mensagensRepo.markProcessed`.
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const updated = await db
      .update(pending_questions)
      .set({
        status: 'respondida',
        resposta: resposta as object,
        resolvida_em: new Date(),
      })
      .where(
        and(
          eq(pending_questions.id, id),
          eq(pending_questions.tenant_id, tenant_id),
          eq(pending_questions.agent_id, agent_id),
        ),
      )
      .returning({ id: pending_questions.id });
    if (updated.length !== 1) {
      throw new Error(
        `pendingQuestionsRepo.resolve matched ${updated.length} rows for ` +
          `pending_question ${id} under ${tenant_id}/${agent_id} — expected 1 ` +
          `(tenant/agent context does not match the target row; the ` +
          `confirmation would have been left unresolved)`,
      );
    }
  },
  async expireDue(): Promise<number> {
    // Issue #345 (Phase 4 review): the `pending-expirer` worker now runs this
    // inner ONCE PER enumerated (tenant_id, agent_id) tuple
    // (`listTenantAgentPairsWithDueExpirations` selects DISTINCT (tenant_id,
    // agent_id)). Without an explicit tenant predicate the UPDATE would expire
    // EVERY tenant's due pending_questions on the first tuple's pass —
    // violating the inviolable cross-tenant isolation invariant. Bind the same
    // (tenant_id, agent_id) the enumeration partitions on, so a per-tuple run
    // only touches ITS OWN rows.
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .update(pending_questions)
      .set({ status: 'expirada' })
      .where(
        and(
          eq(pending_questions.tenant_id, tenant_id),
          eq(pending_questions.agent_id, agent_id),
          eq(pending_questions.status, 'aberta'),
          sql`expira_em < now()`,
        ),
      )
      .returning({ id: pending_questions.id });
    return rows.length;
  },

  /**
   * Issue #345 (Phase 4) — dispatcher enumeration for `pending-expirer`.
   *
   * The worker's inner does TWO things per tenant: expire due `pending_questions`
   * (`expireAll()` → `expireDue()`) AND expire due dual-approval `workflows`
   * (`expireDueDualApprovals()`). So the dispatcher must enumerate the UNION of
   * the (tenant_id, agent_id) tuples that have EITHER kind of due work:
   *
   *   - a `pending_questions` row with `status='aberta' AND expira_em < now()`
   *     (matches `expireDue`'s WHERE), OR
   *   - a `workflows` row with `tipo='dual_approval'`, in a still-open status,
   *     and `proxima_acao_em < now()` (matches `expireDueDualApprovals`'s
   *     filter, which iterates `workflowsRepo.listPending()` — the open-status
   *     set `pendente/em_andamento/aguardando_humano/aguardando_terceiro` — and
   *     keeps only past-due `dual_approval` rows).
   *
   * Including the dual-approval arm is LOAD-BEARING: a tenant whose ONLY due
   * work is an expired dual-approval (no due pending_question) must still be
   * enumerated, otherwise its timed-out approval would never be cancelled.
   * Same shape as the relayer's `listTenantsWithWork` two-arm union (#316).
   *
   * Runs OUTSIDE tenant context (it IS the dispatcher); no tenant guard
   * (cross-tenant iteration is the worker's contract). Belt-and-suspenders
   * NOT NULL predicate on both arms mirrors #251/#292.
   */
  async listTenantAgentPairsWithDueExpirations(): Promise<
    Array<{ tenant_id: string; agent_id: string }>
  > {
    const result = await db.execute<{ tenant_id: string; agent_id: string }>(sql`
      SELECT DISTINCT tenant_id, agent_id FROM ${pending_questions}
        WHERE tenant_id IS NOT NULL
          AND agent_id IS NOT NULL
          AND status = 'aberta'
          AND expira_em < now()
      UNION
      SELECT DISTINCT tenant_id, agent_id FROM ${workflows}
        WHERE tenant_id IS NOT NULL
          AND agent_id IS NOT NULL
          AND tipo = 'dual_approval'
          AND status IN ('pendente', 'em_andamento', 'aguardando_humano', 'aguardando_terceiro')
          AND proxima_acao_em IS NOT NULL
          AND proxima_acao_em < now()
    `);
    return Array.from(
      result.rows as unknown as Array<{ tenant_id: string; agent_id: string }>,
    );
  },

  /**
   * Issue #345 (Phase 4 of #323) — dispatcher enumeration for `pending-reminder`.
   *
   * Returns the DISTINCT (tenant_id, agent_id) tuples that own at least one
   * pending_question due for a reminder. The predicate mirrors EXACTLY the
   * reminder-eligibility filter in `runPendingReminderInner`'s SELECT
   * (`status='aberta' AND expira_em > now() AND tipo != 'edit_review' AND
   * created_at < now() - interval '1 hour' AND reminder_count < MAX AND
   * (last_reminder_at IS NULL OR last_reminder_at < now() - interval '1 hour')`)
   * so a tuple is enumerated iff the inner would find at least one row to remind.
   * `maxReminders` is the worker's `MAX_REMINDERS` constant, threaded through so
   * the cap stays in lockstep with the inner.
   *
   * NOTE: this enumeration scans only `pending_questions` (it does NOT join
   * `pessoas`/`mensagens`). The inner's JOIN to `mensagens` (for the quoted
   * outbound parent) is an additional eligibility gate the inner applies
   * per-row (a row whose outbound parent is missing is skipped+audited), so a
   * tuple can be enumerated yet send no reminder — a cheap no-op, never a
   * cross-tenant read (the inner SELECT is now tenant-scoped — see worker).
   *
   * Runs OUTSIDE tenant context (it IS the dispatcher); no tenant guard
   * (cross-tenant iteration is the worker's contract). Belt-and-suspenders
   * `tenant_id/agent_id IS NOT NULL` mirrors #251/#292. Before this fix the
   * worker ran the inner under a hardcoded `default/default` context, so only
   * the default agent's pending questions ever got reminders.
   */
  async listTenantAgentPairsWithRemindableQuestions(
    maxReminders: number,
  ): Promise<Array<{ tenant_id: string; agent_id: string }>> {
    const result = await db.execute<{ tenant_id: string; agent_id: string }>(sql`
      SELECT DISTINCT tenant_id, agent_id
      FROM ${pending_questions}
      WHERE tenant_id IS NOT NULL
        AND agent_id IS NOT NULL
        AND status = 'aberta'
        AND expira_em > now()
        AND tipo != 'edit_review'
        AND created_at < now() - interval '1 hour'
        AND COALESCE((metadata->>'reminder_count')::int, 0) < ${maxReminders}
        AND (
          metadata->>'last_reminder_at' IS NULL
          OR (metadata->>'last_reminder_at')::timestamptz < now() - interval '1 hour'
        )
    `);
    return Array.from(
      result.rows as unknown as Array<{ tenant_id: string; agent_id: string }>,
    );
  },

  // === B0 tx-aware additions ===

  async findActiveSnapshot(conversa_id: string): Promise<PendingQuestion | null> {
    const rows = await db
      .select()
      .from(pending_questions)
      .where(
        and(
          eq(pending_questions.conversa_id, conversa_id),
          eq(pending_questions.status, 'aberta'),
          sql`expira_em > now()`,
        ),
      )
      .orderBy(desc(pending_questions.created_at))
      .limit(1);
    return rows[0] ?? null;
  },

  async findActiveForUpdate(
    tx: typeof db,
    conversa_id: string,
  ): Promise<PendingQuestion | null> {
    const rows = await tx
      .select()
      .from(pending_questions)
      .where(
        and(
          eq(pending_questions.conversa_id, conversa_id),
          eq(pending_questions.status, 'aberta'),
          sql`expira_em > now()`,
        ),
      )
      .orderBy(desc(pending_questions.created_at))
      .limit(1)
      .for('update');
    return rows[0] ?? null;
  },

  async resolveTx(tx: typeof db, id: string, resposta: unknown): Promise<void> {
    // Flip-readiness (#323, H2 of #355): tenant+agent scope the WHERE (bound
    // from ALS), mirroring `expireDue`. Both columns are NOT NULL. The sole
    // live caller (agent/pending-resolver.ts → `resolveAndDispatch`) runs
    // inside `runWithTenantContext` (entered by the gate/one-tap ingress paths
    // — pending-gate.ts, one-tap.ts via baileys `runWithTenantContext`) and
    // calls this ONLY after `findActiveForUpdate(tx, conversa_id)` has
    // SELECT…FOR UPDATE-locked the row AND verified `locked.id === id` in the
    // SAME tx — so the targeted row is present, locked, and (post-flip) owned
    // by the running pair (it was created under that pair via `createTx` →
    // `applyTenantGuard`).
    // FAIL-LOUD (throw on !=1): the row was just locked FOR UPDATE in this tx,
    // so a 0-row UPDATE can only mean the tenant/agent predicate does not match
    // the locked row — a cross-tenant misroute, never a benign race (the lock
    // already serialized concurrent resolvers). A silent miss would commit the
    // dispatch side-effects (tool execution) while leaving the question
    // `aberta`, so the next inbound would re-resolve and double-dispatch. Same
    // `.returning({id})` + `.length` idiom as `mensagensRepo.markProcessed`.
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const updated = await tx
      .update(pending_questions)
      .set({
        status: 'respondida',
        resposta: resposta as object,
        resolvida_em: new Date(),
      })
      .where(
        and(
          eq(pending_questions.id, id),
          eq(pending_questions.tenant_id, tenant_id),
          eq(pending_questions.agent_id, agent_id),
        ),
      )
      .returning({ id: pending_questions.id });
    if (updated.length !== 1) {
      throw new Error(
        `pendingQuestionsRepo.resolveTx matched ${updated.length} rows for ` +
          `pending_question ${id} under ${tenant_id}/${agent_id} — expected 1 ` +
          `(tenant/agent context does not match the FOR-UPDATE-locked row; the ` +
          `dispatch would have committed while the question stayed open)`,
      );
    }
  },

  async cancelTx(tx: typeof db, id: string, reason: string): Promise<void> {
    // Flip-readiness (#323, H2 of #355): tenant+agent scope the WHERE (bound
    // from ALS, parameterized into the raw SQL exactly like the existing `${id}`
    // bind). Both columns are NOT NULL. The sole live caller
    // (agent/pending-gate.ts → `applyTx`, topic-change/cancellation arm) runs
    // inside `runWithTenantContext` (the gate ingress path) and calls this ONLY
    // after `findActiveForUpdate(tx, conversa_id)` has FOR UPDATE-locked the row
    // AND verified `locked.id === id` in the SAME tx — so the row is present,
    // locked, and (post-flip) owned by the running pair.
    // FAIL-LOUD (throw on !=1): the row was just locked FOR UPDATE in this tx, so
    // a 0-row UPDATE can only mean the tenant/agent predicate does not match the
    // locked row — a cross-tenant misroute, never a benign race. A silent miss
    // would leave the question `aberta` while the gate reports it cancelled,
    // stranding the user mid-flow.
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const res = await tx.execute<{ id: string }>(sql`
      UPDATE pending_questions
         SET status = 'cancelada',
             metadata = metadata || ${JSON.stringify({ cancel_reason: reason })}::jsonb
       WHERE id = ${id}
         AND tenant_id = ${tenant_id}
         AND agent_id = ${agent_id}
       RETURNING id::text
    `);
    if (res.rows.length !== 1) {
      throw new Error(
        `pendingQuestionsRepo.cancelTx matched ${res.rows.length} rows for ` +
          `pending_question ${id} under ${tenant_id}/${agent_id} — expected 1 ` +
          `(tenant/agent context does not match the FOR-UPDATE-locked row; the ` +
          `question would have stayed open despite a reported cancellation)`,
      );
    }
  },

  async cancelOpenForConversaTx(
    tx: typeof db,
    conversa_id: string,
    reason: string,
  ): Promise<{ cancelled_ids: string[] }> {
    // Flip-readiness (#323, H2 of #355): tenant+agent scope the WHERE (bound
    // from ALS, parameterized into the raw SQL like the existing `${conversa_id}`
    // bind). Both columns are NOT NULL. The two live callers
    // (agent/message-update.ts → `createEditReviewPending`; tools/
    // ask-pending-question.ts handler) both run inside `runWithTenantContext` —
    // the edit/revoke listener wraps `routeMessageUpdate` in the resolved
    // tenant context (baileys `messages.update`), and the tool handler runs
    // inside the agent turn / `resolveAndDispatch`, both tenant-scoped. So a
    // conversa shared by a foreign tenant can never have ITS open questions
    // cancelled by another tenant's edit/substitution.
    // PREDICATE-ONLY (NO row-count assertion): this is a BULK cancel that clears
    // ALL open questions on the conversa (0..N), and a 0-row outcome is the
    // documented common case (no question was open). Both callers branch on
    // `cancelled_ids.length > 0` and treat an empty result as a no-op, so an
    // exact-N throw would be wrong here — the tenant+agent predicate is the only
    // change.
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const result = await tx.execute<{ id: string }>(sql`
      UPDATE pending_questions
         SET status = 'cancelada',
             metadata = metadata || ${JSON.stringify({ cancel_reason: reason })}::jsonb
       WHERE conversa_id = ${conversa_id}
         AND tenant_id = ${tenant_id}
         AND agent_id = ${agent_id}
         AND status = 'aberta'
       RETURNING id::text
    `);
    return { cancelled_ids: result.rows.map((r) => (r as { id: string }).id) };
  },

  async createTx(
    tx: typeof db,
    input: PendingQuestionInsert,
  ): Promise<PendingQuestion> {
    // Insert inside the same tx as the cancel — required by the partial unique
    // index `(conversa_id) WHERE status='aberta'` from migration 004. Doing
    // the insert on the global pool would race with the in-flight cancel and
    // hit a duplicate-key error.
    const guarded = applyTenantGuard(input);
    const rows = await tx.insert(pending_questions).values(guarded).returning();
    return rows[0]!;
  },
};

/**
 * idempotencyRepo — tool idempotency cache (`idempotency_keys` table).
 *
 * TENANT/AGENT-ISOLATION (issue #261). The `idempotency_keys` table has
 * `tenant_id` + `agent_id` columns (migrations 009/012). Before #261 both
 * `lookup` and `store` ignored both columns — `lookup` filtered ONLY by
 * `key`, and `store` relied on column defaults (`'default'`). That allowed
 * two tenants invoking the same tool with the same params to collide in
 * the cache and leak each other's tool output.
 *
 * After #261:
 *   - `lookup` pins `tenant_id = <ctx> AND agent_id = <ctx> AND key = <key>`
 *     in the WHERE. Defense in depth on top of the hash-input change in
 *     `computeIdempotencyKey` (src/governance/idempotency.ts).
 *   - `store` writes through `applyTenantGuard`, which stamps the routed
 *     `tenant_id`/`agent_id` and throws on mismatch. `onConflictDoNothing`
 *     now targets the new composite PK `(tenant_id, agent_id, key)` per
 *     migration 063, so a same-key collision across tenants does NOT silent-
 *     swallow the second insert.
 *   - `cleanup` stays global on purpose: it's a maintenance sweep run by
 *     `workers/idempotency-cleanup.ts` and intentionally crosses tenants.
 *     It does NOT read or return tool output, so it cannot leak — it only
 *     prunes by `created_at`. The cleanup worker bootstraps with the system
 *     tenant context for audit; the SQL itself stays unscoped.
 */

/**
 * Reservation outcome from `idempotencyRepo.tryReserve` (issue #298).
 *
 * Discriminated by `was_inserted`:
 *   - `was_inserted=true`: this caller WON the reservation. They MUST run
 *     the handler and then call `markCompleted` (success) or
 *     `releaseReservation` (failure), ALWAYS passing back the
 *     `reservation_token` returned here. `state` will be 'in_progress' and
 *     `resultado` will be undefined.
 *   - `was_inserted=false`: someone else's row was already there. Inspect
 *     `state`:
 *       - 'completed': use `resultado` as the cached output (cache hit) —
 *         ONLY returned when the stored row's `payload_hash` MATCHES the
 *         caller's `input.payload_hash` (see 'collision' below).
 *       - 'in_progress': another worker is mid-execution. The caller MUST
 *         NOT execute the handler; it should poll for completion (see
 *         `waitForCompletion`).
 *       - 'failed': a prior attempt for this exact key terminally FAILED
 *         (issue #298 B3). The caller MUST NOT silently re-execute — the
 *         failed handler may have applied a partial side effect. The
 *         dispatcher surfaces a typed error so any retry is an explicit,
 *         higher-level decision.
 *       - 'collision' (issue #299): a SETTLED ('completed') row exists for
 *         this exact (tenant, agent, key) but its stored `payload_hash`
 *         DIFFERS from the caller's. That means the idempotency key collided
 *         for two distinct payloads (truncated hash, derivator regression,
 *         or stale cache after a schema change). Returning the stored
 *         `resultado` would hand back a result computed for a DIFFERENT
 *         payload — a silent wrong side effect. We FAIL CLOSED: the caller
 *         MUST NOT use `resultado` (it is undefined here) and MUST NOT
 *         re-execute under the colliding key (that would clobber the other
 *         payload's cached result). The dispatcher surfaces a typed error.
 *         The collision is logged + metered inside `tryReserve`.
 *
 * Fencing token (issue #298 B2): on a winning reservation, `reservation_token`
 * is a freshly minted UUID. The owner MUST present it to `markCompleted` /
 * `releaseReservation`; those calls only mutate the row when the token still
 * matches. A slow owner whose lease expired and was reclaimed by a new owner
 * holds a STALE token, so its late completion is a no-op and cannot clobber
 * the new owner — closing the double-execution window of the fixed-TTL
 * reclaim. `reservation_token` is `undefined` on the non-winning branches
 * (the caller has nothing to complete).
 */
export type ReservationResult =
  | {
      was_inserted: true;
      state: 'in_progress';
      resultado: undefined;
      reservation_token: string;
    }
  | {
      was_inserted: false;
      state: 'completed';
      resultado: unknown;
      reservation_token: undefined;
    }
  | {
      was_inserted: false;
      state: 'in_progress';
      resultado: undefined;
      reservation_token: undefined;
    }
  | {
      was_inserted: false;
      state: 'failed';
      resultado: undefined;
      reservation_token: undefined;
    }
  | {
      // #299: settled row's payload_hash differs from the caller's — key
      // collision. Fail closed; never expose the foreign `resultado`.
      was_inserted: false;
      state: 'collision';
      resultado: undefined;
      reservation_token: undefined;
    };

/**
 * #318 (migration-window fix): decide whether a stored vs. expected
 * `payload_hash` mismatch is a REAL key collision that must fail closed.
 *
 * Background. #318 changed the BYTES `computePayloadHash` emits (per-segment
 * `encodeURIComponent` before the `'|'` join) to defeat a delimiter-aliasing
 * collision. Idempotency rows written BEFORE this build deploys store an
 * OLD-format hash with NO version prefix. The #299/#301 revalidation compares
 * the freshly computed (new-format) hash against the stored value; against a
 * legacy row it would NEVER match, so a legit idempotent retry would be
 * mis-reported as a `collision` (fail-closed typed error) for the row's whole
 * remaining TTL — breaking real retries across the deploy window.
 *
 * Rule. `computePayloadHash` now tags its output with
 * `PAYLOAD_HASH_VERSION_PREFIX` (`v2:`), so:
 *   - STORED hash is versioned (`v2:`-prefixed) AND differs from the expected
 *     (also versioned) hash → REAL collision. Strict #299/#301 revalidation
 *     is preserved for all new-vs-new comparisons.
 *   - STORED hash is LEGACY (no `v2:` prefix) → NOT a collision. A legacy hash
 *     can't be revalidated against the new encoding; we fall back to pre-#318
 *     behavior (return the cached result / wait-resolve normally). Legacy rows
 *     expire shortly under the bucket-minute TTL + cleanup sweep, so the
 *     window is bounded and there is no double-execution risk.
 *
 * Equality is exact-string. The expected hash is always current-format (it
 * comes from `computePayloadHash`), so a versioned-stored == expected check is
 * a strict same-format comparison. Tenant isolation is unaffected: the caller
 * has already scoped the row by `(tenant_id, agent_id, key)` in its WHERE
 * clause; this predicate only inspects the hash strings.
 */
function isRealPayloadHashCollision(
  storedPayloadHash: string,
  expectedPayloadHash: string,
): boolean {
  // Legacy stored hash (pre-#318, no version prefix) → cannot revalidate →
  // never a collision (fall back to the pre-#318 hit/wait-resolve behavior).
  if (!isVersionedPayloadHash(storedPayloadHash)) return false;
  // Both current-format: strict #299/#301 revalidation.
  return storedPayloadHash !== expectedPayloadHash;
}

/**
 * #299: emit the structured warn + collision metric and return the typed
 * `collision` reservation result. Shared by both `tryReserve` 'completed'
 * branches (initial SELECT + post-reclaim recheck) so the observability and
 * fail-closed shape stay identical. Mirrors the same event name / metric the
 * legacy `lookup` path uses, so dashboards see one signal regardless of which
 * code path detected the collision.
 */
function reportPayloadHashCollision(
  input: { key: string; payload_hash: string },
  stored: { payload_hash: string },
): ReservationResult {
  logger.warn(
    {
      event: 'idempotency_key_collision_payload_mismatch',
      key: input.key,
      stored_payload_hash: stored.payload_hash,
      expected_payload_hash: input.payload_hash,
    },
    'idempotency.payload_hash_mismatch',
  );
  incCounter('maia_idempotency_payload_hash_collision_total');
  return {
    was_inserted: false,
    state: 'collision',
    resultado: undefined,
    reservation_token: undefined,
  };
}

export const idempotencyRepo = {
  /**
   * Legacy read-only lookup with payload-hash revalidation (#299), state
   * filtering (#298) and tenant/agent scoping (#261).
   *
   * Use `tryReserve` for the atomic dispatcher path; this helper exists for
   * backward compat with non-dispatch callers (tests, one-off inspections).
   * The dispatcher itself no longer calls `lookup` — but it carries the
   * SAME three-layer defense so any non-dispatch caller is protected too.
   *
   * Three-layer defense against a wrong-result cache hit:
   *
   * 1. Tenant/agent scope (#261). The WHERE pins `tenant_id = <ctx> AND
   *    agent_id = <ctx> AND key = <key>`. `getCurrentTenant`/`getCurrentAgent`
   *    throw `MissingTenantContextError` if no ALS context — we refuse a
   *    silent fall-through to the legacy `'default'` bucket. Defense in
   *    depth on top of the hash-input change in `computeIdempotencyKey`
   *    (src/governance/idempotency.ts).
   *
   * 2. State filtering (#298). We filter `state <> 'in_progress'` (rather
   *    than `state = 'completed'`) so that:
   *      - 'completed' → returns `resultado` (the cache hit).
   *      - 'in_progress' → EXCLUDED. An in-flight reservation has no result
   *        yet; surfacing it would make the caller skip execution and return
   *        undefined to the user (silent data loss).
   *      - 'failed' → carries a NULL `resultado`, so it yields a miss.
   *      - pre-#298 rows (written before the `state` column existed) are
   *        treated as settled and still hit, preserving the pre-existing
   *        same-scope idempotency contract.
   *
   * 3. Payload-hash revalidation (#299). The cache key is
   *    `computeIdempotencyKey(...)` — a fingerprint of the inputs PLUS a
   *    bucket-minutes timestamp. If two distinct requests in the same scope
   *    collide on that key (truncated hash, regression in the derivator that
   *    drops a discriminant field, or stale cached payload after a schema
   *    change), the older result would be returned for the NEW request and
   *    the side effect would be silently wrong.
   *
   *    `payload_hash` is an independent SHA256 over (pessoa, entity, tool,
   *    op, normalized_payload | file_sha256). On a hit we verify that the
   *    STORED row's hash matches the EXPECTED hash; on mismatch we treat as
   *    a miss, warn, and bump a metric so we can detect drift.
   *
   * Note on existing rows: rows stored before this fix have
   * `payload_hash == key` (legacy `store` from _dispatcher.ts). Those rows
   * fail revalidation against a real payload_hash and are treated as a miss.
   * Acceptable: the bucket-minute TTL + cleanup worker drain stale rows.
   */
  async lookup(input: { key: string; payload_hash: string }): Promise<unknown | null> {
    // Resolve tenant/agent — `getCurrentTenant`/`getCurrentAgent` throw
    // `MissingTenantContextError` if no context. We refuse a silent
    // fall-through to the legacy `'default'` bucket (see header #261).
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(idempotency_keys)
      .where(
        and(
          eq(idempotency_keys.tenant_id, tenant_id),
          eq(idempotency_keys.agent_id, agent_id),
          eq(idempotency_keys.key, input.key),
          // #298: never surface an in-flight reservation as a cache hit.
          ne(idempotency_keys.state, 'in_progress'),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    // #318: only a CURRENT-format (v2:-prefixed) stored hash that differs is a
    // real collision. A legacy (pre-#318, unprefixed) stored hash can't be
    // revalidated against the new encoding → treat as a hit (pre-#318
    // behavior); it expires shortly under the bucket-minute TTL.
    if (isRealPayloadHashCollision(row.payload_hash, input.payload_hash)) {
      // #299: collision detected within tenant scope. Log + metric so we
      // can detect drift. Treat as miss so caller re-executes.
      logger.warn(
        {
          event: 'idempotency_key_collision_payload_mismatch',
          key: input.key,
          stored_payload_hash: row.payload_hash,
          expected_payload_hash: input.payload_hash,
          stored_tool_name: row.tool_name,
        },
        'idempotency.payload_hash_mismatch',
      );
      incCounter('maia_idempotency_payload_hash_collision_total');
      return null;
    }
    return row.resultado;
  },

  /**
   * Issue #298: atomic reservation. Replaces the racey check-then-act in
   * the dispatcher.
   *
   * Single round-trip:
   *   - INSERT a new row with state='in_progress', expires_at=now()+TTL,
   *     resultado=NULL.
   *   - ON CONFLICT (PK = `(tenant_id, agent_id, key)`) DO NOTHING. If a row already exists,
   *     INSERT is a no-op; otherwise the row is created.
   *   - RETURNING (xmax = 0) AS was_inserted, state, resultado. The xmax
   *     trick: on a fresh insert, xmax=0; on a no-op caused by
   *     ON CONFLICT DO NOTHING, xmax is the *current* transaction's xid
   *     (non-zero). So `xmax = 0` is the canonical "I inserted vs row was
   *     already there" probe.
   *
   * Stale-reservation reclaim: if an existing row is state='in_progress'
   * AND expires_at < now(), it's an orphan (the previous worker crashed
   * before completing). The reclaim path runs an UPDATE … WHERE
   * state='in_progress' AND expires_at < now() — at most one caller wins
   * the update (UPDATE … RETURNING is atomic). Winner re-acquires the
   * reservation; losers see the winner's freshened row on next poll.
   *
   * The repository writes through `applyTenantGuard` (defense in depth:
   * even before PR #273's composite PK lands, the tenant_id/agent_id
   * columns are stamped from ALS context, so cross-tenant collisions are
   * prevented at the application layer).
   */
  async tryReserve(input: {
    key: string;
    tool_name: string;
    operation_type: string;
    pessoa_id: string;
    entity_id: string;
    payload_hash: string;
    file_sha256?: string;
    ttl_seconds: number;
  }): Promise<ReservationResult> {
    // applyTenantGuard stamps tenant_id/agent_id from ALS context and
    // rejects any explicit mismatch. Throws MissingTenantContextError if
    // no context. The atomic-reservation path is dispatcher-driven and
    // always runs inside runWithTenantContext (webhook routes, scheduler).
    const guarded = applyTenantGuard({
      key: input.key,
      tool_name: input.tool_name,
      operation_type: input.operation_type,
      pessoa_id: input.pessoa_id,
      entity_id: input.entity_id,
      payload_hash: input.payload_hash,
      file_sha256: input.file_sha256 ?? null,
      state: 'in_progress' as const,
    });

    // Step 1: try INSERT … ON CONFLICT DO NOTHING. RETURNING captures
    // both the "I inserted" probe and the existing-row state in the same
    // round-trip — no separate SELECT needed in the common path.
    // NOTE: `(xmax = 0)` is the Postgres ON CONFLICT DO NOTHING idiom for
    // distinguishing inserted vs pre-existing rows. With RETURNING, the
    // row body returned is the inserted-or-existing row in either case.
    //
    // Fencing token (B2): `gen_random_uuid()::text` mints a per-reservation
    // token server-side, atomic with the INSERT. The winner gets it back in
    // RETURNING and must echo it on markCompleted/releaseReservation; a
    // preempted owner's stale token can never match the row after a reclaim.
    const ttl = `${input.ttl_seconds} seconds`;
    const inserted = await db.execute<{
      was_inserted: boolean;
      state: string;
      resultado: unknown;
      expires_at: string | null;
      reservation_token: string | null;
    }>(sql`
      INSERT INTO idempotency_keys
        (key, tenant_id, agent_id, tool_name, operation_type, pessoa_id,
         entity_id, payload_hash, file_sha256, resultado, state, expires_at,
         reservation_token)
      VALUES
        (${guarded.key}, ${guarded.tenant_id}, ${guarded.agent_id},
         ${guarded.tool_name}, ${guarded.operation_type}, ${guarded.pessoa_id},
         ${guarded.entity_id}, ${guarded.payload_hash}, ${guarded.file_sha256},
         NULL, 'in_progress', now() + ${ttl}::interval, gen_random_uuid()::text)
      ON CONFLICT (tenant_id, agent_id, key) DO NOTHING
      RETURNING (xmax = 0) AS was_inserted, state, resultado, expires_at,
                reservation_token
    `);

    const firstRow = inserted.rows[0];
    if (firstRow && firstRow.was_inserted) {
      return {
        was_inserted: true,
        state: 'in_progress',
        resultado: undefined,
        reservation_token: firstRow.reservation_token ?? '',
      };
    }

    // Step 2: ON CONFLICT triggered (or RETURNING returned the
    // existing-but-not-inserted row). SELECT the row to inspect state.
    // We tenant-scope the read; if PR #273 merges (composite PK), this
    // also matches the new PK shape.
    const existingRows = await db
      .select({
        state: idempotency_keys.state,
        resultado: idempotency_keys.resultado,
        expires_at: idempotency_keys.expires_at,
        // #299: needed to revalidate the cached payload on a 'completed' hit.
        payload_hash: idempotency_keys.payload_hash,
      })
      .from(idempotency_keys)
      .where(
        and(
          eq(idempotency_keys.tenant_id, guarded.tenant_id),
          eq(idempotency_keys.agent_id, guarded.agent_id),
          eq(idempotency_keys.key, input.key),
        ),
      )
      .limit(1);

    const existing = existingRows[0];
    if (!existing) {
      // Extremely narrow race: row was deleted between ON CONFLICT and
      // SELECT (cleanup worker or down-migration). Treat as "couldn't
      // reserve" — caller re-enters. We retry the insert once to recover
      // cleanly without bubbling up a misleading error.
      const retry = await db.execute<{
        was_inserted: boolean;
        reservation_token: string | null;
      }>(sql`
        INSERT INTO idempotency_keys
          (key, tenant_id, agent_id, tool_name, operation_type, pessoa_id,
           entity_id, payload_hash, file_sha256, resultado, state, expires_at,
           reservation_token)
        VALUES
          (${guarded.key}, ${guarded.tenant_id}, ${guarded.agent_id},
           ${guarded.tool_name}, ${guarded.operation_type}, ${guarded.pessoa_id},
           ${guarded.entity_id}, ${guarded.payload_hash}, ${guarded.file_sha256},
           NULL, 'in_progress', now() + ${ttl}::interval, gen_random_uuid()::text)
        ON CONFLICT (tenant_id, agent_id, key) DO NOTHING
        RETURNING (xmax = 0) AS was_inserted, reservation_token
      `);
      if (retry.rows[0]?.was_inserted) {
        return {
          was_inserted: true,
          state: 'in_progress',
          resultado: undefined,
          reservation_token: retry.rows[0].reservation_token ?? '',
        };
      }
      // Still lost — fall through to a "stale" view; caller will poll and
      // either find a completed row or time out.
      return {
        was_inserted: false,
        state: 'in_progress',
        resultado: undefined,
        reservation_token: undefined,
      };
    }

    if (existing.state === 'completed') {
      // #299: revalidate the cached payload before returning it as a hit.
      // A 'completed' row whose stored payload_hash differs from ours is a
      // key collision (two distinct payloads mapped to the same key). Fail
      // closed — never expose the foreign result.
      // #318: only enforce this when the STORED hash is current-format
      // (v2:-prefixed). A legacy (pre-#318) stored hash can't be revalidated
      // against the new encoding, so a mismatch there is NOT a collision —
      // return the cached result (pre-#318 behavior); the row expires shortly.
      if (isRealPayloadHashCollision(existing.payload_hash, input.payload_hash)) {
        return reportPayloadHashCollision(input, existing);
      }
      return {
        was_inserted: false,
        state: 'completed',
        resultado: existing.resultado,
        reservation_token: undefined,
      };
    }

    if (existing.state === 'failed') {
      // Terminal failure (B3). A prior attempt for this exact key failed;
      // its handler may have applied a partial side effect. We do NOT
      // reclaim or re-run here — the caller (dispatcher) surfaces a typed
      // error so any retry is an explicit, higher-level decision. The
      // failed row is pruned later by `cleanup`.
      return {
        was_inserted: false,
        state: 'failed',
        resultado: undefined,
        reservation_token: undefined,
      };
    }

    // state='in_progress'. Check if expired — if so, try to reclaim.
    // Atomic UPDATE … WHERE state='in_progress' AND expires_at < now()
    // ensures at most one caller wins the reclaim. The reclaim MINTS A
    // FRESH reservation_token (B2): the previous (crashed or preempted)
    // owner still holds the OLD token, so its late markCompleted/
    // releaseReservation — gated on `reservation_token` — becomes a no-op
    // and cannot resurrect or clobber the row the reclaimer now owns.
    if (existing.expires_at && new Date(existing.expires_at) < new Date()) {
      const reclaimed = await db.execute<{ reservation_token: string | null }>(sql`
        UPDATE idempotency_keys
           SET expires_at = now() + ${ttl}::interval,
               reservation_token = gen_random_uuid()::text,
               tool_name = ${guarded.tool_name},
               operation_type = ${guarded.operation_type},
               pessoa_id = ${guarded.pessoa_id},
               entity_id = ${guarded.entity_id},
               payload_hash = ${guarded.payload_hash},
               file_sha256 = ${guarded.file_sha256}
         WHERE tenant_id = ${guarded.tenant_id}
           AND agent_id = ${guarded.agent_id}
           AND key = ${input.key}
           AND state = 'in_progress'
           AND expires_at < now()
         RETURNING reservation_token
      `);
      if (reclaimed.rows.length > 0) {
        return {
          was_inserted: true,
          state: 'in_progress',
          resultado: undefined,
          reservation_token: reclaimed.rows[0]!.reservation_token ?? '',
        };
      }
      // Reclaim lost (someone else got it, or row transitioned to
      // completed/failed). Re-check current state.
      const recheck = await db
        .select({
          state: idempotency_keys.state,
          resultado: idempotency_keys.resultado,
          // #299: revalidate the cached payload on a 'completed' recheck.
          payload_hash: idempotency_keys.payload_hash,
        })
        .from(idempotency_keys)
        .where(
          and(
            eq(idempotency_keys.tenant_id, guarded.tenant_id),
            eq(idempotency_keys.agent_id, guarded.agent_id),
            eq(idempotency_keys.key, input.key),
          ),
        )
        .limit(1);
      const recheckRow = recheck[0];
      if (recheckRow?.state === 'completed') {
        // #299: same collision guard as the first 'completed' branch.
        // #318: legacy-aware — only a current-format (v2:) stored hash that
        // differs is a real collision; a legacy stored hash is treated as a
        // hit (pre-#318 behavior).
        if (isRealPayloadHashCollision(recheckRow.payload_hash, input.payload_hash)) {
          return reportPayloadHashCollision(input, recheckRow);
        }
        return {
          was_inserted: false,
          state: 'completed',
          resultado: recheckRow.resultado,
          reservation_token: undefined,
        };
      }
      if (recheckRow?.state === 'failed') {
        return {
          was_inserted: false,
          state: 'failed',
          resultado: undefined,
          reservation_token: undefined,
        };
      }
      return {
        was_inserted: false,
        state: 'in_progress',
        resultado: undefined,
        reservation_token: undefined,
      };
    }

    return {
      was_inserted: false,
      state: 'in_progress',
      resultado: undefined,
      reservation_token: undefined,
    };
  },

  /**
   * Transition an in_progress reservation to completed and persist the
   * handler's result. Idempotent on the (tenant, agent, key) — if the
   * row is already 'completed' (e.g., a duplicate completion attempt),
   * we keep the existing resultado (the WHERE state='in_progress' makes
   * it a no-op).
   *
   * Fencing (B2): `reservation_token` MUST be the token returned by the
   * winning `tryReserve` for THIS reservation. The UPDATE is gated on
   * `reservation_token = <token>`, so an owner whose lease expired and was
   * reclaimed (the reclaim minted a NEW token) can no longer complete: its
   * stale token doesn't match, the UPDATE touches 0 rows, and the new
   * owner's reservation is preserved. Returns whether the row was actually
   * transitioned (true) or the completion was fenced out / already settled
   * (false) so the caller can detect a preemption.
   */
  async markCompleted(input: {
    key: string;
    resultado: unknown;
    reservation_token: string;
  }): Promise<boolean> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const updated = await db
      .update(idempotency_keys)
      .set({
        resultado: input.resultado as object,
        state: 'completed',
        expires_at: null,
      })
      .where(
        and(
          eq(idempotency_keys.tenant_id, tenant_id),
          eq(idempotency_keys.agent_id, agent_id),
          eq(idempotency_keys.key, input.key),
          eq(idempotency_keys.state, 'in_progress'),
          eq(idempotency_keys.reservation_token, input.reservation_token),
        ),
      )
      .returning({ key: idempotency_keys.key });
    return updated.length > 0;
  },

  /**
   * Mark a reservation as terminally FAILED (issue #298 B3).
   *
   * Previously this DELETEd the in_progress row so the next caller could
   * re-claim with a fresh INSERT. That let the SAME idempotency key be
   * silently re-executed after a failure — dangerous when the failed
   * handler already applied a partial side effect (the caller would see a
   * cache MISS and run the handler again). We now transition
   * in_progress→'failed', a TERMINAL state: a subsequent same-key
   * `tryReserve` reports the failure to the caller instead of re-running.
   * The coherence CHECK requires (failed ⇒ resultado IS NULL AND
   * expires_at IS NULL), so we clear expires_at in the same UPDATE — this
   * also removes the row from the in_progress reaper's partial index; the
   * row is pruned later by the aged-failed sweep in `cleanup`.
   *
   * Fencing (B2): gated on `reservation_token`. A preempted owner (whose
   * lease expired and was reclaimed) holds a STALE token, so its release
   * is a no-op (0 rows) and cannot mark the NEW owner's live reservation
   * as failed. Returns whether the row was actually transitioned.
   */
  async releaseReservation(input: {
    key: string;
    reservation_token: string;
  }): Promise<boolean> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const updated = await db
      .update(idempotency_keys)
      .set({
        state: 'failed',
        expires_at: null,
      })
      .where(
        and(
          eq(idempotency_keys.tenant_id, tenant_id),
          eq(idempotency_keys.agent_id, agent_id),
          eq(idempotency_keys.key, input.key),
          eq(idempotency_keys.state, 'in_progress'),
          eq(idempotency_keys.reservation_token, input.reservation_token),
        ),
      )
      .returning({ key: idempotency_keys.key });
    return updated.length > 0;
  },

  /**
   * Poll for a competing worker's reservation to settle. Used by the
   * dispatcher when `tryReserve` returns `was_inserted=false,
   * state='in_progress'` — another worker owns the reservation and we
   * want to return ITS result (not double-execute the side effect).
   *
   * Terminal outcomes:
   *   - 'completed' → the owner finished; return the cached `resultado`.
   *   - 'collision' (issue #299) → the owner's settled row carries a
   *     payload_hash that DIFFERS from `expected_payload_hash`. The owner
   *     reserved a colliding payload (same key, different inputs); adopting
   *     its result would leak the wrong side effect across the collision.
   *     Only emitted when `expected_payload_hash` is supplied. The caller
   *     MUST NOT use the result; the dispatcher surfaces a typed error.
   *   - 'failed' → the owner terminally failed (issue #298 B3:
   *     releaseReservation now marks the row 'failed' rather than deleting
   *     it). The caller MUST NOT re-execute; the dispatcher surfaces a
   *     typed error so any retry is a higher-level decision.
   *   - 'released' → the row vanished entirely (narrow race: the cleanup
   *     worker reaped it, or a down-migration ran). Treated like a failure
   *     from the caller's perspective — re-dispatch from scratch.
   *   - 'timeout' → the deadline elapsed with the owner still in_progress.
   *
   * `expected_payload_hash` is OPTIONAL for backward compat with non-dispatch
   * callers (and pre-#299 tests) that poll a key without a payload to verify.
   * When omitted, the completed result is returned without revalidation.
   *
   * Polling starts at 100ms and backs off exponentially (capped at 500ms)
   * so the loser of the race pays low latency on a fast handler while not
   * hammering the DB on a slow one. The deadline + sleep shape avoids both
   * wall-clock drift and a busy-wait if `setTimeout` resolves early.
   */
  async waitForCompletion(
    key: string,
    timeout_ms: number,
    expected_payload_hash?: string,
  ): Promise<
    | { status: 'completed'; resultado: unknown }
    | { status: 'collision' }
    | { status: 'timeout' }
    | { status: 'released' }
    | { status: 'failed' }
  > {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const deadline = Date.now() + timeout_ms;
    const INITIAL_POLL_MS = 100;
    const MAX_POLL_MS = 500;
    let pollIntervalMs = INITIAL_POLL_MS;
    while (Date.now() < deadline) {
      const rows = await db
        .select({
          state: idempotency_keys.state,
          resultado: idempotency_keys.resultado,
          // #299: needed to revalidate the owner's payload on completion.
          payload_hash: idempotency_keys.payload_hash,
        })
        .from(idempotency_keys)
        .where(
          and(
            eq(idempotency_keys.tenant_id, tenant_id),
            eq(idempotency_keys.agent_id, agent_id),
            eq(idempotency_keys.key, key),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) {
        // Row vanished entirely (cleanup reap / down-migration) — caller
        // should re-dispatch from scratch.
        return { status: 'released' };
      }
      if (row.state === 'completed') {
        // #299: revalidate the owner's payload_hash before adopting their
        // result. A mismatch is a key collision — fail closed.
        // #318: legacy-aware — only a current-format (v2:-prefixed) stored
        // hash that differs is a real collision. A legacy (pre-#318) stored
        // hash can't be revalidated against the new encoding, so the waiter
        // adopts the owner's result (pre-#318 behavior); the row expires
        // shortly. (`expected_payload_hash` may be omitted by non-dispatch
        // callers — then we skip revalidation entirely, unchanged from #299.)
        if (
          expected_payload_hash !== undefined &&
          isRealPayloadHashCollision(row.payload_hash, expected_payload_hash)
        ) {
          reportPayloadHashCollision(
            { key, payload_hash: expected_payload_hash },
            row,
          );
          return { status: 'collision' };
        }
        return { status: 'completed', resultado: row.resultado };
      }
      if (row.state === 'failed') {
        // Terminal failure (B3). Stop polling immediately — the result
        // will never arrive, and we must not re-run the handler.
        return { status: 'failed' };
      }
      // Still in progress; wait and retry with capped exponential backoff.
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      pollIntervalMs = Math.min(pollIntervalMs * 2, MAX_POLL_MS);
    }
    return { status: 'timeout' };
  },

  /**
   * Legacy write path. PRESERVED for backward compat with tests / call
   * sites that haven't migrated to the tryReserve/markCompleted flow.
   * Inserts a 'completed' row directly (matches the pre-#298 semantics:
   * the row exists only after the handler returned, so it's correctly
   * classified as completed).
   *
   * New code should use tryReserve + markCompleted instead — see
   * src/tools/_dispatcher.ts for the canonical pattern.
   */
  async store(input: {
    key: string;
    tool_name: string;
    operation_type: string;
    pessoa_id: string;
    entity_id: string;
    payload_hash: string;
    file_sha256?: string;
    resultado: unknown;
  }): Promise<void> {
    // applyTenantGuard stamps tenant_id/agent_id from ALS context and rejects
    // any explicit mismatch in the input. Also throws if no context.
    const guarded = applyTenantGuard({
      key: input.key,
      tool_name: input.tool_name,
      operation_type: input.operation_type,
      pessoa_id: input.pessoa_id,
      entity_id: input.entity_id,
      payload_hash: input.payload_hash,
      file_sha256: input.file_sha256 ?? null,
      resultado: input.resultado as object,
      state: 'completed' as const,
      expires_at: null,
    });
    await db.insert(idempotency_keys).values(guarded).onConflictDoNothing();
  },
  async cleanup(olderThanDays: number): Promise<number> {
    // Three-phase sweep:
    //   (1) Reap stale in_progress reservations (crashed workers) so they
    //       don't block re-claim forever. The partial index from
    //       migration 064 (`idx_idempotency_keys_in_progress_expires`)
    //       makes this O(stale rows) regardless of total table size.
    //       Deleting an orphaned in_progress row is safe: a crashed owner
    //       left no result, and the next dispatch re-INSERTs a fresh
    //       reservation. (The fencing token in #298 B2 protects the
    //       OTHER case — a slow-but-alive owner whose lease was reclaimed
    //       via UPDATE — so its late completion can't clobber the row.)
    //   (2) Age out long-completed rows past the cache retention window.
    //   (3) Age out terminal 'failed' rows (issue #298 B3) on the same
    //       retention window — they exist only to suppress silent
    //       re-execution; once well past the window the side effect (if
    //       any) is no longer a re-run risk. The partial index
    //       `idx_idempotency_keys_failed_created` (migration 065) keeps
    //       this O(aged-failed rows).
    // All global on purpose: cleanup is a maintenance sweep, not a
    // tenant-scoped read; it cannot leak (no row body returned).
    const reaped = await db
      .delete(idempotency_keys)
      .where(
        and(
          eq(idempotency_keys.state, 'in_progress'),
          sql`expires_at < now()`,
        ),
      )
      .returning({ key: idempotency_keys.key });
    const aged = await db
      .delete(idempotency_keys)
      .where(
        and(
          eq(idempotency_keys.state, 'completed'),
          sql`created_at < now() - (${olderThanDays} || ' days')::interval`,
        ),
      )
      .returning({ key: idempotency_keys.key });
    const agedFailed = await db
      .delete(idempotency_keys)
      .where(
        and(
          eq(idempotency_keys.state, 'failed'),
          sql`created_at < now() - (${olderThanDays} || ' days')::interval`,
        ),
      )
      .returning({ key: idempotency_keys.key });
    return reaped.length + aged.length + agedFailed.length;
  },
};

/**
 * Issue #316 — transactional effect outbox repository
 * (`idempotency_effect_outbox` table, migrations 068/069).
 *
 * The crux of exactly-once for NON-IDEMPOTENT external effects: the WINNING
 * idempotency reservation's completion and the enqueue of its intended effect
 * happen in ONE transaction (`markCompletedWithEffect`). The effect is thus
 * bound to whichever worker WON the reservation — not to a racer. The tool
 * handler never fires the effect inline (it only PLANS it), so a slow/preempted
 * owner whose lease was reclaimed and whose `markCompleted` is fenced out never
 * enqueues an effect (the UPDATE touches 0 rows → the whole tx no-ops the
 * INSERT too). A single relayer (src/workers/idempotency-outbox-relayer.ts)
 * dispatches each committed pending row EXACTLY ONCE with retry/backoff.
 *
 * TENANT ISOLATION (inviolable): every method scopes by the ALS-resolved
 * (tenant_id, agent_id) and writes through `applyTenantGuard`. The relayer is a
 * per-tenant dispatcher (mirrors reflection-batch #240/#251 +
 * outbound-messages-sweeper #292) and never assumes the 'default' sentinel.
 */
export type IdempotencyEffectOutboxRow = typeof idempotency_effect_outbox.$inferSelect;
export type OutboxEffectStatus = 'pending' | 'sent' | 'failed';

/**
 * A pending row claimed by the relayer for dispatch.
 *
 * #327 — `tenant_id` + `agent_id` are selected onto the row (not just used in
 * the WHERE clause) so the relayer can build the provider-side dedup identity
 * from PERSISTED row fields. The dedup key MUST be byte-identical across a
 * re-dispatch (including a crash-recovered one); deriving tenant/agent from the
 * ambient ALS context instead of the row would let a context mismatch produce a
 * DIFFERENT key → the transport wouldn't dedup. The key depends only on the row.
 */
export type ClaimedOutboxEffect = {
  id: string;
  tenant_id: string;
  agent_id: string;
  idempotency_key: string;
  effect_type: string;
  effect_payload: unknown;
  attempts: number;
  max_attempts: number;
};

export const idempotencyOutboxRepo = {
  /**
   * ATOMIC write side. Transition the in_progress reservation → completed AND
   * enqueue the intended external effect in ONE transaction.
   *
   * Both writes are fenced by `reservation_token` (the markCompleted UPDATE is
   * gated on it). If the owner was preempted (lease reclaimed → fresh token),
   * the UPDATE matches 0 rows: we DETECT that inside the tx and ROLL BACK, so
   * the effect is NOT enqueued under a reservation this worker no longer owns.
   * Returns whether the row was transitioned (true) or fenced out (false) —
   * same contract as `idempotencyRepo.markCompleted`, so the dispatcher's
   * `idempotency_completion_fenced` branch is unchanged.
   *
   * The outbox INSERT is ON CONFLICT (tenant, agent, idempotency_key) DO
   * NOTHING: if a previous (committed) completion already enqueued the effect,
   * a re-entry is a no-op — never a second physical effect. Combined with the
   * fencing UPDATE, the (completion, enqueue) pair is exactly-once.
   */
  async markCompletedWithEffect(input: {
    key: string;
    resultado: unknown;
    reservation_token: string;
    effect: PlannedEffect;
    max_attempts?: number;
  }): Promise<boolean> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const maxAttempts = input.max_attempts ?? 5;
    return withTx(async (tx) => {
      // Fence first: only the current reservation owner (matching token) may
      // complete. A preempted owner's stale token matches 0 rows.
      const completed = await tx
        .update(idempotency_keys)
        .set({
          resultado: input.resultado as object,
          state: 'completed',
          expires_at: null,
        })
        .where(
          and(
            eq(idempotency_keys.tenant_id, tenant_id),
            eq(idempotency_keys.agent_id, agent_id),
            eq(idempotency_keys.key, input.key),
            eq(idempotency_keys.state, 'in_progress'),
            eq(idempotency_keys.reservation_token, input.reservation_token),
          ),
        )
        .returning({ key: idempotency_keys.key });
      if (completed.length === 0) {
        // Fenced out / already settled. Roll back: do NOT enqueue an effect
        // for a reservation we no longer own. Throwing aborts the tx; we
        // translate it back to the boolean contract below.
        throw new OutboxFenced();
      }
      // Enqueue the intended effect, atomic with the completion. ON CONFLICT
      // DO NOTHING on (tenant, agent, key) makes a duplicate completion a
      // no-op (never a second physical effect).
      await tx
        .insert(idempotency_effect_outbox)
        .values(
          applyTenantGuard({
            idempotency_key: input.key,
            effect_type: input.effect.kind,
            effect_payload: input.effect as object,
            status: 'pending' as const,
            attempts: 0,
            max_attempts: maxAttempts,
          }),
        )
        .onConflictDoNothing({
          target: [
            idempotency_effect_outbox.tenant_id,
            idempotency_effect_outbox.agent_id,
            idempotency_effect_outbox.idempotency_key,
          ],
        });
      return true;
    }).catch((err) => {
      if (err instanceof OutboxFenced) return false;
      throw err;
    });
  },

  /**
   * Relayer dispatcher enumeration: DISTINCT (tenant_id, agent_id) tuples that
   * have ANY WORK to do this pass — EITHER a dispatchable pending row
   * (status='pending' AND backoff gate elapsed) OR a terminal row
   * (status IN ('sent','failed')) past the retention window. Runs OUTSIDE
   * tenant context — the relayer opens runWithTenantContext per tuple.
   *
   * The terminal-row arm is LOAD-BEARING for retention (Codex #326 blocker):
   * an IDLE tenant whose outbox holds ONLY old terminal rows and NO pending
   * row would otherwise never be enumerated, so its terminal rows would
   * accumulate without bound. Including it here makes the bounded retention
   * cleanup in `relayInner` reach a terminal-only tenant — cleanup is no
   * longer GATED on the pending-dispatch path. Same shape as the sibling
   * outbound-messages-sweeper `listTenantsWithWork` (#292). Belt-and-suspenders
   * NOT NULL predicate (schema already enforces) mirrors #251/#292.
   */
  async listTenantsWithWork(retentionDays: number): Promise<
    Array<{ tenant_id: string; agent_id: string }>
  > {
    const result = await db.execute<{ tenant_id: string; agent_id: string }>(sql`
      SELECT DISTINCT tenant_id, agent_id
      FROM ${idempotency_effect_outbox}
      WHERE tenant_id IS NOT NULL
        AND agent_id IS NOT NULL
        AND (
          (status = 'pending' AND next_attempt_at <= now())
          OR (
            status IN ('sent', 'failed')
            AND updated_at < now() - (${retentionDays} || ' days')::interval
          )
        )
    `);
    return Array.from(result.rows as unknown as Array<{ tenant_id: string; agent_id: string }>);
  },

  /**
   * Claim a bounded, oldest-first batch of dispatchable pending rows for the
   * CURRENT (tenant, agent). `FOR UPDATE SKIP LOCKED` lets concurrent relayer
   * passes (or the per-tenant advisory lock failing open) never contend on the
   * same row. The claim does NOT mutate status — dispatch + markSent/markRetry
   * happen per row after the physical effect, so a crash mid-batch leaves the
   * row pending (the next tick reclaims it). Bounded by `limit` for per-tenant
   * fairness (a high-volume tenant can't starve others within one pass).
   */
  async claimPendingEffects(limit: number): Promise<ClaimedOutboxEffect[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    // #327: SELECT tenant_id + agent_id (not just filter on them) so the relayer
    // derives the provider-side dedup key from the ROW's persisted identity, not
    // the ambient ALS context — the key must be stable across a re-dispatch.
    const rows = await db.execute<ClaimedOutboxEffect>(sql`
      SELECT id, tenant_id, agent_id, idempotency_key, effect_type, effect_payload, attempts, max_attempts
      FROM ${idempotency_effect_outbox}
      WHERE tenant_id = ${tenant_id}
        AND agent_id = ${agent_id}
        AND status = 'pending'
        AND next_attempt_at <= now()
      ORDER BY next_attempt_at ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `);
    return Array.from(rows.rows as unknown as ClaimedOutboxEffect[]);
  },

  /**
   * Mark a dispatched effect as sent (terminal-ish; retained for audit +
   * retention cleanup). Scoped + CAS on status='pending' so a concurrent
   * relayer that already settled the row is a no-op. Stores the provider ref
   * (external message id) for the audit trail.
   */
  async markEffectSent(input: { id: string; provider_ref: string | null }): Promise<boolean> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const updated = await db
      .update(idempotency_effect_outbox)
      .set({
        status: 'sent',
        provider_ref: input.provider_ref,
        last_error: null,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(idempotency_effect_outbox.tenant_id, tenant_id),
          eq(idempotency_effect_outbox.agent_id, agent_id),
          eq(idempotency_effect_outbox.id, input.id),
          eq(idempotency_effect_outbox.status, 'pending'),
        ),
      )
      .returning({ id: idempotency_effect_outbox.id });
    return updated.length > 0;
  },

  /**
   * Record a transient dispatch failure: bump `attempts`, store the error, and
   * push `next_attempt_at` forward by `backoff_seconds` (exponential backoff is
   * computed by the relayer). The row STAYS pending so the next tick retries —
   * UNLESS this attempt exhausts `max_attempts`, in which case the row is
   * transitioned to the terminal 'failed' status (the failed-has-error CHECK is
   * satisfied because we always store `error`). Returns the post-update status
   * so the relayer can ops_alert on terminal failure.
   */
  async markEffectRetry(input: {
    id: string;
    error: string;
    backoff_seconds: number;
  }): Promise<OutboxEffectStatus | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const backoff = `${input.backoff_seconds} seconds`;
    // Single statement: increment attempts, and if attempts+1 >= max_attempts
    // flip to 'failed' (terminal); otherwise stay 'pending' with the backoff
    // gate pushed forward. CAS on status='pending' so a concurrent settle wins.
    const updated = await db.execute<{ status: OutboxEffectStatus }>(sql`
      UPDATE ${idempotency_effect_outbox}
         SET attempts = attempts + 1,
             last_error = ${input.error},
             status = CASE WHEN attempts + 1 >= max_attempts THEN 'failed' ELSE 'pending' END,
             next_attempt_at = now() + ${backoff}::interval,
             updated_at = now()
       WHERE tenant_id = ${tenant_id}
         AND agent_id = ${agent_id}
         AND id = ${input.id}
         AND status = 'pending'
      RETURNING status
    `);
    return updated.rows[0]?.status ?? null;
  },

  /**
   * FORCE-TERMINAL failure (Codex #326 note (b)): transition a pending row
   * STRAIGHT to terminal 'failed' WITHOUT consuming the retry budget. Unlike
   * `markEffectRetry` (which only increments `attempts` by one), this is for a
   * permanently-unrecoverable row — e.g. an effect_payload that does not parse
   * / validate. Retrying such a row is pointless: it will never become valid,
   * so burning all `max_attempts` ticks on it just delays the ops_alert and
   * wastes relayer passes. We flip to 'failed' immediately and store the error
   * (the failed-has-error CHECK is satisfied because `error` is always set).
   * CAS on status='pending' so a concurrent settle wins. Returns true when this
   * call performed the transition.
   */
  async markEffectFailed(input: { id: string; error: string }): Promise<boolean> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const updated = await db.execute<{ id: string }>(sql`
      UPDATE ${idempotency_effect_outbox}
         SET status = 'failed',
             last_error = ${input.error},
             updated_at = now()
       WHERE tenant_id = ${tenant_id}
         AND agent_id = ${agent_id}
         AND id = ${input.id}
         AND status = 'pending'
      RETURNING id
    `);
    return updated.rows.length > 0;
  },

  /**
   * Retention cleanup: delete terminal rows (sent/failed) older than N days, in
   * bounded batches (mirrors outbound-messages-sweeper #292 blocker #1). Scoped
   * per current (tenant, agent). Returns the count deleted this call.
   *
   * The OUTER `DELETE` repeats the explicit `tenant_id`/`agent_id` predicate
   * (Codex #326 note (a)) so the row removal is tenant-scoped at the DELETE
   * itself, not only inside the `id IN (...)` subquery — defense-in-depth
   * against the (theoretical) reuse of an `id` value across tenants.
   */
  async cleanupTerminal(input: {
    olderThanDays: number;
    batchSize: number;
  }): Promise<number> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const deleted = await db.execute<{ id: string }>(sql`
      DELETE FROM ${idempotency_effect_outbox}
      WHERE tenant_id = ${tenant_id}
        AND agent_id = ${agent_id}
        AND id IN (
          SELECT id
          FROM ${idempotency_effect_outbox}
          WHERE tenant_id = ${tenant_id}
            AND agent_id = ${agent_id}
            AND status IN ('sent', 'failed')
            AND updated_at < now() - (${input.olderThanDays} || ' days')::interval
          ORDER BY updated_at ASC
          LIMIT ${input.batchSize}
          FOR UPDATE SKIP LOCKED
        )
      RETURNING id
    `);
    return deleted.rows.length;
  },
};

/**
 * Sentinel thrown inside `markCompletedWithEffect`'s tx to abort + roll back
 * when the fencing UPDATE matched 0 rows (preempted owner). Translated back to
 * `false` by the `.catch` so the dispatcher sees the same boolean contract as
 * plain `markCompleted`. Not exported — internal to the atomic write path.
 */
class OutboxFenced extends Error {
  constructor() {
    super('idempotency_outbox_completion_fenced');
    this.name = 'OutboxFenced';
  }
}

// Issue #227: outbound delivery idempotency ledger. Migration 063 schema.
export type OutboundMessageRow = typeof outbound_messages.$inferSelect;
export type OutboundChannel = 'text' | 'voice' | 'document' | 'poll';
export type OutboundStatus = 'pending' | 'sent' | 'failed' | 'unknown';

export const outboundMessagesRepo = {
  /**
   * Pre-send optimistic claim. Returns the current row and a `skip` flag:
   *   - skip=false: we claimed this turn (inserted a new pending row OR took
   *     over a prior 'failed' row by resetting it to pending). Caller proceeds
   *     with the gateway send, then markSent/markFailed.
   *   - skip=true: a prior attempt is already in-flight or terminal — i.e. an
   *     existing row has status 'pending' (another worker owns it), 'sent'
   *     (already delivered), or 'unknown' (could-be-delivered). The user has
   *     received (or might have received) this turn's reply, OR another worker
   *     is sending it RIGHT NOW. Caller MUST NOT send again. The returned row's
   *     provider_message_id is the prior ack (NULL when status='pending' or
   *     'unknown').
   *
   * Race-safety:
   *   1. The tx acquires `pg_advisory_xact_lock(hashtext(<scope>))` BEFORE the
   *      INSERT. All concurrent claimers for the same (tenant, agent, key)
   *      serialize on this lock — guarantees only ONE worker gets skip=false.
   *      Lock auto-releases on tx commit/rollback (xact_lock).
   *   2. ON CONFLICT DO UPDATE … WHERE `status = 'failed'` — only a prior
   *      'failed' row is reclaimable. 'pending' rows are now in-flight markers
   *      (the previous "reclaim pending" behavior allowed two workers to BOTH
   *      get skip=false: worker A INSERTed pending → worker B's ON CONFLICT
   *      hit the WHERE and also got skip=false → DOUBLE-SEND).
   *
   * Stale-pending recovery (issue #292, follow-up de #227): the
   * `outbound_messages_sweeper` worker (src/workers/outbound-messages-sweeper.ts,
   * runs every 5 minutes) promotes pending rows older than
   * OUTBOUND_SWEEPER_STALE_PENDING_SEC (default 5min) to 'unknown' — the
   * conservative terminal status that the boundary guard treats as
   * sent_no_persist (NO re-send, trades silence risk for zero double-send).
   * Under normal flow each turn's idempotency_key is unique per inbound, so
   * stale pending rarely affects user-visible behaviour — the sweeper is
   * defense-in-depth + housekeeping (it also runs retention cleanup on
   * terminal rows older than OUTBOUND_SWEEPER_RETENTION_DAYS, default 30d).
   */
  async upsertPending(input: {
    idempotency_key: string;
    conversa_id: string;
    in_reply_to: string;
    channel: OutboundChannel;
    tenant_id?: string;
    agent_id?: string;
  }): Promise<{ row: OutboundMessageRow; skip: boolean }> {
    // Tenant/agent isolation: the dedupe namespace is per (tenant, agent), not
    // a global string. Reads pull from the tenant context (set by webhook
    // routes via runWithTenantContext) unless the caller explicitly overrides
    // — call sites in output-dispatch.ts always run inside such a context.
    const tenant_id = input.tenant_id ?? getCurrentTenant();
    const agent_id = input.agent_id ?? getCurrentAgent();
    // Lock partition matches the UNIQUE: tenant + agent + key. hashtext is
    // 32-bit, so collisions across distinct keys are possible but harmless
    // (worst case: brief serialization of two unrelated turns).
    const lockKey = `${tenant_id}:${agent_id}:${input.idempotency_key}`;
    return withTx(async (tx) => {
      // (1) Serialize concurrent claimers for the same scope. Auto-released
      //     when the tx commits/rolls back.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
      // (2) INSERT … ON CONFLICT DO UPDATE … WHERE status = 'failed'. Only
      //     'failed' rows are reclaimable; 'pending' is now in-flight.
      const claimed = await tx
        .insert(outbound_messages)
        .values({
          idempotency_key: input.idempotency_key,
          conversa_id: input.conversa_id,
          in_reply_to: input.in_reply_to,
          channel: input.channel,
          tenant_id,
          agent_id,
          status: 'pending',
        })
        .onConflictDoUpdate({
          target: [
            outbound_messages.tenant_id,
            outbound_messages.agent_id,
            outbound_messages.idempotency_key,
          ],
          set: {
            status: 'pending',
            channel: input.channel,
            error: null,
            sent_at: null,
          },
          // STRICT pending: only reclaim 'failed' rows. Race-safe — see method
          // doc. Without this, the prior WHERE `IN ('pending','failed')` let
          // two concurrent workers both come back with skip=false.
          where: sql`${outbound_messages.status} = 'failed'`,
        })
        .returning();
      if (claimed.length > 0) {
        return { row: claimed[0]!, skip: false };
      }
      // ON CONFLICT WHERE rejected: existing row is 'pending' (in-flight),
      // 'sent', or 'unknown'. All three are skip=true — re-sending would either
      // double-send (sent) or race the in-flight worker (pending).
      const [existing] = await tx
        .select()
        .from(outbound_messages)
        .where(
          and(
            eq(outbound_messages.tenant_id, tenant_id),
            eq(outbound_messages.agent_id, agent_id),
            eq(outbound_messages.idempotency_key, input.idempotency_key),
          ),
        )
        .limit(1);
      return { row: existing!, skip: true };
    });
  },
  /**
   * Record a successful send. `provider_message_id` may be NULL when the
   * gateway returned no key.id but isBaileysConnected() confirmed the send
   * happened (the 'sent without id' case dispatchOutput tags delivered:true).
   *
   * CAS guard: only transition from non-terminal statuses ('pending'/'failed').
   * A pre-existing 'sent' or 'unknown' row stays as-is — protects against
   * double-marking that could clobber the original provider_message_id, and
   * defensively guards against programming errors that would mark sent after
   * markFailed.
   */
  async markSent(key: string, provider_message_id: string | null): Promise<void> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    await db
      .update(outbound_messages)
      .set({ status: 'sent', provider_message_id, sent_at: sql`now()` })
      .where(
        and(
          eq(outbound_messages.tenant_id, tenant_id),
          eq(outbound_messages.agent_id, agent_id),
          eq(outbound_messages.idempotency_key, key),
          inArray(outbound_messages.status, ['pending', 'failed']),
        ),
      );
  },
  /**
   * Record a failed attempt. `ambiguous=true` (the crux) means "could have
   * been delivered" — record 'unknown' so the per-turn guard treats it as sent
   * (no re-send), trading a sliver of silence risk for zero double-send.
   * `ambiguous=false` means "definitely not delivered" (pre-send disconnect /
   * throw before the wire) — record 'failed', a retry is safe.
   *
   * CAS guard: only transition from non-terminal statuses ('pending'/'failed').
   * A LATE markFailed against an already-'sent' row would otherwise degrade
   * 'sent' → 'failed', re-opening the row to reclaim → DOUBLE-SEND. The CAS
   * makes the call a no-op when a terminal status already won the race.
   */
  async markFailed(
    key: string,
    error: string,
    ambiguous: boolean,
  ): Promise<void> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    await db
      .update(outbound_messages)
      .set({ status: ambiguous ? 'unknown' : 'failed', error })
      .where(
        and(
          eq(outbound_messages.tenant_id, tenant_id),
          eq(outbound_messages.agent_id, agent_id),
          eq(outbound_messages.idempotency_key, key),
          inArray(outbound_messages.status, ['pending', 'failed']),
        ),
      );
  },
  /** Convenience for tests / ops. Scoped to current tenant/agent. */
  async findByKey(key: string): Promise<OutboundMessageRow | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(outbound_messages)
      .where(
        and(
          eq(outbound_messages.tenant_id, tenant_id),
          eq(outbound_messages.agent_id, agent_id),
          eq(outbound_messages.idempotency_key, key),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },
};

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

export const entityStatesRepo = {
  // Flip-readiness (#323, H4 of #355) — READ half of a read-then-write PAIR.
  // `entity_states` carries NOT NULL `tenant_id` + `agent_id` (schema). The PK
  // is `entidade_id` ALONE, so an id-only WHERE returns whatever single row owns
  // that id REGARDLESS of tenant — a cross-tenant read. Worse, `lockdown.ts`
  // feeds this row's `flags` straight back into `upsert` (read-then-write): an
  // unscoped read there would let one tenant's lockdown snapshot be merged onto
  // and re-written over another tenant's row. Scope the WHERE by tenant+agent
  // (bound from ALS) so the read returns the row ONLY when it belongs to the
  // running tuple. Returns null (not throw) on no-match: a missing/foreign
  // entity is a legitimate not-found for a READ, and the live caller
  // (`prompt-builder.ts` entityStateBlocks loop) already `continue`s on null.
  // Caller audit (both run inside the agent turn's
  // `runWithTenantContext({tenant_id, agent_id})`, except lockdown — see below):
  //   - `agent/prompt-builder.ts` (entityStateBlocks): tenant-scoped. SAFE.
  //   - `governance/lockdown.ts` (activate/liftLockdown): legacy emergency
  //     governance with NO live entrypoint (no tRPC/CLI/worker wiring; only doc
  //     references). It ORIGINALLY ran UNSCOPED raw `db` queries over ALL
  //     `entity_states` (a latent cross-tenant sweep). Rescoped per-tenant in
  //     #355: it now binds `tenant_id`/`agent_id` from ALS and scopes every
  //     query/mutation to the running tuple, failing loud (rejecting the
  //     `'default'` literal under the flag) instead of sweeping all tenants. So
  //     the dead path is now both flip-safe and correct if ever wired up — a
  //     cross-tenant `entity_states` write (the bug H4 closes) is no longer
  //     reachable from it.
  async byId(entidade_id: string): Promise<EntityState | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(entity_states)
      .where(
        and(
          eq(entity_states.entidade_id, entidade_id),
          eq(entity_states.tenant_id, tenant_id),
          eq(entity_states.agent_id, agent_id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },
  // Flip-readiness (#323, H4 of #355) — WRITE half of the read-then-write PAIR.
  // The conflict target is the `entidade_id` PK only, and the OLD SET
  // (`{ ...input, updated_at }`) did NOT re-stamp tenant/agent NOR gate the
  // conflict on ownership. So if tenant-B already owns the row for a colliding
  // `entidade_id`, a tenant-A `upsert` would conflict on the PK and DO UPDATE
  // would OVERWRITE tenant-B's `contexto`/`flags` — a cross-tenant write. (PK
  // global-uniqueness makes the collision improbable, but the isolation
  // invariant is STRUCTURAL, not probabilistic — cf. procedureExecutionsRepo.findById.)
  // FIX (two parts):
  //   (1) INSERT stamps tenant_id+agent_id from ALS via `applyTenantGuard`
  //       (throws on a tenant-mismatched explicit input; both columns NOT NULL).
  //   (2) `onConflictDoUpdate.where` gates the UPDATE on tenant+agent so a
  //       conflicting row owned by ANOTHER tenant is left untouched — it can
  //       never overwrite a foreign row. The SET stays tenant-agnostic on
  //       purpose: the WHERE already pins ownership, and the row's identity
  //       columns must not move.
  // FAIL-LOUD on 0 returned rows: with the INSERT now stamped, a 0-row result
  // can ONLY mean the conflict fired AND the ownership WHERE rejected it — i.e.
  // the `entidade_id` is already owned by a different tenant/agent. That is a
  // cross-tenant collision the caller MUST see, not a silent no-op that would
  // make it believe the state was persisted.
  // Caller audit: `prompt-builder.ts` does NOT call upsert (read-only there).
  // `governance/lockdown.ts` is the only upsert caller — same legacy-no-context
  // caveat as `byId` above (REPORTED; not changed).
  async upsert(input: Partial<EntityState> & { entidade_id: string }): Promise<EntityState> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const guarded = applyTenantGuard({
      ...input,
      contexto: input.contexto ?? {},
    });
    // The conflict-arm SET must NEVER move the row's identity columns
    // (`tenant_id`/`agent_id`/`entidade_id`). `applyTenantGuard` already
    // validates them for the INSERT path; here we strip them from the SET so a
    // (future) caller that passes `tenant_id` in `input` cannot re-stamp the
    // running tenant's own row onto another tenant via the UPDATE branch.
    const { tenant_id: _t, agent_id: _a, entidade_id: _e, ...updatable } = input as Record<string, unknown>;
    void _t;
    void _a;
    void _e;
    const rows = await db
      .insert(entity_states)
      .values(guarded as typeof entity_states.$inferInsert)
      .onConflictDoUpdate({
        target: entity_states.entidade_id,
        set: { ...updatable, updated_at: new Date() },
        where: and(
          eq(entity_states.tenant_id, tenant_id),
          eq(entity_states.agent_id, agent_id),
        ),
      })
      .returning();
    if (rows.length !== 1) {
      throw new Error(
        `entityStatesRepo.upsert matched ${rows.length} rows for entidade ${input.entidade_id} ` +
          `under ${tenant_id}/${agent_id} — expected 1 (the entidade_id is already owned by a ` +
          `different tenant/agent; the upsert would have either overwritten a foreign tenant's ` +
          `entity_state or been silently dropped while reported as persisted)`,
      );
    }
    return rows[0]!;
  },
};

export const selfStateRepo = {
  // Flip-readiness (#323, H4 of #355) — READ half of a read-then-write PAIR, and
  // the more dangerous one. `self_state` carries NOT NULL `tenant_id` +
  // `agent_id` (schema). The OLD WHERE filtered on `ativa = true` ALONE and
  // ordered by `versao desc` — so once a second tenant exists it returns
  // WHICHEVER tenant has the highest active `versao`, i.e. ANY tenant's active
  // self_state. That row's `id` then feeds `appendLearning`'s UPDATE-by-id, so
  // an unscoped read here causes a cross-tenant WRITE: one tenant's reflection
  // learning appended onto another tenant's self_state. Scope the WHERE by
  // tenant+agent (bound from ALS) so it returns ONLY the running tuple's active
  // row. Returns null (not throw) on no-match: a tenant with no active
  // self_state yet is legitimate, and every caller already handles null
  // (`prompt-builder.ts` falls back to defaults; `appendLearning` early-returns).
  // Caller audit (all live callers run inside the agent turn's
  // `runWithTenantContext({tenant_id, agent_id})`):
  //   - `agent/prompt-builder.ts` ×2 (legacy self_state fallback): tenant-scoped. SAFE.
  //   - `appendLearning` (below, same repo): tenant-scoped when reached. SAFE.
  // (NB: the many `operationalProfileVersionsRepo.getActive()` call sites are a
  // DIFFERENT repo and unaffected.)
  async getActive(): Promise<SelfState | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(self_state)
      .where(
        and(
          eq(self_state.tenant_id, tenant_id),
          eq(self_state.agent_id, agent_id),
          eq(self_state.ativa, true),
        ),
      )
      .orderBy(desc(self_state.versao))
      .limit(1);
    return rows[0] ?? null;
  },
  // Flip-readiness (#323, H4 of #355) — WRITE half of the read-then-write PAIR.
  // `active` now comes from the tenant-scoped `getActive` above, so `active.id`
  // provably belongs to the running (tenant_id, agent_id) tuple. We STILL add the
  // tenant+agent predicate to the UPDATE WHERE as defense-in-depth (the row id is
  // already tenant-bound by the read, but binding the write makes the mutation
  // tenant-safe on its own and matches the H1–H3 convention).
  // Predicate-only (no fail-loud throw): `appendLearning` runs on a best-effort,
  // fire-and-forget path — its sole live caller (`agent/reflection.ts`
  // `reflectOnWorkflowCompletion`) wraps the whole call in `.catch(() =>
  // undefined)`. A 0-row UPDATE here cannot happen in practice (the row was just
  // read under the SAME scope in this same async context), and even if a
  // concurrent deactivation raced it, dropping a single learning append is a
  // benign no-op (not a correctness/money bug). So scope the WHERE but do not
  // escalate to a throw — unlike the financial/lifecycle single-row writes.
  async appendLearning(learning: string): Promise<void> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const active = await this.getActive();
    if (!active) return;
    const prev = active.resumo_aprendizados ?? '';
    const lines = prev.split('\n').filter(Boolean);
    lines.push(`[${new Date().toISOString().slice(0, 10)}] ${learning}`);
    const trimmed = lines.slice(-50).join('\n');
    await db
      .update(self_state)
      .set({ resumo_aprendizados: trimmed })
      .where(
        and(
          eq(self_state.id, active.id),
          eq(self_state.tenant_id, tenant_id),
          eq(self_state.agent_id, agent_id),
        ),
      );
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

export const tenantsRepo = {
  async findById(id: string): Promise<Tenant | null> {
    const rows = await db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
    return rows[0] ?? null;
  },

  // DEPRECATED for tRPC `tenants.create` — use `createWithAuditAtomic` instead
  // so the tenant insert and `admin_audit_log` append commit together. Kept
  // for callers that don't need an audit row (test fixtures + integration
  // setup such as `tests/integration/tenant-isolation.spec.ts`). All new
  // production code paths MUST go through `createWithAuditAtomic` (issue #184).
  async create(t: { id: string; nome: string; status?: string }): Promise<Tenant> {
    const [created] = await db.insert(tenants).values(t).returning();
    return created!;
  },

  // P3c Task 9: workers que precisam iterar todos os tenants (ex.: reaper)
  // chamam list() para fan-out. Cross-tenant por design — single point of
  // truth para enumeração, sem RLS implícito.
  async list(): Promise<Tenant[]> {
    return db.select().from(tenants).orderBy(tenants.id);
  },

  /**
   * Atomic tenant insert + admin_audit_log append.
   *
   * Codex Adversarial Review on PR #180 (issue #184) — `tenantsRepo.create`
   * followed by a separate `adminAuditLogRepo.append` was not atomic: if the
   * audit insert failed (or the request was interrupted) between the two
   * statements, the tenant row was already committed but no forensic record
   * existed. Retry then hit a duplicate-primary-key CONFLICT (`Tenant 'x'
   * already exists`) and the `tenant_create` audit row was lost forever —
   * violating the append-only mutation-trail invariant for `admin_audit_log`
   * for tenant provisioning.
   *
   * This method follows the same pattern as `updateStatusAtomic` (PR #169,
   * issue #165) and `agentsRepo.createWithSeedAndAudit` (PR #171, issue
   * #166):
   *   1. Open transaction.
   *   2. INSERT into `tenants`.
   *   3. INSERT into `admin_audit_log` inside the same tx — if this throws,
   *      the tenant INSERT rolls back and no orphaned tenant exists.
   *
   * Returns a discriminated union so the router can map outcomes to TRPC
   * codes without inspecting exceptions (matches the `updateStatusAtomic`
   * shape).
   */
  async createWithAuditAtomic(input: {
    tenant: {
      id: string;
      nome: string;
      status?: string;
    };
    audit: {
      tenant_id: string;
      actor_id: string;
      actor_role: string;
    };
  }): Promise<
    | { ok: true; tenant: Tenant }
    | { ok: false; reason: 'duplicate_id' }
  > {
    try {
      return await withTx(async (tx) => {
        // (1) Insert tenant row.
        const [created] = await tx
          .insert(tenants)
          .values({
            id: input.tenant.id,
            nome: input.tenant.nome,
            status: input.tenant.status ?? 'active',
          })
          .returning();
        if (!created) {
          // Should be unreachable — INSERT ... RETURNING either errors or
          // returns the inserted row.
          throw new TypedError(
            'tenant_create_failed',
            `INSERT returned no row for tenant ${input.tenant.id}`,
          );
        }

        // (2) Audit in the SAME tx. If this throws, the tenant INSERT rolls
        //     back — no orphaned tenant row, no missing audit record.
        await tx.insert(admin_audit_log).values({
          tenant_id: input.audit.tenant_id,
          actor_id: input.audit.actor_id,
          actor_role: input.audit.actor_role,
          action: 'tenant_create',
          resource_type: 'tenant',
          resource_id: created.id,
          change_summary: {
            target_tenant_id: created.id,
            nome: created.nome,
            status: created.status,
          },
        });

        return { ok: true as const, tenant: created };
      });
    } catch (err) {
      // Map duplicate-primary-key violation (tenants.id is PRIMARY KEY) to a
      // typed reason so the router can return CONFLICT without inspecting the
      // pg error code. Concurrent racers (two founders trying to create the
      // same id at once) BOTH see this branch — one wins the INSERT, the
      // other's tx aborts with 23505 and rolls back as expected.
      // pgErrorCode unwraps Drizzle's DrizzleQueryError so the underlying
      // pg SQLSTATE (on `.cause`) is read, not the wrapper's undefined code.
      if (pgErrorCode(err) === '23505') {
        return { ok: false as const, reason: 'duplicate_id' as const };
      }
      throw err;
    }
  },

  // Admin UI setup: muda status do tenant (active|suspended). Não retorna nada
  // útil em erro — caller checa findById depois se precisar verificar.
  //
  // DEPRECATED for tRPC `tenants.updateStatus` — use `updateStatusAtomic`
  // instead so the status flip and admin_audit_log append commit together.
  // Kept for any direct caller that doesn't need the audit record (none today;
  // remove once eslint rule confirms zero hits).
  async updateStatus(id: string, status: string): Promise<Tenant | null> {
    const [updated] = await db
      .update(tenants)
      .set({ status, updated_at: new Date() })
      .where(eq(tenants.id, id))
      .returning();
    return updated ?? null;
  },

  /**
   * Atomic status flip + admin_audit_log append.
   *
   * Codex Adversarial Review round 3 on PR #163 (issue #165) — `updateStatus`
   * followed by a separate `adminAuditLogRepo.append` was not atomic: if the
   * audit insert failed (or the request was interrupted) between the two
   * statements, the tenant was already suspended/reactivated but no forensic
   * record existed. Retry then hit `BAD_REQUEST` ("already X") and the audit
   * row was lost forever — violating the append-only mutation-trail invariant
   * for `admin_audit_log`.
   *
   * This method follows the same pattern as
   * `operationalProfileVersionsRepo.approveAndActivateAtomic` (PR #162 r2)
   * and `proposalsUnifiedRepo.decideAtomically` (PR #101):
   *   1. Open transaction.
   *   2. SELECT ... FOR UPDATE the tenant row (serialize concurrent flips).
   *   3. Re-check status inside the tx (prevents lost-update races where two
   *      founders read 'active' and both try to suspend).
   *   4. UPDATE status.
   *   5. INSERT admin_audit_log inside the same tx — if this throws, the
   *      UPDATE rolls back and the tenant status is unchanged.
   *
   * Returns a discriminated union so the router can map outcomes to TRPC
   * codes without inspecting exceptions.
   */
  async updateStatusAtomic(input: {
    id: string;
    status: string;
    audit: {
      tenant_id: string;
      actor_id: string;
      actor_role: string;
      comment: string;
    };
  }): Promise<
    | { ok: true; before: Tenant; after: Tenant }
    | { ok: false; reason: 'not_found' | 'already_in_status' }
  > {
    return await withTx(async (tx) => {
      // (1) Lock the tenant row FOR UPDATE so concurrent flips serialize.
      const lockedRows = await tx
        .select()
        .from(tenants)
        .where(eq(tenants.id, input.id))
        .for('update')
        .limit(1);
      const before = lockedRows[0];
      if (!before) return { ok: false as const, reason: 'not_found' as const };

      // (2) Re-check status INSIDE the tx — the router's pre-flight findById
      // ran outside any transaction, so two concurrent suspend calls could
      // both see 'active' and race to flip. Without this check, one would
      // succeed with from=active→suspended and the other would (incorrectly)
      // commit from=active→suspended a second time, producing a duplicate
      // audit row and a misleading mutation trail.
      if (before.status === input.status) {
        return { ok: false as const, reason: 'already_in_status' as const };
      }

      // (3) Flip status.
      const [after] = await tx
        .update(tenants)
        .set({ status: input.status, updated_at: new Date() })
        .where(eq(tenants.id, input.id))
        .returning();
      if (!after) {
        // Should be unreachable — we just held FOR UPDATE on this row.
        throw new TypedError(
          'tenant_status_update_failed',
          `UPDATE returned no row for tenant ${input.id}`,
        );
      }

      // (4) Audit in the SAME tx. If this throws, EVERYTHING rolls back and
      // the tenant status is restored — no unaudited governance change.
      await tx.insert(admin_audit_log).values({
        tenant_id: input.audit.tenant_id,
        actor_id: input.audit.actor_id,
        actor_role: input.audit.actor_role,
        action: 'tenant_update_status',
        resource_type: 'tenant',
        resource_id: after.id,
        change_summary: {
          target_tenant_id: after.id,
          from_status: before.status,
          to_status: after.status,
          reason: input.audit.comment,
        },
      });

      return { ok: true as const, before, after };
    });
  },
};

export const agentsRepo = {
  async findById(id: string): Promise<Agent | null> {
    const rows = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
    return rows[0] ?? null;
  },

  async listByTenant(tenant_id: string): Promise<Agent[]> {
    return db.select().from(agents).where(eq(agents.tenant_id, tenant_id));
  },

  // Admin UI setup: cria um agent dentro de um tenant existente. NÃO usa
  // applyTenantGuard porque o caller já validou o tenant via founderProcedure
  // ou assertRole + resolveTenantId; passamos tenant_id explícito.
  async create(input: {
    id: string;
    tenant_id: string;
    nome: string;
    status?: string;
    metadata?: Record<string, unknown>;
  }): Promise<Agent> {
    const [created] = await db
      .insert(agents)
      .values({
        id: input.id,
        tenant_id: input.tenant_id,
        nome: input.nome,
        status: input.status ?? 'active',
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      })
      .returning();
    return created!;
  },

  /**
   * Atomic "create agent + seed v1 operational profile + admin audit" — all
   * inside a single transaction so a partial commit cannot leave:
   *   - an agent row with no seed profile (Approve & activate target missing
   *     in /identities, retry of `create` hits CONFLICT),
   *   - or agent + seed profile with no audit row (forensics gap on who
   *     created the agent).
   *
   * Codex review of PR #162 round 3 (issue #166) — addresses the same class
   * of multi-write atomicity gap that `approveAndActivateAtomic` solved for
   * `approveProfile`.
   *
   * Required input is explicit (no AsyncLocalStorage dependency) so the
   * router can call it without `runWithTenantContext` — tenant_id/agent_id
   * are stamped on the seed profile_version directly inside the tx.
   *
   * The seed version is always `version=1` and `status='proposed'`
   * (P8.5 invariant — no profile activates without an approval).
   *
   * Returns a discriminated union so the router can map the duplicate-agent-id
   * race to TRPC CONFLICT without inspecting raw pg error codes.
   *
   * Codex Adversarial Review on PR #187 round 1 (issue #184) — this method
   * previously let a primary-key 23505 bubble up as an INTERNAL_SERVER_ERROR
   * (500) when the router's out-of-tx `findById` preflight raced with a
   * concurrent create that won the INSERT first. We now catch 23505 here and
   * return `{ ok: false, reason: 'duplicate_id' }` — the tx aborts naturally
   * (no orphaned seed_profile or audit row), and the router maps to CONFLICT.
   * Mirrors `tenantsRepo.createWithAuditAtomic` (PR #187).
   *
   * Issue #410/#408 — BASELINE vs DOMAIN differentiation at agent creation.
   * Every runtime agent receives the `DEFAULT_AGENT_PACKS` (`['baseline.core']`,
   * defined in `src/tools/packs.ts`) tool grant — the conservative capability
   * floor (read context, recall/remember safe memory, ask confirmation, audit,
   * escalate). Domain packs are NEVER default; they are granted explicitly.
   *
   * #408 PERSISTS that default grant: step (3) below inserts the agent's
   * `agent_tool_grants` row (`granted_packs=['baseline.core']`) IN THE SAME TX
   * as the agent + seed profile, so an agent never exists without a grant (a
   * grant-less agent would fail-closed to zero tools at runtime — a silent
   * regression). The pack-id list is a literal (not imported from
   * src/tools/packs.ts) so this hot-path repo module stays free of the
   * tools-registry/gateway import chain; it is kept in sync with
   * `DEFAULT_AGENT_PACKS`/`defaultAgentGrant()` (a unit test pins the parity).
   * The runtime enforcement (filter + dispatcher `tool_not_granted` guard) lives
   * in the tools module. The baseline SKILLS half is seeded tenant-wide
   * (`proposed_by='system'`, active) by migration `075_*` (governed/auditable,
   * not a self-approval — invariant #6).
   */
  async createWithSeedAndAudit(args: {
    agent: {
      id: string;
      tenant_id: string;
      nome: string;
      status?: string;
      metadata?: Record<string, unknown>;
    };
    seed_profile: {
      profile_body: ProfileBody;
      proposed_by: string;
      proposed_reason: string;
    };
    audit: {
      actor_id: string;
      actor_role: string;
    };
  }): Promise<
    | { ok: true; agent: Agent; seed_profile: AgentOperationalProfileVersion }
    | { ok: false; reason: 'duplicate_id'; agent_id: string }
  > {
    // Validate before opening the tx so a malformed body fails fast without
    // touching the DB. Mirrors the `seedNewActiveAtomic` pattern.
    validateProfileBodyP8d(args.seed_profile.profile_body);

    try {
      return await withTx(async (tx) => {
        // (1) Insert agent row. PK collision (23505) here is the only
        //     legitimate "duplicate" path — agent ids are caller-supplied
        //     slugs unique on the `agents` PRIMARY KEY. Two concurrent
        //     creates that both passed the (now-removed) router preflight
        //     will both reach this INSERT; the loser hits 23505 and we
        //     surface a typed reason instead of letting the raw pg error
        //     leak as a 500.
        const [createdAgent] = await tx
          .insert(agents)
          .values({
            id: args.agent.id,
            tenant_id: args.agent.tenant_id,
            nome: args.agent.nome,
            status: args.agent.status ?? 'active',
            ...(args.agent.metadata !== undefined ? { metadata: args.agent.metadata } : {}),
          })
          .returning();
        if (!createdAgent) {
          throw new Error('create_with_seed_atomic_agent_insert_failed: returning() empty');
        }

        // (2) Insert seed v1 operational profile_version with status='proposed'.
        //     No need for applyTenantGuard — tenant_id/agent_id are explicit and
        //     match the agent row we just inserted. 23505 here would mean a
        //     pre-existing seed v1 for a brand-new agent id, which is
        //     impossible (the agent insert above just created the row), so we
        //     do NOT map it to duplicate_id.
        const [seedProfile] = await tx
          .insert(agent_operational_profile_versions)
          .values({
            tenant_id: args.agent.tenant_id,
            agent_id: createdAgent.id,
            version: 1,
            status: 'proposed',
            profile_body: args.seed_profile.profile_body,
            proposed_by: args.seed_profile.proposed_by,
            proposed_reason: args.seed_profile.proposed_reason,
          })
          .returning();
        if (!seedProfile) {
          throw new Error('create_with_seed_atomic_profile_insert_failed: returning() empty');
        }

        // (3) Issue #408 — persist the DEFAULT tool grant in the SAME tx. Every
        //     agent gets `granted_packs=['baseline.core']` (the conservative
        //     floor); domain packs are NEVER default. Without this, the agent
        //     would have no grant row and the runtime filter would fail-closed
        //     to zero tools. Literal pack id kept in sync with
        //     `DEFAULT_AGENT_PACKS` (parity pinned by a unit test). No
        //     applyTenantGuard: tenant_id/agent_id are explicit and match the
        //     agent row just inserted.
        await tx.insert(agent_tool_grants).values({
          tenant_id: args.agent.tenant_id,
          agent_id: createdAgent.id,
          granted_packs: ['baseline.core'],
          granted_by: args.audit.actor_id,
          reason: 'baseline.core default grant (agent creation, issue #408)',
        });

        // (4) Audit in the SAME tx. If this insert fails, EVERYTHING rolls back
        //     and the agent + seed profile + grant DO NOT persist — no orphaned
        //     setup.
        await tx.insert(admin_audit_log).values({
          tenant_id: args.agent.tenant_id,
          actor_id: args.audit.actor_id,
          actor_role: args.audit.actor_role,
          action: 'agent_create',
          resource_type: 'agent',
          resource_id: createdAgent.id,
          change_summary: {
            agent_id: createdAgent.id,
            agent_nome: createdAgent.nome,
            seed_profile_version_id: seedProfile.id,
            seed_profile_version: seedProfile.version,
            seed_profile_status: seedProfile.status,
            proposed_reason: args.seed_profile.proposed_reason,
            // Issue #410/#408 — the default tool-pack grant for this agent,
            // now PERSISTED to `agent_tool_grants` in step (3) above. Literal
            // (not imported from src/tools/packs.ts) so this hot-path repo
            // module stays free of the tools-registry/gateway import chain. Kept
            // in sync with `DEFAULT_AGENT_PACKS`/`defaultAgentGrant()`.
            default_tool_packs: ['baseline.core'],
          },
        });

        return { ok: true as const, agent: createdAgent, seed_profile: seedProfile };
      });
    } catch (err) {
      // Map duplicate-primary-key violation (agents.id is PRIMARY KEY) to a
      // typed reason so the router returns CONFLICT without inspecting pg
      // error codes. Concurrent racers that both passed the (now-removed)
      // router preflight BOTH see this branch — one wins the INSERT, the
      // other's tx aborts with 23505 and rolls back the seed_profile/audit
      // writes it never made (`acquireNextVersionForAgent` and the audit
      // step never executed because the agents INSERT threw first).
      //
      // We do NOT distinguish by constraint name here: the only 23505 in
      // step (1) is the agents PK; step (2) PK collision is unreachable for
      // a row whose agent_id was just inserted in the same tx; step (3) the
      // agent_tool_grants (tenant_id, agent_id) unique is likewise unreachable
      // for a brand-new agent id (the agents INSERT in step (1) would have
      // thrown first on a duplicate id); step (4) admin_audit_log has no unique
      // index that could collide.
      // pgErrorCode unwraps Drizzle's DrizzleQueryError so the underlying
      // pg SQLSTATE (on `.cause`) is read, not the wrapper's undefined code.
      if (pgErrorCode(err) === '23505') {
        return {
          ok: false as const,
          reason: 'duplicate_id' as const,
          agent_id: args.agent.id,
        };
      }
      throw err;
    }
  },
};

export const cognitiveModuleLogRepo = {
  // PR #75 review (Superpowers finding #6): cognitive_module_log é tenant-aware
  // (tenant_id + agent_id NOT NULL desde migration 008). O caller atual
  // (reflection.ts) já passa tenant_id/agent_id explicitamente e roda dentro
  // de runWithTenantContext, mas aplicamos `applyTenantGuard` aqui pra:
  //   1. Falhar fechado se algum caller futuro esquecer o contexto.
  //   2. Detectar mismatch entre input e contexto (caller passou tenant errado).
  // O DEFAULT 'default' do schema fica como rede de segurança em P0 — sweep
  // de DROP DEFAULT está agendado pro pós-P0 (finding #7).
  async record(entry: Omit<CognitiveModuleLog, 'id' | 'created_at'>): Promise<void> {
    const guarded = applyTenantGuard(entry as Record<string, unknown>);
    await db.insert(cognitive_module_log).values(guarded as typeof entry);
  },

  async recentByModule(module_name: string, limit = 100): Promise<CognitiveModuleLog[]> {
    return db
      .select()
      .from(cognitive_module_log)
      .where(eq(cognitive_module_log.module_name, module_name))
      .orderBy(desc(cognitive_module_log.created_at))
      .limit(limit);
  },
};

export const cognitiveCandidatesRepo = {
  async create(
    input: Omit<CognitiveCandidate, 'id' | 'created_at' | 'tenant_id' | 'agent_id' | 'status' | 'consumed_by_phase' | 'consumed_at'>,
  ): Promise<CognitiveCandidate> {
    const guarded = applyTenantGuard(input);
    const [row] = await db.insert(cognitive_candidates).values(guarded).returning();
    return row!;
  },

  async listPending(candidate_type?: string, limit = 100): Promise<CognitiveCandidate[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const conditions = [
      eq(cognitive_candidates.tenant_id, tenant_id),
      eq(cognitive_candidates.agent_id, agent_id),
      eq(cognitive_candidates.status, 'pending'),
    ];
    if (candidate_type) conditions.push(eq(cognitive_candidates.candidate_type, candidate_type));
    return db
      .select()
      .from(cognitive_candidates)
      .where(and(...conditions))
      .orderBy(desc(cognitive_candidates.created_at))
      .limit(limit);
  },

  async markConsumed(id: string, phase: string): Promise<void> {
    // Flip-readiness (#323, H4 of #355) — tenant+agent scope the WHERE (bound
    // from ALS), mirroring the already-scoped `listPending`. Both columns are
    // NOT NULL (schema `cognitive_candidates`). The sole live caller
    // (`workers/procedure-candidate-consumer.ts`) marks the EXACT candidate it
    // just read via the tenant+agent-scoped `listPending('procedimento', 50)`,
    // and does so inside the SAME `runWithTenantContext({tenant_id, agent_id})`
    // it opened for that tenant — so the row provably belongs to the running
    // tuple and the predicate matches it.
    //
    // FAIL-LOUD (throw on !=1): this transitions one specific, known-present
    // candidate from 'pending' to 'consumed' (the worker's idempotency hinge —
    // a consumed candidate is never re-processed). The id-only WHERE always
    // matched, so a 0-row result under the new predicate can ONLY be a
    // tenant/agent mismatch (cross-tenant misroute), never a benign no-op. A
    // silent miss would leave the candidate 'pending' forever (re-drafted every
    // run → duplicate procedure drafts) while the worker logged success — so
    // surface it loudly. Same `.returning({id})` + `.length` idiom as
    // `mensagensRepo.markProcessed`.
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const updated = await db
      .update(cognitive_candidates)
      .set({ status: 'consumed', consumed_by_phase: phase, consumed_at: new Date() })
      .where(
        and(
          eq(cognitive_candidates.id, id),
          eq(cognitive_candidates.tenant_id, tenant_id),
          eq(cognitive_candidates.agent_id, agent_id),
        ),
      )
      .returning({ id: cognitive_candidates.id });
    if (updated.length !== 1) {
      throw new Error(
        `cognitiveCandidatesRepo.markConsumed matched ${updated.length} rows for candidate ${id} ` +
          `under ${tenant_id}/${agent_id} — expected 1 (tenant/agent context does not match the ` +
          `target candidate; the consume would have been silently lost, leaving it pending and ` +
          `re-processed every run while reported as consumed)`,
      );
    }
  },

  /**
   * Returns the distinct (tenant_id, agent_id) pairs that own at least
   * one pending candidate of the requested type. Used by workers that
   * must fan out across tenants (e.g., procedure_candidate_consumer).
   *
   * NOTE: This method intentionally does NOT use the tenant guard —
   * iteration is part of the worker's contract. Callers MUST invoke it
   * once at worker startup and then wrap per-pair processing in
   * `runWithTenantContext`. (P83-C2)
   */
  async listPendingTenantPairsForType(
    candidate_type: string,
  ): Promise<Array<{ tenant_id: string; agent_id: string }>> {
    const rows = await db
      .selectDistinct({
        tenant_id: cognitive_candidates.tenant_id,
        agent_id: cognitive_candidates.agent_id,
      })
      .from(cognitive_candidates)
      .where(
        and(
          eq(cognitive_candidates.status, 'pending'),
          eq(cognitive_candidates.candidate_type, candidate_type),
        ),
      );
    return rows;
  },
};

export const memoryEntryRepo = {
  async create(
    input: Omit<
      MemoryEntry,
      | 'id'
      | 'created_at'
      | 'updated_at'
      | 'tenant_id'
      | 'agent_id'
      // P10a: lifecycle columns have DB defaults — callers don't supply them.
      | 'lifecycle_status'
      | 'evidence_count'
      | 'confidence'
      | 'lifecycle_transitions'
      | 'last_recall_at'
    >,
  ): Promise<MemoryEntry> {
    const guarded = applyTenantGuard(input);
    const [row] = await db.insert(memory_entry).values(guarded).returning();
    return row!;
  },

  async findRelevant(opts: {
    interlocutor_id?: string;
    role_id?: string;
    channel_id?: string;
    conversa_id?: string;
    limit?: number;
  }): Promise<MemoryEntry[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const now = new Date();
    const conds = [
      eq(memory_entry.tenant_id, tenant_id),
      eq(memory_entry.agent_id, agent_id),
      eq(memory_entry.needs_review, false),
      // PR #82 review (Codex medium + Superpowers Critical #2): TTL must
      // be enforced at query time. Entries past expires_at MUST NOT be
      // returned to the prompt builder. NULL expires_at = no TTL.
      or(isNull(memory_entry.expires_at), gt(memory_entry.expires_at, now)),
      // P10a (review #104 critical): lifecycle_status filter enforced on
      // every prompt-exposing read. pending_review / deprecated / revoked
      // entries stay hidden from the LLM.
      inArray(memory_entry.lifecycle_status, [
        'ephemeral',
        'observed',
        'reinforced',
        'verified',
        'active',
      ]),
    ];
    // Filtrar por scope_type + subject_id apropriado. PR #82 review
    // (Superpowers Critical #4): role/channel devem só ser incluídos
    // quando o caller passar o subject id correspondente — senão a
    // memória escopada por role/channel atravessa todas as fronteiras.
    const orConds = [];
    if (opts.interlocutor_id) {
      orConds.push(
        and(
          eq(memory_entry.scope_type, 'interlocutor'),
          eq(memory_entry.subject_id, opts.interlocutor_id),
        ),
      );
    }
    if (opts.role_id) {
      orConds.push(
        and(eq(memory_entry.scope_type, 'role'), eq(memory_entry.subject_id, opts.role_id)),
      );
    }
    if (opts.channel_id) {
      orConds.push(
        and(
          eq(memory_entry.scope_type, 'channel'),
          eq(memory_entry.subject_id, opts.channel_id),
        ),
      );
    }
    if (opts.conversa_id) {
      orConds.push(
        and(
          eq(memory_entry.scope_type, 'conversation'),
          eq(memory_entry.subject_id, opts.conversa_id),
        ),
      );
    }
    orConds.push(eq(memory_entry.scope_type, 'agent'));

    return db
      .select()
      .from(memory_entry)
      .where(and(...conds, or(...orConds)))
      .orderBy(desc(memory_entry.created_at))
      .limit(opts.limit ?? 50);
  },

  async markReviewed(
    id: string,
    updates: {
      memory_type: string;
      sensitivity: string;
      proactive_use: boolean;
      mention_allowed: boolean;
      ttl_days?: number | null;
      scope_type?: string;
      subject_id?: string;
    },
  ): Promise<void> {
    // PR #82 review (Superpowers Critical #3): when promoting a candidate
    // out of needs_review, compute expires_at from ttl_days so that the
    // TTL filter in findRelevant can actually evict the row. Without this
    // a sensitive memory with ttl_days=7 was kept indefinitely.
    const expires_at =
      updates.ttl_days != null
        ? new Date(Date.now() + updates.ttl_days * 24 * 60 * 60 * 1000)
        : null;
    // Flip-readiness (#323, H4 of #355) — tenant+agent scope the WHERE (bound
    // from ALS), mirroring the already-scoped `findRelevant` / `listNeedsReview`.
    // Both columns are NOT NULL (schema `memory_entry`). The sole live caller
    // (`workers/legacy-memory-reclassifier.ts`) updates the EXACT entry it just
    // read via the tenant+agent-scoped `listNeedsReview(100)`, inside the SAME
    // `runWithTenantContext({tenant_id, agent_id})` it opened for that tenant —
    // so the row provably belongs to the running tuple and the predicate matches.
    //
    // FAIL-LOUD (throw on !=1): this promotes one specific, known-present entry
    // OUT of `needs_review` (computing its `expires_at` so the TTL filter can
    // evict it). The id-only WHERE always matched, so a 0-row result under the
    // new predicate can ONLY be a tenant/agent mismatch (cross-tenant misroute),
    // never a benign no-op. A silent miss would leave the memory stuck in
    // needs_review=true (permanently hidden from the prompt) while the worker
    // logged it reclassified — so surface it loudly. Same `.returning({id})` +
    // `.length` idiom as `mensagensRepo.markProcessed`.
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const updated = await db
      .update(memory_entry)
      .set({ ...updates, expires_at, needs_review: false, updated_at: new Date() })
      .where(
        and(
          eq(memory_entry.id, id),
          eq(memory_entry.tenant_id, tenant_id),
          eq(memory_entry.agent_id, agent_id),
        ),
      )
      .returning({ id: memory_entry.id });
    if (updated.length !== 1) {
      throw new Error(
        `memoryEntryRepo.markReviewed matched ${updated.length} rows for memory ${id} ` +
          `under ${tenant_id}/${agent_id} — expected 1 (tenant/agent context does not match the ` +
          `target memory; the review would have been silently lost, leaving it stuck in ` +
          `needs_review and hidden from the prompt while reported as reclassified)`,
      );
    }
  },

  async listNeedsReview(limit = 100): Promise<MemoryEntry[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(memory_entry)
      .where(
        and(
          eq(memory_entry.tenant_id, tenant_id),
          eq(memory_entry.agent_id, agent_id),
          eq(memory_entry.needs_review, true),
        ),
      )
      .limit(limit);
  },
};

export const behavioralHintRepo = {
  async create(
    input: Omit<
      BehavioralHint,
      | 'id'
      | 'created_at'
      | 'tenant_id'
      | 'agent_id'
      // P10a: lifecycle columns + updated_at have DB defaults — callers
      // don't supply them.
      | 'updated_at'
      | 'lifecycle_status'
      | 'evidence_count'
      | 'confidence'
      | 'lifecycle_transitions'
      | 'last_recall_at'
    >,
  ): Promise<BehavioralHint> {
    const guarded = applyTenantGuard(input);
    const [row] = await db.insert(behavioral_hint).values(guarded).returning();
    return row!;
  },

  async findActiveForScope(opts: {
    scope_type: string;
    subject_id?: string | null;
  }): Promise<BehavioralHint[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const now = new Date();
    const conds = [
      eq(behavioral_hint.tenant_id, tenant_id),
      eq(behavioral_hint.agent_id, agent_id),
      eq(behavioral_hint.scope_type, opts.scope_type),
      isNull(behavioral_hint.revoked_at),
      // P10a (review #104 critical): hints proposed via propose_hint
      // start in pending_review / ephemeral. The LLM-facing path must
      // include only visible states so a pending hint never steers
      // behavior before a human approves it.
      inArray(behavioral_hint.lifecycle_status, [
        'ephemeral',
        'observed',
        'reinforced',
        'verified',
        'active',
      ]),
    ];
    if (opts.subject_id) conds.push(eq(behavioral_hint.subject_id, opts.subject_id));
    return db
      .select()
      .from(behavioral_hint)
      .where(
        and(
          ...conds,
          or(isNull(behavioral_hint.expires_at), gt(behavioral_hint.expires_at, now)),
        ),
      );
  },

  async revoke(id: string): Promise<void> {
    // Flip-readiness (#323, H4 of #355) — tenant+agent scope the WHERE (bound
    // from ALS), mirroring the already-scoped `findActiveForScope`. Both columns
    // are NOT NULL (schema `behavioral_hint`). This method has NO live caller in
    // `src` today (it is part of the repo's governance surface for revoking a
    // hint by id); because it now READS ALS, any FUTURE caller MUST run inside
    // `runWithTenantContext` (an unwrapped caller throws MissingTenantContextError
    // — the intended fail-closed contract for a tenant-owned write).
    //
    // FAIL-LOUD (throw on !=1): revoking a hint sets `revoked_at`, removing it
    // from every LLM-facing read (`findActiveForScope` filters `revoked_at IS
    // NULL`). A revoke targets one specific, operator-/caller-identified hint id;
    // a 0-row result under the new predicate means that id is NOT owned by the
    // running tenant/agent — a cross-tenant revoke attempt that must be surfaced,
    // not silently swallowed (which would report a sensitive hint as revoked
    // while it stayed live for its real owner). Same `.returning({id})` +
    // `.length` idiom as `mensagensRepo.markProcessed`.
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const updated = await db
      .update(behavioral_hint)
      .set({ revoked_at: new Date() })
      .where(
        and(
          eq(behavioral_hint.id, id),
          eq(behavioral_hint.tenant_id, tenant_id),
          eq(behavioral_hint.agent_id, agent_id),
        ),
      )
      .returning({ id: behavioral_hint.id });
    if (updated.length !== 1) {
      throw new Error(
        `behavioralHintRepo.revoke matched ${updated.length} rows for hint ${id} ` +
          `under ${tenant_id}/${agent_id} — expected 1 (tenant/agent context does not match the ` +
          `target hint; the revoke would have been silently lost while the hint stayed live for ` +
          `its real owner)`,
      );
    }
  },
};

export const capabilitiesDomainRepo = {
  async findByDomain(domain: string): Promise<AgentCapabilityDomain | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(agent_capabilities_domain)
      .where(
        and(
          eq(agent_capabilities_domain.tenant_id, tenant_id),
          eq(agent_capabilities_domain.agent_id, agent_id),
          eq(agent_capabilities_domain.domain, domain),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async upsertConfidence(
    domain: string,
    updates: Partial<AgentCapabilityDomain>,
  ): Promise<void> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    // Try update first
    const existing = await capabilitiesDomainRepo.findByDomain(domain);
    if (existing) {
      await db
        .update(agent_capabilities_domain)
        .set({ ...updates, updated_at: new Date() })
        .where(eq(agent_capabilities_domain.id, existing.id));
    } else {
      await db.insert(agent_capabilities_domain).values({
        tenant_id,
        agent_id,
        domain,
        ...updates,
      } as typeof agent_capabilities_domain.$inferInsert);
    }
  },

  async listAll(): Promise<AgentCapabilityDomain[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(agent_capabilities_domain)
      .where(
        and(
          eq(agent_capabilities_domain.tenant_id, tenant_id),
          eq(agent_capabilities_domain.agent_id, agent_id),
        ),
      );
  },
};

export const capabilitiesSkillRepo = {
  async findBySkill(domain: string, skill_name: string): Promise<AgentCapabilitySkill | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(agent_capabilities_skill)
      .where(
        and(
          eq(agent_capabilities_skill.tenant_id, tenant_id),
          eq(agent_capabilities_skill.agent_id, agent_id),
          eq(agent_capabilities_skill.domain, domain),
          eq(agent_capabilities_skill.skill_name, skill_name),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async upsertConfidence(
    domain: string,
    skill_name: string,
    updates: Partial<AgentCapabilitySkill>,
  ): Promise<void> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const existing = await capabilitiesSkillRepo.findBySkill(domain, skill_name);
    if (existing) {
      await db
        .update(agent_capabilities_skill)
        .set({ ...updates, updated_at: new Date() })
        .where(eq(agent_capabilities_skill.id, existing.id));
    } else {
      await db.insert(agent_capabilities_skill).values({
        tenant_id,
        agent_id,
        domain,
        skill_name,
        ...updates,
      } as typeof agent_capabilities_skill.$inferInsert);
    }
  },

  async listByDomain(domain: string): Promise<AgentCapabilitySkill[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(agent_capabilities_skill)
      .where(
        and(
          eq(agent_capabilities_skill.tenant_id, tenant_id),
          eq(agent_capabilities_skill.agent_id, agent_id),
          eq(agent_capabilities_skill.domain, domain),
        ),
      );
  },

  async listAll(): Promise<AgentCapabilitySkill[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(agent_capabilities_skill)
      .where(
        and(
          eq(agent_capabilities_skill.tenant_id, tenant_id),
          eq(agent_capabilities_skill.agent_id, agent_id),
        ),
      );
  },
};

export const capabilityGapsRepo = {
  async upsert(input: {
    capability_description: string;
    tipo: 'tool' | 'knowledge' | 'procedure';
    contexto?: string;
    source_candidate_id?: string;
  }): Promise<AgentCapabilityGap> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    // Simple match by description (LIKE or exact); P3+ pode usar embedding similarity
    const existing = await db
      .select()
      .from(agent_capability_gaps)
      .where(
        and(
          eq(agent_capability_gaps.tenant_id, tenant_id),
          eq(agent_capability_gaps.agent_id, agent_id),
          eq(agent_capability_gaps.capability_description, input.capability_description),
        ),
      )
      .limit(1);

    if (existing[0]) {
      // Defense in depth (#370): scope the UPDATE by tenant + agent, not by id
      // alone — mirroring updateLevel below. The id matched the tenant-scoped
      // SELECT above, but a colliding/stale id across tenants must never let this
      // bump another tenant's row ("id is not an isolation boundary"; #367/#368).
      await db
        .update(agent_capability_gaps)
        .set({
          frequency_score: existing[0].frequency_score + 1,
          last_observed: new Date(),
        })
        .where(
          and(
            eq(agent_capability_gaps.id, existing[0].id),
            eq(agent_capability_gaps.tenant_id, tenant_id),
            eq(agent_capability_gaps.agent_id, agent_id),
          ),
        );
      return existing[0];
    }

    const [created] = await db
      .insert(agent_capability_gaps)
      .values({
        tenant_id,
        agent_id,
        capability_description: input.capability_description,
        tipo: input.tipo,
        contexto: input.contexto ?? null,
        source_candidate_id: input.source_candidate_id ?? null,
      } as typeof agent_capability_gaps.$inferInsert)
      .returning();
    return created!;
  },

  async listByLevel(level: string): Promise<AgentCapabilityGap[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(agent_capability_gaps)
      .where(
        and(
          eq(agent_capability_gaps.tenant_id, tenant_id),
          eq(agent_capability_gaps.agent_id, agent_id),
          eq(agent_capability_gaps.current_level, level),
        ),
      );
  },

  // P5: extensions ------------------------------------------------------------
  // listByLevels: plural variant for the escalation engine that needs to load
  // every gap in a set of current levels (e.g. ['silent', 'dashboard']) in one
  // query before running level-transition rules.
  async listByLevels(levels: GapLevel[]): Promise<AgentCapabilityGap[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    if (levels.length === 0) return [];
    return db
      .select()
      .from(agent_capability_gaps)
      .where(
        and(
          eq(agent_capability_gaps.tenant_id, tenant_id),
          eq(agent_capability_gaps.agent_id, agent_id),
          inArray(agent_capability_gaps.current_level, levels),
        ),
      );
  },

  // P5: updateLevel — typed-args level setter scoped by the current
  // tenant/agent context (defense in depth: even with a leaked id from
  // another tenant, the WHERE clause filters it out). Sets
  // last_level_change_at = now() which the cooldown logic depends on.
  async updateLevel(args: { id: string; new_level: GapLevel }): Promise<void> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    await db
      .update(agent_capability_gaps)
      .set({ current_level: args.new_level, last_level_change_at: new Date() })
      .where(
        and(
          eq(agent_capability_gaps.id, args.id),
          eq(agent_capability_gaps.tenant_id, tenant_id),
          eq(agent_capability_gaps.agent_id, agent_id),
        ),
      );
  },

  // P5: daysSinceLastProposed — tenant/agent-wide MAX(last_level_change_at)
  // where current_level='proposed'. Used by the escalation engine to enforce
  // cooldown_days_proposed_to_proposed: do not raise another gap to 'proposed'
  // if the last one happened recently. Returns null if no gap was ever
  // promoted to 'proposed' for this (tenant, agent).
  async daysSinceLastProposed(): Promise<number | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const result = await db.execute<{ days: number | null }>(sql`
      SELECT EXTRACT(DAY FROM (now() - MAX(last_level_change_at)))::int AS days
        FROM agent_capability_gaps
       WHERE tenant_id = ${tenant_id}
         AND agent_id = ${agent_id}
         AND current_level = 'proposed'
    `);
    const first = result.rows[0];
    if (!first) return null;
    return first.days ?? null;
  },

  // P5: create — straight insert via applyTenantGuard (no de-dup by
  // description like upsert does). Used by call-sites that already know
  // the gap is new — typically the dialogical-acquisition engine creating
  // technical_gap rows derived from a failed capability_test_result, where
  // grouping by description would be incorrect.
  async create(input: {
    capability_description: string;
    tipo: string;
    contexto?: string;
  }): Promise<AgentCapabilityGap> {
    const guarded = applyTenantGuard({
      capability_description: input.capability_description,
      tipo: input.tipo,
      contexto: input.contexto ?? null,
    });
    const [row] = await db
      .insert(agent_capability_gaps)
      .values(guarded as typeof agent_capability_gaps.$inferInsert)
      .returning();
    return row!;
  },
};

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
/**
 * P8d §10 — Write-path validation para `profile_body`.
 *
 * Aplicada antes de qualquer INSERT em `agent_operational_profile_versions`.
 * Garante que cognitive_limits estão dentro do range esperado e que cada
 * `LearnedVoiceModifier` casa o schema Zod.
 *
 * P9b enforça `cognitive_limits` em runtime do SkillRunner; P8d só fecha a
 * porta na DB (defesa em depth).
 */
function validateProfileBodyP8d(body: ProfileBody): void {
  const identity = (body as { identity?: Record<string, unknown> }).identity;
  if (!identity) return;

  const cl = identity.cognitive_limits as
    | { max_inference_depth?: unknown; max_speculation_in_response?: unknown; confidence_floor_for_action?: unknown }
    | undefined;
  if (cl) {
    // Aceita 0 (semente inicial pode não ter calibrado ainda) mas rejeita
    // valores negativos/fora-range tipados.
    if (typeof cl.max_inference_depth !== 'number' ||
        cl.max_inference_depth < 0 || cl.max_inference_depth > 10) {
      throw new Error('cognitive_limits.max_inference_depth out of range [0,10]');
    }
    if (typeof cl.max_speculation_in_response !== 'number' ||
        cl.max_speculation_in_response < 0 || cl.max_speculation_in_response > 1) {
      throw new Error('cognitive_limits.max_speculation_in_response out of range [0,1]');
    }
    if (typeof cl.confidence_floor_for_action !== 'number' ||
        cl.confidence_floor_for_action < 0 || cl.confidence_floor_for_action > 1) {
      throw new Error('cognitive_limits.confidence_floor_for_action out of range [0,1]');
    }
  }

  const mods = identity.learned_voice_modifiers;
  if (Array.isArray(mods)) {
    for (const m of mods) {
      // Throws ZodError com path detalhado se inválido.
      LearnedVoiceModifierSchema.parse(m);
    }
  }
}

/**
 * Extract the proposal's expected predecessor active id from `profile_body`.
 *
 * The Admin UI `updateProfile` flow populates `metadata.previous_version_id`
 * with the active version id observed at the time the proposal was authored.
 * `approveAndActivateAtomic` compares this against the freshly-locked
 * incumbent active id to detect write-skew (two stale proposals racing).
 *
 * Returns:
 *   - `string`     — explicit predecessor id from the proposal body
 *   - `null`       — explicit "no predecessor expected" (e.g., seed v1)
 *   - `'unknown'`  — `metadata.previous_version_id` is absent entirely. The
 *                    proposal predates this codepath; the caller's policy
 *                    decides whether to reject conservatively or accept.
 */
function readExpectedPredecessor(profile_body: unknown): string | null | 'unknown' {
  const md = (profile_body as { metadata?: Record<string, unknown> } | null)?.metadata;
  if (!md || !('previous_version_id' in md)) return 'unknown';
  const v = md.previous_version_id;
  if (v === null) return null;
  if (typeof v === 'string') return v;
  // Some other JSON type (number, boolean, object) — treat as legacy.
  return 'unknown';
}

/**
 * Detect whether a profile_body was backfilled by migration 061 (or any
 * other migration that stamps `metadata.migrated_from_legacy = true`).
 *
 * Codex Adversarial Review of PR #171 round 3 ([high] #173) — migration 061
 * writes `metadata.previous_version_id = null` (explicit) for every legacy
 * row backfilled from the four `core_immutable`/`operational_profile`/...
 * columns. Without a discriminator, `approveAndActivateAtomic`'s
 * predecessor check would accept that explicit `null` as "no predecessor
 * expected" (the same shape used for intentional seed v1) and a stale
 * migrated proposal could silently activate against an empty active slot.
 *
 * The migration stamps `metadata.migrated_from_legacy = true` alongside the
 * null predecessor; this helper exposes that marker to the approval path so
 * it can reject the ambiguous case (explicit null predecessor whose lineage
 * is actually unknown, NOT an intentional seed) with a distinct typed
 * sentinel.
 */
function isMigratedLegacy(profile_body: unknown): boolean {
  const md = (profile_body as { metadata?: Record<string, unknown> } | null)?.metadata;
  if (!md) return false;
  return md.migrated_from_legacy === true;
}

/**
 * Take a `FOR UPDATE` lock on the parent `agents` row for a given
 * `(tenant_id, agent_id)`. Held until the surrounding `withTx` commits.
 *
 * Returns `true` if the row exists (and is now locked), `false` if the
 * agent was deleted (or never existed) — caller decides whether that is a
 * typed-miss (`agent_missing: true`) or an error condition.
 *
 * Codex Adversarial Review of PR #171 round 3 ([medium]) — the parent-agent
 * lock target was previously only acquired by `acquireNextVersionForAgent`
 * (i.e. only by version allocators). `approveAndActivateAtomic` did NOT
 * take this lock, so a concurrent `seedNewActiveAtomic` (priorities
 * migration) and `approveAndActivateAtomic` could race on the active-row
 * freeze/insert: the partial unique index on (tenant, agent) WHERE
 * status='active' would roll one tx back, surfacing as a 500 instead of a
 * serialized update. Extracting the lock primitive into its own helper
 * lets every writer that touches active state share the same lock target.
 *
 * @param tx        the in-tx drizzle handle (caller MUST already be inside `withTx`)
 * @param tenant_id tenant slug — part of the lock predicate
 * @param agent_id  agent id (PK) — locked with FOR UPDATE
 */
async function lockParentAgent(
  tx: typeof db,
  tenant_id: string,
  agent_id: string,
): Promise<boolean> {
  const lock = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agent_id), eq(agents.tenant_id, tenant_id)))
    .for('update')
    .limit(1);
  return lock.length > 0;
}

/**
 * Shared per-agent version allocator for `agent_operational_profile_versions`.
 *
 * Codex Adversarial Review of PR #171 round 2 (issue #166 follow-up) — three
 * different writers allocate `version` via `MAX(version)+1`:
 *   - `operationalProfileVersionsRepo.create`        (proposal-generator)
 *   - `operationalProfileVersionsRepo.proposeAndAuditAtomic` (Admin UI)
 *   - `operationalProfileVersionsRepo.seedNewActiveAtomic`   (migration script)
 *
 * Until this helper, each writer chose its own lock strategy (none, agent row,
 * or active row), so a *mixed-allocator* race between e.g. an Admin UI propose
 * and the priorities migration could still read the same `MAX(version)` and
 * collide on `agent_op_profile_version_uq`.
 *
 * This helper centralizes the lock target on the parent `agents` row by PK +
 * tenant. All version allocators MUST go through it. The lock is held until
 * the surrounding tx commits/rollbacks, so subsequent `INSERT` lands behind
 * the same lock and the unique-index collision is impossible.
 *
 * Returns `null` if the parent agent was deleted (or never existed) — callers
 * translate that into their own typed-miss sentinel (`agent_missing: true`,
 * NOT_FOUND, etc.). Throws nothing of its own — surfacing as a Postgres error
 * only on lock acquisition failures (deadlock, statement_timeout).
 *
 * @param tx        the in-tx drizzle handle (caller must already be inside `withTx`)
 * @param tenant_id tenant slug — tested in both the lock predicate and MAX scope
 * @param agent_id  agent id (PK) — locked with FOR UPDATE
 */
async function acquireNextVersionForAgent(
  tx: typeof db,
  tenant_id: string,
  agent_id: string,
): Promise<number | null> {
  // (1) Lock the parent agent row via the shared `lockParentAgent` helper.
  //     PK + tenant_id avoids accidentally locking a same-id agent under a
  //     different tenant — defense-in-depth even though `agents.id` is
  //     globally unique today, because the schema contract is "id is unique
  //     per tenant". Sharing this primitive with `approveAndActivateAtomic`
  //     (Codex round 3) ensures every writer that touches active state OR
  //     allocates a version serializes on the same lock target.
  const locked = await lockParentAgent(tx, tenant_id, agent_id);
  if (!locked) return null;

  // (2) Read MAX(version) BEHIND the lock so concurrent allocators serialize.
  const maxRes = await tx.execute<{ max: number | null }>(sql`
    SELECT MAX(version) AS max
      FROM agent_operational_profile_versions
     WHERE tenant_id = ${tenant_id}
       AND agent_id = ${agent_id}
  `);
  const max = maxRes.rows[0]?.max ?? null;
  return max == null ? 1 : Number(max) + 1;
}

export const operationalProfileVersionsRepo = {
  async create(input: {
    profile_body: ProfileBody;
    proposed_by: string;
    proposed_reason?: string;
  }): Promise<AgentOperationalProfileVersion> {
    // P8d §10 — write-path validation: rejeita cognitive_limits fora de range
    // e modifiers malformados. Defesa em depth contra inserts "tortos" via
    // qualquer caller (proposal-generator, migration script, Admin UI).
    validateProfileBodyP8d(input.profile_body);

    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();

    // Codex Adversarial Review of PR #171 round 2 (issue #166) — version
    // allocation now goes through the shared `acquireNextVersionForAgent`
    // helper, which locks the parent agent row before reading MAX(version).
    // This serializes against the OTHER allocators (`proposeAndAuditAtomic`,
    // `seedNewActiveAtomic`), closing the mixed-allocator race where two
    // different writers for the same (tenant, agent) could both read the
    // same MAX and collide on `agent_op_profile_version_uq`. Wrapping the
    // insert in `withTx` keeps the lock held across the INSERT so a third
    // writer cannot squeeze in between MAX and INSERT.
    return withTx(async (tx) => {
      const version = await acquireNextVersionForAgent(tx, tenant_id, agent_id);
      if (version == null) {
        throw new Error(
          `operationalProfileVersionsRepo.create: parent agent ${agent_id} ` +
            `not found in tenant ${tenant_id}`,
        );
      }
      const guarded = applyTenantGuard({
        version,
        status: 'proposed',
        profile_body: input.profile_body,
        proposed_by: input.proposed_by,
        proposed_reason: input.proposed_reason ?? null,
      });
      const [row] = await tx
        .insert(agent_operational_profile_versions)
        .values(guarded)
        .returning();
      return row!;
    });
  },

  async getActive(): Promise<AgentOperationalProfileVersion | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(agent_operational_profile_versions)
      .where(
        and(
          eq(agent_operational_profile_versions.tenant_id, tenant_id),
          eq(agent_operational_profile_versions.agent_id, agent_id),
          eq(agent_operational_profile_versions.status, 'active'),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async getById(id: string): Promise<AgentOperationalProfileVersion | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(agent_operational_profile_versions)
      .where(
        and(
          eq(agent_operational_profile_versions.tenant_id, tenant_id),
          eq(agent_operational_profile_versions.agent_id, agent_id),
          eq(agent_operational_profile_versions.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async listByStatus(status: ProfileStatus): Promise<AgentOperationalProfileVersion[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(agent_operational_profile_versions)
      .where(
        and(
          eq(agent_operational_profile_versions.tenant_id, tenant_id),
          eq(agent_operational_profile_versions.agent_id, agent_id),
          eq(agent_operational_profile_versions.status, status),
        ),
      )
      .orderBy(desc(agent_operational_profile_versions.version));
  },

  // Validated state-machine transition. Retorna typed result, sem throw.
  // - not_found:           id desconhecido
  // - terminal:            row já está rolled_back (terminal)
  // - invalid_transition:  destino não permitido a partir do source, same-state,
  //                        OR source status changed concurrently between read
  //                        and write (status predicate guard fired)
  // - already_has_active:  to:'active' mas outra row ativa existe para (tenant,agent)
  // - stale:               caller passed `expected_from` and the row's status
  //                        changed between caller's pre-lock read and our
  //                        post-lock re-read (concurrent writer won the lock
  //                        first and committed a transition the caller never
  //                        saw). Returned with `actual` so the caller can
  //                        decide whether to retry against the new state.
  //
  // Codex Adversarial Review of PR #171 round 4 (issue #177) — until that
  // refactor, `transition` was the LAST writer of
  // `agent_operational_profile_versions` that bypassed the parent-agent
  // `FOR UPDATE` lock established by `acquireNextVersionForAgent` /
  // `lockParentAgent`. The drift decision engine calls this method to
  // freeze/rollback the active profile when a drift severity threshold is
  // crossed, and the priorities seed script calls `seedNewActiveAtomic`
  // (which DOES take the lock) on the same `(tenant, agent)` slot. The
  // documented race was: seed reads active A → drift `transition` rolls A
  // back/frozen → seed re-writes A as `frozen` using only `id/tenant/agent`
  // → silently undoes `rolled_back` (the terminal state per the doccomment).
  //
  // Round 4 fix was twofold:
  //   (a) Wrap the whole transition in `withTx` and acquire `lockParentAgent`
  //       as the FIRST step. Every other writer of this table now goes
  //       through the same lock target (`approveAndActivateAtomic`,
  //       `proposeAndAuditAtomic`, `seedNewActiveAtomic`, and
  //       `operationalProfileVersionsRepo.create`), so concurrent writers
  //       serialize on `agents(id)` regardless of which transition shape
  //       they perform.
  //   (b) Add a `status = <from>` predicate to the UPDATE itself + check
  //       `returning().length === 1`. Belt-and-suspenders for the case where
  //       another writer somehow holds the row in a different lock domain
  //       (or future codepath bypasses the parent lock): if the source
  //       status changed concurrently, the UPDATE matches zero rows and we
  //       surface `invalid_transition` (the source predicate the caller
  //       asked about no longer holds) instead of silently overwriting it.
  //
  // Codex Adversarial Review of PR #182 round 1 (issue #177 follow-up) —
  // the parent lock + status-predicate guard prevent the silent overwrite,
  // but they did NOT prevent a different fail-open: if `seedNewActiveAtomic`
  // wins the lock first (freezing the old active A and seeding a new active
  // B), a waiting drift `transition({to:'rolled_back'})` caller wakes up,
  // re-reads A as `frozen`, the state machine still permits `frozen →
  // rolled_back`, so the UPDATE succeeds and `transition` returns `ok:true`.
  // The decision engine then marks the rollback as APPLIED even though the
  // newly-seeded version B remains `active` — the rollback was NOT applied
  // to the currently-active row. Critical rollback fails open with false
  // success.
  //
  // Fix: a typed `expected_from` parameter. Callers that have a snapshot
  // expectation of the source state (drift engine: `active`; priorities
  // seed promotion: `proposed`) MUST pass it; after the parent lock + row
  // re-read, if the row's status no longer matches, we surface
  // `{ok:false, reason:'stale', expected_from, actual}` so the caller can
  // observe the race explicitly and decide (retry against the new active,
  // log+skip, etc) instead of silently completing the wrong write.
  //
  // The parameter is OPTIONAL for backwards-compat with sequential callers
  // (unit tests, single-threaded admin scripts) that genuinely do not have
  // a snapshot expectation. Concurrent callers MUST pass it — see the
  // `decision-engine.ts` and `proposal-generator.ts` usages for examples.
  async transition(args: {
    id: string;
    to: ProfileStatus;
    /**
     * The status the caller saw when they decided to transition. After we
     * take the parent-agent lock and re-read the row, if the status changed
     * (a concurrent writer landed first), we return `{ok:false,
     * reason:'stale'}` instead of applying the transition from a state the
     * caller never saw. REQUIRED for concurrent callers (drift engine,
     * priorities seed, any background worker). Optional only for
     * sequential single-writer callers (unit tests, admin scripts running
     * with no concurrent traffic) where the snapshot expectation is
     * implicitly satisfied.
     */
    expected_from?: ProfileStatus;
    approved_by?: string;
    rollback_reason?: string;
  }): Promise<
    | { ok: true; updated: AgentOperationalProfileVersion }
    | { ok: false; reason: 'not_found' | 'invalid_transition' | 'already_has_active' | 'terminal' }
    | { ok: false; reason: 'stale'; expected_from: ProfileStatus; actual: ProfileStatus }
  > {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();

    return await withTx(async (tx) => {
      // (0) Lock the parent `agents` row FIRST so we serialize against every
      //     OTHER writer that touches `(tenant, agent)` profile state
      //     (`approveAndActivateAtomic`, `proposeAndAuditAtomic`,
      //     `seedNewActiveAtomic`, `operationalProfileVersionsRepo.create`).
      //     Round 4 (#177): closes the seed-vs-drift `transition` race.
      const agentLocked = await lockParentAgent(tx, tenant_id, agent_id);
      if (!agentLocked) {
        // Agent was deleted between caller's read and this lock. Treat as
        // not_found to preserve the existing contract.
        return { ok: false as const, reason: 'not_found' as const };
      }

      // (1) Re-read the target row INSIDE the tx + behind the parent lock so
      //     post-lock state drives the validation. `for('update')` on the row
      //     itself is defense-in-depth (a future codepath that bypasses
      //     `lockParentAgent` but still does row-level locks would still
      //     serialize with us).
      const rows = await tx
        .select()
        .from(agent_operational_profile_versions)
        .where(
          and(
            eq(agent_operational_profile_versions.id, args.id),
            eq(agent_operational_profile_versions.tenant_id, tenant_id),
            eq(agent_operational_profile_versions.agent_id, agent_id),
          ),
        )
        .for('update')
        .limit(1);
      const row = rows[0];
      if (!row) return { ok: false as const, reason: 'not_found' as const };

      const from = row.status as ProfileStatus;

      // (1.5) Codex Adversarial Review of PR #182 round 1 fail-open guard:
      //       if the caller passed an `expected_from`, enforce that the
      //       row is STILL in that state under our lock. If a concurrent
      //       writer (e.g. seedNewActiveAtomic, approveAndActivateAtomic)
      //       transitioned the row to a different state while we waited
      //       for the lock, we surface `stale` so the caller can react
      //       explicitly rather than silently completing a write against
      //       a state they never observed.
      if (args.expected_from !== undefined && from !== args.expected_from) {
        return {
          ok: false as const,
          reason: 'stale' as const,
          expected_from: args.expected_from,
          actual: from,
        };
      }

      if (from === 'rolled_back') return { ok: false as const, reason: 'terminal' as const };
      if (from === args.to) return { ok: false as const, reason: 'invalid_transition' as const };

      const allowed: Record<string, readonly string[]> = {
        proposed: ['active', 'frozen', 'rolled_back'],
        active: ['frozen', 'rolled_back'],
        frozen: ['active', 'rolled_back'],
      };
      if (!allowed[from]?.includes(args.to)) {
        return { ok: false as const, reason: 'invalid_transition' as const };
      }

      if (args.to === 'active') {
        // Re-read inside the tx + behind the parent lock so a concurrent
        // approve/seed that landed before we acquired the lock is visible.
        const activeRows = await tx
          .select()
          .from(agent_operational_profile_versions)
          .where(
            and(
              eq(agent_operational_profile_versions.tenant_id, tenant_id),
              eq(agent_operational_profile_versions.agent_id, agent_id),
              eq(agent_operational_profile_versions.status, 'active'),
            ),
          )
          .limit(1);
        const active = activeRows[0];
        if (active && active.id !== row.id) {
          return { ok: false as const, reason: 'already_has_active' as const };
        }
      }

      const now = new Date();
      const patch: Record<string, unknown> = { status: args.to };
      if (args.to === 'active') {
        // approved_at é definido na primeira vez que se aprova; re-ativações
        // a partir de frozen preservam o approved_at original.
        if (!row.approved_at) {
          patch.approved_at = now;
          if (args.approved_by) patch.approved_by = args.approved_by;
        }
        patch.activated_at = now;
      } else if (args.to === 'frozen') {
        patch.frozen_at = now;
      } else if (args.to === 'rolled_back') {
        patch.rolled_back_at = now;
        patch.rollback_reason = args.rollback_reason ?? null;
      }

      // [P86-C3] tenant-scoped write predicate: even though the SELECT above
      // already filtered by tenant_id/agent_id, the actual UPDATE must
      // include them in WHERE as defense-in-depth (an alert UUID alone is
      // not enough authorization to mutate identity in a different tenant
      // context). This is the inviolable tenant isolation invariant.
      //
      // Round 4 (#177): also include `status = from` in the WHERE so a
      // concurrent state change (under READ COMMITTED a snapshot inversion
      // is theoretically possible even with FOR UPDATE if a future writer
      // bypasses the parent lock) cannot be silently overwritten. If the
      // status changed between our locked re-read and the UPDATE, the
      // UPDATE matches zero rows and we surface `invalid_transition` —
      // the source predicate the caller asked about no longer holds.
      const updated = await tx
        .update(agent_operational_profile_versions)
        .set(patch as Partial<typeof agent_operational_profile_versions.$inferInsert>)
        .where(
          and(
            eq(agent_operational_profile_versions.id, args.id),
            eq(agent_operational_profile_versions.tenant_id, tenant_id),
            eq(agent_operational_profile_versions.agent_id, agent_id),
            eq(agent_operational_profile_versions.status, from),
          ),
        )
        .returning();
      if (updated.length === 0) {
        // Status changed concurrently between our locked re-read and this
        // UPDATE — surface as invalid_transition (the source predicate the
        // caller asked about no longer holds). Caller can re-read and decide
        // whether to retry the transition from the new source state.
        return { ok: false as const, reason: 'invalid_transition' as const };
      }
      return { ok: true as const, updated: updated[0]! };
    });
  },

  /**
   * Atomic escalation: if `target_profile_id` is STILL `frozen` and no other
   * row holds the active slot under the same lock, transition it to
   * `rolled_back`. Used by the drift decision engine when an `active →
   * rolled_back` rollback was demoted to `stale + actual='frozen'` by a
   * concurrent `alto` invocation that froze the target first.
   *
   * Codex Adversarial Review of PR #196 round 2 (issue #177 follow-up) — the
   * round-1 fix split the escalation into TWO steps:
   *   1. `getActiveContextForAgent()` — reads the active-slot occupant
   *      OUTSIDE any lock (regular `db.select` with no `FOR UPDATE`).
   *   2. `transition({to:'rolled_back', expected_from:'frozen'})` — opens a
   *      fresh tx, acquires `lockParentAgent`, re-reads the target row.
   *
   * Between steps 1 and 2 the snapshot of the active slot is **released**, so
   * any concurrent writer with the parent lock can land a new state:
   *
   *   - `seedNewActiveAtomic` can promote a brand-new v2 to `active` between
   *     the refetch (which saw `null`) and the retry — the retry then sees
   *     target still `frozen`, transitions it to `rolled_back`, and reports
   *     `applied: true` even though v2 is now the agent's live contract
   *     surface (rollback was applied to the wrong row).
   *
   *   - The state machine permits `frozen → active` (e.g. an operator
   *     re-activates the frozen row via the Admin UI). If the row is
   *     re-activated between the refetch and the retry, the retry's
   *     `expected_from='frozen'` guard surfaces stale, but the original
   *     observation that "no replacement exists" was already wrong — the
   *     row IS the replacement.
   *
   * Fix: collapse both reads into ONE transaction held under
   * `lockParentAgent`. Inside the tx we re-read the target row FOR UPDATE,
   * re-read the active slot FOR UPDATE, and then commit the rollback ONLY
   * if both predicates still hold (target is still `frozen` AND no other
   * row holds the active slot). Every TOCTOU window is closed under the
   * same lock that every other writer of this table uses.
   *
   * Five typed outcomes, all rejected at the source so the caller decides
   * the right log/audit shape:
   *
   *   - `ok: true` — atomically transitioned `frozen → rolled_back`. The
   *     engine logs `drift.rollback.escalated` and reports applied.
   *
   *   - `replaced` — a different row holds the active slot. The seed (or
   *     equivalent writer) won between the engine's pre-lock observation and
   *     this tx. The original target is no longer the contract surface, so
   *     the rollback would be meaningless. Engine skips with
   *     `drift.skip.active_replaced`.
   *
   *   - `reactivated` — the target row itself transitioned `frozen → active`
   *     between the engine's stale observation and this tx (operator
   *     re-activate, future codepath, etc). The engine refuses to roll back
   *     a row that's back in service; skips with `drift.skip.reactivated`.
   *
   *   - `terminal_state` — the target reached a non-frozen non-active state
   *     (e.g. another worker already escalated to `rolled_back`). The
   *     desired terminal is achieved (or close); engine logs
   *     `drift.skip.terminal_state`.
   *
   *   - `target_missing` — the target row was deleted between the engine's
   *     observation and this tx. Extreme race; engine logs as warning.
   *
   * Inputs are explicit (tenant_id, agent_id, target_profile_id) — no
   * AsyncLocalStorage dependency — so this method is callable from any
   * worker context (including ones that haven't `runWithTenantContext`-
   * wrapped their call).
   */
  async escalateRollbackIfStillFrozen(args: {
    tenant_id: string;
    agent_id: string;
    target_profile_id: string;
    approved_by?: string;
    rollback_reason?: string;
  }): Promise<
    | { ok: true; target_profile_id: string; rolled_back_at: Date }
    | { ok: false; reason: 'replaced'; current_active_profile_id: string }
    | { ok: false; reason: 'reactivated' }
    | { ok: false; reason: 'terminal_state'; actual_status: ProfileStatus }
    | { ok: false; reason: 'target_missing' }
    | { ok: false; reason: 'agent_missing' }
  > {
    return await withTx(async (tx) => {
      // (1) Lock the parent agent row FIRST — same lock target as
      //     `transition`, `approveAndActivateAtomic`, `proposeAndAuditAtomic`,
      //     `seedNewActiveAtomic`, and `acquireNextVersionForAgent`. This
      //     serializes us against every writer that could change the active
      //     slot OR the target row's status between our reads and the UPDATE.
      const agentLocked = await lockParentAgent(tx, args.tenant_id, args.agent_id);
      if (!agentLocked) {
        return { ok: false as const, reason: 'agent_missing' as const };
      }

      // (2) Re-read the target row INSIDE the tx + behind the parent lock,
      //     FOR UPDATE. Status may have changed since the engine's
      //     observation; we drive the decision from the post-lock value.
      const targetRows = await tx
        .select({
          id: agent_operational_profile_versions.id,
          status: agent_operational_profile_versions.status,
        })
        .from(agent_operational_profile_versions)
        .where(
          and(
            eq(agent_operational_profile_versions.id, args.target_profile_id),
            eq(agent_operational_profile_versions.tenant_id, args.tenant_id),
            eq(agent_operational_profile_versions.agent_id, args.agent_id),
          ),
        )
        .for('update')
        .limit(1);
      const target = targetRows[0];
      if (!target) {
        return { ok: false as const, reason: 'target_missing' as const };
      }

      const targetStatus = target.status as ProfileStatus;

      // The target was already re-activated (frozen → active is a legal
      // edge). The engine's observation that "no replacement exists" was
      // wrong — this row IS the replacement. Refuse to roll back; the
      // operator/next-cycle re-evaluation will see the live row.
      if (targetStatus === 'active') {
        return { ok: false as const, reason: 'reactivated' as const };
      }

      // Anything other than `frozen` is a terminal/non-recoverable state for
      // our escalation contract (we never escalate from `proposed` or
      // `rolled_back`). Surface the actual status so the caller can log it.
      if (targetStatus !== 'frozen') {
        return {
          ok: false as const,
          reason: 'terminal_state' as const,
          actual_status: targetStatus,
        };
      }

      // (3) Re-read the active slot INSIDE the tx + behind the parent lock,
      //     FOR UPDATE. If a different row holds the slot, the seed (or
      //     equivalent) committed a replacement between the engine's
      //     observation and this tx — we must NOT roll back the original
      //     target because it's no longer the contract surface.
      const activeRows = await tx
        .select({ id: agent_operational_profile_versions.id })
        .from(agent_operational_profile_versions)
        .where(
          and(
            eq(agent_operational_profile_versions.tenant_id, args.tenant_id),
            eq(agent_operational_profile_versions.agent_id, args.agent_id),
            eq(agent_operational_profile_versions.status, 'active'),
          ),
        )
        .for('update')
        .limit(1);
      const active = activeRows[0];
      if (active) {
        // Defensive: a `frozen` target should never share the active slot,
        // but if it somehow did (status==='frozen' AND active row has the
        // same id — impossible under the unique partial index but cheap to
        // guard), treat it as reactivated rather than replaced.
        if (active.id === args.target_profile_id) {
          return { ok: false as const, reason: 'reactivated' as const };
        }
        return {
          ok: false as const,
          reason: 'replaced' as const,
          current_active_profile_id: active.id,
        };
      }

      // (4) All predicates still hold under the lock — target is frozen
      //     AND no replacement exists. Atomically roll it back. The status
      //     predicate in the WHERE clause is belt-and-suspenders: if a
      //     future codepath ever bypassed this lock, the UPDATE would match
      //     zero rows and we'd still surface a typed miss.
      const now = new Date();
      const updated = await tx
        .update(agent_operational_profile_versions)
        .set({
          status: 'rolled_back',
          rolled_back_at: now,
          rollback_reason: args.rollback_reason ?? null,
        })
        .where(
          and(
            eq(agent_operational_profile_versions.id, args.target_profile_id),
            eq(agent_operational_profile_versions.tenant_id, args.tenant_id),
            eq(agent_operational_profile_versions.agent_id, args.agent_id),
            eq(agent_operational_profile_versions.status, 'frozen'),
          ),
        )
        .returning({ id: agent_operational_profile_versions.id });

      if (updated.length === 0) {
        // Should be unreachable: we hold the parent lock AND a row-level
        // FOR UPDATE on the target, so its status cannot change between our
        // read and this UPDATE. If it somehow did (future codepath that
        // bypasses both locks), surface as terminal_state so the caller
        // doesn't double-process.
        return {
          ok: false as const,
          reason: 'terminal_state' as const,
          actual_status: targetStatus,
        };
      }

      return {
        ok: true as const,
        target_profile_id: args.target_profile_id,
        rolled_back_at: now,
      };
    });
  },

  /**
   * Atomic "propose new version + admin audit" — both writes inside a single
   * transaction so a partial commit cannot leave a profile_version row with
   * no audit record of who proposed it (forensics gap).
   *
   * Codex review of PR #162 round 3 (issue #166) — same class of multi-write
   * atomicity gap that `approveAndActivateAtomic` solved for approve. The
   * proposal stays in `status='proposed'`; only `approveAndActivateAtomic`
   * activates it (P8.5 invariant — no profile activates without approval).
   *
   * Codex Adversarial Review of PR #171 (issue #166 follow-up) — even with
   * MAX(version)+1 computed inside the tx, two concurrent `updateProfile`
   * calls for the same (tenant, agent) under READ COMMITTED can both read
   * the same `max` and both attempt to insert `max+1`, colliding on the
   * `(tenant_id, agent_id, version)` unique index. The router translates
   * that DB error into an unhelpful 500 with no retry. Fix: lock the parent
   * `agents` row with `SELECT ... FOR UPDATE` BEFORE reading MAX. This
   * serializes version allocation per-agent (different agents don't
   * contend) and matches the `.for('update')` pattern already used in
   * `approveAndActivateAtomic`. We chose row-lock over `pg_advisory_xact_lock`
   * because the row lock is naturally scoped, debuggable via `pg_locks`,
   * and consistent with the rest of this repo.
   *
   * Codex Adversarial Review of PR #171 round 2 — version allocation moved
   * to the shared `acquireNextVersionForAgent` helper so this method, the
   * priorities-migration `seedNewActiveAtomic`, and `create` ALL serialize
   * on the same parent-agent FOR UPDATE lock. Mixed-allocator race closed.
   *
   * Required input is explicit (no AsyncLocalStorage dependency) so the
   * router can call it without `runWithTenantContext`. The previous active
   * id is captured by the caller (router) BEFORE this call because the
   * read is part of the same logical operation but doesn't need tx
   * isolation — concurrent updateProfile + approveProfile races are guarded
   * by `approveAndActivateAtomic`'s FOR UPDATE on the active row.
   *
   * Returns `null` if the agent was deleted between the caller's
   * `findById` check and this call — the router translates that into
   * NOT_FOUND. Otherwise the proposal commits atomically with the audit
   * row.
   */
  async proposeAndAuditAtomic(args: {
    tenant_id: string;
    agent_id: string;
    profile_body: ProfileBody;
    proposed_by: string;
    proposed_reason: string;
    /** Captured by caller from getActive() before opening the tx. */
    previous_active_id: string | null;
    actor_id: string;
    actor_role: string;
  }): Promise<
    | {
        version: AgentOperationalProfileVersion;
        previous_version_id: string | null;
      }
    | { agent_missing: true }
  > {
    // Validate before opening the tx so a malformed body fails fast without
    // touching the DB.
    validateProfileBodyP8d(args.profile_body);

    return await withTx(async (tx) => {
      // (1) Allocate next version via the shared helper, which (a) locks the
      //     parent agent row FOR UPDATE and (b) reads MAX(version) behind
      //     that lock. The lock is held until tx commit so the subsequent
      //     INSERT lands behind it, eliminating both same-allocator and
      //     mixed-allocator races (Codex round 2 #166: other writers like
      //     `seedNewActiveAtomic` and `operationalProfileVersionsRepo.create`
      //     now use the same helper).
      const nextV = await acquireNextVersionForAgent(tx, args.tenant_id, args.agent_id);
      if (nextV == null) {
        // Agent was deleted between the router's findById and this tx.
        // Surface a typed sentinel so the caller can translate to NOT_FOUND
        // instead of leaking a half-applied transaction or generic 500.
        return { agent_missing: true as const };
      }

      // (2) Insert the proposed row.
      const [version] = await tx
        .insert(agent_operational_profile_versions)
        .values({
          tenant_id: args.tenant_id,
          agent_id: args.agent_id,
          version: nextV,
          status: 'proposed',
          profile_body: args.profile_body,
          proposed_by: args.proposed_by,
          proposed_reason: args.proposed_reason,
        })
        .returning();
      if (!version) {
        throw new Error('propose_atomic_insert_failed: returning() empty');
      }

      // (3) Audit in the SAME tx. If this fails, the profile_version insert
      //     rolls back and there's no orphaned proposal.
      await tx.insert(admin_audit_log).values({
        tenant_id: args.tenant_id,
        actor_id: args.actor_id,
        actor_role: args.actor_role,
        action: 'agent_profile_propose',
        resource_type: 'agent_operational_profile_version',
        resource_id: version.id,
        change_summary: {
          agent_id: args.agent_id,
          previous_version_id: args.previous_active_id,
          new_version: version.version,
          status: version.status,
          proposed_reason: args.proposed_reason,
        },
      });

      return {
        version,
        previous_version_id: args.previous_active_id,
      };
    });
  },

  /**
   * Atomic "proposed → active" approval with auto-freeze of the incumbent
   * active version, plus admin_audit_log append — all inside a single
   * transaction so a partial commit cannot leave the agent with no active
   * profile OR with an unaudited governance change.
   *
   * Codex review of PR #162 round 2 ([high] x2) — addresses both:
   *   - "Profile approval can activate runtime state without an audit trail":
   *     mutation + audit commit together.
   *   - "Freeze incumbent profiles before approving replacements": when an
   *     active version already exists, this method freezes it in the same tx
   *     before activating the new one. (`transition({to:'active'})` alone
   *     fails with already_has_active.)
   *
   * Codex Adversarial Review of PR #171 round 2 ([high] #1) — adds predecessor
   * enforcement. The router's `updateProfile` reads the active version OUTSIDE
   * the proposal tx and chains its id into `profile_body.metadata.previous_version_id`
   * (the "expected predecessor"). If a *different* proposal gets approved
   * between that read and this approval, the active row id no longer matches
   * the predecessor — approving would silently overwrite the newer version
   * with stale content while the audit lineage still points at the original
   * predecessor (write-skew).
   *
   * Mitigation: inside this tx, after locking BOTH the proposed row AND the
   * incumbent active row FOR UPDATE, compare the proposed's expected
   * predecessor against the freshly-locked incumbent. If they diverge,
   * reject with `predecessor_conflict` so the caller can refresh + re-propose.
   *
   * Codex Adversarial Review of PR #171 round 3 ([medium]) — the parent-agent
   * `FOR UPDATE` lock is now the FIRST thing this tx takes, BEFORE reading
   * the proposed or active rows. This closes the cross-allocator race where
   * a concurrent `seedNewActiveAtomic` (priorities migration) could freeze
   * and insert a new active row between this tx's active read and freeze,
   * surfacing as a partial-unique-index conflict / 500 instead of a
   * serialized update. Every writer that touches active state OR allocates
   * a version now shares the same lock target via `lockParentAgent`.
   *
   * Codex Adversarial Review of PR #171 round 3 ([high] #173) — explicit
   * `null` predecessor is now context-sensitive:
   *
   *   - **Intentional seed (no incumbent + version === 1)**: ACCEPT. This is
   *     the first activation of a freshly-created agent; there's nothing for
   *     a predecessor to point at. Matches the router's `create → approve`
   *     flow (`createWithSeedAndAudit` inserts a `proposed` v1 with
   *     `previous_version_id: null` and the owner immediately approves it).
   *
   *   - **Migrated legacy (any version, `metadata.migrated_from_legacy === true`)**:
   *     REJECT with `migrated_legacy_proposal`. Migration 061 stamps every
   *     backfilled row with `previous_version_id: null` + the
   *     `migrated_from_legacy` marker because the original lineage is
   *     unknowable from the legacy four-column shape. Accepting these would
   *     let a stale migrated proposal silently activate against an empty
   *     active slot (#173 finding).
   *
   *   - **`previous_version_id` key absent entirely**: REJECT with
   *     `predecessor_conflict` (`expected: 'unknown'`). Same conservative
   *     policy as round 2 — worst case is silent overwrite of a newer
   *     approved version.
   *
   * Codex Adversarial Review of PR #182 round 3 ([high] #186) — explicit
   * `null` predecessor on a non-seed proposal is now REJECTED outright with
   * the new `missing_predecessor` typed reason:
   *
   *   - **v2+ with `null` predecessor, no incumbent active**: REJECT. The
   *     round-2 policy structurally accepted `null === null` here, so an
   *     agent with `frozen`/`rolled_back` versions but no active row could
   *     approve a v2+ proposal with no lineage anchor — bypassing the
   *     stale-predecessor guard and reactivating profile state after
   *     rollback without binding to the last known version. Recovery from
   *     this state must go through an explicit recovery flow that binds the
   *     new proposal to the last frozen/rolled_back row, not through the
   *     normal approve path.
   *
   *   - **v1 with an incumbent active**: REJECT. A genuine v1 cannot
   *     coexist with an active incumbent (the version allocator wouldn't
   *     have produced v1 in that state). Treat as missing_predecessor
   *     rather than predecessor_conflict so the operator sees the right
   *     diagnosis.
   *
   *   - **v2+ with explicit `null` predecessor against a non-null
   *     incumbent**: still rejected — now via `missing_predecessor` (was
   *     `predecessor_conflict` in round 2). The dangerous shape is the
   *     same; the new reason name better describes the cause.
   *
   * Required input is explicit (no AsyncLocalStorage dependency) so the
   * router can call it without `runWithTenantContext`.
   */
  async approveAndActivateAtomic(args: {
    tenant_id: string;
    agent_id: string;
    /** ID of the `proposed` version being approved. */
    id: string;
    actor_id: string;
    actor_role: string;
    comment: string;
  }): Promise<
    | {
        ok: true;
        activated: { id: string; version: number };
        frozen_previous: { id: string; version: number } | null;
      }
    | {
        ok: false;
        reason:
          | 'not_found'
          | 'invalid_source_status'
          | 'transition_failed'
          | 'agent_missing';
      }
    | {
        ok: false;
        reason: 'predecessor_conflict';
        /** What the proposal expected the incumbent active id to be. */
        expected: string | null | 'unknown';
        /** What the incumbent active id actually is right now (post-lock). */
        current: string | null;
      }
    | {
        ok: false;
        reason: 'migrated_legacy_proposal';
        /** Always `null` for this case — migration 061 backfills explicit null. */
        expected: null;
        /** What the incumbent active id actually is right now (post-lock). */
        current: string | null;
      }
    | {
        ok: false;
        reason: 'missing_predecessor';
        /** The proposal's declared version — useful for the operator message. */
        proposed_version: number;
        /** What the incumbent active id actually is right now (post-lock). */
        current_predecessor: string | null;
      }
  > {
    return await withTx(async (tx) => {
      // (0) Lock the parent agent row FIRST. This serializes against EVERY
      // other writer that touches `(tenant, agent)` operational profile
      // state — `proposeAndAuditAtomic`, `seedNewActiveAtomic`, and
      // `operationalProfileVersionsRepo.create` all go through
      // `lockParentAgent` (directly or via `acquireNextVersionForAgent`).
      // Without this lock, a concurrent `seedNewActiveAtomic` could freeze
      // and insert a new active row between our read and freeze, causing
      // the partial unique index on (tenant, agent) WHERE status='active'
      // to reject one tx as a 500 instead of a serialized update
      // (Codex round 3 [medium]).
      const agentLocked = await lockParentAgent(tx, args.tenant_id, args.agent_id);
      if (!agentLocked) {
        // The agent was deleted between the router's findById check and
        // this lock acquisition. Surface a typed-miss so the caller can
        // translate to NOT_FOUND (same outcome as the upfront check) and
        // we don't leak a half-applied transaction.
        return { ok: false as const, reason: 'agent_missing' as const };
      }

      // (1) Lock the proposed row inside the tx so concurrent approvers
      // serialize on it.
      const proposedRows = await tx
        .select()
        .from(agent_operational_profile_versions)
        .where(
          and(
            eq(agent_operational_profile_versions.id, args.id),
            eq(agent_operational_profile_versions.tenant_id, args.tenant_id),
            eq(agent_operational_profile_versions.agent_id, args.agent_id),
          ),
        )
        .for('update')
        .limit(1);
      const proposed = proposedRows[0];
      if (!proposed) return { ok: false as const, reason: 'not_found' as const };
      if (proposed.status !== 'proposed') {
        return { ok: false as const, reason: 'invalid_source_status' as const };
      }

      // (2) Lock the current active (if any). Note: the parent-agent lock
      // already serializes every writer, so this row lock is defense-in-
      // depth (catches any future codepath that bypasses the parent lock
      // and only touches the active row directly).
      const activeRows = await tx
        .select()
        .from(agent_operational_profile_versions)
        .where(
          and(
            eq(agent_operational_profile_versions.tenant_id, args.tenant_id),
            eq(agent_operational_profile_versions.agent_id, args.agent_id),
            eq(agent_operational_profile_versions.status, 'active'),
          ),
        )
        .for('update')
        .limit(1);
      const incumbent = activeRows[0] ?? null;

      // (2b) Predecessor enforcement — Codex round 2 [high] #1 + round 3
      // [high] #173.
      // The proposal was built against a specific incumbent id (recorded in
      // profile_body.metadata.previous_version_id). If the current incumbent
      // (re-read post-lock) doesn't match, a different proposal won the
      // race — approving this one would silently drop that newer version's
      // changes while the audit lineage still pointed at the old
      // predecessor. Reject so the caller can refresh + re-propose.
      const expectedPredecessor = readExpectedPredecessor(proposed.profile_body);
      const currentPredecessor = incumbent?.id ?? null;
      if (expectedPredecessor === 'unknown') {
        // Legacy proposal authored before this codepath — see policy in
        // the doccomment above. Refuse rather than risk silent overwrite.
        return {
          ok: false as const,
          reason: 'predecessor_conflict' as const,
          expected: 'unknown' as const,
          current: currentPredecessor,
        };
      }

      // Round 3 [high] #173: explicit `null` predecessor needs context.
      // Migration 061 backfills `null` + `migrated_from_legacy: true` for
      // every legacy row whose original lineage is unknowable. Without this
      // discriminator, a stale migrated proposal could silently activate
      // against an empty active slot (the (no incumbent + null predecessor)
      // pair is indistinguishable from intentional seed v1). Reject migrated
      // proposals with a distinct sentinel so the operator must re-propose
      // under the new flow.
      if (expectedPredecessor === null && isMigratedLegacy(proposed.profile_body)) {
        return {
          ok: false as const,
          reason: 'migrated_legacy_proposal' as const,
          expected: null,
          current: currentPredecessor,
        };
      }

      // Round 3 [high] #173: intentional-seed exception. Explicit `null`
      // predecessor is legitimate when (a) there's no incumbent active row
      // AND (b) this is version 1 — the first activation of a freshly-
      // created agent (`createWithSeedAndAudit` → owner approves the seed).
      const isIntentionalSeed =
        expectedPredecessor === null && currentPredecessor === null && proposed.version === 1;

      // Codex Adversarial Review of PR #182 round 3 ([high] #186): explicit
      // `null` predecessor on any non-seed proposal must be rejected.
      // Without this gate, an agent with `frozen`/`rolled_back` versions but
      // no active row (e.g. post-rollback recovery window) could approve a
      // v2+ proposal whose `previous_version_id` is `null` — the structural
      // `null === null` equality would pass and the new active row would
      // appear with no lineage anchor at all, silently bypassing the
      // stale-predecessor guard that round 2/3 introduced.
      //
      // The four explicit cases we now distinguish:
      //   - v1 + no incumbent + null pred       → ACCEPT (intentional seed, handled above)
      //   - v1 + incumbent present + null pred  → REJECT as missing_predecessor
      //       (a v1 cannot coexist with an active row — the version allocator
      //       would never produce v1 in that state)
      //   - v2+ + no incumbent + null pred      → REJECT as missing_predecessor
      //       (recovery requires explicit lineage to the last frozen/rolled_back row)
      //   - v2+ + incumbent + null pred         → REJECT as missing_predecessor
      //       (round 2 already caught this as predecessor_conflict; the new
      //       reason name better describes the cause)
      if (!isIntentionalSeed && expectedPredecessor === null) {
        return {
          ok: false as const,
          reason: 'missing_predecessor' as const,
          proposed_version: proposed.version,
          current_predecessor: currentPredecessor,
        };
      }

      if (!isIntentionalSeed && expectedPredecessor !== currentPredecessor) {
        return {
          ok: false as const,
          reason: 'predecessor_conflict' as const,
          expected: expectedPredecessor,
          current: currentPredecessor,
        };
      }

      const now = new Date();

      // (3) Freeze incumbent if it exists. proposed-version row itself can't
      // be its own incumbent (we already asserted proposed.status==='proposed'
      // != 'active'), so the WHERE id != proposed.id is defensive.
      if (incumbent) {
        const frozen = await tx
          .update(agent_operational_profile_versions)
          .set({ status: 'frozen', frozen_at: now })
          .where(eq(agent_operational_profile_versions.id, incumbent.id))
          .returning({ id: agent_operational_profile_versions.id });
        if (frozen.length === 0) {
          return { ok: false as const, reason: 'transition_failed' as const };
        }
      }

      // (4) Activate the proposed.
      const activated = await tx
        .update(agent_operational_profile_versions)
        .set({
          status: 'active',
          approved_at: proposed.approved_at ?? now,
          approved_by: proposed.approved_by ?? args.actor_id,
          activated_at: now,
        })
        .where(eq(agent_operational_profile_versions.id, args.id))
        .returning({ id: agent_operational_profile_versions.id });
      if (activated.length === 0) {
        return { ok: false as const, reason: 'transition_failed' as const };
      }

      // (5) Audit in the SAME tx. If this insert fails, EVERYTHING rolls back
      // and the incumbent stays active — no unaudited governance change.
      await tx.insert(admin_audit_log).values({
        tenant_id: args.tenant_id,
        actor_id: args.actor_id,
        actor_role: args.actor_role,
        action: 'agent_profile_approve',
        resource_type: 'agent_operational_profile_version',
        resource_id: args.id,
        change_summary: {
          agent_id: args.agent_id,
          new_version_id: args.id,
          new_version: proposed.version,
          previous_active_id: incumbent?.id ?? null,
          previous_active_version: incumbent?.version ?? null,
          // Codex round 2: record the predecessor expectation declared by
          // the proposal so forensics can prove this approval did NOT win
          // a write-skew race (expected == current at lock time).
          expected_predecessor_id: expectedPredecessor,
          comment: args.comment,
        },
      });

      return {
        ok: true as const,
        activated: { id: proposed.id, version: proposed.version },
        frozen_previous: incumbent
          ? { id: incumbent.id, version: incumbent.version }
          : null,
      };
    });
  },

  // Próxima version sequencial para (tenant_id, agent_id) corrente.
  // MAX(version) + 1, ou 1 quando não existe versão ainda.
  async nextVersion(): Promise<number> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const result = await db.execute<{ max: number | null }>(sql`
      SELECT MAX(version) AS max
        FROM agent_operational_profile_versions
       WHERE tenant_id = ${tenant_id}
         AND agent_id = ${agent_id}
    `);
    const max = result.rows[0]?.max ?? null;
    return max == null ? 1 : Number(max) + 1;
  },

  // Review #100 fix: atomic create-frozen-active in one transaction with
  // FOR UPDATE locking. Used by data migration scripts (P8d priorities) to
  // avoid the create→freeze→activate window where a crash leaves the agent
  // with no active profile.
  //
  // Codex Adversarial Review of PR #171 round 2 (issue #166) — the lock
  // target moved from the active-row tuple to the parent `agents` row via
  // `acquireNextVersionForAgent`. Locking the active row only serializes
  // concurrent seeds against EACH OTHER; it does NOT block a concurrent
  // `proposeAndAuditAtomic` (which only has a proposed insert, not an active
  // freeze) from also reading MAX(version) and colliding on
  // `agent_op_profile_version_uq`. By harmonizing on the parent-agent lock,
  // every writer for the same (tenant, agent) now serializes regardless of
  // status.
  //
  // We STILL re-read the current active row inside the tx (after the agent
  // lock) to (a) keep the freeze→activate semantics intact and (b) honor
  // `expected_current_active_id` for the stale-read guard.
  //
  // Codex Adversarial Review of PR #190 (issue #195, [high]) — the
  // doccomment that previously said "we no longer need to lock this row
  // separately — the parent agent lock above already serializes every
  // writer" was DEFENSE-IN-DEPTH FALSE. `lockParentAgent` locks the
  // `agents` row, not the profile_versions row. Under READ COMMITTED a
  // concurrent writer that holds the v1 row lock — e.g. an out-of-band
  // SQL repair, a future codepath that drops `lockParentAgent`, or
  // (theoretically) `operationalProfileVersionsRepo.transition` running
  // in a tx whose lock ordering interleaves with our snapshot read —
  // can commit a `status` change to v1 between the snapshot SELECT here
  // and the freeze UPDATE below. Without `FOR UPDATE` on the read AND a
  // `status='active'` predicate on the freeze, the seed would silently
  // overwrite a just-rolled-back v1 back to `frozen`, undoing a drift
  // rollback and reporting success.
  //
  // Strategy A from the issue (preferred): keep `lockParentAgent` as the
  // primary serialization point, AND restore `FOR UPDATE` on the active-row
  // read here (so we hold a real row lock through the freeze window), AND
  // add `status='active'` to the freeze UPDATE WHERE so the DB itself
  // refuses to overwrite a row whose status changed under us regardless
  // of which locks any writer holds. Either guard alone would close the
  // lost-write window; both together make the invariant explicit at the
  // SQL level for any future reviewer.
  //
  // Semantics:
  //   - Locks the parent agent row FOR UPDATE so EVERY allocator of
  //     `agent_operational_profile_versions.version` for this (tenant, agent)
  //     serializes here.
  //   - Locks the current active profile-version row FOR UPDATE so the
  //     freeze window is held under a row-level lock (defense-in-depth
  //     against any writer that bypasses `lockParentAgent`).
  //   - Verifies tenant scope on both the lock and the inserts.
  //   - On any error inside the closure, the transaction rolls back —
  //     the old active row stays active.
  //   - Throws (instead of returning result) so callers can wrap in
  //     try/catch and count failures distinctly.
  async seedNewActiveAtomic(input: {
    profile_body: ProfileBody;
    proposed_by: string;
    proposed_reason?: string;
    /**
     * Expected current active id; if mismatch, throws — protects against
     * the caller having read stale data outside the tx.
     *
     * Codex PR #202 [HIGH]: REQUIRED for non-initial seeds (any seed where
     * prior versions exist for this agent). The seed throws
     * `seed_atomic_missing_predecessor_expectation` when omitted on a
     * non-initial allocation. Initial seeds (`nextV === 1`, no prior
     * versions) accept an absent expectation.
     */
    expected_current_active_id?: string;
  }): Promise<{
    new_active: AgentOperationalProfileVersion;
    frozen_previous: AgentOperationalProfileVersion | null;
  }> {
    // Validate before opening the transaction so we fail fast without
    // touching the DB on a malformed body.
    validateProfileBodyP8d(input.profile_body);

    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();

    return withTx(async (tx) => {
      // 1) Allocate next version via the shared helper. This (a) takes the
      //    parent agent FOR UPDATE lock and (b) reads MAX(version) behind
      //    it. Throws on missing agent — historically this method was
      //    invoked only by migration scripts that pre-verified the agent
      //    exists, so a missing agent here is a real programmer error.
      const nextV = await acquireNextVersionForAgent(tx, tenant_id, agent_id);
      if (nextV == null) {
        throw new Error(
          `seed_atomic_missing_agent: ${tenant_id}/${agent_id} not found before lock`,
        );
      }

      // 2) Re-read the current active row INSIDE the tx so the stale-read
      //    guard (`expected_current_active_id`) sees post-lock state.
      //
      //    Issue #195: this read is now `FOR UPDATE`. The parent-agent lock
      //    already serializes every writer that goes through
      //    `lockParentAgent` / `acquireNextVersionForAgent`, but it does
      //    NOT block a writer that holds a row-level lock on this
      //    profile_versions row in a different lock domain (out-of-band
      //    SQL, future refactor, edge-case `transition` interleaving).
      //    Re-acquiring `FOR UPDATE` here turns the snapshot read into a
      //    hard row lock that's held through the freeze UPDATE below,
      //    closing the lost-write window even when callers race in ways
      //    `lockParentAgent` alone can't serialize.
      const activeRows = await tx
        .select()
        .from(agent_operational_profile_versions)
        .where(
          and(
            eq(agent_operational_profile_versions.tenant_id, tenant_id),
            eq(agent_operational_profile_versions.agent_id, agent_id),
            eq(agent_operational_profile_versions.status, 'active'),
          ),
        )
        .for('update')
        .limit(1);
      const currentActive = activeRows[0] ?? null;

      // Codex Adversarial Review of PR #202 (issue #195 follow-up, [HIGH]) —
      // closed lost-write window for the "rolled-back-before-lock" path.
      //
      // After the `FOR UPDATE` re-read above, a row whose status was
      // concurrently flipped to a non-active value (e.g. `rolled_back` by
      // the drift engine, `frozen` by another writer) disappears from the
      // `status='active'` result set. Pre-#202, when the caller omitted
      // `expected_current_active_id`, this code:
      //
      //   1. Saw `currentActive == null` (the rolled-back row is no
      //      longer 'active').
      //   2. Skipped the freeze step entirely (no active row to freeze).
      //   3. Inserted a brand-new `status='active'` row, immediately
      //      re-enabling runtime profile state — defeating the rollback's
      //      intent (the decision engine wanted the agent OFF, not
      //      OFF-then-ON-with-a-new-row).
      //
      // The single production caller (`scripts/p8d-migration-priorities.ts`)
      // already passes `expected_current_active_id` because it has read
      // `getActive()` first. There is no legitimate production code path
      // today that creates a non-initial active version without first
      // observing the predecessor. Make that contract explicit:
      //
      //   - `nextV === 1` (no prior versions for this agent) is the
      //     legitimate "initial seed" case — there is no predecessor to be
      //     stale against, so omitting `expected_current_active_id` is OK.
      //   - `nextV > 1` (prior versions exist) means the caller is
      //     re-seeding an agent whose history is non-empty. The caller
      //     MUST declare which active row they expect to supersede,
      //     because that is the ONLY way to detect "the predecessor was
      //     rolled back under us between my `getActive()` and this lock".
      //     Omitting the expectation throws and the tx rolls back —
      //     no silent re-activation post-rollback.
      //
      // Future intentional "no-active recovery seed" (e.g. operator
      // creating a fresh active after every prior version was rolled back
      // manually) should add an explicit `allow_no_predecessor: true`
      // input. Today no caller needs that path; surface it as a typed
      // error so any future addition has to opt in deliberately.
      if (nextV > 1 && !input.expected_current_active_id) {
        throw new Error(
          'seed_atomic_missing_predecessor_expectation: ' +
            `non-initial seed (nextV=${nextV}) requires expected_current_active_id ` +
            'to detect concurrent rollback/freeze of the predecessor',
        );
      }

      if (
        input.expected_current_active_id &&
        currentActive?.id !== input.expected_current_active_id
      ) {
        throw new Error(
          `seed_atomic_stale_active: expected ${input.expected_current_active_id}, found ${currentActive?.id ?? 'none'}`,
        );
      }

      const now = new Date();

      // 3) Freeze the previous active row FIRST so the partial unique index
      //    on (tenant, agent) WHERE status='active' is satisfied before the
      //    new insert lands. Otherwise both rows would compete for activeness.
      //
      //    Issue #195: `status = 'active'` is now in the WHERE clause as
      //    defense-in-depth. Under READ COMMITTED, if a concurrent writer
      //    committed a status change between our snapshot (step 2) and this
      //    UPDATE, EvalPlanQual re-evaluates the predicate against the new
      //    committed row — `status != 'active'` matches zero rows and we
      //    throw `seed_atomic_freeze_failed`, rolling the seed tx back
      //    rather than silently undoing the concurrent state change (e.g.
      //    a drift `transition({to:'rolled_back'})` win). With the
      //    `FOR UPDATE` lock in step 2 this path is the unreachable
      //    defense-in-depth tier; without it, this predicate alone still
      //    closes the lost-write window.
      let frozenPrevious: AgentOperationalProfileVersion | null = null;
      if (currentActive) {
        const [updated] = await tx
          .update(agent_operational_profile_versions)
          .set({ status: 'frozen', frozen_at: now })
          .where(
            and(
              eq(agent_operational_profile_versions.id, currentActive.id),
              eq(agent_operational_profile_versions.tenant_id, tenant_id),
              eq(agent_operational_profile_versions.agent_id, agent_id),
              eq(agent_operational_profile_versions.status, 'active'),
            ),
          )
          .returning();
        if (!updated) {
          // Either the row vanished (rare; agent deletion under the parent
          // lock is impossible) or — issue #195 — a concurrent writer
          // changed `status` out from under us between the FOR UPDATE
          // snapshot and this UPDATE. Surface as `seed_atomic_freeze_failed`
          // so the seed tx rolls back and the caller observes the race
          // rather than silently overwriting a non-active row.
          throw new Error(
            'seed_atomic_freeze_failed: previous active row vanished or status changed mid-tx',
          );
        }
        frozenPrevious = updated;
      }

      // 4) Insert the new row directly as `active`. The partial unique index
      //    rejects if another active row sneaks in between the freeze above
      //    and this insert — that forces tx rollback and the caller retries.
      const guarded = applyTenantGuard({
        version: nextV,
        status: 'active',
        profile_body: input.profile_body,
        proposed_by: input.proposed_by,
        proposed_reason: input.proposed_reason ?? null,
        approved_by: input.proposed_by,
        approved_at: now,
        activated_at: now,
      });
      const [inserted] = await tx
        .insert(agent_operational_profile_versions)
        .values(guarded)
        .returning();
      if (!inserted) {
        throw new Error('seed_atomic_insert_failed: returning() empty');
      }

      return { new_active: inserted, frozen_previous: frozenPrevious };
    });
  },
};

// P4: agent_drift_alerts — audit das execuções do drift detector.
// Cada alert = 1 evento (drift_type, severity, decision) + evidência + audit
// trail (decided_by, resolved_by, resolution_note). FK opcional para
// agent_operational_profile_versions porque drifts podem ser detectados antes
// de uma nova versão de perfil ser proposta.
export const driftAlertsRepo = {
  async create(input: {
    profile_version_id?: string;
    drift_type: DriftType;
    severity: DriftSeverity;
    evidence: unknown;
    detected_by: string;
    decision: DriftDecision;
    decided_by: string;
  }): Promise<AgentDriftAlert> {
    const guarded = applyTenantGuard({
      profile_version_id: input.profile_version_id ?? null,
      drift_type: input.drift_type,
      severity: input.severity,
      evidence: input.evidence as object,
      detected_by: input.detected_by,
      decision: input.decision,
      decided_by: input.decided_by,
    });
    const [row] = await db
      .insert(agent_drift_alerts)
      .values(guarded as typeof agent_drift_alerts.$inferInsert)
      .returning();
    return row!;
  },

  async listUnresolved(): Promise<AgentDriftAlert[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(agent_drift_alerts)
      .where(
        and(
          eq(agent_drift_alerts.tenant_id, tenant_id),
          eq(agent_drift_alerts.agent_id, agent_id),
          isNull(agent_drift_alerts.resolved_at),
        ),
      )
      .orderBy(desc(agent_drift_alerts.created_at));
  },

  async listByProfileVersion(profile_version_id: string): Promise<AgentDriftAlert[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(agent_drift_alerts)
      .where(
        and(
          eq(agent_drift_alerts.tenant_id, tenant_id),
          eq(agent_drift_alerts.agent_id, agent_id),
          eq(agent_drift_alerts.profile_version_id, profile_version_id),
        ),
      )
      .orderBy(desc(agent_drift_alerts.created_at));
  },

  // [P86-C3] tenant-scoped: includes tenant_id AND agent_id predicates in
  // the UPDATE so an alert UUID from another tenant cannot be resolved from
  // the wrong context. Returns { ok, found } so callers can detect a
  // forbidden/missing target without silently no-op'ing.
  async resolve(args: {
    id: string;
    resolution_note: string;
    resolved_by: string;
  }): Promise<{ ok: boolean; found: boolean }> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const updated = await db
      .update(agent_drift_alerts)
      .set({
        resolution_note: args.resolution_note,
        resolved_at: new Date(),
        resolved_by: args.resolved_by,
      })
      .where(
        and(
          eq(agent_drift_alerts.id, args.id),
          eq(agent_drift_alerts.tenant_id, tenant_id),
          eq(agent_drift_alerts.agent_id, agent_id),
        ),
      )
      .returning({ id: agent_drift_alerts.id });
    return { ok: updated.length > 0, found: updated.length > 0 };
  },
};

// P5: gap_escalation_rules — thresholds determinísticos por (tenant_id, agent_id)
// para a escalation chain (silent → dashboard → mentionable → proposed).
// Defaults vivem no schema; este repo expõe getForCurrentAgent (null se nenhuma
// regra customizada) e upsert (ON CONFLICT via UNIQUE(tenant_id, agent_id)).
export const gapEscalationRulesRepo = {
  async getForCurrentAgent(): Promise<GapEscalationRule | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(gap_escalation_rules)
      .where(
        and(
          eq(gap_escalation_rules.tenant_id, tenant_id),
          eq(gap_escalation_rules.agent_id, agent_id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async upsert(input: Partial<NewGapEscalationRule>): Promise<GapEscalationRule> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    // Strip any tenant/agent the caller might have supplied — applyTenantGuard
    // semantics: context wins, mismatch throws.
    const { tenant_id: inTenant, agent_id: inAgent, ...rest } = input;
    if (inTenant && inTenant !== tenant_id) {
      throw new Error(`tenant mismatch: input ${inTenant} vs context ${tenant_id}`);
    }
    if (inAgent && inAgent !== agent_id) {
      throw new Error(`agent mismatch: input ${inAgent} vs context ${agent_id}`);
    }
    const now = new Date();
    const [row] = await db
      .insert(gap_escalation_rules)
      .values({
        ...rest,
        tenant_id,
        agent_id,
        updated_at: now,
      } as typeof gap_escalation_rules.$inferInsert)
      .onConflictDoUpdate({
        target: [gap_escalation_rules.tenant_id, gap_escalation_rules.agent_id],
        set: {
          ...rest,
          updated_at: now,
        },
      })
      .returning();
    return row!;
  },
};

// P5: capability_proposals — propostas formais de capability (spec gerada por
// LLM no nível 'proposed'). Fluxo de status:
//   draft → submitted → approved | rejected
//   approved → delivered
//   rejected | delivered = terminal
// transition() é typed-result (sem throw): { ok:true, updated } | { ok:false,
// reason: 'not_found' | 'invalid_transition' }. Cada transição seta um
// timestamp (submitted_at | decided_at | delivered_at) + campos opcionais
// (decided_by, decision_reason, delivery_artifact_ref).
// P9a — extended capability_type set (migration 044). 'skill' enables
// the P9a Skill Registry to flow proposals through the same approval inbox;
// 'soul_bias' / 'policy_rule' / 'holiday' antecipam P8e/P9b/scheduling sem
// ativar uso até o respectivo phase.
export type CapabilityProposalType =
  | 'tool'
  | 'knowledge'
  | 'procedure'
  | 'integration'
  | 'other'
  | 'skill'
  | 'soul_bias'
  | 'policy_rule'
  | 'holiday';

export const capabilityProposalsRepo = {
  async create(input: {
    gap_id?: string;
    capability_type: CapabilityProposalType;
    title: string;
    description: string;
    proposed_spec: unknown;
    motivation: string;
    expected_impact?: string;
    test_scenarios: unknown[];
  }): Promise<CapabilityProposal> {
    const guarded = applyTenantGuard({
      gap_id: input.gap_id ?? null,
      capability_type: input.capability_type,
      title: input.title,
      description: input.description,
      proposed_spec: input.proposed_spec as object,
      motivation: input.motivation,
      expected_impact: input.expected_impact ?? null,
      test_scenarios: input.test_scenarios as unknown as object,
    });
    const [row] = await db
      .insert(capability_proposals)
      .values(guarded as typeof capability_proposals.$inferInsert)
      .returning();
    return row!;
  },

  // PR #87 follow-up — transactional variant of create. Writes via the
  // caller-supplied `tx` handle so the INSERT participates in an outer
  // withTx block. Pairs with capabilityGapsRepo.updateLevelTx so the
  // gap-escalation worker can commit the proposal artifact and the gap
  // level flip in a single transaction; transient failure during the
  // gap UPDATE rolls back the proposal INSERT so the next worker tick
  // does NOT produce a duplicate proposal row.
  async createTx(
    tx: typeof db,
    input: {
      gap_id?: string;
      capability_type: CapabilityProposalType;
      title: string;
      description: string;
      proposed_spec: unknown;
      motivation: string;
      expected_impact?: string;
      test_scenarios: unknown[];
    },
  ): Promise<CapabilityProposal> {
    const guarded = applyTenantGuard({
      gap_id: input.gap_id ?? null,
      capability_type: input.capability_type,
      title: input.title,
      description: input.description,
      proposed_spec: input.proposed_spec as object,
      motivation: input.motivation,
      expected_impact: input.expected_impact ?? null,
      test_scenarios: input.test_scenarios as unknown as object,
    });
    const [row] = await tx
      .insert(capability_proposals)
      .values(guarded as typeof capability_proposals.$inferInsert)
      .returning();
    return row!;
  },

  async getById(id: string): Promise<CapabilityProposal | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(capability_proposals)
      .where(
        and(
          eq(capability_proposals.tenant_id, tenant_id),
          eq(capability_proposals.agent_id, agent_id),
          eq(capability_proposals.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async listByStatus(status: ProposalStatus): Promise<CapabilityProposal[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(capability_proposals)
      .where(
        and(
          eq(capability_proposals.tenant_id, tenant_id),
          eq(capability_proposals.agent_id, agent_id),
          eq(capability_proposals.status, status),
        ),
      )
      .orderBy(desc(capability_proposals.created_at));
  },

  async listByGap(gap_id: string): Promise<CapabilityProposal[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(capability_proposals)
      .where(
        and(
          eq(capability_proposals.tenant_id, tenant_id),
          eq(capability_proposals.agent_id, agent_id),
          eq(capability_proposals.gap_id, gap_id),
        ),
      )
      .orderBy(desc(capability_proposals.created_at));
  },

  // Validated state-machine transition. Retorna typed result, sem throw.
  // - not_found:           id desconhecido (ou fora do tenant/agent atual)
  // - invalid_transition:  destino não permitido a partir do source, mesmo
  //                        status (re-entrada), ou origem terminal
  //                        (rejected/reverted).
  //
  // P87-C3 (PR #87 review): activation gate. A transição approved → delivered
  // foi removida — agora exige caminho approved → testing → delivered (sucesso)
  // ou approved → testing → reverted (falha). A wiring é feita por
  // activateApprovedCapability (capability-test-runner.ts), que é o ÚNICO
  // caller production-grade do trio approved → testing → {delivered|reverted}.
  // Chamadas diretas a transition({to:'delivered'}) continuam permitidas a
  // partir de 'testing', NUNCA a partir de 'approved'.
  //
  // Side effects (timestamps + opcionais):
  //   to:'submitted' → submitted_at
  //   to:'approved'  → decided_at + decided_by? + decision_reason?
  //   to:'rejected'  → decided_at + decided_by? + decision_reason?
  //   to:'testing'   → (sem timestamp dedicado; updated_at marca)
  //   to:'delivered' → delivered_at + delivery_artifact_ref?
  //                    + last_test_outcome? + last_test_at?
  //   to:'reverted'  → reverted_at + revert_reason?
  //                    + last_test_outcome? + last_test_at?
  async transition(args: {
    id: string;
    to: ProposalStatus;
    decided_by?: string;
    decision_reason?: string;
    delivery_artifact_ref?: string;
    revert_reason?: string;
    last_test_outcome?: 'pass' | 'fail' | 'error';
  }): Promise<
    | { ok: true; updated: CapabilityProposal }
    | { ok: false; reason: 'not_found' | 'invalid_transition' }
  > {
    const row = await capabilityProposalsRepo.getById(args.id);
    if (!row) return { ok: false, reason: 'not_found' };

    const from = row.status as ProposalStatus;
    // Terminal sources — no further transitions.
    if (from === 'rejected' || from === 'reverted') {
      return { ok: false, reason: 'invalid_transition' };
    }
    if (from === args.to) {
      return { ok: false, reason: 'invalid_transition' };
    }

    const allowed: Record<string, readonly string[]> = {
      draft: ['submitted'],
      submitted: ['approved', 'rejected'],
      approved: ['testing'],
      testing: ['delivered', 'reverted'],
      // P87-C3 — delivered → reverted permitido (Superpowers Important #2):
      // tools can fail after activation; revert tooling pode marcar a row.
      delivered: ['reverted'],
    };
    if (!allowed[from]?.includes(args.to)) {
      return { ok: false, reason: 'invalid_transition' };
    }

    const now = new Date();
    const patch: Record<string, unknown> = { status: args.to, updated_at: now };
    if (args.to === 'submitted') {
      patch.submitted_at = now;
    } else if (args.to === 'approved' || args.to === 'rejected') {
      patch.decided_at = now;
      if (args.decided_by) patch.decided_by = args.decided_by;
      if (args.decision_reason) patch.decision_reason = args.decision_reason;
    } else if (args.to === 'delivered') {
      patch.delivered_at = now;
      if (args.delivery_artifact_ref)
        patch.delivery_artifact_ref = args.delivery_artifact_ref;
      if (args.last_test_outcome) {
        patch.last_test_outcome = args.last_test_outcome;
        patch.last_test_at = now;
      }
    } else if (args.to === 'reverted') {
      patch.reverted_at = now;
      if (args.revert_reason) patch.revert_reason = args.revert_reason;
      if (args.last_test_outcome) {
        patch.last_test_outcome = args.last_test_outcome;
        patch.last_test_at = now;
      }
    }

    const [updated] = await db
      .update(capability_proposals)
      .set(patch as Partial<typeof capability_proposals.$inferInsert>)
      .where(eq(capability_proposals.id, args.id))
      .returning();
    return { ok: true, updated: updated! };
  },
};

// P5: capability_test_results — auditoria do loop fechado pós-ativação. Cada
// run dos test_scenarios da proposal gera uma linha; outcome=fail/error pode
// disparar triggered_revert=true e criar um technical_gap_id (gap derivado
// para investigação). Reads ordenam por ran_at DESC (mais recente primeiro).
export const capabilityTestResultsRepo = {
  async record(input: {
    proposal_id: string;
    gap_id?: string;
    outcome: 'pass' | 'fail' | 'error';
    scenarios_run: unknown[];
    scenarios_passed: number;
    scenarios_failed: number;
    details?: unknown;
    triggered_revert?: boolean;
    technical_gap_id?: string;
  }): Promise<CapabilityTestResult> {
    // PR #87 Minor #3: defensive parity. applyTenantGuard injeta tenant/agent
    // do contexto atual, mas NÃO valida que technical_gap_id (passado pelo
    // caller) pertence ao mesmo tenant. Hoje a chain (capability-test-runner
    // → revertCapability → capabilityGapsRepo.create) sempre cria o gap
    // dentro do mesmo tenant context, então o id retornado é seguro — mas
    // callers futuros poderiam quebrar essa premissa. Faz cross-check
    // explícito para fechar a porta agora.
    if (input.technical_gap_id) {
      const tenant_id = getCurrentTenant();
      const agent_id = getCurrentAgent();
      const rows = await db
        .select({ id: agent_capability_gaps.id })
        .from(agent_capability_gaps)
        .where(
          and(
            eq(agent_capability_gaps.id, input.technical_gap_id),
            eq(agent_capability_gaps.tenant_id, tenant_id),
            eq(agent_capability_gaps.agent_id, agent_id),
          ),
        )
        .limit(1);
      if (rows.length === 0) {
        throw new Error('capability_test_results.technical_gap_id_cross_tenant');
      }
    }
    const guarded = applyTenantGuard({
      proposal_id: input.proposal_id,
      gap_id: input.gap_id ?? null,
      outcome: input.outcome,
      scenarios_run: input.scenarios_run as unknown as object,
      scenarios_passed: input.scenarios_passed,
      scenarios_failed: input.scenarios_failed,
      details: (input.details ?? {}) as object,
      triggered_revert: input.triggered_revert ?? false,
      technical_gap_id: input.technical_gap_id ?? null,
    });
    const [row] = await db
      .insert(capability_test_results)
      .values(guarded as typeof capability_test_results.$inferInsert)
      .returning();
    return row!;
  },

  async listByProposal(proposal_id: string): Promise<CapabilityTestResult[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(capability_test_results)
      .where(
        and(
          eq(capability_test_results.tenant_id, tenant_id),
          eq(capability_test_results.agent_id, agent_id),
          eq(capability_test_results.proposal_id, proposal_id),
        ),
      )
      .orderBy(desc(capability_test_results.ran_at));
  },

  async latestByProposal(proposal_id: string): Promise<CapabilityTestResult | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(capability_test_results)
      .where(
        and(
          eq(capability_test_results.tenant_id, tenant_id),
          eq(capability_test_results.agent_id, agent_id),
          eq(capability_test_results.proposal_id, proposal_id),
        ),
      )
      .orderBy(desc(capability_test_results.ran_at))
      .limit(1);
    return rows[0] ?? null;
  },
};

// P6: channels — instâncias de entrada de mensagem (1+ por agent). Tenant-
// scoped via applyTenantGuard; findByExternalCrossTenant é o único método que
// bypassa o guard (usado pelo resolver de entrada, antes do contexto existir).
export const channelsRepo = {
  async create(input: {
    external_id: string;
    channel_type: 'whatsapp' | 'telegram' | 'email' | 'sms' | 'web' | 'api' | 'other';
    display_name?: string;
    metadata?: unknown;
  }): Promise<Channel> {
    const guarded = applyTenantGuard({
      external_id: input.external_id,
      channel_type: input.channel_type,
      display_name: input.display_name ?? null,
      metadata: (input.metadata as object) ?? {},
    });
    const [row] = await db
      .insert(channels)
      .values(guarded as typeof channels.$inferInsert)
      .returning();
    return row!;
  },

  async getById(id: string): Promise<Channel | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.tenant_id, tenant_id),
          eq(channels.agent_id, agent_id),
          eq(channels.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async findByExternal(
    channel_type: string,
    external_id: string,
  ): Promise<Channel | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.tenant_id, tenant_id),
          eq(channels.agent_id, agent_id),
          eq(channels.channel_type, channel_type),
          eq(channels.external_id, external_id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  // EXPLICITLY bypasses applyTenantGuard — used by resolver (entry point,
  // before context exists). The (channel_type, external_id) lookup discovers
  // which tenant/agent owns the inbound message.
  //
  // [Codex review #277] UNIQUE in `migrations/031_p6_channels.sql` is
  // `(tenant_id, channel_type, external_id)` — same (channel_type, external_id)
  // CAN coexist across distinct tenants (e.g., a number switching providers,
  // or a tenant deactivating an old channel before another tenant claims it).
  // A naive `limit(1)` would arbitrarily pick one row, and if the resolver
  // landed on the inactive one it would reject a message belonging to the
  // active tenant — silently dropping legitimate traffic.
  //
  // Strategy: fetch ALL matches, then collapse:
  //   - 0 active rows → return any inactive (resolver will throw with
  //     found:true, active:false → unknown_or_inactive_channel audit).
  //   - 1 active row  → return it (the only sensible owner).
  //   - 2+ active rows → cross-tenant ambiguity. Surface explicitly via
  //     TypedError so the channel ownership conflict is visible in
  //     audit/triage rather than being masked by a non-deterministic pick.
  //     The PROPER fix is an operator deactivating one side; the resolver
  //     refusing to choose is the fail-loud counterpart of the rate-limit
  //     bucket collapse that issue #268 closed.
  //
  // Cardinality is bounded by `channels_external_idx` and in practice expected
  // to be ≤ 2 (one prior, one current); fetching all rows is O(few).
  async findByExternalCrossTenant(args: {
    channel_type: string;
    external_id: string;
  }): Promise<Channel | null> {
    const rows = await db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.channel_type, args.channel_type),
          eq(channels.external_id, args.external_id),
        ),
      );
    if (rows.length === 0) return null;

    const activeRows = rows.filter((r) => r.active);
    if (activeRows.length === 0) {
      // No active owner — return any inactive to preserve the (found:true,
      // active:false) audit signature the resolver expects.
      return rows[0]!;
    }
    if (activeRows.length > 1) {
      // Multiple active tenants claim the same external_id — refuse to choose.
      // Caller (resolveChannel) wraps this in the standard fail-loud path.
      throw new TypedError(
        'channel_resolution_failed',
        'channel ownership ambiguous: multiple active channels match (channel_type, external_id)',
        {
          channel_type: args.channel_type,
          external_id: args.external_id,
          resolver_path: 'ambiguous_active_channels',
          conflicting_tenant_ids: activeRows.map((r) => r.tenant_id),
        },
      );
    }
    return activeRows[0]!;
  },

  // [Issue #411] Single-tenant catch-all for the channel resolver. EXPLICITLY
  // bypasses applyTenantGuard for the same sanctioned reason as
  // `findByExternalCrossTenant` — the entry point runs BEFORE a tenant context
  // exists.
  //
  // Contract: given a channel_type whose `(channel_type, external_id)` exact
  // lookup missed, decide whether the deployment is a genuine single-tenant
  // runtime (one tenant: the seeded `default/default`) or a real multi-tenant
  // config, and (when single-tenant) hand back the seeded `default/default`
  // catch-all channel so the resolver can map ANY inbound sender to
  // (default, default). This is what makes the bot answer arbitrary senders
  // without dropping messages.
  //
  // ── [🔴 CRITICAL fix — PR #417 review] cross-`channel_type` isolation leak ──
  // The discriminator "is this deployment multi-tenant?" MUST be GLOBAL — it
  // looks at EVERY active channel owned by a non-`default` tenant, regardless
  // of `channel_type`. The previous implementation scoped the discriminator to
  // the inbound's `channel_type`, so a real tenant whose only channel was a
  // DIFFERENT type (e.g. a `telegram` tenant while the inbound is `whatsapp`)
  // was invisible → `hasRealTenant` stayed false → the resolver handed
  // `default/default` to a deployment that HAS a real tenant. That collapses
  // distinct tenants onto the shared `maia:ratelimit:default:default:*` bucket
  // — the exact cross-tenant leak issue #268 closed. The fix splits the logic:
  //   1. GLOBAL discriminator (NO channel_type filter): ANY active channel with
  //      tenant_id != 'default' ⇒ real multi-tenant deployment → fail-closed
  //      (`multi_tenant:true`, NO channel) so the resolver throws
  //      `channel_resolution_failed`.
  //   2. ONLY IF none exists: use `channel_type` to locate the seeded active
  //      `default/default` catch-all channel
  //      (migrations/035_p6_seed_default_channel_role_policy.sql).
  //
  // ── [🟠 HIGH fix — PR #417 review] TOCTOU vs a concurrent activation ──
  // Both reads run inside ONE transaction (`withTx` → a single `BEGIN…COMMIT`
  // on one pooled connection) so the discriminator and the catch-all fetch
  // observe a CONSISTENT snapshot. A tenant activating its first channel
  // between the two reads can no longer slip through the window and let an
  // in-flight message hit `default/default` after the deployment became
  // multi-tenant. Residual risk: a concurrent activation that COMMITS before
  // this transaction's snapshot is taken is (correctly) not yet visible — the
  // in-flight message races the activation, which is inherent and bounded; the
  // very next inbound observes the new tenant and fails closed. Eliminating
  // even that would require locking the whole `channels` table on every inbound
  // (rejected: it serialises the hot path for no isolation gain — the next
  // message already fails closed).
  //
  // Cardinality: the `channels` table is small (one row per registered line);
  // the discriminator is a `LIMIT 1` existence probe and the catch-all fetch is
  // a single-row lookup, both O(1)-ish.
  async findDefaultCatchAllChannel(args: {
    channel_type: string;
  }): Promise<
    | { multi_tenant: true; channel: null }
    | { multi_tenant: false; channel: Channel | null }
  > {
    return withTx(async (tx) => {
      // 1. GLOBAL discriminator — any ACTIVE channel owned by a non-`default`
      //    tenant, across ALL channel_types. Its mere existence proves a real
      //    multi-tenant deployment. Fail-closed: do NOT hand back the default
      //    catch-all. `LIMIT 1` — we only need existence, not the rows.
      const realTenantProbe = await tx
        .select({ one: sql<number>`1` })
        .from(channels)
        .where(and(eq(channels.active, true), ne(channels.tenant_id, 'default')))
        .limit(1);
      if (realTenantProbe.length > 0) {
        return { multi_tenant: true, channel: null };
      }

      // 2. Single-tenant runtime: surface the seeded active `default/default`
      //    catch-all channel for this channel_type (if present). Scoped by
      //    channel_type so e.g. a whatsapp inbound gets the whatsapp catch-all.
      const fallbackRows = await tx
        .select()
        .from(channels)
        .where(
          and(
            eq(channels.channel_type, args.channel_type),
            eq(channels.active, true),
            eq(channels.tenant_id, 'default'),
            eq(channels.agent_id, 'default'),
          ),
        )
        .limit(1);
      return { multi_tenant: false, channel: fallbackRows[0] ?? null };
    });
  },

  async listActive(): Promise<Channel[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.tenant_id, tenant_id),
          eq(channels.agent_id, agent_id),
          eq(channels.active, true),
        ),
      );
  },

  // [P88-C3] Tenant-scoped: write paths MUST enforce isolation. Without
  // tenant/agent predicates, any caller with another tenant's channel UUID
  // could disable that channel (cross-tenant DoS). Read-side filters here
  // were already tenant-scoped — this aligns the destructive path.
  async deactivate(id: string): Promise<{ rowCount: number }> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const result = await db
      .update(channels)
      .set({ active: false, updated_at: new Date() })
      .where(
        and(
          eq(channels.tenant_id, tenant_id),
          eq(channels.agent_id, agent_id),
          eq(channels.id, id),
        ),
      )
      .returning({ id: channels.id });
    return { rowCount: result.length };
  },
};

// P6: roles — modos operacionais por agent (comercial, suporte, default, etc).
// Exatamente 1 default por (tenant, agent), garantido por partial unique index.
export const rolesRepo = {
  async create(input: {
    role_key: string;
    display_name: string;
    description?: string;
    prompt_addendum?: string;
    is_default?: boolean;
  }): Promise<Role> {
    const guarded = applyTenantGuard({
      role_key: input.role_key,
      display_name: input.display_name,
      description: input.description ?? null,
      prompt_addendum: input.prompt_addendum ?? null,
      is_default: input.is_default ?? false,
    });
    const [row] = await db
      .insert(roles)
      .values(guarded as typeof roles.$inferInsert)
      .returning();
    return row!;
  },

  async getById(id: string): Promise<Role | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(roles)
      .where(
        and(
          eq(roles.tenant_id, tenant_id),
          eq(roles.agent_id, agent_id),
          eq(roles.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async getByKey(role_key: string): Promise<Role | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(roles)
      .where(
        and(
          eq(roles.tenant_id, tenant_id),
          eq(roles.agent_id, agent_id),
          eq(roles.role_key, role_key),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async getDefault(): Promise<Role | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(roles)
      .where(
        and(
          eq(roles.tenant_id, tenant_id),
          eq(roles.agent_id, agent_id),
          eq(roles.is_default, true),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async listActive(): Promise<Role[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(roles)
      .where(
        and(
          eq(roles.tenant_id, tenant_id),
          eq(roles.agent_id, agent_id),
          eq(roles.active, true),
        ),
      );
  },

  // [P88-C3] Tenant-scoped: same justification as channelsRepo.deactivate.
  // Cross-tenant deactivation would break the inviolable isolation invariant.
  async deactivate(id: string): Promise<{ rowCount: number }> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const result = await db
      .update(roles)
      .set({ active: false, updated_at: new Date() })
      .where(
        and(
          eq(roles.tenant_id, tenant_id),
          eq(roles.agent_id, agent_id),
          eq(roles.id, id),
        ),
      )
      .returning({ id: roles.id });
    return { rowCount: result.length };
  },
};

// P6: channel_policies — governance que define default role + switch_behavior
// + travas anti-oscilação para by_context. UNIQUE (channel_id) garante 1
// policy por canal.
export const channelPoliciesRepo = {
  async create(input: {
    channel_id: string;
    default_role_id: string;
    switch_behavior: SwitchBehavior;
    announce_mode?: AnnounceMode;
    by_context_guards?: unknown;
    allowed_role_ids?: string[];
  }): Promise<ChannelPolicy> {
    const guarded = applyTenantGuard({
      channel_id: input.channel_id,
      default_role_id: input.default_role_id,
      switch_behavior: input.switch_behavior,
      ...(input.announce_mode !== undefined
        ? { announce_mode: input.announce_mode }
        : {}),
      ...(input.by_context_guards !== undefined
        ? { by_context_guards: input.by_context_guards as object }
        : {}),
      ...(input.allowed_role_ids !== undefined
        ? { allowed_role_ids: input.allowed_role_ids as unknown as object }
        : {}),
    });
    const [row] = await db
      .insert(channel_policies)
      .values(guarded as typeof channel_policies.$inferInsert)
      .returning();
    return row!;
  },

  async getByChannelId(channel_id: string): Promise<ChannelPolicy | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select()
      .from(channel_policies)
      .where(
        and(
          eq(channel_policies.tenant_id, tenant_id),
          eq(channel_policies.agent_id, agent_id),
          eq(channel_policies.channel_id, channel_id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async update(
    id: string,
    patch: Partial<NewChannelPolicy>,
  ): Promise<ChannelPolicy> {
    // Strip any tenant/agent the caller might have supplied — context wins.
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const { tenant_id: inTenant, agent_id: inAgent, ...rest } = patch;
    if (inTenant && inTenant !== tenant_id) {
      throw new Error(`tenant mismatch: input ${inTenant} vs context ${tenant_id}`);
    }
    if (inAgent && inAgent !== agent_id) {
      throw new Error(`agent mismatch: input ${inAgent} vs context ${agent_id}`);
    }
    const [row] = await db
      .update(channel_policies)
      .set({
        ...rest,
        updated_at: new Date(),
      } as Partial<typeof channel_policies.$inferInsert>)
      .where(
        and(
          eq(channel_policies.tenant_id, tenant_id),
          eq(channel_policies.agent_id, agent_id),
          eq(channel_policies.id, id),
        ),
      )
      .returning();
    return row!;
  },
};

// P6: role_selector_decisions — log append-only de TODA decisão do role
// selector (mesmo "keep_current"). decided_by NUNCA pode ser llm_classifier:
// CHECK constraint no DB + runtime guard aqui (defense in depth). LLM
// sugere (suggested_by), policy decide (decided_by).
export const roleSelectorDecisionsRepo = {
  async record(input: {
    conversa_id?: string;
    turno_id?: string;
    channel_id?: string;
    policy_id?: string;
    current_role_id?: string;
    suggested_role_id?: string;
    decided_role_id: string;
    action: RoleDecisionAction;
    candidates: unknown[];
    conflicts: unknown[];
    suggested_by: SuggestedBy;
    decided_by: DecidedBy;
    suggested_strength?: RoleSelectorStrength;
    suggested_confidence?: number;
    reason?: string;
    switch_count_in_conversation?: number;
  }): Promise<RoleSelectorDecisionRow> {
    // CRITICAL runtime guard — defense in depth. DB has CHECK constraint,
    // but app validates too. LLM sugere; policy/owner/fallback decide.
    if ((input.decided_by as string) === 'llm_classifier') {
      throw new Error('decided_by_cannot_be_llm_classifier');
    }
    const guarded = applyTenantGuard({
      conversa_id: input.conversa_id ?? null,
      turno_id: input.turno_id ?? null,
      channel_id: input.channel_id ?? null,
      policy_id: input.policy_id ?? null,
      current_role_id: input.current_role_id ?? null,
      suggested_role_id: input.suggested_role_id ?? null,
      decided_role_id: input.decided_role_id,
      action: input.action,
      candidates: input.candidates as unknown as object,
      conflicts: input.conflicts as unknown as object,
      suggested_by: input.suggested_by,
      decided_by: input.decided_by,
      suggested_strength: input.suggested_strength ?? null,
      suggested_confidence:
        input.suggested_confidence !== undefined
          ? String(input.suggested_confidence)
          : null,
      reason: input.reason ?? null,
      switch_count_in_conversation: input.switch_count_in_conversation ?? 0,
    });
    const [row] = await db
      .insert(role_selector_decisions)
      .values(guarded as typeof role_selector_decisions.$inferInsert)
      .returning();
    return row!;
  },

  async listByConversation(
    conversa_id: string,
  ): Promise<RoleSelectorDecisionRow[]> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(role_selector_decisions)
      .where(
        and(
          eq(role_selector_decisions.tenant_id, tenant_id),
          eq(role_selector_decisions.agent_id, agent_id),
          eq(role_selector_decisions.conversa_id, conversa_id),
        ),
      )
      .orderBy(desc(role_selector_decisions.decided_at));
  },

  // [P88-C2] Returns the most recently DECIDED role for this conversation
  // (across all turns). Used by the role selector to rehydrate the current
  // role each turn — without this, `current_role` resets to policy.default
  // every turn, breaking the `by_context` anti-osc lock (it would punish
  // consistency by counting three same-context turns as three switches).
  async getLastDecidedRoleId(conversa_id: string): Promise<string | null> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select({ decided_role_id: role_selector_decisions.decided_role_id })
      .from(role_selector_decisions)
      .where(
        and(
          eq(role_selector_decisions.tenant_id, tenant_id),
          eq(role_selector_decisions.agent_id, agent_id),
          eq(role_selector_decisions.conversa_id, conversa_id),
        ),
      )
      .orderBy(desc(role_selector_decisions.decided_at))
      .limit(1);
    return rows[0]?.decided_role_id ?? null;
  },

  // [P88-H4 cooldown_turns] Counts decisions in this conversation in the
  // last N turns (i.e., the N most recent decisions). Used by the policy
  // decider to enforce `cooldown_turns` — require N turns between switches.
  async countSwitchesInLastNTurns(args: {
    conversa_id: string;
    n: number;
  }): Promise<number> {
    if (args.n <= 0) return 0;
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const rows = await db
      .select({ action: role_selector_decisions.action })
      .from(role_selector_decisions)
      .where(
        and(
          eq(role_selector_decisions.tenant_id, tenant_id),
          eq(role_selector_decisions.agent_id, agent_id),
          eq(role_selector_decisions.conversa_id, args.conversa_id),
        ),
      )
      .orderBy(desc(role_selector_decisions.decided_at))
      .limit(args.n);
    return rows.filter((r) => r.action === 'switch').length;
  },

  async countSwitchesInConversation(conversa_id: string): Promise<number> {
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    const result = await db.execute<{ count: number | string }>(sql`
      SELECT COUNT(*)::int AS count
        FROM role_selector_decisions
       WHERE tenant_id = ${tenant_id}
         AND agent_id = ${agent_id}
         AND conversa_id = ${conversa_id}
         AND action = 'switch'
    `);
    const raw = result.rows[0]?.count ?? 0;
    return typeof raw === 'string' ? Number(raw) : raw;
  },
};

// Calendar v2 — re-export of holidaysRepo + holidayEntidadesRepo from dedicated modules.
export { holidaysRepo } from './repositories/holidays-repo.js';
export { holidayEntidadesRepo, CrossTenantIntegrityError } from './repositories/holiday-entidades-repo.js';

// =====================================================================
// P8.5 Admin UI v1 — auth, approvals, audit log, debug snapshot grants
// =====================================================================

/**
 * Repository wrapper for P8.5 admin-ui app_users (NextAuth integration).
 */
export const appUsersRepo = {
  async getByEmail(tenant_id: string, email: string): Promise<AppUser | null> {
    const rows = await db
      .select()
      .from(app_users)
      .where(and(eq(app_users.tenant_id, tenant_id), eq(app_users.email, email)))
      .limit(1);
    return rows[0] ?? null;
  },

  async getById(id: string): Promise<AppUser | null> {
    const rows = await db.select().from(app_users).where(eq(app_users.id, id)).limit(1);
    return rows[0] ?? null;
  },

  async create(input: NewAppUser): Promise<AppUser> {
    const rows = await db.insert(app_users).values(input).returning();
    if (!rows[0]) throw new TypedError('app_user_create_failed', 'Could not create app_user');
    return rows[0];
  },
};

/**
 * proposalsUnified — virtual UNION view aggregating all proposal sources.
 *
 * Targets (post-merge of #93–#96):
 *   - policy_rules               (P8e — PolicyDescriptorResolver)
 *   - soul_biases                (P8b — Soul Layer)
 *   - skills                     (P8c — User Layer)
 *   - capability_proposals       (P5 — already in main)
 *   - knowledge_pending_review   (P10a — knowledge state machine)
 *
 * In current main, only `capability_proposals` exists. This wrapper falls back
 * gracefully: tables that do not exist yet contribute zero rows (verified at
 * call time via information_schema lookups). Once the dependent PRs merge,
 * the UNION view materializes the full federation without code changes.
 */
export const proposalsUnifiedRepo = {
  /** Tables expected to exist post-merge; queried with COALESCE-style fallback. */
  EXPECTED_TABLES: [
    'policy_rules',
    'soul_biases',
    'skills',
    'capability_proposals',
    'knowledge_pending_review',
  ] as const,

  async _availableTables(): Promise<string[]> {
    const result = await db.execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY (ARRAY['policy_rules','soul_biases','skills','capability_proposals','knowledge_pending_review'])
    `);
    return result.rows.map((r) => r.table_name);
  },

  async list(input: {
    tenantId: string;
    types?: ProposalTypeId[];
    risks?: RiskLevelId[];
    sources?: string[];
    status?: ProposalUnifiedStatus;
    ageBucket?: 'lt_1h' | 'lt_24h' | 'lt_7d' | 'lt_30d' | 'older';
    limit: number;
    cursor?: string | null;
  }): Promise<{
    items: Array<{
      id: string;
      type: ProposalTypeId;
      descriptor: string;
      risk: RiskLevelId;
      source: string;
      status: ProposalUnifiedStatus;
      proposed_at: Date;
      proposed_by: string;
    }>;
    hasMore: boolean;
    nextCursor: string | null;
  }> {
    const available = await this._availableTables();
    const status = input.status ?? 'proposed';

    // capability_proposals is the only table guaranteed to exist on main.
    if (!available.includes('capability_proposals')) {
      return { items: [], hasMore: false, nextCursor: null };
    }

    const items: Array<{
      id: string;
      type: ProposalTypeId;
      descriptor: string;
      risk: RiskLevelId;
      source: string;
      status: ProposalUnifiedStatus;
      proposed_at: Date;
      proposed_by: string;
    }> = [];

    // capability_proposals: title column → descriptor
    // capability_proposals.status uses values: 'draft' | 'submitted' | 'approved' | 'rejected' | 'delivered'
    // We map admin-ui statuses ('proposed' | 'pending_review' | 'rejected' | 'activated') to those values:
    //   proposed → submitted
    //   pending_review → submitted (alias for current admin-ui review queue)
    //   rejected → rejected
    //   activated → delivered
    const capStatusMap: Record<ProposalUnifiedStatus, string> = {
      proposed: 'submitted',
      pending_review: 'submitted',
      rejected: 'rejected',
      activated: 'delivered',
    };
    if (available.includes('capability_proposals')) {
      const dbStatus = capStatusMap[status];
      const rows = await db
        .select()
        .from(capability_proposals)
        .where(
          and(
            eq(capability_proposals.tenant_id, input.tenantId),
            eq(capability_proposals.status, dbStatus),
          ),
        )
        .orderBy(desc(capability_proposals.created_at))
        .limit(input.limit + 1);
      for (const r of rows) {
        // Post-Codex-review #101: risk is DERIVED from capability_type +
        // proposed_spec markers; never hardcoded. Fail-closed default is
        // 'critical' (forces dual approval). See ./capability-risk.ts.
        items.push({
          id: r.id,
          type: 'capability_proposal',
          descriptor: r.title,
          risk: deriveCapabilityRisk(r.capability_type, r.proposed_spec),
          source: r.capability_type,
          status,
          proposed_at: r.created_at,
          proposed_by: r.decided_by ?? 'system',
        });
      }
    }

    // Future tables (policy_rules, soul_biases, skills, knowledge_pending_review)
    // are wired up here once their schemas land in main; the available[] check
    // gates each block independently to avoid runtime errors before merge.

    // Simple in-memory filter on optional facets (UI-side filters)
    const filtered = items.filter((it) => {
      if (input.types && !input.types.includes(it.type)) return false;
      if (input.risks && !input.risks.includes(it.risk)) return false;
      if (input.sources && !input.sources.includes(it.source)) return false;
      return true;
    });

    const hasMore = filtered.length > input.limit;
    const trimmed = filtered.slice(0, input.limit);
    const nextCursor = hasMore && trimmed[trimmed.length - 1]
      ? trimmed[trimmed.length - 1]!.id
      : null;
    return { items: trimmed, hasMore, nextCursor };
  },

  async countersByType(tenantId: string): Promise<Record<ProposalTypeId, number>> {
    const counts: Record<ProposalTypeId, number> = {
      policy_rule: 0,
      soul_bias: 0,
      skill: 0,
      capability_proposal: 0,
      knowledge_proposal: 0,
    };
    const available = await this._availableTables();
    if (available.includes('capability_proposals')) {
      const result = await db.execute<{ count: number | string }>(sql`
        SELECT COUNT(*)::int AS count
          FROM capability_proposals
         WHERE tenant_id = ${tenantId}
           AND status = 'submitted'
      `);
      const raw = result.rows[0]?.count ?? 0;
      counts.capability_proposal = typeof raw === 'string' ? Number(raw) : raw;
    }
    return counts;
  },

  async getOne(
    tenantId: string,
    id: string,
  ): Promise<{
    id: string;
    type: ProposalTypeId;
    descriptor: string;
    risk: RiskLevelId;
    source: string;
    status: ProposalUnifiedStatus;
    proposed_at: Date;
    proposed_by: string;
    body: unknown;
    locks: string[];
  } | null> {
    const available = await this._availableTables();
    if (available.includes('capability_proposals')) {
      const rows = await db
        .select()
        .from(capability_proposals)
        .where(and(eq(capability_proposals.tenant_id, tenantId), eq(capability_proposals.id, id)))
        .limit(1);
      const r = rows[0];
      if (r) {
        // Reverse-map db status → admin-ui status; fall back to 'proposed'.
        const reverseStatusMap: Record<string, ProposalUnifiedStatus> = {
          draft: 'proposed',
          submitted: 'proposed',
          approved: 'pending_review',
          rejected: 'rejected',
          delivered: 'activated',
        };
        // Post-Codex-review #101: risk + locks DERIVED from spec, not hardcoded.
        return {
          id: r.id,
          type: 'capability_proposal',
          descriptor: r.title,
          risk: deriveCapabilityRisk(r.capability_type, r.proposed_spec),
          source: r.capability_type,
          status: reverseStatusMap[r.status] ?? 'proposed',
          proposed_at: r.created_at,
          proposed_by: r.decided_by ?? 'system',
          body: r.proposed_spec,
          locks: deriveCapabilityLocks(r.capability_type, r.proposed_spec),
        };
      }
    }
    return null;
  },

  /**
   * decideAtomically — single-transaction approve/reject for a unified proposal.
   *
   * Post-Codex-review #101: the old approve/reject path inserted into
   * proposal_approvals + admin_audit_log but never touched the source-of-truth
   * row. A capability_proposal could stay in status='submitted' forever while
   * the admin UI reported "activated". This method closes that gap.
   *
   * Behavior per source:
   *   capability_proposals:
   *     - On approve gate satisfied (dual or single): submitted → approved
   *       (capabilityProposalsRepo.transition). Subsequent activation
   *       (approved → testing → delivered) is owned by the capability-test-runner.
   *     - On reject: submitted → rejected.
   *
   *   policy_rules / soul_biases / skills / knowledge_pending_review:
   *     - Transitions deferred to the source repo once each schema lands.
   *       Returns { ok: false, reason: 'source_not_supported' } until then —
   *       NEVER silently succeeds.
   *
   * Pre-conditions enforced inside the transaction:
   *   - Source row exists for (tenantId, id)
   *   - Source status is currently in a valid pre-decision state for the
   *     attempted transition (rejects double-approval, double-reject, race
   *     between two operators).
   *
   * round-2 fix: dup-check (same user cannot approve twice) and gate
   * recomputation now happen INSIDE the transaction after locking the source
   * row. This prevents the race where two concurrent approvers both compute
   * willSatisfyGate=false outside the tx, then both serialize through the
   * lock and insert approvals without triggering the transition.
   *
   * Gate inputs from the tRPC layer (requiredRoles, allLocks) are passed in
   * so this method can recompute dualComplete from the fresh approval list.
   */
  async decideAtomically(input: {
    tenantId: string;
    proposalId: string;
    type: ProposalTypeId;
    approvalClass: string;
    actorId: string;
    actorRole: string;
    decision: 'approved' | 'rejected';
    comment: string;
    /**
     * Provided by the tRPC layer for gate recomputation inside the tx.
     * If absent, falls back to the pre-computed dualComplete (old behaviour,
     * kept for backwards-compat with the mock in tests).
     */
    gateParams?: {
      dualRequired: boolean;
      requiredRoles: string[];
      allLocks: string[];
    };
    /** True ⇒ the gate is satisfied; perform the source transition.
     * Ignored when gateParams is present (recomputed inside tx). */
    dualComplete: boolean;
  }): Promise<{
    ok: true;
    sourceTransitioned: boolean;
    approval: ProposalApproval;
    finalStatus: ProposalUnifiedStatus;
    /** Recomputed inside transaction. */
    dualComplete: boolean;
  } | {
    ok: false;
    reason:
      | 'not_found'
      | 'invalid_source_status'
      | 'source_not_supported'
      | 'transition_failed'
      | 'already_approved_by_user'
      | 'already_approved_by_role';
  }> {
    const available = await this._availableTables();

    return await withTx(async (tx) => {
      // (1) Re-read + LOCK source row to prevent races.
      if (input.type === 'capability_proposal') {
        if (!available.includes('capability_proposals')) {
          return { ok: false, reason: 'source_not_supported' as const };
        }
        const rows = await tx
          .select()
          .from(capability_proposals)
          .where(
            and(
              eq(capability_proposals.tenant_id, input.tenantId),
              eq(capability_proposals.id, input.proposalId),
            ),
          )
          .for('update')
          .limit(1);
        const sourceRow = rows[0];
        if (!sourceRow) return { ok: false, reason: 'not_found' as const };

        // Only 'submitted' rows are eligible for approve/reject. 'draft' would
        // need explicit submit first; terminal states block.
        if (sourceRow.status !== 'submitted') {
          return { ok: false, reason: 'invalid_source_status' as const };
        }

        // (1b) Re-read existing approvals INSIDE the transaction + re-run dup
        // checks so concurrent approvers cannot race past the idempotency guard.
        let resolvedDualComplete = input.dualComplete;
        if (input.decision === 'approved' && input.gateParams) {
          const existingInTx = await tx
            .select()
            .from(proposal_approvals)
            .where(eq(proposal_approvals.proposal_id, input.proposalId));

          // Idempotency by user: same user cannot record two approvals.
          if (existingInTx.some(
            (a) => a.approver_user_id === input.actorId && a.decision === 'approved',
          )) {
            return { ok: false, reason: 'already_approved_by_user' as const };
          }

          const { dualRequired, requiredRoles, allLocks } = input.gateParams;

          // For non-lockdown dual classes: same role cannot double-sign.
          if (dualRequired && allLocks.length === 0) {
            if (existingInTx.some(
              (a) => a.approver_role === input.actorRole && a.decision === 'approved',
            )) {
              return { ok: false, reason: 'already_approved_by_role' as const };
            }
          }

          // Recompute gate from the fresh (locked) approval list + this approval.
          if (allLocks.length > 0) {
            const priorFounderIds = new Set(
              existingInTx
                .filter((a) => a.decision === 'approved' && a.approver_role === 'founder')
                .map((a) => a.approver_user_id),
            );
            priorFounderIds.add(input.actorId);
            resolvedDualComplete = priorFounderIds.size >= 2;
          } else if (dualRequired) {
            const approvedRoles = new Set(
              existingInTx.filter((a) => a.decision === 'approved').map((a) => a.approver_role),
            );
            approvedRoles.add(input.actorRole);
            resolvedDualComplete = requiredRoles.every((r) => approvedRoles.has(r));
          } else {
            resolvedDualComplete = true;
          }
        }

        // (2) Insert approval row.
        const insertedApprovals = await tx
          .insert(proposal_approvals)
          .values({
            tenant_id: input.tenantId,
            proposal_id: input.proposalId,
            approval_class: input.approvalClass,
            approver_user_id: input.actorId,
            approver_role: input.actorRole,
            decision: input.decision,
            comment: input.comment,
          })
          .returning();
        const approval = insertedApprovals[0];
        if (!approval) {
          throw new TypedError('approval_insert_failed', 'Could not record approval');
        }

        // (3) Audit BEFORE source mutation, so the audit row is visible
        // even if the source UPDATE rolls back.
        await tx.insert(admin_audit_log).values({
          tenant_id: input.tenantId,
          actor_id: input.actorId,
          actor_role: input.actorRole,
          action: input.decision === 'approved' ? 'proposal_approve' : 'proposal_reject',
          resource_type: 'capability_proposal',
          resource_id: input.proposalId,
          change_summary: {
            approval_class: input.approvalClass,
            comment: input.comment,
            dual_complete: resolvedDualComplete,
            source_transition_attempted:
              input.decision === 'rejected' || resolvedDualComplete,
          },
        });

        // (4) Mutate source-of-truth.
        let finalStatus: ProposalUnifiedStatus = 'pending_review';
        let sourceTransitioned = false;
        if (input.decision === 'rejected') {
          // Direct UPDATE inside the same txn so we don't depend on
          // capabilityProposalsRepo.transition (which uses module-level `db`).
          const patched = await tx
            .update(capability_proposals)
            .set({
              status: 'rejected',
              decided_at: new Date(),
              decided_by: input.actorId,
              decision_reason: input.comment,
              updated_at: new Date(),
            })
            .where(eq(capability_proposals.id, input.proposalId))
            .returning();
          if (patched.length === 0) {
            return { ok: false, reason: 'transition_failed' as const };
          }
          finalStatus = 'rejected';
          sourceTransitioned = true;
        } else if (resolvedDualComplete) {
          // submitted → approved. (approved → testing → delivered is owned by
          // capability-test-runner and runs out-of-band.)
          const patched = await tx
            .update(capability_proposals)
            .set({
              status: 'approved',
              decided_at: new Date(),
              decided_by: input.actorId,
              decision_reason: input.comment,
              updated_at: new Date(),
            })
            .where(eq(capability_proposals.id, input.proposalId))
            .returning();
          if (patched.length === 0) {
            return { ok: false, reason: 'transition_failed' as const };
          }
          // Admin-ui surface name: 'pending_review' once approved but not yet
          // delivered. The reverseStatusMap in getOne also maps 'approved' →
          // 'pending_review' for consistency.
          finalStatus = 'pending_review';
          sourceTransitioned = true;
        }

        return {
          ok: true as const,
          sourceTransitioned,
          approval,
          finalStatus,
          dualComplete: resolvedDualComplete,
        };
      }

      // policy_rule / soul_bias / skill / knowledge_proposal:
      //
      // Reverted (Codex review of PR #162, finding [critical]): the previous
      // attempt to add a generic raw-table activation path skipped each
      // source's lifecycle invariants — policy descriptor cache events, soul
      // bias lineage + incumbent deprecation, skill scope + active-version
      // deprecation, etc. Those live in their per-source repos
      // (`policyRulesRepo.activate`, `soulBiasesRepo.activate`,
      // `skillsRepo.activate`).
      //
      // Wiring those properly into a transactional `decideAtomically` requires
      // each source repo to expose a tx-aware `activate(tx, ...)` overload.
      // Until that lands, source_not_supported is the fail-safe — the tRPC
      // layer maps it to NOT_IMPLEMENTED rather than pretending success.
      return { ok: false, reason: 'source_not_supported' as const };
    });
  },

  /**
   * Bulk reject — only allowed for risk=low proposals.
   * Hard-limit / architecture-lock proposals are rejected one-at-a-time.
   */
  async bulkReject(
    tenantId: string,
    ids: string[],
    actorId: string,
    actorRole: string,
    comment: string,
  ): Promise<{ rejected_count: number; skipped_ids: string[] }> {
    if (ids.length === 0) return { rejected_count: 0, skipped_ids: [] };
    // round-2 fix: each proposal is processed in its own nested transaction
    // using decideAtomically so that:
    //   (a) The source row is locked (SELECT FOR UPDATE) before reading status.
    //   (b) audit/approval rows are ONLY inserted when the source transition
    //       succeeds (UPDATE returns a row), not on stale/already-handled rows.
    //   (c) rejected_count is only incremented for actual state changes.
    let rejected = 0;
    const skipped: string[] = [];

    for (const id of ids) {
      // Pre-flight: read outside tx for fast-skip (risk, locks). If the row
      // disappears between here and decideAtomically, decideAtomically returns
      // not_found and we skip.
      const proposal = await this.getOne(tenantId, id);
      if (!proposal) {
        skipped.push(id);
        continue;
      }
      if (proposal.risk !== 'low') {
        skipped.push(id);
        continue;
      }
      if (proposal.locks.length > 0) {
        skipped.push(id);
        continue;
      }
      // Authoritative transactional path: lock + validate + write atomically.
      const result = await this.decideAtomically({
        tenantId,
        proposalId: id,
        type: proposal.type,
        approvalClass: `${proposal.type}_${proposal.risk}`,
        actorId,
        actorRole,
        decision: 'rejected',
        comment,
        dualComplete: true, // single rejection is always gate-complete.
      });
      if (!result.ok) {
        // invalid_source_status → row already delivered/approved/rejected.
        // not_found → race: row deleted between pre-flight and lock.
        // Either way: no state change → skip without counting.
        skipped.push(id);
        continue;
      }
      rejected += 1;
    }
    return { rejected_count: rejected, skipped_ids: skipped };
  },
};

/**
 * proposalApprovalsRepo — track + check dual-approval state.
 */
export const proposalApprovalsRepo = {
  async listByProposal(proposalId: string): Promise<ProposalApproval[]> {
    return await db
      .select()
      .from(proposal_approvals)
      .where(eq(proposal_approvals.proposal_id, proposalId));
  },

  async record(input: NewProposalApproval): Promise<ProposalApproval> {
    const rows = await db.insert(proposal_approvals).values(input).returning();
    if (!rows[0]) throw new TypedError('approval_insert_failed', 'Could not record approval');
    return rows[0];
  },
};

/**
 * adminAuditLogRepo — APPEND-ONLY mutation trail for admin-ui actions.
 *
 * IMPORTANT: this repo exposes ONLY `append` and `list`. There is NO update
 * or delete method. Lint rule (eslint custom config) flags any direct
 * `update(admin_audit_log)` or `delete(admin_audit_log)` usage in src/.
 */
export const adminAuditLogRepo = {
  async append(entry: NewAdminAuditLogEntry): Promise<AdminAuditLogEntry> {
    const rows = await db.insert(admin_audit_log).values(entry).returning();
    if (!rows[0]) throw new TypedError('audit_log_append_failed', 'Could not append audit entry');
    return rows[0];
  },

  async list(input: {
    tenantId: string;
    actorId?: string;
    resourceType?: string;
    limit?: number;
  }): Promise<AdminAuditLogEntry[]> {
    const limit = input.limit ?? 100;
    const where = [eq(admin_audit_log.tenant_id, input.tenantId)];
    if (input.actorId) where.push(eq(admin_audit_log.actor_id, input.actorId));
    if (input.resourceType) where.push(eq(admin_audit_log.resource_type, input.resourceType));
    return await db
      .select()
      .from(admin_audit_log)
      .where(and(...where))
      .orderBy(desc(admin_audit_log.created_at))
      .limit(limit);
  },
};

/**
 * debugSnapshotGrantsRepo — TTL-bounded permission grants for trace bodies.
 */
export const debugSnapshotGrantsRepo = {
  async create(input: NewDebugSnapshotGrant): Promise<DebugSnapshotGrant> {
    const rows = await db.insert(debug_snapshot_grants).values(input).returning();
    if (!rows[0]) throw new TypedError('grant_insert_failed', 'Could not create grant');
    return rows[0];
  },

  async findActive(args: {
    tenantId: string;
    userId: string;
    traceId: string;
  }): Promise<DebugSnapshotGrant | null> {
    const now = new Date();
    const rows = await db
      .select()
      .from(debug_snapshot_grants)
      .where(
        and(
          eq(debug_snapshot_grants.tenant_id, args.tenantId),
          eq(debug_snapshot_grants.granted_to_user_id, args.userId),
          eq(debug_snapshot_grants.trace_id, args.traceId),
          isNull(debug_snapshot_grants.revoked_at),
          gt(debug_snapshot_grants.expires_at, now),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },
};

// =====================================================================
// global_settings — issue #183 / PR #188 Codex round 1 (high + medium)
// =====================================================================

/**
 * globalSettingsRepo — process-wide singleton settings (NOT scoped to
 * tenant/agent). Currently backs the founder-only LLM model switch
 * (/setup/llm-settings) but the table is intentionally generic so future
 * deployment-wide settings can reuse it.
 *
 * Why a new table (round 1, [high]):
 *   The previous storage in `agent_facts (tenant_id, agent_id, escopo, chave)`
 *   silently scoped the founder's "global" model pick to the founder's own
 *   `default` agent. Runtime `callLLM` reads inside the CURRENT request's
 *   (tenant_id, agent_id) AsyncLocalStorage context — for any non-default
 *   agent or any other tenant, that's a different row. Founder UI showed
 *   "audited successfully", but those callers kept using the env model.
 *   In incident-time (Anthropic outage, model deprecation) this defeats the
 *   entire purpose of the page. The fix is structural: a table with NO
 *   tenant/agent discriminator.
 *
 * Why `updateAtomic` instead of separate `set` + audit (round 1, [medium]):
 *   The router originally read current values OUTSIDE the tx, then skipped
 *   writes based on that stale snapshot, then audited
 *   `after={input.main, input.fast}`. Two concurrent founders updating
 *   different sides could observe stale `before`, write different values
 *   than what the audit row claims, and leave the DB in a state where the
 *   audit trail is corrupted (forensic gap). Fix: read the current value
 *   INSIDE the tx under `SELECT ... FOR UPDATE` on the row's PK, then
 *   UPSERT, then audit — all in one withTx. Audit `before` is the actual
 *   locked value; audit `after` is what the UPSERT just committed.
 */
/**
 * Codex round 5 on PR #188 [high]: subset-match comparator used by
 * `globalSettingsRepo.updateAtomic`'s optimistic-concurrency check.
 *
 *   - `expected === null` ⇔ "no row should exist". Matches only when
 *     `locked === null` (covers both SQL NULL and the placeholder
 *     'null'::jsonb that updateAtomic INSERTs before the FOR UPDATE).
 *   - `expected = { k1: v1, ... }` ⇔ for each key in `expected`, the
 *     corresponding key in `locked` must deep-equal that value. Extra
 *     keys in `locked` (e.g. `provider` stamped by round-5 writes when
 *     the caller only observed `model`) are allowed. This is the
 *     key behavioral change that lets the LLM settings helper grow
 *     the persisted jsonb shape without breaking clients that observed
 *     only the older shape.
 *
 * Equality on nested values is JSON-canonical (`JSON.stringify`
 * after a stable key sort). All values stored in `global_settings` so
 * far are plain JSON (no functions, dates, etc.), so this is safe.
 */
function matchesExpected(
  locked: unknown,
  expected: Record<string, unknown> | null,
): boolean {
  if (expected === null) {
    // "Expect no row" — locked must be one of the null shapes.
    return locked === null;
  }
  if (locked === null || typeof locked !== 'object') {
    // Caller asked for fields; locked has none to offer.
    return false;
  }
  const lockedObj = locked as Record<string, unknown>;
  for (const k of Object.keys(expected)) {
    if (canonicalize(lockedObj[k]) !== canonicalize(expected[k])) {
      return false;
    }
  }
  return true;
}

function canonicalize(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      o[k] = sortKeys((v as Record<string, unknown>)[k]);
    }
    return o;
  }
  return v;
}

export const globalSettingsRepo = {
  /**
   * Read a single global setting by key. Returns null if the key is not
   * set (caller must apply its own default — for LLM models, that's the
   * env var fallback). Caller-tolerant of DB errors via the surrounding
   * try/catch in `getCurrent*Model` (DB hiccup → env default rather than
   * blocking the LLM call).
   */
  async getByKey(key: string): Promise<{ value: unknown; updated_at: Date; updated_by: string | null } | null> {
    const rows = await db
      .select()
      .from(global_settings)
      .where(eq(global_settings.key, key))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return { value: row.value, updated_at: row.updated_at, updated_by: row.updated_by };
  },

  /**
   * Atomic multi-key update + audit. All keys are upserted under a single
   * tx with `SELECT ... FOR UPDATE` on each row (serializes concurrent
   * founders). Audit row sees the REAL before/after under the lock — not a
   * stale pre-tx snapshot. If the audit insert throws, every upsert rolls
   * back together.
   *
   * Steps inside the tx:
   *   1. For each key, first `INSERT ... ON CONFLICT DO NOTHING` with a
   *      JSON-null placeholder, then `SELECT value FROM global_settings
   *      WHERE key = $1 FOR UPDATE` — Codex round 2 [P2] showed that
   *      without the placeholder, `FOR UPDATE` on a non-existent row
   *      doesn't take any lock, so two concurrent first-writers on a
   *      fresh deploy could both read null and both UPSERT, producing
   *      audit rows whose `before`/`after` don't match the committed DB
   *      state. The placeholder INSERT serializes the race because the
   *      conflict path waits on the inserting tx's row-level lock; the
   *      subsequent SELECT FOR UPDATE then holds the lock for the rest
   *      of this tx. Concurrent writers wait here.
   *   2. Compute `before[key]` from the locked value (JSON null and SQL
   *      NULL both coalesce to JS null — pre-062 rows and the new
   *      placeholder look identical to callers).
   *   3. For each key where `before !== requested`, UPSERT new value with
   *      `updated_at = now`, `updated_by = audit.actor_id`.
   *   4. If NO key actually changed, return `{ ok:false, reason:'no_changes', before }`
   *      so the caller can map to BAD_REQUEST without polluting the audit
   *      log with a no-op row.
   *   5. INSERT admin_audit_log with `action`, `change_summary={ before, after, ...meta }`.
   *      If this throws, ROLLBACK reverts every UPSERT (atomicity invariant
   *      matching `tenantsRepo.updateStatusAtomic`).
   *
   * `meta` is merged into `change_summary` so the caller can stamp extra
   * fields (operator comment, scope label, etc.) without us hardcoding a
   * schema that future callers won't need.
   */
  async updateAtomic(input: {
    keys: ReadonlyArray<{
      key: string;
      value: Record<string, unknown>;
      // Codex round 3 on PR #188 [P2]: optional optimistic-concurrency
      // pre-check. When set, the locked value MUST match `expected`
      // or the whole tx aborts with `reason: 'optimistic_conflict'`. The
      // check runs INSIDE the tx, AFTER the SELECT ... FOR UPDATE, so
      // it's race-free against concurrent writers. `expected = null`
      // means "expect the key to be unset"; `expected = undefined` (or
      // omitted) means "no expectation, proceed unconditionally".
      //
      // Codex round 5 on PR #188 [high]: the comparison semantic is
      // "expected is a key-subset of locked" — every field in
      // `expected` must equal the same field in `lockedValue`, but
      // locked may have additional fields. This lets writes that grow
      // the persisted shape (e.g. adding `provider` alongside `model`)
      // keep accepting clients that observed only the old shape. If a
      // caller wants strict full-shape equality, pass every locked-
      // shape field in `expected`.
      expected?: Record<string, unknown> | null;
    }>;
    audit: {
      tenant_id: string;
      actor_id: string;
      actor_role: string;
      action: string;
      resource_type: string;
      resource_id?: string | null;
      meta?: Record<string, unknown>;
    };
  }): Promise<
    | {
        ok: true;
        applied_at: Date;
        before: Record<string, unknown>;
        after: Record<string, unknown>;
      }
    | {
        ok: false;
        reason: 'no_changes';
        before: Record<string, unknown>;
      }
    | {
        ok: false;
        reason: 'optimistic_conflict';
        // Identify the FIRST key that failed the expected check (sorted
        // key order — same order as the lock acquisition).
        key: string;
        expected: Record<string, unknown> | null;
        current: unknown;
        // Full `before` snapshot of all keys read up to the conflict
        // point. Callers use this to render a useful UI message.
        before: Record<string, unknown>;
      }
  > {
    return await withTx(async (tx) => {
      const now = new Date();
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      let changedCount = 0;
      let conflict:
        | {
            key: string;
            expected: Record<string, unknown> | null;
            current: unknown;
          }
        | null = null;

      // (1) Lock each row FOR UPDATE in deterministic key order. Sorting
      // the keys before locking prevents two concurrent updates that touch
      // an overlapping set of keys from deadlocking each other (a holds
      // main waiting for fast, b holds fast waiting for main). Same trick
      // we use elsewhere in the codebase for multi-row locks.
      const sortedKeys = [...input.keys].sort((a, b) => a.key.localeCompare(b.key));

      for (const entry of sortedKeys) {
        // Codex round 2 on PR #188 [P2]: `SELECT ... FOR UPDATE` does NOT
        // lock a row that doesn't exist. Migration 062 ships the
        // `global_settings` table empty, so two concurrent founders on a
        // fresh deploy could both read `null` here, both UPSERT, and end
        // up with an audit row whose `before` claims null but whose
        // `after` reflects only one founder's input — the same forensic-
        // gap class as round 1 [medium]. Fix: insert a placeholder row
        // via ON CONFLICT DO NOTHING BEFORE the FOR UPDATE select. The
        // placeholder uses `'null'::jsonb` as the value so the lineage
        // starts at literal null (not at a fake string) — `before[key]`
        // computed below honors that. Once the row exists, the FOR
        // UPDATE on the next select actually serializes concurrent txs.
        await tx.execute(sql`
          INSERT INTO ${global_settings} (key, value, updated_at, updated_by)
          VALUES (${entry.key}, 'null'::jsonb, now(), ${input.audit.actor_id})
          ON CONFLICT (key) DO NOTHING
        `);

        const locked = await tx
          .select()
          .from(global_settings)
          .where(eq(global_settings.key, entry.key))
          .for('update')
          .limit(1);
        // Treat the placeholder JSON null exactly like a never-set row so
        // existing callers (and the "no_changes" check below) keep the
        // null-as-absent semantics. With the placeholder INSERT above the
        // row now always exists, but its value can be SQL NULL (legacy
        // pre-062 rows, if any) OR JSON null (placeholder from this tx)
        // OR a real `{model: "..."}` payload (a prior committed write).
        // Both null shapes coalesce to JS `null` here.
        const lockedValue = locked[0]?.value ?? null;
        before[entry.key] = lockedValue;
        after[entry.key] = entry.value;

        // Codex round 3 on PR #188 [P2]: optimistic-concurrency check.
        // If the caller supplied `expected`, compare against the LOCKED
        // value (NOT the pre-tx snapshot — same reason the rest of this
        // function reads under FOR UPDATE). On mismatch we don't break
        // the loop yet: we continue locking remaining keys so all
        // subsequent rows get released cleanly when the tx aborts via
        // throw, and so `before` is populated for the response. The
        // throw below converts the conflict into the typed return
        // shape after the loop.
        //
        // Codex round 5 [high]: comparison is "expected is a key-subset
        // of locked" — every key present in `expected` must match the
        // same key in `lockedValue`, but lockedValue may have extra
        // keys. This lets the LLM settings helper grow the persisted
        // shape (adding `provider` next to `model`) without breaking
        // optimistic-conflict checks from clients that observed only
        // the older `{ model }` shape. The two edge cases (expected
        // === null and locked === null) keep their original strict
        // equality — those signal "no row" and must match exactly.
        if (
          entry.expected !== undefined &&
          conflict === null &&
          !matchesExpected(lockedValue, entry.expected)
        ) {
          conflict = {
            key: entry.key,
            expected: entry.expected,
            current: lockedValue,
          };
          // Don't break: finish locking so `before` is complete and the
          // tx rolls back the placeholder INSERTs uniformly. We skip
          // the upsert below by short-circuiting on `conflict !== null`.
          continue;
        }

        // If a prior key conflicted, don't write this one either —
        // we're going to abort below.
        if (conflict !== null) continue;

        // Deep-equal comparison via JSON canonicalization. Both sides are
        // simple JSON (no functions, no Dates) so JSON.stringify is a safe
        // canonical form. Skipping the UPSERT when the value matches avoids
        // a wasted write AND keeps `updated_at` honest (it should reflect
        // the last actual change, not a no-op renew).
        if (JSON.stringify(lockedValue) === JSON.stringify(entry.value)) {
          continue;
        }

        await tx
          .insert(global_settings)
          .values({
            key: entry.key,
            value: entry.value,
            updated_at: now,
            updated_by: input.audit.actor_id,
          })
          .onConflictDoUpdate({
            target: [global_settings.key],
            set: {
              value: entry.value,
              updated_at: now,
              updated_by: input.audit.actor_id,
            },
          });
        changedCount++;
      }

      // (2) Optimistic-conflict abort. We did NOT call the upsert for the
      // conflicting key (or any subsequent key), so the only DB effect
      // inside this tx is the placeholder INSERTs from step (1) — those
      // are harmless on rollback. We do NOT write the audit row because
      // there's no real state change to record.
      if (conflict !== null) {
        // Throw to force a rollback of the placeholder INSERTs above.
        // The withTx wrapper catches and re-raises, so we package the
        // typed payload as a non-Error sentinel that updateAtomic itself
        // unwraps. But the simpler path here: since we haven't UPSERTED
        // anything, the placeholder INSERTs of a NULL jsonb are
        // observationally equivalent to "key was never set" for the
        // null-as-absent semantics callers rely on. Still, we rely on
        // rollback for correctness if any side effects existed.
        throw new ConflictAbortSignal({
          key: conflict.key,
          expected: conflict.expected,
          current: conflict.current,
          before,
        });
      }

      if (changedCount === 0) {
        // No real change under the lock → caller can map to BAD_REQUEST.
        // The tx will commit empty (no audit row, no upsert) — cheap and
        // honest. Returning `before` lets the caller surface what's
        // currently in DB if it wants to.
        return { ok: false as const, reason: 'no_changes' as const, before };
      }

      // (3) Audit in the SAME tx. before/after here are the REAL locked
      // values, not whatever the caller read pre-tx — so concurrent
      // founders can't corrupt the audit trail.
      await tx.insert(admin_audit_log).values({
        tenant_id: input.audit.tenant_id,
        actor_id: input.audit.actor_id,
        actor_role: input.audit.actor_role,
        action: input.audit.action,
        resource_type: input.audit.resource_type,
        resource_id: input.audit.resource_id ?? null,
        change_summary: {
          before,
          after,
          ...(input.audit.meta ?? {}),
        },
      });

      return { ok: true as const, applied_at: now, before, after };
    }).catch((err: unknown) => {
      // Unwrap the optimistic-conflict sentinel into the typed return.
      // Any other error (DB, audit-insert FK violation, etc.) is a real
      // failure — propagate it so callers preserve the atomicity
      // invariant: a thrown error means NO state changed.
      if (err instanceof ConflictAbortSignal) {
        return {
          ok: false as const,
          reason: 'optimistic_conflict' as const,
          key: err.payload.key,
          expected: err.payload.expected,
          current: err.payload.current,
          before: err.payload.before,
        };
      }
      throw err;
    });
  },
};

// Sentinel used to abort the withTx callback when an optimistic check
// fails. Throwing inside withTx is the standard way to force a ROLLBACK;
// catching this specific type lets us convert the rollback into a typed
// `{ ok: false, reason: 'optimistic_conflict' }` return without leaking
// the throw to callers. Not exported — the conflict path is observable
// via the discriminated union only.
class ConflictAbortSignal {
  constructor(
    public readonly payload: {
      key: string;
      expected: Record<string, unknown> | null;
      current: unknown;
      before: Record<string, unknown>;
    },
  ) {}
}

// P9a — re-export skillsRepo from control-plane/skill-registry. Convention:
// `repositories.ts` é o ponto único de import para callers; `control-plane/`
// hospeda a implementação propriamente dita (Source of Truth + Admin UI).
// Ver `src/control-plane/skill-registry/skills-repo.ts`.
export { skillsRepo } from '@/control-plane/skill-registry/index.js';
export type { SkillsRepo, ProposeInput as SkillProposeInput } from '@/control-plane/skill-registry/index.js';
