import { describe, it, expect } from 'vitest';
import {
  MCP_SECRET_REF_RE,
  assertSafeMcpSecretRef,
  assertSafeMcpUrlSyntax,
  assertResolvesPublic,
  isPrivateAddress,
  McpGuardError,
} from '../../src/lib/mcp-url-guard.js';

describe('assertSafeMcpSecretRef', () => {
  it('aceita apenas o namespace MCP_SECRET_*', () => {
    expect(() => assertSafeMcpSecretRef('MCP_SECRET_ERP_TOKEN')).not.toThrow();
    expect(MCP_SECRET_REF_RE.test('MCP_SECRET_A1')).toBe(true);
  });
  it.each([
    'DATABASE_URL',
    'ANTHROPIC_API_KEY',
    'NEXTAUTH_SECRET',
    'RUNTIME_TRACE_HMAC_MASTER_SECRET',
    'POSTGRES_PASSWORD',
    'MCP_SECRET_', // vazio após o prefixo
    'mcp_secret_x', // minúsculas
  ])('rejeita %s (env var fora do namespace)', (ref) => {
    expect(() => assertSafeMcpSecretRef(ref)).toThrowError(McpGuardError);
  });
});

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // metadata
    '100.64.0.1', // CGNAT
    '0.0.0.0',
    '224.0.0.1', // multicast
    '::1',
    '::',
    'fc00::1',
    'fd12::1',
    'fe80::1',
    '::ffff:10.0.0.1', // v4-mapped
  ])('%s é privado/reservado', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('%s é público', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });
  // Revisão adversarial: forma HEX do IPv4-mapped não era normalizada pelo
  // node nem coberta pelo regex pontilhado — passava como pública.
  it.each([
    '::ffff:7f00:1', // 127.0.0.1
    '::ffff:a9fe:a9fe', // 169.254.169.254 (metadata)
    '::ffff:0a00:0001', // 10.0.0.1
    '::ffff:c0a8:0001', // 192.168.0.1
  ])('IPv4-mapped hex %s é privado', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });
});

describe('assertSafeMcpUrlSyntax — IPv4-mapped hex (revisão adversarial)', () => {
  it.each([
    'https://[::ffff:7f00:1]/mcp',
    'https://[::ffff:a9fe:a9fe]/latest/meta-data/',
  ])('rejeita %s', (url) => {
    expect(() => assertSafeMcpUrlSyntax(url, { allowLocalhostHttp: false })).toThrowError(
      McpGuardError,
    );
  });
});

describe('assertSafeMcpUrlSyntax', () => {
  const prod = { allowLocalhostHttp: false };
  const dev = { allowLocalhostHttp: true };

  it('exige https em produção', () => {
    expect(() => assertSafeMcpUrlSyntax('http://example.com/mcp', prod)).toThrowError(
      McpGuardError,
    );
    expect(() => assertSafeMcpUrlSyntax('https://example.com/mcp', prod)).not.toThrow();
  });
  it('http localhost permitido apenas em dev', () => {
    expect(() => assertSafeMcpUrlSyntax('http://localhost:8080/mcp', dev)).not.toThrow();
    expect(() => assertSafeMcpUrlSyntax('http://localhost:8080/mcp', prod)).toThrowError(
      McpGuardError,
    );
  });
  it('rejeita userinfo', () => {
    expect(() => assertSafeMcpUrlSyntax('https://user:pass@example.com/mcp', prod)).toThrowError(
      /userinfo|credenciais/,
    );
  });
  it('rejeita IP literal privado (loopback, RFC1918, metadata)', () => {
    for (const bad of [
      'https://127.0.0.1/mcp',
      'https://10.0.0.5/mcp',
      'https://169.254.169.254/latest/meta-data/',
      'https://[::1]/mcp',
      'https://[fd00::1]/mcp',
    ]) {
      expect(() => assertSafeMcpUrlSyntax(bad, prod), bad).toThrowError(McpGuardError);
    }
  });
  it('rejeita portas de datastore', () => {
    expect(() => assertSafeMcpUrlSyntax('https://example.com:5432/mcp', prod)).toThrowError(
      /porta/,
    );
    expect(() => assertSafeMcpUrlSyntax('https://example.com:6379/mcp', prod)).toThrowError(
      /porta/,
    );
  });
});

describe('assertResolvesPublic', () => {
  const prod = { allowLocalhostHttp: false };
  it('IP literal privado falha sem tocar DNS', async () => {
    await expect(
      assertResolvesPublic(new URL('https://192.168.0.10/mcp'), prod),
    ).rejects.toThrowError(McpGuardError);
  });
  it('IP literal público passa sem DNS', async () => {
    await expect(assertResolvesPublic(new URL('https://8.8.8.8/mcp'), prod)).resolves.toBeUndefined();
  });
});
