/**
 * Playground sandbox router (issue #464).
 *
 * Surface for the "Testar agente" tab: create a sandbox session (optionally
 * pinned to a PROPOSED profile version), enqueue operator turns, and poll
 * for the agent's replies. The actual turn execution happens in the runtime
 * process (`src/workers/playground-turn-worker.ts`) via Postgres-as-queue —
 * this router never calls the LLM.
 *
 * Guardrails:
 *   - owner/founder only (same gate as profile editing);
 *   - every input carries agentId and every repo call is scoped by
 *     (tenant, agent) — a session id alone never crosses tenants;
 *   - profileVersionId must belong to the agent and be 'proposed' or
 *     'active' (testing a frozen/rolled_back body would mislead).
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../server.js';
import { resolveTenantId } from '../tenant-resolver.js';
import { runWithTenantContext } from '../../../db/tenant-context.js';

const AgentIdSchema = z.string().min(1).max(64);

const CreateSessionInput = z.object({
  tenantId: z.string().optional(),
  agentId: AgentIdSchema,
  profileVersionId: z.string().uuid().nullish(),
});

const SendTurnInput = z.object({
  tenantId: z.string().optional(),
  agentId: AgentIdSchema,
  sessionId: z.string().uuid(),
  message: z.string().min(1).max(4000),
});

const ListTurnsInput = z.object({
  tenantId: z.string().optional(),
  agentId: AgentIdSchema,
  sessionId: z.string().uuid(),
});

async function assertAgentInTenant(
  ctx: { repos: typeof import('../../../db/repositories.js') },
  tenantId: string,
  agentId: string,
) {
  const agent = await ctx.repos.agentsRepo.findById(agentId);
  if (!agent || agent.tenant_id !== tenantId) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Agent not found' });
  }
  return agent;
}

export const playgroundRouter = router({
  createSession: protectedProcedure
    .input(CreateSessionInput)
    .mutation(async ({ input, ctx }) => {
      ctx.assertRole('owner', 'founder');
      const tenantId = resolveTenantId(ctx, input.tenantId);
      await assertAgentInTenant(ctx, tenantId, input.agentId);

      const profileVersionId = input.profileVersionId ?? null;
      if (profileVersionId) {
        const version = await runWithTenantContext(
          { tenant_id: tenantId, agent_id: input.agentId },
          async () => ctx.repos.operationalProfileVersionsRepo.getById(profileVersionId),
        );
        if (!version) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Profile version not found' });
        }
        if (version.status !== 'proposed' && version.status !== 'active') {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: `Cannot test a '${version.status}' profile version — only proposed or active.`,
          });
        }
      }

      const session = await ctx.repos.playgroundRepo.createSession({
        tenant_id: tenantId,
        agent_id: input.agentId,
        profile_version_id: profileVersionId,
        created_by: ctx.userId,
      });
      return {
        id: session.id,
        profile_version_id: session.profile_version_id,
        expires_at: session.expires_at,
      };
    }),

  sendTurn: protectedProcedure.input(SendTurnInput).mutation(async ({ input, ctx }) => {
    ctx.assertRole('owner', 'founder');
    const tenantId = resolveTenantId(ctx, input.tenantId);
    const session = await ctx.repos.playgroundRepo.findSession({
      tenant_id: tenantId,
      agent_id: input.agentId,
      session_id: input.sessionId,
    });
    if (!session) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Playground session not found' });
    }
    if (session.expires_at.getTime() < Date.now()) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Session expired — start a new playground session.',
      });
    }
    const turn = await ctx.repos.playgroundRepo.enqueueUserTurn({
      tenant_id: tenantId,
      agent_id: input.agentId,
      session_id: input.sessionId,
      content: input.message,
    });
    return { id: turn.id, status: turn.status };
  }),

  listTurns: protectedProcedure.input(ListTurnsInput).query(async ({ input, ctx }) => {
    const tenantId = resolveTenantId(ctx, input.tenantId);
    const session = await ctx.repos.playgroundRepo.findSession({
      tenant_id: tenantId,
      agent_id: input.agentId,
      session_id: input.sessionId,
    });
    if (!session) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Playground session not found' });
    }
    const items = await ctx.repos.playgroundRepo.listTurns({
      tenant_id: tenantId,
      agent_id: input.agentId,
      session_id: input.sessionId,
    });
    return {
      items: items.map((t) => ({
        id: t.id,
        role: t.role as 'user' | 'agent',
        content: t.content,
        status: t.status,
        decision_meta: t.decision_meta,
        error_detail: t.error_detail,
        created_at: t.created_at,
      })),
      session: {
        id: session.id,
        profile_version_id: session.profile_version_id,
        expires_at: session.expires_at,
      },
    };
  }),
});
