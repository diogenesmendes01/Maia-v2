import { describe, it, expect, beforeEach, vi } from 'vitest';
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
    const { setupState, PAIRING_CODE_TTL_MS } = await import('../../src/setup/state.js');
    setupState.setCode('12345678');
    expect(setupState.current().phase).toBe('pairing_code');
    vi.advanceTimersByTime(PAIRING_CODE_TTL_MS + 1000);
    expect(setupState.current().phase).toBe('unpaired');
    vi.useRealTimers();
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
  const SANDBOX = join(tmpdir(), 'maia-setup-state-test-' + Date.now());

  it('returns false when creds.json missing', async () => {
    await mkdir(SANDBOX, { recursive: true });
    const { hasValidBaileysSession } = await import('../../src/setup/state.js');
    expect(await hasValidBaileysSession(SANDBOX)).toBe(false);
    await rm(SANDBOX, { recursive: true, force: true });
  });

  it('returns false when creds.json present but missing me field', async () => {
    await mkdir(SANDBOX, { recursive: true });
    await writeFile(join(SANDBOX, 'creds.json'), JSON.stringify({ noteworthy: 'data' }));
    const { hasValidBaileysSession } = await import('../../src/setup/state.js');
    expect(await hasValidBaileysSession(SANDBOX)).toBe(false);
    await rm(SANDBOX, { recursive: true, force: true });
  });

  it('returns true when creds.json has me field', async () => {
    await mkdir(SANDBOX, { recursive: true });
    await writeFile(join(SANDBOX, 'creds.json'), JSON.stringify({ me: { id: '5511...' } }));
    const { hasValidBaileysSession } = await import('../../src/setup/state.js');
    expect(await hasValidBaileysSession(SANDBOX)).toBe(true);
    await rm(SANDBOX, { recursive: true, force: true });
  });
});

describe('setup-recovery — concurrency lock', () => {
  it('triggerRecovery is idempotent: concurrent calls share the same promise', async () => {
    vi.resetModules();
    vi.doMock('../../src/governance/audit.js', () => ({ audit: vi.fn() }));
    vi.doMock('../../src/lib/alerts.js', () => ({ sendAlert: vi.fn().mockResolvedValue(undefined) }));
    vi.doMock('../../src/setup/token.js', () => ({
      rotateToken: vi.fn().mockResolvedValue('new-token'),
    }));
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
    const p1 = triggerRecovery({ shutdownBaileys, startBaileys });
    const p2 = triggerRecovery({ shutdownBaileys, startBaileys });
    expect(p1).toBe(p2); // same promise reference
    await p1;
    expect(shutdownBaileys).toHaveBeenCalledTimes(1);
    expect(startBaileys).toHaveBeenCalledTimes(1);
    expect(_internal.isRecovering()).toBe(false);
  });
});
