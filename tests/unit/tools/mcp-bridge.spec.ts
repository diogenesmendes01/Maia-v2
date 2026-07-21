/**
 * Fase 0 cap. 5 — contenção do bridge MCP.
 *
 * Prova:
 *  (1) flag OFF ⇒ feature_disabled sem tocar repo/rede;
 *  (2) truncamento BYTE-safe (payload multibyte não estoura o cap);
 *  (3) audit carrega pessoa/conversa/mensagem;
 *  (4) regra constitucional aplica no caminho MCP (C-004 cross-entity).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { auditMock } = vi.hoisted(() => ({ auditMock: vi.fn(async () => undefined) }));
const { flagState } = vi.hoisted(() => ({ flagState: { enabled: false } }));
const { callToolMock } = vi.hoisted(() => ({ callToolMock: vi.fn(async () => 'ok') }));
const { listExecutableMock } = vi.hoisted(() => ({
  listExecutableMock: vi.fn(async () => [
    {
      server_name: 'erp',
      tool_name: 'lookup',
      server_url: 'https://erp.example.com/mcp',
      auth_secret_ref: null,
      input_schema: {},
    },
  ]),
}));

vi.mock('@/config/feature-flags.js', () => ({
  featureFlags: { isEnabled: vi.fn(() => flagState.enabled) },
}));
vi.mock('@/db/tenant-context.js', () => ({
  getCurrentTenant: () => 'primary',
  getCurrentAgent: () => 'primary',
}));
vi.mock('@/db/repositories.js', () => ({
  agentToolGrantsRepo: {
    findForCurrentAgent: vi.fn(async () => ({
      granted_packs: ['mcp.erp'],
      granted_tools: [],
      denied_tools: [],
    })),
  },
  mcpServerToolsRepo: { listExecutable: listExecutableMock },
  mcpPackId: (s: string) => `mcp.${s}`,
}));
vi.mock('@/lib/mcp-client.js', () => ({ mcpCallTool: callToolMock }));
vi.mock('@/governance/audit.js', () => ({ audit: auditMock }));
vi.mock('@/lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { dispatchMcpTool } from '@/tools/mcp-bridge.js';
import type { Pessoa, Conversa } from '@/db/schema.js';

const ctx = {
  pessoa: { id: 'p-1' } as Pessoa,
  scope: { entidades: ['e-1'] },
  conversa: { id: 'c-1' } as Conversa,
  mensagem_id: 'm-1',
  request_id: 'r-1',
};

beforeEach(() => {
  flagState.enabled = false;
  auditMock.mockClear();
  callToolMock.mockClear();
  listExecutableMock.mockClear();
});

describe('dispatchMcpTool — contenção (Fase 0 cap. 5)', () => {
  it('(1) flag OFF: feature_disabled sem repo nem rede', async () => {
    const res = await dispatchMcpTool({ tool: 'mcp:erp:lookup', args: {}, request_id: 'r-1', ctx });
    expect(res).toMatchObject({ error: 'feature_disabled' });
    expect(listExecutableMock).not.toHaveBeenCalled();
    expect(callToolMock).not.toHaveBeenCalled();
  });

  it('(2) truncamento byte-safe com payload multibyte', async () => {
    flagState.enabled = true;
    // 40k de emoji (4 bytes cada) — bem acima do cap de 32KB.
    callToolMock.mockResolvedValueOnce('😀'.repeat(40_000));
    const res = (await dispatchMcpTool({
      tool: 'mcp:erp:lookup',
      args: {},
      request_id: 'r-1',
      ctx,
    })) as { result: { content: string; truncated: boolean } };
    expect(res.result.truncated).toBe(true);
    const suffix = '\n…[resultado truncado pelo cap de 32KB]';
    const body = res.result.content.slice(0, -suffix.length);
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(32 * 1024);
    // Sem replacement char de surrogate partido no fim do corte.
    expect(body.endsWith('�')).toBe(false);
  });

  it('(3) audit carrega pessoa/conversa/mensagem', async () => {
    flagState.enabled = true;
    await dispatchMcpTool({ tool: 'mcp:erp:lookup', args: {}, request_id: 'r-1', ctx });
    const call = auditMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(call).toMatchObject({
      acao: 'mcp_tool_call',
      pessoa_id: 'p-1',
      conversa_id: 'c-1',
      mensagem_id: 'm-1',
    });
  });

  it('(4) C-004: entidade fora do escopo é bloqueada antes da rede', async () => {
    flagState.enabled = true;
    const res = await dispatchMcpTool({
      tool: 'mcp:erp:lookup',
      args: { entidade_id: 'entidade-de-outro' },
      request_id: 'r-1',
      ctx,
    });
    expect(res).toMatchObject({ error: 'forbidden' });
    expect(callToolMock).not.toHaveBeenCalled();
  });
});
