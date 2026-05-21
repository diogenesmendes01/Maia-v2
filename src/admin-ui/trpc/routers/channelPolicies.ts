/**
 * Admin UI Setup — channel policies router.
 *
 * Procedures:
 *   - listChannels  — list channels for the resolved tenant (so the UI can
 *                     pick one before upserting a policy)
 *   - listRoles     — list roles in the resolved tenant (so the UI can pick
 *                     the default_role_id for the policy)
 *   - getByChannel  — fetch the current policy (if any) for a channel
 *   - upsert        — create-or-update the policy for a channel. Audits.
 *
 * Notes:
 *   - channelsRepo / rolesRepo / channelPoliciesRepo all use applyTenantGuard,
 *     so every call site below runs inside runWithTenantContext.
 *   - role gate: founder or owner.
 *   - Single source of truth for "1 policy per channel" is the UNIQUE
 *     constraint on (channel_id) — we still try update→create here as a clean
 *     UX shortcut, but the DB is authoritative.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../server.js';
import { resolveTenantId } from '../tenant-resolver.js';
import { runWithTenantContext } from '../../../db/tenant-context.js';

// Mirrors src/types/enums.ts SwitchBehavior + AnnounceMode (single source of
// truth lives there; we declare a Zod equivalent here for input validation).
const SwitchBehaviorSchema = z.enum([
  'locked',
  'prefer_handoff',
  'free_with_trigger',
  'by_context',
]);
const AnnounceModeSchema = z.enum(['always', 'affects_user', 'never']);

const ByContextGuardsSchema = z
  .object({
    min_confidence_to_switch: z.number().min(0).max(1),
    cooldown_turns: z.number().int().min(0).max(50),
    required_strength_delta: z.number().min(0).max(1),
    max_switches_per_conversation: z.number().int().min(0).max(50),
  })
  .partial();

const ListChannelsInputSchema = z.object({
  tenantId: z.string().optional(),
  agentId: z.string(),
});

const ListRolesInputSchema = z.object({
  tenantId: z.string().optional(),
  agentId: z.string(),
});

const GetByChannelInputSchema = z.object({
  tenantId: z.string().optional(),
  agentId: z.string(),
  channelId: z.string().uuid(),
});

const UpsertInputSchema = z.object({
  tenantId: z.string().optional(),
  agentId: z.string(),
  channel_id: z.string().uuid(),
  default_role_id: z.string().uuid(),
  switch_behavior: SwitchBehaviorSchema,
  announce_mode: AnnounceModeSchema.optional(),
  by_context_guards: ByContextGuardsSchema.optional(),
  allowed_role_ids: z.array(z.string().uuid()).optional(),
  comment: z.string().min(10).max(1000),
});

export const channelPoliciesRouter = router({
  listChannels: protectedProcedure
    .input(ListChannelsInputSchema)
    .query(async ({ input, ctx }) => {
      const tenantId = resolveTenantId(ctx, input.tenantId);
      const items = await runWithTenantContext(
        { tenant_id: tenantId, agent_id: input.agentId },
        async () => ctx.repos.channelsRepo.listActive(),
      );
      return { items };
    }),

  listRoles: protectedProcedure.input(ListRolesInputSchema).query(async ({ input, ctx }) => {
    const tenantId = resolveTenantId(ctx, input.tenantId);
    const items = await runWithTenantContext(
      { tenant_id: tenantId, agent_id: input.agentId },
      async () => ctx.repos.rolesRepo.listActive(),
    );
    return { items };
  }),

  getByChannel: protectedProcedure
    .input(GetByChannelInputSchema)
    .query(async ({ input, ctx }) => {
      const tenantId = resolveTenantId(ctx, input.tenantId);
      const policy = await runWithTenantContext(
        { tenant_id: tenantId, agent_id: input.agentId },
        async () => ctx.repos.channelPoliciesRepo.getByChannelId(input.channelId),
      );
      return policy;
    }),

  upsert: protectedProcedure.input(UpsertInputSchema).mutation(async ({ input, ctx }) => {
    ctx.assertRole('owner', 'founder');
    const tenantId = resolveTenantId(ctx, input.tenantId);

    // Pre-flight: confirm the channel + default_role both belong to this
    // (tenant, agent). channelsRepo.getById and rolesRepo.getById already
    // enforce tenant scope via applyTenantGuard.
    const { channel, defaultRole, existing } = await runWithTenantContext(
      { tenant_id: tenantId, agent_id: input.agentId },
      async () => ({
        channel: await ctx.repos.channelsRepo.getById(input.channel_id),
        defaultRole: await ctx.repos.rolesRepo.getById(input.default_role_id),
        existing: await ctx.repos.channelPoliciesRepo.getByChannelId(input.channel_id),
      }),
    );

    if (!channel) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Channel not found in this tenant/agent',
      });
    }
    if (!defaultRole) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Default role not found in this tenant/agent',
      });
    }

    const isUpdate = existing !== null;

    const policy = await runWithTenantContext(
      { tenant_id: tenantId, agent_id: input.agentId },
      async () => {
        if (existing) {
          return ctx.repos.channelPoliciesRepo.update(existing.id, {
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
        }
        return ctx.repos.channelPoliciesRepo.create({
          channel_id: input.channel_id,
          default_role_id: input.default_role_id,
          switch_behavior: input.switch_behavior,
          announce_mode: input.announce_mode,
          by_context_guards: input.by_context_guards,
          allowed_role_ids: input.allowed_role_ids,
        });
      },
    );

    await ctx.repos.adminAuditLogRepo.append({
      tenant_id: tenantId,
      actor_id: ctx.userId,
      actor_role: ctx.userRole,
      action: isUpdate ? 'channel_policy_update' : 'channel_policy_create',
      resource_type: 'channel_policy',
      resource_id: policy.id,
      change_summary: {
        agent_id: input.agentId,
        channel_id: input.channel_id,
        default_role_id: input.default_role_id,
        switch_behavior: input.switch_behavior,
        announce_mode: input.announce_mode ?? null,
        by_context_guards: input.by_context_guards ?? null,
        allowed_role_ids: input.allowed_role_ids ?? null,
        previous_policy_id: existing?.id ?? null,
        reason: input.comment,
      },
    });

    return { policy, created: !isUpdate };
  }),
});
