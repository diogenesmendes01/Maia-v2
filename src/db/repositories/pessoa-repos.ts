import { eq, and, sql, inArray, asc } from 'drizzle-orm';
import { db, withTx, pgErrorCode } from '../client.js';
import {
  pessoas,
  agent_audience_profiles,
  agent_tool_grants,
  permissoes,
  permission_profiles,
  admin_audit_log,
} from '../schema.js';
import { applyTenantGuard } from '../tenant-guard.js';
import { getCurrentTenant, getCurrentAgent } from '../tenant-context.js';
import type {
  Pessoa,
  AgentAudienceProfile,
  NewAgentAudienceProfile,
  AgentToolGrantRow,
  NewAgentToolGrant,
  Permissao,
  PermissionProfile,
} from '../schema.js';

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

  /**
   * Read-modify-write the grant AND append its admin_audit_log row in ONE
   * transaction — "audit every decision": a failed audit insert rolls the
   * grant back. Same contract family as channelsRepo.createWithAudit
   * (PR #491 review): explicit tenant/agent args (no ALS).
   *
   * PR #494 review [medium] — the CURRENT row is read INSIDE the tx under
   * `SELECT ... FOR UPDATE`, and the caller supplies a PURE `compute`
   * function instead of a precomputed grant. Without the lock, two writers
   * (e.g. /setup/mcp toggling a pack while the capabilities modal saves)
   * could read the same snapshot and the last full-array upsert would clobber
   * the other's change — and the audit `previous` would record the stale
   * snapshot rather than the value actually replaced.
   *
   * `compute` MUST be synchronous and side-effect free. Returning
   * `{ ok: false, reject }` aborts with rollback (nothing written) and the
   * opaque `reject` payload is surfaced to the caller for error mapping.
   *
   * First-write race (no row to lock yet): two concurrent inserts collide on
   * the (tenant, agent) UNIQUE — the loser retries the whole tx once, now
   * serialized by the winner's row.
   */
  async updateWithAudit(args: {
    tenant_id: string;
    agent_id: string;
    compute: (current: AgentToolGrantRow | null) =>
      | {
          ok: true;
          granted_packs: string[];
          granted_tools: string[];
          denied_tools: string[];
        }
      | { ok: false; reject: unknown };
    granted_by: string;
    reason: string;
    audit: {
      actor_id: string;
      actor_role: string;
      action: string;
    };
  }): Promise<
    | { ok: true; grant: AgentToolGrantRow }
    | { ok: false; reject: unknown }
  > {
    const attempt = () =>
      withTx(async (tx) => {
        const currentRows = await tx
          .select()
          .from(agent_tool_grants)
          .where(
            and(
              eq(agent_tool_grants.tenant_id, args.tenant_id),
              eq(agent_tool_grants.agent_id, args.agent_id),
            ),
          )
          .limit(1)
          .for('update');
        const current = currentRows[0] ?? null;

        const next = args.compute(current);
        if (!next.ok) return next;

        // Deliberately NOT an upsert: with the row locked, an existing grant
        // takes the UPDATE path; a missing grant takes a PLAIN insert so a
        // concurrent first-writer collides on the (tenant, agent) UNIQUE and
        // hits the 23505 retry below. An ON CONFLICT DO UPDATE here would
        // let the loser silently overwrite the winner with a compute(null)
        // result — the exact lost-update this helper exists to prevent.
        const [row] = current
          ? await tx
              .update(agent_tool_grants)
              .set({
                granted_packs: next.granted_packs,
                granted_tools: next.granted_tools,
                denied_tools: next.denied_tools,
                granted_by: args.granted_by,
                reason: args.reason,
                updated_at: new Date(),
              })
              .where(
                and(
                  eq(agent_tool_grants.tenant_id, args.tenant_id),
                  eq(agent_tool_grants.agent_id, args.agent_id),
                ),
              )
              .returning()
          : await tx
              .insert(agent_tool_grants)
              .values({
                tenant_id: args.tenant_id,
                agent_id: args.agent_id,
                granted_packs: next.granted_packs,
                granted_tools: next.granted_tools,
                denied_tools: next.denied_tools,
                granted_by: args.granted_by,
                reason: args.reason,
              })
              .returning();
        if (!row) {
          throw new Error('grant_update_with_audit_upsert_failed: returning() empty');
        }
        await tx.insert(admin_audit_log).values({
          tenant_id: args.tenant_id,
          actor_id: args.audit.actor_id,
          actor_role: args.audit.actor_role,
          action: args.audit.action,
          resource_type: 'agent_tool_grant',
          resource_id: args.agent_id,
          change_summary: {
            agent_id: args.agent_id,
            previous: current
              ? {
                  granted_packs: current.granted_packs,
                  granted_tools: current.granted_tools,
                  denied_tools: current.denied_tools,
                }
              : null,
            next: {
              granted_packs: next.granted_packs,
              granted_tools: next.granted_tools,
              denied_tools: next.denied_tools,
            },
            reason: args.reason,
          },
        });
        return { ok: true as const, grant: row };
      });

    try {
      return await attempt();
    } catch (err) {
      // Concurrent FIRST write: both saw no row (nothing to lock), the loser
      // hits the (tenant, agent) UNIQUE. One retry is now serialized by the
      // winner's committed row.
      if (pgErrorCode(err) === '23505') {
        return attempt();
      }
      throw err;
    }
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
  /**
   * Issue #511 — batch sibling of `byId`, replacing the per-permission lookup
   * loop in `resolveScope` (`src/governance/permissions.ts`).
   *
   * TENANT-SCOPED, unlike `byId`. `permission_profiles` carries NOT NULL
   * `tenant_id` + `agent_id` (schema `src/db/schema.ts` `permission_profiles`),
   * and a profile is what decides which ACTIONS and which SPEND LIMIT a person
   * gets — reading one by id alone would let a `permissoes` row pointing at a
   * foreign profile id resolve to that other tenant's action list. `byId` is
   * left unscoped for now (its only remaining caller is the interactive
   * `scripts/pessoa-add.ts`, which runs outside a tenant frame); the hot path
   * moves here, so the turn now resolves scope under an exact tenant predicate.
   *
   * Missing ids are simply absent from the result — the caller decides what an
   * unresolvable profile means. `resolveScope` skips the permission entirely,
   * which is the fail-closed reading: no profile, no grant.
   *
   * Deterministic ordering by id (the same permission set must render the same
   * prompt every turn) and an explicit row cap so one tenant cannot make a
   * single statement unbounded.
   */
  async byIds(ids: string[], limit = 500): Promise<PermissionProfile[]> {
    if (ids.length === 0) return [];
    const tenant_id = getCurrentTenant();
    const agent_id = getCurrentAgent();
    return db
      .select()
      .from(permission_profiles)
      .where(
        and(
          eq(permission_profiles.tenant_id, tenant_id),
          eq(permission_profiles.agent_id, agent_id),
          inArray(permission_profiles.id, Array.from(new Set(ids))),
        ),
      )
      .orderBy(asc(permission_profiles.id))
      .limit(limit);
  },
  async list(): Promise<PermissionProfile[]> {
    return db.select().from(permission_profiles);
  },
};
