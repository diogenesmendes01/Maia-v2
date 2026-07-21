/**
 * Fase 0 cap. 5 — com FEATURE_MCP_TOOLS off o worker de sync MCP é NO-OP
 * total: nenhuma leitura de pendências, nenhuma rede, nenhum secret. Sem
 * este gate, o simples cadastro de um server (que auto-enfileira sync)
 * faria o runtime buscar a URL do admin com o bearer resolvido.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { flagState } = vi.hoisted(() => ({ flagState: { enabled: false } }));
const { listPendingMock } = vi.hoisted(() => ({ listPendingMock: vi.fn(async () => []) }));

vi.mock('@/config/feature-flags.js', () => ({
  featureFlags: { isEnabled: vi.fn(() => flagState.enabled) },
}));
vi.mock('@/db/repositories.js', () => ({
  mcpServersRepo: { listWithPendingOps: listPendingMock },
  mcpServerToolsRepo: {},
  mcpSchemaHash: vi.fn(() => 'hash'),
}));
vi.mock('@/lib/mcp-client.js', () => ({ mcpListTools: vi.fn() }));
vi.mock('@/governance/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('@/db/tenant-context.js', () => ({ runWithTenantContext: vi.fn() }));
vi.mock('@/lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { runMcpSyncWorker } from '@/workers/mcp-sync-worker.js';

beforeEach(() => {
  flagState.enabled = false;
  listPendingMock.mockClear();
});

describe('mcp_sync worker — gate por flag (Fase 0 cap. 5)', () => {
  it('flag OFF: não lê pendências nem toca rede', async () => {
    await runMcpSyncWorker();
    expect(listPendingMock).not.toHaveBeenCalled();
  });
  it('flag ON: processa pendências normalmente', async () => {
    flagState.enabled = true;
    await runMcpSyncWorker();
    expect(listPendingMock).toHaveBeenCalledTimes(1);
  });
});
