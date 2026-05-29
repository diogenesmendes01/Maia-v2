/**
 * Issue #333 — the working-memory data write MUST be atomic so the list key can
 * NEVER exist without a TTL.
 *
 * THE BUG (#333): `pushMessage` previously issued three SEPARATE Redis round
 * trips — `rpush` → `ltrim` → `expire`. A process death (crash/OOM/timeout)
 * between the `rpush` and the `expire` left the list in Redis WITHOUT a TTL:
 * data that never expires. And because the TTL/collision marker `SET` runs only
 * AFTER that block, an empty read of such a key found `marker === null` and was
 * charged to the natural/cold-expiry branch — NOT to
 * `working_memory_ttl_miss_total`. So the data persisted with no expiration AND
 * no observability, outside the #330/#317 TTL-miss alert window.
 *
 * THE FIX: collapse `rpush` + `ltrim` + `expire` into ONE server-side Lua EVAL.
 * Redis runs a script atomically and in isolation, so there is no client-visible
 * point between the push and the expire — the list and its TTL are committed
 * together or not at all.
 *
 * WHAT THIS SPEC PROVES (the contract, not the wire format):
 *   1. After a successful `pushMessage`, the data key ALWAYS has a TTL.
 *   2. The write reaches Redis as a SINGLE `eval` call (one atomic round trip),
 *      not three separate `rpush`/`ltrim`/`expire` calls.
 *   3. The script applies the SAME arguments as before: the message entry, the
 *      trailing-N trim, and `MESSAGES_TTL_SECONDS`.
 *   4. Simulating the OLD failure window — a death AFTER the push but BEFORE the
 *      expire — is now structurally impossible: a thrown script leaves NOTHING
 *      behind (no list, hence no list-without-TTL), because Redis aborts the
 *      whole EVAL atomically.
 *   5. The buffer is trimmed to the trailing N entries (ltrim semantics).
 *
 * Strategy: a small in-memory Redis stub whose `eval` faithfully models the
 * atomicity property — it commits the list AND the TTL in the same call, or (in
 * the failure-window test) throws WITHOUT mutating anything. `isRedisConnected`
 * is mocked `true`. Tenant context is provided via `runWithTenantContext` so the
 * production tenant-scoped key resolves byte-for-byte.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';

const TTL_SECONDS = 60 * 60 * 24; // mirrors MESSAGES_TTL_SECONDS in working.ts
const BUFFER_SIZE = 20; // mirrors MESSAGES_BUFFER_SIZE in working.ts

const { stub } = vi.hoisted(() => {
  const lists = new Map<string, { value: string }[]>();
  const ttls = new Map<string, number>();
  const markers = new Map<string, string>();
  const evalCalls: { script: string; numKeys: number; key: string; argv: string[] }[] = [];
  // When true, the data-write script throws WITHOUT mutating anything — models
  // an OOM/crash that aborts the EVAL atomically (the #333 failure window).
  let failEvalAtomically = false;

  const s = {
    lists,
    ttls,
    markers,
    evalCalls,
    setFailEvalAtomically(v: boolean) {
      failEvalAtomically = v;
    },
    // Atomic data write — mirrors the production Lua: rpush + ltrim(-N,-1) +
    // expire, all-or-nothing. Either the list AND its TTL are set together, or
    // (failure path) nothing is touched at all.
    async eval(script: string, numKeys: number, key: string, ...argv: string[]) {
      evalCalls.push({ script, numKeys, key, argv });
      // Atomic failure: abort BEFORE any mutation. There is no partial state —
      // crucially, no list is left without a TTL.
      if (failEvalAtomically) {
        throw Object.assign(new Error('script killed mid-flight (simulated)'), {
          name: 'ReplyError',
        });
      }
      const [value, maxLen, ttl] = argv;
      const arr = lists.get(key) ?? [];
      arr.push({ value: value! });
      const n = Number(maxLen);
      if (arr.length > n) arr.splice(0, arr.length - n); // ltrim(-N, -1)
      lists.set(key, arr);
      ttls.set(key, Number(ttl)); // expire — committed in the SAME call
      return 1;
    },
    async lrange(key: string) {
      return (lists.get(key) ?? []).map((e) => e.value);
    },
    async set(key: string, value: string) {
      markers.set(key, value);
      return 'OK';
    },
    async get(key: string) {
      return markers.get(key) ?? null;
    },
  };
  return { stub: s };
});

vi.mock('@/lib/redis.js', () => ({
  redis: stub,
  isRedisConnected: () => true,
  isRedisOomError: () => false,
  recordRedisOomDegraded: () => {},
}));

vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { pushMessage } = await import('@/memory/working.js');

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const AGENT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function asTenantA<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ tenant_id: TENANT_A, agent_id: AGENT_A }, fn);
}

function workingKey(conversa_id: string): string {
  return `working:${TENANT_A}:${AGENT_A}:conv:${conversa_id}:messages`;
}

describe('working memory — atomic data write (#333)', () => {
  beforeEach(() => {
    stub.lists.clear();
    stub.ttls.clear();
    stub.markers.clear();
    stub.evalCalls.length = 0;
    stub.setFailEvalAtomically(false);
  });

  it('after a successful pushMessage the data key ALWAYS has a TTL', async () => {
    await asTenantA(() => pushMessage('conv-1', 'user', 'olá'));

    const key = workingKey('conv-1');
    // The load-bearing invariant of #333: data present ⇒ TTL present.
    expect(stub.lists.get(key)).toHaveLength(1);
    expect(stub.ttls.get(key)).toBe(TTL_SECONDS);
  });

  it('writes the data in a SINGLE atomic EVAL (not three rpush/ltrim/expire round trips)', async () => {
    await asTenantA(() => pushMessage('conv-single', 'user', 'oi'));

    // Exactly one data-write call reaches Redis, and it is an EVAL whose script
    // performs all three commands server-side.
    expect(stub.evalCalls).toHaveLength(1);
    const call = stub.evalCalls[0]!;
    expect(call.numKeys).toBe(1);
    expect(call.key).toBe(workingKey('conv-single'));
    expect(call.script).toMatch(/rpush/);
    expect(call.script).toMatch(/ltrim/);
    expect(call.script).toMatch(/expire/);
  });

  it('passes the message entry, trim size and TTL as script args (same data as the old 3 calls)', async () => {
    await asTenantA(() => pushMessage('conv-args', 'assistant', 'resposta'));

    const call = stub.evalCalls[0]!;
    const [entry, maxLen, ttl] = call.argv;
    const parsed = JSON.parse(entry!) as { role: string; text: string; ts: number };
    expect(parsed.role).toBe('assistant');
    expect(parsed.text).toBe('resposta');
    expect(typeof parsed.ts).toBe('number');
    expect(maxLen).toBe(String(BUFFER_SIZE));
    expect(ttl).toBe(String(TTL_SECONDS));
  });

  it('the OLD failure window is gone: an aborted script leaves NO list-without-TTL', async () => {
    // Reproduce the exact #333 scenario: the write "dies" partway through. With
    // the old three-call path this could leave a list with no TTL. With the
    // atomic EVAL the script aborts as a unit, so NOTHING is committed — there
    // is no key at all, and therefore no key lacking a TTL.
    stub.setFailEvalAtomically(true);

    await expect(asTenantA(() => pushMessage('conv-crash', 'user', 'boom'))).rejects.toThrow();

    const key = workingKey('conv-crash');
    expect(stub.lists.has(key)).toBe(false); // no data list left behind
    expect(stub.ttls.has(key)).toBe(false); // and so, no list-without-TTL
    // Invariant restated as a guard: there is NO data key anywhere that lacks a
    // TTL after the failed write.
    for (const dataKey of stub.lists.keys()) {
      expect(stub.ttls.has(dataKey)).toBe(true);
    }
  });

  it('every write refreshes the TTL and keeps the list trimmed to the trailing N', async () => {
    await asTenantA(async () => {
      for (let i = 0; i < BUFFER_SIZE + 5; i++) {
        await pushMessage('conv-trim', 'user', `m${i}`);
      }
    });

    const key = workingKey('conv-trim');
    // Trim semantics preserved: never more than the trailing N entries.
    expect(stub.lists.get(key)).toHaveLength(BUFFER_SIZE);
    // The oldest entries were dropped; the newest is retained.
    const values = (stub.lists.get(key) ?? []).map(
      (e) => (JSON.parse(e.value) as { text: string }).text,
    );
    expect(values[values.length - 1]).toBe(`m${BUFFER_SIZE + 4}`);
    expect(values).not.toContain('m0');
    // TTL is still present after the repeated writes (refreshed each time).
    expect(stub.ttls.get(key)).toBe(TTL_SECONDS);
  });

  it('invariant across MANY conversations: no data key ever lacks a TTL', async () => {
    await asTenantA(async () => {
      for (let i = 0; i < 10; i++) {
        await pushMessage(`conv-many-${i}`, 'user', `hello ${i}`);
      }
    });

    expect(stub.lists.size).toBe(10);
    for (const dataKey of stub.lists.keys()) {
      expect(stub.ttls.get(dataKey)).toBe(TTL_SECONDS);
    }
  });
});
