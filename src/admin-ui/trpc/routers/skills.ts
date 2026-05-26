/**
 * Admin UI — Skills Management router (Phase 2: READ; Phase 3: MUTATIONS).
 *
 * Read endpoints for the /skills screen, surfacing the `skills` table (P9a
 * Skill Registry) so operators can list/view versioned, tenant/agent-scoped
 * Skill Contracts instead of hand-writing SQL:
 *   - list         — SUMMARY rows for the tenant/agent (no large JSONB), capped,
 *                    plus a `hasMore` truncation signal when the cap is hit
 *   - getById      — the full contract for one skill row
 *   - listVersions — every version of a descriptor in an EXACT scope (newest
 *                    first); the caller passes the selected row's agent_id
 *                    (nullable = tenant-wide) so scopes never mix
 *   - runtimeFlag  — what value of FEATURE_SKILL_REGISTRY_V1 THIS admin-ui
 *                    process sees (drives the "managed here but verify on
 *                    maia-app" banner). NOTE: admin-ui and maia-app are
 *                    separate containers, so this only reflects admin-ui's own
 *                    env — it is NOT maia-app's runtime state.
 *
 * Phase 3 — lifecycle MUTATIONS (this commit):
 *   - propose      — author a new skill version (status='proposed') directly via
 *                    skillsRepo.propose (the operator-authored path; NOT the
 *                    capability_proposals approval flow — spec §2.2 locked).
 *   - activate     — flip proposed→active (deprecates the prior active atomically)
 *   - deprecate    — mark active/proposed as deprecated
 *   - rollback     — mark active as rolled_back + reactivate the prior version
 *
 * Authoring path (spec §2.2 locked decision): direct skillsRepo, NOT the
 * capability_proposals matrix. Activation duties (spec §2 open-decision 3,
 * "solo operator" answer): `founder` may BOTH propose AND activate — there is
 * NO separation of duties in v1. ALL mutations are therefore gated to a single
 * role (`founder`) via ctx.assertRole('founder'), which keeps it trivial to
 * widen the matrix later by editing one constant.
 *
 * Every mutation writes an admin_audit_log row (action skill_proposed /
 * skill_activated / skill_deprecated / skill_rolled_back), mirroring the audit
 * posture of channelPolicies/tenants. The repo's activate/rollback are already
 * transactional internally; we append the audit row immediately after the repo
 * call succeeds (the repo does not expose its withTx to callers).
 *
 * Tenant scoping mirrors capabilities.ts: tenant is resolved from the session
 * via resolveTenantId (founders may target any tenant; everyone else is pinned
 * to their own), and every repo call runs inside runWithTenantContext so the
 * repo's tenant + agent guards apply. Any authenticated role may read; only
 * `founder` may mutate.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { config } from '@/config/env.js';
import { router, protectedProcedure } from '../server.js';
import { resolveTenantId } from '../tenant-resolver.js';
import { runWithTenantContext } from '../../../db/tenant-context.js';
import { TOOL_CATALOG } from '../../generated/tool-catalog.js';
import { isToolEnabledByFlag } from '../tool-enablement.js';

/**
 * Server-side set of currently-ENABLED tool names (PR #213 FIX 3; round-2 FIX B).
 *
 * Reuses the SAME side-effect-free building blocks as the Tools Catalog router:
 * the generated `TOOL_CATALOG` (static metadata incl. each tool's gating
 * `feature_flag` NAME) + the SHARED, import-safe `isToolEnabledByFlag` helper.
 *
 * Round-2 FIX B: the enabled set is now computed PER CALL (not once at module
 * load) and resolves each declared `FeatureFlagName` flag through the runtime
 * `featureFlags.isEnabled()` path — the SAME gate the dispatcher uses — so a
 * tool disabled by a runtime kill switch / override is rejected by `propose`
 * even when static `config.FEATURE_*` still has the flag on. (The previous
 * module-load snapshot read static config, which DIVERGED from dispatch.)
 * Importing this still pulls in ZERO tool handlers / gateway code — see
 * `tool-enablement.ts` for the import-safety + cross-container caveat.
 */
