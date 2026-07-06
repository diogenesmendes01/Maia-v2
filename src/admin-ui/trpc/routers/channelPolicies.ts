/**
 * Admin UI Setup — channel policies router.
 *
 * Procedures:
 *   - listChannels     — list channels for the resolved tenant (so the UI can
 *                        pick one before upserting a policy)
 *   - listRoles        — list roles in the resolved tenant (so the UI can pick
 *                        the default_role_id for the policy)
 *   - channelsOverview — channels joined with their policy status + role
 *                        count, for the go-live checklist and the channels
 *                        table (avoids an N+1 of getByChannel from the client)
 *   - getByChannel     — fetch the current policy (if any) for a channel
 *   - upsert           — create-or-update the policy for a channel. Audits.
 *   - createChannel    — register a channel for an agent. Audits.
 *   - createRole       — register a role for an agent. Audits.
 *
 * Notes:
 *   - channelsRepo / rolesRepo / channelPoliciesRepo all use applyTenantGuard,
 *     so every call site below runs inside runWithTenantContext.
 *   - role gate: founder or owner.
 *   - Single source of truth for "1 policy per channel" is the UNIQUE
 *     constraint on (channel_id) — we still try update→create here as a clean
 *     UX shortcut, but the DB is authoritative.
 *   - channels e roles eram seed/SQL-only; createChannel/createRole fecham o
 *     elo que faltava na jornada "agente novo → responde no canal". A UNIQUE
 *     do DB continua autoritativa — 23505 vira CONFLICT tipado, nunca 500.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../server.js';
import { resolveTenantId } from '../tenant-resolver.js';
import { runWithTenantContext } from '../../../db/tenant-context.js';
import { pgErrorCode } from '../../../db/client.js';

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

// Mirrors channelsRepo.create's channel_type union (schema has no CHECK; the
// repo signature is the contract).
const ChannelTypeSchema = z.enum([
  'whatsapp',
  'telegram',
  'email',
  'sms',
  'web',
  'api',
  'other',
]);

const CreateChannelInputSchema = z.object({
  tenantId: z.string().optional(),
  agentId: z.string(),
  channel_type: ChannelTypeSchema,
  external_id: z.string().min(1).max(200),
  display_name: z.string().min(1).max(200).optional(),
  comment: z.string().min(10).max(1000),
});

// Same shape rule as agent ids / role_key seeds (e.g. migration 035).
const RoleKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'must be lowercase letters/digits/_/- and start with alnum');

const CreateRoleInputSchema = z.object({
  tenantId: z.string().optional(),
  agentId: z.string(),
  role_key: RoleKeySchema,
  display_name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  prompt_addendum: z.string().max(4000).optional(),
  // Omitted ⇒ the first role of the agent becomes the default automatically
  // (a channel policy cannot exist without a default role). Explicit false is
  // honored even for the first role.
  is_default: z.boolean().optional(),
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

  /**
   * Channels joined with their policy status, plus the agent's role count.
   * Feeds the go-live checklist on the agent detail page and the policy
   * column on /setup/channels without an N+1 of getByChannel calls.
   */
  channelsOverview: protectedProcedure
    .input(ListChannelsInputSchema)
    .query(async ({ input, ctx }) => {
      const tenantId = resolveTenantId(ctx, input.tenantId);
      return runWithTenantContext(
        { tenant_id: tenantId, agent_id: input.agentId },
        async () => {
          const [channels, roles] = await Promise.all([
            ctx.repos.channelsRepo.listActive(),
            ctx.repos.rolesRepo.listActive(),
          ]);
          const roleKeyById = new Map(roles.map((r) => [r.id, r.role_key]));
          const withPolicy = await Promise.all(
            channels.map(async (c) => {
              const policy = await ctx.repos.channelPoliciesRepo.getByChannelId(c.id);
              return {
                id: c.id,
                channel_type: c.channel_type,
                external_id: c.external_id,
                display_name: c.display_name,
                has_policy: policy !== null,
                default_role_key: policy
                  ? (roleKeyById.get(policy.default_role_id) ?? null)
                  : null,
              };
            }),
          );
          return { channels: withPolicy, roles_count: roles.length };
        },
      );
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

  /**
   * Register a channel for an agent. Channels were previously seed/SQL-only
   * (migration 035); this closes the missing link in the "new agent → answers
   * on a channel" journey. The DB UNIQUE (tenant_id, channel_type,
   * external_id) stays authoritative — a violation surfaces as CONFLICT.
   *
   * NOTE: in the current single-tenant runtime the gateway resolves inbound
   * messages via the seeded `primary/primary` catch-all (issue #411 —
   * `src/gateway/channel-resolver.ts`); an exact-match channel row created
   * here only routes traffic on deployments where the gateway passes the bot
   * line as external_id. Registering the row is still the correct
   * configuration step — routing is the runtime's concern, not this surface's.
   */
  createChannel: protectedProcedure
    .input(CreateChannelInputSchema)
    .mutation(async ({ input, ctx }) => {
      ctx.assertRole('owner', 'founder');
      const tenantId = resolveTenantId(ctx, input.tenantId);

      const agent = await ctx.repos.agentsRepo.findById(input.agentId);
      if (!agent || agent.tenant_id !== tenantId) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Agent not found' });
      }

      let channel;
      try {
        channel = await runWithTenantContext(
          { tenant_id: tenantId, agent_id: input.agentId },
          async () =>
            ctx.repos.channelsRepo.create({
              channel_type: input.channel_type,
              external_id: input.external_id,
              display_name: input.display_name,
            }),
        );
      } catch (err) {
        if (pgErrorCode(err) === '23505') {
          throw new TRPCError({
            code: 'CONFLICT',
            message: `Channel '${input.channel_type}/${input.external_id}' already exists in this tenant`,
          });
        }
        throw err;
      }

      await ctx.repos.adminAuditLogRepo.append({
        tenant_id: tenantId,
        actor_id: ctx.userId,
        actor_role: ctx.userRole,
        action: 'channel_create',
        resource_type: 'channel',
        resource_id: channel.id,
        change_summary: {
          agent_id: input.agentId,
          channel_type: input.channel_type,
          external_id: input.external_id,
          display_name: input.display_name ?? null,
          reason: input.comment,
        },
      });

      return { channel };
    }),

  /**
   * Register a role for an agent. Roles were previously seed/SQL-only; a
   * channel policy requires a default_role_id, so without this mutation the
   * policy modal dead-ends on agents created through the wizard.
   *
   * `is_default` omitted ⇒ the agent's first role becomes the default
   * automatically. Both UNIQUEs (role_key per agent; single default per
   * agent — partial index) stay authoritative and surface as CONFLICT.
   */
  createRole: protectedProcedure
    .input(CreateRoleInputSchema)
    .mutation(async ({ input, ctx }) => {
      ctx.assertRole('owner', 'founder');
      const tenantId = resolveTenantId(ctx, input.tenantId);

      const agent = await ctx.repos.agentsRepo.findById(input.agentId);
      if (!agent || agent.tenant_id !== tenantId) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Agent not found' });
      }

      let role;
      try {
        role = await runWithTenantContext(
          { tenant_id: tenantId, agent_id: input.agentId },
          async () => {
            const isDefault =
              input.is_default ?? (await ctx.repos.rolesRepo.listActive()).length === 0;
            return ctx.repos.rolesRepo.create({
              role_key: input.role_key,
              display_name: input.display_name,
              description: input.description,
              prompt_addendum: input.prompt_addendum,
              is_default: isDefault,
            });
          },
        );
      } catch (err) {
        if (pgErrorCode(err) === '23505') {
          throw new TRPCError({
            code: 'CONFLICT',
            message:
              `Role '${input.role_key}' already exists for this agent, ` +
              `or another role is already the default`,
          });
        }
        throw err;
      }

      await ctx.repos.adminAuditLogRepo.append({
        tenant_id: tenantId,
        actor_id: ctx.userId,
        actor_role: ctx.userRole,
        action: 'role_create',
        resource_type: 'role',
        resource_id: role.id,
        change_summary: {
          agent_id: input.agentId,
          role_key: input.role_key,
          display_name: input.display_name,
          is_default: role.is_default,
          reason: input.comment,
        },
      });

      return { role };
    }),
});
