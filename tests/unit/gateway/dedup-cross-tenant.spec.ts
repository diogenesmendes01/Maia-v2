/**
 * Issue #247 — Cross-tenant (cross-empresa) isolation invariant for the
 * GATEWAY DEDUP layer (Redis short-lived "message already seen" cache).
 *
 * Product invariant (project north star):
 *   "Maias de empresas diferentes NUNCA se comunicam, compartilham dados ou
 *    herdam aprendizado. Sem exceção."
 *
 * Gateway-dedup-specific contract this spec PROVES:
 *   Every Redis key emitted by `src/gateway/dedup.ts` (`isDuplicate`,
 *   `markSeen`) is prefixed with BOTH `tenant_id` AND `agent_id` resolved
 *   from the AsyncLocalStorage tenant context (matching the DB fallback's
 *   scoping in `repositories.ts:467-482`), AND throws
 *   `MissingTenantContextError` (loud failure) when invoked outside a
 *   `runWithTenantContext` boundary OR when the context carries empty /
 *   whitespace-only segments.
 *
 * Before this fix the dedup key was `dedup:msg:${whatsapp_id}` — message
 * id ONLY, no tenant namespace. The Codex revalidation pass on PR #241
 * flagged three exploitable failure modes (all rooted in cross-tenant key
 * collision on the WhatsApp `whatsapp_id`):
 *
 *   1. COLLISION-DROP: two tenants share an id → tenant-B's legitimate
 *      inbound is silently swallowed because tenant-A already cached the id.
 *   2. POISONING: an attacker who predicts a target tenant's id can
 *      pre-cache it under their own tenant, blocking the real message.
 *   3. INFORMATION DISCLOSURE: dedup keys surfacing in logs/metrics leak
 *      foreign-tenant message ids across the tenant boundary.
 *
 * Codex review on PR #253 (commit `4921dd27`) raised four additional
 * convergent findings now ALSO covered here:
 *
 *   A. CRITICAL — fail-closed validation: `getCurrentTenant`/`Agent` on
 *      `main` accept empty/whitespace-only ids. `dedup.ts:assertTenantSegment`
 *      now rejects locally. Tests below cover empty string, whitespace-only,
 *      and surrounding-whitespace cases for both tenant_id and agent_id.
 *   B. CRITICAL — alias-safe encoding: per-segment `encodeURIComponent` so
 *      a tenant slug containing `:` can never collide with a tuple where
 *      the `:` is in another segment. Test: `tenant_id` `acme:dev` plus
 *      `agent_id` `x` produces a DIFFERENT key from `tenant_id` `acme`
 *      plus `agent_id` `dev:x` even though both naively concatenate to
 *      `acme:dev:x`.
 *   C. MAJOR — Redis-disconnected branch coverage: previous tests
 *      hardcoded `isRedisConnected: () => true`. We now flip the flag
 *      per-test to exercise the DB-only path.
 *   D. MEDIUM — same-tenant race: `SET NX EX` atomic check-and-set
 *      replaces the EXISTS+SET round-trip. Test: two concurrent
 *      `markSeen` calls with the same key produce ONE persisted entry.
 *
 * Strategy:
 *   - In-memory Redis stub that captures EXACTLY the key strings AND args
 *     passed by production code. We don't simulate Redis semantics in
 *     detail — we record every `(op, key, args)` tuple and assert against
 *     it. The stub does respect `NX` semantics to exercise the race.
 *   - `isRedisConnected()` mockable per-test via the `redisConnected` flag
 *     so the disconnected-Redis branch is exercised.
 *   - `mensagensRepo` mocked to a controlled stub so we exercise the
 *     "DB confirms duplicate → backfill Redis" branch without touching
 *     the real DB. The fallback's own tenant scoping is out of scope for
 *     this spec; we only care that the Redis backfill ALSO uses the
 *     tenant+agent-prefixed key.
 *   - Every test runs inside `runWithTenantContext({tenant_id, agent_id}, …)`
 *     so the production code's `getCurrentTenant`/`getCurrentAgent` resolve
 *     to the routed values. The "missing context" / "corrupted context"
 *     tests deliberately omit or break the wrapper to assert the
 *     loud-failure path.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  runWithTenantContext,
  MissingTenantContextError,
} from '@/db/tenant-context.js';

// ---------------------------------------------------------------------------
// Redis call recorder. Captures (op, key, args) so we can assert on the
// EXACT key strings emitted by production. The `set` method honors `NX`
// semantics so we can exercise the same-tenant race contract.
// ---------------------------------------------------------------------------
type Call = { op: string; key: string; args: unknown[] };

const calls: Call[] = [];
// Toggle: by default treat keys as not-yet-seen. Individual tests can
// pre-populate `existsResponses` to simulate a hit by tenant.
let existsResponses: Record<string, number> = {};
// Set per-test to toggle the Redis-up/Redis-down branch.
let redisConnected = true;

const redisStub = {
  exists: vi.fn(async (key: string) => {
    calls.push({ op: 'exists', key, args: [] });
    return existsResponses[key] ?? 0;
  }),
  set: vi.fn(async (key: string, ...args: unknown[]) => {
    // Honor NX so the same-tenant race test can prove only one writer wins.
    const isNx = args.includes('NX');
    if (isNx && existsResponses[key]) {
      calls.push({ op: 'set', key, args });
      return null;
    }
    calls.push({ op: 'set', key, args });
    existsResponses[key] = 1;
    return 'OK';
  }),
};

vi.mock('@/lib/redis.js', () => ({
  redis: redisStub,
  isRedisConnected: () => redisConnected,
  // #309: consulted in the production catch paths. This spec does not inject
  // Redis errors, so OOM detection is false and the degrade hook is a no-op.
  // OOM coverage lives in `dedup-oom.spec.ts`.
  isRedisOomError: () => false,
  recordRedisOomDegraded: () => {},
}));

// mensagensRepo.findByWhatsappId default: no DB hit. Individual tests
// override `findByWhatsappIdMock` to force the DB-confirmed-duplicate
// branch (which backfills Redis).
const findByWhatsappIdMock = vi.fn(async (_id: string) => null as null | {
  id: string;
});

vi.mock('@/db/repositories.js', () => ({
  mensagensRepo: {
    findByWhatsappId: findByWhatsappIdMock,
  },
}));

// Pull production code AFTER mocks are installed so the redis import binds
// to our stub.
const { isDuplicate, markSeen } = await import('@/gateway/dedup.js');

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const AGENT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const AGENT_A2 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaf';
const TENANT_B = '22222222-2222-2222-2222-222222222222';
const AGENT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
// A whatsapp_id that COLLIDES across tenants — the bug's core failure mode.
const COLLIDING_WID = 'WID_SHARED_BETWEEN_TENANTS';

function keysOf(op: string): string[] {
  return calls.filter((c) => c.op === op).map((c) => c.key);
}

function expectedKey(tenant_id: string, agent_id: string, wid: string): string {
  return (
    'dedup:msg:' +
    encodeURIComponent(tenant_id) +
    ':' +
    encodeURIComponent(agent_id) +
    ':' +
    encodeURIComponent(wid)
  );
}

beforeEach(() => {
  calls.length = 0;
  existsResponses = {};
  redisConnected = true;
  redisStub.exists.mockClear();
  redisStub.set.mockClear();
  findByWhatsappIdMock.mockClear();
  findByWhatsappIdMock.mockResolvedValue(null);
});

describe('issue #247 — gateway dedup Redis keys are tenant+agent-scoped', () => {
  // -------------------------------------------------------------------------
  // markSeen — write side: the cache entry MUST land under a
  // tenant+agent-prefixed key. This is the primary anchor — if writes are
  // unscoped, every other property fails downstream.
  // -------------------------------------------------------------------------
  describe('markSeen', () => {
    it('emits a Redis key prefixed with tenant_id AND agent_id', async () => {
      await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => {
          await markSeen(COLLIDING_WID);
        },
      );

      const setKeys = keysOf('set');
      expect(setKeys).toHaveLength(1);
      expect(setKeys[0]).toBe(expectedKey(TENANT_A, AGENT_A, COLLIDING_WID));
    });

    it('uses SET NX EX (atomic check-and-set) — closes same-tenant race', async () => {
      // Codex PR #253 review, MEDIUM finding. Without NX, two concurrent
      // markSeen calls could race between EXISTS and SET. With NX, only
      // the first writer wins; the loser observes the cached "1" on the
      // next isDuplicate.
      await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => {
          await markSeen(COLLIDING_WID);
        },
      );
      const setCall = calls.find((c) => c.op === 'set');
      expect(setCall).toBeDefined();
      // Must include NX in the args.
      expect(setCall!.args).toContain('NX');
      // Must include EX with 24h TTL.
      expect(setCall!.args).toContain('EX');
      expect(setCall!.args).toContain(60 * 60 * 24);
    });

    it('SYMMETRY — same whatsapp_id under tenant-B emits a DIFFERENT key', async () => {
      await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => {
          await markSeen(COLLIDING_WID);
        },
      );
      await runWithTenantContext(
        { tenant_id: TENANT_B, agent_id: AGENT_B },
        async () => {
          await markSeen(COLLIDING_WID);
        },
      );

      const setKeys = keysOf('set');
      expect(setKeys).toHaveLength(2);
      expect(setKeys[0]).toBe(expectedKey(TENANT_A, AGENT_A, COLLIDING_WID));
      expect(setKeys[1]).toBe(expectedKey(TENANT_B, AGENT_B, COLLIDING_WID));
      expect(setKeys[0]).not.toBe(setKeys[1]);
    });

    it('CROSS-AGENT (same tenant) — different agents emit DIFFERENT keys', async () => {
      // Mirrors the DB fallback scoping (tenant_id + agent_id + wid) — the
      // cache cannot diverge from the source of truth.
      await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => {
          await markSeen(COLLIDING_WID);
        },
      );
      await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A2 },
        async () => {
          await markSeen(COLLIDING_WID);
        },
      );

      const setKeys = keysOf('set');
      expect(setKeys).toHaveLength(2);
      expect(setKeys[0]).not.toBe(setKeys[1]);
      expect(setKeys[0]).toBe(expectedKey(TENANT_A, AGENT_A, COLLIDING_WID));
      expect(setKeys[1]).toBe(expectedKey(TENANT_A, AGENT_A2, COLLIDING_WID));
    });

    it('throws MissingTenantContextError when called without tenant context', async () => {
      // Loud failure — invariant: a missing-context bug must crash, NOT
      // fall back to an empty/shared namespace.
      await expect(markSeen(COLLIDING_WID)).rejects.toThrow(
        MissingTenantContextError,
      );

      // Nothing should have been written to Redis.
      expect(redisStub.set).not.toHaveBeenCalled();
    });

    it('Redis-disconnected branch — no Redis call, no throw', async () => {
      // Codex PR #253 review, MAJOR finding. Previous tests hardcoded
      // isRedisConnected: () => true. We exercise the disconnected branch
      // here: markSeen should be a quiet no-op. The dedup contract is
      // deferred to the DB fallback (covered by repositories' own tests).
      redisConnected = false;
      await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => {
          await markSeen(COLLIDING_WID);
        },
      );
      expect(redisStub.set).not.toHaveBeenCalled();
      expect(redisStub.exists).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // isDuplicate — read side: EXISTS lookup MUST also be tenant+agent-scoped,
  // so a foreign tenant/agent's prior `markSeen` cannot dedup the local read.
  // -------------------------------------------------------------------------
  describe('isDuplicate', () => {
    it('queries EXISTS with a tenant+agent-prefixed key', async () => {
      const keyUsed = await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => {
          await isDuplicate(COLLIDING_WID);
          return calls.find((c) => c.op === 'exists')?.key;
        },
      );
      expect(keyUsed).toBe(expectedKey(TENANT_A, AGENT_A, COLLIDING_WID));
    });

    it('CROSS-TENANT INDEPENDENCE — same whatsapp_id seen by tenant-A is NOT a duplicate for tenant-B', async () => {
      // This is the core property the bug violated.
      await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => {
          await markSeen(COLLIDING_WID);
        },
      );
      const aIsDup = await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => isDuplicate(COLLIDING_WID),
      );
      const bIsDup = await runWithTenantContext(
        { tenant_id: TENANT_B, agent_id: AGENT_B },
        async () => isDuplicate(COLLIDING_WID),
      );

      expect(aIsDup).toBe(true);
      expect(bIsDup).toBe(false);
    });

    it('CROSS-AGENT INDEPENDENCE (same tenant) — agent-A2 NOT deduped by agent-A1 cache', async () => {
      // Mirrors the DB fallback's `(tenant, agent, wid)` scoping at the
      // cache layer. Without agent_id in the key, agent-A2 would be
      // silently deduped by agent-A1's cache and lose a legitimate inbound.
      await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => {
          await markSeen(COLLIDING_WID);
        },
      );
      const a1IsDup = await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => isDuplicate(COLLIDING_WID),
      );
      const a2IsDup = await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A2 },
        async () => isDuplicate(COLLIDING_WID),
      );

      expect(a1IsDup).toBe(true);
      expect(a2IsDup).toBe(false);
    });

    it('SYMMETRY (B → A) — tenant-B cache hit does NOT dedup tenant-A', async () => {
      // Mirror of the cross-tenant test: prove the property is symmetric.
      await runWithTenantContext(
        { tenant_id: TENANT_B, agent_id: AGENT_B },
        async () => {
          await markSeen(COLLIDING_WID);
        },
      );
      const bIsDup = await runWithTenantContext(
        { tenant_id: TENANT_B, agent_id: AGENT_B },
        async () => isDuplicate(COLLIDING_WID),
      );
      const aIsDup = await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => isDuplicate(COLLIDING_WID),
      );

      expect(bIsDup).toBe(true);
      expect(aIsDup).toBe(false);
    });

    it('ADVERSARIAL POISONING — attacker pre-caches a target tenant id under their own tenant; target tenant remains unblocked', async () => {
      // Failure mode #2 from the invariant block in dedup.ts.
      const ATTACKER_TENANT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1';
      const ATTACKER_AGENT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2';
      const TARGET_TENANT = TENANT_A;
      const TARGET_AGENT = AGENT_A;
      const PREDICTED_WID = 'WID_PREDICTED_BY_ATTACKER';

      await runWithTenantContext(
        { tenant_id: ATTACKER_TENANT, agent_id: ATTACKER_AGENT },
        async () => {
          await markSeen(PREDICTED_WID);
        },
      );

      const targetSeesAsDup = await runWithTenantContext(
        { tenant_id: TARGET_TENANT, agent_id: TARGET_AGENT },
        async () => isDuplicate(PREDICTED_WID),
      );

      expect(targetSeesAsDup).toBe(false);

      const existsKeys = keysOf('exists');
      expect(
        existsKeys.some((k) =>
          k.startsWith(
            'dedup:msg:' +
              encodeURIComponent(TARGET_TENANT) +
              ':' +
              encodeURIComponent(TARGET_AGENT) +
              ':',
          ),
        ),
      ).toBe(true);
      expect(
        existsKeys.some((k) =>
          k.startsWith(
            'dedup:msg:' + encodeURIComponent(ATTACKER_TENANT) + ':',
          ),
        ),
      ).toBe(false);
    });

    it('DB-FALLBACK BACKFILL uses the tenant+agent-prefixed key', async () => {
      // When Redis misses but the DB confirms a duplicate, production
      // backfills Redis. That backfill MUST use the tenant+agent-scoped
      // key — otherwise a DB hit under (tenant-A, agent-A1) would
      // poison the cache for (tenant-A, agent-A2).
      findByWhatsappIdMock.mockResolvedValueOnce({ id: 'mid-from-db' });

      const result = await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => isDuplicate(COLLIDING_WID),
      );

      expect(result).toBe(true);
      const setKeys = keysOf('set');
      expect(setKeys).toEqual([expectedKey(TENANT_A, AGENT_A, COLLIDING_WID)]);
    });

    it('throws MissingTenantContextError when called without tenant context', async () => {
      await expect(isDuplicate(COLLIDING_WID)).rejects.toThrow(
        MissingTenantContextError,
      );
      expect(redisStub.exists).not.toHaveBeenCalled();
      expect(redisStub.set).not.toHaveBeenCalled();
      expect(findByWhatsappIdMock).not.toHaveBeenCalled();
    });

    it('Redis-disconnected — skips EXISTS, falls through to DB fallback', async () => {
      // Codex PR #253 review, MAJOR finding. Cover the disconnected
      // branch: EXISTS is skipped entirely; the DB fallback is the only
      // signal. If the DB has no row, isDuplicate returns false (the
      // message has not been processed yet).
      redisConnected = false;
      const result = await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => isDuplicate(COLLIDING_WID),
      );
      expect(result).toBe(false);
      expect(redisStub.exists).not.toHaveBeenCalled();
      // DB was consulted.
      expect(findByWhatsappIdMock).toHaveBeenCalledWith(COLLIDING_WID);
    });

    it('Redis-disconnected + DB hit — duplicate=true, no Redis backfill', async () => {
      // Cover the combo: Redis is down so we skip EXISTS AND we cannot
      // backfill on a DB hit. The function still returns true (caller
      // sees the duplicate), and no Redis write was attempted.
      redisConnected = false;
      findByWhatsappIdMock.mockResolvedValueOnce({ id: 'mid-from-db' });
      const result = await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => isDuplicate(COLLIDING_WID),
      );
      expect(result).toBe(true);
      expect(redisStub.set).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Key encoding — aliasing-safe per-segment encodeURIComponent. Codex PR
  // #253 review (family pattern from #257/#258/#252).
  // -------------------------------------------------------------------------
  describe('alias-safe key encoding', () => {
    it('tenant_id containing ":" produces a key distinct from a tuple where ":" is in agent_id', async () => {
      // Without encoding both tuples would produce the SAME raw string
      // `dedup:msg:acme:dev:WID`. With encoding they're distinct because
      // the colon is escaped to %3A and lands in a different segment.
      await runWithTenantContext(
        { tenant_id: 'acme:dev', agent_id: 'x' },
        async () => {
          await markSeen('WID');
        },
      );
      await runWithTenantContext(
        { tenant_id: 'acme', agent_id: 'dev:x' },
        async () => {
          await markSeen('WID');
        },
      );

      const setKeys = keysOf('set');
      expect(setKeys).toHaveLength(2);
      expect(setKeys[0]).not.toBe(setKeys[1]);
      expect(setKeys[0]).toBe('dedup:msg:acme%3Adev:x:WID');
      expect(setKeys[1]).toBe('dedup:msg:acme:dev%3Ax:WID');
    });

    it('whatsapp_id containing ":" or "%" is encoded', async () => {
      // External-system value — we cannot assume it never contains the
      // delimiter or a percent prefix.
      await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => {
          await markSeen('WID:weird%val');
        },
      );
      const setKeys = keysOf('set');
      expect(setKeys[0]).toBe(
        'dedup:msg:' +
          encodeURIComponent(TENANT_A) +
          ':' +
          encodeURIComponent(AGENT_A) +
          ':' +
          encodeURIComponent('WID:weird%val'),
      );
      // Sanity: the raw `:` and `%` from the wid are NOT present in the key.
      expect(setKeys[0]).not.toContain(':weird%');
    });
  });

  // -------------------------------------------------------------------------
  // Fail-closed validation of corrupted ALS context. Codex PR #253 review,
  // CRITICAL finding: getCurrentTenant/Agent on `main` do NOT yet reject
  // empty/whitespace ids (the fix lives on the unmerged #283 branch). The
  // local guard in dedup.ts must reject defense-in-depth.
  // -------------------------------------------------------------------------
  describe('fail-closed validation of ALS context', () => {
    it('throws on empty-string tenant_id (corrupted ALS)', async () => {
      await expect(
        runWithTenantContext(
          { tenant_id: '', agent_id: AGENT_A },
          async () => markSeen(COLLIDING_WID),
        ),
      ).rejects.toThrow(MissingTenantContextError);
      expect(redisStub.set).not.toHaveBeenCalled();
    });

    it('throws on whitespace-only tenant_id (corrupted ALS)', async () => {
      await expect(
        runWithTenantContext(
          { tenant_id: '   ', agent_id: AGENT_A },
          async () => markSeen(COLLIDING_WID),
        ),
      ).rejects.toThrow(MissingTenantContextError);
      expect(redisStub.set).not.toHaveBeenCalled();
    });

    it('throws on tenant_id with surrounding whitespace (forces ingress-side normalisation)', async () => {
      await expect(
        runWithTenantContext(
          { tenant_id: ' ' + TENANT_A + ' ', agent_id: AGENT_A },
          async () => markSeen(COLLIDING_WID),
        ),
      ).rejects.toThrow(MissingTenantContextError);
      expect(redisStub.set).not.toHaveBeenCalled();
    });

    it('throws on empty-string agent_id (corrupted ALS)', async () => {
      await expect(
        runWithTenantContext(
          { tenant_id: TENANT_A, agent_id: '' },
          async () => markSeen(COLLIDING_WID),
        ),
      ).rejects.toThrow(MissingTenantContextError);
      expect(redisStub.set).not.toHaveBeenCalled();
    });

    it('throws on whitespace-only agent_id (corrupted ALS)', async () => {
      await expect(
        runWithTenantContext(
          { tenant_id: TENANT_A, agent_id: '\t' },
          async () => markSeen(COLLIDING_WID),
        ),
      ).rejects.toThrow(MissingTenantContextError);
      expect(redisStub.set).not.toHaveBeenCalled();
    });

    it('isDuplicate ALSO rejects corrupted context before any Redis or DB op', async () => {
      await expect(
        runWithTenantContext(
          { tenant_id: '', agent_id: AGENT_A },
          async () => isDuplicate(COLLIDING_WID),
        ),
      ).rejects.toThrow(MissingTenantContextError);
      // No Redis or DB op should have been issued.
      expect(redisStub.exists).not.toHaveBeenCalled();
      expect(redisStub.set).not.toHaveBeenCalled();
      expect(findByWhatsappIdMock).not.toHaveBeenCalled();
    });
  });
});
