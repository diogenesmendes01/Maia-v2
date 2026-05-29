/**
 * Issue #246 — Cross-tenant (cross-empresa) isolation invariant for the
 * gateway BOT-DETECTION layer (Redis sliding-window flood counter).
 *
 * Product invariant (project north star):
 *   "Maias de empresas diferentes NUNCA se comunicam, compartilham dados ou
 *    herdam aprendizado. Sem exceção."
 *
 * Bot-detection-specific contract this spec PROVES:
 *   Every Redis key emitted by `src/gateway/bot-detection.ts`
 *   (`checkBotAndMaybeBlock`) is prefixed with `tenant_id` AND `agent_id`
 *   from the AsyncLocalStorage tenant context (each segment URI-encoded
 *   so the `:` delimiter is unambiguous — see ALIASING test below), AND
 *   the function throws `MissingTenantContextError` (loud failure) when
 *   invoked outside a `runWithTenantContext` boundary.
 *
 * Before this fix the key was `maia:botdet:${phone}` — no tenant/agent
 * namespace. Three concrete failure modes the fix closes:
 *
 *   1. Cross-tenant FALSE POSITIVE: a phone flooding tenant-A pumps the
 *      shared global counter past THRESHOLD; tenant-B sees a normal
 *      inbound from the same phone but reads the SAME counter and
 *      decides it's a flood, blocking tenant-B's pessoa unfairly.
 *   2. Cross-tenant FALSE NEGATIVE: a phone identified as a bot in
 *      tenant-B leaks through to tenant-A (or vice versa) because the
 *      shared counter conflates classifications.
 *   3. BYPASS / cross-tenant DoS: an attacker drives the shared counter
 *      from a low-value tenant they control, denying service to the
 *      primary tenant by acting elsewhere.
 *
 * Strategy:
 *   - In-memory Redis stub that captures EXACTLY the key strings passed by
 *     production code. We don't simulate Redis semantics in detail beyond
 *     a per-key counter (so `incr` returns sequentially increasing values
 *     and we can reason about THRESHOLD crossings without a real Redis).
 *   - `isRedisConnected()` mocked to `true` so the early-return in
 *     `checkBotAndMaybeBlock` doesn't short-circuit the key emission we
 *     care about. The disconnected-Redis branch is already covered by
 *     the function's no-op semantics; the relevant contract here is
 *     "what key gets used when we DO talk to Redis".
 *   - `pessoasRepo` and `audit` are stubbed so the test stays a unit
 *     test — the load-bearing assertions are on Redis keys and on the
 *     fact that two tenants' counters NEVER share state.
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
// Redis call recorder + minimal counter semantics. We need `incr` to behave
// like a real counter (per-key sequential) so we can drive the function past
// THRESHOLD and observe pessoa-side effects per tenant. Everything else just
// records the (op, key, args) tuple.
// ---------------------------------------------------------------------------
type Call = { op: string; key: string; args: unknown[] };

const calls: Call[] = [];
const counters = new Map<string, number>();

const redisStub = {
  incr: vi.fn(async (key: string, ...args: unknown[]) => {
    calls.push({ op: 'incr', key, args });
    const next = (counters.get(key) ?? 0) + 1;
    counters.set(key, next);
    return next;
  }),
  expire: vi.fn(async (key: string, ...args: unknown[]) => {
    calls.push({ op: 'expire', key, args });
    return 1;
  }),
};

vi.mock('@/lib/redis.js', () => ({
  redis: redisStub,
  isRedisConnected: () => true,
  // #309: consulted in the production catch path. This spec exercises a
  // NON-OOM Redis failure (`redis_failed` log), so OOM detection is false and
  // the degrade hook is a no-op — behaviour unchanged. OOM-specific coverage
  // lives in `bot-detection-oom.spec.ts`.
  isRedisOomError: () => false,
  recordRedisOomDegraded: () => {},
}));

// ---------------------------------------------------------------------------
// pessoasRepo + audit stubs. Bot detection looks up pessoa by phone and may
// flip status to 'bloqueada'. The tests below mostly stay BELOW the
// THRESHOLD so this path isn't exercised, but we still stub it so the
// module imports cleanly even if a future test crosses the threshold.
// ---------------------------------------------------------------------------
const findByPhoneMock = vi.fn(async (_tel: string) => null);
const updateStatusMock = vi.fn(async (_id: string, _status: string) => undefined);
const auditMock = vi.fn(async (_payload: unknown) => undefined);

vi.mock('@/db/repositories.js', () => ({
  pessoasRepo: {
    findByPhone: (tel: string) => findByPhoneMock(tel),
    updateStatus: (id: string, status: string) => updateStatusMock(id, status),
  },
}));

vi.mock('@/governance/audit.js', () => ({
  audit: (payload: unknown) => auditMock(payload),
}));

const loggerWarnMock = vi.fn();
vi.mock('@/lib/logger.js', () => ({
  logger: { warn: loggerWarnMock, error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// Pull production code AFTER mocks are installed so the redis import binds
// to our stub.
const { checkBotAndMaybeBlock } = await import('@/gateway/bot-detection.js');

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const AGENT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = '22222222-2222-2222-2222-222222222222';
const AGENT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const PHONE_SHARED = '+5511999999999';

function keysOf(op: string): string[] {
  return calls.filter((c) => c.op === op).map((c) => c.key);
}

describe('issue #246 — bot-detection Redis key is tenant+agent scoped', () => {
  beforeEach(() => {
    calls.length = 0;
    counters.clear();
    redisStub.incr.mockClear();
    redisStub.expire.mockClear();
    findByPhoneMock.mockClear();
    updateStatusMock.mockClear();
    auditMock.mockClear();
    loggerWarnMock.mockClear();
    findByPhoneMock.mockResolvedValue(null);
  });

  // -------------------------------------------------------------------------
  // Key shape — the counter key MUST include tenant_id + agent_id, with
  // every segment URI-encoded so the `:` delimiter is unambiguous (Codex
  // review on PR #252, pattern from PR #257 `_vision-cache.ts`).
  // -------------------------------------------------------------------------
  describe('checkBotAndMaybeBlock — key shape', () => {
    it('emits a key prefixed with encoded tenant_id and agent_id segments', async () => {
      await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => {
          await checkBotAndMaybeBlock(PHONE_SHARED);
        },
      );

      // First call also fires `expire` (count === 1 branch). Both ops target
      // the SAME key string. The UUIDs and `+E164` phone are URI-safe so
      // encodeURIComponent leaves them untouched.
      const expected = `maia:botdet:${encodeURIComponent(TENANT_A)}:${encodeURIComponent(AGENT_A)}:${encodeURIComponent(PHONE_SHARED)}`;
      expect(keysOf('incr')).toEqual([expected]);
      expect(keysOf('expire')).toEqual([expected]);
    });

    // -----------------------------------------------------------------------
    // ALIASING — tenants.id and agents.id are TEXT PRIMARY KEY (free-form
    // slug; see migrations/007_p0_tenants_agents.sql). Without per-segment
    // encoding, a tenant slug containing `:` would collide with a tuple
    // where the colon falls on the agent boundary instead — defeating the
    // tenant-isolation invariant by KEY ALIASING, not by missing context.
    // This test PROVES the encoding closes that hole.
    //
    //   Pair A: tenant='acme:dev'   agent='router'   → "acme%3Adev:router"
    //   Pair B: tenant='acme'       agent='dev:router' → "acme:dev%3Arouter"
    //
    // Decoded these would both spell "acme:dev:router", but the encoded
    // forms are distinct so the Redis counter stays per-tenant.
    // -----------------------------------------------------------------------
    it('per-segment encoding prevents aliasing between (tenant, agent) tuples that share a colon-joined form', async () => {
      const PAIR_A_TENANT = 'acme:dev';
      const PAIR_A_AGENT = 'router';
      const PAIR_B_TENANT = 'acme';
      const PAIR_B_AGENT = 'dev:router';

      await runWithTenantContext(
        { tenant_id: PAIR_A_TENANT, agent_id: PAIR_A_AGENT },
        async () => {
          await checkBotAndMaybeBlock(PHONE_SHARED);
        },
      );
      await runWithTenantContext(
        { tenant_id: PAIR_B_TENANT, agent_id: PAIR_B_AGENT },
        async () => {
          await checkBotAndMaybeBlock(PHONE_SHARED);
        },
      );

      const incrKeys = keysOf('incr');
      expect(incrKeys).toHaveLength(2);

      const keyA = `maia:botdet:${encodeURIComponent(PAIR_A_TENANT)}:${encodeURIComponent(PAIR_A_AGENT)}:${encodeURIComponent(PHONE_SHARED)}`;
      const keyB = `maia:botdet:${encodeURIComponent(PAIR_B_TENANT)}:${encodeURIComponent(PAIR_B_AGENT)}:${encodeURIComponent(PHONE_SHARED)}`;

      expect(incrKeys[0]).toBe(keyA);
      expect(incrKeys[1]).toBe(keyB);
      expect(keyA).not.toBe(keyB);

      // Independent counters — both at 1, not at 2 — proves no aliasing.
      expect(counters.get(keyA)).toBe(1);
      expect(counters.get(keyB)).toBe(1);
    });

    // Belt-and-suspenders: even a `%` already present inside the segment
    // must be re-encoded (`%` → `%25`) so the encoded key is unambiguous
    // when read back. Without this rule, `acme%3Adev` (already encoded
    // somewhere upstream) would re-emit identically — but `acme:dev`
    // (raw) would encode to the SAME string. The encoding round-trips
    // through encodeURIComponent so this can't happen.
    it('percent characters in a segment are themselves encoded', async () => {
      const TENANT_WITH_PERCENT = 'acme%3Adev'; // looks pre-encoded
      await runWithTenantContext(
        { tenant_id: TENANT_WITH_PERCENT, agent_id: AGENT_A },
        async () => {
          await checkBotAndMaybeBlock(PHONE_SHARED);
        },
      );
      const incrKey = keysOf('incr')[0]!;
      // The `%` becomes `%25`, so the literal `%3A` shows up as `%253A`
      // — distinguishable from a raw `:` (which would have encoded to `%3A`).
      expect(incrKey).toContain('acme%253Adev');
    });
  });

  // -------------------------------------------------------------------------
  // Independence — same phone, two tenants, INDEPENDENT classification.
  // -------------------------------------------------------------------------
  describe('checkBotAndMaybeBlock — cross-tenant independence', () => {
    it('same phone under different tenants produces DIFFERENT keys (independent counters)', async () => {
      await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => {
          await checkBotAndMaybeBlock(PHONE_SHARED);
        },
      );
      await runWithTenantContext(
        { tenant_id: TENANT_B, agent_id: AGENT_B },
        async () => {
          await checkBotAndMaybeBlock(PHONE_SHARED);
        },
      );

      const incrKeys = keysOf('incr');
      expect(incrKeys).toHaveLength(2);
      // The UUIDs and `+E164` phone are URI-safe so the encoded form
      // matches the raw form; the assertion still goes through
      // encodeURIComponent to prove the contract regardless of input shape.
      expect(incrKeys[0]).toBe(
        `maia:botdet:${encodeURIComponent(TENANT_A)}:${encodeURIComponent(AGENT_A)}:${encodeURIComponent(PHONE_SHARED)}`,
      );
      expect(incrKeys[1]).toBe(
        `maia:botdet:${encodeURIComponent(TENANT_B)}:${encodeURIComponent(AGENT_B)}:${encodeURIComponent(PHONE_SHARED)}`,
      );
      expect(incrKeys[0]).not.toBe(incrKeys[1]);

      // The counter state itself stays separate — tenant-A's first hit and
      // tenant-B's first hit BOTH return 1 from incr, not 2. This is the
      // load-bearing semantic property: the THRESHOLD check fires
      // independently per (tenant, agent), not on shared accumulation.
      expect(counters.get(incrKeys[0]!)).toBe(1);
      expect(counters.get(incrKeys[1]!)).toBe(1);
    });

    it('same phone, same tenant, DIFFERENT agents → different keys', async () => {
      // Defense-in-depth: agents within the same tenant must also be
      // isolated. Catches a regression where someone strips agent_id from
      // the prefix thinking tenant_id is enough.
      await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => {
          await checkBotAndMaybeBlock(PHONE_SHARED);
        },
      );
      await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_B },
        async () => {
          await checkBotAndMaybeBlock(PHONE_SHARED);
        },
      );

      const incrKeys = keysOf('incr');
      expect(incrKeys).toHaveLength(2);
      // AGENT_A / AGENT_B are URI-safe UUIDs so the encoded form is
      // identical to the raw form. Still go through encodeURIComponent so
      // the assertion holds even if the constants are later replaced with
      // a slug containing `:` or `%`.
      expect(incrKeys[0]).toContain(`:${encodeURIComponent(AGENT_A)}:`);
      expect(incrKeys[1]).toContain(`:${encodeURIComponent(AGENT_B)}:`);
      expect(incrKeys[0]).not.toBe(incrKeys[1]);
    });

    it('SYMMETRY: B→A is also isolated', async () => {
      // Inverse of the previous test — proves the property is symmetric
      // and we didn't just hard-code tenant-A as a "primary" path.
      await runWithTenantContext(
        { tenant_id: TENANT_B, agent_id: AGENT_B },
        async () => {
          await checkBotAndMaybeBlock(PHONE_SHARED);
        },
      );
      const tenantBKey = calls.find((c) => c.op === 'incr')?.key;

      calls.length = 0;

      await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => {
          await checkBotAndMaybeBlock(PHONE_SHARED);
        },
      );
      const tenantAKey = calls.find((c) => c.op === 'incr')?.key;

      expect(tenantBKey).toBe(
        `maia:botdet:${encodeURIComponent(TENANT_B)}:${encodeURIComponent(AGENT_B)}:${encodeURIComponent(PHONE_SHARED)}`,
      );
      expect(tenantAKey).toBe(
        `maia:botdet:${encodeURIComponent(TENANT_A)}:${encodeURIComponent(AGENT_A)}:${encodeURIComponent(PHONE_SHARED)}`,
      );
      expect(tenantAKey).not.toBe(tenantBKey);
    });
  });

  // -------------------------------------------------------------------------
  // ADVERSARIAL — phone marked-bot in tenant-A does NOT leak to tenant-B.
  // This is the security-bypass scenario from the issue: an attacker
  // drives the (previously shared) counter in tenant-A past THRESHOLD,
  // and a legitimate pessoa in tenant-B with the same phone gets
  // collateral-damaged into 'bloqueada' status.
  //
  // We exercise the threshold-crossing path: drive tenant-A above
  // THRESHOLD, confirm pessoa-side-effects fire FOR TENANT-A ONLY, then
  // hit tenant-B with the same phone and confirm:
  //   - tenant-B's counter is at 1 (fresh, not inherited)
  //   - tenant-B's `incr` key is the B-scoped one
  //   - no pessoa lookup / update fires in tenant-B
  // -------------------------------------------------------------------------
  describe('checkBotAndMaybeBlock — ADVERSARIAL cross-tenant leak prevention', () => {
    it('phone marked-bot in tenant-A does NOT leak to tenant-B', async () => {
      // THRESHOLD is 50; drive tenant-A's counter past it. We don't have a
      // pessoa for this phone (findByPhone returns null), so the function
      // returns true via the "unknown number flooding → drop" branch
      // without touching `updateStatus`. That's fine — the load-bearing
      // assertion is that tenant-B's counter does NOT inherit the count.
      const TENANT_A_FLOOD = 60; // > THRESHOLD (50)
      await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => {
          for (let i = 0; i < TENANT_A_FLOOD; i++) {
            await checkBotAndMaybeBlock(PHONE_SHARED);
          }
        },
      );

      const tenantAKey = `maia:botdet:${encodeURIComponent(TENANT_A)}:${encodeURIComponent(AGENT_A)}:${encodeURIComponent(PHONE_SHARED)}`;
      expect(counters.get(tenantAKey)).toBe(TENANT_A_FLOOD);

      // findByPhone should have fired for tenant-A AFTER crossing
      // THRESHOLD (10 times: counts 51..60). If counters were shared, the
      // first tenant-B hit below would also trip it. They aren't, so it
      // won't.
      const findByPhoneCallsAfterTenantA = findByPhoneMock.mock.calls.length;
      expect(findByPhoneCallsAfterTenantA).toBe(TENANT_A_FLOOD - 50);

      // Clear recorder for clean assertions on the tenant-B half.
      calls.length = 0;

      // Tenant-B hits with the SAME phone, EXACTLY ONCE.
      let tenantBReturn: boolean | undefined;
      await runWithTenantContext(
        { tenant_id: TENANT_B, agent_id: AGENT_B },
        async () => {
          tenantBReturn = await checkBotAndMaybeBlock(PHONE_SHARED);
        },
      );

      // Tenant-B used its OWN key, not tenant-A's.
      const tenantBKey = `maia:botdet:${encodeURIComponent(TENANT_B)}:${encodeURIComponent(AGENT_B)}:${encodeURIComponent(PHONE_SHARED)}`;
      expect(keysOf('incr')).toEqual([tenantBKey]);
      expect(tenantBKey).not.toBe(tenantAKey);

      // Tenant-B's counter is at 1 — fresh, NOT carrying tenant-A's flood.
      expect(counters.get(tenantBKey)).toBe(1);

      // 1 <= THRESHOLD ⇒ caller should NOT drop the message in tenant-B.
      expect(tenantBReturn).toBe(false);

      // And critically: no extra findByPhone call fired for tenant-B,
      // because tenant-B never crossed THRESHOLD on its own counter.
      expect(findByPhoneMock.mock.calls.length).toBe(
        findByPhoneCallsAfterTenantA,
      );
      // No status flip either.
      expect(updateStatusMock).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // TTL contract — Redis counter MUST expire after 60 seconds (spec 05
  // §11.4 "sliding 60-second flood counter"). Without an enforced TTL the
  // key would accumulate forever and slow flooders below 50 msgs/min would
  // eventually trip the threshold over a long horizon — exactly the
  // opposite of the intent. The TTL is set only on the FIRST hit (`count
  // === 1` branch) because subsequent hits within the window share the
  // existing TTL; that's correct behaviour, but easy to break in a refactor
  // (e.g. set on every hit, or never set), so we pin it down here.
  // -------------------------------------------------------------------------
  describe('checkBotAndMaybeBlock — TTL contract', () => {
    it('sets a 60-second TTL on the FIRST hit (count === 1 branch)', async () => {
      await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => {
          await checkBotAndMaybeBlock(PHONE_SHARED);
        },
      );
      // Exactly one expire call, with TTL=60s (WINDOW_SECONDS in the
      // production module). Asserting the second argument is what catches
      // a refactor that drops it to e.g. 600s or leaves the TTL unset.
      expect(redisStub.expire).toHaveBeenCalledTimes(1);
      const expireCall = redisStub.expire.mock.calls[0]!;
      expect(expireCall[1]).toBe(60);
    });

    it('does NOT re-arm the TTL on subsequent hits within the same window', async () => {
      await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => {
          await checkBotAndMaybeBlock(PHONE_SHARED);
          await checkBotAndMaybeBlock(PHONE_SHARED);
          await checkBotAndMaybeBlock(PHONE_SHARED);
        },
      );
      // expire fires once, on the first hit only. The TTL set there
      // governs the entire 60s window — re-arming on every hit would let
      // a slow flooder keep the counter alive indefinitely.
      expect(redisStub.expire).toHaveBeenCalledTimes(1);
      expect(redisStub.incr).toHaveBeenCalledTimes(3);
    });
  });

  // -------------------------------------------------------------------------
  // Auto-block path — when a KNOWN pessoa crosses THRESHOLD, the function
  // MUST flip `status` to 'bloqueada' via `pessoasRepo.updateStatus` AND
  // emit an audit event AND return true. The existing adversarial test
  // uses an unknown phone (findByPhone → null), which proves cross-tenant
  // isolation but does NOT exercise the side-effect path. This closes
  // that gap (Codex review on PR #252, "Test gaps" §4).
  // -------------------------------------------------------------------------
  describe('checkBotAndMaybeBlock — auto-block of a known pessoa', () => {
    it('flips a known pessoa to bloqueada and audits when count crosses THRESHOLD', async () => {
      const PESSOA_ID = 'pessoa-uuid-aaaa';
      findByPhoneMock.mockResolvedValue({
        id: PESSOA_ID,
        tipo: 'cliente',
        status: 'ativa',
        telefone_whatsapp: PHONE_SHARED,
      } as unknown as null);

      // Drive past THRESHOLD (50) — the 51st call is the first to trigger
      // the auto-block branch. We do 51 calls total: 50 below-threshold
      // (returning false), then one crossing call.
      let lastReturn: boolean | undefined;
      await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => {
          for (let i = 0; i < 51; i++) {
            lastReturn = await checkBotAndMaybeBlock(PHONE_SHARED);
          }
        },
      );

      // The 51st call (count === 51 > 50) should:
      //   1. Return true (caller must drop the message)
      //   2. Have fired `updateStatus(PESSOA_ID, 'bloqueada')` exactly once
      //   3. Have fired `audit` with `acao: 'auto_blocked_anomalous_volume'`
      expect(lastReturn).toBe(true);
      expect(updateStatusMock).toHaveBeenCalledTimes(1);
      expect(updateStatusMock).toHaveBeenCalledWith(PESSOA_ID, 'bloqueada');
      expect(auditMock).toHaveBeenCalledTimes(1);
      const auditPayload = auditMock.mock.calls[0]![0] as {
        acao: string;
        pessoa_id: string;
        metadata: { count: number; window_seconds: number };
      };
      expect(auditPayload.acao).toBe('auto_blocked_anomalous_volume');
      expect(auditPayload.pessoa_id).toBe(PESSOA_ID);
      expect(auditPayload.metadata.window_seconds).toBe(60);
      expect(auditPayload.metadata.count).toBeGreaterThan(50);
    });

    it('does NOT auto-block owners — emits owner_threshold_exceeded log only', async () => {
      // dono/co_dono are exempt from auto-block by design (spec 05 §11.4).
      // We still want a warning log so a runaway loop on the owner's
      // number is visible to operators.
      const OWNER_ID = 'pessoa-owner-uuid';
      findByPhoneMock.mockResolvedValue({
        id: OWNER_ID,
        tipo: 'dono',
        status: 'ativa',
        telefone_whatsapp: PHONE_SHARED,
      } as unknown as null);

      let lastReturn: boolean | undefined;
      await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => {
          for (let i = 0; i < 51; i++) {
            lastReturn = await checkBotAndMaybeBlock(PHONE_SHARED);
          }
        },
      );

      // Owner path: return FALSE (don't drop), no status change, no audit.
      expect(lastReturn).toBe(false);
      expect(updateStatusMock).not.toHaveBeenCalled();
      expect(auditMock).not.toHaveBeenCalled();
      // But a warn log MUST fire so operators can see the threshold cross.
      const ownerWarn = loggerWarnMock.mock.calls.find(
        (call) => call[1] === 'bot_detection.owner_threshold_exceeded',
      );
      expect(ownerWarn).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Log attribution — every `logger.warn` emitted from the function MUST
  // carry `tenant_id` and `agent_id` so operators can attribute Redis
  // failures, threshold crossings, and auto-blocks to the correct Maia in
  // a multi-tenant deployment. The `lib/logger.ts` pino instance does NOT
  // automatically inject ALS context, so the production code passes it
  // explicitly. This was Codex review HIGH finding [2] on PR #252 —
  // without the labels the logs collapse onto a shared bucket and a
  // cross-tenant abuse pattern is invisible.
  // -------------------------------------------------------------------------
  describe('checkBotAndMaybeBlock — log attribution', () => {
    it('redis_failed log includes tenant_id and agent_id', async () => {
      // Force the redis incr to throw so we hit the catch branch.
      redisStub.incr.mockRejectedValueOnce(new Error('CONN_RESET'));

      await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => {
          await checkBotAndMaybeBlock(PHONE_SHARED);
        },
      );

      const redisFailedCall = loggerWarnMock.mock.calls.find(
        (call) => call[1] === 'bot_detection.redis_failed',
      );
      expect(redisFailedCall).toBeDefined();
      const payload = redisFailedCall![0] as {
        tenant_id: string;
        agent_id: string;
        err: string;
      };
      expect(payload.tenant_id).toBe(TENANT_A);
      expect(payload.agent_id).toBe(AGENT_A);
      expect(payload.err).toBe('CONN_RESET');
    });

    it('auto_blocked log includes tenant_id and agent_id', async () => {
      const PESSOA_ID = 'pessoa-uuid-bbbb';
      findByPhoneMock.mockResolvedValue({
        id: PESSOA_ID,
        tipo: 'cliente',
        status: 'ativa',
        telefone_whatsapp: PHONE_SHARED,
      } as unknown as null);

      await runWithTenantContext(
        { tenant_id: TENANT_B, agent_id: AGENT_B },
        async () => {
          for (let i = 0; i < 51; i++) {
            await checkBotAndMaybeBlock(PHONE_SHARED);
          }
        },
      );

      const autoBlockedCall = loggerWarnMock.mock.calls.find(
        (call) => call[1] === 'bot_detection.auto_blocked',
      );
      expect(autoBlockedCall).toBeDefined();
      const payload = autoBlockedCall![0] as {
        tenant_id: string;
        agent_id: string;
        pessoa_id: string;
      };
      expect(payload.tenant_id).toBe(TENANT_B);
      expect(payload.agent_id).toBe(AGENT_B);
      expect(payload.pessoa_id).toBe(PESSOA_ID);
    });

    it('owner_threshold_exceeded log includes tenant_id and agent_id', async () => {
      const OWNER_ID = 'pessoa-owner-cccc';
      findByPhoneMock.mockResolvedValue({
        id: OWNER_ID,
        tipo: 'co_dono',
        status: 'ativa',
        telefone_whatsapp: PHONE_SHARED,
      } as unknown as null);

      await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_B },
        async () => {
          for (let i = 0; i < 51; i++) {
            await checkBotAndMaybeBlock(PHONE_SHARED);
          }
        },
      );

      const ownerCall = loggerWarnMock.mock.calls.find(
        (call) => call[1] === 'bot_detection.owner_threshold_exceeded',
      );
      expect(ownerCall).toBeDefined();
      const payload = ownerCall![0] as {
        tenant_id: string;
        agent_id: string;
        pessoa_id: string;
      };
      expect(payload.tenant_id).toBe(TENANT_A);
      expect(payload.agent_id).toBe(AGENT_B);
      expect(payload.pessoa_id).toBe(OWNER_ID);
    });
  });

  // -------------------------------------------------------------------------
  // Missing context — must throw loudly. NO fallback to a shared key.
  // -------------------------------------------------------------------------
  describe('checkBotAndMaybeBlock — missing tenant context', () => {
    it('throws MissingTenantContextError when called without tenant context', async () => {
      await expect(checkBotAndMaybeBlock(PHONE_SHARED)).rejects.toThrow(
        MissingTenantContextError,
      );
      // Nothing should have been written to Redis.
      expect(redisStub.incr).not.toHaveBeenCalled();
      expect(redisStub.expire).not.toHaveBeenCalled();
      // And no pessoa side-effects either.
      expect(findByPhoneMock).not.toHaveBeenCalled();
      expect(updateStatusMock).not.toHaveBeenCalled();
      expect(auditMock).not.toHaveBeenCalled();
    });
  });
});
