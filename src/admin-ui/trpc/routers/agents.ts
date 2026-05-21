/**
 * Admin UI Setup — agents router.
 *
 * Procedures:
 *   - list           — list agents for a tenant
 *   - getById        — fetch a single agent
 *   - create         — create an agent AND seed agent_operational_profile_versions
 *                      v1 with status='proposed' AND append audit row, all in a
 *                      single transaction (agentsRepo.createWithSeedAndAudit).
 *   - updateProfile  — propose a new operational_profile_version for an existing
 *                      agent AND append audit row, in a single transaction
 *                      (operationalProfileVersionsRepo.proposeAndAuditAtomic).
 *                      Status='proposed' — the proposal still has to be
 *                      approved through the standard proposal-inbox flow.
 *
 * Notes:
 *   - All three mutations (create / updateProfile / approveProfile) now go
 *     through repo-level "atomic" methods that take explicit tenant_id/agent_id
 *     and wrap their writes in `withTx`. Codex review of PR #162 round 3
 *     (issue #166) closed the multi-write atomicity gap.
 *   - The tenant_id ALWAYS comes from the resolved ctx tenant (no body
 *     override for owner — only founder can supply a body tenantId).
 *   - We deliberately do NOT auto-activate the seeded profile. P8.5 invariant
 *     is "no profile activates without an approval"; admin-ui setup respects
 *     this — a freshly-created agent has no active profile until owner/founder
 *     approves the seed via the Proposal Inbox.
 *   - role gate: founder or owner. analyst/viewer cannot create agents.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../server.js';
import { resolveTenantId } from '../tenant-resolver.js';
import { runWithTenantContext } from '../../../db/tenant-context.js';
import { PROFILE_BODY_SCHEMA_VERSION, type ProfileBody } from '../../../db/schema.js';

const AgentIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'must be lowercase letters/digits/_/- and start with alnum');

const AgentStatusSchema = z.enum(['active', 'suspended']);

const FormalitySchema = z.enum(['low', 'medium', 'high']);
const VerbositySchema = z.enum(['concise', 'medium', 'detailed']);

// Operational profile body shape (mirrors ProfileBody in schema.ts).
// We accept the user-visible subset and fill schema_version + metadata
// server-side.
const ProfileBodyInputSchema = z.object({
  identity: z.object({
    role_descriptor: z.string().min(1).max(500),
    voice: z.object({
      tone: z.string().min(1).max(200),
      formality: FormalitySchema,
      verbosity: VerbositySchema,
    }),
    cognitive_limits: z.object({
      max_inference_depth: z.number().int().min(0).max(10),
      max_speculation_in_response: z.number().min(0).max(1),
      confidence_floor_for_action: z.number().min(0).max(1),
    }),
    priorities: z.array(z.string().min(1).max(200)).max(20),
  }),
  style: z.object({
    language: z.string().min(2).max(20),
    rhythm: z.record(z.string(), z.unknown()).default({}),
  }),
});

const ListInputSchema = z.object({ tenantId: z.string().optional() });

const GetByIdInputSchema = z.object({
  tenantId: z.string().optional(),
  id: AgentIdSchema,
});

const CreateInputSchema = z.object({
  tenantId: z.string().optional(),
  id: AgentIdSchema,
  nome: z.string().min(1).max(200),
  status: AgentStatusSchema.optional(),
  profile_body: ProfileBodyInputSchema,
  proposed_reason: z.string().min(10).max(2000),
});

const UpdateProfileInputSchema = z.object({
  tenantId: z.string().optional(),
  agentId: AgentIdSchema,
  profile_body: ProfileBodyInputSchema,
  proposed_reason: z.string().min(10).max(2000),
});

const ApproveProfileInputSchema = z.object({
  tenantId: z.string().optional(),
  agentId: AgentIdSchema,
  versionId: z.string().uuid(),
  comment: z.string().min(10).max(2000),
});

/**
 * Build a full ProfileBody from the user-supplied subset. `previous_version_id`
 * is null for the seed; for `updateProfile` we pass the current active id (if
 * any) so the chain links.
 */
function buildProfileBody(
  input: z.infer<typeof ProfileBodyInputSchema>,
  proposedBy: string,
  previousVersionId: string | null,
): ProfileBody {
  return {
    schema_version: PROFILE_BODY_SCHEMA_VERSION,
    identity: {
      role_descriptor: input.identity.role_descriptor,
      voice: input.identity.voice,
      cognitive_limits: input.identity.cognitive_limits,
      priorities: input.identity.priorities,
      learned_voice_modifiers: [],
    },
    style: {
      language: input.style.language,
      rhythm: input.style.rhythm,
    },
    metadata: {
      effective_from: new Date().toISOString(),
      created_by: proposedBy,
      previous_version_id: previousVersionId,
    },
  };
}

