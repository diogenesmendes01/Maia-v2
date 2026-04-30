import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdir, rm, stat, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SANDBOX = join(tmpdir(), 'maia-setup-token-test-' + Date.now());

let configState: { BAILEYS_AUTH_DIR: string; SETUP_TOKEN_OVERRIDE?: string } = {
  BAILEYS_AUTH_DIR: SANDBOX,
};

const auditMock = vi.fn();

vi.mock('../../src/config/env.js', () => ({
  config: new Proxy({} as Record<string, unknown>, {
    get(_t, prop) {
      if (prop === 'BAILEYS_AUTH_DIR') return configState.BAILEYS_AUTH_DIR;
      if (prop === 'SETUP_TOKEN_OVERRIDE') return configState.SETUP_TOKEN_OVERRIDE;
      return undefined;
    },
  }),
}));

vi.mock('../../src/governance/audit.js', () => ({ audit: auditMock }));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeEach(async () => {
  configState = { BAILEYS_AUTH_DIR: SANDBOX };
  auditMock.mockClear();
  await rm(SANDBOX, { recursive: true, force: true });
  await mkdir(SANDBOX, { recursive: true });
  vi.resetModules();
});
afterAll(async () => {
  await rm(SANDBOX, { recursive: true, force: true });
});

describe('setup-token — ensureToken', () => {
  it('creates token file with mode 0o600 when missing and audits cold_start', async () => {
    const { ensureToken } = await import('../../src/setup/token.js');
    const token = await ensureToken();
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    const filePath = join(SANDBOX, 'setup-token.txt');
    const fileContent = (await readFile(filePath, 'utf-8')).trim();
    expect(fileContent).toBe(token);
    const s = await stat(filePath);
    if (process.platform !== 'win32') {
      expect(s.mode & 0o777).toBe(0o600);
    }
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith({
      acao: 'setup_token_rotated',
      metadata: { reason: 'cold_start' },
    });
  });

  it('returns existing token when file exists (idempotent, no audit)', async () => {
    const { ensureToken } = await import('../../src/setup/token.js');
    const token1 = await ensureToken();
    auditMock.mockClear();
    vi.resetModules();
    const { ensureToken: ensureToken2 } = await import('../../src/setup/token.js');
    const token2 = await ensureToken2();
    expect(token2).toBe(token1);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('SETUP_TOKEN_OVERRIDE env bypasses file (no audit)', async () => {
    configState.SETUP_TOKEN_OVERRIDE = 'override-token-123';
    const { ensureToken } = await import('../../src/setup/token.js');
    const token = await ensureToken();
    expect(token).toBe('override-token-123');
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('emits unexpected_missing audit when file vanishes mid-process', async () => {
    const { ensureToken } = await import('../../src/setup/token.js');
    // First call: cold_start path, sets hasInitialised = true.
    await ensureToken();
    auditMock.mockClear();
    // Simulate the file vanishing (filesystem trouble, operator mistake, etc.).
    await unlink(join(SANDBOX, 'setup-token.txt'));
    // Second call in the SAME module instance: must audit unexpected_missing.
    const token = await ensureToken();
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith({
      acao: 'setup_token_rotated',
      metadata: { reason: 'unexpected_missing' },
    });
  });
});

describe('setup-token — rotateToken', () => {
  it('deletes existing and regenerates a new value, emits exactly one recovery_or_pair audit', async () => {
    const { ensureToken, rotateToken } = await import('../../src/setup/token.js');
    const token1 = await ensureToken();
    auditMock.mockClear();
    const token2 = await rotateToken();
    expect(token2).not.toBe(token1);
    expect(token2).toMatch(/^[0-9a-f]{32}$/);
    // Regression guard: rotation must NOT also emit cold_start.
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith({
      acao: 'setup_token_rotated',
      metadata: { reason: 'recovery_or_pair' },
    });
  });

  it('handles ENOENT on unlink (file already gone)', async () => {
    const { rotateToken } = await import('../../src/setup/token.js');
    // No prior ensureToken → file doesn't exist; rotateToken should still succeed.
    const token = await rotateToken();
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith({
      acao: 'setup_token_rotated',
      metadata: { reason: 'recovery_or_pair' },
    });
  });
});

describe('setup-token — verifyToken', () => {
  it('returns true on exact match', async () => {
    const { verifyToken } = await import('../../src/setup/token.js');
    expect(verifyToken('abc123', 'abc123')).toBe(true);
  });

  it('returns false on mismatch (same length)', async () => {
    const { verifyToken } = await import('../../src/setup/token.js');
    expect(verifyToken('abc123', 'abc124')).toBe(false);
  });

  it('returns false on length mismatch (short-circuit)', async () => {
    const { verifyToken } = await import('../../src/setup/token.js');
    expect(verifyToken('abc', 'abc123')).toBe(false);
    expect(verifyToken('abc123', 'abc')).toBe(false);
  });

  it('returns false on empty input vs non-empty actual', async () => {
    const { verifyToken } = await import('../../src/setup/token.js');
    expect(verifyToken('', 'abc123')).toBe(false);
  });
});
