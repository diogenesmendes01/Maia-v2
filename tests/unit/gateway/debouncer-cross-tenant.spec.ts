/**
 * Issue #248 — Cross-tenant (cross-empresa) isolation invariant for the
 * gateway DEBOUNCE layer (per-user message buffering for chunked-typing).
 *
 * Product invariant (project north star):
 *   "Maias de empresas diferentes NUNCA se comunicam, compartilham dados ou
 *    herdam aprendizado. Sem exceção."
 *
 * Debounce-specific contract this spec PROVES:
 *   Both the Redis state key (`agent-debounce:…`) AND the BullMQ jobId
 *   (`debounce:…`) emitted by `src/gateway/debouncer.ts` are prefixed with
 *   `tenant_id` AND `agent_id` from the AsyncLocalStorage tenant context.
 *   Two messages with the SAME phone but DIFFERENT tenants get two
 *   INDEPENDENT debouncers — neither suppresses the other. The function
 *   throws `MissingTenantContextError` (loud failure) when invoked
 *   outside a `runWithTenantContext` boundary.
 *
 * The pre-fix bug (#248): keys were derived from `phone` alone. A phone
 * shared between two tenants (common B2B SaaS scenario: a household
 * member appears in two companies; an owner uses the same WhatsApp for
 * personal+company) would COLLIDE. Tenant A arms the debouncer with a
 * pending BullMQ job; tenant B's message under the same phone finds the
 * existing job (same jobId), removes it (or short-circuits via
 * max_hold_passthrough), and either replays under tenant A's context or
 * silently drops tenant B's message entirely. Severity: MAJOR (silent
 * loss of legitimate messages in production).
 *
 * Strategy:
 *   - In-memory Redis + BullMQ stubs that record EVERY (op, key, args)
 *     tuple so assertions target the exact key strings emitted by
 *     production. We don't simulate Redis or BullMQ semantics in detail —
 *     the contract under test is "which key string did we use?", not
 *     "does the queue dispatch the job?".
 *   - Every test runs inside `runWithTenantContext({tenant_id, agent_id})`
 *     so the production code's ALS reads resolve to the routed values.
 *     The "missing context" test deliberately omits the wrapper to assert
 *     the loud-failure path.
 *   - The simultaneous-message scenario is the headline adversarial
 *     case: two tenants each take one turn, interleaved, with the same
 *     phone — BOTH must end up scheduled (no suppression, no cross-tenant
 *     execution).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  runWithTenantContext,
  MissingTenantContextError,
} from '@/db/tenant-context.js';

// ---------------------------------------------------------------------------
// Redis call recorder. Production `debouncer.ts` calls only get/set/del
// on its STATE_KEY. We record (op, key) so a single shared phone with two
// tenants emits TWO disjoint key sets in the assertion record.
// ---------------------------------------------------------------------------
type RedisCall = { op: string; key: string; args: unknown[] };
const redisCalls: RedisCall[] = [];
const redisStore = new Map<string, string>();

const redisStub = {
  get: vi.fn(async (key: string, ...args: unknown[]) => {
    redisCalls.push({ op: 'get', key, args });
    return redisStore.get(key) ?? null;
  }),
  set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
    redisCalls.push({ op: 'set', key, args: [value, ...args] });
    redisStore.set(key, value);
    return 'OK';
  }),
  del: vi.fn(async (key: string, ...args: unknown[]) => {
    redisCalls.push({ op: 'del', key, args });
    const had = redisStore.delete(key);
    return had ? 1 : 0;
  }),
};

// Mutable flag so individual tests can toggle Redis to "disconnected"
// without re-importing the debouncer (which would reset the ALS store
// and break the tenant-context propagation under test).
const redisConnected = { value: true };

vi.mock('@/lib/redis.js', () => ({
  redis: redisStub,
  isRedisConnected: () => redisConnected.value,
}));

vi.mock('@/lib/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@/config/env.js', () => ({
  config: {
    BAILEYS_AUTH_DIR: '/tmp/test',
    REDIS_URL: 'redis://localhost:6379',
    MESSAGE_DEBOUNCE_MS: 5000,
    MESSAGE_DEBOUNCE_MAX_MS: 30000,
  },
}));

// ---------------------------------------------------------------------------
// BullMQ stub. Production `debouncer.ts` touches `agentQueue.add` and
// `agentQueue.getJob`. We record each `add` call with its jobId so we can
// assert on the EXACT jobId string emitted under each tenant context.
// `getJob` returns `null` by default (no pre-existing job), simulating
// a clean queue — that's the realistic "first message" path that the
// cross-tenant scenarios all hit.
// ---------------------------------------------------------------------------
type QueueAdd = { name: string; data: unknown; opts: { jobId: string } & Record<string, unknown> };
const queueAdds: QueueAdd[] = [];
const queueGetJob = vi.fn(
  async (_id: string) => null as { remove: () => Promise<void> } | null,
);
const queueAdd = vi.fn(
  async (name: string, data: unknown, opts: { jobId: string } & Record<string, unknown>) => {
    queueAdds.push({ name, data, opts });
    return undefined;
  },
);

vi.mock('@/gateway/queue.js', () => ({
  agentQueue: {
    add: queueAdd,
    getJob: queueGetJob,
  },
}));

// Pull production code AFTER mocks are installed.
const { scheduleDebouncedAgent, clearDebounceState, debounceJobId, _internal } =
  await import('@/gateway/debouncer.js');

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------
const TENANT_A = '11111111-1111-1111-1111-111111111111';
const AGENT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = '22222222-2222-2222-2222-222222222222';
const AGENT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

// The headline shared phone — same +5511 number, two tenants. This is
// the production scenario where the bug bites: WhatsApp Business owner
// uses the same number for personal account (tenant A) and company B's
// support line; both Maias receive the same inbound.
const SHARED_PHONE = '+5511999999999';

/**
 * URI-encoding wrapper to mirror the production `buildKey` segment encoding
 * adopted in the PR #259 review (pattern from #257 `_vision-cache.ts` /
 * #258 `bot-detection.ts`). Tests assert on encoded forms so the `+` in a
 * phone (E.164) becomes `%2B` — anything else means the test is checking
 * a key the production code no longer emits.
 */
