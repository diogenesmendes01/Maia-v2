/**
 * Issue #478 — mcpRouter unit tests (v1).
 *
 * Gates: papel (owner/founder), escopo de tenant, conflito de nome,
 * validação de secret ref/slug, decisão auditada e a edição de grant
 * (setAgentPack) preservando tools/denies existentes.
 */
import { describe, it, expect } from 'vitest';
import { TRPCError } from '@trpc/server';
import { mcpRouter } from '@/admin-ui/trpc/routers/mcp.js';

const SERVER_UUID = '55555555-5555-4555-8555-555555555555';
const TOOL_UUID = '66666666-6666-4666-8666-666666666666';

function makeCtx(
  role: string,
  opts?: {
    existingServer?: boolean;
    server?: { id: string; name: string } | null;
    agent?: { id: string; tenant_id: string } | null;
    grant?: { granted_packs: string[]; granted_tools: string[]; denied_tools: string[] } | null;
  },
) {
  const audit: Array<Record<string, unknown>> = [];
  const upserts: Array<Record<string, unknown>> = [];
  const decisions: Array<Record<string, unknown>> = [];

  const ctx = {
    session: { user: { id: 'user-1', role, tenant_id: 'tenant-A' } },
    userId: 'user-1',
    userRole: role,
    tenantId: 'tenant-A',
    repos: {
      adminAuditLogRepo: {
        async append(row: Record<string, unknown>) {
          audit.push(row);
          return row;
        },
      },
      agentsRepo: {
        async findById(_id: string) {
          return opts?.agent === undefined
            ? { id: 'agent-a', tenant_id: 'tenant-A' }
            : opts.agent;
        },
        async listByTenant() {
          return [{ id: 'agent-a', tenant_id: 'tenant-A', nome: 'A' }];
        },
      },
      mcpServersRepo: {
        async findByName() {
          return opts?.existingServer ? { id: SERVER_UUID } : null;
        },
        async create(args: Record<string, unknown>) {
          return { id: SERVER_UUID, ...args };
        },
        async findById(_args: Record<string, unknown>) {
          return opts?.server === undefined
            ? { id: SERVER_UUID, name: 'erp' }
            : opts.server;
        },
        async setStatus(args: Record<string, unknown>) {
          return { id: args.server_id, name: 'erp', status: args.status };
        },
        async requestOp() {
          return true;
        },
        async listByTenant() {
          return [];
        },
      },
      mcpServerToolsRepo: {
        async decide(args: Record<string, unknown>) {
          decisions.push(args);
          return { id: args.tool_id, tool_name: 'erp_listar_pedidos', ...args };
        },
        async listByServer() {
          return [];
        },
      },
      agentToolGrantsRepo: {
        async findForCurrentAgent() {
          return opts?.grant === undefined
            ? {
                granted_packs: ['baseline.core', 'domain.calendar'],
                granted_tools: ['extra_tool'],
                denied_tools: ['blocked_tool'],
              }
            : opts.grant;
        },
        // Mirrors the real atomic helper (PR #493 follow-up + PR #494 review):
        // the CURRENT row is read inside the "tx" and handed to the caller's
        // pure compute; upsert + audit land together.
        async updateWithAudit(args: {
          tenant_id: string;
          agent_id: string;
          compute: (current: Record<string, unknown> | null) =>
            | {
                ok: true;
                granted_packs: string[];
                granted_tools: string[];
                denied_tools: string[];
              }
            | { ok: false; reject: unknown };
          granted_by: string;
          reason: string;
          audit: { actor_id: string; actor_role: string; action: string };
        }) {
          const current =
            opts?.grant === undefined
              ? {
                  granted_packs: ['baseline.core', 'domain.calendar'],
                  granted_tools: ['extra_tool'],
                  denied_tools: ['blocked_tool'],
                }
              : opts.grant;
          const next = args.compute(current as Record<string, unknown> | null);
          if (!next.ok) return next;
          upserts.push(next as unknown as Record<string, unknown>);
          audit.push({
            tenant_id: args.tenant_id,
            actor_id: args.audit.actor_id,
            actor_role: args.audit.actor_role,
            action: args.audit.action,
            resource_type: 'agent_tool_grant',
            resource_id: args.agent_id,
            change_summary: {
              previous: current,
              next: {
                granted_packs: next.granted_packs,
                granted_tools: next.granted_tools,
                denied_tools: next.denied_tools,
              },
              reason: args.reason,
            },
          });
          return { ok: true as const, grant: { granted_packs: next.granted_packs } };
        },
      },
    } as unknown as typeof import('@/db/repositories.js'),
    assertTenant: () => {},
    assertRole: (...roles: string[]) => {
      if (!roles.includes(role)) {
        throw new TRPCError({ code: 'FORBIDDEN', message: `role ${role} not allowed` });
      }
    },
  };
  return { ctx, audit, upserts, decisions };
}

