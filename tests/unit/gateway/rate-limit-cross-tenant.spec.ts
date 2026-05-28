/**
 * Issue #245 — Cross-tenant (cross-empresa) isolation invariant for the
 * GATEWAY rate-limit layer (Redis sliding-hour quota + warned/silence flags).
 *
 * Product invariant (project north star):
 *   "Maias de empresas diferentes NUNCA se comunicam, compartilham dados ou
 *    herdam aprendizado. Sem exceção."
 *
 * Gateway-specific contract this spec PROVES:
 *   Every Redis key emitted by `src/gateway/rate-limit.ts` (`checkRateLimit`)
 *   is prefixed with `tenant_id` AND `agent_id` from the AsyncLocalStorage
 *   tenant context, AND throws `MissingTenantContextError` (loud failure)
 *   when invoked outside a `runWithTenantContext` boundary.
 *
 * Concrete cross-tenant DoS this fix closes (MAJOR):
 *   Before the fix the keys were `maia:ratelimit:hour:${pessoa_id}`,
 *   `maia:ratelimit:warned:${pessoa_id}`, `maia:ratelimit:silence:${pessoa_id}` —
 *   keyed ONLY on `pessoa_id`. A pessoa_id observed under two different
 *   tenants (B2B contact, fixed test seeds, future ID-generation change)
 *   shared a single sliding-hour counter and silence flag — i.e.
 *   tenant-B saturating its quota would force tenant-A's user into
 *   `silence` despite tenant-A having sent nothing. That is exactly
 *   the cross-tenant DoS the founding principle forbids.
 *
 * Strategy:
 *   - In-memory Redis stub with real-enough semantics for the sliding-hour
 *     sorted set (ZADD/ZCARD/ZREMRANGEBYSCORE/EXPIRE) and string ops
 *     (GET/SET-EX). The contract under test is "different tenants get
 *     different keys", so we also capture (op, key) tuples for direct
 *     key-string assertions.
 *   - `isRedisConnected()` mocked to `true` so the early-return path
 *     doesn't short-circuit the key emission we care about. The
 *     disconnected-Redis branch is covered by the existing
 *     `tests/unit/rate-limit.spec.ts`.
 *   - Every assertion runs inside `runWithTenantContext({tenant_id,
 *     agent_id}, …)` so the production code's `getCurrentTenant()` /
 *     `getCurrentAgent()` resolve to the routed values. The
 *     "missing context" test deliberately omits the wrapper to assert
 *     the loud-failure path.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  runWithTenantContext,
  MissingTenantContextError,
} from '@/db/tenant-context.js';
import type { Pessoa } from '@/db/schema.js';

// ---------------------------------------------------------------------------
// Redis stub. Mixes a key-string recorder (for prefix assertions) with
// just-enough sorted-set / kv semantics for the production code's flow
// to complete (so we can also assert decision-level outcomes like
// "tenant-B's saturation does not affect tenant-A's allow path").
// ---------------------------------------------------------------------------
type Call = { op: string; key: string; args: unknown[] };
type ZEntry = { score: number; member: string };
type KvEntry = { value: string; expiresAt?: number };

const calls: Call[] = [];
const kv = new Map<string, KvEntry>();
const zsets = new Map<string, ZEntry[]>();
const zttl = new Map<string, number>();

function evictIfExpired(k: string): void {
  const entry = kv.get(k);
  if (entry?.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
    kv.delete(k);
  }
  const t = zttl.get(k);
  if (t !== undefined && t <= Date.now()) {
    zsets.delete(k);
    zttl.delete(k);
  }
}

const redisStub = {
  get: vi.fn(async (key: string) => {
    calls.push({ op: 'get', key, args: [] });
    evictIfExpired(key);
    return kv.get(key)?.value ?? null;
  }),
  set: vi.fn(
    async (key: string, value: string, ex?: 'EX', s?: number) => {
      calls.push({ op: 'set', key, args: [value, ex, s] });
      const expiresAt =
        ex === 'EX' && typeof s === 'number' ? Date.now() + s * 1000 : undefined;
      kv.set(key, { value, expiresAt });
      return 'OK' as const;
    },
  ),
  expire: vi.fn(async (key: string, s: number) => {
    calls.push({ op: 'expire', key, args: [s] });
    const e = kv.get(key);
    if (e) e.expiresAt = Date.now() + s * 1000;
    if (zsets.has(key)) zttl.set(key, Date.now() + s * 1000);
    return e || zsets.has(key) ? 1 : 0;
  }),
  zadd: vi.fn(async (key: string, score: number, member: string) => {
    calls.push({ op: 'zadd', key, args: [score, member] });
    evictIfExpired(key);
    const arr = zsets.get(key) ?? [];
    arr.push({ score, member });
    zsets.set(key, arr);
    return 1;
  }),
  zcard: vi.fn(async (key: string) => {
    calls.push({ op: 'zcard', key, args: [] });
    evictIfExpired(key);
    return zsets.get(key)?.length ?? 0;
  }),
  zremrangebyscore: vi.fn(async (key: string, min: number, max: number) => {
    calls.push({ op: 'zremrangebyscore', key, args: [min, max] });
    evictIfExpired(key);
    const arr = zsets.get(key);
    if (!arr) return 0;
    const before = arr.length;
    const kept = arr.filter((e) => e.score < min || e.score > max);
    zsets.set(key, kept);
    return before - kept.length;
  }),
};

vi.mock('@/lib/redis.js', () => ({
  redis: redisStub,
  isRedisConnected: () => true,
}));

vi.mock('@/config/env.js', () => ({
  config: { RATE_LIMIT_MSGS_PER_HOUR: 3 },
}));

vi.mock('@/lib/logger.js', () => ({
  logger: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  },
}));

// Pull production code AFTER mocks are installed so the redis import binds
// to our stub.
const { checkRateLimit } = await import('@/gateway/rate-limit.js');

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const AGENT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = '22222222-2222-2222-2222-222222222222';
const AGENT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const PESSOA_SHARED = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

function pessoaFixture(id: string, tipo: 'funcionario' | 'dono' = 'funcionario'): Pessoa {
  return {
    id,
    nome: tipo,
    apelido: null,
    telefone_whatsapp: '+55',
    tipo,
    email: null,
    observacoes: null,
    preferencias: {},
    modelo_mental: {},
    status: 'ativa',
    created_at: new Date(),
    updated_at: new Date(),
  };
}

function keysOf(op: string): string[] {
  return calls.filter((c) => c.op === op).map((c) => c.key);
}

function resetStub(): void {
  calls.length = 0;
  kv.clear();
  zsets.clear();
  zttl.clear();
  redisStub.get.mockClear();
  redisStub.set.mockClear();
  redisStub.expire.mockClear();
  redisStub.zadd.mockClear();
  redisStub.zcard.mockClear();
  redisStub.zremrangebyscore.mockClear();
}

describe('issue #245 — gateway rate-limit Redis keys are tenant+agent scoped', () => {
  beforeEach(() => {
    resetStub();
  });

  // -------------------------------------------------------------------------
  // Key-shape contract — every key flavor (count / warned / silence) must
  // be prefixed with `maia:ratelimit:${tenant_id}:${agent_id}:…`.
  // -------------------------------------------------------------------------
  describe('key shape', () => {
    it('count key (sorted-set) is prefixed with tenant_id and agent_id', async () => {
      const pessoa = pessoaFixture(PESSOA_SHARED);
      await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => {
          await checkRateLimit(pessoa);
        },
      );

      // The 3 sorted-set ops (zremrangebyscore, zadd, expire, zcard) all
      // target the SAME count key — production passes one `countKey` local
      // through every call.
      const expected = `maia:ratelimit:${TENANT_A}:${AGENT_A}:hour:${PESSOA_SHARED}`;
      expect(keysOf('zremrangebyscore')).toEqual([expected]);
      expect(keysOf('zadd')).toEqual([expected]);
      expect(keysOf('zcard')).toEqual([expected]);
      // `expire` is also called on the count key (1h TTL).
      expect(keysOf('expire')).toContain(expected);
    });

    it('warned + silence keys (string-kv) are prefixed with tenant_id and agent_id (overage path)', async () => {
      const pessoa = pessoaFixture(PESSOA_SHARED);
      // RATE_LIMIT_MSGS_PER_HOUR=3 (mocked above). 4th call triggers `warn`,
      // which is the path that writes BOTH the warned and silence flags.
      await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => {
          await checkRateLimit(pessoa);
          await checkRateLimit(pessoa);
          await checkRateLimit(pessoa);
          const overage = await checkRateLimit(pessoa);
          expect(overage.kind).toBe('warn');
        },
      );

      const expectedWarned = `maia:ratelimit:${TENANT_A}:${AGENT_A}:warned:${PESSOA_SHARED}`;
      const expectedSilence = `maia:ratelimit:${TENANT_A}:${AGENT_A}:silence:${PESSOA_SHARED}`;
      // Both flags are SET (with EX TTLs) on the warn transition.
      const setKeys = keysOf('set');
      expect(setKeys).toContain(expectedWarned);
      expect(setKeys).toContain(expectedSilence);
      // GET is also probed for both keys on the overage decision path.
      const getKeys = keysOf('get');
      expect(getKeys).toContain(expectedWarned);
      expect(getKeys).toContain(expectedSilence);
    });
  });

  // -------------------------------------------------------------------------
  // Same pessoa under different tenants → different keys → independent
  // quotas. This is the core cross-tenant DoS regression test.
  // -------------------------------------------------------------------------
  describe('cross-tenant independence', () => {
    it('same pessoa_id under tenant-A vs tenant-B produces DIFFERENT count keys', async () => {
      const pessoa = pessoaFixture(PESSOA_SHARED);

      await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => {
          await checkRateLimit(pessoa);
        },
      );
      const tenantACountKey = calls.find((c) => c.op === 'zadd')?.key;

      resetStub();

      await runWithTenantContext(
        { tenant_id: TENANT_B, agent_id: AGENT_B },
        async () => {
          await checkRateLimit(pessoa);
        },
      );
      const tenantBCountKey = calls.find((c) => c.op === 'zadd')?.key;

      expect(tenantACountKey).toBeDefined();
      expect(tenantBCountKey).toBeDefined();
      expect(tenantACountKey).not.toBe(tenantBCountKey);
      expect(tenantACountKey).toBe(
        `maia:ratelimit:${TENANT_A}:${AGENT_A}:hour:${PESSOA_SHARED}`,
      );
      expect(tenantBCountKey).toBe(
        `maia:ratelimit:${TENANT_B}:${AGENT_B}:hour:${PESSOA_SHARED}`,
      );
    });

    it('SYMMETRY: B→A is also isolated (different count keys)', async () => {
      // Inverse of the previous test — proves the property is symmetric
      // and we didn't just hard-code tenant-A as a "primary" path.
      const pessoa = pessoaFixture(PESSOA_SHARED);

      await runWithTenantContext(
        { tenant_id: TENANT_B, agent_id: AGENT_B },
        async () => {
          await checkRateLimit(pessoa);
        },
      );
      const tenantBCountKey = calls.find((c) => c.op === 'zadd')?.key;

      resetStub();

      await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => {
          await checkRateLimit(pessoa);
        },
      );
      const tenantACountKey = calls.find((c) => c.op === 'zadd')?.key;

      expect(tenantACountKey).not.toBe(tenantBCountKey);
      expect(tenantACountKey).toBe(
        `maia:ratelimit:${TENANT_A}:${AGENT_A}:hour:${PESSOA_SHARED}`,
      );
      expect(tenantBCountKey).toBe(
        `maia:ratelimit:${TENANT_B}:${AGENT_B}:hour:${PESSOA_SHARED}`,
      );
    });

    it('same pessoa_id, same tenant, DIFFERENT agents → different count keys', async () => {
      // Defense-in-depth: agents within the same tenant must also be
      // isolated. Catches a regression where someone strips `agent_id`
      // from the prefix thinking `tenant_id` alone is enough.
      const pessoa = pessoaFixture(PESSOA_SHARED);

      await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => {
          await checkRateLimit(pessoa);
        },
      );
      const keyAgentA = calls.find((c) => c.op === 'zadd')?.key;

      resetStub();

      await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_B },
        async () => {
          await checkRateLimit(pessoa);
        },
      );
      const keyAgentB = calls.find((c) => c.op === 'zadd')?.key;

      expect(keyAgentA).toBeDefined();
      expect(keyAgentB).toBeDefined();
      expect(keyAgentA).not.toBe(keyAgentB);
      expect(keyAgentA).toContain(`:${AGENT_A}:`);
      expect(keyAgentB).toContain(`:${AGENT_B}:`);
    });

    // -----------------------------------------------------------------------
    // ADVERSARIAL: the actual cross-tenant DoS scenario from the issue body.
    // Tenant-B saturates its quota for `PESSOA_SHARED` and gets silenced.
    // Tenant-A's identical-pessoa_id user must still receive `allow` for
    // its first call — i.e. tenant-B's silence flag MUST NOT carry over
    // to tenant-A's read path.
    // -----------------------------------------------------------------------
    it('ADVERSARIAL: tenant-B saturating its quota does NOT affect tenant-A (independent decisions)', async () => {
      const pessoa = pessoaFixture(PESSOA_SHARED);

      // 1. Tenant-B blasts past threshold (3) — first 3 allowed, 4th warn,
      //    5th silence. After this, tenant-B's warned + silence flags are
      //    set in Redis.
      await runWithTenantContext(
        { tenant_id: TENANT_B, agent_id: AGENT_B },
        async () => {
          expect((await checkRateLimit(pessoa)).kind).toBe('allow');
          expect((await checkRateLimit(pessoa)).kind).toBe('allow');
          expect((await checkRateLimit(pessoa)).kind).toBe('allow');
          expect((await checkRateLimit(pessoa)).kind).toBe('warn');
          expect((await checkRateLimit(pessoa)).kind).toBe('silence');
        },
      );

      // Sanity: tenant-B's silence flag IS in Redis under tenant-B's key.
      expect(
        kv.has(`maia:ratelimit:${TENANT_B}:${AGENT_B}:silence:${PESSOA_SHARED}`),
      ).toBe(true);
      expect(
        kv.has(`maia:ratelimit:${TENANT_B}:${AGENT_B}:warned:${PESSOA_SHARED}`),
      ).toBe(true);

      // 2. Tenant-A's first call for the SAME pessoa_id. Under the
      //    pre-fix code (`maia:ratelimit:silence:${pessoa_id}` with no
      //    tenant prefix), tenant-A would inherit tenant-B's silence flag
      //    and immediately return `silence` despite having sent nothing.
      //    Post-fix: tenant-A gets `allow` because its silence key is
      //    a SEPARATE key that has never been set.
      await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => {
          const decision = await checkRateLimit(pessoa);
          expect(decision.kind).toBe('allow');
        },
      );

      // And tenant-A's count key is empty before this call had run, so the
      // sorted-set under tenant-A's key holds exactly one entry now.
      const tenantACountKey = `maia:ratelimit:${TENANT_A}:${AGENT_A}:hour:${PESSOA_SHARED}`;
      expect(zsets.get(tenantACountKey)?.length).toBe(1);
    });

    it('ADVERSARIAL: tenant-B going silent does NOT silence tenant-A on the THIRD call either (quotas fully independent)', async () => {
      // Stronger variant — proves the independence holds for the FULL
      // sliding window, not just the first call. Tenant-A runs all the
      // way to its OWN warn boundary independently of tenant-B's state.
      const pessoa = pessoaFixture(PESSOA_SHARED);

      await runWithTenantContext(
        { tenant_id: TENANT_B, agent_id: AGENT_B },
        async () => {
          for (let i = 0; i < 5; i++) await checkRateLimit(pessoa);
        },
      );

      await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => {
          expect((await checkRateLimit(pessoa)).kind).toBe('allow'); // 1
          expect((await checkRateLimit(pessoa)).kind).toBe('allow'); // 2
          expect((await checkRateLimit(pessoa)).kind).toBe('allow'); // 3
          expect((await checkRateLimit(pessoa)).kind).toBe('warn');   // 4
          expect((await checkRateLimit(pessoa)).kind).toBe('silence');// 5
        },
      );
    });
  });

  // -------------------------------------------------------------------------
  // Missing tenant context — loud failure (MissingTenantContextError),
  // NO Redis writes. The invariant block in `src/gateway/rate-limit.ts`
  // forbids any silent fallback to a default/empty namespace.
  // -------------------------------------------------------------------------
  describe('missing tenant context', () => {
    it('throws MissingTenantContextError when called without runWithTenantContext', async () => {
      const pessoa = pessoaFixture(PESSOA_SHARED);
      await expect(checkRateLimit(pessoa)).rejects.toThrow(MissingTenantContextError);

      // CRITICAL: no Redis op was issued. A missing-context bug must
      // NEVER have a chance to land state under any key (default or
      // otherwise).
      expect(redisStub.zadd).not.toHaveBeenCalled();
      expect(redisStub.zcard).not.toHaveBeenCalled();
      expect(redisStub.zremrangebyscore).not.toHaveBeenCalled();
      expect(redisStub.get).not.toHaveBeenCalled();
      expect(redisStub.set).not.toHaveBeenCalled();
      expect(redisStub.expire).not.toHaveBeenCalled();
    });

    it('error code is the stable MISSING_TENANT_CONTEXT (programmatic match, no string parsing)', async () => {
      const pessoa = pessoaFixture(PESSOA_SHARED);
      try {
        await checkRateLimit(pessoa);
        expect.fail('checkRateLimit should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(MissingTenantContextError);
        expect((err as MissingTenantContextError).code).toBe('MISSING_TENANT_CONTEXT');
      }
    });
  });
});
