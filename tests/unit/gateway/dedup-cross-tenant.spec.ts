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
 *   `markSeen`) is prefixed with `tenant_id` resolved from the
 *   AsyncLocalStorage tenant context, AND throws
 *   `MissingTenantContextError` (loud failure) when invoked outside a
 *   `runWithTenantContext` boundary.
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
 * The DB-backed fallback (`mensagensRepo.findByWhatsappId`) is ALREADY
 * tenant+agent-scoped via `getCurrentTenant()/getCurrentAgent()` in
 * `repositories.ts`. Only the Redis cache layer was leaky.
 *
 * Strategy:
 *   - In-memory Redis stub that captures EXACTLY the key strings passed by
 *     production code. We don't simulate Redis semantics in detail — we
 *     record every `(op, key)` tuple and assert against it.
 *   - `isRedisConnected()` mocked to `true` so the early-returns in
 *     isDuplicate/markSeen don't short-circuit the key emission we care
 *     about. The disconnected-Redis branch falls through to the DB
 *     fallback whose scoping is already covered by `repositories.ts`
 *     and `tests/unit/cross-tenant-isolation.spec.ts`; the relevant
 *     contract here is "what Redis key gets used when we DO talk to it".
 *   - `mensagensRepo` mocked to a controlled stub so we exercise the
 *     "DB confirms duplicate → backfill Redis" branch without touching
 *     the real DB. The fallback's own tenant scoping is out of scope
 *     for this spec; we only care that the Redis backfill ALSO uses the
 *     tenant-prefixed key.
 *   - Every test runs inside `runWithTenantContext({tenant_id, agent_id}, …)`
 *     so the production code's `getCurrentTenant()` resolves to the routed
 *     value. The "missing context" test deliberately omits the wrapper to
 *     assert the loud-failure path.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  runWithTenantContext,
  MissingTenantContextError,
} from '@/db/tenant-context.js';

// ---------------------------------------------------------------------------
// Redis call recorder. Captures (op, key, args) so we can assert on the
// EXACT key strings emitted by production. Methods return values shaped
// well enough for production code to keep running.
// ---------------------------------------------------------------------------
type Call = { op: string; key: string; args: unknown[] };

const calls: Call[] = [];
// Toggle: by default treat keys as not-yet-seen. Individual tests flip
// `existsResponses` to simulate a hit by tenant.
let existsResponses: Record<string, number> = {};

const redisStub = {
  exists: vi.fn(async (key: string) => {
    calls.push({ op: 'exists', key, args: [] });
    return existsResponses[key] ?? 0;
  }),
  set: vi.fn(async (key: string, ...args: unknown[]) => {
    calls.push({ op: 'set', key, args });
    // Once SET runs, subsequent EXISTS on the same key should hit. This
    // models real Redis closely enough for the cross-tenant assertions.
    existsResponses[key] = 1;
    return 'OK';
  }),
};

