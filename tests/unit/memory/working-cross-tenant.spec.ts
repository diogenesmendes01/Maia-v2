/**
 * Issue #231 — Cross-tenant (cross-empresa) isolation invariant for the
 * WORKING memory layer (Redis short-lived buffers).
 *
 * Product invariant (project north star):
 *   "Maias de empresas diferentes NUNCA se comunicam, compartilham dados ou
 *    herdam aprendizado. Sem exceção."
 *
 * Working-memory-specific contract this spec PROVES:
 *   Every Redis key emitted by `src/memory/working.ts` (`pushMessage`,
 *   `readRecent`) is prefixed with `tenant_id` AND `agent_id` from the
 *   AsyncLocalStorage tenant context, AND throws `MissingTenantContextError`
 *   (loud failure) when invoked outside a `runWithTenantContext` boundary.
 *
 * Before this fix the key was `working:conv:${conversa_id}:messages` — no
 * tenant/agent namespace. The concrete leak depended on global uniqueness
 * of `conversa_id`, but the architectural invariant ("every state passes
 * through tenant_id + agent_id, no exception") was violated. Any future
 * ID-generation change (or fixed seeds across tenants in tests) would
 * silently reintroduce a cross-tenant leak. This spec locks in the
 * namespace at the storage layer.
 *
 * Note (#270/#274): a sibling `rateLimit` helper used to live in this
 * module and was removed as dead code on main. We deliberately do NOT
 * test it here — `tests/unit/memory/working-ratelimit-legacy.spec.ts`
 * is the regression test asserting the export is gone.
 *
 * Strategy:
 *   - In-memory Redis stub that captures EXACTLY the key strings passed by
 *     production code. We don't simulate Redis semantics in detail — we
 *     record every (op, key) tuple and assert against it.
 *   - `isRedisConnected()` mocked to `true` so the early-returns in
 *     pushMessage/readRecent don't short-circuit the key emission we care
 *     about. The disconnected-Redis branch is already covered by the
 *     function's no-op semantics; the relevant contract here is "what key
 *     gets used when we DO talk to Redis".
 *   - Every test runs inside `runWithTenantContext({tenant_id, agent_id}, …)`
 *     so the production code's `getCurrentTenant()` / `getCurrentAgent()`
 *     resolve to the routed values. The "missing context" test deliberately
 *     omits the wrapper to assert the loud-failure path.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  runWithTenantContext,
  MissingTenantContextError,
} from '@/db/tenant-context.js';

// ---------------------------------------------------------------------------
// Redis call recorder. Captures (op, key, args) so we can assert on the
// EXACT key strings emitted by production. Methods return values shaped
// well enough for production code to keep running (e.g. lrange → []),
// but no real semantics are implemented — the contract under test is
// "which key string did we use?", not "does the list trim correctly?".
// ---------------------------------------------------------------------------
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
  // #317: the TTL/collision marker is written via `set` and read via `get`.
  // Record them too so we can assert the marker key is ALSO tenant+agent
  // scoped (the inviolable-isolation invariant applies to it as well).
  set: vi.fn(async (key: string, ...args: unknown[]) => {
    calls.push({ op: 'set', key, args });
    return 'OK';
  }),
  get: vi.fn(async (key: string, ...args: unknown[]) => {
    calls.push({ op: 'get', key, args });
    return null;
  }),
};

vi.mock('@/lib/redis.js', () => ({
  redis: redisStub,
  isRedisConnected: () => true,
}));

// Pull production code AFTER mocks are installed so the redis import binds
// to our stub.
const { pushMessage, readRecent } = await import(
  '@/memory/working.js'
);

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const AGENT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = '22222222-2222-2222-2222-222222222222';
const AGENT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CONV_SHARED = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

function keysOf(op: string): string[] {
  return calls.filter((c) => c.op === op).map((c) => c.key);
}

describe('issue #231 — working memory Redis keys are tenant+agent scoped', () => {
  beforeEach(() => {
    calls.length = 0;
    redisStub.rpush.mockClear();
    redisStub.ltrim.mockClear();
    redisStub.expire.mockClear();
    redisStub.lrange.mockClear();
    redisStub.set.mockClear();
    redisStub.get.mockClear();
  });

  // -------------------------------------------------------------------------
  // pushMessage — message buffer key MUST include tenant_id + agent_id.
  // -------------------------------------------------------------------------
  describe('pushMessage', () => {
    it('emits a key prefixed with both tenant_id and agent_id', async () => {
      await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => {
          await pushMessage(CONV_SHARED, 'user', 'hello');
        },
      );

      // All three ops (rpush + ltrim + expire) target the SAME key — the
      // production function passes one `key` local through all three calls.
      const expected = `working:${TENANT_A}:${AGENT_A}:conv:${CONV_SHARED}:messages`;
      expect(keysOf('rpush')).toEqual([expected]);
      expect(keysOf('ltrim')).toEqual([expected]);
      expect(keysOf('expire')).toEqual([expected]);
    });

    it('the TTL/collision marker key is ALSO tenant+agent scoped (#317 B4)', async () => {
      await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => {
          await pushMessage(CONV_SHARED, 'user', 'hello');
        },
      );
      // The Redis-backed TTL marker (#317) must carry the SAME tenant+agent
      // prefix as the data key — it is per-conversation state and the inviolable
      // isolation invariant applies. A non-scoped marker would let a foreign
      // tenant's marker collide on a shared conversa_id.
      expect(keysOf('set')).toEqual([
        `nx_ttl:${TENANT_A}:${AGENT_A}:conv:${CONV_SHARED}:messages`,
      ]);
    });

    it('marker key differs across tenants for the same conversa_id (#317 B4)', async () => {
      await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => {
          await pushMessage(CONV_SHARED, 'user', 'a');
        },
      );
      await runWithTenantContext(
        { tenant_id: TENANT_B, agent_id: AGENT_B },
        async () => {
          await pushMessage(CONV_SHARED, 'user', 'b');
        },
      );
      const setKeys = keysOf('set');
      expect(setKeys).toEqual([
        `nx_ttl:${TENANT_A}:${AGENT_A}:conv:${CONV_SHARED}:messages`,
        `nx_ttl:${TENANT_B}:${AGENT_B}:conv:${CONV_SHARED}:messages`,
      ]);
    });

    it('same conversa_id under different tenants produces DIFFERENT keys', async () => {
      await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => {
          await pushMessage(CONV_SHARED, 'user', 'tenant A message');
        },
      );
      await runWithTenantContext(
        { tenant_id: TENANT_B, agent_id: AGENT_B },
        async () => {
          await pushMessage(CONV_SHARED, 'user', 'tenant B message');
        },
      );

      const rpushKeys = keysOf('rpush');
      expect(rpushKeys).toHaveLength(2);
      expect(rpushKeys[0]).toBe(
        `working:${TENANT_A}:${AGENT_A}:conv:${CONV_SHARED}:messages`,
      );
      expect(rpushKeys[1]).toBe(
        `working:${TENANT_B}:${AGENT_B}:conv:${CONV_SHARED}:messages`,
      );
      expect(rpushKeys[0]).not.toBe(rpushKeys[1]);
    });

    it('same conversa_id, same tenant, DIFFERENT agents → different keys', async () => {
      // Defense-in-depth: agents within the same tenant must also be
      // isolated. This catches a regression where someone strips agent_id
      // from the prefix thinking tenant_id is enough.
      await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => {
          await pushMessage(CONV_SHARED, 'user', 'agent A');
        },
      );
      await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_B },
        async () => {
          await pushMessage(CONV_SHARED, 'user', 'agent B (same tenant)');
        },
      );

      const rpushKeys = keysOf('rpush');
      expect(rpushKeys).toHaveLength(2);
      expect(rpushKeys[0]).toContain(`:${AGENT_A}:`);
      expect(rpushKeys[1]).toContain(`:${AGENT_B}:`);
      expect(rpushKeys[0]).not.toBe(rpushKeys[1]);
    });

    it('throws MissingTenantContextError when called without tenant context', async () => {
      // Loud failure — invariant block in working.ts: a missing-context
      // bug must crash, NOT fall back to an empty/default namespace.
      await expect(pushMessage(CONV_SHARED, 'user', 'no ctx')).rejects.toThrow(
        MissingTenantContextError,
      );

      // Nothing should have been written to Redis.
      expect(redisStub.rpush).not.toHaveBeenCalled();
      expect(redisStub.ltrim).not.toHaveBeenCalled();
      expect(redisStub.expire).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // readRecent — reads MUST also be scoped. Adversarial: a stale tenant-B
  // entry with the same conversa_id must NEVER be reachable from a tenant-A
  // read, even if the key happened to be written under the legacy unscoped
  // format. This is enforced by the prefix on the READ key (not by data
  // semantics), so we assert on the key string.
  // -------------------------------------------------------------------------
  describe('readRecent', () => {
    it('uses a tenant+agent-prefixed key', async () => {
      const keyUsed = await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => {
          await readRecent(CONV_SHARED);
          return calls.find((c) => c.op === 'lrange')?.key;
        },
      );
      expect(keyUsed).toBe(
        `working:${TENANT_A}:${AGENT_A}:conv:${CONV_SHARED}:messages`,
      );
    });

    it('ADVERSARIAL: stale tenant-B data under shared conversa_id is unreachable from tenant-A read', async () => {
      // Simulate a tenant-B write landing in Redis under its (correctly
      // scoped) key. We capture the exact key tenant-B wrote to.
      await runWithTenantContext(
        { tenant_id: TENANT_B, agent_id: AGENT_B },
        async () => {
          await pushMessage(CONV_SHARED, 'user', 'TENANT_B_SECRET_PAYLOAD');
        },
      );
      const tenantBWriteKey = calls.find((c) => c.op === 'rpush')?.key;

      // Clear the recorder and have tenant-A read using the SAME conversa_id.
      calls.length = 0;

      await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => {
          await readRecent(CONV_SHARED);
        },
      );

      const tenantAReadKey = calls.find((c) => c.op === 'lrange')?.key;

      // The KEY tenant-A reads from MUST differ from the key tenant-B
      // wrote to. This is the load-bearing assertion: even with a shared
      // conversa_id, the prefix isolation prevents cross-tenant reach.
      expect(tenantAReadKey).toBeDefined();
      expect(tenantBWriteKey).toBeDefined();
      expect(tenantAReadKey).not.toBe(tenantBWriteKey);
      expect(tenantAReadKey).toBe(
        `working:${TENANT_A}:${AGENT_A}:conv:${CONV_SHARED}:messages`,
      );
      expect(tenantBWriteKey).toBe(
        `working:${TENANT_B}:${AGENT_B}:conv:${CONV_SHARED}:messages`,
      );
    });

    it('SYMMETRY: B→A is also isolated', async () => {
      // Inverse of the previous test — proves the property is symmetric
      // and we didn't just hard-code tenant-A as a "primary" path.
      await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => {
          await pushMessage(CONV_SHARED, 'user', 'TENANT_A_SECRET_PAYLOAD');
        },
      );
      const tenantAWriteKey = calls.find((c) => c.op === 'rpush')?.key;

      calls.length = 0;

      await runWithTenantContext(
        { tenant_id: TENANT_B, agent_id: AGENT_B },
        async () => {
          await readRecent(CONV_SHARED);
        },
      );

      const tenantBReadKey = calls.find((c) => c.op === 'lrange')?.key;
      expect(tenantBReadKey).not.toBe(tenantAWriteKey);
      expect(tenantBReadKey).toBe(
        `working:${TENANT_B}:${AGENT_B}:conv:${CONV_SHARED}:messages`,
      );
    });

    it('throws MissingTenantContextError when called without tenant context', async () => {
      await expect(readRecent(CONV_SHARED)).rejects.toThrow(
        MissingTenantContextError,
      );
      expect(redisStub.lrange).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // rateLimit was removed from this module as dead code on main (#270/#274).
  // The regression test in `working-ratelimit-legacy.spec.ts` asserts the
  // export is gone; nothing to test here for the working-memory rate limiter.
  // -------------------------------------------------------------------------
});
