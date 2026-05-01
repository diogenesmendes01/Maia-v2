import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeEach(async () => {
  vi.resetModules();
});

describe('setup-state — phase transitions', () => {
  it('initialises in unpaired phase', async () => {
    const { setupState } = await import('../../src/setup/state.js');
    expect(setupState.current().phase).toBe('unpaired');
  });

  it('setQr from unpaired auto-transitions to pairing_qr', async () => {
    const { setupState } = await import('../../src/setup/state.js');
    setupState.setQr('qr-string-1');
    const c = setupState.current();
    expect(c.phase).toBe('pairing_qr');
    if (c.phase === 'pairing_qr') expect(c.qr).toBe('qr-string-1');
  });

  it('setQr while in pairing_qr just updates the qr', async () => {
    const { setupState } = await import('../../src/setup/state.js');
    setupState.setQr('qr-1');
    setupState.setQr('qr-2');
    const c = setupState.current();
    if (c.phase === 'pairing_qr') expect(c.qr).toBe('qr-2');
  });

  it('setQr from disconnected_transient auto-transitions to pairing_qr', async () => {
    const { setupState } = await import('../../src/setup/state.js');
    setupState.markPaired();
    setupState.markDisconnected();
    expect(setupState.current().phase).toBe('disconnected_transient');
    setupState.setQr('qr-after-reconnect');
    expect(setupState.current().phase).toBe('pairing_qr');
  });

  it('setCode from unpaired transitions to pairing_code with expiresAt', async () => {
    const { setupState, PAIRING_CODE_TTL_MS } = await import('../../src/setup/state.js');
    const before = Date.now();
    setupState.setCode('12345678');
    const c = setupState.current();
    expect(c.phase).toBe('pairing_code');
    if (c.phase === 'pairing_code') {
      expect(c.code).toBe('12345678');
      expect(c.expiresAt.getTime()).toBeGreaterThanOrEqual(before + PAIRING_CODE_TTL_MS - 100);
      expect(c.expiresAt.getTime()).toBeLessThanOrEqual(before + PAIRING_CODE_TTL_MS + 100);
    }
  });

  it('pairing_code lazily expires to unpaired on current() read after TTL', async () => {
    vi.useFakeTimers();
    try {
      const { setupState, PAIRING_CODE_TTL_MS } = await import('../../src/setup/state.js');
      setupState.setCode('12345678');
      expect(setupState.current().phase).toBe('pairing_code');
      vi.advanceTimersByTime(PAIRING_CODE_TTL_MS + 1000);
      expect(setupState.current().phase).toBe('unpaired');
    } finally {
      vi.useRealTimers();
    }
  });

  it('markPaired transitions from pairing_qr to connected', async () => {
    const { setupState } = await import('../../src/setup/state.js');
    setupState.setQr('qr');
    setupState.markPaired();
    expect(setupState.current().phase).toBe('connected');
  });

  it('markDisconnected transitions from connected to disconnected_transient', async () => {
    const { setupState } = await import('../../src/setup/state.js');
    setupState.setQr('qr');
    setupState.markPaired();
    setupState.markDisconnected();
    expect(setupState.current().phase).toBe('disconnected_transient');
  });

  it('illegal transitions throw — setCode from connected', async () => {
    const { setupState } = await import('../../src/setup/state.js');
    setupState.setQr('qr');
    setupState.markPaired();
    expect(() => setupState.setCode('11111111')).toThrow();
  });
});

describe('setup-state — hasValidBaileysSession', () => {
  let SANDBOX: string;

  beforeEach(async () => {
    SANDBOX = join(tmpdir(), `maia-setup-state-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(SANDBOX, { recursive: true });
  });

  afterEach(async () => {
    await rm(SANDBOX, { recursive: true, force: true }).catch(() => undefined);
  });

  it('returns false when creds.json missing', async () => {
    const { hasValidBaileysSession } = await import('../../src/setup/state.js');
    expect(await hasValidBaileysSession(SANDBOX)).toBe(false);
  });

  it('returns false when creds.json present but missing me field', async () => {
    await writeFile(join(SANDBOX, 'creds.json'), JSON.stringify({ noteworthy: 'data' }));
    const { hasValidBaileysSession } = await import('../../src/setup/state.js');
    expect(await hasValidBaileysSession(SANDBOX)).toBe(false);
  });

  it('returns true when creds.json has me field', async () => {
    await writeFile(join(SANDBOX, 'creds.json'), JSON.stringify({ me: { id: '5511...' } }));
    const { hasValidBaileysSession } = await import('../../src/setup/state.js');
    expect(await hasValidBaileysSession(SANDBOX)).toBe(true);
  });
});

describe('setup-recovery — concurrency lock', () => {
  it('triggerRecovery is idempotent and runs the full recovery sequence exactly once', async () => {
    vi.resetModules();
    const auditMock = vi.fn().mockResolvedValue(undefined);
    const sendAlertMock = vi.fn().mockResolvedValue(undefined);
    const rotateTokenMock = vi.fn().mockResolvedValue('new-token');
    vi.doMock('../../src/governance/audit.js', () => ({ audit: auditMock }));
    vi.doMock('../../src/lib/alerts.js', () => ({ sendAlert: sendAlertMock }));
    vi.doMock('../../src/setup/token.js', () => ({ rotateToken: rotateTokenMock }));
    vi.doMock('../../src/config/env.js', () => ({
      config: { BAILEYS_AUTH_DIR: '/tmp/maia-recovery-test-stub' },
    }));
    vi.doMock('node:fs/promises', async (orig) => {
      const real = await orig<typeof import('node:fs/promises')>();
      return { ...real, rm: vi.fn().mockResolvedValue(undefined) };
    });

    const shutdownBaileys = vi.fn().mockResolvedValue(undefined);
    const startBaileys = vi.fn().mockResolvedValue(undefined);

    const { triggerRecovery, _internal } = await import('../../src/setup/recovery.js');
    const { setupState } = await import('../../src/setup/state.js');

    const p1 = triggerRecovery({ shutdownBaileys, startBaileys });
    const p2 = triggerRecovery({ shutdownBaileys, startBaileys });
    expect(p1).toBe(p2); // singleton lock: same promise reference
    await p1;

    // Each side-effect runs exactly once.
    expect(shutdownBaileys).toHaveBeenCalledTimes(1);
    expect(startBaileys).toHaveBeenCalledTimes(1);
    expect(rotateTokenMock).toHaveBeenCalledTimes(1);
    expect(sendAlertMock).toHaveBeenCalledTimes(1);

    // Audit trail is complete (start + completed).
    expect(auditMock).toHaveBeenCalledWith({ acao: 'pairing_recovery_started' });
    expect(auditMock).toHaveBeenCalledWith({ acao: 'pairing_recovery_completed' });

    // Final state is unpaired (recovery completed; setUnpaired ran before sendAlert).
    expect(setupState.current().phase).toBe('unpaired');

    // Lock released.
    expect(_internal.isRecovering()).toBe(false);
  });
});
