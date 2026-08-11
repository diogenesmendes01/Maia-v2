/**
 * Cliente MCP first-party (issue #478 — spec §2.2; endurecido na Fase 0
 * cap. 5 da auditoria P0).
 *
 * Wrapper fino sobre @modelcontextprotocol/sdk com:
 *   - transporte streamable HTTP + bearer via SECRET REF restrito ao
 *     namespace `MCP_SECRET_*` (o runtime NUNCA lê um env var arbitrário —
 *     nem para rows legadas do DB; ver src/lib/mcp-url-guard.ts);
 *   - egress guard anti-SSRF: https obrigatório, sem userinfo, sem porta de
 *     datastore, TODOS os IPs resolvidos precisam ser públicos (checado a
 *     cada uso — reduz janela de DNS rebinding);
 *   - timeout REAL por operação via AbortController: o abort cancela o fetch
 *     em voo (antes era um Promise.race que deixava a chamada rodando);
 *   - conexões efêmeras (connect→op→close): v1 prioriza simplicidade e
 *     isolamento sobre pooling — o volume é baixo (tools aprovadas, owner-led).
 *
 * SOMENTE o processo runtime importa este módulo (admin-ui é Postgres-only).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { config } from '@/config/env.js';
import {
  assertSafeMcpSecretRef,
  assertSafeMcpUrlSyntax,
  assertResolvesPublic,
} from './mcp-url-guard.js';

const OP_TIMEOUT_MS = 15_000;

export type McpDiscoveredTool = {
  name: string;
  description: string | null;
  input_schema: Record<string, unknown>;
};

function resolveBearer(authSecretRef: string | null): string | null {
  if (!authSecretRef) return null;
  // Fase 0 cap. 5 — namespace fechado: bloqueia exfiltração de
  // DATABASE_URL/API keys mesmo para refs legadas já persistidas.
  assertSafeMcpSecretRef(authSecretRef);
  const token = process.env[authSecretRef];
  // Fail-closed: ref declarado mas env ausente é erro de configuração — não
  // conectamos "sem auth" silenciosamente.
  if (!token) {
    throw new Error(`mcp_secret_ref_unset: env ${authSecretRef} não definida no runtime`);
  }
  return token;
}

async function withClient<T>(
  args: { url: string; auth_secret_ref: string | null; serverName: string },
  fn: (client: Client, opts: { signal: AbortSignal; timeout: number }) => Promise<T>,
): Promise<T> {
  const allowLocalhostHttp = config.NODE_ENV !== 'production';
  const url = assertSafeMcpUrlSyntax(args.url, { allowLocalhostHttp });
  await assertResolvesPublic(url, { allowLocalhostHttp });

  const bearer = resolveBearer(args.auth_secret_ref);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('mcp_op_timeout')), OP_TIMEOUT_MS);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {
      signal: controller.signal,
      ...(bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : {}),
    },
  });
  const client = new Client({ name: 'maia-runtime', version: '1.0.0' });
  try {
    await client.connect(transport);
    return await fn(client, { signal: controller.signal, timeout: OP_TIMEOUT_MS });
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {});
  }
}

export async function mcpListTools(args: {
  url: string;
  auth_secret_ref: string | null;
  serverName: string;
}): Promise<McpDiscoveredTool[]> {
  return withClient(args, async (client, opts) => {
    const res = await client.listTools(undefined, opts);
    return (res.tools ?? []).map((t) => ({
      name: t.name,
      description: typeof t.description === 'string' ? t.description : null,
      input_schema: (t.inputSchema ?? {}) as Record<string, unknown>,
    }));
  });
}

export async function mcpCallTool(args: {
  url: string;
  auth_secret_ref: string | null;
  serverName: string;
  tool: string;
  toolArgs: Record<string, unknown>;
}): Promise<unknown> {
  return withClient(args, async (client, opts) => {
    const res = await client.callTool(
      { name: args.tool, arguments: args.toolArgs },
      undefined,
      opts,
    );
    return res;
  });
}