vi.mock('@/lib/redis.js', () => ({
  redis: redisStub,
  isRedisConnected: () => true,
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
const TENANT_B = '22222222-2222-2222-2222-222222222222';
const AGENT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
// A whatsapp_id that COLLIDES across tenants — the bug's core failure mode.
const COLLIDING_WID = 'WID_SHARED_BETWEEN_TENANTS';

function keysOf(op: string): string[] {
  return calls.filter((c) => c.op === op).map((c) => c.key);
}

beforeEach(() => {
  calls.length = 0;
  existsResponses = {};
  redisStub.exists.mockClear();
  redisStub.set.mockClear();
  findByWhatsappIdMock.mockClear();
  findByWhatsappIdMock.mockResolvedValue(null);
});

describe('issue #247 — gateway dedup Redis keys are tenant-scoped', () => {
  // -------------------------------------------------------------------------
  // markSeen — write side: the cache entry MUST land under a tenant-prefixed
  // key. This is the primary anchor — if writes are unscoped, every other
  // property fails downstream.
  // -------------------------------------------------------------------------
  describe('markSeen', () => {
    it('emits a Redis key prefixed with tenant_id', async () => {
      await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => {
          await markSeen(COLLIDING_WID);
        },
      );

      const setKeys = keysOf('set');
      expect(setKeys).toHaveLength(1);
      expect(setKeys[0]).toBe(`dedup:msg:${TENANT_A}:${COLLIDING_WID}`);
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
      expect(setKeys[0]).toBe(`dedup:msg:${TENANT_A}:${COLLIDING_WID}`);
      expect(setKeys[1]).toBe(`dedup:msg:${TENANT_B}:${COLLIDING_WID}`);
      expect(setKeys[0]).not.toBe(setKeys[1]);
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
  });

  // -------------------------------------------------------------------------
  // isDuplicate — read side: EXISTS lookup MUST also be tenant-scoped, so a
  // foreign tenant's prior `markSeen` cannot dedup the local tenant's read.
  // -------------------------------------------------------------------------
  describe('isDuplicate', () => {
    it('queries EXISTS with a tenant-prefixed key', async () => {
      const keyUsed = await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => {
          await isDuplicate(COLLIDING_WID);
          return calls.find((c) => c.op === 'exists')?.key;
        },
      );
      expect(keyUsed).toBe(`dedup:msg:${TENANT_A}:${COLLIDING_WID}`);
    });

    it('CROSS-TENANT INDEPENDENCE — same whatsapp_id seen by tenant-A is NOT a duplicate for tenant-B', async () => {
      // This is the core property the bug violated.
      // tenant-A processes a message, caching the id in Redis. Then
      // tenant-B receives a message with the SAME whatsapp_id (collision).
      // Tenant-B's `isDuplicate` MUST return false — i.e. tenant-B MUST
      // get to process the message.
      await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => {
          await markSeen(COLLIDING_WID);
        },
      );
      // After tenant-A's markSeen, the recorder shows the tenant-A key
      // is "in cache" (existsResponses set by the stub). Tenant-A would
      // dedup; tenant-B should NOT.
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

    it('SYMMETRY (B → A) — tenant-B cache hit does NOT dedup tenant-A', async () => {
      // Mirror of the previous test: prove the property is symmetric and
      // we didn't hard-code tenant-A as a "primary" path.
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
      // Failure mode #2 from the invariant block in dedup.ts: an attacker
      // who predicts a target tenant's whatsapp_id pre-caches it on their
      // own tenant. Under the OLD unscoped key, this would block the
      // legitimate inbound on the target tenant. Under the new key, the
      // attacker's cache only blocks THEIR OWN tenant.
      const ATTACKER_TENANT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1';
      const ATTACKER_AGENT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2';
      const TARGET_TENANT = TENANT_A;
      const TARGET_AGENT = AGENT_A;
      const PREDICTED_WID = 'WID_PREDICTED_BY_ATTACKER';

      // Step 1: attacker pre-caches the predicted id under their own tenant.
      await runWithTenantContext(
        { tenant_id: ATTACKER_TENANT, agent_id: ATTACKER_AGENT },
        async () => {
          await markSeen(PREDICTED_WID);
        },
      );

      // Step 2: the legitimate target tenant receives the message. Even
      // with the SAME whatsapp_id, the dedup check MUST return false.
      const targetSeesAsDup = await runWithTenantContext(
        { tenant_id: TARGET_TENANT, agent_id: TARGET_AGENT },
        async () => isDuplicate(PREDICTED_WID),
      );

      expect(targetSeesAsDup).toBe(false);

      // Defensive: the EXISTS call used the TARGET tenant's prefix, not
      // the attacker's. (Without this check a future refactor that
      // accidentally read both prefixes could pass the boolean assertion
      // by hitting a different code path.)
      const existsKeys = keysOf('exists');
      expect(existsKeys.some((k) => k.startsWith(`dedup:msg:${TARGET_TENANT}:`)))
        .toBe(true);
      expect(existsKeys.some((k) => k.startsWith(`dedup:msg:${ATTACKER_TENANT}:`)))
        .toBe(false);
    });

    it('DB-FALLBACK BACKFILL uses the tenant-prefixed key', async () => {
      // When Redis misses but the DB confirms a duplicate
      // (mensagensRepo.findByWhatsappId returns a row), production backfills
      // Redis with the dedup key. That backfill MUST use the tenant-scoped
      // key — otherwise a DB hit under tenant-A would write the legacy
      // unscoped entry and resurface the cross-tenant leak.
      findByWhatsappIdMock.mockResolvedValueOnce({ id: 'mid-from-db' });

      const result = await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => isDuplicate(COLLIDING_WID),
      );

      expect(result).toBe(true);
      const setKeys = keysOf('set');
      expect(setKeys).toEqual([`dedup:msg:${TENANT_A}:${COLLIDING_WID}`]);
    });

    it('throws MissingTenantContextError when called without tenant context', async () => {
      await expect(isDuplicate(COLLIDING_WID)).rejects.toThrow(
        MissingTenantContextError,
      );
      // And no Redis op / DB op was issued.
      expect(redisStub.exists).not.toHaveBeenCalled();
      expect(redisStub.set).not.toHaveBeenCalled();
      expect(findByWhatsappIdMock).not.toHaveBeenCalled();
    });
  });
});