describe('mcp.registerServer', () => {
  it('registers and audits (owner)', async () => {
    const { ctx, audit } = makeCtx('owner');
    const caller = mcpRouter.createCaller(ctx);
    const res = await caller.registerServer({
      name: 'erp',
      url: 'https://erp.example.com/mcp',
      authSecretRef: 'MCP_SERVER_ERP_TOKEN',
    });
    expect(res.id).toBe(SERVER_UUID);
    expect(audit[0]).toMatchObject({ action: 'mcp_server_registered' });
  });

  it('rejects duplicate name (CONFLICT)', async () => {
    const { ctx } = makeCtx('owner', { existingServer: true });
    const caller = mcpRouter.createCaller(ctx);
    await expect(
      caller.registerServer({ name: 'erp', url: 'https://x.com/mcp', authSecretRef: null }),
    ).rejects.toThrowError(/já existe/);
  });

  it('rejects analyst (role gate)', async () => {
    const { ctx } = makeCtx('analyst');
    const caller = mcpRouter.createCaller(ctx);
    await expect(
      caller.registerServer({ name: 'erp', url: 'https://x.com/mcp', authSecretRef: null }),
    ).rejects.toThrowError(/FORBIDDEN|not allowed/);
  });

  it('rejects secret ref that is not an env-var name (Zod)', async () => {
    const { ctx } = makeCtx('owner');
    const caller = mcpRouter.createCaller(ctx);
    await expect(
      caller.registerServer({
        name: 'erp',
        url: 'https://x.com/mcp',
        authSecretRef: 'meu token em plaintext',
      }),
    ).rejects.toThrowError();
  });
});

describe('mcp.decideTool', () => {
  it('decides with audit (founder)', async () => {
    const { ctx, audit, decisions } = makeCtx('founder');
    const caller = mcpRouter.createCaller(ctx);
    const res = await caller.decideTool({
      toolId: TOOL_UUID,
      decision: 'approved',
      isReadOnly: true,
      riskClass: 'medium',
      comment: 'read-only de listagem de pedidos, baixo blast radius',
    });
    expect(res.id).toBe(TOOL_UUID);
    expect(decisions[0]).toMatchObject({ decision: 'approved', is_read_only: true });
    expect(audit[0]).toMatchObject({ action: 'mcp_tool_decided' });
  });

  it('requires min-10-char comment (Zod)', async () => {
    const { ctx } = makeCtx('owner');
    const caller = mcpRouter.createCaller(ctx);
    await expect(
      caller.decideTool({
        toolId: TOOL_UUID,
        decision: 'rejected',
        isReadOnly: false,
        riskClass: 'critical',
        comment: 'curto',
      }),
    ).rejects.toThrowError();
  });
});

describe('mcp.setAgentPack', () => {
  it('grants the pack preserving existing tools/denies, with audit', async () => {
    const { ctx, audit, upserts } = makeCtx('owner');
    const caller = mcpRouter.createCaller(ctx);
    const res = await caller.setAgentPack({
      serverId: SERVER_UUID,
      agentId: 'agent-a',
      granted: true,
    });
    expect(res.granted_packs).toContain('mcp.erp');
    expect(upserts[0]).toMatchObject({
      granted_tools: ['extra_tool'],
      denied_tools: ['blocked_tool'],
    });
    expect(audit[0]).toMatchObject({ action: 'mcp_pack_grant_changed' });
    const summary = audit[0]!.change_summary as {
      previous: { granted_packs: string[] };
      next: { granted_packs: string[] };
      reason: string;
    };
    expect(summary.next.granted_packs).toContain('mcp.erp');
    expect(summary.previous.granted_packs).not.toContain('mcp.erp');
    expect(summary.reason).toContain('mcp.erp');
  });

  it('revokes the pack', async () => {
    const { ctx, upserts } = makeCtx('founder', {
      grant: {
        granted_packs: ['baseline.core', 'mcp.erp'],
        granted_tools: [],
        denied_tools: [],
      },
    });
    const caller = mcpRouter.createCaller(ctx);
    const res = await caller.setAgentPack({
      serverId: SERVER_UUID,
      agentId: 'agent-a',
      granted: false,
    });
    expect(res.granted_packs).not.toContain('mcp.erp');
    expect((upserts[0]!.granted_packs as string[])).toContain('baseline.core');
  });

  it('agent from another tenant = NOT_FOUND', async () => {
    const { ctx } = makeCtx('owner', { agent: { id: 'x', tenant_id: 'tenant-B' } });
    const caller = mcpRouter.createCaller(ctx);
    await expect(
      caller.setAgentPack({ serverId: SERVER_UUID, agentId: 'x', granted: true }),
    ).rejects.toThrowError(/Agent not found/);
  });
});
