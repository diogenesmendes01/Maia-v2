/**
 * MCP externo v1 — router (issue #478, spec §2.8).
 *
 * Conectar (registrar/ativar/desativar/test/sync), Ver (servers + tools com
 * estado), Decidir (aprovar/rejeitar tool a tool — owner/founder, auditado)
 * e Regular por agente (conceder/revogar o pack `mcp.<server>` no grant).
 *
 * Test/sync são ENFILEIRADOS (flags na row) — o worker mcp_sync do runtime
 * executa; o console faz poll de last_*_result. Toda decisão é auditada via
 * admin_audit_log (mesma trilha das demais mutações de governança do console).
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../server.js';
import { resolveTenantId } from '../tenant-resolver.js';
import { runWithTenantContext } from '../../../db/tenant-context.js';
import { mcpPackId } from '../../../db/repositories/mcp-repos.js';
import { BASE_AGENT_PACKS } from '../../../tools/base-agent-packs.js';

const NameSchema = z
  .string()
  .min(2)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'slug minúsculo: letras/dígitos/_/-');

const RegisterInput = z.object({
  tenantId: z.string().optional(),
  name: NameSchema,
  url: z.string().url().max(500),
  // Nome da env var no runtime com o bearer (ex.: MCP_SERVER_ERP_TOKEN).
  authSecretRef: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/, 'nome de env var (MAIÚSCULAS_COM_UNDERSCORE)')
    .max(100)
    .nullable(),
});

const ServerIdInput = z.object({
  tenantId: z.string().optional(),
  serverId: z.string().uuid(),
});

const SetServerStatusInput = ServerIdInput.extend({
  status: z.enum(['active', 'disabled']),
});

const DecideToolInput = z.object({
  tenantId: z.string().optional(),
  toolId: z.string().uuid(),
  decision: z.enum(['approved', 'rejected']),
  isReadOnly: z.boolean(),
  riskClass: z.enum(['low', 'medium', 'high', 'critical']),
  comment: z.string().min(10).max(2000),
});

const PackGrantInput = z.object({
  tenantId: z.string().optional(),
  serverId: z.string().uuid(),
  agentId: z.string().min(1).max(64),
  granted: z.boolean(),
});

export const mcpRouter = router({
  listServers: protectedProcedure
    .input(z.object({ tenantId: z.string().optional() }))
    .query(async ({ input, ctx }) => {
      const tenantId = resolveTenantId(ctx, input.tenantId);
      const items = await ctx.repos.mcpServersRepo.listByTenant(tenantId);
      return { items };
    }),

  registerServer: protectedProcedure.input(RegisterInput).mutation(async ({ input, ctx }) => {
    ctx.assertRole('owner', 'founder');
    const tenantId = resolveTenantId(ctx, input.tenantId);
    const existing = await ctx.repos.mcpServersRepo.findByName({
      tenant_id: tenantId,
      name: input.name,
    });
    if (existing) {
      throw new TRPCError({ code: 'CONFLICT', message: `Server '${input.name}' já existe` });
    }
    const server = await ctx.repos.mcpServersRepo.create({
      tenant_id: tenantId,
      name: input.name,
      url: input.url,
      auth_secret_ref: input.authSecretRef,
      created_by: ctx.userId,
    });
    await ctx.repos.adminAuditLogRepo.append({
      tenant_id: tenantId,
      actor_id: ctx.userId,
      actor_role: ctx.userRole,
      action: 'mcp_server_registered',
      resource_type: 'mcp_server',
      resource_id: server.id,
      change_summary: { name: input.name, url: input.url, auth_secret_ref: input.authSecretRef },
    });
    return server;
  }),

  setServerStatus: protectedProcedure
    .input(SetServerStatusInput)
    .mutation(async ({ input, ctx }) => {
      ctx.assertRole('owner', 'founder');
      const tenantId = resolveTenantId(ctx, input.tenantId);
      const server = await ctx.repos.mcpServersRepo.setStatus({
        tenant_id: tenantId,
        server_id: input.serverId,
        status: input.status,
      });
      if (!server) throw new TRPCError({ code: 'NOT_FOUND', message: 'Server not found' });
      await ctx.repos.adminAuditLogRepo.append({
        tenant_id: tenantId,
        actor_id: ctx.userId,
        actor_role: ctx.userRole,
        action: 'mcp_server_status_changed',
        resource_type: 'mcp_server',
        resource_id: server.id,
        change_summary: { name: server.name, status: input.status },
      });
      return server;
    }),

  requestTest: protectedProcedure.input(ServerIdInput).mutation(async ({ input, ctx }) => {
    ctx.assertRole('owner', 'founder');
    const tenantId = resolveTenantId(ctx, input.tenantId);
    const ok = await ctx.repos.mcpServersRepo.requestOp({
      tenant_id: tenantId,
      server_id: input.serverId,
      op: 'test',
    });
    if (!ok) throw new TRPCError({ code: 'NOT_FOUND', message: 'Server not found' });
    return { queued: true };
  }),

  requestSync: protectedProcedure.input(ServerIdInput).mutation(async ({ input, ctx }) => {
    ctx.assertRole('owner', 'founder');
    const tenantId = resolveTenantId(ctx, input.tenantId);
    const ok = await ctx.repos.mcpServersRepo.requestOp({
      tenant_id: tenantId,
      server_id: input.serverId,
      op: 'sync',
    });
    if (!ok) throw new TRPCError({ code: 'NOT_FOUND', message: 'Server not found' });
    return { queued: true };
  }),

  listTools: protectedProcedure.input(ServerIdInput).query(async ({ input, ctx }) => {
    const tenantId = resolveTenantId(ctx, input.tenantId);
    const server = await ctx.repos.mcpServersRepo.findById({
      tenant_id: tenantId,
      server_id: input.serverId,
    });
    if (!server) throw new TRPCError({ code: 'NOT_FOUND', message: 'Server not found' });
    const items = await ctx.repos.mcpServerToolsRepo.listByServer({
      tenant_id: tenantId,
      server_id: input.serverId,
    });
    return { server, items };
  }),

  decideTool: protectedProcedure.input(DecideToolInput).mutation(async ({ input, ctx }) => {
    ctx.assertRole('owner', 'founder');
    const tenantId = resolveTenantId(ctx, input.tenantId);
    const tool = await ctx.repos.mcpServerToolsRepo.decide({
      tenant_id: tenantId,
      tool_id: input.toolId,
      decision: input.decision,
      is_read_only: input.isReadOnly,
      risk_class: input.riskClass,
      actor_id: ctx.userId,
      comment: input.comment,
    });
    if (!tool) throw new TRPCError({ code: 'NOT_FOUND', message: 'Tool not found' });
    await ctx.repos.adminAuditLogRepo.append({
      tenant_id: tenantId,
      actor_id: ctx.userId,
      actor_role: ctx.userRole,
      action: 'mcp_tool_decided',
      resource_type: 'mcp_server_tool',
      resource_id: tool.id,
      change_summary: {
        tool: tool.tool_name,
        decision: input.decision,
        is_read_only: input.isReadOnly,
        risk_class: input.riskClass,
        comment: input.comment,
      },
    });
    return tool;
  }),

  /**
   * Regular por agente: liga/desliga o pack `mcp.<server>` no grant do
   * agente. Primeira superfície de EDIÇÃO de grants (decisão na spec §2.8):
   * owner/founder, audit direto, preservando granted_tools/denied_tools.
   */
  setAgentPack: protectedProcedure.input(PackGrantInput).mutation(async ({ input, ctx }) => {
    ctx.assertRole('owner', 'founder');
    const tenantId = resolveTenantId(ctx, input.tenantId);
    const server = await ctx.repos.mcpServersRepo.findById({
      tenant_id: tenantId,
      server_id: input.serverId,
    });
    if (!server) throw new TRPCError({ code: 'NOT_FOUND', message: 'Server not found' });
    const agent = await ctx.repos.agentsRepo.findById(input.agentId);
    if (!agent || agent.tenant_id !== tenantId) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Agent not found' });
    }

    const pack = mcpPackId(server.name);
    const updated = await runWithTenantContext(
      { tenant_id: tenantId, agent_id: agent.id },
      async () => {
        const current = await ctx.repos.agentToolGrantsRepo.findForCurrentAgent();
        const packs = new Set(current?.granted_packs ?? [...BASE_AGENT_PACKS]);
        if (input.granted) packs.add(pack);
        else packs.delete(pack);
        return ctx.repos.agentToolGrantsRepo.upsertForCurrentAgent({
          granted_packs: [...packs],
          granted_tools: current?.granted_tools ?? [],
          denied_tools: current?.denied_tools ?? [],
          granted_by: ctx.userId,
          reason: `pack ${pack} ${input.granted ? 'concedido' : 'revogado'} via console MCP (issue #478)`,
        });
      },
    );

    await ctx.repos.adminAuditLogRepo.append({
      tenant_id: tenantId,
      actor_id: ctx.userId,
      actor_role: ctx.userRole,
      action: 'mcp_pack_grant_changed',
      resource_type: 'agent_tool_grant',
      resource_id: agent.id,
      change_summary: { agent_id: agent.id, pack, granted: input.granted },
    });
    return { granted_packs: updated.granted_packs };
  }),

  /** Agentes do tenant com o estado do pack deste server (para a tela). */
  listAgentAccess: protectedProcedure.input(ServerIdInput).query(async ({ input, ctx }) => {
    const tenantId = resolveTenantId(ctx, input.tenantId);
    const server = await ctx.repos.mcpServersRepo.findById({
      tenant_id: tenantId,
      server_id: input.serverId,
    });
    if (!server) throw new TRPCError({ code: 'NOT_FOUND', message: 'Server not found' });
    const pack = mcpPackId(server.name);
    const agents = await ctx.repos.agentsRepo.listByTenant(tenantId);
    const items = await Promise.all(
      agents.map(async (a) => {
        const grant = await runWithTenantContext(
          { tenant_id: tenantId, agent_id: a.id },
          async () => ctx.repos.agentToolGrantsRepo.findForCurrentAgent(),
        );
        return {
          agent_id: a.id,
          nome: a.nome,
          granted: (grant?.granted_packs ?? []).includes(pack),
        };
      }),
    );
    return { pack, items };
  }),
});
