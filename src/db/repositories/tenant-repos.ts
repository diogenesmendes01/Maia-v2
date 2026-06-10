import { eq, and, desc } from 'drizzle-orm';
import { db, withTx, pgErrorCode } from '../client.js';
import {
  self_state,
  tenants,
  agents,
  agent_tool_grants,
  agent_operational_profile_versions,
  admin_audit_log,
} from '../schema.js';
import { BASE_AGENT_PACKS } from '@/tools/base-agent-packs.js';
import { TypedError } from '@/lib/utils.js';
import { getCurrentTenant, getCurrentAgent } from '../tenant-context.js';
import type {
  SelfState,
  Tenant,
  Agent,
  AgentOperationalProfileVersion,
  ProfileBody,
} from '../schema.js';
import { validateProfileBodyP8d } from './profile-internal.js';

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
   * Every runtime agent receives the `BASE_AGENT_PACKS` floor: `baseline.core`
   * (the conservative read/recall/confirm/audit/escalate set) PLUS the
   * platform-default domain packs (`PLATFORM_DEFAULT_DOMAIN_PACKS`, currently
   * `domain.calendar`). OTHER domain packs are NEVER default; they are granted
   * explicitly.
   *
   * #408 PERSISTS that default grant: step (3) below inserts the agent's
   * `agent_tool_grants` row (`granted_packs=[...BASE_AGENT_PACKS]`) IN THE SAME
   * TX as the agent + seed profile, so an agent never exists without a grant (a
   * grant-less agent would fail-closed to the floor at runtime). The pack-id
   * list comes from the zero-import leaf `src/tools/base-agent-packs.ts`, so
   * this hot-path repo module stays free of the tools-registry/gateway import
   * chain (a unit test pins the seeded row against `BASE_AGENT_PACKS`).
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
    /**
     * Issue #470 — archetype wiring. Extra domain packs composed on top of
     * BASE_AGENT_PACKS at creation (deduped). The CALLER resolves archetype →
     * packs (src/tools/archetype-packs.ts); this repo stays free of that
     * vocabulary and only persists what it is told, atomically.
     */
    grant?: {
      extra_packs: string[];
      archetype: string | null;
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
        //     agent gets `granted_packs=[...BASE_AGENT_PACKS]` (baseline.core +
        //     domain.calendar); OTHER domain packs are NEVER default. Without this, the agent
        //     would have no grant row and the runtime filter would fail-closed
        //     to zero tools. Literal pack id kept in sync with
        //     `DEFAULT_AGENT_PACKS` (parity pinned by a unit test). No
        //     applyTenantGuard: tenant_id/agent_id are explicit and match the
        //     agent row just inserted.
        const grantedPacks = [
          ...new Set([...BASE_AGENT_PACKS, ...(args.grant?.extra_packs ?? [])]),
        ];
        await tx.insert(agent_tool_grants).values({
          tenant_id: args.agent.tenant_id,
          agent_id: createdAgent.id,
          granted_packs: grantedPacks,
          granted_by: args.audit.actor_id,
          reason: args.grant?.archetype
            ? `arquétipo '${args.grant.archetype}' + BASE_AGENT_PACKS (agent creation, issues #408/#470)`
            : 'BASE_AGENT_PACKS default grant (agent creation, issue #408)',
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
            // Issue #410/#408/#470 — the tool-pack grant PERSISTED in step (3):
            // BASE_AGENT_PACKS + archetype extras (deduped). Sourced from
            // import-free leaves (base-agent-packs.ts, archetype-packs.ts via
            // the caller) so this repo module stays free of the
            // tools-registry/gateway import chain.
            granted_packs: grantedPacks,
            archetype: args.grant?.archetype ?? null,
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
