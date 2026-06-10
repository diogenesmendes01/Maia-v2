/**
 * MCP sync worker (issue #478 — spec §2.7).
 *
 * Ponte admin-ui→runtime por flags: o console marca test_requested_at /
 * sync_requested_at; este worker (único processo com rede para os servers
 * MCP) executa e grava o resultado. Sync aplica o fail-closed da spec §2.6:
 * schema mudado em tool aprovada ⇒ 'suspended' + exige nova decisão humana.
 *
 * Auditoria sob o bucket 'system' (operação de manutenção tenant-level, sem
 * agente específico — glossário ARCHITECTURE.md §7).
 */
import { logger } from '@/lib/logger.js';
import {
  mcpServersRepo,
  mcpServerToolsRepo,
  mcpSchemaHash,
} from '@/db/repositories.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { mcpListTools } from '@/lib/mcp-client.js';
import { audit } from '@/governance/audit.js';

let running = false;

export async function runMcpSyncWorker(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const pending = await mcpServersRepo.listWithPendingOps();
    for (const server of pending) {
      const testPending =
        server.test_requested_at &&
        (!server.last_test_at || server.last_test_at < server.test_requested_at);
      const syncPending =
        server.sync_requested_at &&
        (!server.last_sync_at || server.last_sync_at < server.sync_requested_at);

      if (testPending) {
        try {
          const tools = await mcpListTools({
            url: server.url,
            auth_secret_ref: server.auth_secret_ref,
            serverName: server.name,
          });
          await mcpServersRepo.recordTestResult({
            server_id: server.id,
            result: { ok: true, tool_count: tools.length, at: new Date().toISOString() },
          });
        } catch (err) {
          await mcpServersRepo.recordTestResult({
            server_id: server.id,
            result: {
              ok: false,
              error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
              at: new Date().toISOString(),
            },
          });
        }
      }

      if (syncPending) {
        try {
          const tools = await mcpListTools({
            url: server.url,
            auth_secret_ref: server.auth_secret_ref,
            serverName: server.name,
          });
          const summary = { inserted: 0, unchanged: 0, updated: 0, suspended: 0 };
          for (const t of tools) {
            const { outcome } = await mcpServerToolsRepo.upsertDiscovered({
              tenant_id: server.tenant_id,
              server_id: server.id,
              tool_name: t.name,
              description: t.description,
              input_schema: t.input_schema,
              schema_hash: mcpSchemaHash(t.input_schema),
            });
            if (outcome === 'inserted') summary.inserted++;
            else if (outcome === 'unchanged') summary.unchanged++;
            else if (outcome === 'updated') summary.updated++;
            else summary.suspended++;
          }
          await mcpServersRepo.recordSyncResult({
            server_id: server.id,
            result: { ok: true, ...summary, total: tools.length, at: new Date().toISOString() },
          });
          await runWithTenantContext(
            { tenant_id: server.tenant_id, agent_id: 'system' },
            async () =>
              audit({
                acao: 'mcp_tools_synced',
                alvo_id: server.id,
                metadata: { server: server.name, ...summary, total: tools.length },
              }),
          );
          if (summary.suspended > 0) {
            logger.warn(
              { server: server.name, suspended: summary.suspended },
              'mcp.sync_suspended_tools_schema_change',
            );
          }
        } catch (err) {
          await mcpServersRepo.recordSyncResult({
            server_id: server.id,
            result: {
              ok: false,
              error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
              at: new Date().toISOString(),
            },
          });
          logger.warn({ err, server: server.name }, 'mcp.sync_failed');
        }
      }
    }
  } finally {
    running = false;
  }
}