export const agentsRouter = router({
  list: protectedProcedure.input(ListInputSchema).query(async ({ input, ctx }) => {
    const tenantId = resolveTenantId(ctx, input.tenantId);
    const items = await ctx.repos.agentsRepo.listByTenant(tenantId);
    return { items };
  }),

  getById: protectedProcedure.input(GetByIdInputSchema).query(async ({ input, ctx }) => {
    const tenantId = resolveTenantId(ctx, input.tenantId);
    const agent = await ctx.repos.agentsRepo.findById(input.id);
    if (!agent) throw new TRPCError({ code: 'NOT_FOUND', message: 'Agent not found' });
    if (agent.tenant_id !== tenantId) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Agent not found' });
    }
    return agent;
  }),

  create: protectedProcedure.input(CreateInputSchema).mutation(async ({ input, ctx }) => {
    ctx.assertRole('owner', 'founder');
    const tenantId = resolveTenantId(ctx, input.tenantId);

    const tenant = await ctx.repos.tenantsRepo.findById(tenantId);
    if (!tenant) {
      throw new TRPCError({ code: 'NOT_FOUND', message: `Tenant ${tenantId} not found` });
    }

    const existing = await ctx.repos.agentsRepo.findById(input.id);
    if (existing) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: `Agent '${input.id}' already exists`,
      });
    }

    // Codex review of PR #162 round 3 (issue #166) — agent insert + seed
    // profile_version + audit are now wrapped in a single tx via
    // agentsRepo.createWithSeedAndAudit. A failure on any of the three
    // rolls back the other two, so we cannot leave an agent with no seed
    // profile (which would break /identities setup) nor an unaudited
    // governance change. Same pattern as `approveAndActivateAtomic`.
    const profileBody = buildProfileBody(input.profile_body, ctx.userId, null);
    const { agent: created, seed_profile: version } =
      await ctx.repos.agentsRepo.createWithSeedAndAudit({
        agent: {
          id: input.id,
          tenant_id: tenantId,
          nome: input.nome,
          status: input.status ?? 'active',
        },
        seed_profile: {
          profile_body: profileBody,
          proposed_by: ctx.userId,
          proposed_reason: input.proposed_reason,
        },
        audit: {
          actor_id: ctx.userId,
          actor_role: ctx.userRole,
        },
      });

    return {
      agent: created,
      seed_profile: {
        id: version.id,
        version: version.version,
        status: version.status,
      },
    };
  }),

  updateProfile: protectedProcedure
    .input(UpdateProfileInputSchema)
    .mutation(async ({ input, ctx }) => {
      ctx.assertRole('owner', 'founder');
      const tenantId = resolveTenantId(ctx, input.tenantId);

      const agent = await ctx.repos.agentsRepo.findById(input.agentId);
      if (!agent || agent.tenant_id !== tenantId) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Agent not found' });
      }

      // Read current active version OUTSIDE the tx — it's only used to chain
      // previous_version_id into the profile_body metadata. Concurrent
      // approveProfile races are guarded inside `approveAndActivateAtomic`
      // via FOR UPDATE on the active row, so a stale read here is bounded
      // (worst case: previous_version_id chains to a now-frozen row, which
      // is still a valid lineage marker).
      const activeVersion = await runWithTenantContext(
        { tenant_id: tenantId, agent_id: agent.id },
        async () => ctx.repos.operationalProfileVersionsRepo.getActive(),
      );

      const profileBody = buildProfileBody(
        input.profile_body,
        ctx.userId,
        activeVersion?.id ?? null,
      );

      // Codex review of PR #162 round 3 (issue #166) — profile_version
      // insert + audit are now wrapped in a single tx via
      // operationalProfileVersionsRepo.proposeAndAuditAtomic. A failure on
      // either rolls back the other, so we cannot leave a proposal with no
      // audit row.
      //
      // Codex Adversarial Review of PR #171 — the atomic helper now locks
      // the parent agent row with FOR UPDATE to serialize version
      // allocation. If the agent was deleted between our findById above
      // and the lock acquisition, the helper returns { agent_missing: true }
      // and we translate to NOT_FOUND (same outcome as the upfront check).
      const result = await ctx.repos.operationalProfileVersionsRepo.proposeAndAuditAtomic({
        tenant_id: tenantId,
        agent_id: agent.id,
        profile_body: profileBody,
        proposed_by: ctx.userId,
        proposed_reason: input.proposed_reason,
        previous_active_id: activeVersion?.id ?? null,
        actor_id: ctx.userId,
        actor_role: ctx.userRole,
      });
      if ('agent_missing' in result) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Agent not found' });
      }

      return {
        version: {
          id: result.version.id,
          version: result.version.version,
          status: result.version.status,
        },
        previous_version_id: result.previous_version_id,
      };
    }),

  /**
   * Approve a `proposed` agent_operational_profile_versions row, transitioning
   * it to `active` and atomically freezing the previous active version (if any).
   *
   * Codex review #162 round 2 ([high] x2) — uses
   * `operationalProfileVersionsRepo.approveAndActivateAtomic`, which wraps:
   *   - lock proposed row
   *   - lock incumbent active (if any) and freeze it
   *   - activate proposed
   *   - append admin_audit_log
   * in a single transaction so partial commits cannot leave runtime state
   * mutated without an audit row, AND so subsequent updateProfile approvals
   * don't get stuck on `already_has_active`.
   *
   * Architecture-lock semantics are NOT applied here — operational profile is
   * per-agent state, not part of the immutable identity_immutable_core. If we
   * later decide it warrants dual approval, switch this to a Proposal Inbox
   * source.
   */
  approveProfile: protectedProcedure
    .input(ApproveProfileInputSchema)
    .mutation(async ({ input, ctx }) => {
      ctx.assertRole('owner', 'founder');
      const tenantId = resolveTenantId(ctx, input.tenantId);

      const agent = await ctx.repos.agentsRepo.findById(input.agentId);
      if (!agent || agent.tenant_id !== tenantId) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Agent not found' });
      }

      const result = await ctx.repos.operationalProfileVersionsRepo.approveAndActivateAtomic({
        tenant_id: tenantId,
        agent_id: agent.id,
        id: input.versionId,
        actor_id: ctx.userId,
        actor_role: ctx.userRole,
        comment: input.comment,
      });

      if (!result.ok) {
        if (result.reason === 'not_found') {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Version not found' });
        }
        if (result.reason === 'invalid_source_status') {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Version is not in proposed state; refresh and retry',
          });
        }
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Approval transition failed: ${result.reason}`,
        });
      }

      return {
        activated: result.activated,
        frozen_previous: result.frozen_previous,
      };
    }),
});
