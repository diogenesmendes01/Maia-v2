/**
 * MCP externo v1 — repos (issue #478, migração 089).
 *
 * Métodos com tenant_id EXPLÍCITO (sem ALS) — chamáveis do admin-ui e do
 * worker mcp_sync. Toda leitura/escrita escopada por tenant (invariante 1);
 * um id de server/tool sozinho nunca cruza tenants.
 */
import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { db } from '../client.js';
import {
  mcp_servers,
  mcp_server_tools,
  type McpServer,
  type McpServerTool,
} from '../schema.js';

export function mcpSchemaHash(inputSchema: unknown): string {
  return createHash('sha256').update(JSON.stringify(inputSchema ?? {})).digest('hex');
}

/** Pack id dinâmico de um server MCP (grant por agente — spec §2). */
export function mcpPackId(serverName: string): string {
  return `mcp.${serverName}`;
}

export const mcpServersRepo = {
  async create(args: {
    tenant_id: string;
    name: string;
    url: string;
    auth_secret_ref: string | null;
    created_by: string;
  }): Promise<McpServer> {
    const [row] = await db
      .insert(mcp_servers)
      .values({
        tenant_id: args.tenant_id,
        name: args.name,
        url: args.url,
        auth_secret_ref: args.auth_secret_ref,
        created_by: args.created_by,
        // Registro já pede o primeiro sync — o worker descobre as tools.
        sync_requested_at: new Date(),
      })
      .returning();
    return row!;
  },

  async listByTenant(tenant_id: string): Promise<McpServer[]> {
    return db
      .select()
      .from(mcp_servers)
      .where(eq(mcp_servers.tenant_id, tenant_id))
      .orderBy(asc(mcp_servers.name));
  },

  async findById(args: { tenant_id: string; server_id: string }): Promise<McpServer | null> {
    const rows = await db
      .select()
      .from(mcp_servers)
      .where(
        and(eq(mcp_servers.id, args.server_id), eq(mcp_servers.tenant_id, args.tenant_id)),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async findByName(args: { tenant_id: string; name: string }): Promise<McpServer | null> {
    const rows = await db
      .select()
      .from(mcp_servers)
      .where(and(eq(mcp_servers.name, args.name), eq(mcp_servers.tenant_id, args.tenant_id)))
      .limit(1);
    return rows[0] ?? null;
  },

  async setStatus(args: {
    tenant_id: string;
    server_id: string;
    status: 'active' | 'disabled';
  }): Promise<McpServer | null> {
    const [row] = await db
      .update(mcp_servers)
      .set({ status: args.status, updated_at: new Date() })
      .where(
        and(eq(mcp_servers.id, args.server_id), eq(mcp_servers.tenant_id, args.tenant_id)),
      )
      .returning();
    return row ?? null;
  },

  async requestOp(args: {
    tenant_id: string;
    server_id: string;
    op: 'test' | 'sync';
  }): Promise<boolean> {
    const set =
      args.op === 'test'
        ? { test_requested_at: new Date(), updated_at: new Date() }
        : { sync_requested_at: new Date(), updated_at: new Date() };
    const rows = await db
      .update(mcp_servers)
      .set(set)
      .where(
        and(eq(mcp_servers.id, args.server_id), eq(mcp_servers.tenant_id, args.tenant_id)),
      )
      .returning({ id: mcp_servers.id });
    return rows.length > 0;
  },

  /** Servers ativos com teste ou sync pendente (cross-tenant: só o worker usa). */
  async listWithPendingOps(): Promise<McpServer[]> {
    return db
      .select()
      .from(mcp_servers)
      .where(
        and(
          eq(mcp_servers.status, 'active'),
          sql`(
            (${mcp_servers.test_requested_at} IS NOT NULL AND
             (${mcp_servers.last_test_at} IS NULL OR ${mcp_servers.last_test_at} < ${mcp_servers.test_requested_at}))
            OR
            (${mcp_servers.sync_requested_at} IS NOT NULL AND
             (${mcp_servers.last_sync_at} IS NULL OR ${mcp_servers.last_sync_at} < ${mcp_servers.sync_requested_at}))
          )`,
        ),
      );
  },

  async recordTestResult(args: {
    server_id: string;
    result: Record<string, unknown>;
  }): Promise<void> {
    await db
      .update(mcp_servers)
      .set({ last_test_at: new Date(), last_test_result: args.result, updated_at: new Date() })
      .where(eq(mcp_servers.id, args.server_id));
  },

  async recordSyncResult(args: {
    server_id: string;
    result: Record<string, unknown>;
  }): Promise<void> {
    await db
      .update(mcp_servers)
      .set({ last_sync_at: new Date(), last_sync_result: args.result, updated_at: new Date() })
      .where(eq(mcp_servers.id, args.server_id));
  },
};

export const mcpServerToolsRepo = {
  async listByServer(args: {
    tenant_id: string;
    server_id: string;
  }): Promise<McpServerTool[]> {
    return db
      .select()
      .from(mcp_server_tools)
      .where(
        and(
          eq(mcp_server_tools.server_id, args.server_id),
          eq(mcp_server_tools.tenant_id, args.tenant_id),
        ),
      )
      .orderBy(asc(mcp_server_tools.tool_name));
  },

  /**
   * Upsert de descoberta (worker mcp_sync). Fail-closed da spec §2.6:
   * tool APROVADA cujo schema_hash mudou volta para 'suspended' — só nova
   * aprovação humana a reabilita. Demais status preservam a decisão.
   */
  async upsertDiscovered(args: {
    tenant_id: string;
    server_id: string;
    tool_name: string;
    description: string | null;
    input_schema: unknown;
    schema_hash: string;
  }): Promise<{ outcome: 'inserted' | 'unchanged' | 'updated' | 'suspended_schema_change' }> {
    const existingRows = await db
      .select()
      .from(mcp_server_tools)
      .where(
        and(
          eq(mcp_server_tools.server_id, args.server_id),
          eq(mcp_server_tools.tool_name, args.tool_name),
        ),
      )
      .limit(1);
    const existing = existingRows[0];
    const now = new Date();

    if (!existing) {
      await db.insert(mcp_server_tools).values({
        server_id: args.server_id,
        tenant_id: args.tenant_id,
        tool_name: args.tool_name,
        description: args.description,
        input_schema: args.input_schema,
        schema_hash: args.schema_hash,
      });
      return { outcome: 'inserted' };
    }

    if (existing.schema_hash === args.schema_hash) {
      await db
        .update(mcp_server_tools)
        .set({ last_seen_at: now, description: args.description })
        .where(eq(mcp_server_tools.id, existing.id));
      return { outcome: 'unchanged' };
    }

    const suspend = existing.status === 'approved';
    await db
      .update(mcp_server_tools)
      .set({
        description: args.description,
        input_schema: args.input_schema,
        schema_hash: args.schema_hash,
        last_seen_at: now,
        updated_at: now,
        ...(suspend ? { status: 'suspended' as const } : {}),
      })
      .where(eq(mcp_server_tools.id, existing.id));
    return { outcome: suspend ? 'suspended_schema_change' : 'updated' };
  },

  async decide(args: {
    tenant_id: string;
    tool_id: string;
    decision: 'approved' | 'rejected';
    is_read_only: boolean;
    risk_class: 'low' | 'medium' | 'high' | 'critical';
    actor_id: string;
    comment: string;
  }): Promise<McpServerTool | null> {
    const [row] = await db
      .update(mcp_server_tools)
      .set({
        status: args.decision,
        is_read_only: args.is_read_only,
        risk_class: args.risk_class,
        approved_by: args.actor_id,
        approved_at: new Date(),
        decision_comment: args.comment,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(mcp_server_tools.id, args.tool_id),
          eq(mcp_server_tools.tenant_id, args.tenant_id),
        ),
      )
      .returning();
    return row ?? null;
  },

  /**
   * Tools executáveis de um tenant: aprovadas + read-only (flag de fase v1)
   * + server ativo. Base da visibilidade no prompt e da execução no bridge.
   */
  async listExecutable(args: {
    tenant_id: string;
  }): Promise<Array<McpServerTool & { server_name: string; server_url: string; auth_secret_ref: string | null }>> {
    const rows = await db
      .select({
        tool: mcp_server_tools,
        server_name: mcp_servers.name,
        server_url: mcp_servers.url,
        auth_secret_ref: mcp_servers.auth_secret_ref,
      })
      .from(mcp_server_tools)
      .innerJoin(mcp_servers, eq(mcp_server_tools.server_id, mcp_servers.id))
      .where(
        and(
          eq(mcp_server_tools.tenant_id, args.tenant_id),
          eq(mcp_server_tools.status, 'approved'),
          eq(mcp_server_tools.is_read_only, true),
          eq(mcp_servers.status, 'active'),
          isNotNull(mcp_servers.url),
        ),
      );
    return rows.map((r) => ({
      ...r.tool,
      server_name: r.server_name,
      server_url: r.server_url,
      auth_secret_ref: r.auth_secret_ref,
    }));
  },
};