function enabledToolNames(): ReadonlySet<string> {
  return new Set(
    TOOL_CATALOG.filter((t) => isToolEnabledByFlag(t.feature_flag)).map((t) => t.name),
  );
}

/**
 * Single role gate for ALL skill mutations (spec §2 open-decision 3 — "solo
 * operator": founder both proposes AND activates, no separation of duties).
 * Kept as one constant so widening the matrix later (e.g. let `owner` propose)
 * is a one-line change.
 */
const MUTATION_ROLE = 'founder' as const;

/** skills.category enum — mirrors the DB check constraint (schema.ts:1952). */
const SkillCategory = z.enum([
  'classify',
  'extract',
  'compose',
  'decide',
  'tool_mediated',
  'diagnose',
  'plan',
  'evaluator',
]);

/** skills.execution_mode enum — mirrors the DB check constraint (schema.ts:1956). */
const SkillExecutionMode = z.enum([
  'prompt_only',
  'procedure_adapter',
  'tool_mediated',
  'evaluator',
]);

/** runtime_hints (SkillRuntimeHints, schema.ts:1975) — all optional numerics + preferred_model. */
const RuntimeHintsSchema = z
  .object({
    max_prompt_tokens: z.number().int().positive().optional(),
    max_output_tokens: z.number().int().positive().optional(),
    max_tool_calls: z.number().int().nonnegative().optional(),
    preferred_model: z.string().min(1).optional(),
    timeout_ms: z.number().int().positive().optional(),
  })
  .strict();

// jsonb objects/arrays arrive as already-parsed JSON from the client (the form
// parses its textareas). Keep the value-shape permissive (the repo persists
// them verbatim) but anchor the container types so a string/number can't be
// smuggled into an object/array column.
const JsonObject = z.record(z.string(), z.unknown());
const JsonObjectArray = z.array(z.record(z.string(), z.unknown()));

/**
 * SkillContractInputSchema — mirrors SkillContract (schema.ts:1988) plus the
 * proposed_reason audit field. Cross-field rule (spec §2.3, mirrors
 * skills-repo.ts propose validation): execution_mode='evaluator' ⇒ allowed_tools
 * MUST be empty. Enforced here with superRefine so the form AND any direct tRPC
 * caller are rejected at the validation boundary, not only deep in the repo.
 */
const SkillContractInputSchema = z
  .object({
    tenantId: z.string().optional(),
    // Target agent scope. The repo derives agent_id from the tenant context, so
    // this is BOTH the runWithTenantContext agent and the skill's agent_id.
    agentId: z.string().min(1),
    skill_descriptor: z.string().min(1).max(200),
    category: SkillCategory,
    execution_mode: SkillExecutionMode,
    goal: z.string().min(1),
    when_to_use: z.string().min(1),
    procedure: JsonObject,
    constraints: JsonObjectArray.default([]),
    input_schema: JsonObject,
    output_schema: JsonObject,
    allowed_tools: z.array(z.string().min(1)).default([]),
    policy_descriptors: z.array(z.string().min(1)).default([]),
    success_criteria: JsonObjectArray.default([]),
    failure_modes: JsonObjectArray.default([]),
    runtime_hints: RuntimeHintsSchema.default({}),
    // Audit reason. Trim BEFORE min(10) so a whitespace-only reason is rejected
    // at the server (the audit boundary), mirroring llmSettings' comment field.
    proposed_reason: z
      .string()
      .trim()
      .min(10, 'proposed_reason must be at least 10 non-whitespace characters')
      .max(2000),
  })
  .superRefine((val, ctx) => {
    if (val.execution_mode === 'evaluator' && val.allowed_tools.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allowed_tools'],
        message:
          'evaluator_mode_disallows_tools: skills with execution_mode=evaluator must have empty allowed_tools',
      });
    }
  });

