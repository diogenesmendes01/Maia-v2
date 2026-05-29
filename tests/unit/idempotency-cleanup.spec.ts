import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tryGetCurrentContext, isSystemContext } from '../../src/db/tenant-context.js';

// idempotency_cleanup worker (issue #323 phase 2). The repo `cleanup` is an
// explicitly-global sweep (unconditioned DELETEs, no tenant predicate), so the
// worker is GENUINELY GLOBAL and was re-homed from the legacy `default/default`
// literal to the reserved `system` sentinel. These tests mock the repo and
// capture the live ALS context to prove the wrapper.

const cleanupMock = vi.fn();
const loggerInfo = vi.fn();

vi.mock('../../src/db/repositories.js', () => ({
  idempotencyRepo: { cleanup: cleanupMock },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: loggerInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

beforeEach(() => {
  cleanupMock.mockReset();
  loggerInfo.mockClear();
});

describe('idempotency-cleanup worker', () => {
  it('invokes the global cleanup sweep and logs the removed count', async () => {
    cleanupMock.mockResolvedValue(7);
    const { runIdempotencyCleanup } = await import('../../src/workers/idempotency-cleanup.js');
    await runIdempotencyCleanup();

    expect(cleanupMock).toHaveBeenCalledTimes(1);
    // 30-day retention window (matches the worker contract).
    expect(cleanupMock).toHaveBeenCalledWith(30);
    expect(loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ removed: 7 }),
      'idempotency_cleanup.done',
    );
  });

  it('runs under the reserved system context (not default/default)', async () => {
    let observed: { tenant_id: string; agent_id: string } | null = null;
    cleanupMock.mockImplementation(async () => {
      observed = tryGetCurrentContext();
      return 0;
    });
    const { runIdempotencyCleanup } = await import('../../src/workers/idempotency-cleanup.js');
    await runIdempotencyCleanup();

    expect(observed).not.toBeNull();
    expect(isSystemContext(observed!)).toBe(true);
    expect(observed!.tenant_id).not.toBe('default');
    expect(observed!.agent_id).not.toBe('default');
  });
});
