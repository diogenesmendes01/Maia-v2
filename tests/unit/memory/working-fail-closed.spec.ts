/**
 * Issue #231 / Codex PR #241 review — MAJOR #1 regression test.
 *
 * Fail-closed guard order: `pushMessage` / `readRecent` MUST crash with
 * `MissingTenantContextError` when called outside a tenant context, EVEN
 * WHEN REDIS IS DOWN. Before the fix, the `!isRedisConnected()` early-return
 * ran before the `getCurrentTenant()` / `getCurrentAgent()` accessors, so a
 * Redis outage silently masked a missing-context bug and let a caller bypass
 * the tenant invariant.
 *
 * Note (#270/#274): a sibling `rateLimit` helper used to live in this
 * module and was removed as dead code on main. We deliberately do NOT
 * test it here.
 *
 * Strategy mirrors `working-cross-tenant.spec.ts`: in-memory Redis stub that
 * records (op, key) calls. The distinguishing knob is `isRedisConnected()`
 * which we mock to return `false` for this whole file — this is the path
 * the old code took straight to `return` without ever validating context.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  runWithTenantContext,
  MissingTenantContextError,
} from '@/db/tenant-context.js';

type Call = { op: string; key: string; args: unknown[] };
const calls: Call[] = [];

const redisStub = {
  rpush: vi.fn(async (key: string, ...args: unknown[]) => {
    calls.push({ op: 'rpush', key, args });
    return 1;
  }),
  ltrim: vi.fn(async (key: string, ...args: unknown[]) => {
    calls.push({ op: 'ltrim', key, args });
    return 'OK';
  }),
  expire: vi.fn(async (key: string, ...args: unknown[]) => {
    calls.push({ op: 'expire', key, args });
    return 1;
  }),
  lrange: vi.fn(async (key: string, ...args: unknown[]) => {
    calls.push({ op: 'lrange', key, args });
    return [];
  }),
  incr: vi.fn(async (key: string, ...args: unknown[]) => {
    calls.push({ op: 'incr', key, args });
    return 1;
  }),
  get: vi.fn(async (key: string) => {
    calls.push({ op: 'get', key, args: [] });
    return null;
  }),
  // #317: marker write/clear. Redis is DOWN for this whole file, so these are
  // never reached (the isRedisConnected()===false guard short-circuits first);
  // present only so the stub shape matches production if that guard ever moves.
  set: vi.fn(async (key: string, ...args: unknown[]) => {
    calls.push({ op: 'set', key, args });
    return 'OK';
  }),
  del: vi.fn(async (key: string) => {
    calls.push({ op: 'del', key, args: [] });
    return 1;
  }),
};

// Redis is DOWN for this whole file — this is the regression path.
vi.mock('@/lib/redis.js', () => ({
  redis: redisStub,
  isRedisConnected: () => false,
}));

const { pushMessage, readRecent } = await import(
  '@/memory/working.js'
);

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const AGENT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CONV = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

describe('issue #231 / #241 MAJOR #1 — fail-closed when Redis is down', () => {
  beforeEach(() => {
    calls.length = 0;
    Object.values(redisStub).forEach((fn) => fn.mockClear());
  });

  describe('pushMessage', () => {
    it('throws MissingTenantContextError even when Redis is unavailable', async () => {
      // Regression: previously `pushMessage` returned early on
      // `!isRedisConnected()` before ever calling `getCurrentTenant()`,
      // so a missing-context caller silently no-op'd during a Redis outage.
      await expect(pushMessage(CONV, 'user', 'no ctx')).rejects.toThrow(
        MissingTenantContextError,
      );
      // No Redis ops should have been attempted either way.
      expect(redisStub.rpush).not.toHaveBeenCalled();
      expect(redisStub.ltrim).not.toHaveBeenCalled();
      expect(redisStub.expire).not.toHaveBeenCalled();
    });

    it('returns silently when context IS present (Redis-down no-op preserved)', async () => {
      // The Redis-down branch is a legitimate degraded-mode early return
      // when context IS valid — we just shouldn't write anything.
      await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => {
          await expect(
            pushMessage(CONV, 'user', 'with ctx'),
          ).resolves.toBeUndefined();
        },
      );
      expect(redisStub.rpush).not.toHaveBeenCalled();
    });
  });

  describe('readRecent', () => {
    it('throws MissingTenantContextError even when Redis is unavailable', async () => {
      await expect(readRecent(CONV)).rejects.toThrow(MissingTenantContextError);
      expect(redisStub.lrange).not.toHaveBeenCalled();
    });

    it('returns empty array when context IS present (Redis-down no-op preserved)', async () => {
      const result = await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => readRecent(CONV),
      );
      expect(result).toEqual([]);
      expect(redisStub.lrange).not.toHaveBeenCalled();
    });
  });

  // rateLimit was removed in #270/#274 (dead code, no callers). See
  // `working-ratelimit-legacy.spec.ts` for the regression test asserting
  // the export is gone.
});