/** Shared input for the id+reason lifecycle mutations (activate/deprecate/rollback). */
const LifecycleInput = z.object({
  id: z.string().min(1),
  tenantId: z.string().optional(),
  // The selected row's agent scope (its own agent_id). The repo rejects a
  // cross-agent / tenant-wide mutation from agent context, so this must be the
  // skill's actual agent. (Tenant-wide skills are out of scope for the UI's
  // agent-context mutations — the repo rejects agent_id=null mutations.)
  agentId: z.string().min(1),
  reason: z
    .string()
    .trim()
    .min(10, 'reason must be at least 10 non-whitespace characters')
    .max(2000),
});

/**
 * Map a skillsRepo error (plain Error with a typed message prefix) to the right
 * TRPCError code. The repo throws Error(`<code>: ...`) for its typed failures:
 *   - not_found                       → NOT_FOUND
 *   - cannot_activate_from_<status>   → CONFLICT (target not in 'proposed')
 *   - cannot_deprecate_from_<status>  → CONFLICT (target not in active/proposed)
 *   - cannot_rollback_from_<status>   → CONFLICT (target not 'active')
 *   - agent_scope_violation           → FORBIDDEN (cross-agent target)
 *   - tenant_admin_required           → FORBIDDEN (tenant-wide needs admin path)
 *   - tenant mismatch                 → FORBIDDEN
 *   - evaluator_mode_disallows_tools  → BAD_REQUEST (also caught by zod)
 *   - disabled_tools_not_allowed      → BAD_REQUEST (allowed_tools has off/unknown tool)
 * Anything else surfaces as INTERNAL_SERVER_ERROR with the original message.
 */
function mapRepoError(err: unknown): TRPCError {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('skill_not_found')) {
    return new TRPCError({ code: 'NOT_FOUND', message: 'Skill not found' });
  }
  if (message.includes('cannot_activate_from_')) {
    return new TRPCError({
      code: 'CONFLICT',
      message:
        'Skill is not in the proposed state — it may have been activated, ' +
        'deprecated, or rolled back already. Refresh and retry.',
    });
  }
  // PR #213 FIX 2: lifecycle-guard conflicts from deprecate/rollback. The repo's
  // status-conditioned UPDATE affected 0 rows because the row was in an invalid
  // state (e.g. already deprecated / rolled_back) — surface as CONFLICT so the
  // UI re-fetches instead of silently no-op'ing.
  if (
    message.includes('cannot_deprecate_from_') ||
    message.includes('cannot_rollback_from_')
  ) {
    return new TRPCError({
      code: 'CONFLICT',
      message:
        'Skill is not in a state that allows this transition — it may have ' +
        'changed status already. Refresh and retry.',
    });
  }
  if (
    message.includes('agent_scope_violation') ||
    message.includes('tenant_admin_required') ||
    message.startsWith('tenant mismatch')
  ) {
    return new TRPCError({ code: 'FORBIDDEN', message });
  }
  if (
    message.includes('evaluator_mode_disallows_tools') ||
    message.includes('disabled_tools_not_allowed')
  ) {
    return new TRPCError({ code: 'BAD_REQUEST', message });
  }
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message });
}

// Server-enforced cap mirrors skillsRepo.SKILLS_LIST_MAX_LIMIT (review PR #209
// finding 2). The router never asks the repo for more than the cap; the repo
// also clamps defensively.
const LIST_LIMIT_CAP = 200;

const ListInput = z.object({
  tenantId: z.string().optional(),
  agentId: z.string(),
  status: z.enum(['proposed', 'active', 'deprecated', 'rolled_back']).optional(),
  limit: z.number().int().positive().max(LIST_LIMIT_CAP).optional(),
});

const GetByIdInput = z.object({
  id: z.string(),
  tenantId: z.string().optional(),
  agentId: z.string(),
});

