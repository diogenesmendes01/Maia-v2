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
import { assertSafeMcpUrlSyntax, MCP_SECRET_REF_RE } from '../../../lib/mcp-url-guard.js';

const NameSchema = z
  .string()
  .min(2)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'slug minúsculo: letras/dígitos/_/-');

/**
 * Fase 0 cap. 5 — UI honesta com a feature OFF: com FEATURE_MCP_TOOLS
 * desligada o worker de sync é no-op, então cadastrar/testar/sincronizar só
 * criaria operações pendentes que nunca rodam (e uma URL+ref persistidos à
 * espera do enablement). Bloqueia na mutation com mensagem explícita. A
 * habilitação em produção exige issue própria + threat model + pentest
 * (gate G4 da Fase 0) — e o boot de produção recusa a flag ligada.
 */
function assertMcpFeatureEnabled(): void {
  const v = process.env.FEATURE_MCP_TOOLS;
  if (v !== 'true' && v !== '1') {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message:
        'MCP está desativado (FEATURE_MCP_TOOLS=false). Cadastro/test/sync ficam indisponíveis até o enablement passar pela revisão de segurança dedicada (Fase 0, gate G4).',
    });
  }
}

const RegisterInput = z.object({
  tenantId: z.string().optional(),
  name: NameSchema,
  // Fase 0 cap. 5 (auditoria P0) — validação sintática anti-SSRF já no
  // cadastro: https obrigatório, sem userinfo, sem porta de datastore, IP
  // literal privado rejeitado. O runtime revalida (inclusive a RESOLUÇÃO
  // DNS) a cada uso — este check é a primeira camada, não a única.
  url: z
    .string()
    .url()
    .max(500)
    .superRefine((raw, ctx) => {
      try {
        assertSafeMcpUrlSyntax(raw, { allowLocalhostHttp: process.env.NODE_ENV !== 'production' });
      } catch (err) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: (err as Error).message });
      }
    }),
  // Fase 0 cap. 5 — o ref é um NAMESPACE dedicado (MCP_SECRET_*), nunca um
  // env var arbitrário: um owner comprometido não consegue mais apontar para
  // DATABASE_URL/chaves LLM e exfiltrar o valor como bearer.
  authSecretRef: z
    .string()
    .regex(MCP_SECRET_REF_RE, 'use o namespace MCP_SECRET_* (ex.: MCP_SECRET_ERP_TOKEN)')
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
    assertMcpFeatureEnabled();
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
    assertMcpFeatureEnabled();
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
    assertMcpFeatureEnabled();
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

    // Follow-up do PR #493 + review do PR #494 [medium]: o read-modify-write
    // inteiro roda DENTRO da transação do helper (SELECT ... FOR UPDATE) —
    // dois writers concorrentes (outro toggle MCP, save da tela de
    // capacidades) são serializados em vez de o último sobrescrever o array
    // do outro; o `previous` da auditoria é o valor realmente substituído.
    const result = await ctx.repos.agentToolGrantsRepo.updateWithAudit({
      tenant_id: tenantId,
      agent_id: agent.id,
      compute: (current) => {
        const packs = new Set(current?.granted_packs ?? [...BASE_AGENT_PACKS]);
        if (input.granted) packs.add(pack);
        else packs.delete(pack);
        return {
          ok: true,
          granted_packs: [...packs],
          granted_tools: current?.granted_tools ?? [],
          denied_tools: current?.denied_tools ?? [],
        };
      },
      granted_by: ctx.userId,
      reason: `pack ${pack} ${input.granted ? 'concedido' : 'revogado'} via console MCP (issue #478)`,
      audit: {
        actor_id: ctx.userId,
        actor_role: ctx.userRole,
        action: 'mcp_pack_grant_changed',
      },
    });
    if (!result.ok) {
      // compute acima nunca rejeita — exhaustividade defensiva.
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'setAgentPack compute rejected unexpectedly',
      });
    }
    return { granted_packs: result.grant.granted_packs };
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