const enc = encodeURIComponent;

function keysOf(op: string): string[] {
  return redisCalls.filter((c) => c.op === op).map((c) => c.key);
}

function jobIdsAdded(): string[] {
  return queueAdds.map((a) => a.opts.jobId);
}

function reset(): void {
  redisCalls.length = 0;
  redisStore.clear();
  queueAdds.length = 0;
  redisStub.get.mockClear();
  redisStub.set.mockClear();
  redisStub.del.mockClear();
  redisStub.get.mockImplementation(async (key: string, ...args: unknown[]) => {
    redisCalls.push({ op: 'get', key, args });
    return redisStore.get(key) ?? null;
  });
  redisStub.set.mockImplementation(async (key: string, value: string, ...args: unknown[]) => {
    redisCalls.push({ op: 'set', key, args: [value, ...args] });
    redisStore.set(key, value);
    return 'OK';
  });
  redisStub.del.mockImplementation(async (key: string, ...args: unknown[]) => {
    redisCalls.push({ op: 'del', key, args });
    const had = redisStore.delete(key);
    return had ? 1 : 0;
  });
  queueGetJob.mockClear();
  queueGetJob.mockResolvedValue(null);
  queueAdd.mockClear();
  queueAdd.mockImplementation(async (name: string, data: unknown, opts: { jobId: string } & Record<string, unknown>) => {
    queueAdds.push({ name, data, opts });
    return undefined;
  });
  // Restore Redis "connected" default — Redis-down tests flip this and
  // beforeEach must reset it for sibling tests.
  redisConnected.value = true;
}