const ListVersionsInput = z.object({
  descriptor: z.string(),
  tenantId: z.string().optional(),
  // The agent scope of the SELECTED row (review PR #209 finding 3). Pass the
  // row's own agent_id — null for a tenant-wide skill — so version history is
  // scope-exact and never blends agent-scoped + tenant-wide rows that happen
  // to share a descriptor. This is the runWithTenantContext agent too.
  agentId: z.string().nullable(),
});

export const skillsRouter = router({
  /**
   * SUMMARY rows for the tenant/agent, optionally filtered by status, capped at
   * LIST_LIMIT_CAP (review PR #209 finding 2). Returns only the table columns
   * (no large JSONB) — the full contract is fetched per-row via getById.
   *
   * Review PR #209 finding A: also returns `hasMore` so the UI can warn when the
   * result was truncated at the cap instead of silently dropping skills. The
   * repo fetches limit+1 rows to compute this cheaply (no full cursor
   * pagination — out of scope at this volume); narrow the filter (agent/status)
   * to see the rest.
   */
  list: protectedProcedure.input(ListInput).query(async ({ input, ctx }) => {
    const tenantId = resolveTenantId(ctx, input.tenantId);
    const limit = Math.min(input.limit ?? LIST_LIMIT_CAP, LIST_LIMIT_CAP);
    const { items, hasMore } = await runWithTenantContext(
      { tenant_id: tenantId, agent_id: input.agentId },
      async () => ctx.repos.skillsRepo.listSummariesPage(input.status, limit),
    );
    return { items, hasMore };
  }),

  /** The full contract for a single skill row (or null when not visible). */
  getById: protectedProcedure.input(GetByIdInput).query(async ({ input, ctx }) => {
    const tenantId = resolveTenantId(ctx, input.tenantId);
    const item = await runWithTenantContext(
      { tenant_id: tenantId, agent_id: input.agentId },
      async () => ctx.repos.skillsRepo.getById(input.id),
    );
    return { item };
  }),

  /**
   * Every version of a descriptor in an EXACT scope, newest first (review PR
   * #209 finding 3). The caller passes the selected row's agentId (null =
   * tenant-wide); we both scope the repo query to it AND use it as the context
   * agent so agent-scoped and tenant-wide rows that share a descriptor never
   * mix. For a tenant-wide row the context agent is unused by the scope filter
   * (it matches agent_id IS NULL), so a placeholder context agent is fine.
   */
  listVersions: protectedProcedure
    .input(ListVersionsInput)
    .query(async ({ input, ctx }) => {
      const tenantId = resolveTenantId(ctx, input.tenantId);
      const contextAgent = input.agentId ?? '__tenant_wide__';
      const items = await runWithTenantContext(
        { tenant_id: tenantId, agent_id: contextAgent },
        async () => ctx.repos.skillsRepo.listVersions(input.descriptor, input.agentId),
      );
      return { items };
    }),

  /**
   * runtimeFlag — review PR #209 finding 1.
   *
   * Returns the value of FEATURE_SKILL_REGISTRY_V1 as seen by THIS admin-ui
   * process's own env config. admin-ui and maia-app run in separate containers
   * with independent env, so this CANNOT report maia-app's runtime state — it
   * only tells operators what this admin-ui is configured with. The flag gates
   * skill *execution* on maia-app (SkillRunner gate 1), not data management
   * here; the page banner makes the "verify on maia-app" caveat explicit.
   *
   * `adminUiSkillRegistryEnabled` is the honest, source-scoped field name.
   */
  runtimeFlag: protectedProcedure.query(() => {
    return { adminUiSkillRegistryEnabled: config.FEATURE_SKILL_REGISTRY_V1 };
  }),

  /**
   * propose — author a NEW skill version (status='proposed') via the direct
   * skillsRepo path (spec §2.2 locked: NOT capability_proposals). Founder-only
   * (MUTATION_ROLE) — "solo operator", no separation of duties.
   *
   * The cross-field evaluator/allowed_tools rule is enforced by the input
   * schema's superRefine AND again by the repo; either rejection maps to
   * BAD_REQUEST. The repo derives the skill's agent_id from the tenant context,
   * so we run inside runWithTenantContext({ tenant_id, agent_id: input.agentId })
   * and DON'T pass agent_id to propose (undefined → context agent).
   *
   * Audit (PR #213 FIX 1): the `skill_proposed` admin_audit_log row is written
   * inside the SAME transaction as the INSERT by passing an `audit` payload to
   * skillsRepo.propose. If the audit insert fails, the proposed row rolls back —
   * a skill version can never commit without its forensic record. change_summary
   * carries the target tenant/agent + category/execution_mode + allowed_tools.
   *
   * FIX 3: reject allowed_tools that name a DISABLED or UNKNOWN tool server-side
   * (in addition to the evaluator⇒empty rule). Reuses the catalog's enabled
   * computation (ENABLED_TOOL_NAMES) so the server is authoritative even if the
   * form is bypassed.
   */
  propose: protectedProcedure
    .input(SkillContractInputSchema)
    .mutation(async ({ input, ctx }) => {
      ctx.assertRole(MUTATION_ROLE);
      const tenantId = resolveTenantId(ctx, input.tenantId);

      // FIX 3: server-side disabled/unknown tool rejection. The form disables
      // these checkboxes, but the server must not trust the client — an
      // allowed_tools entry that is not a currently-enabled catalog tool is a
      // BAD_REQUEST (would otherwise persist a reference to a tool the runtime
      // won't expose). Evaluator skills already force empty allowed_tools.
      // Round-2 FIX B: the enabled set is resolved through the runtime
      // featureFlags gate (computed per-call), so a tool killed at runtime is
      // rejected here just as the dispatcher would refuse to run it.
      const enabledTools = enabledToolNames();
      const offending = input.allowed_tools.filter(
        (name) => !enabledTools.has(name),
      );
      if (offending.length > 0) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `disabled_tools_not_allowed: allowed_tools contains tool(s) that are not enabled: ${offending.join(', ')}`,
        });
      }

      try {
        const row = await runWithTenantContext(
          { tenant_id: tenantId, agent_id: input.agentId },
          async () =>
            ctx.repos.skillsRepo.propose(
              {
                skill_descriptor: input.skill_descriptor,
                category: input.category,
                execution_mode: input.execution_mode,
                goal: input.goal,
                when_to_use: input.when_to_use,
                procedure: input.procedure,
                constraints: input.constraints,
                input_schema: input.input_schema,
                output_schema: input.output_schema,
                allowed_tools: input.allowed_tools,
                policy_descriptors: input.policy_descriptors,
                success_criteria: input.success_criteria,
                failure_modes: input.failure_modes,
                runtime_hints: input.runtime_hints,
                proposed_by: ctx.userId,
                proposed_reason: input.proposed_reason,
              },
              {
                actor_id: ctx.userId,
                actor_role: ctx.userRole,
                action: 'skill_proposed',
                tenant_id: tenantId,
                change_summary: {
                  target_tenant_id: tenantId,
                  agent_id: input.agentId,
                  category: input.category,
                  execution_mode: input.execution_mode,
                  allowed_tools: input.allowed_tools,
                  reason: input.proposed_reason,
                },
              },
            ),
        );
        return { item: row };
      } catch (err) {
        throw mapRepoError(err);
      }
    }),

  /**
   * activate — flip a proposed skill to active (the repo atomically deprecates
   * the prior active for the same scope). Founder-only. Repo throws
   * cannot_activate_from_<status> (→ CONFLICT) when the target isn't proposed,
   * agent_scope_violation / tenant_admin_required (→ FORBIDDEN) for cross-agent
   * or tenant-wide targets, skill_not_found (→ NOT_FOUND).
   *
   * Audit (PR #213 FIX 1): the `skill_activated` row commits inside the repo's
   * activation transaction (audit payload arg). The repo records before/after
   * status from the row it locks in-tx, so the trail always reflects the real
   * transition; a failed audit insert rolls the whole activation back.
   */
  activate: protectedProcedure
    .input(LifecycleInput)
    .mutation(async ({ input, ctx }) => {
      ctx.assertRole(MUTATION_ROLE);
      const tenantId = resolveTenantId(ctx, input.tenantId);
      try {
        const row = await runWithTenantContext(
          { tenant_id: tenantId, agent_id: input.agentId },
          async () =>
            ctx.repos.skillsRepo.activate(input.id, ctx.userId, input.reason, {
              actor_id: ctx.userId,
              actor_role: ctx.userRole,
              action: 'skill_activated',
              tenant_id: tenantId,
              change_summary: {
                target_tenant_id: tenantId,
                agent_id: input.agentId,
                reason: input.reason,
              },
            }),
        );
        return { item: row };
      } catch (err) {
        throw mapRepoError(err);
      }
    }),

  /**
   * deprecate — mark an active/proposed skill as deprecated (does NOT reactivate
   * anything). Founder-only. Repo throws skill_not_found (→ NOT_FOUND),
   * agent_scope_violation / tenant_admin_required (→ FORBIDDEN), and
   * cannot_deprecate_from_<status> (→ CONFLICT) when the row is not in
   * active/proposed (FIX 2 — server-authoritative lifecycle guard).
   *
   * Audit (PR #213 FIX 1): the `skill_deprecated` row commits inside the repo's
   * transaction (audit payload arg) alongside the status-conditioned UPDATE.
   */
  deprecate: protectedProcedure
    .input(LifecycleInput)
    .mutation(async ({ input, ctx }) => {
      ctx.assertRole(MUTATION_ROLE);
      const tenantId = resolveTenantId(ctx, input.tenantId);
      try {
        const row = await runWithTenantContext(
          { tenant_id: tenantId, agent_id: input.agentId },
          async () =>
            ctx.repos.skillsRepo.deprecate(input.id, ctx.userId, input.reason, {
              actor_id: ctx.userId,
              actor_role: ctx.userRole,
              action: 'skill_deprecated',
              tenant_id: tenantId,
              change_summary: {
                target_tenant_id: tenantId,
                agent_id: input.agentId,
                reason: input.reason,
              },
            }),
        );
        return { item: row };
      } catch (err) {
        throw mapRepoError(err);
      }
    }),

  /**
   * rollback — mark an active skill as rolled_back and (best-effort) reactivate
   * the prior version; the repo does both inside one withTx. Founder-only. Repo
   * throws skill_not_found (→ NOT_FOUND), agent_scope_violation /
   * tenant_admin_required (→ FORBIDDEN), and cannot_rollback_from_<status>
   * (→ CONFLICT) when the row is not 'active' (FIX 2 — server-authoritative
   * lifecycle guard). Note the repo's rollback signature is
   * (id, reason, rolledBackBy, audit?).
   *
   * Audit (PR #213 FIX 1): the `skill_rolled_back` row commits inside the repo's
   * transaction (audit payload arg) alongside the status-conditioned UPDATE and
   * any v-1 reactivation.
   */
  rollback: protectedProcedure
    .input(LifecycleInput)
    .mutation(async ({ input, ctx }) => {
      ctx.assertRole(MUTATION_ROLE);
      const tenantId = resolveTenantId(ctx, input.tenantId);
      try {
        const row = await runWithTenantContext(
          { tenant_id: tenantId, agent_id: input.agentId },
          async () =>
            ctx.repos.skillsRepo.rollback(input.id, input.reason, ctx.userId, {
              actor_id: ctx.userId,
              actor_role: ctx.userRole,
              action: 'skill_rolled_back',
              tenant_id: tenantId,
              change_summary: {
                target_tenant_id: tenantId,
                agent_id: input.agentId,
                reason: input.reason,
              },
            }),
        );
        return { item: row };
      } catch (err) {
        throw mapRepoError(err);
      }
    }),
});
