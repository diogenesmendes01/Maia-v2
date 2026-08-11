import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdir, rm, stat, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SANDBOX = join(tmpdir(), 'maia-setup-token-test-' + Date.now());
// Cap. 7 (auditoria P0): o token canônico vive em control/ — fora de
// qualquer alvo de recovery por-linha. O caminho legado (raiz) é migrado
// de forma transparente pelo ensureToken.
const TOKEN_PATH = join(SANDBOX, 'control', 'setup-token.txt');
const LEGACY_TOKEN_PATH = join(SANDBOX, 'setup-token.txt');

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
  it('creates token file under control/ with mode 0o600 when missing and audits cold_start', async () => {
    const { ensureToken } = await import('../../src/setup/token.js');
    const token = await ensureToken();
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    const fileContent = (await readFile(TOKEN_PATH, 'utf-8')).trim();
    expect(fileContent).toBe(token);
    const s = await stat(TOKEN_PATH);
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
    await unlink(TOKEN_PATH);
    // Second call in the SAME module instance: must audit unexpected_missing.
    const token = await ensureToken();
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith({
      acao: 'setup_token_rotated',
      metadata: { reason: 'unexpected_missing' },
    });
  });

  it('rotates and audits when file exists but is empty (security guard)', async () => {
    // Without format validation, ensureToken returned '' and verifyToken('', '')
    // short-circuited via timingSafeEqual to true — authenticating an attacker
    // who omits the ?token= query param entirely. ensureToken must reject
    // empty content and rotate the file.
    await mkdir(join(SANDBOX, 'control'), { recursive: true });
    await writeFile(TOKEN_PATH, '');
    const { ensureToken } = await import('../../src/setup/token.js');
    const token = await ensureToken();
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith({
      acao: 'setup_token_rotated',
      metadata: { reason: 'cold_start' },
    });
    const fileContent = (await readFile(TOKEN_PATH, 'utf-8')).trim();
    expect(fileContent).toBe(token);
  });

  it('rotates and audits when file content is malformed (not 32 hex chars)', async () => {
    await mkdir(join(SANDBOX, 'control'), { recursive: true });
    await writeFile(TOKEN_PATH, 'not-a-valid-token-blob\n');
    const { ensureToken } = await import('../../src/setup/token.js');
    const token = await ensureToken();
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(token).not.toBe('not-a-valid-token-blob');
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith({
      acao: 'setup_token_rotated',
      metadata: { reason: 'cold_start' },
    });
  });

  it('rotates when file has 32 chars but contains non-hex characters', async () => {
    // Right length, wrong alphabet — caller could not have produced this with
    // randomBytes(16).toString('hex'). Treat as corruption, rotate.
    await mkdir(join(SANDBOX, 'control'), { recursive: true });
    await writeFile(TOKEN_PATH, 'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ\n');
    const { ensureToken } = await import('../../src/setup/token.js');
    const token = await ensureToken();
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(token).not.toBe('ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ');
    expect(auditMock).toHaveBeenCalledTimes(1);
  });
});

describe('setup-token — migração transparente do token legado (cap. 7)', () => {
  const LEGACY_TOKEN = 'aaaabbbbccccddddeeeeffff00001111';

  it('honra E move o setup-token.txt legado da raiz para control/ sem rotacionar', async () => {
    await writeFile(LEGACY_TOKEN_PATH, LEGACY_TOKEN + '\n', { mode: 0o600 });
    const { ensureToken } = await import('../../src/setup/token.js');
    const token = await ensureToken();
    // Mesmo valor — o token vigente sobrevive ao upgrade (sem audit de rotação).
    expect(token).toBe(LEGACY_TOKEN);
    expect(auditMock).not.toHaveBeenCalled();
    // Movido: canônico em control/, legado removido da raiz.
    expect((await readFile(TOKEN_PATH, 'utf-8')).trim()).toBe(LEGACY_TOKEN);
    await expect(stat(LEGACY_TOKEN_PATH)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('quando control/ já existe, o novo é o canônico (legado ignorado)', async () => {
    const { ensureToken } = await import('../../src/setup/token.js');
    const canonical = await ensureToken();
    auditMock.mockClear();
    await writeFile(LEGACY_TOKEN_PATH, LEGACY_TOKEN + '\n', { mode: 0o600 });
    vi.resetModules();
    const { ensureToken: ensureToken2 } = await import('../../src/setup/token.js');
    expect(await ensureToken2()).toBe(canonical);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('legado corrompido migra e passa pela MESMA validação de formato (rotaciona)', async () => {
    await writeFile(LEGACY_TOKEN_PATH, 'garbage-token\n');
    const { ensureToken } = await import('../../src/setup/token.js');
    const token = await ensureToken();
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(token).not.toBe('garbage-token');
    expect(auditMock).toHaveBeenCalledWith({
      acao: 'setup_token_rotated',
      metadata: { reason: 'cold_start' },
    });
  });

  it('rotateToken remove também o arquivo legado remanescente na raiz', async () => {
    const { ensureToken, rotateToken } = await import('../../src/setup/token.js');
    await ensureToken();
    // Sobra legada (ex.: escrita por um deploy antigo depois da migração).
    await writeFile(LEGACY_TOKEN_PATH, LEGACY_TOKEN + '\n', { mode: 0o600 });
    await rotateToken();
    await expect(stat(LEGACY_TOKEN_PATH)).rejects.toMatchObject({ code: 'ENOENT' });
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

  it('returns false when BOTH presented and actual are empty (regression guard)', async () => {
    // Without the empty-actual short-circuit, timingSafeEqual on two empty
    // Buffers returns true, which let an empty/corrupt setup-token.txt
    // authenticate `/setup` without a ?token= param. Belt-and-suspenders to
    // the format validation in ensureToken.
    const { verifyToken } = await import('../../src/setup/token.js');
    expect(verifyToken('', '')).toBe(false);
  });
});
