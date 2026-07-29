/**
 * Convenção de NOMES de tools MCP — módulo puro (issue #481, item 3).
 *
 * Extraído de `mcp-bridge.ts` para que o console (admin-ui) possa exibir os
 * nomes canônicos das tools de um pack `mcp.<server>` sem arrastar o grafo do
 * hot path (mcp-client, audit, feature-flags, registry). Mesmo precedente de
 * `grant-math.ts`, que é deliberadamente registry-free para poder ser
 * importado pelo client do Next.
 *
 * O bridge continua sendo a ÚNICA autoridade de execução; aqui vive só a
 * gramática do nome, para runtime e console nunca divergirem.
 */

const MCP_PREFIX = 'mcp:';

export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_PREFIX);
}

/** Nome canônico exposto ao LLM: `mcp:<server>:<tool>`. */
export function mcpToolName(serverName: string, tool: string): string {
  return `${MCP_PREFIX}${serverName}:${tool}`;
}

export function parseMcpToolName(
  name: string,
): { serverName: string; tool: string } | null {
  if (!isMcpToolName(name)) return null;
  const rest = name.slice(MCP_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep <= 0 || sep === rest.length - 1) return null;
  return { serverName: rest.slice(0, sep), tool: rest.slice(sep + 1) };
}
