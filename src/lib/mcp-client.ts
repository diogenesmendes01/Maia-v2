/**
 * Cliente MCP first-party (issue #478 — spec §2.2).
 *
 * Wrapper fino sobre @modelcontextprotocol/sdk com:
 *   - transporte streamable HTTP + bearer via SECRET REF (env var no runtime;
 *     o banco nunca guarda o token);
 *   - timeout duro por operação (conexão/list/call);
 *   - conexões efêmeras (connect→op→close): v1 prioriza simplicidade e
 *     isolamento sobre pooling — o volume é baixo (tools aprovadas, owner-led).
 *
 * SOMENTE o processo runtime importa este módulo (admin-ui é Postgres-only).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const OP_TIMEOUT_MS = 15_000;

export type McpDiscoveredTool = {
  name: string;
  description: string | null;
  input_schema: Record<string, unknown>;
};

function resolveBearer(authSecretRef: string | null): string | null {
  if (!authSecretRef) return null;
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
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const bearer = resolveBearer(args.auth_secret_ref);
  const transport = new StreamableHTTPClientTransport(new URL(args.url), {
    requestInit: bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : undefined,
  });
  const client = new Client({ name: 'maia-runtime', version: '1.0.0' });
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('mcp_op_timeout')), OP_TIMEOUT_MS),
  );
  try {
    await Promise.race([client.connect(transport), timeout]);
    return await Promise.race([fn(client), timeout]);
  } finally {
    await client.close().catch(() => {});
  }
}

export async function mcpListTools(args: {
  url: string;
  auth_secret_ref: string | null;
  serverName: string;
}): Promise<McpDiscoveredTool[]> {
  return withClient(args, async (client) => {
    const res = await client.listTools();
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
  return withClient(args, async (client) => {
    const res = await client.callTool({ name: args.tool, arguments: args.toolArgs });
    return res;
  });
}