describe('issue #248 — debouncer keys are tenant+agent scoped', () => {
  beforeEach(reset);

  // -------------------------------------------------------------------------
  // 1) Same phone, different tenants → INDEPENDENT debouncers.
  //
  // The headline cross-tenant assertion. A Redis state key emitted under
  // tenant A and one emitted under tenant B for the SAME phone must be
  // DIFFERENT strings. Otherwise the second tenant's write would clobber
  // the first's state (and either reset its debounce window or carry over
  // a stale first_enqueued_at across tenants).
  // -------------------------------------------------------------------------
  describe('same phone, different tenants', () => {
    it('emits DIFFERENT Redis state keys for tenant A vs tenant B', async () => {
      await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => {
          await scheduleDebouncedAgent({ phone: SHARED_PHONE, mensagem_id: 'mA' });
        },
      );
      await runWithTenantContext(
        { tenant_id: TENANT_B, agent_id: AGENT_B },
        async () => {
          await scheduleDebouncedAgent({ phone: SHARED_PHONE, mensagem_id: 'mB' });
        },
      );

      // Each scheduleDebouncedAgent emits one `get` (readState) + one
      // `set` (writeState). With independent keys we expect the SET-key
      // for tenant A and tenant B to differ. Each segment is URI-encoded
      // (PR #259 review, mirrors #257/#258 `buildKey`).
      const setKeys = keysOf('set');
      expect(setKeys).toHaveLength(2);
      const expectedA = `agent-debounce:${enc(TENANT_A)}:${enc(AGENT_A)}:${enc(SHARED_PHONE)}`;
      const expectedB = `agent-debounce:${enc(TENANT_B)}:${enc(AGENT_B)}:${enc(SHARED_PHONE)}`;
      expect(setKeys[0]).toBe(expectedA);
      expect(setKeys[1]).toBe(expectedB);
      expect(setKeys[0]).not.toBe(setKeys[1]);

      // Same for the `get` side — the read MUST be scoped, otherwise
      // tenant B would observe tenant A's prior state and falsely
      // believe its own message is a "second-in-window" reset.
      const getKeys = keysOf('get');
      expect(getKeys).toHaveLength(2);
      expect(getKeys[0]).toBe(expectedA);
      expect(getKeys[1]).toBe(expectedB);
    });

    it('emits DIFFERENT BullMQ jobIds for tenant A vs tenant B', async () => {
      // The jobId collision was the OTHER half of the original bug:
      // BullMQ rejects duplicate jobIds. If both tenants hash to the same
      // jobId, the second tenant's `add` either silently no-ops or wins
      // over the first — depending on the order of getJob/remove. Either
      // way, ONE of the tenants loses its message.
      await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => {
          await scheduleDebouncedAgent({ phone: SHARED_PHONE, mensagem_id: 'mA' });
        },
      );
      await runWithTenantContext(
        { tenant_id: TENANT_B, agent_id: AGENT_B },
        async () => {
          await scheduleDebouncedAgent({ phone: SHARED_PHONE, mensagem_id: 'mB' });
        },
      );

      const jobIds = jobIdsAdded();
      expect(jobIds).toHaveLength(2);
      expect(jobIds[0]).toBe(`debounce:${enc(TENANT_A)}:${enc(AGENT_A)}:${enc(SHARED_PHONE)}`);
      expect(jobIds[1]).toBe(`debounce:${enc(TENANT_B)}:${enc(AGENT_B)}:${enc(SHARED_PHONE)}`);
      expect(jobIds[0]).not.toBe(jobIds[1]);
    });
  });

  // -------------------------------------------------------------------------
  // 2) Symmetry — B → A must isolate as cleanly as A → B.
  //
  // If the namespace prefix were applied asymmetrically (e.g. only on
  // write but not on read), the order in which tenants arrive could
  // leak. Run the same scenario in reverse order; the assertion is
  // identical.
  // -------------------------------------------------------------------------
  describe('symmetry: B → A direction', () => {
    it('B-then-A yields the same isolation as A-then-B', async () => {
      await runWithTenantContext(
        { tenant_id: TENANT_B, agent_id: AGENT_B },
        async () => {
          await scheduleDebouncedAgent({ phone: SHARED_PHONE, mensagem_id: 'mB1' });
        },
      );
      await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => {
          await scheduleDebouncedAgent({ phone: SHARED_PHONE, mensagem_id: 'mA1' });
        },
      );

      const setKeys = keysOf('set');
      expect(setKeys).toHaveLength(2);
      expect(setKeys[0]).toBe(`agent-debounce:${enc(TENANT_B)}:${enc(AGENT_B)}:${enc(SHARED_PHONE)}`);
      expect(setKeys[1]).toBe(`agent-debounce:${enc(TENANT_A)}:${enc(AGENT_A)}:${enc(SHARED_PHONE)}`);
      expect(setKeys[0]).not.toBe(setKeys[1]);

      const jobIds = jobIdsAdded();
      expect(jobIds[0]).toBe(`debounce:${enc(TENANT_B)}:${enc(AGENT_B)}:${enc(SHARED_PHONE)}`);
      expect(jobIds[1]).toBe(`debounce:${enc(TENANT_A)}:${enc(AGENT_A)}:${enc(SHARED_PHONE)}`);
      expect(jobIds[0]).not.toBe(jobIds[1]);
    });

    it('same tenant, DIFFERENT agents → still different keys (defense-in-depth)', async () => {
      // Catches a regression where someone strips agent_id from the
      // prefix thinking tenant_id alone is enough. Two agents inside
      // the SAME tenant servicing the same phone (e.g. a router agent
      // and an executor agent in a multi-agent setup) must NOT share
      // debounce windows — they buffer message chunks for different
      // pipelines.
      await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => {
          await scheduleDebouncedAgent({ phone: SHARED_PHONE, mensagem_id: 'mAa' });
        },
      );
      await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_B },
        async () => {
          await scheduleDebouncedAgent({ phone: SHARED_PHONE, mensagem_id: 'mAb' });
        },
      );

      const setKeys = keysOf('set');
      expect(setKeys).toHaveLength(2);
      // Encoded agent_id segments (URI-safe UUIDs are unchanged by enc).
      expect(setKeys[0]).toContain(`:${enc(AGENT_A)}:`);
      expect(setKeys[1]).toContain(`:${enc(AGENT_B)}:`);
      expect(setKeys[0]).not.toBe(setKeys[1]);
    });
  });

  // -------------------------------------------------------------------------
  // 3) Missing context → throws, ZERO side-effects.
  //
  // Loud failure invariant: a missing-context bug must crash, NOT fall
  // back to a "default" or empty namespace. If the throw were swapped
  // for a silent fallback, every legitimate cross-tenant collision
  // would be re-introduced under a single shared namespace.
  // -------------------------------------------------------------------------
  describe('missing tenant context', () => {
    it('scheduleDebouncedAgent throws MissingTenantContextError and emits zero ops', async () => {
      await expect(
        scheduleDebouncedAgent({ phone: SHARED_PHONE, mensagem_id: 'm-no-ctx' }),
      ).rejects.toThrow(MissingTenantContextError);

      // The throw must happen BEFORE any Redis or queue side-effect —
      // otherwise the wrong tenant could observe garbage state.
      expect(redisStub.get).not.toHaveBeenCalled();
      expect(redisStub.set).not.toHaveBeenCalled();
      expect(redisStub.del).not.toHaveBeenCalled();
      expect(queueGetJob).not.toHaveBeenCalled();
      expect(queueAdd).not.toHaveBeenCalled();
    });

    it('clearDebounceState throws MissingTenantContextError and emits zero ops', async () => {
      await expect(clearDebounceState(SHARED_PHONE)).rejects.toThrow(
        MissingTenantContextError,
      );
      expect(redisStub.del).not.toHaveBeenCalled();
    });

    it('debounceJobId throws when called outside tenant context', async () => {
      // Public surface is fail-loud everywhere — you cannot synthesise
      // an unscoped jobId through the module's API.
      expect(() => debounceJobId(SHARED_PHONE)).toThrow(MissingTenantContextError);
    });
  });

  // -------------------------------------------------------------------------
  // 4) Adversarial: simultaneous messages from the same phone to two
  //    tenants → BOTH debouncers armed, BOTH delivered.
  //
  // This is the headline production scenario from issue #248. The
  // pre-fix bug: tenant A's message arms the debouncer under the
  // phone-only key; tenant B's message arrives a few ms later, finds
  // the existing job (same jobId because phone-only collides),
  // removes it (or skips on max_hold), and replaces it with a job
  // running under tenant B's context — silently re-routing tenant A's
  // pending message to tenant B's agent, OR dropping tenant B's
  // message entirely. Post-fix: each tenant scopes to its own
  // (tenant_id, agent_id, phone) tuple, so the jobIds and state keys
  // never collide regardless of arrival order or timing.
  //
  // We assert THREE things about the simultaneous interleaving:
  //   (a) Each tenant's `add` is called exactly once with its OWN
  //       jobId — no `add` is suppressed or rerouted.
  //   (b) The `add`'s `data.mensagem_id` for each tenant matches the
  //       message that tenant sent — i.e. tenant A's job carries
  //       'mA', tenant B's job carries 'mB' (no cross-pollination).
  //   (c) No `getJob` returning a cross-tenant job (we never observe
  //       a state miss as a hit, because the keys are disjoint).
  // -------------------------------------------------------------------------
  describe('adversarial: simultaneous same-phone messages to two tenants', () => {
    it('BOTH tenants get their own debouncer; no silent drop', async () => {
      // Interleave the work: A reads, B reads, A writes, B writes.
      // If keys collided, B's read would see A's prior state (false
      // reset / wrong heldMs) and B's write would clobber A's stamp.
      // With proper scoping, the two flows are perfectly disjoint.
      const flowA = runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => {
          await scheduleDebouncedAgent({
            phone: SHARED_PHONE,
            mensagem_id: 'mA',
          });
        },
      );
      const flowB = runWithTenantContext(
        { tenant_id: TENANT_B, agent_id: AGENT_B },
        async () => {
          await scheduleDebouncedAgent({
            phone: SHARED_PHONE,
            mensagem_id: 'mB',
          });
        },
      );

      // Promise.all in either order — both flows must succeed and
      // each must observe its own scope, regardless of interleaving.
      // The mock Redis is in-memory and synchronous-under-the-hood,
      // so this is a deterministic check that the ALS context
      // propagates correctly across each await without leaking
      // across tenants.
      await Promise.all([flowA, flowB]);

      // (a) Both tenants emitted exactly one `add` each.
      expect(queueAdd).toHaveBeenCalledTimes(2);
      const jobIds = jobIdsAdded();
      const expectedAJob = `debounce:${enc(TENANT_A)}:${enc(AGENT_A)}:${enc(SHARED_PHONE)}`;
      const expectedBJob = `debounce:${enc(TENANT_B)}:${enc(AGENT_B)}:${enc(SHARED_PHONE)}`;
      expect(jobIds).toContain(expectedAJob);
      expect(jobIds).toContain(expectedBJob);

      // (b) mensagem_id is preserved per tenant — no cross-pollination.
      const addByJobId = new Map(queueAdds.map((a) => [a.opts.jobId, a]));
      expect((addByJobId.get(expectedAJob)?.data as { mensagem_id: string }).mensagem_id).toBe('mA');
      expect((addByJobId.get(expectedBJob)?.data as { mensagem_id: string }).mensagem_id).toBe('mB');

      // (c) The Redis state keys also diverge — independent debounce
      // windows that won't suppress each other on the next message.
      const setKeys = new Set(keysOf('set'));
      expect(setKeys.has(`agent-debounce:${enc(TENANT_A)}:${enc(AGENT_A)}:${enc(SHARED_PHONE)}`)).toBe(true);
      expect(setKeys.has(`agent-debounce:${enc(TENANT_B)}:${enc(AGENT_B)}:${enc(SHARED_PHONE)}`)).toBe(true);
    });

    it('a stale tenant-B state is UNREACHABLE from a tenant-A read (post-fix)', async () => {
      // Adversarial: pre-fix, tenant B could leave a stale state row
      // under the phone-only key that tenant A would then read on its
      // next message and treat as a same-window reset. Post-fix, the
      // read key is `${enc(TENANT_A)}:${enc(AGENT_A)}:${enc(phone)}` — a
      // stale entry under `${enc(TENANT_B)}:${enc(AGENT_B)}:${enc(phone)}`
      // is in a different namespace and invisible.
      const staleB = `agent-debounce:${enc(TENANT_B)}:${enc(AGENT_B)}:${enc(SHARED_PHONE)}`;
      redisStore.set(staleB, JSON.stringify({ first_enqueued_at: Date.now() - 1500 }));

      const result = await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () =>
          scheduleDebouncedAgent({
            phone: SHARED_PHONE,
            mensagem_id: 'mA',
          }),
      );

      // Tenant A sees a clean window — `reset: false` because its OWN
      // namespace had no prior state. A pre-fix run would have read
      // tenant B's stale row and returned `reset: true` with a
      // non-zero `held_ms`.
      expect(result).toMatchObject({ kind: 'scheduled', reset: false });
      if (result.kind === 'scheduled') {
        expect(result.held_ms).toBe(0);
      }

      // The read tenant A issued targeted tenant A's namespace.
      const tenantAGetKey = `agent-debounce:${enc(TENANT_A)}:${enc(AGENT_A)}:${enc(SHARED_PHONE)}`;
      expect(keysOf('get')).toEqual([tenantAGetKey]);
    });
  });

  // -------------------------------------------------------------------------
  // 5) scopedKey internal — single source of truth.
  //
  // The composer is exposed via `_internal.scopedKey` so a regression
  // that bypasses it (e.g. someone inlines `${phone}` somewhere) shows
  // up as a key-string divergence in the cross-tenant tests above.
  // This test pins the format so a future cosmetic refactor doesn't
  // silently change the prefix without the cross-tenant tests catching
  // it (they assert on the full key — but assert on the composer too
  // for a clear failure message).
  // -------------------------------------------------------------------------
  describe('scopedKey composition', () => {
    it('produces `${enc(tenant_id)}:${enc(agent_id)}:${enc(phone)}` under a given context', async () => {
      const scoped = await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => _internal.scopedKey(SHARED_PHONE),
      );
      expect(scoped).toBe(`${enc(TENANT_A)}:${enc(AGENT_A)}:${enc(SHARED_PHONE)}`);
    });
  });

  // -------------------------------------------------------------------------
  // 6) Aliasing-safe key encoding (PR #259 review, mirrors PR #257/#258
  //    `buildKey` pattern). Each segment is URI-encoded, so a tenant slug
  //    or agent slug containing `:` cannot collide with a tuple where a
  //    later segment starts with the same prefix.
  // -------------------------------------------------------------------------
  describe('aliasing-safe key encoding (buildKey pattern)', () => {
    it('tenant_id containing `:` is URI-encoded so it cannot alias another tuple', async () => {
      // Adversarial: a tenant slug `acme:dev` with a normal agent `prod`
      // must NOT produce the same key as tenant `acme` + agent `dev:prod`
      // — otherwise the `:` delimiter would let a crafted slug collapse
      // two distinct tenant/agent buckets into one. `tenants.id` is
      // TEXT PRIMARY KEY (free-form slug; see migration
      // 007_p0_tenants_agents.sql).
      await runWithTenantContext(
        { tenant_id: 'acme:dev', agent_id: 'prod' },
        async () => {
          await scheduleDebouncedAgent({ phone: SHARED_PHONE, mensagem_id: 'm1' });
        },
      );
      const keyA = keysOf('set')[0];

      // Reset between the two scenarios so we can compare cleanly.
      redisCalls.length = 0;
      redisStore.clear();
      queueAdds.length = 0;
      redisStub.get.mockClear();
      redisStub.set.mockClear();
      queueAdd.mockClear();

      await runWithTenantContext(
        { tenant_id: 'acme', agent_id: 'dev:prod' },
        async () => {
          await scheduleDebouncedAgent({ phone: SHARED_PHONE, mensagem_id: 'm2' });
        },
      );
      const keyB = keysOf('set')[0];

      expect(keyA).toBeDefined();
      expect(keyB).toBeDefined();
      expect(keyA).not.toBe(keyB);
      // Concrete pinned forms — `:` inside a segment is `%3A`.
      expect(keyA).toBe(`agent-debounce:acme%3Adev:prod:${enc(SHARED_PHONE)}`);
      expect(keyB).toBe(`agent-debounce:acme:dev%3Aprod:${enc(SHARED_PHONE)}`);
    });

    it('phone containing `:` is URI-encoded (defense-in-depth, future-proof)', async () => {
      // Phones in production are E.164 (`+5511…`) and would not contain
      // `:`. But a future caller may pass a free-form WhatsApp lid
      // (`12345@s.whatsapp.net`) or a synthetic id with delimiters —
      // encoding the phone segment makes the rule "every segment is
      // encoded" uniform.
      const weirdPhone = 'lid:12345@whatsapp';
      await runWithTenantContext(
        { tenant_id: TENANT_A, agent_id: AGENT_A },
        async () => {
          await scheduleDebouncedAgent({ phone: weirdPhone, mensagem_id: 'm1' });
        },
      );
      const key = keysOf('set')[0];
      expect(key).toBe(`agent-debounce:${enc(TENANT_A)}:${enc(AGENT_A)}:${enc(weirdPhone)}`);
      // `:` inside the phone is encoded, so the key has exactly the right
      // number of `:` separators (3 after the `agent-debounce` prefix).
      expect(key?.split(':').length).toBe(4);
    });
  });

  // -------------------------------------------------------------------------
  // 7) Malformed-context guard (PR #259 review, MAJOR B): a context object
  //    with empty / whitespace-only / surround-whitespace tenant_id or
  //    agent_id MUST throw at `scopedKey()`, BEFORE we compose any key or
  //    touch Redis. The merge base of this branch does not include
  //    `assertTruthyContext` from `tenant-context.ts` (commit c01c9c0 on
  //    a sibling branch), so we test the local `assertScopeSegment`
  //    equivalent embedded in `debouncer.ts`.
  // -------------------------------------------------------------------------
  describe('malformed context (empty / whitespace tenant or agent segment)', () => {
    it('empty tenant_id throws MissingTenantContextError and emits zero side-effects', async () => {
      await expect(
        runWithTenantContext(
          { tenant_id: '', agent_id: AGENT_A },
          async () => scheduleDebouncedAgent({ phone: SHARED_PHONE, mensagem_id: 'm' }),
        ),
      ).rejects.toThrow(MissingTenantContextError);

      expect(redisStub.get).not.toHaveBeenCalled();
      expect(redisStub.set).not.toHaveBeenCalled();
      expect(queueAdd).not.toHaveBeenCalled();
    });

    it('whitespace-only agent_id throws MissingTenantContextError', async () => {
      await expect(
        runWithTenantContext(
          { tenant_id: TENANT_A, agent_id: '   ' },
          async () => scheduleDebouncedAgent({ phone: SHARED_PHONE, mensagem_id: 'm' }),
        ),
      ).rejects.toThrow(MissingTenantContextError);

      expect(queueAdd).not.toHaveBeenCalled();
    });

    it('surrounding-whitespace tenant_id throws (no implicit trim)', async () => {
      // `' acme '` is intentionally rejected, not implicitly trimmed —
      // cache keys would alias `' acme '` against `'acme'` for some
      // codepaths but not others, hiding the upstream bug. Same rule as
      // the project-wide `assertTruthyContext` in `tenant-context.ts`.
      await expect(
        runWithTenantContext(
          { tenant_id: ' acme ', agent_id: AGENT_A },
          async () => scheduleDebouncedAgent({ phone: SHARED_PHONE, mensagem_id: 'm' }),
        ),
      ).rejects.toThrow(MissingTenantContextError);
    });

    it('null tenant_id (cast through `as any`) throws MissingTenantContextError', async () => {
      await expect(
        runWithTenantContext(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { tenant_id: null as any, agent_id: AGENT_A },
          async () => scheduleDebouncedAgent({ phone: SHARED_PHONE, mensagem_id: 'm' }),
        ),
      ).rejects.toThrow(MissingTenantContextError);

      // CRITICAL: no `undefined:agent_id:phone` key escaped to Redis.
      expect(redisStub.set).not.toHaveBeenCalled();
      expect(queueAdd).not.toHaveBeenCalled();
    });

    it('clearDebounceState also enforces the malformed-context guard', async () => {
      await expect(
        runWithTenantContext(
          { tenant_id: '', agent_id: AGENT_A },
          async () => clearDebounceState(SHARED_PHONE),
        ),
      ).rejects.toThrow(MissingTenantContextError);
      expect(redisStub.del).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 8) Redis-down fail-closed (PR #259 review, MAJOR A + MAJOR C). Pre-fix,
  //    `readState`/`writeState`/`clearState` returned null/void early when
  //    `isRedisConnected()` was false. The caller (`baileys.ts:362-393`)
  //    catches throws and falls through to immediate enqueue, so a Redis
  //    blip combined with the early-return silently bypassed the
  //    tenant-scoped debounce window. Post-fix: each helper throws
  //    `DebouncerRedisUnavailableError` and the caller's catch is the
  //    EXPLICIT bypass decision, not an accident.
  // -------------------------------------------------------------------------
  describe('Redis-down fail-closed contract', () => {
    it('scheduleDebouncedAgent throws DebouncerRedisUnavailableError when Redis is down', async () => {
      // Flip the mutable flag so `isRedisConnected()` returns false for
      // this test only — much safer than `vi.doMock + vi.resetModules`,
      // which would also reset the AsyncLocalStorage store (and break
      // the `runWithTenantContext` propagation under test).
      redisConnected.value = false;

      await expect(
        runWithTenantContext(
          { tenant_id: TENANT_A, agent_id: AGENT_A },
          async () => scheduleDebouncedAgent({ phone: SHARED_PHONE, mensagem_id: 'm' }),
        ),
      ).rejects.toMatchObject({
        name: 'DebouncerRedisUnavailableError',
        code: 'DEBOUNCER_REDIS_UNAVAILABLE',
      });

      // Side-effects: readState throws BEFORE we ever touch BullMQ, so
      // there's no half-committed state (no jobId enqueued without a
      // companion Redis state row).
      expect(redisStub.get).not.toHaveBeenCalled();
      expect(redisStub.set).not.toHaveBeenCalled();
      expect(queueGetJob).not.toHaveBeenCalled();
      expect(queueAdd).not.toHaveBeenCalled();
    });

    it('clearDebounceState throws DebouncerRedisUnavailableError when Redis is down', async () => {
      redisConnected.value = false;

      await expect(
        runWithTenantContext(
          { tenant_id: TENANT_A, agent_id: AGENT_A },
          async () => clearDebounceState(SHARED_PHONE),
        ),
      ).rejects.toMatchObject({
        name: 'DebouncerRedisUnavailableError',
        code: 'DEBOUNCER_REDIS_UNAVAILABLE',
      });
      expect(redisStub.del).not.toHaveBeenCalled();
    });

    it('queue.add failure inside scheduleDebouncedAgent re-throws (no silent swallow)', async () => {
      // Redis is up, but BullMQ blips on `add`. Pre-fix MAJOR D: the
      // `await agentQueue.add(...)` ran outside any local try/catch, so
      // the rejection propagated AND left state in an inconsistent
      // shape (writeState had not yet run). Post-fix: the outer
      // try/catch logs `debounce.schedule_failed` then re-throws so the
      // caller can pick a fallback policy.
      queueAdd.mockImplementationOnce(async () => {
        throw new Error('bullmq blip');
      });

      await expect(
        runWithTenantContext(
          { tenant_id: TENANT_A, agent_id: AGENT_A },
          async () => scheduleDebouncedAgent({ phone: SHARED_PHONE, mensagem_id: 'm' }),
        ),
      ).rejects.toThrow('bullmq blip');

      // writeState must NOT have run — the failure on `add` interrupted
      // the sequence before the state stamp, so we don't leave a state
      // row pointing at a nonexistent job.
      expect(redisStub.set).not.toHaveBeenCalled();
    });

    it('writeState failure after a successful queue.add re-throws (state inconsistency surfaced)', async () => {
      // The OTHER half of MAJOR D: writeState (which runs LAST) blowing
      // up. Pre-fix, the throw went straight to the caller as an
      // unhandled rejection — and the BullMQ job was already armed,
      // so the next message would still find a job to remove, but
      // there's no state row to drive the heldMs / max-hold logic.
      // Post-fix, the outer try/catch logs the failure (attribution
      // visible in `debounce.schedule_failed`) and re-throws.
      redisStub.set.mockImplementationOnce(async () => {
        throw new Error('redis set blip');
      });

      await expect(
        runWithTenantContext(
          { tenant_id: TENANT_A, agent_id: AGENT_A },
          async () => scheduleDebouncedAgent({ phone: SHARED_PHONE, mensagem_id: 'm' }),
        ),
      ).rejects.toThrow('redis set blip');

      // BullMQ `add` ran (the failure was on the FOLLOWING writeState),
      // proving the test exercises the post-add path.
      expect(queueAdd).toHaveBeenCalledTimes(1);
    });
  });
});
