/**
 * Fase 0 cap. 5 (auditoria P0) — guardas de egress e de secret ref do MCP.
 *
 * Antes deste módulo, o Admin aceitava QUALQUER env var name como
 * `authSecretRef` e QUALQUER URL: um owner comprometido escolhia
 * `DATABASE_URL`/`ANTHROPIC_API_KEY` + endpoint próprio e o runtime enviava o
 * valor como Bearer (exfiltração), ou apontava a URL para
 * loopback/RFC1918/metadata (SSRF).
 *
 * Contenção:
 *  - secret refs são um NAMESPACE dedicado (`MCP_SECRET_*`) — nenhum outro
 *    env var é legível pelo caminho MCP, nem para rows legadas do DB;
 *  - URLs: HTTPS obrigatório (http só fora de produção e apenas localhost —
 *    dev loop), sem userinfo, sem porta de datastore, e TODO IP resolvido
 *    precisa ser público (loopback/privado/link-local/CGNAT/ULA/metadata
 *    bloqueados) — verificação na SINTAXE (admin) e na RESOLUÇÃO (runtime,
 *    a cada uso, o que também reduz a janela de DNS rebinding).
 *
 * Sem dependência de config: os callers passam `allowLocalhostHttp` para que
 * o módulo seja importável do admin-ui (Postgres-only) sem puxar env.ts.
 */
import net from 'node:net';

export const MCP_SECRET_REF_RE = /^MCP_SECRET_[A-Z0-9_]{1,80}$/;

export class McpGuardError extends Error {
  readonly code:
    | 'mcp_secret_ref_invalid'
    | 'mcp_url_invalid'
    | 'mcp_url_scheme'
    | 'mcp_url_userinfo'
    | 'mcp_url_port'
    | 'mcp_url_private_address';

  constructor(code: McpGuardError['code'], message: string) {
    super(message);
    this.code = code;
    this.name = 'McpGuardError';
  }
}

/**
 * Refs de secret MCP vivem num namespace próprio. Rejeita qualquer outro env
 * var name — inclusive os já persistidos no DB (defesa em profundidade: a
 * checagem roda no RUNTIME a cada uso, não só no cadastro).
 */
export function assertSafeMcpSecretRef(ref: string): void {
  if (!MCP_SECRET_REF_RE.test(ref)) {
    throw new McpGuardError(
      'mcp_secret_ref_invalid',
      `authSecretRef deve usar o namespace MCP_SECRET_* (recebido: ${ref.slice(0, 40)})`,
    );
  }
}

/** Faixas privadas/reservadas — IPv4, IPv6 e IPv4-mapped. */
export function isPrivateAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateV4(ip);
  if (family === 6) {
    const lower = ip.toLowerCase();
    // IPv4-mapped (::ffff:a.b.c.d) — julga pelo miolo v4.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped && mapped[1]) return isPrivateV4(mapped[1]);
    if (lower === '::' || lower === '::1') return true;
    // fc00::/7 (ULA), fe80::/10 (link-local), ff00::/8 (multicast)
    if (/^f[cd]/.test(lower)) return true;
    if (/^fe[89ab]/.test(lower)) return true;
    if (lower.startsWith('ff')) return true;
    return false;
  }
  // Não é um IP literal — o caller decide (hostname passa pela resolução).
  return false;
}

function isPrivateV4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return true; // malformado ⇒ trata como privado (fail-closed)
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && b === 254) return true; // link-local + metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a >= 224) return true; // multicast + reservado
  return false;
}

/** Portas de datastore/painel que nunca são um endpoint MCP legítimo. */
const BLOCKED_PORTS = new Set(['5432', '6379', '9200', '27017', '3306', '11211']);

/**
 * Validação SINTÁTICA da URL MCP (sem rede — usável no admin e no runtime):
 * https obrigatório (http apenas com `allowLocalhostHttp` E host localhost),
 * sem userinfo, sem porta de datastore, IP literal privado rejeitado.
 */
export function assertSafeMcpUrlSyntax(
  raw: string,
  opts: { allowLocalhostHttp: boolean },
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new McpGuardError('mcp_url_invalid', `URL MCP inválida`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const isLocalhost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (url.protocol !== 'https:') {
    if (!(url.protocol === 'http:' && opts.allowLocalhostHttp && isLocalhost)) {
      throw new McpGuardError(
        'mcp_url_scheme',
        'URL MCP exige https (http apenas em dev para localhost)',
      );
    }
  }
  if (url.username || url.password) {
    throw new McpGuardError('mcp_url_userinfo', 'URL MCP não pode conter credenciais (userinfo)');
  }
  if (url.port && BLOCKED_PORTS.has(url.port)) {
    throw new McpGuardError('mcp_url_port', `porta ${url.port} bloqueada para egress MCP`);
  }
  if (net.isIP(host) && isPrivateAddress(host) && !(opts.allowLocalhostHttp && isLocalhost)) {
    throw new McpGuardError(
      'mcp_url_private_address',
      'URL MCP não pode apontar para endereço privado/reservado',
    );
  }
  return url;
}

/**
 * Verificação de RESOLUÇÃO (runtime, a cada uso): todos os IPs retornados
 * pelo DNS precisam ser públicos. Repetir a checagem por chamada estreita a
 * janela de DNS rebinding; um proxy de egress dedicado continua recomendado.
 */
export async function assertResolvesPublic(
  url: URL,
  opts: { allowLocalhostHttp: boolean },
): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const isLocalhost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (opts.allowLocalhostHttp && isLocalhost) return;
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) {
      throw new McpGuardError(
        'mcp_url_private_address',
        'URL MCP não pode apontar para endereço privado/reservado',
      );
    }
    return;
  }
  const { lookup } = await import('node:dns/promises');
  const results = await lookup(host, { all: true, verbatim: true }).catch(() => []);
  if (results.length === 0) {
    throw new McpGuardError('mcp_url_invalid', `host MCP não resolve: ${host}`);
  }
  for (const r of results) {
    if (isPrivateAddress(r.address)) {
      throw new McpGuardError(
        'mcp_url_private_address',
        `host MCP resolve para endereço privado (${r.address})`,
      );
    }
  }
}
